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

//! Opening the provider's stream: the authority check, waiting for a free
//! connection, and following the redirect chain.

use super::*;

/// How long a confirmed authority stands. The relay asks before every read
/// and every 64 KB written; confirming each time was a database transaction
/// per chunk, which on a TV throttled every paid channel below real time.
/// Removal or an edit of the account still stops playback within this.
pub(super) const AUTHORITY_INTERVAL: Duration = Duration::from_secs(2);

pub(super) async fn authority(state: &Arc<Mutex<State>>) -> Result<(), &'static str> {
    let received = {
        let mut s = state.lock().map_err(|_| "account-proxy-state")?;
        if !s.active() {
            return Err("account-proxy-expired");
        }
        if s.verified
            .is_some_and(|at| at.elapsed() < AUTHORITY_INTERVAL)
        {
            s.renewed = Instant::now();
            return Ok(());
        }
        s.authorities.retain(|task| !task.is_finished());
        if s.authorities.len() >= 16 {
            return Err("account-proxy-authority-limit");
        }
        let callback = s.authority.clone();
        let (sent, received) = tokio::sync::oneshot::channel();
        s.authorities.push(tokio::spawn(async move {
            let result = callback().await.map_err(|_| "account-proxy-revoked");
            let _ = sent.send(result);
        }));
        received
    };
    received.await.map_err(|_| "account-proxy-revoked")??;
    let mut s = state.lock().map_err(|_| "account-proxy-state")?;
    if !s.active() {
        return Err("account-proxy-expired");
    }
    // Actual authorized decoder traffic renews the local lease, including a
    // continuous TS response. Paused/background owners may stop explicitly.
    s.renewed = Instant::now();
    s.verified = Some(Instant::now());
    Ok(())
}

/// One request to the provider, waiting out "busy". Providers with a
/// connection limit keep counting the previous stream after a channel change
/// and answer 503 meanwhile. A live channel's first request waits that out
/// (see `busy_delay`); a stop or newer channel ends this task, and every other
/// status fails at once.
#[allow(clippy::too_many_arguments)]
pub(super) async fn open_waiting(
    state: &Arc<Mutex<State>>,
    target: &Url,
    range: Option<String>,
    allowed: &[String],
    deadline: Instant,
    live_start: bool,
    busy: Option<&BusyNotice>,
    timed: Option<u64>,
) -> Result<reqwest::Response, &'static str> {
    let mut attempt = 0u64;
    let response = tokio::time::timeout_at(deadline, async {
        loop {
            match open(
                target.clone(),
                range.clone(),
                allowed,
                deadline,
                timed,
                live_start,
            )
            .await
            {
                Err("account-proxy-upstream-503") => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let Some(delay) = busy_delay(attempt, live_start, remaining) else {
                        break Err("account-proxy-upstream-503");
                    };
                    if attempt == 0 && live_start {
                        if let Some(notice) = busy {
                            notice();
                        }
                    }
                    attempt += 1;
                    tokio::time::sleep(delay).await;
                    authority(state).await?;
                }
                other => break other,
            }
        }
    })
    .await
    .map_err(|_| "account-proxy-timeout")??;
    time_start(timed, |t| {
        t.upstream_headers_ms = Some(unix_ms());
        t.busy_retries = u32::try_from(attempt).unwrap_or(u32::MAX);
    });
    Ok(response)
}

/// The provider's answer through its redirects. A live start whose stream
/// server does not answer in time runs the chain once more from the start.
pub(super) async fn open(
    url: Url,
    range: Option<String>,
    allowed: &[String],
    deadline: Instant,
    timed: Option<u64>,
    live_start: bool,
) -> Result<reqwest::Response, &'static str> {
    // A busy retry starts over: the hops kept are the answering attempt's.
    time_start(timed, |t| t.hops.clear());
    let first = open_chain(
        url.clone(),
        range.clone(),
        allowed,
        deadline,
        timed,
        live_start,
    )
    .await;
    let outcome = match first {
        Err(code) if code == STALLED => {
            time_start(timed, |t| t.fresh_runs += 1);
            open_chain(url, range, allowed, deadline, timed, live_start).await
        }
        other => other,
    };
    match outcome {
        Err(code) if code == STALLED => Err("account-proxy-timeout"),
        other => other,
    }
}

pub(super) async fn open_chain(
    mut url: Url,
    range: Option<String>,
    allowed: &[String],
    deadline: Instant,
    timed: Option<u64>,
    live_start: bool,
) -> Result<reqwest::Response, &'static str> {
    let authorized = allowed.first().ok_or("account-proxy-source-refused")?;
    if !allowed.iter().any(|o| validate(&url, o).is_ok()) {
        return Err("account-proxy-source-refused");
    }
    for redirect in 0..=5 {
        if redirect > 0 {
            redirect_target(&url, authorized)?;
        }
        let host = url.host_str().ok_or("account-proxy-source-refused")?;
        let port = url
            .port_or_known_default()
            .ok_or("account-proxy-source-refused")?;
        let looked_up = Instant::now();
        let mut addresses = Vec::new();
        for mut address in crate::network::resolve_for_playback(host)
            .await
            .ok_or("account-proxy-network-failed")?
        {
            if addresses.len() >= 128 || !upstream_admitted(address.ip(), port) {
                return Err("account-proxy-source-refused");
            }
            address.set_port(port);
            addresses.push(address);
        }
        if addresses.is_empty() {
            return Err("account-proxy-network-failed");
        }
        let dns_ms = elapsed_ms(looked_up);
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("account-proxy-timeout");
        }
        let connect_ms = Arc::new(Mutex::new(None));
        let builder = if timed.is_some() {
            reqwest::Client::builder().connector_layer(ConnectTiming(connect_ms.clone()))
        } else {
            reqwest::Client::builder()
        };
        let client = builder
            .no_proxy()
            .redirect(Policy::none())
            .resolve_to_addrs(host, &addresses)
            .connect_timeout(remaining.min(Duration::from_secs(5)))
            .read_timeout(Duration::from_secs(5))
            .user_agent("TMG-TV/0.1")
            .build()
            .map_err(|_| "account-proxy-network-failed")?;
        // No whole-body timeout for an explicitly recognized continuous TS
        // stream. Startup, finite resources, each read, and writes stay bounded.
        let mut request = client.get(url.clone());
        if let Some(value) = &range {
            request = request.header(reqwest::header::RANGE, value);
        }
        let sent = Instant::now();
        // A live start's stream server (reached through a redirect) must
        // answer within `STREAM_SERVER_ANSWER`; None means it did not.
        let answered = if live_start && redirect > 0 {
            tokio::time::timeout(STREAM_SERVER_ANSWER, request.send())
                .await
                .ok()
        } else {
            Some(request.send().await)
        };
        if timed.is_some() {
            let connect_ms = connect_ms.lock().ok().and_then(|c| *c);
            let hop = HopTiming {
                dns_ms,
                connect_ms,
                server_wait_ms: (elapsed_ms(sent) - connect_ms.unwrap_or(0.0)).max(0.0),
                https: url.scheme() == "https",
                status: answered
                    .as_ref()
                    .and_then(|r| r.as_ref().ok())
                    .map_or(0, |r| r.status().as_u16()),
            };
            time_start(timed, |t| {
                if t.hops.len() < TIMED_HOPS {
                    t.hops.push(hop);
                }
            });
        }
        let response = answered
            .ok_or(STALLED)?
            .map_err(|_| "account-proxy-network-failed")?;
        if response.status().is_redirection() {
            if redirect == 5 {
                return Err("account-proxy-redirect-refused");
            }
            let raw = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .filter(|v| v.len() <= 16_384)
                .ok_or("account-proxy-redirect-refused")?;
            let next = url
                .join(raw)
                .map_err(|_| "account-proxy-redirect-refused")?;
            redirect_target(&next, authorized)?;
            url = next;
            continue;
        }
        if !matches!(response.status().as_u16(), 200 | 206) {
            // Fixed codes per common status keep provider refusals diagnosable.
            return Err(match response.status().as_u16() {
                401 => "account-proxy-upstream-401",
                403 => "account-proxy-upstream-403",
                404 => "account-proxy-upstream-404",
                405 => "account-proxy-upstream-405",
                406 => "account-proxy-upstream-406",
                429 => "account-proxy-upstream-429",
                458 => "account-proxy-upstream-458",
                500 => "account-proxy-upstream-500",
                502 => "account-proxy-upstream-502",
                503 => "account-proxy-upstream-503",
                509 => "account-proxy-upstream-509",
                _ => "account-proxy-upstream-refused",
            });
        }
        return Ok(response);
    }
    Err("account-proxy-redirect-refused")
}
