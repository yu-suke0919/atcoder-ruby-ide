// Ruby runs only in the agent, on Linux (WSL); the Windows app relays to it
// (docs/architecture.md#wslのエージェント).
#[cfg(unix)]
pub mod agent;
mod agent_client;
#[cfg(unix)]
mod commands;
mod comparison;
mod contests;
mod document;
mod files;
mod input_code;
#[cfg(unix)]
mod lsp;
mod navigation;
#[cfg(unix)]
mod process;
#[cfg(unix)]
mod runner;
mod samples;
mod solutions;
mod submissions;
mod task;
pub mod wsl;

pub use agent_client::AgentClient;
#[cfg(unix)]
pub use commands::{ruby_info, RubyInfo};
pub use comparison::{decode_output, first_difference, OutputDifference};
pub use contests::{
    contest_top, fetch_page, http_client, parse_task_list, unix_now, Contest, ContestKey,
    ContestTask, Contests, RegisteredContest,
};
pub use document::{DocumentResult, DocumentStore};
pub use input_code::{input_code, reading_forms};
#[cfg(unix)]
pub use lsp::{LspInfo, RubyLsp};
pub use navigation::{
    browser_target, is_allowed, is_rurima_page, rurima_page, rurima_target, ALLOWED_ORIGINS,
    RURIMA_HOME, RURIMA_ORIGINS,
};
#[cfg(unix)]
pub use runner::{Output, PreparedRun, RunRequest, RunResult, Runner};
pub use samples::{load_samples, save_samples, ProblemSample, SampleCase, Samples};
pub use submissions::{submissions_page, SubmissionUpdate, Submissions, TaskResult};
pub use task::{
    is_task_page, parse_task, read_task_page, HomeWorkspace, Task, TaskWorkspace, Workspaces,
};

#[cfg(unix)]
#[derive(Clone, serde::Serialize)]
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
