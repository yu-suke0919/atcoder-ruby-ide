use atcoder_ruby_ide::{
    browser_target, contest_top, fetch_page, http_client, input_code, parse_task, parse_task_list,
    reading_forms, submissions_page, Contest, ContestKey, Contests, DocumentStore, SampleCase,
    Samples, Submissions, Task, TaskResult, Workspaces,
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

/// Real task pages as the browser shows them (KaTeX rendered), with the input and constraints
/// sections only: the input format read, the code made from it and an input it must read.
const INPUT_FORMATS: &[(&str, &str, &str, &str)] = &[
    (
        "abc430_a",
        "$A$ $B$ $C$ $D$",
        "a, b, c, d = gets.split.map(&:to_i)\n",
        "10 20 30 40\n",
    ),
    ("tessoku_book_a", "$N$", "n = gets.to_i\n", "2\n"),
    ("arc065_a", "$S$", "s = gets.chomp\n", "erasedream\n"),
    (
        "abc081_b",
        "$N$\n$A_1$ $A_2$ ... $A_N$",
        "n = gets.to_i\na = gets.split.map(&:to_i)\n",
        "3\n8 12 40\n",
    ),
    (
        "abc085_b",
        "$N$\n$d_1$\n$:$\n$d_N$",
        "n = gets.to_i\nn.times do\n  d = gets.to_i\nend\n",
        "2\n10\n8\n",
    ),
    (
        "arc089_a",
        "$N$\n$t_1$ $x_1$ $y_1$\n$t_2$ $x_2$ $y_2$\n$:$\n$t_N$ $x_N$ $y_N$",
        "n = gets.to_i\nn.times do\n  t, x, y = gets.split.map(&:to_i)\nend\n",
        "2\n3 1 2\n6 1 1\n",
    ),
    (
        "abc376_b",
        "$N$ $Q$\n$H_1$ $T_1$\n$H_2$ $T_2$\n$\\vdots$\n$H_Q$ $T_Q$",
        "n, q = gets.split.map(&:to_i)\nq.times do\n  h, t = gets.split\n  t = t.to_i\nend\n",
        "6 2\nR 4\nL 5\n",
    ),
    (
        "abc075_b",
        "$H$ $W$\n$S_1$\n$:$\n$S_H$",
        "h, w = gets.split.map(&:to_i)\nh.times do\n  s = gets.chomp\nend\n",
        "2 3\n#.#\n..#\n",
    ),
    (
        "abc430_b",
        "$N$ $M$\n$S_{1,1}\\ldots S_{1,N}$\n$\\vdots$\n$S_{N,1}\\ldots S_{N,N}$",
        "n, m = gets.split.map(&:to_i)\nn.times do\n  s = gets.chomp\nend\n",
        "2 1\n.#\n#.\n",
    ),
    (
        "abc183_c",
        "$N$ $K$\n$T_{1,1}$ $\\ldots$ $T_{1,N}$\n$\\vdots$\n$T_{N,1}$ $\\ldots$ $T_{N,N}$",
        "n, k = gets.split.map(&:to_i)\nn.times do\n  t = gets.split.map(&:to_i)\nend\n",
        "2 5\n0 3\n3 0\n",
    ),
    (
        "abc088_c",
        "$c_{1,1}$ $c_{1,2}$ $c_{1,3}$\n$c_{2,1}$ $c_{2,2}$ $c_{2,3}$\n$c_{3,1}$ $c_{3,2}$ $c_{3,3}$",
        "3.times do\n  c = gets.split.map(&:to_i)\nend\n",
        "1 0 1\n2 1 2\n1 0 1\n",
    ),
    (
        "abc278_d",
        "$N$\n$A_1$ $A_2$ $\\dots$ $A_N$\n$Q$\n$\\operatorname{query}_1$\n$\\operatorname{query}_2$\n$\\vdots$\n$\\operatorname{query}_Q$",
        "n = gets.to_i\na = gets.split.map(&:to_i)\nq = gets.to_i\nq.times do\n  query = gets.split.map(&:to_i)\nend\n",
        "2\n3 1\n2\n1 5\n3 2\n",
    ),
];

#[test]
fn input_formats_are_read_from_the_loaded_page_and_become_reading_code() {
    for (task, format, code, _) in INPUT_FORMATS {
        let html = std::fs::read_to_string(format!("../tests/fixtures/input-formats/{task}.html"))
            .unwrap();
        let read = parse_task(URL, &html).unwrap();
        assert_eq!(read.input_format.as_deref(), Some(*format), "{task}");
        assert!(!read.constraints.is_empty(), "{task}");
        assert_eq!(
            input_code(format, &read.constraints).as_deref(),
            Some(*code),
            "{task}"
        );
    }
    let constraints = |items: &[&str]| {
        items
            .iter()
            .map(|item| item.to_string())
            .collect::<Vec<_>>()
    };
    // Types come from the constraints: strings only where they say so.
    assert_eq!(input_code("$S$", &[]).as_deref(), Some("s = gets.to_i\n"));
    assert_eq!(
        input_code(
            "$N$ $S$",
            &constraints(&["$S$ は英小文字からなる長さ $N$ の文字列"])
        )
        .as_deref(),
        Some("n, s = gets.split\nn = n.to_i\n")
    );
    // Decimals are read as strings, left to the user to convert (review R8, ABC169 C).
    assert_eq!(
        input_code(
            "$A$ $B$",
            &constraints(&[
                "$0 \\leq A \\leq 10^{15}$",
                "$0 \\leq B < 10$",
                "$A$ は整数",
                "$B$ は小数第 $2$ 位まで与えられる"
            ])
        )
        .as_deref(),
        Some("a, b = gets.split\na = a.to_i\n")
    );
    assert_eq!(
        input_code(
            "$N$\n$X_1$\n$\\vdots$\n$X_N$",
            &constraints(&["$X_i$ は実数"])
        )
        .as_deref(),
        Some("n = gets.to_i\nn.times do\n  x = gets.chomp\nend\n")
    );
    assert_eq!(
        input_code("$N$\n$A_1$\n$\\vdots$\n$A_{N-1}$", &[]).as_deref(),
        Some("n = gets.to_i\n(n - 1).times do\n  a = gets.to_i\nend\n")
    );
    // Formats it cannot tell apart give no code at all.
    for format in [
        "$T$\n$\\mathrm{case}_1$\n$\\mathrm{case}_2$\n$\\vdots$\n$\\mathrm{case}_T$",
        "$N$\n$A_1$\n$\\vdots$\n$A_{2N}$",
        "$N$\n$A_1 + B$",
        "",
        // Rows without a variable, which once panicked (review R3).
        "...",
        "$\\ldots$",
        "$N$\n$\\vdots$",
    ] {
        assert_eq!(input_code(format, &[]), None, "{format}");
    }
}

#[test]
fn rows_read_in_a_loop_can_be_switched_to_arrays_and_back() {
    let forms = |format: &str, constraints: &[&str]| {
        let constraints: Vec<String> = constraints.iter().map(|c| c.to_string()).collect();
        reading_forms(format, &constraints)
    };
    // Each block of rows has the loop that the code starts with and the array to switch to.
    assert_eq!(
        forms("$N$\n$t_1$ $x_1$ $y_1$\n$:$\n$t_N$ $x_N$ $y_N$", &[]),
        [[
            "n.times do\n  t, x, y = gets.split.map(&:to_i)\nend".to_string(),
            "txy = Array.new(n) { gets.split.map(&:to_i) }".to_string()
        ]]
    );
    assert_eq!(
        forms(
            "$N$ $Q$\n$H_1$ $T_1$\n$\\vdots$\n$H_Q$ $T_Q$",
            &["$H_i$ は L または R"]
        ),
        [[
            "q.times do\n  h, t = gets.split\n  t = t.to_i\nend".to_string(),
            "ht = Array.new(q) { h, t = gets.split; [h, t.to_i] }".to_string()
        ]]
    );
    assert_eq!(
        forms(
            "$Q$\n$\\mathrm{query}_1$\n$\\vdots$\n$\\mathrm{query}_Q$",
            &["入力はすべて整数"]
        )[0][1],
        "queries = Array.new(q) { gets.split.map(&:to_i) }"
    );
    // Lines read at once have nothing to switch.
    assert!(forms("$N$\n$A_1$ $\\ldots$ $A_N$", &[]).is_empty());
    assert!(forms("$N$\n$A_1 + B$", &[]).is_empty());
    // Both forms read the same input.
    for (task, format, _, input) in INPUT_FORMATS {
        let html = std::fs::read_to_string(format!("../tests/fixtures/input-formats/{task}.html"))
            .unwrap();
        let read = parse_task(URL, &html).unwrap();
        let mut code = input_code(format, &read.constraints).unwrap();
        for [loop_form, array] in reading_forms(format, &read.constraints) {
            code = code.replace(&loop_form, &array);
        }
        run_reading(task, &code, input);
    }
}

fn run_reading(task: &str, code: &str, input: &str) {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new(ruby())
        .arg("-e")
        .arg(format!(
            "{code}raise 'unread input' unless STDIN.read.strip.empty?"
        ))
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{task}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn generated_code_reads_the_whole_input_with_ruby() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    for (task, _, code, input) in INPUT_FORMATS {
        let mut child = Command::new(ruby())
            .arg("-e")
            .arg(format!(
                "{code}raise 'unread input' unless STDIN.read.strip.empty?"
            ))
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{task}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn new_files_start_with_reading_code_but_converted_and_copied_files_do_not() {
    let root = tempfile::tempdir().unwrap();
    let workspaces = Workspaces::new(root.path());
    let html = std::fs::read_to_string("../tests/fixtures/input-formats/abc081_b.html").unwrap();
    workspaces
        .store_task(&parse_task(URL, &html).unwrap())
        .unwrap();
    let directory = root
        .path()
        .join("workspaces")
        .join("abs")
        .join("practice_1");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("solution.rb"), "puts 'mine'").unwrap();
    let mut documents = DocumentStore::default();
    let opened = workspaces
        .open(URL, "B", documents.revision(), &mut documents)
        .unwrap();
    let code = "n = gets.to_i\na = gets.split.map(&:to_i)\n";
    let read = |name: &str| {
        std::fs::read_to_string(directory.join("files").join(format!("{name}.rb"))).unwrap()
    };
    assert_eq!(opened.document.code, "puts 'mine'");
    assert_eq!(read("B_2"), code);
    assert_eq!(workspaces.create_file(URL, "B").unwrap(), "B_3");
    assert_eq!(read("B_3"), code);
    assert_eq!(workspaces.copy_file(URL, "B_1", "B").unwrap(), "B_4");
    assert_eq!(read("B_4"), "puts 'mine'");
    let home = workspaces
        .open_home(documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(home.document.code, "");
    assert_eq!(workspaces.create_file("home", "home").unwrap(), "home_3");
    assert_eq!(
        std::fs::read_to_string(root.path().join("home").join("files").join("home_3.rb")).unwrap(),
        ""
    );
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
    assert!(opened.samples.cases.iter().all(|case| case.compare));
    assert_eq!(opened.samples.tolerance, None);
    documents.save(documents.revision(), "puts 'mine'").unwrap();
    let mut edited = opened.samples.clone();
    edited.cases[0].stdin = "edited\n".into();
    edited.tolerance = Some(1e-6);
    workspaces.save_samples(URL, edited.clone()).unwrap();

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
    assert_eq!(reopened.samples, edited);
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
    assert_eq!(home.samples.cases.len(), 1);
    assert!(!home.samples.cases[0].compare && home.samples.cases[0].stdin.is_empty());
    documents.save(documents.revision(), "puts gets").unwrap();
    let samples = Samples {
        tolerance: None,
        cases: vec![SampleCase {
            stdin: "1\n".into(),
            expected_output: "1\n".into(),
            compare: true,
        }],
    };
    workspaces.save_samples("home", samples.clone()).unwrap();
    let reopened = workspaces
        .open_home(documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(reopened.document.code, "puts gets");
    assert_eq!(reopened.samples, samples);
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
    std::fs::write(directory.join("samples.json"), r#"{"cases":[]}"#).unwrap();
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
        opened.samples.cases,
        vec![SampleCase {
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
    assert_eq!(opened.samples.cases[0].stdin, "保存済み\r\n");
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
fn per_sample_tolerances_become_the_problem_tolerance_once_and_cases_json_stays() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("workspaces/abs/practice_1");
    std::fs::create_dir_all(&directory).unwrap();
    let old = r#"{"cases":[{"stdin":"1\r\n","expectedOutput":"1\n","compare":false},{"stdin":"2","expectedOutput":"2.000001","compare":true,"tolerance":1e-6},{"stdin":"3","expectedOutput":"","compare":true,"tolerance":1e-9}]}"#;
    std::fs::write(directory.join("cases.json"), old).unwrap();
    let workspaces = Workspaces::new(root.path());
    workspaces
        .store_task(&parse_task(URL, HTML).unwrap())
        .unwrap();
    let mut documents = DocumentStore::default();
    let opened = workspaces
        .open(URL, "A", documents.revision(), &mut documents)
        .unwrap();
    // The first tolerance found becomes the problem's; inputs, outputs and compare stay.
    assert_eq!(opened.samples.tolerance, Some(1e-6));
    let texts: Vec<_> = opened
        .samples
        .cases
        .iter()
        .map(|case| {
            (
                case.stdin.as_str(),
                case.expected_output.as_str(),
                case.compare,
            )
        })
        .collect();
    assert_eq!(
        texts,
        [
            ("1\r\n", "1\n", false),
            ("2", "2.000001", true),
            ("3", "", true)
        ]
    );
    assert_eq!(
        std::fs::read_to_string(directory.join("cases.json")).unwrap(),
        old
    );
    std::fs::write(directory.join("cases.json"), r#"{"cases":[]}"#).unwrap();
    let reopened = workspaces
        .open(URL, "A", documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(reopened.samples, opened.samples);
}

#[test]
fn unreadable_old_samples_are_left_as_they_were_and_named_on_open() {
    let root = tempfile::tempdir().unwrap();
    // Joined part by part so the message's path matches on Windows too.
    let directory = root
        .path()
        .join("workspaces")
        .join("abs")
        .join("practice_1");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("cases.json"), "not json").unwrap();
    let workspaces = Workspaces::new(root.path());
    workspaces
        .store_task(&parse_task(URL, HTML).unwrap())
        .unwrap();
    let mut documents = DocumentStore::default();
    let error = workspaces
        .open(URL, "A", documents.revision(), &mut documents)
        .unwrap_err();
    assert!(
        error.contains(&directory.join("cases.json").display().to_string()),
        "{error}"
    );
    assert!(!directory.join("samples.json").exists());
    assert_eq!(
        std::fs::read_to_string(directory.join("cases.json")).unwrap(),
        "not json"
    );
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
    assert_eq!(names, ["samples.json", "solution.rb", "task.json"]);
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
        // Four bytes, like COM1, but the third byte is inside a character.
        "a名",
        "😀",
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
    documents
        .save(documents.revision(), "puts 'renamed'")
        .unwrap();
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
        assert!(!opened.samples.cases.is_empty());
        for case in opened.samples.cases {
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
    // The reading code made from the raw page reads every sample input to the end.
    for (contest, task) in [
        ("abc430", "abc430_a"),
        ("abc081", "abc081_b"),
        ("abc085", "abc085_b"),
        ("abc086", "arc089_a"),
        ("abc376", "abc376_b"),
        ("abc075", "abc075_b"),
        ("abc430", "abc430_b"),
        ("abc183", "abc183_c"),
        ("abc088", "abc088_c"),
        ("abc278", "abc278_d"),
        ("abc049", "arc065_a"),
    ] {
        let url = format!("https://atcoder.jp/contests/{contest}/tasks/{task}");
        let read = parse_task(
            &url,
            &fetch_page(&client, &format!("{url}?lang=ja"), "").unwrap(),
        )
        .unwrap();
        let code = input_code(read.input_format.as_deref().unwrap(), &read.constraints)
            .unwrap_or_else(|| panic!("{task}: no code"));
        for sample in &read.samples {
            let result = Runner::new(Duration::from_secs(10), 1048576)
                .prepare(RunRequest {
                    code: format!("{code}raise 'unread input' unless STDIN.read.strip.empty?"),
                    stdin: sample.stdin.clone(),
                    ..Default::default()
                })
                .unwrap()
                .execute(Path::new(&ruby()), |_| {})
                .unwrap();
            assert_eq!(result.status, "completed", "{task}: {}", result.stderr);
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

// Pages of the user's submissions, saved while logged in (docs/problem-library.md#提出一覧の読み取りu5a).
const WAITING: &str = include_str!("fixtures/submissions/waiting.html");
const PROGRESS: &str = include_str!("fixtures/submissions/progress.html");
const PROGRESS_TLE: &str = include_str!("fixtures/submissions/progress-tle.html");
const SUBMISSIONS: &str = "https://atcoder.jp/contests/tessoku-book/submissions/me";
const TESSOKU_CONTEST: &str = "https://atcoder.jp/contests/tessoku-book";
fn tessoku_task(id: &str) -> String {
    format!("{TESSOKU_CONTEST}/tasks/{id}")
}
/// One row of a saved page, by its submission ID.
fn submission_row(page: &str, id: u64) -> String {
    let link = format!("submissions/{id}\" class=\"submission-details-link");
    let at = page.find(&link).unwrap();
    let start = page[..at].rfind("<tr>").unwrap();
    let end = at + page[at..].find("</tr>").unwrap() + "</tr>".len();
    page[start..end].to_string()
}
fn submissions_list(rows: &[String]) -> String {
    format!(
        "<html><body><table><tbody>{}</tbody></table></body></html>",
        rows.concat()
    )
}

#[test]
fn u5a_submissions_are_read_from_the_shown_list_with_judging_ones_marked() {
    let root = tempfile::tempdir().unwrap();
    let submissions = Submissions::new(root.path());
    let waiting = submissions.read_page(SUBMISSIONS, WAITING).unwrap();
    assert_eq!(waiting.contest, TESSOKU_CONTEST);
    assert!(waiting.judging);
    // A21 is waiting for judge but has an AC already; every task here has one.
    assert_eq!(waiting.states.len(), 10);
    assert!(waiting
        .states
        .values()
        .all(|state| *state == TaskResult::Ac));
    let stored =
        std::fs::read_to_string(root.path().join("submissions/tessoku-book.json")).unwrap();
    let stored: serde_json::Value = serde_json::from_str(&stored).unwrap();
    let list = stored["submissions"].as_array().unwrap();
    assert_eq!(list.len(), 20);
    assert!(list
        .windows(2)
        .all(|pair| pair[0]["id"].as_u64() < pair[1]["id"].as_u64()));
    let wj = list.iter().find(|s| s["id"] == 80643032).unwrap();
    assert_eq!(wj["task"], tessoku_task("tessoku_book_u"));
    assert_eq!(wj["result"], "WJ");
    assert_eq!(wj["judging"], true);
    assert_eq!(list.iter().filter(|s| s["result"] == "WA").count(), 5);
    assert!(list
        .iter()
        .filter(|s| s["id"] != 80643032)
        .all(|s| s["judging"] == false));
    // Progress and a TLE found during the judge are still judging; the WJ one is now AC.
    for page in [PROGRESS, PROGRESS_TLE] {
        assert!(submissions.read_page(SUBMISSIONS, page).unwrap().judging);
    }
    let stored =
        std::fs::read_to_string(root.path().join("submissions/tessoku-book.json")).unwrap();
    let stored: serde_json::Value = serde_json::from_str(&stored).unwrap();
    let list = stored["submissions"].as_array().unwrap();
    assert_eq!(list.len(), 22);
    let tle = list.iter().find(|s| s["id"] == 80643050).unwrap();
    assert_eq!(
        (tle["result"].as_str(), tle["judging"].as_bool()),
        (Some("23/41 TLE"), Some(true))
    );
    assert_eq!(
        list.iter().find(|s| s["id"] == 80643032).unwrap()["result"],
        "AC"
    );
}

#[test]
fn u5a_a_task_is_ac_with_any_ac_else_judging_with_any_judging_else_other() {
    let root = tempfile::tempdir().unwrap();
    let submissions = Submissions::new(root.path());
    let judging = submission_row(PROGRESS_TLE, 80643050);
    let wrong = submission_row(PROGRESS_TLE, 80022162);
    let four_boxes = tessoku_task("tessoku_book_n");
    let update = submissions
        .read_page(
            SUBMISSIONS,
            &submissions_list(&[judging.clone(), wrong.clone()]),
        )
        .unwrap();
    assert!(update.judging);
    assert_eq!(update.states[&four_boxes], TaskResult::Judging);
    // The judge ends with TLE: the same submission is replaced, not added.
    let finished = judging
        .replace(
            "colspan=\"3\" class=\"text-center waiting-judge\" data-id=\"80643050\"",
            "class=\"text-center\"",
        )
        .replace("23/41 TLE", "TLE");
    let update = submissions
        .read_page(SUBMISSIONS, &submissions_list(&[finished, wrong]))
        .unwrap();
    assert!(!update.judging);
    assert_eq!(update.states[&four_boxes], TaskResult::Other);
    assert_eq!(submissions.states(TESSOKU_CONTEST).unwrap(), update.states);
    // Submissions read before stay: an AC in the full list makes the task AC.
    submissions.read_page(SUBMISSIONS, WAITING).unwrap();
    let states = submissions.states(TESSOKU_CONTEST).unwrap();
    assert_eq!(states[&four_boxes], TaskResult::Ac);
    assert!(!states.contains_key(&tessoku_task("tessoku_book_b")));
    assert!(submissions
        .states("https://atcoder.jp/contests/abc001")
        .unwrap()
        .is_empty());
}

#[test]
fn u5a_only_submission_lists_are_read_and_an_unreadable_record_is_kept() {
    for (url, contest) in [
        (SUBMISSIONS, Some(TESSOKU_CONTEST)),
        (
            "https://atcoder.jp/contests/tessoku-book/submissions/me?page=2",
            Some(TESSOKU_CONTEST),
        ),
        (
            "https://atcoder.jp/contests/abc482/submissions/me/",
            Some("https://atcoder.jp/contests/abc482"),
        ),
        ("https://atcoder.jp/contests/tessoku-book/submissions", None),
        (
            "https://atcoder.jp/contests/tessoku-book/submissions/me/status/json",
            None,
        ),
        (
            "https://atcoder.jp/contests/tessoku-book/tasks/tessoku_book_a",
            None,
        ),
        (
            "https://example.com/contests/tessoku-book/submissions/me",
            None,
        ),
    ] {
        let url = url::Url::parse(url).unwrap();
        assert_eq!(submissions_page(&url).as_deref(), contest, "{url}");
    }
    let root = tempfile::tempdir().unwrap();
    let submissions = Submissions::new(root.path());
    // No submissions yet: nothing to record or color.
    let empty = submissions
        .read_page(
            SUBMISSIONS,
            "<html><body><p>提出がありません</p></body></html>",
        )
        .unwrap();
    assert!(empty.states.is_empty() && !empty.judging);
    // Rows of another contest's tasks are skipped.
    let other = submission_row(WAITING, 80642902)
        .replace("/contests/tessoku-book/tasks/", "/contests/abc001/tasks/");
    assert!(submissions
        .read_page(SUBMISSIONS, &submissions_list(&[other]))
        .unwrap()
        .states
        .is_empty());
    let file = root.path().join("submissions/tessoku-book.json");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "{\"submissions\": [], \"unknown\": 1}").unwrap();
    assert!(submissions.read_page(SUBMISSIONS, WAITING).is_err());
    assert!(submissions.states(TESSOKU_CONTEST).is_err());
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "{\"submissions\": [], \"unknown\": 1}"
    );
}

const ABC483: &str = "https://atcoder.jp/contests/abc483";
const ABC483_BEFORE_REGISTER: &str = include_str!("fixtures/contest-top/before-register.html");
const ABC483_REGISTERED: &str = include_str!("fixtures/contest-top/registered.html");
// 2026-11-07 21:00 and 22:40 JST, as Unix time.
const ABC483_START: i64 = 1_794_052_800;
const ABC483_END: i64 = 1_794_058_800;
const DAY: i64 = 24 * 60 * 60;

fn abc483_task_list() -> String {
    let task = "/contests/abc483/tasks/abc483_a";
    format!("<html><body><a class=\"contest-title\" href=\"/contests/abc483\">AtCoder Beginner Contest 483</a><table><tbody><tr><td><a href=\"{task}\">A</a></td><td><a href=\"{task}\">最初の問題</a></td></tr></tbody></table></body></html>")
}

#[test]
fn u6a_only_contest_tops_are_read() {
    for (url, contest) in [
        (ABC483, Some(ABC483)),
        ("https://atcoder.jp/contests/abc483/?lang=ja", Some(ABC483)),
        ("https://atcoder.jp/contests/abc483/tasks", None),
        ("https://atcoder.jp/contests/abc483/submissions/me", None),
        ("https://atcoder.jp/contests/", None),
        ("https://atcoder.jp/", None),
        ("https://example.com/contests/abc483", None),
    ] {
        let url = url::Url::parse(url).unwrap();
        assert_eq!(contest_top(&url).as_deref(), contest, "{url}");
    }
}

#[test]
fn u6a_a_registered_contest_top_adds_the_contest_with_its_times_and_no_tasks() {
    let before = ABC483_START - 60 * 60;
    let root = tempfile::tempdir().unwrap();
    let contests = Contests::new(root.path());
    // "(Guest)" before registering: nothing is added.
    assert_eq!(
        contests
            .join(ABC483, ABC483_BEFORE_REGISTER, before)
            .unwrap(),
        None
    );
    assert!(contests.list().unwrap().is_empty());
    let joined = contests
        .join(&format!("{ABC483}?lang=ja"), ABC483_REGISTERED, before)
        .unwrap()
        .unwrap();
    assert_eq!(joined.url, ABC483);
    assert_eq!(joined.title, "AtCoder Beginner Contest 483");
    assert!(joined.joined && !joined.hidden && joined.tasks.is_empty());
    assert_eq!(
        joined.start_time.as_deref(),
        Some("2026-11-07T21:00:00+09:00")
    );
    assert_eq!(
        joined.end_time.as_deref(),
        Some("2026-11-07T22:40:00+09:00")
    );
    assert_eq!(contests.list().unwrap(), vec![joined.clone()]);
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.path().join("contests/abc483.json")).unwrap())
            .unwrap();
    assert_eq!(
        saved.as_object().unwrap().keys().collect::<Vec<_>>(),
        [
            "endTime",
            "hidden",
            "joined",
            "startTime",
            "tasks",
            "title",
            "url"
        ]
    );
    // The same page again changes nothing.
    assert_eq!(
        contests.join(ABC483, ABC483_REGISTERED, before).unwrap(),
        None
    );
    // A page without the times is not enough.
    let fresh = tempfile::tempdir().unwrap();
    let untimed = ABC483_REGISTERED.replace("var startTime", "var shownTime");
    assert_eq!(
        Contests::new(fresh.path())
            .join(ABC483, &untimed, before)
            .unwrap(),
        None
    );
    // Up to a day after the end the contest is added; later its page is ignored.
    assert!(Contests::new(fresh.path())
        .join(ABC483, ABC483_REGISTERED, ABC483_END + DAY - 1)
        .unwrap()
        .is_some());
    let late = tempfile::tempdir().unwrap();
    assert_eq!(
        Contests::new(late.path())
            .join(ABC483, ABC483_REGISTERED, ABC483_END + DAY)
            .unwrap(),
        None
    );
    assert!(!late.path().join("contests").exists());
}

#[test]
fn u6a_joining_keeps_the_task_list_and_hidden_state_and_registering_again_keeps_the_times() {
    let before = ABC483_START - 60 * 60;
    let root = tempfile::tempdir().unwrap();
    let contests = Contests::new(root.path());
    let added = contests
        .register(ABC483, |_| Ok(abc483_task_list()))
        .unwrap()
        .contest;
    assert!(!added.joined && added.start_time.is_none() && added.end_time.is_none());
    contests.set_hidden(ABC483, true).unwrap();
    let joined = contests
        .join(ABC483, ABC483_REGISTERED, before)
        .unwrap()
        .unwrap();
    assert_eq!(joined.tasks, added.tasks);
    assert!(joined.hidden && joined.joined);
    let again = contests
        .register(ABC483, |_| Ok(abc483_task_list()))
        .unwrap()
        .contest;
    assert_eq!(again, joined);
    // A delayed contest gets its new times.
    let delayed =
        ABC483_REGISTERED.replace("2026-11-07T22:40:00+09:00", "2026-11-07T22:50:00+09:00");
    let moved = contests.join(ABC483, &delayed, before).unwrap().unwrap();
    assert_eq!(moved.end_time.as_deref(), Some("2026-11-07T22:50:00+09:00"));
    // An unreadable record is kept as it is.
    let file = root.path().join("contests/abc483.json");
    std::fs::write(&file, "{}").unwrap();
    assert!(contests.join(ABC483, ABC483_REGISTERED, before).is_err());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{}");
}

#[test]
fn u6a_joined_contests_are_hidden_once_a_day_after_their_end() {
    let root = tempfile::tempdir().unwrap();
    let contests = Contests::new(root.path());
    contests
        .join(ABC483, ABC483_REGISTERED, ABC483_START - 60)
        .unwrap()
        .unwrap();
    contests
        .register("https://atcoder.jp/contests/tessoku-book", |_| {
            Ok(TESSOKU.to_string())
        })
        .unwrap();
    assert!(contests
        .hide_ended(ABC483_END + DAY - 1)
        .unwrap()
        .is_empty());
    let hidden = contests.hide_ended(ABC483_END + DAY).unwrap();
    assert_eq!(hidden.len(), 1);
    assert_eq!(hidden[0].url, ABC483);
    assert!(hidden[0].hidden && !hidden[0].joined);
    assert_eq!(
        contests
            .list()
            .unwrap()
            .iter()
            .map(|contest| contest.hidden)
            .collect::<Vec<_>>(),
        [true, false]
    );
    // Shown again by the user, it stays shown.
    contests.set_hidden(ABC483, false).unwrap();
    assert!(contests
        .hide_ended(ABC483_END + 2 * DAY)
        .unwrap()
        .is_empty());
}

#[test]
fn u6a_saved_times_must_be_a_pair_in_order() {
    let root = tempfile::tempdir().unwrap();
    let contests = Contests::new(root.path());
    let directory = root.path().join("contests");
    std::fs::create_dir_all(&directory).unwrap();
    let record = |start: &str, end: &str| {
        format!(
            "{{\"url\":\"{ABC483}\",\"title\":\"ABC483\",\"hidden\":false,\"tasks\":[],\"joined\":true{start}{end}}}"
        )
    };
    let start = ",\"startTime\":\"2026-11-07T21:00:00+09:00\"";
    let end = ",\"endTime\":\"2026-11-07T22:40:00+09:00\"";
    std::fs::write(directory.join("abc483.json"), record(start, end)).unwrap();
    assert_eq!(contests.list().unwrap().len(), 1);
    for broken in [
        record(start, ""),
        record(start, ",\"endTime\":\"2026-11-07T20:00:00+09:00\""),
        record(start, ",\"endTime\":\"2026-11-07 22:40\""),
        record(start, ",\"endTime\":\"2026-13-07T22:40:00+09:00\""),
    ] {
        std::fs::write(directory.join("abc483.json"), &broken).unwrap();
        assert!(contests.list().unwrap().is_empty(), "{broken}");
    }
}

#[test]
fn r6_submissions_read_at_the_same_time_are_all_kept() {
    for _ in 0..10 {
        let root = tempfile::tempdir().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = [80642902, 80642903]
            .into_iter()
            .map(|id| {
                let (root, barrier) = (root.path().to_owned(), barrier.clone());
                std::thread::spawn(move || {
                    let page = submissions_list(&[
                        submission_row(WAITING, 80642902).replace("80642902", &id.to_string())
                    ]);
                    barrier.wait();
                    Submissions::new(root)
                        .read_page(SUBMISSIONS, &page)
                        .unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let saved: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.path().join("submissions/tessoku-book.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved["submissions"].as_array().unwrap().len(), 2);
    }
}
