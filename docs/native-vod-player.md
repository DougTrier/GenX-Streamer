# Native on-demand player (Android): audio language and subtitles

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

Owner request, October 18, 2026: a Paid TV movie played in a foreign language with no way to change it, and no subtitles.

## Why the web player cannot do it

On the Google TV Streamer (WebView Chrome 155), checked read-only on October 18:

- `HTMLMediaElement.audioTracks` and `videoTracks` do not exist.
- A playing provider movie file reported 0 `textTracks`.

Provider movies and episodes are MKV/MP4 files whose languages and subtitles are embedded. Android WebView never exposes those tracks to the page. GenX's audio menu and CC button therefore work only for HLS, where hls.js manages the tracks itself.

## Decision

On Android, Paid TV movies and episodes play in Media3 (ExoPlayer) instead of the WebView. In this design, those are selections with `playMode: 'on-demand'` and an account VOD id (`vod:movie:…` or `vod:episode:…`). Live TV, Free TV, GenXtra and Windows keep the web player; nothing changes there.

Media3 reads MKV/MP4 directly and plays every embedded audio stream the TV can decode. It also lists embedded subtitles (SRT, SSA/ASS, VobSub, PGS where supported) and lets the viewer choose them.

### Same source, same safety

- **Source:** the native player opens the same loopback relay URL as the web player (`http://127.0.0.1:<port>/account/<capability>/media/<id>`). It never sees the provider address or the sign-in.
- **Validation:** the native command accepts only a loopback relay URL, checked in Rust and again in Kotlin.
- **Relay rules unchanged:** Host checking, authority every 2 s, the lease, revocation, Range support.

### Sharing the screen with GenX's web controls

The dock, the menus (audio, subtitles, quality), notices, the VOD titles and the full-screen controls are web content drawn above the picture.

- The Media3 `PlayerView` sits below the WebView, at the viewing area's rectangle in window pixels.
- While native playback runs, the WebView background is transparent.
- The page paints its background everywhere except a hole at the picture. The app background moves to an `#app::before` layer with a CSS mask, and the screen's own fill is cleared.
- Web content over the picture still draws opaque on top: menus, the player overlay, the full-screen dock, the VOD titles.
- The rectangle follows the viewing area: normal, Expand, full screen, and the Guide's picture at the top left. Whenever the picture is not shown, the native view is hidden.

### Playback contract

`NativeVodEngine` implements the existing `PlaybackEngine`:

- **Commands:** start, pause, resume, mute, volume, VOD position, duration and seek.
- **Audio:** audio tracks are published through the same per-video registry the audio menu already reads.
- **Subtitles:** subtitle tracks are published to the CC button, which becomes a language menu (Off plus each subtitle) whenever there are several to choose from.
- **Events:** progress, buffering, ended and failures reach the controller like the web engine's, so retries, deadlines, Stop and Back keep their behavior. The engine polls native status every 500 ms; Media3 state is never trusted beyond that reply.

### Lifecycle

- Generation guard: every command carries the engine's session number, and Kotlin ignores an older one.
- `dispose()` releases the player, removes the view and restores the WebView background. It runs on Stop, on another selection, on background suspension, and on exit.
- One player at a time. Closing GenX releases it.

## Not covered

- **Windows:** WebView2 has the same `audioTracks` limit. A separate check of WebView2's AudioVideoTracks feature is needed.
- **Live TV and HLS VOD:** they already have menus when the source lists tracks.
- **External subtitle files** from the provider: not offered by the Xtream API used here.
- **Codec support:** depends on the TV. DTS/TrueHD audio may be unsupported in hardware; that is reported as unsupported audio, never hidden.

## Evidence required before acceptance

- **Fixture tests:** routing (which titles go native), engine-to-controller events, the track menus, the hole masking, and command validation (Rust).
- **On the Streamer, once the owner allows the install:** a multi-language movie plays, its audio and subtitle lists match the file, switching works, and Stop, Back, full screen, Guide picture and VOD titles keep working.

## Live channels with MPEG-2 pictures (October 19, 2026)

Owner report: ACC Network on the Streamer showed only "Buffering…". Measured: the stream is MPEG-TS with MPEG-2 video (stream type 0x02) and MPEG audio (0x03). hls.js drops MPEG-2 video, so the sound played while 0 frames decoded. The Streamer, Sansui TV and Flip 2 all list hardware MPEG-2 decoders (`c2.mtk.mpeg2.decoder`, `c2.realtek.video.mpeg2.decoder`, `c2.qti.mpeg2.decoder`). Owner decision: hand these channels to the Android player; show a clear message on Windows.

- **Detection:** the native HLS loader shows each media segment to `transportVideoFormat` (src/playback/transport-video.ts) before hls.js parses it. A program map with MPEG-1/2 video and no H.264/HEVC reports `unsupported` with `nativeFormat: 'mpeg2'`.
- **Handover (Android):** the routing engine releases the web engine and starts `createNativeLiveEngine` with the same selection, once per attempt. Live selections only; on-demand videos and other failures are untouched.
- **Source and safety:** `native_live_open` starts the casting relay bound to loopback, admitting only this device. It applies the same destination policy (public upstreams only, plain HTTP only when the channel's source allows it, validated redirects and playlist rewriting). The page renews its 60-second lease every 20 s and closes it with the engine. The native command opens a live HLS address only when it is exactly the relay currently open (Rust), and only in the `/media/<64 hex>` loopback form (Kotlin). The movie relay rules are unchanged.
- **Player:** Media3 with `media3-exoplayer-hls` 1.10.1, MIME `application/x-mpegURL`. A live stream that falls behind its window rejoins the live edge.
- **Windows:** the overlay names it: "This channel's picture is MPEG-2. This player cannot show MPEG-2 video. The channel plays in GenX on Android TVs and phones, or choose another stream for it." (src/playback/failure-guidance.ts, from `nativeFormat`).
- **Limits:** Paid TV channels come from the loopback account relay, which this relay refuses as an upstream, so a Paid TV MPEG-2 channel shows the message instead. mpegts.js (direct `.ts` channels) does not use this detection.

### Sound: MPEG Layer II (resolved October 19, 2026)

ACC Network's sound is MPEG-1 Layer II, 48 kHz stereo, 96 kbit/s. Two separate faults kept it silent in Media3:

1. **No working decoder.** The Google TV Streamer (MediaTek) and Retroid Flip 2 (Qualcomm) have no Layer II decoder; the Sansui's `OMX.realtek.audio.decoder` accepts the sound but never outputs it. GenX now carries its own Layer I/II engine, [Trier MPEG](trier-mpeg.md) (`TrierMpegDecoder.kt`, through `TrierMpegRenderer.kt`), written from the standards (owner decision: GenX's own engineering, no third-party code). It is tried before the platform's; live channels also skip platform Layer I/II decoders. Its design, invariants and evidence are in its own document.
2. **Audio stamped 296 s early.** Every ACC segment carried audio timestamps about 296 s before its video, so Media3 never released sound to any decoder (the Sansui's hardware decoder waited the same way). The Android player's loopback relay now realigns audio that is more than 10 s from its video, once per session (`src-tauri/src/playback/ts_align.rs`, MA15). Ordinary streams are not touched.

MPEG-2 video still tries Android's software decoder first. The Realtek hardware decoder warned "Output format changed unexpectedly", and Realtek's software path decodes at about 45% of one core. GenX shows "This channel is playing without sound: this device cannot decode its audio format." only when a channel's sound has no decoder at all.
