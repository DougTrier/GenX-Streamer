//! Bounded projection of an actual committed batch, never a full catalog reload.
use crate::{scan_resume_registry::Registry, scan_resume_runtime::Episode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
const ERR: &str = "scan-resume-projection-invalid";
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    Channels,
    Sources,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Read {
    pub schema_version: u8,
    pub plan_id: String,
    pub catalog_revision: String,
    pub kind: Kind,
    pub cursor: usize,
    pub limit: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    schema_version: u8,
    plan_id: String,
    catalog_revision: String,
    health_revision: String,
    checkpoint_revision: String,
    kind: Kind,
    cursor: usize,
    next_cursor: usize,
    total: usize,
    rows: Vec<Value>,
    done: bool,
}
pub(crate) fn read(registry: Arc<Registry<Episode>>, request: Read) -> Result<Page, String> {
    if ![1, 2].contains(&request.schema_version)
        || !(1..=64).contains(&request.limit)
        || request.cursor
            > if request.schema_version == 2 {
                240
            } else {
                100
            }
    {
        return Err(ERR.into());
    }
    crate::scan_checkpoint::revision(&request.catalog_revision)?;
    let lease = registry.acquire(&request.plan_id)?;
    lease.with(|episode| {
        let projection = episode
            .latest_projection
            .as_ref()
            .ok_or("scan-resume-projection-unavailable")?;
        let fence = projection.after();
        if request.schema_version != projection.version() {
            return Err(ERR.into());
        }
        if request.catalog_revision != fence.catalog.to_string() {
            return Err("scan-resume-projection-stale".into());
        }
        let rows = match request.kind {
            Kind::Channels => projection.channels(),
            Kind::Sources => projection.sources(),
        };
        if rows.len()
            > match request.kind {
                Kind::Channels => {
                    if request.schema_version == 2 {
                        240
                    } else {
                        64
                    }
                }
                Kind::Sources => 100,
            }
            || request.cursor > rows.len()
        {
            return Err(ERR.into());
        }
        let mut page = Page {
            schema_version: request.schema_version,
            plan_id: request.plan_id.clone(),
            catalog_revision: fence.catalog.to_string(),
            health_revision: fence.health.to_string(),
            checkpoint_revision: fence.checkpoint.to_string(),
            kind: request.kind,
            cursor: request.cursor,
            next_cursor: request.cursor,
            total: rows.len(),
            rows: Vec::new(),
            done: request.cursor == rows.len(),
        };
        for row in rows.iter().skip(request.cursor).take(request.limit) {
            page.rows.push(row.clone());
            page.next_cursor += 1;
            page.done = page.next_cursor == page.total;
            if serde_json::to_vec(&page).map_err(|_| ERR)?.len() > 1024 * 1024 {
                page.rows.pop();
                page.next_cursor -= 1;
                page.done = page.next_cursor == page.total;
                if page.rows.is_empty() {
                    return Err("scan-resume-projection-entry-too-large".into());
                }
                break;
            }
        }
        Ok(page)
    })
}
