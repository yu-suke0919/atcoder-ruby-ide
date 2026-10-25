use serde::Serialize;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Serialize)]
pub struct Output {
    pub stream: &'static str,
    pub bytes: Vec<u8>,
}

#[derive(Serialize)]
pub struct RunResult {
    pub status: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
}

struct Active {
    pid: Option<u32>,
    reason: Option<&'static str>,
}

pub struct Runner {
    active: Mutex<Option<Active>>,
    timeout: Duration,
    output_limit: usize,
}

struct ReleaseRun(Arc<Runner>);
impl Drop for ReleaseRun {
    fn drop(&mut self) {
        *self.0.active.lock().unwrap() = None;
    }
}

impl Runner {
    pub fn new(timeout: Duration, output_limit: usize) -> Arc<Self> {
        Arc::new(Self {
            active: Mutex::new(None),
            timeout,
            output_limit,
        })
    }

    pub fn busy(&self) -> bool {
        self.active.lock().unwrap().is_some()
    }

    pub fn stop(&self) -> bool {
        self.stop_for("stopped")
    }

    fn stop_for(&self, reason: &'static str) -> bool {
        let pid = {
            let mut active = self.active.lock().unwrap();
            let Some(state) = active.as_mut() else {
                return false;
            };
            state.reason.get_or_insert(reason);
            state.pid
        };
        if let Some(pid) = pid {
            kill_tree(pid);
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

    pub fn run<F>(
        self: &Arc<Self>,
        ruby: &Path,
        code: &str,
        stdin: &str,
        output: F,
    ) -> Result<RunResult, String>
    where
        F: Fn(Output) + Send + Sync + 'static,
    {
        if code.len() > 1048576 || stdin.len() > 1048576 {
            return Err("コード・入力は各 1 MiB 以下にしてください。".into());
        }
        {
            let mut active = self.active.lock().unwrap();
            if active.is_some() {
                return Err("すでに実行中です。".into());
            }
            *active = Some(Active {
                pid: None,
                reason: None,
            });
        }
        let _release = ReleaseRun(Arc::clone(self));
        let started = Instant::now();
        let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
        let source = directory.path().join("solution.rb");
        let bootstrap = directory.path().join("stdio.rb");
        std::fs::write(&source, code).map_err(|e| e.to_string())?;
        std::fs::write(&bootstrap, "[STDIN, STDOUT, STDERR].each { |io| io.binmode; io.set_encoding(Encoding::UTF_8) }; STDOUT.sync = true; STDERR.sync = true\n").map_err(|e| e.to_string())?;
        if let Some(reason) = self.reason() {
            return Ok(RunResult {
                status: reason.into(),
                exit_code: None,
                duration_ms: started.elapsed().as_millis() as u64,
            });
        }
        let mut command = Command::new(ruby);
        command
            .args(["-EUTF-8:UTF-8", "-r"])
            .arg(&bootstrap)
            .arg(&source)
            .current_dir(directory.path())
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
        self.active.lock().unwrap().as_mut().unwrap().pid = Some(child.id());
        if self.reason().is_some() {
            kill_tree(child.id());
        }
        let output = Arc::new(output);
        let bytes = Arc::new(AtomicUsize::new(0));
        let stdout = self.read_stream(
            child.stdout.take().unwrap(),
            "stdout",
            Arc::clone(&output),
            Arc::clone(&bytes),
        );
        let stderr = self.read_stream(child.stderr.take().unwrap(), "stderr", output, bytes);
        let mut pipe = child.stdin.take().unwrap();
        let input = stdin.as_bytes().to_vec();
        let writer = std::thread::spawn(move || {
            let _ = pipe.write_all(&input);
        });
        let exit = loop {
            match child.try_wait() {
                Ok(Some(exit)) => break exit,
                Ok(None) => {}
                Err(error) => {
                    self.stop();
                    let _ = child.wait();
                    return Err(error.to_string());
                }
            }
            if started.elapsed() >= self.timeout && self.reason().is_none() {
                self.stop_for("timeout");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let _ = writer.join();
        stdout.join().map_err(|_| "stdout reader failed")?;
        stderr.join().map_err(|_| "stderr reader failed")?;
        let status = self.reason().unwrap_or(if exit.success() {
            "completed"
        } else {
            "failed"
        });
        directory.close().map_err(|e| e.to_string())?;
        Ok(RunResult {
            status: status.into(),
            exit_code: exit.code(),
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    fn read_stream<R, F>(
        self: &Arc<Self>,
        mut reader: R,
        stream: &'static str,
        output: Arc<F>,
        bytes: Arc<AtomicUsize>,
    ) -> std::thread::JoinHandle<()>
    where
        R: Read + Send + 'static,
        F: Fn(Output) + Send + Sync + 'static,
    {
        let runner = Arc::clone(self);
        std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            while let Ok(length) = reader.read(&mut buffer) {
                if length == 0 {
                    break;
                }
                let previous = bytes
                    .try_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                        Some((count + length).min(runner.output_limit))
                    })
                    .unwrap();
                let count = length.min(runner.output_limit - previous);
                if count > 0 {
                    output(Output {
                        stream,
                        bytes: buffer[..count].to_vec(),
                    });
                }
                if previous < runner.output_limit && previous + count == runner.output_limit {
                    runner.stop_for("output-limit");
                }
            }
        })
    }
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}
