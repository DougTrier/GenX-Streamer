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

//! Cleaning HLS manifests from the provider before the player reads them.

use super::*;

pub(super) async fn client(
    mut socket: TcpStream,
    state: Arc<Mutex<State>>,
    mut cancel: watch::Receiver<bool>,
) {
    let mut sent = false;
    let mut failure = None;
    tokio::select! { biased;
        _=cancel.changed()=>{},
        _=async { if let Err(code)=process(&mut socket,&state,&mut sent).await { failure=Some(code); } }=>{},
    }
    // Failing before any response: answer 502 with the fixed internal code only
    // (never a provider address, credential or upstream payload), so a failed
    // start is diagnosable instead of an unexplained dropped connection.
    diag(format_args!("outcome={:?} sent={}", failure, sent));
    if let (Some(code), false) = (failure, sent) {
        let reply = format!(
            "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\nX-GenX-Proxy-Error: {code}\r\n\r\n"
        );
        let _ =
            tokio::time::timeout(Duration::from_secs(1), socket.write_all(reply.as_bytes())).await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.shutdown()).await;
}

pub(super) fn scalar(raw: &str) -> bool {
    !raw.is_empty() && raw.len() <= 32 && raw.bytes().all(|b| b.is_ascii_digit())
}

pub(super) fn decimal(raw: &str) -> bool {
    raw.len() <= 32 && raw.split('.').count() <= 2 && raw.split('.').all(scalar)
}

pub(super) fn attrs(raw: &str) -> Result<Vec<(String, String, bool)>, &'static str> {
    let mut values = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    for (i, c) in raw.char_indices().chain(std::iter::once((raw.len(), ','))) {
        if c == '"' {
            quoted = !quoted;
        }
        if c == ',' && !quoted {
            let pair = raw[start..i].trim();
            let (key, value) = pair
                .split_once('=')
                .ok_or("account-proxy-manifest-invalid")?;
            if key.is_empty() || !key.bytes().all(|b| b.is_ascii_uppercase() || b == b'-') {
                return Err("account-proxy-manifest-invalid");
            }
            let is_quoted = value.starts_with('"') && value.ends_with('"') && value.len() >= 2;
            let value = if is_quoted {
                &value[1..value.len() - 1]
            } else {
                value
            };
            if value.len() > 16_384
                || value.contains('"')
                || values.iter().any(|(k, _, _)| k == key)
            {
                return Err("account-proxy-manifest-invalid");
            }
            values.push((key.to_owned(), value.to_owned(), is_quoted));
            start = i + 1;
        }
    }
    if quoted || values.len() > 32 {
        return Err("account-proxy-manifest-invalid");
    }
    Ok(values)
}

/// A manifest tag or attribute name for the developer trace: printable ASCII
/// only, bounded (never a value, which may carry an address or credential).
pub(super) fn printable(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '#' | '-' | '_'))
        .take(48)
        .collect()
}

pub(super) fn clean_manifest(raw: &str, state: &mut State) -> Result<String, &'static str> {
    if raw.len() > MANIFEST_LIMIT {
        return Err("account-proxy-manifest-limit");
    }
    let mut result = String::new();
    let mut header = false;
    for line in raw.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.len() > 16_384 || line.chars().any(char::is_control) {
            return Err("account-proxy-manifest-invalid");
        }
        if line.is_empty() {
            continue;
        }
        if !header {
            if line != "#EXTM3U" {
                return Err("account-proxy-manifest-invalid");
            }
            header = true;
            result.push_str("#EXTM3U\n");
            continue;
        }
        if !line.starts_with('#') {
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            let duration = value
                .split(',')
                .next()
                .ok_or("account-proxy-manifest-invalid")?;
            if !decimal(duration) {
                return Err("account-proxy-manifest-invalid");
            }
            result.push_str(&format!("#EXTINF:{duration},\n"));
            continue;
        }
        let (tag, value) = line.split_once(':').unwrap_or((line, ""));
        if matches!(
            tag,
            "#EXT-X-ENDLIST"
                | "#EXT-X-DISCONTINUITY"
                | "#EXT-X-INDEPENDENT-SEGMENTS"
                | "#EXT-X-I-FRAMES-ONLY"
                | "#EXT-X-GAP"
        ) {
            if !value.is_empty() {
                return Err("account-proxy-manifest-invalid");
            }
            result.push_str(tag);
            result.push('\n');
            continue;
        }
        if matches!(
            tag,
            "#EXT-X-VERSION"
                | "#EXT-X-TARGETDURATION"
                | "#EXT-X-MEDIA-SEQUENCE"
                | "#EXT-X-DISCONTINUITY-SEQUENCE"
        ) {
            if !scalar(value) {
                return Err("account-proxy-manifest-invalid");
            }
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if tag == "#EXT-X-PLAYLIST-TYPE" {
            if !matches!(value, "EVENT" | "VOD") {
                return Err("account-proxy-manifest-invalid");
            }
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if tag == "#EXT-X-PROGRAM-DATE-TIME" {
            if chrono::DateTime::parse_from_rfc3339(value).is_err() {
                return Err("account-proxy-manifest-invalid");
            }
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if tag == "#EXT-X-BYTERANGE" {
            if value.split('@').count() > 2 || !value.split('@').all(scalar) {
                return Err("account-proxy-manifest-invalid");
            }
            result.push_str(line);
            result.push('\n');
            continue;
        }
        let keys: &[&str] = match tag {
            "#EXT-X-STREAM-INF" => &[
                "BANDWIDTH",
                "AVERAGE-BANDWIDTH",
                "CODECS",
                "RESOLUTION",
                "FRAME-RATE",
                "AUDIO",
                "VIDEO",
                "SUBTITLES",
                "CLOSED-CAPTIONS",
            ],
            "#EXT-X-I-FRAME-STREAM-INF" => &[
                "BANDWIDTH",
                "AVERAGE-BANDWIDTH",
                "CODECS",
                "RESOLUTION",
                "VIDEO",
                "URI",
            ],
            "#EXT-X-MEDIA" => &[
                "TYPE",
                "GROUP-ID",
                "NAME",
                "LANGUAGE",
                "DEFAULT",
                "AUTOSELECT",
                "FORCED",
                "INSTREAM-ID",
                "URI",
            ],
            "#EXT-X-KEY" | "#EXT-X-SESSION-KEY" => {
                &["METHOD", "URI", "IV", "KEYFORMAT", "KEYFORMATVERSIONS"]
            }
            "#EXT-X-MAP" => &["URI", "BYTERANGE"],
            "#EXT-X-PART" => &["URI", "DURATION", "INDEPENDENT", "GAP", "BYTERANGE"],
            "#EXT-X-PART-INF" => &["PART-TARGET"],
            "#EXT-X-SERVER-CONTROL" => &[
                "CAN-BLOCK-RELOAD",
                "HOLD-BACK",
                "PART-HOLD-BACK",
                "CAN-SKIP-UNTIL",
                "CAN-SKIP-DATERANGES",
            ],
            "#EXT-X-PRELOAD-HINT" => &["TYPE", "URI", "BYTERANGE-START", "BYTERANGE-LENGTH"],
            "#EXT-X-RENDITION-REPORT" => &["URI", "LAST-MSN", "LAST-PART"],
            "#EXT-X-SKIP" => &["SKIPPED-SEGMENTS"],
            _ if !tag.starts_with("#EXT") => continue,
            // Tags GenX does not know (#EXT-X-ALLOW-CACHE, #EXT-X-DATERANGE,
            // a provider's own) are left out, never passed through: the player
            // only ever sees vetted lines, and no address escapes the relay.
            _ => {
                diag(format_args!("manifest dropped tag {}", printable(tag)));
                continue;
            }
        };
        let mut output = Vec::new();
        for (key, mut value, mut quoted) in attrs(value)? {
            if !keys.contains(&key.as_str()) {
                // Likewise an attribute GenX does not know (PROGRAM-ID).
                diag(format_args!(
                    "manifest dropped {} {}",
                    printable(tag),
                    printable(&key)
                ));
                continue;
            }
            match key.as_str() {
                "URI" => {
                    if !quoted || value.is_empty() {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "AUDIO" | "VIDEO" | "SUBTITLES" | "GROUP-ID" => {
                    value = state.group(&value)?;
                    quoted = true;
                }
                "CLOSED-CAPTIONS" => {
                    if value != "NONE" {
                        value = state.group(&value)?;
                        quoted = true;
                    }
                }
                "NAME" => {
                    value = "Track".into();
                    quoted = true;
                }
                "CODECS" => {
                    if !quoted
                        || value.len() > 512
                        || !value
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b',' | b'-'))
                        || value.split(',').any(|v| {
                            !v.starts_with("avc1")
                                && !v.starts_with("avc3")
                                && !v.starts_with("hvc1")
                                && !v.starts_with("hev1")
                                && !v.starts_with("av01")
                                && !v.starts_with("vp09")
                                && !v.starts_with("mp4a")
                                && !matches!(v, "opus" | "ac-3" | "ec-3" | "stpp" | "wvtt")
                        })
                    {
                        // An unknown codec label is left out; the player
                        // decides from the media itself.
                        diag(format_args!("manifest dropped CODECS"));
                        continue;
                    }
                }
                "RESOLUTION" => {
                    let mut v = value.split('x');
                    if !v.next().is_some_and(scalar)
                        || !v.next().is_some_and(scalar)
                        || v.next().is_some()
                    {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "LANGUAGE" => {
                    if value.len() > 35
                        || !value.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-')
                    {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "TYPE" => {
                    if !matches!(
                        value.as_str(),
                        "AUDIO" | "VIDEO" | "SUBTITLES" | "CLOSED-CAPTIONS" | "PART" | "MAP"
                    ) {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "METHOD" => {
                    if !matches!(value.as_str(), "NONE" | "AES-128") {
                        return Err("account-proxy-encryption-unsupported");
                    }
                }
                "KEYFORMAT" => {
                    if value != "identity" {
                        return Err("account-proxy-encryption-unsupported");
                    }
                }
                "KEYFORMATVERSIONS" => {
                    if value != "1" {
                        return Err("account-proxy-encryption-unsupported");
                    }
                }
                "IV" => {
                    if !value
                        .strip_prefix("0x")
                        .is_some_and(|v| v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit()))
                    {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "DEFAULT"
                | "AUTOSELECT"
                | "FORCED"
                | "INDEPENDENT"
                | "GAP"
                | "CAN-BLOCK-RELOAD"
                | "CAN-SKIP-DATERANGES" => {
                    if !matches!(value.as_str(), "YES" | "NO") {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "BYTERANGE" => {
                    if value.split('@').count() > 2 || !value.split('@').all(scalar) {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "INSTREAM-ID" => {
                    if !(value
                        .strip_prefix("CC")
                        .is_some_and(|v| v.parse::<u8>().is_ok_and(|v| (1..=4).contains(&v)))
                        || value
                            .strip_prefix("SERVICE")
                            .is_some_and(|v| v.parse::<u8>().is_ok_and(|v| (1..=63).contains(&v))))
                    {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                "FRAME-RATE" | "DURATION" | "PART-TARGET" | "HOLD-BACK" | "PART-HOLD-BACK"
                | "CAN-SKIP-UNTIL" => {
                    if !decimal(&value) {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
                _ => {
                    if !scalar(&value) {
                        return Err("account-proxy-manifest-invalid");
                    }
                }
            }
            output.push(if quoted {
                format!("{key}=\"{value}\"")
            } else {
                format!("{key}={value}")
            });
        }
        result.push_str(tag);
        result.push(':');
        result.push_str(&output.join(","));
        result.push('\n');
        if result.len() > MANIFEST_LIMIT {
            return Err("account-proxy-manifest-limit");
        }
    }
    if !header {
        return Err("account-proxy-manifest-invalid");
    }
    Ok(result)
}
