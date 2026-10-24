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

//! Retained Archive playback singleton. Public/account/Archive decoder handoff
//! belongs to the root's existing player owner; this module owns no decoder.
use crate::{
    archive_bookmarks, archive_catalog,
    archive_discovery::{self, FileVerification},
    archive_playback_proxy::{Alive, ArchivePlaybackProxy, Authority},
    scan_manifest_work,
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::Manager;

/// Cleanup is admitted even after ordinary request admission closes. The task
/// retains its work guard if the IPC observer disappears; only actual settlement
/// releases it. This operation must not start network or storage work.
pub(crate) fn spawn_cleanup<R, F>(
    work: crate::close_owner::WorkGuard,
    operation: F,
) -> tokio::task::JoinHandle<Result<R, String>>
where
    R: Send + 'static,
    F: std::future::Future<Output = Result<R, String>> + Send + 'static,
{
    tokio::spawn(async move {
        let _work = work;
        operation.await
    })
}

fn validate_cleanup_request_id(id: &str) -> Result<(), String> {
    // Same wire bound as Requests; cleanup does not enter the cancelable request
    // registry, which is closed during Exit. Cancellation cannot skip this join.
    if id.is_empty() || id.len() > 128 {
        Err("invalid-request-id".into())
    } else {
        Ok(())
    }
}

fn revoke_exact(generation: &AtomicU64, expected: u64) {
    if let Some(next) = expected.checked_add(1) {
        let _ = generation.compare_exchange(expected, next, Ordering::SeqCst, Ordering::SeqCst);
    }
}

struct ActiveSession {
    proxy: ArchivePlaybackProxy,
    file_ref: String,
    title_ref: String,
    download_ref: Option<String>,
    bookmark: Arc<BookmarkSession>,
}
struct BookmarkSession {
    local: Option<crate::archive_download_store::LocalProof>,
    file: Arc<archive_catalog::ResolvedFile>,
    reference: String,
    root_generation: u64,
    owner: Arc<scan_manifest_work::Context>,
    jobs: Arc<crate::close_owner::WorkOwner>,
    valid: Alive,
}
const BOOKMARK_SAVE_BUDGET: std::time::Duration = std::time::Duration::from_secs(120);
/// Minted only while the exact native media session is active. This permits
/// one retained storage job, never media access or renewal after lease expiry.
struct BookmarkSavePermit {
    ends: std::time::Instant,
    authority: Box<dyn Fn() -> Result<(), String> + Send + Sync>,
}
impl BookmarkSavePermit {
    fn admit(
        command: Arc<scan_manifest_work::Context>,
        session: Arc<BookmarkSession>,
        expected: u64,
        admitted_at: std::time::Instant,
    ) -> Result<Self, String> {
        bookmark_admission(&command, &session, expected)?;
        let permit = Self {
            ends: admitted_at + BOOKMARK_SAVE_BUDGET,
            authority: Box::new(move || bookmark_authority(&command, &session, expected)),
        };
        permit.check()?;
        Ok(permit)
    }
    fn check(&self) -> Result<(), String> {
        self.check_with_clock(std::time::Instant::now)
    }
    fn check_with_clock(&self, now: impl FnOnce() -> std::time::Instant) -> Result<(), String> {
        (self.authority)()?;
        if now() >= self.ends {
            return Err("archive-bookmark-save-deadline".into());
        }
        Ok(())
    }
}
async fn join_bookmark_jobs(jobs: &crate::close_owner::WorkOwner) {
    jobs.drained().await;
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BookmarkSaveRequest {
    pub schema_version: u8,
    pub session_generation: String,
    pub expected_revision: String,
    pub position_ms: i64,
    pub duration_ms: Option<i64>,
    pub completed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookmarkRead {
    schema_version: u8,
    session_generation: String,
    supported: bool,
    revision: String,
    position: Option<archive_bookmarks::Position>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookmarkSaved {
    schema_version: u8,
    session_generation: String,
    committed: bool,
    revision: String,
    changed: bool,
}
static ACTIVE: tokio::sync::Mutex<Option<ActiveSession>> = tokio::sync::Mutex::const_new(None);
static GENERATION: AtomicU64 = AtomicU64::new(0);
static LOCAL_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LOCAL_INITIALIZER: std::sync::Mutex<Option<(String, u64)>> = std::sync::Mutex::new(None);
struct LocalIntent(u64);
impl Drop for LocalIntent {
    fn drop(&mut self) {
        if let Ok(mut intent) = LOCAL_INITIALIZER.lock() {
            if intent
                .as_ref()
                .is_some_and(|(_, generation)| *generation == self.0)
            {
                *intent = None;
            }
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadStartRequest {
    pub schema_version: u8,
    pub download_ref: String,
    pub expected_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartRequest {
    pub schema_version: u8,
    pub file_ref: String,
    pub expected_revision: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionRequest {
    pub schema_version: u8,
    pub session_generation: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Started {
    schema_version: u8,
    session_generation: String,
    media_url: String,
    mime_type: &'static str,
    lease_ms: u64,
    cleanup_pending: bool,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum StartResult {
    Started {
        #[serde(flatten)]
        receipt: Started,
    },
    ConfirmedDead {
        #[serde(flatten)]
        receipt: archive_catalog::DeadReceipt,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Stopped {
    schema_version: u8,
    session_generation: String,
    stopped: bool,
    cleanup_pending: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Renewed {
    schema_version: u8,
    session_generation: String,
    renewed: bool,
    lease_ms: u64,
}
fn advance() -> Result<u64, String> {
    GENERATION
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
        .map(|prior| prior + 1)
        .map_err(|_| "archive-playback-generation-exhausted".into())
}
fn generation(value: &str) -> Result<u64, String> {
    if value.is_empty()
        || value.len() > 20
        || value.starts_with('0')
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("archive-playback-session-invalid".into());
    }
    value
        .parse()
        .map_err(|_| "archive-playback-session-invalid".into())
}
fn request_generation(request: &SessionRequest) -> Result<u64, String> {
    if request.schema_version != 1 {
        return Err("archive-playback-session-invalid".into());
    }
    generation(&request.session_generation)
}
pub(crate) async fn start(
    request: StartRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<StartResult, String> {
    if request.schema_version != 1
        || !archive_catalog::hex_ref(&request.file_ref)
        || archive_catalog::revision(&request.expected_revision)? < 1
    {
        return Err("archive-playback-request-invalid".into());
    }
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let startup_ends = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut active = ACTIVE.try_lock().map_err(|_| "archive-playback-busy")?;
        let current = advance()?;
        if let Some(proxy) = active.as_mut() {
            join_bookmark_jobs(&proxy.bookmark.jobs).await;
            proxy.proxy.stop().await?;
        }
        *active = None;
        owner.check()?;
        let file_ref = request.file_ref.clone();
        let revision = request.expected_revision.clone();
        let (file, root_generation) = owner
            .storage(None, move |store, check| {
                check()?;
                store.with_archive_read(|c| archive_catalog::resolve(c, &file_ref, &revision))
            })
            .await?;
        let verified =
            archive_discovery::verify_file_with_deadline(owner.clone(), &file, startup_ends)
                .await?;
        owner.check()?;
        if GENERATION.load(Ordering::SeqCst) != current {
            return Err("archive-playback-replaced".into());
        }
        let file = Arc::new(file);
        let selected_title_ref = file
            .public
            .as_ref()
            .map(|p| p.title_ref.clone())
            .unwrap_or_else(|| archive_catalog::opaque(&["archive-item-v1", &file.item_id]));
        let selected_file_ref = request.file_ref.clone();
        let verified = match verified {
            FileVerification::Missing(evidence) => {
                let file_ref = request.file_ref;
                let revision = request.expected_revision;
                let (dead, _) = owner
                    .storage(Some(root_generation), move |store, check| {
                        check()?;
                        if GENERATION.load(Ordering::SeqCst) != current {
                            return Err("archive-playback-replaced".into());
                        }
                        store.with_archive_write_checked(
                            &revision,
                            |_| Ok(None),
                            |c, check| {
                                archive_catalog::remove_confirmed_missing(
                                    c, &file_ref, &revision, &evidence, check,
                                )
                            },
                            check,
                        )
                    })
                    .await?;
                // No post-COMMIT cancellation check: the actual deletion receipt
                // must reach the frontend even when its original intent expired.
                return Ok(StartResult::ConfirmedDead { receipt: dead });
            }
            FileVerification::File(verified) => verified,
        };
        // Initial selection still requires exact global revision after network
        // metadata work. Ongoing traffic uses semantic selected-file authority.
        let ref_check = request.file_ref.clone();
        let rev_check = request.expected_revision.clone();
        owner
            .storage(Some(root_generation), move |store, check| {
                check()?;
                store.with_archive_read(|c| {
                    archive_catalog::resolve(c, &ref_check, &rev_check).map(|_| ())
                })
            })
            .await?;
        let authority_owner = owner.clone();
        let captured_file = file.clone();
        let reference = request.file_ref;
        let authority: Authority = Arc::new(move || {
            let owner = authority_owner.clone();
            let captured = captured_file.clone();
            let reference = reference.clone();
            Box::pin(async move {
                if GENERATION.load(Ordering::SeqCst) != current {
                    return Err("archive-playback-replaced".into());
                }
                owner
                    .storage(Some(root_generation), move |store, check| {
                        check()?;
                        store.with_archive_read(|c| {
                            archive_catalog::verify_live(c, &reference, &captured)
                        })
                    })
                    .await?;
                if GENERATION.load(Ordering::SeqCst) != current {
                    return Err("archive-playback-replaced".into());
                }
                Ok(())
            })
        });
        let live_owner = owner.clone();
        let alive: Alive = Arc::new(move || {
            live_owner.check().is_ok() && GENERATION.load(Ordering::SeqCst) == current
        });
        let mime_type = verified.mime;
        let proxy =
            ArchivePlaybackProxy::start(verified, current, authority, alive, startup_ends).await?;
        let media_url = proxy.media_url().to_owned();
        let valid = proxy.validity_handle();
        *active = Some(ActiveSession {
            proxy,
            file_ref: selected_file_ref.clone(),
            title_ref: selected_title_ref,
            download_ref: None,
            bookmark: Arc::new(BookmarkSession {
                local: None,
                file,
                reference: selected_file_ref,
                root_generation,
                owner: owner.clone(),
                jobs: Arc::new(crate::close_owner::WorkOwner::default()),
                valid,
            }),
        });
        if let Err(error) = owner.check().and_then(|_| {
            if GENERATION.load(Ordering::SeqCst) == current {
                Ok(())
            } else {
                Err("archive-playback-replaced".into())
            }
        }) {
            active
                .as_mut()
                .ok_or("archive-playback-owner-lost")?
                .proxy
                .stop()
                .await?;
            *active = None;
            return Err(error);
        }
        Ok(StartResult::Started {
            receipt: Started {
                schema_version: 1,
                session_generation: current.to_string(),
                media_url,
                mime_type,
                lease_ms: 60000,
                cleanup_pending: false,
            },
        })
    })
    .await
}
/// Independent local-file authority, through the same retained singleton and
/// decoder handoff. This path never calls provider metadata, DNS or HTTP.
pub(crate) async fn start_download(
    request: DownloadStartRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<StartResult, String> {
    if request.schema_version != 1 || !archive_catalog::hex_ref(&request.download_ref) {
        return Err("archive-download-request-invalid".into());
    }
    archive_catalog::revision(&request.expected_revision)?;
    scan_manifest_work::owned(request_id, app, move |owner| {
        start_download_owned(request, owner)
    })
    .await
}
async fn start_download_owned(
    request: DownloadStartRequest,
    owner: Arc<scan_manifest_work::Context>,
) -> Result<StartResult, String> {
    let _local_admission = LOCAL_GATE.try_lock().map_err(|_| "archive-playback-busy")?;
    let mut active = ACTIVE.try_lock().map_err(|_| "archive-playback-busy")?;
    let current = advance()?;
    if let Some(session) = active.as_mut() {
        join_bookmark_jobs(&session.bookmark.jobs).await;
        session.proxy.stop().await?;
    }
    *active = None;
    *LOCAL_INITIALIZER
        .lock()
        .map_err(|_| "archive-playback-owner-lock")? =
        Some((request.download_ref.clone(), current));
    let _intent = LocalIntent(current);
    let ends = std::time::Instant::now() + std::time::Duration::from_secs(120);
    let reference = request.download_ref.clone();
    let expected = request.expected_revision;
    let (body, root_generation) = owner
        .storage(None, move |store, check| {
            store.open_archive_download_checked(&reference, &expected, || {
                check()?;
                if GENERATION.load(Ordering::SeqCst) != current {
                    return Err("archive-playback-replaced".into());
                }
                if std::time::Instant::now() >= ends {
                    return Err("archive-download-verification-timeout".into());
                }
                Ok(())
            })
        })
        .await?;
    let local = body.proof.clone();
    let file = Arc::new(local.file());
    let file_ref = body.entry.file_ref.clone();
    let title_ref = body.entry.title_ref.clone();
    let authority_owner = owner.clone();
    let captured = local.clone();
    let authority: Authority = Arc::new(move || {
        let owner = authority_owner.clone();
        let proof = captured.clone();
        Box::pin(async move {
            if GENERATION.load(Ordering::SeqCst) != current {
                return Err("archive-playback-replaced".into());
            }
            owner
                .storage(Some(root_generation), move |store, check| {
                    check()?;
                    store.verify_archive_download_live(&proof)
                })
                .await?;
            if GENERATION.load(Ordering::SeqCst) != current {
                return Err("archive-playback-replaced".into());
            }
            Ok(())
        })
    });
    let live_owner = owner.clone();
    let alive: Alive = Arc::new(move || {
        live_owner.check().is_ok() && GENERATION.load(Ordering::SeqCst) == current
    });
    let proxy = ArchivePlaybackProxy::start_local(
        body,
        current,
        authority,
        alive,
        tokio::time::Instant::from_std(ends),
    )
    .await?;
    let media_url = proxy.media_url().to_owned();
    let valid = proxy.validity_handle();
    *active = Some(ActiveSession {
        proxy,
        file_ref: file_ref.clone(),
        title_ref,
        download_ref: Some(request.download_ref),
        bookmark: Arc::new(BookmarkSession {
            local: Some(local),
            file,
            reference: file_ref,
            root_generation,
            owner: owner.clone(),
            jobs: Arc::new(crate::close_owner::WorkOwner::default()),
            valid,
        }),
    });
    if let Err(error) = owner.check().and_then(|_| {
        if GENERATION.load(Ordering::SeqCst) == current {
            Ok(())
        } else {
            Err("archive-playback-replaced".into())
        }
    }) {
        active
            .as_mut()
            .ok_or("archive-playback-owner-lost")?
            .proxy
            .stop()
            .await?;
        *active = None;
        return Err(error);
    }
    Ok(StartResult::Started {
        receipt: Started {
            schema_version: 1,
            session_generation: current.to_string(),
            media_url,
            mime_type: "video/mp4",
            lease_ms: 60000,
            cleanup_pending: false,
        },
    })
}

/// Download removal owns its tombstone/mirror and unlink under this gate. A
/// matching initializer is revoked before joining its actual hash worker.
pub(crate) async fn with_download_removal<T, F, Fut>(
    reference: &str,
    operation: F,
) -> Result<T, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    if !archive_catalog::hex_ref(reference) {
        return Err("archive-download-request-invalid".into());
    }
    if let Some((_, generation)) = LOCAL_INITIALIZER
        .lock()
        .map_err(|_| "archive-playback-owner-lock")?
        .as_ref()
        .filter(|(id, _)| id == reference)
    {
        revoke_exact(&GENERATION, *generation);
    }
    let _admission = LOCAL_GATE.lock().await;
    {
        let mut active = ACTIVE.lock().await;
        if let Some(session) = active.as_mut() {
            if session.download_ref.as_deref() == Some(reference) {
                advance()?;
                join_bookmark_jobs(&session.bookmark.jobs).await;
                session.proxy.stop().await?;
                *active = None;
            }
        }
    }
    operation().await
}
async fn stop_exact(expected: u64) -> Result<(), String> {
    // Revoke the matching in-flight generation before waiting for its startup
    // mutex. An old stop cannot revoke a newer initializer or session.
    revoke_exact(&GENERATION, expected);
    let mut active = ACTIVE.lock().await;
    if expected > GENERATION.load(Ordering::SeqCst) {
        return Err("archive-playback-session-invalid".into());
    }
    if let Some(proxy) = active.as_mut() {
        if proxy.proxy.generation()? == expected {
            join_bookmark_jobs(&proxy.bookmark.jobs).await;
            proxy.proxy.stop().await?;
            *active = None;
        }
    }
    Ok(())
}
pub(crate) async fn stop(
    request: SessionRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Stopped, String> {
    let expected = request_generation(&request)?;
    validate_cleanup_request_id(&request_id)?;
    let work = app.state::<crate::NativeState>().work.acquire();
    spawn_cleanup(work, async move {
        stop_exact(expected).await?;
        // Stop cannot be canceled midway and reported as joined before it is.
        Ok(Stopped {
            schema_version: 1,
            session_generation: request.session_generation,
            stopped: true,
            cleanup_pending: false,
        })
    })
    .await
    .map_err(|_| "archive-playback-stop-unconfirmed".to_string())?
}
pub(crate) async fn renew(
    request: SessionRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Renewed, String> {
    let expected = request_generation(&request)?;
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let active = ACTIVE.lock().await;
        let proxy = active.as_ref().ok_or("archive-playback-expired")?;
        if GENERATION.load(Ordering::SeqCst) != expected || proxy.proxy.generation()? != expected {
            return Err("archive-playback-session-invalid".into());
        }
        owner.check()?;
        proxy.proxy.renew().await?;
        Ok(Renewed {
            schema_version: 1,
            session_generation: request.session_generation,
            renewed: true,
            lease_ms: 60000,
        })
    })
    .await
}
fn bookmark_authority(
    owner: &scan_manifest_work::Context,
    session: &BookmarkSession,
    expected: u64,
) -> Result<(), String> {
    owner.check()?;
    session.owner.check()?;
    if GENERATION.load(Ordering::SeqCst) != expected {
        return Err("archive-playback-session-invalid".into());
    }
    Ok(())
}
fn bookmark_admission(
    owner: &scan_manifest_work::Context,
    session: &BookmarkSession,
    expected: u64,
) -> Result<(), String> {
    bookmark_authority(owner, session, expected)?;
    if !(session.valid)() {
        return Err("archive-playback-expired".into());
    }
    Ok(())
}
async fn capture_bookmark_session(
    expected: u64,
) -> Result<(Arc<BookmarkSession>, crate::close_owner::WorkGuard), String> {
    let active = ACTIVE.lock().await;
    let session = active.as_ref().ok_or("archive-playback-expired")?;
    if GENERATION.load(Ordering::SeqCst) != expected || session.proxy.generation()? != expected {
        return Err("archive-playback-session-invalid".into());
    }
    if session.proxy.needs_cleanup()? {
        return Err("archive-playback-expired".into());
    }
    // Guard is acquired under the same mutex Stop uses. Original retained
    // command producer holds it until its real blocking storage worker settles.
    let work = session.bookmark.jobs.acquire();
    Ok((session.bookmark.clone(), work))
}
pub(crate) async fn read_bookmark(
    request: SessionRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<BookmarkRead, String> {
    let expected = request_generation(&request)?;
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (session, actual_job) = capture_bookmark_session(expected).await?;
        // Shared guard survives either observer/supervisor unwinding or a live
        // blocking producer. Normal release waits its actual JoinHandle result.
        let _actual_join = Arc::new(actual_job);
        let worker_job = _actual_join.clone();
        bookmark_admission(&owner, &session, expected)?;
        let scope = session.clone();
        let command_owner = owner.clone();
        let ((saved, supported), _) = owner
            .storage(Some(session.root_generation), move |store, _| {
                let _worker_job = worker_job;
                bookmark_admission(&command_owner, &scope, expected)?;
                if let Some(local) = &scope.local {
                    let result = store.read_archive_download_bookmark(local)?;
                    bookmark_admission(&command_owner, &scope, expected)?;
                    return Ok((result, true));
                }
                store.with_archive_read(|c| {
                    let result = match archive_bookmarks::capture(&scope.reference, &scope.file) {
                        Ok(proof) => (archive_bookmarks::read(c, &proof)?, true),
                        Err(error) if error == "archive-bookmark-identity-unproven" => (
                            archive_bookmarks::read_unsupported(c, &scope.reference, &scope.file)?,
                            false,
                        ),
                        Err(error) => return Err(error),
                    };
                    bookmark_admission(&command_owner, &scope, expected)?;
                    Ok(result)
                })
            })
            .await?;
        Ok(BookmarkRead {
            schema_version: 1,
            session_generation: request.session_generation,
            supported,
            revision: saved.revision,
            position: saved.position,
        })
    })
    .await
}
fn bookmark_now() -> Result<i64, String> {
    let milliseconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "archive-bookmark-clock-invalid")?
        .as_millis();
    let value = i64::try_from(milliseconds).map_err(|_| "archive-bookmark-clock-invalid")?;
    if value > 9_007_199_254_740_991 {
        return Err("archive-bookmark-clock-invalid".into());
    }
    Ok(value)
}
pub(crate) async fn save_bookmark(
    request: BookmarkSaveRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<BookmarkSaved, String> {
    // Include initial admission, ACTIVE contention and writer/backup time in
    // this one nonrenewable storage budget, independent of the media lease.
    let admitted_at = std::time::Instant::now();
    let expected = request_generation(&SessionRequest {
        schema_version: request.schema_version,
        session_generation: request.session_generation.clone(),
    })?;
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (session, actual_job) = capture_bookmark_session(expected).await?;
        let _actual_join = Arc::new(actual_job);
        let worker_job = _actual_join.clone();
        let permit =
            BookmarkSavePermit::admit(owner.clone(), session.clone(), expected, admitted_at)?;
        let proof = if session.local.is_none() {
            Some(archive_bookmarks::capture(
                &session.reference,
                &session.file,
            )?)
        } else {
            None
        };
        let local_proof = session.local.clone();
        let position = archive_bookmarks::Position {
            position_ms: request.position_ms,
            duration_ms: request.duration_ms,
            completed: request.completed,
            observed_ms: bookmark_now()?,
        };
        archive_bookmarks::validate_input(&request.expected_revision, &position)?;
        let (saved, _) = owner
            .storage(Some(session.root_generation), move |store, _| {
                let _worker_job = worker_job;
                let check = || permit.check();
                if let Some(local) = local_proof {
                    return store.write_archive_download_bookmark_checked(
                        &local,
                        &request.expected_revision,
                        &position,
                        check,
                    );
                }
                store.write_archive_bookmark_checked(
                    &proof.ok_or("archive-bookmark-identity-unproven")?,
                    &request.expected_revision,
                    &position,
                    check,
                )
            })
            .await?;
        // COMMIT truth survives late abort/revoke; no admission check here.
        Ok(BookmarkSaved {
            schema_version: 1,
            session_generation: request.session_generation,
            committed: saved.committed,
            revision: saved.revision,
            changed: saved.changed,
        })
    })
    .await
}
pub(crate) async fn retry_cleanup() -> Result<(), String> {
    let mut active = ACTIVE.lock().await;
    if let Some(proxy) = active.as_mut() {
        if proxy.proxy.needs_cleanup()? {
            join_bookmark_jobs(&proxy.bookmark.jobs).await;
            proxy.proxy.stop().await?;
            *active = None;
        }
    }
    Ok(())
}
/// Root calls BEFORE draining native work guards; proxy authorities retain one.
pub(crate) async fn shutdown() -> Result<(), String> {
    let advanced = advance();
    let mut active = ACTIVE.lock().await;
    if let Some(proxy) = active.as_mut() {
        join_bookmark_jobs(&proxy.bookmark.jobs).await;
        proxy.proxy.stop().await?;
    }
    *active = None;
    advanced.map(|_| ())
}

/// Called after a durable user removal. Join a matching initializer/session,
/// leaving unrelated playback and failed cleanup ownership intact.
pub(crate) async fn revoke_removed(scope: &archive_catalog::RemovalScope) -> Result<(), String> {
    let mut active = ACTIVE.lock().await;
    if let Some(session) = active.as_mut() {
        if session.download_ref.is_none()
            && removal_matches(scope, &session.title_ref, &session.file_ref)
        {
            advance()?;
            join_bookmark_jobs(&session.bookmark.jobs).await;
            session.proxy.stop().await?;
            *active = None;
        }
    }
    Ok(())
}
fn removal_matches(scope: &archive_catalog::RemovalScope, title: &str, file: &str) -> bool {
    match scope {
        archive_catalog::RemovalScope::TitleRef(reference) => title == reference,
        archive_catalog::RemovalScope::FileRef(reference) => file == reference,
        archive_catalog::RemovalScope::All => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    fn bookmark_permit_database() -> (
        tempfile::TempDir,
        Arc<crate::storage_transaction::PairStore>,
        archive_bookmarks::Proof,
    ) {
        let root = tempfile::tempdir().unwrap();
        let store =
            Arc::new(crate::storage_transaction::PairStore::new(root.path().into()).unwrap());
        let title = archive_catalog::opaque(&["archive-item-v1", "fixture"]);
        let reference = archive_catalog::opaque(&["archive-file-v1", "fixture", "episode.mp4"]);
        let proof=store.with_guide_write(|c| {
            c.execute_batch("CREATE TABLE permit_fixture(id INTEGER PRIMARY KEY,payload BLOB);INSERT INTO permit_fixture VALUES(1,zeroblob(1048576));").map_err(|_|"fixture")?;
            c.execute("INSERT INTO archive_title_v1(title_ref,item_id,title,kind,release_year,curated,searched,rights,downloads,observed_ms,search_text) VALUES(?1,'fixture','Fixture','tv',1964,0,1,NULL,1,1,'fixture')",[&title]).map_err(|_|"fixture")?;
            c.execute("INSERT INTO archive_file_v1(file_ref,title_ref,item_id,file_name,format,size_bytes,sha1,servers,observed_ms,eligible) VALUES(?1,?2,'fixture','episode.mp4','h.264','100','0123456789abcdef0123456789abcdef01234567','[]',1,1)",rusqlite::params![reference,title]).map_err(|_|"fixture")?;
            archive_bookmarks::capture(&reference,&archive_catalog::resolve(c,&reference,"0")?)
        }).unwrap();
        (root, store, proof)
    }
    fn bookmark_permit_position() -> archive_bookmarks::Position {
        archive_bookmarks::Position {
            position_ms: 16_182,
            duration_ms: Some(1_463_897),
            completed: false,
            observed_ms: 1000,
        }
    }
    #[test]
    fn archive_bookmark_save_permit_real_admission_denies_expired_new_job_and_retains_context_cancellation(
    ) {
        for cancel_command in [false, true] {
            let (_root, command, playback, _work, mut requests) =
                scan_manifest_work::bookmark_context_fixture();
            let (valid, expire_media) = crate::archive_playback_proxy::bookmark_lease_fixture();
            let expected = GENERATION.load(Ordering::SeqCst);
            let session = Arc::new(BookmarkSession {
                local: None,
                file: Arc::new(archive_catalog::ResolvedFile {
                    item_id: "fixture".into(),
                    file_name: "episode.mp4".into(),
                    size_bytes: "100".into(),
                    sha1: Some("0123456789abcdef0123456789abcdef01234567".into()),
                    servers: vec![],
                    duration_seconds: Some(60.0),
                    provider_index: None,
                    public: None,
                }),
                reference: archive_catalog::opaque(&["archive-file-v1", "fixture", "episode.mp4"]),
                root_generation: 1,
                owner: playback.clone(),
                jobs: Arc::new(crate::close_owner::WorkOwner::default()),
                valid,
            });
            let original = BookmarkSavePermit::admit(
                command.clone(),
                session.clone(),
                expected,
                std::time::Instant::now(),
            )
            .unwrap();
            assert!(
                matches!(BookmarkSavePermit::admit(command.clone(),session.clone(),expected,std::time::Instant::now()-BOOKMARK_SAVE_BUDGET),Err(error) if error=="archive-bookmark-save-deadline")
            );
            expire_media();
            assert!(
                matches!(bookmark_admission(&command,&session,expected),Err(error) if error=="archive-playback-expired")
            );
            assert!(
                matches!(BookmarkSavePermit::admit(command.clone(), session, expected, std::time::Instant::now()),Err(error) if error=="archive-playback-expired")
            );
            original.check().unwrap();
            requests
                .cancel(
                    if cancel_command {
                        "bookmark-command-fixture"
                    } else {
                        "manifest-fixture"
                    }
                    .into(),
                )
                .unwrap();
            assert!(matches!(original.check(),Err(error) if error=="canceled"));
            if cancel_command {
                playback.check().unwrap();
            } else {
                command.check().unwrap();
            }
        }
    }
    #[tokio::test]
    async fn archive_bookmark_save_permit_held_backup_survives_media_expiry_but_new_admission_is_denied(
    ) {
        for strict_media_during_job in [true, false] {
            let (_root, store, proof) = bookmark_permit_database();
            let (media_valid, expire_media) =
                crate::archive_playback_proxy::bookmark_lease_fixture();
            assert!(media_valid()); // Required before any save permit is minted.
            let admitted_at = std::time::Instant::now();
            let permit = BookmarkSavePermit {
                ends: admitted_at + BOOKMARK_SAVE_BUDGET,
                authority: Box::new(|| Ok(())),
            };
            let clock = Arc::new(AtomicU64::new(0));
            let actual_clock = clock.clone();
            let actual_media = media_valid.clone();
            let jobs = Arc::new(crate::close_owner::WorkOwner::default());
            let original_job = jobs.acquire();
            let producer_store = store.clone();
            let (entered, pinned) = tokio::sync::oneshot::channel();
            let (release, held) = std::sync::mpsc::channel();
            let (outcome, observed) = tokio::sync::oneshot::channel();
            let producer = tokio::task::spawn_blocking(move || {
                let _original_job = original_job;
                let calls = AtomicUsize::new(0);
                let signal = std::sync::Mutex::new(Some(entered));
                let check = || {
                    // PairStore admission/preflight/backup admission precede the
                    // fourth check, actual BackupPhase::SnapshotPinned.
                    if calls.fetch_add(1, Ordering::SeqCst) == 3 {
                        signal.lock().unwrap().take().unwrap().send(()).unwrap();
                        held.recv().unwrap();
                    }
                    if strict_media_during_job && !actual_media() {
                        return Err("archive-playback-expired".into());
                    }
                    permit.check_with_clock(|| {
                        admitted_at
                            + std::time::Duration::from_secs(actual_clock.load(Ordering::SeqCst))
                    })
                };
                let result = producer_store.write_archive_bookmark_checked(
                    &proof,
                    "0",
                    &bookmark_permit_position(),
                    check,
                );
                outcome.send(result).ok();
            });
            pinned.await.unwrap();
            drop(producer); // Original SQL worker remains owned independently.
            expire_media();
            clock.store(61, Ordering::SeqCst);
            assert!(!media_valid()); // Strict read/renew/new-save admission remains false.
            let retained_jobs = jobs.clone();
            let mut stop = tokio::spawn(async move { join_bookmark_jobs(&retained_jobs).await });
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(5), &mut stop)
                    .await
                    .is_err()
            );
            assert_eq!(jobs.count(), 1);
            release.send(()).unwrap();
            stop.await.unwrap();
            let receipt = observed.await.unwrap();
            if strict_media_during_job {
                assert!(matches!(receipt,Err(error) if error=="archive-playback-expired"));
            } else {
                let receipt = receipt.unwrap();
                assert!(receipt.committed && receipt.changed);
                assert_eq!(receipt.revision, "1");
            }
            store
                .with_guide_read(|c| {
                    let expected = if strict_media_during_job { 0 } else { 1 };
                    assert_eq!(
                        c.query_row("SELECT revision FROM archive_bookmark_meta_v1", [], |r| r
                            .get::<_, i64>(
                            0
                        ))
                        .unwrap(),
                        expected
                    );
                    if !strict_media_during_job {
                        assert_eq!(
                            c.query_row("SELECT position_ms FROM archive_bookmark_v1", [], |r| r
                                .get::<_, i64>(
                                0
                            ))
                            .unwrap(),
                            16_182
                        );
                    }
                    Ok(())
                })
                .unwrap();
            assert!(!media_valid()); // Committing storage never revives media.
            assert_eq!(jobs.count(), 0);
        }
    }
    #[tokio::test]
    async fn archive_bookmark_save_permit_held_backup_still_refuses_cancel_close_replacement_and_deadline(
    ) {
        for revoke in [
            "command-cancel",
            "playback-cancel",
            "closing",
            "generation",
            "deadline",
        ] {
            let (root, store, proof) = bookmark_permit_database();
            let before = (
                std::fs::read(root.path().join("genx.sqlite3")).unwrap(),
                std::fs::read(root.path().join("genx.sqlite3.backup")).unwrap(),
            );
            let generation = Arc::new(AtomicU64::new(1));
            let command_canceled = Arc::new(AtomicBool::new(false));
            let playback_canceled = Arc::new(AtomicBool::new(false));
            let closing = Arc::new(AtomicBool::new(false));
            let actual_generation = generation.clone();
            let command = command_canceled.clone();
            let playback = playback_canceled.clone();
            let close = closing.clone();
            let admitted_at = std::time::Instant::now();
            // Controlled authority boundary corresponds to both retained native
            // Contexts and exact generation. Their real root/cancel behavior is
            // separately covered by scan_manifest_work ownership fixtures.
            let permit = BookmarkSavePermit {
                ends: admitted_at + BOOKMARK_SAVE_BUDGET,
                authority: Box::new(move || {
                    if close.load(Ordering::SeqCst) {
                        return Err("application-closing".into());
                    }
                    if command.load(Ordering::SeqCst) || playback.load(Ordering::SeqCst) {
                        return Err("canceled".into());
                    }
                    if actual_generation.load(Ordering::SeqCst) != 1 {
                        return Err("archive-playback-session-invalid".into());
                    }
                    Ok(())
                }),
            };
            let clock = Arc::new(AtomicU64::new(0));
            let actual_clock = clock.clone();
            let jobs = Arc::new(crate::close_owner::WorkOwner::default());
            let original_job = jobs.acquire();
            let producer_store = store.clone();
            let (entered, pinned) = tokio::sync::oneshot::channel();
            let (release, held) = std::sync::mpsc::channel();
            let producer = tokio::task::spawn_blocking(move || {
                let _original_job = original_job;
                let calls = AtomicUsize::new(0);
                let signal = std::sync::Mutex::new(Some(entered));
                producer_store.write_archive_bookmark_checked(
                    &proof,
                    "0",
                    &bookmark_permit_position(),
                    || {
                        if calls.fetch_add(1, Ordering::SeqCst) == 3 {
                            signal.lock().unwrap().take().unwrap().send(()).unwrap();
                            held.recv().unwrap();
                        }
                        permit.check_with_clock(|| {
                            admitted_at
                                + std::time::Duration::from_secs(
                                    actual_clock.load(Ordering::SeqCst),
                                )
                        })
                    },
                )
            });
            pinned.await.unwrap();
            match revoke {
                "command-cancel" => command_canceled.store(true, Ordering::SeqCst),
                "playback-cancel" => playback_canceled.store(true, Ordering::SeqCst),
                "closing" => closing.store(true, Ordering::SeqCst),
                "generation" => revoke_exact(&generation, 1),
                _ => clock.store(120, Ordering::SeqCst),
            }
            let retained_jobs = jobs.clone();
            let mut stop = tokio::spawn(async move { join_bookmark_jobs(&retained_jobs).await });
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(5), &mut stop)
                    .await
                    .is_err()
            );
            release.send(()).unwrap();
            let result = producer.await.unwrap();
            let expected = match revoke {
                "closing" => "application-closing",
                "generation" => "archive-playback-session-invalid",
                "deadline" => "archive-bookmark-save-deadline",
                _ => "canceled",
            };
            assert!(matches!(result,Err(error) if error==expected));
            stop.await.unwrap();
            assert_eq!(jobs.count(), 0);
            assert_eq!(
                (
                    std::fs::read(root.path().join("genx.sqlite3")).unwrap(),
                    std::fs::read(root.path().join("genx.sqlite3.backup")).unwrap()
                ),
                before
            );
        }
    }
    #[test]
    fn archive_bookmark_save_wire_is_session_only_and_rejects_invented_authority() {
        let base = serde_json::json!({"schemaVersion":1,"sessionGeneration":"1","expectedRevision":"0","positionMs":12345,"durationMs":60000,"completed":false});
        assert!(serde_json::from_value::<BookmarkSaveRequest>(base.clone()).is_ok());
        for field in ["fileRef", "url", "observedMs", "rootGeneration"] {
            let mut injected = base.clone();
            injected[field] = serde_json::json!("invented");
            assert!(serde_json::from_value::<BookmarkSaveRequest>(injected).is_err());
        }
        let mut injected = base;
        injected["positionMs"] = serde_json::json!(1.5);
        assert!(serde_json::from_value::<BookmarkSaveRequest>(injected).is_err());
    }
    #[tokio::test]
    async fn archive_bookmark_stop_join_retains_original_sql_worker_after_observer_loss_and_revocation(
    ) {
        let root = tempfile::tempdir().unwrap();
        let store =
            Arc::new(crate::storage_transaction::PairStore::new(root.path().into()).unwrap());
        let item = "fixture";
        let reference = archive_catalog::opaque(&["archive-file-v1", item, "episode.mp4"]);
        let title = archive_catalog::opaque(&["archive-item-v1", item]);
        let proof=store.with_guide_write(|c|{
            c.execute("INSERT INTO archive_title_v1(title_ref,item_id,title,kind,release_year,curated,searched,rights,downloads,observed_ms,search_text) VALUES(?1,'fixture','Fixture','tv',1964,0,1,NULL,1,1,'fixture')",[&title]).map_err(|_|"fixture")?;
            c.execute("INSERT INTO archive_file_v1(file_ref,title_ref,item_id,file_name,format,size_bytes,sha1,servers,observed_ms,eligible) VALUES(?1,?2,'fixture','episode.mp4','h.264','100','0123456789abcdef0123456789abcdef01234567','[]',1,1)",rusqlite::params![reference,title]).map_err(|_|"fixture")?;
            archive_bookmarks::capture(&reference,&archive_catalog::resolve(c,&reference,"0")?)
        }).unwrap();
        let jobs = Arc::new(crate::close_owner::WorkOwner::default());
        let actual_guard = jobs.acquire();
        let generation = Arc::new(AtomicU64::new(1));
        let g = generation.clone();
        let producer_store = store.clone();
        let (ready, started) = tokio::sync::oneshot::channel();
        let (release, held) = tokio::sync::oneshot::channel();
        let (outcome, result) = tokio::sync::oneshot::channel();
        let observer = tokio::task::spawn_blocking(move || {
            let _actual_guard = actual_guard;
            ready.send(()).unwrap();
            held.blocking_recv().unwrap();
            let check = || {
                if g.load(Ordering::SeqCst) == 1 {
                    Ok(())
                } else {
                    Err("archive-playback-session-invalid".into())
                }
            };
            let position = archive_bookmarks::Position {
                position_ms: 12345,
                duration_ms: Some(60000),
                completed: false,
                observed_ms: 1000,
            };
            let saved =
                producer_store.write_archive_bookmark_checked(&proof, "0", &position, check);
            outcome.send(saved.is_err()).unwrap();
        });
        started.await.unwrap();
        drop(observer); // Original producer still owns its job.
        revoke_exact(&generation, 1);
        let j = jobs.clone();
        let mut stop = tokio::spawn(async move {
            join_bookmark_jobs(&j).await;
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), &mut stop)
                .await
                .is_err()
        );
        assert_eq!(jobs.count(), 1);
        release.send(()).unwrap();
        stop.await.unwrap();
        assert!(result.await.unwrap());
        assert_eq!(jobs.count(), 0);
        store
            .with_guide_read(|c| {
                assert_eq!(
                    c.query_row("SELECT revision FROM archive_bookmark_meta_v1", [], |r| r
                        .get::<_, i64>(
                        0
                    ))
                    .unwrap(),
                    0
                );
                assert_eq!(
                    c.query_row("SELECT count(*) FROM archive_bookmark_v1", [], |r| r
                        .get::<_, i64>(0))
                        .unwrap(),
                    0
                );
                Ok(())
            })
            .unwrap();
    }
    #[tokio::test]
    async fn cleanup_after_close_retains_actual_join_when_observer_disappears() {
        let mut requests = crate::requests::Requests::default();
        let owner = requests.drain_owner();
        requests.stop();
        assert_eq!(
            requests.register("ordinary-start".into()).unwrap_err(),
            "application-closing"
        );
        let (release, receive) = tokio::sync::oneshot::channel();
        let settled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let actual = settled.clone();
        let observer = spawn_cleanup(owner.acquire(), async move {
            receive
                .await
                .map_err(|_| "fixture-release-lost".to_string())?;
            actual.store(true, Ordering::SeqCst);
            Ok(())
        });
        drop(observer);
        assert_eq!(owner.count(), 1);
        assert!(!settled.load(Ordering::SeqCst));
        release.send(()).unwrap();
        owner.drained().await;
        assert!(settled.load(Ordering::SeqCst));
        assert_eq!(owner.count(), 0);
    }
    #[tokio::test]
    async fn cleanup_preserves_failure_instead_of_claiming_joined_success() {
        let owner = Arc::new(crate::close_owner::WorkOwner::default());
        let result = spawn_cleanup::<(), _>(owner.acquire(), async {
            Err("archive-producer-stop-failed".to_string())
        })
        .await
        .unwrap();
        assert_eq!(result.unwrap_err(), "archive-producer-stop-failed");
        assert_eq!(owner.count(), 0);
    }
    #[test]
    fn exact_stop_is_idempotent_after_shutdown_and_cannot_revoke_replacement() {
        let current = AtomicU64::new(10);
        revoke_exact(&current, 10);
        assert_eq!(current.load(Ordering::SeqCst), 11);
        revoke_exact(&current, 10);
        assert_eq!(current.load(Ordering::SeqCst), 11);
        // A shutdown or replacement has already revoked generation 10.
        current.store(12, Ordering::SeqCst);
        revoke_exact(&current, 10);
        assert_eq!(current.load(Ordering::SeqCst), 12);
        revoke_exact(&current, 13);
        assert_eq!(current.load(Ordering::SeqCst), 12);
    }
    #[test]
    fn cleanup_wire_validation_is_preserved_without_request_registry_admission() {
        assert!(validate_cleanup_request_id("").is_err());
        assert!(validate_cleanup_request_id(&"x".repeat(129)).is_err());
        assert!(validate_cleanup_request_id(&"x".repeat(128)).is_ok());
        assert!(request_generation(&SessionRequest {
            schema_version: 2,
            session_generation: "1".into(),
        })
        .is_err());
    }
    #[test]
    fn removal_scope_preserves_unrelated_archive_playback() {
        use archive_catalog::RemovalScope::*;
        assert!(removal_matches(&All, "title-a", "file-a"));
        assert!(removal_matches(
            &TitleRef("title-a".into()),
            "title-a",
            "file-a"
        ));
        assert!(removal_matches(
            &FileRef("file-a".into()),
            "title-a",
            "file-a"
        ));
        assert!(!removal_matches(
            &TitleRef("title-b".into()),
            "title-a",
            "file-a"
        ));
        assert!(!removal_matches(
            &FileRef("file-b".into()),
            "title-a",
            "file-a"
        ));
        assert!(!removal_matches(
            &TitleRef("file-a".into()),
            "title-a",
            "file-a"
        ));
    }
    #[test]
    fn generations_are_canonical_positive_and_bounded() {
        for s in ["", "0", "01", "-1", "1.0", "18446744073709551616"] {
            assert!(generation(s).is_err());
        }
        assert_eq!(generation("18446744073709551615").unwrap(), u64::MAX);
    }
    #[test]
    fn confirmed_dead_receipt_has_no_playback_or_upstream_fields() {
        let receipt = StartResult::ConfirmedDead {
            receipt: archive_catalog::DeadReceipt {
                schema_version: 1,
                committed: true,
                revision: "2".into(),
                confirmed_dead: 1,
                title_count: 0,
            },
        };
        let value = serde_json::to_value(receipt).unwrap();
        assert_eq!(value["kind"], "confirmedDead");
        assert_eq!(value["committed"], true);
        assert_eq!(value.as_object().unwrap().len(), 6);
        assert!(value.get("mediaUrl").is_none());
    }
}

#[cfg(test)]
#[path = "archive_download_playback_tests.rs"]
mod download_tests;
