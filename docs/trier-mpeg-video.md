# Trier MPEG Video

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

Trier MPEG Video is GenX Streamer's own MPEG-2 video decoder, built on October 19–20, 2026, the video counterpart of [Trier MPEG](trier-mpeg.md) (sound). Like Trier MPEG, it is GenX's own engineering, written from the published standard, ITU-T H.262 | ISO/IEC 13818-2, with no third-party decoder code. FFmpeg (`node_modules/ffmpeg-static`) is used on the PC only as a measuring stick in tests; it is never shipped and none of its code is used.

## Why it exists

Owner decision, October 19, 2026: "There are tons of Samsung devices out there … it is imperative that we build the MPEG decoder for video playback. Maybe other platforms let it slide, but we can be the one that cared enough to fix the problem."

Several free US channels (A&E, ACC Network, AMC, AXS TV, AccuWeather NOW, Animal Planet, BBC America; all 1280×720 at 59.94 fps) broadcast MPEG-2 video. GenX hands MPEG-2 channels to the Android player (Media3). Whether that plays depends on the device:

| Device | MPEG-2 video decoder offered to apps |
| --- | --- |
| Sansui TV (Realtek), Google TV Streamer (MediaTek), Retroid Flip 2 (Qualcomm) | Yes, hardware |
| Galaxy S25 (Samsung) | None. Android's own `c2.android.mpeg2.decoder` ships on the phone, but is marked `domain="tv"` in the media codec list, and creating it by name fails with NAME_NOT_FOUND (tested) |

On the S25 these channels played sound over a black picture. Trier MPEG Video now shows the picture there. Devices with their own decoder keep using it.

## What it decodes

| | Supported |
| --- | --- |
| Profile | MPEG-2 Main Profile (Simple Profile is a subset), Main and High Level (720p, 1080i, 1080p) |
| Chroma | 4:2:0 |
| Pictures | I, P, B; frame pictures and field pictures; progressive and interlaced |
| Prediction | Frame, field, 16×8 and dual-prime; half-sample interpolation; concealment motion vectors read |
| Coding options | Both coefficient tables (`intra_vlc_format`), both scans (`alternate_scan`), linear and non-linear quantiser scale, intra DC precision 8–11 bits, downloaded quantiser matrices |
| Not supported | MPEG-1 video, 4:2:2/4:4:4 (4:2:2 Profile), scalable extensions. The stream is refused cleanly (the "sound only" note shows) |
| Damage | Never panics; an undecodable slice is concealed from the newest reference picture and decoding continues |

## Where the tables come from

Every variable-length code table (Annex B: B.1, B.2–B.4, B.9–B.15) is generated from the text of ITU-T H.262 (02/2000), the free edition on itu.int, by `scripts/trier-video/extract_tables.py` into `src-tauri/src/trier_video/annex_b.rs`. Nothing is retyped by hand. The extractor checks every table's row count. A test-time check found each table prefix-free with its code space filled, and Tables B.14 and B.15 cover the same 111 (run, level) pairs. The scans (Figures 7-2, 7-3), the default intra matrix (6.3.11), the quantiser scales (Table 7-6) and the dual-prime parameters (Tables 7-11, 7-12) were read from the standard's pages; Table 7-11 corrected a value the author had remembered the wrong way round.

## How it works

| Part | Source | Role |
| --- | --- | --- |
| Decoder | `src-tauri/src/trier_video/` (Rust) | `bits.rs` bit reader and table lookup; `tables.rs`/`annex_b.rs` the standard's tables; `idct.rs` the inverse DCT (Annex A, single precision, IEEE 1180 accurate); `mc.rs` predictions (7.6.4, 7.6.7); `picture.rs` frames, field pairs, references and display order; `macroblock.rs` slices, macroblocks, motion vectors (7.6.3 including dual prime), skipped macroblocks (7.6.6), coefficients, inverse quantisation and mismatch control (7.4) |
| Android bridge | `trier_video/android.rs` (JNI) and `TrierMpegVideo.kt` | `TrierMpegVideoDecoder` is a Media3 `SimpleDecoder`; `TrierMpegVideoRenderer` a `DecoderVideoRenderer` for `video/mpeg2`. Pictures go in whole; frames come back in display order by id and are drawn by the native side straight onto the player's surface (YV12), then their buffers are released |
| Selection | `GenXRenderersFactory.buildVideoRenderers`, `NativeVideoRules.needsTrierMpegVideo` | Added only when the device lists no MPEG-2 video decoder |
| Builds | `src-tauri/scripts/build-android.ps1 -Optimization 2` | The decoder needs optimised native code; phone builds use this switch |

Display order: a reference frame (I or P) is held until the next reference is decoded; B frames go out at once. Each frame keeps the time stamp of the data it came from, so Media3 presents it at the right moment. A B picture with no references (an open GOP at a join) is skipped, never shown wrong.

## Invariants

| ID | Invariant | Enforced by |
| --- | --- | --- |
| MV01 | Every table comes from the published standard, not retyped | `extract_tables.py`; `annex_b.rs` header; table tests |
| MV02 | The inverse DCT meets IEEE 1180 accuracy (peak ≤ 1, MSE ≤ 0.06 per position and ≤ 0.02 overall, mean error ≤ 0.015 and ≤ 0.0015, zero stays zero) | `idct::tests::meets_ieee_1180_accuracy` |
| MV03 | Decoded frames match the yardstick's decode frame for frame, in display order (≥ 45 dB required; measured 93–99 dB) | `trier_video::tests` (generated fixtures), `real_captures` (broadcasts) |
| MV04 | Damaged or truncated data never panics or stalls; slices are concealed | `damaged_data_never_panics`; JNI catches panics and resets |
| MV05 | Only devices without an MPEG-2 decoder use it; others keep their hardware | `needsTrierMpegVideo` (Kotlin test) |
| MV06 | Every output buffer is released after it is drawn (surface mode) | `TrierMpegVideoDecoder.render`; S25 run below |
| MV07 | Real time with headroom on the target phone: p99 under the frame period | Met at a fixed clock (benchmark, S25 performance cores: p99 6.3 ms). In the app the phone's governor chooses about 1 GHz and p99 is 22–23 ms, with no frames dropped; open (see Performance) |
| MV08 | The bridge is safe across Media3's two threads: the decoder thread (`decode`, `next`, `flush`, `counters`) and the playback thread (`render`, `release`) never share unsynchronised state | `android.rs`: each part of the state behind its own lock; the decoder's lock is never taken by the playback thread |
| MV09 | Speed changes keep the pictures bit-identical unless a conformance change is intended and re-proved | Benchmark output checksum (`4f0b0f5e753395a0` for A&E ×3); `real_captures` worst-frame dB unchanged; the same checksums on the PC and the S25 |
| MV11 (INV-PERF-TAIL) | Bounded playback pressure, owner invariant: the decoder records consecutive over-budget pictures, the most and fewest frames held, and the pressure (decode time beyond the frame interval still owed, carried from picture to picture) with the longest recovery after a burst. This, not every picture under 16.68 ms, is the measure of playback safety under Android scheduling | `android.rs` `Timing` (counters 8, 13, 26–31; logged every 1,800 pictures); S25: longest recovery 1–2 pictures, at least 6 of 8 frames held |
| MV14 (INV-AUTOTUNE-001 to 011) | Optimisation cannot override correctness: AutoTune may choose only implementations that passed the correctness and safety tests; every switch happens at a picture boundary, keeps reference and buffer ownership, and gives the same pictures under the conformance contract; a setting is preferred only on a repeatable improvement above the measured noise (full list: [trier-adaptive-engine.md](trier-adaptive-engine.md)) | Kit registry (`kit.rs`): only listed kits exist; `every_registered_kit_gives_the_portable_pictures`, `registry_is_consistent`; `set_kit` refuses unsupported CPUs and contract changes; the kit is chosen once per picture. Search, profiles and playback tuning: milestones 2 to 7 |
| MV13 | The decoder never takes the whole machine: half the cores at most (at most 4, at least 1), no spare frame buffers below 512 MB available memory, one worker below 192 MB (owner rule: a television also needs cores for sound, drawing, the network and the system) | `Resources`; `resources_leave_room_for_the_rest_of_the_device` |
| MV12 | Slices decoded on several cores give exactly the pictures one core gives; each worker writes only its own band of rows (exclusive borrows), the references are read-only, and per-slice state starts afresh in every slice | `Band`, `Slicer`, `run_slices`; `two_threads_give_the_same_pictures` (clean and damaged, progressive and interlaced); identical checksums with 1 and 2 threads on all seven broadcasts, PC and S25 |
| MV10 | Damage is contained: a slice that fails is concealed whole, and macroblock rows no slice reached are concealed, from the newest reference | `slice`, `conceal_missing_rows`; scorecard tests 4 and 5 |

## Evidence

Generated fixtures (`cargo test --lib trier_video`, ffmpeg-encoded test patterns, yardstick decode with `-idct faani`):

| Fixture | Content | Worst frame |
| --- | --- | --- |
| progressive | 352×288 I/P/B, GOP 12 | 99 dB (identical) |
| intra | all intra, high quality | 96.94 dB |
| options | intra VLC table one, alternate scan, non-linear quantiser, 10-bit DC | 99 dB (identical) |
| interlaced | 720×576 field DCT and field motion | 93.06 dB |
| hd | 1280×720 I/P/B | 99 dB (identical) |

Real broadcasts, 12 s each (721 frames), captured October 20, 2026 and kept outside the repository (`TRIER_VIDEO_CAPTURES=… cargo test --release --lib real_captures -- --ignored --nocapture`):

| Channel | Worst frame | PC decode speed (one core) |
| --- | --- | --- |
| A&E | 91.15 dB | 370 fps |
| ACC Network | 93.01 dB | 381 fps |
| AccuWeather NOW | 93.74 dB | 326 fps |
| AMC | 99 dB | 321 fps |
| Animal Planet | 91.41 dB | 306 fps |
| AXS TV | 96.98 dB | 325 fps |
| BBC America | 92.82 dB | 244 fps |

Galaxy S25 (SM-S931U), ARM64 debug APK with `-Optimization 2` (ced1e0cb), A&E (720p, 59.94 fps): the picture shows and moves (screenshots); over 30 s, 1,800 pictures in, 1,799 frames out and 1,791 drawn (the 8 undrawn were late at the join); decoding averaged 10.1 ms per picture, about 60% of one core.

Decode time per picture (an average hides hitches, so the tail is recorded too; owner request):

| Where | p50 / mean | p95 | p99 | Maximum | Budget at 59.94 fps |
| --- | --- | --- | --- | --- | --- |
| PC, one core, release build, seven broadcasts | p50 1.7–3.3 ms | 5.3–6.6 ms | 5.7–8.6 ms | 6.9–11.4 ms | 16.7 ms |
| Galaxy S25, A&E, 60 s (APK 2d820573) | mean 10.8 ms | 17.7 ms | 22.0 ms | 31.5 ms | 16.7 ms |

On the S25 about 5% of pictures take longer than one frame period. Nothing is dropped (3,591 of 3,599 drawn, the 8 at the join), because the decoder runs ahead in its own thread and Media3's buffers absorb the peaks, but the headroom is thin. Making the phone path faster is the next step (MV07).

Not yet verified: field pictures and dual-prime prediction against a real stream. ffmpeg cannot encode them, and these channels are progressive; the code follows 7.6.3.6 and Tables 7-11/7-12 exactly. A 1080i channel would close this.

## Performance (owner milestone, October 20, 2026)

Targets on the Galaxy S25: at first ≤ 9 ms average and ≤ 16 ms p95 per picture; stretch ≤ 7 ms average, ≤ 12 ms p95, ≤ 16 ms p99. Rules: profile before optimising, compare every change with an unchanged baseline on identical input, keep pictures and invariants intact, and reject gains that cost correctness or maintainability.

### Tools

`scripts/trier-video/bench/` compiles the decoder's own sources in place (no copy) into `trier-video-bench <file.m2v> [repeats] [budget-us] [nohash]`. It reports mean, p50, p95, p99 and maximum per picture, split by I/P/B, the pictures over the frame period and the longest run of them, the CPU clocks and temperatures before and after, and a checksum of every output frame. Profiles `genx-app` (release code generation with GenX's debug checks) and `genx-dev` (exactly what `build-android.ps1 -Optimization 2` compiles: dev profile, 256 code units) measured the same (32.4 and 32.9 G cycles), so build settings are not a factor. On the phone, `simpleperf stat` cycle counts are used for A/B decisions: they repeat within about 2%, while wall time varied ±15% between identical runs as the phone's clocks moved.

The app logs every 1,800 pictures (`adb logcat -s TrierMpegVideo`): decode mean/p95/p99/max, longest run over the frame period, the thread's CPU time per picture (against its wall time), the decoding core's sampled clock, which cores ran it, frames held (decoded, waiting or with the player), input-to-draw latency (mean, p95, maximum) and the frame period.

### Where the time went

Profile of the original decoder on the S25 (A&E, performance cores): motion compensation 44%, coefficient decoding 18%, inverse DCT 15%, adding and storing blocks 13%, memory fill/copy 6%, allocation under 0.1%. Separately, every picture allocated a fresh 1.4 MB frame: 340 page faults per picture and 0.4 ms of system time that user-mode cycle counts do not show.

### Changes, each measured against the one before (A&E ×3, 2,163 pictures, S25 performance cores)

| Change | Result | Decision |
| --- | --- | --- |
| Motion compensation rows as exact-length iterator zips (no per-sample bounds checks), so the compiler uses NEON (`urhadd`) | 38.9 → 32.7 G cycles (−16%); mean 4.27 → 3.56 ms; checksum unchanged | Kept |
| Inverse DCT as vector sums, skipping zero coefficients | I pictures 7.3 → 9.9 ms (the compiler left it scalar) | Rejected |
| Same, skipping only zero rows | Slower again | Rejected |
| Hand-written NEON inverse DCT, bit-identical (tested equal to the portable code on 200,000 blocks on the phone) | −1% cycles: the original was already vectorised by the compiler | Rejected: not worth `unsafe` code |
| Frame buffers reused once nothing else holds them (at most two spare) | Page faults 736,730 → 4,368; system time 0.9–1.2 s → 0.05 s; mean 3.4–3.7 → 2.9–3.0 ms; checksum unchanged | Kept |
| Block add and store through chunked iterators | +7% cycles | Rejected |
| Block add with `wrapping_add` (the sum cannot overflow; this lets overflow-checked builds vectorise) | −2% cycles, checksum unchanged | Kept |
| Android performance hint session (ADPF) for the decoding thread, target half and then a quarter of the frame period | Session created (`dumpsys performance_hint`), clock unchanged at about 1 GHz | Rejected: no effect on this phone |
| Reconstruction straight into the frame (predictions and residuals written in place; every coded block read first, so a macroblock that fails still leaves the frame untouched) | −8% cycles, −10% instructions | Kept |
| Whole-sample motion compensation copies of constant width (the compiler called the C library's memmove for each 8 or 16 bytes) | −5% cycles | Kept |
| Bit reader: one 8-byte load per peek instead of five checked byte loads | −5% cycles; I-picture p95 5.1 → 4.7 ms | Kept |
| Dequantisation with wrapping arithmetic | −0.8% | Rejected: too small for the extra reasoning |

Net, decoding only (`nohash`), S25 performance cores: mean 2.1 ms, p95 4.7 ms, p99 5.1 ms, maximum 6.6 ms, 7.1 M cycles per picture (about 12.3 M at the start, −42%). That meets the stretch targets at a fixed clock. On the PC, A&E went from 370 to about 500 pictures/s. The seven broadcasts' worst frames are unchanged (91.15–99 dB): the pictures are identical. Cache misses were measured and are not a factor (0.8% of loads miss L1; memory stalls 0.55% of cycles): the decoder is limited by instructions.

Integration overhead was measured too (owner's hypothesis, October 20): on GenX's decoder thread, Media3, JNI and the runtime are under 0.5% of the cycles; copying each frame to the surface on the playback thread is about 2%. The integration cost that mattered was inside the decoder, the macroblock staging buffer and its copy (about 12%), now removed.

### In the app: the governor sets the time

Latest, APK bc7e3f29 (all changes above): mean 8.2–8.3 ms (initial target met), p95 17.3–18.5 ms, p99 27 ms, maximum 32 ms; 7.2 M cycles per picture in the app's decoder thread at about 0.8–1.0 GHz; 3,591 of 3,599 drawn. The p95 is set by I pictures (one in twelve), which take about twice as long as P pictures at the low clock the governor picks; that is the open part of MV07. A 4.2-hour run of A&E on the S25 before these last changes drew 914,391 of 914,399 frames.

Earlier, GenX on the S25 playing A&E, 60 s, APK 1a9d0218: mean 9.7 ms, p95 17.4 ms, p99 23.5 ms, maximum 31.7 ms; longest run over the frame period 2 pictures; 3,591 of 3,599 frames drawn (the other 8 were still in the player's buffers); frames held 8 of 8, so the decoder stays ahead; input-to-draw latency about 150 ms (mostly the 8 buffered frames waiting for their time); thermal status 0 throughout.

The thread's CPU time per picture (9.5 ms) equals its wall time, so it is not waiting for a core. `simpleperf` on the app's decoder thread counted 9.2 M cycles per picture (9.7 M before the frame pool), close to the benchmark's 8.65 M (the rest is Media3's side of the same thread), at an average 0.92 GHz. The S25's governor (Qualcomm WALT, floor 557 MHz) picks the lowest clock that keeps up: the decoder runs ahead, fills the player's buffers and waits, so it looks lightly loaded. Fewer cycles therefore lower the clock (and the power) rather than the time per picture; a 30% faster decoder measured the same ~9.7 ms in the app. Android's performance hint did not change this. Nothing is dropped, and the decoder's own target is met at a fixed clock, but the in-app targets are not met yet.

What would move the in-app numbers: cutting cycles to about 5 M per picture brings the governor to its floor, after which savings show as time (the largest remaining parts are motion compensation 25%, coefficient decoding 22%, inverse DCT 22%, block add and store 19%); or decoding slices on two threads.

## Comparison with FFmpeg and libmpeg2 (owner request, October 20, 2026)

The same fixed corpus goes through Trier MPEG Video, FFmpeg 6.1.1 (its own `mpeg2video` decoder, from `node_modules/ffmpeg-static`) and libmpeg2 0.5.1 (built into the lab tool only; source from Debian's archive, `mpeg2dec_0.5.1.orig.tar.gz`, SHA-256 `dee22e89…71d4`, matching Debian's source listing and upstream's MD5 `0f92c745…`; GPL-2.0, kept outside the repository). Neither reference decoder is part of GenX.

Corpus: the five generated fixtures of `tests.rs` (progressive, intra, options, interlaced 576i, 720p) and the seven 720p broadcast captures. Damage: each stream × 7 kinds × 3 seeds = 252 variants (random bit flips, 20 and 200 per MB; lost 184-byte transport payloads, 20 and 100 per MB; 5% and 20% of pictures dropped; stream cut in half).

Tools: `scripts/trier-video/compare.py` (driver) and the lab commands in `scripts/trier-video/bench/` (`decode`, `compare`, `damage`, and with `TRIER_LAB_LIBMPEG2` set at build time `decode-libmpeg2`, `speed-libmpeg2`). On the PC libmpeg2 is compiled with `clang-cl` and keeps its MMX/SSE2 code (acceleration flags 29); on the S25 it is portable C, which is all libmpeg2 has for 64-bit ARM. Reports: `artifacts/trier-video-compare/<run>/report.md` and `report.json`.

```powershell
$env:TRIER_LAB_LIBMPEG2 = '<unpacked libmpeg2-0.5.1>'; $env:CC_x86_64_pc_windows_msvc = '<NDK>\bin\clang-cl.exe'
cargo build --release --offline --manifest-path scripts/trier-video/bench/Cargo.toml
python -B -X utf8 scripts/trier-video/compare.py --libmpeg2 --lab <trier-video-bench.exe> --captures <captures> --work <local path> --seeds 3
```

Run 20261020T140036Z (PC, Intel i9-14900K, one thread each unless noted):

| Test | Result |
| --- | --- |
| 1 Valid streams | PASS. All 12 decode. Worst frame against FFmpeg's float IDCT: Trier 91.15 dB, libmpeg2 61.96 dB |
| 2 Pixel by pixel | Bit-identical to FFmpeg's float IDCT in 1 of 12 streams; elsewhere at most 0.0012% of samples differ. MPEG-2 defines no single exact IDCT, so exact equality is expected only where both use the same arithmetic |
| 3 Reference compliance | PASS. IEEE 1180 (unit test). No sample differs from FFmpeg's float IDCT by more than 1; FFmpeg's own two IDCTs differ by more than 1 in 0.001–0.004% of samples |
| 4 Malformed streams | PASS. 252 damaged variants: no panic, crash or hang in Trier (nor in FFmpeg or libmpeg2) |
| 5 Damaged pictures | Mean PSNR against the clean decode, Trier / FFmpeg / libmpeg2: flips 20/MB 56.5 / 57.0 / 47.8 dB; flips 200/MB 29.5 / 32.1 / 24.6; loss 20/MB 46.0 / 50.1 / 39.3; loss 100/MB 27.2 / 30.4 / 23.6; 5% pictures dropped 86.8 / 87.2 / 65.8; 20% dropped 44.7 / 50.5 / 41.9; cut 97.1 / 97.6 / 71.2 (libmpeg2's figures include its ~62–71 dB clean difference). Trier is ahead of libmpeg2 and 0.5–5.8 dB behind FFmpeg, whose concealment guesses motion from neighbouring macroblocks |
| 6 Frame count and order | PASS. Every stream: the same frame count as FFmpeg, every frame matched in display order |
| 7 Speed | OPEN. 720p broadcasts, pictures/s, Trier / FFmpeg / libmpeg2: A&E 497 / 2,387 / 1,486; ACC 665 / 2,763 / 1,921; AccuWeather 803 / 3,176 / 2,341; AMC 471 / 2,192 / 1,674; Animal Planet 485 / 2,212 / 1,541; AXS 494 / 2,159 / 1,456; BBC America 355 / 1,883 / 1,350 (FFmpeg with all threads 7,100–8,700). FFmpeg is 4–5× faster on one core, libmpeg2 about 3× |

Found and fixed by the scorecard: after a loss, Trier concealed only the macroblocks after the point where decoding failed, but the bits before it are usually garbage that still parses; it now conceals the whole slice, and rows whose slice start code was lost (MV10). On the same damaged A&E clip, scored the same way: previous decoder 36.2 dB, now 46.9 dB, FFmpeg 50.5 dB. (The first scorecard run also had an alignment flaw that made damaged decodes look far worse than they were; fixed before these figures.)

Galaxy S25, performance cores, three passes of each capture, decoding only (GenX was playing in the background for both; cycle counts are per process):

| Capture | Trier pictures/s (cycles) | libmpeg2 C pictures/s (cycles) |
| --- | --- | --- |
| A&E | 495 (15.3 G) | 862 (8.6 G) |
| ACC Network | 582 (12.7 G) | 992 (7.3 G) |
| AccuWeather | 658 (11.3 G) | 1,112 (6.5 G) |
| AMC | 488 (15.2 G) | 891 (8.2 G) |
| Animal Planet | 431 (17.1 G) | 780 (9.4 G) |
| AXS TV | 445 (16.6 G) | 807 (9.1 G) |
| BBC America | 388 (19.1 G) | 708 (10.4 G) |

Even without SIMD on either side, libmpeg2 needs about 45% fewer cycles: the gap is in method (its integer IDCT with the residual added in the same pass, and its coefficient loop), not only in vector instructions. Trier's output checksums are identical on the PC and the S25 for all seven captures. Next: close the speed gap stage by stage against these two references on this corpus, and motion-guessed concealment for the remaining damage gap.

### Closing the speed gap, stage by stage (October 20, 2026)

Method: each stage's cost measured by subtraction on the S25 (builds that skip motion compensation, the inverse DCT or the block add; cycle counts, two rounds agreeing within 1%), each change A/B against the build before it with the output checksums unchanged on the PC and the S25, then pictures/s against FFmpeg and libmpeg2 on the scorecard corpus (`compare.py --speed-only`). Line-level profiles were tried and proved unreliable here (they twice pointed at code whose removal changed nothing), so subtraction and A/B decide.

A&E counts per picture: 12,958 coefficients, 5,484 coded blocks, 2,143 coded and 1,457 skipped macroblocks.

| Stage | Start of the round | Now (A&E ×3, S25) |
| --- | --- | --- |
| Parsing (bits, tables, vectors, slices) | 4.95 G cycles | 4.37 G |
| Motion compensation | 4.60 G | about 2.8 G |
| Inverse DCT | about 3.3 G | 2.92 G |
| Block add | 1.73 G | 1.20 G |
| Total | 14.3 G (6.6 M per picture) | 11.3 G (5.2 M per picture); libmpeg2 8.6 G |

| Change | Result | Decision |
| --- | --- | --- |
| Inverse DCT of only the corner the coded coefficients reach (1×1, 2×2, 4×4), coefficient 63 (mismatch control) added last: the same sums in the same order, so bit-identical (tested on 200,000 blocks) | −7% cycles; I-picture p95 4.7 → 3.8 ms | Kept |
| Also a 6×6 corner | +4% | Rejected |
| Corner transform in vector-row form | −0.2% | Rejected |
| Flat (DC-only) blocks added as one value | no change | Rejected |
| Sign bit from the same read as the coefficient code (tried twice) | −0.5%, −0.3% | Rejected |
| Motion compensation: one loop per width, half-sample position and averaging, fixed at compile time | −9.5% | Kept |
| …written as exact-length zips so it is vector code again (the indexed form was byte by byte) | −3.2% more | Kept |
| Block add in NEON (the compiler kept rows of 8 scalar); the portable code stays as the reference, tested equal on the phone | −4.4% | Kept |
| Two-level code tables (a 4 KB first level instead of 1 MB per DCT table) | −5.4%; L1 misses −42% | Kept |
| References lent instead of shared per macroblock | −0.5%, simpler | Kept |

PC, one core, pictures/s Trier / FFmpeg / libmpeg2 (runs vary about 10% with the PC's load, so the ratios matter): A&E 570 / 2,253 / 1,429 (0.25× FFmpeg, 0.40× libmpeg2; 0.20× and 0.32× before); 720p fixture 743 / 1,667 / 1,448 (0.45×, 0.51×; 0.33×, 0.37× before).

In the app on the S25 (APK 71209087, A&E 60 s): mean 6.9–7.3 ms (initial target met, at the stretch target), p95 16.1–16.2 ms (just over the 16 ms target), p99 22 ms, 3,591 of 3,599 drawn, 6.6 M cycles per picture in the decoder thread (7.2 M before).

#### A faster inverse DCT algorithm, then parsing (October 20, 2026)

An even/odd (symmetry) 8-point inverse DCT, derived from the same cosine basis (22 multiplications per pass instead of 64), passes IEEE 1180 but loses to the existing code on the phone in every arrangement measured: for all blocks +17% cycles; only for blocks reaching row or column 4 or beyond +2.4%; that with both passes eight-wide +5%. The compiler vectorises the direct form cleanly but left much of the symmetric form scalar, and dense blocks are only 6.6% of decoding (measured by subtraction), so even a perfect dense transform would save at most about 4%. Rejected; the inverse DCT is unchanged, so Trier's pictures are unchanged and the scorecard results stand (identical checksums on the PC and the S25).

Parsing: about 34 cycles per coefficient. Removing a read that is not on the chain from one code to the next changed nothing (twice), which pointed at the chain of dependent steps rather than instruction count. Packing run, level and kind into the table entry itself (no second lookup into a value list) took one load off that chain: −4.0% cycles with only −1.4% instructions; kept. A bit reader holding a 64-bit window (reads as shifts) was +5%: refills are frequent with reads of up to 32 bits, and the core already hid the load; rejected.

Now (A&E ×3, S25): 10.85 G cycles (start of the day 14.3 G, libmpeg2 8.6 G). PC one core: A&E 591 / 2,411 / 1,498 pictures/s Trier / FFmpeg / libmpeg2 (0.25×, 0.39×). In the app (APK 68f9fb84, A&E 60 s): mean 6.9–7.1 ms, p95 12.6–14.0 ms, p99 19.8–21.6 ms, maximum 23–26 ms, 3,591 of 3,599 drawn, 5.2 M cycles per picture at about 0.72 GHz. Both initial targets are met (≤ 9 ms mean, ≤ 16 ms p95); of the stretch targets the mean is at 7 ms, p95 is close to 12 ms, and p99 (≤ 16 ms) is not yet met.

### Where the tail comes from (owner question, October 20, 2026)

Question: is the p99 (about 20–22 ms against a 7 ms mean) computational or environmental? A per-picture trace answers it: `adb shell setprop debug.genx.trier.trace 1` before the player starts logs one line per picture (tag `TrierMpegVideoTrace`: type, structure, coefficients, coded/intra/skipped macroblocks, wall and thread CPU time, core, core move, clock, frames held, pressure); `scripts/trier-video/tail_analysis.py` relates them. (A per-thread cycle counter is in the trace too, but Android refuses `perf_event_open` to the app, so the clock comes from cpufreq after each call.) The benchmark prints the same per picture with `trace` (fixed clock), and `damage … intra:1` makes an I-pictures-only stream.

A&E on the S25, 4,658 pictures after warm-up (APK 9061c63d):

| | All pictures | Slowest 5% | Slowest 1% |
| --- | --- | --- | --- |
| I pictures | 7% | 79% | 96% |
| Coefficients per picture | 13,034 | 63,781 | 81,690 |
| Waiting for a core (wall − CPU time) | 145 µs | 354 µs | 413 µs |
| Core moved since the last picture | 27% | 21% | 23% |
| Frames held, fewest | 6 | 6 | 6 |

Correlation of decode time with coefficients 0.71, with core moves −0.11. Against the median picture of its own type, the slowest 1% are slow because of more work (63%) and a lower clock (35%); waiting for a core is 3%. I pictures: median 16.1 ms, p99 24.2 ms; P pictures: median 6.3 ms. Verdict: the tail is computational, dense I pictures, amplified by the low clock the governor chooses for a light average load; core migration and scheduling are minor, and playback is never at risk (MV11).

I-picture cost by subtraction (all-intra A&E ×10 on the S25, 11.2 M cycles per I picture): inverse DCT 40%, parsing 42%, block add 18%. The dense IDCT matters here, unlike in P pictures, so the even/odd transform was tried once more with explicit 8-lane code (NEON, SSE2 and plain, the same operations in each, tested equal and IEEE 1180-accurate): +5.5% on I pictures. Without its two transposes it is only 3% faster than the direct form, so arithmetic is not what limits the IDCT; rejected. The NEON direct form re-tested: +0.4%, rejected.

Owner rule from here: any change that measures better is kept, however small. Re-tested on the current decoder, three rounds each: wrapping dequantisation −1.1% (kept); the sign bit from the same read as the code −0.6% alone but nothing on top of the dequantisation (not kept: the two together measured the same as the dequantisation alone).

Latest in the app (APK a4834564, A&E 60 s): mean 6.9–7.2 ms, p95 15.6–16.0 ms, p99 19.8 ms, maximum 24.7 ms, 3,591 of 3,599 drawn; INV-PERF-TAIL: most pressure 8.0 ms, longest recovery 2 pictures (42.5 ms), at least 7 of 8 frames held. p95 varies from run to run with the channel's content and the clock (12.6 to 16 ms across today's runs).

### Two-core slice decoding (owner decision, October 20, 2026)

A picture's slices are collected and decoded together. With two threads (`Decoder::set_threads`; the Android bridge uses two on devices with at least four cores, `adb shell setprop debug.genx.trier.threads 1` forces one for tests) the frame is split into two bands at the row where the slice data divides in half, and the second band is decoded on another core at the same time (`std::thread::scope`, joined before the picture completes). Each worker owns its band exclusively, so no two can write the same samples; concealment of a failed slice happens in the worker that owns its row, and rows no slice reached are concealed afterwards. MV08 (the bridge's threads) is unchanged: slice threads exist only inside one `decode` call. The pictures are identical with one or two threads (MV12).

S25 benchmark, A&E ×3, performance cores: mean 1.48 → 0.90 ms, p95 3.15 → 1.80 ms, p99 3.71 → 2.15 ms, I pictures mean 3.25 → 1.86 ms; total cycles +0.7% (thread start and join). Splitting by slice bytes instead of row count balanced the halves: p99 a further −17%.

In the app, same APK and channel, one thread forced against two (60 s each): mean 6.96 → 4.67 / 4.08 ms, p95 16.9 → 10.1 / 9.6 ms, p99 23.4 → 13.4 / 15.9 ms, maximum 30.6 → 16.1 / 18.2 ms; INV-PERF-TAIL pressure 13.9 → 0 / 1.6 ms, bursts 188 → 0 / 13; whole-app CPU 0.72 → 0.79 / 0.71 cores (no measurable increase). Final APK eae18da9: mean 5.2 ms, p95 10.0 ms, p99 13.7 ms, maximum 15.8 ms (every picture inside the frame interval), pressure 0. All targets are met, the stretch ones included (≤ 7 ms mean, ≤ 12 ms p95, ≤ 16 ms p99).

Scorecard run 20261020T193928Z (PC): correctness unchanged (tests 1, 3, 4, 6 PASS; damage results identical). Two cores each, pictures/s Trier / FFmpeg: A&E 626 / 3,068; ACC 1,248 / 4,775; AccuWeather 1,516 / 5,042; BBC America 685 / 3,307. One core: A&E 478 / 1,965 / 1,384 (libmpeg2). FFmpeg's thread counts were set explicitly (`-threads 1`, `2`, `0` for automatic).

Test bed, for comparing like with like: the PC is an Intel i9-14900K (8 performance cores with hyper-threading, 16 efficiency cores) on Windows; FFmpeg 6.1.1 (gyan.dev build, gcc 12.2) uses its hand-written assembly with run-time dispatch (AVX2 here) and its integer IDCT by default, and is timed as a whole process; Trier is Rust at opt-level 3 for the x86-64 baseline (SSE2), timed inside its decode calls; libmpeg2 0.5.1 is built with clang-cl with its MMX/SSE2 code, timed inside its parser. Runs were not pinned to a core. A matched protocol (same core, same timing boundary, same instruction set and as built, FFmpeg with integer and float IDCT, an FFmpeg build for the S25) is the next step before claiming any speed result.

### Several cores, scaled to the device (owner requests, October 20, 2026)

From two cores to N: every macroblock row is its own exclusive band, and workers take the next row with slices as soon as they are free, so busy or slower cores (big.LITTLE) take fewer rows and dense rows balance by themselves (against fixed bands cut at even byte shares: p99 at 4 workers 1.66 → 1.25–1.35 ms on the S25 benchmark). Pictures are identical for 1, 2, 3, 4 and 8 workers (test on clean and damaged, progressive and interlaced; checksums on the PC and the S25). Worker threads have 256 KB stacks; a thread that cannot be started simply takes no rows.

The number of workers comes from `Resources::detect()`: half of the cores the process may use (which respects affinity and container limits), at most 4, at least 1; and from memory: below 512 MB available no spare frame buffers are kept, below 192 MB one worker. The S25 (8 cores) gets 4, a 4-core television 2. `adb shell setprop debug.genx.trier.threads N` overrides the workers for tests, `debug.genx.trier.adaptive 1` sizes them by each picture's slice data (one per 20 KB).

Energy and heat, S25 on battery (owner question: two cores or four at lower load?), A&E 60 s per run, two passes in opposite order, battery current and voltage, the hottest CPU zone and cluster clocks sampled every 2 s:

| Workers | Power (W) | Hottest CPU | Mean | p95 | p99 | Maximum | Bursts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.14 / 1.34 | 42.7 / 42.0 °C | 5.5 / 5.9 ms | 12.8 / 15.0 | 18.0 / 21.1 | 22.6 / 28.6 | 89 / 168 |
| 2 | 1.83 / 1.27 | 42.6 / 41.8 °C | 4.1 / 3.8 ms | 8.8 / 9.4 | 12.6 / 13.3 | 16.0 / 20.5 | 0 / 8 |
| 4 | 1.16 / 1.67 | 42.6 / 42.4 °C | 3.1 / 3.0 ms | 6.1 / 6.3 | 7.9 / 9.1 | 12.5 / 12.7 | 0 / 0 |
| 4, adaptive | 1.25 / 1.75 | 42.6 / 42.2 °C | 4.6 / 5.5 ms | 8.7 / 10.9 | 10.5 / 12.6 | 13.5 / 18.0 | 0 / 2 |

The same configuration varies by about ±0.3 W from run to run (screen, network, sampling), more than any difference between configurations: the decoder's share of the phone's power is not measurable this way, and the temperature is the same (about 42 °C) in every case. Four workers give the best tail by a wide margin, so they are the default; adaptive saved 2.4% of cycles on the benchmark but gave a worse tail and no measurable saving, so it is not. Final APK b60ce385 (default, on battery): mean 3.4 ms, p95 7.4 ms, p99 10.2 ms, maximum 17.9 ms, one burst.

Unpinned benchmark runs mislead here: a single thread is placed on a 4.47 GHz prime core and extra workers on 3.5 GHz cores, and starting and joining workers per picture costs more at full clock (pictures under 1 ms) than in the app (several milliseconds at under 1 GHz). The in-app figures are the ones that matter for playback.

FFmpeg's MPEG-2 decoder threads by slices only (`-h decoder=mpeg2video`), as Trier does.

### FFmpeg on the S25, matched conditions (October 21, 2026)

FFmpeg 6.1.1, the same version as on the PC, built from the official source (`ffmpeg-6.1.1.tar.xz`, SHA-256 `8684f4b0…f968`, good signature from the FFmpeg release key FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8) for ARM64 with NEON with the NDK's clang 19, configured with only the MPEG-2 decoder, the elementary-stream demuxer and the null muxer; measuring only, kept outside the repository (`<local path>`). Conditions identical for all three: the same capture decoded three times, whole process, frames discarded, pinned to the same cores, on battery (94%), 1, 2 and 4 threads; cores used = (user + system time) / wall time. Script `scripts/trier-video/phone-compare.sh` (pushed to `/data/local/tmp` with the lab tool, the FFmpeg build and the capture).

A&E, performance cores (taskset 3f, 6 × 3.53 GHz), pictures/s, two rounds:

| Threads | Trier | FFmpeg | libmpeg2 (C) | FFmpeg ÷ Trier |
| --- | --- | --- | --- | --- |
| 1 | 687 / 593 | 1,482 / 1,319 | 869 / 754 | 2.2× |
| 2 | 1,176 / 1,020 | 2,403 / 2,142 | — | 2.1× |
| 4 | 1,690 / 1,513 | 3,433 / 3,090 | — | 2.0× |
| Cores used at 4 threads | 1.6 | 2.5 | — | |

Unrestricted (all 8 cores) a single thread is placed by the scheduler, sometimes on a 4.47 GHz prime core: Trier 1,082 / 1,006 against FFmpeg 1,151 / 957, which looks like a tie but is placement, not the decoders; pinned runs are the fair ones. FFmpeg is about twice as fast on the S25 at every thread count (about four times on the PC, where it uses AVX2). Trier's workers keep fewer cores busy (starting and joining threads for every picture, and the parts still done on one thread: finding start codes, concealing missing rows, clearing the frame). The next targets: a persistent worker pool with that remaining work moved into the workers, and single-core efficiency (NEON for motion compensation and the coefficient loop), measured against these figures.

### Persistent worker pool (October 21, 2026)

The slice workers' threads now start once per decoder (`pool.rs`) and wait between pictures; `run(job)` calls the job on every helper and on the calling thread and returns only when all have finished, which is what lets the job borrow the picture's bands and slices (one small `unsafe` lifetime erasure, tested: every thread runs each job once, borrows stay valid, a helper's panic reaches the caller and the pool goes on). The serial clearing of a reused 1.4 MB frame buffer before every picture moved into the workers: each clears its own macroblock row just before that row's first slice (frame pictures and first fields; rows no slice reached are cleared in the concealment pass), so every sample is still cleared exactly once before it is written. Pictures unchanged (checksums at 1 and 4 workers on the PC and the S25; equality tests for 1 to 8 workers).

S25, A&E ×3, performance cores, whole process (on battery):

| Workers | Before (threads per picture) | Pool | User cycles before / pool |
| --- | --- | --- | --- |
| 1 | 586 / 632 pictures/s | 596 / 603 | 10.92–10.96 G / 10.91–10.93 G |
| 2 | 1,060 / 1,030 | 1,188 / 1,104 | |
| 4 | 1,626 / 1,502 | 2,060 / 1,931 (+27%) | 11.21 G / 11.18–11.20 G |

The pool does the same work (same cycles) on more cores at once; the shell's `time` had under-counted the old short-lived threads, so its "cores used" (1.6 against the pool's 3.4) is not a fair measure there, and cycle counts are used instead. In the app (APK ab1c2e53, A&E, two runs of 60 s): mean 2.8 / 3.1 ms, p95 6.1 / 5.5 ms, p99 8.2 / 6.7 ms, maximum 11.6 / 9.8 ms, no pressure; three `trier-slices` threads, none left behind after a channel restart.

Matched S25 comparison with the pool (same conditions as above): pictures/s Trier / FFmpeg, 1 thread 593 / 1,327 and 586 / 1,343; 2 threads 1,092 / 2,142 and 1,109 / 2,351; 4 threads 1,931 / 3,181 and 2,080 / 3,328 (FFmpeg 1.6× faster at four, from 2.0×). Work for the same pictures, user cycles: FFmpeg 4.6–4.7 G, libmpeg2 8.5–8.6 G, Trier 10.9–11.1 G. Trier spends about 2.35 times FFmpeg's cycles per picture: the remaining gap is single-core efficiency, not threading.

### Single-core efficiency against FFmpeg, round 1 (October 21, 2026)

Debug checks were most of the gap. GenX's Android debug packages (and the benchmark built to mirror them) keep debug assertions and overflow checks on; in the hot loops that meant an overflow check on every row offset and a non-overlap assertion on every NEON load and store. Built as a release (what a shipped decoder is, and how FFmpeg was built), the same Trier code needs 7.64 G cycles and 18.7 G instructions for A&E ×3 instead of 10.36 G and 31.1 G, with identical pictures. Comparisons with FFmpeg are made release against release from here on; the earlier "2.35×" compared a checked Trier with an optimised FFmpeg.

Matched S25 comparison, release Trier, performance cores, whole process, on battery (two rounds), pictures/s Trier / FFmpeg / libmpeg2: 1 thread 983 / 1,492 / 842 and 932 / 1,327 / 738; 2 threads 1,730 / 2,430 and 1,502 / 2,121; 4 threads 2,846 / 3,228 and 2,486 / 3,046. Trier now beats libmpeg2 on one core (1.17–1.26×) and is within 13–23% of FFmpeg at four threads. Work: Trier 7.65 G cycles, FFmpeg 4.56 G (1.68×).

Stage costs on the release build (subtraction, A&E ×3): parsing 3.53 G, inverse DCT 2.65 G, motion compensation 1.27 G, block add 0.41 G.

| Change (release builds, S25) | Result | Decision |
| --- | --- | --- |
| Motion compensation rows in NEON (`mc::neon`; the block's ranges checked once; vrhadd and vrshrn are the same arithmetic), tested equal to the plain code for every case | −5.3% cycles, −7% instructions (measured on the checked build), pictures identical | Kept |
| Even/odd inverse DCT for dense blocks (reach ≥ 4) with explicit 8-lane code (NEON, SSE2, plain; the same operations, tested equal), re-tested on release builds: rejected four times on the checked build, where every NEON load paid for an assertion | −7.6% on A&E, −7.9% on all-intra A&E; pictures change within IEEE 1180 | Kept, re-proved (below) |
| NEON direct-form inverse DCT, bit-identical | −4.5% (the even/odd form is better) | Not kept |
| Even/odd for every block instead of the corner paths | +5% | Rejected |

Re-proof of the even/odd inverse DCT: IEEE 1180 (unit test, the dense path included); checksums identical on the PC (SSE2) and the S25 (NEON), so Trier stays bit-identical across x86 and ARM; scorecard run 20261020T222206Z (quick): valid streams PASS (worst frame 91.15 dB, unchanged), reference compliance PASS (no sample off by more than 1 from FFmpeg's float IDCT), malformed streams PASS, frame count and order PASS. In the app (APK d14eab3c, debug build): mean 2.9 ms, p95 6.7 ms, p99 8.9 ms, maximum 11.7 ms.

Next: parsing (46% of the release cycles: the coefficient loop and the per-macroblock control), then an integer inverse DCT (FFmpeg's is integer, eight lanes per register against four for single precision).

### Parsing round: the coefficient loop (October 21, 2026)

All release builds, A&E ×3, one worker, S25 cores 0–5, `simpleperf` user cycles; each change compared with the build before it, interleaved, pictures checked first.

| Change | Result | Decision |
| --- | --- | --- |
| The sign bit from the same read as the code (`decode_packed_with_next`) | −1.2 to −1.5% cycles | Kept |
| `#[inline(always)]` on the table decoders | −0.6% cycles, −0.9% instructions | Kept |
| Pre-multiplied scale table with masked indices | Slower (rebuilt whenever quantiser_scale changes) | Rejected |
| 64-bit bit-reader window | No gain | Rejected |
| Zeroing the block inline | Identical machine code | Rejected |
| Block decoding on a local copy of the bit reader | +0.4% | Rejected |
| Native CPU build (`target-cpu=oryon-1`) | −0.7% in 2 of 3 rounds, tied in 1; would need run-time dispatch | Rejected (below noise) |
| Coefficient decoding research (owner brief): H1 negative-offset position counter with a scan-ordered position/weight table, H2 branchless sign and reconstruction, H3 two codes per table read; all 8 combinations, then the pair window (10, 11, 12 bits) | H1+H2+H3, 11-bit window: 6.81 G against 6.97 G cycles (−2.3%), −3.7% instructions, L1 misses +9%; better in all 5 rounds; H1 or H2 alone +0.5% (the compiler made the same code), but each helps with H3 | Kept; 10- and 12-bit windows kept as candidates |

The research round, its search path, interactions and evidence are in the first Performance Discovery Report, [trier-discovery-2026-10-21-coefficients.md](trier-discovery-2026-10-21-coefficients.md). Proof for the kept form:
- Pictures: identical checksums on the S25 for all 8 combinations and 3 windows.
- Recovery: an identical digest on the PC over 84 runs per build (12 clean streams and 30 damaged variants, flip/loss/drop/cut with seed 7, at 1 and 4 workers).
- Unit tests: `branchless_reconstruction_matches_dequant` (every magnitude, sign and quantiser_scale) and `pair_table_matches_single_codes` (every window, both tables).

Quick scorecard after the round (run 20261020T235913Z, PC, three seeds):
- valid streams PASS (worst frame 91.15 dB, unchanged);
- reference compliance PASS;
- 63 malformed variants PASS, with no unsafe failure;
- frame count and order PASS.

On the 42 damaged variants it shares with the previous run (two seeds), Trier's outcomes and picture quality are identical; its lower damaged-picture averages come from the third seed's variants only.

At commit 55b031c the build switches `TRIER_NO_H1`, `TRIER_NO_H2`, `TRIER_NO_H3`, `TRIER_PAIR10` and `TRIER_PAIR12` selected the variants. Since milestone 1 (below), the qualified ones are registered kits instead.

Matched S25 comparison after this round (release Trier, cores 0–5, whole process, on battery, two rounds), pictures/s Trier / FFmpeg / libmpeg2:
- 1 thread: 1,092 / 1,482 / 848 and 1,066 / 1,534 / 838.
- 2 threads: 1,931 / 2,377 and 1,881 / 2,430.
- 4 threads: 3,090 / 3,277 and 3,135 / 3,328, so Trier is within 6% of FFmpeg.

Work for the same pictures:
- Trier 6.88 G user cycles against FFmpeg's 4.62 G on one thread (1.49×, from 1.68× at the start of round 1 and 1.52× before the research round).
- 7.02 G against 4.65 G with four.

Trier beats libmpeg2 on one core by 1.27–1.29×. FFmpeg stays faster per picture. The remaining gap is mostly the inverse DCT (FFmpeg's integer IDCT does eight lanes per register) and the per-macroblock control.

### Adaptive engine, milestone 1: kit registry and capability detection (October 21, 2026)

Owner approval of [trier-adaptive-engine.md](trier-adaptive-engine.md), milestone 1.

**Structure.** The slice decoder is generic over a **kit**: one coefficient decoder, one inverse DCT, one motion compensation and one block add (`kit.rs`). So each kit is compiled whole, and choosing one costs a match per picture (`with_kit!` in `run_slices` and the concealment pass), nothing per block. There is still one slice decoder in the source, with no duplication.

- **Coefficient decoders** are parameter sets read by the one existing loop: negative offset, branchless, pairs and the pair window.
- **Kernels** are the existing NEON, SSE2 and plain forms behind small traits.
- The `TRIER_NO_H*` build switches are gone: the qualified variants are now kits.
- **`Decoder::set_kit`** changes the kit from the next picture on. It refuses a kit the CPU cannot run, and a change of numerical contract, which none of today's kits has: all are bit-exact.
- **The bench** takes `TRIER_VIDEO_KIT=<name>`, and `trier-video-bench kits` prints the detected machine and the registry.

**Registered kits:**

| Kit | Parts | Needs | Why registered |
| --- | --- | --- | --- |
| default | pairs11 coefficients, IDCT NEON (SSE2 on x86), MC NEON, add NEON (portable on x86) | NEON or SSE2 | Fastest measured on the S25; the build-time choice before the engine |
| portable | single-code coefficients, plain IDCT, MC and add | nothing | Fallback everywhere (INV-AUTOTUNE-007) and the test reference |
| pairs10 | default with an 8 KB pair window | NEON or SSE2 | Smaller data caches |
| pairs12 | default with a 32 KB pair window | NEON or SSE2 | Larger data caches |
| compact | default kernels, single-code coefficients (no pair tables) | NEON or SSE2 | The smallest caches |

**Capability detection (`platform.rs`, std only).** It reports:
- the architecture and instruction sets (NEON, SSE2, AVX2, dot product; 32-bit ARM NEON from `/proc/cpuinfo`);
- the usable and allowed cores;
- the clusters, by maximum frequency and kernel capacity;
- available memory and the SoC name.

On the S25: `aarch64`, NEON and dot product, 6 × 3.53 GHz (capacity 765) and 2 × 4.47 GHz (1024), 4.4 GB available, SoC "SUN". On Windows the frequencies and memory read as unknown. Windows cluster detection (`GetLogicalProcessorInformationEx`) waits for the Windows build to use Trier. Thermal state comes from the app (milestone 6).

**Zero-cost proof.**

1. **The kit parameter alone (build m1 against commit 55b031c, m0):**
   - identical S25 checksums;
   - identical PC digest `e0d6d3ff0c5f5e68` over 84 clean and damaged runs;
   - S25 cycles 6.780 against 6.809 G (5 rounds, within noise), with 0.8% fewer instructions: the pair table is now chosen once per slice instead of per block.
2. **The full registry (m2):**
   - S25 default kit 6.785 G (6.744–6.817) against m0 6.810 G (6.801–6.821) and m1 6.801 G;
   - text size +119 KB (546,511 → 665,975 bytes, about 30 KB per extra kit).
   - PC, pinned to one core, 7 rounds, median of mean decode time per picture: m0 1,765 µs (1,719–1,940), m1 1,730 µs (1,711–1,880), m2 1,798 µs (1,764–1,928). m2 is within m0's range but about 4% above m1. **A small x86 cost is not ruled out**; it is to be re-measured with the milestone 2 harness (CPU time, more rounds).

**Qualification matrix:**

| Test | default | portable | pairs10 | pairs12 | compact |
| --- | --- | --- | --- | --- | --- |
| Portable kit's pictures and refused units, progressive (B.14), interlaced and intra-VLC/alternate-scan (B.15) streams, clean and damaged, 1 and 4 workers (PC test) | Same | Reference | Same | Same | Same |
| S25 digest: A&E and BBC America captures + 12 damaged variants, 1 and 4 workers (28 runs) | `88cefa6a26258bde` | same | same | same | same |
| Unit equivalence of its parts (`row_kernel_matches_plain_code`, `dense_vector_form_matches_plain`, `add_row_saturates_like_the_plain_sum`, `branchless_reconstruction_matches_dequant`, `pair_table_matches_single_codes` for windows 10–12) | Pass | — | Pass | Pass | Pass |
| IEEE 1180 (MV02) | Pass (the same IDCT values for every kit) | | | | |

**S25 cost per kit** (A&E ×3, one worker, cores 0–5, 5 rounds):

| Kit | Cycles | vs default | Instructions | L1D misses | Branch misses |
| --- | --- | --- | --- | --- | --- |
| default | 6.785 G | — | 16.48 G | 56.4 M | 56.8 M |
| pairs10 | 6.809 G | +0.4% | 16.52 G | 54.6 M | 59.3 M |
| pairs12 | 6.844 G | +0.9% | 16.46 G | 62.0 M | 55.8 M |
| compact | 6.977 G | +2.8% | 17.22 G | 52.3 M | 52.4 M |
| portable | 8.783 G | +29% | 25.30 G | 48.0 M | 52.3 M |

The default stays the default on the S25. The other kits are candidates for devices whose caches and predictors differ; the Flip 2 and the Streamer are to be measured in milestone 4.

The 32-bit ARM build compiles cleanly (`cargo check --target armv7-linux-androideabi`). That is not a test of the Streamer, which was in use and was not disturbed.

**Tests:** decoder 27 passed (new: `every_registered_kit_gives_the_portable_pictures`, `registry_is_consistent`, `cpu_lists_parse`, `detection_reports_this_machine`). Clippy is clean for the library and the tests.

**Evidence:** `artifacts/trier-video-discovery/20261021-kits/`.

### Adaptive engine, milestone 2: deterministic calibration harness (October 21, 2026)

**Samples.** `scripts/trier-video/calibration_samples.py` generates six fixed streams:
- the classes are SD 480i (29.97), 720p (59.94) and 1080i (29.97), each with an inter-heavy form (GOP 15, two B pictures) and an intra-heavy one (all I pictures);
- the source is ffmpeg's synthetic `testsrc2` pattern with seeded noise, encoded single-threaded in bit-exact mode by the project's ffmpeg 6.1.1 (`node_modules/ffmpeg-static`, a yardstick, never shipped);
- there is no user content and no network.

The manifest is recorded in `scripts/trier-video/calibration-samples.tsv` (size and FNV-1a 64 per file). `--check` regenerates the samples and compares: a second generation in another folder was byte-identical. The harness refuses any sample whose size or checksum differs from the manifest.

**Measurement core, `trier_video::tune`** (in the library, so the app can use it in milestone 6):
- `Config`: kit, workers, adaptive.
- `run`: a fresh decoder per run, the sample decoded over enough passes for at least 300 pictures. It records:
  - wall time;
  - process CPU time;
  - user cycles of every thread (Linux and Android perf counter with `inherit`, added as the pool's threads exit; Windows `QueryProcessCycleTime`);
  - mean, p95, p99 and maximum decode time per picture;
  - pictures over the frame period and the longest run of them;
  - INV-PERF-TAIL pressure;
  - peak resident memory (reset per run on Linux and Android; the process peak on Windows).
- `fingerprint`: each configuration's output (pictures and refused units) is compared with the incumbent's before any timing. A configuration that decodes differently is excluded, never timed.
- `trial`: rounds of A B A, then B A B, alternately. Noise is the spread of the configuration run twice in a round (the median over rounds), and the threshold is the larger of 3 × noise and 1%. The verdict is Better or Worse only when every round agrees beyond the threshold, else Inconclusive. A deadline bounds every trial, and trials it stops are reported as not run.

**Bench:**
- `trier-video-bench calibrate <samples> [--configs] [--rounds] [--metric] [--pictures] [--budget] [--affinity] [--json]` prints the verdicts and writes every run's metrics with the machine, conditions, registry and settings to JSON.
- `trier-video-bench cross <rounds> <exe>... -- <args>` compares separate builds' process cycles on the same core, with the starting build rotating each round.

**The PC registry cost, re-measured with `cross`** (A&E ×3, one worker, core 2, 7 rounds, median cycles):
- **The cost was real.** Commit 55b031c: 11.23 G. The one-kit build: 11.25 G. Milestone 1's five-kit registry: 11.47 G, +2.1%, with no overlap in the ranges.
- **Two hypotheses were tested and rejected:**
  - a per-kit copy of `mc::predict`: 11.57 G, no change;
  - code-generation units: with one unit, 10.99 G against 11.38 G, so the gap persists. Single-unit builds are 2–3% faster for both, a separate finding.
- **The cause** was the dense and corner inverse DCT, shared out of line by the four SSE2 kits. With one kit it had a single caller, which the compiler inlines.
- **The fix is per architecture.**
  - Forcing inlining on all architectures fixes the PC (11.27 G) but costs **13% on the S25** (7.72 against 6.79 G), where the out-of-line copy is better.
  - So inlining is forced on x86-64 only (`cfg_attr`).
  - Result: PC 11.30 G against the commit's 11.18 G, ranges overlapping (from +3.4%); S25 6.791 G against milestone 1's 6.780 G.
  - Pictures are identical (PC digest `e0d6d3ff0c5f5e68`, S25 kit digests `88cefa6a26258bde`).

**First calibrations** (all six samples; every kit on one worker, and the default kit on 2 and 4; 3 rounds; decided on cycles).

S25, cores 0–5, on battery (59%), 39–61 °C:

| Sample | portable/1 | pairs10/1 | pairs12/1 | compact/1 | default/2 | default/4 |
| --- | --- | --- | --- | --- | --- | --- |
| sd-inter | +56.6% worse | +1.9% worse | +0.5% inconclusive | +4.4% worse | +2.6% worse | +3.1% worse |
| sd-intra | +22.9% worse | +2.0% worse | +1.5% worse | +7.0% worse | +2.1% worse | +2.0% worse |
| hd720-inter | +50.2% worse | +0.7% inconclusive | +0.1% inconclusive | +3.9% worse | +2.6% worse | +3.0% worse |
| hd720-intra | +11.3% worse | +0.8% inconclusive | +0.7% inconclusive | +3.5% worse | +1.8% worse | +1.6% worse |
| hd1080i-inter | +44.7% worse | +1.4% inconclusive | +0.9% inconclusive | +3.4% worse | +0.4% inconclusive | −1.1% inconclusive |
| hd1080i-intra | +14.2% worse | +0.6% inconclusive | +1.2% inconclusive | +4.2% worse | +0.4% inconclusive | +0.5% inconclusive |

Noise was 0.03–1.4%. **The default kit is the cheapest in CPU on every S25 class.** Extra workers cost up to 3% more cycles but cut latency.

S25 latency against cost by worker count (medians):

| Sample | Workers | Cycles | Mean | p99 | Max |
| --- | --- | --- | --- | --- | --- |
| hd1080i-inter | 1 | 3.13 G | 3.2 ms | 8.9 ms | 10.2 ms |
| hd1080i-inter | 4 | 3.09 G | 0.9 ms | 2.5 ms | 3.9 ms |
| hd1080i-intra | 1 | 4.76 G | 4.9 ms | 8.8 ms | 10.2 ms |
| hd1080i-intra | 4 | 4.77 G | 1.3 ms | 2.4 ms | 3.8 ms |
| hd720-intra | 1 | 2.05 G | 1.7 ms | 3.9 ms | 4.9 ms |
| hd720-intra | 4 | 2.08 G | 0.5 ms | 1.3 ms | 1.9 ms |

Every configuration meets the frame period (16.7 or 33.4 ms) with wide headroom. Peak memory was 26–34 MB per run. This is the data the policies will weigh (INV-AUTOTUNE-011): one worker is the Efficiency choice here, and four buy latency for Performance.

**On the PC** (i9-14900K, Windows), calibration is noisy:
- unpinned, threads migrate between performance and efficiency cores, and noise was 1–12%;
- pinned to the eight performance cores (`--affinity 0x5555`), noise was 0.2–13% with 300-picture runs, and 0.1–7% with 1,500;
- Windows' process cycle count runs at the timestamp rate, so turbo changes and other programs on the sibling hyper-threads show in it.

So most PC verdicts are inconclusive, and the harness reports them as such instead of choosing. The firm PC results are that portable and compact are worse in some classes; the kits are closer together on x86, which has no SIMD motion compensation or add yet. The 1,500-picture run reached its 600 s budget during the fourth sample, and the remaining trials were reported as not run (INV-AUTOTUNE-006).

**Open, for milestone 4:**
- **Repeatability across sessions.** 4 workers against 1 on hd1080i-intra was +0.5% (inconclusive) in the full S25 calibration and +1.9% (worse) in a later short run, after the phone had warmed.
- **PC calibration** needs longer runs and a larger budget, or `cross`-style whole-process runs.

**Also fixed:** the `timespec` declarations in `android.rs` and `tune.rs` used 64-bit fields. On 32-bit ARM, bionic's `time_t` and `long` are 32 bits. It was memory-safe (the kernel writes 8 bytes into 16), but the trace counters' CPU time would have been wrong on a 32-bit device.

**Tests and checks:**
- decoder tests: 30 passed (new: `configs_parse`, `process_counters_advance`, `passes_cover_short_samples`);
- clippy clean for the library and tests, and for the bench on x86-64, AArch64 and 32-bit ARM.

**Evidence:** `artifacts/trier-video-calibration/` (samples, `s25-20261021.*`, `pc-20261021*.*`, `registry-cost/`).

### Adaptive engine, milestone 3: the Yo-Yo search controller (October 21, 2026)

**`trier_video::yoyo`** is a pure search over a closed space, driven by a `Judge`. It works as follows:
- **The space and its starting point.**
  - The space is a set of ordered and unordered axes, plus a validity rule (only registered kits this CPU can run).
  - The decoder's space is kernels × pair window × workers 1 to the exploration ceiling (8) × adaptive.
  - The search starts from the known-good configuration.
- **Climb.** Each axis is tried in turn, up and down. The climb advances while a step is Better, and carries on past a step that is not (patience 2: two non-improving steps end a direction), so the knee is found, not assumed. Unordered axes try every value.
- **Pairs.** Moves of two settings at once from the best point, with a new climb from any that helps.
- **Restarts.** Up to 2, from the best other configurations measured. Their costs are estimated by chaining the comparisons and kept in the report.
- **Confirmation.** A fresh, longer trial (5 rounds) of the finalist against the known-good configuration. Only a Better verdict is locked; otherwise the known-good stays (INV-AUTOTUNE-007).
- **Bounds.** A trial budget (40) and a time budget. Settled comparisons are cached, never rerun, and are inverted when seen from the other side. Ineligible configurations (different output, unavailable, unrecorded) are never adopted.

**Judges.**
- `tune::LiveJudge` runs real A/B/A trials. Each new configuration's output is fingerprinted against the known-good's first.
- In tests, a judge simulates A/B/A trials over cost tables with seeded noise. The verdict rule is shared (`tune::decide`), so simulated and live trials decide alike.

**Tests (8):**
- explores past four workers and past the knee (locks 6 of 8, having probed 7 and 8);
- crosses a single bump;
- finds a two-setting interaction only reachable by pair moves;
- a restart finds a second optimum that a search without restarts misses;
- noise keeps the known-good;
- trial and time budgets bound the search, and an unconfirmed result is not locked;
- from the portable fallback, the recorded S25 measurements of milestone 2 lead to default/1, with unrecorded configurations refused;
- the decoder space maps kits both ways.

**Bench:** `trier-video-bench yoyo <samples> --sample <name> --metric <m>` prints the full yo-yo log and writes JSON: steps, every trial's medians per side, estimates and the machine.

**On the S25** (unpinned, 8 cores, workers explored 1–8, known-good = the production default `default/4`):

| Sample | Metric | Locked | Confirmed against default/4 | Trials |
| --- | --- | --- | --- | --- |
| hd1080i-intra | wall | default/8 | −29.8% | 27 |
| sd-inter | wall | default/6 | −15.4% | 41 (budget) |
| hd1080i-intra | cycles | default/1 | −22.7% | 32 |
| sd-inter | cycles | default/1 | −31.3% | 32 |

**Findings:**
- The production default is a compromise between the fastest and the cheapest setting.
- Unpinned, extra workers cost 19–38% more cycles. Pinned to one cluster (milestone 2) they cost only 2–3%, so worker placement is the next axis.
- Adaptive mode at its fixed 20 KB threshold is 30–156% slower on wall time.
- The coefficient kits make no difference beside the worker count.

Full report: [trier-discovery-2026-10-21-yoyo-s25.md](trier-discovery-2026-10-21-yoyo-s25.md). The app is unchanged: selecting by policy is milestone 4.

**Tests and checks:** decoder 38 passed; clippy clean for the library and tests, and the bench on x86-64, AArch64 and 32-bit ARM.

**Evidence:** `artifacts/trier-video-yoyo/`.

### Adaptive engine, milestones 4 and 5: policies, repeatability and profiles (October 21, 2026)

**Policies (`tune::Policy`, `tune::meets`, `tune::judge_rounds`):**
- **Hard constraints first.**
  - Every policy: no frame owed past its deadline.
  - Balanced and Efficiency also: no picture over the frame period, median p99 within 60% (Balanced) or 85% (Efficiency) of it, and workers within the MV13 operating ceiling.
  - Performance may select up to the exploration ceiling (owner decision).
- **Then the objective:** decode time for Performance, CPU work for Balanced and Efficiency (cycles where counted, else CPU time).
- **Verdicts.** A configuration that meets the constraints beats one that does not; if neither does, p99 decides. Live trials and tests share one decision rule.
- Differences from the approved table and their reasons are in [trier-adaptive-engine.md](trier-adaptive-engine.md) §5.
- **Commands:** `trier-video-bench yoyo --policy <p>`, and `trier-video-bench validate`. The latter repeats every search in sessions alternating cool and warm (a heat soak), then compares the winners: repeatable, equivalent (a direct 5-round trial cannot separate them) or unstable.

**Validation on the S25, the Flip 2 and the PC** (3 sessions each, 18 searches per machine; full report [trier-discovery-2026-10-21-validation.md](trier-discovery-2026-10-21-validation.md)):
- **Balanced and Efficiency are repeatable on both phones.** The S25 chose 1 worker with the default kit every time, cool or hot (21–31% less CPU than the production default 4). The Flip 2 chose 1 worker with kits equivalent within 0.5%.
- **Performance is equivalent on 1080i and unstable on SD on all three machines:** wall-time noise on phones and the 40-trial budget. An unstable result is kept as evidence but never applied.
- **The confirmation step refused every unproven candidate**, including one 18% slower in confirmation than the search's estimate. No search locked anything that later lost to the known-good configuration.
- **The PC is noise-limited** (hybrid cores, turbo, timer-based cycles, no temperature).
- **A correction:** the Flip 2's pairs10 choice is not a real kit preference; it is equivalent to default.

**Profiles (`trier_video::profile`, milestone 5):**
- **Format:** a versioned text file.
- **Key:** decoder version (`DECODER_VERSION`), a kit-registry hash, and the hardware (architecture, features, SoC, clusters, cores, OS).
- **Entries:** one per workload class (`workload_class`: resolution band and scan, from the stream) and policy, with the configuration and its evidence (confirmation change, noise, trials, stability, UTC date, conditions, source, degradations), plus a bounded history (20 per class and policy).
- **Atomic writes:** a temporary file, flushed, then renamed.
- **Fallback:** a missing, corrupt or stale profile (another decoder version, registry, device or OS) applies the known-good configuration.
- **Not applied:** an unstable result, or one with 3 playback sessions under pressure (`note_degradation`), is not applied.

Bench: `validate --profile <path>` records each class and policy (the most frequent winner; ties go to fewer workers), and `profile show <path>` prints it with whether it is valid here. On the S25 and the Flip 2, real profiles were written, read back as valid, and reported stale with another OS string.

**Tests:** decoder 47 passed. The new ones: 3 policy tests, plus 6 profile tests (round trip; corruption at every 7th byte and junk falls back; a changed device, OS, decoder version or registry makes the profile stale; atomic saving; unusable choices and bounded history; classes and dates). Clippy is clean.

**Evidence:** `artifacts/trier-video-validate/`.

### Adaptive engine, milestones 6 and 7: AutoTune in GenX, the playback guard and learning (October 21, 2026)

**In the app (milestone 6):**
- **`TrierAutoTune.kt`.**
  - At start, it gives the native decoder the profile folder (app-private `files/trier`), the OS and the policy (**Balanced**).
  - On devices that use Trier (no MPEG-2 decoder), it runs **Stage A** in the background: at the lowest thread priority, 90 s after start, only when charging or above 50% battery and not thermally stressed, at most once a day unless the profile needs it.
  - Stage A runs on three bundled samples (`assets/trier-calibration`: SD, 720p and 1080i, 0.5 s each, 2.7 MB in all), generated reproducibly (`calibration_samples.py --app`, manifest `calibration-samples-app.tsv`).
- **`calibration::stage_a`** runs the Yo-Yo search per class within the operating ceiling.
  - It skips classes with a usable choice, and it records only a confirmed choice, or "settled on the known-good" when a complete search confirmed nothing better.
  - It keeps 30% of each sample's budget for the confirmation.
  - It never starts while a decoder is alive, and a decoder starting cancels it within a picture (`tune::cancel`).
- **Applying choices.** Each Trier decoder applies the profile's choice for its stream's class (`profile::workload_class`) before the class's first picture.
- **The decoder's own CPU time.** Each worker reads its thread CPU clock around its share of a picture (`Stats::decode_cpu_us`). That is the CPU objective in the app, where perf counters are denied.
- **Counters** 32–35: AutoTune status, workers, kit, decode CPU.
- **Debug overrides:** `debug.genx.trier.policy` (performance, balanced, efficiency, off), `debug.genx.trier.calibrate=now`, and `debug.genx.trier.threads`, which still takes precedence.

**In playback (milestone 7), the guard and learning (INV-AUTOTUNE-011):**
- **When the guard trips.** After 300 pictures, a profile choice gives way to the known-good settings for the rest of the session in two cases:
  - a frame is at risk: two pictures in a row over the frame period, or a whole period owed;
  - **the policy's deadline share is missed in real playback:** the p99 of the last 600 pictures, checked every 300.
- **What it learns.** A missed share retires the choice at once and raises the class's **worker floor** above it. Stage A then explores only from the floor up, so each playback correction climbs toward a setting that holds in viewing, at most up to the ceiling.
- **No-op cases.** A choice that is the known-good settings themselves is never "reverted", and a failure at the ceiling retires nothing: there is nothing to fall back to. The guard then logs once that the target is out of reach.
- **Degradation.** A session that the guard reverted for a frame at risk counts as degraded; after 3, the choice is retired.

**What the S25 taught** (A&E, 720p, 59.94 fps; evidence `artifacts/trier-autotune-app/s25-closed-loop.md`):
- **The bench was wrong for playback.** Stage A chose 1 worker for every class (34–42% less CPU than 4). In playback the governor holds the CPU near 850 MHz, and with 1 worker p99 was **22 ms** against Balanced's 10 ms (no frames dropped).
- **The guard corrected it in steps.** It reverted 1 worker (floor 2), then 2 workers (floor 3). At floor 3 nothing was confirmed cheaper than 4, so 720p **settled on the known-good 4 workers**.
- **Playback then met the target:** p99 7.1–9.5 ms, zero pressure.
- **Two flaws were found and fixed during the run:**
  - the profile key included the usable core count, which the Flip 2 changes from moment to moment;
  - the guard could retire the known-good itself.
- **Cancellation in the app:** the running 720p search stopped as A&E started, recorded nothing, and playback was normal.
- **Channel switching** (A&E, AMC, BBC America, 8 switches): 3 helper threads while playing, GenX's thread count steady (79–81), 13 sessions closed with the profile applied and no pressure, no crash or ANR, then an ordinary exit.
- **Not yet tested in playback:** the SD and 1080i choices (1 worker) come from Stage A only. All MPEG-2 channels in the owner's source are 720p; the guard will check those choices when such a channel plays.

**Tests:** decoder 60 passed. The new ones cover Stage A (cancellation records nothing; a confirmed choice is saved and kept; a complete search settles on the known-good; an undecodable input), applying and reverting a choice mid-stream with **identical pictures**, the known-good never reverted, the guard rules, the floor (rising, surviving a reload, stopping at the ceiling), and a hardware key that ignores cores going offline. Clippy is clean for x86-64, AArch64 and 32-bit ARM.

### Adaptive engine, milestone 8: cross-platform and competitive verification (October 21, 2026)

All runs use the final code of milestones 1–7 on the A&E 720p capture (2,163 pictures × 3), with release builds. Evidence: `artifacts/trier-video-m8/`.

**Correctness on four architectures.**
- The S25 (AArch64 with NEON), the Flip 2 (AArch64) and the Google TV Streamer (**32-bit ARM**, MT8696, first run on real hardware) give the same output digest `88cefa6a26258bde` over 28 runs: the A&E and BBC America captures plus 12 damaged variants, each at 1 and 4 workers.
- The PC (x86-64, SSE2) gives the same A&E checksum `5389243eb86906fb`.
- The quick scorecard (run 20261021T074703Z) passes valid streams (worst frame 91.15 dB), reference compliance, 63 malformed variants with no unsafe failure, and frame count and order. Its damaged-picture averages are identical to the previous run. The exit code is 1 only because one-core speed stays OPEN while FFmpeg is faster on the PC.

**Matched comparison** (same cores, whole process, pictures/s, two rounds):

| Device | Threads | Trier | FFmpeg 6.1.1 | libmpeg2 0.5.1 |
| --- | --- | --- | --- | --- |
| S25, cores 0–5, on AC | 1 | 1,104 / 1,115 | 1,579 / 1,579 | 879 / 879 |
| | 2 | 1,949 / 1,949 | 2,515 / 2,515 | |
| | 4 | 3,181 / 3,046 | 3,546 / 3,489 | |
| Flip 2, big cores (f0), on AC | 1 | 869 / 869 | 594 / 598 | 721 / 723 |
| | 2 | 1,163 / 1,311 | 650 / 666 | |
| | 4 | 2,301 / 2,377 | 920 / 905 | |

**Cycles for the same pictures:**
- S25: Trier 6.74 G against FFmpeg 4.53 G on one thread (**1.49×**), 7.16 against 4.58 G on four.
- Flip 2: 6.93 against 4.94 G on one thread (1.40×), 7.42 against 5.17 G on four.

**Reading the Flip 2 numbers.** By wall time Trier is 1.46× (1 thread) to 2.5× (4 threads) faster than FFmpeg, but FFmpeg still needs fewer cycles. On that phone FFmpeg ran at an effective ~1.4 GHz and Trier at ~2.8 GHz on the same cores. So it is a scheduling and clock effect, not decoding efficiency.

**Unrestricted** (each at its best, unpinned):
- S25: FFmpeg with automatic threads 3,090–3,433 pictures/s against Trier with 8 workers 2,060–2,545. Trier with 4 workers pinned (3,046–3,181) beats Trier with 8 unpinned: spreading across clusters costs, as the Yo-Yo search found.
- Flip 2: Trier with 6 workers 920–1,045 against FFmpeg 759.

**Where FFmpeg stays ahead and why:** per-picture work on every ARM device measured (1.40–1.49× the cycles). FFmpeg uses an integer IDCT (eight 16-bit lanes per NEON register against Trier's four 32-bit floats) and tighter per-macroblock control (see "Parsing round"). **Trier beats libmpeg2** on one core on both phones (1.20–1.27×).

**The 32-bit path, on the Streamer** (portable kernels: no NEON kernels for 32-bit ARM yet), A&E 720p60:

| Workers | Pictures/s | Mean / p99 | Over the frame period |
| --- | --- | --- | --- |
| 1 | 183 | 16.4 / 41.5 ms | 37% |
| 2 | 351 | 8.5 / 21.2 ms | 7.9% |
| 4 | 651–654 | 4.6 / 11.3 ms | 0.05% |

The Streamer has an MPEG-2 hardware decoder, so GenX never uses Trier there. But on a 4-core 32-bit device that needed Trier, MV13's 2 workers would miss 720p60 deadlines. That needs NEON kernels for 32-bit ARM (a new kit), or a deadline-driven exception to the ceiling (an owner decision).

**Not covered:**
- Windows, where Trier is not used.
- The Sansui TV (offline).
- FFmpeg on 32-bit ARM (no build).

### 32-bit ARM: NEON kernels and exact rounding (October 21, 2026)

Owner request: NEON for Trier on 32-bit ARM, which until now had portable code only. Measured on the Google TV Streamer (MT8696, 4 × 2.0 GHz; A&E 720p60 × 3). Evidence: `artifacts/trier-video-neon32/`.

**How, on stable Rust 1.96.**
- The 32-bit ARM NEON intrinsics (issue #111800) and the `neon` target feature (issue #150246) are both unstable.
- Whole-program `-C target-feature=+neon` gave **no gain** (177–180 against 183 pictures/s): the compiler did not vectorise these loops, and it would have made NEON mandatory.
- So the kernels are inline assembly (stable), with an assembler `.fpu neon` directive. They declare only the registers the 32-bit Android ABI exposes (d0–d15), and are chosen at run time only on CPUs that report NEON (`kit::Features::detected`, from `/proc/cpuinfo`).
- `Decoder::new` starts on the first registered kit the CPU can run, so a 32-bit CPU without NEON falls back to the portable kit.

**What the profile showed and what changed.**

1. **`roundf` was 19% of the time.** ARMv7, and x86-64's SSE2 baseline, have no instruction for `f32::round`, so it was a C library call per sample. `round_half_away` now truncates and steps one away from zero when the exact remainder is at least a half. This is identical to `f32::round` (tested: every half-way value to 2^13 and its neighbours, a million random values, NaN, and values beyond i32 with saturation). AArch64 keeps its single rounding instruction.
   - Streamer +21% (183 → 221 pictures/s).
   - **PC −20% cycles** (11.33 → 9.09 G for A&E ×3, one worker).
2. **Motion-compensation rows in NEON** (`mc::McNeon32`): the 16 variants (width 8 or 16, the half-sample positions, averaging), with the same instructions as the AArch64 kernel (`vrhadd`, `vaddl` + `vadd` + `vrshrn #2`).
3. **The block add in NEON** (`macroblock::AddNeon32`): `vmovn`, `vmovl`, `vadd`, `vqmovun`.
4. **The inverse DCT's corner paths in NEON** (`idct::IdctNeon32`; reach 0 to 3, most blocks of P and B pictures).
   - The same products summed in the scalar code's order, multiply then add, never fused. NEON flushes subnormals to zero, but the transform's products are never that small.
   - Rounding is `vcvt` truncation plus compare masks, then `vmin`/`vmax`.
   - The dense path stays portable on 32-bit ARM: about 8% of the time now. Its even/odd form needs twice the 8 vector registers the 32-bit ABI lets us declare, so an assembly port gains at most about 4%; left for later.

**Results** (pictures/s; mean / p99 per picture; share of pictures over the 16.7 ms frame period):

| Workers | Before | Rounding fix | + NEON rows and add | + NEON IDCT corners |
| --- | --- | --- | --- | --- |
| 1 | 182–183; 16.4 / 41.5 ms; 37% | 221–223; 13.5 / 29.7 ms; 24% | 259–260; 11.5 / 28.1 ms; 14% | **284**; 10.5 / 23.6 ms; 8% |
| 2 | 350; 8.5 / 21.3 ms; 7.9% | 423–424; 7.0 / 15.2 ms; 0.3% | 491–493; 6.1 / 14.3 ms; 0.18% | **544–545**; 5.5 / 11.9 ms; 0.05% |
| 4 | 647–653; 4.6 / 11.3 ms; 0.05% | 773–781; 3.8 / 8.3 ms | 900–905; 3.3 / 7.7 ms | **983–991**; 3.0 / 6.5 ms |

- About **+55% overall**. MV13's 2 workers on a 4-core 32-bit device now hold 720p60: p99 11.9 ms against the 16.7 ms frame period, down from 21.3 ms with 7.9% of pictures late. That closes the open risk from milestone 8.

**Correctness.**
- The decoder's 62 unit tests pass **on the Streamer** (a 32-bit ARM test build of the bench), including:
  - all 16 motion-compensation variants against the plain code;
  - the NEON add against the plain add for every sample and residual;
  - `neon32_matches_plain`: 200,000 random blocks of every reach, with and without coefficient 63, bit-identical;
  - IEEE 1180.
- The Streamer gives the same output digest `88cefa6a26258bde` as the S25 and the Flip 2 over the 28 runs (two captures plus 12 damaged variants, 1 and 4 workers), with both the NEON kit and the portable kit.
- The PC's 84-run digest is unchanged (`e0d6d3ff0c5f5e68`).
- The S25 is unchanged (6.769 against 6.757 G cycles, checksums identical).
- 61 PC tests pass; clippy is clean for x86-64, AArch64 and 32-bit ARM (with the tests).

### AutoTune (owner design, planned)

The full design, the Yo-Yo search controller, the three policies (Performance, Balanced, Efficiency), INV-AUTOTUNE-001 to 010 and the migration plan are in [trier-adaptive-engine.md](trier-adaptive-engine.md) (proposal, awaiting the owner's approval). The summary below was the first design.

A self-tuning decoder that measures its own verified implementations on each device and keeps the best (in the manner of FFTW and ATLAS), bounded by MV14 (INV-AUTOTUNE-001):

- Installation tuning: CPU-specific kernels (IDCT, motion compensation, coefficient tables; scalar, NEON, AVX2 as they exist) measured on fixed local samples, for reproducible results.
- Playback tuning: workers and scheduling (1 to 4, fixed or adaptive) per resolution and frame rate (720p and 1080i may differ on the same device), by short A/B/A trials after playback has settled, with representative I and P pictures; never switching on consecutive pictures.
- Scoring: frame deadlines first, then p99, then CPU and energy. A candidate replaces the current setting only when it wins in every repeat by more than the noise measured for that device; otherwise the safe setting stays.
- The chosen profile is kept per device model, resolution and frame rate, and re-checked only when hardware, software or performance conditions change (an app or Android update, a new resolution, or INV-PERF-TAIL pressure on the kept setting).

First generation: workers and scheduling only, with a persistent profile and a fallback; kernels follow once NEON and x86 alternatives exist.

## Later

The decoder core is plain Rust with no Android types, so the same code can serve Windows, which also cannot show MPEG-2 in its web player. That is a separate phase.
