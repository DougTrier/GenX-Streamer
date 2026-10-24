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

//! Exact SQLite differential and operation-local visit fixtures; no device timing claims.
use super::super::{connect, parse, validate, PairStore, Phase, RecordPair, DB};
use super::*;
use serde_json::json;

fn channel(index: usize) -> Value {
    json!({"id":format!("channel-{index}"),"sourceId":"source","providerId":format!("provider-{index}"),"name":format!("Fixture {index}"),"category":"Sports","urls":[format!("https://fixture.invalid/{index}.m3u8")]})
}
fn fixture(count: usize) -> (tempfile::TempDir, PairStore, Value, Value) {
    let dir = tempfile::tempdir().unwrap();
    let store = PairStore::new(dir.path().into()).unwrap();
    let catalog = json!({"schemaVersion":1,"sources":[{"id":"source","name":"Fixture","kind":"file","location":"fixture.m3u"}],"channels":(0..count).map(channel).collect::<Vec<_>>()});
    let prefs = json!({"schemaVersion":1,"sources":catalog["sources"],"favorites":[],"removedChannels":[],"volume":0.5,"muted":false,"panelWidth":300});
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    let connection = connect(&dir.path().join(DB), false).unwrap();
    connection
        .execute_batch("CREATE TABLE compact_audit(tab TEXT, op TEXT);")
        .unwrap();
    for table in ["source", "channel", "channel_url"] {
        for (operation, event) in [
            ("insert", "INSERT"),
            ("update", "UPDATE"),
            ("delete", "DELETE"),
        ] {
            connection.execute_batch(&format!("CREATE TRIGGER compact_{table}_{operation} AFTER {event} ON {table} BEGIN INSERT INTO compact_audit VALUES('{table}','{operation}');END;")).unwrap();
        }
    }
    let pair = store.read_pair().unwrap();
    (
        dir,
        store,
        parse(pair.catalog.as_ref().unwrap()).unwrap(),
        parse(pair.preferences.as_ref().unwrap()).unwrap(),
    )
}
fn canonical_sql(connection: &Connection) -> Vec<Vec<Vec<SqlValue>>> {
    ["source", "channel", "channel_url"]
        .iter()
        .map(|table| {
            let mut statement = connection
                .prepare(&format!("SELECT * FROM {table} ORDER BY 1,2"))
                .unwrap();
            let columns = statement.column_count();
            let mut rows = statement.query([]).unwrap();
            let mut result = Vec::new();
            while let Some(row) = rows.next().unwrap() {
                result.push(
                    (0..columns)
                        .map(|i| row.get::<_, SqlValue>(i))
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .unwrap(),
                );
            }
            result
        })
        .collect()
}
fn audit(connection: &Connection, table: &str, operation: &str) -> i64 {
    connection
        .query_row(
            "SELECT count(*) FROM compact_audit WHERE tab=?1 AND op=?2",
            params![table, operation],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn compact_append_64_to_2000_visits_only_patch_and_unchanged_replay_has_zero_dml() {
    let (dir, store, old, _) = fixture(2000);
    let mut new = old.clone();
    new["channels"]
        .as_array_mut()
        .unwrap()
        .extend((2000..2064).map(channel));
    let ids: Vec<_> = (2000..2064).map(|i| format!("channel-{i}")).collect();
    let mut connection = connect(&dir.path().join(DB), false).unwrap();
    let tx = connection.transaction().unwrap();
    let mut visits = Vec::new();
    apply_compact_observed(&tx, Some(&old), &new, &ids, &mut |id| {
        visits.push(id.to_owned())
    })
    .unwrap();
    assert_eq!(visits, ids);
    assert_eq!(audit(&tx, "channel", "insert"), 64);
    assert_eq!(audit(&tx, "channel_url", "insert"), 64);
    for table in ["source", "channel", "channel_url"] {
        assert_eq!(audit(&tx, table, "update"), 0);
        assert_eq!(audit(&tx, table, "delete"), 0);
    }
    assert_eq!(audit(&tx, "source", "insert"), 0);
    tx.commit().unwrap();
    let current = parse(store.read_pair().unwrap().catalog.as_ref().unwrap()).unwrap();
    assert_eq!(current, new);
    connection.execute("DELETE FROM compact_audit", []).unwrap();
    let tx = connection.transaction().unwrap();
    let mut visits = Vec::new();
    apply_compact_observed(&tx, Some(&current), &current, &ids, &mut |id| {
        visits.push(id.to_owned())
    })
    .unwrap();
    assert_eq!(visits.len(), 64);
    assert_eq!(
        tx.query_row("SELECT count(*) FROM compact_audit", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    tx.commit().unwrap();
}

#[test]
fn compact_and_full_sql_match_metadata_url_order_provenance_and_source_changes() {
    let (left, compact, old, prefs) = fixture(4);
    let (right, full, _, _) = fixture(4);
    let mut new = old.clone();
    new["sources"][0]["name"] = json!("Renamed source");
    new["sources"][0]["allowHttp"] = json!(true);
    new["sources"][0]["contentKind"] = json!("catalog");
    new["channels"][1]["name"] = json!("Updated station");
    new["channels"][1]["category"] = json!("Local");
    new["channels"][1]["providerId"] = json!("provider-renamed");
    new["channels"][1]["geography"] = json!({"country":"US","state":"US-IL"});
    new["channels"][1]["geographyProvenance"] = json!([{"field":"country","value":"US","sourceId":"source","providerId":"provider-renamed","kind":"m3u","scope":"provider-declared"}]);
    new["channels"][1]["urls"] = json!([
        "https://fixture.invalid/alternate.m3u8",
        "https://fixture.invalid/1.m3u8"
    ]);
    new["channels"][3]["urls"] = json!([
        "https://fixture.invalid/b.ts",
        "https://fixture.invalid/a.ts"
    ]);
    new["channels"].as_array_mut().unwrap().push(channel(4));
    let mut prefs = prefs;
    prefs["sources"] = new["sources"].clone();
    validate(&RecordPair {
        catalog: Some(new.to_string()),
        preferences: Some(prefs.to_string()),
    })
    .unwrap();
    let mut a = connect(&left.path().join(DB), false).unwrap();
    let mut b = connect(&right.path().join(DB), false).unwrap();
    let atx = a.transaction().unwrap();
    let btx = b.transaction().unwrap();
    apply_compact(
        &atx,
        Some(&old),
        &new,
        &["channel-1".into(), "channel-3".into(), "channel-4".into()],
    )
    .unwrap();
    apply(&btx, Some(&old), &new).unwrap();
    assert_eq!(canonical_sql(&atx), canonical_sql(&btx));
    assert_eq!(audit(&atx, "channel", "update"), 1);
    assert_eq!(audit(&atx, "channel", "insert"), 1);
    assert_eq!(audit(&atx, "channel", "delete"), 0);
    assert_eq!(audit(&atx, "source", "update"), 1);
    atx.commit().unwrap();
    btx.commit().unwrap();
    assert_eq!(compact.read_pair().unwrap(), full.read_pair().unwrap());
    // A true swap of two already-persisted alternatives exercises deletion
    // ordering against UNIQUE(channel_id,url), then an alternate removal.
    let mut swapped = new.clone();
    swapped["channels"][1]["urls"]
        .as_array_mut()
        .unwrap()
        .reverse();
    swapped["channels"][3]["urls"].as_array_mut().unwrap().pop();
    let atx = a.transaction().unwrap();
    let btx = b.transaction().unwrap();
    apply_compact(
        &atx,
        Some(&new),
        &swapped,
        &["channel-1".into(), "channel-3".into()],
    )
    .unwrap();
    apply(&btx, Some(&new), &swapped).unwrap();
    assert_eq!(canonical_sql(&atx), canonical_sql(&btx));
    atx.commit().unwrap();
    btx.commit().unwrap();
    assert_eq!(compact.read_pair().unwrap(), full.read_pair().unwrap());
}

#[test]
fn incomplete_duplicate_overscope_reordered_deleted_or_unknown_scopes_refuse_before_dml() {
    let (dir, store, old, _) = fixture(4);
    let before = store.read_pair().unwrap();
    let mut connection = connect(&dir.path().join(DB), false).unwrap();
    for mode in [
        "incomplete",
        "duplicate",
        "overscope",
        "reorder",
        "delete",
        "unknown",
        "source-delete",
    ] {
        let mut new = old.clone();
        let ids = match mode {
            "incomplete" => {
                new["channels"][1]["name"] = json!("Not admitted");
                vec![]
            }
            "duplicate" => vec!["channel-1".into(), "channel-1".into()],
            "overscope" => (0..65).map(|i| format!("channel-{i}")).collect(),
            "reorder" => {
                new["channels"].as_array_mut().unwrap().swap(0, 1);
                vec!["channel-0".into(), "channel-1".into()]
            }
            "delete" => {
                new["channels"].as_array_mut().unwrap().pop();
                vec![]
            }
            "source-delete" => {
                new["sources"] = json!([]);
                vec![]
            }
            _ => vec!["missing".into()],
        };
        let tx = connection.transaction().unwrap();
        let mut visits = Vec::new();
        assert_eq!(
            apply_compact_observed(&tx, Some(&old), &new, &ids, &mut |id| visits
                .push(id.to_owned()))
            .unwrap_err(),
            "catalog-compact-scope-invalid"
        );
        assert!(visits.is_empty());
        assert_eq!(
            tx.query_row("SELECT count(*) FROM compact_audit", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        tx.rollback().unwrap();
        assert_eq!(store.read_pair().unwrap(), before);
    }
}

#[test]
fn caller_actual_compact_commit_rolls_back_trigger_failure_and_retains_late_ack() {
    let (dir, store, catalog, prefs) = super::super::pair_reuse_tests::fixture();
    let request = super::super::pair_reuse_tests::batch(&catalog, &prefs, true);
    let before = store.read_snapshot().unwrap();
    let connection = connect(&dir.path().join(DB), false).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER reject_compact BEFORE INSERT ON channel WHEN NEW.id='new' BEGIN SELECT RAISE(ABORT,'controlled');END;",
        )
        .unwrap();
    assert_eq!(
        store.commit_scan_batch(&request, || Ok(())).unwrap_err(),
        "sqlite-operation-failed"
    );
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert_eq!(
        store.read_scan_checkpoint().unwrap().checkpoint_status,
        "absent"
    );
    connection
        .execute_batch("DROP TRIGGER reject_compact")
        .unwrap();
    drop(connection);
    let mut after_commit = false;
    let receipt = store
        .commit_scan_batch_with_phase(&request, |phase| {
            if phase == Phase::AfterCommit {
                after_commit = true;
                Err("canceled".into())
            } else {
                Ok(())
            }
        })
        .unwrap();
    assert!(after_commit && receipt.committed);
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("1"));
    assert_eq!(
        PairStore::new(dir.path().into())
            .unwrap()
            .read_snapshot()
            .unwrap(),
        store.read_snapshot().unwrap()
    );
}

#[test]
fn source_grant_change_uses_original_health_invalidation_with_empty_channel_patch() {
    let (_dir, store, catalog, prefs) = super::super::pair_reuse_tests::fixture();
    let record = json!({"schemaVersion":1,"channelId":"old","sourceId":"public","checkedUrlOrdinal":0,"targetFingerprint":crate::health_storage::fingerprint(&catalog["sources"][0],&catalog["channels"][0],0).unwrap(),"platform":"windows","observerProfile":"fixture","observedAt":100,"verdict":"Reachable","origin":"local","evidence":{"kind":"recognized-media-response"}});
    store
        .write_health_guarded(
            &json!({"schemaVersion":1,"records":[record]}).to_string(),
            "1",
            "0",
            || Ok(()),
        )
        .unwrap();
    let mut request = super::super::pair_reuse_tests::batch(&catalog, &prefs, false);
    request.catalog_patch.channels.clear();
    request.catalog_patch.final_channel_count = 1;
    request.incoming_health.clear();
    request.expected_health_revision = "1".into();
    let mut source = catalog["sources"][0].clone();
    source["allowHttp"] = json!(true);
    request.catalog_patch.sources = vec![source.clone()];
    request.authorized_sources = vec![source.clone()];
    request.next_preferences["sources"] = json!([source]);
    let receipt = store.commit_scan_batch(&request, || Ok(())).unwrap();
    assert_eq!(receipt.catalog_revision, "2");
    assert_eq!(receipt.health_revision, "2");
    let snapshot = store.read_snapshot().unwrap();
    assert_eq!(
        crate::health_storage::parse(snapshot.health.as_ref().unwrap())
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        parse(snapshot.pair.catalog.as_ref().unwrap()).unwrap()["channels"],
        catalog["channels"]
    );
}

#[test]
fn preferences_only_first_catalog_uses_full_source_cleanup_fallback() {
    let (left, compact, _old, _) = fixture(0);
    let (right, full, _, _) = fixture(0);
    let mut a = connect(&left.path().join(DB), false).unwrap();
    let mut b = connect(&right.path().join(DB), false).unwrap();
    a.execute("UPDATE metadata SET catalog_present=0", [])
        .unwrap();
    b.execute("UPDATE metadata SET catalog_present=0", [])
        .unwrap();
    assert!(compact.read_pair().unwrap().catalog.is_none());
    let mut entry = channel(0);
    entry["sourceId"] = json!("replacement");
    let new = json!({"schemaVersion":1,"sources":[{"id":"replacement","name":"Replacement","kind":"file","location":"replacement.m3u"}],"channels":[entry]});
    let atx = a.transaction().unwrap();
    let btx = b.transaction().unwrap();
    apply_compact(&atx, None, &new, &["channel-0".into()]).unwrap();
    apply(&btx, None, &new).unwrap();
    assert_eq!(canonical_sql(&atx), canonical_sql(&btx));
    assert_eq!(
        atx.query_row("SELECT count(*) FROM source WHERE id='source'", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
    assert_eq!(audit(&atx, "source", "delete"), 1);
    atx.execute("UPDATE metadata SET catalog_present=1", [])
        .unwrap();
    btx.execute("UPDATE metadata SET catalog_present=1", [])
        .unwrap();
    atx.commit().unwrap();
    btx.commit().unwrap();
    assert_eq!(compact.read_pair().unwrap(), full.read_pair().unwrap());
}
