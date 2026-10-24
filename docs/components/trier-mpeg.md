# Trier MPEG

GenX's own decoders, so that no FFmpeg code ships in the apps: Trier MPEG
Video (MPEG-2 video, in Rust) and Trier MPEG audio, plus Trier AutoTune, which
measures each device and picks the fastest settings.

## Where the code is

| Layer | Where |
| --- | --- |
| Native (Rust) | `src-tauri/src/trier_video/` (bitstream, headers, `macroblock.rs` and its parts in `macroblock/`, IDCT and motion compensation kits, pictures, `tune.rs` for AutoTune, `android.rs` for the JNI bridge) |
| Android | `TrierMpegVideo.kt`, `TrierMpegDecoder.kt` (audio), `TrierMpegRenderer.kt`, `TrierAutoTune.kt` |
| Bench and tools | `scripts/trier-video/` (the `trier-video-bench` harness, calibration samples, comparisons with libmpeg2) |

## Start here

- [trier-mpeg-video.md](../trier-mpeg-video.md): the design, what was tested
  against what, and how fast it is.
- `src-tauri/src/trier_video/mod.rs`: the `Decoder` and how a picture is decoded.
- `src-tauri/src/trier_video/macroblock.rs`: the per-macroblock hot path.

## Rules it keeps

MV01–MV14 in [trier-mpeg-video.md](../trier-mpeg-video.md), MA01–MA15 in
[trier-mpeg.md](../trier-mpeg.md), INV-AUTOTUNE-001–011 in
[trier-adaptive-engine.md](../trier-adaptive-engine.md).

Speed matters here: a change to the decoding path should keep the output
checksums identical and be measured. Build the bench and compare two builds on
one pinned core:

```powershell
cd scripts/trier-video/bench
cargo build --profile genx-dev        # what the Android build compiles
trier-video-bench <sample.m2v> 20     # timings and the output checksum
trier-video-bench cross 9 <before.exe> <after.exe> -- <sample.m2v> 20 16683 nohash
```

The three calibration samples are in
`src-tauri/gen/android/app/src/main/assets/trier-calibration/`. On a phone,
use `simpleperf stat` cycle counts.

## Tests

```powershell
cd src-tauri; cargo test --lib trier_video::
```
