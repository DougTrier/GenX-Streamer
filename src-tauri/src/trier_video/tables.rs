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

//! Fixed tables of ITU-T H.262 | ISO/IEC 13818-2 not in Annex B's VLC lists
//! (those are generated into `annex_b.rs`), read from the standard.

/// One entry of the DCT coefficient tables B.14 and B.15.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Coef {
    RunLevel(i32, i32),
    EndOfBlock,
    Escape,
    /// Table B.14 Note 3: "1 s" is (run 0, level 1) only as the first
    /// coefficient of a non-intra block.
    FirstOne,
}
/// A coefficient table entry packed for `Vlc::decode_packed_with_next`: kind in bits
/// 0..2 (1 run/level, 2 end of block, 3 escape; 0 not usable here), run in
/// bits 2..8, level in bits 8..16.
pub(crate) fn pack_coef(c: &Coef) -> u32 {
    match *c {
        Coef::RunLevel(run, level) => {
            assert!((0..64).contains(&run) && (1..256).contains(&level));
            1 | (run as u32) << 2 | (level as u32) << 8
        }
        Coef::EndOfBlock => 2,
        Coef::Escape => 3,
        Coef::FirstOne => 0,
    }
}
pub(crate) const PACKED_RUN_LEVEL: u32 = 1;
pub(crate) const PACKED_END: u32 = 2;
pub(crate) const PACKED_ESCAPE: u32 = 3;

/// Two codes per table read (coefficient decoding research, H3): one lookup of
/// the next `bits` bits (10 to 12: `kit::CoefDecoder::PAIR_BITS`)
/// gives up to two whole run/level codes with their signs, or one followed by
/// end of block. Entry: first code + sign length (bits 0..5; 0: not here, use
/// the ordinary table), second length (5..10; 0: none), flags, run 1 (16..22),
/// run 2 (22..28), level magnitude 1 (32..44) and 2 (44..56).
pub(crate) const PAIR_END1: u64 = 1 << 10;
pub(crate) const PAIR_END2: u64 = 1 << 11;
pub(crate) const PAIR_NEG1: u64 = 1 << 12;
pub(crate) const PAIR_NEG2: u64 = 1 << 13;
/// Builds the H3 table from a coefficient table's rows (escape and codes too
/// long for the window stay 0, which falls back to the ordinary decoding).
pub(crate) fn coef_pairs(rows: &[(&str, Coef)], bits: u32) -> Vec<u64> {
    let bits = bits as usize;
    let mut table = vec![0u64; 1 << bits];
    let mut fill = |code: &str, entry: u64, over: bool| {
        if code.len() > bits {
            return;
        }
        let first = usize::from_str_radix(code, 2).expect("binary code") << (bits - code.len());
        for slot in &mut table[first..first + (1 << (bits - code.len()))] {
            assert!(over || *slot == 0, "codes must be prefix-free: {code}");
            *slot = entry;
        }
    };
    let mut symbols: Vec<(String, u64, u64, bool)> = Vec::new();
    let mut end = String::new();
    for (code, c) in rows {
        match *c {
            Coef::RunLevel(run, level) => {
                for negative in [false, true] {
                    let bits = format!("{code}{}", negative as u8);
                    symbols.push((bits, run as u64, level as u64, negative));
                }
            }
            Coef::EndOfBlock => end = code.to_string(),
            _ => {}
        }
    }
    fill(&end, end.len() as u64 | PAIR_END1, false);
    for (s1, r1, m1, n1) in &symbols {
        let first = s1.len() as u64 | r1 << 16 | m1 << 32 | if *n1 { PAIR_NEG1 } else { 0 };
        fill(s1, first, false);
        fill(
            &format!("{s1}{end}"),
            first | (end.len() as u64) << 5 | PAIR_END2,
            true,
        );
        for (s2, r2, m2, n2) in &symbols {
            let second =
                (s2.len() as u64) << 5 | r2 << 22 | m2 << 44 | if *n2 { PAIR_NEG2 } else { 0 };
            fill(&format!("{s1}{s2}"), first | second, true);
        }
    }
    table
}

/// macroblock_escape in Table B.1 (adds 33 to the increment).
pub(crate) const ESCAPE: i32 = -1;

/// macroblock_type flags (Tables B.2 to B.4).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct MbType {
    pub quant: bool,
    pub forward: bool,
    pub backward: bool,
    pub pattern: bool,
    pub intra: bool,
}
const fn mb(quant: bool, forward: bool, backward: bool, pattern: bool, intra: bool) -> MbType {
    MbType {
        quant,
        forward,
        backward,
        pattern,
        intra,
    }
}
/// Table B.2, I-pictures.
pub(crate) const MB_TYPE_I: &[(&str, MbType)] = &[
    ("1", mb(false, false, false, false, true)),
    ("01", mb(true, false, false, false, true)),
];
/// Table B.3, P-pictures.
pub(crate) const MB_TYPE_P: &[(&str, MbType)] = &[
    ("1", mb(false, true, false, true, false)),
    ("01", mb(false, false, false, true, false)),
    ("001", mb(false, true, false, false, false)),
    ("00011", mb(false, false, false, false, true)),
    ("00010", mb(true, true, false, true, false)),
    ("00001", mb(true, false, false, true, false)),
    ("000001", mb(true, false, false, false, true)),
];
/// Table B.4, B-pictures.
pub(crate) const MB_TYPE_B: &[(&str, MbType)] = &[
    ("10", mb(false, true, true, false, false)),
    ("11", mb(false, true, true, true, false)),
    ("010", mb(false, false, true, false, false)),
    ("011", mb(false, false, true, true, false)),
    ("0010", mb(false, true, false, false, false)),
    ("0011", mb(false, true, false, true, false)),
    ("00011", mb(false, false, false, false, true)),
    ("00010", mb(true, true, true, true, false)),
    ("000011", mb(true, true, false, true, false)),
    ("000010", mb(true, false, true, true, false)),
    ("000001", mb(true, false, false, false, true)),
];

/// scan[alternate_scan][v][u] (Figures 7-2 and 7-3), as [v * 8 + u].
pub(crate) const SCAN: [[u8; 64]; 2] = [
    [
        0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9,
        11, 18, 24, 31, 40, 44, 53, 10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60,
        21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
    ],
    [
        0, 4, 6, 20, 22, 36, 38, 52, 1, 5, 7, 21, 23, 37, 39, 53, 2, 8, 19, 24, 34, 40, 50, 54, 3,
        9, 18, 25, 35, 41, 51, 55, 10, 17, 26, 30, 42, 46, 56, 60, 11, 16, 27, 31, 43, 47, 57, 61,
        12, 15, 28, 32, 44, 48, 58, 62, 13, 14, 29, 33, 45, 49, 59, 63,
    ],
];
/// For each scan, the raster position [v * 8 + u] of scan index n.
pub(crate) fn scan_to_raster(alternate: bool) -> [u8; 64] {
    let mut out = [0u8; 64];
    for (raster, &n) in SCAN[alternate as usize].iter().enumerate() {
        out[n as usize] = raster as u8;
    }
    out
}

/// Default intra quantiser matrix (6.3.11), [v * 8 + u].
pub(crate) const DEFAULT_INTRA_MATRIX: [u8; 64] = [
    8, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27, 29, 34, 34, 38,
    22, 22, 26, 27, 29, 34, 37, 40, 22, 26, 27, 29, 32, 35, 40, 48, 26, 27, 29, 32, 35, 40, 48, 58,
    26, 27, 29, 34, 38, 46, 56, 69, 27, 29, 35, 38, 46, 56, 69, 83,
];
/// Default non-intra quantiser matrix: 16 everywhere.
pub(crate) const DEFAULT_NON_INTRA_MATRIX: [u8; 64] = [16; 64];

/// quantiser_scale for quantiser_scale_code 1..=31 (Table 7-6), by q_scale_type.
pub(crate) fn quantiser_scale(q_scale_type: bool, code: u8) -> i32 {
    const NON_LINEAR: [i32; 32] = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56,
        64, 72, 80, 88, 96, 104, 112,
    ];
    if q_scale_type {
        NON_LINEAR[code as usize & 31]
    } else {
        (code as i32 & 31) * 2
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scans_are_permutations() {
        for scan in SCAN {
            let mut seen = [false; 64];
            for n in scan {
                assert!(!seen[n as usize]);
                seen[n as usize] = true;
            }
        }
        assert_eq!(
            scan_to_raster(false)[2],
            8,
            "zigzag: third coefficient is (v=1, u=0)"
        );
    }
    #[test]
    fn quantiser_scales_follow_table_7_6() {
        assert_eq!(quantiser_scale(false, 31), 62);
        assert_eq!(quantiser_scale(true, 9), 10);
        assert_eq!(quantiser_scale(true, 31), 112);
    }
}
