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

//! Provider claims are bounded data, never network or decoder authority.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Provider {
    Loc,
    Nasa,
    Commons,
}
impl Provider {
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Loc => "loc",
            Self::Nasa => "nasa",
            Self::Commons => "commons",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SearchHit {
    pub item_id: String,
    pub title: String,
    pub metadata_url: String,
    pub source_url: String,
    pub search_document: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SearchPage {
    pub hits: Vec<SearchHit>,
    pub next_cursor: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProviderItem {
    pub provider: Provider,
    pub item_id: String,
    pub title: String,
    pub source_url: String,
    pub metadata_url: String,
    pub description: Option<String>,
    pub subjects: Vec<String>,
    pub creators: Vec<String>,
    pub languages: Vec<String>,
    pub release_year: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_claims: Option<ProviderDateClaims>,
    pub content_type: String,
    pub rights: Option<String>,
    pub license_url: Option<String>,
    pub attribution: Option<String>,
    pub access_restricted: Option<bool>,
    pub download_allowed: Option<bool>,
    pub revision: Option<String>,
    pub variants: Vec<ProviderVariant>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderDateClaims {
    pub schema_version: u32,
    pub provider_created: ProviderCreatedClaim,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProviderCreatedClaim {
    pub field: String,
    pub value: String,
    pub provenance: String,
}
pub(crate) fn provider_created_value(value: &str) -> bool {
    static DATE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let shape = DATE.get_or_init(|| regex::Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$").expect("constant provider date shape"));
    use chrono::Datelike;
    plain(value, 64)
        && shape.is_match(value)
        && chrono::DateTime::parse_from_rfc3339(value)
            .is_ok_and(|date| (1..=9999).contains(&date.year()))
}
pub(crate) fn nasa_date_claim(value: &str) -> Option<ProviderDateClaims> {
    provider_created_value(value).then(|| ProviderDateClaims {
        schema_version: 1,
        provider_created: ProviderCreatedClaim {
            field: "date_created".into(),
            value: value.into(),
            provenance: "provider-search-record".into(),
        },
    })
}
/// Legacy NASA rows contain creation years in this field. Preserve their stored
/// bytes, but never expose those values as original publication evidence.
pub(crate) fn effective_release_year(item: &ProviderItem) -> Option<i64> {
    if item.provider == Provider::Nasa {
        None
    } else {
        item.release_year
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProviderVariant {
    pub asset_id: String,
    pub variant_id: String,
    pub file_name: String,
    pub title: Option<String>,
    pub target_url: String,
    pub mime_type: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub size_bytes: Option<String>,
    pub sha1: Option<String>,
    pub duration_seconds: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub representation_role: Option<String>,
    pub content_role: Option<String>,
    pub original_variant_id: Option<String>,
}

pub(crate) fn plain(s: &str, max: usize) -> bool {
    static CONTROLS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let controls = CONTROLS.get_or_init(|| {
        regex::Regex::new(r"[\p{Cc}\p{Cf}]").expect("constant Unicode control regex")
    });
    !s.trim().is_empty() && s.len() <= max && !controls.is_match(s)
}
pub(crate) fn item_id(provider: Provider, s: &str) -> bool {
    match provider {
        Provider::Commons => {
            !s.is_empty()
                && s.len() <= 20
                && s.bytes().all(|b| b.is_ascii_digit())
                && !s.starts_with('0')
        }
        Provider::Nasa => {
            plain(s, 512)
                && s.trim() == s
                && !matches!(s, "." | "..")
                && !s.chars().any(|c| matches!(c, '/' | '\\' | '?' | '#' | '%'))
        }
        Provider::Loc => {
            plain(s, 256)
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                && s.as_bytes()[0].is_ascii_alphanumeric()
        }
    }
}
/// Preserve the provider ID verbatim in storage; escape it only as one URL path
/// segment. NASA publishes IDs containing spaces and Unicode punctuation.
pub(crate) fn nasa_item_segment(id: &str) -> Result<String, String> {
    if !item_id(Provider::Nasa, id) {
        return Err("archive-nasa-item-id-invalid".into());
    }
    let mut url = reqwest::Url::parse("https://images-api.nasa.gov/")
        .map_err(|_| "archive-nasa-item-id-invalid")?;
    url.path_segments_mut()
        .map_err(|_| "archive-nasa-item-id-invalid")?
        .push(id);
    Ok(url.path()[1..].to_owned())
}
pub(crate) fn title_ref(p: Provider, id: &str) -> String {
    crate::archive_catalog::opaque(&["public-archive-item-v1", p.id(), id])
}
pub(crate) fn file_ref(p: Provider, id: &str, v: &ProviderVariant) -> String {
    crate::archive_catalog::opaque(&[
        "public-archive-file-v1",
        p.id(),
        id,
        &v.asset_id,
        &v.variant_id,
    ])
}
pub(crate) fn validate_item(i: &ProviderItem) -> Result<(), String> {
    if let Some(claims) = &i.date_claims {
        if claims.schema_version != 1 {
            return Err("public-archive-metadata-version-unsupported".into());
        }
        if i.provider != Provider::Nasa
            || claims.provider_created.field != "date_created"
            || claims.provider_created.provenance != "provider-search-record"
            || !provider_created_value(&claims.provider_created.value)
        {
            return Err("public-archive-metadata-invalid".into());
        }
    }
    let optional = |v: &Option<String>, n| v.as_deref().is_none_or(|s| plain(s, n));
    if !item_id(i.provider, &i.item_id)
        || !plain(&i.title, 512)
        || i.title.contains("://")
        || !plain(&i.source_url, 4096)
        || !plain(&i.metadata_url, 4096)
        || !optional(&i.description, 4096)
        || !optional(&i.rights, 4096)
        || !optional(&i.attribution, 4096)
        || !optional(&i.license_url, 4096)
        || i.license_url
            .as_deref()
            .is_some_and(|u| crate::archive_provider_net::license_reference(u).is_none())
        || !optional(&i.revision, 1024)
        || !["tv", "movie", "short", "unknown"].contains(&i.content_type.as_str())
        || i.release_year.is_some_and(|y| !(1888..=2100).contains(&y))
        || [&i.subjects, &i.creators, &i.languages]
            .iter()
            .any(|values| values.len() > 32 || values.iter().any(|s| !plain(s, 256)))
        || i.variants.len() > 1000
    {
        return Err("public-archive-metadata-invalid".into());
    }
    crate::archive_provider_net::source_url(i.provider, &i.item_id, &i.source_url)?;
    let mut ids = std::collections::HashSet::new();
    for v in &i.variants {
        if !plain(&v.asset_id, 1024)
            || !plain(&v.variant_id, 1024)
            || !ids.insert((&v.asset_id, &v.variant_id))
            || !plain(&v.file_name, 1024)
            || v.file_name.contains("://")
            || v.title.as_ref().is_some_and(|s| s.contains("://"))
            || !plain(&v.target_url, 4096)
            || !optional(&v.title, 512)
            || !optional(&v.mime_type, 128)
            || !optional(&v.video_codec, 128)
            || !optional(&v.audio_codec, 128)
            || !optional(&v.representation_role, 128)
            || !optional(&v.content_role, 128)
            || !optional(&v.original_variant_id, 1024)
            || v.size_bytes.as_deref().is_some_and(|s| {
                s.parse::<u64>()
                    .ok()
                    .is_none_or(|n| n == 0 || n > 64 * 1024 * 1024 * 1024 || n.to_string() != s)
            })
            || v.sha1
                .as_ref()
                .is_some_and(|s| s.len() != 40 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
            || v.duration_seconds
                .is_some_and(|n| !n.is_finite() || n <= 0.0 || n > 604800.0)
            || [v.width, v.height]
                .into_iter()
                .flatten()
                .any(|n| n == 0 || n > 32768)
        {
            return Err("public-archive-metadata-invalid".into());
        }
        // Listed unsupported files remain inventory. Their locator still has to
        // belong to this provider; no arbitrary third-party download is retained.
        crate::archive_provider_net::media_url(i.provider, &i.item_id, &v.target_url)?;
    }
    Ok(())
}
