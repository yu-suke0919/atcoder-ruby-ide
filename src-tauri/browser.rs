//! The AtCoder pages in the right column: one home page and one page per task of the selected
//! contest. Pages cannot call the app; the app reads a task page after it has loaded.
use atcoder_ruby_ide::{is_task_page, read_task_page, Workspaces};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::webview::NewWindowResponse;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};
use url::Url;

pub const HOME: &str = "home";
const ATCODER: &str = "https://atcoder.jp";

#[derive(Clone, Copy, Default, Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPage {
    pub url: String,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Browser {
    /// Task URL to webview label for the selected contest.
    tasks: Mutex<HashMap<String, String>>,
    shown: Mutex<String>,
    bounds: Mutex<Bounds>,
    hidden: Mutex<bool>,
    next: Mutex<u64>,
    args: Mutex<Option<String>>,
}

/// The origin pages are loaded from. UI tests point it at a local server; normal runs use AtCoder.
pub fn origin() -> String {
    std::env::var("ATCODER_IDE_TEST_ORIGIN").unwrap_or_else(|_| ATCODER.into())
}
pub fn to_origin(url: &str) -> Result<Url, String> {
    Url::parse(&url.replacen(ATCODER, &origin(), 1)).map_err(|e| e.to_string())
}
fn allowed(url: &Url) -> bool {
    let origin = Url::parse(&origin()).unwrap();
    url.scheme() == origin.scheme()
        && url.host_str() == origin.host_str()
        && url.port_or_known_default() == origin.port_or_known_default()
}

fn open_workspaces(app: &tauri::AppHandle) -> Result<Workspaces, String> {
    Ok(Workspaces::new(
        app.path().app_local_data_dir().map_err(|e| e.to_string())?,
    ))
}

/// Reads the loaded task page when its samples are not saved yet and tells the editor.
fn read_if_needed(webview: &tauri::Webview, task_url: String) {
    let app = webview.app_handle().clone();
    let Ok(workspaces) = open_workspaces(&app) else {
        return;
    };
    if workspaces.task(&task_url).ok().flatten().is_some() {
        return;
    }
    let read = webview.eval_with_callback("document.documentElement.outerHTML", move |json| {
        let html = serde_json::from_str::<String>(&json).unwrap_or_default();
        let (app, task_url) = (app.clone(), task_url.clone());
        std::thread::spawn(move || {
            let error = open_workspaces(&app)
                .and_then(|workspaces| read_task_page(&workspaces, &task_url, &html))
                .err();
            let _ = app.emit_to(
                "main",
                "task-page",
                TaskPage {
                    url: task_url,
                    error,
                },
            );
        });
    });
    if let Err(error) = read {
        eprintln!("cannot read the task page: {error}");
    }
}

fn builder(
    app: &tauri::AppHandle,
    label: &str,
    url: Url,
    task: Option<String>,
) -> WebviewBuilder<tauri::Wry> {
    let (app_for_window, label_for_window) = (app.clone(), label.to_string());
    let mut builder = WebviewBuilder::new(label, WebviewUrl::External(url))
        .on_navigation(allowed)
        .on_new_window(move |url, _| {
            // AtCoder links that open a new window stay in the same page; others are not opened.
            if allowed(&url) {
                if let Some(webview) = app_for_window.get_webview(&label_for_window) {
                    let _ = webview.navigate(url);
                }
            }
            NewWindowResponse::Deny
        });
    if let Some(task_url) = task {
        builder = builder.on_page_load(move |webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && is_task_page(&task_url, payload.url())
            {
                read_if_needed(&webview, task_url.clone());
            }
        });
    }
    let args = app.state::<Browser>().args.lock().unwrap().clone();
    if let Some(args) = args {
        builder = builder.additional_browser_args(&args);
    }
    builder
}

impl Browser {
    pub fn create_home(app: &tauri::App, args: Option<String>) -> tauri::Result<()> {
        let browser = app.state::<Browser>();
        *browser.args.lock().unwrap() = args;
        *browser.shown.lock().unwrap() = HOME.into();
        let window = app.get_window("main").expect("main window");
        let home = builder(
            app.handle(),
            HOME,
            to_origin(&format!("{ATCODER}/")).unwrap(),
            None,
        );
        window.add_child(
            home,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )?;
        Ok(())
    }

    /// Places the shown page over the browser column and hides the others.
    fn apply(&self, app: &tauri::AppHandle) {
        let shown = self.shown.lock().unwrap().clone();
        let hidden = *self.hidden.lock().unwrap();
        let bounds = *self.bounds.lock().unwrap();
        let labels: Vec<String> = std::iter::once(HOME.to_string())
            .chain(self.tasks.lock().unwrap().values().cloned())
            .collect();
        for label in labels {
            let Some(webview) = app.get_webview(&label) else {
                continue;
            };
            if label == shown && !hidden && bounds.width > 0.0 && bounds.height > 0.0 {
                let _ = webview.set_position(LogicalPosition::new(bounds.x, bounds.y));
                let _ = webview.set_size(LogicalSize::new(bounds.width, bounds.height));
                let _ = webview.show();
            } else {
                let _ = webview.hide();
            }
        }
    }
}

// The commands are async: on Windows, creating or changing a webview from a synchronous command,
// which runs on the main thread, deadlocks WebView2.
#[tauri::command]
pub async fn browser_layout(
    app: tauri::AppHandle,
    browser: tauri::State<'_, Browser>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    *browser.bounds.lock().unwrap() = Bounds {
        x,
        y,
        width,
        height,
    };
    browser.apply(&app);
    Ok(())
}

/// Hides every page while an in-app dialog covers the window.
#[tauri::command]
pub async fn browser_visible(
    app: tauri::AppHandle,
    browser: tauri::State<'_, Browser>,
    visible: bool,
) -> Result<(), String> {
    *browser.hidden.lock().unwrap() = !visible;
    browser.apply(&app);
    Ok(())
}

#[tauri::command]
pub async fn browser_home(
    app: tauri::AppHandle,
    browser: tauri::State<'_, Browser>,
    url: Option<String>,
) -> Result<(), String> {
    let home = app.get_webview(HOME).ok_or("ブラウザを準備できません。")?;
    home.navigate(to_origin(&url.unwrap_or_else(|| format!("{ATCODER}/")))?)
        .map_err(|e| e.to_string())?;
    *browser.shown.lock().unwrap() = HOME.into();
    browser.apply(&app);
    Ok(())
}

/// Shows the page of a task, creating it on first use. An already open page whose samples are
/// still missing is loaded again, since it may show a page from before the user logged in.
#[tauri::command]
pub async fn browser_task(
    app: tauri::AppHandle,
    browser: tauri::State<'_, Browser>,
    url: String,
) -> Result<(), String> {
    let existing = browser.tasks.lock().unwrap().get(&url).cloned();
    let label =
        match existing.and_then(|label| app.get_webview(&label).map(|webview| (label, webview))) {
            Some((label, webview)) => {
                if open_workspaces(&app)?.task(&url).ok().flatten().is_none() {
                    webview
                        .navigate(to_origin(&url)?)
                        .map_err(|e| e.to_string())?;
                }
                label
            }
            None => {
                let label = {
                    let mut next = browser.next.lock().unwrap();
                    *next += 1;
                    format!("task-{next}")
                };
                let window = app.get_window("main").ok_or("ウィンドウがありません。")?;
                window
                    .add_child(
                        builder(&app, &label, to_origin(&url)?, Some(url.clone())),
                        LogicalPosition::new(0.0, 0.0),
                        LogicalSize::new(1.0, 1.0),
                    )
                    .map_err(|e| e.to_string())?;
                browser.tasks.lock().unwrap().insert(url, label.clone());
                label
            }
        };
    *browser.shown.lock().unwrap() = label;
    browser.apply(&app);
    Ok(())
}

/// Closes the task pages of the previous contest.
#[tauri::command]
pub async fn browser_close_tasks(
    app: tauri::AppHandle,
    browser: tauri::State<'_, Browser>,
) -> Result<(), String> {
    for label in browser
        .tasks
        .lock()
        .unwrap()
        .drain()
        .map(|(_, label)| label)
    {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
    }
    *browser.shown.lock().unwrap() = HOME.into();
    browser.apply(&app);
    Ok(())
}

/// The browser's cookies for AtCoder, read from the home page. Async so WebView2 does not deadlock.
pub async fn cookies(app: &tauri::AppHandle) -> Result<String, String> {
    let home = app.get_webview(HOME).ok_or("ブラウザを準備できません。")?;
    let url = Url::parse(&origin()).map_err(|e| e.to_string())?;
    let cookies = tauri::async_runtime::spawn_blocking(move || home.cookies_for_url(url))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(cookies
        .iter()
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; "))
}
