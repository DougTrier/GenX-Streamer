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

//! Provider Video On Demand (movies and series) for signed-in accounts.
//! Browsing is category-first and bounded; nothing here is persisted. The
//! sign-in never leaves native code: requests are built here, titles pass the
//! same display policy as channels, and playback goes through the account relay.
use crate::{
    account_acquisition::{self as acq, DisplayPolicy},
    account_vault::{self, Resolved, Secret},
    scan_manifest_work::{self, Context},
};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio::time::Instant;
use zeroize::Zeroizing;

const ITEM_LIMIT: usize = 20_000;
const CATEGORY_LIMIT: usize = 5_000;
const EPISODE_LIMIT: usize = 5_000;
const LIST_BYTES: usize = 48 * 1024 * 1024;
/// Containers a provider may report for a title; anything else is refused.
const EXTENSIONS: [&str; 11] = [
    "mp4", "mkv", "m4v", "mov", "webm", "avi", "ts", "m3u8", "flv", "mpg", "mpeg",
];

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Section {
    Movies,
    Series,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    schema_version: u8,
    account_id: String,
    expected_revision: String,
    section: Section,
    /// Absent: list categories. Present: list that category's titles.
    category_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SeriesRequest {
    schema_version: u8,
    account_id: String,
    expected_revision: String,
    series_id: String,
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    Movie,
    Episode,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlayRequest {
    pub(crate) schema_version: u8,
    pub(crate) account_id: String,
    pub(crate) expected_revision: String,
    pub(crate) kind: Kind,
    pub(crate) item_id: String,
    pub(crate) extension: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Category {
    id: String,
    name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Item {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    year: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rating: Option<String>,
    /// HTTPS artwork only, and only if it carries no part of the sign-in.
    #[serde(skip_serializing_if = "Option::is_none")]
    poster: Option<String>,
    /// Movies only; series titles open their episode list instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    extension: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Listing {
    schema_version: u8,
    account_id: String,
    revision: String,
    categories: Vec<Category>,
    items: Vec<Item>,
    /// Titles left out because their name or data was unusable.
    skipped: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Episode {
    id: String,
    season: u32,
    episode: u32,
    title: String,
    /// None when the provider gives no usable container (XC-021): the episode
    /// stays listed and says so on Play; never a guessed or ".null" address.
    #[serde(skip_serializing_if = "Option::is_none")]
    extension: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_seconds: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DetailsRequest {
    schema_version: u8,
    account_id: String,
    expected_revision: String,
    section: Section,
    item_id: String,
}
/// One title's description from the provider's own detail call, for the
/// browsing banner. Every field is optional and passes the display policy.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Details {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub director: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cast: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u64>,
    /// HTTPS artwork only, and only if it carries no part of the sign-in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backdrop: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DetailsReply {
    schema_version: u8,
    account_id: String,
    revision: String,
    item_id: String,
    details: Details,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SeriesInfo {
    schema_version: u8,
    account_id: String,
    revision: String,
    episodes: Vec<Episode>,
    skipped: usize,
}

pub(crate) fn revision(schema: u8, account_id: &str, raw: &str) -> Result<u64, String> {
    if schema != 1
        || account_id.len() != 32
        || !account_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || raw.is_empty()
        || raw.len() > 19
        || raw.starts_with('0')
        || !raw.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("account-reference-invalid".into());
    }
    raw.parse::<u64>()
        .ok()
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or_else(|| "account-revision-invalid".into())
}
fn plain_id(raw: &str) -> bool {
    !raw.is_empty() && raw.len() <= 32 && raw.bytes().all(|b| b.is_ascii_digit())
}

/// Xtream API credentials for an account: the login itself, or a provider
/// `get.php?username=...&password=...` playlist link (same account).
pub(crate) fn credentials(
    secret: &Secret,
) -> Result<(Zeroizing<String>, Zeroizing<String>, Zeroizing<String>), String> {
    match secret {
        Secret::Xtream {
            server_url,
            username,
            password,
        } => Ok((
            Zeroizing::new(server_url.clone()),
            Zeroizing::new(username.clone()),
            Zeroizing::new(password.clone()),
        )),
        Secret::Playlist { url } => {
            let parsed = Url::parse(url).map_err(|_| "account-vod-unavailable")?;
            if !parsed.path().to_ascii_lowercase().ends_with("/get.php") {
                return Err("account-vod-unavailable".into());
            }
            let (mut user, mut pass) = (None, None);
            for (key, value) in parsed.query_pairs() {
                match key.as_ref() {
                    "username" => user = Some(Zeroizing::new(value.into_owned())),
                    "password" => pass = Some(Zeroizing::new(value.into_owned())),
                    _ => {}
                }
            }
            let mut base = parsed.join(".").map_err(|_| "account-vod-unavailable")?;
            base.set_query(None);
            match (user, pass) {
                (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => {
                    Ok((Zeroizing::new(base.to_string()), u, p))
                }
                _ => Err("account-vod-unavailable".into()),
            }
        }
    }
}

pub(crate) async fn resolve(
    owner: &Arc<Context>,
    app: &tauri::AppHandle,
    account_id: String,
    revision: u64,
) -> Result<(Resolved, u64), String> {
    let root = crate::account_vault_owner::directory(app).await?;
    let (prepared, generation) = owner
        .storage_with_generation(None, move |store, generation, check| {
            store.with_guide_read(|c| {
                account_vault::prepare_resolve(c, &account_id, revision, generation, check)
            })
        })
        .await?;
    owner.check()?;
    let resolved = account_vault::open(app.clone(), root, prepared).await?;
    owner
        .storage_with_generation(Some(generation), move |store, current, check| {
            store.with_guide_read(|c| account_vault::finish_resolve(c, resolved, current, check))
        })
        .await
}

async fn api(
    resolved: &Resolved,
    owner: &Context,
    params: &[(&str, &str)],
    deadline: Instant,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let origin = &resolved.metadata.server_origin;
    let (base, user, pass) = credentials(&resolved.secret)?;
    let action = params.iter().find(|(k, _)| *k == "action").map(|(_, v)| *v);
    let mut url = acq::endpoint(&base, "player_api.php", &user, &pass, action, origin)?;
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in params.iter().filter(|(k, _)| *k != "action") {
            query.append_pair(key, value);
        }
    }
    let url = acq::address(url.as_str(), origin)?;
    let mut budget = LIST_BYTES;
    acq::fetch(url, origin, &mut budget, LIST_BYTES, owner, deadline).await
}

fn rows(bytes: &[u8], limit: usize) -> Result<Vec<Value>, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "account-vod-invalid")?;
    match value {
        Value::Array(rows) if rows.len() <= limit => Ok(rows),
        Value::Array(_) => Err("account-vod-too-large".into()),
        // Some panels answer an empty section with {} or an error object.
        Value::Object(_) | Value::Null => Ok(Vec::new()),
        _ => Err("account-vod-invalid".into()),
    }
}
fn text_field(row: &Value, key: &str) -> Option<String> {
    match row.get(key)? {
        Value::String(v) => Some(v.trim().to_owned()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}
fn poster(row: &Value, keys: &[&str], policy: &DisplayPolicy) -> Option<String> {
    let raw = keys.iter().find_map(|k| text_field(row, k))?;
    let url = Url::parse(&raw).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && raw.len() <= 2048
        && !policy.tainted(&raw))
    .then(|| url.to_string())
}
fn extension(raw: Option<String>) -> Option<String> {
    let value = raw?.to_ascii_lowercase();
    EXTENSIONS.contains(&value.as_str()).then_some(value)
}

pub(crate) fn parse_categories(
    bytes: &[u8],
    policy: &DisplayPolicy,
) -> Result<(Vec<Category>, usize), String> {
    let mut skipped = 0;
    let mut seen = std::collections::HashSet::new();
    let mut categories = Vec::new();
    for row in rows(bytes, CATEGORY_LIMIT)? {
        let id = text_field(&row, "category_id").filter(|v| plain_id(v));
        let name = text_field(&row, "category_name")
            .and_then(|v| policy.text(&v, acq::TEXT_LIMIT, false).ok());
        match (id, name) {
            (Some(id), Some(name)) if seen.insert(id.clone()) => {
                categories.push(Category { id, name })
            }
            _ => skipped += 1,
        }
    }
    Ok((categories, skipped))
}
pub(crate) fn parse_items(
    bytes: &[u8],
    section: Section,
    policy: &DisplayPolicy,
) -> Result<(Vec<Item>, usize), String> {
    let mut skipped = 0;
    let mut items = Vec::new();
    let id_key = if section == Section::Movies {
        "stream_id"
    } else {
        "series_id"
    };
    for row in rows(bytes, ITEM_LIMIT)? {
        let id = text_field(&row, id_key).filter(|v| plain_id(v));
        let name =
            text_field(&row, "name").and_then(|v| policy.text(&v, acq::TEXT_LIMIT, false).ok());
        let extension = if section == Section::Movies {
            extension(text_field(&row, "container_extension"))
        } else {
            None
        };
        let (Some(id), Some(name)) = (id, name) else {
            skipped += 1;
            continue;
        };
        let year = text_field(&row, "year")
            .or_else(|| text_field(&row, "releaseDate").map(|d| d.chars().take(4).collect()))
            .filter(|y| y.len() == 4 && y.bytes().all(|b| b.is_ascii_digit()));
        let rating = text_field(&row, "rating")
            .filter(|r| !r.is_empty() && r.len() <= 8 && r != "0")
            .filter(|r| r.bytes().all(|b| b.is_ascii_digit() || b == b'.'));
        items.push(Item {
            id,
            name,
            year,
            rating,
            poster: poster(&row, &["stream_icon", "cover"], policy),
            extension,
        });
    }
    Ok((items, skipped))
}
pub(crate) fn parse_episodes(
    bytes: &[u8],
    policy: &DisplayPolicy,
) -> Result<(Vec<Episode>, usize), String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "account-vod-invalid")?;
    let seasons = match value.get("episodes") {
        Some(Value::Object(map)) => map.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        // Some panels send a list of season arrays.
        Some(Value::Array(list)) => list
            .iter()
            .enumerate()
            .map(|(i, v)| ((i + 1).to_string(), v.clone()))
            .collect(),
        _ => Vec::new(),
    };
    let mut skipped = 0;
    let mut episodes = Vec::new();
    for (season_key, list) in seasons {
        let Some(list) = list.as_array() else {
            skipped += 1;
            continue;
        };
        for row in list {
            if episodes.len() >= EPISODE_LIMIT {
                return Err("account-vod-too-large".into());
            }
            let id = text_field(row, "id").filter(|v| plain_id(v));
            let season = text_field(row, "season")
                .or_else(|| Some(season_key.clone()))
                .and_then(|v| v.parse::<u32>().ok());
            let episode = text_field(row, "episode_num").and_then(|v| v.parse::<u32>().ok());
            let title =
                text_field(row, "title").and_then(|v| policy.text(&v, acq::TEXT_LIMIT, false).ok());
            let extension = extension(text_field(row, "container_extension"));
            match (id, season, episode, title) {
                (Some(id), Some(season), Some(episode), Some(title)) => {
                    let duration_seconds = row
                        .get("info")
                        .and_then(|i| text_field(i, "duration_secs"))
                        .and_then(|v| v.parse::<u64>().ok())
                        .filter(|v| *v <= 24 * 3600);
                    episodes.push(Episode {
                        id,
                        season,
                        episode,
                        title,
                        extension,
                        duration_seconds,
                    })
                }
                _ => skipped += 1,
            }
        }
    }
    episodes.sort_by_key(|e| (e.season, e.episode));
    Ok((episodes, skipped))
}

/// Provider prose, one line: line breaks become spaces, then the same display
/// policy as titles (no control characters, links or sign-in parts).
fn prose(row: &Value, key: &str, limit: usize, policy: &DisplayPolicy) -> Option<String> {
    let raw = text_field(row, key)?;
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    policy.text(&flat, limit, false).ok()
}
pub(crate) fn parse_details(
    bytes: &[u8],
    section: Section,
    policy: &DisplayPolicy,
) -> Result<Details, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "account-vod-invalid")?;
    let Some(info) = value.get("info").filter(|v| v.is_object()) else {
        return Ok(Details::default());
    };
    let backdrop = match info.get("backdrop_path") {
        Some(Value::Array(list)) => list.first().cloned(),
        Some(Value::String(one)) => Some(Value::String(one.clone())),
        _ => None,
    }
    .and_then(|v| poster(&serde_json::json!({ "art": v }), &["art"], policy));
    let duration_seconds = match section {
        Section::Movies => text_field(info, "duration_secs").and_then(|v| v.parse::<u64>().ok()),
        Section::Series => text_field(info, "episode_run_time")
            .and_then(|v| v.parse::<u64>().ok())
            .map(|minutes| minutes * 60),
    }
    .filter(|v| *v > 0 && *v <= 24 * 3600);
    let year = ["releasedate", "releaseDate", "release_date"]
        .iter()
        .find_map(|k| text_field(info, k))
        .map(|d| d.chars().take(4).collect::<String>())
        .filter(|y| y.len() == 4 && y.bytes().all(|b| b.is_ascii_digit()));
    Ok(Details {
        plot: prose(info, "plot", 4096, policy)
            .or_else(|| prose(info, "description", 4096, policy)),
        genre: prose(info, "genre", acq::TEXT_LIMIT, policy),
        director: prose(info, "director", acq::TEXT_LIMIT, policy),
        cast: prose(info, "cast", acq::TEXT_LIMIT, policy)
            .or_else(|| prose(info, "actors", acq::TEXT_LIMIT, policy)),
        year,
        duration_seconds,
        backdrop,
    })
}
/// A movie's real container from its own detail (`get_vod_info`), or None.
pub(crate) fn vod_info_extension(bytes: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    ["movie_data", "info"].iter().find_map(|section| {
        extension(
            value
                .get(section)
                .and_then(|v| text_field(v, "container_extension")),
        )
    })
}
/// When a listed movie had no container: ask its detail once (one API request,
/// never media). Episodes have no other source, so they stay unknown.
pub(crate) async fn missing_extension(
    resolved: &Resolved,
    owner: &Context,
    kind: Kind,
    item: &str,
) -> Result<String, String> {
    if kind != Kind::Movie || !plain_id(item) {
        return Err("account-vod-format-unknown".into());
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    let bytes = api(
        resolved,
        owner,
        &[("action", "get_vod_info"), ("vod_id", item)],
        deadline,
    )
    .await?;
    vod_info_extension(&bytes).ok_or_else(|| "account-vod-format-unknown".into())
}
/// The provider address for one title, built only here from the sign-in.
pub(crate) fn media_url(
    resolved: &Resolved,
    kind: Kind,
    item: &str,
    ext: &str,
) -> Result<Zeroizing<String>, String> {
    if !plain_id(item) || !EXTENSIONS.contains(&ext) {
        return Err("account-vod-reference-invalid".into());
    }
    let origin = &resolved.metadata.server_origin;
    let (base, user, pass) = credentials(&resolved.secret)?;
    if matches!(user.as_str(), "." | "..") || matches!(pass.as_str(), "." | "..") {
        return Err("account-login-path-invalid".into());
    }
    let mut url = acq::address(&base, origin)?;
    url.set_query(None);
    let prefix = url.path().trim_end_matches('/').to_owned();
    url.set_path(&format!(
        "{prefix}/{}/",
        if kind == Kind::Movie {
            "movie"
        } else {
            "series"
        }
    ));
    url.path_segments_mut()
        .map_err(|_| "account-server-base-invalid")?
        .pop_if_empty()
        .push(&user)
        .push(&pass)
        .push(&format!("{item}.{ext}"));
    Ok(Zeroizing::new(
        acq::address(url.as_str(), origin)?.to_string(),
    ))
}

#[tauri::command]
pub(crate) async fn account_vod_list(
    request: Request,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Listing, String> {
    let resolve_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let revision = revision(
            request.schema_version,
            &request.account_id,
            &request.expected_revision,
        )?;
        if request.category_id.as_deref().is_some_and(|c| !plain_id(c)) {
            return Err("account-vod-reference-invalid".into());
        }
        let (resolved, _) =
            resolve(&owner, &resolve_app, request.account_id.clone(), revision).await?;
        let policy = DisplayPolicy::new(&resolved.secret);
        let deadline = Instant::now() + Duration::from_secs(30);
        let (categories, items, skipped) = match &request.category_id {
            None => {
                let action = if request.section == Section::Movies {
                    "get_vod_categories"
                } else {
                    "get_series_categories"
                };
                let bytes = api(&resolved, &owner, &[("action", action)], deadline).await?;
                let (categories, skipped) = parse_categories(&bytes, &policy)?;
                (categories, Vec::new(), skipped)
            }
            Some(category) => {
                let action = if request.section == Section::Movies {
                    "get_vod_streams"
                } else {
                    "get_series"
                };
                let bytes = api(
                    &resolved,
                    &owner,
                    &[("action", action), ("category_id", category)],
                    deadline,
                )
                .await?;
                let section = request.section;
                let parsed = tauri::async_runtime::spawn_blocking(move || {
                    parse_items(&bytes, section, &policy)
                })
                .await
                .map_err(|_| "account-parser-failed")??;
                (Vec::new(), parsed.0, parsed.1)
            }
        };
        owner.check()?;
        Ok(Listing {
            schema_version: 1,
            account_id: resolved.metadata.id.clone(),
            revision: resolved.metadata.revision.to_string(),
            categories,
            items,
            skipped,
        })
    })
    .await
}

/// The banner's description for one title: one provider detail request, made
/// only for the title the viewer has selected.
#[tauri::command]
pub(crate) async fn account_vod_details(
    request: DetailsRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<DetailsReply, String> {
    let resolve_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let revision = revision(
            request.schema_version,
            &request.account_id,
            &request.expected_revision,
        )?;
        if !plain_id(&request.item_id) {
            return Err("account-vod-reference-invalid".into());
        }
        let (resolved, _) =
            resolve(&owner, &resolve_app, request.account_id.clone(), revision).await?;
        let policy = DisplayPolicy::new(&resolved.secret);
        let deadline = Instant::now() + Duration::from_secs(15);
        let params: [(&str, &str); 2] = if request.section == Section::Movies {
            [("action", "get_vod_info"), ("vod_id", &request.item_id)]
        } else {
            [
                ("action", "get_series_info"),
                ("series_id", &request.item_id),
            ]
        };
        let bytes = api(&resolved, &owner, &params, deadline).await?;
        let section = request.section;
        let details =
            tauri::async_runtime::spawn_blocking(move || parse_details(&bytes, section, &policy))
                .await
                .map_err(|_| "account-parser-failed")??;
        owner.check()?;
        Ok(DetailsReply {
            schema_version: 1,
            account_id: resolved.metadata.id.clone(),
            revision: resolved.metadata.revision.to_string(),
            item_id: request.item_id.clone(),
            details,
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn account_series_info(
    request: SeriesRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<SeriesInfo, String> {
    let resolve_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let revision = revision(
            request.schema_version,
            &request.account_id,
            &request.expected_revision,
        )?;
        if !plain_id(&request.series_id) {
            return Err("account-vod-reference-invalid".into());
        }
        let (resolved, _) =
            resolve(&owner, &resolve_app, request.account_id.clone(), revision).await?;
        let policy = DisplayPolicy::new(&resolved.secret);
        let deadline = Instant::now() + Duration::from_secs(30);
        let bytes = api(
            &resolved,
            &owner,
            &[
                ("action", "get_series_info"),
                ("series_id", &request.series_id),
            ],
            deadline,
        )
        .await?;
        let (episodes, skipped) = parse_episodes(&bytes, &policy)?;
        owner.check()?;
        Ok(SeriesInfo {
            schema_version: 1,
            account_id: resolved.metadata.id.clone(),
            revision: resolved.metadata.revision.to_string(),
            episodes,
            skipped,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_extensions_keep_titles_and_episodes_listed() {
        let movies = br#"[{"stream_id":7,"name":"No extension"},{"stream_id":8,"name":"Null","container_extension":null}]"#;
        let (items, skipped) = parse_items(movies, Section::Movies, &policy()).unwrap();
        assert_eq!((items.len(), skipped), (2, 0));
        assert!(items.iter().all(|i| i.extension.is_none()));
        let series = br#"{"episodes":{"1":[
            {"id":"501","episode_num":1,"title":"Pilot","container_extension":"mkv"},
            {"id":"502","episode_num":2,"title":"No extension"},
            {"id":"503","episode_num":3,"title":"Literal null","container_extension":"null"}
        ]}}"#;
        let (episodes, skipped) = parse_episodes(series, &policy()).unwrap();
        assert_eq!((episodes.len(), skipped), (3, 0));
        assert_eq!(episodes[0].extension.as_deref(), Some("mkv"));
        assert_eq!(episodes[1].extension, None);
        assert_eq!(episodes[2].extension, None, "never a .null address");
        // A movie's own detail gives its real container, or nothing.
        assert_eq!(
            vod_info_extension(br#"{"info":{},"movie_data":{"container_extension":"mkv"}}"#)
                .as_deref(),
            Some("mkv")
        );
        assert_eq!(
            vod_info_extension(br#"{"info":{"container_extension":"MP4"}}"#).as_deref(),
            Some("mp4")
        );
        assert_eq!(
            vod_info_extension(br#"{"movie_data":{"container_extension":"null"}}"#),
            None
        );
        assert_eq!(vod_info_extension(b"not json"), None);
    }
    fn policy() -> DisplayPolicy {
        DisplayPolicy::new(&Secret::Xtream {
            server_url: "http://tv.fixture.invalid:8080".into(),
            username: "fixtureuser".into(),
            password: "fixturepass".into(),
        })
    }
    #[test]
    fn playlist_links_yield_the_same_account_credentials() {
        let (base, user, pass) = credentials(&Secret::Playlist {
            url: "http://tv.fixture.invalid:8099/get.php?username=u1&password=p1&type=m3u_plus&output=ts".into(),
        })
        .unwrap();
        assert_eq!(base.as_str(), "http://tv.fixture.invalid:8099/");
        assert_eq!((user.as_str(), pass.as_str()), ("u1", "p1"));
        for url in [
            "http://tv.fixture.invalid/playlist.m3u",
            "http://tv.fixture.invalid/get.php?username=u1",
        ] {
            assert!(credentials(&Secret::Playlist { url: url.into() }).is_err());
        }
    }
    #[test]
    fn listings_skip_unusable_titles_and_never_show_the_sign_in() {
        let bytes = br#"[
          {"stream_id":101,"name":"Movie One","year":"1999","rating":"7.5","container_extension":"mkv","stream_icon":"https://img.fixture.invalid/a.jpg"},
          {"stream_id":"102","name":"Movie Two","container_extension":"exe","stream_icon":"http://img.fixture.invalid/b.jpg"},
          {"stream_id":"103","name":"Leaks fixturepass"},
          {"stream_id":"x","name":"Bad id"},
          {"stream_id":104,"name":"See http://x"},
          {"stream_id":105,"name":"Poster leak","stream_icon":"https://img.fixture.invalid/fixtureuser.jpg"}
        ]"#;
        let (items, skipped) = parse_items(bytes, Section::Movies, &policy()).unwrap();
        assert_eq!(skipped, 3);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].extension.as_deref(), Some("mkv"));
        assert_eq!(items[0].year.as_deref(), Some("1999"));
        assert!(items[0].poster.is_some());
        // An unknown container stays unknown (XC-021: never a guessed .mp4);
        // the title stays listed. Plain-HTTP poster is dropped.
        assert_eq!(items[1].extension, None);
        assert!(items[1].poster.is_none());
        assert!(items[2].poster.is_none());
        assert!(parse_items(b"{}", Section::Movies, &policy())
            .unwrap()
            .0
            .is_empty());
    }
    #[test]
    fn details_show_the_providers_own_description_and_never_the_sign_in() {
        // get_vod_info: plot with line breaks, genre, cast, length, backdrop list.
        let movie = br#"{"info":{"plot":"A witch returns.\r\nShe brings friends.","genre":"Comedy, Fantasy",
            "director":"Susanne Bier","cast":"Sandra Bullock, Nicole Kidman","duration_secs":"7260",
            "releasedate":"2026-09-18","rating":"6.3","backdrop_path":["https://img.fixture.invalid/back.jpg"],
            "movie_image":"https://img.fixture.invalid/poster.jpg"},"movie_data":{"stream_id":7}}"#;
        let d = parse_details(movie, Section::Movies, &policy()).unwrap();
        assert_eq!(
            d.plot.as_deref(),
            Some("A witch returns. She brings friends.")
        );
        assert_eq!(d.genre.as_deref(), Some("Comedy, Fantasy"));
        assert_eq!(d.director.as_deref(), Some("Susanne Bier"));
        assert_eq!(d.cast.as_deref(), Some("Sandra Bullock, Nicole Kidman"));
        assert_eq!(d.duration_seconds, Some(7260));
        assert_eq!(d.year.as_deref(), Some("2026"));
        assert_eq!(
            d.backdrop.as_deref(),
            Some("https://img.fixture.invalid/back.jpg")
        );
        // get_series_info keeps its details under "info" too; backdrop may be a string.
        let series = br#"{"info":{"plot":"Detectives.","genre":"Crime","releaseDate":"2019-01-01",
            "backdrop_path":"https://img.fixture.invalid/s.jpg","episode_run_time":"45"},"episodes":{}}"#;
        let s = parse_details(series, Section::Series, &policy()).unwrap();
        assert_eq!(s.plot.as_deref(), Some("Detectives."));
        assert_eq!(s.duration_seconds, Some(45 * 60));
        assert_eq!(
            s.backdrop.as_deref(),
            Some("https://img.fixture.invalid/s.jpg")
        );
        // Anything that could carry the sign-in, a link, or plain HTTP art is left out.
        let tainted = br#"{"info":{"plot":"Watch at http://x","genre":"fixtureuser",
            "backdrop_path":["http://img.fixture.invalid/a.jpg"],"duration_secs":"-5"}}"#;
        let t = parse_details(tainted, Section::Movies, &policy()).unwrap();
        assert_eq!(
            (t.plot, t.genre, t.backdrop, t.duration_seconds),
            (None, None, None, None)
        );
        // Nothing usable is an empty detail, not an error; malformed JSON is an error.
        assert!(parse_details(b"[]", Section::Movies, &policy())
            .unwrap()
            .plot
            .is_none());
        assert!(parse_details(b"<html>", Section::Movies, &policy()).is_err());
    }
    #[test]
    fn episodes_are_ordered_and_bounded_to_known_containers() {
        let bytes = br#"{"episodes":{"2":[{"id":"21","episode_num":1,"title":"S2E1","container_extension":"mp4"}],
          "1":[{"id":"12","episode_num":"2","title":"S1E2","container_extension":"mkv","info":{"duration_secs":"1500"}},
               {"id":"11","episode_num":1,"title":"S1E1","container_extension":"mp4"},
               {"id":"13","episode_num":3,"title":"Bad","container_extension":"zip"}]}}"#;
        let (episodes, skipped) = parse_episodes(bytes, &policy()).unwrap();
        // An unplayable container keeps its episode listed, format unknown (XC-021).
        assert_eq!(skipped, 0);
        let order: Vec<_> = episodes.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(order, ["11", "12", "13", "21"]);
        assert_eq!(episodes[1].duration_seconds, Some(1500));
        assert_eq!(episodes[2].extension, None);
    }
}

/// Cheap recheck for an active VOD session: the account still exists at the
/// same revision (removal or edit stops playback). No secret is decrypted.
pub(crate) async fn verify(
    owner: Arc<Context>,
    account_id: String,
    revision: u64,
) -> Result<(), String> {
    owner
        .storage_with_generation(None, move |store, generation, check| {
            store.with_guide_read(|c| {
                account_vault::prepare_resolve(c, &account_id, revision, generation, check)
                    .map(|_| ())
            })
        })
        .await
        .map(|_| ())
}
