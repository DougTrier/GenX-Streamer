//! Per-channel UTC interval coverage, not programme accuracy or stream availability.
use super::database::{sql, valid_time};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MAX_ROWS: usize = 4096;
const GAP_PREVIEW: usize = 8;
// Includes filtered historical rows, not merely the <=4096 returned intervals.
const VM_STEP_BUDGET: usize = 256_000;
const VM_STEP_QUANTUM: i32 = 1000;
pub type CancelCheck = Arc<dyn Fn() -> bool + Send + Sync>;

struct ProgressScope<'a>(&'a Connection);
impl Drop for ProgressScope<'_> {
    fn drop(&mut self) {
        let _ = self.0.progress_handler(0, None::<fn() -> bool>);
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoverageRequest {
    pub schema_version: u8,
    pub source_id: String,
    pub xmltv_channel_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub expected_source_revision: i64,
    pub expected_published_revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelCoverage {
    pub schema_version: u8,
    pub start_ms: i64,
    pub end_ms: i64,
    pub status: &'static str,
    pub reason: Option<&'static str>,
    pub source_revision: Option<i64>,
    pub published_revision: Option<i64>,
    pub covered_ms: Option<i64>,
    pub gap_count: Option<usize>,
    pub gaps: Vec<Gap>,
    pub gaps_complete: bool,
    /// Unknown-end programme starts in this window; no duration is inferred.
    pub unknown_end_count: Option<usize>,
}

fn check(canceled: &CancelCheck) -> Result<(), String> {
    if canceled() {
        Err("guide-cancelled".into())
    } else {
        Ok(())
    }
}

fn initial(q: &CoverageRequest) -> ChannelCoverage {
    ChannelCoverage {
        schema_version: 1,
        start_ms: q.start_ms,
        end_ms: q.end_ms,
        status: "not-assessed",
        reason: None,
        source_revision: None,
        published_revision: None,
        covered_ms: None,
        gap_count: None,
        gaps: Vec::new(),
        gaps_complete: false,
        unknown_end_count: None,
    }
}

/// Caller owns the blocking connection and request/work lease through settlement.
/// No enabled flag exists in guide_source: refresh Off does not disable cached viewing.
pub fn query(
    c: &Connection,
    q: &CoverageRequest,
    canceled: CancelCheck,
) -> Result<ChannelCoverage, String> {
    for (value, limit) in [(&q.source_id, 256), (&q.xmltv_channel_id, 16_384)] {
        if value.trim().is_empty() || value.len() > limit || value.chars().any(char::is_control) {
            return Err("guide-invalid-field".into());
        }
    }
    valid_time(q.start_ms)?;
    valid_time(q.end_ms)?;
    if q.schema_version != 1
        || q.end_ms <= q.start_ms
        || q.end_ms - q.start_ms > WEEK_MS
        || q.expected_source_revision < 0
        || q.expected_published_revision < 0
    {
        return Err("guide-invalid-query-bounds".into());
    }
    check(&canceled)?;
    let budget_exceeded = Arc::new(AtomicBool::new(false));
    let exceeded = budget_exceeded.clone();
    let cancellation_seen = Arc::new(AtomicBool::new(false));
    let interrupted = cancellation_seen.clone();
    let during = canceled.clone();
    let mut steps = 0usize;
    sql(c.progress_handler(
        VM_STEP_QUANTUM,
        Some(move || {
            if during() {
                interrupted.store(true, Ordering::Release);
                return true;
            }
            steps += VM_STEP_QUANTUM as usize;
            if steps >= VM_STEP_BUDGET {
                exceeded.store(true, Ordering::Release);
                return true;
            }
            false
        }),
    ))?;
    let scope = ProgressScope(c);
    let result = (|| {
        let tx = sql(c.unchecked_transaction())?;
        let result = read(&tx, q, &canceled)?;
        check(&canceled)?;
        sql(tx.commit())?;
        Ok(result)
    })();
    // Transaction/rows settle before removing the connection-owned callback.
    drop(scope);
    if cancellation_seen.load(Ordering::Acquire) {
        return Err("guide-cancelled".into());
    }
    check(&canceled)?;
    if budget_exceeded.load(Ordering::Acquire) {
        let mut unknown = initial(q);
        unknown.reason = Some("work-limit");
        return Ok(unknown);
    }
    result
}

fn read(
    c: &Connection,
    q: &CoverageRequest,
    canceled: &CancelCheck,
) -> Result<ChannelCoverage, String> {
    let mut result = initial(q);
    let source: Option<(i64, Option<i64>)> = sql(c
        .query_row(
            "SELECT revision,published_revision FROM guide_source WHERE id=?1",
            [&q.source_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional())?;
    let Some((revision, published)) = source else {
        result.reason = Some("source-missing");
        return Ok(result);
    };
    if revision < 0 || published.is_some_and(|v| v < 0) {
        return Err("guide-invalid-stored-revision".into());
    }
    result.source_revision = Some(revision);
    result.published_revision = published;
    if revision != q.expected_source_revision
        || published != Some(q.expected_published_revision)
        || published != Some(revision)
    {
        result.reason = Some("source-stale");
        return Ok(result);
    }
    let exists: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM guide_channel WHERE guide_source_id=?1 AND id=?2)",
        params![q.source_id, q.xmltv_channel_id],
        |r| r.get(0),
    ))?;
    if !exists {
        result.reason = Some("channel-missing");
        return Ok(result);
    }
    // Fixed index scope; only scalar times enter memory. Sentinel detects work overflow.
    let mut statement = sql(c.prepare(
        "SELECT start_ms,stop_ms FROM guide_program INDEXED BY guide_program_channel_time
         WHERE guide_source_id=?1 AND channel_id=?2 AND start_ms<?4
         AND ((stop_ms IS NOT NULL AND stop_ms>?3) OR (stop_ms IS NULL AND start_ms>=?3))
         ORDER BY start_ms,ordinal LIMIT 4097",
    ))?;
    let mut rows = sql(statement.query(params![
        q.source_id,
        q.xmltv_channel_id,
        q.start_ms,
        q.end_ms
    ]))?;
    let mut visited = 0;
    let mut cursor = q.start_ms;
    let mut covered = 0;
    let mut gaps = 0;
    let mut unknown = 0;
    while let Some(row) = sql(rows.next())? {
        check(canceled)?;
        visited += 1;
        if visited > MAX_ROWS {
            result.reason = Some("work-limit");
            result.gaps.clear();
            return Ok(result);
        }
        let start: i64 = sql(row.get(0))?;
        let stop: Option<i64> = sql(row.get(1))?;
        valid_time(start)?;
        let Some(stop) = stop else {
            unknown += 1;
            continue;
        };
        valid_time(stop)?;
        if stop <= start {
            return Err("guide-invalid-program-end".into());
        }
        let start = start.max(q.start_ms);
        let stop = stop.min(q.end_ms);
        if start > cursor {
            add_gap(&mut result.gaps, &mut gaps, cursor, start);
        }
        if stop > cursor {
            covered += stop - cursor.max(start);
            cursor = stop;
        }
    }
    check(canceled)?;
    if cursor < q.end_ms {
        add_gap(&mut result.gaps, &mut gaps, cursor, q.end_ms);
    }
    result.status = "assessed";
    result.covered_ms = Some(covered);
    result.gap_count = Some(gaps);
    result.gaps_complete = gaps <= GAP_PREVIEW;
    result.unknown_end_count = Some(unknown);
    Ok(result)
}

fn add_gap(preview: &mut Vec<Gap>, count: &mut usize, start_ms: i64, end_ms: i64) {
    *count += 1;
    if preview.len() < GAP_PREVIEW {
        preview.push(Gap { start_ms, end_ms });
    }
}

#[cfg(test)]
#[path = "channel_coverage_tests.rs"]
mod tests;
