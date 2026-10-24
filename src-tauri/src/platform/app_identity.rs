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

//! Is this copy genuine? (docs/verify-a-download.md). About shows the version,
//! platform and build; on Android also the signing certificate's SHA-256
//! fingerprint and whether it is the owner's release certificate. Only an
//! official release copy may send its own APK (Send the app, Share with
//! everyone nearby); development copies offer the link and QR code instead.
//! Windows ships unsigned (owner's decision): its file checksum, compared with
//! SHA256SUMS on the release page, is its only check.

use serde::Serialize;

/// SHA-256 fingerprint of the owner's Android release signing certificate:
/// 64 lowercase hex characters, no colons. The owner created the key on
/// October 24, 2026 (src-tauri/scripts/new-release-key.ps1) and provided this
/// public fingerprint; the key itself stays with the owner. Never change it
/// without a new key: installed copies are checked against it.
// Read on Android (and by the tests); Windows has no signature to compare.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) const RELEASE_CERTIFICATE_SHA256: &str =
    "464c42785a80bb27022527d7e5b703c4ecf2d62f433a0f9f6b162ee95b7872ff";

/// Official only when the release fingerprint is known and this copy is
/// signed by that certificate alone.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn official(release: &str, signers: &[String]) -> bool {
    release.len() == 64
        && release
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && signers.len() == 1
        && signers[0] == release
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppIdentity {
    pub version: String,
    pub platform: &'static str,
    pub architecture: &'static str,
    /// "release" or "development" (Android: a debuggable package; Windows: a debug build).
    pub build: &'static str,
    /// Android: the signing certificates' SHA-256 fingerprints.
    pub signers: Vec<String>,
    /// Signed with the owner's release certificate (always false on Windows).
    pub official: bool,
    /// Android: installed as several APKs, so it cannot be sent as one file.
    pub split: bool,
}

/// Whether this copy may send its own app file: Windows (unsigned by
/// decision) always; Android only as an official release in one APK.
pub(crate) async fn may_send_app_file(app: &tauri::AppHandle) -> Result<(), String> {
    let identity = identity(app).await?;
    if identity.platform == "Android" && !identity.official {
        return Err("share-app-development".into());
    }
    if identity.split {
        return Err("share-app-split".into());
    }
    Ok(())
}

async fn identity(app: &tauri::AppHandle) -> Result<AppIdentity, String> {
    let version = app.package_info().version.to_string();
    #[cfg(target_os = "android")]
    {
        let found = crate::share_links::android_identity(app).await?;
        let official = official(RELEASE_CERTIFICATE_SHA256, &found.signers);
        Ok(AppIdentity {
            version,
            platform: "Android",
            architecture: std::env::consts::ARCH,
            build: if found.debuggable {
                "development"
            } else {
                "release"
            },
            signers: found.signers,
            official,
            split: found.split,
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(AppIdentity {
            version,
            platform: if cfg!(windows) { "Windows" } else { "Other" },
            architecture: std::env::consts::ARCH,
            build: if cfg!(debug_assertions) {
                "development"
            } else {
                "release"
            },
            signers: Vec::new(),
            official: false,
            split: false,
        })
    }
}

#[tauri::command]
pub(crate) async fn app_identity(app: tauri::AppHandle) -> Result<AppIdentity, String> {
    identity(&app).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppChecksum {
    pub sha256: String,
    pub bytes: u64,
}

/// The SHA-256 of this copy's own file (the installed APK, or the running exe),
/// to compare with SHA256SUMS on the release page. Computed only when asked.
#[tauri::command]
pub(crate) async fn app_checksum(app: tauri::AppHandle) -> Result<AppChecksum, String> {
    #[cfg(target_os = "android")]
    let path = crate::share_links::android_app_file(&app).await?.0;
    #[cfg(not(target_os = "android"))]
    let path = {
        let _ = &app;
        std::env::current_exe().map_err(|_| "identity-file-unavailable".to_string())?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::metadata(&path)
            .map_err(|_| "identity-file-unavailable".to_string())?
            .len();
        let sha256 = crate::app_update::hash_file(&path)
            .map_err(|_| "identity-file-unavailable".to_string())?;
        Ok(AppChecksum { sha256, bytes })
    })
    .await
    .map_err(|_| "identity-file-unavailable".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELEASE: &str = "9f2c4e1a7b3d5c8e0f6a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e";

    #[test]
    fn the_owners_certificate_is_official_and_an_empty_one_matches_nothing() {
        assert_eq!(RELEASE_CERTIFICATE_SHA256.len(), 64);
        assert!(official(
            RELEASE_CERTIFICATE_SHA256,
            &[RELEASE_CERTIFICATE_SHA256.to_string()]
        ));
        assert!(!official(
            RELEASE_CERTIFICATE_SHA256,
            &[RELEASE.to_string()]
        ));
        assert!(!official("", &[String::new()]));
    }

    #[test]
    fn only_the_release_certificate_alone_is_official() {
        assert!(official(RELEASE, &[RELEASE.to_string()]));
        assert!(!official(RELEASE, &["0".repeat(64)]));
        assert!(!official(RELEASE, &[]));
        assert!(!official(RELEASE, &[RELEASE.to_string(), "0".repeat(64)]));
        assert!(!official(
            &RELEASE.to_uppercase(),
            &[RELEASE.to_uppercase()]
        ));
        assert!(!official(&RELEASE[..63], &[RELEASE[..63].to_string()]));
    }
}
