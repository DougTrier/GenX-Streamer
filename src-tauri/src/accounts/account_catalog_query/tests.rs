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

//! Tests of Paid TV account channel queries.

use super::*;

#[cfg(test)]
mod geography_tests {
    //! Synthetic Xtream-shaped catalog on the production schema, read through
    //! the production `read_page`/`read_countries` (the real six-table join).
    use super::*;
    use rusqlite::params;
    const ACCOUNT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SECRET: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const BATCH: &str = "cccccccccccccccccccccccccccccccc";
    /// (letter, name, provider group, removed, favorite)
    const CHANNELS: &[(char, &str, &str, bool, bool)] = &[
        ('a', "Alpha News", "USA", false, false),
        ('b', "Bravo Sport", "UK ➾ Sport", false, true),
        ('c', "Charlie TV", "EX-YU", false, false),
        ('d', "Delta Late", "US ➾ Adult", false, false),
        ('e', "Echo Night", "UK ➾ XXX", false, false),
        ('f', "Foxtrot After Dark", "Adult 🔞", false, false),
        ('g', "Golf Removed", "USA", true, false),
    ];
    fn id(letter: char) -> String {
        format!("account-{ACCOUNT}-{}", letter.to_string().repeat(64))
    }
    fn database() -> Connection {
        fill(Connection::open_in_memory().unwrap())
    }
    fn fill(c: Connection) -> Connection {
        c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        crate::account_media_store::initialize(&c).unwrap();
        install_indexes(&c).unwrap();
        c.execute_batch(&format!(
            "INSERT INTO account_vault_versions_v1 VALUES('{ACCOUNT}',1,1);
             INSERT INTO account_vault_meta_v1 VALUES('{ACCOUNT}','Fixture','xtream','https://provider.invalid',0,1,'{SECRET}');
             INSERT INTO account_media_catalog_v1 VALUES('{ACCOUNT}',1,'{SECRET}','{BATCH}',1);
             INSERT INTO account_media_page_v1 VALUES('page-1','{ACCOUNT}','{BATCH}',0,0);
             INSERT INTO account_preferences_meta_v1 VALUES('{ACCOUNT}',1);"
        ))
        .unwrap();
        for (letter, name, group, removed, favorite) in CHANNELS {
            let reference = letter.to_string().repeat(32).replace('g', "9");
            c.execute(
                "INSERT INTO account_vault_references_v1 VALUES(?1,?2,1,'media')",
                params![reference, ACCOUNT],
            )
            .unwrap();
            c.execute(
                "INSERT INTO account_media_entry_v1 VALUES(?1,?2,?3,?4,NULL,NULL,?5,'page-1')",
                params![ACCOUNT, id(*letter), name, group, reference],
            )
            .unwrap();
            if *removed || *favorite {
                c.execute(
                    "INSERT INTO account_channel_preferences_v1 VALUES(?1,?2,?3,?4,NULL)",
                    params![ACCOUNT, id(*letter), favorite, removed],
                )
                .unwrap();
            }
        }
        c
    }
    fn query(country: Option<&str>, hide_adult: bool, sort: Sort, filter: Filter) -> Query {
        Query {
            schema_version: 1,
            account_id: ACCOUNT.into(),
            expected_account_revision: "1".into(),
            expected_media_revision: None,
            expected_preferences_revision: None,
            expected_guide_revision: None,
            sports: None,
            query: String::new(),
            category: None,
            filter,
            history_ids: None,
            sort,
            favorites_first: false,
            country: country.map(str::to_owned),
            hide_adult,
            start_index: 0,
            anchor_id: None,
            page_size: 64,
        }
    }
    fn names(c: &Connection, request: &Query) -> (usize, Vec<String>) {
        let (_root, context, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        let page = read_page(c, request, context).unwrap();
        assert_eq!(page.total, page.items.len(), "fixture fits one page");
        (page.total, page.items.into_iter().map(|i| i.name).collect())
    }
    fn letters(c: &Connection, request: &Query) -> String {
        names(c, request)
            .1
            .iter()
            .map(|n| n.chars().next().unwrap())
            .collect()
    }

    /// File databases reuse the ordered list across pages; in-memory ones never
    /// do. Every page, anchor and later edit must read the same either way.
    #[test]
    fn cached_pages_match_uncached_pages_before_and_after_edits() {
        let root = tempfile::tempdir().unwrap();
        let file = fill(Connection::open(root.path().join("genx.sqlite3")).unwrap());
        let memory = database();
        let (_root, context, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        let pages = |c: &Connection| {
            let mut out = Vec::new();
            for sort in [Sort::Source, Sort::Name, Sort::Category, Sort::Country] {
                for (filter, hide_adult, favorites_first, text, country) in [
                    (Filter::All, false, false, "", None),
                    (Filter::All, true, true, "", None),
                    (Filter::Sports, false, false, "", None),
                    (Filter::All, false, false, "o", Some("UK")),
                    (Filter::Favorites, false, false, "", None),
                ] {
                    let mut request = query(country, hide_adult, sort, filter);
                    request.favorites_first = favorites_first;
                    request.query = text.into();
                    request.page_size = 2;
                    let first = read_page(c, &request, context.clone()).unwrap();
                    request.expected_media_revision = Some(first.media_revision);
                    request.expected_preferences_revision = Some(first.preferences_revision);
                    for start in 0..6 {
                        request.start_index = start;
                        request.anchor_id = None;
                        out.push(
                            serde_json::to_string(
                                &read_page(c, &request, context.clone()).unwrap(),
                            )
                            .unwrap(),
                        );
                    }
                    for letter in ['a', 'b', 'd', 'f', 'g', 'z'] {
                        request.start_index = 0;
                        request.anchor_id = Some(id(letter));
                        out.push(
                            read_page(c, &request, context.clone())
                                .map(|p| serde_json::to_string(&p).unwrap())
                                .unwrap_or_else(|e| e),
                        );
                    }
                }
            }
            out
        };
        let expected = pages(&memory);
        assert_eq!(pages(&file), expected);
        assert_eq!(pages(&file), expected);
        // A preference edit (favorite) changes the order; the cache must notice.
        for c in [&file, &memory] {
            c.execute(
                "INSERT INTO account_channel_preferences_v1 VALUES(?1,?2,1,0,NULL)",
                params![ACCOUNT, id('c')],
            )
            .unwrap();
            c.execute(
                "UPDATE account_preferences_meta_v1 SET revision=revision+1",
                [],
            )
            .unwrap();
        }
        let edited = pages(&memory);
        assert_ne!(edited, expected);
        assert_eq!(pages(&file), edited);
    }
    #[test]
    fn adult_switch_governs_every_listing() {
        let c = database();
        // Hidden: no adult rows in the list, the total, search or favorites.
        assert_eq!(
            letters(&c, &query(None, true, Sort::Source, Filter::All)),
            "ABC"
        );
        // Shown: all six live channels; the removed one never appears.
        assert_eq!(
            letters(&c, &query(None, false, Sort::Source, Filter::All)),
            "ABCDEF"
        );
        let mut search = query(None, true, Sort::Source, Filter::All);
        search.query = "night".into();
        assert_eq!(names(&c, &search).0, 0);
        search.hide_adult = false;
        assert_eq!(letters(&c, &search), "E");
        assert_eq!(
            letters(&c, &query(None, true, Sort::Source, Filter::Favorites)),
            "B"
        );
    }
    #[test]
    fn country_filter_matches_only_verified_countries() {
        let c = database();
        assert_eq!(
            letters(&c, &query(Some("UK"), false, Sort::Source, Filter::All)),
            "BE"
        );
        assert_eq!(
            letters(&c, &query(Some("UK"), true, Sort::Source, Filter::All)),
            "B"
        );
        assert_eq!(
            letters(&c, &query(Some("US"), true, Sort::Source, Filter::All)),
            "A"
        );
        // Unknown country: listed only under All countries and Unknown.
        assert_eq!(
            letters(&c, &query(Some(""), false, Sort::Source, Filter::All)),
            "CF"
        );
        assert_eq!(
            letters(&c, &query(Some(""), true, Sort::Source, Filter::All)),
            "C"
        );
        assert_eq!(
            letters(&c, &query(Some("FR"), false, Sort::Source, Filter::All)),
            ""
        );
        // Several countries at once (owner request: "USA, Canada and UK").
        assert_eq!(
            letters(&c, &query(Some("US,UK"), false, Sort::Source, Filter::All)),
            "ABDE"
        );
        assert_eq!(
            letters(&c, &query(Some("FR,UK"), true, Sort::Source, Filter::All)),
            "B"
        );
    }
    #[test]
    fn country_sort_is_by_name_with_unknown_last_and_anchors_rank_exactly() {
        let c = database();
        // United Kingdom < United States < unknown; then group, then name.
        assert_eq!(
            letters(&c, &query(None, false, Sort::Country, Filter::All)),
            "BEDAFC"
        );
        let mut anchored = query(None, false, Sort::Country, Filter::All);
        anchored.anchor_id = Some(id('a'));
        let (_root, context, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        let page = read_page(&c, &anchored, context).unwrap();
        assert_eq!(page.anchor_index, Some(3));
        assert_eq!(page.start_index, 2);
    }
    #[test]
    fn country_summary_counts_with_the_same_visibility() {
        let c = database();
        let summary = |hide_adult| {
            read_countries(
                &c,
                &CountryRequest {
                    schema_version: 1,
                    account_id: ACCOUNT.into(),
                    expected_account_revision: "1".into(),
                    hide_adult,
                },
            )
            .unwrap()
        };
        let hidden = summary(true);
        assert_eq!(hidden.total, 3);
        assert_eq!(
            hidden.countries,
            vec![
                CountryCount {
                    code: Some("UK".into()),
                    count: 1
                },
                CountryCount {
                    code: Some("US".into()),
                    count: 1
                },
                CountryCount {
                    code: None,
                    count: 1
                },
            ]
        );
        assert_eq!(summary(false).total, 6);
    }
    #[test]
    fn country_adult_and_search_combine() {
        let c = database();
        let mut request = query(Some("UK"), false, Sort::Source, Filter::All);
        request.query = "o".into(); // Bravo, Echo
        assert_eq!(letters(&c, &request), "BE");
        request.hide_adult = true;
        assert_eq!(letters(&c, &request), "B");
        request.query = "echo".into();
        assert_eq!(names(&c, &request).0, 0);
        let mut unknown = query(Some(""), false, Sort::Source, Filter::All);
        unknown.query = "fox".into();
        assert_eq!(letters(&c, &unknown), "F");
        // A group (category) choice narrows within the country.
        let mut group = query(Some("UK"), false, Sort::Source, Filter::All);
        group.category = Some("UK ➾ XXX".into());
        assert_eq!(letters(&c, &group), "E");
        group.hide_adult = true;
        assert_eq!(letters(&c, &group), "");
        // Clearing filters one at a time restores the wider result sets.
        group.category = None;
        assert_eq!(letters(&c, &group), "B");
        group.country = None;
        assert_eq!(letters(&c, &group), "ABC");
        group.hide_adult = false;
        assert_eq!(letters(&c, &group), "ABCDEF");
    }
    #[test]
    fn sports_include_league_and_singular_sport_groups() {
        let c = database();
        for (letter, name, group) in [
            ('1', "1pm Bears at Falcons", "US| NFL PPV"),
            ('2', "Sport One", "US| SPORT ᴴᴰ/ᴿᴬᵂ"),
            ('3', "Bulls", "US| NBA TEAM PPV"),
            ('4', "Evening News", "US| NEWS ᴴᴰ"),
            ('5', "Movie Night", "US| CINEMA"),
        ] {
            let reference = letter.to_string().repeat(32);
            c.execute(
                "INSERT INTO account_vault_references_v1 VALUES(?1,?2,1,'media')",
                params![reference, ACCOUNT],
            )
            .unwrap();
            c.execute(
                "INSERT INTO account_media_entry_v1 VALUES(?1,?2,?3,?4,NULL,NULL,?5,'page-1')",
                params![ACCOUNT, id(letter), name, group, reference],
            )
            .unwrap();
        }
        let (_, sports) = names(&c, &query(None, false, Sort::Source, Filter::Sports));
        assert!(sports.iter().any(|n| n == "Sport One"), "{sports:?}");
        assert!(!sports.iter().any(|n| n == "Evening News"
            || n == "Movie Night"
            || n == "1pm Bears at Falcons"
            || n == "Bulls"));
        let (_, ppv) = names(&c, &query(None, false, Sort::Source, Filter::Ppv));
        assert_eq!(ppv, ["1pm Bears at Falcons", "Bulls"]);
        c.execute(
            "INSERT INTO account_channel_preferences_v1 VALUES(?1,?2,1,0,'Sports')",
            params![ACCOUNT, id('1')],
        )
        .unwrap();
        let mut search = query(None, false, Sort::Source, Filter::All);
        search.query = "Bears".into();
        assert_eq!(names(&c, &search).0, 0);
        assert!(
            !names(&c, &query(None, false, Sort::Source, Filter::Favorites))
                .1
                .contains(&"1pm Bears at Falcons".to_owned())
        );
        search.filter = Filter::Ppv;
        assert_eq!(names(&c, &search).1, ["1pm Bears at Falcons"]);
        search.country = Some("UK".into());
        assert_eq!(names(&c, &search).0, 0);
    }
    #[test]
    fn country_sorted_pages_keep_totals_and_boundaries() {
        let c = database();
        // Two more channels whose country, group and name all tie: only the
        // channel ID orders them, as in production.
        for letter in ['1', '2'] {
            let reference = letter.to_string().repeat(32);
            c.execute(
                "INSERT INTO account_vault_references_v1 VALUES(?1,?2,1,'media')",
                params![reference, ACCOUNT],
            )
            .unwrap();
            c.execute(
                "INSERT INTO account_media_entry_v1 VALUES(?1,?2,'Hotel Twin','USA',NULL,NULL,?3,'page-1')",
                params![ACCOUNT, id(letter), reference],
            )
            .unwrap();
        }
        let mut ids = Vec::new();
        let mut seen = String::new();
        let mut start = 0;
        loop {
            let mut request = query(None, false, Sort::Country, Filter::All);
            request.page_size = 3;
            request.start_index = start;
            if start > 0 {
                request.expected_media_revision = Some("1".into());
                request.expected_preferences_revision = Some("1".into());
            }
            let (_root, context, _playback, _work, _requests) =
                crate::scan_manifest_work::bookmark_context_fixture();
            let page = read_page(&c, &request, context).unwrap();
            // The total never changes, including past the last page.
            assert_eq!(page.total, 8);
            let expected = 8usize.saturating_sub(start).min(3);
            assert_eq!(page.items.len(), expected, "page at {start}");
            if page.items.is_empty() {
                break;
            }
            seen.extend(page.items.iter().map(|i| i.name.chars().next().unwrap()));
            ids.extend(page.items.iter().map(|i| i.id.clone()));
            start += page.items.len();
        }
        // 3 + 3 + a final partial page of 2; no channel repeated or skipped.
        assert_eq!(seen, "BEDAHHFC");
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), 8);
        assert!(ids[4] < ids[5], "ties break by channel ID");
        // Every page concatenated equals the same query read in one page.
        let mut whole = query(None, false, Sort::Country, Filter::All);
        whole.page_size = 64;
        let (_root, context, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        let single: Vec<String> = read_page(&c, &whole, context)
            .unwrap()
            .items
            .into_iter()
            .map(|i| i.id)
            .collect();
        assert_eq!(ids, single);
        // Adult filtering and the country are applied before pagination.
        let mut filtered = query(Some("US"), true, Sort::Country, Filter::All);
        filtered.page_size = 2;
        let (_root, context, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        let page = read_page(&c, &filtered, context).unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.items.len(), 2);
        assert!(page.items.iter().all(|i| i.category == "USA"));
    }
    #[test]
    fn invalid_country_values_are_refused() {
        let c = database();
        for value in [
            "uk",
            "GBR",
            "U'",
            "' OR 1=1 --",
            "US,US",
            "US,",
            ",US",
            "US,uk",
            "US;UK",
            "US, UK",
        ] {
            let (_root, context, _playback, _work, _requests) =
                crate::scan_manifest_work::bookmark_context_fixture();
            let request = query(Some(value), false, Sort::Source, Filter::All);
            assert!(read_page(&c, &request, context).is_err(), "{value}");
        }
    }
    #[test]
    fn sports_explicit_facet_requires_nfl_evidence_for_paid_count_and_paging() {
        let c = database();
        for (letter, name, category) in [
            ('a', "NFL Network", "US | NFL"),
            ('b', "Conflict Channel", "US | American Football"),
            ('c', "NFLive PPV", "US | American Football | PPV"),
            ('d', "FOX Affiliate", "US | General"),
            ('e', "SailGP", "US | Sports"),
            ('f', "NFL Adult", "US | Adult | NFL"),
            ('g', "NFL Removed", "US | NFL"),
        ] {
            c.execute(
                "UPDATE account_media_entry_v1 SET name=?2,category=?3 WHERE channel_id=?1",
                params![id(letter), name, category],
            )
            .unwrap();
        }
        c.execute(
            "UPDATE account_media_entry_v1 SET epg_id='fox' WHERE channel_id=?1",
            [id('d')],
        )
        .unwrap();
        crate::account_guide::install(&c).unwrap();
        c.execute(
            "INSERT INTO account_guide_v1 VALUES(?1,1,1,1000,1,1,0)",
            [ACCOUNT],
        )
        .unwrap();
        c.execute("INSERT INTO account_guide_program_v1 VALUES(?1,'fox',1100,1200,0,'Cartoon hour',NULL,'[]'),(?1,'fox',2000,3000,1,'Chicago Bears at Detroit Lions PPV',NULL,'[]')", [ACCOUNT]).unwrap();
        let mut q = query(Some("US"), true, Sort::Source, Filter::Sports);
        q.query = "NFL".into();
        q.sports = Some(crate::catalog::sports::Scope {
            sport: Some("american-football".into()),
            league: None,
            include_ppv: true,
            window_start_ms: 1000,
            window_end_ms: 1000 + 7 * 86400000,
            vocabulary_version: serde_json::from_str::<serde_json::Value>(
                crate::catalog::sports::VOCABULARY,
            )
            .unwrap()["vocabularyVersion"]
                .as_str()
                .unwrap()
                .into(),
        });
        let read = |request: &Query| {
            let (_r, context, _p, _w, _requests) =
                crate::scan_manifest_work::bookmark_context_fixture();
            read_page(&c, request, context).unwrap()
        };
        let full = read(&q);
        assert_eq!(full.total, 2);
        assert_eq!(
            full.items
                .iter()
                .map(|row| row.id.clone())
                .collect::<Vec<_>>(),
            [id('a'), id('d')]
        );
        assert_eq!(
            full.items.iter().map(|row| row.ppv).collect::<Vec<_>>(),
            [false, true]
        );
        q.page_size = 1;
        let first = read(&q);
        assert_eq!(first.total, 2);
        assert_eq!(first.items[0].id, id('a'));
        q.start_index = 1;
        q.expected_media_revision = Some(first.media_revision);
        q.expected_preferences_revision = Some(first.preferences_revision);
        q.expected_guide_revision = first.guide_revision;
        let next = read(&q);
        assert_eq!(next.total, 2);
        assert_eq!(next.items[0].id, id('d'));
        q.start_index = 0;
        q.query = "Football".into();
        assert_eq!(read(&q).total, 4);
        q.query = "NFLive".into();
        assert_eq!(read(&q).items[0].id, id('c'));
        q.query = "NFL".into();
        q.sports.as_mut().unwrap().sport = None;
        assert_eq!(read(&q).total, 2);
    }

    #[test]
    fn sports_paid_list_uses_raw_overrides_cached_affiliates_and_ppv_before_count() {
        let c = database();
        let admitted_ids = |q: &Query| {
            let (_r, ctx, _p, _w, _requests) =
                crate::scan_manifest_work::bookmark_context_fixture();
            read_page(&c, q, ctx)
                .unwrap()
                .items
                .into_iter()
                .map(|i| i.id.chars().last().unwrap())
                .collect::<String>()
        };
        c.execute("UPDATE account_media_entry_v1 SET name='Event 1',category='US | NFL' WHERE channel_id=?1",[id('a')]).unwrap();
        c.execute(
            "INSERT INTO account_channel_preferences_v1 VALUES(?1,?2,0,0,'US | Sports')",
            params![ACCOUNT, id('a')],
        )
        .unwrap();
        c.execute("UPDATE account_media_entry_v1 SET name='Chicago Bears PPV',category='US | PPV' WHERE channel_id=?1",[id('b')]).unwrap();
        c.execute("UPDATE account_media_entry_v1 SET name='NFLive PPV',category='US | PPV' WHERE channel_id=?1",[id('c')]).unwrap();
        c.execute("UPDATE account_media_entry_v1 SET name='FOX 43',category='US | Locals',epg_id='fox' WHERE channel_id=?1",[id('d')]).unwrap();
        crate::account_guide::install(&c).unwrap();
        c.execute(
            "INSERT INTO account_guide_v1 VALUES(?1,1,1,1000,1,1,0)",
            [ACCOUNT],
        )
        .unwrap();
        c.execute("INSERT INTO account_guide_program_v1 VALUES(?1,'fox',1200,1800,0,'Chicago Bears at Detroit Lions',NULL,'[]')",[ACCOUNT]).unwrap();
        let mut q = query(Some("US"), false, Sort::Source, Filter::All);
        q.query = "NFL".into();
        assert_eq!(admitted_ids(&q), "a");
        q.sports = Some(crate::catalog::sports::Scope {
            sport: None,
            league: None,
            include_ppv: true,
            window_start_ms: 1000,
            window_end_ms: 1000 + 7 * 86400000,
            vocabulary_version: serde_json::from_str::<serde_json::Value>(
                crate::catalog::sports::VOCABULARY,
            )
            .unwrap()["vocabularyVersion"]
                .as_str()
                .unwrap()
                .into(),
        });
        assert_eq!(admitted_ids(&q), "abd");
        q.filter = Filter::Sports;
        assert_eq!(admitted_ids(&q), "abd");
        q.query = "football".into();
        q.sports.as_mut().unwrap().include_ppv = false;
        assert_eq!(admitted_ids(&q), "ad");
        q.query = "NFL".into();
        q.sports.as_mut().unwrap().include_ppv = true;
        q.page_size = 1;
        let (_root, ctx, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        let first = read_page(&c, &q, ctx).unwrap();
        assert_eq!(first.total, 3);
        assert_eq!(first.items[0].id, id('a'));
        q.start_index = 1;
        q.expected_media_revision = Some(first.media_revision);
        q.expected_preferences_revision = Some(first.preferences_revision);
        q.expected_guide_revision = first.guide_revision;
        let expected = q.expected_guide_revision.take();
        let (_r, ctx, _p, _w, _requests) = crate::scan_manifest_work::bookmark_context_fixture();
        assert_eq!(
            read_page(&c, &q, ctx).err().unwrap(),
            "account-guide-revision-conflict"
        );
        q.expected_guide_revision = Some("00".into());
        let (_r, ctx, _p, _w, _requests) = crate::scan_manifest_work::bookmark_context_fixture();
        assert_eq!(
            read_page(&c, &q, ctx).err().unwrap(),
            "account-guide-revision-invalid"
        );
        q.expected_guide_revision = expected;
        let scope = q.sports.take();
        let (_r, ctx, _p, _w, _requests) = crate::scan_manifest_work::bookmark_context_fixture();
        assert_eq!(
            read_page(&c, &q, ctx).err().unwrap(),
            "account-guide-revision-invalid"
        );
        q.sports = scope;
        c.execute(
            "UPDATE account_guide_v1 SET revision=2 WHERE account_id=?1",
            [ACCOUNT],
        )
        .unwrap();
        let (_r, ctx, _p, _w, _requests) = crate::scan_manifest_work::bookmark_context_fixture();
        assert_eq!(
            read_page(&c, &q, ctx).err().unwrap(),
            "account-guide-revision-conflict"
        );
        c.execute(
            "UPDATE account_guide_v1 SET revision=1 WHERE account_id=?1",
            [ACCOUNT],
        )
        .unwrap();
        let (_root, ctx, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        assert_eq!(read_page(&c, &q, ctx).unwrap().items[0].id, id('b'));
        q.start_index = 0;
        q.anchor_id = Some(id('d'));
        q.page_size = 64;
        assert_eq!(admitted_ids(&q), "bd");
        q.filter = Filter::All;
        q.query = "fox".into();
        q.sports.as_mut().unwrap().include_ppv = false;
        assert_eq!(admitted_ids(&q), "d", "EPG literal remains searchable");
        c.execute(
            "UPDATE account_media_entry_v1 SET provider_id='fixture.provider' WHERE channel_id=?1",
            [id('d')],
        )
        .unwrap();
        q.query = "fixture.provider".into();
        assert_eq!(admitted_ids(&q), "d", "provider literal remains searchable");
    }

    #[test]
    fn watched_history_scopes_recency_counts_visibility_and_live_authority() {
        let c = database();
        c.execute(
            "UPDATE account_media_entry_v1 SET category='UK Sports PPV' WHERE channel_id=?1",
            [id('b')],
        )
        .unwrap();
        c.execute(
            "INSERT INTO account_channel_preferences_v1 VALUES(?1,?2,0,0,'News')",
            params![ACCOUNT, id('d')],
        )
        .unwrap();
        let mut q = query(None, false, Sort::Name, Filter::Watched);
        q.favorites_first = true;
        q.history_ids = Some(vec![id('b'), id('d'), id('a'), id('c')]);
        assert_eq!(letters(&c, &q), "BDAC");
        q.hide_adult = true;
        assert_eq!(letters(&c, &q), "BAC");
        q.country = Some("UK".into());
        assert_eq!(letters(&c, &q), "B");
        q.country = None;
        q.page_size = 1;
        let read = |q: &Query| {
            let (_r, ctx, _p, _w, _requests) =
                crate::scan_manifest_work::bookmark_context_fixture();
            read_page(&c, q, ctx)
        };
        let first = read(&q).unwrap();
        assert_eq!(first.total, 3);
        assert_eq!(first.items[0].id, id('b'));
        assert!(first.items[0].ppv);
        q.expected_media_revision = Some(first.media_revision);
        q.expected_preferences_revision = Some(first.preferences_revision);
        q.start_index = 1;
        assert_eq!(read(&q).unwrap().items[0].id, id('a'));
        q.start_index = 0;
        q.history_ids.as_mut().unwrap().swap(0, 2);
        assert_eq!(read(&q).unwrap().items[0].id, id('a'));
        q.history_ids = Some(vec![]);
        assert_eq!(read(&q).unwrap().total, 0);
        q.history_ids = Some(vec![format!(
            "account-{}-{}",
            "f".repeat(32),
            "a".repeat(64)
        )]);
        assert!(read(&q).is_err());
        q.history_ids = Some(vec![id('a')]);
        c.execute(
            "DELETE FROM account_vault_references_v1 WHERE reference=?1",
            ["a".repeat(32)],
        )
        .unwrap();
        assert_eq!(
            read(&q).unwrap().total,
            0,
            "History cannot revive a revoked reference"
        );
        q.filter = Filter::All;
        assert!(read(&q).is_err());
        q.history_ids = None;
        q.page_size = 64;
        assert!(
            !letters(&c, &q).contains('B'),
            "normal All still excludes PPV"
        );
    }

    #[test]
    fn watched_history_paid_programme_search_is_scoped_before_ppv_admission() {
        let c = database();
        crate::account_guide::install(&c).unwrap();
        c.execute(
            "INSERT INTO account_guide_v1 VALUES(?1,1,1,1000,1,1,0)",
            [ACCOUNT],
        )
        .unwrap();
        for letter in ['a', 'b'] {
            c.execute("UPDATE account_media_entry_v1 SET epg_id='shared',category='News' WHERE channel_id=?1",[id(letter)]).unwrap();
        }
        c.execute("INSERT INTO account_guide_program_v1 VALUES(?1,'shared',1200,1800,0,'Boxing PPV final',NULL,'[]')",[ACCOUNT]).unwrap();
        let mut q = query(None, false, Sort::Source, Filter::All);
        q.query = "Boxing".into();
        q.sports = Some(crate::catalog::sports::Scope {
            sport: None,
            league: None,
            include_ppv: false,
            window_start_ms: 1000,
            window_end_ms: 3000,
            vocabulary_version: serde_json::from_str::<serde_json::Value>(
                crate::catalog::sports::VOCABULARY,
            )
            .unwrap()["vocabularyVersion"]
                .as_str()
                .unwrap()
                .into(),
        });
        assert_eq!(letters(&c, &q), "");
        q.filter = Filter::Watched;
        q.history_ids = Some(vec![id('b')]);
        assert_eq!(letters(&c, &q), "B");
        q.history_ids = Some(vec![id('a')]);
        assert_eq!(letters(&c, &q), "A");
    }

    #[test]
    fn watched_history_paid_adult_policy_folds_all_legacy_terms_in_both_categories() {
        let c = database();
        let mut q = query(None, true, Sort::Source, Filter::Watched);
        q.history_ids = Some(vec![id('a')]);
        c.execute(
            "INSERT INTO account_channel_preferences_v1 VALUES(?1,?2,0,0,'News')",
            params![ACCOUNT, id('a')],
        )
        .unwrap();
        for category in ["ＡＤＵＬＴ", "ＰＯＲＮ", "１８＋", "ＸＸＸ", "🔞"] {
            for original in [true, false] {
                let (raw, effective) = if original {
                    (category, "News")
                } else {
                    ("News", category)
                };
                c.execute(
                    "UPDATE account_media_entry_v1 SET category=?1 WHERE channel_id=?2",
                    params![raw, id('a')],
                )
                .unwrap();
                c.execute("UPDATE account_channel_preferences_v1 SET category=?1 WHERE account_id=?2 AND channel_id=?3",params![effective,ACCOUNT,id('a')]).unwrap();
                assert_eq!(
                    letters(&c, &q),
                    "",
                    "History must retain the full folded adult policy across overrides"
                );
                q.hide_adult = false;
                assert_eq!(letters(&c, &q), "A");
                q.hide_adult = true;
            }
        }
    }
}
