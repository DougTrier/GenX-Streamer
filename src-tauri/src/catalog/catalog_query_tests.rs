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
        expected_guide_revision: None,
        sports: None,
        query: text.into(),
        filter: Filter::All,
        history_ids: None,
        geography: Map::new(),
        sort: Sort::Source,
        favorites_first: false,
        favorites_only: false,
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
fn ppv_filter_is_explicit_even_for_search_favorites_and_category_overrides() {
    let mut c = fixture();
    c.execute_batch(
        "CREATE TABLE channel_category_override(channel_id TEXT PRIMARY KEY,category TEXT)",
    )
    .unwrap();
    add(
        &c,
        "ppv",
        "Boxing Night",
        "Sports | PPV01",
        None,
        [Some("US"), None, None],
    );
    add(
        &c,
        "ordinary",
        "UFC Countdown",
        "Sports",
        None,
        [Some("US"), None, None],
    );
    add(
        &c,
        "false-positive",
        "PPVision",
        "News",
        None,
        [Some("CA"), None, None],
    );
    add(
        &c,
        "movie",
        "Movie Event",
        "Pay-Per-View",
        None,
        [Some("US"), None, None],
    );
    c.execute_batch("INSERT INTO favorite VALUES('ppv');INSERT INTO channel_category_override VALUES('ppv','Sports')").unwrap();
    refresh(&mut c);
    for filter in [
        Filter::All,
        Filter::Sports,
        Filter::Favorites,
        Filter::News,
        Filter::Movies,
    ] {
        let mut q = query("");
        q.filter = filter;
        let page = run(&c, &q);
        assert!(!ids(&page).contains(&"ppv"));
        assert!(!ids(&page).contains(&"movie"));
    }
    assert_eq!(run(&c, &query("Boxing")).total_count, 0);
    assert_eq!(run(&c, &query("PPV01")).total_count, 0);
    let mut q = query("");
    q.filter = Filter::Ppv;
    assert_eq!(ids(&run(&c, &q)), ["ppv", "movie"]);
    q.geography.insert("country".into(), "CA".into());
    assert!(run(&c, &q).rows.is_empty());
    q.geography.clear();
    q.page_size = 1;
    let first = run(&c, &q);
    assert_eq!(first.total_count, 2);
    q.expected_catalog_revision = Some(first.catalog_revision);
    q.expected_view_revision = Some(first.view_revision);
    q.after = first.after;
    assert_eq!(ids(&run(&c, &q)), ["movie"]);
    q.filter = Filter::All;
    assert_eq!(
        query_page(&c, &q, &Arc::new(AtomicBool::new(false))).unwrap_err(),
        "catalog-query-cursor-stale"
    );
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
    c.execute_batch("CREATE TABLE channel_url(channel_id TEXT,ordinal INTEGER,url TEXT);")
        .unwrap();
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
                        checked_urls: None,
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
    c.execute_batch("INSERT INTO channel_url VALUES('dead',0,'https://a/primary'),('dead',1,'https://a/backup');")
        .unwrap();
    assert_eq!(run(&c, &q).total_count, 0);
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
fn favorites_only_combines_with_category_before_sorting() {
    let mut c = favorites_fixture();
    add(&c, "s0", "Z Sports", "Sports", None, [None; 3]);
    add(&c, "s1", "A Sports", "Sports", None, [None; 3]);
    add(&c, "s2", "B Sports", "Sports", None, [None; 3]);
    c.execute_batch("INSERT INTO favorite VALUES('s0'); INSERT INTO favorite VALUES('s1');")
        .unwrap();
    refresh(&mut c);
    let mut q = query("");
    q.filter = Filter::Sports;
    q.sort = Sort::Name;
    assert_eq!(ids(&run(&c, &q)), vec!["s1", "s2", "s0"]);
    q.favorites_only = true;
    assert_eq!(ids(&run(&c, &q)), vec!["s1", "s0"]);
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

#[test]
fn sports_cached_programmes_original_categories_ppv_counts_and_cursors() {
    let mut c = fixture();
    c.execute_batch("CREATE TABLE channel_category_override(channel_id TEXT PRIMARY KEY,category TEXT);CREATE TABLE guide_meta(singleton INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO guide_meta VALUES(1,1);CREATE TABLE guide_source(id TEXT PRIMARY KEY,revision INTEGER,published_revision INTEGER);INSERT INTO guide_source VALUES('g',1,1);CREATE TABLE guide_mapping(catalog_source_id TEXT,app_channel_id TEXT,guide_source_id TEXT,xmltv_channel_id TEXT);CREATE INDEX guide_mapping_target ON guide_mapping(guide_source_id,xmltv_channel_id,app_channel_id);CREATE TABLE guide_program(guide_source_id TEXT,channel_id TEXT,start_ms INTEGER,stop_ms INTEGER,title TEXT,description TEXT,categories_json TEXT);CREATE INDEX guide_program_global_time ON guide_program(start_ms,guide_source_id);CREATE INDEX guide_program_channel_time ON guide_program(guide_source_id,channel_id,start_ms);").unwrap();
    for (id, name, category, country) in [
        ("a", "Event 1", "US | NFL", "US"),
        ("b", "Chicago Bears PPV", "US | PPV", "US"),
        ("c", "NFLive PPV", "US | PPV", "US"),
        ("d", "NBA PPV", "US | PPV", "US"),
        ("e", "FOX 43", "News", "US"),
        ("f", "FOX Late", "News", "US"),
        ("g", "Chicago Bears Canada", "Sports", "CA"),
        ("h", "Bears at Cardinals", "Sports", "US"),
    ] {
        add(&c, id, name, category, None, [Some(country), None, None]);
    }
    c.execute_batch("INSERT INTO channel_category_override VALUES('a','Sports');INSERT INTO guide_mapping VALUES('s','e','g','fox'),('s','f','g','late');INSERT INTO guide_program VALUES('g','fox',1200,1800,'Chicago Bears at Detroit Lions',NULL,'[]'),('g','late',691201000,691202000,'NFL Live',NULL,'[]');").unwrap();
    refresh(&mut c);
    assert_eq!(ids(&run(&c, &query("NFL"))), ["a"]);
    let mut q = query("NFL");
    q.sports = Some(crate::catalog::sports::Scope {
        sport: None,
        league: None,
        include_ppv: true,
        window_start_ms: 1000,
        window_end_ms: 1000 + 7 * 86400000,
        vocabulary_version: serde_json::from_str::<Value>(crate::catalog::sports::VOCABULARY)
            .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    });
    q.geography.insert("country".into(), "US".into());
    let full = run(&c, &q);
    assert_eq!(ids(&full), ["a", "b", "e"]);
    assert_eq!(
        full.rows.iter().map(|r| r.ppv).collect::<Vec<_>>(),
        [false, true, false]
    );
    assert_eq!(full.total_count, 3);
    q.page_size = 1;
    let first = run(&c, &q);
    assert_eq!(first.total_count, 3);
    assert_eq!(ids(&first), ["a"]);
    q.expected_catalog_revision = Some(first.catalog_revision);
    q.expected_view_revision = Some(first.view_revision);
    q.after = first.after;
    assert_eq!(ids(&run(&c, &q)), ["b"]);
    c.execute_batch("UPDATE guide_meta SET revision=2").unwrap();
    assert_eq!(
        query_page(&c, &q, &Arc::new(AtomicBool::new(false))).unwrap_err(),
        "catalog-query-cursor-stale"
    );
    c.execute_batch("UPDATE guide_meta SET revision=1").unwrap();
    q.sports.as_mut().unwrap().window_start_ms += 1;
    q.sports.as_mut().unwrap().window_end_ms += 1;
    assert_eq!(
        query_page(&c, &q, &Arc::new(AtomicBool::new(false))).unwrap_err(),
        "catalog-query-cursor-stale"
    );
    q.after = None;
    q.page_size = 50;
    q.query = "football".into();
    q.filter = Filter::Sports;
    q.sports.as_mut().unwrap().include_ppv = false;
    assert_eq!(ids(&run(&c, &q)), ["a", "e"]);
    q.query.clear();
    q.sports.as_mut().unwrap().league = Some("nfl".into());
    q.sports.as_mut().unwrap().include_ppv = true;
    assert_eq!(ids(&run(&c, &q)), ["a", "b", "e"]);
    q.filter = Filter::Ppv;
    assert_eq!(ids(&run(&c, &q)), ["b"]);
    let cancel = Arc::new(AtomicBool::new(true));
    assert!(query_page(&c, &q, &cancel).is_err());
    add(
        &c,
        "0-coverage",
        "AAA Sports Desk",
        "Sports",
        None,
        [Some("US"), None, None],
    );
    add(
        &c,
        "0-cartoon",
        "TG Junior",
        "Kids",
        None,
        [Some("US"), None, None],
    );
    add(
        &c,
        "0-series",
        "Dallas Cowboys Cheerleaders",
        "Series",
        None,
        [Some("US"), None, None],
    );
    c.execute_batch("INSERT INTO guide_mapping VALUES('s','0-cartoon','g','kids'); INSERT INTO guide_program VALUES('g','kids',1200,1800,'The Fixies','The friends watch an NFL football game.','[]');").unwrap();
    refresh(&mut c);
    q.expected_catalog_revision = None;
    q.expected_view_revision = None;
    q.query = "football".into();
    q.sports.as_mut().unwrap().league = None;
    q.sports.as_mut().unwrap().include_ppv = false;
    q.filter = Filter::All;
    q.sort = Sort::Name;
    assert_eq!(ids(&run(&c, &q)), ["a", "e", "0-coverage"]);
    q.page_size = 2;
    let first = run(&c, &q);
    q.expected_catalog_revision = Some(first.catalog_revision);
    q.expected_view_revision = Some(first.view_revision);
    q.after = first.after;
    assert_eq!(ids(&run(&c, &q)), ["0-coverage"]);
}

#[test]
fn sports_explicit_facet_requires_nfl_evidence_before_counts_and_pages() {
    let mut c = fixture();
    c.execute_batch("CREATE TABLE guide_meta(singleton INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO guide_meta VALUES(1,1);CREATE TABLE guide_source(id TEXT PRIMARY KEY,revision INTEGER,published_revision INTEGER);INSERT INTO guide_source VALUES('g',1,1);CREATE TABLE guide_mapping(catalog_source_id TEXT,app_channel_id TEXT,guide_source_id TEXT,xmltv_channel_id TEXT);CREATE INDEX guide_mapping_target ON guide_mapping(guide_source_id,xmltv_channel_id,app_channel_id);CREATE TABLE guide_program(guide_source_id TEXT,channel_id TEXT,start_ms INTEGER,stop_ms INTEGER,title TEXT,description TEXT,categories_json TEXT);CREATE INDEX guide_program_channel_time ON guide_program(guide_source_id,channel_id,start_ms);").unwrap();
    for (id, name, category, country) in [
        ("nfl", "NFL Network", "US | NFL", "US"),
        ("conflict", "Conflict Channel", "American Football", "US"),
        ("nflive", "NFLive", "American Football", "US"),
        ("ppv", "Chicago Bears PPV", "US | PPV", "US"),
        ("false-ppv", "NFLive PPV", "American Football | PPV", "US"),
        ("affiliate", "FOX Affiliate", "General", "US"),
        ("news", "CBS News", "News", "US"),
        ("sailing", "SailGP", "Sports", "US"),
        ("children", "Happy Kids", "Children", "US"),
        ("outside", "FOX Outside Window", "General", "US"),
        ("past", "FOX Past", "General", "US"),
        ("canada", "NFL Canada", "NFL", "CA"),
        ("removed", "NFL Removed", "NFL", "US"),
        ("adult", "NFL Adult", "Adult | NFL", "US"),
    ] {
        add(&c, id, name, category, None, [Some(country), None, None]);
    }
    c.execute_batch("INSERT INTO removed VALUES('removed');INSERT INTO guide_mapping VALUES('s','affiliate','g','fox'),('s','news','g','news'),('s','sailing','g','sail'),('s','children','g','kids'),('s','outside','g','outside'),('s','past','g','past');INSERT INTO guide_program VALUES('g','fox',1100,1200,'Cartoon hour',NULL,'[]'),('g','fox',2000,3000,'Chicago Bears at Green Bay Packers',NULL,'[]'),('g','news',1100,3000,'Local weather and headlines',NULL,'[]'),('g','sail',1100,3000,'Sail Grand Prix',NULL,'[]'),('g','kids',1100,3000,'Cartoon hour',NULL,'[]'),('g','outside',691201000,691202000,'NFL Live',NULL,'[]'),('g','past',0,900,'NFL Replay',NULL,'[]');").unwrap();
    refresh(&mut c);
    let mut q = query("NFL");
    q.filter = Filter::Sports;
    q.hide_adult = true;
    q.geography.insert("country".into(), "US".into());
    q.sports = Some(crate::catalog::sports::Scope {
        sport: Some("american-football".into()),
        league: None,
        include_ppv: true,
        window_start_ms: 1000,
        window_end_ms: 1000 + 7 * 86400000,
        vocabulary_version: serde_json::from_str::<Value>(crate::catalog::sports::VOCABULARY)
            .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    });
    let full = run(&c, &q);
    assert_eq!(ids(&full), ["nfl", "ppv", "affiliate"]);
    assert_eq!(full.total_count, 3);
    assert_eq!(
        full.rows.iter().map(|row| row.ppv).collect::<Vec<_>>(),
        [false, true, false]
    );
    q.page_size = 1;
    let first = run(&c, &q);
    assert_eq!(first.total_count, 3);
    assert_eq!(ids(&first), ["nfl"]);
    q.expected_catalog_revision = Some(first.catalog_revision);
    q.expected_view_revision = Some(first.view_revision);
    q.after = first.after;
    assert_eq!(ids(&run(&c, &q)), ["ppv"]);
    q.after = None;
    q.page_size = 50;
    q.query = "Football".into();
    assert_eq!(
        ids(&run(&c, &q)),
        ["nfl", "conflict", "nflive", "ppv", "false-ppv", "affiliate"]
    );
    q.query = "NFLive".into();
    assert_eq!(ids(&run(&c, &q)), ["nflive", "false-ppv"]);
    q.query = "NFL".into();
    q.sports.as_mut().unwrap().sport = None;
    assert_eq!(ids(&run(&c, &q)), ["nfl", "ppv", "affiliate"]);

    c.execute_batch(
        "INSERT INTO guide_program VALUES
        ('g','kids',2000,3000,'Cartoon hour','The children go to a baseball game.','[{\"text\":\"Comedy\"}]'),
        ('g','fox',3000,4000,'Chicago Cubs at St. Louis Cardinals',NULL,'[]');",
    )
    .unwrap();
    q.query.clear();
    q.sports.as_mut().unwrap().sport = Some("baseball".into());
    let baseball = run(&c, &q);
    assert_eq!(ids(&baseball), ["affiliate"]);
    assert_eq!(baseball.total_count, 1);
}

#[test]
fn sports_large_literal_search_keeps_indexes_and_reuses_programme_inventory() {
    let mut memory = fixture();
    memory.execute_batch("CREATE TABLE guide_meta(singleton INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO guide_meta VALUES(1,1);CREATE TABLE guide_source(id TEXT PRIMARY KEY,revision INTEGER,published_revision INTEGER);INSERT INTO guide_source VALUES('g',1,1);CREATE TABLE guide_mapping(catalog_source_id TEXT,app_channel_id TEXT,guide_source_id TEXT,xmltv_channel_id TEXT);CREATE INDEX guide_mapping_target ON guide_mapping(guide_source_id,xmltv_channel_id,app_channel_id);CREATE TABLE guide_program(guide_source_id TEXT,channel_id TEXT,start_ms INTEGER,stop_ms INTEGER,title TEXT,description TEXT,categories_json TEXT);CREATE INDEX guide_program_global_time ON guide_program(start_ms,guide_source_id);CREATE INDEX guide_program_channel_time ON guide_program(guide_source_id,channel_id,start_ms);").unwrap();
    {
        let tx = memory.transaction().unwrap();
        let mut ch = tx
            .prepare("INSERT INTO channel VALUES(?1,'s',NULL,?2,'News',?3,'US',NULL,NULL,NULL)")
            .unwrap();
        let mut map = tx
            .prepare("INSERT INTO guide_mapping VALUES('s',?1,'g',?1)")
            .unwrap();
        let mut program = tx
            .prepare("INSERT INTO guide_program VALUES('g',?1,?2,?3,?4,NULL,'[]')")
            .unwrap();
        for n in 0..10000 {
            let id = format!("c{n:05}");
            let name = if n % 1000 == 0 {
                "Hallmark"
            } else {
                "Other channel"
            };
            ch.execute(params![id, name, n]).unwrap();
            map.execute([&id]).unwrap();
            for hour in 0..5 {
                program
                    .execute(params![
                        id,
                        1000 + hour * 3600000,
                        1000 + (hour + 1) * 3600000,
                        if n % 100 == 0 {
                            "Hallmark Classics"
                        } else {
                            "Ordinary programme"
                        }
                    ])
                    .unwrap();
            }
        }
        drop(program);
        drop(map);
        drop(ch);
        tx.commit().unwrap();
    }
    refresh(&mut memory);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.sqlite3");
    let mut c = Connection::open(&path).unwrap();
    rusqlite::backup::Backup::new(&memory, &mut c)
        .unwrap()
        .run_to_completion(100, std::time::Duration::ZERO, None)
        .unwrap();
    let mut q = query("Hallmark");
    q.page_size = 10;
    q.sports = Some(crate::catalog::sports::Scope {
        sport: None,
        league: None,
        include_ppv: false,
        window_start_ms: 1000,
        window_end_ms: 1000 + 7 * 86400000,
        vocabulary_version: serde_json::from_str::<Value>(crate::catalog::sports::VOCABULARY)
            .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    });
    let cache = PageCache::default();
    let cancel = Arc::new(AtomicBool::new(false));
    let steps = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = steps.clone();
    let hook: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        observed.fetch_add(1, Ordering::SeqCst);
    });
    let before = crate::catalog::sports::fact_calls();
    let first =
        query_page_inner(&c, &q, &cancel, Some((&cache, &path)), Some(hook.clone())).unwrap();
    let cold = steps.swap(0, Ordering::SeqCst);
    assert_eq!(first.total_count, 100);
    assert_eq!(
        crate::catalog::sports::fact_calls(),
        before,
        "ordinary literal search never invokes ontology evidence"
    );
    q.expected_catalog_revision = Some(first.catalog_revision);
    q.expected_view_revision = Some(first.view_revision);
    q.after = first.after;
    let next = query_page_inner(&c, &q, &cancel, Some((&cache, &path)), Some(hook)).unwrap();
    let warm = steps.load(Ordering::SeqCst);
    assert_eq!(next.total_count, 100);
    assert_eq!(next.rows.len(), 10);
    assert!(warm * 20 < cold, "cold VM blocks={cold}; cached={warm}");
    eprintln!("sports fixture channels=10000 programmes=50000 cold_vm_blocks={cold} cached_vm_blocks={warm}");
}

#[test]
fn sports_real_facets_bound_evidence_work_and_keep_programme_parity() {
    let mut memory = fixture();
    memory.execute_batch("CREATE TABLE guide_meta(singleton INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO guide_meta VALUES(1,1);CREATE TABLE guide_source(id TEXT PRIMARY KEY,revision INTEGER,published_revision INTEGER);INSERT INTO guide_source VALUES('g',1,1);CREATE TABLE guide_mapping(catalog_source_id TEXT,app_channel_id TEXT,guide_source_id TEXT,xmltv_channel_id TEXT);CREATE INDEX guide_mapping_target ON guide_mapping(guide_source_id,xmltv_channel_id,app_channel_id);CREATE TABLE guide_program(guide_source_id TEXT,channel_id TEXT,start_ms INTEGER,stop_ms INTEGER,title TEXT,description TEXT,categories_json TEXT);CREATE INDEX guide_program_global_time ON guide_program(start_ms,guide_source_id);CREATE INDEX guide_program_channel_time ON guide_program(guide_source_id,channel_id,start_ms);").unwrap();
    {
        let tx = memory.transaction().unwrap();
        let mut channel = tx
            .prepare("INSERT INTO channel VALUES(?1,'s',NULL,?2,'News',?3,'US',NULL,NULL,NULL)")
            .unwrap();
        let mut mapping = tx
            .prepare("INSERT INTO guide_mapping VALUES('s',?1,'g',?1)")
            .unwrap();
        let mut program = tx
            .prepare("INSERT INTO guide_program VALUES('g',?1,?2,?3,?4,?5,'[]')")
            .unwrap();
        for n in 0..10_000 {
            let id = format!("c{n:05}");
            channel
                .execute(params![id, format!("Affiliate {n:05}"), n])
                .unwrap();
            mapping.execute([&id]).unwrap();
            for hour in 0..5 {
                let title = match n % 100 {
                    0 => "Chicago Bears at Green Bay Packers",
                    1 => "College Football Championship",
                    2 => "MLB Cardinals at Giants",
                    3 => "Bears wildlife documentary",
                    _ => "Ordinary programme",
                };
                program
                    .execute(params![
                        id,
                        1000 + hour * 3_600_000,
                        1000 + (hour + 1) * 3_600_000,
                        title,
                        "A cached programme description with no independent league evidence."
                    ])
                    .unwrap();
            }
        }
        drop(program);
        drop(mapping);
        drop(channel);
        tx.commit().unwrap();
    }
    refresh(&mut memory);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.sqlite3");
    let mut c = Connection::open(&path).unwrap();
    rusqlite::backup::Backup::new(&memory, &mut c)
        .unwrap()
        .run_to_completion(100, std::time::Duration::ZERO, None)
        .unwrap();
    let cache = PageCache::default();
    let cancel = Arc::new(AtomicBool::new(false));
    for (league, expected) in [(None, 200), (Some("nfl"), 100)] {
        let mut q = query("");
        q.filter = Filter::Sports;
        q.sports = Some(crate::catalog::sports::Scope {
            sport: Some("american-football".into()),
            league: league.map(str::to_owned),
            include_ppv: true,
            window_start_ms: 1000,
            window_end_ms: 1000 + 7 * 86_400_000,
            vocabulary_version: serde_json::from_str::<Value>(crate::catalog::sports::VOCABULARY)
                .unwrap()["vocabularyVersion"]
                .as_str()
                .unwrap()
                .into(),
        });
        let before = crate::catalog::sports::fact_calls();
        let started = std::time::Instant::now();
        let first = query_page_cached(&c, &q, &cancel, &cache, &path).unwrap();
        let work = crate::catalog::sports::fact_calls() - before;
        eprintln!("real facet channels=10000 programmes=50000 league={league:?} evidence_computations={work} elapsed_ms={}", started.elapsed().as_millis());
        assert_eq!(first.total_count, expected);
        assert!(first.rows.iter().all(|r| {
            let n: usize = r.id.trim_start_matches('c').parse().unwrap();
            n.is_multiple_of(100) || (league.is_none() && n % 100 == 1)
        }));
        assert!(
            work <= 10_010,
            "facet evidence work must reuse channel/programme facts, got {work}"
        );
        q.expected_catalog_revision = Some(first.catalog_revision);
        q.expected_view_revision = Some(first.view_revision);
        q.expected_guide_revision = first.guide_revision;
        q.start_index = Some(50);
        let before = crate::catalog::sports::fact_calls();
        let next = query_page_cached(&c, &q, &cancel, &cache, &path).unwrap();
        assert_eq!(next.total_count, expected);
        assert_eq!(
            crate::catalog::sports::fact_calls(),
            before,
            "same-scope page reuses completed membership"
        );
    }

    // Unique descriptions defeat programme memoization. Unrelated ASCII text
    // must still avoid the full ontology classifier, not merely rely on five
    // repeated fixture titles.
    c.execute_batch("UPDATE guide_program SET description='Distinct cached episode '||channel_id||' '||start_ms;UPDATE guide_meta SET revision=2 WHERE singleton=1;").unwrap();
    for (league, expected) in [(None, 200), (Some("nfl"), 100)] {
        let mut q = query("");
        q.filter = Filter::Sports;
        q.sports = Some(crate::catalog::sports::Scope {
            sport: Some("american-football".into()),
            league: league.map(str::to_owned),
            include_ppv: true,
            window_start_ms: 1000,
            window_end_ms: 1000 + 7 * 86_400_000,
            vocabulary_version: serde_json::from_str::<Value>(crate::catalog::sports::VOCABULARY)
                .unwrap()["vocabularyVersion"]
                .as_str()
                .unwrap()
                .into(),
        });
        let before = crate::catalog::sports::full_fact_calls();
        let started = std::time::Instant::now();
        let page = query_page_cached(&c, &q, &cancel, &cache, &path).unwrap();
        let full = crate::catalog::sports::full_fact_calls() - before;
        assert_eq!(page.total_count, expected);
        assert!(
            full <= 2000,
            "only explicit/contextual candidate titles need ontology, got {full}"
        );
        eprintln!("diverse real facet channels=10000 programmes=50000 league={league:?} full_ontology_computations={full} elapsed_ms={}", started.elapsed().as_millis());
    }

    c.execute_batch("UPDATE guide_program SET description='Épisode 東京 éducation '||channel_id||' '||start_ms;UPDATE guide_meta SET revision=3 WHERE singleton=1;").unwrap();
    for (league, expected) in [(None, 200), (Some("nfl"), 100)] {
        let mut q = query("");
        q.filter = Filter::Sports;
        q.sports = Some(crate::catalog::sports::Scope {
            sport: Some("american-football".into()),
            league: league.map(str::to_owned),
            include_ppv: true,
            window_start_ms: 1000,
            window_end_ms: 1000 + 7 * 86_400_000,
            vocabulary_version: serde_json::from_str::<Value>(crate::catalog::sports::VOCABULARY)
                .unwrap()["vocabularyVersion"]
                .as_str()
                .unwrap()
                .into(),
        });
        let before = crate::catalog::sports::full_fact_calls();
        let started = std::time::Instant::now();
        let page = query_page_cached(&c, &q, &cancel, &cache, &path).unwrap();
        let full = crate::catalog::sports::full_fact_calls() - before;
        assert_eq!(page.total_count, expected);
        eprintln!("Unicode real facet channels=10000 programmes=50000 league={league:?} full_ontology_computations={full} elapsed_ms={}", started.elapsed().as_millis());
        assert!(
            full <= 2000,
            "unrelated Unicode descriptions must not force full ontology: {full}"
        );
    }
}

#[test]
fn sports_multifeed_programme_scan_ignores_unmapped_growth_and_keeps_contexts() {
    let mut measurements = Vec::new();
    for (feeds, unmapped) in [(4usize, 1500), (4, 20_000), (8, 20_000)] {
        let mut c = fixture();
        c.execute_batch("PRAGMA user_version=1;").unwrap();
        crate::guide::database::migrate(&mut c).unwrap();
        let now = 1_000_000_000i64;
        let mut expected = std::collections::HashSet::new();
        {
            let tx = c.transaction().unwrap();
            let mut source = tx.prepare("INSERT INTO guide_source VALUES(?1,?1,'https://fixture.invalid/guide','url',0,1,0,?2)").unwrap();
            let mut guide_channel = tx
                .prepare("INSERT INTO guide_channel VALUES(?1,?2,'[]','')")
                .unwrap();
            let mut channel = tx
                .prepare("INSERT INTO channel VALUES(?1,'s',NULL,?2,'News',?3,'US',NULL,NULL,NULL)")
                .unwrap();
            let mut program = tx.prepare("INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,description,search_text,categories_json,categories_key) VALUES(?1,?2,?3,?4,?5,?6,'Cached description','','[]','[]')").unwrap();
            for feed in 0..feeds {
                let id = format!("guide-{feed}");
                let published = (feed + 1 < feeds).then_some(1);
                source.execute(params![id, published]).unwrap();
                guide_channel.execute(params![id, "old-unmapped"]).unwrap();
                for n in 0..unmapped {
                    program
                        .execute(params![
                            id,
                            n as i64,
                            "old-unmapped",
                            if n < unmapped / 2 { n as i64 } else { now },
                            Some(if n < unmapped / 2 {
                                n as i64 + 1
                            } else {
                                now + 3600000
                            }),
                            "Unmapped NFL replay"
                        ])
                        .unwrap();
                }
                for n in 0..125usize {
                    let ordinal = feed * 125 + n;
                    let channel_id = format!("c{ordinal:05}");
                    channel
                        .execute(params![
                            channel_id,
                            if n % 10 == 9 {
                                format!("NFL affiliate {ordinal}")
                            } else {
                                format!("Affiliate {ordinal}")
                            },
                            ordinal as i64
                        ])
                        .unwrap();
                    guide_channel.execute(params![id, channel_id]).unwrap();
                    let mapped_id = if n % 10 == 9 {
                        format!("c{:05}", ordinal - 1)
                    } else {
                        channel_id.clone()
                    };
                    tx.execute(
                        "INSERT INTO guide_mapping VALUES('s',?1,?2,?3)",
                        params![channel_id, id, mapped_id],
                    )
                    .unwrap();
                    for hour in 0..5 {
                        let (start, stop, title) = if hour > 0 {
                            (
                                now + hour * 3_600_000,
                                Some(now + (hour + 1) * 3_600_000),
                                "Ordinary programme",
                            )
                        } else {
                            match n % 10 {
                                0 => (
                                    now,
                                    Some(now + 3_600_000),
                                    "Chicago Bears at Green Bay Packers",
                                ),
                                1 => (now, Some(now + 3_600_000), "MLB Cardinals at Giants"),
                                2 => (now, Some(now + 3_600_000), "PPV NFL Live"),
                                4 => (0, Some(now + 100), "NFL long ongoing programme"),
                                5 => (now - 1, None, "NFL unknown end before scope"),
                                6 => (now + 1, None, "NFL unknown end inside scope"),
                                _ => (now, Some(now + 3_600_000), "Ordinary programme"),
                            }
                        };
                        program
                            .execute(params![
                                id,
                                (unmapped + n * 5 + hour as usize) as i64,
                                channel_id,
                                start,
                                stop,
                                title
                            ])
                            .unwrap();
                    }
                    if published.is_some() && matches!(n % 10, 0 | 2 | 4 | 6 | 9) {
                        expected.insert(channel_id);
                    }
                }
            }
            drop(program);
            drop(channel);
            drop(guide_channel);
            drop(source);
            tx.commit().unwrap();
        }
        refresh(&mut c);
        crate::catalog::ppv::register(&c).unwrap();
        let scope = crate::catalog::sports::Scope {
            sport: Some("american-football".into()),
            league: Some("nfl".into()),
            include_ppv: true,
            window_start_ms: now,
            window_end_ms: now + 7 * 86_400_000,
            vocabulary_version: serde_json::from_str::<Value>(crate::catalog::sports::VOCABULARY)
                .unwrap()["vocabularyVersion"]
                .as_str()
                .unwrap()
                .into(),
        };
        let plan = crate::catalog::sports::Plan::new(&scope, "").unwrap();
        let steps = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = steps.clone();
        c.progress_handler(
            1000,
            Some(move || observed.fetch_add(1, Ordering::SeqCst) > 10_000),
        )
        .unwrap();
        let result = crate::catalog::sports::register_public_list(&c, &plan, false);
        c.progress_handler(0, None::<fn() -> bool>).unwrap();
        let vm = steps.load(Ordering::SeqCst);
        let query_plan = crate::catalog::sports::public_plan();
        eprintln!("multifeed Free sources={feeds} mapped_channels={} programmes={} vm_blocks={vm} plan={query_plan:?} outcome={}", feeds * 125, feeds * (unmapped + 625), if result.is_ok() { "complete" } else { "interrupted" });
        let matched =
            result.expect("programme work must finish inside the deterministic VM budget");
        assert_eq!(matched.all, expected);
        assert!(
            query_plan.first().is_some_and(|p| p.contains("SCAN m")),
            "current mapping must be the outer loop: {query_plan:?}"
        );
        assert!(query_plan.iter().any(|p| p.contains("SEARCH p USING INDEX guide_program_channel_time (guide_source_id=? AND channel_id=? AND start_ms<?)")), "programmes must use a source/channel time lookup: {query_plan:?}");
        // Persisted databases can carry cardinality statistics. Do not assume
        // SQLite's empty-statistics join choice remains the production plan.
        c.execute_batch("ANALYZE;").unwrap();
        steps.store(0, Ordering::SeqCst);
        let observed = steps.clone();
        c.progress_handler(
            1000,
            Some(move || observed.fetch_add(1, Ordering::SeqCst) > 10_000),
        )
        .unwrap();
        let result = crate::catalog::sports::register_public_list(&c, &plan, false);
        c.progress_handler(0, None::<fn() -> bool>).unwrap();
        let analyzed_vm = steps.load(Ordering::SeqCst);
        let analyzed_plan = crate::catalog::sports::public_plan();
        eprintln!("analyzed multifeed Free sources={feeds} vm_blocks={analyzed_vm} plan={analyzed_plan:?} outcome={}", if result.is_ok() { "complete" } else { "interrupted" });
        let matched = result.expect("statistics must not allow repeated global programme scans");
        assert_eq!(matched.all, expected);
        assert!(
            analyzed_plan.first().is_some_and(|p| p.contains("SCAN m")),
            "analyzed mapping must stay outer: {analyzed_plan:?}"
        );
        assert!(analyzed_plan.iter().any(|p| p.contains("SEARCH p USING INDEX guide_program_channel_time (guide_source_id=? AND channel_id=? AND start_ms<?)")), "analyzed programme lookup must stay target-scoped: {analyzed_plan:?}");
        measurements.push(vm);
    }
    assert!(
        measurements[1] <= measurements[0] + 20,
        "unmapped programme growth must not expand mapped work: {measurements:?}"
    );
    assert!(
        measurements[2] < measurements[1] * 3,
        "doubling mapped sources/rows must stay linear: {measurements:?}"
    );
}

#[test]
fn sports_event_only_ppv_badge_requires_matching_event_and_clears_for_normal_match() {
    let mut c = fixture();
    c.execute_batch("CREATE TABLE guide_meta(singleton INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO guide_meta VALUES(1,1);CREATE TABLE guide_source(id TEXT PRIMARY KEY,revision INTEGER,published_revision INTEGER);INSERT INTO guide_source VALUES('g',1,1);CREATE TABLE guide_mapping(catalog_source_id TEXT,app_channel_id TEXT,guide_source_id TEXT,xmltv_channel_id TEXT);CREATE INDEX guide_mapping_target ON guide_mapping(guide_source_id,xmltv_channel_id,app_channel_id);CREATE TABLE guide_program(guide_source_id TEXT,channel_id TEXT,start_ms INTEGER,stop_ms INTEGER,title TEXT,description TEXT,categories_json TEXT);CREATE INDEX guide_program_global_time ON guide_program(start_ms,guide_source_id);CREATE INDEX guide_program_channel_time ON guide_program(guide_source_id,channel_id,start_ms);").unwrap();
    add(&c, "a", "FOX", "News", None, [None, None, None]);
    add(&c, "b", "Other", "News", None, [None, None, None]);
    c.execute_batch("INSERT INTO guide_mapping VALUES('s','a','g','a'),('s','b','g','b');INSERT INTO guide_program VALUES('g','a',1200,1800,'NFL PPV Chicago Bears',NULL,'[]'),('g','b',1200,1800,'NFLive PPV',NULL,'[]')").unwrap();
    refresh(&mut c);
    let mut q = query("NFL");
    q.sports = Some(crate::catalog::sports::Scope {
        sport: None,
        league: None,
        include_ppv: true,
        window_start_ms: 1000,
        window_end_ms: 2000,
        vocabulary_version: serde_json::from_str::<Value>(crate::catalog::sports::VOCABULARY)
            .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    });
    let page = run(&c, &q);
    assert_eq!(ids(&page), ["a"]);
    assert!(page.rows[0].ppv);
    c.execute_batch("INSERT INTO guide_program VALUES('g','a',1300,1900,'NFL Pregame',NULL,'[]')")
        .unwrap();
    assert!(!run(&c, &q).rows[0].ppv);
    c.execute_batch("UPDATE channel SET country='CA' WHERE id='a'")
        .unwrap();
    refresh(&mut c);
    q.query = "NFL Canada".into();
    assert_eq!(
        ids(&run(&c, &q)),
        ["a"],
        "cached programme inherits only safe country search text"
    );
}

#[test]
fn sports_targeted_inventory_keeps_source_projection_overlap_and_ppv_fences() {
    let mut c = fixture();
    c.execute_batch("PRAGMA user_version=1;").unwrap();
    crate::guide::database::migrate(&mut c).unwrap();
    for id in ["good", "foreign", "missing-projection"] {
        add(
            &c,
            id,
            "Generic affiliate",
            "News",
            None,
            [Some("US"), None, None],
        );
    }
    c.execute_batch("INSERT INTO guide_source VALUES('g','Guide','https://fixture.invalid/guide','url',0,1,0,1);INSERT INTO guide_channel VALUES('g','target','[]','');INSERT INTO guide_mapping VALUES('s','good','g','target'),('other','foreign','g','target'),('s','missing-projection','g','target'),('s','orphan','g','target');INSERT INTO guide_program VALUES('g',0,'target',0,1000000001,'PPV NFL game',NULL,'','[]','[]'),('g',1,'target',999999999,NULL,'NFL unknown end before scope',NULL,'','[]','[]'),('g',2,'target',1000000000,1003600000,'NBA game',NULL,'','[]','[]');").unwrap();
    refresh(&mut c);
    c.execute(
        "DELETE FROM catalog_projection WHERE channel_id='missing-projection'",
        [],
    )
    .unwrap();
    crate::catalog::ppv::register(&c).unwrap();
    let scope = crate::catalog::sports::Scope {
        sport: Some("american-football".into()),
        league: Some("nfl".into()),
        include_ppv: true,
        window_start_ms: 1_000_000_000,
        window_end_ms: 1_000_000_000 + 7 * 86_400_000,
        vocabulary_version: serde_json::from_str::<Value>(crate::catalog::sports::VOCABULARY)
            .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    };
    let plan = crate::catalog::sports::Plan::new(&scope, "").unwrap();
    let matched = crate::catalog::sports::register_public_list(&c, &plan, false).unwrap();
    let expected: std::collections::HashSet<String> = ["good".into()].into_iter().collect();
    assert_eq!(
        matched.all, expected,
        "wrong catalog source, orphan and missing projection remain excluded"
    );
    assert_eq!(matched.specific, expected);
    assert_eq!(matched.event_only_ppv, expected, "old-start ongoing overlap is retained; unrelated NBA/old unknown-end rows cannot clear the PPV badge");
    c.execute_batch("INSERT INTO guide_program VALUES('g',3,'target',1000000001,NULL,'NFL normal unknown end inside scope',NULL,'','[]','[]');").unwrap();
    let matched = crate::catalog::sports::register_public_list(&c, &plan, false).unwrap();
    assert_eq!(matched.all, expected);
    assert!(
        matched.event_only_ppv.is_empty(),
        "a genuinely matching normal programme clears the event-only badge"
    );
}

#[test]
fn sports_default_metadata_filter_counts_shared_registry_evidence_before_page() {
    let mut c = fixture();
    add(
        &c,
        "a",
        "Event 1",
        "US | NFL",
        None,
        [Some("US"), None, None],
    );
    add(
        &c,
        "b",
        "Chicago Bears Channel",
        "News",
        None,
        [Some("US"), None, None],
    );
    add(
        &c,
        "c",
        "Bears at Cardinals",
        "News",
        None,
        [Some("US"), None, None],
    );
    add(
        &c,
        "d",
        "NFL PPV",
        "Sports PPV",
        None,
        [Some("US"), None, None],
    );
    refresh(&mut c);
    let mut q = query("");
    q.filter = Filter::Sports;
    q.page_size = 1;
    let first = run(&c, &q);
    assert_eq!(first.total_count, 2);
    assert_eq!(ids(&first), ["a"]);
    q.expected_catalog_revision = Some(first.catalog_revision);
    q.expected_view_revision = Some(first.view_revision);
    q.after = first.after;
    assert_eq!(ids(&run(&c, &q)), ["b"]);
}

#[test]
fn sports_offset_pages_bind_guide_revision_and_anchors_recapture_current_membership() {
    let mut c = fixture();
    c.execute_batch("CREATE TABLE guide_meta(singleton INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO guide_meta VALUES(1,1);CREATE TABLE guide_source(id TEXT PRIMARY KEY,revision INTEGER,published_revision INTEGER);INSERT INTO guide_source VALUES('g',1,1);CREATE TABLE guide_mapping(catalog_source_id TEXT,app_channel_id TEXT,guide_source_id TEXT,xmltv_channel_id TEXT);CREATE INDEX guide_mapping_target ON guide_mapping(guide_source_id,xmltv_channel_id,app_channel_id);CREATE TABLE guide_program(guide_source_id TEXT,channel_id TEXT,start_ms INTEGER,stop_ms INTEGER,title TEXT,description TEXT,categories_json TEXT);CREATE INDEX guide_program_global_time ON guide_program(start_ms,guide_source_id);CREATE INDEX guide_program_channel_time ON guide_program(guide_source_id,channel_id,start_ms);").unwrap();
    for id in ["a", "b", "c"] {
        add(
            &c,
            id,
            "Local affiliate",
            "News",
            None,
            [Some("US"), None, None],
        );
    }
    c.execute_batch("INSERT INTO guide_mapping VALUES('s','a','g','a'),('s','b','g','b'),('s','c','g','c');INSERT INTO guide_program VALUES('g','a',1200,1800,'Chicago Bears at Detroit Lions',NULL,'[]'),('g','b',1200,1800,'NFL Pregame',NULL,'[]'),('g','c',1200,1800,'NBA Basketball',NULL,'[]')").unwrap();
    refresh(&mut c);
    let scope = crate::catalog::sports::Scope {
        sport: None,
        league: None,
        include_ppv: true,
        window_start_ms: 1000,
        window_end_ms: 2000,
        vocabulary_version: serde_json::from_str::<Value>(crate::catalog::sports::VOCABULARY)
            .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    };
    let mut q = query("NFL");
    q.sports = Some(scope.clone());
    q.start_index = Some(0);
    q.page_size = 1;
    let first = run(&c, &q);
    assert_eq!(first.guide_revision.as_deref(), Some("1"));
    assert_eq!(first.total_count, 2);
    assert_eq!(ids(&first), ["a"]);
    q.expected_catalog_revision = Some(first.catalog_revision);
    q.expected_view_revision = Some(first.view_revision);
    q.expected_guide_revision = first.guide_revision;
    q.start_index = Some(1);
    assert_eq!(ids(&run(&c, &q)), ["b"]);
    c.execute_batch("BEGIN IMMEDIATE;DELETE FROM guide_program WHERE channel_id='a';UPDATE guide_program SET title='NFL Game' WHERE channel_id='c';UPDATE guide_meta SET revision=2;COMMIT;").unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    assert_eq!(
        query_page(&c, &q, &cancel).unwrap_err(),
        "catalog-view-revision-stale"
    );
    q.expected_guide_revision = None;
    assert_eq!(
        query_page(&c, &q, &cancel).unwrap_err(),
        "catalog-view-revision-stale"
    );
    for malformed in ["01", "-1", "9223372036854775808", "unknown"] {
        q.expected_guide_revision = Some(malformed.into());
        assert_eq!(
            query_page(&c, &q, &cancel).unwrap_err(),
            "catalog-query-invalid"
        );
    }
    q.expected_guide_revision = Some("2".into());
    q.sports = None;
    assert_eq!(
        query_page(&c, &q, &cancel).unwrap_err(),
        "catalog-query-invalid"
    );
    q.sports = Some(scope.clone());
    q.expected_guide_revision = None;
    q.start_index = None;
    q.anchor_id = Some("b".into());
    let refreshed = run(&c, &q);
    assert_eq!(refreshed.guide_revision.as_deref(), Some("2"));
    assert_eq!(refreshed.anchor_index, Some(0));
    assert_eq!(refreshed.total_count, 2);
    assert_eq!(ids(&refreshed), ["b"]);
    q.expected_guide_revision = refreshed.guide_revision;
    q.anchor_id = None;
    q.start_index = Some(1);
    assert_eq!(ids(&run(&c, &q)), ["c"]);
    let mut empty = fixture();
    add(
        &empty,
        "plain",
        "NFL Channel",
        "News",
        None,
        [None, None, None],
    );
    refresh(&mut empty);
    let mut capture = query("NFL");
    capture.sports = Some(scope);
    let no_guide = run(&empty, &capture);
    assert_eq!(no_guide.guide_revision.as_deref(), Some("0"));
    capture.sports = None;
    let legacy = run(&empty, &capture);
    assert!(legacy.guide_revision.is_none());
    assert!(serde_json::to_value(legacy)
        .unwrap()
        .get("guideRevision")
        .is_none());
}

#[test]
fn watched_history_is_exact_ordered_before_count_page_visibility_and_cursor() {
    let mut c = fixture();
    for (id, category, country) in [
        ("one", "News", "US"),
        ("two", "Sports PPV", "CA"),
        ("adult", "Adult", "US"),
        ("removed", "News", "US"),
        ("unwatched", "News", "US"),
    ] {
        add(&c, id, id, category, None, [Some(country), None, None]);
    }
    c.execute_batch("CREATE TABLE channel_category_override(channel_id TEXT PRIMARY KEY,category TEXT);INSERT INTO channel_category_override VALUES('adult','News');INSERT INTO removed VALUES('removed');INSERT INTO favorite VALUES('one')").unwrap();
    refresh(&mut c);
    let mut q = query("");
    q.filter = Filter::Watched;
    q.history_ids = Some(vec![
        "two".into(),
        "adult".into(),
        "one".into(),
        "removed".into(),
        "deleted".into(),
    ]);
    q.favorites_first = true;
    q.page_size = 1;
    let first = run(&c, &q);
    assert_eq!(first.total_count, 3);
    assert_eq!(ids(&first), ["two"]);
    assert!(first.rows[0].ppv);
    q.expected_catalog_revision = Some(first.catalog_revision);
    q.expected_view_revision = Some(first.view_revision);
    q.after = first.after;
    assert_eq!(ids(&run(&c, &q)), ["adult"]);
    q.history_ids.as_mut().unwrap().swap(0, 2);
    assert_eq!(
        query_page(&c, &q, &Arc::new(AtomicBool::new(false))).unwrap_err(),
        "catalog-query-cursor-stale"
    );
    q.after = None;
    q.page_size = 50;
    q.hide_adult = true;
    assert_eq!(ids(&run(&c, &q)), ["one", "two"]);
    q.geography.insert("country".into(), "US".into());
    assert_eq!(ids(&run(&c, &q)), ["one"]);
    q.query = "two".into();
    assert_eq!(run(&c, &q).total_count, 0);
    q.geography.clear();
    assert_eq!(ids(&run(&c, &q)), ["two"]);
    q.history_ids = Some(vec![]);
    assert_eq!(run(&c, &q).total_count, 0);
    q.history_ids = None;
    assert!(query_page(&c, &q, &Arc::new(AtomicBool::new(false))).is_err());
    q.history_ids = Some(vec!["one".into(), "one".into()]);
    assert!(query_page(&c, &q, &Arc::new(AtomicBool::new(false))).is_err());
    q.filter = Filter::All;
    q.history_ids = Some(vec!["one".into()]);
    assert!(query_page(&c, &q, &Arc::new(AtomicBool::new(false))).is_err());
    assert!(
        !ids(&run(&c, &query(""))).contains(&"two"),
        "History never changes ordinary PPV isolation"
    );
}

#[test]
fn watched_history_programme_search_includes_only_watched_ppv_events() {
    let mut c = fixture();
    c.execute_batch("CREATE TABLE guide_meta(singleton INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO guide_meta VALUES(1,1);CREATE TABLE guide_source(id TEXT PRIMARY KEY,revision INTEGER,published_revision INTEGER);INSERT INTO guide_source VALUES('g',1,1);CREATE TABLE guide_mapping(catalog_source_id TEXT,app_channel_id TEXT,guide_source_id TEXT,xmltv_channel_id TEXT);CREATE INDEX guide_mapping_target ON guide_mapping(guide_source_id,xmltv_channel_id,app_channel_id);CREATE TABLE guide_program(guide_source_id TEXT,channel_id TEXT,start_ms INTEGER,stop_ms INTEGER,title TEXT,description TEXT,categories_json TEXT);CREATE INDEX guide_program_channel_time ON guide_program(guide_source_id,channel_id,start_ms);").unwrap();
    for id in ["one", "two"] {
        add(&c, id, "Local TV", "News", None, [None, None, None]);
        c.execute("INSERT INTO guide_mapping VALUES('s',?1,'g',?1)", [id])
            .unwrap();
        c.execute(
            "INSERT INTO guide_program VALUES('g',?1,1000,2000,'Boxing PPV final',NULL,'[]')",
            [id],
        )
        .unwrap();
    }
    refresh(&mut c);
    let mut q = query("Boxing");
    q.sports = Some(crate::catalog::sports::Scope {
        sport: None,
        league: None,
        include_ppv: false,
        window_start_ms: 1000,
        window_end_ms: 3000,
        vocabulary_version: serde_json::from_str::<Value>(crate::catalog::sports::VOCABULARY)
            .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    });
    assert_eq!(run(&c, &q).total_count, 0);
    q.filter = Filter::Watched;
    q.history_ids = Some(vec!["two".into()]);
    let page = run(&c, &q);
    assert_eq!(ids(&page), ["two"]);
    assert!(page.rows[0].ppv);
}

#[test]
fn watched_history_admission_uses_projection_identity_index() {
    let mut c = fixture();
    for n in 0..300 {
        add(
            &c,
            &format!("c{n}"),
            "News",
            "News",
            None,
            [None, None, None],
        );
    }
    refresh(&mut c);
    register_watch_history(&c, &["c299".into(), "c1".into()]).unwrap();
    let plan=c.prepare("EXPLAIN QUERY PLAN SELECT p.channel_id FROM catalog_projection p JOIN channel c ON c.id=p.channel_id WHERE p.channel_id IN(SELECT value FROM json_each(genx_watch_ids()))").unwrap().query_map([],|r|r.get::<_,String>(3)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    assert!(
        plan.iter()
            .any(|p| p.contains("SEARCH p USING COVERING INDEX")
                || p.contains("SEARCH p USING INDEX")),
        "{plan:?}"
    );
    let mut q = query("");
    q.filter = Filter::Watched;
    q.history_ids = Some(vec!["c299".into(), "c1".into()]);
    assert_eq!(ids(&run(&c, &q)), ["c299", "c1"]);
}

#[test]
fn watched_history_original_adult_fold_survives_category_override() {
    let mut c = fixture();
    c.execute_batch(
        "CREATE TABLE channel_category_override(channel_id TEXT PRIMARY KEY,category TEXT)",
    )
    .unwrap();
    add(&c, "wide", "Local", "ＡＤＵＬＴ", None, [None, None, None]);
    refresh(&mut c);
    let mut q = query("");
    q.filter = Filter::Watched;
    q.history_ids = Some(vec!["wide".into()]);
    q.hide_adult = true;
    assert_eq!(
        run(&c, &q).total_count,
        0,
        "existing projection folds the original category"
    );
    c.execute_batch("INSERT INTO channel_category_override VALUES('wide','News')")
        .unwrap();
    refresh(&mut c);
    assert_eq!(
        run(&c, &q).total_count,
        0,
        "an effective category cannot erase folded original adult evidence in History"
    );
    q.hide_adult = false;
    assert_eq!(ids(&run(&c, &q)), ["wide"]);
}

#[test]
fn sports_collegiate_programme_context_recalls_observed_acc_before_counts() {
    let mut c = fixture();
    c.execute_batch("CREATE TABLE guide_meta(singleton INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO guide_meta VALUES(1,1);CREATE TABLE guide_source(id TEXT PRIMARY KEY,revision INTEGER,published_revision INTEGER);INSERT INTO guide_source VALUES('g',1,1);CREATE TABLE guide_mapping(catalog_source_id TEXT,app_channel_id TEXT,guide_source_id TEXT,xmltv_channel_id TEXT);CREATE TABLE guide_program(guide_source_id TEXT,channel_id TEXT,start_ms INTEGER,stop_ms INTEGER,title TEXT,description TEXT,categories_json TEXT);CREATE INDEX guide_program_channel_time ON guide_program(guide_source_id,channel_id,start_ms);").unwrap();
    for (id, name, categories) in [
        ("acc", "ACC Digital Network (1080p)", "[]"),
        (
            "basketball",
            "ACC Digital Network basketball",
            r#"[{"text":"Basketball"}]"#,
        ),
        (
            "soccer",
            "Atlantic Coast Conference soccer",
            r#"[{"text":"Soccer"}]"#,
        ),
        ("unknown", "UK Football Channel", "[]"),
        ("children", "Football cartoons", "[]"),
    ] {
        add(&c, id, name, "Sports", None, [Some("US"), None, None]);
        c.execute("INSERT INTO guide_mapping VALUES('s',?1,'g',?1)", [id])
            .unwrap();
        c.execute("INSERT INTO guide_program VALUES('g',?1,1100,2000,?2,?3,?4)", params![id, "Miami vs. Duke (11.30.19) Football Replay", "Duke takes down Miami in future Blue Devils head coach Manny Diaz's first year with the Hurricanes.", categories]).unwrap();
    }
    add(
        &c,
        "bare",
        "ACC Digital Network",
        "Sports",
        None,
        [Some("US"), None, None],
    );
    refresh(&mut c);
    let mut q = query("Football");
    q.filter = Filter::Sports;
    q.sports = Some(crate::catalog::sports::Scope {
        sport: Some("american-football".into()),
        league: None,
        include_ppv: true,
        window_start_ms: 1000,
        window_end_ms: 3000,
        vocabulary_version: serde_json::from_str::<Value>(crate::catalog::sports::VOCABULARY)
            .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    });
    let page = run(&c, &q);
    assert_eq!(ids(&page), ["acc"]);
    assert_eq!(page.total_count, 1);
    q.sports.as_mut().unwrap().league = Some("college-football".into());
    assert_eq!(ids(&run(&c, &q)), ["acc"]);
    q.query = "NFL".into();
    assert_eq!(run(&c, &q).total_count, 0);
}
