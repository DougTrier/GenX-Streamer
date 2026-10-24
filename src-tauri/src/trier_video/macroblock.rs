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

//! Slice and macroblock layers (6.2.4 to 6.2.6, 7.2 to 7.6).
use super::kit::{with_kit, BlockAdd, CoefDecoder, Features, InverseDct, Kit};
use super::*;
use std::marker::PhantomData;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

/// One macroblock's place in the frame being decoded (or in its field):
/// predictions and residuals are written there directly, with no staging
/// buffer to clear and copy (performance milestone, docs/trier-mpeg-video.md).
struct Mb<'a> {
    /// From the macroblock's first sample to the end of each plane.
    y: &'a mut [u8],
    cb: &'a mut [u8],
    cr: &'a mut [u8],
    /// Distance between the macroblock's lines in luma and in chroma.
    ys: usize,
    cs: usize,
}
impl<'a> Mb<'a> {
    /// Macroblock (`mx`, `my`) within `band`; None if it lies outside it.
    fn at(band: &'a mut Band, ctx: Ctx, mx: usize, my: usize) -> Option<Self> {
        let (w, cw) = (band.width, band.width / 2);
        let (offset, ys, coffset, cs) = if ctx.frame_pic {
            (0, w, 0, cw)
        } else {
            (ctx.parity * w, 2 * w, ctx.parity * cw, 2 * cw)
        };
        let y0 = (offset + my * 16 * ys + mx * 16).checked_sub(band.y_at)?;
        let c0 = (coffset + my * 8 * cs + mx * 8).checked_sub(band.c_at)?;
        if mx >= ctx.mb_width || y0 + 15 * ys + 16 > band.y.len() || c0 + 7 * cs + 8 > band.cb.len()
        {
            return None;
        }
        Some(Self {
            y: &mut band.y[y0..],
            cb: &mut band.cb[c0..],
            cr: &mut band.cr[c0..],
            ys,
            cs,
        })
    }
}

/// Where a macroblock's prediction comes from.
#[derive(Clone, Copy)]
enum Pred {
    /// Frame pictures: frame-based (kind 2), field-based (1), dual prime (3).
    /// Field pictures: field-based (1), 16x8 (2), dual prime (3).
    Coded(Motion),
    /// Zero vector, same parity, forward (P "No MC" and skipped P macroblocks).
    Zero,
    /// Skipped B macroblock: previous directions, vectors from the predictors.
    SkippedB(Motion),
}

#[derive(Clone, Copy)]
struct Ctx {
    frame_pic: bool,
    /// Parity of the field being decoded (field pictures).
    parity: usize,
    mb_width: usize,
    mb_rows: usize,
}

impl<K: Kit> Slicer<'_, K> {
    fn slice(&mut self, code: u8, body: &[u8], ctx: Ctx, cur: &mut Band) {
        let seq = self.seq;
        let mut b = Bits::new(body);
        let mut row = code as usize - 1;
        if seq.height > 2800 {
            row += (b.read(3) as usize) << 7;
        }
        if row < ctx.mb_rows {
            cur.rows_seen.resize(ctx.mb_rows, false);
            cur.rows_seen[row] = true;
            let mut mb_x: isize = -1;
            let mut start = None;
            let ok = self.decode_slice(seq, cur, ctx, &mut b, row, &mut mb_x, &mut start);
            if !ok {
                self.stats.concealed_slices += 1;
                // Conceal the whole slice from the newest reference: after a
                // loss, the bits before the point where decoding failed are
                // usually garbage too (they still parse for a while). Measured
                // in the scorecard (docs/trier-mpeg-video.md, "Comparison").
                let from = start.unwrap_or((mb_x + 1).max(0) as usize);
                for x in from..ctx.mb_width {
                    self.conceal(cur, ctx, x, row);
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn decode_slice(
        &mut self,
        seq: &Sequence,
        cur: &mut Band,
        ctx: Ctx,
        b: &mut Bits,
        row: usize,
        mb_x: &mut isize,
        start: &mut Option<usize>,
    ) -> bool {
        let v = vlcs();
        let pic = self.pic;
        self.qscale = tables::quantiser_scale(pic.q_scale_type, b.read(5) as u8);
        if b.peek(1) == 1 {
            b.skip(1 + 1 + 7);
            while b.peek(1) == 1 {
                b.skip(9);
            }
        }
        b.skip(1);
        self.reset_dc();
        self.pmv = Default::default();
        // Nothing carries over from the previous slice (which may be on another
        // core); valid streams never use it (no skipped macroblock follows a
        // slice start before a coded one sets it).
        self.last = Motion::default();
        let mut first = true;
        loop {
            if b.bits_left() <= 0 || b.at_start_code_prefix() {
                return !first;
            }
            let mut increment = 0isize;
            while b.peek(11) == 0b000_0000_1000 {
                b.skip(11);
                increment += 33;
            }
            match v.mb_increment.decode(b) {
                Some(i) if i > 0 => increment += i as isize,
                _ => return false,
            }
            let x = *mb_x + increment;
            if x >= ctx.mb_width as isize {
                return false;
            }
            if !first {
                for skipped in (*mb_x + 1)..x {
                    self.skipped(cur, ctx, skipped as usize, row);
                }
            }
            first = false;
            start.get_or_insert(x as usize);
            *mb_x = x;
            if !self.macroblock(seq, cur, ctx, b, x as usize, row) || b.overrun() {
                *mb_x = x - 1;
                return false;
            }
        }
    }

    fn reset_dc(&mut self) {
        let value = 1 << (7 + self.pic.intra_dc_precision);
        self.dc_pred = [value; 3];
    }

    fn macroblock(
        &mut self,
        seq: &Sequence,
        cur: &mut Band,
        ctx: Ctx,
        b: &mut Bits,
        mx: usize,
        my: usize,
    ) -> bool {
        let v = vlcs();
        let pic = self.pic;
        let table = match pic.coding_type {
            I_PIC => &v.mb_i,
            P_PIC => &v.mb_p,
            _ => &v.mb_b,
        };
        let Some(t) = table.decode(b) else {
            return false;
        };
        let mut kind = 0u8;
        if t.forward || t.backward {
            kind = if ctx.frame_pic && pic.frame_pred_frame_dct {
                2
            } else {
                b.read(2) as u8
            };
            if kind == 0 {
                return false;
            }
        }
        let field_dct =
            ctx.frame_pic && !pic.frame_pred_frame_dct && (t.intra || t.pattern) && b.flag();
        if t.quant {
            self.qscale = tables::quantiser_scale(pic.q_scale_type, b.read(5) as u8);
        }
        // Motion vector format (Tables 6-17 and 6-18).
        let concealment = t.intra && pic.concealment;
        let kind_used = if concealment && !(t.forward || t.backward) {
            if ctx.frame_pic {
                2
            } else {
                1
            }
        } else {
            kind
        };
        let (count, field_format, dmv) = match (ctx.frame_pic, kind_used) {
            (true, 1) => (2, true, false),
            (true, 3) | (false, 3) => (1, true, true),
            (false, 2) => (2, true, false),
            (false, _) => (1, true, false),
            _ => (1, false, false),
        };
        let mut dmvector = [0i32; 2];
        if (t.forward || concealment)
            && !self.motion_vectors(b, 0, count, field_format, dmv, ctx.frame_pic, &mut dmvector)
        {
            return false;
        }
        if t.backward
            && !self.motion_vectors(b, 1, count, field_format, dmv, ctx.frame_pic, &mut dmvector)
        {
            return false;
        }
        if concealment {
            b.skip(1);
        }
        // Motion vector predictor updates (Tables 7-9, 7-10) and resets (7.6.3.4).
        if t.intra {
            if concealment {
                self.pmv[1][0] = self.pmv[0][0];
            } else {
                self.pmv = Default::default();
            }
        } else if count == 1 {
            if t.forward {
                self.pmv[1][0] = self.pmv[0][0];
            }
            if t.backward {
                self.pmv[1][1] = self.pmv[0][1];
            }
        }
        if pic.coding_type == P_PIC && !t.intra && !t.forward {
            self.pmv = Default::default();
        }
        if dmv {
            self.dual_prime_vectors(ctx, dmvector);
        }
        let cbp = if t.pattern {
            match v.cbp.decode(b) {
                Some(c) => c,
                None => return false,
            }
        } else if t.intra {
            63
        } else {
            0
        };
        self.stats.coded_macroblocks += 1;
        self.stats.intra_macroblocks += t.intra as u64;
        // Intra: no prediction; motion state for following skipped B blocks is unchanged.
        let mut pred = None;
        if !t.intra {
            self.reset_dc();
            pred = Some(if !t.forward && !t.backward {
                Pred::Zero
            } else {
                Pred::Coded(Motion {
                    forward: t.forward,
                    backward: t.backward,
                    kind,
                })
            });
            if !t.forward && !t.backward {
                // P "No MC": zero vector, field-based same parity in field pictures.
            } else {
                self.last = Motion {
                    forward: t.forward,
                    backward: t.backward,
                    kind,
                };
            }
        }
        // Every coded block is read before the frame is touched, so a
        // macroblock whose data fails leaves the frame as it was.
        for block in 0..6 {
            if cbp & (32 >> block) != 0 {
                if !self.block(seq, b, block, t.intra) {
                    return false;
                }
                K::Idct::inverse_within(&mut self.blocks[block], self.reach[block] as usize);
            }
        }
        let Some(mut mb) = Mb::at(cur, ctx, mx, my) else {
            return true;
        };
        if let Some(pred) = pred {
            if !self.predict_mb(ctx, mx, my, pred, &mut mb) {
                return false;
            }
        }
        for block in 0..6 {
            if cbp & (32 >> block) != 0 {
                add_block::<K>(&mut mb, block, field_dct, t.intra, &self.blocks[block]);
            }
        }
        true
    }

    #[allow(clippy::too_many_arguments)]
    fn motion_vectors(
        &mut self,
        b: &mut Bits,
        s: usize,
        count: usize,
        field_format: bool,
        dmv: bool,
        frame_pic: bool,
        dmvector: &mut [i32; 2],
    ) -> bool {
        if count == 1 {
            if field_format && !dmv {
                self.field_select[0][s] = b.flag();
            }
            self.motion_vector(b, 0, s, field_format, dmv, frame_pic, dmvector)
        } else {
            self.field_select[0][s] = b.flag();
            if !self.motion_vector(b, 0, s, field_format, dmv, frame_pic, dmvector) {
                return false;
            }
            self.field_select[1][s] = b.flag();
            self.motion_vector(b, 1, s, field_format, dmv, frame_pic, dmvector)
        }
    }

    /// 7.6.3.1: decodes one vector and updates its predictor.
    #[allow(clippy::too_many_arguments)]
    fn motion_vector(
        &mut self,
        b: &mut Bits,
        r: usize,
        s: usize,
        field_format: bool,
        dmv: bool,
        frame_pic: bool,
        dmvector: &mut [i32; 2],
    ) -> bool {
        let v = vlcs();
        for t in 0..2 {
            let Some(code) = v.motion.decode(b) else {
                return false;
            };
            let f_code = self.pic.f_code[s][t] as u32;
            if !(1..=9).contains(&f_code) {
                return false;
            }
            let r_size = f_code - 1;
            let residual = if r_size != 0 && code != 0 {
                b.read(r_size) as i32
            } else {
                0
            };
            if dmv {
                match v.dmv.decode(b) {
                    Some(d) => dmvector[t] = d,
                    None => return false,
                }
            }
            let f = 1i32 << r_size;
            let (high, low, range) = (16 * f - 1, -16 * f, 32 * f);
            let delta = if f == 1 || code == 0 {
                code
            } else {
                let d = (code.abs() - 1) * f + residual + 1;
                if code < 0 {
                    -d
                } else {
                    d
                }
            };
            let halve = field_format && t == 1 && frame_pic;
            let prediction = if halve {
                self.pmv[r][s][t] >> 1
            } else {
                self.pmv[r][s][t]
            };
            let mut vector = prediction + delta;
            if vector < low {
                vector += range;
            }
            if vector > high {
                vector -= range;
            }
            self.pmv[r][s][t] = if halve { vector * 2 } else { vector };
            self.vectors[r][s][t] = vector;
        }
        true
    }

    /// 7.6.3.6: the opposite-parity vectors of dual prime prediction.
    fn dual_prime_vectors(&mut self, ctx: Ctx, dmv: [i32; 2]) {
        let half = |x: i32| if x >= 0 { (x + 1) / 2 } else { -((-x + 1) / 2) };
        let v0 = self.vectors[0][0];
        let derive = |m: i32, e: i32| [half(v0[0] * m) + dmv[0], half(v0[1] * m) + e + dmv[1]];
        if ctx.frame_pic {
            let tff = self.pic.top_field_first;
            // Top field predicted from the bottom reference: m[1][0], e = -1.
            self.vectors[2][0] = derive(if tff { 1 } else { 3 }, -1);
            // Bottom field predicted from the top reference: m[0][1], e = +1.
            self.vectors[3][0] = derive(if tff { 3 } else { 1 }, 1);
        } else if ctx.parity == 0 {
            self.vectors[2][0] = derive(1, -1);
        } else {
            self.vectors[2][0] = derive(1, 1);
        }
    }

    /// The reference frame holding field `parity` for direction `s`.
    /// The reference picture to predict from, lent rather than shared: no
    /// reference count changes per macroblock.
    fn reference(&self, s: usize, parity: Option<usize>) -> Option<&Planes> {
        if self.pic.coding_type == P_PIC {
            // The second field of a P frame predicts the opposite-parity field
            // from the first field just decoded.
            if let (Some(first), Some(copy), Some(p)) = (self.first, self.copy, parity) {
                if p == (first == BOTTOM) as usize {
                    return Some(copy);
                }
            }
            return self.newer;
        }
        if s == 0 {
            self.older
        } else {
            self.newer
        }
    }

    fn predict_mb(&mut self, ctx: Ctx, mx: usize, my: usize, pred: Pred, mb: &mut Mb) -> bool {
        let (motion, zero) = match pred {
            Pred::Coded(m) => (m, false),
            Pred::Zero => (
                Motion {
                    forward: true,
                    backward: false,
                    kind: if ctx.frame_pic { 2 } else { 1 },
                },
                true,
            ),
            Pred::SkippedB(m) => (
                Motion {
                    kind: if ctx.frame_pic { 2 } else { 1 },
                    ..m
                },
                false,
            ),
        };
        let skipped_b = matches!(pred, Pred::SkippedB(_));
        let mut averaged = false;
        for s in 0..2 {
            if (s == 0 && !motion.forward) || (s == 1 && !motion.backward) {
                continue;
            }
            // Vectors: decoded, zero, or (skipped B) the predictors.
            let vec = |r: usize| -> [i32; 2] {
                if zero {
                    [0, 0]
                } else if skipped_b {
                    self.pmv[0][s]
                } else {
                    self.vectors[r][s]
                }
            };
            if ctx.frame_pic {
                match motion.kind {
                    2 => {
                        let Some(r) = self.reference(s, None) else {
                            return false;
                        };
                        frame_prediction::<K>(mb, r, mx, my, vec(0), averaged);
                    }
                    1 => {
                        for field in 0..2 {
                            let sel = self.field_select[field][s] as usize;
                            let Some(r) = self.reference(s, Some(sel)) else {
                                return false;
                            };
                            field_rows::<K>(mb, r, sel, field, mx, my, vec(field), averaged);
                        }
                    }
                    _ => {
                        // Dual prime: each field from its same and opposite parity, averaged.
                        let Some(r) = self.reference(0, None) else {
                            return false;
                        };
                        let v0 = self.vectors[0][0];
                        field_rows::<K>(mb, r, 0, 0, mx, my, v0, false);
                        field_rows::<K>(mb, r, 1, 0, mx, my, self.vectors[2][0], true);
                        field_rows::<K>(mb, r, 1, 1, mx, my, v0, false);
                        field_rows::<K>(mb, r, 0, 1, mx, my, self.vectors[3][0], true);
                    }
                }
            } else {
                match motion.kind {
                    1 => {
                        let sel = if zero || skipped_b {
                            ctx.parity
                        } else {
                            self.field_select[0][s] as usize
                        };
                        let Some(r) = self.reference(s, Some(sel)) else {
                            return false;
                        };
                        field_block::<K>(mb, r, sel, mx, my, 0, 16, vec(0), averaged);
                    }
                    2 => {
                        for half in 0..2 {
                            let sel = self.field_select[half][s] as usize;
                            let Some(r) = self.reference(s, Some(sel)) else {
                                return false;
                            };
                            field_block::<K>(mb, r, sel, mx, my, half * 8, 8, vec(half), averaged);
                        }
                    }
                    _ => {
                        let same = ctx.parity;
                        let Some(a) = self.reference(0, Some(same)) else {
                            return false;
                        };
                        let Some(o) = self.reference(0, Some(1 - same)) else {
                            return false;
                        };
                        field_block::<K>(mb, a, same, mx, my, 0, 16, self.vectors[0][0], false);
                        field_block::<K>(mb, o, 1 - same, mx, my, 0, 16, self.vectors[2][0], true);
                    }
                }
            }
            averaged = true;
        }
        true
    }

    fn skipped(&mut self, cur: &mut Band, ctx: Ctx, mx: usize, my: usize) {
        self.stats.skipped_macroblocks += 1;
        self.reset_dc();
        let pred = if self.pic.coding_type == P_PIC {
            self.pmv = Default::default();
            Pred::Zero
        } else {
            Pred::SkippedB(self.last)
        };
        if let Some(mut mb) = Mb::at(cur, ctx, mx, my) {
            // A failed prediction (no reference) leaves the macroblock as it was.
            self.predict_mb(ctx, mx, my, pred, &mut mb);
        }
    }

    fn conceal(&mut self, cur: &mut Band, ctx: Ctx, mx: usize, my: usize) {
        let Some(r) = self.newer else {
            return;
        };
        let Some(mut mb) = Mb::at(cur, ctx, mx, my) else {
            return;
        };
        if ctx.frame_pic {
            frame_prediction::<K>(&mut mb, r, mx, my, [0, 0], false);
        } else {
            field_block::<K>(&mut mb, r, ctx.parity, mx, my, 0, 16, [0, 0], false);
        }
    }

    /// Decodes one block's coefficients and inverse-quantises them (7.2, 7.4)
    /// into `self.blocks[index]` in raster order.
    fn block(&mut self, seq: &Sequence, b: &mut Bits, index: usize, intra: bool) -> bool {
        let v = vlcs();
        let pic = self.pic;
        self.blocks[index] = [0; 64];
        let qscale = self.qscale;
        let matrix = if intra { &seq.intra } else { &seq.non_intra };
        let mut sum = 0i32;
        let mut n = 0usize;
        // Coded coefficients in this block (statistics only).
        let mut coded = 0u64;
        // The DC (or first) coefficient is at raster position 0.
        let mut reach = 0usize;
        let table;
        if intra {
            let cc = if index < 4 { 0 } else { index - 3 };
            let size = if cc == 0 {
                v.dc_luma.decode(b)
            } else {
                v.dc_chroma.decode(b)
            };
            let Some(size) = size else { return false };
            let diff = if size == 0 {
                0
            } else {
                let bits = b.read(size as u32) as i32;
                if bits < 1 << (size - 1) {
                    bits + 1 - (1 << size)
                } else {
                    bits
                }
            };
            self.dc_pred[cc] += diff;
            let dc = (self.dc_pred[cc] * (8 >> pic.intra_dc_precision)).clamp(-2048, 2047);
            self.blocks[index][0] = dc;
            sum += dc;
            n = 1;
            table = if pic.intra_vlc_format {
                &v.coef1
            } else {
                &v.coef0
            };
        } else {
            table = &v.coef0;
            // First coefficient: "1 s" is (0, 1) here (Table B.14 Note 3).
            if b.peek(1) == 1 {
                b.skip(1);
                let level = if b.flag() { -1 } else { 1 };
                let value = dequant(level, matrix[0] as i32, qscale, false);
                self.blocks[index][self.scan[0] as usize] = value;
                sum += value;
                n = 1;
            }
        }
        let pairs = self.pairs[(intra && pic.intra_vlc_format) as usize];
        let weights = &self.weights[intra as usize];
        let q2 = qscale * (1 + intra as i32);
        // H1: the position counts up from -64 towards 0, so running past the
        // block is the counter's sign and the table index is a mask.
        let mut k = n as isize - 64;
        // Places one coefficient: run, level magnitude and sign.
        macro_rules! put {
            ($run:expr, $mag:expr, $neg:expr) => {{
                let (raster, corner, weight) = if K::Coef::NEGATIVE_OFFSET {
                    k += $run as isize;
                    if k >= 0 {
                        return false;
                    }
                    let e = weights[(k & 63) as usize];
                    k += 1;
                    ((e & 63) as usize, ((e >> 6) & 7) as usize, (e >> 9) as i32)
                } else {
                    n += $run as usize;
                    if n > 63 {
                        return false;
                    }
                    let raster = self.scan[n] as usize;
                    n += 1;
                    (raster, (raster >> 3).max(raster & 7), matrix[raster] as i32)
                };
                reach = reach.max(corner);
                let value = if K::Coef::BRANCHLESS {
                    reconstruct($mag as i32, $neg, weight, q2, intra)
                } else {
                    let level = $mag as i32;
                    dequant(if $neg { -level } else { level }, weight, qscale, intra)
                };
                self.blocks[index][raster] = value;
                sum += value;
                coded += 1;
            }};
        }
        loop {
            if K::Coef::PAIRS {
                let e = pairs[b.peek(K::Coef::PAIR_BITS) as usize];
                let first = (e & 31) as u32;
                if first != 0 {
                    b.skip(first);
                    if e & tables::PAIR_END1 != 0 {
                        break;
                    }
                    put!(
                        (e >> 16) & 63,
                        (e >> 32) & 0xFFF,
                        e & tables::PAIR_NEG1 != 0
                    );
                    let second = ((e >> 5) & 31) as u32;
                    if second != 0 {
                        b.skip(second);
                        if e & tables::PAIR_END2 != 0 {
                            break;
                        }
                        put!(
                            (e >> 22) & 63,
                            (e >> 44) & 0xFFF,
                            e & tables::PAIR_NEG2 != 0
                        );
                    }
                    continue;
                }
            }
            // The sign comes from the same read as the code.
            let Some((entry, negative)) = table.decode_packed_with_next(b) else {
                return false;
            };
            match entry & 3 {
                tables::PACKED_RUN_LEVEL => {
                    b.skip(1);
                    put!((entry >> 2) & 63, entry >> 8, negative);
                }
                tables::PACKED_END => break,
                tables::PACKED_ESCAPE => {
                    let run = b.read(6);
                    let raw = b.read(12) as i32;
                    let level = if raw & 0x800 != 0 { raw - 4096 } else { raw };
                    if level == 0 || level == -2048 {
                        return false;
                    }
                    put!(run, level.unsigned_abs(), level < 0);
                }
                _ => return false,
            }
        }
        // Mismatch control (7.4.4). This may set coefficient 63 without a
        // code reaching it; `reach` counts coded coefficients only.
        if sum & 1 == 0 {
            self.blocks[index][63] ^= 1;
        }
        self.reach[index] = reach as u8;
        self.stats.coefficients += coded;
        true
    }
}

/// H2: `dequant` from the level's magnitude and sign. The product is not
/// negative, so the division by 32 is a shift; the saturation bound is 2047,
/// or 2048 before a negative sign; the sign goes on last, without a branch.
/// `q2` is quantiser_scale, doubled for intra blocks. Same values (tested).
#[inline(always)]
fn reconstruct(mag: i32, negative: bool, weight: i32, q2: i32, intra: bool) -> i32 {
    let s = -(negative as i32);
    let m = if intra { mag } else { 2 * mag + 1 };
    let v = (m.wrapping_mul(weight).wrapping_mul(q2) >> 5).min(2047 - s);
    (v ^ s) - s
}

/// 7.4.2.3 and 7.4.3: reconstruction and saturation of one coefficient.
#[inline]
fn dequant(level: i32, weight: i32, qscale: i32, intra: bool) -> i32 {
    // |level| <= 2047, weight <= 255, qscale <= 112: at most about 1.2e8, far
    // inside i32, so wrapping arithmetic gives the same values without the
    // overflow branches GenX's checked Android builds would add.
    let value = if intra {
        level
            .wrapping_mul(weight)
            .wrapping_mul(qscale)
            .wrapping_mul(2)
            / 32
    } else {
        (2 * level + level.signum())
            .wrapping_mul(weight)
            .wrapping_mul(qscale)
            / 32
    };
    value.clamp(-2048, 2047)
}

fn plane_view(planes: &Planes, plane: usize, parity: Option<usize>) -> View<'_> {
    let (data, width, height) = match plane {
        0 => (&planes.y[..], planes.width, planes.height),
        1 => (&planes.cb[..], planes.width / 2, planes.height / 2),
        _ => (&planes.cr[..], planes.width / 2, planes.height / 2),
    };
    match parity {
        None => View {
            data,
            offset: 0,
            stride: width,
            width,
            lines: height,
        },
        Some(p) => View {
            data,
            offset: p * width,
            stride: 2 * width,
            width,
            lines: height / 2,
        },
    }
}
#[inline]
fn chroma(v: [i32; 2]) -> [i32; 2] {
    [v[0] / 2, v[1] / 2]
}

/// Frame prediction of a whole macroblock (frame pictures).
fn frame_prediction<K: Kit>(mb: &mut Mb, r: &Planes, mx: usize, my: usize, v: [i32; 2], avg: bool) {
    let (x, y) = ((mx * 16) as i32, (my * 16) as i32);
    predict::<K::Mc>(
        mb.y,
        mb.ys,
        16,
        16,
        plane_view(r, 0, None),
        x,
        y,
        v[0],
        v[1],
        avg,
    );
    let c = chroma(v);
    predict::<K::Mc>(
        mb.cb,
        mb.cs,
        8,
        8,
        plane_view(r, 1, None),
        x / 2,
        y / 2,
        c[0],
        c[1],
        avg,
    );
    predict::<K::Mc>(
        mb.cr,
        mb.cs,
        8,
        8,
        plane_view(r, 2, None),
        x / 2,
        y / 2,
        c[0],
        c[1],
        avg,
    );
}
/// Field prediction of one field's lines of a frame-picture macroblock: rows
/// `field`, `field` + 2, ... from reference field `sel`.
#[allow(clippy::too_many_arguments)]
fn field_rows<K: Kit>(
    mb: &mut Mb,
    r: &Planes,
    sel: usize,
    field: usize,
    mx: usize,
    my: usize,
    v: [i32; 2],
    avg: bool,
) {
    let (x, y) = ((mx * 16) as i32, (my * 8) as i32);
    predict::<K::Mc>(
        &mut mb.y[field * mb.ys..],
        2 * mb.ys,
        16,
        8,
        plane_view(r, 0, Some(sel)),
        x,
        y,
        v[0],
        v[1],
        avg,
    );
    let c = chroma(v);
    predict::<K::Mc>(
        &mut mb.cb[field * mb.cs..],
        2 * mb.cs,
        8,
        4,
        plane_view(r, 1, Some(sel)),
        x / 2,
        y / 2,
        c[0],
        c[1],
        avg,
    );
    predict::<K::Mc>(
        &mut mb.cr[field * mb.cs..],
        2 * mb.cs,
        8,
        4,
        plane_view(r, 2, Some(sel)),
        x / 2,
        y / 2,
        c[0],
        c[1],
        avg,
    );
}
/// Field-picture prediction of `lines` luma lines from line `top` of the macroblock.
#[allow(clippy::too_many_arguments)]
fn field_block<K: Kit>(
    mb: &mut Mb,
    r: &Planes,
    sel: usize,
    mx: usize,
    my: usize,
    top: usize,
    lines: usize,
    v: [i32; 2],
    avg: bool,
) {
    let (x, y) = ((mx * 16) as i32, (my * 16 + top) as i32);
    predict::<K::Mc>(
        &mut mb.y[top * mb.ys..],
        mb.ys,
        16,
        lines,
        plane_view(r, 0, Some(sel)),
        x,
        y,
        v[0],
        v[1],
        avg,
    );
    let c = chroma(v);
    let (ct, cl) = (top / 2, lines / 2);
    predict::<K::Mc>(
        &mut mb.cb[ct * mb.cs..],
        mb.cs,
        8,
        cl,
        plane_view(r, 1, Some(sel)),
        x / 2,
        y / 2,
        c[0],
        c[1],
        avg,
    );
    predict::<K::Mc>(
        &mut mb.cr[ct * mb.cs..],
        mb.cs,
        8,
        cl,
        plane_view(r, 2, Some(sel)),
        x / 2,
        y / 2,
        c[0],
        c[1],
        avg,
    );
}

/// 7.6.8: adds a block's samples to the prediction, saturating to 0..255.
/// Intra blocks have no prediction: their samples are the block's own.
fn add_block<K: Kit>(mb: &mut Mb, index: usize, field_dct: bool, intra: bool, block: &[i32; 64]) {
    let (ys, cs) = (mb.ys, mb.cs);
    let (plane, start, stride): (&mut [u8], usize, usize) = match index {
        0..=3 if field_dct => (&mut *mb.y, (index / 2) * ys + (index % 2) * 8, 2 * ys),
        0..=3 => (&mut *mb.y, (index / 2) * 8 * ys + (index % 2) * 8, ys),
        4 => (&mut *mb.cb, 0, cs),
        _ => (&mut *mb.cr, 0, cs),
    };
    // A sample (0..255) plus a residual (-256..255, limited by the inverse
    // DCT) cannot overflow; wrapping_add says so, which lets builds with
    // overflow checks (GenX's Android packages) vectorise the loop too.
    for (row, residual) in block.chunks_exact(8).enumerate() {
        let at = start + row * stride;
        let line: &mut [u8; 8] = (&mut plane[at..at + 8]).try_into().expect("8 samples");
        let residual: &[i32; 8] = residual.try_into().expect("8 residuals");
        K::Add::add_row(line, residual, intra);
    }
}

// This module's parts, by area, are in macroblock/.
mod slices;
pub(crate) use slices::*;
mod block_add;
pub(crate) use block_add::*;
#[cfg(test)]
mod tests;
