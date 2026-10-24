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
    fn compare(&mut self, a: &[usize], b: &[usize], rounds: usize) -> Result<Comparison, Refusal> {
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
