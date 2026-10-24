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

//! Comparison tools for the decoder scorecard (docs/trier-mpeg-video.md):
//!
//! decode  <in.m2v> <out.yuv>                 Trier MPEG Video to raw yuv420p, display order
//! compare <ref.yuv> <test.yuv> <w> <h> [align] frame-by-frame differences and PSNR
//! damage  <in.m2v> <out.m2v> <seed> <mode>    seeded damage: flip:N, loss:N, drop:P, cut:F
//!
//! Each prints one JSON line. Nothing here is GenX's player; it is for measuring.
use crate::access_units;
use crate::trier_video::{Decoder, Frame};
use std::io::Write;
use std::time::Instant;

pub fn run(args: &[String]) -> Option<i32> {
    match args.get(1).map(String::as_str)? {
        "decode" => Some(decode(&args[2], &args[3])),
        "compare" => Some(compare(
            &args[2],
            &args[3],
            args[4].parse().expect("width"),
            args[5].parse().expect("height"),
            args.get(6).map(String::as_str) == Some("align"),
        )),
        "damage" => Some(damage(&args[2], &args[3], args[4].parse().expect("seed"), &args[5])),
        _ => None,
    }
}

/// Visible samples of a frame as yuv420p.
fn write_frame(out: &mut impl Write, f: &Frame) -> std::io::Result<()> {
    let p = &f.planes;
    for row in 0..f.height {
        out.write_all(&p.y[row * p.width..row * p.width + f.width])?;
    }
    let (cw, ch, stride) = (f.width / 2, f.height / 2, p.width / 2);
    for plane in [&p.cb, &p.cr] {
        for row in 0..ch {
            out.write_all(&plane[row * stride..row * stride + cw])?;
        }
    }
    Ok(())
}

fn decode(input: &str, output: &str) -> i32 {
    let es = std::fs::read(input).expect("read input");
    let units = access_units(&es);
    let mut out = std::io::BufWriter::new(std::fs::File::create(output).expect("create output"));
    let mut decoder = Decoder::new();
    decoder.set_threads(crate::threads());
    decoder.set_kit(crate::kit()).expect("kit available on this CPU");
    let (mut frames, mut errors, mut seconds) = (0usize, 0usize, 0f64);
    let mut size = (0, 0);
    let mut panicked = false;
    let mut emit = |list: Vec<Frame>, out: &mut std::io::BufWriter<std::fs::File>| {
        for f in list {
            size = (f.width, f.height);
            write_frame(out, &f).expect("write");
            frames += 1;
        }
    };
    for (i, &(unit, _)) in units.iter().enumerate() {
        let started = Instant::now();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            decoder.decode(unit, i as i64)
        }));
        seconds += started.elapsed().as_secs_f64();
        match result {
            Ok(Ok(list)) => emit(list, &mut out),
            Ok(Err(_)) => errors += 1,
            Err(_) => {
                // A panic is an unsafe failure: reported, never hidden.
                panicked = true;
                break;
            }
        }
    }
    if !panicked {
        let rest = decoder.flush();
        emit(rest, &mut out);
    }
    out.flush().expect("flush");
    println!(
        "{{\"decoder\":\"trier\",\"pictures\":{},\"frames\":{frames},\"width\":{},\"height\":{},\"errors\":{errors},\"panic\":{panicked},\"decodeSeconds\":{seconds:.4},\"concealedSlices\":{}}}",
        units.len(),
        size.0,
        size.1,
        decoder.stats.concealed_slices
    );
    if panicked {
        101
    } else {
        0
    }
}

fn psnr(a: &[u8], b: &[u8]) -> (f64, u8, usize, usize) {
    let (mut sq, mut max, mut differ, mut beyond_one) = (0u64, 0u8, 0usize, 0usize);
    for (&x, &y) in a.iter().zip(b) {
        let d = x.abs_diff(y);
        sq += (d as u64) * (d as u64);
        max = max.max(d);
        differ += (d > 0) as usize;
        beyond_one += (d > 1) as usize;
    }
    let value = if sq == 0 {
        99.0
    } else {
        (10.0 * (255f64 * 255.0 / (sq as f64 / a.len() as f64)).log10()).min(99.0)
    };
    (value, max, differ, beyond_one)
}

fn compare(reference: &str, test: &str, width: usize, height: usize, align: bool) -> i32 {
    let size = width * height * 3 / 2;
    let r = std::fs::read(reference).expect("read reference");
    let t = std::fs::read(test).expect("read test");
    let refs: Vec<&[u8]> = r.chunks_exact(size).collect();
    let tests: Vec<&[u8]> = t.chunks_exact(size).collect();
    // Index alignment for clean streams (order must match). With `align` and
    // fewer output frames than reference frames, each output frame is matched
    // to the next reference frame unless one of the following three is
    // clearly better (by 3 dB): a dropped picture then costs only itself, and
    // a badly damaged stretch cannot run the alignment ahead.
    let mut pairs = Vec::new();
    if align && tests.len() != refs.len() {
        let mut next = 0usize;
        for (i, frame) in tests.iter().enumerate() {
            if next >= refs.len() {
                break;
            }
            let here = psnr(refs[next], frame).0;
            let (mut j, mut best) = (next, here);
            for (k, candidate) in refs.iter().enumerate().take(next + 4).skip(next + 1) {
                let p = psnr(candidate, frame).0;
                if p > best && p > here + 3.0 {
                    (j, best) = (k, p);
                }
            }
            pairs.push((j, i));
            next = j + 1;
        }
    } else {
        pairs = (0..refs.len().min(tests.len())).map(|i| (i, i)).collect();
    }
    let (mut identical, mut max, mut differ, mut beyond_one) = (0usize, 0u8, 0usize, 0usize);
    let (mut sum, mut low, mut first_diff) = (0f64, 99f64, None);
    for &(j, i) in &pairs {
        let (p, m, d, b) = psnr(refs[j], tests[i]);
        if std::env::var_os("TRIER_LAB_FRAMES").is_some() {
            eprintln!("frame {i} ref {j} {p:.2} dB");
        }
        if d == 0 {
            identical += 1;
        } else if first_diff.is_none() {
            first_diff = Some(i);
        }
        sum += p;
        low = low.min(p);
        max = max.max(m);
        differ += d;
        beyond_one += b;
    }
    let n = pairs.len().max(1) as f64;
    let samples = (pairs.len() * size).max(1) as f64;
    println!(
        "{{\"referenceFrames\":{},\"testFrames\":{},\"compared\":{},\"identicalFrames\":{identical},\"psnrMean\":{:.2},\"psnrMin\":{:.2},\"maxAbsDiff\":{max},\"samplesDiffering\":{:.6},\"samplesBeyondOne\":{:.6},\"firstDifferentFrame\":{}}}",
        refs.len(),
        tests.len(),
        pairs.len(),
        sum / n,
        if pairs.is_empty() { 0.0 } else { low },
        differ as f64 / samples,
        beyond_one as f64 / samples,
        first_diff.map_or("null".to_string(), |f| f.to_string())
    );
    0
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

/// Seeded damage, keeping the first picture's headers so a decoder can start:
/// flip:N  N random bit flips per megabyte;
/// loss:N  N lost transport packets (184 payload bytes removed) per megabyte;
/// drop:P  P percent of pictures removed whole (never the first);
/// cut:F   only the first F (0..1) of the stream kept;
/// intra:1 only the I pictures kept (each decodes on its own): the stream for
///         measuring I-picture cost, which sets the per-picture tail.
fn damage(input: &str, output: &str, seed: u64, mode: &str) -> i32 {
    let es = std::fs::read(input).expect("read input");
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let (kind, amount) = mode.split_once(':').expect("mode:amount");
    let keep = 64.min(es.len());
    let per_mb = |n: f64| ((es.len() as f64 / 1e6) * n).round().max(1.0) as usize;
    let out: Vec<u8> = match kind {
        "flip" => {
            let mut d = es.clone();
            for _ in 0..per_mb(amount.parse().expect("count")) {
                let at = keep + rng.below(d.len() - keep);
                d[at] ^= 1 << rng.below(8);
            }
            d
        }
        "loss" => {
            let mut lost = vec![false; es.len()];
            for _ in 0..per_mb(amount.parse().expect("count")) {
                let at = keep + rng.below(es.len() - keep);
                lost[at..(at + 184).min(es.len())].fill(true);
            }
            es.iter().zip(&lost).filter(|(_, &l)| !l).map(|(&b, _)| b).collect()
        }
        "drop" => {
            let percent: usize = amount.parse().expect("percent");
            let units = access_units(&es);
            let mut d = Vec::with_capacity(es.len());
            for (i, &(unit, _)) in units.iter().enumerate() {
                if i == 0 || rng.below(100) >= percent {
                    d.extend_from_slice(unit);
                }
            }
            d
        }
        "intra" => {
            let units = access_units(&es);
            let mut d = Vec::with_capacity(es.len());
            for &(unit, kind) in &units {
                if kind == 1 {
                    d.extend_from_slice(unit);
                }
            }
            d
        }
        "cut" => {
            let fraction: f64 = amount.parse().expect("fraction");
            es[..((es.len() as f64 * fraction) as usize).max(keep)].to_vec()
        }
        _ => panic!("unknown damage mode {kind}"),
    };
    std::fs::write(output, &out).expect("write output");
    println!("{{\"mode\":\"{mode}\",\"seed\":{seed},\"inBytes\":{},\"outBytes\":{}}}", es.len(), out.len());
    0
}
