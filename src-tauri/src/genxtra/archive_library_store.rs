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
    #[cfg(test)]
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
type ProofBoundaryHook = Option<Box<dyn FnMut(ProofBoundary)>>;
#[cfg(test)]
thread_local! {
    static STARTUP_PAIR_VALIDATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static PROOF_BOUNDARY_HOOK: std::cell::RefCell<ProofBoundaryHook> = const { std::cell::RefCell::new(None) };
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

// This module's parts, by area, are in archive_library_store/.
mod schema;
pub(crate) use schema::*;
mod checks;
pub(crate) use checks::*;
mod repair;
use repair::*;
// Test hooks other modules' tests use.
#[cfg(test)]
pub(crate) use repair::{observe_backup, BackupObserver, BackupPhase};
