use crate::files::MAX_TEXT_BYTES;
use crate::{decode_output, first_difference, process::ProcessTree, OutputDifference};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct RunRequest {
    pub code: String,
    pub stdin: String,
    pub expected_output: Option<String>,
    pub cwd: Option<PathBuf>,
}

#[derive(Clone, Serialize)]
pub struct Output {
    pub stream: &'static str,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub status: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub comparison: Option<bool>,
    pub difference: Option<OutputDifference>,
    pub error_line: Option<usize>,
    pub output_limit_reached: bool,
}

struct Active {
    tree: Option<Arc<ProcessTree>>,
    reason: Option<&'static str>,
}
pub struct Runner {
    active: Mutex<Option<Active>>,
    idle: Condvar,
    timeout: Duration,
    output_limit: usize,
}
pub struct PreparedRun {
    runner: Arc<Runner>,
    request: RunRequest,
}
#[derive(Default)]
struct Capture {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    bytes: usize,
}

impl Runner {
    pub fn new(timeout: Duration, output_limit: usize) -> Arc<Self> {
        Arc::new(Self {
            active: Mutex::new(None),
            idle: Condvar::new(),
            timeout,
            output_limit,
        })
    }
    pub fn busy(&self) -> bool {
        self.active.lock().unwrap().is_some()
    }
    pub fn wait_idle(&self) {
        let mut active = self.active.lock().unwrap();
        while active.is_some() {
            active = self.idle.wait(active).unwrap();
        }
    }
    pub fn prepare(self: &Arc<Self>, request: RunRequest) -> Result<PreparedRun, String> {
        let mut active = self.active.lock().unwrap();
        if active.is_some() {
            return Err("すでに実行中です。".into());
        }
        for (name, text) in [
            ("コード", Some(request.code.as_str())),
            ("標準入力", Some(request.stdin.as_str())),
            ("期待出力", request.expected_output.as_deref()),
        ] {
            if text.is_some_and(|text| text.len() > MAX_TEXT_BYTES) {
                return Err(format!("{name}は 1 MiB 以下にしてください。"));
            }
        }
        *active = Some(Active {
            tree: None,
            reason: None,
        });
        Ok(PreparedRun {
            runner: Arc::clone(self),
            request,
        })
    }
    pub fn stop(&self) -> bool {
        self.stop_for("stopped")
    }
    fn stop_for(&self, reason: &'static str) -> bool {
        let tree = {
            let mut active = self.active.lock().unwrap();
            let Some(state) = active.as_mut() else {
                return false;
            };
            state.reason.get_or_insert(reason);
            state.tree.clone()
        };
        if let Some(tree) = tree {
            tree.kill();
        }
        true
    }
    fn reason(&self) -> Option<&'static str> {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|state| state.reason)
    }
}

impl Drop for PreparedRun {
    fn drop(&mut self) {
        if let Some(state) = self.runner.active.lock().unwrap().take() {
            if let Some(tree) = state.tree {
                tree.kill();
            }
        }
        self.runner.idle.notify_all();
    }
}

impl PreparedRun {
    pub fn execute<F>(self, ruby: &Path, output: F) -> Result<RunResult, String>
    where
        F: Fn(Output) + Send + Sync + 'static,
    {
        let started = Instant::now();
        if let Some(reason) = self.runner.reason() {
            return Ok(RunResult {
                status: reason.into(),
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                duration_ms: 0,
                comparison: None,
                difference: None,
                error_line: None,
                output_limit_reached: false,
            });
        }
        let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
        let source = directory.path().join("solution.rb");
        let bootstrap = directory.path().join("stdio.rb");
        std::fs::write(&source, &self.request.code).map_err(|e| e.to_string())?;
        std::fs::write(&bootstrap, "Gem.use_paths(Gem.default_dir); [STDIN, STDOUT, STDERR].each { |io| io.binmode; io.set_encoding(Encoding::UTF_8) }; STDOUT.sync = true; STDERR.sync = true\n").map_err(|e| e.to_string())?;
        let mut command = Command::new(ruby);
        command
            .args(["-EUTF-8:UTF-8", "-r"])
            .arg(&bootstrap)
            .arg(&source)
            .current_dir(self.request.cwd.as_deref().unwrap_or(directory.path()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Ruby を起動できません: {e}"))?;
        let tree = match ProcessTree::attach(&child) {
            Ok(tree) => Arc::new(tree),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Ruby のプロセス群を管理できません: {error}"));
            }
        };
        self.runner.active.lock().unwrap().as_mut().unwrap().tree = Some(Arc::clone(&tree));
        if self.runner.reason().is_some() {
            tree.kill();
        }
        let capture = Arc::new(Mutex::new(Capture::default()));
        let output = Arc::new(output);
        let stdout = self.read_stream(
            child.stdout.take().unwrap(),
            "stdout",
            Arc::clone(&output),
            Arc::clone(&capture),
        );
        let stderr = self.read_stream(
            child.stderr.take().unwrap(),
            "stderr",
            output,
            Arc::clone(&capture),
        );
        let input = self.request.stdin.as_bytes().to_vec();
        let mut pipe = child.stdin.take().unwrap();
        let writer = std::thread::spawn(move || {
            let _ = pipe.write_all(&input);
        });
        let mut exit = None;
        let mut wait_error = None;
        loop {
            if exit.is_none() {
                match child.try_wait() {
                    Ok(status) => exit = status,
                    Err(error) => {
                        tree.kill();
                        let _ = child.wait();
                        wait_error = Some(error.to_string());
                        break;
                    }
                }
            }
            if exit.is_some() && stdout.is_finished() && stderr.is_finished() {
                break;
            }
            if started.elapsed() >= self.runner.timeout && self.runner.reason().is_none() {
                self.runner.stop_for("timeout");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        tree.kill();
        let _ = writer.join();
        stdout
            .join()
            .map_err(|_| "標準出力の受信に失敗しました。")?;
        stderr
            .join()
            .map_err(|_| "標準エラーの受信に失敗しました。")?;
        cleanup(directory.path()).map_err(|e| format!("一時ファイルを削除できません: {e}"))?;
        if let Some(error) = wait_error {
            return Err(error);
        }
        let exit = exit.unwrap();
        let capture = capture.lock().unwrap();
        let capped = capture.bytes >= self.runner.output_limit;
        let stdout = decode_output(&capture.stdout, capped);
        let stderr = decode_output(&capture.stderr, capped);
        let status = self.runner.reason().unwrap_or(if exit.success() {
            "completed"
        } else {
            "failed"
        });
        let (comparison, difference) = match (status, self.request.expected_output.as_deref()) {
            ("completed", Some(expected)) => {
                let difference = first_difference(&stdout, expected);
                (Some(difference.is_none()), difference)
            }
            _ => (None, None),
        };
        let error_line = if status == "failed" {
            source_error_line(&stderr, &source, self.request.code.split('\n').count())
        } else {
            None
        };
        Ok(RunResult {
            status: status.into(),
            stdout,
            stderr,
            exit_code: exit.code(),
            duration_ms: started.elapsed().as_millis() as u64,
            comparison,
            difference,
            error_line,
            output_limit_reached: capped,
        })
    }

    fn read_stream<R, F>(
        &self,
        mut reader: R,
        stream: &'static str,
        output: Arc<F>,
        capture: Arc<Mutex<Capture>>,
    ) -> std::thread::JoinHandle<()>
    where
        R: Read + Send + 'static,
        F: Fn(Output) + Send + Sync + 'static,
    {
        let runner = Arc::clone(&self.runner);
        std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            while let Ok(length) = reader.read(&mut buffer) {
                if length == 0 {
                    break;
                }
                let (bytes, reached) = {
                    let mut data = capture.lock().unwrap();
                    let count = length.min(runner.output_limit - data.bytes);
                    let bytes = buffer[..count].to_vec();
                    let previous = data.bytes;
                    data.bytes += count;
                    if stream == "stdout" {
                        data.stdout.extend(&bytes);
                    } else {
                        data.stderr.extend(&bytes);
                    }
                    let reached =
                        previous < runner.output_limit && data.bytes >= runner.output_limit;
                    (bytes, reached)
                };
                if !bytes.is_empty() {
                    output(Output { stream, bytes });
                }
                if reached {
                    runner.stop_for("output-limit");
                }
            }
        })
    }
}

fn source_error_line(stderr: &str, source: &Path, line_count: usize) -> Option<usize> {
    let source = source.to_str()?.replace('\\', "/");
    let normalized = stderr.replace('\\', "/");
    normalized.lines().find_map(|line| {
        let line = line.trim_start();
        let frame = line.strip_prefix("from ").unwrap_or(line);
        let rest = frame.strip_prefix(&source)?.strip_prefix(':')?;
        let (number, message) = rest.split_once(':')?;
        if message.trim_start().starts_with("warning:") {
            return None;
        }
        let number = number.parse::<usize>().ok()?;
        (number > 0 && number <= line_count).then_some(number)
    })
}

fn cleanup(directory: &Path) -> std::io::Result<()> {
    for attempt in 0..=3 {
        match std::fs::remove_dir_all(directory) {
            Ok(()) => return Ok(()),
            Err(error)
                if cfg!(windows)
                    && attempt < 3
                    && matches!(error.raw_os_error(), Some(5 | 32 | 33 | 145)) =>
            {
                std::thread::sleep(Duration::from_millis(50 * (attempt + 1)))
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_frames_match_the_exact_source_and_skip_prism_headers() {
        let source = Path::new("/tmp/日本語 space/solution.rb");
        let stderr = "/tmp/日本語 space/solution.rb: --> /tmp/日本語 space/solution.rb\n\n/tmp/日本語 space/solution.rb:2: syntax errors found (SyntaxError)\n";
        assert_eq!(source_error_line(stderr, source, 3), Some(2));
        assert_eq!(
            source_error_line(
                "/lib/json.rb:9:in parse\n\tfrom /tmp/日本語 space/solution.rb:3:in main\n",
                source,
                3
            ),
            Some(3)
        );
        assert_eq!(source_error_line("/tmp/日本語 space/solution.rb:1: warning: already initialized constant A\n/tmp/日本語 space/solution.rb:2:in main: boom", source, 3), Some(2));
    }

    #[test]
    fn error_frames_accept_windows_path_separators_and_drive_letters() {
        let source = Path::new(r"C:\Users\日本語 space\solution.rb");
        for stderr in [
            "C:/Users/日本語 space/solution.rb:2:in main",
            "\tfrom C:\\Users\\日本語 space\\solution.rb:2:in main",
        ] {
            assert_eq!(source_error_line(stderr, source, 3), Some(2));
        }
    }

    #[test]
    fn error_frames_reject_unrelated_paths_text_and_invalid_lines() {
        let source = Path::new("/tmp/main/solution.rb");
        for stderr in [
            "/tmp/other/solution.rb:1:in main",
            "warning mentions /tmp/main/solution.rb:1:in main",
            "x/tmp/main/solution.rb:1:in main",
            "/tmp/main/solution.rb:0:in main",
            "/tmp/main/solution.rb:4:in main",
            "/tmp/main/solution.rb:-1:in main",
            "/tmp/main/solution.rb:99999999999999999999999999:in main",
            "/tmp/main/solution.rb:2bad:in main",
        ] {
            assert_eq!(source_error_line(stderr, source, 3), None, "{stderr}");
        }
    }
}
