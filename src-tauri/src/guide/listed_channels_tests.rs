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
use rusqlite::params;
use std::sync::atomic::{AtomicUsize, Ordering};
fn fixture() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,catalog_revision INTEGER,revision INTEGER);INSERT INTO metadata VALUES(1,7,20);CREATE TABLE guide_meta(singleton INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO guide_meta VALUES(1,9);CREATE TABLE source(id TEXT PRIMARY KEY,allow_http INTEGER NOT NULL DEFAULT 0,content_kind TEXT,media_mime TEXT);INSERT INTO source(id) VALUES('catalog');CREATE TABLE channel(id TEXT PRIMARY KEY,source_id TEXT,name TEXT,ordinal INTEGER NOT NULL DEFAULT 0,category TEXT NOT NULL DEFAULT '',provider_id TEXT,country TEXT,region TEXT,state TEXT);CREATE TABLE channel_url(channel_id TEXT,ordinal INTEGER,url TEXT,PRIMARY KEY(channel_id,ordinal));CREATE TABLE favorite(id TEXT PRIMARY KEY);CREATE TABLE channel_category_override(channel_id TEXT PRIMARY KEY,category TEXT);CREATE TABLE removed(id TEXT PRIMARY KEY);CREATE TABLE guide_mapping(catalog_source_id TEXT,app_channel_id TEXT,guide_source_id TEXT,xmltv_channel_id TEXT,PRIMARY KEY(catalog_source_id,app_channel_id));CREATE TABLE guide_source(id TEXT PRIMARY KEY,revision INTEGER,published_revision INTEGER);INSERT INTO guide_source VALUES('guide',3,2);CREATE TABLE guide_channel(guide_source_id TEXT,id TEXT,PRIMARY KEY(guide_source_id,id));CREATE TABLE guide_program(guide_source_id TEXT,channel_id TEXT,start_ms INTEGER,stop_ms INTEGER,ordinal INTEGER);CREATE INDEX guide_program_channel_time ON guide_program(guide_source_id,channel_id,start_ms,ordinal);").unwrap();
    c.execute_batch("ALTER TABLE guide_program ADD COLUMN title TEXT NOT NULL DEFAULT '';ALTER TABLE guide_program ADD COLUMN categories_json TEXT NOT NULL DEFAULT '[]';").unwrap();
    let tx = c.unchecked_transaction().unwrap();
    crate::catalog_query::install_projection(&tx).unwrap();
    crate::catalog_endpoint_projection::install(&tx).unwrap();
    tx.commit().unwrap();
    c
}
fn refresh_projection(c: &Connection) {
    let tx = c.unchecked_transaction().unwrap();
    crate::catalog_query::rebuild_projection(&tx).unwrap();
    tx.commit().unwrap();
}
fn add(c: &Connection, id: &str, start: i64, stop: Option<i64>) {
    c.execute(
        "INSERT INTO channel(id,source_id,name) VALUES(?1,'catalog','Same name')",
        [id],
    )
    .unwrap();
    c.execute(
        "INSERT INTO channel_url VALUES(?1,0,?2)",
        params![id, format!("https://example.invalid/{id}")],
    )
    .unwrap();
    c.execute(
        "INSERT INTO guide_mapping VALUES('catalog',?1,'guide',?1)",
        [id],
    )
    .unwrap();
    c.execute("INSERT INTO guide_channel VALUES('guide',?1)", [id])
        .unwrap();
    c.execute(
        "INSERT INTO guide_program(guide_source_id,channel_id,start_ms,stop_ms,ordinal) VALUES('guide',?1,?2,?3,0)",
        params![id, start, stop],
    )
    .unwrap();
    refresh_projection(c);
}
fn q(cursor: Option<String>) -> Query {
    Query {
        start_ms: 1000,
        end_ms: 2000,
        cursor,
        search: None,
        geography: serde_json::Map::new(),
        ppv: false,
        sports: None,
        history_ids: None,
        hide_adult: None,
    }
}
fn read(c: &Connection, q: &Query) -> Page {
    query(c, q, 12, Arc::new(|| false)).unwrap()
}

#[test]
fn ppv_alias_and_events_are_isolated_before_search_and_group_pagination() {
    let c = fixture();
    aliases(&c);
    c.execute_batch("UPDATE channel SET category='Sports PPV' WHERE id='b'")
        .unwrap();
    refresh_projection(&c);
    assert!(read(&c, &q(None)).channels.is_empty());
    let mut request = q(None);
    request.ppv = true;
    let page = read(&c, &request);
    assert_eq!(page.channels.len(), 1);
    assert_eq!(page.channels[0].app_channel_id, "a");
    assert_ne!(page.channels[0].filter_mask & 8, 0);
    let native = |filter: &str| {
        let request: crate::catalog_query::Query = serde_json::from_value(serde_json::json!({"schemaVersion":1,"requestId":"ppv-fixture","query":"","filter":filter,"sort":"source","pageSize":50,"after":null,"startIndex":null,"anchorId":null})).unwrap();
        crate::catalog_query::query_page(
            &c,
            &request,
            &Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap()
    };
    assert_eq!(native("all").total_count, 0);
    let ppv = native("ppv");
    assert_eq!(ppv.total_count, 1);
    assert!(ppv.rows[0].ppv);
    c.execute_batch("ALTER TABLE guide_program ADD COLUMN description TEXT;ALTER TABLE guide_program ADD COLUMN categories_key TEXT NOT NULL DEFAULT '[]';UPDATE guide_program SET title='Fixture programme'").unwrap();
    let mut programmes: crate::guide::database::ProgramQuery = serde_json::from_value(serde_json::json!({"guideSourceId":"guide","appChannelIds":["a"],"windowStartMs":1000,"windowEndMs":2000,"search":"","pageSize":100,"cursor":null,"ppv":true})).unwrap();
    assert_eq!(
        crate::guide::database::query_programs(&c, &programmes)
            .unwrap()
            .programs
            .len(),
        1
    );
    programmes.ppv = false;
    assert!(crate::guide::database::query_programs(&c, &programmes)
        .unwrap()
        .programs
        .is_empty());
    c.execute_batch("UPDATE channel SET category='Sports';UPDATE guide_program SET title='Boxing PPV 17';ALTER TABLE guide_program ADD COLUMN search_text TEXT NOT NULL DEFAULT 'boxing ppv 17'").unwrap();
    refresh_projection(&c);
    let mut normal = q(None);
    normal.search = Some("boxing".into());
    assert!(read(&c, &normal).channels.is_empty());
    normal.ppv = true;
    assert_eq!(read(&c, &normal).channels.len(), 1);
    c.execute_batch("UPDATE guide_program SET title='Boxing Preview',search_text='boxing preview'")
        .unwrap();
    assert!(read(&c, &normal).channels.is_empty());
    normal.ppv = false;
    assert_eq!(read(&c, &normal).channels.len(), 1);
    c.execute_batch("UPDATE channel SET category='PPV' WHERE id='a';DELETE FROM catalog_endpoint_projection_v1 WHERE channel_id='a'").unwrap();
    assert!(
        crate::guide::database::query_programs(&c, &programmes)
            .unwrap()
            .programs
            .is_empty(),
        "missing requested projection authority must not become ordinary programming"
    );
    programmes.ppv = true;
    assert!(crate::guide::database::query_programs(&c, &programmes)
        .unwrap()
        .programs
        .is_empty());
}
#[test]
fn drawable_boundaries_preserve_failed_refresh_cache_current_revision_and_opaque_identity() {
    let c = fixture();
    for (id, start, stop) in [
        ("overlap", 900, Some(1001)),
        ("end-at-start", 900, Some(1000)),
        ("start-at-end", 2000, Some(2100)),
        ("unknown-before", 999, None),
        ("unknown-start", 1000, None),
        ("unknown-inside", 1999, None),
        ("https://opaque.invalid/?q=a&b=\"文\"", 1200, Some(1300)),
    ] {
        add(&c, id, start, stop);
    }
    let p = read(&c, &q(None));
    assert_eq!(
        p.channels
            .iter()
            .map(|v| v.app_channel_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "https://opaque.invalid/?q=a&b=\"文\"",
            "overlap",
            "unknown-inside",
            "unknown-start"
        ]
    );
    assert!(p.channels.iter().all(|v| v.source_revision == 3));
    assert_eq!(p.catalog_revision, "7");
    assert_eq!(p.database_revision, 9);
}
#[test]
fn no_empty_unmapped_removed_or_missing_header_and_source_rows() {
    let c = fixture();
    for id in [
        "good",
        "empty",
        "unmapped",
        "removed",
        "headerless",
        "sourceless",
    ] {
        add(&c, id, 1200, Some(1300));
    }
    c.execute("DELETE FROM guide_program WHERE channel_id='empty'", [])
        .unwrap();
    c.execute(
        "DELETE FROM guide_mapping WHERE app_channel_id='unmapped'",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO removed VALUES('removed')", [])
        .unwrap();
    c.execute("DELETE FROM guide_channel WHERE id='headerless'", [])
        .unwrap();
    c.execute(
        "UPDATE guide_mapping SET guide_source_id='absent' WHERE app_channel_id='sourceless'",
        [],
    )
    .unwrap();
    let p = read(&c, &q(None));
    assert_eq!(p.channels.len(), 1);
    assert_eq!(p.channels[0].app_channel_id, "good");
}
#[test]
fn pages_are_exact_ordered_and_read_only_with_catalog_guide_root_window_cas() {
    let c = fixture();
    for i in 0..PAGE + 2 {
        add(&c, &format!("c{i:04}"), 1200, Some(1300));
    }
    c.execute_batch("PRAGMA query_only=ON").unwrap();
    let changes = c.total_changes();
    let p = read(&c, &q(None));
    assert_eq!(p.channels.len(), PAGE);
    let cursor = p.next_cursor.unwrap();
    let next = read(&c, &q(Some(cursor.clone())));
    assert_eq!(next.channels.len(), 2);
    assert!(next.next_cursor.is_none());
    assert_eq!(next.channels[0].app_channel_id, format!("c{PAGE:04}"));
    assert_eq!(changes, c.total_changes());
    assert_eq!(
        query(&c, &q(Some(cursor.clone())), 13, Arc::new(|| false)).unwrap_err(),
        "guide-listed-stale-cursor"
    );
    let mut window = q(Some(cursor.clone()));
    window.end_ms += 1;
    assert!(read_error(&c, &window).contains("cursor"));
    c.execute_batch("PRAGMA query_only=OFF;UPDATE metadata SET catalog_revision=8")
        .unwrap();
    assert_eq!(
        read_error(&c, &q(Some(cursor.clone()))),
        "guide-listed-stale-cursor"
    );
    c.execute_batch("UPDATE metadata SET catalog_revision=7;UPDATE guide_meta SET revision=10")
        .unwrap();
    assert_eq!(
        read_error(&c, &q(Some(cursor))),
        "guide-listed-stale-cursor"
    );
}
fn read_error(c: &Connection, q: &Query) -> String {
    query(c, q, 12, Arc::new(|| false)).unwrap_err()
}
#[test]
fn removal_and_preferences_race_refuses_cursor_even_without_catalog_or_guide_revision_change() {
    let c = fixture();
    for i in 0..PAGE + 2 {
        add(&c, &format!("c{i:04}"), 1200, Some(1300));
    }
    let cursor = read(&c, &q(None)).next_cursor.unwrap();
    let mut ppv_cursor = q(Some(cursor.clone()));
    ppv_cursor.ppv = true;
    assert_eq!(read_error(&c, &ppv_cursor), "guide-listed-invalid-cursor");
    c.execute_batch(&format!(
        "INSERT INTO removed VALUES('c{:04}');UPDATE metadata SET revision=revision+1;UPDATE catalog_projection_meta SET view_revision=view_revision+1",
        PAGE + 1
    ))
    .unwrap();
    assert_eq!(
        read_error(&c, &q(Some(cursor))),
        "guide-listed-stale-cursor"
    );
    let current = read(&c, &q(None));
    let next = read(&c, &q(current.next_cursor));
    assert_eq!(next.channels.len(), 1);
    assert_eq!(next.channels[0].app_channel_id, format!("c{PAGE:04}"));
    assert_eq!(next.catalog_revision, "7");
    assert_eq!(next.database_revision, 9);
}
#[test]
fn validates_window_cursor_and_cancellation_without_mutation() {
    let c = fixture();
    let changes = c.total_changes();
    for query in [
        Query {
            start_ms: 2,
            end_ms: 1,
            cursor: None,
            search: None,
            geography: serde_json::Map::new(),
            ppv: false,
            sports: None,
            history_ids: None,
            hide_adult: None,
        },
        Query {
            start_ms: 0,
            end_ms: 7 * 86_400_000 + 1,
            cursor: None,
            search: None,
            geography: serde_json::Map::new(),
            ppv: false,
            sports: None,
            history_ids: None,
            hide_adult: None,
        },
        q(Some("{}".into())),
    ] {
        assert!(super::query(&c, &query, 12, Arc::new(|| false)).is_err());
    }
    assert_eq!(
        query(&c, &q(None), 12, Arc::new(|| true)).unwrap_err(),
        "guide-cancelled"
    );
    assert_eq!(changes, c.total_changes());
}
#[test]
fn byte_bounded_adaptive_pages_preserve_long_ids_without_truncation() {
    let c = fixture();
    for i in 0..30 {
        add(
            &c,
            &format!("{i:03}{}", "文".repeat(5000)),
            1200,
            Some(1300),
        );
    }
    let first = read(&c, &q(None));
    assert!(!first.channels.is_empty());
    assert!(first.channels.len() < 30);
    assert!(first.next_cursor.is_some());
    assert!(serde_json::to_vec(&first).unwrap().len() <= MAX_BYTES);
    assert_eq!(first.channels[0].app_channel_id.len(), 15003);
}
#[test]
fn progress_cancellation_resets_handler_and_connection_remains_usable() {
    let c = fixture();
    // No drawable rows: cancellation can only be observed by the VM callback,
    // not a per-result-row check. Real out-of-window programmes prevent an
    // empty-table shortcut and require indexed EXISTS work for these mappings.
    c.execute_batch("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<4000) INSERT INTO channel(id,source_id,name) SELECT printf('c%05d',x),'catalog','Same name' FROM n;INSERT INTO guide_mapping SELECT 'catalog',id,'guide',id FROM channel;INSERT INTO guide_channel SELECT 'guide',id FROM channel;INSERT INTO channel_url SELECT id,0,'https://example.invalid/'||id FROM channel;INSERT INTO guide_program(guide_source_id,channel_id,start_ms,stop_ms,ordinal) SELECT 'guide',id,0,900,0 FROM channel;").unwrap();
    refresh_projection(&c);
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    assert_eq!(
        query(
            &c,
            &q(None),
            12,
            Arc::new(move || observed.fetch_add(1, Ordering::SeqCst) > 3)
        )
        .unwrap_err(),
        "guide-cancelled"
    );
    assert!(count.load(Ordering::SeqCst) > 3);
    assert!(read(&c, &q(None)).channels.is_empty());
}

#[test]
fn many_programs_do_not_duplicate_channel_and_missing_publication_is_not_listed() {
    let c = fixture();
    add(&c, "one", 1100, Some(1200));
    c.execute(
        "INSERT INTO guide_program(guide_source_id,channel_id,start_ms,stop_ms,ordinal) VALUES('guide','one',1200,1300,1)",
        [],
    )
    .unwrap();
    assert_eq!(read(&c, &q(None)).channels.len(), 1);
    c.execute("UPDATE guide_source SET published_revision=NULL", [])
        .unwrap();
    assert!(read(&c, &q(None)).channels.is_empty());
}

#[test]
fn full_source_identity_order_preserves_identical_names_and_rejects_orphan_catalog_source() {
    let c = fixture();
    add(&c, "z", 1100, Some(1200));
    add(&c, "a", 1100, Some(1200));
    c.execute("INSERT INTO source(id) VALUES('catalog2')", [])
        .unwrap();
    c.execute("UPDATE channel SET source_id='catalog2' WHERE id='a'", [])
        .unwrap();
    c.execute(
        "UPDATE guide_mapping SET catalog_source_id='catalog2' WHERE app_channel_id='a'",
        [],
    )
    .unwrap();
    let p = read(&c, &q(None));
    assert_eq!(
        p.channels
            .iter()
            .map(|v| v.app_channel_id.as_str())
            .collect::<Vec<_>>(),
        vec!["z", "a"]
    );
    c.execute("DELETE FROM source WHERE id='catalog2'", [])
        .unwrap();
    assert_eq!(read(&c, &q(None)).channels.len(), 1);
}

// These fixtures use the same admitted projection builders as Live; the read
// query is required to preserve every canonical/mapping/programme row.
fn aliases(c: &Connection) {
    add(c, "a", 1100, Some(1200));
    add(c, "b", 1100, Some(1200));
    c.execute_batch("UPDATE channel SET ordinal=CASE id WHEN 'a' THEN 0 ELSE 1 END;UPDATE channel_url SET url='https://example.invalid/shared';UPDATE guide_mapping SET xmltv_channel_id='a';UPDATE channel SET category=CASE id WHEN 'a' THEN 'General' ELSE 'ＮＥＷＳ / Sports' END;").unwrap();
    refresh_projection(c);
}
#[test]
fn guide_history_lists_exact_alias_and_both_ppv_cohorts_before_scope() {
    let c = fixture();
    aliases(&c);
    let mut request = q(None);
    request.history_ids = Some(vec!["b".into()]);
    let rows = read(&c, &request).channels;
    assert_eq!(
        rows.iter()
            .map(|r| r.app_channel_id.as_str())
            .collect::<Vec<_>>(),
        ["b"],
        "History must not return unwatched representative a"
    );
    c.execute_batch("UPDATE channel SET category='PPV',country='US' WHERE id='b'; UPDATE channel SET country='CA' WHERE id='a';").unwrap();
    refresh_projection(&c);
    assert_eq!(read(&c, &request).channels.len(), 1);
    assert_ne!(read(&c, &request).channels[0].filter_mask & 8, 0);
    request.geography.insert("country".into(), "CA".into());
    assert!(read(&c, &request).channels.is_empty());
    request.geography.clear();
    c.execute_batch("UPDATE channel SET category='Ａｄｕｌｔ PPV' WHERE id='b';INSERT INTO channel_category_override VALUES('b','News')").unwrap();
    refresh_projection(&c);
    assert!(read(&c, &request).channels.is_empty());
    request.hide_adult = Some(false);
    assert_eq!(read(&c, &request).channels.len(), 1);
    request.history_ids = Some(vec![]);
    assert!(read(&c, &request).channels.is_empty());
}
#[test]
fn guide_history_cache_cursor_and_malformed_scope_are_bound() {
    let c = fixture();
    aliases(&c);
    let cache = InventoryCache::default();
    let mut request = q(None);
    request.history_ids = Some(vec!["b".into()]);
    let first = cached_read(&c, &request, &cache, "same-file", 12, Arc::new(|| false)).unwrap();
    assert_eq!(first.channels[0].app_channel_id, "b");
    request.history_ids = Some(vec!["a".into()]);
    let next = cached_read(&c, &request, &cache, "same-file", 12, Arc::new(|| false)).unwrap();
    assert_eq!(next.channels[0].app_channel_id, "a");
    request.history_ids = Some(vec![]);
    assert!(
        cached_read(&c, &request, &cache, "same-file", 12, Arc::new(|| false))
            .unwrap()
            .channels
            .is_empty()
    );
    request.history_ids = Some(vec!["a".into(), "b".into()]);
    let token = Cursor {
        version: 3,
        start_ms: request.start_ms,
        end_ms: request.end_ms,
        root_generation: 12,
        catalog_revision: "7".into(),
        mutation_revision: 20,
        database_revision: 9,
        view_revision: 1,
        grouping_policy: crate::catalog_endpoint_projection::POLICY.into(),
        catalog_source_id: "catalog".into(),
        app_channel_id: "a".into(),
        seen: 1,
        search: "".into(),
        geography: Default::default(),
        ppv: false,
        sports: None,
        literal_search: "".into(),
        history_key: history_key(&request).unwrap(),
    };
    request.cursor = Some(serde_json::to_string(&token).unwrap());
    assert!(cursor(&request).is_ok());
    request.history_ids.as_mut().unwrap().reverse();
    assert!(cursor(&request).is_err());
    request.history_ids.as_mut().unwrap().reverse();
    request.hide_adult = Some(false);
    assert!(cursor(&request).is_err());
    request.cursor = None;
    for ids in [
        Some(vec!["a".into(), "a".into()]),
        Some((0..257).map(|n| format!("c{n}")).collect()),
    ] {
        request.history_ids = ids;
        assert!(query(&c, &request, 12, Arc::new(|| false)).is_err());
    }
    request.history_ids = None;
    request.hide_adult = Some(false);
    assert!(cursor(&request).is_err());
    request.hide_adult = None;
    request.history_ids = Some(vec![]);
    request.ppv = true;
    assert!(cursor(&request).is_err());
}
#[test]
fn inherited_location_matches_aliases_before_grouping_and_limits_category_facts() {
    let c = fixture();
    aliases(&c);
    add(&c, "unknown", 1100, Some(1200));
    c.execute_batch("UPDATE channel SET country='CA',region='NA',state='CA-ON' WHERE id='a';UPDATE channel SET country='US',region='NA',state='US-IL' WHERE id='b';").unwrap();
    refresh_projection(&c);
    let scoped = |geo: serde_json::Value| {
        read(
            &c,
            &Query {
                geography: geo.as_object().unwrap().clone(),
                ..q(None)
            },
        )
    };
    // Live chooses a as representative even when US matched its retained b alias.
    let us = scoped(serde_json::json!({"country":"US"}));
    assert_eq!(us.channels.len(), 1);
    assert_eq!(us.channels[0].app_channel_id, "a");
    assert_eq!(us.channels[0].filter_mask, 6);
    let ca = scoped(serde_json::json!({"country":"CA"}));
    assert_eq!(ca.channels[0].app_channel_id, "a");
    assert_eq!(ca.channels[0].filter_mask, 0);
    assert_eq!(
        scoped(serde_json::json!({"country":"US","region":"NA","state":"US-IL"}))
            .channels
            .len(),
        1
    );
    assert!(scoped(serde_json::json!({"country":"US","state":"US-CA"}))
        .channels
        .is_empty());
    assert_eq!(
        scoped(serde_json::json!({"countries":["US","CA"]}))
            .channels
            .len(),
        1
    );
    assert_eq!(
        scoped(serde_json::json!({"country":null})).channels[0].app_channel_id,
        "unknown"
    );
    assert_eq!(read(&c, &q(None)).channels.len(), 2);
}

#[test]
fn paging_cursor_cannot_be_reused_under_a_different_location() {
    let c = fixture();
    for i in 0..18 {
        add(
            &c,
            &format!("{}-{i:04}", "x".repeat(16000)),
            1100,
            Some(1200),
        );
    }
    c.execute_batch("UPDATE channel SET country='US'").unwrap();
    refresh_projection(&c);
    let mut request = q(None);
    request.geography = serde_json::json!({"country":"US"})
        .as_object()
        .unwrap()
        .clone();
    let first = read(&c, &request);
    let first_count = first.channels.len();
    request.cursor = first.next_cursor;
    assert!(request.cursor.is_some());
    assert_eq!(first_count + read(&c, &request).channels.len(), 18);
    request.geography = serde_json::json!({"country":"CA"})
        .as_object()
        .unwrap()
        .clone();
    assert_eq!(read_error(&c, &request), "guide-listed-invalid-cursor");
    request.geography.clear();
    assert_eq!(read_error(&c, &request), "guide-listed-invalid-cursor");
}
#[test]
fn exact_live_groups_keep_alias_category_facts_and_preserve_all_underlying_rows() {
    let c = fixture();
    aliases(&c);
    c.execute_batch("PRAGMA query_only=ON").unwrap();
    let changes = c.total_changes();
    let p = read(&c, &q(None));
    assert_eq!(
        p.channels
            .iter()
            .map(|v| v.app_channel_id.as_str())
            .collect::<Vec<_>>(),
        vec!["a"]
    );
    let value = serde_json::to_value(p).unwrap();
    assert_eq!(value["channels"][0]["filterMask"], 6);
    assert_eq!(
        value["groupingPolicy"],
        crate::catalog_endpoint_projection::POLICY
    );
    assert!(value["viewRevision"].is_string());
    for table in ["channel", "guide_mapping", "guide_program"] {
        assert_eq!(
            c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
    assert_eq!(changes, c.total_changes());
}
#[test]
fn group_partitions_keep_explicit_choices_and_promote_surviving_alias() {
    let c = fixture();
    aliases(&c);
    c.execute("INSERT INTO favorite VALUES('b')", []).unwrap();
    assert_eq!(read(&c, &q(None)).channels.len(), 2);
    let value = serde_json::to_value(read(&c, &q(None))).unwrap();
    assert_eq!(value["channels"][1]["filterMask"], 7);
    c.execute_batch(
        "DELETE FROM favorite;INSERT INTO channel_category_override VALUES('b','Sports')",
    )
    .unwrap();
    refresh_projection(&c);
    assert_eq!(read(&c, &q(None)).channels.len(), 2);
    c.execute_batch("DELETE FROM channel_category_override;UPDATE guide_mapping SET xmltv_channel_id='b' WHERE app_channel_id='b'")
        .unwrap();
    refresh_projection(&c);
    assert_eq!(read(&c, &q(None)).channels.len(), 2);
    c.execute_batch(
        "UPDATE guide_mapping SET xmltv_channel_id='a';INSERT INTO removed VALUES('a')",
    )
    .unwrap();
    assert_eq!(read(&c, &q(None)).channels[0].app_channel_id, "b");
}
#[test]
fn endpoint_order_grants_media_policy_and_signed_queries_never_merge_by_name_or_guide_id() {
    let c = fixture();
    aliases(&c);
    for sql in [
        "UPDATE channel_url SET url='https://example.invalid/shared?token=other' WHERE channel_id='b'",
        "UPDATE channel_url SET url='https://example.invalid/shared';INSERT INTO channel_url VALUES('a',1,'https://example.invalid/fallback')",
        "DELETE FROM channel_url WHERE ordinal=1;INSERT INTO source(id,allow_http) VALUES('grant',1);UPDATE channel SET source_id='grant' WHERE id='b';UPDATE guide_mapping SET catalog_source_id='grant' WHERE app_channel_id='b'",
        "UPDATE source SET allow_http=0,content_kind='media',media_mime='video/mp4' WHERE id='grant'",
    ] {
        c.execute_batch(sql).unwrap(); refresh_projection(&c);
        assert_eq!(read(&c,&q(None)).channels.len(),2);
    }
}
#[test]
fn display_revision_and_policy_changes_refuse_paged_group_snapshot() {
    let c = fixture();
    for i in 0..PAGE + 2 {
        add(&c, &format!("c{i:04}"), 1100, Some(1200));
    }
    let cursor = read(&c, &q(None)).next_cursor.unwrap();
    c.execute(
        "UPDATE catalog_projection_meta SET view_revision=view_revision+1",
        [],
    )
    .unwrap();
    assert_eq!(
        read_error(&c, &q(Some(cursor))),
        "guide-listed-stale-cursor"
    );
    c.execute(
        "UPDATE catalog_projection_meta SET query_version='future-policy'",
        [],
    )
    .unwrap();
    assert_eq!(read_error(&c, &q(None)), "guide-listed-projection-stale");
}
#[test]
fn incomplete_endpoint_or_category_projection_never_yields_partial_success() {
    for table in ["catalog_endpoint_projection_v1", "catalog_projection"] {
        let c = fixture();
        aliases(&c);
        c.execute(&format!("DELETE FROM {table} WHERE channel_id='b'"), [])
            .unwrap();
        assert_eq!(read_error(&c, &q(None)), "guide-listed-projection-stale");
    }
}

#[test]
fn search_keeps_channels_whose_name_or_one_window_program_has_every_word() {
    let c = fixture();
    c.execute_batch("ALTER TABLE guide_program ADD COLUMN search_text TEXT NOT NULL DEFAULT ''")
        .unwrap();
    for (id, name, start, text) in [
        ("nfl-network", "NFL Network", 1100, "fishing tips"),
        ("espn", "ESPN", 1200, "sportscenter (nfl) live highlights"),
        ("history", "History", 1150, "conflict zone documentary"),
        ("espn-later", "ESPN 2", 2500, "nfl live"),
        ("news", "Ｎｅｗｓ Now", 1300, "morning news"),
    ] {
        add(&c, id, start, Some(start + 50));
        c.execute("UPDATE channel SET name=?2 WHERE id=?1", params![id, name])
            .unwrap();
        c.execute(
            "UPDATE guide_program SET search_text=?2 WHERE channel_id=?1",
            params![id, text],
        )
        .unwrap();
    }
    // espn-later has a listing only after the window, so it is never listed here.
    add(&c, "espn-later-now", 1400, Some(1450));
    refresh_projection(&c);
    let ids = |search: Option<&str>| {
        read(
            &c,
            &Query {
                search: search.map(str::to_owned),
                ..q(None)
            },
        )
        .channels
        .into_iter()
        .map(|v| v.app_channel_id)
        .collect::<Vec<_>>()
    };
    // Words match at word starts, also after punctuation; "conflict" is not "nfl".
    assert_eq!(ids(Some("nfl")), ["espn", "nfl-network"]);
    assert_eq!(ids(Some("onflict")), Vec::<String>::new());
    assert_eq!(ids(Some("confl")), ["history"]);
    // Every word must appear in the channel or in one program.
    assert_eq!(ids(Some("NFL  Live")), ["espn"]);
    // Folded like stored text: full-width letters and case.
    assert_eq!(ids(Some("ｎｅｗｓ")), ["news"]);
    assert_eq!(ids(Some("   ")).len(), ids(None).len());
    assert!(ids(Some("cricket")).is_empty());
    for bad in [
        "a\u{7}b".to_owned(),
        "x".repeat(257),
        "a b c d e f g h i".to_owned(),
    ] {
        let query = Query {
            search: Some(bad),
            ..q(None)
        };
        assert_eq!(read_error(&c, &query), "guide-listed-invalid-search");
    }
}
#[test]
fn search_cursor_belongs_to_its_search() {
    let c = fixture();
    c.execute_batch(
        "ALTER TABLE guide_program ADD COLUMN search_text TEXT NOT NULL DEFAULT 'match'",
    )
    .unwrap();
    for i in 0..PAGE + 2 {
        add(&c, &format!("c{i:04}"), 1100, Some(1200));
    }
    let first = read(
        &c,
        &Query {
            search: Some("Match".into()),
            ..q(None)
        },
    );
    assert_eq!(first.channels.len(), PAGE);
    let cursor = first.next_cursor.clone();
    let rest = read(
        &c,
        &Query {
            search: Some("match".into()),
            ..q(cursor.clone())
        },
    );
    assert_eq!(rest.channels.len(), 2);
    for other in [None, Some("other".to_owned())] {
        let query = Query {
            search: other,
            ..q(cursor.clone())
        };
        assert_eq!(read_error(&c, &query), "guide-listed-invalid-cursor");
    }
}

fn inventory_fixture(count: usize) -> Connection {
    let c = fixture();
    c.execute_batch(
        "ALTER TABLE guide_program ADD COLUMN search_text TEXT NOT NULL DEFAULT 'sports'",
    )
    .unwrap();
    c.execute_batch(&format!("WITH RECURSIVE ids(n) AS(VALUES(0) UNION ALL SELECT n+1 FROM ids WHERE n+1<{count}) INSERT INTO channel(id,source_id,name) SELECT printf('bulk-%05d',n),'catalog','Sports' FROM ids; INSERT INTO channel_url SELECT id,0,'https://example.invalid/'||id FROM channel; INSERT INTO guide_mapping SELECT 'catalog',id,'guide',id FROM channel; INSERT INTO guide_channel SELECT 'guide',id FROM channel; INSERT INTO guide_program(guide_source_id,channel_id,start_ms,stop_ms,ordinal) SELECT 'guide',id,1200,1300,0 FROM channel;")).unwrap();
    refresh_projection(&c);
    c
}
fn cached_read(
    c: &Connection,
    query: &Query,
    cache: &InventoryCache,
    stamp: &str,
    generation: u64,
    cancel: Cancel,
) -> Result<Page, String> {
    query_inner(
        c,
        query,
        generation,
        cancel,
        Some((cache, stamp, &|| Ok(()))),
    )
}
#[test]
fn inventory_cache_reuses_complete_grouping_across_pages_and_unrelated_writes() {
    let c = inventory_fixture(PAGE + 3);
    c.execute_batch("ALTER TABLE metadata ADD COLUMN health_revision INTEGER NOT NULL DEFAULT 0")
        .unwrap();
    let cache = InventoryCache::default();
    let checks = Arc::new(AtomicUsize::new(0));
    let counter = checks.clone();
    let cancel: Cancel = Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        false
    });
    let before = c.total_changes();
    let first = cached_read(&c, &q(None), &cache, "file-A", 12, cancel.clone()).unwrap();
    let cold = checks.swap(0, Ordering::SeqCst);
    assert_eq!(before, c.total_changes());
    // Health and unrelated preference writes do not change membership authority.
    c.execute_batch("UPDATE metadata SET health_revision=health_revision+1,revision=revision+1")
        .unwrap();
    let next = cached_read(&c, &q(first.next_cursor), &cache, "file-A", 12, cancel).unwrap();
    let warm = checks.load(Ordering::SeqCst);
    assert_eq!(next.channels.len(), 3);
    assert!(next.next_cursor.is_none());
    assert!(cold > PAGE && warm < cold / 10, "cold {cold}, warm {warm}");
    assert_eq!(
        serde_json::to_value(&next).unwrap(),
        serde_json::to_value(read(&c, &q(read(&c, &q(None)).next_cursor))).unwrap()
    );
}
#[test]
fn inventory_cache_keys_all_logical_revisions_scope_and_file_generation() {
    let c = inventory_fixture(2);
    let cache = InventoryCache::default();
    let get = |query: &Query, stamp: &str, generation| {
        cached_read(&c, query, &cache, stamp, generation, Arc::new(|| false)).unwrap()
    };
    assert_eq!(get(&q(None), "A", 12).channels.len(), 2);
    let mut ppv = q(None);
    ppv.ppv = true;
    assert!(get(&ppv, "A", 12).channels.is_empty());
    assert_eq!(get(&q(None), "A", 12).channels.len(), 2);
    c.execute_batch("DELETE FROM guide_program WHERE channel_id='bulk-00001';UPDATE guide_meta SET revision=revision+1").unwrap();
    assert_eq!(get(&q(None), "A", 12).channels.len(), 1);
    c.execute_batch("INSERT INTO guide_program(guide_source_id,channel_id,start_ms,stop_ms,ordinal) VALUES('guide','bulk-00001',1200,1300,0);UPDATE metadata SET catalog_revision=catalog_revision+1").unwrap();
    assert_eq!(get(&q(None), "A", 12).channels.len(), 2);
    c.execute_batch("INSERT INTO removed VALUES('bulk-00001');UPDATE catalog_projection_meta SET view_revision=view_revision+1").unwrap();
    assert_eq!(get(&q(None), "A", 12).channels.len(), 1);
    // Same revision numbers on a replacement/root generation cannot reuse old rows.
    c.execute_batch("DELETE FROM removed").unwrap();
    assert_eq!(get(&q(None), "B", 12).channels.len(), 2);
    c.execute_batch("INSERT INTO removed VALUES('bulk-00001')")
        .unwrap();
    assert_eq!(get(&q(None), "B", 13).channels.len(), 1);
    let mut location = q(None);
    location.geography.insert("country".into(), "US".into());
    assert!(get(&location, "B", 13).channels.is_empty());
    let mut search = q(None);
    search.search = Some("missing".into());
    assert!(get(&search, "B", 13).channels.is_empty());
    let mut window = q(None);
    window.start_ms = 1400;
    window.end_ms = 1500;
    assert!(get(&window, "B", 13).channels.is_empty());
}
#[test]
fn cancelled_inventory_never_publishes_partial_cache_and_retained_bytes_are_bounded() {
    let c = inventory_fixture(40);
    let cache = InventoryCache::default();
    let checks = Arc::new(AtomicUsize::new(0));
    let counter = checks.clone();
    assert!(cached_read(
        &c,
        &q(None),
        &cache,
        "A",
        12,
        Arc::new(move || counter.fetch_add(1, Ordering::SeqCst) > 10)
    )
    .is_err());
    assert!(cache.inspect().lock().unwrap().is_none());
    assert_eq!(
        cached_read(&c, &q(None), &cache, "A", 12, Arc::new(|| false))
            .unwrap()
            .channels
            .len(),
        40
    );
    let guard = cache.inspect().lock().unwrap();
    let rows = &guard.as_ref().unwrap().1;
    assert!(rows.iter().map(cache::retained_bytes).sum::<usize>() <= cache::MAX_RETAINED_BYTES);
    assert!(rows.len() <= cache::MAX_RETAINED_ROWS);
}
#[test]
fn inventory_file_identity_detects_replacement_with_identical_bytes_and_revisions() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("guide.sqlite");
    let copy = root.path().join("replacement.sqlite");
    std::fs::write(&path, b"identical sqlite snapshot bytes").unwrap();
    std::fs::copy(&path, &copy).unwrap();
    let old = database_stamp(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::rename(copy, &path).unwrap();
    assert_ne!(old, database_stamp(&path).unwrap());
}

#[test]
fn oversized_inventory_falls_back_to_byte_bounded_pages_without_retaining_partial_rows() {
    let c = inventory_fixture(40);
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("guide.sqlite");
    c.execute("VACUUM INTO ?1", [path.to_str().unwrap()])
        .unwrap();
    let disk = Connection::open(&path).unwrap();
    let stamp = database_stamp(&path).unwrap();
    let cache = InventoryCache::with_limit(4096);
    let page = query_cached(
        &disk,
        &q(None),
        12,
        Arc::new(|| false),
        &cache,
        &path,
        &stamp,
    )
    .unwrap();
    assert!(!page.channels.is_empty());
    assert_eq!(page.channels.len(), 40);
    assert!(serde_json::to_vec(&page).unwrap().len() <= MAX_BYTES);
    assert!(cache.inspect().lock().unwrap().is_none());
}

#[test]
fn real_store_health_commit_between_guide_pages_preserves_membership_cursor_and_cache() {
    use crate::{
        guide::{
            database as db,
            parser::{GuideChannel, GuideProgram, ParsedGuide},
        },
        storage_transaction::PairStore,
    };
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let source =
        serde_json::json!({"id":"catalog","name":"Fixture","kind":"file","location":"fixture.m3u"});
    let channels:Vec<_>=(0..PAGE+2).map(|i|serde_json::json!({"id":format!("ch-{i:05}"),"sourceId":"catalog","name":format!("Channel {i}"),"category":"Sports","urls":[format!("https://example.invalid/{i}")]})).collect();
    let catalog = serde_json::json!({"schemaVersion":1,"sources":[source],"channels":channels});
    let prefs = serde_json::json!({"schemaVersion":1,"sources":catalog["sources"],"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":300});
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    store.with_guide_write(|c|{
        db::save_source(c,&db::GuideSource{id:"g".into(),name:"Guide".into(),location:"https://example.invalid/guide".into(),kind:"url".into(),allow_http:false,revision:0,updated_ms:None},0)?;
        db::replace_guide(c,"g",1,&ParsedGuide{channels:vec![GuideChannel{id:"listing".into(),names:vec!["Listing".into()]}],programs:vec![GuideProgram{channel_id:"listing".into(),start_ms:1200,stop_ms:Some(1300),title:"Live sport".into(),description:None,categories:vec![]}]},1000,&std::sync::atomic::AtomicBool::new(false))?;
        c.execute_batch("INSERT INTO guide_mapping(catalog_source_id,app_channel_id,guide_source_id,xmltv_channel_id) SELECT source_id,id,'g','listing' FROM channel;UPDATE guide_meta SET revision=revision+1").map_err(|_|"fixture")?;Ok(())
    }).unwrap();
    let first = store
        .query_listed_guide(&q(None), 12, Arc::new(|| false))
        .unwrap();
    let fingerprint =
        crate::health_storage::fingerprint(&catalog["sources"][0], &catalog["channels"][0], 0)
            .unwrap();
    let incoming=serde_json::json!({"schemaVersion":1,"records":[{"schemaVersion":1,"channelId":"ch-00000","sourceId":"catalog","checkedUrlOrdinal":0,"targetFingerprint":fingerprint,"platform":"windows","observerProfile":"native-mse-v1","observedAt":100,"verdict":"Reachable","evidence":{"kind":"http","status":200,"contentRecognized":true},"origin":"local"}]}).to_string();
    let health = store
        .write_health_guarded(&incoming, &first.catalog_revision, "0", || Ok(()))
        .unwrap();
    assert_eq!(health.catalog_revision, first.catalog_revision);
    assert_eq!(health.health_revision, "1");
    let checks = Arc::new(AtomicUsize::new(0));
    let counter = checks.clone();
    let next = store
        .query_listed_guide(
            &q(first.next_cursor),
            12,
            Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                false
            }),
        )
        .unwrap();
    assert_eq!(next.channels.len(), 2);
    assert!(next.next_cursor.is_none());
    assert_eq!(next.view_revision, first.view_revision);
    assert!(
        checks.load(Ordering::SeqCst) < 20,
        "health-only commit must not rebuild the catalog grouping"
    );
}

#[test]
fn sports_inventory_admits_affiliate_programmes_and_sets_only_real_ppv_bits() {
    let c = fixture();
    c.execute_batch("ALTER TABLE guide_program ADD COLUMN description TEXT;")
        .unwrap();
    for id in ["a", "b", "c", "d"] {
        add(&c, id, 1200, Some(1800));
    }
    c.execute_batch("UPDATE channel SET name='FOX 43',category='News' WHERE id='a';UPDATE guide_program SET title='Chicago Bears at Detroit Lions' WHERE channel_id='a';UPDATE channel SET name='Event 2',category='US NFL PPV' WHERE id='b';UPDATE guide_program SET title='NFL Game' WHERE channel_id='b';UPDATE channel SET category='NBA PPV' WHERE id='c';UPDATE guide_program SET title='NBA Finals' WHERE channel_id='c';UPDATE guide_program SET title='NFL PPV Game' WHERE channel_id='d';").unwrap();
    refresh_projection(&c);
    let mut query = q(None);
    query.search = Some("NFL".into());
    query.sports = Some(crate::catalog::sports::Scope {
        sport: None,
        league: None,
        include_ppv: true,
        window_start_ms: 1000,
        window_end_ms: 2000,
        vocabulary_version: serde_json::from_str::<serde_json::Value>(
            crate::catalog::sports::VOCABULARY,
        )
        .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    });
    let page = read(&c, &query);
    assert_eq!(
        page.channels
            .iter()
            .map(|c| c.app_channel_id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b", "d"]
    );
    assert_eq!(
        page.channels
            .iter()
            .map(|c| c.filter_mask & 8)
            .collect::<Vec<_>>(),
        [0, 8, 8]
    );
    c.execute_batch("INSERT INTO guide_program(guide_source_id,channel_id,start_ms,stop_ms,ordinal,title,categories_json) VALUES('guide','d',1300,1900,1,'NFL Pregame','[]')").unwrap();
    assert_eq!(
        read(&c, &query)
            .channels
            .iter()
            .find(|r| r.app_channel_id == "d")
            .unwrap()
            .filter_mask
            & 8,
        0
    );
    query.sports.as_mut().unwrap().include_ppv = false;
    assert_eq!(
        read(&c, &query)
            .channels
            .iter()
            .map(|c| c.app_channel_id.as_str())
            .collect::<Vec<_>>(),
        ["a", "d"]
    );
    query.ppv = true;
    assert_eq!(
        read(&c, &query)
            .channels
            .iter()
            .map(|c| c.app_channel_id.as_str())
            .collect::<Vec<_>>(),
        ["b", "d"]
    );
}

#[test]
fn sports_listed_cursor_binds_literal_spacing_and_metadata_mask_uses_registry() {
    let c = inventory_fixture(PAGE + 2);
    c.execute_batch(
        "ALTER TABLE guide_program ADD COLUMN description TEXT;UPDATE channel SET name='foo bar';",
    )
    .unwrap();
    refresh_projection(&c);
    let mut query = q(None);
    query.search = Some("foo bar".into());
    query.sports = Some(crate::catalog::sports::Scope {
        sport: None,
        league: None,
        include_ppv: false,
        window_start_ms: 1000,
        window_end_ms: 2000,
        vocabulary_version: serde_json::from_str::<serde_json::Value>(
            crate::catalog::sports::VOCABULARY,
        )
        .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    });
    query.cursor = read(&c, &query).next_cursor;
    assert!(query.cursor.is_some());
    assert_eq!(read(&c, &query).channels.len(), 2);
    query.search = Some("foo  bar".into());
    assert_eq!(read_error(&c, &query), "guide-listed-invalid-cursor");
    let c = fixture();
    add(&c, "nfl", 1200, Some(1800));
    c.execute_batch("UPDATE channel SET category='News',name='Chicago Bears Channel'")
        .unwrap();
    refresh_projection(&c);
    assert_eq!(read(&c, &q(None)).channels[0].filter_mask & 4, 4);
}

#[test]
fn sports_collegiate_programme_context_admits_observed_acc_guide_membership() {
    let c = fixture();
    c.execute_batch("ALTER TABLE guide_program ADD COLUMN description TEXT;")
        .unwrap();
    for id in ["a", "b", "c", "d"] {
        add(&c, id, 1200, Some(1800));
    }
    c.execute_batch(r#"UPDATE channel SET name='ACC Digital Network',category='Sports';UPDATE channel SET name='Unknown Football Channel' WHERE id='d';UPDATE guide_program SET title='Miami vs. Duke (11.30.19) Football Replay',description='Duke takes down Miami in future Blue Devils head coach Manny Diaz first year with the Hurricanes.';UPDATE guide_program SET categories_json='[{"text":"Basketball"}]' WHERE channel_id='b';UPDATE guide_program SET categories_json='[{"text":"Soccer"}]' WHERE channel_id='c';"#).unwrap();
    refresh_projection(&c);
    let mut query = q(None);
    query.search = Some("Football".into());
    query.sports = Some(crate::catalog::sports::Scope {
        sport: Some("american-football".into()),
        league: None,
        include_ppv: true,
        window_start_ms: 1000,
        window_end_ms: 2000,
        vocabulary_version: serde_json::from_str::<serde_json::Value>(
            crate::catalog::sports::VOCABULARY,
        )
        .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    });
    let page = read(&c, &query);
    assert_eq!(
        page.channels
            .iter()
            .map(|c| c.app_channel_id.as_str())
            .collect::<Vec<_>>(),
        ["a"]
    );
    assert_eq!(page.channels[0].filter_mask & 8, 0);
}
