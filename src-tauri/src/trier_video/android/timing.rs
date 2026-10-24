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

//! Decode timing on Android: CPU time and cycles, clock speed, and the
//! per-picture percentiles the app reports.

use super::*;

/// A system property's value (empty values as None).
pub(super) fn property(name: &str) -> Option<String> {
    let name = std::ffi::CString::new(name).ok()?;
    let mut value = [0 as std::ffi::c_char; 92];
    let length = unsafe { __system_property_get(name.as_ptr(), value.as_mut_ptr()) };
    if length <= 0 {
        return None;
    }
    // SAFETY: the system writes a NUL-terminated value of at most 91 bytes.
    let value = unsafe { std::ffi::CStr::from_ptr(value.as_ptr()) };
    value.to_str().ok().map(str::to_string)
}

extern "C" {
    fn syscall(number: std::ffi::c_long, ...) -> std::ffi::c_long;
    fn read(fd: i32, buffer: *mut c_void, count: usize) -> isize;
    fn close(fd: i32) -> i32;
}

/// A counter of the calling thread's own CPU cycles in user mode (trace only),
/// so each picture's work is known exactly and its average clock is cycles /
/// CPU time. None where the system does not allow it.
pub(super) struct Cycles(pub(super) i32);

impl Cycles {
    pub(super) fn open() -> Option<Self> {
        // struct perf_event_attr: type, size, config, ..., flags at byte 40.
        let mut attr = [0u64; 16];
        attr[0] = 128u64 << 32; // type PERF_TYPE_HARDWARE (0), size 128
                                // attr[1], config: PERF_COUNT_HW_CPU_CYCLES (0).
        attr[5] = (1 << 5) | (1 << 6); // exclude_kernel, exclude_hv
                                       // perf_event_open(attr, this thread, any CPU, no group, no flags).
        let number: std::ffi::c_long = if cfg!(target_arch = "aarch64") {
            241
        } else {
            364
        };
        let fd = unsafe { syscall(number, attr.as_ptr(), 0i32, -1i32, -1i32, 0u64) } as i32;
        (fd >= 0).then_some(Cycles(fd))
    }
    pub(super) fn now(&self) -> u64 {
        let mut value = 0u64;
        let got = unsafe { read(self.0, &mut value as *mut u64 as *mut c_void, 8) };
        if got == 8 {
            value
        } else {
            0
        }
    }
}

impl Drop for Cycles {
    fn drop(&mut self) {
        unsafe { close(self.0) };
    }
}

pub(super) fn log_trace(line: &str) {
    if let Ok(text) = std::ffi::CString::new(line) {
        // ANDROID_LOG_INFO.
        unsafe { __android_log_write(4, c"TrierMpegVideoTrace".as_ptr(), text.as_ptr()) };
    }
}

/// CPU time this thread has used, in microseconds (CLOCK_THREAD_CPUTIME_ID).
// The casts are needed on 32-bit ARM, where `c_long` is 32 bits.
#[allow(clippy::unnecessary_cast)]
pub(super) fn thread_cpu_micros() -> i64 {
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    if unsafe { clock_gettime(3, &mut t) } != 0 {
        return 0;
    }
    t.seconds as i64 * 1_000_000 + t.nanoseconds as i64 / 1000
}

/// The current clock of `cpu` in kHz, when the system lets the app read it.
pub(super) fn cpu_khz(cpu: i32) -> Option<i64> {
    std::fs::read_to_string(format!(
        "/sys/devices/system/cpu/cpu{cpu}/cpufreq/scaling_cur_freq"
    ))
    .ok()?
    .trim()
    .parse()
    .ok()
}

/// Decode times kept for the percentiles (about a minute at 60 pictures/s).
pub(super) const TIMES: usize = 4096;

/// The clock of the decoding core is sampled once per this many calls.
pub(super) const FREQUENCY_SAMPLE: i64 = 30;

/// Inputs remembered for the input-to-draw latency (frames out of order wait).
pub(super) const ARRIVALS: usize = 64;

/// Calls before the lowest queue occupancy counts (the queue fills at a join).
pub(super) const WARM_UP: i64 = 300;

/// HAL_PIXEL_FORMAT_YV12: Y, then Cr, then Cb; chroma stride aligned to 16.
pub(super) const YV12: i32 = 0x3231_5659;

pub(super) struct Native {
    pub(super) decoding: Mutex<Decoding>,
    /// Frames handed to the player, by id, until it releases them.
    pub(super) frames: Mutex<HashMap<i64, Frame>>,
    pub(super) window: Mutex<Window>,
    pub(super) timing: Mutex<Timing>,
}

/// The decoder thread's part.
pub(super) struct Decoding {
    pub(super) decoder: Decoder,
    /// Decoded frames in display order, not yet handed out.
    pub(super) queue: VecDeque<Frame>,
    pub(super) next_id: i64,
    /// pictures in, frames out, decode microseconds in total.
    pub(super) counters: [i64; 3],
    /// The latest per-call decode times (microseconds), for p95/p99/maximum.
    pub(super) times: VecDeque<u32>,
    /// The playback guard has already noted that the known-good settings
    /// miss the policy's share (logged once per session).
    pub(super) guard_noted: bool,
}

/// The playback thread's part: the surface being drawn on.
pub(super) struct Window {
    pub(super) window: *mut c_void,
    pub(super) surface: Option<jni::objects::GlobalRef>,
    pub(super) geometry: (i32, i32),
    pub(super) drawn: i64,
    pub(super) last_result: i64,
}

// SAFETY: an ANativeWindow is a reference-counted object that may be used from
// any thread; this one is only touched while its Mutex is held.
unsafe impl Send for Window {}

impl Drop for Window {
    fn drop(&mut self) {
        if !self.window.is_null() {
            unsafe { ANativeWindow_release(self.window) };
        }
    }
}

/// A lock, still usable after a panic elsewhere left it poisoned (the data is
/// plain bookkeeping that stays consistent between statements).
pub(super) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Where the time goes in the app (performance milestone, docs/trier-mpeg-video.md):
/// how long the decoding thread ran against how long it took, on which core
/// and at what clock, how many frames are waiting, and how long from a
/// picture's data arriving to its frame being drawn.
#[derive(Default)]
pub(super) struct Timing {
    /// The frame period: the smallest positive time-stamp step seen.
    pub(super) period: i64,
    pub(super) last_pts: Option<i64>,
    pub(super) over_run: i64,
    pub(super) longest_over_run: i64,
    pub(super) cpu_micros: i64,
    pub(super) frequency_samples: i64,
    pub(super) khz_total: i64,
    pub(super) calls_by_cpu: [i64; 8],
    pub(super) held_max: i64,
    /// INV-PERF-TAIL, bounded playback pressure. `pressure` is the decode time
    /// beyond the frame period still owed, carried from picture to picture
    /// (zero when the decoder keeps up); a burst lasts until it is back to
    /// zero, and its recovery time is how long that took.
    pub(super) pressure: i64,
    pub(super) max_pressure: i64,
    pub(super) burst_start: Option<(i64, std::time::Instant)>,
    pub(super) bursts: i64,
    pub(super) longest_recovery_pictures: i64,
    pub(super) longest_recovery_micros: i64,
    /// Fewest frames held (waiting plus with the player) after warm-up: the
    /// margin left before the screen would wait for a picture.
    pub(super) held_min: Option<i64>,
    pub(super) calls: i64,
    /// Opened on the decoding thread at its first traced call.
    pub(super) cycles: Option<Cycles>,
    pub(super) cycles_tried: bool,
    pub(super) last_cpu: i32,
    pub(super) migrations: i64,
    pub(super) trace: bool,
    /// When each recent picture's data arrived, by time stamp.
    pub(super) arrivals: VecDeque<(i64, std::time::Instant)>,
    /// Input-to-draw latencies (microseconds), the latest TIMES.
    pub(super) latencies: VecDeque<u32>,
}

impl Timing {
    pub(super) fn decoded(&mut self, pts: i64, wall: i64, cpu: i64, arrived: std::time::Instant) {
        if let Some(last) = self.last_pts.replace(pts) {
            let step = pts - last;
            if step > 0 && (self.period == 0 || step < self.period) {
                self.period = step;
            }
        }
        if self.period > 0 && wall > self.period {
            self.over_run += 1;
            self.longest_over_run = self.longest_over_run.max(self.over_run);
        } else {
            self.over_run = 0;
        }
        self.calls += 1;
        if self.period > 0 {
            self.pressure = (self.pressure + wall - self.period).max(0);
            self.max_pressure = self.max_pressure.max(self.pressure);
            match (self.pressure > 0, self.burst_start) {
                (true, None) => {
                    self.burst_start = Some((self.calls, arrived));
                    self.bursts += 1;
                }
                (false, Some((calls, at))) => {
                    self.burst_start = None;
                    self.longest_recovery_pictures =
                        self.longest_recovery_pictures.max(self.calls - calls);
                    self.longest_recovery_micros = self
                        .longest_recovery_micros
                        .max(at.elapsed().as_micros() as i64);
                }
                _ => {}
            }
        }
        self.cpu_micros += cpu;
        if self.arrivals.len() == ARRIVALS {
            self.arrivals.pop_front();
        }
        self.arrivals.push_back((pts, arrived));
    }
    /// The core this call runs on, counted; true when it moved since the last call.
    pub(super) fn sample_core(&mut self, calls: i64) -> (i32, bool) {
        let cpu = unsafe { sched_getcpu() };
        if (0..8).contains(&cpu) {
            self.calls_by_cpu[cpu as usize] += 1;
        }
        let moved = calls > 1 && cpu != self.last_cpu;
        self.migrations += moved as i64;
        self.last_cpu = cpu;
        if calls % FREQUENCY_SAMPLE == 0 {
            if let Some(khz) = cpu_khz(cpu) {
                self.frequency_samples += 1;
                self.khz_total += khz;
            }
        }
        (cpu, moved)
    }
    pub(super) fn held(&mut self, held: i64) {
        self.held_max = self.held_max.max(held);
        if self.calls > WARM_UP {
            self.held_min = Some(self.held_min.map_or(held, |m| m.min(held)));
        }
    }
    pub(super) fn drawn(&mut self, pts: i64) {
        if let Some(i) = self.arrivals.iter().position(|&(p, _)| p == pts) {
            let (_, arrived) = self.arrivals.remove(i).expect("found");
            if self.latencies.len() == TIMES {
                self.latencies.pop_front();
            }
            self.latencies
                .push_back(arrived.elapsed().as_micros().min(u32::MAX as u128) as u32);
        }
    }
    pub(super) fn flushed(&mut self) {
        self.last_pts = None;
        self.over_run = 0;
        self.pressure = 0;
        self.burst_start = None;
        self.calls = 0;
        self.arrivals.clear();
    }
}

/// (mean, p95, p99, maximum).
pub(super) fn percentiles(values: &VecDeque<u32>) -> (i64, i64, i64, i64) {
    let mut sorted: Vec<u32> = values.iter().copied().collect();
    sorted.sort_unstable();
    let at = |q: f64| {
        sorted
            .get(((sorted.len() as f64 - 1.0) * q).round() as usize)
            .copied()
            .unwrap_or(0) as i64
    };
    let mean = if sorted.is_empty() {
        0
    } else {
        sorted.iter().map(|&v| v as i64).sum::<i64>() / sorted.len() as i64
    };
    (
        mean,
        at(0.95),
        at(0.99),
        sorted.last().copied().unwrap_or(0) as i64,
    )
}
