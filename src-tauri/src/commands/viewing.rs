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

//! Viewing commands: the Back key, full screen, screen-on while watching, and the background download sweep and backup owner.
use crate::*;

#[tauri::command]
pub(crate) async fn acknowledge_back(
    app: tauri::AppHandle,
    request_id: String,
) -> Result<(), String> {
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
pub(crate) async fn set_fullscreen(window: tauri::Window, enabled: bool) -> Result<(), String> {
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

/// Refreshes the verified database backup in the background when it is due
/// (see storage_backup_policy): never while watching, never ahead of a save,
/// and never delaying exit.
/// Partial GenXtra download files left by a process that ended mid-transfer
/// (a crash, Android reclaiming GenX) go once the store is open.
pub(crate) fn spawn_download_sweep(app: tauri::AppHandle) {
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
pub(crate) fn spawn_backup_owner(app: tauri::AppHandle) {
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
pub(crate) async fn set_viewing_active(
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
pub(crate) async fn get_viewing_wake_diagnostics(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
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
