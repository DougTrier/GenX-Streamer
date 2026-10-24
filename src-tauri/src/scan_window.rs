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

//! One versioned atomic window; legacy batch limits stay unchanged.
use crate::scan_batch::{self, Patch};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
const LIMIT: usize = 20 * 1024 * 1024;
const ERR: &str = "scan-window-invalid";
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Chunk {
    pub catalog_patch: Patch,
    pub incoming_health: Vec<Value>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Window {
    pub schema_version: u8,
    pub chunks: Vec<Chunk>,
    pub authorized_sources: Vec<Value>,
    pub next_preferences: Value,
    pub expected_catalog_revision: String,
    pub expected_health_revision: String,
    pub scan_checkpoint: Option<crate::scan_checkpoint::Mutation>,
    pub expected_checkpoint_revision: Option<String>,
}
struct Bound(usize);
impl std::io::Write for Bound {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > LIMIT.saturating_sub(self.0) {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(crate) fn validate(window: &Window) -> Result<(i64, i64), String> {
    if window.schema_version != 1
        || window.chunks.is_empty()
        || window.chunks.len() > 4
        || window.authorized_sources.len() > 100
        || window.scan_checkpoint.is_some() != window.expected_checkpoint_revision.is_some()
    {
        return Err(ERR.into());
    }
    serde_json::to_writer(&mut Bound(0), window).map_err(|_| "scan-window-too-large")?;
    let mut union = HashSet::new();
    for (index, chunk) in window.chunks.iter().enumerate() {
        let p = &chunk.catalog_patch;
        if p.schema_version != 1
            || p.channels.len() > 64
            || p.sources.len() > 100
            || chunk.incoming_health.len() > 64
            || p.base_source_count > 100
            || p.final_source_count > 100
            || p.final_source_count < p.base_source_count
            || p.base_channel_count > 100_000
            || p.final_channel_count > 100_000
            || p.final_channel_count < p.base_channel_count
        {
            return Err(ERR.into());
        }
        if index > 0 {
            let before = &window.chunks[index - 1].catalog_patch;
            if p.base_source_count != before.final_source_count
                || p.base_channel_count != before.final_channel_count
            {
                return Err("scan-window-chain-stale".into());
            }
        }
        let mut ids = HashSet::new();
        for channel in &p.channels {
            let id = channel["id"].as_str().ok_or(ERR)?;
            if !ids.insert(id) {
                return Err(ERR.into());
            }
            union.insert(id);
        }
    }
    if union.len() > 256 {
        return Err(ERR.into());
    }
    if let Some(revision) = &window.expected_checkpoint_revision {
        crate::scan_checkpoint::revision(revision)?;
    }
    Ok((
        crate::scan_checkpoint::revision(&window.expected_catalog_revision)?,
        crate::scan_checkpoint::revision(&window.expected_health_revision)?,
    ))
}
pub(crate) fn expand(
    window: &Window,
    old: &Value,
    check: impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    let patches: Vec<_> = window
        .chunks
        .iter()
        .map(|chunk| &chunk.catalog_patch)
        .collect();
    scan_batch::expand_chunks(
        &patches,
        &window.authorized_sources,
        &window.next_preferences,
        old,
        check,
    )
}
pub(crate) fn ids(window: &Window) -> Result<Vec<Vec<String>>, String> {
    window
        .chunks
        .iter()
        .map(|chunk| {
            chunk
                .catalog_patch
                .channels
                .iter()
                .map(|c| {
                    c["id"]
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| ERR.to_owned())
                })
                .collect()
        })
        .collect()
}
