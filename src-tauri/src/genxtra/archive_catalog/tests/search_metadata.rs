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

//! Archive catalog tests: structured search metadata and subject matching.

use super::*;

#[test]
fn archive_structured_metadata_matches_fields_not_description_or_json_keys() {
    let mut c = database();
    let mut items = Vec::new();
    for (id, name, subject, description, language) in [
        ("title", "Classic Cartoon Collection", "", "", "eng"),
        ("subject", "Classic shorts", "animation", "", "English"),
        (
            "incidental",
            "News report",
            "",
            "A cartoon is mentioned here",
            "spa",
        ),
        ("substring", "Cartoonish commentary", "", "", ""),
        ("spanish", "Cartoons in Spanish", "cartoons", "", "spa"),
    ] {
        let mut t = title(id, Some(1964), 1);
        t.title = name.into();
        t.search_aliases = encode_search_metadata(&SearchMetadata {
            title: name.into(),
            subjects: subject.into(),
            description: description.into(),
            collections: "cartoons".into(),
            languages: if language.is_empty() {
                vec![]
            } else {
                vec![language.into()]
            },
            ..Default::default()
        })
        .unwrap();
        items.push(t);
    }
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "Cartoon",
            restart: false,
        },
        step(items),
        &mut || Ok(()),
    )
    .unwrap();
    let page = query(&c, &search_query("Cartoon", "1"), &mut || Ok(())).unwrap();
    assert_eq!(page.total_count, 3);
    assert_eq!(page.items[0].match_basis, "title");
    assert!(page
        .items
        .iter()
        .any(|t| t.match_basis == "subject" && t.provider_languages == ["English"]));
    assert!(page
        .items
        .iter()
        .any(|t| t.provider_languages == ["spa"] && t.language_provenance == "provider-item"));
    assert!(query(&c, &search_query("languages", "1"), &mut || Ok(()))
        .unwrap()
        .items
        .is_empty());
    assert_eq!(
        query(&c, &search_query("", "1"), &mut || Ok(()))
            .unwrap()
            .total_count,
        5
    );
}

#[test]
fn archive_metadata_envelope_is_bounded_and_legacy_stays_truthful() {
    assert_eq!(match_basis("", "cartoonish", "", "cartoon").unwrap(), None);
    assert_eq!(
        match_basis("", "gilligan island", "", "Gilligan").unwrap(),
        None
    );
    assert!(decode_search_metadata("@genx-search-v2:{broken}").is_err());
    let big = SearchMetadata {
        description: "x".repeat(16384),
        ..Default::default()
    };
    assert!(encode_search_metadata(&big).is_err());
    let data = SearchMetadata {
        series: "Gilligan Island".into(),
        description: "cartoons".into(),
        ..Default::default()
    };
    let encoded = encode_search_metadata(&data).unwrap();
    assert_eq!(
        match_basis("", &encoded, "", "Gilligan").unwrap(),
        Some("series")
    );
    assert_eq!(match_basis("", &encoded, "", "cartoons").unwrap(), None);
    assert_eq!(
        match_basis("", &encoded, "Gilligan_S01_E01.mp4", "Gilligan").unwrap(),
        Some("series")
    );
    assert_eq!(
        match_basis("", &encoded, "Pilot_Episode.mp4", "Pilot episode").unwrap(),
        Some("file")
    );
}

#[test]
fn archive_structured_pending_pages_decode_actual_title_without_matching_json() {
    let mut c = database();
    let mut t = title("partial", Some(1964), 1);
    t.partial = Some(page(64, None));
    t.search_aliases = encode_search_metadata(&SearchMetadata {
        title: "Gilligan Island".into(),
        description: "cartoons".into(),
        ..Default::default()
    })
    .unwrap();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "Gilligan",
            restart: false,
        },
        step(vec![t]),
        &mut || Ok(()),
    )
    .unwrap();
    let q = FileProgressQuery {
        schema_version: 1,
        request_id: "fixture".into(),
        expected_revision: Some("1".into()),
        offset: 0,
        page_size: 50,
        query: "Gilligan".into(),
        decade: None,
        favorites_only: false,
        language_mode: LanguageMode::All,
        content_type: ContentType::All,
    };
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
        1
    );
    let q = FileProgressQuery {
        query: "description".into(),
        ..q
    };
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
        0
    );
}

#[test]
fn archive_search_named_possessive_is_bounded_not_arbitrary_prefix() {
    assert_eq!(
        match_basis(
            "Gilligans Island 1.00",
            "",
            "GilligansIsland1.00.mp4",
            "Gilligan"
        )
        .unwrap(),
        Some("title")
    );
    assert_eq!(
        match_basis("Gilligan's Island", "", "", "Gilligan").unwrap(),
        Some("title")
    );
    assert_eq!(
        match_basis("Gilliganish parody", "", "", "Gilligan").unwrap(),
        None
    );
    assert_eq!(
        match_basis("Cartoonish commentary", "", "", "Cartoon").unwrap(),
        None
    );
    assert_ne!(
        search_scope_hash("Gilligan", None),
        opaque(&["archive-query-v3", "Gilligan", ""])
    );
}

#[test]
fn archive_cartoon_subject_rejects_observed_youtube_category_boilerplate() {
    let mut c = database();
    let mut items = Vec::new();
    for (id, name, subject) in [
        (
            "vlog",
            "How Men's Circles Can Bring You Into Your Feelings",
            "Youtube;video;Film & Animation;",
        ),
        (
            "security",
            "AT&T ThreatTraq",
            "Youtube,video,Film & Animation",
        ),
        ("war", "Ukrainian war", "Youtube\nvideo\nFilm & Animation"),
        ("trailer", "MAGADAN trailer", "Film and Animation"),
        (
            "real",
            "Classic shorts",
            "Youtube;Film & Animation;Cartoons;",
        ),
        ("animation", "Classic shorts two", "Animation"),
    ] {
        let mut t = title(id, Some(1970), 1);
        t.title = name.into();
        t.search_aliases = encode_search_metadata(&SearchMetadata {
            title: name.into(),
            subjects: subject.into(),
            ..Default::default()
        })
        .unwrap();
        items.push(t);
    }
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "Cartoon",
            restart: false,
        },
        step(items),
        &mut || Ok(()),
    )
    .unwrap();
    let result = query(&c, &search_query("Cartoon", "1"), &mut || Ok(())).unwrap();
    assert_eq!(result.total_count, 2);
    assert!(result.items.iter().all(|t| t.match_basis == "subject"));
    assert_eq!(
        query(&c, &search_query("", "1"), &mut || Ok(()))
            .unwrap()
            .total_count,
        6
    );
    assert_eq!(
        match_basis("Animated Classic", "", "", "Cartoon").unwrap(),
        Some("title")
    );
    assert!(subject_match("Film & Animation;Animated", "Cartoon"));
    assert!(!subject_match("Film & Animation;", "Cartoon"));
    assert_ne!(
        search_scope_hash("Cartoon", None),
        opaque(&["archive-query-fields-v4", "Cartoon", ""])
    );
}

#[test]
fn archive_local_query_matches_subject_and_episode_filename_without_merging_items() {
    let mut c = database();
    let mut first = title("first", Some(1964), 1);
    first.search_aliases = encode_search_metadata(&SearchMetadata {
        title: first.title.clone(),
        subjects: "monster movies".into(),
        ..Default::default()
    })
    .unwrap();
    first.files[0].name = "Pilot episode.mp4".into();
    first.all_file_names[0] = "Pilot episode.mp4".into();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![first, title("second", Some(1964), 2)]),
        &mut || Ok(()),
    )
    .unwrap();
    let mut q = Query {
        schema_version: 1,
        request_id: "fixture".into(),
        query: "monster".into(),
        expected_revision: Some("1".into()),
        offset: 0,
        page_size: 50,
        curated_only: false,
        decade: None,
        favorites_only: false,
        language_mode: LanguageMode::All,
        content_type: ContentType::All,
    };
    let page = query(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(page.total_count, 1);
    assert_eq!(
        page.items[0].title_ref,
        opaque(&["archive-item-v1", "first"])
    );
    q.query = "pilot episode".into();
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 1);
    q.query = "identical".into();
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 2);
    q.expected_revision = Some("0".into());
    assert!(matches!(query(&c,&q,&mut || Ok(())),Err(e) if e=="archive-revision-stale"));
}

pub(super) fn search_title(
    id: &str,
    name: &str,
    year: Option<i64>,
    downloads: i64,
    alias: &str,
) -> PreparedTitle {
    let mut t = title(id, year, downloads);
    t.title = name.into();
    t.search_aliases = encode_search_metadata(&SearchMetadata {
        title: name.into(),
        subjects: alias.into(),
        ..Default::default()
    })
    .unwrap();
    t
}

pub(super) fn search_query(value: &str, revision: &str) -> Query {
    Query {
        schema_version: 1,
        request_id: "fixture".into(),
        query: value.into(),
        expected_revision: Some(revision.into()),
        offset: 0,
        page_size: 50,
        curated_only: false,
        decade: None,
        favorites_only: false,
        language_mode: LanguageMode::All,
        content_type: ContentType::All,
    }
}

pub(super) fn refs(page: &Page) -> Vec<String> {
    page.items.iter().map(|t| t.title_ref.clone()).collect()
}

pub(super) fn language_title(
    id: &str,
    name: &str,
    languages: &[&str],
    downloads: i64,
) -> PreparedTitle {
    let mut item = search_title(id, name, Some(1964), downloads, "");
    item.search_aliases = encode_search_metadata(&SearchMetadata {
        title: name.into(),
        languages: languages.iter().map(|s| (*s).into()).collect(),
        ..Default::default()
    })
    .unwrap();
    item
}
