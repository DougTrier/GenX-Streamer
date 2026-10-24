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

//! Share links (docs/share-links.md): the system share sheet for "Watch News 24
//! on GenX Streamer: <link>" and for the app itself, links that open GenX
//! Streamer (genx:// and the https page link), and the check that a shared
//! stream's server is public before anything is fetched from it.
//!
//! The native side only carries links: it admits a link's outer shape (our
//! own scheme or page, bounded, no control characters) and hands it to the
//! interface, which reads and validates every field (src/sharing/share-link.ts).
//! Nothing here logs a link: it names a channel the viewer chose to open.
//!
//! - Windows (share_links/windows_links.rs): genx:// is registered for the
//!   current user to the running GenX Streamer.exe; a second launch with a link
//!   hands it to the running copy. The share sheet is Windows' own
//!   (share_links/windows_share.rs).
//! - Android (SharePlugin.kt): the intent filters in AndroidManifest.xml, the
//!   ACTION_SEND share sheet and the installed APK through the FileProvider.

#[cfg(windows)]
mod windows_links;
#[cfg(windows)]
mod windows_share;
#[cfg(windows)]
pub(crate) use windows_links::{forward_to_running_copy, start as start_windows};

use serde::Serialize;
use std::net::SocketAddr;
use std::time::Duration;

/// The longest link GenX accepts (src/sharing/share-link.ts LIMITS.link).
pub(crate) const MAX_LINK: usize = 6000;
const MAX_TITLE: usize = 240;
const MAX_TEXT: usize = 6400;
/// The event that tells the interface a link is waiting (take_incoming_link).
pub(crate) const INCOMING_EVENT: &str = "incoming-link";

/// A link's outer shape: GenX's own scheme or its web page, bounded, printable.
/// The interface checks every field inside it.
pub(crate) fn admit_link(raw: &str) -> Option<String> {
    let link = raw.trim();
    let lower = link.get(..48).unwrap_or(link).to_ascii_lowercase();
    if link.is_empty()
        || link.len() > MAX_LINK
        || link.chars().any(|c| c.is_control() || c.is_whitespace())
        || !(lower.starts_with("genx://watch")
            || lower.starts_with("https://dougtrier.github.io/genx-streamer/watch"))
    {
        return None;
    }
    Some(link.to_string())
}

/// The link waiting for the interface (Windows; Android keeps its own in SharePlugin).
#[derive(Default)]
pub(crate) struct IncomingLinks(std::sync::Mutex<Option<String>>);
impl IncomingLinks {
    /// The newest link replaces an older one the interface has not taken yet.
    pub(crate) fn offer(&self, link: String) {
        if let Ok(mut pending) = self.0.lock() {
            *pending = Some(link);
        }
    }
    pub(crate) fn take(&self) -> Option<String> {
        self.0.lock().ok().and_then(|mut pending| pending.take())
    }
}

#[cfg(target_os = "android")]
struct SharePlugin(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry, ()>::new("share-links")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                app.manage(SharePlugin(
                    api.register_android_plugin("com.tmg.tv", "SharePlugin")?,
                ));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

/// The share sheet opened: not proof that anything was sent.
#[derive(Debug, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareReceipt {
    pub shown: bool,
}

fn message_fields(title: &str, text: &str) -> Result<(), String> {
    if title.trim().is_empty()
        || title.chars().count() > MAX_TITLE
        || text.trim().is_empty()
        || text.chars().count() > MAX_TEXT
        || title.contains('\0')
        || text.contains('\0')
    {
        return Err("share-message-invalid".into());
    }
    Ok(())
}

#[cfg(target_os = "android")]
async fn android_call<R: serde::de::DeserializeOwned>(
    app: &tauri::AppHandle,
    command: &str,
    args: serde_json::Value,
) -> Result<R, String> {
    use tauri::Manager;
    let plugin = app.try_state::<SharePlugin>().ok_or("share-unavailable")?;
    plugin
        .0
        .run_mobile_plugin_async::<R>(command, args)
        .await
        .map_err(|error| match error {
            tauri::plugin::mobile::PluginInvokeError::InvokeRejected(rejected) => rejected
                .message
                .filter(|code| code.starts_with("share-") && code.len() <= 64)
                .unwrap_or_else(|| "share-unavailable".into()),
            _ => "share-unavailable".into(),
        })
}

/// This installed copy's APK (its own sourceDir) and whether it was installed
/// in several parts (which cannot be shared as one file).
#[cfg(target_os = "android")]
pub(crate) async fn android_app_file(
    app: &tauri::AppHandle,
) -> Result<(std::path::PathBuf, bool), String> {
    #[derive(serde::Deserialize)]
    struct Reply {
        path: String,
        split: bool,
    }
    let reply: Reply = android_call(app, "appFile", serde_json::json!({})).await?;
    Ok((std::path::PathBuf::from(reply.path), reply.split))
}

/// This copy's signing fingerprints, whether it is debuggable and whether it is split.
#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
pub(crate) struct AndroidIdentity {
    pub signers: Vec<String>,
    pub debuggable: bool,
    pub split: bool,
}
#[cfg(target_os = "android")]
pub(crate) async fn android_identity(app: &tauri::AppHandle) -> Result<AndroidIdentity, String> {
    let found: AndroidIdentity = android_call(app, "appIdentity", serde_json::json!({})).await?;
    if found.signers.len() > 8
        || found
            .signers
            .iter()
            .any(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("identity-unavailable".into());
    }
    Ok(found)
}

/// The link GenX was opened with, or the newest one since; each is given out once.
#[tauri::command]
pub(crate) async fn take_incoming_link(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Deserialize)]
        struct Reply {
            link: Option<String>,
        }
        let reply: Reply = android_call(&app, "takeIncomingLink", serde_json::json!({})).await?;
        Ok(reply.link.as_deref().and_then(admit_link))
    }
    #[cfg(not(target_os = "android"))]
    {
        use tauri::Manager;
        Ok(app
            .try_state::<IncomingLinks>()
            .and_then(|links| links.take()))
    }
}

/// Opens the system share sheet with a message (the interface builds it from a
/// validated link; Paid TV never reaches here).
#[tauri::command]
pub(crate) async fn share_text(
    app: tauri::AppHandle,
    title: String,
    text: String,
) -> Result<ShareReceipt, String> {
    message_fields(&title, &text)?;
    #[cfg(target_os = "android")]
    {
        android_call(
            &app,
            "shareText",
            serde_json::json!({"title": title, "text": text}),
        )
        .await
    }
    #[cfg(windows)]
    {
        windows_share::share(app, windows_share::Payload::Text { title, text }).await
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = (app, title, text);
        Err("share-unavailable".into())
    }
}

/// Shares the installed app itself: the APK on Android (Quick Share, Bluetooth,
/// messaging), GenX Streamer.exe on Windows (Nearby Sharing, mail).
#[tauri::command]
pub(crate) async fn share_app_file(
    app: tauri::AppHandle,
    title: String,
    text: String,
) -> Result<ShareReceipt, String> {
    message_fields(&title, &text)?;
    // Only an official release copy sends its own APK (docs/verify-a-download.md).
    crate::app_identity::may_send_app_file(&app).await?;
    #[cfg(target_os = "android")]
    {
        android_call(
            &app,
            "shareApp",
            serde_json::json!({"title": title, "text": text}),
        )
        .await
    }
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|_| "share-app-unavailable")?;
        windows_share::share(app, windows_share::Payload::File { title, text, exe }).await
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = (app, title, text);
        Err("share-unavailable".into())
    }
}

/// The address a shared stream or logo may be fetched from: http or https, a
/// host, no credentials.
fn shared_destination(raw: &str) -> Result<(String, u16), String> {
    let refused = || "share-destination-invalid".to_string();
    if raw.len() > 2048 || raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(refused());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| refused())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(refused());
    }
    let host = url.host_str().ok_or_else(refused)?;
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = url.port_or_known_default().ok_or_else(refused)?;
    Ok((host, port))
}

/// Every address a resolved name gives must be public (sharing_policy::public_upstream),
/// so a link can never point GenX at the viewer's own network.
pub(crate) fn all_public(addresses: &[SocketAddr]) -> Result<(), String> {
    if addresses.is_empty() || addresses.len() > 128 {
        return Err("share-destination-unresolved".into());
    }
    if addresses
        .iter()
        .any(|address| !crate::sharing_policy::public_upstream(address.ip()))
    {
        return Err("share-destination-private".into());
    }
    Ok(())
}

/// Checks that a shared link's stream (or logo) server is on the public
/// internet before GenX plays or fetches it.
#[tauri::command]
pub(crate) async fn check_shared_destination(url: String) -> Result<(), String> {
    let (host, port) = shared_destination(&url)?;
    let lookup = tokio::net::lookup_host((host.as_str(), port));
    let addresses: Vec<SocketAddr> = tokio::time::timeout(Duration::from_secs(8), lookup)
        .await
        .map_err(|_| "share-destination-unresolved".to_string())?
        .map_err(|_| "share-destination-unresolved".to_string())?
        .take(129)
        .collect();
    all_public(&addresses)
}

#[cfg(test)]
#[path = "share_links_tests.rs"]
mod tests;
