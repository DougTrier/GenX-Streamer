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
    }
}
fn read(c: &Connection, q: &Query) -> Page {
    query(c, q, 12, Arc::new(|| false)).unwrap()
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
    c.execute_batch(&format!(
        "INSERT INTO removed VALUES('c{:04}');UPDATE metadata SET revision=revision+1",
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
        },
        Query {
            start_ms: 0,
            end_ms: 7 * 86_400_000 + 1,
            cursor: None,
            search: None,
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
    c.execute_batch("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<4000) INSERT INTO channel(id,source_id,name) SELECT printf('c%05d',x),'catalog','Same name' FROM n;INSERT INTO guide_mapping SELECT 'catalog',id,'guide',id FROM channel;INSERT INTO guide_channel SELECT 'guide',id FROM channel;INSERT INTO channel_url SELECT id,0,'https://example.invalid/'||id FROM channel;INSERT INTO guide_program SELECT 'guide',id,0,900,0 FROM channel;").unwrap();
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
        "INSERT INTO guide_program VALUES('guide','one',1200,1300,1)",
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
    c.execute_batch("DELETE FROM channel_category_override;UPDATE guide_mapping SET xmltv_channel_id='b' WHERE app_channel_id='b'").unwrap();
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
