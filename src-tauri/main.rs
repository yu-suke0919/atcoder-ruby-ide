#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use atcoder_ruby_ide::{
    load_samples, save_samples, DocumentResult, DocumentStore, Problem, ProblemLibrary,
    ProblemWorkspace, RunEvent, RunRequest, Runner, SampleCase, SampleResult,
};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

struct AppState {
    runner: Arc<Runner>,
    documents: Arc<Mutex<DocumentStore>>,
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

#[derive(Serialize)]
struct RubyInfo {
    available: bool,
    version: String,
    path: String,
}

#[tauri::command]
async fn ruby_info(app: tauri::AppHandle) -> Result<RubyInfo, String> {
    let path = ruby_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let probe = Runner::new(Duration::from_secs(5), 16384);
        let result = probe
            .prepare(RunRequest {
                code: "puts RUBY_DESCRIPTION".into(),
                ..Default::default()
            })?
            .execute(&path, |_| {})?;
        if result.status != "completed" {
            return Err(format!("Ruby を起動できません: {}", result.stderr));
        }
        Ok(RubyInfo {
            available: true,
            version: result.stdout.trim().into(),
            path: path.to_string_lossy().into(),
        })
    })
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
    on_event: Channel<RunEvent>,
) -> Result<(), String> {
    let cwd = state
        .documents
        .lock()
        .unwrap()
        .path()
        .and_then(|path| path.parent())
        .map(|path| path.to_owned());
    let prepared = state.runner.prepare(RunRequest {
        code,
        stdin,
        expected_output,
        cwd,
    })?;
    let ruby = ruby_path(&app)?;
    std::thread::Builder::new()
        .name("ruby-runner".into())
        .spawn(move || {
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
async fn document_open(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<DocumentResult, String> {
    let documents = Arc::clone(&state.documents);
    tauri::async_runtime::spawn_blocking(move || {
        let chosen = window
            .app_handle()
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Ruby ファイルを開く")
            .add_filter("Ruby", &["rb"])
            .blocking_pick_file();
        let path = chosen
            .map(|file| file.into_path().map_err(|e| e.to_string()))
            .transpose()?;
        documents.lock().unwrap().open(path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn document_save(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    code: String,
    save_as: bool,
) -> Result<DocumentResult, String> {
    let documents = Arc::clone(&state.documents);
    tauri::async_runtime::spawn_blocking(move || {
        let current = documents.lock().unwrap().path().map(|path| path.to_owned());
        let chosen = if !save_as && current.is_some() {
            current
        } else {
            let mut dialog = window
                .app_handle()
                .dialog()
                .file()
                .set_parent(&window)
                .set_title("Ruby ファイルを保存")
                .add_filter("Ruby", &["rb"]);
            if let Some(current) = current.as_ref() {
                if let Some(parent) = current.parent() {
                    dialog = dialog.set_directory(parent);
                }
                dialog =
                    dialog.set_file_name(current.file_name().unwrap_or_default().to_string_lossy());
            } else {
                dialog = dialog.set_file_name("solution.rb");
            }
            dialog
                .blocking_save_file()
                .map(|file| file.into_path().map_err(|e| e.to_string()))
                .transpose()?
        };
        documents.lock().unwrap().save(&code, chosen)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn document_new(state: tauri::State<'_, AppState>) -> Result<(), String> {
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

#[tauri::command]
async fn samples_open(window: tauri::WebviewWindow) -> Result<SampleResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = window
            .app_handle()
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("サンプルを開く")
            .add_filter("JSON", &["json"])
            .blocking_pick_file()
            .map(|file| file.into_path().map_err(|e| e.to_string()))
            .transpose()?;
        load_samples(selected)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn samples_save(
    window: tauri::WebviewWindow,
    cases: Vec<SampleCase>,
) -> Result<SampleResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = window
            .app_handle()
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("サンプルを保存")
            .add_filter("JSON", &["json"])
            .set_file_name("samples.cases.json")
            .blocking_save_file()
            .map(|file| file.into_path().map_err(|e| e.to_string()))
            .transpose()?;
        save_samples(cases, selected)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn problem_library(app: &tauri::AppHandle) -> Result<ProblemLibrary, String> {
    Ok(ProblemLibrary::new(
        app.path().app_local_data_dir().map_err(|e| e.to_string())?,
    ))
}

#[tauri::command]
async fn problem_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<ProblemWorkspace, String> {
    let library = problem_library(&app)?;
    let documents = Arc::clone(&state.documents);
    let document_revision = documents.lock().unwrap().revision();
    tauri::async_runtime::spawn_blocking(move || {
        let problem = library.problem(&url, false)?;
        library.open_workspace(problem, document_revision, &mut documents.lock().unwrap())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn problem_refresh(app: tauri::AppHandle, url: String) -> Result<Problem, String> {
    let library = problem_library(&app)?;
    tauri::async_runtime::spawn_blocking(move || library.problem(&url, true))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn problem_save_cases(
    app: tauri::AppHandle,
    url: String,
    cases: Vec<SampleCase>,
) -> Result<SampleResult, String> {
    let library = problem_library(&app)?;
    tauri::async_runtime::spawn_blocking(move || library.save_cases(&url, cases))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn confirm_discard(window: tauri::WebviewWindow) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        window
            .app_handle()
            .dialog()
            .message("保存していない変更を破棄しますか？")
            .title("未保存の変更")
            .parent(&window)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "破棄して続ける".into(),
                "キャンセル".into(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|e| e.to_string())
}

fn main() {
    let mut context = tauri::generate_context!();
    #[cfg(windows)]
    if let Ok(port) = std::env::var("ATCODER_IDE_TEST_PORT") {
        let port: u16 = port
            .parse()
            .expect("ATCODER_IDE_TEST_PORT must be a port number");
        for window in &mut context.config_mut().app.windows {
            window.additional_browser_args = Some(format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"));
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            runner: Runner::new(Duration::from_secs(5), 1048576),
            documents: Arc::new(Mutex::new(DocumentStore::default())),
        })
        .invoke_handler(tauri::generate_handler![
            ruby_info,
            run_ruby,
            stop_ruby,
            document_open,
            document_save,
            document_new,
            samples_open,
            samples_save,
            confirm_discard,
            problem_open,
            problem_refresh,
            problem_save_cases
        ])
        .build(context)
        .expect("アプリを起動できませんでした")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app.state::<AppState>();
                state.runner.stop();
                state.runner.wait_idle();
            }
        });
}
