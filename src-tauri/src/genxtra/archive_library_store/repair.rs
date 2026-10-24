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

//! Backing up and repairing the archive library: mirrors, journals, copies,
//! image digests and the initialization pair.

use super::*;

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackupPhase {
    BeforeCopy,
    AfterCopy,
    BeforePublish,
    AfterPublish,
}

#[cfg(test)]
pub(super) type BackupHook = Box<dyn FnMut(BackupPhase) -> Result<(), String>>;

#[cfg(test)]
thread_local! { pub(super) static BACKUP_HOOK: std::cell::RefCell<Option<BackupHook>> = std::cell::RefCell::new(None); }

#[cfg(test)]
pub(crate) struct BackupObserver {
    pub(super) previous: Option<BackupHook>,
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
pub(super) fn backup_phase(phase: BackupPhase) -> Result<(), String> {
    BACKUP_HOOK.with(|slot| match slot.borrow_mut().as_mut() {
        Some(hook) => hook(phase),
        None => Ok(()),
    })
}

pub(super) fn mirror(
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

pub(super) fn journals(path: &Path) -> bool {
    ["-journal", "-wal", "-shm"].iter().any(|s| {
        path.with_file_name(format!(
            "{}{}",
            path.file_name().unwrap_or_default().to_string_lossy(),
            s
        ))
        .exists()
    })
}

pub(super) fn read_copy(
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

pub(super) fn repair_pair(
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
pub(super) struct PairImages {
    pub(super) primary: [u8; 32],
    pub(super) backup: [u8; 32],
    pub(super) witness: [u8; 32],
}

#[derive(Clone)]
pub(super) struct InitializationProof {
    pub(super) images: PairImages,
    pub(super) snapshot: Snapshot,
}

pub(super) fn image_sha(
    path: &Path,
    limit: u64,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Option<[u8; 32]>, String> {
    let first = image_sha_once(path, limit, check)?;
    // Reopen the pathname: a rename during a guard must not validate an old FD.
    let second = image_sha_once(path, limit, check)?;
    Ok(first.filter(|value| second.as_ref() == Some(value)))
}

pub(super) fn image_sha_once(
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

pub(super) fn initialization_images(
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
pub(super) fn initialization_pair(
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
