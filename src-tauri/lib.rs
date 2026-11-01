mod commands;
mod comparison;
mod contests;
mod document;
mod files;
mod input_code;
mod lsp;
mod navigation;
mod process;
mod runner;
mod samples;
mod solutions;
mod task;

pub use commands::{ruby_info, RubyInfo};
pub use comparison::{decode_output, first_difference, OutputDifference};
pub use contests::{
    fetch_page, http_client, parse_task_list, Contest, ContestKey, ContestTask, Contests,
    RegisteredContest,
};
pub use document::{DocumentResult, DocumentStore};
pub use input_code::input_code;
pub use lsp::{LspInfo, RubyLsp};
pub use navigation::{browser_target, is_allowed, ALLOWED_ORIGINS};
pub use runner::{Output, PreparedRun, RunRequest, RunResult, Runner};
pub use samples::{load_samples, save_samples, ProblemSample, SampleCase, Samples};
pub use task::{
    is_task_page, parse_task, read_task_page, HomeWorkspace, Task, TaskWorkspace, Workspaces,
};

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum RunEvent {
    Started {
        execution_limit_ms: u64,
    },
    Output {
        stream: &'static str,
        bytes: Vec<u8>,
    },
    Completed {
        result: RunResult,
    },
    Failed {
        message: String,
    },
}
