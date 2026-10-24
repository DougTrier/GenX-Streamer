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

//! Read-only mapped-target horizons. A horizon is not a promise of gap-free listings.
use super::{attempted, db, GuideSource};
use crate::guide::parser::ParsedGuide;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) const LEAD: i64 = 15 * 60_000;
pub(super) const COOLDOWN: i64 = 3_600_000;
const TARGETS: &str = "SELECT DISTINCT m.xmltv_channel_id FROM guide_mapping m JOIN channel c ON c.id=m.app_channel_id AND c.source_id=m.catalog_source_id JOIN source s ON s.id=c.source_id WHERE m.guide_source_id=?1 AND NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=c.id)";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappedTargets {
    pub version: i64,
    pub assessed_ms: i64,
    pub target_count: i64,
    pub known_end_count: i64,
    pub missing_end_count: i64,
    pub expired_count: i64,
    pub earliest_last_stop_ms: Option<i64>,
    pub cooldown_until_ms: i64,
}

fn catalog_present(c: &Connection) -> Result<bool, String> {
    let count: i64 = db::sql(c.query_row("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN('channel','source','removed')", [], |r| r.get(0)))?;
    if count == 3 {
        return Ok(true);
    }
    let version: i64 = db::sql(c.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
    // Standalone legacy Guide hosts have no catalog. A current Store cannot omit it.
    if count == 0 && version < 11 {
        Ok(false)
    } else {
        Err("guide-refresh-catalog-unavailable".into())
    }
}

fn floor(updated: i64, attempt: Option<i64>) -> Result<i64, String> {
    let last = updated.max(attempt.unwrap_or(updated));
    db::valid_time(last)?;
    let due = last
        .checked_add(COOLDOWN)
        .ok_or("guide-clock-unavailable")?;
    db::valid_time(due)?;
    Ok(due)
}

pub(super) fn read(
    c: &Connection,
    source: &GuideSource,
    now: i64,
) -> Result<MappedTargets, String> {
    db::valid_time(now)?;
    let mut result = MappedTargets {
        version: 1,
        assessed_ms: now,
        target_count: 0,
        known_end_count: 0,
        missing_end_count: 0,
        expired_count: 0,
        earliest_last_stop_ms: None,
        cooldown_until_ms: floor(source.updated_ms.unwrap_or(now), attempted(c, source)?)?,
    };
    if !catalog_present(c)? {
        return Ok(result);
    }
    // Materialize each target once, then use the existing channel/time index. Other
    // headers and duplicated catalog aliases cannot hide an exhausted mapped target.
    let sql = format!("WITH targets AS MATERIALIZED ({TARGETS} LIMIT 100001), horizons AS MATERIALIZED (SELECT (SELECT max(stop_ms) FROM guide_program p WHERE p.guide_source_id=?1 AND p.channel_id=t.xmltv_channel_id) AS last_stop FROM targets t) SELECT count(*),count(last_stop),coalesce(sum(last_stop<=?2),0),min(last_stop) FROM horizons");
    let (targets, known, expired, earliest): (i64, i64, i64, Option<i64>) =
        db::sql(c.query_row(&sql, rusqlite::params![source.id, now], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        }))?;
    if targets > 100000 {
        return Err("guide-refresh-target-limit".into());
    }
    result.target_count = targets;
    result.known_end_count = known;
    result.missing_end_count = targets - known;
    result.expired_count = expired;
    result.earliest_last_stop_ms = earliest;
    Ok(result)
}

pub(super) fn due(stats: &MappedTargets, updated: i64, daily: i64) -> i64 {
    if stats.target_count == 0 {
        return daily;
    }
    let coverage_due = if stats.missing_end_count > 0 {
        updated
    } else {
        stats
            .earliest_last_stop_ms
            .unwrap_or(updated)
            .saturating_sub(LEAD)
            .max(0)
    };
    daily.min(coverage_due).max(stats.cooldown_until_ms)
}

pub(super) fn after_feed(
    c: &Connection,
    source: &GuideSource,
    feed: &ParsedGuide,
    updated: i64,
    daily: i64,
    canceled: &AtomicBool,
) -> Result<i64, String> {
    if canceled.load(Ordering::Acquire) {
        return Err("canceled".into());
    }
    if !catalog_present(c)? {
        return Ok(daily);
    }
    let sql = format!("{TARGETS} LIMIT 100001");
    let mut statement = db::sql(c.prepare(&sql))?;
    let rows = db::sql(statement.query_map([&source.id], |r| r.get::<_, String>(0)))?;
    let mut horizons = HashMap::<String, Option<i64>>::new();
    let mut bytes = 0usize;
    for row in rows {
        if canceled.load(Ordering::Acquire) {
            return Err("canceled".into());
        }
        let id = db::sql(row)?;
        bytes = bytes.saturating_add(id.len());
        if horizons.len() >= 100000 || bytes > 16 * 1024 * 1024 {
            return Err("guide-refresh-target-limit".into());
        }
        horizons.insert(id, None);
    }
    for program in &feed.programs {
        if canceled.load(Ordering::Acquire) {
            return Err("canceled".into());
        }
        if let (Some(last), Some(stop)) = (horizons.get_mut(&program.channel_id), program.stop_ms) {
            db::valid_time(stop)?;
            if stop <= program.start_ms {
                return Err("guide-invalid-program-end".into());
            }
            *last = Some(last.unwrap_or(stop).max(stop));
        }
    }
    let known = horizons.values().flatten().count() as i64;
    let stats = MappedTargets {
        version: 1,
        assessed_ms: updated,
        target_count: horizons.len() as i64,
        known_end_count: known,
        missing_end_count: horizons.len() as i64 - known,
        expired_count: horizons
            .values()
            .flatten()
            .filter(|end| **end <= updated)
            .count() as i64,
        earliest_last_stop_ms: horizons.values().flatten().copied().min(),
        cooldown_until_ms: floor(updated, None)?,
    };
    Ok(due(&stats, updated, daily))
}
