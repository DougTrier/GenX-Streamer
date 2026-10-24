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

use super::*;

const DIGEST: &str = "4f6c1b1a1e5f0d8a9b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a";

/// A release in GitHub's API shape (fields GenX reads), with this build's files.
fn release(tag: &str, assets: serde_json::Value) -> GitHubRelease {
    serde_json::from_value(serde_json::json!({
        "tag_name": tag,
        "name": "GenX Streamer 1.1.0",
        "body": "Performance improvements.\n\u{7}Bug fixes.",
        "draft": false,
        "prerelease": false,
        "published_at": "2026-11-02T18:00:00Z",
        "html_url": format!("https://github.com/DougTrier/GenX-Streamer/releases/tag/{tag}"),
        "assets": assets,
    }))
    .unwrap()
}
fn asset(tag: &str, name: &str) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "size": 48_000_000,
        "state": "uploaded",
        "digest": format!("sha256:{DIGEST}"),
        "browser_download_url":
            format!("https://github.com/DougTrier/GenX-Streamer/releases/download/{tag}/{name}"),
    })
}
fn v(text: &str) -> Version {
    Version::parse(text).unwrap()
}

#[test]
fn versions_are_three_numbers_with_an_optional_v() {
    assert_eq!(v("1.2.3"), Version(1, 2, 3));
    assert_eq!(v("v10.0.1"), Version(10, 0, 1));
    assert!(v("1.10.0") > v("1.9.9"));
    assert!(v("2.0.0") > v("1.99.99"));
    for invalid in [
        "",
        "1.2",
        "1.2.3.4",
        "1.2.x",
        "v",
        "1.2.3-beta",
        "-1.2.3",
        "1..3",
    ] {
        assert_eq!(Version::parse(invalid), None, "{invalid}");
    }
    assert_eq!(v("v0.1.0").to_string(), "0.1.0");
}

#[test]
fn each_platform_and_architecture_has_its_own_release_file() {
    assert_eq!(
        asset_name(v("1.1.0"), "windows", "x86_64").as_deref(),
        Some("GenX-Streamer-1.1.0-Windows-x64.exe")
    );
    assert_eq!(
        asset_name(v("1.1.0"), "android", "aarch64").as_deref(),
        Some("GenX-Streamer-1.1.0-Android-arm64.apk")
    );
    assert_eq!(
        asset_name(v("1.1.0"), "android", "arm").as_deref(),
        Some("GenX-Streamer-1.1.0-Android-armv7.apk")
    );
    assert_eq!(asset_name(v("1.1.0"), "windows", "aarch64"), None);
    assert_eq!(asset_name(v("1.1.0"), "linux", "x86_64"), None);
}

#[test]
fn a_newer_release_offers_this_builds_file_with_its_published_digest() {
    let tag = "v1.1.0";
    let release = release(
        tag,
        serde_json::json!([
            asset(tag, "GenX-Streamer-1.1.0-Android-arm64.apk"),
            asset(tag, "GenX-Streamer-1.1.0-Android-armv7.apk"),
            asset(tag, "GenX-Streamer-1.1.0-Windows-x64.exe"),
        ]),
    );
    let (check, candidate) = assess(&release, v("1.0.0"), "android", "arm").unwrap();
    assert!(check.newer);
    assert_eq!(check.installed, "1.0.0");
    let latest = check.latest.unwrap();
    assert_eq!(latest.version, "1.1.0");
    assert_eq!(latest.title, "GenX Streamer 1.1.0");
    // Notes stay plain text: control characters other than line breaks are dropped.
    assert_eq!(latest.notes, "Performance improvements.\nBug fixes.");
    assert_eq!(
        latest.release_page.as_deref(),
        Some("https://github.com/DougTrier/GenX-Streamer/releases/tag/v1.1.0")
    );
    let candidate = candidate.unwrap();
    assert_eq!(candidate.asset, "GenX-Streamer-1.1.0-Android-armv7.apk");
    assert_eq!(candidate.sha256, DIGEST);
    assert_eq!(candidate.bytes, 48_000_000);
    assert_eq!(
        candidate.url,
        "https://github.com/DougTrier/GenX-Streamer/releases/download/v1.1.0/GenX-Streamer-1.1.0-Android-armv7.apk"
    );
}

#[test]
fn the_same_or_an_older_release_offers_nothing_to_download() {
    let tag = "v1.0.0";
    let release = release(
        tag,
        serde_json::json!([asset(tag, "GenX-Streamer-1.0.0-Windows-x64.exe")]),
    );
    for installed in ["1.0.0", "1.2.0"] {
        let (check, candidate) = assess(&release, v(installed), "windows", "x86_64").unwrap();
        assert!(!check.newer);
        assert_eq!(candidate, None);
        assert_eq!(check.latest.unwrap().version, "1.0.0");
    }
}

#[test]
fn only_official_published_files_with_a_digest_are_accepted() {
    let tag = "v1.1.0";
    let name = "GenX-Streamer-1.1.0-Windows-x64.exe";
    let refused = |assets: serde_json::Value| {
        assess(&release(tag, assets), v("1.0.0"), "windows", "x86_64").unwrap_err()
    };
    assert_eq!(refused(serde_json::json!([])), "update-asset-missing");
    assert_eq!(
        refused(serde_json::json!([asset(
            tag,
            "GenX-Streamer-1.1.0-Android-arm64.apk"
        )])),
        "update-asset-missing"
    );
    let mut elsewhere = asset(tag, name);
    elsewhere["browser_download_url"] = serde_json::json!(format!(
        "https://example.com/DougTrier/GenX-Streamer/releases/download/{tag}/{name}"
    ));
    assert_eq!(
        refused(serde_json::json!([elsewhere])),
        "update-asset-invalid"
    );
    let mut fork = asset(tag, name);
    fork["browser_download_url"] = serde_json::json!(format!(
        "https://github.com/someone/GenX-Streamer/releases/download/{tag}/{name}"
    ));
    assert_eq!(refused(serde_json::json!([fork])), "update-asset-invalid");
    let mut other_tag = asset(tag, name);
    other_tag["browser_download_url"] = serde_json::json!(format!(
        "https://github.com/DougTrier/GenX-Streamer/releases/download/v9.9.9/{name}"
    ));
    assert_eq!(
        refused(serde_json::json!([other_tag])),
        "update-asset-invalid"
    );
    let mut huge = asset(tag, name);
    huge["size"] = serde_json::json!(MAX_ASSET_BYTES + 1);
    assert_eq!(refused(serde_json::json!([huge])), "update-asset-invalid");
    let mut uploading = asset(tag, name);
    uploading["state"] = serde_json::json!("open");
    assert_eq!(
        refused(serde_json::json!([uploading])),
        "update-asset-invalid"
    );
    for digest in [
        serde_json::Value::Null,
        serde_json::json!("md5:abc"),
        serde_json::json!("sha256:1234"),
        serde_json::json!(format!("sha256:{}", "z".repeat(64))),
    ] {
        let mut unverifiable = asset(tag, name);
        unverifiable["digest"] = digest;
        assert_eq!(
            refused(serde_json::json!([unverifiable])),
            "update-unverifiable"
        );
    }
}

#[test]
fn drafts_prereleases_and_unreadable_tags_are_not_releases() {
    let mut draft = release("v2.0.0", serde_json::json!([]));
    draft.draft = true;
    assert_eq!(
        assess(&draft, v("1.0.0"), "windows", "x86_64").unwrap_err(),
        "update-no-release"
    );
    let mut beta = release("v2.0.0", serde_json::json!([]));
    beta.prerelease = true;
    assert_eq!(
        assess(&beta, v("1.0.0"), "windows", "x86_64").unwrap_err(),
        "update-no-release"
    );
    assert_eq!(
        assess(
            &release("nightly", serde_json::json!([])),
            v("1.0.0"),
            "windows",
            "x86_64"
        )
        .unwrap_err(),
        "update-release-invalid"
    );
    assert_eq!(
        assess(
            &release("v2.0.0", serde_json::json!([])),
            v("1.0.0"),
            "linux",
            "x86_64"
        )
        .unwrap_err(),
        "update-platform-unsupported"
    );
}

#[test]
fn a_release_page_outside_the_official_repository_is_not_linked() {
    let mut release = release("v1.0.0", serde_json::json!([]));
    release.html_url = Some("https://example.com/releases/v1.0.0".into());
    let (check, _) = assess(&release, v("1.0.0"), "windows", "x86_64").unwrap();
    assert_eq!(check.latest.unwrap().release_page, None);
}

#[test]
fn file_digests_are_lowercase_sha256() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("file");
    std::fs::write(&path, b"abc").unwrap();
    assert_eq!(
        hash_file(&path).unwrap(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        hash_file(&folder.path().join("missing")).unwrap_err(),
        "update-file-missing"
    );
}

#[cfg(windows)]
mod windows {
    use super::super::hash_file;
    use super::super::windows_swap::*;
    use std::path::Path;

    fn portable() -> (
        tempfile::TempDir,
        std::path::PathBuf,
        std::path::PathBuf,
        String,
    ) {
        let folder = tempfile::tempdir().unwrap();
        let exe = folder.path().join("GenX Streamer.exe");
        std::fs::write(&exe, b"old version").unwrap();
        std::fs::write(folder.path().join("tmg-portable.flag"), b"").unwrap();
        std::fs::create_dir(folder.path().join("data")).unwrap();
        std::fs::write(folder.path().join("data").join("library.sqlite"), b"saved").unwrap();
        let staged = folder.path().join("staged.exe");
        std::fs::write(&staged, b"new version").unwrap();
        let sha = hash_file(&staged).unwrap();
        (folder, exe, staged, sha)
    }

    #[test]
    fn the_new_exe_takes_the_old_ones_place_and_nothing_else_changes() {
        let (folder, exe, staged, sha) = portable();
        install(&staged, &exe, &sha, rename).unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"new version");
        assert_eq!(
            std::fs::read(folder.path().join("GenX Streamer.exe.old")).unwrap(),
            b"old version"
        );
        assert!(!folder.path().join("GenX Streamer.exe.new").exists());
        assert!(folder.path().join("tmg-portable.flag").exists());
        assert_eq!(
            std::fs::read(folder.path().join("data").join("library.sqlite")).unwrap(),
            b"saved"
        );
    }

    #[test]
    fn a_failed_swap_gives_the_old_exe_its_name_back() {
        let (folder, exe, staged, sha) = portable();
        let calls = std::cell::Cell::new(0);
        // The second rename (new → exe) fails, as when antivirus holds the new file.
        let flaky = |from: &Path, to: &Path| {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                Err(std::io::Error::other("held"))
            } else {
                std::fs::rename(from, to)
            }
        };
        assert_eq!(
            install(&staged, &exe, &sha, flaky).unwrap_err(),
            "update-install-failed"
        );
        assert_eq!(std::fs::read(&exe).unwrap(), b"old version");
        assert!(!folder.path().join("GenX Streamer.exe.old").exists());
        assert!(!folder.path().join("GenX Streamer.exe.new").exists());
    }

    #[test]
    fn a_running_exe_that_cannot_move_leaves_everything_as_it_was() {
        let (folder, exe, staged, sha) = portable();
        let refuse = |_: &Path, _: &Path| Err(std::io::Error::other("in use"));
        assert_eq!(
            install(&staged, &exe, &sha, refuse).unwrap_err(),
            "update-in-use"
        );
        assert_eq!(std::fs::read(&exe).unwrap(), b"old version");
        assert!(!folder.path().join("GenX Streamer.exe.new").exists());
    }

    #[test]
    fn a_changed_file_or_a_development_build_is_never_installed() {
        let (folder, exe, staged, _) = portable();
        assert_eq!(
            install(&staged, &exe, &"0".repeat(64), rename).unwrap_err(),
            "update-digest-mismatch"
        );
        assert_eq!(std::fs::read(&exe).unwrap(), b"old version");
        assert!(!folder.path().join("GenX Streamer.exe.new").exists());
        let dev = folder.path().join("tmg-tv.exe");
        std::fs::write(&dev, b"dev").unwrap();
        let sha = hash_file(&staged).unwrap();
        assert_eq!(
            install(&staged, &dev, &sha, rename).unwrap_err(),
            "update-development-build"
        );
    }

    #[test]
    fn a_relaunched_genx_knows_which_process_to_wait_for() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            waited_process(args(&["GenX Streamer.exe", "--genx-after-update", "4242"])),
            Some(4242)
        );
        assert_eq!(waited_process(args(&["GenX Streamer.exe"])), None);
        assert_eq!(
            waited_process(args(&["GenX Streamer.exe", "--genx-after-update", "x"])),
            None
        );
        assert_eq!(
            waited_process(args(&["GenX Streamer.exe", "--genx-after-update", "0"])),
            None
        );
        assert_eq!(waited_process(args(&["--genx-after-update", "7"])), None);
    }
}
