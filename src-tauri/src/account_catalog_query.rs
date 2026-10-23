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
    let media = sql(c.query_row("SELECT account_revision,secret_ref,batch_id,revision FROM account_media_catalog_v1 WHERE account_id=?1",[&request.account_id],|r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?))).optional())?.ok_or("account-media-not-collected")?;
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
        (" LEFT JOIN account_channel_preferences_v1 pref ON pref.account_id=e.account_id AND pref.channel_id=e.channel_id",
            "COALESCE(pref.category,e.category)", "COALESCE(pref.favorite,0)", "COALESCE(pref.removed,0)")
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
pub(crate) fn read_page(
    c: &Connection,
    request: &Query,
    owner: Arc<Context>,
) -> Result<Page, String> {
    validate(request)?;
    owner.check()?;
    let progress_owner = owner.clone();
    sql(c.progress_handler(1000, Some(move || progress_owner.check().is_err())))?;
    let mut progress = Progress { c, active: true };
    let result = (|| {
        register_functions(c)?;
        let tx = sql(c.unchecked_transaction())?;
        let captured = snapshot(&tx, request)?;
        let scoped = scope(&tx)?;
        let live = &scoped.live;
        let predicate = &format!(
            "{}{}",
            scoped.predicate,
            visibility(scoped.category, request.hide_adult)
        );
        let effective_category = scoped.category;
        let favorite = scoped.favorite;
        owner.check()?;
        let filter = match request.filter {
            Filter::All => "all",
            Filter::News => "news",
            Filter::Sports => "sports",
            Filter::Favorites => "favorites",
            Filter::Movies => "movies",
        };
        let order = match request.sort {
            // There is no persisted acquisition ordinal: Source is deterministic ID order.
            Sort::Source => "e.channel_id".to_owned(),
            Sort::Name => "e.name COLLATE NOCASE,e.channel_id".to_owned(),
            Sort::Category => {
                format!("{effective_category} COLLATE NOCASE,e.name COLLATE NOCASE,e.channel_id")
            }
            Sort::Country => country_order(effective_category),
        };
        let order = if request.favorites_first {
            format!("{favorite} DESC,{order}")
        } else {
            order
        };
        // The stamp is read while this transaction holds its shared lock (the
        // snapshot above read the database), so no write lands in between.
        let cache_key = database_stamp(&tx).map(|stamp| {
            serde_json::json!([
                stamp,
                request.account_id,
                captured.account_revision,
                captured.media_revision,
                captured.preferences_revision,
                request.query,
                request.category,
                filter,
                request.country,
                order,
                request.hide_adult,
            ])
            .to_string()
        });
        // None: not cached. Some(None): this query was seen once. Some(Some): listed.
        let seen: Option<Option<Listed>> = match &cache_key {
            None => None,
            Some(key) => {
                let mut held = LISTED.lock().map_err(|_| "account-media-cache-lock")?;
                match held.as_ref().filter(|(k, _)| k == key) {
                    Some((_, listed)) => Some(listed.clone()),
                    None => {
                        *held = Some((key.clone(), None));
                        None
                    }
                }
            }
        };
        let listed = match (seen, &cache_key) {
            (Some(Some(listed)), _) => Some(listed),
            (None, _) | (_, None) => None,
            (Some(None), Some(key)) => {
                let admitted: i64 = sql(tx.query_row(
                    &format!("SELECT COUNT(*){LIVE} WHERE e.account_id=?1"),
                    [&request.account_id],
                    |r| r.get(0),
                ))?;
                if !(0..=MAX).contains(&admitted) {
                    return Err("account-media-too-large".into());
                }
                let mut statement = sql(tx.prepare(&format!(
                    "SELECT e.channel_id{live}{predicate} ORDER BY {order}"
                )))?;
                let ids = sql(statement
                    .query_map(
                        rusqlite::params_from_iter(bound(
                            &[
                                &request.account_id,
                                &request.query,
                                &request.category,
                                &filter,
                            ],
                            &request.country,
                        )),
                        |r| r.get::<_, String>(0),
                    )
                    .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>()))?;
                drop(statement);
                let listed = (admitted, ids.len() as i64, Arc::new(ids));
                *LISTED.lock().map_err(|_| "account-media-cache-lock")? =
                    Some((key.clone(), Some(listed.clone())));
                Some(listed)
            }
        };
        let admitted_count: i64 = if let Some((admitted, _, _)) = &listed {
            *admitted
        } else {
            sql(tx.query_row(
                &format!("SELECT COUNT(*){LIVE} WHERE e.account_id=?1"),
                [&request.account_id],
                |r| r.get(0),
            ))?
        };
        if !(0..=MAX).contains(&admitted_count) {
            return Err("account-media-too-large".into());
        }
        let total: i64 = if let Some((_, total, _)) = &listed {
            *total
        } else {
            sql(tx.query_row(
                &format!("SELECT COUNT(*){live}{predicate}"),
                rusqlite::params_from_iter(bound(
                    &[
                        &request.account_id,
                        &request.query,
                        &request.category,
                        &filter,
                    ],
                    &request.country,
                )),
                |r| r.get(0),
            ))?
        };
        if total < 0 || total > admitted_count {
            return Err("account-media-invalid".into());
        }
        let mut start_index = request.start_index;
        let mut anchor_index = None;
        if let (Some(anchor), Some((_, _, ids))) = (&request.anchor_id, &listed) {
            // The cached order is exactly the requested order, so a listed
            // anchor's position is its rank.
            if let Some(rank) = ids.iter().position(|id| id == anchor) {
                anchor_index = Some(rank);
                start_index = rank.saturating_sub(1);
            }
        } else if let Some(anchor) = &request.anchor_id {
            owner.check()?;
            // The anchor must be live and match the same query/category/filter.
            // Metadata sort keys remain internal and never contain stream URLs.
            let key = sql(tx.query_row(
                &format!("SELECT e.name,{effective_category},e.channel_id,{favorite}{live}{predicate} AND e.channel_id=?5"),
                rusqlite::params_from_iter(bound(&[&request.account_id,&request.query,&request.category,&filter,anchor],&request.country)),
                |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,bool>(3)?)),
            ).optional())?;
            if key.is_some() && matches!(request.sort, Sort::Country) {
                // The country key is computed, so rank the anchor by its row
                // position under exactly the requested order.
                let rank: i64 = sql(tx.query_row(
                    &format!("SELECT pos FROM (SELECT e.channel_id AS id,ROW_NUMBER() OVER (ORDER BY {order})-1 AS pos{live}{predicate}) WHERE id=?5"),
                    rusqlite::params_from_iter(bound(
                        &[&request.account_id, &request.query, &request.category, &filter, anchor],
                        &request.country,
                    )),
                    |r| r.get(0),
                ))?;
                if rank < 0 || rank >= total {
                    return Err("account-media-invalid".into());
                }
                anchor_index = Some(rank as usize);
                start_index = (rank as usize).saturating_sub(1);
            } else if let Some((name, category, id, anchor_favorite)) = key {
                // Every comparison uses exactly the same NOCASE/BINARY ordering
                // and unique ID tie-break as the requested metadata page.
                let predecessor = match request.sort {
                    Sort::Source => "e.channel_id<?7".to_owned(),
                    Sort::Name => "(e.name COLLATE NOCASE<?5 COLLATE NOCASE OR (e.name COLLATE NOCASE=?5 COLLATE NOCASE AND e.channel_id<?7))".to_owned(),
                    Sort::Category => format!("({effective_category} COLLATE NOCASE<?6 COLLATE NOCASE OR ({effective_category} COLLATE NOCASE=?6 COLLATE NOCASE AND (e.name COLLATE NOCASE<?5 COLLATE NOCASE OR (e.name COLLATE NOCASE=?5 COLLATE NOCASE AND e.channel_id<?7))))"),
                    Sort::Country => unreachable!("country anchors are ranked above"),
                };
                let predecessor = format!("((?8=0 AND {predecessor}) OR (?8=1 AND ({favorite}>?9 OR ({favorite}=?9 AND {predecessor}))))");
                let rank: i64 = sql(tx.query_row(
                    &format!("SELECT COUNT(*){live}{predicate} AND {predecessor}"),
                    rusqlite::params_from_iter(bound(
                        &[
                            &request.account_id,
                            &request.query,
                            &request.category,
                            &filter,
                            &name,
                            &category,
                            &id,
                            &request.favorites_first,
                            &anchor_favorite,
                        ],
                        &request.country,
                    )),
                    |r| r.get(0),
                ))?;
                if rank < 0 || rank >= total {
                    return Err("account-media-invalid".into());
                }
                anchor_index = Some(rank as usize);
                // Match public CatalogWindow adjacency: one predecessor, then
                // the anchor and successors. Wrap-around uses a later offset read.
                start_index = (rank as usize).saturating_sub(1);
            }
        }
        let map_channel = |r: &rusqlite::Row<'_>| {
            Ok(Channel {
                id: r.get(0)?,
                name: r.get(1)?,
                category: r.get(2)?,
                provider_id: r.get(3)?,
                epg_id: r.get(4)?,
                stream_reference: r.get(5)?,
                favorite: r.get(6)?,
                original_category: r.get(7)?,
            })
        };
        let columns = format!("SELECT e.channel_id,e.name,{effective_category},e.provider_id,e.epg_id,e.stream_ref,{favorite},e.category{live}{predicate}");
        let rows: Vec<rusqlite::Result<Channel>> = if let Some((_, _, ids)) = &listed {
            // Read only the requested slice of the cached order, each row
            // still through the same live scope and predicate.
            let mut statement = sql(tx.prepare(&format!("{columns} AND e.channel_id=?5")))?;
            let mut rows = Vec::new();
            for id in ids.iter().skip(start_index).take(request.page_size) {
                owner.check()?;
                let channel = sql(statement
                    .query_row(
                        rusqlite::params_from_iter(bound(
                            &[
                                &request.account_id,
                                &request.query,
                                &request.category,
                                &filter,
                                id,
                            ],
                            &request.country,
                        )),
                        map_channel,
                    )
                    .optional())?
                .ok_or("account-media-invalid")?;
                rows.push(Ok(channel));
            }
            rows
        } else {
            let mut statement =
                sql(tx.prepare(&format!("{columns} ORDER BY {order} LIMIT ?5 OFFSET ?6")))?;
            let rows = sql(statement.query_map(
                rusqlite::params_from_iter(bound(
                    &[
                        &request.account_id,
                        &request.query,
                        &request.category,
                        &filter,
                        &(request.page_size as i64),
                        &(start_index as i64),
                    ],
                    &request.country,
                )),
                map_channel,
            ))?;
            rows.collect()
        };
        let mut items = Vec::with_capacity(request.page_size);
        let mut bytes = 512usize;
        let mut identities = std::collections::HashSet::new();
        let mut references = std::collections::HashSet::new();
        for row in rows {
            owner.check()?;
            let item = sql(row)?;
            if !channel_valid(&item, &request.account_id)
                || !identities.insert(item.id.clone())
                || !references.insert(item.stream_reference.clone())
            {
                return Err("account-media-invalid".into());
            }
            let size = serde_json::to_vec(&item)
                .map_err(|_| "account-media-invalid")?
                .len()
                + 1;
            if bytes + size > LIMIT {
                if items.is_empty() {
                    return Err("account-catalog-page-too-large".into());
                }
                break;
            }
            bytes += size;
            items.push(item);
        }
        if start_index < total as usize && items.is_empty() {
            return Err("account-media-invalid".into());
        }
        let page = Page {
            schema_version: 1,
            account_id: request.account_id.clone(),
            account_revision: captured.account_revision.to_string(),
            media_revision: captured.media_revision.to_string(),
            preferences_revision: captured.preferences_revision.to_string(),
            query_version: QUERY_VERSION,
            start_index,
            anchor_index,
            total: total as usize,
            items,
        };
        if serde_json::to_vec(&page)
            .map_err(|_| "account-media-invalid")?
            .len()
            > LIMIT
        {
            return Err("account-catalog-page-too-large".into());
        }
        owner.check()?;
        sql(tx.commit())?;
        Ok(page)
    })();
    let cleanup = progress.clear();
    // Preserve the cancellation reason over SQLite's generic interrupted code.
    owner.check()?;
    cleanup?;
    result
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CountryRequest {
    pub schema_version: u8,
    pub account_id: String,
    pub expected_account_revision: String,
    #[serde(default)]
    pub hide_adult: bool,
}
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CountryCount {
    /// An app country code; None for channels whose country is unknown.
    pub code: Option<String>,
    pub count: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Countries {
    pub schema_version: u8,
    pub account_id: String,
    pub account_revision: String,
    pub total: usize,
    pub countries: Vec<CountryCount>,
}
/// Channel counts per resolved country, under the same visibility rules as the
/// channel list (removed channels and, when chosen, adult groups excluded).
pub(crate) fn read_countries(
    c: &Connection,
    request: &CountryRequest,
) -> Result<Countries, String> {
    let query = Query {
        schema_version: request.schema_version,
        account_id: request.account_id.clone(),
        expected_account_revision: request.expected_account_revision.clone(),
        expected_media_revision: None,
        expected_preferences_revision: None,
        query: String::new(),
        category: None,
        filter: Filter::All,
        sort: Sort::Source,
        favorites_first: false,
        country: None,
        hide_adult: request.hide_adult,
        start_index: 0,
        anchor_id: None,
        page_size: 1,
    };
    validate(&query)?;
    register_functions(c)?;
    let tx = sql(c.unchecked_transaction())?;
    let captured = snapshot(&tx, &query)?;
    let scoped = scope(&tx)?;
    let category = scoped.category;
    let adult = if request.hide_adult {
        format!(" AND NOT {}", adult_predicate(category))
    } else {
        String::new()
    };
    let mut statement = sql(tx.prepare(&format!(
        "SELECT genx_group_country({category}) AS code,COUNT(*){} {adult} GROUP BY code ORDER BY code IS NULL,code",
        scoped.live
    )))?;
    let rows = sql(statement.query_map([&request.account_id], |r| {
        Ok(CountryCount {
            code: r.get(0)?,
            count: r.get::<_, i64>(1)? as usize,
        })
    }))?;
    let mut countries = Vec::new();
    for row in rows {
        countries.push(sql(row)?);
    }
    drop(statement);
    Ok(Countries {
        schema_version: 1,
        account_id: request.account_id.clone(),
        account_revision: captured.account_revision.to_string(),
        total: countries.iter().map(|c| c.count).sum(),
        countries,
    })
}
pub(crate) async fn countries(
    request: CountryRequest,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Countries, String> {
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (result, _) = owner
            .storage(None, move |store, check| {
                check()?;
                store.with_guide_read(|c| read_countries(c, &request))
            })
            .await?;
        owner.check()?;
        Ok(result)
    })
    .await
}
pub(crate) async fn query(
    request: Query,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Page, String> {
    validate(&request)?;
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let query_owner = owner.clone();
        let (page, _) = owner
            .storage(None, move |store, check| {
                check()?;
                store.with_guide_read(|c| read_page(c, &request, query_owner))
            })
            .await?;
        owner.check()?;
        Ok(page)
    })
    .await
}

#[cfg(test)]
mod geography_tests {
    //! Synthetic Xtream-shaped catalog on the production schema, read through
    //! the production `read_page`/`read_countries` (the real six-table join).
    use super::*;
    use rusqlite::params;
    const ACCOUNT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SECRET: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const BATCH: &str = "cccccccccccccccccccccccccccccccc";
    /// (letter, name, provider group, removed, favorite)
    const CHANNELS: &[(char, &str, &str, bool, bool)] = &[
        ('a', "Alpha News", "USA", false, false),
        ('b', "Bravo Sport", "UK ➾ Sport", false, true),
        ('c', "Charlie TV", "EX-YU", false, false),
        ('d', "Delta Late", "US ➾ Adult", false, false),
        ('e', "Echo Night", "UK ➾ XXX", false, false),
        ('f', "Foxtrot After Dark", "Adult 🔞", false, false),
        ('g', "Golf Removed", "USA", true, false),
    ];
    fn id(letter: char) -> String {
        format!("account-{ACCOUNT}-{}", letter.to_string().repeat(64))
    }
    fn database() -> Connection {
        fill(Connection::open_in_memory().unwrap())
    }
    fn fill(c: Connection) -> Connection {
        c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        crate::account_media_store::initialize(&c).unwrap();
        install_indexes(&c).unwrap();
        c.execute_batch(&format!(
            "INSERT INTO account_vault_versions_v1 VALUES('{ACCOUNT}',1,1);
             INSERT INTO account_vault_meta_v1 VALUES('{ACCOUNT}','Fixture','xtream','https://provider.invalid',0,1,'{SECRET}');
             INSERT INTO account_media_catalog_v1 VALUES('{ACCOUNT}',1,'{SECRET}','{BATCH}',1);
             INSERT INTO account_media_page_v1 VALUES('page-1','{ACCOUNT}','{BATCH}',0,0);
             INSERT INTO account_preferences_meta_v1 VALUES('{ACCOUNT}',1);"
        ))
        .unwrap();
        for (letter, name, group, removed, favorite) in CHANNELS {
            let reference = letter.to_string().repeat(32).replace('g', "9");
            c.execute(
                "INSERT INTO account_vault_references_v1 VALUES(?1,?2,1,'media')",
                params![reference, ACCOUNT],
            )
            .unwrap();
            c.execute(
                "INSERT INTO account_media_entry_v1 VALUES(?1,?2,?3,?4,NULL,NULL,?5,'page-1')",
                params![ACCOUNT, id(*letter), name, group, reference],
            )
            .unwrap();
            if *removed || *favorite {
                c.execute(
                    "INSERT INTO account_channel_preferences_v1 VALUES(?1,?2,?3,?4,NULL)",
                    params![ACCOUNT, id(*letter), favorite, removed],
                )
                .unwrap();
            }
        }
        c
    }
    fn query(country: Option<&str>, hide_adult: bool, sort: Sort, filter: Filter) -> Query {
        Query {
            schema_version: 1,
            account_id: ACCOUNT.into(),
            expected_account_revision: "1".into(),
            expected_media_revision: None,
            expected_preferences_revision: None,
            query: String::new(),
            category: None,
            filter,
            sort,
            favorites_first: false,
            country: country.map(str::to_owned),
            hide_adult,
            start_index: 0,
            anchor_id: None,
            page_size: 64,
        }
    }
    fn names(c: &Connection, request: &Query) -> (usize, Vec<String>) {
        let (_root, context, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        let page = read_page(c, request, context).unwrap();
        assert_eq!(page.total, page.items.len(), "fixture fits one page");
        (page.total, page.items.into_iter().map(|i| i.name).collect())
    }
    fn letters(c: &Connection, request: &Query) -> String {
        names(c, request)
            .1
            .iter()
            .map(|n| n.chars().next().unwrap())
            .collect()
    }

    /// File databases reuse the ordered list across pages; in-memory ones never
    /// do. Every page, anchor and later edit must read the same either way.
    #[test]
    fn cached_pages_match_uncached_pages_before_and_after_edits() {
        let root = tempfile::tempdir().unwrap();
        let file = fill(Connection::open(root.path().join("genx.sqlite3")).unwrap());
        let memory = database();
        let (_root, context, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        let pages = |c: &Connection| {
            let mut out = Vec::new();
            for sort in [Sort::Source, Sort::Name, Sort::Category, Sort::Country] {
                for (filter, hide_adult, favorites_first, text, country) in [
                    (Filter::All, false, false, "", None),
                    (Filter::All, true, true, "", None),
                    (Filter::Sports, false, false, "", None),
                    (Filter::All, false, false, "o", Some("UK")),
                    (Filter::Favorites, false, false, "", None),
                ] {
                    let mut request = query(country, hide_adult, sort, filter);
                    request.favorites_first = favorites_first;
                    request.query = text.into();
                    request.page_size = 2;
                    let first = read_page(c, &request, context.clone()).unwrap();
                    request.expected_media_revision = Some(first.media_revision);
                    request.expected_preferences_revision = Some(first.preferences_revision);
                    for start in 0..6 {
                        request.start_index = start;
                        request.anchor_id = None;
                        out.push(
                            serde_json::to_string(
                                &read_page(c, &request, context.clone()).unwrap(),
                            )
                            .unwrap(),
                        );
                    }
                    for letter in ['a', 'b', 'd', 'f', 'g', 'z'] {
                        request.start_index = 0;
                        request.anchor_id = Some(id(letter));
                        out.push(
                            read_page(c, &request, context.clone())
                                .map(|p| serde_json::to_string(&p).unwrap())
                                .unwrap_or_else(|e| e),
                        );
                    }
                }
            }
            out
        };
        let expected = pages(&memory);
        assert_eq!(pages(&file), expected);
        assert_eq!(pages(&file), expected);
        // A preference edit (favorite) changes the order; the cache must notice.
        for c in [&file, &memory] {
            c.execute(
                "INSERT INTO account_channel_preferences_v1 VALUES(?1,?2,1,0,NULL)",
                params![ACCOUNT, id('c')],
            )
            .unwrap();
            c.execute(
                "UPDATE account_preferences_meta_v1 SET revision=revision+1",
                [],
            )
            .unwrap();
        }
        let edited = pages(&memory);
        assert_ne!(edited, expected);
        assert_eq!(pages(&file), edited);
    }
    #[test]
    fn adult_switch_governs_every_listing() {
        let c = database();
        // Hidden: no adult rows in the list, the total, search or favorites.
        assert_eq!(
            letters(&c, &query(None, true, Sort::Source, Filter::All)),
            "ABC"
        );
        // Shown: all six live channels; the removed one never appears.
        assert_eq!(
            letters(&c, &query(None, false, Sort::Source, Filter::All)),
            "ABCDEF"
        );
        let mut search = query(None, true, Sort::Source, Filter::All);
        search.query = "night".into();
        assert_eq!(names(&c, &search).0, 0);
        search.hide_adult = false;
        assert_eq!(letters(&c, &search), "E");
        assert_eq!(
            letters(&c, &query(None, true, Sort::Source, Filter::Favorites)),
            "B"
        );
    }
    #[test]
    fn country_filter_matches_only_verified_countries() {
        let c = database();
        assert_eq!(
            letters(&c, &query(Some("UK"), false, Sort::Source, Filter::All)),
            "BE"
        );
        assert_eq!(
            letters(&c, &query(Some("UK"), true, Sort::Source, Filter::All)),
            "B"
        );
        assert_eq!(
            letters(&c, &query(Some("US"), true, Sort::Source, Filter::All)),
            "A"
        );
        // Unknown country: listed only under All countries and Unknown.
        assert_eq!(
            letters(&c, &query(Some(""), false, Sort::Source, Filter::All)),
            "CF"
        );
        assert_eq!(
            letters(&c, &query(Some(""), true, Sort::Source, Filter::All)),
            "C"
        );
        assert_eq!(
            letters(&c, &query(Some("FR"), false, Sort::Source, Filter::All)),
            ""
        );
        // Several countries at once (owner request: "USA, Canada and UK").
        assert_eq!(
            letters(&c, &query(Some("US,UK"), false, Sort::Source, Filter::All)),
            "ABDE"
        );
        assert_eq!(
            letters(&c, &query(Some("FR,UK"), true, Sort::Source, Filter::All)),
            "B"
        );
    }
    #[test]
    fn country_sort_is_by_name_with_unknown_last_and_anchors_rank_exactly() {
        let c = database();
        // United Kingdom < United States < unknown; then group, then name.
        assert_eq!(
            letters(&c, &query(None, false, Sort::Country, Filter::All)),
            "BEDAFC"
        );
        let mut anchored = query(None, false, Sort::Country, Filter::All);
        anchored.anchor_id = Some(id('a'));
        let (_root, context, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        let page = read_page(&c, &anchored, context).unwrap();
        assert_eq!(page.anchor_index, Some(3));
        assert_eq!(page.start_index, 2);
    }
    #[test]
    fn country_summary_counts_with_the_same_visibility() {
        let c = database();
        let summary = |hide_adult| {
            read_countries(
                &c,
                &CountryRequest {
                    schema_version: 1,
                    account_id: ACCOUNT.into(),
                    expected_account_revision: "1".into(),
                    hide_adult,
                },
            )
            .unwrap()
        };
        let hidden = summary(true);
        assert_eq!(hidden.total, 3);
        assert_eq!(
            hidden.countries,
            vec![
                CountryCount {
                    code: Some("UK".into()),
                    count: 1
                },
                CountryCount {
                    code: Some("US".into()),
                    count: 1
                },
                CountryCount {
                    code: None,
                    count: 1
                },
            ]
        );
        assert_eq!(summary(false).total, 6);
    }
    #[test]
    fn country_adult_and_search_combine() {
        let c = database();
        let mut request = query(Some("UK"), false, Sort::Source, Filter::All);
        request.query = "o".into(); // Bravo, Echo
        assert_eq!(letters(&c, &request), "BE");
        request.hide_adult = true;
        assert_eq!(letters(&c, &request), "B");
        request.query = "echo".into();
        assert_eq!(names(&c, &request).0, 0);
        let mut unknown = query(Some(""), false, Sort::Source, Filter::All);
        unknown.query = "fox".into();
        assert_eq!(letters(&c, &unknown), "F");
        // A group (category) choice narrows within the country.
        let mut group = query(Some("UK"), false, Sort::Source, Filter::All);
        group.category = Some("UK ➾ XXX".into());
        assert_eq!(letters(&c, &group), "E");
        group.hide_adult = true;
        assert_eq!(letters(&c, &group), "");
        // Clearing filters one at a time restores the wider result sets.
        group.category = None;
        assert_eq!(letters(&c, &group), "B");
        group.country = None;
        assert_eq!(letters(&c, &group), "ABC");
        group.hide_adult = false;
        assert_eq!(letters(&c, &group), "ABCDEF");
    }
    #[test]
    fn sports_include_league_and_singular_sport_groups() {
        let c = database();
        for (letter, name, group) in [
            ('1', "1pm Bears at Falcons", "US| NFL PPV"),
            ('2', "Sport One", "US| SPORT ᴴᴰ/ᴿᴬᵂ"),
            ('3', "Bulls", "US| NBA TEAM PPV"),
            ('4', "Evening News", "US| NEWS ᴴᴰ"),
            ('5', "Movie Night", "US| CINEMA"),
        ] {
            let reference = letter.to_string().repeat(32);
            c.execute(
                "INSERT INTO account_vault_references_v1 VALUES(?1,?2,1,'media')",
                params![reference, ACCOUNT],
            )
            .unwrap();
            c.execute(
                "INSERT INTO account_media_entry_v1 VALUES(?1,?2,?3,?4,NULL,NULL,?5,'page-1')",
                params![ACCOUNT, id(letter), name, group, reference],
            )
            .unwrap();
        }
        let (_, sports) = names(&c, &query(None, false, Sort::Source, Filter::Sports));
        for wanted in ["1pm Bears at Falcons", "Sport One", "Bulls"] {
            assert!(sports.iter().any(|n| n == wanted), "{wanted} in {sports:?}");
        }
        assert!(!sports
            .iter()
            .any(|n| n == "Evening News" || n == "Movie Night"));
    }
    #[test]
    fn country_sorted_pages_keep_totals_and_boundaries() {
        let c = database();
        // Two more channels whose country, group and name all tie: only the
        // channel ID orders them, as in production.
        for letter in ['1', '2'] {
            let reference = letter.to_string().repeat(32);
            c.execute(
                "INSERT INTO account_vault_references_v1 VALUES(?1,?2,1,'media')",
                params![reference, ACCOUNT],
            )
            .unwrap();
            c.execute(
                "INSERT INTO account_media_entry_v1 VALUES(?1,?2,'Hotel Twin','USA',NULL,NULL,?3,'page-1')",
                params![ACCOUNT, id(letter), reference],
            )
            .unwrap();
        }
        let mut ids = Vec::new();
        let mut seen = String::new();
        let mut start = 0;
        loop {
            let mut request = query(None, false, Sort::Country, Filter::All);
            request.page_size = 3;
            request.start_index = start;
            if start > 0 {
                request.expected_media_revision = Some("1".into());
                request.expected_preferences_revision = Some("1".into());
            }
            let (_root, context, _playback, _work, _requests) =
                crate::scan_manifest_work::bookmark_context_fixture();
            let page = read_page(&c, &request, context).unwrap();
            // The total never changes, including past the last page.
            assert_eq!(page.total, 8);
            let expected = 8usize.saturating_sub(start).min(3);
            assert_eq!(page.items.len(), expected, "page at {start}");
            if page.items.is_empty() {
                break;
            }
            seen.extend(page.items.iter().map(|i| i.name.chars().next().unwrap()));
            ids.extend(page.items.iter().map(|i| i.id.clone()));
            start += page.items.len();
        }
        // 3 + 3 + a final partial page of 2; no channel repeated or skipped.
        assert_eq!(seen, "BEDAHHFC");
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), 8);
        assert!(ids[4] < ids[5], "ties break by channel ID");
        // Every page concatenated equals the same query read in one page.
        let mut whole = query(None, false, Sort::Country, Filter::All);
        whole.page_size = 64;
        let (_root, context, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        let single: Vec<String> = read_page(&c, &whole, context)
            .unwrap()
            .items
            .into_iter()
            .map(|i| i.id)
            .collect();
        assert_eq!(ids, single);
        // Adult filtering and the country are applied before pagination.
        let mut filtered = query(Some("US"), true, Sort::Country, Filter::All);
        filtered.page_size = 2;
        let (_root, context, _playback, _work, _requests) =
            crate::scan_manifest_work::bookmark_context_fixture();
        let page = read_page(&c, &filtered, context).unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.items.len(), 2);
        assert!(page.items.iter().all(|i| i.category == "USA"));
    }
    #[test]
    fn invalid_country_values_are_refused() {
        let c = database();
        for value in [
            "uk",
            "GBR",
            "U'",
            "' OR 1=1 --",
            "US,US",
            "US,",
            ",US",
            "US,uk",
            "US;UK",
            "US, UK",
        ] {
            let (_root, context, _playback, _work, _requests) =
                crate::scan_manifest_work::bookmark_context_fixture();
            let request = query(Some(value), false, Sort::Source, Filter::All);
            assert!(read_page(&c, &request, context).is_err(), "{value}");
        }
    }
}
