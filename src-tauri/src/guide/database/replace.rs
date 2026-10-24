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

//! Replacing a source's guide (plain, projected and conditional) and
//! publishing it.

use super::*;

#[cfg(test)]
pub fn replace_guide(
    c: &mut Connection,
    id: &str,
    expected_revision: i64,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
) -> Result<i64, String> {
    replace_inner(c, id, expected_revision, feed, updated_ms, flag, |_| Ok(()))
}

pub(crate) fn replace_guide_projected(
    c: &mut Connection,
    request: &super::super::retention::Request,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
) -> Result<i64, String> {
    super::super::retention::publication_window(request, updated_ms)?;
    replace_inner_with_request(
        c,
        &request.scope.source.id,
        request.scope.source.revision,
        feed,
        updated_ms,
        flag,
        |_| Ok(()),
        Some(request),
    )
}

#[cfg(test)]
pub(super) fn replace_inner(
    c: &mut Connection,
    id: &str,
    expected_revision: i64,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
    checkpoint: impl FnMut(usize) -> Result<(), String>,
) -> Result<i64, String> {
    replace_inner_with_request(
        c,
        id,
        expected_revision,
        feed,
        updated_ms,
        flag,
        checkpoint,
        None,
    )
}

// Internal join of the two replace paths; the public wrappers above name
// their inputs, and `request` is the only difference between them.
#[allow(clippy::too_many_arguments)]
pub(super) fn replace_inner_with_request(
    c: &mut Connection,
    id: &str,
    expected_revision: i64,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
    mut checkpoint: impl FnMut(usize) -> Result<(), String>,
    request: Option<&super::super::retention::Request>,
) -> Result<i64, String> {
    if expected_revision < 0 || expected_revision == i64::MAX {
        return Err("guide-invalid-source-revision".into());
    }
    valid_time(updated_ms)?;
    validate_feed(feed, flag)?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let storage_admission = crate::storage_budget::GuideAdmission::capture(&tx)?;
    let projection = request
        .map(|r| super::super::retention::project(&tx, r, feed, flag))
        .transpose()?;
    let feed = projection.as_ref().map_or(feed, |p| &p.feed);
    if let Some(r) = request {
        super::super::retention::install_proposed(&tx, &r.scope)?;
    }
    replace_rows(
        &tx,
        id,
        expected_revision,
        feed,
        updated_ms,
        flag,
        &mut checkpoint,
    )?;
    if let (Some(r), Some(p)) = (request, projection.as_ref()) {
        super::super::retention::record(&tx, r, p, expected_revision + 1)?;
    }
    storage_admission.finish(&tx)?;
    cancel(flag)?;
    sql(tx.commit())?;
    Ok(expected_revision + 1)
}

/// Automatic fetch publishes bytes-derived validators with exactly these rows.
pub(crate) fn replace_guide_conditional_projected(
    c: &mut Connection,
    request: &super::super::retention::Request,
    feed: &ParsedGuide,
    updated_ms: i64,
    validators: &super::super::conditional::Validators,
    flag: &AtomicBool,
) -> Result<i64, String> {
    super::super::retention::publication_window(request, updated_ms)?;
    replace_conditional_inner(
        c,
        &request.scope.source,
        feed,
        updated_ms,
        validators,
        flag,
        Some(request),
    )
}

#[cfg(test)]
pub fn replace_guide_conditional(
    c: &mut Connection,
    source: &GuideSource,
    feed: &ParsedGuide,
    updated_ms: i64,
    validators: &super::super::conditional::Validators,
    flag: &AtomicBool,
) -> Result<i64, String> {
    replace_conditional_inner(c, source, feed, updated_ms, validators, flag, None)
}

pub(super) fn replace_conditional_inner(
    c: &mut Connection,
    source: &GuideSource,
    feed: &ParsedGuide,
    updated_ms: i64,
    validators: &super::super::conditional::Validators,
    flag: &AtomicBool,
    request: Option<&super::super::retention::Request>,
) -> Result<i64, String> {
    if source.revision < 0 || source.revision == i64::MAX {
        return Err("guide-invalid-source-revision".into());
    }
    valid_time(updated_ms)?;
    super::super::refresh::admit_schedule(feed, updated_ms, flag)?;
    validate_feed(feed, flag)?;
    validators.valid()?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let storage_admission = crate::storage_budget::GuideAdmission::capture(&tx)?;
    super::super::refresh::require_automatic_updates(&tx)?;
    let actual = list_sources(&tx)?
        .into_iter()
        .find(|s| s.id == source.id)
        .ok_or("guide-source-missing")?;
    if actual != *source {
        return Err("guide-stale-revision".into());
    }
    let projection = request
        .map(|r| super::super::retention::project(&tx, r, feed, flag))
        .transpose()?;
    let feed = projection.as_ref().map_or(feed, |p| &p.feed);
    replace_rows(
        &tx,
        &source.id,
        source.revision,
        feed,
        updated_ms,
        flag,
        &mut |_| Ok(()),
    )?;
    if let (Some(r), Some(p)) = (request, projection.as_ref()) {
        super::super::retention::record(&tx, r, p, source.revision + 1)?;
    }
    super::super::conditional::record(&tx, source, source.revision + 1, validators, updated_ms)?;
    cancel(flag)?;
    storage_admission.finish(&tx)?;
    cancel(flag)?;
    sql(tx.commit())?;
    Ok(source.revision + 1)
}

pub(crate) fn replace_rows(
    tx: &Connection,
    id: &str,
    expected_revision: i64,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
    mut checkpoint: impl FnMut(usize) -> Result<(), String>,
) -> Result<(), String> {
    if source_revision(tx, id)? != expected_revision {
        return Err("guide-stale-revision".into());
    }
    sql(tx.execute("DELETE FROM guide_channel WHERE guide_source_id=?1", [id]))?;
    checkpoint(0)?;
    cancel(flag)?;
    {
        let mut insert = sql(tx.prepare("INSERT INTO guide_channel VALUES(?1,?2,?3,?4)"))?;
        for ch in &feed.channels {
            cancel(flag)?;
            let names = serde_json::to_string(&ch.names).map_err(|_| "guide-invalid-channel")?;
            sql(insert.execute(params![id, ch.id, names, normalized(&ch.names.join("\n"))]))?;
            insert_channel_names(tx, id, &ch.id, &ch.names)?;
        }
    }
    {
        let mut insert =
            sql(tx.prepare("INSERT INTO guide_program(guide_source_id,ordinal,channel_id,start_ms,stop_ms,title,description,search_text,categories_json,categories_key) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"))?;
        // Exact duplicate programs share one stable schedule row, independent of input ordering.
        let mut ordered: Vec<&GuideProgram> = feed.programs.iter().collect();
        ordered.sort_by(|a, b| {
            (
                &a.channel_id,
                a.start_ms,
                a.stop_ms,
                &a.title,
                &a.description,
                super::super::category::semantic_pairs(&a.categories),
            )
                .cmp(&(
                    &b.channel_id,
                    b.start_ms,
                    b.stop_ms,
                    &b.title,
                    &b.description,
                    super::super::category::semantic_pairs(&b.categories),
                ))
        });
        ordered.dedup_by(|a, b| {
            a.channel_id == b.channel_id
                && a.start_ms == b.start_ms
                && a.stop_ms == b.stop_ms
                && a.title == b.title
                && a.description == b.description
                && super::super::category::semantic_pairs(&a.categories)
                    == super::super::category::semantic_pairs(&b.categories)
        });
        for (i, p) in ordered.iter().enumerate() {
            cancel(flag)?;
            sql(insert.execute(params![
                id,
                i as i64,
                p.channel_id,
                p.start_ms,
                p.stop_ms,
                p.title,
                p.description,
                super::super::category::search_text(
                    &p.title,
                    p.description.as_deref(),
                    &p.categories
                ),
                serde_json::to_string(&super::super::category::canonicalize(p.categories.clone())?)
                    .map_err(|_| "guide-invalid-category")?,
                super::super::category::semantic_key(&p.categories)?
            ]))?;
            checkpoint(i + 1)?;
        }
    }
    sql(tx.execute(
        "UPDATE guide_source SET revision=revision+1,published_revision=revision+1,updated_ms=?2 WHERE id=?1",
        params![id, updated_ms],
    ))?;
    advance(tx)?;
    checkpoint(usize::MAX)?;
    cancel(flag)?;
    Ok(())
}

/// Configuration and the reviewed schedule publish in one commit; failures preserve both prior records.
#[cfg(test)]
pub fn publish_source(
    c: &mut Connection,
    source: &GuideSource,
    expected_revision: i64,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
) -> Result<i64, String> {
    publish_inner(c, source, expected_revision, feed, updated_ms, flag, |_| {
        Ok(())
    })
}

#[cfg(test)]
pub(super) fn publish_inner(
    c: &mut Connection,
    source: &GuideSource,
    expected_revision: i64,
    feed: &ParsedGuide,
    updated_ms: i64,
    flag: &AtomicBool,
    checkpoint: impl FnMut(usize) -> Result<(), String>,
) -> Result<i64, String> {
    validate_source(source, expected_revision)?;
    valid_time(updated_ms)?;
    validate_feed(feed, flag)?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let storage_admission = crate::storage_budget::GuideAdmission::capture(&tx)?;
    let previous: Option<i64> = sql(tx
        .query_row(
            "SELECT revision FROM guide_source WHERE id=?1",
            [&source.id],
            |r| r.get(0),
        )
        .optional())?;
    if previous.unwrap_or(0) != expected_revision {
        return Err("guide-stale-revision".into());
    }
    if previous.is_none()
        && sql(tx.query_row("SELECT count(*) FROM guide_source", [], |r| {
            r.get::<_, i64>(0)
        }))? >= 1000
    {
        return Err("guide-source-limit".into());
    }
    sql(tx.execute("INSERT INTO guide_source(id,name,location,kind,allow_http,revision,updated_ms) VALUES(?1,?2,?3,?4,?5,?6,NULL) ON CONFLICT(id) DO UPDATE SET name=excluded.name,location=excluded.location,kind=excluded.kind,allow_http=excluded.allow_http",params![source.id,source.name,source.location,source.kind,source.allow_http,expected_revision]))?;
    replace_rows(
        &tx,
        &source.id,
        expected_revision,
        feed,
        updated_ms,
        flag,
        checkpoint,
    )?;
    storage_admission.finish(&tx)?;
    cancel(flag)?;
    sql(tx.commit())?;
    Ok(expected_revision + 1)
}
