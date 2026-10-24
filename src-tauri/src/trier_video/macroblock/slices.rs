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

//! Dividing a picture's slices into bands for the decoding threads (Band,
//! Slicer and its constructor), and the decoder's per-picture slice run with
//! concealment of missing rows. The per-macroblock decoding itself stays in
//! macroblock.rs, next to the prediction it inlines.

use super::*;

/// The part of the frame one slice worker writes: the planes' samples from
/// macroblock row `first_row` up to (not including) the next worker's first
/// row, as exclusive borrows, so two workers can never write the same samples.
pub(crate) struct Band<'a> {
    pub(super) y: &'a mut [u8],
    pub(super) cb: &'a mut [u8],
    pub(super) cr: &'a mut [u8],
    /// Where `y` and `cb`/`cr` start within the whole planes.
    pub(super) y_at: usize,
    pub(super) c_at: usize,
    /// Luma width of the planes.
    pub(super) width: usize,
    /// The macroblock rows this worker's slices reached.
    pub(super) rows_seen: Vec<bool>,
}

impl<'a> Band<'a> {
    /// Sets macroblock row `row` to black, both fields' lines of it (only done
    /// for the frame picture or the first field, before anything is written).
    pub(super) fn clear_row(&mut self, ctx: Ctx, row: usize) {
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
    pub(super) fn whole(planes: &'a mut Planes, rows: usize) -> Self {
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
    pub(super) fn bands(planes: &'a mut Planes, ctx: Ctx, cuts: &[usize]) -> Vec<Self> {
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
pub(crate) struct Slicer<'a, K: Kit> {
    pub(super) seq: &'a Sequence,
    pub(super) pic: Picture,
    pub(super) scan: [u8; 64],
    pub(super) older: Option<&'a Planes>,
    pub(super) newer: Option<&'a Planes>,
    /// The first field of a field pair (if any) and its copy, which the second
    /// field of a P frame may predict from.
    pub(super) first: Option<u8>,
    pub(super) copy: Option<&'a Planes>,
    pub(super) pmv: [[[i32; 2]; 2]; 2],
    pub(super) field_select: [[bool; 2]; 2],
    pub(super) vectors: [[[i32; 2]; 2]; 4],
    pub(super) dc_pred: [i32; 3],
    pub(super) qscale: i32,
    pub(super) last: Motion,
    /// One macroblock's coefficient blocks, then its residuals (inverse DCT).
    pub(super) blocks: [[i32; 64]; 6],
    /// For each block, the furthest row or column (0..7) a coded coefficient
    /// reached; the inverse DCT does only that corner (`InverseDct::inverse_within`).
    pub(super) reach: [u8; 6],
    /// Negative-offset coefficient decoding: per scan position (non-intra
    /// [0], intra [1]): raster position (bits 0..6), its row/column reach
    /// (6..9) and the matrix weight (9..17).
    pub(super) weights: [[u32; 64]; 2],
    /// Two-codes-per-read tables for the kit's window (B.14 [0], B.15 [1]).
    pub(super) pairs: [&'static [u64]; 2],
    pub(super) stats: Stats,
    pub(super) kit: PhantomData<K>,
}

impl<'a, K: Kit> Slicer<'a, K> {
    pub(super) fn new(
        d: &'a Decoder,
        seq: &'a Sequence,
        first: Option<u8>,
        copy: Option<&'a Planes>,
    ) -> Self {
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
pub(super) fn slice_row(seq: &Sequence, code: u8, body: &[u8]) -> usize {
    let mut row = code as usize - 1;
    if seq.height > 2800 {
        row += ((body.first().copied().unwrap_or(0) >> 5) as usize) << 7;
    }
    row
}

/// Slices of fewer macroblock rows than this are decoded on one core.
pub(super) const PARALLEL_ROWS: usize = 8;

/// Slice data per worker in adaptive mode (A&E: P pictures about 11 KB, I
/// pictures about 69 KB).
pub(super) const ADAPTIVE_BYTES: usize = 20_000;

impl Decoder {
    /// The macroblock geometry of the picture (frame or field) being decoded.
    pub(super) fn picture_ctx(&self, seq: &Sequence) -> Ctx {
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
    pub(crate) fn conceal_missing_rows(&mut self) {
        with_kit!(self.kit, K => self.conceal_missing_rows_with::<K>())
    }
    pub(super) fn conceal_missing_rows_with<K: Kit>(&mut self) {
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
    pub(crate) fn run_slices(&mut self, slices: &[(u8, &[u8])]) {
        with_kit!(self.kit, K => self.run_slices_with::<K>(slices))
    }
    pub(super) fn run_slices_with<K: Kit>(&mut self, slices: &[(u8, &[u8])]) {
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
