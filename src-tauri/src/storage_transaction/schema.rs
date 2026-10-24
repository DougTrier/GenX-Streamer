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

//! The database schema and its migrations: connecting, archive bindings,
//! geography, integrity checks and the content-library schema.

use super::*;

pub(super) const SCHEMA:&str="CREATE TABLE metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,catalog_present INTEGER NOT NULL,preferences_present INTEGER NOT NULL);
INSERT INTO metadata VALUES(1,0,0,0);
CREATE TABLE source(id TEXT PRIMARY KEY,name TEXT NOT NULL,location TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('url','file')),allow_http INTEGER NOT NULL CHECK(allow_http IN(0,1)),content_kind TEXT,media_mime TEXT,ordinal INTEGER NOT NULL);
CREATE TABLE channel(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES source(id),provider_id TEXT,name TEXT NOT NULL,category TEXT NOT NULL,ordinal INTEGER NOT NULL);
CREATE INDEX channel_source ON channel(source_id);CREATE INDEX channel_category ON channel(category);CREATE INDEX channel_name ON channel(name COLLATE NOCASE);
CREATE TABLE channel_url(channel_id TEXT NOT NULL REFERENCES channel(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,url TEXT NOT NULL,PRIMARY KEY(channel_id,ordinal),UNIQUE(channel_id,url));
CREATE TABLE favorite(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL);CREATE TABLE removed(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL);
CREATE TABLE preference(singleton INTEGER PRIMARY KEY CHECK(singleton=1),volume REAL NOT NULL CHECK(volume BETWEEN 0 AND 1),muted INTEGER NOT NULL CHECK(muted IN(0,1)),panel_width REAL NOT NULL CHECK(panel_width BETWEEN 220 AND 600));PRAGMA user_version=1;";

pub(super) fn refuse_database_links(path: &Path) -> Result<(), String> {
    refuse_link(path)?;
    for suffix in ["-journal", "-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        refuse_link(Path::new(&sidecar))?;
    }
    Ok(())
}

/// Scan work runs in the background and may wait out another writer's commit
/// (an automatic guide refresh holds the database for several seconds on a TV)
/// instead of failing the whole scan after the interactive 2 s timeout.
pub(super) const BACKGROUND_BUSY_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) fn connect_background(path: &Path, readonly: bool) -> Result<Connection, String> {
    let c = connect(path, readonly)?;
    sql(c.busy_timeout(BACKGROUND_BUSY_TIMEOUT))?;
    Ok(c)
}

pub(super) fn connect(path: &Path, readonly: bool) -> Result<Connection, String> {
    refuse_database_links(path)?;
    let c = sql(Connection::open_with_flags(
        path,
        if readonly {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        },
    ))?;
    sql(c.busy_timeout(Duration::from_secs(2)))?;
    sql(c.execute_batch("PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;"))?;
    if !readonly {
        sql(c.execute_batch("PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;"))?;
        let size: i64 = sql(c.pragma_query_value(None, "page_size", |r| r.get(0)))?;
        sql(c.pragma_update(
            None,
            "max_page_count",
            crate::storage_budget::maximum_pages(size)?,
        ))?;
    }
    Ok(c)
}

pub(super) const ARCHIVE_BINDING_SQL: &str = "CREATE TABLE archive_authority_binding_v1(singleton INTEGER PRIMARY KEY CHECK(singleton=1),format INTEGER NOT NULL CHECK(format=1),binding TEXT NOT NULL CHECK(length(CAST(binding AS BLOB))<=2048));";

pub(super) fn archive_binding(
    c: &Connection,
) -> Result<crate::archive_library_store::Binding, String> {
    let schema: String = sql(c.query_row(
        "SELECT sql FROM sqlite_schema WHERE type='table' AND name='archive_authority_binding_v1'",
        [],
        |r| r.get(0),
    ))?;
    if schema.trim_end_matches(';') != ARCHIVE_BINDING_SQL.trim_end_matches(';') {
        return Err(crate::archive_library_store::REPAIR.into());
    }
    let rows: i64 = sql(c.query_row(
        "SELECT count(*) FROM archive_authority_binding_v1",
        [],
        |r| r.get(0),
    ))?;
    if rows != 1 {
        return Err(crate::archive_library_store::REPAIR.into());
    }
    let encoded: String = sql(c.query_row(
        "SELECT binding FROM archive_authority_binding_v1 WHERE singleton=1 AND format=1",
        [],
        |r| r.get(0),
    ))?;
    let binding: crate::archive_library_store::Binding =
        serde_json::from_str(&encoded).map_err(|_| crate::archive_library_store::REPAIR)?;
    binding.validate()?;
    for table in crate::archive_library_store::TABLES {
        let found: i64 = sql(c.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name=?1",
            [table],
            |r| r.get(0),
        ))?;
        if found != 0 {
            return Err(crate::archive_library_store::REPAIR.into());
        }
    }
    Ok(binding)
}

pub(super) fn archive_peer_matches(
    c: &Connection,
    witness: &crate::archive_library_store::Witness,
) -> Result<bool, String> {
    let version: i64 = sql(c.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
    match (version, witness.phase) {
        (17..=19, _) => Ok(archive_binding(c)? == witness.binding),
        (16, crate::archive_library_store::Phase::Prepared) => Ok(
            crate::archive_library_store::source_fingerprint(c, &mut || Ok(()))?
                == witness.binding.imported_digest,
        ),
        (1..=16, crate::archive_library_store::Phase::Active) => Ok(true),
        _ => Ok(false),
    }
}

pub(super) fn migrate(c: &mut Connection) -> Result<(), String> {
    let version: i64 = sql(c.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
    if !matches!(version, 1..=19) {
        return Err("sqlite-unsupported-schema".into());
    }
    if version >= 16 {
        return Ok(());
    }
    if version == 15 {
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        crate::archive_provider_catalog::install(&tx)?;
        sql(tx.execute_batch("PRAGMA user_version=16;"))?;
        return sql(tx.commit());
    }
    if version < 3 {
        crate::guide::database::migrate(c)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        sql(tx.execute_batch("ALTER TABLE channel ADD COLUMN country TEXT;ALTER TABLE channel ADD COLUMN region TEXT;ALTER TABLE channel ADD COLUMN state TEXT;ALTER TABLE channel ADD COLUMN geography_provenance TEXT;CREATE INDEX channel_geography ON channel(country,region,state);PRAGMA user_version=3;"))?;
        sql(tx.commit())?;
    }
    if version < 5 {
        crate::guide::database::migrate_suggestions(c)?;
        crate::health_storage::migrate(c)?;
    }
    if version < 6 {
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        sql(tx.execute_batch("ALTER TABLE preference ADD COLUMN auto_source_refresh INTEGER NOT NULL DEFAULT 0 CHECK(auto_source_refresh IN(0,1));ALTER TABLE preference ADD COLUMN source_refresh_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK(source_refresh_attempt_at BETWEEN 0 AND 8640000000000000);PRAGMA user_version=6;"))?;
        sql(tx.commit())?;
    }
    if version < 7 {
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        sql(tx.execute_batch("ALTER TABLE preference ADD COLUMN reviewed_channel_providers TEXT;ALTER TABLE preference ADD COLUMN reviewed_guide_providers TEXT;ALTER TABLE preference ADD COLUMN preferred_region TEXT;ALTER TABLE preference ADD COLUMN voice_search_consent INTEGER CHECK(voice_search_consent IS NULL OR voice_search_consent IN(0,1));PRAGMA user_version=7;"))?;
        sql(tx.commit())?;
    }
    if version < 8 {
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        crate::guide::database::add_category_columns(&tx)?;
        sql(tx.execute_batch("ALTER TABLE preference ADD COLUMN source_refresh_cadence TEXT NOT NULL DEFAULT 'off' CHECK(source_refresh_cadence IN('off','hourly','every6hours','daily','weekly','every2weeks','monthly'));UPDATE preference SET source_refresh_cadence=CASE WHEN auto_source_refresh=1 THEN 'daily' ELSE 'off' END;PRAGMA user_version=8;"))?;
        sql(tx.commit())?;
    }
    if version < 9 {
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        crate::catalog_query::install_projection(&tx)?;
        sql(tx.execute_batch("PRAGMA user_version=9;"))?;
        sql(tx.commit())?;
    }
    if version < 10 {
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        sql(tx.execute_batch("CREATE TABLE IF NOT EXISTS channel_category_override(channel_id TEXT PRIMARY KEY CHECK(length(CAST(channel_id AS BLOB)) BETWEEN 1 AND 16384),category TEXT NOT NULL CHECK(length(CAST(category AS BLOB)) BETWEEN 1 AND 512),ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 99999));PRAGMA user_version=10;"))?;
        crate::catalog_query::rebuild_projection(&tx)?;
        sql(tx.commit())?;
    }
    if version < 11 {
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        sql(tx.execute_batch("ALTER TABLE metadata ADD COLUMN automatic_guide_updates INTEGER DEFAULT NULL CHECK(automatic_guide_updates IS NULL OR automatic_guide_updates IN(0,1));PRAGMA user_version=11;"))?;
        sql(tx.commit())?;
    }
    if version < 12 {
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        crate::catalog_endpoint_projection::install(&tx)?;
        sql(tx.execute_batch("PRAGMA user_version=12;"))?;
        sql(tx.commit())?;
    }
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    if version < 13 {
        crate::archive_catalog::install(&tx)?;
    } else if version < 14 {
        crate::archive_catalog::install_removals(&tx)?;
    }
    crate::archive_bookmarks::install(&tx)?;
    crate::archive_provider_catalog::install(&tx)?;
    sql(tx.execute_batch("PRAGMA user_version=16;"))?;
    sql(tx.commit())
}

pub(super) fn geography(ch: &Value) -> Result<(), String> {
    let Some(g) = ch.get("geography") else {
        return if ch.get("geographyProvenance").is_none() {
            Ok(())
        } else {
            Err("record-invalid-geography".into())
        };
    };
    let object = g.as_object().ok_or("record-invalid-geography")?;
    if object.is_empty()
        || object
            .keys()
            .any(|k| !matches!(k.as_str(), "country" | "region" | "state"))
    {
        return Err("record-invalid-geography".into());
    }
    for (field, v) in object {
        let value = v.as_str().ok_or("record-invalid-geography")?;
        let valid = match field.as_str() {
            "country" => value.len() == 2 && value.bytes().all(|b| b.is_ascii_uppercase()),
            "region" => {
                !value.is_empty()
                    && value.len() <= 32
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b"_-".contains(&b))
            }
            "state" => value.split_once('-').is_some_and(|(a, b)| {
                a.len() == 2
                    && a.bytes().all(|x| x.is_ascii_uppercase())
                    && !b.is_empty()
                    && b.len() <= 8
                    && b.bytes()
                        .all(|x| x.is_ascii_uppercase() || x.is_ascii_digit())
                    && g["country"].as_str().is_none_or(|country| country == a)
            }),
            _ => false,
        };
        if !valid {
            return Err("record-invalid-geography".into());
        }
    }
    if let Some(p) = ch.get("geographyProvenance") {
        let entries = p.as_array().ok_or("record-invalid-geography-provenance")?;
        if entries.len() > 3 {
            return Err("record-invalid-geography-provenance".into());
        }
        let mut seen = HashSet::new();
        for e in entries {
            let field = text(e, "field", 7, false)?;
            if !matches!(field, "country" | "region" | "state")
                || !seen.insert(field)
                || e["value"] != g[field]
                || e["sourceId"] != ch["sourceId"]
                || !matches!(
                    text(e, "kind", 8, false)?,
                    "provider" | "m3u" | "registry" | "user"
                )
                || !matches!(
                    text(e, "scope", 32, false)?,
                    "channel-origin" | "provider-declared" | "country-group" | "user-reviewed"
                )
            {
                return Err("record-invalid-geography-provenance".into());
            }
            text(e, "sourceId", 256, false)?;
            text(e, "value", 32, false)?;
            if e.get("providerId").is_some() {
                text(e, "providerId", 16384, false)?;
            }
        }
    }
    Ok(())
}

pub(super) fn integrity(c: &Connection) -> Result<(), String> {
    integrity_parts(c, None)
}

pub(super) fn integrity_parts(
    c: &Connection,
    backup: Option<&std::sync::atomic::AtomicU8>,
) -> Result<(), String> {
    let version: i64 = sql(c.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
    if !matches!(version, 1..=19) {
        return Err("sqlite-unsupported-schema".into());
    }
    let check: String = {
        let _time = backup.map(|marker| {
            marker.store(1, std::sync::atomic::Ordering::Relaxed);
            crate::storage_timings::measure(crate::storage_timings::Stage::BackupQuickCheck)
        });
        sql(c.query_row("PRAGMA quick_check", [], |r| r.get(0)))?
    };
    if check != "ok" {
        return Err("sqlite-integrity-failed".into());
    }
    let violations = {
        let _time = backup.map(|marker| {
            marker.store(2, std::sync::atomic::Ordering::Relaxed);
            crate::storage_timings::measure(crate::storage_timings::Stage::BackupForeignKeys)
        });
        sql(
            c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                r.get::<_, i64>(0)
            }),
        )?
    };
    if violations != 0 {
        return Err("sqlite-integrity-failed".into());
    }
    if (15..=16).contains(&version) {
        crate::archive_bookmarks::validate(c)?;
    }
    if version == 16 {
        crate::archive_provider_catalog::validate(c)?;
    }
    if version >= 17 {
        archive_binding(c)?;
    }
    if version >= 18 {
        crate::guide::retention::validate(c)?;
    }
    if version >= 19 {
        validate_content_library_schema(c)?;
    }
    Ok(())
}

pub(super) fn validate_content_library_schema(c: &Connection) -> Result<(), String> {
    // Preparing the query also refuses a claimed schema19 missing its column,
    // including when no preference row is present.
    let invalid: i64 = sql(c.query_row(
        "SELECT count(*) FROM preference WHERE content_library IS NOT NULL AND content_library NOT IN ('live','genxtra')",
        [],
        |r| r.get(0),
    ))?;
    if invalid != 0 {
        return Err("sqlite-invalid-content-library".into());
    }
    Ok(())
}
