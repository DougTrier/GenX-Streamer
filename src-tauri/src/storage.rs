use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(test)]
pub fn read_initial_pair(
    current: &mut Result<Store, String>,
    succeeded: &std::sync::atomic::AtomicBool,
) -> Result<crate::storage_transaction::RecordSnapshot, String> {
    use std::sync::atomic::Ordering;
    let result = current
        .as_ref()
        .map_err(Clone::clone)
        .and_then(Store::read_snapshot);
    match &result {
        Ok(_) => succeeded.store(true, Ordering::SeqCst),
        Err(error) if !succeeded.load(Ordering::SeqCst) => *current = Err(error.clone()),
        Err(_) => {}
    }
    result
}

pub fn data_root(default: PathBuf) -> Result<(PathBuf, String), Box<dyn std::error::Error>> {
    if let Some(path) = std::env::var_os("TMG_DATA_DIR") {
        let root = PathBuf::from(path);
        if !root.is_absolute() {
            return Err("TMG_DATA_DIR must be an absolute writable directory".into());
        }
        return Ok((root, "explicit-directory".into()));
    }
    #[cfg(desktop)]
    {
        let exe = std::env::current_exe()?;
        if let Some(parent) = exe.parent() {
            if parent.join("tmg-portable.flag").is_file() {
                return Ok((parent.join("data"), "portable".into()));
            }
        }
    }
    Ok((default, "application-data".into()))
}

#[cfg(windows)]
pub fn data_root_with_bookmark(
    default: PathBuf,
    bookmarks: &Result<crate::storage_recovery::Bookmarks, String>,
) -> Result<(PathBuf, String), String> {
    if std::env::var_os("TMG_DATA_DIR").is_some() {
        return data_root(default).map_err(|_| "storage-directory-invalid".into());
    }
    if let Some(path) = bookmarks.as_ref().map_err(Clone::clone)?.read()? {
        return Ok((path, "explicit-directory".into()));
    }
    data_root(default).map_err(|_| "storage-directory-invalid".into())
}

pub struct Store {
    // A StoreOwner root lease pins both domains through actual work. Main writes
    // never acquire Archive's gate, and Archive/download work never acquires
    // the main gate. A future combined operation must take main, then Archive,
    // before namespace OS locks/SQL; neither gate may cross a network await.
    writer: std::sync::Mutex<()>,
    archive_writer: std::sync::Mutex<()>,
    pair: crate::storage_transaction::PairStore,
    archive: crate::archive_library_store::ArchiveStore,
    pub mode: String,
}

#[derive(Clone)]
pub struct StorageTarget {
    pub path: PathBuf,
    pub mode: String,
    pub require_existing: bool,
    pub require_database: bool,
}

pub fn retry_same_location(
    current: &mut Result<Store, String>,
    target: &Result<StorageTarget, String>,
    read_succeeded: &std::sync::atomic::AtomicBool,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<String, String> {
    use std::sync::atomic::Ordering;
    check()?;
    // A prepared explicit choice is healthy but has not yet been read by the UI.
    // Verify it in place; never replace it with the original startup target.
    if let Ok(store) = current {
        store.read_snapshot()?;
        check()?;
        return Ok(store.mode.clone());
    }
    if read_succeeded.load(Ordering::SeqCst) {
        return Err("storage-healthy-switch-refused".into());
    }
    let target = target.as_ref().map_err(Clone::clone)?;
    if target.require_existing && !target.path.is_dir() {
        let error = "storage-choice-directory-unavailable".to_string();
        *current = Err(error.clone());
        return Err(error);
    }
    let prepared: Result<Store, String> = (|| {
        let candidate = Store::open_target(target)?;
        candidate.read_snapshot()?;
        check()?;
        Ok(candidate)
    })();
    match prepared {
        Ok(candidate) => {
            *current = Ok(candidate);
            Ok(target.mode.clone())
        }
        Err(error) => {
            *current = Err(error.clone());
            Err(error)
        }
    }
}

pub(crate) fn refuse_link(path: &Path) -> Result<(), String> {
    for part in path.ancestors() {
        if let Ok(metadata) = fs::symlink_metadata(part) {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err("storage-link-refused".into());
                }
            }
            if metadata.file_type().is_symlink() {
                return Err("storage-link-refused".into());
            }
        }
    }
    Ok(())
}
#[cfg(test)]
#[path = "guide_preflight_storage_tests.rs"]
mod guide_preflight_tests;
#[cfg(test)]
#[path = "storage_retry_tests.rs"]
mod retry_tests;
#[cfg(test)]
#[path = "storage_writer_cancellation_tests.rs"]
mod writer_cancellation_tests;
#[cfg(test)]
#[path = "storage_writer_domains_tests.rs"]
mod writer_domains_tests;

impl Store {
    pub(crate) fn write_lease(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        let _time = crate::storage_timings::measure(crate::storage_timings::Stage::WriterAdmission);
        // A background backup holding the lease sees this and steps aside.
        let _waiting = crate::storage_backup_policy::WaitingWriter::begin();
        self.writer.lock().map_err(|_| "storage-writer-lock".into())
    }
    /// Refresh the verified backup when nothing else needs the writer: returns
    /// Ok(false) without waiting if a writer holds the lease, and stops early
    /// (leaving the previous backup) when `abort` turns true.
    pub(crate) fn background_backup(
        &self,
        abort: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<bool, String> {
        let Ok(_lease) = self.writer.try_lock() else {
            return Ok(false);
        };
        self.pair.compact_backup(abort)?;
        Ok(true)
    }
    pub(crate) fn backup_path(&self) -> PathBuf {
        self.pair.backup_path()
    }
    pub(crate) fn write_lease_checked(
        &self,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        Self::checked_writer(&self.writer, check)
    }
    pub(crate) fn archive_write_lease(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        let _time = crate::storage_timings::measure(crate::storage_timings::Stage::WriterAdmission);
        self.archive_writer
            .lock()
            .map_err(|_| "storage-writer-lock".into())
    }
    fn archive_write_lease_checked(
        &self,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        Self::checked_writer(&self.archive_writer, check)
    }
    fn checked_writer<'a>(
        writer: &'a std::sync::Mutex<()>,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<std::sync::MutexGuard<'a, ()>, String> {
        let _time = crate::storage_timings::measure(crate::storage_timings::Stage::WriterAdmission);
        let _waiting = crate::storage_backup_policy::WaitingWriter::begin();
        loop {
            check()?;
            match writer.try_lock() {
                Ok(lease) => {
                    check()?;
                    return Ok(lease);
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err("storage-writer-lock".into());
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    // Keep this on the retained blocking worker. A short sleep
                    // avoids spinning and permits owner cancellation while a
                    // different writer finishes its real durable operation.
                    // The existing mutex promises neither FIFO nor a deadline.
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }
    }
    #[cfg(any(windows, test))]
    pub fn new(root: PathBuf, mode: String) -> Result<Self, String> {
        Self::open(root, mode, false, false)
    }
    pub(crate) fn open_target(target: &StorageTarget) -> Result<Self, String> {
        Self::open(
            target.path.clone(),
            target.mode.clone(),
            target.require_existing,
            target.require_database,
        )
    }
    fn open(
        root: PathBuf,
        mode: String,
        require_existing: bool,
        require_database: bool,
    ) -> Result<Self, String> {
        let _startup_time =
            crate::storage_timings::measure(crate::storage_timings::Stage::StoreOpen);
        refuse_link(&root)?;
        if require_existing {
            if !root.is_dir() {
                return Err("storage-choice-directory-unavailable".into());
            }
        } else {
            fs::create_dir_all(&root).map_err(|_| "storage-directory-unavailable".to_string())?;
        }
        refuse_link(&root)?;
        // Probe the chosen location. Do not silently switch user data to another path.
        tempfile::NamedTempFile::new_in(&root)
            .map_err(|_| "storage-directory-read-only".to_string())?;
        // A second process must not recover an old main peer while this root's
        // Archive authority is being sealed or repaired.
        let initialization = {
            let _timing =
                crate::storage_timings::measure(crate::storage_timings::Stage::ArchiveRootLock);
            crate::archive_library_store::lock_root(&root)?
        };
        let pair = crate::storage_transaction::PairStore::new_existing_locked(
            root,
            require_database,
            &initialization,
        )?;
        let archive = pair.open_archive_library_locked(&initialization, &mut || Ok(()))?;
        drop(initialization);
        Ok(Self {
            pair,
            archive,
            mode,
            writer: std::sync::Mutex::new(()),
            archive_writer: std::sync::Mutex::new(()),
        })
    }
    pub fn read(&self, name: &str) -> Result<Option<String>, String> {
        self.pair.read(name)
    }
    #[cfg(test)]
    pub fn write(&self, name: &str, contents: &str) -> Result<(), String> {
        let _writer = self.write_lease()?;
        self.pair.write(name, contents)
    }
    pub fn read_snapshot(&self) -> Result<crate::storage_transaction::RecordSnapshot, String> {
        self.pair.read_snapshot()
    }
    pub fn read_guide_capture(
        &self,
    ) -> Result<crate::storage_transaction::GuideCaptureSnapshot, String> {
        self.pair.read_guide_capture()
    }
    pub(crate) fn query_catalog_page(
        &self,
        query: &crate::catalog_query::Query,
        canceled: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<crate::catalog_query::Page, String> {
        self.pair.query_catalog_page(query, canceled)
    }
    #[cfg(test)]
    pub fn write_guarded(
        &self,
        catalog: &str,
        preferences: &str,
        health: Option<&str>,
        expected: (Option<&str>, Option<&str>),
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::CommitReceipt, String> {
        let _writer = self.write_lease()?;
        self.pair
            .write_guarded_cas(catalog, preferences, health, expected, check)
    }
    pub(crate) fn mutate_catalog_group(
        &self,
        request: &crate::catalog_group_mutation::Request,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::CatalogGroupReceipt, String> {
        let _writer = self.write_lease()?;
        self.pair.mutate_catalog_group(request, check)
    }
    pub fn write_pair_with_scan(
        &self,
        pair: &crate::storage_transaction::RecordPair,
        health: Option<&str>,
        expected: (Option<&str>, Option<&str>),
        scan: Option<(&crate::scan_checkpoint::Mutation, &str)>,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::CommitReceipt, String> {
        let _writer = self.write_lease()?;
        self.pair
            .write_pair_with_scan(pair, health, expected, scan, check)
    }
    pub(crate) fn read_scan_commit_revisions(
        &self,
    ) -> Result<crate::scan_batch::Revisions, String> {
        self.pair.read_scan_commit_revisions()
    }
    pub(crate) fn read_scan_checkpoint_summary(
        &self,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_checkpoint_summary::Summary, String> {
        self.pair.read_scan_checkpoint_summary(check)
    }
    pub(crate) fn commit_scan_batch(
        &self,
        batch: &crate::scan_batch::Batch,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::CommitReceipt, String> {
        let _writer = self.write_lease()?;
        self.pair.commit_scan_batch(batch, check)
    }
    pub(crate) fn commit_scan_window(
        &self,
        window: &crate::scan_window::Window,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::CommitReceipt, String> {
        let _writer = self.write_lease()?;
        self.pair.commit_scan_window(window, check)
    }
    #[cfg(test)]
    pub(crate) fn write_pair_with_phase(
        &self,
        pair: &crate::storage_transaction::RecordPair,
        health: Option<&str>,
        expected: (Option<&str>, Option<&str>),
        scan: Option<(&crate::scan_checkpoint::Mutation, &str)>,
        phase: impl FnMut(crate::storage_transaction::Phase) -> Result<(), String>,
    ) -> Result<crate::storage_transaction::CommitReceipt, String> {
        let _writer = self.write_lease()?;
        self.pair
            .write_records_with_phase(pair, health, expected, scan, phase)
    }
    #[cfg(test)]
    pub(crate) fn read_snapshot_after_capture(
        &self,
        after: impl FnOnce() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::RecordSnapshot, String> {
        self.pair.read_snapshot_after_capture(after)
    }
    #[cfg(test)]
    pub(crate) fn read_checkpoint_after_capture(
        &self,
        after: impl FnOnce() -> Result<(), String>,
    ) -> Result<crate::scan_checkpoint::Snapshot, String> {
        self.pair.read_checkpoint_after_capture(after)
    }
    pub fn read_scan_checkpoint(&self) -> Result<crate::scan_checkpoint::Snapshot, String> {
        self.pair.read_scan_checkpoint()
    }
    pub(crate) fn begin_scan_candidate_manifest(
        &self,
        request: &crate::scan_candidate_manifest::Begin,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::Header, String> {
        let _writer = self.write_lease()?;
        self.pair.begin_scan_candidate_manifest(request, check)
    }
    pub(crate) fn prepare_source_snapshot_activation(
        &self,
        request: crate::storage_transaction::source_snapshot_activation::Request,
        platform: &str,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::source_snapshot_activation::Prepared, String> {
        let _writer = self.write_lease()?;
        self.pair
            .prepare_source_snapshot_activation(request, platform, check)
    }
    pub(crate) fn prepare_source_snapshot_activation_page(
        &self,
        request: &crate::storage_transaction::source_snapshot_activation::Request,
        header: &crate::scan_candidate_manifest::Header,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::PreparedPage, String> {
        self.pair
            .prepare_source_snapshot_activation_page(request, header, check)
    }
    pub(crate) fn seal_source_snapshot_activation(
        &self,
        request: &crate::storage_transaction::source_snapshot_activation::Request,
        seal: &crate::scan_candidate_manifest::Seal,
        prepared: &crate::scan_candidate_manifest::origin_directory::PreparedCapsule,
        ciphertext: &[u8],
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::CommitReceipt, String> {
        let _writer = self.write_lease()?;
        self.pair
            .seal_source_snapshot_activation(request, seal, prepared, ciphertext, check)
    }
    pub(crate) fn prepare_scan_candidate_manifest_page(
        &self,
        request: crate::scan_candidate_manifest::Append,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::PreparedPage, String> {
        self.pair
            .prepare_scan_candidate_manifest_page(request, check)
    }
    pub(crate) fn append_scan_candidate_manifest_page(
        &self,
        prepared: &crate::scan_candidate_manifest::PreparedPage,
        ciphertext: &[u8],
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::Header, String> {
        let _writer = self.write_lease()?;
        self.pair
            .append_scan_candidate_manifest_page(prepared, ciphertext, check)
    }
    pub(crate) fn prepare_scan_candidate_manifest_seal(
        &self,
        request: &crate::scan_candidate_manifest::Seal,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::origin_directory::PreparedCapsule, String> {
        self.pair
            .prepare_scan_candidate_manifest_seal(request, check)
    }
    pub(crate) fn prepare_scan_resume_admission_runtime(
        &self,
        expected_catalog: &str,
        expected_checkpoint: &str,
        root_generation: u64,
        platform: &str,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::resume_admission::PreparedAdmission, String> {
        self.pair.prepare_scan_resume_admission_runtime(
            expected_catalog,
            expected_checkpoint,
            root_generation,
            platform,
            check,
        )
    }
    pub(crate) fn begin_source_snapshot(
        &self,
        request: &crate::storage_transaction::source_snapshot::Begin,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::source_snapshot::Progress, String> {
        let _writer = self.write_lease()?;
        self.pair.begin_source_snapshot(request, check)
    }
    pub(crate) fn append_source_snapshot(
        &self,
        request: &crate::storage_transaction::source_snapshot::Append,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::source_snapshot::Progress, String> {
        let _writer = self.write_lease()?;
        self.pair.append_source_snapshot(request, check)
    }
    pub(crate) fn promote_source_snapshot(
        &self,
        request: &crate::storage_transaction::source_snapshot::Promote,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::source_snapshot::Receipt, String> {
        let _writer = self.write_lease()?;
        self.pair.promote_source_snapshot(request, check)
    }
    pub(crate) fn channel_checks(
        &self,
        now_ms: i64,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::channel_check::Checks, String> {
        self.pair.channel_checks(now_ms, check)
    }
    pub(crate) fn record_channel_checks(
        &self,
        request: &crate::storage_transaction::channel_check::Record,
        now_ms: i64,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::channel_check::Recorded, String> {
        let _writer = self.write_lease()?;
        self.pair.record_channel_checks(request, now_ms, check)
    }
    pub(crate) fn record_channel_start(
        &self,
        channel_id: &str,
        start_ms: i64,
        now_ms: i64,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<Option<bool>, String> {
        let _writer = self.write_lease()?;
        self.pair
            .record_channel_start(channel_id, start_ms, now_ms, check)
    }
    pub(crate) fn record_scan_channel_checks(
        &self,
        since_ms: i64,
        now_ms: i64,
        slow_pass: bool,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::channel_check::Recorded, String> {
        let _writer = self.write_lease()?;
        self.pair
            .record_scan_channel_checks(since_ms, now_ms, slow_pass, check)
    }
    pub(crate) fn source_snapshot_status(
        &self,
        source_id: &str,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::source_snapshot::Status, String> {
        self.pair.source_snapshot_status(source_id, check)
    }
    pub(crate) fn next_source_snapshot_checks(
        &self,
        request: &crate::storage_transaction::source_snapshot::Next,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::source_snapshot::CheckPage, String> {
        self.pair.next_source_snapshot_checks(request, check)
    }
    pub(crate) fn validate_scan_resume_authority(
        &self,
        fence: crate::scan_checkpoint::resume_plan::Fence,
        header: &serde_json::Value,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        self.pair
            .validate_scan_resume_authority(fence, header, check)
    }
    pub(crate) fn commit_scan_resume_selection(
        &self,
        plan: &crate::scan_checkpoint::resume_plan::Plan,
        root_generation: u64,
        rows: &[crate::storage_transaction::storage_resume_commit::CheckedRow<'_>],
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::storage_resume_commit::Committed, String> {
        let _writer = self.write_lease()?;
        self.pair
            .commit_scan_resume_selection(plan, root_generation, rows, check)
    }
    pub(crate) fn commit_scan_resume_window_selection(
        &self,
        plan: &crate::scan_checkpoint::resume_plan::Plan,
        root_generation: u64,
        rows: &[crate::storage_transaction::storage_resume_commit::CheckedRow<'_>],
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::storage_resume_commit::Committed, String> {
        let _writer = self.write_lease_checked(&mut check)?;
        self.pair
            .commit_scan_resume_window_selection(plan, root_generation, rows, check)
    }
    pub(crate) fn prepare_scan_resume_page(
        &self,
        fence: crate::scan_checkpoint::resume_plan::Fence,
        job_id: &str,
        digest: &str,
        original_index: usize,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::resume_page::PreparedResumePage, String> {
        self.pair
            .prepare_scan_resume_page(fence, job_id, digest, original_index, check)
    }
    pub(crate) fn finish_scan_resume_page(
        &self,
        prepared: crate::storage_transaction::resume_page::PreparedResumePage,
        plaintext: Vec<u8>,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::AuthenticatedPage, String> {
        self.pair
            .finish_scan_resume_page(prepared, plaintext, check)
    }
    pub(crate) fn finish_cached_scan_resume_page(
        &self,
        prepared: crate::storage_transaction::resume_page::PreparedResumePage,
        plaintext: Vec<u8>,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::resume_page::CachedResumePage, String> {
        self.pair
            .finish_cached_scan_resume_page(prepared, plaintext, check)
    }
    pub(crate) fn verify_cached_scan_resume_page(
        &self,
        cached: &crate::storage_transaction::resume_page::CachedResumePage,
        fence: crate::scan_checkpoint::resume_plan::Fence,
        job: &str,
        digest: &str,
        index: usize,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::AuthenticatedPage, String> {
        self.pair
            .verify_cached_scan_resume_page(cached, fence, job, digest, index, check)
    }
    pub(crate) fn finish_scan_resume_admission(
        &self,
        prepared: crate::storage_transaction::resume_admission::PreparedAdmission,
        plaintext: Vec<u8>,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::resume_admission::Admitted, String> {
        self.pair
            .finish_scan_resume_admission(prepared, plaintext, check)
    }
    pub(crate) fn seal_protected_scan_candidate_manifest(
        &self,
        request: &crate::scan_candidate_manifest::Seal,
        prepared: &crate::scan_candidate_manifest::origin_directory::PreparedCapsule,
        ciphertext: &[u8],
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::CommitReceipt, String> {
        let _writer = self.write_lease()?;
        self.pair
            .seal_protected_scan_candidate_manifest(request, prepared, ciphertext, check)
    }
    pub(crate) fn find_scan_candidate_manifest(
        &self,
        request: &crate::scan_candidate_manifest::Find,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::Found, String> {
        self.pair.find_scan_candidate_manifest(request, check)
    }
    pub(crate) fn read_scan_candidate_manifest_page(
        &self,
        request: &crate::scan_candidate_manifest::Read,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::EncryptedPage, String> {
        self.pair.read_scan_candidate_manifest_page(request, check)
    }
    pub(crate) fn finish_scan_candidate_manifest_page(
        &self,
        request: &crate::scan_candidate_manifest::Read,
        page: crate::scan_candidate_manifest::EncryptedPage,
        plaintext: Vec<u8>,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::Page, String> {
        self.pair
            .finish_scan_candidate_manifest_page(request, page, plaintext, check)
    }
    pub fn write_health_guarded(
        &self,
        health: &str,
        expected: &str,
        expected_health: &str,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::CommitReceipt, String> {
        let _writer = self.write_lease()?;
        self.pair
            .write_health_guarded(health, expected, expected_health, check)
    }
    pub fn write_record_guarded(
        &self,
        name: &str,
        contents: &str,
        expected: Option<&str>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::CommitReceipt, String> {
        let _writer = self.write_lease_checked(&mut check)?;
        self.pair
            .write_record_guarded(name, contents, expected, check)
    }
    #[cfg(test)]
    pub fn read_pair(&self) -> Result<crate::storage_transaction::RecordPair, String> {
        self.pair.read_pair()
    }

    pub fn with_guide_read<T>(
        &self,
        read: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        self.pair.with_guide_read(read)
    }
    pub fn with_guide_write<T>(
        &self,
        write: impl FnOnce(&mut rusqlite::Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let _writer = self.write_lease()?;
        self.pair.with_guide_write(write)
    }
    pub(crate) fn with_guide_write_checked<T>(
        &self,
        write: impl FnOnce(&mut rusqlite::Connection) -> Result<T, String>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<T, String> {
        let _writer = self.write_lease_checked(&mut check)?;
        self.pair.with_guide_write_checked(write, check)
    }
    pub(crate) fn with_guide_write_preflight_checked<T>(
        &self,
        preflight: impl FnOnce(&rusqlite::Connection) -> Result<Option<T>, String>,
        write: impl FnOnce(
            &mut rusqlite::Connection,
            &mut dyn FnMut() -> Result<(), String>,
        ) -> Result<T, String>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<T, String> {
        let _writer = self.write_lease_checked(&mut check)?;
        self.pair
            .with_guide_write_preflight_checked(preflight, write, check)
    }
    /// Archive CAS and read-only no-op proof share the actual writer lease.
    pub(crate) fn with_guide_maintenance_preflight_checked<T>(
        &self,
        preflight: impl FnMut(&rusqlite::Connection) -> Result<Option<T>, String>,
        write: impl FnOnce(
            &mut rusqlite::Connection,
            &mut dyn FnMut() -> Result<(), String>,
        ) -> Result<T, String>,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::storage_transaction::guide_maintenance::Maintenance<T>, String> {
        let _writer = self.write_lease_checked(&mut check)?;
        self.pair
            .with_guide_maintenance_preflight_checked(preflight, write, cancel, check)
    }
    /// Archive CAS and read-only no-op proof share the actual writer lease.
    /// Mutations still repeat admission inside their own transaction after backup.
    pub(crate) fn with_archive_write_checked<T>(
        &self,
        expected: &str,
        preflight: impl FnOnce(&rusqlite::Connection) -> Result<Option<T>, String>,
        write: impl FnOnce(
            &mut rusqlite::Connection,
            &mut dyn FnMut() -> Result<(), String>,
        ) -> Result<T, String>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<T, String> {
        let _writer = self.archive_write_lease_checked(&mut check)?;
        self.archive.write_checked(
            |c| {
                if crate::archive_catalog::current(c)?
                    != crate::archive_catalog::revision(expected)?
                {
                    return Err("archive-revision-stale".into());
                }
                preflight(c)
            },
            write,
            &mut check,
        )
    }
    pub(crate) fn with_archive_read<T>(
        &self,
        read: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        self.archive.read(read)
    }
    #[cfg(test)]
    pub(crate) fn with_archive_fixture_write<T>(
        &self,
        write: impl FnOnce(&mut rusqlite::Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let _writer = self.archive_write_lease()?;
        self.archive.seed_fixture(write)
    }
    pub(crate) fn channel_logo_capture(
        &self,
        ids: &[String],
        revision: &str,
        check: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<crate::channel_logos::Capture, String> {
        self.pair.channel_logo_capture(ids, revision, check)
    }
    pub(crate) fn archive_download_directory(&self) -> Result<PathBuf, String> {
        let directory = self.pair.data_root_path().join("archive-downloads-v1");
        refuse_link(&directory)?;
        Ok(directory)
    }
    pub(crate) fn archive_download_capture(
        &self,
        file_ref: &str,
        expected: &str,
    ) -> Result<(crate::archive_download_store::Capture, PathBuf), String> {
        let _writer = self.archive_write_lease()?;
        let (file, title_ref, title, file_title) = self.with_archive_read(|c| {
            crate::archive_catalog::resolve_download(c, file_ref, expected)
        })?;
        let capture = crate::archive_download_store::Capture {
            file,
            file_ref: file_ref.into(),
            title_ref,
            title,
            file_title,
        };
        let directory = self.archive_download_directory()?;
        let downloads =
            crate::archive_download_store::DownloadStore::open(&directory, true, &mut || Ok(()))?
                .ok_or("archive-download-storage-failed")?;
        downloads.preflight(&capture)?;
        Ok((capture, directory))
    }
    pub(crate) fn commit_archive_download_checked(
        &self,
        capture: &crate::archive_download_store::Capture,
        body: &crate::archive_download_store::CompletedBody,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::archive_download_store::Receipt, String> {
        let _writer = self.archive_write_lease_checked(&mut check)?;
        let directory = self.archive_download_directory()?;
        let downloads =
            crate::archive_download_store::DownloadStore::open(&directory, true, &mut check)?
                .ok_or("archive-download-storage-failed")?;
        // Retain shared namespace authority through the local download COMMIT,
        // including another process using the same root. No network await is
        // inside either lock; the downloaded body is already locally prepared.
        self.with_archive_read(|c| {
            downloads.complete(capture, body, &mut || {
                check()?;
                crate::archive_catalog::verify_live(c, &capture.file_ref, &capture.file)
            })
        })
    }
    pub(crate) fn list_archive_downloads(
        &self,
    ) -> Result<crate::archive_download_store::List, String> {
        let _writer = self.archive_write_lease()?;
        let directory = self.archive_download_directory()?;
        match crate::archive_download_store::DownloadStore::open(&directory, false, &mut || Ok(()))?
        {
            Some(store) => store.list(),
            None => Ok(crate::archive_download_store::List {
                schema_version: 1,
                revision: "0".into(),
                entries: vec![],
            }),
        }
    }
    pub(crate) fn remove_archive_download_checked(
        &self,
        reference: &str,
        expected: &str,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::archive_download_store::RemoveCommit, String> {
        let _writer = self.archive_write_lease_checked(&mut check)?;
        let downloads = crate::archive_download_store::DownloadStore::open(
            &self.archive_download_directory()?,
            false,
            &mut check,
        )?
        .ok_or("archive-download-unavailable")?;
        downloads.remove(reference, expected, &mut check)
    }
    pub(crate) fn open_archive_download_checked(
        &self,
        reference: &str,
        expected: &str,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::archive_download_store::LocalBody, String> {
        let _writer = self.archive_write_lease_checked(&mut check)?;
        let downloads = crate::archive_download_store::DownloadStore::open(
            &self.archive_download_directory()?,
            false,
            &mut check,
        )?
        .ok_or("archive-download-unavailable")?;
        downloads.local(reference, expected, &mut check)
    }
    pub(crate) fn verify_archive_download_live(
        &self,
        proof: &crate::archive_download_store::LocalProof,
    ) -> Result<(), String> {
        let directory = self.archive_download_directory()?;
        crate::archive_download_store::verify_local_live(&directory, proof)
    }
    pub(crate) fn read_archive_download_bookmark(
        &self,
        proof: &crate::archive_download_store::LocalProof,
    ) -> Result<crate::archive_bookmarks::ReadReceipt, String> {
        let _writer = self.archive_write_lease()?;
        crate::archive_download_store::DownloadStore::open(
            &self.archive_download_directory()?,
            false,
            &mut || Ok(()),
        )?
        .ok_or("archive-download-unavailable")?
        .read_bookmark(proof)
    }
    pub(crate) fn write_archive_download_bookmark_checked(
        &self,
        proof: &crate::archive_download_store::LocalProof,
        revision: &str,
        position: &crate::archive_bookmarks::Position,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::archive_bookmarks::Receipt, String> {
        let _writer = self.archive_write_lease_checked(&mut check)?;
        crate::archive_download_store::DownloadStore::open(
            &self.archive_download_directory()?,
            false,
            &mut check,
        )?
        .ok_or("archive-download-unavailable")?
        .save_bookmark(proof, revision, position, &mut check)
    }
    pub(crate) fn write_archive_bookmark_checked(
        &self,
        proof: &crate::archive_bookmarks::Proof,
        revision: &str,
        position: &crate::archive_bookmarks::Position,
        mut check: impl Fn() -> Result<(), String>,
    ) -> Result<crate::archive_bookmarks::Receipt, String> {
        let _writer = self.archive_write_lease_checked(&mut check)?;
        self.archive.write_checked(
            |c| crate::archive_bookmarks::preflight_save(c, proof, revision, position, &check),
            |c, _| crate::archive_bookmarks::save(c, proof, revision, position, &check),
            &mut || check(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delegated_preferences_roundtrip_through_canonical_database() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned(), "test".into()).unwrap();
        assert!(store.read_pair().unwrap().preferences.is_none());
        let preferences = serde_json::json!({"schemaVersion":1,"sources":[],"favorites":[],"removedChannels":[],"volume":0.5,"muted":true,"panelWidth":300.0}).to_string();
        store.write("preferences", &preferences).unwrap();
        let reopened = Store::new(dir.path().to_owned(), "test".into()).unwrap();
        let pair = reopened.read_pair().unwrap();
        assert!(pair.catalog.is_none());
        let value: serde_json::Value =
            serde_json::from_str(pair.preferences.as_ref().unwrap()).unwrap();
        assert_eq!(value["muted"], true);
        assert_eq!(value["volume"], 0.5);
        assert!(dir.path().join("genx.sqlite3").exists());
    }
    #[test]
    fn invalid_names_and_json_cannot_mutate_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned(), "test".into()).unwrap();
        assert!(store.write("../outside", "{}").is_err());
        assert!(store.write("catalog", "broken").is_err());
        assert!(store.read("catalog").unwrap().is_none());
    }
    #[test]
    fn initial_read_failure_latches_but_later_failure_preserves_healthy_owner() {
        use std::sync::atomic::{AtomicBool, Ordering};
        for initial_success in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut store = Store::new(dir.path().to_owned(), "test".into());
            let succeeded = AtomicBool::new(false);
            if initial_success {
                read_initial_pair(&mut store, &succeeded).unwrap();
            }
            fs::write(dir.path().join("genx.sqlite3"), b"invalid database").unwrap();
            assert!(read_initial_pair(&mut store, &succeeded).is_err());
            assert_eq!(store.is_ok(), initial_success);
            assert_eq!(succeeded.load(Ordering::SeqCst), initial_success);
        }
    }
}
