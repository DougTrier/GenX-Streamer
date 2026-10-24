# GenX Streamer

A private IPTV player for Windows and Android (TVs, phones and handhelds), built
with Tauri: a shared TypeScript interface over a Rust native layer, with a
Kotlin/Media3 Android player for formats the WebView cannot show.

- Free TV: playlists and discovered sources, scanned and health-checked.
- Paid TV: provider accounts (Xtream), played through a local relay.
- GenXtra: public archive library with downloads.
- Program guide (XMLTV), favourites, voice search, remote/D-pad navigation,
  casting (Chromecast/DLNA) and optional encrypted LAN sharing.

User help: [docs/user-guide.md](docs/user-guide.md).
Design and requirements: [Engineering Spec.MD](Engineering%20Spec.MD). Its
companion documents (invariant registers, metrics, the old task ledger) stay in
the private project archive and are not part of this repository.
Open work: [TASKS.md](TASKS.md).

## Provenance

GenX Streamer includes two decoders of its own, for formats that some devices
offer apps no decoder for (for example Samsung Galaxy phones and MPEG-2 video):

- **Trier MPEG Video** decodes MPEG-2 video (Main Profile, 4:2:0). It was
  written from the published standard, ITU-T H.262 | ISO/IEC 13818-2. Its
  variable-length code tables are extracted from the text of the free ITU-T
  edition by `scripts/trier-video/extract_tables.py`, not retyped from other
  software. Design and measurements: [docs/trier-mpeg-video.md](docs/trier-mpeg-video.md).
- **Trier MPEG** decodes MPEG audio Layers I and II. It was written from
  ISO/IEC 11172-3 and the lower-sampling-frequency extension in ISO/IEC 13818-3.
  Design: [docs/trier-mpeg.md](docs/trier-mpeg.md).

Neither decoder contains code from FFmpeg, libmpeg2 or any other decoder, and
the Windows and Android apps do not include or link FFmpeg. During development,
FFmpeg (the `ffmpeg-static` development dependency) and libmpeg2 serve only as
outside measuring tools: FFmpeg encodes the test streams, and both decode the
same streams so Trier's pictures can be compared with an established decoder.
Trier's output is not bit-identical to FFmpeg's (in the recorded comparison it
matched exactly in 1 of 12 streams), as expected of an independent
implementation; MPEG-2 defines an accuracy bound for the inverse DCT, not one
exact result. Tests that need FFmpeg skip themselves when it is not installed.

Other formats (H.264, HEVC, AAC and the rest) are decoded by the platform:
Android's Media3/MediaCodec and the system WebView.

## Requirements

- Node.js 22 or newer, npm
- Rust (stable) with the `aarch64-linux-android` and `armv7-linux-androideabi`
  targets for Android builds
- Windows: Microsoft Edge WebView2 Runtime (the app does not install it)
- Android builds: Android SDK, NDK 28.2.13676358 and a JDK (Android Studio's
  `jbr` works). The build script uses `ANDROID_HOME` if set.
- Python 3.11 or newer for the license inventory tooling

## Build

```powershell
npm ci
pwsh -NoProfile -File scripts/build-windows.ps1 -Profile Release
pwsh -NoProfile -File src-tauri/scripts/build-android.ps1 -Architecture aarch64 -Optimization 2
pwsh -NoProfile -File src-tauri/scripts/build-android.ps1 -Architecture armv7 -Optimization 2
```

The Windows build writes `src-tauri/target/release/GenX Streamer.exe`. Android
builds are debug-signed development APKs; a release APK needs a release key
(see TASKS.md). Use `-Optimization 2` for anything installed on a device.

## Test

```powershell
npx vitest run                         # unit and browser-component tests
npx playwright test tests/ui           # interface tests
cd src-tauri; cargo test --lib         # native tests
node --test tests/tooling/*.test.mjs   # tooling tests
python -B -X utf8 -m unittest discover -s tests/tooling
```

Packaged acceptance runs (Windows, isolated data folders, owned fixtures):

```powershell
node scripts/native-smoke.mjs "src-tauri/target/release/GenX Streamer.exe"
node tests/native/playback-fault-matrix.mjs --exe=<absolute exe> --sha256=<sha256>
node tests/native/channel-switch-smoke.mjs <exe> 500 <sha256>
```

Device checks need an approved device in the environment:
`GENX_APPROVED_FLIP_SERIAL`, `GENX_APPROVED_TV_SERIAL`, and `ADB` for the adb
path. Without them the device scripts refuse to run.

## Release

```powershell
node scripts/release-notices.mjs --inventory <inventory.json> --crates <crate list> --product "GenX Streamer for Windows" --output <new file>
node scripts/package-candidate.mjs --windows-exe <exe> --output-dir <new folder> --windows-profile release --mode windows-only --notices <notices> --source-revision <commit>
pwsh -NoProfile -File scripts/windows-sandbox-launch-check.ps1 -Zip <zip> -Out <new folder>
```

The Windows build is distributed unsigned by decision; Windows SmartScreen may
show an unknown-publisher prompt on first run.

## Privacy

Before publishing or copying this repository anywhere, run:

```powershell
node scripts/clean-repo.mjs scan
```

It blocks credentials, keys, databases, user-profile paths and private network
addresses. Your own device serials, addresses and paths belong in an untracked
`.private-patterns.json` (already in `.gitignore`); reviewed test placeholders
are listed by fingerprint in `scripts/clean-repo-allow.json`.

## License

GenX Streamer's source code is licensed under the
[Apache License 2.0](LICENSE). Copyright 2026 Doug Trier. See [NOTICE](NOTICE)
for the third-party components and their licenses.

The GenX Streamer name, logo and brand artwork are not covered by the Apache
License: a fork you publish should use its own name and icons. See
[TRADEMARK.md](TRADEMARK.md).
