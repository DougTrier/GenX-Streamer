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

//! Paid TV program guide: the provider's own XMLTV (Xtream `xmltv.php`, or the
//! playlist's `url-tvg`), matched to channels only by the provider's EPG ID
//! (XC-034). The download goes to a temporary file that is always deleted and
//! is read as a stream, so a large guide never sits in memory whole. Only
//! listings for this account's channels, inside a bounded window, are kept. A
//! failed or partial download never replaces the last good guide (XC-036).
use crate::guide::category::{self, GuideCategory};
use quick_xml::{events::Event, Reader, XmlVersion};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read};

/// Download cap (plain or compressed bytes as served).
pub(crate) const DOWNLOAD_LIMIT: usize = 256 * 1024 * 1024;
/// Expanded XML cap: a gzip bomb stops here (XC-035).
pub(crate) const EXPANDED_LIMIT: u64 = 768 * 1024 * 1024;
/// Stored listings per account.
pub(crate) const PROGRAM_LIMIT: usize = 600_000;
/// Kept window: from six hours ago to eight days ahead.
pub(crate) const KEEP_BEFORE_MS: i64 = 6 * 3_600_000;
pub(crate) const KEEP_AFTER_MS: i64 = 8 * 86_400_000;
/// Longest programme the window queries look back for.
const LONGEST_MS: i64 = 12 * 3_600_000;
const TEXT_LIMIT: usize = 65_536;

pub(crate) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS account_guide_v1(
 account_id TEXT PRIMARY KEY REFERENCES account_vault_meta_v1(id) ON DELETE CASCADE,
 account_revision INTEGER NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 fetched_ms INTEGER NOT NULL,programs INTEGER NOT NULL,channels INTEGER NOT NULL,skipped INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS account_guide_program_v1(
 account_id TEXT NOT NULL REFERENCES account_guide_v1(account_id) ON DELETE CASCADE,
 epg_id TEXT NOT NULL,start_ms INTEGER NOT NULL,stop_ms INTEGER,ordinal INTEGER NOT NULL,
 title TEXT NOT NULL,description TEXT,categories TEXT NOT NULL,
 PRIMARY KEY(account_id,epg_id,start_ms,ordinal)) WITHOUT ROWID;
 CREATE INDEX IF NOT EXISTS account_guide_program_time_v1 ON account_guide_program_v1(account_id,start_ms);";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Program {
    pub epg_id: String,
    pub start_ms: i64,
    pub stop_ms: Option<i64>,
    pub ordinal: i64,
    pub title: String,
    pub description: Option<String>,
    pub categories: Vec<GuideCategory>,
}
#[derive(Debug)]
pub(crate) struct Parsed {
    pub programs: Vec<Program>,
    /// Listings for this account's channels that could not be used (bad time,
    /// no title, oversized text). Counted and shown, never hidden.
    pub skipped: usize,
}

/// Counts expanded bytes; stops a decompression bomb or an endless body.
struct Limited<R> {
    inner: R,
    read: u64,
    limit: u64,
}
impl<R: Read> Read for Limited<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read += n as u64;
        if self.read > self.limit {
            return Err(std::io::Error::other("account-guide-too-large"));
        }
        Ok(n)
    }
}

/// Plain or gzip XML, decided by the bytes, never by a name or header (XC-035).
pub(crate) fn open_reader(
    mut file: impl Read + 'static,
    limit: u64,
) -> Result<Box<dyn BufRead>, String> {
    let mut head = [0u8; 2];
    let mut got = 0;
    while got < 2 {
        let n = file
            .read(&mut head[got..])
            .map_err(|_| "account-guide-read-failed")?;
        if n == 0 {
            break;
        }
        got += n;
    }
    if got == 0 {
        return Err("account-guide-empty".into());
    }
    let whole = std::io::Cursor::new(head[..got].to_vec()).chain(file);
    Ok(if got == 2 && head == [0x1f, 0x8b] {
        Box::new(BufReader::with_capacity(
            256 * 1024,
            Limited {
                inner: flate2::read::MultiGzDecoder::new(whole),
                read: 0,
                limit,
            },
        ))
    } else {
        Box::new(BufReader::with_capacity(
            256 * 1024,
            Limited {
                inner: whole,
                read: 0,
                limit,
            },
        ))
    })
}

fn xml_char(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r') || c >= '\u{20}' && c != '\u{fffe}' && c != '\u{ffff}'
}
fn malformed(error: impl std::fmt::Display) -> String {
    // A read failure from the limit reader keeps its own code.
    if error.to_string().contains("account-guide-too-large") {
        "account-guide-too-large".into()
    } else {
        "account-guide-malformed".into()
    }
}

#[derive(Default)]
struct Pending {
    epg_id: String,
    start_ms: i64,
    stop_ms: Option<i64>,
    title: String,
    description: Option<String>,
    categories: Vec<GuideCategory>,
    /// Kept only if wanted, in the window, and every field admitted.
    keep: bool,
    bad: bool,
}

/// Streaming XMLTV read. XML structure stays strict (malformed XML, a DTD
/// subset or entity declarations fail the whole read, so the last good guide
/// stays). Individual listings are tolerant: one unusable listing is counted
/// and left out. Listings for other channels or outside the window are ignored.
pub(crate) fn parse(
    input: impl BufRead,
    wanted: &HashSet<String>,
    from_ms: i64,
    to_ms: i64,
    limit: usize,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Parsed, String> {
    let mut reader = Reader::from_reader(input);
    reader.config_mut().check_end_names = true;
    let mut buf = Vec::new();
    let mut depth = 0usize;
    let mut root_seen = false;
    let mut root_closed = false;
    let mut doctype_seen = false;
    let mut program: Option<Pending> = None;
    let mut field: Option<(String, Option<String>)> = None;
    let mut captured = String::new();
    let mut programs = Vec::new();
    let mut skipped = 0usize;
    let mut events = 0u32;
    loop {
        events = events.wrapping_add(1);
        if events % 4096 == 0 {
            check()?;
        }
        buf.clear();
        let event = reader.read_event_into(&mut buf).map_err(malformed)?;
        match event {
            Event::Decl(decl) => {
                if root_seen || doctype_seen {
                    return Err("account-guide-malformed".into());
                }
                if decl.version().map_err(malformed)?.as_ref() != b"1.0" {
                    return Err("account-guide-malformed".into());
                }
                if let Some(declared) = decl.encoding() {
                    let declared = declared.map_err(malformed)?;
                    if !declared.eq_ignore_ascii_case(b"utf-8") {
                        return Err("account-guide-encoding-unsupported".into());
                    }
                }
            }
            Event::DocType(value) => {
                let value = value.decode().map_err(malformed)?;
                if root_seen
                    || doctype_seen
                    || value.contains('[')
                    || value.contains(']')
                    || value.split_whitespace().next().is_none_or(|v| v != "tv")
                {
                    return Err("account-guide-malformed".into());
                }
                doctype_seen = true;
            }
            event @ (Event::Start(_) | Event::Empty(_)) => {
                let empty = matches!(event, Event::Empty(_));
                let node = match event {
                    Event::Start(v) | Event::Empty(v) => v,
                    _ => unreachable!(),
                };
                let name = node.name();
                let name = std::str::from_utf8(name.as_ref()).map_err(malformed)?;
                if depth == 0 {
                    if root_seen || root_closed || name != "tv" {
                        return Err("account-guide-malformed".into());
                    }
                    root_seen = true;
                } else if depth == 1 && name == "programme" {
                    let mut pending = Pending::default();
                    let (mut channel, mut start, mut stop) = (None, None, None);
                    for attr in node.attributes() {
                        let attr = attr.map_err(malformed)?;
                        let key = attr.key.as_ref();
                        if !matches!(key, b"channel" | b"start" | b"stop") {
                            continue;
                        }
                        let value = attr
                            .normalized_value(XmlVersion::Explicit1_0)
                            .map_err(malformed)?
                            .into_owned();
                        match key {
                            b"channel" => channel = Some(value),
                            b"start" => start = Some(value),
                            _ => stop = Some(value),
                        }
                    }
                    let channel = channel.unwrap_or_default();
                    if wanted.contains(channel.trim()) {
                        pending.epg_id = channel.trim().to_owned();
                        match (
                            start.as_deref().map(crate::guide::parser::parse_timestamp),
                            stop.as_deref().map(crate::guide::parser::parse_timestamp),
                        ) {
                            (Some(Ok(start)), None) => {
                                pending.start_ms = start;
                                pending.keep = start >= from_ms && start < to_ms;
                            }
                            (Some(Ok(start)), Some(Ok(stop))) if stop > start => {
                                pending.start_ms = start;
                                pending.stop_ms = Some(stop);
                                pending.keep = stop > from_ms && start < to_ms;
                            }
                            _ => pending.bad = true,
                        }
                    }
                    program = Some(pending);
                } else if depth == 2
                    && program.as_ref().is_some_and(|p| p.keep && !p.bad)
                    && matches!(name, "title" | "desc" | "category")
                {
                    let language = if name == "category" {
                        node.attributes()
                            .flatten()
                            .find(|a| a.key.as_ref() == b"lang")
                            .and_then(|a| {
                                a.normalized_value(XmlVersion::Explicit1_0)
                                    .ok()
                                    .map(|v| v.into_owned())
                            })
                    } else {
                        None
                    };
                    captured.clear();
                    field = Some((name.to_owned(), language));
                } else if field.is_some() {
                    // Markup inside a text field: this listing only.
                    if let Some(p) = program.as_mut() {
                        p.bad = true;
                    }
                    field = None;
                }
                if empty {
                    if depth == 0 {
                        root_closed = true;
                    } else if depth == 1 {
                        if let Some(p) = program.take() {
                            settle(p, &mut programs, &mut skipped, limit)?;
                        }
                    }
                } else {
                    depth += 1;
                    if depth > 128 {
                        return Err("account-guide-malformed".into());
                    }
                }
            }
            Event::End(_) => {
                if depth == 0 {
                    return Err("account-guide-malformed".into());
                }
                depth -= 1;
                if depth == 2 {
                    if let (Some((name, language)), Some(p)) = (field.take(), program.as_mut()) {
                        let text = captured.trim().to_owned();
                        captured.clear();
                        match name.as_str() {
                            "title" if p.title.is_empty() => {
                                if text.is_empty() || text.len() > 16_384 {
                                    p.bad = true;
                                } else {
                                    p.title = text;
                                }
                            }
                            "desc" if p.description.is_none() && !text.is_empty() => {
                                p.description = Some(text)
                            }
                            "category" => {
                                if category::admit(&mut p.categories, text, language).is_err() {
                                    p.bad = true;
                                }
                            }
                            _ => {}
                        }
                    }
                } else if depth == 1 {
                    if let Some(p) = program.take() {
                        settle(p, &mut programs, &mut skipped, limit)?;
                    }
                } else if depth == 0 {
                    root_closed = true;
                }
            }
            Event::Text(value) => {
                let text = value.xml_content(XmlVersion::Explicit1_0).map_err(malformed)?;
                if field.is_some() {
                    push(&mut captured, &text, &mut program);
                } else if depth == 0 && !text.trim().is_empty() {
                    return Err("account-guide-malformed".into());
                }
            }
            Event::CData(value) => {
                let text = value.xml_content(XmlVersion::Explicit1_0).map_err(malformed)?;
                if field.is_some() {
                    push(&mut captured, &text, &mut program);
                }
            }
            Event::GeneralRef(value) => {
                let name = value.decode().map_err(malformed)?;
                let resolved = quick_xml::escape::unescape(&format!("&{name};"))
                    .map_err(|_| "account-guide-malformed")?
                    .into_owned();
                if field.is_some() {
                    push(&mut captured, &resolved, &mut program);
                }
            }
            Event::Eof => break,
            Event::Comment(_) | Event::PI(_) => {}
        }
    }
    if !root_seen || !root_closed || depth != 0 {
        return Err("account-guide-malformed".into());
    }
    check()?;
    // Providers repeat listings; identical repeats collapse, and listings at
    // the same start keep their file order as an ordinal.
    programs.sort_by(|a: &Program, b: &Program| {
        (&a.epg_id, a.start_ms, a.ordinal).cmp(&(&b.epg_id, b.start_ms, b.ordinal))
    });
    programs.dedup_by(|b, a| {
        a.epg_id == b.epg_id
            && a.start_ms == b.start_ms
            && a.stop_ms == b.stop_ms
            && a.title == b.title
            && a.description == b.description
    });
    let mut previous: Option<(String, i64)> = None;
    let mut ordinal = 0;
    for p in &mut programs {
        let key = (p.epg_id.clone(), p.start_ms);
        ordinal = if previous.as_ref() == Some(&key) {
            ordinal + 1
        } else {
            0
        };
        p.ordinal = ordinal;
        previous = Some(key);
    }
    Ok(Parsed { programs, skipped })
}
fn push(captured: &mut String, text: &str, program: &mut Option<Pending>) {
    if captured.len() + text.len() > TEXT_LIMIT || !text.chars().all(xml_char) {
        if let Some(p) = program.as_mut() {
            p.bad = true;
        }
        return;
    }
    captured.push_str(text);
}
fn settle(
    p: Pending,
    programs: &mut Vec<Program>,
    skipped: &mut usize,
    limit: usize,
) -> Result<(), String> {
    if p.epg_id.is_empty() {
        return Ok(()); // Another channel's listing.
    }
    if p.bad || (p.keep && p.title.is_empty()) {
        *skipped += 1;
        return Ok(());
    }
    if !p.keep {
        return Ok(()); // Outside the kept window.
    }
    let Ok(categories) = category::canonicalize(p.categories) else {
        *skipped += 1;
        return Ok(());
    };
    if programs.len() >= limit {
        return Err("account-guide-too-large".into());
    }
    // File order as a provisional ordinal; renumbered after sorting.
    let ordinal = programs.len() as i64;
    programs.push(Program {
        epg_id: p.epg_id,
        start_ms: p.start_ms,
        stop_ms: p.stop_ms,
        ordinal,
        title: p.title,
        description: p.description,
        categories,
    });
    Ok(())
}

fn sql<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|_| "account-guide-storage-failed".into())
}
pub(crate) fn install(c: &Connection) -> Result<(), String> {
    sql(c.execute_batch(SCHEMA))
}
/// The current account revision's channels with a provider EPG ID.
pub(crate) fn wanted(c: &Connection, account: &str) -> Result<HashSet<String>, String> {
    let live = crate::account_catalog_query::live_scope(c)?;
    let mut statement = sql(c.prepare(&format!(
        "SELECT DISTINCT e.epg_id{} AND e.epg_id IS NOT NULL AND e.epg_id<>''",
        live.from
    )))?;
    let rows = sql(statement.query_map(params![account], |r| r.get::<_, String>(0)))?;
    let mut out = HashSet::new();
    for row in rows {
        out.insert(sql(row)?);
    }
    Ok(out)
}
fn current_revision(c: &Connection, account: &str) -> Result<Option<i64>, String> {
    sql(c
        .query_row(
            "SELECT m.revision FROM account_vault_meta_v1 m JOIN account_vault_versions_v1 v ON v.id=m.id AND v.revision=m.revision AND v.active=1 WHERE m.id=?1",
            params![account],
            |r| r.get(0),
        )
        .optional())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub revision: i64,
    pub fetched_ms: i64,
    pub programs: i64,
    pub channels: i64,
    pub skipped: i64,
}
/// Replaces the account's guide in one transaction, only for the account
/// revision it was downloaded for. Nothing is written if that changed.
pub(crate) fn commit(
    c: &mut Connection,
    account: &str,
    account_revision: i64,
    parsed: &Parsed,
    fetched_ms: i64,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Status, String> {
    install(c)?;
    let tx = sql(c.transaction())?;
    if current_revision(&tx, account)? != Some(account_revision) {
        return Err("account-revision-conflict".into());
    }
    let previous: i64 = sql(tx
        .query_row(
            "SELECT revision FROM account_guide_v1 WHERE account_id=?1",
            params![account],
            |r| r.get(0),
        )
        .optional())?
    .unwrap_or(0);
    let channels = parsed
        .programs
        .iter()
        .map(|p| p.epg_id.as_str())
        .collect::<HashSet<_>>()
        .len() as i64;
    let status = Status {
        revision: previous + 1,
        fetched_ms,
        programs: parsed.programs.len() as i64,
        channels,
        skipped: parsed.skipped as i64,
    };
    sql(tx.execute(
        "INSERT INTO account_guide_v1(account_id,account_revision,revision,fetched_ms,programs,channels,skipped)
         VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(account_id) DO UPDATE SET account_revision=?2,revision=?3,
         fetched_ms=?4,programs=?5,channels=?6,skipped=?7",
        params![account, account_revision, status.revision, fetched_ms, status.programs, channels, status.skipped],
    ))?;
    sql(tx.execute(
        "DELETE FROM account_guide_program_v1 WHERE account_id=?1",
        params![account],
    ))?;
    {
        let mut insert = sql(tx.prepare(
            "INSERT INTO account_guide_program_v1(account_id,epg_id,start_ms,stop_ms,ordinal,title,description,categories)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        ))?;
        for (index, p) in parsed.programs.iter().enumerate() {
            if index % 4096 == 0 {
                check()?;
            }
            let categories =
                serde_json::to_string(&p.categories).map_err(|_| "account-guide-storage-failed")?;
            sql(insert.execute(params![
                account,
                p.epg_id,
                p.start_ms,
                p.stop_ms,
                p.ordinal,
                p.title,
                p.description,
                categories
            ]))?;
        }
    }
    check()?;
    sql(tx.commit())?;
    Ok(status)
}
fn present(c: &Connection) -> Result<bool, String> {
    sql(c.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='account_guide_program_v1'",
        [],
        |r| r.get::<_, i64>(0),
    ))
    .map(|n| n > 0)
}
/// The stored guide, only while it belongs to the account's current revision.
pub(crate) fn status(c: &Connection, account: &str) -> Result<Option<Status>, String> {
    if !present(c)? {
        return Ok(None);
    }
    sql(c
        .query_row(
            "SELECT g.revision,g.fetched_ms,g.programs,g.channels,g.skipped FROM account_guide_v1 g
             JOIN account_vault_meta_v1 m ON m.id=g.account_id AND m.revision=g.account_revision
             JOIN account_vault_versions_v1 v ON v.id=m.id AND v.revision=m.revision AND v.active=1
             WHERE g.account_id=?1",
            params![account],
            |r| {
                Ok(Status {
                    revision: r.get(0)?,
                    fetched_ms: r.get(1)?,
                    programs: r.get(2)?,
                    channels: r.get(3)?,
                    skipped: r.get(4)?,
                })
            },
        )
        .optional())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuideChannel {
    pub id: String,
    pub name: String,
    pub category: String,
    pub epg_id: String,
    pub provider_id: Option<String>,
    /// The channel list's opaque playback capability (never a provider URL).
    pub stream_reference: String,
    pub favorite: bool,
}
/// Channels (current revision, not removed) whose EPG ID has listings.
pub(crate) fn channels(c: &Connection, account: &str) -> Result<Vec<GuideChannel>, String> {
    if status(c, account)?.is_none() {
        return Ok(Vec::new());
    }
    let live = crate::account_catalog_query::live_scope(c)?;
    let mut statement = sql(c.prepare(&format!(
        "SELECT e.channel_id,e.name,{},e.epg_id,{},e.provider_id,e.stream_ref{} AND e.epg_id IS NOT NULL AND EXISTS(
           SELECT 1 FROM account_guide_program_v1 g WHERE g.account_id=e.account_id AND g.epg_id=e.epg_id)
         ORDER BY e.name COLLATE NOCASE,e.channel_id LIMIT 50000",
        live.category, live.favorite, live.from
    )))?;
    let rows = sql(statement.query_map(params![account], |r| {
        Ok(GuideChannel {
            id: r.get(0)?,
            name: r.get(1)?,
            category: r.get(2)?,
            epg_id: r.get(3)?,
            favorite: r.get::<_, i64>(4)? != 0,
            provider_id: r.get(5)?,
            stream_reference: r.get(6)?,
        })
    }))?;
    rows.map(sql).collect()
}
const OVERLAP: &str = "start_ms>=?2-43200000 AND start_ms<?3 AND (stop_ms>?2 OR (stop_ms IS NULL AND start_ms>=?2))";
/// EPG IDs with a listing in the window; with search, whose title or
/// description has every word.
pub(crate) fn listed(
    c: &Connection,
    account: &str,
    from_ms: i64,
    to_ms: i64,
    search: &str,
) -> Result<Vec<String>, String> {
    debug_assert_eq!(LONGEST_MS, 43_200_000);
    if status(c, account)?.is_none() {
        return Ok(Vec::new());
    }
    let words: Vec<String> = search
        .split_whitespace()
        .take(8)
        .map(|w| w.to_lowercase())
        .collect();
    if words.is_empty() {
        let mut statement = sql(c.prepare(&format!(
            "SELECT DISTINCT epg_id FROM account_guide_program_v1 WHERE account_id=?1 AND {OVERLAP}"
        )))?;
        let rows = sql(statement.query_map(params![account, from_ms, to_ms], |r| r.get(0)))?;
        return rows.map(sql).collect();
    }
    // The database narrows by letters; each word must then start a word of the
    // title or description ("nfl" is not "conflict"), as in the Free TV guide.
    let mut sql_text = format!(
        "SELECT epg_id,title,COALESCE(description,'') FROM account_guide_program_v1 WHERE account_id=?1 AND {OVERLAP}"
    );
    for i in 0..words.len() {
        sql_text.push_str(&format!(
            " AND instr(lower(title)||char(10)||lower(COALESCE(description,'')),?{})>0",
            i + 4
        ));
    }
    let mut statement = sql(c.prepare(&sql_text))?;
    let mut values: Vec<rusqlite::types::Value> = vec![
        account.to_owned().into(),
        from_ms.into(),
        to_ms.into(),
    ];
    values.extend(words.iter().cloned().map(Into::into));
    let rows = sql(statement.query_map(rusqlite::params_from_iter(values), |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    }))?;
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        let (epg, title, description) = sql(row)?;
        if seen.contains(&epg) {
            continue;
        }
        let text = format!("{title} {description}").to_lowercase();
        let starts: Vec<&str> = text
            .split(|c: char| c.is_whitespace() || "([-/:\"#.,;!?)]'".contains(c))
            .filter(|w| !w.is_empty())
            .collect();
        if words.iter().all(|word| starts.iter().any(|w| w.starts_with(word.as_str()))) {
            seen.insert(epg.clone());
            out.push(epg);
        }
    }
    Ok(out)
}
/// One channel's listings in the window, after (start, ordinal), at most `limit`.
pub(crate) fn programs(
    c: &Connection,
    account: &str,
    epg_id: &str,
    from_ms: i64,
    to_ms: i64,
    after: Option<(i64, i64)>,
    limit: usize,
) -> Result<Vec<Program>, String> {
    if status(c, account)?.is_none() {
        return Ok(Vec::new());
    }
    let (after_start, after_ordinal) = after.unwrap_or((i64::MIN, i64::MIN));
    let mut statement = sql(c.prepare(&format!(
        "SELECT epg_id,start_ms,stop_ms,ordinal,title,description,categories FROM account_guide_program_v1
         WHERE account_id=?1 AND {OVERLAP} AND epg_id=?4 AND (start_ms>?5 OR (start_ms=?5 AND ordinal>?6))
         ORDER BY start_ms,ordinal LIMIT ?7"
    )))?;
    let rows = sql(statement.query_map(
        params![account, from_ms, to_ms, epg_id, after_start, after_ordinal, limit.min(100) as i64],
        |r| {
            let categories: String = r.get(6)?;
            Ok(Program {
                epg_id: r.get(0)?,
                start_ms: r.get(1)?,
                stop_ms: r.get(2)?,
                ordinal: r.get(3)?,
                title: r.get(4)?,
                description: r.get(5)?,
                categories: serde_json::from_str(&categories).unwrap_or_default(),
            })
        },
    ))?;
    rows.map(sql).collect()
}

#[cfg(test)]
#[path = "account_guide_tests.rs"]
mod tests;
