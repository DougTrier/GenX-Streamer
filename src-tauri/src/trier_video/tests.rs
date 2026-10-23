//! Whole-stream tests: streams generated with the project's ffmpeg
//! (node_modules/ffmpeg-static, a measuring yardstick only, never shipped),
//! decoded here and compared frame by frame with ffmpeg's own decode.
use super::*;
use std::path::PathBuf;
use std::process::Command;

fn ffmpeg() -> Option<PathBuf> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../node_modules/ffmpeg-static/ffmpeg.exe");
    path.exists().then_some(path)
}

/// Splits an elementary stream into the units a demultiplexer would hand over:
/// each picture with the sequence/GOP headers (and their extensions) in front.
pub(super) fn access_units(es: &[u8]) -> Vec<&[u8]> {
    let codes = start_codes(es);
    let mut cuts = vec![0usize];
    let mut pictures = 0;
    for (i, &(code, after)) in codes.iter().enumerate() {
        if code != 0x00 {
            continue;
        }
        pictures += 1;
        if pictures == 1 {
            continue;
        }
        let mut cut = after - 4;
        let mut j = i;
        while j > 0 {
            let (c, a) = codes[j - 1];
            let extension = es.get(a).map(|b| b >> 4);
            let belongs =
                matches!(c, 0xB3 | 0xB8) || (c == 0xB5 && matches!(extension, Some(1) | Some(2)));
            if !belongs || a - 4 <= *cuts.last().unwrap() {
                break;
            }
            cut = a - 4;
            j -= 1;
        }
        cuts.push(cut);
    }
    cuts.push(es.len());
    cuts.windows(2)
        .map(|w| &es[w[0]..w[1]])
        .filter(|u| !u.is_empty())
        .collect()
}

struct Clip {
    width: usize,
    height: usize,
    es: Vec<u8>,
    reference: Vec<u8>,
}
fn make_clip(name: &str, args: &[&str], width: usize, height: usize) -> Option<Clip> {
    let ff = ffmpeg()?;
    let dir = std::env::temp_dir().join("genx-trier-video");
    std::fs::create_dir_all(&dir).ok()?;
    let es = dir.join(format!("{name}.m2v"));
    let yuv = dir.join(format!("{name}.yuv"));
    let size = format!("{width}x{height}");
    let source = format!("testsrc2=size={size}:rate=25");
    let mut encode = Command::new(&ff);
    encode.args([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        &source,
        "-t",
        "2",
        "-c:v",
        "mpeg2video",
    ]);
    encode.args(args);
    encode.args(["-f", "mpeg2video"]).arg(&es);
    assert!(encode.status().ok()?.success(), "encode {name}");
    let status = Command::new(&ff)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-idct",
            "faani",
            "-i",
        ])
        .arg(&es)
        .args(["-f", "rawvideo", "-pix_fmt", "yuv420p"])
        .arg(&yuv)
        .status()
        .ok()?;
    assert!(status.success(), "reference decode {name}");
    Some(Clip {
        width,
        height,
        es: std::fs::read(&es).ok()?,
        reference: std::fs::read(&yuv).ok()?,
    })
}

fn decode_all(es: &[u8]) -> Vec<Frame> {
    decode_with(es, 1)
}
fn decode_with(es: &[u8], threads: usize) -> Vec<Frame> {
    let mut d = Decoder::new();
    d.set_threads(threads);
    let mut frames = Vec::new();
    for (i, unit) in access_units(es).into_iter().enumerate() {
        frames.extend(d.decode(unit, i as i64).expect("decodes"));
    }
    frames.extend(d.flush());
    frames
}

/// Peak signal-to-noise ratio of the visible picture against reference frame `index`.
fn psnr(frame: &Frame, clip: &Clip, index: usize) -> f64 {
    let (w, h) = (clip.width, clip.height);
    let frame_size = w * h * 3 / 2;
    let reference = &clip.reference[index * frame_size..(index + 1) * frame_size];
    let mut sq = 0f64;
    let planes = [
        (&frame.planes.y, frame.planes.width, w, h, 0),
        (
            &frame.planes.cb,
            frame.planes.width / 2,
            w / 2,
            h / 2,
            w * h,
        ),
        (
            &frame.planes.cr,
            frame.planes.width / 2,
            w / 2,
            h / 2,
            w * h * 5 / 4,
        ),
    ];
    for (data, stride, pw, ph, offset) in planes {
        for y in 0..ph {
            for x in 0..pw {
                let d = data[y * stride + x] as f64 - reference[offset + y * pw + x] as f64;
                sq += d * d;
            }
        }
    }
    let mse = sq / frame_size as f64;
    if mse == 0.0 {
        99.0
    } else {
        10.0 * (255.0 * 255.0 / mse).log10()
    }
}

fn check(name: &str, args: &[&str], width: usize, height: usize, min_psnr: f64) {
    let Some(clip) = make_clip(name, args, width, height) else {
        eprintln!("ffmpeg not available: {name} skipped");
        return;
    };
    let frames = decode_all(&clip.es);
    let expected = clip.reference.len() / (width * height * 3 / 2);
    assert_eq!(frames.len(), expected, "{name}: frame count");
    let mut worst = f64::MAX;
    for (i, frame) in frames.iter().enumerate() {
        assert_eq!((frame.width, frame.height), (width, height));
        let p = psnr(frame, &clip, i);
        worst = worst.min(p);
    }
    eprintln!("{name}: {} frames, worst PSNR {worst:.2} dB", frames.len());
    assert!(
        worst >= min_psnr,
        "{name}: worst PSNR {worst:.2} dB < {min_psnr}"
    );
}

#[test]
fn progressive_ipb() {
    check(
        "progressive",
        &["-g", "12", "-bf", "2", "-b:v", "1500k"],
        352,
        288,
        45.0,
    );
}
#[test]
fn intra_only_high_quality() {
    check("intra", &["-g", "1", "-q:v", "2"], 352, 288, 48.0);
}
#[test]
fn intra_vlc_alternate_scan_nonlinear_quant_dc_precision() {
    check(
        "options",
        &[
            "-g",
            "12",
            "-bf",
            "2",
            "-intra_vlc",
            "1",
            "-alternate_scan",
            "1",
            "-non_linear_quant",
            "1",
            "-qmax",
            "28",
            "-dc",
            "10",
            "-b:v",
            "2000k",
        ],
        352,
        288,
        45.0,
    );
}
#[test]
fn interlaced_field_dct_and_field_motion() {
    check(
        "interlaced",
        &[
            "-g",
            "12",
            "-bf",
            "2",
            "-flags",
            "+ildct+ilme",
            "-top",
            "1",
            "-b:v",
            "4000k",
        ],
        720,
        576,
        45.0,
    );
}
#[test]
fn hd_720p_like_broadcast() {
    check(
        "hd",
        &["-g", "15", "-bf", "2", "-b:v", "8000k", "-intra_vlc", "1"],
        1280,
        720,
        45.0,
    );
}
#[test]
fn damaged_data_never_panics() {
    let Some(clip) = make_clip("damage", &["-g", "12", "-bf", "2"], 352, 288) else {
        return;
    };
    let mut es = clip.es.clone();
    // Corrupt bytes throughout (not start codes) and decode everything.
    let mut x: u32 = 12345;
    for i in (100..es.len()).step_by(97) {
        x = x.wrapping_mul(1103515245).wrapping_add(12345);
        if es[i] > 1 {
            es[i] = (x >> 16) as u8 | 2;
        }
    }
    let frames = decode_all(&es);
    assert!(!frames.is_empty());
    // Truncated and random data.
    let mut d = Decoder::new();
    let _ = d.decode(&es[..es.len() / 3], 0);
    let noise: Vec<u8> = (0..5000u32)
        .map(|i| (i.wrapping_mul(2654435761) >> 24) as u8)
        .collect();
    let _ = d.decode(&noise, 1);
    let _ = d.flush();
}

/// Slice decoding on 2, 3, 4 or 8 cores gives exactly the pictures one core gives:
/// progressive and interlaced (field DCT and field motion), clean and damaged
/// (concealment runs in the worker that owns the row).
#[test]
fn two_threads_give_the_same_pictures() {
    let clips = [
        (
            "threads-hd",
            vec!["-g", "15", "-bf", "2", "-b:v", "8000k"],
            1280,
            720,
        ),
        (
            "threads-interlaced",
            vec![
                "-g",
                "12",
                "-bf",
                "2",
                "-flags",
                "+ildct+ilme",
                "-top",
                "1",
                "-b:v",
                "4000k",
            ],
            720,
            576,
        ),
    ];
    for (name, args, w, h) in clips {
        let Some(clip) = make_clip(name, &args, w, h) else {
            eprintln!("ffmpeg not available: {name} skipped");
            return;
        };
        let mut damaged = clip.es.clone();
        let mut x: u32 = 777;
        for i in (200..damaged.len()).step_by(211) {
            x = x.wrapping_mul(1103515245).wrapping_add(12345);
            if damaged[i] > 1 {
                damaged[i] = (x >> 16) as u8 | 2;
            }
        }
        for (what, es) in [("clean", &clip.es), ("damaged", &damaged)] {
            let one = decode_with(es, 1);
            for threads in [2, 3, 4, 8] {
                let many = decode_with(es, threads);
                assert_eq!(
                    one.len(),
                    many.len(),
                    "{name} {what} {threads}: frame count"
                );
                for (i, (a, b)) in one.iter().zip(&many).enumerate() {
                    assert!(
                        a.planes.y == b.planes.y
                            && a.planes.cb == b.planes.cb
                            && a.planes.cr == b.planes.cr,
                        "{name} {what} {threads} threads: frame {i} differs"
                    );
                }
            }
        }
    }
}

/// The resource policy leaves at least half the cores to the rest of the
/// device and gives up spare frames when memory is short.
#[test]
fn resources_leave_room_for_the_rest_of_the_device() {
    let mb = 1u64 << 20;
    assert_eq!(Resources::for_machine(1, None).threads, 1);
    assert_eq!(Resources::for_machine(2, None).threads, 1);
    assert_eq!(Resources::for_machine(4, Some(2048 * mb)).threads, 2);
    assert_eq!(Resources::for_machine(8, Some(4096 * mb)).threads, 4);
    assert_eq!(Resources::for_machine(32, None).threads, 4);
    assert_eq!(
        Resources::for_machine(8, Some(4096 * mb)).spare_frames,
        SPARE_PLANES
    );
    assert_eq!(Resources::for_machine(8, Some(300 * mb)).spare_frames, 0);
    assert_eq!(Resources::for_machine(8, Some(100 * mb)).threads, 1);
}

/// Real broadcast captures (not in the repository): every `*.m2v` in the
/// folder named by TRIER_VIDEO_CAPTURES is decoded, compared frame by frame
/// with the yardstick's decode, and timed.
/// `TRIER_VIDEO_CAPTURES=dir cargo test --release --lib real_captures -- --ignored --nocapture`
#[test]
#[ignore]
fn real_captures() {
    let Ok(dir) = std::env::var("TRIER_VIDEO_CAPTURES") else {
        return;
    };
    let ff = ffmpeg().expect("ffmpeg");
    let mut names: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "m2v"))
        .collect();
    names.sort();
    for path in names {
        let es = std::fs::read(&path).unwrap();
        let yuv = path.with_extension("yuv");
        let ok = Command::new(&ff)
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-idct",
                "faani",
                "-i",
            ])
            .arg(&path)
            .args(["-f", "rawvideo", "-pix_fmt", "yuv420p"])
            .arg(&yuv)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let reference = std::fs::read(&yuv).unwrap();
        // Per-picture decode times: the tail (p95, p99, maximum) shows hitches an average hides.
        let started = std::time::Instant::now();
        let mut d = Decoder::new();
        let mut frames = Vec::new();
        let mut times = Vec::new();
        for (i, unit) in access_units(&es).into_iter().enumerate() {
            let t = std::time::Instant::now();
            frames.extend(d.decode(unit, i as i64).expect("decodes"));
            times.push(t.elapsed().as_micros() as u64);
        }
        frames.extend(d.flush());
        let elapsed = started.elapsed().as_secs_f64();
        times.sort_unstable();
        let at = |q: f64| times[((times.len() as f64 - 1.0) * q).round() as usize];
        let (w, h) = (frames[0].width, frames[0].height);
        let clip = Clip {
            width: w,
            height: h,
            es: Vec::new(),
            reference,
        };
        let expected = clip.reference.len() / (w * h * 3 / 2);
        let mut worst = f64::MAX;
        let mut sum = 0.0;
        let count = frames.len().min(expected);
        for (i, frame) in frames.iter().take(count).enumerate() {
            let p = psnr(frame, &clip, i);
            worst = worst.min(p);
            sum += p;
        }
        eprintln!(
            "{}: {}x{}, {} frames (reference {}), worst {:.2} dB, mean {:.2} dB, {:.0} frames/s, per picture p50 {} us p95 {} us p99 {} us max {} us",
            path.file_name().unwrap().to_string_lossy(),
            w,
            h,
            frames.len(),
            expected,
            worst,
            sum / count as f64,
            frames.len() as f64 / elapsed,
            at(0.5),
            at(0.95),
            at(0.99),
            times[times.len() - 1],
        );
        let _ = std::fs::remove_file(&yuv);
    }
}

/// Frames, and which units were refused with what error (damaged headers).
fn decode_kit(es: &[u8], threads: usize, kit: kit::KitId) -> (Vec<Frame>, Vec<(usize, Error)>) {
    let mut d = Decoder::new();
    d.set_threads(threads);
    d.set_kit(kit).expect("available kit");
    let (mut frames, mut errors) = (Vec::new(), Vec::new());
    for (i, unit) in access_units(es).into_iter().enumerate() {
        match d.decode(unit, i as i64) {
            Ok(out) => frames.extend(out),
            Err(e) => errors.push((i, e)),
        }
    }
    frames.extend(d.flush());
    (frames, errors)
}

/// Qualification of every registered kit (INV-AUTOTUNE-001, 002, 010): each
/// kit this CPU can run gives exactly the portable kit's pictures, clean and
/// damaged, on one worker and four, for progressive (B.14), interlaced
/// (field DCT and motion) and intra-VLC/alternate-scan (B.15) streams. A kit
/// added to the registry is covered here without further code.
#[test]
fn every_registered_kit_gives_the_portable_pictures() {
    let clips = [
        (
            "kits-progressive",
            vec!["-g", "15", "-bf", "2", "-b:v", "6000k"],
            704,
            480,
        ),
        (
            "kits-interlaced",
            vec![
                "-g",
                "12",
                "-bf",
                "2",
                "-flags",
                "+ildct+ilme",
                "-top",
                "1",
                "-b:v",
                "4000k",
            ],
            720,
            576,
        ),
        (
            "kits-intra-vlc",
            vec![
                "-g",
                "12",
                "-bf",
                "2",
                "-intra_vlc",
                "1",
                "-alternate_scan",
                "1",
                "-b:v",
                "3000k",
            ],
            352,
            288,
        ),
    ];
    for (name, args, w, h) in clips {
        let Some(clip) = make_clip(name, &args, w, h) else {
            eprintln!("ffmpeg not available: {name} skipped");
            return;
        };
        let mut damaged = clip.es.clone();
        let mut x: u32 = 4242;
        for i in (150..damaged.len()).step_by(173) {
            x = x.wrapping_mul(1103515245).wrapping_add(12345);
            if damaged[i] > 1 {
                damaged[i] = (x >> 16) as u8 | 2;
            }
        }
        for (what, es) in [("clean", &clip.es), ("damaged", &damaged)] {
            let (reference, refused) = decode_kit(es, 1, kit::KitId::Portable);
            assert!(!reference.is_empty());
            for k in kit::available() {
                for threads in [1, 4] {
                    let (got, got_refused) = decode_kit(es, threads, k.id);
                    assert_eq!(
                        refused, got_refused,
                        "{name} {what} {}: refused units",
                        k.name
                    );
                    assert_eq!(
                        reference.len(),
                        got.len(),
                        "{name} {what} {}: frame count",
                        k.name
                    );
                    for (i, (a, b)) in reference.iter().zip(&got).enumerate() {
                        assert!(
                            a.planes.y == b.planes.y
                                && a.planes.cb == b.planes.cb
                                && a.planes.cr == b.planes.cr,
                            "{name} {what} kit {} {threads} workers: frame {i} differs",
                            k.name
                        );
                    }
                }
            }
        }
    }
}

/// The registry is closed and consistent: unique names, the default first,
/// the portable kit needs nothing and is bit-exact, every kit of this build
/// that the CPU supports can be chosen, and the choice is kept.
#[test]
fn registry_is_consistent() {
    let names: Vec<&str> = kit::KITS.iter().map(|k| k.name).collect();
    let mut unique = names.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), names.len(), "unique kit names");
    assert_eq!(kit::KITS[0].id, kit::KitId::Default);
    let portable = kit::info_of(kit::KitId::Portable);
    assert_eq!(portable.requires, kit::Features::NONE);
    assert_eq!(portable.contract, kit::Contract::BitExact);
    assert!(kit::available().any(|k| k.id == kit::KitId::Portable));
    assert!(kit::available().any(|k| k.id == kit::KitId::Default));
    for k in kit::KITS {
        assert_eq!(kit::KitId::from_name(k.name), Some(k.id));
    }
    let mut d = Decoder::new();
    for k in kit::available() {
        d.set_kit(k.id).expect("available kit");
        assert_eq!(d.kit(), k.id);
    }
}
