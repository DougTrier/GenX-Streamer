//! Real writer contention and durable backups, using synthetic namespaces only.
use super::*;
use rusqlite::{types::Value, Connection};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};

const PREFERENCES: &str = r#"{"schemaVersion":1,"sources":[],"favorites":["missing-favorite"],"removedChannels":["missing-removal"],"volume":0.5,"muted":false,"panelWidth":300.0}"#;

fn fixture() -> (tempfile::TempDir, Arc<Store>) {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::new(root.path().into(), "test".into()).unwrap());
    store.write("preferences", PREFERENCES).unwrap();
    store.with_guide_write(|c| {
        crate::scan_checkpoint::ensure(c)?;
        crate::scan_candidate_manifest::ensure(c)?;
        c.execute_batch("CREATE TABLE writer_fixture(id INTEGER PRIMARY KEY,payload BLOB);INSERT INTO writer_fixture VALUES(1,zeroblob(1048576));INSERT INTO guide_source(id,name,location,kind,allow_http,revision,published_revision,updated_ms) VALUES('fixture-guide','Fixture','https://example.invalid/guide','url',0,1,1,10);INSERT INTO guide_channel VALUES('fixture-guide','fixture-channel','[]','fixture');INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,description,search_text) VALUES('fixture-guide',0,'fixture-channel',10,20,'Fixture',NULL,'fixture');INSERT INTO scan_manifest VALUES('fixture','fixture-job','fixture-digest',1,0,1,'{}','{}',1,1,10,64);INSERT INTO scan_manifest_candidate VALUES('fixture',0,'fixture-metadata');INSERT INTO scan_manifest_page VALUES('fixture',0,1,'fixture-binding','fixture-hash',x'0102030405060708');INSERT INTO scan_manifest_category VALUES('fixture',0,'News');")
            .map_err(|_| "fixture-sql".to_string())?;
        Ok(())
    }).unwrap();
    // Establish a verified baseline containing every fixture namespace.
    store
        .with_guide_write_checked(|_| Ok(()), || Ok(()))
        .unwrap();
    (root, store)
}

fn files(root: &Path) -> (Vec<u8>, Vec<u8>) {
    (
        fs::read(root.join("genx.sqlite3")).unwrap(),
        fs::read(root.join("genx.sqlite3.backup")).unwrap(),
    )
}

fn dump(c: &Connection) -> Vec<(String, Vec<Vec<Value>>)> {
    let mut names = c
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .unwrap();
    let names = names
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    names
        .into_iter()
        .map(|name| {
            let mut query = c
                .prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")))
                .unwrap();
            let columns = query.column_count();
            let rows = query
                .query_map([], |r| {
                    (0..columns)
                        .map(|i| r.get(i))
                        .collect::<rusqlite::Result<Vec<Value>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            (name, rows)
        })
        .collect()
}

#[test]
fn checked_writer_cancellation_finishes_before_held_writer_release() {
    for guide in [false, true] {
        let (root, store) = fixture();
        let before = files(root.path());
        let held = store.write_lease().unwrap();
        let canceled = Arc::new(AtomicBool::new(false));
        let worker_cancel = canceled.clone();
        let worker_store = store.clone();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut entered = false;
            let check = || {
                if !entered {
                    entered = true;
                    entered_tx.send(()).unwrap();
                }
                if worker_cancel.load(Ordering::SeqCst) {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            };
            let result = if guide {
                worker_store
                    .with_guide_write_checked(|_| panic!("canceled writer must not run"), check)
            } else {
                worker_store
                    .write_record_guarded("preferences", PREFERENCES, None, check)
                    .map(|_| ())
            };
            finished_tx.send(result).unwrap();
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        canceled.store(true, Ordering::SeqCst);
        // Receive before releasing the held mutex: this proves actual worker
        // completion rather than a detached observer timing out.
        let result = finished_rx.recv_timeout(std::time::Duration::from_secs(2));
        drop(held);
        worker.join().unwrap();
        assert_eq!(result.unwrap().unwrap_err(), "canceled");
        assert_eq!(files(root.path()), before);
    }
}

#[test]
fn checked_writer_cancellation_after_acquisition_releases_without_mutating() {
    let (root, store) = fixture();
    let before = files(root.path());
    let mut checks = 0;
    let error = store
        .write_record_guarded("preferences", PREFERENCES, None, || {
            checks += 1;
            if checks == 2 {
                assert!(matches!(
                    store.writer.try_lock(),
                    Err(std::sync::TryLockError::WouldBlock)
                ));
                return Err("canceled".into());
            }
            Ok(())
        })
        .unwrap_err();
    assert_eq!(error, "canceled");
    assert_eq!(checks, 2);
    assert_eq!(files(root.path()), before);
    assert!(store.writer.try_lock().is_ok());
}

#[test]
fn checked_guide_backup_cancellation_preserves_original_backup_and_all_namespaces() {
    let (root, store) = fixture();
    let before = files(root.path());
    let pages: i64 = store
        .with_guide_read(|c| {
            c.query_row("PRAGMA page_count", [], |r| r.get(0))
                .map_err(|_| "fixture-sql".into())
        })
        .unwrap();
    assert!(pages > 64);
    let mut checks = 0;
    let error = store
        .with_guide_write_checked(
            |_| -> Result<(), String> { panic!("canceled backup must not invoke mutation") },
            || {
                checks += 1;
                // Writer admission twice, PairStore admission, backup admission,
                // pinned snapshot, first BeforeStep, then real StepCompleted.
                if checks == 7 {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
    assert_eq!(error, "canceled");
    assert_eq!(checks, 7);
    assert_eq!(files(root.path()), before);
}

#[test]
fn checked_guide_write_keeps_verified_complete_preimage_and_late_commit_receipt() {
    let (root, store) = fixture();
    let before = store.with_guide_read(|c| Ok(dump(c))).unwrap();
    let canceled = AtomicBool::new(false);
    let receipt = store
        .with_guide_write_checked(
            |c| {
                let tx = c.transaction().map_err(|_| "fixture-sql")?;
                tx.execute("UPDATE preference SET muted=1 WHERE singleton=1", [])
                    .map_err(|_| "fixture-sql")?;
                tx.commit().map_err(|_| "fixture-sql")?;
                canceled.store(true, Ordering::SeqCst);
                Ok("durable-receipt")
            },
            || {
                if canceled.load(Ordering::SeqCst) {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap();
    assert_eq!(receipt, "durable-receipt");
    let backup = Connection::open_with_flags(
        root.path().join("genx.sqlite3.backup"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        backup
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
    assert_eq!(dump(&backup), before);
    assert_ne!(store.with_guide_read(|c| Ok(dump(c))).unwrap(), before);
    assert!(store.writer.try_lock().is_ok());
}
