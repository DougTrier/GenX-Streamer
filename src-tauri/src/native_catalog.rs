//! Off-thread indexed reads retain their actual native work until SQLite settles.
use crate::{catalog_query, NativeState};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::{
    collections::{HashMap, HashSet},
    sync::{atomic::AtomicU64, Mutex, OnceLock},
};
use tauri::Manager;
#[derive(Default)]
struct Observation {
    stages: HashMap<String, &'static str>,
    cancel_accepted: u64,
    canceled: HashSet<String>,
    totals: Totals,
}
#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Totals {
    received: u64,
    admitted: u64,
    rejected: u64,
    completed: u64,
    succeeded: u64,
    canceled: u64,
    failed: u64,
    abandoned: u64,
}
static OBSERVATION: OnceLock<Mutex<Observation>> = OnceLock::new();
static PROGRESS_CALLBACKS: AtomicU64 = AtomicU64::new(0);
fn observation() -> &'static Mutex<Observation> {
    OBSERVATION.get_or_init(|| Mutex::new(Observation::default()))
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservationSnapshot {
    #[serde(flatten)]
    pub totals: Totals,
    pub stages: HashMap<&'static str, usize>,
    pub cancel_accepted: u64,
    pub cancel_accepted_pending: usize,
    pub progress_callbacks: u64,
}
pub(crate) fn snapshot() -> ObservationSnapshot {
    let mut result = ObservationSnapshot {
        totals: Totals::default(),
        stages: HashMap::new(),
        cancel_accepted: 0,
        cancel_accepted_pending: 0,
        progress_callbacks: PROGRESS_CALLBACKS.load(Ordering::Relaxed),
    };
    if let Ok(o) = observation().lock() {
        for stage in o.stages.values() {
            *result.stages.entry(*stage).or_default() += 1;
        }
        result.cancel_accepted = o.cancel_accepted;
        result.cancel_accepted_pending = o.canceled.len();
        result.totals = o.totals.clone();
    }
    result
}
#[tauri::command]
pub(crate) fn query_cancellation_snapshot() -> ObservationSnapshot {
    snapshot()
}
pub(crate) fn observe_stage(id: &str, stage: &'static str) {
    if let Ok(mut o) = observation().lock() {
        if let Some(value) = o.stages.get_mut(id) {
            *value = stage;
        }
    }
}
pub(crate) fn observe_progress() {
    let _ = PROGRESS_CALLBACKS.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        Some(value.saturating_add(1))
    });
}
struct Observed {
    id: String,
    admitted: bool,
    completed: bool,
}
impl Observed {
    fn new(id: String) -> Self {
        if let Ok(mut o) = observation().lock() {
            o.totals.received = o.totals.received.saturating_add(1);
            if o.stages.len() < 24 {
                o.stages.insert(id.clone(), "command-enter");
            }
        }
        Self {
            id,
            admitted: false,
            completed: false,
        }
    }
    fn admitted(&mut self) {
        self.admitted = true;
        if let Ok(mut o) = observation().lock() {
            o.totals.admitted = o.totals.admitted.saturating_add(1);
        }
        observe_stage(&self.id, "registered");
    }
    fn completed<T>(&mut self, result: &Result<T, String>) {
        self.completed = true;
        if let Ok(mut o) = observation().lock() {
            o.totals.completed = o.totals.completed.saturating_add(1);
            let count = match result {
                Ok(_) => &mut o.totals.succeeded,
                Err(e) if e == "canceled" || e == "catalog-query-cancelled" => {
                    &mut o.totals.canceled
                }
                Err(_) => &mut o.totals.failed,
            };
            *count = count.saturating_add(1);
        }
    }
}
impl Drop for Observed {
    fn drop(&mut self) {
        if let Ok(mut o) = observation().lock() {
            o.stages.remove(&self.id);
            o.canceled.remove(&self.id);
            if !self.admitted {
                o.totals.rejected = o.totals.rejected.saturating_add(1);
            } else if !self.completed {
                o.totals.abandoned = o.totals.abandoned.saturating_add(1);
            }
        }
    }
}

async fn join_query<T, E>(
    mut worker: impl std::future::Future<Output = Result<Result<T, String>, E>> + Unpin,
    mut cancellation: impl std::future::Future + Unpin,
    flag: Arc<AtomicBool>,
) -> Result<T, String> {
    tokio::select! {
        result = &mut worker => result.map_err(|_| "catalog-query-worker-failed".to_string())?,
        _ = &mut cancellation => {
            flag.store(true, Ordering::SeqCst);
            // Signaling cancellation is not permission to detach a live SQLite worker.
            let _ = worker.await;
            Err("canceled".into())
        }
    }
}

#[tauri::command]
pub(crate) async fn query_catalog_page(
    query: catalog_query::Query,
    app: tauri::AppHandle,
) -> Result<catalog_query::Page, String> {
    let mut observed = Observed::new(query.request_id.clone());
    let state = app.state::<NativeState>();
    let work = state.admit_work()?;
    let id = query.request_id.clone();
    let mut cancellation = state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .register(id.clone())?;
    observed.admitted();
    let observed_id = id.clone();
    let flag = Arc::new(AtomicBool::new(false));
    let worker_flag = flag.clone();
    let store = state.store.clone();
    let closing = state.closing.clone();
    let worker = tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        observe_stage(&observed_id, "worker-enter");
        if worker_flag.load(Ordering::SeqCst) || closing.load(Ordering::SeqCst) {
            return Err("canceled".into());
        }
        observe_stage(&observed_id, "store-admission");
        let current = store.read().map_err(|_| "storage-lock")?;
        if worker_flag.load(Ordering::SeqCst) || closing.load(Ordering::SeqCst) {
            return Err("canceled".into());
        }
        observe_stage(&observed_id, "opening-read");
        let result = current
            .as_ref()
            .map_err(Clone::clone)?
            .query_catalog_page(&query, &worker_flag);
        observe_stage(&observed_id, "sql-end");
        if worker_flag.load(Ordering::SeqCst) || closing.load(Ordering::SeqCst) {
            return Err("canceled".into());
        }
        result
    });
    let result = join_query(worker, &mut cancellation, flag).await;
    observe_stage(&id, "worker-joined");
    state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .finish(&id);
    observed.completed(&result);
    drop(observed);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_exposes_only_aggregate_stages_and_releases_finished_owner() {
        let id = "private-observation-fixture";
        let observed = Observed::new(id.into());
        observe_stage(id, "opening-read");
        let encoded = serde_json::to_string(&snapshot()).unwrap();
        assert!(encoded.contains("opening-read"));
        assert!(!encoded.contains(id));
        drop(observed);
        assert!(!observation().lock().unwrap().stages.contains_key(id));
    }
    #[test]
    fn observation_classifies_admission_and_fixed_terminal_outcomes() {
        let mut observed = Observed::new("private-completed-fixture".into());
        observed.admitted();
        observed.completed(&Err::<(), String>("canceled".into()));
        assert!(observed.admitted && observed.completed);
        let totals = snapshot().totals;
        assert!(
            totals.received > 0
                && totals.admitted > 0
                && totals.completed > 0
                && totals.canceled > 0
        );
        let encoded = serde_json::to_string(&snapshot()).unwrap();
        assert!(!encoded.contains("private-completed-fixture"));
    }

    #[tokio::test]
    async fn cancellation_keeps_actual_worker_and_close_owner_until_settled() {
        let owner = Arc::new(crate::close_owner::WorkOwner::default());
        let lease = owner.acquire();
        let flag = Arc::new(AtomicBool::new(false));
        let (release, held) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            let _lease = lease;
            let _ = held.await;
            Ok::<_, String>(17)
        });
        let (cancel, cancellation) = tokio::sync::oneshot::channel();
        let joined = tokio::spawn(join_query(worker, cancellation, flag.clone()));
        cancel.send(()).unwrap();
        tokio::task::yield_now().await;
        assert!(flag.load(Ordering::SeqCst));
        assert!(!joined.is_finished());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), owner.drained())
                .await
                .is_err()
        );
        release.send(()).unwrap();
        assert_eq!(joined.await.unwrap().unwrap_err(), "canceled");
        tokio::time::timeout(std::time::Duration::from_secs(1), owner.drained())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn worker_failure_is_redacted_after_actual_settlement() {
        let flag = Arc::new(AtomicBool::new(false));
        let worker = tokio::spawn(async {
            panic!("private worker failure");
            #[allow(unreachable_code)]
            Ok::<i32, String>(0)
        });
        let (_sender, cancellation) = tokio::sync::oneshot::channel::<()>();
        assert_eq!(
            join_query(worker, cancellation, flag).await.unwrap_err(),
            "catalog-query-worker-failed"
        );
    }
}

#[tauri::command]
pub(crate) fn cancel_catalog_query(
    request_id: String,
    state: tauri::State<'_, NativeState>,
) -> Result<(), String> {
    let result = state
        .requests
        .lock()
        .map_err(|_| "request-lock")?
        .cancel(request_id.clone());
    if result.is_ok() {
        if let Ok(mut o) = observation().lock() {
            o.cancel_accepted = o.cancel_accepted.saturating_add(1);
            if o.stages.contains_key(&request_id) {
                o.canceled.insert(request_id);
            }
        }
    }
    result
}
