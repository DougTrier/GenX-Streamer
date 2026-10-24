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

mod account_acquisition;
mod local_streams;
mod native_live;
mod ts_align;
mod native_video;
pub mod trier_video;
mod vpn_status;
mod web_page;
mod account_catalog_owner;
mod account_catalog_query;
mod account_guide;
mod account_guide_owner;
mod account_media_store;
mod account_playback_owner;
mod account_playback_proxy;
mod account_preferences;
mod account_vault;
mod account_vault_owner;
mod account_vod;
mod viewing_settings;
mod group_country;
#[cfg(any(target_os = "android", test))]
#[cfg_attr(
    all(test, not(target_os = "android")),
    allow(
        dead_code,
        reason = "Compile Android envelope tests on the Windows test host; production callers are Android-only."
    )
)]
mod android_manifest_protector;
#[cfg(any(target_os = "android", test))]
mod android_task_finish;
mod archive_artwork;
mod archive_bookmarks;
mod archive_catalog;
mod archive_date_assessment;
mod archive_discovery;
mod archive_download_owner;
mod archive_download_store;
mod archive_download_transfer;
mod archive_library_store;
mod archive_playback_owner;
mod archive_playback_proxy;
mod archive_provider_catalog;
mod archive_provider_commons;
mod archive_provider_contract;
mod archive_provider_discovery;
mod archive_provider_loc;
mod archive_provider_nasa;
mod archive_provider_net;
mod archive_provider_probe;
pub mod casting;
mod catalog_endpoint_projection;
mod catalog_group_mutation;
mod catalog_query;
mod channel_logos;
mod close_owner;
mod device_capabilities;
mod diagnostics;
mod discovery_unavailable;
mod local_favorites;
mod discovery_input;
mod donation;
pub mod guide;
mod health_storage;
pub mod lan;
mod native_catalog;
#[cfg(any(target_os = "android", test))]
mod native_debug_stages;
mod native_guide;
mod native_sharing;
mod native_shutdown;
mod native_speech;
mod network;
mod network_media_probe;
pub mod relay;
#[cfg(test)]
mod renderer_loss;
mod renderer_recovery;
mod requests;
mod scan_batch;
mod scan_candidate_manifest;
mod scan_checkpoint;
mod scan_checkpoint_summary;
mod scan_manifest_work;
mod scan_resume_commit_owner;
mod scan_resume_owner;
mod scan_resume_probe;
mod scan_resume_projection;
mod scan_resume_reconcile;
mod scan_resume_registry;
mod scan_resume_release;
mod scan_resume_runtime;
mod scan_resume_take;
mod scan_window;
mod series_identity;
pub mod sharing_policy;
mod source_directory;
mod source_snapshot_activation_owner;
mod startup_milestones;
mod storage;
#[allow(
    dead_code,
    reason = "Experimental chunk recovery format remains unwired until durability and fault verification."
)]
mod storage_backup_chunks;
mod storage_budget;
mod storage_leases;
#[cfg(windows)]
mod storage_recovery;
mod storage_startup;
mod storage_timings;
mod storage_backup_policy;
mod storage_transaction;
mod viewing_wake;
#[cfg(windows)]
mod windows_manifest_protector;
#[cfg(windows)]
mod windows_speech;

use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::Emitter;
use tauri::Manager;

struct NativeState {
    store: Arc<storage_leases::StoreOwner>,
    startup: Arc<storage_startup::Owner>,
    storage_target: Arc<Mutex<Result<storage::StorageTarget, String>>>,
    read_succeeded: Arc<AtomicBool>,
    #[cfg(windows)]
    recovery: Arc<storage_recovery::RecoveryOwner>,
    #[cfg(windows)]
    bookmarks: Arc<Result<storage_recovery::Bookmarks, String>>,
    requests: Mutex<requests::Requests>,
    closing: Arc<AtomicBool>,
    close_owner: close_owner::CloseOwner,
    work: Arc<close_owner::WorkOwner>,
    scan_resume: Arc<scan_resume_registry::Registry<scan_resume_runtime::Episode>>,
}

impl NativeState {
    fn admit_work(&self) -> Result<close_owner::WorkGuard, String> {
        let guard = self.work.acquire();
        if self.closing.load(Ordering::SeqCst) {
            return Err("application-closing".into());
        }
        Ok(guard)
    }
}

#[tauri::command]
async fn cast_discover(
    request_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<casting::CastingManager>>,
) -> Result<Vec<casting::CastDevice>, String> {
    if app.state::<NativeState>().closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    let request = state.begin_discovery(&request_id).map_err(str::to_string)?;
    device_capabilities::require_cast_entry(&app).await?;
    request.check_current().map_err(str::to_string)?;
    #[cfg(target_os = "android")]
    let discovery_lease = {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = NEXT
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |id| id.checked_add(1))
            .map_err(|_| "cast-discovery-owner-exhausted".to_string())?;
        format!("discovery-{id}")
    };
    #[cfg(target_os = "android")]
    app.state::<AndroidViewing>()
        .0
        .run_mobile_plugin_async::<serde_json::Value>(
            "setDiscovery",
            serde_json::json!({"enabled": true,"leaseId": discovery_lease}),
        )
        .await
        .map_err(|_| "cast-discovery-permission-unavailable".to_string())?;
    let result = match request.check_current() {
        Ok(()) => state.discover(&request).await.map_err(str::to_string),
        Err(error) => Err(error.to_string()),
    };
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidViewing>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "setDiscovery",
                serde_json::json!({"enabled": false,"leaseId": discovery_lease}),
            )
            .await
            .map_err(|_| "cast-discovery-cleanup-unconfirmed".to_string())?;
    }
    result
}
#[tauri::command]
fn cast_cancel_discovery(
    request_id: String,
    state: tauri::State<'_, Arc<casting::CastingManager>>,
) -> Result<(), String> {
    state.cancel_discovery(&request_id).map_err(str::to_string)
}
#[tauri::command]
async fn list_iptv_accounts(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<account_vault::Metadata>, String> {
    account_vault_owner::list(request_id, app).await
}
#[tauri::command]
async fn save_iptv_account(
    request: account_vault::Put,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_vault_owner::PutReceipt, String> {
    account_vault_owner::put(request, request_id, app).await
}
#[tauri::command]
async fn remove_iptv_account(
    request: account_vault::Remove,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_vault_owner::RemoveReceipt, String> {
    account_vault_owner::remove(request, request_id, app).await
}
#[tauri::command]
async fn inspect_iptv_account(
    request: account_vault_owner::InspectRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_vault_owner::InspectReceipt, String> {
    account_vault_owner::inspect(request, request_id, app).await
}
#[tauri::command]
async fn start_iptv_vod_playback(
    request: account_vod::PlayRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_playback_owner::Started, String> {
    account_playback_owner::start_vod(request, request_id, app).await
}
#[tauri::command]
async fn refresh_iptv_account(
    request: account_vault_owner::InspectRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_vault_owner::RefreshReceipt, String> {
    account_vault_owner::refresh(request, request_id, app).await
}
#[tauri::command]
async fn refresh_iptv_account_guide(
    request: account_vault_owner::InspectRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_guide::Status, String> {
    account_guide_owner::refresh(request, request_id, app).await
}
#[tauri::command]
async fn read_iptv_account_guide_status(
    request: account_guide_owner::ReadRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Option<account_guide::Status>, String> {
    account_guide_owner::status(request, request_id, app).await
}
#[tauri::command]
async fn read_iptv_account_guide_channels(
    request: account_guide_owner::ReadRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<account_guide::GuideChannel>, String> {
    account_guide_owner::channels(request, request_id, app).await
}
#[tauri::command]
async fn read_iptv_account_guide_listed(
    request: account_guide_owner::ReadRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_guide_owner::Listed, String> {
    account_guide_owner::listed(request, request_id, app).await
}
#[tauri::command]
async fn read_iptv_account_guide_programs(
    request: account_guide_owner::ReadRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_guide_owner::Programs, String> {
    account_guide_owner::programs(request, request_id, app).await
}
#[tauri::command]
async fn list_iptv_account_channels(
    request: account_catalog_owner::ListRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_catalog_owner::Page, String> {
    account_catalog_owner::list(request, request_id, app).await
}
#[tauri::command]
async fn list_iptv_account_countries(
    request: account_catalog_query::CountryRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_catalog_query::Countries, String> {
    account_catalog_query::countries(request, request_id, app).await
}
#[tauri::command]
async fn query_iptv_account_channels(
    request: account_catalog_query::Query,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_catalog_query::Page, String> {
    account_catalog_query::query(request, request_id, app).await
}
#[tauri::command]
async fn write_iptv_account_preferences(
    request: account_preferences::Request,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_preferences::Receipt, String> {
    let work = app.state::<NativeState>().admit_work()?;
    let mut receipt = account_preferences::write(request, request_id, app).await?;
    if let Some(channel) = &receipt.removed_channel_id {
        receipt.cleanup_pending =
            account_playback_owner::stop_channel(&receipt.account_id, channel)
                .await
                .is_err();
    }
    drop(work);
    Ok(receipt)
}
#[tauri::command]
async fn start_iptv_playback(
    request: account_catalog_owner::ResolveRequest,
    alternate: Option<bool>,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_playback_owner::Started, String> {
    account_playback_owner::start(request, alternate.unwrap_or(false), request_id, app).await
}
/// Measurement only: the latest live start's relay times (no addresses).
#[tauri::command]
fn account_playback_start_timing() -> Option<account_playback_proxy::StartTiming> {
    account_playback_proxy::start_timing()
}
#[tauri::command]
async fn stop_iptv_playback(
    session_generation: String,
    app: tauri::AppHandle,
) -> Result<account_playback_owner::Stopped, String> {
    // Exact cleanup remains available while closing and retains its actual
    // producer even if the IPC observer is dropped.
    let work = app.state::<NativeState>().work.acquire();
    archive_playback_owner::spawn_cleanup(work, async move {
        account_playback_owner::stop(session_generation).await
    })
    .await
    .map_err(|_| "account-playback-stop-unconfirmed".to_string())?
}
#[tauri::command]
async fn start_archive_playback(
    request: archive_playback_owner::StartRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_playback_owner::StartResult, String> {
    archive_playback_owner::start(request, request_id, app).await
}
#[tauri::command]
async fn start_archive_download_playback(
    request: archive_playback_owner::DownloadStartRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_playback_owner::StartResult, String> {
    archive_playback_owner::start_download(request, request_id, app).await
}
#[tauri::command]
async fn start_archive_download(
    request: archive_download_owner::Request,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_download_store::Receipt, String> {
    archive_download_owner::start(request, request_id, app).await
}
#[tauri::command]
async fn list_archive_downloads(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_download_store::List, String> {
    archive_download_owner::list(request_id, app).await
}
#[tauri::command]
async fn remove_archive_download(
    request: archive_download_owner::RemoveRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_download_owner::RemoveReceipt, String> {
    archive_download_owner::remove(request, request_id, app).await
}
#[tauri::command]
fn archive_download_status() -> Result<Option<archive_download_owner::Progress>, String> {
    archive_download_owner::status()
}
#[tauri::command]
async fn stop_archive_downloads(
    app: tauri::AppHandle,
) -> Result<archive_download_owner::Stopped, String> {
    let work = app.state::<NativeState>().work.acquire();
    archive_playback_owner::spawn_cleanup(work, archive_download_owner::shutdown())
        .await
        .map_err(|_| "archive-download-cleanup-failed".to_string())?
}
#[tauri::command]
async fn stop_archive_playback(
    request: archive_playback_owner::SessionRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_playback_owner::Stopped, String> {
    archive_playback_owner::stop(request, request_id, app).await
}
#[tauri::command]
async fn renew_archive_playback(
    request: archive_playback_owner::SessionRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_playback_owner::Renewed, String> {
    archive_playback_owner::renew(request, request_id, app).await
}
#[tauri::command]
async fn read_archive_bookmark(
    request: archive_playback_owner::SessionRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_playback_owner::BookmarkRead, String> {
    archive_playback_owner::read_bookmark(request, request_id, app).await
}
#[tauri::command]
async fn save_archive_bookmark(
    request: archive_playback_owner::BookmarkSaveRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_playback_owner::BookmarkSaved, String> {
    archive_playback_owner::save_bookmark(request, request_id, app).await
}
#[tauri::command]
async fn cast_network_scope(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<casting::CastingManager>>,
) -> Result<casting::ReceiverNetworkScope, String> {
    if app.state::<NativeState>().closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    device_capabilities::require_cast_entry(&app).await?;
    state.network_scope().await.map_err(str::to_string)
}
#[tauri::command]
async fn cast_validate_receiver(
    device_id: String,
    expected_network: casting::ReceiverNetworkScope,
    allow_unverified_identity: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<casting::CastingManager>>,
) -> Result<casting::ReceiverValidation, String> {
    if app.state::<NativeState>().closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    device_capabilities::require_cast_entry(&app).await?;
    state
        .validate_receiver(&device_id, expected_network, allow_unverified_identity)
        .await
        .map_err(str::to_string)
}
#[tauri::command]
async fn cast_start(
    device_id: String,
    session_id: String,
    selection: casting::MediaSelection,
    allow_http: bool,
    allow_http_receiver: Option<bool>,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<casting::CastingManager>>,
) -> Result<casting::CastStatus, String> {
    if app.state::<NativeState>().closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    device_capabilities::require_cast_entry(&app).await?;
    state
        .start(
            &device_id,
            &session_id,
            selection,
            allow_http,
            allow_http_receiver.unwrap_or(false),
        )
        .await
        .map_err(str::to_string)
}

#[tauri::command]
async fn cast_register_receiver(
    address: String,
    name: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<casting::CastingManager>>,
) -> Result<casting::CastDevice, String> {
    if app.state::<NativeState>().closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    device_capabilities::require_cast_entry(&app).await?;
    state
        .register_receiver(&address, &name)
        .await
        .map_err(str::to_string)
}

#[tauri::command]
async fn cast_discovery_warnings(
    state: tauri::State<'_, Arc<casting::CastingManager>>,
) -> Result<Vec<String>, String> {
    Ok(state.discovery_warnings().await)
}
#[tauri::command]
async fn cast_status(
    session_id: String,
    state: tauri::State<'_, Arc<casting::CastingManager>>,
) -> Result<casting::CastStatus, String> {
    state.status(&session_id).await.map_err(str::to_string)
}
#[tauri::command]
async fn cast_stop(
    session_id: String,
    state: tauri::State<'_, Arc<casting::CastingManager>>,
) -> Result<bool, String> {
    state.stop(&session_id).await.map_err(str::to_string)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    platform: &'static str,
    data_mode: String,
}

#[tauri::command]
fn runtime_info(state: tauri::State<NativeState>) -> Result<RuntimeInfo, String> {
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
fn get_storage_timings() -> storage_timings::Snapshot {
    storage_timings::snapshot()
}

#[tauri::command]
fn get_native_startup_milestones() -> startup_milestones::Snapshot {
    startup_milestones::snapshot()
}

#[tauri::command]
fn get_native_root_selection_milestones() -> startup_milestones::RootSnapshot {
    startup_milestones::root_snapshot()
}

#[tauri::command]
async fn read_record(
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
async fn write_record(
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
async fn read_record_pair(
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
async fn read_scan_health(
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
async fn read_guide_capture(
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
struct StorageRecoveryStatus {
    platform: &'static str,
    available: bool,
    state: &'static str,
    error_category: Option<&'static str>,
    explicit_environment: bool,
}

#[tauri::command]
async fn storage_recovery_status(
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
struct StorageChoice {
    data_mode: &'static str,
    restart_persistent: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageRetry {
    data_mode: String,
    retry_ready: bool,
}

#[tauri::command]
async fn retry_storage(app: tauri::AppHandle) -> Result<StorageRetry, String> {
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
async fn choose_storage_directory(
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
async fn write_record_pair(
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
async fn read_scan_checkpoint(app: tauri::AppHandle) -> Result<scan_checkpoint::Snapshot, String> {
    let state = app.state::<NativeState>();
    let work = state.admit_work()?;
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let store = store.read().map_err(|_| "storage-lock")?;
        store.as_ref().map_err(Clone::clone)?.read_scan_checkpoint()
    })
    .await
    .map_err(|_| "storage-worker-failed".to_string())?
}

#[tauri::command]
fn scan_checkpoint_capabilities() -> serde_json::Value {
    serde_json::json!({ "schemaVersion": 1, "advance": 1, "packedReference": 3 })
}
#[tauri::command]
fn scan_batch_capabilities() -> serde_json::Value {
    serde_json::json!({"schemaVersion":1,"scanBatch":1})
}
#[tauri::command]
fn scan_window_capabilities() -> serde_json::Value {
    serde_json::json!({"schemaVersion":1,"scanWindow":1,"maxChunks":4})
}
async fn scan_storage_work<T: Send + 'static>(
    request_id: String,
    app: tauri::AppHandle,
    operation: impl FnOnce(&storage::Store, &mut dyn FnMut() -> Result<(), String>) -> Result<T, String>
        + Send
        + 'static,
) -> Result<T, String> {
    let state = app.state::<NativeState>();
    let work = state.admit_work()?;
    let mut receiver = state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .register(request_id.clone())?;
    let store = state.store.clone();
    let closing = state.closing.clone();
    let ready = state.read_succeeded.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let mut check = || {
            if closing.load(Ordering::SeqCst) {
                return Err("application-closing".into());
            }
            if !matches!(
                receiver.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ) {
                return Err("canceled".into());
            }
            Ok(())
        };
        check()?;
        let lease = store.read()?;
        check()?;
        if !ready.load(Ordering::SeqCst) {
            return Err("storage-not-ready".into());
        }
        operation(lease.as_ref().map_err(Clone::clone)?, &mut check)
    })
    .await
    .map_err(|_| "storage-worker-failed".to_string());
    state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .finish(&request_id);
    result?
}
#[tauri::command]
async fn mutate_catalog_group(
    request: catalog_group_mutation::Request,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::CatalogGroupReceipt, String> {
    if request.request_id != request_id {
        return Err("catalog-group-invalid-request".into());
    }
    scan_storage_work(request_id, app, move |store, check| {
        store.mutate_catalog_group(&request, check)
    })
    .await
}
#[tauri::command]
fn scan_candidate_manifest_capabilities() -> serde_json::Value {
    serde_json::json!({"schemaVersion": 1, "candidateManifest": if cfg!(any(windows, target_os = "android")) { 1 } else { 0 }})
}
pub(crate) async fn protect_scan_manifest_page(
    app: tauri::AppHandle,
    binding: String,
    input: Vec<u8>,
    opening: bool,
) -> Result<Vec<u8>, String> {
    let input = zeroize::Zeroizing::new(input);
    #[cfg(windows)]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(move || {
            if opening {
                windows_manifest_protector::open(&binding, &input)
            } else {
                windows_manifest_protector::seal(&binding, &input)
            }
        })
        .await
        .map_err(|_| "manifest-protection-platform-failed".to_string())?
    }
    #[cfg(target_os = "android")]
    {
        if opening {
            android_manifest_protector::open(&app, &binding, &input).await
        } else {
            android_manifest_protector::seal(&app, &binding, &input).await
        }
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = (app, binding, input, opening);
        Err("manifest-protection-platform-unavailable".into())
    }
}
#[tauri::command]
async fn begin_scan_candidate_manifest(
    request: scan_candidate_manifest::Begin,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<scan_candidate_manifest::Header, String> {
    scan_storage_work(request_id, app, move |store, check| {
        store.begin_scan_candidate_manifest(&request, check)
    })
    .await
}
#[tauri::command]
async fn append_scan_candidate_manifest_page(
    request: scan_candidate_manifest::Append,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<scan_candidate_manifest::Header, String> {
    let protection_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (prepared, generation) = owner
            .storage(None, move |store, check| {
                store.prepare_scan_candidate_manifest_page(request, check)
            })
            .await?;
        owner.check()?;
        let plaintext = prepared.plaintext.clone();
        let ciphertext =
            protect_scan_manifest_page(protection_app, prepared.binding.clone(), plaintext, false)
                .await?;
        owner.check()?;
        let (receipt, _) = owner
            .storage(Some(generation), move |store, check| {
                store.append_scan_candidate_manifest_page(&prepared, &ciphertext, check)
            })
            .await?;
        Ok(receipt)
    })
    .await
}
#[tauri::command]
async fn seal_scan_candidate_manifest(
    request: scan_candidate_manifest::Seal,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::CommitReceipt, String> {
    let protection_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let ((request, prepared), generation) = owner
            .storage(None, move |store, check| {
                let prepared = store.prepare_scan_candidate_manifest_seal(&request, check)?;
                Ok((request, prepared))
            })
            .await?;
        owner.check()?;
        let ciphertext = protect_scan_manifest_page(
            protection_app,
            prepared.binding.clone(),
            prepared.plaintext.clone(),
            false,
        )
        .await?;
        owner.check()?;
        let (receipt, _) = owner
            .storage(Some(generation), move |store, check| {
                store.seal_protected_scan_candidate_manifest(
                    &request,
                    &prepared,
                    &ciphertext,
                    check,
                )
            })
            .await?;
        Ok(receipt)
    })
    .await
}
#[tauri::command]
async fn find_scan_candidate_manifest(
    request: scan_candidate_manifest::Find,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<scan_candidate_manifest::Found, String> {
    scan_storage_work(request_id, app, move |store, check| {
        store.find_scan_candidate_manifest(&request, check)
    })
    .await
}
#[tauri::command]
fn scan_resume_capabilities(
    window_version: Option<u8>,
    take_timing_version: Option<u8>,
) -> serde_json::Value {
    // Fresh indexing, retained admission, bounded checks and durable publication
    // share one native owner. Capability reports availability, not test acceptance.
    let mut value = serde_json::json!({"schemaVersion":1,"boundedResume":1});
    if window_version == Some(2) {
        value["commitWindow"] = serde_json::json!({"schemaVersion":2,"maxObservations":240,"maxRequestBytes":1048576,"maxActiveProbes":16,"maxHeldRows":256,"maxCacheBytes":20971520,"publicationDelayMs":10000});
    }
    if window_version == Some(2) && take_timing_version == Some(1) {
        value["takeTiming"] = serde_json::json!({"schemaVersion":1,"maxCoolingDelayMs":60000});
    }
    value
}
#[cfg(test)]
mod scan_resume_window_capability_tests {
    #[test]
    fn explicit_window_negotiation_preserves_exact_legacy_reply() {
        let legacy = serde_json::json!({"schemaVersion":1,"boundedResume":1});
        assert_eq!(super::scan_resume_capabilities(None, None), legacy);
        assert_eq!(super::scan_resume_capabilities(Some(1), None), legacy);
        assert_eq!(super::scan_resume_capabilities(None, Some(1)), legacy);
        assert_eq!(
            super::scan_resume_capabilities(Some(2), Some(9))
                .as_object()
                .unwrap()
                .len(),
            3
        );
        let timed = super::scan_resume_capabilities(Some(2), Some(1));
        assert_eq!(timed.as_object().unwrap().len(), 4);
        assert_eq!(
            timed["takeTiming"],
            serde_json::json!({"schemaVersion":1,"maxCoolingDelayMs":60000})
        );
        let window = super::scan_resume_capabilities(Some(2), None);
        assert_eq!(window.as_object().unwrap().len(), 3);
        assert_eq!(
            window["commitWindow"],
            serde_json::json!({"schemaVersion":2,"maxObservations":240,"maxRequestBytes":1048576,"maxActiveProbes":16,"maxHeldRows":256,"maxCacheBytes":20971520,"publicationDelayMs":10000})
        );
    }
}
#[tauri::command]
async fn close_scan_resume_open(
    opening_request_id: String,
    state: tauri::State<'_, NativeState>,
) -> Result<(), String> {
    let registry = state.scan_resume.clone();
    registry.close_open(&opening_request_id).await
}
fn validate_source_snapshot_profile(platform: &str, profile: &str) -> Result<(), String> {
    if platform != std::env::consts::OS
        || ![20_000, 45_000, 60_000].iter().any(|budget| {
            profile == format!("reachability-v3/native-media-resources-v1/max-{budget}/sequential")
        })
    {
        return Err("source-snapshot-runtime-profile-invalid".into());
    }
    Ok(())
}
#[tauri::command]
async fn begin_source_snapshot(
    request: storage_transaction::source_snapshot::Begin,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::source_snapshot::Progress, String> {
    validate_source_snapshot_profile(&request.platform, &request.observer_profile)?;
    scan_storage_work(request_id, app, move |store, check| {
        store.begin_source_snapshot(&request, check)
    })
    .await
}
#[tauri::command]
async fn append_source_snapshot(
    request: storage_transaction::source_snapshot::Append,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::source_snapshot::Progress, String> {
    scan_storage_work(request_id, app, move |store, check| {
        store.append_source_snapshot(&request, check)
    })
    .await
}
#[tauri::command]
async fn promote_source_snapshot(
    request: storage_transaction::source_snapshot::Promote,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::source_snapshot::Receipt, String> {
    scan_storage_work(request_id, app, move |store, check| {
        store.promote_source_snapshot(&request, check)
    })
    .await
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceSnapshotStatusRequest {
    schema_version: u8,
    source_id: String,
}
#[tauri::command]
async fn source_snapshot_status(
    request: SourceSnapshotStatusRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::source_snapshot::Status, String> {
    if request.schema_version != 1
        || request.source_id.is_empty()
        || request.source_id.len() > 256
        || request.source_id.chars().any(char::is_control)
    {
        return Err("source-snapshot-invalid".into());
    }
    scan_storage_work(request_id, app, move |store, check| {
        store.source_snapshot_status(&request.source_id, check)
    })
    .await
}
#[tauri::command]
async fn list_source_snapshot_checks(
    mut request: storage_transaction::source_snapshot::Next,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::source_snapshot::CheckPage, String> {
    validate_source_snapshot_profile(&request.platform, &request.observer_profile)?;
    // Refresh authority uses native time and fixed health policy, never caller TTLs.
    request.now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "source-snapshot-clock-invalid")?
        .as_millis()
        .try_into()
        .map_err(|_| "source-snapshot-clock-invalid")?;
    request.positive_ttl_ms = storage_transaction::source_snapshot_activation::POSITIVE_TTL;
    // Refresh re-checks failures by kind (source_snapshot_activation.rs).
    request.retry_after_ms = storage_transaction::source_snapshot_activation::NO_ANSWER_TTL;
    request.definite_failure_ttl_ms =
        storage_transaction::source_snapshot_activation::DEFINITE_FAILURE_TTL;
    scan_storage_work(request_id, app, move |store, check| {
        store.next_source_snapshot_checks(&request, check)
    })
    .await
}
fn native_now_ms(code: &str) -> Result<i64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| code.to_string())?
        .as_millis()
        .try_into()
        .map_err(|_| code.to_string())
}
/// Saved-channel checks (`channel_check`): newest result per saved channel.
#[tauri::command]
async fn read_channel_checks(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::channel_check::Checks, String> {
    let now = native_now_ms("channel-check-clock-invalid")?;
    scan_storage_work(request_id, app, move |store, check| store.channel_checks(now, check)).await
}
/// Records a batch of quiet channel checks (or a channel that just played),
/// timed by the native clock so a wrong page clock cannot mark channels.
#[tauri::command]
async fn record_channel_checks(
    request: storage_transaction::channel_check::Record,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::channel_check::Recorded, String> {
    storage_transaction::channel_check::validate(&request)?;
    let now = native_now_ms("channel-check-clock-invalid")?;
    scan_storage_work(request_id, app, move |store, check| {
        store.record_channel_checks(&request, now, check)
    })
    .await
}
/// A saved channel took `start_ms` from selection to playing (owner design,
/// October 21, 2026): under 3 s clears its Slow badge, over 5 s sets it.
/// Replies whether it now carries the badge (null when it is not saved).
#[tauri::command]
async fn record_channel_start(
    channel_id: String,
    start_ms: i64,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let now = native_now_ms("channel-check-clock-invalid")?;
    scan_storage_work(request_id, app, move |store, check| {
        store
            .record_channel_start(&channel_id, start_ms, now, check)
            .map(|slow| serde_json::json!({"schemaVersion": 1, "slow": slow}))
    })
    .await
}
/// Counts a finished scan's checks of saved channels like quiet checks (owner
/// decision, October 21, 2026), for checks made since `since_ms` (native clock).
/// After a Slow pass, the channels it found answering are marked Slow.
#[tauri::command]
async fn record_scan_channel_checks(
    since_ms: i64,
    slow_pass: Option<bool>,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::channel_check::Recorded, String> {
    let now = native_now_ms("channel-check-clock-invalid")?;
    // A scan lasts hours at most; older checks belong to earlier scans.
    if !(0..=now).contains(&since_ms) || now - since_ms > 2 * 86_400_000 {
        return Err("channel-check-invalid".into());
    }
    scan_storage_work(request_id, app, move |store, check| {
        store.record_scan_channel_checks(since_ms, now, slow_pass.unwrap_or(false), check)
    })
    .await
}
#[tauri::command]
async fn activate_source_snapshot_checks(
    request: storage_transaction::source_snapshot_activation::Request,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::source_snapshot_activation::Reply, String> {
    source_snapshot_activation_owner::activate(request, request_id, app).await
}
#[tauri::command]
async fn open_scan_resume_plan(
    request: scan_resume_runtime::Open,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    if request.schema_version != 1 {
        return Err("scan-resume-request-invalid".into());
    }
    let registry = app.state::<NativeState>().scan_resume.clone();
    let opening = registry.begin(&request_id)?;
    let protection_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (prepared, generation) = owner
            .storage_with_generation(None, move |store, generation, check| {
                store.prepare_scan_resume_admission_runtime(
                    &request.expected_catalog_revision,
                    &request.expected_checkpoint_revision,
                    generation,
                    std::env::consts::OS,
                    check,
                )
            })
            .await?;
        owner.check()?;
        // Retain ciphertext in its proof for exact post-crypto SQL comparison.
        let mut plaintext = zeroize::Zeroizing::new(
            protect_scan_manifest_page(
                protection_app,
                prepared.encrypted_capsule.binding.clone(),
                prepared.encrypted_capsule.ciphertext.clone(),
                true,
            )
            .await?,
        );
        owner.check()?;
        let (admitted, _) = owner
            .storage(Some(generation), move |store, check| {
                store.finish_scan_resume_admission(prepared, std::mem::take(&mut *plaintext), check)
            })
            .await?;
        owner.check()?;
        let plan_id = scan_resume_runtime::plan_id()?;
        let reply = admitted.plan.public_header(&plan_id)?;
        let episode = scan_resume_runtime::Episode::admitted(admitted.plan, admitted.directory)?;
        opening.install(&plan_id, episode)?;
        Ok(reply)
    })
    .await
}
#[tauri::command]
async fn close_scan_resume_plan(
    request: scan_resume_runtime::Close,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if request.schema_version != 1 {
        return Err("scan-resume-request-invalid".into());
    }
    let registry = app.state::<NativeState>().scan_resume.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        owner.check()?;
        registry.close(&request.plan_id).await
    })
    .await
}
#[tauri::command]
async fn take_scan_resume_candidates(
    request: scan_resume_take::Take,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<scan_resume_take::Reply, String> {
    let registry = app.state::<NativeState>().scan_resume.clone();
    let protection_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        scan_resume_take::take(request, registry, owner, protection_app).await
    })
    .await
}
#[tauri::command]
async fn probe_scan_resume_candidate(
    request: scan_resume_probe::Probe,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let registry = app.state::<NativeState>().scan_resume.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        scan_resume_probe::probe(request, registry, owner).await
    })
    .await
}
#[tauri::command]
async fn commit_scan_resume_candidates(
    request: scan_resume_commit_owner::Commit,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let registry = app.state::<NativeState>().scan_resume.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        scan_resume_commit_owner::commit(owner, registry, request).await
    })
    .await
}
#[tauri::command]
async fn read_scan_resume_publication_projection(
    request: scan_resume_projection::Read,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<scan_resume_projection::Page, String> {
    let registry = app.state::<NativeState>().scan_resume.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        owner.check()?;
        scan_resume_projection::read(registry, request)
    })
    .await
}
#[tauri::command]
async fn release_scan_resume_candidates(
    request: scan_resume_release::Release,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let registry = app.state::<NativeState>().scan_resume.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        owner.check()?;
        scan_resume_release::release(registry, request, false)
    })
    .await
}
#[tauri::command]
async fn defer_scan_resume_candidates(
    request: scan_resume_release::Release,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let registry = app.state::<NativeState>().scan_resume.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        owner.check()?;
        scan_resume_release::release(registry, request, true)
    })
    .await
}
#[tauri::command]
async fn read_scan_candidate_manifest_page(
    request: scan_candidate_manifest::Read,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<scan_candidate_manifest::Page, String> {
    let protection_app = app.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (mut prepared, generation) = owner
            .storage(None, move |store, check| {
                let page = store.read_scan_candidate_manifest_page(&request, check)?;
                Ok((request, page))
            })
            .await?;
        owner.check()?;
        let ciphertext = std::mem::take(&mut prepared.1.ciphertext);
        let mut plaintext = zeroize::Zeroizing::new(
            protect_scan_manifest_page(
                protection_app,
                prepared.1.binding.clone(),
                ciphertext,
                true,
            )
            .await?,
        );
        owner.check()?;
        let (page, _) = owner
            .storage(Some(generation), move |store, check| {
                store.finish_scan_candidate_manifest_page(
                    &prepared.0,
                    prepared.1,
                    std::mem::take(&mut *plaintext),
                    check,
                )
            })
            .await?;
        Ok(page)
    })
    .await
}

#[tauri::command]
async fn read_scan_commit_revisions(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<scan_batch::Revisions, String> {
    scan_storage_work(request_id, app, |store, check| {
        check()?;
        let result = store.read_scan_commit_revisions()?;
        check()?;
        Ok(result)
    })
    .await
}
#[tauri::command]
async fn read_scan_checkpoint_summary(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<scan_checkpoint_summary::Summary, String> {
    scan_storage_work(request_id, app, |store, check| {
        store.read_scan_checkpoint_summary(check)
    })
    .await
}
#[tauri::command]
async fn commit_scan_batch(
    batch: scan_batch::Batch,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::CommitReceipt, String> {
    scan_storage_work(request_id, app, move |store, check| {
        store.commit_scan_batch(&batch, check)
    })
    .await
}
#[tauri::command]
async fn commit_scan_window(
    window: scan_window::Window,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::CommitReceipt, String> {
    scan_storage_work(request_id, app, move |store, check| {
        store.commit_scan_window(&window, check)
    })
    .await
}
async fn mutate_scan_checkpoint(
    mutation: scan_checkpoint::Mutation,
    expected_catalog_revision: String,
    expected_checkpoint_revision: String,
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
                return Err("application-closing".into());
            }
            if receiver.as_mut().is_some_and(|r| {
                !matches!(
                    r.try_recv(),
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty)
                )
            }) {
                return Err("canceled".into());
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
                &storage_transaction::RecordPair::default(),
                None,
                (Some(&expected_catalog_revision), None),
                Some((&mutation, &expected_checkpoint_revision)),
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
            .finish(&id)
    }
    result?
}
#[tauri::command]
async fn write_scan_checkpoint(
    checkpoint: String,
    expected_catalog_revision: String,
    expected_checkpoint_revision: String,
    request_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<storage_transaction::CommitReceipt, String> {
    mutate_scan_checkpoint(
        scan_checkpoint::Mutation::Save { checkpoint },
        expected_catalog_revision,
        expected_checkpoint_revision,
        request_id,
        app,
    )
    .await
}
#[tauri::command]
async fn discard_scan_checkpoint(
    job_id: String,
    expected_catalog_revision: String,
    expected_checkpoint_revision: String,
    request_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<storage_transaction::CommitReceipt, String> {
    mutate_scan_checkpoint(
        scan_checkpoint::Mutation::Discard { job_id },
        expected_catalog_revision,
        expected_checkpoint_revision,
        request_id,
        app,
    )
    .await
}

#[tauri::command]
async fn advance_scan_checkpoint(
    mutation: scan_checkpoint::Mutation,
    expected_catalog_revision: String,
    expected_checkpoint_revision: String,
    request_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<storage_transaction::CommitReceipt, String> {
    if !matches!(&mutation, scan_checkpoint::Mutation::Advance { .. }) {
        return Err("scan-checkpoint-invalid".into());
    }
    mutate_scan_checkpoint(
        mutation,
        expected_catalog_revision,
        expected_checkpoint_revision,
        request_id,
        app,
    )
    .await
}

#[tauri::command]
async fn write_health(
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
async fn write_record_receipt(
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

#[tauri::command]
async fn fetch_playlist(
    url: String,
    allow_http: bool,
    request_id: String,
    state: tauri::State<'_, NativeState>,
) -> Result<String, String> {
    if state.closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    let receiver = state
        .requests
        .lock()
        .map_err(|_| "request-lock".to_string())?
        .register(request_id.clone())?;
    let result = tokio::select! {
        response = network::fetch(&url, allow_http) => response,
        _ = receiver => Err("canceled".into()),
    };
    state
        .requests
        .lock()
        .map_err(|_| "request-lock".to_string())?
        .finish(&request_id);
    result
}

#[tauri::command]
fn cancel_playlist(
    request_id: String,
    app: tauri::AppHandle,
    state: tauri::State<NativeState>,
) -> Result<(), String> {
    state
        .requests
        .lock()
        .map_err(|_| "request-lock".to_string())?
        .cancel(request_id.clone())?;
    let resume = state.scan_resume.cancel_open(&request_id);
    let guide = app
        .state::<Arc<native_guide::NativeGuides>>()
        .cancel_request(&request_id);
    resume.and(guide)
}

#[tauri::command]
async fn inspect_source(
    url: String,
    allow_http: bool,
    request_id: String,
    state: tauri::State<'_, NativeState>,
) -> Result<network::SourceInspection, String> {
    if state.closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    let receiver = state
        .requests
        .lock()
        .map_err(|_| "request-lock".to_string())?
        .register(request_id.clone())?;
    let result = tokio::select! {
        response = network::inspect_playback(&url, allow_http) => response,
        _ = receiver => Err("canceled".into()),
    };
    state
        .requests
        .lock()
        .map_err(|_| "request-lock".to_string())?
        .finish(&request_id);
    result
}

#[tauri::command]
async fn inspect_discovery_page(
    url: String,
    allow_http: bool,
    request_id: String,
    state: tauri::State<'_, NativeState>,
) -> Result<discovery_input::DiscoveryPage, String> {
    if state.closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    let receiver = state
        .requests
        .lock()
        .map_err(|_| "request-lock".to_string())?
        .register(request_id.clone())?;
    let result = tokio::select! {
        response = discovery_input::fetch(&url, allow_http) => response,
        _ = receiver => Err("canceled".into()),
    };
    state
        .requests
        .lock()
        .map_err(|_| "request-lock".to_string())?
        .finish(&request_id);
    result
}

/// Explicit GenXtra series suggestion lookup; cancellable through the request registry.
#[tauri::command]
async fn series_identity_lookup(
    query: String,
    request_id: String,
    state: tauri::State<'_, NativeState>,
) -> Result<series_identity::SeriesIdentity, String> {
    let work = state.admit_work()?;
    let receiver = state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .register(request_id.clone())?;
    let canceled = std::sync::atomic::AtomicBool::new(false);
    let result = tokio::select! {
        identity = series_identity::lookup(&query, &canceled) => identity,
        _ = receiver => Err("series-canceled".into()),
    };
    state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .finish(&request_id);
    drop(work);
    result
}
#[tauri::command]
async fn inspect_source_directory(
    url: String,
    request_id: String,
    state: tauri::State<'_, NativeState>,
) -> Result<source_directory::DirectoryResponse, String> {
    let work = state.admit_work()?;
    let receiver = state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .register(request_id.clone())?;
    let canceled = std::sync::atomic::AtomicBool::new(false);
    let result = tokio::select! {
        response = source_directory::fetch_directory(&url, &canceled) => response
            .map_err(|error| serde_json::to_string(&error).unwrap_or_else(|_| "directory-unavailable".into())),
        _ = receiver => Err("directory-canceled".into()),
    };
    state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .finish(&request_id);
    drop(work);
    result
}

#[tauri::command]
async fn inspect_health_source(
    url: String,
    allow_http: bool,
    request_id: String,
    budget_ms: u64,
    state: tauri::State<'_, NativeState>,
) -> Result<network::HealthInspection, String> {
    if state.closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    let receiver = state
        .requests
        .lock()
        .map_err(|_| "request-lock".to_string())?
        .register(request_id.clone())?;
    let result = tokio::select! {
        response = network::health_inspect(&url, allow_http, budget_ms) => response,
        _ = receiver => Err("canceled".into()),
    };
    state
        .requests
        .lock()
        .map_err(|_| "request-lock".to_string())?
        .finish(&request_id);
    result
}

#[tauri::command]
async fn inspect_media_resources(
    url: String,
    allow_http: bool,
    request_id: String,
    budget_ms: u64,
    state: tauri::State<'_, NativeState>,
) -> Result<network_media_probe::Inspection, String> {
    let _work = state.admit_work()?;
    let receiver = state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .register(request_id.clone())?;
    let result = tokio::select! {r=network_media_probe::inspect(&url,allow_http,request_id.clone(),budget_ms)=>r,_=receiver=>Err("canceled".into())};
    state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .finish(&request_id);
    result
}

#[tauri::command]
async fn fetch_media(
    url: String,
    allow_http: bool,
    request_id: String,
    range: Option<String>,
    state: tauri::State<'_, NativeState>,
) -> Result<network::MediaPayload, String> {
    if state.closing.load(Ordering::SeqCst) {
        return Err("application-closing".into());
    }
    let receiver = state
        .requests
        .lock()
        .map_err(|_| "request-lock".to_string())?
        .register(request_id.clone())?;
    let result = tokio::select! {
        response = network::media(&url, allow_http, range) => response,
        _ = receiver => Err("canceled".into()),
    };
    state
        .requests
        .lock()
        .map_err(|_| "request-lock".to_string())?
        .finish(&request_id);
    result
}

/// `fetch_media` as raw bytes (`network::frame_media`): the page reads the
/// segment without parsing a number per byte.
#[tauri::command]
async fn fetch_media_bytes(
    url: String,
    allow_http: bool,
    request_id: String,
    range: Option<String>,
    state: tauri::State<'_, NativeState>,
) -> Result<tauri::ipc::Response, String> {
    let payload = fetch_media(url, allow_http, request_id, range, state).await?;
    Ok(tauri::ipc::Response::new(network::frame_media(&payload)?))
}

#[tauri::command]
async fn acknowledge_back(app: tauri::AppHandle, request_id: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidViewing>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "acknowledgeBack",
                serde_json::json!({"requestId":request_id}),
            )
            .await
            .map(|_| ())
            .map_err(|_| "back-delivery-unavailable".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, request_id);
        Ok(())
    }
}

#[tauri::command]
async fn set_fullscreen(window: tauri::Window, enabled: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        window
            .set_fullscreen(enabled)
            .map_err(|_| "fullscreen-unavailable".to_string())
    }
    #[cfg(target_os = "android")]
    {
        window
            .state::<AndroidViewing>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "setFullscreen",
                serde_json::json!({"enabled": enabled}),
            )
            .await
            .map(|_| ())
            .map_err(|_| "fullscreen-unavailable".to_string())
    }
}

#[cfg(target_os = "android")]
struct AndroidViewing(tauri::plugin::PluginHandle<tauri::Wry>);

/// Refreshes the verified database backup in the background when it is due
/// (see storage_backup_policy): never while watching, never ahead of a save,
/// and never delaying exit.
/// Partial GenXtra download files left by a process that ended mid-transfer
/// (a crash, Android reclaiming GenX) go once the store is open.
fn spawn_download_sweep(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new()
        .name("genx-download-sweep".into())
        .spawn(move || {
            for _ in 0..120 {
                let state = app.state::<NativeState>();
                if state.closing.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(_work) = state.admit_work() else {
                    return;
                };
                if let Ok(lease) = state.store.read() {
                    if let Ok(store) = &*lease {
                        if let Ok(directory) = store.archive_download_directory() {
                            archive_download_transfer::sweep_abandoned_at_start(&directory);
                        }
                        return;
                    }
                }
                drop(_work);
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        });
}
fn spawn_backup_owner(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new()
        .name("genx-backup-owner".into())
        .spawn(move || loop {
            for _ in 0..300 {
                std::thread::sleep(std::time::Duration::from_secs(1));
                if app.state::<NativeState>().closing.load(Ordering::SeqCst) {
                    return;
                }
            }
            let state = app.state::<NativeState>();
            let Ok(_work) = state.admit_work() else {
                return;
            };
            let Ok(lease) = state.store.read() else {
                continue;
            };
            let Ok(store) = &*lease else {
                continue;
            };
            if !storage_backup_policy::due(&store.backup_path()) {
                continue;
            }
            let closing = state.closing.clone();
            let abort: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
                closing.load(Ordering::SeqCst)
                    || storage_backup_policy::writer_waiting()
                    || storage_backup_policy::viewing()
            });
            let _ = store.background_backup(abort);
        });
}
#[tauri::command]
async fn set_viewing_active(
    app: tauri::AppHandle,
    active: bool,
) -> Result<viewing_wake::WakeReceipt, String> {
    storage_backup_policy::set_viewing(active);
    let state = app.state::<NativeState>();
    let work = if active {
        state.admit_work()?
    } else {
        state.work.acquire()
    };
    let closing = state.closing.clone();
    #[cfg(target_os = "android")]
    native_debug_stages::record(native_debug_stages::Stage::WakeAdmitted);
    viewing_wake::spawn_owned(work, closing, active, async move {
        #[cfg(target_os = "android")]
        {
            use native_debug_stages::{record, Stage};
            record(Stage::WakePluginDispatchEnter);
            let response = app
                .state::<AndroidViewing>()
                .0
                .run_mobile_plugin_async::<viewing_wake::WakeReceipt>(
                    "setViewingActive",
                    serde_json::json!({"enabled":active}),
                )
                .await;
            record(Stage::WakePluginResult);
            let result = response
                .map_err(|_| "viewing-wake-policy-unavailable".to_string())
                .and_then(|receipt| receipt.validate_android(active));
            if result.is_ok() {
                record(Stage::WakeValidated);
            }
            record(Stage::WakeReturn);
            result
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = app;
            Ok(viewing_wake::WakeReceipt::unsupported(active))
        }
    })
    .await
    .map_err(|_| "viewing-wake-worker-unconfirmed".to_string())?
}

#[tauri::command]
async fn get_viewing_wake_diagnostics(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<NativeState>();
    let work = state.admit_work()?;
    let closing = state.closing.clone();
    viewing_wake::spawn_owned(work, closing, false, async move {
        #[cfg(target_os = "android")]
        {
            app.state::<AndroidViewing>()
                .0
                .run_mobile_plugin_async::<serde_json::Value>(
                    "getViewingWakeDiagnostics",
                    serde_json::json!({}),
                )
                .await
                .map_err(|_| "viewing-wake-diagnostics-unavailable".to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = app;
            Ok(
                serde_json::json!({"schemaVersion":1,"adapterVersion":"viewing-wake-v1",
            "platform":if cfg!(windows){"windows"}else{"unsupported"},"requestedActive":null,
            "foreground":null,"windowKeepScreenOn":null,"webViewKeepScreenOn":null,
            "decorKeepScreenOn":null,"nodes":[],"truncated":false}),
            )
        }
    })
    .await
    .map_err(|_| "viewing-wake-worker-unconfirmed".to_string())?
}

#[tauri::command]
fn force_exit(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<NativeState>() {
        state.closing.store(true, Ordering::SeqCst);
        #[cfg(windows)]
        state.recovery.cancel();
    }
    app.exit(0);
}

async fn shutdown_owned(app: &tauri::AppHandle) -> Result<(), &'static str> {
    #[cfg(target_os = "android")]
    renderer_recovery::join_registration(app).await;
    app.state::<NativeState>().startup.join().await;
    let cast = app.state::<Arc<casting::CastingManager>>().inner().clone();
    let lan = app.state::<Arc<lan::LanManager>>().inner().clone();
    let guides = app
        .state::<Arc<native_guide::NativeGuides>>()
        .inner()
        .clone();
    native_shutdown::join_owned(
        async {
            #[cfg(windows)]
            {
                let state = app.state::<NativeState>();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                while state.recovery.active() {
                    if std::time::Instant::now() >= deadline {
                        return Err("storage-recovery-stop-unconfirmed");
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            }
            Ok(())
        },
        async {
            native_speech::shutdown(app)
                .await
                .map_err(|_| "speech-stop-unconfirmed")
        },
        cast.shutdown(),
        async {
            let live = app.state::<native_live::NativeLive>();
            let (lan, accounts, archive, downloads, _) = tokio::join!(
                lan.shutdown(),
                account_playback_owner::shutdown(),
                archive_playback_owner::shutdown(),
                archive_download_owner::shutdown(),
                // The Android player's live relay is joined too (LX02, LX05).
                live.shutdown()
            );
            lan?;
            accounts?;
            downloads.map_err(|_| "archive-download-stop-unconfirmed")?;
            archive.map_err(|_| "archive-playback-stop-unconfirmed")
        },
        guides.shutdown(),
        async {
            let state = app.state::<NativeState>();
            let requests = state
                .requests
                .lock()
                .map(|requests| requests.drain_owner())
                .map_err(|_| "request-lock");
            match requests {
                Ok(requests) => {
                    let (resume, _, _) = tokio::join!(
                        state.scan_resume.shutdown(),
                        requests.drained(),
                        state.work.drained()
                    );
                    resume.map_err(|_| "scan-resume-stop-unconfirmed")
                }
                Err(_) => {
                    let _ = tokio::join!(state.scan_resume.shutdown(), state.work.drained());
                    Err("request-lock")
                }
            }
        },
    )
    .await
}

#[tauri::command]
fn acknowledge_cleanup(
    request_id: String,
    generation: u64,
    result: close_owner::CleanupResult,
    state: tauri::State<NativeState>,
) -> Result<(), String> {
    // The exact active ticket is already the authority. Preparation deliberately
    // accepts its ACK before closing revokes final renderer storage work.
    state
        .close_owner
        .acknowledge(
            &close_owner::CloseTicket {
                request_id,
                generation,
            },
            result,
        )
        .map_err(str::to_string)
}
fn emit_close_progress(app: &tauri::AppHandle, ticket: &close_owner::CloseTicket) {
    let state = app.state::<NativeState>();
    if let Some(snapshot) = state.close_owner.snapshot(ticket) {
        let _ = app.emit("native-close-progress", snapshot);
    }
}
async fn complete_close_attempt(
    app: tauri::AppHandle,
    ticket: close_owner::CloseTicket,
    ack: tokio::sync::oneshot::Receiver<close_owner::CleanupResult>,
) {
    use close_owner::{CloseReason, CloseStage};
    let state = app.state::<NativeState>();
    let result: Result<(), (&'static str, CloseReason)> = async {
        // Every close route first freezes/drains the renderer while final
        // session-bound saves still own ordinary native admission. A missing
        // renderer cannot postpone starting native cleanup beyond this budget.
        state.close_owner.phase(&ticket, CloseStage::Frontend);
        let emitted = app.emit("native-close-starting", ticket.clone()).is_ok();
        emit_close_progress(&app, &ticket);
        let frontend = native_shutdown::prepare_frontend(
            ack,
            emitted,
            tokio::time::sleep(std::time::Duration::from_secs(120)),
        )
        .await;
        state.closing.store(true, Ordering::SeqCst);
        #[cfg(windows)]
        state.recovery.cancel();
        let request_stop = state
            .requests
            .lock()
            .map(|mut requests| requests.stop())
            .map_err(|_| ("request-lock", CloseReason::RequestLock));
        let (native, start_native, native_admission) = match state.close_owner.native_drain() {
            Ok((native, start)) => (native, start, Ok(())),
            Err(error) => (
                Arc::new(close_owner::NativeDrain::default()),
                true,
                Err((error, CloseReason::NativeFailed)),
            ),
        };
        if start_native {
            let owned = native.clone();
            let native_app = app.clone();
            tauri::async_runtime::spawn(async move {
                owned.complete(shutdown_owned(&native_app).await);
            });
        }
        let joined = state
            .close_owner
            .join_cleanup(&ticket, frontend.settled(), &native, emitted, || {
                emit_close_progress(&app, &ticket);
            })
            .await;
        // Cleanup-only IPC can admit actual disposal work after the native phase.
        state
            .close_owner
            .phase(&ticket, CloseStage::FinalNativeDrain);
        emit_close_progress(&app, &ticket);
        let requests = state
            .requests
            .lock()
            .map(|requests| requests.drain_owner())
            .map_err(|_| ("request-lock", CloseReason::RequestLock));
        let final_requests = match requests {
            Ok(requests) => {
                tokio::join!(requests.drained(), state.work.drained());
                Ok(())
            }
            Err(error) => {
                state.work.drained().await;
                Err(error)
            }
        };
        // Admission errors cannot abandon either original cleanup join or the
        // final owned-work drain, and never become successful close receipts.
        request_stop?;
        native_admission?;
        joined?;
        final_requests?;
        #[cfg(target_os = "android")]
        {
            state.close_owner.phase(&ticket, CloseStage::ActivityFinish);
            emit_close_progress(&app, &ticket);
            let (finish, start) = state
                .close_owner
                .activity_drain()
                .map_err(|error| (error, CloseReason::ActivityUnconfirmed))?;
            if start {
                android_task_finish::start_owned(
                    finish.clone(),
                    state.work.acquire(),
                    android_task_finish::request(app.clone()),
                    finalize_activity_exit(app.clone(), ticket.clone()),
                );
            }
            finish
                .settled()
                .await
                .map_err(|error| (error, CloseReason::ActivityUnconfirmed))?;
        }
        Ok(())
    }
    .await;
    let (completion, reason) = match result {
        Ok(()) => (Ok(()), None),
        Err((error, reason)) => (Err(error), Some(reason)),
    };
    state.close_owner.settle(&ticket, completion, reason);
    emit_close_progress(&app, &ticket);
    match completion {
        Ok(()) => {
            #[cfg(not(target_os = "android"))]
            app.exit(0);
            #[cfg(target_os = "android")]
            finalize_activity_exit(app, ticket).await;
        }
        Err(reason) => {
            let _ = app.emit("native-close-blocked", reason);
        }
    }
}
async fn coordinated_exit(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<NativeState>();
    let attempt = state.close_owner.begin_retained().map_err(str::to_string)?;
    if let Some(ack) = attempt.acknowledgment {
        // This producer owns the attempt through actual settlement. A caller's timeout
        // observes progress and cannot invalidate its ticket or drop its ACK receiver.
        tauri::async_runtime::spawn(complete_close_attempt(
            app.clone(),
            attempt.ticket.clone(),
            ack,
        ));
    } else {
        // Explicit Retry repeats the exact pending ticket; frontend ownership coalesces it.
        let _ = app.emit("native-close-starting", attempt.ticket.clone());
        emit_close_progress(&app, &attempt.ticket);
    }
    match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        attempt.completion.settled(),
    )
    .await
    {
        Ok(result) => result.map_err(str::to_string),
        Err(_) => {
            if !state.close_owner.observation_deadline(&attempt.ticket) {
                return attempt.completion.settled().await.map_err(str::to_string);
            }
            emit_close_progress(&app, &attempt.ticket);
            // The owned producer may settle while the observation timer wakes. Do not
            // publish a stale blocked notification for a terminal/superseded attempt.
            if !state
                .close_owner
                .snapshot(&attempt.ticket)
                .is_some_and(|snapshot| snapshot.running)
            {
                return attempt.completion.settled().await.map_err(str::to_string);
            }
            let _ = app.emit("native-close-blocked", "cleanup-stop-timeout");
            Err("cleanup-stop-timeout".into())
        }
    }
}
#[cfg(target_os = "android")]
async fn finalize_activity_exit(app: tauri::AppHandle, ticket: close_owner::CloseTicket) {
    let state = app.state::<NativeState>();
    let requests = match state.requests.lock() {
        Ok(requests) => requests.drain_owner(),
        Err(_) => return,
    };
    // Closing forbids fresh work; cleanup-only operations must still actually settle.
    // Only then, and only for this accepted close, does the process end (LX06):
    // without the C exit handlers that app.exit runs, which raced WebView's GPU
    // thread into a 'destroyed mutex' abort on every exit (ViewingPlugin.endProcess).
    // app.exit stays as the fallback if the plugin cannot be reached.
    let viewing = app.clone();
    android_task_finish::end_after_drain(
        &state.closing,
        &state.close_owner,
        &ticket,
        requests,
        &state.work,
        || async move {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                viewing
                    .state::<AndroidViewing>()
                    .0
                    .run_mobile_plugin_async::<serde_json::Value>("endProcess", serde_json::json!({})),
            )
            .await;
            viewing.exit(0);
        },
    )
    .await;
}
#[tauri::command]
async fn request_exit(app: tauri::AppHandle) -> Result<(), String> {
    coordinated_exit(app).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    startup_milestones::start();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("viewing")
                .setup(|_app, _api| {
                    #[cfg(target_os = "android")]
                    _app.manage(AndroidViewing(
                        _api.register_android_plugin("com.tmg.tv", "ViewingPlugin")?,
                    ));
                    Ok(())
                })
                .build(),
        );
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(android_manifest_protector::init())
        .plugin(renderer_recovery::init())
        .plugin(web_page::init())
        .plugin(native_video::init())
        .plugin(vpn_status::init());
    builder
        .setup(|app| {
            use startup_milestones::{observe_root, root_mark, RootEvent};
            startup_milestones::mark(startup_milestones::Event::SetupEntry);
            let _startup_time = storage_timings::measure(storage_timings::Stage::Setup);
            let base = observe_root(
                RootEvent::AppDataDirStarted,
                RootEvent::AppDataDirFinished,
                || app.path().app_data_dir(),
            )?;
            // An explicit isolated profile (TMG_DATA_DIR) also owns these small stores,
            // so test runs never write into the installed app's own folder.
            let side_root = std::env::var_os("TMG_DATA_DIR")
                .map(std::path::PathBuf::from)
                .filter(|path| path.is_absolute())
                .unwrap_or_else(|| base.clone());
            app.manage(Arc::new(diagnostics::Store::new(
                side_root.join("diagnostic-events.json"),
            )));
            app.manage(native_live::NativeLive::default());
            app.manage(Arc::new(discovery_unavailable::Store::new(
                side_root.join("discovery-unavailable-v1.json"),
            )));
            app.manage(Arc::new(local_favorites::Store::new(
                side_root.join("local-favorites-v1.json"),
            )));
            root_mark(RootEvent::DiagnosticsReady);
            #[cfg(windows)]
            let bookmarks = observe_root(
                RootEvent::WindowsBookmarksStarted,
                RootEvent::WindowsBookmarksFinished,
                || {
                    app.path()
                        .app_config_dir()
                        .map_err(|_| "storage-bookmark-unavailable".to_string())
                        .and_then(|config| {
                            std::env::current_exe()
                                .map_err(|_| "storage-bookmark-unavailable".to_string())
                                .and_then(|exe| storage_recovery::Bookmarks::new(config, &exe))
                        })
                },
            );
            // Android's OS-selected sandbox commonly includes /data/user/0 alias.
            // Resolve only this trusted platform default; explicit user paths retain link refusal.
            #[cfg(target_os = "android")]
            let base = observe_root(
                RootEvent::CanonicalizationStarted,
                RootEvent::CanonicalizationFinished,
                || std::fs::canonicalize(base),
            )?;
            #[cfg(windows)]
            let root = observe_root(RootEvent::PolicyStarted, RootEvent::PolicyFinished, || {
                storage::data_root_with_bookmark(base, &bookmarks)
            });
            #[cfg(not(windows))]
            let root = observe_root(RootEvent::PolicyStarted, RootEvent::PolicyFinished, || {
                storage::data_root(base).map_err(|_| "storage-directory-invalid".to_string())
            });
            let target = observe_root(
                RootEvent::TargetInspectionStarted,
                RootEvent::TargetInspectionFinished,
                || {
                    root.map(|(path, mode)| storage::StorageTarget {
                        require_existing: mode == "explicit-directory"
                            && std::env::var_os("TMG_DATA_DIR").is_none()
                            || path.is_dir(),
                        require_database: path.join(storage_transaction::DB).is_file(),
                        path,
                        mode,
                    })
                },
            );
            startup_milestones::mark(startup_milestones::Event::RootSelected);
            let (pending, ticket) = storage_leases::StoreOwner::initializing();
            let store = Arc::new(pending);
            let startup = Arc::new(storage_startup::Owner::default());
            let target = Arc::new(Mutex::new(target));
            let closing = Arc::new(AtomicBool::new(false));
            let work = Arc::new(close_owner::WorkOwner::default());
            app.manage(NativeState {
                store: store.clone(),
                startup: startup.clone(),
                storage_target: target.clone(),
                read_succeeded: Arc::new(AtomicBool::new(false)),
                #[cfg(windows)]
                recovery: Arc::new(storage_recovery::RecoveryOwner::default()),
                #[cfg(windows)]
                bookmarks: Arc::new(bookmarks),
                requests: Mutex::new(requests::Requests::default()),
                closing: closing.clone(),
                close_owner: close_owner::CloseOwner::default(),
                work: work.clone(),
                scan_resume: Arc::new(scan_resume_registry::Registry::default()),
            });
            app.manage(Arc::new(casting::CastingManager::default()));
            app.manage(Arc::new(lan::LanManager::default()));
            app.manage(Arc::new(native_guide::NativeGuides::default()));
            #[cfg(target_os = "android")]
            renderer_recovery::start(app.handle().clone());
            #[cfg(windows)]
            app.manage(Arc::new(windows_speech::WindowsSpeech::default()));
            startup_milestones::mark(startup_milestones::Event::StateManaged);
            let native_app = app.handle().clone();
            startup.start(store, ticket, target, closing, work.acquire(), async move {
                #[cfg(target_os = "android")]
                renderer_recovery::join_registration(&native_app).await;
                #[cfg(not(target_os = "android"))]
                let _ = native_app;
            })?;
            spawn_backup_owner(app.handle().clone());
            spawn_download_sweep(app.handle().clone());
            #[cfg(windows)]
            web_page::forget_sites(app.handle());
            startup_milestones::mark(startup_milestones::Event::SetupFinished);
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(windows)]
            if matches!(event, tauri::WindowEvent::Focused(false)) {
                if let Some(speech) = window.try_state::<Arc<windows_speech::WindowsSpeech>>() {
                    speech.background();
                }
            }
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = coordinated_exit(app).await;
                });
            }

            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<NativeState>() {
                    state.closing.store(true, Ordering::SeqCst);
                    #[cfg(windows)]
                    state.recovery.cancel();
                    if let Ok(mut requests) = state.requests.lock() {
                        requests.stop();
                    }
                }
                if let Some(casting) = window.try_state::<Arc<casting::CastingManager>>() {
                    let owned = casting.inner().clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = owned.shutdown().await;
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            diagnostics::append_diagnostic_event,
            discovery_unavailable::read_discovery_unavailable,
            discovery_unavailable::record_discovery_unavailable,
            diagnostics::read_diagnostic_events,
            diagnostics::clear_diagnostic_events,
            native_guide::guide_sources,
            native_guide::guide_save_source,
            native_guide::guide_remove_source,
            native_guide::guide_preview,
            native_guide::guide_preview_proposed_source,
            native_guide::guide_preview_file,
            native_guide::guide_file_begin,
            native_guide::guide_file_append,
            native_guide::guide_file_finish,
            native_guide::guide_file_discard,
            native_guide::guide_commit,
            native_guide::guide_commit_and_match,
            native_guide::guide_commit_if_matched,
            native_guide::guide_connect_cached_catalog,
            archive_discovery::archive_query_catalog,
            archive_discovery::archive_title_artwork,
            archive_discovery::archive_title_files,
            archive_discovery::archive_discover_step,
            archive_provider_discovery::public_archive_discover_step,
            archive_discovery::archive_discovery_progress,
            archive_discovery::archive_set_favorite,
            archive_discovery::archive_remove_title,
            archive_discovery::archive_remove_file,
            archive_discovery::archive_clear_library,
            archive_discovery::archive_item_files_progress,
            archive_discovery::archive_item_files_step,
            start_archive_playback,
            start_archive_download_playback,
            start_archive_download,
            list_archive_downloads,
            remove_archive_download,
            archive_download_status,
            stop_archive_downloads,
            stop_archive_playback,
            renew_archive_playback,
            read_archive_bookmark,
            save_archive_bookmark,
            native_guide::guide_refresh_plan,
            native_guide::guide_refresh_due,
            native_guide::guide_discard,
            native_guide::guide_channels,
            native_guide::guide_mappings,
            native_guide::guide_save_mapping,
            native_guide::guide_save_mapping_receipt,
            native_guide::guide_preview_mapped,
            native_guide::guide_mapped_schedule_status,
            native_guide::guide_remove_mapping,
            native_guide::guide_programs,
            native_guide::guide_listed_channels,
            donation::open_donation,
            native_guide::guide_selected_summary,
            native_guide::guide_visible_summaries,
            native_guide::guide_coverage,
            native_guide::guide_pack_suggestions,
            native_guide::guide_grabber_channels,
            native_guide::guide_retention_cleanup,
            native_guide::guide_channel_coverage,
            native_guide::guide_suggest_mapping,
            runtime_info,
            get_native_startup_milestones,
            get_native_root_selection_milestones,
            read_record,
            write_record,
            read_record_pair,
            read_scan_health,
            read_guide_capture,
            native_catalog::query_catalog_page,
            channel_logos::channel_logos,
            mutate_catalog_group,
            native_catalog::cancel_catalog_query,
            native_catalog::query_cancellation_snapshot,
            get_storage_timings,
            storage_recovery_status,
            retry_storage,
            choose_storage_directory,
            write_record_pair,
            read_scan_checkpoint,
            read_scan_checkpoint_summary,
            scan_checkpoint_capabilities,
            scan_candidate_manifest_capabilities,
            begin_scan_candidate_manifest,
            append_scan_candidate_manifest_page,
            seal_scan_candidate_manifest,
            scan_resume_capabilities,
            close_scan_resume_open,
            begin_source_snapshot,
            append_source_snapshot,
            promote_source_snapshot,
            source_snapshot_status,
            list_source_snapshot_checks,
            read_channel_checks,
            record_channel_checks,
            record_scan_channel_checks,
            record_channel_start,
            activate_source_snapshot_checks,
            open_scan_resume_plan,
            close_scan_resume_plan,
            take_scan_resume_candidates,
            probe_scan_resume_candidate,
            commit_scan_resume_candidates,
            read_scan_resume_publication_projection,
            release_scan_resume_candidates,
            defer_scan_resume_candidates,
            find_scan_candidate_manifest,
            read_scan_candidate_manifest_page,
            scan_batch_capabilities,
            scan_window_capabilities,
            read_scan_commit_revisions,
            commit_scan_batch,
            commit_scan_window,
            write_scan_checkpoint,
            discard_scan_checkpoint,
            advance_scan_checkpoint,
            write_health,
            write_record_receipt,
            fetch_playlist,
            acknowledge_back,
            acknowledge_cleanup,
            inspect_source,
            inspect_health_source,
            inspect_media_resources,
            inspect_discovery_page,
            inspect_source_directory,
            series_identity_lookup,
            native_speech::speech_capabilities,
            native_speech::speech_request_permission,
            native_speech::speech_start,
            native_speech::speech_end,
            native_speech::speech_cancel,
            fetch_media,
            fetch_media_bytes,
            device_capabilities::device_capabilities,
            cast_discover,
            cast_cancel_discovery,
            list_iptv_accounts,
            save_iptv_account,
            remove_iptv_account,
            inspect_iptv_account,
            account_vod::account_vod_list,
            local_streams::local_streams_scan,
            local_favorites::local_favorites_read,
            local_favorites::local_favorites_save,
            web_page::web_page,
            native_video::native_video,
            native_live::native_live_open,
            native_live::native_live_renew,
            native_live::native_live_close,
            vpn_status::vpn_status,
            account_vod::account_series_info,
            account_vod::account_vod_details,
            viewing_settings::read_viewing_settings,
            viewing_settings::write_viewing_settings,
            start_iptv_vod_playback,
            refresh_iptv_account,
            refresh_iptv_account_guide,
            read_iptv_account_guide_status,
            read_iptv_account_guide_channels,
            read_iptv_account_guide_listed,
            read_iptv_account_guide_programs,
            list_iptv_account_channels,
            query_iptv_account_channels,
            list_iptv_account_countries,
            write_iptv_account_preferences,
            start_iptv_playback,
            stop_iptv_playback,
            account_playback_start_timing,
            cast_network_scope,
            cast_validate_receiver,
            cast_start,
            cast_register_receiver,
            cast_discovery_warnings,
            cast_status,
            cast_stop,
            cancel_playlist,
            set_fullscreen,
            set_viewing_active,
            get_viewing_wake_diagnostics,
            force_exit,
            request_exit,
            renderer_recovery::renderer_recovery_bootstrap,
            native_sharing::start_server,
            native_sharing::stop_server,
            native_sharing::sharing_invite,
            native_sharing::sharing_publish,
            native_sharing::sharing_selection_changed,
            native_sharing::sharing_viewers,
            native_sharing::sharing_revoke,
            native_sharing::next_remote_control,
            native_sharing::remote_control_active,
            native_sharing::remote_control_allows,
            native_sharing::sharing_control_allows,
            native_sharing::acknowledge_remote_control
        ])
        .run(tauri::generate_context!())
        .expect("GenX Streamer could not initialize its native application runtime");
}

mod refresh_cadence;
