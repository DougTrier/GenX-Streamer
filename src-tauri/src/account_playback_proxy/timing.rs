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

//! Start timing for Paid TV playback: when each hop of opening a stream began
//! and ended, for the start-time diagnostics.

use super::*;

/// Measurement only (owner request, October 22, 2026): wall-clock times of the
/// latest live start's first request through this relay, so a slow start can
/// be split into provider time and player time. Times and a count only; no
/// addresses, headers or bodies.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartTiming {
    pub generation: u64,
    /// The relay began asking the provider: at session start when the request
    /// was opened ahead of the player, else when the player's request arrived.
    pub request_ms: f64,
    /// The player's first request reached the relay.
    pub player_request_ms: Option<f64>,
    /// The provider was asked at session start, before the player.
    pub preopened: bool,
    /// Redirect chains run again because a stream server did not answer.
    pub fresh_runs: u32,
    /// The provider's response headers arrived (after any "busy" retries).
    pub upstream_headers_ms: Option<f64>,
    /// The provider's first body bytes arrived.
    pub upstream_first_byte_ms: Option<f64>,
    /// The first bytes were written to the player.
    pub player_first_byte_ms: Option<f64>,
    /// How many times the provider answered "busy" (503) first.
    pub busy_retries: u32,
    /// Each request of the answering attempt: the first, then one per redirect.
    pub hops: Vec<HopTiming>,
}

/// One provider request (measurement only). Milliseconds.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HopTiming {
    /// Looking up the host's addresses.
    pub dns_ms: f64,
    /// Opening the connection (TCP, plus TLS for HTTPS); None if it failed.
    pub connect_ms: Option<f64>,
    /// From the open connection to the response headers (the server's wait).
    pub server_wait_ms: f64,
    pub https: bool,
    pub status: u16,
}

pub(super) const TIMED_HOPS: usize = 12;

pub(super) static START_TIMING: Mutex<Option<StartTiming>> = Mutex::new(None);

pub(crate) fn start_timing() -> Option<StartTiming> {
    START_TIMING.lock().ok().and_then(|timing| timing.clone())
}

pub(super) fn elapsed_ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

/// Times the client's connector (a pass-through layer; measurement only).
#[derive(Clone)]
pub(super) struct ConnectTiming(pub(super) Arc<Mutex<Option<f64>>>);

impl<S> tower_layer::Layer<S> for ConnectTiming {
    type Service = TimedConnect<S>;
    fn layer(&self, inner: S) -> Self::Service {
        TimedConnect {
            inner,
            out: self.0.clone(),
        }
    }
}

#[derive(Clone)]
pub(super) struct TimedConnect<S> {
    pub(super) inner: S,
    pub(super) out: Arc<Mutex<Option<f64>>>,
}

impl<S, R> tower_service::Service<R> for TimedConnect<S>
where
    S: tower_service::Service<R>,
    S::Future: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<S::Response, S::Error>> + Send>>;
    fn poll_ready(
        &mut self,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), S::Error>> {
        self.inner.poll_ready(cx)
    }
    fn call(&mut self, request: R) -> Self::Future {
        let started = Instant::now();
        let out = self.out.clone();
        let connecting = self.inner.call(request);
        Box::pin(async move {
            let connected = connecting.await;
            if connected.is_ok() {
                if let Ok(mut out) = out.lock() {
                    out.get_or_insert(elapsed_ms(started));
                }
            }
            connected
        })
    }
}

pub(super) fn unix_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Opens the record for a session's first live request; later requests of the
/// same session (reconnects) leave it alone. True when this request opened it.
pub(super) fn open_start_timing(generation: u64, request_ms: f64) -> bool {
    START_TIMING.lock().is_ok_and(|mut timing| {
        if timing.as_ref().is_some_and(|t| t.generation == generation) {
            return false;
        }
        *timing = Some(StartTiming {
            generation,
            request_ms,
            ..StartTiming::default()
        });
        true
    })
}

/// Updates the record of the session that is timing (`timed` names it), never
/// a newer session's record.
pub(super) fn time_start(timed: Option<u64>, update: impl FnOnce(&mut StartTiming)) {
    let Some(generation) = timed else {
        return;
    };
    if let Ok(mut timing) = START_TIMING.lock() {
        if let Some(timing) = timing.as_mut().filter(|t| t.generation == generation) {
            update(timing);
        }
    }
}
