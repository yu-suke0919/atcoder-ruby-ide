// U0 spike: embed AtCoder in the main window and check isolation, cookies and page loads.
// This file is not merged; results are recorded in docs/architecture.md.
use std::sync::Mutex;
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

pub const LABEL: &str = "atcoder";

#[derive(Default)]
pub struct SpikeState {
    pub loads: Mutex<Vec<String>>,
}

pub fn embed(app: &tauri::App, browser_args: Option<String>) -> tauri::Result<()> {
    let window = app.get_window("main").expect("main window");
    let mut builder = WebviewBuilder::new(
        LABEL,
        WebviewUrl::External(
            "https://atcoder.jp/contests/abc400/tasks/abc400_a"
                .parse()
                .unwrap(),
        ),
    )
    .auto_resize()
    .on_navigation(|url| {
        let allowed = url.scheme() == "https" && url.host_str() == Some("atcoder.jp");
        if !allowed {
            eprintln!("spike: blocked navigation to {url}");
        }
        allowed
    })
    .on_page_load(|webview, payload| {
        let entry = format!("{:?} {}", payload.event(), payload.url());
        webview
            .state::<SpikeState>()
            .loads
            .lock()
            .unwrap()
            .push(entry);
    });
    if let Some(args) = browser_args {
        builder = builder.additional_browser_args(&args);
    }
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        use tauri_plugin_notification::NotificationExt;
        std::thread::sleep(std::time::Duration::from_secs(5));
        let result = handle
            .notification()
            .builder()
            .title("AtCoder Ruby IDE")
            .body("U0: トースト通知の確認")
            .show();
        eprintln!("spike: startup notification {result:?}");
    });
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    window.add_child(
        builder,
        LogicalPosition::new(size.width * 0.6, 0.0),
        LogicalSize::new(size.width * 0.4, size.height),
    )?;
    Ok(())
}

#[tauri::command]
pub async fn spike_fetch(app: tauri::AppHandle, url: String) -> Result<serde_json::Value, String> {
    let webview = app.get_webview(LABEL).ok_or("no atcoder webview")?;
    let url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let current = webview.url().map_err(|e| e.to_string())?.to_string();
    let cookies = {
        let (webview, url) = (webview.clone(), url.clone());
        tauri::async_runtime::spawn_blocking(move || webview.cookies_for_url(url))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?
    };
    let names: Vec<String> = cookies.iter().map(|c| c.name().to_string()).collect();
    let header = cookies
        .iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ");
    let response = tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let mut request = client.get(url);
        if !header.is_empty() {
            request = request.header(reqwest::header::COOKIE, header);
        }
        let response = request.send()?;
        let status = response.status().as_u16();
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let body = response.text()?;
        Ok::<_, reqwest::Error>((status, location, body))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let (status, location, body) = response;
    let document = scraper::Html::parse_document(&body);
    let selector = scraper::Selector::parse("h3").unwrap();
    let samples = document
        .select(&selector)
        .filter(|h| h.text().collect::<String>().contains("入力例"))
        .count();
    let logged_in = body.contains("userScreenName = \"") && !body.contains("userScreenName = \"\"");
    Ok(serde_json::json!({
        "current": current,
        "cookieNames": names,
        "status": status,
        "location": location,
        "length": body.len(),
        "samples": samples,
        "loggedIn": logged_in,
    }))
}

#[tauri::command]
pub fn spike_navigate(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let webview = app.get_webview(LABEL).ok_or("no atcoder webview")?;
    webview
        .navigate(url.parse().map_err(|e: url::ParseError| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn spike_loads(state: tauri::State<'_, SpikeState>) -> Vec<String> {
    state.loads.lock().unwrap().clone()
}
