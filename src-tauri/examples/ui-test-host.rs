//! Test-only stdio transport. All execution and document behavior comes from the app library.
use atcoder_ruby_ide::{
    ruby_info, CollectionLibrary, DocumentStore, ProblemLibrary, RubyLsp, RunEvent, RunRequest,
    Runner,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Sink = Arc<Mutex<io::Stdout>>;
fn send(sink: &Sink, value: Value) {
    let mut sink = sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Err(error) = writeln!(sink, "{value}").and_then(|_| sink.flush()) {
        eprintln!("Failed to write UI test response: {error}");
    }
}

struct RunnerCleanup<'a> {
    runner: &'a Runner,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl RunnerCleanup<'_> {
    fn stop_and_wait(&mut self) {
        self.runner.stop();
        self.runner.wait_idle();
        // The reservation is released before the terminal event is sent.
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for RunnerCleanup<'_> {
    fn drop(&mut self) {
        self.stop_and_wait();
    }
}
#[derive(Deserialize)]
struct Request {
    id: u64,
    command: String,
    #[serde(default)]
    args: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunArgs {
    code: String,
    stdin: String,
    expected_output: Option<String>,
    tolerance: Option<f64>,
    problem_time_limit_ms: Option<u32>,
    on_event: u64,
}

fn main() {
    let ruby: PathBuf = std::env::var_os("RUBY_PATH")
        .unwrap_or_else(|| "ruby".into())
        .into();
    let timeout_ms = std::env::var("ATCODER_IDE_UI_TIMEOUT_MS")
        .map(|value| {
            value
                .parse::<u64>()
                .expect("ATCODER_IDE_UI_TIMEOUT_MS must be 1..=5000")
        })
        .unwrap_or(5000);
    assert!(
        (1..=5000).contains(&timeout_ms),
        "ATCODER_IDE_UI_TIMEOUT_MS must be 1..=5000"
    );
    let runner = Runner::new(Duration::from_millis(timeout_ms), 1048576);
    let lsp = RubyLsp::default();
    let mut cleanup = RunnerCleanup {
        runner: &runner,
        worker: None,
    };
    let documents = Mutex::new(DocumentStore::default());
    let library = ProblemLibrary::new(std::env::current_dir().unwrap().join("user-data"));
    let collections = CollectionLibrary::new(std::env::current_dir().unwrap().join("user-data"));
    let sink = Arc::new(Mutex::new(io::stdout()));
    for line in io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line.unwrap()).unwrap();
        let args = request.args;
        let result: Result<Value, String> = (|| match request.command.as_str() {
            "lsp_start" => Ok(json!(lsp.start(
                &ruby,
                &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/ruby-lsp")
            )?)),
            "lsp_complete" => Ok(lsp.complete(
                args["code"].as_str().ok_or("コードがありません")?,
                serde_json::from_value(args["line"].clone()).map_err(|e| e.to_string())?,
                serde_json::from_value(args["character"].clone()).map_err(|e| e.to_string())?,
            )?),
            "lsp_stop" => Ok(json!(lsp.stop())),
            "ruby_info" => Ok(json!(ruby_info(&ruby)?)),
            "run_ruby" => {
                let args: RunArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let prepared = runner.prepare(RunRequest {
                    code: args.code,
                    stdin: args.stdin,
                    expected_output: args.expected_output,
                    tolerance: args.tolerance,
                    problem_time_limit_ms: args.problem_time_limit_ms,
                })?;
                let ruby = ruby.clone();
                let output = Arc::clone(&sink);
                if let Some(worker) = cleanup.worker.take() {
                    let _ = worker.join();
                }
                cleanup.worker = Some(std::thread::spawn(move || {
                    send(
                        &output,
                        json!({ "channel": args.on_event, "event": RunEvent::Started { execution_limit_ms: prepared.execution_limit_ms() } }),
                    );
                    let chunks = Arc::clone(&output);
                    let result = prepared.execute(&ruby, move |chunk| send(&chunks, json!({
                            "channel": args.on_event,
                            "event": RunEvent::Output { stream: chunk.stream, bytes: chunk.bytes }
                        })));
                    let event = match result {
                        Ok(result) => RunEvent::Completed { result },
                        Err(message) => RunEvent::Failed { message },
                    };
                    send(&output, json!({"channel": args.on_event, "event": event}));
                }));
                Ok(Value::Null)
            }
            "stop_ruby" => Ok(json!(runner.stop())),
            "document_save" => {
                documents
                    .lock()
                    .unwrap()
                    .save(args["code"].as_str().ok_or("コードを指定してください")?)?;
                Ok(Value::Null)
            }
            "session_reset" => {
                cleanup.stop_and_wait();
                documents.lock().unwrap().reset();
                Ok(Value::Null)
            }
            "problem_open" => {
                let document_revision = documents.lock().unwrap().revision();
                Ok(json!(library.open_problem(
                    args["url"].as_str().ok_or("URLを指定してください")?,
                    document_revision,
                    || documents.lock().unwrap(),
                )?))
            }
            "collection_list" => Ok(json!(collections.list()?)),
            "collection_register" => Ok(json!(
                collections.register(args["url"].as_str().ok_or("URLを指定してください")?)?
            )),
            "collection_fetch_task" => Ok(json!(collections.fetch_task(
                args["url"].as_str().ok_or("URLを指定してください")?,
                args["task"].as_str().ok_or("問題を指定してください")?
            )?)),
            "collection_open_task" => {
                let mut documents = documents.lock().unwrap();
                Ok(json!(collections.open_task(
                    args["url"].as_str().ok_or("URLを指定してください")?,
                    args["task"].as_str().ok_or("問題を指定してください")?,
                    documents.revision(),
                    &mut documents
                )?))
            }
            "collection_repair_task" => Ok(json!(collections.repair_task(
                args["url"].as_str().ok_or("URLを指定してください")?,
                args["task"].as_str().ok_or("問題を指定してください")?
            )?)),
            "problem_refresh" => Ok(json!(
                library.problem(args["url"].as_str().ok_or("URLを指定してください")?, true)?
            )),
            "problem_save_cases" => Ok(json!(library.save_cases(
                args["url"].as_str().ok_or("URLを指定してください")?,
                serde_json::from_value(args["cases"].clone()).map_err(|e| e.to_string())?
            )?)),
            "shutdown" => {
                lsp.stop();
                cleanup.stop_and_wait();
                Ok(Value::Null)
            }
            other => Err(format!("Unknown test command: {other}")),
        })();
        match result {
            Ok(value) => send(&sink, json!({"id": request.id, "value": value})),
            Err(error) => send(&sink, json!({"id": request.id, "error": error})),
        }
        if request.command == "shutdown" {
            break;
        }
    }
}
