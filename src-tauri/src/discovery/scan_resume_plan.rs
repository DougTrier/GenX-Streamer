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

//! Native-only first-stage resume admission. Not a summary, endpoint, registry or scheduler.
//! Full validation is transient O(N); retained state is hashes/progress, never the full review.
//! Integration must retain Store generation/request/crypto owners and supply SQL-authoritative
//! fences. This module does not assert that an encrypted manifest exists or crypto has settled.
#![allow(dead_code)] // Disabled until storage/crypto/receipt consumers are integrated.
use crate::{scan_candidate_manifest::Entry, storage_transaction::CommitReceipt};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroize;

const ERR: &str = "scan-resume-plan-invalid";
const PAGE_BYTES: usize = 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Fence {
    pub root_generation: u64,
    pub catalog: i64,
    pub health: i64,
    pub checkpoint: i64,
}
#[derive(Clone, Copy)]
pub(crate) struct Context<'a> {
    pub preferences: &'a Value,
    pub catalog: &'a Value,
    pub fence: Fence,
    pub now: u64,
    pub platform: &'a str,
    pub observer_profile: &'a str,
}
pub(crate) struct PageInput<'a> {
    pub fence: Fence,
    pub now: u64,
    pub start: usize,
    pub metadata: &'a [Value],
    pub entries: &'a [Entry],
}
#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Counts {
    pub total: usize,
    pub checked: usize,
    pub responded: usize,
    pub published: usize,
}
struct Progress {
    observation: Option<Box<str>>,
    published: bool,
}
pub(crate) struct Plan {
    fence: Fence,
    expires_at: u64,
    header: Value,
    candidate_hashes: Vec<[u8; 32]>,
    primary_url_hashes: Vec<[u8; 32]>,
    progress: Vec<Progress>,
    counts: Counts,
    // Immutable full-review ambiguity authority; never shipped as an O(N) JS scope.
    ambiguous_providers: HashSet<[u8; 32]>,
    ambiguous_metadata: HashSet<[u8; 32]>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Row {
    pub candidate_index: usize,
    pub candidate: Value,
    pub work: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation: Option<Value>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    pub schema_version: u8,
    pub start_index: usize,
    pub next_index: usize,
    pub rows: Vec<Row>,
}
impl Drop for Row {
    fn drop(&mut self) {
        if let Some(urls) = self.candidate["channel"]["urls"].as_array_mut() {
            for url in urls {
                if let Value::String(url) = url {
                    url.zeroize();
                }
            }
        }
    }
}
fn hash(value: &Value) -> Result<[u8; 32], String> {
    let bytes = serde_json::to_vec(value).map_err(|_| ERR)?;
    Ok(Sha256::digest(bytes).into())
}
fn reference_hash(value: &Value) -> Result<[u8; 32], String> {
    let text = value.as_str().ok_or(ERR)?;
    if text.len() != 64
        || !text
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(ERR.into());
    }
    let mut result = [0; 32];
    for (i, pair) in text.as_bytes().chunks_exact(2).enumerate() {
        let digit = |c: u8| if c <= b'9' { c - b'0' } else { c - b'a' + 10 };
        result[i] = digit(pair[0]) * 16 + digit(pair[1]);
    }
    Ok(result)
}
fn normalized(value: &Value) -> Result<String, String> {
    // ECMAScript trim, used by the existing metadata identity, is not Rust's
    // Unicode White_Space set: include FEFF and exclude0085.
    Ok(value
        .as_str()
        .ok_or(ERR)?
        .nfkc()
        .collect::<String>()
        .trim_matches(|c: char| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
        .to_lowercase())
}
fn keys(channel: &Value) -> Result<([u8; 32], [u8; 32]), String> {
    let provider = channel.get("providerId").unwrap_or(&Value::Null);
    Ok((
        hash(&json!([channel["sourceId"], provider]))?,
        hash(&json!([
            channel["sourceId"],
            provider.as_str().unwrap_or(""),
            normalized(&channel["name"])?,
            normalized(&channel["category"])?
        ]))?,
    ))
}
impl Plan {
    /// Only trusted native SQL snapshots may provide fences/preferences/catalog.
    /// Raw checkpoint is fully validated before any retained plan is constructed.
    pub(crate) fn admit(
        raw: &str,
        context: Context<'_>,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        let Context {
            preferences,
            catalog,
            fence,
            now,
            platform,
            observer_profile,
        } = context;
        if fence.catalog < 0 || fence.health < 0 || fence.checkpoint < 0 {
            return Err(ERR.into());
        }
        let value = super::manifest_seed(raw, preferences, catalog, fence.catalog, now, check)?;
        if value["platform"] != platform || value["observerProfile"] != observer_profile {
            return Err("scan-resume-profile-stale".into());
        }
        let candidates = value["review"]["candidates"].as_array().ok_or(ERR)?;
        let mut candidate_hashes = Vec::with_capacity(candidates.len());
        let mut primary_url_hashes = Vec::with_capacity(candidates.len());
        let mut providers = HashMap::<[u8; 32], usize>::new();
        let mut metadata = HashMap::<[u8; 32], usize>::new();
        for ordinal in 0..candidates.len() {
            if ordinal % 64 == 0 {
                check()?;
            }
            let candidate = super::resume_candidate(&value, ordinal)?;
            candidate_hashes.push(hash(&candidate)?);
            primary_url_hashes.push(reference_hash(&candidate["reference"]["urlHashes"][0])?);
            let (p, m) = keys(&candidate["channel"])?;
            if candidate["channel"]["providerId"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
            {
                *providers.entry(p).or_default() += 1;
            }
            *metadata.entry(m).or_default() += 1;
        }
        let mut progress: Vec<Progress> = (0..candidates.len())
            .map(|_| Progress {
                observation: None,
                published: false,
            })
            .collect();
        for row in value["observations"].as_array().ok_or(ERR)? {
            let ordinal = row[0].as_u64().ok_or(ERR)? as usize;
            progress[ordinal].observation = Some(
                serde_json::to_string(row)
                    .map_err(|_| ERR)?
                    .into_boxed_str(),
            );
        }
        for index in value["publishedIndices"].as_array().ok_or(ERR)? {
            progress[index.as_u64().ok_or(ERR)? as usize].published = true;
        }
        let counts = Counts {
            total: progress.len(),
            checked: value["observations"].as_array().ok_or(ERR)?.len(),
            responded: value["observations"]
                .as_array()
                .ok_or(ERR)?
                .iter()
                .filter(|o| matches!(o[2].as_str(), Some("Reachable" | "PlayedHere")))
                .count(),
            published: value["publishedIndices"].as_array().ok_or(ERR)?.len(),
        };
        let mut header = value;
        // Do not retain immutable tuples/category strings, mutable arrays, or raw JSON.
        header.as_object_mut().ok_or(ERR)?.remove("categoryTable");
        header.as_object_mut().ok_or(ERR)?.remove("observations");
        header
            .as_object_mut()
            .ok_or(ERR)?
            .remove("publishedIndices");
        header["review"]
            .as_object_mut()
            .ok_or(ERR)?
            .remove("candidates");
        if serde_json::to_vec(&header).map_err(|_| ERR)?.len() > PAGE_BYTES {
            return Err("scan-resume-header-limit".into());
        }
        let expires_at = header["createdAtMs"]
            .as_u64()
            .ok_or(ERR)?
            .checked_add(super::DAY)
            .ok_or(ERR)?;
        check()?;
        Ok(Self {
            fence,
            expires_at,
            header,
            candidate_hashes,
            primary_url_hashes,
            progress,
            counts,
            ambiguous_providers: providers
                .into_iter()
                .filter_map(|(k, n)| (n > 1).then_some(k))
                .collect(),
            ambiguous_metadata: metadata
                .into_iter()
                .filter_map(|(k, n)| (n > 1).then_some(k))
                .collect(),
        })
    }
    pub(crate) fn check_fence(&self, current: Fence, now: u64) -> Result<(), String> {
        if self.fence != current {
            return Err("scan-resume-plan-stale".into());
        }
        if now > self.expires_at || now < self.header["createdAtMs"].as_u64().ok_or(ERR)? {
            return Err("scan-checkpoint-expired".into());
        }
        Ok(())
    }
    pub(crate) fn counts(&self) -> Counts {
        self.counts.clone()
    }
    pub(crate) fn fence(&self) -> Fence {
        self.fence
    }
    pub(crate) fn pending_work(&self, index: usize) -> Option<&'static str> {
        let progress = self.progress.get(index)?;
        if progress.published {
            return None;
        }
        match progress.observation.as_deref() {
            None => Some("probe"),
            Some(raw) => {
                let observation: Value = serde_json::from_str(raw).ok()?;
                match observation[2].as_str() {
                    Some("Reachable" | "PlayedHere") => Some("publish"),
                    // Full checkpoint admission rejects unsettled evidence.
                    // An impossible retained state must not dispatch a probe.
                    Some("NotChecked" | "Canceled") => None,
                    _ => None,
                }
            }
        }
    }
    pub(crate) fn verify_original(
        &self,
        index: usize,
        metadata: &Value,
        urls: &[String],
    ) -> Result<(), String> {
        if self.candidate_hashes.get(index) != Some(&hash(metadata)?) {
            return Err("scan-resume-candidate-stale".into());
        }
        super::manifest_urls(metadata, urls)
    }
    pub(crate) fn validate_directory(
        &self,
        directory: &crate::scan_candidate_manifest::origin_directory::AdmittedDirectory,
    ) -> Result<(), String> {
        if directory.rows.len() != self.candidate_hashes.len() {
            return Err("scan-resume-directory-mismatch".into());
        }
        for (index, row) in directory.rows.iter().enumerate() {
            if row.ordinal != index
                || row.metadata_hash != self.candidate_hashes[index]
                || row.primary_url_hash != self.primary_url_hashes[index]
            {
                return Err("scan-resume-directory-mismatch".into());
            }
        }
        Ok(())
    }
    pub(crate) fn header(&self) -> &Value {
        &self.header
    }
    /// Small operational reply only; no raw checkpoint, candidates or settled arrays.
    pub(crate) fn public_header(&self, plan_id: &str) -> Result<Value, String> {
        if plan_id.is_empty()
            || plan_id.len() > 128
            || !plan_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(ERR.into());
        }
        let definitions = self.header["sourceDefinitions"].as_array().ok_or(ERR)?;
        let captured = self.header["review"]["sources"].as_array().ok_or(ERR)?;
        let source_policies:Vec<_>=definitions.iter().map(|definition| {
            let source=&definition["source"];
            let capture=captured.iter().find(|s|s["sourceId"]==source["id"]).ok_or(ERR)?;
            Ok(json!({"source":source,"definitionFingerprint":definition["definitionFingerprint"],"capturedFingerprint":capture["fingerprint"]}))
        }).collect::<Result<_,&str>>()?;
        let result = json!({"schemaVersion":1,"planId":plan_id,"jobId":self.header["jobId"],"reviewDigest":self.header["reviewDigest"],
            "sessionRevision":self.header["review"]["sessionRevision"],"query":self.header["review"]["query"],"createdAtMs":self.header["createdAtMs"],
            "platform":self.header["platform"],"observerProfile":self.header["observerProfile"],"budgetMs":self.header["budgetMs"],"sourcePolicies":source_policies,
            "counts":self.counts(),"revisions":{"catalogRevision":self.fence.catalog.to_string(),"healthRevision":self.fence.health.to_string(),"checkpointRevision":self.fence.checkpoint.to_string()}});
        if serde_json::to_vec(&result).map_err(|_| ERR)?.len() > PAGE_BYTES {
            return Err("scan-resume-header-limit".into());
        }
        Ok(result)
    }
    pub(crate) fn reconciliation_ambiguous(&self, channel: &Value) -> Result<(bool, bool), String> {
        let (p, m) = keys(channel)?;
        Ok((
            self.ambiguous_providers.contains(&p),
            self.ambiguous_metadata.contains(&m),
        ))
    }
    /// Input metadata/URLs must come from the joined authenticated manifest read.
    /// This additional comparison prevents substituting indexed metadata after admission.
    /// Contiguous original manifest pages are a primitive, NOT an origin-fair scheduler.
    pub(crate) fn page(
        &self,
        input: PageInput<'_>,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<Page, String> {
        let PageInput {
            fence: current,
            now,
            start,
            metadata,
            entries,
        } = input;
        self.check_fence(current, now)?;
        check()?;
        if entries.is_empty()
            || entries.len() > 64
            || metadata.len() != entries.len()
            || start
                .checked_add(entries.len())
                .is_none_or(|end| end > self.progress.len())
        {
            return Err(ERR.into());
        }
        let mut page = Page {
            schema_version: 1,
            start_index: start,
            next_index: start,
            rows: Vec::new(),
        };
        for (offset, (candidate, entry)) in metadata.iter().zip(entries).enumerate() {
            check()?;
            let ordinal = start + offset;
            if entry.candidate_index != ordinal
                || hash(candidate)? != self.candidate_hashes[ordinal]
            {
                return Err("scan-resume-candidate-stale".into());
            }
            super::manifest_urls(candidate, &entry.urls)?;
            page.next_index = ordinal + 1;
            let progress = &self.progress[ordinal];
            if progress.published {
                continue;
            }
            let observation = progress
                .observation
                .as_deref()
                .map(serde_json::from_str::<Value>)
                .transpose()
                .map_err(|_| ERR)?;
            if observation
                .as_ref()
                .is_some_and(|o| !matches!(o[2].as_str(), Some("Reachable" | "PlayedHere")))
            {
                continue;
            }
            let observation=observation.map(|o|json!({"channelId":candidate["key"],"sourceId":candidate["sourceId"],"fingerprint":candidate["sourceFingerprint"],"platform":self.header["platform"],"observedAt":o[1],"verdict":o[2],"evidence":o[3]}));
            let mut candidate = candidate.clone();
            candidate.as_object_mut().ok_or(ERR)?.remove("reference");
            candidate["channel"]["urls"] = json!(entry.urls);
            page.rows.push(Row {
                candidate_index: ordinal,
                candidate,
                work: if observation.is_some() {
                    "publish"
                } else {
                    "probe"
                },
                observation,
            });
            // Keep complete rows with an explicit cursor for every unreturned
            // ordinal. Reuse the authenticated encrypted-page suffix: next_index
            // is not necessarily a stored SQL page boundary.
            if serde_json::to_vec(&page).map_err(|_| ERR)?.len() > PAGE_BYTES - 64 {
                page.rows.pop(); // Drop wipes the removed row's URL copies.
                page.next_index = ordinal;
                if page.rows.is_empty() {
                    return Err("scan-resume-page-limit".into());
                }
                break;
            }
        }
        check()?;
        Ok(page)
    }
    /// Only a private proof created after the existing SQL core's actual COMMIT
    /// can advance this plan. Validate the complete bounded delta before mutation.
    pub(crate) fn accept_delta(
        &mut self,
        receipt: &CommitReceipt,
        delta: &crate::storage_transaction::storage_resume_commit::CommittedDelta,
    ) -> Result<(), String> {
        let base = delta.base();
        let after = delta.after();
        let max_rows = match delta.version() {
            1 => 64,
            2 => 240,
            _ => return Err("scan-resume-commit-stale".into()),
        };
        if base != self.fence
            || !receipt.committed
            || after.root_generation != base.root_generation
            || after.catalog < base.catalog
            || after.catalog > base.catalog.checked_add(1).ok_or(ERR)?
            || after.health < base.health
            || after.health > base.health.checked_add(1).ok_or(ERR)?
            || after.checkpoint != base.checkpoint.checked_add(1).ok_or(ERR)?
            || receipt.catalog_revision != after.catalog.to_string()
            || receipt.health_revision != after.health.to_string()
            || receipt.checkpoint_revision.as_deref() != Some(after.checkpoint.to_string().as_str())
            || delta.observation_tuples().len() > max_rows
            || delta.published_indices().len() > max_rows
        {
            return Err("scan-resume-commit-stale".into());
        }
        let mut observations = Vec::new();
        let mut observed = HashSet::new();
        let mut counts = self.counts.clone();
        for tuple in delta.observation_tuples() {
            let index = tuple[0].as_u64().ok_or(ERR)? as usize;
            let progress = self.progress.get(index).ok_or(ERR)?;
            if !observed.insert(index) {
                return Err(ERR.into());
            }
            let encoded = serde_json::to_string(tuple)
                .map_err(|_| ERR)?
                .into_boxed_str();
            if let Some(previous) = progress.observation.as_ref() {
                if previous != &encoded {
                    return Err("scan-resume-progress-conflict".into());
                }
            } else {
                counts.checked = counts.checked.checked_add(1).ok_or(ERR)?;
                if matches!(tuple[2].as_str(), Some("Reachable" | "PlayedHere")) {
                    counts.responded = counts.responded.checked_add(1).ok_or(ERR)?;
                }
            }
            observations.push((index, encoded));
        }
        let mut published = HashSet::new();
        for &index in delta.published_indices() {
            let progress = self.progress.get(index).ok_or(ERR)?;
            if !published.insert(index) {
                return Err(ERR.into());
            }
            let tuple = delta
                .observation_tuples()
                .iter()
                .find(|tuple| tuple[0].as_u64() == Some(index as u64));
            let positive = tuple
                .is_some_and(|tuple| matches!(tuple[2].as_str(), Some("Reachable" | "PlayedHere")))
                || progress
                    .observation
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                    .is_some_and(|tuple| {
                        matches!(tuple[2].as_str(), Some("Reachable" | "PlayedHere"))
                    });
            if !positive {
                return Err("scan-resume-publication-unconfirmed".into());
            }
            if !progress.published {
                counts.published = counts.published.checked_add(1).ok_or(ERR)?;
            }
        }
        if counts.checked > counts.total
            || counts.responded > counts.checked
            || counts.published > counts.responded
        {
            return Err(ERR.into());
        }
        for (index, observation) in observations {
            self.progress[index].observation = Some(observation);
        }
        for index in published {
            self.progress[index].published = true;
        }
        self.counts = counts;
        self.fence = after;
        Ok(())
    }
    /// PRIVATE post-commit integration seam. Never expose a client rebase command.
    /// `after` and raw/prefs/catalog must be captured from actual committed SQL under
    /// the retained Store generation; receipt equality alone is not an attestation.
    pub(crate) fn accept_committed(
        &mut self,
        receipt: &CommitReceipt,
        context: Context<'_>,
        raw: &str,
        check: &mut impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        let after = context.fence;
        if !receipt.committed
            || after.root_generation != self.fence.root_generation
            || after.catalog < self.fence.catalog
            || after.catalog > self.fence.catalog.checked_add(1).ok_or(ERR)?
            || after.health < self.fence.health
            || after.health > self.fence.health.checked_add(1).ok_or(ERR)?
            || after.checkpoint != self.fence.checkpoint.checked_add(1).ok_or(ERR)?
            || receipt.catalog_revision != after.catalog.to_string()
            || receipt.health_revision != after.health.to_string()
            || receipt.checkpoint_revision.as_deref() != Some(after.checkpoint.to_string().as_str())
        {
            return Err("scan-resume-commit-stale".into());
        }
        let next = Self::admit(raw, context, check)?;
        if next.candidate_hashes != self.candidate_hashes
            || next.header["jobId"] != self.header["jobId"]
            || next.header["reviewDigest"] != self.header["reviewDigest"]
            || next.header["policyFingerprint"] != self.header["policyFingerprint"]
            || next.expires_at != self.expires_at
            || next.header["platform"] != self.header["platform"]
            || next.header["observerProfile"] != self.header["observerProfile"]
        {
            return Err("scan-resume-immutable-stale".into());
        }
        for (old, new) in self.progress.iter().zip(&next.progress) {
            if (old.published && !new.published)
                || old
                    .observation
                    .as_ref()
                    .is_some_and(|o| new.observation.as_ref() != Some(o))
            {
                return Err("scan-resume-progress-conflict".into());
            }
        }
        check()?;
        *self = next;
        Ok(())
    }
}
#[cfg(test)]
#[path = "scan_resume_plan_tests.rs"]
pub(crate) mod tests;
