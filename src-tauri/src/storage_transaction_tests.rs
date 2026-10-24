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
use std::fs;
#[test]
fn guide_capture_wire_contains_only_pair_and_atomic_catalog_revision() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let original = pair(2);
    store
        .write_pair(
            original.catalog.as_ref().unwrap(),
            original.preferences.as_ref().unwrap(),
        )
        .unwrap();
    let full = store.read_snapshot().unwrap();
    let narrow = store.read_guide_capture().unwrap();
    assert_eq!(narrow.pair, full.pair);
    assert_eq!(narrow.catalog_revision, full.catalog_revision);
    let wire = serde_json::to_value(narrow).unwrap();
    assert_eq!(wire.as_object().unwrap().len(), 3);
    assert!(wire.get("health").is_none());
    assert!(wire.get("checkpoint").is_none());
}
#[test]
fn guide_capture_releases_sqlite_read_lock_before_pair_validation_and_keeps_old_revision() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let old = pair(2);
    let new = pair(3);
    store
        .write_pair(
            old.catalog.as_ref().unwrap(),
            old.preferences.as_ref().unwrap(),
        )
        .unwrap();
    let old_revision = store.read_snapshot().unwrap().catalog_revision;
    let captured = store
        .read_guide_capture_after_capture(|| {
            store.write_pair(
                new.catalog.as_ref().unwrap(),
                new.preferences.as_ref().unwrap(),
            )
        })
        .unwrap();
    assert_eq!(canonical(&captured.pair), canonical(&old));
    assert_eq!(captured.catalog_revision, old_revision);
    assert_ne!(
        store.read_guide_capture().unwrap().catalog_revision,
        old_revision
    );
}
#[test]
fn guide_capture_refuses_corrupt_pair_without_mutating_database() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let original = pair(2);
    store
        .write_pair(
            original.catalog.as_ref().unwrap(),
            original.preferences.as_ref().unwrap(),
        )
        .unwrap();
    let connection = connect(&root.path().join(DB), false).unwrap();
    connection
        .execute_batch("PRAGMA ignore_check_constraints=ON")
        .unwrap();
    connection
        .execute("UPDATE preference SET volume=2", [])
        .unwrap();
    drop(connection);
    let before = fs::read(root.path().join(DB)).unwrap();
    assert!(store.read_guide_capture().is_err());
    assert_eq!(fs::read(root.path().join(DB)).unwrap(), before);
}
#[test]
fn scan_health_projection_keeps_captured_revisions_without_catalog_json_in_ipc() {
    let snapshot = RecordSnapshot {
        pair: RecordPair {
            catalog: Some("large-catalog-data".repeat(100_000)),
            preferences: Some("private-preferences".into()),
        },
        health: Some("{\"schemaVersion\":1,\"records\":[]}".into()),
        catalog_revision: "17".into(),
        health_revision: "9".into(),
    };
    let projected = ScanHealthSnapshot::from(snapshot);
    let wire = serde_json::to_value(projected).unwrap();
    assert_eq!(wire.as_object().unwrap().len(), 3);
    assert_eq!(wire["catalogRevision"], "17");
    assert_eq!(wire["healthRevision"], "9");
    assert!(wire.get("catalog").is_none());
    assert!(wire.get("preferences").is_none());
    assert!(wire["health"].as_str().unwrap().contains("records"));
}
pub(super) fn catalog_query() -> crate::catalog_query::Query {
    crate::catalog_query::Query {
        schema_version: 1,
        request_id: "catalog-fixture".into(),
        expected_catalog_revision: None,
        expected_view_revision: None,
        query: String::new(),
        filter: crate::catalog_query::Filter::All,
        geography: serde_json::Map::new(),
        sort: crate::catalog_query::Sort::Source,
        favorites_first: false,
        hide_adult: false,
        after: None,
        start_index: None,
        anchor_id: None,
        page_size: 50,
    }
}
#[test]
fn catalog_v8_migration_preserves_canonical_backup_and_installs_actual_read_path() {
    let root = tempfile::tempdir().unwrap();
    let original = pair(4);
    let store = PairStore::new(root.path().into()).unwrap();
    store
        .write_pair(
            original.catalog.as_ref().unwrap(),
            original.preferences.as_ref().unwrap(),
        )
        .unwrap();
    {
        let c = connect(&root.path().join(DB), false).unwrap();
        c.execute_batch("DROP TABLE public_archive_variant_v1;DROP TABLE public_archive_item_v1;DROP TABLE public_archive_preference_v1;DROP TABLE public_archive_removal_v1;DROP TABLE public_archive_checkpoint_v1;DROP TABLE archive_bookmark_v1;DROP TABLE archive_bookmark_meta_v1;DROP TABLE archive_file_v1;DROP TABLE archive_item_progress_v1;DROP TABLE archive_progress_v1;DROP TABLE archive_preferences_v1;DROP TABLE archive_removal_v1;DROP TABLE archive_title_v1;DROP TABLE archive_catalog_meta_v1;DROP TABLE catalog_endpoint_projection_v1;DROP TABLE catalog_trigram;DROP TABLE catalog_shortgram;DROP TABLE catalog_projection;DROP TABLE catalog_projection_meta;DROP INDEX catalog_channel_state;DROP INDEX catalog_channel_region;ALTER TABLE metadata DROP COLUMN automatic_guide_updates;PRAGMA user_version=8;").unwrap();
    }
    let reopened = PairStore::new(root.path().into()).unwrap();
    assert_eq!(
        canonical(&reopened.read_pair().unwrap()),
        canonical(&original)
    );
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let page = reopened
        .query_catalog_page(&catalog_query(), &flag)
        .unwrap();
    assert_eq!(page.rows[0].id, "channel-4");
    assert_eq!(page.total_count, 1);
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        8
    );
    assert_eq!(
        canonical(&PairStore::read_connection(&backup).unwrap()),
        canonical(&original)
    );
}
#[test]
fn catalog_view_revision_changes_only_for_catalog_or_preference_identity_and_rollback() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let original = pair(5);
    store
        .write_pair(
            original.catalog.as_ref().unwrap(),
            original.preferences.as_ref().unwrap(),
        )
        .unwrap();
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let first = store.query_catalog_page(&catalog_query(), &flag).unwrap();
    let mut pref: Value = serde_json::from_str(original.preferences.as_ref().unwrap()).unwrap();
    pref["volume"] = json!(0.75);
    store.write("preferences", &pref.to_string()).unwrap();
    let volume = store.query_catalog_page(&catalog_query(), &flag).unwrap();
    assert_eq!(first.view_revision, volume.view_revision);
    assert_eq!(first.catalog_revision, volume.catalog_revision);
    pref["favorites"] = json!(["channel-5", "missing"]);
    store.write("preferences", &pref.to_string()).unwrap();
    let favorite = store.query_catalog_page(&catalog_query(), &flag).unwrap();
    assert_ne!(favorite.view_revision, volume.view_revision);
    assert_eq!(favorite.catalog_revision, volume.catalog_revision);
    assert!(favorite.rows[0].favorite);
    pref["favorites"] = json!(["missing", "channel-5"]);
    store.write("preferences", &pref.to_string()).unwrap();
    assert_eq!(
        store
            .query_catalog_page(&catalog_query(), &flag)
            .unwrap()
            .view_revision,
        favorite.view_revision
    );
    let replacement = pair(6);
    assert!(store
        .write_records_with_phase(&replacement, None, (None, None), None, |phase| {
            if phase == Phase::BeforeCommit {
                Err("injected-cancel".into())
            } else {
                Ok(())
            }
        })
        .is_err());
    let retained = store.query_catalog_page(&catalog_query(), &flag).unwrap();
    assert_eq!(retained.rows[0].id, "channel-5");
    assert_eq!(retained.view_revision, favorite.view_revision);
    let old_projection = store
        .with_guide_read(|c| {
            sql(c.query_row(
                "SELECT rowid,stamp FROM catalog_projection WHERE channel_id='channel-5'",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)),
            ))
        })
        .unwrap();
    store
        .write("catalog", original.catalog.as_ref().unwrap())
        .unwrap();
    let same_projection = store
        .with_guide_read(|c| {
            sql(c.query_row(
                "SELECT rowid,stamp FROM catalog_projection WHERE channel_id='channel-5'",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)),
            ))
        })
        .unwrap();
    assert_eq!(old_projection, same_projection);
    pref["removedChannels"] = json!(["channel-5"]);
    store.write("preferences", &pref.to_string()).unwrap();
    assert!(store
        .query_catalog_page(&catalog_query(), &flag)
        .unwrap()
        .rows
        .is_empty());
    assert_eq!(
        serde_json::from_str::<Value>(store.read("preferences").unwrap().as_ref().unwrap())
            .unwrap()["favorites"],
        json!(["missing", "channel-5"])
    );
}
#[test]
fn existing_v1_catalog_migrates_to_v11_with_verified_v1_backup() {
    let root = tempfile::tempdir().unwrap();
    let original = pair(42);
    {
        // Intentional owned legacy fixture creation; production connections
        // refuse missing databases instead of creating empty replacements.
        fs::write(root.path().join(DB), b"").unwrap();
        let mut c = connect(&root.path().join(DB), false).unwrap();
        c.execute_batch(SCHEMA).unwrap();
        PairStore::apply(&mut c, &original, |_| Ok(())).unwrap();
    }
    let store = PairStore::new(root.path().into()).unwrap();
    assert_eq!(canonical(&store.read_pair().unwrap()), canonical(&original));
    store
        .with_guide_read(|c| {
            assert_eq!(
                c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                16
            );
            assert!(crate::guide::database::list_sources(c)?.is_empty());
            Ok(())
        })
        .unwrap();
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    integrity(&backup).unwrap();
    drop(backup);
    fs::write(root.path().join(DB), b"corrupted guide database").unwrap();
    let recovered = PairStore::new(root.path().into()).unwrap();
    assert_eq!(
        canonical(&recovered.read_pair().unwrap()),
        canonical(&original)
    );
    recovered
        .with_guide_read(|c| {
            assert_eq!(
                c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                16
            );
            Ok(())
        })
        .unwrap();
}
#[test]
fn geography_roundtrip_preferences_write_recovery_and_v2_migration() {
    let root = tempfile::tempdir().unwrap();
    let original = pair(7);
    {
        fs::write(root.path().join(DB), b"").unwrap();
        let mut c = connect(&root.path().join(DB), false).unwrap();
        c.execute_batch(SCHEMA).unwrap();
        PairStore::apply(&mut c, &original, |_| Ok(())).unwrap();
        crate::guide::database::migrate(&mut c).unwrap();
        c.execute(
            "INSERT INTO guide_source VALUES('guide','Saved guide','fixture','file',0,1,NULL,0)",
            [],
        )
        .unwrap();
    }
    let store = PairStore::new(root.path().into()).unwrap();
    store
        .with_guide_read(|c| {
            assert_eq!(
                c.query_row("SELECT count(*) FROM guide_source", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            Ok(())
        })
        .unwrap();
    let mut record: Value = serde_json::from_str(original.catalog.as_ref().unwrap()).unwrap();
    record["channels"][0]["geography"] = json!({"country":"US","region":"AMER","state":"US-IL"});
    record["channels"][0]["geographyProvenance"] = json!([{"field":"country","value":"US","sourceId":"source","kind":"m3u","scope":"channel-origin"},{"field":"state","value":"US-IL","sourceId":"source","kind":"user","scope":"user-reviewed"}]);
    store.write("catalog", &record.to_string()).unwrap();
    store
        .write("preferences", original.preferences.as_ref().unwrap())
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(store.read("catalog").unwrap().as_ref().unwrap()).unwrap(),
        record
    );
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        16
    );
    drop(backup);
    fs::write(root.path().join(DB), b"corrupt").unwrap();
    let recovered = PairStore::new(root.path().into()).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(recovered.read("catalog").unwrap().as_ref().unwrap())
            .unwrap(),
        record
    );
    for mutate in 0..3 {
        let mut invalid = record.clone();
        match mutate {
            0 => invalid["channels"][0]["geography"]["country"] = json!("CA"),
            1 => invalid["channels"][0]["geographyProvenance"][0]["sourceId"] = json!("other"),
            _ => invalid["channels"][0]["geographyProvenance"][0]["value"] = json!("ZZ"),
        };
        assert!(recovered.write("catalog", &invalid.to_string()).is_err());
    }
    assert_eq!(
        serde_json::from_str::<Value>(recovered.read("catalog").unwrap().as_ref().unwrap())
            .unwrap(),
        record
    );
}
fn pair(n: u32) -> RecordPair {
    let sources = json!([{"id":"source","name":"Fixture","location":"fixture.m3u","kind":"file"}]);
    RecordPair{catalog:Some(json!({"schemaVersion":1,"sources":sources,"channels":[{"id":format!("channel-{n}"),"sourceId":"source","name":format!("Fixture {n}"),"category":"Sports","urls":["https://example.invalid/live"]}]}).to_string()),preferences:Some(json!({"schemaVersion":1,"sources":sources,"favorites":["pending-favorite"],"removedChannels":["pending-removal"],"volume":0.5,"muted":false,"panelWidth":300.0,"automaticSourceRefresh":false,"sourceRefreshCadence":"off","sourceRefreshAttemptAt":0}).to_string())}
}
fn write(s: &PairStore, n: u32) {
    let p = pair(n);
    s.write_pair(p.catalog.as_ref().unwrap(), p.preferences.as_ref().unwrap())
        .unwrap();
}
#[test]
fn source_refresh_preferences_v5_migration_roundtrip_and_invalid_rollback() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let original = pair(9);
    store
        .write_pair(
            original.catalog.as_ref().unwrap(),
            original.preferences.as_ref().unwrap(),
        )
        .unwrap();
    {
        let c = connect(&root.path().join(DB), false).unwrap();
        c.execute_batch("DROP TABLE public_archive_variant_v1;DROP TABLE public_archive_item_v1;DROP TABLE public_archive_preference_v1;DROP TABLE public_archive_removal_v1;DROP TABLE public_archive_checkpoint_v1;DROP TABLE archive_bookmark_v1;DROP TABLE archive_bookmark_meta_v1;DROP TABLE archive_file_v1;DROP TABLE archive_item_progress_v1;DROP TABLE archive_progress_v1;DROP TABLE archive_preferences_v1;DROP TABLE archive_removal_v1;DROP TABLE archive_title_v1;DROP TABLE archive_catalog_meta_v1;DROP TABLE catalog_endpoint_projection_v1;DROP TABLE catalog_trigram;DROP TABLE catalog_shortgram;DROP TABLE catalog_projection;DROP TABLE catalog_projection_meta;DROP INDEX catalog_channel_state;DROP INDEX catalog_channel_region;ALTER TABLE preference DROP COLUMN source_refresh_cadence;ALTER TABLE guide_program DROP COLUMN categories_json;ALTER TABLE guide_program DROP COLUMN categories_key;ALTER TABLE preference DROP COLUMN reviewed_channel_providers;ALTER TABLE preference DROP COLUMN reviewed_guide_providers;ALTER TABLE preference DROP COLUMN preferred_region;ALTER TABLE preference DROP COLUMN voice_search_consent;ALTER TABLE preference DROP COLUMN auto_source_refresh;ALTER TABLE preference DROP COLUMN source_refresh_attempt_at;ALTER TABLE metadata DROP COLUMN automatic_guide_updates;PRAGMA user_version=5;").unwrap();
    }
    let reopened = PairStore::new(root.path().into()).unwrap();
    let migrated = reopened.read_pair().unwrap();
    let catalog_revision = reopened.read_snapshot().unwrap().catalog_revision;
    let mut pref: Value = serde_json::from_str(migrated.preferences.as_ref().unwrap()).unwrap();
    assert_eq!(pref["automaticSourceRefresh"], false);
    assert_eq!(pref["sourceRefreshAttemptAt"], 0);
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        5
    );
    integrity(&backup).unwrap();
    drop(backup);
    pref["automaticSourceRefresh"] = json!(true);
    pref["sourceRefreshCadence"] = json!("daily");
    pref["sourceRefreshAttemptAt"] = json!(1_791_700_000_000_i64);
    reopened.write("preferences", &pref.to_string()).unwrap();
    let persisted = PairStore::new(root.path().into())
        .unwrap()
        .read_pair()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(persisted.preferences.as_ref().unwrap()).unwrap(),
        pref
    );
    assert_eq!(persisted.catalog, migrated.catalog);
    assert_eq!(
        reopened.read_snapshot().unwrap().catalog_revision,
        catalog_revision
    );
    for invalid in [
        json!(-1),
        json!(1.5),
        json!(8_640_000_000_000_001_i64),
        json!(null),
        json!("1"),
    ] {
        let mut bad = pref.clone();
        bad["sourceRefreshAttemptAt"] = invalid;
        assert_eq!(
            reopened.write("preferences", &bad.to_string()).unwrap_err(),
            "record-invalid-source-refresh"
        );
        assert_eq!(
            reopened.read_pair().unwrap().preferences,
            persisted.preferences
        );
    }
    let mut bad = pref.clone();
    bad["automaticSourceRefresh"] = json!("true");
    bad.as_object_mut().unwrap().remove("sourceRefreshCadence");
    assert_eq!(
        reopened.write("preferences", &bad.to_string()).unwrap_err(),
        "record-invalid-source-refresh"
    );
    pref.as_object_mut().unwrap().remove("sourceRefreshCadence");
    pref.as_object_mut()
        .unwrap()
        .remove("automaticSourceRefresh");
    pref.as_object_mut()
        .unwrap()
        .remove("sourceRefreshAttemptAt");
    reopened.write("preferences", &pref.to_string()).unwrap();
    let legacy: Value =
        serde_json::from_str(reopened.read_pair().unwrap().preferences.as_ref().unwrap()).unwrap();
    assert_eq!(legacy["automaticSourceRefresh"], false);
    assert_eq!(legacy["sourceRefreshAttemptAt"], 0);
}

fn canonical(p: &RecordPair) -> (Option<Value>, Option<Value>) {
    (
        p.catalog
            .as_deref()
            .map(|s| serde_json::from_str(s).unwrap()),
        p.preferences
            .as_deref()
            .map(|s| serde_json::from_str(s).unwrap()),
    )
}
#[test]
fn normalized_tables_indexes_foreign_keys_and_atomic_reopen() {
    let root = tempfile::tempdir().unwrap();
    let s = PairStore::new(root.path().into()).unwrap();
    assert_eq!(s.read_pair().unwrap(), RecordPair::default());
    write(&s, 1);
    let c = connect(&root.path().join(DB), false).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM channel_url", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(c
        .execute(
            "INSERT INTO channel_url VALUES('absent',0,'https://example.invalid')",
            []
        )
        .is_err());
    let plan: String = c
        .query_row(
            "EXPLAIN QUERY PLAN SELECT id FROM channel WHERE name='Fixture 1' COLLATE NOCASE",
            [],
            |r| r.get(3),
        )
        .unwrap();
    assert!(plan.contains("channel_name"));
    assert_eq!(
        c.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "delete"
    );
    assert_eq!(
        c.query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    drop(c);
    assert_eq!(
        canonical(
            &PairStore::new(root.path().into())
                .unwrap()
                .read_pair()
                .unwrap()
        ),
        canonical(&pair(1))
    );
}
#[test]
fn refresh_preserves_pending_choices_and_preferences_edit_keeps_catalog() {
    let root = tempfile::tempdir().unwrap();
    let s = PairStore::new(root.path().into()).unwrap();
    write(&s, 1);
    s.write("catalog", pair(2).catalog.as_ref().unwrap())
        .unwrap();
    let p = s.read_pair().unwrap();
    assert_eq!(canonical(&p), canonical(&pair(2)));
    let mut prefs: Value = serde_json::from_str(p.preferences.as_ref().unwrap()).unwrap();
    prefs["muted"] = json!(true);
    s.write("preferences", &prefs.to_string()).unwrap();
    let r = s.read_pair().unwrap();
    assert_eq!(canonical(&r).0, canonical(&pair(2)).0);
    assert_eq!(canonical(&r).1.unwrap()["muted"], true);
}
#[test]
fn failure_mid_transaction_and_before_commit_rolls_back_both_records() {
    for phase in [Phase::AfterCatalog, Phase::BeforeCommit] {
        let root = tempfile::tempdir().unwrap();
        let s = PairStore::new(root.path().into()).unwrap();
        write(&s, 1);
        assert!(s
            .commit(&pair(2), |at| if at == phase {
                Err("injected".into())
            } else {
                Ok(())
            })
            .is_err());
        assert_eq!(
            canonical(
                &PairStore::new(root.path().into())
                    .unwrap()
                    .read_pair()
                    .unwrap()
            ),
            canonical(&pair(1))
        );
    }
}
#[test]
fn crash_after_commit_has_complete_new_revision() {
    let root = tempfile::tempdir().unwrap();
    let s = PairStore::new(root.path().into()).unwrap();
    write(&s, 1);
    assert!(s
        .commit(&pair(2), |at| if at == Phase::AfterCommit {
            Err("injected-process-exit".into())
        } else {
            Ok(())
        })
        .is_err());
    assert_eq!(
        canonical(
            &PairStore::new(root.path().into())
                .unwrap()
                .read_pair()
                .unwrap()
        ),
        canonical(&pair(2))
    );
}
#[test]
fn actual_process_kill_preserves_atomic_revision() {
    const CHILD_ROOT: &str = "GENX_STORAGE_KILL_CHILD_ROOT";
    const CHILD_PHASE: &str = "GENX_STORAGE_KILL_CHILD_PHASE";
    let phases = [
        ("after-catalog", Phase::AfterCatalog, 1),
        ("before-commit", Phase::BeforeCommit, 1),
        ("after-commit", Phase::AfterCommit, 2),
    ];
    if let Some(child_root) = std::env::var_os(CHILD_ROOT) {
        let root = PathBuf::from(child_root);
        let canonical_root = root.canonicalize().unwrap();
        let temporary_root = std::env::temp_dir().canonicalize().unwrap();
        assert!(canonical_root.starts_with(temporary_root));
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("genx-process-kill-"));
        assert!(!fs::symlink_metadata(&root)
            .unwrap()
            .file_type()
            .is_symlink());
        let requested = std::env::var(CHILD_PHASE).unwrap();
        let phase = phases
            .iter()
            .find(|(name, _, _)| *name == requested)
            .unwrap()
            .1;
        let store = PairStore::new(root.clone()).unwrap();
        store
            .commit(&pair(2), |at| {
                if at == phase {
                    fs::write(root.join("checkpoint-ready"), requested.as_bytes()).unwrap();
                    // The parent terminates this OS process. No Rust Drop/SQLite
                    // rollback path is allowed to simulate the crash for it.
                    loop {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
                Ok(())
            })
            .unwrap();
        panic!("Child did not reach its owned checkpoint");
    }
    struct OwnedChild(std::process::Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    for (name, _, expected_revision) in phases {
        let root = tempfile::Builder::new()
            .prefix("genx-process-kill-")
            .tempdir()
            .unwrap();
        let store = PairStore::new(root.path().into()).unwrap();
        write(&store, 1);
        let mut child = OwnedChild(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "storage_transaction::tests::actual_process_kill_preserves_atomic_revision",
                    "--nocapture",
                ])
                .env(CHILD_ROOT, root.path())
                .env(CHILD_PHASE, name)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let marker = root.path().join("checkpoint-ready");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !marker.exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "Child exited before checkpoint"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "Child checkpoint deadline exceeded"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(fs::read_to_string(marker).unwrap(), name);
        child.0.kill().unwrap();
        assert!(!child.0.wait().unwrap().success());
        let reopened = PairStore::new(root.path().into()).unwrap();
        assert_eq!(
            canonical(&reopened.read_pair().unwrap()),
            canonical(&pair(expected_revision))
        );
        let connection = connect(&root.path().join(DB), true).unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }
}
#[test]
fn real_sqlite_full_rolls_back_catalog_and_preferences() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    write(&store, 1);
    let mut connection = connect(&root.path().join(DB), false).unwrap();
    let current_pages: i64 = connection
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .unwrap();
    connection
        .pragma_update(None, "max_page_count", current_pages)
        .unwrap();
    // Confirm this is real SQLITE_FULL, rather than an arbitrary injected
    // application error. Only this owned connection's page budget changes.
    let full = connection
            .execute_batch("CREATE TABLE full_probe(value BLOB); INSERT INTO full_probe VALUES(zeroblob(1048576));")
            .unwrap_err();
    assert_eq!(
        full.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DiskFull)
    );
    connection
        .execute_batch("DROP TABLE IF EXISTS full_probe;")
        .unwrap();
    let mut replacement = pair(2);
    let mut catalog: Value = serde_json::from_str(replacement.catalog.as_ref().unwrap()).unwrap();
    catalog["channels"][0]["name"] = json!("x".repeat(16 * 1024));
    replacement.catalog = Some(catalog.to_string());
    assert_eq!(
        PairStore::apply(&mut connection, &replacement, |_| Ok(())).unwrap_err(),
        "sqlite-storage-full"
    );
    drop(connection);
    let reopened = PairStore::new(root.path().into()).unwrap();
    assert_eq!(
        canonical(&reopened.read_pair().unwrap()),
        canonical(&pair(1))
    );
    let connection = connect(&root.path().join(DB), true).unwrap();
    assert_eq!(
        connection
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}
#[test]
fn corrupt_database_recovers_verified_complete_backup() {
    let root = tempfile::tempdir().unwrap();
    let s = PairStore::new(root.path().into()).unwrap();
    write(&s, 1);
    write(&s, 2);
    fs::write(root.path().join(DB), b"corrupt sqlite header").unwrap();
    assert_eq!(
        canonical(
            &PairStore::new(root.path().into())
                .unwrap()
                .read_pair()
                .unwrap()
        ),
        canonical(&pair(1))
    );
}
#[test]
fn unknown_schema_never_downgrades_to_backup() {
    let root = tempfile::tempdir().unwrap();
    let s = PairStore::new(root.path().into()).unwrap();
    write(&s, 1);
    connect(&root.path().join(DB), false)
        .unwrap()
        .execute_batch("PRAGMA user_version=99")
        .unwrap();
    assert!(PairStore::new(root.path().into()).is_err());
    assert_eq!(
        connect(&root.path().join(DB), true)
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        99
    );
}
#[test]
fn invalid_duplicate_missing_reference_http_and_oversize_inputs_leave_revision() {
    let root = tempfile::tempdir().unwrap();
    let s = PairStore::new(root.path().into()).unwrap();
    write(&s, 1);
    let base: Value = serde_json::from_str(pair(2).catalog.as_ref().unwrap()).unwrap();
    let mut bad = base.clone();
    let duplicate = bad["channels"][0].clone();
    bad["channels"].as_array_mut().unwrap().push(duplicate);
    assert!(s.write("catalog", &bad.to_string()).is_err());
    let mut bad = base.clone();
    bad["channels"][0]["sourceId"] = json!("absent");
    assert!(s.write("catalog", &bad.to_string()).is_err());
    let mut bad = base.clone();
    bad["channels"][0]["urls"] = json!(["http://example.invalid/live"]);
    assert!(s.write("catalog", &bad.to_string()).is_err());
    let mut bad = base.clone();
    bad["schemaVersion"] = json!(2);
    assert!(s.write("catalog", &bad.to_string()).is_err());
    assert!(s.write("catalog", &" ".repeat(LIMIT as usize + 1)).is_err());
    assert!(s.write("../outside", "{}").is_err());
    assert_eq!(canonical(&s.read_pair().unwrap()), canonical(&pair(1)));
}
#[test]
fn explicit_http_grant_roundtrips_and_metadata_is_bound_as_data() {
    let root = tempfile::tempdir().unwrap();
    let s = PairStore::new(root.path().into()).unwrap();
    let mut p = pair(1);
    let mut c: Value = serde_json::from_str(p.catalog.as_ref().unwrap()).unwrap();
    let mut prefs: Value = serde_json::from_str(p.preferences.as_ref().unwrap()).unwrap();
    c["sources"][0]["allowHttp"] = json!(true);
    c["channels"][0]["urls"] = json!(["http://example.invalid/live"]);
    c["channels"][0]["name"] = json!("';DROP TABLE channel;--");
    prefs["sources"] = c["sources"].clone();
    p.catalog = Some(c.to_string());
    p.preferences = Some(prefs.to_string());
    s.write_pair(p.catalog.as_ref().unwrap(), p.preferences.as_ref().unwrap())
        .unwrap();
    assert_eq!(canonical(&s.read_pair().unwrap()), canonical(&p));
}
#[test]
fn legacy_files_are_imported_once_and_retained_unmodified() {
    let root = tempfile::tempdir().unwrap();
    let p = pair(1);
    fs::write(
        root.path().join("catalog.json"),
        p.catalog.as_ref().unwrap(),
    )
    .unwrap();
    fs::write(
        root.path().join("preferences.json"),
        p.preferences.as_ref().unwrap(),
    )
    .unwrap();
    let s = PairStore::new(root.path().into()).unwrap();
    assert_eq!(canonical(&s.read_pair().unwrap()), canonical(&p));
    write(&s, 2);
    assert_eq!(
        fs::read_to_string(root.path().join("catalog.json")).unwrap(),
        p.catalog.unwrap()
    );
    assert_eq!(
        canonical(
            &PairStore::new(root.path().into())
                .unwrap()
                .read_pair()
                .unwrap()
        ),
        canonical(&pair(2))
    );
}
#[test]
fn backup_failure_keeps_database_and_hot_journal_prevents_unsafe_restore() {
    let root = tempfile::tempdir().unwrap();
    let s = PairStore::new(root.path().into()).unwrap();
    write(&s, 1);
    fs::remove_file(root.path().join(BACKUP)).unwrap();
    fs::create_dir(root.path().join(BACKUP)).unwrap();
    assert!(s
        .write("catalog", pair(2).catalog.as_ref().unwrap())
        .is_err());
    assert_eq!(canonical(&s.read_pair().unwrap()), canonical(&pair(1)));
    fs::remove_dir(root.path().join(BACKUP)).unwrap();
    write(&s, 2);
    fs::write(root.path().join(DB), b"broken").unwrap();
    fs::write(
        root.path().join(format!("{DB}-journal")),
        b"forensic journal",
    )
    .unwrap();
    assert!(PairStore::new(root.path().into()).is_err());
    assert!(root.path().join(format!("{DB}-journal")).exists());
}
