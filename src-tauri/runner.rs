use crate::files::MAX_TEXT_BYTES;
use crate::{decode_output, first_difference, process::ProcessTree, OutputDifference};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const RUBY_VM_STACK_BYTES: usize = 32 * 1024 * 1024;
const WINDOWS_JOB_MEMORY_BYTES: usize = 1024 * 1024 * 1024;
const MIN_EXECUTION_LIMIT_MS: u64 = 5000;
const MAX_EXECUTION_LIMIT_MS: u64 = 30000;
const EXECUTION_MARGIN_MS: u64 = 1000;

#[derive(Default)]
pub struct RunRequest {
    pub code: String,
    pub stdin: String,
    pub expected_output: Option<String>,
    pub tolerance: Option<f64>,
    pub problem_time_limit_ms: Option<u32>,
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
    pub execution_limit_ms: u64,
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
    timeout: Duration,
}
#[derive(Default)]
struct Capture {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    bytes: usize,
    closed: bool,
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
    pub fn wait_idle(&self) {
        let mut active = self.active.lock().unwrap();
        while active.is_some() {
            active = self.idle.wait(active).unwrap();
        }
    }
    pub fn prepare(self: &Arc<Self>, request: RunRequest) -> Result<PreparedRun, String> {
        crate::samples::validate_tolerance(request.tolerance)?;
        let timeout = match request.problem_time_limit_ms {
            Some(0) => {
                return Err("問題の時間制限は1〜4,294,967,295ミリ秒の整数にしてください。".into())
            }
            Some(limit) => Duration::from_millis(
                (u64::from(limit) + EXECUTION_MARGIN_MS)
                    .clamp(MIN_EXECUTION_LIMIT_MS, MAX_EXECUTION_LIMIT_MS),
            ),
            None => self.timeout,
        };
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
            timeout,
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
    pub fn execution_limit_ms(&self) -> u64 {
        self.timeout.as_millis() as u64
    }

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
                execution_limit_ms: self.execution_limit_ms(),
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
        let mut command = crate::process::ruby_command(ruby);
        command
            .env("RUBY_THREAD_VM_STACK_SIZE", RUBY_VM_STACK_BYTES.to_string())
            .arg("-r")
            .arg(&bootstrap)
            .arg(&source)
            .current_dir(directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (mut child, tree) = ProcessTree::spawn(&mut command, Some(WINDOWS_JOB_MEMORY_BYTES))
            .map_err(|e| format!("Ruby を起動できません: {e}"))?;
        let tree = Arc::new(tree);
        self.runner.active.lock().unwrap().as_mut().unwrap().tree = Some(Arc::clone(&tree));
        if self.runner.reason().is_some() {
            tree.kill();
        }
        let capture = Arc::new(Mutex::new(Capture::default()));
        // Readers enforce limits independently of a slow notification consumer. Only
        // captured bytes enter this queue, so its payload cannot exceed output_limit.
        let (events, notifications) = mpsc::channel();
        let notifier = std::thread::spawn(move || {
            for event in notifications {
                output(event);
            }
        });
        let stdout_pipe = child.stdout.take().unwrap();
        let stderr_pipe = child.stderr.take().unwrap();
        let mut pipe = child.stdin.take().unwrap();
        #[cfg(unix)]
        for result in [
            crate::process::nonblocking(&stdout_pipe),
            crate::process::nonblocking(&stderr_pipe),
            crate::process::nonblocking(&pipe),
        ] {
            if let Err(error) = result {
                tree.kill();
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Ruby のパイプを設定できません: {error}"));
            }
        }
        let stdout = self.read_stream(stdout_pipe, "stdout", events.clone(), Arc::clone(&capture));
        let stderr = self.read_stream(stderr_pipe, "stderr", events, Arc::clone(&capture));
        let input = self.request.stdin.as_bytes().to_vec();
        let writer_capture = Arc::clone(&capture);
        let writer = std::thread::spawn(move || {
            let mut remaining = input.as_slice();
            while !remaining.is_empty() && !writer_capture.lock().unwrap().closed {
                match pipe.write(remaining) {
                    Ok(0) => break,
                    Ok(count) => remaining = &remaining[count..],
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
        let mut exit = None;
        let mut wait_error = None;
        let mut stopped_at = None;
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
            // Check even after a fast allocation failure and process exit, before
            // accepting an ordinary exit status. Do not infer OOM from stderr.
            #[cfg(windows)]
            match tree.memory_limit_reached() {
                Ok(true) => {
                    self.runner.stop_for("memory-limit");
                }
                Ok(false) => {}
                Err(error) => {
                    wait_error = Some(format!("Rubyのメモリ制限通知を取得できません: {error}"));
                    break;
                }
            }
            if exit.is_some() && stdout.is_finished() && stderr.is_finished() {
                break;
            }
            if started.elapsed() >= self.timeout && self.runner.reason().is_none() {
                self.runner.stop_for("timeout");
            }
            if self.runner.reason().is_some() {
                let stopped = stopped_at.get_or_insert_with(Instant::now);
                let _ = child.kill();
                if stopped.elapsed() >= Duration::from_millis(250) {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        capture.lock().unwrap().closed = true;
        tree.kill();
        if exit.is_none() {
            let _ = child.kill();
            exit = child.wait().ok();
        }
        let _ = writer.join();
        stdout
            .join()
            .map_err(|_| "標準出力の受信に失敗しました。")?;
        stderr
            .join()
            .map_err(|_| "標準エラーの受信に失敗しました。")?;
        notifier.join().map_err(|_| "出力の通知に失敗しました。")?;
        cleanup(directory.path()).map_err(|e| format!("一時ファイルを削除できません: {e}"))?;
        if let Some(error) = wait_error {
            return Err(error);
        }
        let exit = exit.ok_or("Ruby の終了状態を取得できません。")?;
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
                let difference = first_difference(&stdout, expected, self.request.tolerance);
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
            execution_limit_ms: self.execution_limit_ms(),
            comparison,
            difference,
            error_line,
            output_limit_reached: capped,
        })
    }

    fn read_stream<R>(
        &self,
        mut reader: R,
        stream: &'static str,
        output: mpsc::Sender<Output>,
        capture: Arc<Mutex<Capture>>,
    ) -> std::thread::JoinHandle<()>
    where
        R: Read + Send + 'static,
    {
        let runner = Arc::clone(&self.runner);
        std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            while !capture.lock().unwrap().closed {
                let length = match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => length,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                };
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
                if reached {
                    runner.stop_for("output-limit");
                }
                if !bytes.is_empty() {
                    let _ = output.send(Output { stream, bytes });
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

    #[cfg(windows)]
    #[test]
    fn memory_notification_stops_the_job_and_releases_the_runner() {
        let ruby = std::path::PathBuf::from(
            std::env::var_os("RUBY_PATH").unwrap_or_else(|| "ruby".into()),
        );
        let runner = Runner::new(Duration::from_secs(5), MAX_TEXT_BYTES);
        let notified = Arc::clone(&runner);
        let result = runner
            .prepare(RunRequest {
                code: "require 'rbconfig'; spawn(RbConfig.ruby, '-e', 'sleep 30'); puts 'ready'; sleep 30".into(),
                expected_output: Some("never compared".into()),
                ..Default::default()
            })
            .unwrap()
            .execute(&ruby, move |_| {
                let tree = notified
                    .active
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .tree
                    .clone()
                    .unwrap();
                tree.post_memory_limit_notification().unwrap();
            })
            .unwrap();
        assert_eq!(result.status, "memory-limit");
        assert_eq!(result.comparison, None);
        assert_eq!(result.difference, None);
        assert_eq!(result.error_line, None);
        assert_eq!(
            runner
                .prepare(RunRequest {
                    code: "puts 'next'".into(),
                    ..Default::default()
                })
                .unwrap()
                .execute(&ruby, |_| {})
                .unwrap()
                .stdout,
            "next\n"
        );
    }

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
