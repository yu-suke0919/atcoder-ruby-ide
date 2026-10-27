use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::blocking::Client;
use scraper::{ElementRef, Node};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use url::Url;

pub(crate) const MAX_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_IMAGES_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum StatementPart {
    Text {
        text: String,
    },
    Math {
        text: String,
        display: bool,
    },
    Code {
        text: String,
    },
    Preformatted {
        parts: Vec<StatementPart>,
    },
    Image {
        url: String,
        alt: String,
        data: String,
        width: u32,
        height: u32,
    },
}

fn image_url(base: &str, value: &str) -> Result<String, String> {
    let mut url = Url::parse(base)
        .map_err(|_| "画像の基準URLが不正です。")?
        .join(value)
        .map_err(|_| "画像URLが不正です。")?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("atcoder.jp" | "img.atcoder.jp"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("画像はHTTPSのatcoder.jp・img.atcoder.jpから取得してください。".into());
    }
    url.set_fragment(None);
    Ok(url.into())
}
fn text(parts: &mut Vec<StatementPart>, value: &str) {
    if let Some(StatementPart::Text { text }) = parts.last_mut() {
        text.push_str(value);
    } else if !value.is_empty() {
        parts.push(StatementPart::Text { text: value.into() });
    }
}
fn math_source(element: ElementRef<'_>) -> String {
    let mut source = String::new();
    for child in element.children() {
        match child.value() {
            Node::Text(value) => source.push_str(value),
            Node::Element(_) => {
                let child = ElementRef::wrap(child).unwrap();
                match child.value().name() {
                    "sub" | "sup" => {
                        source.push_str(if child.value().name() == "sub" {
                            "_{"
                        } else {
                            "^{"
                        });
                        source.push_str(&math_source(child));
                        source.push('}');
                    }
                    "script" | "style" | "noscript" => {}
                    _ => source.push_str(&math_source(child)),
                }
            }
            _ => {}
        }
    }
    source
}
fn preformatted_parts(element: ElementRef<'_>, parts: &mut Vec<StatementPart>) {
    for child in element.children() {
        match child.value() {
            Node::Text(value) => text(parts, value),
            Node::Element(_) => {
                let child = ElementRef::wrap(child).unwrap();
                match child.value().name() {
                    "var" => parts.push(StatementPart::Math {
                        text: math_source(child),
                        display: false,
                    }),
                    "br" => text(parts, "\n"),
                    "script" | "style" | "noscript" | "iframe" | "object" => {}
                    _ => preformatted_parts(child, parts),
                }
            }
            _ => {}
        }
    }
}
fn walk(element: ElementRef<'_>, base: &str, parts: &mut Vec<StatementPart>) -> Result<(), String> {
    let name = element.value().name();
    if matches!(name, "script" | "style" | "noscript" | "iframe" | "object") {
        return Ok(());
    }
    match name {
        "img" => {
            let url = image_url(
                base,
                element.value().attr("src").ok_or("画像URLがありません。")?,
            )?;
            parts.push(StatementPart::Image {
                url,
                alt: element.value().attr("alt").unwrap_or("問題の図").into(),
                data: String::new(),
                width: 0,
                height: 0,
            });
            return Ok(());
        }
        "var" => {
            parts.push(StatementPart::Math {
                text: math_source(element),
                display: false,
            });
            return Ok(());
        }
        "pre" => {
            if element
                .descendants()
                .any(|node| matches!(node.value(), Node::Element(e) if e.name() == "var"))
            {
                let mut inline = Vec::new();
                preformatted_parts(element, &mut inline);
                parts.push(StatementPart::Preformatted { parts: inline });
            } else {
                parts.push(StatementPart::Code {
                    text: element.text().collect(),
                });
            }
            return Ok(());
        }
        _ => {}
    }
    let block = matches!(
        name,
        "p" | "div" | "section" | "h1" | "h2" | "h3" | "h4" | "li" | "tr" | "br"
    );
    if block {
        text(parts, "\n");
    }
    for child in element.children() {
        match child.value() {
            Node::Text(value) => text(parts, value),
            Node::Element(_) => walk(ElementRef::wrap(child).unwrap(), base, parts)?,
            _ => {}
        }
    }
    if block {
        text(parts, "\n");
    }
    Ok(())
}
fn math_text(value: &str, parts: &mut Vec<StatementPart>) {
    let mut rest = value;
    loop {
        let next = [
            ("\\[", "\\]", true),
            ("\\(", "\\)", false),
            ("$$", "$$", true),
        ]
        .into_iter()
        .filter_map(|(open, close, display)| rest.find(open).map(|at| (at, open, close, display)))
        .min_by_key(|p| p.0);
        let Some((at, open, close, display)) = next else {
            text(parts, rest);
            break;
        };
        let after = &rest[at + open.len()..];
        let Some(end) = after.find(close) else {
            text(parts, rest);
            break;
        };
        text(parts, &rest[..at]);
        parts.push(StatementPart::Math {
            text: after[..end].into(),
            display,
        });
        rest = &after[end + close.len()..];
    }
}
pub(crate) fn parse_statement(
    body: ElementRef<'_>,
    base: &str,
) -> Result<Vec<StatementPart>, String> {
    let mut raw = Vec::new();
    walk(body, base, &mut raw)?;
    let mut parts = Vec::new();
    for part in raw {
        if let StatementPart::Text { text } = part {
            math_text(&text, &mut parts);
        } else {
            parts.push(part);
        }
    }
    if let Some(StatementPart::Text { text }) = parts.first_mut() {
        *text = text.trim_start().into();
    }
    if let Some(StatementPart::Text { text }) = parts.last_mut() {
        *text = text.trim_end().into();
    }
    Ok(parts)
}

fn image_info(bytes: &[u8]) -> Result<(&'static str, u32, u32), String> {
    if let Ok(value) = std::str::from_utf8(bytes) {
        if value.trim_start().starts_with('<') {
            validate_svg(value)?;
            let (width, height) = svg_dimensions(value)?;
            return Ok(("image/svg+xml", width, height));
        }
    }
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mime = match reader.format() {
        Some(image::ImageFormat::Png) => "image/png",
        Some(image::ImageFormat::Jpeg) => "image/jpeg",
        Some(image::ImageFormat::Gif) => "image/gif",
        Some(image::ImageFormat::WebP) => "image/webp",
        _ => {
            return Err(
                "対応しない画像形式です。PNG・JPEG・GIF・WebP・SVGを使用してください。".into(),
            )
        }
    };
    let mut reader = reader;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(64 * 1024 * 1024);
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|e| format!("画像が破損しているか大きすぎます: {e}"))?;
    Ok((mime, decoded.width(), decoded.height()))
}
fn svg_dimensions(value: &str) -> Result<(u32, u32), String> {
    let mut reader = quick_xml::Reader::from_str(value);
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            quick_xml::events::Event::Start(e) | quick_xml::events::Event::Empty(e) => {
                let attrs: BTreeMap<_, _> = e
                    .attributes()
                    .map(|a| {
                        let a = a.map_err(|e| e.to_string())?;
                        Ok((
                            a.key.as_ref().to_owned(),
                            a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                                .map_err(|e| e.to_string())?
                                .into_owned(),
                        ))
                    })
                    .collect::<Result<_, String>>()?;
                let view: Vec<f64> = attrs
                    .get("viewBox")
                    .map(|v| {
                        v.split(|c: char| c.is_whitespace() || c == ',')
                            .filter(|x| !x.is_empty())
                            .filter_map(|x| x.parse().ok())
                            .collect()
                    })
                    .unwrap_or_default();
                let dimension = |name: &str, index, default| -> Result<u32, String> {
                    let size = attrs
                        .get(name)
                        .and_then(|v| v.trim_end_matches("px").parse::<f64>().ok())
                        .unwrap_or_else(|| {
                            if view.len() == 4 {
                                view[index]
                            } else {
                                default
                            }
                        });
                    if !size.is_finite() || size <= 0. || size > 8192. {
                        return Err("画像の寸法は1〜8192pxにしてください。".into());
                    }
                    Ok(size.ceil() as u32)
                };
                return Ok((dimension("width", 2, 300.)?, dimension("height", 3, 150.)?));
            }
            quick_xml::events::Event::Eof => return Err("SVGが空です。".into()),
            _ => {}
        }
    }
}
fn validate_css(value: &str) -> Result<(), String> {
    use cssparser::{ParseError, Parser, Token};
    fn tokens<'i>(input: &mut Parser<'i>, depth: usize) -> Result<(), ParseError<()>> {
        if depth > 64 {
            return Err(ParseError::custom(()));
        }
        while !input.is_exhausted() {
            let token = input.next()?.clone();
            match token {
                Token::UnquotedUrl(ref url) if !url.starts_with('#') || url.len() < 2 => {
                    return Err(ParseError::custom(()));
                }
                Token::Function(ref name) if name.eq_ignore_ascii_case("url") => {
                    input.parse_nested_block(|input| {
                        let url = input.expect_string_cloned()?;
                        if !url.starts_with('#') || url.len() < 2 {
                            return Err(ParseError::custom(()));
                        }
                        Ok(())
                    })?;
                }
                Token::AtKeyword(ref name) if name.eq_ignore_ascii_case("import") => {
                    return Err(ParseError::custom(()));
                }
                // These functions can interpret bare strings or computed values as URLs.
                Token::Function(ref name)
                    if [
                        "image-set",
                        "-webkit-image-set",
                        "image",
                        "src",
                        "expression",
                    ]
                    .iter()
                    .any(|blocked| name.eq_ignore_ascii_case(blocked)) =>
                {
                    return Err(ParseError::custom(()));
                }
                Token::Function(_)
                | Token::ParenthesisBlock
                | Token::SquareBracketBlock
                | Token::CurlyBracketBlock => {
                    input.parse_nested_block(|input| tokens(input, depth + 1))?;
                }
                token if token.is_parse_error() => return Err(ParseError::custom(())),
                _ => {}
            }
        }
        Ok(())
    }
    tokens(&mut Parser::new(value), 0)
        .map_err(|_| "SVGのCSSが不正か、外部参照を含んでいます。".into())
}
fn validate_svg(value: &str) -> Result<(), String> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(value);
    reader.config_mut().expand_empty_elements = true;
    let mut depth = 0usize;
    let mut elements = 0usize;
    let mut root = false;
    let mut style = None;
    let mut css = String::new();
    loop {
        match reader
            .read_event()
            .map_err(|e| format!("SVGが不正です: {e}"))?
        {
            Event::Start(e) => {
                if style.is_some() {
                    return Err("SVGのstyle要素に子要素は使用できません。".into());
                }
                let name = e.name();
                let name = name.as_ref();
                if root && depth == 0 {
                    return Err("SVGのルートが重複しています。".into());
                }
                if !root {
                    if name != "svg" {
                        return Err("SVGのルートが不正です。".into());
                    }
                    root = true;
                }
                if matches!(
                    name.rsplit(':').next().unwrap_or(name),
                    "script" | "foreignObject" | "image" | "animate" | "set"
                ) {
                    return Err("SVGのスクリプト・外部参照には対応していません。".into());
                }
                for attr in e.attributes() {
                    let attr = attr.map_err(|e| e.to_string())?;
                    let key = attr.key.as_ref();
                    let v = attr
                        .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                        .map_err(|e| e.to_string())?;
                    if key.starts_with("on")
                        || (key.ends_with("href") && !v.starts_with('#'))
                        || key == "xml:base"
                    {
                        return Err("SVGの外部参照には対応していません。".into());
                    }
                    validate_css(&v)?;
                }
                depth += 1;
                if name.rsplit(':').next() == Some("style") {
                    style = Some(depth);
                    css.clear();
                }
                elements += 1;
                if depth > 256 || elements > 10000 {
                    return Err("SVGの要素数が多すぎます。".into());
                }
            }
            Event::End(_) => {
                if style == Some(depth) {
                    validate_css(&css)?;
                    style = None;
                }
                depth = depth.checked_sub(1).ok_or("SVGの要素が不正です。")?;
            }
            Event::Text(t) if style.is_some() => css.push_str(&t.xml10_content()),
            Event::CData(t) if style.is_some() => css.push_str(&t.xml10_content()),
            Event::GeneralRef(reference) if style.is_some() => {
                let value = format!("&{};", reference.as_ref());
                css.push_str(&quick_xml::escape::unescape(&value).map_err(|e| e.to_string())?);
            }
            Event::Text(t) if depth == 0 && !t.as_ref().trim().is_empty() => {
                return Err("SVGの外側にテキストがあります。".into());
            }
            Event::DocType(_) | Event::PI(_) => {
                return Err("SVGの外部参照には対応していません。".into())
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !root || depth != 0 {
        return Err("SVGが空か閉じられていません。".into());
    }
    Ok(())
}
pub(crate) fn download_image(client: &Client, url: &str) -> Result<Vec<u8>, String> {
    image_url(url, url)?;
    download_image_bytes(client, url)
}
fn download_image_bytes(client: &Client, url: &str) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("画像を取得できません: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "画像を取得できません（HTTP {}）: {url}",
            response.status()
        ));
    }
    let mut bytes = Vec::new();
    response
        .take((MAX_IMAGE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}
pub(crate) fn fill_images(
    parts: &mut [StatementPart],
    mut fetch: impl FnMut(&str) -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    let mut saved = BTreeMap::new();
    let mut total = 0usize;
    for part in parts {
        if let StatementPart::Image {
            url,
            data,
            width,
            height,
            ..
        } = part
        {
            if !saved.contains_key(url) {
                let bytes = fetch(url)?;
                if bytes.len() > MAX_IMAGE_BYTES {
                    return Err("画像は1件2 MiB以下にしてください。".into());
                }
                let (mime, width, height) = image_info(&bytes)?;
                saved.insert(
                    url.clone(),
                    (
                        format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
                        width,
                        height,
                    ),
                );
            }
            let saved = &saved[url];
            *data = saved.0.clone();
            *width = saved.1;
            *height = saved.2;
            total += data.len();
            if total > MAX_IMAGES_BYTES * 4 / 3 + 128 * 20 {
                return Err("画像合計は8 MiB以下にしてください。".into());
            }
        }
    }
    Ok(())
}
pub(crate) fn validate_statement(
    parts: &[StatementPart],
    base: &str,
    require_images: bool,
) -> Result<(), String> {
    let mut text_bytes = 0;
    let mut images = 0;
    let mut image_bytes = 0;
    let mut elements = parts.len();
    if parts.is_empty() || parts.len() > 10000 {
        return Err("問題文の要素数が不正です。".into());
    }
    for part in parts {
        match part {
            StatementPart::Text { text }
            | StatementPart::Math { text, .. }
            | StatementPart::Code { text } => text_bytes += text.len(),
            StatementPart::Preformatted { parts } => {
                elements += parts.len();
                if parts.is_empty() {
                    return Err("入力形式が空です。".into());
                }
                for part in parts {
                    match part {
                        StatementPart::Text { text }
                        | StatementPart::Math {
                            text,
                            display: false,
                        } => text_bytes += text.len(),
                        _ => {
                            return Err(
                                "入力形式にはテキストとインライン数式を使用してください。".into()
                            )
                        }
                    }
                }
            }
            StatementPart::Image {
                url,
                alt,
                data,
                width,
                height,
            } => {
                if image_url(base, url)? != *url {
                    return Err("保存画像のURLが不正です。".into());
                }
                text_bytes += alt.len();
                images += 1;
                if data.is_empty() && !require_images {
                    continue;
                }
                if data.len() > MAX_IMAGE_BYTES * 4 / 3 + 128 {
                    return Err("画像は1件2 MiB以下にしてください。".into());
                }
                let (prefix, encoded) =
                    data.split_once(";base64,").ok_or("保存画像が不正です。")?;
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|_| "保存画像が不正です。")?;
                let (mime, actual_width, actual_height) = image_info(&bytes)?;
                if bytes.len() > MAX_IMAGE_BYTES
                    || prefix != format!("data:{mime}")
                    || (*width, *height) != (actual_width, actual_height)
                {
                    return Err("保存画像の形式・容量が不正です。".into());
                }
                image_bytes += bytes.len();
            }
        }
    }
    if elements > 10000 {
        return Err("問題文の要素数が不正です。".into());
    }
    if text_bytes == 0 || text_bytes > 1024 * 1024 || images > 20 || image_bytes > MAX_IMAGES_BYTES
    {
        return Err("本文は1 MiB、画像は20件・合計8 MiB以下にしてください。".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const BASE: &str = "https://atcoder.jp/contests/test/tasks/task";
    const SVG: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#ffffff"/></svg>"##;
    fn image() -> StatementPart {
        StatementPart::Image {
            url: "https://img.atcoder.jp/test/picture.svg".into(),
            alt: "図".into(),
            data: String::new(),
            width: 0,
            height: 0,
        }
    }
    #[test]
    fn image_origins_and_schemas_are_checked() {
        assert_eq!(
            image_url(BASE, "/test/a.png").unwrap(),
            "https://atcoder.jp/test/a.png"
        );
        for url in [
            "http://img.atcoder.jp/a.png",
            "https://img.atcoder.jp.evil.test/a",
            "https://u@img.atcoder.jp/a",
            "file:///tmp/a",
            "data:image/png;base64,x",
            "https://img.atcoder.jp:123/a",
        ] {
            assert!(image_url(BASE, url).is_err(), "{url}");
        }
        assert!(
            serde_json::from_str::<StatementPart>(r#"{"type":"html","text":"<script>"}"#).is_err()
        );
        assert!(serde_json::from_str::<StatementPart>(
            r#"{"type":"text","text":"a","onclick":"evil"}"#
        )
        .is_err());
    }
    #[test]
    fn preformatted_cache_accepts_only_bounded_inline_content() {
        let inline = vec![
            StatementPart::Text { text: "  ".into() },
            StatementPart::Math {
                text: "H_{1}".into(),
                display: false,
            },
            StatementPart::Text { text: "\n".into() },
        ];
        validate_statement(&[StatementPart::Preformatted { parts: inline }], BASE, true).unwrap();
        for parts in [
            vec![],
            vec![StatementPart::Code {
                text: "code".into(),
            }],
            vec![image()],
            vec![StatementPart::Math {
                text: "x".into(),
                display: true,
            }],
            vec![StatementPart::Preformatted { parts: vec![] }],
            vec![StatementPart::Text {
                text: "x".repeat(1024 * 1024 + 1),
            }],
            vec![StatementPart::Text { text: "x".into() }; 10000],
        ] {
            assert!(
                validate_statement(&[StatementPart::Preformatted { parts }], BASE, true).is_err()
            );
        }
    }
    #[test]
    fn svg_internal_references_and_styles_roundtrip() {
        let svg = include_bytes!("../tests/fixtures/internal-diagram.svg");
        assert_eq!(image_info(svg).unwrap(), ("image/svg+xml", 240, 120));
        let mut parts = vec![StatementPart::Text { text: "図".into() }, image()];
        fill_images(&mut parts, |_| Ok(svg.to_vec())).unwrap();
        let saved = serde_json::to_vec(&parts).unwrap();
        let restored = serde_json::from_slice::<Vec<StatementPart>>(&saved).unwrap();
        validate_statement(&restored, BASE, true).unwrap();
        assert_eq!(restored, parts);
        for body in [
            r##"<rect fill="url( '#grad' )"/>"##,
            r##"<rect style="fill: URL('#grad'); clip-path: url(#clip)"/>"##,
            r##"<rect fill="u\72l(\23 grad)"/>"##,
            r##"<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#shape"/>"##,
            r##"<style>.shape { fill: url("#grad"); font-family: "Times New Roman"; }</style>"##,
            r##"<style><![CDATA[.shape { fill: u\72l("\23 grad"); }]]></style>"##,
            r##"<style>.shape { fill: url(&quot;&#35;grad&quot;); }</style>"##,
            r##"<style>.shape { color: red; } /* @import "ignored"; url(https://ignored.invalid) */</style>"##,
        ] {
            let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg">{body}</svg>"#);
            validate_svg(&svg).unwrap_or_else(|e| panic!("{body}: {e}"));
        }
    }
    #[test]
    fn svg_styles_reject_external_resources_and_scripts() {
        for body in [
            r#"<rect fill="url(https://external.invalid/a.svg#grad)"/>"#,
            r#"<rect style="fill: u\72l('https://external.invalid/a.svg#grad')"/>"#,
            r#"<style>.a { fill: url(//external.invalid/a.svg#grad); }</style>"#,
            r#"<style><![CDATA[@import "https://external.invalid/a.css";]]></style>"#,
            r#"<style>@\69mport/**/"https://external.invalid/a.css";</style>"#,
            r#"<style>@im<!-- split -->port "https://external.invalid/a.css";</style>"#,
            r#"<style>.a { fill: u&#114;l('https://external.invalid/a.svg'); }</style>"#,
            r#"<style>.a { background: image-set("https://external.invalid/a.png" 1x); }</style>"#,
            r#"<style>.a { width: expression(alert(1)); }</style>"#,
            r##"<g xml:base="https://external.invalid/a.svg"><use href="#shape"/></g>"##,
            r#"<g onclick="alert(1)"/>"#,
            r#"<script>alert(1)</script>"#,
        ] {
            let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg">{body}</svg>"#);
            assert!(validate_svg(&svg).is_err(), "{body}");
        }
    }
    #[test]
    fn images_are_validated_deduplicated_and_bounded() {
        let mut parts = vec![image(), image()];
        let mut calls = 0;
        fill_images(&mut parts, |_| {
            calls += 1;
            Ok(SVG.to_vec())
        })
        .unwrap();
        assert_eq!(calls, 1);
        validate_statement(&parts, BASE, true).unwrap();
        for bytes in [
            vec![],
            b"not an image".to_vec(),
            vec![0; MAX_IMAGE_BYTES + 1],
            b"<svg>".to_vec(),
            b"<svg/><svg/>".to_vec(),
            b"<svg/>invalid".to_vec(),
            br#"<svg width="9999999"/>"#.to_vec(),
            br#"<svg><script>alert(1)</script></svg>"#.to_vec(),
            br#"<svg><use href="https://evil.test/a"/></svg>"#.to_vec(),
            br#"<!DOCTYPE svg><svg/>"#.to_vec(),
        ] {
            assert!(fill_images(&mut [image()], |_| Ok(bytes.clone())).is_err());
        }
        assert!(validate_statement(&vec![image(); 21], BASE, false).is_err());
        assert!(validate_statement(&[image()], BASE, true).is_err());
        let mut oversized = vec![image(); 5];
        let mut big_svg = SVG.to_vec();
        big_svg.resize(MAX_IMAGE_BYTES, b' ');
        assert!(fill_images(&mut oversized, |_| Ok(big_svg.clone())).is_err());
        for (format, mime) in [
            (image::ImageFormat::Png, "image/png"),
            (image::ImageFormat::Jpeg, "image/jpeg"),
            (image::ImageFormat::Gif, "image/gif"),
            (image::ImageFormat::WebP, "image/webp"),
        ] {
            let mut bytes = Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(2, 2)
                .write_to(&mut bytes, format)
                .unwrap();
            assert_eq!(image_info(bytes.get_ref()).unwrap(), (mime, 2, 2));
        }
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        assert_eq!(image_info(png.get_ref()).unwrap(), ("image/png", 2, 2));
        let mut corrupt = png.into_inner();
        corrupt.truncate(corrupt.len() / 2);
        assert!(image_info(&corrupt).is_err());
    }
    #[test]
    fn binary_http_status_redirect_and_size_are_checked() {
        use std::io::Write;
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        for (status, body, expected) in [
            ("200 OK", SVG.to_vec(), true),
            ("404 Not Found", vec![], false),
            ("302 Found", vec![], false),
            ("200 OK", vec![0; MAX_IMAGE_BYTES + 1], false),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 2048];
                let _ = stream.read(&mut request);
                let header = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nLocation: http://example.invalid\r\n\r\n", body.len());
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
            });
            let result = download_image_bytes(&client, &url).and_then(|bytes| {
                if bytes.len() > MAX_IMAGE_BYTES {
                    Err("too large".into())
                } else {
                    Ok(bytes)
                }
            });
            assert_eq!(result.is_ok(), expected);
            server.join().unwrap();
        }
    }
}
