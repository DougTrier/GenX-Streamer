//! Private scalar progress inspection, not policy/TTL/digest admission or resumability.
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
const LIMIT: usize = 20 * 1024 * 1024;
const COUNT_LIMIT: usize = 100_000;
struct Counts {
    version: u8,
    total: usize,
    checked: usize,
    responded: usize,
    published: usize,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    schema_version: u8,
    checkpoint_status: &'static str,
    stored_version: Option<u8>,
    total: usize,
    checked: usize,
    responded: usize,
    published: usize,
    unfinished: bool,
    catalog_revision: String,
    checkpoint_revision: String,
}
pub(crate) struct Captured {
    catalog_revision: i64,
    checkpoint_revision: i64,
    row_version: i64,
    job: Option<String>,
    raw: Option<String>,
    oversized: bool,
}
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| crate::storage_transaction::sql_error_code(&e, "scan-checkpoint-storage-failed"))
}
pub(crate) fn capture(c: &Connection) -> Result<Captured, String> {
    let catalog_revision = sql(c.query_row(
        "SELECT catalog_revision FROM metadata WHERE singleton=1",
        [],
        |r| r.get::<_, i64>(0),
    ))?;
    let exists: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_checkpoint')",
        [],
        |r| r.get(0),
    ))?;
    let (row_version, checkpoint_revision, job, raw, oversized) = if exists {
        sql(c.query_row("SELECT schema_version,revision,CASE WHEN length(CAST(job_id AS BLOB))<=128 THEN job_id ELSE NULL END,CASE WHEN length(CAST(contents AS BLOB))<=?1 THEN contents ELSE NULL END,COALESCE(length(CAST(contents AS BLOB))>?1,0) OR COALESCE(length(CAST(job_id AS BLOB))>128,0) FROM scan_checkpoint WHERE singleton=1", [LIMIT as i64], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,bool>(4)?))).optional())?.ok_or("scan-checkpoint-storage-failed")?
    } else {
        (1, 0, None, None, false)
    };
    if catalog_revision < 0 || checkpoint_revision < 0 {
        return Err("storage-revision-invalid".into());
    }
    Ok(Captured {
        catalog_revision,
        checkpoint_revision,
        row_version,
        job,
        raw,
        oversized,
    })
}
fn text(v: &Value) -> Option<&str> {
    v.as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
}
fn array(v: &Value) -> Option<&Vec<Value>> {
    v.as_array().filter(|v| v.len() <= COUNT_LIMIT)
}
fn counts(
    v: &Value,
    job: &str,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Option<Counts>, String> {
    let Some(version) = v["schemaVersion"].as_u64().filter(|v| matches!(*v, 1..=3)) else {
        return Ok(None);
    };
    if v["jobId"].as_str() != Some(job) {
        return Ok(None);
    }
    let Some(candidates) = array(&v["review"]["candidates"]) else {
        return Ok(None);
    };
    let Some(observations) = array(&v["observations"]) else {
        return Ok(None);
    };
    let published_field = if version == 3 {
        "publishedIndices"
    } else {
        "publishedKeys"
    };
    let Some(published) = array(&v[published_field]) else {
        return Ok(None);
    };
    let mut keys = HashMap::new();
    for (index, candidate) in candidates.iter().enumerate() {
        if index.is_multiple_of(128) {
            check()?;
        }
        let key = if version == 3 {
            let Some(row) = candidate.as_array().filter(|r| r.len() == 9) else {
                return Ok(None);
            };
            text(&row[0])
        } else {
            text(&candidate["key"])
        };
        let Some(key) = key else { return Ok(None) };
        if keys.insert(key, index).is_some() {
            return Ok(None);
        }
    }
    let ordinal = |value: &Value| -> Option<usize> {
        if version == 3 {
            value
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .filter(|n| *n < candidates.len())
        } else {
            value.as_str().and_then(|k| keys.get(k).copied())
        }
    };
    let mut seen = HashMap::new();
    let mut responded = 0;
    for (index, observation) in observations.iter().enumerate() {
        if index.is_multiple_of(128) {
            check()?;
        }
        let (key, verdict) = if version == 3 {
            let Some(row) = observation.as_array().filter(|r| r.len() == 4) else {
                return Ok(None);
            };
            (&row[0], &row[2])
        } else {
            (&observation["channelId"], &observation["verdict"])
        };
        let Some(index) = ordinal(key) else {
            return Ok(None);
        };
        let Some(verdict) = verdict.as_str().filter(|v| {
            matches!(
                *v,
                "Reachable"
                    | "PlayedHere"
                    | "TimedOut"
                    | "AccessDenied"
                    | "TemporaryUnavailable"
                    | "UnsupportedHere"
            )
        }) else {
            return Ok(None);
        };
        let responding = matches!(verdict, "Reachable" | "PlayedHere");
        if seen.insert(index, responding).is_some() {
            return Ok(None);
        }
        responded += usize::from(responding);
    }
    let mut acked = HashSet::new();
    for (index, key) in published.iter().enumerate() {
        if index.is_multiple_of(128) {
            check()?;
        }
        let Some(index) = ordinal(key) else {
            return Ok(None);
        };
        if !acked.insert(index) || seen.get(&index) != Some(&true) {
            return Ok(None);
        }
    }
    Ok(Some(Counts {
        version: version as u8,
        total: candidates.len(),
        checked: seen.len(),
        responded,
        published: acked.len(),
    }))
}
pub(crate) fn finish(
    c: Captured,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Summary, String> {
    check()?;
    let mut result = Summary {
        schema_version: 1,
        checkpoint_status: "invalid",
        stored_version: None,
        total: 0,
        checked: 0,
        responded: 0,
        published: 0,
        unfinished: false,
        catalog_revision: c.catalog_revision.to_string(),
        checkpoint_revision: c.checkpoint_revision.to_string(),
    };
    if c.row_version != 1 || c.oversized {
        check()?;
        return Ok(result);
    }
    match (c.job, c.raw) {
        (None, None) => result.checkpoint_status = "absent",
        (Some(job), Some(raw))
            if job.len() <= 128
                && text(&Value::String(job.clone())).is_some()
                && raw.len() <= LIMIT =>
        {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                if let Some(Counts {
                    version,
                    total,
                    checked,
                    responded,
                    published,
                }) = counts(&v, &job, &mut check)?
                {
                    result.checkpoint_status = "valid";
                    result.stored_version = Some(version);
                    result.total = total;
                    result.checked = checked;
                    result.responded = responded;
                    result.published = published;
                    result.unfinished = checked < total || published < responded;
                }
            }
        }
        _ => {}
    }
    check()?;
    Ok(result)
}

#[cfg(test)]
#[path = "scan_checkpoint_summary_tests.rs"]
mod tests;
