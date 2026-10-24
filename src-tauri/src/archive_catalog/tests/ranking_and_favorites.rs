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

//! Archive catalog tests: search ranking, decades and favorites.

use super::*;

#[test]
fn archive_search_ranks_favorites_then_literal_title_matches_before_aliases() {
    let mut c = database();
    let phrase = "night of living dead";
    commit(
        &mut c,
        "0",
        SearchPage {
            year: None,
            page: 1,
            query_hash: phrase,
            restart: false,
        },
        step(vec![
            search_title(
                "description",
                "High Street Cemetery",
                Some(1968),
                900,
                phrase,
            ),
            search_title(
                "tokens",
                "Night Living Dead: of Terror",
                Some(1968),
                800,
                "",
            ),
            search_title(
                "contains",
                "Restored Night of Living Dead Feature",
                Some(1968),
                700,
                "",
            ),
            search_title("prefix", "Night of Living Dead 4K", Some(1968), 600, ""),
            search_title("exact", "Night of Living Dead", Some(1968), 1, ""),
            search_title("favorite", "Monster Movie Night", Some(1968), 1000, phrase),
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
    let q = search_query("  NIGHT  of Living DEAD  ", "2");
    let result = query(&c, &q, &mut || Ok(())).unwrap();
    let expected: Vec<_> = [
        "favorite",
        "exact",
        "prefix",
        "contains",
        "tokens",
        "description",
    ]
    .into_iter()
    .map(|id| opaque(&["archive-item-v1", id]))
    .collect();
    assert_eq!(refs(&result), expected);
    assert_eq!(result.total_count, 6);
    assert!(result.items[0].favorite);
    // Popularity rank remains source metadata, not the relevance position.
    assert_eq!(result.items[1].rank, 6);
    let mut paged = q;
    paged.page_size = 2;
    let mut actual = Vec::new();
    for offset in [0, 2, 4] {
        paged.offset = offset;
        let page = query(&c, &paged, &mut || Ok(())).unwrap();
        assert_eq!(page.total_count, 6);
        assert_eq!(page.more, offset < 4);
        actual.extend(refs(&page));
    }
    assert_eq!(actual, expected);
    paged.expected_revision = Some("1".into());
    assert!(matches!(query(&c, &paged, &mut || Ok(())), Err(e) if e == "archive-revision-stale"));
}

#[test]
fn archive_search_blank_keeps_popularity_order_with_favorites_first_and_decade_scope() {
    let mut c = database();
    commit(
        &mut c,
        "0",
        SearchPage {
            year: Some(1968),
            page: 1,
            query_hash: "",
            restart: false,
        },
        step(vec![
            search_title("high", "Zulu", Some(1968), 300, ""),
            search_title("middle", "Alpha", Some(1968), 200, ""),
            search_title("favorite", "Low", Some(1968), 1, ""),
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    commit(
        &mut c,
        "1",
        SearchPage {
            year: Some(1970),
            page: 1,
            query_hash: "",
            restart: false,
        },
        step(vec![search_title(
            "later",
            "Earlier Alphabet",
            Some(1970),
            9999,
            "",
        )]),
        &mut || Ok(()),
    )
    .unwrap();
    set_favorite(
        &mut c,
        &FavoriteRequest {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: opaque(&["archive-item-v1", "favorite"]),
            expected_revision: "2".into(),
            value: true,
        },
        &mut || Ok(()),
    )
    .unwrap();
    let mut q = search_query("   ", "3");
    q.curated_only = true;
    let result = query(&c, &q, &mut || Ok(())).unwrap();
    let expected: Vec<_> = ["favorite", "high", "middle", "later"]
        .into_iter()
        .map(|id| opaque(&["archive-item-v1", id]))
        .collect();
    assert_eq!(refs(&result), expected);
    assert_eq!(
        result.items.iter().map(|t| t.rank).collect::<Vec<_>>(),
        [3, 1, 2, 1]
    );
    q.decade = Some(1970);
    let filtered = query(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(filtered.total_count, 1);
    assert_eq!(filtered.items[0].title_ref, expected[3]);
    q.favorites_only = true;
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
}

#[test]
fn archive_search_unicode_punctuation_and_identity_ties_are_literal_and_stable() {
    let mut c = database();
    let punctuation = "%'_; DROP TABLE archive_title_v1; --";
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
            search_title("unicode-b", "ÉCOLE du cinéma", Some(1964), 1, ""),
            search_title("unicode-a", "École du cinéma", Some(1964), 900, ""),
            search_title(
                "unicode-description",
                "Anthology",
                Some(1964),
                9999,
                "école du cinéma",
            ),
            search_title("punctuation", punctuation, Some(1964), 2, ""),
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    let result = query(
        &c,
        &search_query("E\u{301}COLE du CINE\u{301}MA", "1"),
        &mut || Ok(()),
    )
    .unwrap();
    let mut expected = [
        opaque(&["archive-item-v1", "unicode-a"]),
        opaque(&["archive-item-v1", "unicode-b"]),
    ];
    expected.sort();
    assert_eq!(&refs(&result)[..2], &expected);
    assert_eq!(result.total_count, 3);
    assert_eq!(
        result.items[2].title_ref,
        opaque(&["archive-item-v1", "unicode-description"])
    );
    let literal = query(&c, &search_query(punctuation, "1"), &mut || Ok(())).unwrap();
    assert_eq!(literal.total_count, 1);
    assert_eq!(literal.items[0].title, punctuation);
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        4
    );
    let mut canceled = 0;
    assert!(query(&c, &search_query("école", "1"), &mut || {
        canceled += 1;
        Err("canceled".into())
    })
    .is_err());
    assert_eq!(canceled, 1);
}

#[test]
fn archive_decade_and_favorites_filter_before_exact_count_and_page() {
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
            title("sixties", Some(1969), 1),
            title("seventies", Some(1970), 2),
            title("unknown", None, 3),
            title("other-seventies", Some(1979), 4),
        ]),
        &mut || Ok(()),
    )
    .unwrap();
    let favorite = FavoriteRequest {
        schema_version: 1,
        request_id: "fixture".into(),
        title_ref: opaque(&["archive-item-v1", "seventies"]),
        expected_revision: "1".into(),
        value: true,
    };
    assert_eq!(
        set_favorite(&mut c, &favorite, &mut || Ok(()))
            .unwrap()
            .revision,
        "2"
    );
    let mut q = Query {
        schema_version: 1,
        request_id: "fixture".into(),
        query: String::new(),
        expected_revision: Some("2".into()),
        offset: 0,
        page_size: 1,
        curated_only: false,
        decade: Some(1970),
        favorites_only: false,
        language_mode: LanguageMode::All,
        content_type: ContentType::All,
    };
    let page = query(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(page.total_count, 2);
    assert!(page.more);
    q.offset = 1;
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().items.len(), 1);
    q.offset = 0;
    q.favorites_only = true;
    let page = query(&c, &q, &mut || Ok(())).unwrap();
    assert_eq!(page.total_count, 1);
    assert!(page.items[0].favorite);
    assert_eq!(page.items[0].title_ref, favorite.title_ref);
    q.decade = Some(1960);
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
    q.favorites_only = false;
    assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 1);
    q.decade = Some(1950);
    assert!(query(&c, &q, &mut || Ok(())).is_err());
}

#[test]
fn archive_favorite_cas_cancel_refresh_and_dead_tombstone_are_durable() {
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
        step(vec![title("chosen", Some(1964), 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let mut r = FavoriteRequest {
        schema_version: 1,
        request_id: "fixture".into(),
        title_ref: opaque(&["archive-item-v1", "chosen"]),
        expected_revision: "1".into(),
        value: true,
    };
    assert_eq!(
        set_favorite(&mut c, &r, &mut || Ok(())).unwrap().revision,
        "2"
    );
    assert!(matches!(set_favorite(&mut c,&r,&mut ||Ok(())),Err(e) if e=="archive-revision-stale"));
    r.expected_revision = "2".into();
    assert_eq!(
        set_favorite(&mut c, &r, &mut || Ok(())).unwrap().revision,
        "2"
    );
    r.value = false;
    let mut calls = 0;
    assert!(set_favorite(&mut c, &r, &mut || {
        calls += 1;
        if calls == 2 {
            Err("canceled".into())
        } else {
            Ok(())
        }
    })
    .is_err());
    assert_eq!(current(&c).unwrap(), 2);
    assert!(c
        .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
            .get::<_, bool>(0))
        .unwrap());
    let mut retry = step(Vec::new());
    retry.transient_failures = 1;
    retry.next_page = Some(1);
    commit(
        &mut c,
        "2",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        retry,
        &mut || Ok(()),
    )
    .unwrap();
    assert!(c
        .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
            .get::<_, bool>(0))
        .unwrap());
    let mut refresh = step(vec![title("chosen", Some(1964), 99)]);
    refresh.observed_ms = 2_000_000;
    commit(
        &mut c,
        "3",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        refresh,
        &mut || Ok(()),
    )
    .unwrap();
    assert!(c
        .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
            .get::<_, bool>(0))
        .unwrap());
    let mut dead = step(Vec::new());
    dead.deleted.push("chosen".into());
    commit(
        &mut c,
        "4",
        SearchPage {
            year: None,
            page: 1,
            query_hash: "query",
            restart: true,
        },
        dead,
        &mut || Ok(()),
    )
    .unwrap();
    assert!(c
        .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
            .get::<_, bool>(0))
        .unwrap());
    r.expected_revision = "5".into();
    assert_eq!(
        set_favorite(&mut c, &r, &mut || Ok(())).unwrap().revision,
        "6"
    );
    assert!(!c
        .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
            .get::<_, bool>(0))
        .unwrap());
}

#[test]
fn archive_favorite_retains_playable_item_when_year_ranking_changes() {
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
        step(vec![title("chosen", Some(1964), 1)]),
        &mut || Ok(()),
    )
    .unwrap();
    let r = FavoriteRequest {
        schema_version: 1,
        request_id: "fixture".into(),
        title_ref: opaque(&["archive-item-v1", "chosen"]),
        expected_revision: "1".into(),
        value: true,
    };
    set_favorite(&mut c, &r, &mut || Ok(())).unwrap();
    commit(
        &mut c,
        "2",
        SearchPage {
            year: Some(1964),
            page: 1,
            query_hash: "query",
            restart: true,
        },
        step(
            (0..10)
                .map(|i| title(&format!("new-{i}"), Some(1964), 100 + i))
                .collect(),
        ),
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM archive_title_v1 WHERE curated=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        10
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM archive_file_v1 WHERE title_ref=?1",
            [&r.title_ref],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert!(!c
        .query_row(
            "SELECT curated FROM archive_title_v1 WHERE title_ref=?1",
            [&r.title_ref],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
}
