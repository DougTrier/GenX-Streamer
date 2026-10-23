//! Complete selected-channel candidates in one snapshot, independent of schedule page size.
use super::*;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SummaryQuery {
    pub catalog_source_id: String,
    pub app_channel_id: String,
    pub at_ms: i64,
    pub request_id: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SummaryIdentity {
    pub catalog_source_id: String,
    pub app_channel_id: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleSummaries {
    pub request_id: String,
    pub at_ms: i64,
    pub catalog_revision: String,
    pub database_revision: i64,
    pub rows: Vec<SelectedSummary>,
}
#[derive(Clone)]
struct SourceMetadata {
    revision: i64,
    published: Option<i64>,
    updated: Option<i64>,
    bounds: (Option<i64>, Option<i64>),
}
type SourceCache = HashMap<String, Option<SourceMetadata>>;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryProgram {
    pub title: String,
    pub start_ms: i64,
    pub stop_ms: Option<i64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryCoverage {
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedSummary {
    pub request_id: String,
    pub catalog_source_id: String,
    pub app_channel_id: String,
    pub at_ms: i64,
    pub catalog_revision: String,
    pub database_revision: i64,
    pub mapping_status: &'static str,
    pub mapping: Option<GuideMapping>,
    pub source_revision: Option<i64>,
    pub published_revision: Option<i64>,
    pub updated_ms: Option<i64>,
    pub coverage: SummaryCoverage,
    pub cache_status: &'static str,
    pub current_status: Option<&'static str>,
    pub next_status: Option<&'static str>,
    pub current: Option<SummaryProgram>,
    pub next: Option<SummaryProgram>,
}
struct ProgressScope<'a>(&'a Connection);
impl Drop for ProgressScope<'_> {
    fn drop(&mut self) {
        let _ = self.0.progress_handler(0, None::<fn() -> bool>);
    }
}
type CancelCheck = Arc<dyn Fn() -> bool + Send + Sync>;
fn check(cancel: &CancelCheck) -> Result<(), String> {
    if cancel() {
        Err("canceled".into())
    } else {
        Ok(())
    }
}
/// Callback is connection-scoped and removed before this owned connection can be reused.
pub fn selected_summary(
    c: &Connection,
    q: &SummaryQuery,
    cancel: CancelCheck,
) -> Result<SelectedSummary, String> {
    valid_text(&q.catalog_source_id, 256, true)?;
    valid_text(&q.app_channel_id, 16_384, true)?;
    valid_time(q.at_ms)?;
    if q.request_id.is_empty()
        || q.request_id.len() > 128
        || !q
            .request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("guide-invalid-request-id".into());
    }
    check(&cancel)?;
    let during = cancel.clone();
    sql(c.progress_handler(1000, Some(move || during())))?;
    let _scope = ProgressScope(c);
    let result = read_snapshot(c, q, &cancel);
    check(&cancel)?;
    let summary = result?;
    if serde_json::to_vec(&summary)
        .map_err(|_| "guide-summary-serialization-failed")?
        .len()
        > 128 * 1024
    {
        return Err("guide-summary-byte-limit".into());
    }
    Ok(summary)
}
/// One snapshot and connection-scoped cancellation owner for the entire visible set.
pub fn visible_summaries(
    c: &Connection,
    request_id: &str,
    at_ms: i64,
    channels: &[SummaryIdentity],
    cancel: CancelCheck,
) -> Result<VisibleSummaries, String> {
    if channels.is_empty() || channels.len() > 64 {
        return Err("guide-summary-channel-limit".into());
    }
    let mut unique = HashSet::new();
    for id in channels {
        valid_text(&id.catalog_source_id, 256, true)?;
        valid_text(&id.app_channel_id, 16_384, true)?;
        if !unique.insert((&id.catalog_source_id, &id.app_channel_id)) {
            return Err("guide-summary-duplicate-channel".into());
        }
    }
    valid_time(at_ms)?;
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("guide-invalid-request-id".into());
    }
    check(&cancel)?;
    let during = cancel.clone();
    sql(c.progress_handler(1000, Some(move || during())))?;
    let _scope = ProgressScope(c);
    let result = (|| {
        let tx = sql(c.unchecked_transaction())?;
        let cr: i64 = sql(tx.query_row(
            "SELECT catalog_revision FROM metadata WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        let dr = database_revision(&tx)?;
        let mut cache = SourceCache::new();
        let mut rows = Vec::with_capacity(channels.len());
        let mut row_bytes = 0usize;
        for id in channels {
            check(&cancel)?;
            let q = SummaryQuery {
                catalog_source_id: id.catalog_source_id.clone(),
                app_channel_id: id.app_channel_id.clone(),
                at_ms,
                request_id: request_id.into(),
            };
            let row = read_row(&tx, &q, cr, dr, &mut cache, &cancel)?;
            let size = serde_json::to_vec(&row)
                .map_err(|_| "guide-summary-serialization-failed")?
                .len();
            if size > 128 * 1024 {
                return Err("guide-summary-byte-limit".into());
            }
            row_bytes += size;
            if row_bytes > 512 * 1024 {
                return Err("guide-summary-batch-byte-limit".into());
            }
            rows.push(row);
        }
        check(&cancel)?;
        let out = VisibleSummaries {
            request_id: request_id.into(),
            at_ms,
            catalog_revision: cr.to_string(),
            database_revision: dr,
            rows,
        };
        if serde_json::to_vec(&out)
            .map_err(|_| "guide-summary-serialization-failed")?
            .len()
            > 512 * 1024
        {
            return Err("guide-summary-batch-byte-limit".into());
        }
        check(&cancel)?;
        sql(tx.commit())?;
        Ok(out)
    })();
    check(&cancel)?;
    result
}
fn candidates(
    c: &Connection,
    mapping: &GuideMapping,
    at: i64,
    future: bool,
) -> Result<Vec<SummaryProgram>, String> {
    // DISTINCT includes description, matching the pure domain identity despite compact output.
    let predicate = if future {
        "p.start_ms=(SELECT min(n.start_ms) FROM guide_program n WHERE n.guide_source_id=?1 AND n.channel_id=?2 AND n.start_ms>?3 AND n.start_ms<?4)"
    } else {
        "p.start_ms<=?3 AND ((p.stop_ms IS NOT NULL AND p.stop_ms>?3) OR (p.stop_ms IS NULL AND p.start_ms=(SELECT max(n.start_ms) FROM guide_program n WHERE n.guide_source_id=?1 AND n.channel_id=?2 AND n.start_ms<=?3)))"
    };
    let query=format!("SELECT DISTINCT p.start_ms,p.stop_ms,p.title,p.description,p.categories_key FROM guide_program p WHERE p.guide_source_id=?1 AND p.channel_id=?2 AND {predicate} AND ?4>?3 ORDER BY p.start_ms,p.stop_ms,p.title,p.description,p.categories_key LIMIT 2");
    let mut statement = sql(c.prepare(&query))?;
    let rows = sql(statement.query_map(
        params![
            mapping.guide_source_id,
            mapping.xmltv_channel_id,
            at,
            at.saturating_add(WEEK)
        ],
        |r| {
            let category_key = r.get_ref(4)?.as_str()?;
            if category_key.len() > 65536 {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let pairs: Vec<(String, Option<String>)> =
                serde_json::from_str(category_key).map_err(|_| rusqlite::Error::InvalidQuery)?;
            if pairs.len() > 32 {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let categories = pairs
                .into_iter()
                .map(|(text, language)| crate::guide::category::GuideCategory { text, language })
                .collect::<Vec<_>>();
            if crate::guide::category::semantic_key(&categories)
                .map_err(|_| rusqlite::Error::InvalidQuery)?
                != category_key
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let title = match r.get_ref(2)? {
                rusqlite::types::ValueRef::Text(v) if v.len() <= 16_384 => std::str::from_utf8(v)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?
                    .to_owned(),
                _ => return Err(rusqlite::Error::InvalidQuery),
            };
            Ok(SummaryProgram {
                start_ms: r.get(0)?,
                stop_ms: r.get(1)?,
                title,
            })
        },
    ))?;
    sql(rows.collect())
}
fn read_snapshot(
    c: &Connection,
    q: &SummaryQuery,
    cancel: &CancelCheck,
) -> Result<SelectedSummary, String> {
    let tx = sql(c.unchecked_transaction())?;
    let cr: i64 = sql(tx.query_row(
        "SELECT catalog_revision FROM metadata WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    let dr = database_revision(&tx)?;
    let out = read_row(&tx, q, cr, dr, &mut SourceCache::new(), cancel)?;
    sql(tx.commit())?;
    Ok(out)
}
fn read_row(
    tx: &Connection,
    q: &SummaryQuery,
    cr: i64,
    dr: i64,
    cache: &mut SourceCache,
    cancel: &CancelCheck,
) -> Result<SelectedSummary, String> {
    let mut out = SelectedSummary {
        request_id: q.request_id.clone(),
        catalog_source_id: q.catalog_source_id.clone(),
        app_channel_id: q.app_channel_id.clone(),
        at_ms: q.at_ms,
        catalog_revision: cr.to_string(),
        database_revision: dr,
        mapping_status: "channel-unavailable",
        mapping: None,
        source_revision: None,
        published_revision: None,
        updated_ms: None,
        coverage: SummaryCoverage {
            start_ms: None,
            end_ms: None,
        },
        cache_status: "unavailable",
        current_status: None,
        next_status: None,
        current: None,
        next: None,
    };
    let available:bool=sql(tx.query_row("SELECT EXISTS(SELECT 1 FROM channel c JOIN source s ON s.id=c.source_id WHERE c.id=?1 AND c.source_id=?2 AND NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=c.id))",params![q.app_channel_id,q.catalog_source_id],|r|r.get(0)))?;
    if !available {
        return Ok(out);
    }
    check(cancel)?;
    out.mapping_status = "unmapped";
    let mapping=sql(tx.query_row("SELECT catalog_source_id,app_channel_id,guide_source_id,xmltv_channel_id FROM guide_mapping WHERE catalog_source_id=?1 AND app_channel_id=?2",params![q.catalog_source_id,q.app_channel_id],|r|Ok(GuideMapping{catalog_source_id:r.get(0)?,app_channel_id:r.get(1)?,guide_source_id:r.get(2)?,xmltv_channel_id:r.get(3)?})).optional())?;
    let Some(mapping) = mapping else {
        return Ok(out);
    };
    out.mapping_status = "source-unavailable";
    if !cache.contains_key(&mapping.guide_source_id) {
        let source = sql(tx
            .query_row(
                "SELECT revision,published_revision,updated_ms FROM guide_source WHERE id=?1",
                [&mapping.guide_source_id],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<i64>>(1)?,
                        r.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .optional())?;
        let metadata = if let Some((revision, published, updated)) = source {
            let bounds = sql(tx.query_row(
                "SELECT min(start_ms),max(stop_ms) FROM guide_program WHERE guide_source_id=?1",
                [&mapping.guide_source_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ))?;
            Some(SourceMetadata {
                revision,
                published,
                updated,
                bounds,
            })
        } else {
            None
        };
        cache.insert(mapping.guide_source_id.clone(), metadata);
    }
    let source = cache.get(&mapping.guide_source_id).cloned().flatten();
    out.mapping = Some(mapping);
    let Some(source) = source else {
        return Ok(out);
    };
    let (sr, pr, updated) = (source.revision, source.published, source.updated);
    out.mapping_status = "mapped";
    out.source_revision = Some(sr);
    out.published_revision = pr;
    out.updated_ms = updated;
    out.cache_status = if pr == Some(sr) && updated.is_some() {
        "current"
    } else if pr.is_some() {
        "stale"
    } else {
        "unavailable"
    };
    let m = out.mapping.as_ref().unwrap();
    out.coverage = SummaryCoverage {
        start_ms: source.bounds.0,
        end_ms: source.bounds.1,
    };
    check(cancel)?;
    let mut current = candidates(tx, m, q.at_ms, false)?;
    out.current_status = Some(if current.len() > 1 {
        "overlap"
    } else if current.first().is_some_and(|p| p.stop_ms.is_none()) {
        "unknown-end"
    } else if !current.is_empty() {
        "current"
    } else {
        let any: bool = sql(tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM guide_program WHERE guide_source_id=?1 AND channel_id=?2)",
            params![m.guide_source_id, m.xmltv_channel_id],
            |r| r.get(0),
        ))?;
        if any {
            "gap"
        } else {
            "empty"
        }
    });
    if out.current_status == Some("current") {
        out.current = current.pop();
    }
    check(cancel)?;
    let mut next = candidates(tx, m, q.at_ms, true)?;
    out.next_status = Some(if next.len() > 1 {
        "overlap"
    } else if next.is_empty() {
        "none"
    } else {
        "next"
    });
    if out.next_status == Some("next") {
        out.next = next.pop();
    }
    check(cancel)?;
    Ok(out)
}
#[cfg(test)]
#[path = "selected_summary_tests.rs"]
mod tests;
