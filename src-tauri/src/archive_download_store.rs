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

//! Small verified SQLite download namespace. Media bytes never enter SQLite.
//! Caller retains the main Store/root lease and serialized writer through local
//! SQL/FS operations; no lease is held across transfer/network awaits.
use crate::{archive_bookmarks, archive_catalog, storage::refuse_link};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
};

const DB: &str = "downloads.sqlite3";
const BACKUP: &str = "downloads.sqlite3.backup";
const MAX_ROWS: usize = 256;
const MAX_METADATA: usize = 1024 * 1024;
const MAX_DB: u64 = 16 * 1024 * 1024;
const MAX_FILE: u64 = 64 * 1024 * 1024 * 1024;
const ERR: &str = "archive-download-storage-failed";
pub(crate) const REPAIR: &str = "archive-download-repair-required";
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| {
        if matches!(
            &e,
            rusqlite::Error::InvalidColumnType(..)
                | rusqlite::Error::FromSqlConversionFailure(..)
                | rusqlite::Error::QueryReturnedNoRows
        ) {
            return "archive-download-metadata-invalid".into();
        }
        match e.sqlite_error_code() {
            Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
                "archive-download-storage-busy".into()
            }
            Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase) => {
                "archive-download-integrity-failed".into()
            }
            Some(rusqlite::ErrorCode::DiskFull) => "archive-download-disk-full".into(),
            _ => ERR.into(),
        }
    })
}

fn hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn size(s: &str) -> Option<u64> {
    s.parse::<u64>()
        .ok()
        .filter(|n| *n > 0 && *n <= MAX_FILE && n.to_string() == s)
}
fn revision(s: &str) -> Result<i64, String> {
    archive_catalog::revision(s).map_err(|_| "archive-download-revision-invalid".into())
}

pub(crate) struct Capture {
    pub file: archive_catalog::ResolvedFile,
    pub file_ref: String,
    pub title_ref: String,
    pub title: String,
    pub file_title: String,
}
pub(crate) struct CompletedBody {
    pub download_ref: String,
    pub managed_name: String,
    pub size_bytes: String,
    pub local_sha256: String,
    pub provider_sha1_verified: bool,
    pub completed_ms: i64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub download_ref: String,
    pub file_ref: String,
    pub title_ref: String,
    pub title: String,
    pub file_title: String,
    pub file_name: String,
    pub size_bytes: String,
    pub completed_ms: i64,
    pub integrity: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleanup_pending: Option<bool>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct List {
    pub schema_version: u8,
    pub revision: String,
    pub entries: Vec<Entry>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    pub schema_version: u8,
    pub committed: bool,
    pub revision: String,
    pub changed: bool,
    pub entry: Entry,
}
pub(crate) struct RemoveCommit {
    pub schema_version: u8,
    pub committed: bool,
    pub revision: String,
    pub changed: bool,
    pub download_ref: String,
    pub managed_name: String,
    pub directory: PathBuf,
}
impl DownloadStore {
    pub(crate) fn open(
        directory: &Path,
        create: bool,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<Option<Self>, String> {
        refuse_link(directory)?;
        if !directory.exists() {
            if !create {
                return Ok(None);
            }
            std::fs::create_dir(directory).map_err(|_| ERR)?;
            sync_download_directory(directory.parent().ok_or(ERR)?)?;
        }
        if !directory.is_dir() {
            return Err(ERR.into());
        }
        let store = Self {
            directory: directory.into(),
        };
        let main = directory.join(DB);
        let backup = directory.join(BACKUP);
        let read = |p: &Path| -> Result<Option<Snapshot>, String> {
            if !p.exists() {
                return Ok(None);
            }
            // Do not let SQLite inspect/recover an unrecognizable database
            // while an unresolved journal may belong to that exact copy.
            // A valid SQLite header retains SQLite's ordinary hot-journal recovery.
            if ["-journal", "-wal", "-shm"].iter().any(|suffix| {
                directory
                    .join(format!(
                        "{}{}",
                        p.file_name().unwrap().to_string_lossy(),
                        suffix
                    ))
                    .exists()
            }) {
                refuse_link(p)?;
                let mut header = [0u8; 16];
                let valid = File::open(p)
                    .and_then(|mut f| f.read_exact(&mut header))
                    .is_ok()
                    && &header == b"SQLite format 3\0";
                if !valid {
                    return Err(REPAIR.into());
                }
            }
            let c = connect(p, false)?;
            snapshot(&c, true).map(Some)
        };
        let a = read(&main);
        let b = read(&backup);
        let recoverable = |e: &str| {
            matches!(
                e,
                "archive-download-integrity-failed"
                    | "archive-download-metadata-invalid"
                    | "archive-download-metadata-limit"
            )
        };
        for result in [&a, &b] {
            if let Err(error) = result {
                if !recoverable(error) {
                    return Err(error.clone());
                }
            }
        }
        if let (Ok(Some(x)), Ok(Some(y))) = (&a, &b) {
            if x.namespace != y.namespace {
                return Err(REPAIR.into());
            }
        }
        match (&a, &b) {
            (Ok(None), Ok(None)) => {
                if !create {
                    return Ok(None);
                }
                check()?;
                let temp = tempfile::NamedTempFile::new_in(directory).map_err(|_| ERR)?;
                {
                    let c = connect(temp.path(), true)?;
                    install(&c)?;
                }
                publish(temp, &main)?;
                let c = connect(&main, false)?;
                mirror(&c, &backup, check)?;
            }
            (Ok(Some(x)), Ok(Some(y)))
                if x.revision == y.revision && x.bookmark_revision == y.bookmark_revision =>
            {
                if x != y {
                    return Err(REPAIR.into());
                }
            }
            (Ok(Some(x)), Ok(Some(y))) => {
                // Both namespace counters must move monotonically together; crossing
                // histories cannot establish a trustworthy latest committed snapshot.
                if x.revision >= y.revision && x.bookmark_revision >= y.bookmark_revision {
                    let c = connect(&main, false)?;
                    mirror(&c, &backup, check)?;
                } else if y.revision >= x.revision && y.bookmark_revision >= x.bookmark_revision {
                    let c = connect(&backup, false)?;
                    mirror(&c, &main, check)?;
                } else {
                    return Err(REPAIR.into());
                }
            }
            (Ok(Some(_)), _) => {
                let c = connect(&main, false)?;
                mirror(&c, &backup, check)?;
            }
            (_, Ok(Some(_))) => {
                if ["-journal", "-wal", "-shm"]
                    .iter()
                    .any(|s| directory.join(format!("{DB}{s}")).exists())
                {
                    return Err(REPAIR.into());
                }
                let c = connect(&backup, false)?;
                mirror(&c, &main, check)?;
            }
            _ => return Err(REPAIR.into()),
        }
        check()?;
        Ok(Some(store))
    }
    fn read(&self) -> Result<Snapshot, String> {
        snapshot(&connect(&self.directory.join(DB), false)?, false)
    }
    fn wire(&self, s: &Saved) -> Entry {
        Entry {
            download_ref: s.download_ref.clone(),
            file_ref: s.file_ref.clone(),
            title_ref: s.title_ref.clone(),
            title: s.title.clone(),
            file_title: s.file_title.clone(),
            file_name: s.file_name.clone(),
            size_bytes: s.size_bytes.clone(),
            completed_ms: s.completed_ms,
            integrity: if s.provider_sha1_verified {
                "sha1-verified"
            } else {
                "size-verified"
            }
            .into(),
            cleanup_pending: (s.tombstoned && self.directory.join(&s.managed_name).exists())
                .then_some(true),
            available: !s.tombstoned
                && ordinary(
                    &self.directory.join(&s.managed_name),
                    size(&s.size_bytes).unwrap(),
                )
                .is_ok(),
        }
    }
    pub(crate) fn list(&self) -> Result<List, String> {
        let s = self.read()?;
        Ok(List {
            schema_version: 1,
            revision: s.revision.to_string(),
            entries: s
                .entries
                .iter()
                .filter(|e| !e.tombstoned || self.directory.join(&e.managed_name).exists())
                .map(|e| self.wire(e))
                .collect(),
        })
    }
    fn commit(
        &self,
        mut s: Snapshot,
        expected: (i64, i64),
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<Snapshot, String> {
        check()?;
        let mut c = connect(&self.directory.join(DB), false)?;
        let old = snapshot(&c, true)?;
        if (old.revision, old.bookmark_revision) != expected || old.namespace != s.namespace {
            return Err("archive-download-revision-stale".into());
        }
        mirror(&c, &self.directory.join(BACKUP), check)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let fresh: (i64, i64, String) = sql(tx.query_row(
            "SELECT revision,bookmark_revision,digest FROM download_meta WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ))?;
        if fresh != (old.revision, old.bookmark_revision, old.digest) {
            return Err("archive-download-revision-stale".into());
        }
        s.digest = digest(
            &s.namespace,
            s.revision,
            s.bookmark_revision,
            &s.entries,
            &s.bookmarks,
        )?;
        sql(tx.execute("DELETE FROM download_entry", []))?;
        sql(tx.execute("DELETE FROM download_bookmark", []))?;
        for e in &s.entries {
            let record = serde_json::to_string(e).map_err(|_| ERR)?;
            sql(tx.execute(
                "INSERT INTO download_entry VALUES(?1,?2)",
                params![e.download_ref, record],
            ))?;
        }
        for b in &s.bookmarks {
            let record = serde_json::to_string(b).map_err(|_| ERR)?;
            sql(tx.execute(
                "INSERT INTO download_bookmark VALUES(?1,?2)",
                params![b.identity, record],
            ))?;
        }
        sql(tx.execute(
            "UPDATE download_meta SET revision=?1,bookmark_revision=?2,digest=?3 WHERE singleton=1",
            params![s.revision, s.bookmark_revision, s.digest],
        ))?;
        // Validate exact pending rows, namespace digest and all bounds inside
        // this transaction before its irreversible commit.
        read_snapshot(&tx, false)?;
        check()?;
        sql(tx.commit())?;
        // From this point a failure is uncertain, never cancellation/rollback. Do
        // not consult the command abort signal after an actual commit.
        mirror(&c, &self.directory.join(BACKUP), &mut || Ok(())).map_err(|_| REPAIR.to_string())?;
        Ok(s)
    }
    pub(crate) fn complete(
        &self,
        capture: &Capture,
        body: &CompletedBody,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<Receipt, String> {
        check()?;
        let mut s = self.read()?;
        let saved = Saved {
            download_ref: body.download_ref.clone(),
            file_ref: capture.file_ref.clone(),
            title_ref: capture.title_ref.clone(),
            title: capture.title.clone(),
            file_title: capture.file_title.clone(),
            item_id: capture.file.item_id.clone(),
            file_name: capture.file.file_name.clone(),
            size_bytes: body.size_bytes.clone(),
            provider_sha1: capture.file.sha1.clone(),
            local_sha256: body.local_sha256.clone(),
            provider_sha1_verified: body.provider_sha1_verified,
            completed_ms: body.completed_ms,
            managed_name: body.managed_name.clone(),
            tombstoned: false,
        };
        if !saved_valid(&saved) || saved.size_bytes != capture.file.size_bytes {
            return Err("archive-download-completion-invalid".into());
        }
        ordinary(
            &self.directory.join(&saved.managed_name),
            size(&saved.size_bytes).unwrap(),
        )?;
        if let Some(old) = s
            .entries
            .iter()
            .find(|e| e.download_ref == saved.download_ref)
        {
            if old != &saved {
                return Err("archive-download-conflict".into());
            }
            check()?;
            return Ok(Receipt {
                schema_version: 1,
                committed: true,
                revision: s.revision.to_string(),
                changed: false,
                entry: self.wire(old),
            });
        }
        s.entries
            .retain(|e| !e.tombstoned || self.directory.join(&e.managed_name).exists());
        s.entries.push(saved.clone());
        s.entries
            .sort_by(|a, b| a.download_ref.cmp(&b.download_ref));
        let old = (s.revision, s.bookmark_revision);
        s.revision = old
            .0
            .checked_add(1)
            .ok_or("archive-download-revision-exhausted")?;
        // commit expects the admitted revision, while the new counter is written
        // only inside its fenced transaction.
        let committed = self.commit(s, old, check)?;
        Ok(Receipt {
            schema_version: 1,
            committed: true,
            revision: committed.revision.to_string(),
            changed: true,
            entry: self.wire(&saved),
        })
    }

    pub(crate) fn preflight(&self, capture: &Capture) -> Result<(), String> {
        let s = self.read()?;
        if s.entries.iter().any(|e| {
            !e.tombstoned
                && e.file_ref == capture.file_ref
                && e.size_bytes == capture.file.size_bytes
                && e.provider_sha1 == capture.file.sha1
                && self.wire(e).available
        }) {
            return Err("archive-download-already-saved".into());
        }
        if s.entries
            .iter()
            .filter(|e| !e.tombstoned || self.directory.join(&e.managed_name).exists())
            .count()
            >= MAX_ROWS
        {
            return Err("archive-download-limit".into());
        }
        Ok(())
    }
    pub(crate) fn remove(
        &self,
        reference: &str,
        expected: &str,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<RemoveCommit, String> {
        if !hex(reference, 64) {
            return Err("archive-download-request-invalid".into());
        }
        let mut s = self.read()?;
        if s.revision != revision(expected)? {
            return Err("archive-download-revision-stale".into());
        }
        let old = (s.revision, s.bookmark_revision);
        let e = s
            .entries
            .iter_mut()
            .find(|e| e.download_ref == reference)
            .ok_or("archive-download-unavailable")?;
        let changed = !e.tombstoned;
        let managed_name = e.managed_name.clone();
        e.tombstoned = true;
        if changed {
            s.revision = s
                .revision
                .checked_add(1)
                .ok_or("archive-download-revision-exhausted")?;
            s = self.commit(s, old, check)?;
        } else {
            check()?;
        }
        Ok(RemoveCommit {
            schema_version: 1,
            committed: true,
            revision: s.revision.to_string(),
            changed,
            download_ref: reference.into(),
            managed_name,
            directory: self.directory.clone(),
        })
    }
}
#[derive(Clone)]
pub(crate) struct LocalProof {
    saved: Saved,
}

fn ordinary(path: &Path, expected: u64) -> Result<std::fs::Metadata, String> {
    refuse_link(path)?;
    let m = std::fs::symlink_metadata(path).map_err(|_| "archive-download-file-missing")?;
    if !m.is_file() || m.len() != expected {
        return Err("archive-download-file-changed".into());
    }
    Ok(m)
}

pub(crate) fn verify_local_live(directory: &Path, proof: &LocalProof) -> Result<(), String> {
    DownloadStore {
        directory: directory.into(),
    }
    .verify(proof)
}

#[cfg(test)]
#[path = "archive_download_store_tests.rs"]
mod tests;

#[cfg(test)]
pub(crate) use tests::{local_fixture, local_proxy_fixture};

// This module's parts, by area, are in archive_download_store/.
mod snapshot;
pub(crate) use snapshot::*;
mod local_files;
pub(crate) use local_files::*;
