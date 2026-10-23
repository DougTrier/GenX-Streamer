use super::*;
use serde_json::{json, Value};
use std::sync::{mpsc, Arc};
use std::time::Duration;

fn seeded(path: &std::path::Path) -> Store {
    let store = Store::new(path.to_owned(), "test".into()).unwrap();
    let source = json!([{"id":"source","name":"Fixture","kind":"file","location":"fixture.m3u"}]);
    store.write_guarded(
        &json!({"schemaVersion":1,"sources":source,"channels":[{"id":"channel","sourceId":"source","name":"Old","category":"Sports","urls":["https://example.invalid/live"]}]}).to_string(),
        &json!({"schemaVersion":1,"sources":source,"favorites":[],"removedChannels":[],"volume":0.5,"muted":false,"panelWidth":300.0}).to_string(),
        None,(None,None),||Ok(())
    ).unwrap();
    store
}
fn snapshot_values(s: &RecordSnapshot) -> (String, f64) {
    let c: Value = serde_json::from_str(s.pair.catalog.as_ref().unwrap()).unwrap();
    let p: Value = serde_json::from_str(s.pair.preferences.as_ref().unwrap()).unwrap();
    (
        c["channels"][0]["name"].as_str().unwrap().to_owned(),
        p["volume"].as_f64().unwrap(),
    )
}
#[test]
fn reader_observes_old_then_new_consistent_sqlite_snapshot_while_writer_is_retained() {
    let root = tempfile::tempdir().unwrap();
    let owner = Arc::new(StoreOwner::new(Ok(seeded(root.path()))));
    let old = owner
        .read()
        .unwrap()
        .as_ref()
        .unwrap()
        .read_snapshot()
        .unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let worker = owner.clone();
    let task = std::thread::spawn(move || {
        let lease = worker.read().unwrap();
        lease.as_ref().unwrap().with_guide_write(|c| {
            c.execute_batch("BEGIN IMMEDIATE;UPDATE channel SET name='New';UPDATE preference SET volume=0.75;UPDATE metadata SET catalog_revision=catalog_revision+1,revision=revision+1;").unwrap();
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).map_err(|_|"fixture-release".to_string())?;
            c.execute_batch("COMMIT").unwrap();Ok(())
        })
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    // The real transaction has uncommitted replacements, not a mock mutex.
    let during = owner
        .read()
        .unwrap()
        .as_ref()
        .unwrap()
        .read_snapshot()
        .unwrap();
    assert_eq!(during, old);
    assert_eq!(snapshot_values(&during), ("Old".into(), 0.5));
    release_tx.send(()).unwrap();
    task.join().unwrap().unwrap();
    let after = owner
        .read()
        .unwrap()
        .as_ref()
        .unwrap()
        .read_snapshot()
        .unwrap();
    assert_eq!(snapshot_values(&after), ("New".into(), 0.75));
    assert_eq!(
        after.catalog_revision.parse::<i64>().unwrap(),
        old.catalog_revision.parse::<i64>().unwrap() + 1
    );
    assert_eq!(after.health_revision, old.health_revision);
    let backup = rusqlite::Connection::open_with_flags(
        root.path().join("genx.sqlite3.backup"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        backup
            .query_row("SELECT name FROM channel", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "Old"
    );
}
#[test]
fn root_replacement_waits_for_old_reader_and_writer_and_stale_failure_cannot_poison_it() {
    let old_root = tempfile::tempdir().unwrap();
    let new_root = tempfile::tempdir().unwrap();
    let owner = Arc::new(StoreOwner::new(Ok(seeded(old_root.path()))));
    let lease = owner.read().unwrap();
    let old_generation = lease.0.number;
    let writer = lease.as_ref().unwrap().write_lease().unwrap();
    assert!(owner.0.try_write().is_err());
    let next = seeded(new_root.path());
    let replacement = owner.clone();
    let (attempt_tx, attempt_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let task = std::thread::spawn(move || {
        attempt_tx.send(()).unwrap();
        *replacement.exclusive().unwrap() = Ok(next);
        done_tx.send(()).unwrap();
    });
    attempt_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(done_rx.try_recv().is_err());
    drop(writer);
    assert!(owner.0.try_write().is_err());
    drop(lease);
    done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    task.join().unwrap();
    owner
        .poison_initial(
            old_generation,
            "sqlite-operation-failed",
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(owner.read().unwrap().is_ok());
}

#[test]
fn maintenance_quarantine_revokes_only_the_verified_generation() {
    let root = tempfile::tempdir().unwrap();
    let owner = StoreOwner::new(Ok(seeded(root.path())));
    let generation = owner.read().unwrap().generation();
    assert!(owner.quarantine_after_maintenance(generation).unwrap());
    let lease = owner.read().unwrap();
    assert_eq!(lease.generation(), generation + 1);
    assert_eq!(
        lease.as_ref().err().unwrap(),
        "storage-maintenance-verification-failed"
    );
    drop(lease);
    assert!(!owner.quarantine_after_maintenance(generation).unwrap());
    assert_eq!(owner.read().unwrap().generation(), generation + 1);
}

#[test]
fn obsolete_maintenance_verification_cannot_quarantine_a_replacement_root() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let owner = StoreOwner::new(Ok(seeded(first.path())));
    let generation = owner.read().unwrap().generation();
    *owner.exclusive().unwrap() = Ok(seeded(second.path()));
    let before = owner
        .read()
        .unwrap()
        .as_ref()
        .unwrap()
        .read_snapshot()
        .unwrap();
    assert!(!owner.quarantine_after_maintenance(generation).unwrap());
    let lease = owner.read().unwrap();
    assert_eq!(lease.generation(), generation + 1);
    assert_eq!(lease.as_ref().unwrap().read_snapshot().unwrap(), before);
}

#[test]
fn maintenance_quarantine_waits_for_the_last_reader() {
    let root = tempfile::tempdir().unwrap();
    let owner = Arc::new(StoreOwner::new(Ok(seeded(root.path()))));
    let reader = owner.read().unwrap();
    let generation = reader.generation();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let worker = owner.clone();
    let task = std::thread::spawn(move || {
        entered_tx.send(()).unwrap();
        done_tx
            .send(worker.quarantine_after_maintenance(generation))
            .unwrap();
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(done_rx.try_recv().is_err());
    assert!(reader.as_ref().is_ok());
    drop(reader);
    assert!(done_rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap());
    task.join().unwrap();
    assert!(owner.read().unwrap().is_err());
}

#[test]
fn exhausted_maintenance_generation_preserves_the_existing_root() {
    let root = tempfile::tempdir().unwrap();
    let owner = StoreOwner::new(Ok(seeded(root.path())));
    owner.0.write().unwrap().number = u64::MAX;
    assert_eq!(
        owner.quarantine_after_maintenance(u64::MAX).unwrap_err(),
        "storage-generation-exhausted"
    );
    let lease = owner.read().unwrap();
    assert_eq!(lease.generation(), u64::MAX);
    assert!(lease.as_ref().is_ok());
}
#[test]
fn initial_failure_latches_only_before_success_and_same_generation() {
    let root = tempfile::tempdir().unwrap();
    let owner = StoreOwner::new(Ok(seeded(root.path())));
    let generation = owner.read().unwrap().0.number;
    let succeeded = AtomicBool::new(false);
    owner.read_initial(&succeeded).unwrap();
    owner
        .poison_initial(generation, "failure-after-success", &succeeded)
        .unwrap();
    assert!(owner.read().unwrap().is_ok());
    let failing = StoreOwner::new(Err("sqlite-storage-busy".into()));
    assert_eq!(
        failing.read_initial(&AtomicBool::new(false)).unwrap_err(),
        "sqlite-storage-busy"
    );
    assert_eq!(
        failing.read().unwrap().as_ref().err().unwrap(),
        "sqlite-storage-busy"
    );
}
#[test]
fn narrow_guide_capture_requires_prior_validated_startup_and_retains_root_lease() {
    let root = tempfile::tempdir().unwrap();
    let owner = StoreOwner::new(Ok(seeded(root.path())));
    let succeeded = AtomicBool::new(false);
    assert_eq!(
        owner.read_guide_capture(&succeeded).unwrap_err(),
        "storage-not-ready"
    );
    assert!(!succeeded.load(Ordering::SeqCst));
    let original = owner.read_initial(&succeeded).unwrap();
    let captured = owner.read_guide_capture(&succeeded).unwrap();
    assert_eq!(captured.pair, original.pair);
    assert_eq!(captured.catalog_revision, original.catalog_revision);
    let failed = StoreOwner::new(Err("storage-unavailable".into()));
    assert_eq!(
        failed
            .read_guide_capture(&AtomicBool::new(true))
            .unwrap_err(),
        "storage-unavailable"
    );
}
#[test]
fn queued_canceled_writer_never_changes_database_or_validated_backup() {
    let root = tempfile::tempdir().unwrap();
    let owner = Arc::new(StoreOwner::new(Ok(seeded(root.path()))));
    let lease = owner.read().unwrap();
    let store = lease.as_ref().unwrap();
    let original = store.read_snapshot().unwrap();
    let database = std::fs::read(root.path().join("genx.sqlite3")).unwrap();
    let backup = std::fs::read(root.path().join("genx.sqlite3.backup")).unwrap();
    let held = store.write_lease().unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let queued = owner.clone();
    let canceled = cancel.clone();
    let expected = original.catalog_revision.clone();
    let pair = original.pair.clone();
    let (started_tx, started_rx) = mpsc::channel();
    let task = std::thread::spawn(move || {
        let lease = queued.read().unwrap();
        started_tx.send(()).unwrap();
        lease.as_ref().unwrap().write_pair_with_scan(
            &pair,
            None,
            (Some(&expected), None),
            None,
            || {
                if canceled.load(Ordering::SeqCst) {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
        )
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    cancel.store(true, Ordering::SeqCst);
    drop(held);
    assert_eq!(task.join().unwrap().unwrap_err(), "canceled");
    assert_eq!(store.read_snapshot().unwrap(), original);
    assert_eq!(
        std::fs::read(root.path().join("genx.sqlite3")).unwrap(),
        database
    );
    assert_eq!(
        std::fs::read(root.path().join("genx.sqlite3.backup")).unwrap(),
        backup
    );
}
#[test]
fn second_writer_cas_refuses_after_serialized_commit_and_read_connection_cannot_write() {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(seeded(root.path()));
    let original = store.read_snapshot().unwrap();
    let expected = original.catalog_revision.clone();
    let mut next = original.pair.clone();
    let mut c: Value = serde_json::from_str(next.catalog.as_ref().unwrap()).unwrap();
    c["channels"][0]["name"] = json!("Committed");
    next.catalog = Some(c.to_string());
    let held = store.write_lease().unwrap();
    let canceled = AtomicBool::new(false);
    let first = store.clone();
    let p1 = next.clone();
    let e1 = expected.clone();
    let task = std::thread::spawn(move || {
        first.write_pair_with_scan(&p1, None, (Some(&e1), None), None, || Ok(()))
    });
    drop(held);
    let receipt = task.join().unwrap().unwrap();
    assert!(receipt.committed);
    assert_eq!(
        store
            .write_pair_with_scan(&original.pair, None, (Some(&expected), None), None, || {
                if canceled.load(Ordering::SeqCst) {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            })
            .unwrap_err(),
        "catalog-revision-stale"
    );
    store
        .with_guide_read(|c| {
            assert!(c
                .execute("UPDATE metadata SET revision=revision+1", [])
                .is_err());
            assert_eq!(
                c.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                "delete"
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(
        snapshot_values(&store.read_snapshot().unwrap()),
        ("Committed".into(), 0.5)
    );
}

#[test]
fn simultaneous_pair_writers_have_one_cas_winner_and_backup_is_committed_data() {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(seeded(root.path()));
    let original = store.read_snapshot().unwrap();
    let held = store.write_lease().unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut tasks = Vec::new();
    for name in ["First", "Second"] {
        let owner = store.clone();
        let expected = original.catalog_revision.clone();
        let mut pair = original.pair.clone();
        let mut catalog: Value = serde_json::from_str(pair.catalog.as_ref().unwrap()).unwrap();
        catalog["channels"][0]["name"] = json!(name);
        pair.catalog = Some(catalog.to_string());
        let ready = barrier.clone();
        tasks.push(std::thread::spawn(move || {
            ready.wait();
            (
                name,
                owner.write_pair_with_scan(&pair, None, (Some(&expected), None), None, || Ok(())),
            )
        }));
    }
    barrier.wait();
    drop(held);
    let outcomes: Vec<_> = tasks.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(outcomes.iter().filter(|(_, r)| r.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|(_, r)| r
                .as_ref()
                .err()
                .is_some_and(|e| e == "catalog-revision-stale"))
            .count(),
        1
    );
    let winner = outcomes.iter().find(|(_, r)| r.is_ok()).unwrap().0;
    let after = store.read_snapshot().unwrap();
    assert_eq!(snapshot_values(&after).0, winner);
    assert_eq!(
        after.catalog_revision.parse::<u64>().unwrap(),
        original.catalog_revision.parse::<u64>().unwrap() + 1
    );
    let backup = rusqlite::Connection::open(root.path().join("genx.sqlite3.backup")).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        backup
            .query_row("SELECT name FROM channel", [], |r| r.get::<_, String>(0))
            .unwrap(),
        winner
    );
}

#[test]
fn actual_first_read_failure_poison_retains_backup_and_healthy_later_failure_does_not() {
    for prior_success in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let owner = StoreOwner::new(Ok(seeded(root.path())));
        let succeeded = AtomicBool::new(false);
        if prior_success {
            owner.read_initial(&succeeded).unwrap();
        }
        let backup = std::fs::read(root.path().join("genx.sqlite3.backup")).unwrap();
        std::fs::write(root.path().join("genx.sqlite3"), b"broken owned fixture").unwrap();
        assert!(owner.read_initial(&succeeded).is_err());
        assert_eq!(owner.read().unwrap().is_ok(), prior_success);
        assert_eq!(
            std::fs::read(root.path().join("genx.sqlite3.backup")).unwrap(),
            backup
        );
    }
}

#[tokio::test]
async fn abandoned_awaiter_retains_store_lease_and_work_until_actual_writer_settlement() {
    let root = tempfile::tempdir().unwrap();
    let owner = Arc::new(StoreOwner::new(Ok(seeded(root.path()))));
    let work = Arc::new(crate::close_owner::WorkOwner::default());
    let guard = work.acquire();
    let target = owner.clone();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let task = tokio::task::spawn_blocking(move || {
        let _work = guard;
        let lease = target.read().unwrap();
        lease
            .as_ref()
            .unwrap()
            .with_guide_write(|c| {
                c.execute_batch("BEGIN IMMEDIATE;UPDATE preference SET volume=0.75")
                    .unwrap();
                entered_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(|_| "fixture-release".to_string())?;
                c.execute_batch("COMMIT").unwrap();
                Ok(())
            })
            .unwrap();
    });
    entered_rx.await.unwrap();
    drop(task);
    assert_eq!(work.count(), 1);
    assert!(owner.0.try_write().is_err());
    assert_eq!(
        snapshot_values(
            &owner
                .read()
                .unwrap()
                .as_ref()
                .unwrap()
                .read_snapshot()
                .unwrap()
        )
        .1,
        0.5
    );
    release_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), work.drained())
        .await
        .unwrap();
    assert_eq!(work.count(), 0);
    assert_eq!(
        snapshot_values(
            &owner
                .read()
                .unwrap()
                .as_ref()
                .unwrap()
                .read_snapshot()
                .unwrap()
        )
        .1,
        0.75
    );
    assert!(owner.exclusive().unwrap().is_ok());
}

#[test]
fn paired_health_checkpoint_reads_remain_atomic_during_backup_and_precommit_then_reopen() {
    use crate::scan_checkpoint::{self, Mutation};
    use crate::storage_transaction::{Phase, RecordPair};
    let root = tempfile::tempdir().unwrap();
    let store = Store::new(root.path().to_owned(), "test".into()).unwrap();
    let source = json!({"id":"public","name":"Public","kind":"url","location":"https://iptv-org.github.io/iptv/index.m3u","allowHttp":false});
    let mut catalog = json!({"schemaVersion":1,"sources":[source.clone()],"channels":[]});
    let mut prefs = json!({"schemaVersion":1,"sources":[source.clone()],"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":300});
    store
        .write_guarded(
            &catalog.to_string(),
            &prefs.to_string(),
            None,
            (None, None),
            || Ok(()),
        )
        .unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let channel = json!({"sourceId":"public","providerId":"Station","name":"Station","category":"News","urls":["https://example.com/media.m3u8?public=1"]});
    let mut checkpoint = json!({"schemaVersion":1,"jobId":"job-a","createdAtMs":now,"catalogRevision":"1","policyFingerprint":"","sourceDefinitions":[{"source":source,"definitionFingerprint":scan_checkpoint::source_fingerprint(&source).unwrap()}],"budgetMs":20000,"platform":"windows","observerProfile":"resource-v1","review":{"sessionRevision":"session-a","query":"","status":"completed","sources":[{"sourceId":"public","fingerprint":"scope-a","status":"completed","inspected":1,"matched":1,"warnings":0}],"candidates":[{"key":"key-a","sourceId":"public","sourceFingerprint":"scope-a","sessionRevision":"session-a","channel":channel}],"counts":{"inspected":1,"matched":1,"failedSources":0,"canceledSources":0}},"observations":[],"publishedKeys":[]});
    checkpoint["policyFingerprint"] =
        json!(scan_checkpoint::policy_fingerprint(&checkpoint, &prefs).unwrap());
    store
        .write_pair_with_scan(
            &RecordPair::default(),
            None,
            (Some("1"), None),
            Some((
                &Mutation::Save {
                    checkpoint: checkpoint.to_string(),
                },
                "0",
            )),
            || Ok(()),
        )
        .unwrap();
    let before = store.read_snapshot().unwrap();
    let old_checkpoint = store.read_scan_checkpoint().unwrap().checkpoint.unwrap();
    let mut published = channel.clone();
    published["id"] = json!("saved-id");
    catalog["channels"] = json!([published.clone()]);
    prefs["volume"] = json!(0.75);
    checkpoint["observations"] = json!([{"channelId":"key-a","sourceId":"public","fingerprint":"scope-a","platform":"windows","observedAt":now,"verdict":"Reachable","evidence":{"kind":"recognized-media-response"}}]);
    checkpoint["publishedKeys"] = json!(["key-a"]);
    let health = json!({"schemaVersion":1,"records":[{"schemaVersion":1,"channelId":"saved-id","sourceId":"public","checkedUrlOrdinal":0,"targetFingerprint":crate::health_storage::fingerprint(&source,&published,0).unwrap(),"platform":"windows","observerProfile":"native-mse-v1","observedAt":now,"verdict":"Reachable","evidence":{"kind":"http","status":200,"contentRecognized":true},"origin":"local"}]}).to_string();
    let owner = Arc::new(StoreOwner::new(Ok(store)));
    let target = owner.clone();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let task = std::thread::spawn(move || {
        let lease = target.read().unwrap();
        let mut held_commit = false;
        lease.as_ref().unwrap().write_pair_with_phase(
            &RecordPair {
                catalog: Some(catalog.to_string()),
                preferences: Some(prefs.to_string()),
            },
            Some(&health),
            (Some("1"), Some("0")),
            Some((
                &Mutation::Save {
                    checkpoint: checkpoint.to_string(),
                },
                "1",
            )),
            |phase| {
                if phase == Phase::BeforeBackup || (phase == Phase::BeforeCommit && !held_commit) {
                    if phase == Phase::BeforeCommit {
                        held_commit = true;
                    }
                    entered_tx.send(()).unwrap();
                    release_rx
                        .recv_timeout(Duration::from_secs(5))
                        .map_err(|_| "fixture-release".to_string())?;
                }
                Ok(())
            },
        )
    });
    let (captured_tx, captured_rx) = mpsc::channel();
    let (validate_tx, validate_rx) = mpsc::channel();
    let reader_owner = owner.clone();
    let reader = std::thread::spawn(move || {
        let lease = reader_owner.read().unwrap();
        lease.as_ref().unwrap().read_snapshot_after_capture(|| {
            captured_tx.send(()).unwrap();
            validate_rx
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| "fixture-release".to_string())?;
            Ok(())
        })
    });
    captured_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    for _ in 0..2 {
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let lease = owner.read().unwrap();
        let store = lease.as_ref().unwrap();
        assert_eq!(store.read_snapshot().unwrap(), before);
        assert_eq!(
            store.read_scan_checkpoint().unwrap().checkpoint.as_deref(),
            Some(old_checkpoint.as_str())
        );
        drop(lease);
        release_tx.send(()).unwrap();
    }
    let receipt = task.join().unwrap().unwrap();
    // COMMIT succeeded while the reader still owns immutable old data and
    // its root lease, but no SQLite transaction during expensive validation.
    assert!(owner.0.try_write().is_err());
    validate_tx.send(()).unwrap();
    assert_eq!(reader.join().unwrap().unwrap(), before);
    assert!(receipt.committed);
    assert_eq!(receipt.catalog_revision, "2");
    assert_eq!(receipt.health_revision, "1");
    assert_eq!(receipt.checkpoint_revision.as_deref(), Some("2"));
    drop(owner);
    let reopened = Store::new(root.path().to_owned(), "test".into()).unwrap();
    let after = reopened.read_snapshot().unwrap();
    assert_eq!(snapshot_values(&after), ("Station".into(), 0.75));
    assert_eq!(after.catalog_revision, "2");
    assert_eq!(after.health_revision, "1");
    let h: Value = serde_json::from_str(after.health.as_ref().unwrap()).unwrap();
    assert_eq!(h["records"].as_array().unwrap().len(), 1);
    let saved: Value =
        serde_json::from_str(&reopened.read_scan_checkpoint().unwrap().checkpoint.unwrap())
            .unwrap();
    assert_eq!(saved["catalogRevision"], "2");
    assert_eq!(saved["publishedKeys"], json!(["key-a"]));
}

#[test]
fn malformed_captured_health_refuses_even_when_writer_repairs_after_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let store = seeded(root.path());
    store.with_guide_write(|c| {
        c.execute_batch("UPDATE metadata SET health_present=1;INSERT INTO channel_health VALUES('channel',0,'windows','fixture','source','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,'Reachable','local','{');").unwrap(); Ok(())
    }).unwrap();
    let result = store.read_snapshot_after_capture(|| {
        store.with_guide_write(|c| {
            c.execute_batch("DELETE FROM channel_health;UPDATE metadata SET health_present=0;")
                .unwrap();
            Ok(())
        })
    });
    assert_eq!(result.unwrap_err(), "health-invalid-stored-record");
    assert!(store.read_snapshot().unwrap().health.is_none());
}
#[test]
fn captured_health_encoding_limit_is_refused_after_transaction_release() {
    let root = tempfile::tempdir().unwrap();
    let store = seeded(root.path());
    store.with_guide_write(|c| {
        let tx = c.transaction().unwrap();
        tx.execute_batch("UPDATE metadata SET health_present=1").unwrap();
        let id = "\\".repeat(9600);
        for n in 0..1100 {
            tx.execute("INSERT INTO channel_health VALUES(?1,?2,'windows','fixture','source',?3,1,'Reachable','local',?4)",rusqlite::params![format!("{id}{n}"),0,"a".repeat(64),r#"{"kind":"http","status":200,"contentRecognized":true}"#]).unwrap();
        }
        tx.commit().unwrap(); Ok(())
    }).unwrap();
    let mut after_capture = false;
    let result = store.read_snapshot_after_capture(|| {
        after_capture = true;
        // Captured raw strings are below 20MiB; JSON escaping exceeds the
        // wire bound. This write must complete before encoding rejects it.
        store.with_guide_write(|c| {
            c.execute_batch("UPDATE preference SET volume=0.75")
                .unwrap();
            Ok(())
        })
    });
    assert!(after_capture);
    assert_eq!(result.unwrap_err(), "health-too-large");
}
#[test]
fn malformed_and_large_captured_checkpoint_remain_explicit_invalid_after_repair() {
    for raw in ["{".to_string(), "x".repeat(20 * 1024 * 1024 + 1)] {
        let root = tempfile::tempdir().unwrap();
        let store = seeded(root.path());
        store
            .with_guide_write(|c| {
                crate::scan_checkpoint::ensure(c)?;
                c.execute(
                    "UPDATE scan_checkpoint SET revision=1,job_id='job-owned',contents=?1",
                    [&raw],
                )
                .unwrap();
                Ok(())
            })
            .unwrap();
        let captured = store
            .read_checkpoint_after_capture(|| {
                store.with_guide_write(|c| {
                    c.execute_batch(
                        "UPDATE scan_checkpoint SET revision=2,job_id=NULL,contents=NULL",
                    )
                    .unwrap();
                    Ok(())
                })
            })
            .unwrap();
        assert_eq!(captured.checkpoint_status, "invalid");
        assert_eq!(captured.checkpoint_revision, "1");
        assert_eq!(captured.job_id.as_deref(), Some("job-owned"));
        assert!(captured.checkpoint.is_none());
        assert_eq!(
            store.read_scan_checkpoint().unwrap().checkpoint_status,
            "absent"
        );
    }
}

#[test]
fn async_phase_generation_changes_even_when_replacement_has_identical_records() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let owner = StoreOwner::new(Ok(seeded(first.path())));
    let lease = owner.read().unwrap();
    let before = lease.generation();
    let snapshot = lease.as_ref().unwrap().read_snapshot().unwrap();
    drop(lease);
    *owner.exclusive().unwrap() = Ok(seeded(second.path()));
    let after = owner.read().unwrap();
    assert_ne!(before, after.generation());
    assert_eq!(snapshot, after.as_ref().unwrap().read_snapshot().unwrap());
}
