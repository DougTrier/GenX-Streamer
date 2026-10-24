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
fn fixture() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,catalog_revision INTEGER);INSERT INTO metadata VALUES(1,7);CREATE TABLE channel(id TEXT PRIMARY KEY,source_id TEXT,provider_id TEXT,name TEXT,category TEXT,ordinal INTEGER,country TEXT,region TEXT,state TEXT,geography_provenance TEXT);CREATE INDEX channel_geography ON channel(country,region,state);CREATE TABLE favorite(id TEXT PRIMARY KEY);CREATE TABLE removed(id TEXT PRIMARY KEY);").unwrap();
    let tx = c.transaction().unwrap();
    install_projection(&tx).unwrap();
    tx.commit().unwrap();
    c
}
fn add(
    c: &Connection,
    id: &str,
    name: &str,
    category: &str,
    provider: Option<&str>,
    geo: [Option<&str>; 3],
) {
    let ordinal: i64 = c
        .query_row("SELECT count(*) FROM channel", [], |r| r.get(0))
        .unwrap();
    c.execute(
        "INSERT INTO channel VALUES(?1,'s',?2,?3,?4,?5,?6,?7,?8,NULL)",
        params![id, provider, name, category, ordinal, geo[0], geo[1], geo[2]],
    )
    .unwrap();
}
fn refresh(c: &mut Connection) {
    let tx = c.transaction().unwrap();
    rebuild_projection(&tx).unwrap();
    tx.commit().unwrap();
}
fn query(text: &str) -> Query {
    Query {
        schema_version: 1,
        request_id: "fixture-request".into(),
        expected_catalog_revision: None,
        expected_view_revision: None,
        query: text.into(),
        filter: Filter::All,
        geography: Map::new(),
        sort: Sort::Source,
        favorites_first: false,
        hide_adult: false,
        after: None,
        start_index: None,
        anchor_id: None,
        page_size: 50,
    }
}
fn run(c: &Connection, q: &Query) -> Page {
    query_page(c, q, &Arc::new(AtomicBool::new(false))).unwrap()
}
fn ids(page: &Page) -> Vec<&str> {
    page.rows.iter().map(|r| r.id.as_str()).collect()
}
#[test]
fn not_responding_filter_lists_only_channels_failed_on_two_days() {
    let mut c = fixture();
    for id in ["alive", "dead", "once"] {
        add(&c, id, id, "News", None, [None, None, None]);
    }
    refresh(&mut c);
    let mut q = query("");
    q.filter = Filter::Unresponsive;
    assert!(ids(&run(&c, &q)).is_empty(), "no checks recorded yet");
    let hour = 3_600_000;
    for (at, batch) in [
        (
            0,
            vec![
                ("alive", "Reachable"),
                ("dead", "TimedOut"),
                ("once", "TimedOut"),
            ],
        ),
        (
            21 * hour,
            vec![("alive", "Reachable"), ("dead", "AccessDenied")],
        ),
    ] {
        let tx = c.transaction().unwrap();
        let request = crate::storage_transaction::channel_check::Record {
            schema_version: 1,
            observations: batch
                .into_iter()
                .map(
                    |(id, verdict)| crate::storage_transaction::channel_check::Observation {
                        channel_id: id.into(),
                        verdict: verdict.into(),
                    },
                )
                .collect(),
        };
        crate::storage_transaction::channel_check::record(&tx, &request, at).unwrap();
        tx.commit().unwrap();
    }
    let page = run(&c, &q);
    assert_eq!(ids(&page), vec!["dead"]);
    assert_eq!(page.total_count, 1);
}
#[test]
fn literal_short_unicode_alias_network_and_published_location_matching() {
    let mut c = fixture();
    add(
        &c,
        "local",
        "ＷＭＡＱ οΣ İ %_𐐀",
        "News",
        Some("WMAQ.us@HD"),
        [Some("US"), None, Some("US-IL")],
    );
    add(
        &c,
        "fox",
        "Local station",
        "Sports",
        Some("Fox.us@SD"),
        [None, None, None],
    );
    add(
        &c,
        "opaque",
        "Other",
        "Animation",
        Some("privateFox.us@HD"),
        [None, None, None],
    );
    add(&c, "kids", "Junior", "Children", None, [None, None, None]);
    refresh(&mut c);
    for text in [
        "wmaq",
        "ος",
        "i\u{307}",
        "%_",
        "𐐨",
        "illinois",
        "us-il",
        "united states",
        "wmaq.us@hd",
    ] {
        assert_eq!(ids(&run(&c, &query(text))), vec!["local"], "{text}");
    }
    assert_eq!(ids(&run(&c, &query("fox"))), vec!["fox"]);
    assert_eq!(ids(&run(&c, &query("cartoons"))), vec!["opaque"]);
    assert_eq!(ids(&run(&c, &query("kids"))), vec!["kids"]);
    assert!(run(&c, &query("privatefox")).rows.is_empty());
    assert!(run(&c, &query("chicago")).rows.is_empty());
    let mut q = query("");
    q.geography.insert("country".into(), Value::Null);
    assert_eq!(ids(&run(&c, &q)), vec!["fox", "opaque", "kids"]);
    q.geography
        .insert("country".into(), Value::String("US".into()));
    q.filter = Filter::Sports;
    assert!(run(&c, &q).rows.is_empty());
    assert_eq!(fold("ΟΣ ΟΣΑ"), "ος οσα"); // Rust's contextual final sigma, not per-char lowercase.
    assert_eq!(fold("I İ ı i"), "i i\u{307} ı i"); // Locale-independent JS lowercasing.
}
#[test]
fn several_countries_combine_and_bad_lists_are_refused() {
    let mut c = fixture();
    for (id, country) in [("us", "US"), ("ca", "CA"), ("uk", "UK"), ("fr", "FR")] {
        add(&c, id, id, "News", None, [Some(country), None, None]);
    }
    add(&c, "none", "none", "News", None, [None, None, None]);
    refresh(&mut c);
    let mut q = query("");
    q.geography.insert(
        "countries".into(),
        Value::Array(["US", "CA", "UK"].map(|v| Value::String(v.into())).to_vec()),
    );
    let page = run(&c, &q);
    let mut found = ids(&page);
    found.sort();
    assert_eq!(found, vec!["ca", "uk", "us"]);
    let stop = Arc::new(AtomicBool::new(false));
    for bad in [
        Value::Array(vec![Value::String("US".into())]),
        Value::Array(vec![Value::String("US".into()), Value::String("US".into())]),
        Value::Array(vec![Value::String("US".into()), Value::String("u'".into())]),
        Value::Array(vec![Value::String("US".into()), Value::Null]),
        Value::String("US,CA".into()),
    ] {
        let mut q = query("");
        q.geography.insert("countries".into(), bad.clone());
        assert_eq!(
            query_page(&c, &q, &stop).unwrap_err(),
            "catalog-query-invalid-geography",
            "{bad}"
        );
    }
    // A list stands alone: no country, region or state beside it.
    q.geography
        .insert("region".into(), Value::String("NORAM".into()));
    assert_eq!(
        query_page(&c, &q, &stop).unwrap_err(),
        "catalog-query-invalid-geography"
    );
}
#[test]
fn finite_cursor_binds_snapshot_filters_and_true_utf16_order() {
    let mut c = fixture();
    for (id, name) in [("bmp", "\u{e000}"), ("smp", "𐀀"), ("first", "A")] {
        add(&c, id, name, "News", None, [None, None, None]);
    }
    refresh(&mut c);
    let mut q = query("");
    q.sort = Sort::Name;
    q.page_size = 1;
    let first = run(&c, &q);
    assert_eq!(ids(&first), vec!["first"]);
    assert_eq!(first.total_count, 3);
    q.expected_catalog_revision = Some(first.catalog_revision.clone());
    q.expected_view_revision = Some(first.view_revision.clone());
    q.after = first.after;
    let second = run(&c, &q);
    assert_eq!(ids(&second), vec!["smp"]);
    q.after = second.after;
    assert_eq!(ids(&run(&c, &q)), vec!["bmp"]);
    q.filter = Filter::Favorites;
    assert_eq!(
        query_page(&c, &q, &Arc::new(AtomicBool::new(false))).unwrap_err(),
        "catalog-query-cursor-stale"
    );
    q.filter = Filter::All;
    c.execute("UPDATE catalog_projection_meta SET view_revision=1", [])
        .unwrap();
    assert_eq!(
        query_page(&c, &q, &Arc::new(AtomicBool::new(false))).unwrap_err(),
        "catalog-view-revision-stale"
    );
}
#[test]
fn unchanged_projection_reuses_postings_and_removal_update_rolls_back_atomically() {
    let mut c = fixture();
    for i in 0..100 {
        add(
            &c,
            &format!("c{i}"),
            &format!("News {i}"),
            "News",
            None,
            [None, None, None],
        );
    }
    refresh(&mut c);
    let changes = c.total_changes();
    refresh(&mut c);
    assert_eq!(
        c.total_changes() - changes,
        0,
        "unchanged projection and query version cause no DML"
    );
    assert_eq!(
        c.query_row(
            "SELECT query_version FROM catalog_projection_meta WHERE singleton=1",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        labels().version
    );
    {
        let tx = c.transaction().unwrap();
        tx.execute("DELETE FROM channel WHERE id='c0'", []).unwrap();
        rebuild_projection(&tx).unwrap();
        assert_eq!(
            query_page(&tx, &query("News"), &Arc::new(AtomicBool::new(false))).unwrap_err(),
            "catalog-query-database-failed",
            "nested read transactions refused"
        );
        // Dropping an uncommitted mutation restores both canonical and index state.
    }
    assert_eq!(run(&c, &query("News 0")).rows.len(), 1);
    c.execute("UPDATE channel SET name='Changed' WHERE id='c0'", [])
        .unwrap();
    c.execute("DELETE FROM channel WHERE id IN('c1','c2','c3')", [])
        .unwrap();
    refresh(&mut c);
    assert!(run(&c, &query("News 0")).rows.is_empty());
    assert_eq!(ids(&run(&c, &query("Changed"))), vec!["c0"]);
    assert_eq!(run(&c, &query("")).total_count, 97);
}
#[test]
fn favorite_and_removed_are_sql_owned_and_orphan_preferences_are_preserved() {
    let mut c = fixture();
    add(&c, "one", "One", "News", None, [None, None, None]);
    add(&c, "two", "Two", "Sports", None, [None, None, None]);
    refresh(&mut c);
    c.execute_batch("INSERT INTO favorite VALUES('one');INSERT INTO favorite VALUES('missing');INSERT INTO removed VALUES('two');")
            .unwrap();
    let mut q = query("");
    q.filter = Filter::Favorites;
    let page = run(&c, &q);
    assert_eq!(ids(&page), vec!["one"]);
    assert!(page.rows[0].favorite);
    let wire = serde_json::to_string(&page).unwrap();
    assert!(!wire.contains("urls") && !wire.contains("fixture.invalid"));
    assert_eq!(run(&c, &query("")).total_count, 1);
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM favorite WHERE id='missing'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
#[test]
fn byte_limited_pages_reach_every_admitted_large_row_without_truncation() {
    let mut c = fixture();
    for i in 0..50 {
        add(
            &c,
            &format!("c{i}"),
            &"Z".repeat(16000),
            &"N".repeat(16000),
            None,
            [None, None, None],
        );
    }
    refresh(&mut c);
    let mut q = query("");
    let mut all = Vec::new();
    loop {
        let page = run(&c, &q);
        assert!(serde_json::to_vec(&page).unwrap().len() <= RESPONSE_LIMIT);
        assert_eq!(page.total_count, 50);
        assert!(!page.rows.is_empty());
        all.extend(page.rows.iter().map(|r| r.id.clone()));
        q.expected_catalog_revision = Some(page.catalog_revision);
        q.expected_view_revision = Some(page.view_revision);
        q.after = page.after;
        if q.after.is_none() {
            break;
        }
    }
    assert_eq!(all, (0..50).map(|i| format!("c{i}")).collect::<Vec<_>>());
}
#[test]
fn actual_vm_cancellation_settles_and_unregisters_progress_before_next_read() {
    let mut c = fixture();
    for i in 0..2000 {
        add(
            &c,
            &format!("c{i}"),
            "Common News",
            "News",
            None,
            [None, None, None],
        );
    }
    refresh(&mut c);
    let cancel = Arc::new(AtomicBool::new(false));
    let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let flag = Arc::clone(&cancel);
    let count = Arc::clone(&seen);
    let hook = Arc::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
        flag.store(true, Ordering::SeqCst);
    });
    assert_eq!(
        query_page_inner(&c, &query("News"), &cancel, None, Some(hook)).unwrap_err(),
        "catalog-query-cancelled"
    );
    assert!(seen.load(Ordering::SeqCst) > 0);
    assert_eq!(run(&c, &query("News")).total_count, 2000);
    assert_eq!(
        c.query_row("SELECT count(*) FROM channel", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2000
    );
}
#[test]
fn projection_disk_full_rolls_back_canonical_and_index_together() {
    let mut c = fixture();
    add(&c, "one", "Original", "News", None, [None, None, None]);
    refresh(&mut c);
    let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    c.pragma_update(None, "max_page_count", pages + 2).unwrap();
    {
        let tx = c.transaction().unwrap();
        tx.execute(
            "UPDATE channel SET name=?1 WHERE id='one'",
            ["\u{fdfa}".repeat(1000)],
        )
        .unwrap();
        assert!(
            rebuild_projection(&tx).is_err(),
            "normalization expansion must refuse rather than truncate or retain a partial index"
        );
    }
    assert_eq!(ids(&run(&c, &query("Original"))), vec!["one"]);
    assert_eq!(
        c.query_row("SELECT name FROM channel WHERE id='one'", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "Original"
    );
}
#[test]
fn direct_windows_and_anchor_rank_are_filtered_revision_scoped_and_bounded() {
    let mut c = fixture();
    for i in 0..101 {
        add(
            &c,
            &format!("c{i}"),
            &format!("Name{i:03}"),
            if i % 2 == 0 { "News" } else { "Sports" },
            None,
            [None, None, None],
        );
    }
    refresh(&mut c);
    let mut q = query("");
    q.start_index = Some(99);
    let page = run(&c, &q);
    assert_eq!(page.start_index, 99);
    assert_eq!(page.total_count, 101);
    assert_eq!(ids(&page), vec!["c99", "c100"]);
    q.start_index = Some(100000);
    let empty = run(&c, &q);
    assert_eq!(empty.start_index, 101);
    assert!(empty.rows.is_empty());
    q.start_index = None;
    q.anchor_id = Some("c50".into());
    q.page_size = 3;
    let anchor = run(&c, &q);
    assert_eq!(anchor.anchor_index, Some(50));
    assert_eq!(anchor.start_index, 49);
    assert_eq!(ids(&anchor), vec!["c49", "c50", "c51"]);
    q.filter = Filter::Sports;
    let missing = run(&c, &q);
    assert_eq!(missing.anchor_index, None);
    assert_eq!(missing.start_index, 0);
    assert_eq!(ids(&missing), vec!["c1", "c3", "c5"]);
    q.anchor_id = Some("c51".into());
    let filtered = run(&c, &q);
    assert_eq!(filtered.anchor_index, Some(25));
    assert_eq!(filtered.start_index, 24);
    assert_eq!(ids(&filtered), vec!["c49", "c51", "c53"]);
    q.start_index = Some(0);
    assert_eq!(
        query_page(&c, &q, &Arc::new(AtomicBool::new(false))).unwrap_err(),
        "catalog-query-invalid"
    );
    q.start_index = None;
    q.expected_catalog_revision = Some("6".into());
    assert_eq!(
        query_page(&c, &q, &Arc::new(AtomicBool::new(false))).unwrap_err(),
        "catalog-revision-stale"
    );
}
fn favorites_fixture() -> Connection {
    let mut c = fixture();
    for (id, name, country) in [
        ("n0", "Z News", "GB"),
        ("n1", "A News", "CA"),
        ("n2", "Y News", "AU"),
        ("n3", "B News", "US"),
    ] {
        add(&c, id, name, "News", None, [Some(country), None, None]);
    }
    c.execute_batch("INSERT INTO favorite VALUES('n0');INSERT INTO favorite VALUES('n3');INSERT INTO favorite VALUES('orphan');")
            .unwrap();
    refresh(&mut c);
    c
}
/// Slow channels sort after fast ones (owner design, October 21, 2026),
/// within favorites-first; a badge change advances the view revision, so a
/// cursor from before it is refused rather than read in the new order.
#[test]
fn slow_channels_sort_after_fast_and_badge_changes_refuse_old_cursors() {
    use crate::storage_transaction::channel_check;
    let mut c = favorites_fixture();
    let before = run(&c, &query(""));
    let tx = c.transaction().unwrap();
    assert_eq!(
        channel_check::mark_slow(&tx, &["n0".into(), "n1".into()], 1).unwrap(),
        2
    );
    // Marking again changes nothing and does not move the revision.
    assert_eq!(channel_check::mark_slow(&tx, &["n0".into()], 2).unwrap(), 0);
    tx.commit().unwrap();
    let after = run(&c, &query(""));
    assert_eq!(
        after.view_revision.parse::<i64>().unwrap(),
        before.view_revision.parse::<i64>().unwrap() + 1
    );
    for sort in [Sort::Source, Sort::Name, Sort::Geography] {
        let mut q = query("");
        q.sort = sort;
        let plain = run(&c, &q);
        // Fast first, each part in the chosen order.
        let fast: Vec<&str> = ids(&plain)
            .into_iter()
            .filter(|id| !["n0", "n1"].contains(id))
            .collect();
        assert_eq!(&ids(&plain)[..2], fast.as_slice());
        q.favorites_first = true;
        let prioritized = run(&c, &q);
        assert_eq!(
            prioritized
                .rows
                .iter()
                .map(|r| r.favorite)
                .collect::<Vec<_>>(),
            [true, true, false, false]
        );
        assert_eq!(ids(&prioritized)[0], "n3", "the fast favorite first");
        assert_eq!(ids(&prioritized)[1], "n0", "then the slow favorite");
        assert_eq!(ids(&prioritized)[3], "n1", "the slow one last");
    }
    assert_eq!(ids(&run(&c, &query(""))), vec!["n2", "n3", "n0", "n1"]);
    // A cursor taken before a badge change is refused after it.
    let mut q = query("");
    q.page_size = 2;
    let first = run(&c, &q);
    q.expected_catalog_revision = Some(first.catalog_revision.clone());
    q.expected_view_revision = Some(first.view_revision.clone());
    q.after = first.after;
    assert_eq!(ids(&run(&c, &q)), vec!["n0", "n1"]);
    let tx = c.transaction().unwrap();
    assert_eq!(
        channel_check::record_start(&tx, "n1", 1_000, 3).unwrap(),
        Some(false)
    );
    tx.commit().unwrap();
    assert_eq!(
        query_page(&c, &q, &Arc::new(AtomicBool::new(false))).unwrap_err(),
        "catalog-view-revision-stale"
    );
    // A start between 3 and 5 s changes nothing, so the revision stays.
    let current = run(&c, &query("")).view_revision;
    let tx = c.transaction().unwrap();
    assert_eq!(
        channel_check::record_start(&tx, "n0", 4_000, 4).unwrap(),
        Some(true)
    );
    tx.commit().unwrap();
    assert_eq!(run(&c, &query("")).view_revision, current);
    assert_eq!(ids(&run(&c, &query(""))), vec!["n1", "n2", "n3", "n0"]);
    // With no Slow channel left, the order is the original one again.
    let tx = c.transaction().unwrap();
    channel_check::record_start(&tx, "n0", 1_000, 5).unwrap();
    tx.commit().unwrap();
    assert_eq!(ids(&run(&c, &query(""))), ids(&before));
}
#[test]
fn favorites_first_is_opt_in_and_keeps_stable_ties_for_every_sort() {
    let c = favorites_fixture();
    for sort in [Sort::Source, Sort::Name, Sort::Geography] {
        let mut q = query("");
        q.sort = sort;
        let default = run(&c, &q);
        q.favorites_first = true;
        let prioritized = run(&c, &q);
        let expected: Vec<&str> = default
            .rows
            .iter()
            .filter(|row| row.favorite)
            .chain(default.rows.iter().filter(|row| !row.favorite))
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(ids(&prioritized), expected);
        assert!(prioritized.rows[0].favorite && prioritized.rows[1].favorite);
        assert!(!prioritized.rows[2].favorite && !prioritized.rows[3].favorite);
        q.favorites_first = false;
        assert_eq!(ids(&run(&c, &q)), ids(&default));
    }
    assert_eq!(ids(&run(&c, &query(""))), vec!["n0", "n1", "n2", "n3"]);
    let mut old = serde_json::to_value(query("")).unwrap();
    old.as_object_mut().unwrap().remove("favoritesFirst");
    assert!(
        !serde_json::from_value::<Query>(old.clone())
            .unwrap()
            .favorites_first
    );
    old["favoritesFirst"] = Value::Null;
    assert!(serde_json::from_value::<Query>(old).is_err());
}
#[test]
fn favorites_first_cursor_window_and_anchor_share_the_same_binary_order() {
    let c = favorites_fixture();
    for sort in [Sort::Source, Sort::Name, Sort::Geography] {
        let mut q = query("");
        q.sort = sort;
        q.favorites_first = true;
        let full = run(&c, &q);
        let expected: Vec<String> = full.rows.iter().map(|row| row.id.clone()).collect();
        q.page_size = 1;
        let mut observed = Vec::new();
        loop {
            let page = run(&c, &q);
            observed.extend(page.rows.iter().map(|row| row.id.clone()));
            if let Some(cursor) = page.after {
                q.expected_catalog_revision = Some(cursor.catalog_revision.clone());
                q.expected_view_revision = Some(cursor.view_revision.clone());
                q.after = Some(cursor);
            } else {
                break;
            }
        }
        assert_eq!(observed, expected);
        q.after = None;
        q.start_index = Some(2);
        q.page_size = 2;
        let window = run(&c, &q);
        assert_eq!(window.start_index, 2);
        assert_eq!(
            ids(&window),
            expected[2..].iter().map(String::as_str).collect::<Vec<_>>()
        );
        q.start_index = None;
        q.anchor_id = Some(expected[3].clone());
        let anchor = run(&c, &q);
        assert_eq!(anchor.anchor_index, Some(3));
        assert_eq!(anchor.start_index, 2);
        assert_eq!(ids(&anchor), ids(&window));
    }
}
#[test]
fn favorites_first_scope_and_membership_changes_refuse_old_cursors() {
    let mut c = favorites_fixture();
    let mut q = query("");
    q.favorites_first = true;
    q.page_size = 1;
    let cursor = run(&c, &q).after.unwrap();
    q.expected_catalog_revision = Some(cursor.catalog_revision.clone());
    q.expected_view_revision = Some(cursor.view_revision.clone());
    q.after = Some(cursor.clone());
    q.favorites_first = false;
    assert_eq!(
        query_page(&c, &q, &Arc::new(AtomicBool::new(false))).unwrap_err(),
        "catalog-query-cursor-stale"
    );
    q.favorites_first = true;
    let tx = c.transaction().unwrap();
    tx.execute("DELETE FROM favorite WHERE id='n0'", [])
        .unwrap();
    tx.execute("INSERT INTO favorite VALUES('n2')", []).unwrap();
    advance_view_revision(&tx, true).unwrap();
    tx.commit().unwrap();
    assert_eq!(
        query_page(&c, &q, &Arc::new(AtomicBool::new(false))).unwrap_err(),
        "catalog-view-revision-stale"
    );
    let mut fresh = query("");
    fresh.favorites_first = true;
    fresh.page_size = 1;
    let new_cursor = run(&c, &fresh).after.unwrap();
    assert_ne!(cursor.query_key, new_cursor.query_key);
    assert_eq!(cursor.catalog_revision, new_cursor.catalog_revision);
}
#[test]
fn favorites_first_intersects_search_country_and_removed_scope_without_inference() {
    let c = favorites_fixture();
    let mut q = query("News");
    q.favorites_first = true;
    q.filter = Filter::Favorites;
    q.geography
        .insert("country".into(), Value::String("US".into()));
    assert_eq!(ids(&run(&c, &q)), vec!["n3"]);
    q.query = "Z News".into();
    assert_eq!(run(&c, &q).total_count, 0);
    q.geography.clear();
    assert_eq!(ids(&run(&c, &q)), vec!["n0"]);
    c.execute("INSERT INTO removed VALUES('n0')", []).unwrap();
    assert_eq!(run(&c, &q).total_count, 0);
    q.query = "News".into();
    q.filter = Filter::All;
    let page = run(&c, &q);
    assert_eq!(page.rows[0].id, "n3");
    assert_eq!(page.rows.len(), 3);
}
