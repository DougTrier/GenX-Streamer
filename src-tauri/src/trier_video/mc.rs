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

//! Forming predictions (7.6.4): half-sample interpolation from a reference
//! field or frame, and averaging of two predictions (7.6.7).

use super::kit::{Features, MotionRows};

/// One plane of a reference picture seen as a frame or as one field.
#[derive(Clone, Copy)]
pub(crate) struct View<'a> {
    pub data: &'a [u8],
    /// First sample of the view.
    pub offset: usize,
    /// Distance between the view's lines (twice the width for a field).
    pub stride: usize,
    pub width: usize,
    pub lines: usize,
}

/// Writes a `w` x `h` prediction into `dst` (rows `dst_stride` apart): the
/// block at (`x`, `y`) of `src` moved by the half-sample vector (`mx`, `my`).
/// With `average`, the result is averaged into what `dst` already holds
/// ((a + b)//2), as for bidirectional and dual-prime predictions. Vectors that
/// leave the picture (forbidden, but seen in damaged streams) read the edge.
#[allow(clippy::too_many_arguments)]
pub(crate) fn predict<M: MotionRows>(
    dst: &mut [u8],
    dst_stride: usize,
    w: usize,
    h: usize,
    src: View,
    x: i32,
    y: i32,
    mx: i32,
    my: i32,
    average: bool,
) {
    let ix = x + (mx >> 1); // DIV 2: toward minus infinity
    let iy = y + (my >> 1);
    let hx = (mx & 1) as usize;
    let hy = (my & 1) as usize;
    let max_x = src.width as i32 - 1;
    let max_y = src.lines as i32 - 1;
    let inside = ix >= 0
        && iy >= 0
        && ix + w as i32 + hx as i32 - 1 <= max_x
        && iy + h as i32 + hy as i32 - 1 <= max_y;
    if inside && (w == 16 || w == 8) {
        // The common case, one loop per width, half-sample position and
        // averaging, each compiled with its sizes fixed (NEON on phones).
        let base = src.offset + iy as usize * src.stride + ix as usize;
        let (data, ss) = (src.data, src.stride);
        macro_rules! go {
            ($w:literal) => {
                match (hx, hy, average) {
                    (0, 0, false) => {
                        rows::<M, $w, false, false, false>(dst, dst_stride, h, data, base, ss)
                    }
                    (1, 0, false) => {
                        rows::<M, $w, true, false, false>(dst, dst_stride, h, data, base, ss)
                    }
                    (0, 1, false) => {
                        rows::<M, $w, false, true, false>(dst, dst_stride, h, data, base, ss)
                    }
                    (_, _, false) => {
                        rows::<M, $w, true, true, false>(dst, dst_stride, h, data, base, ss)
                    }
                    (0, 0, true) => {
                        rows::<M, $w, false, false, true>(dst, dst_stride, h, data, base, ss)
                    }
                    (1, 0, true) => {
                        rows::<M, $w, true, false, true>(dst, dst_stride, h, data, base, ss)
                    }
                    (0, 1, true) => {
                        rows::<M, $w, false, true, true>(dst, dst_stride, h, data, base, ss)
                    }
                    (_, _, true) => {
                        rows::<M, $w, true, true, true>(dst, dst_stride, h, data, base, ss)
                    }
                }
            };
        }
        if w == 16 {
            go!(16)
        } else {
            go!(8)
        }
        return;
    }
    let at = |px: i32, py: i32| -> u32 {
        let px = px.clamp(0, max_x) as usize;
        let py = py.clamp(0, max_y) as usize;
        src.data[src.offset + py * src.stride + px] as u32
    };
    for row in 0..h {
        let out = &mut dst[row * dst_stride..row * dst_stride + w];
        if inside {
            // Exact-length rows written as iterator zips: no per-sample bounds
            // checks, so the compiler vectorises them (NEON on phones).
            let base = src.offset + (iy as usize + row) * src.stride + ix as usize;
            let a = &src.data[base..base + w + hx];
            match (hx, hy) {
                // Whole-sample copies of constant width: without the constant the
                // compiler calls the C library's memmove for every 8 or 16 bytes.
                (0, 0) if !average && w == 16 => out[..16].copy_from_slice(&a[..16]),
                (0, 0) if !average && w == 8 => out[..8].copy_from_slice(&a[..8]),
                (0, 0) => store(out, a.iter().copied(), average),
                (1, 0) => store(
                    out,
                    a.iter().zip(&a[1..]).map(|(&p, &q)| half(p, q)),
                    average,
                ),
                (0, 1) => {
                    let b = &src.data[base + src.stride..base + src.stride + w];
                    store(out, a.iter().zip(b).map(|(&p, &q)| half(p, q)), average)
                }
                _ => {
                    let b = &src.data[base + src.stride..base + src.stride + w + 1];
                    let pred = a.iter().zip(&a[1..]).zip(b.iter().zip(&b[1..])).map(
                        |((&p0, &p1), (&q0, &q1))| {
                            ((p0 as u16 + p1 as u16 + q0 as u16 + q1 as u16 + 2) >> 2) as u8
                        },
                    );
                    store(out, pred, average)
                }
            }
        } else {
            let py = iy + row as i32;
            fill(
                out,
                |i| {
                    let px = ix + i as i32;
                    match (hx, hy) {
                        (0, 0) => at(px, py),
                        (1, 0) => (at(px, py) + at(px + 1, py) + 1) >> 1,
                        (0, 1) => (at(px, py) + at(px, py + 1) + 1) >> 1,
                        _ => {
                            (at(px, py) + at(px + 1, py) + at(px, py + 1) + at(px + 1, py + 1) + 2)
                                >> 2
                        }
                    }
                },
                average,
            );
        }
    }
}
/// `h` rows of a `W`-wide prediction lying wholly inside the reference, from
/// `base` (rows `ss` apart) into `dst` (rows `ds` apart): the same arithmetic
/// as the general path, with the half-sample position (HX, HY) and averaging
/// fixed at compile time.
#[inline(always)]
fn rows<M: MotionRows, const W: usize, const HX: bool, const HY: bool, const AVG: bool>(
    dst: &mut [u8],
    ds: usize,
    h: usize,
    src: &[u8],
    base: usize,
    ss: usize,
) {
    M::rows::<W, HX, HY, AVG>(dst, ds, h, src, base, ss)
}

/// Motion compensation rows as a registered stage (`kit::MotionRows`): plain Rust.
pub(crate) struct McPortable;
impl MotionRows for McPortable {
    const ID: &'static str = "mc.rows.portable";
    const REQUIRES: Features = Features::NONE;
    #[inline(always)]
    fn rows<const W: usize, const HX: bool, const HY: bool, const AVG: bool>(
        dst: &mut [u8],
        ds: usize,
        h: usize,
        src: &[u8],
        base: usize,
        ss: usize,
    ) {
        rows_portable::<W, HX, HY, AVG>(dst, ds, h, src, base, ss)
    }
}
/// NEON rows, the block's ranges checked once (plain Rust if they fail).
#[cfg(target_arch = "aarch64")]
pub(crate) struct McNeon;
#[cfg(target_arch = "aarch64")]
impl MotionRows for McNeon {
    const ID: &'static str = "mc.rows.neon";
    const REQUIRES: Features = Features::NEON;
    #[inline(always)]
    fn rows<const W: usize, const HX: bool, const HY: bool, const AVG: bool>(
        dst: &mut [u8],
        ds: usize,
        h: usize,
        src: &[u8],
        base: usize,
        ss: usize,
    ) {
        rows_neon::<W, HX, HY, AVG>(dst, ds, h, src, base, ss)
    }
}
/// NEON rows on 32-bit ARM, in inline assembly: the NEON intrinsics and the
/// `neon` target feature are not stable for 32-bit ARM (Rust 1.96), and
/// whole-program NEON did not vectorise these loops (measured: no gain).
/// The same instructions as the AArch64 kernel, so the same results as the
/// plain code (tested on ARM devices). Chosen only where the CPU has NEON.
#[cfg(target_arch = "arm")]
pub(crate) struct McNeon32;
#[cfg(target_arch = "arm")]
impl MotionRows for McNeon32 {
    const ID: &'static str = "mc.rows.neon32";
    const REQUIRES: Features = Features::NEON;
    #[inline(always)]
    fn rows<const W: usize, const HX: bool, const HY: bool, const AVG: bool>(
        dst: &mut [u8],
        ds: usize,
        h: usize,
        src: &[u8],
        base: usize,
        ss: usize,
    ) {
        if h > 0 {
            // The whole block's reads and writes, checked once.
            let last_read = base + (h - 1 + HY as usize) * ss + W + HX as usize;
            let last_write = (h - 1) * ds + W;
            if last_read <= src.len() && last_write <= dst.len() && (W == 8 || W == 16) {
                for row in 0..h {
                    // SAFETY: every access lies within the ranges just
                    // checked; this kit is chosen only on CPUs with NEON.
                    unsafe {
                        neon32::row::<W, HX, HY, AVG>(
                            dst.as_mut_ptr().add(row * ds),
                            src.as_ptr().add(base + row * ss),
                            ss,
                        )
                    };
                }
                return;
            }
        }
        rows_portable::<W, HX, HY, AVG>(dst, ds, h, src, base, ss)
    }
}

/// The form chosen at build time before the engine existed.
#[cfg(target_arch = "aarch64")]
pub(crate) type Best = McNeon;
#[cfg(target_arch = "arm")]
pub(crate) type Best = McNeon32;
#[cfg(not(any(target_arch = "aarch64", target_arch = "arm")))]
pub(crate) type Best = McPortable;

#[cfg(target_arch = "arm")]
mod neon32 {
    /// One row: `d` gets W samples predicted from `p` (and `p + 1`, `p + ss`,
    /// `p + ss + 1` for half-sample positions), averaged into `d` with AVG.
    /// vrhadd is (a + b + 1) >> 1; vaddl, vadd and vrshrn by 2 are
    /// (a + b + c + d + 2) >> 2: the plain code's arithmetic.
    ///
    /// SAFETY: the row's bytes must be readable at `p` (W + HX, and the same
    /// at `p + ss` with HY) and writable at `d` (W); the CPU must have NEON.
    #[inline(always)]
    pub(super) unsafe fn row<const W: usize, const HX: bool, const HY: bool, const AVG: bool>(
        d: *mut u8,
        p: *const u8,
        ss: usize,
    ) {
        match (W, HX, HY, AVG) {
            (16, false, false, false) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0-d1}}, [{p}]",
                "vst1.8 {{d0-d1}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (16, false, false, true) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0-d1}}, [{p}]",
                "vld1.8 {{d2-d3}}, [{d}]",
                "vrhadd.u8 q0, q0, q1",
                "vst1.8 {{d0-d1}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (16, false, true, false) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0-d1}}, [{p}]",
                "vld1.8 {{d2-d3}}, [{q}]",
                "vrhadd.u8 q0, q0, q1",
                "vst1.8 {{d0-d1}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                q = in(reg) p.add(ss),
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (16, false, true, true) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0-d1}}, [{p}]",
                "vld1.8 {{d2-d3}}, [{q}]",
                "vrhadd.u8 q0, q0, q1",
                "vld1.8 {{d2-d3}}, [{d}]",
                "vrhadd.u8 q0, q0, q1",
                "vst1.8 {{d0-d1}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                q = in(reg) p.add(ss),
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (16, true, false, false) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0-d1}}, [{p}]",
                "vld1.8 {{d2-d3}}, [{p1}]",
                "vrhadd.u8 q0, q0, q1",
                "vst1.8 {{d0-d1}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                p1 = in(reg) p.add(1),
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (16, true, false, true) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0-d1}}, [{p}]",
                "vld1.8 {{d2-d3}}, [{p1}]",
                "vrhadd.u8 q0, q0, q1",
                "vld1.8 {{d2-d3}}, [{d}]",
                "vrhadd.u8 q0, q0, q1",
                "vst1.8 {{d0-d1}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                p1 = in(reg) p.add(1),
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (16, true, true, false) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0-d1}}, [{p}]",
                "vld1.8 {{d2-d3}}, [{p1}]",
                "vld1.8 {{d4-d5}}, [{q}]",
                "vld1.8 {{d6-d7}}, [{q1}]",
                "vaddl.u8 q4, d0, d2",
                "vaddl.u8 q5, d4, d6",
                "vadd.i16 q4, q4, q5",
                "vaddl.u8 q5, d1, d3",
                "vaddl.u8 q6, d5, d7",
                "vadd.i16 q5, q5, q6",
                "vrshrn.i16 d0, q4, #2",
                "vrshrn.i16 d1, q5, #2",
                "vst1.8 {{d0-d1}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                p1 = in(reg) p.add(1),
                q = in(reg) p.add(ss),
                q1 = in(reg) p.add(ss + 1),
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (16, true, true, true) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0-d1}}, [{p}]",
                "vld1.8 {{d2-d3}}, [{p1}]",
                "vld1.8 {{d4-d5}}, [{q}]",
                "vld1.8 {{d6-d7}}, [{q1}]",
                "vaddl.u8 q4, d0, d2",
                "vaddl.u8 q5, d4, d6",
                "vadd.i16 q4, q4, q5",
                "vaddl.u8 q5, d1, d3",
                "vaddl.u8 q6, d5, d7",
                "vadd.i16 q5, q5, q6",
                "vrshrn.i16 d0, q4, #2",
                "vrshrn.i16 d1, q5, #2",
                "vld1.8 {{d2-d3}}, [{d}]",
                "vrhadd.u8 q0, q0, q1",
                "vst1.8 {{d0-d1}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                p1 = in(reg) p.add(1),
                q = in(reg) p.add(ss),
                q1 = in(reg) p.add(ss + 1),
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (8, false, false, false) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0}}, [{p}]",
                "vst1.8 {{d0}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (8, false, false, true) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0}}, [{p}]",
                "vld1.8 {{d1}}, [{d}]",
                "vrhadd.u8 d0, d0, d1",
                "vst1.8 {{d0}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (8, false, true, false) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0}}, [{p}]",
                "vld1.8 {{d1}}, [{q}]",
                "vrhadd.u8 d0, d0, d1",
                "vst1.8 {{d0}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                q = in(reg) p.add(ss),
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (8, false, true, true) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0}}, [{p}]",
                "vld1.8 {{d1}}, [{q}]",
                "vrhadd.u8 d0, d0, d1",
                "vld1.8 {{d1}}, [{d}]",
                "vrhadd.u8 d0, d0, d1",
                "vst1.8 {{d0}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                q = in(reg) p.add(ss),
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (8, true, false, false) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0}}, [{p}]",
                "vld1.8 {{d1}}, [{p1}]",
                "vrhadd.u8 d0, d0, d1",
                "vst1.8 {{d0}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                p1 = in(reg) p.add(1),
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (8, true, false, true) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0}}, [{p}]",
                "vld1.8 {{d1}}, [{p1}]",
                "vrhadd.u8 d0, d0, d1",
                "vld1.8 {{d1}}, [{d}]",
                "vrhadd.u8 d0, d0, d1",
                "vst1.8 {{d0}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                p1 = in(reg) p.add(1),
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (8, true, true, false) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0}}, [{p}]",
                "vld1.8 {{d1}}, [{p1}]",
                "vld1.8 {{d2}}, [{q}]",
                "vld1.8 {{d3}}, [{q1}]",
                "vaddl.u8 q2, d0, d1",
                "vaddl.u8 q3, d2, d3",
                "vadd.i16 q2, q2, q3",
                "vrshrn.i16 d0, q2, #2",
                "vst1.8 {{d0}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                p1 = in(reg) p.add(1),
                q = in(reg) p.add(ss),
                q1 = in(reg) p.add(ss + 1),
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            (8, true, true, true) => core::arch::asm!(
                ".fpu neon",
                "vld1.8 {{d0}}, [{p}]",
                "vld1.8 {{d1}}, [{p1}]",
                "vld1.8 {{d2}}, [{q}]",
                "vld1.8 {{d3}}, [{q1}]",
                "vaddl.u8 q2, d0, d1",
                "vaddl.u8 q3, d2, d3",
                "vadd.i16 q2, q2, q3",
                "vrshrn.i16 d0, q2, #2",
                "vld1.8 {{d1}}, [{d}]",
                "vrhadd.u8 d0, d0, d1",
                "vst1.8 {{d0}}, [{d}]",
                p = in(reg) p,
                d = in(reg) d,
                p1 = in(reg) p.add(1),
                q = in(reg) p.add(ss),
                q1 = in(reg) p.add(ss + 1),
                out("d0") _,
                out("d1") _,
                out("d2") _,
                out("d3") _,
                out("d4") _,
                out("d5") _,
                out("d6") _,
                out("d7") _,
                out("d8") _,
                out("d9") _,
                out("d10") _,
                out("d11") _,
                out("d12") _,
                out("d13") _,
                options(nostack, preserves_flags)
            ),
            _ => unreachable!("widths 8 and 16 only"),
        }
    }
}

#[cfg(target_arch = "aarch64")]
#[inline(always)]
fn rows_neon<const W: usize, const HX: bool, const HY: bool, const AVG: bool>(
    dst: &mut [u8],
    ds: usize,
    h: usize,
    src: &[u8],
    base: usize,
    ss: usize,
) {
    if h > 0 {
        // The whole block's reads and writes, checked once instead of per row.
        let last_read = base + (h - 1 + HY as usize) * ss + W + HX as usize;
        let last_write = (h - 1) * ds + W;
        if last_read <= src.len() && last_write <= dst.len() {
            // SAFETY: every access of the kernel lies within the ranges just
            // checked; NEON is part of the AArch64 baseline.
            unsafe {
                neon::rows::<W, HX, HY, AVG>(dst.as_mut_ptr(), ds, h, src.as_ptr().add(base), ss)
            };
            return;
        }
    }
    rows_portable::<W, HX, HY, AVG>(dst, ds, h, src, base, ss)
}
/// `rows` in plain Rust: the reference the NEON kernel is tested against.
#[inline(always)]
fn rows_portable<const W: usize, const HX: bool, const HY: bool, const AVG: bool>(
    dst: &mut [u8],
    ds: usize,
    h: usize,
    src: &[u8],
    base: usize,
    ss: usize,
) {
    let n = W + HX as usize;
    for row in 0..h {
        let s = base + row * ss;
        let a = &src[s..s + n];
        let out = &mut dst[row * ds..row * ds + W];
        // Exact-length zips (and a plain copy): the forms the compiler turns
        // into vector code; indexing by position here stayed byte by byte.
        match (HX, HY) {
            (false, false) if !AVG => out.copy_from_slice(a),
            (false, false) => put::<AVG>(out, a.iter().copied()),
            (true, false) => put::<AVG>(out, a.iter().zip(&a[1..]).map(|(&p, &q)| half(p, q))),
            (false, true) => {
                let b = &src[s + ss..s + ss + W];
                put::<AVG>(out, a.iter().zip(b).map(|(&p, &q)| half(p, q)))
            }
            (true, true) => {
                let b = &src[s + ss..s + ss + n];
                put::<AVG>(
                    out,
                    a.iter().zip(&a[1..]).zip(b.iter().zip(&b[1..])).map(
                        |((&p0, &p1), (&q0, &q1))| {
                            ((p0 as u16 + p1 as u16 + q0 as u16 + q1 as u16 + 2) >> 2) as u8
                        },
                    ),
                )
            }
        }
    }
}
#[inline(always)]
fn put<const AVG: bool>(out: &mut [u8], pred: impl Iterator<Item = u8>) {
    if AVG {
        for (o, p) in out.iter_mut().zip(pred) {
            *o = half(*o, p);
        }
    } else {
        for (o, p) in out.iter_mut().zip(pred) {
            *o = p;
        }
    }
}

/// The prediction rows in NEON, one register per row: the same arithmetic as
/// `rows_portable` (vrhadd is (a + b + 1) >> 1; vrshrn by 2 is (sum + 2) >> 2),
/// so the results are identical (tested). The compiled iterator form spent
/// about 1,370 instructions per macroblock on per-row slicing and checks.
#[cfg(target_arch = "aarch64")]
mod neon {
    use std::arch::aarch64::*;

    /// SAFETY: `src` must be readable for `(h - 1 + HY) * ss + W + HX` bytes and
    /// `dst` writable for `(h - 1) * ds + W` bytes.
    #[inline(always)]
    pub(super) unsafe fn rows<const W: usize, const HX: bool, const HY: bool, const AVG: bool>(
        dst: *mut u8,
        ds: usize,
        h: usize,
        src: *const u8,
        ss: usize,
    ) {
        for row in 0..h {
            let p = src.add(row * ss);
            let d = dst.add(row * ds);
            if W == 16 {
                let a = vld1q_u8(p);
                let pred = match (HX, HY) {
                    (false, false) => a,
                    (true, false) => vrhaddq_u8(a, vld1q_u8(p.add(1))),
                    (false, true) => vrhaddq_u8(a, vld1q_u8(p.add(ss))),
                    (true, true) => {
                        let (a1, b, b1) = (
                            vld1q_u8(p.add(1)),
                            vld1q_u8(p.add(ss)),
                            vld1q_u8(p.add(ss + 1)),
                        );
                        let lo = vaddq_u16(
                            vaddl_u8(vget_low_u8(a), vget_low_u8(a1)),
                            vaddl_u8(vget_low_u8(b), vget_low_u8(b1)),
                        );
                        let hi = vaddq_u16(vaddl_high_u8(a, a1), vaddl_high_u8(b, b1));
                        vcombine_u8(vrshrn_n_u16::<2>(lo), vrshrn_n_u16::<2>(hi))
                    }
                };
                let out = if AVG {
                    vrhaddq_u8(vld1q_u8(d), pred)
                } else {
                    pred
                };
                vst1q_u8(d, out);
            } else {
                let a = vld1_u8(p);
                let pred = match (HX, HY) {
                    (false, false) => a,
                    (true, false) => vrhadd_u8(a, vld1_u8(p.add(1))),
                    (false, true) => vrhadd_u8(a, vld1_u8(p.add(ss))),
                    (true, true) => {
                        let sum = vaddq_u16(
                            vaddl_u8(a, vld1_u8(p.add(1))),
                            vaddl_u8(vld1_u8(p.add(ss)), vld1_u8(p.add(ss + 1))),
                        );
                        vrshrn_n_u16::<2>(sum)
                    }
                };
                let out = if AVG {
                    vrhadd_u8(vld1_u8(d), pred)
                } else {
                    pred
                };
                vst1_u8(d, out);
            }
        }
    }
}

/// (a + b + 1) // 2: a half-sample position, or the average of two predictions.
#[inline(always)]
fn half(a: u8, b: u8) -> u8 {
    ((a as u16 + b as u16 + 1) >> 1) as u8
}
#[inline(always)]
fn store(out: &mut [u8], pred: impl Iterator<Item = u8>, average: bool) {
    if average {
        for (o, p) in out.iter_mut().zip(pred) {
            *o = half(*o, p);
        }
    } else {
        for (o, p) in out.iter_mut().zip(pred) {
            *o = p;
        }
    }
}
#[inline]
fn fill(out: &mut [u8], value: impl Fn(usize) -> u32, average: bool) {
    if average {
        for (i, o) in out.iter_mut().enumerate() {
            *o = ((*o as u32 + value(i) + 1) >> 1) as u8;
        }
    } else {
        for (i, o) in out.iter_mut().enumerate() {
            *o = value(i) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The row kernel (NEON on ARM64) gives exactly the plain code's samples,
    /// for both widths, every half-sample position, with and without averaging.
    #[test]
    fn row_kernel_matches_plain_code() {
        let mut seed = 0x1234_5678_9abc_def1u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let src: Vec<u8> = (0..64 * 40).map(|_| next() as u8).collect();
        macro_rules! check {
            ($w:literal, $hx:literal, $hy:literal, $avg:literal) => {
                for case in 0..50 {
                    let h = [16, 8, 4][case % 3];
                    let base = (next() % 200) as usize;
                    let start: Vec<u8> = (0..48 * 17).map(|_| next() as u8).collect();
                    let (mut fast, mut plain) = (start.clone(), start);
                    Best::rows::<$w, $hx, $hy, $avg>(&mut fast, 48, h, &src, base, 64);
                    rows_portable::<$w, $hx, $hy, $avg>(&mut plain, 48, h, &src, base, 64);
                    assert_eq!(fast, plain, "W {} hx {} hy {} avg {}", $w, $hx, $hy, $avg);
                }
            };
        }
        check!(16, false, false, false);
        check!(16, true, false, false);
        check!(16, false, true, false);
        check!(16, true, true, false);
        check!(16, false, false, true);
        check!(16, true, false, true);
        check!(16, false, true, true);
        check!(16, true, true, true);
        check!(8, false, false, false);
        check!(8, true, false, false);
        check!(8, false, true, false);
        check!(8, true, true, false);
        check!(8, false, false, true);
        check!(8, true, false, true);
        check!(8, false, true, true);
        check!(8, true, true, true);
    }
    #[test]
    fn half_samples_round_up_and_vectors_floor() {
        // 4x4 plane with distinct values.
        let data: Vec<u8> = (0..16).map(|v| v * 10).collect();
        let view = View {
            data: &data,
            offset: 0,
            stride: 4,
            width: 4,
            lines: 4,
        };
        let mut out = [0u8; 4];
        predict::<Best>(&mut out, 2, 2, 2, view, 1, 1, 0, 0, false);
        assert_eq!(out, [50, 60, 90, 100]);
        // Half sample right: (50 + 60 + 1) / 2 = 55.
        predict::<Best>(&mut out, 2, 2, 2, view, 1, 1, 1, 0, false);
        assert_eq!(out[0], 55);
        // Negative half vector: -1 DIV 2 = -1, so between x = 0 and x = 1.
        predict::<Best>(&mut out, 2, 2, 2, view, 1, 1, -1, 0, false);
        assert_eq!(out[0], 45);
        // Both halves: (50 + 60 + 90 + 100 + 2) / 4 = 75.
        predict::<Best>(&mut out, 2, 2, 2, view, 1, 1, 1, 1, false);
        assert_eq!(out[0], 75);
        // Averaging into an existing prediction: (75 + 50 + 1) / 2 = 63.
        predict::<Best>(&mut out, 2, 2, 2, view, 1, 1, 0, 0, true);
        assert_eq!(out[0], 63);
        // A field view: odd lines only.
        let field = View {
            data: &data,
            offset: 4,
            stride: 8,
            width: 4,
            lines: 2,
        };
        predict::<Best>(&mut out, 2, 2, 2, field, 0, 0, 0, 0, false);
        assert_eq!(out, [40, 50, 120, 130]);
    }
}
