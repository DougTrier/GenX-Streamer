//! `calibrate`: Trier AutoTune's deterministic calibration harness
//! (docs/trier-adaptive-engine.md, milestone 2), and `cross`: CPU cycles of
//! separate builds compared on the same core (for build-level questions such
//! as what the kit registry costs).
//!
//! trier-video-bench calibrate <samples-dir> [--configs default/1,pairs10/1,...]
//!     [--rounds 3] [--metric cycles|cpu|wall|p99] [--min-gain 0.01]
//!     [--budget 600] [--samples sd-inter,...] [--pictures 300] [--json out.json]
//!     [--affinity <mask>]  (Windows: pin the process, as `taskset` does on
//!     Linux and Android; unpinned runs migrate between core types and their
//!     noise makes most verdicts inconclusive)
//! trier-video-bench yoyo <samples-dir> --sample <name> [--metric cycles|cpu|wall|p99
//!     | --policy performance|balanced|efficiency]
//!     [--start default/4] [--max-workers 8] [--rounds 3] [--confirm-rounds 5]
//!     [--trials 40] [--budget 900] [--pictures 300] [--affinity <mask>] [--json out.json]
//!     (the Yo-Yo search on one sample; the start defaults to the production
//!     default, the exploration ceiling to min(8, usable cores))
//! trier-video-bench validate <samples-dir> [--samples a,b] [--policies p,q,r]
//!     [--sessions 2] [--states cool,warm] [--cool-temp 42] [--cool-wait 600]
//!     [--soak 90] [--budget 600] [--trials 40] [--max-workers N]
//!     [--affinity <mask>] [--json out.json]
//!     (milestone 4: the same searches repeated across sessions and thermal
//!     states; winners compared directly where they differ)
//! trier-video-bench stage-a <dir with sd.m2v, hd720.m2v, hd1080i.m2v>
//!     --profile <path> [--policy balanced] [--budget 120] [--os <text>]
//!     (the app's Stage A calibration, run from the shell to test it)
//! trier-video-bench profile show <path> [--os <text>]
//!     (yoyo and validate take --profile <path> [--os <text>] to record results)
//! trier-video-bench cross <rounds> <exe>... -- <args for each exe>
//!     (TRIER_CROSS_MASK: the CPU affinity mask, default 4 = core 2)

use crate::trier_video::{kit, platform, profile, tune, yoyo};
use std::fmt::Write as _;
use std::path::Path;

pub fn run(args: &[String]) -> Option<i32> {
    match args.get(1).map(String::as_str) {
        Some("calibrate") => Some(calibrate(&args[2..])),
        Some("cross") => Some(cross(&args[2..])),
        Some("yoyo") => Some(search(&args[2..])),
        Some("validate") => Some(validate(&args[2..])),
        Some("profile") => Some(show_profile(&args[2..])),
        Some("stage-a") => Some(stage_a(&args[2..])),
        _ => None,
    }
}

struct Entry {
    name: String,
    class: String,
    kind: String,
    rate: (u64, u64),
    bytes: usize,
    fnv: String,
    data: Vec<u8>,
}

fn fnv64(data: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in data {
        h = (h ^ b as u64).wrapping_mul(0x100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Reads samples.tsv and every sample, refusing any whose size or checksum
/// differs from the manifest (the samples are fixed: INV-AUTOTUNE-005, 009).
fn load(dir: &Path, only: &[String]) -> Result<Vec<Entry>, String> {
    let manifest = std::fs::read_to_string(dir.join("samples.tsv"))
        .map_err(|e| format!("{}: {e}", dir.join("samples.tsv").display()))?;
    let mut out = Vec::new();
    for line in manifest.lines().skip(1).filter(|l| !l.trim().is_empty()) {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() != 9 {
            return Err(format!("bad manifest line: {line}"));
        }
        if !only.is_empty() && !only.iter().any(|o| o == f[0]) {
            continue;
        }
        let data = std::fs::read(dir.join(format!("{}.m2v", f[0])))
            .map_err(|e| format!("{}: {e}", f[0]))?;
        let fnv = fnv64(&data);
        if data.len().to_string() != f[7] || fnv != f[8] {
            return Err(format!(
                "{}: differs from the manifest (size or checksum)",
                f[0]
            ));
        }
        out.push(Entry {
            name: f[0].into(),
            class: f[1].into(),
            kind: f[2].into(),
            rate: (
                f[5].parse().map_err(|_| "rate")?,
                f[6].parse().map_err(|_| "rate")?,
            ),
            bytes: data.len(),
            fnv,
            data,
        });
    }
    if out.is_empty() {
        return Err("no samples selected".into());
    }
    Ok(out)
}

fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn calibrate(args: &[String]) -> i32 {
    let Some(dir) = args.first() else {
        eprintln!("usage: calibrate <samples-dir> [options]");
        return 2;
    };
    let only: Vec<String> = option(args, "--samples")
        .map(|s| s.split(',').map(String::from).collect())
        .unwrap_or_default();
    let configs: Vec<tune::Config> = match option(args, "--configs") {
        Some(list) => match list
            .split(',')
            .map(tune::Config::parse)
            .collect::<Option<Vec<_>>>()
        {
            Some(c) if !c.is_empty() => c,
            _ => {
                eprintln!("bad --configs {list}");
                return 2;
            }
        },
        // Every available kit on one worker, then the default on 2 and 4.
        None => kit::available()
            .map(|k| tune::Config {
                kit: k.id,
                workers: 1,
                adaptive: false,
            })
            .chain([2, 4].map(|w| tune::Config {
                kit: kit::KitId::Default,
                workers: w,
                adaptive: false,
            }))
            .collect(),
    };
    let rounds: usize = option(args, "--rounds")
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let pictures: usize = option(args, "--pictures")
        .and_then(|v| v.parse().ok())
        .unwrap_or(300);
    let min_gain: f64 = option(args, "--min-gain")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.01);
    let budget: f64 = option(args, "--budget")
        .and_then(|v| v.parse().ok())
        .unwrap_or(600.0);
    let wanted_metric = option(args, "--metric").map(|m| tune::Metric::parse(m).ok_or(m));
    if let Some(Err(m)) = wanted_metric {
        eprintln!("bad --metric {m}");
        return 2;
    }
    let entries = match load(Path::new(dir), &only) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("samples: {e}");
            return 1;
        }
    };
    let affinity = option(args, "--affinity")
        .map(|m| usize::from_str_radix(m.trim_start_matches("0x"), 16).unwrap_or(0));
    if let Some(mask) = affinity {
        #[cfg(windows)]
        // SAFETY: the current process's pseudo-handle and a plain mask.
        if mask == 0
            || unsafe { tune::win::SetProcessAffinityMask(tune::win::GetCurrentProcess(), mask) }
                == 0
        {
            eprintln!("--affinity {mask:#x} not applied");
            return 2;
        }
        #[cfg(not(windows))]
        {
            eprintln!("--affinity {mask:#x}: use taskset on this system");
            return 2;
        }
    }
    let deadline = tune::deadline(budget);
    let machine = platform::Machine::detect();
    let before = crate::conditions();
    println!("machine: {}", machine.summary());
    println!("before: {before}");
    let incumbent = configs[0];
    let mut json_samples = Vec::new();
    let mut failed = false;
    for e in &entries {
        let units: Vec<&[u8]> = crate::access_units(&e.data)
            .into_iter()
            .map(|(u, _)| u)
            .collect();
        let passes = tune::Sample::passes_for(units.len(), pictures);
        let sample = tune::Sample {
            name: e.name.clone(),
            class: e.class.clone(),
            units,
            period_us: 1e6 * e.rate.1 as f64 / e.rate.0 as f64,
            passes,
        };
        // Output identity first, untimed: a configuration that decodes
        // differently from the incumbent is excluded, never timed.
        let mut prints = Vec::new();
        let mut eligible = Vec::new();
        let mut excluded = Vec::new();
        for &c in &configs {
            match tune::fingerprint(&sample, c) {
                Ok(h) => prints.push((c, h)),
                Err(why) => excluded.push((c, why)),
            }
        }
        let reference = prints
            .iter()
            .find(|(c, _)| *c == incumbent)
            .map(|(_, h)| *h);
        for &(c, h) in &prints {
            if Some(h) == reference {
                eligible.push(c);
            } else {
                excluded.push((c, format!("output {h:016x} differs from the incumbent's")));
                failed = true;
            }
        }
        println!(
            "sample {} ({}, {}): {} pictures x {} passes, period {:.0} us, output {}",
            e.name,
            e.class,
            e.kind,
            sample.units.len(),
            sample.passes,
            sample.period_us,
            reference.map_or("none".into(), |h| format!("{h:016x}"))
        );
        for (c, why) in &excluded {
            println!("  excluded {}: {why}", c.label());
        }
        let mut trials = Vec::new();
        if eligible.contains(&incumbent) {
            // The metric: the one asked for, else the best this machine has.
            let probe = match tune::run(&sample, incumbent) {
                Ok(r) => r,
                Err(why) => {
                    eprintln!("  {}: {why}", incumbent.label());
                    return 1;
                }
            };
            let metric = match wanted_metric {
                Some(Ok(m)) => m,
                _ => tune::Metric::preferred(&probe),
            };
            for &b in eligible.iter().filter(|&&c| c != incumbent) {
                match tune::trial(&sample, incumbent, b, metric, rounds, min_gain, deadline) {
                    Ok(t) if t.changes.is_empty() => {
                        println!(
                            "  {:<12} vs {:<12} {:>6}: not run (budget reached)",
                            b.label(),
                            incumbent.label(),
                            metric.name()
                        );
                        trials.push(t);
                    }
                    Ok(t) => {
                        println!(
                            "  {:<12} vs {:<12} {:>6}: {:+6.2}% (rounds {}) noise {:.2}% threshold {:.2}% -> {:?}{}",
                            b.label(),
                            incumbent.label(),
                            metric.name(),
                            100.0 * median(&t.changes),
                            t.changes.iter().map(|c| format!("{:+.2}", 100.0 * c)).collect::<Vec<_>>().join(" "),
                            100.0 * t.noise,
                            100.0 * t.threshold,
                            t.verdict,
                            if t.budget_hit { " (budget reached)" } else { "" }
                        );
                        trials.push(t);
                    }
                    Err(why) => {
                        eprintln!("  {}: {why}", b.label());
                        failed = true;
                    }
                }
            }
        }
        json_samples.push(sample_json(e, &sample, &prints, &excluded, &trials));
    }
    let after = crate::conditions();
    println!("after:  {after}");
    if let Some(path) = option(args, "--json") {
        let doc = format!(
            "{{\"tool\":\"trier-video-bench calibrate\",\"registry\":{},\"machine\":{},\"conditionsBefore\":{},\"conditionsAfter\":{},\"settings\":{{\"configs\":{},\"rounds\":{rounds},\"pictures\":{pictures},\"minGain\":{min_gain},\"budgetSeconds\":{budget},\"affinity\":{}}},\"samples\":[{}]}}\n",
            registry_json(),
            machine_json(&machine),
            s(&before),
            s(&after),
            arr(configs.iter().map(|c| s(&c.label()))),
            affinity.map_or("null".into(), |m| s(&format!("{m:#x}"))),
            json_samples.join(",")
        );
        if let Err(e) = std::fs::write(path, doc) {
            eprintln!("{path}: {e}");
            return 1;
        }
        println!("json: {path}");
    }
    i32::from(failed)
}

fn search(args: &[String]) -> i32 {
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
fn num_json(v: f64) -> String {
    num(v)
}

/// The OS as profiles key it: `--os`, else Android's release and SDK
/// (getprop), else the platform's name.
fn os_text(args: &[String]) -> String {
    if let Some(os) = option(args, "--os") {
        return os.to_string();
    }
    let prop = |name: &str| {
        std::process::Command::new("getprop")
            .arg(name)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|v| !v.is_empty())
    };
    match (
        prop("ro.build.version.release"),
        prop("ro.build.version.sdk"),
    ) {
        (Some(release), Some(sdk)) => format!("Android {release} (SDK {sdk})"),
        _ => std::env::consts::OS.to_string(),
    }
}

/// Opens the profile at `path` for this machine: the valid one, or a new
/// one when it is missing, invalid or stale (the reason is printed).
fn open_profile(path: &str, key: &profile::HardwareKey) -> profile::Profile {
    match profile::Profile::load(Path::new(path), key) {
        profile::Load::Valid(p) => p,
        other => {
            println!("profile {path}: {other:?}; starting a new one");
            profile::Profile::new(key.clone())
        }
    }
}

/// The class a sample's results are kept under.
fn class_of(sample: &tune::Sample) -> String {
    tune::shape(sample).map_or_else(
        || sample.class.clone(),
        |(w, h, progressive)| profile::workload_class(w, h, progressive),
    )
}

fn stage_a(args: &[String]) -> i32 {
    let (Some(dir), Some(path)) = (args.first(), option(args, "--profile")) else {
        eprintln!("usage: stage-a <samples-dir> --profile <path> [--policy p] [--budget s]");
        return 2;
    };
    let Some(policy) = tune::Policy::parse(option(args, "--policy").unwrap_or("balanced")) else {
        eprintln!("bad --policy");
        return 2;
    };
    let names = ["sd", "hd720", "hd1080i"];
    let data: Vec<Vec<u8>> = match names
        .iter()
        .map(|n| std::fs::read(Path::new(dir).join(format!("{n}.m2v"))))
        .collect::<Result<_, _>>()
    {
        Ok(d) => d,
        Err(e) => {
            eprintln!("samples: {e}");
            return 1;
        }
    };
    let inputs: Vec<crate::trier_video::calibration::Input> = names
        .iter()
        .zip(&data)
        .map(|(name, es)| crate::trier_video::calibration::Input { name, es })
        .collect();
    let bounds = crate::trier_video::calibration::Bounds {
        seconds: option(args, "--budget")
            .and_then(|v| v.parse().ok())
            .unwrap_or(120.0),
        ..Default::default()
    };
    let started = std::time::Instant::now();
    for line in crate::trier_video::calibration::stage_a(
        &inputs,
        Path::new(path),
        &os_text(args),
        policy,
        bounds,
        &format!("bench, {}", power_text()),
    ) {
        println!("{line}");
    }
    println!("stage A took {:.0} s", started.elapsed().as_secs_f64());
    0
}

fn show_profile(args: &[String]) -> i32 {
    let (Some("show"), Some(path)) = (args.first().map(String::as_str), args.get(1)) else {
        eprintln!("usage: profile show <path> [--os <text>]");
        return 2;
    };
    let key = profile::HardwareKey::of(&platform::Machine::detect(), &os_text(args));
    let load = profile::Profile::load(Path::new(path), &key);
    let p = match &load {
        profile::Load::Valid(p) => {
            println!(
                "profile {path}: valid for this device ({})",
                profile::DECODER_VERSION
            );
            p.clone()
        }
        other => {
            println!("profile {path}: {other:?}");
            match std::fs::read_to_string(path).map(|t| profile::Profile::parse(&t)) {
                Ok(Ok(p)) => p,
                _ => return 1,
            }
        }
    };
    println!(
        "device: {} {} [{}] {} cores, clusters {}, {}",
        p.hardware.processor,
        p.hardware.arch,
        p.hardware.features,
        p.hardware.cores,
        p.hardware.clusters,
        p.hardware.os
    );
    for e in &p.entries {
        println!(
            "  {:<8} {:<12} {:<12} {:+6.1}% (noise {:.1}%) {:<11} {} trials, {}, {}, {}{}",
            e.class,
            e.policy.name(),
            e.config.label(),
            100.0 * e.change,
            100.0 * e.noise,
            e.stability,
            e.trials,
            e.source,
            e.date,
            e.conditions,
            if e.usable() { "" } else { "  (not applied)" }
        );
    }
    println!(
        "history: {} results, newest first (the current ones included)",
        p.history.len()
    );
    0
}

/// A policy's rule on this machine: the operating ceiling is the production
/// worker count (MV13), the objective cycles where they are counted.
fn policy_rule(policy: tune::Policy) -> tune::Rule {
    tune::Rule::Policy {
        policy,
        ceiling: crate::trier_video::Resources::detect().threads,
        objective: policy.objective(tune::LiveJudge::cycles_counted()),
    }
}
fn rule_name(rule: tune::Rule) -> String {
    match rule {
        tune::Rule::Metric(m) => format!("metric {}", m.name()),
        tune::Rule::Policy {
            policy,
            ceiling,
            objective,
        } => format!(
            "policy {} (objective {}, p99 within {:.0}% of the frame, operating ceiling {})",
            policy.name(),
            objective.name(),
            100.0 * policy.p99_share(),
            if policy.capped() {
                format!("{ceiling} workers")
            } else {
                "none".into()
            }
        ),
    }
}
/// `--affinity <hex mask>`: pins the process on Windows; elsewhere taskset.
fn apply_affinity(args: &[String]) -> bool {
    let Some(mask) = option(args, "--affinity") else {
        return true;
    };
    let mask = usize::from_str_radix(mask.trim_start_matches("0x"), 16).unwrap_or(0);
    #[cfg(windows)]
    {
        // SAFETY: the current process's pseudo-handle and a plain mask.
        let ok = mask != 0
            && unsafe { tune::win::SetProcessAffinityMask(tune::win::GetCurrentProcess(), mask) }
                != 0;
        if !ok {
            eprintln!("--affinity not applied");
        }
        ok
    }
    #[cfg(not(windows))]
    {
        eprintln!("--affinity {mask:#x}: use taskset on this system");
        false
    }
}

/// Brings the machine to a thermal state before a session: `cool` waits
/// until the hottest CPU zone is at or below `cool_temp` (at most
/// `cool_wait` s; 30 s idle where no sensor is readable), `warm` decodes the
/// heaviest sample on every explored worker for `soak` s.
fn prepare(
    state: &str,
    cool_temp: f64,
    cool_wait: f64,
    soak: f64,
    heavy: &tune::Sample,
    workers: usize,
) -> String {
    let t0 = platform::cpu_temperature();
    let started = std::time::Instant::now();
    match state {
        "warm" => {
            let c = tune::Config {
                kit: kit::KitId::Default,
                workers,
                adaptive: false,
            };
            while started.elapsed().as_secs_f64() < soak {
                let _ = tune::run(heavy, c);
            }
        }
        _ => match t0 {
            Some(_) => {
                while started.elapsed().as_secs_f64() < cool_wait
                    && platform::cpu_temperature().is_some_and(|t| t > cool_temp)
                {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                }
            }
            None => std::thread::sleep(std::time::Duration::from_secs(30)),
        },
    }
    let t1 = platform::cpu_temperature();
    format!(
        "{state}: {:.0} s, CPU {} -> {}",
        started.elapsed().as_secs_f64(),
        t0.map_or("unknown".into(), |t| format!("{t:.1} C")),
        t1.map_or("unknown".into(), |t| format!("{t:.1} C"))
    )
}

/// Power state for the record (Android battery status; unknown elsewhere).
fn power_text() -> String {
    let read = |p: &str| {
        std::fs::read_to_string(p)
            .ok()
            .map(|v| v.trim().to_string())
    };
    match (
        read("/sys/class/power_supply/battery/status"),
        read("/sys/class/power_supply/battery/capacity"),
    ) {
        (Some(status), Some(level)) => format!("battery {level}% {status}"),
        _ => "power unknown".into(),
    }
}

/// One search of a validation: its session, thermal state, sample, policy,
/// outcome, duration and CPU temperature before and after.
struct SearchRun {
    session: usize,
    state: String,
    sample: String,
    policy: tune::Policy,
    outcome: yoyo::Outcome,
    seconds: f64,
    before: Option<f64>,
    after: Option<f64>,
}

fn validate(args: &[String]) -> i32 {
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
                    o.confirmation.map_or("none".into(), |c| format!("{:+.1}% {:?}", 100.0 * c.change, c.verdict)),
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

fn median(v: &[f64]) -> f64 {
    let mut v = v.to_vec();
    v.sort_by(f64::total_cmp);
    v.get(v.len() / 2).copied().unwrap_or(f64::NAN)
}

fn s(text: &str) -> String {
    let mut out = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
fn arr(items: impl Iterator<Item = String>) -> String {
    format!("[{}]", items.collect::<Vec<_>>().join(","))
}
fn num(v: f64) -> String {
    if v.is_finite() {
        format!("{v}")
    } else {
        "null".into()
    }
}
fn opt<T: std::fmt::Display>(v: Option<T>) -> String {
    v.map_or("null".into(), |v| v.to_string())
}

fn registry_json() -> String {
    arr(kit::KITS.iter().map(|k| {
        format!(
            "{{\"name\":{},\"parts\":{},\"requires\":{},\"contract\":{},\"available\":{}}}",
            s(k.name),
            arr(k.parts.iter().map(|p| s(p))),
            arr(k.requires.names().into_iter().map(s)),
            s(&format!("{:?}", k.contract)),
            kit::Features::detected().covers(k.requires)
        )
    }))
}

fn machine_json(m: &platform::Machine) -> String {
    format!(
        "{{\"arch\":{},\"features\":{},\"usableCores\":{},\"allowed\":{},\"clusters\":{},\"memoryAvailable\":{},\"processor\":{}}}",
        s(m.arch),
        arr(m.features.names().into_iter().map(s)),
        m.usable_cores,
        m.allowed
            .as_ref()
            .map_or("null".into(), |a| arr(a.iter().map(|c| c.to_string()))),
        arr(m.clusters.iter().map(|c| format!(
            "{{\"maxKhz\":{},\"capacity\":{},\"cpus\":{}}}",
            c.max_khz,
            opt(c.capacity),
            arr(c.cpus.iter().map(|c| c.to_string()))
        ))),
        opt(m.memory_available),
        m.processor.as_deref().map_or("null".into(), s)
    )
}

fn run_json(r: &tune::Run) -> String {
    format!(
        "{{\"pictures\":{},\"frames\":{},\"refused\":{},\"wallUs\":{},\"cpuUs\":{},\"cycles\":{},\"meanUs\":{},\"p95Us\":{},\"p99Us\":{},\"maxUs\":{},\"overBudget\":{},\"longestOver\":{},\"maxPressureUs\":{},\"peakRss\":{},\"peakIsProcess\":{}}}",
        r.pictures,
        r.frames,
        r.refused,
        num(r.wall_us),
        r.cpu_us.map_or("null".into(), num),
        opt(r.cycles),
        num(r.mean_us),
        num(r.p95_us),
        num(r.p99_us),
        num(r.max_us),
        r.over_budget,
        r.longest_over,
        num(r.max_pressure_us),
        opt(r.peak_rss),
        r.peak_is_process
    )
}

fn sample_json(
    e: &Entry,
    sample: &tune::Sample,
    prints: &[(tune::Config, u64)],
    excluded: &[(tune::Config, String)],
    trials: &[tune::Trial],
) -> String {
    format!(
        "{{\"name\":{},\"class\":{},\"kind\":{},\"bytes\":{},\"fnv64\":{},\"pictures\":{},\"passes\":{},\"periodUs\":{},\"outputs\":{},\"excluded\":{},\"trials\":{}}}",
        s(&e.name),
        s(&e.class),
        s(&e.kind),
        e.bytes,
        s(&e.fnv),
        sample.units.len(),
        sample.passes,
        num(sample.period_us),
        arr(prints.iter().map(|(c, h)| format!("{{\"config\":{},\"fingerprint\":\"{h:016x}\"}}", s(&c.label())))),
        arr(excluded.iter().map(|(c, why)| format!("{{\"config\":{},\"why\":{}}}", s(&c.label()), s(why)))),
        arr(trials.iter().map(|t| format!(
            "{{\"a\":{},\"b\":{},\"metric\":{},\"noise\":{},\"threshold\":{},\"changes\":{},\"verdict\":{},\"budgetHit\":{},\"rounds\":{}}}",
            s(&t.a.label()),
            s(&t.b.label()),
            s(t.metric.name()),
            num(t.noise),
            num(t.threshold),
            arr(t.changes.iter().map(|c| num(*c))),
            s(&format!("{:?}", t.verdict)),
            t.budget_hit,
            arr(t.rounds.iter().map(|round| arr(round.iter().map(|(side, r)| format!(
                "{{\"side\":{},\"run\":{}}}",
                s(&format!("{side:?}")),
                run_json(r)
            )))))
        )))
    )
}

/// Cycles and CPU time of separate builds run on the same core, interleaved
/// with the starting build rotating each round.
fn cross(args: &[String]) -> i32 {
    let Some(split) = args.iter().position(|a| a == "--") else {
        eprintln!("usage: cross <rounds> <exe>... -- <args>");
        return 2;
    };
    let Some(rounds) = args.first().and_then(|r| r.parse::<usize>().ok()) else {
        eprintln!("usage: cross <rounds> <exe>... -- <args>");
        return 2;
    };
    let exes = &args[1..split];
    let rest = &args[split + 1..];
    if exes.is_empty() {
        eprintln!("no builds given");
        return 2;
    }
    #[cfg(windows)]
    {
        let mask: usize = std::env::var("TRIER_CROSS_MASK")
            .ok()
            .and_then(|m| m.parse().ok())
            .unwrap_or(4);
        // Children inherit this process's affinity.
        // SAFETY: the current process's pseudo-handle and a plain mask.
        unsafe { tune::win::SetProcessAffinityMask(tune::win::GetCurrentProcess(), mask) };
        println!("affinity mask {mask:#x}");
    }
    let mut results: Vec<Vec<(f64, f64)>> = vec![Vec::new(); exes.len()];
    for r in 0..rounds {
        for k in 0..exes.len() {
            let i = (r + k) % exes.len();
            match measure_child(&exes[i], rest) {
                Ok((cycles, cpu)) => {
                    println!(
                        "round {} {:<40} cycles {:>14.0} cpu {:.3} s",
                        r + 1,
                        exes[i],
                        cycles,
                        cpu
                    );
                    results[i].push((cycles, cpu));
                }
                Err(e) => {
                    eprintln!("{}: {e}", exes[i]);
                    return 1;
                }
            }
        }
    }
    for (exe, v) in exes.iter().zip(&results) {
        let cycles: Vec<f64> = v.iter().map(|x| x.0).collect();
        let (lo, hi) = cycles
            .iter()
            .fold((f64::MAX, f64::MIN), |(a, b), &c| (a.min(c), b.max(c)));
        println!(
            "{exe}: cycles median {:.4} G (range {:.4}-{:.4}), cpu median {:.3} s",
            median(&cycles) / 1e9,
            lo / 1e9,
            hi / 1e9,
            median(&v.iter().map(|x| x.1).collect::<Vec<_>>())
        );
    }
    0
}

/// Runs `exe` with `args`, output discarded, and returns its CPU cycles and
/// CPU seconds (all its threads).
fn measure_child(exe: &str, args: &[String]) -> Result<(f64, f64), String> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        let mut child = std::process::Command::new(exe)
            .args(args)
            .stdout(std::process::Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("exit {status}"));
        }
        let h = child.as_raw_handle() as isize;
        let mut cycles = 0u64;
        let mut t = [tune::win::FileTime::default(); 4];
        let [a, b, c, d] = &mut t;
        // SAFETY: the exited child's handle stays open until `child` drops.
        let ok = unsafe {
            tune::win::QueryProcessCycleTime(h, &mut cycles) != 0
                && tune::win::GetProcessTimes(h, a, b, c, d) != 0
        };
        if !ok {
            return Err("process counters unavailable".into());
        }
        Ok((cycles as f64, (t[2].value() + t[3].value()) as f64 / 1e7))
    }
    #[cfg(not(windows))]
    {
        let _ = (exe, args);
        Err("cross is for Windows; on Android use simpleperf stat".into())
    }
}
