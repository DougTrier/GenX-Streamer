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

//! Reading the scan candidate manifest: encrypted pages, verifying reads and
//! authenticated pages.

use super::*;

pub struct EncryptedPage {
    pub binding: String,
    pub ciphertext: Vec<u8>,
    pub(super) header: Header,
    pub(super) start_index: usize,
    pub(super) count: usize,
    pub(super) plain_hash: String,
    pub(super) metadata: Vec<Value>,
    pub(super) images: Vec<CandidateImage>,
    pub(super) namespace: String,
    pub(super) authority_hash: [u8; 32],
}

pub(super) struct CandidateImage {
    pub(super) ordinal: usize,
    pub(super) metadata_hash: [u8; 32],
    pub(super) category_index: i64,
    pub(super) category_hash: [u8; 32],
}

// Private complete image proof; only a fully authenticated cached page may retain it.
pub(crate) struct ReadIdentity {
    pub(super) header: Header,
    pub(super) start_index: usize,
    pub(super) count: usize,
    pub(super) binding: String,
    pub(super) plain_hash: String,
    pub(super) ciphertext: Zeroizing<Vec<u8>>,
    pub(super) images: Vec<CandidateImage>,
    pub(super) namespace: String,
    pub(super) authority_hash: [u8; 32],
}

impl EncryptedPage {
    pub(crate) fn take_identity(&mut self) -> ReadIdentity {
        ReadIdentity {
            header: self.header.clone(),
            start_index: self.start_index,
            count: self.count,
            binding: self.binding.clone(),
            plain_hash: self.plain_hash.clone(),
            ciphertext: Zeroizing::new(self.ciphertext.clone()),
            images: std::mem::take(&mut self.images),
            namespace: self.namespace.clone(),
            authority_hash: self.authority_hash,
        }
    }
}

pub(crate) fn read_page(
    c: &Connection,
    request: &Read,
    context: &Context<'_>,
) -> Result<EncryptedPage, String> {
    if request.start_index >= 100_000 {
        return Err("scan-manifest-order-invalid".into());
    }
    check_cas(
        context,
        &request.expected_catalog_revision,
        &request.expected_checkpoint_revision,
    )?;
    current_job(c, context, &request.job_id, &request.review_digest)?;
    let old = stored(c, &request.manifest_id)?;
    authority(c, &old, context)?;
    if old.state != 1
        || old.header.job_id != request.job_id
        || old.header.review_digest != request.review_digest
    {
        return Err("scan-manifest-job-stale".into());
    }
    let (count, binding, plain_hash, ciphertext) = sql(c
        .query_row(
            "SELECT item_count,binding,plain_hash,ciphertext FROM scan_manifest_page WHERE manifest_id=?1 AND start_index=?2",
            params![request.manifest_id, request.start_index as i64],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                ))
            },
        )
        .optional())?
    .ok_or("scan-manifest-page-absent")?;
    if count <= 0
        || count > 64
        || binding.len() > BINDING_LIMIT
        || ciphertext.is_empty()
        || ciphertext.len() > CIPHER_PAGE_LIMIT
    {
        return Err(ERR.into());
    }
    let count = count as usize;
    let mut metadata = Vec::with_capacity(count);
    let mut images = Vec::with_capacity(count);
    for ordinal in request.start_index..request.start_index + count {
        let (value, image) = candidate_metadata_image(c, &old, ordinal, true)?;
        metadata.push(value);
        images.push(image.ok_or(ERR)?);
    }
    if super::binding(
        c,
        &old,
        &metadata,
        request.start_index..request.start_index + count,
    )? != binding
    {
        return Err("scan-manifest-binding-mismatch".into());
    }
    Ok(EncryptedPage {
        binding,
        ciphertext,
        header: old.header,
        start_index: request.start_index,
        count,
        plain_hash,
        metadata,
        images,
        namespace: sql(c.query_row(
            "SELECT namespace FROM scan_manifest_namespace WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?,
        authority_hash: Sha256::digest(encode(&old.authority)?.as_bytes()).into(),
    })
}

pub(crate) fn verify_read(
    c: &Connection,
    request: &Read,
    context: &Context<'_>,
    page: &EncryptedPage,
) -> Result<(), String> {
    check_cas(
        context,
        &request.expected_catalog_revision,
        &request.expected_checkpoint_revision,
    )?;
    current_job(c, context, &request.job_id, &request.review_digest)?;
    let old = stored(c, &request.manifest_id)?;
    authority(c, &old, context)?;
    if old.state != 1
        || old.header.manifest_revision != page.header.manifest_revision
        || old.header.manifest_id != page.header.manifest_id
    {
        return Err("scan-manifest-revision-stale".into());
    }
    Ok(())
}

// A cache hit still reads all relevant bytes in the current SQL snapshot. It
// avoids decrypting/parsing/rebuilding the page; it is not an O(1) index proof.
pub(crate) fn verify_cached_read(
    c: &Connection,
    request: &Read,
    context: &Context<'_>,
    image: &ReadIdentity,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    check()?;
    check_cas(
        context,
        &request.expected_catalog_revision,
        &request.expected_checkpoint_revision,
    )?;
    current_job(c, context, &request.job_id, &request.review_digest)?;
    let old = stored(c, &request.manifest_id)?;
    authority(c, &old, context)?;
    if old.state != 1
        || encode(&old.header)? != encode(&image.header)?
        || Sha256::digest(encode(&old.authority)?.as_bytes()).as_slice() != image.authority_hash
    {
        return Err("scan-manifest-revision-stale".into());
    }
    let namespace: String = sql(c.query_row(
        "SELECT namespace FROM scan_manifest_namespace WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    if namespace != image.namespace {
        return Err("scan-manifest-binding-mismatch".into());
    }
    let exact:bool=sql(c.query_row("SELECT EXISTS(SELECT 1 FROM scan_manifest_page WHERE manifest_id=?1 AND start_index=?2 AND item_count=?3 AND binding COLLATE BINARY=?4 AND plain_hash COLLATE BINARY=?5 AND ciphertext=?6)",
        params![request.manifest_id,image.start_index as i64,image.count as i64,image.binding,image.plain_hash,image.ciphertext.as_slice()],|r|r.get(0)))?;
    if !exact {
        return Err("scan-manifest-authentication-failed".into());
    }
    let mut statement = sql(c.prepare(
        "SELECT ordinal,metadata FROM scan_manifest_candidate WHERE manifest_id=?1 AND ordinal>=?2 AND ordinal<?3 ORDER BY ordinal",
    ))?;
    let mut rows = sql(statement.query(params![
        request.manifest_id,
        image.start_index as i64,
        (image.start_index + image.count) as i64
    ]))?;
    for expected in &image.images {
        check()?;
        let row = sql(rows.next())?.ok_or("scan-manifest-binding-mismatch")?;
        let ordinal: i64 = sql(row.get(0))?;
        let raw: String = sql(row.get(1))?;
        if ordinal != expected.ordinal as i64
            || raw.len() > PAGE_LIMIT
            || Sha256::digest(raw.as_bytes()).as_slice() != expected.metadata_hash
        {
            return Err("scan-manifest-binding-mismatch".into());
        }
    }
    if sql(rows.next())?.is_some() || image.images.len() != image.count {
        return Err("scan-manifest-binding-mismatch".into());
    }
    let mut categories = std::collections::BTreeMap::new();
    for expected in &image.images {
        if categories
            .insert(expected.category_index, expected.category_hash)
            .is_some_and(|previous| previous != expected.category_hash)
        {
            return Err("scan-manifest-binding-mismatch".into());
        }
    }
    let placeholders = (2..=categories.len() + 1)
        .map(|n| format!("?{n}"))
        .collect::<Vec<_>>()
        .join(",");
    let query =
        format!("SELECT ordinal,contents FROM scan_manifest_category WHERE manifest_id=?1 AND ordinal IN({placeholders}) ORDER BY ordinal");
    let mut args = vec![rusqlite::types::Value::Text(request.manifest_id.clone())];
    args.extend(
        categories
            .keys()
            .map(|index| rusqlite::types::Value::Integer(*index)),
    );
    let mut statement = sql(c.prepare(&query))?;
    let mut rows = sql(statement.query(rusqlite::params_from_iter(args)))?;
    for (index, hash) in categories {
        check()?;
        let row = sql(rows.next())?.ok_or("scan-manifest-binding-mismatch")?;
        let ordinal: i64 = sql(row.get(0))?;
        let raw: String = sql(row.get(1))?;
        if ordinal != index
            || raw.len() > 16384
            || Sha256::digest(raw.as_bytes()).as_slice() != hash
        {
            return Err("scan-manifest-binding-mismatch".into());
        }
    }
    if sql(rows.next())?.is_some() {
        return Err("scan-manifest-binding-mismatch".into());
    }
    check()
}

pub fn finish_page(page: EncryptedPage, plaintext: Vec<u8>) -> Result<Page, String> {
    Ok(finish_page_authenticated(page, plaintext)?.into_legacy())
}

/// Native-only result after exact plaintext/binding/URL metadata validation.
/// Root must additionally finish the same-generation SQL verify_read before delivery.
pub(crate) struct AuthenticatedPage {
    pub page: Page,
    pub metadata: Vec<Value>,
}

impl AuthenticatedPage {
    pub(crate) fn selected(&self, index: usize) -> Result<Self, String> {
        let offset = index
            .checked_sub(self.page.start_index)
            .ok_or("scan-resume-page-invalid")?;
        let entry = self
            .page
            .entries
            .get(offset)
            .ok_or("scan-resume-page-invalid")?;
        let metadata = self
            .metadata
            .get(offset)
            .ok_or("scan-resume-page-invalid")?;
        if entry.candidate_index != index {
            return Err("scan-resume-page-invalid".into());
        }
        Ok(Self {
            page: Page {
                schema_version: self.page.schema_version,
                manifest_id: self.page.manifest_id.clone(),
                job_id: self.page.job_id.clone(),
                review_digest: self.page.review_digest.clone(),
                manifest_revision: self.page.manifest_revision.clone(),
                start_index: index,
                next_index: index + 1,
                entries: vec![entry.clone()],
            },
            metadata: vec![metadata.clone()],
        })
    }
    pub(super) fn into_legacy(mut self) -> Page {
        std::mem::replace(
            &mut self.page,
            Page {
                schema_version: 1,
                manifest_id: String::new(),
                job_id: String::new(),
                review_digest: String::new(),
                manifest_revision: String::new(),
                start_index: 0,
                next_index: 0,
                entries: Vec::new(),
            },
        )
    }
}

impl Drop for AuthenticatedPage {
    fn drop(&mut self) {
        for entry in &mut self.page.entries {
            for url in &mut entry.urls {
                url.zeroize();
            }
        }
    }
}

pub(crate) fn finish_page_authenticated(
    page: EncryptedPage,
    plaintext: Vec<u8>,
) -> Result<AuthenticatedPage, String> {
    let plaintext = Zeroizing::new(plaintext);
    if plaintext.len() > PAGE_LIMIT || digest(&plaintext) != page.plain_hash {
        return Err("scan-manifest-authentication-failed".into());
    }
    let entries: Vec<Entry> = serde_json::from_slice(&plaintext).map_err(|_| ERR)?;
    if entries.len() != page.count
        || entries
            .iter()
            .enumerate()
            .any(|(i, e)| e.candidate_index != page.start_index + i)
    {
        return Err(ERR.into());
    }
    for (entry, metadata) in entries.iter().zip(&page.metadata) {
        crate::scan_checkpoint::manifest_urls(metadata, &entry.urls)?;
    }
    let result = Page {
        schema_version: 1,
        manifest_id: page.header.manifest_id,
        job_id: page.header.job_id,
        review_digest: page.header.review_digest,
        manifest_revision: page.header.manifest_revision,
        start_index: page.start_index,
        next_index: page.start_index + entries.len(),
        entries,
    };
    if encode(&result)?.len() > PAGE_LIMIT {
        return Err("scan-manifest-page-limit".into());
    }
    Ok(AuthenticatedPage {
        page: result,
        metadata: page.metadata,
    })
}

pub(crate) fn discard_job(c: &Connection, job: Option<&str>) -> Result<(), String> {
    if present(c)? {
        if let Some(job) = job {
            sql(c.execute("DELETE FROM scan_manifest WHERE job_id=?1", [job]))?;
        }
    }
    Ok(())
}

pub(crate) fn bind_checkpoint(
    c: &Connection,
    job: Option<&str>,
    digest: Option<&str>,
) -> Result<(), String> {
    if present(c)? {
        match (job, digest) {
            (Some(job), Some(digest)) => {
                sql(c.execute(
                    "DELETE FROM scan_manifest WHERE state=1 AND (job_id<>?1 OR review_digest<>?2)",
                    params![job, digest],
                ))?;
            }
            _ => {
                sql(c.execute("DELETE FROM scan_manifest WHERE state=1", []))?;
            }
        }
    }
    Ok(())
}
