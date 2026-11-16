//! The workspace of each task, and home: the user's solution files and samples, opened and saved
//! under the app's data folder.
use crate::files::{create_if_missing, read_limited, write_atomic};
use crate::navigation::TaskKey;
use crate::task::{parse_task, validate, Task};
use crate::{
    load_samples, save_samples, solutions, DocumentResult, DocumentStore, SampleCase, Samples,
};
use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_TASK_BYTES: usize = 16 * 1024 * 1024;

impl TaskKey {
    fn workspace(&self, root: &Path) -> PathBuf {
        root.join("workspaces").join(&self.contest).join(&self.task)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkspace {
    pub task: Task,
    /// The rows of the reading code as `[loop, array]`, for the editor's switch buttons.
    pub reading_forms: Vec<[String; 2]>,
    /// Where the sample input holds a graph, for the graph window (D4).
    pub graph: Option<crate::GraphForm>,
    pub files: Vec<String>,
    pub file: String,
    pub document: DocumentResult,
    pub samples: Samples,
}

/// The files and samples of an open workspace; home is only this.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFiles {
    /// The file names in tab order; `file` is the open one.
    pub files: Vec<String>,
    pub file: String,
    pub document: DocumentResult,
    pub samples: Samples,
}

/// The name the screen and the file commands use for the home workspace.
const HOME: &str = "home";

fn empty_case() -> SampleCase {
    SampleCase {
        stdin: String::new(),
        expected_output: String::new(),
        compare: false,
    }
}

/// Opens the samples and the first file of a workspace directory, creating them on first use.
fn open_files(
    directory: &Path,
    label: &str,
    template: &str,
    initial_cases: Vec<SampleCase>,
    expected_document_revision: u64,
    documents: &mut DocumentStore,
) -> Result<WorkspaceFiles, String> {
    if documents.revision() != expected_document_revision {
        return Err("読み込み中に編集中の問題が変わりました。問題を開き直してください。".into());
    }
    std::fs::create_dir_all(directory).map_err(|e| format!("作業領域を作成できません: {e}"))?;
    let sample_path = directory.join("samples.json");
    if !sample_path.try_exists().map_err(|e| e.to_string())? {
        let initial = Samples {
            tolerance: None,
            cases: initial_cases,
        };
        let data = serde_json::to_vec_pretty(&initial).map_err(|e| e.to_string())?;
        create_if_missing(&sample_path, &data)?;
    }
    let samples = load_samples(&sample_path)?;
    solutions::ensure(directory, label, template)?;
    let files = solutions::list(directory)?;
    let file = files.first().ok_or("ファイルがありません。")?.clone();
    let document = documents.open(solutions::path(directory, &file)?)?;
    Ok(WorkspaceFiles {
        files,
        file,
        document,
        samples,
    })
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
            &task.input_code(),
            initial_cases,
            expected_document_revision,
            documents,
        )?;
        Ok(TaskWorkspace {
            reading_forms: task.reading_forms(),
            graph: task.graph_form(),
            task,
            files: opened.files,
            file: opened.file,
            document: opened.document,
            samples: opened.samples,
        })
    }
    /// Opens the home workspace, creating it with one empty, uncompared sample on first use.
    pub fn open_home(
        &self,
        expected_document_revision: u64,
        documents: &mut DocumentStore,
    ) -> Result<WorkspaceFiles, String> {
        open_files(
            &self.root.join(HOME),
            HOME,
            "",
            vec![empty_case()],
            expected_document_revision,
            documents,
        )
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
        // New files of a task start with its reading code; home has no input format.
        let template = if workspace == HOME {
            String::new()
        } else {
            self.task(workspace)?
                .map(|task| task.input_code())
                .unwrap_or_default()
        };
        solutions::create(&self.directory(workspace)?, label, &template)
    }
    pub fn copy_file(&self, workspace: &str, name: &str, label: &str) -> Result<String, String> {
        solutions::copy(&self.directory(workspace)?, name, label)
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
    /// Saves the samples of an open workspace: `home` or a task URL.
    pub fn save_samples(&self, workspace: &str, samples: Samples) -> Result<(), String> {
        let directory = self.directory(workspace)?;
        if !directory.is_dir() {
            return Err("問題を開いてからサンプルを保存してください。".into());
        }
        save_samples(samples, &directory.join("samples.json"))
    }
}

/// Reads a loaded task page into `task.json`. Used by the browser and by the UI test host.
pub fn read_task_page(workspaces: &Workspaces, url: &str, html: &str) -> Result<(), String> {
    workspaces.store_task(&parse_task(url, html)?)
}
