mod comparison;
mod document;
mod process;
mod runner;

pub use comparison::{compare_output, decode_output, first_difference, OutputDifference};
pub use document::{DocumentResult, DocumentStore};
pub use runner::{Output, PreparedRun, RunRequest, RunResult, Runner};

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RunEvent {
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
