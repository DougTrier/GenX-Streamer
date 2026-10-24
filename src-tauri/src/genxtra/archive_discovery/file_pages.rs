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

//! Reading a title's file list from partial headers, page by page.

use super::*;

pub(super) struct PartialHeader {
    pub(super) document: Value,
    pub(super) count: u32,
    pub(super) fingerprint: String,
}

pub(super) async fn partial_field(
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

pub(super) async fn partial_header(
    client: &Client,
    id: &str,
    owner: Arc<Context>,
    deadline: Instant,
    budget: Arc<AtomicUsize>,
) -> Result<PartialHeader, String> {
    partial_header_inner(client, id, owner, deadline, budget, false).await
}

pub(super) async fn partial_header_inner(
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

pub(super) fn parse_partial_header(id: &str, values: &[Value]) -> Result<PartialHeader, String> {
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
pub(super) async fn acquire_file_page(
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
