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

#[cfg(not(windows))]
use serde_json::json;
use serde_json::Value;
#[cfg(windows)]
use std::sync::Arc;
use tauri::Manager;
#[cfg(target_os = "android")]
async fn call(app: &tauri::AppHandle, method: &str, args: Value) -> Result<Value, String> {
    app.state::<crate::AndroidViewing>()
        .0
        .run_mobile_plugin_async::<Value>(method, args)
        .await
        .map_err(|e| {
            let error = e.to_string();
            [
                "application-closing",
                "speech-invalid-request",
                "speech-background",
                "speech-busy",
                "speech-permission-required",
                "speech-on-device-unavailable",
                "speech-provider-unavailable",
                "speech-permission-denied",
                "speech-no-match",
                "speech-no-input",
                "speech-recognition-failed",
                "speech-provider-busy",
                "speech-language-unsupported",
                "speech-language-unavailable",
                "speech-network-failed",
                "speech-result-too-large",
                "speech-timeout",
                "speech-canceled",
                "speech-owner-mismatch",
                "speech-stop-unconfirmed",
            ]
            .into_iter()
            .find(|code| error.contains(code))
            .unwrap_or("speech-platform-failed")
            .to_string()
        })
}
#[tauri::command]
pub async fn speech_capabilities(app: tauri::AppHandle) -> Result<Value, String> {
    if app
        .state::<crate::NativeState>()
        .closing
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("application-closing".into());
    }
    #[cfg(target_os = "android")]
    {
        call(&app, "speechCapabilities", json!({})).await
    }
    #[cfg(windows)]
    {
        app.state::<Arc<crate::windows_speech::WindowsSpeech>>()
            .capability()
            .await
    }
    #[cfg(not(any(target_os = "android", windows)))]
    {
        let _ = app;
        Ok(
            json!({"platform":"windows","onDeviceAvailable":false,"serviceAvailable":false,"permissionGranted":false,"cloudConsentRequired":true}),
        )
    }
}
#[tauri::command]
pub async fn speech_request_permission(
    app: tauri::AppHandle,
    request_id: String,
) -> Result<Value, String> {
    if app
        .state::<crate::NativeState>()
        .closing
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("application-closing".into());
    }
    #[cfg(target_os = "android")]
    {
        call(&app, "speechPermission", json!({"requestId":request_id})).await
    }
    #[cfg(windows)]
    {
        app.state::<Arc<crate::windows_speech::WindowsSpeech>>()
            .permission(&request_id)
    }
    #[cfg(not(any(target_os = "android", windows)))]
    {
        let _ = (app, request_id);
        Err("speech-provider-unavailable".into())
    }
}
#[tauri::command]
pub async fn speech_start(
    app: tauri::AppHandle,
    request_id: String,
    language: String,
    allow_cloud: bool,
) -> Result<Value, String> {
    if app
        .state::<crate::NativeState>()
        .closing
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("application-closing".into());
    }
    #[cfg(target_os = "android")]
    {
        call(
            &app,
            "speechStart",
            json!({"requestId":request_id,"language":language,"allowCloud":allow_cloud}),
        )
        .await
    }
    #[cfg(windows)]
    {
        let _ = allow_cloud;
        let window = app.get_webview_window("main").ok_or("speech-background")?;
        if !window.is_focused().unwrap_or(false) {
            return Err("speech-background".into());
        }
        app.state::<Arc<crate::windows_speech::WindowsSpeech>>()
            .start(request_id, language)
            .await
    }
    #[cfg(not(any(target_os = "android", windows)))]
    {
        let _ = (request_id, language, allow_cloud);
        Err("speech-provider-unavailable".into())
    }
}
#[tauri::command]
pub async fn speech_end(app: tauri::AppHandle, request_id: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        call(&app, "speechEnd", json!({"requestId":request_id}))
            .await
            .map(|_| ())
    }
    #[cfg(windows)]
    {
        app.state::<Arc<crate::windows_speech::WindowsSpeech>>()
            .end(&request_id)
    }
    #[cfg(not(any(target_os = "android", windows)))]
    {
        let _ = (app, request_id);
        Err("speech-provider-unavailable".into())
    }
}
#[tauri::command]
pub async fn speech_cancel(app: tauri::AppHandle, request_id: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        call(&app, "speechCancel", json!({"requestId":request_id}))
            .await
            .map(|_| ())
    }
    #[cfg(windows)]
    {
        app.state::<Arc<crate::windows_speech::WindowsSpeech>>()
            .cancel(&request_id)
            .await
    }
    #[cfg(not(any(target_os = "android", windows)))]
    {
        let _ = (app, request_id);
        Ok(())
    }
}
pub async fn shutdown(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use crate::native_debug_stages::{record, Stage};
        record(Stage::SpeechShutdownEnter);
        let result = call(app, "speechShutdown", json!({})).await.map(|_| ());
        record(Stage::SpeechShutdownSettled);
        result
    }
    #[cfg(windows)]
    {
        app.state::<Arc<crate::windows_speech::WindowsSpeech>>()
            .shutdown()
            .await
    }
    #[cfg(not(any(target_os = "android", windows)))]
    {
        let _ = app;
        Ok(())
    }
}
