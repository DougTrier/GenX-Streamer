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

//! On-demand Archive records. Never a station, playlist, guide or preference.
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

pub(crate) const POLICY: &str = "archive-popularity-playable-v1";
pub(crate) fn now_ms() -> Result<i64, String> {
    let milliseconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "archive-clock-invalid")?
        .as_millis();
    if milliseconds > 9_007_199_254_740_991 {
        return Err("archive-clock-invalid".into());
    }
    i64::try_from(milliseconds).map_err(|_| "archive-clock-invalid".into())
}
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| crate::storage_transaction::sql_error_code(&e, "archive-database-failed"))
}
pub(crate) fn revision(s: &str) -> Result<i64, String> {
    if s.is_empty()
        || s.len() > 19
        || !s.bytes().all(|b| b.is_ascii_digit())
        || (s.len() > 1 && s.starts_with('0'))
    {
        return Err("archive-revision-invalid".into());
    }
    s.parse().map_err(|_| "archive-revision-invalid".into())
}
pub(crate) fn text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
pub(crate) fn fold(s: &str) -> String {
    s.nfkc().collect::<String>().to_lowercase()
}
pub(crate) fn opaque(parts: &[&str]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update((p.len() as u64).to_be_bytes());
        h.update(p.as_bytes());
    }
    format!("{:x}", h.finalize())
}
pub(crate) fn install(tx: &Transaction<'_>) -> Result<(), String> {
    sql(tx.execute_batch("CREATE TABLE archive_catalog_meta_v1(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision>=0)); INSERT INTO archive_catalog_meta_v1 VALUES(1,0);
CREATE TABLE archive_title_v1(title_ref TEXT PRIMARY KEY,item_id TEXT UNIQUE NOT NULL,title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 512),kind TEXT NOT NULL CHECK(kind IN('tv','movie')),release_year INTEGER CHECK(release_year IS NULL OR release_year BETWEEN 1888 AND 2100),curated INTEGER NOT NULL CHECK(curated IN(0,1)),searched INTEGER NOT NULL CHECK(searched IN(0,1)),rights TEXT CHECK(rights IS NULL OR length(CAST(rights AS BLOB))<=2048),downloads INTEGER NOT NULL CHECK(downloads>=0),observed_ms INTEGER NOT NULL CHECK(observed_ms BETWEEN 0 AND 9007199254740991),search_text TEXT NOT NULL);
CREATE INDEX archive_title_year_v1 ON archive_title_v1(release_year,downloads DESC,item_id);
CREATE TABLE archive_preferences_v1(title_ref TEXT PRIMARY KEY CHECK(length(title_ref)=64),item_id TEXT NOT NULL,title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 512),release_year INTEGER CHECK(release_year IS NULL OR release_year BETWEEN 1888 AND 2100),favorite INTEGER NOT NULL CHECK(favorite IN(0,1)));
CREATE TABLE archive_file_v1(file_ref TEXT PRIMARY KEY,title_ref TEXT NOT NULL REFERENCES archive_title_v1(title_ref) ON DELETE CASCADE,item_id TEXT NOT NULL,file_name TEXT NOT NULL CHECK(length(CAST(file_name AS BLOB)) BETWEEN 1 AND 1024),format TEXT NOT NULL CHECK(format='h.264'),size_bytes TEXT NOT NULL,duration_seconds REAL CHECK(duration_seconds IS NULL OR (duration_seconds>0 AND duration_seconds<=604800)),sha1 TEXT,servers TEXT NOT NULL CHECK(length(CAST(servers AS BLOB))<=1024),observed_ms INTEGER NOT NULL CHECK(observed_ms BETWEEN 0 AND 9007199254740991),eligible INTEGER NOT NULL CHECK(eligible IN(0,1)),provider_index INTEGER CHECK(provider_index IS NULL OR provider_index BETWEEN 0 AND 99999),original_identity TEXT CHECK(original_identity IS NULL OR length(CAST(original_identity AS BLOB))<=1024),file_title TEXT CHECK(file_title IS NULL OR length(CAST(file_title AS BLOB))<=512),UNIQUE(item_id,file_name)); CREATE INDEX archive_file_title_v1 ON archive_file_v1(title_ref,file_name);
CREATE TABLE archive_item_progress_v1(item_id TEXT PRIMARY KEY REFERENCES archive_title_v1(item_id) ON DELETE CASCADE,provider_count INTEGER NOT NULL CHECK(provider_count BETWEEN 1 AND 100000),next_offset INTEGER NOT NULL CHECK(next_offset BETWEEN 0 AND provider_count),fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),scanned_bytes INTEGER NOT NULL CHECK(scanned_bytes BETWEEN 0 AND 20971520),curation_year INTEGER CHECK(curation_year IS NULL OR curation_year BETWEEN 1960 AND 1999),capacity INTEGER NOT NULL CHECK(capacity IN(0,1)));
CREATE TABLE archive_progress_v1(year INTEGER PRIMARY KEY CHECK(year=0 OR year BETWEEN 1960 AND 1999),query_hash TEXT NOT NULL,next_page INTEGER NOT NULL CHECK(next_page BETWEEN 1 AND 21),complete INTEGER NOT NULL CHECK(complete IN(0,1)),retry_after_ms INTEGER);"))?;
    install_removals(tx)
}
pub(crate) fn install_removals(tx: &Transaction<'_>) -> Result<(), String> {
    sql(tx.execute_batch("CREATE TABLE archive_removal_v1(scope TEXT NOT NULL CHECK(scope IN('title','file')),reference TEXT NOT NULL CHECK(length(reference)=64),item_id TEXT NOT NULL CHECK(length(CAST(item_id AS BLOB)) BETWEEN 1 AND 100),title_ref TEXT NOT NULL CHECK(length(title_ref)=64),display_name TEXT NOT NULL CHECK(length(CAST(display_name AS BLOB)) BETWEEN 1 AND 512),file_name TEXT CHECK(file_name IS NULL OR length(CAST(file_name AS BLOB)) BETWEEN 1 AND 1024),created_revision INTEGER NOT NULL CHECK(created_revision>=0),PRIMARY KEY(scope,reference));CREATE INDEX archive_removal_title_v1 ON archive_removal_v1(title_ref,scope);"))
}
#[derive(Clone)]
pub(crate) enum RemovalScope {
    TitleRef(String),
    FileRef(String),
    All,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveTitleRequest {
    pub schema_version: u32,
    pub request_id: String,
    pub title_ref: String,
    pub expected_revision: String,
    pub explicit_action: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveFileRequest {
    pub schema_version: u32,
    pub request_id: String,
    pub title_ref: String,
    pub file_ref: String,
    pub expected_revision: String,
    pub explicit_action: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearLibraryRequest {
    pub schema_version: u32,
    pub request_id: String,
    pub expected_revision: String,
    pub explicit_action: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalReceipt {
    pub schema_version: u32,
    pub committed: bool,
    pub revision: String,
    pub removed_titles: usize,
    pub removed_files: usize,
    pub removed_favorites: usize,
    pub cleared_progress: usize,
    pub cleanup_pending: bool,
}
fn removed(c: &Connection, scope: &str, reference: &str) -> Result<bool, String> {
    sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM archive_removal_v1 WHERE scope=?1 AND reference=?2)",
        params![scope, reference],
        |r| r.get(0),
    ))
}
pub(crate) fn remove(
    c: &mut Connection,
    scope: &RemovalScope,
    title_ref: Option<&str>,
    expected: &str,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<RemovalReceipt, String> {
    if title_ref.is_some_and(|s| !hex_ref(s))
        || match scope {
            RemovalScope::TitleRef(s) | RemovalScope::FileRef(s) => !hex_ref(s),
            RemovalScope::All => false,
        }
    {
        return Err("archive-removal-invalid".into());
    }
    check()?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let old = current(&tx)?;
    if old != revision(expected)? {
        return Err("archive-revision-stale".into());
    }
    let next = old.checked_add(1).ok_or("archive-revision-exhausted")?;
    let mut receipt = RemovalReceipt {
        schema_version: 1,
        committed: true,
        revision: expected.to_owned(),
        removed_titles: 0,
        removed_files: 0,
        removed_favorites: 0,
        cleared_progress: 0,
        cleanup_pending: false,
    };
    let mut changed = false;
    let public_handled = if matches!(scope, RemovalScope::All) {
        false
    } else {
        crate::archive_provider_catalog::remove_in_transaction(&tx, scope, title_ref, &mut receipt)?
    };
    if public_handled {
        changed = true;
    } else {
        match scope {
            RemovalScope::All => {
                crate::archive_bookmarks::reset_library_in_transaction(&tx, check)?;
                receipt.removed_titles = sql(tx.query_row(
                    "SELECT count(*) FROM archive_title_v1",
                    [],
                    |r| r.get::<_, i64>(0),
                ))? as usize;
                receipt.removed_files = sql(tx.query_row(
                    "SELECT count(*) FROM archive_file_v1",
                    [],
                    |r| r.get::<_, i64>(0),
                ))? as usize;
                receipt.removed_favorites = sql(tx.query_row(
                    "SELECT count(*) FROM archive_preferences_v1 WHERE favorite=1",
                    [],
                    |r| r.get::<_, i64>(0),
                ))? as usize;
                receipt.cleared_progress = sql(tx.query_row(
                    "SELECT (SELECT count(*) FROM archive_progress_v1)+(SELECT count(*) FROM archive_item_progress_v1)",
                    [],
                    |r| r.get::<_, i64>(0),
                ))? as usize;
                for table in [
                    "archive_item_progress_v1",
                    "archive_file_v1",
                    "archive_title_v1",
                    "archive_preferences_v1",
                    "archive_progress_v1",
                    "archive_removal_v1",
                ] {
                    check()?;
                    sql(tx.execute(&format!("DELETE FROM {table}"), []))?;
                }
                // Empty clear still invalidates every already-captured producer.
                changed = true;
            }
            RemovalScope::TitleRef(reference) => {
                let row: Option<(String, String)> = sql(tx
                    .query_row(
                        "SELECT item_id,title FROM archive_title_v1 WHERE title_ref=?1",
                        [reference],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional())?;
                let row = match row {
                    Some(row) => Some(row),
                    None => sql(tx
                        .query_row(
                            "SELECT item_id,title FROM archive_preferences_v1 WHERE title_ref=?1",
                            [reference],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional())?,
                };
                if let Some((id, name)) = row {
                    if opaque(&["archive-item-v1", &id]) != *reference {
                        return Err("archive-removal-scope-invalid".into());
                    }
                    sql(tx.execute(
                        "INSERT INTO archive_removal_v1 VALUES('title',?1,?2,?1,?3,NULL,?4) ON CONFLICT(scope,reference) DO NOTHING",
                        params![reference, id, name, next],
                    ))?;
                    receipt.removed_files = sql(tx.query_row(
                        "SELECT count(*) FROM archive_file_v1 WHERE title_ref=?1",
                        [reference],
                        |r| r.get::<_, i64>(0),
                    ))? as usize;
                    receipt.cleared_progress = sql(tx.query_row(
                        "SELECT count(*) FROM archive_item_progress_v1 WHERE item_id=?1",
                        [&id],
                        |r| r.get::<_, i64>(0),
                    ))? as usize;
                    receipt.removed_favorites = sql(tx.query_row(
                        "SELECT count(*) FROM archive_preferences_v1 WHERE title_ref=?1 AND favorite=1",
                        [reference],
                        |r| r.get::<_, i64>(0),
                    ))? as usize;
                    sql(tx.execute(
                        "DELETE FROM archive_preferences_v1 WHERE title_ref=?1",
                        [reference],
                    ))?;
                    receipt.removed_titles = sql(tx.execute(
                        "DELETE FROM archive_title_v1 WHERE title_ref=?1",
                        [reference],
                    ))?;
                    changed = true;
                } else if !removed(&tx, "title", reference)? {
                    return Err("archive-title-unavailable".into());
                }
            }
            RemovalScope::FileRef(reference) => {
                let requested_title = title_ref.ok_or("archive-removal-scope-invalid")?;
                let row:Option<(String,String,String,String)>=sql(tx.query_row("SELECT f.item_id,f.title_ref,f.file_name,COALESCE(f.file_title,t.title) FROM archive_file_v1 f JOIN archive_title_v1 t ON t.title_ref=f.title_ref WHERE f.file_ref=?1",[reference],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
                if let Some((id, title, name, display)) = row {
                    if title != requested_title
                        || opaque(&["archive-file-v1", &id, &name]) != *reference
                    {
                        return Err("archive-removal-scope-invalid".into());
                    }
                    sql(tx.execute(
                        "INSERT INTO archive_removal_v1 VALUES('file',?1,?2,?3,?4,?5,?6) ON CONFLICT(scope,reference) DO NOTHING",
                        params![reference, id, title, display, name, next],
                    ))?;
                    receipt.removed_files = sql(
                        tx.execute("DELETE FROM archive_file_v1 WHERE file_ref=?1", [reference])
                    )?;
                    changed = true;
                } else {
                    let saved: Option<String> = sql(tx
                        .query_row(
                            "SELECT title_ref FROM archive_removal_v1 WHERE scope='file' AND reference=?1",
                            [reference],
                            |r| r.get(0),
                        )
                        .optional())?;
                    if saved.as_deref() != Some(requested_title) {
                        return Err("archive-removal-scope-invalid".into());
                    }
                }
            }
        }
    }
    if matches!(scope, RemovalScope::All) {
        crate::archive_provider_catalog::remove_in_transaction(
            &tx,
            scope,
            title_ref,
            &mut receipt,
        )?;
    }
    if changed {
        catalog_bounds(&tx)?;
        sql(tx.execute(
            "UPDATE archive_catalog_meta_v1 SET revision=?1 WHERE singleton=1 AND revision=?2",
            params![next, old],
        ))?;
        receipt.revision = next.to_string();
    }
    crate::archive_library_store::finalize(&tx, matches!(scope, RemovalScope::All), check)?;
    check()?;
    sql(tx.commit())?;
    Ok(receipt)
}
pub(crate) fn current(c: &Connection) -> Result<i64, String> {
    sql(c.query_row(
        "SELECT revision FROM archive_catalog_meta_v1 WHERE singleton=1",
        [],
        |r| r.get(0),
    ))
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FavoriteRequest {
    pub schema_version: u32,
    pub request_id: String,
    pub title_ref: String,
    pub expected_revision: String,
    pub value: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteReceipt {
    pub schema_version: u32,
    pub committed: bool,
    pub revision: String,
    pub title_ref: String,
    pub favorite: bool,
}
fn catalog_bounds(c: &Connection) -> Result<i64, String> {
    let (preferences,preference_bytes):(i64,i64)=sql(c.query_row("SELECT count(*),COALESCE(sum(length(CAST(title_ref AS BLOB))+length(CAST(item_id AS BLOB))+length(CAST(title AS BLOB))+128),0) FROM archive_preferences_v1",[],|r|Ok((r.get(0)?,r.get(1)?))))?;
    if preferences > 10000 || preference_bytes > 4 * 1024 * 1024 {
        return Err("archive-preferences-limit".into());
    }
    let (total,bytes):(i64,i64)=sql(c.query_row("SELECT (SELECT count(*) FROM archive_title_v1),(SELECT COALESCE(sum(length(CAST(title AS BLOB))+length(CAST(item_id AS BLOB))+COALESCE(length(CAST(rights AS BLOB)),0)+length(CAST(search_text AS BLOB))+256),0) FROM archive_title_v1)+(SELECT COALESCE(sum(length(CAST(file_name AS BLOB))+length(CAST(item_id AS BLOB))+length(CAST(servers AS BLOB))+COALESCE(length(CAST(original_identity AS BLOB)),0)+COALESCE(length(CAST(file_title AS BLOB)),0)+256),0) FROM archive_file_v1)",[],|r|Ok((r.get(0)?,r.get(1)?))))?;
    let progress_bytes: i64 = sql(c.query_row(
        "SELECT count(*)*256 FROM archive_item_progress_v1",
        [],
        |r| r.get(0),
    ))?;
    let (removal_count,removal_bytes):(i64,i64)=sql(c.query_row("SELECT count(*),COALESCE(sum(length(CAST(reference AS BLOB))+length(CAST(item_id AS BLOB))+length(CAST(title_ref AS BLOB))+length(CAST(display_name AS BLOB))+COALESCE(length(CAST(file_name AS BLOB)),0)+128),0) FROM archive_removal_v1",[],|r|Ok((r.get(0)?,r.get(1)?))))?;
    if removal_count > 10000 || removal_bytes > 4 * 1024 * 1024 {
        return Err("archive-removals-limit".into());
    }
    let public = if crate::archive_provider_catalog::installed(c)? {
        sql(
            c.query_row("SELECT count(*) FROM public_archive_item_v1", [], |r| {
                r.get::<_, i64>(0)
            }),
        )?
    } else {
        0
    };
    if total + public > 1400
        || bytes
            .checked_add(preference_bytes)
            .and_then(|b| b.checked_add(progress_bytes))
            .and_then(|b| b.checked_add(removal_bytes))
            .is_none_or(|b| b > 20 * 1024 * 1024)
    {
        return Err("archive-catalog-limit".into());
    }
    Ok(total + public)
}
pub(crate) fn set_favorite(
    c: &mut Connection,
    r: &FavoriteRequest,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<FavoriteReceipt, String> {
    if r.schema_version != 1 || !text(&r.request_id, 256) || !hex_ref(&r.title_ref) {
        return Err("archive-favorite-invalid".into());
    }
    if crate::archive_provider_catalog::title_exists(c, &r.title_ref)? {
        return crate::archive_provider_catalog::set_favorite(c, r, check);
    }
    let expected = revision(&r.expected_revision)?;
    check()?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    if current(&tx)? != expected {
        return Err("archive-revision-stale".into());
    }
    let live:Option<(String,String,Option<i64>)>=sql(tx.query_row("SELECT item_id,title,release_year FROM archive_title_v1 t WHERE title_ref=?1 AND EXISTS(SELECT 1 FROM archive_file_v1 f WHERE f.title_ref=t.title_ref AND f.eligible=1)",[&r.title_ref],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional())?;
    let saved: Option<(String, String, Option<i64>, bool)> = sql(tx
        .query_row(
            "SELECT item_id,title,release_year,favorite FROM archive_preferences_v1 WHERE title_ref=?1",
            [&r.title_ref],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional())?;
    let metadata = match (live, saved.as_ref()) {
        (Some(metadata), _) => metadata,
        (None, Some((id, title, year, _))) if !r.value => (id.clone(), title.clone(), *year),
        _ => return Err("archive-title-unavailable".into()),
    };
    if opaque(&["archive-item-v1", &metadata.0]) != r.title_ref {
        return Err("archive-favorite-invalid".into());
    }
    let changed = saved.as_ref().is_some_and(|s| s.3) != r.value;
    let mut result_revision = expected;
    if changed {
        result_revision = expected
            .checked_add(1)
            .ok_or("archive-revision-exhausted")?;
        sql(tx.execute(
            "INSERT INTO archive_preferences_v1 VALUES(?1,?2,?3,?4,?5) ON CONFLICT(title_ref) DO UPDATE SET favorite=excluded.favorite",
            params![r.title_ref, metadata.0, metadata.1, metadata.2, r.value],
        ))?;
        catalog_bounds(&tx)?;
        if sql(tx.execute(
            "UPDATE archive_catalog_meta_v1 SET revision=?1 WHERE singleton=1 AND revision=?2",
            params![result_revision, expected],
        ))? != 1
        {
            return Err("archive-revision-stale".into());
        }
    }
    crate::archive_library_store::finalize(&tx, false, check)?;
    check()?;
    sql(tx.commit())?;
    Ok(FavoriteReceipt {
        schema_version: 1,
        committed: true,
        revision: result_revision.to_string(),
        title_ref: r.title_ref.clone(),
        favorite: r.value,
    })
}
pub(crate) fn valid_decade(d: Option<i64>) -> bool {
    d.is_none_or(|d| matches!(d, 1960 | 1970 | 1980 | 1990 | 2000 | 2010 | 2020))
}
pub(crate) fn decade_end(decade: i64) -> i64 {
    if decade == 2020 {
        2100
    } else {
        decade + 9
    }
}
pub(crate) fn search_scope_hash(query: &str, decade: Option<i64>) -> String {
    opaque(&[
        "archive-query-fields-v9",
        query.trim(),
        &decade.map(|d| d.to_string()).unwrap_or_default(),
    ])
}

/// Filters provider claims only; this never establishes the language of audio.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LanguageMode {
    #[default]
    All,
    EnglishFirst,
    English,
    Unlisted,
}
impl LanguageMode {
    pub(crate) fn includes(self, languages: &[String]) -> bool {
        match self {
            Self::English => provider_language_rank(languages) == 0,
            Self::Unlisted => languages.is_empty(),
            Self::All | Self::EnglishFirst => true,
        }
    }
    pub(crate) fn rank(self, languages: &[String]) -> u8 {
        if self == Self::EnglishFirst {
            provider_language_rank(languages)
        } else {
            0
        }
    }
}
fn provider_language_rank(languages: &[String]) -> u8 {
    if languages.iter().any(|language| {
        let value = language.trim().to_ascii_lowercase();
        if matches!(value.as_str(), "en" | "eng" | "english") {
            return true;
        }
        let Some(tag) = value.strip_prefix("en-") else {
            return false;
        };
        // Accept clear hyphenated English tags, not prose containing English,
        // country/location labels, titles, or legacy mixed search aliases.
        let mut parts = tag.split('-');
        parts.next().is_some_and(|part| {
            ((2..=8).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphabetic()))
                || (part.len() == 3 && part.bytes().all(|b| b.is_ascii_digit()))
        }) && parts.all(|part| {
            (1..=8).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphanumeric())
        })
    }) {
        0
    } else if languages.is_empty() {
        1
    } else {
        2
    }
}

/// Provider type claims; the Archive mediatype `movies` alone proves no subtype.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ContentType {
    #[default]
    All,
    Tv,
    Movie,
    Short,
    Unknown,
}
pub(crate) fn content_type(metadata: Option<&SearchMetadata>) -> ContentType {
    let Some(m) = metadata else {
        return ContentType::Unknown;
    };
    let mut tv = false;
    let mut movie = false;
    let mut short = false;
    for label in m
        .provider_type
        .split([';', ',', '\n'])
        .chain(m.subjects.split([';', ',', '\n']))
    {
        match words(label).join(" ").as_str() {
            "tv" | "tv show" | "tv shows" | "tv series" | "television series"
            | "television show" | "television shows" | "classic tv" => tv = true,
            "movie" | "movies" | "feature film" | "feature films" => movie = true,
            "short film" | "short films" | "short subject" | "short subjects"
            | "animated short" | "animated shorts" | "cartoon shorts" => short = true,
            _ => {}
        }
    }
    // Only specific provider taxonomies establish a subtype. Broad video,
    // community, animation and public-access collections do not.
    for label in m.collections.lines().map(str::trim) {
        match label {
            "classic_tv" => tv = true,
            "feature_films" => movie = true,
            _ => {}
        }
    }
    match (tv, movie, short) {
        (true, false, false) => ContentType::Tv,
        (false, true, false) => ContentType::Movie,
        (false, false, true) => ContentType::Short,
        _ => ContentType::Unknown,
    }
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Artwork {
    pub item_id: String,
    pub file_name: String,
    pub size_bytes: String,
    pub mime_type: String,
    pub provider_sha1: Option<String>,
}
impl Artwork {
    pub(crate) fn validate(&self) -> bool {
        !self.item_id.is_empty()
            && self.item_id.len() <= 100
            && self
                .item_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            && ((self.file_name == "__ia_thumb.jpg" && self.mime_type == "image/jpeg")
                || (self.file_name == "__ia_thumb.png" && self.mime_type == "image/png"))
            && self
                .size_bytes
                .parse::<u64>()
                .is_ok_and(|n| n > 0 && n <= 512 * 1024 && n.to_string() == self.size_bytes)
            && self.provider_sha1.as_ref().is_none_or(|value| {
                value.len() == 40 && value.bytes().all(|c| c.is_ascii_hexdigit())
            })
    }
    pub(crate) fn reference(&self) -> String {
        opaque(&[
            "archive-artwork-v1",
            &self.item_id,
            &self.file_name,
            &self.size_bytes,
            &self.mime_type,
            self.provider_sha1.as_deref().unwrap_or(""),
        ])
    }
    fn info(&self) -> ArtworkInfo {
        ArtworkInfo {
            schema_version: 1,
            artwork_ref: self.reference(),
            item_id: self.item_id.clone(),
            file_name: self.file_name.clone(),
            size_bytes: self.size_bytes.clone(),
            mime_type: self.mime_type.clone(),
            provenance: "provider-item",
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkInfo {
    pub schema_version: u32,
    pub artwork_ref: String,
    pub item_id: String,
    pub file_name: String,
    pub size_bytes: String,
    pub mime_type: String,
    pub provenance: &'static str,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub schema_version: u32,
    pub request_id: String,
    pub query: String,
    pub expected_revision: Option<String>,
    pub offset: usize,
    pub page_size: usize,
    #[serde(default)]
    pub curated_only: bool,
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
pub struct Title {
    pub title_ref: String,
    pub title: String,
    pub kind: String,
    pub content_type: ContentType,
    pub content_type_provenance: &'static str,
    pub provider_series: Option<String>,
    pub artwork: Option<ArtworkInfo>,
    pub release_year: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_assessment: Option<crate::archive_date_assessment::DateAssessment>,
    pub curated: bool,
    pub favorite: bool,
    pub title_provenance: &'static str,
    pub provider_languages: Vec<String>,
    pub provider_subjects: Vec<String>,
    pub provider_description: Option<String>,
    pub language_provenance: &'static str,
    pub match_basis: &'static str,
    pub file_count: i64,
    pub duration_seconds: Option<f64>,
    pub rights: Option<String>,
    pub rank: i64,
    pub quality: &'static str,
    pub observed_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub schema_version: u32,
    pub revision: String,
    pub total_count: usize,
    pub offset: usize,
    pub items: Vec<Title>,
    pub more: bool,
}
fn query_valid(
    schema: u32,
    id: &str,
    offset: usize,
    size: usize,
    max: usize,
) -> Result<(), String> {
    if schema != 1 || !text(id, 256) || offset > max || !(1..=50).contains(&size) {
        Err("archive-query-invalid".into())
    } else {
        Ok(())
    }
}
/// Versioned value inside the existing bounded search_text column. Legacy flat
/// aliases remain readable; refresh upgrades only the explicitly fetched item.
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SearchMetadata {
    pub title: String,
    pub series: String,
    pub subjects: String,
    pub collections: String,
    pub description: String,
    pub languages: Vec<String>,
    #[serde(default)]
    pub provider_type: String,
    #[serde(default)]
    pub artwork: Option<Artwork>,
}
const SEARCH_METADATA_PREFIX: &str = "@genx-search-v3:";
pub(crate) fn encode_search_metadata(value: &SearchMetadata) -> Result<String, String> {
    validate_search_metadata(value)?;
    let body = serde_json::to_string(value).map_err(|_| "archive-search-metadata-invalid")?;
    let value = format!("{SEARCH_METADATA_PREFIX}{body}");
    if value.len() > 16384 {
        return Err("archive-search-metadata-limit".into());
    }
    Ok(value)
}
fn validate_search_metadata(m: &SearchMetadata) -> Result<(), String> {
    if (!m.title.is_empty() && !text(&m.title, 512))
        || m.languages.len() > 16
        || m.languages.iter().any(|s| !text(s, 128))
        || [&m.series, &m.subjects, &m.collections]
            .iter()
            .any(|s| s.len() > 16384 || s.chars().any(|c| c.is_control() && c != '\n'))
        || m.provider_type.len() > 1024
        || m.provider_type.chars().any(|c| c.is_control() && c != '\n')
        || m.artwork.as_ref().is_some_and(|art| !art.validate())
        || m.description.len() > 4096
        || m.description.chars().any(char::is_control)
    {
        return Err("archive-search-metadata-invalid".into());
    }
    Ok(())
}
fn decode_search_metadata(value: &str) -> Result<Option<SearchMetadata>, String> {
    if value.len() > 16384 {
        return Err("archive-search-metadata-limit".into());
    }
    let Some(body) = value
        .strip_prefix(SEARCH_METADATA_PREFIX)
        .or_else(|| value.strip_prefix("@genx-search-v2:"))
    else {
        return Ok(None);
    };
    let m: SearchMetadata =
        serde_json::from_str(body).map_err(|_| "archive-search-metadata-invalid")?;
    validate_search_metadata(&m)?;
    Ok(Some(m))
}
fn words(value: &str) -> Vec<String> {
    fold(value)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
// Matching and relevance share word boundaries and the existing bounded
// name alias, never arbitrary substring/stemming. Possessive punctuation does
// not make an otherwise equivalent programme title a weaker language tier.
fn search_words(value: &str) -> Vec<String> {
    static POSSESSIVE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let possessive = POSSESSIVE.get_or_init(|| {
        regex::Regex::new(r"(?u)\b([\p{L}\p{N}]{4,})['’]s\b")
            .expect("constant Archive possessive grammar")
    });
    words(&possessive.replace_all(&fold(value), "$1"))
}
fn word_matches(candidate: &str, query: &str) -> bool {
    candidate == query
        || (query.chars().count() >= 4 && candidate.strip_suffix('s') == Some(query))
        || (candidate.chars().count() >= 4 && query.strip_suffix('s') == Some(candidate))
}
fn same_words(candidate: &[String], query: &[String]) -> bool {
    candidate.len() == query.len() && candidate.iter().zip(query).all(|(a, b)| word_matches(a, b))
}
fn meaningful_match(value: &str, query: &str) -> bool {
    let haystack = search_words(value);
    let tokens = search_words(query);
    !tokens.is_empty()
        && tokens.iter().all(|t| {
            if matches!(
                t.as_str(),
                "cartoon" | "cartoons" | "animation" | "animated"
            ) {
                haystack.iter().any(|w| {
                    matches!(
                        w.as_str(),
                        "cartoon" | "cartoons" | "animation" | "animated"
                    )
                })
            } else {
                haystack.iter().any(|w| word_matches(w, t))
            }
        })
}
fn subject_match(value: &str, query: &str) -> bool {
    // YouTube's broad category includes live action, vlogs and news. Its
    // literal "Film & Animation" label does not establish cartoon content.
    value.split([';', ',', '\n']).any(|label| {
        let label_words = words(label);
        let boilerplate =
            label_words == ["film", "animation"] || label_words == ["film", "and", "animation"];
        !boilerplate && meaningful_match(label, query)
    })
}
pub(crate) fn cartoon_query(query: &str) -> bool {
    matches!(
        query.trim().to_ascii_lowercase().as_str(),
        "cartoon" | "cartoons" | "animation" | "animated"
    )
}
fn animation_collection(value: &str) -> bool {
    value.lines().any(|label| {
        matches!(
            label.trim(),
            "animationandcartoons" | "classic_cartoons" | "animation_unsorted"
        )
    })
}
fn music_performance(subjects: &str, title: &str) -> bool {
    subjects.split([';', ',', '\n']).any(|label| {
        matches!(
            words(label).join(" ").as_str(),
            "live performance"
                | "music video"
                | "concert"
                | "concerts"
                | "live music"
                | "local music"
                | "show gig"
                | "one man band"
        )
    }) || words(title).windows(2).any(|pair| pair == ["live", "at"])
}
fn cartoon_basis(
    title: &str,
    metadata: Option<&SearchMetadata>,
    query: &str,
) -> Option<&'static str> {
    let title_evidence = meaningful_match(title, query)
        || metadata.is_some_and(|m| meaningful_match(&m.title, query));
    let series_evidence = metadata.is_some_and(|m| meaningful_match(&m.series, query));
    let category = metadata.is_some_and(|m| animation_collection(&m.collections));
    // A title keyword can name a band/song or a school concert. In music
    // context require a separate animation claim, not a repeated cartoon tag.
    let animation_corroboration = metadata.is_some_and(|m| {
        category
            || m.subjects
                .split([';', ',', '\n'])
                .chain(m.provider_type.split([';', ',', '\n']))
                .any(|label| {
                    matches!(
                        words(label).join(" ").as_str(),
                        "animation"
                            | "animated short"
                            | "animated shorts"
                            | "animated film"
                            | "animated series"
                    )
                })
    });
    if metadata.is_some_and(|m| {
        music_performance(&m.subjects, if title.is_empty() { &m.title } else { title })
    }) && !animation_corroboration
    {
        return None;
    }
    if title_evidence {
        return Some("title");
    }
    if series_evidence {
        return Some("series");
    }
    if metadata.is_some_and(|m| subject_match(&m.subjects, query)) {
        return Some("subject");
    }
    // This exact provider taxonomy is genre evidence, not arbitrary collection
    // text matching and not verified work identity or audio language.
    category.then_some("genre")
}
fn incidental_named_match(title: &str, metadata: Option<&SearchMetadata>, query: &str) -> bool {
    // One ambiguous name in an interview, pet feature or live performance is
    // not evidence of the requested program. A specific multiword request can
    // still select that exact interview/band, and blank browsing stays intact.
    let query_words = search_words(query);
    if query_words.len() != 1
        || same_words(&search_words(title), &query_words)
        // Asking for the context itself is not an incidental-name search.
        || matches!(query_words[0].as_str(), "interview" | "interviews" | "concert" | "concerts" | "music" | "live" | "band" | "pet" | "pets" | "adopt")
    {
        return false;
    }
    let title_words = words(title);
    let context = music_performance(metadata.map_or("", |m| m.subjects.as_str()), title)
        || title.to_ascii_lowercase().contains("live @")
        || title_words
            .iter()
            .any(|w| w == "interview" || w == "interviews")
        || title_words.windows(3).any(|w| w == ["adopt", "a", "pet"]);
    context
        && !matches!(
            content_type(metadata),
            ContentType::Tv | ContentType::Movie | ContentType::Short
        )
}
pub(crate) fn match_basis(
    title: &str,
    aliases: &str,
    files: &str,
    query: &str,
) -> Result<Option<&'static str>, String> {
    if query.trim().is_empty() {
        return Ok(Some("browse"));
    }
    let metadata = decode_search_metadata(aliases)?;
    if cartoon_query(query) {
        return Ok(cartoon_basis(title, metadata.as_ref(), query));
    }
    // Legacy mixed aliases establish no typed metadata. Their actual saved
    // title can still disclose an incidental pet/interview/performance context;
    // use only that title, preserving blank and specifically named browsing.
    if incidental_named_match(
        if title.is_empty() {
            metadata.as_ref().map_or("", |m| m.title.as_str())
        } else {
            title
        },
        metadata.as_ref(),
        query,
    ) {
        return Ok(None);
    }
    if meaningful_match(title, query) {
        return Ok(Some("title"));
    }
    if let Some(m) = metadata {
        if meaningful_match(&m.title, query) {
            return Ok(Some("title"));
        }
        if meaningful_match(&m.series, query) {
            return Ok(Some("series"));
        }
        if subject_match(&m.subjects, query) {
            return Ok(Some("subject"));
        }
    }
    if meaningful_match(files, query) {
        return Ok(Some("file"));
    }
    Ok(None)
}
pub(crate) fn prepared_matches_query(title: &PreparedTitle, query: &str) -> Result<bool, String> {
    let files = title
        .files
        .iter()
        .map(|f| {
            format!(
                "{}\n{}",
                f.name,
                f.file_title.as_deref().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(match_basis(&title.title, &title.search_aliases, &files, query)?.is_some())
}
fn search_phrase(value: &str) -> String {
    fold(value).split_whitespace().collect::<Vec<_>>().join(" ")
}
fn title_match_rank(title: &str, query: &str) -> u8 {
    let title = search_words(title);
    let query = search_words(query);
    if query.is_empty() {
        return 4;
    }
    if same_words(&title, &query) {
        0
    } else if title.len() > query.len() && same_words(&title[..query.len()], &query) {
        1
    } else if title
        .windows(query.len())
        .any(|part| same_words(part, &query))
    {
        2
    } else if query
        .iter()
        .all(|token| title.iter().any(|word| word_matches(word, token)))
    {
        3
    } else {
        4
    }
}

pub(crate) fn query(
    c: &Connection,
    q: &Query,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Page, String> {
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
    let matched = query_matches(&tx, q, check)?;
    let total = matched.len();
    let items: Vec<Title> = matched
        .into_iter()
        .skip(q.offset)
        .take(q.page_size)
        .collect();
    check()?;
    sql(tx.commit())?;
    Ok(Page {
        schema_version: 1,
        revision: rev.to_string(),
        total_count: total,
        offset: q.offset,
        more: q.offset + items.len() < total,
        items,
    })
}
// Shared by public paging and discovery's atomic before/after visibility proof.
// Caller owns the read snapshot or IMMEDIATE write transaction. No nested BEGIN.
fn query_matches(
    c: &Connection,
    q: &Query,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Vec<Title>, String> {
    let phrase = search_phrase(&q.query);
    let tokens: Vec<String> = phrase.split_whitespace().map(str::to_owned).collect();
    let mut read=sql(c.prepare("SELECT t.title_ref,t.title,t.kind,t.release_year,t.rights,t.observed_ms,(SELECT count(*) FROM archive_file_v1 f WHERE f.title_ref=t.title_ref AND f.eligible=1),(SELECT CASE WHEN count(*)=1 THEN min(duration_seconds) ELSE NULL END FROM archive_file_v1 f WHERE f.title_ref=t.title_ref AND f.eligible=1),ROW_NUMBER() OVER(PARTITION BY t.release_year ORDER BY t.downloads DESC,t.item_id),t.search_text,t.curated,(SELECT group_concat(file_name||char(10)||COALESCE(file_title,''),char(10)) FROM archive_file_v1 f WHERE f.title_ref=t.title_ref AND f.eligible=1),COALESCE(p.favorite,0) FROM archive_title_v1 t LEFT JOIN archive_preferences_v1 p ON p.title_ref=t.title_ref WHERE (?1=0 OR t.curated=1) AND (?2 IS NULL OR t.release_year BETWEEN ?2 AND CASE WHEN ?2=2020 THEN 2100 ELSE ?2+9 END) AND (?3=0 OR COALESCE(p.favorite,0)=1) AND EXISTS(SELECT 1 FROM archive_file_v1 f WHERE f.title_ref=t.title_ref AND f.eligible=1) ORDER BY COALESCE(p.favorite,0) DESC,t.release_year,t.downloads DESC,t.item_id"))?;
    let mut rows = sql(read.query(params![q.curated_only, q.decade, q.favorites_only]))?;
    let mut matched = Vec::new();
    while let Some(r) = sql(rows.next())? {
        check()?;
        let search: String = sql(r.get(9))?;
        let filenames: String = sql(r.get(11))?;
        if search.len() > 16384 || filenames.len() > 1000 * 1538 {
            return Err("archive-search-metadata-limit".into());
        }
        let title: String = sql(r.get(1))?;
        let normalized_title = search_phrase(&title);
        let Some(basis) = match_basis(&title, &search, &filenames, &q.query)? else {
            continue;
        };
        let metadata = decode_search_metadata(&search)?;
        let content = content_type(metadata.as_ref());
        if q.content_type != ContentType::All && q.content_type != content {
            continue;
        }
        let languages = metadata
            .as_ref()
            .map(|m| m.languages.clone())
            .unwrap_or_default();
        if !q.language_mode.includes(&languages) {
            continue;
        }
        let subjects = metadata
            .as_ref()
            .map(|m| {
                m.subjects
                    .lines()
                    .map(str::trim)
                    .filter(|s| text(s, 128))
                    .take(16)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let description = metadata
            .as_ref()
            .map(|m| m.description.trim())
            .filter(|s| text(s, 2048) && !s.contains("://") && !s.contains('<') && !s.contains('>'))
            .map(str::to_owned);
        let stored_kind: String = sql(r.get(2))?;
        let kind = match content {
            ContentType::Tv => "tv".to_owned(),
            ContentType::Movie | ContentType::Short => "movie".to_owned(),
            _ => stored_kind,
        };
        let relevance = match basis {
            "title" => title_match_rank(&normalized_title, &phrase),
            "series" => 4,
            "subject" | "genre" => 5,
            "file" => 6,
            _ => 7,
        };
        let listed_year = sql(r.get(3))?;
        let date_assessment = crate::archive_date_assessment::from_legacy_year(listed_year)?;
        matched.push((
            relevance,
            normalized_title,
            Title {
                title_ref: sql(r.get(0))?,
                title,
                title_provenance: "provider-item",
                language_provenance: if languages.is_empty() {
                    "unknown"
                } else {
                    "provider-item"
                },
                provider_languages: languages,
                provider_subjects: subjects,
                provider_description: description,
                match_basis: basis,
                kind,
                content_type: content,
                content_type_provenance: if content == ContentType::Unknown {
                    "unknown"
                } else {
                    "provider-item"
                },
                provider_series: metadata
                    .as_ref()
                    .map(|m| m.series.trim())
                    .filter(|s| text(s, 512) && !s.contains('\n'))
                    .map(str::to_owned),
                artwork: metadata
                    .as_ref()
                    .and_then(|m| m.artwork.as_ref())
                    .map(Artwork::info),
                release_year: listed_year,
                date_assessment: Some(date_assessment),
                curated: sql(r.get(10))?,
                favorite: sql(r.get(12))?,
                rights: sql(r.get(4))?,
                observed_ms: sql(r.get(5))?,
                file_count: sql(r.get(6))?,
                duration_seconds: sql(r.get(7))?,
                rank: sql(r.get(8))?,
                quality: "metadata-h264",
                provider_id: None,
                source_url: None,
            },
        ));
        if matched.len() > 1400 {
            return Err("archive-title-limit".into());
        }
    }
    drop(rows);
    drop(read);
    check()?;
    for item in crate::archive_provider_catalog::query_rows(c, q, check)? {
        let normalized = search_phrase(&item.title);
        let relevance = match item.match_basis {
            "title" => title_match_rank(&normalized, &phrase),
            "series" => 4,
            "subject" | "genre" => 5,
            "file" => 6,
            _ => 7,
        };
        matched.push((relevance, normalized, item));
        if matched.len() > 1400 {
            return Err("archive-title-limit".into());
        }
    }
    // Unicode normalization stays consistent with literal token matching.
    // Sort the bounded native matches before slicing, within this same read
    // snapshot; do not rank a frontend page or infer identity from filenames.
    // Blank browsing retains SQL's per-year popularity and item-id order.
    if !tokens.is_empty() {
        matched.sort_unstable_by(|a, b| {
            b.2.favorite
                .cmp(&a.2.favorite)
                .then_with(|| a.0.cmp(&b.0))
                .then_with(|| {
                    q.language_mode
                        .rank(&a.2.provider_languages)
                        .cmp(&q.language_mode.rank(&b.2.provider_languages))
                })
                .then_with(|| a.1.cmp(&b.1))
                .then_with(|| a.2.title_ref.cmp(&b.2.title_ref))
        });
    } else if q.language_mode == LanguageMode::EnglishFirst {
        // Stable sorting keeps the original per-year popularity/item order
        // within each favorite/language tier, before native pagination.
        matched.sort_by_key(|(_, _, item)| {
            (
                !item.favorite,
                q.language_mode.rank(&item.provider_languages),
            )
        });
    }
    Ok(matched.into_iter().map(|(_, _, item)| item).collect())
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoveryView {
    pub schema_version: u32,
    pub language_mode: LanguageMode,
    pub favorites_only: bool,
    pub curated_only: bool,
    #[serde(default)]
    pub content_type: ContentType,
}
impl DiscoveryView {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("archive-discovery-view-invalid".into());
        }
        Ok(())
    }
}
fn visible_refs(
    c: &Connection,
    query: &str,
    decade: Option<i64>,
    view: &DiscoveryView,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<std::collections::HashSet<String>, String> {
    view.validate()?;
    let q = Query {
        schema_version: 1,
        request_id: "archive-discovery-view".into(),
        query: query.into(),
        expected_revision: None,
        offset: 0,
        page_size: 50,
        curated_only: view.curated_only,
        decade,
        favorites_only: view.favorites_only,
        language_mode: view.language_mode,
        content_type: view.content_type,
    };
    Ok(query_matches(c, &q, check)?
        .into_iter()
        .map(|item| item.title_ref)
        .collect())
}
pub(crate) fn artwork_source(
    c: &Connection,
    title_ref: &str,
    expected: &str,
) -> Result<(String, Option<Artwork>), String> {
    if !hex_ref(title_ref) || current(c)? != revision(expected)? {
        return Err("archive-revision-stale".into());
    }
    let row: Option<(String, String)> = sql(c.query_row("SELECT item_id,search_text FROM archive_title_v1 WHERE title_ref=?1 AND EXISTS(SELECT 1 FROM archive_file_v1 f WHERE f.title_ref=archive_title_v1.title_ref AND f.eligible=1)", [title_ref], |r| Ok((r.get(0)?,r.get(1)?))).optional())?;
    let (id, aliases) = row.ok_or("archive-artwork-unavailable")?;
    let image = decode_search_metadata(&aliases)?.and_then(|m| m.artwork);
    if image.as_ref().is_some_and(|image| image.item_id != id) {
        return Err("archive-artwork-unavailable".into());
    }
    Ok((id, image))
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilesQuery {
    pub schema_version: u32,
    pub request_id: String,
    pub title_ref: String,
    pub expected_revision: String,
    pub offset: usize,
    pub page_size: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    pub file_ref: String,
    pub title: String,
    pub file_name: String,
    pub item_id: String,
    pub format: String,
    pub duration_seconds: Option<f64>,
    pub size_bytes: Option<String>,
    pub availability: &'static str,
    pub observed_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_facts: Option<crate::archive_provider_catalog::Facts>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesPage {
    pub schema_version: u32,
    pub revision: String,
    pub title_ref: String,
    pub total_count: usize,
    pub offset: usize,
    pub files: Vec<FileRow>,
    pub more: bool,
}
pub(crate) fn files(
    c: &Connection,
    q: &FilesQuery,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<FilesPage, String> {
    query_valid(q.schema_version, &q.request_id, q.offset, q.page_size, 1000)?;
    if !hex_ref(&q.title_ref) {
        return Err("archive-query-invalid".into());
    }
    if crate::archive_provider_catalog::title_exists(c, &q.title_ref)? {
        return crate::archive_provider_catalog::files(c, q, check);
    }
    let tx = sql(c.unchecked_transaction())?;
    let rev = current(&tx)?;
    if revision(&q.expected_revision)? != rev {
        return Err("archive-revision-stale".into());
    }
    let total: i64 = sql(tx.query_row(
        "SELECT count(*) FROM archive_file_v1 WHERE title_ref=?1 AND eligible=1",
        [&q.title_ref],
        |r| r.get(0),
    ))?;
    if !(0..=1000).contains(&total) {
        return Err("archive-file-limit".into());
    }
    let mut stmt=sql(tx.prepare("SELECT f.file_ref,f.file_title,f.file_name,f.item_id,f.duration_seconds,f.size_bytes,f.observed_ms FROM archive_file_v1 f JOIN archive_title_v1 t ON t.title_ref=f.title_ref WHERE f.title_ref=?1 AND f.eligible=1 ORDER BY f.file_name LIMIT ?2 OFFSET ?3"))?;
    let mut rows = sql(stmt.query(params![q.title_ref, q.page_size as i64, q.offset as i64]))?;
    let mut files = Vec::new();
    while let Some(r) = sql(rows.next())? {
        check()?;
        let file_name: String = sql(r.get(2))?;
        let metadata_title: Option<String> = sql(r.get(1))?;
        let title = metadata_title
            .filter(|s| text(s, 512))
            .unwrap_or_else(|| file_name_label(&file_name));
        files.push(FileRow {
            file_ref: sql(r.get(0))?,
            title,
            file_name,
            item_id: sql(r.get(3))?,
            duration_seconds: sql(r.get(4))?,
            size_bytes: Some(sql(r.get(5))?),
            provider_facts: None,
            observed_ms: sql(r.get(6))?,
            format: "h.264".into(),
            availability: "unverified",
        });
    }
    drop(rows);
    drop(stmt);
    check()?;
    sql(tx.commit())?;
    Ok(FilesPage {
        schema_version: 1,
        revision: rev.to_string(),
        title_ref: q.title_ref.clone(),
        total_count: total as usize,
        offset: q.offset,
        more: q.offset + files.len() < total as usize,
        files,
    })
}
pub(crate) fn file_name_label(name: &str) -> String {
    if name.len() <= 512 {
        return name.to_owned();
    }
    // Keep the filename suffix visible when a long provider directory dominates.
    // This changes presentation only; the exact file identity is retained.
    let mut prefix = 384;
    while !name.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let mut suffix = name.len() - 125;
    while !name.is_char_boundary(suffix) {
        suffix += 1;
    }
    format!("{}…{}", &name[..prefix], &name[suffix..])
}
pub(crate) fn hex_ref(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadReceipt {
    pub schema_version: u32,
    pub committed: bool,
    pub revision: String,
    pub confirmed_dead: usize,
    pub title_count: usize,
}
pub(crate) fn remove_confirmed_missing(
    c: &mut Connection,
    file_ref: &str,
    expected: &str,
    evidence: &crate::archive_discovery::MissingEvidence,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<DeadReceipt, String> {
    if !hex_ref(file_ref) || !evidence.fresh() {
        return Err("archive-dead-proof-invalid".into());
    }
    check()?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let rev = current(&tx)?;
    if rev != revision(expected)? {
        return Err("archive-revision-stale".into());
    }
    if rev == i64::MAX {
        return Err("archive-revision-exhausted".into());
    }
    let row: Option<(String, String)> = sql(tx
        .query_row(
            "SELECT item_id,file_name FROM archive_file_v1 WHERE file_ref=?1",
            [file_ref],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional())?;
    let count = if let Some((item, name)) = row {
        if !evidence.matches(&item, &name) {
            return Err("archive-dead-proof-invalid".into());
        }
        sql(tx.execute("DELETE FROM archive_file_v1 WHERE file_ref=?1", [file_ref]))?
    } else {
        0
    };
    if count > 0 {
        sql(tx.execute("DELETE FROM archive_title_v1 WHERE NOT EXISTS(SELECT 1 FROM archive_file_v1 f WHERE f.title_ref=archive_title_v1.title_ref AND f.eligible=1)",[]))?;
        sql(tx.execute(
            "UPDATE archive_catalog_meta_v1 SET revision=revision+1 WHERE singleton=1",
            [],
        ))?;
    }
    let total: i64 = sql(tx.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r.get(0)))?;
    check()?;
    if !evidence.fresh() {
        return Err("archive-dead-proof-invalid".into());
    }
    crate::archive_library_store::finalize(&tx, false, check)?;
    check()?;
    if !evidence.fresh() {
        return Err("archive-dead-proof-invalid".into());
    }
    sql(tx.commit())?;
    Ok(DeadReceipt {
        schema_version: 1,
        committed: true,
        revision: (rev + i64::from(count > 0)).to_string(),
        confirmed_dead: count,
        title_count: total as usize,
    })
}
/// Native-only file authority for the future playback owner, never bridge data.
pub(crate) struct ResolvedFile {
    pub item_id: String,
    pub file_name: String,
    pub size_bytes: String,
    pub sha1: Option<String>,
    pub servers: Vec<String>,
    pub duration_seconds: Option<f64>,
    pub provider_index: Option<u32>,
    pub public: Option<crate::archive_provider_catalog::Resolved>,
}
pub(crate) fn resolve(
    c: &Connection,
    file_ref: &str,
    expected: &str,
) -> Result<ResolvedFile, String> {
    if !hex_ref(file_ref) {
        return Err("archive-file-invalid".into());
    }
    let tx = sql(c.unchecked_transaction())?;
    if current(&tx)? != revision(expected)? {
        return Err("archive-revision-stale".into());
    }
    let file = read_resolved(&tx, file_ref)?;
    sql(tx.commit())?;
    Ok(file)
}
/// Capture exact eligible file and its actual display metadata in one snapshot.
/// Download persistence remains independent of later provider-row deletion.
pub(crate) fn resolve_download(
    c: &Connection,
    file_ref: &str,
    expected: &str,
) -> Result<(ResolvedFile, String, String, String), String> {
    if !hex_ref(file_ref) {
        return Err("archive-file-invalid".into());
    }
    let tx = sql(c.unchecked_transaction())?;
    if current(&tx)? != revision(expected)? {
        return Err("archive-revision-stale".into());
    }
    let file = read_resolved(&tx, file_ref)?;
    if file.public.is_some() {
        return Err("public-archive-download-unsupported".into());
    }
    let (title_ref, title, file_title) = sql(tx.query_row(
        "SELECT t.title_ref,t.title,COALESCE(f.file_title,f.file_name) FROM archive_file_v1 f JOIN archive_title_v1 t ON t.title_ref=f.title_ref WHERE f.file_ref=?1",
        [file_ref], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    ))?;
    sql(tx.commit())?;
    Ok((file, title_ref, title, file_title))
}
fn read_resolved(c: &Connection, file_ref: &str) -> Result<ResolvedFile, String> {
    if crate::archive_provider_catalog::file_exists(c, file_ref)? {
        return crate::archive_provider_catalog::resolve(c, file_ref);
    }
    if removed(c, "file", file_ref)? {
        return Err("archive-file-unavailable".into());
    }
    let raw:(String,String,String,Option<String>,String,Option<f64>,Option<u32>)=sql(c.query_row("SELECT item_id,file_name,size_bytes,sha1,servers,duration_seconds,provider_index FROM archive_file_v1 WHERE file_ref=?1 AND eligible=1 AND format='h.264'",[file_ref],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional())?.ok_or("archive-file-unavailable")?;
    if removed(c, "title", &opaque(&["archive-item-v1", &raw.0]))? {
        return Err("archive-file-unavailable".into());
    }
    let servers: Vec<String> = serde_json::from_str(&raw.4).map_err(|_| "archive-file-invalid")?;
    if !text(&raw.0, 100)
        || !raw
            .0
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || !text(&raw.1, 1024)
        || raw.1.starts_with('/')
        || raw.1.contains('\\')
        || raw
            .1
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
        || opaque(&["archive-file-v1", &raw.0, &raw.1]) != file_ref
        || raw
            .2
            .parse::<u64>()
            .ok()
            .is_none_or(|n| n == 0 || n > 64 * 1024 * 1024 * 1024)
        || servers.len() > 3
        || servers.iter().any(|s| {
            s.len() > 253
                || !s.starts_with("ia")
                || !s.ends_with(".archive.org")
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        })
    {
        return Err("archive-file-invalid".into());
    }
    Ok(ResolvedFile {
        item_id: raw.0,
        file_name: raw.1,
        size_bytes: raw.2,
        sha1: raw.3,
        servers,
        duration_seconds: raw.5,
        provider_index: raw.6,
        public: None,
    })
}
pub(crate) fn verify_live(
    c: &Connection,
    file_ref: &str,
    expected: &ResolvedFile,
) -> Result<(), String> {
    if !hex_ref(file_ref) {
        return Err("archive-file-invalid".into());
    }
    if let Some(public) = &expected.public {
        return crate::archive_provider_catalog::verify_live(c, file_ref, public);
    }
    let live = read_resolved(c, file_ref)?;
    if live.public.is_some()
        || live.item_id != expected.item_id
        || live.file_name != expected.file_name
        || live.size_bytes != expected.size_bytes
        || live.sha1 != expected.sha1
        || live.servers != expected.servers
    {
        return Err("archive-file-changed".into());
    }
    Ok(())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgressQuery {
    #[serde(default)]
    pub decade: Option<i64>,
    pub schema_version: u32,
    pub request_id: String,
    pub query: String,
    pub year: Option<i64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressReply {
    pub schema_version: u32,
    pub revision: String,
    pub year: Option<i64>,
    pub next_page: u32,
    pub complete: bool,
    pub capacity_reached: bool,
    pub retry_after_ms: Option<i64>,
    pub title_count: usize,
}
pub(crate) fn progress(c: &Connection, q: &ProgressQuery) -> Result<ProgressReply, String> {
    if q.schema_version != 1
        || !valid_decade(q.decade)
        || q.year
            .zip(q.decade)
            .is_some_and(|(y, d)| !(d..=d + 9).contains(&y))
        || !text(&q.request_id, 256)
        || q.query.len() > 256
        || q.query.chars().any(char::is_control)
        || q.year.is_some_and(|y| !(1960..=1999).contains(&y))
        || (q.year.is_none() && q.query.trim().is_empty())
    {
        return Err("archive-query-invalid".into());
    }
    let tx = sql(c.unchecked_transaction())?;
    let rev = current(&tx)?;
    let hash = search_scope_hash(&q.query, q.decade);
    let saved: Option<(u32, bool, Option<i64>)> = sql(tx
        .query_row(
            "SELECT next_page,complete,retry_after_ms FROM archive_progress_v1 WHERE year=?1 AND query_hash=?2",
            params![q.year.unwrap_or(0), hash],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional())?;
    let (next, complete, retry) = saved.unwrap_or((1, false, None));
    let count: i64 = sql(tx.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r.get(0)))?;
    if !(0..=1400).contains(&count) {
        return Err("archive-title-limit".into());
    }
    sql(tx.commit())?;
    Ok(ProgressReply {
        schema_version: 1,
        revision: rev.to_string(),
        year: q.year,
        next_page: next,
        complete,
        capacity_reached: next == 21 && !complete,
        retry_after_ms: retry,
        title_count: count as usize,
    })
}
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
const FILE_PROGRESS_SQL: &str = "SELECT t.title_ref,t.title,t.kind,t.release_year,p.provider_count,p.next_offset,(SELECT count(*) FROM archive_file_v1 f WHERE f.item_id=t.item_id AND f.eligible=1),p.capacity,t.search_text FROM archive_item_progress_v1 p JOIN archive_title_v1 t ON t.item_id=p.item_id WHERE p.item_id=?1";
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
fn install_page(c: &Connection, id: &str, p: &PreparedPage) -> Result<(), String> {
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
fn prepare_at(
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
pub(crate) fn commit_view(
    c: &mut Connection,
    expected: &str,
    search: SearchPage<'_>,
    step: PreparedStep,
    view: Option<(&str, Option<i64>, &DiscoveryView)>,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<StepReceipt, String> {
    let SearchPage {
        year,
        page,
        query_hash,
        restart,
    } = search;
    check()?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    if step.item_page {
        if current(&tx)? != revision(expected)? {
            return Err("archive-revision-stale".into());
        }
    } else {
        prepare(&tx, expected, year.unwrap_or(0), page, query_hash, restart)?;
    }
    let old = current(&tx)?;
    if old == i64::MAX {
        return Err("archive-revision-exhausted".into());
    }
    let before_visible = view
        .map(|(query, decade, filter)| visible_refs(&tx, query, decade, filter, check))
        .transpose()?;
    let mut dead = 0;
    for id in &step.deleted {
        check()?;
        dead += sql(tx.execute("DELETE FROM archive_file_v1 WHERE item_id=?1", [id]))?;
        sql(tx.execute("DELETE FROM archive_title_v1 WHERE item_id=?1", [id]))?;
    }
    let mut files_admitted = 0;
    for t in &step.titles {
        check()?;
        let title_ref = opaque(&["archive-item-v1", &t.item_id]);
        if removed(&tx, "title", &title_ref)? {
            continue;
        }
        // Complete authoritative file-list absence is permanent evidence; an
        // outage or rejected metadata never enters this prepared title list.
        let mut stmt =
            sql(tx.prepare("SELECT file_ref,file_name FROM archive_file_v1 WHERE item_id=?1"))?;
        let rows = sql(stmt.query_map([&t.item_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }))?;
        let old_files = sql(rows.collect::<rusqlite::Result<Vec<_>>>())?;
        drop(stmt);
        for (reference, name) in old_files {
            if t.partial.is_some() {
                continue;
            }
            if !t.all_file_names.contains(&name) {
                dead +=
                    sql(tx.execute("DELETE FROM archive_file_v1 WHERE file_ref=?1", [reference]))?;
            }
        }
        if t.files.is_empty() && t.partial.is_none() {
            // Missing/changed format labels do not prove an existing file dead.
            // Keep historical metadata; playback revalidates it independently.
            continue;
        }
        sql(tx.execute("INSERT INTO archive_title_v1 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(item_id) DO UPDATE SET title=excluded.title,kind=excluded.kind,release_year=excluded.release_year,curated=max(archive_title_v1.curated,excluded.curated),searched=max(archive_title_v1.searched,excluded.searched),rights=excluded.rights,downloads=excluded.downloads,observed_ms=excluded.observed_ms,search_text=excluded.search_text",params![title_ref,t.item_id,t.title,t.kind,t.year,year.is_some() && t.partial.is_none(),year.is_none(),t.rights,t.downloads,step.observed_ms,t.search_aliases]))?;
        if t.partial.is_none() {
            sql(tx.execute(
                "UPDATE archive_file_v1 SET eligible=0 WHERE item_id=?1",
                [&t.item_id],
            ))?;
        }
        let servers = serde_json::to_string(&t.servers).map_err(|_| "archive-encoding-failed")?;
        let mut page = t.partial.clone();
        let mut available: i64 = sql(tx.query_row(
            "SELECT count(*) FROM archive_file_v1 WHERE item_id=?1 AND eligible=1",
            [&t.item_id],
            |r| r.get(0),
        ))?;
        for f in &t.files {
            check()?;
            if removed(
                &tx,
                "file",
                &opaque(&["archive-file-v1", &t.item_id, &f.name]),
            )? {
                continue;
            }
            let exists: bool = sql(tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM archive_file_v1 WHERE item_id=?1 AND file_name=?2 AND eligible=1)",
                params![t.item_id, f.name],
                |r| r.get(0),
            ))?;
            if page.is_some() && !exists && available >= 1000 {
                if let Some(p) = page.as_mut() {
                    p.capacity = true;
                    p.next_offset = p
                        .next_offset
                        .min(f.provider_index.ok_or("archive-item-progress-invalid")?);
                }
                continue;
            }
            let file_ref = opaque(&["archive-file-v1", &t.item_id, &f.name]);
            sql(tx.execute("INSERT INTO archive_file_v1 VALUES(?1,?2,?3,?4,'h.264',?5,?6,?7,?8,?9,1,?10,?11,?12) ON CONFLICT(item_id,file_name) DO UPDATE SET size_bytes=excluded.size_bytes,duration_seconds=excluded.duration_seconds,sha1=excluded.sha1,servers=excluded.servers,observed_ms=excluded.observed_ms,eligible=1,provider_index=excluded.provider_index,original_identity=excluded.original_identity,file_title=excluded.file_title",params![file_ref,title_ref,t.item_id,f.name,f.size,f.duration,f.sha1,servers,step.observed_ms,f.provider_index,f.original,f.file_title]))?;
            if !exists {
                available += 1;
            }
            files_admitted += 1;
        }
        if let Some(partial) = &page {
            install_page(&tx, &t.item_id, partial)?;
            if partial.curation_year.is_some() {
                let originals: i64 = sql(tx.query_row(
                    "SELECT count(DISTINCT original_identity) FROM archive_file_v1 WHERE item_id=?1 AND eligible=1",
                    [&t.item_id],
                    |r| r.get(0),
                ))?;
                if t.kind != "tv" || originals >= 2 {
                    sql(tx.execute(
                        "UPDATE archive_title_v1 SET curated=1 WHERE item_id=?1",
                        [&t.item_id],
                    ))?;
                }
            }
        } else {
            sql(tx.execute(
                "DELETE FROM archive_item_progress_v1 WHERE item_id=?1",
                [&t.item_id],
            ))?;
        }
    }
    sql(tx.execute("DELETE FROM archive_title_v1 WHERE NOT EXISTS(SELECT 1 FROM archive_file_v1 f WHERE f.title_ref=archive_title_v1.title_ref AND f.eligible=1) AND NOT EXISTS(SELECT 1 FROM archive_item_progress_v1 p WHERE p.item_id=archive_title_v1.item_id)",[]))?;
    sql(tx.execute(
        "UPDATE archive_title_v1 SET curated=0 WHERE release_year IS NULL OR release_year NOT BETWEEN 1960 AND 1999",
        [],
    ))?;
    sql(tx.execute("UPDATE archive_title_v1 SET curated=0 WHERE title_ref IN(SELECT title_ref FROM (SELECT title_ref,ROW_NUMBER() OVER(PARTITION BY release_year ORDER BY downloads DESC,item_id) AS n FROM archive_title_v1 WHERE curated=1) WHERE n>10)",[]))?;
    sql(tx.execute(
        "DELETE FROM archive_title_v1 WHERE curated=0 AND searched=0 AND NOT EXISTS(SELECT 1 FROM archive_preferences_v1 p WHERE p.title_ref=archive_title_v1.title_ref AND p.favorite=1) AND NOT EXISTS(SELECT 1 FROM archive_item_progress_v1 i WHERE i.item_id=archive_title_v1.item_id)",
        [],
    ))?;
    let searched: i64 = sql(tx.query_row(
        "SELECT count(*) FROM archive_title_v1 WHERE searched=1 AND curated=0",
        [],
        |r| r.get(0),
    ))?;
    if searched > 1000 {
        return Err("archive-title-limit".into());
    }
    let total = catalog_bounds(&tx)?;
    let mut admitted = 0;
    for t in &step.titles {
        if !t.files.is_empty()
            && !removed(&tx, "title", &opaque(&["archive-item-v1", &t.item_id]))?
            && sql(tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM archive_file_v1 WHERE item_id=?1 AND eligible=1)",
                [&t.item_id],
                |r| r.get::<_, bool>(0),
            ))?
        {
            admitted += 1;
        }
    }
    let new_visible_matches = match (view, before_visible) {
        (Some((query, decade, filter)), Some(before)) => Some(
            visible_refs(&tx, query, decade, filter, check)?
                .difference(&before)
                .count(),
        ),
        _ => None,
    };
    let retry_after_ms = if step.transient_failures > 0 {
        Some(
            step.observed_ms
                .checked_add(60_000)
                .ok_or("archive-clock-invalid")?,
        )
    } else {
        None
    };
    if !step.item_page {
        sql(tx.execute("INSERT INTO archive_progress_v1 VALUES(?1,?2,?3,?4,?5) ON CONFLICT(year) DO UPDATE SET query_hash=excluded.query_hash,next_page=excluded.next_page,complete=excluded.complete,retry_after_ms=excluded.retry_after_ms",params![year.unwrap_or(0),query_hash,step.next_page.unwrap_or(21),step.next_page.is_none()&&!step.capacity_reached,retry_after_ms]))?;
    }
    if sql(tx.execute(
        "UPDATE archive_catalog_meta_v1 SET revision=revision+1 WHERE singleton=1 AND revision=?1",
        [old],
    ))? != 1
    {
        return Err("archive-revision-stale".into());
    }
    let mut pending_file_pages = Vec::new();
    let mut file_page_progress = None;
    for t in &step.titles {
        if t.partial.is_some() {
            if removed(&tx, "title", &opaque(&["archive-item-v1", &t.item_id]))? {
                continue;
            }
            let progress = file_progress(&tx, &t.item_id)?;
            if step.item_page {
                file_page_progress = Some(progress.clone());
            }
            if !progress.complete {
                pending_file_pages.push(progress);
            }
        }
    }
    crate::archive_library_store::finalize(&tx, false, check)?;
    check()?;
    sql(tx.commit())?;
    Ok(StepReceipt {
        schema_version: 1,
        committed: true,
        revision: (old + 1).to_string(),
        year,
        page,
        next_page: step.next_page,
        examined: step.examined,
        admitted,
        new_visible_matches,
        excluded_unknown_year: step.unknown_year,
        unavailable: step.unavailable,
        transient_failures: step.transient_failures,
        confirmed_dead: dead,
        title_count: total as usize,
        capacity_reached: step.capacity_reached,
        retry_after_ms,
        ranking_policy: POLICY,
        pending_file_pages,
        file_page_progress,
        files_admitted,
    })
}
#[cfg(test)]
#[path = "archive_catalog_tests.rs"]
mod tests;
