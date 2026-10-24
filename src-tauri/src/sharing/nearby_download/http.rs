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

//! One nearby connection: the request head, the page (written for the device
//! that asked: SH-009, SH-011, SH-014, SH-019, SH-020, SH-025) or the file
//! (whole, or from where an interrupted download stopped: HTTP Range with
//! If-Range, so browsers can resume).
use super::*;
use crate::sharing::compatibility::{self, Fit};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Route {
    Page,
    File,
    /// Digits that are not this session's code: a wrong guess, counted.
    WrongCode,
    NotFound,
}

/// The parts of a request head GenX uses; everything else is ignored.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Request {
    pub route: Route,
    pub head_only: bool,
    pub range: Option<String>,
    pub if_range: Option<String>,
    pub user_agent: String,
}

/// Reads a head: GET or HEAD of the page (with or without its final slash,
/// as people type it) or the file, under the code.
pub(crate) fn request(head: &str, token: &str, file: &str) -> Request {
    let mut lines = head.split("\r\n");
    let line = lines.next().unwrap_or("");
    let mut parts = line.split(' ');
    let (method, path, version) = (parts.next(), parts.next(), parts.next());
    let head_only = method == Some("HEAD");
    let valid = matches!(method, Some("GET" | "HEAD"))
        && matches!(version, Some("HTTP/1.1" | "HTTP/1.0"))
        && parts.next().is_none();
    let path = path.unwrap_or("");
    let first = path
        .strip_prefix('/')
        .unwrap_or("")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    let route = if !valid {
        Route::NotFound
    } else if path == format!("/{token}") || path == format!("/{token}/") {
        Route::Page
    } else if path == format!("/{token}/{file}") {
        Route::File
    } else if !first.is_empty() && first != token && first.bytes().all(|b| b.is_ascii_digit()) {
        Route::WrongCode
    } else {
        // favicon.ico and the like: not a guess at the code.
        Route::NotFound
    };
    let (mut range, mut if_range, mut user_agent) = (None, None, String::new());
    for header in lines.take(64) {
        let Some((name, value)) = header.split_once(':') else {
            continue;
        };
        let value = value.trim().chars().take(512).collect::<String>();
        match name.trim().to_ascii_lowercase().as_str() {
            "range" => range = Some(value),
            "if-range" => if_range = Some(value),
            "user-agent" => user_agent = value,
            _ => {}
        }
    }
    Request {
        route,
        head_only,
        range,
        if_range,
        user_agent,
    }
}

/// Which bytes to send.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Bytes {
    Whole,
    /// First and last byte, inclusive.
    Part(u64, u64),
    Unsatisfiable,
}

/// One `bytes=` range ("a-b", "a-" or "-n"). A range is honored only when the
/// file is still the one the browser started (If-Range with this ETag);
/// several ranges, odd units or a different ETag send the whole file (UP-011's
/// rule for the receiving side: never splice different files).
pub(crate) fn bytes(range: Option<&str>, if_range: Option<&str>, etag: &str, total: u64) -> Bytes {
    let Some(range) = range else {
        return Bytes::Whole;
    };
    if if_range.is_some_and(|tag| tag != etag) {
        return Bytes::Whole;
    }
    let Some(spec) = range.strip_prefix("bytes=") else {
        return Bytes::Whole;
    };
    if spec.contains(',') {
        return Bytes::Whole;
    }
    let Some((first, last)) = spec.trim().split_once('-') else {
        return Bytes::Whole;
    };
    let number = |text: &str| -> Option<u64> {
        (!text.is_empty() && text.len() <= 19 && text.bytes().all(|b| b.is_ascii_digit()))
            .then(|| text.parse().ok())
            .flatten()
    };
    if total == 0 {
        return Bytes::Unsatisfiable;
    }
    match (first, last) {
        ("", suffix) => match number(suffix) {
            Some(0) | None => Bytes::Unsatisfiable,
            Some(n) => Bytes::Part(total.saturating_sub(n), total - 1),
        },
        (start, "") => match number(start) {
            Some(start) if start < total => Bytes::Part(start, total - 1),
            Some(_) => Bytes::Unsatisfiable,
            None => Bytes::Whole,
        },
        (start, end) => match (number(start), number(end)) {
            (Some(start), Some(end)) if start <= end && start < total => {
                Bytes::Part(start, end.min(total - 1))
            }
            (Some(_), Some(_)) => Bytes::Unsatisfiable,
            _ => Bytes::Whole,
        },
    }
}

/// The file's ETag: its SHA-256, so a resumed download can only continue the same file.
pub(crate) fn etag(file: &AppFile) -> String {
    format!("\"{}\"", file.sha256)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// AB:CD:… as Android shows certificate fingerprints.
fn fingerprint(hex: &str) -> String {
    hex.as_bytes()
        .chunks(2)
        .map(|pair| String::from_utf8_lossy(pair).to_ascii_uppercase())
        .collect::<Vec<_>>()
        .join(":")
}

/// The page for the device that asked: the download with its requirements,
/// checksum and signer, a plain warning first when the device can't be told,
/// or no download at all when it cannot run here.
pub(crate) fn page(file: &AppFile, user_agent: &str, token: &str) -> String {
    let receiver = compatibility::receiver(user_agent);
    let fit = compatibility::fit(file.package, receiver);
    let platform = compatibility::platform(file.package);
    let mut body = String::new();
    if fit == Fit::Incompatible {
        let device = match receiver {
            compatibility::Receiver::Apple => "an iPhone, iPad or Mac",
            compatibility::Receiver::Windows => "a Windows PC",
            compatibility::Receiver::Android => "an Android device",
            compatibility::Receiver::Unknown => "this device",
        };
        body.push_str(&format!(
            "<h1>This is GenX Streamer for {platform}</h1><p>It won't run on {device}, so it isn't offered here.</p>"
        ));
        if receiver == compatibility::Receiver::Apple {
            body.push_str("<p>GenX Streamer isn't available for iPhone, iPad or Mac yet.</p>");
        } else {
            body.push_str("<p>When you're online, get the right version for this device at <a href=\"https://dougtrier.github.io/GenX-Streamer/get/\">dougtrier.github.io/GenX-Streamer/get</a>.</p>");
        }
    } else {
        body.push_str("<h1>Get GenX Streamer</h1><p>A free TV app, shared from a device nearby. No internet needed for this download.</p>");
        if fit == Fit::Uncertain {
            body.push_str("<p class=\"warn\">This page can't tell what kind of device this is. Download it only if it matches the line below.</p>");
        }
        body.push_str(&format!(
            "<p>{}</p><a class=\"button\" href=\"/{}/{}\" download>Download GenX Streamer ({:.1} MB)</a><p>{}</p><p>Then open GenX Streamer, and you're ready to rock.</p>",
            escape(compatibility::requirements(file.package)),
            escape(token),
            escape(file.name),
            file.bytes as f64 / 1_048_576.0,
            escape(file.guidance),
        ));
        body.push_str(&format!(
            "<p class=\"check\">To check the file: SHA-256 <code>{}</code>",
            escape(&file.sha256)
        ));
        if let Some(signer) = file.signer {
            body.push_str(&format!(
                "<br>Signed by GenX Streamer's official key <code>{}</code>",
                escape(&fingerprint(signer))
            ));
        }
        body.push_str("</p><p>This download is available for a few minutes only.</p>");
    }
    PAGE.replace("{{BODY}}", &body)
}

fn response_head(status: &str, mime: &str, length: u64, extra: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {length}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n{extra}\r\n"
    )
}

/// One connection, on a blocking thread: the head, then the page or the file.
pub(crate) fn serve(
    mut stream: std::net::TcpStream,
    token: &str,
    file: &AppFile,
    stats: &Stats,
    peer: IpAddr,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(60)))?;
    let mut head = Vec::new();
    let mut buffer = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let read = stream.read(&mut buffer)?;
        if read == 0 || head.len() + read > MAX_HEAD {
            return Ok(());
        }
        head.extend_from_slice(&buffer[..read]);
    }
    let head = String::from_utf8_lossy(&head);
    let asked = request(&head, token, file.name);
    let fit = compatibility::fit(file.package, compatibility::receiver(&asked.user_agent));
    match asked.route {
        Route::Page => {
            if let Ok(mut visitors) = stats.visitors.lock() {
                if visitors.len() < 1024 {
                    visitors.insert(peer);
                }
            }
            let body = page(file, &asked.user_agent, token);
            let csp = "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\r\n";
            stream.write_all(
                response_head("200 OK", "text/html; charset=utf-8", body.len() as u64, csp)
                    .as_bytes(),
            )?;
            if !asked.head_only {
                stream.write_all(body.as_bytes())?;
            }
        }
        // SH-019: a file known not to run on the asking device is not handed over.
        Route::File if fit == Fit::Incompatible => {
            let body = "This file won't run on this device.";
            stream.write_all(
                response_head(
                    "403 Forbidden",
                    "text/plain; charset=utf-8",
                    body.len() as u64,
                    "",
                )
                .as_bytes(),
            )?;
            if !asked.head_only {
                stream.write_all(body.as_bytes())?;
            }
        }
        Route::File => {
            let tag = etag(file);
            let common = format!(
                "Accept-Ranges: bytes\r\nETag: {tag}\r\nContent-Disposition: attachment; filename=\"{}\"\r\n",
                file.name
            );
            let wanted = bytes(
                asked.range.as_deref(),
                asked.if_range.as_deref(),
                &tag,
                file.bytes,
            );
            let (status, first, last) = match wanted {
                Bytes::Whole => ("200 OK", 0, file.bytes.saturating_sub(1)),
                Bytes::Part(first, last) => ("206 Partial Content", first, last),
                Bytes::Unsatisfiable => {
                    let extra = format!("Content-Range: bytes */{}\r\n{common}", file.bytes);
                    stream.write_all(
                        response_head("416 Range Not Satisfiable", "text/plain", 0, &extra)
                            .as_bytes(),
                    )?;
                    return stream.flush();
                }
            };
            let length = if file.bytes == 0 { 0 } else { last - first + 1 };
            let extra = if status.starts_with("206") {
                format!(
                    "Content-Range: bytes {first}-{last}/{}\r\n{common}",
                    file.bytes
                )
            } else {
                common
            };
            stream.write_all(response_head(status, file.mime, length, &extra).as_bytes())?;
            if !asked.head_only {
                use std::io::Seek;
                if first == 0 {
                    stats.downloads.fetch_add(1, Ordering::SeqCst);
                }
                let mut source = std::fs::File::open(&file.path)?;
                source.seek(std::io::SeekFrom::Start(first))?;
                let sent = std::io::copy(&mut (&mut source).take(length), &mut stream)?;
                // A download is complete when its last byte has been delivered.
                if sent == length && last + 1 == file.bytes {
                    stats.completed.fetch_add(1, Ordering::SeqCst);
                }
            }
        }
        Route::WrongCode => {
            stats.guesses.record(peer);
            stream.write_all(response_head("404 Not Found", "text/plain", 0, "").as_bytes())?;
        }
        Route::NotFound => {
            stream.write_all(response_head("404 Not Found", "text/plain", 0, "").as_bytes())?;
        }
    }
    stream.flush()
}
