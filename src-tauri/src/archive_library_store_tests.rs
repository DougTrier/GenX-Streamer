//! Synthetic namespace/canonical fixtures only; no profiles, devices or requests.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

fn legacy() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    let tx = c.transaction().unwrap();
    archive_catalog::install(&tx).unwrap();
    archive_bookmarks::install(&tx).unwrap();
    archive_provider_catalog::install(&tx).unwrap();
    let title = archive_catalog::opaque(&["archive-item-v1", "fixture"]);
    let file = archive_catalog::opaque(&["archive-file-v1", "fixture", "episode.mp4"]);
    tx.execute("INSERT INTO archive_title_v1 VALUES(?1,'fixture','Fixture episode','tv',1964,1,1,NULL,5,10,'legacy text')",[&title]).unwrap();
    tx.execute("INSERT INTO archive_file_v1 VALUES(?1,?2,'fixture','episode.mp4','h.264','100',10.0,?3,'[]',10,1,0,'disc.iso','Episode')",params![file,title,"a".repeat(40)]).unwrap();
    tx.execute(
        "INSERT INTO archive_preferences_v1 VALUES(?1,'fixture','Fixture episode',1964,1)",
        [&title],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO archive_preferences_v1 VALUES(?1,'orphan','Removed favorite',NULL,1)",
        [archive_catalog::opaque(&["archive-item-v1", "orphan"])],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO archive_removal_v1 VALUES('file',?1,'fixture',?2,'Hidden','hidden.mp4',6)",
        params![
            archive_catalog::opaque(&["archive-file-v1", "fixture", "hidden.mp4"]),
            title
        ],
    )
    .unwrap();
    tx.execute("INSERT INTO archive_bookmark_v1 VALUES(?1,'fixture','episode.mp4','100',?2,1000,10000,0,10)",params![file,"a".repeat(40)]).unwrap();
    tx.execute(
        "INSERT INTO archive_progress_v1 VALUES(0,?1,3,0,12345)",
        ["b".repeat(64)],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO archive_item_progress_v1 VALUES('fixture',5,2,?1,123,NULL,0)",
        ["c".repeat(64)],
    )
    .unwrap();
    let id = "public-fixture";
    let tr = crate::archive_provider_contract::title_ref(
        crate::archive_provider_contract::Provider::Loc,
        id,
    );
    let item = crate::archive_provider_contract::ProviderItem {
        provider: crate::archive_provider_contract::Provider::Loc,
        item_id: id.into(),
        title: "Public fixture".into(),
        source_url: format!("https://www.loc.gov/item/{id}/"),
        metadata_url: format!("https://www.loc.gov/item/{id}/?fo=json"),
        description: None,
        subjects: vec![],
        creators: vec![],
        languages: vec![],
        release_year: None,
        date_claims: None,
        content_type: "unknown".into(),
        rights: None,
        license_url: None,
        attribution: None,
        access_restricted: None,
        download_allowed: None,
        revision: None,
        variants: vec![],
    };
    archive_provider_catalog::upsert(&tx, &item, 10).unwrap();
    tx.execute(
        "INSERT INTO public_archive_preference_v1 VALUES(?1,1)",
        [&tr],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO public_archive_removal_v1 VALUES('file',?1,?2)",
        params!["d".repeat(64), tr],
    )
    .unwrap();
    // Whitespace is deliberately retained byte-for-byte, not reserialized.
    tx.execute("INSERT INTO public_archive_checkpoint_v1 VALUES(?1,'loc',?2)",params!["e".repeat(64),"{ \"cursor\": null, \"next_cursor\": null, \"pending\": [], \"started\": true, \"complete\": true, \"retry_after_ms\": null }"]).unwrap();
    tx.execute_batch("UPDATE archive_catalog_meta_v1 SET revision=7;UPDATE archive_bookmark_meta_v1 SET revision=3;CREATE TABLE untouched(value TEXT);INSERT INTO untouched VALUES('keep');PRAGMA user_version=16;").unwrap();
    tx.commit().unwrap();
    c
}
fn seal(c: &Connection) {
    for table in [
        "public_archive_variant_v1",
        "public_archive_item_v1",
        "public_archive_preference_v1",
        "public_archive_removal_v1",
        "public_archive_checkpoint_v1",
        "archive_file_v1",
        "archive_item_progress_v1",
        "archive_title_v1",
        "archive_preferences_v1",
        "archive_removal_v1",
        "archive_progress_v1",
        "archive_bookmark_v1",
        "archive_bookmark_meta_v1",
        "archive_catalog_meta_v1",
    ] {
        c.execute_batch(&format!("DROP TABLE {table};")).unwrap();
    }
    c.execute_batch("PRAGMA user_version=17;").unwrap();
}
fn verify(c: &Connection) -> Result<(), String> {
    if c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
        .unwrap()
        != 17
    {
        return Err("seal-missing".into());
    }
    Ok(())
}
fn active() -> (tempfile::TempDir, Connection, Binding, ArchiveStore) {
    let root = tempfile::tempdir().unwrap();
    let c = legacy();
    let lease = lock_root(root.path()).unwrap();
    let b = prepare(&lease, &c, &mut || Ok(())).unwrap();
    seal(&c);
    activate(&lease, &b, || verify(&c), &mut || Ok(())).unwrap();
    drop(lease);
    let store = ArchiveStore::open(root.path(), &b, &mut || Ok(())).unwrap();
    (root, c, b, store)
}
fn image(root: &Path) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let d = root.join(DIRECTORY);
    (
        fs::read(d.join(DB)).unwrap(),
        fs::read(d.join(BACKUP)).unwrap(),
        fs::read(root.join(WITNESS)).unwrap(),
    )
}
fn assert_matching_peers(root: &Path) {
    let dir = root.join(DIRECTORY);
    let a = connect(&dir.join(DB), false, false).unwrap();
    let b = connect(&dir.join(BACKUP), false, false).unwrap();
    assert_eq!(
        snapshot(&a, &mut || Ok(())).unwrap(),
        snapshot(&b, &mut || Ok(())).unwrap()
    );
}
fn change(store: &ArchiveStore, next: i64, clear: bool) -> Result<i64, String> {
    store.write_checked(
        |_| Ok(None),
        |c, check| {
            let tx = sql(c.transaction())?;
            sql(tx.execute("UPDATE archive_catalog_meta_v1 SET revision=?1", [next]))?;
            if clear {
                sql(tx.execute("DELETE FROM archive_title_v1", []))?;
            }
            finalize(&tx, clear, check)?;
            check()?;
            sql(tx.commit())?;
            Ok(next)
        },
        &mut || Ok(()),
    )
}

#[test]
fn migration_copies_all_fourteen_exact_rows_and_preserves_other_domain() {
    let root = tempfile::tempdir().unwrap();
    let c = legacy();
    let before = source_fingerprint(&c, &mut || Ok(())).unwrap();
    let lease = lock_root(root.path()).unwrap();
    let b = prepare(&lease, &c, &mut || Ok(())).unwrap();
    assert_eq!(b.imported_digest, before);
    assert_eq!((b.source_revision, b.source_bookmark_revision), (7, 3));
    assert_eq!(
        inspect(root.path()).unwrap().unwrap().phase,
        Phase::Prepared
    );
    let copied = connect(&root.path().join(DIRECTORY).join(DB), false, false).unwrap();
    assert_eq!(source_fingerprint(&copied, &mut || Ok(())).unwrap(), before);
    assert_eq!(
        c.query_row("SELECT value FROM untouched", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "keep"
    );
    assert_eq!(snapshot(&copied, &mut || Ok(())).unwrap().sequence, 0);
    assert_eq!(prepare(&lease, &c, &mut || Ok(())).unwrap(), b);
}
#[test]
fn prepared_is_not_read_authority_and_activation_requires_actual_seal() {
    let root = tempfile::tempdir().unwrap();
    let c = legacy();
    let lease = lock_root(root.path()).unwrap();
    let b = prepare(&lease, &c, &mut || Ok(())).unwrap();
    assert_eq!(
        activate(&lease, &b, || verify(&c), &mut || Ok(())).unwrap_err(),
        "seal-missing"
    );
    drop(lease);
    assert!(ArchiveStore::open(root.path(), &b, &mut || Ok(())).is_err());
    let lease = lock_root(root.path()).unwrap();
    seal(&c);
    activate(&lease, &b, || verify(&c), &mut || Ok(())).unwrap();
    drop(lease);
    assert!(ArchiveStore::open(root.path(), &b, &mut || Ok(())).is_ok());
}
#[test]
fn unadopted_published_copy_resumes_only_exact_source_and_recreates_witness() {
    let root = tempfile::tempdir().unwrap();
    let c = legacy();
    let lease = lock_root(root.path()).unwrap();
    let b = prepare(&lease, &c, &mut || Ok(())).unwrap();
    fs::remove_file(root.path().join(WITNESS)).unwrap();
    fs::remove_file(root.path().join(DIRECTORY).join(BACKUP)).unwrap();
    assert_eq!(prepare(&lease, &c, &mut || Ok(())).unwrap(), b);
    assert!(root.path().join(DIRECTORY).join(BACKUP).exists());
    fs::remove_file(root.path().join(WITNESS)).unwrap();
    c.execute("UPDATE archive_catalog_meta_v1 SET revision=8", [])
        .unwrap();
    assert_eq!(prepare(&lease, &c, &mut || Ok(())).unwrap_err(), REPAIR);
}
#[test]
fn prepared_source_divergence_refuses_without_changing_export() {
    let root = tempfile::tempdir().unwrap();
    let c = legacy();
    let lease = lock_root(root.path()).unwrap();
    prepare(&lease, &c, &mut || Ok(())).unwrap();
    let before = image(root.path());
    c.execute("UPDATE archive_preferences_v1 SET favorite=0", [])
        .unwrap();
    assert_eq!(prepare(&lease, &c, &mut || Ok(())).unwrap_err(), REPAIR);
    assert_eq!(image(root.path()), before);
}
#[test]
fn root_os_lock_is_exclusive_and_released_on_actual_drop() {
    let root = tempfile::tempdir().unwrap();
    let lease = lock_root(root.path()).unwrap();
    assert!(lock_root(root.path()).is_err());
    drop(lease);
    assert!(lock_root(root.path()).is_ok());
}
#[test]
fn reads_and_preflight_are_read_only_and_noop_keeps_every_byte() {
    let (root, _, _, store) = active();
    let before = image(root.path());
    assert!(store
        .read(|c| sql(c.execute("DELETE FROM archive_title_v1", [])))
        .is_err());
    let result = store
        .write_checked(
            |c| {
                assert!(c.execute("DELETE FROM archive_title_v1", []).is_err());
                Ok(Some("unchanged"))
            },
            |_, _| panic!("no-op must not mutate"),
            &mut || Ok(()),
        )
        .unwrap();
    assert_eq!(result, "unchanged");
    assert_eq!(image(root.path()), before);
}
#[test]
fn stale_preflight_and_precommit_cancel_preserve_both_copies() {
    let (root, _, _, store) = active();
    let before = image(root.path());
    let err = store
        .write_checked(
            |_| Err("archive-revision-stale".into()),
            |_, _| Ok(()),
            &mut || Ok(()),
        )
        .unwrap_err();
    assert_eq!(err, "archive-revision-stale");
    let err = store
        .write_checked(
            |_| Ok(None),
            |c, check| {
                let tx = sql(c.transaction())?;
                sql(tx.execute("UPDATE archive_catalog_meta_v1 SET revision=8", []))?;
                finalize(&tx, false, check)?;
                Err::<(), String>("canceled".into())
            },
            &mut || Ok(()),
        )
        .unwrap_err();
    assert_eq!(err, "canceled");
    assert_eq!(image(root.path()), before);
}
#[test]
fn acknowledged_change_and_clear_recover_from_either_copy_corruption() {
    for bad in [DB, BACKUP] {
        let (root, _, b, store) = active();
        change(&store, 8, true).unwrap();
        let d = root.path().join(DIRECTORY);
        fs::write(d.join(bad), b"corrupt").unwrap();
        let recovered = ArchiveStore::open(root.path(), &b, &mut || Ok(())).unwrap();
        assert_eq!(recovered.read(archive_catalog::current).unwrap(), 8);
        assert_eq!(
            recovered
                .read(|c| sql(
                    c.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r
                        .get::<_, i64>(0))
                ))
                .unwrap(),
            0
        );
        let c = connect(&d.join(DB), false, false).unwrap();
        let s = snapshot(&c, &mut || Ok(())).unwrap();
        assert_eq!((s.sequence, s.epoch), (1, 1));
        assert_matching_peers(root.path());
    }
}
#[test]
fn active_never_reimports_stale_canonical_and_missing_copies_never_initialize() {
    let (root, _, b, store) = active();
    change(&store, 8, true).unwrap();
    let stale = legacy();
    let lease = lock_root(root.path()).unwrap();
    assert_eq!(prepare(&lease, &stale, &mut || Ok(())).unwrap_err(), REPAIR);
    drop(lease);
    for f in [DB, BACKUP] {
        fs::remove_file(root.path().join(DIRECTORY).join(f)).unwrap();
    }
    assert!(ArchiveStore::open(root.path(), &b, &mut || Ok(())).is_err());
    assert!(inspect(root.path()).unwrap().is_some());
}
#[test]
fn equal_sequence_divergence_crossed_history_unknown_schema_refuse() {
    let (root, _, b, store) = active();
    change(&store, 8, false).unwrap();
    let backup = connect(&root.path().join(DIRECTORY).join(BACKUP), false, false).unwrap();
    let tx = backup.unchecked_transaction().unwrap();
    tx.execute("UPDATE archive_catalog_meta_v1 SET revision=9", [])
        .unwrap();
    let mut s = control(&tx).unwrap();
    s.digest = complete_digest(
        &s,
        &walk_domain(&tx, &mut || Ok(()), |_, _| Ok(())).unwrap(),
    )
    .unwrap();
    tx.execute("UPDATE archive_namespace_meta_v1 SET digest=?1", [s.digest])
        .unwrap();
    tx.commit().unwrap();
    drop(backup);
    assert!(ArchiveStore::open(root.path(), &b, &mut || Ok(())).is_err());
    let (root, _, b, _) = active();
    let c = connect(&root.path().join(DIRECTORY).join(DB), false, false).unwrap();
    c.execute_batch("PRAGMA user_version=99;").unwrap();
    drop(c);
    assert!(ArchiveStore::open(root.path(), &b, &mut || Ok(())).is_err());
}
#[test]
fn mismatched_namespace_and_corrupt_witness_refuse() {
    let (root, _, b, _) = active();
    let mut other = b.clone();
    other.namespace = "0".repeat(64);
    assert!(ArchiveStore::open(root.path(), &other, &mut || Ok(())).is_err());
    fs::write(root.path().join(WITNESS), b"{}").unwrap();
    assert!(inspect(root.path()).is_err());
    assert!(ArchiveStore::open(root.path(), &b, &mut || Ok(())).is_err());
}
#[test]
fn late_abort_after_real_commit_preserves_receipt_and_latest_mirror() {
    let (root, _, _, store) = active();
    let canceled = AtomicBool::new(false);
    let result = store
        .write_checked(
            |_| Ok(None),
            |c, check| {
                let tx = sql(c.transaction())?;
                tx.execute("UPDATE archive_catalog_meta_v1 SET revision=8", [])
                    .unwrap();
                finalize(&tx, false, check)?;
                check()?;
                sql(tx.commit())?;
                canceled.store(true, Ordering::SeqCst);
                Ok("committed")
            },
            &mut || {
                if canceled.load(Ordering::SeqCst) {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap();
    assert_eq!(result, "committed");
    assert!(canceled.load(Ordering::SeqCst));
    assert_matching_peers(root.path());
}
#[test]
fn committed_error_is_repair_required_not_false_cancellation() {
    let (root, _, _, store) = active();
    let err = store
        .write_checked(
            |_| Ok(None),
            |c, check| {
                let tx = sql(c.transaction())?;
                tx.execute("UPDATE archive_catalog_meta_v1 SET revision=8", [])
                    .unwrap();
                finalize(&tx, false, check)?;
                sql(tx.commit())?;
                Err::<(), String>("canceled".into())
            },
            &mut || Ok(()),
        )
        .unwrap_err();
    assert_eq!(err, REPAIR);
    assert_eq!(store.read(archive_catalog::current).unwrap(), 8);
    assert_matching_peers(root.path());
}
#[test]
fn forgotten_finalize_never_acknowledges_invalid_durable_snapshot() {
    let (root, _, _, store) = active();
    let err = store
        .write_checked(
            |_| Ok(None),
            |c, _| {
                c.execute("UPDATE archive_catalog_meta_v1 SET revision=8", [])
                    .unwrap();
                Ok(())
            },
            &mut || Ok(()),
        )
        .unwrap_err();
    assert_eq!(err, REPAIR);
    let c = connect(&root.path().join(DIRECTORY).join(BACKUP), false, false).unwrap();
    assert_eq!(snapshot(&c, &mut || Ok(())).unwrap().catalog_revision, 7);
}
#[test]
fn migration_cancellation_before_publication_preserves_legacy() {
    for stop in [1, 2, 5, 20] {
        let root = tempfile::tempdir().unwrap();
        let c = legacy();
        let before = source_fingerprint(&c, &mut || Ok(())).unwrap();
        let lease = lock_root(root.path()).unwrap();
        let mut count = 0;
        let result = prepare(&lease, &c, &mut || {
            count += 1;
            if count == stop {
                Err("canceled".into())
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        assert_eq!(source_fingerprint(&c, &mut || Ok(())).unwrap(), before);
        assert!(inspect(root.path()).unwrap().is_none());
    }
}

#[test]
fn postcommit_latest_mirror_failure_preserves_committed_primary_and_truthful_error() {
    let (root, _, binding, store) = active();
    let dir = root.path().join(DIRECTORY);
    let result = store.write_checked(
        |_| Ok(None),
        |c, check| {
            let tx = sql(c.transaction())?;
            tx.execute("UPDATE archive_catalog_meta_v1 SET revision=8", [])
                .unwrap();
            finalize(&tx, false, check)?;
            sql(tx.commit())?;
            fs::remove_file(dir.join(BACKUP)).unwrap();
            fs::create_dir(dir.join(BACKUP)).unwrap();
            Ok("committed")
        },
        &mut || Ok(()),
    );
    assert_eq!(result.unwrap_err(), REPAIR);
    let current = connect(&dir.join(DB), false, false).unwrap();
    assert_eq!(
        snapshot(&current, &mut || Ok(())).unwrap().catalog_revision,
        8
    );
    drop(current);
    // Storage errors never cause an overwrite of the obstructing path.
    assert!(ArchiveStore::open(root.path(), &binding, &mut || Ok(())).is_err());
    fs::remove_dir(dir.join(BACKUP)).unwrap();
    let restored = ArchiveStore::open(root.path(), &binding, &mut || Ok(())).unwrap();
    assert_eq!(restored.read(archive_catalog::current).unwrap(), 8);
    assert_matching_peers(root.path());
}

#[test]
fn unsupported_legacy_schema_and_unsafe_corrupt_journal_never_fallback() {
    let root = tempfile::tempdir().unwrap();
    let legacy = legacy();
    legacy.execute_batch("PRAGMA user_version=99;").unwrap();
    let lease = lock_root(root.path()).unwrap();
    assert_eq!(
        prepare(&lease, &legacy, &mut || Ok(())).unwrap_err(),
        SCHEMA
    );
    drop(lease);
    let (root, _, binding, _) = active();
    let dir = root.path().join(DIRECTORY);
    fs::write(dir.join(DB), b"bad header").unwrap();
    fs::write(dir.join(format!("{DB}-journal")), b"unresolved").unwrap();
    assert!(ArchiveStore::open(root.path(), &binding, &mut || Ok(())).is_err());
    assert_eq!(fs::read(dir.join(DB)).unwrap(), b"bad header");
}

#[test]
fn actual_quickcheck_cancel_and_guard_unwind_join_worker_without_replacement() {
    let (root, _, _, store) = active();
    let before = image(root.path());
    let path = root.path().join("quick-fixture.sqlite3");
    let c = connect(&path, true, false).unwrap();
    c.execute_batch("CREATE TABLE padding(id INTEGER PRIMARY KEY,value TEXT); CREATE INDEX padding_value ON padding(value); BEGIN;").unwrap();
    {
        let mut insert = c.prepare("INSERT INTO padding VALUES(?1,?2)").unwrap();
        for n in 0..10_000 {
            insert
                .execute(params![n, format!("fixture-cell-{n:05}")])
                .unwrap();
        }
    }
    c.execute_batch("COMMIT;").unwrap();
    drop(c);
    let mut checks = 0;
    let error = quick_check_owned(&path, &mut || {
        checks += 1;
        if checks == 2 {
            Err("canceled".into())
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert_eq!(error, "canceled");
    assert_eq!(checks, 2);
    assert_eq!(image(root.path()), before);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut checks = 0;
        quick_check_owned(&path, &mut || {
            checks += 1;
            if checks == 2 {
                panic!("fixture authority unwind")
            }
            Ok(())
        })
        .unwrap();
    }));
    assert!(outcome.is_err());
    // Real worker disposal has completed, so ordinary reads and OS lock reuse
    // succeed without a detached verifier still holding the SQLite file.
    assert_eq!(store.read(archive_catalog::current).unwrap(), 7);
    assert_eq!(image(root.path()), before);
}

#[test]
fn namespace_rejects_wal_journal_mode_without_peer_downgrade() {
    let (root, _, binding, _) = active();
    let path = root.path().join(DIRECTORY).join(DB);
    let c = connect(&path, false, false).unwrap();
    assert_eq!(
        c.query_row("PRAGMA journal_mode=WAL", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    drop(c);
    assert_eq!(
        ArchiveStore::open(root.path(), &binding, &mut || Ok(()))
            .err()
            .unwrap(),
        SCHEMA
    );
    let c = connect(&path, false, false).unwrap();
    assert_eq!(
        c.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
}

#[test]
fn shared_catalog_readers_overlap_and_wait_for_ordinary_exclusive_release() {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    let (root, _, _, store) = active();
    let store = Arc::new(store);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let first = store.clone();
    let reader = std::thread::spawn(move || {
        first.read(|_| {
            entered_tx.send(()).unwrap();
            release_rx
                .recv_timeout(Duration::from_secs(2))
                .map_err(|_| "fixture-reader".to_owned())?;
            Ok(())
        })
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let second = store.read(archive_catalog::current);
    release_tx.send(()).unwrap();
    reader.join().unwrap().unwrap();
    assert_eq!(second.unwrap(), 7);
    let held = lock_root(root.path()).unwrap();
    let pending = store.clone();
    let (entered_tx, entered_rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut entered = Some(entered_tx);
        pending.read_checked(archive_catalog::current, &mut || {
            if let Some(tx) = entered.take() {
                tx.send(()).unwrap();
            }
            Ok(())
        })
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    drop(held);
    assert_eq!(reader.join().unwrap().unwrap(), 7);
}
#[test]
fn checked_exclusive_wait_cancels_and_joins_before_shared_reader_releases() {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    let (root, _, _, store) = active();
    let before = image(root.path());
    let held = lock_wait(root.path(), true, Duration::ZERO, &mut || Ok(())).unwrap();
    let canceled = Arc::new(AtomicBool::new(false));
    let signal = canceled.clone();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        let mut entered = Some(entered_tx);
        let result = store.write_checked(
            |_| Ok(None),
            |_, _| Err::<(), String>("must-not-mutate".into()),
            &mut || {
                if let Some(tx) = entered.take() {
                    tx.send(()).unwrap();
                }
                if signal.load(Ordering::SeqCst) {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
        );
        done_tx.send(result).unwrap();
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    canceled.store(true, Ordering::SeqCst);
    let result = done_rx.recv_timeout(Duration::from_secs(1));
    drop(held);
    writer.join().unwrap();
    assert_eq!(result.unwrap().unwrap_err(), "canceled");
    assert_eq!(image(root.path()), before);
}
#[test]
fn contended_lock_wait_has_a_real_bounded_deadline_and_leaves_no_owner() {
    use std::time::{Duration, Instant};
    let (root, _, _, _) = active();
    let held = lock_root(root.path()).unwrap();
    let started = Instant::now();
    let error = lock_wait(root.path(), true, Duration::from_millis(30), &mut || Ok(()))
        .err()
        .unwrap();
    assert_eq!(error, "archive-library-storage-busy");
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(held);
    assert!(lock_root(root.path()).is_ok());
}

#[test]
fn actual_crossed_counter_histories_refuse_without_peer_replacement() {
    let (root, _, binding, _store) = active();
    let dir = root.path().join(DIRECTORY);
    let mut primary = connect(&dir.join(DB), false, false).unwrap();
    for revision in [8, 9] {
        let tx = primary.transaction().unwrap();
        tx.execute("UPDATE archive_catalog_meta_v1 SET revision=?1", [revision])
            .unwrap();
        finalize(&tx, false, &mut || Ok(())).unwrap();
        tx.commit().unwrap();
    }
    let mut backup = connect(&dir.join(BACKUP), false, false).unwrap();
    let tx = backup.transaction().unwrap();
    tx.execute("UPDATE archive_bookmark_meta_v1 SET revision=4", [])
        .unwrap();
    tx.execute("UPDATE archive_bookmark_v1 SET position_ms=2000", [])
        .unwrap();
    finalize(&tx, false, &mut || Ok(())).unwrap();
    tx.commit().unwrap();
    let a = snapshot(&primary, &mut || Ok(())).unwrap();
    let b = snapshot(&backup, &mut || Ok(())).unwrap();
    assert_eq!(
        (a.sequence, a.catalog_revision, a.bookmark_revision),
        (2, 9, 3)
    );
    assert_eq!(
        (b.sequence, b.catalog_revision, b.bookmark_revision),
        (1, 7, 4)
    );
    drop(primary);
    drop(backup);
    let before = image(root.path());
    assert_eq!(
        ArchiveStore::open(root.path(), &binding, &mut || Ok(()))
            .err()
            .unwrap(),
        REPAIR
    );
    assert_eq!(image(root.path()), before);
}

#[test]
fn future_provider_date_version_cannot_restore_older_namespace_or_touch_canonical() {
    let (root, canonical, binding, store) = active();
    let canonical_path = root.path().join("genx.sqlite3");
    let mut persisted = Connection::open(&canonical_path).unwrap();
    rusqlite::backup::Backup::new(&canonical, &mut persisted)
        .unwrap()
        .run_to_completion(100, std::time::Duration::from_millis(1), None)
        .unwrap();
    drop(persisted);
    store
        .seed_fixture(|c| {
            let raw: String = c
                .query_row(
                    "SELECT document FROM public_archive_item_v1 LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let mut nasa = archive_provider_catalog::decode_item(&raw).unwrap();
            nasa.provider = crate::archive_provider_contract::Provider::Nasa;
            nasa.source_url = format!(
                "https://images-assets.nasa.gov/video/{}/collection.json",
                nasa.item_id
            );
            nasa.metadata_url = format!("https://images-api.nasa.gov/asset/{}", nasa.item_id);
            nasa.date_claims =
                crate::archive_provider_contract::nasa_date_claim("2021-01-30T00:00:00Z");
            archive_provider_catalog::upsert(c, &nasa, 12)?;
            Ok(())
        })
        .unwrap();
    let dir = root.path().join(DIRECTORY);
    let mut primary = connect(&dir.join(DB), false, false).unwrap();
    let tx = primary.transaction().unwrap();
    let (reference, raw): (String, String) = tx
        .query_row(
            "SELECT title_ref,document FROM public_archive_item_v1 WHERE provider='nasa'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let mut future: serde_json::Value = serde_json::from_str(&raw).unwrap();
    future["date_claims"]["schemaVersion"] = serde_json::json!(2);
    tx.execute(
        "UPDATE public_archive_item_v1 SET document=?2 WHERE title_ref=?1",
        params![reference, serde_json::to_string(&future).unwrap()],
    )
    .unwrap();
    tx.execute("UPDATE archive_catalog_meta_v1 SET revision=revision+1", [])
        .unwrap();
    // Simulate a newer valid writer's checksum, not an accidental byte flip.
    // The current decoder must refuse its unsupported semantic version before
    // choosing a perfectly healthy but older mirror.
    let mut current = control(&tx).unwrap();
    current.sequence += 1;
    let domain = walk_domain(&tx, &mut || Ok(()), |_, _| Ok(())).unwrap();
    let digest = complete_digest(&current, &domain).unwrap();
    tx.execute(
        "UPDATE archive_namespace_meta_v1 SET sequence=?1,digest=?2",
        params![current.sequence, digest],
    )
    .unwrap();
    tx.commit().unwrap();
    assert_eq!(
        snapshot(&primary, &mut || Ok(())).unwrap_err(),
        "public-archive-metadata-version-unsupported"
    );
    drop(primary);
    let before = image(root.path());
    let canonical_before = fs::read(&canonical_path).unwrap();
    assert_eq!(
        ArchiveStore::open(root.path(), &binding, &mut || Ok(()))
            .err()
            .unwrap(),
        "public-archive-metadata-version-unsupported"
    );
    assert_eq!(image(root.path()), before);
    assert_eq!(fs::read(&canonical_path).unwrap(), canonical_before);
}

fn quick_stride_fixture() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("stride-fixture.sqlite3");
    let c = connect(&path, true, false).unwrap();
    c.execute_batch("CREATE TABLE padding(id INTEGER PRIMARY KEY,value TEXT);CREATE INDEX padding_value ON padding(value);BEGIN;").unwrap();
    {
        let mut insert = c.prepare("INSERT INTO padding VALUES(?1,?2)").unwrap();
        for n in 0..20_000 {
            insert
                .execute(params![n, format!("fixed-seed-73419-cell-{n:05}")])
                .unwrap();
        }
    }
    c.execute_batch("COMMIT").unwrap();
    drop(c);
    (root, path)
}

#[test]
fn quick_stride_real_callback_counts_and_alternating_measurements() {
    let (_root, path) = quick_stride_fixture();
    let before = fs::read(&path).unwrap();
    let mut samples = Vec::new();
    for stride in [1000, 10000, 10000, 1000, 1000, 10000] {
        let mut checks = 0usize;
        let started = std::time::Instant::now();
        quick_check_owned_at_stride(
            &path,
            &mut || {
                checks += 1;
                Ok(())
            },
            stride,
        )
        .unwrap();
        // One initial authority check plus one per actual SQLite progress callback.
        samples.push((stride, checks - 1, started.elapsed().as_secs_f64() * 1000.0));
    }
    let small = samples.iter().find(|s| s.0 == 1000).unwrap().1;
    let large = samples.iter().find(|s| s.0 == 10000).unwrap().1;
    assert!(
        large > 0,
        "Fixture must execute a real batched progress callback"
    );
    assert!(
        small >= large * 9,
        "Batching must reduce actual handshakes, not omit SQL validation"
    );
    assert!(
        fs::read(&path).unwrap() == before,
        "Read-only checks cannot change fixture bytes"
    );
    println!(
        "ARCHIVE_QUICK_CHECK_MEASURE {}",
        serde_json::json!({"fixtureSeed":73419,"rows":20000,"sqlite":rusqlite::version(),"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"samples":samples})
    );
}

#[test]
fn quick_stride_actual_progress_cancel_and_panic_join_and_release_file() {
    for stride in [1000, 10000] {
        let (_root, path) = quick_stride_fixture();
        let before = fs::read(&path).unwrap();
        let mut checks = 0;
        assert_eq!(
            quick_check_owned_at_stride(
                &path,
                &mut || {
                    checks += 1;
                    if checks == 2 {
                        Err("canceled".into())
                    } else {
                        Ok(())
                    }
                },
                stride
            )
            .unwrap_err(),
            "canceled"
        );
        assert_eq!(checks, 2);
        let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut calls = 0;
            quick_check_owned_at_stride(
                &path,
                &mut || {
                    calls += 1;
                    if calls == 2 {
                        panic!("fixed fixture guard unwind");
                    }
                    Ok(())
                },
                stride,
            )
            .unwrap();
        }));
        assert!(unwind.is_err());
        assert!(
            fs::read(&path).unwrap() == before,
            "Canceled and unwound verifiers preserve bytes"
        );
        // Moving/opening after return proves the original read worker was joined,
        // rather than a timeout dropping its observer while it holds the file.
        let moved = path.with_extension("joined.sqlite3");
        fs::rename(&path, &moved).unwrap();
        let c = connect(&moved, false, false).unwrap();
        c.execute_batch("BEGIN EXCLUSIVE;ROLLBACK;").unwrap();
        drop(c);
        quick_check_owned_at_stride(&moved, &mut || Ok(()), stride).unwrap();
        assert_eq!(
            quick_check_owned_at_stride(&moved, &mut || Err("pre-canceled".into()), stride)
                .unwrap_err(),
            "pre-canceled"
        );
    }
}

fn validated_at_stride(path: &Path, stride: i32) -> Result<Snapshot, String> {
    let c = connect(path, false, true)?;
    let tx = sql(c.unchecked_transaction())?;
    let value = validate_at_stride(&tx, true, &mut || Ok(()), stride)?;
    sql(tx.commit())?;
    Ok(value)
}

#[test]
fn quick_stride_complete_namespace_snapshot_and_refusals_are_equivalent() {
    let (root, _, _, _) = active();
    let source = root.path().join(DIRECTORY).join(DB);
    let expected = validated_at_stride(&source, 1000).unwrap();
    assert_eq!(validated_at_stride(&source, 10000).unwrap(), expected);
    let before = image(root.path());
    for fault in ["digest", "fk", "schema", "binding", "header"] {
        let path = root.path().join(format!("stride-{fault}.sqlite3"));
        fs::copy(&source, &path).unwrap();
        if fault == "header" {
            fs::write(&path, b"corrupt sqlite header").unwrap();
        } else {
            let c = connect(&path, false, false).unwrap();
            c.execute_batch(match fault {
                "digest" => "UPDATE archive_title_v1 SET title='Mutated without authority';",
                "fk" => {
                    "PRAGMA foreign_keys=OFF;UPDATE archive_file_v1 SET title_ref='missing-parent';"
                }
                "schema" => "PRAGMA user_version=2;",
                "binding" => "UPDATE archive_namespace_meta_v1 SET binding='{}';",
                _ => unreachable!(),
            })
            .unwrap();
        }
        let bytes = fs::read(&path).unwrap();
        let a = validated_at_stride(&path, 1000).unwrap_err();
        let b = validated_at_stride(&path, 10000).unwrap_err();
        assert_eq!(
            a, b,
            "Both full validators must refuse the same {fault} fault"
        );
        assert!(
            fs::read(&path).unwrap() == bytes,
            "Refusal cannot repair/mutate an unowned fixture"
        );
    }
    assert!(
        image(root.path()) == before,
        "Validation fixtures cannot alter the original active namespace"
    );
}
