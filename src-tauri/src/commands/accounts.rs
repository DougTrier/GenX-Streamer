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

//! Paid TV account commands: saving, refreshing and browsing Xtream-style accounts, their guides and video on demand, and account playback.
use crate::*;

#[tauri::command]
pub(crate) async fn list_iptv_accounts(
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<account_vault::Metadata>, String> {
    account_vault_owner::list(request_id, app).await
}
#[tauri::command]
pub(crate) async fn save_iptv_account(
    request: account_vault::Put,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_vault_owner::PutReceipt, String> {
    account_vault_owner::put(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn remove_iptv_account(
    request: account_vault::Remove,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_vault_owner::RemoveReceipt, String> {
    account_vault_owner::remove(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn inspect_iptv_account(
    request: account_vault_owner::InspectRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_vault_owner::InspectReceipt, String> {
    account_vault_owner::inspect(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn start_iptv_vod_playback(
    request: account_vod::PlayRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_playback_owner::Started, String> {
    account_playback_owner::start_vod(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn refresh_iptv_account(
    request: account_vault_owner::InspectRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_vault_owner::RefreshReceipt, String> {
    account_vault_owner::refresh(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn refresh_iptv_account_guide(
    request: account_vault_owner::InspectRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_guide::Status, String> {
    account_guide_owner::refresh(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn read_iptv_account_guide_status(
    request: account_guide_owner::ReadRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Option<account_guide::Status>, String> {
    account_guide_owner::status(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn read_iptv_account_guide_channels(
    request: account_guide_owner::ReadRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<account_guide::GuideChannel>, String> {
    account_guide_owner::channels(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn read_iptv_account_guide_listed(
    request: account_guide_owner::ReadRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_guide_owner::Listed, String> {
    account_guide_owner::listed(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn read_iptv_account_guide_programs(
    request: account_guide_owner::ReadRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_guide_owner::Programs, String> {
    account_guide_owner::programs(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn list_iptv_account_channels(
    request: account_catalog_owner::ListRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_catalog_owner::Page, String> {
    account_catalog_owner::list(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn list_iptv_account_countries(
    request: account_catalog_query::CountryRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_catalog_query::Countries, String> {
    account_catalog_query::countries(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn query_iptv_account_channels(
    request: account_catalog_query::Query,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_catalog_query::Page, String> {
    account_catalog_query::query(request, request_id, app).await
}
#[tauri::command]
pub(crate) async fn write_iptv_account_preferences(
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
pub(crate) async fn start_iptv_playback(
    request: account_catalog_owner::ResolveRequest,
    alternate: Option<bool>,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<account_playback_owner::Started, String> {
    account_playback_owner::start(request, alternate.unwrap_or(false), request_id, app).await
}
/// Measurement only: the latest live start's relay times (no addresses).
#[tauri::command]
pub(crate) fn account_playback_start_timing() -> Option<account_playback_proxy::StartTiming> {
    account_playback_proxy::start_timing()
}
#[tauri::command]
pub(crate) async fn stop_iptv_playback(
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
