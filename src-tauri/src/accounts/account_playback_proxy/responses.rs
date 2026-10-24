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

//! Answering the player: MIME types, ranges, headers, chunks, and the
//! request-processing loop.

use super::*;

pub(super) fn mime(response: &reqwest::Response) -> &'static str {
    let raw = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    match raw
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "application/vnd.apple.mpegurl"
        | "application/x-mpegurl"
        | "audio/mpegurl"
        | "audio/x-mpegurl" => "application/vnd.apple.mpegurl",
        "video/mp2t" => "video/mp2t",
        "video/mp4" => "video/mp4",
        "video/x-matroska" => "video/x-matroska",
        "video/webm" => "video/webm",
        "audio/mp4" => "audio/mp4",
        "audio/aac" => "audio/aac",
        "audio/mpeg" => "audio/mpeg",
        "text/html" | "application/json" | "text/xml" | "application/xml" => "refused",
        _ => "application/octet-stream",
    }
}

/// Video container from its first bytes (Matroska/WebM, MP4, MPEG-TS), never
/// from a server label. None means "not a video file" (for example an error page).
/// Relay trace for diagnosing provider replies: debug builds only, and only when
/// GENX_RELAY_DIAG names a file. Records status, type and leading-byte facts,
/// never addresses, credentials or bodies.
pub(super) fn diag(line: std::fmt::Arguments) {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("GENX_RELAY_DIAG") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(f, "{} {}", now_ms(), line);
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = line;
}

pub(super) fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub(super) fn sniff_video(prefix: &[u8]) -> Option<&'static str> {
    if prefix.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        Some("video/x-matroska")
    } else if prefix.len() >= 8 && &prefix[4..8] == b"ftyp" {
        Some("video/mp4")
    } else if prefix.len() >= 377 && prefix[0] == 0x47 && prefix[188] == 0x47 && prefix[376] == 0x47
    {
        Some("video/mp2t")
    } else {
        None
    }
}

pub(super) fn content_range(response: &reqwest::Response) -> Result<Option<String>, &'static str> {
    let Some(raw) = response.headers().get(reqwest::header::CONTENT_RANGE) else {
        return Ok(None);
    };
    let value = raw.to_str().map_err(|_| "account-proxy-range-refused")?;
    if value.len() > 80 {
        return Err("account-proxy-range-refused");
    }
    let raw = value
        .strip_prefix("bytes ")
        .ok_or("account-proxy-range-refused")?;
    let (extent, total) = raw.split_once('/').ok_or("account-proxy-range-refused")?;
    let (start, end) = extent
        .split_once('-')
        .ok_or("account-proxy-range-refused")?;
    let start = start
        .parse::<u64>()
        .map_err(|_| "account-proxy-range-refused")?;
    let end = end
        .parse::<u64>()
        .map_err(|_| "account-proxy-range-refused")?;
    if start > end || (total != "*" && !total.parse::<u64>().is_ok_and(|n| n > end)) {
        return Err("account-proxy-range-refused");
    }
    Ok(Some(value.to_owned()))
}

pub(super) async fn headers(
    socket: &mut TcpStream,
    status: u16,
    mime: &str,
    length: Option<usize>,
    range: Option<&str>,
    origin: Option<&str>,
) -> Result<(), &'static str> {
    let mut text=format!("HTTP/1.1 {status} Response\r\nContent-Type: {mime}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nAccept-Ranges: bytes\r\n");
    if let Some(length) = length {
        text.push_str(&format!("Content-Length: {length}\r\n"));
    } else {
        text.push_str("Transfer-Encoding: chunked\r\n");
    }
    if let Some(value) = range {
        text.push_str(&format!("Content-Range: {value}\r\n"));
    }
    if let Some(value) = origin {
        text.push_str(&format!("Access-Control-Allow-Origin: {value}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET,HEAD,OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Expose-Headers: Content-Range,Accept-Ranges\r\n"));
    }
    text.push_str("\r\n");
    socket
        .write_all(text.as_bytes())
        .await
        .map_err(|_| "account-proxy-write-failed")
}

pub(super) async fn chunk(socket: &mut TcpStream, bytes: &[u8]) -> Result<(), &'static str> {
    for part in bytes.chunks(CHUNK) {
        let work = async {
            socket
                .write_all(format!("{:x}\r\n", part.len()).as_bytes())
                .await?;
            socket.write_all(part).await?;
            socket.write_all(b"\r\n").await
        };
        tokio::time::timeout(Duration::from_secs(5), work)
            .await
            .map_err(|_| "account-proxy-write-failed")?
            .map_err(|_| "account-proxy-write-failed")?;
    }
    Ok(())
}

pub(super) async fn process(
    socket: &mut TcpStream,
    state: &Arc<Mutex<State>>,
    sent: &mut bool,
) -> Result<(), &'static str> {
    let request = read_request(socket, state).await?;
    let arrived = unix_ms();
    authority(state).await?;
    let (target, allowed, vod, live_start, busy, timed, preopened) = {
        let mut s = state.lock().map_err(|_| "account-proxy-state")?;
        let vod = s.vod;
        let busy = s.busy.clone();
        let live_start = !vod && request.id == s.root;
        // The player's first plain request takes the answer opened at start.
        let preopened =
            if live_start && !request.options && !request.head && request.range.is_none() {
                s.preopen.take()
            } else {
                None
            };
        // The first live request of each session opens the timing record
        // (unless the session's opening request already did).
        let timed = (live_start
            && !request.options
            && (preopened.is_some() || open_start_timing(s.generation, arrived)))
        .then_some(s.generation);
        let mut allowed = vec![s.authorized_origin.clone()];
        allowed.extend(s.media_origins.iter().cloned());
        let root = s.root.clone();
        let r = s
            .resources
            .get_mut(&request.id)
            .ok_or("account-proxy-resource-refused")?;
        if request.id != root && !r.playlist && r.seen.elapsed() >= RESOURCE_LIFETIME {
            return Err("account-proxy-resource-refused");
        }
        r.seen = Instant::now();
        (
            Url::parse(&r.url).map_err(|_| "account-proxy-source-refused")?,
            allowed,
            vod,
            live_start,
            busy,
            timed,
            preopened,
        )
    };
    time_start(timed, |t| {
        t.player_request_ms.get_or_insert(arrived);
    });
    if request.options {
        *sent = true;
        headers(
            socket,
            204,
            "text/plain",
            Some(0),
            None,
            request.origin.as_deref(),
        )
        .await?;
        return Ok(());
    }
    let deadline = Instant::now()
        + if live_start {
            LIVE_BUSY_WINDOW
        } else {
            Duration::from_secs(20)
        };
    // The answer opened at session start, while fresh. Its failure is this
    // request's failure (asking again at once would only repeat it); a stale or
    // abandoned one is dropped and the provider is asked now.
    let opened = match preopened {
        Some(taken) => match tokio::time::timeout_at(deadline, taken)
            .await
            .map_err(|_| "account-proxy-timeout")?
        {
            Ok(Ok((response, ready))) if ready.elapsed() <= PREOPEN_FRESH => Some(response),
            Ok(Err(code)) => return Err(code),
            Ok(Ok(_)) | Err(_) => None,
        },
        None => None,
    };
    let mut response = match opened {
        Some(response) => response,
        None => {
            open_waiting(
                state,
                &target,
                request.range.clone(),
                &allowed,
                deadline,
                live_start,
                busy.as_ref(),
                timed,
            )
            .await?
        }
    };
    authority(state).await?;
    let status = response.status().as_u16();
    let mut kind = mime(&response);
    diag(format_args!(
        "vod={} status={} label={:?} length={:?} range_reply={} same_origin={}",
        vod,
        status,
        response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
        response.content_length(),
        response
            .headers()
            .contains_key(reqwest::header::CONTENT_RANGE),
        response.url().origin() == target.origin()
    ));
    let range = content_range(&response)?;
    // Many panels label video files as text/html or JSON. In a VOD session the
    // first bytes decide (below); anything else still refuses such labels.
    if kind == "refused" {
        if !vod {
            return Err("account-proxy-content-refused");
        }
        kind = "pending";
    }
    // In a VOD session a video file is streamed with bounded reads, not capped:
    // movies are gigabytes and players fetch them in byte ranges.
    let media_file = vod
        && matches!(
            kind,
            "video/mp4"
                | "video/x-matroska"
                | "video/webm"
                | "application/octet-stream"
                | "pending"
        );
    if !media_file
        && response
            .content_length()
            .is_some_and(|n| n > FINITE_BODY_LIMIT as u64)
    {
        return Err("account-proxy-body-limit");
    }
    let base = response.url().clone();
    {
        // Remember where the provider sent this playback so its manifest's
        // segment addresses on that server are admitted (bounded per session).
        let mut s = state.lock().map_err(|_| "account-proxy-state")?;
        let reached = base.origin().ascii_serialization();
        if !s.admits(&base) {
            if s.media_origins.len() >= 8 {
                return Err("account-proxy-resource-limit");
            }
            s.media_origins.push(reached);
        }
    }
    let mut prefix = Zeroizing::new(Vec::new());
    while prefix.len() < 512 {
        let part = tokio::time::timeout_at(deadline, response.chunk())
            .await
            .map_err(|_| "account-proxy-timeout")?
            .map_err(|_| "account-proxy-network-failed")?;
        let Some(part) = part else { break };
        if part.len() > FINITE_BODY_LIMIT.saturating_sub(prefix.len()) {
            return Err("account-proxy-body-limit");
        }
        if prefix.is_empty() && !part.is_empty() {
            time_start(timed, |t| t.upstream_first_byte_ms = Some(unix_ms()));
        }
        prefix.extend_from_slice(&part);
    }
    diag(format_args!(
        "head={:02x?} text_start={:?}",
        &prefix[..prefix.len().min(16)],
        String::from_utf8_lossy(&prefix[..prefix.len().min(9)])
    ));
    if prefix.is_empty() {
        return Err("account-proxy-content-empty");
    }
    let text = String::from_utf8_lossy(&prefix);
    let sniff = text.trim_start_matches('\u{feff}').trim_start();
    // A provider's block or login page (any case, any label) is never media.
    let opening = sniff.get(..9).unwrap_or(sniff).to_ascii_lowercase();
    if opening.starts_with("<html")
        || opening.starts_with("<!doctype")
        || opening.starts_with("<?xml")
    {
        return Err("account-proxy-content-page");
    }
    if kind == "pending" {
        let mut s = state.lock().map_err(|_| "account-proxy-state")?;
        kind = match sniff_video(&prefix) {
            Some(found) => {
                s.vod_kind = Some(found);
                found
            }
            None if status == 206 => s.vod_kind.ok_or("account-proxy-content-not-video")?,
            None => return Err("account-proxy-content-not-video"),
        };
    }
    let manifest = kind == "application/vnd.apple.mpegurl" || sniff.starts_with("#EXTM3U");
    drop(text);
    if manifest {
        if prefix.len() > MANIFEST_LIMIT {
            return Err("account-proxy-manifest-limit");
        }
        while let Some(part) = tokio::time::timeout_at(deadline, response.chunk())
            .await
            .map_err(|_| "account-proxy-timeout")?
            .map_err(|_| "account-proxy-network-failed")?
        {
            if part.len() > MANIFEST_LIMIT.saturating_sub(prefix.len()) {
                return Err("account-proxy-manifest-limit");
            }
            prefix.extend_from_slice(&part);
        }
        authority(state).await?;
        let body = {
            let mut s = state.lock().map_err(|_| "account-proxy-state")?;
            let source =
                std::str::from_utf8(&prefix).map_err(|_| "account-proxy-manifest-invalid")?;
            let body = s.rewrite(source, &base)?;
            if let Some(r) = s.resources.get_mut(&request.id) {
                r.playlist = true;
            }
            body
        };
        authority(state).await?;
        *sent = true;
        headers(
            socket,
            status,
            "application/vnd.apple.mpegurl",
            Some(body.len()),
            None,
            request.origin.as_deref(),
        )
        .await?;
        if !request.head {
            socket
                .write_all(body.as_bytes())
                .await
                .map_err(|_| "account-proxy-write-failed")?;
        }
        return Ok(());
    }
    let continuous = response.content_length().is_none()
        && request.range.is_none()
        && (kind == "video/mp2t"
            || (prefix.len() >= 377
                && prefix[0] == 0x47
                && prefix[188] == 0x47
                && prefix[376] == 0x47));
    authority(state).await?;
    *sent = true;
    // Real video is reaching the player: this format works for this account.
    let on_media = state.lock().ok().and_then(|mut s| s.on_media.take());
    if let Some(notice) = on_media {
        notice();
    }
    headers(
        socket,
        status,
        kind,
        if request.head {
            response.content_length().map(|n| n as usize)
        } else {
            None
        },
        range.as_deref(),
        request.origin.as_deref(),
    )
    .await?;
    if request.head {
        return Ok(());
    }
    let mut received = prefix.len();
    chunk(socket, &prefix).await?;
    time_start(timed, |t| t.player_first_byte_ms = Some(unix_ms()));
    loop {
        authority(state).await?;
        let until = if continuous || media_file {
            Instant::now() + Duration::from_secs(5)
        } else {
            deadline
        };
        let part = tokio::time::timeout_at(until, response.chunk())
            .await
            .map_err(|_| "account-proxy-timeout")?
            .map_err(|_| "account-proxy-network-failed")?;
        let Some(part) = part else { break };
        if !continuous && !media_file && part.len() > FINITE_BODY_LIMIT.saturating_sub(received) {
            return Err("account-proxy-body-limit");
        }
        received = received.saturating_add(part.len());
        for piece in part.chunks(CHUNK) {
            authority(state).await?;
            chunk(socket, piece).await?;
        }
    }
    authority(state).await?;
    socket
        .write_all(b"0\r\n\r\n")
        .await
        .map_err(|_| "account-proxy-write-failed")?;
    Ok(())
}
