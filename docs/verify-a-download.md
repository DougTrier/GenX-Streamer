# Checking that a copy of GenX Streamer is genuine

GenX Streamer spreads from person to person (Pass It Along), so anyone who
receives a copy can check it against the official release.

## The release files

Every GitHub release of GenX Streamer carries these files, named with the
version and platform, and a `SHA256SUMS` file listing the SHA-256 checksum of
each (written by `scripts/package-candidate.mjs`):

| File | What it is |
| --- | --- |
| `GenX-Streamer-<version>-Windows-x64-portable.zip` | The portable Windows app: GenX Streamer.exe, `tmg-portable.flag` (keeps data beside the exe), a README and the dependency notices. Extract all of it into one folder. |
| `GenX-Streamer-<version>-Windows-x64.exe` | The same exe on its own (what **Check for updates** installs). |
| `GenX-Streamer-<version>-Android-arm64.apk` | The Android app (ARM64). |
| `SHA256SUMS` | One line per file: `<sha256>  <file name>`. |

The release page is https://github.com/DougTrier/GenX-Streamer/releases/latest
(private until the owner publishes the repository).

## Comparing a file

Compute the file's SHA-256 and compare it with its line in `SHA256SUMS` from
the release page. Every character must match.

- **Windows** (PowerShell): `Get-FileHash .\GenX-Streamer-1.0.0-Windows-x64-portable.zip -Algorithm SHA256`
- **macOS**: `shasum -a 256 GenX-Streamer-1.0.0-Android-arm64.apk`
- **Linux**: `sha256sum GenX-Streamer-1.0.0-Android-arm64.apk`
- **A running copy**: Settings → About GenX Streamer → **This copy** →
  **Show checksum** shows the SHA-256 of the app's own file (the installed APK,
  or the running exe), to compare with `SHA256SUMS`.

An APK received phone to phone is the sender's installed APK, byte for byte,
so its checksum matches the release's APK when the sender has an official
copy.

## Android: the signing certificate

GenX checks its own signing certificate inside the app; About does not show
it (the owner's decision, October 24, 2026). **This copy** says only the
version and **Release build**, **Unofficial build** (release-built but not
signed with the GenX Streamer release key) or **Development build**. Android
itself refuses to install an update signed by anyone else over an installed
copy. To see the certificate of a downloaded APK yourself, use Android's
`apksigner verify --print-certs GenX-Streamer-<version>-Android.apk` and
compare its SHA-256 with the fingerprint below.

Only an official release copy sends its own APK (Send the app, Share with
everyone nearby). Development copies, which are debug-signed, offer the link
and the QR code instead. The release certificate's fingerprint is one constant,
`RELEASE_CERTIFICATE_SHA256` in `src-tauri/src/platform/app_identity.rs`:
`464c42785a80bb27022527d7e5b703c4ecf2d62f433a0f9f6b162ee95b7872ff`, the
owner's release key, created October 24, 2026
([release-signing.md](release-signing.md)). `apksigner` prints it with colons:
`46:4C:42:78:…:72:FF`.

## Windows: unsigned by decision

GenX Streamer for Windows is not code-signed (the owner's decision). The
checksum above is the only check. Windows SmartScreen will still warn that the
publisher is unknown, even for a genuine copy: choose **More info**, then
**Run anyway**, after comparing the checksum.

## Nothing installs on its own

GenX never installs anything silently. On Android, every install (an update
from Check for updates, an app a website offers, or a file a friend sends) goes
through Android's own installer, which asks first. The
`REQUEST_INSTALL_PACKAGES` permission GenX declares (for the website-APK
feature, W16) only lets GenX open that installer; it cannot install anything
by itself.
