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

//! Pure NASA Image and Video Library normalization. Asset manifests enumerate
//! files; they do not prove that every encoding shares the original's codecs.
use crate::archive_provider_contract::{
    Provider, ProviderItem, ProviderVariant, SearchHit, SearchPage,
};
use reqwest::Url;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const INVALID: &str = "archive-nasa-response-invalid";

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn texts(value: Option<&Value>) -> Result<Vec<String>, String> {
    let values: Vec<&Value> = match value {
        Some(Value::Array(values)) if values.len() <= 256 => values.iter().collect(),
        Some(Value::Array(_)) => return Err("archive-nasa-field-limit".into()),
        Some(value @ Value::String(_)) => vec![value],
        _ => vec![],
    };
    let mut result = Vec::new();
    for value in values {
        if let Some(value) = text(Some(value)) {
            if value.len() > 65_536 {
                return Err("archive-nasa-field-limit".into());
            }
            if !result.contains(&value) {
                result.push(value);
            }
        }
    }
    Ok(result)
}

fn valid_id(id: &str) -> bool {
    crate::archive_provider_contract::item_id(Provider::Nasa, id)
}

fn asset_url(id: &str) -> Result<String, String> {
    Ok(format!(
        "https://images-api.nasa.gov/asset/{}",
        crate::archive_provider_contract::nasa_item_segment(id)?
    ))
}

fn data(hit: &Value) -> Result<&Value, String> {
    let entries = hit.get("data").and_then(Value::as_array).ok_or(INVALID)?;
    // Search items are a single NASA record. Multiple conflicting records must
    // not be resolved by silently choosing whichever happens to be first.
    if entries.len() != 1 || !entries[0].is_object() {
        return Err(INVALID.into());
    }
    Ok(&entries[0])
}

fn api_identity(url: &str, path: &str) -> bool {
    Url::parse(url).ok().is_some_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("images-api.nasa.gov")
            && url.path() == path
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.fragment().is_none()
            && url.query().is_none()
    })
}

fn source(hit: &Value, id: &str) -> Result<String, String> {
    let raw = hit.get("href").and_then(Value::as_str).ok_or(INVALID)?;
    let mut url = Url::parse(raw).map_err(|_| INVALID)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str() != Some("images-assets.nasa.gov")
        || url.path()
            != format!(
                "/video/{}/collection.json",
                crate::archive_provider_contract::nasa_item_segment(id)?
            )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err("archive-nasa-source-invalid".into());
    }
    // This is a metadata locator, not permission to fetch or upgrade media.
    url.set_scheme("https").map_err(|_| INVALID)?;
    Ok(url.into())
}

fn next_cursor(collection: &Value) -> Result<Option<String>, String> {
    let Some(links) = collection.get("links").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let links = links.as_array().ok_or(INVALID)?;
    if links.len() > 32 {
        return Err("archive-nasa-link-limit".into());
    }
    let next: Vec<_> = links
        .iter()
        .filter(|link| link.get("rel").and_then(Value::as_str) == Some("next"))
        .collect();
    if next.is_empty() {
        return Ok(None);
    }
    if next.len() != 1 {
        return Err("archive-nasa-continuation-invalid".into());
    }
    let raw = next[0].get("href").and_then(Value::as_str).ok_or(INVALID)?;
    let url = Url::parse(raw).map_err(|_| INVALID)?;
    // NASA itself currently emits HTTP next links even for HTTPS requests.
    // Extract only the numeric page, never return or follow this remote URL.
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str() != Some("images-api.nasa.gov")
        || url.path() != "/search"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("archive-nasa-continuation-invalid".into());
    }
    let pages: Vec<_> = url
        .query_pairs()
        .filter(|(name, _)| name == "page")
        .collect();
    if pages.len() != 1 {
        return Err("archive-nasa-continuation-invalid".into());
    }
    let raw = pages[0].1.as_ref();
    let page = raw
        .parse::<u32>()
        .map_err(|_| "archive-nasa-continuation-invalid")?;
    if !(2..=100_000).contains(&page) || raw != page.to_string() {
        return Err("archive-nasa-continuation-invalid".into());
    }
    Ok(Some(page.to_string()))
}

pub(crate) fn parse_search(document: &Value) -> Result<SearchPage, String> {
    let collection = document
        .get("collection")
        .filter(|v| v.is_object())
        .ok_or(INVALID)?;
    let items = collection
        .get("items")
        .and_then(Value::as_array)
        .ok_or(INVALID)?;
    if items.len() > 100 {
        return Err("archive-nasa-result-limit".into());
    }
    let mut hits = Vec::new();
    let mut identities = BTreeSet::new();
    for hit in items {
        let metadata = data(hit)?;
        if metadata.get("media_type").and_then(Value::as_str) != Some("video") {
            continue;
        }
        let id = metadata
            .get("nasa_id")
            .and_then(Value::as_str)
            .ok_or(INVALID)?;
        if !valid_id(id) {
            return Err("archive-nasa-item-id-invalid".into());
        }
        if !identities.insert(id.to_owned()) {
            return Err("archive-nasa-duplicate-item".into());
        }
        let title = text(metadata.get("title")).ok_or(INVALID)?;
        hits.push(SearchHit {
            item_id: id.into(),
            title,
            metadata_url: asset_url(id)?,
            source_url: source(hit, id)?,
            search_document: hit.clone(),
        });
    }
    Ok(SearchPage {
        hits,
        next_cursor: next_cursor(collection)?,
    })
}

pub(crate) fn parse_item(
    expected_id: &str,
    search_document: &Value,
    asset_document: &Value,
) -> Result<ProviderItem, String> {
    if !valid_id(expected_id) {
        return Err("archive-nasa-item-id-invalid".into());
    }
    let metadata = data(search_document)?;
    if metadata.get("nasa_id").and_then(Value::as_str) != Some(expected_id)
        || metadata.get("media_type").and_then(Value::as_str) != Some("video")
    {
        return Err("archive-nasa-item-mismatch".into());
    }
    let collection = asset_document
        .get("collection")
        .filter(|v| v.is_object())
        .ok_or(INVALID)?;
    let href = collection
        .get("href")
        .and_then(Value::as_str)
        .ok_or(INVALID)?;
    if !api_identity(
        href,
        &format!(
            "/asset/{}",
            crate::archive_provider_contract::nasa_item_segment(expected_id)?
        ),
    ) {
        return Err("archive-nasa-asset-mismatch".into());
    }
    let entries = collection
        .get("items")
        .and_then(Value::as_array)
        .ok_or(INVALID)?;
    if entries.len() > 1_000 {
        return Err("archive-nasa-file-limit".into());
    }
    let mut variants = Vec::new();
    let mut seen = BTreeSet::new();
    for entry in entries {
        let target = entry
            .get("href")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or(INVALID)?;
        if !seen.insert(target.to_owned()) {
            continue;
        }
        let url = Url::parse(target).map_err(|_| INVALID)?;
        let file_name = url
            .path_segments()
            .and_then(|mut parts| parts.next_back())
            .filter(|s| !s.is_empty())
            .ok_or(INVALID)?
            .to_owned();
        // Keep exact listed unsupported files, including sidecars and originals.
        // URL suffixes are not MIME, codec, size or rendition identity evidence.
        variants.push(ProviderVariant {
            asset_id: expected_id.into(),
            variant_id: format!("{:x}", Sha256::digest(target.as_bytes())),
            file_name,
            target_url: target.into(),
            title: None,
            mime_type: None,
            video_codec: None,
            audio_codec: None,
            size_bytes: None,
            sha1: None,
            duration_seconds: None,
            width: None,
            height: None,
            representation_role: None,
            content_role: None,
            original_variant_id: None,
        });
    }
    Ok(ProviderItem {
        provider: Provider::Nasa,
        item_id: expected_id.into(),
        title: text(metadata.get("title")).ok_or(INVALID)?,
        source_url: source(search_document, expected_id)?,
        metadata_url: asset_url(expected_id)?,
        description: text(metadata.get("description")),
        subjects: texts(metadata.get("keywords"))?,
        creators: texts(metadata.get("creator"))?,
        languages: texts(metadata.get("language"))?,
        release_year: None,
        date_claims: metadata
            .get("date_created")
            .and_then(Value::as_str)
            .and_then(crate::archive_provider_contract::nasa_date_claim),
        content_type: "unknown".into(),
        rights: text(metadata.get("copyright")).or_else(|| text(metadata.get("rights"))),
        license_url: text(metadata.get("license_url")),
        attribution: text(metadata.get("credit")),
        access_restricted: None,
        download_allowed: None,
        revision: None,
        variants,
    })
}

#[cfg(test)]
#[path = "archive_provider_nasa_tests.rs"]
mod tests;
