use crate::{DocumentStore, PreparedRun, RunRequest, Runner};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[derive(Serialize)]
pub struct RubyInfo {
    pub version: String,
}

pub fn ruby_info(path: &Path) -> Result<RubyInfo, String> {
    let result = Runner::new(Duration::from_secs(5), 16384)
        .prepare(RunRequest {
            code: "puts RUBY_DESCRIPTION".into(),
            ..Default::default()
        })?
        .execute(path, |_| {})?;
    if result.status != "completed" {
        return Err(format!("Ruby を起動できません: {}", result.stderr));
    }
    Ok(RubyInfo {
        version: result.stdout.trim().into(),
    })
}

pub fn prepare_document_run(
    runner: &Arc<Runner>,
    documents: &DocumentStore,
    code: String,
    stdin: String,
    expected_output: Option<String>,
    tolerance: Option<f64>,
    problem_time_limit_ms: Option<u32>,
) -> Result<PreparedRun, String> {
    runner.prepare(RunRequest {
        code,
        stdin,
        expected_output,
        tolerance,
        problem_time_limit_ms,
        cwd: documents
            .path()
            .and_then(|path| path.parent())
            .map(Path::to_owned),
    })
}

pub fn document_save_path(
    current: Option<PathBuf>,
    save_as: bool,
    choose: impl FnOnce(Option<&Path>) -> Result<Option<PathBuf>, String>,
) -> Result<Option<PathBuf>, String> {
    if !save_as && current.is_some() {
        Ok(current)
    } else {
        choose(current.as_deref())
    }
}
