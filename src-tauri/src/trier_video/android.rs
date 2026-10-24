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

//! The Android player's bridge (com.tmg.tv.TrierMpegVideoNative): whole
//! pictures in, decoded frames out by id, drawn straight onto the player's
//! surface. Frames stay alive until the player releases their id.
//!
//! Threads (MV08): Media3 calls `decode`, `next`, `flush` and `counters` on its
//! decoder thread, and `render` and `release` on its playback thread, at the
//! same time. Each part of the state therefore has its own lock: the decoder
//! (decoder thread only, so drawing never waits for a picture to decode), the
//! frames held by the player, the window, and the timing both threads add to.
use super::{calibration, platform, profile, tune};
use super::{Decoder, Frame, Resources};
use jni::objects::{JByteArray, JByteBuffer, JLongArray, JObject, JString};
use jni::sys::{jboolean, jint, jlong, jstring};
use jni::JNIEnv;
use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};

/// Trier AutoTune in the app (milestone 6): where the device profile lives,
/// the OS it is keyed by, and the policy (None: off). Set by `configure`.
struct AutoTuneConfig {
    profile: std::path::PathBuf,
    os: String,
    policy: Option<tune::Policy>,
}
static AUTOTUNE: Mutex<Option<AutoTuneConfig>> = Mutex::new(None);
/// Decoders alive: calibration never starts while one is, and a decoder
/// starting cancels a running calibration (INV-AUTOTUNE-006).
static LIVE: AtomicUsize = AtomicUsize::new(0);
/// The workload classes of the app's calibration samples.
const CALIBRATED_CLASSES: [&str; 3] = ["sdi", "hd720p", "hd1080i"];

fn log_autotune(line: &str) {
    if let Ok(text) = std::ffi::CString::new(line) {
        // ANDROID_LOG_INFO.
        unsafe { __android_log_write(4, c"TrierAutoTune".as_ptr(), text.as_ptr()) };
    }
}
fn java_string(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(|v| v.into()).unwrap_or_default()
}
/// The policy: `debug.genx.trier.policy` (performance, balanced, efficiency,
/// off) when set, else the app's.
fn policy_of(app: &str) -> Option<tune::Policy> {
    let chosen = property("debug.genx.trier.policy").unwrap_or_else(|| app.to_string());
    tune::Policy::parse(&chosen)
}

/// Where the profile lives, the OS text and the app's policy name.
#[no_mangle]
pub extern "system" fn Java_com_tmg_tv_TrierMpegVideoNative_configure(
    mut env: JNIEnv,
    _this: JObject,
    dir: JString,
    os: JString,
    policy: JString,
) {
    let dir = java_string(&mut env, &dir);
    let os = java_string(&mut env, &os);
    let policy = policy_of(&java_string(&mut env, &policy));
    log_autotune(&format!(
        "configured: profile in {dir}, {os}, policy {}",
        policy.map_or("off", |p| p.name())
    ));
    *AUTOTUNE.lock().unwrap_or_else(|e| e.into_inner()) = Some(AutoTuneConfig {
        profile: std::path::Path::new(&dir).join("autotune.profile"),
        os,
        policy,
    });
}

/// Playback showed the profile's choice missing the policy's deadline share:
/// retire it now (not at the session's end, which a killed app never
/// reaches) and raise the worker floor for the class.
fn learn_from_playback(class: &str, policy: tune::Policy, ceiling: usize) {
    let guard = AUTOTUNE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(cfg) = guard.as_ref() else { return };
    let key = profile::HardwareKey::of(&platform::Machine::detect(), &cfg.os);
    if let profile::Load::Valid(mut p) = profile::Profile::load(&cfg.profile, &key) {
        let floor = p.record_playback_failure(class, policy, ceiling);
        let saved = p.save(&cfg.profile);
        log_autotune(&format!(
            "learned: {class} ({}) needs at least {} workers in playback; the choice is retired and Stage A will calibrate again ({})",
            policy.name(),
            floor.map_or("?".into(), |f| f.to_string()),
            if saved.is_ok() { "saved" } else { "not saved" }
        ));
    }
}

/// At the end of a playback session: a profile choice that the guard had to
/// revert counts as a degraded session for its class and policy; after
/// `profile::DEGRADATIONS_BEFORE_RECALIBRATION` of them the choice is no
/// longer applied and Stage A calibrates that class again.
fn record_session(native: &Native) {
    let d = lock(&native.decoding);
    let (status, class) = d.decoder.autotune_status();
    let t = lock(&native.timing);
    log_autotune(&format!(
        "session: {} pictures, class {class}, AutoTune {status:?}, {} workers, max pressure {} us, bursts {}, decode CPU {} us per picture",
        t.calls,
        d.decoder.threads(),
        t.max_pressure,
        t.bursts,
        d.decoder.stats.decode_cpu_us / (t.calls.max(1) as u64)
    ));
    if status != super::AutoTuneStatus::Reverted {
        return;
    }
    let Some((class, policy)) = d.decoder.autotune_choice() else {
        return;
    };
    let guard = AUTOTUNE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(cfg) = guard.as_ref() else { return };
    let key = profile::HardwareKey::of(&platform::Machine::detect(), &cfg.os);
    if let profile::Load::Valid(mut p) = profile::Profile::load(&cfg.profile, &key) {
        let due = p.note_degradation(&class, policy);
        let saved = p.save(&cfg.profile);
        log_autotune(&format!(
            "session degraded on {class} ({}); {}",
            policy.name(),
            match (due, saved) {
                (_, Err(e)) => format!("profile not saved: {e}"),
                (true, Ok(())) => "the choice is retired; Stage A will calibrate again".into(),
                (false, Ok(())) => "noted".into(),
            }
        ));
    }
}

/// Whether Stage A has work to do: AutoTune is on and the profile lacks a
/// usable choice for one of the calibrated classes (missing, stale, corrupt,
/// unstable or degraded).
#[no_mangle]
pub extern "system" fn Java_com_tmg_tv_TrierMpegVideoNative_needsCalibration(
    _env: JNIEnv,
    _this: JObject,
) -> jboolean {
    let guard = AUTOTUNE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(cfg) = guard.as_ref() else { return 0 };
    let Some(policy) = cfg.policy else { return 0 };
    let key = profile::HardwareKey::of(&platform::Machine::detect(), &cfg.os);
    let needed = match profile::Profile::load(&cfg.profile, &key) {
        profile::Load::Valid(p) => CALIBRATED_CLASSES
            .iter()
            .any(|c| p.choice(c, policy).is_none()),
        _ => true,
    };
    needed as jboolean
}

/// Stage A on the app's three samples (SD, 720p, 1080i) within `seconds`;
/// returns the log lines. Refuses while a decoder is alive; a decoder
/// starting cancels it within a picture.
#[no_mangle]
pub extern "system" fn Java_com_tmg_tv_TrierMpegVideoNative_calibrate(
    mut env: JNIEnv,
    _this: JObject,
    sd: JByteArray,
    hd720: JByteArray,
    hd1080: JByteArray,
    seconds: jint,
    conditions: JString,
) -> jstring {
    let text = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let (path, os, policy) = {
            let guard = AUTOTUNE.lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_ref() {
                Some(AutoTuneConfig {
                    profile,
                    os,
                    policy: Some(p),
                }) => (profile.clone(), os.clone(), *p),
                Some(_) => return "off".to_string(),
                None => return "not configured".to_string(),
            }
        };
        if LIVE.load(Ordering::SeqCst) > 0 {
            return "deferred: playback is running".to_string();
        }
        let conditions = java_string(&mut env, &conditions);
        let bytes =
            |env: &mut JNIEnv, a: &JByteArray| env.convert_byte_array(a).unwrap_or_default();
        let (sd, hd720, hd1080) = (
            bytes(&mut env, &sd),
            bytes(&mut env, &hd720),
            bytes(&mut env, &hd1080),
        );
        let inputs = [
            calibration::Input {
                name: "sd",
                es: &sd,
            },
            calibration::Input {
                name: "hd720",
                es: &hd720,
            },
            calibration::Input {
                name: "hd1080i",
                es: &hd1080,
            },
        ];
        let bounds = calibration::Bounds {
            seconds: f64::from(seconds.max(1)),
            ..calibration::Bounds::default()
        };
        let lines = calibration::stage_a(&inputs, &path, &os, policy, bounds, &conditions);
        for line in &lines {
            log_autotune(&format!("stage A: {line}"));
        }
        lines.join("\n")
    }))
    .unwrap_or_else(|_| "calibration failed (panic caught)".to_string());
    env.new_string(text)
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

#[repr(C)]
struct NativeWindowBuffer {
    width: i32,
    height: i32,
    stride: i32,
    format: i32,
    bits: *mut c_void,
    reserved: [u32; 6],
}
#[link(name = "android")]
extern "C" {
    fn ANativeWindow_fromSurface(
        env: *mut jni::sys::JNIEnv,
        surface: jni::sys::jobject,
    ) -> *mut c_void;
    fn ANativeWindow_release(window: *mut c_void);
    fn ANativeWindow_setBuffersGeometry(
        window: *mut c_void,
        width: i32,
        height: i32,
        format: i32,
    ) -> i32;
    fn ANativeWindow_lock(
        window: *mut c_void,
        buffer: *mut NativeWindowBuffer,
        dirty: *mut c_void,
    ) -> i32;
    fn ANativeWindow_unlockAndPost(window: *mut c_void) -> i32;
}
#[repr(C)]
/// `struct timespec`: `time_t` and `long` are both `long` in bionic, so 32
/// bits on 32-bit ARM and 64 on AArch64.
struct Timespec {
    seconds: std::ffi::c_long,
    nanoseconds: std::ffi::c_long,
}
extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
    fn sched_getcpu() -> i32;
    fn __system_property_get(name: *const std::ffi::c_char, value: *mut std::ffi::c_char) -> i32;
}
#[link(name = "log")]
extern "C" {
    fn __android_log_write(
        priority: i32,
        tag: *const std::ffi::c_char,
        text: *const std::ffi::c_char,
    ) -> i32;
}
/// The per-picture trace (INV-PERF-TAIL), off unless the debug property
/// `debug.genx.trier.trace` is 1 when a decoder starts (adb shell setprop).
fn trace_requested() -> bool {
    property("debug.genx.trier.trace").as_deref() == Some("1")
}
/// A system property's value (empty values as None).
fn property(name: &str) -> Option<String> {
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
struct Cycles(i32);
impl Cycles {
    fn open() -> Option<Self> {
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
    fn now(&self) -> u64 {
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

fn log_trace(line: &str) {
    if let Ok(text) = std::ffi::CString::new(line) {
        // ANDROID_LOG_INFO.
        unsafe { __android_log_write(4, c"TrierMpegVideoTrace".as_ptr(), text.as_ptr()) };
    }
}
/// CPU time this thread has used, in microseconds (CLOCK_THREAD_CPUTIME_ID).
// The casts are needed on 32-bit ARM, where `c_long` is 32 bits.
#[allow(clippy::unnecessary_cast)]
fn thread_cpu_micros() -> i64 {
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
fn cpu_khz(cpu: i32) -> Option<i64> {
    std::fs::read_to_string(format!(
        "/sys/devices/system/cpu/cpu{cpu}/cpufreq/scaling_cur_freq"
    ))
    .ok()?
    .trim()
    .parse()
    .ok()
}
/// Decode times kept for the percentiles (about a minute at 60 pictures/s).
const TIMES: usize = 4096;
/// The clock of the decoding core is sampled once per this many calls.
const FREQUENCY_SAMPLE: i64 = 30;
/// Inputs remembered for the input-to-draw latency (frames out of order wait).
const ARRIVALS: usize = 64;
/// Calls before the lowest queue occupancy counts (the queue fills at a join).
const WARM_UP: i64 = 300;
/// HAL_PIXEL_FORMAT_YV12: Y, then Cr, then Cb; chroma stride aligned to 16.
const YV12: i32 = 0x3231_5659;

struct Native {
    decoding: Mutex<Decoding>,
    /// Frames handed to the player, by id, until it releases them.
    frames: Mutex<HashMap<i64, Frame>>,
    window: Mutex<Window>,
    timing: Mutex<Timing>,
}
/// The decoder thread's part.
struct Decoding {
    decoder: Decoder,
    /// Decoded frames in display order, not yet handed out.
    queue: VecDeque<Frame>,
    next_id: i64,
    /// pictures in, frames out, decode microseconds in total.
    counters: [i64; 3],
    /// The latest per-call decode times (microseconds), for p95/p99/maximum.
    times: VecDeque<u32>,
    /// The playback guard has already noted that the known-good settings
    /// miss the policy's share (logged once per session).
    guard_noted: bool,
}
/// The playback thread's part: the surface being drawn on.
struct Window {
    window: *mut c_void,
    surface: Option<jni::objects::GlobalRef>,
    geometry: (i32, i32),
    drawn: i64,
    last_result: i64,
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
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Where the time goes in the app (performance milestone, docs/trier-mpeg-video.md):
/// how long the decoding thread ran against how long it took, on which core
/// and at what clock, how many frames are waiting, and how long from a
/// picture's data arriving to its frame being drawn.
#[derive(Default)]
struct Timing {
    /// The frame period: the smallest positive time-stamp step seen.
    period: i64,
    last_pts: Option<i64>,
    over_run: i64,
    longest_over_run: i64,
    cpu_micros: i64,
    frequency_samples: i64,
    khz_total: i64,
    calls_by_cpu: [i64; 8],
    held_max: i64,
    /// INV-PERF-TAIL, bounded playback pressure. `pressure` is the decode time
    /// beyond the frame period still owed, carried from picture to picture
    /// (zero when the decoder keeps up); a burst lasts until it is back to
    /// zero, and its recovery time is how long that took.
    pressure: i64,
    max_pressure: i64,
    burst_start: Option<(i64, std::time::Instant)>,
    bursts: i64,
    longest_recovery_pictures: i64,
    longest_recovery_micros: i64,
    /// Fewest frames held (waiting plus with the player) after warm-up: the
    /// margin left before the screen would wait for a picture.
    held_min: Option<i64>,
    calls: i64,
    /// Opened on the decoding thread at its first traced call.
    cycles: Option<Cycles>,
    cycles_tried: bool,
    last_cpu: i32,
    migrations: i64,
    trace: bool,
    /// When each recent picture's data arrived, by time stamp.
    arrivals: VecDeque<(i64, std::time::Instant)>,
    /// Input-to-draw latencies (microseconds), the latest TIMES.
    latencies: VecDeque<u32>,
}
impl Timing {
    fn decoded(&mut self, pts: i64, wall: i64, cpu: i64, arrived: std::time::Instant) {
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
    fn sample_core(&mut self, calls: i64) -> (i32, bool) {
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
    fn held(&mut self, held: i64) {
        self.held_max = self.held_max.max(held);
        if self.calls > WARM_UP {
            self.held_min = Some(self.held_min.map_or(held, |m| m.min(held)));
        }
    }
    fn drawn(&mut self, pts: i64) {
        if let Some(i) = self.arrivals.iter().position(|&(p, _)| p == pts) {
            let (_, arrived) = self.arrivals.remove(i).expect("found");
            if self.latencies.len() == TIMES {
                self.latencies.pop_front();
            }
            self.latencies
                .push_back(arrived.elapsed().as_micros().min(u32::MAX as u128) as u32);
        }
    }
    fn flushed(&mut self) {
        self.last_pts = None;
        self.over_run = 0;
        self.pressure = 0;
        self.burst_start = None;
        self.calls = 0;
        self.arrivals.clear();
    }
}
/// (mean, p95, p99, maximum).
fn percentiles(values: &VecDeque<u32>) -> (i64, i64, i64, i64) {
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
/// The handle's state, shared by both threads (every field has its own lock).
fn native<'a>(handle: jlong) -> Option<&'a Native> {
    if handle == 0 {
        None
    } else {
        Some(unsafe { &*(handle as *const Native) })
    }
}

#[no_mangle]
pub extern "system" fn Java_com_tmg_tv_TrierMpegVideoNative_create(
    _env: JNIEnv,
    _this: JObject,
) -> jlong {
    // Slices on several cores (half the device's, at most 4), with fewer spare
    // frames when memory is short (`Resources`): the slowest pictures (dense I
    // pictures) then take a fraction as long (INV-PERF-TAIL).
    // Playback comes first: a running calibration stops within a picture.
    LIVE.fetch_add(1, Ordering::SeqCst);
    tune::cancel();
    let mut decoder = Decoder::new();
    let mut resources = Resources::detect();
    // `adb shell setprop debug.genx.trier.threads N` sets the workers (A/B
    // tests), and then AutoTune stays out of the way.
    let mut forced = false;
    if let Some(n) = property("debug.genx.trier.threads").and_then(|v| v.parse::<usize>().ok()) {
        if n > 0 {
            resources.threads = n;
            forced = true;
        }
    }
    // `debug.genx.trier.adaptive 1` sizes the workers by each picture's weight.
    if property("debug.genx.trier.adaptive").as_deref() == Some("1") {
        resources.adaptive = true;
    }
    decoder.set_resources(resources);
    // AutoTune: the profile's choice for each stream's class, applied before
    // its first picture; anything missing or stale keeps these settings.
    if !forced {
        let guard = AUTOTUNE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(AutoTuneConfig {
            profile: path,
            os,
            policy: Some(policy),
        }) = guard.as_ref()
        {
            let key = profile::HardwareKey::of(&platform::Machine::detect(), os);
            match profile::Profile::load(path, &key) {
                profile::Load::Valid(p) => {
                    log_autotune(&format!(
                        "decoder: profile with {} choices, policy {}",
                        p.entries.len(),
                        policy.name()
                    ));
                    decoder.set_autotune(p, *policy, resources.threads);
                }
                other => log_autotune(&format!("decoder: no profile applied ({other:?})")),
            }
        }
    }
    let native = Box::new(Native {
        decoding: Mutex::new(Decoding {
            decoder,
            queue: VecDeque::new(),
            next_id: 1,
            counters: [0; 3],
            times: VecDeque::with_capacity(TIMES),
            guard_noted: false,
        }),
        frames: Mutex::new(HashMap::new()),
        window: Mutex::new(Window {
            window: std::ptr::null_mut(),
            surface: None,
            geometry: (0, 0),
            drawn: 0,
            last_result: 0,
        }),
        timing: Mutex::new(Timing {
            trace: trace_requested(),
            ..Timing::default()
        }),
    });
    Box::into_raw(native) as jlong
}

/// After both threads have stopped (Media3 releases the decoder last).
#[no_mangle]
pub extern "system" fn Java_com_tmg_tv_TrierMpegVideoNative_destroy(
    _env: JNIEnv,
    _this: JObject,
    handle: jlong,
) {
    if handle != 0 {
        let native = unsafe { Box::from_raw(handle as *mut Native) };
        record_session(&native);
        drop(native);
        LIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Decodes `size` bytes of `data`; 0 on success, -1 unsupported stream, -2 bad input.
#[no_mangle]
pub extern "system" fn Java_com_tmg_tv_TrierMpegVideoNative_decode(
    env: JNIEnv,
    _this: JObject,
    handle: jlong,
    data: JByteBuffer,
    size: jint,
    time_us: jlong,
) -> jint {
    let Some(n) = native(handle) else { return -2 };
    let (Ok(address), Ok(capacity)) = (
        env.get_direct_buffer_address(&data),
        env.get_direct_buffer_capacity(&data),
    ) else {
        return -2;
    };
    let size = (size.max(0) as usize).min(capacity);
    let bytes = unsafe { std::slice::from_raw_parts(address, size) };
    let mut d = lock(&n.decoding);
    d.counters[0] += 1;
    let (core, moved) = lock(&n.timing).sample_core(d.counters[0]);
    let before = d.decoder.stats;
    let cycles_before = {
        let mut t = lock(&n.timing);
        if t.trace && !t.cycles_tried {
            t.cycles_tried = true;
            t.cycles = Cycles::open();
        }
        t.cycles.as_ref().map_or(0, Cycles::now)
    };
    let started = std::time::Instant::now();
    let cpu_started = thread_cpu_micros();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        d.decoder.decode(bytes, time_us)
    }));
    let micros = started.elapsed().as_micros() as i64;
    let cpu = thread_cpu_micros() - cpu_started;
    let tracing = {
        let mut t = lock(&n.timing);
        let cycles = t
            .cycles
            .as_ref()
            .map_or(0, |c| c.now().saturating_sub(cycles_before));
        t.decoded(time_us, micros, cpu, started);
        // The playback guard (milestone 7): a frame at risk, or the policy's
        // deadline share missed over the last 600 pictures, sends the decoder
        // back to the known-good settings for this session.
        let applied = d.decoder.autotune_status().0 == super::AutoTuneStatus::Applied;
        if applied {
            let risk = calibration::guard_trips(t.calls, t.over_run, t.pressure, t.period);
            let missed = t.calls % 300 == 0
                && d.decoder.autotune_policy().is_some_and(|(policy, _)| {
                    let recent: Vec<u32> = d.times.iter().copied().collect();
                    calibration::policy_trips(policy, t.calls, &recent, t.period)
                });
            if risk || missed {
                let choice = (d.decoder.threads(), d.decoder.autotune_choice());
                let reverted = d.decoder.autotune_revert();
                if !reverted && !d.guard_noted {
                    // The known-good settings themselves miss the policy's
                    // share: nothing to fall back to; noted once per session.
                    d.guard_noted = true;
                    log_autotune(&format!(
                        "guard: the known-good {} workers miss the policy's deadline share on {} (over in a row {}, owed {} us); the target is out of reach for this class here, playback continues unchanged",
                        choice.0,
                        choice.1.as_ref().map_or("?", |c| c.0.as_str()),
                        t.over_run,
                        t.pressure
                    ));
                }
                if reverted {
                    let why = if missed {
                        "the policy's deadline share missed in playback"
                    } else {
                        "a frame at risk"
                    };
                    log_autotune(&format!(
                        "guard: {why} with {} workers on {} (over in a row {}, owed {} us); back to {} workers for this session",
                        choice.0,
                        choice.1.as_ref().map_or("?", |c| c.0.as_str()),
                        t.over_run,
                        t.pressure,
                        d.decoder.threads()
                    ));
                    if let (true, Some((class, policy))) = (missed, choice.1) {
                        learn_from_playback(
                            &class,
                            policy,
                            d.decoder.autotune_policy().map_or(1, |p| p.1),
                        );
                    }
                }
            }
        }
        t.trace.then_some((t.pressure, cycles))
    };
    if let Some((pressure, cycles)) = tracing {
        // Outside the timed region: the clock read costs tens of microseconds.
        let after = d.decoder.stats;
        let held = d.queue.len() + lock(&n.frames).len();
        log_trace(&format!(
            "T,{},{},{},{},{},{},{},{micros},{cpu},{core},{},{},{held},{pressure},{cycles}",
            d.counters[0],
            after.last_type,
            after.last_structure,
            after.coefficients - before.coefficients,
            after.coded_macroblocks - before.coded_macroblocks,
            after.intra_macroblocks - before.intra_macroblocks,
            after.skipped_macroblocks - before.skipped_macroblocks,
            moved as u8,
            cpu_khz(core).unwrap_or(0),
        ));
    }
    d.counters[2] += micros;
    if d.times.len() == TIMES {
        d.times.pop_front();
    }
    d.times.push_back(micros.min(u32::MAX as i64) as u32);
    match result {
        Ok(Ok(frames)) => {
            d.counters[1] += frames.len() as i64;
            d.queue.extend(frames);
            0
        }
        Ok(Err(_)) => -1,
        Err(_) => {
            d.decoder.reset();
            -2
        }
    }
}

/// The next frame in display order: its id (0 when none), with
/// out = [time stamp, width, height].
#[no_mangle]
pub extern "system" fn Java_com_tmg_tv_TrierMpegVideoNative_next(
    env: JNIEnv,
    _this: JObject,
    handle: jlong,
    out: JLongArray,
) -> jlong {
    let Some(n) = native(handle) else { return 0 };
    let mut d = lock(&n.decoding);
    let Some(frame) = d.queue.pop_front() else {
        return 0;
    };
    let id = d.next_id;
    d.next_id += 1;
    let info = [frame.pts, frame.width as i64, frame.height as i64];
    let _ = env.set_long_array_region(&out, 0, &info);
    let held = {
        let mut frames = lock(&n.frames);
        frames.insert(id, frame);
        (d.queue.len() + frames.len()) as i64
    };
    lock(&n.timing).held(held);
    id
}

#[no_mangle]
pub extern "system" fn Java_com_tmg_tv_TrierMpegVideoNative_release(
    _env: JNIEnv,
    _this: JObject,
    handle: jlong,
    id: jlong,
) {
    if let Some(n) = native(handle) {
        // Dropped outside the lock: the last reference frees the planes.
        let frame = lock(&n.frames).remove(&id);
        drop(frame);
    }
}

/// Drops pending pictures and references (seek, flush).
#[no_mangle]
pub extern "system" fn Java_com_tmg_tv_TrierMpegVideoNative_flush(
    _env: JNIEnv,
    _this: JObject,
    handle: jlong,
) {
    if let Some(n) = native(handle) {
        let mut d = lock(&n.decoding);
        d.decoder.reset();
        d.queue.clear();
        lock(&n.timing).flushed();
    }
}

/// Copies frame `id` into the surface; 0 on success.
#[no_mangle]
pub extern "system" fn Java_com_tmg_tv_TrierMpegVideoNative_render(
    mut env: JNIEnv,
    _this: JObject,
    handle: jlong,
    id: jlong,
    surface: JObject,
) -> jint {
    let Some(n) = native(handle) else { return -1 };
    // The frame's planes are shared (Arc): the map's lock is held only to find it.
    let Some(frame) = lock(&n.frames).get(&id).cloned() else {
        return -2;
    };
    let mut w = lock(&n.window);
    let result = draw(&mut env, &mut w, &frame, &surface);
    w.last_result = result as i64;
    if result == 0 {
        w.drawn += 1;
        drop(w);
        lock(&n.timing).drawn(frame.pts);
    }
    result
}

fn draw(env: &mut JNIEnv, n: &mut Window, frame: &Frame, surface: &JObject) -> jint {
    // Reuse the window while the surface is the same object.
    let same = n
        .surface
        .as_ref()
        .is_some_and(|g| env.is_same_object(g, surface).unwrap_or(false));
    if !same {
        if !n.window.is_null() {
            unsafe { ANativeWindow_release(n.window) };
            n.window = std::ptr::null_mut();
        }
        n.window = unsafe { ANativeWindow_fromSurface(env.get_raw(), surface.as_raw()) };
        if n.window.is_null() {
            return -3;
        }
        n.surface = env.new_global_ref(surface).ok();
        n.geometry = (0, 0);
    }
    let (w, h) = (frame.width as i32, frame.height as i32);
    if n.geometry != (w, h) {
        if unsafe { ANativeWindow_setBuffersGeometry(n.window, w, h, YV12) } != 0 {
            return -4;
        }
        n.geometry = (w, h);
    }
    let mut buffer = NativeWindowBuffer {
        width: 0,
        height: 0,
        stride: 0,
        format: 0,
        bits: std::ptr::null_mut(),
        reserved: [0; 6],
    };
    if unsafe { ANativeWindow_lock(n.window, &mut buffer, std::ptr::null_mut()) } != 0
        || buffer.bits.is_null()
    {
        return -5;
    }
    let planes = &frame.planes;
    let rows = (h.min(buffer.height)) as usize;
    let cols = (w.min(buffer.width)) as usize;
    let y_stride = buffer.stride as usize;
    let c_stride = ((buffer.stride as usize / 2) + 15) & !15;
    let c_rows = (buffer.height as usize).div_ceil(2);
    let base = buffer.bits as *mut u8;
    unsafe {
        for row in 0..rows {
            std::ptr::copy_nonoverlapping(
                planes.y.as_ptr().add(row * planes.width),
                base.add(row * y_stride),
                cols,
            );
        }
        let v_plane = base.add(y_stride * buffer.height as usize);
        let u_plane = v_plane.add(c_stride * c_rows);
        let (cw, ch) = (cols.div_ceil(2), rows.div_ceil(2));
        let src_cw = planes.width / 2;
        for row in 0..ch {
            std::ptr::copy_nonoverlapping(
                planes.cr.as_ptr().add(row * src_cw),
                v_plane.add(row * c_stride),
                cw,
            );
            std::ptr::copy_nonoverlapping(
                planes.cb.as_ptr().add(row * src_cw),
                u_plane.add(row * c_stride),
                cw,
            );
        }
        ANativeWindow_unlockAndPost(n.window);
    }
    0
}

/// out (32 values) = [pictures in, frames out, frames drawn, last draw result,
/// decode microseconds in total, decode p95, p99, maximum (microseconds per
/// call), longest run of consecutive calls over the frame period, thread CPU
/// microseconds in total, clock samples, kHz summed over them, frames held now
/// (waiting plus with the player), most frames held, input-to-draw latency
/// mean, p95, maximum (microseconds), frame period (microseconds), then calls
/// on each of CPUs 0 to 7, then INV-PERF-TAIL: most pressure (microseconds of
/// decoding beyond the frame period still owed), bursts, longest recovery in
/// pictures and microseconds, fewest frames held after warm-up, core moves].
/// Decode wall time against thread CPU time shows whether the thread was
/// running slowly or waiting for a core.
#[no_mangle]
pub extern "system" fn Java_com_tmg_tv_TrierMpegVideoNative_counters(
    env: JNIEnv,
    _this: JObject,
    handle: jlong,
    out: JLongArray,
) {
    let Some(n) = native(handle) else { return };
    let mut values = [0i64; 36];
    {
        // An average hides the single slow picture that shows as a hitch:
        // report p95, p99 and the maximum over the latest calls too.
        let d = lock(&n.decoding);
        // AutoTune: what is in force for this stream, and the decoder's own
        // CPU time so far (every worker).
        let (status, _) = d.decoder.autotune_status();
        values[32] = status.code();
        values[33] = d.decoder.threads() as i64;
        values[34] = super::kit::KITS
            .iter()
            .position(|k| k.id == d.decoder.kit())
            .map_or(-1, |i| i as i64);
        values[35] = d.decoder.stats.decode_cpu_us as i64;
        let (_, p95, p99, max) = percentiles(&d.times);
        values[0] = d.counters[0];
        values[1] = d.counters[1];
        values[4] = d.counters[2];
        values[5..8].copy_from_slice(&[p95, p99, max]);
        values[12] = (d.queue.len() + lock(&n.frames).len()) as i64;
    }
    {
        let w = lock(&n.window);
        values[2] = w.drawn;
        values[3] = w.last_result;
    }
    let t = lock(&n.timing);
    let (latency, latency_p95, _, latency_max) = percentiles(&t.latencies);
    values[8..12].copy_from_slice(&[
        t.longest_over_run,
        t.cpu_micros,
        t.frequency_samples,
        t.khz_total,
    ]);
    values[13..18].copy_from_slice(&[t.held_max, latency, latency_p95, latency_max, t.period]);
    values[18..26].copy_from_slice(&t.calls_by_cpu);
    values[26..32].copy_from_slice(&[
        t.max_pressure,
        t.bursts,
        t.longest_recovery_pictures,
        t.longest_recovery_micros,
        t.held_min.unwrap_or(-1),
        t.migrations,
    ]);
    drop(t);
    // Only as many as the app's array holds (older apps had 32).
    let room = env.get_array_length(&out).unwrap_or(0).max(0) as usize;
    let _ = env.set_long_array_region(&out, 0, &values[..room.min(values.len())]);
}
