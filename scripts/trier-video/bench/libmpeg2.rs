//! libmpeg2 0.5.1 as a reference decoder in the scorecard (build.rs):
//!
//! decode-libmpeg2 <in.m2v> <out.yuv>     raw yuv420p in display order
//! speed-libmpeg2  <in.m2v> [repeats]     decoding time only, as Trier's is measured
use std::io::Write;
use std::time::Instant;

#[repr(C)]
struct Sequence {
    width: u32,
    height: u32,
    chroma_width: u32,
    chroma_height: u32,
    byte_rate: u32,
    vbv_buffer_size: u32,
    flags: u32,
    picture_width: u32,
    picture_height: u32,
    // The remaining fields are not read.
}
#[repr(C)]
struct Fbuf {
    buf: [*mut u8; 3],
    id: *mut std::ffi::c_void,
}
#[repr(C)]
struct Info {
    sequence: *const Sequence,
    gop: *const std::ffi::c_void,
    current_picture: *const std::ffi::c_void,
    current_picture_2nd: *const std::ffi::c_void,
    current_fbuf: *const Fbuf,
    display_picture: *const std::ffi::c_void,
    display_picture_2nd: *const std::ffi::c_void,
    display_fbuf: *const Fbuf,
    discard_fbuf: *const Fbuf,
    user_data: *const u8,
    user_data_len: u32,
}
const STATE_BUFFER: i32 = 0;
const STATE_SLICE: i32 = 7;
const STATE_END: i32 = 8;
const STATE_INVALID_END: i32 = 10;
const ACCEL_DETECT: u32 = 0x8000_0000;

extern "C" {
    fn mpeg2_accel(accel: u32) -> u32;
    fn mpeg2_init() -> *mut std::ffi::c_void;
    fn mpeg2_info(d: *mut std::ffi::c_void) -> *const Info;
    fn mpeg2_close(d: *mut std::ffi::c_void);
    fn mpeg2_buffer(d: *mut std::ffi::c_void, start: *mut u8, end: *mut u8);
    fn mpeg2_parse(d: *mut std::ffi::c_void) -> i32;
}

/// One displayed frame: planes, their strides (luma, chroma), visible size.
struct Shown<'a> {
    planes: [&'a [u8]; 3],
    stride: usize,
    chroma_stride: usize,
    width: usize,
    height: usize,
}
/// Decodes `es` in 64 KB pieces (as a player feeds it), calling `frame` with
/// each displayed frame; returns the seconds spent inside libmpeg2 and the
/// accelerations it chose.
fn run(es: &mut Vec<u8>, mut frame: impl FnMut(&Shown)) -> (f64, u32) {
    // The last picture is displayed at the sequence end code.
    if !es.ends_with(&[0, 0, 1, 0xB7]) {
        es.extend_from_slice(&[0, 0, 1, 0xB7]);
    }
    let accel = unsafe { mpeg2_accel(ACCEL_DETECT) };
    let d = unsafe { mpeg2_init() };
    assert!(!d.is_null(), "mpeg2_init");
    let info = unsafe { mpeg2_info(d) };
    let mut seconds = 0f64;
    let mut at = 0usize;
    loop {
        let started = Instant::now();
        let state = unsafe { mpeg2_parse(d) };
        seconds += started.elapsed().as_secs_f64();
        match state {
            STATE_BUFFER => {
                if at >= es.len() {
                    break;
                }
                let end = (at + 65536).min(es.len());
                let base = es.as_mut_ptr();
                unsafe { mpeg2_buffer(d, base.add(at), base.add(end)) };
                at = end;
            }
            STATE_SLICE | STATE_END | STATE_INVALID_END => unsafe {
                let i = &*info;
                if !i.display_fbuf.is_null() && !i.sequence.is_null() {
                    let s = &*i.sequence;
                    let f = &*i.display_fbuf;
                    let (w, h) = (s.width as usize, s.height as usize);
                    let (cw, ch) = (s.chroma_width as usize, s.chroma_height as usize);
                    frame(&Shown {
                        planes: [
                            std::slice::from_raw_parts(f.buf[0], w * h),
                            std::slice::from_raw_parts(f.buf[1], cw * ch),
                            std::slice::from_raw_parts(f.buf[2], cw * ch),
                        ],
                        stride: w,
                        chroma_stride: cw,
                        width: s.picture_width as usize,
                        height: s.picture_height as usize,
                    });
                }
            },
            _ => {}
        }
    }
    unsafe { mpeg2_close(d) };
    (seconds, accel)
}

pub fn command(args: &[String]) -> Option<i32> {
    match args.get(1).map(String::as_str)? {
        "decode-libmpeg2" => {
            let mut es = std::fs::read(&args[2]).expect("read input");
            let mut out = std::io::BufWriter::new(std::fs::File::create(&args[3]).expect("create"));
            let mut frames = 0usize;
            let mut size = (0, 0);
            let (seconds, accel) = run(&mut es, |f| {
                for row in 0..f.height {
                    let at = row * f.stride;
                    out.write_all(&f.planes[0][at..at + f.width]).expect("write");
                }
                for plane in &f.planes[1..] {
                    for row in 0..f.height / 2 {
                        let at = row * f.chroma_stride;
                        out.write_all(&plane[at..at + f.width / 2]).expect("write");
                    }
                }
                frames += 1;
                size = (f.width, f.height);
            });
            out.flush().expect("flush");
            println!(
                "{{\"decoder\":\"libmpeg2\",\"frames\":{frames},\"width\":{},\"height\":{},\"decodeSeconds\":{seconds:.4},\"accel\":{accel},\"panic\":false,\"errors\":0}}",
                size.0, size.1
            );
            Some(0)
        }
        "speed-libmpeg2" => {
            let es = std::fs::read(&args[2]).expect("read input");
            let repeats: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(3);
            let (mut total, mut frames, mut accel) = (0f64, 0usize, 0);
            for _ in 0..repeats {
                let mut copy = es.clone();
                let (s, a) = run(&mut copy, |_| frames += 1);
                total += s;
                accel = a;
            }
            println!(
                "{{\"decoder\":\"libmpeg2\",\"frames\":{frames},\"picturesPerSecond\":{:.1},\"meanUs\":{:.0},\"accel\":{accel}}}",
                frames as f64 / total,
                total * 1e6 / frames.max(1) as f64
            );
            Some(0)
        }
        _ => None,
    }
}
