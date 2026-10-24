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

//! Real SQLite fixtures; no installation profile, decoder, network, or device.
use super::*;
use std::cell::Cell;

fn fixture() -> (tempfile::TempDir, PairStore) {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    store.write_pair(
        r#"{"schemaVersion":1,"sources":[],"channels":[]}"#,
        r#"{"schemaVersion":1,"sources":[],"favorites":["kept-favorite"],"removedChannels":["kept-removal"],"volume":0.5,"muted":false,"panelWidth":300}"#,
    ).unwrap();
    let mut c = connect(&root.path().join(DB), false).unwrap();
    let tx = c.transaction().unwrap();
    tx.execute_batch("CREATE TABLE maintenance_payload(id INTEGER PRIMARY KEY,payload BLOB NOT NULL);CREATE TABLE maintenance_text_pk(id TEXT PRIMARY KEY,payload TEXT);INSERT INTO maintenance_text_pk VALUES(NULL,'first'),(NULL,'second'),('kept','exact');CREATE VIRTUAL TABLE maintenance_fts USING fts5(text,content='',contentless_delete=1);INSERT INTO maintenance_fts(rowid,text) VALUES(37,'galaxy spacecraft'),(91,'scheduled news');CREATE TABLE maintenance_parent(id INTEGER PRIMARY KEY);CREATE TABLE maintenance_child(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES maintenance_parent);INSERT INTO maintenance_parent VALUES(1);INSERT INTO maintenance_child VALUES(1,1);").unwrap();
    {
        let mut insert = tx
            .prepare("INSERT INTO maintenance_payload VALUES(?1,zeroblob(8192))")
            .unwrap();
        for index in 0..1024 {
            insert.execute([index]).unwrap();
        }
    }
    tx.commit().unwrap();
    drop(c);
    (root, store)
}
fn cancel() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}
fn preflight(c: &Connection) -> Result<Option<usize>, String> {
    let remaining: i64 = sql(c.query_row(
        "SELECT count(*) FROM maintenance_payload WHERE id>=32",
        [],
        |r| r.get(0),
    ))?;
    Ok((remaining == 0).then_some(0))
}
fn prune(
    c: &mut Connection,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<usize, String> {
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let removed = sql(tx.execute("DELETE FROM maintenance_payload WHERE id>=32", []))?;
    check()?;
    sql(tx.commit())?;
    Ok(removed)
}
fn count(c: &Connection) -> i64 {
    c.query_row("SELECT count(*) FROM maintenance_payload", [], |r| r.get(0))
        .unwrap()
}
fn matches(c: &Connection) -> Vec<i64> {
    c.prepare(
        "SELECT rowid FROM maintenance_fts WHERE maintenance_fts MATCH 'spacecraft' ORDER BY rowid",
    )
    .unwrap()
    .query_map([], |r| r.get(0))
    .unwrap()
    .collect::<rusqlite::Result<Vec<_>>>()
    .unwrap()
}
fn images(root: &Path) -> (Vec<u8>, Vec<u8>) {
    (
        std::fs::read(root.join(DB)).unwrap(),
        std::fs::read(root.join(BACKUP)).unwrap(),
    )
}

#[test]
fn real_vacuum_shrinks_file_with_one_preimage_and_preserves_post_prune_rows_and_fts() {
    let (root, store) = fixture();
    let original = std::fs::metadata(root.path().join(DB)).unwrap().len();
    let backups = Cell::new(0);
    let expected = Cell::new(None);
    let receipt = store
        .guide_maintenance_observed(
            &mut preflight,
            prune,
            cancel(),
            &mut || Ok(()),
            &mut |stage, c| {
                if stage == Stage::BackupComplete {
                    backups.set(backups.get() + 1);
                }
                if stage == Stage::RetentionCommitted {
                    expected.set(Some(logical(c, &mut || Ok(()))?));
                    assert_eq!(count(c), 32);
                    assert_eq!(matches(c), vec![37]);
                }
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(receipt.value, 992);
    assert_eq!(backups.get(), 1);
    assert!(receipt.fatal_verification.is_none());
    let Compaction::Compacted { before, after } = receipt.compaction else {
        panic!("expected physical compaction");
    };
    assert!(before.free_pages > 0);
    assert_eq!(before.file_bytes, original);
    assert!(after.file_bytes < before.file_bytes / 2);
    assert!(after.pages < before.pages);
    assert_eq!(after.free_pages, 0);
    assert_eq!(after.file_bytes, after.pages * after.page_size);
    let c = connect(&root.path().join(DB), true).unwrap();
    assert_eq!(
        logical(&c, &mut || Ok(())).unwrap(),
        expected.get().unwrap()
    );
    assert_eq!(count(&c), 32);
    assert_eq!(matches(&c), vec![37]);
    integrity(&c).unwrap();
    let preimage = connect(&root.path().join(BACKUP), true).unwrap();
    assert_eq!(count(&preimage), 1024);
    assert_eq!(matches(&preimage), vec![37]);
    assert_eq!(
        std::fs::metadata(root.path().join(BACKUP)).unwrap().len(),
        original
    );
}

#[test]
fn already_pruned_and_compacted_noop_does_not_replace_backup_or_call_mutator() {
    let (root, store) = fixture();
    store
        .with_guide_maintenance_preflight_checked(preflight, prune, cancel(), || Ok(()))
        .unwrap();
    let before = images(root.path());
    let receipt = store
        .with_guide_maintenance_preflight_checked(
            preflight,
            |_, _| panic!("no-op must not write"),
            cancel(),
            || Ok(()),
        )
        .unwrap();
    assert_eq!(receipt.value, 0);
    assert!(matches!(receipt.compaction, Compaction::Skipped { .. }));
    assert_eq!(images(root.path()), before);
}

#[test]
fn existing_freepages_can_compact_without_repeating_retention_and_backup_current_once() {
    let (root, store) = fixture();
    let mut c = connect(&root.path().join(DB), false).unwrap();
    assert_eq!(prune(&mut c, &mut || Ok(())).unwrap(), 992);
    drop(c);
    let backups = Cell::new(0);
    let receipt = store
        .guide_maintenance_observed(
            &mut preflight,
            |_, _| panic!("already pruned"),
            cancel(),
            &mut || Ok(()),
            &mut |stage, _| {
                if stage == Stage::BackupComplete {
                    backups.set(backups.get() + 1);
                }
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(backups.get(), 1);
    assert_eq!(receipt.value, 0);
    assert!(matches!(receipt.compaction, Compaction::Compacted { .. }));
    assert_eq!(
        count(&connect(&root.path().join(BACKUP), true).unwrap()),
        32
    );
}

#[test]
fn held_reader_defers_exclusive_admission_without_preimage_or_retention_mutation() {
    let (root, store) = fixture();
    let reader = connect(&root.path().join(DB), true).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    assert_eq!(count(&reader), 1024);
    let before = images(root.path());
    let result =
        store.with_guide_maintenance_preflight_checked(preflight, prune, cancel(), || Ok(()));
    assert_eq!(result.unwrap_err(), "sqlite-maintenance-busy");
    assert_eq!(count(&reader), 1024);
    assert_eq!(images(root.path()), before);
    reader.execute_batch("COMMIT").unwrap();
    drop(reader);
    assert!(matches!(
        store
            .with_guide_maintenance_preflight_checked(preflight, prune, cancel(), || Ok(()))
            .unwrap()
            .compaction,
        Compaction::Compacted { .. }
    ));
}

#[test]
fn exclusive_owner_blocks_external_reader_and_writer_across_retention_commit() {
    let (root, store) = fixture();
    let receipt = store
        .guide_maintenance_observed(
            &mut preflight,
            prune,
            cancel(),
            &mut || Ok(()),
            &mut |stage, _| {
                if stage == Stage::RetentionCommitted {
                    let other = Connection::open(root.path().join(DB)).unwrap();
                    other.busy_timeout(Duration::from_millis(1)).unwrap();
                    assert_eq!(
                        other
                            .query_row("SELECT count(*) FROM maintenance_payload", [], |r| r
                                .get::<_, i64>(0))
                            .unwrap_err()
                            .sqlite_error_code(),
                        Some(rusqlite::ErrorCode::DatabaseBusy)
                    );
                    assert_eq!(
                        other
                            .execute("UPDATE maintenance_parent SET id=2", [])
                            .unwrap_err()
                            .sqlite_error_code(),
                        Some(rusqlite::ErrorCode::DatabaseBusy)
                    );
                }
                Ok(())
            },
        )
        .unwrap();
    assert!(matches!(receipt.compaction, Compaction::Compacted { .. }));
}

#[test]
fn canceled_admission_preserves_exact_database_and_backup() {
    let (root, store) = fixture();
    let before = images(root.path());
    let flag = cancel();
    flag.store(true, Ordering::Release);
    assert_eq!(
        store
            .with_guide_maintenance_preflight_checked(preflight, prune, flag, || Ok(()))
            .unwrap_err(),
        "sqlite-maintenance-cancelled"
    );
    assert_eq!(images(root.path()), before);
}

#[test]
fn canceled_after_retention_commit_keeps_receipt_and_does_not_restore_pruned_data() {
    let (root, store) = fixture();
    let flag = cancel();
    let receipt = store
        .guide_maintenance_observed(
            &mut preflight,
            prune,
            flag.clone(),
            &mut || Ok(()),
            &mut |stage, _| {
                if stage == Stage::RetentionCommitted {
                    flag.store(true, Ordering::Release);
                }
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(receipt.value, 992);
    assert!(receipt.fatal_verification.is_none());
    assert!(
        matches!(receipt.compaction, Compaction::Deferred { reason, .. } if reason=="sqlite-maintenance-cancelled")
    );
    let c = connect(&root.path().join(DB), true).unwrap();
    assert_eq!(count(&c), 32);
    integrity(&c).unwrap();
    assert_eq!(
        count(&connect(&root.path().join(BACKUP), true).unwrap()),
        1024
    );
}

#[test]
fn actual_sqlite_vacuum_interrupt_rolls_back_and_clears_hook_without_erasing_prune() {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            TEST_CANCEL_AFTER.with(|v| v.set(None));
        }
    }
    let _reset = Reset;
    let (root, store) = fixture();
    {
        let c = connect(&root.path().join(DB), false).unwrap();
        // The 32 retained payload rows alone can VACUUM without any nested VM
        // reaching the production 1000-op progress quantum. Retain enough real
        // rows that copying this table must execute that handler during VACUUM.
        c.execute_batch("WITH RECURSIVE n(x) AS(VALUES(2) UNION ALL SELECT x+1 FROM n WHERE x<20001) INSERT INTO maintenance_parent SELECT x FROM n;").unwrap();
    }
    let flag = cancel();
    let expected = Cell::new(None);
    let receipt = store
        .guide_maintenance_observed(
            &mut preflight,
            prune,
            flag.clone(),
            &mut || Ok(()),
            &mut |stage, c| {
                if stage == Stage::BeforeVacuum {
                    expected.set(Some(logical(c, &mut || Ok(()))?));
                    TEST_CANCEL_AFTER.with(|v| v.set(Some(1)));
                }
                Ok(())
            },
        )
        .unwrap();
    assert!(flag.load(Ordering::Acquire));
    assert_eq!(receipt.value, 992);
    assert!(receipt.fatal_verification.is_none());
    assert!(
        matches!(receipt.compaction, Compaction::Failed { reason, .. } if reason=="sqlite-maintenance-cancelled")
    );
    let c = connect(&root.path().join(DB), true).unwrap();
    assert_eq!(count(&c), 32);
    assert_eq!(
        c.query_row("SELECT count(*) FROM maintenance_parent", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        20001
    );
    assert_eq!(
        logical(&c, &mut || Ok(())).unwrap(),
        expected.get().unwrap()
    );
    integrity(&c).unwrap();
    // The same module's verification already used the original connection with
    // cancellation still true; a leaked progress hook would have interrupted it.
    assert_eq!(
        count(&connect(&root.path().join(BACKUP), true).unwrap()),
        1024
    );
}

#[test]
fn late_cancel_after_actual_vacuum_success_cannot_erase_verified_durable_success() {
    let (root, store) = fixture();
    let flag = cancel();
    let receipt = store
        .guide_maintenance_observed(
            &mut preflight,
            prune,
            flag.clone(),
            &mut || Ok(()),
            &mut |stage, _| {
                if stage == Stage::VacuumReturned {
                    flag.store(true, Ordering::Release);
                }
                Ok(())
            },
        )
        .unwrap();
    assert!(flag.load(Ordering::Acquire));
    assert_eq!(receipt.value, 992);
    assert!(matches!(receipt.compaction, Compaction::Compacted { .. }));
    assert!(receipt.fatal_verification.is_none());
    assert_eq!(count(&connect(&root.path().join(DB), true).unwrap()), 32);
}

#[test]
fn postverification_logical_damage_returns_fatal_receipt_and_preserves_preimage_for_quarantine() {
    let (root, store) = fixture();
    let receipt = store
        .guide_maintenance_observed(
            &mut preflight,
            prune,
            cancel(),
            &mut || Ok(()),
            &mut |stage, c| {
                if stage == Stage::BeforeVerify {
                    c.execute(
                        "UPDATE maintenance_text_pk SET payload='changed' WHERE id='kept'",
                        [],
                    )
                    .unwrap();
                }
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(receipt.value, 992);
    assert_eq!(
        receipt.fatal_verification.as_deref(),
        Some("sqlite-maintenance-verification-failed")
    );
    assert!(matches!(receipt.compaction, Compaction::Failed { .. }));
    assert_eq!(count(&connect(&root.path().join(DB), true).unwrap()), 32);
    assert_eq!(
        count(&connect(&root.path().join(BACKUP), true).unwrap()),
        1024
    );
}

#[test]
fn postcommit_storage_full_outcome_keeps_receipt_and_diskfull_error_is_redacted_and_typed() {
    let (root, store) = fixture();
    let receipt = store
        .guide_maintenance_observed(
            &mut preflight,
            prune,
            cancel(),
            &mut || Ok(()),
            &mut |stage, _| {
                if stage == Stage::BeforeVacuum {
                    return Err("sqlite-storage-full".into());
                }
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(receipt.value, 992);
    assert!(receipt.fatal_verification.is_none());
    assert!(
        matches!(receipt.compaction, Compaction::Deferred { reason, .. } if reason=="sqlite-storage-full")
    );
    assert_eq!(count(&connect(&root.path().join(DB), true).unwrap()), 32);
    let error = rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL),
        Some("private path must never escape".into()),
    );
    assert_eq!(
        vacuum_error(&error, &AtomicBool::new(false), &AtomicBool::new(false)),
        "sqlite-storage-full"
    );
    // This is boundary fault injection + SQLite error mapping, not a claim of a
    // real full filesystem/VFS or power-loss experiment. Those remain open.
}

#[test]
fn implicit_rowids_are_excluded_but_fts_document_ids_are_part_of_logical_proof() {
    let (root, _) = fixture();
    let c = connect(&root.path().join(DB), false).unwrap();
    let before = logical(&c, &mut || Ok(())).unwrap();
    c.execute("UPDATE maintenance_text_pk SET rowid=rowid+1000", [])
        .unwrap();
    assert_eq!(logical(&c, &mut || Ok(())).unwrap(), before);
    c.execute("DELETE FROM maintenance_fts WHERE rowid=37", [])
        .unwrap();
    c.execute(
        "INSERT INTO maintenance_fts(rowid,text) VALUES(38,'galaxy spacecraft')",
        [],
    )
    .unwrap();
    assert_ne!(logical(&c, &mut || Ok(())).unwrap(), before);
    assert_eq!(matches(&c), vec![38]);
}

#[test]
fn schema18_compaction_preserves_exact_main_binding_and_independent_archive_authority_files() {
    let (root, store) = fixture();
    let lease = crate::archive_library_store::lock_root(root.path()).unwrap();
    let archive = store
        .open_archive_library_locked(&lease, &mut || Ok(()))
        .unwrap();
    drop(archive);
    drop(lease);
    let c = connect(&root.path().join(DB), true).unwrap();
    assert_eq!(number(&c, "user_version").unwrap(), 19);
    let binding = archive_binding(&c).unwrap();
    drop(c);
    let authority_files = [
        "archive-authority-v1",
        "archive-library-v1/archive.sqlite3",
        "archive-library-v1/archive.sqlite3.backup",
    ];
    let before = authority_files.map(|name| std::fs::read(root.path().join(name)).unwrap());
    let receipt = store
        .with_guide_maintenance_preflight_checked(preflight, prune, cancel(), || Ok(()))
        .unwrap();
    assert!(receipt.fatal_verification.is_none());
    assert!(matches!(receipt.compaction, Compaction::Compacted { .. }));
    let c = connect(&root.path().join(DB), true).unwrap();
    assert_eq!(archive_binding(&c).unwrap(), binding);
    assert_eq!(number(&c, "user_version").unwrap(), 19);
    assert_eq!(
        authority_files.map(|name| std::fs::read(root.path().join(name)).unwrap()),
        before
    );
}
