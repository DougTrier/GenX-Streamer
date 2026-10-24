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

//! `validate`: the same searches repeated across sessions and thermal states.

use super::*;

/// One search of a validation: its session, thermal state, sample, policy,
/// outcome, duration and CPU temperature before and after.
pub(super) struct SearchRun {
    pub(super) session: usize,
    pub(super) state: String,
    pub(super) sample: String,
    pub(super) policy: tune::Policy,
    pub(super) outcome: yoyo::Outcome,
    pub(super) seconds: f64,
    pub(super) before: Option<f64>,
    pub(super) after: Option<f64>,
}

pub(super) fn validate(args: &[String]) -> i32 {
    let Some(dir) = args.first() else {
        eprintln!("usage: validate <samples-dir> [options]");
        return 2;
    };
    let arg = |flag: &str, default: f64| -> f64 {
        option(args, flag)
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    };
    let list = |flag: &str, default: &str| -> Vec<String> {
        option(args, flag)
            .unwrap_or(default)
            .split(',')
            .filter(|x| !x.is_empty())
            .map(String::from)
            .collect()
    };
    let names = list("--samples", "hd1080i-intra,sd-inter");
    let policies: Vec<tune::Policy> = match list("--policies", "performance,balanced,efficiency")
        .iter()
        .map(|p| tune::Policy::parse(p))
        .collect::<Option<Vec<_>>>()
    {
        Some(p) => p,
        None => {
            eprintln!("bad --policies");
            return 2;
        }
    };
    let states = list("--states", "cool,warm");
    let sessions = arg("--sessions", 2.0) as usize;
    if !apply_affinity(args) {
        return 2;
    }
    let machine = platform::Machine::detect();
    let max_workers = arg("--max-workers", machine.usable_cores.min(8) as f64) as usize;
    let start = tune::Config {
        kit: kit::KitId::Default,
        workers: crate::trier_video::Resources::detect()
            .threads
            .min(max_workers),
        adaptive: false,
    };
    let limits = yoyo::Limits {
        max_trials: arg("--trials", 40.0) as usize,
        ..yoyo::Limits::default()
    };
    let budget = arg("--budget", 600.0);
    let entries = match load(Path::new(dir), &names) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("samples: {e}");
            return 1;
        }
    };
    let samples: Vec<tune::Sample> = entries
        .iter()
        .map(|e| {
            let units: Vec<&[u8]> = crate::access_units(&e.data)
                .into_iter()
                .map(|(u, _)| u)
                .collect();
            tune::Sample {
                passes: tune::Sample::passes_for(units.len(), arg("--pictures", 300.0) as usize),
                name: e.name.clone(),
                class: e.class.clone(),
                units,
                period_us: 1e6 * e.rate.1 as f64 / e.rate.0 as f64,
            }
        })
        .collect();
    let heavy = samples
        .iter()
        .max_by_key(|s| s.units.iter().map(|u| u.len()).sum::<usize>())
        .expect("a sample");
    let space = yoyo::decoder_space(max_workers);
    let label = |p: &[usize]| yoyo::config_of(p).map_or("?".into(), |c| c.label());
    println!("machine: {}", machine.summary());
    println!(
        "known-good {}; workers explored 1-{max_workers}; {} sessions ({}); policies {}",
        start.label(),
        sessions,
        states.join(","),
        policies
            .iter()
            .map(|p| p.name())
            .collect::<Vec<_>>()
            .join(",")
    );
    let mut results: Vec<SearchRun> = Vec::new();
    let mut prepared = Vec::new();
    for session in 0..sessions {
        let state = states[session % states.len().max(1)].clone();
        let note = prepare(
            &state,
            arg("--cool-temp", 42.0),
            arg("--cool-wait", 600.0),
            arg("--soak", 90.0),
            heavy,
            max_workers,
        );
        println!("session {} {note}", session + 1);
        prepared.push(note);
        for sample in &samples {
            for &policy in &policies {
                let rule = policy_rule(policy);
                let t0 = platform::cpu_temperature();
                let started = std::time::Instant::now();
                let mut judge =
                    match tune::LiveJudge::new(sample, start, rule, 0.01, tune::deadline(budget)) {
                        Ok(j) => j,
                        Err(why) => {
                            eprintln!("{why}");
                            return 1;
                        }
                    };
                let o = yoyo::search(&space, &mut judge, &yoyo::point_of(start), limits);
                let secs = started.elapsed().as_secs_f64();
                let t1 = platform::cpu_temperature();
                println!(
                    "  {:<14} {:<12} locked {:<12} (found {} by {}, confirmation {}) {} trials {:.0} s{} CPU {} -> {}",
                    sample.name,
                    policy.name(),
                    label(&o.locked),
                    label(&o.found),
                    o.found_by,
                    o.confirmation
                        .map_or("none".into(), |c| format!("{:+.1}% {:?}", 100.0 * c.change, c.verdict)),
                    o.trials,
                    secs,
                    if o.budget_hit { " budget" } else { "" },
                    t0.map_or("?".into(), |t| format!("{t:.0}C")),
                    t1.map_or("?".into(), |t| format!("{t:.0}C"))
                );
                results.push(SearchRun {
                    session,
                    state: state.clone(),
                    sample: sample.name.clone(),
                    policy,
                    outcome: o,
                    seconds: secs,
                    before: t0,
                    after: t1,
                });
            }
        }
    }
    // Stability: the same winner in every session, or winners a direct
    // trial cannot tell apart (equivalent); otherwise unstable.
    let key = profile::HardwareKey::of(&machine, &os_text(args));
    let mut profile_out = option(args, "--profile").map(|p| open_profile(p, &key));
    println!("stability:");
    let mut stability = Vec::new();
    for sample in &samples {
        for &policy in &policies {
            let winners: Vec<yoyo::Point> = results
                .iter()
                .filter(|r| r.sample == sample.name && r.policy == policy)
                .map(|r| r.outcome.locked.clone())
                .collect();
            let mut distinct = winners.clone();
            distinct.sort();
            distinct.dedup();
            let mut checks = Vec::new();
            let verdict = if distinct.len() <= 1 {
                "repeatable".to_string()
            } else {
                let rule = policy_rule(policy);
                let mut judge =
                    match tune::LiveJudge::new(sample, start, rule, 0.01, tune::deadline(budget)) {
                        Ok(j) => j,
                        Err(why) => {
                            eprintln!("{why}");
                            return 1;
                        }
                    };
                let mut all_equivalent = true;
                for i in 0..distinct.len() {
                    for j in i + 1..distinct.len() {
                        use yoyo::Judge as _;
                        let c = judge.compare(&distinct[i], &distinct[j], limits.confirm_rounds);
                        let text = match &c {
                            Ok(c) => format!(
                                "{} vs {}: {:+.2}% {:?} ({:?})",
                                label(&distinct[j]),
                                label(&distinct[i]),
                                100.0 * c.change,
                                c.verdict,
                                c.basis
                            ),
                            Err(r) => {
                                format!("{} vs {}: {r:?}", label(&distinct[j]), label(&distinct[i]))
                            }
                        };
                        if !matches!(&c, Ok(c) if c.verdict == crate::trier_video::tune::Verdict::Inconclusive)
                        {
                            all_equivalent = false;
                        }
                        checks.push(text);
                    }
                }
                if all_equivalent {
                    "equivalent".into()
                } else {
                    "unstable".into()
                }
            };
            println!(
                "  {:<14} {:<12} {:<11} winners [{}] {}",
                sample.name,
                policy.name(),
                verdict,
                winners
                    .iter()
                    .map(|p| label(p))
                    .collect::<Vec<_>>()
                    .join(", "),
                checks.join("; ")
            );
            if let Some(prof) = profile_out.as_mut() {
                // The choice: the winner seen most often (on a tie, the one with
                // fewer workers). Unstable results are kept as evidence only.
                let mut best: Option<(usize, &yoyo::Point)> = None;
                for w in &distinct {
                    let n = winners.iter().filter(|x| *x == w).count();
                    let better = match best {
                        None => true,
                        Some((m, b)) => n > m || (n == m && w[2] < b[2]),
                    };
                    if better {
                        best = Some((n, w));
                    }
                }
                let chosen = best
                    .map(|(_, w)| w.clone())
                    .unwrap_or_else(|| yoyo::point_of(start));
                let last = results.iter().rev().find(|r| {
                    r.sample == sample.name && r.policy == policy && r.outcome.locked == chosen
                });
                let (change, noise, trials) = last
                    .and_then(|r| {
                        r.outcome
                            .confirmation
                            .map(|c| (c.change, c.noise, r.outcome.trials))
                    })
                    .unwrap_or((0.0, 0.0, 0));
                if let Some(config) = yoyo::config_of(&chosen) {
                    prof.record(profile::Entry {
                        class: class_of(sample),
                        policy,
                        config,
                        change,
                        noise,
                        trials,
                        stability: verdict.clone(),
                        date: profile::utc_now(),
                        conditions: format!(
                            "{} sessions ({}), {}",
                            sessions,
                            (0..sessions)
                                .map(|i| states[i % states.len().max(1)].as_str())
                                .collect::<Vec<_>>()
                                .join(","),
                            power_text()
                        ),
                        source: "bench".into(),
                        degradations: 0,
                        floor: 1,
                    });
                }
            }
            stability.push(format!(
                "{{\"sample\":{},\"policy\":{},\"verdict\":{},\"winners\":{},\"checks\":{}}}",
                s(&sample.name),
                s(policy.name()),
                s(&verdict),
                arr(winners.iter().map(|p| s(&label(p)))),
                arr(checks.iter().map(|c| s(c)))
            ));
        }
    }
    if let (Some(prof), Some(path)) = (&profile_out, option(args, "--profile")) {
        match prof.save(Path::new(path)) {
            Ok(()) => println!("profile: {path}"),
            Err(e) => {
                eprintln!("profile {path}: {e}");
                return 1;
            }
        }
    }
    if let Some(path) = option(args, "--json") {
        let runs = arr(results.iter().map(|r| {
            let (session, state, sample, policy, o, secs, t0, t1) =
                (&r.session, &r.state, &r.sample, &r.policy, &r.outcome, &r.seconds, &r.before, &r.after);
            format!(
                "{{\"session\":{},\"state\":{},\"sample\":{},\"policy\":{},\"locked\":{},\"found\":{},\"foundBy\":{},\"confirmation\":{},\"trials\":{},\"budgetHit\":{},\"seconds\":{},\"tempBefore\":{},\"tempAfter\":{},\"steps\":{}}}",
                session + 1,
                s(state),
                s(sample),
                s(policy.name()),
                s(&label(&o.locked)),
                s(&label(&o.found)),
                s(o.found_by),
                o.confirmation.map_or("null".into(), |c| format!(
                    "{{\"change\":{},\"verdict\":{},\"basis\":{}}}",
                    num(c.change),
                    s(&format!("{:?}", c.verdict)),
                    s(&format!("{:?}", c.basis))
                )),
                o.trials,
                o.budget_hit,
                num(*secs),
                t0.map_or("null".into(), num),
                t1.map_or("null".into(), num),
                arr(o.steps.iter().map(|st| format!(
                    "{{\"incumbent\":{},\"candidate\":{},\"change\":{},\"verdict\":{},\"basis\":{},\"decision\":{}}}",
                    s(&label(&st.incumbent)),
                    s(&label(&st.candidate)),
                    st.comparison.map_or("null".into(), |c| num(c.change)),
                    st.comparison.map_or("null".into(), |c| s(&format!("{:?}", c.verdict))),
                    st.comparison.map_or("null".into(), |c| s(&format!("{:?}", c.basis))),
                    s(&format!("{:?}", st.decision))
                )))
            )
        }));
        let doc = format!(
            "{{\"tool\":\"trier-video-bench validate\",\"decoder\":{},\"registryHash\":{},\"registry\":{},\"machine\":{},\"knownGood\":{},\"maxWorkers\":{max_workers},\"operatingCeiling\":{},\"cyclesCounted\":{},\"sessions\":{},\"runs\":{runs},\"stability\":[{}]}}\n",
            s(profile::DECODER_VERSION),
            s(&profile::registry_hash()),
            registry_json(),
            machine_json(&machine),
            s(&start.label()),
            crate::trier_video::Resources::detect().threads,
            tune::LiveJudge::cycles_counted(),
            arr(prepared.iter().map(|p| s(p))),
            stability.join(",")
        );
        if let Err(err) = std::fs::write(path, doc) {
            eprintln!("{path}: {err}");
            return 1;
        }
        println!("json: {path}");
    }
    0
}

pub(super) fn median(v: &[f64]) -> f64 {
    let mut v = v.to_vec();
    v.sort_by(f64::total_cmp);
    v.get(v.len() / 2).copied().unwrap_or(f64::NAN)
}
