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

//! Synthetic namespace proof fixtures; never inspect profiles or devices.
use super::*;

fn active() -> (tempfile::TempDir, Binding) {
    let root = tempfile::tempdir().unwrap();
    let mut source = Connection::open_in_memory().unwrap();
    let tx = source.transaction().unwrap();
    archive_catalog::install(&tx).unwrap();
    archive_bookmarks::install(&tx).unwrap();
    archive_provider_catalog::install(&tx).unwrap();
    let title = archive_catalog::opaque(&["archive-item-v1", "proof-fixture"]);
    let file = archive_catalog::opaque(&["archive-file-v1", "proof-fixture", "episode.mp4"]);
    tx.execute(
        "INSERT INTO archive_title_v1 VALUES(?1,'proof-fixture','Proof fixture','tv',1964,1,1,NULL,5,10,'proof fixture')",
        [&title],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO archive_file_v1 VALUES(?1,?2,'proof-fixture','episode.mp4','h.264','100',10.0,?3,'[]',10,1,0,NULL,'Episode')",
        params![file, title, "a".repeat(40)],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO archive_preferences_v1 VALUES(?1,'proof-fixture','Proof fixture',1964,1)",
        [&title],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO archive_bookmark_v1 VALUES(?1,'proof-fixture','episode.mp4','100',?2,1000,10000,0,10)",
        params![file, "a".repeat(40)],
    )
    .unwrap();
    tx.execute_batch("PRAGMA user_version=16;").unwrap();
    tx.commit().unwrap();
    let lease = lock_root(root.path()).unwrap();
    let binding = prepare(&lease, &source, &mut || Ok(())).unwrap();
    activate(&lease, &binding, || Ok(()), &mut || Ok(())).unwrap();
    drop(lease);
    (root, binding)
}
fn reset() {
    STARTUP_PAIR_VALIDATIONS.with(|v| v.set(0));
}
fn validations() -> usize {
    STARTUP_PAIR_VALIDATIONS.with(|v| v.get())
}
fn images(root: &Path) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let dir = root.join(DIRECTORY);
    (
        fs::read(dir.join(DB)).unwrap(),
        fs::read(dir.join(BACKUP)).unwrap(),
        fs::read(root.join(WITNESS)).unwrap(),
    )
}

#[test]
fn same_exclusive_active_initialization_reuses_one_full_validated_pair_and_exact_bytes() {
    let (root, binding) = active();
    let before = images(root.path());
    let lease = lock_root(root.path()).unwrap();
    reset();
    verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap();
    verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap();
    activate(&lease, &binding, || Ok(()), &mut || Ok(())).unwrap();
    ArchiveStore::open_locked(&lease, &binding, &mut || Ok(())).unwrap();
    assert_eq!(
        validations(),
        1,
        "one complete pair validation per unchanged exclusive initialization"
    );
    assert!(
        images(root.path()) == before,
        "all namespace image bytes preserved"
    );
    let store = ArchiveStore::open_locked(&lease, &binding, &mut || Ok(())).unwrap();
    drop(lease);
    store
        .read(|c| {
            assert_eq!(
                c.query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                c.query_row("SELECT position_ms FROM archive_bookmark_v1", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1000
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn new_lock_lifetime_never_reuses_a_previous_validation() {
    let (root, binding) = active();
    reset();
    for _ in 0..2 {
        let lease = lock_root(root.path()).unwrap();
        verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap();
    }
    assert_eq!(validations(), 2);
}

fn prime(root: &Path, binding: &Binding) -> RootLock {
    let lease = lock_root(root).unwrap();
    verify_handoff_pair(&lease, binding, &mut || Ok(())).unwrap();
    assert!(lease.initialization_proof.lock().unwrap().is_some());
    reset();
    lease
}
fn set_schema_bytes(path: &Path) {
    let modified = fs::metadata(path).unwrap().modified().unwrap();
    let mut bytes = fs::read(path).unwrap();
    let length = bytes.len();
    bytes[60..64].copy_from_slice(&2u32.to_be_bytes());
    fs::write(path, bytes).unwrap();
    File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert_eq!(fs::metadata(path).unwrap().len(), length as u64);
    assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), modified);
}
#[test]
fn shared_lease_never_creates_or_reuses_initialization_proof() {
    let (root, binding) = active();
    let lease = lock_wait(root.path(), true, std::time::Duration::ZERO, &mut || Ok(())).unwrap();
    reset();
    for _ in 0..2 {
        verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap();
    }
    assert_eq!(validations(), 2);
    assert!(lease.initialization_proof.lock().unwrap().is_none());
}
#[test]
fn same_size_restored_mtime_schema_mutation_runs_full_validation_and_refuses() {
    let (root, binding) = active();
    let lease = prime(root.path(), &binding);
    set_schema_bytes(&root.path().join(DIRECTORY).join(DB));
    assert_eq!(
        verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap_err(),
        SCHEMA
    );
    assert_eq!(validations(), 1);
    assert!(lease.initialization_proof.lock().unwrap().is_none());
}
#[test]
fn changed_domain_bytes_on_both_copies_cannot_reuse_old_verified_snapshot() {
    let (root, binding) = active();
    let lease = prime(root.path(), &binding);
    for name in [DB, BACKUP] {
        let path = root.path().join(DIRECTORY).join(name);
        let mut bytes = fs::read(&path).unwrap();
        let location = bytes
            .windows(13)
            .position(|v| v == b"Proof fixture")
            .unwrap();
        bytes[location] = b'X';
        fs::write(path, bytes).unwrap();
    }
    assert_eq!(
        verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap_err(),
        REPAIR
    );
    assert_eq!(validations(), 1);
    assert!(lease.initialization_proof.lock().unwrap().is_none());
}
#[test]
fn each_journal_marker_forces_original_pair_path_without_caching() {
    for suffix in ["-journal", "-wal", "-shm"] {
        let (root, binding) = active();
        let lease = prime(root.path(), &binding);
        let path = root.path().join(DIRECTORY).join(format!("{DB}{suffix}"));
        fs::write(&path, []).unwrap();
        verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap();
        assert_eq!(validations(), 1, "{suffix}");
        assert!(lease.initialization_proof.lock().unwrap().is_none());
    }
}
#[test]
fn witness_and_wrong_binding_refusals_invalidate_prior_proof() {
    let (root, binding) = active();
    let lease = prime(root.path(), &binding);
    let mut wrong = binding.clone();
    wrong.namespace = "f".repeat(64);
    assert_eq!(
        verify_handoff_pair(&lease, &wrong, &mut || Ok(())).unwrap_err(),
        REPAIR
    );
    assert!(lease.initialization_proof.lock().unwrap().is_none());
    verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap();
    assert_eq!(validations(), 1);
    fs::write(root.path().join(WITNESS), b"{}").unwrap();
    assert_eq!(
        verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap_err(),
        REPAIR
    );
    assert!(lease.initialization_proof.lock().unwrap().is_none());
}
#[test]
fn prepared_state_and_fresh_seal_authority_never_inherit_active_proof() {
    let (root, binding) = active();
    let lease = prime(root.path(), &binding);
    save_witness(root.path(), &binding, Phase::Prepared).unwrap();
    verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap();
    assert_eq!(validations(), 1);
    assert!(lease.initialization_proof.lock().unwrap().is_none());
    activate(&lease, &binding, || Ok(()), &mut || Ok(())).unwrap();
    assert_eq!(validations(), 2);
    assert!(lease.initialization_proof.lock().unwrap().is_none());
    verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap();
    let mut called = false;
    assert_eq!(
        activate(
            &lease,
            &binding,
            || {
                called = true;
                Err("seal-stale".into())
            },
            &mut || Ok(())
        )
        .unwrap_err(),
        "seal-stale"
    );
    assert!(called);
    assert!(lease.initialization_proof.lock().unwrap().is_none());
}
#[test]
fn pathname_replacement_during_hash_never_acknowledges_old_open_file() {
    let (root, binding) = active();
    let lease = prime(root.path(), &binding);
    let path = root.path().join(DIRECTORY).join(DB);
    let old = root
        .path()
        .join(DIRECTORY)
        .join("replaced-owned-fixture.sqlite3");
    let mut calls = 0;
    let mut replaced = false;
    let result = verify_handoff_pair(&lease, &binding, &mut || {
        calls += 1;
        if calls == 4 {
            fs::rename(&path, &old).unwrap();
            fs::copy(&old, &path).unwrap();
            set_schema_bytes(&path);
            replaced = true;
        }
        Ok(())
    });
    assert!(replaced);
    assert_eq!(result.unwrap_err(), SCHEMA);
    assert_eq!(validations(), 1);
    assert!(lease.initialization_proof.lock().unwrap().is_none());
}
#[test]
fn cancel_and_panic_during_hash_discard_proof_and_next_operation_fully_revalidates() {
    for panic in [false, true] {
        let (root, binding) = active();
        let lease = prime(root.path(), &binding);
        let before = images(root.path());
        let mut calls = 0;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            verify_handoff_pair(&lease, &binding, &mut || {
                calls += 1;
                if calls == 4 {
                    if panic {
                        panic!("owned hash authority fixture");
                    }
                    return Err("canceled".into());
                }
                Ok(())
            })
        }));
        if panic {
            assert!(result.is_err());
        } else {
            assert_eq!(result.unwrap().unwrap_err(), "canceled");
        }
        assert!(lease.initialization_proof.lock().unwrap().is_none());
        assert_eq!(validations(), 0);
        assert!(
            images(root.path()) == before,
            "all namespace image bytes preserved"
        );
        verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap();
        assert_eq!(validations(), 1);
    }
}
#[test]
fn repaired_peer_cannot_seed_proof_until_subsequent_unchanged_full_validation() {
    let (root, binding) = active();
    let lease = prime(root.path(), &binding);
    let dir = root.path().join(DIRECTORY);
    let expected = read_copy(&dir.join(BACKUP), &mut || Ok(()))
        .unwrap()
        .unwrap();
    fs::write(dir.join(DB), b"corrupt").unwrap();
    verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap();
    assert_eq!(validations(), 1);
    assert!(lease.initialization_proof.lock().unwrap().is_none());
    assert_eq!(
        read_copy(&dir.join(DB), &mut || Ok(())).unwrap().unwrap(),
        expected
    );
    verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap();
    verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap();
    assert_eq!(validations(), 2);
}
#[test]
fn legitimate_namespace_revision_change_revalidates_and_returns_new_snapshot() {
    let (root, binding) = active();
    let lease = prime(root.path(), &binding);
    let dir = root.path().join(DIRECTORY);
    let old = lease
        .initialization_proof
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .snapshot
        .clone();
    let mut c = connect(&dir.join(DB), false, false).unwrap();
    let tx = c.transaction().unwrap();
    tx.execute_batch("UPDATE archive_bookmark_v1 SET position_ms=2000;UPDATE archive_bookmark_meta_v1 SET revision=revision+1;")
        .unwrap();
    finalize(&tx, false, &mut || Ok(())).unwrap();
    tx.commit().unwrap();
    mirror(&c, &dir.join(BACKUP), &mut || Ok(())).unwrap();
    let new = initialization_pair(&lease, &binding, &mut || Ok(())).unwrap();
    assert_eq!(validations(), 1);
    assert_eq!(new.sequence, old.sequence + 1);
    assert_eq!(new.bookmark_revision, old.bookmark_revision + 1);
    assert_ne!(new.digest, old.digest);
}

#[test]
fn final_image_and_reuse_authority_refusals_never_restore_the_proof() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    for boundary in [ProofBoundary::ImagesReady, ProofBoundary::ReuseReady] {
        let (root, binding) = active();
        let lease = prime(root.path(), &binding);
        let before = images(root.path());
        let refused = Arc::new(AtomicBool::new(false));
        let signal = refused.clone();
        PROOF_BOUNDARY_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move |phase| {
                if phase == boundary {
                    signal.store(true, Ordering::SeqCst);
                }
            }))
        });
        let result = verify_handoff_pair(&lease, &binding, &mut || {
            if refused.load(Ordering::SeqCst) {
                Err("authority-refused".into())
            } else {
                Ok(())
            }
        });
        PROOF_BOUNDARY_HOOK.with(|slot| *slot.borrow_mut() = None);
        assert!(refused.load(Ordering::SeqCst));
        assert_eq!(result.unwrap_err(), "authority-refused");
        assert!(lease.initialization_proof.lock().unwrap().is_none());
        assert_eq!(validations(), 0);
        assert!(
            images(root.path()) == before,
            "refusal preserves all namespace bytes"
        );
        verify_handoff_pair(&lease, &binding, &mut || Ok(())).unwrap();
        assert_eq!(validations(), 1);
    }
}
