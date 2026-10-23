//! Passive first-startup timestamps. Origin is Rust run(), not OS process/Java entry.
//! ReplyValueReady precedes Tauri serialization and does not claim host delivery.
//! ReadPairSnapshot brackets StoreOwner::read_initial: root-read lease, SQL
//! snapshot and canonical record encoding, not SQL execution alone.
use serde::Serialize;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

#[derive(Clone, Copy)]
pub(crate) enum Event {
    RunEntry,
    SetupEntry,
    RootSelected,
    StateManaged,
    StartupAdmitted,
    RegistrationWaitStarted,
    RegistrationWaitFinished,
    WorkerQueued,
    WorkerStarted,
    StoreOpenStarted,
    StoreOpenFinished,
    StoreInstallStarted,
    StoreInstallFinished,
    StartupWorkerFinished,
    SetupFinished,
    ReadPairEntered,
    ReadPairStartupJoined,
    ReadPairWorkerQueued,
    ReadPairWorkerStarted,
    ReadPairSnapshotStarted,
    ReadPairSnapshotFinished,
    ReadPairReplyValueReady,
}
const NAMES: [&str; 22] = [
    "run-entry",
    "setup-entry",
    "root-selected",
    "state-managed",
    "startup-admitted",
    "registration-wait-started",
    "registration-wait-finished",
    "worker-queued",
    "worker-started",
    "store-open-started",
    "store-open-finished",
    "store-install-started",
    "store-install-finished",
    "startup-worker-finished",
    "setup-finished",
    "read-pair-entered",
    "read-pair-startup-joined",
    "read-pair-worker-queued",
    "read-pair-worker-started",
    "read-pair-snapshot-started",
    "read-pair-snapshot-finished",
    "read-pair-reply-value-ready",
];
// A separate command preserves the original 22-slot startup wire contract.
#[derive(Clone, Copy)]
#[allow(
    dead_code,
    reason = "Fixed cross-platform slots retain null markers for platform-specific work."
)]
pub(crate) enum RootEvent {
    AppDataDirStarted,
    AppDataDirFinished,
    DiagnosticsReady,
    WindowsBookmarksStarted,
    WindowsBookmarksFinished,
    CanonicalizationStarted,
    CanonicalizationFinished,
    PolicyStarted,
    PolicyFinished,
    TargetInspectionStarted,
    TargetInspectionFinished,
}
const ROOT_NAMES: [&str; 11] = [
    "app-data-dir-started",
    "app-data-dir-finished",
    "diagnostics-ready",
    "windows-bookmarks-started",
    "windows-bookmarks-finished",
    "platform-canonicalization-started",
    "platform-canonicalization-finished",
    "root-policy-started",
    "root-policy-finished",
    "target-inspection-started",
    "target-inspection-finished",
];
const MAX_MICROS: u64 = 9_007_199_254_740_991;
#[derive(Clone, Copy, Serialize, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
enum Outcome {
    Succeeded,
    Failed,
}
struct State {
    at: [Option<u64>; 22],
    results: [Option<Outcome>; 22],
    last: u64,
    ignored_marks: u64,
    pair_claimed: bool,
    pair_outcome: Option<Outcome>,
    root_at: [Option<u64>; 11],
    root_results: [Option<Outcome>; 11],
    root_ignored: u64,
}
struct Recorder {
    origin: Instant,
    state: Mutex<State>,
}
impl Recorder {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
            state: Mutex::new(State {
                at: [None; 22],
                results: [None; 22],
                last: 0,
                ignored_marks: 0,
                pair_claimed: false,
                pair_outcome: None,
                root_at: [None; 11],
                root_results: [None; 11],
                root_ignored: 0,
            }),
        }
    }
    fn elapsed(&self) -> u64 {
        self.origin.elapsed().as_micros().min(MAX_MICROS as u128) as u64
    }
    fn mark_at(&self, event: Event, at: u64) {
        self.record(event, at, None);
    }
    fn record(&self, event: Event, at: u64, result: Option<Outcome>) {
        if let Ok(mut state) = self.state.lock() {
            state.last = state.last.max(at.min(MAX_MICROS));
            let index = event as usize;
            if state.at[index].is_none() {
                state.at[index] = Some(state.last);
                state.results[index] = result;
            } else {
                state.ignored_marks = state.ignored_marks.saturating_add(1).min(MAX_MICROS);
            }
        }
    }
    fn mark(&self, event: Event) {
        self.mark_at(event, self.elapsed());
    }
    fn result(&self, event: Event, succeeded: bool) {
        self.record(
            event,
            self.elapsed(),
            Some(if succeeded {
                Outcome::Succeeded
            } else {
                Outcome::Failed
            }),
        );
    }
    fn claim_pair(self: &Arc<Self>) -> FirstRead {
        let claimed = if let Ok(mut state) = self.state.lock() {
            if state.pair_claimed {
                false
            } else {
                state.pair_claimed = true;
                true
            }
        } else {
            false
        };
        let trace = FirstRead {
            recorder: claimed.then(|| self.clone()),
        };
        trace.mark(Event::ReadPairEntered);
        trace
    }
    fn root_mark(&self, event: RootEvent, result: Option<Outcome>) {
        self.root_record(event, self.elapsed(), result);
    }
    fn root_record(&self, event: RootEvent, at: u64, result: Option<Outcome>) {
        if let Ok(mut state) = self.state.lock() {
            state.last = state.last.max(at.min(MAX_MICROS));
            let index = event as usize;
            if state.root_at[index].is_none() {
                state.root_at[index] = Some(state.last);
                state.root_results[index] = result;
            } else {
                state.root_ignored = state.root_ignored.saturating_add(1).min(MAX_MICROS);
            }
        }
    }
    fn observe_root<T, E>(
        &self,
        start: RootEvent,
        finish: RootEvent,
        operation: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        self.root_mark(start, None);
        let result = operation();
        self.root_mark(
            finish,
            Some(if result.is_ok() {
                Outcome::Succeeded
            } else {
                Outcome::Failed
            }),
        );
        result
    }
    fn root_snapshot(&self) -> RootSnapshot {
        let before = self.elapsed();
        let captured = self.state.lock().ok().map(|state| {
            (
                state.root_at,
                state.root_results,
                state.last,
                state.root_ignored,
            )
        });
        let after = self.elapsed();
        match captured {
            Some((at, results, last, ignored)) => RootSnapshot {
                schema_version: 1,
                clock: "native-run-monotonic",
                available: true,
                sample_started_ms: Some(before as f64 / 1000.0),
                sample_finished_ms: Some(after.max(last) as f64 / 1000.0),
                ignored_marks: ignored,
                milestones: ROOT_NAMES
                    .iter()
                    .zip(at)
                    .zip(results)
                    .map(|((name, at), outcome)| Milestone {
                        name,
                        at_ms: at.map(|v| v as f64 / 1000.0),
                        outcome,
                    })
                    .collect(),
            },
            None => root_unavailable(),
        }
    }
    fn snapshot(&self) -> Snapshot {
        let before = self.elapsed();
        let captured = self.state.lock().ok().map(|state| {
            (
                state.at,
                state.results,
                state.last,
                state.ignored_marks,
                state.pair_claimed,
                state.pair_outcome,
            )
        });
        let after = self.elapsed();
        match captured {
            Some((at, results, last, ignored, claimed, outcome)) => Snapshot {
                schema_version: 1,
                clock: "native-run-monotonic",
                available: true,
                sample_started_ms: Some(before as f64 / 1000.0),
                sample_finished_ms: Some(after.max(last) as f64 / 1000.0),
                ignored_marks: ignored,
                first_read_claimed: claimed,
                first_read_outcome: outcome,
                milestones: NAMES
                    .iter()
                    .zip(at)
                    .zip(results)
                    .map(|((name, at), outcome)| Milestone {
                        name,
                        at_ms: at.map(|v| v as f64 / 1000.0),
                        outcome,
                    })
                    .collect(),
            },
            None => unavailable(),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Milestone {
    name: &'static str,
    at_ms: Option<f64>,
    outcome: Option<Outcome>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    schema_version: u8,
    clock: &'static str,
    available: bool,
    sample_started_ms: Option<f64>,
    sample_finished_ms: Option<f64>,
    ignored_marks: u64,
    first_read_claimed: bool,
    first_read_outcome: Option<Outcome>,
    milestones: Vec<Milestone>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RootSnapshot {
    schema_version: u8,
    clock: &'static str,
    available: bool,
    sample_started_ms: Option<f64>,
    sample_finished_ms: Option<f64>,
    ignored_marks: u64,
    milestones: Vec<Milestone>,
}
fn root_unavailable() -> RootSnapshot {
    RootSnapshot {
        schema_version: 1,
        clock: "native-run-monotonic",
        available: false,
        sample_started_ms: None,
        sample_finished_ms: None,
        ignored_marks: 0,
        milestones: ROOT_NAMES
            .iter()
            .map(|name| Milestone {
                name,
                at_ms: None,
                outcome: None,
            })
            .collect(),
    }
}
fn unavailable() -> Snapshot {
    Snapshot {
        schema_version: 1,
        clock: "native-run-monotonic",
        available: false,
        sample_started_ms: None,
        sample_finished_ms: None,
        ignored_marks: 0,
        first_read_claimed: false,
        first_read_outcome: None,
        milestones: NAMES
            .iter()
            .map(|name| Milestone {
                name,
                at_ms: None,
                outcome: None,
            })
            .collect(),
    }
}
static RECORDER: OnceLock<Arc<Recorder>> = OnceLock::new();
pub(crate) fn start() {
    RECORDER
        .get_or_init(|| Arc::new(Recorder::new()))
        .mark(Event::RunEntry);
}
pub(crate) fn mark(event: Event) {
    if let Some(recorder) = RECORDER.get() {
        recorder.mark(event);
    }
}
pub(crate) fn result(event: Event, succeeded: bool) {
    if let Some(recorder) = RECORDER.get() {
        recorder.result(event, succeeded);
    }
}
pub(crate) fn snapshot() -> Snapshot {
    RECORDER
        .get()
        .map(|r| r.snapshot())
        .unwrap_or_else(unavailable)
}
pub(crate) fn root_mark(event: RootEvent) {
    if let Some(recorder) = RECORDER.get() {
        recorder.root_mark(event, None);
    }
}
pub(crate) fn observe_root<T, E>(
    start: RootEvent,
    finish: RootEvent,
    operation: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    match RECORDER.get() {
        Some(recorder) => recorder.observe_root(start, finish, operation),
        None => operation(),
    }
}
pub(crate) fn root_snapshot() -> RootSnapshot {
    RECORDER
        .get()
        .map(|r| r.root_snapshot())
        .unwrap_or_else(root_unavailable)
}
#[derive(Clone)]
pub(crate) struct FirstRead {
    recorder: Option<Arc<Recorder>>,
}
impl FirstRead {
    pub(crate) fn mark(&self, event: Event) {
        if let Some(recorder) = &self.recorder {
            recorder.mark(event);
        }
    }
    pub(crate) fn result(&self, event: Event, succeeded: bool) {
        if let Some(recorder) = &self.recorder {
            recorder.result(event, succeeded);
        }
    }
    pub(crate) fn finish(&self, succeeded: bool) {
        if let Some(recorder) = &self.recorder {
            recorder.result(Event::ReadPairReplyValueReady, succeeded);
            if let Ok(mut state) = recorder.state.lock() {
                if state.pair_outcome.is_none() {
                    state.pair_outcome = Some(if succeeded {
                        Outcome::Succeeded
                    } else {
                        Outcome::Failed
                    });
                }
            }
        }
    }
}
pub(crate) fn first_read_pair() -> FirstRead {
    RECORDER
        .get()
        .map(|r| r.claim_pair())
        .unwrap_or(FirstRead { recorder: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_slots_first_mark_and_scalar_only_snapshot_are_bounded() {
        let recorder = Arc::new(Recorder::new());
        recorder.mark_at(Event::RunEntry, 10);
        recorder.mark_at(Event::RunEntry, 40);
        recorder.mark_at(Event::SetupEntry, 30);
        let state = recorder.state.lock().unwrap();
        assert_eq!(state.at[0], Some(10));
        assert_eq!(state.at[1], Some(40));
        assert_eq!(state.ignored_marks, 1);
        drop(state);
        let snapshot = recorder.snapshot();
        assert_eq!(snapshot.milestones.len(), 22);
        assert_eq!(snapshot.milestones[0].at_ms, Some(0.010));
        assert!(snapshot.milestones[2].at_ms.is_none());
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.len() < 2500);
        assert!(!json.contains("requestId") && !json.contains("path") && !json.contains("https:"));
    }
    #[test]
    fn concurrent_first_read_claim_is_single_and_later_calls_cannot_mix_events() {
        let recorder = Arc::new(Recorder::new());
        let claims: Vec<_> = (0..16)
            .map(|_| {
                let r = recorder.clone();
                std::thread::spawn(move || r.claim_pair())
            })
            .collect();
        let claims: Vec<_> = claims.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(claims.iter().filter(|c| c.recorder.is_some()).count(), 1);
        for claim in &claims {
            if claim.recorder.is_some() {
                claim.mark(Event::ReadPairSnapshotFinished);
                claim.finish(false);
            } else {
                claim.mark(Event::ReadPairWorkerStarted);
                claim.finish(true);
            }
        }
        let snapshot = recorder.snapshot();
        assert_eq!(snapshot.first_read_outcome, Some(Outcome::Failed));
        assert!(snapshot.milestones[Event::ReadPairWorkerStarted as usize]
            .at_ms
            .is_none());
        assert!(
            snapshot.milestones[Event::ReadPairSnapshotFinished as usize]
                .at_ms
                .is_some()
        );
    }
    #[test]
    fn losing_observer_does_not_finish_or_replace_original_first_read() {
        let recorder = Arc::new(Recorder::new());
        let observer = recorder.claim_pair();
        let worker = observer.clone();
        drop(observer);
        assert!(recorder.claim_pair().recorder.is_none());
        assert!(recorder.snapshot().first_read_outcome.is_none());
        worker.mark(Event::ReadPairSnapshotFinished);
        worker.finish(true);
        assert_eq!(
            recorder.snapshot().first_read_outcome,
            Some(Outcome::Succeeded)
        );
    }
    #[test]
    fn poisoned_observation_marks_and_claims_are_unavailable_without_panicking() {
        let recorder = Arc::new(Recorder::new());
        let poisoned = recorder.clone();
        let _ = std::panic::catch_unwind(move || {
            let _lock = poisoned.state.lock().unwrap();
            panic!("fixed observation failure");
        });
        recorder.mark(Event::StoreOpenStarted);
        assert!(!recorder.snapshot().available);
        assert!(recorder.claim_pair().recorder.is_none());
    }
}

#[cfg(test)]
mod root_tests {
    use super::*;
    #[test]
    fn root_clock_is_shared_and_original_twenty_two_slot_contract_stays_exact() {
        let r = Recorder::new();
        r.mark_at(Event::SetupEntry, 100);
        r.root_record(RootEvent::AppDataDirStarted, 200, None);
        r.root_record(RootEvent::AppDataDirFinished, 300, Some(Outcome::Succeeded));
        r.root_record(RootEvent::AppDataDirFinished, 400, Some(Outcome::Failed));
        r.mark_at(Event::RootSelected, 500);
        let old = r.snapshot();
        let root = r.root_snapshot();
        assert_eq!(root.clock, old.clock);
        assert_eq!(root.clock, "native-run-monotonic");
        assert_eq!(root.milestones.len(), 11);
        assert_eq!(root.ignored_marks, 1);
        assert_eq!(root.milestones[1].at_ms, Some(0.3));
        assert_eq!(root.milestones[1].outcome, Some(Outcome::Succeeded));
        assert_eq!(old.milestones.len(), 22);
        assert_eq!(old.ignored_marks, 0);
        assert_eq!(old.milestones[2].at_ms, Some(0.5));
        assert!(root.sample_finished_ms.unwrap() >= 0.5);
        let json = serde_json::to_value(&old).unwrap();
        let mut keys: Vec<_> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "available",
                "clock",
                "firstReadClaimed",
                "firstReadOutcome",
                "ignoredMarks",
                "milestones",
                "sampleFinishedMs",
                "sampleStartedMs",
                "schemaVersion"
            ]
        );
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(
            old.milestones.iter().map(|m| m.name).collect::<Vec<_>>(),
            NAMES
        );
        let encoded = serde_json::to_string(&root).unwrap();
        assert!(encoded.len() < 1800);
        assert!(
            !encoded.contains("path") && !encoded.contains("token") && !encoded.contains("https:")
        );
    }
    #[test]
    fn partial_failed_root_operation_returns_original_error_without_claiming_later_work() {
        let r = Recorder::new();
        let error = Box::new(String::from("synthetic-private-error-not-exported"));
        let pointer = (&*error) as *const String;
        let mut calls = 0;
        let actual = r
            .observe_root(
                RootEvent::AppDataDirStarted,
                RootEvent::AppDataDirFinished,
                || {
                    calls += 1;
                    Err::<(), _>(error)
                },
            )
            .unwrap_err();
        assert_eq!(calls, 1);
        assert_eq!((&*actual) as *const String, pointer);
        let snapshot = r.root_snapshot();
        assert_eq!(snapshot.milestones[1].outcome, Some(Outcome::Failed));
        assert!(snapshot
            .milestones
            .iter()
            .skip(2)
            .all(|m| m.at_ms.is_none()));
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains(actual.as_str()));
    }
    #[test]
    fn successful_root_operation_returns_owned_value_and_snapshots_are_detached() {
        let r = Recorder::new();
        let value = Box::new(42);
        let pointer = (&*value) as *const i32;
        let before = r.root_snapshot();
        let actual = r
            .observe_root(RootEvent::PolicyStarted, RootEvent::PolicyFinished, || {
                Ok::<_, ()>(value)
            })
            .unwrap();
        assert_eq!((&*actual) as *const i32, pointer);
        assert!(before.milestones.iter().all(|m| m.at_ms.is_none()));
        assert_eq!(
            r.root_snapshot().milestones[8].outcome,
            Some(Outcome::Succeeded)
        );
    }
    #[test]
    fn unavailable_or_poisoned_root_clock_has_no_invented_times_and_does_not_replace_result() {
        let unavailable = root_unavailable();
        assert_eq!(unavailable.clock, "native-run-monotonic");
        assert!(!unavailable.available);
        assert!(
            unavailable.sample_started_ms.is_none() && unavailable.sample_finished_ms.is_none()
        );
        assert!(unavailable
            .milestones
            .iter()
            .all(|m| m.at_ms.is_none() && m.outcome.is_none()));
        let r = Arc::new(Recorder::new());
        let poison = r.clone();
        let _ = std::panic::catch_unwind(move || {
            let _held = poison.state.lock().unwrap();
            panic!("fixed root observer fixture");
        });
        let mut calls = 0;
        let actual = r
            .observe_root(
                RootEvent::CanonicalizationStarted,
                RootEvent::CanonicalizationFinished,
                || {
                    calls += 1;
                    Ok::<_, ()>(Box::new(7))
                },
            )
            .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(*actual, 7);
        assert!(!r.root_snapshot().available);
    }
}
