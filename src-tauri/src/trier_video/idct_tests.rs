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

use super::*;

/// The rounding gives exactly f32::round: every half-way value up to
/// 2^13 and its nearest neighbours, plus a million random values.
#[test]
fn rounding_matches_f32_round() {
    let check = |v: f32| assert_eq!(round_half_away(v), v.round() as i32, "{v:e}");
    for k in -16_384i32..=16_384 {
        let half = k as f32 + 0.5;
        for d in -3i32..=3 {
            for v in [half, -half, k as f32] {
                check(f32::from_bits((v.to_bits() as i32 + d) as u32));
            }
        }
    }
    let mut seed = 0x0123_4567_89ab_cdefu64;
    for _ in 0..1_000_000 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        check(f32::from_bits(seed as u32) % 70_000.0);
    }
    for v in [
        0.0f32,
        -0.0,
        0.49999997,
        -0.49999997,
        0.5,
        -0.5,
        8_388_607.5,
        f32::NAN,
        3e9,
        -3e9,
    ] {
        check(v);
    }
}
/// The IEEE 1180-1990 test: 10,000 random blocks per range, compared with a
/// double-precision reference; peak error <= 1, mean square error per
/// position <= 0.06, overall <= 0.02, mean error per position <= 0.015,
/// overall <= 0.0015, and an all-zero block stays zero.
#[test]
fn meets_ieee_1180_accuracy() {
    // Double-precision separable transforms with C(u) folded in.
    let mut c = [[0f64; 8]; 8];
    for (x, row) in c.iter_mut().enumerate() {
        for (u, value) in row.iter_mut().enumerate() {
            let cu = if u == 0 {
                std::f64::consts::FRAC_1_SQRT_2
            } else {
                1.0
            };
            *value = cu / 2.0 * ((2 * x + 1) as f64 * u as f64 * std::f64::consts::PI / 16.0).cos();
        }
    }
    let reference = |input: &[i32; 64]| -> [i32; 64] {
        let mut rows = [0f64; 64];
        for v in 0..8 {
            for x in 0..8 {
                rows[v * 8 + x] = (0..8).map(|u| c[x][u] * input[v * 8 + u] as f64).sum();
            }
        }
        let mut out = [0i32; 64];
        for y in 0..8 {
            for x in 0..8 {
                let sum: f64 = (0..8).map(|v| c[y][v] * rows[v * 8 + x]).sum();
                out[y * 8 + x] = (sum.round() as i32).clamp(-256, 255);
            }
        }
        out
    };
    let forward = |spatial: &[f64; 64]| -> [i32; 64] {
        let mut rows = [0f64; 64];
        for y in 0..8 {
            for u in 0..8 {
                rows[y * 8 + u] = (0..8).map(|x| c[x][u] * spatial[y * 8 + x]).sum();
            }
        }
        let mut out = [0i32; 64];
        for v in 0..8 {
            for u in 0..8 {
                let sum: f64 = (0..8).map(|y| c[y][v] * rows[y * 8 + u]).sum();
                out[v * 8 + u] = (sum.round() as i32).clamp(-2048, 2047);
            }
        }
        out
    };
    // The test's own generator (IEEE 1180 Annex A), so results are reproducible.
    struct Rng(i64);
    impl Rng {
        fn next(&mut self, low: i64, high: i64) -> i64 {
            self.0 = (self.0 * 1103515245 + 12345) & 0x7fff_ffff;
            let x = self.0 as f64 / 2147483647.0;
            let v = (x * (high - low + 1) as f64) as i64 + low;
            v.min(high)
        }
    }
    for (low, high) in [(-256, 255), (-5, 5), (-300, 300)] {
        for sign in [1i32, -1] {
            let mut rng = Rng(1);
            let mut err = [0i64; 64];
            let mut sq = [0i64; 64];
            let mut peak = 0;
            let mut dense_err = [0i64; 64];
            let mut dense_sq = [0i64; 64];
            let mut dense_peak = 0;
            let blocks = 10_000;
            for _ in 0..blocks {
                // A spatial block, its exact forward DCT rounded, then both inverses.
                let mut spatial = [0f64; 64];
                for s in spatial.iter_mut() {
                    *s = (rng.next(low, high) * sign as i64) as f64;
                }
                let coef = forward(&spatial);
                let expected = reference(&coef);
                let mut actual = coef;
                inverse(&mut actual);
                let mut fast = coef;
                dense::<Simd>(&mut fast);
                for i in 0..64 {
                    let e = (fast[i] - expected[i]) as i64;
                    dense_peak = dense_peak.max(e.abs());
                    dense_err[i] += e;
                    dense_sq[i] += e * e;
                }
                for i in 0..64 {
                    let e = (actual[i] - expected[i]) as i64;
                    peak = peak.max(e.abs());
                    err[i] += e;
                    sq[i] += e * e;
                }
            }
            let n = blocks as f64;
            assert!(peak <= 1, "peak error {peak} for range {low}..{high}");
            assert!(
                dense_peak <= 1,
                "dense peak error {dense_peak} for range {low}..{high}"
            );
            let d_pmse = dense_sq.iter().map(|&s| s as f64 / n).fold(0f64, f64::max);
            let d_omse = dense_sq.iter().sum::<i64>() as f64 / (n * 64.0);
            let d_pme = dense_err
                .iter()
                .map(|&s| (s as f64 / n).abs())
                .fold(0f64, f64::max);
            let d_ome = (dense_err.iter().sum::<i64>() as f64 / (n * 64.0)).abs();
            assert!(
                d_pmse <= 0.06 && d_omse <= 0.02 && d_pme <= 0.015 && d_ome <= 0.0015,
                "dense: mse {d_pmse} {d_omse} mean error {d_pme} {d_ome} range {low}..{high}"
            );
            let pmse = sq.iter().map(|&s| s as f64 / n).fold(0f64, f64::max);
            let omse = sq.iter().sum::<i64>() as f64 / (n * 64.0);
            let pme = err
                .iter()
                .map(|&s| (s as f64 / n).abs())
                .fold(0f64, f64::max);
            let ome = (err.iter().sum::<i64>() as f64 / (n * 64.0)).abs();
            assert!(
                pmse <= 0.06 && omse <= 0.02,
                "mse {pmse} {omse} range {low}..{high}"
            );
            assert!(
                pme <= 0.015 && ome <= 0.0015,
                "mean error {pme} {ome} range {low}..{high}"
            );
        }
    }
    let mut zero = [0i32; 64];
    inverse(&mut zero);
    assert!(zero.iter().all(|&v| v == 0));
}

/// The vector form of the dense transform returns exactly what the plain
/// form returns (the same operations per lane), so every platform agrees.
#[test]
fn dense_vector_form_matches_plain() {
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for i in 0..100_000 {
        let range = [2048i64, 300, 20][i % 3];
        let block: [i32; 64] = std::array::from_fn(|_| {
            if next() % 2 == 0 {
                ((next() % (2 * range as u64 + 1)) as i64 - range) as i32
            } else {
                0
            }
        });
        let mut plain = block;
        let mut fast = block;
        dense::<Plain>(&mut plain);
        dense::<Simd>(&mut fast);
        assert_eq!(plain, fast, "block {block:?}");
    }
}

/// The corner transform returns exactly what the full one returns, for
/// every reach, with and without the mismatch-control coefficient.
/// 32-bit ARM: the NEON corner paths give exactly the plain IDCT's
/// output for every reach, with and without coefficient 63, and around
/// the rounding and clamping boundaries (runs on ARM devices).
#[cfg(target_arch = "arm")]
#[test]
fn neon32_matches_plain() {
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for i in 0..200_000 {
        let reach = i % 8;
        let range = [2047u64, 300, 40, 8][i % 4];
        let mut block = [0i32; 64];
        for v in 0..=reach {
            for u in 0..=reach {
                if next() % 2 == 0 {
                    block[v * 8 + u] = (next() % (2 * range + 1)) as i32 - range as i32;
                }
            }
        }
        if i % 3 == 0 {
            block[63] = if next() % 2 == 0 { 1 } else { -1 };
        }
        let (mut fast, mut plain) = (block, block);
        IdctNeon32::inverse_within(&mut fast, reach);
        IdctPlain::inverse_within(&mut plain, reach);
        assert_eq!(fast, plain, "reach {reach} block {block:?}");
    }
}

#[test]
fn corner_matches_full_transform() {
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for i in 0..200_000 {
        let reach = (i % 8) as usize;
        let mut block = [0i32; 64];
        for v in 0..=reach {
            for u in 0..=reach {
                if next() % 3 == 0 {
                    block[v * 8 + u] = (next() % 4095) as i32 - 2047;
                }
            }
        }
        if i % 2 == 0 {
            block[63] = if next() % 2 == 0 { 1 } else { -1 };
        }
        let mut full = block;
        let mut fast = block;
        inverse(&mut full);
        if reach >= 4 {
            // Dense blocks use the even/odd transform: within IEEE 1180 of the direct one.
            within::<Simd>(&mut fast, reach);
            assert!(
                full.iter().zip(&fast).all(|(a, b)| (a - b).abs() <= 1),
                "reach {reach}"
            );
            continue;
        }
        within::<Simd>(&mut fast, reach);
        assert_eq!(full, fast, "reach {reach} block {block:?}");
    }
}
