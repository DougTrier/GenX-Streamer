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

fn fixture(count: usize) -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,catalog_revision INTEGER);INSERT INTO metadata VALUES(1,7);CREATE TABLE channel(id TEXT PRIMARY KEY,source_id TEXT,provider_id TEXT,name TEXT,category TEXT,ordinal INTEGER,country TEXT,region TEXT,state TEXT,geography_provenance TEXT);CREATE INDEX channel_geography ON channel(country,region,state);CREATE TABLE source(id TEXT PRIMARY KEY,name TEXT);INSERT INTO source VALUES('source','Original source');CREATE TABLE favorite(id TEXT PRIMARY KEY);CREATE TABLE removed(id TEXT PRIMARY KEY);CREATE TABLE channel_category_override(channel_id TEXT PRIMARY KEY,category TEXT,ordinal INTEGER);").unwrap();
    for i in 0..count {
        add(&c, i);
    }
    let tx = c.transaction().unwrap();
    install_projection(&tx).unwrap();
    tx.commit().unwrap();
    c.execute_batch("CREATE TABLE projection_audit(kind TEXT);CREATE TRIGGER audit_projection_insert AFTER INSERT ON catalog_projection BEGIN INSERT INTO projection_audit VALUES('insert');END;CREATE TRIGGER audit_projection_update AFTER UPDATE ON catalog_projection BEGIN INSERT INTO projection_audit VALUES('update');END;CREATE TRIGGER audit_projection_delete AFTER DELETE ON catalog_projection BEGIN INSERT INTO projection_audit VALUES('delete');END;CREATE TRIGGER audit_projection_meta AFTER UPDATE ON catalog_projection_meta BEGIN INSERT INTO projection_audit VALUES('meta');END;").unwrap();
    c
}
fn add(c: &Connection, i: usize) {
    c.execute(
        "INSERT INTO channel VALUES(?1,'source',?2,?3,'Sports',?4,'US',NULL,'US-IL',NULL)",
        params![
            format!("channel-{i:06}"),
            format!("provider-{i}"),
            format!("Station {i}"),
            i as i64
        ],
    )
    .unwrap();
}
fn ids(range: std::ops::Range<usize>) -> Vec<String> {
    range.map(|i| format!("channel-{i:06}")).collect()
}
fn projection(c: &Connection) -> Vec<Vec<SqlValue>> {
    let mut q = c
        .prepare("SELECT * FROM catalog_projection ORDER BY channel_id")
        .unwrap();
    let mut rows = q.query([]).unwrap();
    let mut values = Vec::new();
    while let Some(row) = rows.next().unwrap() {
        values.push(
            (0..10)
                .map(|i| row.get::<_, SqlValue>(i))
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap(),
        );
    }
    values
}
fn query(text: &str) -> Query {
    Query {
        schema_version: 1,
        request_id: "projection-fixture".into(),
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
fn page(c: &Connection, q: &Query) -> Value {
    serde_json::to_value(query_page(c, q, &Arc::new(AtomicBool::new(false))).unwrap()).unwrap()
}
fn dml(c: &Connection, kind: &str) -> i64 {
    c.query_row(
        "SELECT count(*) FROM projection_audit WHERE kind=?1",
        [kind],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn adding64_to2000_visits64_and_repeated_unchanged_scope_has_zero_dml() {
    let mut c = fixture(2000);
    for i in 2000..2064 {
        add(&c, i);
    }
    let changed = ids(2000..2064);
    let mut visited = 0;
    let tx = c.transaction().unwrap();
    reconcile_projection_observed(&tx, &changed, &mut || visited += 1).unwrap();
    tx.commit().unwrap();
    assert_eq!(visited, 64);
    assert_eq!(dml(&c, "insert"), 64);
    assert_eq!(dml(&c, "update"), 0);
    assert_eq!(dml(&c, "delete"), 0);
    assert_eq!(dml(&c, "meta"), 0);
    c.execute("DELETE FROM projection_audit", []).unwrap();
    let changes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let hook = changes.clone();
    c.update_hook(Some(
        move |_action: rusqlite::hooks::Action, _db: &str, _table: &str, _row: i64| {
            hook.fetch_add(1, Ordering::SeqCst);
        },
    ))
    .unwrap();
    let tx = c.transaction().unwrap();
    reconcile_projection(&tx, &changed).unwrap();
    tx.commit().unwrap();
    assert_eq!(
        changes.load(Ordering::SeqCst),
        0,
        "including FTS shadow tables and metadata"
    );
}

#[test]
fn affected_changes_match_full_rebuild_for_keys_filters_fts_deletions_and_ordinals() {
    let mut affected = fixture(6);
    let mut full = fixture(6);
    let mutation="UPDATE channel SET name='Evening News' WHERE id='channel-000000';UPDATE channel SET category='Kids',country='CA',state='CA-ON' WHERE id='channel-000001';UPDATE channel SET provider_id='CNN.us@HD' WHERE id='channel-000002';UPDATE channel SET source_id='different' WHERE id='channel-000003';UPDATE channel SET ordinal=0 WHERE id='channel-000004';UPDATE channel SET ordinal=4 WHERE id='channel-000000';DELETE FROM channel WHERE id='channel-000005';INSERT INTO favorite VALUES('channel-000001');INSERT INTO removed VALUES('channel-000002');";
    affected.execute_batch(mutation).unwrap();
    full.execute_batch(mutation).unwrap();
    add(&affected, 6);
    add(&full, 6);
    let changed = ids(0..7);
    let tx = affected.transaction().unwrap();
    reconcile_projection(&tx, &changed).unwrap();
    advance_view_revision(&tx, true).unwrap();
    tx.commit().unwrap();
    let tx = full.transaction().unwrap();
    rebuild_projection(&tx).unwrap();
    advance_view_revision(&tx, true).unwrap();
    tx.commit().unwrap();
    assert_eq!(projection(&affected), projection(&full));
    for text in [
        "",
        "evening news",
        "children",
        "CNN",
        "Ontario",
        "Station 6",
    ] {
        for sort in [Sort::Source, Sort::Name, Sort::Geography] {
            for filter in [Filter::All, Filter::Favorites, Filter::News, Filter::Sports] {
                for favorites_first in [false, true] {
                    let mut q = query(text);
                    q.sort = sort;
                    q.filter = filter;
                    q.favorites_first = favorites_first;
                    assert_eq!(page(&affected, &q), page(&full, &q));
                }
            }
        }
    }
    let mut geography = query("");
    geography
        .geography
        .insert("country".into(), Value::String("CA".into()));
    assert_eq!(page(&affected, &geography), page(&full, &geography));
}

#[test]
fn source_display_rename_and_live_favorite_removal_need_no_projection_rewrite_but_invalidate_cursor(
) {
    let mut c = fixture(4);
    let before = projection(&c);
    let mut q = query("");
    q.page_size = 1;
    let old = query_page(&c, &q, &Arc::new(AtomicBool::new(false))).unwrap();
    let tx = c.transaction().unwrap();
    tx.execute_batch("UPDATE source SET name='Renamed source';INSERT INTO favorite VALUES('channel-000003');INSERT INTO removed VALUES('channel-000001');UPDATE metadata SET catalog_revision=catalog_revision+1;").unwrap();
    reconcile_projection(&tx, &[]).unwrap();
    advance_view_revision(&tx, true).unwrap();
    tx.commit().unwrap();
    assert_eq!(projection(&c), before);
    assert_eq!(dml(&c, "insert") + dml(&c, "update") + dml(&c, "delete"), 0);
    q.expected_catalog_revision = Some(old.catalog_revision.clone());
    q.expected_view_revision = Some(old.view_revision.clone());
    q.after = old.after;
    assert!(query_page(&c, &q, &Arc::new(AtomicBool::new(false))).is_err());
    let mut favorites = query("");
    favorites.filter = Filter::Favorites;
    assert_eq!(page(&c, &favorites)["rows"][0]["id"], "channel-000003");
    assert_eq!(page(&c, &query(""))["totalCount"], 3);
}

#[test]
fn category_override_and_old_query_version_fallback_preserve_full_results() {
    let mut c = fixture(4);
    let mut full = fixture(4);
    for connection in [&c, &full] {
        connection.execute_batch("INSERT INTO channel_category_override VALUES('channel-000002','Animation',0);UPDATE catalog_projection_meta SET query_version='old-version';UPDATE catalog_projection SET stamp=x'00';DELETE FROM projection_audit;").unwrap();
    }
    let mut visited = 0;
    let tx = c.transaction().unwrap();
    reconcile_projection_observed(&tx, &[], &mut || visited += 1).unwrap();
    tx.commit().unwrap();
    let tx = full.transaction().unwrap();
    rebuild_projection(&tx).unwrap();
    tx.commit().unwrap();
    assert_eq!(visited, 0);
    assert_eq!(dml(&c, "update"), 4);
    assert_eq!(projection(&c), projection(&full));
    assert_eq!(
        page(&c, &query("cartoons")),
        page(&full, &query("cartoons"))
    );
    assert_eq!(page(&c, &query("cartoons"))["totalCount"], 1);
}

#[test]
fn invalid_scope_and_actual_sql_failure_roll_back_without_partial_index_changes() {
    let mut c = fixture(4);
    let before = projection(&c);
    for invalid in [
        ids(0..65),
        vec!["channel-000000".into(), "channel-000000".into()],
    ] {
        let tx = c.transaction().unwrap();
        assert_eq!(
            reconcile_projection(&tx, &invalid).unwrap_err(),
            "catalog-projection-invalid-scope"
        );
        tx.rollback().unwrap();
        assert_eq!(projection(&c), before);
    }
    c.execute_batch("CREATE TRIGGER refuse_projection BEFORE UPDATE ON catalog_projection BEGIN SELECT RAISE(ABORT,'controlled failure');END;").unwrap();
    let tx = c.transaction().unwrap();
    tx.execute(
        "UPDATE channel SET name='Changed' WHERE id='channel-000000'",
        [],
    )
    .unwrap();
    assert!(reconcile_projection(&tx, &ids(0..1)).is_err());
    tx.rollback().unwrap();
    assert_eq!(projection(&c), before);
    assert_eq!(page(&c, &query("Changed"))["totalCount"], 0);
    assert_eq!(dml(&c, "update"), 0);
}

#[test]
fn compact_transaction_category_override_fallback_updates_unpatched_row_and_survives_reopen() {
    use crate::scan_batch::{Batch, Patch};
    use crate::storage_transaction::{PairStore, RecordPair};
    let left = tempfile::tempdir().unwrap();
    let right = tempfile::tempdir().unwrap();
    let compact = PairStore::new(left.path().into()).unwrap();
    let full = PairStore::new(right.path().into()).unwrap();
    let source = serde_json::json!({"id":"source","name":"Source","kind":"url","location":"https://example.invalid/list.m3u","allowHttp":false});
    let mut catalog = serde_json::json!({"schemaVersion":1,"sources":[source],"channels":[{"id":"old","sourceId":"source","name":"Old","category":"Sports","urls":["https://example.invalid/old.m3u8"]}]});
    let mut prefs = serde_json::json!({"schemaVersion":1,"sources":catalog["sources"],"favorites":["old"],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":350});
    for store in [&compact, &full] {
        store
            .write_pair(&catalog.to_string(), &prefs.to_string())
            .unwrap();
    }
    let channel = serde_json::json!({"id":"new","sourceId":"source","name":"New","category":"Sports","urls":["https://example.invalid/new.m3u8"]});
    prefs["channelCategoryOverrides"] = serde_json::json!([{"channelId":"old","category":"News"}]);
    let batch = Batch {
        schema_version: 1,
        catalog_patch: Patch {
            schema_version: 1,
            base_source_count: 1,
            base_channel_count: 1,
            final_source_count: 1,
            final_channel_count: 2,
            sources: vec![],
            channels: vec![channel.clone()],
        },
        authorized_sources: catalog["sources"].as_array().unwrap().clone(),
        next_preferences: prefs.clone(),
        incoming_health: vec![],
        expected_catalog_revision: "1".into(),
        expected_health_revision: "0".into(),
        scan_checkpoint: None,
        expected_checkpoint_revision: None,
    };
    let receipt = compact.commit_scan_batch(&batch, || Ok(())).unwrap();
    catalog["channels"].as_array_mut().unwrap().push(channel);
    let full_receipt = full
        .write_pair_with_scan(
            &RecordPair {
                catalog: Some(catalog.to_string()),
                preferences: Some(prefs.to_string()),
            },
            Some("{\"schemaVersion\":1,\"records\":[]}"),
            (Some("1"), Some("0")),
            None,
            || Ok(()),
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(receipt).unwrap(),
        serde_json::to_value(full_receipt).unwrap()
    );
    assert_eq!(
        compact.read_snapshot().unwrap(),
        full.read_snapshot().unwrap()
    );
    let c = Connection::open(left.path().join(crate::storage_transaction::DB)).unwrap();
    let f = Connection::open(right.path().join(crate::storage_transaction::DB)).unwrap();
    assert_eq!(projection(&c), projection(&f));
    let mut news = query("");
    news.filter = Filter::News;
    assert_eq!(page(&c, &news)["rows"][0]["id"], "old");
    drop(c);
    drop(f);
    drop(compact);
    let reopened = PairStore::new(left.path().into()).unwrap();
    assert_eq!(
        reopened.read_snapshot().unwrap(),
        full.read_snapshot().unwrap()
    );
}
