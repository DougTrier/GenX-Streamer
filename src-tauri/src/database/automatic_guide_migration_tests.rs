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

fn fixture(enabled: Option<bool>) -> RecordPair {
    let sources = json!([{"id":"source","name":"Fixture","kind":"url","location":"https://example.invalid/list.m3u"}]);
    let catalog = json!({"schemaVersion":1,"sources":sources,"channels":[{"id":"channel","sourceId":"source","name":"Fixture channel","category":"Sports","urls":["https://example.invalid/live.m3u8"]}]});
    let mut preferences = json!({"schemaVersion":1,"sources":sources,"favorites":["channel"],"removedChannels":["absent"],"volume":0.5,"muted":true,"panelWidth":300,"reviewedChannelProviders":[],"reviewedGuideProviders":[],"preferredRegion":{"country":"US","state":"US-IL","postal":"00501","origin":"manual"}});
    if let Some(enabled) = enabled {
        preferences["automaticGuideUpdates"] = json!(enabled);
    }
    RecordPair {
        catalog: Some(catalog.to_string()),
        preferences: Some(preferences.to_string()),
    }
}

fn saved_flag(store: &PairStore) -> bool {
    let pair = store.read_pair().unwrap();
    serde_json::from_str::<Value>(pair.preferences.as_ref().unwrap()).unwrap()
        ["automaticGuideUpdates"]
        .as_bool()
        .unwrap_or(true)
}

#[test]
fn schema10_migration_preserves_legacy_absence_and_verified_preupgrade_backup() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let input = fixture(None);
    store
        .write_pair(
            input.catalog.as_ref().unwrap(),
            input.preferences.as_ref().unwrap(),
        )
        .unwrap();
    let connection = connect(&root.path().join(DB), false).unwrap();
    connection
        .execute_batch(
            "DROP TABLE public_archive_variant_v1;DROP TABLE public_archive_item_v1;DROP TABLE public_archive_preference_v1;DROP TABLE public_archive_removal_v1;DROP TABLE public_archive_checkpoint_v1;DROP TABLE archive_bookmark_v1;DROP TABLE archive_bookmark_meta_v1;DROP TABLE archive_file_v1;DROP TABLE archive_item_progress_v1;DROP TABLE archive_progress_v1;DROP TABLE archive_preferences_v1;DROP TABLE archive_removal_v1;DROP TABLE archive_title_v1;DROP TABLE archive_catalog_meta_v1;DROP TABLE catalog_endpoint_projection_v1;ALTER TABLE metadata DROP COLUMN automatic_guide_updates;PRAGMA user_version=10;",
        )
        .unwrap();
    let before = PairStore::read_connection(&connection).unwrap();
    let before_metadata: (i64, i64, i64) = connection
        .query_row(
            "SELECT revision,catalog_revision,health_revision FROM metadata",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    drop(connection);
    drop(store);
    let pending = PairStore {
        root: root.path().into(),
        require_database: true,
        page_cache: Default::default(),
    };
    let mut observed_preupgrade_backup = false;
    pending
        .recover_observed(|phase| {
            if phase == RecoveryPhase::Migration {
                let backup = connect(&root.path().join(BACKUP), true).unwrap();
                assert_eq!(
                    backup
                        .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                        .unwrap(),
                    10
                );
                assert_eq!(PairStore::read_connection(&backup).unwrap(), before);
                observed_preupgrade_backup = true;
            }
        })
        .unwrap();
    assert!(observed_preupgrade_backup);
    let migrated = PairStore::new(root.path().into()).unwrap();
    assert!(saved_flag(&migrated));
    let after = migrated.read_pair().unwrap();
    assert_eq!(after.catalog, before.catalog);
    assert_eq!(after, before);
    assert!(
        serde_json::from_str::<Value>(after.preferences.as_ref().unwrap())
            .unwrap()
            .get("automaticGuideUpdates")
            .is_none()
    );
    let current = connect(&root.path().join(DB), true).unwrap();
    let after_metadata: (i64, i64, i64) = current
        .query_row(
            "SELECT revision,catalog_revision,health_revision FROM metadata",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(after_metadata, before_metadata);
    assert_eq!(
        current
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        16
    );
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        10
    );
    assert_eq!(PairStore::read_connection(&backup).unwrap(), before);
}

#[test]
fn disabled_survives_reopen_and_catalog_only_save_while_legacy_import_defaults_enabled() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let input = fixture(Some(false));
    store
        .write_pair(
            input.catalog.as_ref().unwrap(),
            input.preferences.as_ref().unwrap(),
        )
        .unwrap();
    store
        .write("catalog", input.catalog.as_ref().unwrap())
        .unwrap();
    assert!(!saved_flag(&store));
    let reopened = PairStore::new(root.path().into()).unwrap();
    assert!(!saved_flag(&reopened));
    let legacy = fixture(None);
    reopened
        .write_pair(
            legacy.catalog.as_ref().unwrap(),
            legacy.preferences.as_ref().unwrap(),
        )
        .unwrap();
    assert!(saved_flag(&reopened));
    let read = reopened.read_pair().unwrap();
    assert!(
        serde_json::from_str::<Value>(read.preferences.as_ref().unwrap())
            .unwrap()
            .get("automaticGuideUpdates")
            .is_none()
    );
    let import_root = tempfile::tempdir().unwrap();
    let imported = PairStore::new(import_root.path().into()).unwrap();
    imported
        .write_pair(
            read.catalog.as_ref().unwrap(),
            read.preferences.as_ref().unwrap(),
        )
        .unwrap();
    assert!(saved_flag(&imported));
    let enabled = fixture(Some(true));
    imported
        .write_pair(
            enabled.catalog.as_ref().unwrap(),
            enabled.preferences.as_ref().unwrap(),
        )
        .unwrap();
    let explicit = imported.read_pair().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(explicit.preferences.as_ref().unwrap()).unwrap()
            ["automaticGuideUpdates"],
        true
    );
}

#[test]
fn stale_cas_and_precommit_failure_cannot_change_disabled_choice() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let input = fixture(Some(false));
    store
        .write_pair(
            input.catalog.as_ref().unwrap(),
            input.preferences.as_ref().unwrap(),
        )
        .unwrap();
    let before = store.read_snapshot().unwrap();
    let changed = fixture(Some(true));
    assert_eq!(
        store
            .write_records_with_phase(&changed, None, (Some("0"), None), None, |_| Ok(()))
            .unwrap_err(),
        "catalog-revision-stale"
    );
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert_eq!(
        store
            .write_records_with_phase(
                &changed,
                None,
                (Some(&before.catalog_revision), None),
                None,
                |phase| {
                    if phase == Phase::BeforeCommit {
                        Err("fixture-canceled".into())
                    } else {
                        Ok(())
                    }
                }
            )
            .unwrap_err(),
        "fixture-canceled"
    );
    assert_eq!(store.read_snapshot().unwrap(), before);
    assert!(!saved_flag(&store));
}

#[test]
fn invalid_boolean_and_future_schema_refuse_without_replacing_data() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let input = fixture(Some(false));
    store
        .write_pair(
            input.catalog.as_ref().unwrap(),
            input.preferences.as_ref().unwrap(),
        )
        .unwrap();
    let before = store.read_snapshot().unwrap();
    let mut invalid: Value = serde_json::from_str(input.preferences.as_ref().unwrap()).unwrap();
    invalid["automaticGuideUpdates"] = json!("false");
    assert_eq!(
        store
            .write("preferences", &invalid.to_string())
            .unwrap_err(),
        "record-invalid-automatic-guide-updates"
    );
    assert_eq!(store.read_snapshot().unwrap(), before);
    let connection = connect(&root.path().join(DB), false).unwrap();
    connection.execute_batch("PRAGMA user_version=99").unwrap();
    drop(connection);
    let db = std::fs::read(root.path().join(DB)).unwrap();
    let backup = std::fs::read(root.path().join(BACKUP)).unwrap();
    assert_eq!(
        PairStore::new(root.path().into()).err().unwrap(),
        "sqlite-unsupported-schema"
    );
    assert_eq!(std::fs::read(root.path().join(DB)).unwrap(), db);
    assert_eq!(std::fs::read(root.path().join(BACKUP)).unwrap(), backup);
}
