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

//! Adding a residual row to the picture: the portable version and the NEON
//! versions for 64-bit and 32-bit ARM, chosen at build time (AddBest).

use super::*;

/// The block add as a registered stage (`kit::BlockAdd`): plain Rust.
pub(crate) struct AddPortable;

impl BlockAdd for AddPortable {
    const ID: &'static str = "add.row.portable";
    const REQUIRES: Features = Features::NONE;
    #[inline(always)]
    fn add_row(line: &mut [u8; 8], residual: &[i32; 8], intra: bool) {
        add_row_portable(line, residual, intra)
    }
}

/// The block add in NEON.
#[cfg(target_arch = "aarch64")]
pub(crate) struct AddNeon;

#[cfg(target_arch = "aarch64")]
impl BlockAdd for AddNeon {
    const ID: &'static str = "add.row.neon";
    const REQUIRES: Features = Features::NEON;
    #[inline(always)]
    fn add_row(line: &mut [u8; 8], residual: &[i32; 8], intra: bool) {
        add_row(line, residual, intra)
    }
}

/// The block add in NEON on 32-bit ARM, as inline assembly (see
/// `mc::McNeon32`): the residual narrowed to 16 bits, the prediction widened
/// and added, and the sum saturated to 0..255, as the AArch64 kernel does.
#[cfg(target_arch = "arm")]
pub(crate) struct AddNeon32;

#[cfg(target_arch = "arm")]
impl BlockAdd for AddNeon32 {
    const ID: &'static str = "add.row.neon32";
    const REQUIRES: Features = Features::NEON;
    #[inline(always)]
    fn add_row(line: &mut [u8; 8], residual: &[i32; 8], intra: bool) {
        // SAFETY: 32 bytes are read from `residual` and 8 read from and written
        // to `line`, exactly their sizes; this kit is chosen only with NEON.
        unsafe {
            if intra {
                core::arch::asm!(
                    ".fpu neon",
                    "vld1.32 {{d0-d3}}, [{r}]",
                    "vmovn.i32 d4, q0",
                    "vmovn.i32 d5, q1",
                    "vqmovun.s16 d4, q2",
                    "vst1.8 {{d4}}, [{l}]",
                    r = in(reg) residual.as_ptr(),
                    l = in(reg) line.as_mut_ptr(),
                    out("d0") _, out("d1") _, out("d2") _, out("d3") _, out("d4") _, out("d5") _,
                    options(nostack, preserves_flags)
                );
            } else {
                core::arch::asm!(
                    ".fpu neon",
                    "vld1.32 {{d0-d3}}, [{r}]",
                    "vld1.8 {{d6}}, [{l}]",
                    "vmovn.i32 d4, q0",
                    "vmovn.i32 d5, q1",
                    "vmovl.u8 q3, d6",
                    "vadd.i16 q2, q2, q3",
                    "vqmovun.s16 d4, q2",
                    "vst1.8 {{d4}}, [{l}]",
                    r = in(reg) residual.as_ptr(),
                    l = in(reg) line.as_mut_ptr(),
                    out("d0") _, out("d1") _, out("d2") _, out("d3") _, out("d4") _, out("d5") _,
                    out("d6") _, out("d7") _,
                    options(nostack, preserves_flags)
                );
            }
        }
    }
}

/// The form chosen at build time before the engine existed.
#[cfg(target_arch = "aarch64")]
pub(crate) type AddBest = AddNeon;

#[cfg(target_arch = "arm")]
pub(crate) type AddBest = AddNeon32;

#[cfg(not(any(target_arch = "aarch64", target_arch = "arm")))]
pub(crate) type AddBest = AddPortable;

/// One row of 7.6.8: the prediction plus the residual, saturated to 0..255
/// (intra: the residual alone). A sample (0..255) plus a residual (-256..255,
/// limited by the inverse DCT) fits in 16 bits.
#[cfg(target_arch = "aarch64")]
#[inline(always)]
pub(super) fn add_row(line: &mut [u8; 8], residual: &[i32; 8], intra: bool) {
    // SAFETY: NEON is part of the AArch64 baseline; the loads and stores are
    // exactly the 8 samples of `line` and the 8 values of `residual`.
    unsafe {
        use std::arch::aarch64::*;
        // The compiler does not vectorise rows of 8 here (measured: 13% of
        // decoding went to this loop as scalar code), so it is written out.
        let r = vcombine_s16(
            vmovn_s32(vld1q_s32(residual.as_ptr())),
            vmovn_s32(vld1q_s32(residual.as_ptr().add(4))),
        );
        let sum = if intra {
            r
        } else {
            vaddq_s16(vreinterpretq_s16_u16(vmovl_u8(vld1_u8(line.as_ptr()))), r)
        };
        vst1_u8(line.as_mut_ptr(), vqmovun_s16(sum));
    }
}

/// `add_row` in plain Rust: the reference the NEON path is tested against.
pub(super) fn add_row_portable(line: &mut [u8; 8], residual: &[i32; 8], intra: bool) {
    for i in 0..8 {
        let base = if intra { 0 } else { line[i] as i32 };
        line[i] = base.wrapping_add(residual[i]).clamp(0, 255) as u8;
    }
}
