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

//! Preparing and committing discovery steps: file progress, item pages and
//! prepared titles.

use super::*;

pub(crate) struct PreparedFile {
    pub provider_index: Option<u32>,
    pub original: Option<String>,
    pub file_title: Option<String>,
    pub name: String,
    pub size: String,
    pub duration: Option<f64>,
    pub sha1: Option<String>,
}

#[derive(Clone)]
pub(crate) struct PreparedPage {
    pub provider_count: u32,
    pub next_offset: u32,
    pub fingerprint: String,
    pub scanned_bytes: u64,
    pub curation_year: Option<i64>,
    pub expected_offset: Option<u32>,
    pub expected_fingerprint: Option<String>,
    pub capacity: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProgress {
    pub title_ref: String,
    pub title: String,
    pub kind: String,
    pub original_year: Option<i64>,
    pub provider_file_count: u32,
    pub next_offset: u32,
    pub available_file_count: u32,
    pub complete: bool,
    pub capacity_reached: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileStepRequest {
    pub schema_version: u32,
    pub request_id: String,
    pub title_ref: String,
    pub expected_revision: String,
    pub expected_offset: u32,
    pub explicit_action: bool,
    #[serde(default)]
    pub restart: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStepReceipt {
    pub schema_version: u32,
    pub committed: bool,
    pub revision: String,
    pub progress: FileProgress,
    pub admitted: usize,
    pub confirmed_dead: usize,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileProgressQuery {
    pub schema_version: u32,
    pub request_id: String,
    pub expected_revision: Option<String>,
    pub offset: usize,
    pub page_size: usize,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub decade: Option<i64>,
    #[serde(default)]
    pub favorites_only: bool,
    #[serde(default)]
    pub language_mode: LanguageMode,
    #[serde(default)]
    pub content_type: ContentType,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProgressReply {
    pub schema_version: u32,
    pub revision: String,
    pub total_count: usize,
    pub offset: usize,
    pub items: Vec<FileProgress>,
    pub more: bool,
}

pub(crate) struct ItemCapture {
    pub item_id: String,
    pub downloads: i64,
    pub page: PreparedPage,
}

pub(super) const FILE_PROGRESS_SQL: &str = "SELECT t.title_ref,t.title,t.kind,t.release_year,p.provider_count,p.next_offset,(SELECT count(*) FROM archive_file_v1 f WHERE f.item_id=t.item_id AND f.eligible=1),p.capacity,t.search_text FROM archive_item_progress_v1 p JOIN archive_title_v1 t ON t.item_id=p.item_id WHERE p.item_id=?1";

pub(crate) fn file_progress(c: &Connection, id: &str) -> Result<FileProgress, String> {
    let (mut progress, aliases): (FileProgress, String) =
        sql(c.query_row(FILE_PROGRESS_SQL, [id], |r| {
            let count: u32 = r.get(4)?;
            let next: u32 = r.get(5)?;
            let progress = FileProgress {
                title_ref: r.get(0)?,
                title: r.get(1)?,
                kind: r.get(2)?,
                original_year: r.get(3)?,
                provider_file_count: count,
                next_offset: next,
                available_file_count: r.get(6)?,
                complete: next == count,
                capacity_reached: r.get(7)?,
            };
            Ok((progress, r.get(8)?))
        }))?;
    match content_type(decode_search_metadata(&aliases)?.as_ref()) {
        ContentType::Tv => progress.kind = "tv".to_owned(),
        ContentType::Movie | ContentType::Short => progress.kind = "movie".to_owned(),
        _ => {}
    }
    Ok(progress)
}

pub(crate) fn item_prepare(c: &Connection, r: &FileStepRequest) -> Result<ItemCapture, String> {
    if r.schema_version != 1
        || !text(&r.request_id, 256)
        || !hex_ref(&r.title_ref)
        || !r.explicit_action
        || r.expected_offset > 100000
    {
        return Err("archive-item-request-invalid".into());
    }
    let tx = sql(c.unchecked_transaction())?;
    if current(&tx)? != revision(&r.expected_revision)? {
        return Err("archive-revision-stale".into());
    }
    let raw:(String,i64,u32,u32,String,i64,Option<i64>,bool)=sql(tx.query_row("SELECT t.item_id,t.downloads,p.provider_count,p.next_offset,p.fingerprint,p.scanned_bytes,p.curation_year,p.capacity FROM archive_title_v1 t JOIN archive_item_progress_v1 p ON p.item_id=t.item_id WHERE t.title_ref=?1",[&r.title_ref],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional())?.ok_or("archive-item-unavailable")?;
    if raw.3 != r.expected_offset || (!r.restart && (raw.3 >= raw.2 || raw.7)) {
        return Err("archive-item-progress-stale".into());
    }
    let page = PreparedPage {
        provider_count: raw.2,
        next_offset: raw.3,
        fingerprint: raw.4.clone(),
        scanned_bytes: u64::try_from(raw.5)
            .ok()
            .filter(|n| *n <= 20 * 1024 * 1024)
            .ok_or("archive-item-progress-invalid")?,
        curation_year: raw.6,
        expected_offset: Some(raw.3),
        expected_fingerprint: Some(raw.4),
        capacity: false,
    };
    sql(tx.commit())?;
    Ok(ItemCapture {
        item_id: raw.0,
        downloads: raw.1,
        page,
    })
}

pub(super) fn install_page(c: &Connection, id: &str, p: &PreparedPage) -> Result<(), String> {
    if p.provider_count == 0
        || p.provider_count > 100000
        || p.next_offset > p.provider_count
        || !hex_ref(&p.fingerprint)
        || p.scanned_bytes > 20 * 1024 * 1024
    {
        return Err("archive-item-progress-invalid".into());
    }
    let previous: Option<(u32, String)> = sql(c
        .query_row(
            "SELECT next_offset,fingerprint FROM archive_item_progress_v1 WHERE item_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional())?;
    if let Some(expected) = p.expected_offset {
        if previous.as_ref().is_none_or(|(offset, hash)| {
            *offset != expected || Some(hash) != p.expected_fingerprint.as_ref()
        }) {
            return Err("archive-item-progress-stale".into());
        }
    } else if previous
        .as_ref()
        .is_some_and(|(offset, hash)| hash == &p.fingerprint && *offset >= p.next_offset)
    {
        return Ok(());
    }
    let scanned_bytes =
        i64::try_from(p.scanned_bytes).map_err(|_| "archive-item-progress-invalid")?;
    sql(c.execute("INSERT INTO archive_item_progress_v1 VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(item_id) DO UPDATE SET provider_count=excluded.provider_count,next_offset=excluded.next_offset,fingerprint=excluded.fingerprint,scanned_bytes=excluded.scanned_bytes,curation_year=excluded.curation_year,capacity=excluded.capacity",params![id,p.provider_count,p.next_offset,p.fingerprint,scanned_bytes,p.curation_year,p.capacity]))?;
    Ok(())
}

pub(crate) fn item_progress(
    c: &Connection,
    q: &FileProgressQuery,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<FileProgressReply, String> {
    query_valid(q.schema_version, &q.request_id, q.offset, q.page_size, 1400)?;
    if !valid_decade(q.decade)
        || q.query.len() > 512
        || q.query.chars().any(char::is_control)
        || (q.offset > 0 && q.expected_revision.is_none())
    {
        return Err("archive-query-invalid".into());
    }
    let tx = sql(c.unchecked_transaction())?;
    let rev = current(&tx)?;
    if q.expected_revision
        .as_deref()
        .map(revision)
        .transpose()?
        .is_some_and(|r| r != rev)
    {
        return Err("archive-revision-stale".into());
    }
    let mut stmt=sql(tx.prepare("SELECT t.item_id,t.search_text,COALESCE(p.favorite,0),t.title FROM archive_item_progress_v1 i JOIN archive_title_v1 t ON t.item_id=i.item_id LEFT JOIN archive_preferences_v1 p ON p.title_ref=t.title_ref WHERE i.next_offset<i.provider_count AND (?1 IS NULL OR t.release_year BETWEEN ?1 AND ?1+9) AND (?2=0 OR COALESCE(p.favorite,0)=1) ORDER BY t.title_ref"))?;
    let mut rows = sql(stmt.query(params![q.decade, q.favorites_only]))?;
    let mut matched = Vec::new();
    let phrase = search_phrase(&q.query);
    while let Some(row) = sql(rows.next())? {
        check()?;
        let alias: String = sql(row.get(1))?;
        if alias.len() > 16384 {
            return Err("archive-search-metadata-limit".into());
        }
        let name: String = sql(row.get(3))?;
        let Some(basis) = match_basis(&name, &alias, "", &q.query)? else {
            continue;
        };
        let metadata = decode_search_metadata(&alias)?;
        let content = content_type(metadata.as_ref());
        if q.content_type != ContentType::All && q.content_type != content {
            continue;
        }
        let languages = metadata
            .as_ref()
            .map(|m| m.languages.as_slice())
            .unwrap_or_default();
        if !q.language_mode.includes(languages) {
            continue;
        }
        let id: String = sql(row.get(0))?;
        let favorite: bool = sql(row.get(2))?;
        let relevance = match basis {
            "title" => title_match_rank(&search_phrase(&name), &phrase),
            "series" => 4,
            "subject" | "genre" => 5,
            _ => 7,
        };
        matched.push((!favorite, relevance, q.language_mode.rank(languages), id));
        if matched.len() > 1400 {
            return Err("archive-title-limit".into());
        }
    }
    drop(rows);
    drop(stmt);
    if q.language_mode == LanguageMode::EnglishFirst {
        matched
            .sort_by_key(|(favorite, relevance, language, _)| (*favorite, *relevance, *language));
    }
    let total = matched.len();
    let mut items = Vec::new();
    for (_, _, _, id) in matched.into_iter().skip(q.offset).take(q.page_size) {
        check()?;
        items.push(file_progress(&tx, &id)?);
    }
    check()?;
    sql(tx.commit())?;
    Ok(FileProgressReply {
        schema_version: 1,
        revision: rev.to_string(),
        total_count: total,
        offset: q.offset,
        more: q.offset + items.len() < total,
        items,
    })
}

pub(crate) struct PreparedTitle {
    pub partial: Option<PreparedPage>,
    pub item_id: String,
    pub search_aliases: String,
    pub title: String,
    pub kind: &'static str,
    pub year: Option<i64>,
    pub rights: Option<String>,
    pub downloads: i64,
    pub servers: Vec<String>,
    pub all_file_names: Vec<String>,
    pub files: Vec<PreparedFile>,
}

pub(crate) struct PreparedStep {
    pub item_page: bool,
    pub titles: Vec<PreparedTitle>,
    pub deleted: Vec<String>,
    pub examined: usize,
    pub unknown_year: usize,
    pub transient_failures: usize,
    pub unavailable: usize,
    pub capacity_reached: bool,
    pub next_page: Option<u32>,
    pub observed_ms: i64,
}

pub(crate) fn prepare(
    c: &Connection,
    expected: &str,
    year: i64,
    page: u32,
    query_hash: &str,
    restart: bool,
) -> Result<(), String> {
    prepare_at(c, expected, year, page, query_hash, restart, now_ms()?)
}

pub(super) fn prepare_at(
    c: &Connection,
    expected: &str,
    year: i64,
    page: u32,
    query_hash: &str,
    restart: bool,
    now: i64,
) -> Result<(), String> {
    if current(c)? != revision(expected)? {
        return Err("archive-revision-stale".into());
    }
    if restart && page == 1 {
        return Ok(());
    }
    let saved: Option<(String, u32, bool, Option<i64>)> = sql(c
        .query_row(
            "SELECT query_hash,next_page,complete,retry_after_ms FROM archive_progress_v1 WHERE year=?1",
            [year],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional())?;
    match saved {
        Some((hash, next, complete, _)) if hash == query_hash && (complete || page != next) => {
            Err("archive-progress-stale".into())
        }
        Some((hash, _, _, _)) if hash != query_hash && page != 1 => {
            Err("archive-progress-stale".into())
        }
        Some((hash, _, _, Some(retry))) if hash == query_hash && now < retry => {
            Err("archive-retry-not-due".into())
        }
        None if page != 1 => Err("archive-progress-stale".into()),
        _ => Ok(()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepReceipt {
    pub schema_version: u32,
    pub committed: bool,
    pub revision: String,
    pub year: Option<i64>,
    pub page: u32,
    pub next_page: Option<u32>,
    pub examined: usize,
    pub admitted: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_visible_matches: Option<usize>,
    pub excluded_unknown_year: usize,
    pub unavailable: usize,
    pub transient_failures: usize,
    pub confirmed_dead: usize,
    pub title_count: usize,
    pub capacity_reached: bool,
    pub retry_after_ms: Option<i64>,
    pub ranking_policy: &'static str,
    pub pending_file_pages: Vec<FileProgress>,
    #[serde(skip)]
    pub(crate) file_page_progress: Option<FileProgress>,
    #[serde(skip)]
    pub(crate) files_admitted: usize,
}

/// Which search results page a step commits: its year filter, page number,
/// query fingerprint, and whether the search starts over.
#[derive(Clone, Copy)]
pub(crate) struct SearchPage<'a> {
    pub year: Option<i64>,
    pub page: u32,
    pub query_hash: &'a str,
    pub restart: bool,
}

pub(crate) fn commit(
    c: &mut Connection,
    expected: &str,
    search: SearchPage<'_>,
    step: PreparedStep,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<StepReceipt, String> {
    commit_view(c, expected, search, step, None, check)
}
