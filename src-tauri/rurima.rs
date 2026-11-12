//! The るりま window over the AtCoder pages (D3): a child webview that opens only the reference
//! and the search for its full text, placed where the screen draws the window.
use crate::browser::Browser;
use atcoder_ruby_ide::{is_rurima_page, rurima_page, rurima_target, RURIMA_HOME};
use tauri::webview::NewWindowResponse;
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};
use url::Url;

pub const RURIMA: &str = "rurima";

/// The るりま window's pages in UI tests come from a local server, each site under its own path.
fn rurima_test_paths() -> Option<Vec<(&'static str, String)>> {
    let origin = std::env::var("ATCODER_IDE_TEST_RURIMA_ORIGIN").ok()?;
    let origin = origin.trim_end_matches('/');
    Some(vec![
        ("https://docs.ruby-lang.org", format!("{origin}/rurima")),
        ("https://www.google.com", format!("{origin}/google")),
    ])
}
pub(crate) fn rurima_to_origin(url: &Url) -> Url {
    rurima_test_paths()
        .and_then(|paths| {
            paths.iter().find_map(|(site, local)| {
                let rest = url.as_str().strip_prefix(site)?;
                Url::parse(&format!("{local}{rest}")).ok()
            })
        })
        .unwrap_or_else(|| url.clone())
}
/// The real URL of a page the るりま window loaded, if the window may open it.
pub(crate) fn rurima_from_origin(url: &Url) -> Option<Url> {
    let url = rurima_test_paths()
        .and_then(|paths| {
            paths.iter().find_map(|(site, local)| {
                let rest = url.as_str().strip_prefix(local.as_str())?;
                Url::parse(&format!("{site}{rest}")).ok()
            })
        })
        .unwrap_or_else(|| url.clone());
    is_rurima_page(&url).then_some(url)
}

fn rurima(app: &tauri::AppHandle) -> Result<tauri::Webview, String> {
    app.get_webview(RURIMA)
        .ok_or_else(|| "るりまの窓を準備できません。".into())
}
/// The るりま window opens only the reference and the search for its full text (D3).
fn rurima_builder(app: &tauri::AppHandle, url: Url) -> WebviewBuilder<tauri::Wry> {
    let (app_for_window, app_for_page) = (app.clone(), app.clone());
    let mut builder = WebviewBuilder::new(RURIMA, WebviewUrl::External(url))
        .on_navigation(move |url| match rurima_from_origin(url) {
            // Other versions' pages, mostly the latest one's on Google, open as Ruby 3.4's.
            Some(page) => match rurima_page(&page) {
                Some(version) => {
                    let app = app_for_page.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(webview) = app.get_webview(RURIMA) {
                            let _ = webview.navigate(rurima_to_origin(&version));
                        }
                    });
                    false
                }
                None => true,
            },
            None => false,
        })
        .on_new_window(move |url, _| {
            if rurima_from_origin(&url).is_some() {
                if let Some(webview) = app_for_window.get_webview(RURIMA) {
                    let _ = webview.navigate(url);
                }
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|webview, payload| crate::browser::show_url(&webview, payload.url()));
    let args = app.state::<Browser>().args();
    if let Some(args) = args {
        builder = builder.additional_browser_args(&args);
    }
    builder
}

/// Opens the るりま window's page for `query`: words to search for, or a page of the reference
/// or of the search. The window is made on first use, with the reference's top when there is no
/// query; `cover_layout` places it (D3).
#[tauri::command]
pub async fn rurima_show(
    app: tauri::AppHandle,
    browser: tauri::State<'_, Browser>,
    query: Option<String>,
) -> Result<(), String> {
    let target = query.as_deref().map(rurima_target).transpose()?;
    match app.get_webview(RURIMA) {
        Some(webview) => {
            if let Some(url) = target {
                webview
                    .navigate(rurima_to_origin(&url))
                    .map_err(|e| e.to_string())?;
            }
        }
        None => {
            let url = target.unwrap_or_else(|| Url::parse(RURIMA_HOME).unwrap());
            let window = app.get_window("main").ok_or("ウィンドウがありません。")?;
            let _rurima = window
                .add_child(
                    rurima_builder(&app, rurima_to_origin(&url)),
                    LogicalPosition::new(0.0, 0.0),
                    LogicalSize::new(1.0, 1.0),
                )
                .map_err(|e| e.to_string())?;
            #[cfg(windows)]
            crate::webview2::add_search_menu(&_rurima);
        }
    }
    browser.apply(&app);
    Ok(())
}

/// Goes back or forward in the るりま window's history.
#[tauri::command]
pub async fn rurima_history(app: tauri::AppHandle, forward: bool) -> Result<(), String> {
    let script = if forward {
        "history.forward()"
    } else {
        "history.back()"
    };
    rurima(&app)?.eval(script).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rurima_reload(app: tauri::AppHandle) -> Result<(), String> {
    rurima(&app)?.reload().map_err(|e| e.to_string())
}
