use atcoder_ruby_ide::{compare_output, decode_output, DocumentStore, RunRequest, Runner};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

fn ruby() -> PathBuf {
    std::env::var_os("RUBY_PATH")
        .unwrap_or_else(|| "ruby".into())
        .into()
}
fn request(code: &str, stdin: &str) -> RunRequest {
    RunRequest {
        code: code.into(),
        stdin: stdin.into(),
        ..Default::default()
    }
}
fn execute(code: &str, stdin: &str) -> atcoder_ruby_ide::RunResult {
    Runner::new(Duration::from_secs(5), 1048576)
        .prepare(request(code, stdin))
        .unwrap()
        .execute(&ruby(), |_| {})
        .unwrap()
}

#[test]
fn m02_m03_document_utf8_bom_japanese_paths_and_overwrite() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("解答 空白.rb");
    std::fs::write(&first, "\u{feff}puts 'こんにちは'\r\n").unwrap();
    let mut store = DocumentStore::default();
    let opened = store.open(Some(first.clone())).unwrap();
    assert_eq!(opened.code.as_deref(), Some("puts 'こんにちは'\r\n"));
    assert_eq!(store.path(), Some(first.as_path()));
    store.save("puts 2\n", Some(first.clone())).unwrap();
    assert_eq!(std::fs::read_to_string(&first).unwrap(), "puts 2\n");
    let second = root.path().join("別名.rb");
    store.save("puts 3", Some(second.clone())).unwrap();
    assert_eq!(store.path(), Some(second.as_path()));
    assert_eq!(std::fs::read_to_string(first).unwrap(), "puts 2\n");
}

#[test]
fn m02_m03_cancel_and_io_errors_keep_current_document() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("valid.rb");
    let mut store = DocumentStore::default();
    store.save("original", Some(path.clone())).unwrap();
    assert!(store.open(None).unwrap().canceled);
    assert!(store.save("changed", None).unwrap().canceled);
    assert!(store.open(Some(root.path().join("missing.rb"))).is_err());
    assert!(store
        .save("changed", Some(root.path().join("missing/bad.rb")))
        .is_err());
    assert_eq!(store.path(), Some(path.as_path()));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
    store.reset();
    assert!(store.path().is_none());
}

#[test]
fn m11_comparison_newlines_empty_and_significant_whitespace() {
    for (actual, expected) in [
        ("6 test\n", "6 test"),
        ("日本語\r\n2\r\n", "日本語\n2"),
        ("a\rb\r", "a\nb"),
        ("", ""),
        ("\n", ""),
        ("<img src=x>", "<img src=x>"),
    ] {
        assert!(compare_output(actual, expected));
    }
    for (actual, expected) in [
        ("a\n\n", "a\n"),
        (" a", "a"),
        ("a ", "a"),
        ("a\tb", "a b"),
        ("YES", "Yes"),
        ("1.0", "1"),
        ("1 2", "2 1"),
        ("\n\n", ""),
    ] {
        assert!(!compare_output(actual, expected));
    }
}

#[test]
fn r04_utf8_cap_discards_only_incomplete_tail() {
    assert_eq!(decode_output(&[0xe3, 0x81], true), "");
    assert_eq!(decode_output(&[0xe3, 0x81], false), "�");
    assert_eq!(decode_output(&[0xff, b'x', 0xe3, 0x81], true), "�x");
    assert_eq!(decode_output("あ".as_bytes(), true), "あ");
}

#[test]
fn m04_sample_stdin_eof_and_streamed_output() {
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    let output = Arc::new(Mutex::new(Vec::new()));
    let capture = Arc::clone(&output);
    let mut req = request("a=gets.to_i; b,c=gets.split.map(&:to_i); s=gets.chomp; puts \"#{a+b+c} #{s}\"; puts STDIN.read.empty?", "1\n2 3\ntest\n");
    req.expected_output = Some("6 test\ntrue".into());
    let result = runner
        .prepare(req)
        .unwrap()
        .execute(&ruby(), move |event| {
            if event.stream == "stdout" {
                capture.lock().unwrap().extend(event.bytes);
            }
        })
        .unwrap();
    assert_eq!(result.status, "completed");
    assert_eq!(result.stdout, "6 test\ntrue\n");
    assert_eq!(result.comparison, Some(true));
    assert_eq!(output.lock().unwrap().as_slice(), result.stdout.as_bytes());
    assert!(!runner.busy());
}

#[test]
fn m05_japanese_stderr_and_verbatim_input_newlines() {
    let result = execute(
        "puts STDIN.read.bytes.join(','); puts '日本語'; warn '標準エラー'",
        "\r\n",
    );
    assert_eq!(result.stdout, "13,10\n日本語\n");
    assert_eq!(result.stderr, "標準エラー\n");
}

#[test]
fn m05_syntax_error_missing_ruby_and_recovery() {
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    assert_eq!(
        runner
            .prepare(request("puts(", ""))
            .unwrap()
            .execute(&ruby(), |_| {})
            .unwrap()
            .status,
        "failed"
    );
    assert!(runner
        .prepare(request("", ""))
        .unwrap()
        .execute(&PathBuf::from("missing-ruby-executable-for-test"), |_| {})
        .is_err());
    assert!(!runner.busy());
    assert_eq!(
        runner
            .prepare(request("puts 42", ""))
            .unwrap()
            .execute(&ruby(), |_| {})
            .unwrap()
            .stdout,
        "42\n"
    );
}

#[test]
fn m06_stop_before_spawn_and_reject_concurrent_reservations() {
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    let pending = runner.prepare(request("loop {}", "")).unwrap();
    assert!(runner.prepare(request("puts 2", "")).is_err());
    assert!(runner.stop());
    assert_eq!(pending.execute(&ruby(), |_| {}).unwrap().status, "stopped");
    assert!(!runner.busy());
}

#[test]
fn m06_stream_before_exit_stop_and_rerun() {
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    let pending = runner
        .prepare(request("puts 'ready'; sleep 10", ""))
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let running = std::thread::spawn(move || {
        pending.execute(&ruby(), move |event| {
            let _ = tx.send(event);
        })
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(3)).unwrap().bytes,
        b"ready\n"
    );
    runner.stop();
    assert_eq!(running.join().unwrap().unwrap().status, "stopped");
    assert_eq!(
        runner
            .prepare(request("puts 7", ""))
            .unwrap()
            .execute(&ruby(), |_| {})
            .unwrap()
            .stdout,
        "7\n"
    );
}

#[test]
fn m06_timeout_and_output_cap() {
    let runner = Runner::new(Duration::from_millis(200), 1024);
    assert_eq!(
        runner
            .prepare(request("loop {}", ""))
            .unwrap()
            .execute(&ruby(), |_| {})
            .unwrap()
            .status,
        "timeout"
    );
    let result = runner
        .prepare(request("loop { print 'あいうえお' }", ""))
        .unwrap()
        .execute(&ruby(), |_| {})
        .unwrap();
    assert_eq!(result.status, "output-limit");
    assert!(result.stdout.len() <= 1024);
    assert!(!result.stdout.contains('�'));
    assert!(result.output_limit_reached);
}

#[test]
fn m07_saved_file_cwd_and_current_buffer() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("input.txt"), "作業ディレクトリ").unwrap();
    let mut req = request("puts File.read('input.txt', encoding: 'UTF-8')", "");
    req.cwd = Some(root.path().to_owned());
    assert_eq!(
        Runner::new(Duration::from_secs(5), 1048576)
            .prepare(req)
            .unwrap()
            .execute(&ruby(), |_| {})
            .unwrap()
            .stdout,
        "作業ディレクトリ\n"
    );
}

#[test]
fn m08_all_input_limits_are_utf8_bytes() {
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    assert!(runner.prepare(request(&"x".repeat(1048577), "")).is_err());
    assert!(runner.prepare(request("", &"あ".repeat(349526))).is_err());
    let mut req = request("", "");
    req.expected_output = Some("あ".repeat(349526));
    assert!(runner.prepare(req).is_err());
    assert!(!runner.busy());
}

#[test]
fn m11_only_successful_runs_are_compared() {
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    for (code, expected, comparison) in [
        ("", Some(""), Some(true)),
        ("puts 1", Some("2"), Some(false)),
        ("print 'same'; exit 1", Some("same"), None),
        ("puts 1", None, None),
    ] {
        let mut req = request(code, "");
        req.expected_output = expected.map(str::to_owned);
        assert_eq!(
            runner
                .prepare(req)
                .unwrap()
                .execute(&ruby(), |_| {})
                .unwrap()
                .comparison,
            comparison
        );
    }
}

#[test]
fn temporary_source_is_removed() {
    let result = execute("puts __FILE__", "");
    assert!(!PathBuf::from(result.stdout.trim()).exists());
}

#[test]
fn r04_output_cap_after_manual_stop_drops_incomplete_utf8() {
    let runner = Runner::new(Duration::from_secs(5), 4);
    let stopped = Arc::clone(&runner);
    let result = runner
        .prepare(request("print 'あ' * 200", ""))
        .unwrap()
        .execute(&ruby(), move |_| {
            stopped.stop();
        })
        .unwrap();
    assert_eq!(result.status, "stopped");
    assert!(result.output_limit_reached);
    assert_eq!(result.stdout, "あ");
    assert!(!runner.busy());
}

#[cfg(unix)]
#[test]
fn r02_cleanup_failure_releases_reservation() {
    use std::os::unix::fs::PermissionsExt;
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    let directory = Arc::new(Mutex::new(String::new()));
    let capture = Arc::clone(&directory);
    let result = runner
        .prepare(request("puts __dir__; File.chmod(0, __dir__)", ""))
        .unwrap()
        .execute(&ruby(), move |event| {
            if event.stream == "stdout" {
                *capture.lock().unwrap() = String::from_utf8(event.bytes).unwrap().trim().into();
            }
        });
    let path = PathBuf::from(directory.lock().unwrap().clone());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::remove_dir_all(path).unwrap();
    assert!(result.is_err());
    assert!(!runner.busy());
    assert_eq!(
        runner
            .prepare(request("puts 42", ""))
            .unwrap()
            .execute(&ruby(), |_| {})
            .unwrap()
            .stdout,
        "42\n"
    );
}

#[test]
fn m06_descendants_are_stopped_even_after_parent_exit() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("orphan.txt");
    let literal = format!("\"{}\"", marker.to_string_lossy().replace('\\', "/"));
    let code = format!("require 'rbconfig'; spawn(RbConfig.ruby, '-e', 'sleep 0.8; File.write({literal}, \"survived\")'); puts 'parent done'");
    let runner = Runner::new(Duration::from_millis(300), 1048576);
    let result = runner
        .prepare(request(&code, ""))
        .unwrap()
        .execute(&ruby(), |_| {})
        .unwrap();
    assert_eq!(result.status, "timeout");
    std::thread::sleep(Duration::from_millis(900));
    assert!(!marker.exists());
}
