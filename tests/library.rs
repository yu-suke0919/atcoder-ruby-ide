use atcoder_ruby_ide::{
    browser_target, fetch_page, http_client, parse_task, parse_task_list, Contest, ContestKey,
    Contests, DocumentStore, SampleCase, Task, Workspaces,
};
use std::path::Path;

const URL: &str = "https://atcoder.jp/contests/abs/tasks/practice_1";
const HTML: &str = include_str!("fixtures/atcoder-task.html");
const TESSOKU: &str = include_str!("fixtures/atcoder-tessoku-tasks.html");

fn with_limits(header: &str) -> String {
    HTML.replace(
        "<div id=\"task-statement\">",
        &format!("<p>{header}</p><div id=\"task-statement\">"),
    )
}

#[test]
fn task_page_pairs_samples_by_number_without_keeping_the_statement() {
    let task = parse_task(&format!("{URL}?lang=en#sample"), HTML).unwrap();
    assert_eq!(task.url, URL);
    assert_eq!(task.samples.len(), 2);
    assert_eq!(task.samples[0].stdin, "1 2\n");
    assert_eq!(task.samples[1].expected_output, "30\n");
    let saved = serde_json::to_value(&task).unwrap();
    assert_eq!(
        saved.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["samples", "url"]
    );
}

#[test]
fn english_empty_output_entities_and_legacy_pages() {
    let html = r#"<span class="h2">B - Test</span><div id="task-statement"><section><h3>Sample Input 1</h3><pre>&lt;tag&gt; &amp; x
</pre></section><section><h3>Sample Output 1</h3><pre></pre></section></div>"#;
    let task = parse_task(URL, html).unwrap();
    assert_eq!(task.samples[0].stdin, "<tag> & x\n");
    assert_eq!(task.samples[0].expected_output, "");
    let snow = parse_task(
        "https://atcoder.jp/contests/abc001/tasks/abc001_1",
        include_str!("fixtures/atcoder-snow.html"),
    )
    .unwrap();
    let pairs: Vec<_> = snow
        .samples
        .iter()
        .map(|s| (s.stdin.as_str(), s.expected_output.as_str()))
        .collect();
    assert_eq!(
        pairs,
        [("15\n10\n", "5\n"), ("0\n0\n", "0\n"), ("5\n20\n", "-15\n")]
    );
    let product = parse_task(
        "https://atcoder.jp/contests/abc086/tasks/abc086_a",
        include_str!("fixtures/atcoder-product.html"),
    )
    .unwrap();
    assert_eq!(product.samples[0].stdin, "3 4\n");
    assert_eq!(product.samples[1].expected_output, "Odd\n");
}

#[test]
fn copy_buttons_added_by_the_loaded_page_are_not_part_of_sample_headings() {
    // The app reads the page after AtCoder's script adds Copy buttons to each sample.
    let html = r#"<div id="task-statement"><span class="lang"><span class="lang-ja"><div class="part"><section><h3>入力例 1<span class="btn btn-default btn-sm btn-copy" tabindex="0" data-toggle="tooltip" data-trigger="manual" title="Copied!" data-target="pre-sample0">Copy</span></h3><div class="div-btn-copy"><span class="btn-copy btn-pre" tabindex="0" data-toggle="tooltip" data-trigger="manual" title="Copied!" data-target="pre-sample0">Copy</span></div><pre id="pre-sample0">10 20 30 40
</pre></section></div><div class="part"><section><h3>出力例 1<span class="btn btn-default btn-sm btn-copy" tabindex="0" data-target="pre-sample1">Copy</span></h3><div class="div-btn-copy"><span class="btn-copy btn-pre" data-target="pre-sample1">Copy</span></div><pre id="pre-sample1">No
</pre></section></div></span></span></div>"#;
    let task = parse_task(URL, html).unwrap();
    assert_eq!(task.samples.len(), 1);
    assert_eq!(task.samples[0].stdin, "10 20 30 40\n");
    assert_eq!(task.samples[0].expected_output, "No\n");
}

#[test]
fn the_url_field_opens_only_allowed_origins() {
    for (input, expected) in [
        (
            "https://atcoder.jp/contests/abc430/tasks/abc430_a",
            "https://atcoder.jp/contests/abc430/tasks/abc430_a",
        ),
        (
            "  atcoder.jp/contests/abc430  ",
            "https://atcoder.jp/contests/abc430",
        ),
        ("https://atcoder.jp", "https://atcoder.jp/"),
    ] {
        assert_eq!(browser_target(input).unwrap().as_str(), expected, "{input}");
    }
    for input in [
        "https://example.com/",
        "http://atcoder.jp/",
        "https://atcoder.jp.example.com/",
        "https://img.atcoder.jp/x.png",
        "javascript:alert(1)",
        "file:///C:/Windows",
        "",
    ] {
        let error = browser_target(input).unwrap_err();
        assert!(error.contains("https://atcoder.jp"), "{input}: {error}");
    }
}

#[test]
fn task_limits_parse_exact_milliseconds_in_both_languages() {
    for (header, time, memory) in [
        (
            "実行時間制限: 2 sec / メモリ制限: 1024 MiB",
            Some(2000),
            Some(1024),
        ),
        (
            "Time Limit: 1.001 sec / Memory Limit: 64 MiB",
            Some(1001),
            Some(64),
        ),
        ("Time Limit: 4294967.295 sec", Some(u32::MAX), None),
        ("", None, None),
    ] {
        let task = parse_task(URL, &with_limits(header)).unwrap();
        assert_eq!(task.time_limit_ms, time, "{header}");
        assert_eq!(task.memory_limit_mib, memory, "{header}");
    }
    let body_mentions_limits =
        HTML.replace("図の説明", "<p>Time Limit: 0 sec / Memory Limit: 0 MiB</p>");
    assert_eq!(
        parse_task(URL, &body_mentions_limits)
            .unwrap()
            .time_limit_ms,
        None
    );
    for header in [
        "Time Limit: 0 sec",
        "Time Limit: 1.0001 sec",
        "Memory Limit: 64 MB",
        "Time Limit: 1 sec / Time Limit: 2 sec",
    ] {
        assert!(
            parse_task(URL, &with_limits(header))
                .unwrap_err()
                .contains("制限値"),
            "{header}"
        );
    }
}

#[test]
fn pages_without_a_statement_ask_for_login_and_invalid_samples_are_rejected() {
    // A logged-out live task page has no #task-statement (AtCoder returns "Permission denied.").
    let denied = r#"<div class="alert alert-danger">Permission denied.</div>"#;
    assert!(parse_task(URL, denied).unwrap_err().contains("ログイン"));
    for html in [
        HTML.replace("出力例 1", "出力例 3"),
        HTML.replace("入力例 2", "入力例 1"),
        HTML.replace("1 2", &"x".repeat(1048577)),
        r#"<div id="task-statement"><h3>入力例 1</h3><h3>説明</h3><pre>x</pre><h3>出力例 1</h3><pre>y</pre></div>"#.into(),
    ] {
        assert!(parse_task(URL, &html).is_err());
    }
    for url in [
        "http://atcoder.jp/contests/abs/tasks/practice_1",
        "https://atcoder.jp.evil.test/contests/abs/tasks/practice_1",
        "https://user@atcoder.jp/contests/abs/tasks/practice_1",
        "https://atcoder.jp/contests/abs/tasks/a%2fb",
    ] {
        assert!(parse_task(url, HTML).is_err(), "{url}");
    }
}

#[test]
fn workspace_opens_only_after_the_page_was_read_and_keeps_user_data_on_rereads() {
    let root = tempfile::tempdir().unwrap();
    let workspaces = Workspaces::new(root.path());
    let mut documents = DocumentStore::default();
    assert!(workspaces.task(URL).unwrap().is_none());
    assert!(workspaces
        .open(URL, "A", documents.revision(), &mut documents)
        .unwrap_err()
        .contains("読み取っていません"));
    assert!(!root.path().join("workspaces/abs/practice_1/files").exists());

    let task = parse_task(
        URL,
        &with_limits("実行時間制限: 2 sec / メモリ制限: 1024 MiB"),
    )
    .unwrap();
    workspaces.store_task(&task).unwrap();
    let opened = workspaces
        .open(URL, "A", documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(opened.task, task);
    // The first open makes two empty files named after the task's label.
    assert_eq!(opened.files, ["A_1", "A_2"]);
    assert_eq!(opened.file, "A_1");
    assert_eq!(
        Path::new(&opened.document.file_path),
        root.path().join("workspaces/abs/practice_1/files/A_1.rb")
    );
    assert_eq!(opened.document.code, "");
    assert!(!root
        .path()
        .join("workspaces/abs/practice_1/solution.rb")
        .exists());
    assert!(opened
        .cases
        .iter()
        .all(|case| case.compare && case.tolerance.is_none()));
    documents.save("puts 'mine'").unwrap();
    let mut edited = opened.cases.clone();
    edited[0].stdin = "edited\n".into();
    workspaces.save_cases(URL, edited.clone()).unwrap();

    let reread = Task {
        time_limit_ms: Some(3000),
        ..task
    };
    workspaces.store_task(&reread).unwrap();
    let reopened = workspaces
        .open(URL, "A", documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(reopened.task.time_limit_ms, Some(3000));
    assert_eq!(reopened.document.code, "puts 'mine'");
    assert_eq!(reopened.cases, edited);
}

#[test]
fn home_opens_without_a_task_and_keeps_its_code_and_samples_apart_from_problems() {
    let root = tempfile::tempdir().unwrap();
    let workspaces = Workspaces::new(root.path());
    let mut documents = DocumentStore::default();
    let home = workspaces
        .open_home(documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(home.document.code, "");
    assert_eq!(home.files, ["home_1", "home_2"]);
    assert_eq!(
        Path::new(&home.document.file_path),
        root.path().join("home/files/home_1.rb")
    );
    assert_eq!(home.cases.len(), 1);
    assert!(!home.cases[0].compare && home.cases[0].stdin.is_empty());
    documents.save("puts gets").unwrap();
    let cases = vec![SampleCase {
        stdin: "1\n".into(),
        expected_output: "1\n".into(),
        compare: true,
        tolerance: None,
    }];
    workspaces.save_home_cases(cases.clone()).unwrap();
    let reopened = workspaces
        .open_home(documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(reopened.document.code, "puts gets");
    assert_eq!(reopened.cases, cases);
    assert!(!root.path().join("workspaces").exists());
    let stale = documents.revision();
    documents.reset();
    assert!(workspaces.open_home(stale, &mut documents).is_err());
}

#[test]
fn unreadable_task_data_is_read_again_and_late_opens_do_not_replace_the_document() {
    let root = tempfile::tempdir().unwrap();
    let workspaces = Workspaces::new(root.path());
    let directory = root.path().join("workspaces/abs/practice_1");
    std::fs::create_dir_all(&directory).unwrap();
    for broken in [
        "{}".to_string(),
        r#"{"url":"https://atcoder.jp/contests/abs/tasks/practice_1","samples":[],"statement":[]}"#
            .into(),
        r#"{"url":"https://atcoder.jp/contests/abs/tasks/other","samples":[]}"#.into(),
    ] {
        std::fs::write(directory.join("task.json"), broken).unwrap();
        assert!(workspaces.task(URL).unwrap().is_none());
    }
    workspaces
        .store_task(&parse_task(URL, HTML).unwrap())
        .unwrap();
    let current = root.path().join("current.rb");
    std::fs::write(&current, "keep").unwrap();
    let mut documents = DocumentStore::default();
    let revision = documents.revision();
    documents.open(current.clone()).unwrap();
    assert!(workspaces.open(URL, "A", revision, &mut documents).is_err());
    assert_eq!(documents.path(), Some(current.as_path()));
    std::fs::write(directory.join("cases.json"), r#"{"cases":[]}"#).unwrap();
    assert!(workspaces
        .open(URL, "A", documents.revision(), &mut documents)
        .is_err());
    assert_eq!(documents.path(), Some(current.as_path()));
}

#[test]
fn tasks_without_samples_open_with_one_uncompared_empty_case() {
    let html = r#"<div id="task-statement"><section><h3>問題文</h3><p>高さを調整してください。</p></section><section><h3>入出力例1</h3><p><a href="https://img.atcoder.jp/example.zip">zip</a></p></section></div>"#;
    let task = parse_task(URL, html).unwrap();
    assert!(task.samples.is_empty());
    let root = tempfile::tempdir().unwrap();
    let workspaces = Workspaces::new(root.path());
    workspaces.store_task(&task).unwrap();
    let mut documents = DocumentStore::default();
    let opened = workspaces
        .open(URL, "A", documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(
        opened.cases,
        vec![SampleCase {
            tolerance: None,
            stdin: String::new(),
            expected_output: String::new(),
            compare: false
        }]
    );
}

#[test]
fn existing_solutions_and_cases_are_reused_when_the_task_is_read_for_the_first_time() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("workspaces/abs/practice_1");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("solution.rb"), "puts 'before U2b'").unwrap();
    std::fs::write(
        directory.join("cases.json"),
        include_bytes!("fixtures/cases-without-tolerance.json"),
    )
    .unwrap();
    let workspaces = Workspaces::new(root.path());
    workspaces
        .store_task(&parse_task(URL, HTML).unwrap())
        .unwrap();
    let mut documents = DocumentStore::default();
    let opened = workspaces
        .open(URL, "A", documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(opened.document.code, "puts 'before U2b'");
    assert_eq!(opened.cases[0].stdin, "保存済み\r\n");
    // solution.rb becomes the first file once and stays as it was.
    assert_eq!(opened.files, ["A_1", "A_2"]);
    let read = |name: &str| std::fs::read_to_string(directory.join(name)).unwrap();
    assert_eq!(read("files/A_1.rb"), "puts 'before U2b'");
    assert_eq!(read("files/A_2.rb"), "");
    assert_eq!(read("solution.rb"), "puts 'before U2b'");
    std::fs::write(directory.join("solution.rb"), "puts 'changed later'").unwrap();
    let reopened = workspaces
        .open(URL, "A", documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(reopened.document.code, "puts 'before U2b'");
}

#[test]
fn a_solution_that_cannot_be_converted_is_left_as_it_was() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("workspaces/abs/practice_1");
    // A directory where solution.rb should be cannot be read, so nothing is converted.
    std::fs::create_dir_all(directory.join("solution.rb")).unwrap();
    std::fs::write(directory.join("solution.rb/keep.txt"), "keep").unwrap();
    let workspaces = Workspaces::new(root.path());
    workspaces
        .store_task(&parse_task(URL, HTML).unwrap())
        .unwrap();
    let mut documents = DocumentStore::default();
    let error = workspaces
        .open(URL, "A", documents.revision(), &mut documents)
        .unwrap_err();
    assert!(error.contains("solution.rb"), "{error}");
    let mut names: Vec<_> = std::fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["cases.json", "solution.rb", "task.json"]);
    assert_eq!(
        std::fs::read_to_string(directory.join("solution.rb/keep.txt")).unwrap(),
        "keep"
    );
    assert_eq!(documents.path(), None);
}

#[test]
fn files_are_added_renamed_and_deleted_with_safe_unique_names_in_natural_order() {
    let root = tempfile::tempdir().unwrap();
    let workspaces = Workspaces::new(root.path());
    workspaces
        .store_task(&parse_task(URL, HTML).unwrap())
        .unwrap();
    let mut documents = DocumentStore::default();
    workspaces
        .open(URL, "A", documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(workspaces.create_file(URL, "A").unwrap(), "A_3");
    // A copy has the same code under the next free name.
    std::fs::write(
        root.path().join("workspaces/abs/practice_1/files/A_2.rb"),
        "puts 'copy me'",
    )
    .unwrap();
    assert_eq!(workspaces.copy_file(URL, "A_2", "A").unwrap(), "A_4");
    assert_eq!(
        std::fs::read_to_string(root.path().join("workspaces/abs/practice_1/files/A_4.rb"))
            .unwrap(),
        "puts 'copy me'"
    );
    assert!(workspaces.copy_file(URL, "missing", "A").is_err());
    workspaces.delete_file(URL, "A_4", &documents).unwrap();
    workspaces
        .rename_file(URL, "A_3", "brute", &mut documents)
        .unwrap();
    for invalid in [
        "",
        "a b",
        "../x",
        "x.rb",
        "CON",
        "日本語",
        &"a".repeat(41),
        "a_1",
    ] {
        assert!(
            workspaces
                .rename_file(URL, "brute", invalid, &mut documents)
                .is_err(),
            "{invalid}"
        );
    }
    workspaces
        .rename_file(URL, "brute", "A_10", &mut documents)
        .unwrap();
    assert_eq!(workspaces.files(URL).unwrap(), ["A_1", "A_2", "A_10"]);
    // The open file follows its new name.
    workspaces
        .rename_file(URL, "A_1", "main", &mut documents)
        .unwrap();
    let file = root.path().join("workspaces/abs/practice_1/files/main.rb");
    assert_eq!(documents.path(), Some(file.as_path()));
    documents.save("puts 'renamed'").unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "puts 'renamed'");
    assert!(workspaces.delete_file(URL, "main", &documents).is_err());
    workspaces.delete_file(URL, "A_2", &documents).unwrap();
    workspaces.delete_file(URL, "A_10", &documents).unwrap();
    assert_eq!(workspaces.files(URL).unwrap(), ["main"]);
    let opened = workspaces.open_file(URL, "main", &mut documents).unwrap();
    assert_eq!(opened.code, "puts 'renamed'");
    documents.reset();
    // The last file stays even when it is not open.
    assert!(workspaces.delete_file(URL, "main", &documents).is_err());
    assert!(workspaces
        .open_file(URL, "../task", &mut documents)
        .is_err());
    assert!(workspaces.create_file("home", "home").is_err());
}

#[test]
fn contest_and_task_urls_register_the_same_contest() {
    for (url, task) in [
        ("https://atcoder.jp/contests/tessoku-book", None),
        (
            "https://atcoder.jp/contests/tessoku-book/tasks/?lang=ja",
            None,
        ),
        (
            "https://atcoder.jp/contests/tessoku-book/tasks/tessoku_book_a#x",
            Some("https://atcoder.jp/contests/tessoku-book/tasks/tessoku_book_a"),
        ),
    ] {
        let key = ContestKey::parse(url).unwrap();
        assert_eq!(key.url, "https://atcoder.jp/contests/tessoku-book");
        assert_eq!(key.id, "tessoku-book");
        assert_eq!(key.task.as_deref(), task);
    }
    for url in [
        "https://atcoder.jp/contests",
        "https://atcoder.jp/contests/abc/submissions",
        "https://evil.test/contests/abc",
        "https://atcoder.jp/contests/a%2fb",
    ] {
        assert!(ContestKey::parse(url).is_err(), "{url}");
    }
}

#[test]
fn real_task_list_keeps_names_labels_urls_and_official_order() {
    let contest = parse_task_list("https://atcoder.jp/contests/tessoku-book", TESSOKU).unwrap();
    assert_eq!(contest.title, "競技プログラミングの鉄則 演習問題集");
    assert_eq!(contest.tasks.len(), 151);
    assert_eq!(contest.tasks[0].label, "A01");
    assert_eq!(
        contest.tasks[0].url,
        "https://atcoder.jp/contests/tessoku-book/tasks/tessoku_book_a"
    );
    assert!(!contest.hidden);
    assert!(parse_task_list(
        "https://atcoder.jp/contests/tessoku-book",
        "<a class=\"contest-title\">x</a>"
    )
    .unwrap_err()
    .contains("ログイン"));
}

#[test]
fn registration_saves_lists_hides_and_keeps_hidden_state_and_workspaces() {
    let root = tempfile::tempdir().unwrap();
    let contests = Contests::new(root.path());
    let fetched = std::cell::RefCell::new(Vec::new());
    let fetch = |url: &str| {
        fetched.borrow_mut().push(url.to_string());
        Ok(TESSOKU.to_string())
    };
    let registered = contests
        .register(
            "https://atcoder.jp/contests/tessoku-book/tasks/tessoku_book_b",
            fetch,
        )
        .unwrap();
    assert_eq!(
        fetched.borrow().as_slice(),
        ["https://atcoder.jp/contests/tessoku-book/tasks?lang=ja"]
    );
    assert_eq!(
        registered.task.as_deref(),
        Some("https://atcoder.jp/contests/tessoku-book/tasks/tessoku_book_b")
    );
    let hidden = contests.set_hidden(&registered.contest.url, true).unwrap();
    assert!(hidden.hidden);
    let again = contests
        .register("https://atcoder.jp/contests/tessoku-book", |_| {
            Ok(TESSOKU.to_string())
        })
        .unwrap();
    assert!(again.contest.hidden);
    assert_eq!(contests.list().unwrap(), vec![again.contest.clone()]);
    std::fs::write(root.path().join("contests/broken.json"), "{}").unwrap();
    assert_eq!(contests.list().unwrap().len(), 1);
    assert_eq!(
        std::fs::read_to_string(root.path().join("contests/broken.json")).unwrap(),
        "{}"
    );
    let failed = contests.register("https://atcoder.jp/contests/tessoku-book", |_| {
        Err("offline".into())
    });
    assert_eq!(failed.err().as_deref(), Some("offline"));
    let saved: Contest = serde_json::from_slice(
        &std::fs::read(root.path().join("contests/tessoku-book.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(saved, again.contest);
    assert!(contests
        .register(
            "https://atcoder.jp/contests/tessoku-book/tasks/missing_task",
            |_| Ok(TESSOKU.to_string())
        )
        .is_err());
}

#[test]
fn page_requests_send_browser_cookies_and_report_login_redirects() {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let mut cookies = Vec::new();
        for status in ["200 OK", "302 Found", "404 Not Found"] {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            let mut cookie = String::new();
            while reader.read_line(&mut line).unwrap() > 2 {
                if let Some(value) = line
                    .strip_prefix("cookie: ")
                    .or_else(|| line.strip_prefix("Cookie: "))
                {
                    cookie = value.trim().into();
                }
                line.clear();
            }
            cookies.push(cookie);
            let body = "<html>tasks</html>";
            write!(&stream, "HTTP/1.1 {status}\r\nLocation: /login\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        cookies
    });
    let client = http_client().unwrap();
    let url = format!("http://{address}/contests/abc/tasks");
    assert_eq!(
        fetch_page(&client, &url, "REVEL_SESSION=abc").unwrap(),
        "<html>tasks</html>"
    );
    assert!(fetch_page(&client, &url, "")
        .unwrap_err()
        .contains("ログイン"));
    assert!(fetch_page(&client, &url, "")
        .unwrap_err()
        .contains("参加登録"));
    assert_eq!(server.join().unwrap(), ["REVEL_SESSION=abc", "", ""]);
}

fn ruby() -> std::ffi::OsString {
    std::env::var_os("RUBY_PATH").unwrap_or_else(|| "ruby".into())
}

#[test]
#[ignore = "AtCoderの公開ページへ接続する。npm run test:atcoder-live で明示実行"]
fn live_atcoder_task_list_and_ended_task_pages_run_every_sample() {
    use atcoder_ruby_ide::{RunRequest, Runner};
    use std::time::Duration;
    let root = tempfile::tempdir().unwrap();
    let client = http_client().unwrap();
    let contests = Contests::new(root.path());
    let registered = contests
        .register("https://atcoder.jp/contests/abc086", |url| {
            fetch_page(&client, url, "")
        })
        .unwrap();
    assert_eq!(registered.contest.tasks[0].label, "A");
    let workspaces = Workspaces::new(root.path());
    for (url, code) in [
        (
            "https://atcoder.jp/contests/abc086/tasks/abc086_a",
            "a, b = gets.split.map(&:to_i); puts((a*b).even? ? 'Even' : 'Odd')",
        ),
        (
            "https://atcoder.jp/contests/abc001/tasks/abc001_1",
            "puts gets.to_i - gets.to_i",
        ),
    ] {
        // The app reads task pages from the browser; this explicit check fetches the same HTML.
        let task = parse_task(
            url,
            &fetch_page(&client, &format!("{url}?lang=ja"), "").unwrap(),
        )
        .unwrap();
        workspaces.store_task(&task).unwrap();
        let mut documents = DocumentStore::default();
        let opened = workspaces
            .open(url, "A", documents.revision(), &mut documents)
            .unwrap();
        assert!(!opened.cases.is_empty());
        for case in opened.cases {
            let result = Runner::new(Duration::from_secs(10), 1048576)
                .prepare(RunRequest {
                    code: code.into(),
                    stdin: case.stdin,
                    expected_output: Some(case.expected_output),
                    ..Default::default()
                })
                .unwrap()
                .execute(Path::new(&ruby()), |_| {})
                .unwrap();
            assert_eq!(result.comparison, Some(true), "{url}: {}", result.stderr);
        }
    }
}
