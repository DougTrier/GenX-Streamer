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

//! Account-scoped COUNT/OFFSET metadata queries. No provider URLs are read.
//! Search deliberately uses SQLite ASCII lower/NOCASE literal substring rules;
//! it does not claim the public catalog's Unicode NFKC search semantics.
//! Account preferences are independent from canonical public-source preferences.
use crate::scan_manifest_work::{self, Context};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const ERR: &str = "account-catalog-query-invalid";
const LIMIT: usize = 1024 * 1024;
const MAX: i64 = 100_000;
pub(crate) const QUERY_VERSION: &str = "account-sqlite-ascii-v2";
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Sort {
    Source,
    Name,
    Category,
    /// Country (by official name, channels without one last), then group, then name.
    Country,
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Filter {
    #[default]
    All,
    News,
    Sports,
    Favorites,
    Movies,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Query {
    pub schema_version: u8,
    pub account_id: String,
    pub expected_account_revision: String,
    /// Only an initial offset-zero read may capture a previously unknown revision.
    pub expected_media_revision: Option<String>,
    /// Capture on an initial scope/reset read; every offset continuation is exact.
    pub expected_preferences_revision: Option<String>,
    pub query: String,
    pub category: Option<String>,
    #[serde(default)]
    pub filter: Filter,
    pub sort: Sort,
    #[serde(default = "favorites_first")]
    pub favorites_first: bool,
    /// An app country code, several joined by commas ("US,CA,UK", at most 64),
    /// or "" for channels whose country is unknown.
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub hide_adult: bool,
    pub start_index: usize,
    pub anchor_id: Option<String>,
    pub page_size: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    pub schema_version: u8,
    pub account_id: String,
    pub account_revision: String,
    pub media_revision: String,
    pub preferences_revision: String,
    pub query_version: &'static str,
    pub start_index: usize,
    pub anchor_index: Option<usize>,
    pub total: usize,
    pub items: Vec<Channel>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Channel {
    pub id: String,
    pub name: String,
    pub category: String,
    pub original_category: String,
    pub provider_id: Option<String>,
    pub epg_id: Option<String>,
    pub stream_reference: String,
    pub favorite: bool,
}
struct Snapshot {
    account_revision: i64,
    media_revision: i64,
    preferences_revision: i64,
}
fn favorites_first() -> bool {
    true
}
fn sql<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|error| {
        crate::storage_transaction::sql_error_code(&error, "account-catalog-query-storage-failed")
    })
}
fn opaque(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn scoped_id(value: &str, account: &str) -> bool {
    value
        .strip_prefix(&format!("account-{account}-"))
        .is_some_and(|id| {
            id.len() == 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}
fn revision(value: &str) -> Result<i64, String> {
    if value.is_empty()
        || value.len() > 19
        || value.starts_with('0')
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("account-revision-invalid".into());
    }
    value
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| "account-revision-invalid".into())
}
fn preferences_revision(value: &str) -> Result<i64, String> {
    if value == "0" {
        return Ok(0);
    }
    revision(value)
}
fn text(value: &str, max: usize, empty: bool) -> bool {
    value.len() <= max
        && (empty || !value.trim().is_empty())
        && !value.chars().any(char::is_control)
        && !value.contains("://")
}
fn validate(request: &Query) -> Result<(), String> {
    if request.schema_version != 1
        || !opaque(&request.account_id)
        || !text(&request.query, 256, true)
        || request
            .category
            .as_ref()
            .is_some_and(|v| !text(v, 16384, true))
        || request.start_index > MAX as usize
        || request.page_size == 0
        || request.page_size > 64
        || request.country.as_deref().is_some_and(|c| !country_code(c))
        || (request.start_index != 0 && request.expected_media_revision.is_none())
        || (request.start_index != 0 && request.expected_preferences_revision.is_none())
        || request
            .anchor_id
            .as_ref()
            .is_some_and(|id| !scoped_id(id, &request.account_id))
    {
        return Err(ERR.into());
    }
    revision(&request.expected_account_revision)?;
    if let Some(media) = &request.expected_media_revision {
        revision(media)?;
    }
    if let Some(preferences) = &request.expected_preferences_revision {
        preferences_revision(preferences)?;
    }
    Ok(())
}
/// "" (unknown), or 1 to 64 distinct codes of two capital letters joined by
/// commas; bound as a parameter, never placed in SQL text.
fn country_code(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let codes: Vec<&str> = value.split(',').collect();
    codes.len() <= 64
        && codes
            .iter()
            .all(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_uppercase()))
        && codes.iter().collect::<std::collections::HashSet<_>>().len() == codes.len()
}
/// SQL functions over a channel group: its app country code (NULL when not
/// reliably known) and that country's name for ordering. One resolver serves
/// filtering, sorting and the country summary alike.
pub(crate) fn register_functions(c: &Connection) -> Result<(), String> {
    use rusqlite::functions::FunctionFlags;
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    sql(
        c.create_scalar_function("genx_group_country", 1, flags, |ctx| {
            Ok(crate::group_country::group_country(&ctx.get::<String>(0)?))
        }),
    )?;
    sql(
        c.create_scalar_function("genx_group_country_name", 1, flags, |ctx| {
            Ok(crate::group_country::group_country(&ctx.get::<String>(0)?)
                .and_then(|code| crate::group_country::country_name(&code)))
        }),
    )
}
/// Adult groups, independent of country: "Adult", "XXX", "18+", "🔞", "Porn".
pub(crate) fn adult_predicate(category: &str) -> String {
    format!("(instr(lower({category}),'adult')>0 OR instr(lower({category}),'xxx')>0 OR instr({category},'18+')>0 OR instr({category},'🔞')>0 OR instr(lower({category}),'porn')>0)")
}
/// Extra conditions for adult visibility and the chosen country, bound as
/// parameter ?20 (see `bound`). No country choice (NULL) adds no condition, so
/// channels of unknown country always remain in the full list; "" selects
/// exactly those channels; a code selects only verified matches.
pub(crate) fn visibility(category: &str, hide_adult: bool) -> String {
    let adult = if hide_adult {
        format!(" AND NOT {}", adult_predicate(category))
    } else {
        String::new()
    };
    format!("{adult} AND (?20 IS NULL OR (?20='' AND genx_group_country({category}) IS NULL) OR (?20<>'' AND instr(','||?20||',',','||genx_group_country({category})||',')>0))")
}
/// Statement values ?1.. followed by the country at ?20 (unused slots NULL).
pub(crate) fn bound<'a>(
    values: &[&'a dyn rusqlite::ToSql],
    country: &'a Option<String>,
) -> Vec<&'a dyn rusqlite::ToSql> {
    static NULL: rusqlite::types::Null = rusqlite::types::Null;
    let mut out = values.to_vec();
    out.resize(19, &NULL);
    out.push(country);
    out
}
fn country_order(category: &str) -> String {
    format!("genx_group_country_name({category}) IS NULL,genx_group_country_name({category}),{category} COLLATE NOCASE,e.name COLLATE NOCASE,e.channel_id")
}
fn present(c: &Connection, name: &str) -> Result<bool, String> {
    sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get::<_, bool>(0),
    ))
}
fn snapshot(c: &Connection, request: &Query) -> Result<Snapshot, String> {
    if !present(c, "account_vault_meta_v1")? {
        return Err("account-sign-in-required".into());
    }
    let account = sql(c.query_row("SELECT m.revision,m.secret_ref,m.server_origin,m.allow_http,v.active,v.revision FROM account_vault_meta_v1 m JOIN account_vault_versions_v1 v ON v.id=m.id WHERE m.id=?1",[&request.account_id],|r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?))).optional())?.ok_or("account-removed")?;
    if account.0 <= 0 || account.0 != account.5 || account.4 != 1 || !opaque(&account.1) {
        return Err("account-sign-in-required".into());
    }
    let origin = reqwest::Url::parse(&account.2).map_err(|_| "account-origin-refused")?;
    if !crate::account_vault::origin_allowed(&origin, &account.2, account.3 != 0) {
        return Err("account-origin-refused".into());
    }
    if account.0 != revision(&request.expected_account_revision)? {
        return Err("account-revision-conflict".into());
    }
    if !present(c, "account_media_catalog_v1")? {
        return Err("account-media-not-collected".into());
    }
    let media = sql(c
        .query_row(
            "SELECT account_revision,secret_ref,batch_id,revision FROM account_media_catalog_v1 WHERE account_id=?1",
            [&request.account_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional())?
    .ok_or("account-media-not-collected")?;
    if media.0 != account.0 || media.1 != account.1 {
        return Err("account-media-reference-revoked".into());
    }
    if media.3 <= 0 || !opaque(&media.2) {
        return Err("account-media-invalid".into());
    }
    if request
        .expected_media_revision
        .as_deref()
        .map(revision)
        .transpose()?
        .is_some_and(|r| r != media.3)
    {
        return Err("account-media-revision-conflict".into());
    }
    let preferences = crate::account_preferences::revision(c, &request.account_id)?;
    if request
        .expected_preferences_revision
        .as_deref()
        .map(preferences_revision)
        .transpose()?
        .is_some_and(|expected| expected != preferences)
    {
        return Err("account-preferences-revision-conflict".into());
    }
    Ok(Snapshot {
        account_revision: account.0,
        media_revision: media.3,
        preferences_revision: preferences,
    })
}
/// Invoke under the storage writer or the account install transaction; only
/// metadata indexes are created. Reads never silently mutate the database.
pub(crate) fn install_indexes(c: &Connection) -> Result<(), String> {
    if !present(c, "account_media_entry_v1")? {
        return Err("account-media-not-collected".into());
    }
    sql(c.execute_batch("CREATE INDEX IF NOT EXISTS account_media_name_v1 ON account_media_entry_v1(account_id,name COLLATE NOCASE,channel_id);
        CREATE INDEX IF NOT EXISTS account_media_category_v1 ON account_media_entry_v1(account_id,category COLLATE NOCASE,name COLLATE NOCASE,channel_id);"))
}
// Primary-key account entry scans and point joins retain exact current account,
// revision, secret reference, batch, page and stream grant ownership.
const LIVE: &str = " FROM account_media_entry_v1 e
 JOIN account_media_catalog_v1 cat ON cat.account_id=e.account_id
 JOIN account_vault_meta_v1 m ON m.id=cat.account_id AND m.revision=cat.account_revision AND m.secret_ref=cat.secret_ref
 JOIN account_vault_versions_v1 v ON v.id=m.id AND v.revision=m.revision AND v.active=1
 JOIN account_media_page_v1 p ON p.page_ref=e.page_ref AND p.account_id=e.account_id AND p.batch_id=cat.batch_id
 JOIN account_vault_references_v1 r ON r.reference=e.stream_ref AND r.account_id=e.account_id AND r.account_revision=cat.account_revision AND r.purpose='media'
";
struct Scope {
    live: String,
    predicate: String,
    category: &'static str,
    favorite: &'static str,
}
/// Provider group words that mean sport. Paid providers rarely say "sports":
/// "US| NFL PPV", "US| SPORT ᴴᴰ", "NBA TEAM PPV" (October 18, 2026 trial).
const SPORT_WORDS: [&str; 20] = [
    "sport", "nfl", "nba", "nhl", "mlb", "mls", "ncaa", "ufc", "wwe", "boxing", "espn", "dazn",
    "golf", "tennis", "rugby", "cricket", "nascar", "racing", "soccer", "football",
];
fn scope(c: &Connection) -> Result<Scope, String> {
    let meta = present(c, "account_preferences_meta_v1")?;
    let preferences = present(c, "account_channel_preferences_v1")?;
    if meta != preferences {
        return Err("account-preferences-invalid".into());
    }
    let (join, category, favorite, removed) = if preferences {
        (
            " LEFT JOIN account_channel_preferences_v1 pref ON pref.account_id=e.account_id AND pref.channel_id=e.channel_id",
            "COALESCE(pref.category,e.category)",
            "COALESCE(pref.favorite,0)",
            "COALESCE(pref.removed,0)",
        )
    } else {
        ("", "e.category", "CAST(0 AS INTEGER)", "0")
    };
    let sports = SPORT_WORDS
        .iter()
        .map(|word| format!("instr(lower({category}),'{word}')>0"))
        .collect::<Vec<_>>()
        .join(" OR ");
    Ok(Scope {
        live: format!("{LIVE}{join} WHERE e.account_id=?1 AND {removed}=0"),
        predicate: format!(" AND (?2='' OR instr(lower(e.name)||char(10)||lower({category})||char(10)||lower(COALESCE(e.provider_id,''))||char(10)||lower(COALESCE(e.epg_id,'')),lower(?2))>0)
            AND (?3 IS NULL OR {category}=?3 COLLATE NOCASE)
            AND (?4='all' OR (?4='news' AND instr(lower({category}),'news')>0) OR (?4='sports' AND ({sports})) OR (?4='movies' AND (instr(lower({category}),'movie')>0 OR instr(lower({category}),'cinema')>0 OR instr(lower({category}),'film')>0)) OR (?4='favorites' AND {favorite}=1))"),
        category,favorite,
    })
}
/// The Paid TV list's live scope for other readers (the account guide): the
/// FROM/WHERE (account as ?1, removed channels excluded) and the effective
/// category and favorite expressions, exactly as the channel list uses them.
pub(crate) struct LiveScope {
    pub from: String,
    pub category: &'static str,
    pub favorite: &'static str,
}
pub(crate) fn live_scope(c: &Connection) -> Result<LiveScope, String> {
    let scoped = scope(c)?;
    Ok(LiveScope {
        from: scoped.live,
        category: scoped.category,
        favorite: scoped.favorite,
    })
}
struct Progress<'a> {
    c: &'a Connection,
    active: bool,
}
impl Progress<'_> {
    fn clear(&mut self) -> Result<(), String> {
        sql(self.c.progress_handler(0, None::<fn() -> bool>))?;
        self.active = false;
        Ok(())
    }
}
impl Drop for Progress<'_> {
    fn drop(&mut self) {
        if self.active {
            let _ = self.c.progress_handler(0, None::<fn() -> bool>);
        }
    }
}
fn channel_valid(item: &Channel, account: &str) -> bool {
    scoped_id(&item.id, account)
        && opaque(&item.stream_reference)
        && text(&item.name, 16384, false)
        && text(&item.category, 16384, true)
        && text(&item.original_category, 16384, true)
        && item
            .provider_id
            .as_ref()
            .is_none_or(|v| text(v, 16384, false))
        && item.epg_id.as_ref().is_none_or(|v| text(v, 16384, false))
}
/// Counts and ordered channel IDs of the last Paid TV list query at one
/// database state. Later pages, anchors and scrolling reuse them instead of
/// re-counting the six-table join each time (about a second per page on a TV).
/// Building the list costs more than one page, so a query's first page is read
/// directly and the list is built when a second page of it is requested.
type Listed = (i64, i64, Arc<Vec<String>>);
static LISTED: std::sync::Mutex<Option<(String, Option<Listed>)>> = std::sync::Mutex::new(None);
/// Changes with every committed write (rollback journal rewrites the file).
fn database_stamp(c: &Connection) -> Option<String> {
    let path = c.path().filter(|p| !p.is_empty())?;
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(format!("{path}\n{}:{modified}", meta.len()))
}

// This module's parts, by area, are in account_catalog_query/.
mod page;
pub(crate) use page::*;
#[cfg(test)]
mod tests;
