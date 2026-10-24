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

//! The archive library database's schema: connecting, installing and
//! checking it, and walking its domains for the source fingerprint.

use super::*;

pub(super) fn directory(root: &Path, create: bool) -> Result<PathBuf, String> {
    let path = root.join(DIRECTORY);
    refuse_link(&path)?;
    if create && !path.exists() {
        fs::create_dir(&path).map_err(|_| ERR)?;
        sync_directory(root)?;
    }
    if !path.is_dir() {
        return Err(REPAIR.into());
    }
    Ok(path)
}

pub(super) fn connect(path: &Path, create: bool, read_only: bool) -> Result<Connection, String> {
    refuse_link(path)?;
    if let Ok(meta) = fs::metadata(path) {
        if !meta.is_file() || meta.len() > MAX_DB {
            return Err(LIMIT.into());
        }
    }
    let flags = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | if create {
                OpenFlags::SQLITE_OPEN_CREATE
            } else {
                OpenFlags::empty()
            }
    };
    let c = sql(Connection::open_with_flags(path, flags))?;
    sql(c.busy_timeout(std::time::Duration::from_secs(2)))?;
    sql(c.execute_batch(
        "PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;PRAGMA cache_size=-2048;",
    ))?;
    if read_only {
        sql(c.execute_batch("PRAGMA query_only=ON;"))?;
    } else {
        sql(c.execute_batch("PRAGMA synchronous=EXTRA;PRAGMA max_page_count=32768;"))?;
    }
    Ok(c)
}

pub(super) fn install(c: &mut Connection) -> Result<(), String> {
    sql(c.execute_batch("PRAGMA page_size=4096;PRAGMA journal_mode=DELETE;"))?;
    let tx = sql(c.transaction())?;
    archive_catalog::install(&tx)?;
    archive_bookmarks::install(&tx)?;
    archive_provider_catalog::install(&tx)?;
    sql(tx.execute_batch(CONTROL_SQL))?;
    sql(tx.execute_batch("PRAGMA user_version=1;"))?;
    sql(tx.commit())
}

pub(super) type SchemaRows = Vec<(String, String, String, Option<String>)>;

pub(super) fn schema_rows(c: &Connection, namespace: bool) -> Result<SchemaRows, String> {
    let mut statement = sql(
        c.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' OR type='index' ORDER BY type,name")
    )?;
    let rows = sql(statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    }))?;
    let rows = sql(rows.collect::<rusqlite::Result<SchemaRows>>())?;
    Ok(rows
        .into_iter()
        .filter(|r| namespace || TABLES.contains(&r.2.as_str()))
        .collect())
}

pub(super) fn expected_schema() -> Result<&'static SchemaRows, String> {
    static EXPECTED: OnceLock<Result<SchemaRows, String>> = OnceLock::new();
    EXPECTED
        .get_or_init(|| {
            let mut c = sql(Connection::open_in_memory())?;
            install(&mut c)?;
            schema_rows(&c, true)
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub(super) fn validate_schema(c: &Connection, namespace: bool) -> Result<(), String> {
    let expected = expected_schema()?;
    let expected: SchemaRows = expected
        .iter()
        .filter(|r| namespace || TABLES.contains(&r.2.as_str()))
        .cloned()
        .collect();
    if schema_rows(c, namespace)? != expected {
        return Err(INVALID.into());
    }
    Ok(())
}

pub(super) fn revisions(c: &Connection) -> Result<(i64, i64), String> {
    let cat = archive_catalog::current(c)?;
    let book: i64 = sql(c.query_row(
        "SELECT revision FROM archive_bookmark_meta_v1 WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    if cat < 0 || book < 0 {
        return Err(INVALID.into());
    }
    Ok((cat, book))
}

pub(super) fn domain_bounds(c: &Connection) -> Result<(), String> {
    let _timing = crate::storage_timings::archive_measure(
        crate::storage_timings::ArchivePhase::DomainValidation,
    );
    // Preserve the legacy domain budget, including user choices and removals.
    let(t,p,pb,b,progress,r,rb):(i64,i64,i64,i64,i64,i64,i64)=sql(c.query_row("SELECT (SELECT count(*) FROM archive_title_v1),(SELECT count(*) FROM archive_preferences_v1),(SELECT COALESCE(sum(length(CAST(title_ref AS BLOB))+length(CAST(item_id AS BLOB))+length(CAST(title AS BLOB))+128),0) FROM archive_preferences_v1),(SELECT COALESCE(sum(length(CAST(title AS BLOB))+length(CAST(item_id AS BLOB))+COALESCE(length(CAST(rights AS BLOB)),0)+length(CAST(search_text AS BLOB))+256),0) FROM archive_title_v1)+(SELECT COALESCE(sum(length(CAST(file_name AS BLOB))+length(CAST(item_id AS BLOB))+length(CAST(servers AS BLOB))+COALESCE(length(CAST(original_identity AS BLOB)),0)+COALESCE(length(CAST(file_title AS BLOB)),0)+256),0) FROM archive_file_v1),(SELECT count(*)*256 FROM archive_item_progress_v1),(SELECT count(*) FROM archive_removal_v1),(SELECT COALESCE(sum(length(CAST(reference AS BLOB))+length(CAST(item_id AS BLOB))+length(CAST(title_ref AS BLOB))+length(CAST(display_name AS BLOB))+COALESCE(length(CAST(file_name AS BLOB)),0)+128),0) FROM archive_removal_v1)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))))?;
    if t > 1400
        || p > 10000
        || pb > 4 * 1024 * 1024
        || r > 10000
        || rb > 4 * 1024 * 1024
        || b.checked_add(pb)
            .and_then(|n| n.checked_add(progress))
            .and_then(|n| n.checked_add(rb))
            .is_none_or(|n| n > 20 * 1024 * 1024)
    {
        return Err(LIMIT.into());
    }
    archive_bookmarks::validate(c)?;
    archive_provider_catalog::validate(c)?;
    revisions(c)?;
    Ok(())
}

pub(super) fn hash_part(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}

pub(super) fn table_columns(c: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut st = sql(c.prepare(&format!("PRAGMA table_info({table})")))?;
    let rows = sql(st.query_map([], |r| r.get::<_, String>(1)))?;
    sql(rows.collect())
}

pub(super) fn sorted_select(c: &Connection, table: &str) -> Result<String, String> {
    let mut st = sql(c.prepare(&format!("PRAGMA table_info({table})")))?;
    let rows = sql(st.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, u32>(5)?))))?;
    let mut keys = sql(rows.collect::<rusqlite::Result<Vec<_>>>())?;
    keys.retain(|p| p.1 > 0);
    keys.sort_by_key(|p| p.1);
    if keys.is_empty() {
        return Err(INVALID.into());
    }
    Ok(format!(
        "SELECT * FROM {table} ORDER BY {}",
        keys.iter()
            .map(|p| p.0.as_str())
            .collect::<Vec<_>>()
            .join(",")
    ))
}

pub(super) fn walk_domain(
    c: &Connection,
    check: &mut dyn FnMut() -> Result<(), String>,
    mut row_fn: impl FnMut(&str, &[Value]) -> Result<(), String>,
) -> Result<String, String> {
    let _timing =
        crate::storage_timings::archive_measure(crate::storage_timings::ArchivePhase::DomainWalk);
    let mut hash = Sha256::new();
    hash_part(&mut hash, b"archive-library-domain-v1");
    let mut total_rows = 0usize;
    let mut total_bytes = 0usize;
    for table in TABLES {
        check()?;
        hash_part(&mut hash, table.as_bytes());
        let columns = table_columns(c, table)?;
        let oversized = columns
            .iter()
            .map(|col| format!("length(CAST({col} AS BLOB))>1048576"))
            .collect::<Vec<_>>()
            .join(" OR ");
        if sql(c.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {oversized})"),
            [],
            |r| r.get::<_, bool>(0),
        ))? {
            return Err(LIMIT.into());
        }
        for col in columns {
            hash_part(&mut hash, col.as_bytes());
        }
        let mut st = sql(c.prepare(&sorted_select(c, table)?))?;
        let columns = st.column_count();
        let mut rows = sql(st.query([]))?;
        while let Some(row) = sql(rows.next())? {
            check()?;
            total_rows += 1;
            if total_rows > MAX_ROWS {
                return Err(LIMIT.into());
            }
            let mut values = Vec::with_capacity(columns);
            let mut row_bytes = 0usize;
            hash.update([0xff]);
            for n in 0..columns {
                let value = sql(row.get_ref(n))?;
                let size = match value {
                    ValueRef::Text(v) | ValueRef::Blob(v) => v.len(),
                    _ => 8,
                };
                row_bytes = row_bytes.checked_add(size).ok_or(LIMIT)?;
                total_bytes = total_bytes.checked_add(size).ok_or(LIMIT)?;
                if row_bytes > 1024 * 1024 || total_bytes > MAX_BYTES {
                    return Err(LIMIT.into());
                }
                match value {
                    ValueRef::Null => hash.update([0]),
                    ValueRef::Integer(v) => {
                        hash.update([1]);
                        hash.update(v.to_be_bytes());
                    }
                    ValueRef::Real(v) => {
                        if !v.is_finite() {
                            return Err(INVALID.into());
                        }
                        hash.update([2]);
                        hash.update(v.to_bits().to_be_bytes());
                    }
                    ValueRef::Text(v) => {
                        hash.update([3]);
                        hash_part(&mut hash, v);
                    }
                    ValueRef::Blob(v) => {
                        hash.update([4]);
                        hash_part(&mut hash, v);
                    }
                }
                values.push(match value {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => Value::Integer(v),
                    ValueRef::Real(v) => Value::Real(v),
                    ValueRef::Text(v) => {
                        Value::Text(std::str::from_utf8(v).map_err(|_| INVALID)?.to_owned())
                    }
                    ValueRef::Blob(v) => Value::Blob(v.to_vec()),
                });
            }
            row_fn(table, &values)?;
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn source_fingerprint(
    c: &Connection,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<String, String> {
    validate_schema(c, false)?;
    domain_bounds(c)?;
    walk_domain(c, check, |_, _| Ok(()))
}
