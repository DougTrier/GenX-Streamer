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
commands are registered in `src-tauri/src/lib.rs` (`generate_handler!`); they live
in `src-tauri/src/commands/` and in the component modules.

## Components

The code is organized by the components below; each has a guide in
[docs/components/](docs/components/README.md) with its folders in every layer,
where to start reading, its rules and its test commands.

| Component | Interface (`src/`) | Native (`src-tauri/src/`) |
| --- | --- | --- |
| [Channel Catalog](docs/components/channel-catalog.md) | `catalog/`, `search/`, `location/`, `preferences/`, `application/catalog/`, `application/health/`, `ui/channels/` | `catalog/`, `database/` |
| [Source Discovery](docs/components/source-discovery.md) | `discovery/`, `sources/`, `application/discovery/`, `ui/scan/` | `discovery/` |
| [Playback Engine](docs/components/playback-engine.md) | `playback/`, `application/playback/`, `ui/player/`, `platform/browser-engine*.ts` | `playback/` |
| [Trier MPEG](docs/components/trier-mpeg.md) | — | `trier_video/` |
| [GenXtra](docs/components/genxtra.md) | `application/genxtra/`, `ui/genxtra/`, `platform/archive-*.ts` | `genxtra/` |
| [Program Guide (EPG)](docs/components/program-guide.md) | `guide/`, `application/guide/`, `ui/guide/` | `guide/` |
| [Browser](docs/components/browser.md) | — | `browser/` (and `src-tauri/page-scripts/`) |
| [Paid TV accounts](docs/components/paid-tv-accounts.md) | `application/accounts/`, `ui/accounts/`, `platform/account-*.ts` | `accounts/` |
| [LAN sharing and casting](docs/components/sharing-and-casting.md) | `sharing/`, `casting/`, `application/sharing/` | `sharing/` |
| [Platform adapters](docs/components/platform-adapters.md) | `platform/`, `diagnostics/` | `lib.rs`, `commands/`, `lifecycle.rs`, `platform/` |
| [UI components](docs/components/ui-components.md) | `main.ts`, `application/shell/`, `ui/` | — |

## Interface: `src/`

| Folder | Owns |
| --- | --- |
| `main.ts` | The composition root: builds the shared application context (`app`, one line per shared value) and creates every area in start-up order. |
| `application/<component>/` | The application's areas, grouped by component. Each area is a factory, `createX(app)` or `installX(app)`, that declares in its own environment type the part of the shared context it uses: for example `discovery/scan-controller.ts` (channel scans), `guide/guide-controller.ts` (automatic program guide), `discovery/import-controller.ts` (adding and refreshing channels), `health/channel-health-controller.ts` (saved-channel checks), `playback/player-view.ts` (the picture panel and transport), `shell/startup.ts` and `shell/close-controller.ts`. |
| `catalog/` | The channel catalog model, M3U playlist parsing (in a worker, page by page) and validation. |
| `discovery/` | Finding channels: online source search, the scan pipeline, health checks, the reviewed provider registry. |
| `sources/` | Saved sources and the media checks run before a source is trusted. |
| `playback/` | The player controller (one session at a time), its engines, the adaptive live buffer, start timing. |
| `guide/` | The program guide: building it from XMLTV, matching listings to channels, timeline data. |
| `search/` | Channel and program search, category aliases, voice search. |
| `location/` | Countries, regions and their order. |
| `casting/` | Chromecast and DLNA casting, as seen from the interface. |
| `sharing/` | LAN viewing and phone pairing, as seen from the interface. |
| `data-transfer/` | Backups, exports and imports (in a worker). |
| `preferences/` | The settings model and its validation. |
| `platform/` | Typed wrappers around native commands, one file per native area. |
| `diagnostics/` | The redacted event history. |
| `ui/<screen>/` | Screens and components (plain DOM, no framework), one folder per screen or area: `shell/` (the static layout `shell.ts`, `remote-navigation.ts` the D-pad and keyboard focus engine), `scan/`, `guide/`, `genxtra/`, `accounts/`, `player/`, `channels/`, `settings/`. |
| `ui/*.css` | The stylesheets, imported by `main.ts` in cascade order; `dialog-polish.css` is the shared pop-up look. |

## Native layer: `src-tauri/src/`

| Folder or file | Owns |
| --- | --- |
| `lib.rs` | Tauri set-up (`run`), the shared native state and the list of registered commands (`generate_handler!`). It re-exports every component module under its own name, so code refers to them as `crate::<module>`. |
| `commands/` | The commands the interface calls, one file per area: `accounts`, `archive`, `casting`, `scan`, `sources`, `storage`, `viewing`. Most delegate to the component modules. |
| `lifecycle.rs` | Orderly exit: the close attempt, draining owned work, shutdown and the exit commands. |
| `accounts/` | Paid TV (Xtream-style) accounts: the credential vault, catalog, guide, video on demand and the playback proxy. |
| `genxtra/` | GenXtra, the public archive library: providers (Internet Archive, Library of Congress, NASA, Wikimedia Commons), catalog, downloads, playback proxy. |
| `catalog/` | Catalog queries and projections, groups, logos, favorites, channel health. |
| `database/` | SQLite storage: transactions (`PairStore`), backups, recovery, leases, budgets, start-up checks. |
| `discovery/` | Channel scans: batches, windows, checkpoints and resumable manifests, stream checks, the source directory. |
| `guide/` | XMLTV parsing, the guide database, channel matching (crosswalk), refresh, the guide commands. |
| `playback/` | The Android native players, transport-stream audio alignment, viewing settings, keeping the screen awake. |
| `sharing/` | `lan/` the LAN viewing server and its viewer page, `casting/` Chromecast and DLNA, `relay.rs` the public-only media relay, `sharing_policy.rs`, `share_links` share links ([design](docs/share-links.md)). |
| `browser/` | The in-app player for station websites (`web_page.rs`, with `../page-scripts/`) and the fixed support pages. |
| `platform/` | Close and shutdown owners, device capabilities, speech, VPN status, renderer recovery, diagnostics, start-up milestones, the request registry. |
| `trier_video/` | Trier MPEG Video, GenX's own MPEG-2 video decoder ([design](docs/trier-mpeg-video.md)). |

A large module keeps its file and puts its parts in a folder of the same name
(`database/storage_transaction.rs` and `database/storage_transaction/*.rs`),
each starting with `use super::*;`. Tests sit next to the code: larger suites
in `<module>_tests.rs` files attached with
`#[cfg(test)] #[path = "<module>_tests.rs"] mod tests;` (the largest split by
topic into a `tests/` folder beside the module), small ones in an inline
`mod tests` block at the end of the file.
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
| `SharePlugin.kt` | Share links: links that open GenX, the share sheet, sending the installed APK ([design](docs/share-links.md)). |

## File size

Files stay at about 800 lines, with 1,000 as the ceiling, so that each can be
read and changed without tools. [CONTRIBUTING.md](CONTRIBUTING.md) shows how
the large ones were split, for when another one grows.

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
| `tests/<area>/` | Unit and component tests (Vitest), many in a real browser. A large suite keeps its shared setup in a `*.fixture.ts` module and its tests in topic files. |
| `tests/ui/` | Interface tests (Playwright) against the real application source. |
| `tests/native/` | Acceptance runs against a packaged Windows build, with isolated data folders and owned fixtures. |
| `tests/tooling/` | Tests of the build, release and verification scripts (Node and Python). |
| `src-tauri/src/**` | Native unit tests (`cargo test --lib`). |
| `src-tauri/gen/android/app/src/test/` | Android unit tests (Gradle). |

`npm run verify` runs the development checks in order (types, format, lint,
unit, interface, privacy scan, Rust format and lint, native tests, tooling)
and writes a receipt under `artifacts/development-verification/`.
