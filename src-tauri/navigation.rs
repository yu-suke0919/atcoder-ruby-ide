//! Which pages the right-hand browser may open.
use url::Url;

/// The origin the browser always opens, and the only one whose pages the app reads.
pub const ATCODER_ORIGIN: &str = "https://atcoder.jp";

fn same_origin(url: &Url, origin: &str) -> bool {
    Url::parse(origin).is_ok_and(|origin| origin.origin() == url.origin())
}

/// Whether a URL is one of AtCoder's pages, the pages the app reads.
pub fn is_atcoder(url: &Url) -> bool {
    same_origin(url, ATCODER_ORIGIN)
}

/// Whether a URL belongs to AtCoder or an origin added in the settings (D5).
pub fn is_allowed(url: &Url, added: &[String]) -> bool {
    is_atcoder(url) || added.iter().any(|origin| same_origin(url, origin))
}

/// A URL typed or kept as text. A missing scheme means HTTPS.
fn typed_url(input: &str) -> Option<Url> {
    let input = input.trim();
    if input.contains("://") {
        Url::parse(input).ok()
    } else {
        Url::parse(&format!("https://{input}")).ok()
    }
}

/// Parses what was typed in the URL field.
pub fn browser_target(input: &str, added: &[String]) -> Result<Url, String> {
    typed_url(input)
        .filter(|url| is_allowed(url, added))
        .ok_or_else(|| {
            let origins: Vec<&str> = std::iter::once(ATCODER_ORIGIN)
                .chain(added.iter().map(String::as_str))
                .collect();
            format!("開けるのは {} のページだけです。", origins.join("、"))
        })
}

/// The origins added in the settings (D5), each typed as a domain or a URL, as HTTPS origins
/// such as `https://kenkoooo.com`.
pub fn browser_origins(inputs: &[String]) -> Result<Vec<String>, String> {
    let mut origins: Vec<String> = Vec::new();
    for input in inputs {
        let url = typed_url(input)
            .ok_or_else(|| format!("「{}」はドメインかURLではありません。", input.trim()))?;
        if url.scheme() != "https" {
            return Err(format!(
                "追加できるのはHTTPSのページだけです（{}）。",
                input.trim()
            ));
        }
        if !url.has_host() {
            return Err(format!("「{}」にドメインがありません。", input.trim()));
        }
        let origin = url.origin().ascii_serialization();
        if origin == ATCODER_ORIGIN {
            return Err("AtCoderは最初から開けます。".into());
        }
        if origins.contains(&origin) {
            return Err(format!("{origin} はすでに一覧にあります。"));
        }
        origins.push(origin);
    }
    Ok(origins)
}

/// Origins the るりま window may open (D3): the reference, and the search engine that searches
/// its full text.
pub const RURIMA_ORIGINS: &[&str] = &["https://docs.ruby-lang.org", "https://www.google.com"];
/// The first page of the るりま window: the reference of Ruby 3.4, the Ruby AtCoder uses.
pub const RURIMA_HOME: &str = "https://docs.ruby-lang.org/ja/3.4/doc/index.html";
/// Added after the words. Narrowing to a path such as `/ja/latest/` was not applied by Google.
const RURIMA_SEARCH: &str = "site:docs.ruby-lang.org";
const RURIMA_VERSION: &str = "3.4";
const MAX_SEARCH_CHARS: usize = 200;

/// Whether the るりま window may open a URL.
pub fn is_rurima_page(url: &Url) -> bool {
    RURIMA_ORIGINS
        .iter()
        .any(|origin| Url::parse(origin).is_ok_and(|origin| origin.origin() == url.origin()))
}

/// The Ruby 3.4 page, AtCoder's Ruby, for a page of another version of the Japanese reference
/// (`/ja/latest/…`, `/ja/4.0/…`). Every version names the latest one's page as the canonical one,
/// so Google lists mostly those.
pub fn rurima_page(url: &Url) -> Option<Url> {
    if url.origin() != Url::parse(RURIMA_ORIGINS[0]).ok()?.origin() {
        return None;
    }
    let (version, rest) = url.path().strip_prefix("/ja/")?.split_once('/')?;
    let other = version == "latest" || version.starts_with(|c: char| c.is_ascii_digit());
    if !other || version == RURIMA_VERSION {
        return None;
    }
    let mut page = url.clone();
    page.set_path(&format!("/ja/{RURIMA_VERSION}/{rest}"));
    Some(page)
}

/// What the るりま window opens for text typed or selected: a page of the reference or of the
/// search as it is (a missing scheme means HTTPS), or else the full-text search for the words.
pub fn rurima_target(input: &str) -> Result<Url, String> {
    let words = input.split_whitespace().collect::<Vec<_>>().join(" ");
    if words.is_empty() {
        return Err("検索する語を入れてください。".into());
    }
    let page = if words.contains("://") {
        Some(Url::parse(&words).ok())
    } else if !words.contains(' ')
        && RURIMA_ORIGINS
            .iter()
            .any(|origin| words.starts_with(origin.trim_start_matches("https://")))
    {
        Some(Url::parse(&format!("https://{words}")).ok())
    } else {
        None
    };
    if let Some(page) = page {
        return page
            .filter(is_rurima_page)
            .map(|page| rurima_page(&page).unwrap_or(page))
            .ok_or_else(|| {
                format!(
                    "るりまの窓で開けるのは {} のページだけです。",
                    RURIMA_ORIGINS.join("、")
                )
            });
    }
    let words: String = words.chars().take(MAX_SEARCH_CHARS).collect();
    Url::parse_with_params(
        "https://www.google.com/search",
        &[("q", format!("{words} {RURIMA_SEARCH}"))],
    )
    .map_err(|e| e.to_string())
}
