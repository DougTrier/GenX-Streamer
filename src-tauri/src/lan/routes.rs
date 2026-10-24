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

//! The sharing server's routes: pairing, heartbeats, control commands,
//! the channel list and the media a paired viewer may play.

use super::*;

pub(super) async fn route(request: Request, shared: Arc<Mutex<State>>) -> Response {
    let permit = if matches!(request.path.as_str(), "/state" | "/channels" | "/control") {
        let Some(viewer) = token(&request) else {
            return error(401, "viewer-unauthorized");
        };
        let Ok(mut state) = shared.lock() else {
            return error(503, "state-unavailable");
        };
        let now = state.now();
        state.expire(now);
        match state.consumers.admit_control(viewer) {
            Ok(permit) => Some(permit),
            Err("consumer-control-limit" | "consumer-total-control-limit") => {
                let mut refused = error(429, "viewer-request-limit");
                refused.extra.push(("Retry-After".into(), "1".into()));
                return refused;
            }
            Err(_) => return error(401, "viewer-unauthorized"),
        }
    } else {
        None
    };
    if let Some(mut permit) = permit {
        let control_command = request.path == "/control";
        let mut result = tokio::select! {
            _ = permit.cancelled() => return if control_command { error(409, "control-application-unconfirmed") } else { error(401, "viewer-unauthorized") },
            result = route_inner(request, shared) => result,
        };
        if !permit.valid() {
            return if control_command {
                error(409, "control-application-unconfirmed")
            } else {
                error(401, "viewer-unauthorized")
            };
        }
        result.owner = Some(RequestOwner::Control(permit));
        result
    } else {
        route_inner(request, shared).await
    }
}

pub(super) async fn route_inner(request: Request, shared: Arc<Mutex<State>>) -> Response {
    if request.method == "GET" {
        let asset = match request.path.as_str() {
            "/" => Some((
                include_str!("viewer.html").as_bytes(),
                "text/html; charset=utf-8",
            )),
            "/viewer.css" => Some((
                include_str!("viewer.css").as_bytes(),
                "text/css; charset=utf-8",
            )),
            "/viewer.js" => Some((
                include_str!("viewer.js").as_bytes(),
                "text/javascript; charset=utf-8",
            )),
            "/hls.js" => Some((
                include_str!("../../../node_modules/hls.js/dist/hls.min.js").as_bytes(),
                "text/javascript; charset=utf-8",
            )),
            _ => None,
        };
        if let Some((body, content_type)) = asset {
            return Response { status: 200, body: body.to_vec(), content_type: content_type.into(), extra: vec![("Content-Security-Policy".into(), "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; connect-src 'self'; worker-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'".into())], upstream: None, owner: None, manifest_budget: None, #[cfg(test)] writer_probe: None };
        }
    }

    if request.method == "POST" {
        let Ok(state) = shared.lock() else {
            return error(503, "state-unavailable");
        };
        if request.origin.as_deref() != Some(&state.origin) {
            return error(403, "origin-refused");
        }
    }
    if request.path == "/pair" && request.method == "POST" {
        let Ok(body) = serde_json::from_slice::<PairBody>(&request.body) else {
            return error(400, "pair-body-invalid");
        };
        let Ok(viewer) = opaque() else {
            return error(503, "entropy-unavailable");
        };
        let Ok(viewer_id) = opaque() else {
            return error(503, "entropy-unavailable");
        };
        let Ok(mut state) = shared.lock() else {
            return error(503, "state-unavailable");
        };
        let now = state.now();
        state.expire(now);
        if state
            .policy
            .pair(&body.secret, viewer.clone(), now)
            .is_err()
        {
            return error(403, "pairing-refused");
        }
        if state
            .consumers
            .register(&viewer, Instant::now() + Duration::from_secs(30))
            .is_err()
        {
            state.policy.revoke(&viewer);
            return error(503, "consumer-admission-unavailable");
        }
        state.viewers.insert(
            viewer_id.clone(),
            (viewer.clone(), now.saturating_add(30000)),
        );
        let controller = state.pending_controller.take();
        let role = if let Some((channels, labels)) = controller {
            state.controllers.insert(
                viewer.clone(),
                Controller {
                    channels,
                    labels,
                    sequence: 0,
                },
            );
            let _ = state.policy.heartbeat(&viewer, true, now);
            let _ =
                state
                    .consumers
                    .heartbeat(&viewer, true, Instant::now() + Duration::from_secs(30));
            "controller"
        } else {
            "viewer"
        };
        let mut result = response(
            200,
            json(
                &serde_json::json!({"paired":true,"viewerId":viewer_id,"role":role,"leaseMilliseconds":30000}),
            ),
        );
        result.extra.push((
            "Set-Cookie".into(),
            format!("tmg_viewer={viewer}; Secure; HttpOnly; SameSite=Strict; Path=/"),
        ));
        return result;
    }
    let Some(viewer) = token(&request) else {
        return error(401, "viewer-unauthorized");
    };
    if request.path == "/channels" && request.method == "GET" {
        let Ok(mut state) = shared.lock() else {
            return error(503, "state-unavailable");
        };
        let now = state.now();
        state.expire(now);
        if !state
            .viewers
            .values()
            .any(|(token, expiry)| token == viewer && *expiry > now)
        {
            return error(401, "viewer-unauthorized");
        }
        let Some(controller) = state.controllers.get(viewer) else {
            return error(403, "view-only-access");
        };
        return response(200, json(&controller.labels));
    }
    if request.path == "/state" && request.method == "POST" {
        let paused = if request.method == "POST" {
            let Ok(body) = serde_json::from_slice::<HeartbeatBody>(&request.body) else {
                return error(400, "state-body-invalid");
            };
            body.paused
        } else {
            false
        };
        let Ok(mut state) = shared.lock() else {
            return error(503, "state-unavailable");
        };
        let now = state.now();
        let Ok(channel) = state.policy.heartbeat(viewer, paused, now) else {
            return error(401, "viewer-unauthorized");
        };
        if state
            .consumers
            .heartbeat(viewer, paused, Instant::now() + Duration::from_secs(30))
            .is_err()
        {
            return error(401, "viewer-unauthorized");
        }
        if let Some((_, expiry)) = state
            .viewers
            .values_mut()
            .find(|(token, _)| token == viewer)
        {
            *expiry = now.saturating_add(30000);
        }
        return response(
            200,
            json(&ViewerState {
                revision: channel.as_ref().map(|c| c.revision),
                media_path: channel.map(|c| format!("/media/{}/{}", c.revision, c.media_id)),
            }),
        );
    }
    if request.path == "/control" && request.method == "POST" {
        {
            let Ok(state) = shared.lock() else {
                return error(503, "state-unavailable");
            };
            if !state.controllers.contains_key(viewer) {
                return error(403, "view-only-access");
            }
        }
        let Ok(body) = serde_json::from_slice::<ControlBody>(&request.body) else {
            return error(400, "control-body-invalid");
        };
        if !body.valid() {
            return error(400, "control-payload-invalid");
        }
        let (command_id, received) = {
            let Ok(mut state) = shared.lock() else {
                return error(503, "state-unavailable");
            };
            let now = state.now();
            state.expire(now);
            if state.policy.heartbeat(viewer, true, now).is_err() {
                return error(401, "viewer-unauthorized");
            }
            let Some(controller) = state.controllers.get(viewer) else {
                return error(403, "view-only-access");
            };
            if body.sequence == 0 || body.sequence <= controller.sequence {
                return error(409, "control-sequence-replayed");
            }
            if body.revision != state.revision {
                return error(409, "control-revision-obsolete");
            }
            if body
                .channel_id
                .as_ref()
                .is_some_and(|channel| !controller.channels.contains(channel))
            {
                return error(403, "control-channel-out-of-scope");
            }
            if state
                .pending_controls
                .values()
                .any(|pending| pending.token == viewer)
            {
                return error(409, "control-already-pending");
            }
            let Ok(command_id) = opaque() else {
                return error(503, "entropy-unavailable");
            };
            let (reply, received) = oneshot::channel();
            let command = ControlCommand {
                command_id: command_id.clone(),
                channel_id: body.channel_id,
                sequence: body.sequence,
                revision: body.revision,
                action: body.action,
                muted: body.muted,
                volume: body.volume,
                allowed_channel_ids: if matches!(
                    body.action,
                    ControlAction::Next | ControlAction::Previous
                ) {
                    let mut ids: Vec<_> = controller.channels.iter().cloned().collect();
                    ids.sort();
                    ids
                } else {
                    Vec::new()
                },
            };
            if state
                .consumers
                .heartbeat(viewer, true, Instant::now() + Duration::from_secs(30))
                .is_err()
            {
                return error(401, "viewer-unauthorized");
            }
            if state.command_sender.try_send(command).is_err() {
                return error(429, "control-queue-full");
            }
            state
                .controllers
                .get_mut(viewer)
                .expect("controller checked under lock")
                .sequence = body.sequence;
            if let Some((_, expiry)) = state
                .viewers
                .values_mut()
                .find(|(token, _)| token == viewer)
            {
                *expiry = now.saturating_add(30000);
            }
            state.pending_controls.insert(
                command_id.clone(),
                PendingControl {
                    token: viewer.into(),
                    expires: now.saturating_add(3000),
                    revision: body.revision,
                    reply,
                },
            );
            (command_id, received)
        };
        let confirmed = matches!(
            tokio::time::timeout(Duration::from_secs(3), received).await,
            Ok(Ok(true))
        );
        if let Ok(mut state) = shared.lock() {
            state.pending_controls.remove(&command_id);
        }
        return if confirmed {
            response(
                200,
                json(&serde_json::json!({"commandId":command_id,"applied":true})),
            )
        } else {
            error(409, "control-application-unconfirmed")
        };
    }
    if request.method != "GET" {
        return error(403, "view-only-access");
    }
    let parts: Vec<_> = request.path.split('/').collect();
    if parts.len() != 4 || parts[1] != "media" || !id(parts[3]) {
        return error(404, "resource-not-admitted");
    }
    let Ok(revision) = parts[2].parse::<u64>() else {
        return error(404, "resource-not-admitted");
    };
    let (target, allow_http, mut permit, budget) = {
        let Ok(mut state) = shared.lock() else {
            return error(503, "state-unavailable");
        };
        let now = state.now();
        state.expire(now);
        let Ok(target) = state.policy.resource(viewer, revision, parts[3], now) else {
            return error(401, "resource-unauthorized");
        };
        let permit = match state.consumers.admit_media(viewer, revision) {
            Ok(permit) => permit,
            Err("consumer-media-limit" | "consumer-total-media-limit") => {
                let mut refused = error(429, "viewer-request-limit");
                refused.extra.push(("Retry-After".into(), "1".into()));
                return refused;
            }
            Err(_) => return error(401, "resource-unauthorized"),
        };
        (
            target,
            state.allow_http,
            permit,
            state.manifest_budget.clone(),
        )
    };
    let Ok(url) = reqwest::Url::parse(&target) else {
        return error(502, "resource-invalid");
    };
    let upstream_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    #[cfg(test)]
    let fixture = shared
        .lock()
        .ok()
        .and_then(|state| state.fixture_upstream.clone());
    #[cfg(test)]
    let opening = async {
        if let Some(base) = fixture.clone() {
            open_fixture_upstream(url, request.range.clone(), base, upstream_deadline).await
        } else {
            relay::open_with_remaining_policy(
                url,
                request.range.clone(),
                allow_http,
                upstream_deadline,
                5,
            )
            .await
        }
    };
    #[cfg(not(test))]
    let opening = relay::open_with_remaining_policy(
        url,
        request.range.clone(),
        allow_http,
        upstream_deadline,
        5,
    );
    let mut reply = tokio::select! {
        _ = permit.cancelled() => return error(401, "resource-unauthorized"),
        result = opening => match result { Ok(reply) => reply, Err(_) => return error(502, "upstream-unavailable") },
    };
    if reply.body_kind == relay::BodyKind::Manifest
        && (reply.status == 206 || reply.content_range.is_some())
    {
        // Rewriting changes byte offsets: obtain the complete validated playlist once.
        // The initial request and this refetch share one deadline and redirect allowance.
        let canonical_url = reply.final_url.clone();
        let remaining_redirects = 5usize.saturating_sub(reply.redirects_used);
        drop(reply);
        #[cfg(test)]
        let opening = async {
            if let Some(base) = fixture {
                open_fixture_upstream(canonical_url, None, base, upstream_deadline).await
            } else {
                relay::open_with_remaining_policy(
                    canonical_url,
                    None,
                    allow_http,
                    upstream_deadline,
                    remaining_redirects,
                )
                .await
            }
        };
        #[cfg(not(test))]
        let opening = relay::open_with_remaining_policy(
            canonical_url,
            None,
            allow_http,
            upstream_deadline,
            remaining_redirects,
        );
        reply = tokio::select! {
            _ = permit.cancelled() => return error(401, "resource-unauthorized"),
            result = opening => match result { Ok(reply) => reply, Err(_) => return error(502, "upstream-unavailable") },
        };
        if reply.status == 206 || reply.content_range.is_some() {
            return error(502, "partial-manifest-unsupported");
        }
        if reply.status < 400 && reply.body_kind != relay::BodyKind::Manifest {
            return error(502, "canonical-manifest-invalid");
        }
    }
    if reply.status >= 400 {
        let mut failed = error(reply.status, "upstream-request-failed");
        if let Some(retry_after) = reply
            .retry_after
            .and_then(|value| safe_header(&value).map(str::to_string))
        {
            failed.extra.push(("Retry-After".into(), retry_after));
        }
        return failed;
    }
    let status = reply.status;
    let range = reply
        .content_range
        .clone()
        .and_then(|value| safe_header(&value).map(str::to_string));
    let content_type = safe_header(&reply.content_type)
        .unwrap_or("application/octet-stream")
        .to_string();
    let final_url = reply.final_url.clone();
    let (body, content_type, upstream, manifest_budget) = if reply.body_kind
        == relay::BodyKind::Manifest
    {
        if status == 206 || range.is_some() {
            return error(502, "partial-manifest-unsupported");
        }
        // Reserve input2MiB + rewritten output4MiB before collecting any manifest.
        let Ok(reservation) = budget.try_acquire_many_owned(6 * 1024 * 1024) else {
            let mut refused = error(503, "manifest-budget-unavailable");
            refused.extra.push(("Retry-After".into(), "1".into()));
            return refused;
        };
        let bytes = tokio::select! {
            _ = permit.cancelled() => return error(401, "resource-unauthorized"),
            result = reply.read_manifest() => match result { Ok(bytes) => bytes, Err(_) => return error(502, "manifest-invalid-or-large") },
        };
        let Ok(manifest) = std::str::from_utf8(&bytes) else {
            return error(502, "manifest-invalid");
        };
        if !supported_manifest(manifest) {
            return error(502, "manifest-feature-unsupported");
        }
        let Ok(mut state) = shared.lock() else {
            return error(503, "state-unavailable");
        };
        let now = state.now();
        if !permit.valid()
            || state
                .policy
                .resource(viewer, revision, parts[3], now)
                .is_err()
        {
            return error(401, "resource-unauthorized");
        }
        let mut staged: HashMap<String, String> = HashMap::new();
        let rewritten = relay::rewrite_hls(manifest, &final_url, |url| {
            if url.scheme() == "http" && !state.allow_http {
                return Err("upstream-http-denied");
            }
            let target = url.to_string();
            if target.len() > 8192 {
                return Err("manifest-target-large");
            }
            let resource = if let Some(resource) =
                state.resources.get(&target).or_else(|| staged.get(&target))
            {
                resource.clone()
            } else {
                if state.resources.len() + staged.len() >= 4096 {
                    return Err("resource-limit");
                }
                let resource = opaque()?;
                staged.insert(target, resource.clone());
                resource
            };
            Ok(format!("/media/{revision}/{resource}"))
        });
        let Ok(rewritten) = rewritten else {
            return error(502, "manifest-rewrite-refused");
        };
        let batch = staged
            .iter()
            .map(|(target, resource)| (resource.clone(), target.clone()))
            .collect();
        if state.policy.admit_resources(revision, batch).is_err() {
            return error(502, "manifest-rewrite-refused");
        }
        state.resources.extend(staged);
        (
            rewritten.into_bytes(),
            "application/vnd.apple.mpegurl".to_string(),
            None,
            Some(reservation),
        )
    } else {
        if !permit.valid() {
            return error(401, "resource-unauthorized");
        }
        (Vec::new(), content_type, Some(reply), None)
    };
    let mut result = Response {
        status,
        body,
        content_type,
        extra: Vec::new(),
        upstream,
        owner: Some(RequestOwner::Media(permit)),
        manifest_budget,
        #[cfg(test)]
        writer_probe: shared
            .lock()
            .ok()
            .and_then(|state| state.writer_probe.clone()),
    };
    if let Some(range) = range {
        result.extra.push(("Content-Range".into(), range));
    }
    result
}
