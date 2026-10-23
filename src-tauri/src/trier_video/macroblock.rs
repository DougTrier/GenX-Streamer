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

/// The part of the frame one slice worker writes: the planes' samples from
/// macroblock row `first_row` up to (not including) the next worker's first
/// row, as exclusive borrows, so two workers can never write the same samples.
pub(super) struct Band<'a> {
    y: &'a mut [u8],
    cb: &'a mut [u8],
    cr: &'a mut [u8],
    /// Where `y` and `cb`/`cr` start within the whole planes.
    y_at: usize,
    c_at: usize,
    /// Luma width of the planes.
    width: usize,
    /// The macroblock rows this worker's slices reached.
    rows_seen: Vec<bool>,
}
impl<'a> Band<'a> {
    /// Sets macroblock row `row` to black, both fields' lines of it (only done
    /// for the frame picture or the first field, before anything is written).
    fn clear_row(&mut self, ctx: Ctx, row: usize) {
        let (lines, parity) = if ctx.frame_pic {
            (16, 0)
        } else {
            (32, ctx.parity)
        };
        let (w, cw) = (self.width, self.width / 2);
        let y = ((lines * row + parity) * w).saturating_sub(self.y_at);
        let y_end = ((lines * (row + 1) + parity) * w).saturating_sub(self.y_at);
        let c = ((lines / 2 * row + parity) * cw).saturating_sub(self.c_at);
        let c_end = ((lines / 2 * (row + 1) + parity) * cw).saturating_sub(self.c_at);
        let (y_end, c_end) = (y_end.min(self.y.len()), c_end.min(self.cb.len()));
        if y < y_end {
            self.y[y..y_end].fill(16);
        }
        if c < c_end {
            self.cb[c..c_end].fill(128);
            self.cr[c..c_end].fill(128);
        }
        // A bottom field first: line 0 (luma and chroma) lies above row 0's
        // lines and belongs to no band row.
        if row == 0 && parity == 1 && self.y_at == 0 {
            let n = w.min(self.y.len());
            self.y[..n].fill(16);
            let m = cw.min(self.cb.len());
            self.cb[..m].fill(128);
            self.cr[..m].fill(128);
        }
    }
    fn whole(planes: &'a mut Planes, rows: usize) -> Self {
        Band {
            width: planes.width,
            y: &mut planes.y,
            cb: &mut planes.cb,
            cr: &mut planes.cr,
            y_at: 0,
            c_at: 0,
            rows_seen: vec![false; rows],
        }
    }
    /// The frame cut into bands at macroblock rows `cuts` (ascending, each
    /// above 0): band i holds the rows from cuts[i - 1] (0 for the first) up to
    /// cuts[i]. Field pictures interleave their lines with the other field's,
    /// so a field's macroblock row spans 32 frame lines starting at its parity.
    fn bands(planes: &'a mut Planes, ctx: Ctx, cuts: &[usize]) -> Vec<Self> {
        let width = planes.width;
        let (lines, parity) = if ctx.frame_pic {
            (16, 0)
        } else {
            (32, ctx.parity)
        };
        let (mut y, mut cb, mut cr) = (&mut planes.y[..], &mut planes.cb[..], &mut planes.cr[..]);
        let (mut y_at, mut c_at) = (0, 0);
        let mut out = Vec::with_capacity(cuts.len() + 1);
        for &cut in cuts {
            let y_cut = ((lines * cut + parity) * width).clamp(y_at, y_at + y.len());
            let c_cut = ((lines / 2 * cut + parity) * (width / 2)).clamp(c_at, c_at + cb.len());
            let (y0, y1) = std::mem::take(&mut y).split_at_mut(y_cut - y_at);
            let (cb0, cb1) = std::mem::take(&mut cb).split_at_mut(c_cut - c_at);
            let (cr0, cr1) = std::mem::take(&mut cr).split_at_mut(c_cut - c_at);
            out.push(Band {
                y: y0,
                cb: cb0,
                cr: cr0,
                y_at,
                c_at,
                width,
                rows_seen: vec![false; ctx.mb_rows],
            });
            (y, cb, cr, y_at, c_at) = (y1, cb1, cr1, y_cut, c_cut);
        }
        out.push(Band {
            y,
            cb,
            cr,
            y_at,
            c_at,
            width,
            rows_seen: vec![false; ctx.mb_rows],
        });
        out
    }
}

/// The macroblock-level state of one slice worker, with the picture's shared,
/// read-only data (sequence, picture header, scan, reference pictures). Each
/// slice starts this state afresh (7.6.3.4, 7.2.1), so which worker decodes a
/// slice never changes its result (tested: one thread and two give the same
/// pictures).
pub(super) struct Slicer<'a, K: Kit> {
    seq: &'a Sequence,
    pic: Picture,
    scan: [u8; 64],
    older: Option<&'a Planes>,
    newer: Option<&'a Planes>,
    /// The first field of a field pair (if any) and its copy, which the second
    /// field of a P frame may predict from.
    first: Option<u8>,
    copy: Option<&'a Planes>,
    pmv: [[[i32; 2]; 2]; 2],
    field_select: [[bool; 2]; 2],
    vectors: [[[i32; 2]; 2]; 4],
    dc_pred: [i32; 3],
    qscale: i32,
    last: Motion,
    /// One macroblock's coefficient blocks, then its residuals (inverse DCT).
    blocks: [[i32; 64]; 6],
    /// For each block, the furthest row or column (0..7) a coded coefficient
    /// reached; the inverse DCT does only that corner (`InverseDct::inverse_within`).
    reach: [u8; 6],
    /// Negative-offset coefficient decoding: per scan position (non-intra
    /// [0], intra [1]): raster position (bits 0..6), its row/column reach
    /// (6..9) and the matrix weight (9..17).
    weights: [[u32; 64]; 2],
    /// Two-codes-per-read tables for the kit's window (B.14 [0], B.15 [1]).
    pairs: [&'static [u64]; 2],
    stats: Stats,
    kit: PhantomData<K>,
}
impl<'a, K: Kit> Slicer<'a, K> {
    fn new(d: &'a Decoder, seq: &'a Sequence, first: Option<u8>, copy: Option<&'a Planes>) -> Self {
        let mut weights = [[0u32; 64]; 2];
        if K::Coef::NEGATIVE_OFFSET {
            for (table, matrix) in weights.iter_mut().zip([&seq.non_intra, &seq.intra]) {
                for (entry, &raster) in table.iter_mut().zip(d.scan.iter()) {
                    let raster = raster as u32 & 63;
                    let corner = (raster >> 3).max(raster & 7);
                    *entry = raster | corner << 6 | (matrix[raster as usize] as u32) << 9;
                }
            }
        }
        Slicer {
            seq,
            pic: d.pic,
            scan: d.scan,
            older: d.older.as_deref(),
            newer: d.newer.as_deref(),
            first,
            copy,
            pmv: Default::default(),
            field_select: Default::default(),
            vectors: Default::default(),
            dc_pred: [0; 3],
            qscale: 0,
            last: Motion::default(),
            blocks: [[0; 64]; 6],
            reach: [0; 6],
            weights,
            pairs: if K::Coef::PAIRS {
                let t = pair_tables(K::Coef::PAIR_BITS);
                [&t[0], &t[1]]
            } else {
                [&[], &[]]
            },
            stats: Stats::default(),
            kit: PhantomData,
        }
    }
}

/// The macroblock row a slice belongs to, from its start code (and, above
/// 2,800 lines, the slice_vertical_position_extension: its first 3 bits).
fn slice_row(seq: &Sequence, code: u8, body: &[u8]) -> usize {
    let mut row = code as usize - 1;
    if seq.height > 2800 {
        row += ((body.first().copied().unwrap_or(0) >> 5) as usize) << 7;
    }
    row
}
/// Slices of fewer macroblock rows than this are decoded on one core.
const PARALLEL_ROWS: usize = 8;
/// Slice data per worker in adaptive mode (A&E: P pictures about 11 KB, I
/// pictures about 69 KB).
const ADAPTIVE_BYTES: usize = 20_000;

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

impl Decoder {
    /// The macroblock geometry of the picture (frame or field) being decoded.
    fn picture_ctx(&self, seq: &Sequence) -> Ctx {
        let frame_pic = self.pic.structure == FRAME;
        Ctx {
            frame_pic,
            parity: (self.pic.structure == BOTTOM) as usize,
            mb_width: seq.mb_width,
            mb_rows: if frame_pic {
                seq.mb_height
            } else {
                seq.mb_height / 2
            },
        }
    }

    /// At the end of a picture (frame or field): macroblock rows no slice
    /// reached (their start code was lost) are concealed from the newest
    /// reference instead of staying blank.
    pub(super) fn conceal_missing_rows(&mut self) {
        with_kit!(self.kit, K => self.conceal_missing_rows_with::<K>())
    }
    fn conceal_missing_rows_with<K: Kit>(&mut self) {
        let Some(seq) = self.seq.clone() else { return };
        let Some(mut cur) = self.current.take() else {
            return;
        };
        let ctx = self.picture_ctx(&seq);
        let Current {
            planes,
            first_field,
            first_field_copy,
            rows_seen,
            cleared,
            ..
        } = &mut cur;
        let mut slicer = Slicer::<K>::new(self, &seq, *first_field, first_field_copy.as_deref());
        let mut band = Band::whole(planes, ctx.mb_rows);
        // Rows of a reused buffer that no slice reached are still to clear (the
        // frame picture or the first field: the second finds them black).
        if !cleared.is_empty() {
            cleared.resize(ctx.mb_rows, false);
            for row in 0..ctx.mb_rows {
                if !cleared[row] {
                    band.clear_row(ctx, row);
                }
            }
            cleared.clear();
        }
        for row in 0..ctx.mb_rows {
            if !rows_seen.get(row).copied().unwrap_or(false) {
                slicer.stats.concealed_slices += 1;
                for x in 0..ctx.mb_width {
                    slicer.conceal(&mut band, ctx, x, row);
                }
            }
        }
        let stats = slicer.stats;
        rows_seen.clear();
        self.stats.add(&stats);
        self.current = Some(cur);
    }

    /// Decodes a picture's slices (in stream order within each row). With two
    /// threads and enough rows, the top half of the rows is decoded here and
    /// the bottom half on a second core at the same time, each writing only
    /// its own band of the frame.
    pub(super) fn run_slices(&mut self, slices: &[(u8, &[u8])]) {
        with_kit!(self.kit, K => self.run_slices_with::<K>(slices))
    }
    fn run_slices_with<K: Kit>(&mut self, slices: &[(u8, &[u8])]) {
        if slices.is_empty() {
            return;
        }
        let Some(seq) = self.seq.clone() else { return };
        let Some(mut cur) = self.current.take() else {
            return;
        };
        let ctx = self.picture_ctx(&seq);
        let Current {
            planes,
            first_field,
            first_field_copy,
            rows_seen,
            cleared,
            ..
        } = &mut cur;
        rows_seen.resize(ctx.mb_rows, false);
        if !cleared.is_empty() {
            cleared.resize(ctx.mb_rows, false);
        }
        let to_clear = !cleared.is_empty();
        let copy = first_field_copy.as_deref();
        let work = |band: &mut Band, from: usize, to: usize, cleared: &mut [bool]| -> Stats {
            let cpu0 = tune::thread_cpu_us();
            let mut slicer = Slicer::<K>::new(self, &seq, *first_field, copy);
            for &(code, body) in slices {
                let row = slice_row(&seq, code, body);
                if (from..to).contains(&row) {
                    if let Some(c) = cleared.get_mut(row).filter(|c| !**c) {
                        band.clear_row(ctx, row);
                        *c = true;
                    }
                    slicer.slice(code, body, ctx, band);
                }
            }
            if let (Some(a), Some(b)) = (cpu0, tune::thread_cpu_us()) {
                slicer.stats.decode_cpu_us = b.saturating_sub(a);
            }
            slicer.stats
        };
        // Up to `threads` workers, at most one per PARALLEL_ROWS / 2 rows.
        // Adaptive: one worker per ADAPTIVE_BYTES of the picture's slice data,
        // so light pictures (most P and B pictures) stay on one core and only
        // heavy ones (I pictures, the tail) spread out; never more than
        // `threads`, nor more than one per PARALLEL_ROWS / 2 rows.
        let weight: usize = slices.iter().map(|&(_, body)| body.len()).sum();
        let wanted = if self.adaptive {
            1 + weight / ADAPTIVE_BYTES
        } else {
            self.threads
        };
        let workers = match &self.pool {
            Some(pool) if ctx.mb_rows >= PARALLEL_ROWS && slices.len() >= 2 => wanted
                .min(pool.threads())
                .min(ctx.mb_rows / (PARALLEL_ROWS / 2))
                .max(1),
            _ => 1,
        };
        let mut stats = Vec::with_capacity(workers);
        let mut seen = Vec::with_capacity(ctx.mb_rows);
        if workers > 1 {
            // Every macroblock row is its own exclusive band, and a worker takes
            // the next row with slices as soon as it is free: busy or slower
            // cores (big.LITTLE) simply take fewer rows, and dense rows balance
            // out by themselves. A row is never divided; within it the slices
            // keep their stream order.
            let mut by_row: Vec<Vec<(u8, &[u8])>> = vec![Vec::new(); ctx.mb_rows];
            for &(code, body) in slices {
                if let Some(list) = by_row.get_mut(slice_row(&seq, code, body)) {
                    list.push((code, body));
                }
            }
            let order: Vec<usize> = (0..ctx.mb_rows)
                .filter(|&r| !by_row[r].is_empty())
                .collect();
            let cuts: Vec<usize> = (1..ctx.mb_rows).collect();
            let bands: Vec<Mutex<Band>> = Band::bands(planes, ctx, &cuts)
                .into_iter()
                .map(Mutex::new)
                .collect();
            let next = AtomicUsize::new(0);
            let seats = AtomicUsize::new(0);
            let results = Mutex::new(Vec::with_capacity(workers));
            // Clearing a reused buffer's rows happens here too, row by row by
            // the worker that decodes the row, instead of all at once before.
            let row_cleared: Vec<AtomicBool> = (0..ctx.mb_rows)
                .map(|r| AtomicBool::new(!to_clear || cleared[r]))
                .collect();
            let job = || {
                // Only `workers` of the pool's threads take part in this picture.
                if seats.fetch_add(1, Ordering::Relaxed) >= workers {
                    return;
                }
                let cpu0 = tune::thread_cpu_us();
                let mut slicer = Slicer::<K>::new(self, &seq, *first_field, copy);
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(&row) = order.get(i) else { break };
                    // Uncontended: each row is taken by exactly one worker.
                    let mut band = bands[row].lock().unwrap_or_else(|e| e.into_inner());
                    if !row_cleared[row].swap(true, Ordering::Relaxed) {
                        band.clear_row(ctx, row);
                    }
                    for &(code, body) in &by_row[row] {
                        slicer.slice(code, body, ctx, &mut band);
                    }
                }
                if let (Some(a), Some(b)) = (cpu0, tune::thread_cpu_us()) {
                    slicer.stats.decode_cpu_us = b.saturating_sub(a);
                }
                results
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(slicer.stats);
            };
            // A panic in a helper is passed on, as it would be on one thread.
            self.pool.as_ref().expect("pool").run(&job);
            stats.extend(results.into_inner().unwrap_or_else(|e| e.into_inner()));
            if to_clear {
                for (c, r) in cleared.iter_mut().zip(&row_cleared) {
                    *c = r.load(Ordering::Relaxed);
                }
            }
            for band in bands {
                seen.push(
                    band.into_inner()
                        .unwrap_or_else(|e| e.into_inner())
                        .rows_seen,
                );
            }
        } else {
            let mut band = Band::whole(planes, ctx.mb_rows);
            stats.push(work(&mut band, 0, usize::MAX, cleared));
            seen.push(band.rows_seen);
        }
        for rows in &seen {
            for (r, &s) in rows_seen.iter_mut().zip(rows) {
                *r |= s;
            }
        }
        for st in &stats {
            self.stats.add(st);
        }
        self.current = Some(cur);
    }
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
fn add_row(line: &mut [u8; 8], residual: &[i32; 8], intra: bool) {
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
fn add_row_portable(line: &mut [u8; 8], residual: &[i32; 8], intra: bool) {
    for i in 0..8 {
        let base = if intra { 0 } else { line[i] as i32 };
        line[i] = base.wrapping_add(residual[i]).clamp(0, 255) as u8;
    }
}

#[cfg(test)]
mod tests {
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
                            second.is_none_or(
                                |s| s.1 == tables::PACKED_ESCAPE || l + s.0 > bits as u64
                            ),
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
}
