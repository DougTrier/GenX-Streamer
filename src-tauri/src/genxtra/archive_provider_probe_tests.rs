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
    let bytes = include_bytes!("../../../tests/fixtures/archive-providers/loc-00694220-moov.bin");
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
    assert!(webm_tracks(&[eb(0x1a45dfa3, &eb(0x4282, b"webm")), double_tracks].concat()).is_err());
}
