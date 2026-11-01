#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod browser;

use atcoder_ruby_ide::{
    fetch_page, http_client, Contest, Contests, DocumentResult, DocumentStore, HomeWorkspace,
    LspInfo, RegisteredContest, RubyInfo, RubyLsp, RunEvent, RunRequest, Runner, SampleCase,
    TaskWorkspace, Workspaces,
};
use browser::Browser;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, Manager};

struct AppState {
    runner: Arc<Runner>,
    documents: Arc<Mutex<DocumentStore>>,
    contest_lock: Arc<Mutex<()>>,
    lsp: Arc<RubyLsp>,
}

fn lsp_resources(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        app.path()
            .resolve("ruby-lsp", tauri::path::BaseDirectory::Resource)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/ruby-lsp"))
    }
}

#[tauri::command]
async fn lsp_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<LspInfo, String> {
    let lsp = Arc::clone(&state.lsp);
    let ruby = ruby_path(&app)?;
    let resources = lsp_resources(&app)?;
    tauri::async_runtime::spawn_blocking(move || lsp.start(&ruby, &resources))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn lsp_complete(
    state: tauri::State<'_, AppState>,
    code: String,
    line: u32,
    character: u32,
) -> Result<serde_json::Value, String> {
    let lsp = Arc::clone(&state.lsp);
    tauri::async_runtime::spawn_blocking(move || lsp.complete(&code, line, character))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn lsp_stop(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let lsp = Arc::clone(&state.lsp);
    tauri::async_runtime::spawn_blocking(move || lsp.stop())
        .await
        .map_err(|e| e.to_string())
}

fn ruby_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        app.path()
            .resolve("ruby/bin/ruby.exe", tauri::path::BaseDirectory::Resource)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(std::env::var_os("RUBY_PATH")
            .unwrap_or_else(|| "ruby".into())
            .into())
    }
}

#[tauri::command]
async fn ruby_info(app: tauri::AppHandle) -> Result<RubyInfo, String> {
    let path = ruby_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || atcoder_ruby_ide::ruby_info(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn run_ruby(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    code: String,
    stdin: String,
    expected_output: Option<String>,
    tolerance: Option<f64>,
    problem_time_limit_ms: Option<u32>,
    on_event: Channel<RunEvent>,
) -> Result<(), String> {
    let prepared = state.runner.prepare(RunRequest {
        code,
        stdin,
        expected_output,
        tolerance,
        problem_time_limit_ms,
    })?;
    let ruby = ruby_path(&app)?;
    std::thread::Builder::new()
        .name("ruby-runner".into())
        .spawn(move || {
            let _ = on_event.send(RunEvent::Started {
                execution_limit_ms: prepared.execution_limit_ms(),
            });
            let output = on_event.clone();
            let result = prepared.execute(&ruby, move |chunk| {
                let _ = output.send(RunEvent::Output {
                    stream: chunk.stream,
                    bytes: chunk.bytes,
                });
            });
            let event = match result {
                Ok(result) => RunEvent::Completed { result },
                Err(message) => RunEvent::Failed { message },
            };
            let _ = on_event.send(event);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn stop_ruby(state: tauri::State<'_, AppState>) -> bool {
    state.runner.stop()
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
    let runner = Arc::clone(&state.runner);
    let documents = Arc::clone(&state.documents);
    tauri::async_runtime::spawn_blocking(move || {
        runner.stop();
        runner.wait_idle();
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

#[tauri::command]
async fn task_save_cases(
    app: tauri::AppHandle,
    url: String,
    cases: Vec<SampleCase>,
) -> Result<(), String> {
    let workspaces = Workspaces::new(data_dir(&app)?);
    tauri::async_runtime::spawn_blocking(move || workspaces.save_cases(&url, cases))
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

#[tauri::command]
async fn home_save_cases(app: tauri::AppHandle, cases: Vec<SampleCase>) -> Result<(), String> {
    let workspaces = Workspaces::new(data_dir(&app)?);
    tauri::async_runtime::spawn_blocking(move || workspaces.save_home_cases(cases))
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
        .manage(AppState {
            runner: Runner::new(Duration::from_secs(5), 1048576),
            documents: Arc::new(Mutex::new(DocumentStore::default())),
            contest_lock: Arc::new(Mutex::new(())),
            lsp: Arc::new(RubyLsp::default()),
        })
        .manage(Browser::default())
        .setup(move |app| {
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
            task_save_cases,
            home_open,
            home_save_cases,
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
                let state = app.state::<AppState>();
                state.runner.stop();
                state.runner.wait_idle();
                state.lsp.stop();
            }
        });
}
