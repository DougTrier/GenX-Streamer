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

//! Exact-file bookmark storage only. Runtime owners must retain their root/session
//! authority and use the checked, verified-backup writer before calling mutations.
//! Provider SHA1 is provenance, not a claim of end-to-end media hashing.
use crate::archive_catalog::{self, ResolvedFile};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

const MAX_POSITION: i64 = 604_800_000;
const MAX_ROWS: usize = 10_000;
const MAX_BYTES: usize = 4 * 1024 * 1024;
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|_| "archive-bookmark-storage-failed".into())
}
pub(crate) fn install(tx: &Transaction<'_>) -> Result<(), String> {
    sql(tx.execute_batch("CREATE TABLE archive_bookmark_meta_v1(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision>=0));INSERT INTO archive_bookmark_meta_v1 VALUES(1,0);
CREATE TABLE archive_bookmark_v1(file_ref TEXT PRIMARY KEY CHECK(length(file_ref)=64),item_id TEXT NOT NULL CHECK(length(CAST(item_id AS BLOB)) BETWEEN 1 AND 100),file_name TEXT NOT NULL CHECK(length(CAST(file_name AS BLOB)) BETWEEN 1 AND 1024),size_bytes TEXT NOT NULL,provider_sha1 TEXT NOT NULL CHECK(length(provider_sha1)=40),position_ms INTEGER NOT NULL CHECK(position_ms BETWEEN 0 AND 604800000),duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms BETWEEN 1 AND 604800000),completed INTEGER NOT NULL CHECK(completed IN(0,1)),observed_ms INTEGER NOT NULL CHECK(observed_ms BETWEEN 0 AND 9007199254740991),CHECK(duration_ms IS NULL OR position_ms<=duration_ms));"))
}

/// Minted from resolved native file authority; never accepts caller-supplied URLs,
/// titles, edition relationships or a deserialized proof.
pub(crate) struct Proof {
    reference: String,
    file: ResolvedFile,
}
fn identity(reference: &str, item: &str, name: &str, size: &str, sha1: &str) -> bool {
    archive_catalog::hex_ref(reference)
        && !item.is_empty()
        && item.len() <= 100
        && item
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && !name.is_empty()
        && name.len() <= 1024
        && !name.chars().any(|c| c.is_control())
        && !name.starts_with('/')
        && !name.contains('\\')
        && !name
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
        && archive_catalog::opaque(&["archive-file-v1", item, name]) == reference
        && size
            .parse::<u64>()
            .ok()
            .is_some_and(|n| n > 0 && n <= 64 * 1024 * 1024 * 1024 && n.to_string() == size)
        && sha1.len() == 40
        && sha1
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn capture(reference: &str, file: &ResolvedFile) -> Result<Proof, String> {
    if file.public.is_some() {
        return Err("archive-bookmark-identity-unproven".into());
    }
    let sha1 = file
        .sha1
        .as_deref()
        .ok_or("archive-bookmark-identity-unproven")?;
    if !identity(
        reference,
        &file.item_id,
        &file.file_name,
        &file.size_bytes,
        sha1,
    ) {
        return Err("archive-bookmark-identity-unproven".into());
    }
    Ok(Proof {
        reference: reference.into(),
        file: ResolvedFile {
            item_id: file.item_id.clone(),
            file_name: file.file_name.clone(),
            size_bytes: file.size_bytes.clone(),
            sha1: file.sha1.clone(),
            servers: file.servers.clone(),
            duration_seconds: file.duration_seconds,
            provider_index: file.provider_index,
            public: None,
        },
    })
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Position {
    pub position_ms: i64,
    /// Actual finite decoder duration, never inferred from a catalog field.
    pub duration_ms: Option<i64>,
    /// Caller may set only after its retained decoder's finite-ended event.
    pub completed: bool,
    pub observed_ms: i64,
}
fn position_valid(p: &Position) -> bool {
    (0..=MAX_POSITION).contains(&p.position_ms)
        && (0..=9_007_199_254_740_991).contains(&p.observed_ms)
        && p.duration_ms
            .is_none_or(|d| (1..=MAX_POSITION).contains(&d) && p.position_ms <= d)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadReceipt {
    pub schema_version: u8,
    pub revision: String,
    pub position: Option<Position>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    pub schema_version: u8,
    pub committed: bool,
    pub revision: String,
    pub changed: bool,
}
fn current(c: &Connection) -> Result<i64, String> {
    let rows: i64 = sql(
        c.query_row("SELECT count(*) FROM archive_bookmark_meta_v1", [], |r| {
            r.get(0)
        }),
    )?;
    let rev: i64 = sql(c.query_row(
        "SELECT revision FROM archive_bookmark_meta_v1 WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    if rows != 1 || rev < 0 {
        return Err("archive-bookmark-invalid".into());
    }
    Ok(rev)
}
fn expected(value: &str) -> Result<i64, String> {
    if value.is_empty()
        || value.len() > 19
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("archive-bookmark-revision-invalid".into());
    }
    value
        .parse::<i64>()
        .map_err(|_| "archive-bookmark-revision-invalid".into())
}
pub(crate) fn validate_input(revision: &str, position: &Position) -> Result<(), String> {
    expected(revision)?;
    if !position_valid(position) {
        return Err("archive-bookmark-position-invalid".into());
    }
    Ok(())
}
type Stored = (String, String, String, String, Position);
fn stored(c: &Connection, reference: &str) -> Result<Option<Stored>, String> {
    sql(c.query_row("SELECT item_id,file_name,size_bytes,provider_sha1,position_ms,duration_ms,completed,observed_ms FROM archive_bookmark_v1 WHERE file_ref=?1", [reference], |r| {
        let completed: i64 = r.get(6)?;
        if !(0..=1).contains(&completed) { return Err(rusqlite::Error::InvalidQuery); }
        Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,Position { position_ms:r.get(4)?,duration_ms:r.get(5)?,completed:completed==1,observed_ms:r.get(7)? }))
    }).optional())
}
fn matches(s: &Stored, proof: &Proof) -> bool {
    s.0 == proof.file.item_id
        && s.1 == proof.file.file_name
        && s.2 == proof.file.size_bytes
        && Some(s.3.as_str()) == proof.file.sha1.as_deref()
}
fn same_timeline(a: &Position, b: &Position) -> bool {
    a.position_ms == b.position_ms && a.duration_ms == b.duration_ms && a.completed == b.completed
}
/// Snapshot read. A retained but changed/deleted file never acquires a bookmark
/// through filename/title similarity. An unrelated discovery revision is harmless.
pub(crate) fn read(c: &Connection, proof: &Proof) -> Result<ReadReceipt, String> {
    let tx = sql(c.unchecked_transaction())?;
    archive_catalog::verify_live(&tx, &proof.reference, &proof.file)?;
    let revision = current(&tx)?;
    let saved = stored(&tx, &proof.reference)?;
    if let Some(s) = &saved {
        if !identity(&proof.reference, &s.0, &s.1, &s.2, &s.3) || !position_valid(&s.4) {
            return Err("archive-bookmark-invalid".into());
        }
    }
    let position = saved.filter(|s| matches(s, proof)).map(|s| s.4);
    sql(tx.commit())?;
    Ok(ReadReceipt {
        schema_version: 1,
        revision: revision.to_string(),
        position,
    })
}
/// Unknown checksum is a supported Restart-only outcome, not false absence.
/// The exact retained native selection still must be live in the same snapshot.
pub(crate) fn read_unsupported(
    c: &Connection,
    reference: &str,
    file: &ResolvedFile,
) -> Result<ReadReceipt, String> {
    let tx = sql(c.unchecked_transaction())?;
    archive_catalog::verify_live(&tx, reference, file)?;
    let revision = current(&tx)?;
    sql(tx.commit())?;
    Ok(ReadReceipt {
        schema_version: 1,
        revision: revision.to_string(),
        position: None,
    })
}
/// Full bounded namespace validation participates in canonical recovery/backup.
/// No initialization, trimming or replacement takes place on this read path.
pub(crate) fn validate(c: &Connection) -> Result<(), String> {
    current(c)?;
    let mut query = sql(c.prepare(
        "SELECT file_ref,item_id,file_name,size_bytes,provider_sha1,position_ms,duration_ms,completed,observed_ms FROM archive_bookmark_v1",
    ))?;
    let mut rows = sql(query.query([]))?;
    let mut count = 0usize;
    let mut bytes = 0usize;
    while let Some(r) = sql(rows.next())? {
        count += 1;
        if count > MAX_ROWS {
            return Err("archive-bookmark-limit".into());
        }
        let reference: String = sql(r.get(0))?;
        let item: String = sql(r.get(1))?;
        let name: String = sql(r.get(2))?;
        let size: String = sql(r.get(3))?;
        let sha1: String = sql(r.get(4))?;
        let completed: i64 = sql(r.get(7))?;
        let p = Position {
            position_ms: sql(r.get(5))?,
            duration_ms: sql(r.get(6))?,
            completed: completed == 1,
            observed_ms: sql(r.get(8))?,
        };
        if !identity(&reference, &item, &name, &size, &sha1)
            || !(0..=1).contains(&completed)
            || !position_valid(&p)
        {
            return Err("archive-bookmark-invalid".into());
        }
        bytes = bytes
            .checked_add(reference.len() + item.len() + name.len() + size.len() + sha1.len() + 192)
            .ok_or("archive-bookmark-limit")?;
        if bytes > MAX_BYTES {
            return Err("archive-bookmark-limit".into());
        }
    }
    Ok(())
}
fn finish(
    tx: Transaction<'_>,
    old: i64,
    changed: bool,
    check: &impl Fn() -> Result<(), String>,
) -> Result<Receipt, String> {
    let revision = if changed {
        old.checked_add(1)
            .ok_or("archive-bookmark-revision-exhausted")?
    } else {
        old
    };
    if changed {
        sql(tx.execute(
            "UPDATE archive_bookmark_meta_v1 SET revision=?1 WHERE singleton=1 AND revision=?2",
            params![revision, old],
        ))?;
    }
    validate(&tx)?;
    crate::archive_library_store::finalize(&tx, false, &mut || check())?;
    check()?;
    sql(tx.commit())?;
    // Irreversible COMMIT is reported even if the caller's signal changes now.
    Ok(Receipt {
        schema_version: 1,
        committed: true,
        revision: revision.to_string(),
        changed,
    })
}
pub(crate) fn save(
    c: &mut Connection,
    proof: &Proof,
    revision: &str,
    position: &Position,
    check: impl Fn() -> Result<(), String>,
) -> Result<Receipt, String> {
    check()?;
    validate_input(revision, position)?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let (old, changed) = prepare_save(&tx, proof, revision, position)?;
    if changed {
        sql(tx.execute("INSERT INTO archive_bookmark_v1 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(file_ref) DO UPDATE SET item_id=excluded.item_id,file_name=excluded.file_name,size_bytes=excluded.size_bytes,provider_sha1=excluded.provider_sha1,position_ms=excluded.position_ms,duration_ms=excluded.duration_ms,completed=excluded.completed,observed_ms=excluded.observed_ms",params![proof.reference,proof.file.item_id,proof.file.file_name,proof.file.size_bytes,proof.file.sha1,position.position_ms,position.duration_ms,position.completed as i64,position.observed_ms]))?;
    }
    finish(tx, old, changed, &check)
}
fn prepare_save(
    tx: &Transaction<'_>,
    proof: &Proof,
    revision: &str,
    position: &Position,
) -> Result<(i64, bool), String> {
    let expected = expected(revision)?;
    let old = current(tx)?;
    if old != expected {
        return Err("archive-bookmark-revision-stale".into());
    }
    archive_catalog::verify_live(tx, &proof.reference, &proof.file)?;
    let saved = stored(tx, &proof.reference)?;
    let changed = saved
        .as_ref()
        .is_none_or(|s| !matches(s, proof) || !same_timeline(&s.4, position));
    Ok((old, changed))
}
/// Under the caller's retained writer/root/session lease, acknowledge only a
/// fully validated unchanged timeline. A newer observation timestamp alone is
/// not a mutation. Changed timelines release this snapshot before backup, then
/// must pass save's fresh CAS and exact-file checks in a new transaction.
pub(crate) fn preflight_save(
    c: &Connection,
    proof: &Proof,
    revision: &str,
    position: &Position,
    check: &impl Fn() -> Result<(), String>,
) -> Result<Option<Receipt>, String> {
    check()?;
    validate_input(revision, position)?;
    let tx = sql(c.unchecked_transaction())?;
    let (old, changed) = prepare_save(&tx, proof, revision, position)?;
    if changed {
        sql(tx.rollback())?;
        Ok(None)
    } else {
        validate(&tx)?;
        check()?;
        sql(tx.commit())?;
        Ok(Some(Receipt {
            schema_version: 1,
            committed: true,
            revision: old.to_string(),
            changed: false,
        }))
    }
}
/// Explicit Archive-only reset. The eventual library-clear owner must call this
/// within its SAME transaction using clear_in_transaction, not chain two commits.
#[cfg(test)]
pub(crate) fn clear_in_transaction(
    tx: &Transaction<'_>,
    revision: &str,
    check: &impl Fn() -> Result<(), String>,
) -> Result<(i64, bool), String> {
    check()?;
    let old = current(tx)?;
    if old != expected(revision)? {
        return Err("archive-bookmark-revision-stale".into());
    }
    let changed = sql(tx.execute("DELETE FROM archive_bookmark_v1", []))? > 0;
    let next = if changed {
        old.checked_add(1)
            .ok_or("archive-bookmark-revision-exhausted")?
    } else {
        old
    };
    if changed {
        sql(tx.execute(
            "UPDATE archive_bookmark_meta_v1 SET revision=?1 WHERE singleton=1",
            [next],
        ))?;
    }
    check()?;
    Ok((next, changed))
}
/// Archive library Clear already owns its catalog CAS and transaction. Read the
/// separate bookmark revision inside that exact writer snapshot, then reset it
/// without requiring a second independently committing command.
pub(crate) fn reset_library_in_transaction(
    tx: &Transaction<'_>,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
    check()?;
    let old = current(tx)?;
    sql(tx.execute("DELETE FROM archive_bookmark_v1", []))?;
    // Even an empty explicit reset revokes every earlier captured bookmark CAS.
    let next = old
        .checked_add(1)
        .ok_or("archive-bookmark-revision-exhausted")?;
    sql(tx.execute(
        "UPDATE archive_bookmark_meta_v1 SET revision=?1 WHERE singleton=1 AND revision=?2",
        params![next, old],
    ))?;
    check()?;
    Ok(())
}
#[cfg(test)]
pub(crate) fn clear(
    c: &mut Connection,
    revision: &str,
    check: impl Fn() -> Result<(), String>,
) -> Result<Receipt, String> {
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let (revision, changed) = clear_in_transaction(&tx, revision, &check)?;
    validate(&tx)?;
    crate::archive_library_store::finalize(&tx, false, &mut || check())?;
    check()?;
    sql(tx.commit())?;
    Ok(Receipt {
        schema_version: 1,
        committed: true,
        revision: revision.to_string(),
        changed,
    })
}

#[cfg(test)]
mod tests {
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
            !encoded.contains("item")
                && !encoded.contains("episode.mp4")
                && !encoded.contains(HASH)
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
}
