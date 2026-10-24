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

//! Writing the scan candidate manifest: preparing, appending and sealing
//! pages, and finding the current job.

use super::*;

/// Admission proof is private native data. Protection happens after the read transaction ends.
pub struct PreparedPage {
    pub binding: String,
    pub plaintext: Vec<u8>,
    pub(super) request: Append,
    pub(super) header: Header,
    pub(super) url_bytes: u64,
    pub(super) plain_hash: String,
    pub(super) origin_rows: Vec<origin_directory::OriginRow>,
}

pub(super) fn candidate_metadata(
    c: &Connection,
    stored: &Stored,
    ordinal: usize,
) -> Result<Value, String> {
    candidate_metadata_image(c, stored, ordinal, false).map(|(value, _)| value)
}

pub(super) fn candidate_metadata_image(
    c: &Connection,
    stored: &Stored,
    ordinal: usize,
    capture_image: bool,
) -> Result<(Value, Option<CandidateImage>), String> {
    let raw: String = sql(c.query_row(
        "SELECT metadata FROM scan_manifest_candidate WHERE manifest_id=?1 AND ordinal=?2",
        params![stored.header.manifest_id, ordinal as i64],
        |r| r.get(0),
    ))?;
    if raw.len() > PAGE_LIMIT {
        return Err(ERR.into());
    }
    let tuple: Value = serde_json::from_str(&raw).map_err(|_| ERR)?;
    let source_index = tuple[1].as_u64().filter(|n| *n < 100).ok_or(ERR)? as usize;
    let category_index = tuple[4].as_u64().filter(|n| *n < 100_000).ok_or(ERR)? as i64;
    let category: String = sql(c.query_row(
        "SELECT contents FROM scan_manifest_category WHERE manifest_id=?1 AND ordinal=?2",
        params![stored.header.manifest_id, category_index],
        |r| r.get(0),
    ))?;
    if category.len() > 16_384 {
        return Err(ERR.into());
    }
    let source = stored.authority["review"]["sources"]
        .as_array()
        .and_then(|sources| sources.get(source_index))
        .ok_or(ERR)?;
    let value = crate::scan_checkpoint::manifest_candidate_parts(
        &tuple,
        &json!(category),
        source,
        &stored.authority["review"]["sessionRevision"],
    )?;
    Ok((
        value,
        capture_image.then(|| CandidateImage {
            ordinal,
            metadata_hash: Sha256::digest(raw.as_bytes()).into(),
            category_index,
            category_hash: Sha256::digest(category.as_bytes()).into(),
        }),
    ))
}

impl Drop for PreparedPage {
    fn drop(&mut self) {
        self.plaintext.zeroize();
        for entry in &mut self.request.entries {
            entry.urls.zeroize();
        }
    }
}

pub(super) fn binding(
    c: &Connection,
    stored: &Stored,
    metadata: &[Value],
    indices: impl Iterator<Item = usize>,
) -> Result<String, String> {
    let header = &stored.header;
    let namespace: String = sql(c.query_row(
        "SELECT namespace FROM scan_manifest_namespace WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    let bindings: Vec<Value> = metadata
        .iter()
        .zip(indices)
        .map(|(candidate, index)| {
            let definition = stored.authority["sourceDefinitions"]
                .as_array()
                .and_then(|definitions| {
                    definitions
                        .iter()
                        .find(|d| d["source"]["id"] == candidate["sourceId"])
                })
                .ok_or(ERR)?;
            Ok(json!([
                index,
                candidate["key"],
                candidate["sourceId"],
                candidate["sourceFingerprint"],
                definition["definitionFingerprint"],
                candidate["reference"]
            ]))
        })
        .collect::<Result<_, String>>()?;
    let binding = encode(&json!([
        "genx-scan-candidates-v1",
        namespace,
        header.manifest_id,
        header.job_id,
        header.review_digest,
        bindings
    ]))?;
    if binding.len() > BINDING_LIMIT {
        return Err("scan-manifest-binding-limit".into());
    }
    Ok(binding)
}

pub(crate) fn prepare_page(
    c: &Connection,
    request: Append,
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<PreparedPage, String> {
    check_cas(
        context,
        &request.expected_catalog_revision,
        &request.expected_checkpoint_revision,
    )?;
    let mut raw_bytes = 0usize;
    for entry in &request.entries {
        if entry.urls.is_empty() || entry.urls.len() > 16 {
            return Err("scan-manifest-page-limit".into());
        }
        for url in &entry.urls {
            if url.len() > 16_384 {
                return Err("scan-manifest-page-limit".into());
            }
            raw_bytes = raw_bytes.checked_add(url.len()).ok_or(ERR)?;
            if raw_bytes > PAGE_LIMIT {
                return Err("scan-manifest-page-limit".into());
            }
        }
    }
    if request.entries.is_empty()
        || request.entries.len() > 64
        || encode(&request)?.len() > PAGE_LIMIT
    {
        return Err("scan-manifest-page-limit".into());
    }
    let old = stored(c, &request.manifest_id)?;
    authority(c, &old, context)?;
    if old.state != 0 || old.header.manifest_revision != request.expected_manifest_revision {
        return Err("scan-manifest-revision-stale".into());
    }
    let mut metadata = Vec::new();
    let mut url_bytes = 0u64;
    for (offset, entry) in request.entries.iter().enumerate() {
        check()?;
        if entry.candidate_index != old.header.next_index + offset
            || entry.candidate_index >= old.header.candidate_count
        {
            return Err("scan-manifest-order-invalid".into());
        }
        let candidate = candidate_metadata(c, &old, entry.candidate_index)?;
        crate::scan_checkpoint::manifest_urls(&candidate, &entry.urls)?;
        url_bytes += entry.urls.iter().map(|u| u.len() as u64).sum::<u64>();
        metadata.push(candidate);
    }
    if old.url_bytes + url_bytes > URL_LIMIT {
        return Err("scan-manifest-url-limit".into());
    }
    let binding = binding(
        c,
        &old,
        &metadata,
        request.entries.iter().map(|entry| entry.candidate_index),
    )?;
    let plaintext = encode(&request.entries)?.into_bytes();
    if plaintext.len() > PAGE_LIMIT {
        return Err("scan-manifest-page-limit".into());
    }
    let plain_hash = digest(&plaintext);
    let origin_rows = origin_directory::derive_rows(&metadata, &request.entries)?;
    Ok(PreparedPage {
        binding,
        plaintext,
        request,
        header: old.header,
        url_bytes,
        plain_hash,
        origin_rows,
    })
}

pub(crate) fn append_page(
    c: &Connection,
    prepared: &PreparedPage,
    ciphertext: &[u8],
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Header, String> {
    check()?;
    check_cas(
        context,
        &prepared.request.expected_catalog_revision,
        &prepared.request.expected_checkpoint_revision,
    )?;
    let old = stored(c, &prepared.header.manifest_id)?;
    authority(c, &old, context)?;
    if old.state != 0
        || old.header.manifest_revision != prepared.header.manifest_revision
        || old.header.next_index != prepared.header.next_index
    {
        return Err("scan-manifest-revision-stale".into());
    }
    if digest(&prepared.plaintext) != prepared.plain_hash
        || crate::scan_checkpoint::revision(&old.header.manifest_revision)? == i64::MAX
    {
        return Err(ERR.into());
    }
    if ciphertext.is_empty()
        || ciphertext.len() > CIPHER_PAGE_LIMIT
        || old.cipher_bytes + ciphertext.len() as u64 > CIPHER_LIMIT
    {
        return Err("scan-manifest-cipher-limit".into());
    }
    sql(c.execute(
        "INSERT INTO scan_manifest_page VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            old.header.manifest_id,
            old.header.next_index as i64,
            prepared.request.entries.len() as i64,
            prepared.binding,
            prepared.plain_hash,
            ciphertext
        ],
    ))?;
    sql(c.execute("UPDATE scan_manifest SET revision=revision+1,next_index=next_index+?1,url_bytes=url_bytes+?2,cipher_bytes=cipher_bytes+?3 WHERE id=?4",params![prepared.request.entries.len() as i64,prepared.url_bytes as i64,ciphertext.len() as i64,old.header.manifest_id]))?;
    origin_directory::append_capture(c, &old.header.manifest_id, &prepared.origin_rows)?;
    check()?;
    Ok(stored(c, &old.header.manifest_id)?.header)
}

pub(crate) fn seal_seed(
    c: &Connection,
    request: &Seal,
    context: &Context<'_>,
) -> Result<String, String> {
    let old = seal_metadata(c, request, context)?;
    let seed: String = sql(c.query_row(
        "SELECT seed FROM scan_manifest WHERE id=?1",
        [&old.header.manifest_id],
        |r| r.get(0),
    ))?;
    if seed.len() > 20 * 1024 * 1024 {
        return Err(ERR.into());
    }
    Ok(seed)
}

pub(super) fn seal_metadata(
    c: &Connection,
    request: &Seal,
    context: &Context<'_>,
) -> Result<Stored, String> {
    check_cas(
        context,
        &request.expected_catalog_revision,
        &request.expected_checkpoint_revision,
    )?;
    let old = stored(c, &request.manifest_id)?;
    authority(c, &old, context)?;
    if old.state != 0 || old.header.manifest_revision != request.expected_manifest_revision {
        return Err("scan-manifest-revision-stale".into());
    }
    if old.header.next_index != old.header.candidate_count {
        return Err("scan-manifest-incomplete".into());
    }
    let mut pages = sql(c.prepare("SELECT start_index,item_count FROM scan_manifest_page WHERE manifest_id=?1 ORDER BY start_index"))?;
    let rows = sql(pages.query_map([&request.manifest_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
    }))?;
    let mut covered = 0;
    for row in rows {
        let (start, count) = sql(row)?;
        if start != covered || count <= 0 || count > 64 {
            return Err("scan-manifest-incomplete".into());
        }
        covered += count;
    }
    if covered != old.header.candidate_count as i64 {
        return Err("scan-manifest-incomplete".into());
    }
    Ok(old)
}

pub(crate) fn seal(c: &Connection, request: &Seal) -> Result<(), String> {
    let revision = crate::scan_checkpoint::revision(&request.expected_manifest_revision)?;
    if revision == i64::MAX {
        return Err("scan-manifest-revision-stale".into());
    }
    if sql(c.execute(
        "UPDATE scan_manifest SET state=1,revision=revision+1 WHERE id=?1 AND state=0 AND revision=?2",
        params![request.manifest_id, revision],
    ))? != 1
    {
        return Err("scan-manifest-revision-stale".into());
    }
    Ok(())
}

pub(super) fn current_job(
    c: &Connection,
    context: &Context<'_>,
    job: &str,
    digest: &str,
) -> Result<(), String> {
    let _ = context;
    let (current, present): (Option<String>, bool) = sql(c.query_row(
        "SELECT job_id,typeof(contents)!='null' FROM scan_checkpoint WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    if !present || current.as_deref() != Some(job) || digest.len() != 64 {
        return Err("scan-manifest-job-stale".into());
    }
    Ok(())
}

pub(crate) fn find(c: &Connection, request: &Find, context: &Context<'_>) -> Result<Found, String> {
    check_cas(
        context,
        &request.expected_catalog_revision,
        &request.expected_checkpoint_revision,
    )?;
    current_job(c, context, &request.job_id, &request.review_digest)?;
    if !present(c)? {
        return Ok(Found {
            schema_version: 1,
            status: "absent",
            header: None,
        });
    }
    let id = sql(c
        .query_row(
            "SELECT id FROM scan_manifest WHERE job_id=?1 AND review_digest=?2 AND state=1",
            params![request.job_id, request.review_digest],
            |r| r.get::<_, String>(0),
        )
        .optional())?;
    let Some(id) = id else {
        return Ok(Found {
            schema_version: 1,
            status: "absent",
            header: None,
        });
    };
    let old = stored(c, &id)?;
    authority(c, &old, context)?;
    Ok(Found {
        schema_version: 1,
        status: "sealed",
        header: Some(old.header),
    })
}
