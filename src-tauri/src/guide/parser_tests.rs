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
fn multilingual_display_names_are_bounded_without_truncation() {
    let xml = format!(
        "<tv><channel id='a'>{}</channel></tv>",
        "<display-name>Name</display-name>".repeat(32)
    );
    assert_eq!(
        parse_guide(xml.as_bytes()).unwrap().channels[0].names.len(),
        32
    );
    let overflow = format!(
        "<tv><channel id='a'>{}</channel></tv>",
        "<display-name>Name</display-name>".repeat(33)
    );
    assert!(parse_guide(overflow.as_bytes()).is_err());
}
#[test]
fn cancellation_never_returns_a_partial_guide() {
    let cancel = AtomicBool::new(true);
    assert_eq!(
        parse_guide_cancelable(feed("").as_bytes(), &cancel).unwrap_err(),
        "Guide parsing was cancelled."
    );
    cancel.store(false, Ordering::Release);
    assert!(parse_guide_cancelable(feed("").as_bytes(), &cancel).is_ok());
}
fn channel() -> &'static str {
    "<channel id='a'><display-name>A</display-name></channel>"
}
fn feed(program: &str) -> String {
    format!("<tv>{}{program}</tv>", channel())
}
fn program(start: &str, stop: &str, title: &str) -> String {
    format!("<programme channel='a' start='{start}' {stop}><title>{title}</title></programme>")
}
#[test]
fn entities_cdata_tails_and_first_language_are_preserved() {
    let xml = feed("<programme channel='a' start='20261010120000'><title lang='en'>Tom &amp; Jerry <![CDATA[<live>]]> &#x1F4FA; tail</title><title lang='fr'>Autre</title><desc>A &lt; B &quot;yes&quot;</desc></programme>");
    let parsed = parse_guide(xml.as_bytes()).unwrap();
    assert_eq!(parsed.programs[0].title, "Tom & Jerry <live> 📺 tail");
    assert_eq!(
        parsed.programs[0].description.as_deref(),
        Some("A < B \"yes\"")
    );
    assert_eq!(parsed.programs[0].stop_ms, None);
}
#[test]
fn strict_calendar_offsets_minute_precision_and_dst_instants() {
    assert_eq!(
        parse_timestamp("202610101200").unwrap(),
        parse_timestamp("20261010120000 +0000").unwrap()
    );
    assert_eq!(
        parse_timestamp("20261101013000 -0600").unwrap()
            - parse_timestamp("20261101013000 -0500").unwrap(),
        3_600_000
    );
    assert_eq!(
        parse_timestamp("20260308030000 -0500").unwrap()
            - parse_timestamp("20260308015959 -0600").unwrap(),
        1_000
    );
    assert_eq!(
        parse_timestamp("20261011000000 +1400").unwrap(),
        parse_timestamp("20261010100000").unwrap()
    );
    assert!(parse_timestamp("20240229000000").is_ok());
    for bad in [
        "20260229000000",
        "20261301000000",
        "20260101240000",
        "20260101000060",
        "00000101000000",
        "2026",
        "2026101012",
        "20261010120000 BST",
        "20261010120000 +1401",
        "20261010120000 +0060",
    ] {
        assert!(parse_timestamp(bad).is_err(), "{bad}");
    }
}
#[test]
fn utf16_bom_declared_and_utf8_bom_are_explicitly_supported() {
    let xml = format!(
        "<?xml version='1.0' encoding='UTF-16'?><tv>{}</tv>",
        channel()
    );
    for le in [true, false] {
        let mut bytes = if le {
            vec![0xff, 0xfe]
        } else {
            vec![0xfe, 0xff]
        };
        for unit in xml.encode_utf16() {
            bytes.extend(if le {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        assert_eq!(parse_guide(&bytes).unwrap().channels[0].id, "a");
    }
    let mut bytes = vec![0xef, 0xbb, 0xbf];
    bytes.extend(feed("").as_bytes());
    assert_eq!(parse_guide(&bytes).unwrap().channels.len(), 1);
    assert!(parse_guide(b"<?xml version='1.0' encoding='ISO-8859-1'?><tv/>").is_err());
    assert!(parse_guide(&[0xff, 0xfe, 0x00, 0xd8]).is_err());
    assert!(parse_guide(&[0xff, 0xfe, 0]).is_err());
}
#[test]
fn external_dtd_is_not_resolved_and_internal_entities_are_refused() {
    let xml = format!(
        "<!DOCTYPE tv SYSTEM 'file:///never-read'><tv>{}</tv>",
        channel()
    );
    assert!(parse_guide(xml.as_bytes()).is_ok());
    for xml in [
        "<!DOCTYPE tv [<!ENTITY x SYSTEM 'https://private.invalid'>]><tv/>",
        "<!DOCTYPE tv [<!ENTITY x 'expanded'>]><tv/>",
        "<tv>&unknown;</tv>",
        "<tv>&#0;</tv>",
    ] {
        assert!(parse_guide(xml.as_bytes()).is_err());
    }
}
#[test]
fn malformed_or_incomplete_feed_and_invalid_references_fail_whole_revision() {
    for xml in [
        "",
        "<tv>",
        "<wrong/>",
        "<tv/><tv/>",
        "<tv><channel></tv>",
        "<tv><programme channel='missing' start='20261010120000'><title>X</title></programme></tv>",
        "<tv><channel id='a' id='b'/></tv>",
    ] {
        assert!(parse_guide(xml.as_bytes()).is_err(), "{xml}");
    }
    for p in [
        program("2026", "", "X"),
        program("20261010120000", "stop='20261010120000'", "X"),
        program("20261010120000", "stop='20261010110000'", "X"),
        program("20261010120000", "", ""),
        program("20261010120000", "", "Bare & tail"),
    ] {
        assert!(parse_guide(feed(&p).as_bytes()).is_err(), "{p}");
    }
}
#[test]
fn channel_conflicts_fail_exact_duplicates_and_programs_are_stably_retained() {
    assert_eq!(
        parse_guide(format!("<tv>{}{}</tv>", channel(), channel()).as_bytes())
            .unwrap()
            .channels
            .len(),
        1
    );
    assert!(parse_guide(
        format!(
            "<tv>{}<channel id='a'><display-name>B</display-name></channel></tv>",
            channel()
        )
        .as_bytes()
    )
    .is_err());
    let a = program("20261010120000", "", "A");
    let b = program("20261010130000", "", "B");
    let first = parse_guide(feed(&format!("{b}{a}{a}")).as_bytes()).unwrap();
    let second = parse_guide(feed(&format!("{a}{b}{a}")).as_bytes()).unwrap();
    assert_eq!(first, second);
    assert_eq!(first.programs.len(), 3);
    // Identical IDs in separate feeds stay independent; there is no global name/ID merge.
    assert_eq!(
        parse_guide(feed("").as_bytes()).unwrap().channels[0].id,
        "a"
    );
}
#[test]
fn configurable_bounds_reject_overflow_without_truncation() {
    let xml = feed(&program("20261010120000", "", "X"));
    let limits = GuideLimits {
        expanded_bytes: xml.len(),
        channels: 1,
        programs: 1,
    };
    assert!(parse_guide_with_limits(xml.as_bytes(), limits).is_ok());
    assert!(parse_guide_with_limits(
        xml.as_bytes(),
        GuideLimits {
            expanded_bytes: xml.len() - 1,
            ..limits
        }
    )
    .is_err());
    assert!(parse_guide_with_limits(
        xml.as_bytes(),
        GuideLimits {
            channels: 0,
            ..limits
        }
    )
    .is_err());
    assert!(parse_guide_with_limits(
        xml.as_bytes(),
        GuideLimits {
            programs: 0,
            ..limits
        }
    )
    .is_err());
    let large = feed(&program("20261010120000", "", &"x".repeat(16_385)));
    assert!(parse_guide(large.as_bytes()).is_err());
}
