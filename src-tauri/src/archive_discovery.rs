// Copyright 2026 Doug Trier
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Explicit bounded Archive search steps; no scheduled acquisition or bundled records.
use crate::{
    archive_catalog as catalog,
    scan_manifest_work::{self, Context},
};
use reqwest::{redirect::Policy, Client, Url};
use serde::Deserialize;
use serde_json::Value;
use std::{
    net::ToSocketAddrs,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::time::Instant;
static DISCOVERY_OWNER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StepRequest {
    pub schema_version: u32,
    pub request_id: String,
    pub expected_revision: String,
    pub year: Option<i64>,
    #[serde(default)]
    pub decade: Option<i64>,
    pub page: u32,
    pub query: String,
    pub explicit_action: bool,
    #[serde(default)]
    pub restart: bool,
    #[serde(default)]
    pub view: Option<catalog::DiscoveryView>,
}
fn validate(r: &StepRequest) -> Result<(), String> {
    if r.schema_version != 1
        || !catalog::text(&r.request_id, 256)
        || !r.explicit_action
        || !(1..=20).contains(&r.page)
        || !catalog::valid_decade(r.decade)
        || r.year
            .zip(r.decade)
            .is_some_and(|(y, d)| !(d..=catalog::decade_end(d)).contains(&y))
        || r.query.len() > 256
        || r.query.chars().any(char::is_control)
        || r.year.is_some_and(|y| !(1960..=1999).contains(&y))
        || (r.year.is_none() && r.query.trim().is_empty())
    {
        return Err("archive-discovery-invalid".into());
    }
    if let Some(view) = &r.view {
        view.validate()?;
    }
    catalog::revision(&r.expected_revision)?;
    Ok(())
}
fn check(owner: &Context, deadline: Instant) -> Result<(), String> {
    owner.check()?;
    if Instant::now() >= deadline {
        Err("archive-request-timeout".into())
    } else {
        Ok(())
    }
}
async fn client(owner: &Arc<Context>, deadline: Instant) -> Result<Client, String> {
    client_for_host(owner, deadline, "archive.org").await
}
async fn client_for_host(
    owner: &Arc<Context>,
    deadline: Instant,
    host: &str,
) -> Result<Client, String> {
    check(owner, deadline)?;
    let dns_host = host.to_owned();
    let mut task = tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for address in (dns_host.as_str(), 443)
            .to_socket_addrs()
            .map_err(|_| "archive-dns-unavailable")?
        {
            if out.len() >= 128 || !crate::sharing_policy::public_upstream(address.ip()) {
                return Err("archive-destination-refused");
            }
            out.push(address);
        }
        if out.is_empty() {
            return Err("archive-dns-unavailable");
        }
        Ok(out)
    });
    let addresses = loop {
        if let Err(error) = check(owner, deadline) {
            let _ = task.await;
            return Err(error);
        }
        tokio::select! {
            r=&mut task => {
                let result=r.map_err(|_|"archive-dns-unavailable")?.map_err(str::to_owned)?;
                check(owner,deadline)?;
                break result;
            }
            _=tokio::time::sleep(Duration::from_millis(50)) => {
            }
        }
    };
    // OS DNS is joined on cancellation/expiry; admission deadline is not an OS kill.
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(5))
        .user_agent("GenX-Streamer/0.1 (explicit archive search)")
        .build()
        .map_err(|_| "archive-client-unavailable".into())
}
async fn json(
    client: &Client,
    url: Url,
    owner: &Context,
    deadline: Instant,
    budget: &AtomicUsize,
) -> Result<Value, String> {
    check(owner, deadline)?;
    let task = async {
        let mut response = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|_| "archive-network-unavailable".to_owned())?;
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err("archive-rate-limited".into());
        }
        if response.status().is_server_error() {
            return Err("archive-server-unavailable".into());
        }
        if response
            .content_length()
            .is_some_and(|n| n > 2 * 1024 * 1024)
        {
            return Err("archive-response-limit".into());
        }
        if response.status() != reqwest::StatusCode::OK
            || response.url() != &url
            || response
                .headers()
                .get(reqwest::header::CONTENT_ENCODING)
                .is_some_and(|h| !h.to_str().is_ok_and(|s| s.eq_ignore_ascii_case("identity")))
        {
            return Err("archive-response-refused".into());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "archive-network-unavailable".to_owned())?
        {
            check(owner, deadline)?;
            if body.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err("archive-response-limit".into());
            }
            let previous = budget.fetch_add(chunk.len(), Ordering::SeqCst);
            if previous + chunk.len() > 20 * 1024 * 1024 {
                return Err("archive-response-limit".into());
            }
            body.extend_from_slice(&chunk);
        }
        check(owner, deadline)?;
        serde_json::from_slice(&body).map_err(|_| "archive-metadata-invalid".into())
    };
    // Finite API requests retain no detached readers after timeout; caller joins
    // every spawned metadata task before releasing the native owner.
    tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), task)
        .await
        .map_err(|_| "archive-request-timeout".to_owned())?
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && s.as_bytes()[0].is_ascii_alphanumeric()
}
fn string(v: &Value, key: &str, max: usize) -> Option<String> {
    v.get(key)?
        .as_str()
        .filter(|s| catalog::text(s, max))
        .map(str::to_owned)
}
fn year(v: &Value) -> Option<i64> {
    // Original item date/year metadata only. Never addeddate/publicdate/upload.
    for key in ["year", "date"] {
        let Some(raw) = v.get(key) else {
            continue;
        };
        let Some(text) = raw
            .as_str()
            .map(str::to_owned)
            .or_else(|| raw.as_u64().map(|n| n.to_string()))
        else {
            continue;
        };
        if text.len() >= 4
            && text.as_bytes()[..4].iter().all(u8::is_ascii_digit)
            && (text.len() == 4 || text.as_bytes()[4] == b'-')
        {
            if let Ok(y) = text[..4].parse::<i64>() {
                if (1888..=2100).contains(&y) {
                    return Some(y);
                }
            }
        }
    }
    None
}
fn duration(v: &Value) -> Option<f64> {
    let raw = v.get("length")?;
    let seconds = raw.as_f64().or_else(|| {
        let value = raw.as_str()?.trim();
        if value.is_empty()
            || value.len() > 32
            || !value
                .bytes()
                .all(|b| b.is_ascii_digit() || b == b'.' || b == b':')
        {
            return None;
        }
        if !value.contains(':') {
            return value.parse::<f64>().ok();
        }
        let parts: Vec<&str> = value.split(':').collect();
        if !(2..=3).contains(&parts.len()) {
            return None;
        }
        let seconds = parts.last()?.parse::<f64>().ok()?;
        if !seconds.is_finite() || !(0.0..60.0).contains(&seconds) {
            return None;
        }
        let minutes = parts[parts.len() - 2].parse::<u64>().ok()?;
        if parts.len() == 3 {
            if minutes >= 60 {
                return None;
            }
            let hours = parts[0].parse::<u64>().ok()?;
            Some(
                hours
                    .checked_mul(3600)?
                    .checked_add(minutes.checked_mul(60)?)? as f64
                    + seconds,
            )
        } else {
            Some(minutes.checked_mul(60)? as f64 + seconds)
        }
    })?;
    if seconds.is_finite() && seconds > 0.0 && seconds <= 7.0 * 86400.0 {
        Some(seconds)
    } else {
        None
    }
}
fn servers(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for key in ["d1", "d2", "server"] {
        if let Some(s) = v.get(key).and_then(Value::as_str) {
            if s.len() <= 253
                && s.ends_with(".archive.org")
                && s.starts_with("ia")
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
                && !out.iter().any(|x| x == s)
            {
                out.push(s.to_owned());
            }
        }
    }
    out
}
enum Metadata {
    Title(Box<catalog::PreparedTitle>),
    Deleted,
    UnknownYear,
    Unavailable,
}
fn extended_deleted(v: &Value) -> Result<bool, String> {
    if let Some(code) = v.get("errcode") {
        match code.as_u64() {
            Some(104) => return Ok(true),
            Some(0) if v.get("error").is_none() => {}
            _ => return Err("archive-metadata-unavailable".into()),
        }
    }
    if v.get("error").is_some() {
        return Err("archive-metadata-unavailable".into());
    }
    Ok(false)
}
fn listed_artwork(id: &str, files: &[Value]) -> Option<catalog::Artwork> {
    files
        .iter()
        .filter_map(|file| {
            let name = file.get("name")?.as_str()?;
            let mime = match name {
                "__ia_thumb.jpg" => "image/jpeg",
                "__ia_thumb.png" => "image/png",
                _ => return None,
            };
            if file.get("format").and_then(Value::as_str) != Some("Item Tile")
                || file
                    .get("private")
                    .is_some_and(|v| v.as_bool() == Some(true) || v.as_str() == Some("true"))
            {
                return None;
            }
            let image = catalog::Artwork {
                item_id: id.into(),
                file_name: name.into(),
                size_bytes: file.get("size")?.as_str()?.into(),
                mime_type: mime.into(),
                provider_sha1: file.get("sha1").and_then(Value::as_str).map(str::to_owned),
            };
            image.validate().then_some(image)
        })
        .next()
}
// Both official labels explicitly claim the codec. Generic MPEG4/container or
// extension labels are insufficient. Fresh playback proof reuses this parser.
fn h264_format(value: &str) -> bool {
    value.eq_ignore_ascii_case("h.264") || value.eq_ignore_ascii_case("h.264 IA")
}
fn parse_metadata(
    id: &str,
    downloads: i64,
    v: Value,
    requested_year: Option<i64>,
) -> Result<Metadata, String> {
    parse_metadata_page(id, downloads, v, requested_year, None, 0)
}
fn parse_metadata_page(
    id: &str,
    downloads: i64,
    v: Value,
    requested_year: Option<i64>,
    partial: Option<catalog::PreparedPage>,
    provider_start: u32,
) -> Result<Metadata, String> {
    if extended_deleted(&v)? {
        return Ok(Metadata::Deleted);
    }
    let Some(metadata) = v.get("metadata") else {
        return Ok(Metadata::Unavailable);
    };
    if metadata
        .get("identifier")
        .and_then(Value::as_str)
        .is_some_and(|s| s != id)
        || metadata.get("mediatype").and_then(Value::as_str) != Some("movies")
        || metadata
            .get("access-restricted-item")
            .is_some_and(|x| x.as_bool() == Some(true) || x.as_str() == Some("true"))
    {
        return Ok(Metadata::Unavailable);
    }
    let released = year(metadata);
    if requested_year.is_some() && released != requested_year {
        return Ok(Metadata::UnknownYear);
    }
    let title = string(metadata, "title", 512).ok_or("archive-title-invalid")?;
    let field = |key: &str| -> Result<String, String> {
        let mut out = String::new();
        if let Some(value) = metadata.get(key) {
            append_search_aliases(&mut out, value)?;
        }
        Ok(out.trim().to_owned())
    };
    let language = field("language")?;
    let languages: Vec<String> = language
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .take(17)
        .map(str::to_owned)
        .collect();
    if languages.len() > 16 || languages.iter().any(|s| !catalog::text(s, 128)) {
        return Err("archive-search-metadata-limit".into());
    }
    let mut search_metadata = catalog::SearchMetadata {
        title: title.clone(),
        series: field("series")?,
        subjects: field("subject")?,
        collections: field("collection")?,
        description: string(metadata, "description", 4096).unwrap_or_default(),
        languages,
        provider_type: field("type")?,
        artwork: None,
    };
    let files = v
        .get("files")
        .and_then(Value::as_array)
        .ok_or("archive-files-invalid")?;
    if files.len() > if partial.is_some() { 64 } else { 1000 }
        || (partial.is_none()
            && v.get("files_count")
                .and_then(Value::as_u64)
                .is_some_and(|n| n != files.len() as u64))
    {
        return Err("archive-file-limit".into());
    }
    search_metadata.artwork = listed_artwork(id, files);
    let mut names = Vec::new();
    let mut prepared = Vec::new();
    let mut originals = std::collections::HashSet::new();
    for (index, file) in files.iter().enumerate() {
        let name = string(file, "name", 1024).ok_or("archive-file-invalid")?;
        if name.starts_with('/')
            || name.contains('\\')
            || name
                .split('/')
                .any(|s| s == ".." || s == "." || s.is_empty())
            || names.contains(&name)
        {
            return Err("archive-file-invalid".into());
        }
        names.push(name.clone());
        if file
            .get("format")
            .and_then(Value::as_str)
            .is_none_or(|f| !h264_format(f))
        {
            continue;
        }
        if file
            .get("private")
            .is_some_and(|x| x.as_bool() == Some(true) || x.as_str() == Some("true"))
        {
            continue;
        }
        let size = file
            .get("size")
            .and_then(Value::as_str)
            .ok_or("archive-file-invalid")?;
        if size.is_empty()
            || size.len() > 19
            || !size.bytes().all(|b| b.is_ascii_digit())
            || (size.len() > 1 && size.starts_with('0'))
            || size
                .parse::<u64>()
                .ok()
                .is_none_or(|n| n == 0 || n > 64 * 1024 * 1024 * 1024)
        {
            return Err("archive-file-invalid".into());
        }
        let sha1 = file
            .get("sha1")
            .and_then(Value::as_str)
            .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(str::to_ascii_lowercase);
        let original = file
            .get("original")
            .and_then(Value::as_str)
            .filter(|s| catalog::text(s, 1024) && !s.contains("://"))
            .map(str::to_owned)
            .or_else(|| {
                (file.get("source").and_then(Value::as_str) == Some("original"))
                    .then(|| name.clone())
            });
        if let Some(original) = &original {
            originals.insert(original.clone());
        }
        prepared.push(catalog::PreparedFile {
            file_title: string(file, "title", 512),
            provider_index: partial.as_ref().map(|_| provider_start + index as u32),
            original,
            name,
            size: size.to_owned(),
            duration: duration(file),
            sha1,
        });
    }
    let series = catalog::content_type(Some(&search_metadata)) == catalog::ContentType::Tv;
    // A lone episode with a series label cannot consume a distinct-program
    // curation slot. Multi-original-file TV items are one provider item title;
    // unrelated uploads are never combined by title or the series label.
    if partial.is_none() && requested_year.is_some() && series && originals.len() < 2 {
        return Ok(Metadata::Unavailable);
    }
    let search_aliases = catalog::encode_search_metadata(&search_metadata)?;
    if search_aliases.len() > 16384 {
        return Err("archive-search-metadata-limit".into());
    }
    // Item identity is retained; never merge different uploads by a series label.
    Ok(Metadata::Title(Box::new(catalog::PreparedTitle {
        partial,
        item_id: id.to_owned(),
        title,
        search_aliases,
        kind: if series { "tv" } else { "movie" },
        year: released,
        rights: string(metadata, "rights", 2048).filter(|s| !s.contains("://")),
        downloads,
        servers: servers(&v),
        all_file_names: names,
        files: prepared,
    })))
}
fn append_search_aliases(out: &mut String, value: &Value) -> Result<(), String> {
    let values: Vec<&Value> = match value {
        Value::String(_) => vec![value],
        Value::Array(values) if values.len() <= 1000 => values.iter().collect(),
        Value::Null => return Ok(()),
        _ => return Err("archive-search-metadata-invalid".into()),
    };
    for value in values {
        let s = value.as_str().ok_or("archive-search-metadata-invalid")?;
        if s.trim().is_empty() {
            continue;
        }
        if !catalog::text(s, 2048) || out.len() + s.len() + 1 > 16384 {
            return Err("archive-search-metadata-limit".into());
        }
        out.push('\n');
        out.push_str(s);
    }
    Ok(())
}
fn provider_query(r: &StepRequest) -> String {
    let mut query = "mediatype:movies".to_owned();
    if !r.query.trim().is_empty() {
        let terms = r
            .query
            .split_whitespace()
            .map(|t| {
                if matches!(
                    t.to_ascii_lowercase().as_str(),
                    "cartoon" | "cartoons" | "animation" | "animated"
                ) {
                    "(cartoon OR cartoons OR animation OR animated)".to_owned()
                } else {
                    let escaped = t.replace('\\', "\\\\").replace('"', "\\\"");
                    if t.len() >= 4
                        && t.len() <= 64
                        && t.bytes().all(|c| c.is_ascii_alphabetic())
                        && !t.ends_with(['s', 'S'])
                    {
                        format!("(\"{escaped}\" OR \"{escaped}s\" OR \"{escaped}'s\")")
                    } else {
                        format!("\"{escaped}\"")
                    }
                }
            })
            .collect::<Vec<_>>()
            .join(" AND ");
        // Genre searches use subjects; names must not let incidental creator
        // or news tags consume their first bounded metadata page.
        let genre = matches!(
            r.query.trim().to_ascii_lowercase().as_str(),
            "cartoon"
                | "cartoons"
                | "animation"
                | "animated"
                | "comedy"
                | "drama"
                | "western"
                | "westerns"
                | "horror"
                | "science fiction"
                | "sci fi"
                | "documentary"
                | "documentaries"
        );
        let fields: &[&str] = if genre {
            &["title", "series", "subject"]
        } else {
            &["title", "series"]
        };
        let mut scopes = fields
            .iter()
            .map(|field| format!("{field}:({terms})"))
            .collect::<Vec<_>>()
            .join(" OR ");
        if matches!(
            r.query.trim().to_ascii_lowercase().as_str(),
            "cartoon" | "cartoons" | "animation" | "animated"
        ) {
            scopes=format!("title:({terms}) OR series:({terms}) OR subject:(cartoon OR cartoons OR animated) OR (subject:animation AND NOT subject:\"Film & Animation\") OR collection:(animationandcartoons OR classic_cartoons OR animation_unsorted)");
        }
        let phrase = r.query.replace('\\', "\\\\").replace('"', "\\\"");
        query.push_str(&format!(" AND (title:\"{phrase}\"^8 OR {scopes})"));
    }
    if let Some(y) = r.year {
        query.push_str(&format!(
            " AND date:[{y}-01-01T00:00:00Z TO {y}-12-31T23:59:59Z]"
        ));
    }
    if r.year.is_none() {
        if let Some(d) = r.decade {
            query.push_str(&format!(
                " AND date:[{d}-01-01T00:00:00Z TO {}-12-31T23:59:59Z]",
                catalog::decade_end(d)
            ));
        }
    }
    query
}
fn filter_decade(metadata: Metadata, decade: Option<i64>) -> Metadata {
    match metadata {
        Metadata::Title(t)
            if decade.is_some_and(|d| {
                t.year
                    .is_none_or(|y| !(d..=catalog::decade_end(d)).contains(&y))
            }) =>
        {
            Metadata::UnknownYear
        }
        other => other,
    }
}
struct PartialHeader {
    document: Value,
    count: u32,
    fingerprint: String,
}
async fn partial_field(
    client: &Client,
    id: &str,
    field: &str,
    owner: &Context,
    deadline: Instant,
    budget: &AtomicUsize,
) -> Result<Value, String> {
    let url = Url::parse(&format!(
        "https://archive.org/metadata/{id}/{field}?extended_err=1"
    ))
    .map_err(|_| "archive-address-invalid")?;
    let response = json(client, url, owner, deadline, budget).await?;
    if extended_deleted(&response)? {
        return Err("archive-item-deleted".into());
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| "archive-metadata-unavailable".into())
}
async fn partial_header(
    client: &Client,
    id: &str,
    owner: Arc<Context>,
    deadline: Instant,
    budget: Arc<AtomicUsize>,
) -> Result<PartialHeader, String> {
    partial_header_inner(client, id, owner, deadline, budget, false).await
}
async fn partial_header_inner(
    client: &Client,
    id: &str,
    owner: Arc<Context>,
    deadline: Instant,
    budget: Arc<AtomicUsize>,
    include_directory: bool,
) -> Result<PartialHeader, String> {
    if !identifier(id) {
        return Err("archive-item-invalid".into());
    }
    let fields = [
        "metadata",
        "files_count",
        "item_last_updated",
        "workable_servers",
    ];
    let mut tasks = Vec::new();
    for field in fields {
        let client = client.clone();
        let id = id.to_owned();
        let owner = owner.clone();
        let budget = budget.clone();
        tasks.push(tokio::spawn(async move {
            partial_field(&client, &id, field, &owner, deadline, &budget).await
        }));
    }
    let mut values = Vec::new();
    let mut failure = None;
    // Retain and join all four producers even if one fails or owner is canceled.
    for task in tasks {
        match task.await {
            Ok(Ok(value)) => values.push(value),
            Ok(Err(error)) => {
                failure.get_or_insert(error);
            }
            Err(_) => {
                failure.get_or_insert("archive-metadata-unavailable".into());
            }
        }
    }
    if let Some(error) = failure {
        return Err(error);
    }
    // Playback reads the optional directory sequentially; preserve the four-producer cap.
    if include_directory {
        values.push(partial_field(client, id, "dir", &owner, deadline, &budget).await?);
    }
    check(&owner, deadline)?;
    parse_partial_header(id, &values)
}
fn parse_partial_header(id: &str, values: &[Value]) -> Result<PartialHeader, String> {
    if values.len() != 4 && values.len() != 5 {
        return Err("archive-metadata-invalid".into());
    }
    let metadata = &values[0];
    if metadata.get("identifier").and_then(Value::as_str) != Some(id) {
        return Err("archive-item-invalid".into());
    }
    let count = values[1]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 100000)
        .ok_or("archive-provider-file-limit")? as u32;
    let updated = values[2]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 9_007_199_254_740_991.0)
        .ok_or("archive-item-version-unavailable")?;
    let hosts = values[3]
        .as_array()
        .ok_or("archive-item-hosts-unavailable")?;
    if hosts.len() > 3 {
        return Err("archive-item-hosts-unavailable".into());
    }
    let mut document =
        serde_json::json!({"metadata":metadata,"files_count":count,"item_last_updated":updated});
    for (index, host) in hosts.iter().enumerate() {
        document[["d1", "d2", "server"][index]] = host.clone();
    }
    if media_hosts(&document)?.len() != hosts.len() {
        return Err("archive-item-hosts-unavailable".into());
    }
    if let Some(directory) = values.get(4).filter(|v| !v.is_null()) {
        validate_media_directory(id, directory)?;
        document["dir"] = directory.clone();
    }
    let encoded = serde_json::to_string(&document).map_err(|_| "archive-metadata-invalid")?;
    let fingerprint = catalog::opaque(&["archive-partial-header-v1", id, &encoded]);
    Ok(PartialHeader {
        document,
        count,
        fingerprint,
    })
}
// The item's page position (capture, restart, curation year) and the fetch
// limits (owner, deadline, budget) are used independently of each other.
#[allow(clippy::too_many_arguments)]
async fn acquire_file_page(
    client: &Client,
    id: &str,
    downloads: i64,
    owner: Arc<Context>,
    deadline: Instant,
    budget: Arc<AtomicUsize>,
    capture: Option<&catalog::PreparedPage>,
    restart: bool,
    curation_year: Option<i64>,
) -> Result<Metadata, String> {
    let before = partial_header(client, id, owner.clone(), deadline, budget.clone()).await?;
    if !restart
        && capture.is_some_and(|c| {
            c.fingerprint != before.fingerprint || c.provider_count != before.count
        })
    {
        return Err("archive-item-scope-changed".into());
    }
    let start = if restart {
        0
    } else {
        capture.map_or(0, |p| p.next_offset)
    };
    if start >= before.count {
        return Err("archive-item-progress-stale".into());
    }
    let mut count = (before.count - start).min(64);
    let response = loop {
        let mut url = Url::parse(&format!("https://archive.org/metadata/{id}/files"))
            .map_err(|_| "archive-address-invalid")?;
        url.query_pairs_mut()
            .append_pair("start", &start.to_string())
            .append_pair("count", &count.to_string())
            .append_pair("extended_err", "1");
        match json(client, url, &owner, deadline, &budget).await {
            Err(e)
                if e == "archive-response-limit"
                    && count > 1
                    && budget.load(Ordering::SeqCst) < 20 * 1024 * 1024 =>
            {
                count = (count / 2).max(1);
            }
            other => break other?,
        }
    };
    if extended_deleted(&response)? {
        return Err("archive-item-deleted".into());
    }
    let files = response
        .get("result")
        .and_then(Value::as_array)
        .filter(|files| files.len() == count as usize)
        .ok_or("archive-item-scope-changed")?;
    let bytes = serde_json::to_vec(files)
        .map_err(|_| "archive-metadata-invalid")?
        .len() as u64;
    let prior = if restart {
        0
    } else {
        capture.map_or(0, |p| p.scanned_bytes)
    };
    let scanned = prior.checked_add(bytes).ok_or("archive-item-byte-limit")?;
    let after = partial_header(client, id, owner.clone(), deadline, budget.clone()).await?;
    if before.fingerprint != after.fingerprint {
        return Err("archive-item-scope-changed".into());
    }
    let exceeds = scanned > 20 * 1024 * 1024;
    let page = catalog::PreparedPage {
        provider_count: before.count,
        next_offset: if exceeds { start } else { start + count },
        fingerprint: before.fingerprint,
        scanned_bytes: if exceeds { prior } else { scanned },
        curation_year,
        expected_offset: capture.and_then(|p| p.expected_offset),
        expected_fingerprint: capture.and_then(|p| p.expected_fingerprint.clone()),
        capacity: exceeds || (scanned == 20 * 1024 * 1024 && start + count < before.count),
    };
    let mut document = before.document;
    document["files"] = Value::Array(if exceeds { Vec::new() } else { files.clone() });
    parse_metadata_page(id, downloads, document, curation_year, Some(page), start)
}
fn search_url(r: &StepRequest) -> Result<Url, String> {
    let mut url = Url::parse("https://archive.org/advancedsearch.php")
        .map_err(|_| "archive-address-invalid")?;
    url.query_pairs_mut()
        .append_pair("q", &provider_query(r))
        .append_pair("fl[]", "identifier")
        .append_pair("fl[]", "downloads")
        .append_pair("rows", "20")
        .append_pair("page", &r.page.to_string())
        .append_pair("output", "json")
        .append_pair("sort[]", "downloads desc")
        .append_pair("sort[]", "identifier asc");
    Ok(url)
}
async fn acquire(owner: Arc<Context>, r: &StepRequest) -> Result<catalog::PreparedStep, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let client = client(&owner, deadline).await?;
    let budget = Arc::new(AtomicUsize::new(0));
    let url = search_url(r)?;
    let data = json(&client, url, &owner, deadline, &budget).await?;
    if data.get("error").is_some() {
        return Err("archive-search-unavailable".into());
    }
    let response = data.get("response").ok_or("archive-search-invalid")?;
    let docs = response
        .get("docs")
        .and_then(Value::as_array)
        .ok_or("archive-search-invalid")?;
    if docs.len() > 20 {
        return Err("archive-search-limit".into());
    }
    let found = response
        .get("numFound")
        .and_then(Value::as_u64)
        .ok_or("archive-search-invalid")?;
    let mut work = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for d in docs {
        let id = d
            .get("identifier")
            .and_then(Value::as_str)
            .filter(|s| identifier(s) && ids.insert((*s).to_owned()))
            .ok_or("archive-item-invalid")?;
        let downloads = d
            .get("downloads")
            .and_then(Value::as_i64)
            .filter(|n| *n >= 0)
            .unwrap_or(0);
        work.push((id.to_owned(), downloads));
    }
    let mut step = catalog::PreparedStep {
        item_page: false,
        titles: Vec::new(),
        deleted: Vec::new(),
        examined: work.len(),
        unknown_year: 0,
        transient_failures: 0,
        unavailable: 0,
        capacity_reached: found > r.page as u64 * 20 && r.page == 20,
        next_page: if found > r.page as u64 * 20 && r.page < 20 {
            Some(r.page + 1)
        } else {
            None
        },
        observed_ms: catalog::now_ms()?,
    };
    // Four actual retained tasks per wave. Every task is joined before any
    // cancellation/error exits; no detached late metadata publication.
    for wave in work.chunks(4) {
        let mut tasks = Vec::new();
        for (id, downloads) in wave {
            let id = id.clone();
            let owner = owner.clone();
            let client = client.clone();
            let budget = budget.clone();
            let downloads = *downloads;
            let requested_year = r.year;
            let decade = r.decade;
            tasks.push(tokio::spawn(async move {
                let url = Url::parse(&format!("https://archive.org/metadata/{id}?extended_err=1"))
                    .map_err(|_| "archive-address-invalid".to_owned())?;
                let full = match json(&client, url, &owner, deadline, &budget).await {
                    Ok(v) => parse_metadata(&id, downloads, v, requested_year),
                    Err(e) => Err(e),
                };
                let result = match full {
                    Err(e)
                        if matches!(
                            e.as_str(),
                            "archive-response-limit" | "archive-file-limit"
                        ) && budget.load(Ordering::SeqCst) < 20 * 1024 * 1024 =>
                    {
                        acquire_file_page(
                            &client,
                            &id,
                            downloads,
                            owner.clone(),
                            deadline,
                            budget.clone(),
                            None,
                            false,
                            requested_year,
                        )
                        .await
                    }
                    other => other,
                };
                result.map(|m| {
                    let m = filter_decade(m, decade);
                    (id, m)
                })
            }));
        }
        let mut query_error = None;
        for task in tasks {
            match task.await {
                Ok(Ok((id, Metadata::Deleted))) => step.deleted.push(id),
                Ok(Ok((_, Metadata::Title(t)))) => {
                    // Same predicate as local results/pending and transaction
                    // visible-yield checks; a broad provider hit is not admission.
                    match catalog::prepared_matches_query(&t, &r.query) {
                        Ok(true) => {
                            if t.files.is_empty() {
                                step.unavailable += 1;
                            }
                            step.titles.push(*t);
                        }
                        Ok(false) => step.unavailable += 1,
                        Err(error) => query_error = Some(error),
                    }
                }
                Ok(Ok((_, Metadata::UnknownYear))) => step.unknown_year += 1,
                Ok(Ok((_, Metadata::Unavailable))) => step.unavailable += 1,
                _ => step.transient_failures += 1,
            }
        }
        // Retain and join every original wave producer before returning an
        // invalid-metadata error; never detach the remaining metadata jobs.
        if let Some(error) = query_error {
            return Err(error);
        }
        if budget.load(Ordering::SeqCst) > 20 * 1024 * 1024 {
            return Err("archive-response-limit".into());
        }
        check(&owner, deadline)?;
    }
    if step.transient_failures > 0 {
        step.next_page = Some(r.page);
    }
    Ok(step)
}
#[tauri::command]
pub async fn archive_discover_step(
    request: StepRequest,
    app: tauri::AppHandle,
) -> Result<catalog::StepReceipt, String> {
    validate(&request)?;
    let query_hash = catalog::search_scope_hash(&request.query, request.decade);
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        // One actual online step, including final publication. Queued callers
        // remain canceled/owned and cannot create an unbounded fetch fanout.
        let admission = Instant::now() + Duration::from_secs(20);
        let pending = DISCOVERY_OWNER.lock();
        tokio::pin!(pending);
        let _step_owner = loop {
            check(&owner, admission)?;
            tokio::select! {
                guard=&mut pending => break guard,
                _=tokio::time::sleep(Duration::from_millis(50)) => {
                }
            }
        };
        let captured = request.clone();
        let hash = query_hash.clone();
        let (_, generation) = owner
            .storage(None, move |s, check| {
                check()?;
                s.with_archive_read(|c| {
                    catalog::prepare(
                        c,
                        &captured.expected_revision,
                        captured.year.unwrap_or(0),
                        captured.page,
                        &hash,
                        captured.restart,
                    )
                })
            })
            .await?;
        let step = acquire(owner.clone(), &request).await?;
        owner.check()?;
        let (receipt, _) = owner
            .storage(Some(generation), move |s, check| {
                check()?;
                s.with_archive_write_checked(
                    &request.expected_revision,
                    |_| Ok(None),
                    |c, check| {
                        catalog::commit_view(
                            c,
                            &request.expected_revision,
                            catalog::SearchPage {
                                year: request.year,
                                page: request.page,
                                query_hash: &query_hash,
                                restart: request.restart,
                            },
                            step,
                            request
                                .view
                                .as_ref()
                                .map(|view| (request.query.as_str(), request.decade, view)),
                            check,
                        )
                    },
                    check,
                )
            })
            .await?;
        Ok(receipt)
    })
    .await
}
#[tauri::command]
pub async fn archive_item_files_progress(
    request: catalog::FileProgressQuery,
    app: tauri::AppHandle,
) -> Result<catalog::FileProgressReply, String> {
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let (reply, _) = owner
            .storage(None, move |s, check| {
                s.with_archive_read(|c| catalog::item_progress(c, &request, check))
            })
            .await?;
        Ok(reply)
    })
    .await
}
#[tauri::command]
pub async fn archive_item_files_step(
    request: catalog::FileStepRequest,
    app: tauri::AppHandle,
) -> Result<catalog::FileStepReceipt, String> {
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let deadline = Instant::now() + Duration::from_secs(20);
        let pending = DISCOVERY_OWNER.lock();
        tokio::pin!(pending);
        let _guard = loop {
            check(&owner, deadline)?;
            tokio::select! {
                g=&mut pending => break g,
                _=tokio::time::sleep(Duration::from_millis(50)) => {
                }
            }
        };
        let captured_request = request.clone();
        let (capture, generation) = owner
            .storage(None, move |s, check| {
                check()?;
                s.with_archive_read(|c| catalog::item_prepare(c, &captured_request))
            })
            .await?;
        let client = client(&owner, deadline).await?;
        let budget = Arc::new(AtomicUsize::new(0));
        let result = acquire_file_page(
            &client,
            &capture.item_id,
            capture.downloads,
            owner.clone(),
            deadline,
            budget,
            Some(&capture.page),
            request.restart,
            capture.page.curation_year,
        )
        .await?;
        let Metadata::Title(title) = result else {
            return Err("archive-item-unavailable".into());
        };
        check(&owner, deadline)?;
        let year = capture.page.curation_year;
        let step = catalog::PreparedStep {
            item_page: true,
            titles: vec![*title],
            deleted: Vec::new(),
            examined: 1,
            unknown_year: 0,
            transient_failures: 0,
            unavailable: 0,
            capacity_reached: false,
            next_page: None,
            observed_ms: catalog::now_ms()?,
        };
        let (receipt, _) = owner
            .storage(Some(generation), move |s, check| {
                s.with_archive_write_checked(
                    &request.expected_revision,
                    |_| Ok(None),
                    |c, check| {
                        catalog::commit(
                            c,
                            &request.expected_revision,
                            catalog::SearchPage {
                                year,
                                page: 1,
                                query_hash: "item-page",
                                restart: false,
                            },
                            step,
                            check,
                        )
                    },
                    check,
                )
            })
            .await?;
        let progress = receipt
            .file_page_progress
            .ok_or("archive-committed-receipt-invalid")?;
        Ok(catalog::FileStepReceipt {
            schema_version: 1,
            committed: true,
            revision: receipt.revision,
            progress,
            admitted: receipt.files_admitted,
            confirmed_dead: 0,
        })
    })
    .await
}
#[tauri::command]
pub async fn archive_remove_title(
    request: catalog::RemoveTitleRequest,
    app: tauri::AppHandle,
) -> Result<catalog::RemovalReceipt, String> {
    removal_owned(
        request.schema_version,
        request.request_id,
        request.expected_revision,
        request.explicit_action,
        catalog::RemovalScope::TitleRef(request.title_ref),
        None,
        app,
    )
    .await
}
#[tauri::command]
pub async fn archive_remove_file(
    request: catalog::RemoveFileRequest,
    app: tauri::AppHandle,
) -> Result<catalog::RemovalReceipt, String> {
    removal_owned(
        request.schema_version,
        request.request_id,
        request.expected_revision,
        request.explicit_action,
        catalog::RemovalScope::FileRef(request.file_ref),
        Some(request.title_ref),
        app,
    )
    .await
}
#[tauri::command]
pub async fn archive_clear_library(
    request: catalog::ClearLibraryRequest,
    app: tauri::AppHandle,
) -> Result<catalog::RemovalReceipt, String> {
    removal_owned(
        request.schema_version,
        request.request_id,
        request.expected_revision,
        request.explicit_action,
        catalog::RemovalScope::All,
        None,
        app,
    )
    .await
}
async fn removal_owned(
    schema: u32,
    request_id: String,
    expected: String,
    explicit: bool,
    scope: catalog::RemovalScope,
    title_ref: Option<String>,
    app: tauri::AppHandle,
) -> Result<catalog::RemovalReceipt, String> {
    if schema != 1 || !catalog::text(&request_id, 256) || !explicit {
        return Err("archive-removal-invalid".into());
    }
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let captured = expected.clone();
        let (_, generation) = owner
            .storage(None, move |s, check| {
                check()?;
                s.with_archive_read(|c| {
                    if catalog::current(c)? != catalog::revision(&captured)? {
                        return Err("archive-revision-stale".into());
                    }
                    Ok(())
                })
            })
            .await?;
        let retire = scope.clone();
        let (mut receipt, _) = owner
            .storage(Some(generation), move |s, check| {
                s.with_archive_write_checked(
                    &expected,
                    |_| Ok(None),
                    |c, check| catalog::remove(c, &scope, title_ref.as_deref(), &expected, check),
                    check,
                )
            })
            .await?;
        // Publication has already committed. Join cleanup without reporting a
        // late cancellation as a failed durable removal; retain failed handles.
        receipt.cleanup_pending = cleanup_removed(&retire).await;
        Ok(receipt)
    })
    .await
}
/// Post-COMMIT cleanup has no authority to undo or erase the durable receipt.
/// Join both original owners even when one reports cleanup failure.
pub(crate) async fn cleanup_removed(scope: &catalog::RemovalScope) -> bool {
    let (playback, download) = tokio::join!(
        crate::archive_playback_owner::revoke_removed(scope),
        crate::archive_download_owner::revoke_removed(scope),
    );
    playback.is_err() || download.is_err()
}
#[tauri::command]
pub async fn archive_set_favorite(
    request: catalog::FavoriteRequest,
    app: tauri::AppHandle,
) -> Result<catalog::FavoriteReceipt, String> {
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let captured = request.clone();
        let (_, generation) = owner
            .storage(None, move |s, check| {
                check()?;
                s.with_archive_read(|c| {
                    if catalog::current(c)? != catalog::revision(&captured.expected_revision)? {
                        return Err("archive-revision-stale".into());
                    }
                    Ok(())
                })
            })
            .await?;
        let (receipt, _) = owner
            .storage(Some(generation), move |s, check| {
                check()?;
                s.with_archive_write_checked(
                    &request.expected_revision,
                    |_| Ok(None),
                    |c, check| catalog::set_favorite(c, &request, check),
                    check,
                )
            })
            .await?;
        Ok(receipt)
    })
    .await
}
#[tauri::command]
pub async fn archive_query_catalog(
    request: catalog::Query,
    app: tauri::AppHandle,
) -> Result<catalog::Page, String> {
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let (page, _) = owner
            .storage(None, move |s, check| {
                s.with_archive_read(|c| catalog::query(c, &request, check))
            })
            .await?;
        Ok(page)
    })
    .await
}
#[tauri::command]
pub async fn archive_title_files(
    request: catalog::FilesQuery,
    app: tauri::AppHandle,
) -> Result<catalog::FilesPage, String> {
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let (page, _) = owner
            .storage(None, move |s, check| {
                s.with_archive_read(|c| catalog::files(c, &request, check))
            })
            .await?;
        Ok(page)
    })
    .await
}
#[tauri::command]
pub async fn archive_discovery_progress(
    request: catalog::ProgressQuery,
    app: tauri::AppHandle,
) -> Result<catalog::ProgressReply, String> {
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let (page, _) = owner
            .storage(None, move |s, check| {
                check()?;
                s.with_archive_read(|c| catalog::progress(c, &request))
            })
            .await?;
        Ok(page)
    })
    .await
}

static ARTWORK_OWNER: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtworkRequest {
    pub schema_version: u32,
    pub request_id: String,
    pub title_ref: String,
    pub expected_revision: String,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkReply {
    pub schema_version: u32,
    pub title_ref: String,
    pub revision: String,
    pub artwork_ref: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub byte_length: usize,
    pub data_url: String,
}
async fn artwork_bytes(
    owner: &Arc<Context>,
    route: MediaRoute,
    image: &catalog::Artwork,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    let mut url = route.url;
    for redirect in 0..=3 {
        check(owner, deadline)?;
        crate::archive_playback_proxy::validate(&url, &route.hosts, &route.tail)?;
        let host = url.host_str().ok_or("archive-artwork-host-refused")?;
        let client = client_for_host(owner, deadline, host).await?;
        let mut response = tokio::time::timeout(
            deadline.saturating_duration_since(Instant::now()),
            client
                .get(url.clone())
                .header(reqwest::header::ACCEPT, &image.mime_type)
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .send(),
        )
        .await
        .map_err(|_| "archive-request-timeout")?
        .map_err(|_| "archive-artwork-network-unavailable")?;
        check(owner, deadline)?;
        if response.status().is_redirection() {
            if redirect == 3 {
                return Err("archive-artwork-redirect-limit".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("archive-artwork-redirect-refused")?;
            url = url
                .join(location)
                .map_err(|_| "archive-artwork-redirect-refused")?;
            continue;
        }
        let expected: u64 = image
            .size_bytes
            .parse()
            .map_err(|_| "archive-artwork-size-refused")?;
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        if response.url() != &url {
            return Err("archive-artwork-response-refused".into());
        }
        crate::archive_artwork::response(
            response.status().as_u16(),
            mime,
            response.content_length(),
            response
                .headers()
                .get(reqwest::header::CONTENT_ENCODING)
                .map(|value| value.as_bytes()),
            response
                .headers()
                .contains_key(reqwest::header::CONTENT_RANGE),
            expected as usize,
            &image.mime_type,
        )?;
        let mut bytes = Vec::new();
        while let Some(chunk) = tokio::time::timeout(
            deadline.saturating_duration_since(Instant::now()),
            response.chunk(),
        )
        .await
        .map_err(|_| "archive-request-timeout")?
        .map_err(|_| "archive-artwork-network-unavailable")?
        {
            check(owner, deadline)?;
            crate::archive_artwork::append(&mut bytes, &chunk, expected as usize)?;
        }
        if bytes.len() as u64 != expected {
            return Err("archive-artwork-size-refused".into());
        }
        check(owner, deadline)?;
        return Ok(bytes);
    }
    Err("archive-artwork-redirect-limit".into())
}
#[tauri::command]
pub async fn archive_title_artwork(
    request: ArtworkRequest,
    app: tauri::AppHandle,
) -> Result<Option<ArtworkReply>, String> {
    if request.schema_version != 1
        || !catalog::text(&request.request_id, 256)
        || !catalog::hex_ref(&request.title_ref)
    {
        return Err("archive-artwork-request-invalid".into());
    }
    catalog::revision(&request.expected_revision)?;
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let _slot = ARTWORK_OWNER
            .try_acquire()
            .map_err(|_| "archive-artwork-busy")?;
        let deadline = Instant::now() + Duration::from_secs(20);
        let read = request.clone();
        let (source, generation) = owner
            .storage(None, move |store, check| {
                check()?;
                store.with_archive_read(|c| {
                    catalog::artwork_source(c, &read.title_ref, &read.expected_revision)
                })
            })
            .await?;
        check(&owner, deadline)?;
        let client = client(&owner, deadline).await?;
        let url = Url::parse(&format!(
            "https://archive.org/metadata/{}?extended_err=1",
            source.0
        ))
        .map_err(|_| "archive-artwork-request-invalid")?;
        let document = json(&client, url, &owner, deadline, &AtomicUsize::new(0)).await?;
        let image = if extended_deleted(&document)? {
            None
        } else {
            let metadata = document
                .get("metadata")
                .ok_or("archive-metadata-unavailable")?;
            if metadata.get("identifier").and_then(Value::as_str) != Some(source.0.as_str())
                || metadata.get("mediatype").and_then(Value::as_str) != Some("movies")
            {
                return Err("archive-artwork-item-changed".into());
            }
            if metadata
                .get("access-restricted-item")
                .is_some_and(|v| v.as_bool() == Some(true) || v.as_str() == Some("true"))
            {
                None
            } else {
                let files = document
                    .get("files")
                    .and_then(Value::as_array)
                    .filter(|files| files.len() <= 1000)
                    .ok_or("archive-artwork-metadata-limit")?;
                listed_artwork(&source.0, files)
            }
        };
        if source
            .1
            .as_ref()
            .is_some_and(|expected| image.as_ref() != Some(expected))
        {
            return Err("archive-artwork-item-changed".into());
        }
        let result = if let Some(image) = image {
            let route = media_route(&source.0, &image.file_name, &document)?;
            let bytes = artwork_bytes(&owner, route, &image, deadline).await?;
            let (width, height) = crate::archive_artwork::validate(&bytes, &image.mime_type)?;
            use base64::Engine;
            let data_url = format!(
                "data:{};base64,{}",
                image.mime_type,
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            );
            Some(ArtworkReply {
                schema_version: 1,
                title_ref: request.title_ref.clone(),
                revision: request.expected_revision.clone(),
                artwork_ref: image.reference(),
                mime_type: image.mime_type,
                width,
                height,
                byte_length: bytes.len(),
                data_url,
            })
        } else {
            None
        };
        check(&owner, deadline)?;
        let final_read = request.clone();
        owner
            .storage(Some(generation), move |store, check| {
                check()?;
                store.with_archive_read(|c| {
                    let current = catalog::artwork_source(
                        c,
                        &final_read.title_ref,
                        &final_read.expected_revision,
                    )?;
                    if current != source {
                        return Err("archive-artwork-item-changed".into());
                    }
                    check()
                })
            })
            .await?;
        check(&owner, deadline)?;
        Ok(result)
    })
    .await
}
/// Runtime metadata proof for the future native playback owner. This fetches
/// neither media nor a playlist, and never returns upstream data to JavaScript.
pub(crate) struct VerifiedFile {
    pub url: Url,
    pub allowed_hosts: Vec<String>,
    pub size_bytes: u64,
    pub expected_tail: String,
    pub public: Option<crate::archive_provider_discovery::ExactMedia>,
    pub mime: &'static str,
}
pub(crate) fn media_host(host: &str) -> bool {
    host == "archive.org"
        || (host.ends_with(".archive.org")
            && host.len() <= 253
            && (host.starts_with("ia")
                || host
                    .strip_prefix("dn")
                    .and_then(|s| s.split('.').next())
                    .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())))
            && host.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            }))
}
fn media_hosts(document: &Value) -> Result<Vec<String>, String> {
    let mut hosts = Vec::new();
    for key in ["d1", "d2", "server"] {
        if let Some(value) = document.get(key).filter(|v| !v.is_null()) {
            let host = value
                .as_str()
                .filter(|h| *h != "archive.org" && media_host(h))
                .ok_or("archive-file-route-unverified")?;
            if !hosts.iter().any(|h| h == host) {
                hosts.push(host.to_owned());
            }
        }
    }
    Ok(hosts)
}
fn validate_media_directory<'a>(id: &str, value: &'a Value) -> Result<&'a str, String> {
    let directory = value
        .as_str()
        .filter(|s| s.len() <= 256)
        .ok_or("archive-file-route-unverified")?;
    let directory = directory.strip_suffix('/').unwrap_or(directory);
    let expected = format!("items/{id}");
    let path = directory
        .strip_prefix('/')
        .ok_or("archive-file-route-unverified")?;
    let valid = path == expected
        || path.split_once('/').is_some_and(|(disk, rest)| {
            !disk.is_empty()
                && disk.len() <= 4
                && disk.bytes().all(|b| b.is_ascii_digit())
                && rest == expected
        });
    if !identifier(id) || !valid {
        return Err("archive-file-route-unverified".into());
    }
    Ok(directory)
}
struct MediaRoute {
    url: Url,
    hosts: Vec<String>,
    tail: String,
}
fn media_route(id: &str, filename: &str, document: &Value) -> Result<MediaRoute, String> {
    if !identifier(id)
        || filename.is_empty()
        || filename.len() > 1024
        || filename.contains('\\')
        || filename
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("archive-file-route-unverified".into());
    }
    let mut canonical =
        Url::parse("https://archive.org/download/").map_err(|_| "archive-address-invalid")?;
    {
        let mut segments = canonical
            .path_segments_mut()
            .map_err(|_| "archive-address-invalid")?;
        segments.pop_if_empty();
        segments.push(id);
        for segment in filename.split('/') {
            segments.push(segment);
        }
    }
    let tail = canonical
        .path()
        .strip_prefix("/download/")
        .ok_or("archive-file-route-unverified")?
        .to_owned();
    let mut hosts = media_hosts(document)?;
    let url = if let Some(directory) = document.get("dir").filter(|v| !v.is_null()) {
        let directory = validate_media_directory(id, directory)?;
        let primary = document
            .get("d1")
            .and_then(Value::as_str)
            .filter(|h| hosts.iter().any(|v| v == h))
            .ok_or("archive-file-route-unverified")?;
        let mut url = Url::parse(&format!("https://{primary}/"))
            .map_err(|_| "archive-file-route-unverified")?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| "archive-file-route-unverified")?;
            segments.clear();
            for segment in directory.trim_start_matches('/').split('/') {
                segments.push(segment);
            }
            for segment in filename.split('/') {
                segments.push(segment);
            }
        }
        url
    } else {
        canonical
    };
    hosts.push("archive.org".into());
    Ok(MediaRoute { url, hosts, tail })
}
pub(crate) struct MissingEvidence {
    item_id: String,
    file_name: String,
    observed_ms: i64,
}
impl MissingEvidence {
    pub(crate) fn matches(&self, item: &str, name: &str) -> bool {
        self.item_id == item && self.file_name == name
    }
    pub(crate) fn fresh(&self) -> bool {
        let elapsed = catalog::now_ms()
            .ok()
            .and_then(|now| now.checked_sub(self.observed_ms));
        elapsed.is_some_and(|n| (0..=120_000).contains(&n))
    }
}
pub(crate) enum FileVerification {
    File(Box<VerifiedFile>),
    Missing(MissingEvidence),
}
pub(crate) async fn verify_file(
    owner: Arc<Context>,
    file: &catalog::ResolvedFile,
) -> Result<FileVerification, String> {
    verify_file_with_deadline(owner, file, Instant::now() + Duration::from_secs(20)).await
}
pub(crate) async fn verify_file_with_deadline(
    owner: Arc<Context>,
    file: &catalog::ResolvedFile,
    deadline: Instant,
) -> Result<FileVerification, String> {
    if let Some(public) = &file.public {
        return crate::archive_provider_discovery::verify(owner, public, deadline)
            .await
            .map(|file| FileVerification::File(Box::new(file)));
    }
    let client = client(&owner, deadline).await?;
    let (parsed, route) = if let Some(index) = file.provider_index {
        let budget = Arc::new(AtomicUsize::new(0));
        match verify_partial_file(&client, file, index, owner.clone(), deadline, budget).await {
            Err(e) if e == "archive-item-deleted" => (Metadata::Deleted, None),
            other => other?,
        }
    } else {
        let metadata_url = Url::parse(&format!(
            "https://archive.org/metadata/{}?extended_err=1",
            file.item_id
        ))
        .map_err(|_| "archive-address-invalid")?;
        let data = json(
            &client,
            metadata_url,
            &owner,
            deadline,
            &AtomicUsize::new(0),
        )
        .await?;
        let route = media_route(&file.item_id, &file.file_name, &data)?;
        (parse_metadata(&file.item_id, 0, data, None)?, Some(route))
    };
    check(&owner, deadline)?;
    let title = match parsed {
        Metadata::Deleted => {
            return Ok(FileVerification::Missing(MissingEvidence {
                item_id: file.item_id.clone(),
                file_name: file.file_name.clone(),
                observed_ms: catalog::now_ms()?,
            }))
        }
        Metadata::Title(title)
            if file.provider_index.is_none() && !title.all_file_names.contains(&file.file_name) =>
        {
            return Ok(FileVerification::Missing(MissingEvidence {
                item_id: file.item_id.clone(),
                file_name: file.file_name.clone(),
                observed_ms: catalog::now_ms()?,
            }))
        }
        Metadata::Title(title) => title,
        _ => return Err("archive-file-unavailable".into()),
    };
    let current = title
        .files
        .iter()
        .find(|f| f.name == file.file_name)
        .ok_or("archive-file-unavailable")?;
    if current.size != file.size_bytes || (file.sha1.is_some() && current.sha1 != file.sha1) {
        return Err("archive-file-changed".into());
    }
    let route = route.ok_or("archive-file-route-unverified")?;
    owner.check()?;
    Ok(FileVerification::File(Box::new(VerifiedFile {
        url: route.url,
        allowed_hosts: route.hosts,
        expected_tail: route.tail,
        size_bytes: current.size.parse().map_err(|_| "archive-file-invalid")?,
        public: None,
        mime: "video/mp4",
    })))
}
async fn verify_partial_file(
    client: &Client,
    file: &catalog::ResolvedFile,
    index: u32,
    owner: Arc<Context>,
    deadline: Instant,
    budget: Arc<AtomicUsize>,
) -> Result<(Metadata, Option<MediaRoute>), String> {
    let before = partial_header_inner(
        client,
        &file.item_id,
        owner.clone(),
        deadline,
        budget.clone(),
        true,
    )
    .await?;
    if index >= before.count {
        return Err("archive-file-index-changed".into());
    }
    let field = format!("files/{index}");
    let value = partial_field(client, &file.item_id, &field, &owner, deadline, &budget).await?;
    if value.get("name").and_then(Value::as_str) != Some(file.file_name.as_str()) {
        return Err("archive-file-index-changed".into());
    }
    let after = partial_header_inner(
        client,
        &file.item_id,
        owner.clone(),
        deadline,
        budget.clone(),
        true,
    )
    .await?;
    if before.fingerprint != after.fingerprint {
        return Err("archive-item-scope-changed".into());
    }
    let page = catalog::PreparedPage {
        provider_count: before.count,
        next_offset: index + 1,
        fingerprint: before.fingerprint,
        scanned_bytes: 0,
        curation_year: None,
        expected_offset: None,
        expected_fingerprint: None,
        capacity: false,
    };
    let mut document = before.document;
    document["files"] = Value::Array(vec![value]);
    let route = media_route(&file.item_id, &file.file_name, &document)?;
    Ok((
        parse_metadata_page(&file.item_id, 0, document, None, Some(page), index)?,
        Some(route),
    ))
}
#[cfg(test)]
#[path = "archive_discovery_tests.rs"]
mod tests;
