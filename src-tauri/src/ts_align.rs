//! Realigns audio timestamps in MPEG transport stream segments whose audio is
//! stamped far from the video it is sent with. Measured on ACC Network
//! (October 19, 2026): every segment carried audio about 296 s earlier than
//! its video, so Media3 waited forever for sound matching the picture. The
//! web player tolerated it.
//!
//! Each segment that shows both a video and an audio timestamp is measured.
//! An audio stream more than [`THRESHOLD`] from its video gets a shift onto
//! the video timeline, kept for the relay session so the audio stays
//! continuous; it is re-decided only when the corrected gap leaves the
//! threshold again (a discontinuity: the source restarted with a new offset,
//! or fixed itself, which removes the shift). Streams within the threshold
//! (all ordinary ones) are never changed (MP01-MP03,
//! docs/lifecycle-media-invariants.md). Timestamps are 33-bit and wrap.

use std::collections::HashMap;

const PACKET: usize = 188;
const WRAP: i64 = 1 << 33;
/// Far beyond any real audio/video skew; well below the measured 296 s.
const THRESHOLD: i64 = 10 * 90_000;

#[derive(Default)]
pub(crate) struct TsAligner {
    /// Shift per audio PID; absent means unchanged. One per relay session.
    shifts: HashMap<u16, i64>,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Video,
    Audio,
}

fn kind(stream_type: u8) -> Option<Kind> {
    match stream_type {
        0x01 | 0x02 | 0x10 | 0x1b | 0x24 | 0x42 | 0xea => Some(Kind::Video),
        0x03 | 0x04 | 0x0f | 0x11 | 0x81 | 0x87 => Some(Kind::Audio),
        _ => None,
    }
}

/// The payload of a packet and whether it starts a unit, or None.
fn payload(packet: &[u8]) -> Option<(u16, bool, usize)> {
    if packet.len() != PACKET || packet[0] != 0x47 {
        return None;
    }
    let pid = (u16::from(packet[1] & 0x1f) << 8) | u16::from(packet[2]);
    let start = packet[1] & 0x40 != 0;
    let offset = match (packet[3] >> 4) & 3 {
        1 => 4,
        3 => 5 + usize::from(packet[4]),
        _ => return None,
    };
    (offset < PACKET).then_some((pid, start, offset))
}

/// Elementary stream kinds by PID, from the segment's PAT and PMT.
fn streams(segment: &[u8]) -> HashMap<u16, Kind> {
    let mut maps = Vec::new();
    let mut kinds = HashMap::new();
    for packet in segment.chunks_exact(PACKET) {
        let Some((pid, true, offset)) = payload(packet) else {
            continue;
        };
        let pointer = usize::from(packet[offset]);
        let at = offset + 1 + pointer;
        if at + 3 > PACKET {
            continue;
        }
        let length = (usize::from(packet[at + 1] & 0x0f) << 8) | usize::from(packet[at + 2]);
        let end = (at + 3 + length).min(PACKET).saturating_sub(4);
        if pid == 0 && packet[at] == 0x00 {
            let mut entry = at + 8;
            while entry + 4 <= end {
                let program = (u16::from(packet[entry]) << 8) | u16::from(packet[entry + 1]);
                if program != 0 {
                    maps.push(
                        (u16::from(packet[entry + 2] & 0x1f) << 8) | u16::from(packet[entry + 3]),
                    );
                }
                entry += 4;
            }
        } else if maps.contains(&pid) && packet[at] == 0x02 && at + 12 <= end {
            let info = (usize::from(packet[at + 10] & 0x0f) << 8) | usize::from(packet[at + 11]);
            let mut entry = at + 12 + info;
            while entry + 5 <= end {
                let elementary =
                    (u16::from(packet[entry + 1] & 0x1f) << 8) | u16::from(packet[entry + 2]);
                if let Some(kind) = kind(packet[entry]) {
                    kinds.insert(elementary, kind);
                }
                entry += 5
                    + ((usize::from(packet[entry + 3] & 0x0f) << 8)
                        | usize::from(packet[entry + 4]));
            }
        }
    }
    kinds
}

/// Where a PES header's PTS (and DTS, if present) start within the packet.
fn timestamps(packet: &[u8], offset: usize) -> Option<(usize, Option<usize>)> {
    let pes = &packet[offset..];
    if pes.len() < 9 || pes[..3] != [0, 0, 1] {
        return None;
    }
    let flags = pes[7] >> 6;
    if flags & 2 == 0 || pes.len() < 14 {
        return None;
    }
    let dts = (flags == 3 && pes.len() >= 19).then_some(offset + 14);
    Some((offset + 9, dts))
}

fn read(bytes: &[u8]) -> i64 {
    (i64::from(bytes[0] >> 1 & 7) << 30)
        | (i64::from(bytes[1]) << 22)
        | (i64::from(bytes[2] >> 1) << 15)
        | (i64::from(bytes[3]) << 7)
        | i64::from(bytes[4] >> 1)
}

fn write(bytes: &mut [u8], value: i64) {
    let value = value.rem_euclid(WRAP);
    bytes[0] = (bytes[0] & 0xf1) | (((value >> 30) & 7) as u8) << 1;
    bytes[1] = (value >> 22) as u8;
    bytes[2] = (((value >> 15) & 0x7f) as u8) << 1 | (bytes[2] & 1);
    bytes[3] = (value >> 7) as u8;
    bytes[4] = ((value & 0x7f) as u8) << 1 | (bytes[4] & 1);
}

/// The signed distance from `from` to `to` on the 33-bit timestamp circle.
fn distance(from: i64, to: i64) -> i64 {
    let d = (to - from).rem_euclid(WRAP);
    if d >= WRAP / 2 {
        d - WRAP
    } else {
        d
    }
}

impl TsAligner {
    /// Realigns one whole segment in place; anything that is not an MPEG
    /// transport stream passes through unchanged.
    pub(crate) fn apply(&mut self, segment: &mut [u8]) {
        if segment.len() < PACKET || !segment.len().is_multiple_of(PACKET) || segment[0] != 0x47 {
            return;
        }
        self.measure(segment);
        if self.shifts.is_empty() {
            return;
        }
        let shifts = &self.shifts;
        for packet in segment.chunks_exact_mut(PACKET) {
            let Some((pid, true, offset)) = payload(packet) else {
                continue;
            };
            let Some(&shift) = shifts.get(&pid) else {
                continue;
            };
            let Some((pts, dts)) = timestamps(packet, offset) else {
                continue;
            };
            let value = read(&packet[pts..pts + 5]);
            write(&mut packet[pts..pts + 5], value + shift);
            if let Some(dts) = dts {
                let value = read(&packet[dts..dts + 5]);
                write(&mut packet[dts..dts + 5], value + shift);
            }
        }
    }

    fn measure(&mut self, segment: &[u8]) {
        let kinds = streams(segment);
        let mut first: HashMap<u16, i64> = HashMap::new();
        for packet in segment.chunks_exact(PACKET) {
            let Some((pid, true, offset)) = payload(packet) else {
                continue;
            };
            if !kinds.contains_key(&pid) || first.contains_key(&pid) {
                continue;
            }
            if let Some((pts, _)) = timestamps(packet, offset) {
                first.insert(pid, read(&packet[pts..pts + 5]));
            }
        }
        let video = first
            .iter()
            .filter(|(pid, _)| kinds.get(pid) == Some(&Kind::Video))
            .min_by_key(|(pid, _)| **pid)
            .map(|(_, pts)| *pts);
        let audio: Vec<(u16, i64)> = first
            .iter()
            .filter(|(pid, _)| kinds.get(pid) == Some(&Kind::Audio))
            .map(|(pid, pts)| (*pid, *pts))
            .collect();
        // A segment without both keeps the current shifts; an audio-only or
        // video-only stream never has a pair, so it is never changed.
        let Some(video) = video else { return };
        for (pid, pts) in audio {
            let gap = distance(pts, video);
            let current = self.shifts.get(&pid).copied().unwrap_or(0);
            // Within tolerance of the current correction: keep it, so slow
            // drift never makes the audio jump (MP03).
            if (gap - current).abs() <= THRESHOLD {
                continue;
            }
            if gap.abs() > THRESHOLD {
                self.shifts.insert(pid, gap);
            } else {
                self.shifts.remove(&pid);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(pid: u16, start: bool, body: &[u8]) -> Vec<u8> {
        let mut p = vec![
            0x47,
            (if start { 0x40 } else { 0 }) | (pid >> 8) as u8,
            pid as u8,
            0x10,
        ];
        p.extend_from_slice(body);
        p.resize(PACKET, 0xff);
        p
    }
    fn section(table: u8, body: &[u8]) -> Vec<u8> {
        let mut s = vec![0, table, 0xb0, (body.len() + 4) as u8];
        s.extend_from_slice(body);
        s.extend_from_slice(&[0, 0, 0, 0]);
        s
    }
    fn pes(stream: u8, pts: i64, dts: Option<i64>) -> Vec<u8> {
        let mut p = vec![
            0,
            0,
            1,
            stream,
            0,
            0,
            0x80,
            if dts.is_some() { 0xc0 } else { 0x80 },
        ];
        p.push(if dts.is_some() { 10 } else { 5 });
        let mut field = [0u8; 5];
        field[0] = if dts.is_some() { 0x31 } else { 0x21 };
        field[2] = 1;
        field[4] = 1;
        write(&mut field, pts);
        p.extend_from_slice(&field);
        if let Some(dts) = dts {
            let mut field = [0x11, 0, 1, 0, 1];
            write(&mut field, dts);
            p.extend_from_slice(&field);
        }
        p
    }
    /// PAT, PMT (video PID 256 of `video_type`, audio PID 257), then PES packets.
    fn segment(video_type: u8, video: &[i64], audio: &[i64]) -> Vec<u8> {
        let mut s = packet(
            0,
            true,
            &section(0x00, &[0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00]),
        );
        s.extend(packet(
            0x1000,
            true,
            &section(
                0x02,
                &[
                    0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, video_type, 0xe1, 0x00, 0xf0, 0x00,
                    0x03, 0xe1, 0x01, 0xf0, 0x00,
                ],
            ),
        ));
        for (v, a) in video.iter().zip(audio) {
            s.extend(packet(256, true, &pes(0xe0, *v, Some(*v - 3003))));
            s.extend(packet(256, false, &[0; 4]));
            s.extend(packet(257, true, &pes(0xc0, *a, None)));
        }
        s
    }
    fn pts_of(segment: &[u8], pid: u16) -> Vec<(i64, Option<i64>)> {
        segment
            .chunks_exact(PACKET)
            .filter_map(|p| {
                let (id, start, offset) = payload(p)?;
                if id != pid || !start {
                    return None;
                }
                let (pts, dts) = timestamps(p, offset)?;
                Some((read(&p[pts..pts + 5]), dts.map(|d| read(&p[d..d + 5]))))
            })
            .collect()
    }
    const S: i64 = 90_000;

    #[test]
    fn audio_stamped_minutes_early_is_moved_onto_the_video_timeline_for_the_whole_session() {
        let mut aligner = TsAligner::default();
        let video = [1_000 * S, 1_000 * S + 1_501];
        let audio = [704 * S, 704 * S + 2_160];
        let mut first = segment(0x02, &video, &audio);
        aligner.apply(&mut first);
        assert_eq!(
            pts_of(&first, 257),
            vec![(1_000 * S, None), (1_000 * S + 2_160, None)]
        );
        // Video untouched, DTS included.
        assert_eq!(pts_of(&first, 256)[0], (1_000 * S, Some(1_000 * S - 3003)));
        // A later segment keeps the same shift, so audio stays continuous.
        let mut later = segment(0x02, &[1_004 * S], &[708 * S + 500]);
        aligner.apply(&mut later);
        assert_eq!(pts_of(&later, 257), vec![(1_004 * S + 500, None)]);
    }

    #[test]
    fn ordinary_skew_and_streams_without_a_pair_are_never_changed() {
        let mut aligner = TsAligner::default();
        let original = segment(0x1b, &[50 * S], &[50 * S - 45_000]);
        let mut copy = original.clone();
        aligner.apply(&mut copy);
        assert_eq!(copy, original);
        // Just inside the threshold is still ordinary (MP01).
        let edge = segment(0x1b, &[60 * S], &[60 * S - THRESHOLD]);
        let mut copy = edge.clone();
        aligner.apply(&mut copy);
        assert_eq!(copy, edge);
        // Not a transport stream.
        let mut text = b"#EXTM3U\n".to_vec();
        TsAligner::default().apply(&mut text);
        assert_eq!(text, b"#EXTM3U\n");
    }

    #[test]
    fn the_33_bit_wrap_is_crossed_in_both_directions() {
        // Video just after the wrap, audio 296 s earlier (before the wrap).
        let mut aligner = TsAligner::default();
        let mut s = segment(0x02, &[100 * S], &[WRAP - 196 * S]);
        aligner.apply(&mut s);
        assert_eq!(pts_of(&s, 257), vec![(100 * S, None)]);
        // Audio that wraps later in the session lands past the video wrap too.
        let mut later = segment(0x02, &[WRAP - 10], &[WRAP - 296 * S - 10]);
        let mut aligner = TsAligner::default();
        aligner.apply(&mut later);
        assert_eq!(pts_of(&later, 257), vec![(WRAP - 10, None)]);
    }

    #[test]
    fn damaged_segments_never_panic() {
        let base = segment(0x02, &[1_000 * S], &[700 * S]);
        for cut in [0, 1, 187, 188, 189, 376, base.len() - 1] {
            let mut part = base[..cut].to_vec();
            TsAligner::default().apply(&mut part);
        }
        let mut noise: Vec<u8> = (0..188 * 8).map(|i| (i * 37 % 251) as u8).collect();
        for i in (0..noise.len()).step_by(188) {
            noise[i] = 0x47;
        }
        TsAligner::default().apply(&mut noise);
    }

    /// A real ACC Network segment, when GENX_TS_SAMPLE names one.
    #[test]
    fn a_real_broadcast_segment_gets_aligned() {
        let Some(path) = std::env::var_os("GENX_TS_SAMPLE") else {
            return;
        };
        let mut bytes = std::fs::read(path).unwrap();
        let before_audio = pts_of(&bytes, 257)[0].0;
        let video = pts_of(&bytes, 256)[0].0;
        assert!(distance(before_audio, video).abs() > THRESHOLD);
        TsAligner::default().apply(&mut bytes);
        assert_eq!(pts_of(&bytes, 257)[0].0, video);
        println!(
            "aligned audio by {:.3} s",
            distance(before_audio, video) as f64 / 90_000.0
        );
    }

    #[test]
    fn a_discontinuity_re_decides_and_slow_drift_does_not_mp02_mp03() {
        let mut aligner = TsAligner::default();
        let mut first = segment(0x02, &[1_000 * S], &[704 * S]);
        aligner.apply(&mut first);
        assert_eq!(pts_of(&first, 257)[0].0, 1_000 * S);
        // Slow drift (0.6 s) keeps the same shift: audio stays continuous.
        let mut drift = segment(0x02, &[1_004 * S], &[708 * S + 54_000]);
        aligner.apply(&mut drift);
        assert_eq!(pts_of(&drift, 257)[0].0, 1_004 * S + 54_000);
        // The source restarts with audio 120 s early: a new shift.
        let mut restart = segment(0x02, &[50 * S], &[50 * S - 120 * S]);
        aligner.apply(&mut restart);
        assert_eq!(pts_of(&restart, 257)[0].0, 50 * S);
        // The source fixes itself: the shift is removed, nothing is changed.
        let healthy = segment(0x02, &[60 * S], &[60 * S - 9_000]);
        let mut copy = healthy.clone();
        aligner.apply(&mut copy);
        assert_eq!(copy, healthy);
    }

    #[test]
    fn corrected_audio_stays_in_order_mp03() {
        let mut aligner = TsAligner::default();
        let video: Vec<i64> = (0..20).map(|i| 1_000 * S + i * 3_003).collect();
        let audio: Vec<i64> = (0..20).map(|i| 704 * S + i * 2_160).collect();
        let mut s = segment(0x02, &video, &audio);
        aligner.apply(&mut s);
        let corrected: Vec<i64> = pts_of(&s, 257).into_iter().map(|(p, _)| p).collect();
        assert!(corrected.windows(2).all(|w| w[1] > w[0]));
        assert_eq!(corrected[0], video[0]);
    }

    #[test]
    fn each_relay_session_starts_uncorrected_mp02() {
        // A session that saw a broken stream must not carry its shift into the next.
        let mut broken = segment(0x02, &[1_000 * S], &[704 * S]);
        TsAligner::default().apply(&mut broken);
        let healthy = segment(0x02, &[1_000 * S], &[1_000 * S - 9_000]);
        let mut copy = healthy.clone();
        TsAligner::default().apply(&mut copy);
        assert_eq!(copy, healthy);
    }
}
