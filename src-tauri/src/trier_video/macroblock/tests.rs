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

//! Tests of macroblock decoding.

use super::*;
/// The row add matches the plain arithmetic for every sample value and
/// residual in range, intra and not.
#[test]
fn add_row_saturates_like_the_plain_sum() {
    for intra in [false, true] {
        for p in (0..=255u8).step_by(5) {
            for r in -256..=255i32 {
                let mut fast = [p, 0, 255, p, 128, 1, 254, p];
                let mut plain = fast;
                let residual = [r, r, r, -r.min(255), r / 2, 255, -256, 0];
                AddBest::add_row(&mut fast, &residual, intra);
                add_row_portable(&mut plain, &residual, intra);
                assert_eq!(fast, plain, "p {p} r {r} intra {intra}");
            }
        }
    }
}

/// H2 gives `dequant`'s values for every level magnitude and sign, intra
/// and not, every quantiser_scale value and a spread of weights.
#[test]
fn branchless_reconstruction_matches_dequant() {
    for intra in [false, true] {
        for weight in [0, 1, 2, 7, 16, 31, 64, 127, 200, 255] {
            for qscale in 1..=112 {
                let q2 = qscale * (1 + intra as i32);
                for mag in 1..=2047 {
                    for negative in [false, true] {
                        let level = if negative { -mag } else { mag };
                        assert_eq!(
                            reconstruct(mag, negative, weight, q2, intra),
                            dequant(level, weight, qscale, intra),
                            "mag {mag} neg {negative} w {weight} q {qscale} intra {intra}"
                        );
                    }
                }
            }
        }
    }
}

/// H3: for every window, the pair table's entry is exactly what decoding
/// the codes one at a time gives (lengths, runs, levels, signs, end of
/// block), or 0 where a code does not fit the window.
#[test]
fn pair_table_matches_single_codes() {
    let v = vlcs();
    for (pairs, table, bits) in (10..=12).flat_map(|bits| {
        let t = pair_tables(bits);
        [(&t[0], &v.coef0, bits), (&t[1], &v.coef1, bits)]
    }) {
        for window in 0..1u32 << bits {
            for tail in [0u32, 0xFFFFF, 0x5A5A5] {
                let word = window << (32 - bits) | tail >> bits;
                let data = [word.to_be_bytes(), [0xA5; 4]].concat();
                let mut b = Bits::new(&data);
                let e = pairs[window as usize];
                // One ordinary decode: (length, kind, run, level, negative).
                let one = |b: &mut Bits| {
                    let start = b.bits_left();
                    let (entry, negative) = table.decode_packed_with_next(b)?;
                    if entry & 3 == tables::PACKED_RUN_LEVEL {
                        b.skip(1);
                    }
                    let len = (start - b.bits_left()) as u64;
                    Some((
                        len,
                        entry & 3,
                        ((entry >> 2) & 63) as u64,
                        (entry >> 8) as u64,
                        negative,
                    ))
                };
                let first = one(&mut b);
                let len1 = e & 31;
                if len1 == 0 {
                    // Not in the window: escape, a long code or no code.
                    assert!(
                        first.is_none_or(|f| f.1 == tables::PACKED_ESCAPE || f.0 > bits as u64),
                        "window {window:b}"
                    );
                    continue;
                }
                let (l, kind, run, level, negative) = first.expect("a code");
                assert_eq!(l, len1, "window {window:b}");
                if e & tables::PAIR_END1 != 0 {
                    assert_eq!(kind, tables::PACKED_END);
                    continue;
                }
                assert_eq!(kind, tables::PACKED_RUN_LEVEL);
                assert_eq!((run, level), ((e >> 16) & 63, (e >> 32) & 0xFFF));
                assert_eq!(negative, e & tables::PAIR_NEG1 != 0);
                let len2 = (e >> 5) & 31;
                let second = one(&mut b);
                if len2 == 0 {
                    // The second code is an escape or would not fit the window.
                    assert!(
                        second
                            .is_none_or(|s| s.1 == tables::PACKED_ESCAPE || l + s.0 > bits as u64),
                        "window {window:b}"
                    );
                    continue;
                }
                let (l2, kind2, run2, level2, negative2) = second.expect("a second code");
                assert_eq!(l2, len2);
                if e & tables::PAIR_END2 != 0 {
                    assert_eq!(kind2, tables::PACKED_END);
                    continue;
                }
                assert_eq!(kind2, tables::PACKED_RUN_LEVEL);
                assert_eq!((run2, level2), ((e >> 22) & 63, (e >> 44) & 0xFFF));
                assert_eq!(negative2, e & tables::PAIR_NEG2 != 0);
            }
        }
    }
}
