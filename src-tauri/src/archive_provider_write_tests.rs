//! Real final-write admission fixtures; no provider requests or user profiles.
use super::*;
use crate::{
    archive_library_store::{observe_backup, BackupPhase},
    storage::Store,
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc,
    },
};
const SCOPE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn directory(root: &Path) -> PathBuf {
    root.join("archive-library-v1")
}
fn fixture() -> (tempfile::TempDir, Arc<Store>) {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::new(root.path().into(), "test".into()).unwrap());
    // The large unrelated main table intentionally stays outside the namespace.
    store.with_guide_write(|c|{c.execute_batch("CREATE TABLE archive_writer_fixture(id INTEGER PRIMARY KEY,payload BLOB);INSERT INTO archive_writer_fixture VALUES(1,zeroblob(1048576));").map_err(|_|"fixture")?;Ok(())}).unwrap();
    store
        .with_archive_fixture_write(|c| {
            c.execute(
                "UPDATE archive_catalog_meta_v1 SET revision=7 WHERE singleton=1",
                [],
            )
            .map_err(|_| "fixture")?;
            Ok(())
        })
        .unwrap();
    (root, store)
}
fn files(root: &Path) -> (Vec<u8>, Vec<u8>) {
    let d = directory(root);
    (
        fs::read(d.join("archive.sqlite3")).unwrap(),
        fs::read(d.join("archive.sqlite3.backup")).unwrap(),
    )
}
fn acquired(cursor: catalog::Cursor) -> Acquired {
    Acquired {
        provider: Provider::Loc,
        cursor,
        items: vec![],
        outcome: ProviderOutcome {
            provider_id: "loc".into(),
            state: "complete".into(),
            examined: 0,
            admitted: 0,
            retry_after_ms: None,
            reason: None,
        },
    }
}
fn complete() -> catalog::Cursor {
    catalog::Cursor {
        started: true,
        complete: true,
        ..Default::default()
    }
}
fn revision(store: &Store) -> i64 {
    store.with_archive_read(legacy::current).unwrap()
}
fn item() -> ProviderItem {
    ProviderItem {
        provider: Provider::Loc,
        item_id: "fixture".into(),
        title: "Fixture film".into(),
        source_url: "https://www.loc.gov/item/fixture/".into(),
        metadata_url: "https://www.loc.gov/item/fixture/?fo=json".into(),
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
    }
}
fn stop_backup() -> crate::archive_library_store::BackupObserver {
    observe_backup(|phase| {
        if phase == BackupPhase::BeforeCopy {
            Err("fixture-backup-required".into())
        } else {
            Ok(())
        }
    })
}
#[test]
fn public_writer_unchanged_cursor_skips_backup_and_keeps_all_bytes() {
    let (root, store) = fixture();
    store
        .with_archive_fixture_write(|c| catalog::save_cursor(c, SCOPE, Provider::Loc, &complete()))
        .unwrap();
    let before = files(root.path());
    let _observe = stop_backup();
    let receipt =
        commit_acquired(&store, "7", SCOPE, &[acquired(complete())], &mut || Ok(())).unwrap();
    assert!(receipt.committed);
    assert_eq!(receipt.revision, "7");
    assert_eq!(receipt.admitted, 0);
    assert_eq!(files(root.path()), before);
}
#[test]
fn public_writer_stale_revision_refuses_before_backup_or_noop() {
    let (root, store) = fixture();
    let before = files(root.path());
    let _observe = stop_backup();
    let error = commit_acquired(
        &store,
        "6",
        SCOPE,
        &[acquired(Default::default())],
        &mut || Ok(()),
    )
    .err()
    .unwrap();
    assert_eq!(error, "archive-revision-stale");
    assert_eq!(files(root.path()), before);
}
#[test]
fn public_writer_changed_cursor_backs_up_then_commits_real_progress() {
    let (root, store) = fixture();
    let before = files(root.path());
    {
        let _observe = stop_backup();
        assert_eq!(
            commit_acquired(&store, "7", SCOPE, &[acquired(complete())], &mut || Ok(()))
                .err()
                .unwrap(),
            "fixture-backup-required"
        );
    }
    assert_eq!(files(root.path()), before);
    let copies = Arc::new(AtomicUsize::new(0));
    let seen = copies.clone();
    let _observe = observe_backup(move |phase| {
        if phase == BackupPhase::BeforeCopy {
            seen.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    });
    let receipt =
        commit_acquired(&store, "7", SCOPE, &[acquired(complete())], &mut || Ok(())).unwrap();
    assert_eq!(receipt.revision, "8");
    assert_eq!(revision(&store), 8);
    assert_eq!(copies.load(Ordering::SeqCst), 2);
    assert!(
        store
            .with_archive_read(|c| catalog::cursor(c, SCOPE, Provider::Loc, false))
            .unwrap()
            .complete
    );
    // Latest mirror must represent the acknowledged state, not the preimage.
    let backup =
        rusqlite::Connection::open(directory(root.path()).join("archive.sqlite3.backup")).unwrap();
    assert_eq!(legacy::current(&backup).unwrap(), 8);
    assert!(
        catalog::cursor(&backup, SCOPE, Provider::Loc, false)
            .unwrap()
            .complete
    );
}
#[test]
fn public_writer_retry_timestamp_change_is_not_noop() {
    let (root, store) = fixture();
    let before = files(root.path());
    let mut next = catalog::Cursor::default();
    next.retry_after_ms = Some(12345);
    let _observe = stop_backup();
    assert_eq!(
        commit_acquired(&store, "7", SCOPE, &[acquired(next)], &mut || Ok(()))
            .err()
            .unwrap(),
        "fixture-backup-required"
    );
    assert_eq!(revision(&store), 7);
    assert_eq!(files(root.path()), before);
}
#[test]
fn public_writer_metadata_observation_is_not_noop_even_when_identical() {
    let (root, store) = fixture();
    let observed = item();
    store
        .with_archive_fixture_write(|c| catalog::upsert(c, &observed, 1).map(|_| ()))
        .unwrap();
    let before = files(root.path());
    let mut result = acquired(Default::default());
    result.items.push(observed);
    let _observe = stop_backup();
    assert_eq!(
        commit_acquired(&store, "7", SCOPE, &[result], &mut || Ok(()))
            .err()
            .unwrap(),
        "fixture-backup-required"
    );
    assert_eq!(revision(&store), 7);
    assert_eq!(files(root.path()), before);
}
#[test]
fn public_writer_cancel_wait_joins_before_held_writer_release() {
    let (root, store) = fixture();
    let before = files(root.path());
    let held = store.archive_write_lease().unwrap();
    let canceled = Arc::new(AtomicBool::new(false));
    let worker_store = store.clone();
    let worker_cancel = canceled.clone();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut first = Some(entered_tx);
        let result = commit_acquired(
            &worker_store,
            "7",
            SCOPE,
            &[acquired(complete())],
            &mut || {
                if let Some(sender) = first.take() {
                    sender.send(()).unwrap();
                }
                if worker_cancel.load(Ordering::SeqCst) {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
        );
        done_tx.send(result.map(|_| ())).unwrap();
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    canceled.store(true, Ordering::SeqCst);
    let result = done_rx.recv_timeout(Duration::from_secs(2));
    drop(held);
    worker.join().unwrap();
    assert_eq!(result.unwrap().unwrap_err(), "canceled");
    assert_eq!(files(root.path()), before);
}
#[test]
fn public_writer_cancel_real_backup_preserves_catalog_cursor_and_backup() {
    let (root, store) = fixture();
    let before = files(root.path());
    let canceled = Arc::new(AtomicBool::new(false));
    let mark = canceled.clone();
    let copied = Arc::new(AtomicBool::new(false));
    let observed = copied.clone();
    let _observe = observe_backup(move |phase| {
        if phase == BackupPhase::AfterCopy {
            observed.store(true, Ordering::SeqCst);
            mark.store(true, Ordering::SeqCst);
        }
        Ok(())
    });
    let error = commit_acquired(&store, "7", SCOPE, &[acquired(complete())], &mut || {
        if canceled.load(Ordering::SeqCst) {
            Err("canceled".into())
        } else {
            Ok(())
        }
    })
    .err()
    .unwrap();
    assert_eq!(error, "canceled");
    assert!(copied.load(Ordering::SeqCst));
    assert_eq!(files(root.path()), before);
    assert_eq!(revision(&store), 7);
    assert!(
        !store
            .with_archive_read(|c| catalog::cursor(c, SCOPE, Provider::Loc, false))
            .unwrap()
            .started
    );
}
#[test]
fn archive_writer_keeps_actual_commit_receipt_after_abort() {
    let (root, store) = fixture();
    let canceled = Arc::new(AtomicBool::new(false));
    let commit_cancel = canceled.clone();
    let receipt = store
        .with_archive_write_checked(
            "7",
            |_| Ok(None),
            |c, check| {
                c.commit_hook(Some(move || {
                    commit_cancel.store(true, Ordering::SeqCst);
                    false
                }))
                .map_err(|_| "fixture-hook")?;
                legacy::remove(c, &legacy::RemovalScope::All, None, "7", check)
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
    assert!(canceled.load(Ordering::SeqCst));
    assert!(receipt.committed);
    assert_eq!(receipt.revision, "8");
    assert_eq!(revision(&store), 8);
    let backup =
        rusqlite::Connection::open(directory(root.path()).join("archive.sqlite3.backup")).unwrap();
    assert_eq!(legacy::current(&backup).unwrap(), 8);
}
