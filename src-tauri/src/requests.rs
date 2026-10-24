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

use crate::close_owner::{WorkGuard, WorkOwner};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;
// Sixteen foreground scan probes plus bounded capacity for playback/control work.
pub(crate) const MAX_RUNNING_REQUESTS: usize = 24;
// Scan checks must leave at least eight requests for playback and control.
const _: () = assert!(crate::scan_resume_owner::MAX_ACTIVE_PROBES + 8 <= MAX_RUNNING_REQUESTS);
#[derive(Debug)]
enum Request {
    Running(Option<oneshot::Sender<()>>, u64),
    PreCanceled(Instant),
}
#[derive(Debug)]
pub struct Receiver {
    receiver: oneshot::Receiver<()>,
    entries: Arc<Mutex<HashMap<String, Request>>>,
    id: String,
    token: u64,
    _guard: WorkGuard,
}
impl Receiver {
    pub fn try_recv(&mut self) -> Result<(), oneshot::error::TryRecvError> {
        self.receiver.try_recv()
    }
}
impl Future for Receiver {
    type Output = Result<(), oneshot::error::RecvError>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.get_mut().receiver).poll(cx)
    }
}
impl Drop for Receiver {
    fn drop(&mut self) {
        if let Ok(mut entries) = self.entries.lock() {
            if matches!(entries.get(&self.id),Some(Request::Running(_,token)) if *token==self.token)
            {
                entries.remove(&self.id);
            }
        }
    }
}
#[derive(Default)]
pub struct Requests {
    entries: Arc<Mutex<HashMap<String, Request>>>,
    work: Arc<WorkOwner>,
    closed: bool,
    next: u64,
}
fn prune(entries: &mut HashMap<String, Request>) {
    entries.retain(
        |_, r| !matches!(r,Request::PreCanceled(time) if time.elapsed()>=Duration::from_secs(30)),
    );
}
fn valid(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        Err("invalid-request-id".into())
    } else {
        Ok(())
    }
}
impl Requests {
    pub fn admit_pending(&mut self, id: &str) -> Result<(), String> {
        valid(id)?;
        if self.closed {
            return Err("application-closing".into());
        }
        let mut entries = self.entries.lock().map_err(|_| "request-lock")?;
        prune(&mut entries);
        if matches!(entries.get(id), Some(Request::PreCanceled(_))) {
            entries.remove(id);
            return Err("canceled".into());
        }
        if entries.contains_key(id) {
            return Err("duplicate-request-id".into());
        }
        Ok(())
    }
    pub fn register(&mut self, id: String) -> Result<Receiver, String> {
        valid(&id)?;
        if self.closed {
            return Err("application-closing".into());
        }
        let mut entries = self.entries.lock().map_err(|_| "request-lock")?;
        prune(&mut entries);
        if matches!(entries.get(&id), Some(Request::PreCanceled(_))) {
            entries.remove(&id);
            return Err("canceled".into());
        }
        if entries.contains_key(&id) {
            return Err("duplicate-request-id".into());
        }
        if entries
            .values()
            .filter(|r| matches!(r, Request::Running(..)))
            .count()
            >= MAX_RUNNING_REQUESTS
        {
            return Err("network-concurrency-limit".into());
        }
        self.next = self
            .next
            .checked_add(1)
            .ok_or("request-generation-exhausted")?;
        let (sender, receiver) = oneshot::channel();
        entries.insert(id.clone(), Request::Running(Some(sender), self.next));
        Ok(Receiver {
            receiver,
            entries: self.entries.clone(),
            id,
            token: self.next,
            _guard: self.work.acquire(),
        })
    }
    pub fn cancel(&mut self, id: String) -> Result<(), String> {
        valid(&id)?;
        let mut entries = self.entries.lock().map_err(|_| "request-lock")?;
        prune(&mut entries);
        match entries.get_mut(&id) {
            Some(Request::Running(sender, _)) => {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(());
                }
            }
            Some(Request::PreCanceled(_)) => {}
            None => {
                if entries.len() >= 260 {
                    return Err("cancellation-limit".into());
                }
                entries.insert(id, Request::PreCanceled(Instant::now()));
            }
        }
        Ok(())
    }
    pub fn finish(&mut self, id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(id);
        }
    }
    pub fn drain_owner(&self) -> Arc<WorkOwner> {
        self.work.clone()
    }
    pub fn stop(&mut self) {
        self.closed = true;
        if let Ok(mut entries) = self.entries.lock() {
            for entry in entries.values_mut() {
                if let Request::Running(sender, _) = entry {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(());
                    }
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upload_admission_consumes_pre_cancel_without_claiming_running_slot() {
        let mut requests = Requests::default();
        requests.cancel("early".into()).unwrap();
        assert_eq!(requests.admit_pending("early").unwrap_err(), "canceled");
        requests.admit_pending("fresh").unwrap();
        assert!(requests.entries.lock().unwrap().is_empty());
        let _receiver = requests.register("running".into()).unwrap();
        assert_eq!(
            requests.admit_pending("running").unwrap_err(),
            "duplicate-request-id"
        );
    }
    #[test]
    fn cancellation_before_registration_and_during_io_cannot_reuse_live_id() {
        let mut requests = Requests::default();
        requests.cancel("early".into()).unwrap();
        assert_eq!(requests.register("early".into()).unwrap_err(), "canceled");
        let mut receiver = requests.register("live".into()).unwrap();
        requests.cancel("live".into()).unwrap();
        assert!(receiver.try_recv().is_ok());
        assert_eq!(
            requests.register("live".into()).unwrap_err(),
            "duplicate-request-id"
        );
        requests.finish("live");
        assert!(requests.register("live".into()).is_ok());
    }
    #[test]
    fn active_and_pending_cancellation_maps_are_bounded() {
        let mut requests = Requests::default();
        let receivers: Vec<_> = (0..MAX_RUNNING_REQUESTS)
            .map(|n| requests.register(n.to_string()).unwrap())
            .collect();
        assert_eq!(
            requests.register("twenty-fifth".into()).unwrap_err(),
            "network-concurrency-limit"
        );
        // Keep the existing total-map bound260, including live running entries.
        for n in 0..(260 - MAX_RUNNING_REQUESTS) {
            requests.cancel(format!("pending-{n}")).unwrap();
        }
        assert_eq!(
            requests.cancel("overflow".into()).unwrap_err(),
            "cancellation-limit"
        );
        requests.stop();
        assert!(receivers
            .into_iter()
            .all(|mut receiver| receiver.try_recv().is_ok()));
        assert_eq!(
            requests.register("new".into()).unwrap_err(),
            "application-closing"
        );
    }
    #[tokio::test]
    async fn stop_retains_live_work_until_drop_and_refuses_new_admission() {
        let mut requests = Requests::default();
        let mut receivers: Vec<_> = (0..MAX_RUNNING_REQUESTS)
            .map(|n| requests.register(format!("owned-{n}")).unwrap())
            .collect();
        let work = requests.drain_owner();
        requests.stop();
        assert_eq!(work.count(), MAX_RUNNING_REQUESTS);
        assert_eq!(requests.entries.lock().unwrap().len(), MAX_RUNNING_REQUESTS);
        assert!(receivers
            .iter_mut()
            .all(|receiver| receiver.try_recv().is_ok()));
        assert_eq!(work.count(), MAX_RUNNING_REQUESTS);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), work.drained())
                .await
                .is_err()
        );
        drop(receivers);
        work.drained().await;
        assert!(requests.entries.lock().unwrap().is_empty());
        assert_eq!(
            requests.register("new".into()).unwrap_err(),
            "application-closing"
        );
    }
    #[test]
    fn old_receiver_drop_does_not_remove_replacement_id() {
        let mut requests = Requests::default();
        let old = requests.register("same".into()).unwrap();
        requests.finish("same");
        let new = requests.register("same".into()).unwrap();
        drop(old);
        assert!(requests.entries.lock().unwrap().contains_key("same"));
        drop(new);
        assert!(requests.entries.lock().unwrap().is_empty());
    }
    #[test]
    fn canceled_running_slot_remains_owned_until_drop_with_scan_headroom() {
        let mut requests = Requests::default();
        let mut scan: Vec<_> = (0..16)
            .map(|n| requests.register(format!("scan-{n}")).unwrap())
            .collect();
        let _other: Vec<_> = (16..MAX_RUNNING_REQUESTS)
            .map(|n| requests.register(format!("other-{n}")).unwrap())
            .collect();
        requests.cancel("scan-0".into()).unwrap();
        assert!(scan[0].try_recv().is_ok());
        assert_eq!(
            requests.register("new".into()).unwrap_err(),
            "network-concurrency-limit"
        );
        assert_eq!(
            requests.register("scan-0".into()).unwrap_err(),
            "duplicate-request-id"
        );
        drop(scan.remove(0));
        let replacement = requests.register("scan-0".into()).unwrap();
        assert_eq!(requests.drain_owner().count(), MAX_RUNNING_REQUESTS);
        drop(replacement);
    }
}
