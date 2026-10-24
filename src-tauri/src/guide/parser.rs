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

//! Streaming, offline XMLTV admission. No external DTD/entity resolver is installed.
use chrono::NaiveDate;
use quick_xml::{events::Event, Reader, XmlVersion};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuideChannel {
    pub id: String,
    pub names: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuideProgram {
    pub channel_id: String,
    pub start_ms: i64,
    pub stop_ms: Option<i64>,
    pub title: String,
    pub description: Option<String>,
    #[serde(default)]
    pub categories: Vec<crate::guide::category::GuideCategory>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedGuide {
    pub channels: Vec<GuideChannel>,
    pub programs: Vec<GuideProgram>,
}
#[derive(Clone, Copy)]
pub struct GuideLimits {
    pub expanded_bytes: usize,
    pub channels: usize,
    pub programs: usize,
}
impl Default for GuideLimits {
    fn default() -> Self {
        Self {
            expanded_bytes: 64 * 1024 * 1024,
            channels: 100_000,
            programs: 500_000,
        }
    }
}
fn fail(message: &str) -> String {
    message.to_owned()
}
fn xml_char(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r') || c >= '\u{20}' && c != '\u{fffe}' && c != '\u{ffff}'
}

fn cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err(fail("Guide parsing was cancelled."))
    } else {
        Ok(())
    }
}
fn decode(
    bytes: &[u8],
    limit: usize,
    cancel: &AtomicBool,
) -> Result<(String, &'static str), String> {
    cancelled(cancel)?;
    if bytes.len() > limit {
        return Err(fail("Guide exceeds the expanded XML byte limit."));
    }
    let (body, encoding) = if bytes.starts_with(&[0xff, 0xfe]) {
        (&bytes[2..], "utf-16le")
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        (&bytes[2..], "utf-16be")
    } else if bytes.starts_with(&[b'<', 0, b'?', 0]) {
        (bytes, "utf-16le")
    } else if bytes.starts_with(&[0, b'<', 0, b'?']) {
        (bytes, "utf-16be")
    } else {
        (
            bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes),
            "utf-8",
        )
    };
    let text = if encoding == "utf-8" {
        std::str::from_utf8(body)
            .map_err(|_| fail("Guide UTF-8 is invalid or its encoding is unsupported."))?
            .to_owned()
    } else {
        if body.len() % 2 != 0 {
            return Err(fail("Guide UTF-16 is incomplete."));
        }
        let units = body.chunks_exact(2).map(|p| {
            if encoding == "utf-16le" {
                u16::from_le_bytes([p[0], p[1]])
            } else {
                u16::from_be_bytes([p[0], p[1]])
            }
        });
        let mut out = String::new();
        for (index, value) in char::decode_utf16(units).enumerate() {
            if index % 4096 == 0 {
                cancelled(cancel)?;
            }
            out.push(value.map_err(|_| fail("Guide UTF-16 contains an invalid surrogate."))?);
            if out.len() > limit {
                return Err(fail("Guide exceeds the expanded XML byte limit."));
            }
        }
        out
    };
    for (index, value) in text.chars().enumerate() {
        if index % 4096 == 0 {
            cancelled(cancel)?;
        }
        if !xml_char(value) {
            return Err(fail("Guide contains invalid XML characters."));
        }
    }
    Ok((text, encoding))
}

/// Same explicit policy as the shared domain: second/minute precision, numeric offset <=14:00, absent offset UTC.
pub fn parse_timestamp(value: &str) -> Result<i64, String> {
    let mut parts = value.split_whitespace();
    let digits = parts
        .next()
        .ok_or_else(|| fail("Guide timestamp is incomplete."))?;
    let zone = parts.next();
    if parts.next().is_some()
        || !matches!(digits.len(), 12 | 14)
        || !digits.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(fail(
            "Guide timestamp requires a complete date and numeric timezone.",
        ));
    }
    let number = |a: usize, b: usize| -> u32 { digits[a..b].parse().unwrap_or(0) };
    let year = number(0, 4) as i32;
    if year == 0 {
        return Err(fail("Guide timestamp calendar is invalid."));
    }
    let date = NaiveDate::from_ymd_opt(year, number(4, 6), number(6, 8))
        .and_then(|d| {
            d.and_hms_opt(
                number(8, 10),
                number(10, 12),
                if digits.len() == 14 {
                    number(12, 14)
                } else {
                    0
                },
            )
        })
        .ok_or_else(|| fail("Guide timestamp calendar is invalid."))?;
    let offset = if let Some(zone) = zone {
        let z = zone.as_bytes();
        if z.len() != 5 || !matches!(z[0], b'+' | b'-') || !z[1..].iter().all(u8::is_ascii_digit) {
            return Err(fail("Guide named or malformed timezone is unsupported."));
        }
        let h: i64 = zone[1..3].parse().unwrap_or(99);
        let m: i64 = zone[3..5].parse().unwrap_or(99);
        if h > 14 || m > 59 || h == 14 && m != 0 {
            return Err(fail("Guide timezone offset is invalid."));
        }
        (h * 60 + m) * if z[0] == b'-' { -1 } else { 1 }
    } else {
        0
    };
    Ok(date.and_utc().timestamp_millis() - offset * 60_000)
}

pub fn parse_guide(bytes: &[u8]) -> Result<ParsedGuide, String> {
    parse_guide_with_limits(bytes, GuideLimits::default())
}
pub fn parse_guide_cancelable(bytes: &[u8], cancel: &AtomicBool) -> Result<ParsedGuide, String> {
    parse_inner(bytes, GuideLimits::default(), cancel)
}

/// Limits can be reduced for controlled fixtures; production callers use parse_guide.
pub fn parse_guide_with_limits(bytes: &[u8], limits: GuideLimits) -> Result<ParsedGuide, String> {
    parse_inner(bytes, limits, &AtomicBool::new(false))
}
fn parse_inner(
    bytes: &[u8],
    limits: GuideLimits,
    cancel: &AtomicBool,
) -> Result<ParsedGuide, String> {
    let (text, encoding) = decode(bytes, limits.expanded_bytes, cancel)?;
    let mut reader = Reader::from_str(&text);
    reader.config_mut().check_end_names = true;
    let mut stack: Vec<String> = Vec::new();
    let mut root_seen = false;
    let mut root_closed = false;
    let mut declaration_seen = false;
    let mut doctype_seen = false;
    let mut channels = BTreeMap::<String, GuideChannel>::new();
    let mut programs = Vec::new();
    let mut channel: Option<GuideChannel> = None;
    let mut program: Option<GuideProgram> = None;
    let mut captured = String::new();
    let mut field: Option<String> = None;
    let mut field_language: Option<String> = None;
    let mut channel_count = 0usize;
    loop {
        cancelled(cancel)?;
        match reader
            .read_event()
            .map_err(|_| fail("Guide XML is malformed."))?
        {
            Event::Decl(decl) => {
                if root_seen || declaration_seen || doctype_seen {
                    return Err(fail("Guide XML declaration is misplaced."));
                }
                declaration_seen = true;
                if decl
                    .version()
                    .map_err(|_| fail("Guide XML version is invalid."))?
                    .as_ref()
                    != b"1.0"
                {
                    return Err(fail("Guide requires XML version 1.0."));
                }
                if let Some(declared) = decl.encoding() {
                    let declared =
                        declared.map_err(|_| fail("Guide encoding declaration is invalid."))?;
                    let name = std::str::from_utf8(&declared)
                        .map_err(|_| fail("Guide encoding is unsupported."))?
                        .to_ascii_lowercase();
                    if name != encoding && !(name == "utf-16" && encoding.starts_with("utf-16")) {
                        return Err(fail(
                            "Guide encoding is unsupported or disagrees with its bytes.",
                        ));
                    }
                }
            }
            Event::DocType(value) => {
                let value = value.decode().map_err(|_| fail("Guide DTD is invalid."))?;
                if root_seen
                    || doctype_seen
                    || value.contains('[')
                    || value.contains(']')
                    || value.split_whitespace().next().is_none_or(|v| v != "tv")
                {
                    return Err(fail(
                        "Guide entity declarations and internal DTD subsets are refused.",
                    ));
                }
                doctype_seen = true;
            }
            event @ (Event::Start(_) | Event::Empty(_)) => {
                let empty = matches!(event, Event::Empty(_));
                let node = match event {
                    Event::Start(v) | Event::Empty(v) => v,
                    _ => unreachable!(),
                };
                let name = std::str::from_utf8(node.name().as_ref())
                    .map_err(|_| fail("Guide element name is invalid."))?
                    .to_owned();
                if stack.is_empty() {
                    if root_seen || root_closed || name != "tv" {
                        return Err(fail("Guide requires one XMLTV tv root."));
                    }
                    root_seen = true;
                }
                let mut attrs = BTreeMap::new();
                for attr in node.attributes() {
                    let attr = attr.map_err(|_| fail("Guide XML attributes are malformed."))?;
                    let key = std::str::from_utf8(attr.key.as_ref())
                        .map_err(|_| fail("Guide attribute is invalid."))?
                        .to_owned();
                    let value = attr
                        .normalized_value(XmlVersion::Explicit1_0)
                        .map_err(|_| fail("Guide attribute entity is unsupported."))?
                        .into_owned();
                    if value.len() > 16_384 || !value.chars().all(xml_char) {
                        return Err(fail(
                            "Guide attribute exceeds limits or contains invalid characters.",
                        ));
                    }
                    attrs.insert(key, value);
                }
                if stack.len() == 1 && name == "channel" {
                    channel_count += 1;
                    if channel_count > limits.channels {
                        return Err(fail("Guide exceeds its channel limit."));
                    }
                    let id = attrs
                        .remove("id")
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| fail("Guide channel ID is missing."))?;
                    channel = Some(GuideChannel {
                        id,
                        names: Vec::new(),
                    });
                } else if stack.len() == 1 && name == "programme" {
                    if programs.len() >= limits.programs {
                        return Err(fail("Guide exceeds its program limit."));
                    }
                    let id = attrs
                        .remove("channel")
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| fail("Guide program channel is missing."))?;
                    let start_ms = parse_timestamp(
                        &attrs
                            .remove("start")
                            .ok_or_else(|| fail("Guide program start is missing."))?,
                    )?;
                    let stop_ms = attrs
                        .remove("stop")
                        .map(|v| parse_timestamp(&v))
                        .transpose()?;
                    if stop_ms.is_some_and(|end| end <= start_ms) {
                        return Err(fail("Guide program end must follow its start."));
                    }
                    program = Some(GuideProgram {
                        channel_id: id,
                        start_ms,
                        stop_ms,
                        title: String::new(),
                        description: None,
                        categories: Vec::new(),
                    });
                } else if stack.len() == 2
                    && (channel.is_some() && name == "display-name"
                        || program.is_some()
                            && matches!(name.as_str(), "title" | "desc" | "category"))
                {
                    captured.clear();
                    field = Some(name.clone());
                    field_language = if name == "category" {
                        attrs.remove("lang")
                    } else {
                        None
                    };
                } else if field.is_some() {
                    return Err(fail(
                        "Guide text fields must contain text, not nested elements.",
                    ));
                }
                if stack.len() >= 128 {
                    return Err(fail("Guide XML nesting exceeds its limit."));
                }
                stack.push(name.clone());
                if empty {
                    finish(
                        &name,
                        &mut stack,
                        &mut channel,
                        &mut program,
                        &mut channels,
                        &mut programs,
                        &mut field,
                        &mut field_language,
                        &mut captured,
                        &mut root_closed,
                    )?;
                }
            }
            Event::End(node) => {
                let name = std::str::from_utf8(node.name().as_ref())
                    .map_err(|_| fail("Guide element is invalid."))?
                    .to_owned();
                finish(
                    &name,
                    &mut stack,
                    &mut channel,
                    &mut program,
                    &mut channels,
                    &mut programs,
                    &mut field,
                    &mut field_language,
                    &mut captured,
                    &mut root_closed,
                )?;
            }
            Event::Text(value) => append(
                value
                    .xml_content(XmlVersion::Explicit1_0)
                    .map_err(|_| fail("Guide text encoding is invalid."))?
                    .as_ref(),
                &stack,
                &field,
                &mut captured,
            )?,
            Event::CData(value) => {
                if stack.is_empty() {
                    return Err(fail("Guide CDATA appears outside its root."));
                }
                append(
                    value
                        .xml_content(XmlVersion::Explicit1_0)
                        .map_err(|_| fail("Guide CDATA encoding is invalid."))?
                        .as_ref(),
                    &stack,
                    &field,
                    &mut captured,
                )?;
            }
            Event::GeneralRef(value) => {
                if stack.is_empty() {
                    return Err(fail("Guide entity appears outside its root."));
                }
                let name = value
                    .decode()
                    .map_err(|_| fail("Guide entity is invalid."))?;
                let resolved = quick_xml::escape::unescape(&format!("&{name};"))
                    .map_err(|_| fail("Guide entity is unsupported."))?
                    .into_owned();
                if !resolved.chars().all(xml_char) {
                    return Err(fail("Guide entity contains an invalid XML character."));
                }
                append(&resolved, &stack, &field, &mut captured)?;
            }
            Event::Eof => break,
            Event::Comment(_) | Event::PI(_) => {}
        }
    }
    if !root_seen || !root_closed || !stack.is_empty() {
        return Err(fail("Guide XML root is missing or incomplete."));
    }
    for (index, program) in programs.iter().enumerate() {
        if index % 4096 == 0 {
            cancelled(cancel)?;
        }
        if !channels.contains_key(&program.channel_id) {
            return Err(fail("Guide program refers to an unknown channel ID."));
        }
    }
    programs.sort_by(|a, b| {
        (
            &a.channel_id,
            a.start_ms,
            a.stop_ms,
            &a.title,
            &a.description,
            crate::guide::category::semantic_pairs(&a.categories),
        )
            .cmp(&(
                &b.channel_id,
                b.start_ms,
                b.stop_ms,
                &b.title,
                &b.description,
                crate::guide::category::semantic_pairs(&b.categories),
            ))
    });
    cancelled(cancel)?;
    Ok(ParsedGuide {
        channels: channels.into_values().collect(),
        programs,
    })
}
fn append(
    value: &str,
    stack: &[String],
    field: &Option<String>,
    out: &mut String,
) -> Result<(), String> {
    if field.is_some() {
        if out.len().saturating_add(value.len()) > 65_536 {
            return Err(fail("Guide text exceeds its field limit."));
        }
        out.push_str(value);
    } else if stack.is_empty() && !value.trim().is_empty() {
        return Err(fail("Guide text appears outside its root."));
    }
    Ok(())
}
#[allow(clippy::too_many_arguments)]
fn finish(
    name: &str,
    stack: &mut Vec<String>,
    channel: &mut Option<GuideChannel>,
    program: &mut Option<GuideProgram>,
    channels: &mut BTreeMap<String, GuideChannel>,
    programs: &mut Vec<GuideProgram>,
    field: &mut Option<String>,
    field_language: &mut Option<String>,
    captured: &mut String,
    root_closed: &mut bool,
) -> Result<(), String> {
    if stack.pop().as_deref() != Some(name) {
        return Err(fail("Guide XML closing element is invalid."));
    }
    if field.as_deref() == Some(name) {
        let text = captured.trim().to_owned();
        match name {
            "display-name" => {
                if channel.as_ref().unwrap().names.len() >= 32 {
                    return Err(fail("Guide channel exceeds its display-name limit."));
                }
                if text.is_empty() || text.len() > 512 {
                    return Err(fail("Guide display name is empty or too long."));
                }
                channel.as_mut().unwrap().names.push(text);
            }
            // XMLTV language order is preserved: the first title/description is selected explicitly.
            "title" => {
                if text.is_empty() || text.len() > 16_384 {
                    return Err(fail("Guide title is empty or too long."));
                }
                if program.as_ref().unwrap().title.is_empty() {
                    program.as_mut().unwrap().title = text;
                }
            }
            "category" => {
                let categories = &mut program.as_mut().unwrap().categories;
                crate::guide::category::admit(categories, text, field_language.take())?;
            }
            "desc" if program.as_ref().unwrap().description.is_none() => {
                program.as_mut().unwrap().description = Some(text);
            }
            _ => {}
        }
        *field = None;
        *field_language = None;
        captured.clear();
    }
    if stack.len() == 1 && name == "channel" {
        let value = channel.take().unwrap();
        if value.names.is_empty() {
            return Err(fail("Guide channel display name is missing."));
        }
        if let Some(old) = channels.get(&value.id) {
            if old != &value {
                return Err(fail(
                    "Guide repeats a channel ID with conflicting metadata.",
                ));
            }
        } else {
            channels.insert(value.id.clone(), value);
        }
    } else if stack.len() == 1 && name == "programme" {
        let mut value = program.take().unwrap();
        value.categories = crate::guide::category::canonicalize(value.categories)?;
        if value.title.is_empty() {
            return Err(fail("Guide program title is missing."));
        }
        programs.push(value);
    } else if stack.is_empty() && name == "tv" {
        *root_closed = true;
    }
    Ok(())
}

#[cfg(test)]
#[path = "parser_tests.rs"]
mod tests;
