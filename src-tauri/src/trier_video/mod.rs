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

//! Trier MPEG Video: GenX's own MPEG-2 video decoder (ITU-T H.262 | ISO/IEC
//! 13818-2, Main Profile, 4:2:0), written from the published standard
//! (docs/trier-mpeg-video.md). Built for devices that offer apps no MPEG-2
//! decoder, such as Samsung's Galaxy phones (owner decision, October 19, 2026).
//!
//! Input is elementary-stream data (one or more whole pictures per call, as
//! demultiplexers deliver them). Output is decoded frames in display order,
//! each with the time stamp of the data it came from. Damaged data never
//! panics: a bad slice is concealed from the reference picture and decoding
//! continues with the next slice.
#![allow(clippy::needless_range_loop)]
#[cfg(target_os = "android")]
mod android;
mod annex_b;
mod bits;
mod idct;
pub mod kit;
mod macroblock;
mod mc;
mod picture;
pub mod calibration;
pub mod platform;
pub mod profile;
mod pool;
mod tables;
#[cfg(test)]
mod tests;
pub mod tune;
pub mod yoyo;

use bits::{Bits, Vlc};
use mc::{predict, View};
use std::sync::{Arc, OnceLock};
use tables::{Coef, MbType};

/// A decoded picture's samples (4:2:0); planes are padded to whole macroblocks.
pub struct Planes {
    pub y: Vec<u8>,
    pub cb: Vec<u8>,
    pub cr: Vec<u8>,
    /// Luma width and height of the padded planes (chroma is half of each).
    pub width: usize,
    pub height: usize,
}
impl Planes {
    fn new(width: usize, height: usize) -> Self {
        Self {
            y: vec![16; width * height],
            cb: vec![128; width * height / 4],
            cr: vec![128; width * height / 4],
            width,
            height,
        }
    }
    /// Black again, exactly as `new` makes it.
    fn clear(&mut self) {
        self.y.fill(16);
        self.cb.fill(128);
        self.cr.fill(128);
    }
}

/// Free frame buffers kept for reuse beyond those still in use (the default;
/// `Resources` lowers it when memory is short).
const SPARE_PLANES: usize = 2;

/// How much of the machine the decoder takes (owner rule: a television also
/// needs cores for sound, drawing, the network and the system, so the decoder
/// never takes them all). Workers: half the cores, at most 4, at least 1.
/// Memory: below LOW_MEMORY available, no spare frame buffers are kept; below
/// VERY_LOW_MEMORY, one worker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Resources {
    pub threads: usize,
    pub spare_frames: usize,
    /// Workers by each picture's weight (up to `threads`) instead of always all.
    pub adaptive: bool,
}
const LOW_MEMORY: u64 = 512 << 20;
const VERY_LOW_MEMORY: u64 = 192 << 20;
impl Resources {
    /// From the cores this process may use and the memory available now.
    pub fn detect() -> Self {
        let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
        Self::for_machine(cores, available_memory())
    }
    pub fn for_machine(cores: usize, memory: Option<u64>) -> Self {
        let mut threads = (cores / 2).clamp(1, 4);
        let mut spare_frames = SPARE_PLANES;
        if let Some(available) = memory {
            if available < LOW_MEMORY {
                spare_frames = 0;
            }
            if available < VERY_LOW_MEMORY {
                threads = 1;
            }
        }
        Resources {
            threads,
            spare_frames,
            // Measured on the S25 on battery (docs/trier-mpeg-video.md): every
            // worker for every picture gave the best tail, with no measurable
            // difference in power or temperature, so adaptive is off.
            adaptive: false,
        }
    }
}
/// MemAvailable from /proc/meminfo (Linux and Android); None elsewhere.
fn available_memory() -> Option<u64> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = info.lines().find(|l| l.starts_with("MemAvailable:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}

/// A frame ready for display.
#[derive(Clone)]
pub struct Frame {
    pub planes: Arc<Planes>,
    /// The visible size (horizontal_size, vertical_size).
    pub width: usize,
    pub height: usize,
    pub pts: i64,
    pub progressive: bool,
    pub top_field_first: bool,
    pub repeat_first_field: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The stream needs features this decoder does not implement (MPEG-1,
    /// 4:2:2/4:4:4, scalability).
    Unsupported(&'static str),
}

struct Vlcs {
    mb_increment: Vlc<i32>,
    cbp: Vlc<i32>,
    motion: Vlc<i32>,
    dmv: Vlc<i32>,
    dc_luma: Vlc<i32>,
    dc_chroma: Vlc<i32>,
    coef0: Vlc<Coef>,
    coef1: Vlc<Coef>,
    mb_i: Vlc<MbType>,
    mb_p: Vlc<MbType>,
    mb_b: Vlc<MbType>,
}
/// The two-codes-per-read tables (B.14 and B.15) for a window of `bits` bits
/// (10 to 12), built on first use: only the windows a kit uses take memory.
fn pair_tables(bits: u32) -> &'static [Vec<u64>; 2] {
    static T: [OnceLock<[Vec<u64>; 2]>; 3] = [OnceLock::new(), OnceLock::new(), OnceLock::new()];
    assert!((10..=12).contains(&bits), "pair window");
    T[(bits - 10) as usize].get_or_init(|| {
        let zero: Vec<(&str, Coef)> = annex_b::DCT_TABLE_ZERO
            .iter()
            .copied()
            .filter(|(_, c)| *c != Coef::FirstOne)
            .collect();
        [
            tables::coef_pairs(&zero, bits),
            tables::coef_pairs(annex_b::DCT_TABLE_ONE, bits),
        ]
    })
}
fn vlcs() -> &'static Vlcs {
    static V: OnceLock<Vlcs> = OnceLock::new();
    V.get_or_init(|| {
        let zero: Vec<(&str, Coef)> = annex_b::DCT_TABLE_ZERO
            .iter()
            .copied()
            .filter(|(_, c)| *c != Coef::FirstOne)
            .collect();
        Vlcs {
            mb_increment: Vlc::new(annex_b::MB_ADDRESS_INCREMENT),
            cbp: Vlc::new(annex_b::CODED_BLOCK_PATTERN),
            motion: Vlc::new(annex_b::MOTION_CODE),
            dmv: Vlc::new(annex_b::DMVECTOR),
            dc_luma: Vlc::new(annex_b::DCT_DC_SIZE_LUMINANCE),
            dc_chroma: Vlc::new(annex_b::DCT_DC_SIZE_CHROMINANCE),
            coef0: Vlc::packed(&zero, tables::pack_coef),
            coef1: Vlc::packed(annex_b::DCT_TABLE_ONE, tables::pack_coef),
            mb_i: Vlc::new(tables::MB_TYPE_I),
            mb_p: Vlc::new(tables::MB_TYPE_P),
            mb_b: Vlc::new(tables::MB_TYPE_B),
        }
    })
}

/// AutoTune's state in a decoder.
struct AutoTune {
    profile: profile::Profile,
    policy: tune::Policy,
    ceiling: usize,
    /// The settings before AutoTune: kit, workers, adaptive.
    base: (kit::KitId, usize, bool),
    /// The stream shape the current settings were chosen for.
    shape: Option<(usize, usize, bool)>,
    status: AutoTuneStatus,
    class: String,
}
/// What AutoTune did for the current stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoTuneStatus {
    /// No profile was given.
    Off,
    /// Given, waiting for the first picture.
    Waiting,
    /// The profile's choice for this class is in force.
    Applied,
    /// No usable choice for this class: the known-good settings.
    NoChoice,
    /// The chosen kit was refused (unsupported CPU or contract change).
    KitRefused,
    /// Playback pressure under the profile's choice: back to the known-good
    /// settings for the rest of this decoder's life (milestone 7).
    Reverted,
}
impl AutoTuneStatus {
    pub fn code(self) -> i64 {
        match self {
            AutoTuneStatus::Off => 0,
            AutoTuneStatus::Waiting => 1,
            AutoTuneStatus::Applied => 2,
            AutoTuneStatus::NoChoice => 3,
            AutoTuneStatus::KitRefused => 4,
            AutoTuneStatus::Reverted => 5,
        }
    }
}

#[derive(Clone)]
struct Sequence {
    width: usize,
    height: usize,
    mb_width: usize,
    mb_height: usize,
    progressive: bool,
    mpeg2: bool,
    intra: [u8; 64],
    non_intra: [u8; 64],
}

const FRAME: u8 = 3;
const BOTTOM: u8 = 2;
const I_PIC: u8 = 1;
const P_PIC: u8 = 2;
const B_PIC: u8 = 3;

#[derive(Clone, Copy, Default)]
struct Picture {
    coding_type: u8,
    f_code: [[u8; 2]; 2],
    intra_dc_precision: u8,
    structure: u8,
    top_field_first: bool,
    frame_pred_frame_dct: bool,
    concealment: bool,
    q_scale_type: bool,
    intra_vlc_format: bool,
    alternate_scan: bool,
    repeat_first_field: bool,
    progressive_frame: bool,
}

/// The frame being decoded (one frame picture, or two field pictures).
struct Current {
    planes: Planes,
    reference: bool,
    pts: i64,
    picture: Picture,
    /// Set after the first field of a field-picture pair.
    first_field: Option<u8>,
    /// A copy of the first field's frame, for the second field of a P frame.
    first_field_copy: Option<Arc<Planes>>,
    /// Macroblock rows of the current picture (frame or field) a slice reached.
    rows_seen: Vec<bool>,
    /// For a reused buffer not yet cleared: which macroblock rows (of the frame
    /// picture or first field) have been set to black. Each row is cleared once,
    /// just before its first slice, or at the end of the picture if no slice
    /// reached it; empty when the whole buffer is already black.
    cleared: Vec<bool>,
}

/// Motion state that survives from one macroblock to the next.
#[derive(Clone, Copy, Default)]
struct Motion {
    forward: bool,
    backward: bool,
    /// 1 field-based, 2 frame-based (16x8 in field pictures), 3 dual prime.
    kind: u8,
}

pub struct Decoder {
    seq: Option<Sequence>,
    pic: Picture,
    have_picture_header: bool,
    pending_pts: Option<i64>,
    /// Older and newer reference frames (I or P).
    older: Option<Arc<Planes>>,
    newer: Option<Arc<Planes>>,
    newer_frame: Option<Frame>,
    current: Option<Current>,
    out: Vec<Frame>,
    /// Every frame buffer handed out and not yet given up. One whose only
    /// holder is this list is free: nothing else can reach it any more, so it
    /// is reused instead of allocating (and the system mapping and zeroing) a
    /// fresh 1.4 MB per 720p picture, which measured 340 page faults each.
    planes: Vec<Arc<Planes>>,
    /// Pictures since the last I-picture are undecodable after a reset.
    need_intra: bool,
    // Macroblock state.
    scan: [u8; 64],
    /// Cores a picture's slices may be decoded on (1 to 8; `set_threads`).
    threads: usize,
    /// Free frame buffers kept for reuse (`set_resources`).
    spare_frames: usize,
    /// Workers by picture weight (`set_resources`); otherwise always `threads`.
    adaptive: bool,
    /// The slice workers' threads, kept for the decoder's life (`set_threads`).
    pool: Option<pool::Pool>,
    /// The registered kit decoding the slices (`set_kit`); changes take effect
    /// at the next picture.
    kit: kit::KitId,
    /// AutoTune's profile and policy: the choice for each stream's workload
    /// class is applied before the class's first picture.
    autotune: Option<AutoTune>,
    pub stats: Stats,
}

#[derive(Clone, Copy, Default, Debug)]
pub struct Stats {
    pub pictures: u64,
    pub concealed_slices: u64,
    /// Work done so far, for relating each picture's decode time to its
    /// content (INV-PERF-TAIL, docs/trier-mpeg-video.md): coded DCT
    /// coefficients, coded, intra and skipped macroblocks.
    pub coefficients: u64,
    pub coded_macroblocks: u64,
    pub intra_macroblocks: u64,
    pub skipped_macroblocks: u64,
    /// The last picture's picture_coding_type (1 I, 2 P, 3 B) and
    /// picture_structure (3 frame, 1 top field, 2 bottom field).
    pub last_type: u8,
    pub last_structure: u8,
    /// CPU time spent decoding slices, summed over every worker's thread
    /// clock (microseconds; 0 where thread clocks are unavailable): the cost
    /// AutoTune weighs in an app, where perf counters are denied.
    pub decode_cpu_us: u64,
}

impl Stats {
    /// Adds a slice worker's counts (pictures and the last picture's type are
    /// the decoder's own).
    fn add(&mut self, other: &Stats) {
        self.concealed_slices += other.concealed_slices;
        self.coefficients += other.coefficients;
        self.coded_macroblocks += other.coded_macroblocks;
        self.intra_macroblocks += other.intra_macroblocks;
        self.skipped_macroblocks += other.skipped_macroblocks;
        self.decode_cpu_us += other.decode_cpu_us;
    }
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoder {
    pub fn new() -> Self {
        Self {
            seq: None,
            pic: Picture::default(),
            have_picture_header: false,
            pending_pts: None,
            older: None,
            newer: None,
            newer_frame: None,
            current: None,
            out: Vec::new(),
            planes: Vec::new(),
            need_intra: true,
            threads: 1,
            spare_frames: SPARE_PLANES,
            adaptive: false,
            pool: None,
            // The first registered kit this CPU can run (the default kit,
            // unless it needs NEON on a 32-bit ARM CPU without it).
            kit: kit::available().next().map_or(kit::KitId::Portable, |k| k.id),
            autotune: None,
            scan: tables::scan_to_raster(false),
            stats: Stats::default(),
        }
    }

    /// Forgets references and pending pictures (after a seek or a stream change).
    /// Decode each picture's slices on up to `threads` cores (1 to 8). The
    /// pictures are the same however many (tested).
    pub fn set_threads(&mut self, threads: usize) {
        self.threads = threads.clamp(1, 8);
        // Helper threads start once here, not for every picture.
        self.pool = (self.threads > 1).then(|| pool::Pool::new(self.threads - 1));
    }
    /// Workers and spare frame buffers, usually from `Resources::detect()`.
    /// Decodes with the registered kit `id` from the next picture on (the
    /// adaptive engine's choice; every kit gives the same pictures, tested).
    pub fn set_kit(&mut self, id: kit::KitId) -> Result<(), kit::KitError> {
        let info = kit::info_of(id);
        if !kit::Features::detected().covers(info.requires) {
            return Err(kit::KitError::Unsupported(info.requires));
        }
        if info.contract != kit::info_of(self.kit).contract {
            return Err(kit::KitError::ContractChange);
        }
        self.kit = id;
        Ok(())
    }
    pub fn kit(&self) -> kit::KitId {
        self.kit
    }
    /// Workers per picture now.
    pub fn threads(&self) -> usize {
        self.threads
    }
    /// Applies AutoTune's `profile` under `policy` from the next stream on:
    /// for each workload class with a usable choice, that kit and those
    /// workers (at most `ceiling` for capped policies); for classes without
    /// one, the settings in force now (the known-good configuration).
    pub fn set_autotune(&mut self, profile: profile::Profile, policy: tune::Policy, ceiling: usize) {
        self.autotune = Some(AutoTune {
            profile,
            policy,
            ceiling,
            base: (self.kit, self.threads, self.adaptive),
            shape: None,
            status: AutoTuneStatus::Waiting,
            class: String::new(),
        });
    }
    /// Back to the settings in force before AutoTune, for the rest of this
    /// decoder's life (the playback guard, milestone 7): the next picture
    /// decodes with them. True when a profile choice was in force.
    pub fn autotune_revert(&mut self) -> bool {
        let Some(a) = self.autotune.as_ref() else { return false };
        if a.status != AutoTuneStatus::Applied {
            return false;
        }
        // The choice is the known-good settings themselves: nothing to fall
        // back to, and nothing to learn.
        if a.base == (self.kit, self.threads, self.adaptive) {
            return false;
        }
        let (kit, threads, adaptive) = a.base;
        if let Some(a) = self.autotune.as_mut() {
            a.status = AutoTuneStatus::Reverted;
        }
        let _ = self.set_kit(kit);
        if threads != self.threads {
            self.set_threads(threads);
        }
        self.adaptive = adaptive;
        true
    }
    /// The policy and operating ceiling AutoTune runs under, if any.
    pub fn autotune_policy(&self) -> Option<(tune::Policy, usize)> {
        self.autotune.as_ref().map(|a| (a.policy, a.ceiling))
    }
    /// The class and policy whose choice is (or was, before a revert) in force.
    pub fn autotune_choice(&self) -> Option<(String, tune::Policy)> {
        self.autotune.as_ref().and_then(|a| {
            matches!(a.status, AutoTuneStatus::Applied | AutoTuneStatus::Reverted)
                .then(|| (a.class.clone(), a.policy))
        })
    }
    /// What AutoTune did for the current stream, and its class.
    pub fn autotune_status(&self) -> (AutoTuneStatus, &str) {
        self.autotune
            .as_ref()
            .map_or((AutoTuneStatus::Off, ""), |a| (a.status, a.class.as_str()))
    }
    /// Before a picture: if the stream's shape changed, apply the choice for
    /// its class (picture boundary: the previous picture's slices are done).
    fn apply_autotune(&mut self) {
        let Some(seq) = self.seq.as_ref() else { return };
        let shape = (seq.width, seq.height, seq.progressive);
        let Some(a) = self.autotune.as_mut() else { return };
        // After a revert the known-good settings stay for this decoder's life.
        if a.shape == Some(shape) || a.status == AutoTuneStatus::Reverted {
            return;
        }
        a.shape = Some(shape);
        a.class = profile::workload_class(shape.0, shape.1, shape.2);
        let choice = a.profile.choice(&a.class, a.policy).map(|e| e.config);
        let (policy, ceiling, base) = (a.policy, a.ceiling, a.base);
        let (kit, threads, adaptive, status) = match choice {
            Some(c) => {
                let workers = if policy.capped() { c.workers.min(ceiling) } else { c.workers };
                (c.kit, workers, c.adaptive, AutoTuneStatus::Applied)
            }
            None => (base.0, base.1, base.2, AutoTuneStatus::NoChoice),
        };
        let status = if self.set_kit(kit).is_ok() {
            status
        } else {
            AutoTuneStatus::KitRefused
        };
        if threads != self.threads {
            self.set_threads(threads);
        }
        self.adaptive = adaptive;
        if let Some(a) = self.autotune.as_mut() {
            a.status = status;
        }
    }
    pub fn set_resources(&mut self, r: Resources) {
        self.set_threads(r.threads);
        self.spare_frames = r.spare_frames;
        self.adaptive = r.adaptive;
    }

    pub fn reset(&mut self) {
        self.older = None;
        self.newer = None;
        self.newer_frame = None;
        self.current = None;
        self.out.clear();
        self.need_intra = true;
        self.have_picture_header = false;
    }

    /// A black frame buffer: a free one reused, or a new one. Buffers of
    /// another size are given up, and at most `spare_frames` free ones are kept.
    /// A frame buffer and whether it still needs clearing (`Current::cleared`).
    fn take_planes(&mut self, width: usize, height: usize) -> (Planes, bool) {
        self.planes
            .retain(|p| p.width == width && p.height == height);
        // A count of one cannot rise again (no other holder exists to clone
        // it), so try_unwrap then succeeds; holders on other threads only drop.
        let reused = self
            .planes
            .iter()
            .position(|p| Arc::strong_count(p) == 1)
            .and_then(|i| Arc::try_unwrap(self.planes.swap_remove(i)).ok());
        let mut spare = 0;
        self.planes.retain(|p| {
            if Arc::strong_count(p) > 1 {
                return true;
            }
            spare += 1;
            spare <= self.spare_frames
        });
        match reused {
            // With slice workers a reused buffer is cleared row by row by the
            // worker decoding that row (`Current::cleared`), in parallel;
            // otherwise here, whole.
            Some(mut planes) => {
                if self.pool.is_none() {
                    planes.clear();
                    (planes, false)
                } else {
                    (planes, true)
                }
            }
            None => (Planes::new(width, height), false),
        }
    }

    /// Frames still held for display order (the last reference frame).
    pub fn flush(&mut self) -> Vec<Frame> {
        let mut out = std::mem::take(&mut self.out);
        out.extend(self.newer_frame.take());
        out
    }

    /// Decodes whole pictures from `data`; returns frames now due for display.
    pub fn decode(&mut self, data: &[u8], pts: i64) -> Result<Vec<Frame>, Error> {
        let units = start_codes(data);
        // A picture's slices are collected, then decoded together (on two
        // cores when allowed) before the next header or the end of the data.
        let mut slices: Vec<(u8, &[u8])> = Vec::new();
        for (index, &(code, start)) in units.iter().enumerate() {
            let end = units
                .get(index + 1)
                .map(|&(_, s)| s - 4)
                .unwrap_or(data.len());
            let body = &data[start..end.max(start)];
            if !(0x01..=0xAF).contains(&code) && !slices.is_empty() {
                self.run_slices(&slices);
                slices.clear();
            }
            match code {
                0xB3 => self.sequence_header(body),
                0xB5 => self.extension(body)?,
                0xB8 => {}
                0x00 => {
                    self.apply_autotune();
                    self.picture_header(body, pts)?
                }
                0x01..=0xAF => {
                    if self.have_picture_header {
                        slices.push((code, body));
                    }
                }
                0xB7 => self.finish_frame_if_complete(true),
                _ => {}
            }
        }
        self.run_slices(&slices);
        // A picture ends with its data: complete it now so its frame can be shown.
        self.finish_picture();
        Ok(std::mem::take(&mut self.out))
    }

    fn sequence_header(&mut self, body: &[u8]) {
        let mut b = Bits::new(body);
        let width = b.read(12) as usize;
        let height = b.read(12) as usize;
        b.skip(4 + 4 + 18 + 1 + 10 + 1);
        let mut intra = tables::DEFAULT_INTRA_MATRIX;
        let mut non_intra = tables::DEFAULT_NON_INTRA_MATRIX;
        if b.flag() {
            read_matrix(&mut b, &mut intra);
        }
        if b.flag() {
            read_matrix(&mut b, &mut non_intra);
        }
        if width == 0 || height == 0 || b.overrun() {
            return;
        }
        let keep = self.seq.as_ref().map(|s| (s.progressive, s.mpeg2));
        let changed = self.seq.as_ref().map(|s| (s.width, s.height)) != Some((width, height));
        let (progressive, mpeg2) = keep.unwrap_or((true, false));
        self.seq = Some(Sequence {
            width,
            height,
            mb_width: width.div_ceil(16),
            mb_height: height.div_ceil(16),
            progressive,
            mpeg2,
            intra,
            non_intra,
        });
        if changed {
            let pending = self.flush();
            self.reset();
            self.out = pending;
        }
    }

    fn extension(&mut self, body: &[u8]) -> Result<(), Error> {
        let mut b = Bits::new(body);
        match b.read(4) {
            1 => {
                // Sequence extension.
                b.skip(8);
                let progressive = b.flag();
                let chroma = b.read(2);
                let h_ext = b.read(2) as usize;
                let v_ext = b.read(2) as usize;
                if chroma != 1 {
                    return Err(Error::Unsupported("chroma format other than 4:2:0"));
                }
                if let Some(seq) = self.seq.as_mut() {
                    seq.width |= h_ext << 12;
                    seq.height |= v_ext << 12;
                    seq.progressive = progressive;
                    seq.mpeg2 = true;
                    seq.mb_width = seq.width.div_ceil(16);
                    seq.mb_height = if progressive {
                        seq.height.div_ceil(16)
                    } else {
                        2 * seq.height.div_ceil(32)
                    };
                }
            }
            3 => {
                // Quant matrix extension (4:2:0 uses the luminance matrices for chroma).
                if let Some(seq) = self.seq.as_mut() {
                    if b.flag() {
                        read_matrix(&mut b, &mut seq.intra);
                    }
                    if b.flag() {
                        read_matrix(&mut b, &mut seq.non_intra);
                    }
                }
            }
            8 => {
                // Picture coding extension.
                let p = &mut self.pic;
                p.f_code = [
                    [b.read(4) as u8, b.read(4) as u8],
                    [b.read(4) as u8, b.read(4) as u8],
                ];
                p.intra_dc_precision = b.read(2) as u8;
                p.structure = b.read(2) as u8;
                p.top_field_first = b.flag();
                p.frame_pred_frame_dct = b.flag();
                p.concealment = b.flag();
                p.q_scale_type = b.flag();
                p.intra_vlc_format = b.flag();
                p.alternate_scan = b.flag();
                p.repeat_first_field = b.flag();
                b.skip(1);
                p.progressive_frame = b.flag();
                self.scan = tables::scan_to_raster(p.alternate_scan);
                self.begin_picture();
            }
            _ => {}
        }
        Ok(())
    }

    fn picture_header(&mut self, body: &[u8], pts: i64) -> Result<(), Error> {
        self.finish_picture();
        let mut b = Bits::new(body);
        b.skip(10);
        let coding_type = b.read(3) as u8;
        self.have_picture_header = false;
        if !(I_PIC..=B_PIC).contains(&coding_type) {
            return Ok(());
        }
        // Defaults until the picture coding extension (MPEG-2 always sends one).
        self.pic = Picture {
            coding_type,
            structure: FRAME,
            frame_pred_frame_dct: true,
            progressive_frame: true,
            ..Picture::default()
        };
        self.pending_pts = Some(pts);
        if self.seq.as_ref().is_some_and(|s| !s.mpeg2) {
            return Err(Error::Unsupported("MPEG-1 video"));
        }
        Ok(())
    }
}

fn read_matrix(b: &mut Bits, matrix: &mut [u8; 64]) {
    // Matrices are sent in zigzag order (7.3.1).
    let raster = tables::scan_to_raster(false);
    for n in 0..64 {
        matrix[raster[n] as usize] = b.read(8) as u8;
    }
}

/// (start code value, offset of the byte after it) for every 00 00 01 xx.
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
