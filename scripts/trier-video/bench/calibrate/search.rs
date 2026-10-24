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

//! `yoyo`: the Yo-Yo search for the best configuration on one sample.

use super::*;

pub(super) fn search(args: &[String]) -> i32 {
    let (Some(dir), Some(name)) = (args.first(), option(args, "--sample")) else {
        eprintln!("usage: yoyo <samples-dir> --sample <name> [options]");
        return 2;
    };
    let num = |flag: &str, default: f64| -> f64 {
        option(args, flag)
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    };
    let machine = platform::Machine::detect();
    let max_workers = num("--max-workers", machine.usable_cores.min(8) as f64) as usize;
    let start = match option(args, "--start") {
        Some(t) => match tune::Config::parse(t) {
            Some(c) => c,
            None => {
                eprintln!("bad --start {t}");
                return 2;
            }
        },
        // The production default: the default kit, MV13's worker count.
        None => tune::Config {
            kit: kit::KitId::Default,
            workers: crate::trier_video::Resources::detect().threads,
            adaptive: false,
        },
    };
    let metric = match option(args, "--metric").map(tune::Metric::parse) {
        Some(Some(m)) => m,
        Some(None) => {
            eprintln!("bad --metric");
            return 2;
        }
        None => tune::Metric::Cycles,
    };
    let rule = match option(args, "--policy").map(tune::Policy::parse) {
        Some(Some(p)) => policy_rule(p),
        Some(None) => {
            eprintln!("bad --policy");
            return 2;
        }
        None => tune::Rule::Metric(metric),
    };
    if !apply_affinity(args) {
        return 2;
    }
    let limits = yoyo::Limits {
        max_trials: num("--trials", 40.0) as usize,
        rounds: num("--rounds", 3.0) as usize,
        confirm_rounds: num("--confirm-rounds", 5.0) as usize,
        ..yoyo::Limits::default()
    };
    let entries = match load(Path::new(dir), &[name.to_string()]) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("samples: {e}");
            return 1;
        }
    };
    let e = &entries[0];
    let units: Vec<&[u8]> = crate::access_units(&e.data)
        .into_iter()
        .map(|(u, _)| u)
        .collect();
    let passes = tune::Sample::passes_for(units.len(), num("--pictures", 300.0) as usize);
    let sample = tune::Sample {
        name: e.name.clone(),
        class: e.class.clone(),
        units,
        period_us: 1e6 * e.rate.1 as f64 / e.rate.0 as f64,
        passes,
    };
    let space = yoyo::decoder_space(max_workers);
    let start_point = yoyo::point_of(start);
    if !space.valid(&start_point) {
        eprintln!(
            "start {} is outside the space (workers 1-{max_workers})",
            start.label()
        );
        return 2;
    }
    let budget = num("--budget", 900.0);
    let mut judge = match tune::LiveJudge::new(&sample, start, rule, 0.01, tune::deadline(budget)) {
        Ok(j) => j,
        Err(why) => {
            eprintln!("{why}");
            return 1;
        }
    };
    let before = crate::conditions();
    println!("machine: {}", machine.summary());
    println!("before: {before}");
    println!(
        "sample {} ({}, {}), {} pictures x {} passes; {}; known-good {}; workers explored 1-{max_workers}",
        e.name,
        e.class,
        e.kind,
        sample.units.len(),
        passes,
        rule_name(rule),
        start.label()
    );
    let started = std::time::Instant::now();
    let o = yoyo::search(&space, &mut judge, &start_point, limits);
    let label = |p: &[usize]| yoyo::config_of(p).map_or("?".into(), |c| c.label());
    for (i, st) in o.steps.iter().enumerate() {
        let phase = match &st.phase {
            yoyo::Phase::Climb { axis, up } => format!(
                "climb {} {}",
                space.axes[*axis].name,
                if *up { "up" } else { "down" }
            ),
            yoyo::Phase::Choose { axis } => format!("choose {}", space.axes[*axis].name),
            yoyo::Phase::Pair { first, second } => {
                format!(
                    "pair {}+{}",
                    space.axes[*first].name, space.axes[*second].name
                )
            }
            yoyo::Phase::Restart { origin } => format!("restart from {}", label(origin)),
            yoyo::Phase::Confirm => "confirm".into(),
        };
        let measured = st.comparison.map_or(String::new(), |c| {
            format!(
                "{:+6.2}% (noise {:.2}%, threshold {:.2}%) {:?}{}",
                100.0 * c.change,
                100.0 * c.noise,
                100.0 * c.threshold,
                c.verdict,
                match c.basis {
                    yoyo::Basis::Constraint => " by constraint",
                    yoyo::Basis::BothFail => " both fail: p99",
                    _ => "",
                }
            )
        });
        println!(
            "{:>3} {:<24} {:>12} -> {:<12} {:<52} {:?}",
            i + 1,
            phase,
            label(&st.incumbent),
            label(&st.candidate),
            measured,
            st.decision
        );
    }
    println!(
        "found {} (by {}), confirmation {}, locked {}; {} trials in {:.0} s{}",
        label(&o.found),
        o.found_by,
        o.confirmation.map_or("none".into(), |c| format!(
            "{:+.2}% {:?}",
            100.0 * c.change,
            c.verdict
        )),
        label(&o.locked),
        o.trials,
        started.elapsed().as_secs_f64(),
        if o.budget_hit { ", budget reached" } else { "" }
    );
    for (t, met) in judge.trials.iter().zip(&judge.constraints) {
        for (c, m) in [(t.a, &met[0]), (t.b, &met[1])] {
            if let Err(why) = m {
                println!("  constraint: {} {why}", c.label());
            }
        }
    }
    println!(
        "estimated {} relative to {} (lowest first): {}",
        rule_name(rule),
        start.label(),
        o.estimates
            .iter()
            .map(|(p, e)| format!("{} {:.3}", label(p), e))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let after = crate::conditions();
    println!("after:  {after}");
    if let Some(path) = option(args, "--json") {
        let steps = arr(o.steps.iter().map(|st| {
            format!(
                "{{\"phase\":{},\"incumbent\":{},\"candidate\":{},\"change\":{},\"noise\":{},\"threshold\":{},\"verdict\":{},\"basis\":{},\"decision\":{}}}",
                s(&format!("{:?}", st.phase)),
                s(&label(&st.incumbent)),
                s(&label(&st.candidate)),
                st.comparison.map_or("null".into(), |c| num_json(c.change)),
                st.comparison.map_or("null".into(), |c| num_json(c.noise)),
                st.comparison.map_or("null".into(), |c| num_json(c.threshold)),
                st.comparison.map_or("null".into(), |c| s(&format!("{:?}", c.verdict))),
                st.comparison.map_or("null".into(), |c| s(&format!("{:?}", c.basis))),
                s(&format!("{:?}", st.decision))
            )
        }));
        let trials = arr(judge.trials.iter().map(|t| {
            let side = |side: tune::Side| -> String {
                let runs: Vec<&tune::Run> = t
                    .rounds
                    .iter()
                    .flatten()
                    .filter(|(s, _)| *s == side)
                    .map(|(_, r)| r)
                    .collect();
                let med = |f: &dyn Fn(&tune::Run) -> Option<f64>| {
                    median(&runs.iter().filter_map(|r| f(r)).collect::<Vec<_>>())
                };
                format!(
                    "{{\"cycles\":{},\"cpuUs\":{},\"wallUs\":{},\"meanUs\":{},\"p99Us\":{},\"maxUs\":{},\"maxPressureUs\":{},\"peakRss\":{}}}",
                    num_json(med(&|r| r.cycles.map(|c| c as f64))),
                    num_json(med(&|r| r.cpu_us)),
                    num_json(med(&|r| Some(r.wall_us))),
                    num_json(med(&|r| Some(r.mean_us))),
                    num_json(med(&|r| Some(r.p99_us))),
                    num_json(med(&|r| Some(r.max_us))),
                    num_json(med(&|r| Some(r.max_pressure_us))),
                    num_json(med(&|r| r.peak_rss.map(|m| m as f64)))
                )
            };
            format!(
                "{{\"a\":{},\"b\":{},\"verdict\":{},\"changes\":{},\"noise\":{},\"medianA\":{},\"medianB\":{}}}",
                s(&t.a.label()),
                s(&t.b.label()),
                s(&format!("{:?}", t.verdict)),
                arr(t.changes.iter().map(|c| num_json(*c))),
                num_json(t.noise),
                side(tune::Side::A),
                side(tune::Side::B)
            )
        }));
        let doc = format!(
            "{{\"tool\":\"trier-video-bench yoyo\",\"registry\":{},\"machine\":{},\"conditionsBefore\":{},\"conditionsAfter\":{},\"sample\":{},\"metric\":{},\"knownGood\":{},\"maxWorkers\":{max_workers},\"limits\":{{\"maxTrials\":{},\"patience\":{},\"restarts\":{},\"rounds\":{},\"confirmRounds\":{}}},\"budgetSeconds\":{budget},\"found\":{},\"foundBy\":{},\"locked\":{},\"confirmation\":{},\"trialsRun\":{},\"budgetHit\":{},\"estimates\":{},\"steps\":{steps},\"trials\":{trials}}}\n",
            registry_json(),
            machine_json(&machine),
            s(&before),
            s(&after),
            s(&e.name),
            s(&rule_name(rule)),
            s(&start.label()),
            limits.max_trials,
            limits.patience,
            limits.restarts,
            limits.rounds,
            limits.confirm_rounds,
            s(&label(&o.found)),
            s(o.found_by),
            s(&label(&o.locked)),
            o.confirmation.map_or("null".into(), |c| format!(
                "{{\"change\":{},\"noise\":{},\"threshold\":{},\"verdict\":{}}}",
                num_json(c.change),
                num_json(c.noise),
                num_json(c.threshold),
                s(&format!("{:?}", c.verdict))
            )),
            o.trials,
            o.budget_hit,
            arr(o.estimates.iter().map(|(p, e)| format!(
                "{{\"config\":{},\"relative\":{}}}",
                s(&label(p)),
                num_json(*e)
            )))
        );
        if let Err(err) = std::fs::write(path, doc) {
            eprintln!("{path}: {err}");
            return 1;
        }
        println!("json: {path}");
    }
    0
}

pub(super) fn num_json(v: f64) -> String {
    num(v)
}
