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

//! Archive catalog tests: cancellation, failed refreshes, the live fence, and
//! observed metadata.

use super::*;

#[test]
fn archive_cancellation_rolls_back_catalog_and_progress() {
    let mut c = database();
    let mut calls = 0;
    let result = commit(
        &mut c,
        "0",
        SearchPage {
            year: Some(1964),
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![title("held", Some(1964), 1)]),
        &mut || {
            calls += 1;
            if calls >= 3 {
                Err("canceled".into())
            } else {
                Ok(())
            }
        },
    );
    assert!(result.is_err());
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
fn archive_transient_failure_keeps_last_good_files_and_retry_page() {
    let mut c = database();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: Some(1964),
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![title("retained", Some(1964), 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let mut failed = step(Vec::new());
    failed.transient_failures = 1;
    failed.next_page = Some(1);
    let receipt = commit(
        &mut c,
        "1",
        SearchPage {
            year: Some(1964),
            page: 1,
            query_hash: "query",
            restart: true,
        },
        failed,
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.title_count, 1);
    assert_eq!(receipt.confirmed_dead, 0);
    assert_eq!(receipt.next_page, Some(1));
    assert!(receipt.retry_after_ms.is_some());
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_file_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        prepare_at(&c, "2", 1964, 1, "query", false, 1_000_000),
        Err("archive-retry-not-due".into())
    );
}

#[test]
fn archive_live_fence_ignores_unrelated_revision_and_refuses_changed_binding() {
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
        step(vec![title("selected", Some(1928), 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let reference = opaque(&["archive-file-v1", "selected", "one.mp4"]);
    let file = resolve(&c, &reference, "1").unwrap();
    commit(
        &mut c,
        "1",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "other-query",
            restart: false,
        },
        step(vec![title("unrelated", None, 2)]),
        &mut || Ok(()),
    )
    .unwrap();
    assert!(verify_live(&c, &reference, &file).is_ok());
    c.execute(
        "UPDATE archive_file_v1 SET size_bytes='301' WHERE file_ref=?1",
        [&reference],
    )
    .unwrap();
    assert_eq!(
        verify_live(&c, &reference, &file),
        Err("archive-file-changed".into())
    );
    c.execute(
        "UPDATE archive_file_v1 SET eligible=0 WHERE file_ref=?1",
        [&reference],
    )
    .unwrap();
    assert_eq!(
        verify_live(&c, &reference, &file),
        Err("archive-file-unavailable".into())
    );
}

#[test]
fn archive_complete_file_list_removes_only_confirmed_absent_copy() {
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
        step(vec![title("selected", None, 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let mut fresh = title("selected", None, 1);
    fresh.all_file_names = vec!["one.mp4".into()];
    fresh.files.truncate(1);
    let result = commit(
        &mut c,
        "1",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(vec![fresh]),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(result.confirmed_dead, 1);
    assert_eq!(result.title_count, 1);
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_file_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

pub(super) fn observed_search_metadata(raw: &str) -> SearchMetadata {
    let document: serde_json::Value = serde_json::from_str(raw).unwrap();
    let metadata = &document["metadata"];
    let field = |name: &str| match &metadata[name] {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Array(values) => values
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    SearchMetadata {
        title: field("title"),
        series: field("series"),
        subjects: field("subject"),
        collections: field("collection"),
        description: String::new(),
        languages: vec![],
        provider_type: String::new(),
        artwork: None,
    }
}

#[test]
fn archive_observed_concert_cartoon_tag_is_not_animation_but_named_browse_remain() {
    let metadata = observed_search_metadata(include_str!(
            "../../../../../tests/fixtures/archive-search-metadata/kdhxmo-Opera_Bell_Band_50_000_000_Live_at_KDHX_7_20_21.json"
        ));
    assert!(metadata.subjects.lines().any(|label| label == "cartoon"));
    let aliases = encode_search_metadata(&metadata).unwrap();
    for query in ["Cartoon", "cartoons", "animation", "animated"] {
        assert_eq!(
            match_basis(
                &metadata.title,
                &aliases,
                "Opera_Bell_Band_50_000_000_Live_at_KDHX_7_20_21.mp4",
                query
            )
            .unwrap(),
            None
        );
    }
    assert_eq!(
        match_basis(&metadata.title, &aliases, "", "Opera Bell Band").unwrap(),
        Some("title")
    );
    assert_eq!(
        match_basis(&metadata.title, &aliases, "", "").unwrap(),
        Some("browse")
    );
    assert_eq!(
        match_basis("Cartoonish commentary", "", "", "Cartoon").unwrap(),
        None
    );
    let only_style = SearchMetadata {
        title: metadata.title.clone(),
        subjects: "cartoon".into(),
        ..Default::default()
    };
    let style_aliases = encode_search_metadata(&only_style).unwrap();
    assert_eq!(
        match_basis(&only_style.title, &style_aliases, "", "Cartoon").unwrap(),
        None
    );
    assert_eq!(
        match_basis("", &style_aliases, "", "Cartoon").unwrap(),
        None,
        "pending suggestions retain the actual live-performance title context"
    );
    let animated = SearchMetadata {
        title: "Animated concert".into(),
        subjects: "music video\nAnimation".into(),
        ..Default::default()
    };
    let aliases = encode_search_metadata(&animated).unwrap();
    assert_eq!(
        match_basis("", &aliases, "", "Cartoon").unwrap(),
        Some("title"),
        "pending metadata follows the same actual-title evidence"
    );
}

#[test]
fn archive_observed_title_keywords_cannot_override_incidental_context() {
    let concert = observed_search_metadata(include_str!(
            "../../../../../tests/fixtures/archive-search-metadata/mmtvnh-Merrimack_Middle_School_Band_-_Cartoon_Symphony_2023.json"
        ));
    let alias = encode_search_metadata(&concert).unwrap();
    assert_eq!(
        match_basis(&concert.title, &alias, "Cartoon.mp4", "Cartoon").unwrap(),
        None
    );
    assert_eq!(
        match_basis("", &alias, "", "Cartoon").unwrap(),
        None,
        "pending predicate"
    );
    assert_eq!(
        match_basis(&concert.title, &alias, "", "Merrimack Middle School Band").unwrap(),
        Some("title")
    );
    assert_eq!(
        match_basis(&concert.title, &alias, "", "").unwrap(),
        Some("browse")
    );
    assert_eq!(
        match_basis(&concert.title, &alias, "", "concert").unwrap(),
        Some("subject"),
        "explicit context searches remain supported"
    );
    let animated = observed_search_metadata(include_str!(
        "../../../../../tests/fixtures/archive-search-metadata/GrooviesMusicalEvolution.json"
    ));
    assert_eq!(
        match_basis(
            &animated.title,
            &encode_search_metadata(&animated).unwrap(),
            "",
            "Cartoon"
        )
        .unwrap(),
        Some("title"),
        "corroborated animation is not excluded merely for music"
    );
    for (raw, specific) in [
            (include_str!("../../../../../tests/fixtures/archive-search-metadata/gtv16nm-El_Camino_-_A_Breaking_Bad_Movie_An_Interview_with_Vince_Gilligan_from_the_KiMo_Theatre.json"), "Vince Gilligan"),
            (include_str!("../../../../../tests/fixtures/archive-search-metadata/Humane_Society_of_St._Lucie_County_Adopt-a-Pet_-_Gilligan.json"), "Adopt a Pet Gilligan"),
            (include_str!("../../../../../tests/fixtures/archive-search-metadata/JamusUnpluggedLiveGilligansBarAndGrillJanuary112019.json"), "Jamus Unplugged"),
        ] {
            let m = observed_search_metadata(raw);
            let alias = encode_search_metadata(&m).unwrap();
            assert_eq!(match_basis(&m.title, &alias, "Gilligan.mp4", "Gilligan").unwrap(), None, "{}", m.title);
            assert_eq!(match_basis("", &alias, "", "Gilligan").unwrap(), None, "pending {}", m.title);
            assert_eq!(match_basis(&m.title, &alias, "", specific).unwrap(), Some("title"));
            assert_eq!(match_basis(&m.title, &alias, "", "").unwrap(), Some("browse"));
        }
}

#[test]
fn archive_observed_type_classifier_is_shared_not_a_collection_or_title_guess() {
    for (raw, expected) in [
            (
                include_str!("../../../../../tests/fixtures/archive-search-metadata/GilligansIsland1.00.json"),
                ContentType::Tv,
            ),
            (
                include_str!("../../../../../tests/fixtures/archive-search-metadata/thenewadventuresofgilligans1.json"),
                ContentType::Tv,
            ),
            (
                include_str!("../../../../../tests/fixtures/archive-search-metadata/NightOfTheLivingDead-MPEG.json"),
                ContentType::Movie,
            ),
            (
                include_str!(
                    "../../../../../tests/fixtures/archive-search-metadata/mmtvnh-Merrimack_Middle_School_Band_-_Cartoon_Symphony_2023.json"
                ),
                ContentType::Unknown,
            ),
        ] {
            assert_eq!(content_type(Some(&observed_search_metadata(raw))), expected);
        }
    for collections in [
        "opensource_movies\ncommunity",
        "television\ncommunity_media",
        "animationandcartoons",
        "my_feature_films",
    ] {
        assert_eq!(
            content_type(Some(&SearchMetadata {
                collections: collections.into(),
                ..Default::default()
            })),
            ContentType::Unknown
        );
    }
    assert_eq!(
        content_type(Some(&SearchMetadata {
            collections: "classic_tv\nfeature_films".into(),
            ..Default::default()
        })),
        ContentType::Unknown
    );
}

#[test]
fn archive_observed_animation_taxonomy_and_subjects_are_genre_not_playability_proof() {
    for (raw, expected) in [
        (
            include_str!("../../../../../tests/fixtures/archive-search-metadata/Popeye_forPresident.json"),
            "subject",
        ),
        (
            include_str!("../../../../../tests/fixtures/archive-search-metadata/BettyBoopCartoons.json"),
            "title",
        ),
        (
            include_str!(
                "../../../../../tests/fixtures/archive-search-metadata/BugsBunnyCaseOfTheMissingHare.json"
            ),
            "genre",
        ),
    ] {
        let metadata = observed_search_metadata(raw);
        let aliases = encode_search_metadata(&metadata).unwrap();
        assert_eq!(
            match_basis(&metadata.title, &aliases, "", "Cartoon").unwrap(),
            Some(expected),
            "{}",
            metadata.title
        );
        assert_eq!(
            match_basis(&metadata.title, &aliases, "", "Gilligan").unwrap(),
            None
        );
    }
    let metadata = SearchMetadata {
        title: "Unrelated record".into(),
        collections: "cartoon\nmy_animationandcartoons".into(),
        description: "Cartoon animation".into(),
        ..Default::default()
    };
    assert_eq!(
        match_basis(
            &metadata.title,
            &encode_search_metadata(&metadata).unwrap(),
            "",
            "Cartoon"
        )
        .unwrap(),
        None
    );
}
