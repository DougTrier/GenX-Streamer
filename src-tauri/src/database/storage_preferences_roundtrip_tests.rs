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

//! Real independent Store files; synthetic preferences and no installation data.
use super::*;
use crate::storage::Store;
use std::fs;

fn preferences() -> Value {
    json!({"schemaVersion":1,"sources":[],"favorites":["missing-favorite"],"removedChannels":["missing-removed"],"volume":0.5,"muted":false,"panelWidth":320,"automaticGuideUpdates":false,"voiceSearchConsent":true,"reviewedChannelProviders":[],"reviewedGuideProviders":[],"preferredRegion":{"country":"US","state":"US-IL","postal":"61554","origin":"manual"},"channelCategoryOverrides":[{"channelId":"missing-favorite","category":"Sports"}]})
}
fn fixture() -> (tempfile::TempDir, Store) {
    let root = tempfile::tempdir().unwrap();
    let store = Store::new(root.path().into(), "test".into()).unwrap();
    store
        .write("preferences", &preferences().to_string())
        .unwrap();
    (root, store)
}
fn saved(store: &Store) -> Value {
    serde_json::from_str(&store.read("preferences").unwrap().unwrap()).unwrap()
}
#[derive(Default, Debug, PartialEq, Eq)]
struct BackupCounts {
    checks: usize,
    completed: usize,
}
impl BackupCounts {
    fn observe(&mut self, phase: Phase) {
        self.checks += usize::from(phase == Phase::DuringBackup);
        self.completed += usize::from(phase == Phase::AfterBackup);
    }
    fn assert_backed_once(&self) {
        assert!(self.checks > 0, "owned operation did not enter backup");
        assert_eq!(self.completed, 1, "owned backup completion count");
    }
}
fn observed_write(
    store: &Store,
    root: &Path,
    pair: &RecordPair,
    expected: (Option<&str>, Option<&str>),
    mut guard: impl FnMut(Phase) -> Result<(), String>,
) -> (Result<CommitReceipt, String>, BackupCounts) {
    let mut counts = BackupCounts::default();
    let result = (|| {
        // The same checked Store gate and PairStore mutation path as the public
        // entry point, with operation-owned phases rather than global timings.
        let _writer = store.write_lease_checked(&mut || guard(Phase::BeforeWork))?;
        let pair_store = PairStore::new(root.into())?;
        pair_store.write_records_with_phase(pair, None, expected, None, |phase| {
            counts.observe(phase);
            guard(phase)
        })
    })();
    (result, counts)
}
fn observed_preferences(
    store: &Store,
    root: &Path,
    pref: &Value,
) -> (Result<CommitReceipt, String>, BackupCounts) {
    observed_write(
        store,
        root,
        &RecordPair {
            catalog: None,
            preferences: Some(pref.to_string()),
        },
        (Some("0"), None),
        |_| Ok(()),
    )
}
fn bytes(root: &Path) -> (Vec<u8>, Vec<u8>) {
    (
        fs::read(root.join(DB)).unwrap(),
        fs::read(root.join(BACKUP)).unwrap(),
    )
}
fn logical_rows(c: &Connection) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
    let mut statement = c
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .unwrap();
    let names = statement
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    names
        .into_iter()
        .map(|name| {
            let mut statement = c
                .prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")))
                .unwrap();
            let columns = statement.column_count();
            let mut rows = statement
                .query_map([], |r| {
                    (0..columns)
                        .map(|i| r.get::<_, rusqlite::types::Value>(i))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            rows.sort_by_cached_key(|row| format!("{row:?}"));
            (name, rows)
        })
        .collect()
}

#[test]
fn content_library_choices_survive_store_close_reopen_and_pair_export_import() {
    for choice in ["live", "genxtra"] {
        let (root, store) = fixture();
        let mut input = saved(&store);
        input["contentLibrary"] = json!(choice);
        store
            .write_record_guarded("preferences", &input.to_string(), Some("0"), || Ok(()))
            .unwrap();
        assert_eq!(saved(&store), input);
        let exported = serde_json::to_string(&store.read_pair().unwrap()).unwrap();
        drop(store);
        let reopened = Store::new(root.path().into(), "test".into()).unwrap();
        assert_eq!(saved(&reopened)["contentLibrary"], choice);
        let imported_root = tempfile::tempdir().unwrap();
        let imported = Store::new(imported_root.path().into(), "test".into()).unwrap();
        let pair: RecordPair = serde_json::from_str(&exported).unwrap();
        imported
            .write_pair_with_scan(&pair, None, (Some("0"), None), None, || Ok(()))
            .unwrap();
        assert_eq!(saved(&imported), input);
    }
}

#[test]
fn legacy_schema18_keeps_absence_verified_preimage_and_recovers_then_migrates() {
    let (root, store) = fixture();
    let expected = saved(&store);
    assert!(expected.get("contentLibrary").is_none());
    drop(store);
    let c = connect(&root.path().join(DB), false).unwrap();
    let has: i64 = c
        .query_row(
            "SELECT count(*) FROM pragma_table_info('preference') WHERE name='content_library'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    if has != 0 {
        c.execute_batch("ALTER TABLE preference DROP COLUMN content_library;")
            .unwrap();
    }
    c.execute_batch("PRAGMA user_version=18").unwrap();
    let preimage = logical_rows(&c);
    drop(c);
    let migrated = Store::new(root.path().into(), "test".into()).unwrap();
    assert_eq!(saved(&migrated), expected);
    let c = connect(&root.path().join(DB), true).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        19
    );
    assert_eq!(
        c.query_row("SELECT content_library FROM preference", [], |r| r
            .get::<_, Option<String>>(0))
            .unwrap(),
        None
    );
    drop(c);
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    // SQLite's online-backup API may change physical header counters. Verify
    // the complete logical schema18 preimage, not byte-identical page headers.
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        18
    );
    assert!(
        logical_rows(&backup) == preimage,
        "schema18 backup logical preimage differs"
    );
    integrity(&backup).unwrap();
    drop(backup);
    drop(migrated);
    fs::write(root.path().join(DB), b"corrupt fixture").unwrap();
    let recovered = Store::new(root.path().into(), "test".into()).unwrap();
    assert_eq!(saved(&recovered), expected);
    assert_eq!(
        connect(&root.path().join(DB), true)
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        19
    );
}

#[test]
fn identical_preferences_preserve_every_byte_revision_and_backup_counter() {
    let (root, store) = fixture();
    let before = bytes(root.path());
    let snapshot = store.read_snapshot().unwrap();
    for _ in 0..3 {
        let receipt = store
            .write_record_guarded(
                "preferences",
                snapshot.pair.preferences.as_ref().unwrap(),
                Some(&snapshot.catalog_revision),
                || Ok(()),
            )
            .unwrap();
        assert!(receipt.committed);
        assert_eq!(receipt.catalog_revision, snapshot.catalog_revision);
        assert_eq!(receipt.health_revision, snapshot.health_revision);
        let input = RecordPair {
            catalog: None,
            preferences: snapshot.pair.preferences.clone(),
        };
        let (result, counts) = observed_write(
            &store,
            root.path(),
            &input,
            (Some(&snapshot.catalog_revision), None),
            |_| Ok(()),
        );
        result.unwrap();
        assert_eq!(counts, BackupCounts::default());
    }
    assert!(
        bytes(root.path()) == before,
        "database or backup bytes changed"
    );
    assert_eq!(store.read_pair().unwrap(), snapshot.pair);
}

#[test]
fn equal_preferences_refuse_stale_cas_cancellation_and_generation_before_backup() {
    let (root, store) = fixture();
    let pref = saved(&store).to_string();
    let before = bytes(root.path());
    assert_eq!(
        store
            .write_record_guarded("preferences", &pref, Some("999"), || Ok(()))
            .unwrap_err(),
        "catalog-revision-stale"
    );
    assert_eq!(
        store
            .write_record_guarded("preferences", &pref, Some("0"), || Err(
                "request-canceled".into()
            ))
            .unwrap_err(),
        "request-canceled"
    );
    let mut checks = 0;
    assert_eq!(
        store
            .write_record_guarded("preferences", &pref, Some("0"), || {
                checks += 1;
                if checks >= 3 {
                    Err("storage-generation-stale".into())
                } else {
                    Ok(())
                }
            })
            .unwrap_err(),
        "storage-generation-stale"
    );
    assert!(
        bytes(root.path()) == before,
        "database or backup bytes changed"
    );
    let input = RecordPair {
        catalog: None,
        preferences: Some(pref),
    };
    let (stale, counts) =
        observed_write(&store, root.path(), &input, (Some("999"), None), |_| Ok(()));
    assert_eq!(stale.unwrap_err(), "catalog-revision-stale");
    assert_eq!(counts, BackupCounts::default());
    let (cancelled, counts) =
        observed_write(&store, root.path(), &input, (Some("0"), None), |phase| {
            if phase == Phase::BeforeCommit {
                Err("storage-generation-stale".into())
            } else {
                Ok(())
            }
        });
    assert_eq!(cancelled.unwrap_err(), "storage-generation-stale");
    assert_eq!(counts, BackupCounts::default());
    assert!(
        bytes(root.path()) == before,
        "database or backup bytes changed"
    );
}

#[test]
fn noop_preflight_rechecks_health_revision_final_guard_and_exhaustion() {
    let (root, store) = fixture();
    let pref = saved(&store).to_string();
    let pair = PairStore::new(root.path().into()).unwrap();
    let input = RecordPair {
        catalog: None,
        preferences: Some(pref),
    };
    let before = bytes(root.path());
    assert_eq!(
        pair.write_pair_with_scan(&input, None, (Some("0"), Some("999")), None, || Ok(()))
            .unwrap_err(),
        "health-revision-stale"
    );
    assert_eq!(
        pair.write_records_with_phase(&input, None, (Some("0"), None), None, |stage| {
            if stage == Phase::BeforeCommit {
                Err("root-replaced".into())
            } else {
                Ok(())
            }
        })
        .unwrap_err(),
        "root-replaced"
    );
    assert!(
        bytes(root.path()) == before,
        "database or backup bytes changed"
    );
    let (stale, counts) = observed_write(
        &store,
        root.path(),
        &input,
        (Some("0"), Some("999")),
        |_| Ok(()),
    );
    assert_eq!(stale.unwrap_err(), "health-revision-stale");
    assert_eq!(counts, BackupCounts::default());
    let (cancelled, counts) =
        observed_write(&store, root.path(), &input, (Some("0"), None), |phase| {
            if phase == Phase::BeforeCommit {
                Err("root-replaced".into())
            } else {
                Ok(())
            }
        });
    assert_eq!(cancelled.unwrap_err(), "root-replaced");
    assert_eq!(counts, BackupCounts::default());
    assert!(
        bytes(root.path()) == before,
        "database or backup bytes changed"
    );
    connect(&root.path().join(DB), false)
        .unwrap()
        .execute("UPDATE metadata SET revision=?1", [i64::MAX])
        .unwrap();
    assert_eq!(
        pair.write_pair_with_scan(&input, None, (Some("0"), None), None, || Ok(()))
            .unwrap_err(),
        "storage-revision-exhausted"
    );
}

#[test]
fn invalid_library_payload_refuses_before_backup_and_never_changes_data() {
    let (root, store) = fixture();
    let before = bytes(root.path());
    for bad in [
        json!(null),
        json!("archive"),
        json!(true),
        json!({}),
        json!([]),
    ] {
        let mut pref = saved(&store);
        pref["contentLibrary"] = bad;
        assert_eq!(
            store
                .write_record_guarded("preferences", &pref.to_string(), Some("0"), || Ok(()))
                .unwrap_err(),
            "record-invalid-content-library"
        );
        let (invalid, counts) = observed_preferences(&store, root.path(), &pref);
        assert_eq!(invalid.unwrap_err(), "record-invalid-content-library");
        assert_eq!(counts, BackupCounts::default());
    }
    assert!(
        bytes(root.path()) == before,
        "database or backup bytes changed"
    );
}

#[test]
fn noop_does_not_need_backup_destination_but_real_change_still_does() {
    let (root, store) = fixture();
    let pref = saved(&store);
    let before = fs::read(root.path().join(DB)).unwrap();
    fs::remove_file(root.path().join(BACKUP)).unwrap();
    fs::create_dir(root.path().join(BACKUP)).unwrap();
    store
        .write_record_guarded("preferences", &pref.to_string(), Some("0"), || Ok(()))
        .unwrap();
    let mut changed = pref.clone();
    changed["contentLibrary"] = json!("genxtra");
    assert!(store
        .write_record_guarded("preferences", &changed.to_string(), Some("0"), || Ok(()))
        .is_err());
    assert_eq!(fs::read(root.path().join(DB)).unwrap(), before);
    assert_eq!(saved(&store), pref);
}

#[test]
fn source_and_optional_preference_changes_are_never_ignored_as_noops() {
    let (root, store) = fixture();
    let initial = saved(&store);
    let mut changed = initial.clone();
    changed["contentLibrary"] = json!("live");
    let (result, counts) = observed_preferences(&store, root.path(), &changed);
    result.unwrap();
    counts.assert_backed_once();
    assert_eq!(saved(&store)["contentLibrary"], "live");
    changed = saved(&store);
    changed.as_object_mut().unwrap().remove("contentLibrary");
    let (result, counts) = observed_preferences(&store, root.path(), &changed);
    result.unwrap();
    counts.assert_backed_once();
    assert!(saved(&store).get("contentLibrary").is_none());
    let mut source_change = saved(&store);
    source_change["sources"] =
        json!([{"id":"new","name":"Synthetic source","kind":"file","location":"fixture.m3u"}]);
    let (result, counts) = observed_preferences(&store, root.path(), &source_change);
    result.unwrap();
    counts.assert_backed_once();
    assert_eq!(saved(&store)["sources"], source_change["sources"]);
    assert!(
        bytes(root.path()).0 != bytes(root.path()).1,
        "changed write did not retain prior backup"
    );
}

#[test]
fn every_persisted_extension_and_source_permission_change_keeps_backup_and_roundtrip() {
    let (root, store) = fixture();
    let changes = [
        ("favorites", json!(["other-favorite"])),
        ("removedChannels", json!(["other-removed"])),
        ("voiceSearchConsent", json!(false)),
        ("automaticGuideUpdates", json!(true)),
        (
            "channelCategoryOverrides",
            json!([{ "channelId":"missing-favorite", "category":"Drama" }]),
        ),
        (
            "preferredRegion",
            json!({"country":"US","state":"US-IN","origin":"manual"}),
        ),
        (
            "reviewedChannelProviders",
            json!([{"id":"p","name":"Provider","location":"https://example.invalid/channels.m3u","provenance":"https://example.invalid/"}]),
        ),
        (
            "reviewedGuideProviders",
            json!([{"id":"g","name":"Guide","location":"https://example.invalid/guide.xml","provenance":"https://example.invalid/","limitations":"Synthetic"}]),
        ),
        ("sourceRefreshCadence", json!("hourly")),
        ("sourceRefreshAttemptAt", json!(1234)),
        (
            "sources",
            json!([{"id":"s","name":"Source","location":"https://example.invalid/list","kind":"url","allowHttp":true}]),
        ),
        (
            "sources",
            json!([{"id":"s","name":"Source","location":"https://example.invalid/list","kind":"url","allowHttp":false}]),
        ),
    ];
    for (key, value) in changes {
        let mut pref = saved(&store);
        pref[key] = value;
        let (result, counts) = observed_preferences(&store, root.path(), &pref);
        result.unwrap();
        counts.assert_backed_once();
        let actual = saved(&store);
        if key == "sources" && pref[key][0]["allowHttp"] == false {
            assert!(actual[key][0].get("allowHttp").is_none());
        } else if key == "reviewedChannelProviders" {
            assert_eq!(actual[key][0]["id"], "p");
            assert_eq!(actual[key][0]["allowHttp"], false);
        } else {
            assert_eq!(actual[key], pref[key], "{key}");
        }
    }
}

#[test]
fn unknown_payload_fields_and_catalog_source_mismatch_do_not_get_noop_ack() {
    let (root, store) = fixture();
    let pref = saved(&store);
    fs::remove_file(root.path().join(BACKUP)).unwrap();
    fs::create_dir(root.path().join(BACKUP)).unwrap();
    let before = fs::read(root.path().join(DB)).unwrap();
    let mut unknown = pref.clone();
    unknown["futurePreference"] = json!({"value":1});
    assert!(store
        .write_record_guarded("preferences", &unknown.to_string(), Some("0"), || Ok(()))
        .is_err());
    assert_eq!(fs::read(root.path().join(DB)).unwrap(), before);
    fs::remove_dir(root.path().join(BACKUP)).unwrap();
    store
        .write(
            "catalog",
            &json!({"schemaVersion":1,"sources":[],"channels":[]}).to_string(),
        )
        .unwrap();
    fs::remove_file(root.path().join(BACKUP)).unwrap();
    fs::create_dir(root.path().join(BACKUP)).unwrap();
    let mut mismatch = saved(&store);
    mismatch["sources"] = json!([{"id":"s","name":"Source","kind":"file","location":"fixture"}]);
    assert!(store
        .write_record_guarded("preferences", &mismatch.to_string(), Some("1"), || Ok(()))
        .is_err());
}
