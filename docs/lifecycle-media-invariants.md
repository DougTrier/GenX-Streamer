# Native lifecycle and media pipeline invariants (LX, MP)

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

Two groups proposed in an owner-supplied review on October 19, 2026, after the Android exit crash and Trier MPEG work:

- **LX** protects startup, shutdown, resource ownership and the Android exit fix.
- **MP** protects what happens around [Trier MPEG](trier-mpeg.md): timestamp correction, the PCM handoff to Android's player, channel changes and the relay.

They stay separate from Trier MPEG's own decoder register (MA01–MA15). Following the review's advice, each proposed item was cross-referenced against the existing registers: playback P01–P09, data D01–D05 and sharing S01–S06 in [streaming invariants](streaming-invariants.md); casting C01–C08 in [casting contracts](casting-invariants.md); EXIT01, LIFE01 and LIFE02 in metric gates; and MA01–MA15. Where an existing contract already holds the obligation, it is mapped there, not duplicated.

Every invariant marked **New** below has three things:

- a deterministic pass/fail condition;
- a negative test proving the gate rejects a violation;
- evidence tied to an exact revision.

## The Android exit crash (what LX06, LX10–LX12 protect)

**Measured:** on the Google TV Streamer and the Sansui TV, every ordinary exit ended in a native abort. The abort message was "FORTIFY: pthread_mutex_lock called on a destroyed mutex", followed by a SIGSEGV in WebView's in-process GPU thread (`Chrome_InProcGp`) or in `hwuiTask0`. It happened about one second after GenX's exit work completed:

- 03:30 on the Sansui;
- 03:46, 07:38 and 08:08 on the Streamer.

**Cause:** GenX's exit settles all owned work, finishes the Activity, drains requests, then called Tauri's `app.exit(0)`. That runs the C library's exit handlers, which destroy shared native state while WebView's GPU and HWUI threads are still running.

Twice (07:32 to 07:38) the drain was still running when Android froze the finished app. The exit only completed, and crashed, once a relaunch woke the process.

**Fix:** after the drain, `finalize_activity_exit` asks `ViewingPlugin.endProcess`, which calls `Process.killProcess`. That skips the C exit handlers, and `app.exit` remains only as the fallback.

**Was leaving the process to Android viable? No.** The review asked this first. During exit GenX sets `closing` and refuses all new work for good (LX01). A process left alive and later reused by Android for a relaunch would carry that state and refuse to work, which would break LX11. So the process must end, and it must end only after the work is settled (LX06).

**Safe application close versus process termination.** These are not the same thing, and LX06 keeps them in order:

- *Safe close* means everything GenX owns has settled and is durable. It is proven by the existing close owner: EXIT01, D02, and `native_shutdown::join_owned` joining speech, casting, LAN sharing, accounts, the Archive, guides, downloads, scan resume and now the live relay.
- *Termination* is permitted only after that, by `android_task_finish::end_after_drain`.
- The absence of a crash alone is never taken as proof of a clean close.

## Cross-reference

| Proposed | Obligation | Existing coverage | Decision |
| --- | --- | --- | --- |
| LX01 | No new work once shutdown begins | `NativeState.closing`; close owner (EXIT01); `CastingManager::shutdown` refuses late work (its test) | Mapped; extended: the live relay refuses opens after shutdown (`shutdown_closes_the_relay_and_refuses_later_opens_lx01_lx05`) |
| LX02 | Owned operations cancelled or joined before termination | EXIT01 ("actual native joins"); `native_shutdown::join_owned`; P02 | Mapped; extended: the live relay is now joined (it was not) |
| LX03 | Idempotent shutdown | Close owner retained attempts (`close_owner` tests); `stale_generation_and_duplicate_exit_are_refused` | Mapped; extended in the LX06 test (a repeated ticket never ends the process twice) |
| LX04 | Acknowledged changes durable before termination | D02 (atomic, serialized commits; recovery keeps the last valid revision); exit saves before the drain | Mapped; physical: relaunch after exits keeps channels, favorites and settings (Tasklist evidence) |
| LX05 | AudioTrack, video and relay ownership released before termination | `NativeVideoPlugin.release` in `MainActivity.onDestroy` (Media3 player, so its AudioTrack); C05 for casting | Mapped; extended: live relay shutdown joined |
| LX06 | Termination only after the coordinator confirms the drain | — | **New** (below) |
| LX07 | Late callbacks cannot change state after shutdown | P03 (only the latest selection may act); close owner tickets | Mapped |
| LX08 | Bounded deadlines; incomplete cleanup never reported clean | EXIT01 (5 s or an explicit blocked-close state) | Mapped; `endProcess` is bounded (2 s, then `app.exit`) |
| LX09 | Exit during playback, refresh or import keeps the last valid state | D02, D03, scan publication tests | Mapped; physical exits ran during ACC playback |
| LX10 | A verified exit leaves no GenX native crash in the observation window | — | **New** (below) |
| LX11 | Relaunch after termination restores valid state and plays | Startup recovery tests | **New** physical gate (below) |
| LX12 | Android termination cannot alter Windows or fire on backgrounding | — | **New** (below) |
| MP01 | Healthy streams' timestamps are never modified | — | **New** (MA15 covered the fix; MP01 states the protection) |
| MP02 | Correction handles discontinuities and resets per session | — | **New**; the aligner was changed to meet it |
| MP03 | Corrected audio stays in order, synchronized, without jumps from drift | — | **New** |
| MP04 | PCM handoff keeps rate, frame length, channels and 16-bit range | MA06, MA13 (decoder output) | **New** at the Media3 boundary |
| MP05 | A channel change isolates the old decoder, timestamps and AudioTrack | P01 (one session), P03 (latest wins); native live engine disposal; one relay per session | Mapped; extended by MP02's per-session test |
| MP06 | Memory, latency and CPU budgets on supported hardware | MA14 (decode speed); relay limits (2048 resources, 4 clients, 32 MiB per media response, 2 MiB per playlist); P08 (two-hour soak) | Mapped; physical: Sansui about 45% of one core for MPEG-2 plus Layer II. The 24-hour soak stays open (its own task) |
| MP07 | Decoder failures cannot cause unbounded retries, noise, deadlocks or growth | MA01, MA03, MA10, MA11; P05 (bounded recovery) | Mapped |
| MP08 | The relay cannot widen permissions, expose credentials or become an open proxy | C06; `native_video` and `NativeVideoRules` (exact loopback address only); relay `validate_target` (public upstreams only) | Mapped |

## New invariants

| ID | Pass/fail condition | Negative test (proves rejection) | Evidence |
| --- | --- | --- | --- |
| LX06 | `end_after_drain` runs `end` only after the request owner and work owner reach zero, `closing` is set, and the close owner accepts this exact ticket once. | `the_process_ends_only_after_every_owned_operation_drains_lx06`: outstanding request or work keeps it from ending. `no_close_or_a_stale_or_repeated_ticket_never_ends_the_process_lx06`: no close, a stale ticket, or a repeated ticket never ends it. | `src-tauri/src/android_task_finish.rs` |
| LX10 | `scripts/android-exit-check.mjs`: after GenX's own `request_exit`, the device's crash buffer has no GenX or FORTIFY line for 60 s. | The same check recorded the pre-fix failure: build `af68e9f3` at 08:08 on the Streamer, with the abort and SIGSEGV in `Chrome_InProcGp` (evidence) | 23d850e: Streamer, Sansui, Flip 2, phone PASS (same folder) |
| LX11 | Same script: GenX relaunches to a resumed `MainActivity` with no new crash. | Before the fix, a relaunch into the frozen leftover process aborted in `hwuiTask0` (07:38, Streamer) | Same folder |
| LX12 | Kotlin `killProcess` appears only in the renderer-recovery helpers and `ViewingPlugin.endProcess`. Rust requests `endProcess` exactly once, in the Android-only `finalize_activity_exit`, through `end_after_drain`. | `tests/tooling/test_process_termination.py`: a stray `killProcess` on backgrounding, a second request, or an ungated call each fail. | Tooling tests |
| MP01 | An audio stream within 10 s of its video is byte-identical after the relay; only a gap beyond 10 s is corrected. | `ordinary_skew_and_streams_without_a_pair_are_never_changed`: half a second off and exactly 10 s off are untouched. `audio_stamped_minutes_early…`: 296 s off is corrected. | `src-tauri/src/ts_align.rs` |
| MP02 | Each relay session starts uncorrected. A correction is re-decided only when the corrected gap leaves the threshold: a restart with a new offset gets a new shift, and a source that fixed itself loses the shift. The 33-bit wrap is handled. | `a_discontinuity_re_decides_and_slow_drift_does_not_mp02_mp03`, `each_relay_session_starts_uncorrected_mp02`, `the_33_bit_wrap_is_crossed_in_both_directions` | same |
| MP03 | Within a session the corrected audio timestamps keep their order, and drift inside the threshold never changes the shift, so the sound does not jump. | `corrected_audio_stays_in_order_mp03`; drift case in the MP02 test | same |
| MP04 | `TrierMpegMediaDecoder` declares 16-bit PCM, 2 channels, at the stream's rate, and returns 384 or 1152 sample pairs per frame with the input's timestamp. A frame it cannot decode returns silence of the same length, never a gap. | `aDamagedFrameIsSilenceOfItsFullLengthNotAGap_MP04_MA03` | `TrierMpegMediaDecoderTest.kt` |

## Enforcement

- **Fast, every affected change:** the unit tests above (Rust, Android JVM, tooling).
- **Integration, when the relay, player or exit changes:** the real-HTTP relay tests, the Media3 decoder bridge, and the Windows yardstick (MA08).
- **Physical, at release or relevant changes:** `scripts/android-exit-check.mjs` on the Streamer, Sansui, Flip 2 and phone, plus ACC Network playback with sound.
