# Trier MPEG

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

Trier MPEG is GenX Streamer's own MPEG audio engine. It decodes MPEG audio Layer I and Layer II sound on Android, and it was built specifically for GenX on October 19, 2026. It is GenX's own engineering, written from the published standards, with no third-party code: ISO/IEC 11172-3 (MPEG-1 audio) and the lower-sampling-frequency extension in ISO/IEC 13818-3 (MPEG-2 audio).

## Why it exists

ACC Network, a free live sports channel, broadcasts MPEG-2 video with MPEG-1 Layer II sound (48 kHz stereo, 96 kbit/s). GenX hands MPEG-2 channels to the Android player, Media3, but none of GenX's Android devices could play that sound:

| Device | Layer II decoder |
| --- | --- |
| Google TV Streamer (MediaTek) | none |
| Retroid Flip 2 (Qualcomm) | none (Media3 reported the track unsupported) |
| Sansui TV (Realtek) | `OMX.realtek.audio.decoder`, which accepts the sound but never outputs it |

The owner decided GenX would carry its own decoder rather than port or bundle another project's. A port of pl_mpeg, an outside open-source decoder, was evaluated for one evening. Measured against Microsoft's decoder it was 23.4 dB off: about 5% quiet, from a shortcut in its requantization. It was removed before anything shipped.

## What it plays

| | Supported |
| --- | --- |
| Layers | Layer I and Layer II (Layer III, MP3, stays with Android's own decoders) |
| Versions and rates | MPEG-1: 32, 44.1, 48 kHz · MPEG-2: 16, 22.05, 24 kHz · MPEG-2.5: 8, 11.025, 12 kHz (nonstandard for Layer I/II, accepted but not independently verified) |
| Bitrates | Every listed bitrate, plus free format (the bitrate is taken from the frame length the container gives) |
| Channel modes | Stereo, joint stereo (intensity), dual channel, mono |
| Output | 16-bit stereo PCM at the stream's own rate. Mono plays on both speakers; dual channel plays its first program on both speakers, as TVs and Windows do |
| CRC | The protection field is read past, not verified (as common decoders do) |

## How it works

| Part | Source | Role |
| --- | --- | --- |
| Decoder | `src-tauri/gen/android/app/src/main/java/com/tmg/tv/TrierMpegDecoder.kt` | Pure Kotlin with no Android types. Reads the header, bit allocation, scale-factor selection and scale factors; requantizes; runs the synthesis subband filter. One call decodes one frame. |
| Media3 bridge | `TrierMpegRenderer.kt` (same folder) | `TrierMpegMediaDecoder` wraps the decoder as a Media3 `SimpleDecoder`. `TrierMpegRenderer` is a `DecoderAudioRenderer` for `audio/mpeg-L1` and `audio/mpeg-L2`. `GenXRenderersFactory` puts it ahead of the platform's audio renderers. |
| Player wiring | `NativeVideoPlugin.kt` | Builds every Media3 player with `GenXRenderersFactory`. Live channels also skip platform Layer I/II decoders. |
| Timestamp alignment | `src-tauri/src/playback/ts_align.rs`, used by the loopback relay in `src-tauri/src/sharing/casting/receiver_relay.rs` | Fixes streams whose audio is stamped far from their video (MA15). |

Decoding steps, as the standard defines them:

1. **Header.** Sync, version, layer, bitrate, rate, padding, mode and mode extension. Reserved values are refused (MA02).
2. **Side information.** Layer I uses 4-bit allocations and one scale factor per subband. Layer II uses the allocation table for its version, rate and per-channel bitrate: 11172-3 Tables 3-B.2a–d (27, 30, 8 or 12 subbands), or 13818-3 Table B.1 for the lower rates (30 subbands). Then the scale-factor selection information and one to three scale factors per subband.
3. **Requantization.** A code c with L levels becomes (2c − (L − 1)) / L, times the scale factor 2^(1 − index/3). Grouped codes (3, 5 and 9 levels) unpack three samples from one word (MA07). Above the joint-stereo bound, one sample serves both channels, scaled by each channel's own scale factor.
4. **Synthesis.** The standard's 32-band synthesis filter: matrixing with N[i][k] = cos((16 + i)(2k + 1)π/64) into a 1024-value history per channel, then the 512-tap window D[i] of 11172-3 Table 3-B.3, to 32 output samples per block.
5. **Output.** Rounded and clamped to 16 bits (MA13). A damaged frame yields silence of its own length, so the timeline never breaks (MA03).

## The timestamp problem it exposed

Even with a decoder, ACC Network stayed silent: its audio timestamps run about 296 seconds earlier than its video, in every segment. Media3 waits for sound that matches the picture's time, so it never sent any frame to any decoder; the Sansui's own decoder waited the same way. The web player tolerated it.

The loopback relay that feeds the Android player now realigns any audio stream stamped more than 10 seconds from its video. The shift is measured once per session from the first segment that shows both, then applied to every later segment, so the sound stays continuous. The 33-bit timestamp wrap is handled. Ordinary streams are never changed (MA15). On a real ACC segment the measured shift was 296.27 seconds. Over 5½ hours it drifted by about 0.6 seconds, so a long session may need a fresh start for exact lip sync.

## Invariant register

Tests are in `src-tauri/gen/android/app/src/test/java/com/tmg/tv/TrierMpegDecoderTest.kt`; each test name ends with the IDs it proves. Frames come from `TrierMpegTestFrames.kt`, a separate frame writer built from the bitstream syntax, not from the decoder.

| ID | Invariant | Failure it prevents (where seen) | Proof |
| --- | --- | --- | --- |
| MA01 | No input makes the decoder throw or read past the frame: any truncation, any single-bit damage, random bytes after a header, random junk. | Decoders that panic or read out of bounds on damaged broadcast data (malformed-input suites in other decoders) | `anyDamageNeverThrowsAndKeepsTheTimeline_MA01_MA03` |
| MA02 | Only valid Layer I/II headers are accepted: reserved version, reserved layer, bitrate index 15 and reserved rate are refused; Layer III is left to Android. | Garbage decoded as audio after a false sync | `headersRejectReservedValuesAndLayerThree_MA02` |
| MA03 | A frame with a header always yields its full length (384 or 1152 samples per channel); if its contents are short or damaged that length is silence. | Audio timeline gaps (A/V drift) or noise bursts on damaged frames | `anyDamage…MA01_MA03`, renderer silence path |
| MA04 | Every bitrate/mode pair is decoded, including Layer II pairs 11172-3 calls disallowed (32 kbit/s stereo, 384 kbit/s mono). | A decoder that rejected every frame of such streams (published Layer II decoder issue) | `unusualButReadableBitrateModePairsAreDecoded_MA04`, `everyVariant…` |
| MA05 | Free-format frames (bitrate index 0) take their bitrate from the length the container gave. | Free-format Layer II producing no output or garbage (published issue) | `freeFormatTakesItsLengthFromTheContainer_MA05` |
| MA06 | MPEG-1, MPEG-2 and MPEG-2.5 rates, Layer I and II, all four modes; mono fills both channels; dual channel (two programs, usually two languages) plays the first program on both speakers, as TVs and Windows do; joint stereo shares one sample per subband above the bound, scaled per channel. | Silence or wrong channels on less common variants | `everyVariantDecodesToItsFrameLength_MA04_MA06`, `channelsKeepTheirRoles_MA06` |
| MA07 | Requantization is exact: (2·code − (L − 1)) / L for L levels, times 2^(1 − index/3); scale factor 63 mutes its subband. | A known shortcut (dividing by L + 1) that leaves a decoder 5% quiet with a 24–28 dB error, measured on ACC against Windows | `scaleFactorsAndCodesScaleExactly_MA07_MA13`, MA08 |
| MA08 | Output matches an independent decoder: Windows Media Foundation's MPEG audio decoder, on ACC Network's real broadcast and on generated streams for every variant it supports. | Table or filter errors that unit tests built from the same reading would share | Evidence below |
| MA09 | `reset()` forgets the synthesis filter history (seek, discontinuity). | Clicks or a smeared burst after a stream jump | `resetForgetsTheFilterHistory_MA09` |
| MA10 | An invalid sample (a grouped code ≥ L³, or an all-ones code) mutes the frame. | Full-scale noise from bit errors | `invalidSamplesAndForbiddenAllocationMuteTheFrame_MA10_MA11` |
| MA11 | Layer I allocation code 15 (forbidden) mutes the frame. | As MA10 | same |
| MA12 | A CRC-protected frame decodes exactly like its unprotected twin; the CRC is skipped, not verified (as common decoders do; damage is bounded by MA03/MA10/MA13). | Misaligned side information when the CRC field is present | `crcProtectedFramesDecodeLikeTheirUnprotectedTwins_MA12` |
| MA13 | Output clamps to 16-bit; it never wraps around. | Loud crackle on hot masters | `scaleFactorsAndCodesScaleExactly_MA07_MA13` |
| MA14 | Ten seconds of 48 kHz stereo Layer II decode in under two seconds on the build machine's JVM. | Stutter on slow TVs | `tenSecondsDecodeQuickly_MA14` |
| MA15 | In the Android player's relay, an audio stream stamped more than 10 s away from its video is moved onto the video timeline once per session; ordinary streams are never changed; 33-bit wrap handled. | ACC Network: audio stamped 296 s early, so Media3 never released any sound | `src-tauri/src/playback/ts_align.rs` tests, including a real ACC segment |

### Research behind the register

Searches on October 19, 2026 found no CVEs for Layer II decoders. They did find:

- malformed-input fuzzing in another decoder (MA01);
- a decoder that rejected Layer II frames whose bitrate/mode pair the standard disallows (MA04);
- free-format Layer II failing in 8 of 18 streams (MA05).

The ISO 11172-4 compliance bitstreams are not freely available, so MA08 uses Windows Media Foundation as the independent reference, with generated streams for every variant.

## Evidence (MA08)

Run on October 19, 2026 against Windows Media Foundation (results):

| Set | Result |
| --- | --- |
| ACC Network's real broadcast | SNR 98.1 dB, largest difference 1 step out of 65,536 |
| 56 generated MPEG-1/MPEG-2 streams (both layers, every rate and mode, all four Layer II tables) | 50 at 90–103 dB with largest difference 1 (one bit-identical). The other 6 are Layer I mono, which Windows alone plays 3 dB quieter; they agree at about 70 dB once that is applied |
| MPEG-2.5 rates | Unverified; Windows does not decode them |

To repeat it: run `TrierMpegYardstickTest` with `GENX_TRIER_MPEG_YARDSTICK_DIR` pointing at a folder and `GENX_TRIER_MPEG_GENERATE=1`. Then run `yard_all.py` from the evidence folder against that folder (it uses `mf-decode.ps1`, Windows PowerShell 5.1).

## Status

- Physical, before the rename (interim build with the timestamp fix): the Flip 2 decoded ACC's sound and reached READY with audio and video.
- Installed after the rename: see the Tasklist entry for the build and devices.
- Lip sync on ACC still needs a viewer to judge, because the shift is measured from the segment boundaries.
