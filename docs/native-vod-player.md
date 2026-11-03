# Native on-demand player (Android): audio language and subtitles

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

**Release status:** 0.1.25 / build 1025 has been withdrawn because of phone/handheld layout and Football/NFL search issues. Public downloads provide [0.1.27 / build 1027](https://github.com/DougTrier/GenX-Streamer/releases/tag/v0.1.27). See the [candidate status](../README.md#release-status) and [physical device audit](device-playability-audit.md) for the current development build. Results in this document apply to the builds named alongside them.

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

### Fire OS 7 embedded coordinates (October 31, 2026; 0.1.3)

Owner-supplied AFTKA evidence: a 1920×1080 screenshot places the intended
picture at about (784,257), while the visible video and SurfaceFlinger updates
start at (1568,515). Fullscreen plays correctly. A TextureView-only 0.1.2
experiment did not fix it and was removed.

The source trace exposed an incorrect coordinate-space assumption:
`native-picture.ts` multiplied the CSS `getBoundingClientRect()` by DPR;
`native_video.rs` forwarded those numbers unchanged; `NativeVideoPlugin.place`
used them as Android view pixels. Neither Rust nor FrameLayout applies another
density conversion. Thus DPR 2 incorrectly doubles placement when the CSS
viewport already maps 1:1 to the actual WebView. The device evidence matches
that failure; the underlying Amazon DPR/render-scale discrepancy is inferred
from the measurements, not directly measured here.

The host now sends fractional CSS bounds plus the CSS viewport width/height
in the same placement request. Rust validates and forwards both. Android maps
once using actual WebView width / CSS viewport width and actual WebView height /
CSS viewport height, rounding only the resulting view pixels. Display density,
DPR and deprecated `WebView.getScale()` are not additional multipliers.
Android documents `getScale()` as prone to rendering/UI-thread races; see
[WebView API reference](https://developer.android.com/reference/android/webkit/WebView#getScale()).
The WebView's window origin is translated into the player's parent coordinate
space; parent padding is subtracted because FrameLayout adds it during layout.
Commands without viewport retain the legacy view-pixel contract.

The host watches the player and document sizes, layout-mode attributes,
window resize and DOM fullscreen changes. Android also reapplies the latest
placement when the WebView's bounds change, and clears it when the player
stops. Each channel's open request carries a fresh rectangle and viewport.
The existing SurfaceView, decoder selection and relays are retained. No
dependency update, minimum SDK increase or Fire-specific scale constant is needed.

Regression coverage includes the reported origin at a 1:1 viewport, ordinary
2× handheld scaling, parent offsets, hidden/invalid bounds, and real browser
DPR-2 embedded → fullscreen → embedded/resize requests. Synthetic density
tests do not constitute a physical Flip 2 verification. The signed 0.1.3 APK
was installed over 0.1.2 on the 32-bit Google TV Streamer, retaining the 10.9K
library. ACC Network visual playback passed embedded → fullscreen → embedded;
switching to ACC Digital Network and back passed, with no crash-buffer entries.
Screenshots and test logs are in the ignored `artifacts/fire-tv-testing/` folder.
The owner confirmed the signed 0.1.3 update fixes embedded playback, fullscreen,
returning to embedded, sound and channel switching on AFTKA / Fire OS 7.
Physical Flip 2 update testing remains pending.

### Fire OS 7 playback coverage candidate (0.1.4)

The owner reports dark embedded pictures with working fullscreen playback in
Free TV and Paid TV live channels, plus GenXtra titles which can now be dark
in both modes on 0.1.3. Those selections still used WebView video;
the 0.1.3 native rectangle fix covered Paid movies/episodes and MPEG-2 live
fallback, not these browser paths.

A native capability enables embedded native playback only for televisions with
Amazon manufacturer, an AFT model and SDK 28. GenXtra, Paid live and public
Free TV selections then use the existing Media3 engine and CSS/native picture host. Other devices
retain their existing GenXtra and Paid-live browser engines. Android Paid
movies/episodes retain their existing native route.

GenXtra opens only the exact active Archive owner's media URL, after generation,
lease and owner checks. Paid live opens only the current live account proxy's
URL; movie/episode, expired and stopped proxies cannot mint that admission.
The existing owners retain lease renewal, cancellation, credentials, transport,
bookmark and download authority. No additional upstream relay is opened.
Kotlin also validates the opaque loopback URL shape. Archive and Paid-live flags
cannot be mixed; control commands cannot carry source flags.

Paid live HLS keeps its explicit HLS MIME; MPEG-TS uses the progressive
extractor. Both keep live decoder rules and the existing back buffer. Position,
audio, captions, pause/resume and cleanup use the existing engine protocol.
The browser/native hole tests now cover GenXtra and Paid VOD layouts explicitly.

At the 0.1.4 checkpoint, physical Fire TV checks across GenXtra, Paid live,
Web viewer and Free TV were pending. This is historical status; current
version-specific local results and owner follow-up are recorded separately.

Public Free TV starts directly in the native live engine on this capability,
covering H.264/browser streams as well as the existing MPEG-2 fallback. Known
container information survives retries; unknown public sources are inspected
before opening the relay. HLS retains the existing timestamp-aligning relay.
Progressive media uses the existing bounded streaming proxy (loopback only,
public destination validation, pinned redirects, owner stop and renewal). It
is not mislabeled as HLS. Native opens require the exact active live grant;
Archive, Paid-live and public-live flags cannot be combined.

Stop now leaves both fullscreen and expanded presentation before releasing
playback, through the shared button/remote Stop action. It resets the actual
expanded state and its button together. Even a cleanup failure leaves the
navigation visible, rather than stranding GenXtra in expanded view.

Thor acceptance also exposed a custom MPEG-2 surface lifecycle failure when the
search keyboard resized the player. Android retained the Java Surface wrapper
but replaced its native window; comparing Java object identity reused an
abandoned queue. The renderer now acquires the current public NDK window per
frame, releases redundant references and resets buffer geometry on replacement.
It permits one redraw only when a different window proves replacement; persistent
rendering failures still reach the player. Ownership tests cover repeated queue
replacement, failed acquisition, geometry restoration and bounded redraws. The
signed 0.1.21 APK passed three keyboard resize cycles and fullscreen/return on both the ARM32 Google Streamer and ARM64 Thor, followed by sustained playback. Fire TV and Flip 2 owner confirmation remains separate.

The 0.1.3 local Google Streamer Weather Channel observation reproduced
buffering during a 180-second sample. It does not identify the restart trigger.
The candidate logs fixed recovery code/phase/evidence/attempt/delay and fixed
relay failure codes after headers have been sent. It logs no provider messages,
URLs or account identities. No delivery timeout was changed without evidence.
The Firestick reports remain on the remote computer and were not available
locally at the time of these checks. Physical Fire TV confirmation is pending.

### Live progress and playback diagnostics candidate (0.1.6)

The local Google Streamer reproduced repeated Paid Weather Channel interruptions.
The signed 0.1.5 diagnostic APK established `body_failure timeout=true`, then
`account-proxy-network-failed response_started=true`, controller recovery and a
released/recreated AVC decoder. The TV/RAW Weather variant repeated this about
12-18 seconds apart. A separate US Weather variant could run for three minutes
without the failure, so a short successful start is not acceptance.

The relay's reqwest client-wide five-second read timeout overrode live playback's
20-second no-progress budget. Continuous live bodies now use one explicit
20-second read-progress budget, with header/connection waits, finite HLS resource
limits, VOD reads, cancellation and ownership still bounded. Live root TS/audio
is identified by its owner/container rather than the absence of a Content-Length
or Range header. Native Media3 live reads use the same budget; VOD keeps its
existing source configuration. A six-second burst-gap regression test requires
both bursts through one upstream connection. Stop must cancel a stalled body
within one second. These tests do not substitute for real provider playback.

Public native progressive sources use the existing video-file/range-capable
proxy path, with a separately owned public renewal. HLS keeps its timestamp-aligning
relay. Private account-native grants still exclude VOD, expired and stopped
sessions; public opens require their exact NativeLive grant.

Settings → Advanced → Playback diagnostics starts an opt-in 15-minute capture across Free
TV, Paid TV, GenXtra and Web Stream. Up to 800 observations / 1 MiB are retained;
old entries and frontend queue drops are counted. Playback-state transitions,
recovery reasons, buffer depth, browser/native frame counters and dimensions,
CSS rectangles, DPR, Android density/WebView scale and actual screen-space player
and surface bounds are recorded where exposed. Native player and surface bounds
are compared with expected placement (two-pixel tolerance), including the reported
double-offset case and aspect-fit letterboxing. Final composited content pixels
remain explicitly unverified; third-party Web Stream pages do not expose their
internal video frame counters through GenX's bridge.

Web Stream records native resource/HTTP and renderer errors, with main-frame
errors distinguishable from subresources. It does not expose an app bridge to
the page, inspect credentials or record page/provider URLs. Trace fields are
allowlisted numeric/boolean facts and fixed tokens; free text is rejected.
The capture persists atomically and is available after restart, but recording
never resumes automatically. Android Export writes a uniquely named JSON report
under the app's external files directory, so Fire TV needs no document picker.
The UI shows its path for ADB/file-manager retrieval. Windows uses a user-selected
file. Nothing is uploaded automatically.

At that earlier checkpoint publication was held pending further playback and owner
Fire TV verification. The current short targeted acceptance policy appears in the final
section and docs/release-signing.md; older duration requests below are historical.

The 0.1.7 candidate samples actual geometry changes rather than repeated unchanged
class assignments from player progress updates. Five-second periodic quality
samples remain enabled. A browser regression exercises repeated UI assignments
without a log flood, followed by an actual placement change.

The local 0.1.7 Weather Channel and ESPN HD captures each passed more than ten
minutes of recorded playback without mid-playback buffering/recovery. A broader
FOX Sports 1 RAW football test did not pass: it recovered around six minutes in.
That observation remains a release blocker, not a successful recovery verdict.
The MPEG-TS adapter previously discarded the library's error detail, so those
logs alone cannot attribute this failure to the provider or the application.

The 0.1.8 diagnostic candidate records allowlisted MPEG-TS/HLS/HTML5 failure
details and HTTP/media error numbers, never library messages or addresses.
Immediate controller-state recording supplements five-second quality samples.
The relay distinguishes local consumer disconnects from local write timeouts,
and records an upstream EOF with received-byte count and duration. A local write
failure after decoder disposal may be a consequence of recovery; it must not be
called a provider failure without supporting upstream evidence.

The same candidate gives personal devices at up to 1100 × 650 CSS pixels the full
Guide workspace, with wrapped controls and touch targets at least 44 pixels tall.
The Thor's narrow right-hand agenda previously shared its limited height with
the channel sidebar. TV layout and its row fitting retain their existing path.


The 0.1.8 Google TV capture ran FOX Sports 1 RAW for two consecutive windows
(663 and 749 seconds) without recovery or mid-playback buffering. That does not
explain the earlier 0.1.7 interruption. A subsequent Free ACC Network attempt
played briefly, repeatedly buffered, then stopped advancing; a retry played.
This failed attempt remains evidence against release readiness. The 0.1.9
candidate additionally retains rate-limited nonfatal HLS gap/stall/nudge events,
which previously disappeared before the watchdog failure. This instrumentation
change is not presented as a stream-delivery fix.


The 0.1.10 diagnostic candidate adds sampled HLS fragment sequence/timing/byte facts
and fixed nonfatal warning categories. Its recorder accepts the controller's
`observed-progress`/`media` evidence and decode/capability phases; the earlier
allowlist mismatch could interrupt recording at watchdog/decoder failures.
Regression coverage requires capture to continue after these failure events.
Browser learned-buffer keys now include the exact source as well as the channel,
so alternatives do not inherit each other's hold target. This is session-local;
no automatic persistent source winner is claimed by this candidate.


### Native HLS adapter statistics correction (0.1.11)

The 0.1.10 ACC Network HLS capture retained actual playback failure: short playing
intervals, repeated buffering, fragment delivery with `receivedBytes: 0`, an HLS
internal abort, and an observed-progress watchdog timeout. The corrected recorder
continued after failure rather than silently losing the evidence.

The installed hls.js FragmentLoader assigns `frag.stats = loader.stats` before
calling the custom loader's `load`. GenX's NativeHlsLoader then replaced its stats
object, leaving HLS's fragment reference at zero bytes/timing while callbacks got
a different populated object. HLS's ABR controller uses those fragment statistics
for bandwidth sampling and emergency-abort decisions. This is an adapter contract
bug, not evidence that the provider failed.

The loader now resets statistics in place, retaining the outer object, nested
timing objects, and HLS-owned retry count. A regression reproduces HLS's retained
reference before load: it fails on the old adapter and passes with real byte and
timing updates after the fix. No timeout or global buffer was increased for this
correction. At that stage, a sustained retest was still needed before claiming the
observed Free TV stalls resolved; subsequent evidence is recorded separately.


The 0.1.11 retest confirmed nonzero fragment bytes and a changing bandwidth
estimate after the statistics fix, but ACC HLS still failed. One six-second
fragment delivered 3,729,920 bytes with an end-to-end estimate around 2.2 Mbps,
below that fragment's media rate. This does not yet separate upstream download
from native/IPC/frontend overhead; the capture must not be called a provider fault.
The quality menu exposed only one 720p rendition in this observation. The manual
Auto interaction was not independently verified before failure.

The 0.1.12 candidate records native download duration separately from total
frontend delivery duration and its remaining overhead, using validated native
monotonic timing. Invalid/missing native timings remain null. Quality samples
include Auto/manual state, selected rendition/count and advertised bitrate.
Starting quality now uses HLS `startLevel`, which seeds the initial highest
supported rendition without locking `manualLevel` through `nextLevel`. Manual
quality choices remain available, and a single-rendition source cannot be made
lower-bitrate merely by selecting Auto.

### Session-owned native HLS connections (0.1.13)

The 0.1.12 ACC HLS retest failed again with no navigation during playback. Its
native download measurements account for most of the segment delivery time;
the observed app delivery overhead was much smaller. This locates the delay in
the native HTTP stage, which includes our own transport behavior and is not by
itself evidence of a provider fault.

Inspection found that playback constructed a fresh reqwest client for every
playlist, key and media request. The 0.1.13 candidate owns a bounded client pool
per HLS playback session instead. HTTPS-only and HTTP-enabled redirect policies
remain separate; URL/range validation, response size and request deadlines are
unchanged. Stop cancels loaders, closes the session and joins the native work;
application shutdown and Android renderer recovery revoke all remaining pools.
An open that finishes after Stop must be closed without dispatching its canceled
load. Cleanup failures remain failures, rather than successful release claims.

The native socket fixture verifies two media requests on one connection and EOF
when the session closes. Loader tests verify shared session identity, a late open,
idempotent Stop, joined cleanup and surfaced close failure. Passing these tests
did not establish sustained playback on the device; that earlier retest requirement
is retained as history rather than the current release-duration policy.

The 0.1.13 ACC HLS capture recorded three mid-playback buffering transitions,
with decoded playback resuming and no recorded fatal error/recovery restart.
This still fails the smooth-playback gate. Connection reuse must not be described
as resolving the Free TV delivery issue from this evidence.

### Applying learned buffering at source startup (0.1.14)

The browser retained an exact-source adaptive buffer goal after stalls, but only
used it inside the next stall hold. Starting that source again still called play
immediately. In addition, a Fast profile's configured HLS buffer could remain
below the subsequently learned goal.

For a live HLS source with an existing in-memory learned requirement, startup now
waits for that buffered duration, bounded by the existing 12-second hold limit
and the controller's overall startup deadline. Stop cancels the wait and releases
its timer/listener. Other source URLs, fresh sources and on-demand playback keep
their prior startup behavior. Only this HLS instance's buffer capacity rises to
its learned goal (at most 20 seconds); no global timeout/buffer increase is made.

The regression fails on the earlier startup path and covers buffer readiness,
Stop, the wait deadline, URL isolation and on-demand exclusion after the fix.
This is session-local learning, not persistent source ranking or proof that
insufficient upstream throughput can sustain the advertised rendition.

The first physical 0.1.14 HLS run recorded approximately three minutes with no
mid-playback buffering and about 30 seconds buffered ahead at the end. Because
that run did not learn a stall requirement, it does not demonstrate that the new
startup wait caused the improvement. Earlier failing captures remain retained.

The 0.1.15 candidate limits routine native HLS delivery timing to one sample per
five seconds, matching the separately sampled buffered-fragment facts. A 15-minute
quarter-second-part fixture must leave room within the 800-observation recorder
for frame/native-bounds samples and immediate states/errors. This changes only
routine diagnostic cadence; playback failures and state transitions bypass it.

### Buffered VOD, keyboard handoff and stable Guide (0.1.23 / build 1023)

A physical GenXtra resume capture exposed an application transport defect: a valid
decoder with roughly 150 seconds buffered stopped accepting more bytes. Our body-write
deadline closed its response. The browser later requested the exact next byte, creating
avoidable connections. A controlled Paid finite-VOD range fixture reproduced the same
problem in its separate body path. The earlier failures remain retained evidence.

Both finite-VOD paths wait for socket readiness without consuming bytes, then perform
a guarded nonblocking partial write. Offset advances only for bytes accepted by the
socket; WouldBlock preserves it. GenXtra rechecks exact authority after readiness.
Paid finite VOD retains its existing two-second verification cache on immediately
writable bytes and requires fresh checks while blocked. Fresh checks continue every
two seconds during backpressure. The Paid correction is gated to finite VOD; live/HLS
keeps its existing framing and deadlines. Header, upstream-read and authority deadlines,
grant/reference/session checks, client/chunk limits, lease expiry and joined Stop remain.
No authority-cache grace or general timeout increase is introduced.

Closed request diagnostics retain numeric range/byte progress and fixed phase/terminal
codes, without URLs, capability tokens, account identity or arbitrary upstream text.
The original body-timeout fixture fails against the prior source and the corrected
single response survives a held reader, resumes exact bytes and cancels promptly.

Dismissing the native keyboard preserves input focus. The next arrow ends its owned
editing session and resumes normal remote routing; OK can reopen editing. The Guide keeps
a steady status area while listings load: candidate 12 retained a deep row's identity but
its rectangle moved 13.7 CSS pixels when the loading line disappeared. That observation is
why a further layout correction was required; it is not called a pixel-stable pass.

Paid VOD also keeps focus on a visible control after its poster gallery closes, with
explicit remote routes between its filter rail and player controls. Native Back exits
the owned fullscreen presentation before reopening the gallery. Modal, editing, menu
and replay owners retain their earlier priority. These navigation checks are separate
from recorded playback counters; a healthy stream alone cannot pass the route matrix.

Stopping a scan now retains a normal paused result for its own typed cancellation.
Unrelated errors, unconfirmed publication receipts and cleanup failures remain failures.
The owner's latest acceptance request uses short targeted Scan, Menu, Guide and remote
checks. Existing sustained Free/Paid/GenXtra captures remain supporting evidence; no new
five-minute capture per stream is required. Physical owner Fire TV/Flip 2 checks and
ordinary joined closing remain separate from automated verification.

Candidate 15 also addresses Guide work contending with fresh playback authority.
Candidate 14 exhausted its bounded SQLite BUSY retries during actual Paid playback;
the exact device writer remains unknown. A real 17-second same-Store maintenance
fixture independently reproduced the unchanged-authority refusal. Native authority
now waits for owned-writer read admission and then checks a fresh exact snapshot,
without cached permission grace or increasing the global interactive SQL timeout.
The original external BUSY clock remains bounded; pending admission never renews a
lease or counts as successful authorization.

Full Guide acquisition and new cached mapping connections defer while viewing or
browsing. A playback intent becomes busy first, then joins full-builder, maintenance
and daily-guide cancellation, their original operations and cancellation receipts
before media acquisition. Already active mapping writers are joined; unstarted
mapping requests coalesce until idle. Ordinary cached channel/program queries remain
available. A canceled maintenance tail retries storage work only, not completed feed
acquisition. Unknown cleanup/publication failures remain visible and refuse admission.

Find can queue an update while the Guide is open. Close the Guide and stop playback
to let that owned update proceed, then reopen to view saved results. The queued owner still rechecks
latest source identity and HTTP permission before any preview or commit. A known
metadata-only refusal is reported visibly and retires its pending status; after
confirmed cleanup it does not block independent playback. Actual owned cancellation
remains quiet. Unknown cancellation, cleanup or receipt uncertainty stays a failure.
A later cleanup failure wins even if an earlier source refusal was harmless to media.

The final candidate 16 full 17-stage run passed 3718 unit, 595 UI,
1647 native plus 7 existing ignored,
117 casting and 45 Python checks. Its exact APK SHA-256
is `bec077f50dd1a8d1713916ee1a841ede0c73f8d6d2a6d7d4fd7db3a7e7581722`. Matching Google Streamer/Thor runtime receipts cover only their
recorded public sources, modes and remote actions. Paid authority and selection
verification for candidate 16 uses offline fixtures while the owner household uses
the provider; earlier real Paid captures remain separately scoped supporting evidence. Frames/audio counters do not prove physical
audibility, every composited pixel or every channel. Fire TV AFTKA and Flip 2 owner tests
remain separate. Historical AFTKA / Fire OS 7 (Android 9) embedded/fullscreen
confirmation applies to 0.1.3; the later successful 0.1.21 stream observation is
narrower than final 0.1.23 device acceptance.
That 0.1.23 checkpoint was not a public release. It does not impose an
owner-before-publication condition on 0.1.25: the accepted sequence publishes
after exact-candidate automated/package checks, scoped local physical checks
and closing, then the owner tests the Fire TV Stick/Flip 2 in-house upgrades.
Their new-version results remain unverified until reported.

## 0.1.25 sports search and release evidence

The withdrawn 0.1.25 / build 1025 release was built from candidate 7. The evidence below is retained as history; the phone/handheld layout and search regressions require new verification.
All 17 development checks passed: 4,006 unit tests across 356 files, 600 UI checks, 1,702 native tests with 7 existing ignored, 117 casting checks and 45 Python tooling tests; type, lint, format and the remaining tooling checks passed. Its universal Android package is
`91e2fb538e3cad35e1d2ccbdca03658c7c3ca8cc2d622da7ea5b2b8b5e50f0e5` (93,111,678 bytes), `com.tmg.tv`, minimum API 24,
target API 36 and both ARM ABIs under the same official release certificate.
Windows 0.1.25 x64 Release EXE is 48,686,080 bytes (SHA-256 `106d72b72c154a88866e733be79f8364c3015095257d96819e4ed7832217fd96`); portable ZIP is 16,912,514 bytes (SHA-256 `fc0c7215d096ffadab3877c097beaa7136a0e58db5c297654d5f7cef0b18bba3`). Its 39 non-HTML frontend assets are byte-exact and index.html is parsed-document equivalent. Four isolated TS/fMP4/AES/range fixtures produced fresh frames and progress; Guide/fullscreen/favorite checks and SQLite integrity passed. Ordinary request_exit completed in 59.886 ms with exit code 0, no forced termination and the observer joined. This does not establish physical audibility, provider coverage or a Windows Authenticode signature. Current signed 0.1.25 / build 1025 checks used one existing public Free source on each local Google Streamer and Thor. Complete embedded/fullscreen/back pictures, readable HUD controls, Quality menus, buffer adjustment and normal Exit were verified. Thor also verified its cached US/Sports Guide, three complete programme rows, preview tuning and fullscreen return; a separate focused-row check verified two complete ordinary channel cards. Both local apps are closed with no active GenX media. Google image-acquisition warnings remain with unknown impact; no clean-log or physical-audibility certificate is claimed. No new Paid-provider playback was used. New-version Firestick and Flip 2 testing remains owner follow-up after publication. Current source and controlled browser tests cover sport/league, team-aware search, matching PPV and independent Free/Paid choices. Physical Thor checks used cached US/Sports Guide rows and one public Free channel; current Google checks used Free History. These bounded checks do not certify every facet, Guide source, Paid account or channel.

No new local Paid-provider stream is opened while the household provider
client is active. Earlier 0.1.23 playback/Windows and internal 0.1.24 results
remain version-specific; neither establishes this candidate's acceptance.
The withdrawn assets used 0.1.25 / build 1025; their manifest and SHA256SUMS identify the recorded packages, which are no longer publicly downloadable. New Fire TV Stick/Flip 2 upgrade results remain
unverified follow-up after the official stable GitHub publication.

This phase adds cached sport/league and bounded team-aware queries,
matching PPV under specific intent and independent Free/Paid browsing
choices. It does not add a new player, change automatic PPV source-equivalence
boundaries or implement My Local/Web TV discovery. Programme inheritance
still uses the selected geo-authorized canonical channel; another alias's
league metadata does not resolve an otherwise unknown mascot-only title.

All primary channel-card headings use 1rem text, nominally 16px at the
normal root size, with full wrapping and the original channel name retained.
On short personal displays, an adaptive list reserve accommodates two
ordinary measured row pitches up to 80px each, while shorter rows retain
the compact reserve. A larger wrapped row retains its complete measured
height, and a settled empty list releases its reserve. The sidebar's filter
stack can scroll while focused copy is
revealed within that sidebar. An exceptionally tall card pages through its
readable text on Down/Up before changing channels. Main-card paging uses
actual text bounds rather than the shared virtual-row pitch, so a following
short card does not introduce blank paging; action controls use their own
rectangles. Background metadata growth does not pull the sidebar away from
controls the user has returned to. Anchors retain their position where the
same identity remains.

The source-focused regression uses the shipped Roboto Condensed font, native
SELECT controls and nine ordinary provider-shaped rows at 833x397. It
reproduces the 80px row pitch observed on Thor: the frozen C5 source shows
one complete card in its 120px list; the adaptive reserve shows two complete
ordinary cards with their actual action targets. The original 24 browser
cases and nine History cases remain unchanged. The resulting 25 Sports and
nine History cases, plus 17 bundled layout cases, passed targeted checks.
Those C6 source fixtures did not establish physical acceptance; its later fullscreen result is recorded below.

Release files contain the reviewed app binaries, portable package, manifest, checksums and locked third-party notices. Saved libraries, account settings, raw device logs, test helpers and private inspection material remain outside the public release.

Free programme membership is read from current Guide mappings, then exact
channel/catalog-source and projection rows and a published Guide source.
The existing `guide_program_channel_time` index seeks each mapped source,
XMLTV channel and upper time boundary. It avoids scanning unrelated feed
programmes while retaining every original overlap predicate. No arbitrary
lower start-time floor or incomplete early result was added: a programme
with an old start and a still-overlapping known end remains eligible, and
unknown ends retain the original inside-window rule. Shared EPG IDs keep
their separate application-channel contexts, including PPV inheritance and
event-only badge decisions.

The C3 real-SQLite fixture kept the same 500 mapped contexts and exact IDs
while increasing stored programmes from 8500 to 82500. Old global-scan work
grew 203 to 1258 VM blocks; mapped-index work stayed 79/79. Doubling mapped
contexts to 1000 with 165000 programmes took 182 blocks (or 69/69/157 after
ANALYZE). Baseline plans were already programme-first: the proved defect is
unrelated global programme work, not an established repeated-loop failure.
The synthetic unmapped ratio is not a measurement of the device's cache.

The query-local raw-fact cache retains exact field vectors with separate
channel/programme entries. Unicode necessary-evidence checks use exactly the
existing NFKC/lower normalization and Regex Unicode L/N boundaries. All
evidence and contextual first-token keys participate; only a proved negative
skips full classification. Positive candidates still use the full matcher.
The 50000-unique-Unicode-description host fixture retained AF200/NFL100 rows
while reducing full ontology calls 50000 to 2000. These work bounds and host
timings do not certify Android latency. Fullwidth aliases, combining marks,
mixed-script boundaries and shared classifier/query cases retain parity.

### Rejected internal 0.1.25 candidates

Candidate 1 was rejected after Google measurements found Sports controls
overlapping the first row, card wrapping overridden by the theme cascade
and slow facet completion. Candidate 2's controls/programme wrapping passed
the scoped observations, but an ordinary long channel name was still
ellipsized and American Football remained in SQL beyond the 10-second
observation gate. It eventually returned 96 rows; the first observed complete
sample was an upper bound, not an exact 67-second query duration. Candidate 2
is rejected overall despite valid static packages and an isolated Windows
fixture PASS. Both candidates' installation/ordinary-closing observations
are supporting history only. No media was selected in their Google checks;
NFL/Guide/Thor 2 were stopped after root held the failed candidate. Their
artifacts and rejected receipts remain immutable and do not pass current gates.

Candidate 3 retained valid static packages and all-17 source evidence, and
its Google short check passed with known cold-query latency. It was rejected
after Thor's focused Syracuse/Clemson replay card clipped its title in a
72px list viewport despite the taller measured card. The previous default
whole-card fixture had hidden Sports controls and incorrectly installed TV
selector wrappers on the personal layout. The C4 fixtures use native SELECT
controls with the active filter stack and preserve the TV-specific tests.
Both C3 devices closed through measured ordinary Exit with live PIDs, helper
removal and joined observers/loggers. C3 remains rejected overall; none of
its packages or physical results establishes current candidate7 acceptance.

Candidate 4 was rejected for TV-remote buffer navigation: focus could land
on the meter, whose Left/Right handling adjusted the target and prevented
reaching Auto. Earlier apparent preference loss was resolved by retesting
the original exact feed, which restored its saved Manual 4-second target;
automatic selection had used another feed with an independent choice. Its
scoped Google History/remove/Clear/Guide observations remain historical
only. Google closed through ordinary Exit before helper/observer/logger
cleanup, and Thor never installed C4.

Candidate 5 removes the meter's key interception. The existing navigator
reaches the visible arrow and Auto buttons, and OK activates the selected
button. The two new embedded/fullscreen remote regression cases fail with
the frozen C4 widget; all eight cases pass with the new source. The original
six test bodies remain unchanged. Google's current C5 short public-Free
check passed its scoped buffer/History/Guide observations and closed
through ordinary Exit. C5 was nevertheless rejected on Thor: at default
font scale, its 120px list held only one complete ordinary card at the
measured 80px row pitch. Thor stopped at that layout gate without media
coverage and closed through ordinary Exit. Its initial accidental GenXtra
tab activation is an operator deviation, not proof of media selection or
absence of background catalogue activity. Both C5 devices are closed; its
packages and scoped Google success do not establish C7 acceptance.

Candidate 6 changes only the short-personal adaptive reserve and adds the
shipped-font regression described above. A constant 160px draft fixed the
new ordinary-row case but failed the unchanged shorter History footer
bound; the adaptive rule retained both checks. Its Google short check passed its scoped public-Free buffer controls and About/build identity. Thor confirmed two ordinary cards and exact-stream saved Manual 4-second restoration, but the fullscreen HUD compressed controls into vertical words and clipped controls below the viewport. C6 is rejected overall despite valid source, static packages and an isolated Windows fixture PASS. Both devices closed through ordinary Exit before joined observer/logger cleanup and helper removal. No History/Guide follow-up was inferred after the fullscreen hold.

Candidate 7 corrects fullscreen HUD styles, panel-local remote focus and their browser regression fixture, followed by a short-landscape Guide layout correction before any C7 package was built. Fullscreen actions retain intrinsic label widths, wrap as needed and scroll within a bounded HUD; the read-only status stays inside it. Fullscreen personal controls and the meter retain 44px targets, while the existing explicit compact TV control policy remains unchanged. Fixed quality/audio menus retain their viewport positioning. Panel Left/Right only moves focus; it does not change or save a target. Up/Down and panel-edge movement remain available to the shared navigator.

The original eight widget test bodies remain byte-identical. Four complete-shell cases load the shipped font at personal 833x469, 736x414, 390x844 and TV 960x540; they check readable words, controls/status bounds, hit targets, non-overlap and actual Quality menu End/Escape behavior. Two personal remote routes verify focus-only movement and OK activation. The final 14 widget cases are included in 73 focused passes; 19 related UI checks (17 bundled and two source-component cases) also passed. These fixtures do not establish C7 physical acceptance. A separate preflight using installed C6 confirmed the unchanged short-landscape Guide still hid its mini preview, left only one complete programme row and intentionally switched to Watch after tuning because the preview had zero bounds. That C6 preflight closed normally and remains supporting diagnosis only.

For personal viewports 701–1100px wide and at most 650px high, the Guide now reserves a 180x101.25 preview corner beside a bounded 100px toolbar and keeps the programme grid full width below. Programme rows retain their 44px floor. Toolbar Left/Right and first-row Up reveal the focused control inside the toolbar client scrollport, including scrollbar gutters, without moving the outer page. Sports controls keep DOM order. The existing GuideViews tune/cancellation/current-intent logic is unchanged; the visible preview keeps the Guide open after a deliberate tune, while narrow-phone Watch-return and TV layout remain unchanged.

The final source-component fixture mounts the actual healthy Manual 4-second buffer footer, full shipping CSS and Roboto Condensed, with American Football selected so both Sport/League and matching-PPV status are present. At 833x397 its footer is 44.375px high and its 132.625px programme viewport contains three complete 44px rows; preview and toolbar do not cover them. Actual createGuideViews/page-controller tests cover first tune from idle for Free and Paid, retained focus, held cancellation and newer intent. The same final fixture against exact F14 CSS recorded six failures and six passes; the fixed five-suite cohort passed all 51 cases. These are controlled source fixtures, not decoded physical playback, broad device acceptance or a new Paid-provider test. The initial full F15 run stopped at two legacy handheld fixture assertions requiring Close to be visible before toolbar scrolling; the runtime source did not change. The personal fixture now reaches Close with actual directional keys before its original viewport/hit assertion, adds client-scrollport/text-fit/44px checks and keeps the TV initial-visibility contract. The focused repair and all 819 Guide cases across 69 files passed; failed F15 receipts remain unchanged. Fresh strict16 development, signed packages and actual scoped physical evidence remain required separately.

### Historical internal 0.1.24 scope

The signed internal 0.1.24 / build 1024 PPV candidate2 used unchanged-bound
3752 unit/component tests in 335 files and 597 interface tests, with a fresh
1658 native passes plus 7 existing ignored. Its Google short check covered
catalog filters, the remote PPV menu, identity and ordinary closing; no media
was selected. It had no new all-17 run, Windows package, Paid-provider playback
or owner Fire TV Stick/Flip 2 acceptance. Its APK was 92502318 bytes/SHA256
`619134618b36a426fa3fd0f58844e394ae76b5bc6116cac7bfaa320374811565`.
All 2037 packaged source paths and 40 frontend inputs were bound at that
historical checkpoint; those measurements do not verify 0.1.25. Archived
0.1.23 all-17/Windows/device reports and 0.1.24 receipts remain unchanged.

### Historical candidate3 Google TV cold-query timing limitation

In the rejected candidate3 Google check, the first American Football/NFL filter became ready by about 8 seconds. The first filtered Guide was still pending at 9.6 seconds and was observed ready by 19.6 seconds. These are observation bounds, not exact completion timings or an instantaneous/under-load responsiveness claim. No duplicate catalog count/rows dispatch was found: the Guide builds its own exact-scope saved-listing inventory before bounded visible-row reads.

### Current source buffering and live History scope

Manual buffer targets are integers from 1 to 20 seconds, separate from automatic profile state and supported browser live source learning. Engine capability decides whether the current route can control the target or only observe available measurements. Durable preferences use opaque digests of canonical Free endpoints or scoped stable Paid channel/format identities; restart and unchanged-source rescans retain the preference without storing raw URLs or credentials. Reset deletes one preference; capacity refusal does not evict another stream. The async lookup precedes decoder allocation and is cancellation-raced; accepted setters are generation/engine fenced and do not retune.

Live-channel History stores only bounded scoped IDs/timestamps after current decoded admission. Exact-ID membership and recency are applied before counts and paging, intersected with search/location/adult visibility. Already watched PPV channels are admitted only by their recorded IDs; ordinary PPV and source-picker fences stay separate. Saved History is not playback authority, and Paid rows still require current account/media/reference ownership. Existing Free parser identity preservation is reused; a genuinely regenerated identity does not receive guessed history. Optional storage failures remain visible to the initiating operation; closing joins their settlement without relabelling a failed save as success.

Current local Free playback checks on Google Streamer and Thor verified the buffer meter, remote focus between controls, a saved 4-second target and return to Auto. Google retained its saved History channel. Exact-source persistence and other History actions retain their separately recorded source and earlier device evidence; a full rescan and current Paid-provider History were not repeated.
