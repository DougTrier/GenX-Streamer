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

//! Reading and parsing the player's requests to the local proxy.

use super::*;

pub(super) struct Request {
    pub(super) id: String,
    pub(super) range: Option<String>,
    pub(super) head: bool,
    pub(super) options: bool,
    pub(super) origin: Option<String>,
}

pub(super) fn parse_request(bytes: &[u8], state: &State) -> Result<Request, &'static str> {
    let text = std::str::from_utf8(bytes).map_err(|_| "account-proxy-request-refused")?;
    let mut lines = text.split("\r\n");
    let mut first = lines
        .next()
        .ok_or("account-proxy-request-refused")?
        .split(' ');
    let method = first.next().ok_or("account-proxy-request-refused")?;
    let path = first.next().ok_or("account-proxy-request-refused")?;
    let version = first.next().ok_or("account-proxy-request-refused")?;
    if !matches!(method, "GET" | "HEAD" | "OPTIONS")
        || !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || first.next().is_some()
    {
        return Err("account-proxy-request-refused");
    }
    let prefix = format!("/account/{}/media/", state.capability);
    let id = path
        .strip_prefix(&prefix)
        .filter(|v| valid_cap(v))
        .ok_or("account-proxy-resource-refused")?;
    let mut host = None;
    let mut origin = None;
    let mut range = None;
    let mut cross_site = false;
    for line in lines.filter(|line| !line.is_empty()) {
        let (key, value) = line
            .split_once(':')
            .ok_or("account-proxy-request-refused")?;
        let value = value.trim();
        if key.eq_ignore_ascii_case("host") && host.replace(value).is_some() {
            return Err("account-proxy-request-refused");
        }
        if key.eq_ignore_ascii_case("origin") {
            if origin.is_some() || !cors(value) {
                return Err("account-proxy-origin-refused");
            }
            origin = Some(value.to_owned());
        }
        if key.eq_ignore_ascii_case("range") {
            if range.is_some() || !relay::validate_range(value) {
                return Err("account-proxy-range-refused");
            }
            range = Some(value.to_owned());
        }
        if key.eq_ignore_ascii_case("transfer-encoding")
            || (key.eq_ignore_ascii_case("content-length") && value != "0")
        {
            return Err("account-proxy-request-refused");
        }
        if key.eq_ignore_ascii_case("sec-fetch-site") && value == "cross-site" {
            cross_site = true;
        }
    }
    if cross_site && origin.is_none() {
        return Err("account-proxy-origin-refused");
    }
    if host != state.local_origin.strip_prefix("http://") {
        return Err("account-proxy-host-refused");
    }
    Ok(Request {
        id: id.to_owned(),
        range,
        head: method == "HEAD",
        options: method == "OPTIONS",
        origin,
    })
}

pub(super) async fn read_request(
    socket: &mut TcpStream,
    state: &Arc<Mutex<State>>,
) -> Result<Request, &'static str> {
    let work = async {
        let mut bytes = Vec::new();
        let mut part = [0u8; 1024];
        loop {
            let n = socket
                .read(&mut part)
                .await
                .map_err(|_| "account-proxy-request-refused")?;
            if n == 0 || bytes.len() + n > HEADER_LIMIT {
                return Err("account-proxy-request-refused");
            }
            bytes.extend_from_slice(&part[..n]);
            if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                if end + 4 != bytes.len() {
                    return Err("account-proxy-request-refused");
                }
                let captured = state.lock().map_err(|_| "account-proxy-state")?;
                return parse_request(&bytes, &captured);
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(3), work)
        .await
        .map_err(|_| "account-proxy-request-refused")?
}
