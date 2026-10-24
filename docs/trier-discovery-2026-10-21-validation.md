# Performance Discovery Report: policies and repeatability on three machines (October 21, 2026)

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

Milestone 4 of [trier-adaptive-engine.md](trier-adaptive-engine.md). For each machine, the same Yo-Yo searches were run with the three policies (Performance, Balanced, Efficiency) in three sessions: cool, after a 90 s heat soak, then cool again. The questions were whether the tuner finds the same answer each time, and what it does when it cannot. The app is unchanged by this report.

## 1. What was learned

- **Balanced and Efficiency are repeatable on both phones.** On the S25, every session and both samples chose **1 worker with the default kit** (21–31% less CPU than the 4-worker production default), cool or hot. On the Flip 2 they chose 1 worker in every session. On 1080i the kit varied between default, pairs10 and pairs12, and direct trials found those **equivalent** (within 0.5%).
- **Performance (wall time) is the hard case.**
  - On 1080i it was equivalent on all three machines: 7 or 8 workers on the S25 and PC, 2 or 3 on the Flip 2.
  - On SD it was **unstable** on all three: at least one session stopped short of the best point, and direct trials showed the better one. On the S25, 7 workers beat 4. On the Flip 2, 6 beat 3 by 45.6%.
  - Wall time on phones follows the governor and temperature (noise up to 15%), and 40 trials over 80 configurations were not always enough. Performance needs a larger trial budget or more rounds.
- **The safety rules held everywhere.** No search locked a configuration that later lost to the known-good one. The confirmation step refused several attractive-looking candidates:
  - on the Flip 2, pairs10/4 measured **18% slower** than the known-good in confirmation, though the search's chained estimate called it faster;
  - candidates −22.5% and −18.6% "faster" were inconclusive in confirmation, so the known-good stayed.
- **The PC is noise-limited.** Its 1080i Balanced and Efficiency results were "repeatable" only because no session could prove anything better than the known-good. On SD, direct trials show 1 worker is best, yet two of three sessions stopped short. The causes are hybrid cores, turbo, and Windows' timer-based cycle count, and the PC has no readable CPU temperature.
- **A correction to an earlier claim.** The Flip 2's Efficiency search once locked pairs10/1 on 1080i, which I described as a device-specific kit choice. A direct trial shows pairs10/1 and default/1 are indistinguishable (−0.5%). The gain came from going from 3 workers to 1. **No device has yet shown a real kit preference.**

## 2. Devices and conditions

| Machine | Hardware | Known-good | Explored | Operating ceiling | Power | CPU temperature by session |
| --- | --- | --- | --- | --- | --- | --- |
| Galaxy S25 | SM8750 "SUN": 6 × 3.53 GHz + 2 × 4.47 GHz | default/4 | 1–8 workers | 4 | Battery (51% → about 35%) | Cool 42→38 °C; warm 61→64 °C; cool again after 546 s, 66→42 °C. Searches ran 38–69 °C |
| Retroid Flip 2 | SM8250 "KONA": 4 × 1.80 + 3 × 2.42 + 1 × 2.84 GHz, 6 usable | default/3 | 1–6 | 3 | AC | Cool 35→31 °C; warm 72→65 °C; cool again after 531 s, 69→35 °C. Searches ran 31–72 °C |
| PC | i9-14900K, Windows, pinned to the 8 performance cores (`--affinity 0x5555`) | default/4 | 1–8 | 4 | Mains | Not readable (Windows); cool = 30 s idle |

All three ran the same samples (sd-inter and hd1080i-intra, 300 pictures per run). Each search had 40 trials, 3 rounds per trial and 5 confirmation rounds, within a 600 s budget.

## 3. Results

| Machine | Sample | Policy | Locked (cool / warm / cool) | Stability (direct check) |
| --- | --- | --- | --- | --- |
| S25 | sd-inter | Performance | 6 / 4 (kept) / pairs12-7 | Unstable: pairs12/7 beats 4 (−14.1%); 7 against 6 inconclusive |
| S25 | sd-inter | Balanced | 1 / 1 / 1 | Repeatable |
| S25 | sd-inter | Efficiency | 1 / 1 / 1 | Repeatable |
| S25 | hd1080i-intra | Performance | 8 / 8 / pairs10-7 | Equivalent (−9.2%, inconclusive) |
| S25 | hd1080i-intra | Balanced | 1 / 1 / 1 | Repeatable |
| S25 | hd1080i-intra | Efficiency | 1 / 1 / 1 | Repeatable |
| Flip 2 | sd-inter | Performance | 3 (kept) / pairs10-6 / 6 | Unstable: 6 beats 3 (−45.6%) |
| Flip 2 | sd-inter | Balanced | 1 / 1 / 1 | Repeatable |
| Flip 2 | sd-inter | Efficiency | 1 / 1 / 1 | Repeatable |
| Flip 2 | hd1080i-intra | Performance | 3 / 3 / pairs12-2 | Equivalent (−25.7%, inconclusive) |
| Flip 2 | hd1080i-intra | Balanced | 1 / 1 / pairs12-1 | Equivalent (+0.4%) |
| Flip 2 | hd1080i-intra | Efficiency | pairs10-1 / 1 / 1 | Equivalent (−0.5%) |
| PC | sd-inter | Performance | 7 / 7 / compact-6 | Unstable: 7 beats compact/6 (−7.6%) |
| PC | sd-inter | Balanced | 1 / 2 / 4 (kept) | Unstable: 1 is best (2: +4.1%, 4: +6.4%) |
| PC | sd-inter | Efficiency | pairs12-1a / 4a / 4 (kept) | Unstable: pairs12/1a best |
| PC | hd1080i-intra | Performance | 8 / pairs12-8 / 7 | Equivalent |
| PC | hd1080i-intra | Balanced | 4 / 4 / 4 (all kept) | "Repeatable" only because nothing beat the known-good |
| PC | hd1080i-intra | Efficiency | 4 / 4 / 4 (all kept) | As Balanced |

"Kept" means the search confirmed nothing better and the known-good configuration stayed (INV-AUTOTUNE-007).

## 4. What this means for the next milestones

- **Apply Balanced and Efficiency choices with confidence on phones.** Their CPU objective is steady, and they gave the same answer cool and hot.
- **Performance needs more evidence before it is applied.** Options: more trials (80) and rounds (5) for wall-time searches, or keep the operating point only where sessions agree. A profile marks an unstable result as "not applied" (milestone 5), so the known-good configuration stays.
- **In playback, Stage B must confirm against real telemetry.** The bench runs at the governor's mercy; INV-AUTOTUNE-011 asks for the sustained playback behaviour.
- **The PC needs `cross`-style long runs**, or should be excluded from tuning until Windows uses Trier.

## 5. Evidence

- **Logs and JSON** (every session, search step, confirmation and stability check): `artifacts/trier-video-validate/`, as `{s25,flip2,pc}.{txt,json}`.
- **Device profiles from the milestone 5 check:** `s25-sd.profile` and `flip2-sd.profile`.
- **Command:**

  ```
  trier-video-bench validate <samples> --sessions 3 --soak 90 --budget 600 [--cool-temp 42|35] [--affinity 0x5555] --json <out>
  ```
