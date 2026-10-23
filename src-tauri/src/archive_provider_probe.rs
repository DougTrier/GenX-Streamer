//! Bounded structural inspection of the selected exact representation.
//! Provider labels and filename suffixes never establish codec support.
use crate::{
    archive_provider_contract::Provider, archive_provider_net as net, scan_manifest_work::Context,
};
use reqwest::Url;
use std::sync::Arc;
use tokio::time::Instant;
#[derive(Clone, Debug)]
pub(crate) struct Inspection {
    pub size: u64,
    pub mime: &'static str,
    pub video_codec: &'static str,
    pub audio_codec: Option<&'static str>,
}
pub(crate) struct Body {
    pub bytes: Vec<u8>,
    pub size: u64,
    pub mime: String,
}
pub(crate) async fn range(
    p: Provider,
    target: &Url,
    start: u64,
    end: u64,
    owner: &Arc<Context>,
    deadline: Instant,
) -> Result<Body, String> {
    net::check(owner, deadline)?;
    if net::retry_until(p).is_some() {
        return Err("public-archive-rate-limited".into());
    }
    if start > end || end - start >= 2 * 1024 * 1024 {
        return Err("public-archive-inspection-limit".into());
    }
    let c = net::client(
        owner,
        deadline,
        target.host_str().ok_or("public-archive-url-refused")?,
        p,
    )
    .await?;
    let work = async {
        let mut r = c
            .get(target.clone())
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
            .send()
            .await
            .map_err(|_| "public-archive-network-unavailable")?;
        if matches!(r.status().as_u16(), 401 | 403) {
            return Err("public-archive-access-refused".into());
        }
        if matches!(r.status().as_u16(), 429 | 503) {
            net::retain_retry(
                p,
                r.headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|h| h.to_str().ok()),
            );
            return Err("public-archive-rate-limited".into());
        }
        if r.status().as_u16() != 206
            || r.url() != target
            || r.headers()
                .get(reqwest::header::CONTENT_ENCODING)
                .is_some_and(|v| v.as_bytes() != b"identity")
        {
            return Err("public-archive-range-unverified".into());
        }
        let cr = r
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .ok_or("public-archive-range-unverified")?;
        let (span, total) = cr
            .strip_prefix("bytes ")
            .and_then(|s| s.split_once('/'))
            .ok_or("public-archive-range-unverified")?;
        let (first, last) = span
            .split_once('-')
            .ok_or("public-archive-range-unverified")?;
        let size = total
            .parse::<u64>()
            .ok()
            .filter(|n| (16..=64 * 1024 * 1024 * 1024).contains(n))
            .ok_or("public-archive-size-unverified")?;
        let actual_end = end.min(size - 1);
        if first != start.to_string()
            || last != actual_end.to_string()
            || start >= size
            || r.content_length() != Some(actual_end - start + 1)
        {
            return Err("public-archive-range-unverified".into());
        }
        let mime = r
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !matches!(mime.as_str(), "video/mp4" | "video/webm") {
            return Err("public-archive-format-unsupported".into());
        }
        let length = (actual_end - start + 1) as usize;
        let mut bytes = Vec::with_capacity(length);
        while let Some(part) = r
            .chunk()
            .await
            .map_err(|_| "public-archive-network-unavailable")?
        {
            net::check(owner, deadline)?;
            if bytes.len() + part.len() > length {
                return Err("public-archive-size-changed".into());
            }
            bytes.extend_from_slice(&part);
        }
        if bytes.len() != length {
            return Err("public-archive-size-changed".into());
        }
        net::check(owner, deadline)?;
        Ok(Body { bytes, size, mime })
    };
    tokio::time::timeout_at(deadline, work)
        .await
        .map_err(|_| "public-archive-timeout".to_owned())?
}
fn box_header(bytes: &[u8]) -> Result<(usize, [u8; 4], u64), String> {
    if bytes.len() < 8 {
        return Err("public-archive-container-unverified".into());
    }
    let n = u32::from_be_bytes(bytes[..4].try_into().unwrap());
    let kind = bytes[4..8].try_into().unwrap();
    if n == 1 {
        if bytes.len() < 16 {
            return Err("public-archive-container-unverified".into());
        }
        let size = u64::from_be_bytes(bytes[8..16].try_into().unwrap());
        if size < 16 {
            return Err("public-archive-container-unverified".into());
        }
        Ok((16, kind, size))
    } else if n >= 8 {
        Ok((8, kind, n as u64))
    } else {
        Err("public-archive-container-unverified".into())
    }
}
fn verified_moov_payload(
    bytes: &[u8],
    observed_header: usize,
    observed_size: u64,
) -> Result<&[u8], String> {
    let (header, kind, size) = box_header(bytes)?;
    if kind != *b"moov"
        || header != observed_header
        || size != observed_size
        || size != bytes.len() as u64
    {
        return Err("public-archive-container-changed".into());
    }
    Ok(&bytes[header..])
}
fn children(mut bytes: &[u8]) -> Result<Vec<([u8; 4], &[u8])>, String> {
    let mut result = Vec::new();
    while !bytes.is_empty() {
        let (h, k, n) = box_header(bytes)?;
        let n = usize::try_from(n).map_err(|_| "public-archive-container-unverified")?;
        if n > bytes.len() || result.len() >= 4096 {
            return Err("public-archive-container-unverified".into());
        }
        result.push((k, &bytes[h..n]));
        bytes = &bytes[n..];
    }
    Ok(result)
}
fn child<'a>(bytes: &'a [u8], kind: &[u8; 4]) -> Result<&'a [u8], String> {
    let matches = children(bytes)?
        .into_iter()
        .filter(|(k, _)| k == kind)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err("public-archive-codec-unverified".into());
    }
    Ok(matches[0].1)
}
const CODEC: &str = "public-archive-codec-unverified";
struct Bits<'a> {
    bytes: &'a [u8],
    bit: usize,
}
impl<'a> Bits<'a> {
    fn read(&mut self, count: usize) -> Result<u32, String> {
        if count > 32
            || self
                .bit
                .checked_add(count)
                .is_none_or(|n| n > self.bytes.len() * 8)
        {
            return Err(CODEC.into());
        }
        let mut n = 0;
        for _ in 0..count {
            n = (n << 1) | ((self.bytes[self.bit / 8] >> (7 - self.bit % 8)) & 1) as u32;
            self.bit += 1;
        }
        Ok(n)
    }
    fn ue(&mut self) -> Result<u32, String> {
        let mut zeros = 0;
        while self.read(1)? == 0 {
            zeros += 1;
            if zeros > 16 {
                return Err(CODEC.into());
            }
        }
        Ok(((1u32 << zeros) - 1) + self.read(zeros)?)
    }
}
fn rbsp(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut zero = 0;
    for (at, byte) in bytes.iter().copied().enumerate() {
        if zero >= 2 && byte == 3 {
            if bytes.get(at + 1).is_none_or(|n| *n > 3) {
                return Err(CODEC.into());
            }
            zero = 0;
            continue;
        }
        zero = if byte == 0 { zero + 1 } else { 0 };
        out.push(byte);
    }
    Ok(out)
}
fn parameter<'a>(bytes: &'a [u8], at: &mut usize, kind: u8) -> Result<&'a [u8], String> {
    let length = bytes.get(*at..*at + 2).ok_or(CODEC)?;
    let length = u16::from_be_bytes(length.try_into().map_err(|_| CODEC)?) as usize;
    *at += 2;
    let nal = bytes
        .get(*at..*at + length)
        .filter(|n| !n.is_empty())
        .ok_or(CODEC)?;
    *at += length;
    if nal[0] & 0x80 != 0 || nal[0] & 0x1f != kind {
        return Err(CODEC.into());
    }
    Ok(nal)
}
fn avc_config(entry: &[u8]) -> Result<(), String> {
    // ISO VisualSampleEntry fixed header is 78 bytes, not a bare fourcc.
    if entry.len() < 78
        || entry.get(6..8) == Some(&[0, 0])
        || u16::from_be_bytes(entry[24..26].try_into().unwrap()) == 0
        || u16::from_be_bytes(entry[26..28].try_into().unwrap()) == 0
    {
        return Err(CODEC.into());
    }
    let c = child(&entry[78..], b"avcC")?;
    if c.len() < 7
        || c.len() > 256 * 1024
        || c[0] != 1
        || c[2] & 3 != 0
        || c[4] & 0xfc != 0xfc
        || c[4] & 3 == 2
        || c[5] & 0xe0 != 0xe0
        || c[5] & 31 == 0
    {
        return Err(CODEC.into());
    }
    let mut at = 6;
    let mut sps_ids = std::collections::BTreeSet::new();
    for _ in 0..c[5] & 31 {
        let sps = parameter(c, &mut at, 7)?;
        // The summary may omit constraints which the actual SPS satisfies.
        // Require the same profile/level, valid reserved bits, and never admit
        // summary constraint claims absent from this concrete parameter set.
        if sps.len() < 5
            || sps[1] != c[1]
            || sps[3] != c[3]
            || sps[2] & 3 != 0
            || c[2] & !sps[2] != 0
        {
            return Err(CODEC.into());
        }
        let raw = rbsp(&sps[4..])?;
        let id = Bits {
            bytes: &raw,
            bit: 0,
        }
        .ue()?;
        if id > 31 || !sps_ids.insert(id) {
            return Err(CODEC.into());
        }
    }
    let pps_count = *c.get(at).ok_or(CODEC)?;
    at += 1;
    if pps_count == 0 {
        return Err(CODEC.into());
    }
    let mut pps_ids = std::collections::BTreeSet::new();
    for _ in 0..pps_count {
        let pps = parameter(c, &mut at, 8)?;
        let raw = rbsp(pps.get(1..).ok_or(CODEC)?)?;
        let mut bits = Bits {
            bytes: &raw,
            bit: 0,
        };
        let id = bits.ue()?;
        let sps = bits.ue()?;
        if id > 255 || !pps_ids.insert(id) || !sps_ids.contains(&sps) {
            return Err(CODEC.into());
        }
    }
    if at < c.len() {
        if !matches!(
            c[1],
            100 | 110 | 122 | 144 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
        ) || c.get(at..at + 4).is_none()
            || c[at] & 0xfc != 0xfc
            || c[at + 1] & 0xf8 != 0xf8
            || c[at + 2] & 0xf8 != 0xf8
        {
            return Err(CODEC.into());
        }
        let count = c[at + 3];
        at += 4;
        for _ in 0..count {
            parameter(c, &mut at, 13)?;
        }
    }
    if at != c.len() {
        return Err(CODEC.into());
    }
    Ok(())
}
fn descriptors(mut bytes: &[u8]) -> Result<Vec<(u8, &[u8])>, String> {
    let mut result = Vec::new();
    while !bytes.is_empty() {
        if result.len() >= 128 {
            return Err(CODEC.into());
        }
        let tag = bytes[0];
        let mut at = 1;
        let mut length = 0usize;
        loop {
            if at > 4 {
                return Err(CODEC.into());
            }
            let b = *bytes.get(at).ok_or(CODEC)?;
            at += 1;
            length = (length << 7) | (b & 0x7f) as usize;
            if b & 0x80 == 0 {
                break;
            }
        }
        let end = at
            .checked_add(length)
            .filter(|n| *n <= bytes.len())
            .ok_or(CODEC)?;
        result.push((tag, &bytes[at..end]));
        bytes = &bytes[end..];
    }
    Ok(result)
}
fn descriptor(bytes: &[u8], tag: u8) -> Result<&[u8], String> {
    let values = descriptors(bytes)?
        .into_iter()
        .filter(|(t, _)| *t == tag)
        .collect::<Vec<_>>();
    if values.len() != 1 {
        return Err(CODEC.into());
    }
    Ok(values[0].1)
}
fn frequency(bits: &mut Bits<'_>) -> Result<u32, String> {
    const FREQUENCIES: [u32; 13] = [
        96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
    ];
    let index = bits.read(4)? as usize;
    if index == 15 {
        let n = bits.read(24)?;
        if n == 0 || n > 192000 {
            return Err(CODEC.into());
        }
        Ok(n)
    } else {
        FREQUENCIES.get(index).copied().ok_or_else(|| CODEC.into())
    }
}
fn aac_config(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 2 || bytes.len() > 128 {
        return Err(CODEC.into());
    }
    let mut b = Bits { bytes, bit: 0 };
    let mut object = b.read(5)?;
    if object == 31 {
        object = 32 + b.read(6)?;
    }
    frequency(&mut b)?;
    let channels = b.read(4)?;
    if !(1..=7).contains(&channels) {
        return Err(CODEC.into());
    } // PCE not inspected.
    if object == 5 || object == 29 {
        frequency(&mut b)?;
        object = b.read(5)?;
    }
    if object != 2 {
        return Err("public-archive-audio-codec-unsupported".into());
    }
    b.read(1)?;
    if b.read(1)? != 0 {
        b.read(14)?;
    } // GASpecificConfig.
    if b.read(1)? != 0 {
        return Err(CODEC.into());
    } // Unknown extensions stay unverified.
    Ok(())
}
fn aac_entry(entry: &[u8]) -> Result<(), String> {
    if entry.len() < 28
        || entry.get(6..8) == Some(&[0, 0])
        || entry[8..10] != [0, 0]
        || u16::from_be_bytes(entry[16..18].try_into().unwrap()) == 0
        || u32::from_be_bytes(entry[24..28].try_into().unwrap()) == 0
    {
        return Err(CODEC.into());
    }
    let esds = child(&entry[28..], b"esds")?;
    if esds.len() < 4 || esds[..4] != [0, 0, 0, 0] {
        return Err(CODEC.into());
    }
    let es = descriptor(&esds[4..], 3)?;
    if es.len() < 3 {
        return Err(CODEC.into());
    }
    let flags = es[2];
    let mut at = 3;
    if flags & 0x80 != 0 {
        at += 2;
    }
    if flags & 0x40 != 0 {
        let n = *es.get(at).ok_or(CODEC)? as usize;
        at += 1 + n;
    }
    if flags & 0x20 != 0 {
        at += 2;
    }
    let config = descriptor(es.get(at..).ok_or(CODEC)?, 4)?;
    // 0x40 explicitly denotes MPEG-4 Audio; mp4a alone does not establish AAC.
    if config.len() < 13 || config[0] != 0x40 || config[1] >> 2 != 5 || config[1] & 1 != 1 {
        return Err("public-archive-audio-codec-unsupported".into());
    }
    aac_config(descriptor(&config[13..], 5)?)
}
fn mp4_tracks(moov: &[u8]) -> Result<(&'static str, Option<&'static str>), String> {
    let mut video = false;
    let mut audio = false;
    let mut tracks = 0;
    for (kind, track) in children(moov)? {
        if kind != *b"trak" {
            continue;
        }
        tracks += 1;
        if tracks > 32 {
            return Err("public-archive-inspection-limit".into());
        }
        let mdia = child(track, b"mdia")?;
        let hdlr = child(mdia, b"hdlr")?;
        let handler = hdlr.get(8..12).ok_or("public-archive-codec-unverified")?;
        if handler != b"vide" && handler != b"soun" {
            continue;
        }
        let stsd = child(child(child(mdia, b"minf")?, b"stbl")?, b"stsd")?;
        let n = u32::from_be_bytes(
            stsd.get(4..8)
                .ok_or("public-archive-codec-unverified")?
                .try_into()
                .unwrap(),
        );
        let entries = children(stsd.get(8..).ok_or("public-archive-codec-unverified")?)?;
        if n == 0 || n as usize != entries.len() {
            return Err("public-archive-codec-unverified".into());
        }
        for (codec, entry) in entries {
            if handler == b"vide" {
                if codec != *b"avc1" && codec != *b"avc3" {
                    return Err("public-archive-video-codec-unsupported".into());
                }
                avc_config(entry)?;
                video = true;
            } else {
                if codec != *b"mp4a" {
                    return Err("public-archive-audio-codec-unsupported".into());
                }
                aac_entry(entry)?;
                audio = true;
            }
        }
    }
    if !video {
        return Err("public-archive-video-codec-unverified".into());
    }
    Ok(("h264", audio.then_some("aac")))
}
fn vint(bytes: &[u8], id: bool) -> Result<(u64, usize, bool), String> {
    let first = *bytes.first().ok_or("public-archive-container-unverified")?;
    let len = (first.leading_zeros() + 1) as usize;
    if len > if id { 4 } else { 8 } || bytes.len() < len {
        return Err("public-archive-container-unverified".into());
    }
    let mut n = if id {
        first as u64
    } else {
        (first as u64) & (0xffu64 >> len)
    };
    for b in &bytes[1..len] {
        n = (n << 8) | *b as u64;
    }
    let unknown = !id && n == (1u64 << (7 * len)) - 1;
    Ok((n, len, unknown))
}
fn ebml_elements(mut bytes: &[u8], allow_unknown: bool) -> Result<Vec<(u64, &[u8])>, String> {
    let mut result = Vec::new();
    while !bytes.is_empty() {
        let (id, a, _) = vint(bytes, true)?;
        let (n, b, unknown) = vint(&bytes[a..], false)?;
        let h = a + b;
        if result.len() >= 4096 {
            return Err("public-archive-inspection-limit".into());
        }
        if unknown {
            if !allow_unknown {
                return Err("public-archive-container-unverified".into());
            }
            if id == 0x18538067 {
                result.push((id, &bytes[h..]));
            }
            break;
        }
        let n = usize::try_from(n).map_err(|_| "public-archive-container-unverified")?;
        let Some(end) = h.checked_add(n).filter(|n| *n <= bytes.len()) else {
            if allow_unknown {
                if id == 0x18538067 {
                    result.push((id, &bytes[h..]));
                }
                break;
            }
            return Err("public-archive-container-unverified".into());
        };
        result.push((id, &bytes[h..end]));
        bytes = &bytes[end..];
    }
    Ok(result)
}
fn ebml_field<'a>(fields: &[(u64, &'a [u8])], id: u64) -> Result<&'a [u8], String> {
    let matches = fields
        .iter()
        .filter(|(key, _)| *key == id)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(CODEC.into());
    }
    Ok(matches[0].1)
}
fn unsigned(bytes: &[u8]) -> Result<u64, String> {
    if bytes.is_empty() || bytes.len() > 8 {
        return Err(CODEC.into());
    }
    Ok(bytes.iter().fold(0, |n, b| (n << 8) | *b as u64))
}
fn opus_private(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 19 || &bytes[..8] != b"OpusHead" || bytes[8] != 1 || bytes[9] == 0 {
        return Err(CODEC.into());
    }
    let channels = bytes[9] as usize;
    if bytes[18] == 0 {
        if channels > 2 || bytes.len() != 19 {
            return Err(CODEC.into());
        }
    } else {
        if bytes.len() != 21 + channels || bytes[19] == 0 || bytes[20] > bytes[19] {
            return Err(CODEC.into());
        }
        let coded = bytes[19] as u16 + bytes[20] as u16;
        if coded > 255 || bytes[21..].iter().any(|n| *n != 255 && *n as u16 >= coded) {
            return Err(CODEC.into());
        }
    }
    Ok(())
}
fn vorbis_private(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > 256 * 1024 || bytes.first() != Some(&2) {
        return Err(CODEC.into());
    }
    let mut at = 1;
    let mut lengths = [0usize; 2];
    for length in &mut lengths {
        loop {
            let n = *bytes.get(at).ok_or(CODEC)?;
            at += 1;
            *length += n as usize;
            if n != 255 {
                break;
            }
        }
    }
    let a = at
        .checked_add(lengths[0])
        .filter(|n| *n <= bytes.len())
        .ok_or(CODEC)?;
    let b = a
        .checked_add(lengths[1])
        .filter(|n| *n <= bytes.len())
        .ok_or(CODEC)?;
    let identification = &bytes[at..a];
    let comments = &bytes[a..b];
    let setup = &bytes[b..];
    if identification.len() != 30
        || identification.get(..7) != Some(b"\x01vorbis")
        || identification[7..11] != [0, 0, 0, 0]
        || identification[11] == 0
        || u32::from_le_bytes(identification[12..16].try_into().unwrap()) == 0
        || !(6..=13).contains(&(identification[28] & 15))
        || !(6..=13).contains(&(identification[28] >> 4))
        || identification[28] & 15 > identification[28] >> 4
        || identification[29] & 1 != 1
        || comments.get(..7) != Some(b"\x03vorbis")
        || comments.len() < 12
        || setup.get(..7) != Some(b"\x05vorbis")
        || setup.len() < 8
    {
        return Err(CODEC.into());
    }
    let vendor = u32::from_le_bytes(comments[7..11].try_into().unwrap()) as usize;
    let mut p = 11usize
        .checked_add(vendor)
        .filter(|n| *n + 4 <= comments.len())
        .ok_or(CODEC)?;
    let count = u32::from_le_bytes(comments[p..p + 4].try_into().unwrap());
    p += 4;
    if count > 4096 {
        return Err(CODEC.into());
    }
    for _ in 0..count {
        let n = comments.get(p..p + 4).ok_or(CODEC)?;
        let n = u32::from_le_bytes(n.try_into().unwrap()) as usize;
        p += 4;
        p = p
            .checked_add(n)
            .filter(|n| *n < comments.len())
            .ok_or(CODEC)?;
    }
    if p + 1 != comments.len() || comments[p] & 1 != 1 {
        return Err(CODEC.into());
    }
    Ok(())
}
fn webm_tracks(bytes: &[u8]) -> Result<(&'static str, Option<&'static str>), String> {
    let top = ebml_elements(bytes, true)?;
    let header = ebml_field(&top, 0x1a45dfa3)?;
    if ebml_field(&ebml_elements(header, false)?, 0x4282)? != b"webm" {
        return Err("public-archive-container-unverified".into());
    }
    let segment = ebml_field(&top, 0x18538067)?;
    let segments = ebml_elements(segment, true)?;
    let tracks = ebml_field(&segments, 0x1654ae6b)?;
    let mut video = None;
    let mut audio = None;
    let mut count = 0;
    for (id, track) in ebml_elements(tracks, false)? {
        if id != 0xae {
            continue;
        }
        count += 1;
        if count > 32 {
            return Err("public-archive-inspection-limit".into());
        }
        let fields = ebml_elements(track, false)?;
        let kind = unsigned(ebml_field(&fields, 0x83)?)?;
        // Other track kinds do not establish either video or audio capability.
        if kind != 1 && kind != 2 {
            continue;
        }
        let codec = ebml_field(&fields, 0x86)?;
        if kind == 1 {
            video = Some(match codec {
                b"V_VP8" => "vp8",
                b"V_VP9" => "vp9",
                _ => return Err("public-archive-video-codec-unsupported".into()),
            });
        } else if kind == 2 {
            audio = Some(match codec {
                b"A_OPUS" => {
                    opus_private(ebml_field(&fields, 0x63a2)?)?;
                    "opus"
                }
                b"A_VORBIS" => {
                    vorbis_private(ebml_field(&fields, 0x63a2)?)?;
                    "vorbis"
                }
                _ => return Err("public-archive-audio-codec-unsupported".into()),
            });
        }
    }
    Ok((video.ok_or("public-archive-video-codec-unverified")?, audio))
}
pub(crate) async fn inspect(
    p: Provider,
    target: &Url,
    expected: Option<&str>,
    owner: &Arc<Context>,
    deadline: Instant,
) -> Result<Inspection, String> {
    let first = range(p, target, 0, 4095, owner, deadline).await?;
    if expected.is_some_and(|n| n != first.size.to_string()) {
        return Err("public-archive-size-changed".into());
    }
    let size = first.size;
    if first.mime == "video/webm" {
        let bytes = range(
            p,
            target,
            0,
            (512 * 1024 - 1).min(size - 1),
            owner,
            deadline,
        )
        .await?;
        if bytes.size != size || bytes.mime != first.mime {
            return Err("public-archive-size-changed".into());
        }
        let (v, a) = webm_tracks(&bytes.bytes)?;
        return Ok(Inspection {
            size,
            mime: "video/webm",
            video_codec: v,
            audio_codec: a,
        });
    }
    if first.bytes.get(4..8) != Some(b"ftyp") {
        return Err("public-archive-container-unverified".into());
    }
    let mut offset = 0u64;
    let mut examined = 0u64;
    for _ in 0..64 {
        net::check(owner, deadline)?;
        let header = if offset == 0 {
            first.bytes[..16].to_vec()
        } else {
            let b = range(
                p,
                target,
                offset,
                (offset + 15).min(size - 1),
                owner,
                deadline,
            )
            .await?;
            if b.size != size || b.mime != first.mime {
                return Err("public-archive-size-changed".into());
            }
            b.bytes
        };
        let (h, kind, n) = box_header(&header)?;
        let end = offset
            .checked_add(n)
            .filter(|n| *n <= size)
            .ok_or("public-archive-container-unverified")?;
        if kind == *b"moov" {
            if n > 2 * 1024 * 1024 || examined + n > 2 * 1024 * 1024 {
                return Err("public-archive-inspection-limit".into());
            }
            let body = range(p, target, offset, end - 1, owner, deadline).await?;
            if body.size != size || body.mime != first.mime {
                return Err("public-archive-size-changed".into());
            }
            let (v, a) = mp4_tracks(verified_moov_payload(&body.bytes, h, n)?)?;
            return Ok(Inspection {
                size,
                mime: "video/mp4",
                video_codec: v,
                audio_codec: a,
            });
        }
        examined += header.len() as u64;
        offset = end;
        if offset >= size {
            break;
        }
    }
    Err("public-archive-codec-unverified".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fetched_moov_must_agree_with_the_previously_observed_box_header() {
        let valid = bx(b"moov", b"body");
        assert_eq!(
            verified_moov_payload(&valid, 8, valid.len() as u64).unwrap(),
            b"body"
        );
        let changed = bx(b"mdat", b"body");
        assert!(verified_moov_payload(&changed, 8, valid.len() as u64).is_err());
        assert!(verified_moov_payload(&valid, 16, valid.len() as u64).is_err());
        assert!(verified_moov_payload(&valid, 8, valid.len() as u64 + 1).is_err());
        assert!(verified_moov_payload(&valid[..valid.len() - 1], 8, valid.len() as u64).is_err());
    }
    fn bx(kind: &[u8; 4], v: &[u8]) -> Vec<u8> {
        let mut o = ((v.len() + 8) as u32).to_be_bytes().to_vec();
        o.extend(kind);
        o.extend(v);
        o
    }
    fn avcc() -> Vec<u8> {
        let sps = [0x67, 0x42, 0, 0x1e, 0xe9, 0x01, 0x40, 0x7b, 0x20];
        let pps = [0x68, 0xce, 0x3c, 0x80];
        [
            vec![1, 0x42, 0, 0x1e, 0xff, 0xe1],
            (sps.len() as u16).to_be_bytes().to_vec(),
            sps.to_vec(),
            vec![1],
            (pps.len() as u16).to_be_bytes().to_vec(),
            pps.to_vec(),
        ]
        .concat()
    }
    fn visual(config: &[u8]) -> Vec<u8> {
        let mut v = vec![0; 78];
        v[7] = 1;
        v[24..26].copy_from_slice(&640u16.to_be_bytes());
        v[26..28].copy_from_slice(&480u16.to_be_bytes());
        v.extend(bx(b"avcC", config));
        v
    }
    fn desc(tag: u8, payload: &[u8]) -> Vec<u8> {
        assert!(payload.len() < 128);
        [vec![tag, payload.len() as u8], payload.to_vec()].concat()
    }
    fn audio(object: u8, asc: &[u8]) -> Vec<u8> {
        let mut config = vec![object, 0x15];
        config.extend([0; 11]);
        config.extend(desc(5, asc));
        let es = [vec![0, 1, 0], desc(4, &config), desc(6, &[2])].concat();
        let esds = [vec![0; 4], desc(3, &es)].concat();
        let mut a = vec![0; 28];
        a[7] = 1;
        a[16..18].copy_from_slice(&2u16.to_be_bytes());
        a[18..20].copy_from_slice(&16u16.to_be_bytes());
        a[24..28].copy_from_slice(&(44100u32 << 16).to_be_bytes());
        a.extend(bx(b"esds", &esds));
        a
    }
    fn track_entry(kind: &[u8; 4], codec: &[u8; 4], entry: &[u8]) -> Vec<u8> {
        let mut h = vec![0; 8];
        h.extend(kind);
        let mut s = vec![0; 4];
        s.extend(1u32.to_be_bytes());
        s.extend(bx(codec, entry));
        bx(
            b"trak",
            &[bx(
                b"mdia",
                &[bx(b"hdlr", &h), bx(b"minf", &bx(b"stbl", &bx(b"stsd", &s)))].concat(),
            )]
            .concat(),
        )
    }
    fn track(kind: &[u8; 4], codec: &[u8; 4]) -> Vec<u8> {
        track_entry(
            kind,
            codec,
            &if kind == b"vide" {
                visual(&avcc())
            } else {
                audio(0x40, &[0x12, 0x10])
            },
        )
    }
    #[test]
    fn structural_codec_admission_does_not_scan_arbitrary_text() {
        assert!(mp4_tracks(&track(b"vide", b"avc1")).is_ok());
        assert!(mp4_tracks(&track(b"vide", b"mp4v")).is_err());
        assert!(mp4_tracks(&bx(b"free", b"avc1 mp4a")).is_err());
        assert!(mp4_tracks(&[track(b"vide", b"avc1"), track(b"soun", b"ac-3")].concat()).is_err());
    }
    #[test]
    fn official_loc_header_proves_actual_h264_aac_without_media_body() {
        // Exact 351,838-byte moov from the official item00694220 representation.
        // No mdat bytes; this is configuration proof, never decoder acceptance.
        let bytes = include_bytes!("../../tests/fixtures/archive-providers/loc-00694220-moov.bin");
        let payload = verified_moov_payload(bytes, 8, bytes.len() as u64).unwrap();
        assert_eq!(mp4_tracks(payload).unwrap(), ("h264", Some("aac")));
    }
    #[test]
    fn avcc_summary_constraints_cannot_overclaim_actual_sps() {
        let mut config = avcc();
        config[10] = 0x40; // Actual SPS has additional constraint_set1.
        assert!(avc_config(&visual(&config)).is_ok());
        config[2] = 0x40;
        assert!(avc_config(&visual(&config)).is_ok());
        for (at, value) in [(2, 0x80), (2, 0x41), (10, 0x41), (9, 0x4d), (11, 0x28)] {
            let mut invalid = config.clone();
            invalid[at] = value;
            assert!(avc_config(&visual(&invalid)).is_err(), "offset {at}");
        }
    }
    #[test]
    fn malformed_lengths_and_unknown_ebml_are_refused() {
        assert!(children(&[0; 8]).is_err());
        assert!(vint(&[0], false).is_err());
        assert!(webm_tracks(b"webm V_VP9 A_OPUS").is_err());
    }
    #[test]
    fn avc_entry_requires_real_config_not_fourcc_or_arbitrary_marker() {
        assert!(mp4_tracks(&track_entry(b"vide", b"avc1", &[0; 8])).is_err());
        assert!(mp4_tracks(&track_entry(b"vide", b"avc3", &visual(&avcc()))).is_ok());
        let mut missing = visual(&avcc());
        missing[82..86].copy_from_slice(b"free");
        assert!(avc_config(&missing).is_err());
    }
    #[test]
    fn avcc_truncation_lengths_nal_types_and_parameter_relations_are_checked() {
        let c = avcc();
        for end in 0..c.len() {
            assert!(avc_config(&visual(&c[..end])).is_err(), "prefix {end}");
        }
        for (at, value) in [(0, 0), (4, 0xfe), (5, 0xe0), (6, 0xff), (8, 0x68)] {
            let mut v = c.clone();
            v[at] = value;
            assert!(avc_config(&visual(&v)).is_err());
        }
        let mut wrong_pps = c.clone();
        let n = wrong_pps.len();
        wrong_pps[n - 3] = 0x48; // PPS id1 references SPS1, unavailable.
        assert!(avc_config(&visual(&wrong_pps)).is_err());
        let mut trailing = c;
        trailing.push(0);
        assert!(avc_config(&visual(&trailing)).is_err());
    }
    #[test]
    fn mp4a_requires_esds_mpeg4audio_and_recognized_aac_config() {
        let moov = [track(b"vide", b"avc1"), track(b"soun", b"mp4a")].concat();
        assert_eq!(mp4_tracks(&moov).unwrap(), ("h264", Some("aac")));
        assert!(mp4_tracks(
            &[
                track(b"vide", b"avc1"),
                track_entry(b"soun", b"mp4a", &[0; 28])
            ]
            .concat()
        )
        .is_err());
        assert!(aac_entry(&audio(0x6b, &[0x12, 0x10])).is_err()); // MPEG audio, not AAC.
        assert!(aac_entry(&audio(0x40, &[0x1a, 0x10])).is_err()); // AAC SSR, not admitted profile.
        assert!(aac_entry(&audio(0x40, &[0x12])).is_err());
        assert!(aac_entry(&audio(0x40, &[0x12, 0x00])).is_err()); // PCE not inspected.
        assert!(aac_entry(&audio(0x40, &[0x17, 0x90])).is_err()); // Invalid frequency index.
    }
    #[test]
    fn esds_length_and_duplicate_config_are_refused_without_unbounded_walk() {
        assert!(descriptors(&[3, 0x80, 0x80, 0x80, 0x80, 0]).is_err());
        assert!(descriptors(&[3, 127, 0]).is_err());
        assert!(descriptor(
            &[desc(5, &[0x12, 0x10]), desc(5, &[0x12, 0x10])].concat(),
            5
        )
        .is_err());
        let a = audio(0x40, &[0x12, 0x10]);
        for end in 0..a.len() {
            assert!(aac_entry(&a[..end]).is_err(), "prefix {end}");
        }
    }
    fn eb(id: u32, payload: &[u8]) -> Vec<u8> {
        let id = id.to_be_bytes();
        let start = id.iter().position(|b| *b != 0).unwrap();
        let length = if payload.len() < 127 {
            vec![0x80 | payload.len() as u8]
        } else {
            ((payload.len() as u16) | 0x4000).to_be_bytes().to_vec()
        };
        [&id[start..], length.as_slice(), payload].concat()
    }
    fn webm(entries: &[u8]) -> Vec<u8> {
        [
            eb(0x1a45dfa3, &eb(0x4282, b"webm")),
            eb(0x18538067, &eb(0x1654ae6b, entries)),
        ]
        .concat()
    }
    fn webm_track(kind: &[u8], codec: &[u8], private: Option<&[u8]>) -> Vec<u8> {
        eb(
            0xae,
            &[
                eb(0x83, kind),
                eb(0x86, codec),
                private.map_or_else(Vec::new, |p| eb(0x63a2, p)),
            ]
            .concat(),
        )
    }
    fn opus() -> Vec<u8> {
        [
            b"OpusHead".as_slice(),
            &[1, 2],
            &[0, 0],
            &48000u32.to_le_bytes(),
            &[0, 0, 0],
        ]
        .concat()
    }
    fn vorbis() -> Vec<u8> {
        let mut id = vec![0; 30];
        id[..7].copy_from_slice(b"\x01vorbis");
        id[11] = 2;
        id[12..16].copy_from_slice(&48000u32.to_le_bytes());
        id[28] = 0x76;
        id[29] = 1;
        let comment = [b"\x03vorbis".as_slice(), &[0; 8], &[1]].concat();
        [
            vec![2, id.len() as u8, comment.len() as u8],
            id,
            comment,
            b"\x05vorbis\x01".to_vec(),
        ]
        .concat()
    }
    #[test]
    fn ebml_eight_byte_sizes_and_empty_track_type_never_panic() {
        assert_eq!(
            vint(&[1, 0, 0, 0, 0, 0, 0, 1], false).unwrap(),
            (1, 8, false)
        );
        assert_eq!(
            vint(&[1, 255, 255, 255, 255, 255, 255, 255], false).unwrap(),
            ((1u64 << 56) - 1, 8, true)
        );
        assert!(webm_tracks(&webm(&webm_track(&[], b"V_VP9", None))).is_err());
        assert!(webm_tracks(&webm(&webm_track(&[0, 1], b"V_VP9", None))).is_ok());
    }
    #[test]
    fn webm_actual_track_types_and_required_audio_config_are_checked() {
        let video = webm_track(&[1], b"V_VP9", None);
        assert_eq!(
            webm_tracks(&webm(
                &[video.clone(), webm_track(&[2], b"A_OPUS", Some(&opus()))].concat()
            ))
            .unwrap(),
            ("vp9", Some("opus"))
        );
        assert_eq!(
            webm_tracks(&webm(
                &[
                    video.clone(),
                    webm_track(&[2], b"A_VORBIS", Some(&vorbis()))
                ]
                .concat()
            ))
            .unwrap(),
            ("vp9", Some("vorbis"))
        );
        assert!(webm_tracks(&webm(
            &[video.clone(), webm_track(&[2], b"A_OPUS", None)].concat()
        ))
        .is_err());
        assert!(webm_tracks(&webm(&webm_track(&[17], b"V_VP9", None))).is_err());
        assert!(webm_tracks(&webm(&webm_track(&[1], b"V_AV1", None))).is_err());
        assert!(webm_tracks(&webm(
            &[video, webm_track(&[2], b"A_AAC", Some(&[0x12, 0x10]))].concat()
        ))
        .is_err());
    }
    #[test]
    fn opus_and_vorbis_truncation_mapping_and_lacing_are_refused() {
        let o = opus();
        for end in 0..o.len() {
            assert!(opus_private(&o[..end]).is_err());
        }
        let mut o = opus();
        o[9] = 3;
        assert!(opus_private(&o).is_err());
        let mut o = opus();
        o[18] = 1;
        assert!(opus_private(&o).is_err());
        let v = vorbis();
        assert!(vorbis_private(&v).is_ok());
        for end in 0..v.len() {
            assert!(vorbis_private(&v[..end]).is_err());
        }
        let mut v = vorbis();
        v[1] = 255;
        assert!(vorbis_private(&v).is_err());
    }
    #[test]
    fn duplicate_codec_fields_and_element_limit_are_refused() {
        let duplicated = eb(
            0xae,
            &[eb(0x83, &[1]), eb(0x86, b"V_VP8"), eb(0x86, b"V_VP9")].concat(),
        );
        assert!(webm_tracks(&webm(&duplicated)).is_err());
        let elements = vec![eb(0xec, &[]); 4097].concat();
        assert!(ebml_elements(&elements, false).is_err());
    }
    #[test]
    fn duplicate_webm_doctype_segment_or_tracks_are_not_ignored() {
        let track = webm_track(&[1], b"V_VP9", None);
        let header = eb(0x1a45dfa3, &eb(0x4282, b"webm"));
        let segment = eb(0x18538067, &eb(0x1654ae6b, &track));
        assert!(webm_tracks(&[header.clone(), segment.clone(), segment.clone()].concat()).is_err());
        assert!(webm_tracks(&[header.clone(), header, segment.clone()].concat()).is_err());
        let double_type = eb(
            0x1a45dfa3,
            &[eb(0x4282, b"webm"), eb(0x4282, b"matroska")].concat(),
        );
        assert!(webm_tracks(&[double_type, segment].concat()).is_err());
        let double_tracks = eb(
            0x18538067,
            &[
                eb(0x1654ae6b, &track),
                eb(0x1654ae6b, &webm_track(&[1], b"V_AV1", None)),
            ]
            .concat(),
        );
        assert!(
            webm_tracks(&[eb(0x1a45dfa3, &eb(0x4282, b"webm")), double_tracks].concat()).is_err()
        );
    }
}
