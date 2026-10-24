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
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Saved {
    download_ref: String,
    file_ref: String,
    title_ref: String,
    title: String,
    file_title: String,
    item_id: String,
    file_name: String,
    size_bytes: String,
    provider_sha1: Option<String>,
    local_sha256: String,
    provider_sha1_verified: bool,
    completed_ms: i64,
    managed_name: String,
    tombstoned: bool,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct LocalBookmark {
    identity: String,
    item_id: String,
    file_name: String,
    size_bytes: String,
    local_sha256: String,
    position: archive_bookmarks::Position,
}
#[derive(Clone, PartialEq)]
struct Snapshot {
    namespace: String,
    revision: i64,
    bookmark_revision: i64,
    digest: String,
    entries: Vec<Saved>,
    bookmarks: Vec<LocalBookmark>,
}
fn saved_valid(s: &Saved) -> bool {
    hex(&s.download_ref, 64)
        && hex(&s.file_ref, 64)
        && hex(&s.title_ref, 64)
        && hex(&s.local_sha256, 64)
        && s.managed_name == format!("{}.mp4", s.download_ref)
        && size(&s.size_bytes).is_some()
        && archive_catalog::text(&s.title, 1024)
        && archive_catalog::text(&s.file_title, 1024)
        && archive_catalog::text(&s.item_id, 100)
        && s.item_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && archive_catalog::text(&s.file_name, 1024)
        && !s.file_name.starts_with('/')
        && !s.file_name.contains('\\')
        && !s
            .file_name
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
        && archive_catalog::opaque(&["archive-file-v1", &s.item_id, &s.file_name]) == s.file_ref
        && archive_catalog::opaque(&["archive-item-v1", &s.item_id]) == s.title_ref
        && s.provider_sha1.as_deref().is_none_or(|v| hex(v, 40))
        && s.provider_sha1_verified == s.provider_sha1.is_some()
        && (0..=9_007_199_254_740_991).contains(&s.completed_ms)
}
fn local_identity(item: &str, name: &str, size: &str, sha: &str) -> String {
    archive_catalog::opaque(&["archive-local-bookmark-v1", item, name, size, sha])
}
fn digest(
    namespace: &str,
    rev: i64,
    br: i64,
    entries: &[Saved],
    bookmarks: &[LocalBookmark],
) -> Result<String, String> {
    let bytes =
        serde_json::to_vec(&(1u8, namespace, rev, br, entries, bookmarks)).map_err(|_| ERR)?;
    if bytes.len() > 6 * 1024 * 1024 {
        return Err("archive-download-metadata-limit".into());
    }
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn connect(path: &Path, create: bool) -> Result<Connection, String> {
    refuse_link(path)?;
    if path.exists() {
        if !path.is_file() {
            return Err(ERR.into());
        }
        if std::fs::metadata(path).map_err(|_| ERR)?.len() > MAX_DB {
            return Err("archive-download-metadata-limit".into());
        }
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | if create {
            OpenFlags::SQLITE_OPEN_CREATE
        } else {
            OpenFlags::empty()
        };
    let c = sql(Connection::open_with_flags(path, flags))?;
    sql(c.busy_timeout(std::time::Duration::from_secs(2)))?;
    sql(c.execute_batch(
        "PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;PRAGMA synchronous=EXTRA;PRAGMA cache_size=-2048;PRAGMA max_page_count=4096;",
    ))?;
    Ok(c)
}
fn snapshot(c: &Connection, full: bool) -> Result<Snapshot, String> {
    let tx = sql(c.unchecked_transaction())?;
    let value = read_snapshot(&tx, full)?;
    sql(tx.commit())?;
    Ok(value)
}
fn read_snapshot(tx: &Connection, full: bool) -> Result<Snapshot, String> {
    if sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? != 1 {
        return Err("archive-download-schema-unsupported".into());
    }
    if full
        && (sql(tx.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)))? != "ok"
            || sql(
                tx.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get::<_, i64>(0)
                }),
            )? != 0)
    {
        return Err("archive-download-integrity-failed".into());
    }
    if sql(tx.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('download_meta','download_entry','download_bookmark')",
        [],
        |r| r.get::<_, i64>(0),
    ))? != 3
    {
        return Err("archive-download-integrity-failed".into());
    }
    for (table, expected) in [
        (
            "download_meta",
            vec![
                "singleton",
                "namespace",
                "revision",
                "bookmark_revision",
                "digest",
            ],
        ),
        ("download_entry", vec!["identity", "record"]),
        ("download_bookmark", vec!["identity", "record"]),
    ] {
        let mut statement = sql(tx.prepare(&format!("PRAGMA table_info({table})")))?;
        let names = sql(statement.query_map([], |r| r.get::<_, String>(1)))?;
        if sql(names.collect::<rusqlite::Result<Vec<_>>>())? != expected {
            return Err("archive-download-metadata-invalid".into());
        }
    }
    let page_size: i64 = sql(tx.query_row("PRAGMA page_size", [], |r| r.get(0)))?;
    let pages: i64 = sql(tx.query_row("PRAGMA page_count", [], |r| r.get(0)))?;
    if page_size != 4096
        || pages < 0
        || pages
            .checked_mul(page_size)
            .is_none_or(|n| n as u64 > MAX_DB)
    {
        return Err("archive-download-metadata-limit".into());
    }
    let (namespace, rev, br, stored): (String, i64, i64, String) = sql(tx.query_row(
        "SELECT namespace,revision,bookmark_revision,digest FROM download_meta WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ))?;
    if !hex(&namespace, 64)
        || rev < 0
        || br < 0
        || !hex(&stored, 64)
        || sql(tx.query_row("SELECT count(*) FROM download_meta", [], |r| {
            r.get::<_, i64>(0)
        }))? != 1
    {
        return Err("archive-download-metadata-invalid".into());
    }
    let read_rows = |table: &str, max: usize, limit: usize| -> Result<Vec<String>, String> {
        let mut st = sql(tx.prepare(&format!(
            "SELECT length(CAST(identity AS BLOB)),length(CAST(record AS BLOB)),identity,record FROM {table} ORDER BY identity"
        )))?;
        let mut rows = sql(st.query([]))?;
        let mut out = Vec::new();
        let mut bytes = 0;
        while let Some(r) = sql(rows.next())? {
            let identity_bytes: i64 = sql(r.get(0))?;
            let record_bytes: i64 = sql(r.get(1))?;
            let row_limit = if table == "download_entry" {
                8192
            } else {
                2048
            };
            if identity_bytes != 64
                || record_bytes < 1
                || record_bytes > row_limit
                || out.len() >= max
                || record_bytes as usize > limit - bytes
            {
                return Err("archive-download-metadata-limit".into());
            }
            let id: String = sql(r.get(2))?;
            let text: String = sql(r.get(3))?;
            let value: serde_json::Value =
                serde_json::from_str(&text).map_err(|_| "archive-download-metadata-invalid")?;
            let field = if table == "download_entry" {
                "download_ref"
            } else {
                "identity"
            };
            if value.get(field).and_then(serde_json::Value::as_str) != Some(id.as_str()) {
                return Err("archive-download-metadata-invalid".into());
            }
            bytes += text.len();
            if out.len() >= max || bytes > limit {
                return Err("archive-download-metadata-limit".into());
            }
            out.push(text);
        }
        Ok(out)
    };
    let entries: Vec<Saved> = read_rows("download_entry", MAX_ROWS, MAX_METADATA)?
        .into_iter()
        .map(|s| serde_json::from_str(&s).map_err(|_| "archive-download-metadata-invalid".into()))
        .collect::<Result<_, String>>()?;
    if entries.iter().any(|s| !saved_valid(s)) {
        return Err("archive-download-metadata-invalid".into());
    }
    let bookmarks: Vec<LocalBookmark> = read_rows("download_bookmark", 10_000, 4 * 1024 * 1024)?
        .into_iter()
        .map(|s| serde_json::from_str(&s).map_err(|_| "archive-download-metadata-invalid".into()))
        .collect::<Result<_, String>>()?;
    for b in &bookmarks {
        if !archive_catalog::text(&b.item_id, 100)
            || !archive_catalog::text(&b.file_name, 1024)
            || b.file_name.starts_with('/')
            || b.file_name.contains('\\')
            || b.file_name
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || !hex(&b.local_sha256, 64)
            || size(&b.size_bytes).is_none()
            || b.identity
                != local_identity(&b.item_id, &b.file_name, &b.size_bytes, &b.local_sha256)
        {
            return Err("archive-download-metadata-invalid".into());
        }
        archive_bookmarks::validate_input("0", &b.position)
            .map_err(|_| "archive-download-metadata-invalid")?;
    }
    if digest(&namespace, rev, br, &entries, &bookmarks)? != stored {
        return Err("archive-download-integrity-failed".into());
    }
    Ok(Snapshot {
        namespace,
        revision: rev,
        bookmark_revision: br,
        digest: stored,
        entries,
        bookmarks,
    })
}
pub(crate) fn sync_download_directory(path: &Path) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        File::open(path)
            .and_then(|f| f.sync_all())
            .map_err(|_| ERR)?;
    }
    #[cfg(windows)]
    {
        let _ = path;
    }
    Ok(())
}
fn publish(temp: tempfile::NamedTempFile, target: &Path) -> Result<(), String> {
    refuse_link(target)?;
    temp.as_file().sync_all().map_err(|_| ERR)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let (f, path) = temp.into_parts();
        drop(f);
        let from: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(ERR.into());
        }
    }
    #[cfg(not(windows))]
    {
        temp.persist(target).map_err(|_| ERR)?;
    }
    sync_download_directory(target.parent().ok_or(ERR)?)
}
fn mirror(
    source: &Connection,
    target: &Path,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<Snapshot, String> {
    check()?;
    let expected = snapshot(source, true)?;
    let temp = tempfile::NamedTempFile::new_in(target.parent().ok_or(ERR)?).map_err(|_| ERR)?;
    {
        let mut dest = connect(temp.path(), true)?;
        crate::storage_transaction::copy_sqlite_snapshot_checked(source, &mut dest, &mut *check)?;
        if snapshot(&dest, true)? != expected {
            return Err(ERR.into());
        }
    }
    check()?;
    publish(temp, target)?;
    let installed = connect(target, false)?;
    if snapshot(&installed, true)? != expected {
        return Err(ERR.into());
    }
    Ok(expected)
}
fn install(c: &Connection) -> Result<(), String> {
    sql(c.execute_batch("PRAGMA page_size=4096;PRAGMA journal_mode=DELETE;CREATE TABLE download_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),namespace TEXT NOT NULL,revision INTEGER NOT NULL,bookmark_revision INTEGER NOT NULL,digest TEXT NOT NULL);CREATE TABLE download_entry(identity TEXT PRIMARY KEY CHECK(length(identity)=64),record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=8192));CREATE TABLE download_bookmark(identity TEXT PRIMARY KEY CHECK(length(identity)=64),record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=2048));PRAGMA user_version=1;"))?;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| ERR)?;
    let namespace = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let d = digest(&namespace, 0, 0, &[], &[])?;
    sql(c.execute(
        "INSERT INTO download_meta VALUES(1,?1,0,0,?2)",
        params![namespace, d],
    ))?;
    Ok(())
}
pub(crate) struct DownloadStore {
    directory: PathBuf,
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
    pub(crate) fn local(
        &self,
        reference: &str,
        expected: &str,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<LocalBody, String> {
        check()?;
        let s = self.read()?;
        if s.revision != revision(expected)? {
            return Err("archive-download-revision-stale".into());
        }
        let saved = s
            .entries
            .into_iter()
            .find(|e| e.download_ref == reference && !e.tombstoned)
            .ok_or("archive-download-unavailable")?;
        let path = self.directory.join(&saved.managed_name);
        let length = size(&saved.size_bytes).ok_or(ERR)?;
        let before = ordinary(&path, length)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1);
        }
        let mut file = options
            .open(&path)
            .map_err(|_| "archive-download-file-unavailable")?;
        let opened = file.metadata().map_err(|_| ERR)?;
        if !same_file(&before, &opened) {
            return Err("archive-download-file-changed".into());
        }
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut count = 0u64;
        let mut prefix = [0u8; 8];
        loop {
            check()?;
            let n = file
                .read(&mut buffer)
                .map_err(|_| "archive-download-file-read-failed")?;
            if n == 0 {
                break;
            }
            if count < 8 {
                let start = count as usize;
                let available = n.min(8 - start);
                prefix[start..start + available].copy_from_slice(&buffer[..available]);
            }
            count = count.checked_add(n as u64).ok_or(ERR)?;
            if count > length {
                return Err("archive-download-file-changed".into());
            }
            hash.update(&buffer[..n]);
        }
        if count != length
            || format!("{:x}", hash.finalize()) != saved.local_sha256
            || &prefix[4..8] != b"ftyp"
        {
            return Err("archive-download-file-corrupt".into());
        }
        if !same_file(&opened, &file.metadata().map_err(|_| ERR)?)
            || !same_file(&opened, &ordinary(&path, length)?)
        {
            return Err("archive-download-file-changed".into());
        }
        file.seek(SeekFrom::Start(0)).map_err(|_| ERR)?;
        check()?;
        self.verify(&LocalProof {
            saved: saved.clone(),
        })?;
        Ok(LocalBody {
            entry: self.wire(&saved),
            proof: LocalProof { saved },
            file: Arc::new(file),
            metadata: opened,
            #[cfg(test)]
            before_read: None,
        })
    }
    pub(crate) fn verify(&self, proof: &LocalProof) -> Result<(), String> {
        // Fresh selected-row authority only; full namespace inspection/digest occurs
        // at admission and all writes, never per64KiB playback read.
        let c = connect(&self.directory.join(DB), false)?;
        let raw: Option<String> = sql(c
            .query_row(
                "SELECT record FROM download_entry WHERE identity=?1",
                [&proof.saved.download_ref],
                |r| r.get(0),
            )
            .optional())?;
        let live: Saved =
            serde_json::from_str(&raw.ok_or("archive-download-unavailable")?).map_err(|_| ERR)?;
        if live != proof.saved || live.tombstoned {
            return Err("archive-download-file-changed".into());
        }
        Ok(())
    }
    pub(crate) fn read_bookmark(
        &self,
        proof: &LocalProof,
    ) -> Result<archive_bookmarks::ReadReceipt, String> {
        self.verify(proof)?;
        let s = self.read()?;
        let id = proof.identity();
        Ok(archive_bookmarks::ReadReceipt {
            schema_version: 1,
            revision: s.bookmark_revision.to_string(),
            position: s
                .bookmarks
                .into_iter()
                .find(|b| b.identity == id)
                .map(|b| b.position),
        })
    }
    pub(crate) fn save_bookmark(
        &self,
        proof: &LocalProof,
        expected: &str,
        position: &archive_bookmarks::Position,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<archive_bookmarks::Receipt, String> {
        archive_bookmarks::validate_input(expected, position)?;
        check()?;
        self.verify(proof)?;
        let mut s = self.read()?;
        if s.bookmark_revision != revision(expected)? {
            return Err("archive-bookmark-revision-stale".into());
        }
        let identity = proof.identity();
        let old = (s.revision, s.bookmark_revision);
        if s.bookmarks.iter().any(|b| {
            b.identity == identity
                && b.position.position_ms == position.position_ms
                && b.position.duration_ms == position.duration_ms
                && b.position.completed == position.completed
        }) {
            check()?;
            return Ok(archive_bookmarks::Receipt {
                schema_version: 1,
                committed: true,
                revision: s.bookmark_revision.to_string(),
                changed: false,
            });
        }
        s.bookmarks.retain(|b| b.identity != identity);
        s.bookmarks.push(LocalBookmark {
            identity,
            item_id: proof.saved.item_id.clone(),
            file_name: proof.saved.file_name.clone(),
            size_bytes: proof.saved.size_bytes.clone(),
            local_sha256: proof.saved.local_sha256.clone(),
            position: position.clone(),
        });
        s.bookmarks.sort_by(|a, b| a.identity.cmp(&b.identity));
        s.bookmark_revision = s
            .bookmark_revision
            .checked_add(1)
            .ok_or("archive-bookmark-revision-exhausted")?;
        let s = self.commit(s, old, check)?;
        Ok(archive_bookmarks::Receipt {
            schema_version: 1,
            committed: true,
            revision: s.bookmark_revision.to_string(),
            changed: true,
        })
    }
}
#[derive(Clone)]
pub(crate) struct LocalProof {
    saved: Saved,
}
impl LocalProof {
    pub(crate) fn identity(&self) -> String {
        local_identity(
            &self.saved.item_id,
            &self.saved.file_name,
            &self.saved.size_bytes,
            &self.saved.local_sha256,
        )
    }
    #[cfg(test)]
    pub(crate) fn download_ref(&self) -> &str {
        &self.saved.download_ref
    }
    pub(crate) fn file(&self) -> archive_catalog::ResolvedFile {
        archive_catalog::ResolvedFile {
            item_id: self.saved.item_id.clone(),
            file_name: self.saved.file_name.clone(),
            size_bytes: self.saved.size_bytes.clone(),
            sha1: self.saved.provider_sha1.clone(),
            servers: vec![],
            duration_seconds: None,
            provider_index: None,
            public: None,
        }
    }
}
pub(crate) struct LocalBody {
    pub entry: Entry,
    pub proof: LocalProof,
    file: Arc<File>,
    metadata: std::fs::Metadata,
    #[cfg(test)]
    pub(crate) before_read: Option<Arc<dyn Fn() + Send + Sync>>,
}
impl LocalBody {
    pub(crate) fn size(&self) -> u64 {
        self.metadata.len()
    }
    pub(crate) fn read_chunk(&self, offset: u64, length: usize) -> Result<Vec<u8>, String> {
        #[cfg(test)]
        if let Some(before) = &self.before_read {
            before();
        }
        if length > 64 * 1024
            || offset
                .checked_add(length as u64)
                .is_none_or(|end| end > self.size())
            || !same_file(&self.metadata, &self.file.metadata().map_err(|_| ERR)?)
        {
            return Err("archive-download-file-changed".into());
        }
        let mut bytes = vec![0u8; length];
        let mut read = 0;
        while read < length {
            #[cfg(windows)]
            let n = {
                use std::os::windows::fs::FileExt;
                self.file
                    .seek_read(&mut bytes[read..], offset + read as u64)
            };
            #[cfg(unix)]
            let n = {
                use std::os::unix::fs::FileExt;
                self.file.read_at(&mut bytes[read..], offset + read as u64)
            };
            let n = n.map_err(|_| "archive-download-file-read-failed")?;
            if n == 0 {
                return Err("archive-download-file-changed".into());
            }
            read += n;
        }
        Ok(bytes)
    }
}
fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    if !a.is_file() || !b.is_file() || a.len() != b.len() || a.modified().ok() != b.modified().ok()
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if a.dev() != b.dev() || a.ino() != b.ino() {
            return false;
        }
    }
    true
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
