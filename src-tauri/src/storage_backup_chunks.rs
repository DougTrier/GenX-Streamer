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

//! EXPERIMENTAL, unwired complete-snapshot backup format. No backup-frequency change.
//!
//! Official design references: https://sqlite.org/dbpage.html and
//! https://sqlite.org/rsync.html . Bundled SQLite is currently 3.53.2, but DBPAGE
//! is disabled by default. This module refuses unsupported builds; it enables no
//! compile flags and never changes the canonical database or legacy backup.
//!
//! Caller must retain the actual single native storage writer/root authority for
//! open/capture/publication. `validate` must run the EXISTING full schema,
//! quick_check and foreign_key_check gate on the supplied pinned connection.
//! Complete page scanning includes freelist, indexes, private manifests and all
//! write families. Only changed immutable chunks are written; source validation
//! and checksum-verified reuse still read the whole image. No speed claim yet.
//!
//! No GC: previous generations and orphan chunks survive. Explicit quotas refuse
//! growth; the owner may fall back to the existing full backup. Never remove an
//! old generation based on age, guessed jobs or table-specific revisions.
//!
//! Remaining acceptance: Android/Windows power-loss/rename durability, disk-full,
//! cancellation, all-family/schema/growth/shrink fixtures, strict restore gates,
//! measured latency, and root integration preserving truthful COMMIT receipts.
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::{self, File}, io::{Read, Write}, path::{Path, PathBuf}};
use tempfile::NamedTempFile;

const ERR: &str = "sqlite-chunk-backup-refused";
const CHUNK: usize = 64 * 1024;
const IMAGE_MAX: u64 = 512 * 1024 * 1024;
const MANIFEST_MAX: usize = 1024 * 1024;
const STORE_MAX: u64 = 2 * 1024 * 1024 * 1024;
const FILES_MAX: usize = 32768;
const CURRENT: &str = "CURRENT.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema_version: u8,
    generation: String,
    page_size: usize,
    page_count: u64,
    chunks: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pointer {
    schema_version: u8,
    current: String,
    previous: Option<String>,
}
/// Native-only receipt. A crossed pointer publication is not cancellation.
pub(crate) struct Receipt {
    pub committed: bool,
    pub manifest_hash: String,
    pub previous_manifest_hash: Option<String>,
    pub image_bytes: u64,
    pub written_chunk_bytes: u64,
    pub reused_chunks: usize,
    /// Pointer rename succeeded but directory durability could not be confirmed.
    /// Owner must preserve this receipt and prevent the subsequent main write.
    pub durability_pending: bool,
}
/// Retained under the caller's native writer. Failed capture requires reopen,
/// because durable orphan files may have been created before cancellation.
pub(crate) struct ChunkStore {
    directory: PathBuf,
    bytes: u64,
    files: usize,
    poisoned: bool,
}
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
fn key(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn ordinary(path: &Path, directory: bool) -> Result<(), String> {
    let m = fs::symlink_metadata(path).map_err(|_| ERR)?;
    if m.file_type().is_symlink() || (directory && !m.is_dir()) || (!directory && !m.is_file()) {
        return Err(ERR.into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 { return Err(ERR.into()); }
    }
    Ok(())
}
fn read_bounded(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    ordinary(path, false)?;
    let mut bytes = Vec::new();
    File::open(path).map_err(|_| ERR)?.take(max as u64 + 1)
        .read_to_end(&mut bytes).map_err(|_| ERR)?;
    if bytes.len() > max { return Err(ERR.into()); }
    Ok(bytes)
}
fn pointer(directory: &Path) -> Result<Option<Pointer>, String> {
    let p = directory.join(CURRENT);
    match fs::symlink_metadata(&p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ERR.into()),
        Ok(_) => (),
    }
    let value: Pointer = serde_json::from_slice(&read_bounded(&p, 1024)?).map_err(|_| ERR)?;
    if value.schema_version != 1 || !key(&value.current)
        || value.previous.as_ref().is_some_and(|s| !key(s)) {
        return Err(ERR.into());
    }
    Ok(Some(value))
}
fn manifest(directory: &Path, id: &str) -> Result<Manifest, String> {
    if !key(id) { return Err(ERR.into()); }
    let bytes = read_bounded(&directory.join(format!("manifest-{id}.json")), MANIFEST_MAX)?;
    if hash(&bytes) != id { return Err(ERR.into()); }
    let value: Manifest = serde_json::from_slice(&bytes).map_err(|_| ERR)?;
    let size = value.page_count.checked_mul(value.page_size as u64).ok_or(ERR)?;
    if value.schema_version != 1 || value.generation.len() != 32
        || !value.generation.bytes().all(|b| b.is_ascii_hexdigit())
        || !value.page_size.is_power_of_two() || !(512..=CHUNK).contains(&value.page_size)
        || size == 0 || size > IMAGE_MAX
        || value.chunks.len() != size.div_ceil(CHUNK as u64) as usize
        || value.chunks.iter().any(|s| !key(s)) {
        return Err(ERR.into());
    }
    Ok(value)
}
// POSIX rename metadata must be flushed. On Windows use WRITE_THROUGH rather
// than a silently unsupported directory fsync. Platform fault proof remains OPEN.
fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(not(windows))]
    { File::open(path).map_err(|_| ERR)?.sync_all().map_err(|_| ERR)?; }
    #[cfg(windows)]
    { let _ = path; }
    Ok(())
}
fn rename(temp: NamedTempFile, target: &Path, replace: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let (file, path) = temp.into_parts();
        drop(file);
        let from: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        let flags = MOVEFILE_WRITE_THROUGH | if replace { MOVEFILE_REPLACE_EXISTING } else { 0 };
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) } == 0 { return Err(ERR.into()); }
        // TempPath's removal attempt only addresses the now absent original name.
    }
    #[cfg(not(windows))]
    {
        if replace { temp.persist(target).map_err(|_| ERR)?; }
        else { temp.persist_noclobber(target).map_err(|_| ERR)?; }
    }
    Ok(())
}
impl ChunkStore {
    /// Directory must already exist inside the owner's admitted local data root.
    /// Does not enumerate/read provider content or initialize canonical storage.
    pub(crate) fn open(directory: &Path) -> Result<Self, String> {
        ordinary(directory, true)?;
        let directory = directory.canonicalize().map_err(|_| ERR)?;
        let mut bytes = 0u64;
        let mut files = 0usize;
        for entry in fs::read_dir(&directory).map_err(|_| ERR)? {
            let entry = entry.map_err(|_| ERR)?;
            ordinary(&entry.path(), false)?;
            files = files.checked_add(1).ok_or(ERR)?;
            bytes = bytes.checked_add(entry.metadata().map_err(|_| ERR)?.len()).ok_or(ERR)?;
            if files > FILES_MAX || bytes > STORE_MAX { return Err(ERR.into()); }
        }
        let head = pointer(&directory)?;
        if let Some(head) = head { manifest(&directory, &head.current)?; }
        Ok(Self { directory, bytes, files, poisoned: false })
    }
    pub(crate) fn head(&self) -> Result<Option<String>, String> {
        if self.poisoned { return Err(ERR.into()); }
        Ok(pointer(&self.directory)?.map(|p| p.current))
    }
    /// Cold recovery order: current, retained previous, then owner's legacy DB
    /// backup. Each candidate still needs materialize's complete validation.
    pub(crate) fn recovery_heads(&self) -> Result<Option<(String, Option<String>)>, String> {
        Ok(pointer(&self.directory)?.map(|p| (p.current, p.previous)))
    }
    fn reserve(&self, amount: usize) -> Result<(), String> {
        if self.files >= FILES_MAX || self.bytes.checked_add(amount as u64).ok_or(ERR)? > STORE_MAX {
            return Err("sqlite-chunk-backup-quota".into());
        }
        Ok(())
    }
    fn immutable(&mut self, name: &str, bytes: &[u8]) -> Result<bool, String> {
        let target = self.directory.join(name);
        match fs::symlink_metadata(&target) {
            Ok(_) => {
                // Reuse is proved by content, not a filename or prior in-memory cache.
                if read_bounded(&target, bytes.len())? != bytes { return Err(ERR.into()); }
                return Ok(false);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(ERR.into()),
        }
        self.reserve(bytes.len())?;
        let mut tmp = NamedTempFile::new_in(&self.directory).map_err(|_| ERR)?;
        tmp.write_all(bytes).map_err(|_| ERR)?;
        tmp.as_file().sync_all().map_err(|_| ERR)?;
        rename(tmp, &target, false)?;
        sync_directory(&self.directory)?;
        self.bytes += bytes.len() as u64;
        self.files += 1;
        Ok(true)
    }
    /// `expected_head` is captured under the same caller-owned writer authority.
    /// No post-publication cancellation check may hide the committed receipt.
    pub(crate) fn capture(
        &mut self, source: &Connection, expected_head: Option<&str>,
        mut validate: impl FnMut(&Connection) -> Result<(), String>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Receipt, String> {
        if self.poisoned { return Err(ERR.into()); }
        let result = self.capture_inner(source, expected_head, &mut validate, &mut check);
        if result.is_err() { self.poisoned = true; }
        result
    }
    fn capture_inner(
        &mut self, source: &Connection, expected_head: Option<&str>,
        validate: &mut impl FnMut(&Connection) -> Result<(), String>,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<Receipt, String> {
        check()?;
        if !source.is_autocommit() || self.head()?.as_deref() != expected_head { return Err(ERR.into()); }
        let enabled: bool = source.query_row("SELECT sqlite_compileoption_used('ENABLE_DBPAGE_VTAB')", [], |r| r.get(0)).map_err(|_| ERR)?;
        if !enabled { return Err("sqlite-chunk-backup-dbpage-unavailable".into()); }
        let pinned = source.unchecked_transaction().map_err(|_| ERR)?;
        pinned.query_row("SELECT count(*) FROM sqlite_schema", [], |r| r.get::<_, i64>(0)).map_err(|_| ERR)?;
        // Same immutable snapshot as raw pages. No stale destination-schema cache.
        validate(&pinned)?;
        check()?;
        let page_size = usize::try_from(pinned.query_row("PRAGMA main.page_size", [], |r| r.get::<_, i64>(0)).map_err(|_| ERR)?).map_err(|_| ERR)?;
        let page_count = u64::try_from(pinned.query_row("PRAGMA main.page_count", [], |r| r.get::<_, i64>(0)).map_err(|_| ERR)?).map_err(|_| ERR)?;
        let image_bytes = page_count.checked_mul(page_size as u64).ok_or(ERR)?;
        if !page_size.is_power_of_two() || !(512..=CHUNK).contains(&page_size)
            || image_bytes == 0 || image_bytes > IMAGE_MAX { return Err(ERR.into()); }
        let mut chunks = Vec::with_capacity(image_bytes.div_ceil(CHUNK as u64) as usize);
        let mut buffer = Vec::with_capacity(CHUNK);
        let mut written = 0u64;
        let mut reused = 0usize;
        let mut next = 1u64;
        {
            let mut stmt = pinned.prepare("SELECT pgno,data FROM sqlite_dbpage('main') ORDER BY pgno").map_err(|_| ERR)?;
            let mut rows = stmt.query([]).map_err(|_| ERR)?;
            while let Some(row) = rows.next().map_err(|_| ERR)? {
                check()?;
                let number = u64::try_from(row.get::<_, i64>(0).map_err(|_| ERR)?).map_err(|_| ERR)?;
                let data: Vec<u8> = row.get(1).map_err(|_| ERR)?;
                if number != next || number > page_count || data.len() != page_size { return Err(ERR.into()); }
                next += 1;
                buffer.extend_from_slice(&data);
                if buffer.len() == CHUNK || number == page_count {
                    let id = hash(&buffer);
                    if self.immutable(&format!("chunk-{id}.bin"), &buffer)? { written += buffer.len() as u64; }
                    else { reused += 1; }
                    chunks.push(id);
                    buffer.clear();
                }
            }
        }
        if next != page_count + 1 || !buffer.is_empty() { return Err(ERR.into()); }
        let mut entropy = [0u8; 16];
        getrandom::fill(&mut entropy).map_err(|_| ERR)?;
        let generation = entropy.iter().map(|b| format!("{b:02x}")).collect();
        let value = Manifest { schema_version: 1, generation, page_size, page_count, chunks };
        let encoded = serde_json::to_vec(&value).map_err(|_| ERR)?;
        if encoded.len() > MANIFEST_MAX { return Err(ERR.into()); }
        let id = hash(&encoded);
        self.immutable(&format!("manifest-{id}.json"), &encoded)?;
        // Retain the READ snapshot through publication: another DELETE-mode
        // writer cannot change the prewrite image during pointer installation.
        check()?;
        if self.head()?.as_deref() != expected_head { return Err(ERR.into()); }
        let previous = expected_head.map(str::to_owned);
        let encoded = serde_json::to_vec(&Pointer { schema_version: 1, current: id.clone(), previous: previous.clone() }).map_err(|_| ERR)?;
        self.reserve(encoded.len())?;
        let mut tmp = NamedTempFile::new_in(&self.directory).map_err(|_| ERR)?;
        tmp.write_all(&encoded).map_err(|_| ERR)?;
        tmp.as_file().sync_all().map_err(|_| ERR)?;
        let old_size = fs::metadata(self.directory.join(CURRENT)).map(|m| m.len()).unwrap_or(0);
        check()?; // Final cancel/root fence before the irreversible publication.
        let renamed = rename(tmp, &self.directory.join(CURRENT), true);
        let mut durability_pending = false;
        if renamed.is_err() {
            // An I/O error must not hide a proven crossed publication.
            if pointer(&self.directory)?.is_some_and(|p| p.current == id) {
                durability_pending = true;
            } else {
                return Err(ERR.into());
            }
        }
        durability_pending |= sync_directory(&self.directory).is_err();
        // Read-only close failure after publication is likewise a committed
        // recovery image with pending durability/cleanup, never cancellation.
        durability_pending |= pinned.commit().is_err();
        self.bytes = self.bytes.saturating_sub(old_size) + encoded.len() as u64;
        if previous.is_none() { self.files += 1; }
        self.poisoned = durability_pending;
        Ok(Receipt { committed: true, manifest_hash: id, previous_manifest_hash: previous,
            image_bytes, written_chunk_bytes: written, reused_chunks: reused, durability_pending })
    }
    /// Materialize to a private temporary file. Root installs it only after this
    /// returns; legacy recovery remains available if this generation is refused.
    pub(crate) fn materialize(
        &self, id: &str, output_directory: &Path,
        mut validate: impl FnMut(&Connection) -> Result<(), String>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<NamedTempFile, String> {
        ordinary(output_directory, true)?;
        let m = manifest(&self.directory, id)?;
        let size = m.page_count.checked_mul(m.page_size as u64).ok_or(ERR)?;
        let mut remaining = size;
        let mut temp = NamedTempFile::new_in(output_directory).map_err(|_| ERR)?;
        for id in &m.chunks {
            check()?;
            let expected = remaining.min(CHUNK as u64) as usize;
            let bytes = read_bounded(&self.directory.join(format!("chunk-{id}.bin")), CHUNK)?;
            if bytes.len() != expected || hash(&bytes) != *id { return Err(ERR.into()); }
            temp.write_all(&bytes).map_err(|_| ERR)?;
            remaining -= expected as u64;
        }
        if remaining != 0 { return Err(ERR.into()); }
        temp.as_file().sync_all().map_err(|_| ERR)?;
        {
            let c = Connection::open_with_flags(temp.path(), OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|_| ERR)?;
            c.execute_batch("PRAGMA query_only=ON;PRAGMA trusted_schema=OFF;").map_err(|_| ERR)?;
            validate(&c)?;
        }
        check()?;
        Ok(temp)
    }
}
