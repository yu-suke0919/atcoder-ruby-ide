//! The agent's side of the channel: Ruby and Ruby LSP requests, one JSON object per line.
//! See docs/architecture.md#wslのエージェント.
use crate::{ruby_info, RubyLsp, RunEvent, RunRequest, Runner};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

type Sink = Arc<Mutex<Box<dyn Write + Send>>>;

fn send(sink: &Sink, value: Value) {
    let mut sink = sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // The app may be gone; there is nobody left to tell.
    let _ = writeln!(sink, "{value}").and_then(|_| sink.flush());
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
    #[serde(rename = "problemMemoryLimitMiB")]
    problem_memory_limit_mib: Option<u32>,
}

#[derive(Deserialize)]
struct CompleteArgs {
    code: String,
    line: u32,
    character: u32,
}

pub struct Agent {
    ruby: PathBuf,
    resources: PathBuf,
    runner: Arc<Runner>,
    lsp: Arc<RubyLsp>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Agent {
    /// `default_timeout` applies to runs whose problem has no known time limit.
    pub fn new(ruby: PathBuf, resources: PathBuf, default_timeout: Duration) -> Self {
        Self {
            ruby,
            resources,
            runner: Runner::new(default_timeout, 1048576),
            lsp: Arc::new(RubyLsp::default()),
            worker: Mutex::new(None),
        }
    }

    /// Answers requests until the input ends or `shutdown` arrives, then stops everything.
    pub fn serve(&self, input: impl BufRead, output: impl Write + Send + 'static) {
        let sink: Sink = Arc::new(Mutex::new(Box::new(output)));
        // Ruby LSP can take seconds to start; its requests wait on their own thread so that
        // stopping a run is never stuck behind them.
        let (lsp_requests, queue) = mpsc::channel::<Request>();
        let lsp = Arc::clone(&self.lsp);
        let (ruby, resources) = (self.ruby.clone(), self.resources.clone());
        let lsp_sink = Arc::clone(&sink);
        let lsp_worker = std::thread::spawn(move || {
            for request in queue {
                let result = match request.command.as_str() {
                    "lsp_start" => lsp.start(&ruby, &resources).map(|info| json!(info)),
                    "lsp_complete" => serde_json::from_value::<CompleteArgs>(request.args)
                        .map_err(|e| e.to_string())
                        .and_then(|args| lsp.complete(&args.code, args.line, args.character)),
                    _ => Ok(json!(lsp.stop())),
                };
                send(&lsp_sink, answer(request.id, result));
            }
        });
        for line in input.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let request: Request = match serde_json::from_str(&line) {
                Ok(request) => request,
                Err(error) => {
                    send(&sink, json!({"id": null, "error": error.to_string()}));
                    continue;
                }
            };
            if request.command.starts_with("lsp_") {
                let _ = lsp_requests.send(request);
                continue;
            }
            let id = request.id;
            let shutdown = request.command == "shutdown";
            let result = self.handle(request, &sink);
            send(&sink, answer(id, result));
            if shutdown {
                break;
            }
        }
        // Queued LSP requests finish on their own thread; stopping does not wait for them.
        drop(lsp_requests);
        drop(lsp_worker);
        self.stop_all();
    }

    /// Stops the run and Ruby LSP with their process groups. Used when the app goes away.
    pub fn stop_all(&self) {
        self.runner.stop();
        self.runner.wait_idle();
        self.lsp.stop();
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }

    fn handle(&self, request: Request, sink: &Sink) -> Result<Value, String> {
        match request.command.as_str() {
            "ruby_info" => Ok(json!(ruby_info(&self.ruby)?)),
            "run_ruby" => {
                let args: RunArgs =
                    serde_json::from_value(request.args).map_err(|e| e.to_string())?;
                let prepared = self.runner.prepare(RunRequest {
                    code: args.code,
                    stdin: args.stdin,
                    expected_output: args.expected_output,
                    tolerance: args.tolerance,
                    problem_time_limit_ms: args.problem_time_limit_ms,
                    problem_memory_limit_mib: args.problem_memory_limit_mib,
                })?;
                let mut worker = self.worker.lock().unwrap();
                // The previous run released its reservation before its last event.
                if let Some(previous) = worker.take() {
                    let _ = previous.join();
                }
                let (ruby, sink, run) = (self.ruby.clone(), Arc::clone(sink), request.id);
                *worker = Some(std::thread::spawn(move || {
                    let event = |event: RunEvent| json!({"run": run, "event": event});
                    send(
                        &sink,
                        event(RunEvent::Started {
                            execution_limit_ms: prepared.execution_limit_ms(),
                        }),
                    );
                    let chunks = Arc::clone(&sink);
                    let result = prepared.execute(&ruby, move |chunk| {
                        send(
                            &chunks,
                            json!({"run": run, "event": RunEvent::Output { stream: chunk.stream, bytes: chunk.bytes }}),
                        )
                    });
                    send(
                        &sink,
                        event(match result {
                            Ok(result) => RunEvent::Completed { result },
                            Err(message) => RunEvent::Failed { message },
                        }),
                    );
                }));
                Ok(Value::Null)
            }
            "stop_ruby" => Ok(json!(self.runner.stop())),
            "shutdown" => Ok(Value::Null),
            other => Err(format!("Unknown agent command: {other}")),
        }
    }
}

fn answer(id: u64, result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({"id": id, "value": value}),
        Err(error) => json!({"id": id, "error": error}),
    }
}
