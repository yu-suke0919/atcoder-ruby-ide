use atcoder_ruby_ide::{compare_output, decode_output, DocumentStore, RunRequest, Runner};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

#[test]
fn m14_sample_json_roundtrip_cancel_and_failed_writes_preserve_files() {
    use atcoder_ruby_ide::{load_samples, save_samples, SampleCase};
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("サンプル 空白.json");
    let cases = || {
        vec![
            SampleCase {
                stdin: "日本語\r\n".into(),
                expected_output: "".into(),
                compare: true,
            },
            SampleCase {
                stdin: "two".into(),
                expected_output: "ignored".into(),
                compare: false,
            },
        ]
    };
    assert!(load_samples(None).unwrap().canceled);
    assert!(save_samples(cases(), None).unwrap().canceled);
    save_samples(cases(), Some(file.clone())).unwrap();
    assert_eq!(
        load_samples(Some(file.clone())).unwrap().cases.unwrap(),
        cases()
    );
    let original = std::fs::read(&file).unwrap();
    assert!(save_samples(vec![], Some(file.clone())).is_err());
    assert_eq!(std::fs::read(&file).unwrap(), original);
    let protected = root.path().join("directory.json");
    std::fs::create_dir(&protected).unwrap();
    std::fs::write(protected.join("keep"), "preserved").unwrap();
    assert!(save_samples(cases(), Some(protected.clone())).is_err());
    assert_eq!(
        std::fs::read_to_string(protected.join("keep")).unwrap(),
        "preserved"
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
    save_samples(cases(), Some(file.clone())).unwrap();
    assert_eq!(load_samples(Some(file)).unwrap().cases.unwrap(), cases());
}

#[test]
fn m14_sample_json_rejects_invalid_types_counts_and_utf8_byte_limits() {
    use atcoder_ruby_ide::load_samples;
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("invalid.json");
    for invalid in [
        "not JSON".to_string(), "[]".into(), r#"{"cases":[]}"#.into(),
        r#"{"cases":[{"stdin":1,"expectedOutput":"","compare":true}]}"#.into(),
        r#"{"cases":[{"stdin":"","compare":true}]}"#.into(),
        serde_json::json!({"cases":vec![serde_json::json!({"stdin":"", "expectedOutput":"", "compare":true}); 101]}).to_string(),
        serde_json::json!({"cases":[{"stdin":"あ".repeat(349526), "expectedOutput":"", "compare":true}]}).to_string(),
        serde_json::json!({"cases":[{"stdin":"", "expectedOutput":"x".repeat(1048577), "compare":false}]}).to_string(),
        " ".repeat(16 * 1024 * 1024 + 1),
    ] {
        std::fs::write(&file, invalid).unwrap();
        assert!(load_samples(Some(file.clone())).is_err());
    }
    std::fs::write(
        &file,
        "\u{feff}{\"cases\":[{\"stdin\":\"\",\"expectedOutput\":\"\",\"compare\":true}]}",
    )
    .unwrap();
    assert_eq!(load_samples(Some(file)).unwrap().cases.unwrap().len(), 1);
}

fn ruby() -> PathBuf {
    std::env::var_os("RUBY_PATH")
        .unwrap_or_else(|| "ruby".into())
        .into()
}

#[test]
fn m19_atcoder_ruby_and_portable_gems_execute_with_standard_libraries() {
    let source: serde_json::Value =
        serde_json::from_str(include_str!("../config/ruby-windows.json")).unwrap();
    let version = source["rubyVersion"].as_str().unwrap();
    let code = format!(
        "raise 'Ruby patch differs from pinned config' unless RUBY_VERSION == {version:?}\n{}",
        include_str!("fixtures/runtime-gems.rb")
    );
    let result = Runner::new(Duration::from_secs(5), 1048576)
        .prepare(request(&code, "日本語\n"))
        .unwrap()
        .execute(&ruby(), |_| {})
        .unwrap();
    assert_eq!(result.status, "completed", "{}", result.stderr);
    assert_eq!(result.stdout, include_str!("fixtures/runtime-gems.txt"));
    assert_eq!(result.stderr, "");
}

#[test]
fn m15_run_result_serializes_the_same_comparison_and_difference() {
    for (code, expected, comparison, difference) in [
        (
            "print '日😀A'",
            Some("日😀B"),
            Some(false),
            serde_json::json!({"line":1,"column":3,"actualLine":"日😀A","expectedLine":"日😀B"}),
        ),
        (
            "print 'ok'",
            Some("ok\n\n"),
            Some(false),
            serde_json::json!({"line":2,"column":1,"actualLine":null,"expectedLine":""}),
        ),
        (
            "",
            Some("x"),
            Some(false),
            serde_json::json!({"line":1,"column":1,"actualLine":"","expectedLine":"x"}),
        ),
        ("puts 'ok'", Some("ok"), Some(true), serde_json::Value::Null),
        ("print 'actual'", None, None, serde_json::Value::Null),
        (
            "print 'actual'; exit 1",
            Some("expected"),
            None,
            serde_json::Value::Null,
        ),
    ] {
        let mut req = request(code, "");
        req.expected_output = expected.map(str::to_owned);
        let result = Runner::new(Duration::from_secs(5), 1048576)
            .prepare(req)
            .unwrap()
            .execute(&ruby(), |_| {})
            .unwrap();
        assert_eq!(result.comparison, comparison);
        assert_eq!(result.clone().difference, result.difference);
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["difference"], difference);
        assert_eq!(json["comparison"], serde_json::json!(comparison));
    }
}

#[test]
fn m15_stopped_and_limited_runs_have_no_comparison_details() {
    let mut req = request("loop {}", "");
    req.expected_output = Some("expected".into());
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    let prepared = runner.prepare(req).unwrap();
    runner.stop();
    let result = prepared.execute(&ruby(), |_| {}).unwrap();
    assert_eq!(result.status, "stopped");
    assert_eq!(result.comparison, None);
    assert_eq!(result.difference, None);
    for (code, timeout, limit, status) in [
        ("loop {}", Duration::from_millis(200), 1048576, "timeout"),
        (
            "loop { print 'x' * 128 }",
            Duration::from_secs(5),
            32,
            "output-limit",
        ),
    ] {
        let mut req = request(code, "");
        req.expected_output = Some("expected".into());
        let result = Runner::new(timeout, limit)
            .prepare(req)
            .unwrap()
            .execute(&ruby(), |_| {})
            .unwrap();
        assert_eq!(result.status, status);
        assert_eq!(result.comparison, None);
        assert_eq!(result.difference, None);
    }
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
fn error_positions_follow_the_executed_source_including_library_callers() {
    for (code, line) in [
        ("# 日本語\nraise 'boom'\n", 2),
        ("# 日本語\nif true\n", 2),
        ("def explode\n  raise 'boom'\nend\nexplode\n", 2),
        ("require 'json'\nJSON.parse('{')\n", 2),
        ("$VERBOSE = true\nA = 1\nA = 2\nraise 'boom'\n", 4),
    ] {
        let result = execute(code, "");
        assert_eq!(result.status, "failed");
        assert!(!result.stderr.is_empty());
        assert_eq!(
            serde_json::to_value(result).unwrap()["errorLine"],
            line,
            "{code}"
        );
    }
}

#[test]
fn error_positions_ignore_success_unrelated_backtraces_and_missing_locations() {
    for code in [
        "warn \"#{__FILE__}:1: warning\"",
        "warn 'unknown'; exit 1",
        "e = RuntimeError.new('boom'); e.set_backtrace(['/other/solution.rb:1:in main']); raise e",
    ] {
        let result = execute(code, "");
        assert_eq!(
            serde_json::to_value(result).unwrap()["errorLine"],
            serde_json::Value::Null
        );
    }
}

#[test]
fn m06_stop_before_spawn_and_reject_concurrent_reservations() {
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    let pending = runner.prepare(request("loop {}", "")).unwrap();
    assert!(runner.prepare(request("puts 2", "")).is_err());
    assert!(runner.stop());
    let result = pending.execute(&ruby(), |_| {}).unwrap();
    assert_eq!(result.status, "stopped");
    assert_eq!(result.error_line, None);
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
    assert!(!runner.busy());
    // Output limiting is independent of the short timeout used above. Cold Windows
    // Ruby startup can exceed 200 ms under concurrent test load.
    let runner = Runner::new(Duration::from_secs(5), 1024);
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
fn r04_output_cap_precedes_notification_stop_and_drops_incomplete_utf8() {
    for stream in ["STDOUT", "STDERR"] {
        let runner = Runner::new(Duration::from_secs(5), 4);
        let stopped = Arc::clone(&runner);
        let result = runner
            .prepare(request(&format!("{stream}.write('あ' * 200)"), ""))
            .unwrap()
            .execute(&ruby(), move |_| {
                stopped.stop();
            })
            .unwrap();
        assert_eq!(result.status, "output-limit", "{stream}");
        assert!(result.output_limit_reached);
        let (captured, other) = if stream == "STDOUT" {
            (&result.stdout, &result.stderr)
        } else {
            (&result.stderr, &result.stdout)
        };
        assert_eq!(captured, "あ");
        assert!(other.is_empty());
        assert!(!runner.busy());
    }
}

fn with_delayed_notification(code: &str, expected: &str) -> atcoder_ruby_ide::RunResult {
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    let mut req = request(code, "");
    req.expected_output = Some(expected.into());
    let prepared = runner.prepare(req).unwrap();
    let (entered, notified) = mpsc::channel();
    let (release, waiting) = mpsc::channel();
    let gate = Mutex::new(Some(waiting));
    let chunks = Arc::new(Mutex::new((Vec::new(), Vec::new())));
    let received = Arc::clone(&chunks);
    let running = std::thread::spawn(move || {
        prepared.execute(&ruby(), move |event| {
            let first = gate.lock().unwrap().take();
            if let Some(waiting) = first {
                let _ = entered.send(event.bytes.len());
                let _ = waiting.recv_timeout(Duration::from_secs(10));
            }
            let mut chunks = received.lock().unwrap();
            if event.stream == "stdout" {
                chunks.0.extend(event.bytes);
            } else {
                chunks.1.extend(event.bytes);
            }
        })
    });
    let first = notified.recv_timeout(Duration::from_secs(8));
    if first.is_ok() {
        // Hold the first notification beyond the real five-second process limit.
        std::thread::sleep(Duration::from_secs(6));
    }
    let _ = release.send(());
    let result = running.join().unwrap().unwrap();
    assert!(first.unwrap() < 1048576);
    let chunks = chunks.lock().unwrap();
    assert_eq!(chunks.0, result.stdout.as_bytes());
    assert_eq!(chunks.1, result.stderr.as_bytes());
    assert!(!runner.busy());
    result
}

#[test]
fn delayed_notification_does_not_block_output_limit_detection() {
    let result = with_delayed_notification("STDOUT.write('x' * (1024 * 1024 + 1)); sleep 10", "");
    assert_eq!(result.status, "output-limit");
    assert!(result.output_limit_reached);
    assert_eq!(result.stdout, "x".repeat(1048576));
    assert_eq!(result.comparison, None);
}

#[test]
fn delayed_notification_after_process_exit_does_not_cause_timeout() {
    let result = with_delayed_notification("puts '通知の待機'", "通知の待機\n");
    assert_eq!(result.status, "completed");
    assert!(!result.output_limit_reached);
    assert_eq!(result.stdout, "通知の待機\n");
    assert_eq!(result.comparison, Some(true));
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
    let code = format!("require 'rbconfig'; spawn(RbConfig.ruby, '-e', 'sleep 2.5; File.write({literal}, \"survived\")'); puts 'parent done'");
    let runner = Runner::new(Duration::from_secs(1), 1048576);
    let result = runner
        .prepare(request(&code, ""))
        .unwrap()
        .execute(&ruby(), |_| {})
        .unwrap();
    assert_eq!(result.status, "timeout");
    assert_eq!(result.stdout, "parent done\n");
    std::thread::sleep(Duration::from_millis(2700));
    assert!(!marker.exists());
}

#[test]
fn m08_source_open_and_save_enforce_utf8_byte_limit_without_changing_current_document() {
    let root = tempfile::tempdir().unwrap();
    let current = root.path().join("current.rb");
    let candidate = root.path().join("candidate.rb");
    let mut store = DocumentStore::default();
    store.save("original", Some(current.clone())).unwrap();
    let at_limit = "あ".repeat(349525) + "a";
    assert_eq!(at_limit.len(), 1048576);
    std::fs::write(&candidate, &at_limit).unwrap();
    assert_eq!(
        store.open(Some(candidate.clone())).unwrap().code.as_deref(),
        Some(at_limit.as_str())
    );
    store.save(&at_limit, Some(current.clone())).unwrap();
    assert_eq!(std::fs::read_to_string(&current).unwrap(), at_limit);

    // Count bytes on disk, including an optional UTF-8 BOM.
    std::fs::write(&candidate, format!("\u{feff}{at_limit}")).unwrap();
    assert!(store
        .open(Some(candidate.clone()))
        .err()
        .unwrap()
        .contains("1 MiB"));
    assert_eq!(store.path(), Some(current.as_path()));
    assert!(store
        .save(&(at_limit.clone() + "a"), Some(current.clone()))
        .err()
        .unwrap()
        .contains("1 MiB"));
    assert_eq!(std::fs::read_to_string(&current).unwrap(), at_limit);
    assert_eq!(store.path(), Some(current.as_path()));

    std::fs::write(&candidate, [0xff]).unwrap();
    assert!(store.open(Some(candidate)).is_err());
    assert_eq!(store.path(), Some(current.as_path()));
}

#[test]
fn m03_atomic_source_save_failure_preserves_target_and_removes_temporary_files() {
    let root = tempfile::tempdir().unwrap();
    let current = root.path().join("current.rb");
    let target = root.path().join("occupied.rb");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("keep"), "keep").unwrap();
    let mut store = DocumentStore::default();
    store.save("original", Some(current.clone())).unwrap();
    assert!(store.save("replacement", Some(target.clone())).is_err());
    assert_eq!(std::fs::read_to_string(&current).unwrap(), "original");
    assert_eq!(
        std::fs::read_to_string(target.join("keep")).unwrap(),
        "keep"
    );
    assert_eq!(store.path(), Some(current.as_path()));
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
}
