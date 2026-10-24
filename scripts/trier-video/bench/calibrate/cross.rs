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

//! `cross`: CPU cycles of separate builds compared on the same core.

use super::*;

/// Cycles and CPU time of separate builds run on the same core, interleaved
/// with the starting build rotating each round.
pub(super) fn cross(args: &[String]) -> i32 {
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
pub(super) fn measure_child(exe: &str, args: &[String]) -> Result<(f64, f64), String> {
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
