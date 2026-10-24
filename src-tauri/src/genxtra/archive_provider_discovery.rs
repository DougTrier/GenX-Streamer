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

//! Explicit, resumable public-provider steps sharing the canonical catalog CAS.
use crate::{
    archive_catalog as legacy, archive_provider_catalog as catalog,
    archive_provider_contract::{self as contract, Provider, ProviderItem, SearchPage},
    archive_provider_net as net,
    scan_manifest_work::{self, Context},
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tokio::time::Instant;
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub schema_version: u8,
    pub request_id: String,
    pub expected_revision: String,
    pub query: String,
    pub decade: Option<i64>,
    pub language_mode: legacy::LanguageMode,
    pub content_type: legacy::ContentType,
    pub curated_only: bool,
    pub favorites_only: bool,
    pub restart: bool,
    pub explicit_action: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderOutcome {
    pub provider_id: String,
    pub state: String,
    pub examined: usize,
    pub admitted: usize,
    pub retry_after_ms: Option<i64>,
    pub reason: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    pub schema_version: u8,
    pub committed: bool,
    pub revision: String,
    pub examined: usize,
    pub admitted: usize,
    pub providers: Vec<ProviderOutcome>,
    pub more: bool,
}
struct Acquired {
    provider: Provider,
    cursor: catalog::Cursor,
    items: Vec<ProviderItem>,
    outcome: ProviderOutcome,
}
fn cursor_encoding(cursor: &catalog::Cursor) -> Result<String, String> {
    serde_json::to_string(cursor).map_err(|_| "public-archive-progress-invalid".into())
}
fn receipt(revision: i64, outcomes: Vec<ProviderOutcome>) -> Result<Receipt, String> {
    let examined = outcomes
        .iter()
        .try_fold(0usize, |n, p| n.checked_add(p.examined))
        .ok_or("public-archive-receipt-invalid")?;
    let admitted = outcomes
        .iter()
        .try_fold(0usize, |n, p| n.checked_add(p.admitted))
        .ok_or("public-archive-receipt-invalid")?;
    if examined > 12 || admitted > 12 {
        return Err("public-archive-receipt-invalid".into());
    }
    let more = outcomes
        .iter()
        .any(|p| matches!(p.state.as_str(), "partial" | "waiting" | "failed"));
    Ok(Receipt {
        schema_version: 1,
        committed: true,
        revision: revision.to_string(),
        examined,
        admitted,
        providers: outcomes,
        more,
    })
}

#[cfg(test)]
#[path = "archive_provider_write_tests.rs"]
mod write_tests;
/// Local final admission only; Context retains the root generation around this
/// call. No network work or speculative transaction participates in preflight.
fn commit_acquired(
    store: &crate::storage::Store,
    expected: &str,
    scope: &str,
    results: &[Acquired],
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Receipt, String> {
    store.with_archive_write_checked(
        expected,
        |c| {
            if results.iter().any(|r| !r.items.is_empty()) {
                return Ok(None);
            }
            for acquired in results {
                let before = catalog::cursor(c, scope, acquired.provider, false)?;
                if cursor_encoding(&before)? != cursor_encoding(&acquired.cursor)? {
                    return Ok(None);
                }
            }
            let outcomes = results
                .iter()
                .map(|r| {
                    let mut outcome = r.outcome.clone();
                    outcome.admitted = 0;
                    outcome
                })
                .collect();
            receipt(legacy::current(c)?, outcomes).map(Some)
        },
        |c, check| {
            let tx = c
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|_| "public-archive-storage-failed")?;
            let old = legacy::current(&tx)?;
            if old != legacy::revision(expected)? {
                return Err("archive-revision-stale".into());
            }
            let mut outcomes = Vec::new();
            let mut changed = false;
            for acquired in results {
                check()?;
                let before = catalog::cursor(&tx, scope, acquired.provider, false)?;
                let mut outcome = acquired.outcome.clone();
                outcome.admitted = 0;
                for item in &acquired.items {
                    // Even matching metadata is a real observation/timestamp write.
                    if catalog::upsert(&tx, item, legacy::now_ms()?)? {
                        outcome.admitted += 1;
                        changed = true;
                    }
                }
                if cursor_encoding(&before)? != cursor_encoding(&acquired.cursor)? {
                    catalog::save_cursor(&tx, scope, acquired.provider, &acquired.cursor)?;
                    changed = true;
                }
                outcomes.push(outcome);
            }
            let revision = if changed {
                old.checked_add(1).ok_or("archive-revision-exhausted")?
            } else {
                old
            };
            if changed {
                tx.execute(
                    "UPDATE archive_catalog_meta_v1 SET revision=?1 WHERE singleton=1",
                    params![revision],
                )
                .map_err(|_| "public-archive-storage-failed")?;
            }
            let result = receipt(revision, outcomes)?;
            crate::archive_library_store::finalize(&tx, false, check)?;
            check()?;
            tx.commit().map_err(|_| "public-archive-storage-failed")?;
            Ok(result)
        },
        check,
    )
}
static OWNER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn validate(r: &Request) -> Result<(), String> {
    if r.schema_version != 1
        || !r.explicit_action
        || !contract::plain(&r.request_id, 128)
        || !contract::plain(&r.query, 256)
        || r.query.contains("://")
        || !legacy::valid_decade(r.decade)
    {
        return Err("public-archive-request-invalid".into());
    }
    legacy::revision(&r.expected_revision)?;
    Ok(())
}
fn scope(r: &Request) -> String {
    legacy::opaque(&[
        "public-archive-discovery-v2",
        &r.query.trim().to_lowercase(),
        &legacy::search_scope_hash(&r.query.trim().to_lowercase(), r.decade),
        &format!(
            "{:?}|{:?}|{:?}|{}|{}",
            r.decade, r.language_mode, r.content_type, r.curated_only, r.favorites_only
        ),
    ])
}
fn search_url(p: Provider, q: &str, cursor: Option<&str>) -> Result<String, String> {
    let mut u = reqwest::Url::parse(match p {
        Provider::Loc => "https://www.loc.gov/film-and-videos/",
        Provider::Nasa => "https://images-api.nasa.gov/search",
        Provider::Commons => "https://commons.wikimedia.org/w/api.php",
    })
    .map_err(|_| "public-archive-url-refused")?;
    let page = || -> Result<String, String> {
        let s = cursor.unwrap_or("1");
        let n = s
            .parse::<u32>()
            .ok()
            .filter(|n| (1..=25000).contains(n) && n.to_string() == s)
            .ok_or("public-archive-progress-invalid")?;
        Ok(n.to_string())
    };
    match p {
        Provider::Loc => {
            u.query_pairs_mut()
                .append_pair("fo", "json")
                .append_pair("c", "4")
                .append_pair("q", q)
                .append_pair("sp", &page()?);
        }
        Provider::Nasa => {
            u.query_pairs_mut()
                .append_pair("q", q)
                .append_pair("media_type", "video")
                .append_pair("page_size", "4")
                .append_pair("page", &page()?);
        }
        Provider::Commons => {
            u.query_pairs_mut()
                .append_pair("action", "query")
                .append_pair("format", "json")
                .append_pair("formatversion", "2")
                .append_pair("generator", "search")
                .append_pair("gsrsearch", &format!("filetype:video {q}"))
                .append_pair("gsrnamespace", "6")
                .append_pair("gsrlimit", "4")
                .append_pair("prop", "videoinfo")
                .append_pair(
                    "viprop",
                    "timestamp|url|size|mime|sha1|derivatives|extmetadata|mediatype|metadata",
                )
                .append_pair("vilimit", "1")
                .append_pair("viextmetadatalanguage", "en")
                .append_pair("maxlag", "5");
            if let Some(cursor) = cursor {
                if cursor.len() > 2048 {
                    return Err("public-archive-progress-invalid".into());
                }
                let v: serde_json::Value =
                    serde_json::from_str(cursor).map_err(|_| "public-archive-progress-invalid")?;
                let object = v
                    .as_object()
                    .filter(|o| o.len() <= 2)
                    .ok_or("public-archive-progress-invalid")?;
                for (k, v) in object {
                    match (k.as_str(), v) {
                        ("continue", serde_json::Value::String(s)) if contract::plain(s, 128) => {
                            u.query_pairs_mut().append_pair(k, s);
                        }
                        ("gsroffset", v) if v.as_u64().is_some_and(|n| n <= 100000) => {
                            u.query_pairs_mut()
                                .append_pair(k, &v.as_u64().unwrap().to_string());
                        }
                        _ => return Err("public-archive-progress-invalid".into()),
                    }
                }
            }
        }
    }
    Ok(u.into())
}
fn next_advances(p: Provider, before: Option<&str>, after: &str) -> Result<(), String> {
    let position = |cursor: Option<&str>| -> Option<u64> {
        if p == Provider::Commons {
            cursor.map_or(Some(0), |s| {
                serde_json::from_str::<serde_json::Value>(s)
                    .ok()?
                    .get("gsroffset")?
                    .as_u64()
            })
        } else {
            cursor.unwrap_or("1").parse().ok()
        }
    };
    if position(Some(after))
        .zip(position(before))
        .is_none_or(|(a, b)| a <= b)
    {
        return Err("public-archive-progress-invalid".into());
    }
    Ok(())
}
fn parse_search(p: Provider, v: &serde_json::Value) -> Result<SearchPage, String> {
    match p {
        Provider::Loc => crate::archive_provider_loc::parse_search(v),
        Provider::Nasa => crate::archive_provider_nasa::parse_search(v),
        Provider::Commons => crate::archive_provider_commons::parse_search(v),
    }
}
fn parse_item(
    p: Provider,
    id: &str,
    search: &serde_json::Value,
    v: &serde_json::Value,
) -> Result<ProviderItem, String> {
    match p {
        Provider::Loc => crate::archive_provider_loc::parse_item(id, v),
        Provider::Nasa => crate::archive_provider_nasa::parse_item(id, search, v),
        Provider::Commons => crate::archive_provider_commons::parse_item(id, v),
    }
}
fn admitted(item: &ProviderItem, r: &Request) -> Result<bool, String> {
    if r.curated_only
        || r.favorites_only
        || item.access_restricted == Some(true)
        || item.variants.is_empty()
        || !r.language_mode.includes(&item.languages)
        || r.decade.is_some_and(|d| {
            contract::effective_release_year(item)
                .is_none_or(|y| y < d || y > legacy::decade_end(d))
        })
    {
        return Ok(false);
    }
    let content = match item.content_type.as_str() {
        "tv" => legacy::ContentType::Tv,
        "movie" => legacy::ContentType::Movie,
        "short" => legacy::ContentType::Short,
        _ => legacy::ContentType::Unknown,
    };
    if r.content_type != legacy::ContentType::All && r.content_type != content {
        return Ok(false);
    }
    Ok(catalog::matches(item, &r.query)?.is_some())
}
fn failure_reason(error: &str) -> &'static str {
    match error {
        "public-archive-contact-required" => "public-archive-contact-required",
        "public-archive-timeout" => "public-archive-timeout",
        "public-archive-rate-limited" => "public-archive-rate-limited",
        "public-archive-server-unavailable" => "public-archive-server-unavailable",
        "public-archive-dns-unavailable" | "public-archive-network-unavailable" => {
            "public-archive-network-unavailable"
        }
        _ => "public-archive-metadata-unavailable",
    }
}
async fn acquire(
    p: Provider,
    mut cursor: catalog::Cursor,
    r: Request,
    owner: Arc<Context>,
    deadline: Instant,
) -> Result<Acquired, String> {
    let mut result = Acquired {
        provider: p,
        cursor: cursor.clone(),
        items: Vec::new(),
        outcome: ProviderOutcome {
            provider_id: p.id().into(),
            state: if cursor.complete {
                "complete"
            } else {
                "partial"
            }
            .into(),
            examined: 0,
            admitted: 0,
            retry_after_ms: None,
            reason: None,
        },
    };
    if cursor.complete {
        return Ok(result);
    }
    if r.curated_only || r.favorites_only {
        result.outcome.state = "complete".into();
        result.outcome.reason = Some("public-archive-view-does-not-acquire".into());
        return Ok(result);
    }
    if p == Provider::Commons && net::commons_agent().is_err() {
        result.outcome.state = "configuration-required".into();
        result.outcome.reason = Some("public-archive-contact-required".into());
        return Ok(result);
    }
    if let Some(until) = cursor
        .retry_after_ms
        .filter(|n| legacy::now_ms().is_ok_and(|now| *n > now))
    {
        result.outcome.state = "waiting".into();
        result.outcome.retry_after_ms = Some(until);
        result.outcome.reason = Some("public-archive-rate-limited".into());
        return Ok(result);
    }
    cursor.retry_after_ms = None;
    let mut budget = 0usize;
    let work = async {
        if cursor.pending.is_empty() {
            let raw = search_url(p, &r.query, cursor.cursor.as_deref())?;
            let document = net::json(p, &raw, &owner, deadline, &mut budget).await?;
            let page = parse_search(p, &document)?;
            if page.hits.len() > 4 || page.next_cursor.as_ref().is_some_and(|v| v.len() > 2048) {
                return Err("public-archive-response-limit".into());
            }
            if let Some(next) = &page.next_cursor {
                search_url(p, &r.query, Some(next))?;
                next_advances(p, cursor.cursor.as_deref(), next)?;
            }
            for hit in &page.hits {
                if !contract::item_id(p, &hit.item_id) || !contract::plain(&hit.title, 512) {
                    return Err("public-archive-metadata-invalid".into());
                }
                net::metadata_url(p, &hit.metadata_url)?;
                net::source_url(p, &hit.item_id, &hit.source_url)?;
            }
            cursor.pending = page.hits;
            cursor.next_cursor = page.next_cursor;
            cursor.started = true;
        }
        // Every distinct pending hit gets one attempt. A malformed or dead
        // record stays retryable without preventing the remaining hits/sources.
        let attempts = cursor.pending.len().min(4);
        let mut first_error = None;
        for _ in 0..attempts {
            net::check(&owner, deadline)?;
            let hit = cursor.pending.remove(0);
            result.outcome.examined += 1;
            let attempt = async {
                let document = if p == Provider::Commons {
                    hit.search_document.clone()
                } else {
                    net::json(p, &hit.metadata_url, &owner, deadline, &mut budget).await?
                };
                let item = parse_item(p, &hit.item_id, &hit.search_document, &document)?;
                contract::validate_item(&item)?;
                if item.provider != p || item.item_id != hit.item_id {
                    return Err("public-archive-metadata-invalid".into());
                }
                Ok::<ProviderItem, String>(item)
            }
            .await;
            owner.check()?;
            match attempt {
                Ok(item) => {
                    if admitted(&item, &r)? {
                        result.items.push(item);
                    }
                }
                Err(error) => {
                    cursor.pending.push(hit);
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        if cursor.pending.is_empty() {
            cursor.cursor = cursor.next_cursor.take();
            cursor.complete = cursor.cursor.is_none();
        }
        Ok::<(), String>(())
    }
    .await;
    owner.check()?;
    match work {
        Ok(()) => {
            result.outcome.state = if cursor.complete {
                "complete"
            } else {
                "partial"
            }
            .into();
        }
        Err(e) => {
            let reason = failure_reason(&e);
            result.outcome.state = if matches!(
                reason,
                "public-archive-timeout" | "public-archive-rate-limited"
            ) {
                "waiting"
            } else {
                "failed"
            }
            .into();
            result.outcome.reason = Some(reason.into());
            if result.outcome.state == "waiting" {
                result.outcome.retry_after_ms = Some(net::retry_until(p).unwrap_or(
                    legacy::now_ms()?
                        + if reason == "public-archive-rate-limited" {
                            60000
                        } else {
                            1000
                        },
                ));
                cursor.retry_after_ms = result.outcome.retry_after_ms;
            }
        }
    }
    result.cursor = cursor;
    Ok(result)
}
#[tauri::command]
pub(crate) async fn public_archive_discover_step(
    request: Request,
    app: tauri::AppHandle,
) -> Result<Receipt, String> {
    validate(&request)?;
    let scope = scope(&request);
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let deadline = Instant::now() + Duration::from_secs(20);
        let pending = OWNER.lock();
        tokio::pin!(pending);
        let _guard = loop {
            net::check(&owner, deadline)?;
            tokio::select! {
                g=&mut pending => break g,
                _=tokio::time::sleep(Duration::from_millis(25)) => {
                }
            }
        };
        let capture = request.clone();
        let key = scope.clone();
        let (states, generation) = owner
            .storage(None, move |s, check| {
                check()?;
                s.with_archive_read(|c| {
                    if legacy::current(c)? != legacy::revision(&capture.expected_revision)? {
                        return Err("archive-revision-stale".into());
                    }
                    if !catalog::installed(c)? {
                        return Err("public-archive-schema-incomplete".into());
                    }
                    let mut states = Vec::new();
                    for p in [Provider::Loc, Provider::Nasa, Provider::Commons] {
                        states.push((p, catalog::cursor(c, &key, p, capture.restart)?));
                    }
                    Ok(states)
                })
            })
            .await?;
        let mut tasks = Vec::new();
        for (p, cursor) in states {
            tasks.push(tokio::spawn(acquire(
                p,
                cursor,
                request.clone(),
                owner.clone(),
                deadline,
            )));
        }
        let mut results = Vec::new();
        let mut failure = None;
        for task in tasks {
            match task.await {
                Ok(Ok(v)) => results.push(v),
                Ok(Err(e)) => failure = Some(e),
                Err(_) => failure = Some("public-archive-work-join-failed".into()),
            }
        }
        owner.check()?;
        if let Some(error) = failure {
            return Err(error);
        }
        let (reply, _) = owner
            .storage(Some(generation), move |s, check| {
                commit_acquired(s, &request.expected_revision, &scope, &results, check)
            })
            .await?;
        Ok(reply)
    })
    .await
}
/// A fresh exact-item observation is required for each selected online variant.
pub(crate) async fn verify(
    owner: Arc<Context>,
    file: &catalog::Resolved,
    deadline: Instant,
) -> Result<crate::archive_discovery::VerifiedFile, String> {
    let mut budget = 0;
    let p = file.item.provider;
    let data = net::json(p, &file.item.metadata_url, &owner, deadline, &mut budget).await?;
    // NASA asset JSON binds the exact asset ID/locator; descriptive search
    // claims retain their previously observed provenance, never become fresh
    // selected-variant codec or size claims.
    let retained_search = serde_json::json!({"href":file.item.source_url,"data":[{"nasa_id":file.item.item_id,"title":file.item.title,"media_type":"video"}]});
    let current = parse_item(p, &file.item.item_id, &retained_search, &data)?;
    contract::validate_item(&current)?;
    if current.access_restricted == Some(true) {
        return Err("public-archive-access-refused".into());
    }
    let v = current
        .variants
        .iter()
        .find(|v| v.asset_id == file.variant.asset_id && v.variant_id == file.variant.variant_id)
        .ok_or("public-archive-file-unavailable")?;
    if v.target_url != file.variant.target_url
        || (file.item.revision.is_some() && current.revision != file.item.revision)
        || (file.variant.size_bytes.is_some() && file.variant.size_bytes != v.size_bytes)
        || (file.variant.sha1.is_some() && file.variant.sha1 != v.sha1)
    {
        return Err("public-archive-file-changed".into());
    }
    let target = net::media_url(p, &current.item_id, &v.target_url)?;
    let inspection = crate::archive_provider_probe::inspect(
        p,
        &target,
        v.size_bytes.as_deref(),
        &owner,
        deadline,
    )
    .await?;
    net::check(&owner, deadline)?;
    Ok(crate::archive_discovery::VerifiedFile {
        url: target.clone(),
        allowed_hosts: Vec::new(),
        expected_tail: String::new(),
        size_bytes: inspection.size,
        public: Some(ExactMedia {
            provider: p,
            target,
            mime: inspection.mime,
            video_codec: inspection.video_codec,
            audio_codec: inspection.audio_codec,
        }),
        mime: inspection.mime,
    })
}
#[derive(Clone)]
pub(crate) struct ExactMedia {
    pub provider: Provider,
    pub target: reqwest::Url,
    pub mime: &'static str,
    pub video_codec: &'static str,
    pub audio_codec: Option<&'static str>,
}
impl ExactMedia {
    pub(crate) fn validate(&self, url: &reqwest::Url) -> Result<(), String> {
        let codecs = match self.mime {
            "video/mp4" => {
                self.video_codec == "h264" && self.audio_codec.is_none_or(|c| c == "aac")
            }
            "video/webm" => {
                matches!(self.video_codec, "vp8" | "vp9")
                    && self
                        .audio_codec
                        .is_none_or(|c| matches!(c, "opus" | "vorbis"))
            }
            _ => false,
        };
        if !codecs || url != &self.target {
            return Err("public-archive-redirect-unverified".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nasa_incoming_and_legacy_numeric_years_do_not_establish_decade_eligibility() {
        let search: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/native/archive-nasa/apollo-search-page-2.json"
        ))
        .unwrap();
        let assets: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/native/archive-nasa/apollo-page-2-first-assets.json"
        ))
        .unwrap();
        let page = crate::archive_provider_nasa::parse_search(&search).unwrap();
        let hit = &page.hits[0];
        let mut item =
            crate::archive_provider_nasa::parse_item(&hit.item_id, &hit.search_document, &assets)
                .unwrap();
        let mut request = Request {
            schema_version: 1,
            request_id: "date-fixture".into(),
            expected_revision: "0".into(),
            query: "Apollo".into(),
            decade: None,
            language_mode: legacy::LanguageMode::All,
            content_type: legacy::ContentType::All,
            curated_only: false,
            favorites_only: false,
            restart: false,
            explicit_action: true,
        };
        assert!(admitted(&item, &request).unwrap());
        for year in [None, Some(1969), Some(1985), Some(2021)] {
            item.release_year = year;
            for decade in [1960, 1980, 2020] {
                request.decade = Some(decade);
                assert!(!admitted(&item, &request).unwrap());
            }
        }
    }
    #[test]
    fn cursor_progress_must_advance_not_loop() {
        assert!(next_advances(Provider::Loc, Some("2"), "2").is_err());
        assert!(next_advances(Provider::Nasa, None, "1").is_err());
        assert!(next_advances(Provider::Loc, Some("2"), "3").is_ok());
        assert!(next_advances(
            Provider::Commons,
            Some(r#"{"gsroffset":4,"continue":"x"}"#),
            r#"{"gsroffset":4,"continue":"y"}"#
        )
        .is_err());
    }
    #[test]
    fn cursor_rebuild_never_follows_remote_url() {
        assert!(search_url(Provider::Loc, "moon", Some("https://evil.invalid/")).is_err());
        assert!(search_url(
            Provider::Commons,
            "moon",
            Some(r#"{"gsroffset":4,"url":"https://evil.invalid/"}"#)
        )
        .is_err());
        let s = search_url(Provider::Nasa, "A&B", Some("2")).unwrap();
        assert!(s.contains("q=A%26B"));
        assert!(s.starts_with("https://images-api.nasa.gov/search?"));
    }
    #[test]
    fn archive_relevance_v9_public_scope_binds_matching_policy_without_reusing_old_checkpoints() {
        let mut request = Request {
            schema_version: 1,
            request_id: "scope".into(),
            expected_revision: "0".into(),
            query: "Gilligan".into(),
            decade: None,
            language_mode: legacy::LanguageMode::All,
            content_type: legacy::ContentType::All,
            curated_only: false,
            favorites_only: false,
            restart: false,
            explicit_action: true,
        };
        let filters = format!(
            "{:?}|{:?}|{:?}|{}|{}",
            request.decade,
            request.language_mode,
            request.content_type,
            request.curated_only,
            request.favorites_only
        );
        let old = legacy::opaque(&["public-archive-discovery-v1", "gilligan", &filters]);
        let current = scope(&request);
        assert_ne!(current, old);
        assert_eq!(
            current,
            legacy::opaque(&[
                "public-archive-discovery-v2",
                "gilligan",
                &legacy::search_scope_hash("gilligan", None),
                &filters
            ])
        );
        request.query = " GILLIGAN ".into();
        assert_eq!(scope(&request), current);
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE public_archive_checkpoint_v1(scope TEXT,provider TEXT,document TEXT)",
        )
        .unwrap();
        c.execute(
            "INSERT INTO public_archive_checkpoint_v1 VALUES(?1,'loc','old-valid-state')",
            [&old],
        )
        .unwrap();
        let changes = c.total_changes();
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM public_archive_checkpoint_v1 WHERE scope=?1",
                [scope(&request)],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row(
                "SELECT document FROM public_archive_checkpoint_v1 WHERE scope=?1",
                [old],
                |r| { r.get::<_, String>(0) }
            )
            .unwrap(),
            "old-valid-state"
        );
        assert_eq!(changes, c.total_changes());
    }
}
