use atcoder_ruby_ide::{parse_problem, DocumentStore, ProblemLibrary, SampleCase};
use std::path::Path;
const URL: &str = "https://atcoder.jp/contests/abs/tasks/practice_1";
fn statement_text(problem: &atcoder_ruby_ide::Problem) -> String {
    problem
        .statement
        .iter()
        .map(|part| match part {
            atcoder_ruby_ide::StatementPart::Text { text }
            | atcoder_ruby_ide::StatementPart::Math { text, .. }
            | atcoder_ruby_ide::StatementPart::Code { text } => text.as_str(),
            atcoder_ruby_ide::StatementPart::Image { alt, .. } => alt.as_str(),
        })
        .collect()
}
const HTML: &str = include_str!("fixtures/atcoder-task.html");

fn seed(root: &Path) {
    let path = root.join("library/problems/abs/practice_1");
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(
        path.join("problem.json"),
        serde_json::to_vec(&parse_problem(URL, HTML).unwrap()).unwrap(),
    )
    .unwrap();
}

#[test]
fn parse_japanese_pairs_by_number_and_only_displays_text() {
    let problem = parse_problem(&format!("{URL}?lang=en#sample"), HTML).unwrap();
    assert_eq!(problem.url, URL);
    assert_eq!(problem.title, "A - 和を求める & 比較");
    assert!(statement_text(&problem).contains("1 \\leq A,B \\leq 100"));
    assert!(statement_text(&problem).contains("図の説明"));
    assert!(!statement_text(&problem).contains("DO_NOT_DISPLAY"));
    assert_eq!(problem.samples.len(), 2);
    assert_eq!(problem.samples[0].stdin, "1 2\n");
    assert_eq!(problem.samples[1].expected_output, "30\n");
    assert!(problem.samples.iter().all(|case| case.compare));
}

#[test]
fn parse_english_empty_output_entities_and_legacy_pages() {
    let html = r#"<span class="h2">B - Test</span><div id="task-statement"><section><h3>Sample Input 1</h3><pre>&lt;tag&gt; &amp; x
</pre></section><section><h3>Sample Output 1</h3><pre></pre></section></div>"#;
    let p = parse_problem(URL, html).unwrap();
    assert_eq!(p.samples[0].stdin, "<tag> & x\n");
    assert_eq!(p.samples[0].expected_output, "");
}

#[test]
fn real_product_page_excludes_editorial_link_and_prefers_japanese() {
    let problem = parse_problem(
        "https://atcoder.jp/contests/abc086/tasks/abc086_a",
        include_str!("fixtures/atcoder-product.html"),
    )
    .unwrap();
    assert_eq!(problem.title, "A - Product");
    assert!(statement_text(&problem).contains("シカのAtCoDeerくん"));
    assert!(!statement_text(&problem).contains("Problem Statement"));
    assert_eq!(problem.samples.len(), 2);
    assert_eq!(problem.samples[0].stdin, "3 4\n");
    assert_eq!(problem.samples[0].expected_output, "Even\n");
    assert_eq!(problem.samples[1].stdin, "1 21\n");
    assert_eq!(problem.samples[1].expected_output, "Odd\n");
}

#[test]
fn tasks_without_samples_open_with_one_uncompared_empty_case() {
    let html = r#"<span class="h2">A50 - 山型足し算</span><div id="task-statement"><section><h3>問題文</h3><p>高さを調整してください。</p></section><section><h3>入出力例1</h3><p><a href="https://img.atcoder.jp/example.zip">入出力ファイルはこちらから(zip)</a></p></section></div>"#;
    let problem = parse_problem(URL, html).unwrap();
    assert!(problem.samples.is_empty());
    let root = tempfile::tempdir().unwrap();
    let library = ProblemLibrary::new(root.path());
    let mut documents = DocumentStore::default();
    let opened = library
        .open_workspace(problem, documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(
        opened.cases,
        vec![SampleCase {
            stdin: String::new(),
            expected_output: String::new(),
            compare: false
        }]
    );
    let missing_output = html.replace(
        "</div>",
        "<section><h3>入力例 1</h3><pre>input</pre></section></div>",
    );
    assert!(parse_problem(URL, &missing_output).is_err());
}

#[test]
fn real_legacy_snow_page_pairs_headings_outside_sections() {
    let problem = parse_problem(
        "https://atcoder.jp/contests/abc001/tasks/abc001_1",
        include_str!("fixtures/atcoder-snow.html"),
    )
    .unwrap();
    assert_eq!(problem.title, "A - 積雪深差");
    assert!(statement_text(&problem).contains("積雪深"));
    assert_eq!(problem.samples.len(), 3);
    for (case, (stdin, expected)) in
        problem
            .samples
            .iter()
            .zip([("15\n10\n", "5\n"), ("0\n0\n", "0\n"), ("5\n20\n", "-15\n")])
    {
        assert_eq!(case.stdin, stdin);
        assert_eq!(case.expected_output, expected);
        assert!(case.compare);
    }
}

#[test]
fn missing_sample_body_cannot_use_the_next_headings_pre() {
    let html = r#"<span class="h2">A - Test</span><div id="task-statement">
<h3>入力例 1</h3><h3>説明</h3><pre>not an input</pre>
<h3>出力例 1</h3><pre>answer</pre></div>"#;
    assert!(parse_problem(URL, html)
        .unwrap_err()
        .contains("サンプル本文"));
}

#[test]
fn reject_foreign_urls_credentials_paths_and_invalid_samples() {
    for url in [
        "http://atcoder.jp/contests/abs/tasks/practice_1",
        "https://evil.test/contests/abs/tasks/practice_1",
        "https://atcoder.jp.evil.test/contests/abs/tasks/practice_1",
        "https://user@atcoder.jp/contests/abs/tasks/practice_1",
        "https://atcoder.jp:444/contests/abs/tasks/practice_1",
        "https://atcoder.jp/contests/abs/tasks/a%2fb",
        "https://atcoder.jp/contests/abs/tasks/a/extra",
    ] {
        assert!(parse_problem(url, HTML).is_err(), "{url}");
    }
    for html in [
        "login page".into(),
        HTML.replace("出力例 1", "出力例 3"),
        HTML.replace("入力例 2", "入力例 1"),
        HTML.replace("1 2", &"x".repeat(1048577)),
    ] {
        assert!(parse_problem(URL, &html).is_err());
    }
}

#[test]
fn cached_problem_opens_offline_and_restores_saved_workspace_without_overwriting_it() {
    let root = tempfile::tempdir().unwrap();
    seed(root.path());
    let library = ProblemLibrary::new(root.path());
    let problem = library.problem(URL, false).unwrap();
    let mut documents = DocumentStore::default();
    let first = library
        .open_workspace(problem, documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(first.document.code.as_deref(), Some(""));
    assert_eq!(first.cases.len(), 2);
    let code_path = documents.path().unwrap().to_owned();
    assert!(code_path.starts_with(root.path().join("workspaces/abs/practice_1")));
    documents
        .save("puts 'saved'", Some(code_path.clone()))
        .unwrap();
    library
        .save_cases(
            URL,
            vec![SampleCase {
                stdin: "custom\r\n".into(),
                expected_output: "saved\n".into(),
                compare: false,
            }],
        )
        .unwrap();
    // A refreshed problem must never replace user-owned code/cases.
    seed(root.path());
    let second = library
        .open_workspace(
            library.problem(URL, false).unwrap(),
            documents.revision(),
            &mut documents,
        )
        .unwrap();
    assert_eq!(second.document.code.as_deref(), Some("puts 'saved'"));
    assert_eq!(second.cases.len(), 1);
    assert_eq!(second.cases[0].stdin, "custom\r\n");
    assert!(!second.cases[0].compare);
}

#[test]
fn corrupted_cache_and_workspace_fail_without_changing_the_active_document() {
    let root = tempfile::tempdir().unwrap();
    seed(root.path());
    let library = ProblemLibrary::new(root.path());
    let current = root.path().join("current.rb");
    let mut documents = DocumentStore::default();
    documents.save("keep", Some(current.clone())).unwrap();
    let workspace = root.path().join("workspaces/abs/practice_1");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cases.json"), r#"{"cases":[]}"#).unwrap();
    assert!(library
        .open_workspace(
            library.problem(URL, false).unwrap(),
            documents.revision(),
            &mut documents
        )
        .is_err());
    assert_eq!(documents.path(), Some(current.as_path()));
    std::fs::remove_file(workspace.join("cases.json")).unwrap();
    std::fs::write(workspace.join("solution.rb"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
    assert!(library
        .open_workspace(
            library.problem(URL, false).unwrap(),
            documents.revision(),
            &mut documents
        )
        .is_err());
    assert_eq!(documents.path(), Some(current.as_path()));
    let cache = root
        .path()
        .join("library/problems/abs/practice_1/problem.json");
    let mut problem = parse_problem(URL, HTML).unwrap();
    problem.url = "https://atcoder.jp/contests/abc001/tasks/abc001_1".into();
    std::fs::write(&cache, serde_json::to_vec(&problem).unwrap()).unwrap();
    assert!(library.problem(URL, false).is_err());
    std::fs::write(&cache, vec![b' '; 32 * 1024 * 1024 + 1]).unwrap();
    assert!(library.problem(URL, false).is_err());
    assert_eq!(std::fs::read_to_string(current).unwrap(), "keep");
}

#[test]
fn late_problem_download_cannot_replace_a_newer_document() {
    for action in ["reset", "open", "save"] {
        let root = tempfile::tempdir().unwrap();
        let library = ProblemLibrary::new(root.path());
        let mut documents = DocumentStore::default();
        let current = root.path().join("current.rb");
        std::fs::write(&current, "keep current").unwrap();
        // A problem download begins, then the user reloads or changes documents.
        let document_revision = documents.revision();
        match action {
            "reset" => documents.reset(),
            "open" => {
                documents.open(Some(current.clone())).unwrap();
            }
            "save" => {
                documents
                    .save("keep current", Some(current.clone()))
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let current_path = documents.path().map(Path::to_owned);
        let downloaded = parse_problem(URL, HTML).unwrap();
        assert!(
            library
                .open_workspace(downloaded, document_revision, &mut documents)
                .is_err(),
            "{action}"
        );
        assert_eq!(documents.path(), current_path.as_deref());
        assert!(!root.path().join("workspaces").exists());
        assert_eq!(std::fs::read_to_string(&current).unwrap(), "keep current");
        if let Some(path) = current_path {
            documents.save("new edit", Some(path)).unwrap();
            assert_eq!(std::fs::read_to_string(&current).unwrap(), "new edit");
        }
    }
}

#[test]
#[ignore = "AtCoderの公開ページへ接続する。npm run test:atcoder-live で明示実行"]
fn live_atcoder_download_run_refresh_and_restore() {
    use atcoder_ruby_ide::{RunRequest, Runner};
    use std::time::Duration;

    let root = tempfile::tempdir().unwrap();
    let library = ProblemLibrary::new(root.path());
    let ruby = std::env::var_os("RUBY_PATH").unwrap_or_else(|| "ruby".into());
    for (contest, task, title, count, code) in [
        (
            "abs",
            "practice_1",
            "PracticeA - Welcome to AtCoder",
            2,
            "a = gets.to_i; b, c = gets.split.map(&:to_i); s = gets.chomp; puts \"#{a+b+c} #{s}\"",
        ),
        (
            "abc086",
            "abc086_a",
            "A - Product",
            2,
            "a, b = gets.split.map(&:to_i); puts((a*b).even? ? 'Even' : 'Odd')",
        ),
        (
            "abc001",
            "abc001_1",
            "A - 積雪深差",
            3,
            "puts gets.to_i - gets.to_i",
        ),
    ] {
        let url = format!("https://atcoder.jp/contests/{contest}/tasks/{task}");
        let problem = library
            .problem(&url, false)
            .unwrap_or_else(|e| panic!("{url}: {e}"));
        assert_eq!(problem.title, title);
        assert_eq!(problem.samples.len(), count);
        let mut documents = DocumentStore::default();
        let workspace = library
            .open_workspace(problem, documents.revision(), &mut documents)
            .unwrap();
        for case in &workspace.cases {
            let result = Runner::new(Duration::from_secs(5), 1048576)
                .prepare(RunRequest {
                    code: code.into(),
                    stdin: case.stdin.clone(),
                    expected_output: Some(case.expected_output.clone()),
                    ..Default::default()
                })
                .unwrap()
                .execute(Path::new(&ruby), |_| {})
                .unwrap();
            assert_eq!(result.status, "completed", "{url}: {}", result.stderr);
            assert_eq!(result.comparison, Some(true), "{url}: {}", result.stdout);
        }
        documents
            .save(code, documents.path().map(Path::to_owned))
            .unwrap();
        let edited = vec![SampleCase {
            stdin: "custom input\n".into(),
            expected_output: "custom output\n".into(),
            compare: false,
        }];
        library.save_cases(&url, edited.clone()).unwrap();
        let refreshed = library.problem(&url, true).unwrap();
        assert_eq!(refreshed.title, title);
        assert_eq!(refreshed.samples, workspace.problem.samples);
        let cached = library.problem(&url, false).unwrap();
        let reopened = library
            .open_workspace(cached, documents.revision(), &mut documents)
            .unwrap();
        assert_eq!(reopened.document.code.as_deref(), Some(code));
        assert_eq!(reopened.cases, edited);
        println!(
            "{task}: fetched, {count} Ruby samples passed, refreshed, saved workspace restored"
        );
    }
}

#[test]
#[ignore = "AtCoderへ接続する。全問は ATCODER_COLLECTION_LIVE_ALL=1 で明示指定"]
fn live_atcoder_collection_import_and_fixed_workspace() {
    use atcoder_ruby_ide::CollectionLibrary;
    let root = tempfile::tempdir().unwrap();
    let library = CollectionLibrary::new(root.path());
    let url = "https://atcoder.jp/contests/tessoku-book";
    let registered = library.register(url).unwrap();
    assert!(registered.created);
    assert_eq!(registered.view.collection.tasks.len(), 151);
    let count = if std::env::var("ATCODER_COLLECTION_LIVE_ALL").as_deref() == Ok("1") {
        151
    } else {
        2
    };
    for (index, task) in registered
        .view
        .collection
        .tasks
        .iter()
        .take(count)
        .enumerate()
    {
        let view = library.fetch_task(url, &task.url).unwrap();
        assert!(
            view.downloaded.contains(&task.url),
            "{}: {:?}",
            task.label,
            view.collection.tasks[index].error
        );
        if index % 10 == 0 || index + 1 == count {
            println!("tessoku-book: {} / {count}", index + 1);
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    assert_eq!(library.view(url).unwrap().downloaded.len(), count);
    assert!(!library.register(url).unwrap().created);
    let task = &registered.view.collection.tasks[0].url;
    let mut documents = DocumentStore::default();
    let opened = library
        .open_task(url, task, documents.revision(), &mut documents)
        .unwrap();
    assert!(!opened.problem.samples.is_empty());
    documents
        .save("puts 'saved'", documents.path().map(Path::to_owned))
        .unwrap();
    let reopened = library
        .open_task(url, task, documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(reopened.document.code.as_deref(), Some("puts 'saved'"));
    assert_eq!(reopened.problem.statement, opened.problem.statement);
    let snapshot = root
        .path()
        .join("library/collections/tessoku-book")
        .join(format!("{}.json", task.rsplit('/').next().unwrap()));
    std::fs::write(snapshot, "corrupt original").unwrap();
    let revision = documents.revision();
    let repaired = library.repair_task(url, task).unwrap();
    assert_eq!(repaired.problem.url, *task);
    assert_eq!(repaired.view.downloaded.len(), count);
    assert_eq!(documents.revision(), revision);
    let reopened = library
        .open_task(url, task, documents.revision(), &mut documents)
        .unwrap();
    assert_eq!(reopened.document.code.as_deref(), Some("puts 'saved'"));
}

#[test]
fn rich_statement_preserves_math_code_and_image_order_without_html() {
    let html = r#"<span class="h2">Rich</span><div id="task-statement"><p>前<var>\frac{a_1}{2}</var>後</p><p>\[\sum_{i=1}^N i\]</p><pre>$literal$ &lt;script&gt;</pre><img src="//img.atcoder.jp/test/diagram.png" alt="図"><script>HIDDEN</script></div>"#;
    let problem = parse_problem(URL, html).unwrap();
    let statement = serde_json::to_value(&problem).unwrap()["statement"].clone();
    assert!(
        statement.is_array(),
        "statement must be structured: {statement}"
    );
    let parts = statement.as_array().unwrap();
    assert!(parts
        .iter()
        .any(|p| p["type"] == "math" && p["text"] == "\\frac{a_1}{2}"));
    assert!(parts
        .iter()
        .any(|p| p["type"] == "math" && p["display"] == true));
    assert!(parts
        .iter()
        .any(|p| p["type"] == "code" && p["text"] == "$literal$ <script>"));
    let image = parts.iter().find(|p| p["type"] == "image").unwrap();
    assert_eq!(image["url"], "https://img.atcoder.jp/test/diagram.png");
    assert!(!statement.to_string().contains("HIDDEN"));
}

#[test]
#[ignore = "AtCoderとimg.atcoder.jpへ接続する。明示実行する画像連携テスト"]
fn live_atcoder_media_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let library = ProblemLibrary::new(root.path());
    let url = "https://atcoder.jp/contests/abc243/tasks/abc243_c";
    let problem = library.problem(url, false).unwrap();
    let images: Vec<_> = problem
        .statement
        .iter()
        .filter_map(|p| match p {
            atcoder_ruby_ide::StatementPart::Image {
                data,
                width,
                height,
                ..
            } => Some((data, width, height)),
            _ => None,
        })
        .collect();
    assert!(!images.is_empty());
    for (data, width, height) in images {
        assert!(data.starts_with("data:image/png;base64,"));
        assert!(*width > 0 && *height > 0);
    }
    assert!(problem
        .statement
        .iter()
        .any(|p| matches!(p, atcoder_ruby_ide::StatementPart::Math { .. })));
    assert_eq!(
        library.problem(url, false).unwrap().statement,
        problem.statement
    );
    assert_eq!(
        library.problem(url, true).unwrap().statement,
        problem.statement
    );
}
