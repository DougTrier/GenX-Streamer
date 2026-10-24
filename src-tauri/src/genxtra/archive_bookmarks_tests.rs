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
use std::cell::Cell;
fn database() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch(
            "PRAGMA foreign_keys=ON;CREATE TABLE live_fixture(id TEXT PRIMARY KEY);INSERT INTO live_fixture VALUES('preserved');",
        )
        .unwrap();
    let tx = c.transaction().unwrap();
    archive_catalog::install(&tx).unwrap();
    install(&tx).unwrap();
    tx.commit().unwrap();
    c
}
fn add(c: &Connection, item: &str, name: &str, hash: Option<&str>) -> String {
    let title = archive_catalog::opaque(&["archive-item-v1", item]);
    let reference = archive_catalog::opaque(&["archive-file-v1", item, name]);
    c.execute("INSERT OR IGNORE INTO archive_title_v1(title_ref,item_id,title,kind,release_year,curated,searched,rights,downloads,observed_ms,search_text) VALUES(?1,?2,'Same title','tv',1964,0,1,NULL,1,1,'same title')",params![title,item]).unwrap();
    c.execute("INSERT INTO archive_file_v1(file_ref,title_ref,item_id,file_name,format,size_bytes,duration_seconds,sha1,servers,observed_ms,eligible) VALUES(?1,?2,?3,?4,'h.264','100',60,?5,'[]',1,1)",params![reference,title,item,name,hash]).unwrap();
    reference
}
const HASH: &str = "0123456789abcdef0123456789abcdef01234567";
fn proof(c: &Connection, reference: &str) -> Proof {
    capture(
        reference,
        &archive_catalog::resolve(c, reference, "0").unwrap(),
    )
    .unwrap()
}
fn position() -> Position {
    Position {
        position_ms: 12_345,
        duration_ms: Some(60_000),
        completed: false,
        observed_ms: 1000,
    }
}
fn disk_fixture() -> (tempfile::TempDir, crate::storage::Store, Proof) {
    let root = tempfile::tempdir().unwrap();
    let store = crate::storage::Store::new(root.path().into(), "test".into()).unwrap();
    store.with_guide_write(|c| {
            c.execute_batch("CREATE TABLE bookmark_preflight_live(id TEXT PRIMARY KEY,payload BLOB);INSERT INTO bookmark_preflight_live VALUES('retained',zeroblob(1048576));").unwrap();
            Ok(())
        }).unwrap();
    store.with_guide_write(|_| Ok(())).unwrap();
    let proof = store
        .with_archive_fixture_write(|c| {
            let reference = add(c, "item", "episode.mp4", Some(HASH));
            Ok(proof(c, &reference))
        })
        .unwrap();
    (root, store, proof)
}
fn namespace_path(root: &std::path::Path, backup: bool) -> std::path::PathBuf {
    root.join("archive-library-v1").join(if backup {
        "archive.sqlite3.backup"
    } else {
        "archive.sqlite3"
    })
}
fn disk_images(root: &std::path::Path) -> (Vec<u8>, Vec<u8>) {
    (
        std::fs::read(namespace_path(root, false)).unwrap(),
        std::fs::read(namespace_path(root, true)).unwrap(),
    )
}
#[test]
fn archive_bookmarks_preflight_duplicates_stale_and_invalid_skip_backup() {
    let (root, store, proof) = disk_fixture();
    let receipt = store
        .write_archive_bookmark_checked(&proof, "0", &position(), || Ok(()))
        .unwrap();
    assert!(receipt.committed && receipt.changed);
    let before = disk_images(root.path());
    let mut later = position();
    later.observed_ms += 1000;
    let receipt = store
        .write_archive_bookmark_checked(&proof, "1", &later, || Ok(()))
        .unwrap();
    assert!(receipt.committed && !receipt.changed);
    assert_eq!(receipt.revision, "1");
    assert_eq!(disk_images(root.path()), before);
    assert_eq!(
        store
            .with_archive_read(|c| Ok(read(c, &proof)?.position.unwrap().observed_ms))
            .unwrap(),
        1000
    );
    assert!(
        matches!(store.write_archive_bookmark_checked(&proof,"0",&later,||Ok(())),Err(e)if e=="archive-bookmark-revision-stale")
    );
    for revision in ["01", "invalid"] {
        assert!(store
            .write_archive_bookmark_checked(&proof, revision, &later, || Ok(()))
            .is_err());
    }
    later.position_ms = -1;
    assert!(store
        .write_archive_bookmark_checked(&proof, "1", &later, || Ok(()))
        .is_err());
    assert_eq!(disk_images(root.path()), before);
    store
        .with_archive_fixture_write(|c| {
            c.execute("UPDATE archive_file_v1 SET size_bytes='101'", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
    let changed_file = disk_images(root.path());
    assert!(
        matches!(store.write_archive_bookmark_checked(&proof,"1",&position(),||Ok(())),Err(e)if e=="archive-file-changed")
    );
    assert_eq!(disk_images(root.path()), changed_file);
}
#[test]
fn archive_bookmarks_preflight_changed_timeline_keeps_full_backup_and_recovery() {
    let (root, store, proof) = disk_fixture();
    let main_before = (
        std::fs::read(root.path().join("genx.sqlite3")).unwrap(),
        std::fs::read(root.path().join("genx.sqlite3.backup")).unwrap(),
    );
    store
        .write_archive_bookmark_checked(&proof, "0", &position(), || Ok(()))
        .unwrap();
    let before_backup = disk_images(root.path()).1;
    let mut next = position();
    next.position_ms = 20000;
    next.observed_ms = 2000;
    let receipt = store
        .write_archive_bookmark_checked(&proof, "1", &next, || Ok(()))
        .unwrap();
    assert!(receipt.committed && receipt.changed);
    assert_eq!(receipt.revision, "2");
    assert_ne!(disk_images(root.path()).1, before_backup);
    let backup = Connection::open(namespace_path(root.path(), true)).unwrap();
    let saved = read(&backup, &proof).unwrap();
    assert_eq!(saved.revision, "2");
    assert_eq!(saved.position.unwrap().position_ms, 20000);
    assert_eq!(
        backup
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name='bookmark_preflight_live'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        backup
            .query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(backup);
    assert_eq!(
        (
            std::fs::read(root.path().join("genx.sqlite3")).unwrap(),
            std::fs::read(root.path().join("genx.sqlite3.backup")).unwrap()
        ),
        main_before
    );
    assert_eq!(
        store
            .with_guide_read(|c| Ok(c
                .query_row(
                    "SELECT length(payload) FROM bookmark_preflight_live",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap()))
            .unwrap(),
        1048576
    );
    drop(store);
    std::fs::write(namespace_path(root.path(), false), b"fixture corruption").unwrap();
    let reopened = crate::storage::Store::new(root.path().into(), "test".into()).unwrap();
    let saved = reopened.with_archive_read(|c| read(c, &proof)).unwrap();
    assert_eq!(saved.revision, "2");
    assert_eq!(saved.position.unwrap().position_ms, 20000);
    drop(reopened);
    // Independent canonical recovery cannot roll the namespace back.
    std::fs::write(root.path().join("genx.sqlite3"), b"main fixture corruption").unwrap();
    let reopened = crate::storage::Store::new(root.path().into(), "test".into()).unwrap();
    let saved = reopened.with_archive_read(|c| read(c, &proof)).unwrap();
    assert_eq!(saved.revision, "2");
    assert_eq!(saved.position.unwrap().position_ms, 20000);
    assert_eq!(
        reopened
            .with_guide_read(|c| Ok(c
                .query_row(
                    "SELECT length(payload) FROM bookmark_preflight_live",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap()))
            .unwrap(),
        1048576
    );
}
#[test]
fn archive_bookmarks_preflight_cancel_before_noop_commit_and_during_backup_preserves_images() {
    use crate::archive_library_store::{observe_backup, BackupPhase};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let (root, store, proof) = disk_fixture();
    store
        .write_archive_bookmark_checked(&proof, "0", &position(), || Ok(()))
        .unwrap();
    let before = disk_images(root.path());
    assert!(
        matches!(store.write_archive_bookmark_checked(&proof,"1",&position(),||Err("canceled".into())),Err(e)if e=="canceled")
    );
    assert_eq!(disk_images(root.path()), before);
    let mut next = position();
    next.position_ms = 20000;
    let canceled = Arc::new(AtomicBool::new(false));
    let copied = Arc::new(AtomicBool::new(false));
    let mark = canceled.clone();
    let seen = copied.clone();
    let observer = observe_backup(move |phase| {
        if phase == BackupPhase::AfterCopy {
            seen.store(true, Ordering::SeqCst);
            mark.store(true, Ordering::SeqCst);
        }
        Ok(())
    });
    assert!(
        matches!(store.write_archive_bookmark_checked(&proof,"1",&next,||if canceled.load(Ordering::SeqCst){Err("canceled".into())}else{Ok(())}),Err(e)if e=="canceled")
    );
    assert!(copied.load(Ordering::SeqCst));
    assert_eq!(disk_images(root.path()), before);
    drop(observer);
    let receipt = store
        .write_archive_bookmark_checked(&proof, "1", &next, || Ok(()))
        .unwrap();
    assert!(receipt.changed);
}
#[test]
fn archive_bookmarks_preflight_revalidates_after_backup_and_validates_noop_namespace() {
    use crate::archive_library_store::{observe_backup, BackupPhase};
    for replace_file in [false, true] {
        let (root, store, proof) = disk_fixture();
        let mut mutation = Connection::open(namespace_path(root.path(), false)).unwrap();
        let mut changed = false;
        let observer = observe_backup(move |phase| {
            if phase == BackupPhase::AfterPublish && !changed {
                changed = true;
                let tx = mutation.transaction().unwrap();
                tx.execute_batch(if replace_file {
                    "UPDATE archive_file_v1 SET size_bytes='101';"
                } else {
                    "UPDATE archive_bookmark_meta_v1 SET revision=1;"
                })
                .unwrap();
                crate::archive_library_store::finalize(&tx, false, &mut || Ok(())).unwrap();
                tx.commit().unwrap();
            }
            Ok(())
        });
        assert!(
            matches!(store.write_archive_bookmark_checked(&proof,"0",&position(),||Ok(())),Err(e)if e=="archive-revision-stale")
        );
        drop(observer);
        assert!(store
            .with_archive_read(|c| Ok(stored(c, &proof.reference)?.is_none()))
            .unwrap());
    }
    let (root, store, proof) = disk_fixture();
    store
        .write_archive_bookmark_checked(&proof, "0", &position(), || Ok(()))
        .unwrap();
    let other_proof = store
        .with_archive_fixture_write(|c| {
            let other = add(c, "other", "episode.mp4", Some(HASH));
            Ok(super::tests::proof(c, &other))
        })
        .unwrap();
    store
        .write_archive_bookmark_checked(&other_proof, "1", &position(), || Ok(()))
        .unwrap();
    // Corrupt BOTH copies, so neither is a valid recovery source. Unknown
    // proof metadata cannot receive a successful no-op acknowledgement.
    for backup in [false, true] {
        let c = Connection::open(namespace_path(root.path(), backup)).unwrap();
        c.execute(
            "UPDATE archive_bookmark_v1 SET provider_sha1=?1 WHERE file_ref=?2",
            params!["g".repeat(40), other_proof.reference],
        )
        .unwrap();
    }
    let before = disk_images(root.path());
    assert!(
        matches!(store.write_archive_bookmark_checked(&proof,"2",&position(),||Ok(())),Err(e)if e==crate::archive_library_store::REPAIR)
    );
    assert_eq!(disk_images(root.path()), before);
}
#[test]
fn archive_bookmarks_preflight_only_observation_time_is_ignored() {
    let mut c = database();
    let reference = add(&c, "item", "episode.mp4", Some(HASH));
    let proof = proof(&c, &reference);
    save(&mut c, &proof, "0", &position(), || Ok(())).unwrap();
    let mut next = position();
    next.observed_ms = 2000;
    let unchanged = save(&mut c, &proof, "1", &next, || Ok(())).unwrap();
    assert!(!unchanged.changed);
    assert_eq!(
        read(&c, &proof).unwrap().position.unwrap().observed_ms,
        1000
    );
    for (revision, field) in [("1", "duration"), ("2", "completed"), ("3", "position")] {
        match field {
            "duration" => next.duration_ms = Some(61_000),
            "completed" => next.completed = true,
            _ => next.position_ms = 20_000,
        }
        assert!(preflight_save(&c, &proof, revision, &next, &|| Ok(()))
            .unwrap()
            .is_none());
        assert!(c.is_autocommit());
        assert!(
            save(&mut c, &proof, revision, &next, || Ok(()))
                .unwrap()
                .changed
        );
    }
    assert_eq!(current(&c).unwrap(), 4);
}
#[test]
fn archive_bookmarks_exact_identity_and_unrelated_revision_preserve_position() {
    let mut c = database();
    let reference = add(&c, "item", "episode.mp4", Some(HASH));
    let p = proof(&c, &reference);
    assert!(read(&c, &p).unwrap().position.is_none());
    let result = save(&mut c, &p, "0", &position(), || Ok(())).unwrap();
    assert!(result.committed && result.changed);
    assert_eq!(result.revision, "1");
    c.execute("UPDATE archive_catalog_meta_v1 SET revision=17", [])
        .unwrap();
    c.execute("UPDATE archive_file_v1 SET provider_index=33", [])
        .unwrap();
    assert_eq!(read(&c, &p).unwrap().position.unwrap().position_ms, 12_345);
    assert_eq!(
        save(&mut c, &p, "1", &position(), || Ok(()))
            .unwrap()
            .revision,
        "1"
    );
    let encoded = serde_json::to_string(&read(&c, &p).unwrap()).unwrap();
    assert!(
        !encoded.contains("item") && !encoded.contains("episode.mp4") && !encoded.contains(HASH)
    );
}
#[test]
fn archive_bookmarks_replacement_same_filename_and_other_edition_never_resume() {
    let mut c = database();
    let reference = add(&c, "item", "episode.mp4", Some(HASH));
    let p = proof(&c, &reference);
    save(&mut c, &p, "0", &position(), || Ok(())).unwrap();
    let other = add(&c, "other-item", "episode.mp4", Some(HASH));
    assert!(read(&c, &proof(&c, &other)).unwrap().position.is_none());
    c.execute(
        "UPDATE archive_file_v1 SET size_bytes='101' WHERE file_ref=?1",
        [&reference],
    )
    .unwrap();
    assert!(read(&c, &p).is_err());
    let new = proof(&c, &reference);
    assert!(read(&c, &new).unwrap().position.is_none());
    assert_eq!(current(&c).unwrap(), 1);
    assert_eq!(stored(&c, &reference).unwrap().unwrap().2, "100");
    c.execute(
        "DELETE FROM archive_file_v1 WHERE file_ref=?1",
        [&reference],
    )
    .unwrap();
    assert!(read(&c, &new).is_err());
    assert!(stored(&c, &reference).unwrap().is_some());
}
#[test]
fn archive_bookmarks_unproven_checksum_and_wrong_reference_are_rejected() {
    let c = database();
    let reference = add(&c, "item", "episode.mp4", None);
    let mut f = archive_catalog::resolve(&c, &reference, "0").unwrap();
    let unsupported = read_unsupported(&c, &reference, &f).unwrap();
    assert_eq!(unsupported.revision, "0");
    assert!(unsupported.position.is_none());
    assert!(capture(&reference, &f).is_err());
    f.sha1 = Some("unknown".into());
    assert!(capture(&reference, &f).is_err());
    f.sha1 = Some(HASH.into());
    assert!(capture(&"a".repeat(64), &f).is_err());
    assert!(capture(&reference, &f).is_ok());
}
#[test]
fn archive_bookmarks_cancellation_and_stale_cas_leave_no_mutation() {
    let mut c = database();
    let reference = add(&c, "item", "episode.mp4", Some(HASH));
    let p = proof(&c, &reference);
    assert!(save(&mut c, &p, "0", &position(), || Err("canceled".into())).is_err());
    let checks = Cell::new(0);
    assert!(save(&mut c, &p, "0", &position(), || {
        checks.set(checks.get() + 1);
        if checks.get() == 2 {
            Err("canceled".into())
        } else {
            Ok(())
        }
    })
    .is_err());
    assert_eq!(current(&c).unwrap(), 0);
    assert!(stored(&c, &reference).unwrap().is_none());
    save(&mut c, &p, "0", &position(), || Ok(())).unwrap();
    let mut next = position();
    next.position_ms = 20_000;
    assert!(save(&mut c, &p, "0", &next, || Ok(())).is_err());
    assert!(save(&mut c, &p, "01", &next, || Ok(())).is_err());
    assert_eq!(read(&c, &p).unwrap().position.unwrap().position_ms, 12_345);
    // Exactly two checks, both before COMMIT: a late cancellation cannot hide it.
    let checks = Cell::new(0);
    let receipt = save(&mut c, &p, "1", &next, || {
        checks.set(checks.get() + 1);
        if checks.get() > 2 {
            Err("late".into())
        } else {
            Ok(())
        }
    })
    .unwrap();
    assert!(receipt.committed);
    assert_eq!(checks.get(), 2);
    assert_eq!(receipt.revision, "2");
}
#[test]
fn archive_bookmarks_clear_is_atomic_archive_only_and_preserves_live_choices() {
    let mut c = database();
    let reference = add(&c, "item", "episode.mp4", Some(HASH));
    let p = proof(&c, &reference);
    save(&mut c, &p, "0", &position(), || Ok(())).unwrap();
    let checks = Cell::new(0);
    assert!(clear(&mut c, "1", || {
        checks.set(checks.get() + 1);
        if checks.get() == 2 {
            Err("canceled".into())
        } else {
            Ok(())
        }
    })
    .is_err());
    assert!(read(&c, &p).unwrap().position.is_some());
    let receipt = clear(&mut c, "1", || Ok(())).unwrap();
    assert_eq!(receipt.revision, "2");
    assert!(read(&c, &p).unwrap().position.is_none());
    assert_eq!(archive_catalog::current(&c).unwrap(), 0);
    assert_eq!(
        c.query_row("SELECT count(*) FROM live_fixture", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(!clear(&mut c, "2", || Ok(())).unwrap().changed);
}
#[test]
fn archive_bookmarks_position_bounds_and_namespace_corruption_refuse_without_trimming() {
    let mut c = database();
    let reference = add(&c, "item", "episode.mp4", Some(HASH));
    let p = proof(&c, &reference);
    for bad in [-1, MAX_POSITION + 1] {
        let mut value = position();
        value.position_ms = bad;
        assert!(save(&mut c, &p, "0", &value, || Ok(())).is_err());
    }
    let mut bad = position();
    bad.duration_ms = Some(1);
    assert!(save(&mut c, &p, "0", &bad, || Ok(())).is_err());
    save(&mut c, &p, "0", &position(), || Ok(())).unwrap();
    c.execute(
        "UPDATE archive_bookmark_v1 SET provider_sha1=?1",
        ["z".repeat(40)],
    )
    .unwrap();
    assert!(validate(&c).is_err());
    assert_eq!(current(&c).unwrap(), 1);
    assert!(clear(&mut c, "0", || Ok(())).is_err());
}
#[test]
fn archive_bookmarks_byte_and_count_limits_are_bounded_not_truncated() {
    for (rows, long) in [(10_001usize, false), (4000, true)] {
        let mut c = database();
        let tx = c.transaction().unwrap();
        for i in 0..rows {
            let item = format!("item{i}");
            let name = if long {
                format!("{}-{i}", "a".repeat(1000))
            } else {
                "a.mp4".into()
            };
            let reference = archive_catalog::opaque(&["archive-file-v1", &item, &name]);
            tx.execute(
                "INSERT INTO archive_bookmark_v1 VALUES(?1,?2,?3,'100',?4,1,NULL,0,1)",
                params![reference, item, name, HASH],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        assert_eq!(validate(&c), Err("archive-bookmark-limit".into()));
        assert_eq!(
            c.query_row("SELECT count(*) FROM archive_bookmark_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            rows as i64
        );
    }
}
#[test]
fn archive_bookmarks_schema15_backed14_migration_keeps_old_backup_and_live_data() {
    let root = tempfile::tempdir().unwrap();
    let store = crate::storage_transaction::PairStore::new(root.path().into()).unwrap();
    let catalog = serde_json::json!({"schemaVersion":1,"sources":[],"channels":[]}).to_string();
    let preferences=serde_json::json!({"schemaVersion":1,"sources":[],"favorites":["recoverable"],"removedChannels":["removed-live"],"volume":0.5,"muted":false,"panelWidth":300.0}).to_string();
    store.write_pair(&catalog, &preferences).unwrap();
    let before = store.read_snapshot().unwrap();
    drop(store);
    let c = Connection::open(root.path().join("genx.sqlite3")).unwrap();
    c.execute_batch("DROP TABLE public_archive_variant_v1;DROP TABLE public_archive_item_v1;DROP TABLE public_archive_preference_v1;DROP TABLE public_archive_removal_v1;DROP TABLE public_archive_checkpoint_v1;DROP TABLE archive_bookmark_v1;DROP TABLE archive_bookmark_meta_v1;PRAGMA user_version=14;").unwrap();
    drop(c);
    let reopened = crate::storage_transaction::PairStore::new(root.path().into()).unwrap();
    let after = reopened.read_snapshot().unwrap();
    assert_eq!(before.pair, after.pair);
    assert_eq!(before.catalog_revision, after.catalog_revision);
    reopened
        .with_guide_read(|c| {
            assert_eq!(
                c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                16
            );
            validate(c)
        })
        .unwrap();
    let backup = Connection::open(root.path().join("genx.sqlite3.backup")).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        14
    );
    assert_eq!(
        backup
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name LIKE 'archive_bookmark_%'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
#[test]
fn archive_bookmarks_missing_schema15_namespace_is_refused_not_reinitialized() {
    for table in ["archive_bookmark_v1", "archive_bookmark_meta_v1"] {
        let root = tempfile::tempdir().unwrap();
        drop(crate::storage_transaction::PairStore::new(root.path().into()).unwrap());
        let c = Connection::open(root.path().join("genx.sqlite3")).unwrap();
        c.execute_batch(&format!("DROP TABLE {table}")).unwrap();
        drop(c);
        assert!(crate::storage_transaction::PairStore::new(root.path().into()).is_err());
        let c = Connection::open(root.path().join("genx.sqlite3")).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name=?1",
                [table],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
}
