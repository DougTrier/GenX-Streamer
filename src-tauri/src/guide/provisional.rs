//! Proposed HTTPS guide descriptors remain memory-only until explicit publication.
use super::database::{self as db, GuideSource};
use rusqlite::{params, Connection};

pub(crate) fn validate_absent(c: &Connection, source: &GuideSource) -> Result<(), String> {
    db::validate_source(source, 0)?;
    let url = reqwest::Url::parse(&source.location).map_err(|_| "guide-invalid-url")?;
    if source.kind != "url"
        || source.allow_http
        || url.scheme() != "https"
        || url.fragment().is_some()
    {
        return Err("guide-proposed-source-invalid".into());
    }
    let exists: bool = db::sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM guide_source WHERE id=?1 OR location=?2)",
        params![source.id, source.location],
        |r| r.get(0),
    ))?;
    if exists {
        return Err("guide-proposed-source-conflict".into());
    }
    let count: i64 = db::sql(c.query_row("SELECT count(*) FROM guide_source", [], |r| r.get(0)))?;
    if count >= 1000 {
        return Err("guide-source-limit".into());
    }
    Ok(())
}

/// Caller holds the publication transaction after the complete feed/scope proof.
pub(crate) fn insert(c: &Connection, source: &GuideSource) -> Result<(), String> {
    validate_absent(c, source)?;
    db::sql(c.execute("INSERT INTO guide_source(id,name,location,kind,allow_http,revision,updated_ms,published_revision) VALUES(?1,?2,?3,'url',0,0,NULL,NULL)",params![source.id,source.name,source.location]))?;
    Ok(())
}

#[cfg(test)]
#[path = "provisional_tests.rs"]
mod tests;
