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

//! Storage commands: the saved catalog and preferences records, storage recovery and location, health records and timing diagnostics.
use crate::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeInfo {
    platform: &'static str,
    data_mode: String,
}

#[tauri::command]
pub(crate) fn runtime_info(state: tauri::State<NativeState>) -> Result<RuntimeInfo, String> {
    Ok(RuntimeInfo {
        platform: std::env::consts::OS,
        data_mode: state
            .store
            .read()
            .map_err(|_| "storage-lock".to_string())?
            .as_ref()
            .map_err(Clone::clone)?
            .mode
            .clone(),
    })
}

#[tauri::command]
pub(crate) fn get_storage_timings() -> storage_timings::Snapshot {
    storage_timings::snapshot()
}

#[tauri::command]
pub(crate) fn get_native_startup_milestones() -> startup_milestones::Snapshot {
    startup_milestones::snapshot()
}

#[tauri::command]
pub(crate) fn get_native_root_selection_milestones() -> startup_milestones::RootSnapshot {
    startup_milestones::root_snapshot()
}

#[tauri::command]
pub(crate) async fn read_record(
    name: String,
    state: tauri::State<'_, NativeState>,
) -> Result<Option<String>, String> {
    let store = state.store.clone();
    let work = state.admit_work()?;
    state.startup.join().await;
    if state.closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        store
            .read()
            .map_err(|_| "storage-lock".to_string())?
            .as_ref()
            .map_err(Clone::clone)?
            .read(&name)
    })
    .await
    .map_err(|_| "storage-worker-failed".to_string())?
}

#[tauri::command]
pub(crate) async fn write_record(
    name: String,
    contents: String,
    state: tauri::State<'_, NativeState>,
) -> Result<(), String> {
    let store = state.store.clone();
    let work = state.admit_work()?;
    let closing = state.closing.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        store
            .read()
            .map_err(|_| "storage-lock".to_string())?
            .as_ref()
            .map_err(Clone::clone)?
            .write_record_guarded(&name, &contents, None, || {
                if closing.load(Ordering::SeqCst) {
                    Err("application-closing".into())
                } else {
                    Ok(())
                }
            })
            .map(|_| ())
    })
    .await
    .map_err(|_| "storage-worker-failed".to_string())?
}

#[tauri::command]
pub(crate) async fn read_record_pair(
    state: tauri::State<'_, NativeState>,
) -> Result<storage_transaction::RecordSnapshot, String> {
    use startup_milestones::Event;
    let trace = startup_milestones::first_read_pair();
    let read_trace = trace.clone();
    let result = async {
        let store = state.store.clone();
        let succeeded = state.read_succeeded.clone();
        let work = state.admit_work()?;
        state.startup.join().await;
        read_trace.mark(Event::ReadPairStartupJoined);
        if state.closing.load(Ordering::SeqCst) {
            return Err("application-closing".into());
        }
        read_trace.mark(Event::ReadPairWorkerQueued);
        tauri::async_runtime::spawn_blocking(move || {
            read_trace.mark(Event::ReadPairWorkerStarted);
            let _work = work;
            // Includes the pinned root-read lease, SQL snapshot and record encoding.
            read_trace.mark(Event::ReadPairSnapshotStarted);
            let result = store.read_initial(&succeeded);
            read_trace.result(Event::ReadPairSnapshotFinished, result.is_ok());
            result
        })
        .await
        .map_err(|_| "storage-worker-failed".to_string())?
    }
    .await;
    trace.finish(result.is_ok());
    result
}

#[tauri::command]
pub(crate) async fn read_scan_health(
    state: tauri::State<'_, NativeState>,
) -> Result<storage_transaction::ScanHealthSnapshot, String> {
    let store = state.store.clone();
    let succeeded = state.read_succeeded.clone();
    let work = state.admit_work()?;
    state.startup.join().await;
    if state.closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        // Preserve the validated, atomic SQLite snapshot and captured revisions;
        // drop the catalog/preferences before serializing the IPC reply.
        store.read_initial(&succeeded).map(Into::into)
    })
    .await
    .map_err(|_| "storage-worker-failed".to_string())?
}

#[tauri::command]
pub(crate) async fn read_guide_capture(
    state: tauri::State<'_, NativeState>,
) -> Result<storage_transaction::GuideCaptureSnapshot, String> {
    let store = state.store.clone();
    let succeeded = state.read_succeeded.clone();
    let work = state.admit_work()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        store.read_guide_capture(&succeeded)
    })
    .await
    .map_err(|_| "storage-worker-failed".to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageRecoveryStatus {
    platform: &'static str,
    available: bool,
    state: &'static str,
    error_category: Option<&'static str>,
    explicit_environment: bool,
}

#[tauri::command]
pub(crate) async fn storage_recovery_status(
    state: tauri::State<'_, NativeState>,
) -> Result<StorageRecoveryStatus, String> {
    let _work = state.admit_work()?;
    state.startup.join().await;
    if state.closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    let current = state.store.read().map_err(|_| "storage-lock".to_string())?;
    let healthy = current.is_ok() || state.read_succeeded.load(Ordering::SeqCst);
    let explicit_environment = std::env::var_os("TMG_DATA_DIR").is_some();
    #[cfg(windows)]
    let (available, choosing, error_category) = (
        !healthy
            && !explicit_environment
            && state.bookmarks.is_ok()
            && !state.closing.load(Ordering::SeqCst),
        state.recovery.active(),
        current
            .as_ref()
            .err()
            .map(|e| storage_recovery::error_category(e)),
    );
    #[cfg(not(windows))]
    let (available, choosing, error_category) =
        (false, false, current.as_ref().err().map(|_| "unavailable"));
    Ok(StorageRecoveryStatus {
        platform: std::env::consts::OS,
        available,
        state: if choosing {
            "choosing"
        } else if healthy {
            "healthy"
        } else {
            "failed"
        },
        error_category,
        explicit_environment,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageChoice {
    data_mode: &'static str,
    restart_persistent: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageRetry {
    data_mode: String,
    retry_ready: bool,
}

#[tauri::command]
pub(crate) async fn retry_storage(app: tauri::AppHandle) -> Result<StorageRetry, String> {
    let state = app.state::<NativeState>();
    let work = state.admit_work()?;
    state.startup.join().await;
    if state.closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    let (playback, downloads) = tokio::join!(
        archive_playback_owner::shutdown(),
        archive_download_owner::shutdown()
    );
    playback?;
    downloads?;
    #[cfg(windows)]
    let choice = state.recovery.begin()?;
    let store = state.store.clone();
    let target = state.storage_target.clone();
    let succeeded = state.read_succeeded.clone();
    let closing = state.closing.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let mut current = store.exclusive().map_err(|_| "storage-lock")?;
        let target = target.lock().map_err(|_| "storage-lock")?.clone();
        let data_mode = storage::retry_same_location(&mut current, &target, &succeeded, || {
            if closing.load(Ordering::SeqCst) {
                return Err("application-closing".into());
            }
            #[cfg(windows)]
            choice.ensure_current(&closing)?;
            Ok(())
        })?;
        Ok(StorageRetry {
            data_mode,
            retry_ready: true,
        })
    })
    .await
    .map_err(|_| "storage-worker-failed".to_string())?
}

#[tauri::command]
pub(crate) async fn choose_storage_directory(
    path: String,
    app: tauri::AppHandle,
) -> Result<StorageChoice, String> {
    #[cfg(not(windows))]
    {
        let _ = (path, app);
        Err("storage-choice-platform-unavailable".into())
    }
    #[cfg(windows)]
    {
        let state = app.state::<NativeState>();
        let _opening_wait = state.admit_work()?;
        state.startup.join().await;
        let choice = state.recovery.begin()?;
        if state.closing.load(Ordering::SeqCst) {
            return Err("application-closing".into());
        }
        if std::env::var_os("TMG_DATA_DIR").is_some() {
            return Err("storage-explicit-environment-restart-required".into());
        }
        {
            let current = state.store.read().map_err(|_| "storage-lock")?;
            if current.is_ok() || state.read_succeeded.load(Ordering::SeqCst) {
                return Err("storage-healthy-switch-refused".into());
            }
        }
        let bookmarks = state.bookmarks.clone();
        let (playback, downloads) = tokio::join!(
            archive_playback_owner::shutdown(),
            archive_download_owner::shutdown()
        );
        playback?;
        downloads?;
        let store = state.store.clone();
        let succeeded = state.read_succeeded.clone();
        let target = state.storage_target.clone();
        let work = state.admit_work()?;
        tauri::async_runtime::spawn_blocking(move || {
            let _work = work;
            let bookmarks = bookmarks.as_ref().as_ref().map_err(Clone::clone)?;
            let path = std::path::PathBuf::from(path);
            storage_recovery::validate_path(&path)?;
            let candidate = storage::Store::new(path.clone(), "explicit-directory".into())?;
            candidate.read_snapshot()?;
            let mut current = store.exclusive().map_err(|_| "storage-lock")?;
            // Both guards are acquired before bookmark/publication. No fallible
            // operation remains between successful choice and target update.
            let mut target = target.lock().map_err(|_| "storage-lock")?;
            choice.commit_retained(
                bookmarks,
                &path,
                candidate,
                (&mut current, &mut target),
                &app.state::<NativeState>().closing,
                &succeeded,
            )?;
            Ok(StorageChoice {
                data_mode: "explicit-directory",
                restart_persistent: true,
            })
        })
        .await
        .map_err(|_| "storage-worker-failed".to_string())?
    }
}

#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "Preserve existing flat IPC fields while adding optional atomic checkpoint CAS."
)]
pub(crate) async fn write_record_pair(
    catalog: String,
    preferences: String,
    health: Option<String>,
    expected_catalog_revision: Option<String>,
    expected_health_revision: Option<String>,
    scan_checkpoint: Option<scan_checkpoint::Mutation>,
    expected_checkpoint_revision: Option<String>,
    request_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<storage_transaction::CommitReceipt, String> {
    let state = app.state::<NativeState>();
    if state.closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    if scan_checkpoint.is_some() != expected_checkpoint_revision.is_some() {
        return Err("scan-checkpoint-revision-required".into());
    }
    let mut receiver = request_id
        .as_ref()
        .map(|id| {
            state
                .requests
                .lock()
                .map_err(|_| "request-lock".to_string())?
                .register(id.clone())
        })
        .transpose()?;
    let store = state.store.clone();
    let worker_app = app.clone();
    let work = state.admit_work()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let mut check = || {
            if worker_app
                .state::<NativeState>()
                .closing
                .load(Ordering::SeqCst)
            {
                return Err("application-closing".to_string());
            }
            if receiver.as_mut().is_some_and(|r| {
                !matches!(
                    r.try_recv(),
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty)
                )
            }) {
                return Err("canceled".to_string());
            }
            Ok(())
        };
        check()?;
        let current = store.read().map_err(|_| "storage-lock")?;
        check()?;
        current
            .as_ref()
            .map_err(Clone::clone)?
            .write_pair_with_scan(
                &storage_transaction::RecordPair {
                    catalog: Some(catalog),
                    preferences: Some(preferences),
                },
                health.as_deref(),
                (
                    expected_catalog_revision.as_deref(),
                    expected_health_revision.as_deref(),
                ),
                scan_checkpoint
                    .as_ref()
                    .zip(expected_checkpoint_revision.as_deref()),
                check,
            )
    })
    .await
    .map_err(|_| "storage-worker-failed".to_string());
    if let Some(id) = request_id {
        state
            .requests
            .lock()
            .map_err(|_| "request-lock".to_string())?
            .finish(&id);
    }
    result?
}

#[tauri::command]
pub(crate) async fn write_health(
    health: String,
    expected_catalog_revision: String,
    expected_health_revision: String,
    request_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<storage_transaction::CommitReceipt, String> {
    let state = app.state::<NativeState>();
    if state.closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    let mut receiver = request_id
        .as_ref()
        .map(|id| {
            state
                .requests
                .lock()
                .map_err(|_| "request-lock".to_string())?
                .register(id.clone())
        })
        .transpose()?;
    let store = state.store.clone();
    let worker_app = app.clone();
    let work = state.admit_work()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let mut check = || {
            if worker_app
                .state::<NativeState>()
                .closing
                .load(Ordering::SeqCst)
            {
                return Err("application-closing".to_string());
            }
            if receiver.as_mut().is_some_and(|r| {
                !matches!(
                    r.try_recv(),
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty)
                )
            }) {
                return Err("canceled".to_string());
            }
            Ok(())
        };
        check()?;
        let current = store.read().map_err(|_| "storage-lock")?;
        check()?;
        current
            .as_ref()
            .map_err(Clone::clone)?
            .write_health_guarded(
                &health,
                &expected_catalog_revision,
                &expected_health_revision,
                check,
            )
    })
    .await
    .map_err(|_| "storage-worker-failed".to_string());
    if let Some(id) = request_id {
        state
            .requests
            .lock()
            .map_err(|_| "request-lock".to_string())?
            .finish(&id);
    }
    result?
}

#[tauri::command]
pub(crate) async fn write_record_receipt(
    name: String,
    contents: String,
    expected_catalog_revision: Option<String>,
    request_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeState>,
) -> Result<storage_transaction::CommitReceipt, String> {
    if state.closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    let mut receiver = request_id
        .as_ref()
        .map(|id| {
            state
                .requests
                .lock()
                .map_err(|_| "request-lock".to_string())?
                .register(id.clone())
        })
        .transpose()?;
    let store = state.store.clone();
    let worker_app = app.clone();
    let work = state.admit_work()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let mut check = || {
            if worker_app
                .state::<NativeState>()
                .closing
                .load(Ordering::SeqCst)
            {
                return Err("application-closing".to_string());
            }
            if receiver.as_mut().is_some_and(|r| {
                !matches!(
                    r.try_recv(),
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty)
                )
            }) {
                return Err("canceled".to_string());
            }
            Ok(())
        };
        check()?;
        let current = store.read().map_err(|_| "storage-lock")?;
        check()?;
        current
            .as_ref()
            .map_err(Clone::clone)?
            .write_record_guarded(
                &name,
                &contents,
                expected_catalog_revision.as_deref(),
                check,
            )
    })
    .await
    .map_err(|_| "storage-worker-failed".to_string());
    if let Some(id) = request_id {
        state
            .requests
            .lock()
            .map_err(|_| "request-lock".to_string())?
            .finish(&id);
    }
    result?
}
