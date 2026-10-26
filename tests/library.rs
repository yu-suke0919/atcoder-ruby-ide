use atcoder_ruby_ide::{parse_problem, DocumentStore, ProblemLibrary, SampleCase};
use std::path::Path;
const URL: &str = "https://atcoder.jp/contests/abs/tasks/practice_1";
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
    assert!(problem.statement.contains("1 \\leq A,B \\leq 100"));
    assert!(problem.statement.contains("図の説明"));
    assert!(!problem.statement.contains("DO_NOT_DISPLAY"));
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
    let first = library.open_workspace(problem, &mut documents).unwrap();
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
        .open_workspace(library.problem(URL, false).unwrap(), &mut documents)
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
        .open_workspace(library.problem(URL, false).unwrap(), &mut documents)
        .is_err());
    assert_eq!(documents.path(), Some(current.as_path()));
    std::fs::remove_file(workspace.join("cases.json")).unwrap();
    std::fs::write(workspace.join("solution.rb"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
    assert!(library
        .open_workspace(library.problem(URL, false).unwrap(), &mut documents)
        .is_err());
    assert_eq!(documents.path(), Some(current.as_path()));
    let cache = root
        .path()
        .join("library/problems/abs/practice_1/problem.json");
    let mut problem = parse_problem(URL, HTML).unwrap();
    problem.url = "https://atcoder.jp/contests/abc001/tasks/abc001_1".into();
    std::fs::write(&cache, serde_json::to_vec(&problem).unwrap()).unwrap();
    assert!(library.problem(URL, false).is_err());
    std::fs::write(&cache, vec![b' '; 8 * 1024 * 1024 + 1]).unwrap();
    assert!(library.problem(URL, false).is_err());
    assert_eq!(std::fs::read_to_string(current).unwrap(), "keep");
}
