use crate::files::{read_limited, write_atomic, MAX_TEXT_BYTES};
use crate::presentation::{
    download_image, fill_images, parse_statement, validate_statement, MAX_CACHE_BYTES,
};
use crate::StatementPart;
use crate::{load_samples, save_samples, DocumentResult, DocumentStore, SampleCase, SampleResult};
use reqwest::blocking::Client;
use scraper::{Html, Node, Selector};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use url::Url;

pub(crate) const MAX_HTML_BYTES: usize = 4 * MAX_TEXT_BYTES;

pub(crate) struct ProblemKey {
    pub(crate) url: String,
    pub(crate) contest: String,
    pub(crate) task: String,
}
impl ProblemKey {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        let url = Url::parse(value.trim()).map_err(|_| "AtCoder の問題URLを入力してください。")?;
        let parts: Vec<_> = url.path().trim_end_matches('/').split('/').collect();
        let valid_id = |id: &str| {
            !id.is_empty()
                && id.len() <= 100
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        };
        if url.scheme() != "https"
            || url.host_str() != Some("atcoder.jp")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || parts.len() != 5
            || parts[1] != "contests"
            || parts[3] != "tasks"
            || !valid_id(parts[2])
            || !valid_id(parts[4])
        {
            return Err(
                "https://atcoder.jp/contests/<contest>/tasks/<task> 形式のURLを入力してください。"
                    .into(),
            );
        }
        Ok(Self {
            url: format!(
                "https://atcoder.jp/contests/{}/tasks/{}",
                parts[2], parts[4]
            ),
            contest: parts[2].into(),
            task: parts[4].into(),
        })
    }
    fn directory(&self, root: &Path, kind: &str) -> PathBuf {
        root.join(kind).join(&self.contest).join(&self.task)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Problem {
    pub url: String,
    pub title: String,
    pub statement: Vec<StatementPart>,
    pub samples: Vec<SampleCase>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemWorkspace {
    pub problem: Problem,
    pub document: DocumentResult,
    pub cases: Vec<SampleCase>,
}

pub(crate) fn validate(problem: &Problem, key: &ProblemKey) -> Result<(), String> {
    validate_content(problem, key, true)
}
fn validate_content(
    problem: &Problem,
    key: &ProblemKey,
    require_images: bool,
) -> Result<(), String> {
    if problem.url != key.url || problem.title.trim().is_empty() || problem.title.len() > 1024 {
        return Err("問題データのURL・タイトルが不正です。".into());
    }
    validate_statement(&problem.statement, &key.url, require_images)?;
    if problem.samples.is_empty() {
        Ok(())
    } else {
        crate::samples::validate(&problem.samples)
    }
}
fn selector(value: &str) -> Selector {
    Selector::parse(value).unwrap()
}
pub fn parse_problem(url: &str, html: &str) -> Result<Problem, String> {
    let key = ProblemKey::parse(url)?;
    if html.len() > MAX_HTML_BYTES {
        return Err("問題ページは4 MiB以下にしてください。".into());
    }
    let doc = Html::parse_document(html);
    let task = doc
        .select(&selector("#task-statement"))
        .next()
        .ok_or("公開されている問題文が見つかりません。URLや公開状態を確認してください。")?;
    let body = task
        .select(&selector(".lang-ja"))
        .next()
        .or_else(|| task.select(&selector(".lang-en")).next())
        .unwrap_or(task);
    let title = doc
        .select(&selector("span.h2"))
        .next()
        .ok_or("問題のタイトルが見つかりません。")?
        .children()
        .filter_map(|node| node.value().as_text())
        .map(|text| &**text)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut inputs = BTreeMap::new();
    let mut outputs = BTreeMap::new();
    let mut pending = None;
    // Older tasks put h3 outside section. Pair each heading with its next pre
    // in document order, without crossing another heading.
    for element in body.select(&selector("h3, pre")) {
        if element.value().name() == "h3" {
            if pending.is_some() {
                return Err("サンプル本文がありません。".into());
            }
            let heading = element.text().collect::<String>();
            let heading = heading.trim();
            let (number, is_input) = if let Some(n) = heading
                .strip_prefix("入力例")
                .or_else(|| heading.strip_prefix("Sample Input"))
            {
                (n, true)
            } else if let Some(n) = heading
                .strip_prefix("出力例")
                .or_else(|| heading.strip_prefix("Sample Output"))
            {
                (n, false)
            } else {
                continue;
            };
            let number: usize = number
                .trim()
                .parse()
                .map_err(|_| "サンプル番号が不正です。")?;
            pending = Some((number, is_input));
            continue;
        }
        let Some((number, is_input)) = pending.take() else {
            continue;
        };
        let target = if is_input { &mut inputs } else { &mut outputs };
        let mut value = String::new();
        // HTML entities are decoded by the parser; pre whitespace is retained.
        for node in element.descendants() {
            match node.value() {
                Node::Text(text) => value.push_str(text),
                Node::Element(e) if e.name() == "br" => value.push('\n'),
                _ => {}
            }
        }
        if number == 0 || target.insert(number, value).is_some() {
            return Err("サンプル番号が不正または重複しています。".into());
        }
    }
    if pending.is_some() {
        return Err("サンプル本文がありません。".into());
    }
    if inputs.keys().ne(outputs.keys()) {
        return Err("対応するサンプル入出力が見つかりません。".into());
    }
    let samples = inputs
        .into_iter()
        .map(|(number, stdin)| SampleCase {
            stdin,
            expected_output: outputs.remove(&number).unwrap(),
            compare: true,
        })
        .collect();
    let statement = parse_statement(body, &key.url)?;
    let problem = Problem {
        url: key.url.clone(),
        title,
        statement,
        samples,
    };
    validate_content(&problem, &key, false)?;
    Ok(problem)
}

pub(crate) fn download(client: &Client, url: &str) -> Result<String, String> {
    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("問題を取得できません: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "問題を取得できません（HTTP {}）。公開状態を確認し、時間をおいて再試行してください。",
            response.status()
        ));
    }
    let mut bytes = Vec::new();
    response
        .take((MAX_HTML_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("問題の読み込みに失敗しました: {e}"))?;
    if bytes.len() > MAX_HTML_BYTES {
        return Err("問題ページは4 MiB以下にしてください。".into());
    }
    String::from_utf8(bytes).map_err(|_| "問題ページがUTF-8ではありません。".into())
}

pub(crate) fn http_client() -> Result<Client, String> {
    Client::builder()
        .use_native_tls()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("AtCoder-Ruby-IDE/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

pub(crate) fn download_problem(url: &str) -> Result<Problem, String> {
    let key = ProblemKey::parse(url)?;
    let client = http_client()?;
    let html = download(&client, &format!("{}?lang=ja", key.url))?;
    let mut problem = parse_problem(&key.url, &html)?;
    fill_images(&mut problem.statement, |url| download_image(&client, url))?;
    validate(&problem, &key)?;
    Ok(problem)
}

pub struct ProblemLibrary {
    root: PathBuf,
}
impl ProblemLibrary {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    pub fn problem(&self, url: &str, refresh: bool) -> Result<Problem, String> {
        let key = ProblemKey::parse(url)?;
        let cache = key
            .directory(&self.root, "library/problems")
            .join("problem.json");
        if !refresh && cache.try_exists().map_err(|e| e.to_string())? {
            let data = read_limited(&cache, MAX_CACHE_BYTES)
                .map_err(|e| format!("保存済み問題を読み込めません: {e}"))?;
            let problem: Problem = serde_json::from_slice(&data)
                .map_err(|e| format!("保存済み問題が不正です。再取得してください: {e}"))?;
            validate(&problem, &key)?;
            return Ok(problem);
        }
        let client = http_client()?;
        self.store_page_with(
            &key,
            &download(&client, &format!("{}?lang=ja", key.url))?,
            |url| download_image(&client, url),
        )
    }
    #[cfg(test)]
    fn store_page(&self, key: &ProblemKey, html: &str) -> Result<Problem, String> {
        let client = http_client()?;
        self.store_page_with(key, html, |url| download_image(&client, url))
    }
    fn store_page_with(
        &self,
        key: &ProblemKey,
        html: &str,
        fetch_image: impl FnMut(&str) -> Result<Vec<u8>, String>,
    ) -> Result<Problem, String> {
        let mut problem = parse_problem(&key.url, html)?;
        fill_images(&mut problem.statement, fetch_image)?;
        validate(&problem, key)?;
        let data = serde_json::to_vec_pretty(&problem).map_err(|e| e.to_string())?;
        if data.len() > MAX_CACHE_BYTES {
            return Err("保存する問題が32 MiBを超えています。".into());
        }
        let cache = key
            .directory(&self.root, "library/problems")
            .join("problem.json");
        std::fs::create_dir_all(cache.parent().unwrap()).map_err(|e| e.to_string())?;
        write_atomic(&cache, &data).map_err(|e| format!("問題を保存できません: {e}"))?;
        Ok(problem)
    }
    pub fn open_problem(
        &self,
        url: &str,
        revision: u64,
        documents: &std::sync::Mutex<DocumentStore>,
    ) -> Result<ProblemWorkspace, String> {
        let problem = self.problem(url, false)?;
        self.open_workspace(problem, revision, &mut documents.lock().unwrap())
    }
    pub fn open_workspace(
        &self,
        problem: Problem,
        expected_document_revision: u64,
        documents: &mut DocumentStore,
    ) -> Result<ProblemWorkspace, String> {
        if documents.revision() != expected_document_revision {
            return Err("取得中に編集中の文書が変わりました。問題を開き直してください。".into());
        }
        let key = ProblemKey::parse(&problem.url)?;
        validate(&problem, &key)?;
        let workspace = key.directory(&self.root, "workspaces");
        std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
        let case_path = workspace.join("cases.json");
        let initial_cases = if problem.samples.is_empty() {
            vec![SampleCase {
                stdin: String::new(),
                expected_output: String::new(),
                compare: false,
            }]
        } else {
            problem.samples.clone()
        };
        let data = serde_json::to_vec_pretty(&serde_json::json!({"cases":initial_cases}))
            .map_err(|e| e.to_string())?;
        create_if_missing(&case_path, &data)?;
        let cases = load_samples(Some(case_path))?.cases.unwrap();
        let code_path = workspace.join("solution.rb");
        create_if_missing(&code_path, b"")?;
        let document = documents.open(Some(code_path))?;
        Ok(ProblemWorkspace {
            problem,
            document,
            cases,
        })
    }
    pub fn save_cases(&self, url: &str, cases: Vec<SampleCase>) -> Result<SampleResult, String> {
        let key = ProblemKey::parse(url)?;
        let workspace = key.directory(&self.root, "workspaces");
        if !workspace.is_dir() {
            return Err("問題を開いてからケースを保存してください。".into());
        }
        save_samples(cases, Some(workspace.join("cases.json")))
    }
}
pub(crate) fn create_if_missing(path: &Path, data: &[u8]) -> Result<(), String> {
    if path.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    temporary.write_all(data).map_err(|e| e.to_string())?;
    match temporary.persist_noclobber(path) {
        Ok(_) => Ok(()),
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(format!("作業領域を作成できません: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    fn serve(response: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 2048];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(&response);
        });
        (url, thread)
    }
    #[test]
    fn http_status_redirect_size_and_utf8_are_checked() {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        for (status, body, ok) in [
            ("200 OK", b"<p>ok</p>".to_vec(), true),
            ("404 Not Found", vec![], false),
            ("302 Found", vec![], false),
            ("200 OK", vec![b'x'; MAX_HTML_BYTES + 1], false),
            ("200 OK", vec![0xff], false),
        ] {
            let mut response = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nLocation: http://example.invalid/\r\n\r\n", body.len()).into_bytes();
            response.extend(body);
            let (url, server) = serve(response);
            assert_eq!(download(&client, &url).is_ok(), ok);
            server.join().unwrap();
        }
    }
    #[test]
    fn refresh_is_atomic_and_does_not_touch_user_files() {
        let root = tempfile::tempdir().unwrap();
        let library = ProblemLibrary::new(root.path());
        let url = "https://atcoder.jp/contests/abs/tasks/practice_1";
        let key = ProblemKey::parse(url).unwrap();
        let html = include_str!("../tests/fixtures/atcoder-task.html");
        let first = library.store_page(&key, html).unwrap();
        let mut documents = DocumentStore::default();
        let workspace = library
            .open_workspace(first, documents.revision(), &mut documents)
            .unwrap();
        let code_path = documents.path().unwrap().to_owned();
        documents
            .save("puts 'my answer'", Some(code_path.clone()))
            .unwrap();
        let cache = key
            .directory(root.path(), "library/problems")
            .join("problem.json");
        let old = std::fs::read(&cache).unwrap();
        assert!(library.store_page(&key, "invalid page").is_err());
        assert_eq!(std::fs::read(&cache).unwrap(), old);
        let updated = library
            .store_page(
                &key,
                &html.replace("和を求める", "Updated").replace("1 2", "8 9"),
            )
            .unwrap();
        assert_eq!(updated.samples[0].stdin, "8 9\n");
        let reopened = library
            .open_workspace(updated, documents.revision(), &mut documents)
            .unwrap();
        assert!(reopened.problem.title.contains("Updated"));
        assert_eq!(reopened.cases, workspace.cases);
        assert_eq!(
            std::fs::read_to_string(code_path).unwrap(),
            "puts 'my answer'"
        );
    }
    #[test]
    fn image_download_failure_keeps_the_entire_old_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let library = ProblemLibrary::new(root.path());
        let key = ProblemKey::parse("https://atcoder.jp/contests/test/tasks/task").unwrap();
        let html = r#"<span class="h2">Media</span><div id="task-statement"><p><var>\\frac{1}{2}</var></p><img src="https://img.atcoder.jp/test/figure.svg" alt="図"></div>"#;
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50"/></svg>"#;
        library
            .store_page_with(&key, html, |_| Ok(svg.to_vec()))
            .unwrap();
        let cache = key
            .directory(root.path(), "library/problems")
            .join("problem.json");
        let old = std::fs::read(&cache).unwrap();
        assert!(library
            .store_page_with(&key, html, |_| Err("offline".into()))
            .is_err());
        assert_eq!(std::fs::read(&cache).unwrap(), old);
        assert!(library
            .store_page_with(&key, html, |_| Ok(b"broken image".to_vec()))
            .is_err());
        assert_eq!(std::fs::read(&cache).unwrap(), old);
        let reopened = library.problem(&key.url, false).unwrap();
        assert!(
            reopened.statement.iter().any(|p| matches!(p, StatementPart::Image { data, .. } if data.starts_with("data:image/svg+xml;base64,")))
        );
    }
}
