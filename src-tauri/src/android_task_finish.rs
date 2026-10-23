//! Acknowledges an owned Activity's finish request, not its destruction or process absence.
use crate::close_owner::{NativeDrain, WorkGuard};
use serde::Deserialize;
use std::{future::Future, sync::Arc};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinishReceipt {
    schema_version: u8,
    adapter_version: String,
    platform: String,
    request_accepted: bool,
    activity_finishing: bool,
    task_root: bool,
}
impl FinishReceipt {
    pub fn validate(self) -> Result<(), &'static str> {
        if self.schema_version != 1
            || self.adapter_version != "activity-finish-v1"
            || self.platform != "android"
            || !self.request_accepted
            || !self.activity_finishing
            || !self.task_root
        {
            return Err("activity-finish-unconfirmed");
        }
        Ok(())
    }
}
pub fn start_owned<F, C>(drain: Arc<NativeDrain>, work: WorkGuard, operation: F, accepted: C)
where
    F: Future<Output = Result<FinishReceipt, &'static str>> + Send + 'static,
    C: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        let result = operation.await.and_then(FinishReceipt::validate);
        // Publish settlement only after the actual native operation and work guard finish.
        drop(work);
        drain.complete(result);
        if result.is_ok() {
            accepted.await;
        }
    });
}
#[cfg(target_os = "android")]
pub async fn request(app: tauri::AppHandle) -> Result<FinishReceipt, &'static str> {
    use tauri::Manager;
    app.state::<crate::AndroidViewing>()
        .0
        .run_mobile_plugin_async::<FinishReceipt>("finishOwnedTask", serde_json::json!({}))
        .await
        .map_err(|_| "activity-finish-unconfirmed")
}
/// LX06 (docs/lifecycle-media-invariants.md): GenX's Android process may be
/// ended only after closing began, every owned request and work item drained,
/// and this exact close attempt accepted the Activity exit (once). `end` runs
/// at most once and never before those hold; returns whether it ran.
#[cfg(any(target_os = "android", test))]
pub async fn end_after_drain<E, F>(
    closing: &std::sync::atomic::AtomicBool,
    close: &crate::close_owner::CloseOwner,
    ticket: &crate::close_owner::CloseTicket,
    requests: Arc<crate::close_owner::WorkOwner>,
    work: &crate::close_owner::WorkOwner,
    end: E,
) -> bool
where
    E: FnOnce() -> F,
    F: Future<Output = ()>,
{
    tokio::join!(requests.drained(), work.drained());
    if !closing.load(std::sync::atomic::Ordering::SeqCst) || !close.accept_activity_exit(ticket) {
        return false;
    }
    end().await;
    true
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::close_owner::{CloseOwner, WorkOwner};
    fn receipt() -> FinishReceipt {
        serde_json::from_str(r#"{"schemaVersion":1,"adapterVersion":"activity-finish-v1","platform":"android","requestAccepted":true,"activityFinishing":true,"taskRoot":true}"#).unwrap()
    }
    #[test]
    fn receipt_requires_all_actual_ack_fields() {
        receipt().validate().unwrap();
        for key in ["requestAccepted", "activityFinishing", "taskRoot"] {
            let mut value=serde_json::to_value(serde_json::json!({"schemaVersion":1,"adapterVersion":"activity-finish-v1","platform":"android","requestAccepted":true,"activityFinishing":true,"taskRoot":true})).unwrap();
            value[key] = false.into();
            assert_eq!(
                serde_json::from_value::<FinishReceipt>(value)
                    .unwrap()
                    .validate(),
                Err("activity-finish-unconfirmed")
            );
        }
    }
    #[tokio::test]
    async fn timeout_retry_and_duplicate_close_retain_one_actual_late_ack() {
        let close = CloseOwner::default();
        let work = Arc::new(WorkOwner::default());
        let (release, receive) = tokio::sync::oneshot::channel();
        let (drain, start) = close.activity_drain().unwrap();
        assert!(start);
        let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let actual = accepted.clone();
        start_owned(
            drain.clone(),
            work.acquire(),
            async move {
                receive.await.unwrap();
                Ok(receipt())
            },
            async move {
                actual.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            },
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(5), drain.settled())
                .await
                .is_err()
        );
        assert_eq!(work.count(), 1);
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 0);
        let (retry, start) = close.activity_drain().unwrap();
        assert!(!start);
        assert!(Arc::ptr_eq(&drain, &retry));
        release.send(()).unwrap();
        retry.settled().await.unwrap();
        assert_eq!(work.count(), 0);
        let (duplicate, start) = close.activity_drain().unwrap();
        assert!(!start);
        duplicate.settled().await.unwrap();
        tokio::task::yield_now().await;
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn failed_request_is_unconfirmed_and_retry_gets_fresh_owner() {
        let close = CloseOwner::default();
        let work = Arc::new(WorkOwner::default());
        let (drain, _) = close.activity_drain().unwrap();
        start_owned(
            drain.clone(),
            work.acquire(),
            async { Err("activity-finish-unconfirmed") },
            async { panic!("unconfirmed finish must never exit") },
        );
        assert_eq!(drain.settled().await, Err("activity-finish-unconfirmed"));
        assert_eq!(work.count(), 0);
        let (retry, start) = close.activity_drain().unwrap();
        assert!(start);
        assert!(!Arc::ptr_eq(&drain, &retry));
        start_owned(
            retry.clone(),
            work.acquire(),
            async { Ok(receipt()) },
            async {},
        );
        retry.settled().await.unwrap();
    }
    #[test]
    fn stale_generation_and_duplicate_exit_are_refused() {
        let close = CloseOwner::default();
        let (old, _) = close.begin().unwrap().unwrap();
        close.finish(&old);
        let (current, _) = close.begin().unwrap().unwrap();
        assert!(!close.accept_activity_exit(&old));
        assert!(close.accept_activity_exit(&current));
        assert!(!close.accept_activity_exit(&current));
    }

    #[tokio::test]
    async fn the_process_ends_only_after_every_owned_operation_drains_lx06() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let close = CloseOwner::default();
        let (ticket, _) = close.begin().unwrap().unwrap();
        let closing = AtomicBool::new(true);
        let requests = Arc::new(WorkOwner::default());
        let work = Arc::new(WorkOwner::default());
        let pending_request = requests.acquire();
        let pending_work = work.acquire();
        let ended = AtomicUsize::new(0);
        let gate = end_after_drain(&closing, &close, &ticket, requests.clone(), &work, || async {
            ended.fetch_add(1, Ordering::SeqCst);
        });
        tokio::pin!(gate);
        // Negative: with owned work outstanding the process is never ended.
        let wait = std::time::Duration::from_millis(50);
        assert!(tokio::time::timeout(wait, gate.as_mut()).await.is_err());
        drop(pending_request);
        assert!(tokio::time::timeout(wait, gate.as_mut()).await.is_err());
        assert_eq!(ended.load(Ordering::SeqCst), 0);
        drop(pending_work);
        assert!(gate.await);
        assert_eq!(ended.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn no_close_or_a_stale_or_repeated_ticket_never_ends_the_process_lx06() {
        let close = CloseOwner::default();
        let (old, _) = close.begin().unwrap().unwrap();
        close.finish(&old);
        let (current, _) = close.begin().unwrap().unwrap();
        let requests = Arc::new(WorkOwner::default());
        let work = WorkOwner::default();
        let refuse = || async { panic!("must not end the process") };
        let not_closing = std::sync::atomic::AtomicBool::new(false);
        assert!(!end_after_drain(&not_closing, &close, &current, requests.clone(), &work, refuse).await);
        let closing = std::sync::atomic::AtomicBool::new(true);
        assert!(!end_after_drain(&closing, &close, &old, requests.clone(), &work, refuse).await);
        assert!(end_after_drain(&closing, &close, &current, requests.clone(), &work, || async {}).await);
        // Repeated exit requests cannot end it twice (LX03).
        assert!(!end_after_drain(&closing, &close, &current, requests, &work, refuse).await);
    }
}
