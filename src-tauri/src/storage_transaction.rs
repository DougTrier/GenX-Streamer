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
#[derive(Clone, Copy, Debug, PartialEq)]
enum BackupPhase {
    SnapshotPinned,
    BeforeStep,
    StepCompleted,
    BeforeVerify,
    QuickCheckProgress,
    ForeignKeyProgress,
    BeforeSync,
    BeforeReplace,
}

// SQLite still calls us every 1000 VM operations. Only the expensive owner
// rendezvous is gated: first callback of each phase, then 10ms since the last
// successful reply. No integrity result is cached or omitted. BeforeSync and
// BeforeReplace still consult the original, possibly borrowed FnMut authority.
// Worker, channels and callback are retained and joined on refusal or unwind.
#[derive(Default)]
struct BackupRendezvous {
    observed: Option<std::time::Instant>,
    granted: Option<(BackupPhase, std::time::Instant)>,
    refused_clock: bool,
}
impl BackupRendezvous {
    const INTERVAL: Duration = Duration::from_millis(10);
    fn observe(&mut self, now: std::time::Instant) -> Result<(), ()> {
        if self.refused_clock
            || self
                .observed
                .is_some_and(|previous| now.checked_duration_since(previous).is_none())
        {
            self.refused_clock = true;
            return Err(());
        }
        self.observed = Some(now);
        Ok(())
    }
    fn due(&mut self, phase: BackupPhase, now: std::time::Instant) -> Result<bool, ()> {
        self.observe(now)?;
        Ok(self.granted.is_none_or(|(previous_phase, replied)| {
            phase != previous_phase || now.duration_since(replied) >= Self::INTERVAL
        }))
    }
    fn grant(&mut self, phase: BackupPhase, replied: std::time::Instant) -> Result<(), ()> {
        self.observe(replied)?;
        self.granted = Some((phase, replied));
        Ok(())
    }
}
struct BackupVerifier {
    progress: Option<std::sync::mpsc::Receiver<BackupPhase>>,
    replies: Option<std::sync::mpsc::SyncSender<bool>>,
    worker: Option<std::thread::JoinHandle<Result<(), String>>>,
}
impl BackupVerifier {
    fn join(&mut self) -> Result<(), String> {
        // Disconnect both endpoints before joining, including during unwind.
        // A blocked send/recv in the SQL callback then refuses continuation.
        self.progress.take();
        self.replies.take();
        self.worker
            .take()
            .ok_or("sqlite-verification-worker-failed")?
            .join()
            .map_err(|_| "sqlite-verification-worker-failed")?
    }
}
impl Drop for BackupVerifier {
    fn drop(&mut self) {
        if self.worker.is_some() {
            let _ = self.join();
        }
    }
}
fn verify_backup_owned(
    path: &Path,
    phase: &mut impl FnMut(BackupPhase) -> Result<(), String>,
) -> Result<(), String> {
    use std::sync::{
        atomic::{AtomicU8, Ordering},
        mpsc, Arc,
    };
    let (progress_tx, progress_rx) = mpsc::sync_channel(1);
    let (reply_tx, reply_rx) = mpsc::sync_channel(0);
    let path = path.to_owned();
    let worker = std::thread::Builder::new()
        .name("genx-backup-verifier".into())
        .spawn(move || {
            let copy = connect(&path, true)?;
            // Use the same bounded connection-local read policy as startup.
            // The private snapshot is still checked in full, closed and joined
            // before sync/replacement; mmap may fall back to ordinary reads.
            sql(copy.execute_batch(&InspectionPager::DEFAULT.configuration()?))?;
            let marker = Arc::new(AtomicU8::new(0));
            let callback_marker = marker.clone();
            let mut rendezvous = BackupRendezvous::default();
            sql(copy.progress_handler(
                1000,
                Some(move || {
                    let stage = if callback_marker.load(Ordering::Relaxed) == 2 {
                        BackupPhase::ForeignKeyProgress
                    } else {
                        BackupPhase::QuickCheckProgress
                    };
                    match rendezvous.due(stage, std::time::Instant::now()) {
                        Ok(false) => return false,
                        Ok(true) => (),
                        Err(()) => return true,
                    }
                    if progress_tx.send(stage).is_err() || !matches!(reply_rx.recv(), Ok(true)) {
                        return true;
                    }
                    // Start the interval after the actual successful reply, not
                    // before a potentially slow authority check or scheduler wait.
                    rendezvous.grant(stage, std::time::Instant::now()).is_err()
                }),
            ))?;
            let result = integrity_parts(&copy, Some(&marker));
            // Clear while the connection still exists. Closing it on any panic also
            // releases the callback/channels; the retained owner always joins us.
            let cleared = sql(copy.progress_handler(0, None::<fn() -> bool>));
            result.and(cleared)
        })
        .map_err(|_| "sqlite-verification-worker-failed")?;
    let mut verifier = BackupVerifier {
        progress: Some(progress_rx),
        replies: Some(reply_tx),
        worker: Some(worker),
    };
    let mut refused = None;
    while let Ok(step) = verifier
        .progress
        .as_ref()
        .ok_or("sqlite-verification-worker-failed")?
        .recv()
    {
        crate::storage_timings::backup_verification_handshake();
        let permitted = if refused.is_some() {
            false
        } else {
            match phase(step) {
                Ok(()) => true,
                Err(error) => {
                    refused = Some(error);
                    false
                }
            }
        };
        if verifier
            .replies
            .as_ref()
            .ok_or("sqlite-verification-worker-failed")?
            .send(permitted)
            .is_err()
        {
            break;
        }
    }
    let result = verifier.join();
    match refused {
        Some(error) => Err(error),
        None => result,
    }
}
// Copy existing SQLite pages without rebuilding indexes. Unlike VACUUM INTO,
// this retains freelist pages: it is not a secure-deletion or compacting step.
pub(crate) fn copy_sqlite_snapshot_checked(
    source: &Connection,
    destination: &mut Connection,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    copy_backup_pages(source, destination, &mut |_| check())
}
fn copy_backup_pages(
    source: &Connection,
    destination: &mut Connection,
    phase: &mut impl FnMut(BackupPhase) -> Result<(), String>,
) -> Result<(), String> {
    const PAGES_PER_STEP: i32 = 64;
    let pinned = sql(source.unchecked_transaction())?;
    // Establish a read snapshot before copying, preventing a changing source
    // from restarting the backup or mixing pre-write revisions between steps.
    sql(
        pinned.query_row("SELECT count(*) FROM sqlite_schema", [], |r| {
            r.get::<_, i64>(0)
        }),
    )?;
    let page_count: i64 = sql(pinned.query_row("PRAGMA page_count", [], |r| r.get(0)))?;
    let pages = u64::try_from(page_count).map_err(|_| "sqlite-operation-failed")?;
    let step_limit = pages.max(1).div_ceil(PAGES_PER_STEP as u64) + 1;
    phase(BackupPhase::SnapshotPinned)?;
    {
        let backup = sql(rusqlite::backup::Backup::new(&pinned, destination))?;
        let mut complete = false;
        for _ in 0..step_limit {
            phase(BackupPhase::BeforeStep)?;
            let step = sql(backup.step(PAGES_PER_STEP))?;
            phase(BackupPhase::StepCompleted)?;
            match step {
                rusqlite::backup::StepResult::Done => {
                    complete = true;
                    break;
                }
                rusqlite::backup::StepResult::More => {}
                // Keep existing bounded SQLite busy handling; never spin/retry
                // a busy or locked source/destination indefinitely.
                _ => return Err("sqlite-operation-failed".into()),
            }
        }
        if !complete {
            return Err("sqlite-operation-failed".into());
        }
        // Drop Backup (finish) before destination verification or use.
    }
    sql(pinned.commit())?;
    Ok(())
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
pub(crate) fn sql_error_code(error: &rusqlite::Error, fallback: &'static str) -> String {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DiskFull) => "sqlite-storage-full".into(),
        // Another connection held the database past the busy timeout.
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            "sqlite-busy".into()
        }
        _ => fallback.into(),
    }
}
fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|error| sql_error_code(&error, "sqlite-operation-failed"))
}
fn text<'a>(value: &'a Value, field: &str, max: usize, empty: bool) -> Result<&'a str, String> {
    let s = value
        .get(field)
        .and_then(Value::as_str)
        .ok_or("record-invalid-field")?;
    if s.len() > max || (!empty && s.is_empty()) {
        return Err("record-invalid-field".into());
    }
    Ok(s)
}
fn array<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a Vec<Value>, String> {
    let a = v
        .get(key)
        .and_then(Value::as_array)
        .ok_or("record-invalid-array")?;
    if a.len() > max {
        return Err("record-array-too-large".into());
    }
    Ok(a)
}
fn parse(s: &str) -> Result<Value, String> {
    if s.len() as u64 > LIMIT {
        return Err("record-too-large".into());
    }
    let v: Value = serde_json::from_str(s).map_err(|_| "record-invalid-json")?;
    if v.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("record-unsupported-schema".into());
    }
    Ok(v)
}
fn source(v: &Value) -> Result<(), String> {
    text(v, "id", 256, false)?;
    text(v, "name", 512, false)?;
    let location = text(v, "location", 16384, false)?;
    let kind = text(v, "kind", 8, false)?;
    if !matches!(kind, "file" | "url") {
        return Err("record-invalid-source-kind".into());
    }
    if v.get("allowHttp").is_some_and(|x| !x.is_boolean()) {
        return Err("record-invalid-http-grant".into());
    }
    if kind == "url" {
        url(
            location,
            v.get("allowHttp").and_then(Value::as_bool).unwrap_or(false),
        )?;
    }
    if let Some(k) = v.get("contentKind") {
        if !matches!(k.as_str(), Some("catalog" | "hls" | "media")) {
            return Err("record-invalid-content-kind".into());
        }
    }
    if v.get("mediaMime").is_some_and(|m| {
        m.as_str().is_none_or(|s| {
            s.len() > 128
                || !s.split_once('/').is_some_and(|(a, b)| {
                    [a, b].iter().all(|part| {
                        !part.is_empty()
                            && part
                                .bytes()
                                .all(|ch| ch.is_ascii_alphanumeric() || b".+-".contains(&ch))
                    })
                })
        })
    }) {
        return Err("record-invalid-mime".into());
    }
    Ok(())
}
fn url(s: &str, http: bool) -> Result<(), String> {
    let u = reqwest::Url::parse(s).map_err(|_| "record-invalid-url")?;
    if s.len() > 16384
        || !u.username().is_empty()
        || u.password().is_some()
        || u.host_str().is_none()
        || !(u.scheme() == "https" || (http && u.scheme() == "http"))
    {
        return Err("record-invalid-url".into());
    }
    Ok(())
}
fn identities(v: &Value, key: &str) -> Result<(), String> {
    let empty = Vec::new();
    let a = if key == "removedChannels" && v.get(key).is_none() {
        &empty
    } else {
        array(v, key, 100000)?
    };
    let mut seen = HashSet::new();
    for x in a {
        let s = x.as_str().ok_or("record-invalid-identity")?;
        if s.is_empty() || s.len() > 16384 || !seen.insert(s) {
            return Err("record-invalid-identity".into());
        }
    }
    Ok(())
}
pub(crate) fn validate_checkpoint_catalog(catalog: &Value) -> Result<(), String> {
    validate(&RecordPair {
        catalog: Some(serde_json::to_string(catalog).map_err(|_| "scan-checkpoint-invalid")?),
        preferences: None,
    })
    .map(|_| ())
    .map_err(|_| "scan-checkpoint-invalid".into())
}
fn validate(pair: &RecordPair) -> Result<(Option<Value>, Option<Value>), String> {
    let c = pair.catalog.as_deref().map(parse).transpose()?;
    let mut p = pair.preferences.as_deref().map(parse).transpose()?;
    if let Some(pref) = p.as_mut() {
        preference_extensions::normalize(pref)?;
    }
    let mut ids = HashSet::new();
    if let Some(c) = &c {
        let sources = array(c, "sources", 100)?;
        for s in sources {
            source(s)?;
            if !ids.insert(text(s, "id", 256, false)?) {
                return Err("record-duplicate-source".into());
            }
        }
        let mut channels = HashSet::new();
        for ch in array(c, "channels", 100000)? {
            let id = text(ch, "id", 16384, false)?;
            if !channels.insert(id) {
                return Err("record-duplicate-channel".into());
            }
            let sid = text(ch, "sourceId", 256, false)?;
            let source = sources
                .iter()
                .find(|s| s["id"].as_str() == Some(sid))
                .ok_or("record-missing-source")?;
            text(ch, "name", 16384, false)?;
            text(ch, "category", 16384, true)?;
            if ch.get("providerId").is_some() {
                text(ch, "providerId", 16384, false)?;
            }
            geography(ch)?;
            let urls = array(ch, "urls", 16)?;
            if urls.is_empty() {
                return Err("record-missing-url".into());
            }
            let mut unique = HashSet::new();
            for u in urls {
                let s = u.as_str().ok_or("record-invalid-url")?;
                url(s, source["allowHttp"].as_bool().unwrap_or(false))?;
                if !unique.insert(s) {
                    return Err("record-duplicate-url".into());
                }
            }
        }
    }
    if let Some(p) = &p {
        identities(p, "favorites")?;
        identities(p, "removedChannels")?;
        let volume = p
            .get("volume")
            .and_then(Value::as_f64)
            .ok_or("record-invalid-volume")?;
        let width = p
            .get("panelWidth")
            .and_then(Value::as_f64)
            .ok_or("record-invalid-panel")?;
        if !(0.0..=1.0).contains(&volume)
            || !(220.0..=600.0).contains(&width)
            || p.get("muted").and_then(Value::as_bool).is_none()
        {
            return Err("record-invalid-preferences".into());
        }
        if p.get("automaticSourceRefresh")
            .is_some_and(|v| v.as_bool().is_none())
            || p.get("sourceRefreshAttemptAt").is_some_and(|v| {
                v.as_f64().is_none_or(|n| {
                    !n.is_finite()
                        || !(0.0..=8_640_000_000_000_000.0).contains(&n)
                        || n.fract() != 0.0
                })
            })
        {
            return Err("record-invalid-source-refresh".into());
        }
        crate::refresh_cadence::from_preferences(p)?;
        let mut seen = HashSet::new();
        for s in array(p, "sources", 100)? {
            source(s)?;
            if !seen.insert(text(s, "id", 256, false)?) {
                return Err("record-duplicate-source".into());
            }
        }
        // Catalog sources are canonical; preferences mirror is reconstructed on reads.
    }
    if let (Some(catalog), Some(preferences)) = (&c, &p) {
        if catalog["sources"] != preferences["sources"] {
            return Err("record-source-mirror-mismatch".into());
        }
    }
    Ok((c, p))
}
const SCHEMA:&str="CREATE TABLE metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,catalog_present INTEGER NOT NULL,preferences_present INTEGER NOT NULL);
INSERT INTO metadata VALUES(1,0,0,0);
CREATE TABLE source(id TEXT PRIMARY KEY,name TEXT NOT NULL,location TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('url','file')),allow_http INTEGER NOT NULL CHECK(allow_http IN(0,1)),content_kind TEXT,media_mime TEXT,ordinal INTEGER NOT NULL);
CREATE TABLE channel(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES source(id),provider_id TEXT,name TEXT NOT NULL,category TEXT NOT NULL,ordinal INTEGER NOT NULL);
CREATE INDEX channel_source ON channel(source_id);CREATE INDEX channel_category ON channel(category);CREATE INDEX channel_name ON channel(name COLLATE NOCASE);
CREATE TABLE channel_url(channel_id TEXT NOT NULL REFERENCES channel(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,url TEXT NOT NULL,PRIMARY KEY(channel_id,ordinal),UNIQUE(channel_id,url));
CREATE TABLE favorite(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL);CREATE TABLE removed(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL);
CREATE TABLE preference(singleton INTEGER PRIMARY KEY CHECK(singleton=1),volume REAL NOT NULL CHECK(volume BETWEEN 0 AND 1),muted INTEGER NOT NULL CHECK(muted IN(0,1)),panel_width REAL NOT NULL CHECK(panel_width BETWEEN 220 AND 600));PRAGMA user_version=1;";
fn refuse_database_links(path: &Path) -> Result<(), String> {
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
const BACKGROUND_BUSY_TIMEOUT: Duration = Duration::from_secs(30);
fn connect_background(path: &Path, readonly: bool) -> Result<Connection, String> {
    let c = connect(path, readonly)?;
    sql(c.busy_timeout(BACKGROUND_BUSY_TIMEOUT))?;
    Ok(c)
}
fn connect(path: &Path, readonly: bool) -> Result<Connection, String> {
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
const ARCHIVE_BINDING_SQL: &str = "CREATE TABLE archive_authority_binding_v1(singleton INTEGER PRIMARY KEY CHECK(singleton=1),format INTEGER NOT NULL CHECK(format=1),binding TEXT NOT NULL CHECK(length(CAST(binding AS BLOB))<=2048));";
fn archive_binding(c: &Connection) -> Result<crate::archive_library_store::Binding, String> {
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
fn archive_peer_matches(
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
fn migrate(c: &mut Connection) -> Result<(), String> {
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
fn geography(ch: &Value) -> Result<(), String> {
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
fn integrity(c: &Connection) -> Result<(), String> {
    integrity_parts(c, None)
}
fn integrity_parts(
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

fn validate_content_library_schema(c: &Connection) -> Result<(), String> {
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

enum InspectionFailure {
    Corrupt,
    Refused(&'static str),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Inspection {
    Corrupt,
    HealthyCurrent,
    HealthyNeedsMutation,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecoveryPhase {
    SchemaChecked,
    QuickCheck,
    ForeignKeys,
    ProofReused,
    Migration,
    FinalIntegrity,
}
fn inspect_sql<T>(result: rusqlite::Result<T>) -> Result<T, InspectionFailure> {
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
fn inspect_existing_database(
    path: &Path,
    observe: &mut impl FnMut(RecoveryPhase),
) -> Result<Inspection, String> {
    inspect_existing_database_with_pager(path, observe, InspectionPager::DEFAULT)
}

#[derive(Clone, Copy)]
struct InspectionPager {
    cache_kib: u32,
    mmap_bytes: u64,
}
impl InspectionPager {
    const DEFAULT: Self = Self {
        cache_kib: 8192,
        // Bounded file-backed mapping, not an eager heap allocation. SQLite maps
        // at most the file length and its VFS falls back to reads if mmap fails.
        // ARMv7 startup latency and peak memory still require device comparison.
        mmap_bytes: 268435456,
    };
    fn configuration(self) -> Result<String, String> {
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
fn inspect_existing_database_with_pager(
    path: &Path,
    observe: &mut impl FnMut(RecoveryPhase),
    pager: InspectionPager,
) -> Result<Inspection, String> {
    inspect_database_with_access(path, observe, pager, OpenFlags::SQLITE_OPEN_READ_WRITE)
}
fn inspect_database_with_access(
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
fn bounded(path: &Path, limit: u64) -> Result<String, String> {
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
struct LegacySnapshot {
    schema_version: u8,
    revision: u64,
    records: RecordPair,
    checksum: String,
}
fn legacy_pair(root: &Path) -> Result<RecordPair, String> {
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
    #[cfg(test)]
    fn recover_observed(&self, mut observe: impl FnMut(RecoveryPhase)) -> Result<(), String> {
        let lease = crate::archive_library_store::lock_root(&self.root)?;
        self.recover_observed_locked(&lease, &mut observe)
    }
    fn recover_observed_locked(
        &self,
        lease: &crate::archive_library_store::RootLock,
        observe: &mut impl FnMut(RecoveryPhase),
    ) -> Result<(), String> {
        // Inspect the permanent authority before any older canonical peer can
        // be considered for recovery. Invalid markers never authorize fallback.
        let mut authority = crate::archive_library_store::inspect(&self.root)?;
        if authority.is_none() {
            let directory = self.root.join("archive-library-v1");
            refuse_link(&directory)?;
            let mut orphan = false;
            for name in ["archive.sqlite3", "archive.sqlite3.backup"] {
                let path = directory.join(name);
                refuse_link(&path)?;
                orphan |= path
                    .try_exists()
                    .map_err(|_| crate::archive_library_store::REPAIR)?;
            }
            if orphan {
                // Only an exact, unadopted sequence-zero export can recreate a
                // PREPARED witness. Never restore a main peer first and then
                // discover that a committed namespace forbids that history.
                let source = connect(&self.root.join(DB), true)
                    .map_err(|_| crate::archive_library_store::REPAIR)?;
                crate::archive_library_store::prepare(lease, &source, &mut || Ok(()))?;
                authority = crate::archive_library_store::inspect(&self.root)?;
            }
        }
        if let Some(witness) = authority.as_ref() {
            let _caller = crate::storage_timings::archive_caller(
                crate::storage_timings::ArchiveCaller::RecoveryHandoff,
            );
            crate::archive_library_store::verify_handoff_pair(
                lease,
                &witness.binding,
                &mut || Ok(()),
            )?;
        }
        let main = self.root.join(DB);
        let backup = self.root.join(BACKUP);
        refuse_link(&main)?;
        refuse_link(&backup)?;
        if self.require_database && !main.is_file() {
            return Err("sqlite-required-database-missing".into());
        }
        let journal_present = ["-journal", "-wal", "-shm"]
            .iter()
            .any(|suffix| self.root.join(format!("{DB}{suffix}")).exists());
        if main.exists() && journal_present {
            let mut header = [0_u8; 16];
            if File::open(&main)
                .and_then(|mut file| file.read_exact(&mut header))
                .is_err()
                || &header != b"SQLite format 3\0"
            {
                return Err("sqlite-recovery-journal-present".into());
            }
        }
        let inspection = if main.exists() {
            inspect_existing_database(&main, observe)?
        } else {
            Inspection::Corrupt
        };
        if inspection != Inspection::Corrupt {
            if let Some(witness) = authority.as_ref() {
                if !archive_peer_matches(&connect(&main, true)?, witness)? {
                    return Err(crate::archive_library_store::REPAIR.into());
                }
            }
        }
        if inspection == Inspection::HealthyCurrent {
            // Current DELETE databases require no startup mutation. Reuse the
            // coherent schema/quick-check/FK proof; writes configure their own
            // connection later. Never reuse it for migrations or mode changes.
            observe(RecoveryPhase::ProofReused);
            return Ok(());
        }
        if inspection == Inspection::HealthyNeedsMutation {
            let mut c = connect(&main, false)?;
            let version = sql(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))?;
            // Capture the current derived-policy authority before its verified
            // backup. Older schemas are fenced by their existing migration.
            let projection_fence = if version >= 15 {
                crate::catalog_query::projection_upgrade_fence(&c)?
            } else {
                None
            };
            if version < 16 || projection_fence.is_some() {
                self.backup_now(&c)?;
            }
            {
                let _time = crate::storage_timings::measure(
                    crate::storage_timings::Stage::RecoveryMigration,
                );
                observe(RecoveryPhase::Migration);
                migrate(&mut c)?;
                crate::catalog_query::upgrade_projection_policy(&mut c, projection_fence)?;
            }
            {
                let _time = crate::storage_timings::measure(
                    crate::storage_timings::Stage::RecoveryFinalIntegrity,
                );
                observe(RecoveryPhase::FinalIntegrity);
                integrity(&c)?;
            }
            return Ok(());
        }
        if backup.exists() {
            let c = connect(&backup, true)?;
            integrity(&c)?;
            if let Some(witness) = authority.as_ref() {
                if !archive_peer_matches(&c, witness)? {
                    return Err(crate::archive_library_store::REPAIR.into());
                }
            }
            drop(c);
            if journal_present {
                return Err("sqlite-recovery-journal-present".into());
            }
            let mut tmp = tempfile::NamedTempFile::new_in(&self.root)
                .map_err(|_| "sqlite-recovery-failed")?;
            std::io::copy(
                &mut File::open(&backup).map_err(|_| "sqlite-recovery-failed")?,
                &mut tmp,
            )
            .map_err(|_| "sqlite-recovery-failed")?;
            tmp.as_file()
                .sync_all()
                .map_err(|_| "sqlite-recovery-failed")?;
            tmp.persist(&main).map_err(|_| "sqlite-recovery-failed")?;
            let mut restored = connect(&main, false)?;
            {
                let _time = crate::storage_timings::measure(
                    crate::storage_timings::Stage::RecoveryMigration,
                );
                observe(RecoveryPhase::Migration);
                migrate(&mut restored)?;
                crate::catalog_query::upgrade_projection_policy(&mut restored, None)?;
            }
            {
                let _time = crate::storage_timings::measure(
                    crate::storage_timings::Stage::RecoveryFinalIntegrity,
                );
                observe(RecoveryPhase::FinalIntegrity);
                integrity(&restored)?;
            }
            return Ok(());
        }
        if main.exists() {
            return Err("sqlite-recovery-unavailable".into());
        }
        if authority.is_some() {
            // A permanent Archive authority proves this was an existing root.
            // Missing canonical peers are not permission to erase Live data by
            // silently manufacturing a fresh main database.
            return Err(crate::archive_library_store::REPAIR.into());
        }
        let legacy = legacy_pair(&self.root)?;
        let tmp =
            tempfile::NamedTempFile::new_in(&self.root).map_err(|_| "sqlite-create-failed")?;
        {
            let mut c = connect(tmp.path(), false)?;
            let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
            sql(tx.execute_batch(SCHEMA))?;
            sql(tx.commit())?;
            {
                let _time = crate::storage_timings::measure(
                    crate::storage_timings::Stage::RecoveryMigration,
                );
                observe(RecoveryPhase::Migration);
                migrate(&mut c)?;
            }
            Self::apply(&mut c, &legacy, |_| Ok(()))?;
            {
                let _time = crate::storage_timings::measure(
                    crate::storage_timings::Stage::RecoveryFinalIntegrity,
                );
                observe(RecoveryPhase::FinalIntegrity);
                integrity(&c)?;
            }
        }
        tmp.as_file()
            .sync_all()
            .map_err(|_| "sqlite-create-failed")?;
        tmp.persist(main).map_err(|_| "sqlite-create-failed")?;
        Ok(())
    }
    fn backup(&self, c: &Connection) -> Result<(), String> {
        self.backup_with_check(c, || Ok(()))
    }
    /// Before an ordinary write: reuse a verified backup younger than the
    /// write-backup interval, otherwise take one now (see storage_backup_policy).
    fn backup_with_check(
        &self,
        c: &Connection,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        if crate::storage_backup_policy::fresh(&self.root.join(BACKUP), write_backup_interval()) {
            check()?;
        } else {
            self.backup_now_with_check(c, &mut check)?;
        }
        crate::storage_backup_policy::note_write();
        Ok(())
    }
    /// Upgrade and recovery paths: always take a fresh verified backup.
    fn backup_now(&self, c: &Connection) -> Result<(), String> {
        self.backup_now_with_check(c, || Ok(()))
    }
    fn backup_now_with_check(
        &self,
        c: &Connection,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        check()?;
        self.backup_observed(c, &mut |_| check())?;
        crate::storage_backup_policy::note_backed_up();
        Ok(())
    }
    /// The background refresh: a compact copy (`VACUUM INTO`, live pages only)
    /// from a read-only connection, the same full verification as every backup,
    /// then an atomic swap. `abort` is polled throughout; returning true stops
    /// the copy and leaves the previous backup in place. The caller holds the
    /// writer lease, so the copy is a consistent image.
    pub(crate) fn compact_backup(
        &self,
        abort: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<(), String> {
        let path = self.root.join(BACKUP);
        refuse_link(&path)?;
        if abort() {
            return Err("storage-backup-deferred".into());
        }
        let tmp =
            tempfile::NamedTempFile::new_in(&self.root).map_err(|_| "sqlite-backup-failed")?;
        {
            let source = connect(&self.root.join(DB), true)?;
            let stop = abort.clone();
            sql(source.progress_handler(1000, Some(move || stop())))?;
            let target = tmp
                .path()
                .to_str()
                .ok_or("sqlite-backup-failed")?
                .to_owned();
            let copied = source.execute("VACUUM INTO ?1", [target]);
            let _ = source.progress_handler(0, None::<fn() -> bool>);
            if abort() {
                return Err("storage-backup-deferred".into());
            }
            copied.map_err(|_| "sqlite-backup-failed")?;
        }
        verify_backup_owned(tmp.path(), &mut |_| {
            if abort() {
                Err("storage-backup-deferred".into())
            } else {
                Ok(())
            }
        })?;
        tmp.as_file()
            .sync_all()
            .map_err(|_| "sqlite-backup-failed")?;
        if abort() {
            return Err("storage-backup-deferred".into());
        }
        tmp.persist(&path).map_err(|_| "sqlite-backup-failed")?;
        crate::storage_backup_policy::note_backed_up();
        Ok(())
    }
    pub(crate) fn backup_path(&self) -> PathBuf {
        self.root.join(BACKUP)
    }
    fn backup_observed(
        &self,
        c: &Connection,
        phase: &mut impl FnMut(BackupPhase) -> Result<(), String>,
    ) -> Result<(), String> {
        let _time = crate::storage_timings::measure(crate::storage_timings::Stage::Backup);
        let path = self.root.join(BACKUP);
        refuse_link(&path)?;
        let tmp =
            tempfile::NamedTempFile::new_in(&self.root).map_err(|_| "sqlite-backup-failed")?;
        {
            let _copy = crate::storage_timings::measure(crate::storage_timings::Stage::BackupCopy);
            let mut destination = connect(tmp.path(), false)?;
            copy_backup_pages(c, &mut destination, phase)?;
        }
        phase(BackupPhase::BeforeVerify)?;
        verify_backup_owned(tmp.path(), phase)?;
        phase(BackupPhase::BeforeSync)?;
        {
            let _sync = crate::storage_timings::measure(crate::storage_timings::Stage::BackupSync);
            tmp.as_file()
                .sync_all()
                .map_err(|_| "sqlite-backup-failed")?;
        }
        phase(BackupPhase::BeforeReplace)?;
        let _replace =
            crate::storage_timings::measure(crate::storage_timings::Stage::BackupReplace);
        tmp.persist(path).map_err(|_| "sqlite-backup-failed")?;
        Ok(())
    }
    pub fn with_guide_read<T>(
        &self,
        read: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let c = connect(&self.root.join(DB), true)?;
        read(&c)
    }
    pub fn query_catalog_page(
        &self,
        query: &crate::catalog_query::Query,
        cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<crate::catalog_query::Page, String> {
        let path = self.root.join(DB);
        let c = connect(&path, true)?;
        crate::catalog_query::query_page_cached(&c, query, cancel, &self.page_cache, &path)
    }
    pub fn with_guide_write<T>(
        &self,
        write: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut c = connect(&self.root.join(DB), false)?;
        self.backup(&c)?;
        write(&mut c)
    }
    pub(crate) fn with_guide_write_checked<T>(
        &self,
        write: impl FnOnce(&mut Connection) -> Result<T, String>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<T, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), false)?;
        self.backup_with_check(&c, &mut check)?;
        check()?;
        // The callback owns its transaction and final admission. Never run a
        // post-callback cancellation check over an actual durable receipt.
        write(&mut c)
    }
    /// Preflight must only read; it may prove a no-op without a speculative write.
    /// The caller retains its Store writer lease across preflight and commit.
    pub(crate) fn with_guide_write_preflight_checked<T>(
        &self,
        preflight: impl FnOnce(&Connection) -> Result<Option<T>, String>,
        write: impl FnOnce(&mut Connection, &mut dyn FnMut() -> Result<(), String>) -> Result<T, String>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<T, String> {
        check()?;
        let c = connect(&self.root.join(DB), true)?;
        let unchanged = preflight(&c)?;
        check()?;
        if let Some(receipt) = unchanged {
            return Ok(receipt);
        }
        drop(c);
        let mut c = connect(&self.root.join(DB), false)?;
        self.backup_with_check(&c, &mut check)?;
        check()?;
        // COMMIT is owned by the callback. Never erase its durable receipt with
        // a post-callback cancellation check.
        write(&mut c, &mut check)
    }
    #[cfg(test)]
    pub(crate) fn write_archive_bookmark_checked(
        &self,
        proof: &crate::archive_bookmarks::Proof,
        revision: &str,
        position: &crate::archive_bookmarks::Position,
        mut check: impl Fn() -> Result<(), String>,
    ) -> Result<crate::archive_bookmarks::Receipt, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), false)?;
        if let Some(receipt) =
            crate::archive_bookmarks::preflight_save(&c, proof, revision, position, &check)?
        {
            return Ok(receipt);
        }
        self.backup_with_check(&c, &mut check)?;
        // save owns fresh transaction admission and final cancellation check.
        // No check after its COMMIT may hide a durable receipt.
        crate::archive_bookmarks::save(&mut c, proof, revision, position, check)
    }
    pub fn read_snapshot(&self) -> Result<RecordSnapshot, String> {
        self.read_snapshot_after_capture(|| Ok(()))
    }
    pub fn read_guide_capture(&self) -> Result<GuideCaptureSnapshot, String> {
        self.read_guide_capture_after_capture(|| Ok(()))
    }
    pub(crate) fn read_guide_capture_after_capture(
        &self,
        after: impl FnOnce() -> Result<(), String>,
    ) -> Result<GuideCaptureSnapshot, String> {
        let _time = crate::storage_timings::measure(crate::storage_timings::Stage::Snapshot);
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let captured = Self::capture_pair(&tx)?;
        let revision: i64 = sql(tx.query_row(
            "SELECT catalog_revision FROM metadata WHERE singleton=1",
            [],
            |row| row.get(0),
        ))?;
        sql(tx.commit())?;
        after()?;
        if revision < 0 {
            return Err("storage-revision-invalid".into());
        }
        Ok(GuideCaptureSnapshot {
            pair: Self::finish_pair(captured)?,
            catalog_revision: revision.to_string(),
        })
    }
    pub(crate) fn read_snapshot_after_capture(
        &self,
        after: impl FnOnce() -> Result<(), String>,
    ) -> Result<RecordSnapshot, String> {
        let _time = crate::storage_timings::measure(crate::storage_timings::Stage::Snapshot);
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let captured_pair = Self::capture_pair(&tx)?;
        let captured_health = crate::health_storage::capture(&tx)?;
        let (cr, hr): (i64, i64) = sql(tx.query_row(
            "SELECT catalog_revision,health_revision FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        sql(tx.commit())?;
        // Only immutable captured data survives this point. Pure validation
        // keeps its root/work lease, but never holds a DELETE-mode read lock.
        after()?;
        let (pair, catalog) = Self::finish_pair_validated(captured_pair)?;
        let health = crate::health_storage::finish(captured_health)?;
        if crate::health_storage::reconcile(health.as_deref(), None, catalog.as_ref())? != health {
            return Err("health-stored-target-mismatch".into());
        }
        if cr < 0 || hr < 0 {
            return Err("storage-revision-invalid".into());
        }
        Ok(RecordSnapshot {
            pair,
            health,
            catalog_revision: cr.to_string(),
            health_revision: hr.to_string(),
        })
    }
    #[cfg(test)]
    pub fn write_guarded(
        &self,
        catalog: &str,
        preferences: &str,
        health: Option<&str>,
        expected: Option<&str>,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        // Compatibility helper only for pre-CAS storage fixtures. Production IPC
        // must supply both captured revisions and uses write_guarded_cas directly.
        let snapshot = self.read_snapshot()?;
        let expected_health = snapshot.health_revision;
        let expected_catalog = snapshot.catalog_revision;
        self.write_guarded_cas(
            catalog,
            preferences,
            health,
            (expected.or(Some(&expected_catalog)), Some(&expected_health)),
            check,
        )
    }
    #[cfg(test)]
    pub fn write_guarded_cas(
        &self,
        catalog: &str,
        preferences: &str,
        health: Option<&str>,
        expected: (Option<&str>, Option<&str>),
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        let p = RecordPair {
            catalog: Some(catalog.into()),
            preferences: Some(preferences.into()),
        };
        self.write_records_guarded(&p, health, expected.0, expected.1, None, check)
    }
    pub fn write_pair_with_scan(
        &self,
        pair: &RecordPair,
        health: Option<&str>,
        expected: (Option<&str>, Option<&str>),
        scan: Option<(&crate::scan_checkpoint::Mutation, &str)>,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.write_records_guarded(pair, health, expected.0, expected.1, scan, check)
    }
    pub(crate) fn mutate_catalog_group(
        &self,
        request: &crate::catalog_group_mutation::Request,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<CatalogGroupReceipt, String> {
        check()?;
        let mut connection = connect(&self.root.join(DB), false)?;
        self.backup_with_check(&connection, &mut check)?;
        check()?;
        let tx = sql(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let pending = crate::catalog_group_mutation::apply(&tx, request, &mut check)?;
        // Validate complete canonical catalog/preferences after all group edits.
        // Failure rolls back every member; no partial group acknowledgment.
        let _validated = Self::read_connection_validated(&tx)?;
        check()?;
        sql(tx.commit())?;
        // Never turn a crossed durable commit into a late cancellation error.
        Ok(CatalogGroupReceipt {
            schema_version: 1,
            committed: true,
            catalog_revision: pending.catalog_revision,
            view_revision: pending.view_revision,
            affected_count: pending.affected_count,
        })
    }
    pub(crate) fn read_scan_commit_revisions(
        &self,
    ) -> Result<crate::scan_batch::Revisions, String> {
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let (catalog_revision, health_revision): (i64, i64) = sql(tx.query_row(
            "SELECT catalog_revision,health_revision FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        sql(tx.commit())?;
        if catalog_revision < 0 || health_revision < 0 {
            return Err("storage-revision-invalid".into());
        }
        Ok(crate::scan_batch::Revisions {
            schema_version: 1,
            catalog_revision: catalog_revision.to_string(),
            health_revision: health_revision.to_string(),
        })
    }
    pub(crate) fn read_scan_checkpoint_summary(
        &self,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_checkpoint_summary::Summary, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let captured = crate::scan_checkpoint_summary::capture(&tx)?;
        sql(tx.commit())?;
        let summary = crate::scan_checkpoint_summary::finish(captured, &mut check)?;
        check()?;
        Ok(summary)
    }
    pub(crate) fn commit_scan_batch(
        &self,
        batch: &crate::scan_batch::Batch,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.commit_scan_batch_with_phase(batch, |_| check())
    }
    fn commit_scan_batch_with_phase(
        &self,
        batch: &crate::scan_batch::Batch,
        mut phase: impl FnMut(Phase) -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.commit_scan_batch_observed(batch, &mut phase, None)
    }
    fn commit_scan_batch_observed(
        &self,
        batch: &crate::scan_batch::Batch,
        phase: &mut impl FnMut(Phase) -> Result<(), String>,
        observer: Option<&mut dyn FnMut(PairCaptureStage)>,
    ) -> Result<CommitReceipt, String> {
        // Preserve the existing capture-only fixture seam. The value observer is
        // operation-local and can additionally prove which consumers reuse it.
        match observer {
            Some(observe) => self.commit_scan_batch_values_observed(
                batch,
                phase,
                Some(&mut |stage| {
                    if matches!(stage, PairCaptureStage::Before | PairCaptureStage::After) {
                        observe(stage);
                    }
                }),
            ),
            None => self.commit_scan_batch_values_observed(batch, phase, None),
        }
    }
    fn commit_scan_batch_values_observed(
        &self,
        batch: &crate::scan_batch::Batch,
        phase: &mut impl FnMut(Phase) -> Result<(), String>,
        mut observer: Option<&mut dyn FnMut(PairCaptureStage)>,
    ) -> Result<CommitReceipt, String> {
        phase(Phase::BeforeWork)?;
        let expected = crate::scan_batch::validate_envelope(batch)?;
        let health =
            serde_json::to_string(&json!({"schemaVersion":1,"records":batch.incoming_health}))
                .map_err(|_| "health-encoding-failed")?;
        crate::health_storage::parse(&health)?;
        let scan = batch
            .scan_checkpoint
            .as_ref()
            .zip(batch.expected_checkpoint_revision.as_deref())
            .map(|(mutation, revision)| {
                crate::scan_checkpoint::revision(revision).map(|r| (mutation, r, scan_now()))
            })
            .transpose()?;
        let mut c = connect(&self.root.join(DB), false)?;
        phase(Phase::BeforeBackup)?;
        self.backup_with_check(&c, || phase(Phase::DuringBackup))?;
        phase(Phase::AfterBackup)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let actual: (i64, i64) = sql(tx.query_row(
            "SELECT catalog_revision,health_revision FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        if actual.0 != expected.0 {
            return Err("catalog-revision-stale".into());
        }
        if actual.1 != expected.1 {
            return Err("health-revision-stale".into());
        }
        let old = Self::read_connection_validated(&tx)?;
        if let Some(observe) = observer.as_mut() {
            observe(PairCaptureStage::Before);
        }
        let empty_catalog = json!({"schemaVersion":1,"sources":[],"channels":[]});
        let old_catalog = old.catalog.as_ref().unwrap_or(&empty_catalog);
        if let Some(observe) = observer.as_mut() {
            observe(PairCaptureStage::BeforeCatalogReuse);
        }
        let catalog = crate::scan_batch::expand(batch, old_catalog, || phase(Phase::BeforeCommit))?;
        let pair = RecordPair {
            catalog: Some(serde_json::to_string(&catalog).map_err(|_| "record-encoding-failed")?),
            preferences: Some(
                serde_json::to_string(&batch.next_preferences)
                    .map_err(|_| "record-encoding-failed")?,
            ),
        };
        let validated = validate(&pair)?;
        // expand + canonical validation admitted every patch identity; collect
        // the entire bounded patch, never filter/truncate changed rows.
        let projection_ids = batch
            .catalog_patch
            .channels
            .iter()
            .map(|channel| {
                channel["id"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "scan-batch-invalid".to_string())
            })
            .collect::<Result<Vec<_>, String>>()?;
        let receipt = Self::apply_scan_transaction(
            &tx,
            &pair,
            Some(&health),
            (Some(expected.0), Some(expected.1)),
            scan,
            PairReuse {
                validated,
                before: Some(old),
                projection_ids: Some(vec![projection_ids]),
                health_groups: None,
                observer,
            },
            phase,
        )?;
        sql(tx.commit())?;
        // Durable publication wins over a cancellation arriving after COMMIT.
        let _ = phase(Phase::AfterCommit);
        Ok(receipt)
    }
    pub(crate) fn commit_scan_window(
        &self,
        window: &crate::scan_window::Window,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.commit_scan_window_observed(window, &mut |_| check(), None)
    }
    fn commit_scan_window_observed(
        &self,
        window: &crate::scan_window::Window,
        phase: &mut impl FnMut(Phase) -> Result<(), String>,
        observer: Option<&mut dyn FnMut(PairCaptureStage)>,
    ) -> Result<CommitReceipt, String> {
        self.commit_scan_window_with_page_limit(
            window,
            phase,
            observer,
            #[cfg(test)]
            None,
        )
    }
    fn commit_scan_window_with_page_limit(
        &self,
        window: &crate::scan_window::Window,
        phase: &mut impl FnMut(Phase) -> Result<(), String>,
        mut observer: Option<&mut dyn FnMut(PairCaptureStage)>,
        #[cfg(test)] max_page_count: Option<i64>,
    ) -> Result<CommitReceipt, String> {
        phase(Phase::BeforeWork)?;
        let expected = crate::scan_window::validate(window)?;
        let health_groups = window
            .chunks
            .iter()
            .map(|chunk| {
                let raw = serde_json::to_string(
                    &json!({"schemaVersion":1,"records":chunk.incoming_health}),
                )
                .map_err(|_| "health-encoding-failed")?;
                crate::health_storage::parse(&raw)?;
                Ok(raw)
            })
            .collect::<Result<Vec<String>, String>>()?;
        let scan = window
            .scan_checkpoint
            .as_ref()
            .zip(window.expected_checkpoint_revision.as_deref())
            .map(|(mutation, revision)| {
                crate::scan_checkpoint::revision(revision).map(|r| (mutation, r, scan_now()))
            })
            .transpose()?;
        let mut c = connect(&self.root.join(DB), false)?;
        #[cfg(test)]
        if let Some(maximum) = max_page_count {
            sql(c.pragma_update(None, "max_page_count", maximum))?;
        }
        phase(Phase::BeforeBackup)?;
        self.backup_with_check(&c, || phase(Phase::DuringBackup))?;
        phase(Phase::AfterBackup)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let actual: (i64, i64) = sql(tx.query_row(
            "SELECT catalog_revision,health_revision FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        if actual.0 != expected.0 {
            return Err("catalog-revision-stale".into());
        }
        if actual.1 != expected.1 {
            return Err("health-revision-stale".into());
        }
        let old = Self::read_connection_validated(&tx)?;
        if let Some(observe) = observer.as_mut() {
            observe(PairCaptureStage::Before);
        }
        let empty_catalog = json!({"schemaVersion":1,"sources":[],"channels":[]});
        let old_catalog = old.catalog.as_ref().unwrap_or(&empty_catalog);
        if let Some(observe) = observer.as_mut() {
            observe(PairCaptureStage::BeforeCatalogReuse);
        }
        let catalog =
            crate::scan_window::expand(window, old_catalog, || phase(Phase::BeforeCommit))?;
        let pair = RecordPair {
            catalog: Some(serde_json::to_string(&catalog).map_err(|_| "record-encoding-failed")?),
            preferences: Some(
                serde_json::to_string(&window.next_preferences)
                    .map_err(|_| "record-encoding-failed")?,
            ),
        };
        let validated = validate(&pair)?;
        let projection_ids = crate::scan_window::ids(window)?;
        let receipt = Self::apply_scan_transaction(
            &tx,
            &pair,
            None,
            (Some(expected.0), Some(expected.1)),
            scan,
            PairReuse {
                validated,
                before: Some(old),
                projection_ids: Some(projection_ids),
                health_groups: Some(&health_groups),
                observer,
            },
            phase,
        )?;
        sql(tx.commit())?;
        // Durable publication wins over a cancellation arriving after COMMIT.
        let _ = phase(Phase::AfterCommit);
        Ok(receipt)
    }
    pub fn read_scan_checkpoint(&self) -> Result<crate::scan_checkpoint::Snapshot, String> {
        self.read_checkpoint_after_capture(|| Ok(()))
    }
    fn manifest_context<T>(
        c: &Connection,
        action: impl FnOnce(&crate::scan_candidate_manifest::Context<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        // Only authority fields are needed per page: no channel/URL/health/checkpoint body read.
        let mut sources_stmt =
            sql(c.prepare("SELECT id,name,kind,location,allow_http,content_kind,media_mime FROM source ORDER BY ordinal LIMIT 101"))?;
        let sources=sql(sources_stmt.query_map([],|r|{
            let mut value=json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"location":r.get::<_,String>(3)?});
            if r.get::<_,bool>(4)?{value["allowHttp"]=json!(true);}
            if let Some(kind)=r.get::<_,Option<String>>(5)?{value["contentKind"]=json!(kind);}
            if let Some(mime)=r.get::<_,Option<String>>(6)?{value["mediaMime"]=json!(mime);}
            Ok(value)
        }))?.collect::<rusqlite::Result<Vec<_>>>();
        let sources = sql(sources)?;
        if sources.len() > 100 {
            return Err("scan-manifest-source-limit".into());
        }
        let catalog = json!({"schemaVersion":1,"sources":sources,"channels":[]});
        let (present,providers,region):(bool,Option<String>,Option<String>)=sql(c.query_row("SELECT metadata.preferences_present,preference.reviewed_channel_providers,preference.preferred_region FROM metadata JOIN preference ON preference.singleton=metadata.singleton WHERE metadata.singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))))?;
        if !present {
            return Err("scan-checkpoint-preferences-required".into());
        }
        let mut preferences = json!({});
        for (name, raw) in [
            ("reviewedChannelProviders", providers),
            ("preferredRegion", region),
        ] {
            if let Some(raw) = raw {
                if raw.len() > 2 * 1024 * 1024 {
                    return Err("scan-manifest-authority-limit".into());
                }
                // These columns contain an extension array/object, not a schemaVersion record.
                preferences[name] =
                    serde_json::from_str(&raw).map_err(|_| "record-invalid-json")?;
            }
        }
        preference_extensions::normalize(&mut preferences)?;
        let catalog_revision: i64 = sql(c.query_row(
            "SELECT catalog_revision FROM metadata WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        let exists: bool = sql(c.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_checkpoint')",
            [],
            |r| r.get(0),
        ))?;
        let checkpoint_revision = if exists {
            sql(c.query_row(
                "SELECT revision FROM scan_checkpoint WHERE singleton=1",
                [],
                |r| r.get::<_, i64>(0),
            ))?
        } else {
            0
        };
        action(&crate::scan_candidate_manifest::Context {
            preferences: &preferences,
            catalog: &catalog,
            catalog_revision,
            checkpoint_revision,
            now: scan_now(),
        })
    }
    pub(crate) fn begin_scan_candidate_manifest(
        &self,
        request: &crate::scan_candidate_manifest::Begin,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::Header, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), false)?;
        self.backup_with_check(&c, &mut check)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        // Initial semantic validation needs the full catalog once, including published targets.
        let pair = Self::read_connection(&tx)?;
        let full_catalog = pair
            .catalog
            .as_deref()
            .map(parse)
            .transpose()?
            .unwrap_or_else(|| json!({"schemaVersion":1,"sources":[],"channels":[]}));
        let result = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::begin(
                &tx,
                request,
                &crate::scan_candidate_manifest::Context {
                    catalog: &full_catalog,
                    ..*context
                },
                &mut check,
            )
        })?;
        check()?;
        sql(tx.commit())?;
        Ok(result)
    }
    pub(crate) fn prepare_scan_candidate_manifest_page(
        &self,
        request: crate::scan_candidate_manifest::Append,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::PreparedPage, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let result = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::prepare_page(&tx, request, context, &mut check)
        })?;
        sql(tx.commit())?;
        check()?;
        Ok(result)
    }
    pub(crate) fn append_scan_candidate_manifest_page(
        &self,
        prepared: &crate::scan_candidate_manifest::PreparedPage,
        ciphertext: &[u8],
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::Header, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), false)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let result = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::append_page(
                &tx, prepared, ciphertext, context, &mut check,
            )
        })?;
        check()?;
        sql(tx.commit())?;
        Ok(result)
    }
    pub(crate) fn prepare_scan_candidate_manifest_seal(
        &self,
        request: &crate::scan_candidate_manifest::Seal,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::origin_directory::PreparedCapsule, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let prepared = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::origin_directory::prepare_seal(
                &tx, request, context, &mut check,
            )
        })?;
        sql(tx.commit())?;
        check()?;
        Ok(prepared)
    }
    #[cfg(test)]
    pub(crate) fn seal_scan_candidate_manifest(
        &self,
        request: &crate::scan_candidate_manifest::Seal,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.seal_scan_candidate_manifest_inner(request, None, check)
    }
    pub(crate) fn seal_protected_scan_candidate_manifest(
        &self,
        request: &crate::scan_candidate_manifest::Seal,
        prepared: &crate::scan_candidate_manifest::origin_directory::PreparedCapsule,
        ciphertext: &[u8],
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.seal_scan_candidate_manifest_inner(request, Some((prepared, ciphertext)), check)
    }
    fn seal_scan_candidate_manifest_inner(
        &self,
        request: &crate::scan_candidate_manifest::Seal,
        protection: Option<(
            &crate::scan_candidate_manifest::origin_directory::PreparedCapsule,
            &[u8],
        )>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), false)?;
        self.backup_with_check(&c, &mut check)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let seed = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::seal_seed(&tx, request, context)
        })?;
        if let Some((prepared, ciphertext)) = protection {
            Self::manifest_context(&tx, |context| {
                crate::scan_candidate_manifest::origin_directory::finish_seal(
                    &tx, request, prepared, ciphertext, context, &mut check,
                )
            })?;
        }
        let mutation = crate::scan_checkpoint::Mutation::Save { checkpoint: seed };
        let expected = crate::scan_checkpoint::revision(&request.expected_catalog_revision)?;
        let scan_revision =
            crate::scan_checkpoint::revision(&request.expected_checkpoint_revision)?;
        let pair = RecordPair::default();
        let validated = validate(&pair)?;
        let receipt = Self::apply_scan_transaction(
            &tx,
            &pair,
            None,
            (Some(expected), None),
            Some((&mutation, scan_revision, scan_now())),
            PairReuse {
                validated,
                before: None,
                projection_ids: None,
                health_groups: None,
                observer: None,
            },
            &mut |_| check(),
        )?;
        crate::scan_candidate_manifest::seal(&tx, request)?;
        check()?;
        sql(tx.commit())?;
        Ok(receipt)
    }
    pub(crate) fn find_scan_candidate_manifest(
        &self,
        request: &crate::scan_candidate_manifest::Find,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::Found, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let result = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::find(&tx, request, context)
        })?;
        sql(tx.commit())?;
        check()?;
        Ok(result)
    }
    pub(crate) fn read_scan_candidate_manifest_page(
        &self,
        request: &crate::scan_candidate_manifest::Read,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::EncryptedPage, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let result = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::read_page(&tx, request, context)
        })?;
        sql(tx.commit())?;
        check()?;
        Ok(result)
    }
    pub(crate) fn finish_scan_candidate_manifest_page(
        &self,
        request: &crate::scan_candidate_manifest::Read,
        page: crate::scan_candidate_manifest::EncryptedPage,
        plaintext: Vec<u8>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::Page, String> {
        let mut plaintext = zeroize::Zeroizing::new(plaintext);
        check()?;
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::verify_read(&tx, request, context, &page)
        })?;
        sql(tx.commit())?;
        check()?;
        crate::scan_candidate_manifest::finish_page(page, std::mem::take(&mut *plaintext))
    }
    pub(crate) fn read_checkpoint_after_capture(
        &self,
        after: impl FnOnce() -> Result<(), String>,
    ) -> Result<crate::scan_checkpoint::Snapshot, String> {
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let revision: i64 = sql(tx.query_row(
            "SELECT catalog_revision FROM metadata WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        let captured = crate::scan_checkpoint::capture(&tx)?;
        let captured_pair = if captured.has_contents() {
            Some(Self::capture_pair(&tx)?)
        } else {
            None
        };
        sql(tx.commit())?;
        after()?;
        let mut snapshot = crate::scan_checkpoint::finish(captured, revision)?;
        if let Some(raw) = &snapshot.checkpoint {
            let pair = Self::finish_pair(captured_pair.ok_or("scan-checkpoint-invalid")?)?;
            let catalog = pair
                .catalog
                .as_deref()
                .map(parse)
                .transpose()?
                .unwrap_or_else(|| json!({"schemaVersion":1,"sources":[],"channels":[]}));
            let prefs = pair
                .preferences
                .as_deref()
                .map(parse)
                .transpose()?
                .unwrap_or_else(|| json!({}));
            if crate::scan_checkpoint::validate(raw, &prefs, &catalog, revision, scan_now())
                .is_err()
            {
                snapshot.checkpoint_status = "invalid";
                snapshot.checkpoint = None;
            }
        }
        Ok(snapshot)
    }
    pub fn write_health_guarded(
        &self,
        health: &str,
        expected: &str,
        expected_health: &str,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.write_records_guarded(
            &RecordPair {
                catalog: None,
                preferences: None,
            },
            Some(health),
            Some(expected),
            Some(expected_health),
            None,
            check,
        )
    }
    pub fn write_record_guarded(
        &self,
        name: &str,
        contents: &str,
        expected: Option<&str>,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        let p = match name {
            "catalog" => RecordPair {
                catalog: Some(contents.into()),
                preferences: None,
            },
            "preferences" => RecordPair {
                catalog: None,
                preferences: Some(contents.into()),
            },
            _ => return Err("invalid-record-name".into()),
        };
        self.write_records_guarded(&p, None, expected, None, None, check)
    }
    fn write_records_guarded(
        &self,
        p: &RecordPair,
        health: Option<&str>,
        expected: Option<&str>,
        expected_health: Option<&str>,
        scan: Option<(&crate::scan_checkpoint::Mutation, &str)>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.write_records_with_phase(p, health, (expected, expected_health), scan, |_| check())
    }
    pub(crate) fn write_records_with_phase(
        &self,
        p: &RecordPair,
        health: Option<&str>,
        expected: (Option<&str>, Option<&str>),
        scan: Option<(&crate::scan_checkpoint::Mutation, &str)>,
        mut phase: impl FnMut(Phase) -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        let (expected, expected_health) = expected;
        phase(Phase::BeforeWork)?;
        let (_, validated_preferences) = validate(p)?;
        if health.is_some() && expected.is_none() {
            return Err("catalog-revision-required".into());
        }
        let expected = expected
            .map(|value| {
                if value.is_empty()
                    || !value.bytes().all(|b| b.is_ascii_digit())
                    || (value.len() > 1 && value.starts_with('0'))
                {
                    return Err("catalog-revision-invalid".to_string());
                }
                value
                    .parse::<i64>()
                    .map_err(|_| "catalog-revision-invalid".to_string())
            })
            .transpose()?;
        if health.is_some() && expected_health.is_none() {
            return Err("health-revision-required".into());
        }
        let expected_health = expected_health
            .map(|value| {
                if value.is_empty()
                    || !value.bytes().all(|b| b.is_ascii_digit())
                    || (value.len() > 1 && value.starts_with('0'))
                {
                    return Err("health-revision-invalid".to_string());
                }
                value
                    .parse::<i64>()
                    .map_err(|_| "health-revision-invalid".to_string())
            })
            .transpose()?;
        if let Some(h) = health {
            crate::health_storage::parse(h)?;
        }
        if scan.is_some() && expected.is_none() {
            return Err("catalog-revision-required".into());
        }
        let scan = scan
            .map(|(m, r)| crate::scan_checkpoint::revision(r).map(|r| (m, r, scan_now())))
            .transpose()?;
        let mut c = connect(&self.root.join(DB), false)?;
        phase(Phase::BeforeBackup)?;
        if p.catalog.is_none() && health.is_none() && scan.is_none() {
            if let Some(preferences) = validated_preferences.as_ref() {
                if let Some(receipt) = Self::preferences_noop_preflight(
                    &mut c,
                    preferences,
                    (expected, expected_health),
                    &mut phase,
                )? {
                    return Ok(receipt);
                }
            }
        }
        self.backup_with_check(&c, || phase(Phase::DuringBackup))?;
        phase(Phase::AfterBackup)?;
        Self::apply_with_scan(
            &mut c,
            p,
            health,
            (expected, expected_health),
            scan,
            |stage| {
                if stage == Phase::AfterCommit {
                    Ok(())
                } else {
                    phase(stage)
                }
            },
        )
    }
    /// The Store's checked canonical writer remains held throughout this read
    /// preflight and any later backup/write. No speculative UPDATE or revision
    /// change is needed to recognize the exact canonical persisted preferences.
    fn preferences_noop_preflight(
        c: &mut Connection,
        preferences: &Value,
        expected: (Option<i64>, Option<i64>),
        phase: &mut impl FnMut(Phase) -> Result<(), String>,
    ) -> Result<Option<CommitReceipt>, String> {
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let version: i64 = sql(tx.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
        if version < 19 {
            return Ok(None);
        }
        let (overall, catalog, health): (i64, i64, i64) = sql(tx.query_row(
            "SELECT revision,catalog_revision,health_revision FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ))?;
        if [overall, catalog, health]
            .iter()
            .any(|r| *r < 0 || *r == i64::MAX)
        {
            return Err("storage-revision-exhausted".into());
        }
        if expected.0.is_some_and(|revision| revision != catalog) {
            return Err("catalog-revision-stale".into());
        }
        if expected.1.is_some_and(|revision| revision != health) {
            return Err("health-revision-stale".into());
        }
        let current = Self::read_connection_validated(&tx)?;
        // Match only documented SQL read/write normalization. Unknown fields
        // remain in the candidate and therefore cannot receive a no-op ACK.
        // Complete source arrays, ordering, extensions and explicit/absent
        // contentLibrary remain part of equality.
        let mut candidate = preferences.clone();
        for key in ["volume", "panelWidth"] {
            candidate[key] = json!(preferences[key]
                .as_f64()
                .ok_or("record-invalid-preferences")?);
        }
        let cadence = crate::refresh_cadence::from_preferences(preferences)?;
        candidate["sourceRefreshCadence"] = json!(cadence.as_str());
        candidate["automaticSourceRefresh"] =
            json!(cadence != crate::refresh_cadence::Cadence::Off);
        candidate["sourceRefreshAttemptAt"] = json!(preferences["sourceRefreshAttemptAt"]
            .as_f64()
            .unwrap_or(0.0) as i64);
        if candidate.get("removedChannels").is_none() {
            candidate["removedChannels"] = json!([]);
        }
        if candidate
            .get("channelCategoryOverrides")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        {
            candidate
                .as_object_mut()
                .ok_or("record-invalid-preferences")?
                .remove("channelCategoryOverrides");
        }
        for source in candidate["sources"]
            .as_array_mut()
            .ok_or("record-invalid-preferences")?
        {
            if source.get("allowHttp").and_then(Value::as_bool) == Some(false) {
                source
                    .as_object_mut()
                    .ok_or("record-invalid-preferences")?
                    .remove("allowHttp");
            }
        }
        if current.preferences.as_ref() != Some(&candidate) {
            return Ok(None);
        }
        phase(Phase::BeforeCommit)?;
        sql(tx.commit())?;
        Ok(Some(CommitReceipt {
            committed: true,
            catalog_revision: catalog.to_string(),
            health_revision: health.to_string(),
            checkpoint_revision: None,
        }))
    }
    pub fn read_pair(&self) -> Result<RecordPair, String> {
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let captured = Self::capture_pair(&tx)?;
        sql(tx.commit())?;
        Self::finish_pair(captured)
    }
    fn read_connection(c: &Connection) -> Result<RecordPair, String> {
        Self::read_connection_validated(c).map(|snapshot| snapshot.pair)
    }
    fn read_connection_validated(c: &Connection) -> Result<ValidatedPair, String> {
        Self::finish_pair_canonical(Self::capture_pair(c)?)
    }
    /// One indexed walk replaces a separate SQLite URL query for every channel.
    /// The bounds are necessary subsets of the unchanged canonical validator:
    /// 100k channels, 16 URLs each, 16KiB fields and 20MiB whole catalog.
    fn capture_channel_urls(c: &Connection) -> Result<HashMap<String, Vec<String>>, String> {
        const MAX_CHANNELS: usize = 100_000;
        const URLS_PER_CHANNEL: usize = 16;
        const MAX_ROWS: usize = MAX_CHANNELS * URLS_PER_CHANNEL;
        let mut statement = sql(c.prepare(
            "SELECT CASE WHEN length(CAST(channel_id AS BLOB)) BETWEEN 1 AND 16384 THEN channel_id ELSE NULL END,
                    CASE WHEN length(CAST(url AS BLOB))<=16384 THEN url ELSE NULL END
             FROM channel_url ORDER BY channel_id,ordinal LIMIT ?1",
        ))?;
        let rows = sql(statement.query_map([(MAX_ROWS + 1) as i64], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        }))?;
        let mut groups: HashMap<String, Vec<String>> = HashMap::new();
        let mut bytes = 0usize;
        for (index, row) in rows.enumerate() {
            if index == MAX_ROWS {
                return Err("record-array-too-large".into());
            }
            let (id, url) = sql(row)?;
            let id = id.ok_or("record-invalid-field")?;
            let url = url.ok_or("record-invalid-url")?;
            if !groups.contains_key(&id) {
                if groups.len() == MAX_CHANNELS {
                    return Err("record-array-too-large".into());
                }
                // Count IDs once, as canonical JSON does; counting them once
                // per URL would incorrectly reject legitimate long identities.
                bytes += id.len();
            }
            bytes += url.len();
            if bytes as u64 > LIMIT {
                return Err("record-too-large".into());
            }
            let urls = groups.entry(id).or_default();
            if urls.len() == URLS_PER_CHANNEL {
                return Err("record-array-too-large".into());
            }
            urls.push(url);
        }
        Ok(groups)
    }
    fn capture_pair(c: &Connection) -> Result<CapturedPair, String> {
        let mut extensions = [None, None, None];
        let (cp, pp): (bool, bool) = sql(c.query_row(
            "SELECT catalog_present,preferences_present FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        let mut source_stmt =
            sql(c.prepare("SELECT id,name,location,kind,allow_http,content_kind,media_mime FROM source ORDER BY ordinal"))?;
        let sources = sql(source_stmt.query_map([], |r| {
            let id: String = r.get(0)?;
            let name: String = r.get(1)?;
            let location: String = r.get(2)?;
            let kind: String = r.get(3)?;
            let mut v = json!({ "id": id, "name": name, "location": location, "kind": kind });
            let http: bool = r.get(4)?;
            if http {
                v["allowHttp"] = json!(true);
            }
            if let Some(kind) = r.get::<_, Option<String>>(5)? {
                v["contentKind"] = json!(kind);
            }
            if let Some(mime) = r.get::<_, Option<String>>(6)? {
                v["mediaMime"] = json!(mime);
            }
            Ok(v)
        }))?
        .collect::<rusqlite::Result<Vec<_>>>();
        let sources = sql(sources)?;
        let catalog = if cp {
            let mut stmt = sql(c.prepare(
                "SELECT id,source_id,provider_id,name,category,country,region,state,geography_provenance FROM channel ORDER BY ordinal",
            ))?;
            let rows = sql(stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<String>>(8)?,
                ))
            }))?;
            let mut channels = Vec::new();
            let mut urls_by_channel = Self::capture_channel_urls(c)?;
            for row in rows {
                let (id, sid, pid, name, category, country, region, state, provenance) = sql(row)?;
                let urls = urls_by_channel.remove(&id).unwrap_or_default();
                let mut ch =
                    json!({"id":id,"sourceId":sid,"name":name,"category":category,"urls":urls});
                if let Some(pid) = pid {
                    ch["providerId"] = json!(pid);
                }
                let mut g = serde_json::Map::new();
                for (key, value) in [("country", country), ("region", region), ("state", state)] {
                    if let Some(value) = value {
                        g.insert(key.into(), json!(value));
                    }
                }
                if !g.is_empty() {
                    ch["geography"] = Value::Object(g);
                }
                if let Some(value) = provenance {
                    ch["geographyProvenance"] = json!(value);
                }
                channels.push(ch);
            }
            if !urls_by_channel.is_empty() {
                return Err("record-orphaned-channel-url".into());
            }
            Some(json!({"schemaVersion":1,"sources":sources,"channels":channels}))
        } else {
            None
        };
        let preferences = if pp {
            let ids = |table: &str| -> Result<Vec<String>, String> {
                let mut s = sql(c.prepare(&format!("SELECT id FROM {table} ORDER BY ordinal")))?;
                let a =
                    sql(s.query_map([], |r| r.get(0)))?.collect::<rusqlite::Result<Vec<String>>>();
                sql(a)
            };
            let (volume, muted, width): (f64, bool, f64) = sql(c.query_row(
                "SELECT volume,muted,panel_width FROM preference WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            ))?;
            let (automatic, attempt): (bool, i64) = if sql(c.query_row(
                "PRAGMA user_version",
                [],
                |r| r.get::<_, i64>(0),
            ))? >= 6
            {
                sql(c.query_row(
                    "SELECT auto_source_refresh,source_refresh_attempt_at FROM preference WHERE singleton=1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                ))?
            } else {
                (false, 0)
            };
            let mut pref = json!({"schemaVersion":1,"favorites":ids("favorite")?,"removedChannels":ids("removed")?,"volume":volume,"muted":muted,"panelWidth":width,"sources":sources,"automaticSourceRefresh":automatic,"sourceRefreshAttemptAt":attempt});
            if sql(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 8 {
                let cadence: String = sql(c.query_row(
                    "SELECT source_refresh_cadence FROM preference WHERE singleton=1",
                    [],
                    |r| r.get(0),
                ))?;
                // Store raw cadence; parse only after the read transaction ends.
                pref["sourceRefreshCadence"] = json!(cadence);
            }
            if sql(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 7 {
                let stored_extensions: (Option<String>, Option<String>, Option<String>) = sql(c.query_row(
                    "SELECT reviewed_channel_providers,reviewed_guide_providers,preferred_region FROM preference WHERE singleton=1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                ))?;
                extensions = [
                    stored_extensions.0,
                    stored_extensions.1,
                    stored_extensions.2,
                ];
                let consent: Option<bool> = sql(c.query_row(
                    "SELECT voice_search_consent FROM preference WHERE singleton=1",
                    [],
                    |r| r.get(0),
                ))?;
                if let Some(consent) = consent {
                    pref["voiceSearchConsent"] = json!(consent);
                }
            }
            if sql(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 10 {
                let overrides = channel_categories::capture(c)?;
                if !overrides.is_empty() {
                    pref["channelCategoryOverrides"] = json!(overrides);
                }
            }
            if sql(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 11 {
                let enabled: Option<bool> = sql(c.query_row(
                    "SELECT automatic_guide_updates FROM metadata WHERE singleton=1",
                    [],
                    |r| r.get(0),
                ))?;
                if let Some(enabled) = enabled {
                    pref["automaticGuideUpdates"] = json!(enabled);
                }
            }
            if sql(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 19 {
                let library: Option<String> = sql(c.query_row(
                    "SELECT content_library FROM preference WHERE singleton=1",
                    [],
                    |r| r.get(0),
                ))?;
                if let Some(library) = library {
                    pref["contentLibrary"] = json!(library);
                }
            }
            Some(pref)
        } else {
            None
        };
        Ok(CapturedPair {
            catalog,
            preferences,
            extensions,
        })
    }
    fn finish_pair(captured: CapturedPair) -> Result<RecordPair, String> {
        Self::finish_pair_validated(captured).map(|(pair, _)| pair)
    }
    fn finish_pair_validated(
        captured: CapturedPair,
    ) -> Result<(RecordPair, Option<Value>), String> {
        let snapshot = Self::finish_pair_canonical(captured)?;
        Ok((snapshot.pair, snapshot.catalog))
    }
    fn finish_pair_canonical(mut captured: CapturedPair) -> Result<ValidatedPair, String> {
        if let Some(catalog) = captured.catalog.as_mut() {
            for channel in catalog["channels"]
                .as_array_mut()
                .ok_or("catalog-invalid-channels")?
            {
                if let Some(raw) = channel.get("geographyProvenance").and_then(Value::as_str) {
                    channel["geographyProvenance"] =
                        serde_json::from_str(raw).map_err(|_| "sqlite-invalid-geography")?;
                }
                geography(channel)?;
            }
        }
        if let Some(pref) = captured.preferences.as_mut() {
            for (key, raw) in [
                "reviewedChannelProviders",
                "reviewedGuideProviders",
                "preferredRegion",
            ]
            .into_iter()
            .zip(captured.extensions)
            {
                if let Some(raw) = raw {
                    if raw.len() as u64 > LIMIT {
                        return Err("record-too-large".into());
                    }
                    pref[key] = serde_json::from_str(&raw).map_err(|_| "record-invalid-json")?;
                }
            }
            if let Some(raw) = pref.get("sourceRefreshCadence").and_then(Value::as_str) {
                let parsed = crate::refresh_cadence::Cadence::parse(raw)?;
                pref["sourceRefreshCadence"] = json!(parsed.as_str());
                pref["automaticSourceRefresh"] =
                    json!(parsed != crate::refresh_cadence::Cadence::Off);
            }
            preference_extensions::normalize(pref)?;
        }
        let encode = |v: Option<Value>| {
            v.map(|v| serde_json::to_string(&v).map_err(|_| "record-encoding-failed".to_string()))
                .transpose()
        };
        let result = RecordPair {
            catalog: encode(captured.catalog)?,
            preferences: encode(captured.preferences)?,
        };
        // Validation already parses the exact encoded canonical catalog. Snapshot
        // reads reuse that value for health targets instead of parsing it again.
        let (catalog, preferences) = validate(&result)?;
        Ok(ValidatedPair {
            pair: result,
            catalog,
            preferences,
        })
    }
    pub fn read(&self, name: &str) -> Result<Option<String>, String> {
        let p = self.read_pair()?;
        match name {
            "catalog" => Ok(p.catalog),
            "preferences" => Ok(p.preferences),
            _ => Err("invalid-record-name".into()),
        }
    }
    #[cfg(test)]
    pub fn write(&self, name: &str, contents: &str) -> Result<(), String> {
        let p = match name {
            "catalog" => RecordPair {
                catalog: Some(contents.into()),
                preferences: None,
            },
            "preferences" => RecordPair {
                catalog: None,
                preferences: Some(contents.into()),
            },
            _ => return Err("invalid-record-name".into()),
        };
        self.commit(&p, |_| Ok(()))
    }
    #[cfg(test)]
    pub fn write_pair(&self, catalog: &str, preferences: &str) -> Result<(), String> {
        self.commit(
            &RecordPair {
                catalog: Some(catalog.into()),
                preferences: Some(preferences.into()),
            },
            |_| Ok(()),
        )
    }
    #[cfg(test)]
    fn commit<F: FnMut(Phase) -> Result<(), String>>(
        &self,
        p: &RecordPair,
        checkpoint: F,
    ) -> Result<(), String> {
        validate(p)?;
        let mut c = connect(&self.root.join(DB), false)?;
        self.backup(&c)?;
        Self::apply(&mut c, p, checkpoint)
    }
    fn apply<F: FnMut(Phase) -> Result<(), String>>(
        c: &mut Connection,
        p: &RecordPair,
        checkpoint: F,
    ) -> Result<(), String> {
        Self::apply_guarded(c, p, None, None, checkpoint).map(|_| ())
    }
    fn apply_guarded<F: FnMut(Phase) -> Result<(), String>>(
        c: &mut Connection,
        p: &RecordPair,
        health: Option<&str>,
        expected: Option<i64>,
        checkpoint: F,
    ) -> Result<CommitReceipt, String> {
        Self::apply_guarded_cas(c, p, health, expected, None, checkpoint)
    }
    fn apply_guarded_cas<F: FnMut(Phase) -> Result<(), String>>(
        c: &mut Connection,
        p: &RecordPair,
        health: Option<&str>,
        expected: Option<i64>,
        expected_health: Option<i64>,
        checkpoint: F,
    ) -> Result<CommitReceipt, String> {
        Self::apply_with_scan(c, p, health, (expected, expected_health), None, checkpoint)
    }
    fn apply_with_scan<F: FnMut(Phase) -> Result<(), String>>(
        c: &mut Connection,
        p: &RecordPair,
        health: Option<&str>,
        expected: (Option<i64>, Option<i64>),
        scan: Option<(&crate::scan_checkpoint::Mutation, i64, u64)>,
        mut checkpoint: F,
    ) -> Result<CommitReceipt, String> {
        let validated = validate(p)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let receipt = Self::apply_scan_transaction(
            &tx,
            p,
            health,
            expected,
            scan,
            PairReuse {
                validated,
                before: None,
                projection_ids: None,
                health_groups: None,
                observer: None,
            },
            &mut checkpoint,
        )?;
        sql(tx.commit())?;
        checkpoint(Phase::AfterCommit)?;
        Ok(receipt)
    }
    fn apply_scan_transaction<F: FnMut(Phase) -> Result<(), String>>(
        tx: &rusqlite::Transaction<'_>,
        p: &RecordPair,
        health: Option<&str>,
        expected: (Option<i64>, Option<i64>),
        scan: Option<(&crate::scan_checkpoint::Mutation, i64, u64)>,
        reuse: PairReuse<'_, '_>,
        checkpoint: &mut F,
    ) -> Result<CommitReceipt, String> {
        let PairReuse {
            validated,
            before,
            projection_ids,
            health_groups,
            mut observer,
        } = reuse;
        let (expected, expected_health) = expected;
        let (catalog, prefs) = validated;
        let modern_health =
            sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 5;
        let indexed = sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 9;
        let user_categories =
            sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 10;
        let old_categories = if user_categories {
            Some(channel_categories::semantic(tx)?)
        } else {
            None
        };
        let preference_identities = |c: &Connection| -> Result<Vec<Vec<String>>, String> {
            ["favorite", "removed"]
                .into_iter()
                .map(|table| {
                    let mut statement =
                        sql(c.prepare(&format!("SELECT id FROM {table} ORDER BY id")))?;
                    let ids = sql(statement.query_map([], |r| r.get::<_, String>(0)))?;
                    sql(ids.collect())
                })
                .collect()
        };
        let old_identities = if indexed {
            Some(preference_identities(tx)?)
        } else {
            None
        };
        let mut before = if modern_health {
            match before {
                Some(snapshot) => Some(snapshot),
                None => {
                    let snapshot = Self::read_connection_validated(tx)?;
                    if let Some(observe) = observer.as_mut() {
                        observe(PairCaptureStage::Before);
                    }
                    Some(snapshot)
                }
            }
        } else {
            None
        };
        let old_health = if modern_health {
            crate::health_storage::read(tx)?
        } else {
            None
        };
        let revision = if modern_health {
            sql(tx.query_row(
                "SELECT catalog_revision FROM metadata WHERE singleton=1",
                [],
                |r| r.get::<_, i64>(0),
            ))?
        } else {
            0
        };
        let (overall, hr): (i64, i64) = if modern_health {
            sql(tx.query_row(
                "SELECT revision,health_revision FROM metadata WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ))?
        } else {
            (0, 0)
        };
        if revision < 0 || hr < 0 || overall < 0 || [revision, hr, overall].contains(&i64::MAX) {
            return Err("storage-revision-exhausted".into());
        }
        if expected.is_some_and(|r| r != revision) {
            return Err("catalog-revision-stale".into());
        }
        if expected_health.is_some_and(|r| r != hr) {
            return Err("health-revision-stale".into());
        }
        if let Some(cat) = catalog {
            if modern_health {
                let previous = before
                    .as_ref()
                    .and_then(|snapshot| snapshot.catalog.as_ref());
                if let Some(observe) = observer.as_mut() {
                    observe(PairCaptureStage::BeforeDeltaReuse);
                }
                if let Some(groups) = projection_ids.as_deref() {
                    if groups.len() == 1 {
                        catalog_delta::apply_compact(tx, previous, &cat, &groups[0])?;
                    } else {
                        catalog_delta::apply_groups(tx, previous, &cat, groups)?;
                    }
                } else {
                    catalog_delta::apply(tx, previous, &cat)?;
                }
            } else {
                sql(tx.execute_batch(
                    "DELETE FROM channel_url;DELETE FROM channel;DELETE FROM source;",
                ))?;
                Self::insert_sources(tx, array(&cat, "sources", 100)?)?;
                let modern =
                    sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 3;
                let mut cs = sql(tx.prepare(if modern {
                    "INSERT INTO channel VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"
                } else {
                    "INSERT INTO channel VALUES(?1,?2,?3,?4,?5,?6)"
                }))?;
                let mut us = sql(tx.prepare("INSERT INTO channel_url VALUES(?1,?2,?3)"))?;
                for (i, ch) in array(&cat, "channels", 100000)?.iter().enumerate() {
                    let mut fields: Vec<rusqlite::types::Value> = vec![
                        ch["id"].as_str().unwrap().to_owned().into(),
                        ch["sourceId"].as_str().unwrap().to_owned().into(),
                        ch["providerId"]
                            .as_str()
                            .map(|v| v.to_owned().into())
                            .unwrap_or(rusqlite::types::Value::Null),
                        ch["name"].as_str().unwrap().to_owned().into(),
                        ch["category"].as_str().unwrap().to_owned().into(),
                        (i as i64).into(),
                    ];
                    if modern {
                        for key in ["country", "region", "state"] {
                            fields.push(
                                ch["geography"][key]
                                    .as_str()
                                    .map(|v| v.to_owned().into())
                                    .unwrap_or(rusqlite::types::Value::Null),
                            );
                        }
                        fields.push(
                            ch.get("geographyProvenance")
                                .map(|p| serde_json::to_string(p).map(rusqlite::types::Value::Text))
                                .transpose()
                                .map_err(|_| "record-encoding-failed")?
                                .unwrap_or(rusqlite::types::Value::Null),
                        );
                    }
                    sql(cs.execute(rusqlite::params_from_iter(fields)))?;
                    for (j, u) in ch["urls"]
                        .as_array()
                        .ok_or("record-invalid-url")?
                        .iter()
                        .enumerate()
                    {
                        sql(us.execute(params![ch["id"].as_str(), j as i64, u.as_str()]))?;
                    }
                }
            }
            sql(tx.execute(
                "UPDATE metadata SET catalog_present=1 WHERE singleton=1",
                [],
            ))?;
        }
        checkpoint(Phase::AfterCatalog)?;
        if let Some(pref) = prefs {
            let cp: bool = sql(tx.query_row(
                "SELECT catalog_present FROM metadata WHERE singleton=1",
                [],
                |r| r.get(0),
            ))?;
            if !cp {
                sql(tx.execute("DELETE FROM source", []))?;
                Self::insert_sources(tx, array(&pref, "sources", 100)?)?;
            }
            sql(tx.execute_batch(
                "DELETE FROM favorite;DELETE FROM removed;DELETE FROM preference;",
            ))?;
            for (table, key) in [("favorite", "favorites"), ("removed", "removedChannels")] {
                if let Some(a) = pref[key].as_array() {
                    let mut stmt = sql(tx.prepare(&format!("INSERT INTO {table} VALUES(?1,?2)")))?;
                    for (i, id) in a.iter().enumerate() {
                        sql(stmt.execute(params![id.as_str(), i as i64]))?;
                    }
                }
            }
            sql(tx.execute(
                "INSERT INTO preference(singleton,volume,muted,panel_width) VALUES(1,?1,?2,?3)",
                params![
                    pref["volume"].as_f64(),
                    pref["muted"].as_bool(),
                    pref["panelWidth"].as_f64()
                ],
            ))?;
            if sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 6 {
                sql(tx.execute(
                    "UPDATE preference SET auto_source_refresh=?1,source_refresh_attempt_at=?2 WHERE singleton=1",
                    params![
                        crate::refresh_cadence::from_preferences(&pref)? != crate::refresh_cadence::Cadence::Off,
                        pref["sourceRefreshAttemptAt"].as_f64().unwrap_or(0.0) as i64
                    ],
                ))?;
            }
            if sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 8 {
                sql(tx.execute(
                    "UPDATE preference SET source_refresh_cadence=?1 WHERE singleton=1",
                    params![crate::refresh_cadence::from_preferences(&pref)?.as_str()],
                ))?;
            }
            if sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 7 {
                let json_field = |key: &str| -> Result<Option<String>, String> {
                    pref.get(key)
                        .map(serde_json::to_string)
                        .transpose()
                        .map_err(|_| "record-encoding-failed".into())
                };
                sql(tx.execute(
                    "UPDATE preference SET reviewed_channel_providers=?1,reviewed_guide_providers=?2,preferred_region=?3 WHERE singleton=1",
                    params![
                        json_field("reviewedChannelProviders")?,
                        json_field("reviewedGuideProviders")?,
                        json_field("preferredRegion")?
                    ],
                ))?;
                sql(tx.execute(
                    "UPDATE preference SET voice_search_consent=?1 WHERE singleton=1",
                    params![pref.get("voiceSearchConsent").and_then(Value::as_bool)],
                ))?;
            }
            if sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 11 {
                sql(tx.execute(
                    "UPDATE metadata SET automatic_guide_updates=?1 WHERE singleton=1",
                    params![pref.get("automaticGuideUpdates").and_then(Value::as_bool)],
                ))?;
            } else if pref.get("automaticGuideUpdates").is_some() {
                return Err("sqlite-unsupported-automatic-guide-updates".into());
            }
            if sql(tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))? >= 19 {
                sql(tx.execute(
                    "UPDATE preference SET content_library=?1 WHERE singleton=1",
                    params![pref.get("contentLibrary").and_then(Value::as_str)],
                ))?;
            } else if pref.get("contentLibrary").is_some() {
                return Err("sqlite-unsupported-content-library".into());
            }
            if user_categories {
                channel_categories::replace(tx, pref.get("channelCategoryOverrides"))?;
            } else if pref.get("channelCategoryOverrides").is_some() {
                return Err("sqlite-unsupported-category-overrides".into());
            }
            sql(tx.execute(
                "UPDATE metadata SET preferences_present=1 WHERE singleton=1",
                [],
            ))?;
        }
        // The delta has consumed the prior trees; only the canonical text is still
        // compared. Freeing them lowers the peak while the after snapshot is read.
        if let Some(snapshot) = before.as_mut() {
            snapshot.catalog = None;
            snapshot.preferences = None;
        }
        // Keep SQL's exact canonical strings as authority. Health and checkpoint
        // processing share this snapshot; neither changes canonical pair rows.
        let mut after = if modern_health || scan.is_some() {
            let snapshot = Self::read_connection_validated(tx)?;
            if let Some(observe) = observer.as_mut() {
                observe(PairCaptureStage::After);
            }
            Some(snapshot)
        } else {
            None
        };
        if modern_health {
            let new_catalog = after
                .as_ref()
                .and_then(|snapshot| snapshot.pair.catalog.as_ref());
            let parsed_catalog = after
                .as_ref()
                .and_then(|snapshot| snapshot.catalog.as_ref());
            if let Some(observe) = observer.as_mut() {
                observe(PairCaptureStage::AfterHealthReuse);
            }
            let retained = if let Some(groups) = health_groups {
                crate::health_storage::reconcile_groups(
                    old_health.as_deref(),
                    &groups.iter().map(String::as_str).collect::<Vec<_>>(),
                    parsed_catalog,
                )?
            } else {
                crate::health_storage::reconcile(old_health.as_deref(), health, parsed_catalog)?
            };
            let old_catalog = before
                .as_ref()
                .and_then(|snapshot| snapshot.pair.catalog.as_ref());
            let catalog_changed = old_catalog != new_catalog;
            drop(before);
            // The checkpoint below needs only the parsed trees.
            if let Some(snapshot) = after.as_mut() {
                snapshot.pair = RecordPair::default();
            }
            let health_changed = old_health != retained;
            if catalog_changed && revision == i64::MAX {
                return Err("catalog-revision-exhausted".into());
            }
            crate::health_storage::replace(tx, retained.as_deref())?;
            if indexed {
                // Incrementally reconcile projection rows within this canonical transaction.
                let categories_changed = if user_categories {
                    old_categories.as_ref() != Some(&channel_categories::semantic(tx)?)
                } else {
                    false
                };
                if p.catalog.is_some() || categories_changed {
                    if !categories_changed {
                        if let Some(groups) = projection_ids.as_deref() {
                            for ids in groups {
                                crate::catalog_query::reconcile_projection(tx, ids)?;
                            }
                        } else {
                            crate::catalog_query::rebuild_projection(tx)?;
                        }
                    } else {
                        crate::catalog_query::rebuild_projection(tx)?;
                    }
                }
                let identity_changed = old_identities.as_ref() != Some(&preference_identities(tx)?);
                crate::catalog_query::advance_view_revision(
                    tx,
                    catalog_changed || identity_changed || categories_changed,
                )?;
            }
            sql(tx.execute(
                "UPDATE metadata SET catalog_revision=catalog_revision+?1,health_revision=health_revision+?2 WHERE singleton=1",
                params![catalog_changed, health_changed],
            ))?;
        }
        if p.catalog.is_some() || p.preferences.is_some() {
            sql(tx.execute(
                "UPDATE metadata SET revision=revision+1 WHERE singleton=1",
                [],
            ))?;
        }
        let (cr, hr) = if modern_health {
            sql(tx.query_row(
                "SELECT catalog_revision,health_revision FROM metadata WHERE singleton=1",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            ))?
        } else {
            (0, 0)
        };
        let checkpoint_revision = if let Some((mutation, expected_scan, now)) = scan {
            let current_pair = after
                .as_ref()
                .ok_or("scan-checkpoint-preferences-required")?;
            let empty_catalog = json!({"schemaVersion":1,"sources":[],"channels":[]});
            let catalog_value = current_pair.catalog.as_ref().unwrap_or(&empty_catalog);
            let preferences_value = current_pair
                .preferences
                .as_ref()
                .ok_or("scan-checkpoint-preferences-required")?;
            if let Some(observe) = observer.as_mut() {
                observe(PairCaptureStage::AfterCheckpointReuse);
            }
            Some(crate::scan_checkpoint::apply(
                tx,
                mutation,
                expected_scan,
                preferences_value,
                catalog_value,
                (revision, cr, now),
                || checkpoint(Phase::BeforeCommit),
            )?)
        } else {
            None
        };
        checkpoint(Phase::BeforeCommit)?;
        Ok(CommitReceipt {
            committed: true,
            catalog_revision: cr.to_string(),
            health_revision: hr.to_string(),
            checkpoint_revision,
        })
    }
    fn insert_sources(c: &Connection, sources: &[Value]) -> Result<(), String> {
        let mut s = sql(c.prepare("INSERT INTO source VALUES(?1,?2,?3,?4,?5,?6,?7,?8)"))?;
        for (i, v) in sources.iter().enumerate() {
            sql(s.execute(params![
                v["id"].as_str(),
                v["name"].as_str(),
                v["location"].as_str(),
                v["kind"].as_str(),
                v["allowHttp"].as_bool().unwrap_or(false),
                v["contentKind"].as_str(),
                v["mediaMime"].as_str(),
                i as i64
            ]))?;
        }
        Ok(())
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
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn guide_capture_wire_contains_only_pair_and_atomic_catalog_revision() {
        let root = tempfile::tempdir().unwrap();
        let store = PairStore::new(root.path().into()).unwrap();
        let original = pair(2);
        store
            .write_pair(
                original.catalog.as_ref().unwrap(),
                original.preferences.as_ref().unwrap(),
            )
            .unwrap();
        let full = store.read_snapshot().unwrap();
        let narrow = store.read_guide_capture().unwrap();
        assert_eq!(narrow.pair, full.pair);
        assert_eq!(narrow.catalog_revision, full.catalog_revision);
        let wire = serde_json::to_value(narrow).unwrap();
        assert_eq!(wire.as_object().unwrap().len(), 3);
        assert!(wire.get("health").is_none());
        assert!(wire.get("checkpoint").is_none());
    }
    #[test]
    fn guide_capture_releases_sqlite_read_lock_before_pair_validation_and_keeps_old_revision() {
        let root = tempfile::tempdir().unwrap();
        let store = PairStore::new(root.path().into()).unwrap();
        let old = pair(2);
        let new = pair(3);
        store
            .write_pair(
                old.catalog.as_ref().unwrap(),
                old.preferences.as_ref().unwrap(),
            )
            .unwrap();
        let old_revision = store.read_snapshot().unwrap().catalog_revision;
        let captured = store
            .read_guide_capture_after_capture(|| {
                store.write_pair(
                    new.catalog.as_ref().unwrap(),
                    new.preferences.as_ref().unwrap(),
                )
            })
            .unwrap();
        assert_eq!(canonical(&captured.pair), canonical(&old));
        assert_eq!(captured.catalog_revision, old_revision);
        assert_ne!(
            store.read_guide_capture().unwrap().catalog_revision,
            old_revision
        );
    }
    #[test]
    fn guide_capture_refuses_corrupt_pair_without_mutating_database() {
        let root = tempfile::tempdir().unwrap();
        let store = PairStore::new(root.path().into()).unwrap();
        let original = pair(2);
        store
            .write_pair(
                original.catalog.as_ref().unwrap(),
                original.preferences.as_ref().unwrap(),
            )
            .unwrap();
        let connection = connect(&root.path().join(DB), false).unwrap();
        connection
            .execute_batch("PRAGMA ignore_check_constraints=ON")
            .unwrap();
        connection
            .execute("UPDATE preference SET volume=2", [])
            .unwrap();
        drop(connection);
        let before = fs::read(root.path().join(DB)).unwrap();
        assert!(store.read_guide_capture().is_err());
        assert_eq!(fs::read(root.path().join(DB)).unwrap(), before);
    }
    #[test]
    fn scan_health_projection_keeps_captured_revisions_without_catalog_json_in_ipc() {
        let snapshot = RecordSnapshot {
            pair: RecordPair {
                catalog: Some("large-catalog-data".repeat(100_000)),
                preferences: Some("private-preferences".into()),
            },
            health: Some("{\"schemaVersion\":1,\"records\":[]}".into()),
            catalog_revision: "17".into(),
            health_revision: "9".into(),
        };
        let projected = ScanHealthSnapshot::from(snapshot);
        let wire = serde_json::to_value(projected).unwrap();
        assert_eq!(wire.as_object().unwrap().len(), 3);
        assert_eq!(wire["catalogRevision"], "17");
        assert_eq!(wire["healthRevision"], "9");
        assert!(wire.get("catalog").is_none());
        assert!(wire.get("preferences").is_none());
        assert!(wire["health"].as_str().unwrap().contains("records"));
    }
    pub(super) fn catalog_query() -> crate::catalog_query::Query {
        crate::catalog_query::Query {
            schema_version: 1,
            request_id: "catalog-fixture".into(),
            expected_catalog_revision: None,
            expected_view_revision: None,
            query: String::new(),
            filter: crate::catalog_query::Filter::All,
            geography: serde_json::Map::new(),
            sort: crate::catalog_query::Sort::Source,
            favorites_first: false,
            hide_adult: false,
            after: None,
            start_index: None,
            anchor_id: None,
            page_size: 50,
        }
    }
    #[test]
    fn catalog_v8_migration_preserves_canonical_backup_and_installs_actual_read_path() {
        let root = tempfile::tempdir().unwrap();
        let original = pair(4);
        let store = PairStore::new(root.path().into()).unwrap();
        store
            .write_pair(
                original.catalog.as_ref().unwrap(),
                original.preferences.as_ref().unwrap(),
            )
            .unwrap();
        {
            let c = connect(&root.path().join(DB), false).unwrap();
            c.execute_batch("DROP TABLE public_archive_variant_v1;DROP TABLE public_archive_item_v1;DROP TABLE public_archive_preference_v1;DROP TABLE public_archive_removal_v1;DROP TABLE public_archive_checkpoint_v1;DROP TABLE archive_bookmark_v1;DROP TABLE archive_bookmark_meta_v1;DROP TABLE archive_file_v1;DROP TABLE archive_item_progress_v1;DROP TABLE archive_progress_v1;DROP TABLE archive_preferences_v1;DROP TABLE archive_removal_v1;DROP TABLE archive_title_v1;DROP TABLE archive_catalog_meta_v1;DROP TABLE catalog_endpoint_projection_v1;DROP TABLE catalog_trigram;DROP TABLE catalog_shortgram;DROP TABLE catalog_projection;DROP TABLE catalog_projection_meta;DROP INDEX catalog_channel_state;DROP INDEX catalog_channel_region;ALTER TABLE metadata DROP COLUMN automatic_guide_updates;PRAGMA user_version=8;").unwrap();
        }
        let reopened = PairStore::new(root.path().into()).unwrap();
        assert_eq!(
            canonical(&reopened.read_pair().unwrap()),
            canonical(&original)
        );
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let page = reopened
            .query_catalog_page(&catalog_query(), &flag)
            .unwrap();
        assert_eq!(page.rows[0].id, "channel-4");
        assert_eq!(page.total_count, 1);
        let backup = connect(&root.path().join(BACKUP), true).unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            8
        );
        assert_eq!(
            canonical(&PairStore::read_connection(&backup).unwrap()),
            canonical(&original)
        );
    }
    #[test]
    fn catalog_view_revision_changes_only_for_catalog_or_preference_identity_and_rollback() {
        let root = tempfile::tempdir().unwrap();
        let store = PairStore::new(root.path().into()).unwrap();
        let original = pair(5);
        store
            .write_pair(
                original.catalog.as_ref().unwrap(),
                original.preferences.as_ref().unwrap(),
            )
            .unwrap();
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let first = store.query_catalog_page(&catalog_query(), &flag).unwrap();
        let mut pref: Value = serde_json::from_str(original.preferences.as_ref().unwrap()).unwrap();
        pref["volume"] = json!(0.75);
        store.write("preferences", &pref.to_string()).unwrap();
        let volume = store.query_catalog_page(&catalog_query(), &flag).unwrap();
        assert_eq!(first.view_revision, volume.view_revision);
        assert_eq!(first.catalog_revision, volume.catalog_revision);
        pref["favorites"] = json!(["channel-5", "missing"]);
        store.write("preferences", &pref.to_string()).unwrap();
        let favorite = store.query_catalog_page(&catalog_query(), &flag).unwrap();
        assert_ne!(favorite.view_revision, volume.view_revision);
        assert_eq!(favorite.catalog_revision, volume.catalog_revision);
        assert!(favorite.rows[0].favorite);
        pref["favorites"] = json!(["missing", "channel-5"]);
        store.write("preferences", &pref.to_string()).unwrap();
        assert_eq!(
            store
                .query_catalog_page(&catalog_query(), &flag)
                .unwrap()
                .view_revision,
            favorite.view_revision
        );
        let replacement = pair(6);
        assert!(store
            .write_records_with_phase(&replacement, None, (None, None), None, |phase| {
                if phase == Phase::BeforeCommit {
                    Err("injected-cancel".into())
                } else {
                    Ok(())
                }
            })
            .is_err());
        let retained = store.query_catalog_page(&catalog_query(), &flag).unwrap();
        assert_eq!(retained.rows[0].id, "channel-5");
        assert_eq!(retained.view_revision, favorite.view_revision);
        let old_projection = store
            .with_guide_read(|c| {
                sql(c.query_row(
                    "SELECT rowid,stamp FROM catalog_projection WHERE channel_id='channel-5'",
                    [],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)),
                ))
            })
            .unwrap();
        store
            .write("catalog", original.catalog.as_ref().unwrap())
            .unwrap();
        let same_projection = store
            .with_guide_read(|c| {
                sql(c.query_row(
                    "SELECT rowid,stamp FROM catalog_projection WHERE channel_id='channel-5'",
                    [],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)),
                ))
            })
            .unwrap();
        assert_eq!(old_projection, same_projection);
        pref["removedChannels"] = json!(["channel-5"]);
        store.write("preferences", &pref.to_string()).unwrap();
        assert!(store
            .query_catalog_page(&catalog_query(), &flag)
            .unwrap()
            .rows
            .is_empty());
        assert_eq!(
            serde_json::from_str::<Value>(store.read("preferences").unwrap().as_ref().unwrap())
                .unwrap()["favorites"],
            json!(["missing", "channel-5"])
        );
    }
    #[test]
    fn existing_v1_catalog_migrates_to_v11_with_verified_v1_backup() {
        let root = tempfile::tempdir().unwrap();
        let original = pair(42);
        {
            // Intentional owned legacy fixture creation; production connections
            // refuse missing databases instead of creating empty replacements.
            fs::write(root.path().join(DB), b"").unwrap();
            let mut c = connect(&root.path().join(DB), false).unwrap();
            c.execute_batch(SCHEMA).unwrap();
            PairStore::apply(&mut c, &original, |_| Ok(())).unwrap();
        }
        let store = PairStore::new(root.path().into()).unwrap();
        assert_eq!(canonical(&store.read_pair().unwrap()), canonical(&original));
        store
            .with_guide_read(|c| {
                assert_eq!(
                    c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                        .unwrap(),
                    16
                );
                assert!(crate::guide::database::list_sources(c)?.is_empty());
                Ok(())
            })
            .unwrap();
        let backup = connect(&root.path().join(BACKUP), true).unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        integrity(&backup).unwrap();
        drop(backup);
        fs::write(root.path().join(DB), b"corrupted guide database").unwrap();
        let recovered = PairStore::new(root.path().into()).unwrap();
        assert_eq!(
            canonical(&recovered.read_pair().unwrap()),
            canonical(&original)
        );
        recovered
            .with_guide_read(|c| {
                assert_eq!(
                    c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                        .unwrap(),
                    16
                );
                Ok(())
            })
            .unwrap();
    }
    #[test]
    fn geography_roundtrip_preferences_write_recovery_and_v2_migration() {
        let root = tempfile::tempdir().unwrap();
        let original = pair(7);
        {
            fs::write(root.path().join(DB), b"").unwrap();
            let mut c = connect(&root.path().join(DB), false).unwrap();
            c.execute_batch(SCHEMA).unwrap();
            PairStore::apply(&mut c, &original, |_| Ok(())).unwrap();
            crate::guide::database::migrate(&mut c).unwrap();
            c.execute(
                "INSERT INTO guide_source VALUES('guide','Saved guide','fixture','file',0,1,NULL,0)",
                [],
            )
            .unwrap();
        }
        let store = PairStore::new(root.path().into()).unwrap();
        store
            .with_guide_read(|c| {
                assert_eq!(
                    c.query_row("SELECT count(*) FROM guide_source", [], |r| r
                        .get::<_, i64>(0))
                        .unwrap(),
                    1
                );
                Ok(())
            })
            .unwrap();
        let mut record: Value = serde_json::from_str(original.catalog.as_ref().unwrap()).unwrap();
        record["channels"][0]["geography"] =
            json!({"country":"US","region":"AMER","state":"US-IL"});
        record["channels"][0]["geographyProvenance"] = json!([{"field":"country","value":"US","sourceId":"source","kind":"m3u","scope":"channel-origin"},{"field":"state","value":"US-IL","sourceId":"source","kind":"user","scope":"user-reviewed"}]);
        store.write("catalog", &record.to_string()).unwrap();
        store
            .write("preferences", original.preferences.as_ref().unwrap())
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(store.read("catalog").unwrap().as_ref().unwrap())
                .unwrap(),
            record
        );
        let backup = connect(&root.path().join(BACKUP), true).unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            16
        );
        drop(backup);
        fs::write(root.path().join(DB), b"corrupt").unwrap();
        let recovered = PairStore::new(root.path().into()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(recovered.read("catalog").unwrap().as_ref().unwrap())
                .unwrap(),
            record
        );
        for mutate in 0..3 {
            let mut invalid = record.clone();
            match mutate {
                0 => invalid["channels"][0]["geography"]["country"] = json!("CA"),
                1 => invalid["channels"][0]["geographyProvenance"][0]["sourceId"] = json!("other"),
                _ => invalid["channels"][0]["geographyProvenance"][0]["value"] = json!("ZZ"),
            };
            assert!(recovered.write("catalog", &invalid.to_string()).is_err());
        }
        assert_eq!(
            serde_json::from_str::<Value>(recovered.read("catalog").unwrap().as_ref().unwrap())
                .unwrap(),
            record
        );
    }
    fn pair(n: u32) -> RecordPair {
        let sources =
            json!([{"id":"source","name":"Fixture","location":"fixture.m3u","kind":"file"}]);
        RecordPair{catalog:Some(json!({"schemaVersion":1,"sources":sources,"channels":[{"id":format!("channel-{n}"),"sourceId":"source","name":format!("Fixture {n}"),"category":"Sports","urls":["https://example.invalid/live"]}]}).to_string()),preferences:Some(json!({"schemaVersion":1,"sources":sources,"favorites":["pending-favorite"],"removedChannels":["pending-removal"],"volume":0.5,"muted":false,"panelWidth":300.0,"automaticSourceRefresh":false,"sourceRefreshCadence":"off","sourceRefreshAttemptAt":0}).to_string())}
    }
    fn write(s: &PairStore, n: u32) {
        let p = pair(n);
        s.write_pair(p.catalog.as_ref().unwrap(), p.preferences.as_ref().unwrap())
            .unwrap();
    }
    #[test]
    fn source_refresh_preferences_v5_migration_roundtrip_and_invalid_rollback() {
        let root = tempfile::tempdir().unwrap();
        let store = PairStore::new(root.path().into()).unwrap();
        let original = pair(9);
        store
            .write_pair(
                original.catalog.as_ref().unwrap(),
                original.preferences.as_ref().unwrap(),
            )
            .unwrap();
        {
            let c = connect(&root.path().join(DB), false).unwrap();
            c.execute_batch("DROP TABLE public_archive_variant_v1;DROP TABLE public_archive_item_v1;DROP TABLE public_archive_preference_v1;DROP TABLE public_archive_removal_v1;DROP TABLE public_archive_checkpoint_v1;DROP TABLE archive_bookmark_v1;DROP TABLE archive_bookmark_meta_v1;DROP TABLE archive_file_v1;DROP TABLE archive_item_progress_v1;DROP TABLE archive_progress_v1;DROP TABLE archive_preferences_v1;DROP TABLE archive_removal_v1;DROP TABLE archive_title_v1;DROP TABLE archive_catalog_meta_v1;DROP TABLE catalog_endpoint_projection_v1;DROP TABLE catalog_trigram;DROP TABLE catalog_shortgram;DROP TABLE catalog_projection;DROP TABLE catalog_projection_meta;DROP INDEX catalog_channel_state;DROP INDEX catalog_channel_region;ALTER TABLE preference DROP COLUMN source_refresh_cadence;ALTER TABLE guide_program DROP COLUMN categories_json;ALTER TABLE guide_program DROP COLUMN categories_key;ALTER TABLE preference DROP COLUMN reviewed_channel_providers;ALTER TABLE preference DROP COLUMN reviewed_guide_providers;ALTER TABLE preference DROP COLUMN preferred_region;ALTER TABLE preference DROP COLUMN voice_search_consent;ALTER TABLE preference DROP COLUMN auto_source_refresh;ALTER TABLE preference DROP COLUMN source_refresh_attempt_at;ALTER TABLE metadata DROP COLUMN automatic_guide_updates;PRAGMA user_version=5;").unwrap();
        }
        let reopened = PairStore::new(root.path().into()).unwrap();
        let migrated = reopened.read_pair().unwrap();
        let catalog_revision = reopened.read_snapshot().unwrap().catalog_revision;
        let mut pref: Value = serde_json::from_str(migrated.preferences.as_ref().unwrap()).unwrap();
        assert_eq!(pref["automaticSourceRefresh"], false);
        assert_eq!(pref["sourceRefreshAttemptAt"], 0);
        let backup = connect(&root.path().join(BACKUP), true).unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            5
        );
        integrity(&backup).unwrap();
        drop(backup);
        pref["automaticSourceRefresh"] = json!(true);
        pref["sourceRefreshCadence"] = json!("daily");
        pref["sourceRefreshAttemptAt"] = json!(1_791_700_000_000_i64);
        reopened.write("preferences", &pref.to_string()).unwrap();
        let persisted = PairStore::new(root.path().into())
            .unwrap()
            .read_pair()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(persisted.preferences.as_ref().unwrap()).unwrap(),
            pref
        );
        assert_eq!(persisted.catalog, migrated.catalog);
        assert_eq!(
            reopened.read_snapshot().unwrap().catalog_revision,
            catalog_revision
        );
        for invalid in [
            json!(-1),
            json!(1.5),
            json!(8_640_000_000_000_001_i64),
            json!(null),
            json!("1"),
        ] {
            let mut bad = pref.clone();
            bad["sourceRefreshAttemptAt"] = invalid;
            assert_eq!(
                reopened.write("preferences", &bad.to_string()).unwrap_err(),
                "record-invalid-source-refresh"
            );
            assert_eq!(
                reopened.read_pair().unwrap().preferences,
                persisted.preferences
            );
        }
        let mut bad = pref.clone();
        bad["automaticSourceRefresh"] = json!("true");
        bad.as_object_mut().unwrap().remove("sourceRefreshCadence");
        assert_eq!(
            reopened.write("preferences", &bad.to_string()).unwrap_err(),
            "record-invalid-source-refresh"
        );
        pref.as_object_mut().unwrap().remove("sourceRefreshCadence");
        pref.as_object_mut()
            .unwrap()
            .remove("automaticSourceRefresh");
        pref.as_object_mut()
            .unwrap()
            .remove("sourceRefreshAttemptAt");
        reopened.write("preferences", &pref.to_string()).unwrap();
        let legacy: Value =
            serde_json::from_str(reopened.read_pair().unwrap().preferences.as_ref().unwrap())
                .unwrap();
        assert_eq!(legacy["automaticSourceRefresh"], false);
        assert_eq!(legacy["sourceRefreshAttemptAt"], 0);
    }

    fn canonical(p: &RecordPair) -> (Option<Value>, Option<Value>) {
        (
            p.catalog
                .as_deref()
                .map(|s| serde_json::from_str(s).unwrap()),
            p.preferences
                .as_deref()
                .map(|s| serde_json::from_str(s).unwrap()),
        )
    }
    #[test]
    fn normalized_tables_indexes_foreign_keys_and_atomic_reopen() {
        let root = tempfile::tempdir().unwrap();
        let s = PairStore::new(root.path().into()).unwrap();
        assert_eq!(s.read_pair().unwrap(), RecordPair::default());
        write(&s, 1);
        let c = connect(&root.path().join(DB), false).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM channel_url", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(c
            .execute(
                "INSERT INTO channel_url VALUES('absent',0,'https://example.invalid')",
                []
            )
            .is_err());
        let plan: String = c
            .query_row(
                "EXPLAIN QUERY PLAN SELECT id FROM channel WHERE name='Fixture 1' COLLATE NOCASE",
                [],
                |r| r.get(3),
            )
            .unwrap();
        assert!(plan.contains("channel_name"));
        assert_eq!(
            c.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "delete"
        );
        assert_eq!(
            c.query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        drop(c);
        assert_eq!(
            canonical(
                &PairStore::new(root.path().into())
                    .unwrap()
                    .read_pair()
                    .unwrap()
            ),
            canonical(&pair(1))
        );
    }
    #[test]
    fn refresh_preserves_pending_choices_and_preferences_edit_keeps_catalog() {
        let root = tempfile::tempdir().unwrap();
        let s = PairStore::new(root.path().into()).unwrap();
        write(&s, 1);
        s.write("catalog", pair(2).catalog.as_ref().unwrap())
            .unwrap();
        let p = s.read_pair().unwrap();
        assert_eq!(canonical(&p), canonical(&pair(2)));
        let mut prefs: Value = serde_json::from_str(p.preferences.as_ref().unwrap()).unwrap();
        prefs["muted"] = json!(true);
        s.write("preferences", &prefs.to_string()).unwrap();
        let r = s.read_pair().unwrap();
        assert_eq!(canonical(&r).0, canonical(&pair(2)).0);
        assert_eq!(canonical(&r).1.unwrap()["muted"], true);
    }
    #[test]
    fn failure_mid_transaction_and_before_commit_rolls_back_both_records() {
        for phase in [Phase::AfterCatalog, Phase::BeforeCommit] {
            let root = tempfile::tempdir().unwrap();
            let s = PairStore::new(root.path().into()).unwrap();
            write(&s, 1);
            assert!(s
                .commit(&pair(2), |at| if at == phase {
                    Err("injected".into())
                } else {
                    Ok(())
                })
                .is_err());
            assert_eq!(
                canonical(
                    &PairStore::new(root.path().into())
                        .unwrap()
                        .read_pair()
                        .unwrap()
                ),
                canonical(&pair(1))
            );
        }
    }
    #[test]
    fn crash_after_commit_has_complete_new_revision() {
        let root = tempfile::tempdir().unwrap();
        let s = PairStore::new(root.path().into()).unwrap();
        write(&s, 1);
        assert!(s
            .commit(&pair(2), |at| if at == Phase::AfterCommit {
                Err("injected-process-exit".into())
            } else {
                Ok(())
            })
            .is_err());
        assert_eq!(
            canonical(
                &PairStore::new(root.path().into())
                    .unwrap()
                    .read_pair()
                    .unwrap()
            ),
            canonical(&pair(2))
        );
    }
    #[test]
    fn actual_process_kill_preserves_atomic_revision() {
        const CHILD_ROOT: &str = "GENX_STORAGE_KILL_CHILD_ROOT";
        const CHILD_PHASE: &str = "GENX_STORAGE_KILL_CHILD_PHASE";
        let phases = [
            ("after-catalog", Phase::AfterCatalog, 1),
            ("before-commit", Phase::BeforeCommit, 1),
            ("after-commit", Phase::AfterCommit, 2),
        ];
        if let Some(child_root) = std::env::var_os(CHILD_ROOT) {
            let root = PathBuf::from(child_root);
            let canonical_root = root.canonicalize().unwrap();
            let temporary_root = std::env::temp_dir().canonicalize().unwrap();
            assert!(canonical_root.starts_with(temporary_root));
            assert!(root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("genx-process-kill-"));
            assert!(!fs::symlink_metadata(&root)
                .unwrap()
                .file_type()
                .is_symlink());
            let requested = std::env::var(CHILD_PHASE).unwrap();
            let phase = phases
                .iter()
                .find(|(name, _, _)| *name == requested)
                .unwrap()
                .1;
            let store = PairStore::new(root.clone()).unwrap();
            store
                .commit(&pair(2), |at| {
                    if at == phase {
                        fs::write(root.join("checkpoint-ready"), requested.as_bytes()).unwrap();
                        // The parent terminates this OS process. No Rust Drop/SQLite
                        // rollback path is allowed to simulate the crash for it.
                        loop {
                            std::thread::sleep(Duration::from_millis(50));
                        }
                    }
                    Ok(())
                })
                .unwrap();
            panic!("Child did not reach its owned checkpoint");
        }
        struct OwnedChild(std::process::Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        for (name, _, expected_revision) in phases {
            let root = tempfile::Builder::new()
                .prefix("genx-process-kill-")
                .tempdir()
                .unwrap();
            let store = PairStore::new(root.path().into()).unwrap();
            write(&store, 1);
            let mut child = OwnedChild(
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "storage_transaction::tests::actual_process_kill_preserves_atomic_revision",
                        "--nocapture",
                    ])
                    .env(CHILD_ROOT, root.path())
                    .env(CHILD_PHASE, name)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            let marker = root.path().join("checkpoint-ready");
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !marker.exists() {
                assert!(
                    child.0.try_wait().unwrap().is_none(),
                    "Child exited before checkpoint"
                );
                assert!(
                    std::time::Instant::now() < deadline,
                    "Child checkpoint deadline exceeded"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(fs::read_to_string(marker).unwrap(), name);
            child.0.kill().unwrap();
            assert!(!child.0.wait().unwrap().success());
            let reopened = PairStore::new(root.path().into()).unwrap();
            assert_eq!(
                canonical(&reopened.read_pair().unwrap()),
                canonical(&pair(expected_revision))
            );
            let connection = connect(&root.path().join(DB), true).unwrap();
            assert_eq!(
                connection
                    .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
        }
    }
    #[test]
    fn real_sqlite_full_rolls_back_catalog_and_preferences() {
        let root = tempfile::tempdir().unwrap();
        let store = PairStore::new(root.path().into()).unwrap();
        write(&store, 1);
        let mut connection = connect(&root.path().join(DB), false).unwrap();
        let current_pages: i64 = connection
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        connection
            .pragma_update(None, "max_page_count", current_pages)
            .unwrap();
        // Confirm this is real SQLITE_FULL, rather than an arbitrary injected
        // application error. Only this owned connection's page budget changes.
        let full = connection
            .execute_batch("CREATE TABLE full_probe(value BLOB); INSERT INTO full_probe VALUES(zeroblob(1048576));")
            .unwrap_err();
        assert_eq!(
            full.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DiskFull)
        );
        connection
            .execute_batch("DROP TABLE IF EXISTS full_probe;")
            .unwrap();
        let mut replacement = pair(2);
        let mut catalog: Value =
            serde_json::from_str(replacement.catalog.as_ref().unwrap()).unwrap();
        catalog["channels"][0]["name"] = json!("x".repeat(16 * 1024));
        replacement.catalog = Some(catalog.to_string());
        assert_eq!(
            PairStore::apply(&mut connection, &replacement, |_| Ok(())).unwrap_err(),
            "sqlite-storage-full"
        );
        drop(connection);
        let reopened = PairStore::new(root.path().into()).unwrap();
        assert_eq!(
            canonical(&reopened.read_pair().unwrap()),
            canonical(&pair(1))
        );
        let connection = connect(&root.path().join(DB), true).unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }
    #[test]
    fn corrupt_database_recovers_verified_complete_backup() {
        let root = tempfile::tempdir().unwrap();
        let s = PairStore::new(root.path().into()).unwrap();
        write(&s, 1);
        write(&s, 2);
        fs::write(root.path().join(DB), b"corrupt sqlite header").unwrap();
        assert_eq!(
            canonical(
                &PairStore::new(root.path().into())
                    .unwrap()
                    .read_pair()
                    .unwrap()
            ),
            canonical(&pair(1))
        );
    }
    #[test]
    fn unknown_schema_never_downgrades_to_backup() {
        let root = tempfile::tempdir().unwrap();
        let s = PairStore::new(root.path().into()).unwrap();
        write(&s, 1);
        connect(&root.path().join(DB), false)
            .unwrap()
            .execute_batch("PRAGMA user_version=99")
            .unwrap();
        assert!(PairStore::new(root.path().into()).is_err());
        assert_eq!(
            connect(&root.path().join(DB), true)
                .unwrap()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            99
        );
    }
    #[test]
    fn invalid_duplicate_missing_reference_http_and_oversize_inputs_leave_revision() {
        let root = tempfile::tempdir().unwrap();
        let s = PairStore::new(root.path().into()).unwrap();
        write(&s, 1);
        let base: Value = serde_json::from_str(pair(2).catalog.as_ref().unwrap()).unwrap();
        let mut bad = base.clone();
        let duplicate = bad["channels"][0].clone();
        bad["channels"].as_array_mut().unwrap().push(duplicate);
        assert!(s.write("catalog", &bad.to_string()).is_err());
        let mut bad = base.clone();
        bad["channels"][0]["sourceId"] = json!("absent");
        assert!(s.write("catalog", &bad.to_string()).is_err());
        let mut bad = base.clone();
        bad["channels"][0]["urls"] = json!(["http://example.invalid/live"]);
        assert!(s.write("catalog", &bad.to_string()).is_err());
        let mut bad = base.clone();
        bad["schemaVersion"] = json!(2);
        assert!(s.write("catalog", &bad.to_string()).is_err());
        assert!(s.write("catalog", &" ".repeat(LIMIT as usize + 1)).is_err());
        assert!(s.write("../outside", "{}").is_err());
        assert_eq!(canonical(&s.read_pair().unwrap()), canonical(&pair(1)));
    }
    #[test]
    fn explicit_http_grant_roundtrips_and_metadata_is_bound_as_data() {
        let root = tempfile::tempdir().unwrap();
        let s = PairStore::new(root.path().into()).unwrap();
        let mut p = pair(1);
        let mut c: Value = serde_json::from_str(p.catalog.as_ref().unwrap()).unwrap();
        let mut prefs: Value = serde_json::from_str(p.preferences.as_ref().unwrap()).unwrap();
        c["sources"][0]["allowHttp"] = json!(true);
        c["channels"][0]["urls"] = json!(["http://example.invalid/live"]);
        c["channels"][0]["name"] = json!("';DROP TABLE channel;--");
        prefs["sources"] = c["sources"].clone();
        p.catalog = Some(c.to_string());
        p.preferences = Some(prefs.to_string());
        s.write_pair(p.catalog.as_ref().unwrap(), p.preferences.as_ref().unwrap())
            .unwrap();
        assert_eq!(canonical(&s.read_pair().unwrap()), canonical(&p));
    }
    #[test]
    fn legacy_files_are_imported_once_and_retained_unmodified() {
        let root = tempfile::tempdir().unwrap();
        let p = pair(1);
        fs::write(
            root.path().join("catalog.json"),
            p.catalog.as_ref().unwrap(),
        )
        .unwrap();
        fs::write(
            root.path().join("preferences.json"),
            p.preferences.as_ref().unwrap(),
        )
        .unwrap();
        let s = PairStore::new(root.path().into()).unwrap();
        assert_eq!(canonical(&s.read_pair().unwrap()), canonical(&p));
        write(&s, 2);
        assert_eq!(
            fs::read_to_string(root.path().join("catalog.json")).unwrap(),
            p.catalog.unwrap()
        );
        assert_eq!(
            canonical(
                &PairStore::new(root.path().into())
                    .unwrap()
                    .read_pair()
                    .unwrap()
            ),
            canonical(&pair(2))
        );
    }
    #[test]
    fn backup_failure_keeps_database_and_hot_journal_prevents_unsafe_restore() {
        let root = tempfile::tempdir().unwrap();
        let s = PairStore::new(root.path().into()).unwrap();
        write(&s, 1);
        fs::remove_file(root.path().join(BACKUP)).unwrap();
        fs::create_dir(root.path().join(BACKUP)).unwrap();
        assert!(s
            .write("catalog", pair(2).catalog.as_ref().unwrap())
            .is_err());
        assert_eq!(canonical(&s.read_pair().unwrap()), canonical(&pair(1)));
        fs::remove_dir(root.path().join(BACKUP)).unwrap();
        write(&s, 2);
        fs::write(root.path().join(DB), b"broken").unwrap();
        fs::write(
            root.path().join(format!("{DB}-journal")),
            b"forensic journal",
        )
        .unwrap();
        assert!(PairStore::new(root.path().into()).is_err());
        assert!(root.path().join(format!("{DB}-journal")).exists());
    }
}

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
