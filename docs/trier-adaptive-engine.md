# Trier AutoTune: the Yo-Yo adaptive execution engine (proposal)

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

Status: **approved October 21, 2026; milestone 1 in progress** (owner requests of October 21, 2026: "Fully Adaptive Algorithm Architecture", "Yo-Yo AutoTune Engine" and the "operational sweet spot"). It extends "AutoTune" in [trier-mpeg-video.md](trier-mpeg-video.md) (MV14) and adds the invariants INV-AUTOTUNE-001 to 011.

## Goal and limits

Trier MPEG Video should not have one hard-coded performance configuration. On each machine and for each kind of stream, it should find the best **verified** combination of:
- coefficient decoding, inverse DCT, motion compensation and block add;
- scheduling and worker count;
- memory strategy.

It should then lock that combination in, remember it, and reconsider it only when conditions justify it. A correct implementation is not discarded because it is slower on the first device measured: it stays a candidate.

It is a **bounded, verified** engine, not a self-modifying decoder:

- Every implementation is ordinary, reviewed Rust compiled into the decoder. Nothing is generated, downloaded or patched at run time.
- The set of implementations and allowed combinations is a closed registry, fixed when the decoder is built.
- Nothing becomes selectable without passing its qualification tests. Those run in CI for every registered combination, not only the default.
- Unproven variants are not kept just to have more choices.
- The tuner chooses only among registered, eligible combinations, and only at synchronisation boundaries.

## What exists today (inspected October 21, 2026)

| Area | Current state | Where |
| --- | --- | --- |
| Worker pool | Persistent helpers started once per decoder. `run(job)` waits for all of them, and panics are passed on. Dynamic row scheduling: the next free worker takes the next macroblock row. | `pool.rs`, `macroblock.rs` `run_slices` |
| Resource policy (MV13) | Half the cores (1 to 4). No spare frames below 512 MB available, 1 worker below 192 MB. Adaptive workers by picture size, off by default. Debug properties override. | `mod.rs` `Resources`, `android.rs` |
| Profiling counters | INV-PERF-TAIL `Timing`: frame period, decode wall and CPU time, pressure, bursts, recovery, frames held, CPU frequency samples, calls by CPU, migrations, latencies; 32 counters, logged every 1,800 pictures. Perf counters are denied to the app. | `android.rs`, `TrierMpegVideo.kt` |
| Test harness | Decoder unit tests (IEEE 1180, kernel equivalence, 1–8 workers equal, damaged data). Benchmark with checksum gate and per-picture trace. Lab `damage`/`compare`. Scorecard `compare.py` against FFmpeg and libmpeg2. Matched S25 script `phone-compare.sh`. | `tests.rs`, `scripts/trier-video/` |
| Kernel variants | IDCT: corner paths + even/odd dense in `Lane8` (NEON, SSE2, plain). MC rows: NEON, portable. Block add: NEON, portable. Coefficients: packed two-level tables; research variants H1/H2/H3 behind build switches. | `idct.rs`, `mc.rs`, `macroblock.rs` |
| Selection | Build time only (`target_arch`). 32-bit ARM (the Streamer's MT8696) gets no NEON, because NEON is optional there and needs detecting at run time. x86 uses SSE2 even where AVX2 exists. | |

## Architecture

### 1. Resource discovery (`trier_video::platform`)

The decoder takes one snapshot at decoder creation, refreshed cheaply between pictures where noted. **It never assumes all cores are equal, or that more threads help.**

| Fact | Android (Rust, no new permissions) | Windows |
| --- | --- | --- |
| Architecture, instruction sets | `cfg!(target_arch)`; `is_aarch64_feature_detected!` (NEON, dotprod, i8mm); 32-bit ARM `getauxval(AT_HWCAP)` (NEON) | `is_x86_feature_detected!` (SSE2, SSSE3, AVX2) |
| Cores, performance vs efficiency | `/sys/devices/system/cpu/cpu*/cpufreq/cpuinfo_max_freq` grouped into clusters; `cpu_capacity` where present; MIDR per cluster | `GetLogicalProcessorInformationEx` (`EfficiencyClass`) |
| Current availability, affinity, frequency | `sched_getaffinity`; `scaling_cur_freq` (already sampled by `Timing`) | Process affinity mask; frequency is not reliably readable, so it is recorded as unknown |
| Memory | `MemAvailable` (already used); app memory class from Kotlin | `GlobalMemoryStatusEx` |
| Thermal, pressure | `PowerManager.getCurrentThermalStatus` (Kotlin, API 29+) passed down; INV-PERF-TAIL pressure | Not available as a general API; recorded as unknown |
| Energy | `BatteryManager` current × voltage while on battery: coarse, so used only as supporting evidence, never as the sole score | None per process; CPU time is the proxy, and reports say so |
| Workload | From the stream: resolution, frame rate, progressive/interlaced, picture types; per picture: bytes, coefficients, intra/coded/skipped macroblocks (already in `Stats`) | Same |

### 2. Variant registry

**Stage interfaces.** Each costly stage is a trait with no state of its own. An implementation is a zero-sized type that works only on the buffers it is lent:

```rust
trait CoefDecoder { fn block(s: &mut BlockState, b: &mut Bits, tables: &Tables, intra: bool) -> bool; }
trait InverseDct  { fn inverse_within(block: &mut [i32; 64], reach: usize); }
trait MotionComp  { fn rows<const W: usize, const HX: bool, const HY: bool, const AVG: bool>(/* as mc::rows */); }
trait BlockAdd    { fn add_row(line: &mut [u8; 8], residual: &[i32; 8], intra: bool); }
```

Every implementation declares:
- `ID`: for example `coef.packed.pairs12`, `idct.evenodd.neon`.
- `VERSION`: bumped on any change to its code.
- `REQUIRES`: CPU features.
- `CONTRACT`: `BitExact` (the same output as the portable reference for every input) or `Ieee1180` (inverse DCTs only).

**Kits: whole combinations, compiled whole.** Calling a stage through `dyn` or a function pointer per block would cost more than most of the differences being tuned. In the release build, the coefficient loop, MC and add are inlined into `Slicer::slice`. So the unit of choice for kernels is a **kit**: one implementation of each stage, compiled together as `Slicer::slice::<K>()`.

The registry is a fixed table of kits. Each entry holds:
- the kit's ID and the versions of its parts;
- its requirements and contract, taken from the strictest of its parts;
- a function pointer to its slice decoder.

That is one indirect call per slice and nothing per block. **The decoder is not duplicated in source:** there is one generic slice decoder, and the compiler instantiates it per registered kit. Kits are registered deliberately, not multiplied out, to bound the binary size and the instruction cache. The **portable kit** (plain Rust everywhere) is always registered: it is the fallback and the test reference.

**Execution settings** (no new compiled code; chosen per picture):
- worker count: 1 to the MV13 maximum;
- worker placement: any core, or the performance cluster only;
- scheduler: dynamic rows (today), bands balanced by compressed bytes, fixed bands;
- adaptive workers on or off, and its byte threshold;
- memory strategy: spare frames 0–2, kept or released between channels.

Every option must keep buffer ownership as it is today.

### 3. Qualification (INV-AUTOTUNE-001, 002, 003, 010)

A registration macro generates each kit's tests, so no kit can be registered untested:

| Test | Bit-exact kits | IEEE 1180 kits |
| --- | --- | --- |
| Unit equivalence with the portable stage (as `row_kernel_matches_plain_code`, `dense_vector_form_matches_plain`, `branchless_reconstruction_matches_dequant`, `pair_table_matches_single_codes`) | Required | Required for the non-IDCT stages |
| IEEE 1180 accuracy (MV02) | Portable passes | Required |
| Clean corpus frame checksums | Identical to the portable kit | MV03 (≥ 45 dB) and scorecard reference compliance |
| Damaged corpus (flip, loss, drop, cut; fixed seeds): accept/reject and concealment | Identical digest | Same slices accepted and rejected; MV03 |
| 1 vs 2–8 workers give the same pictures (MV12) | Required | Required |
| Malformed streams: no panic, crash or hang (MV04) | Required | Required |
| Memory: no new `unsafe` without a bounds argument checked once per block (as `mc::rows`); no allocation in the per-picture path; fixed table sizes | Review + tests | Same |

**Determinism (002).** An IEEE 1180 kit is a different numerical contract: conforming, but not bit-identical. It is never substituted for a bit-exact kit silently. Each profile records the contract in use, and a bit-exact-only policy can exclude such kits. Because a different IDCT rounding would mix two roundings in one reference chain, an IEEE 1180 kit changes only at Stage A calibration, effective at the next sequence header or I picture. Bit-exact kits and execution settings give identical pictures, so they may change at any picture boundary.

### 4. The Yo-Yo search controller

**The search space** is the eligible kits × execution settings for the current workload class. Each setting is an ordered axis, such as workers 1, 2, 3, 4, or spare frames 0, 1, 2. Kits form a small graph whose neighbours differ in one stage. The landscape is not assumed to be monotonic, or to have one optimum.

**One trial** is an A/B/A comparison between the incumbent and a candidate. It uses the same workload and the same timing boundary, with the order alternated. It reports each candidate's median, its spread and the noise of A against A.

**The search:**

1. **Start** from the known-good configuration: the stored profile, or the portable kit plus the MV13 policy.
2. **Baseline:** repeat the incumbent until its noise is measured (at least 3 runs).
3. **Climb one axis, both ways.** Move one step along an axis.
   - If the candidate is better by more than the threshold, it becomes the incumbent and the next step goes the same way.
   - The climb does not stop at the first good point: it keeps advancing until two consecutive steps are no better (the knee is found, not assumed), within the axis's safe range.
   - Then it tries the other direction from the best point.
   - When neither direction improves, the axis is settled for now. This is the yo-yo.
4. **Check interactions.** After every axis has settled, try joint moves of pairs of axes whose single moves were close to the threshold either way, then pairs of kit stages. This step exists because of the coefficient research below: H1 and H2 were each slightly worse alone, yet helped in combination with H3.
5. **Restart.** Restart steps 3–4 from the best two distinct configurations found so far (bounded, at most 2), so a second optimum is not missed.
6. **Confirm.** The finalist runs repeated A/B/A trials against the original known-good configuration, and wins only if it is better in every repeat by more than the threshold.
7. **Lock.** Store the winner with its evidence. Below the threshold, keep the known-good configuration (INV-AUTOTUNE-007).

**The best-known configuration is always kept** while candidates are tried, so exploration never permanently gives up a proven result. The report distinguishes a local improvement (better than its neighbours) from the best configuration found within the search budget.

**Worker range: owner decision, October 21, 2026.** The exploration ceiling and the operating ceiling are separate:

| Setting | Rule |
| --- | --- |
| Production default | MV13 unchanged: half the available cores, at most 4, until evidence says otherwise |
| Exploration (calibration and the bench) | 1 to 8 workers, bounded by the cores and memory available and by the measured overhead; restricted further on lower-powered devices |
| Qualified candidates | Only worker counts passing the concurrency and correctness gates (MV12: identical pictures for every count) |
| Selection | Each policy picks its own operating point among the qualified, measured configurations |

The search advances until performance stops improving. It then carries on a bounded distance past the first decline (the landscape may have more than one peak), retreats, and compares the neighbours.

Exploring a setting is not shipping it. For example, AutoTune may find that 6 workers give the highest throughput on the S25, while Efficiency still selects 3 because 3 meet every deadline with less CPU time and heat. Extra workers can cost energy even when they finish sooner, so Balanced and Efficiency weigh that trade.

The rule: **never stop exploring merely because the current setting works; stop when the evidence shows the best qualified operating point within the search budget.**

**Threshold:** improvement must exceed max(3 × noise, policy minimum). The policy minimum is 1% for Stage A and 3% for a runtime switch. A switch is a cost, so this hysteresis is part of INV-AUTOTUNE-008.

**Bounds:** at most N trials (default 40), a time budget, a CPU budget of one core at low priority (Stage A), and a minimum residence time before any further runtime change (default 10 minutes of playback). Settled axes are not retried while their profile is valid, so the tuner does not waste CPU retesting what it already knows.

### 5. Scoring and policies

Every trial records:
- CPU cycles where accessible (benchmark only);
- decoded pictures per second and sustained throughput;
- mean, p95, p99 and maximum decode latency;
- total worker CPU time, and scheduling overhead (worker CPU time minus one-worker CPU time);
- dropped frames, INV-PERF-TAIL pressure, bursts, longest recovery, consecutive over-budget pictures;
- frames-held minimum;
- memory high-water mark;
- temperature and energy where available.

| Policy | Hard constraints | Then minimise |
| --- | --- | --- |
| Performance | Correctness; MV13 resource limits; no dropped frames | p99, then mean latency |
| Balanced (default) | Above, plus p99 ≤ 60% of the frame period, no consecutive over-budget pictures, pressure recovers within 2 pictures | CPU time per picture |
| Efficiency | No dropped frames, p99 ≤ 85% of the frame period, frames held never below 2 | Energy where measured, else CPU time per picture; fewer awake cores preferred on ties |

**As built in milestone 4** (`tune::Policy`, `tune::meets`, `tune::judge_rounds`):

| Policy | Hard constraints (from the same trial's runs) | Selection ceiling | Then minimise |
| --- | --- | --- | --- |
| Performance | No frame owed past its deadline in any run (INV-PERF-TAIL pressure 0) | The exploration ceiling (owner decision, October 21) | Decode time (wall) |
| Balanced | No pressure; no picture over the frame period in any run; median p99 ≤ 60% of the frame period | The operating ceiling (MV13) | CPU work: cycles where counted, else CPU time |
| Efficiency | As Balanced, with p99 ≤ 85% | The operating ceiling (MV13) | CPU work, as Balanced |

Differences from the table above:
- **Performance ranks by decode time, not p99.** The p99 of a 300-picture run rests on 3 pictures, too few to rank configurations by, so p99 is a constraint and decode time the objective.
- **Energy is not measured in the bench.** So Efficiency minimises CPU work like Balanced and differs in its looser deadline share.
- **No tie-break toward fewer cores.** A tie is an inconclusive result, and the noise rule never adopts on one. The search starts from the known-good configuration and keeps it on ties.
- **The frames-held constraint belongs to playback (Stage B).** The bench has no player.

**Verdicts.**
- A configuration that meets the constraints beats one that does not.
- When both meet them, the objective decides by the noise rule: every round must agree beyond the larger of 3 × noise and 1%.
- When neither does, p99 decides, so the search moves toward meeting them.

**Confirmation rule:** a fresh 5-round trial of the finalist against the known-good configuration under the same policy. Only a Better verdict is locked.

**Repeatability rule** (`trier-video-bench validate`): the same searches are repeated in sessions alternating between a cool state (the hottest CPU zone at or below a set temperature) and a warm one (a heat soak decoding the heaviest sample on every worker). Per sample and policy:
- **repeatable:** the same winner in every session;
- **equivalent:** different winners that a direct 5-round trial cannot tell apart;
- **unstable:** different winners that it can.

**Correctness is never traded against score.** Ineligible kits never enter the search.

**The operational sweet spot (INV-AUTOTUNE-011, owner analogy: tuning a distributor V8 by timing light *and* by ear).** The fixed-sample benchmark is the timing light: precise, but not the whole story. Playback telemetry is listening to the engine:
- INV-PERF-TAIL pressure, bursts and recovery (knock);
- frames held and uneven presentation (rough idle);
- worker CPU time (fuel);
- CPU frequency and thermal state (temperature);
- throughput under heavy pictures (acceleration).

The controller is a closed loop: Advance → Measure → Listen → Retreat → Compare → Lock, and retune when conditions change.

Under Balanced and Efficiency, a configuration with a slightly slower mean decode time is preferred when it meets every deadline as reliably and is measurably better on energy, heat or stability. Timing goes both ways: advancing (more workers, a bigger table, a more aggressive kernel) often gives more power, until it knocks. So the tuner explores in both directions and keeps advancing past the current best while that is safe and improving. It establishes where performance starts to deteriorate, then works back to the best point. Backing a setting off (retarding the timing) is just as normal a move. For example, three workers that hold every deadline with less CPU time and heat beat four that are 0.2 ms faster on average.

A setting may also differ by picture weight. The adaptive worker mode (`ADAPTIVE_BYTES`) already gives heavy I pictures more workers than light P and B pictures.

### 6. Two-stage calibration

**Stage A: device calibration.**
- When: after installation or a decoder update, or when the hardware key changes.
- Conditions: idle, preferably charging, deferrable and cancellable. If playback starts, it stops and the known-good configuration stays.
- Inputs: fixed, deterministic samples generated by the repository's fixture generator, never user content. There are SD, 720p and 1080i classes, each with intra-heavy and inter-heavy material.
- It chooses: kits (including IEEE 1180 kits under policies that allow them) and the starting execution settings for each class.
- Budget: 20 s of wall time and one core.

**Stage B: runtime workload calibration.**
- When: during playback, only after warm-up, and only when the stream's class has no settled profile or the monitor flags degradation.
- It chooses: execution settings and bit-exact kits only.
- How: it switches only between pictures, never while workers hold a picture.
- Inputs: the INV-PERF-TAIL counters over windows of real pictures, matched by picture type.
- It does not claim switching is invisible until that has been verified on the device. The first version logs every switch and its effect on frames held.

### 7. Profiles

A profile is written atomically (a temporary file, then a rename) in the app's private data, apart from user data. It is versioned and keyed by:

- the CPU architecture and the instruction sets detected;
- the processor:
  - SoC model or CPUID, the clusters (core counts, maximum frequencies, MIDR or efficiency class);
  - the OS version and API level;
- the decoder version, the kernel implementation versions and the registry hash;
- the workload class: resolution band, frame rate, progressive or interlaced, intra VLC format.

Its value holds:
- the selected kit and execution settings, and the policy;
- each candidate's measurements, with noise and repeats (confidence);
- the date, battery or charging state, thermal state and frequency summary of the last calibration (INV-AUTOTUNE-009).

**Revalidation** happens on:
- a decoder or kernel version change;
- an OS or platform change;
- a processor key change;
- persistent degradation: INV-PERF-TAIL pressure on the locked setting in 3 sessions.

It never happens on a schedule alone. A missing, unreadable or stale profile falls back to the portable kit plus MV13, which is today's behaviour.

### 8. Invariants

| ID | Invariant | How the design keeps it |
| --- | --- | --- |
| INV-AUTOTUNE-001 Correctness | Only qualified implementations are eligible | Registration macro generates the qualification tests; CI runs them for every kit |
| INV-AUTOTUNE-002 Determinism | Declared contract kept; an IEEE 1180 kit never silently replaces a bit-exact one | `CONTRACT` per kit; profile records it; IEEE 1180 changes only at Stage A, at a sequence or I picture |
| INV-AUTOTUNE-003 Memory safety | No unchecked access, unsafe ownership, invalid reuse or unbounded allocation | Kits are stateless over borrowed buffers; `unsafe` only behind a once-per-block bounds check with an equivalence test; fixed tables; frames owned by the decoder as now (MV06) |
| INV-AUTOTUNE-004 Safe transitions | Changes only at synchronisation boundaries | Kit and settings chosen on the decoder thread before `run_slices`; all workers of a picture use one kit; the pool is resized only between pictures |
| INV-AUTOTUNE-005 Measurement integrity | Comparable workloads and timing boundaries; uncertainty reported | A/B/A with alternated order; same samples; noise measured; environment recorded |
| INV-AUTOTUNE-006 Resource protection | Bounded CPU, memory, energy, time | Trial and time budgets; one low-priority core for Stage A; MV13 caps |
| INV-AUTOTUNE-007 Reliable fallback | Failure or inconclusive result keeps the known-good configuration | Portable kit + MV13 always available; no change without a confirmed win |
| INV-AUTOTUNE-008 Stability | No oscillation | Hysteresis thresholds, minimum residence time, settled axes not retried |
| INV-AUTOTUNE-009 Reproducibility | Accepted results carry workload, candidate, version, evidence | Profile value; benchmark artifacts |
| INV-AUTOTUNE-010 Regression protection | All existing codec, malformed-input, ordering, recovery, worker and playback tests pass | Unchanged test suites + per-kit generated tests; scorecard |
| INV-AUTOTUNE-011 Operational sweet spot | Choices rest on sustained playback behaviour, not synthetic throughput alone. A slightly slower configuration may be preferred when it meets every deadline as reliably and measurably improves energy, heat or stability. The tuner evaluates changes in both directions, may advance beyond the current best where safe, recognises interactions between settings, distinguishes local improvements from the best found within its budget, and keeps the best-known configuration while exploring. Correctness and safety are never traded for a metric | Stage B scoring uses INV-PERF-TAIL telemetry, CPU time and thermal state; Balanced and Efficiency policies (§5); the bench reports CPU time and tail as well as speed |

MV14 becomes the umbrella for these eleven.

### 9. Evidence and rejected experiments

Every development A/B and every calibration result is kept:
- summary tables go in `docs/trier-mpeg-video.md`;
- raw outputs go under `artifacts/trier-video-*` (commands, build, device, seeds);
- device profiles can be exported from the app as redacted diagnostics.

Rejected experiments stay listed with their reason:

| Reason | What happens to it |
| --- | --- |
| Incorrect | Never registered |
| Identical machine code | Nothing to register |
| Dominated everywhere measured | Source kept behind a build switch, with its numbers |
| Slower here | Registered as a candidate if plausibly faster on another CPU |

### 10. Performance Discovery Report (owner request)

Every Stage A calibration, and every Stage B change of setting, produces a report, so the owner can see exactly what AutoTune learned and why. The report is written:
- as JSON, next to the profile, for the record and for diagnostics export;
- as readable Markdown, from the benchmark harness and from the app's diagnostics export (Settings → advanced, never in the viewing flow).

Its sections are fixed:

1. **What was learned:** the winner, its gain over the known-good configuration with confidence, and the interactions found, in a few lines.
2. **Device and conditions discovered:** architecture and instruction sets; clusters and cores used; memory; power and thermal state; frequency summary; OS and decoder versions.
3. **Workload:** the class, the sample stream or streams, the picture count and the clean checksum required.
4. **Candidates and qualification:**
   - every candidate considered;
   - its qualification tests and results;
   - whether it was eligible;
   - excluded candidates and why (missing CPU feature, contract not allowed by the policy, failed test).
5. **Baseline and noise:** the known-good configuration's repeats and the noise threshold derived from them.
6. **Search path (the yo-yo log):** every trial in order, with:
   - the move (axis and direction);
   - A/B/A medians, the spread and the metric values (§5);
   - the decision: kept, reversed, axis settled, or inconclusive.
7. **Interactions found:** settings that behave differently together than alone.
8. **Result and confidence:**
   - the locked configuration;
   - runner-ups kept as candidates;
   - what the result does and does not cover (devices, stream classes, worker counts).
9. **Rejected, with reasons:** using the categories in §9.
10. **Not tested:** budget exhausted, axes skipped, conditions missing.
11. **Evidence and reproduction:** raw output paths, build identities, seeds and commands.

The first report, written by hand from the coefficient-decoding research before AutoTune exists, is [trier-discovery-2026-10-21-coefficients.md](trier-discovery-2026-10-21-coefficients.md). It also serves as the template.

### 11. Competitive benchmarking

The decoder keeps being compared with FFmpeg and libmpeg2 in two modes:
- **matched resources:** the same cores, threads, power state and timing boundary;
- **unrestricted:** each at its best on the machine.

These run on the PC, the S25 and the Flip 2, and on the Streamer where possible. Scoring and methodology stay as they are, and cases where a competitor stays faster are recorded with the reason.

## Migration plan (owner's milestones)

Each milestone ends with the same gates:
- decoder tests and clippy;
- clean and damaged checksums identical to the milestone before (bit-exact work);
- the scorecard;
- S25 release cycles no worse than before (above noise);
- a commit, then the `checkpoint.ps1` backup.

The app's behaviour does not change until milestone 6.

1. **Variant registry and capability detection. Done October 21, 2026** (see "Adaptive engine, milestone 1" in [trier-mpeg-video.md](trier-mpeg-video.md)).
   - The slice decoder is generic over kits.
   - Five kits are registered: default, portable, pairs10, pairs12 and compact.
   - The qualification test covers every registered kit automatically.
   - `platform.rs` handles discovery; 32-bit ARM NEON is read from `/proc/cpuinfo`.
   - Zero cost: proven on the S25. On the PC, the registry build is within the commit's range but about 4% above the one-kit build, to be re-measured in milestone 2.
   - Deferred, with reasons: Windows cluster detection (until Windows uses Trier) and thermal state (milestone 6, from the app).
2. **Deterministic microbenchmark harness. Done October 21, 2026** (see "Adaptive engine, milestone 2" in [trier-mpeg-video.md](trier-mpeg-video.md)).
   - Six generated samples (SD, 720p and 1080i; inter and intra) with a recorded manifest, regenerated byte-identically.
   - `trier_video::tune`: runs, output fingerprints before timing, and A/B/A trials with noise and verdicts.
   - Measurements: cycles, CPU time, tail, INV-PERF-TAIL pressure and peak memory.
   - Budgets, and `calibrate` / `cross` in the bench, with JSON output.
   - The PC registry cost was found and fixed (inverse DCT inlining, x86-64 only).
   - First calibrations: the S25 gives firm verdicts (noise ≤ 1.4%). The PC is mostly inconclusive by design while its noise is high.
   - Open for milestone 4: repeatability across sessions and thermal states.
3. **Yo-Yo search controller. Done October 21, 2026** (`yoyo.rs`; see "Adaptive engine, milestone 3" in [trier-mpeg-video.md](trier-mpeg-video.md)).
   - The search climbs in both directions with patience past the knee, tries pair moves, restarts from runner-ups, and confirms against the known-good within trial and time budgets.
   - Eight tests on synthetic and recorded tables pass.
   - On the S25 with workers explored 1–8: wall time locks 8 workers (1080i intra) and 6 (SD inter); cycles lock 1 worker for both. All are confirmed against the production default.
   - Report: [trier-discovery-2026-10-21-yoyo-s25.md](trier-discovery-2026-10-21-yoyo-s25.md).
   - Learned for the next milestones: worker placement (cluster) is an axis to add; the adaptive threshold should be tunable or dropped; policies must choose between the wall and cycle optima.
4. **Scoring and statistical validation. Done October 21, 2026.**
   - The three policies, the thresholds and the confirmation rule (§5, "As built").
   - `validate` runs cool and warm sessions.
   - Report: [trier-discovery-2026-10-21-validation.md](trier-discovery-2026-10-21-validation.md).
   - Balanced and Efficiency are repeatable on both phones.
   - Performance is equivalent or unstable (wall-time noise), so it needs a larger budget before it is applied.
   - The PC is noise-limited.
5. **Profile persistence. Done October 21, 2026** (`profile.rs`).
   - The versioned profile with its keys, evidence and bounded history; atomic store; revalidation by decoder version, registry, hardware and OS.
   - Unstable or repeatedly degraded choices are not applied.
   - Six tests pass.
   - Real profiles were written and checked on the S25 and the Flip 2.
6. **Safe playback integration. Done October 21, 2026** on the S25 (see "Adaptive engine, milestones 6 and 7" in [trier-mpeg-video.md](trier-mpeg-video.md)).
   - Stage A runs in the app: background, cancellable, budgeted, on bundled samples. Profiles are applied at the first picture of each class.
   - Not done: the Flip 2 and the Streamer, which have MPEG-2 hardware decoders and so do not use Trier in the app.
   - Channel switching on the S25 (A&E, AMC, BBC America, 8 switches): 3 helper threads while playing, no growth in GenX's threads, every session closed, no crash or ANR. Installed only after GenX's ordinary exit.
   - Planned originally:
     - Stage A in the app: background, cancellable, budgeted.
     - The profile is applied at decoder creation.
     - Checked on the physical S25, Flip 2 and Streamer: INV-PERF-TAIL, channel switching, no thread leaks, and installation only after GenX's ordinary exit.
7. **Runtime monitoring and bounded recalibration. Done October 21, 2026.**
   - The playback guard (frame at risk, or the policy share missed over 600 pictures) reverts to the known-good for the session.
   - What playback teaches is learned: retirement and a worker floor, so Stage A climbs to settings that hold in viewing.
   - There is no oscillation: a revert lasts the session, and floors only rise.
   - Shown on the S25: 1 → 2 → settled at 4 workers for 720p60.
   - **Not built: live A/B exploration during viewing** (deliberately running other settings in front of the viewer). It needs an owner decision; the guard and floor give the playback feedback without it.
   - Planned originally: Stage B for execution settings, hysteresis, residence time, degradation triggers, and switch logging.
8. **Cross-platform and competitive verification. Done October 21, 2026** (see "Adaptive engine, milestone 8" in [trier-mpeg-video.md](trier-mpeg-video.md)).
   - Identical output digests on the S25, the Flip 2 and the Streamer (32-bit ARM, first device run), and on the PC.
   - The scorecard's correctness tests pass.
   - Matched and unrestricted comparisons with FFmpeg and libmpeg2 on both phones.
   - FFmpeg still needs 1.40–1.49× fewer cycles; Trier beats libmpeg2.
   - The 32-bit path needed NEON kernels or a deadline exception to MV13's ceiling before a 4-core 32-bit device could rely on it. **Resolved October 21, 2026** by NEON kernels for 32-bit ARM and exact rounding without `roundf`: 2 workers now hold 720p60 (p99 11.9 ms; see "32-bit ARM" in [trier-mpeg-video.md](trier-mpeg-video.md)).
   - Windows is not covered (Trier is not used there).
   - Planned originally:
   - The scorecard on each device.
   - Matched and unrestricted comparisons with FFmpeg and libmpeg2.
   - Windows once the Windows build uses Trier.

Risks:
- **Binary size and instruction cache:** each kit is a full slice decoder of roughly 30–60 KB. Kits are registered deliberately, and the release size is measured in milestone 1.
- **CI time:** it grows with the number of kits. The generated tests use small fixtures and a seed-fixed damaged corpus.
- **Calibration noise on phones:** the governor and thermals vary. A/B/A interleaving, repeats and "win in every repeat" keep the known-good configuration when results are unclear.
- **Stage B visibility:** a worker-count change may cost one picture's latency. It is verified on the device before it is called non-disruptive.

## First input: the coefficient-decoding research round (done)

See [trier-discovery-2026-10-21-coefficients.md](trier-discovery-2026-10-21-coefficients.md): H1, H2 and H3 measured alone and in all combinations on the S25. H1+H2+H3 with an 11-bit pair window is the default (−2.3% cycles, pictures and recovery unchanged); the 10- and 12-bit windows are kept as candidates. H1 and H2 helped only together with H3: an interaction that a one-setting-at-a-time search would have missed, and the reason the Yo-Yo controller checks pairs.
