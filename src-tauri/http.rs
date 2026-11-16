//! Fetching AtCoder's pages the browser does not show (task lists, a submission list left while
//! judging) with the browser's cookies. Redirects are not followed: they mean logging in.
use reqwest::blocking::Client;
use std::io::Read;
use std::time::Duration;

/// The largest page read, fetched or loaded in the browser.
pub(crate) const MAX_HTML_BYTES: usize = 4 * crate::files::MAX_TEXT_BYTES;

pub fn http_client() -> Result<Client, String> {
    Client::builder()
        .use_native_tls()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("AtCoder-Ruby-IDE/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// Fetches a page with the browser's cookies. Login redirects and missing permissions are
/// reported as a request to log in or register in the browser.
pub fn fetch_page(client: &Client, url: &str, cookie: &str) -> Result<String, String> {
    let mut request = client.get(url);
    if !cookie.is_empty() {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    let response = request
        .send()
        .map_err(|e| format!("AtCoderに接続できません: {e}"))?;
    let status = response.status();
    if status.is_redirection()
        || status == reqwest::StatusCode::NOT_FOUND
        || status == reqwest::StatusCode::FORBIDDEN
    {
        return Err(format!(
            "AtCoderのページを取得できません（HTTP {}）。ブラウザでログインし、開催中のコンテストは参加登録してください。",
            status.as_u16()
        ));
    }
    if !status.is_success() {
        return Err(format!(
            "AtCoderのページを取得できません（HTTP {}）。時間をおいて再試行してください。",
            status.as_u16()
        ));
    }
    let mut bytes = Vec::new();
    response
        .take((MAX_HTML_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("AtCoderのページの読み込みに失敗しました: {e}"))?;
    if bytes.len() > MAX_HTML_BYTES {
        return Err("AtCoderのページは4 MiB以下にしてください。".into());
    }
    String::from_utf8(bytes).map_err(|_| "AtCoderのページがUTF-8ではありません。".into())
}
