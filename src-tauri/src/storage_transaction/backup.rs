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

//! Online backups of the catalog database: the backup rendezvous and verifier,
//! copying pages, and PairStore's backup and recovery methods.

use super::*;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum BackupPhase {
    SnapshotPinned,
    BeforeStep,
    StepCompleted,
    BeforeVerify,
    QuickCheckProgress,
    ForeignKeyProgress,
    BeforeSync,
    BeforeReplace,
}

// SQLite still calls us every 1000 VM operations. Only the expensive owner
// rendezvous is gated: first callback of each phase, then 10ms since the last
// successful reply. No integrity result is cached or omitted. BeforeSync and
// BeforeReplace still consult the original, possibly borrowed FnMut authority.
// Worker, channels and callback are retained and joined on refusal or unwind.
#[derive(Default)]
pub(super) struct BackupRendezvous {
    observed: Option<std::time::Instant>,
    granted: Option<(BackupPhase, std::time::Instant)>,
    refused_clock: bool,
}

impl BackupRendezvous {
    pub(super) const INTERVAL: Duration = Duration::from_millis(10);
    pub(super) fn observe(&mut self, now: std::time::Instant) -> Result<(), ()> {
        if self.refused_clock
            || self
                .observed
                .is_some_and(|previous| now.checked_duration_since(previous).is_none())
        {
            self.refused_clock = true;
            return Err(());
        }
        self.observed = Some(now);
        Ok(())
    }
    pub(super) fn due(&mut self, phase: BackupPhase, now: std::time::Instant) -> Result<bool, ()> {
        self.observe(now)?;
        Ok(self.granted.is_none_or(|(previous_phase, replied)| {
            phase != previous_phase || now.duration_since(replied) >= Self::INTERVAL
        }))
    }
    pub(super) fn grant(
        &mut self,
        phase: BackupPhase,
        replied: std::time::Instant,
    ) -> Result<(), ()> {
        self.observe(replied)?;
        self.granted = Some((phase, replied));
        Ok(())
    }
}

pub(super) struct BackupVerifier {
    progress: Option<std::sync::mpsc::Receiver<BackupPhase>>,
    replies: Option<std::sync::mpsc::SyncSender<bool>>,
    worker: Option<std::thread::JoinHandle<Result<(), String>>>,
}

impl BackupVerifier {
    pub(super) fn join(&mut self) -> Result<(), String> {
        // Disconnect both endpoints before joining, including during unwind.
        // A blocked send/recv in the SQL callback then refuses continuation.
        self.progress.take();
        self.replies.take();
        self.worker
            .take()
            .ok_or("sqlite-verification-worker-failed")?
            .join()
            .map_err(|_| "sqlite-verification-worker-failed")?
    }
}

impl Drop for BackupVerifier {
    fn drop(&mut self) {
        if self.worker.is_some() {
            let _ = self.join();
        }
    }
}

pub(super) fn verify_backup_owned(
    path: &Path,
    phase: &mut impl FnMut(BackupPhase) -> Result<(), String>,
) -> Result<(), String> {
    use std::sync::{
        atomic::{AtomicU8, Ordering},
        mpsc, Arc,
    };
    let (progress_tx, progress_rx) = mpsc::sync_channel(1);
    let (reply_tx, reply_rx) = mpsc::sync_channel(0);
    let path = path.to_owned();
    let worker = std::thread::Builder::new()
        .name("genx-backup-verifier".into())
        .spawn(move || {
            let copy = connect(&path, true)?;
            // Use the same bounded connection-local read policy as startup.
            // The private snapshot is still checked in full, closed and joined
            // before sync/replacement; mmap may fall back to ordinary reads.
            sql(copy.execute_batch(&InspectionPager::DEFAULT.configuration()?))?;
            let marker = Arc::new(AtomicU8::new(0));
            let callback_marker = marker.clone();
            let mut rendezvous = BackupRendezvous::default();
            sql(copy.progress_handler(
                1000,
                Some(move || {
                    let stage = if callback_marker.load(Ordering::Relaxed) == 2 {
                        BackupPhase::ForeignKeyProgress
                    } else {
                        BackupPhase::QuickCheckProgress
                    };
                    match rendezvous.due(stage, std::time::Instant::now()) {
                        Ok(false) => return false,
                        Ok(true) => (),
                        Err(()) => return true,
                    }
                    if progress_tx.send(stage).is_err() || !matches!(reply_rx.recv(), Ok(true)) {
                        return true;
                    }
                    // Start the interval after the actual successful reply, not
                    // before a potentially slow authority check or scheduler wait.
                    rendezvous.grant(stage, std::time::Instant::now()).is_err()
                }),
            ))?;
            let result = integrity_parts(&copy, Some(&marker));
            // Clear while the connection still exists. Closing it on any panic also
            // releases the callback/channels; the retained owner always joins us.
            let cleared = sql(copy.progress_handler(0, None::<fn() -> bool>));
            result.and(cleared)
        })
        .map_err(|_| "sqlite-verification-worker-failed")?;
    let mut verifier = BackupVerifier {
        progress: Some(progress_rx),
        replies: Some(reply_tx),
        worker: Some(worker),
    };
    let mut refused = None;
    while let Ok(step) = verifier
        .progress
        .as_ref()
        .ok_or("sqlite-verification-worker-failed")?
        .recv()
    {
        crate::storage_timings::backup_verification_handshake();
        let permitted = if refused.is_some() {
            false
        } else {
            match phase(step) {
                Ok(()) => true,
                Err(error) => {
                    refused = Some(error);
                    false
                }
            }
        };
        if verifier
            .replies
            .as_ref()
            .ok_or("sqlite-verification-worker-failed")?
            .send(permitted)
            .is_err()
        {
            break;
        }
    }
    let result = verifier.join();
    match refused {
        Some(error) => Err(error),
        None => result,
    }
}

// Copy existing SQLite pages without rebuilding indexes. Unlike VACUUM INTO,
// this retains freelist pages: it is not a secure-deletion or compacting step.
pub(crate) fn copy_sqlite_snapshot_checked(
    source: &Connection,
    destination: &mut Connection,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    copy_backup_pages(source, destination, &mut |_| check())
}

pub(super) fn copy_backup_pages(
    source: &Connection,
    destination: &mut Connection,
    phase: &mut impl FnMut(BackupPhase) -> Result<(), String>,
) -> Result<(), String> {
    const PAGES_PER_STEP: i32 = 64;
    let pinned = sql(source.unchecked_transaction())?;
    // Establish a read snapshot before copying, preventing a changing source
    // from restarting the backup or mixing pre-write revisions between steps.
    sql(
        pinned.query_row("SELECT count(*) FROM sqlite_schema", [], |r| {
            r.get::<_, i64>(0)
        }),
    )?;
    let page_count: i64 = sql(pinned.query_row("PRAGMA page_count", [], |r| r.get(0)))?;
    let pages = u64::try_from(page_count).map_err(|_| "sqlite-operation-failed")?;
    let step_limit = pages.max(1).div_ceil(PAGES_PER_STEP as u64) + 1;
    phase(BackupPhase::SnapshotPinned)?;
    {
        let backup = sql(rusqlite::backup::Backup::new(&pinned, destination))?;
        let mut complete = false;
        for _ in 0..step_limit {
            phase(BackupPhase::BeforeStep)?;
            let step = sql(backup.step(PAGES_PER_STEP))?;
            phase(BackupPhase::StepCompleted)?;
            match step {
                rusqlite::backup::StepResult::Done => {
                    complete = true;
                    break;
                }
                rusqlite::backup::StepResult::More => {}
                // Keep existing bounded SQLite busy handling; never spin/retry
                // a busy or locked source/destination indefinitely.
                _ => return Err("sqlite-operation-failed".into()),
            }
        }
        if !complete {
            return Err("sqlite-operation-failed".into());
        }
        // Drop Backup (finish) before destination verification or use.
    }
    sql(pinned.commit())?;
    Ok(())
}

impl PairStore {
    #[cfg(test)]
    pub(super) fn recover_observed(
        &self,
        mut observe: impl FnMut(RecoveryPhase),
    ) -> Result<(), String> {
        let lease = crate::archive_library_store::lock_root(&self.root)?;
        self.recover_observed_locked(&lease, &mut observe)
    }

    pub(super) fn recover_observed_locked(
        &self,
        lease: &crate::archive_library_store::RootLock,
        observe: &mut impl FnMut(RecoveryPhase),
    ) -> Result<(), String> {
        // Inspect the permanent authority before any older canonical peer can
        // be considered for recovery. Invalid markers never authorize fallback.
        let mut authority = crate::archive_library_store::inspect(&self.root)?;
        if authority.is_none() {
            let directory = self.root.join("archive-library-v1");
            refuse_link(&directory)?;
            let mut orphan = false;
            for name in ["archive.sqlite3", "archive.sqlite3.backup"] {
                let path = directory.join(name);
                refuse_link(&path)?;
                orphan |= path
                    .try_exists()
                    .map_err(|_| crate::archive_library_store::REPAIR)?;
            }
            if orphan {
                // Only an exact, unadopted sequence-zero export can recreate a
                // PREPARED witness. Never restore a main peer first and then
                // discover that a committed namespace forbids that history.
                let source = connect(&self.root.join(DB), true)
                    .map_err(|_| crate::archive_library_store::REPAIR)?;
                crate::archive_library_store::prepare(lease, &source, &mut || Ok(()))?;
                authority = crate::archive_library_store::inspect(&self.root)?;
            }
        }
        if let Some(witness) = authority.as_ref() {
            let _caller = crate::storage_timings::archive_caller(
                crate::storage_timings::ArchiveCaller::RecoveryHandoff,
            );
            crate::archive_library_store::verify_handoff_pair(
                lease,
                &witness.binding,
                &mut || Ok(()),
            )?;
        }
        let main = self.root.join(DB);
        let backup = self.root.join(BACKUP);
        refuse_link(&main)?;
        refuse_link(&backup)?;
        if self.require_database && !main.is_file() {
            return Err("sqlite-required-database-missing".into());
        }
        let journal_present = ["-journal", "-wal", "-shm"]
            .iter()
            .any(|suffix| self.root.join(format!("{DB}{suffix}")).exists());
        if main.exists() && journal_present {
            let mut header = [0_u8; 16];
            if File::open(&main)
                .and_then(|mut file| file.read_exact(&mut header))
                .is_err()
                || &header != b"SQLite format 3\0"
            {
                return Err("sqlite-recovery-journal-present".into());
            }
        }
        let inspection = if main.exists() {
            inspect_existing_database(&main, observe)?
        } else {
            Inspection::Corrupt
        };
        if inspection != Inspection::Corrupt {
            if let Some(witness) = authority.as_ref() {
                if !archive_peer_matches(&connect(&main, true)?, witness)? {
                    return Err(crate::archive_library_store::REPAIR.into());
                }
            }
        }
        if inspection == Inspection::HealthyCurrent {
            // Current DELETE databases require no startup mutation. Reuse the
            // coherent schema/quick-check/FK proof; writes configure their own
            // connection later. Never reuse it for migrations or mode changes.
            observe(RecoveryPhase::ProofReused);
            return Ok(());
        }
        if inspection == Inspection::HealthyNeedsMutation {
            let mut c = connect(&main, false)?;
            let version = sql(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))?;
            // Capture the current derived-policy authority before its verified
            // backup. Older schemas are fenced by their existing migration.
            let projection_fence = if version >= 15 {
                crate::catalog_query::projection_upgrade_fence(&c)?
            } else {
                None
            };
            if version < 16 || projection_fence.is_some() {
                self.backup_now(&c)?;
            }
            {
                let _time = crate::storage_timings::measure(
                    crate::storage_timings::Stage::RecoveryMigration,
                );
                observe(RecoveryPhase::Migration);
                migrate(&mut c)?;
                crate::catalog_query::upgrade_projection_policy(&mut c, projection_fence)?;
            }
            {
                let _time = crate::storage_timings::measure(
                    crate::storage_timings::Stage::RecoveryFinalIntegrity,
                );
                observe(RecoveryPhase::FinalIntegrity);
                integrity(&c)?;
            }
            return Ok(());
        }
        if backup.exists() {
            let c = connect(&backup, true)?;
            integrity(&c)?;
            if let Some(witness) = authority.as_ref() {
                if !archive_peer_matches(&c, witness)? {
                    return Err(crate::archive_library_store::REPAIR.into());
                }
            }
            drop(c);
            if journal_present {
                return Err("sqlite-recovery-journal-present".into());
            }
            let mut tmp = tempfile::NamedTempFile::new_in(&self.root)
                .map_err(|_| "sqlite-recovery-failed")?;
            std::io::copy(
                &mut File::open(&backup).map_err(|_| "sqlite-recovery-failed")?,
                &mut tmp,
            )
            .map_err(|_| "sqlite-recovery-failed")?;
            tmp.as_file()
                .sync_all()
                .map_err(|_| "sqlite-recovery-failed")?;
            tmp.persist(&main).map_err(|_| "sqlite-recovery-failed")?;
            let mut restored = connect(&main, false)?;
            {
                let _time = crate::storage_timings::measure(
                    crate::storage_timings::Stage::RecoveryMigration,
                );
                observe(RecoveryPhase::Migration);
                migrate(&mut restored)?;
                crate::catalog_query::upgrade_projection_policy(&mut restored, None)?;
            }
            {
                let _time = crate::storage_timings::measure(
                    crate::storage_timings::Stage::RecoveryFinalIntegrity,
                );
                observe(RecoveryPhase::FinalIntegrity);
                integrity(&restored)?;
            }
            return Ok(());
        }
        if main.exists() {
            return Err("sqlite-recovery-unavailable".into());
        }
        if authority.is_some() {
            // A permanent Archive authority proves this was an existing root.
            // Missing canonical peers are not permission to erase Live data by
            // silently manufacturing a fresh main database.
            return Err(crate::archive_library_store::REPAIR.into());
        }
        let legacy = legacy_pair(&self.root)?;
        let tmp =
            tempfile::NamedTempFile::new_in(&self.root).map_err(|_| "sqlite-create-failed")?;
        {
            let mut c = connect(tmp.path(), false)?;
            let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
            sql(tx.execute_batch(SCHEMA))?;
            sql(tx.commit())?;
            {
                let _time = crate::storage_timings::measure(
                    crate::storage_timings::Stage::RecoveryMigration,
                );
                observe(RecoveryPhase::Migration);
                migrate(&mut c)?;
            }
            Self::apply(&mut c, &legacy, |_| Ok(()))?;
            {
                let _time = crate::storage_timings::measure(
                    crate::storage_timings::Stage::RecoveryFinalIntegrity,
                );
                observe(RecoveryPhase::FinalIntegrity);
                integrity(&c)?;
            }
        }
        tmp.as_file()
            .sync_all()
            .map_err(|_| "sqlite-create-failed")?;
        tmp.persist(main).map_err(|_| "sqlite-create-failed")?;
        Ok(())
    }

    pub(super) fn backup(&self, c: &Connection) -> Result<(), String> {
        self.backup_with_check(c, || Ok(()))
    }

    /// Before an ordinary write: reuse a verified backup younger than the
    /// write-backup interval, otherwise take one now (see storage_backup_policy).
    pub(super) fn backup_with_check(
        &self,
        c: &Connection,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        if crate::storage_backup_policy::fresh(&self.root.join(BACKUP), write_backup_interval()) {
            check()?;
        } else {
            self.backup_now_with_check(c, &mut check)?;
        }
        crate::storage_backup_policy::note_write();
        Ok(())
    }

    /// Upgrade and recovery paths: always take a fresh verified backup.
    pub(super) fn backup_now(&self, c: &Connection) -> Result<(), String> {
        self.backup_now_with_check(c, || Ok(()))
    }

    pub(super) fn backup_now_with_check(
        &self,
        c: &Connection,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        check()?;
        self.backup_observed(c, &mut |_| check())?;
        crate::storage_backup_policy::note_backed_up();
        Ok(())
    }

    /// The background refresh: a compact copy (`VACUUM INTO`, live pages only)
    /// from a read-only connection, the same full verification as every backup,
    /// then an atomic swap. `abort` is polled throughout; returning true stops
    /// the copy and leaves the previous backup in place. The caller holds the
    /// writer lease, so the copy is a consistent image.
    pub(crate) fn compact_backup(
        &self,
        abort: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<(), String> {
        let path = self.root.join(BACKUP);
        refuse_link(&path)?;
        if abort() {
            return Err("storage-backup-deferred".into());
        }
        let tmp =
            tempfile::NamedTempFile::new_in(&self.root).map_err(|_| "sqlite-backup-failed")?;
        {
            let source = connect(&self.root.join(DB), true)?;
            let stop = abort.clone();
            sql(source.progress_handler(1000, Some(move || stop())))?;
            let target = tmp
                .path()
                .to_str()
                .ok_or("sqlite-backup-failed")?
                .to_owned();
            let copied = source.execute("VACUUM INTO ?1", [target]);
            let _ = source.progress_handler(0, None::<fn() -> bool>);
            if abort() {
                return Err("storage-backup-deferred".into());
            }
            copied.map_err(|_| "sqlite-backup-failed")?;
        }
        verify_backup_owned(tmp.path(), &mut |_| {
            if abort() {
                Err("storage-backup-deferred".into())
            } else {
                Ok(())
            }
        })?;
        tmp.as_file()
            .sync_all()
            .map_err(|_| "sqlite-backup-failed")?;
        if abort() {
            return Err("storage-backup-deferred".into());
        }
        tmp.persist(&path).map_err(|_| "sqlite-backup-failed")?;
        crate::storage_backup_policy::note_backed_up();
        Ok(())
    }

    pub(crate) fn backup_path(&self) -> PathBuf {
        self.root.join(BACKUP)
    }

    pub(super) fn backup_observed(
        &self,
        c: &Connection,
        phase: &mut impl FnMut(BackupPhase) -> Result<(), String>,
    ) -> Result<(), String> {
        let _time = crate::storage_timings::measure(crate::storage_timings::Stage::Backup);
        let path = self.root.join(BACKUP);
        refuse_link(&path)?;
        let tmp =
            tempfile::NamedTempFile::new_in(&self.root).map_err(|_| "sqlite-backup-failed")?;
        {
            let _copy = crate::storage_timings::measure(crate::storage_timings::Stage::BackupCopy);
            let mut destination = connect(tmp.path(), false)?;
            copy_backup_pages(c, &mut destination, phase)?;
        }
        phase(BackupPhase::BeforeVerify)?;
        verify_backup_owned(tmp.path(), phase)?;
        phase(BackupPhase::BeforeSync)?;
        {
            let _sync = crate::storage_timings::measure(crate::storage_timings::Stage::BackupSync);
            tmp.as_file()
                .sync_all()
                .map_err(|_| "sqlite-backup-failed")?;
        }
        phase(BackupPhase::BeforeReplace)?;
        let _replace =
            crate::storage_timings::measure(crate::storage_timings::Stage::BackupReplace);
        tmp.persist(path).map_err(|_| "sqlite-backup-failed")?;
        Ok(())
    }
}
