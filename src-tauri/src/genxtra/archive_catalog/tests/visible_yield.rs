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

//! Archive catalog tests: visible yield, content types, years, type filters
//! and artwork sources.

use super::*;

pub(super) fn discovery_view(language_mode: LanguageMode) -> DiscoveryView {
    DiscoveryView {
        schema_version: 1,
        language_mode,
        content_type: ContentType::All,
        favorites_only: false,
        curated_only: false,
    }
}

#[test]
fn archive_visible_yield_counts_new_full_snapshot_identities_not_admissions_or_first_page() {
    let mut c = database();
    let initial: Vec<_> = (0..60)
        .map(|index| {
            language_title(
                &format!("old{index:02}"),
                &format!("Gilligan {index:02}"),
                &["eng"],
                1,
            )
        })
        .collect();
    let legacy = commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(initial),
        &mut || Ok(()),
    )
    .unwrap();
    assert!(
        serde_json::to_value(legacy)
            .unwrap()
            .get("newVisibleMatches")
            .is_none(),
        "legacy receipt shape unchanged"
    );
    let english = discovery_view(LanguageMode::English);
    let receipt = commit_view(
        &mut c,
        "1",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(vec![language_title("old00", "Gilligan 00", &["eng"], 1)]),
        Some(("Gilligan", None, &english)),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(
        (receipt.admitted, receipt.new_visible_matches),
        (1, Some(0))
    );
    let receipt = commit_view(
        &mut c,
        "2",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(vec![language_title(
            "foreign",
            "Gilligan foreign",
            &["spa"],
            1,
        )]),
        Some(("Gilligan", None, &english)),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(
        (receipt.admitted, receipt.new_visible_matches),
        (1, Some(0))
    );
    let receipt = commit_view(
        &mut c,
        "3",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(vec![language_title(
            "new",
            "Gilligan ZZZ beyond first fifty",
            &["en-GB"],
            1,
        )]),
        Some(("Gilligan", None, &english)),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.new_visible_matches, Some(1));
    let mut q = search_query("Gilligan", "4");
    q.language_mode = LanguageMode::English;
    let first = query(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(first.total_count, 61);
    assert!(!first.items.iter().any(|item| item.title.contains("ZZZ")));
    let mut replacement = step(vec![language_title(
        "replacement",
        "Gilligan replacement",
        &["English"],
        1,
    )]);
    replacement.deleted.push("new".into());
    let receipt = commit_view(
        &mut c,
        "4",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        replacement,
        Some(("Gilligan", None, &english)),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(
        receipt.new_visible_matches,
        Some(1),
        "equal total count is not equal identity set"
    );
    assert_eq!(
        query(
            &c,
            &Query {
                expected_revision: Some("5".into()),
                ..q
            },
            &mut || Ok(())
        )
        .unwrap()
        .total_count,
        61
    );
}

#[test]
fn archive_visible_yield_uses_decade_favorites_curation_and_exact_language_filters() {
    for (language, decade, favorite_only, curated_only, expected) in [
        (LanguageMode::English, None, false, false, 0),
        (LanguageMode::Unlisted, None, false, false, 1),
        (LanguageMode::EnglishFirst, None, false, false, 1),
        (LanguageMode::All, Some(1970), false, false, 0),
        (LanguageMode::All, None, true, false, 0),
        (LanguageMode::All, None, false, true, 0),
    ] {
        let mut c = database();
        let view = DiscoveryView {
            favorites_only: favorite_only,
            curated_only,
            ..discovery_view(language)
        };
        let receipt = commit_view(
            &mut c,
            "0",
            SearchPage {
                year: None,
                page: 1,
                query_hash: "query",
                restart: false,
            },
            step(vec![language_title("new", "Gilligan", &[], 1)]),
            Some(("Gilligan", decade, &view)),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(receipt.new_visible_matches, Some(expected));
        assert_eq!(receipt.admitted, 1);
    }
}

#[test]
fn archive_visible_yield_cancel_stale_invalid_view_roll_back_catalog_and_cursor() {
    let mut c = database();
    let view = discovery_view(LanguageMode::All);
    assert!(commit_view(
        &mut c,
        "1",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false
        },
        step(vec![]),
        Some(("Gilligan", None, &view)),
        &mut || Ok(())
    )
    .is_err());
    let invalid = DiscoveryView {
        schema_version: 2,
        ..discovery_view(LanguageMode::All)
    };
    assert!(commit_view(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false
        },
        step(vec![]),
        Some(("Gilligan", None, &invalid)),
        &mut || Ok(())
    )
    .is_err());
    let mut checks = 0;
    assert!(commit_view(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false
        },
        step(vec![language_title("new", "Gilligan", &["eng"], 1)]),
        Some(("Gilligan", None, &view)),
        &mut || {
            checks += 1;
            if checks >= 5 {
                Err("canceled".into())
            } else {
                Ok(())
            }
        }
    )
    .is_err());
    assert_eq!(current(&c).unwrap(), 0);
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_progress_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn archive_content_types_are_grounded_claims_conflicts_and_legacy_stay_unknown() {
    for (claim, expected) in [
        ("Classic TV", ContentType::Tv),
        ("TV Series", ContentType::Tv),
        ("Feature film", ContentType::Movie),
        ("Short film", ContentType::Short),
        ("animated shorts", ContentType::Short),
        ("movie trailer", ContentType::Unknown),
        ("movies\nclassic tv", ContentType::Unknown),
        ("", ContentType::Unknown),
    ] {
        let m = SearchMetadata {
            subjects: claim.into(),
            ..Default::default()
        };
        assert_eq!(content_type(Some(&m)), expected, "{claim}");
    }
    assert_eq!(content_type(None), ContentType::Unknown);
    let mut c = database();
    let mut item = title("unknown", Some(2024), 1);
    item.kind = "movie";
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![item]),
        &mut || Ok(()),
    )
    .unwrap();
    let result = query(&c, &search_query("", "1"), &mut || Ok(())).unwrap();
    assert_eq!(result.items[0].content_type, ContentType::Unknown);
    assert_eq!(result.items[0].content_type_provenance, "unknown");
    assert!(result.items[0].artwork.is_none());
}

#[test]
fn archive_modern_browse_years_filter_before_paging_without_expanding_curation() {
    let mut c = database();
    let items = [1964, 2004, 2014, 2024, 2035, 2100]
        .into_iter()
        .map(|year| title(&format!("year{year}"), Some(year), 1))
        .collect();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(items),
        &mut || Ok(()),
    )
    .unwrap();
    for (decade, expected) in [(1960, 1), (2000, 1), (2010, 1), (2020, 3)] {
        let mut q = search_query("", "1");
        q.decade = Some(decade);
        q.page_size = 1;
        let first = query(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(first.total_count, expected);
        if decade == 2020 {
            q.offset = 2;
            assert_eq!(
                query(&c, &q, &mut || Ok(())).unwrap().items[0].release_year,
                Some(2100)
            );
        }
        q.curated_only = true;
        q.offset = 0;
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
    }
    let before = current(&c).unwrap();
    assert!(progress(
        &c,
        &ProgressQuery {
            schema_version: 1,
            request_id: "fixture".into(),
            query: "".into(),
            year: Some(2024),
            decade: Some(2020)
        }
    )
    .is_err());
    assert_eq!(current(&c).unwrap(), before);
}

#[test]
fn archive_type_filter_controls_titles_pending_and_atomic_new_visible_yield() {
    let mut c = database();
    let mut item = language_title("new", "Gilligan", &["eng"], 1);
    item.search_aliases = encode_search_metadata(&SearchMetadata {
        title: "Gilligan".into(),
        subjects: "Classic TV".into(),
        ..Default::default()
    })
    .unwrap();
    item.partial = Some(page(64, None));
    item.files[0].provider_index = Some(0);
    item.files[1].provider_index = Some(1);
    let view = DiscoveryView {
        content_type: ContentType::Movie,
        ..discovery_view(LanguageMode::All)
    };
    let receipt = commit_view(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![item]),
        Some(("Gilligan", None, &view)),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.new_visible_matches, Some(0));
    for (filter, expected) in [
        (ContentType::Tv, 1),
        (ContentType::Movie, 0),
        (ContentType::Unknown, 0),
        (ContentType::All, 1),
    ] {
        let mut q = search_query("Gilligan", "1");
        q.content_type = filter;
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, expected);
        let pending = FileProgressQuery {
            schema_version: 1,
            request_id: "fixture".into(),
            expected_revision: Some("1".into()),
            offset: 0,
            page_size: 50,
            query: "Gilligan".into(),
            decade: None,
            favorites_only: false,
            language_mode: LanguageMode::All,
            content_type: filter,
        };
        assert_eq!(
            item_progress(&c, &pending, &mut || Ok(()))
                .unwrap()
                .total_count,
            expected
        );
    }
}

#[test]
fn archive_artwork_source_legacy_null_and_versioned_actual_proof_preserve_authority() {
    let mut c = database();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![title("legacy", None, 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let reference = opaque(&["archive-item-v1", "legacy"]);
    assert_eq!(artwork_source(&c, &reference, "1").unwrap().0, "legacy");
    assert!(artwork_source(&c, &reference, "1").unwrap().1.is_none());
    assert!(artwork_source(&c, &reference, "0").is_err());
    let image = Artwork {
        item_id: "legacy".into(),
        file_name: "__ia_thumb.jpg".into(),
        size_bytes: "1330".into(),
        mime_type: "image/jpeg".into(),
        provider_sha1: None,
    };
    let metadata = SearchMetadata {
        artwork: Some(image.clone()),
        ..Default::default()
    };
    let encoded = encode_search_metadata(&metadata).unwrap();
    assert!(encoded.starts_with("@genx-search-v3:"));
    c.execute(
        "UPDATE archive_title_v1 SET search_text=?1 WHERE item_id='legacy'",
        [encoded],
    )
    .unwrap();
    assert!(artwork_source(&c, &reference, "1").unwrap().1 == Some(image));
    let legacy="@genx-search-v2:{\"title\":\"Legacy\",\"series\":\"\",\"subjects\":\"\",\"collections\":\"\",\"description\":\"\",\"languages\":[]}";
    assert!(decode_search_metadata(legacy)
        .unwrap()
        .unwrap()
        .artwork
        .is_none());
    let bad = SearchMetadata {
        artwork: Some(Artwork {
            item_id: "legacy".into(),
            file_name: "../../secret".into(),
            size_bytes: "1".into(),
            mime_type: "image/jpeg".into(),
            provider_sha1: None,
        }),
        ..Default::default()
    };
    assert!(encode_search_metadata(&bad).is_err());
}
