use crate::files::{read_limited, write_atomic, MAX_TEXT_BYTES};
use crate::{load_samples, save_samples, DocumentResult, DocumentStore, SampleCase, SampleResult};
use reqwest::blocking::Client;
use scraper::{ElementRef, Html, Node, Selector};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use url::Url;

const MAX_HTML_BYTES: usize = 4 * MAX_TEXT_BYTES;
const MAX_CACHE_BYTES: usize = 8 * MAX_TEXT_BYTES;

struct ProblemKey {
    url: String,
    contest: String,
    task: String,
}
impl ProblemKey {
    fn parse(value: &str) -> Result<Self, String> {
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
    pub statement: String,
    pub samples: Vec<SampleCase>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemWorkspace {
    pub problem: Problem,
    pub document: DocumentResult,
    pub cases: Vec<SampleCase>,
}

fn validate(problem: &Problem, key: &ProblemKey) -> Result<(), String> {
    if problem.url != key.url
        || problem.title.trim().is_empty()
        || problem.title.len() > 1024
        || problem.statement.trim().is_empty()
        || problem.statement.len() > MAX_TEXT_BYTES
    {
        return Err(
            "問題データのURL・タイトル・本文が不正、またはサイズ上限を超えています。".into(),
        );
    }
    crate::samples::validate(&problem.samples)
}
fn selector(value: &str) -> Selector {
    Selector::parse(value).unwrap()
}
fn plain_text(element: ElementRef<'_>, out: &mut String) {
    let name = element.value().name();
    if ["script", "style", "noscript", "iframe"].contains(&name) {
        return;
    }
    if name == "img" {
        out.push_str(&format!(
            "[画像: {}]",
            element
                .value()
                .attr("alt")
                .filter(|s| !s.is_empty())
                .unwrap_or("原文を参照")
        ));
        return;
    }
    let block = [
        "p", "div", "section", "h1", "h2", "h3", "h4", "pre", "li", "tr", "br",
    ]
    .contains(&name);
    if block {
        out.push('\n');
    }
    for child in element.children() {
        match child.value() {
            Node::Text(text) => out.push_str(text),
            Node::Element(_) => plain_text(ElementRef::wrap(child).unwrap(), out),
            _ => {}
        }
    }
    if block {
        out.push('\n');
    }
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
        .text()
        .collect::<String>()
        .trim()
        .to_owned();
    let mut inputs = BTreeMap::new();
    let mut outputs = BTreeMap::new();
    for section in body.select(&selector("section")) {
        let Some(heading) = section.select(&selector("h3")).next() else {
            continue;
        };
        let heading = heading.text().collect::<String>();
        let heading = heading.trim();
        let (number, target) = if let Some(n) = heading
            .strip_prefix("入力例")
            .or_else(|| heading.strip_prefix("Sample Input"))
        {
            (n, &mut inputs)
        } else if let Some(n) = heading
            .strip_prefix("出力例")
            .or_else(|| heading.strip_prefix("Sample Output"))
        {
            (n, &mut outputs)
        } else {
            continue;
        };
        let number: usize = number
            .trim()
            .parse()
            .map_err(|_| "サンプル番号が不正です。")?;
        let pre = section
            .select(&selector("pre"))
            .next()
            .ok_or("サンプル本文がありません。")?;
        let mut value = String::new();
        // HTML entities are decoded by the parser; pre whitespace is retained.
        for node in pre.descendants() {
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
    if inputs.is_empty() || inputs.keys().ne(outputs.keys()) {
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
    let mut statement = String::new();
    plain_text(body, &mut statement);
    let problem = Problem {
        url: key.url.clone(),
        title,
        statement: statement.trim().to_owned(),
        samples,
    };
    validate(&problem, &key)?;
    Ok(problem)
}

fn download(client: &Client, url: &str) -> Result<String, String> {
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
        let client = Client::builder()
            .use_native_tls()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .user_agent(concat!("AtCoder-Ruby-IDE/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        self.store_page(&key, &download(&client, &format!("{}?lang=ja", key.url))?)
    }
    fn store_page(&self, key: &ProblemKey, html: &str) -> Result<Problem, String> {
        let problem = parse_problem(&key.url, html)?;
        let data = serde_json::to_vec_pretty(&problem).map_err(|e| e.to_string())?;
        if data.len() > MAX_CACHE_BYTES {
            return Err("保存する問題が8 MiBを超えています。".into());
        }
        let cache = key
            .directory(&self.root, "library/problems")
            .join("problem.json");
        std::fs::create_dir_all(cache.parent().unwrap()).map_err(|e| e.to_string())?;
        write_atomic(&cache, &data).map_err(|e| format!("問題を保存できません: {e}"))?;
        Ok(problem)
    }
    pub fn open_workspace(
        &self,
        problem: Problem,
        documents: &mut DocumentStore,
    ) -> Result<ProblemWorkspace, String> {
        let key = ProblemKey::parse(&problem.url)?;
        validate(&problem, &key)?;
        let workspace = key.directory(&self.root, "workspaces");
        std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
        let case_path = workspace.join("cases.json");
        let data = serde_json::to_vec_pretty(&serde_json::json!({"cases":problem.samples}))
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
fn create_if_missing(path: &Path, data: &[u8]) -> Result<(), String> {
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
        let workspace = library.open_workspace(first, &mut documents).unwrap();
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
                &html
                    .replace("和を求める", "Updated")
                    .replace("1 2\n", "8 9\n"),
            )
            .unwrap();
        let reopened = library.open_workspace(updated, &mut documents).unwrap();
        assert!(reopened.problem.title.contains("Updated"));
        assert_eq!(reopened.cases, workspace.cases);
        assert_eq!(
            std::fs::read_to_string(code_path).unwrap(),
            "puts 'my answer'"
        );
    }
}
