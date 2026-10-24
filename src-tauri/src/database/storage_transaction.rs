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

//! Normalized canonical SQLite storage. JSON is only the compatibility/migration boundary.
#[cfg(test)]
#[path = "storage_guide_clone_bench_tests.rs"]
mod guide_clone_bench_tests;
#[path = "storage_guide_maintenance.rs"]
pub(crate) mod guide_maintenance;
#[cfg(test)]
#[path = "storage_guide_retention_tests.rs"]
mod guide_retention_tests;
use crate::storage::refuse_link;
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
const LIMIT: u64 = 20 * 1024 * 1024;
pub(crate) const DB: &str = "genx.sqlite3";
const BACKUP: &str = "genx.sqlite3.backup";
#[cfg(test)]
#[path = "automatic_guide_migration_tests.rs"]
mod automatic_guide_migration_tests;
#[cfg(test)]
#[path = "storage_backup_verification_tests.rs"]
mod backup_verification_tests;
#[path = "catalog_delta.rs"]
mod catalog_delta;
#[cfg(test)]
#[path = "catalog_delta_tests.rs"]
mod catalog_delta_tests;
#[path = "channel_categories.rs"]
mod channel_categories;
#[cfg(test)]
#[path = "channel_category_tests.rs"]
mod channel_category_tests;
#[path = "channel_check.rs"]
pub(crate) mod channel_check;
#[path = "channel_logo_store.rs"]
mod channel_logo_store;
#[cfg(test)]
#[path = "catalog_endpoint_policy_tests.rs"]
mod endpoint_policy_tests;
#[cfg(test)]
#[path = "storage_online_backup_tests.rs"]
mod online_backup_tests;
#[cfg(test)]
#[path = "catalog_page_cache_tests.rs"]
mod page_cache_tests;
#[cfg(test)]
#[path = "storage_pair_reuse_tests.rs"]
mod pair_reuse_tests;
#[cfg(test)]
#[path = "storage_parsed_read_tests.rs"]
mod parsed_read_tests;
#[path = "preference_extensions.rs"]
mod preference_extensions;
#[cfg(test)]
#[path = "preference_extensions_tests.rs"]
mod preference_extensions_tests;
#[cfg(test)]
#[path = "storage_preferences_roundtrip_tests.rs"]
mod preferences_roundtrip_tests;
#[cfg(test)]
#[path = "storage_recovery_lock_tests.rs"]
mod recovery_lock_tests;
#[path = "storage_resume_admission.rs"]
pub(crate) mod resume_admission;
#[path = "storage_resume_authority.rs"]
mod resume_authority;
#[path = "storage_resume_page.rs"]
pub(crate) mod resume_page;
#[cfg(test)]
#[path = "scan_batch_tests.rs"]
mod scan_batch_tests;
#[cfg(test)]
#[path = "scan_checkpoint_tests.rs"]
mod scan_checkpoint_tests;
#[cfg(test)]
#[path = "scan_window_tests.rs"]
mod scan_window_tests;
#[path = "source_snapshot.rs"]
pub(crate) mod source_snapshot;
#[path = "source_snapshot_activation.rs"]
pub(crate) mod source_snapshot_activation;
#[path = "source_snapshot_ambiguity.rs"]
mod source_snapshot_ambiguity;
#[cfg(test)]
#[path = "storage_startup_timing_tests.rs"]
mod startup_timing_tests;
#[path = "storage_resume_commit.rs"]
pub(crate) mod storage_resume_commit;
#[cfg(test)]
#[path = "storage_validated_value_reuse_tests.rs"]
mod validated_value_reuse_tests;
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct RecordPair {
    pub catalog: Option<String>,
    pub preferences: Option<String>,
}

#[cfg(test)]
mod public_archive_migration_tests {
    use super::*;
    #[test]
    fn schema15_upgrade_is_additive_and_preserves_exact_ia_namespaces() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        let tx = c.transaction().unwrap();
        crate::archive_catalog::install(&tx).unwrap();
        crate::archive_bookmarks::install(&tx).unwrap();
        let tr = crate::archive_catalog::opaque(&["archive-item-v1", "legacy"]);
        let fr = crate::archive_catalog::opaque(&["archive-file-v1", "legacy", "movie.mp4"]);
        tx.execute("INSERT INTO archive_title_v1(title_ref,item_id,title,kind,curated,searched,downloads,observed_ms,search_text) VALUES(?1,'legacy','Legacy title','movie',0,1,3,1,'Legacy title')",[&tr]).unwrap();
        tx.execute("INSERT INTO archive_file_v1(file_ref,title_ref,item_id,file_name,format,size_bytes,servers,observed_ms,eligible) VALUES(?1,?2,'legacy','movie.mp4','h.264','100','[]',1,1)",params![fr,tr]).unwrap();
        tx.execute(
            "INSERT INTO archive_preferences_v1 VALUES(?1,'legacy','Legacy title',NULL,1)",
            [&tr],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO archive_removal_v1 VALUES('file',?1,'legacy',?2,'Hidden file','hidden.mp4',1)",
            params!["b".repeat(64), tr],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO archive_bookmark_v1 VALUES(?1,'legacy','movie.mp4','100',?2,1000,5000,0,1)",
            params![fr, "a".repeat(40)],
        )
        .unwrap();
        tx.execute_batch("PRAGMA user_version=15").unwrap();
        tx.commit().unwrap();
        let before = ia_snapshot(&c);
        migrate(&mut c).unwrap();
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            16
        );
        assert_eq!(before, ia_snapshot(&c));
        crate::archive_provider_catalog::validate(&c).unwrap();
        migrate(&mut c).unwrap();
        assert_eq!(before, ia_snapshot(&c));
    }
    fn ia_snapshot(c: &Connection) -> Vec<(String, Vec<Vec<String>>)> {
        let mut result = Vec::new();
        for table in [
            "archive_title_v1",
            "archive_file_v1",
            "archive_preferences_v1",
            "archive_removal_v1",
            "archive_catalog_meta_v1",
            "archive_bookmark_v1",
            "archive_bookmark_meta_v1",
            "archive_progress_v1",
            "archive_item_progress_v1",
        ] {
            let mut s = c
                .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
                .unwrap();
            let n = s.column_count();
            let rows = s
                .query_map([], |r| {
                    Ok((0..n)
                        .map(|i| format!("{:?}", r.get_ref(i).unwrap()))
                        .collect::<Vec<_>>())
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            result.push((table.into(), rows));
        }
        result
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum PairCaptureStage {
    Before,
    After,
    BeforeCatalogReuse,
    BeforeDeltaReuse,
    AfterHealthReuse,
    AfterCheckpointReuse,
}
/// Exact SQL-derived canonical bytes and the values validated from those bytes.
/// Private transaction-local carrier; never retained across transactions or roots.
#[derive(Debug)]
struct ValidatedPair {
    pair: RecordPair,
    catalog: Option<Value>,
    preferences: Option<Value>,
}
struct PairReuse<'a, 'h> {
    validated: (Option<Value>, Option<Value>),
    before: Option<ValidatedPair>,
    projection_ids: Option<Vec<Vec<String>>>,
    health_groups: Option<&'h [String]>,
    observer: Option<&'a mut dyn FnMut(PairCaptureStage)>,
}

struct CapturedPair {
    catalog: Option<Value>,
    preferences: Option<Value>,
    extensions: [Option<String>; 3],
}
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordSnapshot {
    #[serde(flatten)]
    pub pair: RecordPair,
    pub health: Option<String>,
    pub catalog_revision: String,
    pub health_revision: String,
}
/// Program-guide capture omits unrelated health/checkpoint payloads.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GuideCaptureSnapshot {
    #[serde(flatten)]
    pub pair: RecordPair,
    pub catalog_revision: String,
}
/// Scan readers need health and the same captured CAS revisions, not catalog JSON.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanHealthSnapshot {
    pub health: Option<String>,
    pub catalog_revision: String,
    pub health_revision: String,
}
impl From<RecordSnapshot> for ScanHealthSnapshot {
    fn from(snapshot: RecordSnapshot) -> Self {
        Self {
            health: snapshot.health,
            catalog_revision: snapshot.catalog_revision,
            health_revision: snapshot.health_revision,
        }
    }
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitReceipt {
    pub committed: bool,
    pub catalog_revision: String,
    pub health_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint_revision: Option<String>,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogGroupReceipt {
    pub schema_version: u32,
    pub committed: bool,
    pub catalog_revision: String,
    pub view_revision: String,
    pub affected_count: usize,
}
pub struct PairStore {
    root: PathBuf,
    require_database: bool,
    /// Ordered result of the last channel-list query, reused for its next pages.
    page_cache: crate::catalog_query::PageCache,
}
#[cfg(not(test))]
fn write_backup_interval() -> std::time::Duration {
    crate::storage_backup_policy::INTERVAL
}
#[cfg(test)]
thread_local! {
    pub(crate) static TEST_WRITE_BACKUP_INTERVAL: std::cell::Cell<std::time::Duration> =
        const { std::cell::Cell::new(std::time::Duration::ZERO) };
}
#[cfg(test)]
fn write_backup_interval() -> std::time::Duration {
    TEST_WRITE_BACKUP_INTERVAL.with(|value| value.get())
}
#[cfg(test)]
#[path = "storage_archive_library_tests.rs"]
mod archive_library_tests;

impl PairStore {
    pub(crate) fn data_root_path(&self) -> &Path {
        &self.root
    }
    pub(crate) fn open_archive_library_locked(
        &self,
        lease: &crate::archive_library_store::RootLock,
        check: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<crate::archive_library_store::ArchiveStore, String> {
        use crate::archive_library_store as library;
        lease.verify_root(&self.root)?;
        let mut c = connect(&self.root.join(DB), false)?;
        let version: i64 = sql(c.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
        let witness = library::inspect(&self.root)?;
        let binding = match (version, witness.as_ref()) {
            (17..=19, Some(w)) => {
                let binding = archive_binding(&c)?;
                if binding != w.binding {
                    return Err(library::REPAIR.into());
                }
                binding
            }
            (16, Some(w)) if w.phase == library::Phase::Active => w.binding.clone(),
            (16, _) => library::prepare(lease, &c, check)?,
            _ => return Err(library::REPAIR.into()),
        };
        {
            let _caller = crate::storage_timings::archive_caller(
                crate::storage_timings::ArchiveCaller::OpenHandoff,
            );
            library::verify_handoff_pair(lease, &binding, check)?;
        }
        if version == 16 {
            self.backup_now_with_check(&c, &mut *check)?;
            let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
            // PREPARED still belongs to this exact source snapshot. ACTIVE is
            // permanent authority: restored legacy rows are retired, not read.
            if witness
                .as_ref()
                .is_none_or(|w| w.phase == library::Phase::Prepared)
                && library::source_fingerprint(&tx, check)? != binding.imported_digest
            {
                return Err(library::REPAIR.into());
            }
            sql(tx.execute_batch(ARCHIVE_BINDING_SQL))?;
            let encoded = serde_json::to_string(&binding).map_err(|_| library::REPAIR)?;
            sql(tx.execute(
                "INSERT INTO archive_authority_binding_v1 VALUES(1,1,?1)",
                [encoded],
            ))?;
            for table in [
                "public_archive_variant_v1",
                "public_archive_preference_v1",
                "public_archive_removal_v1",
                "public_archive_checkpoint_v1",
                "public_archive_item_v1",
                "archive_bookmark_v1",
                "archive_bookmark_meta_v1",
                "archive_item_progress_v1",
                "archive_progress_v1",
                "archive_preferences_v1",
                "archive_removal_v1",
                "archive_file_v1",
                "archive_title_v1",
                "archive_catalog_meta_v1",
            ] {
                sql(tx.execute_batch(&format!("DROP TABLE {table};")))?;
            }
            sql(tx.execute_batch("PRAGMA user_version=17;"))?;
            archive_binding(&tx)?;
            check()?;
            sql(tx.commit())?;
            // Durable retirement cannot be described as canceled afterward.
            self.backup_now(&c)
                .map_err(|_| library::REPAIR.to_string())?;
        } else {
            // PREPARED + committed seal may have crashed before its mirror.
            if witness
                .as_ref()
                .is_some_and(|w| w.phase == library::Phase::Prepared)
            {
                self.backup_now_with_check(&c, &mut *check)?;
            }
        }
        library::activate(
            lease,
            &binding,
            || {
                if archive_binding(&c)? == binding {
                    Ok(())
                } else {
                    Err(library::REPAIR.into())
                }
            },
            &mut || Ok(()),
        )?;
        let current: i64 = sql(c.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
        if current == 17 {
            // Policy metadata migration is non-destructive. Legacy full caches
            // remain untouched until explicit checked retention maintenance.
            self.backup_now_with_check(&c, &mut *check)?;
            let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
            crate::guide::retention::install(&tx)?;
            sql(tx.execute_batch("PRAGMA user_version=18;"))?;
            crate::guide::retention::validate(&tx)?;
            archive_binding(&tx)?;
            check()?;
            sql(tx.commit())?;
        }
        let current: i64 = sql(c.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
        if current == 18 {
            // Preserve the fully checked schema18 preimage. NULL means legacy
            // absence, independently of either explicit user library choice.
            self.backup_now_with_check(&c, &mut *check)?;
            let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
            sql(tx.execute_batch("ALTER TABLE preference ADD COLUMN content_library TEXT DEFAULT NULL CHECK(content_library IS NULL OR content_library IN ('live','genxtra'));PRAGMA user_version=19;"))?;
            validate_content_library_schema(&tx)?;
            archive_binding(&tx)?;
            check()?;
            sql(tx.commit())?;
        }
        drop(c);
        library::ArchiveStore::open_locked(lease, &binding, &mut || Ok(()))
    }
    #[cfg(test)]
    pub fn new(root: PathBuf) -> Result<Self, String> {
        Self::new_existing(root, false)
    }
    #[cfg(test)]
    pub(crate) fn new_existing(root: PathBuf, require_database: bool) -> Result<Self, String> {
        refuse_link(&root)?;
        if !root.is_dir() {
            return Err("storage-directory-unavailable".into());
        }
        let lease = crate::archive_library_store::lock_root(&root)?;
        Self::new_existing_locked(root, require_database, &lease)
    }
    pub(crate) fn new_existing_locked(
        root: PathBuf,
        require_database: bool,
        lease: &crate::archive_library_store::RootLock,
    ) -> Result<Self, String> {
        lease.verify_root(&root)?;
        refuse_link(&root)?;
        if !root.is_dir() {
            return Err("storage-directory-unavailable".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let absolute = root
                .canonicalize()
                .map_err(|_| "storage-directory-unavailable")?;
            let prefix = absolute
                .components()
                .next()
                .ok_or("storage-directory-unavailable")?;
            let drive = format!("{}\\", prefix.as_os_str().to_string_lossy());
            let wide: Vec<u16> = std::ffi::OsStr::new(&drive)
                .encode_wide()
                .chain(Some(0))
                .collect();
            if unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(wide.as_ptr()) } == 4
            {
                return Err("sqlite-local-volume-required".into());
            }
        }
        // Copies left by a backup or write interrupted by a crash or forced
        // stop; nothing can own one before this store opens.
        for abandoned in crate::storage_backup_policy::abandoned_temporaries(&root) {
            let _ = std::fs::remove_file(abandoned);
        }
        let s = Self {
            root,
            require_database,
            page_cache: Default::default(),
        };
        s.recover_observed_locked(lease, &mut |_| {})?;
        Ok(s)
    }
}
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Phase {
    BeforeWork,
    BeforeBackup,
    DuringBackup,
    AfterBackup,
    AfterCatalog,
    BeforeCommit,
    AfterCommit,
}

#[cfg(test)]
#[path = "health_storage_tests.rs"]
mod health_tests;

#[cfg(test)]
#[path = "storage_transaction_tests.rs"]
mod tests;

#[cfg(test)]
mod migration_and_lock_tests {
    use super::*;
    #[test]
    fn checksummed_legacy_pair_migrates_without_modifying_original() {
        let root = tempfile::tempdir().unwrap();
        let records = RecordPair {
            catalog: Some(json!({"schemaVersion":1,"sources":[],"channels":[]}).to_string()),
            preferences: None,
        };
        let mut h = Sha256::new();
        h.update(b"genx-record-pair-v1");
        h.update(7_u64.to_be_bytes());
        for v in [&records.catalog, &records.preferences] {
            if let Some(v) = v {
                h.update([1]);
                h.update((v.len() as u64).to_be_bytes());
                h.update(v.as_bytes());
            } else {
                h.update([0]);
            }
        }
        let text = json!({"schemaVersion":1,"revision":7,"records":records,"checksum":format!("{:x}",h.finalize())}).to_string();
        let path = root.path().join("record-pair.json");
        std::fs::write(&path, &text).unwrap();
        let store = PairStore::new(root.path().into()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(store.read("catalog").unwrap().as_ref().unwrap())
                .unwrap(),
            json!({"schemaVersion":1,"sources":[],"channels":[]})
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
    }
    #[test]
    fn lock_contention_has_bounded_deadline_and_preserves_whole_revision() {
        let root = tempfile::tempdir().unwrap();
        let store = PairStore::new(root.path().into()).unwrap();
        let c = connect(&root.path().join(DB), false).unwrap();
        c.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let began = std::time::Instant::now();
        assert!(store
            .write(
                "catalog",
                &json!({"schemaVersion":1,"sources":[],"channels":[]}).to_string()
            )
            .is_err());
        let elapsed = began.elapsed();
        assert!(elapsed < Duration::from_secs(4));
        c.execute_batch("ROLLBACK").unwrap();
        assert_eq!(store.read_pair().unwrap(), RecordPair::default());
    }
    #[test]
    fn full_100k_catalog_is_normalized_without_truncation() {
        let root = tempfile::tempdir().unwrap();
        let store = PairStore::new(root.path().into()).unwrap();
        let channels:Vec<Value>=(0..100000).map(|i|json!({"id":format!("c{i}"),"sourceId":"s","name":format!("Fixture {i}"),"category":"Sports","urls":[format!("https://example.invalid/live/{i}")]})).collect();
        let catalog =
            json!({"schemaVersion":1,"sources":[{"id":"s","name":"Fixture","kind":"file","location":"fixture"}],"channels":channels})
                .to_string();
        assert!(catalog.len() as u64 <= LIMIT);
        let start = std::time::Instant::now();
        store.write("catalog", &catalog).unwrap();
        let write_ms = start.elapsed().as_millis();
        let start = std::time::Instant::now();
        let read = store.read("catalog").unwrap().unwrap();
        let read_ms = start.elapsed().as_millis();
        let parsed: Value = serde_json::from_str(&read).unwrap();
        assert_eq!(parsed["channels"].as_array().unwrap().len(), 100000);
        assert_eq!(parsed["channels"][99999]["id"], "c99999");
        let c = connect(&root.path().join(DB), true).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM channel", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            100000
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM catalog_projection", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            100000
        );
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut query = super::tests::catalog_query();
        query.query = "Fixture".into();
        let mut times = Vec::new();
        for _ in 0..30 {
            let started = std::time::Instant::now();
            let page = store.query_catalog_page(&query, &flag).unwrap();
            times.push(started.elapsed().as_micros());
            assert_eq!(page.total_count, 100000);
            assert_eq!(page.rows.len(), 50);
            assert_eq!(page.rows[0].id, "c0");
            assert_eq!(page.rows[49].id, "c49");
            assert!(page.after.is_some());
            assert!(!serde_json::to_string(&page).unwrap().contains("https://"));
        }
        times.sort_unstable();
        println!(
            "native catalog indexed fixture scope=host-SQL-only samples=30 warm_p95_us={} query=common-title no_UI_IPC_hardware_acceptance",
            times[28]
        );
        println!(
            "sqlite fixture seed=0 channels=100000 input_bytes={} write_ms={} full_json_read_ms={} sqlite_bytes={}",
            catalog.len(),
            write_ms,
            read_ms,
            std::fs::metadata(root.path().join(DB)).unwrap().len()
        );
    }
}

fn scan_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or(u64::MAX)
}

// This module's parts, by area, are in storage_transaction/.
mod backup;
pub(crate) use backup::*;
mod records;
pub(crate) use records::*;
mod schema;
use schema::*;
mod inspection;
use inspection::*;
mod apply;
mod guide_access;
mod pair_capture;
mod record_writes;
mod scan_commits;
mod scan_manifest;
