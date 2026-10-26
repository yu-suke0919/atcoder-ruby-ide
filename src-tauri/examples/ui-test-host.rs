//! Test-only stdio transport. All execution and document behavior comes from the app library.
use atcoder_ruby_ide::{load_samples, save_samples, DocumentStore, RunEvent, RunRequest, Runner};
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

impl Drop for RunnerCleanup<'_> {
    fn drop(&mut self) {
        self.runner.stop();
        self.runner.wait_idle();
        // The reservation is released before the terminal event is sent.
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
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
    on_event: u64,
}

fn main() {
    let ruby: PathBuf = std::env::var_os("RUBY_PATH")
        .unwrap_or_else(|| "ruby".into())
        .into();
    let runner = Runner::new(Duration::from_secs(5), 1048576);
    let mut cleanup = RunnerCleanup {
        runner: &runner,
        worker: None,
    };
    let mut documents = DocumentStore::default();
    let sink = Arc::new(Mutex::new(io::stdout()));
    for line in io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line.unwrap()).unwrap();
        let args = request.args;
        let result: Result<Value, String> = (|| match request.command.as_str() {
            "ruby_info" => {
                let result = Runner::new(Duration::from_secs(3), 16384)
                    .prepare(RunRequest {
                        code: "puts RUBY_DESCRIPTION".into(),
                        ..Default::default()
                    })?
                    .execute(&ruby, |_| {})?;
                if result.status != "completed" {
                    return Err(result.stderr);
                }
                Ok(json!({"available": true, "version": result.stdout.trim(), "path": ruby}))
            }
            "run_ruby" => {
                let args: RunArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let prepared = runner.prepare(RunRequest {
                    code: args.code,
                    stdin: args.stdin,
                    expected_output: args.expected_output,
                    cwd: documents
                        .path()
                        .and_then(|p| p.parent())
                        .map(|p| p.to_owned()),
                })?;
                let ruby = ruby.clone();
                let output = Arc::clone(&sink);
                if let Some(worker) = cleanup.worker.take() {
                    let _ = worker.join();
                }
                cleanup.worker = Some(std::thread::spawn(move || {
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
            "document_open" => {
                let path: Option<PathBuf> =
                    serde_json::from_value(args["selected"].clone()).map_err(|e| e.to_string())?;
                Ok(json!(documents.open(path)?))
            }
            "document_save" => {
                let path = if args["saveAs"] != true && documents.path().is_some() {
                    documents.path().map(|p| p.to_owned())
                } else {
                    serde_json::from_value(args["selected"].clone()).map_err(|e| e.to_string())?
                };
                Ok(json!(documents.save(
                    args["code"].as_str().ok_or("コードを指定してください")?,
                    path
                )?))
            }
            "document_new" => {
                documents.reset();
                Ok(Value::Null)
            }
            "samples_open" => Ok(json!(load_samples(
                serde_json::from_value(args["selected"].clone()).map_err(|e| e.to_string())?
            )?)),
            "samples_save" => Ok(json!(save_samples(
                serde_json::from_value(args["cases"].clone()).map_err(|e| e.to_string())?,
                serde_json::from_value(args["selected"].clone()).map_err(|e| e.to_string())?
            )?)),
            "shutdown" => {
                runner.stop();
                runner.wait_idle();
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
