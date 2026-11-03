// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0

//! Only COMET's official schedule API and the published Comet.us main feed.
//! This is not a generic HTML/JSON source. Normalized XMLTV goes through the
//! ordinary parser, preview, retention, publication and exact mapping owners.
use chrono::{NaiveDate, NaiveTime, TimeZone, Timelike, Utc};
use quick_xml::{events::Event, Reader};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
};

pub(crate) const LOCATION: &str = "https://comettv.com/schedule/";
pub(crate) const API: &str = "https://comettv.com/wp-json/comet/v1/fetch-all-schedule-days";
pub(crate) const BODY_LIMIT: usize = 2 * 1024 * 1024;

pub(crate) fn handles(location: &str) -> bool {
    location == LOCATION
}

pub(crate) fn main_provider(provider: &str) -> bool {
    matches!(provider, "Comet.us" | "Comet.us@SD")
}

fn check(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::SeqCst) {
        Err("canceled".into())
    } else {
        Ok(())
    }
}

fn dates(now: i64) -> Result<Vec<NaiveDate>, String> {
    let local = Utc
        .timestamp_millis_opt(now)
        .single()
        .ok_or("comet-invalid-clock")?
        .with_timezone(&chrono_tz::America::New_York);
    let today = local.date_naive();
    // The verified broadcast-day fragment rolls only from PM into the next AM.
    // Before noon the previous fragment can therefore contain current listings;
    // afterwards it cannot contribute a known active interval. Avoid retrieving
    // an entirely expired DST-ambiguous broadcast day then refusing today's data.
    let first = if local.hour() < 12 {
        today.pred_opt().ok_or("comet-invalid-clock")?
    } else {
        today
    };
    (0..8)
        .map(|offset| {
            first
                .checked_add_days(chrono::Days::new(offset))
                .ok_or_else(|| "comet-invalid-clock".into())
        })
        .collect()
}

pub(crate) fn request_url(now: i64) -> Result<String, String> {
    let mut url = reqwest::Url::parse(API).map_err(|_| "comet-invalid-url")?;
    let days = dates(now)?
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    url.query_pairs_mut()
        .append_pair("days", &days)
        .append_pair("timezone", "America/New_York");
    Ok(url.into())
}

pub(crate) async fn fetch(now: i64, flag: &AtomicBool) -> Result<Vec<u8>, String> {
    check(flag)?;
    let url = request_url(now)?;
    let mut response = crate::network::response_json_metadata(&url).await?;
    check(flag)?;
    if response.status() != reqwest::StatusCode::OK
        || response.url().as_str() != url
        || !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|s| s.to_str().ok())
            .is_some_and(|s| {
                s.split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
            })
    {
        return Err("comet-response-unavailable".into());
    }
    if response
        .content_length()
        .is_some_and(|n| n > BODY_LIMIT as u64)
        || response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .is_some_and(|value| value.as_bytes() != b"identity")
    {
        return Err("comet-response-limit-or-coding".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "comet-read-failed")? {
        check(flag)?;
        if chunk.len() > BODY_LIMIT.saturating_sub(bytes.len()) {
            return Err("comet-response-too-large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    check(flag)?;
    Ok(bytes)
}

/// Called on the existing blocking parse worker, with the acquisition anchor.
pub(crate) fn normalize(bytes: &[u8], now: i64, flag: &AtomicBool) -> Result<Vec<u8>, String> {
    normalize_days(bytes, &dates(now)?, flag)
}

fn normalize_days(bytes: &[u8], days: &[NaiveDate], flag: &AtomicBool) -> Result<Vec<u8>, String> {
    check(flag)?;
    if bytes.len() > BODY_LIMIT
        || days.is_empty()
        || days.len() > 8
        || days
            .windows(2)
            .any(|pair| pair[0].succ_opt() != Some(pair[1]))
    {
        return Err("comet-response-limit".into());
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Envelope {
        html: BTreeMap<String, String>,
    }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| "comet-invalid-json")?;
    let expected: Vec<_> = days.iter().map(ToString::to_string).collect();
    if envelope.html.keys().collect::<Vec<_>>() != expected.iter().collect::<Vec<_>>() {
        return Err("comet-response-day-mismatch".into());
    }
    let mut programs = BTreeMap::new();
    for day in days {
        check(flag)?;
        let fragment = &envelope.html[&day.to_string()];
        let rows = parse_fragment(fragment, *day, flag)?;
        for (index, row) in rows.iter().enumerate() {
            // Never bridge an unlisted overnight gap into another broadcast day.
            let value = Program {
                start: row.start,
                stop: rows.get(index + 1).map(|next| next.start),
                title: row.title.clone(),
                description: row.description.clone(),
            };
            if programs
                .get(&row.start)
                .is_some_and(|previous| previous != &value)
            {
                return Err("comet-conflicting-programmes".into());
            }
            programs.insert(row.start, value);
        }
    }
    if programs.is_empty() || programs.len() > 1024 {
        return Err("comet-empty-or-excessive-schedule".into());
    }
    let mut xml = String::from("<?xml version='1.0' encoding='UTF-8'?><tv>");
    // One canonical header avoids making the existing exact/main-feed matcher
    // ambiguous. Published main-feed equivalence connects bare Comet.us.
    for channel in ["Comet.us@SD"] {
        xml.push_str(&format!(
            "<channel id='{channel}'><display-name>COMET</display-name></channel>"
        ));
        for program in programs.values() {
            check(flag)?;
            let start = stamp(program.start)?;
            let stop = program
                .stop
                .map(stamp)
                .transpose()?
                .map(|s| format!(" stop='{s}'"))
                .unwrap_or_default();
            xml.push_str(&format!(
                "<programme channel='{channel}' start='{start}'{stop}><title>{}</title>",
                quick_xml::escape::escape(&program.title)
            ));
            if !program.description.is_empty() {
                xml.push_str(&format!(
                    "<desc>{}</desc>",
                    quick_xml::escape::escape(&program.description)
                ));
            }
            xml.push_str("</programme>");
            if xml.len() > BODY_LIMIT {
                return Err("comet-normalized-limit".into());
            }
        }
    }
    xml.push_str("</tv>");
    check(flag)?;
    Ok(xml.into_bytes())
}

#[derive(Debug, PartialEq, Eq)]
struct Program {
    start: i64,
    stop: Option<i64>,
    title: String,
    description: String,
}
#[derive(Default)]
struct Raw {
    time: String,
    title: String,
    episode: String,
    description: String,
    fields: [usize; 4],
}
struct Row {
    start: i64,
    title: String,
    description: String,
}
struct Frame {
    tag: String,
    class: String,
}
fn has(class: &str, name: &str) -> bool {
    class.split_ascii_whitespace().any(|s| s == name)
}
fn text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn stamp(ms: i64) -> Result<String, String> {
    Ok(Utc
        .timestamp_millis_opt(ms)
        .single()
        .ok_or("comet-invalid-instant")?
        .format("%Y%m%d%H%M%S +0000")
        .to_string())
}
fn local_clock(value: &str) -> Result<NaiveTime, String> {
    static CLOCK: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = CLOCK.get_or_init(|| regex::Regex::new(r"^((?:[1-9]|1[0-2])(?::[0-5][0-9])? (?:AM|PM)) Eastern Pacific (?:[1-9]|1[0-2])(?::[0-5][0-9])? (?:AM|PM) CT (?:[1-9]|1[0-2])(?::[0-5][0-9])? (?:AM|PM) MT$").expect("fixed COMET clock pattern"));
    let captures = pattern.captures(value).ok_or("comet-invalid-clock-label")?;
    let clock = if captures[1].contains(':') {
        captures[1].to_owned()
    } else {
        captures[1].replacen(' ', ":00 ", 1)
    };
    NaiveTime::parse_from_str(&clock, "%I:%M %p").map_err(|_| "comet-invalid-clock-label".into())
}

pub(crate) fn suggestion<'a>(
    providers: impl Iterator<Item = &'a str>,
) -> Option<super::crosswalk_pack::FeedSuggestion> {
    let count = providers
        .filter(|id| main_provider(id))
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    (count > 0).then(|| super::crosswalk_pack::FeedSuggestion {
        name: "Official COMET · national main feed".into(),
        location: LOCATION.into(),
        channels: count,
    })
}
fn append(
    value: &str,
    stack: &[Frame],
    raw: &mut Option<Raw>,
    heading: &mut String,
) -> Result<(), String> {
    let target = if let Some(row) = raw {
        if stack.iter().any(|f| has(&f.class, "episode-title")) {
            &mut row.episode
        } else if stack.iter().any(|f| has(&f.class, "title")) {
            &mut row.title
        } else if stack.iter().any(|f| has(&f.class, "description")) {
            &mut row.description
        } else if stack.iter().any(|f| has(&f.class, "time")) {
            &mut row.time
        } else {
            return Ok(());
        }
    } else if stack.iter().any(|f| has(&f.class, "print-heading")) {
        heading
    } else {
        return Ok(());
    };
    if target.len() + value.len() > 8192 {
        return Err("comet-field-limit".into());
    }
    target.push_str(value);
    Ok(())
}

fn parse_fragment(
    fragment: &str,
    broadcast_day: NaiveDate,
    flag: &AtomicBool,
) -> Result<Vec<Row>, String> {
    if fragment.len() > 256 * 1024 {
        return Err("comet-fragment-limit".into());
    }
    if fragment.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut reader = Reader::from_str(fragment);
    let mut stack: Vec<Frame> = Vec::new();
    let mut current: Option<Raw> = None;
    let mut heading = String::new();
    let mut headings = 0;
    let mut raw_rows = Vec::new();
    loop {
        check(flag)?;
        match reader.read_event().map_err(|_| "comet-invalid-fragment")? {
            Event::Start(node) | Event::Empty(node) => {
                let tag = std::str::from_utf8(node.name().as_ref())
                    .map_err(|_| "comet-invalid-tag")?
                    .to_owned();
                if !matches!(
                    tag.as_str(),
                    "div" | "h1" | "h2" | "small" | "a" | "img" | "br" | "strong" | "em"
                ) || stack.len() >= 32
                {
                    return Err("comet-unsupported-fragment".into());
                }
                let mut class = String::new();
                for attr in node.attributes() {
                    let attr = attr.map_err(|_| "comet-invalid-attribute")?;
                    if attr.key.as_ref() == b"class" {
                        class = std::str::from_utf8(&attr.value)
                            .map_err(|_| "comet-invalid-class")?
                            .to_owned();
                        if !class
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'-' | b'_'))
                        {
                            return Err("comet-invalid-class".into());
                        }
                    }
                }
                if has(&class, "single-show") {
                    if current.is_some() || tag != "div" {
                        return Err("comet-nested-programme".into());
                    }
                    current = Some(Raw::default());
                }
                if has(&class, "print-heading") {
                    headings += 1;
                    if headings > 1 || current.is_some() {
                        return Err("comet-invalid-heading".into());
                    }
                }
                if let Some(row) = &mut current {
                    for (i, name) in ["time", "title", "episode-title", "description"]
                        .iter()
                        .enumerate()
                    {
                        if has(&class, name) {
                            row.fields[i] += 1;
                            if row.fields[i] > 1 {
                                return Err("comet-duplicate-field".into());
                            }
                        }
                    }
                }
                // Only these two observed HTML void elements may omit an end tag.
                if matches!(tag.as_str(), "img" | "br") {
                    continue;
                }
                stack.push(Frame { tag, class });
            }
            Event::End(node) => {
                let frame = stack.pop().ok_or("comet-invalid-close")?;
                if frame.tag.as_bytes() != node.name().as_ref() {
                    return Err("comet-invalid-close".into());
                }
                if has(&frame.class, "single-show") {
                    let row = current.take().ok_or("comet-invalid-programme")?;
                    if row.fields[0] != 1 || row.fields[1] != 1 {
                        return Err("comet-missing-field".into());
                    }
                    raw_rows.push(row);
                    if raw_rows.len() > 128 {
                        return Err("comet-programme-limit".into());
                    }
                } else if current.is_some() && stack.iter().any(|f| has(&f.class, "time")) {
                    append(" ", &stack, &mut current, &mut heading)?;
                }
            }
            Event::Text(value) => append(
                &value
                    .xml_content(quick_xml::XmlVersion::Explicit1_0)
                    .map_err(|_| "comet-invalid-text")?,
                &stack,
                &mut current,
                &mut heading,
            )?,
            Event::GeneralRef(value) => {
                let name = value.decode().map_err(|_| "comet-invalid-entity")?;
                let resolved = if name == "nbsp" {
                    " ".into()
                } else {
                    quick_xml::escape::unescape(&format!("&{name};"))
                        .map_err(|_| "comet-unsupported-entity")?
                        .into_owned()
                };
                append(&resolved, &stack, &mut current, &mut heading)?;
            }
            Event::Comment(_) => {}
            Event::Eof => break,
            _ => return Err("comet-unsupported-fragment".into()),
        }
    }
    if !stack.is_empty()
        || current.is_some()
        || headings != 1
        || text(&heading) != broadcast_day.format("%B %-d, %Y").to_string()
    {
        return Err("comet-fragment-day-mismatch".into());
    }
    let mut day = broadcast_day;
    let mut previous: Option<NaiveTime> = None;
    let mut rolled = false;
    let mut rows = Vec::new();
    for raw in raw_rows {
        check(flag)?;
        let clock = local_clock(&text(&raw.time))?;
        if rolled && clock.hour() >= 12 {
            return Err("comet-clock-order".into());
        }
        if let Some(before) = previous {
            if clock <= before {
                if rolled || clock == before || before.hour() < 12 || clock.hour() >= 12 {
                    return Err("comet-clock-order".into());
                }
                day = day.succ_opt().ok_or("comet-invalid-date")?;
                rolled = true;
            }
        }
        let instant = chrono_tz::America::New_York
            .from_local_datetime(&day.and_time(clock))
            .single()
            .ok_or("comet-ambiguous-or-nonexistent-local-time")?
            .timestamp_millis();
        if rows.last().is_some_and(|p: &Row| p.start >= instant) {
            return Err("comet-clock-order".into());
        }
        let series = text(&raw.title);
        let episode = text(&raw.episode);
        let description = text(&raw.description);
        if series.is_empty() || series.len() > 1024 || episode.len() > 1024 {
            return Err("comet-invalid-title".into());
        }
        rows.push(Row {
            start: instant,
            title: if episode.is_empty() {
                series
            } else {
                format!("{series} — {episode}")
            },
            description,
        });
        previous = Some(clock);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests;
