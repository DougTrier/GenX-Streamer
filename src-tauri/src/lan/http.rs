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

//! The sharing server's HTTP: reading requests and their bodies, and writing
//! responses, manifests and upstream media.

use super::*;

pub(super) struct Request {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) origin: Option<String>,
    pub(super) cookie: Option<String>,
    pub(super) range: Option<String>,
    pub(super) body: Vec<u8>,
}

pub(super) struct Response {
    pub(super) status: u16,
    pub(super) body: Vec<u8>,
    pub(super) content_type: String,
    pub(super) extra: Vec<(String, String)>,
    pub(super) upstream: Option<relay::OpenedUpstream>,
    pub(super) owner: Option<RequestOwner>,
    pub(super) manifest_budget: Option<tokio::sync::OwnedSemaphorePermit>,
    #[cfg(test)]
    pub(super) writer_probe: Option<Arc<writer_tests::WriterProbe>>,
}

pub(super) enum RequestOwner {
    Media(MediaPermit),
    Control(ControlPermit),
}

impl RequestOwner {
    pub(super) fn valid(&self) -> bool {
        match self {
            Self::Media(permit) => permit.valid(),
            Self::Control(permit) => permit.valid(),
        }
    }
    pub(super) async fn cancelled(&mut self) {
        match self {
            Self::Media(permit) => permit.cancelled().await,
            Self::Control(permit) => permit.cancelled().await,
        }
    }
}

pub(super) fn response(status: u16, body: Vec<u8>) -> Response {
    Response {
        status,
        body,
        content_type: "application/json".into(),
        extra: Vec::new(),
        upstream: None,
        owner: None,
        manifest_budget: None,
        #[cfg(test)]
        writer_probe: None,
    }
}

pub(super) fn error(status: u16, category: &str) -> Response {
    response(status, json(&serde_json::json!({"error": category})))
}

pub(super) async fn read_request(
    stream: &mut TlsStream<tokio::net::TcpStream>,
) -> Result<Request, &'static str> {
    let mut bytes = Vec::new();
    let header_end;
    loop {
        let mut buffer = [0u8; 1024];
        let size = stream
            .read(&mut buffer)
            .await
            .map_err(|_| "request-read-failed")?;
        if size == 0 {
            return Err("request-incomplete");
        }
        bytes.extend_from_slice(&buffer[..size]);
        if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
            header_end = end + 4;
            break;
        }
        if bytes.len() > MAX_HEADER {
            return Err("request-header-large");
        }
    }
    if header_end > MAX_HEADER {
        return Err("request-header-large");
    }
    let text = std::str::from_utf8(&bytes[..header_end]).map_err(|_| "request-invalid")?;
    let mut lines = text.split("\r\n");
    let mut start = lines.next().ok_or("request-invalid")?.split(' ');
    let method = start.next().ok_or("request-invalid")?.to_string();
    let path = start.next().ok_or("request-invalid")?.to_string();
    if start.next() != Some("HTTP/1.1")
        || start.next().is_some()
        || !matches!(method.as_str(), "GET" | "POST")
        || path.len() > 256
        || !path.starts_with('/')
        || path.contains(['%', '\\', '?', '#'])
    {
        return Err("request-target-invalid");
    }
    let mut headers = HashMap::new();
    for line in lines.filter(|l| !l.is_empty()) {
        let (name, value) = line.split_once(':').ok_or("request-header-invalid")?;
        if name.is_empty()
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || headers
                .insert(name.to_ascii_lowercase(), value.trim().to_string())
                .is_some()
        {
            return Err("request-header-duplicate");
        }
    }
    if headers.contains_key("transfer-encoding") {
        return Err("request-transfer-refused");
    }
    let length = headers
        .get("content-length")
        .map(|v| v.parse::<usize>())
        .transpose()
        .map_err(|_| "request-length-invalid")?
        .unwrap_or(0);
    if length > MAX_BODY {
        return Err("request-body-large");
    }
    while bytes.len() < header_end + length {
        let mut buffer = [0u8; 1024];
        let size = stream
            .read(&mut buffer)
            .await
            .map_err(|_| "request-read-failed")?;
        if size == 0 {
            return Err("request-incomplete");
        }
        bytes.extend_from_slice(&buffer[..size]);
    }
    if bytes.len() != header_end + length {
        return Err("request-pipelining-refused");
    }
    Ok(Request {
        method,
        path,
        origin: headers.remove("origin"),
        cookie: headers.remove("cookie"),
        range: headers.remove("range"),
        body: bytes[header_end..].to_vec(),
    })
}

pub(super) fn token(request: &Request) -> Option<&str> {
    request
        .cookie
        .as_deref()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(name, value)| *name == "tmg_viewer" && id(value))
        .map(|(_, value)| value)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PairBody {
    pub(super) secret: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HeartbeatBody {
    pub(super) paused: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct ControlBody {
    pub(super) sequence: u64,
    pub(super) revision: u64,
    pub(super) action: ControlAction,
    pub(super) channel_id: Option<String>,
    pub(super) muted: Option<bool>,
    pub(super) volume: Option<f64>,
}

impl ControlBody {
    pub(super) fn valid(&self) -> bool {
        match self.action {
            ControlAction::Select => {
                self.channel_id
                    .as_ref()
                    .is_some_and(|id| !id.is_empty() && id.len() <= 256)
                    && self.muted.is_none()
                    && self.volume.is_none()
            }
            ControlAction::Mute => {
                self.muted.is_some() && self.channel_id.is_none() && self.volume.is_none()
            }
            ControlAction::Volume => {
                self.volume
                    .is_some_and(|volume| volume.is_finite() && (0.0..=1.0).contains(&volume))
                    && self.channel_id.is_none()
                    && self.muted.is_none()
            }
            _ => self.channel_id.is_none() && self.muted.is_none() && self.volume.is_none(),
        }
    }
}

#[cfg(test)]
pub(super) async fn open_fixture_upstream(
    original: reqwest::Url,
    range: Option<String>,
    base: reqwest::Url,
    deadline: tokio::time::Instant,
) -> Result<relay::OpenedUpstream, &'static str> {
    if range
        .as_ref()
        .is_some_and(|value| !relay::validate_range(value))
    {
        return Err("range-refused");
    }
    let mut endpoint = base
        .join(original.path())
        .map_err(|_| "fixture-url-invalid")?;
    endpoint.set_query(original.query());
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "fixture-client-failed")?;
    let mut request = client.get(endpoint);
    if let Some(range) = range {
        request = request.header(reqwest::header::RANGE, range);
    }
    let response = tokio::time::timeout_at(deadline, request.send())
        .await
        .map_err(|_| "fixture-upstream-timeout")?
        .map_err(|_| "fixture-upstream-failed")?;
    let mut opened =
        relay::OpenedUpstream::from_test_response_with_deadline(response, deadline).await?;
    opened.final_url = original;
    Ok(opened)
}

pub(super) fn supported_manifest(manifest: &str) -> bool {
    if manifest.contains("{$") {
        return false;
    }
    for line in manifest.lines().filter(|line| line.starts_with('#')) {
        if [
            "#EXT-X-DEFINE:",
            "#EXT-X-CONTENT-STEERING:",
            "#EXT-X-PART:",
            "#EXT-X-PRELOAD-HINT:",
            "#EXT-X-SERVER-CONTROL:",
            "#EXT-X-SKIP:",
        ]
        .iter()
        .any(|tag| line.starts_with(tag))
        {
            return false;
        }
        let mut remaining = line;
        while let Some(position) = remaining.find("URI=") {
            let tail = &remaining[position + 4..];
            let Some(quoted) = tail.strip_prefix('"') else {
                return false;
            };
            let Some(end) = quoted.find('"') else {
                return false;
            };
            remaining = &quoted[end + 1..];
        }
    }
    true
}

pub(super) fn safe_header(value: &str) -> Option<&str> {
    if value.len() <= 256 && value.bytes().all(|b| (32..127).contains(&b)) {
        Some(value)
    } else {
        None
    }
}

pub(super) async fn bounded_write<W: AsyncWrite + Unpin>(
    writer: &mut W,
    bytes: &[u8],
) -> Result<(), &'static str> {
    tokio::time::timeout(Duration::from_secs(5), writer.write_all(bytes))
        .await
        .map_err(|_| "response-timeout")?
        .map_err(|_| "response-write-failed")
}

pub(super) async fn write_response<W: AsyncWrite + Unpin>(
    writer: &mut W,
    response: Response,
) -> Result<(), &'static str> {
    let Response {
        status,
        body,
        content_type,
        extra,
        mut upstream,
        mut owner,
        manifest_budget,
        #[cfg(test)]
        writer_probe,
    } = response;
    #[cfg(test)]
    let mut probed_writer = writer_tests::ProbeWriter::new(writer, writer_probe);
    #[cfg(test)]
    let writer = &mut probed_writer;
    // Keep this reservation and the request permit until the actual socket write settles.
    let _reservation = manifest_budget;
    let reason = match status {
        200 => "OK",
        206 => "Partial Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        409 => "Conflict",
        429 => "Too Many Requests",
        404 => "Not Found",
        502 => "Bad Gateway",
        _ => "Service Unavailable",
    };
    let framing = if upstream.is_some() {
        "Transfer-Encoding: chunked\r\n".to_string()
    } else {
        format!("Content-Length: {}\r\n", body.len())
    };
    let mut header = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\n{framing}Connection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n");
    for (name, value) in extra {
        header.push_str(&format!("{name}: {value}\r\n"));
    }
    header.push_str("\r\n");
    let writing = async {
        bounded_write(writer, header.as_bytes()).await?;
        if let Some(upstream) = upstream.as_mut() {
            while let Some(chunk) = upstream.next_chunk().await? {
                if chunk.is_empty() {
                    continue;
                }
                bounded_write(writer, format!("{:x}\r\n", chunk.len()).as_bytes()).await?;
                bounded_write(writer, chunk.as_ref()).await?;
                bounded_write(writer, b"\r\n").await?;
            }
            bounded_write(writer, b"0\r\n\r\n").await?;
        } else {
            bounded_write(writer, &body).await?;
        }
        tokio::time::timeout(Duration::from_secs(5), writer.shutdown())
            .await
            .map_err(|_| "response-timeout")?
            .map_err(|_| "response-write-failed")?;
        Ok(())
    };
    if let Some(owner) = owner.as_mut() {
        if !owner.valid() {
            return Err("consumer-cancelled");
        }
        tokio::select! {
            _ = owner.cancelled() => Err("consumer-cancelled"),
            result = writing => result,
        }
    } else {
        writing.await
    }
}
