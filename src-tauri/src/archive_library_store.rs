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

//! Sole GenXtra authority after an explicit, crash-recoverable canonical handoff.
//! Callers retain Store/root-generation ownership; no network is performed here.
use crate::{archive_bookmarks, archive_catalog, archive_provider_catalog, storage::refuse_link};
use fs2::FileExt;
use rusqlite::{
    params,
    types::{Value, ValueRef},
    Connection, OpenFlags,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tempfile::NamedTempFile;

pub(crate) const TABLES: [&str; 14] = [
    "archive_catalog_meta_v1",
    "archive_title_v1",
    "archive_file_v1",
    "archive_progress_v1",
    "archive_item_progress_v1",
    "archive_preferences_v1",
    "archive_removal_v1",
    "archive_bookmark_meta_v1",
    "archive_bookmark_v1",
    "public_archive_item_v1",
    "public_archive_variant_v1",
    "public_archive_preference_v1",
    "public_archive_removal_v1",
    "public_archive_checkpoint_v1",
];
const DIRECTORY: &str = "archive-library-v1";
const DB: &str = "archive.sqlite3";
const BACKUP: &str = "archive.sqlite3.backup";
const WITNESS: &str = "archive-authority-v1";
const META: &str = "archive_namespace_meta_v1";
const MAX_DB: u64 = 128 * 1024 * 1024;
const MAX_ROWS: usize = 200_000;
const MAX_BYTES: usize = 96 * 1024 * 1024;
const ERR: &str = "archive-library-storage-failed";
pub(crate) const REPAIR: &str = "archive-library-repair-required";
const INVALID: &str = "archive-library-integrity-failed";
const LIMIT: &str = "archive-library-limit";
const SCHEMA: &str = "archive-library-schema-unsupported";
const CONTROL_SQL:&str="CREATE TABLE archive_namespace_meta_v1(singleton INTEGER PRIMARY KEY CHECK(singleton=1),binding TEXT NOT NULL CHECK(length(CAST(binding AS BLOB))<=2048),sequence INTEGER NOT NULL CHECK(sequence>=0),epoch INTEGER NOT NULL CHECK(epoch>=0),digest TEXT NOT NULL CHECK(length(digest)=64));";
fn sql<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|e| match e.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase) => {
            INVALID.into()
        }
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            "archive-library-storage-busy".into()
        }
        Some(rusqlite::ErrorCode::DiskFull) => "archive-library-disk-full".into(),
        _ => ERR.into(),
    })
}
fn hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn random() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| ERR)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Binding {
    pub namespace: String,
    pub migration_id: String,
    pub imported_digest: String,
    pub source_revision: i64,
    pub source_bookmark_revision: i64,
}
impl Binding {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !hex(&self.namespace)
            || !hex(&self.migration_id)
            || !hex(&self.imported_digest)
            || self.source_revision < 0
            || self.source_bookmark_revision < 0
        {
            return Err(INVALID.into());
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Phase {
    Prepared,
    Active,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Witness {
    pub schema_version: u8,
    pub phase: Phase,
    pub binding: Binding,
    checksum: String,
}
fn witness_checksum(phase: Phase, b: &Binding) -> Result<String, String> {
    let bytes = serde_json::to_vec(&(1u8, phase, b)).map_err(|_| ERR)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
pub(crate) fn inspect(root: &Path) -> Result<Option<Witness>, String> {
    refuse_link(root)?;
    let path = root.join(WITNESS);
    refuse_link(&path)?;
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ERR.into()),
        Ok(m) if !m.is_file() || m.len() > 4096 => return Err(REPAIR.into()),
        _ => (),
    }
    let mut bytes = Vec::new();
    File::open(&path)
        .map_err(|_| ERR)?
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| ERR)?;
    if bytes.len() > 4096 {
        return Err(REPAIR.into());
    }
    let value: Witness = serde_json::from_slice(&bytes).map_err(|_| REPAIR)?;
    value.binding.validate().map_err(|_| REPAIR)?;
    if value.schema_version != 1 || witness_checksum(value.phase, &value.binding)? != value.checksum
    {
        return Err(REPAIR.into());
    }
    Ok(Some(value))
}
/// This OS lock is held across the complete handoff by the canonical owner.
pub(crate) struct RootLock {
    root: PathBuf,
    _file: File,
    shared: bool,
    // Never leaves this exact OS-lock lifetime; normal mutation paths do not use it.
    initialization_proof: Mutex<Option<InitializationProof>>,
}
impl RootLock {
    fn invalidate_proof(&self) {
        if let Ok(mut proof) = self.initialization_proof.lock() {
            *proof = None;
        }
    }
    fn initialization_result<T>(&self, result: Result<T, String>) -> Result<T, String> {
        if result.is_err() {
            self.invalidate_proof();
        }
        result
    }
    pub(crate) fn verify_root(&self, root: &Path) -> Result<(), String> {
        refuse_link(root)?;
        let actual = root.canonicalize().map_err(|_| ERR)?;
        if actual != self.root {
            return Err("archive-library-root-mismatch".into());
        }
        Ok(())
    }
}
pub(crate) fn lock_root(root: &Path) -> Result<RootLock, String> {
    lock_wait(root, false, std::time::Duration::ZERO, &mut || Ok(()))
}
fn lock_wait(
    root: &Path,
    shared: bool,
    budget: std::time::Duration,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<RootLock, String> {
    let started = std::time::Instant::now();
    check()?;
    refuse_link(root)?;
    if !root.is_dir() {
        return Err(ERR.into());
    }
    let path = root.join("archive-library-v1.lock");
    refuse_link(&path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|_| ERR)?;
    loop {
        check()?;
        let result = if shared {
            FileExt::try_lock_shared(&file)
        } else {
            FileExt::try_lock_exclusive(&file)
        };
        match result {
            Ok(()) => break,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
            {
                if started.elapsed() >= budget {
                    return Err("archive-library-storage-busy".into());
                }
                std::thread::sleep(
                    std::time::Duration::from_millis(10)
                        .min(budget.saturating_sub(started.elapsed())),
                );
            }
            Err(_) => return Err(ERR.into()),
        }
    }
    check()?;
    refuse_link(&path)?;
    Ok(RootLock {
        root: root.canonicalize().map_err(|_| ERR)?,
        _file: file,
        shared,
        initialization_proof: Mutex::new(None),
    })
}
fn sync_directory(path: &Path) -> Result<(), String> {
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
fn publish(temp: NamedTempFile, target: &Path) -> Result<(), String> {
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
    sync_directory(target.parent().ok_or(ERR)?)
}
fn save_witness(root: &Path, binding: &Binding, phase: Phase) -> Result<(), String> {
    let value = Witness {
        schema_version: 1,
        phase,
        binding: binding.clone(),
        checksum: witness_checksum(phase, binding)?,
    };
    let bytes = serde_json::to_vec(&value).map_err(|_| ERR)?;
    let mut temp = NamedTempFile::new_in(root).map_err(|_| ERR)?;
    temp.write_all(&bytes).map_err(|_| ERR)?;
    publish(temp, &root.join(WITNESS))?;
    if inspect(root)?.as_ref() != Some(&value) {
        return Err(REPAIR.into());
    }
    Ok(())
}
fn directory(root: &Path, create: bool) -> Result<PathBuf, String> {
    let path = root.join(DIRECTORY);
    refuse_link(&path)?;
    if create && !path.exists() {
        fs::create_dir(&path).map_err(|_| ERR)?;
        sync_directory(root)?;
    }
    if !path.is_dir() {
        return Err(REPAIR.into());
    }
    Ok(path)
}
fn connect(path: &Path, create: bool, read_only: bool) -> Result<Connection, String> {
    refuse_link(path)?;
    if let Ok(meta) = fs::metadata(path) {
        if !meta.is_file() || meta.len() > MAX_DB {
            return Err(LIMIT.into());
        }
    }
    let flags = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | if create {
                OpenFlags::SQLITE_OPEN_CREATE
            } else {
                OpenFlags::empty()
            }
    };
    let c = sql(Connection::open_with_flags(path, flags))?;
    sql(c.busy_timeout(std::time::Duration::from_secs(2)))?;
    sql(c.execute_batch(
        "PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;PRAGMA cache_size=-2048;",
    ))?;
    if read_only {
        sql(c.execute_batch("PRAGMA query_only=ON;"))?;
    } else {
        sql(c.execute_batch("PRAGMA synchronous=EXTRA;PRAGMA max_page_count=32768;"))?;
    }
    Ok(c)
}
fn install(c: &mut Connection) -> Result<(), String> {
    sql(c.execute_batch("PRAGMA page_size=4096;PRAGMA journal_mode=DELETE;"))?;
    let tx = sql(c.transaction())?;
    archive_catalog::install(&tx)?;
    archive_bookmarks::install(&tx)?;
    archive_provider_catalog::install(&tx)?;
    sql(tx.execute_batch(CONTROL_SQL))?;
    sql(tx.execute_batch("PRAGMA user_version=1;"))?;
    sql(tx.commit())
}
type SchemaRows = Vec<(String, String, String, Option<String>)>;
fn schema_rows(c: &Connection, namespace: bool) -> Result<SchemaRows, String> {
    let mut statement=sql(c.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' OR type='index' ORDER BY type,name"))?;
    let rows = sql(statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    }))?;
    let rows = sql(rows.collect::<rusqlite::Result<SchemaRows>>())?;
    Ok(rows
        .into_iter()
        .filter(|r| namespace || TABLES.contains(&r.2.as_str()))
        .collect())
}
fn expected_schema() -> Result<&'static SchemaRows, String> {
    static EXPECTED: OnceLock<Result<SchemaRows, String>> = OnceLock::new();
    EXPECTED
        .get_or_init(|| {
            let mut c = sql(Connection::open_in_memory())?;
            install(&mut c)?;
            schema_rows(&c, true)
        })
        .as_ref()
        .map_err(Clone::clone)
}
fn validate_schema(c: &Connection, namespace: bool) -> Result<(), String> {
    let expected = expected_schema()?;
    let expected: SchemaRows = expected
        .iter()
        .filter(|r| namespace || TABLES.contains(&r.2.as_str()))
        .cloned()
        .collect();
    if schema_rows(c, namespace)? != expected {
        return Err(INVALID.into());
    }
    Ok(())
}
fn revisions(c: &Connection) -> Result<(i64, i64), String> {
    let cat = archive_catalog::current(c)?;
    let book: i64 = sql(c.query_row(
        "SELECT revision FROM archive_bookmark_meta_v1 WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    if cat < 0 || book < 0 {
        return Err(INVALID.into());
    }
    Ok((cat, book))
}
fn domain_bounds(c: &Connection) -> Result<(), String> {
    let _timing = crate::storage_timings::archive_measure(
        crate::storage_timings::ArchivePhase::DomainValidation,
    );
    // Preserve the legacy domain budget, including user choices and removals.
    let(t,p,pb,b,progress,r,rb):(i64,i64,i64,i64,i64,i64,i64)=sql(c.query_row("SELECT (SELECT count(*) FROM archive_title_v1),(SELECT count(*) FROM archive_preferences_v1),(SELECT COALESCE(sum(length(CAST(title_ref AS BLOB))+length(CAST(item_id AS BLOB))+length(CAST(title AS BLOB))+128),0) FROM archive_preferences_v1),(SELECT COALESCE(sum(length(CAST(title AS BLOB))+length(CAST(item_id AS BLOB))+COALESCE(length(CAST(rights AS BLOB)),0)+length(CAST(search_text AS BLOB))+256),0) FROM archive_title_v1)+(SELECT COALESCE(sum(length(CAST(file_name AS BLOB))+length(CAST(item_id AS BLOB))+length(CAST(servers AS BLOB))+COALESCE(length(CAST(original_identity AS BLOB)),0)+COALESCE(length(CAST(file_title AS BLOB)),0)+256),0) FROM archive_file_v1),(SELECT count(*)*256 FROM archive_item_progress_v1),(SELECT count(*) FROM archive_removal_v1),(SELECT COALESCE(sum(length(CAST(reference AS BLOB))+length(CAST(item_id AS BLOB))+length(CAST(title_ref AS BLOB))+length(CAST(display_name AS BLOB))+COALESCE(length(CAST(file_name AS BLOB)),0)+128),0) FROM archive_removal_v1)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))))?;
    if t > 1400
        || p > 10000
        || pb > 4 * 1024 * 1024
        || r > 10000
        || rb > 4 * 1024 * 1024
        || b.checked_add(pb)
            .and_then(|n| n.checked_add(progress))
            .and_then(|n| n.checked_add(rb))
            .is_none_or(|n| n > 20 * 1024 * 1024)
    {
        return Err(LIMIT.into());
    }
    archive_bookmarks::validate(c)?;
    archive_provider_catalog::validate(c)?;
    revisions(c)?;
    Ok(())
}
fn hash_part(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}
fn table_columns(c: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut st = sql(c.prepare(&format!("PRAGMA table_info({table})")))?;
    let rows = sql(st.query_map([], |r| r.get::<_, String>(1)))?;
    sql(rows.collect())
}
fn sorted_select(c: &Connection, table: &str) -> Result<String, String> {
    let mut st = sql(c.prepare(&format!("PRAGMA table_info({table})")))?;
    let rows = sql(st.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, u32>(5)?))))?;
    let mut keys = sql(rows.collect::<rusqlite::Result<Vec<_>>>())?;
    keys.retain(|p| p.1 > 0);
    keys.sort_by_key(|p| p.1);
    if keys.is_empty() {
        return Err(INVALID.into());
    }
    Ok(format!(
        "SELECT * FROM {table} ORDER BY {}",
        keys.iter()
            .map(|p| p.0.as_str())
            .collect::<Vec<_>>()
            .join(",")
    ))
}
fn walk_domain(
    c: &Connection,
    check: &mut dyn FnMut() -> Result<(), String>,
    mut row_fn: impl FnMut(&str, &[Value]) -> Result<(), String>,
) -> Result<String, String> {
    let _timing =
        crate::storage_timings::archive_measure(crate::storage_timings::ArchivePhase::DomainWalk);
    let mut hash = Sha256::new();
    hash_part(&mut hash, b"archive-library-domain-v1");
    let mut total_rows = 0usize;
    let mut total_bytes = 0usize;
    for table in TABLES {
        check()?;
        hash_part(&mut hash, table.as_bytes());
        let columns = table_columns(c, table)?;
        let oversized = columns
            .iter()
            .map(|col| format!("length(CAST({col} AS BLOB))>1048576"))
            .collect::<Vec<_>>()
            .join(" OR ");
        if sql(c.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {oversized})"),
            [],
            |r| r.get::<_, bool>(0),
        ))? {
            return Err(LIMIT.into());
        }
        for col in columns {
            hash_part(&mut hash, col.as_bytes());
        }
        let mut st = sql(c.prepare(&sorted_select(c, table)?))?;
        let columns = st.column_count();
        let mut rows = sql(st.query([]))?;
        while let Some(row) = sql(rows.next())? {
            check()?;
            total_rows += 1;
            if total_rows > MAX_ROWS {
                return Err(LIMIT.into());
            }
            let mut values = Vec::with_capacity(columns);
            let mut row_bytes = 0usize;
            hash.update([0xff]);
            for n in 0..columns {
                let value = sql(row.get_ref(n))?;
                let size = match value {
                    ValueRef::Text(v) | ValueRef::Blob(v) => v.len(),
                    _ => 8,
                };
                row_bytes = row_bytes.checked_add(size).ok_or(LIMIT)?;
                total_bytes = total_bytes.checked_add(size).ok_or(LIMIT)?;
                if row_bytes > 1024 * 1024 || total_bytes > MAX_BYTES {
                    return Err(LIMIT.into());
                }
                match value {
                    ValueRef::Null => hash.update([0]),
                    ValueRef::Integer(v) => {
                        hash.update([1]);
                        hash.update(v.to_be_bytes());
                    }
                    ValueRef::Real(v) => {
                        if !v.is_finite() {
                            return Err(INVALID.into());
                        }
                        hash.update([2]);
                        hash.update(v.to_bits().to_be_bytes());
                    }
                    ValueRef::Text(v) => {
                        hash.update([3]);
                        hash_part(&mut hash, v);
                    }
                    ValueRef::Blob(v) => {
                        hash.update([4]);
                        hash_part(&mut hash, v);
                    }
                }
                values.push(match value {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => Value::Integer(v),
                    ValueRef::Real(v) => Value::Real(v),
                    ValueRef::Text(v) => {
                        Value::Text(std::str::from_utf8(v).map_err(|_| INVALID)?.to_owned())
                    }
                    ValueRef::Blob(v) => Value::Blob(v.to_vec()),
                });
            }
            row_fn(table, &values)?;
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub(crate) fn source_fingerprint(
    c: &Connection,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<String, String> {
    validate_schema(c, false)?;
    domain_bounds(c)?;
    walk_domain(c, check, |_, _| Ok(()))
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Snapshot {
    binding: Binding,
    sequence: i64,
    epoch: i64,
    digest: String,
    catalog_revision: i64,
    bookmark_revision: i64,
}
fn control(c: &Connection) -> Result<Snapshot, String> {
    let (raw, sequence, epoch, digest): (String, i64, i64, String) = sql(c.query_row(
        "SELECT binding,sequence,epoch,digest FROM archive_namespace_meta_v1 WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ))?;
    if raw.len() > 2048
        || sequence < 0
        || epoch < 0
        || !hex(&digest)
        || sql(
            c.query_row("SELECT count(*) FROM archive_namespace_meta_v1", [], |r| {
                r.get::<_, i64>(0)
            }),
        )? != 1
    {
        return Err(INVALID.into());
    }
    let binding: Binding = serde_json::from_str(&raw).map_err(|_| INVALID)?;
    binding.validate()?;
    let (cat, book) = revisions(c)?;
    if cat < binding.source_revision || book < binding.source_bookmark_revision {
        return Err(INVALID.into());
    }
    Ok(Snapshot {
        binding,
        sequence,
        epoch,
        digest,
        catalog_revision: cat,
        bookmark_revision: book,
    })
}
fn complete_digest(s: &Snapshot, domain: &str) -> Result<String, String> {
    let value = serde_json::to_vec(&(
        1u8,
        &s.binding,
        s.sequence,
        s.epoch,
        s.catalog_revision,
        s.bookmark_revision,
        domain,
    ))
    .map_err(|_| ERR)?;
    Ok(format!("{:x}", Sha256::digest(value)))
}
struct CheckWorker {
    progress: Option<std::sync::mpsc::Receiver<()>>,
    replies: Option<std::sync::mpsc::SyncSender<bool>>,
    worker: Option<std::thread::JoinHandle<Result<(), String>>>,
}
impl CheckWorker {
    fn join(&mut self) -> Result<(), String> {
        self.progress.take();
        self.replies.take();
        self.worker
            .take()
            .ok_or(ERR)?
            .join()
            .map_err(|_| ERR.to_string())?
    }
}
impl Drop for CheckWorker {
    fn drop(&mut self) {
        if self.worker.is_some() {
            let _ = self.join();
        }
    }
}
/// The progress handshake keeps the actual SQL worker retained and joined,
/// including cancellation or panic in the caller's authority guard.
// Batch only the cooperative authority handshake, never the SQL verification.
// Admission and precommit guards still run, and the original worker always joins.
// An opcode stride is not a wall-clock cancellation or disposal guarantee.
const QUICK_CHECK_OPS: i32 = 10000;
fn quick_check_owned(
    path: &Path,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
    quick_check_owned_at_stride(path, check, QUICK_CHECK_OPS)
}
fn quick_check_owned_at_stride(
    path: &Path,
    check: &mut dyn FnMut() -> Result<(), String>,
    stride: i32,
) -> Result<(), String> {
    if !matches!(stride, 1000 | 10000) {
        return Err(ERR.into());
    }
    let _timing =
        crate::storage_timings::archive_measure(crate::storage_timings::ArchivePhase::QuickCheck);
    use std::sync::mpsc;
    check()?;
    let (progress_tx, progress_rx) = mpsc::sync_channel(1);
    let (reply_tx, reply_rx) = mpsc::sync_channel(0);
    let path = path.to_owned();
    let worker = std::thread::Builder::new()
        .name("genx-archive-verifier".into())
        .spawn(move || {
            let c = connect(&path, false, true)?;
            sql(c.progress_handler(
                stride,
                Some(move || progress_tx.send(()).is_err() || !matches!(reply_rx.recv(), Ok(true))),
            ))?;
            let result = sql(c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)))
                .and_then(|value| {
                    if value == "ok" {
                        Ok(())
                    } else {
                        Err(INVALID.into())
                    }
                });
            let cleared = sql(c.progress_handler(0, None::<fn() -> bool>));
            result.and(cleared)
        })
        .map_err(|_| ERR)?;
    let mut owned = CheckWorker {
        progress: Some(progress_rx),
        replies: Some(reply_tx),
        worker: Some(worker),
    };
    let mut refused = None;
    while owned.progress.as_ref().ok_or(ERR)?.recv().is_ok() {
        let allowed = if refused.is_some() {
            false
        } else {
            match check() {
                Ok(()) => true,
                Err(error) => {
                    refused = Some(error);
                    false
                }
            }
        };
        if owned.replies.as_ref().ok_or(ERR)?.send(allowed).is_err() {
            break;
        }
    }
    let result = owned.join();
    match refused {
        Some(error) => Err(error),
        None => result,
    }
}
fn validate(
    c: &Connection,
    full: bool,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Snapshot, String> {
    validate_at_stride(c, full, check, QUICK_CHECK_OPS)
}
fn validate_at_stride(
    c: &Connection,
    full: bool,
    check: &mut dyn FnMut() -> Result<(), String>,
    stride: i32,
) -> Result<Snapshot, String> {
    check()?;
    if sql(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? != 1 {
        return Err(SCHEMA.into());
    }
    if sql(c.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0)))? != "delete" {
        return Err(SCHEMA.into());
    }
    validate_schema(c, true)?;
    let pages: i64 = sql(c.query_row("PRAGMA page_count", [], |r| r.get(0)))?;
    let size: i64 = sql(c.query_row("PRAGMA page_size", [], |r| r.get(0)))?;
    if size != 4096 || pages < 0 || pages.checked_mul(size).is_none_or(|n| n as u64 > MAX_DB) {
        return Err(LIMIT.into());
    }
    if full {
        if let Some(path) = c.path().filter(|path| !path.is_empty()) {
            if stride == QUICK_CHECK_OPS {
                quick_check_owned(Path::new(path), check)?;
            } else {
                quick_check_owned_at_stride(Path::new(path), check, stride)?;
            }
        } else if sql(c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)))? != "ok" {
            return Err(INVALID.into());
        }
    }
    if sql(
        c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get::<_, i64>(0)
        }),
    )? != 0
    {
        return Err(INVALID.into());
    }
    let s = control(c)?;
    let domain = walk_domain(c, check, |_, _| Ok(()))?;
    if s.sequence == 0 && domain != s.binding.imported_digest {
        return Err(INVALID.into());
    }
    if complete_digest(&s, &domain)? != s.digest {
        return Err(INVALID.into());
    }
    domain_bounds(c)?;
    check()?;
    Ok(s)
}
fn snapshot(
    c: &Connection,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Snapshot, String> {
    let tx = sql(c.unchecked_transaction())?;
    let s = validate(&tx, true, check)?;
    sql(tx.commit())?;
    Ok(s)
}
/// Mutations invoke this INSIDE their own transaction immediately before COMMIT.
/// Legacy canonical fixtures have no control row and preserve their old behavior.
pub(crate) fn finalize(
    c: &Connection,
    clear_epoch: bool,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let installed:bool=sql(c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='archive_namespace_meta_v1' AND type='table')",[],|r|r.get(0)))?;
    if !installed {
        return Ok(());
    }
    if c.is_autocommit() {
        return Err("archive-library-transaction-required".into());
    }
    check()?;
    validate_schema(c, true)?;
    domain_bounds(c)?;
    let mut s = control(c)?;
    let domain = walk_domain(c, check, |_, _| Ok(()))?;
    if !clear_epoch && complete_digest(&s, &domain)? == s.digest {
        return Ok(());
    }
    s.sequence = s
        .sequence
        .checked_add(1)
        .ok_or("archive-library-sequence-exhausted")?;
    if clear_epoch {
        s.epoch = s
            .epoch
            .checked_add(1)
            .ok_or("archive-library-epoch-exhausted")?;
    }
    s.digest = complete_digest(&s, &domain)?;
    sql(c.execute(
        "UPDATE archive_namespace_meta_v1 SET sequence=?1,epoch=?2,digest=?3 WHERE singleton=1",
        params![s.sequence, s.epoch, s.digest],
    ))?;
    check()?;
    Ok(())
}
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackupPhase {
    BeforeCopy,
    AfterCopy,
    BeforePublish,
    AfterPublish,
}
#[cfg(test)]
type BackupHook = Box<dyn FnMut(BackupPhase) -> Result<(), String>>;
#[cfg(test)]
thread_local! { static BACKUP_HOOK: std::cell::RefCell<Option<BackupHook>> = std::cell::RefCell::new(None); }
#[cfg(test)]
pub(crate) struct BackupObserver {
    previous: Option<BackupHook>,
}
#[cfg(test)]
impl Drop for BackupObserver {
    fn drop(&mut self) {
        BACKUP_HOOK.with(|hook| {
            *hook.borrow_mut() = self.previous.take();
        });
    }
}
#[cfg(test)]
pub(crate) fn observe_backup(
    hook: impl FnMut(BackupPhase) -> Result<(), String> + 'static,
) -> BackupObserver {
    BackupObserver {
        previous: BACKUP_HOOK.with(|slot| slot.borrow_mut().replace(Box::new(hook))),
    }
}
#[cfg(test)]
fn backup_phase(phase: BackupPhase) -> Result<(), String> {
    BACKUP_HOOK.with(|slot| match slot.borrow_mut().as_mut() {
        Some(hook) => hook(phase),
        None => Ok(()),
    })
}
fn mirror(
    c: &Connection,
    target: &Path,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Snapshot, String> {
    #[cfg(test)]
    backup_phase(BackupPhase::BeforeCopy)?;
    let expected = snapshot(c, check)?;
    let temp = NamedTempFile::new_in(target.parent().ok_or(ERR)?).map_err(|_| ERR)?;
    {
        let mut dest = connect(temp.path(), true, false)?;
        crate::storage_transaction::copy_sqlite_snapshot_checked(c, &mut dest, &mut *check)?;
        #[cfg(test)]
        backup_phase(BackupPhase::AfterCopy)?;
        if snapshot(&dest, check)? != expected {
            return Err(INVALID.into());
        }
    }
    check()?;
    #[cfg(test)]
    backup_phase(BackupPhase::BeforePublish)?;
    publish(temp, target)?;
    #[cfg(test)]
    backup_phase(BackupPhase::AfterPublish)?;
    let installed = connect(target, false, false)?;
    if snapshot(&installed, check)? != expected {
        return Err(INVALID.into());
    }
    Ok(expected)
}
fn journals(path: &Path) -> bool {
    ["-journal", "-wal", "-shm"].iter().any(|s| {
        path.with_file_name(format!(
            "{}{}",
            path.file_name().unwrap_or_default().to_string_lossy(),
            s
        ))
        .exists()
    })
}
fn read_copy(
    path: &Path,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Option<Snapshot>, String> {
    refuse_link(path)?;
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ERR.into()),
        Ok(m) if !m.is_file() => return Err(REPAIR.into()),
        _ => (),
    }
    if journals(path) {
        let mut header = [0u8; 16];
        if File::open(path)
            .and_then(|mut f| f.read_exact(&mut header))
            .is_err()
            || &header != b"SQLite format 3\0"
        {
            return Err(REPAIR.into());
        }
    }
    let c = connect(path, false, false)?;
    snapshot(&c, check).map(Some)
}
fn repair_pair(
    directory: &Path,
    binding: &Binding,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Snapshot, String> {
    #[cfg(test)]
    STARTUP_PAIR_VALIDATIONS.with(|value| value.set(value.get() + 1));
    let _timing =
        crate::storage_timings::archive_measure(crate::storage_timings::ArchivePhase::Pair);
    let main = directory.join(DB);
    let backup = directory.join(BACKUP);
    let a = {
        let _timing =
            crate::storage_timings::archive_measure(crate::storage_timings::ArchivePhase::Primary);
        read_copy(&main, check)
    };
    let b = {
        let _timing =
            crate::storage_timings::archive_measure(crate::storage_timings::ArchivePhase::Backup);
        read_copy(&backup, check)
    };
    for result in [&a, &b] {
        if let Err(e) = result {
            if e != INVALID && e != LIMIT {
                return Err(e.clone());
            }
        }
    }
    for value in [
        a.as_ref().ok().and_then(Option::as_ref),
        b.as_ref().ok().and_then(Option::as_ref),
    ]
    .into_iter()
    .flatten()
    {
        if &value.binding != binding {
            return Err(REPAIR.into());
        }
    }
    let (source, target) = match (&a, &b) {
        (Ok(Some(x)), Ok(Some(y))) if x.sequence == y.sequence => {
            if x != y {
                return Err(REPAIR.into());
            }
            return Ok(x.clone());
        }
        (Ok(Some(x)), Ok(Some(y))) => {
            let (new, old, from, to) = if x.sequence > y.sequence {
                (x, y, &main, &backup)
            } else {
                (y, x, &backup, &main)
            };
            if new.epoch < old.epoch
                || new.catalog_revision < old.catalog_revision
                || new.bookmark_revision < old.bookmark_revision
            {
                return Err(REPAIR.into());
            }
            (from, to)
        }
        (Ok(Some(_)), _) => (&main, &backup),
        (_, Ok(Some(_))) => (&backup, &main),
        _ => return Err(REPAIR.into()),
    };
    if journals(target) {
        return Err(REPAIR.into());
    }
    let c = connect(source, false, false)?;
    mirror(&c, target, check)
}

#[derive(Clone, PartialEq, Eq)]
struct PairImages {
    primary: [u8; 32],
    backup: [u8; 32],
    witness: [u8; 32],
}
#[derive(Clone)]
struct InitializationProof {
    images: PairImages,
    snapshot: Snapshot,
}
fn image_sha(
    path: &Path,
    limit: u64,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Option<[u8; 32]>, String> {
    let first = image_sha_once(path, limit, check)?;
    // Reopen the pathname: a rename during a guard must not validate an old FD.
    let second = image_sha_once(path, limit, check)?;
    Ok(first.filter(|value| second.as_ref() == Some(value)))
}
fn image_sha_once(
    path: &Path,
    limit: u64,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Option<[u8; 32]>, String> {
    check()?;
    refuse_link(path)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(m) if m.is_file() && m.len() <= limit => m,
        _ => return Ok(None),
    };
    let mut file = File::open(path).map_err(|_| ERR)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut bytes = 0u64;
    loop {
        check()?;
        let count = file.read(&mut buffer).map_err(|_| ERR)?;
        if count == 0 {
            break;
        }
        bytes = bytes.checked_add(count as u64).ok_or(LIMIT)?;
        if bytes > limit {
            return Ok(None);
        }
        hash.update(&buffer[..count]);
    }
    refuse_link(path)?;
    // Length bounds are only admission checks. Trust always requires every byte's SHA.
    if bytes != metadata.len() || file.metadata().map_err(|_| ERR)?.len() != bytes {
        return Ok(None);
    }
    Ok(Some(hash.finalize().into()))
}
fn initialization_images(
    lease: &RootLock,
    binding: &Binding,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Option<PairImages>, String> {
    check()?;
    lease.verify_root(&lease.root)?;
    if lease.shared {
        return Ok(None);
    }
    let witness = inspect(&lease.root)?.ok_or(REPAIR)?;
    if witness.phase != Phase::Active || &witness.binding != binding {
        return Ok(None);
    }
    let dir = directory(&lease.root, false)?;
    let main = dir.join(DB);
    let backup = dir.join(BACKUP);
    if journals(&main) || journals(&backup) {
        return Ok(None);
    }
    let Some(primary) = image_sha(&main, MAX_DB, check)? else {
        return Ok(None);
    };
    let Some(backup_hash) = image_sha(&backup, MAX_DB, check)? else {
        return Ok(None);
    };
    let Some(witness_hash) = image_sha(&lease.root.join(WITNESS), 4096, check)? else {
        return Ok(None);
    };
    lease.verify_root(&lease.root)?;
    directory(&lease.root, false)?;
    if journals(&main) || journals(&backup) || inspect(&lease.root)?.as_ref() != Some(&witness) {
        return Ok(None);
    }
    #[cfg(test)]
    proof_boundary(ProofBoundary::ImagesReady);
    check()?;
    Ok(Some(PairImages {
        primary,
        backup: backup_hash,
        witness: witness_hash,
    }))
}
/// Only unchanged ACTIVE initialization under this same exclusive OS lock may
/// reuse a complete verified Snapshot. Every call hashes both full SQL images
/// and raw witness; changes/journals/PREPARED/shared leases take the original
/// full verification/recovery path. No write or post-backup CAS uses this proof.
fn initialization_pair(
    lease: &RootLock,
    binding: &Binding,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Snapshot, String> {
    // Take first: any refused guard/error invalidates rather than retaining authority.
    let previous = lease
        .initialization_proof
        .lock()
        .ok()
        .and_then(|mut p| p.take());
    let before = initialization_images(lease, binding, check)?;
    if let (Some(previous), Some(images)) = (&previous, &before) {
        if &previous.images == images && &previous.snapshot.binding == binding {
            #[cfg(test)]
            proof_boundary(ProofBoundary::ReuseReady);
            check()?;
            let value = previous.snapshot.clone();
            if let Ok(mut proof) = lease.initialization_proof.lock() {
                *proof = Some(previous.clone());
            }
            return Ok(value);
        }
    }
    let value = repair_pair(&directory(&lease.root, false)?, binding, check)?;
    if let Some(before) = before {
        if initialization_images(lease, binding, check)?.as_ref() == Some(&before) {
            if let Ok(mut proof) = lease.initialization_proof.lock() {
                *proof = Some(InitializationProof {
                    images: before,
                    snapshot: value.clone(),
                });
            }
        }
    }
    Ok(value)
}
/// Prepare exact archive rows from one canonical snapshot. Caller holds RootLock
/// through its separate schema17 seal, canonical latest mirror, and activation.
pub(crate) fn prepare(
    lease: &RootLock,
    source: &Connection,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Binding, String> {
    lease.invalidate_proof();
    check()?;
    if sql(source.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? != 16 {
        return Err(SCHEMA.into());
    }
    let tx = sql(source.unchecked_transaction())?;
    let digest = source_fingerprint(&tx, check)?;
    let (cat, book) = revisions(&tx)?;
    if let Some(w) = inspect(&lease.root)? {
        if w.phase != Phase::Prepared
            || w.binding.imported_digest != digest
            || w.binding.source_revision != cat
            || w.binding.source_bookmark_revision != book
        {
            return Err(REPAIR.into());
        }
        let dir = directory(&lease.root, false)?;
        let s = repair_pair(&dir, &w.binding, check)?;
        if s.sequence != 0 || s.epoch != 0 {
            return Err(REPAIR.into());
        }
        return Ok(w.binding);
    }
    let dir = directory(&lease.root, true)?;
    // A crash may publish an exact unadopted copy before its witness. Resume
    // only its immutable baseline, never merge current canonical contents.
    if [DB, BACKUP].iter().any(|n| dir.join(n).exists()) {
        let a = read_copy(&dir.join(DB), check);
        let b = read_copy(&dir.join(BACKUP), check);
        for result in [&a, &b] {
            if let Err(e) = result {
                if e != INVALID && e != LIMIT {
                    return Err(e.clone());
                }
            }
        }
        let candidate = a
            .as_ref()
            .ok()
            .and_then(Option::as_ref)
            .or_else(|| b.as_ref().ok().and_then(Option::as_ref))
            .ok_or(REPAIR)?;
        let binding = candidate.binding.clone();
        if binding.imported_digest != digest
            || binding.source_revision != cat
            || binding.source_bookmark_revision != book
            || candidate.sequence != 0
            || candidate.epoch != 0
        {
            return Err(REPAIR.into());
        }
        let s = repair_pair(&dir, &binding, check)?;
        if s.sequence != 0 || s.epoch != 0 {
            return Err(REPAIR.into());
        }
        check()?;
        save_witness(&lease.root, &binding, Phase::Prepared)?;
        return Ok(binding);
    }
    let binding = Binding {
        namespace: random()?,
        migration_id: random()?,
        imported_digest: digest,
        source_revision: cat,
        source_bookmark_revision: book,
    };
    let temp = NamedTempFile::new_in(&dir).map_err(|_| ERR)?;
    {
        let mut target = connect(temp.path(), true, false)?;
        install(&mut target)?;
        let target_tx = sql(target.transaction())?;
        sql(target_tx.execute_batch(
            "DELETE FROM archive_catalog_meta_v1;DELETE FROM archive_bookmark_meta_v1;",
        ))?;
        walk_domain(&tx, check, |table, values| {
            let placeholders = (1..=values.len())
                .map(|n| format!("?{n}"))
                .collect::<Vec<_>>()
                .join(",");
            sql(target_tx.execute(
                &format!("INSERT INTO {table} VALUES({placeholders})"),
                rusqlite::params_from_iter(values.iter()),
            ))?;
            Ok(())
        })?;
        let raw = serde_json::to_string(&binding).map_err(|_| ERR)?;
        let mut s = Snapshot {
            binding: binding.clone(),
            sequence: 0,
            epoch: 0,
            digest: String::new(),
            catalog_revision: cat,
            bookmark_revision: book,
        };
        s.digest = complete_digest(&s, &binding.imported_digest)?;
        sql(target_tx.execute(
            "INSERT INTO archive_namespace_meta_v1 VALUES(1,?1,0,0,?2)",
            params![raw, s.digest],
        ))?;
        validate(&target_tx, false, check)?;
        check()?;
        sql(target_tx.commit())?;
    }
    check()?;
    publish(temp, &dir.join(DB))?;
    let c = connect(&dir.join(DB), false, false)?;
    mirror(&c, &dir.join(BACKUP), check)?;
    check()?;
    save_witness(&lease.root, &binding, Phase::Prepared)?;
    sql(tx.commit())?;
    Ok(binding)
}
/// Validate/reconcile the sole handoff inventory without reacquiring RootLock.
/// Active namespace authority survives restoration of an older canonical file.
pub(crate) fn verify_handoff_pair(
    lease: &RootLock,
    binding: &Binding,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
    lease.initialization_result((|| {
        binding.validate()?;
        let witness = inspect(&lease.root)?.ok_or(REPAIR)?;
        if &witness.binding != binding {
            return Err(REPAIR.into());
        }
        initialization_pair(lease, binding, check)?;
        Ok(())
    })())
}
pub(crate) fn activate(
    lease: &RootLock,
    binding: &Binding,
    verify_seal: impl FnOnce() -> Result<(), String>,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let _caller =
        crate::storage_timings::archive_caller(crate::storage_timings::ArchiveCaller::Activate);
    lease.initialization_result((|| {
        binding.validate()?;
        let w = inspect(&lease.root)?.ok_or(REPAIR)?;
        if &w.binding != binding {
            return Err(REPAIR.into());
        }
        verify_seal()?;
        initialization_pair(lease, binding, check)?;
        check()?;
        if w.phase == Phase::Prepared {
            save_witness(&lease.root, binding, Phase::Active)?;
        }
        Ok(())
    })())
}
#[derive(Clone)]
pub(crate) struct ArchiveStore {
    root: PathBuf,
    binding: Binding,
}
impl ArchiveStore {
    /// Explicit raw fixture construction only. This does not exercise normal
    /// mutation cancellation/CAS and must never be called by production code.
    #[cfg(test)]
    pub(crate) fn seed_fixture<T>(
        &self,
        write: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let _lease = lock_root(&self.root)?;
        let dir = self.current()?;
        repair_pair(&dir, &self.binding, &mut || Ok(()))?;
        let mut c = connect(&dir.join(DB), false, false)?;
        let receipt = write(&mut c)?;
        if !c.is_autocommit() {
            return Err(REPAIR.into());
        }
        let tx = sql(c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        finalize(&tx, false, &mut || Ok(()))?;
        sql(tx.commit())?;
        snapshot(&c, &mut || Ok(()))?;
        mirror(&c, &dir.join(BACKUP), &mut || Ok(()))?;
        Ok(receipt)
    }
    pub(crate) fn open(
        root: &Path,
        binding: &Binding,
        check: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        let lease = lock_wait(root, false, std::time::Duration::from_secs(2), check)?;
        Self::open_locked(&lease, binding, check)
    }
    pub(crate) fn open_locked(
        lease: &RootLock,
        binding: &Binding,
        check: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        let _caller = crate::storage_timings::archive_caller(
            crate::storage_timings::ArchiveCaller::OpenLocked,
        );
        lease.initialization_result((|| {
            let root = lease.root.as_path();
            binding.validate()?;
            let w = inspect(root)?.ok_or(REPAIR)?;
            if w.phase != Phase::Active || &w.binding != binding {
                return Err(REPAIR.into());
            }
            initialization_pair(lease, binding, check)?;
            Ok(Self {
                root: root.into(),
                binding: binding.clone(),
            })
        })())
    }
    fn current(&self) -> Result<PathBuf, String> {
        let w = inspect(&self.root)?.ok_or(REPAIR)?;
        if w.phase != Phase::Active || w.binding != self.binding {
            return Err(REPAIR.into());
        }
        directory(&self.root, false)
    }
    pub(crate) fn read<T>(
        &self,
        read: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        self.read_checked(read, &mut || Ok(()))
    }
    pub(crate) fn read_checked<T>(
        &self,
        read: impl FnOnce(&Connection) -> Result<T, String>,
        check: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<T, String> {
        let _lease = lock_wait(&self.root, true, std::time::Duration::from_secs(2), check)?;
        let dir = self.current()?;
        let c = connect(&dir.join(DB), false, true)?;
        let s = control(&c)?;
        if s.binding != self.binding {
            return Err(REPAIR.into());
        }
        check()?;
        read(&c)
    }
    /// The mutation owns its transaction/COMMIT and calls finalize before COMMIT.
    /// Preflight must only read. The caller retains checked Store writer authority.
    pub(crate) fn write_checked<T>(
        &self,
        preflight: impl FnOnce(&Connection) -> Result<Option<T>, String>,
        write: impl FnOnce(&mut Connection, &mut dyn FnMut() -> Result<(), String>) -> Result<T, String>,
        check: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<T, String> {
        check()?;
        let _lease = lock_wait(&self.root, false, std::time::Duration::from_secs(2), check)?;
        let dir = self.current()?;
        let old = repair_pair(&dir, &self.binding, check)?;
        let mut c = connect(&dir.join(DB), false, false)?;
        sql(c.execute_batch("PRAGMA query_only=ON;"))?;
        let unchanged = preflight(&c);
        sql(c.execute_batch("PRAGMA query_only=OFF;"))?;
        let unchanged = unchanged?;
        check()?;
        if let Some(receipt) = unchanged {
            return Ok(receipt);
        }
        mirror(&c, &dir.join(BACKUP), check)?;
        check()?;
        // Recheck exact namespace state after the backup releases its read
        // snapshot. The domain callback still repeats its own selected-row CAS.
        if snapshot(&c, check)? != old {
            return Err("archive-revision-stale".into());
        }
        let result = write(&mut c, check);
        // A mutation error may occur after its own COMMIT. Reconcile actual state
        // without consulting an aborted observer, never assert a false rollback.
        if !c.is_autocommit() {
            return Err(REPAIR.into());
        }
        let actual = snapshot(&c, &mut || Ok(())).map_err(|_| REPAIR.to_string())?;
        if actual.binding != old.binding
            || actual.sequence < old.sequence
            || actual.epoch < old.epoch
            || actual.catalog_revision < old.catalog_revision
            || actual.bookmark_revision < old.bookmark_revision
        {
            return Err(REPAIR.into());
        }
        if actual != old {
            mirror(&c, &dir.join(BACKUP), &mut || Ok(())).map_err(|_| REPAIR.to_string())?;
        }
        match result {
            Err(_) if actual != old => Err(REPAIR.into()),
            other => other,
        }
    }
}

#[cfg(test)]
#[path = "archive_library_store_tests.rs"]
mod tests;

#[cfg(test)]
thread_local! {
    static STARTUP_PAIR_VALIDATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static PROOF_BOUNDARY_HOOK: std::cell::RefCell<Option<Box<dyn FnMut(ProofBoundary)>>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum ProofBoundary {
    ImagesReady,
    ReuseReady,
}
#[cfg(test)]
fn proof_boundary(phase: ProofBoundary) {
    PROOF_BOUNDARY_HOOK.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook(phase);
        }
    });
}
#[cfg(test)]
#[path = "archive_startup_proof_tests.rs"]
mod startup_proof_tests;
