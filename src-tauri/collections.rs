use crate::files::{read_limited, write_atomic};
use crate::library::{
    create_if_missing, download, download_problem, http_client, validate, ProblemKey,
    MAX_HTML_BYTES,
};
use crate::presentation::MAX_CACHE_BYTES;
use crate::{DocumentStore, Problem, ProblemLibrary, ProblemWorkspace};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use url::Url;

const MAX_COLLECTION_BYTES: usize = 2 * 1024 * 1024;

struct CollectionKey {
    url: String,
    contest: String,
}
impl CollectionKey {
    fn parse(value: &str) -> Result<Self, String> {
        let parsed = Url::parse(value.trim()).map_err(|_| "問題集URLを入力してください。")?;
        let parts: Vec<_> = parsed.path().trim_end_matches('/').split('/').collect();
        if !(parts.len() == 3 || (parts.len() == 4 && parts[3] == "tasks"))
            || parts[1] != "contests"
        {
            return Err(
                "https://atcoder.jp/contests/<id> 形式の問題集URLを入力してください。".into(),
            );
        }
        // Reuse the same origin, credential and identifier rules as individual tasks.
        let mut probe = parsed.clone();
        probe.set_path(&format!("/contests/{}/tasks/probe", parts[2]));
        let key = ProblemKey::parse(probe.as_str())?;
        Ok(Self {
            url: format!("https://atcoder.jp/contests/{}", key.contest),
            contest: key.contest,
        })
    }
    fn manifest(&self, root: &Path) -> PathBuf {
        root.join("library/collections")
            .join(format!("{}.json", self.contest))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionTask {
    pub label: String,
    pub title: String,
    pub url: String,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Collection {
    pub url: String,
    pub title: String,
    pub tasks: Vec<CollectionTask>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionView {
    pub collection: Collection,
    pub downloaded: Vec<String>,
}
#[derive(Serialize)]
pub struct RegisteredCollection {
    pub view: CollectionView,
    pub created: bool,
}
#[derive(Serialize)]
pub struct RepairedCollectionTask {
    pub view: CollectionView,
    pub problem: Problem,
}
fn text(element: scraper::ElementRef<'_>) -> String {
    element
        .text()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn validate_collection(collection: &Collection, key: &CollectionKey) -> Result<(), String> {
    if collection.url != key.url
        || collection.title.trim().is_empty()
        || collection.title.len() > 1024
        || !(1..=1000).contains(&collection.tasks.len())
    {
        return Err("問題集の名前・URL・問題数が不正です（最大1,000問）。".into());
    }
    let mut urls = BTreeSet::new();
    let mut labels = BTreeSet::new();
    for task in &collection.tasks {
        let task_key = ProblemKey::parse(&task.url)?;
        if task_key.contest != key.contest
            || task_key.url != task.url
            || task.label.trim().is_empty()
            || task.label.len() > 64
            || task.title.trim().is_empty()
            || task.title.len() > 1024
            || task.error.as_ref().is_some_and(|e| e.len() > 2048)
            || !urls.insert(&task.url)
            || !labels.insert(&task.label)
        {
            return Err("問題一覧に不正な問題・別コンテストのURL・重複があります。".into());
        }
    }
    Ok(())
}
pub fn parse_collection(url: &str, html: &str) -> Result<Collection, String> {
    let key = CollectionKey::parse(url)?;
    if html.len() > MAX_HTML_BYTES {
        return Err("問題一覧は4 MiB以下にしてください。".into());
    }
    let document = Html::parse_document(html);
    let select = |value: &str| Selector::parse(value).unwrap();
    let title = document
        .select(&select("a.contest-title"))
        .next()
        .map(text)
        .ok_or("問題集名が見つかりません。公開状態を確認してください。")?;
    let mut tasks = Vec::new();
    for row in document.select(&select("table tbody tr")) {
        let cells: Vec<_> = row.select(&select("td")).collect();
        if cells.len() < 2 {
            return Err("問題一覧の形式が不正です。".into());
        }
        let a = cells[0]
            .select(&select("a[href]"))
            .next()
            .ok_or("問題URLがありません。")?;
        let b = cells[1]
            .select(&select("a[href]"))
            .next()
            .ok_or("問題名がありません。")?;
        let base = Url::parse(&format!("{}/tasks", key.url)).unwrap();
        let first = base
            .join(a.value().attr("href").unwrap())
            .map_err(|e| e.to_string())?;
        let second = base
            .join(b.value().attr("href").unwrap())
            .map_err(|e| e.to_string())?;
        let first = ProblemKey::parse(first.as_str())?;
        let second = ProblemKey::parse(second.as_str())?;
        if first.url != second.url {
            return Err("問題番号と問題名のURLが一致しません。".into());
        }
        tasks.push(CollectionTask {
            label: text(a),
            title: text(b),
            url: first.url,
            error: None,
        });
    }
    let collection = Collection {
        url: key.url.clone(),
        title,
        tasks,
    };
    validate_collection(&collection, &key)?;
    Ok(collection)
}

pub struct CollectionLibrary {
    root: PathBuf,
}
impl CollectionLibrary {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    fn load(&self, key: &CollectionKey) -> Result<Collection, String> {
        let bytes = read_limited(&key.manifest(&self.root), MAX_COLLECTION_BYTES)
            .map_err(|e| format!("保存済み問題集を読み込めません: {e}"))?;
        let collection: Collection =
            serde_json::from_slice(&bytes).map_err(|e| format!("保存済み問題集が不正です: {e}"))?;
        validate_collection(&collection, key)?;
        Ok(collection)
    }
    fn save(
        &self,
        key: &CollectionKey,
        collection: &Collection,
        initial: bool,
    ) -> Result<(), String> {
        validate_collection(collection, key)?;
        let bytes = serde_json::to_vec_pretty(collection).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_COLLECTION_BYTES {
            return Err("問題集JSONが2 MiBを超えています。".into());
        }
        let path = key.manifest(&self.root);
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        if initial {
            create_if_missing(&path, &bytes)
        } else {
            write_atomic(&path, &bytes).map_err(|e| e.to_string())
        }
    }
    fn snapshot_path(&self, key: &CollectionKey, task: &str) -> Result<PathBuf, String> {
        let task = ProblemKey::parse(task)?;
        if task.contest != key.contest {
            return Err("別の問題集の問題は開けません。".into());
        }
        Ok(self
            .root
            .join("library/collections")
            .join(&key.contest)
            .join(format!("{}.json", task.task)))
    }
    fn snapshot(&self, key: &CollectionKey, task: &str) -> Result<Problem, String> {
        let bytes = read_limited(&self.snapshot_path(key, task)?, MAX_CACHE_BYTES)
            .map_err(|e| format!("保存済み問題を開けません: {e}"))?;
        let problem: Problem = serde_json::from_slice(&bytes)
            .map_err(|e| format!("固定保存した問題が不正です: {e}"))?;
        validate(&problem, &ProblemKey::parse(task)?)?;
        Ok(problem)
    }
    pub fn view(&self, url: &str) -> Result<CollectionView, String> {
        let key = CollectionKey::parse(url)?;
        let collection = self.load(&key)?;
        let mut downloaded = Vec::new();
        for task in &collection.tasks {
            if self
                .snapshot_path(&key, &task.url)?
                .try_exists()
                .map_err(|e| e.to_string())?
            {
                downloaded.push(task.url.clone());
            }
        }
        Ok(CollectionView {
            collection,
            downloaded,
        })
    }
    pub fn list(&self) -> Result<Vec<CollectionView>, String> {
        let directory = self.root.join("library/collections");
        if !directory.try_exists().map_err(|e| e.to_string())? {
            return Ok(Vec::new());
        }
        let mut urls = Vec::new();
        for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") && path.is_file() {
                if let Some(id) = path.file_stem().and_then(|name| name.to_str()) {
                    urls.push(format!("https://atcoder.jp/contests/{id}"));
                }
            }
        }
        urls.sort();
        Ok(urls.iter().filter_map(|url| self.view(url).ok()).collect())
    }
    pub fn register(&self, url: &str) -> Result<RegisteredCollection, String> {
        self.register_with(url, |url| download(&http_client()?, url))
    }
    fn register_with(
        &self,
        url: &str,
        fetch: impl FnOnce(&str) -> Result<String, String>,
    ) -> Result<RegisteredCollection, String> {
        let key = CollectionKey::parse(url)?;
        let exists = key
            .manifest(&self.root)
            .try_exists()
            .map_err(|e| e.to_string())?;
        if exists && self.load(&key).is_ok() {
            return Ok(RegisteredCollection {
                view: self.view(&key.url)?,
                created: false,
            });
        }
        let collection =
            parse_collection(&key.url, &fetch(&format!("{}/tasks?lang=ja", key.url))?)?;
        self.save(&key, &collection, !exists)?;
        Ok(RegisteredCollection {
            view: self.view(&key.url)?,
            created: true,
        })
    }
    pub fn fetch_task(&self, url: &str, task: &str) -> Result<CollectionView, String> {
        self.fetch_with(url, task, download_problem)
    }
    fn fetch_with(
        &self,
        url: &str,
        task: &str,
        fetch: impl FnOnce(&str) -> Result<Problem, String>,
    ) -> Result<CollectionView, String> {
        let key = CollectionKey::parse(url)?;
        let mut collection = self.load(&key)?;
        let index = collection
            .tasks
            .iter()
            .position(|t| t.url == task)
            .ok_or("問題集に含まれない問題です。")?;
        let path = self.snapshot_path(&key, task)?;
        if path.try_exists().map_err(|e| e.to_string())? {
            self.snapshot(&key, task)?;
            return self.view(url);
        }
        let result = (|| {
            let problem = fetch(task)?;
            validate(&problem, &ProblemKey::parse(task)?)?;
            let bytes = serde_json::to_vec_pretty(&problem).map_err(|e| e.to_string())?;
            if bytes.len() > MAX_CACHE_BYTES {
                return Err("問題が32 MiBを超えています。".into());
            }
            std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            create_if_missing(&path, &bytes)
        })();
        collection.tasks[index].error = result.err().map(|e| e.chars().take(128).collect());
        self.save(&key, &collection, false)?;
        self.view(url)
    }
    pub fn open_task(
        &self,
        url: &str,
        task: &str,
        revision: u64,
        documents: &mut DocumentStore,
    ) -> Result<ProblemWorkspace, String> {
        let key = CollectionKey::parse(url)?;
        let collection = self.load(&key)?;
        if !collection.tasks.iter().any(|t| t.url == task) {
            return Err("問題集に含まれない問題です。".into());
        }
        let problem = self.snapshot(&key, task)?;
        ProblemLibrary::new(&self.root).open_workspace(problem, revision, documents)
    }

    pub fn repair_task(&self, url: &str, task: &str) -> Result<RepairedCollectionTask, String> {
        self.repair_with(url, task, download_problem)
    }
    fn repair_with(
        &self,
        url: &str,
        task: &str,
        fetch: impl FnOnce(&str) -> Result<Problem, String>,
    ) -> Result<RepairedCollectionTask, String> {
        let key = CollectionKey::parse(url)?;
        let view = self.view(url)?;
        if !view.collection.tasks.iter().any(|entry| entry.url == task) {
            return Err("問題集に含まれない問題です。".into());
        }
        if !view.downloaded.iter().any(|entry| entry == task) {
            return Err("未取得の問題は「未取得分を取得」から取得してください。".into());
        }
        // Explicit repairs bypass both caches. Do every fallible read/validation
        // before the atomic replacement so failure leaves the old bytes intact.
        let problem = fetch(task)?;
        validate(&problem, &ProblemKey::parse(task)?)?;
        let bytes = serde_json::to_vec_pretty(&problem).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_CACHE_BYTES {
            return Err("問題が32 MiBを超えています。".into());
        }
        write_atomic(&self.snapshot_path(&key, task)?, &bytes)
            .map_err(|e| format!("問題原本を置き換えられません: {e}"))?;
        Ok(RepairedCollectionTask { view, problem })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_problem;
    use crate::presentation::fill_images;
    use crate::{DocumentStore, SampleCase};
    const URL: &str = "https://atcoder.jp/contests/tessoku-book";
    const HTML: &str = include_str!("../tests/fixtures/atcoder-tessoku-tasks.html");
    fn problem(url: &str) -> crate::Problem {
        parse_problem(url, include_str!("../tests/fixtures/atcoder-task.html")).unwrap()
    }
    fn register(library: &CollectionLibrary) -> CollectionView {
        library
            .register_with(URL, |_| Ok(HTML.into()))
            .unwrap()
            .view
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_lookup_errors_never_replace_a_readable_manifest() {
        let root = tempfile::tempdir().unwrap();
        let library = CollectionLibrary::new(root.path());
        let mut collection = register(&library).collection;
        collection.title = "fixed title".into();
        collection.tasks[0].error = Some("saved failure".into());
        let key = CollectionKey::parse(URL).unwrap();
        library.save(&key, &collection, false).unwrap();
        let manifest = key.manifest(root.path());
        let original = std::fs::read(&manifest).unwrap();
        let snapshot = library
            .snapshot_path(&key, &collection.tasks[0].url)
            .unwrap();
        std::fs::create_dir_all(snapshot.parent().unwrap()).unwrap();
        // A symlink loop produces a real metadata I/O error even when running as root.
        std::os::unix::fs::symlink(&snapshot, &snapshot).unwrap();
        assert!(library.view(URL).is_err());
        assert!(library
            .register_with(URL, |_| panic!("readable manifest must not be refreshed"))
            .is_err());
        assert_eq!(std::fs::read(&manifest).unwrap(), original);
        let saved = library.load(&key).unwrap();
        assert_eq!(saved.title, "fixed title");
        assert_eq!(saved.tasks[0].error.as_deref(), Some("saved failure"));
    }

    #[test]
    fn re_registration_repairs_invalid_manifests_and_preserves_snapshots_and_workspaces() {
        for invalid in [b"broken".to_vec(), br#"{"obsolete":true}"#.to_vec()] {
            let root = tempfile::tempdir().unwrap();
            let library = CollectionLibrary::new(root.path());
            let registered = library.register_with(URL, |_| Ok(HTML.into())).unwrap();
            let task = &registered.view.collection.tasks[0].url;
            library
                .fetch_with(URL, task, |url| Ok(problem(url)))
                .unwrap();
            let mut documents = DocumentStore::default();
            library
                .open_task(URL, task, documents.revision(), &mut documents)
                .unwrap();
            let solution = documents.path().unwrap().to_owned();
            std::fs::write(&solution, b"my answer").unwrap();
            let cases = solution.parent().unwrap().join("cases.json");
            std::fs::write(&cases, b"my edited cases").unwrap();
            let key = CollectionKey::parse(URL).unwrap();
            let snapshot = library.snapshot_path(&key, task).unwrap();
            let original = std::fs::read(&snapshot).unwrap();
            let manifest = key.manifest(root.path());
            std::fs::write(&manifest, &invalid).unwrap();
            assert!(library.list().unwrap().is_empty());
            assert!(library
                .register_with(URL, |_| Err("offline".into()))
                .is_err());
            assert_eq!(std::fs::read(&manifest).unwrap(), invalid);
            assert!(library
                .register_with(URL, |_| Ok("invalid page".into()))
                .is_err());
            assert_eq!(std::fs::read(&manifest).unwrap(), invalid);
            let repaired = library
                .register_with(URL, |url| {
                    assert_eq!(url, format!("{URL}/tasks?lang=ja"));
                    Ok(HTML.into())
                })
                .unwrap();
            assert!(repaired.created);
            assert_eq!(repaired.view.downloaded, vec![task.clone()]);
            assert_eq!(library.list().unwrap().len(), 1);
            assert_eq!(std::fs::read(&snapshot).unwrap(), original);
            assert_eq!(std::fs::read(solution).unwrap(), b"my answer");
            assert_eq!(std::fs::read(cases).unwrap(), b"my edited cases");
            assert!(
                !library
                    .register_with(URL, |_| panic!("must reuse repaired manifest"))
                    .unwrap()
                    .created
            );
        }
    }

    #[test]
    fn list_skips_invalid_manifests_without_modifying_them() {
        let root = tempfile::tempdir().unwrap();
        let library = CollectionLibrary::new(root.path());
        library.register_with(URL, |_| Ok(HTML.into())).unwrap();
        let directory = root.path().join("library/collections");
        for name in ["broken.json", "invalid name.json"] {
            std::fs::write(directory.join(name), b"broken").unwrap();
        }
        assert_eq!(library.list().unwrap().len(), 1);
        assert_eq!(
            std::fs::read(directory.join("broken.json")).unwrap(),
            b"broken"
        );
    }

    #[test]
    fn real_tessoku_table_has_151_tasks_in_official_order() {
        let collection = parse_collection(&format!("{URL}/tasks?lang=en#top"), HTML).unwrap();
        assert_eq!(collection.url, URL);
        assert_eq!(collection.title, "競技プログラミングの鉄則 演習問題集");
        assert_eq!(collection.tasks.len(), 151);
        assert_eq!(collection.tasks[0].label, "A01");
        assert_eq!(collection.tasks[0].title, "The First Problem");
        assert_eq!(
            collection.tasks[0].url,
            format!("{URL}/tasks/tessoku_book_a")
        );
        assert_eq!(collection.tasks[75].label, "B01");
        assert_eq!(collection.tasks[150].label, "C20");
    }

    #[test]
    fn reject_invalid_urls_empty_duplicate_and_foreign_task_rows() {
        for url in [
            "http://atcoder.jp/contests/tessoku-book",
            "https://evil.test/contests/tessoku-book",
            "https://u@atcoder.jp/contests/tessoku-book",
            "https://atcoder.jp/contests/tessoku-book/tasks/x",
            "https://atcoder.jp/contests/a%2fb",
        ] {
            assert!(parse_collection(url, HTML).is_err(), "{url}");
        }
        for html in [
            "<a class=contest-title>Empty</a>".into(),
            HTML.replace("/tasks/tessoku_book_b\"", "/tasks/tessoku_book_a\""),
            HTML.replace(
                "/contests/tessoku-book/tasks/tessoku_book_a",
                "https://evil.test/task",
            ),
            HTML.replace(
                "/contests/tessoku-book/tasks/tessoku_book_a",
                "/contests/other/tasks/task_a",
            ),
            "x".repeat(4 * 1024 * 1024 + 1),
        ] {
            assert!(parse_collection(URL, &html).is_err());
        }
    }

    #[test]
    fn registration_is_a_fixed_snapshot_and_existing_registration_never_fetches() {
        let root = tempfile::tempdir().unwrap();
        let library = CollectionLibrary::new(root.path());
        let first = library
            .register_with(URL, |url| {
                assert_eq!(url, format!("{URL}/tasks?lang=ja"));
                Ok(HTML.into())
            })
            .unwrap();
        assert!(first.created);
        let again = library
            .register_with(&format!("{URL}/tasks/"), |_| panic!("must stay offline"))
            .unwrap();
        assert!(!again.created);
        assert_eq!(again.view.collection.title, first.view.collection.title);
        assert_eq!(library.list().unwrap().len(), 1);
        assert!(!root.path().join("workspaces").exists());
    }

    #[test]
    fn failure_resume_freeze_and_workspace_protection() {
        let root = tempfile::tempdir().unwrap();
        let library = CollectionLibrary::new(root.path());
        let view = register(&library);
        let a = &view.collection.tasks[0].url;
        let b = &view.collection.tasks[1].url;
        let failed = library
            .fetch_with(URL, a, |_| Err("offline".into()))
            .unwrap();
        assert_eq!(failed.collection.tasks[0].error.as_deref(), Some("offline"));
        assert!(failed.downloaded.is_empty());
        library.fetch_with(URL, b, |url| Ok(problem(url))).unwrap();
        let restarted = CollectionLibrary::new(root.path());
        assert_eq!(restarted.view(URL).unwrap().downloaded, vec![b.clone()]);
        assert_eq!(
            restarted.view(URL).unwrap().collection.tasks[0]
                .error
                .as_deref(),
            Some("offline")
        );
        let done = restarted
            .fetch_with(URL, a, |url| Ok(problem(url)))
            .unwrap();
        assert_eq!(done.downloaded.len(), 2);
        assert!(done.collection.tasks[0].error.is_none());
        restarted
            .fetch_with(URL, b, |_| panic!("already downloaded"))
            .unwrap();
        let mut documents = DocumentStore::default();
        let opened = restarted
            .open_task(URL, a, documents.revision(), &mut documents)
            .unwrap();
        let source = documents.path().unwrap().to_owned();
        documents.save("puts 'mine'", Some(source)).unwrap();
        let cases = vec![SampleCase {
            stdin: "custom".into(),
            expected_output: "mine".into(),
            compare: false,
        }];
        crate::ProblemLibrary::new(root.path())
            .save_cases(a, cases.clone())
            .unwrap();
        // A standalone refresh may change its own cache, never the collection copy.
        let cache = root
            .path()
            .join("library/problems/tessoku-book/tessoku_book_a");
        std::fs::create_dir_all(&cache).unwrap();
        let mut newer = problem(a);
        newer.statement = vec![crate::StatementPart::Text {
            text: "new edition".into(),
        }];
        std::fs::write(
            cache.join("problem.json"),
            serde_json::to_vec(&newer).unwrap(),
        )
        .unwrap();
        let reopened = restarted
            .open_task(URL, a, documents.revision(), &mut documents)
            .unwrap();
        assert_eq!(reopened.problem.statement, opened.problem.statement);
        assert_eq!(reopened.document.code.as_deref(), Some("puts 'mine'"));
        assert_eq!(reopened.cases, cases);
        assert!(restarted
            .fetch_with(
                URL,
                "https://atcoder.jp/contests/other/tasks/x",
                |_| panic!("foreign task")
            )
            .is_err());
        let snapshot = restarted
            .snapshot_path(&CollectionKey::parse(URL).unwrap(), a)
            .unwrap();
        std::fs::write(&snapshot, "corrupt").unwrap();
        assert!(restarted
            .fetch_with(URL, a, |_| panic!("cannot replace a snapshot"))
            .is_err());
        assert_eq!(std::fs::read_to_string(snapshot).unwrap(), "corrupt");
    }

    #[test]
    fn explicit_repair_replaces_only_the_target_and_keeps_workspaces_and_metadata() {
        let root = tempfile::tempdir().unwrap();
        let library = CollectionLibrary::new(root.path());
        let view = register(&library);
        let a = &view.collection.tasks[0].url;
        let b = &view.collection.tasks[1].url;
        for task in [a, b] {
            library
                .fetch_with(URL, task, |url| Ok(problem(url)))
                .unwrap();
        }
        let key = CollectionKey::parse(URL).unwrap();
        let manifest = std::fs::read(key.manifest(root.path())).unwrap();
        let other_path = library.snapshot_path(&key, b).unwrap();
        let other = std::fs::read(&other_path).unwrap();
        let mut documents = DocumentStore::default();
        library
            .open_task(URL, a, documents.revision(), &mut documents)
            .unwrap();
        let source = documents.path().unwrap().to_owned();
        documents
            .save("puts 'my answer'", Some(source.clone()))
            .unwrap();
        let cases = vec![SampleCase {
            stdin: "mine".into(),
            expected_output: "answer".into(),
            compare: false,
        }];
        ProblemLibrary::new(root.path())
            .save_cases(a, cases.clone())
            .unwrap();
        let case_path = source.parent().unwrap().join("cases.json");
        let saved_cases = std::fs::read(&case_path).unwrap();
        let revision = documents.revision();
        let global = root
            .path()
            .join("library/problems/tessoku-book/tessoku_book_a");
        std::fs::create_dir_all(&global).unwrap();
        std::fs::write(global.join("problem.json"), "bad standalone cache").unwrap();
        let html = include_str!("../tests/fixtures/atcoder-task.html")
            .replace("和を求める", "Repaired")
            .replace("1 2", "8 9")
            .replace("<pre>3", "<pre>17");
        let repaired = library
            .repair_with(URL, a, |url| {
                assert_eq!(url, a);
                parse_problem(url, &html)
            })
            .unwrap();
        assert!(repaired.problem.title.contains("Repaired"));
        assert_eq!(repaired.problem.samples[0].stdin, "8 9\n");
        assert_eq!(repaired.problem.samples[0].expected_output, "17\n");
        assert_eq!(repaired.view.downloaded.len(), 2);
        assert_eq!(documents.revision(), revision);
        assert_eq!(documents.path(), Some(source.as_path()));
        assert_eq!(
            std::fs::read_to_string(&source).unwrap(),
            "puts 'my answer'"
        );
        assert_eq!(std::fs::read(&case_path).unwrap(), saved_cases);
        assert_eq!(std::fs::read(key.manifest(root.path())).unwrap(), manifest);
        assert_eq!(std::fs::read(other_path).unwrap(), other);
        assert_eq!(
            std::fs::read_to_string(global.join("problem.json")).unwrap(),
            "bad standalone cache"
        );
        let reopened = library
            .open_task(URL, a, documents.revision(), &mut documents)
            .unwrap();
        assert!(reopened.problem.title.contains("Repaired"));
        assert_eq!(reopened.cases, cases);
    }

    #[test]
    fn repair_can_replace_corrupt_bytes_but_failures_leave_them_untouched() {
        let root = tempfile::tempdir().unwrap();
        let library = CollectionLibrary::new(root.path());
        let view = register(&library);
        let a = &view.collection.tasks[0].url;
        library.fetch_with(URL, a, |url| Ok(problem(url))).unwrap();
        let path = library
            .snapshot_path(&CollectionKey::parse(URL).unwrap(), a)
            .unwrap();
        std::fs::write(&path, "corrupt original").unwrap();
        assert!(library
            .repair_with(URL, a, |_| Err("network offline".into()))
            .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "corrupt original");
        assert!(library
            .repair_with(URL, a, |url| parse_problem(url, "not a task page"))
            .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "corrupt original");
        library
            .repair_with(URL, a, |_| {
                parse_problem(a, include_str!("../tests/fixtures/atcoder-task.html"))
            })
            .unwrap();
        assert!(library
            .snapshot(&CollectionKey::parse(URL).unwrap(), a)
            .is_ok());
    }

    #[test]
    fn repair_rejects_missing_and_foreign_tasks_before_fetching() {
        let root = tempfile::tempdir().unwrap();
        let library = CollectionLibrary::new(root.path());
        let view = register(&library);
        for task in [
            &view.collection.tasks[0].url[..],
            "https://atcoder.jp/contests/other/tasks/x",
            "https://atcoder.jp/contests/tessoku-book/tasks/unknown",
        ] {
            assert!(library
                .repair_with(URL, task, |_| panic!("must not fetch"))
                .is_err());
        }
        assert!(!root.path().join("workspaces").exists());
    }
    #[test]
    fn repaired_images_are_atomic_and_fixed_against_other_cache_updates() {
        let root = tempfile::tempdir().unwrap();
        let library = CollectionLibrary::new(root.path());
        let view = register(&library);
        let a = &view.collection.tasks[0].url;
        let mut media = problem(a);
        let mut parts = vec![crate::StatementPart::Image {
            url: "https://img.atcoder.jp/test/image.svg".into(),
            alt: "図".into(),
            data: String::new(),
            width: 0,
            height: 0,
        }];
        fill_images(&mut parts, |_| Ok(br#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>"#.to_vec())).unwrap();
        media.statement.extend(parts);
        library.fetch_with(URL, a, |_| Ok(media.clone())).unwrap();
        let path = library
            .snapshot_path(&CollectionKey::parse(URL).unwrap(), a)
            .unwrap();
        let old = std::fs::read(&path).unwrap();
        let mut bad = media.clone();
        if let Some(crate::StatementPart::Image { data, .. }) = bad.statement.last_mut() {
            *data = "broken".into();
        }
        assert!(library.repair_with(URL, a, |_| Ok(bad)).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), old);
        assert!(library
            .repair_with(URL, a, |_| Err("image download failed".into()))
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), old);
        media.title = "Repaired media".into();
        library.repair_with(URL, a, |_| Ok(media.clone())).unwrap();
        assert_eq!(
            library
                .snapshot(&CollectionKey::parse(URL).unwrap(), a)
                .unwrap()
                .statement,
            media.statement
        );
        library
            .fetch_with(URL, a, |_| panic!("acquired image must not download"))
            .unwrap();
    }
}
