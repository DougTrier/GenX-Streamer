# Performance Discovery Report: coefficient decoding, Galaxy S25 (October 21, 2026)

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

The first report in the AutoTune report format ([trier-adaptive-engine.md](trier-adaptive-engine.md), "Performance Discovery Report"). This search was run by hand with the lab tools, because AutoTune is not built yet. Everything below is measured; nothing is estimated.

## 1. What was learned

- **Winner: H1+H2+H3 with an 11-bit pair window.** It takes 6.81 G cycles for A&E ×3 against 6.97 G (−2.3%), with 3.7% fewer instructions. It gives identical pictures and identical recovery from damage.
- **The settings interact.**
  - H1 (negative-offset counter) alone: +0.5% cycles.
  - H2 (branchless sign and reconstruction) alone: +0.5% cycles.
  - Each helps once H3 (two codes per lookup) is on: H1+H2+H3 is 0.5% better than H3 alone.
  - A search that tunes one setting at a time would have rejected both H1 and H2.
- **There is no single best window.** The 10-, 11- and 12-bit pair tables were equal within noise here, trading L1 misses for fallback branches. All three stay as candidates for devices with different caches; 11 bits is the default, because it ties here at half the 12-bit table's cache footprint.
- **The gap to FFmpeg narrows.** On one core, Trier's work for the same pictures went from 7.00 G cycles (1.52× FFmpeg's 4.61 G) to 6.81–6.88 G (1.48–1.49×). In the matched S25 run after this round, Trier is within 6% of FFmpeg at four threads (3,090–3,135 against 3,277–3,328 pictures/s).

## 2. Device and conditions discovered

| Fact | Value |
| --- | --- |
| Device | Samsung Galaxy S25, SoC SM8750 (`ro.soc.model`) |
| Architecture, features | AArch64: fp asimd (NEON), aes, pmull, sha1/2/3/512, crc32, atomics, fphp, asimdhp, asimdrdm, jscvt, fcma, lrcpc, dcpop, asimddp (dot product), asimdfhm, i8mm, bf16, flagm2, frint, bti, rng and others (`/proc/cpuinfo`) |
| Cores used | 0–5 (`taskset 3f`: the six 3.53 GHz cores); the two 4.47 GHz cores excluded so every build sees the same cores |
| Power | On battery (79% at the matched run). Governor left as the phone sets it (WALT) |
| Measurement | Release builds (opt-level 3); `simpleperf stat` user-space cycles, instructions, L1 data load misses and branch misses; whole process; checksum off during timing (`nohash`) |

## 3. Workload

- **Stream:** A&E broadcast capture `cap-aande.m2v`, 2,163 pictures of 720p (1280 × 720 progressive, 59.94 fps), decoded 3 times (6,489 pictures per run), one worker. (Corrected October 21: an earlier version of this report said 1080i.)
- **Clean checksum:** A&E `5389243eb86906fb`, BBC America `f57cbac97ca5a254`. Required of every candidate before timing.

## 4. Candidates and qualification

| Candidate | What it changes | Unit equivalence | Clean pictures (S25) | Clean + damaged digest (PC, 84 runs) | Eligible |
| --- | --- | --- | --- | --- | --- |
| Baseline (commit 3113112 + sign-from-the-same-read + inlined decoders) | — | — | reference | `e0d6d3ff0c5f5e68` | Yes |
| H1 negative-offset counter, scan-ordered position/weight table | Position counts from −64 up to 0; the overflow test is the sign; one table load gives raster position, reach and weight | Covered by the clean and damaged corpus (same accept/reject on run overflow) | Identical | Identical | Yes |
| H2 branchless sign and reconstruction | Magnitude × weight × scale, shifted, saturated at 2047 + sign, sign applied by xor/subtract | `branchless_reconstruction_matches_dequant`: every magnitude 1–2047, both signs, every quantiser_scale, 10 weights, intra and not | Identical | Identical | Yes |
| H3 two codes per lookup (12-, 11-, 10-bit windows) | One table read gives up to two run/level codes with signs, or one and end of block; escapes and long codes fall back to the ordinary table | `pair_table_matches_single_codes`: every window, three continuations, both tables, all three window sizes | Identical | Identical | Yes |
| All 7 combinations of H1/H2/H3 | | | Identical | Identical (each) | Yes |

**Damaged corpus:**
- Streams: interlaced, HD, A&E, BBC America and AMC.
- Damage, seed 7: flip:20, flip:200, loss:20, loss:100, drop:20 and cut:0.5.
- With the 12 clean streams, that makes 42 files, each decoded with 1 and 4 workers: 84 runs.
- All 84 runs exited normally.

## 5. Baseline and noise

- **Baseline:** 6.947 G cycles (5 runs, 6.907–6.980) in the factorial round, and 6.971 G (6.945–6.997) in the window round. Run-to-run spread is about ±0.5%.
- **Throughput:** wall-clock pictures per second varied ±8% between identical runs, so it is reported but not used to decide.

## 6. Search path

The owner asked to "do all three at the same time, then work back". So the search started at the far corner and stepped back one setting at a time, then tried every pair (a full 2³ factorial), each candidate in 5 interleaved rounds.

| Configuration | Cycles (G), mean (range) | vs baseline | Instructions (G) | L1D misses (M) | Branch misses (M) | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline | 6.947 (6.907–6.980) | | 17.251 | 51.0 | 53.1 | Reference |
| H1+H2+H3 (12-bit) | 6.822 (6.790–6.851) | −1.8% | 16.603 | 62.1 | 55.4 | Better in every round |
| H2+H3 (H1 off) | 6.840 (6.806–6.904) | −1.5% | 16.719 | 62.0 | 55.4 | Better; H1 adds 0.3% on top |
| H1+H3 (H2 off) | 6.835 median (6.818–7.110) | −1.6% | 16.640 | 61.5 | 55.4 | One outlier round; inconclusive against H1+H2+H3 |
| H3 only | 6.855 (6.832–6.879) | −1.3% | 16.747 | 67.8 | 56.0 | Better in every round |
| H1+H2 (H3 off) | 6.912 (6.893–6.936) | −0.5% | 17.108 | 52.1 | 52.6 | Overlaps the baseline: not significant |
| H1 only | 6.980 (6.974–6.991) | +0.5% | 17.251 | 51.6 | 52.1 | Worse; instruction count unchanged |
| H2 only | 6.985 (6.926–7.023) | +0.5% | 17.252 | 52.8 | 52.3 | Worse; instruction count unchanged |

Second round, the pair window (H1+H2+H3, 5 interleaved rounds):

| Window (table size) | Cycles (G), mean (range) | vs baseline | Instructions (G) | L1D misses (M) | Branch misses (M) | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline | 6.971 (6.945–6.997) | | 17.251 | 53.6 | 53.1 | Reference |
| 12 bits (32 KB) | 6.839 (6.829–6.851) | −1.9% | 16.603 | 62.7 | 55.4 | Better in every round |
| 11 bits (16 KB) | 6.810 (6.780–6.859) | −2.3% | 16.615 | 58.2 | 56.3 | Better in every round; best mean; ties 12 bits within noise |
| 10 bits (8 KB) | 6.828 median (6.792–7.071) | −2.1% (median) | 16.660 | 55.3 | 58.7 | One outlier round; ties within noise |

## 7. Interactions found

- **H1 and H2 alone make no difference to the instruction count** (17.251 G, unchanged): the compiler produced essentially the same code as the baseline. The +0.5% in cycles is code placement, not the idea.
- **With H3 on, the same changes count** (−0.9% instructions on top of H3). H3 places two coefficients per table read. Each placement then saves a separate scan-table load and a weight load (H1), and the sign branch and signed division (H2).
- **Smaller pair windows trade misses for branches.** As the window shrinks, L1 data misses fall (62.7 → 58.2 → 55.3 M) and fallback branch misses rise (55.4 → 56.3 → 58.7 M). The best point therefore depends on the cache and the branch predictor, so it is a per-device choice for AutoTune.

## 8. Result and confidence

| Choice | Status |
| --- | --- |
| H1+H2+H3, 11-bit window | **Locked in as the default**: better than the baseline in all 5 rounds; mean −2.3%, beyond the ±0.5% noise |
| 12-bit and 10-bit windows | **Kept as candidates** (build switches `TRIER_PAIR12`, `TRIER_PAIR10`): equal within noise here, and plausibly better on devices with larger or smaller L1 caches |
| H1 and H2 without H3 | Kept in the source as switches (`TRIER_NO_H3`), not candidates: worse or not significant on their own |

**Confidence:**
- One device and one stream class (720p broadcast).
- The Flip 2 (Snapdragon 865), the Streamer (32-bit, no NEON path) and the PC were not tuned here.
- In-app timing was not measured for this change. It is bit-exact, and the app's counters will show it at the next APK.

## 9. Rejected, with reasons

| Experiment | Result | Reason |
| --- | --- | --- |
| p1: pre-multiplied scale table (weight × quantiser_scale) with masked indices | Slower | Rebuilt whenever quantiser_scale changes (per macroblock) |
| p4: 64-bit bit-reader window | Not better | No measurable gain |
| p5: zeroing the block inline | Identical machine code | Nothing to register |
| p6: block decoding on a local copy of the bit reader | +0.4% cycles | Worse in every round |
| Native CPU build (`-C target-cpu=oryon-1`) | −0.7% in 2 of 3 rounds, tied in 1 | Below noise. It would also need run-time dispatch to ship, because the APK serves older CPUs too. A future kit candidate only if a specific instruction is shown to help |

## 10. Not tested here

- Multi-worker runs of the new loop. They are equal in pictures; their cycles were not measured.
- Intra-only streams.
- Other devices.
- Energy.

## 11. Evidence and reproduction

- **Raw outputs:** `artifacts/trier-video-discovery/20261021-coefficients/` (backed up under `<local path>`):
  - `s25-factorial-5-rounds.txt`, `s25-windows-5-rounds.txt`, `s25-native-cpu.txt`;
  - one `*.recov` per build (each of the 84 runs: workers, file, exit code, checksum);
  - the helper scripts `xbuild.sh`, `xrecov.sh` and `xab.sh`.
- **Builds:** commit 55b031c, one source, with the switches `TRIER_NO_H1`, `TRIER_NO_H2`, `TRIER_NO_H3` and `TRIER_PAIR10` / `TRIER_PAIR12` set at build time; `cargo build --release` of `scripts/trier-video/bench` for `aarch64-linux-android` (NDK 28.2) and the PC. From milestone 1 on, the qualified variants are registered kits (`TRIER_VIDEO_KIT=default|pairs10|pairs12|compact|portable`) and the switches are gone.
- **Tests:** decoder 23 passed, including `branchless_reconstruction_matches_dequant` and `pair_table_matches_single_codes`. The pair-table test was also run with 10- and 11-bit windows.
