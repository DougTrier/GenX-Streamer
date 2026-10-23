//! Pure Commons Action API decoding. No request, media permission or codec admission.
//!
//! Search uses formatversion=2, generator=search, namespace 6, gsrlimit=4 and
//! filetype:video; fetch timestamp|url|size|mime|sha1|derivatives|extmetadata|
//! mediatype|metadata with prop=videoinfo and vilimit=1. Preserve the complete
//! bounded continue object, not a guessed page number. The native owner must
//! reconstruct its allowlisted API query and use maxlag=5, polite pacing and an
//! operator-approved public contact in its identifiable User-Agent.
use crate::archive_provider_contract::{
    Provider, ProviderItem, ProviderVariant, SearchHit, SearchPage,
};
use reqwest::Url;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const ERROR: &str = "archive-commons-metadata-invalid";
const API: &str = "https://commons.wikimedia.org/w/api.php";
const PROPS: &str = "timestamp|url|size|mime|sha1|derivatives|extmetadata|mediatype|metadata";
const MAX_PAGE_BYTES: usize = 512 * 1024;

fn fail<T>() -> Result<T, String> {
    Err(ERROR.into())
}
fn bounded_json(value: &Value, limit: usize) -> Result<(), String> {
    if serde_json::to_vec(value).map_err(|_| ERROR)?.len() > limit {
        return fail();
    }
    Ok(())
}
fn format_character(c: char) -> bool {
    matches!(c as u32, 0x00ad | 0x061c | 0x06dd | 0x070f | 0x0890..=0x0891
        | 0x08e2 | 0x180e | 0x200b..=0x200f | 0x202a..=0x202e | 0x2060..=0x2064
        | 0x2066..=0x206f | 0xfeff | 0xfff9..=0xfffb | 0x110bd | 0x110cd
        | 0x13430..=0x1343f | 0x1bca0..=0x1bca3 | 0x1d173..=0x1d17a
        | 0xe0001 | 0xe0020..=0xe007f)
}
fn raw_text(value: &str, max: usize) -> Result<String, String> {
    if value.trim().is_empty()
        || value.len() > max
        || value.chars().any(|c| c.is_control() || format_character(c))
    {
        return fail();
    }
    Ok(value.to_owned())
}
fn decode_entity(entity: &str) -> Option<char> {
    match entity {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" | "#39" => Some('\''),
        "nbsp" => Some(' '),
        _ => entity
            .strip_prefix("#x")
            .or_else(|| entity.strip_prefix("#X"))
            .and_then(|s| u32::from_str_radix(s, 16).ok())
            .or_else(|| entity.strip_prefix('#').and_then(|s| s.parse().ok()))
            .and_then(char::from_u32),
    }
}
fn tag_end(value: &str) -> Option<usize> {
    let mut quote = None;
    for (index, c) in value.char_indices() {
        match (quote, c) {
            (Some(q), c) if q == c => quote = None,
            (None, '\'' | '"') => quote = Some(c),
            (None, '>') => return Some(index),
            _ => {}
        }
    }
    None
}
/// Metadata is always rendered as text. Strip markup, comments and script/style
/// bodies, decode entities once, remove formatting/control characters, and fail
/// on overflow rather than silently shortening attribution or identity.
fn plain(value: &str, max: usize) -> Result<Option<String>, String> {
    if value.len() > 65_536 {
        return fail();
    }
    let lower = value.to_ascii_lowercase();
    let mut out = String::new();
    let mut at = 0;
    while at < value.len() {
        let rest = &value[at..];
        if rest.starts_with("<!--") {
            at = lower[at + 4..]
                .find("-->")
                .map_or(value.len(), |n| at + 4 + n + 3);
            out.push(' ');
            continue;
        }
        if rest.starts_with('<') {
            let Some(end) = tag_end(rest) else {
                return fail();
            };
            let tag = lower[at + 1..at + end].trim();
            let name = tag.split(|c: char| c.is_whitespace() || c == '/').next();
            if matches!(name, Some("script" | "style")) {
                let close = format!("</{}", name.unwrap_or_default());
                at = lower[at + end + 1..]
                    .find(&close)
                    .and_then(|n| {
                        let start = at + end + 1 + n;
                        lower[start..].find('>').map(|tail| start + tail + 1)
                    })
                    .unwrap_or(value.len());
            } else {
                at += end + 1;
            }
            out.push(' ');
            continue;
        }
        if rest.starts_with('&') {
            if let Some(end) = rest.find(';').filter(|n| *n <= 16) {
                if let Some(c) = decode_entity(&rest[1..end]) {
                    if !c.is_control() && !format_character(c) {
                        out.push(c);
                    }
                    at += end + 1;
                    continue;
                }
            }
        }
        let c = rest.chars().next().ok_or(ERROR)?;
        if c.is_whitespace() || c.is_control() || format_character(c) {
            out.push(' ');
        } else {
            out.push(c);
        }
        at += c.len_utf8();
    }
    let text = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.len() > max {
        return fail();
    }
    Ok((!text.is_empty()).then_some(text))
}
fn ext(info: &Value, key: &str, max: usize) -> Result<Option<String>, String> {
    match info.pointer(&format!("/extmetadata/{key}/value")) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => plain(s, max),
        _ => fail(),
    }
}
fn page_id(value: &Value) -> Result<String, String> {
    value
        .get("pageid")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
        .map(|id| id.to_string())
        .ok_or_else(|| ERROR.into())
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 16
        && !id.starts_with('0')
        && id.bytes().all(|b| b.is_ascii_digit())
        && id.parse::<u64>().is_ok_and(|n| n <= 9_007_199_254_740_991)
}
fn metadata_url(id: &str) -> String {
    let mut url = Url::parse(API).expect("constant Commons API URL");
    url.query_pairs_mut().extend_pairs([
        ("action", "query"),
        ("format", "json"),
        ("formatversion", "2"),
        ("pageids", id),
        ("prop", "videoinfo"),
        ("viprop", PROPS),
        ("vilimit", "1"),
        ("viextmetadatalanguage", "en"),
        ("maxlag", "5"),
    ]);
    url.into()
}
fn source_url(id: &str) -> String {
    format!("https://commons.wikimedia.org/w/index.php?curid={id}")
}
fn media_url(value: &Value, field: &str) -> Result<String, String> {
    let text = raw_text(value.get(field).and_then(Value::as_str).ok_or(ERROR)?, 4096)?;
    let url = Url::parse(&text).map_err(|_| ERROR)?;
    if url.scheme() != "https"
        || url.host_str() != Some("upload.wikimedia.org")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
        || url.fragment().is_some()
        || !url.path().starts_with("/wikipedia/commons/")
        || url.path().ends_with('/')
    {
        return fail();
    }
    // Exact original URLs currently carry these public attribution parameters.
    // Keep them byte-for-byte; this is not permission to remove arbitrary query.
    let mut keys = BTreeSet::new();
    for (key, val) in url.query_pairs() {
        if !keys.insert(key.to_string())
            || !matches!(
                (key.as_ref(), val.as_ref()),
                ("utm_source", "commons.wikimedia.org")
                    | ("utm_campaign", "imageinfo" | "api")
                    | ("utm_content", "original")
            )
        {
            return fail();
        }
    }
    Ok(text)
}
fn optional_string(value: &Value, key: &str, max: usize) -> Result<Option<String>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(raw_text(s, max)?)),
        _ => fail(),
    }
}
fn decimal(value: &Value, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .map(|n| Some(n.to_string()))
            .ok_or_else(|| ERROR.into()),
    }
}
fn dimension(value: &Value, key: &str) -> Result<Option<u32>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n > 0 && *n <= 32_768)
            .map(Some)
            .ok_or_else(|| ERROR.into()),
    }
}
fn duration(value: &Value) -> Result<Option<f64>, String> {
    match value.get("duration") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_f64()
            .filter(|n| n.is_finite() && *n > 0.0 && *n <= 604_800.0)
            .map(Some)
            .ok_or_else(|| ERROR.into()),
    }
}
fn digest(value: &Value) -> Result<Option<String>, String> {
    let hash = optional_string(value, "sha1", 40)?;
    if hash
        .as_ref()
        .is_some_and(|s| s.len() != 40 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return fail();
    }
    Ok(hash.map(|s| s.to_ascii_lowercase()))
}
fn named<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    value.as_array()?.iter().find_map(|v| {
        (v.get("name")?.as_str()? == name)
            .then(|| v.get("value"))
            .flatten()
    })
}
fn original_codec(info: &Value, stream: &str) -> Result<Option<String>, String> {
    let Some(value) = info
        .get("metadata")
        .and_then(|m| named(m, stream))
        .and_then(|m| named(m, "dataformat"))
    else {
        return Ok(None);
    };
    let value = raw_text(value.as_str().ok_or(ERROR)?, 128)?;
    let normalized = match value.as_str() {
        "V_VP8" => "vp8",
        "V_VP9" => "vp9",
        "V_AV1" => "av1",
        "V_THEORA" => "theora",
        "A_OPUS" => "opus",
        "A_VORBIS" => "vorbis",
        "V_MPEG4/ISO/AVC" => "h264",
        "A_AAC" => "aac",
        _ => &value,
    };
    Ok(Some(normalized.to_owned()))
}
fn mime_codecs(raw: &str) -> Result<(String, Option<String>, Option<String>), String> {
    raw_text(raw, 512)?;
    let mut parts = raw.split(';');
    let mime = parts.next().ok_or(ERROR)?.trim().to_ascii_lowercase();
    if mime.is_empty() || !mime.contains('/') {
        return fail();
    }
    let mut video = None;
    let mut audio = None;
    for parameter in parts {
        let Some((key, value)) = parameter.trim().split_once('=') else {
            continue;
        };
        if !key.eq_ignore_ascii_case("codecs") {
            continue;
        }
        for codec in value.trim().trim_matches('"').split(',') {
            let codec = codec.trim().to_ascii_lowercase();
            if codec.is_empty() || codec.len() > 128 {
                return fail();
            }
            if matches!(codec.as_str(), "opus" | "vorbis" | "aac" | "mp3" | "flac")
                || codec.starts_with("mp4a.")
            {
                if audio.replace(codec).is_some() {
                    return fail();
                }
            } else if video.replace(codec).is_some() {
                return fail();
            }
        }
    }
    Ok((mime, video, audio))
}
fn file_name(target: &str) -> Result<String, String> {
    let url = Url::parse(target).map_err(|_| ERROR)?;
    let name = url.path().rsplit('/').next().ok_or(ERROR)?;
    let mut out = Vec::new();
    let bytes = name.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let h = bytes.get(at + 1..at + 3).ok_or(ERROR)?;
            let text = std::str::from_utf8(h).map_err(|_| ERROR)?;
            out.push(u8::from_str_radix(text, 16).map_err(|_| ERROR)?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    let name = String::from_utf8(out).map_err(|_| ERROR)?;
    if name.contains(['/', '\\']) {
        return fail();
    }
    raw_text(&name, 1024)
}
fn checked_page(page: &Value) -> Result<(&Value, String), String> {
    bounded_json(page, MAX_PAGE_BYTES)?;
    let id = page_id(page)?;
    if page.get("ns").and_then(Value::as_u64) != Some(6)
        || page.get("missing").is_some()
        || page.get("invalid").is_some()
        || page.get("imagerepository").and_then(Value::as_str) != Some("local")
    {
        return fail();
    }
    let title = page.get("title").and_then(Value::as_str).ok_or(ERROR)?;
    raw_text(title.strip_prefix("File:").ok_or(ERROR)?, 1024)?;
    let info = page
        .get("videoinfo")
        .and_then(Value::as_array)
        .ok_or(ERROR)?;
    if info.len() != 1 || info[0].get("filehidden").is_some() {
        return fail();
    }
    if info[0]
        .get("mediatype")
        .and_then(Value::as_str)
        .is_some_and(|s| s != "VIDEO")
    {
        return fail();
    }
    Ok((&info[0], id))
}

pub(crate) fn parse_search(value: &Value) -> Result<SearchPage, String> {
    bounded_json(value, 2 * 1024 * 1024)?;
    if value.get("error").is_some() || value.get("errors").is_some() {
        return fail();
    }
    let pages: Vec<&Value> = match value.pointer("/query/pages") {
        Some(Value::Array(pages)) if pages.len() <= 4 => pages.iter().collect(),
        None if value.get("batchcomplete") == Some(&Value::Bool(true))
            && value.get("query").is_none() =>
        {
            Vec::new()
        }
        _ => return fail(),
    };
    let mut hits = Vec::new();
    let mut seen = BTreeSet::new();
    for page in pages {
        let item = parse_item(&page_id(page)?, page)?;
        if !seen.insert(item.item_id.clone()) {
            return fail();
        }
        hits.push(SearchHit {
            metadata_url: item.metadata_url,
            source_url: item.source_url,
            item_id: item.item_id,
            title: item.title,
            search_document: page.clone(),
        });
    }
    let next_cursor = match value.get("continue") {
        None => None,
        Some(v) => {
            let object = v.as_object().ok_or(ERROR)?;
            if object.len() != 2
                || object
                    .get("continue")
                    .and_then(Value::as_str)
                    .is_none_or(|s| {
                        s.is_empty() || s.len() > 128 || s.chars().any(char::is_control)
                    })
                || object
                    .get("gsroffset")
                    .and_then(Value::as_u64)
                    .is_none_or(|n| n > 10_000)
            {
                return fail();
            }
            let encoded = serde_json::to_string(v).map_err(|_| ERROR)?;
            if encoded.len() > 2048 {
                return fail();
            }
            Some(encoded)
        }
    };
    Ok(SearchPage { hits, next_cursor })
}

pub(crate) fn parse_item(expected_id: &str, value: &Value) -> Result<ProviderItem, String> {
    if !valid_id(expected_id) || value.get("error").is_some() {
        return fail();
    }
    let page = if let Some(pages) = value.pointer("/query/pages").and_then(Value::as_array) {
        if pages.len() != 1 {
            return fail();
        }
        &pages[0]
    } else {
        value
    };
    let (info, id) = checked_page(page)?;
    if id != expected_id {
        return fail();
    }
    let original_name = page
        .get("title")
        .and_then(Value::as_str)
        .and_then(|s| s.strip_prefix("File:"))
        .ok_or(ERROR)?;
    let title = match ext(info, "ObjectName", 512)? {
        Some(title) => title,
        None => plain(original_name, 512)?.ok_or(ERROR)?,
    };
    let original_url = media_url(info, "url")?;
    let sha1 = digest(info)?;
    let timestamp = optional_string(info, "timestamp", 64)?;
    if sha1.is_none() && timestamp.is_none() {
        return fail();
    }
    let original_mime = optional_string(info, "mime", 128)?;
    let mut variants = vec![ProviderVariant {
        asset_id: id.clone(),
        variant_id: "original".into(),
        file_name: original_name.to_owned(),
        target_url: original_url,
        title: None,
        mime_type: original_mime,
        video_codec: original_codec(info, "video")?,
        audio_codec: original_codec(info, "audio")?,
        size_bytes: decimal(info, "size")?,
        sha1: sha1.clone(),
        duration_seconds: duration(info)?,
        width: dimension(info, "width")?,
        height: dimension(info, "height")?,
        representation_role: Some("original".into()),
        content_role: None,
        original_variant_id: None,
    }];
    if let Some(derivatives) = info.get("derivatives") {
        let derivatives = derivatives.as_array().ok_or(ERROR)?;
        if derivatives.len() > 128 {
            return fail();
        }
        let mut seen = BTreeSet::new();
        seen.insert("original".to_owned());
        for derivative in derivatives {
            let target_url = media_url(derivative, "src")?;
            let key = optional_string(derivative, "transcodekey", 256)?;
            let variant_id = key.as_ref().map_or_else(
                || format!("url:{:x}", Sha256::digest(target_url.as_bytes())),
                |key| format!("transcode:{key}"),
            );
            if !seen.insert(variant_id.clone()) {
                return fail();
            }
            let (mime, video_codec, audio_codec) = mime_codecs(
                derivative
                    .get("type")
                    .and_then(Value::as_str)
                    .ok_or(ERROR)?,
            )?;
            variants.push(ProviderVariant {
                asset_id: id.clone(),
                variant_id,
                file_name: file_name(&target_url)?,
                target_url,
                title: None,
                mime_type: Some(mime),
                video_codec,
                audio_codec,
                // A source/derivative edge does not transfer integrity or timing.
                size_bytes: decimal(derivative, "size")?,
                sha1: digest(derivative)?,
                duration_seconds: duration(derivative)?,
                width: dimension(derivative, "width")?,
                height: dimension(derivative, "height")?,
                representation_role: Some(
                    if key.is_some() {
                        "derivative"
                    } else {
                        "unknown"
                    }
                    .into(),
                ),
                content_role: None,
                original_variant_id: Some("original".into()),
            });
        }
    }
    let mut rights = Vec::new();
    for (field, label) in [
        ("LicenseShortName", "License"),
        ("UsageTerms", "Usage"),
        ("Restrictions", "Restrictions"),
        ("Copyrighted", "Copyrighted"),
        ("AttributionRequired", "Attribution required"),
    ] {
        if let Some(text) = ext(info, field, 2048)? {
            rights.push(format!("{label}: {text}"));
        }
    }
    let rights = plain(
        &rights.join("; ").replace('&', "&amp;").replace('<', "&lt;"),
        4096,
    )?;
    let mut attribution = Vec::new();
    for field in ["Attribution", "Artist", "Credit"] {
        if let Some(text) = ext(info, field, 2048)? {
            attribution.push(text);
        }
    }
    let attribution = attribution.join("; ");
    if attribution.len() > 4096 {
        return fail();
    }
    let creator = ext(info, "Artist", 256)?.into_iter().collect();
    let subjects = ext(info, "Categories", 8192)?.map_or_else(Vec::new, |s| {
        s.split('|')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    });
    if subjects.len() > 32 || subjects.iter().any(|s| s.len() > 256) {
        return fail();
    }
    let license_url = ext(info, "LicenseUrl", 4096)?
        .map(|text| {
            let url = Url::parse(&text).map_err(|_| ERROR)?;
            if url.scheme() != "https"
                || !url.username().is_empty()
                || url.password().is_some()
                || url.host_str().is_none()
                || url.fragment().is_some()
            {
                return fail();
            }
            Ok(text)
        })
        .transpose()?;
    Ok(ProviderItem {
        provider: Provider::Commons,
        item_id: id.clone(),
        title,
        source_url: source_url(&id),
        metadata_url: metadata_url(&id),
        description: ext(info, "ImageDescription", 4096)?,
        subjects,
        creators: creator,
        // Extmetadata language is the metadata display language, not soundtrack.
        languages: Vec::new(),
        release_year: None,
        date_claims: None,
        content_type: "unknown".into(),
        rights,
        license_url,
        attribution: (!attribution.is_empty()).then_some(attribution),
        access_restricted: Some(false),
        download_allowed: Some(true),
        revision: Some(format!(
            "{}|{}",
            sha1.unwrap_or_default(),
            timestamp.unwrap_or_default()
        )),
        variants,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Shape/values from anonymous official pageid=91010657 metadata observed
    // 2026-10-15. Reduced fixture, not a complete response or decoder proof.
    fn page() -> Value {
        json!({"pageid":91010657,"ns":6,"title":"File:Apollo.webm","imagerepository":"local",
          "videoinfo":[{"timestamp":"2020-06-07T10:54:12Z","size":1004160886,"width":1920,"height":1080,
            "duration":10950.101,"url":"https://upload.wikimedia.org/wikipedia/commons/8/83/Apollo.webm?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original",
            "sha1":"7aa691c65d4695bd367d9758680e271e1390cb43","mime":"video/webm","mediatype":"VIDEO",
            "metadata":[{"name":"video","value":[{"name":"dataformat","value":"V_VP9"}]},
              {"name":"audio","value":[{"name":"dataformat","value":"A_OPUS"},{"name":"language","value":"eng"}]}],
            "extmetadata":{"ObjectName":{"value":"Apollo 11"},"Artist":{"value":"<a href=\"https://nasa.gov\">NASA</a>"},
              "Credit":{"value":"NASA &amp; contributors"},"ImageDescription":{"value":"A <b>moonwalk</b>."},
              "DateTimeOriginal":{"value":"Taken in July 1969"},"DateTime":{"value":"2020-06-07"},
              "LicenseShortName":{"value":"Public domain"},"AttributionRequired":{"value":"false"},
              "Categories":{"value":"Videos of 1969|Space exploration"}},
            "derivatives":[{"src":"https://upload.wikimedia.org/wikipedia/commons/transcoded/8/83/Apollo.webm/Apollo.webm.240p.vp9.webm",
              "type":"video/webm; codecs=\"vp9, opus\"","transcodekey":"240p.vp9.webm","width":426,"height":240},
              {"src":"https://upload.wikimedia.org/wikipedia/commons/transcoded/8/83/Apollo.webm/Apollo.webm.360p.mpeg4.mov",
              "type":"video/quicktime; codecs=\"mp4v\"","transcodekey":"360p.mpeg4.mov","width":640,"height":360}]}]})
    }
    #[test]
    fn commons_original_and_unsupported_derivatives_keep_separate_byte_facts() {
        let item = parse_item("91010657", &page()).unwrap();
        assert_eq!(item.variants.len(), 3);
        assert_eq!(item.variants[0].size_bytes.as_deref(), Some("1004160886"));
        assert_eq!(item.variants[0].video_codec.as_deref(), Some("vp9"));
        assert_eq!(item.variants[0].audio_codec.as_deref(), Some("opus"));
        assert!(item.variants[1].size_bytes.is_none());
        assert!(item.variants[1].sha1.is_none());
        assert!(item.variants[1].duration_seconds.is_none());
        assert_eq!(item.variants[2].video_codec.as_deref(), Some("mp4v"));
        assert_eq!(
            item.variants[2].mime_type.as_deref(),
            Some("video/quicktime")
        );
        assert!(item.variants.iter().all(|v| v.content_role.is_none()));
    }
    #[test]
    fn commons_metadata_language_and_upload_capture_dates_do_not_become_audio_or_release() {
        let item = parse_item("91010657", &page()).unwrap();
        assert!(item.languages.is_empty());
        assert!(item.release_year.is_none());
        assert_eq!(item.creators, vec!["NASA"]);
        assert!(item.attribution.unwrap().contains("NASA & contributors"));
        assert_eq!(item.description.as_deref(), Some("A moonwalk ."));
    }
    #[test]
    fn commons_html_never_preserves_tags_scripts_controls_or_recursive_entities() {
        assert_eq!(
            plain(
                "<script>bad()</script><style>x{}</style>A &amp; B &#x202e; &#65;<!--x-->",
                100
            )
            .unwrap()
            .as_deref(),
            Some("A & B A")
        );
        assert_eq!(
            plain("&amp;lt;img&gt;", 100).unwrap().as_deref(),
            Some("&lt;img>")
        );
        assert!(plain("<unclosed", 100).is_err());
        assert!(plain("<b>long</b>", 2).is_err());
        assert_eq!(
            plain("<span title=\"x > garbage\">Good</span>", 100)
                .unwrap()
                .as_deref(),
            Some("Good")
        );
    }
    #[test]
    fn commons_search_keeps_exact_cursor_and_page_document() {
        let page = page();
        let result = parse_search(&json!({"query":{"pages":[page.clone()]},"continue":{"gsroffset":4,"continue":"gsroffset||"}})).unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].search_document, page);
        assert_eq!(
            serde_json::from_str::<Value>(&result.next_cursor.unwrap()).unwrap(),
            json!({"gsroffset":4,"continue":"gsroffset||"})
        );
        assert!(result.hits[0].metadata_url.starts_with(API));
    }
    #[test]
    fn commons_search_refuses_api_errors_malformed_and_oversized_or_duplicate_pages() {
        assert!(parse_search(&json!({"error":{"code":"maxlag"}})).is_err());
        assert!(parse_search(&json!({"query":{}})).is_err());
        assert!(parse_search(&json!({"query":{"pages":[page(),page()]}})).is_err());
        assert!(
            parse_search(&json!({"query":{"pages":[page(),page(),page(),page(),page()]}})).is_err()
        );
        assert!(parse_search(&json!({"batchcomplete":true}))
            .unwrap()
            .hits
            .is_empty());
    }
    #[test]
    fn commons_search_refuses_unrecognized_continuation_not_silent_exhaustion() {
        for cursor in [
            json!({"gsroffset":4}),
            json!({"gsroffset":4,"continue":"x","vicontinue":"hidden"}),
            json!({"gsroffset":10001,"continue":"x"}),
            json!({"gsroffset":"4","continue":"x"}),
        ] {
            assert!(parse_search(&json!({"query":{"pages":[]},"continue":cursor})).is_err());
        }
    }
    #[test]
    fn commons_expected_identity_namespace_and_revision_are_required() {
        assert!(parse_item("0123", &page()).is_err());
        assert!(parse_item("9", &page()).is_err());
        let mut v = page();
        v["ns"] = json!(0);
        assert!(parse_item("91010657", &v).is_err());
        let mut v = page();
        v["videoinfo"][0].as_object_mut().unwrap().remove("sha1");
        v["videoinfo"][0]
            .as_object_mut()
            .unwrap()
            .remove("timestamp");
        assert!(parse_item("91010657", &v).is_err());
    }
    #[test]
    fn commons_hidden_or_missing_files_are_not_an_empty_success() {
        let mut v = page();
        v["missing"] = json!(true);
        assert!(parse_item("91010657", &v).is_err());
        let mut v = page();
        v["videoinfo"][0]["filehidden"] = json!(true);
        assert!(parse_item("91010657", &v).is_err());
        let mut v = page();
        v["videoinfo"] = json!([]);
        assert!(parse_item("91010657", &v).is_err());
    }
    #[test]
    fn commons_exact_target_rejects_credentials_host_path_query_and_encoded_filename_escape() {
        for url in [
            "http://upload.wikimedia.org/wikipedia/commons/a.webm",
            "https://evil.example/wikipedia/commons/a.webm",
            "https://u:p@upload.wikimedia.org/wikipedia/commons/a.webm",
            "https://upload.wikimedia.org/wikipedia/en/a.webm",
            "https://upload.wikimedia.org/wikipedia/commons/a.webm?token=secret",
            "https://upload.wikimedia.org/wikipedia/commons/a.webm#fragment",
        ] {
            let mut v = page();
            v["videoinfo"][0]["url"] = json!(url);
            assert!(parse_item("91010657", &v).is_err());
        }
        assert!(file_name("https://upload.wikimedia.org/wikipedia/commons/a%2fb.webm").is_err());
        assert!(file_name("https://upload.wikimedia.org/wikipedia/commons/a%00.webm").is_err());
    }
    #[test]
    fn commons_size_digest_dimensions_and_derivative_count_are_not_coerced_or_truncated() {
        for field in ["size", "width", "duration"] {
            let mut v = page();
            v["videoinfo"][0][field] = json!(-1);
            assert!(parse_item("91010657", &v).is_err());
        }
        let mut v = page();
        v["videoinfo"][0]["sha1"] = json!("not-a-digest");
        assert!(parse_item("91010657", &v).is_err());
        let mut v = page();
        let d = v["videoinfo"][0]["derivatives"][0].clone();
        v["videoinfo"][0]["derivatives"] = json!(vec![d; 129]);
        assert!(parse_item("91010657", &v).is_err());
    }
    #[test]
    fn commons_fresh_query_envelope_accepts_only_one_exact_page() {
        assert!(parse_item("91010657", &json!({"query":{"pages":[page()]}})).is_ok());
        assert!(parse_item("91010657", &json!({"query":{"pages":[page(),page()]}})).is_err());
    }
    #[test]
    fn commons_unknown_rights_do_not_become_public_domain() {
        let mut v = page();
        v["videoinfo"][0]["extmetadata"] = json!({});
        let item = parse_item("91010657", &v).unwrap();
        assert!(item.rights.is_none());
        assert!(item.license_url.is_none());
        assert!(item.attribution.is_none());
        assert!(item.creators.is_empty());
    }
    #[test]
    fn commons_derivative_owns_only_its_explicit_integrity_metadata() {
        let mut v = page();
        v["videoinfo"][0]["derivatives"][0]["size"] = json!(12345);
        v["videoinfo"][0]["derivatives"][0]["sha1"] =
            json!("1111111111111111111111111111111111111111");
        v["videoinfo"][0]["derivatives"][0]["duration"] = json!(9.5);
        let item = parse_item("91010657", &v).unwrap();
        assert_eq!(item.variants[1].size_bytes.as_deref(), Some("12345"));
        assert_eq!(
            item.variants[1].sha1.as_deref(),
            Some("1111111111111111111111111111111111111111")
        );
        assert_eq!(item.variants[1].duration_seconds, Some(9.5));
        assert_ne!(item.variants[0].sha1, item.variants[1].sha1);
    }
    #[test]
    fn commons_identity_and_attribution_overflow_are_reported_not_truncated() {
        let mut v = page();
        v["videoinfo"][0]["extmetadata"]["Credit"]["value"] = json!("a".repeat(2049));
        assert!(parse_item("91010657", &v).is_err());
        let mut v = page();
        v["videoinfo"][0]["extmetadata"]["ObjectName"]["value"] = json!("a".repeat(513));
        assert!(parse_item("91010657", &v).is_err());
        let mut v = page();
        v["videoinfo"][0]["derivatives"][0]["transcodekey"] = json!("a\u{202e}b");
        assert!(parse_item("91010657", &v).is_err());
    }
}
