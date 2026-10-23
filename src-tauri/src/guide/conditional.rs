//! Definition/revision-bound validators. Operational metadata, never guide freshness.
use super::database::{self as db, GuideSource};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Validators {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}
impl Validators {
    pub fn valid(&self) -> Result<(), String> {
        for value in [&self.etag, &self.last_modified].into_iter().flatten() {
            if value.is_empty()
                || value.len() > 1024
                || !value.is_ascii()
                || value.chars().any(char::is_control)
            {
                return Err("guide-validator-invalid".into());
            }
        }
        Ok(())
    }
    pub fn from_headers(headers: &reqwest::header::HeaderMap) -> Self {
        let bounded = |name| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .filter(|v| {
                    !v.is_empty()
                        && v.len() <= 1024
                        && v.is_ascii()
                        && !v.chars().any(char::is_control)
                })
                .map(str::to_owned)
        };
        Self {
            etag: bounded(reqwest::header::ETAG),
            last_modified: bounded(reqwest::header::LAST_MODIFIED),
        }
    }
}
#[derive(Debug, Clone)]
pub struct CachedValidators {
    pub fingerprint: String,
    pub revision: i64,
    pub validators: Validators,
}
fn fingerprint(source: &GuideSource) -> Result<String, String> {
    db::key((
        &source.id,
        &source.kind,
        &source.location,
        source.allow_http,
    ))
}
pub fn read(c: &Connection, source: &GuideSource) -> Result<Option<CachedValidators>, String> {
    let exists: bool = db::sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='guide_http_cache' AND type='table')",
        [],
        |r| r.get(0),
    ))?;
    if !exists {
        return Ok(None);
    }
    let cached=db::sql(c.query_row("SELECT fingerprint,published_revision,etag,last_modified,schema_version FROM guide_http_cache WHERE source_id=?1",[&source.id],|r|{
        if r.get::<_,i64>(4)?!=1 || [0,2,3].into_iter().any(|i|r.get_ref(i).is_ok_and(|v|v.as_bytes().is_ok_and(|b|b.len()>1024))) {return Err(rusqlite::Error::InvalidQuery)}
        Ok(CachedValidators{fingerprint:r.get(0)?,revision:r.get(1)?,validators:Validators{etag:r.get(2)?,last_modified:r.get(3)?}})
    }).optional())?;
    let Some(cached) = cached else {
        return Ok(None);
    };
    cached.validators.valid()?;
    let coverage = db::source_coverage(c, &source.id)?;
    if source.kind != "url"
        || cached.fingerprint != fingerprint(source)?
        || cached.revision != source.revision
        || coverage.published_revision != Some(source.revision)
        || coverage.program_count == 0
    {
        return Ok(None);
    }
    if cached.validators.etag.is_none() && cached.validators.last_modified.is_none() {
        return Ok(None);
    }
    Ok(Some(cached))
}
pub(crate) fn read_projected(
    c: &Connection,
    request: &super::retention::Request,
) -> Result<Option<CachedValidators>, String> {
    super::retention::verify(c, &request.scope)?;
    if !super::retention::permits_304(c, &request.scope, request.authority.as_deref())? {
        return Ok(None);
    }
    read(c, &request.scope.source)
}
pub(crate) fn revalidate_projected(
    c: &mut Connection,
    request: &super::retention::Request,
    cached: &CachedValidators,
    received: &Validators,
    now: i64,
    flag: &AtomicBool,
) -> Result<(), String> {
    revalidate_inner(
        c,
        &request.scope.source,
        cached,
        received,
        now,
        || flag.load(Ordering::SeqCst),
        Some(request),
    )
}
/// Called inside the SAME schedule replacement transaction after revision advance.
pub(super) fn record(
    c: &Connection,
    source: &GuideSource,
    revision: i64,
    validators: &Validators,
    now: i64,
) -> Result<(), String> {
    validators.valid()?;
    db::valid_time(now)?;
    db::sql(c.execute_batch("CREATE TABLE IF NOT EXISTS guide_http_cache(source_id TEXT PRIMARY KEY REFERENCES guide_source(id) ON DELETE CASCADE,schema_version INTEGER NOT NULL CHECK(schema_version=1),fingerprint TEXT NOT NULL,published_revision INTEGER NOT NULL,etag TEXT,last_modified TEXT,checked_ms INTEGER NOT NULL);"))?;
    db::sql(c.execute("INSERT INTO guide_http_cache VALUES(?1,1,?2,?3,?4,?5,?6) ON CONFLICT(source_id) DO UPDATE SET fingerprint=excluded.fingerprint,published_revision=excluded.published_revision,etag=excluded.etag,last_modified=excluded.last_modified,checked_ms=excluded.checked_ms",params![source.id,fingerprint(source)?,revision,validators.etag,validators.last_modified,now]))?;
    Ok(())
}
pub fn revalidate(
    c: &mut Connection,
    source: &GuideSource,
    cached: &CachedValidators,
    received: &Validators,
    now: i64,
    flag: &AtomicBool,
) -> Result<(), String> {
    revalidate_checked(c, source, cached, received, now, || {
        flag.load(Ordering::SeqCst)
    })
}
fn revalidate_checked(
    c: &mut Connection,
    source: &GuideSource,
    cached: &CachedValidators,
    received: &Validators,
    now: i64,
    mut canceled: impl FnMut() -> bool,
) -> Result<(), String> {
    revalidate_inner(c, source, cached, received, now, &mut canceled, None)
}
fn revalidate_inner(
    c: &mut Connection,
    source: &GuideSource,
    cached: &CachedValidators,
    received: &Validators,
    now: i64,
    mut canceled: impl FnMut() -> bool,
    request: Option<&super::retention::Request>,
) -> Result<(), String> {
    if canceled() {
        return Err("canceled".into());
    }
    db::valid_time(now)?;
    let tx = db::sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    if let Some(request) = request {
        super::retention::verify(&tx, &request.scope)?;
        if !super::retention::permits_304(&tx, &request.scope, request.authority.as_deref())? {
            return Err("guide-projection-refetch-required".into());
        }
    }
    super::refresh::require_automatic_updates(&tx)?;
    let actual = db::list_sources(&tx)?
        .into_iter()
        .find(|s| s.id == source.id)
        .ok_or("guide-source-missing")?;
    if actual != *source {
        return Err("guide-stale-revision".into());
    }
    let current = read(&tx, &actual)?.ok_or("guide-not-modified-without-cache")?;
    if current.fingerprint != cached.fingerprint
        || current.revision != cached.revision
        || current.validators != cached.validators
    {
        return Err("guide-stale-revision".into());
    }
    let known_future: bool = db::sql(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM guide_program WHERE guide_source_id=?1 AND stop_ms>?2)",
        params![source.id, now],
        |r| r.get(0),
    ))?;
    if !known_future {
        return Err("guide-not-modified-cache-expired".into());
    }
    // A 304 updates only transport check metadata, never schedule success time/revision.
    let merged = Validators {
        etag: received
            .etag
            .clone()
            .or_else(|| cached.validators.etag.clone()),
        last_modified: received
            .last_modified
            .clone()
            .or_else(|| cached.validators.last_modified.clone()),
    };
    record(&tx, &actual, actual.revision, &merged, now)?;
    if canceled() {
        return Err("canceled".into());
    }
    db::sql(tx.commit())?;
    Ok(())
}

#[cfg(test)]
#[path = "conditional_tests.rs"]
mod tests;
