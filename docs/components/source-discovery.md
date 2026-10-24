# Source Discovery

Finding channels to add. Scans of playlists and station websites, the online
source search, the network checks that decide whether a stream really plays,
scans that pause and resume (checkpoints and candidate manifests), the slow
pass, imports and refreshing saved sources.

## Where the code is

| Layer | Where |
| --- | --- |
| Domain (TypeScript) | `src/discovery/` (the scan pipeline, candidates, health checks, the provider registry, selection sessions, scan checkpoints), `src/sources/` (saved sources and the media checks run before a source is trusted) |
| Application | `src/application/discovery/` (`scan-controller.ts` and its parts: the scan screen's wiring, publication, bounded resume; imports; refresh; the source finder) |
| Screens | `src/ui/scan/` (`source-scan.ts`, the scan screen, with its parts `source-scan-runs.ts`, `source-scan-checks.ts`, `source-scan-automatic.ts`, `source-scan-model.ts`; the inline scan panel, import entry, website discovery, local streams) |
| Native wrappers | `src/platform/scan-*.ts`, `bounded-scan-resume.ts`, `source-*.ts`, `playlist-file.ts`, `local-streams.ts` |
| Native (Rust) | `src-tauri/src/discovery/` (scan batches, windows, checkpoints, candidate manifests, resume, `network_media_probe.rs` for stream checks, the source directory) |
| Android | `ScanManifest*.kt`, `AndroidScanManifestKeys.kt`, `ManifestCryptoWorker.kt`, `DiscoveryLease.kt` |

## Start here

- `src/discovery/scan.ts` and `pipeline.ts`: what a scan does, step by step.
- `src/application/discovery/scan-controller.ts`: how the app runs a scan and
  publishes what it found.
- `src-tauri/src/discovery/network_media_probe.rs`: how a stream is checked.
- `src-tauri/src/discovery/scan_checkpoint.rs`: what a saved scan contains.

## Rules it keeps

Scans only publish channels that answered; a resumed scan never repeats or
loses work; the slow pass and automatic checks are bounded. See
[metric-requirements.md](../metric-requirements.md),
[daily-source-refresh.md](../daily-source-refresh.md) and the reviewed
provider list in [research-reviewed-providers.json](../research-reviewed-providers.json).

## Tests

```powershell
npx vitest run tests/discovery tests/sources
npx playwright test scan source-scan-integration website-discovery inline-discovery online-magnifier file-review
cd src-tauri; cargo test --lib discovery::
```
