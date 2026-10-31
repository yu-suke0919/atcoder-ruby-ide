mod collections;
mod commands;
mod comparison;
mod document;
mod files;
mod library;
mod lsp;
mod presentation;
mod process;
mod runner;
mod samples;

pub use collections::{
    parse_collection, Collection, CollectionLibrary, CollectionTask, CollectionView,
    RegisteredCollection, RepairedCollectionTask,
};
pub use commands::{document_save_path, prepare_document_run, ruby_info, RubyInfo};
pub use comparison::{decode_output, first_difference, OutputDifference};
pub use document::{DocumentResult, DocumentStore};
pub use library::{parse_problem, Problem, ProblemLibrary, ProblemWorkspace};
pub use lsp::{LspInfo, RubyLsp};
pub use presentation::StatementPart;
pub use runner::{Output, PreparedRun, RunRequest, RunResult, Runner};
pub use samples::{load_samples, save_samples, ProblemSample, SampleCase, SampleResult};

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
