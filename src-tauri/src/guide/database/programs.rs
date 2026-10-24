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

//! Reading programs and channels from the saved guide.

use super::*;

pub(super) fn column_text(
    r: &rusqlite::Row<'_>,
    index: usize,
    max: usize,
) -> rusqlite::Result<String> {
    let value = r.get_ref(index)?.as_str()?;
    if valid_text(value, max, true).is_err() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(value.to_owned())
}

pub(super) fn mapped_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MappedProgram> {
    Ok(MappedProgram {
        catalog_source_id: column_text(r, 0, 256)?,
        app_channel_id: column_text(r, 1, 16_384)?,
        guide_source_id: column_text(r, 2, 256)?,
        xmltv_channel_id: column_text(r, 3, 16_384)?,
        start_ms: r.get(4)?,
        stop_ms: r.get(5)?,
        title: column_text(r, 6, 16_384)?,
        description: if matches!(r.get_ref(7)?, rusqlite::types::ValueRef::Null) {
            None
        } else {
            let text = r.get_ref(7)?.as_str()?;
            if valid_text(text, 65_536, false).is_err() {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Some(text.to_owned())
        },
        ordinal: r.get(8)?,
        categories: {
            let raw = r.get_ref(9)?.as_str()?;
            if raw.len() > 32768 {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let categories: Vec<super::super::category::GuideCategory> =
                serde_json::from_str(raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let categories = super::super::category::canonicalize(categories)
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
            let expected = r.get_ref(10)?.as_str()?;
            if expected.len() > 65536
                || super::super::category::semantic_key(&categories)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?
                    != expected
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            categories
        },
    })
}

pub fn query_programs(c: &Connection, q: &ProgramQuery) -> Result<ProgramPage, String> {
    valid_text(&q.guide_source_id, 256, false)?;
    valid_text(&q.search, 512, false)?;
    valid_time(q.window_start_ms)?;
    valid_time(q.window_end_ms)?;
    if q.window_end_ms <= q.window_start_ms
        || q.window_end_ms - q.window_start_ms > WEEK
        || q.page_size == 0
        || q.page_size > 100
        || q.app_channel_ids.len() > 100
    {
        return Err("guide-invalid-query-bounds".into());
    }
    if let Some(context) = q.context_at_ms {
        valid_time(context)?;
        if q.guide_source_id.is_empty()
            || q.app_channel_ids.len() != 1
            || !q.search.trim().is_empty()
            || context < q.window_start_ms
            || context >= q.window_end_ms
        {
            return Err("guide-invalid-context-scope".into());
        }
    }
    let mut unique = HashSet::new();
    for id in &q.app_channel_ids {
        valid_text(id, 16_384, true)?;
        if !unique.insert(id) {
            return Err("guide-duplicate-query-channel".into());
        }
    }
    let tx = sql(c.unchecked_transaction())?;
    let sr = if q.guide_source_id.is_empty() {
        0
    } else {
        source_revision(&tx, &q.guide_source_id)?
    };
    let dr = database_revision(&tx)?;
    let catalog_revision: i64 = sql(tx.query_row(
        "SELECT revision FROM metadata WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    let mut requested_ids = q.app_channel_ids.clone();
    requested_ids.sort();
    let search_tokens = tokens(&q.search);
    let query_key = key((
        &q.guide_source_id,
        &requested_ids,
        q.window_start_ms,
        q.window_end_ms,
        q.context_at_ms,
        &search_tokens,
        q.search.trim().is_empty(),
        catalog_revision,
    ))?;
    if let Some(cursor) = &q.cursor {
        valid_text(&cursor.app_channel_id, 16_384, true)?;
        valid_text(&cursor.guide_source_id, 256, true)?;
        valid_time(cursor.start_ms)?;
        if cursor.source_revision != sr
            || cursor.database_revision != dr
            || cursor.ordinal < 0
            || cursor.query_key != query_key
        {
            return Err("guide-stale-cursor".into());
        }
    }
    let mut values: Vec<rusqlite::types::Value> = vec![
        q.guide_source_id.clone().into(),
        q.window_start_ms.into(),
        q.window_end_ms.into(),
    ];
    // Only the latest started entry in this exact feed/channel can supply unknown-end
    // context. Future entries and search filters cannot change that historical boundary.
    let context_clause = if let Some(context) = q.context_at_ms {
        values.push(context.into());
        " OR (p.start_ms<=?4 AND p.start_ms=(SELECT max(ctx.start_ms) FROM guide_program ctx WHERE ctx.guide_source_id=p.guide_source_id AND ctx.channel_id=p.channel_id AND ctx.start_ms<=?4))".to_owned()
    } else {
        String::new()
    };
    let search_clause = if q.search.trim().is_empty() {
        String::new()
    } else if search_tokens.is_empty() {
        " AND 0".into()
    } else {
        search_tokens
            .iter()
            .map(|token| {
                values.push(token.clone().into());
                format!(" AND instr(p.search_text,?{})>0", values.len())
            })
            .collect::<String>()
    };
    let placeholders = q
        .app_channel_ids
        .iter()
        .map(|id| {
            values.push(id.clone().into());
            format!("?{}", values.len())
        })
        .collect::<Vec<_>>()
        .join(",");
    let channel_clause = if q.app_channel_ids.is_empty() {
        String::new()
    } else {
        format!(" AND m.app_channel_id IN({placeholders})")
    };
    let cursor_clause = if let Some(cursor) = &q.cursor {
        let index = values.len() + 1;
        values.extend([
            cursor.start_ms.into(),
            cursor.guide_source_id.clone().into(),
            cursor.ordinal.into(),
            cursor.app_channel_id.clone().into(),
        ]);
        format!(
            " AND (p.start_ms,p.guide_source_id,p.ordinal,m.app_channel_id)>(?{index},?{},?{},?{})",
            index + 1,
            index + 2,
            index + 3
        )
    } else {
        String::new()
    };
    let scope_clause = if q.guide_source_id.is_empty() {
        "(?1='')"
    } else {
        "p.guide_source_id=?1"
    };
    let statement=format!("SELECT m.catalog_source_id,m.app_channel_id,p.guide_source_id,p.channel_id,p.start_ms,p.stop_ms,p.title,p.description,p.ordinal,p.categories_json,p.categories_key FROM guide_program p JOIN guide_mapping m ON m.guide_source_id=p.guide_source_id AND m.xmltv_channel_id=p.channel_id JOIN channel c ON c.id=m.app_channel_id AND c.source_id=m.catalog_source_id WHERE {scope_clause} AND p.start_ms<?3 AND ((p.stop_ms IS NOT NULL AND p.stop_ms>?2) OR (p.stop_ms IS NULL AND (p.start_ms>=?2{context_clause}))){search_clause}{channel_clause} AND NOT EXISTS(SELECT 1 FROM removed r WHERE r.id=m.app_channel_id){cursor_clause} ORDER BY p.start_ms,p.guide_source_id,p.ordinal,m.app_channel_id LIMIT {}",q.page_size+1);
    let mut s = sql(tx.prepare(&statement))?;
    let mut programs: Vec<MappedProgram> =
        sql(sql(s.query_map(rusqlite::params_from_iter(values), mapped_row))?.collect())?;
    drop(s);
    let page_bytes: usize = programs
        .iter()
        .map(|p| {
            p.catalog_source_id.len()
                + p.app_channel_id.len()
                + p.guide_source_id.len()
                + p.xmltv_channel_id.len()
                + p.title.len()
                + p.description.as_ref().map_or(0, String::len)
                + p.categories
                    .iter()
                    .map(|v| v.text.len() + v.language.as_ref().map_or(0, String::len))
                    .sum::<usize>()
        })
        .sum();
    if page_bytes > 8 * 1024 * 1024 {
        return Err("guide-page-byte-limit-choose-smaller-page".into());
    }
    let has_more = programs.len() > q.page_size;
    programs.truncate(q.page_size);
    let next_cursor = if has_more {
        programs.last().map(|p| GuideCursor {
            guide_source_id: p.guide_source_id.clone(),
            query_key: query_key.clone(),
            source_revision: sr,
            database_revision: dr,
            start_ms: p.start_ms,
            ordinal: p.ordinal,
            app_channel_id: p.app_channel_id.clone(),
        })
    } else {
        None
    };
    sql(tx.commit())?;
    Ok(ProgramPage {
        programs,
        next_cursor,
        source_revision: sr,
        database_revision: dr,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideChannelPage {
    pub channels: Vec<super::super::parser::GuideChannel>,
    pub next_cursor: Option<GuideChannelCursor>,
    pub source_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuideChannelCursor {
    pub source_revision: i64,
    pub query_key: String,
    pub last_id: String,
}

pub fn list_channels(
    c: &Connection,
    source_id: &str,
    search: &str,
    cursor: Option<&GuideChannelCursor>,
    page_size: usize,
) -> Result<GuideChannelPage, String> {
    valid_text(source_id, 256, true)?;
    valid_text(search, 512, false)?;
    if let Some(cursor) = cursor {
        valid_text(&cursor.last_id, 16_384, true)?;
    }
    if page_size == 0 || page_size > 100 {
        return Err("guide-invalid-page-size".into());
    }
    let tx = sql(c.unchecked_transaction())?;
    let revision = source_revision(&tx, source_id)?;
    let search_tokens = tokens(search);
    let query_key = key((source_id, &search_tokens, search.trim().is_empty()))?;
    if cursor.is_some_and(|v| v.source_revision != revision || v.query_key != query_key) {
        return Err("guide-stale-cursor".into());
    }
    let mut values: Vec<rusqlite::types::Value> = vec![
        source_id.to_owned().into(),
        cursor.map(|c| c.last_id.clone()).into(),
    ];
    let search_clause = if search.trim().is_empty() {
        String::new()
    } else if search_tokens.is_empty() {
        " AND 0".into()
    } else {
        search_tokens
            .iter()
            .map(|token| {
                values.push(token.clone().into());
                format!(" AND instr(search_names,?{})>0", values.len())
            })
            .collect::<String>()
    };
    let statement = format!(
        "SELECT id,names_json FROM guide_channel WHERE guide_source_id=?1 AND (?2 IS NULL OR id>?2){search_clause} ORDER BY id LIMIT {}",
        page_size + 1
    );
    let mut s = sql(tx.prepare(&statement))?;
    let raw: Vec<(String, String)> = sql(sql(s
        .query_map(rusqlite::params_from_iter(values), |r| {
            Ok((column_text(r, 0, 16_384)?, column_text(r, 1, 65_536)?))
        }))?
    .collect())?;
    drop(s);
    let more = raw.len() > page_size;
    let mut channels = Vec::new();
    for (id, names) in raw.into_iter().take(page_size) {
        let names: Vec<String> =
            serde_json::from_str(&names).map_err(|_| "guide-invalid-stored-channel")?;
        if names.is_empty() || names.len() > 32 {
            return Err("guide-invalid-stored-channel".into());
        }
        for name in &names {
            valid_text(name, 512, true)?;
        }
        channels.push(super::super::parser::GuideChannel { id, names });
    }
    let next_cursor = if more {
        channels.last().map(|c| GuideChannelCursor {
            source_revision: revision,
            query_key: query_key.clone(),
            last_id: c.id.clone(),
        })
    } else {
        None
    };
    sql(tx.commit())?;
    Ok(GuideChannelPage {
        channels,
        next_cursor,
        source_revision: revision,
    })
}
