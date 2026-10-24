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
fn fixture(count: usize) -> (tempfile::TempDir, PairStore, Value, Value) {
    let dir = tempfile::tempdir().unwrap();
    let store = PairStore::new(dir.path().into()).unwrap();
    let source = json!({"id":"source","name":"Fixture","kind":"file","location":"fixture.m3u"});
    let catalog = json!({"schemaVersion":1,"sources":[source],"channels":(0..count).map(channel).collect::<Vec<_>>()});
    let preferences = json!({"schemaVersion":1,"sources":catalog["sources"],"favorites":[],"removedChannels":[],"volume":0.5,"muted":false,"panelWidth":300});
    store
        .write_pair(&catalog.to_string(), &preferences.to_string())
        .unwrap();
    let c = connect(&dir.path().join(DB), false).unwrap();
    c.execute_batch("CREATE TABLE delta_audit(tab TEXT,op TEXT);")
        .unwrap();
    for table in ["source", "channel", "channel_url"] {
        for (op, event) in [
            ("insert", "INSERT"),
            ("update", "UPDATE"),
            ("delete", "DELETE"),
        ] {
            c.execute_batch(&format!(
                "CREATE TRIGGER audit_{table}_{op} AFTER {event} ON {table} BEGIN INSERT INTO delta_audit VALUES('{table}','{op}');END;"
            ))
            .unwrap();
        }
    }
    (dir, store, catalog, preferences)
}
fn channel(index: usize) -> Value {
    json!({"id":format!("channel-{index}"),"sourceId":"source","providerId":format!("provider-{index}"),"name":format!("Fixture {index}"),"category":"Sports","urls":[format!("https://example.invalid/{index}.m3u8")]})
}
fn writes(dir: &Path, table: &str, operation: &str) -> i64 {
    connect(&dir.join(DB), true)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM delta_audit WHERE tab=?1 AND op=?2",
            params![table, operation],
            |r| r.get(0),
        )
        .unwrap()
}
fn reset(dir: &Path) {
    connect(&dir.join(DB), false)
        .unwrap()
        .execute("DELETE FROM delta_audit", [])
        .unwrap();
}
fn assert_catalog(store: &PairStore, expected: &Value) {
    let actual: Value =
        serde_json::from_str(store.read_pair().unwrap().catalog.as_ref().unwrap()).unwrap();
    assert_eq!(actual["channels"], expected["channels"]);
    assert_eq!(actual["sources"][0]["id"], expected["sources"][0]["id"]);
}
#[test]
fn delta_append_64_to_2000_and_identical_catalog_have_only_changed_writes() {
    let (dir, store, mut catalog, prefs) = fixture(2000);
    catalog["channels"]
        .as_array_mut()
        .unwrap()
        .extend((2000..2064).map(channel));
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    assert_eq!(writes(dir.path(), "channel", "insert"), 64);
    assert_eq!(writes(dir.path(), "channel", "update"), 0);
    assert_eq!(writes(dir.path(), "channel", "delete"), 0);
    assert_eq!(writes(dir.path(), "channel_url", "insert"), 64);
    assert_eq!(writes(dir.path(), "channel_url", "delete"), 0);
    assert_eq!(
        writes(dir.path(), "source", "insert")
            + writes(dir.path(), "source", "update")
            + writes(dir.path(), "source", "delete"),
        0
    );
    assert_catalog(&store, &catalog);
    reset(dir.path());
    let before = store.read_snapshot().unwrap();
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    for table in ["source", "channel", "channel_url"] {
        for op in ["insert", "update", "delete"] {
            assert_eq!(writes(dir.path(), table, op), 0);
        }
    }
    let after = store.read_snapshot().unwrap();
    assert_eq!(before.catalog_revision, after.catalog_revision);
    assert_eq!(before.health_revision, after.health_revision);
    assert_catalog(&PairStore::new(dir.path().into()).unwrap(), &catalog);
}
#[test]
fn delta_url_only_and_metadata_reorder_preserve_ordinals_without_unrelated_churn() {
    let (dir, store, mut catalog, prefs) = fixture(4);
    catalog["channels"][2]["urls"] = json!([
        "https://example.invalid/new.m3u8",
        "https://example.invalid/alternate.m3u8"
    ]);
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    assert_eq!(writes(dir.path(), "channel", "update"), 0);
    assert_eq!(writes(dir.path(), "channel_url", "delete"), 1);
    assert_eq!(writes(dir.path(), "channel_url", "insert"), 2);
    reset(dir.path());
    catalog["channels"][1]["name"] = json!("Changed fixture");
    catalog["channels"][1]["geography"] = json!({"country":"US","state":"US-IL"});
    catalog["channels"].as_array_mut().unwrap().reverse();
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    assert_eq!(writes(dir.path(), "channel", "update"), 4);
    assert_eq!(
        writes(dir.path(), "channel_url", "delete") + writes(dir.path(), "channel_url", "insert"),
        0
    );
    assert_catalog(&store, &catalog);
}
#[test]
fn delta_moves_channels_before_deleting_source_and_cascades_only_missing_urls() {
    let (dir, store, mut catalog, mut prefs) = fixture(3);
    catalog["sources"][0]["id"] = json!("replacement");
    catalog["sources"][0]["name"] = json!("Replacement");
    catalog["channels"].as_array_mut().unwrap().pop();
    for ch in catalog["channels"].as_array_mut().unwrap() {
        ch["sourceId"] = json!("replacement");
    }
    prefs["sources"] = catalog["sources"].clone();
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    assert_eq!(writes(dir.path(), "source", "insert"), 1);
    assert_eq!(writes(dir.path(), "source", "delete"), 1);
    assert_eq!(writes(dir.path(), "channel", "update"), 2);
    assert_eq!(writes(dir.path(), "channel", "delete"), 1);
    assert_eq!(writes(dir.path(), "channel_url", "delete"), 1);
    let c = connect(&dir.path().join(DB), true).unwrap();
    let mut statement = c.prepare("PRAGMA foreign_key_check").unwrap();
    assert!(!statement.exists([]).unwrap());
    assert_catalog(&store, &catalog);
}
#[test]
fn delta_actual_transaction_fault_and_stale_cas_leave_canonical_health_projection_unchanged() {
    let (dir, store, mut catalog, prefs) = fixture(5);
    let before = store.read_snapshot().unwrap();
    catalog["channels"].as_array_mut().unwrap().push(channel(5));
    let pair = RecordPair {
        catalog: Some(catalog.to_string()),
        preferences: Some(prefs.to_string()),
    };
    for failure in [Phase::AfterCatalog, Phase::BeforeCommit] {
        assert!(store
            .commit(&pair, |phase| if phase == failure {
                Err("fixture-phase".into())
            } else {
                Ok(())
            })
            .is_err());
        assert_eq!(store.read_snapshot().unwrap(), before);
        assert_eq!(writes(dir.path(), "channel", "insert"), 0);
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        assert_eq!(
            store
                .query_catalog_page(&tests::catalog_query(), &flag)
                .unwrap()
                .total_count,
            5
        );
    }
    assert_eq!(
        store
            .write_guarded_cas(
                pair.catalog.as_ref().unwrap(),
                pair.preferences.as_ref().unwrap(),
                None,
                (Some("0"), Some(&before.health_revision)),
                || Ok(())
            )
            .unwrap_err(),
        "catalog-revision-stale"
    );
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert_eq!(writes(dir.path(), "channel", "insert"), 0);
    let receipt = store
        .write_guarded_cas(
            pair.catalog.as_ref().unwrap(),
            pair.preferences.as_ref().unwrap(),
            None,
            (
                Some(&before.catalog_revision),
                Some(&before.health_revision),
            ),
            || Ok(()),
        )
        .unwrap();
    assert!(receipt.committed);
    assert_eq!(writes(dir.path(), "channel", "insert"), 1);
}
#[test]
fn delta_first_catalog_cleans_preferences_only_sources_and_empty_catalog_deletes_children_first() {
    let dir = tempfile::tempdir().unwrap();
    let store = PairStore::new(dir.path().into()).unwrap();
    let mut prefs = json!({"schemaVersion":1,"sources":[{"id":"stale","name":"Stale","kind":"file","location":"old.m3u"}],"favorites":[],"removedChannels":[],"volume":0.5,"muted":false,"panelWidth":300});
    store.write("preferences", &prefs.to_string()).unwrap();
    let mut catalog = json!({"schemaVersion":1,"sources":[{"id":"source","name":"Fixture","kind":"file","location":"fixture.m3u"}],"channels":[channel(0)]});
    prefs["sources"] = catalog["sources"].clone();
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    assert_catalog(&store, &catalog);
    assert_eq!(
        connect(&dir.path().join(DB), true)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM source", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    catalog["sources"] = json!([]);
    catalog["channels"] = json!([]);
    prefs["sources"] = json!([]);
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    let read: Value =
        serde_json::from_str(store.read_pair().unwrap().catalog.as_ref().unwrap()).unwrap();
    assert_eq!(read, catalog);
}

#[test]
fn delta_url_position_changes_keep_unchanged_rows_and_handle_unique_url_swaps() {
    let (dir, store, mut catalog, prefs) = fixture(1);
    catalog["channels"][0]["urls"] = json!([
        "https://example.invalid/a",
        "https://example.invalid/b",
        "https://example.invalid/c"
    ]);
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    reset(dir.path());
    catalog["channels"][0]["urls"][1] = json!("https://example.invalid/d");
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    assert_eq!(writes(dir.path(), "channel_url", "delete"), 1);
    assert_eq!(writes(dir.path(), "channel_url", "insert"), 1);
    assert_eq!(writes(dir.path(), "channel", "update"), 0);
    reset(dir.path());
    catalog["channels"][0]["urls"]
        .as_array_mut()
        .unwrap()
        .swap(0, 2);
    store
        .write_pair(&catalog.to_string(), &prefs.to_string())
        .unwrap();
    assert_eq!(writes(dir.path(), "channel_url", "delete"), 2);
    assert_eq!(writes(dir.path(), "channel_url", "insert"), 2);
    assert_catalog(&store, &catalog);
}
