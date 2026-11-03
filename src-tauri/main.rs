#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod browser;

use atcoder_ruby_ide::{
    fetch_page, http_client, AgentClient, Contest, Contests, DocumentResult, DocumentStore,
    HomeWorkspace, RegisteredContest, Samples, TaskWorkspace, Workspaces,
};
use browser::Browser;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, Manager};

struct AppState {
    agent: Arc<AgentClient>,
    documents: Arc<Mutex<DocumentStore>>,
    contest_lock: Arc<Mutex<()>>,
}

/// Ruby and Ruby LSP run in the agent (docs/architecture.md#wslのエージェント). On Windows the
/// app's own WSL distribution is checked once per app run, and downloaded and registered when it is
/// missing or another version; on Linux the agent built next to the app runs the development Ruby.
fn agent(app: &tauri::AppHandle) -> AgentClient {
    #[cfg(windows)]
    {
        use atcoder_ruby_ide::wsl;
        use std::time::Duration;
        let resources = app
            .path()
            .resource_dir()
            .map(|dir| dir.join("wsl"))
            .map_err(|e| e.to_string());
        let location = app
            .path()
            .app_local_data_dir()
            .map(|dir| dir.join("wsl"))
            .map_err(|e| e.to_string());
        let ready = Mutex::new(false);
        let app = app.clone();
        AgentClient::new(move || {
            let mut ready = ready.lock().unwrap();
            if !*ready {
                let resources = resources.as_ref().map_err(String::clone)?;
                let location = location.as_ref().map_err(String::clone)?;
                let manifest: Value = serde_json::from_slice(
                    &std::fs::read(resources.join("runtime.json"))
                        .map_err(|e| format!("同梱物の情報を読めません: {e}"))?,
                )
                .map_err(|e| e.to_string())?;
                let field = |name: &str| {
                    manifest[name]
                        .as_str()
                        .ok_or(format!("Linuxの情報に{name}がありません。"))
                };
                let (url, sha256) = (field("url")?, field("sha256")?);
                wsl::ensure_distribution(
                    wsl::wsl,
                    |file| {
                        // The screen shows the download; a report per megabyte is enough.
                        let mut shown = 0;
                        wsl::download(
                            url,
                            sha256,
                            file,
                            Duration::from_secs(30),
                            |received, total| {
                                if received - shown >= 1 << 20 || Some(received) == total {
                                    shown = received;
                                    use tauri::Emitter;
                                    let _ = app.emit(
                                        "runtime-download",
                                        json!({"received": received, "total": total}),
                                    );
                                }
                            },
                        )
                    },
                    field("version")?,
                    location,
                    Duration::from_secs(120),
                )?;
                *ready = true;
            }
            Ok(wsl::agent_command(wsl::wsl()))
        })
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        AgentClient::new(|| {
            let agent = std::env::current_exe()
                .map_err(|e| e.to_string())?
                .with_file_name("atcoder-ruby-agent");
            let mut command = std::process::Command::new(agent);
            command
                .arg(std::env::var_os("RUBY_PATH").unwrap_or_else(|| "ruby".into()))
                .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/ruby-lsp"));
            Ok(command)
        })
    }
}

/// Runs a blocking agent request off the main thread.
async fn ask(state: &AppState, command: &'static str, args: Value) -> Result<Value, String> {
    let agent = Arc::clone(&state.agent);
    tauri::async_runtime::spawn_blocking(move || agent.request(command, args))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn lsp_start(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    ask(&state, "lsp_start", Value::Null).await
}

#[tauri::command]
async fn lsp_complete(
    state: tauri::State<'_, AppState>,
    code: String,
    line: u32,
    character: u32,
) -> Result<Value, String> {
    ask(
        &state,
        "lsp_complete",
        json!({"code": code, "line": line, "character": character}),
    )
    .await
}

#[tauri::command]
async fn lsp_stop(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    ask(&state, "lsp_stop", Value::Null).await
}

#[tauri::command]
async fn ruby_info(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    ask(&state, "ruby_info", Value::Null).await
}

#[tauri::command]
async fn run_ruby(
    state: tauri::State<'_, AppState>,
    code: String,
    stdin: String,
    expected_output: Option<String>,
    tolerance: Option<f64>,
    problem_time_limit_ms: Option<u32>,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let agent = Arc::clone(&state.agent);
    let args = json!({
        "code": code,
        "stdin": stdin,
        "expectedOutput": expected_output,
        "tolerance": tolerance,
        "problemTimeLimitMs": problem_time_limit_ms,
    });
    tauri::async_runtime::spawn_blocking(move || {
        agent.run(args, move |event| {
            let _ = on_event.send(event);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn stop_ruby(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    ask(&state, "stop_ruby", Value::Null).await
}

#[tauri::command]
async fn document_save(state: tauri::State<'_, AppState>, code: String) -> Result<(), String> {
    let documents = Arc::clone(&state.documents);
    tauri::async_runtime::spawn_blocking(move || documents.lock().unwrap().save(&code))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn session_reset(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let agent = Arc::clone(&state.agent);
    let documents = Arc::clone(&state.documents);
    tauri::async_runtime::spawn_blocking(move || {
        // Nothing to stop when the agent never started or cannot start.
        if agent.pid().is_some() {
            let _ = agent.request("stop_ruby", Value::Null);
        }
        agent.wait_idle();
        documents.lock().unwrap().reset();
    })
    .await
    .map_err(|e| e.to_string())
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
async fn contest_list(app: tauri::AppHandle) -> Result<Vec<Contest>, String> {
    let contests = Contests::new(data_dir(&app)?);
    tauri::async_runtime::spawn_blocking(move || contests.list())
        .await
        .map_err(|e| e.to_string())?
}

/// Registers a contest from its task list, fetched once with the browser's cookies.
#[tauri::command]
async fn contest_register(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<RegisteredContest, String> {
    let contests = Contests::new(data_dir(&app)?);
    let cookie = browser::cookies(&app).await?;
    let lock = Arc::clone(&state.contest_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap();
        let client = http_client()?;
        contests.register(&url, |page| {
            fetch_page(&client, browser::to_origin(page)?.as_str(), &cookie)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn contest_set_hidden(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
    hidden: bool,
) -> Result<Contest, String> {
    let contests = Contests::new(data_dir(&app)?);
    let lock = Arc::clone(&state.contest_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap();
        contests.set_hidden(&url, hidden)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens a task's workspace, or returns None while its page has not been read yet.
#[tauri::command]
async fn task_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
    label: String,
) -> Result<Option<TaskWorkspace>, String> {
    let workspaces = Workspaces::new(data_dir(&app)?);
    let documents = Arc::clone(&state.documents);
    let revision = documents.lock().unwrap().revision();
    tauri::async_runtime::spawn_blocking(move || {
        if workspaces.task(&url)?.is_none() {
            return Ok(None);
        }
        workspaces
            .open(&url, &label, revision, &mut documents.lock().unwrap())
            .map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves a workspace's samples: `home` or a task URL.
#[tauri::command]
async fn samples_save(
    app: tauri::AppHandle,
    workspace: String,
    samples: Samples,
) -> Result<(), String> {
    let workspaces = Workspaces::new(data_dir(&app)?);
    tauri::async_runtime::spawn_blocking(move || workspaces.save_samples(&workspace, samples))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn home_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<HomeWorkspace, String> {
    let workspaces = Workspaces::new(data_dir(&app)?);
    let documents = Arc::clone(&state.documents);
    let revision = documents.lock().unwrap().revision();
    tauri::async_runtime::spawn_blocking(move || {
        workspaces.open_home(revision, &mut documents.lock().unwrap())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// File commands take the workspace: `home` or a task URL.
#[tauri::command]
async fn file_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    workspace: String,
    name: String,
) -> Result<DocumentResult, String> {
    let workspaces = Workspaces::new(data_dir(&app)?);
    let documents = Arc::clone(&state.documents);
    tauri::async_runtime::spawn_blocking(move || {
        workspaces.open_file(&workspace, &name, &mut documents.lock().unwrap())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn file_create(
    app: tauri::AppHandle,
    workspace: String,
    label: String,
) -> Result<String, String> {
    let workspaces = Workspaces::new(data_dir(&app)?);
    tauri::async_runtime::spawn_blocking(move || workspaces.create_file(&workspace, &label))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn file_copy(
    app: tauri::AppHandle,
    workspace: String,
    name: String,
    label: String,
) -> Result<String, String> {
    let workspaces = Workspaces::new(data_dir(&app)?);
    tauri::async_runtime::spawn_blocking(move || workspaces.copy_file(&workspace, &name, &label))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn file_rename(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    workspace: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let workspaces = Workspaces::new(data_dir(&app)?);
    let documents = Arc::clone(&state.documents);
    tauri::async_runtime::spawn_blocking(move || {
        workspaces.rename_file(&workspace, &from, &to, &mut documents.lock().unwrap())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn file_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    workspace: String,
    name: String,
) -> Result<(), String> {
    let workspaces = Workspaces::new(data_dir(&app)?);
    let documents = Arc::clone(&state.documents);
    tauri::async_runtime::spawn_blocking(move || {
        workspaces.delete_file(&workspace, &name, &documents.lock().unwrap())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    // UI tests open a debugging port on Windows. Child webviews share the WebView2 environment,
    // so they need the same arguments.
    #[cfg(windows)]
    let browser_args = std::env::var("ATCODER_IDE_TEST_PORT").ok().map(|port| {
        let port: u16 = port
            .parse()
            .expect("ATCODER_IDE_TEST_PORT must be a port number");
        format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}")
    });
    #[cfg(not(windows))]
    let browser_args: Option<String> = None;
    let mut context = tauri::generate_context!();
    if let Some(args) = &browser_args {
        for window in &mut context.config_mut().app.windows {
            window.additional_browser_args = Some(args.clone());
        }
    }
    tauri::Builder::default()
        // Restores the window size, position and maximized state of the last run.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Browser::default())
        .setup(move |app| {
            app.manage(AppState {
                agent: Arc::new(agent(app.handle())),
                documents: Arc::new(Mutex::new(DocumentStore::default())),
                contest_lock: Arc::new(Mutex::new(())),
            });
            Browser::create_home(app, browser_args.clone())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ruby_info,
            lsp_start,
            lsp_complete,
            lsp_stop,
            run_ruby,
            stop_ruby,
            document_save,
            session_reset,
            contest_list,
            contest_register,
            contest_set_hidden,
            task_open,
            samples_save,
            home_open,
            file_open,
            file_create,
            file_copy,
            file_rename,
            file_delete,
            browser::browser_layout,
            browser::browser_visible,
            browser::browser_home,
            browser::browser_task,
            browser::browser_close_tasks,
            browser::browser_open,
            browser::browser_history,
            browser::browser_reload
        ])
        .build(context)
        .expect("アプリを起動できませんでした")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // The agent stops the run and Ruby LSP when its stdin closes.
                app.state::<AppState>().agent.shutdown();
            }
        });
}
