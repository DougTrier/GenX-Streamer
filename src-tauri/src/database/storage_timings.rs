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

//! Fixed aggregate process timings only. No payload, path, ID or error text.
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::Instant;

#[derive(Clone, Copy)]
pub(crate) enum Stage {
    ReadAdmission,
    ReplacementAdmission,
    WriterAdmission,
    Snapshot,
    Backup,
    Setup,
    StoreOpen,
    RecoveryInspection,
    InspectionQuickCheck,
    InspectionForeignKeys,
    RecoveryMigration,
    RecoveryFinalIntegrity,
    BackupCopy,
    BackupQuickCheck,
    BackupForeignKeys,
    BackupSync,
    BackupReplace,
    RegistrationWait,
    StartupWorkerQueue,
    InspectionOpen,
    InspectionConfigure,
    InspectionSchema,
    InspectionPagerRead,
    ArchiveRootLock,
}
struct Counter {
    count: AtomicU64,
    micros: AtomicU64,
    max_micros: AtomicU64,
}
impl Counter {
    const fn new() -> Self {
        Self {
            count: AtomicU64::new(0),
            micros: AtomicU64::new(0),
            max_micros: AtomicU64::new(0),
        }
    }
    fn record(&self, micros: u64) {
        const SAFE: u64 = 9_007_199_254_740_991;
        let micros = micros.min(SAFE);
        let _ = self
            .count
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| {
                Some(v.saturating_add(1).min(SAFE))
            });
        let _ = self
            .micros
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| {
                Some(v.saturating_add(micros).min(SAFE))
            });
        self.max_micros.fetch_max(micros, Ordering::Relaxed);
    }
    fn snapshot(&self) -> Sample {
        Sample {
            count: self.count.load(Ordering::Relaxed),
            total_ms: self.micros.load(Ordering::Relaxed) as f64 / 1000.0,
            max_ms: self.max_micros.load(Ordering::Relaxed) as f64 / 1000.0,
        }
    }
}
static COUNTERS: [Counter; 24] = [const { Counter::new() }; 24];
/// Fixed synchronous caller scopes. These diagnostics never carry authority.
#[derive(Clone, Copy)]
pub(crate) enum ArchiveCaller {
    RecoveryHandoff,
    OpenHandoff,
    Activate,
    OpenLocked,
    Other,
}
#[derive(Clone, Copy)]
pub(crate) enum ArchivePhase {
    Call,
    Pair,
    Primary,
    Backup,
    QuickCheck,
    DomainWalk,
    DomainValidation,
}
static ARCHIVE_COUNTERS: [[Counter; 7]; 5] = [const { [const { Counter::new() }; 7] }; 5];
thread_local! {
    // Already const. Clippy on the Android targets still asks for it (it reads
    // that platform's thread_local! expansion, not this initializer).
    #[allow(
        clippy::missing_const_for_thread_local,
        reason = "the initializer is const; Android-only false positive"
    )]
    static ARCHIVE_CALLER: std::cell::Cell<ArchiveCaller> = const { std::cell::Cell::new(ArchiveCaller::Other) };
}
pub(crate) struct ArchiveMeasurement {
    caller: ArchiveCaller,
    phase: ArchivePhase,
    started: Instant,
}
pub(crate) fn archive_measure(phase: ArchivePhase) -> ArchiveMeasurement {
    ArchiveMeasurement {
        caller: ARCHIVE_CALLER.with(std::cell::Cell::get),
        phase,
        started: Instant::now(),
    }
}
impl Drop for ArchiveMeasurement {
    fn drop(&mut self) {
        ARCHIVE_COUNTERS[self.caller as usize][self.phase as usize]
            .record(self.started.elapsed().as_micros().min(u64::MAX as u128) as u64);
    }
}
pub(crate) struct ArchiveCallerScope {
    previous: ArchiveCaller,
    measurement: ArchiveMeasurement,
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}
pub(crate) fn archive_caller(caller: ArchiveCaller) -> ArchiveCallerScope {
    let previous = ARCHIVE_CALLER.with(|current| current.replace(caller));
    ArchiveCallerScope {
        previous,
        measurement: archive_measure(ArchivePhase::Call),
        _thread: std::marker::PhantomData,
    }
}
impl Drop for ArchiveCallerScope {
    fn drop(&mut self) {
        ARCHIVE_CALLER.with(|current| current.set(self.previous));
        // The retained measurement records its original caller on field drop,
        // including early refusal or unwind. No work/result is intercepted.
        let _ = &self.measurement;
    }
}
static PAGER: Mutex<Option<Pager>> = Mutex::new(None);
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pager {
    samples: u64,
    cache_size_pages_or_kib: i64,
    mmap_bytes: u64,
    page_count: u64,
    page_size_bytes: u64,
    freelist_pages: u64,
    sqlite_version_number: i32,
    final_mmap_bytes: Option<u64>,
}
/// One coherent connection-local sample; invalid diagnostics never affect admission.
fn pager_sample(cache: i64, mmap: i64, pages: i64, size: i64, free: i64) -> Option<Pager> {
    const SAFE: i64 = 9_007_199_254_740_991;
    if !(-SAFE..=SAFE).contains(&cache)
        || !(0..=SAFE).contains(&mmap)
        || !(0..=SAFE).contains(&pages)
        || !(512..=65536).contains(&size)
        || !(0..=pages).contains(&free)
    {
        return None;
    }
    Some(Pager {
        samples: 0,
        cache_size_pages_or_kib: cache,
        mmap_bytes: mmap as u64,
        page_count: pages as u64,
        page_size_bytes: size as u64,
        freelist_pages: free as u64,
        sqlite_version_number: rusqlite::version_number(),
        final_mmap_bytes: None,
    })
}
pub(crate) fn record_pager(cache: i64, mmap: i64, pages: i64, size: i64, free: i64) -> Option<u64> {
    let mut value = pager_sample(cache, mmap, pages, size, free)?;
    let mut sample = PAGER.lock().ok()?;
    let ticket = sample.map_or(0, |value| value.samples).checked_add(1)?;
    if ticket > 9_007_199_254_740_991 {
        return None;
    }
    value.samples = ticket;
    *sample = Some(value);
    Some(ticket)
}
fn finish_pager(sample: &mut Option<Pager>, ticket: u64, mmap: i64) {
    if !(0..=9_007_199_254_740_991).contains(&mmap) {
        return;
    }
    if let Some(value) = sample.as_mut().filter(|value| value.samples == ticket) {
        value.final_mmap_bytes = Some(mmap as u64);
    }
}
pub(crate) fn record_final_mmap(ticket: u64, mmap: i64) {
    if let Ok(mut sample) = PAGER.lock() {
        finish_pager(&mut sample, ticket, mmap);
    }
}
static BACKUP_HANDSHAKES: AtomicU64 = AtomicU64::new(0);
pub(crate) fn backup_verification_handshake() {
    let _ = BACKUP_HANDSHAKES.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        Some(value.saturating_add(1).min(9_007_199_254_740_991))
    });
}
pub(crate) struct Measurement {
    stage: Stage,
    started: Instant,
}
pub(crate) fn measure(stage: Stage) -> Measurement {
    Measurement {
        stage,
        started: Instant::now(),
    }
}
impl Drop for Measurement {
    fn drop(&mut self) {
        COUNTERS[self.stage as usize]
            .record(self.started.elapsed().as_micros().min(u64::MAX as u128) as u64);
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sample {
    count: u64,
    total_ms: f64,
    max_ms: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    schema_version: u8,
    read_admission: Sample,
    replacement_admission: Sample,
    writer_admission: Sample,
    snapshot: Sample,
    backup: Sample,
    backup_phases: BackupPhases,
    startup: Startup,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupPhases {
    verification_handshakes: u64,
    copy: Sample,
    quick_check: Sample,
    foreign_keys: Sample,
    sync: Sample,
    replace: Sample,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Startup {
    setup: Sample,
    store_open: Sample,
    recovery_inspection: Sample,
    inspection_quick_check: Sample,
    inspection_foreign_keys: Sample,
    recovery_migration: Sample,
    recovery_final_integrity: Sample,
    registration_wait: Sample,
    worker_queue: Sample,
    inspection_open: Sample,
    inspection_configure: Sample,
    inspection_schema: Sample,
    inspection_pager_read: Sample,
    pager: Option<Pager>,
    archive: ArchiveStartup,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveCallerSamples {
    call: Sample,
    pair_verification: Sample,
    primary_verification: Sample,
    backup_verification: Sample,
    quick_check: Sample,
    domain_walk: Sample,
    domain_validation: Sample,
}
fn archive_samples(caller: ArchiveCaller) -> ArchiveCallerSamples {
    let c = &ARCHIVE_COUNTERS[caller as usize];
    ArchiveCallerSamples {
        call: c[0].snapshot(),
        pair_verification: c[1].snapshot(),
        primary_verification: c[2].snapshot(),
        backup_verification: c[3].snapshot(),
        quick_check: c[4].snapshot(),
        domain_walk: c[5].snapshot(),
        domain_validation: c[6].snapshot(),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveStartup {
    root_lock: Sample,
    recovery_handoff: ArchiveCallerSamples,
    open_handoff: ArchiveCallerSamples,
    activate: ArchiveCallerSamples,
    open_locked: ArchiveCallerSamples,
    other: ArchiveCallerSamples,
}
pub(crate) fn snapshot() -> Snapshot {
    Snapshot {
        schema_version: 1,
        read_admission: COUNTERS[0].snapshot(),
        replacement_admission: COUNTERS[1].snapshot(),
        writer_admission: COUNTERS[2].snapshot(),
        snapshot: COUNTERS[3].snapshot(),
        backup: COUNTERS[4].snapshot(),
        backup_phases: BackupPhases {
            verification_handshakes: BACKUP_HANDSHAKES.load(Ordering::Relaxed),
            copy: COUNTERS[Stage::BackupCopy as usize].snapshot(),
            quick_check: COUNTERS[Stage::BackupQuickCheck as usize].snapshot(),
            foreign_keys: COUNTERS[Stage::BackupForeignKeys as usize].snapshot(),
            sync: COUNTERS[Stage::BackupSync as usize].snapshot(),
            replace: COUNTERS[Stage::BackupReplace as usize].snapshot(),
        },
        startup: Startup {
            setup: COUNTERS[Stage::Setup as usize].snapshot(),
            store_open: COUNTERS[Stage::StoreOpen as usize].snapshot(),
            recovery_inspection: COUNTERS[Stage::RecoveryInspection as usize].snapshot(),
            inspection_quick_check: COUNTERS[Stage::InspectionQuickCheck as usize].snapshot(),
            inspection_foreign_keys: COUNTERS[Stage::InspectionForeignKeys as usize].snapshot(),
            recovery_migration: COUNTERS[Stage::RecoveryMigration as usize].snapshot(),
            recovery_final_integrity: COUNTERS[Stage::RecoveryFinalIntegrity as usize].snapshot(),
            registration_wait: COUNTERS[Stage::RegistrationWait as usize].snapshot(),
            worker_queue: COUNTERS[Stage::StartupWorkerQueue as usize].snapshot(),
            inspection_open: COUNTERS[Stage::InspectionOpen as usize].snapshot(),
            inspection_configure: COUNTERS[Stage::InspectionConfigure as usize].snapshot(),
            inspection_schema: COUNTERS[Stage::InspectionSchema as usize].snapshot(),
            inspection_pager_read: COUNTERS[Stage::InspectionPagerRead as usize].snapshot(),
            pager: PAGER.lock().ok().and_then(|value| *value),
            archive: ArchiveStartup {
                root_lock: COUNTERS[Stage::ArchiveRootLock as usize].snapshot(),
                recovery_handoff: archive_samples(ArchiveCaller::RecoveryHandoff),
                open_handoff: archive_samples(ArchiveCaller::OpenHandoff),
                activate: archive_samples(ArchiveCaller::Activate),
                open_locked: archive_samples(ArchiveCaller::OpenLocked),
                other: archive_samples(ArchiveCaller::Other),
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aggregates_are_bounded_and_have_only_fixed_fields() {
        let c = Counter::new();
        c.record(1500);
        c.record(2500);
        let s = c.snapshot();
        assert_eq!(s.count, 2);
        assert_eq!(s.total_ms, 4.0);
        assert_eq!(s.max_ms, 2.5);
        c.record(u64::MAX);
        assert!(c.snapshot().total_ms.is_finite());
        let value = serde_json::to_value(snapshot()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 8);
        assert_eq!(value["schemaVersion"], 1);
        for key in [
            "readAdmission",
            "replacementAdmission",
            "writerAdmission",
            "snapshot",
            "backup",
        ] {
            assert_eq!(value[key].as_object().unwrap().len(), 3);
            assert!(value[key]["maxMs"].is_number());
        }
        assert_eq!(value["startup"].as_object().unwrap().len(), 15);
        for key in [
            "setup",
            "storeOpen",
            "recoveryInspection",
            "inspectionQuickCheck",
            "inspectionForeignKeys",
            "recoveryMigration",
            "recoveryFinalIntegrity",
            "registrationWait",
            "workerQueue",
            "inspectionOpen",
            "inspectionConfigure",
            "inspectionSchema",
            "inspectionPagerRead",
        ] {
            assert_eq!(value["startup"][key].as_object().unwrap().len(), 3);
            assert!(value["startup"][key]["maxMs"].is_number());
        }
    }

    #[test]
    fn archive_phase_callers_are_fixed_numeric_and_restore_after_unwind() {
        let before = ARCHIVE_COUNTERS[ArchiveCaller::OpenHandoff as usize]
            [ArchivePhase::DomainWalk as usize]
            .snapshot()
            .count;
        {
            let _outer = archive_caller(ArchiveCaller::OpenHandoff);
            let _ = std::panic::catch_unwind(|| {
                let _inner = archive_caller(ArchiveCaller::Activate);
                let _phase = archive_measure(ArchivePhase::QuickCheck);
                panic!("controlled diagnostic-only unwind");
            });
            let _phase = archive_measure(ArchivePhase::DomainWalk);
        }
        assert!(
            ARCHIVE_COUNTERS[ArchiveCaller::OpenHandoff as usize]
                [ArchivePhase::DomainWalk as usize]
                .snapshot()
                .count
                > before
        );
        assert!(matches!(
            ARCHIVE_CALLER.with(std::cell::Cell::get),
            ArchiveCaller::Other
        ));
        let value = serde_json::to_value(snapshot()).unwrap();
        let archive = &value["startup"]["archive"];
        assert_eq!(archive.as_object().unwrap().len(), 6);
        for caller in [
            "recoveryHandoff",
            "openHandoff",
            "activate",
            "openLocked",
            "other",
        ] {
            assert_eq!(archive[caller].as_object().unwrap().len(), 7);
            for sample in archive[caller].as_object().unwrap().values() {
                assert_eq!(sample.as_object().unwrap().len(), 3);
                assert!(sample
                    .as_object()
                    .unwrap()
                    .values()
                    .all(serde_json::Value::is_number));
            }
        }
        assert!(!serde_json::to_string(&value)
            .unwrap()
            .contains("diagnostic-only"));
    }

    #[test]
    fn pager_samples_are_coherent_bounded_numeric_metadata_only() {
        let value =
            serde_json::to_value(pager_sample(-8192, 134217728, 40, 4096, 3).unwrap()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 8);
        assert_eq!(value["cacheSizePagesOrKib"], -8192);
        assert!(value
            .as_object()
            .unwrap()
            .iter()
            .all(|(key, field)| key == "finalMmapBytes" && field.is_null() || field.is_number()));
        assert!(pager_sample(i64::MIN, -1, 4, 0, 5).is_none());
        assert_eq!(value["mmapBytes"], 134217728);
        assert_eq!(value["pageCount"], 40);
        assert_eq!(value["pageSizeBytes"], 4096);
        assert_eq!(value["freelistPages"], 3);
    }

    #[test]
    fn final_mmap_preserves_initial_sample_and_rejects_obsolete_or_invalid_results() {
        let mut initial = pager_sample(-8192, 134217728, 40, 4096, 3).unwrap();
        initial.samples = 4;
        let mut sample = Some(initial);
        finish_pager(&mut sample, 3, 0);
        finish_pager(&mut sample, 4, -1);
        assert!(sample.unwrap().final_mmap_bytes.is_none());
        finish_pager(&mut sample, 4, 0);
        assert_eq!(sample.unwrap().final_mmap_bytes, Some(0));
        assert_eq!(sample.unwrap().mmap_bytes, 134217728);
    }

    #[test]
    fn scoped_measurement_records_early_error_and_unwind_without_payload() {
        let before = COUNTERS[Stage::Setup as usize].snapshot().count;
        let reject = || -> Result<(), &'static str> {
            let _scope = measure(Stage::Setup);
            Err("private fixture payload must never be captured")
        };
        let rejected = reject();
        assert!(rejected.is_err());
        let unwound = std::panic::catch_unwind(|| {
            let _scope = measure(Stage::Setup);
            panic!("controlled unwind");
        });
        assert!(unwound.is_err());
        let sample = COUNTERS[Stage::Setup as usize].snapshot();
        assert!(sample.count >= before + 2);
        assert!(sample.total_ms.is_finite() && sample.max_ms.is_finite());
        let encoded = serde_json::to_string(&snapshot()).unwrap();
        assert!(!encoded.contains("private fixture"));
        assert!(!encoded.contains("controlled unwind"));
    }
}
