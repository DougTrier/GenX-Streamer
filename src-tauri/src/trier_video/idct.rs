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

//! 8x8 inverse DCT (H.262 Annex A): f(x,y) = 2/N sum_u sum_v C(u)C(v) F(u,v)
//! cos((2x+1)u pi/2N) cos((2y+1)v pi/2N), N = 8, C(0) = 1/sqrt(2). Evaluated
//! separably in single precision, rounded to the nearest integer and limited
//! to [-256, 255]; this meets the IEEE 1180 accuracy Annex A requires (tested).
use std::sync::OnceLock;

use super::kit::{Contract, Features, InverseDct};
fn basis() -> &'static [[f32; 8]; 8] {
    static B: OnceLock<[[f32; 8]; 8]> = OnceLock::new();
    B.get_or_init(|| {
        let mut m = [[0f32; 8]; 8];
        for (x, row) in m.iter_mut().enumerate() {
            for (u, value) in row.iter_mut().enumerate() {
                let c = if u == 0 {
                    std::f64::consts::FRAC_1_SQRT_2
                } else {
                    1.0
                };
                let angle = (2 * x + 1) as f64 * u as f64 * std::f64::consts::PI / 16.0;
                *value = (c / 2.0 * angle.cos()) as f32;
            }
        }
        m
    })
}

/// In place: `block` holds F[v][u] at [v * 8 + u]; returns f[y][x] at [y * 8 + x].
pub(crate) fn inverse(block: &mut [i32; 64]) {
    // Only the DC coefficient: a flat block (very common).
    if block[1..].iter().all(|&c| c == 0) {
        let value = round_limit(block[0] as f32 / 8.0);
        block.fill(value);
        return;
    }
    let m = basis();
    // Rows: g[v][x] = sum_u M[x][u] F[v][u].
    let mut rows = [0f32; 64];
    for v in 0..8 {
        let f = &block[v * 8..v * 8 + 8];
        if f.iter().all(|&c| c == 0) {
            continue;
        }
        for x in 0..8 {
            let mut sum = 0f32;
            for u in 0..8 {
                sum += m[x][u] * f[u] as f32;
            }
            rows[v * 8 + x] = sum;
        }
    }
    // Columns: f[y][x] = sum_v M[y][v] g[v][x].
    for y in 0..8 {
        for x in 0..8 {
            let mut sum = 0f32;
            for v in 0..8 {
                sum += m[y][v] * rows[v * 8 + x];
            }
            block[y * 8 + x] = round_limit(sum);
        }
    }
}
/// `inverse` for a block whose coded coefficients all lie within rows and
/// columns 0..=`reach`, apart from coefficient 63, which mismatch control
/// (7.4.4) may have set: only that corner is transformed, and coefficient 63's
/// term is added last. Every output is the same products summed in the same
/// order as `inverse`; the skipped terms are exact zeros (adding +0 or -0 to a
/// sum that starts at +0 never changes it), so results are bit-identical
/// (tested).
/// The dense blocks use lane form `L` (each registered stage below fixes it).
#[inline(always)]
fn within<L: Lane8>(block: &mut [i32; 64], reach: usize) {
    match reach {
        // Only DC and coefficient 63 zero: `inverse` takes its flat shortcut.
        0 if block[63] == 0 => inverse(block),
        0 => corner::<1>(block),
        1 => corner::<2>(block),
        2 | 3 => corner::<4>(block),
        _ => dense::<L>(block),
    }
}

/// The inverse DCT as a registered stage (`kit::InverseDct`): the corner
/// paths plus the even/odd dense form in plain Rust, NEON or SSE2. The lane
/// forms do the same operations in the same order, so all three give the
/// same results (tested), and are bit-exact against each other.
pub(crate) struct IdctPlain;
impl InverseDct for IdctPlain {
    const ID: &'static str = "idct.evenodd.plain";
    const REQUIRES: Features = Features::NONE;
    const CONTRACT: Contract = Contract::BitExact;
    #[inline(always)]
    fn inverse_within(block: &mut [i32; 64], reach: usize) {
        within::<Plain>(block, reach)
    }
}
#[cfg(target_arch = "aarch64")]
pub(crate) struct IdctNeon;
#[cfg(target_arch = "aarch64")]
impl InverseDct for IdctNeon {
    const ID: &'static str = "idct.evenodd.neon";
    const REQUIRES: Features = Features::NEON;
    const CONTRACT: Contract = Contract::BitExact;
    #[inline(always)]
    fn inverse_within(block: &mut [i32; 64], reach: usize) {
        within::<neon::Neon>(block, reach)
    }
}
#[cfg(target_arch = "x86_64")]
pub(crate) struct IdctSse2;
#[cfg(target_arch = "x86_64")]
impl InverseDct for IdctSse2 {
    const ID: &'static str = "idct.evenodd.sse2";
    const REQUIRES: Features = Features::SSE2;
    const CONTRACT: Contract = Contract::BitExact;
    #[inline(always)]
    fn inverse_within(block: &mut [i32; 64], reach: usize) {
        within::<sse::Sse>(block, reach)
    }
}
/// The form chosen at build time before the engine existed.
/// 32-bit ARM: the corner paths (reach 0 to 3: most blocks of P and B
/// pictures) in NEON inline assembly, the same products summed in the same
/// order as `corner` and rounded as `round_half_away`, so bit-identical with
/// `IdctPlain` (tested on ARM devices); dense blocks as `IdctPlain`.
#[cfg(target_arch = "arm")]
pub(crate) struct IdctNeon32;
#[cfg(target_arch = "arm")]
impl InverseDct for IdctNeon32 {
    const ID: &'static str = "idct.corner-neon32.evenodd.plain";
    const REQUIRES: Features = Features::NEON;
    const CONTRACT: Contract = Contract::BitExact;
    #[inline(always)]
    fn inverse_within(block: &mut [i32; 64], reach: usize) {
        match reach {
            0 if block[63] == 0 => inverse(block),
            0 => neon32::corner::<1>(block),
            1 => neon32::corner::<2>(block),
            2 | 3 => neon32::corner::<4>(block),
            _ => dense::<Plain>(block),
        }
    }
}

#[cfg(target_arch = "aarch64")]
pub(crate) type Best = IdctNeon;
#[cfg(target_arch = "x86_64")]
pub(crate) type Best = IdctSse2;
#[cfg(target_arch = "arm")]
pub(crate) type Best = IdctNeon32;
#[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64", target_arch = "arm")))]
pub(crate) type Best = IdctPlain;

/// The basis transposed: column u of M as 8 consecutive values (the vector
/// the corner rows' pass scales by F[v][u]).
#[cfg(target_arch = "arm")]
fn basis_t() -> &'static [[f32; 8]; 8] {
    static T: OnceLock<[[f32; 8]; 8]> = OnceLock::new();
    T.get_or_init(|| {
        let m = basis();
        std::array::from_fn(|u| std::array::from_fn(|x| m[x][u]))
    })
}

#[cfg(target_arch = "arm")]
mod neon32 {
    use super::{basis, basis_t, round_limit};

    /// `super::corner` with its two passes in NEON (32-bit ARM inline
    /// assembly; the intrinsics are not stable there). Each pass is, per
    /// output vector of 8 lanes, a sum of scalar x vector products taken in
    /// the scalar code's order, multiply then add (never fused); the first
    /// product starts the sum, which the scalar code's `0 + p` equals but for
    /// the sign of a zero, which rounding erases. NEON flushes subnormals to
    /// zero; the transform's products are never that small.
    #[inline(always)]
    pub(super) fn corner<const N: usize>(block: &mut [i32; 64]) {
        let last = block[63] as f32;
        let flat =
            last == 0.0 && (0..N).all(|v| (0..N).all(|u| (v | u) == 0 || block[v * 8 + u] == 0));
        if flat {
            let value = round_limit(block[0] as f32 / 8.0);
            block.fill(value);
            return;
        }
        let m = basis();
        let mt = basis_t();
        // Rows: g[v] = sum_u F[v][u] * column u, for the first N rows (zero
        // rows stay zero, as in the scalar code); row 7 last: F[7][7] * column 7.
        let mut rows = [[0f32; 8]; 5];
        for v in 0..N {
            let f: [f32; N] = std::array::from_fn(|u| block[v * 8 + u] as f32);
            if f.iter().all(|&c| c == 0.0) {
                continue;
            }
            // SAFETY: N vectors of 8 floats from `mt`, N scalars from `f`,
            // 8 floats written to `rows[v]`; N >= 1.
            unsafe {
                accumulate(
                    rows[v].as_mut_ptr(),
                    mt.as_ptr() as *const f32,
                    f.as_ptr(),
                    N,
                )
            };
        }
        let terms = if last != 0.0 {
            rows[N] = std::array::from_fn(|x| m[x][7] * last);
            N + 1
        } else {
            N
        };
        // Columns: f[y] = sum_v M[y][v] * g[v], v in order, row 7 last;
        // rounded half away from zero and limited to [-256, 255].
        for y in 0..8 {
            let mut c = [0f32; 5];
            c[..N].copy_from_slice(&m[y][..N]);
            c[N] = m[y][7];
            // SAFETY: `terms` vectors from `rows`, `terms` scalars from `c`,
            // 8 integers written to the block's row y.
            unsafe {
                accumulate_round(
                    block.as_mut_ptr().add(y * 8),
                    rows.as_ptr() as *const f32,
                    c.as_ptr(),
                    terms,
                )
            };
        }
    }

    /// out[0..8] = sum over i < n of s[i] * v[i][0..8], in order.
    /// SAFETY: v readable for 8n floats, s for n, out writable for 8; n >= 1.
    #[inline(always)]
    unsafe fn accumulate(out: *mut f32, v: *const f32, s: *const f32, n: usize) {
        core::arch::asm!(
            ".fpu neon",
            "vld1.32 {{d4-d7}}, [{v}]!",
            "vld1.32 {{d8[0]}}, [{s}]!",
            "vmul.f32 q0, q2, d8[0]",
            "vmul.f32 q1, q3, d8[0]",
            "subs {n}, {n}, #1",
            "beq 3f",
            "2:",
            "vld1.32 {{d4-d7}}, [{v}]!",
            "vld1.32 {{d8[0]}}, [{s}]!",
            "vmul.f32 q2, q2, d8[0]",
            "vmul.f32 q3, q3, d8[0]",
            "vadd.f32 q0, q0, q2",
            "vadd.f32 q1, q1, q3",
            "subs {n}, {n}, #1",
            "bne 2b",
            "3:",
            "vst1.32 {{d0-d3}}, [{out}]",
            v = inout(reg) v => _,
            s = inout(reg) s => _,
            n = inout(reg) n => _,
            out = in(reg) out,
            out("d0") _, out("d1") _, out("d2") _, out("d3") _, out("d4") _, out("d5") _,
            out("d6") _, out("d7") _, out("d8") _,
            options(nostack)
        );
    }

    /// `accumulate`, then each lane rounded half away from zero (truncate;
    /// one step away from zero when the exact remainder is at least a half)
    /// and limited to [-256, 255], as `round_limit`, into 8 integers.
    /// SAFETY: as `accumulate`, with `out` writable for 8 i32.
    #[inline(always)]
    unsafe fn accumulate_round(out: *mut i32, v: *const f32, s: *const f32, n: usize) {
        core::arch::asm!(
            ".fpu neon",
            "vld1.32 {{d4-d7}}, [{v}]!",
            "vld1.32 {{d8[0]}}, [{s}]!",
            "vmul.f32 q0, q2, d8[0]",
            "vmul.f32 q1, q3, d8[0]",
            "subs {n}, {n}, #1",
            "beq 3f",
            "2:",
            "vld1.32 {{d4-d7}}, [{v}]!",
            "vld1.32 {{d8[0]}}, [{s}]!",
            "vmul.f32 q2, q2, d8[0]",
            "vmul.f32 q3, q3, d8[0]",
            "vadd.f32 q0, q0, q2",
            "vadd.f32 q1, q1, q3",
            "subs {n}, {n}, #1",
            "bne 2b",
            "3:",
            // t = trunc(x); rest = x - t (exact).
            "vcvt.s32.f32 q2, q0",
            "vcvt.s32.f32 q3, q1",
            "vcvt.f32.s32 q4, q2",
            "vcvt.f32.s32 q5, q3",
            "vsub.f32 q4, q0, q4",
            "vsub.f32 q5, q1, q5",
            // rest >= 0.5: t + 1 (the mask is -1).
            "vmov.f32 q6, #0.5",
            "vcge.f32 q7, q4, q6",
            "vsub.i32 q2, q2, q7",
            "vcge.f32 q7, q5, q6",
            "vsub.i32 q3, q3, q7",
            // rest <= -0.5: t - 1.
            "vneg.f32 q6, q6",
            "vcge.f32 q7, q6, q4",
            "vadd.i32 q2, q2, q7",
            "vcge.f32 q7, q6, q5",
            "vadd.i32 q3, q3, q7",
            // Limit to [-256, 255].
            "vmov.i32 q6, #255",
            "vmin.s32 q2, q2, q6",
            "vmin.s32 q3, q3, q6",
            "vmvn.i32 q6, #255",
            "vmax.s32 q2, q2, q6",
            "vmax.s32 q3, q3, q6",
            "vst1.32 {{d4-d7}}, [{out}]",
            v = inout(reg) v => _,
            s = inout(reg) s => _,
            n = inout(reg) n => _,
            out = in(reg) out,
            out("d0") _, out("d1") _, out("d2") _, out("d3") _, out("d4") _, out("d5") _,
            out("d6") _, out("d7") _, out("d8") _, out("d9") _, out("d10") _, out("d11") _,
            out("d12") _, out("d13") _, out("d14") _, out("d15") _,
            options(nostack)
        );
    }
}

/// Blocks reaching row or column 4 or beyond (nearly every block of an I
/// picture): the even/odd 8-point transform, eight lanes at a time in vector
/// registers. 22 multiplications per 8 points instead of 64. Each lane does
/// the same single-precision operations in the same order on every platform
/// (no fused multiply-add), so NEON, SSE2 and plain code give identical
/// results (tested), and the output is bit-identical across devices.
// Inlined into each kit on x86-64 only: there, kits sharing one out-of-line
// copy cost 2-3% of cycles (one kit had inlined it as its only caller); on
// AArch64 inlining it cost 13% and the out-of-line copy is kept (milestone 2,
// docs/trier-mpeg-video.md).
#[cfg_attr(target_arch = "x86_64", inline(always))]
fn dense<L: Lane8>(block: &mut [i32; 64]) {
    if block[1..].iter().all(|&c| c == 0) {
        // Only the DC coefficient after all: `inverse`'s flat shortcut.
        let value = round_limit(block[0] as f32 / 8.0);
        block.fill(value);
        return;
    }
    let k = even_odd();
    // Along v, for all u at once: g[y] = sum_v M[y][v] F[v].
    let x: [L; 8] = std::array::from_fn(|v| L::from_i32(&block[v * 8..v * 8 + 8]));
    let g = idct8(x, k);
    // Along u: transpose, transform, transpose back.
    let f = transpose(idct8(transpose(g), k));
    for (y, row) in f.iter().enumerate() {
        row.round_into(&mut block[y * 8..y * 8 + 8]);
    }
}
/// x[n] = sum_k M[n][k] X[k] by the cosines' symmetry: cos((2(7-n)+1)k pi/16)
/// = (-1)^k cos((2n+1)k pi/16), so x[n] = E[n] + O[n] and x[7-n] = E[n] - O[n],
/// E over even k, O over odd k. In E: M[n][0] = a and M[n][4] = +a, -a, -a, +a;
/// M[n][2] = p, q, -q, -p and M[n][6] = q, -p, p, -q.
#[inline(always)]
fn idct8<L: Lane8>(x: [L; 8], k: &EvenOdd) -> [L; 8] {
    let ee0 = x[0].add(x[4]).mul(k.a);
    let ee1 = x[0].sub(x[4]).mul(k.a);
    let eo0 = x[2].mul(k.p).add(x[6].mul(k.q));
    let eo1 = x[2].mul(k.q).sub(x[6].mul(k.p));
    let e = [ee0.add(eo0), ee1.add(eo1), ee1.sub(eo1), ee0.sub(eo0)];
    let o: [L; 4] = std::array::from_fn(|n| {
        let c = &k.odd[n];
        x[1].mul(c[0])
            .add(x[3].mul(c[1]))
            .add(x[5].mul(c[2]))
            .add(x[7].mul(c[3]))
    });
    [
        e[0].add(o[0]),
        e[1].add(o[1]),
        e[2].add(o[2]),
        e[3].add(o[3]),
        e[3].sub(o[3]),
        e[2].sub(o[2]),
        e[1].sub(o[1]),
        e[0].sub(o[0]),
    ]
}
#[inline(always)]
fn transpose<L: Lane8>(rows: [L; 8]) -> [L; 8] {
    let mut m = [[0f32; 8]; 8];
    for (row, r) in m.iter_mut().zip(&rows) {
        r.store(row);
    }
    std::array::from_fn(|c| L::load(&std::array::from_fn(|r| m[r][c])))
}
/// The 8-point transform's constants, from the same cosines as `basis()`.
struct EvenOdd {
    /// 1 / (2 sqrt 2) = M[n][0] = |M[n][4]|.
    a: f32,
    /// cos(pi/8) / 2 and cos(3pi/8) / 2.
    p: f32,
    q: f32,
    /// M[n][2j + 1] = cos((2n + 1)(2j + 1) pi / 16) / 2, n and j in 0..4.
    odd: [[f32; 4]; 4],
}
fn even_odd() -> &'static EvenOdd {
    static E: OnceLock<EvenOdd> = OnceLock::new();
    E.get_or_init(|| {
        let half_cos = |k: f64| ((k * std::f64::consts::PI / 16.0).cos() / 2.0) as f32;
        EvenOdd {
            a: (std::f64::consts::FRAC_1_SQRT_2 / 2.0) as f32,
            p: half_cos(2.0),
            q: half_cos(6.0),
            odd: std::array::from_fn(|n| {
                std::array::from_fn(|j| half_cos(((2 * n + 1) * (2 * j + 1)) as f64))
            }),
        }
    })
}

/// Eight single-precision lanes: one IEEE add, subtract or multiply per lane.
trait Lane8: Copy {
    fn load(v: &[f32; 8]) -> Self;
    fn store(self, out: &mut [f32; 8]);
    fn add(self, other: Self) -> Self;
    fn sub(self, other: Self) -> Self;
    fn mul(self, c: f32) -> Self;
    fn from_i32(v: &[i32]) -> Self {
        Self::load(&std::array::from_fn(|i| v[i] as f32))
    }
    /// round_limit of each lane into `out`.
    fn round_into(self, out: &mut [i32]) {
        let mut v = [0f32; 8];
        self.store(&mut v);
        for (o, x) in out.iter_mut().zip(v) {
            *o = round_limit(x);
        }
    }
}
/// The plain form: the reference the vector forms are tested against (and
/// the form used where neither NEON nor SSE2 is available).
#[derive(Clone, Copy)]
#[cfg_attr(any(target_arch = "aarch64", target_arch = "x86_64"), allow(dead_code))]
struct Plain([f32; 8]);
impl Lane8 for Plain {
    #[inline(always)]
    fn load(v: &[f32; 8]) -> Self {
        Plain(*v)
    }
    #[inline(always)]
    fn store(self, out: &mut [f32; 8]) {
        *out = self.0;
    }
    #[inline(always)]
    fn add(self, o: Self) -> Self {
        Plain(std::array::from_fn(|i| self.0[i] + o.0[i]))
    }
    #[inline(always)]
    fn sub(self, o: Self) -> Self {
        Plain(std::array::from_fn(|i| self.0[i] - o.0[i]))
    }
    #[inline(always)]
    fn mul(self, c: f32) -> Self {
        Plain(std::array::from_fn(|i| self.0[i] * c))
    }
}
#[cfg(all(test, target_arch = "aarch64"))]
type Simd = neon::Neon;
#[cfg(all(test, target_arch = "x86_64"))]
type Simd = sse::Sse;
#[cfg(all(test, not(any(target_arch = "aarch64", target_arch = "x86_64"))))]
/// The lane form of `Best`, for the tests.
type Simd = Plain;

// SAFETY (both modules): NEON is part of the AArch64 baseline and SSE2 of the
// x86-64 baseline; every load and store is of exactly 8 floats or 8 integers
// inside the arrays and slices passed in.
#[cfg(target_arch = "aarch64")]
mod neon {
    use super::{round_limit, Lane8};
    use std::arch::aarch64::*;
    #[derive(Clone, Copy)]
    pub(super) struct Neon(float32x4_t, float32x4_t);
    impl Lane8 for Neon {
        #[inline(always)]
        fn load(v: &[f32; 8]) -> Self {
            unsafe { Neon(vld1q_f32(v.as_ptr()), vld1q_f32(v.as_ptr().add(4))) }
        }
        #[inline(always)]
        fn store(self, out: &mut [f32; 8]) {
            unsafe {
                vst1q_f32(out.as_mut_ptr(), self.0);
                vst1q_f32(out.as_mut_ptr().add(4), self.1);
            }
        }
        #[inline(always)]
        fn add(self, o: Self) -> Self {
            unsafe { Neon(vaddq_f32(self.0, o.0), vaddq_f32(self.1, o.1)) }
        }
        #[inline(always)]
        fn sub(self, o: Self) -> Self {
            unsafe { Neon(vsubq_f32(self.0, o.0), vsubq_f32(self.1, o.1)) }
        }
        #[inline(always)]
        fn mul(self, c: f32) -> Self {
            unsafe { Neon(vmulq_n_f32(self.0, c), vmulq_n_f32(self.1, c)) }
        }
        #[inline(always)]
        fn from_i32(v: &[i32]) -> Self {
            assert!(v.len() >= 8);
            unsafe {
                Neon(
                    vcvtq_f32_s32(vld1q_s32(v.as_ptr())),
                    vcvtq_f32_s32(vld1q_s32(v.as_ptr().add(4))),
                )
            }
        }
        /// vcvtaq rounds half away from zero, as f32::round in `round_limit`.
        #[inline(always)]
        fn round_into(self, out: &mut [i32]) {
            assert!(out.len() >= 8);
            let _ = round_limit;
            unsafe {
                let (low, high) = (vdupq_n_s32(-256), vdupq_n_s32(255));
                let a = vminq_s32(vmaxq_s32(vcvtaq_s32_f32(self.0), low), high);
                let b = vminq_s32(vmaxq_s32(vcvtaq_s32_f32(self.1), low), high);
                vst1q_s32(out.as_mut_ptr(), a);
                vst1q_s32(out.as_mut_ptr().add(4), b);
            }
        }
    }
}
#[cfg(target_arch = "x86_64")]
mod sse {
    use super::Lane8;
    use std::arch::x86_64::*;
    #[derive(Clone, Copy)]
    pub(super) struct Sse(__m128, __m128);
    impl Lane8 for Sse {
        #[inline(always)]
        fn load(v: &[f32; 8]) -> Self {
            unsafe { Sse(_mm_loadu_ps(v.as_ptr()), _mm_loadu_ps(v.as_ptr().add(4))) }
        }
        #[inline(always)]
        fn store(self, out: &mut [f32; 8]) {
            unsafe {
                _mm_storeu_ps(out.as_mut_ptr(), self.0);
                _mm_storeu_ps(out.as_mut_ptr().add(4), self.1);
            }
        }
        #[inline(always)]
        fn add(self, o: Self) -> Self {
            unsafe { Sse(_mm_add_ps(self.0, o.0), _mm_add_ps(self.1, o.1)) }
        }
        #[inline(always)]
        fn sub(self, o: Self) -> Self {
            unsafe { Sse(_mm_sub_ps(self.0, o.0), _mm_sub_ps(self.1, o.1)) }
        }
        #[inline(always)]
        fn mul(self, c: f32) -> Self {
            unsafe {
                let c = _mm_set1_ps(c);
                Sse(_mm_mul_ps(self.0, c), _mm_mul_ps(self.1, c))
            }
        }
        #[inline(always)]
        fn from_i32(v: &[i32]) -> Self {
            assert!(v.len() >= 8);
            unsafe {
                Sse(
                    _mm_cvtepi32_ps(_mm_loadu_si128(v.as_ptr() as *const __m128i)),
                    _mm_cvtepi32_ps(_mm_loadu_si128(v.as_ptr().add(4) as *const __m128i)),
                )
            }
        }
        // round_into: the plain per-lane rounding (SSE2 has no round half away from zero).
    }
}
// Inlined into each kit on x86-64 only: there, kits sharing one out-of-line
// copy cost 2-3% of cycles (one kit had inlined it as its only caller); on
// AArch64 inlining it cost 13% and the out-of-line copy is kept (milestone 2,
// docs/trier-mpeg-video.md).
#[cfg_attr(target_arch = "x86_64", inline(always))]
fn corner<const N: usize>(block: &mut [i32; 64]) {
    let last = block[63] as f32;
    // Only the DC coefficient after all: the same flat shortcut as `inverse`
    // (outside the corner every coefficient but 63 is zero by construction).
    let flat = last == 0.0 && (0..N).all(|v| (0..N).all(|u| (v | u) == 0 || block[v * 8 + u] == 0));
    if flat {
        let value = round_limit(block[0] as f32 / 8.0);
        block.fill(value);
        return;
    }
    let m = basis();
    // Rows: g[v][x] = sum_u M[x][u] F[v][u] for the first N rows.
    let mut rows = [[0f32; 8]; N];
    for (v, row) in rows.iter_mut().enumerate() {
        let f = &block[v * 8..v * 8 + N];
        if f.iter().all(|&c| c == 0) {
            continue;
        }
        for (x, g) in row.iter_mut().enumerate() {
            let mut sum = 0f32;
            for u in 0..N {
                sum += m[x][u] * f[u] as f32;
            }
            *g = sum;
        }
    }
    // Row 7 holds at most coefficient 63: g[7][x] = M[x][7] F[7][7].
    let row7: [f32; 8] = std::array::from_fn(|x| m[x][7] * last);
    // Columns: f[y][x] = sum_v M[y][v] g[v][x], v in order, row 7 last.
    for y in 0..8 {
        for x in 0..8 {
            let mut sum = 0f32;
            for (v, row) in rows.iter().enumerate() {
                sum += m[y][v] * row[x];
            }
            if last != 0.0 {
                sum += m[y][7] * row7[x];
            }
            block[y * 8 + x] = round_limit(sum);
        }
    }
}

#[inline]
fn round_limit(v: f32) -> i32 {
    round_half_away(v).clamp(-256, 255)
}

/// `f32::round` (half away from zero) as an integer. AArch64 has an
/// instruction for it; 32-bit ARM and x86-64's SSE2 baseline do not, and
/// there `round` is a call into the C library (19% of decoding time on the
/// Streamer). Instead: truncate, then step away from zero when the exact
/// remainder is at least a half. For |v| < 2^23 (the transform's values are
/// far smaller) `v - trunc(v)` is exact, so the result is identical (tested);
/// larger values are already integers (and beyond i32 both saturate), and
/// NaN gives 0 either way.
#[inline(always)]
fn round_half_away(v: f32) -> i32 {
    #[cfg(target_arch = "aarch64")]
    {
        v.round() as i32
    }
    #[cfg(not(target_arch = "aarch64"))]
    {
        let t = v as i32;
        let rest = v - t as f32;
        // Saturating: beyond i32 the truncation saturated already.
        t.saturating_add((rest >= 0.5) as i32)
            .saturating_sub((rest <= -0.5) as i32)
    }
}

#[cfg(test)]
#[path = "idct_tests.rs"]
mod tests;
