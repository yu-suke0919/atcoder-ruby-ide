//! Test-only stdio transport. All execution and document behavior comes from the app library.
use atcoder_ruby_ide::{
    browser_target, fetch_page, http_client, read_task_page, ruby_info, Contests, DocumentStore,
    RubyLsp, RunEvent, RunRequest, Runner, Workspaces,
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
    let data = std::env::current_dir().unwrap().join("user-data");
    let workspaces = Workspaces::new(&data);
    let contests = Contests::new(&data);
    // Pages come from the test server; this host has no browser, so showing a task page
    // fetches it and reads it the way the app reads a loaded page.
    let origin = std::env::var("ATCODER_IDE_TEST_ORIGIN").unwrap_or_default();
    let page = |url: &str| {
        let client = http_client()?;
        fetch_page(&client, &url.replacen("https://atcoder.jp", &origin, 1), "")
    };
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
            "contest_list" => Ok(json!(contests.list()?)),
            "contest_register" => Ok(json!(
                contests.register(args["url"].as_str().ok_or("URLを指定してください")?, page)?
            )),
            "contest_set_hidden" => Ok(json!(contests.set_hidden(
                args["url"].as_str().ok_or("URLを指定してください")?,
                args["hidden"].as_bool().ok_or("hiddenを指定してください")?
            )?)),
            "task_open" => {
                let url = args["url"].as_str().ok_or("URLを指定してください")?;
                if workspaces.task(url)?.is_none() {
                    return Ok(Value::Null);
                }
                let label = args["label"].as_str().ok_or("ラベルを指定してください")?;
                let mut documents = documents.lock().unwrap();
                let revision = documents.revision();
                Ok(json!(workspaces.open(
                    url,
                    label,
                    revision,
                    &mut documents
                )?))
            }
            "task_save_cases" => {
                workspaces.save_cases(
                    args["url"].as_str().ok_or("URLを指定してください")?,
                    serde_json::from_value(args["cases"].clone()).map_err(|e| e.to_string())?,
                )?;
                Ok(Value::Null)
            }
            "home_open" => {
                let mut documents = documents.lock().unwrap();
                let revision = documents.revision();
                Ok(json!(workspaces.open_home(revision, &mut documents)?))
            }
            "home_save_cases" => {
                workspaces.save_home_cases(
                    serde_json::from_value(args["cases"].clone()).map_err(|e| e.to_string())?,
                )?;
                Ok(Value::Null)
            }
            "file_open" | "file_create" | "file_rename" | "file_delete" => {
                let text = |key: &str| args[key].as_str().ok_or(format!("{key}を指定してください"));
                let workspace = text("workspace")?;
                let mut documents = documents.lock().unwrap();
                match request.command.as_str() {
                    "file_open" => Ok(json!(workspaces.open_file(
                        workspace,
                        text("name")?,
                        &mut documents
                    )?)),
                    "file_create" => Ok(json!(workspaces.create_file(workspace, text("label")?)?)),
                    "file_rename" => {
                        workspaces.rename_file(
                            workspace,
                            text("from")?,
                            text("to")?,
                            &mut documents,
                        )?;
                        Ok(Value::Null)
                    }
                    _ => {
                        workspaces.delete_file(workspace, text("name")?, &documents)?;
                        Ok(Value::Null)
                    }
                }
            }
            "browser_task" => {
                let url = args["url"].as_str().ok_or("URLを指定してください")?;
                send(&sink, json!({"appEvent": "browser-url", "payload": url}));
                if workspaces.task(url)?.is_none() {
                    let error = page(url)
                        .and_then(|html| read_task_page(&workspaces, url, &html))
                        .err();
                    send(
                        &sink,
                        json!({"appEvent": "task-page", "payload": {"url": url, "error": error}}),
                    );
                }
                Ok(Value::Null)
            }
            // There are no pages here: the shown URL changes as the real browser reports it.
            "browser_home" => {
                let url = args["url"].as_str().unwrap_or("https://atcoder.jp/");
                send(&sink, json!({"appEvent": "browser-url", "payload": url}));
                Ok(Value::Null)
            }
            "browser_open" => {
                let url = browser_target(args["url"].as_str().unwrap_or_default())?;
                send(
                    &sink,
                    json!({"appEvent": "browser-url", "payload": url.as_str()}),
                );
                Ok(Value::Null)
            }
            "browser_layout"
            | "browser_visible"
            | "browser_close_tasks"
            | "browser_history"
            | "browser_reload" => Ok(Value::Null),
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
