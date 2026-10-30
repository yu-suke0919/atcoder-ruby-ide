#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use atcoder_ruby_ide::{
    document_save_path, load_samples, prepare_document_run, save_samples, CollectionLibrary,
    CollectionView, DocumentResult, DocumentStore, LspInfo, Problem, ProblemLibrary,
    ProblemWorkspace, RegisteredCollection, RepairedCollectionTask, RubyInfo, RubyLsp, RunEvent,
    Runner, SampleCase, SampleResult,
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

struct AppState {
    runner: Arc<Runner>,
    documents: Arc<Mutex<DocumentStore>>,
    collection_lock: Arc<Mutex<()>>,
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
    on_event: Channel<RunEvent>,
) -> Result<(), String> {
    let prepared = prepare_document_run(
        &state.runner,
        &state.documents.lock().unwrap(),
        code,
        stdin,
        expected_output,
    )?;
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
        let chosen = document_save_path(current, save_as, |current| {
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
                .transpose()
        })?;
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

fn collection_library(app: &tauri::AppHandle) -> Result<CollectionLibrary, String> {
    Ok(CollectionLibrary::new(
        app.path().app_local_data_dir().map_err(|e| e.to_string())?,
    ))
}

#[tauri::command]
async fn collection_list(app: tauri::AppHandle) -> Result<Vec<CollectionView>, String> {
    let library = collection_library(&app)?;
    tauri::async_runtime::spawn_blocking(move || library.list())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn collection_register(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<RegisteredCollection, String> {
    let library = collection_library(&app)?;
    let lock = Arc::clone(&state.collection_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap();
        library.register(&url)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn collection_fetch_task(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
    task: String,
) -> Result<CollectionView, String> {
    let library = collection_library(&app)?;
    let lock = Arc::clone(&state.collection_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap();
        library.fetch_task(&url, &task)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn collection_repair_task(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
    task: String,
) -> Result<RepairedCollectionTask, String> {
    let library = collection_library(&app)?;
    let lock = Arc::clone(&state.collection_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap();
        library.repair_task(&url, &task)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn collection_open_task(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
    task: String,
) -> Result<ProblemWorkspace, String> {
    let library = collection_library(&app)?;
    let documents = Arc::clone(&state.documents);
    let revision = documents.lock().unwrap().revision();
    tauri::async_runtime::spawn_blocking(move || {
        library.open_task(&url, &task, revision, &mut documents.lock().unwrap())
    })
    .await
    .map_err(|e| e.to_string())?
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
        library.open_problem(&url, document_revision, &documents)
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
            collection_lock: Arc::new(Mutex::new(())),
            lsp: Arc::new(RubyLsp::default()),
        })
        .invoke_handler(tauri::generate_handler![
            ruby_info,
            lsp_start,
            lsp_complete,
            lsp_stop,
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
            problem_save_cases,
            collection_list,
            collection_register,
            collection_fetch_task,
            collection_repair_task,
            collection_open_task
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
