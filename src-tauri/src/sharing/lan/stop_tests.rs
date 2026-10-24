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
use crate::close_owner::{CloseOwner, WorkOwner};

fn config() -> StartConfig {
    StartConfig {
        bind: "127.0.0.1:0".parse().unwrap(),
        certificate_chain: vec![
            include_bytes!("fixtures/loopback-cert.der").to_vec(),
            include_bytes!("fixtures/loopback-root.der").to_vec(),
        ],
        private_key: include_bytes!("fixtures/loopback-key.der").to_vec(),
        allow_http_upstream: false,
    }
}

// A started blocking child cannot be aborted. This exercises the real JoinSet
// abort-and-join boundary without changing production timeouts or TLS policy.
async fn retained_child(
    manager: &LanManager,
) -> (
    std::sync::mpsc::Sender<()>,
    Arc<WorkOwner>,
    SocketAddr,
    oneshot::Receiver<()>,
) {
    manager.start(config()).await.unwrap();
    let state = manager.running.lock().await.as_ref().unwrap().state.clone();
    manager.stop().await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let work = Arc::new(WorkOwner::default());
    let guard = work.acquire();
    let (release, released) = std::sync::mpsc::channel();
    let (started, ready) = oneshot::channel();
    let (stop, cancelled) = oneshot::channel();
    let (listener_dropped, dropped) = oneshot::channel();
    let task = tokio::spawn(async move {
        let mut children = JoinSet::new();
        children.spawn_blocking(move || {
            let _guard = guard;
            let _ = started.send(());
            let _ = released.recv();
        });
        let _ = cancelled.await;
        children.abort_all();
        while children.join_next().await.is_some() {}
        drop(listener);
        let _ = listener_dropped.send(());
    });
    ready.await.unwrap();
    let (_, commands) = mpsc::channel(1);
    *manager.running.lock().await = Some(Running {
        state,
        stop: Some(stop),
        task,
        join_failed: false,
        commands: Arc::new(tokio::sync::Mutex::new(commands)),
    });
    (release, work, address, dropped)
}

#[tokio::test]
async fn deadline_retains_listener_and_child_join_until_retry_settles() {
    let manager = LanManager::default();
    let close = CloseOwner::default();
    let (release, work, address, mut dropped) = retained_child(&manager).await;
    let (first, _) = close.native_drain().unwrap();
    let result = manager.stop().await;
    assert_eq!(result, Err("lan-stop-deadline"));
    first.complete(result);
    assert_eq!(work.count(), 1);
    assert!(manager.running.lock().await.is_some());
    assert!(TcpListener::bind(address).await.is_err());
    assert!(matches!(
        dropped.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    assert!(matches!(
        manager.start(config()).await,
        Err("lan-already-running")
    ));
    let (retry, start) = close.native_drain().unwrap();
    assert!(start);
    release.send(()).unwrap();
    let result = manager.stop().await;
    retry.complete(result);
    retry.settled().await.unwrap();
    assert_eq!(work.count(), 0);
    assert!(manager.running.lock().await.is_none());
    dropped.await.unwrap();
    manager.start(config()).await.unwrap();
    manager.stop().await.unwrap();
}

#[tokio::test]
async fn abandoned_stop_waiter_does_not_drop_join_ownership() {
    let manager = LanManager::default();
    let (release, work, address, mut dropped) = retained_child(&manager).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(30), manager.stop())
            .await
            .is_err()
    );
    assert_eq!(work.count(), 1);
    let owner = manager.running.lock().await;
    assert!(owner.as_ref().unwrap().stop.is_none());
    assert!(!owner.as_ref().unwrap().task.is_finished());
    drop(owner);
    assert!(TcpListener::bind(address).await.is_err());
    assert!(matches!(
        dropped.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    release.send(()).unwrap();
    manager.shutdown().await.unwrap();
    assert_eq!(work.count(), 0);
    assert!(manager.running.lock().await.is_none());
    dropped.await.unwrap();
    assert!(matches!(
        manager.start(config()).await,
        Err("lan-owner-closing")
    ));
}

#[tokio::test]
async fn failed_listener_join_never_becomes_false_clean_on_retry() {
    let manager = LanManager::default();
    manager.start(config()).await.unwrap();
    let mut owner = manager.running.lock().await;
    let running = owner.as_mut().unwrap();
    running.stop.take().unwrap().send(()).unwrap();
    (&mut running.task).await.unwrap();
    running.task = tokio::spawn(async { panic!("owned fixture failure") });
    drop(owner);
    assert_eq!(manager.stop().await, Err("lan-stop-task-failed"));
    assert_eq!(manager.stop().await, Err("lan-stop-task-failed"));
    assert!(manager.running.lock().await.is_some());
    assert!(matches!(
        manager.start(config()).await,
        Err("lan-already-running")
    ));
}
