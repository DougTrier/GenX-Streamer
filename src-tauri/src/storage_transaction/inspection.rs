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

//! Inspecting an existing database before it is opened or recovered, and
//! reading the legacy JSON pair.

use super::*;

pub(super) enum InspectionFailure {
    Corrupt,
    Refused(&'static str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Inspection {
    Corrupt,
    HealthyCurrent,
    HealthyNeedsMutation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RecoveryPhase {
    SchemaChecked,
    QuickCheck,
    ForeignKeys,
    ProofReused,
    Migration,
    FinalIntegrity,
}

pub(super) fn inspect_sql<T>(result: rusqlite::Result<T>) -> Result<T, InspectionFailure> {
    result.map_err(|error| match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase) => {
            InspectionFailure::Corrupt
        }
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            InspectionFailure::Refused("sqlite-storage-busy")
        }
        _ => InspectionFailure::Refused("sqlite-recovery-inspection-failed"),
    })
}

// A failed read is not evidence that replacing a live database is safe.
// Read-write admission allows SQLite itself to recover a valid hot rollback
// journal; no schema/configuration mutation occurs before this inspection.
pub(super) fn inspect_existing_database(
    path: &Path,
    observe: &mut impl FnMut(RecoveryPhase),
) -> Result<Inspection, String> {
    inspect_existing_database_with_pager(path, observe, InspectionPager::DEFAULT)
}

#[derive(Clone, Copy)]
pub(super) struct InspectionPager {
    pub(super) cache_kib: u32,
    pub(super) mmap_bytes: u64,
}

impl InspectionPager {
    pub(super) const DEFAULT: Self = Self {
        cache_kib: 8192,
        // Bounded file-backed mapping, not an eager heap allocation. SQLite maps
        // at most the file length and its VFS falls back to reads if mmap fails.
        // ARMv7 startup latency and peak memory still require device comparison.
        mmap_bytes: 268435456,
    };
    pub(super) fn configuration(self) -> Result<String, String> {
        const MAX_INSPECTION_MMAP_BYTES: u64 = 268435456;
        if !(1024..=32768).contains(&self.cache_kib) || self.mmap_bytes > MAX_INSPECTION_MMAP_BYTES
        {
            return Err("sqlite-inspection-pager-invalid".into());
        }
        Ok(format!(
            "PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;PRAGMA cache_size=-{};PRAGMA mmap_size={};",
            self.cache_kib, self.mmap_bytes,
        ))
    }
}

pub(super) fn inspect_existing_database_with_pager(
    path: &Path,
    observe: &mut impl FnMut(RecoveryPhase),
    pager: InspectionPager,
) -> Result<Inspection, String> {
    inspect_database_with_access(path, observe, pager, OpenFlags::SQLITE_OPEN_READ_WRITE)
}

pub(super) fn inspect_database_with_access(
    path: &Path,
    observe: &mut impl FnMut(RecoveryPhase),
    pager: InspectionPager,
    access: OpenFlags,
) -> Result<Inspection, String> {
    let _startup_time =
        crate::storage_timings::measure(crate::storage_timings::Stage::RecoveryInspection);
    let pager_configuration = pager.configuration()?;
    let open_time = crate::storage_timings::measure(crate::storage_timings::Stage::InspectionOpen);
    refuse_database_links(path)?;
    let inspection = (|| -> Result<Inspection, InspectionFailure> {
        let mut c = inspect_sql(Connection::open_with_flags(path, access))?;
        drop(open_time);
        let configure_time =
            crate::storage_timings::measure(crate::storage_timings::Stage::InspectionConfigure);
        inspect_sql(c.busy_timeout(Duration::from_secs(2)))?;
        // Connection-local bounds reduce small random reads during the full
        // integrity walk. SQLite/VFS may decline mmap and use its normal pager;
        // this does not skip checks or change any persisted database setting.
        inspect_sql(c.execute_batch(&pager_configuration))?;
        drop(configure_time);
        // Every admission check observes the same SQLite snapshot. No startup
        // configuration or schema write may cross this proof's fast path.
        let schema_time =
            crate::storage_timings::measure(crate::storage_timings::Stage::InspectionSchema);
        let tx = inspect_sql(c.transaction())?;
        let version: i64 = inspect_sql(tx.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
        if !matches!(version, 1..=19) {
            return Err(InspectionFailure::Refused("sqlite-unsupported-schema"));
        }
        if (13..=16).contains(&version) {
            let archive_tables: i64 = inspect_sql(tx.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('archive_catalog_meta_v1','archive_title_v1','archive_file_v1','archive_progress_v1','archive_preferences_v1','archive_item_progress_v1')",
                [], |row| row.get(0),
            ))?;
            if archive_tables != 6 {
                return Err(InspectionFailure::Refused(
                    "sqlite-incomplete-archive-schema",
                ));
            }
        }
        if (14..=16).contains(&version) {
            let removals: i64 = inspect_sql(tx.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='archive_removal_v1'",
                [],
                |r| r.get(0),
            ))?;
            if removals != 1 {
                return Err(InspectionFailure::Refused(
                    "sqlite-incomplete-archive-schema",
                ));
            }
        }
        if (15..=16).contains(&version) {
            let bookmarks: i64 = inspect_sql(tx.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('archive_bookmark_meta_v1','archive_bookmark_v1')",
                [],
                |r| r.get(0),
            ))?;
            if bookmarks != 2 {
                return Err(InspectionFailure::Refused(
                    "sqlite-incomplete-archive-bookmark-schema",
                ));
            }
            crate::archive_bookmarks::validate(&tx)
                .map_err(|_| InspectionFailure::Refused("sqlite-invalid-archive-bookmarks"))?;
        }
        if version == 16 {
            crate::archive_provider_catalog::validate(&tx)
                .map_err(|_| InspectionFailure::Refused("sqlite-invalid-public-archive-schema"))?;
        }
        if version >= 17 {
            archive_binding(&tx)
                .map_err(|_| InspectionFailure::Refused("archive-library-repair-required"))?;
        }
        if version >= 18 {
            crate::guide::retention::validate(&tx).map_err(|error| {
                InspectionFailure::Refused(if error == "guide-projection-policy-unsupported" {
                    "guide-projection-policy-unsupported"
                } else {
                    "guide-projection-state-invalid"
                })
            })?;
        }
        if version >= 19 {
            validate_content_library_schema(&tx)
                .map_err(|_| InspectionFailure::Refused("sqlite-invalid-content-library"))?;
        }
        drop(schema_time);
        let pager_ticket = {
            let _time =
                crate::storage_timings::measure(crate::storage_timings::Stage::InspectionPagerRead);
            // Diagnostics cannot turn a formerly accepted store into a refusal.
            // The same transaction supplies all five numeric values.
            let read = || -> rusqlite::Result<(i64, i64, i64, i64, i64)> {
                Ok((
                    tx.query_row("PRAGMA cache_size", [], |r| r.get(0))?,
                    tx.query_row("PRAGMA mmap_size", [], |r| r.get(0))?,
                    tx.query_row("PRAGMA page_count", [], |r| r.get(0))?,
                    tx.query_row("PRAGMA page_size", [], |r| r.get(0))?,
                    tx.query_row("PRAGMA freelist_count", [], |r| r.get(0))?,
                ))
            };
            read().ok().and_then(|(cache, mmap, pages, size, free)| {
                crate::storage_timings::record_pager(cache, mmap, pages, size, free)
            })
        };
        observe(RecoveryPhase::SchemaChecked);
        let check: String = {
            let _time = crate::storage_timings::measure(
                crate::storage_timings::Stage::InspectionQuickCheck,
            );
            inspect_sql(tx.query_row("PRAGMA quick_check", [], |r| r.get(0)))?
        };
        observe(RecoveryPhase::QuickCheck);
        if check != "ok" {
            return Ok(Inspection::Corrupt);
        }
        let violations: i64 = {
            let _time = crate::storage_timings::measure(
                crate::storage_timings::Stage::InspectionForeignKeys,
            );
            inspect_sql(
                tx.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                }),
            )?
        };
        observe(RecoveryPhase::ForeignKeys);
        if let Some(ticket) = pager_ticket {
            let _time =
                crate::storage_timings::measure(crate::storage_timings::Stage::InspectionPagerRead);
            if let Ok(mmap) = tx.query_row("PRAGMA mmap_size", [], |row| row.get::<_, i64>(0)) {
                crate::storage_timings::record_final_mmap(ticket, mmap);
            }
        }
        if violations != 0 {
            return Ok(Inspection::Corrupt);
        }
        let mode: String = inspect_sql(tx.query_row("PRAGMA journal_mode", [], |r| r.get(0)))?;
        let projection_current = version >= 9
            && crate::catalog_query::projection_is_current(&tx)
                .map_err(|_| InspectionFailure::Refused("sqlite-catalog-projection-invalid"))?;
        let proof = if version >= 16 && mode == "delete" && projection_current {
            Inspection::HealthyCurrent
        } else {
            Inspection::HealthyNeedsMutation
        };
        inspect_sql(tx.commit())?;
        Ok(proof)
    })();
    match inspection {
        Ok(valid) => Ok(valid),
        Err(InspectionFailure::Corrupt) => Ok(Inspection::Corrupt),
        Err(InspectionFailure::Refused(reason)) => Err(reason.into()),
    }
}

pub(super) fn bounded(path: &Path, limit: u64) -> Result<String, String> {
    refuse_link(path)?;
    let f = File::open(path).map_err(|_| "storage-read-failed")?;
    if f.metadata().map_err(|_| "storage-read-failed")?.len() > limit {
        return Err("record-too-large".into());
    }
    let mut s = String::new();
    f.take(limit + 1)
        .read_to_string(&mut s)
        .map_err(|_| "storage-read-failed")?;
    if s.len() as u64 > limit {
        return Err("record-too-large".into());
    }
    Ok(s)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LegacySnapshot {
    schema_version: u8,
    revision: u64,
    records: RecordPair,
    checksum: String,
}

pub(super) fn legacy_pair(root: &Path) -> Result<RecordPair, String> {
    let read_snapshot = |path: &Path| -> Result<RecordPair, String> {
        let s: LegacySnapshot = serde_json::from_str(&bounded(path, 4 * LIMIT + 1024)?)
            .map_err(|_| "legacy-pair-invalid")?;
        let mut h = Sha256::new();
        h.update(b"genx-record-pair-v1");
        h.update(s.revision.to_be_bytes());
        for v in [&s.records.catalog, &s.records.preferences] {
            if let Some(v) = v {
                h.update([1]);
                h.update((v.len() as u64).to_be_bytes());
                h.update(v.as_bytes());
            } else {
                h.update([0]);
            }
        }
        if s.schema_version != 1 || format!("{:x}", h.finalize()) != s.checksum {
            return Err("legacy-pair-integrity-failed".into());
        }
        validate(&s.records)?;
        Ok(s.records)
    };
    let main = root.join("record-pair.json");
    let backup = root.join("record-pair.json.backup");
    if main.exists() {
        return read_snapshot(&main).or_else(|e| {
            if backup.exists() {
                read_snapshot(&backup)
            } else {
                Err(e)
            }
        });
    }
    if backup.exists() {
        return read_snapshot(&backup);
    }
    let mut pair = RecordPair::default();
    for name in ["catalog", "preferences"] {
        let path = root.join(format!("{name}.json"));
        let backup = root.join(format!("{name}.json.backup"));
        let read = |path: &Path| -> Result<String, String> {
            let s = bounded(path, LIMIT)?;
            parse(&s)?;
            Ok(s)
        };
        let value = if path.exists() {
            Some(read(&path).or_else(|e| {
                if backup.exists() {
                    read(&backup)
                } else {
                    Err(e)
                }
            })?)
        } else if backup.exists() {
            Some(read(&backup)?)
        } else {
            None
        };
        if name == "catalog" {
            pair.catalog = value;
        } else {
            pair.preferences = value;
        }
    }
    validate(&pair)?;
    Ok(pair)
}
