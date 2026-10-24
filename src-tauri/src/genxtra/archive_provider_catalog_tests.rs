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

use super::*;
#[test]
fn long_public_filename_keeps_exact_identity_and_bounded_utf8_display_label() {
    let c = db();
    let mut item = item(Provider::Loc, "longname", "Long filename");
    item.variants[0].file_name = format!("{}episode.mp4", "界".repeat(220));
    let reference = contract::file_ref(item.provider, &item.item_id, &item.variants[0]);
    upsert(&c, &item, 1).unwrap();
    let page = legacy::files(
        &c,
        &legacy::FilesQuery {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: contract::title_ref(item.provider, &item.item_id),
            expected_revision: "0".into(),
            offset: 0,
            page_size: 50,
        },
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(page.files[0].file_ref, reference);
    assert_eq!(page.files[0].file_name, item.variants[0].file_name);
    assert!(page.files[0].title.len() <= 512);
    assert!(page.files[0].title.ends_with("episode.mp4"));
    assert!(page.files[0].title.contains('…'));
}
fn db() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    let tx = c.transaction().unwrap();
    legacy::install(&tx).unwrap();
    crate::archive_bookmarks::install(&tx).unwrap();
    install(&tx).unwrap();
    tx.commit().unwrap();
    c
}
fn variant(id: &str, url: &str, mime: Option<&str>) -> ProviderVariant {
    ProviderVariant {
        asset_id: "part".into(),
        variant_id: id.into(),
        file_name: id.into(),
        title: None,
        target_url: url.into(),
        mime_type: mime.map(str::to_owned),
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
    }
}
fn item(p: Provider, id: &str, title: &str) -> ProviderItem {
    ProviderItem {
        provider: p,
        item_id: id.into(),
        title: title.into(),
        source_url: match p {
            Provider::Loc => format!("https://www.loc.gov/item/{id}/"),
            Provider::Nasa => {
                format!("https://images-assets.nasa.gov/video/{id}/collection.json")
            }
            Provider::Commons => {
                format!("https://commons.wikimedia.org/w/index.php?curid={id}")
            }
        },
        metadata_url: match p {
            Provider::Loc => format!("https://www.loc.gov/item/{id}/?fo=json"),
            Provider::Nasa => format!("https://images-api.nasa.gov/asset/{id}"),
            Provider::Commons => "https://commons.wikimedia.org/w/api.php".into(),
        },
        description: None,
        subjects: vec![],
        creators: vec![],
        languages: vec![],
        release_year: None,
        date_claims: None,
        content_type: "unknown".into(),
        rights: Some("Rights not independently verified".into()),
        license_url: None,
        attribution: None,
        access_restricted: None,
        download_allowed: None,
        revision: None,
        variants: vec![variant(
            "movie.mp4",
            &match p {
                Provider::Loc => "https://tile.loc.gov/storage-services/service/movie.mp4".into(),
                Provider::Nasa => format!("http://images-assets.nasa.gov/video/{id}/movie.mp4"),
                Provider::Commons => {
                    "https://upload.wikimedia.org/wikipedia/commons/a/ab/movie.webm".into()
                }
            },
            None,
        )],
    }
}
fn q() -> legacy::Query {
    legacy::Query {
        schema_version: 1,
        request_id: "fixture".into(),
        query: String::new(),
        expected_revision: None,
        offset: 0,
        page_size: 50,
        curated_only: false,
        decade: None,
        favorites_only: false,
        language_mode: legacy::LanguageMode::All,
        content_type: legacy::ContentType::All,
    }
}
#[test]
fn provider_ids_do_not_collide_or_rewrite_ia_refs() {
    let c = db();
    let a = item(Provider::Loc, "same", "Same title");
    let b = item(Provider::Nasa, "same", "Same title");
    upsert(&c, &a, 1).unwrap();
    upsert(&c, &b, 1).unwrap();
    let page = legacy::query(&c, &q(), &mut || Ok(())).unwrap();
    assert_eq!(page.total_count, 2);
    assert_ne!(page.items[0].title_ref, page.items[1].title_ref);
    assert!(!page
        .items
        .iter()
        .any(|r| r.title_ref == legacy::opaque(&["archive-item-v1", "same"])));
    assert!(page
        .items
        .iter()
        .all(|r| r.rank == 0 && r.quality == "metadata-listed"));
}
#[test]
fn unsupported_and_unknown_variants_stay_browsable_without_borrowed_size() {
    let c = db();
    let mut i = item(Provider::Loc, "disc", "Classic archive");
    i.variants.push(variant(
        "disc.iso",
        "https://tile.loc.gov/storage-services/service/disc.iso",
        Some("application/x-iso9660-image"),
    ));
    upsert(&c, &i, 1).unwrap();
    let tr = contract::title_ref(i.provider, &i.item_id);
    let page = legacy::files(
        &c,
        &legacy::FilesQuery {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: tr,
            expected_revision: "0".into(),
            offset: 0,
            page_size: 50,
        },
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(page.total_count, 2);
    let iso = page
        .files
        .iter()
        .find(|f| f.file_name == "disc.iso")
        .unwrap();
    assert!(iso.size_bytes.is_none());
    assert!(!iso.provider_facts.as_ref().unwrap().playback_candidate);
    assert!(!iso.provider_facts.as_ref().unwrap().download_supported);
    let mp4 = page
        .files
        .iter()
        .find(|f| f.file_name == "movie.mp4")
        .unwrap();
    assert!(mp4.size_bytes.is_none());
    assert!(mp4.provider_facts.as_ref().unwrap().playback_candidate);
    let resolved = legacy::resolve(&c, &mp4.file_ref, "0").unwrap();
    assert!(crate::archive_bookmarks::capture(&mp4.file_ref, &resolved).is_err());
    assert!(legacy::resolve_download(&c, &mp4.file_ref, "0").is_err());
}
#[test]
fn favorite_and_tombstone_survive_refresh_and_stale_cas() {
    let mut c = db();
    let i = item(Provider::Loc, "favorite", "Chosen title");
    upsert(&c, &i, 1).unwrap();
    let tr = contract::title_ref(i.provider, &i.item_id);
    let r = legacy::set_favorite(
        &mut c,
        &legacy::FavoriteRequest {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: tr.clone(),
            expected_revision: "0".into(),
            value: true,
        },
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(r.revision, "1");
    assert!(legacy::query(&c, &q(), &mut || Ok(())).unwrap().items[0].favorite);
    assert!(legacy::remove(
        &mut c,
        &legacy::RemovalScope::TitleRef(tr.clone()),
        None,
        "0",
        &mut || Ok(())
    )
    .is_err());
    let receipt = legacy::remove(
        &mut c,
        &legacy::RemovalScope::TitleRef(tr),
        None,
        "1",
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.removed_titles, 1);
    assert!(!upsert(&c, &i, 2).unwrap());
    assert!(legacy::set_favorite(
        &mut c,
        &legacy::FavoriteRequest {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: contract::title_ref(i.provider, &i.item_id),
            expected_revision: receipt.revision,
            value: true
        },
        &mut || Ok(())
    )
    .is_err());
    assert_eq!(
        legacy::query(&c, &q(), &mut || Ok(())).unwrap().total_count,
        0
    );
}
#[test]
fn failed_transaction_does_not_advance_cursor_or_insert_partial_items() {
    let mut c = db();
    let key = "a".repeat(64);
    let t = c.transaction().unwrap();
    let state = Cursor {
        started: true,
        complete: true,
        ..Default::default()
    };
    save_cursor(&t, &key, Provider::Loc, &state).unwrap();
    let i = item(Provider::Loc, "rolledback", "Before commit");
    upsert(&t, &i, 1).unwrap();
    drop(t);
    assert!(!cursor(&c, &key, Provider::Loc, false).unwrap().complete);
    assert_eq!(
        legacy::query(&c, &q(), &mut || Ok(())).unwrap().total_count,
        0
    );
}
#[test]
fn query_filters_use_actual_type_year_and_contradiction_rules() {
    let c = db();
    let mut good = item(Provider::Loc, "animation", "Classic cartoon");
    good.subjects = vec!["Animated films".into()];
    good.content_type = "short".into();
    good.release_year = Some(1965);
    let mut concert = item(Provider::Nasa, "concert", "Opera Bell Band");
    concert.subjects = vec!["Film & Animation".into()];
    upsert(&c, &good, 1).unwrap();
    upsert(&c, &concert, 1).unwrap();
    let mut query = q();
    query.query = "Cartoon".into();
    query.decade = Some(1960);
    let page = legacy::query(&c, &query, &mut || Ok(())).unwrap();
    assert_eq!(page.total_count, 1);
    assert_eq!(page.items[0].title, "Classic cartoon");
    query.curated_only = true;
    assert_eq!(
        legacy::query(&c, &query, &mut || Ok(()))
            .unwrap()
            .total_count,
        0
    );
}

#[test]
fn nasa_legacy_year_is_unknown_in_saved_projection_without_rewriting_rows() {
    let c = db();
    let mut saved = item(Provider::Nasa, "legacy", "Apollo legacy");
    saved.release_year = Some(1985);
    upsert(&c, &saved, 1).unwrap();
    let title = contract::title_ref(saved.provider, &saved.item_id);
    c.execute(
        "INSERT INTO public_archive_preference_v1 VALUES(?1,1)",
        [&title],
    )
    .unwrap();
    let before = crate::archive_library_store::source_fingerprint(&c, &mut || Ok(())).unwrap();
    let page = legacy::query(&c, &q(), &mut || Ok(())).unwrap();
    assert_eq!(page.total_count, 1);
    assert!(page.items[0].favorite);
    assert_eq!(page.items[0].release_year, None);
    for decade in [1960, 1970, 1980, 1990, 2000, 2010, 2020] {
        let mut query = q();
        query.decade = Some(decade);
        assert_eq!(
            legacy::query(&c, &query, &mut || Ok(()))
                .unwrap()
                .total_count,
            0
        );
    }
    let raw: String = c
        .query_row(
            "SELECT document FROM public_archive_item_v1 WHERE title_ref=?1",
            [&title],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(decode_item(&raw).unwrap().release_year, Some(1985));
    assert!(decode_item(&raw).unwrap().date_claims.is_none());
    assert_eq!(
        crate::archive_library_store::source_fingerprint(&c, &mut || Ok(())).unwrap(),
        before
    );
}

#[test]
fn nasa_date_only_refresh_preserves_selection_but_authority_changes_revoke() {
    let c = db();
    let mut saved = item(Provider::Nasa, "apollo", "Apollo");
    saved.release_year = Some(1985);
    upsert(&c, &saved, 1).unwrap();
    let reference = contract::file_ref(saved.provider, &saved.item_id, &saved.variants[0]);
    let selected = resolve(&c, &reference).unwrap().public.unwrap();
    saved.release_year = None;
    saved.date_claims = contract::nasa_date_claim("2021-01-30T00:00:00Z");
    upsert(&c, &saved, 2).unwrap();
    verify_live(&c, &reference, &selected).unwrap();
    assert_eq!(
        resolve(&c, &reference)
            .unwrap()
            .public
            .unwrap()
            .item
            .date_claims
            .unwrap()
            .provider_created
            .value,
        "2021-01-30T00:00:00Z"
    );
    for mode in [
        "target", "access", "revision", "size", "checksum", "asset", "variant", "identity",
    ] {
        let mut changed = saved.clone();
        match mode {
            "target" => {
                changed.variants[0].target_url =
                    "https://images-assets.nasa.gov/video/apollo/other.mp4".into()
            }
            "access" => changed.access_restricted = Some(true),
            "revision" => changed.revision = Some("new-source-revision".into()),
            "size" => changed.variants[0].size_bytes = Some("100".into()),
            "checksum" => changed.variants[0].sha1 = Some("b".repeat(40)),
            "asset" => changed.variants[0].asset_id = "other-asset".into(),
            "variant" => changed.variants[0].variant_id = "other-variant".into(),
            "identity" => changed.item_id = "other".into(),
            _ => unreachable!(),
        }
        // Compare authority directly for identities that intentionally map
        // to a different opaque reference; no title-similarity fallback.
        let mut header = changed.clone();
        header.variants.clear();
        assert_ne!(
            selected.fingerprint,
            selected_fingerprint(
                &serde_json::to_string(&header).unwrap(),
                &serde_json::to_string(&changed.variants[0]).unwrap()
            )
            .unwrap(),
            "{mode}"
        );
        if !matches!(mode, "asset" | "variant" | "identity") {
            upsert(&c, &changed, 3).unwrap();
            assert!(verify_live(&c, &reference, &selected).is_err(), "{mode}");
            upsert(&c, &saved, 4).unwrap();
        }
    }
    c.execute(
        "INSERT INTO public_archive_removal_v1 VALUES('file',?1,?2)",
        params![reference, selected.title_ref],
    )
    .unwrap();
    assert!(verify_live(&c, &reference, &selected).is_err());
}

#[test]
fn non_nasa_selection_retains_exact_legacy_raw_header_proof() {
    for (provider, id) in [(Provider::Loc, "film"), (Provider::Commons, "123")] {
        let c = db();
        let mut saved = item(provider, id, "Original work");
        saved.release_year = Some(1965);
        upsert(&c, &saved, 1).unwrap();
        let reference = contract::file_ref(provider, id, &saved.variants[0]);
        let selected = resolve(&c, &reference).unwrap().public.unwrap();
        let (raw, variant): (String, String) = c.query_row("SELECT i.document,v.document FROM public_archive_item_v1 i JOIN public_archive_variant_v1 v ON v.title_ref=i.title_ref WHERE v.file_ref=?1", [&reference], |r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(
            selected.fingerprint,
            legacy::opaque(&["public-archive-selected-v1", &raw, &variant])
        );
        saved.release_year = Some(2021);
        upsert(&c, &saved, 2).unwrap();
        assert!(verify_live(&c, &reference, &selected).is_err());
        upsert(&c, &item(provider, id, "Original work"), 3).unwrap();
        let selected = resolve(&c, &reference).unwrap().public.unwrap();
        c.execute(
            "UPDATE public_archive_item_v1 SET document=' '||document||' '",
            [],
        )
        .unwrap();
        assert!(verify_live(&c, &reference, &selected).is_err());
    }
}

#[test]
fn date_claim_versions_and_field_bounds_are_not_corruption_recovery_errors() {
    let mut i = item(Provider::Nasa, "apollo", "Apollo");
    i.date_claims = contract::nasa_date_claim("2021-01-30T00:00:00Z");
    i.date_claims.as_mut().unwrap().schema_version = 2;
    assert_eq!(
        decode_item(&serde_json::to_string(&i).unwrap()).unwrap_err(),
        "public-archive-metadata-version-unsupported"
    );
    i.date_claims.as_mut().unwrap().schema_version = 1;
    for value in [
        "2021-02-30T00:00:00Z",
        "2021-01-30T00:00:00Z\n",
        "2021",
        "0000-01-01T00:00:00Z",
    ] {
        i.date_claims.as_mut().unwrap().provider_created.value = value.into();
        assert!(
            decode_item(&serde_json::to_string(&i).unwrap()).is_err(),
            "{value}"
        );
    }
    for value in [
        "2020-02-29T00:00:00Z",
        "2021-01-30T01:02:03.123456789+05:30",
    ] {
        assert!(contract::provider_created_value(value), "{value}");
    }
}
