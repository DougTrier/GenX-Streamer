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

//! Channel scan commands: checkpoints, candidate manifests, bounded resume, source snapshots and channel checks.
use crate::*;

#[tauri::command]
pub(crate) async fn read_scan_checkpoint(
    app: tauri::AppHandle,
) -> Result<scan_checkpoint::Snapshot, String> {
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
pub(crate) fn scan_checkpoint_capabilities() -> serde_json::Value {
    serde_json::json!({ "schemaVersion": 1, "advance": 1, "packedReference": 3 })
}
#[tauri::command]
pub(crate) fn scan_batch_capabilities() -> serde_json::Value {
    serde_json::json!({"schemaVersion":1,"scanBatch":1})
}
#[tauri::command]
pub(crate) fn scan_window_capabilities() -> serde_json::Value {
    serde_json::json!({"schemaVersion":1,"scanWindow":1,"maxChunks":4})
}
pub(crate) async fn scan_storage_work<T: Send + 'static>(
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
pub(crate) async fn mutate_catalog_group(
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
pub(crate) fn scan_candidate_manifest_capabilities() -> serde_json::Value {
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
pub(crate) async fn begin_scan_candidate_manifest(
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
pub(crate) async fn append_scan_candidate_manifest_page(
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
pub(crate) async fn seal_scan_candidate_manifest(
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
pub(crate) async fn find_scan_candidate_manifest(
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
pub(crate) fn scan_resume_capabilities(
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
pub(crate) async fn close_scan_resume_open(
    opening_request_id: String,
    state: tauri::State<'_, NativeState>,
) -> Result<(), String> {
    let registry = state.scan_resume.clone();
    registry.close_open(&opening_request_id).await
}
pub(crate) fn validate_source_snapshot_profile(
    platform: &str,
    profile: &str,
) -> Result<(), String> {
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
pub(crate) async fn begin_source_snapshot(
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
pub(crate) async fn append_source_snapshot(
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
pub(crate) async fn promote_source_snapshot(
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
pub(crate) struct SourceSnapshotStatusRequest {
    schema_version: u8,
    source_id: String,
}
#[tauri::command]
pub(crate) async fn source_snapshot_status(
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
pub(crate) async fn list_source_snapshot_checks(
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
pub(crate) fn native_now_ms(code: &str) -> Result<i64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| code.to_string())?
        .as_millis()
        .try_into()
        .map_err(|_| code.to_string())
}
/// Saved-channel checks (`channel_check`): newest result per saved channel.
#[tauri::command]
pub(crate) async fn read_channel_checks(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::channel_check::Checks, String> {
    let now = native_now_ms("channel-check-clock-invalid")?;
    scan_storage_work(request_id, app, move |store, check| {
        store.channel_checks(now, check)
    })
    .await
}
/// Records a batch of quiet channel checks (or a channel that just played),
/// timed by the native clock so a wrong page clock cannot mark channels.
#[tauri::command]
pub(crate) async fn record_channel_checks(
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
pub(crate) async fn record_channel_start(
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
pub(crate) async fn record_scan_channel_checks(
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
pub(crate) async fn activate_source_snapshot_checks(
    request: storage_transaction::source_snapshot_activation::Request,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::source_snapshot_activation::Reply, String> {
    source_snapshot_activation_owner::activate(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn open_scan_resume_plan(
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
pub(crate) async fn close_scan_resume_plan(
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
pub(crate) async fn take_scan_resume_candidates(
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
pub(crate) async fn probe_scan_resume_candidate(
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
pub(crate) async fn commit_scan_resume_candidates(
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
pub(crate) async fn read_scan_resume_publication_projection(
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
pub(crate) async fn release_scan_resume_candidates(
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
pub(crate) async fn defer_scan_resume_candidates(
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
pub(crate) async fn read_scan_candidate_manifest_page(
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
pub(crate) async fn read_scan_commit_revisions(
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
pub(crate) async fn read_scan_checkpoint_summary(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<scan_checkpoint_summary::Summary, String> {
    scan_storage_work(request_id, app, |store, check| {
        store.read_scan_checkpoint_summary(check)
    })
    .await
}
#[tauri::command]
pub(crate) async fn commit_scan_batch(
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
pub(crate) async fn commit_scan_window(
    window: scan_window::Window,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<storage_transaction::CommitReceipt, String> {
    scan_storage_work(request_id, app, move |store, check| {
        store.commit_scan_window(&window, check)
    })
    .await
}
pub(crate) async fn mutate_scan_checkpoint(
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
pub(crate) async fn write_scan_checkpoint(
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
pub(crate) async fn discard_scan_checkpoint(
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
pub(crate) async fn advance_scan_checkpoint(
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
