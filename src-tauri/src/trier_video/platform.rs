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

//! What the machine offers the decoder (the adaptive engine's resource
//! discovery, docs/trier-adaptive-engine.md §1): architecture, instruction
//! sets, cores grouped into clusters by their maximum frequency (performance
//! and efficiency cores are not assumed equal), the cores this process may
//! use, and available memory. Read from the kernel's files with std only;
//! what a platform does not expose is reported as unknown, never guessed.

use super::kit::Features;

/// One group of cores with the same maximum frequency.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cluster {
    /// Maximum frequency in kHz (`cpuinfo_max_freq`).
    pub max_khz: u64,
    /// The kernel's relative capacity (`cpu_capacity`, 1024 = the strongest),
    /// where it is exposed.
    pub capacity: Option<u64>,
    pub cpus: Vec<usize>,
}

#[derive(Clone, Debug)]
pub struct Machine {
    pub arch: &'static str,
    pub features: Features,
    /// Logical cores the process may run on (`available_parallelism`, which
    /// follows affinity and quotas).
    pub usable_cores: usize,
    /// Cores the process may run on, by number (Linux `Cpus_allowed_list`).
    pub allowed: Option<Vec<usize>>,
    /// Slowest first; empty where frequencies are not readable (Windows).
    pub clusters: Vec<Cluster>,
    /// Bytes of memory available now (Linux `MemAvailable`).
    pub memory_available: Option<u64>,
    /// The SoC or processor name where the kernel gives one.
    pub processor: Option<String>,
}

impl Machine {
    pub fn detect() -> Self {
        Self {
            arch: std::env::consts::ARCH,
            features: Features::detected(),
            usable_cores: std::thread::available_parallelism().map_or(1, |n| n.get()),
            allowed: allowed_cpus(),
            clusters: clusters(),
            memory_available: super::available_memory().or_else(windows_memory),
            processor: processor(),
        }
    }
    /// One line for logs and reports.
    pub fn summary(&self) -> String {
        let clusters: Vec<String> = self
            .clusters
            .iter()
            .map(|c| {
                format!(
                    "{}x{:.2}GHz{}",
                    c.cpus.len(),
                    c.max_khz as f64 / 1e6,
                    c.capacity.map_or(String::new(), |v| format!("/cap{v}"))
                )
            })
            .collect();
        format!(
            "arch {} features [{}] usable cores {} clusters [{}] allowed {} memory {} processor {}",
            self.arch,
            self.features.names().join(","),
            self.usable_cores,
            if clusters.is_empty() {
                "unknown".into()
            } else {
                clusters.join(" ")
            },
            self.allowed
                .as_ref()
                .map_or("unknown".into(), |a| format!("{a:?}")),
            self.memory_available
                .map_or("unknown".into(), |m| format!("{} MB", m >> 20)),
            self.processor.as_deref().unwrap_or("unknown"),
        )
    }
}

/// The hottest CPU thermal zone in degrees Celsius (Linux and Android zones
/// whose type names a CPU), or None where none is readable.
pub fn cpu_temperature() -> Option<f64> {
    let mut hottest: Option<f64> = None;
    for zone in 0..200 {
        let base = format!("/sys/class/thermal/thermal_zone{zone}");
        let Ok(kind) = std::fs::read_to_string(format!("{base}/type")) else {
            if zone > 0 && !std::path::Path::new(&base).exists() {
                break;
            }
            continue;
        };
        if !kind.contains("cpu") {
            continue;
        }
        let Some(raw) = std::fs::read_to_string(format!("{base}/temp"))
            .ok()
            .and_then(|t| t.trim().parse::<f64>().ok())
        else {
            continue;
        };
        // Millidegrees on most kernels.
        let c = if raw > 1000.0 { raw / 1000.0 } else { raw };
        if (-40.0..150.0).contains(&c) {
            hottest = Some(hottest.map_or(c, |h: f64| h.max(c)));
        }
    }
    hottest
}

/// Cores grouped by maximum frequency, slowest first.
fn clusters() -> Vec<Cluster> {
    let read =
        |path: String| -> Option<u64> { std::fs::read_to_string(path).ok()?.trim().parse().ok() };
    let mut out: Vec<Cluster> = Vec::new();
    for cpu in 0..256 {
        let base = format!("/sys/devices/system/cpu/cpu{cpu}");
        if !std::path::Path::new(&base).exists() {
            break;
        }
        let Some(max_khz) = read(format!("{base}/cpufreq/cpuinfo_max_freq")) else {
            continue;
        };
        let capacity = read(format!("{base}/cpu_capacity"));
        match out.iter_mut().find(|c| c.max_khz == max_khz) {
            Some(c) => c.cpus.push(cpu),
            None => out.push(Cluster {
                max_khz,
                capacity,
                cpus: vec![cpu],
            }),
        }
    }
    out.sort_by_key(|c| c.max_khz);
    out
}

/// Linux `Cpus_allowed_list` ("0-5,7") as core numbers.
fn allowed_cpus() -> Option<Vec<usize>> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let list = status
        .lines()
        .find_map(|l| l.strip_prefix("Cpus_allowed_list:"))?
        .trim();
    parse_cpu_list(list)
}
fn parse_cpu_list(list: &str) -> Option<Vec<usize>> {
    let mut out = Vec::new();
    for part in list.split(',').filter(|p| !p.is_empty()) {
        match part.split_once('-') {
            Some((a, b)) => out.extend(a.trim().parse::<usize>().ok()?..=b.trim().parse().ok()?),
            None => out.push(part.trim().parse().ok()?),
        }
    }
    Some(out)
}

/// Windows: available physical memory (`GlobalMemoryStatusEx`).
#[cfg(windows)]
fn windows_memory() -> Option<u64> {
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        load: u32,
        total_phys: u64,
        avail_phys: u64,
        rest: [u64; 5],
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatusEx) -> i32;
    }
    let mut m = MemoryStatusEx {
        length: std::mem::size_of::<MemoryStatusEx>() as u32,
        load: 0,
        total_phys: 0,
        avail_phys: 0,
        rest: [0; 5],
    };
    // SAFETY: a correctly sized MEMORYSTATUSEX with its length set.
    (unsafe { GlobalMemoryStatusEx(&mut m) } != 0).then_some(m.avail_phys)
}
#[cfg(not(windows))]
fn windows_memory() -> Option<u64> {
    None
}

/// The SoC (Android: `/sys/devices/soc0/machine`), the processor model
/// (`/proc/cpuinfo`) or Windows's processor identifier, where readable.
fn processor() -> Option<String> {
    if cfg!(windows) {
        return std::env::var("PROCESSOR_IDENTIFIER").ok();
    }
    if let Ok(m) = std::fs::read_to_string("/sys/devices/soc0/machine") {
        let m = m.trim();
        if !m.is_empty() {
            return Some(m.to_string());
        }
    }
    let info = std::fs::read_to_string("/proc/cpuinfo").ok()?;
    info.lines()
        .find(|l| l.starts_with("Hardware") || l.starts_with("model name"))
        .and_then(|l| l.split_once(':'))
        .map(|(_, v)| v.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cpu_lists_parse() {
        assert_eq!(parse_cpu_list("0-5,7"), Some(vec![0, 1, 2, 3, 4, 5, 7]));
        assert_eq!(parse_cpu_list("3"), Some(vec![3]));
        assert_eq!(parse_cpu_list("x"), None);
    }
    /// Detection never fails: unknowns stay unknown, and the CPU always has
    /// what the portable kit and this build's baseline need.
    #[test]
    fn detection_reports_this_machine() {
        let m = Machine::detect();
        assert!(m.usable_cores >= 1);
        #[cfg(target_arch = "x86_64")]
        assert!(m.features.covers(Features::SSE2));
        #[cfg(target_arch = "aarch64")]
        assert!(m.features.covers(Features::NEON));
        assert!(!m.summary().is_empty());
    }
}
