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

//! Fresh indexed revision proof, never a persisted summary of activation authority.
use super::sql;
use rusqlite::{
    params,
    types::{ToSqlOutput, ValueRef},
    Connection, OptionalExtension, Row, ToSql,
};

// Preserve SQLite storage classes and even non-UTF8 TEXT bytes verbatim.
// Owned rusqlite::Value would require decoding TEXT to a Rust String.
#[derive(Debug)]
enum RawValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(Vec<u8>),
    Blob(Vec<u8>),
}
fn raw(row: &Row<'_>) -> rusqlite::Result<RawValue> {
    Ok(match row.get_ref(0)? {
        ValueRef::Null => RawValue::Null,
        ValueRef::Integer(v) => RawValue::Integer(v),
        ValueRef::Real(v) => RawValue::Real(v),
        ValueRef::Text(v) => RawValue::Text(v.to_vec()),
        ValueRef::Blob(v) => RawValue::Blob(v.to_vec()),
    })
}
impl ToSql for RawValue {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(match self {
            Self::Null => ValueRef::Null,
            Self::Integer(v) => ValueRef::Integer(*v),
            Self::Real(v) => ValueRef::Real(*v),
            Self::Text(v) => ValueRef::Text(v),
            Self::Blob(v) => ValueRef::Blob(v),
        }))
    }
}

pub(crate) const INDEX: &str = "source_activation_revision_guard_v1";
const TABLE: &str = "CREATE TABLE source_activation_row(manifest_id TEXT NOT NULL REFERENCES scan_manifest(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,source_id TEXT NOT NULL,entry_id TEXT NOT NULL,source_revision TEXT NOT NULL,PRIMARY KEY(manifest_id,ordinal))";
const SOURCE_TABLE: &str = "CREATE TABLE source_snapshot_source(source_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,definition TEXT NOT NULL,permission TEXT NOT NULL,platform TEXT NOT NULL,profile TEXT NOT NULL,refreshed_ms INTEGER NOT NULL)";
const INDEX_SQL: &str = "CREATE INDEX source_activation_revision_guard_v1 ON source_activation_row(manifest_id,source_id,source_revision)";
const ORIGINAL: &str = "SELECT EXISTS(SELECT 1 FROM source_activation_row a LEFT JOIN source_snapshot_source s ON s.source_id=a.source_id WHERE a.manifest_id=?1 AND (s.revision IS NULL OR CAST(s.revision AS TEXT)<>a.source_revision))";
const INVALID: &str = "source-activation-schema-invalid";

// Conservative recognition of our exact DDL, not a schema repair mechanism.
// Unknown affinities/collations/nullable legacy schemas use the original SQL.
fn normalized(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_ascii_whitespace() && *c != ';')
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .replace("ifnotexists", "")
}
fn matches_schema(c: &Connection, kind: &str, name: &str, expected: &str) -> Result<bool, String> {
    let actual: Option<String> = sql(c
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type=?1 AND name=?2",
            params![kind, name],
            |r| r.get(0),
        )
        .optional())?;
    Ok(actual.is_some_and(|s| normalized(&s) == normalized(expected)))
}
fn known_tables(c: &Connection) -> Result<bool, String> {
    Ok(matches_schema(c, "table", "source_activation_row", TABLE)?
        && matches_schema(c, "table", "source_snapshot_source", SOURCE_TABLE)?)
}
pub(crate) fn install_index(c: &Connection) -> Result<(), String> {
    if !known_tables(c)? {
        return Err(INVALID.into());
    }
    let manifest: i64 = sql(c.query_row(
        "SELECT schema_version FROM scan_manifest_namespace WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    let snapshot: i64 = sql(c.query_row(
        "SELECT schema_version FROM source_snapshot_namespace WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    if manifest != 1 || !matches!(snapshot, 1 | 2) {
        return Err(INVALID.into());
    }
    let exists: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
        [INDEX],
        |r| r.get(0),
    ))?;
    if exists {
        if !matches_schema(c, "index", INDEX, INDEX_SQL)? {
            return Err(INVALID.into());
        }
    } else {
        sql(c.execute_batch(INDEX_SQL))?;
    }
    Ok(())
}
fn original(c: &Connection, manifest: &str) -> Result<bool, String> {
    sql(c.query_row(ORIGINAL, [manifest], |r| r.get(0)))
}
pub(crate) fn stale(c: &Connection, manifest: &str) -> Result<bool, String> {
    if !known_tables(c)? || !matches_schema(c, "index", INDEX, INDEX_SQL)? {
        return original(c, manifest);
    }
    // Exact TEXT-affinity/BINARY known schemas justify endpoint extrema. Values
    // remain SQLite values: BLOBs must never be coerced to Rust Strings. NULLs
    // are impossible in the supported schema; the fallback above preserves
    // legacy nullable/typeless three-valued SQL semantics, including NULL revs.
    let mut source: RawValue = sql(c.query_row(
        "SELECT MIN(source_id) FROM source_activation_row INDEXED BY source_activation_revision_guard_v1 WHERE manifest_id=?1",
        [manifest], raw))?;
    let mut groups = 0usize;
    while !matches!(source, RawValue::Null) {
        // Valid activation requests contain at most 100 selected sources. A
        // malformed/legacy larger inventory retains the original single-query
        // cancellation/progress behavior instead of many short uninterruptible
        // seeks. This is a fallback, never an admission or truncation policy.
        if groups == 100 {
            return original(c, manifest);
        }
        groups += 1;
        let min: RawValue = sql(c.query_row(
            "SELECT MIN(source_revision) FROM source_activation_row INDEXED BY source_activation_revision_guard_v1 WHERE manifest_id=?1 AND source_id=?2",
            params![manifest, source], raw))?;
        let max: RawValue = sql(c.query_row(
            "SELECT MAX(source_revision) FROM source_activation_row INDEXED BY source_activation_revision_guard_v1 WHERE manifest_id=?1 AND source_id=?2",
            params![manifest, source], raw))?;
        // Query the current source anew, inside the caller's same SQLite snapshot.
        // SQL performs exactly the old CAST/current-vs-TEXT-column comparison.
        let stale: bool = sql(c.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM source_snapshot_source WHERE source_id=?1) OR EXISTS(SELECT 1 FROM source_snapshot_source WHERE source_id=?1 AND (revision IS NULL OR CAST(revision AS TEXT)<>?2 OR CAST(revision AS TEXT)<>?3))",
            params![source, min, max], |r| r.get(0)))?;
        if stale {
            return Ok(true);
        }
        source = sql(c.query_row(
            "SELECT MIN(source_id) FROM source_activation_row INDEXED BY source_activation_revision_guard_v1 WHERE manifest_id=?1 AND source_id>?2",
            params![manifest, source], raw))?;
    }
    Ok(false)
}

#[cfg(test)]
#[path = "scan_manifest_activation_guard_tests.rs"]
mod tests;
