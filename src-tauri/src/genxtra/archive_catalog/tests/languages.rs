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

//! Archive catalog tests: language modes, filters and ranking tiers.

use super::*;

#[test]
fn archive_language_dto_default_and_invalid_modes_are_explicit() {
    let value = serde_json::json!({"schemaVersion":1,"requestId":"fixture","query":"","expectedRevision":null,"offset":0,"pageSize":50});
    assert_eq!(
        serde_json::from_value::<Query>(value.clone())
            .unwrap()
            .language_mode,
        LanguageMode::All
    );
    assert_eq!(
        serde_json::from_value::<FileProgressQuery>(value.clone())
            .unwrap()
            .language_mode,
        LanguageMode::All
    );
    for (mode, expected) in [
        ("all", LanguageMode::All),
        ("english-first", LanguageMode::EnglishFirst),
        ("english", LanguageMode::English),
        ("unlisted", LanguageMode::Unlisted),
    ] {
        let mut request = value.clone();
        request["languageMode"] = mode.into();
        assert_eq!(
            serde_json::from_value::<Query>(request.clone())
                .unwrap()
                .language_mode,
            expected
        );
        assert_eq!(
            serde_json::from_value::<FileProgressQuery>(request)
                .unwrap()
                .language_mode,
            expected
        );
    }
    for invalid in [
        serde_json::json!("English"),
        serde_json::json!("en"),
        serde_json::json!(""),
        serde_json::Value::Null,
        serde_json::json!(4),
    ] {
        let mut request = value.clone();
        request["languageMode"] = invalid;
        assert!(serde_json::from_value::<Query>(request.clone()).is_err());
        assert!(serde_json::from_value::<FileProgressQuery>(request).is_err());
    }
}

#[test]
fn archive_language_claim_aliases_do_not_guess_audio_or_country() {
    for label in [
        "en",
        "eng",
        "English",
        " ENGLISH ",
        "en-US",
        "en-GB",
        "en-Latn-US",
        "EN-au",
        "en-001",
    ] {
        assert_eq!(provider_language_rank(&[label.into()]), 0, "{label}");
    }
    for label in [
        "und",
        "unknown",
        "US",
        "GB",
        "United States",
        "United Kingdom",
        "English subtitles",
        "French and English",
        "en_uk",
        "english-US",
        "en-",
        "en-!",
        "en-US-",
        "en-notenglish",
    ] {
        assert_eq!(provider_language_rank(&[label.into()]), 2, "{label}");
    }
    assert_eq!(provider_language_rank(&[]), 1);
    assert_eq!(provider_language_rank(&["spa".into(), "en-GB".into()]), 0);
}

#[test]
fn archive_language_filters_preserve_unknown_legacy_library_and_bookmarks() {
    let mut c = database();
    let mut legacy = title("legacy", Some(1964), 99);
    legacy.title = "English US England".into();
    legacy.search_aliases = "eng English US London".into();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![
            language_title("en-us", "US provider claim", &["en-US"], 1),
            language_title("en-gb", "UK provider claim", &["en-GB"], 2),
            language_title("mixed", "Multiple claims", &["spa", "eng"], 3),
            language_title("unknown", "English in title", &[], 4),
            language_title("und", "Unknown label", &["und"], 5),
            language_title("country", "English London", &["United Kingdom"], 6),
            legacy,
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    let reference = opaque(&["archive-file-v1", "en-us", "one.mp4"]);
    c.execute(
        "UPDATE archive_file_v1 SET sha1=?1 WHERE file_ref=?2",
        params!["0123456789abcdef0123456789abcdef01234567", reference],
    )
    .unwrap();
    let file = resolve(&c, &reference, "1").unwrap();
    let proof = crate::archive_bookmarks::capture(&reference, &file).unwrap();
    let position = crate::archive_bookmarks::Position {
        position_ms: 12345,
        duration_ms: Some(60000),
        completed: false,
        observed_ms: 1000,
    };
    crate::archive_bookmarks::save(&mut c, &proof, "0", &position, || Ok(())).unwrap();
    let mut q = search_query("", "1");
    let before = refs(&query(&c, &q, &mut || Ok(())).unwrap());
    q.language_mode = LanguageMode::English;
    let english = query(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(english.total_count, 3);
    assert!(english
        .items
        .iter()
        .all(|t| t.language_provenance == "provider-item"));
    q.language_mode = LanguageMode::Unlisted;
    let unlisted = query(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(unlisted.total_count, 2);
    assert!(unlisted
        .items
        .iter()
        .all(|t| t.provider_languages.is_empty() && t.language_provenance == "unknown"));
    q.language_mode = LanguageMode::All;
    assert_eq!(refs(&query(&c, &q, &mut || Ok(())).unwrap()), before);
    assert_eq!(current(&c).unwrap(), 1);
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_file_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        14
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM unrelated_station", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        crate::archive_bookmarks::read(&c, &proof)
            .unwrap()
            .position
            .unwrap()
            .position_ms,
        12345
    );
}

#[test]
fn archive_language_english_first_preserves_favorite_and_relevance_tiers() {
    let mut c = database();
    let mut subject = language_title("english-subject", "Other name", &["eng"], 100);
    subject.search_aliases = encode_search_metadata(&SearchMetadata {
        title: "Other name".into(),
        subjects: "Cartoon".into(),
        languages: vec!["eng".into()],
        ..Default::default()
    })
    .unwrap();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(vec![
            language_title("favorite", "Cartoon extra", &["spa"], 1),
            language_title("exact", "Cartoon", &["spa"], 2),
            language_title("prefix-other", "Cartoon alpha", &["spa"], 3),
            language_title("prefix-unknown", "Cartoon beta", &[], 4),
            language_title("prefix-english", "Cartoon zeta", &["en"], 5),
            subject,
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    set_favorite(
        &mut c,
        &FavoriteRequest {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: opaque(&["archive-item-v1", "favorite"]),
            expected_revision: "1".into(),
            value: true,
        },
        &mut || Ok(()),
    )
    .unwrap();
    let mut q = search_query("Cartoon", "2");
    q.language_mode = LanguageMode::EnglishFirst;
    let expected = [
        "favorite",
        "exact",
        "prefix-english",
        "prefix-unknown",
        "prefix-other",
        "english-subject",
    ]
    .map(|id| opaque(&["archive-item-v1", id]));
    assert_eq!(refs(&query(&c, &q, &mut || Ok(())).unwrap()), expected);
    q.favorites_only = true;
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 1);
    q.language_mode = LanguageMode::English;
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
    assert!(c
        .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
            .get::<_, bool>(0))
        .unwrap());
}

#[test]
fn archive_language_blank_browse_stable_pagination_keeps_original_tiebreaks() {
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
        step(vec![
            language_title("english-a", "Z title", &["en"], 5),
            language_title("english-b", "A title", &["English"], 5),
            language_title("english-c", "B title", &["eng"], 1),
            language_title("unlisted", "No claim", &[], 99),
            language_title("other", "Spanish", &["spa"], 100),
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    let mut q = search_query("", "1");
    let old = refs(&query(&c, &q, &mut || Ok(())).unwrap());
    q.language_mode = LanguageMode::EnglishFirst;
    let expected = ["english-a", "english-b", "english-c", "unlisted", "other"]
        .map(|id| opaque(&["archive-item-v1", id]));
    assert_eq!(refs(&query(&c, &q, &mut || Ok(())).unwrap()), expected);
    q.page_size = 2;
    let mut paged = Vec::new();
    loop {
        let page = query(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(page.total_count, 5);
        paged.extend(refs(&page));
        if !page.more {
            break;
        }
        q.offset += page.items.len();
    }
    assert_eq!(paged, expected);
    q.offset = 0;
    q.page_size = 50;
    q.language_mode = LanguageMode::All;
    assert_eq!(refs(&query(&c, &q, &mut || Ok(())).unwrap()), old);
    q.decade = Some(1970);
    q.language_mode = LanguageMode::English;
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
}

#[test]
fn archive_language_pending_pages_share_filters_ranking_and_pagination() {
    let mut c = database();
    let mut titles = vec![
        language_title("english", "Cartoon zeta", &["en-GB"], 1),
        language_title("unknown", "Cartoon beta", &[], 2),
        language_title("spanish", "Cartoon alpha", &["spa"], 3),
        language_title("exact", "Cartoon", &["spa"], 4),
    ];
    for item in &mut titles {
        item.partial = Some(page(64, None));
    }
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: false,
        },
        step(titles),
        &mut || Ok(()),
    )
    .unwrap();
    let mut q = FileProgressQuery {
        schema_version: 1,
        request_id: "fixture".into(),
        expected_revision: Some("1".into()),
        offset: 0,
        page_size: 50,
        query: "Cartoon".into(),
        decade: None,
        favorites_only: false,
        language_mode: LanguageMode::English,
        content_type: ContentType::All,
    };
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().items[0].title_ref,
        opaque(&["archive-item-v1", "english"])
    );
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
        1
    );
    q.language_mode = LanguageMode::Unlisted;
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().items[0].title_ref,
        opaque(&["archive-item-v1", "unknown"])
    );
    q.language_mode = LanguageMode::EnglishFirst;
    q.page_size = 1;
    let expected =
        ["exact", "english", "unknown", "spanish"].map(|id| opaque(&["archive-item-v1", id]));
    let mut actual = Vec::new();
    for offset in 0..4 {
        q.offset = offset;
        let reply = item_progress(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(reply.total_count, 4);
        assert_eq!(reply.more, offset < 3);
        actual.push(reply.items[0].title_ref.clone());
    }
    assert_eq!(actual, expected);
    q.offset = 0;
    q.decade = Some(1970);
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
        0
    );
    q.decade = None;
    q.language_mode = LanguageMode::All;
    assert_eq!(
        item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
        4
    );
    assert_eq!(current(&c).unwrap(), 1);
}
