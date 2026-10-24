# Platform adapters

What differs between Windows and Android, kept out of the rest of the app:
start-up and orderly exit, the Back key and TV focus, device capabilities,
voice search, the VPN indicator, WebView renderer recovery, diagnostics and
the redacted event history, and the typed calls from the interface to the
native layer.

## Where the code is

| Layer | Where |
| --- | --- |
| Interface (TypeScript) | `src/platform/` (one typed wrapper per native area; `owned-native-command.ts` is the shared call path), `src/diagnostics/` (events) |
| Native (Rust) | `src-tauri/src/lib.rs` (set-up and the registered commands), `commands/` (the commands the interface calls, one file per area), `lifecycle.rs` (exit), `platform/` (close and shutdown owners, device capabilities, speech, VPN status, renderer recovery, start-up milestones, the request registry) |
| Android | `MainActivity.kt`, `BackOwnership.kt`, `TelevisionCapability.kt`, `TelevisionShellFocusOwner.kt`, `NativeSpeech.kt`, `SpeechOwnership.kt`, `RendererRecovery*.kt`, `RendererRelaunchActivity.kt`, `ActivityTaskFinish.kt`, `VpnStatusPlugin.kt` |

## Start here

- `src-tauri/src/lib.rs`: `run()` and the list of commands.
- `src-tauri/src/lifecycle.rs`: what happens when the app closes.
- `src/platform/owned-native-command.ts`: how the interface calls a command.

## Rules it keeps

LX01–LX12 in [lifecycle-media-invariants.md](../lifecycle-media-invariants.md);
the VPN indicator in [vpn-indicator.md](../vpn-indicator.md); the event
history in [event-history.md](../event-history.md). Diagnostics are always
redacted.

## Tests

```powershell
npx vitest run tests/platform tests/diagnostics
npx playwright test bootstrap-failure exit-support storage-recovery
cd src-tauri; cargo test --lib platform::
```

Packaged acceptance runs of the Windows build are in `tests/native/` (see the
README); Android unit tests are under `src-tauri/gen/android/app/src/test/`.
