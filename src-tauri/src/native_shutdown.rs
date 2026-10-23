//! Independent owners always settle; an earlier failure is not permission to skip cleanup.
use crate::close_owner::CleanupResult;
use std::future::Future;
use tokio::sync::oneshot;

/// A preparation deadline permits native shutdown to start; it never cancels
/// the original renderer acknowledgment or reports its cleanup as completed.
pub(crate) enum PreparedFrontend {
    Settled(Result<CleanupResult, oneshot::error::RecvError>),
    Pending(oneshot::Receiver<CleanupResult>),
}
impl PreparedFrontend {
    pub(crate) async fn settled(self) -> Result<CleanupResult, oneshot::error::RecvError> {
        match self {
            Self::Settled(result) => result,
            Self::Pending(acknowledgment) => acknowledgment.await,
        }
    }
}
pub(crate) async fn prepare_frontend(
    mut acknowledgment: oneshot::Receiver<CleanupResult>,
    emitted: bool,
    preparation_deadline: impl Future<Output = ()>,
) -> PreparedFrontend {
    if !emitted {
        // No waiter is spawned. join_cleanup handles failed event delivery and
        // disposes this receiver without claiming an acknowledgment arrived.
        return PreparedFrontend::Pending(acknowledgment);
    }
    tokio::select! {
        biased;
        result = &mut acknowledgment => PreparedFrontend::Settled(result),
        _ = preparation_deadline => PreparedFrontend::Pending(acknowledgment),
    }
}

pub(crate) async fn join_owned<R, S, C, L, G, D>(
    recovery: R,
    speech: S,
    casting: C,
    sharing: L,
    guides: G,
    drains: D,
) -> Result<(), &'static str>
where
    R: Future<Output = Result<(), &'static str>>,
    S: Future<Output = Result<(), &'static str>>,
    C: Future<Output = Result<(), &'static str>>,
    L: Future<Output = Result<(), &'static str>>,
    G: Future<Output = Result<(), &'static str>>,
    D: Future<Output = Result<(), &'static str>>,
{
    let (recovery, speech, casting, sharing, guides) =
        tokio::join!(recovery, speech, casting, sharing, guides);
    // Cleanup may admit final disposal-only work; inspect its actual ownership after all
    // subsystem producers settle, even when one of their results already failed.
    let drains = drains.await;
    for result in [recovery, speech, casting, sharing, guides, drains] {
        result?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{close_owner::WorkOwner, requests::Requests};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };

    #[tokio::test]
    async fn frontend_preparation_keeps_final_owned_save_admitted_until_exact_ack() {
        use crate::close_owner::{CleanupResult, CloseOwner};
        let owner = Arc::new(CloseOwner::default());
        let closing = Arc::new(AtomicBool::new(false));
        let work = Arc::new(WorkOwner::default());
        let save_guard = work.acquire();
        let mut attempt = owner.begin_retained().unwrap();
        let ticket = attempt.ticket.clone();
        let ack = attempt.acknowledgment.take().unwrap();
        let actual = owner.clone();
        let gate = closing.clone();
        let retained_work = work.clone();
        let retained_ticket = ticket.clone();
        let (entered, waiting) = oneshot::channel();
        let producer = tokio::spawn(async move {
            entered.send(()).unwrap();
            let prepared = prepare_frontend(ack, true, std::future::pending()).await;
            // This is the global closing/request-stop/native-shutdown boundary.
            gate.store(true, Ordering::SeqCst);
            let (native, _) = actual.native_drain().unwrap();
            retained_work.drained().await;
            native.complete(Ok(()));
            actual
                .join_cleanup(&retained_ticket, prepared.settled(), &native, true, || {})
                .await
                .unwrap();
        });
        waiting.await.unwrap();
        tokio::task::yield_now().await;
        assert!(!closing.load(Ordering::SeqCst));
        assert_eq!(work.count(), 1);
        assert!(!producer.is_finished());
        // An observation deadline/repeated close cannot revoke the save owner.
        owner.observation_deadline(&ticket);
        assert_eq!(owner.begin_retained().unwrap().ticket, ticket);
        assert!(!closing.load(Ordering::SeqCst));
        drop(save_guard);
        owner.acknowledge(&ticket, CleanupResult::Drained).unwrap();
        producer.await.unwrap();
        assert!(closing.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn preparation_deadline_starts_native_but_retains_original_late_ack_and_final_join() {
        use crate::close_owner::{CleanupResult, CloseOwner, CloseStage};
        let owner = Arc::new(CloseOwner::default());
        let mut attempt = owner.begin_retained().unwrap();
        let ticket = attempt.ticket.clone();
        let ack = attempt.acknowledgment.take().unwrap();
        let actual = owner.clone();
        let retained_ticket = ticket.clone();
        let (deadline, expires) = oneshot::channel();
        let (native_started, started) = oneshot::channel();
        let producer = tokio::spawn(async move {
            let prepared = prepare_frontend(ack, true, async { expires.await.unwrap() }).await;
            let (native, _) = actual.native_drain().unwrap();
            native.complete(Ok(()));
            native_started.send(()).unwrap();
            actual
                .join_cleanup(&retained_ticket, prepared.settled(), &native, true, || {})
                .await
                .unwrap();
            actual.settle(&retained_ticket, Ok(()), None);
        });
        deadline.send(()).unwrap();
        started.await.unwrap();
        tokio::task::yield_now().await;
        assert!(!producer.is_finished());
        assert_eq!(owner.snapshot(&ticket).unwrap().stage, CloseStage::Frontend);
        assert!(!owner.snapshot(&ticket).unwrap().frontend_settled);
        assert!(owner.snapshot(&ticket).unwrap().native_settled);
        let retry = owner.begin_retained().unwrap();
        assert_eq!(retry.ticket, ticket);
        assert!(retry.acknowledgment.is_none());
        owner.acknowledge(&ticket, CleanupResult::Drained).unwrap();
        producer.await.unwrap();
        assert_eq!(owner.snapshot(&ticket).unwrap().stage, CloseStage::Settled);
    }

    #[tokio::test]
    async fn failed_ack_starts_native_immediately_and_waits_actual_native_result() {
        use crate::close_owner::{CleanupResult, CloseOwner, CloseReason};
        let owner = Arc::new(CloseOwner::default());
        let mut attempt = owner.begin_retained().unwrap();
        let ticket = attempt.ticket.clone();
        let ack = attempt.acknowledgment.take().unwrap();
        owner.acknowledge(&ticket, CleanupResult::Failed).unwrap();
        let prepared = prepare_frontend(ack, true, std::future::pending()).await;
        assert!(matches!(
            &prepared,
            PreparedFrontend::Settled(Ok(CleanupResult::Failed))
        ));
        let (native, _) = owner.native_drain().unwrap();
        let pending_native = native.clone();
        let actual = owner.clone();
        let (joined, observed) = oneshot::channel();
        let producer = tokio::spawn(async move {
            joined.send(()).unwrap();
            actual
                .join_cleanup(&ticket, prepared.settled(), &pending_native, true, || {})
                .await
        });
        observed.await.unwrap();
        tokio::task::yield_now().await;
        assert!(!producer.is_finished());
        native.complete(Ok(()));
        assert_eq!(
            producer.await.unwrap(),
            Err(("frontend-cleanup-failed", CloseReason::FrontendFailed))
        );
    }

    #[tokio::test]
    async fn lost_ack_and_unavailable_event_do_not_wait_preparation_or_leave_ack_task() {
        use crate::close_owner::{CleanupResult, CloseOwner, CloseReason};
        let (sender, ack) = oneshot::channel::<CleanupResult>();
        drop(sender);
        let prepared = prepare_frontend(ack, true, async {
            panic!("lost ACK must start native cleanup first")
        })
        .await;
        assert!(matches!(&prepared, PreparedFrontend::Settled(Err(_))));
        assert!(prepared.settled().await.is_err());

        let owner = CloseOwner::default();
        let attempt = owner.begin_retained().unwrap();
        let (sender, ack) = oneshot::channel::<CleanupResult>();
        let prepared = prepare_frontend(ack, false, async {
            panic!("unavailable event must start native cleanup immediately")
        })
        .await;
        let (native, _) = owner.native_drain().unwrap();
        native.complete(Ok(()));
        assert_eq!(
            owner
                .join_cleanup(&attempt.ticket, prepared.settled(), &native, false, || {})
                .await,
            Err(("cleanup-event-unavailable", CloseReason::EventUnavailable))
        );
        // Receiver is owned by the real joined operation, never a spawned waiter.
        assert!(sender.is_closed());
    }

    #[tokio::test]
    async fn failed_first_owner_starts_all_and_held_owner_prevents_settlement() {
        let started = Arc::new(AtomicUsize::new(0));
        let drained = Arc::new(AtomicUsize::new(0));
        let (release, receive) = tokio::sync::oneshot::channel();
        let (all_started, observed) = tokio::sync::oneshot::channel();
        let started_signal = std::sync::Mutex::new(Some(all_started));
        let counter = started.clone();
        let drain_counter = drained.clone();
        let work = tokio::spawn(async move {
            let start = || {
                if counter.fetch_add(1, Ordering::SeqCst) == 4 {
                    started_signal
                        .lock()
                        .unwrap()
                        .take()
                        .unwrap()
                        .send(())
                        .unwrap();
                }
            };
            let one = || async {
                start();
                Ok(())
            };
            join_owned(
                async {
                    start();
                    Err("storage-recovery-stop-unconfirmed")
                },
                one(),
                async {
                    start();
                    receive.await.unwrap();
                    Ok(())
                },
                one(),
                one(),
                async {
                    drain_counter.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), observed)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(started.load(Ordering::SeqCst), 5);
        assert_eq!(drained.load(Ordering::SeqCst), 0);
        assert!(!work.is_finished());
        release.send(()).unwrap();
        assert_eq!(
            work.await.unwrap(),
            Err("storage-recovery-stop-unconfirmed")
        );
        assert_eq!(drained.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failed_subsystem_still_joins_real_request_receiver_and_native_work_guard() {
        let mut requests = Requests::default();
        let receiver = requests.register("held-request".into()).unwrap();
        requests.stop();
        let request_drain = requests.drain_owner();
        let native_work = Arc::new(WorkOwner::default());
        let guard = native_work.acquire();
        let (entered, waiting) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            join_owned(
                async { Ok(()) },
                async { Err("speech-stop-unconfirmed") },
                async { Ok(()) },
                async { Ok(()) },
                async { Ok(()) },
                async move {
                    entered.send(()).unwrap();
                    tokio::join!(request_drain.drained(), native_work.drained());
                    Ok(())
                },
            )
            .await
        });
        waiting.await.unwrap();
        assert!(!task.is_finished());
        drop(receiver);
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        drop(guard);
        assert_eq!(task.await.unwrap(), Err("speech-stop-unconfirmed"));
    }

    #[tokio::test]
    async fn fixed_failure_priority_is_preserved_after_every_owner_and_drain_runs() {
        assert_eq!(
            join_owned(
                async { Ok(()) },
                async { Err("speech-stop-unconfirmed") },
                async { Err("cast-stop-unconfirmed") },
                async { Err("lan-stop-unconfirmed") },
                async { Err("guide-owner-lock") },
                async { Err("request-lock") }
            )
            .await,
            Err("speech-stop-unconfirmed")
        );
        assert_eq!(
            join_owned(
                async { Ok(()) },
                async { Ok(()) },
                async { Ok(()) },
                async { Ok(()) },
                async { Ok(()) },
                async { Err("request-lock") }
            )
            .await,
            Err("request-lock")
        );
    }
}
