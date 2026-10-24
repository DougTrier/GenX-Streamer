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

// This module's parts, by area, are in calibrate/.
mod search;
use search::*;
mod validate;
use validate::*;
mod json;
use json::*;
mod cross;
use cross::*;
