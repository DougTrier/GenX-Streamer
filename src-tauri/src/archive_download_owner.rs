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

//! One retained native download; playback/search generations lend no authority.
use crate::{
    archive_catalog,
    archive_discovery::{self, FileVerification},
    archive_download_store::{self, CompletedBody},
    archive_download_transfer::{self, Check},
    scan_manifest_work,
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tokio::sync::Notify;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub schema_version: u8,
    pub file_ref: String,
    pub expected_revision: String,
}
#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Phase {
    Preparing,
    Downloading,
    Verifying,
    Saving,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    pub schema_version: u8,
    pub request_id: String,
    pub file_ref: String,
    pub job_id: String,
    pub phase: Phase,
    pub received_bytes: String,
    pub total_bytes: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Stopped {
    schema_version: u8,
    stopped: bool,
    cleanup_pending: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoveRequest {
    pub schema_version: u8,
    pub download_ref: String,
    pub expected_revision: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoveReceipt {
    schema_version: u8,
    committed: bool,
    revision: String,
    changed: bool,
    download_ref: String,
    cleanup_pending: bool,
}
pub(crate) async fn list(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_download_store::List, String> {
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        owner
            .storage(None, move |store, check| {
                check()?;
                store.list_archive_downloads()
            })
            .await
            .map(|(list, _)| list)
    })
    .await
}
pub(crate) async fn remove(
    request: RemoveRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<RemoveReceipt, String> {
    if request.schema_version != 1 || !archive_catalog::hex_ref(&request.download_ref) {
        return Err("archive-download-request-invalid".into());
    }
    archive_catalog::revision(&request.expected_revision)?;
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let _work = admit_work()?;
        let reference = request.download_ref.clone();
        crate::archive_playback_owner::with_download_removal(&reference, move || async move {
            let (committed, root_generation) = owner
                .storage(None, move |store, check| {
                    store.remove_archive_download_checked(
                        &request.download_ref,
                        &request.expected_revision,
                        check,
                    )
                })
                .await?;
            let cleanup_ref = committed.download_ref.clone();
            let cleanup_pending = owner
                .storage(Some(root_generation), move |_store, _check| {
                    archive_download_transfer::remove_published_sync(
                        &committed.directory,
                        &cleanup_ref,
                        &committed.managed_name,
                    )
                })
                .await
                .is_err();
            Ok(RemoveReceipt {
                schema_version: committed.schema_version,
                committed: committed.committed,
                revision: committed.revision,
                changed: committed.changed,
                download_ref: committed.download_ref,
                cleanup_pending,
            })
        })
        .await
    })
    .await
}
struct Job {
    progress: Mutex<Progress>,
    canceled: AtomicBool,
    settled: AtomicBool,
    done: Notify,
    cleanup_failed: AtomicBool,
    started: Instant,
    title_ref: Mutex<Option<String>>,
}
#[derive(Default)]
struct Registry {
    active: Option<Arc<Job>>,
    stopping: usize,
}
static ACTIVE: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));
static WORK: LazyLock<Arc<crate::close_owner::WorkOwner>> =
    LazyLock::new(|| Arc::new(crate::close_owner::WorkOwner::default()));
fn admit_work() -> Result<crate::close_owner::WorkGuard, String> {
    let registry = ACTIVE.lock().map_err(|_| "archive-download-owner-lock")?;
    if registry.stopping != 0 {
        return Err("archive-download-busy".into());
    }
    Ok(WORK.acquire())
}
// Every retained stop observer closes admission until its original join settles.
// Concurrent cleanup callers cannot reopen admission underneath another caller.
struct StopAdmission;
impl StopAdmission {
    fn begin(registry: &mut Registry) -> Result<Self, String> {
        registry.stopping = registry
            .stopping
            .checked_add(1)
            .ok_or("archive-download-owner-lock")?;
        Ok(Self)
    }
}
impl Drop for StopAdmission {
    fn drop(&mut self) {
        if let Ok(mut registry) = ACTIVE.lock() {
            registry.stopping = registry.stopping.saturating_sub(1);
        }
    }
}
struct Reservation {
    job: Arc<Job>,
    finished: bool,
    _work: crate::close_owner::WorkGuard,
}
impl Reservation {
    fn admit(job: Arc<Job>) -> Result<Self, String> {
        let mut active = ACTIVE.lock().map_err(|_| "archive-download-owner-lock")?;
        if active.stopping != 0 || active.active.is_some() {
            return Err("archive-download-busy".into());
        }
        active.active = Some(job.clone());
        Ok(Self {
            job,
            finished: false,
            _work: WORK.acquire(),
        })
    }
    fn finish(&mut self, result: &Result<archive_download_store::Receipt, String>) {
        self.job.cleanup_failed.store(
            result.as_ref().err().is_some_and(|e| {
                matches!(
                    e.as_str(),
                    "archive-download-cleanup-failed" | "archive-download-worker-failed"
                )
            }),
            Ordering::SeqCst,
        );
        self.finished = true;
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if !self.finished {
            self.job.cleanup_failed.store(true, Ordering::SeqCst);
        }
        if let Ok(mut active) = ACTIVE.lock() {
            if active
                .active
                .as_ref()
                .is_some_and(|j| Arc::ptr_eq(j, &self.job))
                && !self.job.cleanup_failed.load(Ordering::SeqCst)
            {
                active.active = None;
            }
        }
        self.job.settled.store(true, Ordering::SeqCst);
        self.job.done.notify_waiters();
    }
}
impl Job {
    fn check(&self) -> Result<(), String> {
        if self.canceled.load(Ordering::SeqCst) {
            return Err("canceled".into());
        }
        if self.started.elapsed() >= Duration::from_secs(2 * 60 * 60) {
            return Err("archive-download-deadline".into());
        }
        Ok(())
    }
    fn report(&self, app: &tauri::AppHandle, phase: Phase, received: u64, total: Option<u64>) {
        if let Ok(mut progress) = self.progress.lock() {
            progress.phase = phase;
            progress.received_bytes = received.to_string();
            progress.total_bytes = total.map(|s| s.to_string());
            let _ = app.emit("archive-download-progress", progress.clone());
        }
    }
}
pub(crate) fn status() -> Result<Option<Progress>, String> {
    let active = ACTIVE.lock().map_err(|_| "archive-download-owner-lock")?;
    active
        .active
        .as_ref()
        .map(|job| {
            job.progress
                .lock()
                .map(|p| p.clone())
                .map_err(|_| "archive-download-owner-lock".into())
        })
        .transpose()
}
fn reference() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "archive-download-random-failed")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn validate(request: &Request) -> Result<(), String> {
    if request.schema_version != 1
        || !archive_catalog::hex_ref(&request.file_ref)
        || archive_catalog::revision(&request.expected_revision)? < 1
    {
        return Err("archive-download-request-invalid".into());
    }
    Ok(())
}
pub(crate) async fn start(
    request: Request,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_download_store::Receipt, String> {
    let admitted_at = Instant::now();
    validate(&request)?;
    let id = request_id.clone();
    let handle = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let job = Arc::new(Job {
            progress: Mutex::new(Progress {
                schema_version: 1,
                request_id: id,
                file_ref: request.file_ref.clone(),
                job_id: reference()?,
                phase: Phase::Preparing,
                received_bytes: "0".into(),
                total_bytes: None,
            }),
            canceled: AtomicBool::new(false),
            settled: AtomicBool::new(false),
            done: Notify::new(),
            cleanup_failed: AtomicBool::new(false),
            started: admitted_at,
            title_ref: Mutex::new(None),
        });
        let mut reservation = Reservation::admit(job.clone())?;
        let check_owner = owner.clone();
        let check_job = job.clone();
        let check: Check = Arc::new(move || {
            check_owner.check()?;
            check_job.check()
        });
        let result = async {
            check()?;
            job.report(&handle, Phase::Preparing, 0, None);
            let file_ref = request.file_ref;
            let revision = request.expected_revision;
            let ((capture, directory), root) = owner
                .storage(None, move |store, guard| {
                    guard()?;
                    store.archive_download_capture(&file_ref, &revision)
                })
                .await?;
            let capture = Arc::new(capture);
            *job.title_ref
                .lock()
                .map_err(|_| "archive-download-owner-lock")? = Some(capture.title_ref.clone());
            // Removal between capture and publishing its job discriminator is
            // caught before any media request, without stopping unrelated work.
            let initial_capture = capture.clone();
            owner
                .storage(Some(root), move |store, guard| {
                    guard()?;
                    store.with_archive_read(|c| {
                        archive_catalog::verify_live(
                            c,
                            &initial_capture.file_ref,
                            &initial_capture.file,
                        )
                    })
                })
                .await?;
            check()?;
            let verified = match archive_discovery::verify_file(owner.clone(), &capture.file)
                .await?
            {
                FileVerification::File(file) => file,
                FileVerification::Missing(_) => return Err("archive-download-unavailable".into()),
            };
            check()?;
            let size = verified.size_bytes;
            job.report(&handle, Phase::Downloading, 0, Some(size));
            let progress_job = job.clone();
            let progress_app = handle.clone();
            let last = Arc::new(Mutex::new(Instant::now()));
            let progress = Arc::new(move |received| {
                if let Ok(mut last) = last.lock() {
                    if last.elapsed() >= Duration::from_millis(250) {
                        progress_job.report(
                            &progress_app,
                            Phase::Downloading,
                            received,
                            Some(size),
                        );
                        *last = Instant::now();
                    }
                }
            });
            let staged = archive_download_transfer::fetch(
                verified,
                capture.file.sha1.clone(),
                directory,
                check.clone(),
                progress,
            )
            .await?;
            job.report(&handle, Phase::Verifying, size, Some(size));
            // Fresh metadata again after the complete transfer; no stale source
            // fingerprint can authorize the final local publication.
            let fresh = archive_discovery::verify_file(owner.clone(), &capture.file).await;
            if let Err(error) = check() {
                staged.discard().await?;
                return Err(error);
            }
            match fresh {
                Ok(FileVerification::File(_)) => {}
                Ok(FileVerification::Missing(_)) => {
                    staged.discard().await?;
                    return Err("archive-download-unavailable".into());
                }
                Err(error) => {
                    staged.discard().await?;
                    return Err(error);
                }
            }
            let reference = job
                .progress
                .lock()
                .map_err(|_| "archive-download-owner-lock")?
                .job_id
                .clone();
            // Retain the staged file until storage admission actually calls the
            // operation: a canceled/stale root must still explicitly join cleanup.
            let staged = Arc::new(Mutex::new(Some(staged)));
            let publish_staged = staged.clone();
            let publish_reference = reference.clone();
            let publish_check = check.clone();
            let publication = owner
                .storage(Some(root), move |_, guard| {
                    guard()?;
                    publish_check()?;
                    publish_staged
                        .lock()
                        .map_err(|_| "archive-download-owner-lock")?
                        .take()
                        .ok_or("archive-download-writer-lost")?
                        .publish_sync(publish_reference, publish_check)
                })
                .await;
            let body = match publication {
                Ok((body, _)) => body,
                Err(error) => {
                    let retained = staged
                        .lock()
                        .map_err(|_| "archive-download-owner-lock")?
                        .take();
                    if let Some(retained) = retained {
                        retained.discard().await?;
                    }
                    return Err(error);
                }
            };
            job.report(&handle, Phase::Saving, size, Some(size));
            let cleanup_reference = reference.clone();
            let cleanup_name = body.managed_name.clone();
            let cleanup_store = handle.state::<crate::NativeState>().store.clone();
            let completed = CompletedBody {
                download_ref: reference,
                managed_name: body.managed_name.clone(),
                size_bytes: body.size.to_string(),
                local_sha256: body.local_sha256,
                provider_sha1_verified: body.provider_sha1_verified,
                completed_ms: archive_catalog::now_ms()?,
            };
            let commit_capture = capture.clone();
            let commit_check = check.clone();
            let result = owner
                .storage(Some(root), move |store, guard| {
                    guard()?;
                    commit_check()?;
                    store.commit_archive_download_checked(&commit_capture, &completed, || {
                        guard()?;
                        commit_check()
                    })
                })
                .await;
            match result {
                Ok((receipt, _)) => Ok(receipt),
                Err(error) => {
                    // A lost worker/post-COMMIT mirror failure is uncertain:
                    // never unlink a body that may own a durable completion.
                    if matches!(
                        error.as_str(),
                        "canceled"
                            | "application-closing"
                            | "archive-download-deadline"
                            | "archive-file-unavailable"
                            | "archive-file-changed"
                            | "scan-manifest-root-changed"
                    ) {
                        tokio::task::spawn_blocking(move || {
                            // Cleanup-only authority survives command abort, but
                            // cannot mutate a root adopted after this transfer.
                            let lease = cleanup_store
                                .read()
                                .map_err(|_| "archive-download-cleanup-failed")?;
                            if lease.generation() != root {
                                return Ok(());
                            }
                            let directory = lease
                                .as_ref()
                                .map_err(|_| "archive-download-cleanup-failed")?
                                .archive_download_directory()?;
                            archive_download_transfer::remove_published_sync(
                                &directory,
                                &cleanup_reference,
                                &cleanup_name,
                            )
                        })
                        .await
                        .map_err(|_| "archive-download-worker-failed")??;
                    }
                    Err(error)
                }
            }
        }
        .await;
        reservation.finish(&result);
        result
    })
    .await
}
pub(crate) async fn shutdown() -> Result<Stopped, String> {
    let (job, admission) = {
        let mut active = ACTIVE.lock().map_err(|_| "archive-download-owner-lock")?;
        let admission = StopAdmission::begin(&mut active)?;
        (active.active.clone(), admission)
    };
    finish_shutdown(job, admission).await
}
async fn finish_shutdown(
    job: Option<Arc<Job>>,
    _admission: StopAdmission,
) -> Result<Stopped, String> {
    if let Some(job) = job {
        job.canceled.store(true, Ordering::SeqCst);
        loop {
            let notified = job.done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if job.settled.load(Ordering::SeqCst) {
                break;
            }
            notified.await;
        }
        WORK.drained().await;
        if job.cleanup_failed.load(Ordering::SeqCst) {
            return Err("archive-download-cleanup-failed".into());
        }
    } else {
        WORK.drained().await;
    }
    Ok(Stopped {
        schema_version: 1,
        stopped: true,
        cleanup_pending: false,
    })
}
pub(crate) async fn revoke_removed(scope: &archive_catalog::RemovalScope) -> Result<(), String> {
    let matched = {
        let mut active = ACTIVE.lock().map_err(|_| "archive-download-owner-lock")?;
        let matches = active
            .active
            .as_ref()
            .map(|job| {
                let progress = job
                    .progress
                    .lock()
                    .map_err(|_| "archive-download-owner-lock")?;
                Ok::<_, String>(match scope {
                    archive_catalog::RemovalScope::All => true,
                    archive_catalog::RemovalScope::FileRef(reference) => {
                        reference == &progress.file_ref
                    }
                    archive_catalog::RemovalScope::TitleRef(reference) => {
                        job.title_ref
                            .lock()
                            .map_err(|_| "archive-download-owner-lock")?
                            .as_ref()
                            == Some(reference)
                    }
                })
            })
            .transpose()?
            .unwrap_or(false);
        if matches {
            let admission = StopAdmission::begin(&mut active)?;
            Some((active.active.clone(), admission))
        } else {
            None
        }
    };
    if let Some((job, admission)) = matched {
        finish_shutdown(job, admission).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    fn job() -> Arc<Job> {
        Arc::new(Job {
            progress: Mutex::new(Progress {
                schema_version: 1,
                request_id: "download-held-fixture".into(),
                file_ref: "a".repeat(64),
                job_id: "b".repeat(64),
                phase: Phase::Downloading,
                received_bytes: "1".into(),
                total_bytes: Some("3".into()),
            }),
            canceled: AtomicBool::new(false),
            settled: AtomicBool::new(false),
            done: Notify::new(),
            cleanup_failed: AtomicBool::new(false),
            started: Instant::now(),
            title_ref: Mutex::new(Some("c".repeat(64))),
        })
    }
    #[test]
    fn archive_download_request_admits_exact_archive_reference_not_url_path_or_invented_destination(
    ) {
        let valid =
            serde_json::json!({"schemaVersion":1,"fileRef":"a".repeat(64),"expectedRevision":"1"});
        let request: Request = serde_json::from_value(valid.clone()).unwrap();
        validate(&request).unwrap();
        for field in [
            "url",
            "destination",
            "path",
            "sizeBytes",
            "sha1",
            "allowHttp",
        ] {
            let mut invalid = valid.clone();
            invalid[field] = serde_json::json!("untrusted");
            assert!(serde_json::from_value::<Request>(invalid).is_err());
        }
        for reference in [
            "https://archive.org/download/item/file.mp4",
            "C:/file.mp4",
            "live-channel",
        ] {
            let request = Request {
                schema_version: 1,
                file_ref: reference.into(),
                expected_revision: "1".into(),
            };
            assert!(validate(&request).is_err());
        }
        for revision in ["0", "01", "-1", "9223372036854775808"] {
            assert!(validate(&Request {
                schema_version: 1,
                file_ref: "a".repeat(64),
                expected_revision: revision.into()
            })
            .is_err());
        }
    }
    #[tokio::test]
    async fn archive_download_shutdown_waits_actual_producer_after_observer_disappears() {
        let _lock = TEST_LOCK.lock().await;
        let actual = job();
        let actual_job = actual.clone();
        let reservation = Reservation::admit(actual.clone()).unwrap();
        let (release, held) = tokio::sync::oneshot::channel();
        let producer = tokio::spawn(async move {
            let mut reservation = reservation;
            held.await.unwrap();
            let result = Err("canceled".to_owned());
            reservation.finish(&result);
        });
        drop(producer); // Native owned producer survives a lost IPC observer.
        let stop = tokio::spawn(shutdown());
        tokio::time::timeout(Duration::from_secs(1), async {
            while !actual_job.canceled.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(actual_job.canceled.load(Ordering::SeqCst));
        assert!(!stop.is_finished());
        assert!(WORK.count() > 0);
        assert!(Reservation::admit(job()).is_err());
        release.send(()).unwrap();
        let receipt = stop.await.unwrap().unwrap();
        assert!(receipt.stopped && !receipt.cleanup_pending);
        assert_eq!(WORK.count(), 0);
        assert!(status().unwrap().is_none());
    }
    #[tokio::test]
    async fn archive_download_unrelated_discovery_removal_does_not_cancel_the_job() {
        let _lock = TEST_LOCK.lock().await;
        let actual = job();
        let mut reservation = Reservation::admit(actual.clone()).unwrap();
        assert!(
            !crate::archive_discovery::cleanup_removed(&archive_catalog::RemovalScope::FileRef(
                "d".repeat(64)
            ))
            .await
        );
        assert!(
            !crate::archive_discovery::cleanup_removed(&archive_catalog::RemovalScope::TitleRef(
                "d".repeat(64)
            ))
            .await
        );
        assert!(!actual.canceled.load(Ordering::SeqCst));
        reservation.finish(&Err("canceled".into()));
        drop(reservation);
        assert!(status().unwrap().is_none());
    }
    #[tokio::test]
    async fn archive_download_matching_discovery_hook_joins_file_title_and_clear_producers() {
        let _lock = TEST_LOCK.lock().await;
        for scope in [
            archive_catalog::RemovalScope::FileRef("a".repeat(64)),
            archive_catalog::RemovalScope::TitleRef("c".repeat(64)),
            archive_catalog::RemovalScope::All,
        ] {
            let actual = job();
            let mut reservation = Reservation::admit(actual.clone()).unwrap();
            let (release, held) = tokio::sync::oneshot::channel();
            let producer = tokio::spawn(async move {
                held.await.unwrap();
                reservation.finish(&Err("canceled".into()));
            });
            let cleanup =
                tokio::spawn(
                    async move { crate::archive_discovery::cleanup_removed(&scope).await },
                );
            tokio::time::timeout(Duration::from_secs(1), async {
                while !actual.canceled.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(!cleanup.is_finished());
            assert!(Reservation::admit(job()).is_err());
            release.send(()).unwrap();
            producer.await.unwrap();
            assert!(!cleanup.await.unwrap());
            assert_eq!(WORK.count(), 0);
            assert!(status().unwrap().is_none());
        }
    }
    #[tokio::test]
    async fn archive_download_postcommit_cleanup_failure_preserves_committed_removal_receipt() {
        let _lock = TEST_LOCK.lock().await;
        let actual = job();
        let mut reservation = Reservation::admit(actual.clone()).unwrap();
        let (release, held) = tokio::sync::oneshot::channel();
        let producer = tokio::spawn(async move {
            held.await.unwrap();
            reservation.finish(&Err("archive-download-cleanup-failed".into()));
        });
        let cleanup = tokio::spawn(async {
            crate::archive_discovery::cleanup_removed(&archive_catalog::RemovalScope::All).await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !actual.canceled.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!cleanup.is_finished());
        release.send(()).unwrap();
        producer.await.unwrap();
        let mut receipt = archive_catalog::RemovalReceipt {
            schema_version: 1,
            committed: true,
            revision: "12".into(),
            removed_titles: 1,
            removed_files: 2,
            removed_favorites: 1,
            cleared_progress: 0,
            cleanup_pending: false,
        };
        let before = serde_json::to_value(&receipt).unwrap();
        receipt.cleanup_pending = cleanup.await.unwrap();
        assert!(receipt.cleanup_pending);
        let mut expected = before;
        expected["cleanupPending"] = serde_json::json!(true);
        assert_eq!(serde_json::to_value(&receipt).unwrap(), expected);
        assert_eq!(WORK.count(), 0);
        assert!(Reservation::admit(job()).is_err());
        // Fixture's injected cleanup failure owns no OS resource; production
        // retains failed ownership, while this private fixture resets its registry.
        ACTIVE.lock().unwrap().active = None;
    }
    #[tokio::test]
    async fn archive_download_overlapping_stop_owners_cannot_reopen_admission_early() {
        let _lock = TEST_LOCK.lock().await;
        let first = StopAdmission::begin(&mut ACTIVE.lock().unwrap()).unwrap();
        let second = StopAdmission::begin(&mut ACTIVE.lock().unwrap()).unwrap();
        assert!(Reservation::admit(job()).is_err());
        drop(first);
        assert!(Reservation::admit(job()).is_err());
        drop(second);
        let mut reservation = Reservation::admit(job()).unwrap();
        reservation.finish(&Err("canceled".into()));
        drop(reservation);
        assert!(status().unwrap().is_none());
    }
    #[test]
    fn archive_download_job_deadline_and_cancel_are_independent_of_media_renewal() {
        let mut expired = job();
        Arc::get_mut(&mut expired).unwrap().started =
            Instant::now() - Duration::from_secs(2 * 60 * 60);
        assert_eq!(expired.check().unwrap_err(), "archive-download-deadline");
        let active = job();
        active.check().unwrap();
        active.canceled.store(true, Ordering::SeqCst);
        assert_eq!(active.check().unwrap_err(), "canceled");
    }
}
