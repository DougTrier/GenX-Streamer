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

//! Trier AutoTune's Yo-Yo search controller (docs/trier-adaptive-engine.md
//! §4, milestone 3): from the known-good configuration, advance and retreat
//! along each setting, keep advancing past the first setback (the knee is
//! found, not assumed), try settings in pairs (they interact), restart from
//! runner-ups, then confirm the finalist against the known-good configuration
//! in a fresh, longer trial. Every comparison comes from a `Judge`: live A/B/A
//! trials (`tune::LiveJudge`) or, in tests, simulated trials over measurement
//! tables decided by the same rule (`tune::decide`). The search is bounded by
//! trial and time budgets; whatever it cannot confirm, it does not adopt
//! (INV-AUTOTUNE-007), and the known-good configuration is kept throughout.

use super::kit::{self, KitId};
use super::tune::{Config, Verdict};
use std::collections::{HashMap, HashSet};

/// A configuration as one value index per axis.
pub type Point = Vec<usize>;

#[derive(Clone, Debug)]
pub struct Axis {
    pub name: &'static str,
    pub values: Vec<String>,
    /// Ordered axes are climbed step by step; others are tried value by value.
    pub ordered: bool,
}

/// Which points of the axes' product exist (registered, available kits).
type Allowed = Box<dyn Fn(&[usize]) -> bool>;

/// The closed set of configurations the search may visit.
pub struct Space {
    pub axes: Vec<Axis>,
    allowed: Allowed,
}
impl Space {
    pub fn new(axes: Vec<Axis>, allowed: impl Fn(&[usize]) -> bool + 'static) -> Self {
        Self {
            axes,
            allowed: Box::new(allowed),
        }
    }
    pub fn valid(&self, p: &[usize]) -> bool {
        p.len() == self.axes.len()
            && p.iter().zip(&self.axes).all(|(&v, a)| v < a.values.len())
            && (self.allowed)(p)
    }
    pub fn label(&self, p: &[usize]) -> String {
        p.iter()
            .zip(&self.axes)
            .map(|(&v, a)| format!("{}={}", a.name, a.values.get(v).map_or("?", |s| s)))
            .collect::<Vec<_>>()
            .join(" ")
    }
    /// The next valid point from `p` along `axis`, skipping invalid ones.
    fn step(&self, p: &[usize], axis: usize, up: bool) -> Option<Point> {
        let mut q = p.to_vec();
        loop {
            q[axis] = if up {
                q[axis]
                    .checked_add(1)
                    .filter(|&v| v < self.axes[axis].values.len())?
            } else {
                q[axis].checked_sub(1)?
            };
            if self.valid(&q) {
                return Some(q);
            }
        }
    }
    /// One-step moves along `axis` (ordered: down and up; else every value).
    fn moves(&self, p: &[usize], axis: usize) -> Vec<Point> {
        if self.axes[axis].ordered {
            [false, true]
                .iter()
                .filter_map(|&up| {
                    let mut q = p.to_vec();
                    q[axis] = if up {
                        q[axis] + 1
                    } else {
                        q[axis].checked_sub(1)?
                    };
                    (q[axis] < self.axes[axis].values.len()).then_some(q)
                })
                .collect()
        } else {
            (0..self.axes[axis].values.len())
                .filter(|&v| v != p[axis])
                .map(|v| {
                    let mut q = p.to_vec();
                    q[axis] = v;
                    q
                })
                .collect()
        }
    }
}

/// What decided a comparison.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Basis {
    /// One metric (`--metric`, or the simulated tables).
    Metric,
    /// Both met the policy's constraints; its objective decided.
    Objective,
    /// Only one met the policy's constraints.
    Constraint,
    /// Neither met them; the p99 decode time decided (towards meeting them).
    BothFail,
}

/// One A/B/A comparison: B (the candidate) against A (the incumbent).
#[derive(Clone, Copy, Debug)]
pub struct Comparison {
    pub verdict: Verdict,
    /// B against A on the deciding metric, relative (negative: B lower).
    pub change: f64,
    pub noise: f64,
    pub threshold: f64,
    pub basis: Basis,
}
impl Comparison {
    /// The same comparison seen from the other side.
    fn inverted(self) -> Self {
        Self {
            verdict: match self.verdict {
                Verdict::Better => Verdict::Worse,
                Verdict::Worse => Verdict::Better,
                Verdict::Inconclusive => Verdict::Inconclusive,
            },
            change: 1.0 / (1.0 + self.change) - 1.0,
            ..self
        }
    }
}

/// Why a judge gave no comparison.
#[derive(Clone, Debug, PartialEq)]
pub enum Refusal {
    /// The time or resource budget is spent.
    Budget,
    /// The candidate may not be used (its output differs, it is unavailable,
    /// or nothing was recorded for it).
    Ineligible(String),
}

pub trait Judge {
    fn compare(&mut self, a: &[usize], b: &[usize], rounds: usize) -> Result<Comparison, Refusal>;
    /// Called once before the confirmation trial: a judge may switch to a
    /// budget kept for it, so a search that used its own time can still
    /// confirm what it found.
    fn confirming(&mut self) {}
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Trials the search may run (the confirmation is one more).
    pub max_trials: usize,
    /// Steps past the last improvement before an axis direction stops.
    pub patience: usize,
    /// Restarts from runner-ups.
    pub restarts: usize,
    pub rounds: usize,
    pub confirm_rounds: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_trials: 40,
            patience: 2,
            restarts: 2,
            rounds: 3,
            confirm_rounds: 5,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    Climb { axis: usize, up: bool },
    Choose { axis: usize },
    Pair { first: usize, second: usize },
    Restart { origin: Point },
    Confirm,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
    Adopted,
    Kept,
    Ineligible(String),
    Budget,
}

#[derive(Clone, Debug)]
pub struct Step {
    pub phase: Phase,
    pub incumbent: Point,
    pub candidate: Point,
    pub comparison: Option<Comparison>,
    pub decision: Decision,
}

#[derive(Clone, Debug)]
pub struct Outcome {
    pub known_good: Point,
    /// The best configuration the search found (before confirmation).
    pub found: Point,
    /// How it was found: "climb", "pairs" or "restart" ("start" if none better).
    pub found_by: &'static str,
    /// What is locked in: `found` if confirmed against the known-good, else
    /// the known-good itself.
    pub locked: Point,
    pub confirmation: Option<Comparison>,
    pub steps: Vec<Step>,
    pub trials: usize,
    pub budget_hit: bool,
    /// Estimated cost of every configuration measured, relative to the
    /// known-good (1.0), chained through the comparisons; lowest first.
    pub estimates: Vec<(Point, f64)>,
}

enum Probe {
    Better,
    NotBetter,
    Stop,
}

struct Search<'a, J: Judge> {
    space: &'a Space,
    judge: &'a mut J,
    limits: Limits,
    cache: HashMap<(Point, Point), Comparison>,
    ineligible: HashSet<Point>,
    estimates: HashMap<Point, f64>,
    steps: Vec<Step>,
    trials: usize,
    budget_hit: bool,
}

impl<J: Judge> Search<'_, J> {
    fn probe(&mut self, inc: &[usize], cand: &[usize], phase: Phase) -> Probe {
        if self.budget_hit {
            return Probe::Stop;
        }
        if self.ineligible.contains(cand) || inc == cand {
            return Probe::NotBetter;
        }
        let key = (inc.to_vec(), cand.to_vec());
        let reverse = (cand.to_vec(), inc.to_vec());
        // Settled comparisons are not run again.
        if let Some(c) = self
            .cache
            .get(&key)
            .copied()
            .or_else(|| self.cache.get(&reverse).map(|c| c.inverted()))
        {
            return if c.verdict == Verdict::Better {
                Probe::Better
            } else {
                Probe::NotBetter
            };
        }
        if self.trials >= self.limits.max_trials {
            self.budget_hit = true;
            self.log(phase, inc, cand, None, Decision::Budget);
            return Probe::Stop;
        }
        match self.judge.compare(inc, cand, self.limits.rounds) {
            Ok(c) => {
                self.trials += 1;
                self.cache.insert(key, c);
                if let Some(&e) = self.estimates.get(inc) {
                    self.estimates
                        .entry(cand.to_vec())
                        .or_insert(e * (1.0 + c.change));
                }
                let better = c.verdict == Verdict::Better;
                let decision = if better {
                    Decision::Adopted
                } else {
                    Decision::Kept
                };
                self.log(phase, inc, cand, Some(c), decision);
                if better {
                    Probe::Better
                } else {
                    Probe::NotBetter
                }
            }
            Err(Refusal::Budget) => {
                self.budget_hit = true;
                self.log(phase, inc, cand, None, Decision::Budget);
                Probe::Stop
            }
            Err(Refusal::Ineligible(why)) => {
                self.ineligible.insert(cand.to_vec());
                self.log(phase, inc, cand, None, Decision::Ineligible(why));
                Probe::NotBetter
            }
        }
    }

    fn log(
        &mut self,
        phase: Phase,
        inc: &[usize],
        cand: &[usize],
        c: Option<Comparison>,
        d: Decision,
    ) {
        self.steps.push(Step {
            phase,
            incumbent: inc.to_vec(),
            candidate: cand.to_vec(),
            comparison: c,
            decision: d,
        });
    }

    /// Each axis in turn, both ways, past the knee; repeated while anything
    /// improves (bounded by the number of axes).
    fn climb(&mut self, start: &[usize]) -> Point {
        let mut inc = start.to_vec();
        for _ in 0..=self.space.axes.len() {
            let mut changed = false;
            for axis in 0..self.space.axes.len() {
                if self.space.axes[axis].ordered {
                    for up in [true, false] {
                        let mut misses = 0;
                        let mut at = inc.clone();
                        while let Some(next) = self.space.step(&at, axis, up) {
                            at = next;
                            match self.probe(&inc, &at, Phase::Climb { axis, up }) {
                                Probe::Better => {
                                    inc = at.clone();
                                    misses = 0;
                                    changed = true;
                                }
                                Probe::NotBetter => {
                                    misses += 1;
                                    if misses >= self.limits.patience {
                                        break;
                                    }
                                }
                                Probe::Stop => return inc,
                            }
                        }
                    }
                } else {
                    for cand in self.space.moves(&inc.clone(), axis) {
                        if !self.space.valid(&cand) {
                            continue;
                        }
                        match self.probe(&inc, &cand, Phase::Choose { axis }) {
                            Probe::Better => {
                                inc = cand;
                                changed = true;
                            }
                            Probe::NotBetter => {}
                            Probe::Stop => return inc,
                        }
                    }
                }
            }
            if !changed {
                break;
            }
        }
        inc
    }

    /// Moves of two settings at once from `inc`: the first better one, if any.
    fn pairs(&mut self, inc: &[usize]) -> Option<Point> {
        let n = self.space.axes.len();
        for first in 0..n {
            for second in first + 1..n {
                for a in self.space.moves(inc, first) {
                    for b in self.space.moves(&a, second) {
                        if !self.space.valid(&b) {
                            continue;
                        }
                        match self.probe(inc, &b, Phase::Pair { first, second }) {
                            Probe::Better => return Some(b),
                            Probe::NotBetter => {}
                            Probe::Stop => return None,
                        }
                    }
                }
            }
        }
        None
    }

    /// Climb, then pairs, then climb again from any pair that helped.
    fn settle(&mut self, start: &[usize]) -> (Point, bool) {
        let mut best = self.climb(start);
        let mut by_pairs = false;
        for _ in 0..self.space.axes.len() {
            match self.pairs(&best) {
                Some(p) => {
                    by_pairs = true;
                    best = self.climb(&p);
                }
                None => break,
            }
        }
        (best, by_pairs)
    }
}

/// Runs the search from the known-good configuration `start`.
pub fn search<J: Judge>(space: &Space, judge: &mut J, start: &[usize], limits: Limits) -> Outcome {
    assert!(space.valid(start), "the known-good configuration is valid");
    let mut s = Search {
        space,
        judge,
        limits,
        cache: HashMap::new(),
        ineligible: HashSet::new(),
        estimates: HashMap::from([(start.to_vec(), 1.0)]),
        steps: Vec::new(),
        trials: 0,
        budget_hit: false,
    };
    let (mut found, by_pairs) = s.settle(start);
    let mut found_by = if found == start {
        "start"
    } else if by_pairs {
        "pairs"
    } else {
        "climb"
    };
    // Restarts from the best other configurations measured so far.
    let mut origins: Vec<Point> = vec![found.clone()];
    for _ in 0..limits.restarts {
        if s.budget_hit {
            break;
        }
        let mut ranked: Vec<(Point, f64)> =
            s.estimates.iter().map(|(p, &e)| (p.clone(), e)).collect();
        ranked.sort_by(|a, b| a.1.total_cmp(&b.1));
        let Some((origin, _)) = ranked.into_iter().find(|(p, _)| !origins.contains(p)) else {
            break;
        };
        origins.push(origin.clone());
        let (other, _) = s.settle(&origin);
        if other != found {
            if let Probe::Better = s.probe(&found, &other, Phase::Restart { origin }) {
                found = other;
                found_by = "restart";
            }
        }
    }
    // Confirmation: a fresh, longer trial of the finalist against the
    // known-good configuration (not taken from the cache).
    let mut confirmation = None;
    let mut locked = start.to_vec();
    if found != start {
        s.judge.confirming();
        match s.judge.compare(start, &found, limits.confirm_rounds) {
            Ok(c) => {
                s.trials += 1;
                let adopted = c.verdict == Verdict::Better;
                if adopted {
                    locked = found.clone();
                }
                let d = if adopted {
                    Decision::Adopted
                } else {
                    Decision::Kept
                };
                s.log(Phase::Confirm, start, &found, Some(c), d);
                confirmation = Some(c);
            }
            Err(r) => {
                let d = match r {
                    Refusal::Budget => {
                        s.budget_hit = true;
                        Decision::Budget
                    }
                    Refusal::Ineligible(why) => Decision::Ineligible(why),
                };
                s.log(Phase::Confirm, start, &found, None, d);
            }
        }
    }
    let mut estimates: Vec<(Point, f64)> = s.estimates.into_iter().collect();
    estimates.sort_by(|a, b| a.1.total_cmp(&b.1));
    Outcome {
        known_good: start.to_vec(),
        found,
        found_by,
        locked,
        confirmation,
        steps: s.steps,
        trials: s.trials,
        budget_hit: s.budget_hit,
        estimates,
    }
}

/// The decoder's search space: kernels (native SIMD or portable), the
/// coefficient pair window (none, 10, 11, 12 bits), workers (1 to
/// `max_workers`, the exploration ceiling) and adaptive workers. Only points
/// that map to a registered kit this CPU can run are valid.
pub fn decoder_space(max_workers: usize) -> Space {
    decoder_space_from(1, max_workers)
}
/// `decoder_space` with at least `floor` workers: what playback taught the
/// profile (a choice with fewer missed the policy's deadline share).
pub fn decoder_space_from(floor: usize, max_workers: usize) -> Space {
    let max = max_workers.clamp(1, 8);
    let floor = floor.clamp(1, max);
    Space::new(
        vec![
            Axis {
                name: "kernels",
                values: vec!["native".into(), "portable".into()],
                ordered: false,
            },
            Axis {
                name: "pairs",
                values: vec!["none".into(), "10".into(), "11".into(), "12".into()],
                ordered: true,
            },
            Axis {
                name: "workers",
                values: (1..=max).map(|w| w.to_string()).collect(),
                ordered: true,
            },
            Axis {
                name: "adaptive",
                values: vec!["off".into(), "on".into()],
                ordered: false,
            },
        ],
        move |p| {
            p.get(2).is_some_and(|&w| w + 1 >= floor)
                && kit_of(p)
                    .is_some_and(|k| kit::Features::detected().covers(kit::info_of(k).requires))
        },
    )
}
fn kit_of(p: &[usize]) -> Option<KitId> {
    match (p.first()?, p.get(1)?) {
        (0, 0) => Some(KitId::Compact),
        (0, 1) => Some(KitId::Pairs10),
        (0, 2) => Some(KitId::Default),
        (0, 3) => Some(KitId::Pairs12),
        (1, 0) => Some(KitId::Portable),
        _ => None,
    }
}
/// The decoder configuration of a point of `decoder_space`.
pub fn config_of(p: &[usize]) -> Option<Config> {
    Some(Config {
        kit: kit_of(p)?,
        workers: p.get(2)? + 1,
        adaptive: *p.get(3)? == 1,
    })
}
/// The point of `decoder_space` for `c`.
pub fn point_of(c: Config) -> Point {
    let (kernels, pairs) = match c.kit {
        KitId::Compact => (0, 0),
        KitId::Pairs10 => (0, 1),
        KitId::Default => (0, 2),
        KitId::Pairs12 => (0, 3),
        KitId::Portable => (1, 0),
    };
    vec![kernels, pairs, c.workers - 1, c.adaptive as usize]
}

#[cfg(test)]
mod tests {
    use super::super::tune::decide;
    use super::*;

    /// Simulated A/B/A trials over a cost table, decided by the live rule:
    /// each run is the cost times (1 + noise x u), u uniform in [-1, 1] from a
    /// fixed seed.
    struct TableJudge<F: Fn(&[usize]) -> Option<f64>> {
        cost: F,
        noise: f64,
        min_gain: f64,
        seed: u64,
        refuse_after: Option<usize>,
        calls: usize,
        /// Set by `confirming`: the refusal budget no longer applies.
        confirm_open: bool,
    }
    impl<F: Fn(&[usize]) -> Option<f64>> TableJudge<F> {
        fn new(cost: F, noise: f64) -> Self {
            Self {
                cost,
                noise,
                min_gain: 0.01,
                seed: 0x2545_f491_4f6c_dd1d,
                refuse_after: None,
                calls: 0,
                confirm_open: false,
            }
        }
        fn sample(&mut self, v: f64) -> f64 {
            self.seed ^= self.seed << 13;
            self.seed ^= self.seed >> 7;
            self.seed ^= self.seed << 17;
            let u = (self.seed >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0;
            v * (1.0 + self.noise * u)
        }
    }
    impl<F: Fn(&[usize]) -> Option<f64>> Judge for TableJudge<F> {
        fn compare(
            &mut self,
            a: &[usize],
            b: &[usize],
            rounds: usize,
        ) -> Result<Comparison, Refusal> {
            if !self.confirm_open && self.refuse_after.is_some_and(|n| self.calls >= n) {
                return Err(Refusal::Budget);
            }
            self.calls += 1;
            let ca = (self.cost)(a).ok_or_else(|| Refusal::Ineligible("not recorded".into()))?;
            let cb = (self.cost)(b).ok_or_else(|| Refusal::Ineligible("not recorded".into()))?;
            let values: Vec<(Vec<f64>, Vec<f64>)> = (0..rounds)
                .map(|r| {
                    if r % 2 == 0 {
                        let (x, y, z) = (self.sample(ca), self.sample(cb), self.sample(ca));
                        (vec![x, z], vec![y])
                    } else {
                        let (x, y, z) = (self.sample(cb), self.sample(ca), self.sample(cb));
                        (vec![y], vec![x, z])
                    }
                })
                .collect();
            let d = decide(&values, rounds, self.min_gain);
            let mut changes = d.changes.clone();
            changes.sort_by(f64::total_cmp);
            Ok(Comparison {
                verdict: d.verdict,
                change: changes[changes.len() / 2],
                noise: d.noise,
                threshold: d.threshold,
                basis: Basis::Metric,
            })
        }
        fn confirming(&mut self) {
            if self.refuse_after == Some(usize::MAX - 1) {
                self.confirm_open = true;
            }
        }
    }

    fn workers_only(n: usize) -> Space {
        Space::new(
            vec![Axis {
                name: "workers",
                values: (1..=n).map(|w| w.to_string()).collect(),
                ordered: true,
            }],
            |_| true,
        )
    }
    fn probed(o: &Outcome, p: &[usize]) -> bool {
        o.steps.iter().any(|s| s.candidate == p)
    }

    /// The tuner does not stop at four workers: it advances while that helps,
    /// goes past the knee to see the decline, and locks the peak (6).
    #[test]
    fn explores_past_four_and_past_the_knee() {
        let curve = [1.0, 0.55, 0.40, 0.33, 0.30, 0.28, 0.29, 0.31];
        let space = workers_only(8);
        let mut judge = TableJudge::new(|p: &[usize]| Some(curve[p[0]]), 0.002);
        let o = search(&space, &mut judge, &[3], Limits::default());
        assert_eq!(o.locked, vec![5], "{:?}", o.steps);
        assert!(
            probed(&o, &[6]) && probed(&o, &[7]),
            "explored past the knee"
        );
        assert_eq!(o.found_by, "climb");
        assert_eq!(o.confirmation.map(|c| c.verdict), Some(Verdict::Better));
    }

    /// A single setback does not end the climb (patience 2): it crosses a
    /// bump to a better point beyond.
    #[test]
    fn crosses_a_bump() {
        let curve = [1.0, 0.80, 0.85, 0.70, 0.75, 0.90];
        let mut judge = TableJudge::new(|p: &[usize]| Some(curve[p[0]]), 0.002);
        let o = search(&workers_only(6), &mut judge, &[0], Limits::default());
        assert_eq!(o.locked, vec![3]);
    }

    /// Two settings that do nothing alone but help together (as H1 and H2 did
    /// with H3) are found by the pair moves.
    #[test]
    fn finds_an_interaction() {
        let space = Space::new(
            vec![
                Axis {
                    name: "x",
                    values: vec!["0".into(), "1".into()],
                    ordered: false,
                },
                Axis {
                    name: "y",
                    values: vec!["0".into(), "1".into()],
                    ordered: false,
                },
            ],
            |_| true,
        );
        let cost = |p: &[usize]| {
            Some(match (p[0], p[1]) {
                (0, 0) => 1.0,
                (1, 0) => 1.005,
                (0, 1) => 1.004,
                _ => 0.97,
            })
        };
        let mut judge = TableJudge::new(cost, 0.001);
        let o = search(&space, &mut judge, &[0, 0], Limits::default());
        assert_eq!(o.locked, vec![1, 1]);
        assert_eq!(o.found_by, "pairs");
    }

    /// A restart from a runner-up reaches a better point the first climb
    /// stopped short of; without restarts the search keeps the local one.
    #[test]
    fn restarts_find_a_second_optimum() {
        let curve = [1.0, 0.90, 0.95, 0.96, 0.85];
        let mut judge = TableJudge::new(|p: &[usize]| Some(curve[p[0]]), 0.002);
        let o = search(&workers_only(5), &mut judge, &[0], Limits::default());
        assert_eq!(o.locked, vec![4]);
        assert_eq!(o.found_by, "restart");
        let mut judge = TableJudge::new(|p: &[usize]| Some(curve[p[0]]), 0.002);
        let limits = Limits {
            restarts: 0,
            ..Limits::default()
        };
        let o = search(&workers_only(5), &mut judge, &[0], limits);
        assert_eq!(o.locked, vec![1], "local optimum without restarts");
    }

    /// When differences are within the noise nothing is adopted: the
    /// known-good configuration stays (INV-AUTOTUNE-007).
    #[test]
    fn noise_keeps_the_known_good() {
        let curve = [1.0, 0.99, 0.995, 1.01];
        let mut judge = TableJudge::new(|p: &[usize]| Some(curve[p[0]]), 0.05);
        let o = search(&workers_only(4), &mut judge, &[0], Limits::default());
        assert_eq!(o.locked, vec![0]);
    }

    /// The trial budget stops the search; a refused confirmation (time
    /// budget) keeps the known-good configuration.
    #[test]
    fn budgets_bound_the_search() {
        let curve = [1.0, 0.55, 0.40, 0.33, 0.30, 0.28, 0.29, 0.31];
        let mut judge = TableJudge::new(|p: &[usize]| Some(curve[p[0]]), 0.002);
        let limits = Limits {
            max_trials: 2,
            ..Limits::default()
        };
        let o = search(&workers_only(8), &mut judge, &[3], limits);
        assert!(o.budget_hit);
        assert!(o.trials <= 3, "two search trials and the confirmation");
        assert_eq!(o.locked, vec![5], "the confirmed improvement within budget");
        let mut judge = TableJudge::new(|p: &[usize]| Some(curve[p[0]]), 0.002);
        judge.refuse_after = Some(2);
        let o = search(&workers_only(8), &mut judge, &[3], Limits::default());
        assert!(o.budget_hit);
        assert_eq!(o.locked, vec![3], "unconfirmed: the known-good stays");
    }

    /// A judge with a budget kept for the confirmation: the search spends its
    /// own, and what it found is still confirmed and locked.
    #[test]
    fn confirmation_has_its_own_budget() {
        let curve = [1.0, 0.55, 0.40, 0.33, 0.30, 0.28, 0.29, 0.31];
        let mut judge = TableJudge::new(|p: &[usize]| Some(curve[p[0]]), 0.002);
        // usize::MAX - 1 marks "keeps a confirmation budget" for this judge.
        judge.refuse_after = Some(usize::MAX - 1);
        judge.calls = usize::MAX - 3;
        let o = search(&workers_only(8), &mut judge, &[3], Limits::default());
        assert!(o.budget_hit, "the search ran out of its own budget");
        assert_eq!(o.locked, vec![5], "{:?}", o.steps);
        assert!(o.confirmation.is_some());
    }

    /// Recorded S25 measurements (milestone 2, sd-inter, cycles): from the
    /// portable fallback the search reaches the measured best, default/1,
    /// through the kit axes; configurations nothing was recorded for are
    /// refused, never assumed.
    #[test]
    fn recorded_s25_table_from_the_fallback() {
        let recorded: HashMap<&str, f64> = HashMap::from([
            ("default/1", 0.8179),
            ("portable/1", 1.2771),
            ("pairs10/1", 0.8325),
            ("pairs12/1", 0.8229),
            ("compact/1", 0.8542),
            ("default/2", 0.8386),
            ("default/4", 0.8425),
        ]);
        let space = decoder_space(4);
        let cost =
            move |p: &[usize]| config_of(p).and_then(|c| recorded.get(c.label().as_str()).copied());
        let mut judge = TableJudge::new(cost, 0.002);
        let start = point_of(Config {
            kit: KitId::Portable,
            workers: 1,
            adaptive: false,
        });
        let o = search(&space, &mut judge, &start, Limits::default());
        let locked = config_of(&o.locked).expect("a kit");
        assert_eq!(locked.label(), "default/1", "{:#?}", o.steps);
        assert!(o
            .steps
            .iter()
            .any(|s| matches!(s.decision, Decision::Ineligible(_))));
    }

    #[test]
    fn a_floor_removes_fewer_workers() {
        let space = decoder_space_from(3, 4);
        assert!(!space.valid(&[0, 2, 1, 0]), "2 workers below the floor");
        assert!(space.valid(&[0, 2, 2, 0]) && space.valid(&[0, 2, 3, 0]));
    }

    #[test]
    fn decoder_space_maps_kits_both_ways() {
        let space = decoder_space(8);
        for k in kit::available() {
            for workers in [1, 4, 8] {
                let c = Config {
                    kit: k.id,
                    workers,
                    adaptive: workers == 4,
                };
                let p = point_of(c);
                assert!(space.valid(&p));
                assert_eq!(config_of(&p), Some(c));
            }
        }
        // Portable kernels exist only without pair tables.
        assert!(!space.valid(&[1, 2, 0, 0]));
    }
}
