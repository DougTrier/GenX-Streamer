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

#[cfg(test)]
#[path = "archive_discovery_tests.rs"]
mod tests;

// This module's parts, by area, are in archive_discovery/.
mod metadata;
use metadata::*;
mod file_pages;
use file_pages::*;
mod commands;
pub use commands::*;
mod media;
pub use media::*;
