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

//! Parsing archive metadata: identifiers, years, durations, servers, artwork
//! and metadata pages, and search aliases.

use super::*;

pub(super) fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && s.as_bytes()[0].is_ascii_alphanumeric()
}

pub(super) fn string(v: &Value, key: &str, max: usize) -> Option<String> {
    v.get(key)?
        .as_str()
        .filter(|s| catalog::text(s, max))
        .map(str::to_owned)
}

pub(super) fn year(v: &Value) -> Option<i64> {
    // Original item date/year metadata only. Never addeddate/publicdate/upload.
    for key in ["year", "date"] {
        let Some(raw) = v.get(key) else {
            continue;
        };
        let Some(text) = raw
            .as_str()
            .map(str::to_owned)
            .or_else(|| raw.as_u64().map(|n| n.to_string()))
        else {
            continue;
        };
        if text.len() >= 4
            && text.as_bytes()[..4].iter().all(u8::is_ascii_digit)
            && (text.len() == 4 || text.as_bytes()[4] == b'-')
        {
            if let Ok(y) = text[..4].parse::<i64>() {
                if (1888..=2100).contains(&y) {
                    return Some(y);
                }
            }
        }
    }
    None
}

pub(super) fn duration(v: &Value) -> Option<f64> {
    let raw = v.get("length")?;
    let seconds = raw.as_f64().or_else(|| {
        let value = raw.as_str()?.trim();
        if value.is_empty()
            || value.len() > 32
            || !value
                .bytes()
                .all(|b| b.is_ascii_digit() || b == b'.' || b == b':')
        {
            return None;
        }
        if !value.contains(':') {
            return value.parse::<f64>().ok();
        }
        let parts: Vec<&str> = value.split(':').collect();
        if !(2..=3).contains(&parts.len()) {
            return None;
        }
        let seconds = parts.last()?.parse::<f64>().ok()?;
        if !seconds.is_finite() || !(0.0..60.0).contains(&seconds) {
            return None;
        }
        let minutes = parts[parts.len() - 2].parse::<u64>().ok()?;
        if parts.len() == 3 {
            if minutes >= 60 {
                return None;
            }
            let hours = parts[0].parse::<u64>().ok()?;
            Some(
                hours
                    .checked_mul(3600)?
                    .checked_add(minutes.checked_mul(60)?)? as f64
                    + seconds,
            )
        } else {
            Some(minutes.checked_mul(60)? as f64 + seconds)
        }
    })?;
    if seconds.is_finite() && seconds > 0.0 && seconds <= 7.0 * 86400.0 {
        Some(seconds)
    } else {
        None
    }
}

pub(super) fn servers(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for key in ["d1", "d2", "server"] {
        if let Some(s) = v.get(key).and_then(Value::as_str) {
            if s.len() <= 253
                && s.ends_with(".archive.org")
                && s.starts_with("ia")
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
                && !out.iter().any(|x| x == s)
            {
                out.push(s.to_owned());
            }
        }
    }
    out
}

pub(super) enum Metadata {
    Title(Box<catalog::PreparedTitle>),
    Deleted,
    UnknownYear,
    Unavailable,
}

pub(super) fn extended_deleted(v: &Value) -> Result<bool, String> {
    if let Some(code) = v.get("errcode") {
        match code.as_u64() {
            Some(104) => return Ok(true),
            Some(0) if v.get("error").is_none() => {}
            _ => return Err("archive-metadata-unavailable".into()),
        }
    }
    if v.get("error").is_some() {
        return Err("archive-metadata-unavailable".into());
    }
    Ok(false)
}

pub(super) fn listed_artwork(id: &str, files: &[Value]) -> Option<catalog::Artwork> {
    files
        .iter()
        .filter_map(|file| {
            let name = file.get("name")?.as_str()?;
            let mime = match name {
                "__ia_thumb.jpg" => "image/jpeg",
                "__ia_thumb.png" => "image/png",
                _ => return None,
            };
            if file.get("format").and_then(Value::as_str) != Some("Item Tile")
                || file
                    .get("private")
                    .is_some_and(|v| v.as_bool() == Some(true) || v.as_str() == Some("true"))
            {
                return None;
            }
            let image = catalog::Artwork {
                item_id: id.into(),
                file_name: name.into(),
                size_bytes: file.get("size")?.as_str()?.into(),
                mime_type: mime.into(),
                provider_sha1: file.get("sha1").and_then(Value::as_str).map(str::to_owned),
            };
            image.validate().then_some(image)
        })
        .next()
}

// Both official labels explicitly claim the codec. Generic MPEG4/container or
// extension labels are insufficient. Fresh playback proof reuses this parser.
pub(super) fn h264_format(value: &str) -> bool {
    value.eq_ignore_ascii_case("h.264") || value.eq_ignore_ascii_case("h.264 IA")
}

pub(super) fn parse_metadata(
    id: &str,
    downloads: i64,
    v: Value,
    requested_year: Option<i64>,
) -> Result<Metadata, String> {
    parse_metadata_page(id, downloads, v, requested_year, None, 0)
}

pub(super) fn parse_metadata_page(
    id: &str,
    downloads: i64,
    v: Value,
    requested_year: Option<i64>,
    partial: Option<catalog::PreparedPage>,
    provider_start: u32,
) -> Result<Metadata, String> {
    if extended_deleted(&v)? {
        return Ok(Metadata::Deleted);
    }
    let Some(metadata) = v.get("metadata") else {
        return Ok(Metadata::Unavailable);
    };
    if metadata
        .get("identifier")
        .and_then(Value::as_str)
        .is_some_and(|s| s != id)
        || metadata.get("mediatype").and_then(Value::as_str) != Some("movies")
        || metadata
            .get("access-restricted-item")
            .is_some_and(|x| x.as_bool() == Some(true) || x.as_str() == Some("true"))
    {
        return Ok(Metadata::Unavailable);
    }
    let released = year(metadata);
    if requested_year.is_some() && released != requested_year {
        return Ok(Metadata::UnknownYear);
    }
    let title = string(metadata, "title", 512).ok_or("archive-title-invalid")?;
    let field = |key: &str| -> Result<String, String> {
        let mut out = String::new();
        if let Some(value) = metadata.get(key) {
            append_search_aliases(&mut out, value)?;
        }
        Ok(out.trim().to_owned())
    };
    let language = field("language")?;
    let languages: Vec<String> = language
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .take(17)
        .map(str::to_owned)
        .collect();
    if languages.len() > 16 || languages.iter().any(|s| !catalog::text(s, 128)) {
        return Err("archive-search-metadata-limit".into());
    }
    let mut search_metadata = catalog::SearchMetadata {
        title: title.clone(),
        series: field("series")?,
        subjects: field("subject")?,
        collections: field("collection")?,
        description: string(metadata, "description", 4096).unwrap_or_default(),
        languages,
        provider_type: field("type")?,
        artwork: None,
    };
    let files = v
        .get("files")
        .and_then(Value::as_array)
        .ok_or("archive-files-invalid")?;
    if files.len() > if partial.is_some() { 64 } else { 1000 }
        || (partial.is_none()
            && v.get("files_count")
                .and_then(Value::as_u64)
                .is_some_and(|n| n != files.len() as u64))
    {
        return Err("archive-file-limit".into());
    }
    search_metadata.artwork = listed_artwork(id, files);
    let mut names = Vec::new();
    let mut prepared = Vec::new();
    let mut originals = std::collections::HashSet::new();
    for (index, file) in files.iter().enumerate() {
        let name = string(file, "name", 1024).ok_or("archive-file-invalid")?;
        if name.starts_with('/')
            || name.contains('\\')
            || name
                .split('/')
                .any(|s| s == ".." || s == "." || s.is_empty())
            || names.contains(&name)
        {
            return Err("archive-file-invalid".into());
        }
        names.push(name.clone());
        if file
            .get("format")
            .and_then(Value::as_str)
            .is_none_or(|f| !h264_format(f))
        {
            continue;
        }
        if file
            .get("private")
            .is_some_and(|x| x.as_bool() == Some(true) || x.as_str() == Some("true"))
        {
            continue;
        }
        let size = file
            .get("size")
            .and_then(Value::as_str)
            .ok_or("archive-file-invalid")?;
        if size.is_empty()
            || size.len() > 19
            || !size.bytes().all(|b| b.is_ascii_digit())
            || (size.len() > 1 && size.starts_with('0'))
            || size
                .parse::<u64>()
                .ok()
                .is_none_or(|n| n == 0 || n > 64 * 1024 * 1024 * 1024)
        {
            return Err("archive-file-invalid".into());
        }
        let sha1 = file
            .get("sha1")
            .and_then(Value::as_str)
            .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(str::to_ascii_lowercase);
        let original = file
            .get("original")
            .and_then(Value::as_str)
            .filter(|s| catalog::text(s, 1024) && !s.contains("://"))
            .map(str::to_owned)
            .or_else(|| {
                (file.get("source").and_then(Value::as_str) == Some("original"))
                    .then(|| name.clone())
            });
        if let Some(original) = &original {
            originals.insert(original.clone());
        }
        prepared.push(catalog::PreparedFile {
            file_title: string(file, "title", 512),
            provider_index: partial.as_ref().map(|_| provider_start + index as u32),
            original,
            name,
            size: size.to_owned(),
            duration: duration(file),
            sha1,
        });
    }
    let series = catalog::content_type(Some(&search_metadata)) == catalog::ContentType::Tv;
    // A lone episode with a series label cannot consume a distinct-program
    // curation slot. Multi-original-file TV items are one provider item title;
    // unrelated uploads are never combined by title or the series label.
    if partial.is_none() && requested_year.is_some() && series && originals.len() < 2 {
        return Ok(Metadata::Unavailable);
    }
    let search_aliases = catalog::encode_search_metadata(&search_metadata)?;
    if search_aliases.len() > 16384 {
        return Err("archive-search-metadata-limit".into());
    }
    // Item identity is retained; never merge different uploads by a series label.
    Ok(Metadata::Title(Box::new(catalog::PreparedTitle {
        partial,
        item_id: id.to_owned(),
        title,
        search_aliases,
        kind: if series { "tv" } else { "movie" },
        year: released,
        rights: string(metadata, "rights", 2048).filter(|s| !s.contains("://")),
        downloads,
        servers: servers(&v),
        all_file_names: names,
        files: prepared,
    })))
}

pub(super) fn append_search_aliases(out: &mut String, value: &Value) -> Result<(), String> {
    let values: Vec<&Value> = match value {
        Value::String(_) => vec![value],
        Value::Array(values) if values.len() <= 1000 => values.iter().collect(),
        Value::Null => return Ok(()),
        _ => return Err("archive-search-metadata-invalid".into()),
    };
    for value in values {
        let s = value.as_str().ok_or("archive-search-metadata-invalid")?;
        if s.trim().is_empty() {
            continue;
        }
        if !catalog::text(s, 2048) || out.len() + s.len() + 1 > 16384 {
            return Err("archive-search-metadata-limit".into());
        }
        out.push('\n');
        out.push_str(s);
    }
    Ok(())
}
