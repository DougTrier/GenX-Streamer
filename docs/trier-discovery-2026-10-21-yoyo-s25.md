# Performance Discovery Report: the Yo-Yo search on the Galaxy S25 (October 21, 2026)

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

This is the first report written from a search the controller ran itself: milestone 3, `trier-video-bench yoyo`. The format is in [trier-adaptive-engine.md](trier-adaptive-engine.md), "Performance Discovery Report". Four searches were run: two samples, each decided once on wall time (the Performance view) and once on CPU cycles (the Efficiency view). The policies that weigh both are milestone 4. **Nothing here changes the app**: the production default stays the MV13 rule (half the cores, at most 4).

## 1. What was learned

- **The production default of 4 workers is a compromise.**
  - For speed, the tuner went past four:
    - 1080i intra settled on **8 workers**, 29.8% less wall time than 4;
    - SD inter settled on **6**, 15.4% less.
  - For CPU cost it came all the way down to **1 worker**: 22.7% fewer cycles than 4 on 1080i intra, and 31.3% fewer on SD inter.
  - Each result was confirmed against the known-good configuration in a fresh five-round trial.
- **Where the workers run matters as much as how many there are.**
  - In milestone 2, pinned to the six 3.53 GHz cores, extra workers cost 2–3% more cycles.
  - Unpinned across both clusters, as here and as in the app, they cost far more: SD inter with 3 workers +38.5%, 1080i intra with 3 workers +19.1%, against 1 worker.
  - Worker placement (one cluster, or any core) is therefore the next axis to add.
- **The knee was found, not assumed.** On 1080i intra by wall time, 7 workers were inconclusive against 6, but the climb did not stop there: 8 was better than 6 by 9.4% and was adopted.
- **Adaptive workers at today's threshold (one worker per 20 KB of slice data) are much slower.**
  - Wall time was +30–35% on 1080i intra and +117–156% on SD inter, against a fixed count of the same size: SD pictures are small, so the adaptive mode gives them one worker.
  - On cycles it equals one worker.
  - Its threshold needs to become a tunable value, or it stays a niche setting.
- **The coefficient kits make no difference beside the worker count.** pairs10, pairs12 and compact are inconclusive against default at 4–8 workers. At 1 worker, pairs12 is 0.3–0.8% below default: inconclusive, so not adopted. Compact and pairs10 are worse (+1.5–5.7%).
- **No restart and no pair move found anything better than the climb.** Their results are logged as kept; nothing was missed within the budget.

## 2. Device and conditions discovered

| Fact | Value |
| --- | --- |
| Device | Samsung Galaxy S25, SoC "SUN" (SM8750) |
| Features | AArch64, NEON, dot product |
| Cores | 8 usable: 6 × 3.53 GHz (capacity 765) and 2 × 4.47 GHz (capacity 1024), all allowed (unpinned) |
| Memory | 4.3 GB available |
| Power | On battery, 51% at the start |
| Before/after | CPU 0.56–0.96 GHz idle on the 3.53 GHz cluster and 1.96–3.84 GHz on the prime cores before; 2.00 / 1.96 GHz after each search; 40–51 °C before, 51–57 °C after |

## 3. Workload

The calibration samples come from milestone 2 (`scripts/trier-video/calibration-samples.tsv`, the manifest checked before every run):
- **hd1080i-intra:** 60 pictures, 1920 × 1080 interlaced, all I pictures, frame period 33.4 ms.
- **sd-inter:** 60 pictures, 720 × 480 interlaced, GOP 15 with B pictures.

Each run decodes 300 pictures (5 passes) with a fresh decoder.

## 4. Candidates and qualification

- **The search space** (`yoyo::decoder_space(8)`): kernels (native or portable) × pair window (none, 10, 11, 12) × workers 1–8 × adaptive (off or on). Only points that are registered kits available on this CPU exist (portable kernels only without pair tables), giving 5 kits × 8 × 2 = 80 configurations.
- **Qualification:** every configuration's output (frames and refused units) was compared with the known-good's before it was timed. All measured configurations matched; none was excluded.
- **Known-good:** `default/4`, the production default from `Resources::detect()`.

## 5. Baseline and noise

Noise is measured inside every trial: the spread of the configuration run twice in a round.
- On cycles it was 0.00–4.0%, mostly below 0.3%.
- On wall time it was 0.2–14.7%, mostly 1–5%: wall time on a phone follows the governor.

The threshold per trial is the larger of 3 × noise and 1%. Absolute numbers from different trials are **not** comparable: `default/4` took 310 ms of wall time in the first 1080i trial and 568 ms twenty minutes later. Decisions use only the A/B comparisons inside one trial (INV-AUTOTUNE-005).

## 6. Search path (summarised; every step is in the logs)

| Search | Path | Trials | Confirmation |
| --- | --- | --- | --- |
| hd1080i-intra, wall | Window moves inconclusive → workers 4→5 (−14.8%) → 6 (−10.5%) → 7 inconclusive → 8 (−9.4% against 6) adopted → down to 7 inconclusive → adaptive +31% → pair moves (window × workers, × adaptive) all kept → restart from pairs12/8 and pairs12/7 found nothing better | 27 | default/8 against default/4: −29.8% (noise 2.1%) Better |
| sd-inter, wall | Window inconclusive → 4→5 (−10.0%) → 6 (−7.3%) → 7 inconclusive, 8 inconclusive (knee) → adaptive +137% → pairs and restarts from pairs10/7 and pairs12/7: inconclusive or worse → trial budget (40) reached | 41 | default/6 against default/4: −15.4% (noise 0.5%) Better |
| hd1080i-intra, cycles | Window: compact worse → workers up 5, 6 inconclusive → down 3 (−7.2%) → 2 (−14.4%) → 1 (−3.7%) → adaptive equal → pairs12/1 −0.3% inconclusive → pair moves and restarts: all worse or inconclusive | 32 | default/1 against default/4: −22.7% (noise 0.9%) Better |
| sd-inter, cycles | Window: compact worse → up 5 worse → down 3 (−6.0%) → 2 (−14.0%) → 1 (−23.7%) → pairs12/1 −0.8% inconclusive → everything else worse | 32 | default/1 against default/4: −31.3% (noise 0.05%) Better |

Per worker count, the medians inside the trials that measured each one:

| Sample | Workers | Wall (300 pictures) | Cycles | CPU time | Mean / p99 / max per picture |
| --- | --- | --- | --- | --- | --- |
| sd-inter (cycles search) | 1 | 296 ms | 0.574 G | 294 ms | 0.99 / 2.59 / 2.73 ms |
| | 2 | 194 ms | 0.705 G | 366 ms | 0.65 / 1.62 / 1.77 ms |
| | 4 | 132 ms | 0.833 G | 442 ms | 0.44 / 1.03 / 1.33 ms |
| | 6 | 109 ms | 0.858 G | 477 ms | 0.36 / 0.83 / 0.97 ms |
| hd1080i-intra (cycles search) | 1 | 1,569 ms | 3.038 G | 1,557 ms | 5.2 / 10.8 / 12.6 ms |
| | 2 | 851 ms | 3.167 G | 1,639 ms | 2.8 / 5.7 / 9.4 ms |
| | 4 | 568 ms | 3.938 G | 2,030 ms | 1.9 / 3.5 / 5.1 ms |
| | 6 | 432 ms | 4.246 G | 2,196 ms | 1.4 / 2.6 / 4.9 ms |

Every configuration met its frame period (33.4 ms) with no pressure: the 1-worker p99 of 10.8 ms leaves two thirds of the frame free. Peak memory was 6.5 MB (SD) and 18 MB (1080i) per run, including the sample held by the harness.

## 7. Interactions found

- **Workers × placement.** The cycle cost of extra workers depends on which cores they run on (milestone 2 pinned: +2–3%; here unpinned: +19–38%).
- **Window × workers.** The pair window's small effect at 1 worker (pairs12 −0.3 to −0.8%) disappears at 4 or more workers, where the worker count dominates. No pair move beat the single-axis result.
- **Adaptive × sample size.** At its fixed 20 KB threshold, adaptive mode amounts to "one worker" for these samples. It is never better on wall time and only equal on cycles.

## 8. Result and confidence

| View | Locked here | Status |
| --- | --- | --- |
| Performance (wall time) | 8 workers (1080i intra), 6 (SD inter) | Confirmed against 4 (−29.8%, −15.4%). Above MV13's production cap: exploration found it, and selection under a policy is milestone 4 (owner decision, October 21) |
| Efficiency (cycles) | 1 worker, default kit (both samples) | Confirmed (−22.7%, −31.3%). Every frame deadline is met with wide margin |
| Kits | default (pairs11) | No kit beat it in any of the four searches |

**Confidence:**
- One device, on battery, unpinned, two of the six sample classes.
- Single searches: repeatability across sessions and thermal states is milestone 4.
- The SD-inter wall search used its whole 40-trial budget. Its locked point is confirmed, but restarts after pairs12/7 did not finish.

## 9. Rejected, with reasons

| Configuration | Reason |
| --- | --- |
| Adaptive workers (any) | +30% to +156% wall time against the same fixed count (threshold too coarse for these samples) |
| compact kit | +3.6% to +5.7% cycles (no pair tables) |
| portable kernels at 7 workers | +30% wall time |
| 3 or more workers for Efficiency | +19% to +41% cycles unpinned |

## 10. Not tested here

- 720p and the other four sample classes.
- Worker placement (performance cluster only), which is the next axis.
- Energy: CPU time stands in for it here.
- The Flip 2 and the Streamer.
- In-app timing.

## 11. Evidence and reproduction

- **Logs and JSON:** `artifacts/trier-video-yoyo/s25-{hd1080i-intra,sd-inter}-{wall,cycles}.{txt,json}`, with every step, every trial's medians per side, the estimates and the machine.
- **Command:**

  ```
  trier-video-bench yoyo cal --sample <name> --metric wall|cycles --budget 900 --json <out>
  ```

  The defaults are 40 trials, patience 2, 2 restarts, 3 rounds and 5 confirmation rounds, with workers explored 1–8. The build is the milestone 3 commit, release, `aarch64-linux-android` (NDK 28.2).
