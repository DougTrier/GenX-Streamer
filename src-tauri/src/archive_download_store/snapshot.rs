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

//! The download store's saved state: reading its snapshot, and publishing,
//! mirroring and installing it.

use super::*;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Saved {
    pub(super) download_ref: String,
    pub(super) file_ref: String,
    pub(super) title_ref: String,
    pub(super) title: String,
    pub(super) file_title: String,
    pub(super) item_id: String,
    pub(super) file_name: String,
    pub(super) size_bytes: String,
    pub(super) provider_sha1: Option<String>,
    pub(super) local_sha256: String,
    pub(super) provider_sha1_verified: bool,
    pub(super) completed_ms: i64,
    pub(super) managed_name: String,
    pub(super) tombstoned: bool,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct LocalBookmark {
    pub(super) identity: String,
    pub(super) item_id: String,
    pub(super) file_name: String,
    pub(super) size_bytes: String,
    pub(super) local_sha256: String,
    pub(super) position: archive_bookmarks::Position,
}

#[derive(Clone, PartialEq)]
pub(super) struct Snapshot {
    pub(super) namespace: String,
    pub(super) revision: i64,
    pub(super) bookmark_revision: i64,
    pub(super) digest: String,
    pub(super) entries: Vec<Saved>,
    pub(super) bookmarks: Vec<LocalBookmark>,
}

pub(super) fn saved_valid(s: &Saved) -> bool {
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

pub(super) fn local_identity(item: &str, name: &str, size: &str, sha: &str) -> String {
    archive_catalog::opaque(&["archive-local-bookmark-v1", item, name, size, sha])
}

pub(super) fn digest(
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

pub(super) fn connect(path: &Path, create: bool) -> Result<Connection, String> {
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

pub(super) fn snapshot(c: &Connection, full: bool) -> Result<Snapshot, String> {
    let tx = sql(c.unchecked_transaction())?;
    let value = read_snapshot(&tx, full)?;
    sql(tx.commit())?;
    Ok(value)
}

pub(super) fn read_snapshot(tx: &Connection, full: bool) -> Result<Snapshot, String> {
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

pub(super) fn publish(temp: tempfile::NamedTempFile, target: &Path) -> Result<(), String> {
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

pub(super) fn mirror(
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

pub(super) fn install(c: &Connection) -> Result<(), String> {
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
    pub(super) directory: PathBuf,
}
