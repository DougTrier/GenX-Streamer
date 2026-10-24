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

//! Durable native full-source ambiguity, fenced by the snapshot revision.
//! Promotion builds counts once; publication reads at most 128 indexed keys.
use super::*;
use rusqlite::OptionalExtension;
use std::collections::HashMap;

const ERR: &str = "source-snapshot-ambiguity-invalid";
#[derive(Default)]
pub(crate) struct SnapshotAmbiguity {
    provider: HashMap<[u8; 32], u8>,
    metadata: HashMap<[u8; 32], u8>,
}
fn keys(channel: &Value) -> Result<([u8; 32], [u8; 32]), String> {
    Ok((
        Sha256::digest(crate::scan_resume_reconcile::provider(channel)?.as_bytes()).into(),
        Sha256::digest(crate::scan_resume_reconcile::metadata(channel)?.as_bytes()).into(),
    ))
}
impl SnapshotAmbiguity {
    pub(crate) fn ambiguous(&self, channel: &Value) -> Result<(bool, bool), String> {
        let (provider, metadata) = keys(channel)?;
        Ok((
            self.provider.get(&provider).is_some_and(|count| *count > 1),
            self.metadata.get(&metadata).is_some_and(|count| *count > 1),
        ))
    }
}

/// Independent operational schema: key semantics are the exact reconcile v1
/// equivalences above, not snapshot identity hashes or client supplied counts.
fn ensure_counts(c: &Connection) -> Result<(), String> {
    let exists: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='source_reconcile_count_namespace')",
        [],
        |r| r.get(0),
    ))?;
    if exists {
        let version: i64 = sql(c.query_row(
            "SELECT schema_version FROM source_reconcile_count_namespace WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        match version {
            2 => return Ok(()),
            1 => {
                // The legacy keys have no revision. Only proven current coverage
                // can supply that missing dimension; never assign historical keys.
                sql(c.execute_batch(
                    "ALTER TABLE source_reconcile_count RENAME TO source_reconcile_count_v1;
ALTER TABLE source_reconcile_count_coverage RENAME TO source_reconcile_count_coverage_v1;
DROP TABLE source_reconcile_count_namespace;",
                ))?;
            }
            _ => return Err("source-snapshot-count-version-unsupported".into()),
        }
    }
    sql(c.execute_batch("CREATE TABLE source_reconcile_count_namespace(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=2));
INSERT INTO source_reconcile_count_namespace VALUES(1,2);
CREATE TABLE source_reconcile_count(source_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),kind INTEGER NOT NULL CHECK(kind IN(0,1)),key BLOB NOT NULL CHECK(length(key)=32),n INTEGER NOT NULL CHECK(n IN(1,2)),PRIMARY KEY(source_id,revision,kind,key)) WITHOUT ROWID;
CREATE TABLE source_reconcile_count_coverage(source_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),entry_count INTEGER NOT NULL CHECK(entry_count BETWEEN 0 AND 100000),key_version INTEGER NOT NULL CHECK(key_version=1),PRIMARY KEY(source_id,revision)) WITHOUT ROWID;"))?;
    if exists {
        sql(c.execute_batch("INSERT INTO source_reconcile_count_coverage SELECT v.source_id,v.revision,v.entry_count,v.key_version FROM source_reconcile_count_coverage_v1 v JOIN source_snapshot_source s ON s.source_id=v.source_id AND s.revision=v.revision WHERE v.key_version=1 AND v.entry_count=(SELECT count(*) FROM source_snapshot_entry e WHERE e.source_id=v.source_id AND e.available=1);
INSERT INTO source_reconcile_count SELECT k.source_id,v.revision,k.kind,k.key,k.n FROM source_reconcile_count_v1 k JOIN source_reconcile_count_coverage v ON v.source_id=k.source_id;
DROP TABLE source_reconcile_count_v1;
DROP TABLE source_reconcile_count_coverage_v1;"))?;
    }
    Ok(())
}

/// A historical revision is usable only through a live sealed native mapping.
/// The caller already authenticated original metadata/URLs and source grants.
pub(super) fn pinned_coverage(
    c: &Connection,
    manifest: &str,
    source_id: &str,
    revision: i64,
) -> Result<bool, String> {
    ensure_counts(c)?;
    sql(c.query_row("SELECT EXISTS(SELECT 1 FROM source_activation_row a JOIN scan_manifest m ON m.id=a.manifest_id JOIN source_reconcile_count_coverage v ON v.source_id=a.source_id AND CAST(v.revision AS TEXT)=a.source_revision WHERE a.manifest_id=?1 AND a.source_id=?2 AND a.source_revision=?3 AND m.state=1 AND v.key_version=1)", params![manifest, source_id, revision.to_string()], |r| r.get(0)))
}

/// Invoke after manifest retirement, in that same final commit transaction.
pub(super) fn prune_unpinned_counts_in_transaction(c: &Connection) -> Result<(), String> {
    let exists: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='source_reconcile_count_namespace')",
        [],
        |r| r.get(0),
    ))?;
    if !exists {
        return Ok(());
    }
    ensure_counts(c)?;
    let mut statement =
        sql(c.prepare("SELECT source_id,revision FROM source_snapshot_source ORDER BY source_id"))?;
    let sources =
        sql(statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| ERR)?;
    drop(statement);
    for (source_id, current) in sources {
        prune_counts(c, &source_id, current)?;
    }
    Ok(())
}

fn prune_counts(c: &Connection, source_id: &str, current: i64) -> Result<(), String> {
    let mapped: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='source_activation_row')",
        [],
        |r| r.get(0),
    ))?;
    if mapped {
        sql(c.execute("DELETE FROM source_reconcile_count_coverage WHERE source_id=?1 AND revision<>?2 AND NOT EXISTS(SELECT 1 FROM source_activation_row a JOIN scan_manifest m ON m.id=a.manifest_id WHERE a.source_id=?1 AND a.source_revision=CAST(source_reconcile_count_coverage.revision AS TEXT) AND m.state=1)", params![source_id, current]))?;
    } else {
        sql(c.execute(
            "DELETE FROM source_reconcile_count_coverage WHERE source_id=?1 AND revision<>?2",
            params![source_id, current],
        ))?;
    }
    sql(c.execute("DELETE FROM source_reconcile_count WHERE source_id=?1 AND NOT EXISTS(SELECT 1 FROM source_reconcile_count_coverage v WHERE v.source_id=source_reconcile_count.source_id AND v.revision=source_reconcile_count.revision)", [source_id]))?;
    Ok(())
}

/// Caller owns the promotion/publication transaction. Coverage is inserted
/// only after every available entry was indexed, including fresh siblings.
/// Failure/cancel rolls back both counts and snapshot/evidence changes.
pub(super) fn rebuild_counts_in_transaction(
    c: &Connection,
    source_id: &str,
    expected_revision: i64,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    check()?;
    ensure_counts(c)?;
    let current: Option<i64> = sql(c
        .query_row(
            "SELECT revision FROM source_snapshot_source WHERE source_id=?1",
            [source_id],
            |r| r.get(0),
        )
        .optional())?;
    if current != Some(expected_revision) || expected_revision <= 0 {
        return Err("source-snapshot-revision-stale".into());
    }
    let covered: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_reconcile_count_coverage WHERE source_id=?1 AND revision=?2 AND key_version=1)",
        params![source_id, expected_revision],
        |r| r.get(0),
    ))?;
    if covered {
        return prune_counts(c, source_id, expected_revision);
    }
    sql(c.execute(
        "DELETE FROM source_reconcile_count WHERE source_id=?1 AND revision=?2",
        params![source_id, expected_revision],
    ))?;
    let mut insert = sql(c.prepare("INSERT INTO source_reconcile_count(source_id,revision,kind,key,n) VALUES(?1,?2,?3,?4,1) ON CONFLICT(source_id,revision,kind,key) DO UPDATE SET n=min(2,source_reconcile_count.n+1)"))?;
    let mut page = sql(c.prepare(
        "SELECT ordinal,channel FROM source_snapshot_entry WHERE source_id=?1 AND available=1 AND ordinal>?2 ORDER BY ordinal LIMIT 64",
    ))?;
    let mut after = -1i64;
    let mut total = 0usize;
    let mut bytes = 0usize;
    loop {
        check()?;
        let rows = sql(page.query_map(params![source_id, after], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        }))?;
        let mut count = 0usize;
        for row in rows {
            check()?;
            let (ordinal, raw) = sql(row)?;
            if ordinal <= after || ordinal >= 100_000 || raw.len() > 1024 * 1024 {
                return Err(ERR.into());
            }
            after = ordinal;
            count += 1;
            total += 1;
            bytes = bytes.checked_add(raw.len() + 1).ok_or(ERR)?;
            if total > 100_000 || bytes > 20 * 1024 * 1024 {
                return Err("source-snapshot-ambiguity-too-large".into());
            }
            let channel: Value = serde_json::from_str(&raw).map_err(|_| ERR)?;
            if channel["sourceId"] != source_id {
                return Err(ERR.into());
            }
            let (provider, metadata) = keys(&channel)?;
            if channel["providerId"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
            {
                sql(insert.execute(params![
                    source_id,
                    expected_revision,
                    0,
                    provider.as_slice()
                ]))?;
            }
            sql(insert.execute(params![
                source_id,
                expected_revision,
                1,
                metadata.as_slice()
            ]))?;
        }
        if count < 64 {
            break;
        }
    }
    drop(page);
    drop(insert);
    check()?;
    sql(c.execute(
        "INSERT INTO source_reconcile_count_coverage(source_id,revision,entry_count,key_version) VALUES(?1,?2,?3,1)",
        params![source_id, expected_revision, total as i64],
    ))?;
    prune_counts(c, source_id, expected_revision)
}

/// Combine this result with the admitted Plan's ambiguity via logical OR.
/// Legacy manifests have no independent snapshot mapping and add no ambiguity.
/// `c` must be the same publication transaction as reconciliation and evidence.
pub(crate) fn prepare(
    c: &Connection,
    header: &Value,
    selected: &[crate::scan_resume_reconcile::Selected<'_>],
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<SnapshotAmbiguity, String> {
    check()?;
    if selected.len() > 64 {
        return Err(ERR.into());
    }
    let mut result = SnapshotAmbiguity::default();
    if selected.is_empty() {
        return Ok(result);
    }
    let exists: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='source_activation_row')",
        [],
        |r| r.get(0),
    ))?;
    if !exists {
        return Ok(result);
    }
    let mut statement = sql(c.prepare(
        "SELECT id FROM scan_manifest WHERE job_id=?1 AND review_digest=?2 AND state=1 LIMIT 2",
    ))?;
    let manifests = sql(statement.query_map(
        params![
            header["jobId"].as_str().ok_or(ERR)?,
            header["reviewDigest"].as_str().ok_or(ERR)?,
        ],
        |r| r.get::<_, String>(0),
    ))?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(|_| ERR)?;
    drop(statement);
    if manifests.len() > 1 {
        return Err(ERR.into());
    }
    let Some(manifest) = manifests.first() else {
        return Ok(result);
    };
    let mapped: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_activation_row WHERE manifest_id=?1)",
        [manifest],
        |r| r.get(0),
    ))?;
    if !mapped {
        return Ok(result);
    }
    let mut sources = HashMap::<String, String>::new();
    for row in selected {
        check()?;
        let (source_id, revision): (String, String) = sql(c.query_row(
            "SELECT source_id,source_revision FROM source_activation_row WHERE manifest_id=?1 AND ordinal=?2",
            params![manifest, row.original_index as i64],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        let channel = &row.candidate["channel"];
        if channel["sourceId"] != source_id || row.candidate["sourceId"] != source_id {
            return Err(ERR.into());
        }
        if sources
            .insert(source_id, revision.clone())
            .is_some_and(|old| old != revision)
        {
            return Err(ERR.into());
        }
        let (provider, metadata) = keys(channel)?;
        if channel["providerId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
        {
            result.provider.insert(provider, 0);
        }
        result.metadata.insert(metadata, 0);
    }
    // Sorting source IDs keeps preparation deterministic without retaining URLs.
    let mut sources: Vec<_> = sources.into_iter().collect();
    sources.sort_by(|a, b| a.0.cmp(&b.0));
    ensure_counts(c)?;
    for (source_id, expected) in sources {
        check()?;
        let current: Option<i64> = sql(c
            .query_row(
                "SELECT revision FROM source_snapshot_source WHERE source_id=?1",
                [&source_id],
                |r| r.get(0),
            )
            .optional())?;
        let expected = crate::scan_checkpoint::revision(&expected)?;
        let coverage: Option<i64> = sql(c
            .query_row(
                "SELECT key_version FROM source_reconcile_count_coverage WHERE source_id=?1 AND revision=?2",
                params![source_id, expected],
                |r| r.get(0),
            )
            .optional())?;
        if current == Some(expected) {
            match coverage {
                None => rebuild_counts_in_transaction(c, &source_id, expected, check)?,
                Some(1) => {}
                _ => return Err("source-snapshot-count-coverage-stale".into()),
            }
        } else if coverage != Some(1) || !pinned_coverage(c, manifest, &source_id, expected)? {
            return Err("source-snapshot-revision-stale".into());
        }
        let mut lookup = sql(c.prepare("SELECT n FROM source_reconcile_count WHERE source_id=?1 AND revision=?2 AND kind=?3 AND key=?4"))?;
        for row in selected
            .iter()
            .filter(|row| row.candidate["sourceId"] == source_id)
        {
            check()?;
            let channel = &row.candidate["channel"];
            let (provider, metadata) = keys(channel)?;
            if channel["providerId"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
            {
                let count: Option<u8> = sql(lookup
                    .query_row(params![source_id, expected, 0, provider.as_slice()], |r| {
                        r.get(0)
                    })
                    .optional())?;
                match count {
                    Some(count @ 1..=2) => {
                        result.provider.insert(provider, count);
                    }
                    _ => return Err("source-snapshot-revision-stale".into()),
                }
            }
            let count: Option<u8> = sql(lookup
                .query_row(params![source_id, expected, 1, metadata.as_slice()], |r| {
                    r.get(0)
                })
                .optional())?;
            match count {
                Some(count @ 1..=2) => {
                    result.metadata.insert(metadata, count);
                }
                _ => return Err("source-snapshot-revision-stale".into()),
            }
        }
    }
    if result
        .provider
        .values()
        .chain(result.metadata.values())
        .any(|count| *count == 0)
    {
        return Err("source-snapshot-revision-stale".into());
    }
    check()?;
    Ok(result)
}

#[cfg(test)]
#[path = "source_snapshot_ambiguity_tests.rs"]
mod tests;

// Prepared fixtures only; execution is deferred by the active user instruction.
#[cfg(test)]
mod pinned_revision_tests {
    use super::*;
    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE scan_manifest(id TEXT,job_id TEXT,review_digest TEXT,state INTEGER);
CREATE TABLE source_activation_row(manifest_id TEXT,ordinal INTEGER,source_id TEXT,source_revision TEXT);
CREATE TABLE source_snapshot_source(source_id TEXT,revision INTEGER);
CREATE TABLE source_snapshot_entry(source_id TEXT,ordinal INTEGER,channel TEXT,available INTEGER);
INSERT INTO scan_manifest VALUES('old','job','digest',1);
INSERT INTO source_activation_row VALUES('old',0,'s','1');
INSERT INTO source_snapshot_source VALUES('s',1);",
        )
        .unwrap();
        c
    }
    fn channel(provider: &str) -> Value {
        json!({"sourceId":"s","providerId":provider,"name":"Station","category":"News"})
    }
    #[test]
    fn old_checkpoint_uses_pinned_original_counts_after_new_snapshot_promotion() {
        let c = fixture();
        let original = channel("provider");
        for ordinal in 0..2 {
            c.execute(
                "INSERT INTO source_snapshot_entry VALUES('s',?1,?2,1)",
                params![ordinal, original.to_string()],
            )
            .unwrap();
        }
        rebuild_counts_in_transaction(&c, "s", 1, &mut || Ok(())).unwrap();
        c.execute_batch(
            "UPDATE source_snapshot_source SET revision=2; DELETE FROM source_snapshot_entry;",
        )
        .unwrap();
        c.execute(
            "INSERT INTO source_snapshot_entry VALUES('s',0,?1,1)",
            [original.to_string()],
        )
        .unwrap();
        rebuild_counts_in_transaction(&c, "s", 2, &mut || Ok(())).unwrap();
        let candidate = json!({"sourceId":"s","channel":original});
        let observation = Value::Null;
        let rows = [crate::scan_resume_reconcile::Selected {
            original_index: 0,
            candidate: &candidate,
            observation: &observation,
        }];
        let result = prepare(
            &c,
            &json!({"jobId":"job","reviewDigest":"digest"}),
            &rows,
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(
            result.ambiguous(&candidate["channel"]).unwrap(),
            (true, true)
        );
        assert!(pinned_coverage(&c, "old", "s", 1).unwrap());
        c.execute("UPDATE scan_manifest SET state=2 WHERE id='old'", [])
            .unwrap();
        rebuild_counts_in_transaction(&c, "s", 2, &mut || Ok(())).unwrap();
        assert!(!pinned_coverage(&c, "old", "s", 1).unwrap());
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM source_reconcile_count_coverage WHERE source_id='s'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    #[test]
    fn arbitrary_old_mapping_without_coverage_cannot_use_current_counts() {
        let c = fixture();
        let original = channel("provider");
        c.execute_batch("UPDATE source_snapshot_source SET revision=2")
            .unwrap();
        c.execute(
            "INSERT INTO source_snapshot_entry VALUES('s',0,?1,1)",
            [original.to_string()],
        )
        .unwrap();
        rebuild_counts_in_transaction(&c, "s", 2, &mut || Ok(())).unwrap();
        let candidate = json!({"sourceId":"s","channel":original});
        let observation = Value::Null;
        let rows = [crate::scan_resume_reconcile::Selected {
            original_index: 0,
            candidate: &candidate,
            observation: &observation,
        }];
        assert_eq!(
            prepare(
                &c,
                &json!({"jobId":"job","reviewDigest":"digest"}),
                &rows,
                &mut || Ok(())
            )
            .err()
            .unwrap(),
            "source-snapshot-revision-stale"
        );
    }
    #[test]
    fn legacy_migration_never_assigns_unversioned_keys_to_old_mapping() {
        let c = fixture();
        c.execute_batch(
            "UPDATE source_snapshot_source SET revision=2;
CREATE TABLE source_reconcile_count_namespace(singleton INTEGER PRIMARY KEY,schema_version INTEGER);
INSERT INTO source_reconcile_count_namespace VALUES(1,1);
CREATE TABLE source_reconcile_count(source_id TEXT,kind INTEGER,key BLOB,n INTEGER,PRIMARY KEY(source_id,kind,key));
CREATE TABLE source_reconcile_count_coverage(source_id TEXT PRIMARY KEY,revision INTEGER,entry_count INTEGER,key_version INTEGER);
INSERT INTO source_reconcile_count VALUES('s',1,zeroblob(32),2);
INSERT INTO source_reconcile_count_coverage VALUES('s',1,0,1);",
        )
        .unwrap();
        ensure_counts(&c).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM source_reconcile_count_coverage",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM source_reconcile_count", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(!pinned_coverage(&c, "old", "s", 1).unwrap());
    }
}
