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

use super::*;
use crate::close_owner::WorkOwner;
use std::{
    sync::{atomic::AtomicUsize, mpsc},
    time::Duration,
};
type Fixture = (
    tempfile::TempDir,
    Arc<StoreOwner>,
    InitialTicket,
    Arc<Mutex<Result<StorageTarget, String>>>,
    Arc<AtomicBool>,
    Arc<WorkOwner>,
    Arc<Owner>,
);
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let seed = Store::new(dir.path().to_owned(), "test".into()).unwrap();
    seed.write_guarded(r#"{"schemaVersion":1,"sources":[],"channels":[]}"#,
            r#"{"schemaVersion":1,"sources":[],"favorites":["recoverable"],"removedChannels":["missing"],"volume":0.7,"muted":true,"panelWidth":360}"#,
            None,(None,None),||Ok(())).unwrap();
    let target = Arc::new(Mutex::new(Ok(StorageTarget {
        path: dir.path().into(),
        mode: "test".into(),
        require_existing: true,
        require_database: true,
    })));
    let (store, ticket) = StoreOwner::initializing();
    (
        dir,
        Arc::new(store),
        ticket,
        target,
        Arc::new(AtomicBool::new(false)),
        Arc::new(WorkOwner::default()),
        Arc::new(Owner::default()),
    )
}
#[tokio::test]
async fn registration_and_pending_owner_precede_actual_open_without_poisoning_initial_read() {
    let (_dir, store, ticket, target, closing, work, owner) = fixture();
    let (release, ready) = tokio::sync::oneshot::channel();
    let opens = Arc::new(AtomicUsize::new(0));
    let counted = opens.clone();
    owner
        .start_with(
            store.clone(),
            ticket,
            target,
            closing,
            work.acquire(),
            async move { ready.await.unwrap() },
            move |target| {
                counted.fetch_add(1, Ordering::SeqCst);
                Store::open_target(target)
            },
        )
        .unwrap();
    assert_eq!(work.count(), 1);
    assert_eq!(opens.load(Ordering::SeqCst), 0);
    let succeeded = AtomicBool::new(false);
    assert_eq!(
        store.read_initial(&succeeded).err().unwrap(),
        "storage-initializing"
    );
    assert_eq!(store.read().unwrap().generation(), 1);
    assert!(!succeeded.load(Ordering::SeqCst));
    release.send(()).unwrap();
    owner.join().await;
    let snapshot = store.read_initial(&succeeded).unwrap();
    assert!(snapshot.pair.preferences.unwrap().contains("recoverable"));
    assert!(succeeded.load(Ordering::SeqCst));
    assert_eq!(store.read().unwrap().generation(), 1);
    assert_eq!(work.count(), 0);
    assert_eq!(opens.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn canceled_waiter_retains_original_blocking_handle_and_concurrent_reads_share_one_open() {
    let (_dir, store, ticket, target, closing, work, owner) = fixture();
    let (entered, observed) = tokio::sync::oneshot::channel();
    let (release, held) = mpsc::channel();
    let opens = Arc::new(AtomicUsize::new(0));
    let counted = opens.clone();
    owner
        .start_with(
            store.clone(),
            ticket,
            target.clone(),
            closing.clone(),
            work.acquire(),
            async {},
            move |target| {
                counted.fetch_add(1, Ordering::SeqCst);
                entered.send(()).unwrap();
                held.recv_timeout(Duration::from_secs(5)).unwrap();
                Store::open_target(target)
            },
        )
        .unwrap();
    observed.await.unwrap();
    let first = owner.clone();
    let waiting = tokio::spawn(async move { first.join().await });
    tokio::task::yield_now().await;
    waiting.abort();
    let _ = waiting.await;
    assert_eq!(work.count(), 1);
    assert!(owner
        .start(
            store.clone(),
            ticket,
            target,
            closing,
            work.acquire(),
            async {}
        )
        .is_err());
    let second = owner.clone();
    let joined = tokio::spawn(async move { second.join().await });
    tokio::task::yield_now().await;
    assert!(!joined.is_finished());
    release.send(()).unwrap();
    joined.await.unwrap();
    owner.join().await;
    assert!(store.read().unwrap().is_ok());
    assert_eq!(opens.load(Ordering::SeqCst), 1);
    assert_eq!(work.count(), 0);
}
#[tokio::test]
async fn closing_while_original_open_is_held_joins_without_adoption_or_empty_substitution() {
    let (_dir, store, ticket, target, closing, work, owner) = fixture();
    let (entered, observed) = tokio::sync::oneshot::channel();
    let (release, held) = mpsc::channel();
    owner
        .start_with(
            store.clone(),
            ticket,
            target,
            closing.clone(),
            work.acquire(),
            async {},
            move |target| {
                entered.send(()).unwrap();
                held.recv_timeout(Duration::from_secs(5)).unwrap();
                Store::open_target(target)
            },
        )
        .unwrap();
    observed.await.unwrap();
    closing.store(true, Ordering::SeqCst);
    let cleanup = owner.clone();
    let drain = tokio::spawn(async move { cleanup.join().await });
    tokio::task::yield_now().await;
    assert!(!drain.is_finished());
    assert_eq!(work.count(), 1);
    release.send(()).unwrap();
    drain.await.unwrap();
    work.drained().await;
    assert_eq!(
        store.read().unwrap().as_ref().err().unwrap(),
        "storage-initializing"
    );
    assert_eq!(store.read().unwrap().generation(), 1);
}
#[tokio::test]
async fn preopen_closing_after_registration_prevents_factory_entirely() {
    let (_dir, store, ticket, target, closing, work, owner) = fixture();
    let (release, ready) = tokio::sync::oneshot::channel();
    owner
        .start_with(
            store.clone(),
            ticket,
            target,
            closing.clone(),
            work.acquire(),
            async move { ready.await.unwrap() },
            |_| panic!("obsolete opening must never start"),
        )
        .unwrap();
    closing.store(true, Ordering::SeqCst);
    release.send(()).unwrap();
    owner.join().await;
    assert_eq!(work.count(), 0);
    assert!(store.read().unwrap().is_err());
}
#[tokio::test]
async fn failed_or_panicked_open_remains_failed_and_explicit_recovery_is_not_poisoned_by_old_join()
{
    for panic in [false, true] {
        let (dir, store, ticket, target, closing, work, owner) = fixture();
        owner
            .start_with(
                store.clone(),
                ticket,
                target,
                closing,
                work.acquire(),
                async {},
                move |_| {
                    if panic {
                        panic!("fixture-open-panic")
                    };
                    Err("fixture-open-failed".into())
                },
            )
            .unwrap();
        owner.join().await;
        assert_eq!(
            store.read().unwrap().as_ref().err().unwrap(),
            if panic {
                "storage-startup-worker-failed"
            } else {
                "fixture-open-failed"
            }
        );
        assert_eq!(work.count(), 0);
        {
            let mut replacement = store.exclusive().unwrap();
            *replacement = Ok(Store::new(dir.path().into(), "test".into()).unwrap());
        }
        owner.join().await;
        assert!(store.read_initial(&AtomicBool::new(false)).is_ok());
        assert_eq!(store.read().unwrap().generation(), 2);
    }
}
#[tokio::test]
async fn stale_generation_cannot_replace_a_newer_root_and_real_schema_inspection_is_retained() {
    let (dir, store, ticket, target, closing, work, owner) = fixture();
    let (entered, observed) = tokio::sync::oneshot::channel();
    let (release, held) = mpsc::channel();
    owner
        .start_with(
            store.clone(),
            ticket,
            target,
            closing,
            work.acquire(),
            async {},
            move |target| {
                entered.send(()).unwrap();
                held.recv_timeout(Duration::from_secs(5)).unwrap();
                Store::open_target(target)
            },
        )
        .unwrap();
    observed.await.unwrap();
    {
        let mut current = store.exclusive().unwrap();
        *current = Err("fixture-newer-root".into());
    }
    release.send(()).unwrap();
    owner.join().await;
    assert_eq!(
        store.read().unwrap().as_ref().err().unwrap(),
        "fixture-newer-root"
    );
    let c = rusqlite::Connection::open(dir.path().join(crate::storage_transaction::DB)).unwrap();
    assert_eq!(
        c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        19
    );
}
