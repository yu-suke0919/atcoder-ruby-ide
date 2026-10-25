use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri_size_probe::{Output, RunResult, Runner};

fn ruby() -> PathBuf {
    std::env::var_os("RUBY_PATH")
        .unwrap_or_else(|| "ruby".into())
        .into()
}

fn execute(code: &str, stdin: &str, timeout: u64, limit: usize) -> (RunResult, String, String) {
    let output = Arc::new(Mutex::new((Vec::new(), Vec::new())));
    let captured = Arc::clone(&output);
    let runner = Runner::new(Duration::from_millis(timeout), limit);
    let result = runner
        .run(&ruby(), code, stdin, move |event: Output| {
            let mut data = captured.lock().unwrap();
            if event.stream == "stdout" {
                data.0.extend(event.bytes);
            } else {
                data.1.extend(event.bytes);
            }
        })
        .unwrap();
    assert!(!runner.busy());
    let data = output.lock().unwrap();
    (
        result,
        String::from_utf8_lossy(&data.0).into_owned(),
        String::from_utf8_lossy(&data.1).into_owned(),
    )
}

#[test]
fn sample_and_stdin_eof() {
    let (result, stdout, stderr) = execute("a=gets.to_i; b,c=gets.split.map(&:to_i); s=gets.chomp; puts \"#{a+b+c} #{s}\"; puts STDIN.read.empty?", "1\n2 3\ntest\n", 5000, 1048576);
    assert_eq!(result.status, "completed");
    assert_eq!(stdout, "6 test\ntrue\n");
    assert_eq!(stderr, "");
}

#[test]
fn japanese_and_stderr_and_input_newlines() {
    let (result, stdout, stderr) = execute(
        "puts STDIN.read.bytes.join(','); puts '日本語'; warn '標準エラー'",
        "\r\n",
        5000,
        1048576,
    );
    assert_eq!(result.status, "completed");
    assert_eq!(stdout, "13,10\n日本語\n");
    assert_eq!(stderr, "標準エラー\n");
}

#[test]
fn error_and_next_run() {
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    assert_eq!(
        runner.run(&ruby(), "puts(", "", |_| {}).unwrap().status,
        "failed"
    );
    assert_eq!(
        runner.run(&ruby(), "puts 42", "", |_| {}).unwrap().status,
        "completed"
    );
    assert!(!runner.busy());
}

#[test]
fn missing_ruby_releases_busy_state() {
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    assert!(runner
        .run(
            &PathBuf::from("missing-ruby-for-size-probe"),
            "",
            "",
            |_| {}
        )
        .is_err());
    assert!(!runner.busy());
}

#[test]
fn streaming_stop_and_reject_concurrent_runs() {
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    let active = Arc::clone(&runner);
    let (sender, receiver) = mpsc::channel();
    let pending = std::thread::spawn(move || {
        active.run(&ruby(), "puts 'ready'; sleep 10", "", move |event| {
            let _ = sender.send(event);
        })
    });
    let event = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(event.bytes, b"ready\n");
    assert!(runner.run(&ruby(), "puts 1", "", |_| {}).is_err());
    assert!(runner.stop());
    assert_eq!(pending.join().unwrap().unwrap().status, "stopped");
    assert!(!runner.busy());
}

#[test]
fn timeout_and_output_limit() {
    assert_eq!(execute("loop {}", "", 200, 1048576).0.status, "timeout");
    let (result, stdout, _) = execute("loop { print 'x' * 4096 }", "", 5000, 512);
    assert_eq!(result.status, "output-limit");
    assert_eq!(stdout.len(), 512);
}

#[test]
fn input_limit_and_temporary_file_cleanup() {
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    assert!(runner
        .run(&ruby(), &"x".repeat(1048577), "", |_| {})
        .is_err());
    assert!(runner
        .run(&ruby(), "", &"あ".repeat(349526), |_| {})
        .is_err());
    assert!(!runner.busy());
    let (result, stdout, _) = execute("puts __FILE__", "", 5000, 1048576);
    assert_eq!(result.status, "completed");
    assert!(!PathBuf::from(stdout.trim()).exists());
}

#[test]
fn stop_kills_descendants() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("orphan.txt");
    let marker_literal = serde_json_path(&marker);
    let code = format!("require 'rbconfig'; pid=spawn(RbConfig.ruby, '-e', 'sleep 0.8; File.write({marker_literal}, :survived)', out: File::NULL, err: File::NULL); puts 'ready'; Process.wait(pid)");
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    let active = Arc::clone(&runner);
    let (sender, receiver) = mpsc::channel();
    let pending = std::thread::spawn(move || {
        active.run(&ruby(), &code, "", move |event| {
            let _ = sender.send(event);
        })
    });
    receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    runner.stop();
    assert_eq!(pending.join().unwrap().unwrap().status, "stopped");
    std::thread::sleep(Duration::from_millis(1100));
    assert!(!marker.exists());
}

fn serde_json_path(path: &std::path::Path) -> String {
    format!(
        "\"{}\"",
        path.to_string_lossy()
            .replace('\\', "/")
            .replace('"', "\\\"")
    )
}
