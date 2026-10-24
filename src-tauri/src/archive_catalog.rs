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
                receipt.cleared_progress=sql(tx.query_row("SELECT (SELECT count(*) FROM archive_progress_v1)+(SELECT count(*) FROM archive_item_progress_v1)",[],|r|r.get::<_,i64>(0)))? as usize;
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
                    sql(tx.execute("INSERT INTO archive_removal_v1 VALUES('title',?1,?2,?1,?3,NULL,?4) ON CONFLICT(scope,reference) DO NOTHING",params![reference,id,name,next]))?;
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
                    sql(tx.execute("INSERT INTO archive_removal_v1 VALUES('file',?1,?2,?3,?4,?5,?6) ON CONFLICT(scope,reference) DO NOTHING",params![reference,id,title,display,name,next]))?;
                    receipt.removed_files = sql(
                        tx.execute("DELETE FROM archive_file_v1 WHERE file_ref=?1", [reference])
                    )?;
                    changed = true;
                } else {
                    let saved:Option<String>=sql(tx.query_row("SELECT title_ref FROM archive_removal_v1 WHERE scope='file' AND reference=?1",[reference],|r|r.get(0)).optional())?;
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
    let saved:Option<(String,String,Option<i64>,bool)>=sql(tx.query_row("SELECT item_id,title,release_year,favorite FROM archive_preferences_v1 WHERE title_ref=?1",[&r.title_ref],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional())?;
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
        sql(tx.execute("INSERT INTO archive_preferences_v1 VALUES(?1,?2,?3,?4,?5) ON CONFLICT(title_ref) DO UPDATE SET favorite=excluded.favorite",params![r.title_ref,metadata.0,metadata.1,metadata.2,r.value]))?;
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
    let saved:Option<(u32,bool,Option<i64>)>=sql(tx.query_row("SELECT next_page,complete,retry_after_ms FROM archive_progress_v1 WHERE year=?1 AND query_hash=?2",params![q.year.unwrap_or(0),hash],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional())?;
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
pub(crate) fn file_progress(c: &Connection, id: &str) -> Result<FileProgress, String> {
    let (mut progress, aliases): (FileProgress, String) = sql(c.query_row("SELECT t.title_ref,t.title,t.kind,t.release_year,p.provider_count,p.next_offset,(SELECT count(*) FROM archive_file_v1 f WHERE f.item_id=t.item_id AND f.eligible=1),p.capacity,t.search_text FROM archive_item_progress_v1 p JOIN archive_title_v1 t ON t.item_id=p.item_id WHERE p.item_id=?1",[id],|r| {
        let count:u32=r.get(4)?;let next:u32=r.get(5)?;
        Ok((FileProgress {title_ref:r.get(0)?,title:r.get(1)?,kind:r.get(2)?,original_year:r.get(3)?,provider_file_count:count,next_offset:next,available_file_count:r.get(6)?,complete:next==count,capacity_reached:r.get(7)?},r.get(8)?))
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
    let saved:Option<(String,u32,bool,Option<i64>)>=sql(c.query_row("SELECT query_hash,next_page,complete,retry_after_ms FROM archive_progress_v1 WHERE year=?1",[year],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
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
pub(crate) fn commit(
    c: &mut Connection,
    expected: &str,
    year: Option<i64>,
    page: u32,
    query_hash: &str,
    restart: bool,
    step: PreparedStep,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<StepReceipt, String> {
    commit_view(
        c, expected, year, page, query_hash, restart, step, None, check,
    )
}
pub(crate) fn commit_view(
    c: &mut Connection,
    expected: &str,
    year: Option<i64>,
    page: u32,
    query_hash: &str,
    restart: bool,
    step: PreparedStep,
    view: Option<(&str, Option<i64>, &DiscoveryView)>,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<StepReceipt, String> {
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
            let exists:bool=sql(tx.query_row("SELECT EXISTS(SELECT 1 FROM archive_file_v1 WHERE item_id=?1 AND file_name=?2 AND eligible=1)",params![t.item_id,f.name],|r|r.get(0)))?;
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
                let originals:i64=sql(tx.query_row("SELECT count(DISTINCT original_identity) FROM archive_file_v1 WHERE item_id=?1 AND eligible=1",[&t.item_id],|r|r.get(0)))?;
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
    sql(tx.execute("UPDATE archive_title_v1 SET curated=0 WHERE release_year IS NULL OR release_year NOT BETWEEN 1960 AND 1999",[]))?;
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
mod tests {
    use super::*;
    include!("archive_date_assessment_tests.rs");
    fn database() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;CREATE TABLE unrelated_station(id TEXT PRIMARY KEY);INSERT INTO unrelated_station VALUES('station-retained');").unwrap();
        let tx = c.transaction().unwrap();
        install(&tx).unwrap();
        crate::archive_bookmarks::install(&tx).unwrap();
        tx.commit().unwrap();
        c
    }
    #[test]
    fn archive_library_clear_resets_bookmarks_in_same_cas_transaction_and_cancel_rolls_all_back() {
        let mut c = database();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![title("chosen", Some(1964), 1)]),
            &mut || Ok(()),
        )
        .unwrap();
        let reference = opaque(&["archive-file-v1", "chosen", "one.mp4"]);
        c.execute(
            "UPDATE archive_file_v1 SET sha1=?1",
            ["0123456789abcdef0123456789abcdef01234567"],
        )
        .unwrap();
        let file = resolve(&c, &reference, "1").unwrap();
        let proof = crate::archive_bookmarks::capture(&reference, &file).unwrap();
        let position = crate::archive_bookmarks::Position {
            position_ms: 12345,
            duration_ms: Some(60000),
            completed: false,
            observed_ms: 1000,
        };
        crate::archive_bookmarks::save(&mut c, &proof, "0", &position, || Ok(())).unwrap();
        let checks = std::cell::Cell::new(0);
        assert!(remove(&mut c, &RemovalScope::All, None, "1", &mut || {
            checks.set(checks.get() + 1);
            if checks.get() == 3 {
                Err("canceled".into())
            } else {
                Ok(())
            }
        })
        .is_err());
        assert_eq!(current(&c).unwrap(), 1);
        assert!(crate::archive_bookmarks::read(&c, &proof)
            .unwrap()
            .position
            .is_some());
        let receipt = remove(&mut c, &RemovalScope::All, None, "1", &mut || Ok(())).unwrap();
        assert!(receipt.committed);
        assert_eq!(receipt.revision, "2");
        assert!(!serde_json::to_string(&receipt)
            .unwrap()
            .contains("bookmark"));
        assert_eq!(
            c.query_row("SELECT count(*) FROM archive_bookmark_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT revision FROM archive_bookmark_meta_v1", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            2
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM unrelated_station", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        // Empty Clear also revokes an earlier captured bookmark revision.
        remove(&mut c, &RemovalScope::All, None, "2", &mut || Ok(())).unwrap();
        assert_eq!(
            c.query_row("SELECT revision FROM archive_bookmark_meta_v1", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            3
        );
    }
    fn title(id: &str, year: Option<i64>, downloads: i64) -> PreparedTitle {
        PreparedTitle {
            partial: None,
            item_id: id.into(),
            title: "Identical provider title".into(),
            search_aliases: "identical provider title".into(),
            kind: "tv",
            year,
            rights: None,
            downloads,
            servers: vec!["ia800000.us.archive.org".into()],
            all_file_names: vec!["one.mp4".into(), "two.mp4".into()],
            files: vec![
                PreparedFile {
                    provider_index: None,
                    original: Some("one.mpg".into()),
                    file_title: None,
                    name: "one.mp4".into(),
                    size: "100".into(),
                    duration: Some(60.0),
                    sha1: None,
                },
                PreparedFile {
                    provider_index: None,
                    original: Some("two.mpg".into()),
                    file_title: None,
                    name: "two.mp4".into(),
                    size: "200".into(),
                    duration: None,
                    sha1: None,
                },
            ],
        }
    }
    fn step(titles: Vec<PreparedTitle>) -> PreparedStep {
        PreparedStep {
            item_page: false,
            titles,
            deleted: Vec::new(),
            examined: 12,
            unknown_year: 0,
            transient_failures: 0,
            unavailable: 0,
            capacity_reached: false,
            next_page: None,
            observed_ms: 1_000_000,
        }
    }
    fn page(next: u32, expected: Option<u32>) -> PreparedPage {
        PreparedPage {
            provider_count: 2000,
            next_offset: next,
            fingerprint: "a".repeat(64),
            scanned_bytes: 1000,
            curation_year: None,
            expected_offset: expected,
            expected_fingerprint: expected.map(|_| "a".repeat(64)),
            capacity: false,
        }
    }
    #[test]
    fn archive_user_title_removal_is_scoped_durable_and_refresh_cannot_restore_it() {
        let mut c = database();
        let mut chosen = title("chosen", Some(1964), 1);
        chosen.partial = Some(page(64, None));
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![chosen, title("other", Some(1965), 2)]),
            &mut || Ok(()),
        )
        .unwrap();
        let title_ref = opaque(&["archive-item-v1", "chosen"]);
        set_favorite(
            &mut c,
            &FavoriteRequest {
                schema_version: 1,
                request_id: "fixture".into(),
                title_ref: title_ref.clone(),
                expected_revision: "1".into(),
                value: true,
            },
            &mut || Ok(()),
        )
        .unwrap();
        let selected = opaque(&["archive-file-v1", "chosen", "one.mp4"]);
        let captured = resolve(&c, &selected, "2").unwrap();
        let receipt = remove(
            &mut c,
            &RemovalScope::TitleRef(title_ref.clone()),
            None,
            "2",
            &mut || Ok(()),
        )
        .unwrap();
        assert!(receipt.committed);
        assert_eq!(receipt.revision, "3");
        assert_eq!(
            (
                receipt.removed_titles,
                receipt.removed_files,
                receipt.removed_favorites,
                receipt.cleared_progress
            ),
            (1, 2, 1, 1)
        );
        assert!(verify_live(&c, &selected, &captured).is_err());
        assert!(removed(&c, "title", &title_ref).unwrap());
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM archive_title_v1 WHERE item_id='other'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM unrelated_station", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let noop = remove(
            &mut c,
            &RemovalScope::TitleRef(title_ref),
            None,
            "3",
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(noop.revision, "3");
        assert_eq!(noop.removed_files, 0);
        let receipt = commit(
            &mut c,
            "3",
            None,
            1,
            "query",
            true,
            step(vec![title("chosen", Some(1964), 99)]),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(receipt.admitted, 0);
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM archive_title_v1 WHERE item_id='chosen'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
    #[test]
    fn archive_user_file_removal_preserves_siblings_preferences_and_scope() {
        let mut c = database();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![title("chosen", Some(1964), 1)]),
            &mut || Ok(()),
        )
        .unwrap();
        let title_ref = opaque(&["archive-item-v1", "chosen"]);
        let file = opaque(&["archive-file-v1", "chosen", "one.mp4"]);
        set_favorite(
            &mut c,
            &FavoriteRequest {
                schema_version: 1,
                request_id: "fixture".into(),
                title_ref: title_ref.clone(),
                expected_revision: "1".into(),
                value: true,
            },
            &mut || Ok(()),
        )
        .unwrap();
        assert!(
            matches!(remove(&mut c,&RemovalScope::FileRef(file.clone()),Some(&"b".repeat(64)),"2",&mut ||Ok(())),Err(e) if e=="archive-removal-scope-invalid")
        );
        assert_eq!(current(&c).unwrap(), 2);
        let receipt = remove(
            &mut c,
            &RemovalScope::FileRef(file.clone()),
            Some(&title_ref),
            "2",
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(
            (
                receipt.removed_files,
                receipt.removed_titles,
                receipt.removed_favorites
            ),
            (1, 0, 0)
        );
        assert!(c
            .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        commit(
            &mut c,
            "3",
            None,
            1,
            "query",
            true,
            step(vec![title("chosen", Some(1964), 1)]),
            &mut || Ok(()),
        )
        .unwrap();
        assert!(resolve(&c, &file, "4").is_err());
        assert!(resolve(&c, &opaque(&["archive-file-v1", "chosen", "two.mp4"]), "4").is_ok());
        let noop = remove(
            &mut c,
            &RemovalScope::FileRef(file),
            Some(&title_ref),
            "4",
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(noop.revision, "4");
        assert_eq!(noop.removed_files, 0);
    }
    #[test]
    fn archive_discovery_does_not_report_admission_when_all_files_were_user_removed() {
        let mut c = database();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![title("chosen", Some(1964), 1)]),
            &mut || Ok(()),
        )
        .unwrap();
        let title_ref = opaque(&["archive-item-v1", "chosen"]);
        remove(
            &mut c,
            &RemovalScope::FileRef(opaque(&["archive-file-v1", "chosen", "one.mp4"])),
            Some(&title_ref),
            "1",
            &mut || Ok(()),
        )
        .unwrap();
        remove(
            &mut c,
            &RemovalScope::FileRef(opaque(&["archive-file-v1", "chosen", "two.mp4"])),
            Some(&title_ref),
            "2",
            &mut || Ok(()),
        )
        .unwrap();
        let receipt = commit(
            &mut c,
            "3",
            None,
            1,
            "query",
            true,
            step(vec![title("chosen", Some(1964), 1)]),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(receipt.admitted, 0);
        assert_eq!(receipt.title_count, 0);
        let mut partial = title("chosen", Some(1964), 1);
        partial.partial = Some(page(64, None));
        partial.files[0].provider_index = Some(0);
        partial.files[1].provider_index = Some(1);
        let receipt = commit(
            &mut c,
            "4",
            None,
            1,
            "query",
            true,
            step(vec![partial]),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(receipt.pending_file_pages[0].available_file_count, 0);
        assert_eq!(
            receipt.admitted, 0,
            "pending metadata with only removed files is not playable admission"
        );
    }
    #[test]
    fn archive_user_removal_cancel_and_stale_revision_leave_all_choices_unchanged() {
        let mut c = database();
        let mut chosen = title("chosen", Some(1964), 1);
        chosen.partial = Some(page(64, None));
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![chosen]),
            &mut || Ok(()),
        )
        .unwrap();
        let reference = opaque(&["archive-item-v1", "chosen"]);
        let scope = RemovalScope::TitleRef(reference);
        assert!(
            matches!(remove(&mut c,&scope,None,"0",&mut ||Ok(())),Err(e) if e=="archive-revision-stale")
        );
        let mut checks = 0;
        assert!(remove(&mut c, &scope, None, "1", &mut || {
            checks += 1;
            if checks == 2 {
                Err("canceled".into())
            } else {
                Ok(())
            }
        })
        .is_err());
        assert_eq!(current(&c).unwrap(), 1);
        assert_eq!(file_progress(&c, "chosen").unwrap().available_file_count, 2);
        assert_eq!(
            c.query_row("SELECT count(*) FROM archive_removal_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let mut checks = 0;
        assert!(remove(&mut c, &RemovalScope::All, None, "1", &mut || {
            checks += 1;
            if checks == 4 {
                Err("canceled".into())
            } else {
                Ok(())
            }
        })
        .is_err());
        assert_eq!(current(&c).unwrap(), 1);
        assert_eq!(file_progress(&c, "chosen").unwrap().next_offset, 64);
        let receipt = remove(&mut c, &RemovalScope::All, None, "1", &mut || Ok(())).unwrap();
        assert_eq!(receipt.revision, "2");
        assert_eq!(
            (
                receipt.removed_titles,
                receipt.removed_files,
                receipt.cleared_progress
            ),
            (1, 2, 2)
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM unrelated_station", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            remove(&mut c, &RemovalScope::All, None, "2", &mut || Ok(()))
                .unwrap()
                .revision,
            "3"
        );
        assert!(
            matches!(commit(&mut c,"2",None,1,"query",true,step(vec![title("stale",Some(1964),1)]),&mut ||Ok(())),Err(e) if e=="archive-revision-stale")
        );
    }
    #[test]
    fn archive_schema14_backed_migration_preserves_actual_schema13_library_and_live_data() {
        let root = tempfile::tempdir().unwrap();
        let store = crate::storage_transaction::PairStore::new(root.path().to_path_buf()).unwrap();
        let sources = serde_json::json!([{"id":"source","name":"Fixture","location":"fixture.m3u","kind":"file"}]);
        let catalog=serde_json::json!({"schemaVersion":1,"sources":sources,"channels":[{"id":"live","sourceId":"source","name":"Live fixture","category":"News","urls":["https://example.invalid/live"]}]}).to_string();
        let preferences=serde_json::json!({"schemaVersion":1,"sources":sources,"favorites":["live"],"removedChannels":["missing-live"],"volume":0.5,"muted":false,"panelWidth":300.0}).to_string();
        store.write_pair(&catalog, &preferences).unwrap();
        let live = store.read_snapshot().unwrap();
        store.with_guide_write(|c|{let mut chosen=title("chosen",Some(1964),1);chosen.partial=Some(page(64,None));commit(c,"0",None,1,"query",false,step(vec![chosen]),&mut ||Ok(()))?;set_favorite(c,&FavoriteRequest {schema_version:1,request_id:"fixture".into(),title_ref:opaque(&["archive-item-v1","chosen"]),expected_revision:"1".into(),value:true},&mut ||Ok(()))?;
            c.execute_batch("INSERT INTO guide_source(id,name,location,kind,allow_http,revision,updated_ms,published_revision) VALUES('guide','Fixture','https://example.invalid/guide','url',0,1,1000,1);INSERT INTO guide_channel VALUES('guide','xmlid','[\"Fixture\"]','fixture');INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,search_text) VALUES('guide',0,'xmlid',1000,2000,'Fixture program','fixture program');DROP TABLE public_archive_variant_v1;DROP TABLE public_archive_item_v1;DROP TABLE public_archive_preference_v1;DROP TABLE public_archive_removal_v1;DROP TABLE public_archive_checkpoint_v1;DROP TABLE archive_bookmark_v1;DROP TABLE archive_bookmark_meta_v1;DROP TABLE archive_removal_v1;PRAGMA user_version=13;").map_err(|_|"fixture-failed".to_owned())?;Ok(())}).unwrap();
        drop(store);
        let reopened =
            crate::storage_transaction::PairStore::new(root.path().to_path_buf()).unwrap();
        let after = reopened.read_snapshot().unwrap();
        assert_eq!(after.pair.catalog, live.pair.catalog);
        assert_eq!(after.pair.preferences, live.pair.preferences);
        assert_eq!(after.catalog_revision, live.catalog_revision);
        reopened
            .with_guide_read(|c| {
                assert_eq!(
                    c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                        .unwrap(),
                    16
                );
                assert_eq!(current(c).unwrap(), 2);
                assert_eq!(file_progress(c, "chosen").unwrap().next_offset, 64);
                assert!(c
                    .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
                        .get::<_, bool>(0))
                    .unwrap());
                assert_eq!(
                    c.query_row("SELECT count(*) FROM guide_program", [], |r| r
                        .get::<_, i64>(0))
                        .unwrap(),
                    1
                );
                Ok(())
            })
            .unwrap();
        let backup = Connection::open(root.path().join("genx.sqlite3.backup")).unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            13
        );
        assert_eq!(current(&backup).unwrap(), 2);
        assert_eq!(
            backup
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name='archive_removal_v1'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        drop(backup);
        reopened
            .with_guide_write(|c| remove(c, &RemovalScope::All, None, "2", &mut || Ok(())))
            .unwrap();
        let cleared = reopened.read_snapshot().unwrap();
        assert_eq!(cleared.pair.catalog, live.pair.catalog);
        assert_eq!(cleared.pair.preferences, live.pair.preferences);
        reopened
            .with_guide_read(|c| {
                assert_eq!(
                    c.query_row("SELECT count(*) FROM guide_program", [], |r| r
                        .get::<_, i64>(0))
                        .unwrap(),
                    1
                );
                assert_eq!(current(c).unwrap(), 3);
                Ok(())
            })
            .unwrap();
    }
    #[test]
    fn archive_schema13_and14_missing_namespace_fail_without_fallback() {
        for version in [13, 14] {
            let root = tempfile::tempdir().unwrap();
            let store =
                crate::storage_transaction::PairStore::new(root.path().to_path_buf()).unwrap();
            drop(store);
            let c = Connection::open(root.path().join(crate::storage_transaction::DB)).unwrap();
            if version == 13 {
                c.execute_batch("DROP TABLE archive_removal_v1;DROP TABLE archive_item_progress_v1;PRAGMA user_version=13;").unwrap();
            } else {
                c.execute_batch("DROP TABLE archive_removal_v1;").unwrap();
            }
            drop(c);
            assert!(
                matches!(crate::storage_transaction::PairStore::new(root.path().to_path_buf()),Err(e) if e=="sqlite-incomplete-archive-schema")
            );
        }
    }
    #[test]
    fn archive_untitled_file_labels_are_actual_distinct_utf8_bounded_names() {
        let mut c = database();
        let mut record = title("labels", Some(1964), 1);
        let first = format!("{}/First recording.mp4", "界".repeat(230));
        let second = format!("{}/Second recording.mp4", "界".repeat(230));
        record.files[0].name = first.clone();
        record.files[1].name = second.clone();
        record.all_file_names = vec![first.clone(), second.clone()];
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![record]),
            &mut || Ok(()),
        )
        .unwrap();
        let request = FilesQuery {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: opaque(&["archive-item-v1", "labels"]),
            expected_revision: "1".into(),
            offset: 0,
            page_size: 50,
        };
        let reply = files(&c, &request, &mut || Ok(())).unwrap();
        assert_eq!(reply.files.len(), 2);
        assert_ne!(reply.files[0].title, reply.files[1].title);
        for file in &reply.files {
            assert!(file.title.len() <= 512);
            assert!(file.title.contains('…'));
            assert!(file.title.ends_with("recording.mp4"));
            assert!(std::str::from_utf8(file.title.as_bytes()).is_ok());
        }
        assert_eq!(reply.files[0].file_name, first);
        assert_eq!(reply.files[1].file_name, second);
        c.execute(
            "UPDATE archive_file_v1 SET file_title='Provider supplied title' WHERE file_name=?1",
            [&first],
        )
        .unwrap();
        assert_eq!(
            files(&c, &request, &mut || Ok(())).unwrap().files[0].title,
            "Provider supplied title"
        );
        assert_eq!(file_name_label("one.mp4"), "one.mp4");
    }
    #[test]
    fn archive_partial_pages_append_preserve_and_fence_without_absence_deletion() {
        let mut c = database();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![title("large", Some(1964), 1)]),
            &mut || Ok(()),
        )
        .unwrap();
        let mut first = title("large", Some(1964), 1);
        first.partial = Some(page(64, None));
        first.files.truncate(1);
        first.files[0].name = "page-one.mp4".into();
        first.files[0].provider_index = Some(0);
        first.all_file_names = vec!["page-one.mp4".into()];
        let receipt = commit(
            &mut c,
            "1",
            None,
            1,
            "query",
            true,
            step(vec![first]),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(receipt.confirmed_dead, 0);
        assert_eq!(receipt.pending_file_pages[0].next_offset, 64);
        assert_eq!(receipt.pending_file_pages[0].available_file_count, 3);
        let request = FileStepRequest {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: opaque(&["archive-item-v1", "large"]),
            expected_revision: "2".into(),
            expected_offset: 64,
            explicit_action: true,
            restart: false,
        };
        assert_eq!(item_prepare(&c, &request).unwrap().page.next_offset, 64);
        let mut second = title("large", Some(1964), 1);
        second.partial = Some(page(128, Some(64)));
        second.files.truncate(1);
        second.files[0].name = "page-two.mp4".into();
        second.files[0].provider_index = Some(64);
        second.all_file_names = vec!["page-two.mp4".into()];
        let mut prepared = step(vec![second]);
        prepared.item_page = true;
        let receipt = commit(&mut c, "2", None, 1, "unused", false, prepared, &mut || {
            Ok(())
        })
        .unwrap();
        assert_eq!(receipt.file_page_progress.unwrap().next_offset, 128);
        assert_eq!(receipt.files_admitted, 1);
        assert_eq!(receipt.confirmed_dead, 0);
        assert_eq!(file_progress(&c, "large").unwrap().available_file_count, 4);
        let mut stale = title("large", Some(1964), 1);
        stale.partial = Some(page(192, Some(64)));
        let mut prepared = step(vec![stale]);
        prepared.item_page = true;
        assert!(
            matches!(commit(&mut c,"3",None,1,"unused",false,prepared,&mut ||Ok(())),Err(e) if e=="archive-item-progress-stale")
        );
        assert_eq!(current(&c).unwrap(), 3);
        assert_eq!(file_progress(&c, "large").unwrap().next_offset, 128);
        let mut final_page = title("large", Some(1964), 1);
        final_page.partial = Some(page(2000, Some(128)));
        final_page.files.clear();
        final_page.all_file_names.clear();
        let mut prepared = step(vec![final_page]);
        prepared.item_page = true;
        let receipt = commit(&mut c, "3", None, 1, "unused", false, prepared, &mut || {
            Ok(())
        })
        .unwrap();
        assert!(receipt.file_page_progress.unwrap().complete);
        assert_eq!(receipt.confirmed_dead, 0);
        assert_eq!(file_progress(&c, "large").unwrap().available_file_count, 4);
        let query = FileProgressQuery {
            schema_version: 1,
            request_id: "fixture".into(),
            expected_revision: Some("4".into()),
            offset: 0,
            page_size: 50,
            query: String::new(),
            decade: None,
            favorites_only: false,
            language_mode: LanguageMode::All,
            content_type: ContentType::All,
        };
        assert_eq!(
            item_progress(&c, &query, &mut || Ok(()))
                .unwrap()
                .total_count,
            0
        );
    }
    #[test]
    fn archive_pending_zero_files_are_not_playable_and_cancel_rolls_back_progress() {
        let mut c = database();
        let mut pending = title("pending", Some(1964), 1);
        pending.partial = Some(page(64, None));
        pending.files.clear();
        pending.all_file_names.clear();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![pending]),
            &mut || Ok(()),
        )
        .unwrap();
        let q = Query {
            schema_version: 1,
            request_id: "fixture".into(),
            query: String::new(),
            expected_revision: Some("1".into()),
            offset: 0,
            page_size: 50,
            curated_only: false,
            decade: None,
            favorites_only: false,
            language_mode: LanguageMode::All,
            content_type: ContentType::All,
        };
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
        let p = FileProgressQuery {
            schema_version: 1,
            request_id: "fixture".into(),
            expected_revision: Some("1".into()),
            offset: 0,
            page_size: 50,
            query: String::new(),
            decade: Some(1960),
            favorites_only: false,
            language_mode: LanguageMode::All,
            content_type: ContentType::All,
        };
        let reply = item_progress(&c, &p, &mut || Ok(())).unwrap();
        assert_eq!(reply.items[0].available_file_count, 0);
        assert!(!reply.items[0].complete);
        let mut next = title("pending", Some(1964), 1);
        next.partial = Some(page(128, Some(64)));
        next.files[0].provider_index = Some(64);
        next.files[1].provider_index = Some(65);
        let mut prepared = step(vec![next]);
        prepared.item_page = true;
        let mut calls = 0;
        assert!(
            commit(&mut c, "1", None, 1, "unused", false, prepared, &mut || {
                calls += 1;
                if calls == 3 {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            })
            .is_err()
        );
        assert_eq!(current(&c).unwrap(), 1);
        assert_eq!(file_progress(&c, "pending").unwrap().next_offset, 64);
        assert_eq!(
            file_progress(&c, "pending").unwrap().available_file_count,
            0
        );
    }
    #[test]
    fn archive_curation_caps_distinct_provider_items_and_nests_episode_files() {
        let mut c = database();
        let titles = (0..12)
            .map(|i| title(&format!("item-{i:02}"), Some(1964), i))
            .collect();
        let receipt = commit(
            &mut c,
            "0",
            Some(1964),
            1,
            "query",
            false,
            step(titles),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(receipt.title_count, 10);
        assert_eq!(
            c.query_row("SELECT count(*) FROM archive_file_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            20
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM unrelated_station", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT min(downloads) FROM archive_title_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
    #[test]
    fn archive_explicit_search_retains_pre_decade_and_unknown_year() {
        let mut c = database();
        let receipt = commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![
                title("older", Some(1928), 1),
                title("unknown", None, 2),
            ]),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(receipt.title_count, 2);
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM archive_title_v1 WHERE curated=1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        let q = Query {
            schema_version: 1,
            request_id: "fixture".into(),
            query: String::new(),
            expected_revision: Some("1".into()),
            offset: 0,
            page_size: 50,
            curated_only: true,
            decade: None,
            favorites_only: false,
            language_mode: LanguageMode::All,
            content_type: ContentType::All,
        };
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
    }
    #[test]
    fn archive_structured_metadata_matches_fields_not_description_or_json_keys() {
        let mut c = database();
        let mut items = Vec::new();
        for (id, name, subject, description, language) in [
            ("title", "Classic Cartoon Collection", "", "", "eng"),
            ("subject", "Classic shorts", "animation", "", "English"),
            (
                "incidental",
                "News report",
                "",
                "A cartoon is mentioned here",
                "spa",
            ),
            ("substring", "Cartoonish commentary", "", "", ""),
            ("spanish", "Cartoons in Spanish", "cartoons", "", "spa"),
        ] {
            let mut t = title(id, Some(1964), 1);
            t.title = name.into();
            t.search_aliases = encode_search_metadata(&SearchMetadata {
                title: name.into(),
                subjects: subject.into(),
                description: description.into(),
                collections: "cartoons".into(),
                languages: if language.is_empty() {
                    vec![]
                } else {
                    vec![language.into()]
                },
                ..Default::default()
            })
            .unwrap();
            items.push(t);
        }
        commit(
            &mut c,
            "0",
            None,
            1,
            "Cartoon",
            false,
            step(items),
            &mut || Ok(()),
        )
        .unwrap();
        let page = query(&c, &search_query("Cartoon", "1"), &mut || Ok(())).unwrap();
        assert_eq!(page.total_count, 3);
        assert_eq!(page.items[0].match_basis, "title");
        assert!(page
            .items
            .iter()
            .any(|t| t.match_basis == "subject" && t.provider_languages == ["English"]));
        assert!(page
            .items
            .iter()
            .any(|t| t.provider_languages == ["spa"] && t.language_provenance == "provider-item"));
        assert!(query(&c, &search_query("languages", "1"), &mut || Ok(()))
            .unwrap()
            .items
            .is_empty());
        assert_eq!(
            query(&c, &search_query("", "1"), &mut || Ok(()))
                .unwrap()
                .total_count,
            5
        );
    }
    #[test]
    fn archive_metadata_envelope_is_bounded_and_legacy_stays_truthful() {
        assert_eq!(match_basis("", "cartoonish", "", "cartoon").unwrap(), None);
        assert_eq!(
            match_basis("", "gilligan island", "", "Gilligan").unwrap(),
            None
        );
        assert!(decode_search_metadata("@genx-search-v2:{broken}").is_err());
        let big = SearchMetadata {
            description: "x".repeat(16384),
            ..Default::default()
        };
        assert!(encode_search_metadata(&big).is_err());
        let data = SearchMetadata {
            series: "Gilligan Island".into(),
            description: "cartoons".into(),
            ..Default::default()
        };
        let encoded = encode_search_metadata(&data).unwrap();
        assert_eq!(
            match_basis("", &encoded, "", "Gilligan").unwrap(),
            Some("series")
        );
        assert_eq!(match_basis("", &encoded, "", "cartoons").unwrap(), None);
        assert_eq!(
            match_basis("", &encoded, "Gilligan_S01_E01.mp4", "Gilligan").unwrap(),
            Some("series")
        );
        assert_eq!(
            match_basis("", &encoded, "Pilot_Episode.mp4", "Pilot episode").unwrap(),
            Some("file")
        );
    }
    #[test]
    fn archive_structured_pending_pages_decode_actual_title_without_matching_json() {
        let mut c = database();
        let mut t = title("partial", Some(1964), 1);
        t.partial = Some(page(64, None));
        t.search_aliases = encode_search_metadata(&SearchMetadata {
            title: "Gilligan Island".into(),
            description: "cartoons".into(),
            ..Default::default()
        })
        .unwrap();
        commit(
            &mut c,
            "0",
            None,
            1,
            "Gilligan",
            false,
            step(vec![t]),
            &mut || Ok(()),
        )
        .unwrap();
        let q = FileProgressQuery {
            schema_version: 1,
            request_id: "fixture".into(),
            expected_revision: Some("1".into()),
            offset: 0,
            page_size: 50,
            query: "Gilligan".into(),
            decade: None,
            favorites_only: false,
            language_mode: LanguageMode::All,
            content_type: ContentType::All,
        };
        assert_eq!(
            item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
            1
        );
        let q = FileProgressQuery {
            query: "description".into(),
            ..q
        };
        assert_eq!(
            item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
            0
        );
    }
    #[test]
    fn archive_search_named_possessive_is_bounded_not_arbitrary_prefix() {
        assert_eq!(
            match_basis(
                "Gilligans Island 1.00",
                "",
                "GilligansIsland1.00.mp4",
                "Gilligan"
            )
            .unwrap(),
            Some("title")
        );
        assert_eq!(
            match_basis("Gilligan's Island", "", "", "Gilligan").unwrap(),
            Some("title")
        );
        assert_eq!(
            match_basis("Gilliganish parody", "", "", "Gilligan").unwrap(),
            None
        );
        assert_eq!(
            match_basis("Cartoonish commentary", "", "", "Cartoon").unwrap(),
            None
        );
        assert_ne!(
            search_scope_hash("Gilligan", None),
            opaque(&["archive-query-v3", "Gilligan", ""])
        );
    }
    #[test]
    fn archive_cartoon_subject_rejects_observed_youtube_category_boilerplate() {
        let mut c = database();
        let mut items = Vec::new();
        for (id, name, subject) in [
            (
                "vlog",
                "How Men's Circles Can Bring You Into Your Feelings",
                "Youtube;video;Film & Animation;",
            ),
            (
                "security",
                "AT&T ThreatTraq",
                "Youtube,video,Film & Animation",
            ),
            ("war", "Ukrainian war", "Youtube\nvideo\nFilm & Animation"),
            ("trailer", "MAGADAN trailer", "Film and Animation"),
            (
                "real",
                "Classic shorts",
                "Youtube;Film & Animation;Cartoons;",
            ),
            ("animation", "Classic shorts two", "Animation"),
        ] {
            let mut t = title(id, Some(1970), 1);
            t.title = name.into();
            t.search_aliases = encode_search_metadata(&SearchMetadata {
                title: name.into(),
                subjects: subject.into(),
                ..Default::default()
            })
            .unwrap();
            items.push(t);
        }
        commit(
            &mut c,
            "0",
            None,
            1,
            "Cartoon",
            false,
            step(items),
            &mut || Ok(()),
        )
        .unwrap();
        let result = query(&c, &search_query("Cartoon", "1"), &mut || Ok(())).unwrap();
        assert_eq!(result.total_count, 2);
        assert!(result.items.iter().all(|t| t.match_basis == "subject"));
        assert_eq!(
            query(&c, &search_query("", "1"), &mut || Ok(()))
                .unwrap()
                .total_count,
            6
        );
        assert_eq!(
            match_basis("Animated Classic", "", "", "Cartoon").unwrap(),
            Some("title")
        );
        assert!(subject_match("Film & Animation;Animated", "Cartoon"));
        assert!(!subject_match("Film & Animation;", "Cartoon"));
        assert_ne!(
            search_scope_hash("Cartoon", None),
            opaque(&["archive-query-fields-v4", "Cartoon", ""])
        );
    }
    #[test]
    fn archive_local_query_matches_subject_and_episode_filename_without_merging_items() {
        let mut c = database();
        let mut first = title("first", Some(1964), 1);
        first.search_aliases = encode_search_metadata(&SearchMetadata {
            title: first.title.clone(),
            subjects: "monster movies".into(),
            ..Default::default()
        })
        .unwrap();
        first.files[0].name = "Pilot episode.mp4".into();
        first.all_file_names[0] = "Pilot episode.mp4".into();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![first, title("second", Some(1964), 2)]),
            &mut || Ok(()),
        )
        .unwrap();
        let mut q = Query {
            schema_version: 1,
            request_id: "fixture".into(),
            query: "monster".into(),
            expected_revision: Some("1".into()),
            offset: 0,
            page_size: 50,
            curated_only: false,
            decade: None,
            favorites_only: false,
            language_mode: LanguageMode::All,
            content_type: ContentType::All,
        };
        let page = query(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(page.total_count, 1);
        assert_eq!(
            page.items[0].title_ref,
            opaque(&["archive-item-v1", "first"])
        );
        q.query = "pilot episode".into();
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 1);
        q.query = "identical".into();
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 2);
        q.expected_revision = Some("0".into());
        assert!(matches!(query(&c,&q,&mut || Ok(())),Err(e) if e=="archive-revision-stale"));
    }
    fn search_title(
        id: &str,
        name: &str,
        year: Option<i64>,
        downloads: i64,
        alias: &str,
    ) -> PreparedTitle {
        let mut t = title(id, year, downloads);
        t.title = name.into();
        t.search_aliases = encode_search_metadata(&SearchMetadata {
            title: name.into(),
            subjects: alias.into(),
            ..Default::default()
        })
        .unwrap();
        t
    }
    fn search_query(value: &str, revision: &str) -> Query {
        Query {
            schema_version: 1,
            request_id: "fixture".into(),
            query: value.into(),
            expected_revision: Some(revision.into()),
            offset: 0,
            page_size: 50,
            curated_only: false,
            decade: None,
            favorites_only: false,
            language_mode: LanguageMode::All,
            content_type: ContentType::All,
        }
    }
    fn refs(page: &Page) -> Vec<String> {
        page.items.iter().map(|t| t.title_ref.clone()).collect()
    }
    fn language_title(id: &str, name: &str, languages: &[&str], downloads: i64) -> PreparedTitle {
        let mut item = search_title(id, name, Some(1964), downloads, "");
        item.search_aliases = encode_search_metadata(&SearchMetadata {
            title: name.into(),
            languages: languages.iter().map(|s| (*s).into()).collect(),
            ..Default::default()
        })
        .unwrap();
        item
    }
    #[test]
    fn archive_language_dto_default_and_invalid_modes_are_explicit() {
        let value = serde_json::json!({"schemaVersion":1,"requestId":"fixture","query":"","expectedRevision":null,"offset":0,"pageSize":50});
        assert_eq!(
            serde_json::from_value::<Query>(value.clone())
                .unwrap()
                .language_mode,
            LanguageMode::All
        );
        assert_eq!(
            serde_json::from_value::<FileProgressQuery>(value.clone())
                .unwrap()
                .language_mode,
            LanguageMode::All
        );
        for (mode, expected) in [
            ("all", LanguageMode::All),
            ("english-first", LanguageMode::EnglishFirst),
            ("english", LanguageMode::English),
            ("unlisted", LanguageMode::Unlisted),
        ] {
            let mut request = value.clone();
            request["languageMode"] = mode.into();
            assert_eq!(
                serde_json::from_value::<Query>(request.clone())
                    .unwrap()
                    .language_mode,
                expected
            );
            assert_eq!(
                serde_json::from_value::<FileProgressQuery>(request)
                    .unwrap()
                    .language_mode,
                expected
            );
        }
        for invalid in [
            serde_json::json!("English"),
            serde_json::json!("en"),
            serde_json::json!(""),
            serde_json::Value::Null,
            serde_json::json!(4),
        ] {
            let mut request = value.clone();
            request["languageMode"] = invalid;
            assert!(serde_json::from_value::<Query>(request.clone()).is_err());
            assert!(serde_json::from_value::<FileProgressQuery>(request).is_err());
        }
    }
    #[test]
    fn archive_language_claim_aliases_do_not_guess_audio_or_country() {
        for label in [
            "en",
            "eng",
            "English",
            " ENGLISH ",
            "en-US",
            "en-GB",
            "en-Latn-US",
            "EN-au",
            "en-001",
        ] {
            assert_eq!(provider_language_rank(&[label.into()]), 0, "{label}");
        }
        for label in [
            "und",
            "unknown",
            "US",
            "GB",
            "United States",
            "United Kingdom",
            "English subtitles",
            "French and English",
            "en_uk",
            "english-US",
            "en-",
            "en-!",
            "en-US-",
            "en-notenglish",
        ] {
            assert_eq!(provider_language_rank(&[label.into()]), 2, "{label}");
        }
        assert_eq!(provider_language_rank(&[]), 1);
        assert_eq!(provider_language_rank(&["spa".into(), "en-GB".into()]), 0);
    }
    #[test]
    fn archive_language_filters_preserve_unknown_legacy_library_and_bookmarks() {
        let mut c = database();
        let mut legacy = title("legacy", Some(1964), 99);
        legacy.title = "English US England".into();
        legacy.search_aliases = "eng English US London".into();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![
                language_title("en-us", "US provider claim", &["en-US"], 1),
                language_title("en-gb", "UK provider claim", &["en-GB"], 2),
                language_title("mixed", "Multiple claims", &["spa", "eng"], 3),
                language_title("unknown", "English in title", &[], 4),
                language_title("und", "Unknown label", &["und"], 5),
                language_title("country", "English London", &["United Kingdom"], 6),
                legacy,
            ]),
            &mut || Ok(()),
        )
        .unwrap();
        let reference = opaque(&["archive-file-v1", "en-us", "one.mp4"]);
        c.execute(
            "UPDATE archive_file_v1 SET sha1=?1 WHERE file_ref=?2",
            params!["0123456789abcdef0123456789abcdef01234567", reference],
        )
        .unwrap();
        let file = resolve(&c, &reference, "1").unwrap();
        let proof = crate::archive_bookmarks::capture(&reference, &file).unwrap();
        let position = crate::archive_bookmarks::Position {
            position_ms: 12345,
            duration_ms: Some(60000),
            completed: false,
            observed_ms: 1000,
        };
        crate::archive_bookmarks::save(&mut c, &proof, "0", &position, || Ok(())).unwrap();
        let mut q = search_query("", "1");
        let before = refs(&query(&c, &q, &mut || Ok(())).unwrap());
        q.language_mode = LanguageMode::English;
        let english = query(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(english.total_count, 3);
        assert!(english
            .items
            .iter()
            .all(|t| t.language_provenance == "provider-item"));
        q.language_mode = LanguageMode::Unlisted;
        let unlisted = query(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(unlisted.total_count, 2);
        assert!(unlisted
            .items
            .iter()
            .all(|t| t.provider_languages.is_empty() && t.language_provenance == "unknown"));
        q.language_mode = LanguageMode::All;
        assert_eq!(refs(&query(&c, &q, &mut || Ok(())).unwrap()), before);
        assert_eq!(current(&c).unwrap(), 1);
        assert_eq!(
            c.query_row("SELECT count(*) FROM archive_file_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            14
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM unrelated_station", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            crate::archive_bookmarks::read(&c, &proof)
                .unwrap()
                .position
                .unwrap()
                .position_ms,
            12345
        );
    }
    #[test]
    fn archive_language_english_first_preserves_favorite_and_relevance_tiers() {
        let mut c = database();
        let mut subject = language_title("english-subject", "Other name", &["eng"], 100);
        subject.search_aliases = encode_search_metadata(&SearchMetadata {
            title: "Other name".into(),
            subjects: "Cartoon".into(),
            languages: vec!["eng".into()],
            ..Default::default()
        })
        .unwrap();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![
                language_title("favorite", "Cartoon extra", &["spa"], 1),
                language_title("exact", "Cartoon", &["spa"], 2),
                language_title("prefix-other", "Cartoon alpha", &["spa"], 3),
                language_title("prefix-unknown", "Cartoon beta", &[], 4),
                language_title("prefix-english", "Cartoon zeta", &["en"], 5),
                subject,
            ]),
            &mut || Ok(()),
        )
        .unwrap();
        set_favorite(
            &mut c,
            &FavoriteRequest {
                schema_version: 1,
                request_id: "fixture".into(),
                title_ref: opaque(&["archive-item-v1", "favorite"]),
                expected_revision: "1".into(),
                value: true,
            },
            &mut || Ok(()),
        )
        .unwrap();
        let mut q = search_query("Cartoon", "2");
        q.language_mode = LanguageMode::EnglishFirst;
        let expected = [
            "favorite",
            "exact",
            "prefix-english",
            "prefix-unknown",
            "prefix-other",
            "english-subject",
        ]
        .map(|id| opaque(&["archive-item-v1", id]));
        assert_eq!(refs(&query(&c, &q, &mut || Ok(())).unwrap()), expected);
        q.favorites_only = true;
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 1);
        q.language_mode = LanguageMode::English;
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
        assert!(c
            .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
    }
    #[test]
    fn archive_language_blank_browse_stable_pagination_keeps_original_tiebreaks() {
        let mut c = database();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![
                language_title("english-a", "Z title", &["en"], 5),
                language_title("english-b", "A title", &["English"], 5),
                language_title("english-c", "B title", &["eng"], 1),
                language_title("unlisted", "No claim", &[], 99),
                language_title("other", "Spanish", &["spa"], 100),
            ]),
            &mut || Ok(()),
        )
        .unwrap();
        let mut q = search_query("", "1");
        let old = refs(&query(&c, &q, &mut || Ok(())).unwrap());
        q.language_mode = LanguageMode::EnglishFirst;
        let expected = ["english-a", "english-b", "english-c", "unlisted", "other"]
            .map(|id| opaque(&["archive-item-v1", id]));
        assert_eq!(refs(&query(&c, &q, &mut || Ok(())).unwrap()), expected);
        q.page_size = 2;
        let mut paged = Vec::new();
        loop {
            let page = query(&c, &q, &mut || Ok(())).unwrap();
            assert_eq!(page.total_count, 5);
            paged.extend(refs(&page));
            if !page.more {
                break;
            }
            q.offset += page.items.len();
        }
        assert_eq!(paged, expected);
        q.offset = 0;
        q.page_size = 50;
        q.language_mode = LanguageMode::All;
        assert_eq!(refs(&query(&c, &q, &mut || Ok(())).unwrap()), old);
        q.decade = Some(1970);
        q.language_mode = LanguageMode::English;
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
    }
    #[test]
    fn archive_language_pending_pages_share_filters_ranking_and_pagination() {
        let mut c = database();
        let mut titles = vec![
            language_title("english", "Cartoon zeta", &["en-GB"], 1),
            language_title("unknown", "Cartoon beta", &[], 2),
            language_title("spanish", "Cartoon alpha", &["spa"], 3),
            language_title("exact", "Cartoon", &["spa"], 4),
        ];
        for item in &mut titles {
            item.partial = Some(page(64, None));
        }
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(titles),
            &mut || Ok(()),
        )
        .unwrap();
        let mut q = FileProgressQuery {
            schema_version: 1,
            request_id: "fixture".into(),
            expected_revision: Some("1".into()),
            offset: 0,
            page_size: 50,
            query: "Cartoon".into(),
            decade: None,
            favorites_only: false,
            language_mode: LanguageMode::English,
            content_type: ContentType::All,
        };
        assert_eq!(
            item_progress(&c, &q, &mut || Ok(())).unwrap().items[0].title_ref,
            opaque(&["archive-item-v1", "english"])
        );
        assert_eq!(
            item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
            1
        );
        q.language_mode = LanguageMode::Unlisted;
        assert_eq!(
            item_progress(&c, &q, &mut || Ok(())).unwrap().items[0].title_ref,
            opaque(&["archive-item-v1", "unknown"])
        );
        q.language_mode = LanguageMode::EnglishFirst;
        q.page_size = 1;
        let expected =
            ["exact", "english", "unknown", "spanish"].map(|id| opaque(&["archive-item-v1", id]));
        let mut actual = Vec::new();
        for offset in 0..4 {
            q.offset = offset;
            let reply = item_progress(&c, &q, &mut || Ok(())).unwrap();
            assert_eq!(reply.total_count, 4);
            assert_eq!(reply.more, offset < 3);
            actual.push(reply.items[0].title_ref.clone());
        }
        assert_eq!(actual, expected);
        q.offset = 0;
        q.decade = Some(1970);
        assert_eq!(
            item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
            0
        );
        q.decade = None;
        q.language_mode = LanguageMode::All;
        assert_eq!(
            item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
            4
        );
        assert_eq!(current(&c).unwrap(), 1);
    }
    #[test]
    fn archive_search_ranks_favorites_then_literal_title_matches_before_aliases() {
        let mut c = database();
        let phrase = "night of living dead";
        commit(
            &mut c,
            "0",
            None,
            1,
            phrase,
            false,
            step(vec![
                search_title(
                    "description",
                    "High Street Cemetery",
                    Some(1968),
                    900,
                    phrase,
                ),
                search_title(
                    "tokens",
                    "Night Living Dead: of Terror",
                    Some(1968),
                    800,
                    "",
                ),
                search_title(
                    "contains",
                    "Restored Night of Living Dead Feature",
                    Some(1968),
                    700,
                    "",
                ),
                search_title("prefix", "Night of Living Dead 4K", Some(1968), 600, ""),
                search_title("exact", "Night of Living Dead", Some(1968), 1, ""),
                search_title("favorite", "Monster Movie Night", Some(1968), 1000, phrase),
            ]),
            &mut || Ok(()),
        )
        .unwrap();
        set_favorite(
            &mut c,
            &FavoriteRequest {
                schema_version: 1,
                request_id: "fixture".into(),
                title_ref: opaque(&["archive-item-v1", "favorite"]),
                expected_revision: "1".into(),
                value: true,
            },
            &mut || Ok(()),
        )
        .unwrap();
        let q = search_query("  NIGHT  of Living DEAD  ", "2");
        let result = query(&c, &q, &mut || Ok(())).unwrap();
        let expected: Vec<_> = [
            "favorite",
            "exact",
            "prefix",
            "contains",
            "tokens",
            "description",
        ]
        .into_iter()
        .map(|id| opaque(&["archive-item-v1", id]))
        .collect();
        assert_eq!(refs(&result), expected);
        assert_eq!(result.total_count, 6);
        assert!(result.items[0].favorite);
        // Popularity rank remains source metadata, not the relevance position.
        assert_eq!(result.items[1].rank, 6);
        let mut paged = q;
        paged.page_size = 2;
        let mut actual = Vec::new();
        for offset in [0, 2, 4] {
            paged.offset = offset;
            let page = query(&c, &paged, &mut || Ok(())).unwrap();
            assert_eq!(page.total_count, 6);
            assert_eq!(page.more, offset < 4);
            actual.extend(refs(&page));
        }
        assert_eq!(actual, expected);
        paged.expected_revision = Some("1".into());
        assert!(
            matches!(query(&c, &paged, &mut || Ok(())), Err(e) if e == "archive-revision-stale")
        );
    }
    #[test]
    fn archive_search_blank_keeps_popularity_order_with_favorites_first_and_decade_scope() {
        let mut c = database();
        commit(
            &mut c,
            "0",
            Some(1968),
            1,
            "",
            false,
            step(vec![
                search_title("high", "Zulu", Some(1968), 300, ""),
                search_title("middle", "Alpha", Some(1968), 200, ""),
                search_title("favorite", "Low", Some(1968), 1, ""),
            ]),
            &mut || Ok(()),
        )
        .unwrap();
        commit(
            &mut c,
            "1",
            Some(1970),
            1,
            "",
            false,
            step(vec![search_title(
                "later",
                "Earlier Alphabet",
                Some(1970),
                9999,
                "",
            )]),
            &mut || Ok(()),
        )
        .unwrap();
        set_favorite(
            &mut c,
            &FavoriteRequest {
                schema_version: 1,
                request_id: "fixture".into(),
                title_ref: opaque(&["archive-item-v1", "favorite"]),
                expected_revision: "2".into(),
                value: true,
            },
            &mut || Ok(()),
        )
        .unwrap();
        let mut q = search_query("   ", "3");
        q.curated_only = true;
        let result = query(&c, &q, &mut || Ok(())).unwrap();
        let expected: Vec<_> = ["favorite", "high", "middle", "later"]
            .into_iter()
            .map(|id| opaque(&["archive-item-v1", id]))
            .collect();
        assert_eq!(refs(&result), expected);
        assert_eq!(
            result.items.iter().map(|t| t.rank).collect::<Vec<_>>(),
            [3, 1, 2, 1]
        );
        q.decade = Some(1970);
        let filtered = query(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(filtered.total_count, 1);
        assert_eq!(filtered.items[0].title_ref, expected[3]);
        q.favorites_only = true;
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
    }
    #[test]
    fn archive_search_unicode_punctuation_and_identity_ties_are_literal_and_stable() {
        let mut c = database();
        let punctuation = "%'_; DROP TABLE archive_title_v1; --";
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![
                search_title("unicode-b", "ÉCOLE du cinéma", Some(1964), 1, ""),
                search_title("unicode-a", "École du cinéma", Some(1964), 900, ""),
                search_title(
                    "unicode-description",
                    "Anthology",
                    Some(1964),
                    9999,
                    "école du cinéma",
                ),
                search_title("punctuation", punctuation, Some(1964), 2, ""),
            ]),
            &mut || Ok(()),
        )
        .unwrap();
        let result = query(
            &c,
            &search_query("E\u{301}COLE du CINE\u{301}MA", "1"),
            &mut || Ok(()),
        )
        .unwrap();
        let mut expected = [
            opaque(&["archive-item-v1", "unicode-a"]),
            opaque(&["archive-item-v1", "unicode-b"]),
        ];
        expected.sort();
        assert_eq!(&refs(&result)[..2], &expected);
        assert_eq!(result.total_count, 3);
        assert_eq!(
            result.items[2].title_ref,
            opaque(&["archive-item-v1", "unicode-description"])
        );
        let literal = query(&c, &search_query(punctuation, "1"), &mut || Ok(())).unwrap();
        assert_eq!(literal.total_count, 1);
        assert_eq!(literal.items[0].title, punctuation);
        assert_eq!(
            c.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            4
        );
        let mut canceled = 0;
        assert!(query(&c, &search_query("école", "1"), &mut || {
            canceled += 1;
            Err("canceled".into())
        })
        .is_err());
        assert_eq!(canceled, 1);
    }
    #[test]
    fn archive_decade_and_favorites_filter_before_exact_count_and_page() {
        let mut c = database();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![
                title("sixties", Some(1969), 1),
                title("seventies", Some(1970), 2),
                title("unknown", None, 3),
                title("other-seventies", Some(1979), 4),
            ]),
            &mut || Ok(()),
        )
        .unwrap();
        let favorite = FavoriteRequest {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: opaque(&["archive-item-v1", "seventies"]),
            expected_revision: "1".into(),
            value: true,
        };
        assert_eq!(
            set_favorite(&mut c, &favorite, &mut || Ok(()))
                .unwrap()
                .revision,
            "2"
        );
        let mut q = Query {
            schema_version: 1,
            request_id: "fixture".into(),
            query: String::new(),
            expected_revision: Some("2".into()),
            offset: 0,
            page_size: 1,
            curated_only: false,
            decade: Some(1970),
            favorites_only: false,
            language_mode: LanguageMode::All,
            content_type: ContentType::All,
        };
        let page = query(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(page.total_count, 2);
        assert!(page.more);
        q.offset = 1;
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().items.len(), 1);
        q.offset = 0;
        q.favorites_only = true;
        let page = query(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(page.total_count, 1);
        assert!(page.items[0].favorite);
        assert_eq!(page.items[0].title_ref, favorite.title_ref);
        q.decade = Some(1960);
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
        q.favorites_only = false;
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 1);
        q.decade = Some(1950);
        assert!(query(&c, &q, &mut || Ok(())).is_err());
    }
    #[test]
    fn archive_favorite_cas_cancel_refresh_and_dead_tombstone_are_durable() {
        let mut c = database();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![title("chosen", Some(1964), 1)]),
            &mut || Ok(()),
        )
        .unwrap();
        let mut r = FavoriteRequest {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: opaque(&["archive-item-v1", "chosen"]),
            expected_revision: "1".into(),
            value: true,
        };
        assert_eq!(
            set_favorite(&mut c, &r, &mut || Ok(())).unwrap().revision,
            "2"
        );
        assert!(
            matches!(set_favorite(&mut c,&r,&mut ||Ok(())),Err(e) if e=="archive-revision-stale")
        );
        r.expected_revision = "2".into();
        assert_eq!(
            set_favorite(&mut c, &r, &mut || Ok(())).unwrap().revision,
            "2"
        );
        r.value = false;
        let mut calls = 0;
        assert!(set_favorite(&mut c, &r, &mut || {
            calls += 1;
            if calls == 2 {
                Err("canceled".into())
            } else {
                Ok(())
            }
        })
        .is_err());
        assert_eq!(current(&c).unwrap(), 2);
        assert!(c
            .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        let mut retry = step(Vec::new());
        retry.transient_failures = 1;
        retry.next_page = Some(1);
        commit(&mut c, "2", None, 1, "query", true, retry, &mut || Ok(())).unwrap();
        assert!(c
            .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        let mut refresh = step(vec![title("chosen", Some(1964), 99)]);
        refresh.observed_ms = 2_000_000;
        commit(&mut c, "3", None, 1, "query", true, refresh, &mut || Ok(())).unwrap();
        assert!(c
            .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        let mut dead = step(Vec::new());
        dead.deleted.push("chosen".into());
        commit(&mut c, "4", None, 1, "query", true, dead, &mut || Ok(())).unwrap();
        assert!(c
            .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        r.expected_revision = "5".into();
        assert_eq!(
            set_favorite(&mut c, &r, &mut || Ok(())).unwrap().revision,
            "6"
        );
        assert!(!c
            .query_row("SELECT favorite FROM archive_preferences_v1", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
    }
    #[test]
    fn archive_favorite_retains_playable_item_when_year_ranking_changes() {
        let mut c = database();
        commit(
            &mut c,
            "0",
            Some(1964),
            1,
            "query",
            false,
            step(vec![title("chosen", Some(1964), 1)]),
            &mut || Ok(()),
        )
        .unwrap();
        let r = FavoriteRequest {
            schema_version: 1,
            request_id: "fixture".into(),
            title_ref: opaque(&["archive-item-v1", "chosen"]),
            expected_revision: "1".into(),
            value: true,
        };
        set_favorite(&mut c, &r, &mut || Ok(())).unwrap();
        commit(
            &mut c,
            "2",
            Some(1964),
            1,
            "query",
            true,
            step(
                (0..10)
                    .map(|i| title(&format!("new-{i}"), Some(1964), 100 + i))
                    .collect(),
            ),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM archive_title_v1 WHERE curated=1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            10
        );
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM archive_file_v1 WHERE title_ref=?1",
                [&r.title_ref],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert!(!c
            .query_row(
                "SELECT curated FROM archive_title_v1 WHERE title_ref=?1",
                [&r.title_ref],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
    }
    #[test]
    fn archive_cancellation_rolls_back_catalog_and_progress() {
        let mut c = database();
        let mut calls = 0;
        let result = commit(
            &mut c,
            "0",
            Some(1964),
            1,
            "query",
            false,
            step(vec![title("held", Some(1964), 1)]),
            &mut || {
                calls += 1;
                if calls >= 3 {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
        );
        assert!(result.is_err());
        assert_eq!(current(&c).unwrap(), 0);
        assert_eq!(
            c.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM archive_progress_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn archive_transient_failure_keeps_last_good_files_and_retry_page() {
        let mut c = database();
        commit(
            &mut c,
            "0",
            Some(1964),
            1,
            "query",
            false,
            step(vec![title("retained", Some(1964), 1)]),
            &mut || Ok(()),
        )
        .unwrap();
        let mut failed = step(Vec::new());
        failed.transient_failures = 1;
        failed.next_page = Some(1);
        let receipt = commit(
            &mut c,
            "1",
            Some(1964),
            1,
            "query",
            true,
            failed,
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(receipt.title_count, 1);
        assert_eq!(receipt.confirmed_dead, 0);
        assert_eq!(receipt.next_page, Some(1));
        assert!(receipt.retry_after_ms.is_some());
        assert_eq!(
            c.query_row("SELECT count(*) FROM archive_file_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            prepare_at(&c, "2", 1964, 1, "query", false, 1_000_000),
            Err("archive-retry-not-due".into())
        );
    }
    #[test]
    fn archive_live_fence_ignores_unrelated_revision_and_refuses_changed_binding() {
        let mut c = database();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![title("selected", Some(1928), 1)]),
            &mut || Ok(()),
        )
        .unwrap();
        let reference = opaque(&["archive-file-v1", "selected", "one.mp4"]);
        let file = resolve(&c, &reference, "1").unwrap();
        commit(
            &mut c,
            "1",
            None,
            1,
            "other-query",
            false,
            step(vec![title("unrelated", None, 2)]),
            &mut || Ok(()),
        )
        .unwrap();
        assert!(verify_live(&c, &reference, &file).is_ok());
        c.execute(
            "UPDATE archive_file_v1 SET size_bytes='301' WHERE file_ref=?1",
            [&reference],
        )
        .unwrap();
        assert_eq!(
            verify_live(&c, &reference, &file),
            Err("archive-file-changed".into())
        );
        c.execute(
            "UPDATE archive_file_v1 SET eligible=0 WHERE file_ref=?1",
            [&reference],
        )
        .unwrap();
        assert_eq!(
            verify_live(&c, &reference, &file),
            Err("archive-file-unavailable".into())
        );
    }
    #[test]
    fn archive_complete_file_list_removes_only_confirmed_absent_copy() {
        let mut c = database();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![title("selected", None, 1)]),
            &mut || Ok(()),
        )
        .unwrap();
        let mut fresh = title("selected", None, 1);
        fresh.all_file_names = vec!["one.mp4".into()];
        fresh.files.truncate(1);
        let result = commit(
            &mut c,
            "1",
            None,
            1,
            "query",
            true,
            step(vec![fresh]),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(result.confirmed_dead, 1);
        assert_eq!(result.title_count, 1);
        assert_eq!(
            c.query_row("SELECT count(*) FROM archive_file_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    fn observed_search_metadata(raw: &str) -> SearchMetadata {
        let document: serde_json::Value = serde_json::from_str(raw).unwrap();
        let metadata = &document["metadata"];
        let field = |name: &str| match &metadata[name] {
            serde_json::Value::String(value) => value.clone(),
            serde_json::Value::Array(values) => values
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        SearchMetadata {
            title: field("title"),
            series: field("series"),
            subjects: field("subject"),
            collections: field("collection"),
            description: String::new(),
            languages: vec![],
            provider_type: String::new(),
            artwork: None,
        }
    }
    #[test]
    fn archive_observed_concert_cartoon_tag_is_not_animation_but_named_browse_remain() {
        let metadata = observed_search_metadata(include_str!("../../tests/fixtures/archive-search-metadata/kdhxmo-Opera_Bell_Band_50_000_000_Live_at_KDHX_7_20_21.json"));
        assert!(metadata.subjects.lines().any(|label| label == "cartoon"));
        let aliases = encode_search_metadata(&metadata).unwrap();
        for query in ["Cartoon", "cartoons", "animation", "animated"] {
            assert_eq!(
                match_basis(
                    &metadata.title,
                    &aliases,
                    "Opera_Bell_Band_50_000_000_Live_at_KDHX_7_20_21.mp4",
                    query
                )
                .unwrap(),
                None
            );
        }
        assert_eq!(
            match_basis(&metadata.title, &aliases, "", "Opera Bell Band").unwrap(),
            Some("title")
        );
        assert_eq!(
            match_basis(&metadata.title, &aliases, "", "").unwrap(),
            Some("browse")
        );
        assert_eq!(
            match_basis("Cartoonish commentary", "", "", "Cartoon").unwrap(),
            None
        );
        let only_style = SearchMetadata {
            title: metadata.title.clone(),
            subjects: "cartoon".into(),
            ..Default::default()
        };
        let style_aliases = encode_search_metadata(&only_style).unwrap();
        assert_eq!(
            match_basis(&only_style.title, &style_aliases, "", "Cartoon").unwrap(),
            None
        );
        assert_eq!(
            match_basis("", &style_aliases, "", "Cartoon").unwrap(),
            None,
            "pending suggestions retain the actual live-performance title context"
        );
        let animated = SearchMetadata {
            title: "Animated concert".into(),
            subjects: "music video\nAnimation".into(),
            ..Default::default()
        };
        let aliases = encode_search_metadata(&animated).unwrap();
        assert_eq!(
            match_basis("", &aliases, "", "Cartoon").unwrap(),
            Some("title"),
            "pending metadata follows the same actual-title evidence"
        );
    }
    #[test]
    fn archive_observed_title_keywords_cannot_override_incidental_context() {
        let concert = observed_search_metadata(include_str!("../../tests/fixtures/archive-search-metadata/mmtvnh-Merrimack_Middle_School_Band_-_Cartoon_Symphony_2023.json"));
        let alias = encode_search_metadata(&concert).unwrap();
        assert_eq!(
            match_basis(&concert.title, &alias, "Cartoon.mp4", "Cartoon").unwrap(),
            None
        );
        assert_eq!(
            match_basis("", &alias, "", "Cartoon").unwrap(),
            None,
            "pending predicate"
        );
        assert_eq!(
            match_basis(&concert.title, &alias, "", "Merrimack Middle School Band").unwrap(),
            Some("title")
        );
        assert_eq!(
            match_basis(&concert.title, &alias, "", "").unwrap(),
            Some("browse")
        );
        assert_eq!(
            match_basis(&concert.title, &alias, "", "concert").unwrap(),
            Some("subject"),
            "explicit context searches remain supported"
        );
        let animated = observed_search_metadata(include_str!(
            "../../tests/fixtures/archive-search-metadata/GrooviesMusicalEvolution.json"
        ));
        assert_eq!(
            match_basis(
                &animated.title,
                &encode_search_metadata(&animated).unwrap(),
                "",
                "Cartoon"
            )
            .unwrap(),
            Some("title"),
            "corroborated animation is not excluded merely for music"
        );
        for (raw, specific) in [
            (include_str!("../../tests/fixtures/archive-search-metadata/gtv16nm-El_Camino_-_A_Breaking_Bad_Movie_An_Interview_with_Vince_Gilligan_from_the_KiMo_Theatre.json"), "Vince Gilligan"),
            (include_str!("../../tests/fixtures/archive-search-metadata/Humane_Society_of_St._Lucie_County_Adopt-a-Pet_-_Gilligan.json"), "Adopt a Pet Gilligan"),
            (include_str!("../../tests/fixtures/archive-search-metadata/JamusUnpluggedLiveGilligansBarAndGrillJanuary112019.json"), "Jamus Unplugged"),
        ] {
            let m = observed_search_metadata(raw);
            let alias = encode_search_metadata(&m).unwrap();
            assert_eq!(match_basis(&m.title, &alias, "Gilligan.mp4", "Gilligan").unwrap(), None, "{}", m.title);
            assert_eq!(match_basis("", &alias, "", "Gilligan").unwrap(), None, "pending {}", m.title);
            assert_eq!(match_basis(&m.title, &alias, "", specific).unwrap(), Some("title"));
            assert_eq!(match_basis(&m.title, &alias, "", "").unwrap(), Some("browse"));
        }
    }
    #[test]
    fn archive_observed_type_classifier_is_shared_not_a_collection_or_title_guess() {
        for (raw, expected) in [
            (include_str!("../../tests/fixtures/archive-search-metadata/GilligansIsland1.00.json"), ContentType::Tv),
            (include_str!("../../tests/fixtures/archive-search-metadata/thenewadventuresofgilligans1.json"), ContentType::Tv),
            (include_str!("../../tests/fixtures/archive-search-metadata/NightOfTheLivingDead-MPEG.json"), ContentType::Movie),
            (include_str!("../../tests/fixtures/archive-search-metadata/mmtvnh-Merrimack_Middle_School_Band_-_Cartoon_Symphony_2023.json"), ContentType::Unknown),
        ] {
            assert_eq!(content_type(Some(&observed_search_metadata(raw))), expected);
        }
        for collections in [
            "opensource_movies\ncommunity",
            "television\ncommunity_media",
            "animationandcartoons",
            "my_feature_films",
        ] {
            assert_eq!(
                content_type(Some(&SearchMetadata {
                    collections: collections.into(),
                    ..Default::default()
                })),
                ContentType::Unknown
            );
        }
        assert_eq!(
            content_type(Some(&SearchMetadata {
                collections: "classic_tv\nfeature_films".into(),
                ..Default::default()
            })),
            ContentType::Unknown
        );
    }
    #[test]
    fn archive_observed_animation_taxonomy_and_subjects_are_genre_not_playability_proof() {
        for (raw, expected) in [
            (include_str!("../../tests/fixtures/archive-search-metadata/Popeye_forPresident.json"), "subject"),
            (include_str!("../../tests/fixtures/archive-search-metadata/BettyBoopCartoons.json"), "title"),
            (include_str!("../../tests/fixtures/archive-search-metadata/BugsBunnyCaseOfTheMissingHare.json"), "genre"),
        ] {
            let metadata = observed_search_metadata(raw);
            let aliases = encode_search_metadata(&metadata).unwrap();
            assert_eq!(match_basis(&metadata.title, &aliases, "", "Cartoon").unwrap(), Some(expected), "{}", metadata.title);
            assert_eq!(match_basis(&metadata.title, &aliases, "", "Gilligan").unwrap(), None);
        }
        let metadata = SearchMetadata {
            title: "Unrelated record".into(),
            collections: "cartoon\nmy_animationandcartoons".into(),
            description: "Cartoon animation".into(),
            ..Default::default()
        };
        assert_eq!(
            match_basis(
                &metadata.title,
                &encode_search_metadata(&metadata).unwrap(),
                "",
                "Cartoon"
            )
            .unwrap(),
            None
        );
    }
    fn discovery_view(language_mode: LanguageMode) -> DiscoveryView {
        DiscoveryView {
            schema_version: 1,
            language_mode,
            content_type: ContentType::All,
            favorites_only: false,
            curated_only: false,
        }
    }
    #[test]
    fn archive_visible_yield_counts_new_full_snapshot_identities_not_admissions_or_first_page() {
        let mut c = database();
        let initial: Vec<_> = (0..60)
            .map(|index| {
                language_title(
                    &format!("old{index:02}"),
                    &format!("Gilligan {index:02}"),
                    &["eng"],
                    1,
                )
            })
            .collect();
        let legacy = commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(initial),
            &mut || Ok(()),
        )
        .unwrap();
        assert!(
            serde_json::to_value(legacy)
                .unwrap()
                .get("newVisibleMatches")
                .is_none(),
            "legacy receipt shape unchanged"
        );
        let english = discovery_view(LanguageMode::English);
        let receipt = commit_view(
            &mut c,
            "1",
            None,
            1,
            "query",
            true,
            step(vec![language_title("old00", "Gilligan 00", &["eng"], 1)]),
            Some(("Gilligan", None, &english)),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(
            (receipt.admitted, receipt.new_visible_matches),
            (1, Some(0))
        );
        let receipt = commit_view(
            &mut c,
            "2",
            None,
            1,
            "query",
            true,
            step(vec![language_title(
                "foreign",
                "Gilligan foreign",
                &["spa"],
                1,
            )]),
            Some(("Gilligan", None, &english)),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(
            (receipt.admitted, receipt.new_visible_matches),
            (1, Some(0))
        );
        let receipt = commit_view(
            &mut c,
            "3",
            None,
            1,
            "query",
            true,
            step(vec![language_title(
                "new",
                "Gilligan ZZZ beyond first fifty",
                &["en-GB"],
                1,
            )]),
            Some(("Gilligan", None, &english)),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(receipt.new_visible_matches, Some(1));
        let mut q = search_query("Gilligan", "4");
        q.language_mode = LanguageMode::English;
        let first = query(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(first.total_count, 61);
        assert!(!first.items.iter().any(|item| item.title.contains("ZZZ")));
        let mut replacement = step(vec![language_title(
            "replacement",
            "Gilligan replacement",
            &["English"],
            1,
        )]);
        replacement.deleted.push("new".into());
        let receipt = commit_view(
            &mut c,
            "4",
            None,
            1,
            "query",
            true,
            replacement,
            Some(("Gilligan", None, &english)),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(
            receipt.new_visible_matches,
            Some(1),
            "equal total count is not equal identity set"
        );
        assert_eq!(
            query(
                &c,
                &Query {
                    expected_revision: Some("5".into()),
                    ..q
                },
                &mut || Ok(())
            )
            .unwrap()
            .total_count,
            61
        );
    }
    #[test]
    fn archive_visible_yield_uses_decade_favorites_curation_and_exact_language_filters() {
        for (language, decade, favorite_only, curated_only, expected) in [
            (LanguageMode::English, None, false, false, 0),
            (LanguageMode::Unlisted, None, false, false, 1),
            (LanguageMode::EnglishFirst, None, false, false, 1),
            (LanguageMode::All, Some(1970), false, false, 0),
            (LanguageMode::All, None, true, false, 0),
            (LanguageMode::All, None, false, true, 0),
        ] {
            let mut c = database();
            let view = DiscoveryView {
                favorites_only: favorite_only,
                curated_only,
                ..discovery_view(language)
            };
            let receipt = commit_view(
                &mut c,
                "0",
                None,
                1,
                "query",
                false,
                step(vec![language_title("new", "Gilligan", &[], 1)]),
                Some(("Gilligan", decade, &view)),
                &mut || Ok(()),
            )
            .unwrap();
            assert_eq!(receipt.new_visible_matches, Some(expected));
            assert_eq!(receipt.admitted, 1);
        }
    }
    #[test]
    fn archive_visible_yield_cancel_stale_invalid_view_roll_back_catalog_and_cursor() {
        let mut c = database();
        let view = discovery_view(LanguageMode::All);
        assert!(commit_view(
            &mut c,
            "1",
            None,
            1,
            "query",
            false,
            step(vec![]),
            Some(("Gilligan", None, &view)),
            &mut || Ok(())
        )
        .is_err());
        let invalid = DiscoveryView {
            schema_version: 2,
            ..discovery_view(LanguageMode::All)
        };
        assert!(commit_view(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![]),
            Some(("Gilligan", None, &invalid)),
            &mut || Ok(())
        )
        .is_err());
        let mut checks = 0;
        assert!(commit_view(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![language_title("new", "Gilligan", &["eng"], 1)]),
            Some(("Gilligan", None, &view)),
            &mut || {
                checks += 1;
                if checks >= 5 {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            }
        )
        .is_err());
        assert_eq!(current(&c).unwrap(), 0);
        assert_eq!(
            c.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM archive_progress_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn archive_content_types_are_grounded_claims_conflicts_and_legacy_stay_unknown() {
        for (claim, expected) in [
            ("Classic TV", ContentType::Tv),
            ("TV Series", ContentType::Tv),
            ("Feature film", ContentType::Movie),
            ("Short film", ContentType::Short),
            ("animated shorts", ContentType::Short),
            ("movie trailer", ContentType::Unknown),
            ("movies\nclassic tv", ContentType::Unknown),
            ("", ContentType::Unknown),
        ] {
            let m = SearchMetadata {
                subjects: claim.into(),
                ..Default::default()
            };
            assert_eq!(content_type(Some(&m)), expected, "{claim}");
        }
        assert_eq!(content_type(None), ContentType::Unknown);
        let mut c = database();
        let mut item = title("unknown", Some(2024), 1);
        item.kind = "movie";
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![item]),
            &mut || Ok(()),
        )
        .unwrap();
        let result = query(&c, &search_query("", "1"), &mut || Ok(())).unwrap();
        assert_eq!(result.items[0].content_type, ContentType::Unknown);
        assert_eq!(result.items[0].content_type_provenance, "unknown");
        assert!(result.items[0].artwork.is_none());
    }
    #[test]
    fn archive_modern_browse_years_filter_before_paging_without_expanding_curation() {
        let mut c = database();
        let items = [1964, 2004, 2014, 2024, 2035, 2100]
            .into_iter()
            .map(|year| title(&format!("year{year}"), Some(year), 1))
            .collect();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(items),
            &mut || Ok(()),
        )
        .unwrap();
        for (decade, expected) in [(1960, 1), (2000, 1), (2010, 1), (2020, 3)] {
            let mut q = search_query("", "1");
            q.decade = Some(decade);
            q.page_size = 1;
            let first = query(&c, &q, &mut || Ok(())).unwrap();
            assert_eq!(first.total_count, expected);
            if decade == 2020 {
                q.offset = 2;
                assert_eq!(
                    query(&c, &q, &mut || Ok(())).unwrap().items[0].release_year,
                    Some(2100)
                );
            }
            q.curated_only = true;
            q.offset = 0;
            assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 0);
        }
        let before = current(&c).unwrap();
        assert!(progress(
            &c,
            &ProgressQuery {
                schema_version: 1,
                request_id: "fixture".into(),
                query: "".into(),
                year: Some(2024),
                decade: Some(2020)
            }
        )
        .is_err());
        assert_eq!(current(&c).unwrap(), before);
    }
    #[test]
    fn archive_type_filter_controls_titles_pending_and_atomic_new_visible_yield() {
        let mut c = database();
        let mut item = language_title("new", "Gilligan", &["eng"], 1);
        item.search_aliases = encode_search_metadata(&SearchMetadata {
            title: "Gilligan".into(),
            subjects: "Classic TV".into(),
            ..Default::default()
        })
        .unwrap();
        item.partial = Some(page(64, None));
        item.files[0].provider_index = Some(0);
        item.files[1].provider_index = Some(1);
        let view = DiscoveryView {
            content_type: ContentType::Movie,
            ..discovery_view(LanguageMode::All)
        };
        let receipt = commit_view(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![item]),
            Some(("Gilligan", None, &view)),
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(receipt.new_visible_matches, Some(0));
        for (filter, expected) in [
            (ContentType::Tv, 1),
            (ContentType::Movie, 0),
            (ContentType::Unknown, 0),
            (ContentType::All, 1),
        ] {
            let mut q = search_query("Gilligan", "1");
            q.content_type = filter;
            assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, expected);
            let pending = FileProgressQuery {
                schema_version: 1,
                request_id: "fixture".into(),
                expected_revision: Some("1".into()),
                offset: 0,
                page_size: 50,
                query: "Gilligan".into(),
                decade: None,
                favorites_only: false,
                language_mode: LanguageMode::All,
                content_type: filter,
            };
            assert_eq!(
                item_progress(&c, &pending, &mut || Ok(()))
                    .unwrap()
                    .total_count,
                expected
            );
        }
    }
    #[test]
    fn archive_artwork_source_legacy_null_and_versioned_actual_proof_preserve_authority() {
        let mut c = database();
        commit(
            &mut c,
            "0",
            None,
            1,
            "query",
            false,
            step(vec![title("legacy", None, 1)]),
            &mut || Ok(()),
        )
        .unwrap();
        let reference = opaque(&["archive-item-v1", "legacy"]);
        assert_eq!(artwork_source(&c, &reference, "1").unwrap().0, "legacy");
        assert!(artwork_source(&c, &reference, "1").unwrap().1.is_none());
        assert!(artwork_source(&c, &reference, "0").is_err());
        let image = Artwork {
            item_id: "legacy".into(),
            file_name: "__ia_thumb.jpg".into(),
            size_bytes: "1330".into(),
            mime_type: "image/jpeg".into(),
            provider_sha1: None,
        };
        let metadata = SearchMetadata {
            artwork: Some(image.clone()),
            ..Default::default()
        };
        let encoded = encode_search_metadata(&metadata).unwrap();
        assert!(encoded.starts_with("@genx-search-v3:"));
        c.execute(
            "UPDATE archive_title_v1 SET search_text=?1 WHERE item_id='legacy'",
            [encoded],
        )
        .unwrap();
        assert!(artwork_source(&c, &reference, "1").unwrap().1 == Some(image));
        let legacy="@genx-search-v2:{\"title\":\"Legacy\",\"series\":\"\",\"subjects\":\"\",\"collections\":\"\",\"description\":\"\",\"languages\":[]}";
        assert!(decode_search_metadata(legacy)
            .unwrap()
            .unwrap()
            .artwork
            .is_none());
        let bad = SearchMetadata {
            artwork: Some(Artwork {
                item_id: "legacy".into(),
                file_name: "../../secret".into(),
                size_bytes: "1".into(),
                mime_type: "image/jpeg".into(),
                provider_sha1: None,
            }),
            ..Default::default()
        };
        assert!(encode_search_metadata(&bad).is_err());
    }
    #[test]
    fn archive_relevance_v9_legacy_pet_keeps_saved_records_but_not_incidental_name_results() {
        let observed: serde_json::Value=serde_json::from_str(include_str!("../../tests/fixtures/archive-search-metadata/Humane_Society_of_St._Lucie_County_Adopt-a-Pet_-_Gilligan.json")).unwrap();
        let mut legacy = title("legacy-pet", Some(2014), 99);
        legacy.title = observed["metadata"]["title"].as_str().unwrap().into();
        // Old mixed aliases cannot establish any typed subject/language claim.
        legacy.search_aliases = "Gilligan cartoon eng television".into();
        let mut c = database();
        commit(
            &mut c,
            "0",
            None,
            1,
            "Gilligan",
            false,
            step(vec![
                legacy,
                language_title("show", "Gilligan's Island", &["eng"], 1),
            ]),
            &mut || Ok(()),
        )
        .unwrap();
        let reference = opaque(&["archive-item-v1", "legacy-pet"]);
        set_favorite(
            &mut c,
            &FavoriteRequest {
                schema_version: 1,
                request_id: "favorite".into(),
                title_ref: reference.clone(),
                expected_revision: "1".into(),
                value: true,
            },
            &mut || Ok(()),
        )
        .unwrap();
        let changes = c.total_changes();
        let p = query(&c, &search_query("Gilligan", "2"), &mut || Ok(())).unwrap();
        assert_eq!(refs(&p), vec![opaque(&["archive-item-v1", "show"])]);
        let blank = query(&c, &search_query("", "2"), &mut || Ok(())).unwrap();
        assert_eq!(blank.total_count, 2);
        let mut favorites = search_query("", "2");
        favorites.favorites_only = true;
        assert_eq!(
            refs(&query(&c, &favorites, &mut || Ok(())).unwrap()),
            vec![reference.clone()]
        );
        assert_eq!(
            refs(
                &query(&c, &search_query("Adopt a Pet Gilligan", "2"), &mut || Ok(
                    ()
                ))
                .unwrap()
            ),
            vec![reference]
        );
        assert_eq!(changes, c.total_changes());
        assert_eq!(current(&c).unwrap(), 2);
        assert_eq!(
            c.query_row("SELECT count(*) FROM archive_file_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            4
        );
    }
    #[test]
    fn archive_relevance_v9_equivalent_title_spellings_share_language_tier_before_paging() {
        let mut c = database();
        commit(
            &mut c,
            "0",
            None,
            1,
            "Gilligan Island",
            false,
            step(vec![
                language_title("spanish", "Gilligan Island", &["spa"], 1000),
                language_title("english-possessive", "Gilligan's Island", &["eng"], 1),
                language_title("english-plural", "Gilligans Island", &["English"], 2),
                language_title(
                    "english-unicode",
                    "Ｇｉｌｌｉｇａｎ’s　Ｉｓｌａｎｄ",
                    &["en-US"],
                    3,
                ),
            ]),
            &mut || Ok(()),
        )
        .unwrap();
        let mut q = search_query("Gilligan Island", "1");
        q.language_mode = LanguageMode::EnglishFirst;
        q.page_size = 1;
        let mut items = Vec::new();
        for offset in 0..4 {
            q.offset = offset;
            let p = query(&c, &q, &mut || Ok(())).unwrap();
            assert_eq!(p.total_count, 4);
            items.push(p.items.into_iter().next().unwrap());
        }
        assert!(items[..3]
            .iter()
            .all(|t| provider_language_rank(&t.provider_languages) == 0));
        assert_eq!(items[3].title_ref, opaque(&["archive-item-v1", "spanish"]));
        q.offset = 0;
        q.page_size = 50;
        q.language_mode = LanguageMode::English;
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 3);
        q.language_mode = LanguageMode::All;
        assert_eq!(query(&c, &q, &mut || Ok(())).unwrap().total_count, 4);
    }
    #[test]
    fn archive_relevance_v9_public_and_legacy_predicates_keep_exact_named_context_choices() {
        use crate::archive_provider_contract::{Provider, ProviderItem};
        for (title, query, expected) in [
            ("Adopt-a-Pet: Gilligan", "Gilligan", None),
            (
                "Adopt-a-Pet: Gilligan",
                "Adopt a Pet Gilligan",
                Some("title"),
            ),
            ("Interview with Vince Gilligan", "Gilligan", None),
            (
                "Interview with Vince Gilligan",
                "Vince Gilligan",
                Some("title"),
            ),
            ("Gilligan's Island", "Gilligan Island", Some("title")),
            ("Gilliganville Island", "Gilligan Island", None),
        ] {
            let i = ProviderItem {
                provider: Provider::Loc,
                item_id: "fixture".into(),
                title: title.into(),
                source_url: "https://www.loc.gov/item/fixture/".into(),
                metadata_url: "https://www.loc.gov/item/fixture/?fo=json".into(),
                description: None,
                subjects: vec![],
                creators: vec![],
                languages: vec![],
                release_year: None,
                date_claims: None,
                content_type: "unknown".into(),
                rights: None,
                license_url: None,
                attribution: None,
                access_restricted: None,
                download_allowed: None,
                revision: None,
                variants: vec![],
            };
            assert_eq!(
                match_basis(title, "untrusted mixed cartoon English", "", query).unwrap(),
                expected,
                "legacy {query}: {title}"
            );
            assert_eq!(
                crate::archive_provider_catalog::matches(&i, query).unwrap(),
                expected,
                "public {query}: {title}"
            );
        }
    }
    #[test]
    fn archive_relevance_v9_search_scope_does_not_reuse_old_discovery_continuation() {
        assert_ne!(
            search_scope_hash("Gilligan", None),
            opaque(&["archive-query-fields-v8", "Gilligan", ""])
        );
    }
    #[test]
    fn archive_relevance_v9_word_boundaries_and_bounded_aliases_never_become_substring_stemming() {
        for title in [
            "Gilligan's Island",
            "Gilligans Island",
            "Ｇｉｌｌｉｇａｎ’s　Ｉｓｌａｎｄ",
            "Gilligan — Island",
        ] {
            for query in ["Gilligan Island", "Gilligan's Island", "Gilligans Island"] {
                assert_eq!(match_basis(title, "", "", query).unwrap(), Some("title"));
                assert_eq!(title_match_rank(title, query), 0, "{title}: {query}");
            }
        }
        for (title, query) in [
            ("Gilliganville Island", "Gilligan Island"),
            ("New", "News"),
            ("Mar", "Mars"),
            ("Bas", "Bass"),
            ("Time", "Timer"),
        ] {
            assert_eq!(
                match_basis(title, "", "", query).unwrap(),
                None,
                "{title}: {query}"
            );
        }
        assert_eq!(
            title_match_rank("Gilligan Island Remastered", "Gilligan Island"),
            1
        );
        assert_eq!(
            title_match_rank("Restored Gilligan Island Feature", "Gilligan Island"),
            2
        );
        assert_eq!(title_match_rank("Island of Gilligan", "Gilligan Island"), 3);
    }
    #[test]
    fn archive_relevance_v9_pending_legacy_titles_share_matching_and_preserve_read_cas_cancel() {
        let mut c = database();
        let mut pet = title("pet", None, 100);
        pet.title = "Adopt-a-Pet: Gilligan".into();
        pet.search_aliases = "old mixed Gilligan eng tv".into();
        pet.partial = Some(page(64, None));
        let mut show = title("show", None, 1);
        show.title = "Gilligan's Island".into();
        show.search_aliases = "untrusted flat descriptions".into();
        show.partial = Some(page(64, None));
        commit(
            &mut c,
            "0",
            None,
            1,
            "Gilligan",
            false,
            step(vec![pet, show]),
            &mut || Ok(()),
        )
        .unwrap();
        let mut q = FileProgressQuery {
            schema_version: 1,
            request_id: "pending".into(),
            expected_revision: Some("1".into()),
            offset: 0,
            page_size: 50,
            query: "Gilligan Island".into(),
            decade: None,
            favorites_only: false,
            language_mode: LanguageMode::All,
            content_type: ContentType::All,
        };
        let changes = c.total_changes();
        let p = item_progress(&c, &q, &mut || Ok(())).unwrap();
        assert_eq!(p.total_count, 1);
        assert_eq!(p.items[0].title_ref, opaque(&["archive-item-v1", "show"]));
        q.query = "Gilligan".into();
        assert_eq!(
            item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
            1
        );
        q.query = "Adopt a Pet Gilligan".into();
        assert_eq!(
            item_progress(&c, &q, &mut || Ok(())).unwrap().total_count,
            1
        );
        q.expected_revision = Some("0".into());
        assert!(matches!(item_progress(&c,&q,&mut||Ok(())),Err(e) if e=="archive-revision-stale"));
        q.expected_revision = Some("1".into());
        assert!(
            matches!(item_progress(&c,&q,&mut||Err("fixture-cancel".into())),Err(e) if e=="fixture-cancel")
        );
        assert_eq!(changes, c.total_changes());
        assert_eq!(current(&c).unwrap(), 1);
    }
}
