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

//! Guide sources: listing, checking, saving and removing them, and checking
//! a guide feed.

use super::*;

pub(super) fn source_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GuideSource> {
    Ok(GuideSource {
        id: row.get(0)?,
        name: row.get(1)?,
        location: row.get(2)?,
        kind: row.get(3)?,
        allow_http: row.get(4)?,
        revision: row.get(5)?,
        updated_ms: row.get(6)?,
    })
}

pub fn list_sources(c: &Connection) -> Result<Vec<GuideSource>, String> {
    let mut statement = sql(c.prepare(
        "SELECT id,name,location,kind,allow_http,revision,updated_ms FROM guide_source ORDER BY id",
    ))?;
    let rows = sql(statement.query_map([], source_row))?;
    sql(rows.collect())
}

pub fn source_revision(c: &Connection, id: &str) -> Result<i64, String> {
    valid_text(id, 256, true)?;
    sql(c
        .query_row("SELECT revision FROM guide_source WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional())?
    .ok_or_else(|| "guide-source-missing".into())
}

pub(super) fn database_revision(c: &Connection) -> Result<i64, String> {
    sql(c.query_row(
        "SELECT revision FROM guide_meta WHERE singleton=1",
        [],
        |r| r.get(0),
    ))
}

pub(crate) fn advance(c: &Connection) -> Result<(), String> {
    sql(c.execute(
        "UPDATE guide_meta SET revision=revision+1 WHERE singleton=1",
        [],
    ))?;
    Ok(())
}

/// Saving user configuration invalidates previews/cursors. Changed destinations clear only that source's schedules, retaining mappings.
pub(crate) fn validate_source(source: &GuideSource, expected_revision: i64) -> Result<(), String> {
    valid_text(&source.id, 256, true)?;
    valid_text(&source.name, 512, true)?;
    valid_text(&source.location, 16_384, true)?;
    if expected_revision < 0
        || expected_revision == i64::MAX
        || source.revision != expected_revision
        || source.updated_ms.is_some()
    {
        return Err("guide-invalid-source-revision".into());
    }
    if source.kind == "url" {
        let url = reqwest::Url::parse(&source.location).map_err(|_| "guide-invalid-url")?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.host_str().is_none()
            || !(url.scheme() == "https" || source.allow_http && url.scheme() == "http")
        {
            return Err("guide-invalid-url".into());
        }
    } else if source.kind != "file" {
        return Err("guide-invalid-source-kind".into());
    }
    Ok(())
}

pub fn save_source(
    c: &mut Connection,
    source: &GuideSource,
    expected_revision: i64,
) -> Result<GuideSource, String> {
    save_source_checked(c, source, expected_revision, &mut || Ok(()))
}

pub(super) fn previous_source_save(
    c: &Connection,
    source: &GuideSource,
    expected_revision: i64,
) -> Result<Option<GuideSource>, String> {
    validate_source(source, expected_revision)?;
    let previous = sql(c
        .query_row(
            "SELECT id,name,location,kind,allow_http,revision,updated_ms FROM guide_source WHERE id=?1",
            [&source.id],
            source_row,
        )
        .optional())?;
    if previous.as_ref().map_or(0, |s| s.revision) != expected_revision {
        return Err("guide-stale-revision".into());
    }
    if previous.is_none()
        && sql(c.query_row("SELECT count(*) FROM guide_source", [], |r| {
            r.get::<_, i64>(0)
        }))? >= 1000
    {
        return Err("guide-source-limit".into());
    }
    Ok(previous)
}

pub(super) fn same_source_configuration(a: &GuideSource, b: &GuideSource) -> bool {
    a.id == b.id
        && a.name == b.name
        && a.location == b.location
        && a.kind == b.kind
        && a.allow_http == b.allow_http
}

/// A read snapshot proves only identical configuration at the requested revision.
/// A changed save repeats every admission check after the actual checked backup.
pub(crate) fn preflight_save_source(
    c: &Connection,
    source: &GuideSource,
    expected_revision: i64,
) -> Result<Option<GuideSource>, String> {
    let tx = sql(c.unchecked_transaction())?;
    let previous = previous_source_save(&tx, source, expected_revision)?;
    let unchanged = previous.filter(|old| same_source_configuration(old, source));
    sql(tx.commit())?;
    Ok(unchanged)
}

pub(crate) fn save_source_checked(
    c: &mut Connection,
    source: &GuideSource,
    expected_revision: i64,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<GuideSource, String> {
    validate_source(source, expected_revision)?;
    check()?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let previous = previous_source_save(&tx, source, expected_revision)?;
    if let Some(old) = previous
        .as_ref()
        .filter(|old| same_source_configuration(old, source))
    {
        let receipt = old.clone();
        check()?;
        sql(tx.commit())?;
        return Ok(receipt);
    }
    let updated = previous.as_ref().and_then(|s| s.updated_ms);
    sql(tx.execute("INSERT INTO guide_source(id,name,location,kind,allow_http,revision,updated_ms) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET name=excluded.name,location=excluded.location,kind=excluded.kind,allow_http=excluded.allow_http,revision=excluded.revision,updated_ms=excluded.updated_ms",params![source.id,source.name,source.location,source.kind,source.allow_http,expected_revision+1,updated]))?;
    advance(&tx)?;
    check()?;
    sql(tx.commit())?;
    Ok(GuideSource {
        revision: expected_revision + 1,
        updated_ms: updated,
        ..source.clone()
    })
}

pub fn remove_source(c: &mut Connection, id: &str, expected_revision: i64) -> Result<(), String> {
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    if source_revision(&tx, id)? != expected_revision {
        return Err("guide-stale-revision".into());
    }
    sql(tx.execute("DELETE FROM guide_source WHERE id=?1", [id]))?;
    advance(&tx)?;
    sql(tx.commit())
}

pub(crate) fn validate_feed(feed: &ParsedGuide, flag: &AtomicBool) -> Result<(), String> {
    if feed.channels.len() > 100_000 || feed.programs.len() > 500_000 {
        return Err("guide-record-limit".into());
    }
    let mut ids = HashSet::new();
    let mut bytes = 0usize;
    for ch in &feed.channels {
        cancel(flag)?;
        valid_text(&ch.id, 16_384, true)?;
        if ch.names.is_empty() || ch.names.len() > 32 || !ids.insert(ch.id.as_str()) {
            return Err("guide-invalid-channel".into());
        }
        bytes = bytes.saturating_add(ch.id.len());
        for name in &ch.names {
            valid_text(name, 512, true)?;
            bytes = bytes.saturating_add(name.len());
        }
    }
    for p in &feed.programs {
        cancel(flag)?;
        valid_text(&p.title, 16_384, true)?;
        valid_time(p.start_ms)?;
        if !ids.contains(p.channel_id.as_str()) {
            return Err("guide-unknown-channel".into());
        }
        if let Some(stop) = p.stop_ms {
            valid_time(stop)?;
            if stop <= p.start_ms {
                return Err("guide-invalid-end".into());
            }
        }
        if let Some(desc) = &p.description {
            valid_text(desc, 65_536, false)?;
        }
        let categories = super::super::category::canonicalize(p.categories.clone())?;
        let category_bytes = serde_json::to_vec(&categories)
            .map_err(|_| "guide-invalid-category")?
            .len();
        let category_key = super::super::category::semantic_key(&categories)?;
        if category_bytes > 32768 || category_key.len() > 65536 {
            return Err("guide-category-byte-limit".into());
        }
        bytes = bytes.saturating_add(category_bytes + category_key.len());
        bytes = bytes.saturating_add(
            p.title.len()
                + p.channel_id.len()
                + p.description.as_ref().map_or(0, String::len)
                + p.categories
                    .iter()
                    .map(|v| v.text.len() + v.language.as_ref().map_or(0, String::len))
                    .sum::<usize>()
                + 32,
        );
    }
    if bytes > 64 * 1024 * 1024 {
        return Err("guide-record-byte-limit".into());
    }
    Ok(())
}
