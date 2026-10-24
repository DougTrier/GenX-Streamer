# Playback Engine

Playing what the viewer chose: one playback session at a time, the engine
that fits the stream (hls.js, mpegts.js, the browser's own player, or a native
player on Android), the adaptive live buffer, start timing, recovery when a
stream drops, instant replay, audio tracks, captions and quality.

## Where the code is

| Layer | Where |
| --- | --- |
| Domain (TypeScript) | `src/playback/` (`controller.ts`, the `PlaybackController`, built on `controller-core.ts`; engines, the adaptive buffer, failure guidance, start timing, keeping the screen awake) |
| Browser engine | `src/platform/browser-engine.ts` and `browser-engine-start.ts` (hls.js, mpegts.js and direct media in the WebView) |
| Application | `src/application/playback/` (the player's set-up, controls, the picture panel, media keys, playback health) |
| Screens | `src/ui/player/` (audio tracks, captions, quality, full screen, live replay, the VOD dock and stop button, casting button) |
| Native (Rust) | `src-tauri/src/playback/` (the Android native live and on-demand players, transport-stream audio alignment, viewing settings, the screen-awake owner) |
| Android | `NativeVideoPlugin.kt` (Media3), `ViewingPlugin.kt`, `ViewingLifecycleOwner.kt`, `ViewingWakePolicy.kt` |

## Start here

- `src/playback/controller.ts`: start, events, pause, resume, seek and stop.
- `src/platform/browser-engine-start.ts`: how a stream is attached in the
  WebView and watched until the picture starts.
- [native-vod-player.md](../native-vod-player.md): when Android plays natively.

## Rules it keeps

P01–P09 (one session per device, ownership, deadlines, truthful state) in
[streaming-invariants.md](../streaming-invariants.md); LX01–LX12 and
MP01–MP08 in [lifecycle-media-invariants.md](../lifecycle-media-invariants.md);
RP01–RP08 in [instant-replay.md](../instant-replay.md).

## Tests

```powershell
npx vitest run tests/playback
npx playwright test live-replay picture-states seek-busy-focus sound-instant vod-cinema background-pause
cd src-tauri; cargo test --lib playback::
```

Packaged checks of the real Windows build: `tests/native/playback-fault-matrix.mjs`
and `tests/native/channel-switch-smoke.mjs` (see the README).
