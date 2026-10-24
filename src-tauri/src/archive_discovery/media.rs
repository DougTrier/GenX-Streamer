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

//! Artwork and media files: fetching artwork, media hosts and routes, and
//! verifying downloaded files.

use super::*;

pub(super) static ARTWORK_OWNER: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtworkRequest {
    pub schema_version: u32,
    pub request_id: String,
    pub title_ref: String,
    pub expected_revision: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkReply {
    pub schema_version: u32,
    pub title_ref: String,
    pub revision: String,
    pub artwork_ref: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub byte_length: usize,
    pub data_url: String,
}

pub(super) async fn artwork_bytes(
    owner: &Arc<Context>,
    route: MediaRoute,
    image: &catalog::Artwork,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    let mut url = route.url;
    for redirect in 0..=3 {
        check(owner, deadline)?;
        crate::archive_playback_proxy::validate(&url, &route.hosts, &route.tail)?;
        let host = url.host_str().ok_or("archive-artwork-host-refused")?;
        let client = client_for_host(owner, deadline, host).await?;
        let mut response = tokio::time::timeout(
            deadline.saturating_duration_since(Instant::now()),
            client
                .get(url.clone())
                .header(reqwest::header::ACCEPT, &image.mime_type)
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .send(),
        )
        .await
        .map_err(|_| "archive-request-timeout")?
        .map_err(|_| "archive-artwork-network-unavailable")?;
        check(owner, deadline)?;
        if response.status().is_redirection() {
            if redirect == 3 {
                return Err("archive-artwork-redirect-limit".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("archive-artwork-redirect-refused")?;
            url = url
                .join(location)
                .map_err(|_| "archive-artwork-redirect-refused")?;
            continue;
        }
        let expected: u64 = image
            .size_bytes
            .parse()
            .map_err(|_| "archive-artwork-size-refused")?;
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        if response.url() != &url {
            return Err("archive-artwork-response-refused".into());
        }
        crate::archive_artwork::response(
            response.status().as_u16(),
            mime,
            response.content_length(),
            response
                .headers()
                .get(reqwest::header::CONTENT_ENCODING)
                .map(|value| value.as_bytes()),
            response
                .headers()
                .contains_key(reqwest::header::CONTENT_RANGE),
            expected as usize,
            &image.mime_type,
        )?;
        let mut bytes = Vec::new();
        while let Some(chunk) = tokio::time::timeout(
            deadline.saturating_duration_since(Instant::now()),
            response.chunk(),
        )
        .await
        .map_err(|_| "archive-request-timeout")?
        .map_err(|_| "archive-artwork-network-unavailable")?
        {
            check(owner, deadline)?;
            crate::archive_artwork::append(&mut bytes, &chunk, expected as usize)?;
        }
        if bytes.len() as u64 != expected {
            return Err("archive-artwork-size-refused".into());
        }
        check(owner, deadline)?;
        return Ok(bytes);
    }
    Err("archive-artwork-redirect-limit".into())
}

#[tauri::command]
pub async fn archive_title_artwork(
    request: ArtworkRequest,
    app: tauri::AppHandle,
) -> Result<Option<ArtworkReply>, String> {
    if request.schema_version != 1
        || !catalog::text(&request.request_id, 256)
        || !catalog::hex_ref(&request.title_ref)
    {
        return Err("archive-artwork-request-invalid".into());
    }
    catalog::revision(&request.expected_revision)?;
    scan_manifest_work::owned(request.request_id.clone(), app, move |owner| async move {
        let _slot = ARTWORK_OWNER
            .try_acquire()
            .map_err(|_| "archive-artwork-busy")?;
        let deadline = Instant::now() + Duration::from_secs(20);
        let read = request.clone();
        let (source, generation) = owner
            .storage(None, move |store, check| {
                check()?;
                store.with_archive_read(|c| {
                    catalog::artwork_source(c, &read.title_ref, &read.expected_revision)
                })
            })
            .await?;
        check(&owner, deadline)?;
        let client = client(&owner, deadline).await?;
        let url = Url::parse(&format!(
            "https://archive.org/metadata/{}?extended_err=1",
            source.0
        ))
        .map_err(|_| "archive-artwork-request-invalid")?;
        let document = json(&client, url, &owner, deadline, &AtomicUsize::new(0)).await?;
        let image = if extended_deleted(&document)? {
            None
        } else {
            let metadata = document
                .get("metadata")
                .ok_or("archive-metadata-unavailable")?;
            if metadata.get("identifier").and_then(Value::as_str) != Some(source.0.as_str())
                || metadata.get("mediatype").and_then(Value::as_str) != Some("movies")
            {
                return Err("archive-artwork-item-changed".into());
            }
            if metadata
                .get("access-restricted-item")
                .is_some_and(|v| v.as_bool() == Some(true) || v.as_str() == Some("true"))
            {
                None
            } else {
                let files = document
                    .get("files")
                    .and_then(Value::as_array)
                    .filter(|files| files.len() <= 1000)
                    .ok_or("archive-artwork-metadata-limit")?;
                listed_artwork(&source.0, files)
            }
        };
        if source
            .1
            .as_ref()
            .is_some_and(|expected| image.as_ref() != Some(expected))
        {
            return Err("archive-artwork-item-changed".into());
        }
        let result = if let Some(image) = image {
            let route = media_route(&source.0, &image.file_name, &document)?;
            let bytes = artwork_bytes(&owner, route, &image, deadline).await?;
            let (width, height) = crate::archive_artwork::validate(&bytes, &image.mime_type)?;
            use base64::Engine;
            let data_url = format!(
                "data:{};base64,{}",
                image.mime_type,
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            );
            Some(ArtworkReply {
                schema_version: 1,
                title_ref: request.title_ref.clone(),
                revision: request.expected_revision.clone(),
                artwork_ref: image.reference(),
                mime_type: image.mime_type,
                width,
                height,
                byte_length: bytes.len(),
                data_url,
            })
        } else {
            None
        };
        check(&owner, deadline)?;
        let final_read = request.clone();
        owner
            .storage(Some(generation), move |store, check| {
                check()?;
                store.with_archive_read(|c| {
                    let current = catalog::artwork_source(
                        c,
                        &final_read.title_ref,
                        &final_read.expected_revision,
                    )?;
                    if current != source {
                        return Err("archive-artwork-item-changed".into());
                    }
                    check()
                })
            })
            .await?;
        check(&owner, deadline)?;
        Ok(result)
    })
    .await
}

/// Runtime metadata proof for the future native playback owner. This fetches
/// neither media nor a playlist, and never returns upstream data to JavaScript.
pub(crate) struct VerifiedFile {
    pub url: Url,
    pub allowed_hosts: Vec<String>,
    pub size_bytes: u64,
    pub expected_tail: String,
    pub public: Option<crate::archive_provider_discovery::ExactMedia>,
    pub mime: &'static str,
}

pub(crate) fn media_host(host: &str) -> bool {
    host == "archive.org"
        || (host.ends_with(".archive.org")
            && host.len() <= 253
            && (host.starts_with("ia")
                || host
                    .strip_prefix("dn")
                    .and_then(|s| s.split('.').next())
                    .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())))
            && host.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            }))
}

pub(super) fn media_hosts(document: &Value) -> Result<Vec<String>, String> {
    let mut hosts = Vec::new();
    for key in ["d1", "d2", "server"] {
        if let Some(value) = document.get(key).filter(|v| !v.is_null()) {
            let host = value
                .as_str()
                .filter(|h| *h != "archive.org" && media_host(h))
                .ok_or("archive-file-route-unverified")?;
            if !hosts.iter().any(|h| h == host) {
                hosts.push(host.to_owned());
            }
        }
    }
    Ok(hosts)
}

pub(super) fn validate_media_directory<'a>(id: &str, value: &'a Value) -> Result<&'a str, String> {
    let directory = value
        .as_str()
        .filter(|s| s.len() <= 256)
        .ok_or("archive-file-route-unverified")?;
    let directory = directory.strip_suffix('/').unwrap_or(directory);
    let expected = format!("items/{id}");
    let path = directory
        .strip_prefix('/')
        .ok_or("archive-file-route-unverified")?;
    let valid = path == expected
        || path.split_once('/').is_some_and(|(disk, rest)| {
            !disk.is_empty()
                && disk.len() <= 4
                && disk.bytes().all(|b| b.is_ascii_digit())
                && rest == expected
        });
    if !identifier(id) || !valid {
        return Err("archive-file-route-unverified".into());
    }
    Ok(directory)
}

pub(super) struct MediaRoute {
    pub(super) url: Url,
    pub(super) hosts: Vec<String>,
    pub(super) tail: String,
}

pub(super) fn media_route(
    id: &str,
    filename: &str,
    document: &Value,
) -> Result<MediaRoute, String> {
    if !identifier(id)
        || filename.is_empty()
        || filename.len() > 1024
        || filename.contains('\\')
        || filename
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("archive-file-route-unverified".into());
    }
    let mut canonical =
        Url::parse("https://archive.org/download/").map_err(|_| "archive-address-invalid")?;
    {
        let mut segments = canonical
            .path_segments_mut()
            .map_err(|_| "archive-address-invalid")?;
        segments.pop_if_empty();
        segments.push(id);
        for segment in filename.split('/') {
            segments.push(segment);
        }
    }
    let tail = canonical
        .path()
        .strip_prefix("/download/")
        .ok_or("archive-file-route-unverified")?
        .to_owned();
    let mut hosts = media_hosts(document)?;
    let url = if let Some(directory) = document.get("dir").filter(|v| !v.is_null()) {
        let directory = validate_media_directory(id, directory)?;
        let primary = document
            .get("d1")
            .and_then(Value::as_str)
            .filter(|h| hosts.iter().any(|v| v == h))
            .ok_or("archive-file-route-unverified")?;
        let mut url = Url::parse(&format!("https://{primary}/"))
            .map_err(|_| "archive-file-route-unverified")?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| "archive-file-route-unverified")?;
            segments.clear();
            for segment in directory.trim_start_matches('/').split('/') {
                segments.push(segment);
            }
            for segment in filename.split('/') {
                segments.push(segment);
            }
        }
        url
    } else {
        canonical
    };
    hosts.push("archive.org".into());
    Ok(MediaRoute { url, hosts, tail })
}

pub(crate) struct MissingEvidence {
    pub(super) item_id: String,
    pub(super) file_name: String,
    pub(super) observed_ms: i64,
}

impl MissingEvidence {
    pub(crate) fn matches(&self, item: &str, name: &str) -> bool {
        self.item_id == item && self.file_name == name
    }
    pub(crate) fn fresh(&self) -> bool {
        let elapsed = catalog::now_ms()
            .ok()
            .and_then(|now| now.checked_sub(self.observed_ms));
        elapsed.is_some_and(|n| (0..=120_000).contains(&n))
    }
}

pub(crate) enum FileVerification {
    File(Box<VerifiedFile>),
    Missing(MissingEvidence),
}

pub(crate) async fn verify_file(
    owner: Arc<Context>,
    file: &catalog::ResolvedFile,
) -> Result<FileVerification, String> {
    verify_file_with_deadline(owner, file, Instant::now() + Duration::from_secs(20)).await
}

pub(crate) async fn verify_file_with_deadline(
    owner: Arc<Context>,
    file: &catalog::ResolvedFile,
    deadline: Instant,
) -> Result<FileVerification, String> {
    if let Some(public) = &file.public {
        return crate::archive_provider_discovery::verify(owner, public, deadline)
            .await
            .map(|file| FileVerification::File(Box::new(file)));
    }
    let client = client(&owner, deadline).await?;
    let (parsed, route) = if let Some(index) = file.provider_index {
        let budget = Arc::new(AtomicUsize::new(0));
        match verify_partial_file(&client, file, index, owner.clone(), deadline, budget).await {
            Err(e) if e == "archive-item-deleted" => (Metadata::Deleted, None),
            other => other?,
        }
    } else {
        let metadata_url = Url::parse(&format!(
            "https://archive.org/metadata/{}?extended_err=1",
            file.item_id
        ))
        .map_err(|_| "archive-address-invalid")?;
        let data = json(
            &client,
            metadata_url,
            &owner,
            deadline,
            &AtomicUsize::new(0),
        )
        .await?;
        let route = media_route(&file.item_id, &file.file_name, &data)?;
        (parse_metadata(&file.item_id, 0, data, None)?, Some(route))
    };
    check(&owner, deadline)?;
    let title = match parsed {
        Metadata::Deleted => {
            return Ok(FileVerification::Missing(MissingEvidence {
                item_id: file.item_id.clone(),
                file_name: file.file_name.clone(),
                observed_ms: catalog::now_ms()?,
            }))
        }
        Metadata::Title(title)
            if file.provider_index.is_none() && !title.all_file_names.contains(&file.file_name) =>
        {
            return Ok(FileVerification::Missing(MissingEvidence {
                item_id: file.item_id.clone(),
                file_name: file.file_name.clone(),
                observed_ms: catalog::now_ms()?,
            }))
        }
        Metadata::Title(title) => title,
        _ => return Err("archive-file-unavailable".into()),
    };
    let current = title
        .files
        .iter()
        .find(|f| f.name == file.file_name)
        .ok_or("archive-file-unavailable")?;
    if current.size != file.size_bytes || (file.sha1.is_some() && current.sha1 != file.sha1) {
        return Err("archive-file-changed".into());
    }
    let route = route.ok_or("archive-file-route-unverified")?;
    owner.check()?;
    Ok(FileVerification::File(Box::new(VerifiedFile {
        url: route.url,
        allowed_hosts: route.hosts,
        expected_tail: route.tail,
        size_bytes: current.size.parse().map_err(|_| "archive-file-invalid")?,
        public: None,
        mime: "video/mp4",
    })))
}

pub(super) async fn verify_partial_file(
    client: &Client,
    file: &catalog::ResolvedFile,
    index: u32,
    owner: Arc<Context>,
    deadline: Instant,
    budget: Arc<AtomicUsize>,
) -> Result<(Metadata, Option<MediaRoute>), String> {
    let before = partial_header_inner(
        client,
        &file.item_id,
        owner.clone(),
        deadline,
        budget.clone(),
        true,
    )
    .await?;
    if index >= before.count {
        return Err("archive-file-index-changed".into());
    }
    let field = format!("files/{index}");
    let value = partial_field(client, &file.item_id, &field, &owner, deadline, &budget).await?;
    if value.get("name").and_then(Value::as_str) != Some(file.file_name.as_str()) {
        return Err("archive-file-index-changed".into());
    }
    let after = partial_header_inner(
        client,
        &file.item_id,
        owner.clone(),
        deadline,
        budget.clone(),
        true,
    )
    .await?;
    if before.fingerprint != after.fingerprint {
        return Err("archive-item-scope-changed".into());
    }
    let page = catalog::PreparedPage {
        provider_count: before.count,
        next_offset: index + 1,
        fingerprint: before.fingerprint,
        scanned_bytes: 0,
        curation_year: None,
        expected_offset: None,
        expected_fingerprint: None,
        capacity: false,
    };
    let mut document = before.document;
    document["files"] = Value::Array(vec![value]);
    let route = media_route(&file.item_id, &file.file_name, &document)?;
    Ok((
        parse_metadata_page(&file.item_id, 0, document, None, Some(page), index)?,
        Some(route),
    ))
}
