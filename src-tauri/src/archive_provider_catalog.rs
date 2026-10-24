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

//! Additive provider catalog. Legacy IA identities/namespaces are never rewritten.
use crate::{
    archive_catalog as legacy,
    archive_provider_contract::{self as contract, Provider, ProviderItem, ProviderVariant},
    archive_provider_net as net,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| crate::storage_transaction::sql_error_code(&e, "public-archive-storage-failed"))
}
pub(crate) fn installed(c: &Connection) -> Result<bool, String> {
    sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='public_archive_item_v1' AND type='table')",
        [],
        |r| r.get(0),
    ))
}
pub(crate) fn install(tx: &Transaction<'_>) -> Result<(), String> {
    sql(tx.execute_batch("CREATE TABLE public_archive_item_v1(title_ref TEXT PRIMARY KEY CHECK(length(title_ref)=64),provider TEXT NOT NULL CHECK(provider IN('loc','nasa','commons')),item_id TEXT NOT NULL,document TEXT NOT NULL CHECK(length(CAST(document AS BLOB))<=524288),observed_ms INTEGER NOT NULL,UNIQUE(provider,item_id));CREATE TABLE public_archive_variant_v1(file_ref TEXT PRIMARY KEY CHECK(length(file_ref)=64),title_ref TEXT NOT NULL REFERENCES public_archive_item_v1(title_ref) ON DELETE CASCADE,variant_id TEXT NOT NULL,document TEXT NOT NULL CHECK(length(CAST(document AS BLOB))<=16384),observed_ms INTEGER NOT NULL CHECK(observed_ms BETWEEN 0 AND 9007199254740991),UNIQUE(title_ref,variant_id));CREATE INDEX public_archive_variant_title_v1 ON public_archive_variant_v1(title_ref);CREATE TABLE public_archive_preference_v1(title_ref TEXT PRIMARY KEY CHECK(length(title_ref)=64),favorite INTEGER NOT NULL CHECK(favorite IN(0,1)));CREATE TABLE public_archive_removal_v1(scope TEXT NOT NULL CHECK(scope IN('title','file')),reference TEXT NOT NULL CHECK(length(reference)=64),title_ref TEXT NOT NULL CHECK(length(title_ref)=64),PRIMARY KEY(scope,reference));CREATE TABLE public_archive_checkpoint_v1(scope TEXT NOT NULL CHECK(length(scope)=64),provider TEXT NOT NULL CHECK(provider IN('loc','nasa','commons')),document TEXT NOT NULL CHECK(length(CAST(document AS BLOB))<=524288),PRIMARY KEY(scope,provider));"))
}
pub(crate) fn validate(c: &Connection) -> Result<(), String> {
    if !installed(c)? {
        return Err("public-archive-schema-incomplete".into());
    }
    let tables:i64=sql(c.query_row("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('public_archive_item_v1','public_archive_variant_v1','public_archive_preference_v1','public_archive_removal_v1','public_archive_checkpoint_v1')",[],|r|r.get(0)))?;
    if tables != 5 {
        return Err("public-archive-schema-incomplete".into());
    }
    bounds(c)?;
    let mut items = std::collections::HashMap::new();
    let mut statement = sql(c.prepare(
        "SELECT title_ref,provider,item_id,document,observed_ms FROM public_archive_item_v1",
    ))?;
    let mut rows = sql(statement.query([]))?;
    while let Some(row) = sql(rows.next())? {
        let reference: String = sql(row.get(0))?;
        let provider: String = sql(row.get(1))?;
        let id: String = sql(row.get(2))?;
        let raw: String = sql(row.get(3))?;
        let observed: i64 = sql(row.get(4))?;
        let item = decode_item(&raw)?;
        if item.provider.id() != provider
            || item.item_id != id
            || contract::title_ref(item.provider, &id) != reference
            || !item.variants.is_empty()
            || !(0..=9_007_199_254_740_991).contains(&observed)
        {
            return Err("public-archive-metadata-invalid".into());
        }
        items.insert(reference, item);
    }
    drop(rows);
    drop(statement);
    let mut statement = sql(
        c.prepare("SELECT file_ref,title_ref,variant_id,document FROM public_archive_variant_v1")
    )?;
    let mut rows = sql(statement.query([]))?;
    while let Some(row) = sql(rows.next())? {
        let reference: String = sql(row.get(0))?;
        let tr: String = sql(row.get(1))?;
        let id: String = sql(row.get(2))?;
        let raw: String = sql(row.get(3))?;
        let variant: ProviderVariant =
            serde_json::from_str(&raw).map_err(|_| "public-archive-metadata-invalid")?;
        let item = items.get(&tr).ok_or("public-archive-metadata-invalid")?;
        if contract::file_ref(item.provider, &item.item_id, &variant) != reference
            || id != format!("{}\n{}", variant.asset_id, variant.variant_id)
        {
            return Err("public-archive-metadata-invalid".into());
        }
        let mut one = item.clone();
        one.variants.push(variant);
        contract::validate_item(&one)?;
    }
    drop(rows);
    drop(statement);
    let mut statement =
        sql(c.prepare("SELECT provider,document FROM public_archive_checkpoint_v1"))?;
    let mut rows = sql(statement.query([]))?;
    while let Some(row) = sql(rows.next())? {
        let provider: String = sql(row.get(0))?;
        let raw: String = sql(row.get(1))?;
        let p = match provider.as_str() {
            "loc" => Provider::Loc,
            "nasa" => Provider::Nasa,
            "commons" => Provider::Commons,
            _ => return Err("public-archive-progress-invalid".into()),
        };
        let state: Cursor =
            serde_json::from_str(&raw).map_err(|_| "public-archive-progress-invalid")?;
        validate_cursor(p, &state)?;
    }
    Ok(())
}
fn bounds(c: &Connection) -> Result<(), String> {
    let(t,v,bytes,p,r,progress):(i64,i64,i64,i64,i64,i64)=sql(c.query_row("SELECT (SELECT count(*) FROM public_archive_item_v1),(SELECT count(*) FROM public_archive_variant_v1),(SELECT COALESCE(sum(length(CAST(document AS BLOB))),0) FROM public_archive_item_v1)+(SELECT COALESCE(sum(length(CAST(document AS BLOB))),0) FROM public_archive_variant_v1),(SELECT count(*) FROM public_archive_preference_v1),(SELECT count(*) FROM public_archive_removal_v1),(SELECT COALESCE(sum(length(CAST(document AS BLOB))),0) FROM public_archive_checkpoint_v1)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))))?;
    let ia: i64 = sql(c.query_row("SELECT count(*) FROM archive_title_v1", [], |r| r.get(0)))?;
    if t > 400
        || t + ia > 1400
        || v > 20000
        || bytes > 20 * 1024 * 1024
        || p > 10000
        || r > 10000
        || progress > 4 * 1024 * 1024
    {
        return Err("public-archive-catalog-limit".into());
    }
    Ok(())
}
pub(crate) fn decode_item(raw: &str) -> Result<ProviderItem, String> {
    if raw.len() > 524288 {
        return Err("public-archive-metadata-invalid".into());
    }
    let item: ProviderItem =
        serde_json::from_str(raw).map_err(|_| "public-archive-metadata-invalid")?;
    contract::validate_item(&item)?;
    Ok(item)
}
fn removed(c: &Connection, scope: &str, r: &str) -> Result<bool, String> {
    sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM public_archive_removal_v1 WHERE scope=?1 AND reference=?2)",
        params![scope, r],
        |row| row.get(0),
    ))
}
pub(crate) fn upsert(c: &Connection, item: &ProviderItem, observed: i64) -> Result<bool, String> {
    contract::validate_item(item)?;
    let tr = contract::title_ref(item.provider, &item.item_id);
    if removed(c, "title", &tr)? {
        return Ok(false);
    }
    let mut header = item.clone();
    header.variants.clear();
    let raw = serde_json::to_string(&header).map_err(|_| "public-archive-metadata-invalid")?;
    if raw.len() > 524288 {
        return Err("public-archive-metadata-limit".into());
    }
    sql(c.execute("INSERT INTO public_archive_item_v1 VALUES(?1,?2,?3,?4,?5) ON CONFLICT(title_ref) DO UPDATE SET document=excluded.document,observed_ms=excluded.observed_ms",params![tr,item.provider.id(),item.item_id,raw,observed]))?;
    // A refresh updates actual listed variants but does not treat an incomplete
    // or empty response as proof that old files disappeared.
    for variant in &item.variants {
        let fr = contract::file_ref(item.provider, &item.item_id, variant);
        if removed(c, "file", &fr)? {
            continue;
        }
        let json = serde_json::to_string(variant).map_err(|_| "public-archive-metadata-invalid")?;
        if json.len() > 16384 {
            return Err("public-archive-metadata-limit".into());
        }
        sql(c.execute("INSERT INTO public_archive_variant_v1 VALUES(?1,?2,?3,?4,?5) ON CONFLICT(file_ref) DO UPDATE SET document=excluded.document,observed_ms=excluded.observed_ms",params![fr,tr,format!("{}\n{}",variant.asset_id,variant.variant_id),json,observed]))?;
    }
    bounds(c)?;
    Ok(true)
}
fn search_metadata(i: &ProviderItem) -> legacy::SearchMetadata {
    legacy::SearchMetadata {
        title: i.title.clone(),
        series: String::new(),
        subjects: i.subjects.join("\n"),
        collections: String::new(),
        description: String::new(),
        // Language filtering/ranking uses retained claims separately. These
        // aliases only feed the shared contradiction-aware text predicate.
        languages: Vec::new(),
        provider_type: match i.content_type.as_str() {
            "tv" => "television",
            "movie" => "feature film",
            "short" => "short film",
            _ => "",
        }
        .into(),
        artwork: None,
    }
}
pub(crate) fn matches(i: &ProviderItem, query: &str) -> Result<Option<&'static str>, String> {
    let encoded = legacy::encode_search_metadata(&search_metadata(i))?;
    legacy::match_basis(&i.title, &encoded, "", query)
}
pub(crate) fn query_rows(
    c: &Connection,
    q: &legacy::Query,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Vec<legacy::Title>, String> {
    if !installed(c)? || q.curated_only {
        return Ok(Vec::new());
    }
    bounds(c)?;
    let mut stmt=sql(c.prepare("SELECT i.title_ref,i.document,i.observed_ms,COALESCE(p.favorite,0),(SELECT count(*) FROM public_archive_variant_v1 v WHERE v.title_ref=i.title_ref) FROM public_archive_item_v1 i LEFT JOIN public_archive_preference_v1 p ON p.title_ref=i.title_ref WHERE EXISTS(SELECT 1 FROM public_archive_variant_v1 v WHERE v.title_ref=i.title_ref) ORDER BY i.title_ref"))?;
    let mut rows = sql(stmt.query([]))?;
    let mut result = Vec::new();
    while let Some(r) = sql(rows.next())? {
        check()?;
        let raw: String = sql(r.get(1))?;
        let i = decode_item(&raw)?;
        let release_year = contract::effective_release_year(&i);
        let favorite: bool = sql(r.get(3))?;
        if q.favorites_only && !favorite
            || q.decade.is_some_and(|d| {
                contract::effective_release_year(&i)
                    .is_none_or(|y| y < d || y > legacy::decade_end(d))
            })
            || !q.language_mode.includes(&i.languages)
        {
            continue;
        }
        let content = match i.content_type.as_str() {
            "tv" => legacy::ContentType::Tv,
            "movie" => legacy::ContentType::Movie,
            "short" => legacy::ContentType::Short,
            _ => legacy::ContentType::Unknown,
        };
        if q.content_type != legacy::ContentType::All && q.content_type != content {
            continue;
        }
        let Some(basis) = matches(&i, &q.query)? else {
            continue;
        };
        result.push(legacy::Title {
            title_ref: sql(r.get(0))?,
            title: i.title,
            kind: if content == legacy::ContentType::Tv {
                "tv"
            } else {
                "movie"
            }
            .into(),
            content_type: content,
            content_type_provenance: if content == legacy::ContentType::Unknown {
                "unknown"
            } else {
                "provider-item"
            },
            provider_series: None,
            artwork: None,
            release_year,
            date_assessment: None,
            curated: false,
            favorite,
            title_provenance: "provider-item",
            provider_languages: i.languages.clone(),
            provider_subjects: i.subjects,
            provider_description: i.description,
            language_provenance: if i.languages.is_empty() {
                "unknown"
            } else {
                "provider-item"
            },
            match_basis: basis,
            file_count: sql(r.get(4))?,
            duration_seconds: None,
            rights: i.rights,
            rank: 0,
            quality: "metadata-listed",
            observed_ms: sql(r.get(2))?,
            provider_id: Some(i.provider.id().into()),
            source_url: Some(i.source_url),
        });
    }
    Ok(result)
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Facts {
    pub provider_id: String,
    pub source_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_claims: Option<contract::ProviderDateClaims>,
    pub mime_type: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub representation_role: Option<String>,
    pub content_role: Option<String>,
    pub rights: Option<String>,
    pub license_url: Option<String>,
    pub attribution: Option<String>,
    pub download_allowed: Option<bool>,
    pub access_restricted: Option<bool>,
    pub playback_candidate: bool,
    pub download_supported: bool,
    pub unsupported_reason: Option<String>,
}
pub(crate) fn candidate(i: &ProviderItem, v: &ProviderVariant) -> bool {
    if i.access_restricted == Some(true) {
        return false;
    }
    match v
        .mime_type
        .as_deref()
        .map(|s| {
            s.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .as_deref()
    {
        Some("video/mp4" | "video/webm") => true,
        None => net::media_url(i.provider, &i.item_id, &v.target_url)
            .is_ok_and(|u| u.path().ends_with(".mp4") || u.path().ends_with(".webm")),
        _ => false,
    }
}
fn facts(i: &ProviderItem, v: &ProviderVariant) -> Facts {
    let playable = candidate(i, v);
    Facts {
        provider_id: i.provider.id().into(),
        source_url: i.source_url.clone(),
        date_claims: i.date_claims.clone(),
        mime_type: v.mime_type.clone(),
        video_codec: v.video_codec.clone(),
        audio_codec: v.audio_codec.clone(),
        width: v.width,
        height: v.height,
        representation_role: v.representation_role.clone(),
        content_role: v.content_role.clone(),
        rights: i.rights.clone(),
        license_url: i.license_url.as_deref().and_then(net::license_reference),
        attribution: i.attribution.clone(),
        download_allowed: i.download_allowed,
        access_restricted: i.access_restricted,
        playback_candidate: playable,
        download_supported: false,
        unsupported_reason: if playable {
            None
        } else {
            Some(
                if i.access_restricted == Some(true) {
                    "Provider access is restricted."
                } else {
                    "This representation is listed for information; this player does not support its format."
                }
                .into(),
            )
        },
    }
}
pub(crate) fn title_exists(c: &Connection, tr: &str) -> Result<bool, String> {
    if !installed(c)? {
        return Ok(false);
    }
    sql(c.query_row("SELECT EXISTS(SELECT 1 FROM public_archive_item_v1 WHERE title_ref=?1) OR EXISTS(SELECT 1 FROM public_archive_removal_v1 WHERE scope='title' AND reference=?1)",[tr],|r|r.get(0)))
}
pub(crate) fn file_exists(c: &Connection, fr: &str) -> Result<bool, String> {
    if !installed(c)? {
        return Ok(false);
    }
    sql(c.query_row("SELECT EXISTS(SELECT 1 FROM public_archive_variant_v1 WHERE file_ref=?1) OR EXISTS(SELECT 1 FROM public_archive_removal_v1 WHERE scope='file' AND reference=?1)",[fr],|r|r.get(0)))
}
pub(crate) fn files(
    c: &Connection,
    q: &legacy::FilesQuery,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<legacy::FilesPage, String> {
    let tx = sql(c.unchecked_transaction())?;
    let rev = legacy::current(&tx)?;
    if rev != legacy::revision(&q.expected_revision)? {
        return Err("archive-revision-stale".into());
    }
    let raw: String = sql(tx.query_row(
        "SELECT document FROM public_archive_item_v1 WHERE title_ref=?1",
        [&q.title_ref],
        |r| r.get(0),
    ))?;
    let i = decode_item(&raw)?;
    let total: usize = sql(tx.query_row(
        "SELECT count(*) FROM public_archive_variant_v1 WHERE title_ref=?1",
        [&q.title_ref],
        |r| r.get::<_, u32>(0).map(|n| n as usize),
    ))?;
    if total > 1000 {
        return Err("archive-file-limit".into());
    }
    let mut s=sql(tx.prepare("SELECT v.file_ref,v.document,v.observed_ms FROM public_archive_variant_v1 v JOIN public_archive_item_v1 i ON i.title_ref=v.title_ref WHERE v.title_ref=?1 ORDER BY v.variant_id LIMIT ?2 OFFSET ?3"))?;
    let mut rs = sql(s.query(params![q.title_ref, q.page_size as i64, q.offset as i64]))?;
    let mut files = Vec::new();
    while let Some(r) = sql(rs.next())? {
        check()?;
        let raw: String = sql(r.get(1))?;
        let v: ProviderVariant =
            serde_json::from_str(&raw).map_err(|_| "public-archive-metadata-invalid")?;
        files.push(legacy::FileRow {
            file_ref: sql(r.get(0))?,
            title: v
                .title
                .clone()
                .unwrap_or_else(|| legacy::file_name_label(&v.file_name)),
            file_name: v.file_name.clone(),
            item_id: i.item_id.clone(),
            format: v.mime_type.clone().unwrap_or_else(|| "Not listed".into()),
            duration_seconds: v.duration_seconds,
            size_bytes: v.size_bytes.clone(),
            availability: "unverified",
            observed_ms: sql(r.get(2))?,
            provider_facts: Some(facts(&i, &v)),
        });
    }
    drop(rs);
    drop(s);
    check()?;
    sql(tx.commit())?;
    Ok(legacy::FilesPage {
        schema_version: 1,
        revision: rev.to_string(),
        title_ref: q.title_ref.clone(),
        total_count: total,
        offset: q.offset,
        more: q.offset + files.len() < total,
        files,
    })
}
#[derive(Clone, Debug)]
pub(crate) struct Resolved {
    pub item: ProviderItem,
    pub variant: ProviderVariant,
    pub title_ref: String,
    pub fingerprint: String,
}
pub(crate) fn resolve(c: &Connection, reference: &str) -> Result<legacy::ResolvedFile, String> {
    let(raw,vr):(String,String)=sql(c.query_row("SELECT i.document,v.document FROM public_archive_variant_v1 v JOIN public_archive_item_v1 i ON i.title_ref=v.title_ref WHERE v.file_ref=?1",[reference],|r|Ok((r.get(0)?,r.get(1)?))))?;
    let item = decode_item(&raw)?;
    let variant: ProviderVariant =
        serde_json::from_str(&vr).map_err(|_| "public-archive-metadata-invalid")?;
    if contract::file_ref(item.provider, &item.item_id, &variant) != reference
        || !candidate(&item, &variant)
    {
        return Err("public-archive-format-unsupported".into());
    }
    let title_ref = contract::title_ref(item.provider, &item.item_id);
    if removed(c, "title", &title_ref)? || removed(c, "file", reference)? {
        return Err("archive-file-unavailable".into());
    }
    let proof = Resolved {
        fingerprint: selected_fingerprint(&raw, &vr)?,
        title_ref,
        item: item.clone(),
        variant: variant.clone(),
    };
    Ok(legacy::ResolvedFile {
        item_id: item.item_id,
        file_name: variant.file_name,
        size_bytes: variant.size_bytes.unwrap_or_default(),
        sha1: variant.sha1,
        servers: Vec::new(),
        duration_seconds: variant.duration_seconds,
        provider_index: None,
        public: Some(proof),
    })
}
fn selected_fingerprint(raw: &str, variant: &str) -> Result<String, String> {
    // Date claims cannot grant playback authority. Keep every other retained
    // header value and the exact variant proof in the pinned selection.
    let mut header: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "public-archive-metadata-invalid")?;
    let fields = header
        .as_object_mut()
        .ok_or("public-archive-metadata-invalid")?;
    if fields.get("provider").and_then(serde_json::Value::as_str) != Some("nasa") {
        return Ok(legacy::opaque(&[
            "public-archive-selected-v1",
            raw,
            variant,
        ]));
    }
    fields.remove("release_year");
    fields.remove("date_claims");
    let proof = serde_json::to_string(&header).map_err(|_| "public-archive-metadata-invalid")?;
    Ok(legacy::opaque(&[
        "public-archive-selected-v2",
        &proof,
        variant,
    ]))
}
pub(crate) fn verify_live(c: &Connection, r: &str, expected: &Resolved) -> Result<(), String> {
    let live = resolve(c, r)?;
    if live
        .public
        .as_ref()
        .is_none_or(|v| v.fingerprint != expected.fingerprint)
    {
        return Err("archive-file-changed".into());
    }
    Ok(())
}
pub(crate) fn set_favorite(
    c: &mut Connection,
    r: &legacy::FavoriteRequest,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<legacy::FavoriteReceipt, String> {
    let tx = sql(c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
    let old = legacy::current(&tx)?;
    if old != legacy::revision(&r.expected_revision)? {
        return Err("archive-revision-stale".into());
    }
    let actual: bool = sql(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM public_archive_item_v1 WHERE title_ref=?1)",
        [&r.title_ref],
        |row| row.get(0),
    ))?;
    if !actual && r.value {
        return Err("archive-title-unavailable".into());
    }
    let saved: Option<bool> = sql(tx
        .query_row(
            "SELECT favorite FROM public_archive_preference_v1 WHERE title_ref=?1",
            [&r.title_ref],
            |r| r.get(0),
        )
        .optional())?;
    let mut rev = old;
    if saved.unwrap_or(false) != r.value {
        rev = old.checked_add(1).ok_or("archive-revision-exhausted")?;
        sql(tx.execute(
            "INSERT INTO public_archive_preference_v1 VALUES(?1,?2) ON CONFLICT(title_ref) DO UPDATE SET favorite=excluded.favorite",
            params![r.title_ref, r.value],
        ))?;
        sql(tx.execute(
            "UPDATE archive_catalog_meta_v1 SET revision=?1 WHERE singleton=1",
            [rev],
        ))?;
    }
    bounds(&tx)?;
    crate::archive_library_store::finalize(&tx, false, check)?;
    check()?;
    sql(tx.commit())?;
    Ok(legacy::FavoriteReceipt {
        schema_version: 1,
        committed: true,
        revision: rev.to_string(),
        title_ref: r.title_ref.clone(),
        favorite: r.value,
    })
}
/// Called inside the legacy removal transaction; clear remains one atomic scope.
pub(crate) fn remove_in_transaction(
    c: &Connection,
    scope: &legacy::RemovalScope,
    title: Option<&str>,
    receipt: &mut legacy::RemovalReceipt,
) -> Result<bool, String> {
    if !installed(c)? {
        return Ok(false);
    }
    let count =
        |table: &str, where_clause: &str, args: &[&dyn rusqlite::ToSql]| -> Result<usize, String> {
            sql(c.query_row(
                &format!("SELECT count(*) FROM {table} {where_clause}"),
                args,
                |r| r.get::<_, u32>(0).map(|n| n as usize),
            ))
        };
    match scope {
        legacy::RemovalScope::All => {
            receipt.removed_titles += count("public_archive_item_v1", "", &[])?;
            receipt.removed_files += count("public_archive_variant_v1", "", &[])?;
            receipt.removed_favorites +=
                count("public_archive_preference_v1", "WHERE favorite=1", &[])?;
            receipt.cleared_progress += count("public_archive_checkpoint_v1", "", &[])?;
            for table in [
                "public_archive_variant_v1",
                "public_archive_item_v1",
                "public_archive_preference_v1",
                "public_archive_removal_v1",
                "public_archive_checkpoint_v1",
            ] {
                sql(c.execute(&format!("DELETE FROM {table}"), []))?;
            }
            Ok(true)
        }
        legacy::RemovalScope::TitleRef(r) => {
            if !title_exists(c, r)? {
                return Ok(false);
            }
            receipt.removed_files = count("public_archive_variant_v1", "WHERE title_ref=?1", &[r])?;
            receipt.removed_favorites = count(
                "public_archive_preference_v1",
                "WHERE title_ref=?1 AND favorite=1",
                &[r],
            )?;
            sql(c.execute(
                "INSERT OR IGNORE INTO public_archive_removal_v1 VALUES('title',?1,?1)",
                [r],
            ))?;
            sql(c.execute(
                "DELETE FROM public_archive_preference_v1 WHERE title_ref=?1",
                [r],
            ))?;
            receipt.removed_titles =
                sql(c.execute("DELETE FROM public_archive_item_v1 WHERE title_ref=?1", [r]))?;
            Ok(true)
        }
        legacy::RemovalScope::FileRef(r) => {
            if !file_exists(c, r)? {
                return Ok(false);
            }
            let tr:Option<String>=sql(c.query_row("SELECT title_ref FROM public_archive_variant_v1 WHERE file_ref=?1 UNION SELECT title_ref FROM public_archive_removal_v1 WHERE scope='file' AND reference=?1",[r],|r|r.get(0)).optional())?;
            if tr.as_deref() != title {
                return Err("archive-removal-scope-invalid".into());
            }
            sql(c.execute(
                "INSERT OR IGNORE INTO public_archive_removal_v1 VALUES('file',?1,?2)",
                params![r, title],
            ))?;
            receipt.removed_files = sql(c.execute(
                "DELETE FROM public_archive_variant_v1 WHERE file_ref=?1",
                [r],
            ))?;
            Ok(true)
        }
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Cursor {
    pub cursor: Option<String>,
    pub next_cursor: Option<String>,
    pub pending: Vec<contract::SearchHit>,
    pub started: bool,
    pub complete: bool,
    pub retry_after_ms: Option<i64>,
}
pub(crate) fn cursor(
    c: &Connection,
    scope: &str,
    p: Provider,
    restart: bool,
) -> Result<Cursor, String> {
    if restart {
        return Ok(Cursor::default());
    }
    let raw: Option<String> = sql(c
        .query_row(
            "SELECT document FROM public_archive_checkpoint_v1 WHERE scope=?1 AND provider=?2",
            params![scope, p.id()],
            |r| r.get(0),
        )
        .optional())?;
    match raw {
        None => Ok(Cursor::default()),
        Some(s) if s.len() <= 524288 => {
            let value: Cursor =
                serde_json::from_str(&s).map_err(|_| "public-archive-progress-invalid")?;
            validate_cursor(p, &value)?;
            Ok(value)
        }
        _ => Err("public-archive-progress-invalid".into()),
    }
}
pub(crate) fn save_cursor(
    c: &Connection,
    scope: &str,
    p: Provider,
    cursor: &Cursor,
) -> Result<(), String> {
    validate_cursor(p, cursor)?;
    let raw = serde_json::to_string(cursor).map_err(|_| "public-archive-progress-invalid")?;
    if raw.len() > 524288
        || cursor.pending.len() > 4
        || cursor.cursor.as_ref().is_some_and(|s| s.len() > 2048)
        || cursor.next_cursor.as_ref().is_some_and(|s| s.len() > 2048)
    {
        return Err("public-archive-progress-limit".into());
    }
    sql(c.execute(
        "INSERT INTO public_archive_checkpoint_v1 VALUES(?1,?2,?3) ON CONFLICT(scope,provider) DO UPDATE SET document=excluded.document",
        params![scope, p.id(), raw],
    ))?;
    bounds(c)
}
fn validate_cursor(p: Provider, c: &Cursor) -> Result<(), String> {
    if c.pending.len() > 4
        || c.complete
            && (!c.started
                || !c.pending.is_empty()
                || c.cursor.is_some()
                || c.next_cursor.is_some())
        || c.cursor.as_ref().is_some_and(|s| !contract::plain(s, 2048))
        || c.next_cursor
            .as_ref()
            .is_some_and(|s| !contract::plain(s, 2048))
        || c.retry_after_ms
            .is_some_and(|n| !(0..=9_007_199_254_740_991).contains(&n))
    {
        return Err("public-archive-progress-invalid".into());
    }
    let mut ids = std::collections::HashSet::new();
    for hit in &c.pending {
        if !contract::item_id(p, &hit.item_id)
            || !contract::plain(&hit.title, 512)
            || !ids.insert(&hit.item_id)
            || serde_json::to_vec(&hit.search_document)
                .map_err(|_| "public-archive-progress-invalid")?
                .len()
                > 256 * 1024
        {
            return Err("public-archive-progress-invalid".into());
        }
        net::source_url(p, &hit.item_id, &hit.source_url)?;
        net::metadata_url(p, &hit.metadata_url)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_public_filename_keeps_exact_identity_and_bounded_utf8_display_label() {
        let c = db();
        let mut item = item(Provider::Loc, "longname", "Long filename");
        item.variants[0].file_name = format!("{}episode.mp4", "界".repeat(220));
        let reference = contract::file_ref(item.provider, &item.item_id, &item.variants[0]);
        upsert(&c, &item, 1).unwrap();
        let page = legacy::files(
            &c,
            &legacy::FilesQuery {
                schema_version: 1,
                request_id: "fixture".into(),
                title_ref: contract::title_ref(item.provider, &item.item_id),
                expected_revision: "0".into(),
                offset: 0,
                page_size: 50,
            },
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(page.files[0].file_ref, reference);
        assert_eq!(page.files[0].file_name, item.variants[0].file_name);
        assert!(page.files[0].title.len() <= 512);
        assert!(page.files[0].title.ends_with("episode.mp4"));
        assert!(page.files[0].title.contains('…'));
    }
    fn db() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        let tx = c.transaction().unwrap();
        legacy::install(&tx).unwrap();
        crate::archive_bookmarks::install(&tx).unwrap();
        install(&tx).unwrap();
        tx.commit().unwrap();
        c
    }
    fn variant(id: &str, url: &str, mime: Option<&str>) -> ProviderVariant {
        ProviderVariant {
            asset_id: "part".into(),
            variant_id: id.into(),
            file_name: id.into(),
            title: None,
            target_url: url.into(),
            mime_type: mime.map(str::to_owned),
            video_codec: None,
            audio_codec: None,
            size_bytes: None,
            sha1: None,
            duration_seconds: None,
            width: None,
            height: None,
            representation_role: None,
            content_role: None,
            original_variant_id: None,
        }
    }
    fn item(p: Provider, id: &str, title: &str) -> ProviderItem {
        ProviderItem {
            provider: p,
            item_id: id.into(),
            title: title.into(),
            source_url: match p {
                Provider::Loc => format!("https://www.loc.gov/item/{id}/"),
                Provider::Nasa => {
                    format!("https://images-assets.nasa.gov/video/{id}/collection.json")
                }
                Provider::Commons => {
                    format!("https://commons.wikimedia.org/w/index.php?curid={id}")
                }
            },
            metadata_url: match p {
                Provider::Loc => format!("https://www.loc.gov/item/{id}/?fo=json"),
                Provider::Nasa => format!("https://images-api.nasa.gov/asset/{id}"),
                Provider::Commons => "https://commons.wikimedia.org/w/api.php".into(),
            },
            description: None,
            subjects: vec![],
            creators: vec![],
            languages: vec![],
            release_year: None,
            date_claims: None,
            content_type: "unknown".into(),
            rights: Some("Rights not independently verified".into()),
            license_url: None,
            attribution: None,
            access_restricted: None,
            download_allowed: None,
            revision: None,
            variants: vec![variant(
                "movie.mp4",
                &match p {
                    Provider::Loc => {
                        "https://tile.loc.gov/storage-services/service/movie.mp4".into()
                    }
                    Provider::Nasa => format!("http://images-assets.nasa.gov/video/{id}/movie.mp4"),
                    Provider::Commons => {
                        "https://upload.wikimedia.org/wikipedia/commons/a/ab/movie.webm".into()
                    }
                },
                None,
            )],
        }
    }
    fn q() -> legacy::Query {
        legacy::Query {
            schema_version: 1,
            request_id: "fixture".into(),
            query: String::new(),
            expected_revision: None,
            offset: 0,
            page_size: 50,
            curated_only: false,
            decade: None,
            favorites_only: false,
            language_mode: legacy::LanguageMode::All,
            content_type: legacy::ContentType::All,
        }
    }
    #[test]
    fn provider_ids_do_not_collide_or_rewrite_ia_refs() {
        let c = db();
        let a = item(Provider::Loc, "same", "Same title");
        let b = item(Provider::Nasa, "same", "Same title");
        upsert(&c, &a, 1).unwrap();
        upsert(&c, &b, 1).unwrap();
        let page = legacy::query(&c, &q(), &mut || Ok(())).unwrap();
        assert_eq!(page.total_count, 2);
        assert_ne!(page.items[0].title_ref, page.items[1].title_ref);
        assert!(!page
            .items
            .iter()
            .any(|r| r.title_ref == legacy::opaque(&["archive-item-v1", "same"])));
        assert!(page
            .items
            .iter()
            .all(|r| r.rank == 0 && r.quality == "metadata-listed"));
    }
    #[test]
    fn unsupported_and_unknown_variants_stay_browsable_without_borrowed_size() {
        let c = db();
        let mut i = item(Provider::Loc, "disc", "Classic archive");
        i.variants.push(variant(
            "disc.iso",
            "https://tile.loc.gov/storage-services/service/disc.iso",
            Some("application/x-iso9660-image"),
        ));
        upsert(&c, &i, 1).unwrap();
        let tr = contract::title_ref(i.provider, &i.item_id);
        let page = legacy::files(
            &c,
            &legacy::FilesQuery {
                schema_version: 1,
                request_id: "fixture".into(),
                title_ref: tr,
                expected_revision: "0".into(),
                offset: 0,
                page_size: 50,
            },
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(page.total_count, 2);
        let iso = page
            .files
            .iter()
            .find(|f| f.file_name == "disc.iso")
            .unwrap();
        assert!(iso.size_bytes.is_none());
        assert!(!iso.provider_facts.as_ref().unwrap().playback_candidate);
        assert!(!iso.provider_facts.as_ref().unwrap().download_supported);
        let mp4 = page
            .files
            .iter()
            .find(|f| f.file_name == "movie.mp4")
            .unwrap();
        assert!(mp4.size_bytes.is_none());
        assert!(mp4.provider_facts.as_ref().unwrap().playback_candidate);
        let resolved = legacy::resolve(&c, &mp4.file_ref, "0").unwrap();
        assert!(crate::archive_bookmarks::capture(&mp4.file_ref, &resolved).is_err());
        assert!(legacy::resolve_download(&c, &mp4.file_ref, "0").is_err());
    }
    #[test]
    fn favorite_and_tombstone_survive_refresh_and_stale_cas() {
        let mut c = db();
        let i = item(Provider::Loc, "favorite", "Chosen title");
        upsert(&c, &i, 1).unwrap();
        let tr = contract::title_ref(i.provider, &i.item_id);
        let r = legacy::set_favorite(
            &mut c,
            &legacy::FavoriteRequest {
                schema_version: 1,
                request_id: "fixture".into(),
                title_ref: tr.clone(),
                expected_revision: "0".into(),
                value: true,
            },
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(r.revision, "1");
        assert!(legacy::query(&c, &q(), &mut || Ok(())).unwrap().items[0].favorite);
        assert!(legacy::remove(
            &mut c,
            &legacy::RemovalScope::TitleRef(tr.clone()),
            None,
            "0",
            &mut || Ok(())
        )
        .is_err());
        let receipt = legacy::remove(
            &mut c,
            &legacy::RemovalScope::TitleRef(tr),
            None,
            "1",
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(receipt.removed_titles, 1);
        assert!(!upsert(&c, &i, 2).unwrap());
        assert!(legacy::set_favorite(
            &mut c,
            &legacy::FavoriteRequest {
                schema_version: 1,
                request_id: "fixture".into(),
                title_ref: contract::title_ref(i.provider, &i.item_id),
                expected_revision: receipt.revision,
                value: true
            },
            &mut || Ok(())
        )
        .is_err());
        assert_eq!(
            legacy::query(&c, &q(), &mut || Ok(())).unwrap().total_count,
            0
        );
    }
    #[test]
    fn failed_transaction_does_not_advance_cursor_or_insert_partial_items() {
        let mut c = db();
        let key = "a".repeat(64);
        let t = c.transaction().unwrap();
        let state = Cursor {
            started: true,
            complete: true,
            ..Default::default()
        };
        save_cursor(&t, &key, Provider::Loc, &state).unwrap();
        let i = item(Provider::Loc, "rolledback", "Before commit");
        upsert(&t, &i, 1).unwrap();
        drop(t);
        assert!(!cursor(&c, &key, Provider::Loc, false).unwrap().complete);
        assert_eq!(
            legacy::query(&c, &q(), &mut || Ok(())).unwrap().total_count,
            0
        );
    }
    #[test]
    fn query_filters_use_actual_type_year_and_contradiction_rules() {
        let c = db();
        let mut good = item(Provider::Loc, "animation", "Classic cartoon");
        good.subjects = vec!["Animated films".into()];
        good.content_type = "short".into();
        good.release_year = Some(1965);
        let mut concert = item(Provider::Nasa, "concert", "Opera Bell Band");
        concert.subjects = vec!["Film & Animation".into()];
        upsert(&c, &good, 1).unwrap();
        upsert(&c, &concert, 1).unwrap();
        let mut query = q();
        query.query = "Cartoon".into();
        query.decade = Some(1960);
        let page = legacy::query(&c, &query, &mut || Ok(())).unwrap();
        assert_eq!(page.total_count, 1);
        assert_eq!(page.items[0].title, "Classic cartoon");
        query.curated_only = true;
        assert_eq!(
            legacy::query(&c, &query, &mut || Ok(()))
                .unwrap()
                .total_count,
            0
        );
    }

    #[test]
    fn nasa_legacy_year_is_unknown_in_saved_projection_without_rewriting_rows() {
        let c = db();
        let mut saved = item(Provider::Nasa, "legacy", "Apollo legacy");
        saved.release_year = Some(1985);
        upsert(&c, &saved, 1).unwrap();
        let title = contract::title_ref(saved.provider, &saved.item_id);
        c.execute(
            "INSERT INTO public_archive_preference_v1 VALUES(?1,1)",
            [&title],
        )
        .unwrap();
        let before = crate::archive_library_store::source_fingerprint(&c, &mut || Ok(())).unwrap();
        let page = legacy::query(&c, &q(), &mut || Ok(())).unwrap();
        assert_eq!(page.total_count, 1);
        assert!(page.items[0].favorite);
        assert_eq!(page.items[0].release_year, None);
        for decade in [1960, 1970, 1980, 1990, 2000, 2010, 2020] {
            let mut query = q();
            query.decade = Some(decade);
            assert_eq!(
                legacy::query(&c, &query, &mut || Ok(()))
                    .unwrap()
                    .total_count,
                0
            );
        }
        let raw: String = c
            .query_row(
                "SELECT document FROM public_archive_item_v1 WHERE title_ref=?1",
                [&title],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(decode_item(&raw).unwrap().release_year, Some(1985));
        assert!(decode_item(&raw).unwrap().date_claims.is_none());
        assert_eq!(
            crate::archive_library_store::source_fingerprint(&c, &mut || Ok(())).unwrap(),
            before
        );
    }

    #[test]
    fn nasa_date_only_refresh_preserves_selection_but_authority_changes_revoke() {
        let c = db();
        let mut saved = item(Provider::Nasa, "apollo", "Apollo");
        saved.release_year = Some(1985);
        upsert(&c, &saved, 1).unwrap();
        let reference = contract::file_ref(saved.provider, &saved.item_id, &saved.variants[0]);
        let selected = resolve(&c, &reference).unwrap().public.unwrap();
        saved.release_year = None;
        saved.date_claims = contract::nasa_date_claim("2021-01-30T00:00:00Z");
        upsert(&c, &saved, 2).unwrap();
        verify_live(&c, &reference, &selected).unwrap();
        assert_eq!(
            resolve(&c, &reference)
                .unwrap()
                .public
                .unwrap()
                .item
                .date_claims
                .unwrap()
                .provider_created
                .value,
            "2021-01-30T00:00:00Z"
        );
        for mode in [
            "target", "access", "revision", "size", "checksum", "asset", "variant", "identity",
        ] {
            let mut changed = saved.clone();
            match mode {
                "target" => {
                    changed.variants[0].target_url =
                        "https://images-assets.nasa.gov/video/apollo/other.mp4".into()
                }
                "access" => changed.access_restricted = Some(true),
                "revision" => changed.revision = Some("new-source-revision".into()),
                "size" => changed.variants[0].size_bytes = Some("100".into()),
                "checksum" => changed.variants[0].sha1 = Some("b".repeat(40)),
                "asset" => changed.variants[0].asset_id = "other-asset".into(),
                "variant" => changed.variants[0].variant_id = "other-variant".into(),
                "identity" => changed.item_id = "other".into(),
                _ => unreachable!(),
            }
            // Compare authority directly for identities that intentionally map
            // to a different opaque reference; no title-similarity fallback.
            let mut header = changed.clone();
            header.variants.clear();
            assert_ne!(
                selected.fingerprint,
                selected_fingerprint(
                    &serde_json::to_string(&header).unwrap(),
                    &serde_json::to_string(&changed.variants[0]).unwrap()
                )
                .unwrap(),
                "{mode}"
            );
            if !matches!(mode, "asset" | "variant" | "identity") {
                upsert(&c, &changed, 3).unwrap();
                assert!(verify_live(&c, &reference, &selected).is_err(), "{mode}");
                upsert(&c, &saved, 4).unwrap();
            }
        }
        c.execute(
            "INSERT INTO public_archive_removal_v1 VALUES('file',?1,?2)",
            params![reference, selected.title_ref],
        )
        .unwrap();
        assert!(verify_live(&c, &reference, &selected).is_err());
    }

    #[test]
    fn non_nasa_selection_retains_exact_legacy_raw_header_proof() {
        for (provider, id) in [(Provider::Loc, "film"), (Provider::Commons, "123")] {
            let c = db();
            let mut saved = item(provider, id, "Original work");
            saved.release_year = Some(1965);
            upsert(&c, &saved, 1).unwrap();
            let reference = contract::file_ref(provider, id, &saved.variants[0]);
            let selected = resolve(&c, &reference).unwrap().public.unwrap();
            let (raw, variant): (String, String) = c.query_row("SELECT i.document,v.document FROM public_archive_item_v1 i JOIN public_archive_variant_v1 v ON v.title_ref=i.title_ref WHERE v.file_ref=?1", [&reference], |r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(
                selected.fingerprint,
                legacy::opaque(&["public-archive-selected-v1", &raw, &variant])
            );
            saved.release_year = Some(2021);
            upsert(&c, &saved, 2).unwrap();
            assert!(verify_live(&c, &reference, &selected).is_err());
            upsert(&c, &item(provider, id, "Original work"), 3).unwrap();
            let selected = resolve(&c, &reference).unwrap().public.unwrap();
            c.execute(
                "UPDATE public_archive_item_v1 SET document=' '||document||' '",
                [],
            )
            .unwrap();
            assert!(verify_live(&c, &reference, &selected).is_err());
        }
    }

    #[test]
    fn date_claim_versions_and_field_bounds_are_not_corruption_recovery_errors() {
        let mut i = item(Provider::Nasa, "apollo", "Apollo");
        i.date_claims = contract::nasa_date_claim("2021-01-30T00:00:00Z");
        i.date_claims.as_mut().unwrap().schema_version = 2;
        assert_eq!(
            decode_item(&serde_json::to_string(&i).unwrap()).unwrap_err(),
            "public-archive-metadata-version-unsupported"
        );
        i.date_claims.as_mut().unwrap().schema_version = 1;
        for value in [
            "2021-02-30T00:00:00Z",
            "2021-01-30T00:00:00Z\n",
            "2021",
            "0000-01-01T00:00:00Z",
        ] {
            i.date_claims.as_mut().unwrap().provider_created.value = value.into();
            assert!(
                decode_item(&serde_json::to_string(&i).unwrap()).is_err(),
                "{value}"
            );
        }
        for value in [
            "2020-02-29T00:00:00Z",
            "2021-01-30T01:02:03.123456789+05:30",
        ] {
            assert!(contract::provider_created_value(value), "{value}");
        }
    }
}
