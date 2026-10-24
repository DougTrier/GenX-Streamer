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

//! Voluntary updates (docs/updates.md, UP-001 to UP-010). Nothing here runs
//! unless the viewer asks: Check for updates reads the official repository's
//! latest release; Download and Install are each a separate choice.
//!
//! - Only the official release is accepted (UP-004): the fixed GitHub API
//!   address, an asset named for this platform and architecture (UP-006) at
//!   that release's own download address, redirects only to GitHub's hosts.
//! - A download must match the SHA-256 digest GitHub publishes for the asset
//!   and its declared size (UP-005), and is checked again before installing.
//!   On Android the app must also carry this copy's signing certificate
//!   (AppUpdatePlugin.kt), so a different publisher's APK is never offered.
//! - Windows (app_update/windows_swap.rs) replaces only GenX Streamer.exe,
//!   keeping the old one until the new one is in place (UP-007); the data
//!   folder and tmg-portable.flag are untouched (UP-008). The new version
//!   starts after an ordinary exit, and only when the viewer chose Restart.
//! - No background checks, no expiry, and GitHub being unreachable changes
//!   nothing else (UP-009, UP-010).

#[cfg(windows)]
mod windows_swap;
#[cfg(windows)]
pub(crate) use windows_swap::{after_update_wait, relaunch_after_exit, remove_previous};

use crate::NativeState;
use reqwest::{redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

pub(crate) const RELEASES_API: &str =
    "https://api.github.com/repos/DougTrier/GenX-Streamer/releases/latest";
const DOWNLOAD_PREFIX: &str = "https://github.com/DougTrier/GenX-Streamer/releases/download/";
const RELEASE_PAGE_PREFIX: &str = "https://github.com/DougTrier/GenX-Streamer/releases/";
/// GitHub serves release files from github.com, then one of its file hosts.
const ASSET_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
const MAX_RELEASE_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;
const MAX_NOTES: usize = 4000;
pub(crate) const PROGRESS_EVENT: &str = "update-progress";

/// major.minor.patch, from "1.2.3" or "v1.2.3".
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Version(u64, u64, u64);
impl Version {
    pub(crate) fn parse(raw: &str) -> Option<Self> {
        let text = raw.trim().strip_prefix('v').unwrap_or(raw.trim());
        let mut parts = text.split('.');
        let mut next = || -> Option<u64> {
            let part = parts.next()?;
            if part.is_empty() || part.len() > 9 || !part.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            part.parse().ok()
        };
        let version = Version(next()?, next()?, next()?);
        parts.next().is_none().then_some(version)
    }
}
impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

/// The release file for this build (docs/updates.md, "Release files").
pub(crate) fn asset_name(version: Version, os: &str, arch: &str) -> Option<String> {
    let platform = match (os, arch) {
        ("windows", "x86_64") => "Windows-x64.exe",
        // One universal APK for every ARM device (docs/share-links.md SH-010).
        ("android", "aarch64" | "arm") => "Android.apk",
        _ => return None,
    };
    Some(format!("GenX-Streamer-{version}-{platform}"))
}

#[derive(Deserialize)]
pub(crate) struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    published_at: Option<String>,
    html_url: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}
#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
    size: u64,
    browser_download_url: String,
    digest: Option<String>,
    state: Option<String>,
}

/// A newer release this build can install, as checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub version: Version,
    pub asset: String,
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Available {
    pub version: String,
    pub title: String,
    /// Release notes as plain text (the interface never renders them as markup).
    pub notes: String,
    pub published: Option<String>,
    pub release_page: Option<String>,
    pub bytes: u64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCheck {
    pub installed: String,
    /// The latest official release, whether or not it is newer.
    pub latest: Option<Available>,
    pub newer: bool,
}

fn text(raw: Option<&str>, max: usize) -> String {
    raw.unwrap_or("")
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Reads the latest release: what it is, and the file this build would install.
pub(crate) fn assess(
    release: &GitHubRelease,
    installed: Version,
    os: &str,
    arch: &str,
) -> Result<(UpdateCheck, Option<Candidate>), &'static str> {
    if release.draft || release.prerelease {
        return Err("update-no-release");
    }
    let version = Version::parse(&release.tag_name).ok_or("update-release-invalid")?;
    let release_page = release
        .html_url
        .as_deref()
        .filter(|url| url.starts_with(RELEASE_PAGE_PREFIX) && url.len() <= 512)
        .map(str::to_string);
    let newer = version > installed;
    let mut candidate = None;
    let mut bytes = 0;
    if newer {
        let name = asset_name(version, os, arch).ok_or("update-platform-unsupported")?;
        let asset = release
            .assets
            .iter()
            .find(|asset| asset.name == name)
            .ok_or("update-asset-missing")?;
        let expected = format!("{DOWNLOAD_PREFIX}{}/{name}", release.tag_name);
        if asset.browser_download_url != expected
            || asset.size == 0
            || asset.size > MAX_ASSET_BYTES
            || asset
                .state
                .as_deref()
                .is_some_and(|state| state != "uploaded")
        {
            return Err("update-asset-invalid");
        }
        let sha256 = asset
            .digest
            .as_deref()
            .and_then(|digest| digest.strip_prefix("sha256:"))
            .filter(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(|hex| hex.to_ascii_lowercase())
            .ok_or("update-unverifiable")?;
        bytes = asset.size;
        candidate = Some(Candidate {
            version,
            asset: name,
            url: expected,
            bytes,
            sha256,
        });
    }
    let title = text(release.name.as_deref(), 200);
    Ok((
        UpdateCheck {
            installed: installed.to_string(),
            latest: Some(Available {
                version: version.to_string(),
                title: if title.is_empty() {
                    format!("GenX Streamer {version}")
                } else {
                    title
                },
                notes: text(release.body.as_deref(), MAX_NOTES),
                published: release
                    .published_at
                    .as_deref()
                    .filter(|date| date.len() <= 40)
                    .map(str::to_string),
                release_page,
                bytes,
            }),
            newer,
        },
        candidate,
    ))
}

/// A download that matched its digest, waiting for Install.
#[derive(Clone, Debug)]
pub(crate) struct Staged {
    pub version: Version,
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Default)]
pub(crate) struct UpdateOwner {
    checked: Mutex<Option<Candidate>>,
    staged: Mutex<Option<Staged>>,
    downloading: AtomicBool,
    cancel: AtomicBool,
}

fn installed_version(app: &tauri::AppHandle) -> Result<Version, String> {
    Version::parse(&app.package_info().version.to_string())
        .ok_or_else(|| "update-version-unknown".to_string())
}

fn client(redirects: bool) -> Result<reqwest::Client, String> {
    let policy = if redirects {
        Policy::custom(|attempt| {
            let allowed = attempt.url().scheme() == "https"
                && attempt
                    .url()
                    .host_str()
                    .is_some_and(|host| ASSET_HOSTS.contains(&host));
            if attempt.previous().len() >= 5 || !allowed {
                attempt.error("update-redirect-refused")
            } else {
                attempt.follow()
            }
        })
    } else {
        Policy::none()
    };
    reqwest::Client::builder()
        .redirect(policy)
        .https_only(true)
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("GenX-Streamer/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "update-unavailable".to_string())
}

fn transport(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "update-timeout".into()
    } else if error.is_redirect() {
        "update-redirect-refused".into()
    } else {
        "update-offline".into()
    }
}

/// Check for updates: reads the official latest release (only when asked).
#[tauri::command]
pub(crate) async fn update_check(app: tauri::AppHandle) -> Result<UpdateCheck, String> {
    let _work = app.state::<NativeState>().admit_work()?;
    let installed = installed_version(&app)?;
    let mut response = client(false)?
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(transport)?;
    match response.status().as_u16() {
        200 => {}
        404 => return Err("update-no-release".into()),
        403 | 429 => return Err("update-rate-limited".into()),
        _ => return Err("update-unavailable".into()),
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport)? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_RELEASE_BYTES {
            return Err("update-release-invalid".into());
        }
    }
    let release: GitHubRelease =
        serde_json::from_slice(&body).map_err(|_| "update-release-invalid".to_string())?;
    let (check, candidate) = assess(
        &release,
        installed,
        std::env::consts::OS,
        std::env::consts::ARCH,
    )?;
    let owner = app.state::<UpdateOwner>();
    *owner.checked.lock().map_err(|_| "update-unavailable")? = candidate;
    Ok(check)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadReceipt {
    pub version: String,
    pub bytes: u64,
    /// The file matched the digest GitHub publishes for it.
    pub verified: bool,
}

pub(crate) fn hash_file(path: &std::path::Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|_| "update-file-missing".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "update-file-missing".to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn staging(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let folder = app
        .path()
        .app_cache_dir()
        .map_err(|_| "update-storage-unavailable".to_string())?
        .join("updates");
    std::fs::create_dir_all(&folder).map_err(|_| "update-storage-unavailable".to_string())?;
    Ok(folder)
}

/// Download update: the file of the release last checked (never a caller's address).
#[tauri::command]
pub(crate) async fn update_download(
    app: tauri::AppHandle,
    version: String,
) -> Result<DownloadReceipt, String> {
    let state = app.state::<NativeState>();
    let _work = state.admit_work()?;
    let owner = app.state::<UpdateOwner>();
    let candidate = owner
        .checked
        .lock()
        .map_err(|_| "update-unavailable")?
        .clone()
        .filter(|candidate| candidate.version.to_string() == version)
        .ok_or("update-not-checked")?;
    if owner.downloading.swap(true, Ordering::SeqCst) {
        return Err("update-busy".into());
    }
    owner.cancel.store(false, Ordering::SeqCst);
    let result = download(&app, &owner, &state, &candidate).await;
    owner.downloading.store(false, Ordering::SeqCst);
    let staged = result?;
    let receipt = DownloadReceipt {
        version: staged.version.to_string(),
        bytes: candidate.bytes,
        verified: true,
    };
    *owner.staged.lock().map_err(|_| "update-unavailable")? = Some(staged);
    Ok(receipt)
}

async fn download(
    app: &tauri::AppHandle,
    owner: &UpdateOwner,
    state: &NativeState,
    candidate: &Candidate,
) -> Result<Staged, String> {
    use std::io::Write;
    let folder = staging(app)?;
    // One update file at a time: an older download is never kept beside a newer one.
    if let Ok(entries) = std::fs::read_dir(&folder) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    if let Ok(mut staged) = owner.staged.lock() {
        *staged = None;
    }
    let url = Url::parse(&candidate.url).map_err(|_| "update-asset-invalid")?;
    let mut response = client(true)?
        .get(url)
        .timeout(Duration::from_secs(30 * 60))
        .send()
        .await
        .map_err(transport)?;
    if !response.status().is_success() {
        return Err("update-download-refused".into());
    }
    if response
        .content_length()
        .is_some_and(|length| length != candidate.bytes)
    {
        return Err("update-download-mismatch".into());
    }
    let partial = folder.join(format!("{}.partial", candidate.asset));
    let target = folder.join(&candidate.asset);
    let mut file =
        std::fs::File::create(&partial).map_err(|_| "update-storage-unavailable".to_string())?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut reported = 0u64;
    let outcome: Result<(), String> = async {
        while let Some(chunk) = response.chunk().await.map_err(transport)? {
            if owner.cancel.load(Ordering::SeqCst) || state.closing.load(Ordering::SeqCst) {
                return Err("update-canceled".into());
            }
            received += chunk.len() as u64;
            if received > candidate.bytes {
                return Err("update-download-mismatch".into());
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .map_err(|_| "update-storage-unavailable".to_string())?;
            if received - reported > candidate.bytes / 50 || received == candidate.bytes {
                reported = received;
                let _ = app.emit(
                    PROGRESS_EVENT,
                    serde_json::json!({"received": received, "total": candidate.bytes}),
                );
            }
        }
        file.sync_all()
            .map_err(|_| "update-storage-unavailable".to_string())?;
        if received != candidate.bytes {
            return Err("update-download-mismatch".into());
        }
        if format!("{:x}", hasher.finalize_reset()) != candidate.sha256 {
            return Err("update-digest-mismatch".into());
        }
        Ok(())
    }
    .await;
    drop(file);
    if let Err(error) = outcome {
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    std::fs::rename(&partial, &target).map_err(|_| {
        let _ = std::fs::remove_file(&partial);
        "update-storage-unavailable".to_string()
    })?;
    Ok(Staged {
        version: candidate.version,
        path: target,
        sha256: candidate.sha256.clone(),
    })
}

/// Stops a download in progress; the partial file is removed.
#[tauri::command]
pub(crate) fn update_cancel(app: tauri::AppHandle) {
    app.state::<UpdateOwner>()
        .cancel
        .store(true, Ordering::SeqCst);
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallReceipt {
    /// Windows: the new GenX Streamer.exe is in place and starts on Restart.
    /// Android: Android's installer is open and asks the viewer.
    pub installer_opened: bool,
    pub restart_required: bool,
}

#[cfg(target_os = "android")]
struct AppUpdatePlugin(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry, ()>::new("app-update")
        .setup(|app, api| {
            app.manage(UpdateOwner::default());
            #[cfg(target_os = "android")]
            app.manage(AppUpdatePlugin(
                api.register_android_plugin("com.tmg.tv", "AppUpdatePlugin")?,
            ));
            #[cfg(not(target_os = "android"))]
            let _ = api;
            Ok(())
        })
        .build()
}

/// Install update: the verified download, checked once more first.
#[tauri::command]
pub(crate) async fn update_install(
    app: tauri::AppHandle,
    version: String,
) -> Result<InstallReceipt, String> {
    let _work = app.state::<NativeState>().admit_work()?;
    let staged = app
        .state::<UpdateOwner>()
        .staged
        .lock()
        .map_err(|_| "update-unavailable")?
        .clone()
        .filter(|staged| staged.version.to_string() == version)
        .ok_or("update-not-downloaded")?;
    let path = staged.path.clone();
    let digest = tauri::async_runtime::spawn_blocking(move || hash_file(&path))
        .await
        .map_err(|_| "update-file-missing".to_string())??;
    if digest != staged.sha256 {
        return Err("update-digest-mismatch".into());
    }
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|_| "update-install-failed")?;
        let sha = staged.sha256.clone();
        tauri::async_runtime::spawn_blocking(move || {
            windows_swap::install(&staged.path, &exe, &sha, windows_swap::rename)
        })
        .await
        .map_err(|_| "update-install-failed".to_string())??;
        Ok(InstallReceipt {
            installer_opened: false,
            restart_required: true,
        })
    }
    #[cfg(target_os = "android")]
    {
        let plugin = app
            .try_state::<AppUpdatePlugin>()
            .ok_or("update-unavailable")?;
        plugin
            .0
            .run_mobile_plugin_async::<InstallReceipt>(
                "installUpdate",
                serde_json::json!({"path": staged.path.to_string_lossy()}),
            )
            .await
            .map_err(|error| match error {
                tauri::plugin::mobile::PluginInvokeError::InvokeRejected(rejected) => rejected
                    .message
                    .filter(|code| code.starts_with("update-") && code.len() <= 64)
                    .unwrap_or_else(|| "update-install-failed".into()),
                _ => "update-install-failed".into(),
            })
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = staged;
        Err("update-platform-unsupported".into())
    }
}

/// Windows: after Install, the viewer's Restart starts the new version once
/// GenX has closed the ordinary way (lifecycle.rs calls relaunch_after_exit).
#[tauri::command]
pub(crate) fn update_restart(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_swap::request_relaunch();
        let _ = app;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("update-platform-unsupported".into())
    }
}

#[cfg(test)]
#[path = "app_update_tests.rs"]
mod tests;
