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

//! Source commands: fetching playlists and media and inspecting sources, directories and websites (every destination is validated).
use crate::*;

#[tauri::command]
pub(crate) async fn fetch_playlist(
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
pub(crate) fn cancel_playlist(
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
pub(crate) async fn inspect_source(
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
pub(crate) async fn inspect_discovery_page(
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
pub(crate) async fn series_identity_lookup(
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
pub(crate) async fn inspect_source_directory(
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
pub(crate) async fn inspect_health_source(
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
pub(crate) async fn inspect_media_resources(
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
    let result = tokio::select! {
        r=network_media_probe::inspect(&url,allow_http,request_id.clone(),budget_ms) => r,
        _=receiver => Err("canceled".into()),
    };
    state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .finish(&request_id);
    result
}

#[tauri::command]
pub(crate) async fn fetch_media(
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
pub(crate) async fn fetch_media_bytes(
    url: String,
    allow_http: bool,
    request_id: String,
    range: Option<String>,
    state: tauri::State<'_, NativeState>,
) -> Result<tauri::ipc::Response, String> {
    let payload = fetch_media(url, allow_http, request_id, range, state).await?;
    Ok(tauri::ipc::Response::new(network::frame_media(&payload)?))
}
