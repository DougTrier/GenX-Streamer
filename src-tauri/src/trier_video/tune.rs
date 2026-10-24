// Copyright 2026 Doug Trier
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Trier AutoTune's deterministic measurements (docs/trier-adaptive-engine.md,
//! milestone 2): one run of a sample under one configuration, and A/B/A trials
//! that compare two configurations with the noise measured alongside them.
//!
//! Every run decodes the same in-memory sample with a fresh decoder, so runs
//! are comparable (INV-AUTOTUNE-005). Before any timing, each configuration's
//! output is checked against the incumbent's (pictures and refused units): a
//! configuration that decodes differently is never timed (INV-AUTOTUNE-001).
//! Budgets bound every trial (INV-AUTOTUNE-006), and an unclear result is
//! reported as inconclusive, never as a win (INV-AUTOTUNE-007).

use super::kit::KitId;
use super::{Decoder, Resources};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Set when playback starts: a running calibration stops within a picture
/// (INV-AUTOTUNE-006, -007: it never competes with viewing).
static CANCEL: AtomicBool = AtomicBool::new(false);
pub fn cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}
pub fn clear_cancel() {
    CANCEL.store(false, Ordering::SeqCst);
}
pub fn cancelled() -> bool {
    CANCEL.load(Ordering::SeqCst)
}

/// CPU time of the calling thread in microseconds (Linux and Android
/// CLOCK_THREAD_CPUTIME_ID; None elsewhere: Windows thread times advance in
/// scheduler ticks).
#[cfg(any(target_os = "linux", target_os = "android"))]
#[allow(clippy::unnecessary_cast)]
pub fn thread_cpu_us() -> Option<u64> {
    // `time_t` and `long` are both `long` (32 bits on 32-bit ARM).
    #[repr(C)]
    struct Timespec {
        seconds: std::ffi::c_long,
        nanoseconds: std::ffi::c_long,
    }
    extern "C" {
        fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
    }
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: `t` is a valid timespec; CLOCK_THREAD_CPUTIME_ID is 3.
    (unsafe { clock_gettime(3, &mut t) } == 0)
        .then(|| t.seconds as u64 * 1_000_000 + t.nanoseconds as u64 / 1000)
}
#[cfg(not(any(target_os = "linux", target_os = "android")))]
pub fn thread_cpu_us() -> Option<u64> {
    None
}

/// Splits an elementary stream into the units a demultiplexer hands over:
/// each picture with the sequence and GOP headers in front of it.
pub fn access_units(es: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 < es.len() {
        if es[i + 2] > 1 {
            i += 3;
        } else if es[i] == 0 && es[i + 1] == 0 && es[i + 2] == 1 {
            starts.push((es[i + 3], i));
            i += 4;
        } else {
            i += 1;
        }
    }
    let mut units = Vec::new();
    let (mut from, mut seen_picture, mut cut) = (0usize, false, None::<usize>);
    for &(code, at) in &starts {
        match code {
            0xB3 | 0xB8 if seen_picture && cut.is_none() => cut = Some(at),
            0x00 if seen_picture => {
                let end = cut.unwrap_or(at);
                units.push(&es[from..end]);
                from = end;
                cut = None;
            }
            0x00 => seen_picture = true,
            _ => {}
        }
    }
    if from < es.len() {
        units.push(&es[from..]);
    }
    units
}

/// The frame period in microseconds from the first sequence header's
/// frame_rate_code (Table 6-4), or None.
pub fn frame_period_us(es: &[u8]) -> Option<f64> {
    let at = es.windows(4).position(|w| w == [0, 0, 1, 0xB3])?;
    let code = es.get(at + 7)? & 0x0F;
    let fps = match code {
        1 => 24000.0 / 1001.0,
        2 => 24.0,
        3 => 25.0,
        4 => 30000.0 / 1001.0,
        5 => 30.0,
        6 => 50.0,
        7 => 60000.0 / 1001.0,
        8 => 60.0,
        _ => return None,
    };
    Some(1e6 / fps)
}

/// One configuration the tuner can choose: a registered kit and the workers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Config {
    pub kit: KitId,
    pub workers: usize,
    /// Workers by picture weight instead of always `workers`.
    pub adaptive: bool,
}
impl Config {
    /// `kit/workers`, with `a` for adaptive: `default/4a`.
    pub fn label(&self) -> String {
        format!(
            "{}/{}{}",
            self.kit.name(),
            self.workers,
            if self.adaptive { "a" } else { "" }
        )
    }
    pub fn parse(text: &str) -> Option<Self> {
        let (kit, rest) = text.split_once('/')?;
        let adaptive = rest.ends_with('a');
        let workers: usize = rest.trim_end_matches('a').parse().ok()?;
        ((1..=8).contains(&workers)).then_some(())?;
        Some(Self {
            kit: KitId::from_name(kit)?,
            workers,
            adaptive,
        })
    }
}

/// A calibration sample: its access units and its frame period.
pub struct Sample<'a> {
    pub name: String,
    pub class: String,
    pub units: Vec<&'a [u8]>,
    /// Microseconds per picture at the stream's frame rate.
    pub period_us: f64,
    /// Passes over the sample in one run, with one decoder (as in playback),
    /// so short samples still give runs long enough to time.
    pub passes: usize,
}
impl Sample<'_> {
    /// Passes giving at least `pictures` pictures per run.
    pub fn passes_for(units: usize, pictures: usize) -> usize {
        pictures.div_ceil(units.max(1)).max(1)
    }
}

/// What one run measured.
#[derive(Clone, Debug, Default)]
pub struct Run {
    pub pictures: usize,
    pub frames: usize,
    pub refused: usize,
    pub wall_us: f64,
    /// Process CPU time, every thread (None where the clock is unavailable;
    /// on Windows it advances in scheduler ticks of about 15.6 ms, so cycles
    /// decide there).
    pub cpu_us: Option<f64>,
    /// User-mode CPU cycles, every thread (None where not permitted).
    pub cycles: Option<u64>,
    /// CPU time of the decoder's own slice decoding, every worker
    /// (`Stats::decode_cpu_us`; None where thread CPU clocks are unavailable).
    pub decode_cpu_us: Option<f64>,
    pub mean_us: f64,
    pub p95_us: f64,
    pub p99_us: f64,
    pub max_us: f64,
    /// Pictures slower than the frame period, and the longest run of them.
    pub over_budget: usize,
    pub longest_over: usize,
    /// INV-PERF-TAIL: decode time beyond the frame period still owed, at most.
    pub max_pressure_us: f64,
    /// Peak resident memory during the run where it can be reset per run
    /// (Linux), else the process's peak so far (`peak_is_process`).
    pub peak_rss: Option<u64>,
    pub peak_is_process: bool,
}

/// The metric a verdict is decided on (all are recorded either way).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Metric {
    Cycles,
    Cpu,
    Wall,
    P99,
    /// The decoder's own CPU time (its workers' thread clocks): in an app,
    /// where perf counters are denied and process CPU includes everything.
    DecodeCpu,
}
impl Metric {
    pub fn name(self) -> &'static str {
        match self {
            Metric::Cycles => "cycles",
            Metric::Cpu => "cpu",
            Metric::Wall => "wall",
            Metric::P99 => "p99",
            Metric::DecodeCpu => "decode-cpu",
        }
    }
    pub fn parse(text: &str) -> Option<Self> {
        [
            Metric::Cycles,
            Metric::Cpu,
            Metric::Wall,
            Metric::P99,
            Metric::DecodeCpu,
        ]
        .into_iter()
        .find(|m| m.name() == text)
    }
    /// The value of `run` (lower is better), or None if it was not measured.
    pub fn of(self, run: &Run) -> Option<f64> {
        match self {
            Metric::Cycles => run.cycles.map(|c| c as f64),
            Metric::Cpu => run.cpu_us,
            Metric::Wall => Some(run.wall_us),
            Metric::P99 => Some(run.p99_us),
            Metric::DecodeCpu => run.decode_cpu_us,
        }
    }
    /// The best metric this machine measures: cycles, else CPU time.
    pub fn preferred(run: &Run) -> Self {
        if run.cycles.is_some() {
            Metric::Cycles
        } else if run.cpu_us.is_some() {
            Metric::Cpu
        } else {
            Metric::Wall
        }
    }
}

/// The stream's shape from its first decoded frame: visible width, height
/// and whether it is progressive (the workload class of `profile`).
pub fn shape(sample: &Sample) -> Option<(usize, usize, bool)> {
    let mut d = Decoder::new();
    for (i, unit) in sample.units.iter().enumerate() {
        if let Ok(out) = d.decode(unit, i as i64) {
            if let Some(f) = out.first() {
                return Some((f.width, f.height, f.progressive));
            }
        }
    }
    d.flush()
        .first()
        .map(|f| (f.width, f.height, f.progressive))
}

/// Output identity of a configuration: FNV-1a over every frame's planes and
/// the refused units, untimed.
pub fn fingerprint(sample: &Sample, config: Config) -> Result<u64, String> {
    let mut d = decoder(config)?;
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for &b in bytes {
            h = (h ^ b as u64).wrapping_mul(0x100_0000_01b3);
        }
    };
    for (i, unit) in sample.units.iter().enumerate() {
        match d.decode(unit, i as i64) {
            Ok(out) => {
                for f in &out {
                    eat(&f.planes.y);
                    eat(&f.planes.cb);
                    eat(&f.planes.cr);
                }
            }
            Err(_) => eat(&(i as u64).to_le_bytes()),
        }
    }
    for f in d.flush() {
        eat(&f.planes.y);
        eat(&f.planes.cb);
        eat(&f.planes.cr);
    }
    Ok(h)
}

fn decoder(config: Config) -> Result<Decoder, String> {
    let mut d = Decoder::new();
    d.set_resources(Resources {
        threads: config.workers,
        spare_frames: 2,
        adaptive: config.adaptive,
    });
    d.set_kit(config.kit)
        .map_err(|e| format!("{}: {e:?}", config.label()))?;
    Ok(d)
}

/// One timed run: a fresh decoder (its worker threads start and stop inside
/// the run, so the process counters include them), every unit decoded once.
pub fn run(sample: &Sample, config: Config) -> Result<Run, String> {
    let counter = cycles::Counter::open();
    let peak_reset = memory::reset_peak();
    let (cpu0, cycles0) = (cpu::process_us(), counter.as_ref().and_then(|c| c.read()));
    let started = Instant::now();
    let mut times = Vec::with_capacity(sample.units.len() * sample.passes);
    let (mut frames, mut refused) = (0, 0);
    let decode_cpu_us;
    {
        let mut d = decoder(config)?;
        let units = sample.units.len();
        for pass in 0..sample.passes.max(1) {
            for (i, unit) in sample.units.iter().enumerate() {
                if cancelled() {
                    return Err("cancelled".into());
                }
                let t = Instant::now();
                match d.decode(unit, (pass * units + i) as i64) {
                    Ok(out) => frames += out.len(),
                    Err(_) => refused += 1,
                }
                times.push(t.elapsed().as_secs_f64() * 1e6);
            }
        }
        frames += d.flush().len();
        decode_cpu_us = (thread_cpu_us().is_some()).then_some(d.stats.decode_cpu_us as f64);
    }
    let wall_us = started.elapsed().as_secs_f64() * 1e6;
    let cpu_us = cpu0.zip(cpu::process_us()).map(|(a, b)| b - a);
    let cycles = cycles0
        .zip(counter.as_ref().and_then(|c| c.read()))
        .map(|(a, b)| b.saturating_sub(a));
    let (mut over, mut streak, mut longest, mut pressure, mut max_pressure) = (0, 0, 0, 0f64, 0f64);
    for &t in &times {
        if t > sample.period_us {
            over += 1;
            streak += 1;
            longest = longest.max(streak);
        } else {
            streak = 0;
        }
        pressure = (pressure + t - sample.period_us).max(0.0);
        max_pressure = max_pressure.max(pressure);
    }
    let mut sorted = times.clone();
    sorted.sort_by(f64::total_cmp);
    let at = |q: f64| {
        sorted
            .get(((sorted.len().max(1) - 1) as f64 * q).round() as usize)
            .copied()
            .unwrap_or(0.0)
    };
    Ok(Run {
        pictures: times.len(),
        frames,
        refused,
        wall_us,
        cpu_us,
        cycles,
        decode_cpu_us,
        mean_us: times.iter().sum::<f64>() / times.len().max(1) as f64,
        p95_us: at(0.95),
        p99_us: at(0.99),
        max_us: sorted.last().copied().unwrap_or(0.0),
        over_budget: over,
        longest_over: longest,
        max_pressure_us: max_pressure,
        peak_rss: memory::peak(),
        peak_is_process: !peak_reset,
    })
}

/// Which configuration a round's run measured.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    A,
    B,
}

/// The outcome of a trial on its decision metric.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// B is better than A in every round by more than the threshold.
    Better,
    /// B is worse than A in every round by more than the threshold.
    Worse,
    /// Neither: within noise, mixed, or the budget ran out first.
    Inconclusive,
}

#[derive(Clone, Debug)]
pub struct Trial {
    pub a: Config,
    pub b: Config,
    pub metric: Metric,
    /// Each round's runs in the order they ran: A B A, then B A B, alternately.
    pub rounds: Vec<Vec<(Side, Run)>>,
    /// The relative spread between the two runs of the same configuration in
    /// a round (the median over rounds).
    pub noise: f64,
    pub threshold: f64,
    /// B against A per round, relative (negative: B lower, better).
    pub changes: Vec<f64>,
    pub verdict: Verdict,
    /// Set when the time budget stopped the trial before all rounds ran.
    pub budget_hit: bool,
}

/// Compares `b` with `a` on `metric` over `rounds` rounds (A B A, B A B, ...).
/// A round's change is B's mean against A's mean; noise is the spread of the
/// configuration run twice in that round. The threshold is the larger of
/// 3 × noise and `min_gain`.
pub fn trial(
    sample: &Sample,
    a: Config,
    b: Config,
    metric: Metric,
    rounds: usize,
    min_gain: f64,
    deadline: Instant,
) -> Result<Trial, String> {
    let mut out = Vec::new();
    let mut budget_hit = false;
    for r in 0..rounds {
        if Instant::now() >= deadline {
            budget_hit = true;
            break;
        }
        let order = if r % 2 == 0 {
            [Side::A, Side::B, Side::A]
        } else {
            [Side::B, Side::A, Side::B]
        };
        let mut runs = Vec::new();
        for side in order {
            let config = if side == Side::A { a } else { b };
            runs.push((side, run(sample, config)?));
        }
        out.push(runs);
    }
    let value = |run: &Run| metric.of(run);
    let values: Vec<(Vec<f64>, Vec<f64>)> = out
        .iter()
        .map(|runs| {
            let of = |side: Side| -> Vec<f64> {
                runs.iter()
                    .filter(|(s, _)| *s == side)
                    .filter_map(|(_, r)| value(r))
                    .collect()
            };
            (of(Side::A), of(Side::B))
        })
        .collect();
    let Decision {
        noise,
        threshold,
        changes,
        verdict,
    } = decide(&values, rounds, min_gain);
    Ok(Trial {
        a,
        b,
        metric,
        rounds: out,
        noise,
        threshold,
        changes,
        verdict,
        budget_hit,
    })
}

/// AutoTune's operating policies (docs/trier-adaptive-engine.md §5): hard
/// constraints first, then one objective. Every policy explores the same
/// configurations; Balanced and Efficiency may only *select* within the
/// operating ceiling (MV13: half the cores, at most 4), Performance up to the
/// exploration ceiling (owner decision, October 21, 2026).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    Performance,
    Balanced,
    Efficiency,
}
impl Policy {
    pub const ALL: [Policy; 3] = [Policy::Performance, Policy::Balanced, Policy::Efficiency];
    pub fn name(self) -> &'static str {
        match self {
            Policy::Performance => "performance",
            Policy::Balanced => "balanced",
            Policy::Efficiency => "efficiency",
        }
    }
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.name() == text)
    }
    /// The p99 decode time allowed, as a share of the frame period.
    pub fn p99_share(self) -> f64 {
        match self {
            Policy::Performance => 1.0,
            Policy::Balanced => 0.6,
            Policy::Efficiency => 0.85,
        }
    }
    /// Whether the operating ceiling caps what it may select.
    pub fn capped(self) -> bool {
        self != Policy::Performance
    }
    /// What it minimises once the constraints hold. Performance: decode time
    /// (wall; the p99 of 300 pictures rests on 3 of them, too few to rank by,
    /// so p99 is a constraint). The others: CPU work, cycles where counted,
    /// else the decoder's own CPU time (energy is not measured).
    pub fn objective(self, cycles: bool) -> Metric {
        match self {
            Policy::Performance => Metric::Wall,
            _ if cycles => Metric::Cycles,
            _ if thread_cpu_us().is_some() => Metric::DecodeCpu,
            _ => Metric::Cpu,
        }
    }
}

/// What decides a comparison: one metric, or a policy.
#[derive(Clone, Copy, Debug)]
pub enum Rule {
    Metric(Metric),
    Policy {
        policy: Policy,
        /// The operating ceiling (workers) for capped policies.
        ceiling: usize,
        objective: Metric,
    },
}

/// Whether a configuration's runs in one trial meet `policy`'s hard
/// constraints: never owing a frame past its deadline (no pressure); for
/// Balanced and Efficiency also no picture over the frame period, the median
/// p99 within the policy's share of it, and the workers within the ceiling.
pub fn meets(
    policy: Policy,
    config: Config,
    runs: &[&Run],
    period_us: f64,
    ceiling: usize,
) -> Result<(), String> {
    if policy.capped() && config.workers > ceiling {
        return Err(format!(
            "{} workers, above the operating ceiling {ceiling}",
            config.workers
        ));
    }
    if runs.iter().any(|r| r.max_pressure_us > 0.0) {
        return Err("frames owed past their deadline".into());
    }
    if policy != Policy::Performance {
        if runs.iter().any(|r| r.over_budget > 0) {
            return Err("pictures over the frame period".into());
        }
        let mut p99: Vec<f64> = runs.iter().map(|r| r.p99_us).collect();
        p99.sort_by(f64::total_cmp);
        let median = p99.get(p99.len() / 2).copied().unwrap_or(f64::INFINITY);
        let limit = policy.p99_share() * period_us;
        if median > limit {
            return Err(format!(
                "p99 {:.1} ms above {:.0}% of the frame period",
                median / 1e3,
                100.0 * policy.p99_share()
            ));
        }
    }
    Ok(())
}

/// Decides one trial's runs under `rule`; shared by live trials and tests.
/// Under a policy, a configuration that meets the constraints beats one that
/// does not; if both do, the objective decides by the noise rule; if neither
/// does, the p99 decides (towards meeting them).
pub fn judge_rounds(
    rounds_runs: &[Vec<(Side, Run)>],
    a: Config,
    b: Config,
    rule: Rule,
    period_us: f64,
    rounds: usize,
    min_gain: f64,
) -> (super::yoyo::Comparison, [Result<(), String>; 2]) {
    use super::yoyo::{Basis, Comparison};
    let values = |metric: Metric| -> Vec<(Vec<f64>, Vec<f64>)> {
        rounds_runs
            .iter()
            .map(|runs| {
                let of = |side: Side| -> Vec<f64> {
                    runs.iter()
                        .filter(|(s, _)| *s == side)
                        .filter_map(|(_, r)| metric.of(r))
                        .collect()
                };
                (of(Side::A), of(Side::B))
            })
            .collect()
    };
    let from = |metric: Metric, basis: Basis| -> Comparison {
        let d = decide(&values(metric), rounds, min_gain);
        let mut changes = d.changes.clone();
        changes.sort_by(f64::total_cmp);
        Comparison {
            verdict: d.verdict,
            change: changes.get(changes.len() / 2).copied().unwrap_or(f64::NAN),
            noise: d.noise,
            threshold: d.threshold,
            basis,
        }
    };
    match rule {
        Rule::Metric(m) => (from(m, Basis::Metric), [Ok(()), Ok(())]),
        Rule::Policy {
            policy,
            ceiling,
            objective,
        } => {
            let runs_of = |side: Side| -> Vec<&Run> {
                rounds_runs
                    .iter()
                    .flatten()
                    .filter(|(s, _)| *s == side)
                    .map(|(_, r)| r)
                    .collect()
            };
            let am = meets(policy, a, &runs_of(Side::A), period_us, ceiling);
            let bm = meets(policy, b, &runs_of(Side::B), period_us, ceiling);
            let c = match (am.is_ok(), bm.is_ok()) {
                (true, true) => from(objective, Basis::Objective),
                (true, false) => Comparison {
                    verdict: Verdict::Worse,
                    ..from(objective, Basis::Constraint)
                },
                (false, true) => Comparison {
                    verdict: Verdict::Better,
                    ..from(objective, Basis::Constraint)
                },
                (false, false) => from(Metric::P99, Basis::BothFail),
            };
            (c, [am, bm])
        }
    }
}

/// A `yoyo::Judge` that runs real A/B/A trials on one sample. A
/// configuration is compared only after its output matched the known-good
/// configuration's (pictures and refused units); otherwise it is ineligible.
/// Every trial is kept for the report.
pub struct LiveJudge<'s, 'a> {
    pub sample: &'s Sample<'a>,
    pub rule: Rule,
    pub min_gain: f64,
    pub deadline: Instant,
    reference: u64,
    checked: std::collections::HashMap<Config, Result<(), String>>,
    /// A later deadline for the confirmation trial (see `yoyo::Judge::confirming`).
    pub confirm_deadline: Option<Instant>,
    pub trials: Vec<Trial>,
    /// Per trial, whether A and B met the policy's constraints (and why not).
    pub constraints: Vec<[Result<(), String>; 2]>,
}
impl<'s, 'a> LiveJudge<'s, 'a> {
    pub fn new(
        sample: &'s Sample<'a>,
        known_good: Config,
        rule: Rule,
        min_gain: f64,
        deadline: Instant,
    ) -> Result<Self, String> {
        Ok(Self {
            reference: fingerprint(sample, known_good)?,
            sample,
            rule,
            min_gain,
            deadline,
            checked: std::collections::HashMap::new(),
            confirm_deadline: None,
            trials: Vec::new(),
            constraints: Vec::new(),
        })
    }
    /// Whether this machine counts cycles (the objective of capped policies).
    pub fn cycles_counted() -> bool {
        cycles::Counter::open().is_some_and(|c| c.read().is_some())
    }
    fn eligible(&mut self, c: Config) -> Result<(), String> {
        if let Some(r) = self.checked.get(&c) {
            return r.clone();
        }
        if cancelled() {
            return Err("cancelled".into());
        }
        let r = match fingerprint(self.sample, c) {
            Ok(h) if h == self.reference => Ok(()),
            Ok(h) => Err(format!("output {h:016x} differs from the known-good's")),
            Err(e) => Err(e),
        };
        self.checked.insert(c, r.clone());
        r
    }
}
impl super::yoyo::Judge for LiveJudge<'_, '_> {
    fn confirming(&mut self) {
        if let Some(d) = self.confirm_deadline {
            self.deadline = self.deadline.max(d);
        }
    }
    fn compare(
        &mut self,
        a: &[usize],
        b: &[usize],
        rounds: usize,
    ) -> Result<super::yoyo::Comparison, super::yoyo::Refusal> {
        use super::yoyo::Refusal;
        if Instant::now() >= self.deadline || cancelled() {
            return Err(Refusal::Budget);
        }
        let (Some(ca), Some(cb)) = (super::yoyo::config_of(a), super::yoyo::config_of(b)) else {
            return Err(Refusal::Ineligible("no registered kit".into()));
        };
        for c in [ca, cb] {
            if let Err(why) = self.eligible(c) {
                return Err(if cancelled() {
                    Refusal::Budget
                } else {
                    Refusal::Ineligible(why)
                });
            }
        }
        let metric = match self.rule {
            Rule::Metric(m) => m,
            Rule::Policy { objective, .. } => objective,
        };
        let t = trial(
            self.sample,
            ca,
            cb,
            metric,
            rounds,
            self.min_gain,
            self.deadline,
        )
        .map_err(|why| {
            if cancelled() {
                Refusal::Budget
            } else {
                Refusal::Ineligible(why)
            }
        })?;
        if t.budget_hit {
            return Err(Refusal::Budget);
        }
        let (c, met) = judge_rounds(
            &t.rounds,
            ca,
            cb,
            self.rule,
            self.sample.period_us,
            rounds,
            self.min_gain,
        );
        self.trials.push(t);
        self.constraints.push(met);
        Ok(c)
    }
}

/// The verdict rule, shared by live trials and the simulated ones that test
/// the search controller: per round, A's and B's values (the configuration
/// run twice gives that round's noise); the noise is the median over rounds,
/// the threshold the larger of 3 x noise and `min_gain`, and the verdict is
/// Better or Worse only when every one of `rounds` rounds agrees beyond it.
pub struct Decision {
    pub noise: f64,
    pub threshold: f64,
    pub changes: Vec<f64>,
    pub verdict: Verdict,
}
pub fn decide(values: &[(Vec<f64>, Vec<f64>)], rounds: usize, min_gain: f64) -> Decision {
    let mut noises = Vec::new();
    let mut changes = Vec::new();
    for (va, vb) in values {
        if va.is_empty() || vb.is_empty() {
            continue;
        }
        let twice = if va.len() == 2 { va } else { vb };
        if twice.len() == 2 {
            noises.push((twice[0] - twice[1]).abs() / ((twice[0] + twice[1]) / 2.0));
        }
        let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
        changes.push(mean(vb) / mean(va) - 1.0);
    }
    noises.sort_by(f64::total_cmp);
    let noise = noises
        .get(noises.len() / 2)
        .copied()
        .unwrap_or(f64::INFINITY);
    let threshold = (3.0 * noise).max(min_gain);
    let verdict = if changes.len() < rounds || changes.is_empty() {
        Verdict::Inconclusive
    } else if changes.iter().all(|&c| c < -threshold) {
        Verdict::Better
    } else if changes.iter().all(|&c| c > threshold) {
        Verdict::Worse
    } else {
        Verdict::Inconclusive
    };
    Decision {
        noise,
        threshold,
        changes,
        verdict,
    }
}

/// A deadline `seconds` from now (the calibration budget).
pub fn deadline(seconds: f64) -> Instant {
    Instant::now() + Duration::from_secs_f64(seconds.max(0.0))
}

/// Process CPU time (all threads).
pub mod cpu {
    /// Microseconds, or None where unavailable.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    pub fn process_us() -> Option<f64> {
        #[repr(C)]
        // `time_t` and `long` are both `long` (32 bits on 32-bit ARM).
        struct Timespec {
            seconds: std::ffi::c_long,
            nanoseconds: std::ffi::c_long,
        }
        extern "C" {
            fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
        }
        let mut t = Timespec {
            seconds: 0,
            nanoseconds: 0,
        };
        // SAFETY: `t` is a valid timespec; CLOCK_PROCESS_CPUTIME_ID is 2.
        (unsafe { clock_gettime(2, &mut t) } == 0)
            .then(|| t.seconds as f64 * 1e6 + t.nanoseconds as f64 / 1e3)
    }
    #[cfg(windows)]
    pub fn process_us() -> Option<f64> {
        let mut t = [super::win::FileTime::default(); 4];
        let [a, b, c, d] = &mut t;
        // SAFETY: four valid FILETIMEs for the current process's pseudo-handle.
        let ok =
            unsafe { super::win::GetProcessTimes(super::win::GetCurrentProcess(), a, b, c, d) };
        // Kernel and user time, 100 ns units.
        (ok != 0).then(|| (t[2].value() + t[3].value()) as f64 / 10.0)
    }
    #[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
    pub fn process_us() -> Option<f64> {
        None
    }
}

/// User-mode CPU cycles of the process, every thread.
pub mod cycles {
    /// Linux and Android: a perf counter on this thread that its future
    /// threads inherit (their counts are added when they exit); denied to
    /// Android apps, allowed to the shell. Windows: the process's cycle time
    /// (all threads, user and kernel).
    pub struct Counter {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        fd: i32,
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    extern "C" {
        fn syscall(number: std::ffi::c_long, ...) -> std::ffi::c_long;
        fn read(fd: i32, buf: *mut std::ffi::c_void, count: usize) -> isize;
        fn close(fd: i32) -> i32;
    }
    impl Counter {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        pub fn open() -> Option<Self> {
            // struct perf_event_attr (128 bytes): type HARDWARE (0) and size;
            // config CPU_CYCLES (0); flags at byte 40: inherit (bit 1),
            // exclude_kernel (5), exclude_hv (6).
            let mut attr = [0u64; 16];
            attr[0] = 128u64 << 32;
            attr[5] = (1 << 1) | (1 << 5) | (1 << 6);
            let number: std::ffi::c_long = if cfg!(target_arch = "aarch64") {
                241
            } else if cfg!(target_arch = "arm") {
                364
            } else {
                298
            };
            // SAFETY: perf_event_open(attr, this thread, any CPU, no group, no flags).
            let fd = unsafe { syscall(number, attr.as_ptr(), 0i32, -1i32, -1i32, 0u64) } as i32;
            (fd >= 0).then_some(Counter { fd })
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        pub fn read(&self) -> Option<u64> {
            let mut value = 0u64;
            // SAFETY: reads 8 bytes into `value` from our own perf fd.
            let got = unsafe { read(self.fd, &mut value as *mut u64 as *mut std::ffi::c_void, 8) };
            (got == 8).then_some(value)
        }
        #[cfg(windows)]
        pub fn open() -> Option<Self> {
            Some(Counter {})
        }
        #[cfg(windows)]
        pub fn read(&self) -> Option<u64> {
            let mut c = 0u64;
            // SAFETY: the current process's pseudo-handle and a valid u64.
            (unsafe { super::win::QueryProcessCycleTime(super::win::GetCurrentProcess(), &mut c) }
                != 0)
                .then_some(c)
        }
        #[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
        pub fn open() -> Option<Self> {
            None
        }
        #[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
        pub fn read(&self) -> Option<u64> {
            None
        }
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    impl Drop for Counter {
        fn drop(&mut self) {
            // SAFETY: closes our own fd once.
            unsafe { close(self.fd) };
        }
    }
}

/// Peak resident memory.
pub mod memory {
    /// Linux: resets the kernel's peak (VmHWM) so the next reading is this
    /// run's; false where that is not possible (the peak is then the process's).
    pub fn reset_peak() -> bool {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            std::fs::write("/proc/self/clear_refs", "5").is_ok()
        }
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        {
            false
        }
    }
    /// Bytes, or None.
    pub fn peak() -> Option<u64> {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            let status = std::fs::read_to_string("/proc/self/status").ok()?;
            let kb: u64 = status
                .lines()
                .find_map(|l| l.strip_prefix("VmHWM:"))?
                .split_whitespace()
                .next()?
                .parse()
                .ok()?;
            Some(kb * 1024)
        }
        #[cfg(windows)]
        {
            let mut c = super::win::MemoryCounters {
                cb: std::mem::size_of::<super::win::MemoryCounters>() as u32,
                ..Default::default()
            };
            // SAFETY: a correctly sized PROCESS_MEMORY_COUNTERS.
            let ok = unsafe {
                super::win::K32GetProcessMemoryInfo(super::win::GetCurrentProcess(), &mut c, c.cb)
            };
            (ok != 0).then_some(c.peak_working_set as u64)
        }
        #[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
        {
            None
        }
    }
}

/// Windows process counters (kernel32, linked by std).
#[cfg(windows)]
pub mod win {
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct FileTime {
        low: u32,
        high: u32,
    }
    impl FileTime {
        pub fn value(&self) -> u64 {
            (self.high as u64) << 32 | self.low as u64
        }
    }
    #[repr(C)]
    #[derive(Default)]
    pub struct MemoryCounters {
        pub cb: u32,
        pub page_faults: u32,
        pub peak_working_set: usize,
        pub working_set: usize,
        pub quota_peak_paged: usize,
        pub quota_paged: usize,
        pub quota_peak_nonpaged: usize,
        pub quota_nonpaged: usize,
        pub pagefile: usize,
        pub peak_pagefile: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetCurrentProcess() -> isize;
        pub fn GetProcessTimes(
            process: isize,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        pub fn QueryProcessCycleTime(process: isize, cycles: *mut u64) -> i32;
        pub fn K32GetProcessMemoryInfo(
            process: isize,
            counters: *mut MemoryCounters,
            cb: u32,
        ) -> i32;
        pub fn SetProcessAffinityMask(process: isize, mask: usize) -> i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configs_parse() {
        let c = Config::parse("pairs10/4a").expect("parses");
        assert_eq!((c.kit, c.workers, c.adaptive), (KitId::Pairs10, 4, true));
        assert_eq!(c.label(), "pairs10/4a");
        assert!(Config::parse("default/0").is_none());
        assert!(Config::parse("default/9").is_none());
        assert!(Config::parse("nothing/1").is_none());
    }
    /// The counters this platform offers advance with work (the CPU clock
    /// may move in scheduler ticks, so the work goes on until it has).
    #[test]
    fn process_counters_advance() {
        let counter = cycles::Counter::open();
        let (c0, k0) = (cpu::process_us(), counter.as_ref().and_then(|c| c.read()));
        let until = Instant::now() + Duration::from_secs(5);
        let mut x = 0u64;
        loop {
            for i in 0..1_000_000u64 {
                x = std::hint::black_box(x.wrapping_mul(31).wrapping_add(i));
            }
            let moved = match (c0, cpu::process_us()) {
                (Some(a), Some(b)) => b > a,
                _ => true,
            };
            if moved || Instant::now() > until {
                break;
            }
        }
        if let (Some(a), Some(b)) = (c0, cpu::process_us()) {
            assert!(b > a, "cpu time advances");
        }
        if let (Some(a), Some(b)) = (k0, counter.as_ref().and_then(|c| c.read())) {
            assert!(b > a, "cycles advance");
        }
    }
    fn run_with(p99_us: f64, over: usize, pressure: f64, cycles: u64, wall: f64) -> Run {
        Run {
            pictures: 300,
            p99_us,
            over_budget: over,
            max_pressure_us: pressure,
            cycles: Some(cycles),
            wall_us: wall,
            ..Run::default()
        }
    }
    /// Three rounds A B A / B A B / A B A with A's and B's runs.
    fn rounds_of(a: Run, b: Run) -> Vec<Vec<(Side, Run)>> {
        (0..3)
            .map(|r| {
                if r % 2 == 0 {
                    vec![
                        (Side::A, a.clone()),
                        (Side::B, b.clone()),
                        (Side::A, a.clone()),
                    ]
                } else {
                    vec![
                        (Side::B, b.clone()),
                        (Side::A, a.clone()),
                        (Side::B, b.clone()),
                    ]
                }
            })
            .collect()
    }
    fn cfg(workers: usize) -> Config {
        Config {
            kit: KitId::Default,
            workers,
            adaptive: false,
        }
    }
    fn policy(p: Policy) -> Rule {
        Rule::Policy {
            policy: p,
            ceiling: 4,
            objective: p.objective(true),
        }
    }
    const PERIOD: f64 = 33_367.0;

    /// Balanced refuses a cheaper configuration whose p99 exceeds 60% of the
    /// frame period; Efficiency (85%) takes it.
    #[test]
    fn policies_apply_their_deadline_share() {
        use super::super::yoyo::Basis;
        let a = run_with(10_000.0, 0, 0.0, 4_000_000_000, 500_000.0);
        let b = run_with(25_000.0, 0, 0.0, 3_000_000_000, 1_500_000.0);
        let (c, met) = judge_rounds(
            &rounds_of(a.clone(), b.clone()),
            cfg(4),
            cfg(1),
            policy(Policy::Balanced),
            PERIOD,
            3,
            0.01,
        );
        assert_eq!((c.verdict, c.basis), (Verdict::Worse, Basis::Constraint));
        assert!(met[1].as_ref().is_err_and(|e| e.contains("60%")));
        let (c, _) = judge_rounds(
            &rounds_of(a, b),
            cfg(4),
            cfg(1),
            policy(Policy::Efficiency),
            PERIOD,
            3,
            0.01,
        );
        assert_eq!((c.verdict, c.basis), (Verdict::Better, Basis::Objective));
    }

    /// Performance ranks by decode time and may select above the operating
    /// ceiling; Balanced may not.
    #[test]
    fn only_performance_selects_above_the_ceiling() {
        let a = run_with(5_000.0, 0, 0.0, 4_000_000_000, 500_000.0);
        let b = run_with(3_000.0, 0, 0.0, 4_400_000_000, 300_000.0);
        let (c, _) = judge_rounds(
            &rounds_of(a.clone(), b.clone()),
            cfg(4),
            cfg(8),
            policy(Policy::Performance),
            PERIOD,
            3,
            0.01,
        );
        assert_eq!(c.verdict, Verdict::Better);
        let (c, met) = judge_rounds(
            &rounds_of(a, b),
            cfg(4),
            cfg(8),
            policy(Policy::Balanced),
            PERIOD,
            3,
            0.01,
        );
        assert_eq!(c.verdict, Verdict::Worse);
        assert!(met[1].as_ref().is_err_and(|e| e.contains("ceiling")));
    }

    /// A frame owed past its deadline fails every policy; when both fail, the
    /// lower p99 wins (towards meeting the constraints).
    #[test]
    fn deadlines_come_first() {
        use super::super::yoyo::Basis;
        let late = run_with(40_000.0, 5, 9_000.0, 3_000_000_000, 1_000_000.0);
        let less_late = run_with(34_000.0, 1, 600.0, 3_500_000_000, 900_000.0);
        let fine = run_with(9_000.0, 0, 0.0, 3_900_000_000, 400_000.0);
        let (c, _) = judge_rounds(
            &rounds_of(late.clone(), fine),
            cfg(1),
            cfg(4),
            policy(Policy::Performance),
            PERIOD,
            3,
            0.01,
        );
        assert_eq!((c.verdict, c.basis), (Verdict::Better, Basis::Constraint));
        let (c, _) = judge_rounds(
            &rounds_of(late, less_late),
            cfg(1),
            cfg(2),
            policy(Policy::Efficiency),
            PERIOD,
            3,
            0.01,
        );
        assert_eq!((c.verdict, c.basis), (Verdict::Better, Basis::BothFail));
    }

    #[test]
    fn passes_cover_short_samples() {
        assert_eq!(Sample::passes_for(60, 300), 5);
        assert_eq!(Sample::passes_for(61, 300), 5);
        assert_eq!(Sample::passes_for(400, 300), 1);
        assert_eq!(Sample::passes_for(0, 300), 300);
    }
}
