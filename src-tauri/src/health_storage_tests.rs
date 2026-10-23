use super::*;
use crate::health_storage;
fn fixture() -> (String, String, Value) {
    let source = json!({"id":"source","name":"Fixture","kind":"file","location":"fixture.m3u"});
    let channel = json!({"id":"channel","sourceId":"source","name":"Channel","category":"Sports","urls":["https://example.invalid/live"]});
    let catalog = json!({"schemaVersion":1,"sources":[source],"channels":[channel]});
    let preferences = json!({"schemaVersion":1,"sources":catalog["sources"],"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":300});
    let fingerprint =
        health_storage::fingerprint(&catalog["sources"][0], &catalog["channels"][0], 0).unwrap();
    let record = json!({"schemaVersion":1,"channelId":"channel","sourceId":"source","checkedUrlOrdinal":0,"targetFingerprint":fingerprint,"platform":"windows","observerProfile":"native-mse-v1","observedAt":100,"verdict":"Reachable","evidence":{"kind":"http","status":200,"contentRecognized":true},"origin":"local"});
    (catalog.to_string(), preferences.to_string(), record)
}
fn payload(record: &Value) -> String {
    json!({"schemaVersion":1,"records":[record]}).to_string()
}
#[test]
fn health_only_queued_cancel_and_commit_receipt_have_definite_ownership() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let (catalog, prefs, record) = fixture();
    store
        .write_guarded_cas(&catalog, &prefs, None, (Some("0"), None), || Ok(()))
        .unwrap();
    let before = store.read_snapshot().unwrap();
    let shared = std::sync::Arc::new(std::sync::Mutex::new(store));
    let mut registry = crate::requests::Requests::default();
    let mut receiver = registry.register("queued-health".into()).unwrap();
    let held = shared.lock().unwrap();
    let owner = shared.clone();
    let incoming = payload(&record);
    let worker = std::thread::spawn(move || {
        owner
            .lock()
            .unwrap()
            .write_health_guarded(&incoming, "1", "0", || match receiver.try_recv() {
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => Ok(()),
                _ => Err("canceled".into()),
            })
    });
    registry.cancel("queued-health".into()).unwrap();
    drop(held);
    assert_eq!(worker.join().unwrap().unwrap_err(), "canceled");
    assert_eq!(shared.lock().unwrap().read_snapshot().unwrap(), before);
    assert_eq!(
        shared
            .lock()
            .unwrap()
            .write_records_with_phase(
                &RecordPair::default(),
                Some(&payload(&record)),
                (Some("1"), Some("0")),
                None,
                |phase| if phase == Phase::BeforeCommit {
                    Err("canceled".into())
                } else {
                    Ok(())
                },
            )
            .unwrap_err(),
        "canceled"
    );
    assert_eq!(shared.lock().unwrap().read_snapshot().unwrap(), before);
    let mut late_cancel = false;
    let receipt = shared
        .lock()
        .unwrap()
        .write_records_with_phase(
            &RecordPair::default(),
            Some(&payload(&record)),
            (Some("1"), Some("0")),
            None,
            |phase| {
                if late_cancel {
                    return Err("canceled".into());
                }
                // Cancellation arrives immediately after the final successful
                // fence, independently of the number of backup step checks.
                if phase == Phase::BeforeCommit {
                    late_cancel = true;
                }
                Ok(())
            },
        )
        .unwrap();
    assert!(late_cancel && receipt.committed);
    assert_eq!(receipt.catalog_revision, "1");
    assert_eq!(receipt.health_revision, "1");
    drop(shared);
    let reopened = PairStore::new(root.path().into())
        .unwrap()
        .read_snapshot()
        .unwrap();
    assert_eq!(reopened.pair, before.pair);
    assert_eq!(reopened.health_revision, "1");
    assert_eq!(
        health_storage::parse(reopened.health.as_deref().unwrap())
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn health_only_two_writers_cas_preserves_catalog_preferences_and_guide_revision() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let (catalog, prefs, record) = fixture();
    store
        .write_record_guarded("catalog", &catalog, None, || Ok(()))
        .unwrap();
    store
        .write_record_guarded("preferences", &prefs, None, || Ok(()))
        .unwrap();
    let before = store.read_snapshot().unwrap();
    let c = connect(&root.path().join(DB), false).unwrap();
    let revision: i64 = c
        .query_row("SELECT revision FROM metadata", [], |r| r.get(0))
        .unwrap();
    drop(c);
    let store = std::sync::Arc::new(std::sync::Mutex::new(store));
    let start = std::sync::Arc::new(std::sync::Barrier::new(3));
    let mut workers = Vec::new();
    for profile in ["writer-a", "writer-b"] {
        let store = store.clone();
        let start = start.clone();
        let mut record = record.clone();
        record["observerProfile"] = json!(profile);
        workers.push(std::thread::spawn(move || {
            start.wait();
            store
                .lock()
                .unwrap()
                .write_health_guarded(&payload(&record), "1", "0", || Ok(()))
        }));
    }
    start.wait();
    let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| r.as_ref().is_err_and(|e| e == "health-revision-stale"))
            .count(),
        1
    );
    let after = store.lock().unwrap().read_snapshot().unwrap();
    assert_eq!(after.pair, before.pair);
    assert_eq!(after.catalog_revision, before.catalog_revision);
    assert_eq!(after.health_revision, "1");
    assert_eq!(
        health_storage::parse(after.health.as_deref().unwrap())
            .unwrap()
            .len(),
        1
    );
    let c = connect(&root.path().join(DB), false).unwrap();
    assert_eq!(
        c.query_row("SELECT revision FROM metadata", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        revision
    );
}
#[test]
fn stale_scan_cannot_replace_decoded_health_or_preferences() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let (catalog, prefs, mut record) = fixture();
    store
        .write_guarded_cas(&catalog, &prefs, None, (Some("0"), None), || Ok(()))
        .unwrap();
    record["verdict"] = json!("PlayedHere");
    record["evidence"] = json!({"kind":"decoded","elapsedMilliseconds":1000,"before":{"mediaTime":1,"decodedFrames":1,"width":320,"height":180},"after":{"mediaTime":2,"decodedFrames":20,"width":320,"height":180}});
    store
        .write_health_guarded(&payload(&record), "1", "0", || Ok(()))
        .unwrap();
    let before = store.read_snapshot().unwrap();
    let (_, _, scan) = fixture();
    let mut changed: Value = serde_json::from_str(&prefs).unwrap();
    changed["volume"] = json!(0.2);
    assert_eq!(
        store
            .write_guarded_cas(
                &catalog,
                &changed.to_string(),
                Some(&payload(&scan)),
                (Some("1"), Some("0")),
                || Ok(())
            )
            .unwrap_err(),
        "health-revision-stale"
    );
    assert_eq!(store.read_snapshot().unwrap(), before);
}
#[test]
fn health_only_catalog_cas_and_exact_target_refuse_replacement() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let (catalog, prefs, record) = fixture();
    store
        .write_guarded_cas(&catalog, &prefs, None, (Some("0"), None), || Ok(()))
        .unwrap();
    let mut changed: Value = serde_json::from_str(&catalog).unwrap();
    changed["channels"][0]["urls"][0] = json!("https://example.invalid/new");
    store
        .write_record_guarded("catalog", &changed.to_string(), Some("1"), || Ok(()))
        .unwrap();
    let before = store.read_snapshot().unwrap();
    assert_eq!(
        store
            .write_health_guarded(&payload(&record), "1", "0", || Ok(()))
            .unwrap_err(),
        "catalog-revision-stale"
    );
    assert_eq!(
        store
            .write_health_guarded(&payload(&record), "2", "0", || Ok(()))
            .unwrap_err(),
        "health-target-mismatch"
    );
    assert_eq!(store.read_snapshot().unwrap(), before);
}
#[test]
fn health_only_nonuseful_older_and_imported_updates_preserve_useful_local_slots() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let (catalog, prefs, record) = fixture();
    store
        .write_guarded_cas(&catalog, &prefs, None, (Some("0"), None), || Ok(()))
        .unwrap();
    store
        .write_health_guarded(&payload(&record), "1", "0", || Ok(()))
        .unwrap();
    let before = store.read_snapshot().unwrap();
    for mode in ["older", "imported", "canceled"] {
        let mut update = record.clone();
        update["observedAt"] = json!(if mode == "older" { 99 } else { 200 });
        if mode == "imported" {
            update["origin"] = json!("imported");
        }
        if mode == "canceled" {
            update["verdict"] = json!("Canceled");
            update["evidence"] = json!({"kind":"canceled"});
        }
        let receipt = store
            .write_health_guarded(&payload(&update), "1", "1", || Ok(()))
            .unwrap();
        assert_eq!(receipt.health_revision, "1");
        assert_eq!(store.read_snapshot().unwrap(), before);
    }
}
#[test]
fn paired_health_requires_revision_and_health_only_cancel_rolls_back_whole_delta() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let (catalog, prefs, record) = fixture();
    store
        .write_guarded_cas(&catalog, &prefs, None, (Some("0"), None), || Ok(()))
        .unwrap();
    let before = store.read_snapshot().unwrap();
    assert_eq!(
        store
            .write_guarded_cas(
                &catalog,
                &prefs,
                Some(&payload(&record)),
                (None, Some("0")),
                || Ok(())
            )
            .unwrap_err(),
        "catalog-revision-required"
    );
    assert_eq!(
        store
            .write_guarded_cas(
                &catalog,
                &prefs,
                Some(&payload(&record)),
                (Some("1"), None),
                || Ok(())
            )
            .unwrap_err(),
        "health-revision-required"
    );
    for value in ["", "-1", "01", "1.0", "9223372036854775808"] {
        assert_eq!(
            store
                .write_health_guarded(&payload(&record), "1", value, || Ok(()))
                .unwrap_err(),
            "health-revision-invalid"
        );
    }
    let mut checks = 0;
    assert_eq!(
        store
            .write_health_guarded(&payload(&record), "1", "0", || {
                checks += 1;
                if checks == 5 {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            })
            .unwrap_err(),
        "canceled"
    );
    assert_eq!(checks, 5);
    assert_eq!(store.read_snapshot().unwrap(), before);
    drop(store);
    assert_eq!(
        PairStore::new(root.path().into())
            .unwrap()
            .read_snapshot()
            .unwrap(),
        before
    );
}
#[test]
fn javascript_exact_fingerprint_escaping_unicode_permission_ordinal() {
    let source = json!({"id":"source😀","kind":"file","location":"fixture \"line\" \\ slash / 雪"});
    let channel = json!({"id":"channel𐐀","sourceId":"source😀","urls":["https://example.invalid/other","https://example.invalid/live?q=%22雪%22&token=a/b"]});
    // Node crypto SHA256 of exact JSON.stringify tuple, not a Rust-generated expected hash.
    assert_eq!(
        health_storage::fingerprint(&source, &channel, 1).unwrap(),
        "faa2a00eb1c52a3d8e7d6ba12d6de0e6e7e4c220fc146ac3ec0a867c060d9982"
    );
    let mut http = source.clone();
    http["allowHttp"] = json!(true);
    assert_ne!(
        health_storage::fingerprint(&http, &channel, 1).unwrap(),
        health_storage::fingerprint(&source, &channel, 1).unwrap()
    );
    assert_ne!(
        health_storage::fingerprint(&source, &channel, 0).unwrap(),
        health_storage::fingerprint(&source, &channel, 1).unwrap()
    );
}
#[test]
fn actual_three_record_transaction_reopen_and_preferences_revision() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let (catalog, preferences, record) = fixture();
    let receipt = store
        .write_guarded(
            &catalog,
            &preferences,
            Some(&payload(&record)),
            Some("0"),
            || Ok(()),
        )
        .unwrap();
    assert!(receipt.committed);
    assert_eq!(receipt.catalog_revision, "1");
    assert_eq!(receipt.health_revision, "1");
    let mut pref: Value = serde_json::from_str(&preferences).unwrap();
    pref["volume"] = json!(0.25);
    let next = store
        .write_record_guarded("preferences", &pref.to_string(), Some("1"), || Ok(()))
        .unwrap();
    assert_eq!(next.catalog_revision, "1");
    assert_eq!(next.health_revision, "1");
    drop(store);
    let reopened = PairStore::new(root.path().into()).unwrap();
    let snapshot = reopened.read_snapshot().unwrap();
    assert_eq!(snapshot.catalog_revision, "1");
    assert_eq!(snapshot.health_revision, "1");
    assert_eq!(
        serde_json::from_str::<Value>(snapshot.health.as_deref().unwrap()).unwrap()["records"][0],
        record
    );
    assert_eq!(
        serde_json::from_str::<Value>(snapshot.pair.preferences.as_deref().unwrap()).unwrap()
            ["volume"],
        0.25
    );
    reopened
        .with_guide_read(|c| {
            assert_eq!(
                c.query_row("SELECT count(*) FROM channel_health", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                16
            );
            integrity(c)
        })
        .unwrap();
}
#[test]
fn replacement_filters_changed_signed_url_source_grant_and_retains_exact_targets() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let (catalog, prefs, record) = fixture();
    store
        .write_guarded(&catalog, &prefs, Some(&payload(&record)), None, || Ok(()))
        .unwrap();
    // Canonical same catalog, even explicit false permission, preserves both revisions.
    let mut c: Value = serde_json::from_str(&catalog).unwrap();
    let mut p: Value = serde_json::from_str(&prefs).unwrap();
    c["sources"][0]["allowHttp"] = json!(false);
    p["sources"] = c["sources"].clone();
    let receipt = store
        .write_guarded(&c.to_string(), &p.to_string(), None, Some("1"), || Ok(()))
        .unwrap();
    assert_eq!(receipt.catalog_revision, "1");
    assert_eq!(receipt.health_revision, "1");
    c["channels"][0]["urls"][0] = json!("https://example.invalid/live?token=new");
    let receipt = store
        .write_guarded(&c.to_string(), &p.to_string(), None, Some("1"), || Ok(()))
        .unwrap();
    assert_eq!(receipt.catalog_revision, "2");
    assert_eq!(receipt.health_revision, "2");
    assert_eq!(
        serde_json::from_str::<Value>(store.read_snapshot().unwrap().health.as_deref().unwrap())
            .unwrap()["records"],
        json!([])
    );
}
#[test]
fn stale_cas_precommit_cancellation_and_backup_failure_preserve_whole_health_pair() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let (catalog, prefs, record) = fixture();
    store
        .write_guarded(&catalog, &prefs, Some(&payload(&record)), None, || Ok(()))
        .unwrap();
    let before = store.read_snapshot().unwrap();
    assert_eq!(
        store
            .write_guarded(&catalog, &prefs, Some(&payload(&record)), Some("0"), || Ok(
                ()
            ))
            .unwrap_err(),
        "catalog-revision-stale"
    );
    let mut new: Value = serde_json::from_str(&catalog).unwrap();
    new["channels"][0]["name"] = json!("Changed");
    let mut updated = record.clone();
    updated["observedAt"] = json!(200);
    let pair = RecordPair {
        catalog: Some(new.to_string()),
        preferences: Some(prefs.clone()),
    };
    let mut c = connect(&root.path().join(DB), false).unwrap();
    assert_eq!(
        PairStore::apply_guarded(&mut c, &pair, Some(&payload(&updated)), Some(1), |phase| {
            if phase == Phase::BeforeCommit {
                Err("canceled".into())
            } else {
                Ok(())
            }
        })
        .unwrap_err(),
        "canceled"
    );
    drop(c);
    let after = store.read_snapshot().unwrap();
    assert_eq!(after.pair, before.pair);
    assert_eq!(after.health, before.health);
    assert_eq!(after.catalog_revision, before.catalog_revision);
    let mut calls = 0;
    assert_eq!(
        store
            .write_guarded(&catalog, &prefs, None, None, || {
                calls += 1;
                Err("application-closing".into())
            })
            .unwrap_err(),
        "application-closing"
    );
    assert_eq!(calls, 1);
    std::fs::remove_file(root.path().join(BACKUP)).unwrap();
    std::fs::create_dir(root.path().join(BACKUP)).unwrap();
    assert!(store
        .write_guarded(
            &new.to_string(),
            &prefs,
            Some(&payload(&updated)),
            None,
            || Ok(())
        )
        .is_err());
    assert_eq!(store.read_snapshot().unwrap().health, before.health);
}
#[test]
fn native_evidence_validation_and_contextual_reconciliation_match_shared_rules() {
    let (catalog, _, record) = fixture();
    let cat: Value = serde_json::from_str(&catalog).unwrap();
    let old = payload(&record);
    for kind in ["canceled", "not-checked", "local-network-unavailable"] {
        let mut r = record.clone();
        r["observedAt"] = json!(200);
        r["verdict"] = json!(if kind == "canceled" {
            "Canceled"
        } else {
            "NotChecked"
        });
        r["evidence"] = json!({"kind":kind});
        assert_eq!(
            health_storage::reconcile(Some(&old), Some(&payload(&r)), Some(&cat))
                .unwrap()
                .unwrap(),
            health_storage::encode(&health_storage::parse(&old).unwrap()).unwrap()
        );
    }
    let mut imported = record.clone();
    imported["origin"] = json!("imported");
    imported["observedAt"] = json!(200);
    assert_eq!(
        health_storage::parse(
            &health_storage::reconcile(Some(&old), Some(&payload(&imported)), Some(&cat))
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        health_storage::parse(&old).unwrap()
    );
    let mut forged = record.clone();
    forged["verdict"] = json!("PlayedHere");
    assert!(health_storage::parse(&payload(&forged)).is_err());
    forged = record.clone();
    forged["evidence"]["body"] = json!("untrusted response");
    assert!(health_storage::parse(&payload(&forged)).is_err());
    assert!(health_storage::parse(
        &json!({"schemaVersion":1,"records":[record.clone(),record.clone()]}).to_string()
    )
    .is_err());
    let mut profile = record.clone();
    profile["observerProfile"] = json!("native-other");
    let both = health_storage::reconcile(Some(&old), Some(&payload(&profile)), Some(&cat))
        .unwrap()
        .unwrap();
    assert_eq!(health_storage::parse(&both).unwrap().len(), 2);
}

#[test]
fn actual_v4_migration_preserves_catalog_and_verified_backup() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let (catalog, prefs, _) = fixture();
    store.write_pair(&catalog, &prefs).unwrap();
    let before = store.read_pair().unwrap();
    drop(store);
    let c = connect(&root.path().join(DB), false).unwrap();
    c.execute_batch("DROP TABLE public_archive_variant_v1;DROP TABLE public_archive_item_v1;DROP TABLE public_archive_preference_v1;DROP TABLE public_archive_removal_v1;DROP TABLE public_archive_checkpoint_v1;DROP TABLE archive_bookmark_v1;DROP TABLE archive_bookmark_meta_v1;DROP TABLE archive_file_v1;DROP TABLE archive_item_progress_v1;DROP TABLE archive_progress_v1;DROP TABLE archive_preferences_v1;DROP TABLE archive_removal_v1;DROP TABLE archive_title_v1;DROP TABLE archive_catalog_meta_v1;DROP TABLE catalog_endpoint_projection_v1;DROP TABLE catalog_trigram;DROP TABLE catalog_shortgram;DROP TABLE catalog_projection;DROP TABLE catalog_projection_meta;DROP INDEX catalog_channel_state;DROP INDEX catalog_channel_region;ALTER TABLE preference DROP COLUMN source_refresh_cadence;ALTER TABLE guide_program DROP COLUMN categories_json;ALTER TABLE guide_program DROP COLUMN categories_key;ALTER TABLE preference DROP COLUMN reviewed_channel_providers;ALTER TABLE preference DROP COLUMN reviewed_guide_providers;ALTER TABLE preference DROP COLUMN preferred_region;ALTER TABLE preference DROP COLUMN voice_search_consent;ALTER TABLE preference DROP COLUMN auto_source_refresh;ALTER TABLE preference DROP COLUMN source_refresh_attempt_at;DROP TABLE channel_health;ALTER TABLE metadata DROP COLUMN catalog_revision;ALTER TABLE metadata DROP COLUMN health_revision;ALTER TABLE metadata DROP COLUMN health_present;ALTER TABLE metadata DROP COLUMN automatic_guide_updates;PRAGMA user_version=4;").unwrap();
    drop(c);
    let store = PairStore::new(root.path().into()).unwrap();
    assert_eq!(store.read_pair().unwrap(), before);
    assert!(store.read_snapshot().unwrap().health.is_none());
    let migrated = connect(&root.path().join(DB), true).unwrap();
    assert_eq!(
        migrated
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        16
    );
    let backup = connect(&root.path().join(BACKUP), true).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        4
    );
    integrity(&backup).unwrap();
}
#[test]
fn decoded_progress_numeric_parity_payload_budget_and_stored_corruption() {
    let (catalog, prefs, mut record) = fixture();
    record["evidence"] = json!({"kind":"decoded","before":{"mediaTime":1.0,"decodedFrames":10.0,"width":320.0,"height":180.0},"after":{"mediaTime":2.0,"decodedFrames":11.0,"width":320.0,"height":180.0},"elapsedMilliseconds":1000.0});
    record["verdict"] = json!("PlayedHere");
    record["observedAt"] = json!(100.0);
    record["checkedUrlOrdinal"] = json!(0.0);
    record["schemaVersion"] = json!(1.0);
    assert_eq!(health_storage::parse(&payload(&record)).unwrap().len(), 1);
    record["evidence"]["after"]["decodedFrames"] = json!(10.0);
    assert!(health_storage::parse(&payload(&record)).is_err());
    assert!(health_storage::parse(&" ".repeat(20 * 1024 * 1024 + 1)).is_err());
    let (_, _, good) = fixture();
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    store
        .write_guarded(&catalog, &prefs, Some(&payload(&good)), None, || Ok(()))
        .unwrap();
    let c = connect(&root.path().join(DB), false).unwrap();
    c.execute(
        "UPDATE channel_health SET evidence_json=?1",
        params!["x".repeat(4097)],
    )
    .unwrap();
    drop(c);
    assert_eq!(
        store.read_snapshot().unwrap_err(),
        "health-invalid-stored-record"
    );
}
#[test]
fn commit_receipt_survives_cancellation_after_durable_commit_and_revision_bounds() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let (catalog, prefs, record) = fixture();
    let pair = RecordPair {
        catalog: Some(catalog.clone()),
        preferences: Some(prefs.clone()),
    };
    let mut c = connect(&root.path().join(DB), false).unwrap();
    let canceled = std::sync::atomic::AtomicBool::new(false);
    let receipt =
        PairStore::apply_guarded(&mut c, &pair, Some(&payload(&record)), Some(0), |phase| {
            if phase == Phase::AfterCommit {
                canceled.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(())
        })
        .unwrap();
    assert!(receipt.committed);
    assert!(canceled.load(std::sync::atomic::Ordering::SeqCst));
    drop(c);
    assert_eq!(store.read_snapshot().unwrap().catalog_revision, "1");
    for value in ["-1", "01", "9223372036854775808", "1.0", ""] {
        assert_eq!(
            store
                .write_guarded(&catalog, &prefs, None, Some(value), || Ok(()))
                .unwrap_err(),
            "catalog-revision-invalid"
        );
    }
    let c = connect(&root.path().join(DB), false).unwrap();
    c.execute("UPDATE metadata SET health_revision=?1", params![i64::MAX])
        .unwrap();
    drop(c);
    assert_eq!(
        store
            .write_guarded(&catalog, &prefs, None, None, || Ok(()))
            .unwrap_err(),
        "storage-revision-exhausted"
    );
}

#[test]
fn actual_cancellation_while_waiting_storage_lock_prevents_admission() {
    let root = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(PairStore::new(root.path().into()).unwrap());
    let (catalog, prefs, record) = fixture();
    let mut requests = crate::requests::Requests::default();
    requests.cancel("pre-canceled-health".into()).unwrap();
    assert_eq!(
        requests.register("pre-canceled-health".into()).unwrap_err(),
        "canceled"
    );
    let mut receiver = requests.register("queued-health".into()).unwrap();
    let gate = std::sync::Arc::new(std::sync::Mutex::new(()));
    let held = gate.lock().unwrap();
    let cloned_gate = gate.clone();
    let cloned_store = store.clone();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        let _held = cloned_gate.lock().unwrap();
        cloned_store.write_guarded(&catalog, &prefs, Some(&payload(&record)), Some("0"), || {
            if matches!(
                receiver.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ) {
                Ok(())
            } else {
                Err("canceled".into())
            }
        })
    });
    started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    requests.cancel("queued-health".into()).unwrap();
    drop(held);
    assert_eq!(thread.join().unwrap().unwrap_err(), "canceled");
    requests.finish("queued-health");
    let snapshot = store.read_snapshot().unwrap();
    assert!(snapshot.pair.catalog.is_none());
    assert!(snapshot.health.is_none());
    assert_eq!(snapshot.catalog_revision, "0");
    assert_eq!(snapshot.health_revision, "0");
}

#[test]
fn initial_snapshot_health_failure_is_latched_only_before_any_success() {
    for already_read in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let store = crate::storage::Store::new(root.path().into(), "fixture".into()).unwrap();
        let (catalog, prefs, record) = fixture();
        store
            .write_guarded(
                &catalog,
                &prefs,
                Some(&payload(&record)),
                (Some("0"), Some("0")),
                || Ok(()),
            )
            .unwrap();
        let mut current = Ok(store);
        let succeeded = std::sync::atomic::AtomicBool::new(false);
        if already_read {
            crate::storage::read_initial_pair(&mut current, &succeeded).unwrap();
        }
        let c = connect(&root.path().join(DB), false).unwrap();
        c.execute(
            "UPDATE channel_health SET target_fingerprint=?1",
            params!["0".repeat(64)],
        )
        .unwrap();
        drop(c);
        assert_eq!(
            crate::storage::read_initial_pair(&mut current, &succeeded).unwrap_err(),
            "health-stored-target-mismatch"
        );
        assert_eq!(
            succeeded.load(std::sync::atomic::Ordering::SeqCst),
            already_read
        );
        assert_eq!(current.is_ok(), already_read);
    }
}
#[test]
fn standalone_health_input_limit_does_not_consume_catalog_limit() {
    let empty = "{\"schemaVersion\":1,\"records\":[]}";
    let accepted = format!("{empty}{}", " ".repeat(20 * 1024 * 1024 - empty.len()));
    assert!(health_storage::parse(&accepted).unwrap().is_empty());
    let oversized = format!("{accepted} ");
    assert!(health_storage::parse(&oversized).is_err());
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let (catalog, prefs, _) = fixture();
    let receipt = store
        .write_guarded(&catalog, &prefs, Some(&accepted), None, || Ok(()))
        .unwrap();
    assert_eq!(receipt.catalog_revision, "1");
    assert_eq!(receipt.health_revision, "1");
    assert!(store.read_snapshot().unwrap().health.is_some());
}

#[test]
fn health_target_admission_is_stricter_than_catalog_and_legacy_edit_filters_old_evidence() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    let (catalog, prefs, record) = fixture();
    store
        .write_guarded(&catalog, &prefs, Some(&payload(&record)), None, || Ok(()))
        .unwrap();
    let before = store.read_snapshot().unwrap();
    let mut cat: Value = serde_json::from_str(&catalog).unwrap();
    let mut pref: Value = serde_json::from_str(&prefs).unwrap();
    cat["sources"][0]["location"] = json!("fixture\nfile.m3u");
    pref["sources"] = cat["sources"].clone();
    let mut forged = record.clone();
    let tuple = json!([
        "health-target-v1",
        "source",
        "file",
        "fixture\nfile.m3u",
        false,
        "channel",
        0,
        "https://example.invalid/live"
    ]);
    forged["targetFingerprint"] = json!(format!(
        "{:x}",
        Sha256::digest(tuple.to_string().as_bytes())
    ));
    assert_eq!(
        store
            .write_guarded(
                &cat.to_string(),
                &pref.to_string(),
                Some(&payload(&forged)),
                Some("1"),
                || Ok(())
            )
            .unwrap_err(),
        "health-target-invalid"
    );
    assert_eq!(store.read_snapshot().unwrap().pair, before.pair);
    assert_eq!(store.read_snapshot().unwrap().health, before.health);
    let receipt = store
        .write_record_guarded("catalog", &cat.to_string(), Some("1"), || Ok(()))
        .unwrap();
    assert_eq!(receipt.catalog_revision, "2");
    assert_eq!(receipt.health_revision, "2");
    assert!(
        health_storage::parse(store.read_snapshot().unwrap().health.as_deref().unwrap())
            .unwrap()
            .is_empty()
    );
}
#[test]
fn target_url_source_scope_and_http_grant_refusals_match_shared_contract() {
    let (catalog, _, _) = fixture();
    let cat: Value = serde_json::from_str(&catalog).unwrap();
    let source = cat["sources"][0].clone();
    let channel = cat["channels"][0].clone();
    let expected = health_storage::fingerprint(&source, &channel, 0).unwrap();
    let mut explicit_false = source.clone();
    explicit_false["allowHttp"] = json!(false);
    assert_eq!(
        health_storage::fingerprint(&explicit_false, &channel, 0).unwrap(),
        expected
    );
    for raw in [
        "http://example.invalid/live",
        "https://name:secret@example.invalid/live",
        "https://example.invalid/live\n",
        "file:///fixture",
    ] {
        let mut ch = channel.clone();
        ch["urls"][0] = json!(raw);
        assert_eq!(
            health_storage::fingerprint(&source, &ch, 0).unwrap_err(),
            "health-target-invalid"
        );
    }
    let mut granted = source.clone();
    granted["allowHttp"] = json!(true);
    let mut http = channel.clone();
    http["urls"][0] = json!("http://example.invalid/live");
    assert!(health_storage::fingerprint(&granted, &http, 0).is_ok());
    let mut mismatch = channel.clone();
    mismatch["sourceId"] = json!("another-source");
    assert!(health_storage::fingerprint(&source, &mismatch, 0).is_err());
    assert!(health_storage::fingerprint(&source, &channel, 16).is_err());
    let mut online = source.clone();
    online["kind"] = json!("url");
    online["location"] = json!("http://example.invalid/catalog");
    assert!(health_storage::fingerprint(&online, &channel, 0).is_err());
    online["allowHttp"] = json!(true);
    assert!(health_storage::fingerprint(&online, &channel, 0).is_ok());
}
