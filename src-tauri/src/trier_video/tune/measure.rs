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

//! Measuring a run: CPU time, cycles, memory, and the Windows counters.

/// Process CPU time (all threads).
pub mod cpu {
    /// Microseconds, or None where unavailable.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    pub fn process_us() -> Option<f64> {
        #[repr(C)]
        // `time_t` and `long` are both `long` (32 bits on 32-bit ARM).
        struct Timespec {
            seconds: std::ffi::c_long,
            nanoseconds: std::ffi::c_long,
        }
        extern "C" {
            fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
        }
        let mut t = Timespec {
            seconds: 0,
            nanoseconds: 0,
        };
        // SAFETY: `t` is a valid timespec; CLOCK_PROCESS_CPUTIME_ID is 2.
        (unsafe { clock_gettime(2, &mut t) } == 0)
            .then(|| t.seconds as f64 * 1e6 + t.nanoseconds as f64 / 1e3)
    }
    #[cfg(windows)]
    pub fn process_us() -> Option<f64> {
        let mut t = [super::win::FileTime::default(); 4];
        let [a, b, c, d] = &mut t;
        // SAFETY: four valid FILETIMEs for the current process's pseudo-handle.
        let ok =
            unsafe { super::win::GetProcessTimes(super::win::GetCurrentProcess(), a, b, c, d) };
        // Kernel and user time, 100 ns units.
        (ok != 0).then(|| (t[2].value() + t[3].value()) as f64 / 10.0)
    }
    #[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
    pub fn process_us() -> Option<f64> {
        None
    }
}

/// User-mode CPU cycles of the process, every thread.
pub mod cycles {
    /// Linux and Android: a perf counter on this thread that its future
    /// threads inherit (their counts are added when they exit); denied to
    /// Android apps, allowed to the shell. Windows: the process's cycle time
    /// (all threads, user and kernel).
    pub struct Counter {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        fd: i32,
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    extern "C" {
        fn syscall(number: std::ffi::c_long, ...) -> std::ffi::c_long;
        fn read(fd: i32, buf: *mut std::ffi::c_void, count: usize) -> isize;
        fn close(fd: i32) -> i32;
    }
    impl Counter {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        pub fn open() -> Option<Self> {
            // struct perf_event_attr (128 bytes): type HARDWARE (0) and size;
            // config CPU_CYCLES (0); flags at byte 40: inherit (bit 1),
            // exclude_kernel (5), exclude_hv (6).
            let mut attr = [0u64; 16];
            attr[0] = 128u64 << 32;
            attr[5] = (1 << 1) | (1 << 5) | (1 << 6);
            let number: std::ffi::c_long = if cfg!(target_arch = "aarch64") {
                241
            } else if cfg!(target_arch = "arm") {
                364
            } else {
                298
            };
            // SAFETY: perf_event_open(attr, this thread, any CPU, no group, no flags).
            let fd = unsafe { syscall(number, attr.as_ptr(), 0i32, -1i32, -1i32, 0u64) } as i32;
            (fd >= 0).then_some(Counter { fd })
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        pub fn read(&self) -> Option<u64> {
            let mut value = 0u64;
            // SAFETY: reads 8 bytes into `value` from our own perf fd.
            let got = unsafe { read(self.fd, &mut value as *mut u64 as *mut std::ffi::c_void, 8) };
            (got == 8).then_some(value)
        }
        #[cfg(windows)]
        pub fn open() -> Option<Self> {
            Some(Counter {})
        }
        #[cfg(windows)]
        pub fn read(&self) -> Option<u64> {
            let mut c = 0u64;
            // SAFETY: the current process's pseudo-handle and a valid u64.
            (unsafe { super::win::QueryProcessCycleTime(super::win::GetCurrentProcess(), &mut c) }
                != 0)
                .then_some(c)
        }
        #[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
        pub fn open() -> Option<Self> {
            None
        }
        #[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
        pub fn read(&self) -> Option<u64> {
            None
        }
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    impl Drop for Counter {
        fn drop(&mut self) {
            // SAFETY: closes our own fd once.
            unsafe { close(self.fd) };
        }
    }
}

/// Peak resident memory.
pub mod memory {
    /// Linux: resets the kernel's peak (VmHWM) so the next reading is this
    /// run's; false where that is not possible (the peak is then the process's).
    pub fn reset_peak() -> bool {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            std::fs::write("/proc/self/clear_refs", "5").is_ok()
        }
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        {
            false
        }
    }
    /// Bytes, or None.
    pub fn peak() -> Option<u64> {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            let status = std::fs::read_to_string("/proc/self/status").ok()?;
            let kb: u64 = status
                .lines()
                .find_map(|l| l.strip_prefix("VmHWM:"))?
                .split_whitespace()
                .next()?
                .parse()
                .ok()?;
            Some(kb * 1024)
        }
        #[cfg(windows)]
        {
            let mut c = super::win::MemoryCounters {
                cb: std::mem::size_of::<super::win::MemoryCounters>() as u32,
                ..Default::default()
            };
            // SAFETY: a correctly sized PROCESS_MEMORY_COUNTERS.
            let ok = unsafe {
                super::win::K32GetProcessMemoryInfo(super::win::GetCurrentProcess(), &mut c, c.cb)
            };
            (ok != 0).then_some(c.peak_working_set as u64)
        }
        #[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
        {
            None
        }
    }
}

/// Windows process counters (kernel32, linked by std).
#[cfg(windows)]
pub mod win {
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct FileTime {
        low: u32,
        high: u32,
    }
    impl FileTime {
        pub fn value(&self) -> u64 {
            (self.high as u64) << 32 | self.low as u64
        }
    }
    #[repr(C)]
    #[derive(Default)]
    pub struct MemoryCounters {
        pub cb: u32,
        pub page_faults: u32,
        pub peak_working_set: usize,
        pub working_set: usize,
        pub quota_peak_paged: usize,
        pub quota_paged: usize,
        pub quota_peak_nonpaged: usize,
        pub quota_nonpaged: usize,
        pub pagefile: usize,
        pub peak_pagefile: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetCurrentProcess() -> isize;
        pub fn GetProcessTimes(
            process: isize,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        pub fn QueryProcessCycleTime(process: isize, cycles: *mut u64) -> i32;
        pub fn K32GetProcessMemoryInfo(
            process: isize,
            counters: *mut MemoryCounters,
            cb: u32,
        ) -> i32;
        pub fn SetProcessAffinityMask(process: isize, mask: usize) -> i32;
    }
}
