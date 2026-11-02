// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
//! Metadata-only admission of equivalent live feeds. Never opens a stream.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PublicQuery {
    channel_id: String,
    catalog_revision: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicReply {
    channel_id: String,
    catalog_revision: String,
    valid_until_ms: Option<i64>,
    candidates: Vec<String>,
}
fn number(raw: &str) -> Result<i64, String> {
    let n = raw
        .parse::<i64>()
        .map_err(|_| "equivalent-source-invalid")?;
    if n < 0 || n.to_string() != raw {
        return Err("equivalent-source-invalid".into());
    }
    Ok(n)
}
fn identity(raw: &str) -> Result<(), String> {
    if raw.is_empty() || raw.len() > 16_384 || raw.chars().any(char::is_control) {
        Err("equivalent-source-invalid".into())
    } else {
        Ok(())
    }
}
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|_| "equivalent-source-storage".into())
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}
/// Browse grouping supplies PPV evidence across exact aliases. If that derived
/// authority is unavailable, the caller keeps its original source only.
fn public_ppv_cohorts(
    c: &Connection,
    candidates: &[String],
) -> Result<Option<std::collections::HashMap<String, bool>>, String> {
    let available: bool = sql(c.query_row(
        "SELECT count(*)=7 FROM sqlite_schema WHERE type='table' AND name IN ('catalog_endpoint_projection_v1','catalog_projection','catalog_projection_meta','channel_category_override','favorite','removed','guide_mapping')",
        [], |r| r.get(0),
    ))?;
    if !available || !crate::catalog_query::projection_is_current(c)? {
        return Ok(None);
    }
    let complete: bool = sql(c.query_row(
        "SELECT (SELECT count(*) FROM channel)=(SELECT count(*) FROM catalog_endpoint_projection_v1) AND (SELECT count(*) FROM channel)=(SELECT count(*) FROM catalog_projection)",
        [], |r| r.get(0),
    ))?;
    if !complete {
        return Ok(None);
    }
    crate::catalog::ppv::register(c)?;
    let evidence = crate::catalog::ppv::indexed_channel_group("c");
    let mut statement = sql(c.prepare(&format!("SELECT {evidence} FROM channel c JOIN catalog_endpoint_projection_v1 ep ON ep.channel_id=c.id WHERE c.id=?1")))?;
    let mut result = std::collections::HashMap::new();
    for id in candidates {
        let known: Option<bool> = sql(statement.query_row([id], |r| r.get(0)).optional())?;
        let Some(known) = known else { return Ok(None) };
        result.insert(id.clone(), known);
    }
    Ok(Some(result))
}
fn public(c: &Connection, q: PublicQuery, at: i64) -> Result<PublicReply, String> {
    identity(&q.channel_id)?;
    let revision = number(&q.catalog_revision)?;
    let tx = sql(c.unchecked_transaction())?;
    let actual: i64 = sql(tx.query_row(
        "SELECT catalog_revision FROM metadata WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    if actual != revision {
        return Err("equivalent-source-stale".into());
    }
    let mut reply = PublicReply {
        channel_id: q.channel_id.clone(),
        catalog_revision: q.catalog_revision,
        valid_until_ms: None,
        candidates: vec![q.channel_id.clone()],
    };
    // Exact canonical feed mapping plus matching known geography. Names and
    // generic programme titles never grant equivalence across regional feeds.
    let mapping: Option<(String, String)> = sql(tx
        .query_row(
            "SELECT m.guide_source_id,m.xmltv_channel_id FROM channel c
         JOIN guide_mapping m ON m.app_channel_id=c.id AND m.catalog_source_id=c.source_id
         JOIN guide_source s ON s.id=m.guide_source_id AND s.published_revision=s.revision
         WHERE c.id=?1 AND c.country IS NOT NULL AND c.country<>''
         AND NOT EXISTS(SELECT 1 FROM removed WHERE id=c.id)
         AND s.updated_ms BETWEEN ?2-172800000 AND ?2+300000",
            params![q.channel_id, at],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional())?;
    let Some((source, feed)) = mapping else {
        return Ok(reply);
    };
    let (count, end): (i64, Option<i64>) = sql(tx.query_row(
        "SELECT count(*),min(stop_ms) FROM guide_program
         WHERE guide_source_id=?1 AND channel_id=?2 AND start_ms<=?3 AND stop_ms>?3",
        params![source, feed, at],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    if count != 1 || end.is_none() {
        return Ok(reply);
    }
    let mut statement=sql(tx.prepare(
        "SELECT other.id FROM channel selected JOIN channel other
           ON other.country=selected.country AND other.region IS selected.region AND other.state IS selected.state
         JOIN guide_mapping m ON m.app_channel_id=other.id AND m.catalog_source_id=other.source_id
         WHERE selected.id=?1 AND m.guide_source_id=?2 AND m.xmltv_channel_id=?3
         AND NOT EXISTS(SELECT 1 FROM removed WHERE id=other.id)
         ORDER BY (other.id=?1) DESC,other.id LIMIT 16"))?;
    let candidates: Vec<String> = sql(sql(
        statement.query_map(params![q.channel_id, source, feed], |r| r.get(0))
    )?
    .collect())?;
    let Some(cohorts) = public_ppv_cohorts(&tx, &candidates)? else {
        return Ok(reply);
    };
    let Some(selected_ppv) = cohorts.get(&q.channel_id) else {
        return Ok(reply);
    };
    reply.candidates = candidates
        .into_iter()
        .filter(|id| cohorts.get(id) == Some(selected_ppv))
        .collect();
    reply.valid_until_ms = end;
    Ok(reply)
}

#[tauri::command]
pub(crate) async fn equivalent_live_channels(
    query: PublicQuery,
    app: tauri::AppHandle,
) -> Result<PublicReply, String> {
    let state = app.state::<crate::NativeState>();
    let work = state.admit_work()?;
    let owned = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let storage = owned.read().map_err(|_| "storage-lock")?;
        storage
            .as_ref()
            .map_err(Clone::clone)?
            .with_guide_read(|c| public(c, query, now()))
    })
    .await
    .map_err(|_| "equivalent-source-worker".to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PaidQuery {
    account_id: String,
    account_revision: String,
    media_revision: String,
    channel_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PaidReply {
    account_id: String,
    account_revision: String,
    media_revision: String,
    channel_id: String,
    valid_until_ms: Option<i64>,
    candidates: Vec<crate::account_media_store::Channel>,
}
// An additional restriction, never identity evidence on its own. Preserve all
// regional/delay qualifiers while allowing known transport/resolution labels.
fn paid_name(raw: &str) -> String {
    let mut words: Vec<String> = raw
        .split(|c: char| !c.is_alphanumeric())
        .filter(|v| !v.is_empty())
        .map(str::to_lowercase)
        .filter(|v| !["hd", "fhd", "uhd", "sd", "4k", "60fps", "30fps"].contains(&v.as_str()))
        .collect();
    while words
        .first()
        .is_some_and(|v| ["us", "usa", "tv", "raw", "the"].contains(&v.as_str()))
    {
        words.remove(0);
    }
    words.join(" ")
}
fn paid_ppv(
    c: &Connection,
    account: &str,
    row: &crate::account_media_store::Channel,
) -> Result<bool, String> {
    let effective: Option<String> = sql(c.query_row(
        "SELECT category FROM account_channel_preferences_v1 WHERE account_id=?1 AND channel_id=?2",
        params![account,row.id], |r| r.get::<_,Option<String>>(0),
    ).optional())?.flatten();
    Ok(crate::catalog::ppv::marked(&row.name)
        || crate::catalog::ppv::marked(&row.category)
        || effective
            .as_deref()
            .is_some_and(crate::catalog::ppv::marked))
}
fn paid(c: &Connection, q: PaidQuery, at: i64) -> Result<PaidReply, String> {
    identity(&q.account_id)?;
    identity(&q.channel_id)?;
    let ar = number(&q.account_revision)?;
    let mr = number(&q.media_revision)?;
    if ar == 0 || mr == 0 {
        return Err("equivalent-source-invalid".into());
    }
    let tx = sql(c.unchecked_transaction())?;
    let target: crate::account_media_store::Channel=sql(tx.query_row(
        "SELECT e.channel_id,e.name,e.category,e.provider_id,e.epg_id,e.stream_ref FROM account_media_entry_v1 e
         JOIN account_media_catalog_v1 cat ON cat.account_id=e.account_id
         JOIN account_vault_meta_v1 m ON m.id=cat.account_id AND m.revision=cat.account_revision AND m.secret_ref=cat.secret_ref
         JOIN account_vault_references_v1 r ON r.reference=e.stream_ref AND r.account_id=e.account_id AND r.account_revision=m.revision AND r.purpose='media'
         WHERE e.account_id=?1 AND e.channel_id=?2 AND m.revision=?3 AND cat.revision=?4
         AND NOT EXISTS(SELECT 1 FROM account_channel_preferences_v1 p WHERE p.account_id=e.account_id AND p.channel_id=e.channel_id AND p.removed=1)",
        params![q.account_id,q.channel_id,ar,mr],paid_row).optional())?.ok_or("equivalent-source-stale")?;
    let country = crate::accounts::group_country::group_country(&target.category);
    let name = paid_name(&target.name);
    let feed = target.epg_id.clone();
    let mut reply = PaidReply {
        account_id: q.account_id.clone(),
        account_revision: q.account_revision,
        media_revision: q.media_revision,
        channel_id: q.channel_id.clone(),
        valid_until_ms: None,
        candidates: vec![target],
    };
    let Some(country) = country else {
        return Ok(reply);
    };
    let Some(feed) = feed.filter(|f| !f.trim().is_empty()) else {
        return Ok(reply);
    };
    if name.is_empty() {
        return Ok(reply);
    }
    let (count,end):(i64,Option<i64>)=sql(tx.query_row(
        "SELECT count(*),min(p.stop_ms) FROM account_guide_program_v1 p JOIN account_guide_v1 g ON g.account_id=p.account_id
         WHERE p.account_id=?1 AND p.epg_id=?2 AND p.start_ms<=?3 AND p.stop_ms>?3
         AND g.account_revision=?4 AND g.fetched_ms BETWEEN ?3-172800000 AND ?3+300000",
        params![q.account_id,feed,at,ar],|r|Ok((r.get(0)?,r.get(1)?))))?;
    if count != 1 || end.is_none() {
        return Ok(reply);
    }
    let selected_ppv = paid_ppv(&tx, &q.account_id, &reply.candidates[0])?;
    let mut statement=sql(tx.prepare(
        "SELECT e.channel_id,e.name,e.category,e.provider_id,e.epg_id,e.stream_ref FROM account_media_entry_v1 e
         JOIN account_vault_references_v1 r ON r.reference=e.stream_ref AND r.account_id=e.account_id AND r.account_revision=?3 AND r.purpose='media'
         WHERE e.account_id=?1 AND e.epg_id=?2 AND e.channel_id<>?4
         AND NOT EXISTS(SELECT 1 FROM account_channel_preferences_v1 p WHERE p.account_id=e.account_id AND p.channel_id=e.channel_id AND p.removed=1)
         ORDER BY e.channel_id LIMIT 128"))?;
    let rows = sql(statement.query_map(params![q.account_id, feed, ar, q.channel_id], paid_row))?;
    for row in rows {
        let row = sql(row)?;
        if crate::accounts::group_country::group_country(&row.category).as_ref() == Some(&country)
            && paid_name(&row.name) == name
            && paid_ppv(&tx, &q.account_id, &row)? == selected_ppv
        {
            reply.candidates.push(row);
            if reply.candidates.len() == 16 {
                break;
            }
        }
    }
    reply.valid_until_ms = end;
    Ok(reply)
}
fn paid_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<crate::account_media_store::Channel> {
    Ok(crate::account_media_store::Channel {
        id: r.get(0)?,
        name: r.get(1)?,
        category: r.get(2)?,
        provider_id: r.get(3)?,
        epg_id: r.get(4)?,
        stream_reference: r.get(5)?,
    })
}
#[tauri::command]
pub(crate) async fn equivalent_paid_channels(
    query: PaidQuery,
    app: tauri::AppHandle,
) -> Result<PaidReply, String> {
    let state = app.state::<crate::NativeState>();
    let work = state.admit_work()?;
    let owned = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let storage = owned.read().map_err(|_| "storage-lock")?;
        storage
            .as_ref()
            .map_err(Clone::clone)?
            .with_guide_read(|c| paid(c, query, now()))
    })
    .await
    .map_err(|_| "equivalent-source-worker".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE metadata(singleton INTEGER,catalog_revision INTEGER);INSERT INTO metadata VALUES(1,7);
          CREATE TABLE channel(id TEXT PRIMARY KEY,source_id TEXT,country TEXT,region TEXT,state TEXT,name TEXT NOT NULL DEFAULT 'News',category TEXT NOT NULL DEFAULT 'News',ordinal INTEGER NOT NULL DEFAULT 0,provider_id TEXT);
          CREATE TABLE source(id TEXT PRIMARY KEY,allow_http INTEGER NOT NULL DEFAULT 0,content_kind TEXT,media_mime TEXT);
          INSERT INTO source(id) VALUES('a'),('b');
          CREATE TABLE channel_url(channel_id TEXT,ordinal INTEGER,url TEXT);
          CREATE TABLE favorite(id TEXT PRIMARY KEY);
          CREATE TABLE channel_category_override(channel_id TEXT PRIMARY KEY,category TEXT);
          CREATE TABLE removed(id TEXT);CREATE TABLE guide_mapping(catalog_source_id TEXT,app_channel_id TEXT,guide_source_id TEXT,xmltv_channel_id TEXT);
          CREATE TABLE guide_source(id TEXT,revision INTEGER,published_revision INTEGER,updated_ms INTEGER);
          CREATE TABLE guide_program(guide_source_id TEXT,channel_id TEXT,start_ms INTEGER,stop_ms INTEGER);
          INSERT INTO guide_source VALUES('guide',1,1,1000);
          INSERT INTO channel(id,source_id,country,region,state) VALUES('one','a','US',NULL,NULL),('two','b','US',NULL,NULL),('regional','b','US',NULL,'NY'),('unknown','b',NULL,NULL,NULL),('different-feed','b','US',NULL,NULL);
          INSERT INTO channel_url SELECT id,0,'https://fixture.invalid/'||id FROM channel;
          INSERT INTO guide_mapping VALUES('a','one','guide','feed'),('b','two','guide','feed'),('b','regional','guide','feed'),('b','unknown','guide','feed'),('b','different-feed','guide','other');
          INSERT INTO guide_program VALUES('guide','feed',1000,10000);").unwrap();
        let tx = c.unchecked_transaction().unwrap();
        crate::catalog_query::install_projection(&tx).unwrap();
        crate::catalog_endpoint_projection::install(&tx).unwrap();
        tx.commit().unwrap();
        c
    }
    fn query() -> PublicQuery {
        PublicQuery {
            channel_id: "one".into(),
            catalog_revision: "7".into(),
        }
    }
    fn refresh_public(c: &Connection) {
        let tx = c.unchecked_transaction().unwrap();
        crate::catalog_query::rebuild_projection(&tx).unwrap();
        tx.commit().unwrap();
    }
    #[test]
    fn public_equivalent_sources_preserve_ppv_cohort_and_exact_group_alias_evidence() {
        let c = fixture();
        c.execute_batch("UPDATE channel SET category='Sports PPV' WHERE id='two'")
            .unwrap();
        refresh_public(&c);
        assert_eq!(public(&c, query(), 2000).unwrap().candidates, ["one"]);
        let mut ppv = query();
        ppv.channel_id = "two".into();
        assert_eq!(public(&c, ppv, 2000).unwrap().candidates, ["two"]);
        c.execute_batch("INSERT INTO channel_category_override VALUES('two','Sports')")
            .unwrap();
        refresh_public(&c);
        assert_eq!(public(&c, query(), 2000).unwrap().candidates, ["one"]);
        // A PPV alias makes this exact logical catalog group PPV even when its
        // chosen representative's own title/category has no PPV marker.
        c.execute_batch("DELETE FROM channel_category_override;UPDATE channel_url SET url='https://fixture.invalid/shared' WHERE channel_id IN ('one','two')").unwrap();
        refresh_public(&c);
        assert_eq!(
            public(&c, query(), 2000).unwrap().candidates,
            ["one", "two"]
        );
    }
    #[test]
    fn public_unknown_ppv_projection_authority_never_admits_alternates() {
        for change in [
            "DELETE FROM catalog_endpoint_projection_v1 WHERE channel_id='one'",
            "DELETE FROM catalog_endpoint_projection_v1 WHERE channel_id='two'",
            "DROP TABLE catalog_endpoint_projection_v1",
            "UPDATE catalog_projection_meta SET query_version='unknown'",
        ] {
            let c = fixture();
            c.execute_batch(change).unwrap();
            assert_eq!(
                public(&c, query(), 2000).unwrap().candidates,
                ["one"],
                "{change}"
            );
        }
    }
    #[test]
    fn admits_same_canonical_feed_and_geography_without_reading_any_media() {
        let r = public(&fixture(), query(), 2000).unwrap();
        assert_eq!(r.candidates, vec!["one", "two"]);
        assert_eq!(r.valid_until_ms, Some(10000));
    }
    #[test]
    fn stale_overlap_missing_or_expired_programmes_do_not_grant_equivalence() {
        for change in [
            "DELETE FROM guide_program",
            "UPDATE guide_program SET stop_ms=1500",
            "UPDATE guide_source SET published_revision=0",
            "INSERT INTO guide_program VALUES('guide','feed',1500,9000)",
        ] {
            let c = fixture();
            c.execute_batch(change).unwrap();
            assert_eq!(public(&c, query(), 2000).unwrap().candidates, vec!["one"]);
        }
        assert_eq!(
            public(&fixture(), query(), 172802000).unwrap().candidates,
            vec!["one"]
        );
    }
    #[test]
    fn removed_candidates_and_old_catalog_revisions_are_rejected() {
        let c = fixture();
        c.execute_batch("INSERT INTO removed VALUES('two')")
            .unwrap();
        assert_eq!(public(&c, query(), 2000).unwrap().candidates, vec!["one"]);
        let mut q = query();
        q.catalog_revision = "6".into();
        assert!(public(&c, q, 2000).is_err());
    }
    #[test]
    fn paid_name_keeps_regional_and_delay_qualifiers() {
        assert_eq!(
            paid_name("TV RAW | The Weather Channel HD"),
            paid_name("US: WEATHER CHANNEL FHD")
        );
        assert_ne!(
            paid_name("US: Sports East HD"),
            paid_name("US: Sports West HD")
        );
        assert_ne!(
            paid_name("US: ABC New York HD"),
            paid_name("US: ABC Los Angeles HD")
        );
        assert_ne!(paid_name("US: ABC HD"), paid_name("US: ABC +1 HD"));
    }
    fn paid_fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE account_vault_meta_v1(id TEXT,revision INTEGER,secret_ref TEXT);
          CREATE TABLE account_media_catalog_v1(account_id TEXT,account_revision INTEGER,secret_ref TEXT,revision INTEGER);
          CREATE TABLE account_media_entry_v1(account_id TEXT,channel_id TEXT,name TEXT,category TEXT,provider_id TEXT,epg_id TEXT,stream_ref TEXT);
          CREATE TABLE account_vault_references_v1(reference TEXT,account_id TEXT,account_revision INTEGER,purpose TEXT);
          CREATE TABLE account_channel_preferences_v1(account_id TEXT,channel_id TEXT,removed INTEGER,category TEXT);
          CREATE TABLE account_guide_v1(account_id TEXT,account_revision INTEGER,fetched_ms INTEGER);
          CREATE TABLE account_guide_program_v1(account_id TEXT,epg_id TEXT,start_ms INTEGER,stop_ms INTEGER);
          INSERT INTO account_vault_meta_v1 VALUES('account',2,'secret');
          INSERT INTO account_media_catalog_v1 VALUES('account',2,'secret',3);
          INSERT INTO account_media_entry_v1 VALUES
            ('account','one','TV RAW | The Weather Channel','USA',NULL,'weather','r1'),
            ('account','two','US: WEATHER CHANNEL FHD','USA HD',NULL,'weather','r2'),
            ('account','west','US: Weather Channel West HD','USA',NULL,'weather','r3'),
            ('account','canada','Weather Channel','Canada',NULL,'weather','r4'),
            ('account','other','Weather Channel','USA',NULL,'other-feed','r5'),
            ('other-account','foreign','Weather Channel','USA',NULL,'weather','foreign');
          INSERT INTO account_vault_references_v1 VALUES('r1','account',2,'media'),('r2','account',2,'media'),('r3','account',2,'media'),('r4','account',2,'media'),('r5','account',2,'media');
          INSERT INTO account_guide_v1 VALUES('account',2,1000);
          INSERT INTO account_guide_program_v1 VALUES('account','weather',1000,10000);").unwrap();
        c
    }
    fn paid_query() -> PaidQuery {
        PaidQuery {
            account_id: "account".into(),
            account_revision: "2".into(),
            media_revision: "3".into(),
            channel_id: "one".into(),
        }
    }
    #[test]
    fn paid_equivalent_sources_preserve_raw_and_effective_ppv_cohorts() {
        let c = paid_fixture();
        c.execute_batch(
            "UPDATE account_media_entry_v1 SET category='USA | PPV' WHERE channel_id='two'",
        )
        .unwrap();
        let ids = |reply: PaidReply| {
            reply
                .candidates
                .into_iter()
                .map(|c| c.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(paid(&c, paid_query(), 2000).unwrap()), ["one"]);
        let mut ppv = paid_query();
        ppv.channel_id = "two".into();
        assert_eq!(ids(paid(&c, ppv, 2000).unwrap()), ["two"]);
        c.execute_batch(
            "INSERT INTO account_channel_preferences_v1 VALUES('account','two',0,'Sports')",
        )
        .unwrap();
        assert_eq!(ids(paid(&c, paid_query(), 2000).unwrap()), ["one"]);
        c.execute_batch("UPDATE account_media_entry_v1 SET category='USA' WHERE channel_id='two';UPDATE account_channel_preferences_v1 SET category='PPV' WHERE channel_id='two'").unwrap();
        assert_eq!(ids(paid(&c, paid_query(), 2000).unwrap()), ["one"]);
        c.execute_batch(
            "INSERT INTO account_channel_preferences_v1 VALUES('account','one',0,'PPV')",
        )
        .unwrap();
        assert_eq!(ids(paid(&c, paid_query(), 2000).unwrap()), ["one", "two"]);
    }
    #[test]
    fn paid_equivalence_requires_account_feed_country_and_regional_identity() {
        let result = paid(&paid_fixture(), paid_query(), 2000).unwrap();
        assert_eq!(
            result
                .candidates
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two"]
        );
        assert_eq!(result.valid_until_ms, Some(10000));
    }
    #[test]
    fn paid_stale_fences_revoked_capabilities_and_removed_candidates_do_not_enter_the_set() {
        let c = paid_fixture();
        let mut q = paid_query();
        q.media_revision = "2".into();
        assert!(paid(&c, q, 2000).is_err());
        c.execute_batch("INSERT INTO account_channel_preferences_v1(account_id,channel_id,removed) VALUES('account','two',1)")
            .unwrap();
        assert_eq!(paid(&c, paid_query(), 2000).unwrap().candidates.len(), 1);
        c.execute_batch("DELETE FROM account_channel_preferences_v1;DELETE FROM account_vault_references_v1 WHERE reference='r2'").unwrap();
        assert_eq!(paid(&c, paid_query(), 2000).unwrap().candidates.len(), 1);
    }
    #[test]
    fn paid_missing_or_overlapping_guide_does_not_grant_equivalence() {
        for change in [
            "DELETE FROM account_guide_program_v1",
            "INSERT INTO account_guide_program_v1 VALUES('account','weather',1500,9000)",
            "UPDATE account_guide_v1 SET account_revision=1",
        ] {
            let c = paid_fixture();
            c.execute_batch(change).unwrap();
            assert_eq!(paid(&c, paid_query(), 2000).unwrap().candidates.len(), 1);
        }
    }
}
