//! Authenticated primary-origin sidecar. All writes participate in the caller's
//! existing transaction; platform crypto is performed by the retained root owner
//! outside SQLite/Store leases. No endpoint or capability is enabled here.
#![allow(dead_code)] // Removed when root's operational storage/actor consumers land.
use super::*;
const ORIGIN_ERR: &str = "scan-origin-directory-invalid";
const CAPSULE_LIMIT: usize = 4096;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OriginRow {
    pub ordinal: usize,
    pub metadata_hash: [u8; 32],
    pub primary_url_hash: [u8; 32],
    pub origin_token: [u8; 32],
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OriginHeader {
    pub schema_version: u8,
    pub manifest_id: String,
    pub origin_revision: String,
    pub next_index: usize,
    pub candidate_count: usize,
    pub state: &'static str,
}
struct Directory {
    revision: i64,
    next: usize,
    state: i64,
    hash: Option<Vec<u8>>,
    cipher: Option<Vec<u8>>,
    manifest_revision: Option<i64>,
}
pub(crate) struct PreparedCapsule {
    pub binding: String,
    pub plaintext: Vec<u8>,
    manifest_id: String,
    origin_revision: i64,
    manifest_revision: i64,
    final_manifest_revision: i64,
    directory_hash: [u8; 32],
    count: usize,
    backfill: bool,
}
impl Drop for PreparedCapsule {
    fn drop(&mut self) {
        self.plaintext.zeroize();
    }
}
pub(crate) struct EncryptedCapsule {
    pub binding: String,
    pub ciphertext: Vec<u8>,
    manifest_id: String,
    manifest_revision: i64,
    origin_revision: i64,
    directory_hash: [u8; 32],
    count: usize,
}
pub(crate) struct AdmittedDirectory {
    pub manifest_id: String,
    pub manifest_revision: String,
    pub origin_revision: String,
    pub rows: Vec<OriginRow>,
}
fn hash32(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
fn decoded_hash(value: &Value) -> Result<[u8; 32], String> {
    let text = value.as_str().ok_or(ORIGIN_ERR)?;
    if text.len() != 64
        || !text
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(ORIGIN_ERR.into());
    }
    let mut out = [0; 32];
    for (i, pair) in text.as_bytes().chunks_exact(2).enumerate() {
        let digit = |c: u8| if c <= b'9' { c - b'0' } else { c - b'a' + 10 };
        out[i] = digit(pair[0]) * 16 + digit(pair[1]);
    }
    Ok(out)
}
/// Must be called again on the actual decrypted primary URL before probe dispatch.
/// This token is a concurrency grouping, never a network/HTTP/source grant.
pub(crate) fn origin_token(primary: &str) -> Result<[u8; 32], String> {
    if primary.len() > 16_384 || primary.chars().any(char::is_control) {
        return Err(ORIGIN_ERR.into());
    }
    let url = reqwest::Url::parse(primary).map_err(|_| ORIGIN_ERR)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ORIGIN_ERR.into());
    }
    let mut digest = Sha256::new();
    digest.update(b"genx-scan-origin-v1\0");
    digest.update(url.origin().ascii_serialization().as_bytes());
    Ok(digest.finalize().into())
}
pub(crate) fn derive_rows(metadata: &[Value], entries: &[Entry]) -> Result<Vec<OriginRow>, String> {
    if entries.is_empty() || entries.len() > 64 || metadata.len() != entries.len() {
        return Err(ORIGIN_ERR.into());
    }
    metadata
        .iter()
        .zip(entries)
        .map(|(candidate, entry)| {
            crate::scan_checkpoint::manifest_urls(candidate, &entry.urls)?;
            Ok(OriginRow {
                ordinal: entry.candidate_index,
                metadata_hash: hash32(&serde_json::to_vec(candidate).map_err(|_| ORIGIN_ERR)?),
                primary_url_hash: decoded_hash(&candidate["reference"]["urlHashes"][0])?,
                origin_token: origin_token(entry.urls.first().ok_or(ORIGIN_ERR)?)?,
            })
        })
        .collect()
}
fn present(c: &Connection) -> Result<bool, String> {
    let exists:bool=sql(c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_manifest_origin_namespace')",[],|r|r.get(0)))?;
    if exists {
        let version: i64 = sql(c.query_row(
            "SELECT schema_version FROM scan_manifest_origin_namespace WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        if version != 1 {
            return Err("scan-origin-version-unsupported".into());
        }
    }
    Ok(exists)
}
fn ensure(c: &Connection) -> Result<(), String> {
    let _ = present(c)?;
    sql(c.execute_batch("CREATE TABLE IF NOT EXISTS scan_manifest_origin_namespace(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=1));INSERT OR IGNORE INTO scan_manifest_origin_namespace VALUES(1,1);CREATE TABLE IF NOT EXISTS scan_manifest_origin_directory(manifest_id TEXT PRIMARY KEY REFERENCES scan_manifest(id) ON DELETE CASCADE,revision INTEGER NOT NULL CHECK(revision>=0),state INTEGER NOT NULL CHECK(state IN(0,1)),next_index INTEGER NOT NULL CHECK(next_index>=0),directory_hash BLOB,capsule BLOB,manifest_revision INTEGER);CREATE TABLE IF NOT EXISTS scan_manifest_origin(manifest_id TEXT NOT NULL,ordinal INTEGER NOT NULL,metadata_hash BLOB NOT NULL CHECK(length(metadata_hash)=32),primary_url_hash BLOB NOT NULL CHECK(length(primary_url_hash)=32),origin_token BLOB NOT NULL CHECK(length(origin_token)=32),PRIMARY KEY(manifest_id,ordinal),FOREIGN KEY(manifest_id,ordinal) REFERENCES scan_manifest_candidate(manifest_id,ordinal) ON DELETE CASCADE);CREATE INDEX IF NOT EXISTS scan_manifest_origin_head ON scan_manifest_origin(manifest_id,origin_token,ordinal);"))
}
fn directory(c: &Connection, id: &str) -> Result<Directory, String> {
    if !present(c)? {
        return Err("scan-origin-directory-absent".into());
    }
    let (revision,state,next,hash,cipher,manifest_revision)=sql(c.query_row("SELECT revision,state,next_index,directory_hash,capsule,manifest_revision FROM scan_manifest_origin_directory WHERE manifest_id=?1",[id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,Option<Vec<u8>>>(3)?,r.get::<_,Option<Vec<u8>>>(4)?,r.get::<_,Option<i64>>(5)?))).optional())?.ok_or("scan-origin-directory-absent")?;
    if revision < 0
        || ![0, 1].contains(&state)
        || !(0..=100_000).contains(&next)
        || hash.as_ref().is_some_and(|v| v.len() != 32)
        || cipher
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.len() > CAPSULE_LIMIT + 16 * 1024)
    {
        return Err(ORIGIN_ERR.into());
    }
    if (state == 0 && (hash.is_some() || cipher.is_some() || manifest_revision.is_some()))
        || (state == 1 && (hash.is_none() || cipher.is_none() || manifest_revision.is_none()))
    {
        return Err(ORIGIN_ERR.into());
    }
    Ok(Directory {
        revision,
        state,
        next: next as usize,
        hash,
        cipher,
        manifest_revision,
    })
}
pub(super) fn begin_capture(c: &Connection, id: &str) -> Result<(), String> {
    ensure(c)?;
    sql(c.execute(
        "INSERT INTO scan_manifest_origin_directory VALUES(?1,0,0,0,NULL,NULL,NULL)",
        [id],
    ))?;
    Ok(())
}
fn append(
    c: &Connection,
    id: &str,
    rows: &[OriginRow],
    expected: Option<i64>,
) -> Result<OriginHeader, String> {
    let old = stored(c, id)?;
    let d = directory(c, id)?;
    if rows.is_empty()
        || rows.len() > 64
        || d.state != 0
        || d.revision == i64::MAX
        || expected.is_some_and(|r| r != d.revision)
    {
        return Err("scan-origin-revision-stale".into());
    }
    for (offset, row) in rows.iter().enumerate() {
        if row.ordinal != d.next + offset || row.ordinal >= old.header.candidate_count {
            return Err("scan-origin-order-invalid".into());
        }
        sql(c.execute(
            "INSERT INTO scan_manifest_origin VALUES(?1,?2,?3,?4,?5)",
            params![
                id,
                row.ordinal as i64,
                row.metadata_hash.as_slice(),
                row.primary_url_hash.as_slice(),
                row.origin_token.as_slice()
            ],
        ))?;
    }
    sql(c.execute("UPDATE scan_manifest_origin_directory SET revision=revision+1,next_index=next_index+?1 WHERE manifest_id=?2 AND revision=?3",params![rows.len() as i64,id,d.revision]))?;
    header(c, id)
}
pub(super) fn append_capture(c: &Connection, id: &str, rows: &[OriginRow]) -> Result<(), String> {
    append(c, id, rows, None).map(|_| ())
}
fn header(c: &Connection, id: &str) -> Result<OriginHeader, String> {
    let d = directory(c, id)?;
    let m = stored(c, id)?;
    Ok(OriginHeader {
        schema_version: 1,
        manifest_id: id.into(),
        origin_revision: d.revision.to_string(),
        next_index: d.next,
        candidate_count: m.header.candidate_count,
        state: if d.state == 1 { "sealed" } else { "staging" },
    })
}
fn rows(
    c: &Connection,
    id: &str,
    count: usize,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<Vec<OriginRow>, String> {
    if count > 100_000 {
        return Err(ORIGIN_ERR.into());
    }
    let mut statement=sql(c.prepare("SELECT ordinal,metadata_hash,primary_url_hash,origin_token FROM scan_manifest_origin WHERE manifest_id=?1 ORDER BY ordinal LIMIT 100001"))?;
    let found = sql(statement.query_map([id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, Vec<u8>>(1)?,
            r.get::<_, Vec<u8>>(2)?,
            r.get::<_, Vec<u8>>(3)?,
        ))
    }))?;
    let mut out = Vec::with_capacity(count);
    for row in found {
        if out.len().is_multiple_of(64) {
            check()?;
        }
        let (ordinal, metadata, primary, token) = sql(row)?;
        if ordinal != out.len() as i64 || out.len() >= count {
            return Err("scan-origin-directory-incomplete".into());
        }
        out.push(OriginRow {
            ordinal: ordinal as usize,
            metadata_hash: metadata.try_into().map_err(|_| ORIGIN_ERR)?,
            primary_url_hash: primary.try_into().map_err(|_| ORIGIN_ERR)?,
            origin_token: token.try_into().map_err(|_| ORIGIN_ERR)?,
        });
    }
    if out.len() != count {
        return Err("scan-origin-directory-incomplete".into());
    }
    Ok(out)
}
fn binding(
    c: &Connection,
    m: &Stored,
    manifest_revision: i64,
    origin_revision: i64,
) -> Result<String, String> {
    let namespace: String = sql(c.query_row(
        "SELECT namespace FROM scan_manifest_namespace WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    encode(&json!([
        "genx-scan-origin-directory-v1",
        namespace,
        m.header.manifest_id,
        m.header.job_id,
        m.header.review_digest,
        m.authority["policyFingerprint"],
        m.header.candidate_count,
        manifest_revision,
        origin_revision
    ]))
}
fn directory_digest(binding: &str, rows: &[OriginRow]) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(b"genx-origin-rows-v1\0");
    digest.update((binding.len() as u64).to_be_bytes());
    digest.update(binding.as_bytes());
    for row in rows {
        digest.update((row.ordinal as u64).to_be_bytes());
        digest.update(row.metadata_hash);
        digest.update(row.primary_url_hash);
        digest.update(row.origin_token);
    }
    digest.finalize().into()
}
fn capsule_plain(hash: &[u8; 32], count: usize) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&json!({"schemaVersion":1,"candidateCount":count,"directoryHash":hash.iter().map(|byte|format!("{byte:02x}")).collect::<String>()})).map_err(|_|ORIGIN_ERR.into())
}
fn prepare(
    c: &Connection,
    m: Stored,
    d: Directory,
    backfill: bool,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<PreparedCapsule, String> {
    if d.state != 0 || d.next != m.header.candidate_count || d.revision == i64::MAX {
        return Err("scan-origin-directory-incomplete".into());
    }
    let revision = crate::scan_checkpoint::revision(&m.header.manifest_revision)?;
    let final_revision = if backfill {
        revision
    } else {
        revision.checked_add(1).ok_or(ORIGIN_ERR)?
    };
    let binding = binding(
        c,
        &m,
        final_revision,
        d.revision.checked_add(1).ok_or(ORIGIN_ERR)?,
    )?;
    if binding.len() > BINDING_LIMIT {
        return Err(ORIGIN_ERR.into());
    }
    let rows = rows(c, &m.header.manifest_id, m.header.candidate_count, check)?;
    let hash = directory_digest(&binding, &rows);
    let plaintext = capsule_plain(&hash, rows.len())?;
    Ok(PreparedCapsule {
        binding,
        plaintext,
        manifest_id: m.header.manifest_id,
        origin_revision: d.revision,
        manifest_revision: revision,
        final_manifest_revision: final_revision,
        directory_hash: hash,
        count: rows.len(),
        backfill,
    })
}
pub(crate) fn prepare_seal(
    c: &Connection,
    request: &Seal,
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<PreparedCapsule, String> {
    check()?;
    let m = seal_metadata(c, request, context)?;
    let d = directory(c, &request.manifest_id)?;
    prepare(c, m, d, false, &mut check)
}
fn finish(
    c: &Connection,
    proof: &PreparedCapsule,
    ciphertext: &[u8],
    m: Stored,
    d: Directory,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    check()?;
    if d.state != 0
        || d.revision != proof.origin_revision
        || d.next != proof.count
        || crate::scan_checkpoint::revision(&m.header.manifest_revision)? != proof.manifest_revision
        || (m.state == 1) != proof.backfill
        || ciphertext.is_empty()
        || ciphertext.len() > CAPSULE_LIMIT + 16 * 1024
    {
        return Err("scan-origin-revision-stale".into());
    }
    let binding = binding(
        c,
        &m,
        proof.final_manifest_revision,
        proof.origin_revision.checked_add(1).ok_or(ORIGIN_ERR)?,
    )?;
    let rows = rows(c, &proof.manifest_id, proof.count, check)?;
    if binding != proof.binding
        || directory_digest(&binding, &rows) != proof.directory_hash
        || capsule_plain(&proof.directory_hash, proof.count)? != proof.plaintext
    {
        return Err("scan-origin-binding-mismatch".into());
    }
    sql(c.execute("UPDATE scan_manifest_origin_directory SET revision=revision+1,state=1,directory_hash=?1,capsule=?2,manifest_revision=?3 WHERE manifest_id=?4 AND revision=?5 AND state=0",params![proof.directory_hash.as_slice(),ciphertext,proof.final_manifest_revision,proof.manifest_id,proof.origin_revision]))?;
    check()?;
    Ok(())
}
/// Call BEFORE CP apply + main manifest seal in the SAME transaction. Its capsule
/// binds the prospective main revision and is unreadable until main seal commits.
pub(crate) fn finish_seal(
    c: &Connection,
    request: &Seal,
    proof: &PreparedCapsule,
    ciphertext: &[u8],
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    check_cas(
        context,
        &request.expected_catalog_revision,
        &request.expected_checkpoint_revision,
    )?;
    let m = stored(c, &request.manifest_id)?;
    authority(c, &m, context)?;
    if proof.backfill
        || proof.manifest_id != request.manifest_id
        || m.header.manifest_revision != request.expected_manifest_revision
    {
        return Err("scan-origin-revision-stale".into());
    }
    let d = directory(c, &request.manifest_id)?;
    finish(c, proof, ciphertext, m, d, &mut check)
}
fn found(c: &Connection, request: &Find, context: &Context<'_>) -> Result<Stored, String> {
    let reply = find(c, request, context)?;
    let h = reply.header.ok_or("scan-manifest-absent")?;
    stored(c, &h.manifest_id)
}
pub(crate) fn prepare_open(
    c: &Connection,
    request: &Find,
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<EncryptedCapsule, String> {
    check()?;
    let m = found(c, request, context)?;
    let d = directory(c, &m.header.manifest_id)?;
    let revision = crate::scan_checkpoint::revision(&m.header.manifest_revision)?;
    if d.state != 1 || d.next != m.header.candidate_count || d.manifest_revision != Some(revision) {
        return Err("scan-origin-directory-unsealed".into());
    }
    let hash: [u8; 32] = d
        .hash
        .ok_or(ORIGIN_ERR)?
        .try_into()
        .map_err(|_| ORIGIN_ERR)?;
    Ok(EncryptedCapsule {
        binding: binding(c, &m, revision, d.revision)?,
        ciphertext: d.cipher.ok_or(ORIGIN_ERR)?,
        manifest_id: m.header.manifest_id,
        manifest_revision: revision,
        origin_revision: d.revision,
        directory_hash: hash,
        count: d.next,
    })
}
pub(crate) fn finish_open(
    c: &Connection,
    request: &Find,
    proof: &EncryptedCapsule,
    plaintext: Vec<u8>,
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<AdmittedDirectory, String> {
    let plaintext = Zeroizing::new(plaintext);
    check()?;
    if plaintext.len() > CAPSULE_LIMIT {
        return Err(ORIGIN_ERR.into());
    }
    let m = found(c, request, context)?;
    let d = directory(c, &m.header.manifest_id)?;
    if proof.manifest_id != m.header.manifest_id
        || crate::scan_checkpoint::revision(&m.header.manifest_revision)? != proof.manifest_revision
        || d.revision != proof.origin_revision
        || d.state != 1
        || d.next != proof.count
        || d.manifest_revision != Some(proof.manifest_revision)
        || d.hash.as_deref() != Some(proof.directory_hash.as_slice())
        || d.cipher.as_deref() != Some(proof.ciphertext.as_slice())
    {
        return Err("scan-origin-revision-stale".into());
    }
    let binding = binding(c, &m, proof.manifest_revision, proof.origin_revision)?;
    let rows = rows(c, &m.header.manifest_id, proof.count, &mut check)?;
    if binding != proof.binding
        || directory_digest(&binding, &rows) != proof.directory_hash
        || capsule_plain(&proof.directory_hash, proof.count)?.as_slice() != plaintext.as_slice()
    {
        return Err("scan-origin-authentication-failed".into());
    }
    check()?;
    Ok(AdmittedDirectory {
        manifest_id: m.header.manifest_id,
        manifest_revision: m.header.manifest_revision,
        origin_revision: d.revision.to_string(),
        rows,
    })
}
pub(crate) fn begin_backfill(
    c: &Connection,
    request: &Find,
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<OriginHeader, String> {
    check()?;
    let m = found(c, request, context)?;
    ensure(c)?;
    let existing = directory(c, &m.header.manifest_id);
    let revision = match existing {
        Ok(d) if d.state == 0 => d.revision.checked_add(1).ok_or(ORIGIN_ERR)?,
        Ok(_) => return Err("scan-origin-directory-already-sealed".into()),
        Err(e) if e == "scan-origin-directory-absent" => 0,
        Err(e) => return Err(e),
    };
    sql(c.execute(
        "DELETE FROM scan_manifest_origin WHERE manifest_id=?1",
        [&m.header.manifest_id],
    ))?;
    sql(c.execute("INSERT INTO scan_manifest_origin_directory VALUES(?1,?2,0,0,NULL,NULL,NULL) ON CONFLICT(manifest_id) DO UPDATE SET revision=excluded.revision,state=0,next_index=0,directory_hash=NULL,capsule=NULL,manifest_revision=NULL",params![m.header.manifest_id,revision]))?;
    check()?;
    header(c, &m.header.manifest_id)
}
pub(crate) fn append_backfill(
    c: &Connection,
    request: &Find,
    expected_origin_revision: &str,
    page: &AuthenticatedPage,
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<OriginHeader, String> {
    check()?;
    let m = found(c, request, context)?;
    if page.page.manifest_id != m.header.manifest_id
        || page.page.job_id != m.header.job_id
        || page.page.review_digest != m.header.review_digest
        || page.page.manifest_revision != m.header.manifest_revision
    {
        return Err("scan-origin-binding-mismatch".into());
    }
    let d = directory(c, &m.header.manifest_id)?;
    if page.page.start_index != d.next || page.page.next_index != d.next + page.page.entries.len() {
        return Err("scan-origin-order-invalid".into());
    }
    let rows = derive_rows(&page.metadata, &page.page.entries)?;
    let reply = append(
        c,
        &m.header.manifest_id,
        &rows,
        Some(crate::scan_checkpoint::revision(expected_origin_revision)?),
    )?;
    check()?;
    Ok(reply)
}
pub(crate) fn prepare_backfill_seal(
    c: &Connection,
    request: &Find,
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<PreparedCapsule, String> {
    check()?;
    let m = found(c, request, context)?;
    let d = directory(c, &m.header.manifest_id)?;
    prepare(c, m, d, true, &mut check)
}
pub(crate) fn finish_backfill_seal(
    c: &Connection,
    request: &Find,
    proof: &PreparedCapsule,
    ciphertext: &[u8],
    context: &Context<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<OriginHeader, String> {
    let m = found(c, request, context)?;
    authority(c, &m, context)?;
    if !proof.backfill || proof.manifest_id != m.header.manifest_id {
        return Err("scan-origin-binding-mismatch".into());
    }
    let id = m.header.manifest_id.clone();
    let d = directory(c, &id)?;
    finish(c, proof, ciphertext, m, d, &mut check)?;
    header(c, &id)
}
#[cfg(test)]
#[path = "scan_manifest_origin_directory_tests.rs"]
mod tests;
