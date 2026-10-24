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

//! GenXtra archive commands: playback, downloads and resume bookmarks.
use crate::*;

#[tauri::command]
pub(crate) async fn start_archive_playback(
    request: archive_playback_owner::StartRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_playback_owner::StartResult, String> {
    archive_playback_owner::start(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn start_archive_download_playback(
    request: archive_playback_owner::DownloadStartRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_playback_owner::StartResult, String> {
    archive_playback_owner::start_download(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn start_archive_download(
    request: archive_download_owner::Request,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_download_store::Receipt, String> {
    archive_download_owner::start(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn list_archive_downloads(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_download_store::List, String> {
    archive_download_owner::list(request_id, app).await
}
#[tauri::command]
pub(crate) async fn remove_archive_download(
    request: archive_download_owner::RemoveRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_download_owner::RemoveReceipt, String> {
    archive_download_owner::remove(request, request_id, app).await
}
#[tauri::command]
pub(crate) fn archive_download_status() -> Result<Option<archive_download_owner::Progress>, String>
{
    archive_download_owner::status()
}
#[tauri::command]
pub(crate) async fn stop_archive_downloads(
    app: tauri::AppHandle,
) -> Result<archive_download_owner::Stopped, String> {
    let work = app.state::<NativeState>().work.acquire();
    archive_playback_owner::spawn_cleanup(work, archive_download_owner::shutdown())
        .await
        .map_err(|_| "archive-download-cleanup-failed".to_string())?
}
#[tauri::command]
pub(crate) async fn stop_archive_playback(
    request: archive_playback_owner::SessionRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_playback_owner::Stopped, String> {
    archive_playback_owner::stop(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn renew_archive_playback(
    request: archive_playback_owner::SessionRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_playback_owner::Renewed, String> {
    archive_playback_owner::renew(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn read_archive_bookmark(
    request: archive_playback_owner::SessionRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_playback_owner::BookmarkRead, String> {
    archive_playback_owner::read_bookmark(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn save_archive_bookmark(
    request: archive_playback_owner::BookmarkSaveRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<archive_playback_owner::BookmarkSaved, String> {
    archive_playback_owner::save_bookmark(request, request_id, app).await
}
