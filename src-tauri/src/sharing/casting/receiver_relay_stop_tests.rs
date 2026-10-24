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
use tokio::sync::oneshot;

async fn relay() -> ReceiverRelay {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    ReceiverRelay::owned(
        listener,
        origin,
        "127.0.0.1".parse().unwrap(),
        Url::parse("https://example.invalid/fixture.m3u8").unwrap(),
        false,
    )
    .unwrap()
}

#[tokio::test]
async fn canceled_stop_waiter_retains_actual_listener_and_child_join() {
    let mut relay = relay().await;
    relay.stop().await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let work = Arc::new(WorkOwner::default());
    let guard = work.acquire();
    let (release, released) = std::sync::mpsc::channel();
    let (started, ready) = oneshot::channel();
    let (cancel, mut canceled) = watch::channel(false);
    let (listener_dropped, mut dropped) = oneshot::channel();
    relay.cancel = cancel;
    relay.task = Some(tokio::spawn(async move {
        let mut children = JoinSet::new();
        // Started blocking work cannot be canceled by abort_all: the join must
        // remain owned until its actual guard has dropped.
        children.spawn_blocking(move || {
            let _guard = guard;
            let _ = started.send(());
            let _ = released.recv();
        });
        let _ = canceled.changed().await;
        children.abort_all();
        while children.join_next().await.is_some() {}
        drop(listener);
        let _ = listener_dropped.send(());
    }));
    ready.await.unwrap();
    let resource = relay
        .state
        .lock()
        .unwrap()
        .issue(Url::parse("https://example.invalid/owned.ts").unwrap())
        .unwrap();
    assert!(resource.contains("/media/"));
    assert!(
        tokio::time::timeout(Duration::from_millis(30), relay.stop())
            .await
            .is_err()
    );
    assert!(relay.task.as_ref().is_some_and(|task| !task.is_finished()));
    assert_eq!(work.count(), 1);
    assert!(TcpListener::bind(address).await.is_err());
    assert!(matches!(
        dropped.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    assert_eq!(relay.state.lock().unwrap().resources.len(), 1);
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), relay.stop())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(work.count(), 0);
    assert!(relay.task.is_none());
    assert!(relay.state.lock().unwrap().resources.is_empty());
    dropped.await.unwrap();
    relay.stop().await.unwrap();
}

#[tokio::test]
async fn failed_join_is_not_repolled_or_reclassified_as_clean() {
    let mut relay = relay().await;
    relay.stop().await.unwrap();
    relay.task = Some(tokio::spawn(async { panic!("owned fixture failure") }));
    assert_eq!(relay.stop().await, Err("cast-relay-shutdown"));
    assert!(relay.join_failed);
    assert!(relay.task.is_some());
    assert_eq!(relay.stop().await, Err("cast-relay-shutdown"));
}

#[tokio::test]
async fn poisoned_resource_state_refuses_clean_result_after_confirmed_join() {
    let mut relay = relay().await;
    let state = relay.state.clone();
    assert!(std::thread::spawn(move || {
        let _state = state.lock().unwrap();
        panic!("owned fixture state poison");
    })
    .join()
    .is_err());
    assert_eq!(relay.stop().await, Err("cast-relay-shutdown"));
    assert!(relay.task.is_none());
    assert!(!relay.join_failed);
    assert_eq!(relay.stop().await, Err("cast-relay-shutdown"));
}
