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
#[path = "archive_bookmarks_tests.rs"]
mod tests;
