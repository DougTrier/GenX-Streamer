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

//! Pure Library of Congress JSON normalization. This module never acquires media.
//! Only a file's own metadata can establish its codec, size or dimensions.
use crate::archive_provider_contract::{
    Provider, ProviderItem, ProviderVariant, SearchHit, SearchPage,
};
use reqwest::Url;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const MAX_RESULTS: usize = 150;
const MAX_FILES: usize = 2_048;
const INVALID: &str = "archive-loc-response-invalid";

fn optional_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn text_list(value: Option<&Value>) -> Result<Vec<String>, String> {
    let values: Vec<&Value> = match value {
        Some(Value::Array(values)) if values.len() <= 256 => values.iter().collect(),
        Some(Value::Array(_)) => return Err("archive-loc-field-limit".into()),
        Some(value @ Value::String(_)) => vec![value],
        _ => vec![],
    };
    let mut result = Vec::new();
    for value in values {
        if let Some(text) = optional_text(Some(value)) {
            if text.len() > 65_536 {
                return Err("archive-loc-field-limit".into());
            }
            if !result.contains(&text) {
                result.push(text);
            }
        }
    }
    Ok(result)
}

fn collect_texts(values: &[Option<&Value>]) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for value in values {
        for text in text_list(*value)? {
            if !result.contains(&text) {
                result.push(text);
            }
        }
    }
    if result.len() > 256 {
        return Err("archive-loc-field-limit".into());
    }
    Ok(result)
}

fn joined(values: &[Option<&Value>]) -> Result<Option<String>, String> {
    let texts = collect_texts(values)?;
    if texts.is_empty() {
        return Ok(None);
    }
    let result = texts.join(" ");
    if result.len() > 65_536 {
        return Err("archive-loc-field-limit".into());
    }
    Ok(Some(result))
}

fn prose(value: Option<String>) -> Option<String> {
    use std::sync::OnceLock;
    static TAGS: OnceLock<regex::Regex> = OnceLock::new();
    value
        .map(|text| {
            let without_tags = TAGS
                .get_or_init(|| regex::Regex::new("(?s)<[^>]*>").expect("fixed HTML tag pattern"))
                .replace_all(&text, " ");
            let entities = without_tags.replace("&nbsp;", " ");
            let decoded = quick_xml::escape::unescape(&entities)
                .map(|s| s.into_owned())
                .unwrap_or(entities);
            decoded.split_whitespace().collect::<Vec<_>>().join(" ")
        })
        .filter(|text| !text.is_empty())
}

fn item_identity(value: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| INVALID)?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str() != Some("www.loc.gov")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err(INVALID.into());
    }
    let id = url
        .path()
        .strip_prefix("/item/")
        .and_then(|s| s.strip_suffix('/'))
        .ok_or(INVALID)?;
    if id.is_empty()
        || id.len() > 200
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(INVALID.into());
    }
    Ok(id.into())
}

fn page_cursor(value: Option<&Value>) -> Result<Option<String>, String> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let text = value.as_str().ok_or(INVALID)?;
    let url = Url::parse(text).map_err(|_| INVALID)?;
    if url.scheme() != "https"
        || url.host_str() != Some("www.loc.gov")
        || url.path() != "/film-and-videos/"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("archive-loc-continuation-invalid".into());
    }
    let pages: Vec<_> = url.query_pairs().filter(|(name, _)| name == "sp").collect();
    if pages.len() != 1 {
        return Err("archive-loc-continuation-invalid".into());
    }
    let raw = pages[0].1.as_ref();
    let page = raw
        .parse::<u32>()
        .map_err(|_| "archive-loc-continuation-invalid")?;
    if !(2..=100_000).contains(&page) || raw != page.to_string() {
        return Err("archive-loc-continuation-invalid".into());
    }
    Ok(Some(page.to_string()))
}

pub(crate) fn parse_search(document: &Value) -> Result<SearchPage, String> {
    let results = document
        .get("results")
        .and_then(Value::as_array)
        .ok_or(INVALID)?;
    if results.len() > MAX_RESULTS {
        return Err("archive-loc-result-limit".into());
    }
    let mut hits = Vec::new();
    let mut identities = BTreeSet::new();
    for result in results {
        let raw = optional_text(result.get("id"))
            .or_else(|| optional_text(result.get("url")))
            .ok_or(INVALID)?;
        let id = item_identity(&raw)?;
        let title = optional_text(result.get("title")).ok_or(INVALID)?;
        if !identities.insert(id.clone()) {
            return Err("archive-loc-duplicate-item".into());
        }
        let source_url = format!("https://www.loc.gov/item/{id}/");
        hits.push(SearchHit {
            item_id: id,
            title,
            metadata_url: format!("{source_url}?fo=json"),
            source_url,
            search_document: result.clone(),
        });
    }
    Ok(SearchPage {
        hits,
        next_cursor: page_cursor(document.pointer("/pagination/next"))?,
    })
}

fn decimal(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let raw = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_u64().map(|n| n.to_string()))?;
    if raw.is_empty()
        || raw.len() > 20
        || !raw.bytes().all(|b| b.is_ascii_digit())
        || (raw.len() > 1 && raw.starts_with('0'))
    {
        return None;
    }
    raw.parse::<u64>()
        .ok()
        .filter(|n| *n > 0)
        .map(|n| n.to_string())
}

fn dimension(value: Option<&Value>) -> Option<u32> {
    decimal(value)?.parse().ok()
}

fn seconds(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    let n = value.as_f64().or_else(|| value.as_str()?.parse().ok())?;
    (n.is_finite() && n > 0.0).then_some(n)
}

fn unique<T: Clone + PartialEq>(values: impl Iterator<Item = Option<T>>) -> Option<T> {
    let mut result = None;
    for value in values.flatten() {
        if result.as_ref().is_some_and(|existing| existing != &value) {
            return None;
        }
        result = Some(value);
    }
    result
}

fn streams(node: &Value, kind: &str) -> Vec<Value> {
    node.get("streams")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|stream| stream.get("codec_type").and_then(Value::as_str) == Some(kind))
        .cloned()
        .collect()
}

fn variant(asset: &str, target: &str, node: &Value) -> Result<ProviderVariant, String> {
    let parsed = Url::parse(target).map_err(|_| INVALID)?;
    let file_name = parsed
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|name| !name.is_empty())
        .ok_or(INVALID)?
        .to_owned();
    let video = streams(node, "video");
    let audio = streams(node, "audio");
    // Generic player configuration MIME does not override an actual file MIME.
    let mime = optional_text(node.get("mimetype"))
        .or_else(|| optional_text(node.get("mime_type")))
        .filter(|mime| mime != "application/x-video");
    Ok(ProviderVariant {
        asset_id: asset.into(),
        variant_id: format!("{:x}", Sha256::digest(target.as_bytes())),
        file_name,
        target_url: target.into(),
        title: optional_text(node.get("title")).or_else(|| optional_text(node.get("shortName"))),
        mime_type: mime,
        video_codec: unique(
            video
                .iter()
                .map(|stream| optional_text(stream.get("codec_name"))),
        ),
        audio_codec: unique(
            audio
                .iter()
                .map(|stream| optional_text(stream.get("codec_name"))),
        ),
        size_bytes: unique(
            [
                decimal(node.get("size")),
                decimal(node.pointer("/format/size")),
            ]
            .into_iter(),
        ),
        sha1: None,
        duration_seconds: seconds(node.pointer("/format/duration"))
            .or_else(|| seconds(node.get("duration"))),
        width: unique(
            std::iter::once(dimension(node.get("width")))
                .chain(video.iter().map(|stream| dimension(stream.get("width")))),
        ),
        height: unique(
            std::iter::once(dimension(node.get("height")))
                .chain(video.iter().map(|stream| dimension(stream.get("height")))),
        ),
        representation_role: None,
        content_role: None,
        original_variant_id: None,
    })
}

fn inventory(
    value: &Value,
    asset: &str,
    depth: usize,
    variants: &mut Vec<ProviderVariant>,
) -> Result<(), String> {
    if depth > 12 {
        return Err("archive-loc-file-depth-limit".into());
    }
    match value {
        Value::Array(values) => {
            if values.len() > MAX_FILES {
                return Err("archive-loc-file-limit".into());
            }
            for value in values {
                inventory(value, asset, depth + 1, variants)?;
            }
        }
        Value::Object(_) => {
            for key in ["url", "download", "video", "video_stream"] {
                if let Some(target) = optional_text(value.get(key)) {
                    if variants.len() >= MAX_FILES {
                        return Err("archive-loc-file-limit".into());
                    }
                    variants.push(variant(asset, &target, value)?);
                }
            }
            for key in ["files", "captions", "static"] {
                if let Some(child) = value.get(key) {
                    inventory(child, asset, depth + 1, variants)?;
                }
            }
        }
        Value::Null => {}
        _ => return Err("archive-loc-files-invalid".into()),
    }
    Ok(())
}

fn merge_inventory(variants: Vec<ProviderVariant>) -> Vec<ProviderVariant> {
    let mut grouped: BTreeMap<(String, String), Vec<ProviderVariant>> = BTreeMap::new();
    for variant in variants {
        grouped
            .entry((variant.asset_id.clone(), variant.target_url.clone()))
            .or_default()
            .push(variant);
    }
    grouped
        .into_values()
        .map(|mut group| {
            let mut result = group.remove(0);
            macro_rules! merge {
                ($field:ident) => {{
                    result.$field = unique(
                        std::iter::once(result.$field.clone())
                            .chain(group.iter().map(|v| v.$field.clone())),
                    );
                }};
            }
            merge!(title);
            merge!(mime_type);
            merge!(video_codec);
            merge!(audio_codec);
            merge!(size_bytes);
            merge!(duration_seconds);
            merge!(width);
            merge!(height);
            result
        })
        .collect()
}

fn recording_year(item: &Value) -> Option<i64> {
    // Search-level date can describe a veteran's service period or a collection.
    // A specific catalog record's exact creation date is a distinct claim.
    let inner = item.get("item")?;
    if text_list(item.get("original_format"))
        .ok()?
        .iter()
        .any(|v| v.eq_ignore_ascii_case("collection"))
    {
        return None;
    }
    let date = inner.get("date")?.as_str()?;
    if !(date.len() == 4 || date.len() == 10)
        || !date.as_bytes().get(..4)?.iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    if date.len() == 10 && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
        return None;
    }
    date[..4]
        .parse::<i64>()
        .ok()
        .filter(|year| (1888..=2100).contains(year))
}

pub(crate) fn parse_item(expected_id: &str, document: &Value) -> Result<ProviderItem, String> {
    let item = document
        .get("item")
        .filter(|item| item.is_object())
        .ok_or(INVALID)?;
    let actual = optional_text(item.get("id"))
        .or_else(|| optional_text(item.get("url")))
        .ok_or(INVALID)?;
    if item_identity(&actual)? != expected_id {
        return Err("archive-loc-item-mismatch".into());
    }
    let inner = item.get("item").unwrap_or(&Value::Null);
    let title = optional_text(item.get("title")).ok_or(INVALID)?;
    let source_url = format!("https://www.loc.gov/item/{expected_id}/");
    let mut variants = Vec::new();
    let mut restrictions = Vec::new();
    if let Some(resources) = document.get("resources").filter(|v| !v.is_null()) {
        let resources = resources.as_array().ok_or(INVALID)?;
        if resources.len() > 256 {
            return Err("archive-loc-resource-limit".into());
        }
        for resource in resources {
            if !resource.is_object() {
                return Err(INVALID.into());
            }
            let asset = optional_text(resource.get("uuid"))
                .or_else(|| optional_text(resource.get("url")))
                .or_else(|| optional_text(resource.get("id")))
                .unwrap_or_else(|| expected_id.into());
            if let Some(restricted) = resource.get("download_restricted").and_then(Value::as_bool) {
                restrictions.push(restricted);
            }
            if let Some(files) = resource.get("files").filter(|v| !v.is_number()) {
                inventory(files, &asset, 0, &mut variants)?;
            }
            // Direct players can expose actual media missing from files[]. Never
            // transfer resource-wide dimensions or duration to these alternatives.
            for key in ["video", "video_stream", "audio", "audio_stream"] {
                if let Some(target) = optional_text(resource.get(key)) {
                    if variants.len() >= MAX_FILES {
                        return Err("archive-loc-file-limit".into());
                    }
                    variants.push(variant(&asset, &target, &Value::Null)?);
                }
            }
        }
    }
    let download_allowed = if restrictions.contains(&true) {
        Some(false)
    } else if !restrictions.is_empty() {
        Some(true)
    } else {
        None
    };
    Ok(ProviderItem {
        provider: Provider::Loc,
        item_id: expected_id.into(),
        title,
        metadata_url: format!("{source_url}?fo=json"),
        source_url,
        description: prose(joined(&[
            item.get("description"),
            item.get("summary"),
            inner.get("summary"),
        ])?),
        subjects: collect_texts(&[
            item.get("subject"),
            item.get("subjects"),
            item.get("genre"),
            inner.get("genre"),
        ])?,
        creators: collect_texts(&[
            item.get("creator"),
            item.get("creators"),
            inner.get("creator"),
            inner.get("creators"),
        ])?,
        languages: collect_texts(&[item.get("language"), inner.get("language")])?,
        release_year: recording_year(item),
        date_claims: None,
        content_type: if collect_texts(&[item.get("genre"), inner.get("genre")])?
            .iter()
            .any(|s| s.eq_ignore_ascii_case("Short films"))
        {
            "short"
        } else if collect_texts(&[item.get("genre"), inner.get("genre")])?
            .iter()
            .any(|s| s.eq_ignore_ascii_case("Feature films"))
        {
            "movie"
        } else {
            "unknown"
        }
        .into(),
        rights: prose(joined(&[
            item.get("rights"),
            item.get("rights_advisory"),
            inner.get("rights_advisory"),
            inner.get("rights_information"),
        ])?),
        license_url: optional_text(item.get("license_url")),
        attribution: prose(joined(&[
            item.get("attribution"),
            inner.get("attribution"),
        ])?),
        access_restricted: item.get("access_restricted").and_then(Value::as_bool),
        download_allowed,
        revision: item
            .get("_version_")
            .and_then(|v| v.as_u64())
            .map(|n| n.to_string()),
        variants: merge_inventory(variants),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item() -> Value {
        json!({"item":{"id":"http://www.loc.gov/item/00694220/","title":"The great train robbery","date":"1903","item":{"date":"1903","genre":["Silent films"]},"access_restricted":false},"resources":[{"url":"https://www.loc.gov/resource/ntscrm.00000765/","download_restricted":false,"width":1920,"height":1080,"duration":701,"files":[[{"download":"https://tile.loc.gov/a.mp4","mimetype":"application/x-video","shortName":"Great Train Robbery"},{"url":"https://tile.loc.gov/a.mp4","mimetype":"video/mp4","size":274118177},{"url":"https://tile.loc.gov/a.mov","mimetype":"video/quicktime","size":4779287790_u64},{"url":"https://tile.loc.gov/a.jpg","mimetype":"image/jpeg","width":1920,"height":1080}]],"video":"https://tile.loc.gov/a.mp4","video_stream":"https://tile.loc.gov/a.m3u8"}]})
    }

    #[test]
    fn loc_observed_official_search_and_classic_inventory() {
        let search: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/archive-providers/loc-search.json"
        ))
        .unwrap();
        let page = parse_search(&search).unwrap();
        assert_eq!(page.next_cursor.as_deref(), Some("2"));
        assert_eq!(page.hits[0].item_id, "00694220");
        let document: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/archive-providers/loc-classic.json"
        ))
        .unwrap();
        let item = parse_item("00694220", &document).unwrap();
        assert_eq!(item.release_year, Some(1903));
        assert_eq!(item.content_type, "short");
        assert_eq!(item.variants.len(), 5);
        let mp4 = item
            .variants
            .iter()
            .find(|v| v.file_name == "00000765.mp4")
            .unwrap();
        assert_eq!(mp4.size_bytes.as_deref(), Some("274118177"));
        assert_eq!(
            (mp4.video_codec.clone(), mp4.width, mp4.duration_seconds),
            (None, None, None)
        );
        crate::archive_provider_contract::validate_item(&item).unwrap();
    }

    #[test]
    fn loc_observed_interview_scopes_date_rights_and_stream_metadata() {
        let document: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/archive-providers/loc-interview.json"
        ))
        .unwrap();
        let item = parse_item("afc2001001.67577", &document).unwrap();
        assert_eq!(item.release_year, None);
        let mp4 = item
            .variants
            .iter()
            .find(|v| v.file_name.ends_with("_640x480_800.mp4"))
            .unwrap();
        assert_eq!(mp4.size_bytes.as_deref(), Some("352465669"));
        assert_eq!(mp4.video_codec.as_deref(), Some("h264"));
        assert_eq!(mp4.audio_codec.as_deref(), Some("aac"));
        assert_eq!((mp4.width, mp4.height), (Some(640), Some(480)));
        assert_eq!(mp4.duration_seconds, Some(3141.404444));
        assert!(item.rights.as_deref().unwrap().contains("permission"));
        assert_eq!(
            (item.access_restricted, item.download_allowed),
            (Some(false), Some(true))
        );
        // Large genuine rights statements are never silently shortened to fit.
        if item.rights.as_ref().unwrap().len() > 4096 {
            assert!(crate::archive_provider_contract::validate_item(&item).is_err());
        } else {
            crate::archive_provider_contract::validate_item(&item).unwrap();
        }
    }

    #[test]
    fn loc_preserves_all_actual_inventory_and_deduplicates_same_asset_url() {
        let result = parse_item("00694220", &item()).unwrap();
        assert_eq!(result.variants.len(), 4);
        let file = result
            .variants
            .iter()
            .find(|v| v.file_name == "a.mp4")
            .unwrap();
        assert_eq!(file.mime_type.as_deref(), Some("video/mp4"));
        assert_eq!(file.size_bytes.as_deref(), Some("274118177"));
        assert_eq!(file.video_codec, None);
        assert_eq!(file.width, None);
        assert_eq!(file.duration_seconds, None);
        assert_eq!(result.release_year, Some(1903));
    }

    #[test]
    fn loc_variant_scoped_probe_fields_do_not_spread() {
        let mut doc = item();
        doc["resources"][0]["files"][0][1]["streams"] = json!([{"codec_type":"video","codec_name":"h264","width":640,"height":480},{"codec_type":"audio","codec_name":"aac"}]);
        doc["resources"][0]["files"][0][1]["format"] =
            json!({"size":"274118177","duration":"701.5"});
        let result = parse_item("00694220", &doc).unwrap();
        let mp4 = result
            .variants
            .iter()
            .find(|v| v.file_name == "a.mp4")
            .unwrap();
        assert_eq!(mp4.video_codec.as_deref(), Some("h264"));
        assert_eq!(mp4.audio_codec.as_deref(), Some("aac"));
        assert_eq!(mp4.width, Some(640));
        assert_eq!(mp4.duration_seconds, Some(701.5));
        let mov = result
            .variants
            .iter()
            .find(|v| v.file_name == "a.mov")
            .unwrap();
        assert_eq!((mov.video_codec.clone(), mov.width), (None, None));
    }

    #[test]
    fn loc_veteran_service_era_is_not_recording_year() {
        let mut doc = item();
        doc["item"]["date"] = json!("1963");
        doc["item"]["item"] = json!({"service_history":[{"dates_of_service":"1963-1969"}]});
        assert_eq!(parse_item("00694220", &doc).unwrap().release_year, None);
    }

    #[test]
    fn loc_collection_date_does_not_become_release_year() {
        let mut doc = item();
        doc["item"]["original_format"] = json!(["collection"]);
        assert_eq!(parse_item("00694220", &doc).unwrap().release_year, None);
    }

    #[test]
    fn loc_access_and_rights_are_independent() {
        let mut doc = item();
        doc["item"]["rights"] = json!(["Copyright retained; permission needed for publication"]);
        let parsed = parse_item("00694220", &doc).unwrap();
        assert_eq!(parsed.access_restricted, Some(false));
        assert_eq!(parsed.download_allowed, Some(true));
        assert!(parsed.rights.unwrap().contains("permission"));
        assert_eq!(parsed.license_url, None);
    }

    #[test]
    fn loc_any_download_restriction_wins_without_assuming_permission() {
        let mut doc = item();
        doc["resources"]
            .as_array_mut()
            .unwrap()
            .push(json!({"url":"https://www.loc.gov/resource/other/","download_restricted":true}));
        assert_eq!(
            parse_item("00694220", &doc).unwrap().download_allowed,
            Some(false)
        );
    }

    #[test]
    fn loc_contributors_are_not_relabelled_as_creators() {
        let mut doc = item();
        doc["item"]["contributor_names"] = json!(["Veteran", "Actor", "Interviewer"]);
        assert!(parse_item("00694220", &doc).unwrap().creators.is_empty());
    }

    #[test]
    fn loc_rejects_wrong_item_and_invalid_identity() {
        assert!(parse_item("different", &item()).is_err());
        for url in [
            "https://evil.test/item/00694220/",
            "https://www.loc.gov@evil.test/item/00694220/",
            "https://www.loc.gov/item/%2e%2e/",
            "https://www.loc.gov/item/a/b/",
        ] {
            assert!(item_identity(url).is_err());
        }
    }

    #[test]
    fn loc_continuation_is_numeric_and_never_a_remote_fetch_target() {
        let doc = json!({"results":[],"pagination":{"next":"https://www.loc.gov/film-and-videos/?fo=json&q=film&sp=2"}});
        assert_eq!(
            parse_search(&doc).unwrap().next_cursor.as_deref(),
            Some("2")
        );
        for next in [
            "http://www.loc.gov/film-and-videos/?sp=2",
            "https://evil.test/film-and-videos/?sp=2",
            "https://www.loc.gov/film-and-videos/?sp=2&sp=3",
            "https://www.loc.gov/film-and-videos/?sp=02",
            "https://www.loc.gov/search/?sp=2",
        ] {
            assert!(page_cursor(Some(&json!(next))).is_err());
        }
    }

    #[test]
    fn loc_conflicting_file_facts_remain_unknown() {
        let mut doc = item();
        doc["resources"][0]["files"][0]
            .as_array_mut()
            .unwrap()
            .push(json!({"url":"https://tile.loc.gov/a.mp4","size":9}));
        assert_eq!(
            parse_item("00694220", &doc)
                .unwrap()
                .variants
                .iter()
                .find(|v| v.file_name == "a.mp4")
                .unwrap()
                .size_bytes,
            None
        );
    }

    #[test]
    fn loc_result_limit_is_not_silent_truncation() {
        assert!(parse_search(&json!({"results":vec![json!({});151]})).is_err());
        assert!(parse_search(&json!({"error":"temporarily unavailable"})).is_err());
    }

    #[test]
    fn loc_exact_duplicate_search_identity_is_rejected() {
        let hit = json!({"id":"http://www.loc.gov/item/00694220/","title":"A"});
        assert!(parse_search(&json!({"results":[hit.clone(),hit]})).is_err());
    }
}
