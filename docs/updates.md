# Voluntary updates

The viewer owns GenX Streamer and decides when it changes (owner, October 24,
2026). **About GenX Streamer → About the Author → Updates** has one button,
**Check for updates**, and one promise beneath it: *Updates are always
optional. GenX Streamer will never update without your permission.*

There are no background checks, no notifications and no polling: GitHub is
contacted only when the button is chosen. An automatic check, if ever wanted,
would be a separate opt-in setting.

## What happens

1. **Check for updates** reads the official repository's latest release
   (`https://api.github.com/repos/DougTrier/GenX-Streamer/releases/latest`).
2. GenX compares its installed version with the release's tag (`v1.1.0` or
   `1.1.0`; three numbers). If it is newer, the viewer sees **Update
   available**, both versions, and **What's new** (the release notes, shown as
   plain text), with **Download update** and **Not now**.
3. **Download update** fetches this device's file of that release into GenX's
   cache, then checks it (see Verification). Nothing is installed.
4. **Install update** checks the file once more and then:
   - **Windows**: puts the new GenX Streamer.exe in place (below) and offers
     **Restart now** or **Later**. The new version starts after an ordinary
     exit if the viewer chose Restart, or the next time GenX is opened.
   - **Android**: opens Android's own installer, which asks the viewer before
     installing. Android keeps the app's data across the update.

Each step is a separate choice; **Not now** at any point changes nothing.

## Invariants

| ID | Invariant | How |
| --- | --- | --- |
| UP-001 | Updates are never mandatory. | Nothing in GenX depends on a check; there is no expiry or nag. |
| UP-002 | No update downloads without explicit approval. | Only **Download update** calls `update_download`. |
| UP-003 | No installation without explicit approval. | Only **Install update** calls `update_install`; Android's installer asks again; Windows restarts only on **Restart now**. |
| UP-004 | Only official GitHub releases are accepted. | The fixed API address; no drafts or prereleases; the file must be at `https://github.com/DougTrier/GenX-Streamer/releases/download/<tag>/<file>`, redirects only to GitHub's file hosts over https. The interface cannot name an address. |
| UP-005 | Integrity and authenticity are verified before installation. | Size and SHA-256 must match what GitHub publishes for the file (its `digest`); checked after download and again before install. Android: the APK must be this app (`com.tmg.tv`), newer, and signed with exactly this copy's certificates. |
| UP-006 | The right platform and architecture. | The file is chosen by name for the running build (below). |
| UP-007 | A failed update leaves the app working. | Windows keeps the old exe until the new one is in place and puts it back if a step fails; Android's installer replaces the app only when it succeeds. |
| UP-008 | Settings, accounts, playlists, favorites and history survive. | Windows replaces only GenX Streamer.exe (never the data folder or `tmg-portable.flag`); Android updates in place with the same signature. |
| UP-009 | Older versions keep running. | No expiry date anywhere. |
| UP-010 | Offline operation stays available. | A failed check says GitHub could not be reached; nothing else changes. |

## Release files

A release must carry these files (names are exact; `<version>` is the tag
without its `v`):

| Device | File |
| --- | --- |
| Windows x64 (portable) | `GenX-Streamer-<version>-Windows-x64.exe` (the bare exe, beside `GenX-Streamer-<version>-Windows-x64-portable.zip` for new installs) |
| Android ARM64 | `GenX-Streamer-<version>-Android-arm64.apk` |
| Android ARMv7 | `GenX-Streamer-<version>-Android-armv7.apk` |

The build's own architecture (`std::env::consts`) picks the file. GitHub
computes each file's SHA-256 digest when it is uploaded; GenX refuses a file
without one. `scripts/package-candidate.mjs` writes these names (ARM64 for
Android so far) and `SHA256SUMS`; see
[verify-a-download.md](verify-a-download.md).

## Verification

- **Integrity**: the downloaded size equals the declared size and its SHA-256
  equals GitHub's published digest; a mismatch deletes the file.
- **Authenticity**: the release comes from the official repository over
  https. On Android the APK must also be signed with the installed copy's
  certificates. GenX ships unsigned on Windows (owner's decision), so on
  Windows authenticity rests on the official repository and its digest.
- **Signatures on Android**: development APKs are debug-signed. A
  release-signed update cannot install over a debug-signed copy (or the other
  way round): GenX says so instead of offering it, and that copy must be
  uninstalled first (back up channels first). The release key is the owner's.

## Windows: replacing a running exe

A running exe cannot be overwritten, but it can be renamed
(`src-tauri/src/platform/app_update/windows_swap.rs`):

1. The verified file is copied beside the app as `GenX Streamer.exe.new` and
   checked again.
2. The running `GenX Streamer.exe` is renamed `GenX Streamer.exe.old`.
3. `GenX Streamer.exe.new` becomes `GenX Streamer.exe`. If this fails, the old
   exe gets its name back.
4. **Restart now** runs the ordinary exit (Settings → Exit app); when it has
   finished, the new exe starts with `--genx-after-update <pid>` and waits for
   the old process to end before opening the saved data.
5. The next start removes `GenX Streamer.exe.old`.

Development builds (any other exe name) are never replaced. A folder GenX
cannot write to is reported before anything moves.

## While the repository is private

GitHub answers 404 for a private repository's releases (checked October 24,
2026), so until the owner publishes it, **Check for updates** says no public
release was found.

## Code and tests

| Layer | Where |
| --- | --- |
| Interface | `src/ui/settings/about-update.ts`, `src/platform/app-update.ts` |
| Native | `src-tauri/src/platform/app_update.rs`, `app_update/windows_swap.rs`; `lifecycle.rs` starts the new version after an ordinary exit |
| Android | `AppUpdatePlugin.kt` (`UpdateRules`) |

```powershell
npx playwright test app-update about
cd src-tauri; cargo test --lib app_update
```

Android: `UpdateRulesTest.kt`. Downloading a real release and installing it
need a published release and a device.
