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

//! Independent durable databases keep independent writer admission, not independent root authority.
use super::*;
use crate::{
    archive_bookmarks as bookmarks, archive_catalog as catalog, storage_transaction as pair,
};
use std::sync::{mpsc, Arc};
use std::time::Duration;

// Observation guards prove ordering; these are not playback latency budgets.
const WAIT: Duration = Duration::from_secs(10);
const PREFS: &str = r#"{"schemaVersion":1,"sources":[],"favorites":[],"removedChannels":[],"volume":0.5,"muted":false,"panelWidth":300.0}"#;

fn logical_image(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let c = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap();
    assert_eq!(
        c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
    let mut hash = Sha256::new();
    let mut schema = c
        .prepare("SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_schema ORDER BY type,name")
        .unwrap();
    let objects = schema
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    // Complete typed row multisets, including namespace control/digest/revisions,
    // rather than physical pager-header bytes changed by SQLite online backup.
    hash.update(format!("{objects:?}"));
    for (kind, name, _, _) in objects {
        if kind != "table" {
            continue;
        }
        let mut query = c
            .prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")))
            .unwrap();
        let columns = query.column_count();
        let mut rows = query
            .query_map([], |r| {
                (0..columns)
                    .map(|i| r.get::<_, rusqlite::types::Value>(i))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
            .map(|row| format!("{:?}", row.unwrap()))
            .collect::<Vec<_>>();
        rows.sort();
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        hash.update((columns as u64).to_le_bytes());
        hash.update((rows.len() as u64).to_le_bytes());
        for row in rows {
            hash.update((row.len() as u64).to_le_bytes());
            hash.update(row.as_bytes());
        }
    }
    for pragma in ["user_version", "application_id", "encoding"] {
        let value: rusqlite::types::Value =
            c.pragma_query_value(None, pragma, |r| r.get(0)).unwrap();
        hash.update(format!("{pragma}:{value:?}"));
    }
    format!("{:x}", hash.finalize())
}

fn fixture() -> (tempfile::TempDir, Store, bookmarks::Proof) {
    let root = tempfile::tempdir().unwrap();
    let store = Store::new(root.path().into(), "writer-domains-fixture".into()).unwrap();
    store.write("preferences", PREFS).unwrap();
    let proof = store.with_archive_fixture_write(|c| {
        let title = catalog::opaque(&["archive-item-v1", "item"]);
        let file = catalog::opaque(&["archive-file-v1", "item", "episode.mp4"]);
        c.execute("INSERT INTO archive_title_v1(title_ref,item_id,title,kind,curated,searched,downloads,observed_ms,search_text) VALUES(?1,'item','Fixture','tv',0,1,1,1,'fixture')",[&title]).unwrap();
        c.execute("INSERT INTO archive_file_v1(file_ref,title_ref,item_id,file_name,format,size_bytes,duration_seconds,sha1,servers,observed_ms,eligible) VALUES(?1,?2,'item','episode.mp4','h.264','100',60,?3,'[]',1,1)",rusqlite::params![file,title,"a".repeat(40)]).unwrap();
        bookmarks::capture(&file, &catalog::resolve(c, &file, "0")?)
    }).unwrap();
    (root, store, proof)
}
fn position() -> bookmarks::Position {
    bookmarks::Position {
        position_ms: 12000,
        duration_ms: Some(60000),
        completed: false,
        observed_ms: 1000,
    }
}

/// Hold the real main backup under the same Store gate as production record writes.
type HeldMainBackup = (
    mpsc::Receiver<()>,
    mpsc::Sender<()>,
    std::thread::JoinHandle<Result<(), String>>,
);
fn held_main_backup(store: Arc<Store>) -> HeldMainBackup {
    held_main_backup_result(store, false)
}
fn held_main_backup_result(store: Arc<Store>, refuse: bool) -> HeldMainBackup {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let job = std::thread::spawn(move || {
        let _writer = store.write_lease()?;
        let mut held = false;
        store
            .pair
            .write_records_with_phase(
                &pair::RecordPair {
                    catalog: None,
                    preferences: Some(PREFS.replace("0.5", "0.6")),
                },
                None,
                (None, None),
                None,
                |stage| {
                    if stage == pair::Phase::DuringBackup && !held {
                        held = true;
                        entered_tx.send(()).unwrap();
                        release_rx.recv_timeout(WAIT.saturating_mul(3)).unwrap();
                    }
                    if refuse && stage == pair::Phase::AfterBackup {
                        return Err("fixture-main-refusal".into());
                    }
                    Ok(())
                },
            )
            .map(|_| ())
    });
    (entered_rx, release_tx, job)
}

#[test]
fn local_download_bookmark_commits_while_real_main_backup_is_held() {
    let (root, store, _proof) = fixture();
    let (saved, _) =
        crate::archive_download_store::local_fixture(&root.path().join("archive-downloads-v1"));
    let local = store
        .open_archive_download_checked(&saved.entry.download_ref, &saved.revision, || Ok(()))
        .unwrap();
    let proof = local.proof.clone();
    drop(local);
    let store = Arc::new(store);
    let (entered, release, main) = held_main_backup(store.clone());
    entered.recv_timeout(WAIT).unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let archive_store = store.clone();
    let archive = std::thread::spawn(move || {
        let result =
            archive_store
                .write_archive_download_bookmark_checked(&proof, "0", &position(), || Ok(()));
        done_tx
            .send(result.map(|r| (r.committed, r.changed, r.revision)))
            .unwrap();
    });
    let observed = done_rx.recv_timeout(WAIT);
    release.send(()).unwrap();
    main.join().unwrap().unwrap();
    archive.join().unwrap();
    assert_eq!(
        observed
            .expect("Local bookmark waited for an unrelated main backup")
            .unwrap(),
        (true, true, "1".into())
    );
    let reopened = Store::new(root.path().into(), "download-reopen".into()).unwrap();
    let local = reopened
        .open_archive_download_checked(&saved.entry.download_ref, &saved.revision, || Ok(()))
        .unwrap();
    assert_eq!(
        reopened
            .read_archive_download_bookmark(&local.proof)
            .unwrap()
            .position
            .unwrap()
            .position_ms,
        12000
    );
}

#[test]
fn archive_writer_serialization_retains_selected_revision_cas() {
    let (_root, store, _proof) = fixture();
    let store = Arc::new(store);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let first_store = store.clone();
    let first = std::thread::spawn(move || {
        first_store.with_archive_write_checked(
            "0",
            |_| Ok(None),
            |c, check| {
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(WAIT.saturating_mul(3)).unwrap();
                catalog::set_favorite(
                    c,
                    &catalog::FavoriteRequest {
                        schema_version: 1,
                        request_id: "first-writer".into(),
                        title_ref: catalog::opaque(&["archive-item-v1", "item"]),
                        expected_revision: "0".into(),
                        value: true,
                    },
                    check,
                )
                .map(|_| ())
            },
            || Ok(()),
        )
    });
    entered_rx.recv_timeout(WAIT).unwrap();
    assert!(matches!(
        store.archive_writer.try_lock(),
        Err(std::sync::TryLockError::WouldBlock)
    ));
    let (admitted_tx, admitted_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let second_store = store.clone();
    let second = std::thread::spawn(move || {
        let mut admitted = false;
        let result = second_store.with_archive_write_checked::<()>(
            "0",
            |_| Ok(None),
            |_, _| panic!("Stale writer must not mutate"),
            || {
                if !admitted {
                    admitted = true;
                    admitted_tx.send(()).unwrap();
                }
                Ok(())
            },
        );
        done_tx.send(result).unwrap();
    });
    admitted_rx.recv_timeout(WAIT).unwrap();
    let while_held = done_rx.recv_timeout(Duration::from_millis(50));
    release_tx.send(()).unwrap();
    first.join().unwrap().unwrap();
    second.join().unwrap();
    assert!(matches!(while_held, Err(mpsc::RecvTimeoutError::Timeout)));
    assert_eq!(
        done_rx.recv_timeout(WAIT).unwrap().unwrap_err(),
        "archive-revision-stale"
    );
    assert_eq!(store.with_archive_read(catalog::current).unwrap(), 1);
}

#[test]
fn cancellation_finishes_waiting_worker_in_each_domain_before_held_writer_releases() {
    use std::sync::atomic::{AtomicBool, Ordering};
    for archive in [false, true] {
        let (root, store, proof) = fixture();
        let store = Arc::new(store);
        let main_before = fs::read(root.path().join("genx.sqlite3")).unwrap();
        let archive_before =
            fs::read(root.path().join("archive-library-v1/archive.sqlite3")).unwrap();
        let held = if archive {
            store.archive_write_lease().unwrap()
        } else {
            store.write_lease().unwrap()
        };
        let canceled = Arc::new(AtomicBool::new(false));
        let worker_cancel = canceled.clone();
        let worker_store = store.clone();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let entered = AtomicBool::new(false);
            let check = || {
                if !entered.swap(true, Ordering::SeqCst) {
                    entered_tx.send(()).unwrap();
                }
                if worker_cancel.load(Ordering::SeqCst) {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            };
            let result = if archive {
                worker_store
                    .write_archive_bookmark_checked(&proof, "0", &position(), check)
                    .map(|_| ())
            } else {
                worker_store
                    .write_record_guarded("preferences", PREFS, None, check)
                    .map(|_| ())
            };
            done_tx.send(result).unwrap();
        });
        entered_rx.recv_timeout(WAIT).unwrap();
        canceled.store(true, Ordering::SeqCst);
        let observed = done_rx.recv_timeout(WAIT);
        drop(held);
        worker.join().unwrap();
        assert_eq!(
            observed
                .expect("Canceled SQL worker was not joined")
                .unwrap_err(),
            "canceled"
        );
        assert_eq!(
            fs::read(root.path().join("genx.sqlite3")).unwrap(),
            main_before
        );
        assert_eq!(
            fs::read(root.path().join("archive-library-v1/archive.sqlite3")).unwrap(),
            archive_before
        );
    }
}

#[test]
fn root_replacement_joins_active_main_and_archive_operations_before_advancing_generation() {
    for release_archive_first in [false, true] {
        let (_root, store, _proof) = fixture();
        let owner = Arc::new(crate::storage_leases::StoreOwner::new(Ok(store)));
        let (main_entered_tx, main_entered_rx) = mpsc::channel();
        let (main_release_tx, main_release_rx) = mpsc::channel();
        let main_owner = owner.clone();
        let main = std::thread::spawn(move || {
            let lease = main_owner.read().unwrap();
            lease
                .as_ref()
                .unwrap()
                .with_guide_write_checked(
                    |_| {
                        main_entered_tx.send(()).unwrap();
                        main_release_rx
                            .recv_timeout(WAIT.saturating_mul(3))
                            .unwrap();
                        Ok(())
                    },
                    || Ok(()),
                )
                .unwrap();
        });
        main_entered_rx.recv_timeout(WAIT).unwrap();
        let (archive_entered_tx, archive_entered_rx) = mpsc::channel();
        let (archive_release_tx, archive_release_rx) = mpsc::channel();
        let archive_owner = owner.clone();
        let archive = std::thread::spawn(move || {
            let lease = archive_owner.read().unwrap();
            let error = lease
                .as_ref()
                .unwrap()
                .with_archive_write_checked(
                    "0",
                    |_| Ok(None),
                    |_, _| {
                        archive_entered_tx.send(()).unwrap();
                        archive_release_rx
                            .recv_timeout(WAIT.saturating_mul(3))
                            .unwrap();
                        Err::<(), _>("fixture-archive-refusal".into())
                    },
                    || Ok(()),
                )
                .unwrap_err();
            assert_eq!(error, "fixture-archive-refusal");
        });
        archive_entered_rx.recv_timeout(WAIT).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (replaced_tx, replaced_rx) = mpsc::channel();
        let replacement_owner = owner.clone();
        let replacement = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let mut lease = replacement_owner.exclusive().unwrap();
            *lease = Err("fixture-replaced".into());
            replaced_tx.send(()).unwrap();
        });
        started_rx.recv_timeout(WAIT).unwrap();
        let both_held = replaced_rx.recv_timeout(Duration::from_millis(50));
        let (first_release, second_release, first, second) = if release_archive_first {
            (archive_release_tx, main_release_tx, archive, main)
        } else {
            (main_release_tx, archive_release_tx, main, archive)
        };
        first_release.send(()).unwrap();
        first.join().unwrap();
        let one_still_held = replaced_rx.recv_timeout(Duration::from_millis(50));
        second_release.send(()).unwrap();
        second.join().unwrap();
        replacement.join().unwrap();
        assert!(matches!(both_held, Err(mpsc::RecvTimeoutError::Timeout)));
        assert!(matches!(
            one_still_held,
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        replaced_rx.recv_timeout(WAIT).unwrap();
        let current = owner.read().unwrap();
        assert_eq!(current.generation(), 2);
        assert!(matches!(current.as_ref(),Err(error) if error=="fixture-replaced"));
    }
}

#[test]
fn failed_main_backup_owner_cannot_erase_independently_committed_archive_bookmark() {
    let (_root, store, proof) = fixture();
    let store = Arc::new(store);
    let proof = Arc::new(proof);
    let (entered, release, main) = held_main_backup_result(store.clone(), true);
    entered.recv_timeout(WAIT).unwrap();
    let archive_store = store.clone();
    let archive_proof = proof.clone();
    let (saved_tx, saved_rx) = mpsc::channel();
    let archive = std::thread::spawn(move || {
        saved_tx
            .send(
                archive_store
                    .write_archive_bookmark_checked(&archive_proof, "0", &position(), || Ok(()))
                    .map(|receipt| receipt.committed),
            )
            .unwrap();
    });
    let saved = saved_rx.recv_timeout(WAIT);
    release.send(()).unwrap();
    assert_eq!(main.join().unwrap().unwrap_err(), "fixture-main-refusal");
    archive.join().unwrap();
    assert!(saved
        .expect("Archive work waited for failed main write")
        .unwrap());
    assert_eq!(
        store
            .with_archive_read(|c| Ok(bookmarks::read(c, &proof)?.position.unwrap().position_ms))
            .unwrap(),
        12000
    );
    let prefs: serde_json::Value =
        serde_json::from_str(store.read("preferences").unwrap().as_ref().unwrap()).unwrap();
    assert_eq!(prefs["volume"], 0.5);
}

#[test]
fn main_preference_commit_progresses_during_archive_write_and_survives_archive_refusal() {
    let (root, store, _proof) = fixture();
    let archive_before = fs::read(root.path().join("archive-library-v1/archive.sqlite3")).unwrap();
    let store = Arc::new(store);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let archive_store = store.clone();
    let archive = std::thread::spawn(move || {
        archive_store.with_archive_write_checked(
            "0",
            |_| Ok(None),
            |_, _| {
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(WAIT.saturating_mul(3)).unwrap();
                Err::<(), _>("fixture-archive-refusal".into())
            },
            || Ok(()),
        )
    });
    entered_rx.recv_timeout(WAIT).unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let main_store = store.clone();
    let main = std::thread::spawn(move || {
        done_tx
            .send(
                main_store
                    .write_record_guarded("preferences", &PREFS.replace("0.5", "0.6"), None, || {
                        Ok(())
                    })
                    .map(|r| r.committed),
            )
            .unwrap();
    });
    let observed = done_rx.recv_timeout(WAIT);
    release_tx.send(()).unwrap();
    main.join().unwrap();
    assert_eq!(
        archive.join().unwrap().unwrap_err(),
        "fixture-archive-refusal"
    );
    assert!(observed
        .expect("Main write waited for unrelated Archive SQL")
        .unwrap());
    assert_eq!(
        fs::read(root.path().join("archive-library-v1/archive.sqlite3")).unwrap(),
        archive_before
    );
    let prefs: serde_json::Value =
        serde_json::from_str(store.read("preferences").unwrap().as_ref().unwrap()).unwrap();
    assert_eq!(prefs["volume"], 0.6);
}

#[test]
fn archive_bookmark_commits_while_real_main_backup_is_held() {
    let (root, store, proof) = fixture();
    let store = Arc::new(store);
    let (entered, release, main) = held_main_backup(store.clone());
    entered.recv_timeout(WAIT).unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let archive_store = store.clone();
    let archive = std::thread::spawn(move || {
        let result =
            archive_store.write_archive_bookmark_checked(&proof, "0", &position(), || Ok(()));
        done_tx
            .send(result.map(|r| (r.committed, r.changed, r.revision)))
            .unwrap();
    });
    // Always release/join original workers, including the expected red baseline.
    let observed = done_rx.recv_timeout(WAIT);
    release.send(()).unwrap();
    main.join().unwrap().unwrap();
    archive.join().unwrap();
    let receipt = observed
        .expect("Archive bookmark waited for an unrelated main backup")
        .unwrap();
    assert_eq!(receipt, (true, true, "1".into()));
    store
        .with_archive_read(|c| {
            assert_eq!(
                c.query_row("SELECT position_ms FROM archive_bookmark_v1", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                12000
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(
        logical_image(&root.path().join("archive-library-v1/archive.sqlite3")),
        logical_image(
            &root
                .path()
                .join("archive-library-v1/archive.sqlite3.backup")
        )
    );
    let reopened = Store::new(root.path().into(), "writer-domains-reopen".into()).unwrap();
    assert_eq!(
        reopened
            .with_archive_read(|c| Ok(c
                .query_row("SELECT position_ms FROM archive_bookmark_v1", [], |r| r
                    .get::<_, i64>(0))
                .unwrap()))
            .unwrap(),
        12000
    );
}
