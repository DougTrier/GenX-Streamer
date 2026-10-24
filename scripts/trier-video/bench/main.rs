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

//! Trier MPEG Video benchmark. Decodes an MPEG-2 elementary stream with the
//! decoder's own sources (compiled in place, unchanged) and reports per-picture
//! decode time: mean, p50, p95, p99, maximum, by picture type, the longest run
//! of consecutive pictures over the frame period, and (on Android) CPU
//! frequency and temperature before and after. Identical input and conditions
//! make before/after comparisons fair (docs/trier-mpeg-video.md). The output
//! checksum (FNV-1a over every frame's planes, in output order) must not change
//! when an optimisation is meant to leave the pictures bit-identical.
//!
//! trier-video-bench <file.m2v> [repeats] [budget-microseconds] [nohash] [trace]
//! trier-video-bench decode|compare|damage ... (lab.rs: the comparison scorecard)
//! trier-video-bench kits (the detected machine and the registered kits)
//! trier-video-bench calibrate|cross ... (calibrate.rs: AutoTune's harness)
//! (nohash skips the checksum, so CPU counters see decoding only)
//! TRIER_VIDEO_KIT=<name> decodes with that registered kit (default: default).
mod calibrate;
mod lab;
#[cfg(libmpeg2)]
mod libmpeg2;
#[path = "../../../src-tauri/src/trier_video/mod.rs"]
#[allow(dead_code)]
mod trier_video;

use std::time::Instant;

fn start_codes(data: &[u8]) -> Vec<(u8, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i + 2] > 1 {
            i += 3;
        } else if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            out.push((data[i + 3], i + 4));
            i += 4;
        } else {
            i += 1;
        }
    }
    out
}
/// Each picture with the headers in front of it, as a demultiplexer delivers
/// them; and its picture_coding_type (1 I, 2 P, 3 B).
fn access_units(es: &[u8]) -> Vec<(&[u8], u8)> {
    let codes = start_codes(es);
    let mut cuts = vec![0usize];
    let mut types = Vec::new();
    for (i, &(code, after)) in codes.iter().enumerate() {
        if code != 0x00 {
            continue;
        }
        types.push((es.get(after + 1).copied().unwrap_or(0) >> 3) & 7);
        if types.len() == 1 {
            continue;
        }
        let mut cut = after - 4;
        let mut j = i;
        while j > 0 {
            let (c, a) = codes[j - 1];
            let ext = es.get(a).map(|b| b >> 4);
            let belongs =
                matches!(c, 0xB3 | 0xB8) || (c == 0xB5 && matches!(ext, Some(1) | Some(2)));
            if !belongs || a - 4 <= *cuts.last().unwrap() {
                break;
            }
            cut = a - 4;
            j -= 1;
        }
        cuts.push(cut);
    }
    cuts.push(es.len());
    cuts.windows(2)
        .map(|w| &es[w[0]..w[1]])
        .zip(types)
        .collect()
}

fn read(path: &str) -> String {
    std::fs::read_to_string(path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}
fn conditions() -> String {
    if !cfg!(target_os = "android") {
        return String::new();
    }
    let freqs: Vec<String> = (0..8)
        .map(|c| {
            read(&format!(
                "/sys/devices/system/cpu/cpu{c}/cpufreq/scaling_cur_freq"
            ))
        })
        .map(|f| {
            f.parse::<u64>()
                .map(|k| format!("{:.2}", k as f64 / 1e6))
                .unwrap_or(f)
        })
        .collect();
    let mut temps = Vec::new();
    for zone in 0..80 {
        let kind = read(&format!("/sys/class/thermal/thermal_zone{zone}/type"));
        if kind.contains("cpu") && temps.len() < 4 {
            let t = read(&format!("/sys/class/thermal/thermal_zone{zone}/temp"));
            if let Ok(v) = t.parse::<i64>() {
                temps.push(format!("{kind}={:.1}C", v as f64 / 1000.0));
            }
        }
    }
    format!("cpu GHz [{}] temps [{}]", freqs.join(" "), temps.join(" "))
}

/// TRIER_VIDEO_KIT: the registered kit to decode with (`kits` lists them).
fn kit() -> trier_video::kit::KitId {
    match std::env::var("TRIER_VIDEO_KIT") {
        Ok(name) => trier_video::kit::KitId::from_name(&name)
            .unwrap_or_else(|| panic!("unknown kit {name}; see `trier-video-bench kits`")),
        Err(_) => trier_video::kit::KitId::Default,
    }
}

/// TRIER_VIDEO_THREADS: workers per picture's slices (1 to 8, or `auto` for
/// the decoder's resource policy); default 1.
fn threads() -> usize {
    match std::env::var("TRIER_VIDEO_THREADS").as_deref() {
        Ok("auto") => trier_video::Resources::detect().threads,
        Ok(v) => v.parse().unwrap_or(1),
        Err(_) => 1,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = lab::run(&args) {
        std::process::exit(code);
    }
    if let Some(code) = calibrate::run(&args) {
        std::process::exit(code);
    }
    if args.get(1).map(String::as_str) == Some("kits") {
        println!(
            "machine: {}",
            trier_video::platform::Machine::detect().summary()
        );
        let have = trier_video::kit::Features::detected();
        for k in trier_video::kit::KITS {
            println!(
                "kit {:<9} {} parts [{}] needs [{}] {:?}: {}",
                k.name,
                if have.covers(k.requires) {
                    "available  "
                } else {
                    "unavailable"
                },
                k.parts.join(", "),
                k.requires.names().join(","),
                k.contract,
                k.why
            );
        }
        return;
    }
    #[cfg(libmpeg2)]
    if let Some(code) = libmpeg2::command(&args) {
        std::process::exit(code);
    }
    let path = args
        .get(1)
        .expect("usage: trier-video-bench <file.m2v> [repeats] [budget-us]");
    let repeats: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(3);
    let budget: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(16_683);
    let es = std::fs::read(path).expect("read input");
    let units = access_units(&es);
    println!(
        "input {path}: {} pictures, {} bytes, budget {budget} us, repeats {repeats}",
        units.len(),
        es.len()
    );
    println!("kit: {}", kit().name());
    println!("before: {}", conditions());
    let mut all: Vec<(u64, u8)> = Vec::new();
    let mut frames = 0usize;
    let mut sum: u64 = 0xcbf2_9ce4_8422_2325;
    let checksum = args.get(4).map(String::as_str) != Some("nohash");
    // `trace` (5th argument): one line per picture on stderr, as the app's trace.
    let trace = args.get(5).map(String::as_str) == Some("trace");
    let mut hash = |out: &[trier_video::Frame]| {
        for f in out.iter().filter(|_| checksum) {
            for plane in [&f.planes.y, &f.planes.cb, &f.planes.cr] {
                for &b in plane.iter() {
                    sum = (sum ^ b as u64).wrapping_mul(0x100_0000_01b3);
                }
            }
        }
    };
    let started = Instant::now();
    for _ in 0..repeats {
        let mut d = trier_video::Decoder::new();
        d.set_resources(trier_video::Resources {
            threads: threads(),
            spare_frames: 2,
            // TRIER_VIDEO_ADAPTIVE=1: workers by picture weight.
            adaptive: std::env::var("TRIER_VIDEO_ADAPTIVE").as_deref() == Ok("1"),
        });
        d.set_kit(kit()).expect("kit available on this CPU");
        for (i, &(unit, kind)) in units.iter().enumerate() {
            let before = d.stats;
            let t = Instant::now();
            let out = d.decode(unit, i as i64).expect("decodes");
            let us = t.elapsed().as_micros() as u64;
            all.push((us, kind));
            if trace {
                let a = d.stats;
                eprintln!(
                    "B,{i},{},{},{},{},{},{},{us}",
                    a.last_type,
                    a.last_structure,
                    a.coefficients - before.coefficients,
                    a.coded_macroblocks - before.coded_macroblocks,
                    a.intra_macroblocks - before.intra_macroblocks,
                    a.skipped_macroblocks - before.skipped_macroblocks
                );
            }
            frames += out.len();
            hash(&out);
        }
        let out = d.flush();
        frames += out.len();
        hash(&out);
    }
    let wall = started.elapsed().as_secs_f64();
    println!("after:  {}", conditions());
    let report = |label: &str, mut times: Vec<u64>| {
        if times.is_empty() {
            return;
        }
        times.sort_unstable();
        let at = |q: f64| times[((times.len() as f64 - 1.0) * q).round() as usize];
        let mean = times.iter().sum::<u64>() as f64 / times.len() as f64;
        let over = times.iter().filter(|&&t| t > budget).count();
        println!(
            "{label:>4}: n={:5} mean {:7.0} us  p50 {:6} p95 {:6} p99 {:6} max {:6} us  over budget {:4} ({:.2}%)",
            times.len(),
            mean,
            at(0.5),
            at(0.95),
            at(0.99),
            times[times.len() - 1],
            over,
            100.0 * over as f64 / times.len() as f64
        );
    };
    report("all", all.iter().map(|&(t, _)| t).collect());
    for (kind, name) in [(1, "I"), (2, "P"), (3, "B")] {
        report(
            name,
            all.iter()
                .filter(|&&(_, k)| k == kind)
                .map(|&(t, _)| t)
                .collect(),
        );
    }
    // Longest run of consecutive pictures over the frame period (in decode order).
    let (mut run, mut longest) = (0, 0);
    for &(t, _) in &all {
        run = if t > budget { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    println!("longest run over budget: {longest} pictures; {frames} frames out; {:.0} pictures/s decoding, {:.1} s wall; output checksum {sum:016x}",
        all.len() as f64 * 1e6 / all.iter().map(|&(t, _)| t).sum::<u64>() as f64,
        wall
    );
}
