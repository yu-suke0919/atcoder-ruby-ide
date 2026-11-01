//! A task's samples and limits read from its AtCoder page, and the workspace that holds the user's
//! solution and samples for that task.
use crate::files::{read_limited, write_atomic, MAX_TEXT_BYTES};
use crate::{
    load_samples, save_samples, solutions, DocumentResult, DocumentStore, ProblemSample, SampleCase,
};
use scraper::{ElementRef, Html, Node, Selector};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use url::Url;

pub(crate) const MAX_HTML_BYTES: usize = 4 * MAX_TEXT_BYTES;
const MAX_TASK_BYTES: usize = 16 * 1024 * 1024;

pub(crate) struct TaskKey {
    pub(crate) url: String,
    pub(crate) contest: String,
    pub(crate) task: String,
}
impl TaskKey {
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
    fn workspace(&self, root: &Path) -> PathBuf {
        root.join("workspaces").join(&self.contest).join(&self.task)
    }
}

/// What the app keeps from a task page. The statement itself is read in the browser.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub url: String,
    pub samples: Vec<ProblemSample>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_limit_ms: Option<u32>,
    #[serde(rename = "memoryLimitMiB", skip_serializing_if = "Option::is_none")]
    pub memory_limit_mib: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkspace {
    pub task: Task,
    /// The file names in tab order; `file` is the open one.
    pub files: Vec<String>,
    pub file: String,
    pub document: DocumentResult,
    pub cases: Vec<SampleCase>,
}

/// The home workspace: code and samples that belong to no task.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeWorkspace {
    pub files: Vec<String>,
    pub file: String,
    pub document: DocumentResult,
    pub cases: Vec<SampleCase>,
}

/// The name the screen and the file commands use for the home workspace.
const HOME: &str = "home";

struct Opened {
    files: Vec<String>,
    file: String,
    document: DocumentResult,
    cases: Vec<SampleCase>,
}

fn empty_case() -> SampleCase {
    SampleCase {
        stdin: String::new(),
        expected_output: String::new(),
        compare: false,
        tolerance: None,
    }
}

/// Opens the samples and the first file of a workspace directory, creating them on first use.
fn open_files(
    directory: &Path,
    label: &str,
    initial_cases: Vec<SampleCase>,
    expected_document_revision: u64,
    documents: &mut DocumentStore,
) -> Result<Opened, String> {
    if documents.revision() != expected_document_revision {
        return Err("読み込み中に編集中の問題が変わりました。問題を開き直してください。".into());
    }
    std::fs::create_dir_all(directory).map_err(|e| format!("作業領域を作成できません: {e}"))?;
    let case_path = directory.join("cases.json");
    let data = serde_json::to_vec_pretty(&serde_json::json!({ "cases": initial_cases }))
        .map_err(|e| e.to_string())?;
    create_if_missing(&case_path, &data)?;
    let cases = load_samples(&case_path)?;
    solutions::ensure(directory, label)?;
    let files = solutions::list(directory)?;
    let file = files.first().ok_or("ファイルがありません。")?.clone();
    let document = documents.open(solutions::path(directory, &file)?)?;
    Ok(Opened {
        files,
        file,
        document,
        cases,
    })
}

fn validate(task: &Task, key: &TaskKey) -> Result<(), String> {
    if task.url != key.url {
        return Err("問題データのURLが不正です。".into());
    }
    if task.time_limit_ms == Some(0) || task.memory_limit_mib == Some(0) {
        return Err("問題の制限値が不正です。".into());
    }
    if task.samples.len() > 100 {
        return Err("サンプルは100件以下にしてください。".into());
    }
    if task.samples.is_empty() {
        Ok(())
    } else {
        crate::samples::validate_problem_samples(&task.samples)
    }
}
fn selector(value: &str) -> Selector {
    Selector::parse(value).unwrap()
}

fn milliseconds(value: &str) -> Option<u32> {
    let (seconds, fraction) = value.split_once('.').unwrap_or((value, "0"));
    if fraction.len() > 3
        || [seconds, fraction]
            .iter()
            .any(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    seconds
        .parse::<u32>()
        .ok()?
        .checked_mul(1000)?
        .checked_add(fraction.parse::<u32>().ok()? * 10_u32.pow(3 - fraction.len() as u32))
}

fn parse_limits(task: ElementRef<'_>) -> Result<(Option<u32>, Option<u32>), String> {
    let (mut time, mut memory) = (None, None);
    let invalid = || "問題の制限値が不正です。".to_string();
    for paragraph in task
        .prev_siblings()
        .filter_map(ElementRef::wrap)
        .filter(|element| element.value().name() == "p")
    {
        let text = paragraph.text().collect::<String>();
        for part in text.split('/') {
            let part = part.trim();
            let (target, unit, value) = if let Some(value) = part
                .strip_prefix("実行時間制限")
                .or_else(|| part.strip_prefix("Time Limit"))
            {
                (&mut time, "sec", value)
            } else if let Some(value) = part
                .strip_prefix("メモリ制限")
                .or_else(|| part.strip_prefix("Memory Limit"))
            {
                (&mut memory, "MiB", value)
            } else {
                continue;
            };
            let value = value.trim_start().strip_prefix(':').ok_or_else(invalid)?;
            let mut words = value.split_whitespace();
            let number = words.next().ok_or_else(invalid)?;
            if target.is_some() || words.next() != Some(unit) || words.next().is_some() {
                return Err(invalid());
            }
            let value = if unit == "sec" {
                milliseconds(number).ok_or_else(invalid)?
            } else {
                number.parse::<u32>().map_err(|_| invalid())?
            };
            if value == 0 {
                return Err(invalid());
            }
            *target = Some(value);
        }
    }
    Ok((time, memory))
}

/// Reads samples and limits from a task page. A page without a task statement (not logged in,
/// not registered, or missing) is an error so the caller can ask the user to log in or register.
pub fn parse_task(url: &str, html: &str) -> Result<Task, String> {
    let key = TaskKey::parse(url)?;
    if html.len() > MAX_HTML_BYTES {
        return Err("問題ページは4 MiB以下にしてください。".into());
    }
    let doc = Html::parse_document(html);
    let task = doc.select(&selector("#task-statement")).next().ok_or(
        "問題文が見つかりません。ブラウザでログインし、開催中のコンテストは参加登録してください。",
    )?;
    let body = task
        .select(&selector(".lang-ja"))
        .next()
        .or_else(|| task.select(&selector(".lang-en")).next())
        .unwrap_or(task);
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
            // Only the heading's own text: the loaded page adds a Copy button inside it.
            let heading = element
                .children()
                .filter_map(|node| node.value().as_text().map(|text| &**text))
                .collect::<String>();
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
        .map(|(number, stdin)| ProblemSample {
            stdin,
            expected_output: outputs.remove(&number).unwrap(),
        })
        .collect();
    let (time_limit_ms, memory_limit_mib) = parse_limits(task)?;
    let task = Task {
        url: key.url.clone(),
        samples,
        time_limit_ms,
        memory_limit_mib,
    };
    validate(&task, &key)?;
    Ok(task)
}

pub struct Workspaces {
    root: PathBuf,
}
impl Workspaces {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    /// The saved task, or None when it is missing or no longer readable and must be read again.
    pub fn task(&self, url: &str) -> Result<Option<Task>, String> {
        let key = TaskKey::parse(url)?;
        let Ok(data) = read_limited(&key.workspace(&self.root).join("task.json"), MAX_TASK_BYTES)
        else {
            return Ok(None);
        };
        Ok(serde_json::from_slice::<Task>(&data)
            .ok()
            .filter(|task| validate(task, &key).is_ok()))
    }
    pub fn store_task(&self, task: &Task) -> Result<(), String> {
        let key = TaskKey::parse(&task.url)?;
        validate(task, &key)?;
        let directory = key.workspace(&self.root);
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let data = serde_json::to_vec_pretty(task).map_err(|e| e.to_string())?;
        write_atomic(&directory.join("task.json"), &data)
            .map_err(|e| format!("問題の内容を保存できません: {e}"))
    }
    /// Opens the workspace of a task whose page has been read. The first open creates the
    /// solution and the samples; later opens restore them unchanged.
    pub fn open(
        &self,
        url: &str,
        label: &str,
        expected_document_revision: u64,
        documents: &mut DocumentStore,
    ) -> Result<TaskWorkspace, String> {
        let key = TaskKey::parse(url)?;
        let task = self
            .task(url)?
            .ok_or("問題ページをまだ読み取っていません。ブラウザで問題ページを開いてください。")?;
        let initial_cases = if task.samples.is_empty() {
            vec![empty_case()]
        } else {
            task.samples.iter().map(SampleCase::from).collect()
        };
        let opened = open_files(
            &key.workspace(&self.root),
            label,
            initial_cases,
            expected_document_revision,
            documents,
        )?;
        Ok(TaskWorkspace {
            task,
            files: opened.files,
            file: opened.file,
            document: opened.document,
            cases: opened.cases,
        })
    }
    /// Opens the home workspace, creating it with one empty, uncompared sample on first use.
    pub fn open_home(
        &self,
        expected_document_revision: u64,
        documents: &mut DocumentStore,
    ) -> Result<HomeWorkspace, String> {
        let opened = open_files(
            &self.root.join(HOME),
            HOME,
            vec![empty_case()],
            expected_document_revision,
            documents,
        )?;
        Ok(HomeWorkspace {
            files: opened.files,
            file: opened.file,
            document: opened.document,
            cases: opened.cases,
        })
    }
    /// The directory of a workspace: `home`, or a task URL.
    fn directory(&self, workspace: &str) -> Result<PathBuf, String> {
        if workspace == HOME {
            Ok(self.root.join(HOME))
        } else {
            Ok(TaskKey::parse(workspace)?.workspace(&self.root))
        }
    }
    pub fn files(&self, workspace: &str) -> Result<Vec<String>, String> {
        solutions::list(&self.directory(workspace)?)
    }
    pub fn open_file(
        &self,
        workspace: &str,
        name: &str,
        documents: &mut DocumentStore,
    ) -> Result<DocumentResult, String> {
        let directory = self.directory(workspace)?;
        if !self.files(workspace)?.iter().any(|file| file == name) {
            return Err(format!("「{name}」がありません。"));
        }
        documents.open(solutions::path(&directory, name)?)
    }
    pub fn create_file(&self, workspace: &str, label: &str) -> Result<String, String> {
        solutions::create(&self.directory(workspace)?, label)
    }
    /// Renames a file. The open file keeps being the open one under its new name.
    pub fn rename_file(
        &self,
        workspace: &str,
        from: &str,
        to: &str,
        documents: &mut DocumentStore,
    ) -> Result<(), String> {
        let (old, new) = solutions::rename(&self.directory(workspace)?, from, to)?;
        if documents.path() == Some(old.as_path()) {
            documents.open(new)?;
        }
        Ok(())
    }
    pub fn delete_file(
        &self,
        workspace: &str,
        name: &str,
        documents: &DocumentStore,
    ) -> Result<(), String> {
        solutions::delete(&self.directory(workspace)?, name, documents.path())
    }
    pub fn save_home_cases(&self, cases: Vec<SampleCase>) -> Result<(), String> {
        let home = self.root.join(HOME);
        if !home.is_dir() {
            return Err("ホームを開いてからサンプルを保存してください。".into());
        }
        save_samples(cases, &home.join("cases.json"))
    }
    pub fn save_cases(&self, url: &str, cases: Vec<SampleCase>) -> Result<(), String> {
        let workspace = TaskKey::parse(url)?.workspace(&self.root);
        if !workspace.is_dir() {
            return Err("問題を開いてからサンプルを保存してください。".into());
        }
        save_samples(cases, &workspace.join("cases.json"))
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

/// Reads a loaded task page into `task.json`. Used by the browser and by the UI test host.
pub fn read_task_page(workspaces: &Workspaces, url: &str, html: &str) -> Result<(), String> {
    workspaces.store_task(&parse_task(url, html)?)
}

/// Whether a loaded page address is the given task page, ignoring query and fragment.
pub fn is_task_page(task_url: &str, loaded: &Url) -> bool {
    Url::parse(task_url).is_ok_and(|task| task.path() == loaded.path().trim_end_matches('/'))
}
