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

//! Tests of Trier AutoTune.

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
