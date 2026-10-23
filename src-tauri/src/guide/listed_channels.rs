//! Complete, paged membership of saved channels with drawable listings. No mutation/network.
use super::database::{sql, valid_text, valid_time};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use unicode_normalization::UnicodeNormalization;

/// Channels per page. Every page re-runs the endpoint grouping over the whole
/// catalog (about 2.4 s on the Sansui TV with ~9,000 channels), so pages are
/// large: 128 per page made a 1,471-channel guide take 12 passes and 34 s
/// (October 19, 2026). MAX_BYTES still trims a page that would be too big.
pub(crate) const PAGE: usize = 1024;
const MAX_TOTAL: usize = 100_000;
const MAX_BYTES: usize = 512 * 1024;
const SEARCH_BYTES: usize = 256;
const SEARCH_TOKENS: usize = 8;
/// Punctuation that also starts a word, besides spaces.
const WORD_BREAKS: [&str; 8] = ["(", "[", "-", "/", ":", "\"", "#", "."];
pub(crate) type Cancel = Arc<dyn Fn() -> bool + Send + Sync>;
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Query {
    pub start_ms: i64,
    pub end_ms: i64,
    pub cursor: Option<String>,
    /// Keep channels whose name, or a program title, description or category
    /// within the window, contains every word.
    #[serde(default)]
    pub search: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Cursor {
    version: u8,
    start_ms: i64,
    end_ms: i64,
    pub root_generation: u64,
    catalog_revision: String,
    mutation_revision: i64,
    database_revision: i64,
    view_revision: i64,
    grouping_policy: String,
    catalog_source_id: String,
    app_channel_id: String,
    seen: usize,
    #[serde(default)]
    search: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Channel {
    pub catalog_source_id: String,
    pub app_channel_id: String,
    pub guide_source_id: String,
    pub xmltv_channel_id: String,
    pub source_revision: i64,
    pub filter_mask: u8,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    pub start_ms: i64,
    pub end_ms: i64,
    pub root_generation: u64,
    pub catalog_revision: String,
    pub database_revision: i64,
    pub view_revision: String,
    pub grouping_policy: String,
    pub channels: Vec<Channel>,
    pub next_cursor: Option<String>,
}
/// Words folded like stored search text (NFKC, lowercase, whitespace split).
pub(crate) fn search_tokens(q: &Query) -> Result<Vec<String>, String> {
    let Some(raw) = q.search.as_deref() else {
        return Ok(Vec::new());
    };
    if raw.len() > SEARCH_BYTES || raw.chars().any(char::is_control) {
        return Err("guide-listed-invalid-search".into());
    }
    let folded = raw.nfkc().collect::<String>().to_lowercase();
    let tokens: Vec<String> = folded
        .split(|c: char| c.is_whitespace() || c == '\u{feff}')
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect();
    if tokens.len() > SEARCH_TOKENS {
        return Err("guide-listed-invalid-search".into());
    }
    Ok(tokens)
}
pub(crate) fn cursor(q: &Query) -> Result<Option<Cursor>, String> {
    valid_time(q.start_ms)?;
    valid_time(q.end_ms)?;
    if q.end_ms <= q.start_ms || q.end_ms - q.start_ms > 7 * 86_400_000 {
        return Err("guide-listed-invalid-window".into());
    }
    q.cursor
        .as_ref()
        .map(|raw| {
            if raw.len() > 128 * 1024 {
                return Err("guide-listed-invalid-cursor".into());
            }
            let v: Cursor = serde_json::from_str(raw).map_err(|_| "guide-listed-invalid-cursor")?;
            valid_text(&v.catalog_source_id, 16_384, true)?;
            valid_text(&v.app_channel_id, 16_384, true)?;
            if v.version != 2
                || v.search != search_tokens(q)?.join(" ")
                || v.start_ms != q.start_ms
                || v.end_ms != q.end_ms
                || v.seen == 0
                || v.seen >= MAX_TOTAL
                || v.database_revision < 0
                || v.mutation_revision < 0
                || v.view_revision < 0
                || v.grouping_policy != crate::catalog_endpoint_projection::POLICY
                || v.catalog_revision.parse::<u64>().is_err()
            {
                return Err("guide-listed-invalid-cursor".into());
            }
            Ok(v)
        })
        .transpose()
}
struct Progress<'a>(&'a Connection);
impl Drop for Progress<'_> {
    fn drop(&mut self) {
        let _ = self.0.progress_handler(0, None::<fn() -> bool>);
    }
}
pub(crate) fn query(
    c: &Connection,
    q: &Query,
    generation: u64,
    cancel: Cancel,
) -> Result<Page, String> {
    let after = cursor(q)?;
    let tokens = search_tokens(q)?;
    let check = || {
        if cancel() {
            Err("guide-cancelled".to_string())
        } else {
            Ok(())
        }
    };
    check()?;
    let during = cancel.clone();
    sql(c.progress_handler(1000, Some(move || during())))?;
    let _progress = Progress(c);
    let result = (|| {
        let tx = sql(c.unchecked_transaction())?;
        let (catalog, mutation, database): (i64,i64,i64) = sql(tx.query_row("SELECT m.catalog_revision,m.revision,g.revision FROM metadata m,guide_meta g WHERE m.singleton=1 AND g.singleton=1", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))))?;
        if catalog < 0 || mutation < 0 || database < 0 {
            return Err("guide-invalid-stored-revision".into());
        }
        // Use the same derived authority and exact group partition as Live TV.
        // Never silently fall back to raw aliases if either projection is stale.
        if !crate::catalog_endpoint_projection::present(&tx)?
            || !crate::catalog_query::projection_is_current(&tx)?
        {
            return Err("guide-listed-projection-stale".into());
        }
        let (view,complete): (i64,bool) = sql(tx.query_row("SELECT view_revision,(SELECT count(*) FROM channel)=(SELECT count(*) FROM catalog_endpoint_projection_v1) AND (SELECT count(*) FROM channel)=(SELECT count(*) FROM catalog_projection) FROM catalog_projection_meta WHERE singleton=1", [], |r| Ok((r.get(0)?,r.get(1)?))))?;
        if view < 0 || !complete {
            return Err("guide-listed-projection-stale".into());
        }
        let catalog_revision = catalog.to_string();
        if after.as_ref().is_some_and(|v| {
            v.root_generation != generation
                || v.catalog_revision != catalog_revision
                || v.mutation_revision != mutation
                || v.database_revision != database
                || v.view_revision != view
        }) {
            return Err("guide-listed-stale-cursor".into());
        }
        // Fixed filter facts cover every member of the same Live group. In
        // particular, a source's Sports alias must not disappear merely because
        // its chosen representative has a different source-supplied category.
        let statement = format!("{}, filter_facts AS MATERIALIZED(SELECT em.endpoint_key,em.preferred,em.custom_category,em.guide_source,em.guide_channel,MAX(instr(p.category_key,'news')>0) AS news,MAX(instr(p.category_key,'sports')>0) AS sports FROM endpoint_members em JOIN catalog_projection p ON p.channel_id=em.channel_id GROUP BY em.endpoint_key,em.preferred,em.custom_category,em.guide_source,em.guide_channel) SELECT m.catalog_source_id,m.app_channel_id,m.guide_source_id,m.xmltv_channel_id,s.revision,em.preferred+2*am.news+4*am.sports FROM guide_mapping m JOIN channel c ON c.source_id=m.catalog_source_id AND c.id=m.app_channel_id JOIN endpoint_members em ON em.channel_id=c.id AND em.position=1 JOIN filter_facts am ON {} JOIN source cs ON cs.id=c.source_id JOIN guide_source s ON s.id=m.guide_source_id JOIN guide_channel h ON h.guide_source_id=m.guide_source_id AND h.id=m.xmltv_channel_id WHERE s.published_revision IS NOT NULL AND s.published_revision<=s.revision AND (?3=0 OR (m.catalog_source_id,m.app_channel_id)>(?4,?5)) AND EXISTS(SELECT 1 FROM guide_program p INDEXED BY guide_program_channel_time WHERE p.guide_source_id=m.guide_source_id AND p.channel_id=m.xmltv_channel_id AND p.start_ms<?2 AND ((p.stop_ms IS NOT NULL AND p.stop_ms>?1) OR (p.stop_ms IS NULL AND p.start_ms>=?1))){} ORDER BY m.catalog_source_id,m.app_channel_id LIMIT {}",crate::catalog_endpoint_projection::MEMBERS_CTE.trim_end(),crate::catalog_endpoint_projection::SAME_GROUP,search_clause(tokens.len()),PAGE + 1);
        let mut values: Vec<rusqlite::types::Value> = vec![
            q.start_ms.into(),
            q.end_ms.into(),
            after.is_some().into(),
            after
                .as_ref()
                .map_or("", |v| v.catalog_source_id.as_str())
                .to_owned()
                .into(),
            after
                .as_ref()
                .map_or("", |v| v.app_channel_id.as_str())
                .to_owned()
                .into(),
        ];
        values.extend(tokens.iter().map(|t| t.clone().into()));
        let mut stmt = sql(tx.prepare(&statement))?;
        let mut rows = sql(stmt.query(rusqlite::params_from_iter(values)))?;
        let mut channels = Vec::new();
        while let Some(row) = sql(rows.next())? {
            check()?;
            let item = Channel {
                catalog_source_id: sql(row.get(0))?,
                app_channel_id: sql(row.get(1))?,
                guide_source_id: sql(row.get(2))?,
                xmltv_channel_id: sql(row.get(3))?,
                source_revision: sql(row.get(4))?,
                filter_mask: sql(row.get(5))?,
            };
            for (s, limit) in [
                (&item.catalog_source_id, 16_384),
                (&item.app_channel_id, 16_384),
                (&item.guide_source_id, 256),
                (&item.xmltv_channel_id, 16_384),
            ] {
                valid_text(s, limit, true)?;
            }
            if item.source_revision < 1 || item.filter_mask > 7 {
                return Err("guide-invalid-stored-revision".into());
            }
            channels.push(item);
        }
        drop(rows);
        drop(stmt);
        let mut more = channels.len() > PAGE;
        channels.truncate(PAGE);
        let seen = after.as_ref().map_or(0, |v| v.seen);
        let mut page = Page {
            start_ms: q.start_ms,
            end_ms: q.end_ms,
            root_generation: generation,
            catalog_revision,
            database_revision: database,
            view_revision: view.to_string(),
            grouping_policy: crate::catalog_endpoint_projection::POLICY.into(),
            channels,
            next_cursor: None,
        };
        loop {
            if seen + page.channels.len() > MAX_TOTAL
                || (seen + page.channels.len() == MAX_TOTAL && more)
            {
                return Err("guide-listed-capacity".into());
            }
            page.next_cursor = if more {
                page.channels
                    .last()
                    .map(|v| {
                        serde_json::to_string(&Cursor {
                            version: 2,
                            start_ms: q.start_ms,
                            end_ms: q.end_ms,
                            root_generation: generation,
                            catalog_revision: page.catalog_revision.clone(),
                            mutation_revision: mutation,
                            database_revision: database,
                            view_revision: view,
                            grouping_policy: crate::catalog_endpoint_projection::POLICY.into(),
                            catalog_source_id: v.catalog_source_id.clone(),
                            app_channel_id: v.app_channel_id.clone(),
                            seen: seen + page.channels.len(),
                            search: tokens.join(" "),
                        })
                    })
                    .transpose()
                    .map_err(|_| "guide-listed-invalid-cursor")?
            } else {
                None
            };
            if serde_json::to_vec(&page)
                .map_err(|_| "guide-listed-capacity")?
                .len()
                <= MAX_BYTES
            {
                break;
            }
            page.channels.pop();
            more = true;
            if page.channels.is_empty() {
                return Err("guide-listed-capacity".into());
            }
        }
        check()?;
        sql(tx.commit())?;
        Ok(page)
    })();
    check()?;
    result
}

/// Every word in the channel's own search text, or in one listed program within the window.
fn search_clause(tokens: usize) -> String {
    if tokens == 0 {
        return String::new();
    }
    // Each word must start a word in the text ("nfl" finds "NFL Live", not
    // "conflict"). The plain instr() check first keeps most rows cheap.
    let all = |column: &str| {
        let words = WORD_BREAKS.iter().fold(column.to_owned(), |text, c| {
            format!("replace({text},'{c}',' ')")
        });
        (6..6 + tokens)
            .map(|i| format!("(instr({column},?{i})>0 AND instr(' '||{words},' '||?{i})>0)"))
            .collect::<Vec<_>>()
            .join(" AND ")
    };
    format!(
        " AND ((SELECT {} FROM catalog_projection sp WHERE sp.channel_id=c.id) OR EXISTS(SELECT 1 FROM guide_program sq INDEXED BY guide_program_channel_time WHERE sq.guide_source_id=m.guide_source_id AND sq.channel_id=m.xmltv_channel_id AND sq.start_ms<?2 AND ((sq.stop_ms IS NOT NULL AND sq.stop_ms>?1) OR (sq.stop_ms IS NULL AND sq.start_ms>=?1)) AND {}))",
        all("sp.search_text"),
        all("sq.search_text")
    )
}

#[cfg(test)]
#[path = "listed_channels_tests.rs"]
mod tests;
