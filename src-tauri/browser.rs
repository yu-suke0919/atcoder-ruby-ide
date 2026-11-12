//! The AtCoder pages in the right column: one home page and one page per task of the selected
//! contest, which may also go to the origins added in the settings (D5). Pages cannot call the
//! app; the app reads a task page after it has loaded, and only AtCoder's pages.
use crate::rurima::{rurima_from_origin, RURIMA};
use atcoder_ruby_ide::{
    browser_origins, browser_target, contest_top, fetch_page, http_client, is_allowed, is_atcoder,
    is_task_page, read_task_page, submissions_page, unix_now, Contests, Submissions, Workspaces,
    ATCODER_ORIGIN,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::webview::NewWindowResponse;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};
use url::Url;

pub const HOME: &str = "home";

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
    /// Contests whose submission list is being fetched while a submission is judged (U5b).
    following: Mutex<HashSet<String>>,
    /// While a window of the screen (るりま D3, graph D4) is out: where the るりま window's page
    /// lies, empty for the graph. The screen draws the window around it, and the AtCoder pages
    /// are hidden behind a picture of them.
    cover: Mutex<Option<Bounds>>,
    /// The origins added in the settings, besides AtCoder (D5).
    origins: Mutex<Vec<String>>,
}

/// The origin pages are loaded from. UI tests point it at a local server; normal runs use AtCoder.
pub fn origin() -> String {
    std::env::var("ATCODER_IDE_TEST_ORIGIN").unwrap_or_else(|_| ATCODER_ORIGIN.into())
}
pub fn to_origin(url: &str) -> Result<Url, String> {
    Url::parse(&url.replacen(ATCODER_ORIGIN, &origin(), 1)).map_err(|e| e.to_string())
}
/// The real URL of a loaded page, undoing the UI tests' origin.
fn real_url(url: &Url) -> Url {
    let origin = origin();
    match url.as_str().strip_prefix(origin.trim_end_matches('/')) {
        Some(rest) if origin != ATCODER_ORIGIN => {
            Url::parse(&format!("{ATCODER_ORIGIN}{rest}")).ok()
        }
        _ => None,
    }
    .unwrap_or_else(|| url.clone())
}
/// Whether the pages may go to a URL: AtCoder or an origin added in the settings.
fn allowed(app: &tauri::AppHandle, url: &Url) -> bool {
    is_allowed(
        &real_url(url),
        &app.state::<Browser>().origins.lock().unwrap(),
    )
}

/// Tells the screen which URL the shown page, or the るりま window, has.
pub(crate) fn show_url(webview: &tauri::Webview, url: &Url) {
    if webview.label() == RURIMA {
        if let Some(url) = rurima_from_origin(url) {
            let _ = webview.emit_to("main", "rurima-url", url.as_str());
        }
        return;
    }
    let browser = webview.state::<Browser>();
    if *browser.shown.lock().unwrap() != webview.label() {
        return;
    }
    if allowed(webview.app_handle(), url) {
        let _ = webview.emit_to("main", "browser-url", real_url(url).as_str());
    }
}
fn shown(app: &tauri::AppHandle, browser: &Browser) -> Result<tauri::Webview, String> {
    let label = browser.shown.lock().unwrap().clone();
    app.get_webview(&label)
        .ok_or_else(|| "ブラウザを準備できません。".into())
}
fn show_current_url(app: &tauri::AppHandle, browser: &Browser) {
    if let Ok(webview) = shown(app, browser) {
        if let Ok(url) = webview.url() {
            show_url(&webview, &url);
        }
    }
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

/// How often a shown submission list with a judging submission is read again (U5a).
const JUDGING_READ_INTERVAL: Duration = Duration::from_secs(3);
/// How often and how long a hidden or left list is fetched while a submission is judged (U5b).
const JUDGING_FETCH_INTERVAL: Duration = Duration::from_secs(10);
const JUDGING_FETCH_LIMIT: Duration = Duration::from_secs(10 * 60);

fn send_submissions(
    app: &tauri::AppHandle,
    read: Result<atcoder_ruby_ide::SubmissionUpdate, String>,
) {
    let _ = match read {
        Ok(update) => app.emit_to("main", "submissions", &update),
        Err(error) => app.emit_to("main", "submissions", serde_json::json!({ "error": error })),
    };
}

/// Fetches the submission list `page` with the browser's cookies while a submission is judged,
/// after its webview hid or left the list (U5b). One contest is fetched by one thread at a time.
fn follow_submissions(app: &tauri::AppHandle, page: Url, since: Instant) {
    let Some(contest) = submissions_page(&page) else {
        return;
    };
    let browser = app.state::<Browser>();
    if !browser.following.lock().unwrap().insert(contest.clone()) {
        return;
    }
    let cookie = tauri::async_runtime::block_on(cookies(app)).unwrap_or_default();
    let fetch = || {
        let client = http_client()?;
        fetch_page(&client, to_origin(page.as_str())?.as_str(), &cookie)
    };
    if let Ok(root) = app.path().app_local_data_dir() {
        Submissions::new(root).follow_judging(
            page.as_str(),
            JUDGING_FETCH_INTERVAL,
            since + JUDGING_FETCH_LIMIT,
            fetch,
            |read| send_submissions(app, read),
        );
    }
    browser.following.lock().unwrap().remove(&contest);
}

/// Reads the shown submission list into the contest's submissions and tells the screen the colors.
/// While a submission is judging, AtCoder rewrites the list in place, so it is read again as long
/// as the webview is shown and still shows it; otherwise the list is fetched (U5b). `since` is when
/// the judging list was loaded, about when the submission was made.
fn read_submissions(webview: &tauri::Webview, since: Instant) {
    let app = webview.app_handle().clone();
    let label = webview.label().to_string();
    let read = webview.eval_with_callback("document.documentElement.outerHTML", move |json| {
        let html = serde_json::from_str::<String>(&json).unwrap_or_default();
        let (app, label) = (app.clone(), label.clone());
        std::thread::spawn(move || {
            let shown_list = || {
                app.get_webview(&label)
                    .and_then(|webview| webview.url().ok())
                    .map(|url| real_url(&url))
                    .filter(|url| submissions_page(url).is_some())
            };
            let Some(page) = shown_list() else {
                return;
            };
            let result = app
                .path()
                .app_local_data_dir()
                .map_err(|e| e.to_string())
                .and_then(|root| Submissions::new(root).read_page(page.as_str(), &html));
            let judging = result.as_ref().is_ok_and(|update| update.judging);
            send_submissions(&app, result);
            if !judging {
                return;
            }
            std::thread::sleep(JUDGING_READ_INTERVAL);
            let visible = *app.state::<Browser>().shown.lock().unwrap() == label;
            match (shown_list(), app.get_webview(&label)) {
                (Some(_), Some(webview)) if visible => read_submissions(&webview, since),
                _ => follow_submissions(&app, page, since),
            }
        });
    });
    if let Err(error) = read {
        eprintln!("cannot read the submission list: {error}");
    }
}

/// Reads a loaded contest top page: a registered contest is added or updated and the screen is
/// told (U6a). Registering changes no URL, so every load of the top is read.
fn read_contest_top(webview: &tauri::Webview, page: Url) {
    let app = webview.app_handle().clone();
    let read = webview.eval_with_callback("document.documentElement.outerHTML", move |json| {
        let html = serde_json::from_str::<String>(&json).unwrap_or_default();
        let (app, page) = (app.clone(), page.clone());
        std::thread::spawn(move || {
            let lock = std::sync::Arc::clone(&app.state::<crate::AppState>().contest_lock);
            let _guard = lock.lock().unwrap();
            let joined = app
                .path()
                .app_local_data_dir()
                .map_err(|e| e.to_string())
                .and_then(|root| Contests::new(root).join(page.as_str(), &html, unix_now()));
            let payload = match joined {
                Ok(None) => return,
                Ok(Some(contest)) => serde_json::json!({ "contest": contest }),
                Err(error) => serde_json::json!({ "error": error }),
            };
            let _ = app.emit_to("main", "contest-joined", payload);
        });
    });
    if let Err(error) = read {
        eprintln!("cannot read the contest page: {error}");
    }
}

fn builder(
    app: &tauri::AppHandle,
    label: &str,
    url: Url,
    task: Option<String>,
) -> WebviewBuilder<tauri::Wry> {
    let (app_for_window, label_for_window) = (app.clone(), label.to_string());
    let app_for_page = app.clone();
    let mut builder = WebviewBuilder::new(label, WebviewUrl::External(url))
        .on_navigation(move |url| allowed(&app_for_page, url))
        .on_new_window(move |url, _| {
            // Allowed links that open a new window stay in the same page; others are not opened.
            if allowed(&app_for_window, &url) {
                if let Some(webview) = app_for_window.get_webview(&label_for_window) {
                    let _ = webview.navigate(url);
                }
            }
            NewWindowResponse::Deny
        });
    builder = builder.on_page_load(move |webview, payload| {
        show_url(&webview, payload.url());
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            let url = real_url(payload.url());
            if submissions_page(&url).is_some() {
                read_submissions(&webview, Instant::now());
            } else if contest_top(&url).is_some() {
                read_contest_top(&webview, url);
            }
        }
        if let Some(task_url) = &task {
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && is_atcoder(&real_url(payload.url()))
                && is_task_page(task_url, payload.url())
            {
                read_if_needed(&webview, task_url.clone());
            }
        }
    });
    let args = app.state::<Browser>().args.lock().unwrap().clone();
    if let Some(args) = args {
        builder = builder.additional_browser_args(&args);
    }
    builder
}

impl Browser {
    /// The browser arguments of the UI tests, which every child webview needs too.
    pub(crate) fn args(&self) -> Option<String> {
        self.args.lock().unwrap().clone()
    }

    pub fn create_home(app: &tauri::App, args: Option<String>) -> tauri::Result<()> {
        let browser = app.state::<Browser>();
        *browser.args.lock().unwrap() = args;
        *browser.shown.lock().unwrap() = HOME.into();
        let window = app.get_window("main").expect("main window");
        let home = builder(
            app.handle(),
            HOME,
            to_origin(&format!("{ATCODER_ORIGIN}/")).unwrap(),
            None,
        );
        let _home = window.add_child(
            home,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )?;
        #[cfg(windows)]
        crate::webview2::add_search_menu(&_home);
        Ok(())
    }

    /// Places the shown page over the browser column and hides the others. While the るりま
    /// window is out, the AtCoder pages are hidden and its page lies where the screen asks (D3).
    pub(crate) fn apply(&self, app: &tauri::AppHandle) {
        let shown = self.shown.lock().unwrap().clone();
        let hidden = *self.hidden.lock().unwrap();
        let bounds = *self.bounds.lock().unwrap();
        let cover = *self.cover.lock().unwrap();
        let place = |webview: &tauri::Webview, at: Option<Bounds>| match at {
            Some(at) if !hidden && at.width >= 1.0 && at.height >= 1.0 => {
                let _ = webview.set_position(LogicalPosition::new(at.x, at.y));
                let _ = webview.set_size(LogicalSize::new(at.width, at.height));
                let _ = webview.show();
            }
            _ => {
                let _ = webview.hide();
            }
        };
        let labels: Vec<String> = std::iter::once(HOME.to_string())
            .chain(self.tasks.lock().unwrap().values().cloned())
            .collect();
        for label in labels {
            let Some(webview) = app.get_webview(&label) else {
                continue;
            };
            let at = (label == shown && cover.is_none()).then_some(bounds);
            place(&webview, at);
        }
        if let Some(webview) = app.get_webview(RURIMA) {
            place(&webview, cover);
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
    home.navigate(to_origin(
        &url.unwrap_or_else(|| format!("{ATCODER_ORIGIN}/")),
    )?)
    .map_err(|e| e.to_string())?;
    *browser.shown.lock().unwrap() = HOME.into();
    browser.apply(&app);
    show_current_url(&app, &browser);
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
                let _page = window
                    .add_child(
                        builder(&app, &label, to_origin(&url)?, Some(url.clone())),
                        LogicalPosition::new(0.0, 0.0),
                        LogicalSize::new(1.0, 1.0),
                    )
                    .map_err(|e| e.to_string())?;
                #[cfg(windows)]
                crate::webview2::add_search_menu(&_page);
                browser.tasks.lock().unwrap().insert(url, label.clone());
                label
            }
        };
    *browser.shown.lock().unwrap() = label;
    browser.apply(&app);
    show_current_url(&app, &browser);
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
    show_current_url(&app, &browser);
    Ok(())
}

/// Sets the origins added in the settings (D5), each typed as a domain or a URL, and returns
/// them as HTTPS origins. One that cannot be added leaves the list as it was.
#[tauri::command]
pub async fn browser_set_origins(
    browser: tauri::State<'_, Browser>,
    origins: Vec<String>,
) -> Result<Vec<String>, String> {
    let origins = browser_origins(&origins)?;
    *browser.origins.lock().unwrap() = origins.clone();
    Ok(origins)
}

/// Opens a URL typed in the URL field in the shown page.
#[tauri::command]
pub async fn browser_open(
    app: tauri::AppHandle,
    browser: tauri::State<'_, Browser>,
    url: String,
) -> Result<(), String> {
    let origins = browser.origins.lock().unwrap().clone();
    let url = to_origin(browser_target(&url, &origins)?.as_str())?;
    shown(&app, &browser)?
        .navigate(url)
        .map_err(|e| e.to_string())
}

/// Puts the AtCoder page aside while a window of the screen is out, with the るりま window's page
/// where the screen draws it (zero size for the graph window, D4), or, with `open` false, shows
/// the AtCoder page again. The screen sends a few in a row to slide the window down or up (D3).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn cover_layout(
    app: tauri::AppHandle,
    browser: tauri::State<'_, Browser>,
    open: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    *browser.cover.lock().unwrap() = open.then_some(Bounds {
        x,
        y,
        width,
        height,
    });
    browser.apply(&app);
    Ok(())
}

/// A JPEG picture of the shown AtCoder page, drawn darkened behind the るりま window: the page
/// itself lies over the screen, so nothing can be drawn over it (D3). Empty where WebView2's
/// `CapturePreview` is not available.
#[tauri::command]
pub async fn browser_snapshot(
    app: tauri::AppHandle,
    browser: tauri::State<'_, Browser>,
) -> Result<tauri::ipc::Response, String> {
    let webview = shown(&app, &browser)?;
    #[cfg(windows)]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        webview
            .with_webview(move |platform| crate::webview2::capture(platform, sender))
            .map_err(|e| e.to_string())?;
        let picture = tauri::async_runtime::spawn_blocking(move || {
            receiver
                .recv_timeout(Duration::from_secs(3))
                .unwrap_or_default()
        })
        .await
        .map_err(|e| e.to_string())?;
        Ok(tauri::ipc::Response::new(picture))
    }
    #[cfg(not(windows))]
    {
        let _ = webview;
        Ok(tauri::ipc::Response::new(Vec::new()))
    }
}

/// Goes back or forward in the shown page's history.
#[tauri::command]
pub async fn browser_history(
    app: tauri::AppHandle,
    browser: tauri::State<'_, Browser>,
    forward: bool,
) -> Result<(), String> {
    let script = if forward {
        "history.forward()"
    } else {
        "history.back()"
    };
    shown(&app, &browser)?
        .eval(script)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_reload(
    app: tauri::AppHandle,
    browser: tauri::State<'_, Browser>,
) -> Result<(), String> {
    shown(&app, &browser)?.reload().map_err(|e| e.to_string())
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
