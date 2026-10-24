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

use super::database::{self as db, GuideSource};
use crate::refresh_cadence::Cadence;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
/// Automatic refresh must contain a real known interval extending beyond the
/// admission instant. This is not per-channel continuity or seven-day coverage.
pub(crate) fn admit_schedule(
    feed: &super::parser::ParsedGuide,
    now: i64,
    canceled: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    db::valid_time(now)?;
    if feed.programs.is_empty() {
        return Err("guide-empty-confirmation-required".into());
    }
    let mut known_nonexpired = false;
    for program in &feed.programs {
        if canceled.load(Ordering::SeqCst) {
            return Err("canceled".into());
        }
        db::valid_time(program.start_ms)?;
        if let Some(stop) = program.stop_ms {
            db::valid_time(stop)?;
            if stop <= program.start_ms {
                return Err("guide-invalid-program-end".into());
            }
            known_nonexpired |= stop > now;
        }
    }
    if !known_nonexpired {
        return Err("guide-refresh-no-future-schedule".into());
    }
    Ok(())
}
fn saved_cadence(c: &Connection) -> Result<Cadence, String> {
    // Guide renewal has its own permission and daily policy. Channel cadence
    // must not disable, accelerate or delay program-guide renewal.
    let has_control: bool = db::sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('metadata') WHERE name='automatic_guide_updates')",
        [],
        |r| r.get(0),
    ))?;
    if !has_control {
        // Older schemas did not expose the option; absence remains enabled.
        let version: i64 = db::sql(c.query_row("PRAGMA user_version", [], |row| row.get(0)))?;
        if version >= 11 {
            return Err("guide-refresh-invalid-policy".into());
        }
        return Ok(Cadence::Daily);
    }
    let enabled: Option<Option<i64>> = db::sql(
        c.query_row(
            "SELECT automatic_guide_updates FROM metadata WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional(),
    )?;
    match enabled {
        Some(Some(0)) => Ok(Cadence::Off),
        Some(Some(1)) | Some(None) => Ok(Cadence::Daily),
        _ => Err("guide-refresh-invalid-policy".into()),
    }
}
/// Call inside the automatic publication transaction, not merely before it.
pub(crate) fn require_automatic_updates(c: &Connection) -> Result<(), String> {
    if saved_cadence(c)? == Cadence::Off {
        return Err("guide-refresh-disabled".into());
    }
    Ok(())
}
pub(crate) fn next_after_success(c: &Connection, updated: i64) -> Result<i64, String> {
    saved_cadence(c)?
        .next(updated)?
        .ok_or_else(|| "guide-refresh-disabled".into())
}
#[path = "refresh_coverage.rs"]
mod coverage;
pub use coverage::MappedTargets;
pub(crate) fn mapped_targets(c: &Connection, id: &str, now: i64) -> Result<MappedTargets, String> {
    let source = db::list_sources(c)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("guide-source-missing")?;
    coverage::read(c, &source, now)
}
pub(crate) fn next_after_feed(
    c: &Connection,
    source: &GuideSource,
    feed: &super::parser::ParsedGuide,
    updated: i64,
    canceled: &std::sync::atomic::AtomicBool,
) -> Result<i64, String> {
    let daily = next_after_success(c, updated)?;
    coverage::after_feed(c, source, feed, updated, daily, canceled)
}

#[cfg(test)]
#[path = "refresh_coverage_tests.rs"]
mod coverage_tests;
#[cfg(test)]
#[path = "refresh_tests.rs"]
mod tests;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshCandidate {
    pub source_id: String,
    pub source_revision: i64,
    pub next_due_ms: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshPlan {
    pub now_ms: i64,
    pub sources: Vec<RefreshCandidate>,
}
fn fingerprint(source: &GuideSource) -> Result<String, String> {
    db::key((
        &source.id,
        &source.kind,
        &source.location,
        source.allow_http,
    ))
}
fn attempted(c: &Connection, source: &GuideSource) -> Result<Option<i64>, String> {
    let exists:bool=db::sql(c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='guide_refresh_state')",[],|r|r.get(0)))?;
    if !exists {
        return Ok(None);
    }
    db::sql(c.query_row("SELECT attempted_ms FROM guide_refresh_state WHERE source_id=?1 AND fingerprint=?2 AND schema_version=1",params![source.id,fingerprint(source)?],|r|r.get(0)).optional())
}
fn candidate(
    c: &Connection,
    source: &GuideSource,
    cadence: Cadence,
) -> Result<Option<RefreshCandidate>, String> {
    let coverage = db::source_coverage(c, &source.id)?;
    if source.kind != "url"
        || coverage.published_revision != Some(source.revision)
        || source.updated_ms.is_none()
    {
        return Ok(None);
    }
    let last = attempted(c, source)?
        .unwrap_or(0)
        .max(source.updated_ms.unwrap_or(0));
    Ok(Some(RefreshCandidate {
        source_id: source.id.clone(),
        source_revision: source.revision,
        next_due_ms: coverage::due(
            &coverage::read(c, source, source.updated_ms.unwrap_or(0))?,
            source.updated_ms.unwrap_or(0),
            cadence.next(last)?.ok_or("guide-refresh-disabled")?,
        ),
    }))
}
pub fn plan(c: &Connection, now: i64) -> Result<RefreshPlan, String> {
    db::valid_time(now)?;
    let tx = db::sql(c.unchecked_transaction())?;
    let cadence = saved_cadence(&tx)?;
    let mut sources = Vec::new();
    for source in db::list_sources(&tx)?
        .into_iter()
        .filter(|_| cadence != Cadence::Off)
    {
        if let Some(candidate) = candidate(&tx, &source, cadence)? {
            sources.push(candidate);
        }
    }
    db::sql(tx.commit())?;
    Ok(RefreshPlan {
        now_ms: now,
        sources,
    })
}
#[cfg(test)]
pub fn claim(
    c: &mut Connection,
    id: &str,
    revision: i64,
    now: i64,
) -> Result<(GuideSource, i64, bool), String> {
    claim_checked(c, id, revision, now, &mut || Ok(()))
}
pub(crate) fn claim_checked(
    c: &mut Connection,
    id: &str,
    revision: i64,
    now: i64,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(GuideSource, i64, bool), String> {
    check()?;
    db::valid_time(now)?;
    let tx = db::sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let cadence = saved_cadence(&tx)?;
    if cadence == Cadence::Off {
        return Err("guide-refresh-disabled".into());
    }
    let source = db::list_sources(&tx)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("guide-source-missing")?;
    if source.revision != revision {
        return Err("guide-stale-revision".into());
    }
    let ready = candidate(&tx, &source, cadence)?.ok_or("guide-refresh-source-unapproved")?;
    if now < ready.next_due_ms {
        check()?;
        return Ok((source, ready.next_due_ms, false));
    }
    let next_due = if coverage::read(&tx, &source, now)?.target_count > 0 {
        now.checked_add(coverage::COOLDOWN)
            .ok_or("guide-clock-unavailable")?
    } else {
        cadence.next(now)?.ok_or("guide-refresh-disabled")?
    };
    db::valid_time(next_due)?;
    db::sql(tx.execute_batch("CREATE TABLE IF NOT EXISTS guide_refresh_state(source_id TEXT PRIMARY KEY REFERENCES guide_source(id) ON DELETE CASCADE,schema_version INTEGER NOT NULL CHECK(schema_version=1),fingerprint TEXT NOT NULL,attempted_ms INTEGER NOT NULL);"))?;
    db::sql(tx.execute("INSERT INTO guide_refresh_state VALUES(?1,1,?2,?3) ON CONFLICT(source_id) DO UPDATE SET schema_version=1,fingerprint=excluded.fingerprint,attempted_ms=excluded.attempted_ms",params![id,fingerprint(&source)?,now]))?;
    check()?;
    db::sql(tx.commit())?;
    Ok((source, next_due, true))
}

/// Read-only negative claim proof, under the same checked Store writer/root lease.
/// The mutating claim repeats permission, source revision and due checks after backup.
pub(crate) fn preflight_claim(
    c: &Connection,
    id: &str,
    revision: i64,
    now: i64,
) -> Result<Option<(GuideSource, i64, bool)>, String> {
    db::valid_time(now)?;
    let cadence = saved_cadence(c)?;
    if cadence == Cadence::Off {
        return Err("guide-refresh-disabled".into());
    }
    let source = db::list_sources(c)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("guide-source-missing")?;
    if source.revision != revision {
        return Err("guide-stale-revision".into());
    }
    let ready = candidate(c, &source, cadence)?.ok_or("guide-refresh-source-unapproved")?;
    Ok((now < ready.next_due_ms).then_some((source, ready.next_due_ms, false)))
}
