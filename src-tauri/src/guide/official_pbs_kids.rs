// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
//! Fixed official PBS KIDS national 24/7 schedule; never a regional/name merge
//! or a generic GraphQL client. Publication uses the ordinary XMLTV owners.
use chrono::{NaiveDate, NaiveTime, TimeZone, Utc};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
};

pub(crate) const LOCATION: &str = "https://pbskids.org/videos/watch/live";
pub(crate) const API: &str = "https://graph.services.pbskids.org/";
pub(crate) const BODY_LIMIT: usize = 2 * 1024 * 1024;
const CHANNEL: &str = "PBSKids.us@SD";

pub(crate) fn handles(location: &str) -> bool {
    location == LOCATION
}
pub(crate) fn main_provider(id: &str) -> bool {
    matches!(id, "PBSKids.us" | "PBSKids.us@SD")
}
fn check(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::SeqCst) {
        Err("canceled".into())
    } else {
        Ok(())
    }
}
fn dates(now: i64) -> Result<Vec<NaiveDate>, String> {
    let today = Utc
        .timestamp_millis_opt(now)
        .single()
        .ok_or("pbs-invalid-clock")?
        .with_timezone(&chrono_tz::America::New_York)
        .date_naive();
    (0..8)
        .map(|n| {
            today
                .checked_add_days(chrono::Days::new(n))
                .ok_or_else(|| "pbs-invalid-clock".into())
        })
        .collect()
}
fn request_body(days: &[NaiveDate]) -> Result<Vec<u8>, String> {
    if days.is_empty() || days.len() > 8 || days.windows(2).any(|p| p[0].succ_opt() != Some(p[1])) {
        return Err("pbs-invalid-days".into());
    }
    let definitions = (0..days.len())
        .map(|i| format!("$d{i}:String!"))
        .collect::<Vec<_>>()
        .join(",");
    let fields =
        "short_name listings{title episode_title minutes nola_episode nola_root start_time}";
    let selections = (0..days.len())
        .map(|i| {
            format!("day{i}:tvSchedulesFeeds(station_callsign:$station,date:$d{i}){{{fields}}}")
        })
        .collect::<String>();
    let query =
        format!("query GenXNationalPBSKIDS($station:String!,{definitions}){{{selections}}}");
    let mut variables = serde_json::Map::new();
    variables.insert("station".into(), "PBSKIDS247".into());
    for (i, day) in days.iter().enumerate() {
        variables.insert(format!("d{i}"), day.format("%Y%m%d").to_string().into());
    }
    serde_json::to_vec(&serde_json::json!({"query":query,"variables":variables}))
        .map_err(|_| "pbs-request-invalid".into())
}
pub(crate) async fn fetch(now: i64, flag: &AtomicBool) -> Result<Vec<u8>, String> {
    check(flag)?;
    let body = request_body(&dates(now)?)?;
    let mut response = crate::network::response_pbs_kids_metadata(&body).await?;
    check(flag)?;
    if response.status() != reqwest::StatusCode::OK
        || response.url() != &reqwest::Url::parse(API).map_err(|_| "pbs-invalid-url")?
        || !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|s| {
                s.split(';')
                    .next()
                    .is_some_and(|m| m.trim().eq_ignore_ascii_case("application/json"))
            })
    {
        return Err("pbs-response-unavailable".into());
    }
    if response
        .content_length()
        .is_some_and(|n| n > BODY_LIMIT as u64)
        || response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .is_some_and(|v| v.as_bytes() != b"identity")
    {
        return Err("pbs-response-limit-or-coding".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "pbs-read-failed")? {
        check(flag)?;
        if chunk.len() > BODY_LIMIT.saturating_sub(bytes.len()) {
            return Err("pbs-response-too-large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    check(flag)?;
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    data: BTreeMap<String, Vec<Feed>>,
    #[serde(default)]
    errors: Option<Vec<serde_json::Value>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Feed {
    short_name: String,
    listings: Vec<Listing>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Listing {
    title: String,
    episode_title: String,
    minutes: u16,
    nola_episode: String,
    nola_root: String,
    start_time: String,
}
struct Program {
    start: i64,
    declared_stop: i64,
    title: String,
    episode: String,
}
fn text_ok(value: &str, limit: usize) -> bool {
    value.len() <= limit
        && value.chars().all(|c| {
            matches!(c, '\t' | '\n' | '\r') || (c >= '\u{20}' && c != '\u{fffe}' && c != '\u{ffff}')
        })
}
pub(crate) fn normalize(bytes: &[u8], now: i64, flag: &AtomicBool) -> Result<Vec<u8>, String> {
    normalize_days(bytes, &dates(now)?, flag)
}
fn normalize_days(bytes: &[u8], days: &[NaiveDate], flag: &AtomicBool) -> Result<Vec<u8>, String> {
    check(flag)?;
    if bytes.len() > BODY_LIMIT
        || days.is_empty()
        || days.len() > 8
        || days.windows(2).any(|p| p[0].succ_opt() != Some(p[1]))
    {
        return Err("pbs-response-limit".into());
    }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| "pbs-invalid-json")?;
    if envelope.errors.is_some_and(|e| !e.is_empty())
        || envelope.data.len() != days.len()
        || (0..days.len()).any(|i| !envelope.data.contains_key(&format!("day{i}")))
    {
        return Err("pbs-response-day-or-error-mismatch".into());
    }
    let mut programs: Vec<Program> = Vec::new();
    for (i, day) in days.iter().enumerate() {
        check(flag)?;
        let feeds = &envelope.data[&format!("day{i}")];
        if feeds.len() != 1
            || feeds[0].short_name != "Kids 24/7"
            || feeds[0].listings.is_empty()
            || feeds[0].listings.len() > 128
        {
            return Err("pbs-feed-or-record-limit".into());
        }
        let mut previous = None;
        for row in &feeds[0].listings {
            check(flag)?;
            if row.start_time.len() != 4
                || !row.start_time.bytes().all(|b| b.is_ascii_digit())
                || row.minutes == 0
                || row.minutes > 1440
                || row.title.trim().is_empty()
                || !text_ok(&row.title, 1024)
                || !text_ok(&row.episode_title, 2048)
                || !text_ok(&row.nola_episode, 128)
                || !text_ok(&row.nola_root, 128)
            {
                return Err("pbs-invalid-listing".into());
            }
            let clock = NaiveTime::parse_from_str(&row.start_time, "%H%M")
                .map_err(|_| "pbs-invalid-clock-label")?;
            if previous.is_some_and(|p| clock < p) {
                return Err("pbs-clock-order".into());
            }
            previous = Some(clock);
            let start = chrono_tz::America::New_York
                .from_local_datetime(&day.and_time(clock))
                .single()
                .ok_or("pbs-ambiguous-or-nonexistent-local-time")?
                .timestamp_millis();
            let declared_stop = start
                .checked_add(i64::from(row.minutes) * 60_000)
                .ok_or("pbs-invalid-duration")?;
            let program = Program {
                start,
                declared_stop,
                title: row.title.clone(),
                episode: row.episode_title.clone(),
            };
            // Official module79103 w()/P(): last matching publisher row wins;
            // later distinct starts take over, and declared gaps stay gaps.
            if programs.last().is_some_and(|p| p.start == start) {
                programs.pop();
            }
            programs.push(program);
        }
    }
    if programs.is_empty() || programs.len() > 1024 {
        return Err("pbs-empty-or-excessive-schedule".into());
    }
    let stamp = |ms| {
        Utc.timestamp_millis_opt(ms)
            .single()
            .map(|d| d.format("%Y%m%d%H%M%S +0000").to_string())
            .ok_or("pbs-invalid-clock")
    };
    let mut xml = format!("<?xml version='1.0' encoding='UTF-8'?><tv><channel id='{CHANNEL}'><display-name>PBS KIDS</display-name></channel>");
    for (i, row) in programs.iter().enumerate() {
        check(flag)?;
        let stop = programs
            .get(i + 1)
            .map_or(row.declared_stop, |next| row.declared_stop.min(next.start));
        if stop <= row.start {
            return Err("pbs-invalid-interval".into());
        }
        xml.push_str(&format!(
            "<programme channel='{CHANNEL}' start='{}' stop='{}'><title>{}</title>",
            stamp(row.start)?,
            stamp(stop)?,
            quick_xml::escape::escape(&row.title)
        ));
        if !row.episode.is_empty() {
            let episode = quick_xml::escape::escape(&row.episode);
            // The generic parser currently keeps desc, not sub-title. Preserve
            // the published episode verbatim for ordinary saved-Guide search.
            xml.push_str(&format!(
                "<sub-title>{episode}</sub-title><desc>{episode}</desc>"
            ));
        }
        xml.push_str("</programme>");
        if xml.len() > BODY_LIMIT {
            return Err("pbs-normalized-limit".into());
        }
    }
    xml.push_str("</tv>");
    Ok(xml.into_bytes())
}
pub(crate) fn suggestion<'a>(
    providers: impl Iterator<Item = &'a str>,
) -> Option<super::crosswalk_pack::FeedSuggestion> {
    let count = providers
        .filter(|id| main_provider(id))
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    (count > 0).then(|| super::crosswalk_pack::FeedSuggestion {
        name: "Official PBS KIDS · national 24/7 feed".into(),
        location: LOCATION.into(),
        channels: count,
    })
}

#[cfg(test)]
mod tests;
