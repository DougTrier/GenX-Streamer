# GenX Streamer architecture

A map for developers: what runs where, which folder owns what, and the rules
the code follows. Build and test commands are in the [README](README.md); the
product requirements are in [Engineering Spec.MD](Engineering%20Spec.MD).

## The three layers

```
┌───────────────────────────────────────────────────────────────┐
│ Interface (TypeScript, src/)                                  │
│ Runs in the system WebView: WebView2 on Windows, Android      │
│ System WebView on Android. One code base for every device.    │
└──────────────────────┬────────────────────────────────────────┘
                       │ Tauri commands (invoke), events
┌──────────────────────▼────────────────────────────────────────┐
│ Native layer (Rust, src-tauri/src/)                           │
│ Storage (SQLite), network policy, local media relay, scans,   │
│ program guide database, casting, LAN sharing, Trier MPEG Video│
└──────────────────────┬────────────────────────────────────────┘
                       │ Tauri mobile plugins (Android only)
┌──────────────────────▼────────────────────────────────────────┐
│ Android (Kotlin, src-tauri/gen/android/app/src/main/java/     │
│ com/tmg/tv/): Media3 player, Trier decoder bridges, station    │
│ web pages, speech, TV focus and lifecycle                      │
└───────────────────────────────────────────────────────────────┘
```

The interface never talks to the network or disk directly for app data: it
calls typed wrappers in `src/platform/`, which call native commands. About 200
commands are registered in `src-tauri/src/lib.rs` (`generate_handler!`).

## Interface: `src/`

| Folder | Owns |
| --- | --- |
| `main.ts` | The composition root: creates the long-lived owners and connects them to the interface. |
| `application/` | Workflows that span several areas: scans and their resume, imports, account browsing, guide capture, start-up recovery. |
| `catalog/` | The channel catalog model, M3U playlist parsing (in a worker, page by page) and validation. |
| `discovery/` | Finding channels: online source search, the scan pipeline, health checks, the reviewed provider registry. |
| `sources/` | Saved sources and the media checks run before a source is trusted. |
| `playback/` | The player controller (one session at a time), HLS through hls.js, the adaptive live buffer, start timing. |
| `guide/` | The program guide: building it from XMLTV, matching listings to channels, timeline data. |
| `search/` | Channel and program search, category aliases, voice search. |
| `location/` | Countries, regions and their order. |
| `casting/` | Chromecast and DLNA casting, as seen from the interface. |
| `sharing/` | LAN viewing and phone pairing, as seen from the interface. |
| `data-transfer/` | Backups, exports and imports (in a worker). |
| `preferences/` | The settings model and its validation. |
| `platform/` | Typed wrappers around native commands, one file per native area. |
| `diagnostics/` | The redacted event history. |
| `ui/` | Screens and components (plain DOM, no framework) and their stylesheets. `shell.ts` is the static layout, `remote-navigation.ts` the D-pad and keyboard focus engine, `dialog-polish.css` the shared pop-up look. |

## Native layer: `src-tauri/src/`

Most modules are flat files named by area prefix:

| Prefix or folder | Owns |
| --- | --- |
| `lib.rs` | Tauri set-up, shared native state, command registration, shutdown. |
| `account_*` | Paid TV (Xtream-style) accounts: the credential vault, catalog, guide, video on demand and the playback relay. |
| `archive_*` | GenXtra, the public archive library: providers (Internet Archive, Library of Congress, NASA, Wikimedia Commons), catalog, downloads, playback proxy. |
| `catalog_*`, `channel_*` | Catalog queries, projections, deltas, groups, categories, logos and channel checks. |
| `scan_*` | Channel scans: batches, checkpoints and resumable manifests. |
| `source_snapshot*` | Atomic activation of refreshed source data. |
| `storage*` | SQLite storage: transactions, backups, recovery, leases, budgets. |
| `guide/` | XMLTV parsing, the guide database, channel matching (crosswalk), refresh. |
| `casting/` | Chromecast and DLNA: discovery, protocols, the receiver relay. |
| `lan/` | The LAN viewing server and its viewer page. |
| `relay.rs`, `network*.rs`, `requests.rs` | The local media relay and network policy (every destination is validated). |
| `native_*` | Native playback, speech, sharing, guide and shutdown commands. |
| `trier_video/` | Trier MPEG Video, GenX's own MPEG-2 video decoder ([design](docs/trier-mpeg-video.md)). |
| `web_page.rs`, `../page-scripts/` | The in-app player for station websites. |
| `close_owner.rs`, `renderer_*` | Orderly exit and WebView renderer recovery. |

Tests sit next to the code as `*_tests.rs` files or `mod tests` blocks.
`src-tauri/vendor/tao` is a vendored copy of the tao window library with
GenX's patches listed in its `GENX-PATCHES.md`.

## Android: `src-tauri/gen/android/app/src/main/java/com/tmg/tv/`

| File | Owns |
| --- | --- |
| `MainActivity.kt` | The single activity, TV and phone start-up. |
| `NativeVideoPlugin.kt` | The Media3 (ExoPlayer) player for formats the WebView cannot show. |
| `TrierMpegVideo.kt`, `TrierMpegDecoder.kt`, `TrierMpegRenderer.kt`, `TrierAutoTune.kt` | Bridges to GenX's own decoders: Trier MPEG Video (in Rust) and Trier MPEG audio ([design](docs/trier-mpeg.md)). |
| `WebPagePlugin.kt`, `WebPageService.kt`, `PageController.kt` | Station web pages in an isolated WebView. |
| `ViewingPlugin.kt`, `ViewingLifecycleOwner.kt`, `ViewingWakePolicy.kt` | Screen-on, lifecycle and support links. |
| `NativeSpeech.kt` | Voice search. |
| `TelevisionCapability.kt`, `TelevisionShellFocusOwner.kt`, `BackOwnership.kt` | TV detection, remote focus and the Back key. |

## Rules the code follows

- **One owner per resource.** Each session owns its engine, listeners, timers,
  requests and clean-up; clean-up is safe to call twice.
- **Stale results never land.** Every asynchronous result carries a
  generation or revision and is dropped if the world moved on.
- **Storage is atomic.** A refresh, import or migration either commits whole
  or leaves the previous valid state.
- **Outside data is untrusted.** Playlist names, logos, guide text and web
  pages are rendered as text, never as markup; network destinations are
  validated before any request.
- **Errors are truthful.** Failures show an actionable message; diagnostics
  are redacted (no credentials or private addresses).
- **No FFmpeg in the apps.** Media is decoded by the platform or by GenX's own
  decoders (see the README's Provenance section).

## Requirement codes in comments

Comments cite requirement and invariant codes such as `P09`, `LX06` or `W16`.
[docs/codes.md](docs/codes.md) says what each family means and which document
defines it.

## Names from the earlier app

The Rust crate is `tmg-tv` (library `tmg_tv_lib`), the Android application ID
is `com.tmg.tv`, and the Windows build first produces `tmg-tv.exe`, which the
build script copies to `GenX Streamer.exe`. These names come from GenX's
predecessor, TMG Mobile Stream. The Android ID must stay: changing it would
stop installed copies from updating.

## Tests

| Where | What |
| --- | --- |
| `tests/<area>/` | Unit and component tests (Vitest), many in a real browser. |
| `tests/ui/` | Interface tests (Playwright) against the real application source. |
| `tests/native/` | Acceptance runs against a packaged Windows build, with isolated data folders and owned fixtures. |
| `tests/tooling/` | Tests of the build, release and verification scripts (Node and Python). |
| `src-tauri/src/**` | Native unit tests (`cargo test --lib`). |
| `src-tauri/gen/android/app/src/test/` | Android unit tests (Gradle). |

`npm run verify` runs the development checks in order (types, format, lint,
unit, interface, privacy scan, Rust format and lint, native tests, tooling)
and writes a receipt under `artifacts/development-verification/`.
