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

//! Casting commands: finding Chromecast and DLNA receivers, starting, watching and stopping a cast.
use crate::*;

#[tauri::command]
pub(crate) async fn cast_discover(
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
pub(crate) fn cast_cancel_discovery(
    request_id: String,
    state: tauri::State<'_, Arc<casting::CastingManager>>,
) -> Result<(), String> {
    state.cancel_discovery(&request_id).map_err(str::to_string)
}
#[tauri::command]
pub(crate) async fn cast_network_scope(
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
pub(crate) async fn cast_validate_receiver(
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
pub(crate) async fn cast_start(
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
pub(crate) async fn cast_register_receiver(
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
pub(crate) async fn cast_discovery_warnings(
    state: tauri::State<'_, Arc<casting::CastingManager>>,
) -> Result<Vec<String>, String> {
    Ok(state.discovery_warnings().await)
}
#[tauri::command]
pub(crate) async fn cast_status(
    session_id: String,
    state: tauri::State<'_, Arc<casting::CastingManager>>,
) -> Result<casting::CastStatus, String> {
    state.status(&session_id).await.map_err(str::to_string)
}
#[tauri::command]
pub(crate) async fn cast_stop(
    session_id: String,
    state: tauri::State<'_, Arc<casting::CastingManager>>,
) -> Result<bool, String> {
    state.stop(&session_id).await.map_err(str::to_string)
}
