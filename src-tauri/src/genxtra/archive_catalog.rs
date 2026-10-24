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
pub(crate) fn current(c: &Connection) -> Result<i64, String> {
    sql(c.query_row(
        "SELECT revision FROM archive_catalog_meta_v1 WHERE singleton=1",
        [],
        |r| r.get(0),
    ))
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

// This module's parts, by area, are in archive_catalog/.
mod library_edits;
pub use library_edits::*;
mod search;
pub(crate) use search::*;
mod files;
pub use files::*;
mod file_steps;
pub use file_steps::*;
