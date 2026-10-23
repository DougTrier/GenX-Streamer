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
            .and_then(|parts| parts.last())
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
mod tests {
    use super::*;
    use serde_json::json;

    fn hit() -> Value {
        json!({"href":"https://images-assets.nasa.gov/video/Apollo_11/collection.json","data":[{"nasa_id":"Apollo_11","title":"Apollo 11 Productions","description":"1985 productions about 1969; TRT00:48:22","date_created":"1985-01-01T00:00:00Z","media_type":"video","keywords":["Apollo 11","Goddard"],"photographer":"NASA"}],"links":[{"rel":"preview","render":"image","width":400,"height":266,"size":15000,"href":"https://images-assets.nasa.gov/video/Apollo_11/Apollo_11~medium.jpg"}]})
    }
    fn assets() -> Value {
        json!({"collection":{"href":"http://images-api.nasa.gov/asset/Apollo_11","items":[{"href":"http://images-assets.nasa.gov/video/Apollo_11/Apollo_11~orig.mp4"},{"href":"http://images-assets.nasa.gov/video/Apollo_11/Apollo_11~preview.mp4"},{"href":"http://images-assets.nasa.gov/video/Apollo_11/Apollo_11.vtt"},{"href":"http://images-assets.nasa.gov/video/Apollo_11/metadata.json"},{"href":"http://images-assets.nasa.gov/video/Apollo_11/Apollo_11~medium.jpg"}]}})
    }

    #[test]
    fn nasa_actual_apollo_pages_preserve_space_and_unicode_ids() {
        for raw in [
            include_str!("../../tests/fixtures/native/archive-nasa/apollo-search-page-1.json"),
            include_str!("../../tests/fixtures/native/archive-nasa/apollo-search-page-2.json"),
        ] {
            let document: Value = serde_json::from_str(raw).unwrap();
            let page = parse_search(&document).unwrap();
            assert_eq!(page.hits.len(), 4);
            for (hit, observed) in page
                .hits
                .iter()
                .zip(document["collection"]["items"].as_array().unwrap())
            {
                let exact_id = observed["data"][0]["nasa_id"].as_str().unwrap();
                assert_eq!(hit.item_id, exact_id);
                assert_eq!(hit.search_document, *observed);
                crate::archive_provider_net::metadata_url(Provider::Nasa, &hit.metadata_url)
                    .unwrap();
                crate::archive_provider_net::source_url(Provider::Nasa, exact_id, &hit.source_url)
                    .unwrap();
                assert_eq!(Url::parse(&hit.metadata_url).unwrap().query(), None);
            }
        }
        let unicode_id = "Apollo 14 ‘A Wild Place Up Here’";
        assert_eq!(
            asset_url(unicode_id).unwrap(),
            "https://images-api.nasa.gov/asset/Apollo%2014%20%E2%80%98A%20Wild%20Place%20Up%20Here%E2%80%99"
        );
    }

    #[test]
    fn nasa_actual_space_id_manifest_retains_exact_variants_and_refresh_identity() {
        let search: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/native/archive-nasa/apollo-search-page-2.json"
        ))
        .unwrap();
        let assets: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/native/archive-nasa/apollo-page-2-first-assets.json"
        ))
        .unwrap();
        let page = parse_search(&search).unwrap();
        let hit = &page.hits[0];
        assert_eq!(hit.item_id, "Apollo 14 Launch Coverage");
        assert_eq!(
            hit.metadata_url,
            "https://images-api.nasa.gov/asset/Apollo%2014%20Launch%20Coverage"
        );
        let item = parse_item(&hit.item_id, &hit.search_document, &assets).unwrap();
        crate::archive_provider_contract::validate_item(&item).unwrap();
        assert_eq!(item.item_id, hit.item_id);
        assert_eq!(item.variants.len(), 23);
        for (variant, observed) in item
            .variants
            .iter()
            .zip(assets["collection"]["items"].as_array().unwrap())
        {
            let exact_url = observed["href"].as_str().unwrap();
            assert_eq!(variant.target_url, exact_url);
            assert_eq!(variant.asset_id, hit.item_id);
            assert_eq!(
                variant.variant_id,
                format!("{:x}", Sha256::digest(exact_url.as_bytes()))
            );
            let admitted =
                crate::archive_provider_net::media_url(Provider::Nasa, &hit.item_id, exact_url)
                    .unwrap();
            assert!(admitted
                .path()
                .starts_with("/video/Apollo%2014%20Launch%20Coverage/"));
            assert!(
                variant.video_codec.is_none()
                    && variant.audio_codec.is_none()
                    && variant.size_bytes.is_none()
            );
        }
        // Playback refresh retains the saved exact ID/source rather than
        // repeating search or fabricating descriptive/variant evidence.
        let refresh = json!({"href":item.source_url,"data":[{"nasa_id":item.item_id,"title":item.title,"media_type":"video"}]});
        let refreshed = parse_item(&hit.item_id, &refresh, &assets).unwrap();
        for (before, after) in item.variants.iter().zip(&refreshed.variants) {
            assert_eq!(
                crate::archive_provider_contract::file_ref(Provider::Nasa, &item.item_id, before),
                crate::archive_provider_contract::file_ref(
                    Provider::Nasa,
                    &refreshed.item_id,
                    after
                )
            );
        }
        let mut wrong = assets.clone();
        wrong["collection"]["href"] =
            json!("https://images-api.nasa.gov/asset/Apollo_14_Launch_Coverage");
        assert!(parse_item(&hit.item_id, &hit.search_document, &wrong).is_err());
    }

    #[test]
    fn nasa_expanded_ids_do_not_grant_path_or_authority_injection() {
        for id in [
            "",
            ".",
            "..",
            " lead",
            "trail ",
            "a/b",
            "a\\b",
            "a?b",
            "a#b",
            "a%2fb",
            "a\nvalue",
            "a\u{200b}value",
        ] {
            assert!(!valid_id(id), "{id:?}");
            assert!(asset_url(id).is_err(), "{id:?}");
        }
        assert!(asset_url(&"x".repeat(513)).is_err());
        for raw in [
            "https://images-assets.nasa.gov.evil.invalid/video/Apollo%2014%20Launch%20Coverage/collection.json",
            "https://user@images-assets.nasa.gov/video/Apollo%2014%20Launch%20Coverage/collection.json",
            "https://images-assets.nasa.gov/video/Apollo_14_Launch_Coverage/collection.json",
            "https://images-assets.nasa.gov/video/Apollo%2014%20Launch%20Coverage/collection.json?x=1",
            "https://images-assets.nasa.gov/video/Apollo%2014%20Launch%20Coverage/collection.json#x",
        ] {
            assert!(crate::archive_provider_net::source_url(Provider::Nasa, "Apollo 14 Launch Coverage", raw).is_err(), "{raw}");
        }
        for raw in [
            "https://images-assets.nasa.gov/video/Apollo_14_Launch_Coverage/a.mp4",
            "https://images-assets.nasa.gov/video/Apollo%2014%20Launch%20Coverage-Other/a.mp4",
            "https://images-assets.nasa.gov/video/Apollo%2014%20Launch%20Coverage/../Other/a.mp4",
            "https://images-assets.nasa.gov.evil.invalid/video/Apollo%2014%20Launch%20Coverage/a.mp4",
            "https://images-assets.nasa.gov/video/Apollo%2014%20Launch%20Coverage/a.mp4?token=x",
        ] {
            assert!(crate::archive_provider_net::media_url(Provider::Nasa, "Apollo 14 Launch Coverage", raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn nasa_observed_official_search_and_manifest_validate_without_master_claims() {
        let search: Value = serde_json::from_str(include_str!(
            "../../artifacts/archive-providers/2026-10-15/loc-nasa-adapters-v1/nasa-search.json"
        ))
        .unwrap();
        let page = parse_search(&search).unwrap();
        assert_eq!(page.hits.len(), 2);
        assert_eq!(page.next_cursor.as_deref(), Some("2"));
        let assets: Value = serde_json::from_str(include_str!(
            "../../artifacts/archive-providers/2026-10-15/loc-nasa-adapters-v1/nasa-assets.json"
        ))
        .unwrap();
        let item = parse_item(
            &page.hits[0].item_id,
            &page.hits[0].search_document,
            &assets,
        )
        .unwrap();
        assert_eq!(item.release_year, None);
        assert_eq!(
            item.date_claims.as_ref().unwrap().provider_created.value,
            "1985-01-01T00:00:00Z"
        );
        assert_eq!(
            item.variants.len(),
            assets["collection"]["items"].as_array().unwrap().len()
        );
        assert_eq!(
            item.variants
                .iter()
                .filter(|v| v.file_name.ends_with(".mp4"))
                .count(),
            4
        );
        assert!(item
            .variants
            .iter()
            .all(|v| v.video_codec.is_none() && v.audio_codec.is_none() && v.size_bytes.is_none()));
        crate::archive_provider_contract::validate_item(&item).unwrap();
    }

    #[test]
    fn nasa_preserves_all_exact_assets_and_unknown_variant_facts() {
        let item = parse_item("Apollo_11", &hit(), &assets()).unwrap();
        assert_eq!(item.variants.len(), 5);
        for v in &item.variants {
            assert_eq!(
                (
                    v.mime_type.clone(),
                    v.video_codec.clone(),
                    v.audio_codec.clone(),
                    v.size_bytes.clone()
                ),
                (None, None, None, None)
            );
            assert_eq!((v.width, v.height, v.duration_seconds), (None, None, None));
            assert_eq!(
                (v.representation_role.clone(), v.original_variant_id.clone()),
                (None, None)
            );
            assert!(v.target_url.starts_with("http://"));
        }
    }

    #[test]
    fn nasa_thumbnail_or_master_claims_do_not_bleed_into_derivatives() {
        let mut doc = assets();
        doc["collection"]["metadata"] =
            json!({"XMP:Format":"H.264","FileSize":"1453 MB","QuickTime:ImageWidth":1920});
        let result = parse_item("Apollo_11", &hit(), &doc).unwrap();
        assert!(result
            .variants
            .iter()
            .all(|v| v.size_bytes.is_none() && v.width.is_none() && v.video_codec.is_none()));
    }

    #[test]
    fn nasa_created_date_is_retained_without_claiming_original_release() {
        let result = parse_item("Apollo_11", &hit(), &assets()).unwrap();
        assert_eq!(result.release_year, None);
        assert_eq!(
            result.date_claims.as_ref().unwrap().provider_created.value,
            "1985-01-01T00:00:00Z"
        );
        let mut doc = hit();
        doc["data"][0]
            .as_object_mut()
            .unwrap()
            .remove("date_created");
        doc["data"][0]["metadata_date"] = json!("2016-01-01T00:00:00Z");
        let missing = parse_item("Apollo_11", &doc, &assets()).unwrap();
        assert!(missing.release_year.is_none() && missing.date_claims.is_none());
    }

    #[test]
    fn nasa_invalid_creation_date_is_unknown() {
        let mut doc = hit();
        doc["data"][0]["date_created"] = json!("1985-99-99T00:00:00Z");
        let invalid = parse_item("Apollo_11", &doc, &assets()).unwrap();
        assert!(invalid.release_year.is_none() && invalid.date_claims.is_none());
    }

    #[test]
    fn nasa_actual_vintage_footage_created_in_2021_has_unknown_release() {
        let search: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/native/archive-nasa/apollo-search-page-2.json"
        ))
        .unwrap();
        let assets: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/native/archive-nasa/apollo-page-2-first-assets.json"
        ))
        .unwrap();
        let hit = &parse_search(&search).unwrap().hits[0];
        let item = parse_item(&hit.item_id, &hit.search_document, &assets).unwrap();
        assert_eq!(item.release_year, None);
        let claims = item.date_claims.as_ref().unwrap();
        assert_eq!(claims.schema_version, 1);
        assert_eq!(claims.provider_created.field, "date_created");
        assert_eq!(claims.provider_created.value, "2021-01-28T00:00:00Z");
        assert_eq!(claims.provider_created.provenance, "provider-search-record");
        crate::archive_provider_contract::validate_item(&item).unwrap();
    }

    #[test]
    fn nasa_unknown_rights_are_not_blanket_public_domain_permission() {
        let item = parse_item("Apollo_11", &hit(), &assets()).unwrap();
        assert_eq!(
            (
                item.rights,
                item.license_url,
                item.download_allowed,
                item.access_restricted
            ),
            (None, None, None, None)
        );
        assert!(item.creators.is_empty());
    }

    #[test]
    fn nasa_wrong_manifest_or_hit_is_rejected() {
        assert!(parse_item("Other", &hit(), &assets()).is_err());
        let mut doc = assets();
        doc["collection"]["href"] = json!("https://images-api.nasa.gov/asset/Other");
        assert!(parse_item("Apollo_11", &hit(), &doc).is_err());
    }

    #[test]
    fn nasa_duplicate_assets_are_not_duplicate_cards() {
        let mut doc = assets();
        let duplicate = doc["collection"]["items"][0].clone();
        doc["collection"]["items"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert_eq!(
            parse_item("Apollo_11", &hit(), &doc)
                .unwrap()
                .variants
                .len(),
            5
        );
    }

    #[test]
    fn nasa_http_next_is_only_numeric_evidence() {
        let doc = json!({"collection":{"items":[hit()],"links":[{"rel":"next","href":"http://images-api.nasa.gov/search?q=Apollo+11&page=2&page_size=1"}]}});
        let result = parse_search(&doc).unwrap();
        assert_eq!(result.next_cursor.as_deref(), Some("2"));
        assert_eq!(result.hits[0].search_document, hit());
        assert_eq!(
            result.hits[0].metadata_url,
            "https://images-api.nasa.gov/asset/Apollo_11"
        );
    }

    #[test]
    fn nasa_foreign_or_ambiguous_continuation_is_error_not_end_of_results() {
        for next in [
            "https://evil.test/search?page=2",
            "https://images-api.nasa.gov/search?page=2&page=3",
            "https://images-api.nasa.gov/search?page=02",
            "https://images-api.nasa.gov/asset/Apollo_11?page=2",
            "https://user@images-api.nasa.gov/search?page=2",
        ] {
            assert!(next_cursor(&json!({"links":[{"rel":"next","href":next}]})).is_err());
        }
    }

    #[test]
    fn nasa_source_locator_must_bind_exact_item() {
        let mut doc = hit();
        doc["href"] = json!("https://images-assets.nasa.gov/video/Other/collection.json");
        assert!(parse_item("Apollo_11", &doc, &assets()).is_err());
        doc["href"] = json!("https://evil.test/video/Apollo_11/collection.json");
        assert!(parse_item("Apollo_11", &doc, &assets()).is_err());
    }

    #[test]
    fn nasa_malformed_response_and_limit_are_not_silent_success() {
        assert!(parse_search(&json!({"collection":{"error":"unavailable"}})).is_err());
        assert!(parse_search(&json!({"collection":{"items":vec![hit();101]}})).is_err());
        let mut doc = assets();
        doc["collection"]["items"] = json!(vec![
            json!({"href":"http://images-assets.nasa.gov/video/Apollo_11/a.mp4"});
            1001
        ]);
        assert!(parse_item("Apollo_11", &hit(), &doc).is_err());
    }

    #[test]
    fn nasa_search_does_not_admit_images_as_video() {
        let mut image = hit();
        image["data"][0]["media_type"] = json!("image");
        assert!(parse_search(&json!({"collection":{"items":[image]}}))
            .unwrap()
            .hits
            .is_empty());
    }

    #[test]
    fn nasa_conflicting_multi_record_data_does_not_select_first() {
        let mut doc = hit();
        let mut other = doc["data"][0].clone();
        other["nasa_id"] = json!("Other");
        doc["data"].as_array_mut().unwrap().push(other);
        assert!(parse_item("Apollo_11", &doc, &assets()).is_err());
    }
}
