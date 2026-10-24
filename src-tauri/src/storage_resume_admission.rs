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

//! Native full admission followed by authenticated directory admission. Platform
//! crypto and Store-generation ownership stay in the caller, outside SQL leases.
use super::*;
use crate::scan_candidate_manifest::{origin_directory, Find};
use crate::scan_checkpoint::resume_plan::{Context as PlanContext, Fence, Plan};
use zeroize::Zeroizing;

pub(crate) struct PreparedAdmission {
    pub plan: Plan,
    pub find: Find,
    pub encrypted_capsule: origin_directory::EncryptedCapsule,
}
pub(crate) struct Admitted {
    pub plan: Plan,
    pub directory: origin_directory::AdmittedDirectory,
}
fn revisions(c: &Connection, root_generation: u64) -> Result<Fence, String> {
    let (catalog, health): (i64, i64) = sql(c.query_row(
        "SELECT catalog_revision,health_revision FROM metadata WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    let exists: bool = sql(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_checkpoint')",
        [],
        |r| r.get(0),
    ))?;
    let checkpoint = if exists {
        sql(c.query_row(
            "SELECT revision FROM scan_checkpoint WHERE singleton=1",
            [],
            |r| r.get::<_, i64>(0),
        ))?
    } else {
        0
    };
    if catalog < 0 || health < 0 || checkpoint < 0 {
        return Err("scan-resume-plan-invalid".into());
    }
    Ok(Fence {
        root_generation,
        catalog,
        health,
        checkpoint,
    })
}
impl PairStore {
    pub(crate) fn prepare_scan_resume_admission(
        &self,
        expected_catalog: &str,
        expected_checkpoint: &str,
        root_generation: u64,
        platform: &str,
        profile: &str,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<PreparedAdmission, String> {
        self.prepare_scan_resume_admission_profile(
            expected_catalog,
            expected_checkpoint,
            root_generation,
            platform,
            |_| Ok(profile.to_owned()),
            &mut check,
        )
    }
    pub(crate) fn prepare_scan_resume_admission_runtime(
        &self,
        expected_catalog: &str,
        expected_checkpoint: &str,
        root_generation: u64,
        platform: &str,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<PreparedAdmission, String> {
        self.prepare_scan_resume_admission_profile(
            expected_catalog,
            expected_checkpoint,
            root_generation,
            platform,
            |budget| {
                if !matches!(budget, 20_000 | 45_000 | 60_000) {
                    return Err("scan-resume-profile-stale".into());
                }
                Ok(format!(
                    "reachability-v3/native-media-resources-v1/max-{budget}/sequential"
                ))
            },
            check,
        )
    }
    fn prepare_scan_resume_admission_profile(
        &self,
        expected_catalog: &str,
        expected_checkpoint: &str,
        root_generation: u64,
        platform: &str,
        resolve_profile: impl FnOnce(i64) -> Result<String, String>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<PreparedAdmission, String> {
        let expected_catalog = crate::scan_checkpoint::revision(expected_catalog)?;
        let expected_checkpoint = crate::scan_checkpoint::revision(expected_checkpoint)?;
        check()?;
        let mut c = connect_background(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let fence = revisions(&tx, root_generation)?;
        if fence.catalog != expected_catalog || fence.checkpoint != expected_checkpoint {
            return Err("scan-resume-plan-stale".into());
        }
        let captured_pair = Self::capture_pair(&tx)?;
        let captured_checkpoint = crate::scan_checkpoint::capture(&tx)?;
        if !captured_checkpoint.has_contents() {
            return Err("scan-checkpoint-absent".into());
        }
        let budget: i64 = sql(tx.query_row(
            "SELECT json_extract(contents,'$.budgetMs') FROM scan_checkpoint WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        let profile = resolve_profile(budget)?;
        sql(tx.commit())?;
        check()?;
        // Full canonical and checkpoint validation takes place after releasing
        // DELETE journal reader ownership. Nothing is admitted from scalar counts.
        let pair = Self::finish_pair_canonical(captured_pair)?;
        let snapshot = crate::scan_checkpoint::finish(captured_checkpoint, fence.catalog)?;
        let raw = Zeroizing::new(
            snapshot
                .checkpoint
                .ok_or(match snapshot.checkpoint_status {
                    "absent" => "scan-checkpoint-absent",
                    _ => "scan-checkpoint-invalid",
                })?,
        );
        let catalog = pair
            .catalog
            .unwrap_or_else(|| json!({"schemaVersion":1,"sources":[],"channels":[]}));
        let preferences = pair
            .preferences
            .ok_or("scan-checkpoint-preferences-required")?;
        let plan = Plan::admit(
            &raw,
            PlanContext {
                preferences: &preferences,
                catalog: &catalog,
                fence,
                now: scan_now(),
                platform,
                observer_profile: &profile,
            },
            &mut check,
        )?;
        let find = Find {
            job_id: plan.header()["jobId"]
                .as_str()
                .ok_or("scan-resume-plan-invalid")?
                .to_owned(),
            review_digest: plan.header()["reviewDigest"]
                .as_str()
                .ok_or("scan-resume-plan-invalid")?
                .to_owned(),
            expected_catalog_revision: fence.catalog.to_string(),
            expected_checkpoint_revision: fence.checkpoint.to_string(),
        };
        // Re-establish the exact same authority snapshot before obtaining the
        // OS-crypto proof. No full catalog/checkpoint graph is retained or reread.
        let tx = sql(c.transaction())?;
        plan.check_fence(revisions(&tx, root_generation)?, scan_now())?;
        let encrypted_capsule = Self::manifest_context(&tx, |context| {
            crate::scan_checkpoint::manifest_authority(
                plan.header(),
                context.preferences,
                context.catalog,
                context.catalog_revision,
                context.now,
            )?;
            origin_directory::prepare_open(&tx, &find, context, &mut check)
        })?;
        sql(tx.commit())?;
        check()?;
        Ok(PreparedAdmission {
            plan,
            find,
            encrypted_capsule,
        })
    }
    pub(crate) fn finish_scan_resume_admission(
        &self,
        prepared: PreparedAdmission,
        plaintext: Vec<u8>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<Admitted, String> {
        // Wipe even when pre-admission cancellation or stale SQL fences fail.
        let mut plaintext = Zeroizing::new(plaintext);
        check()?;
        let mut c = connect_background(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let fence = prepared.plan.fence();
        prepared
            .plan
            .check_fence(revisions(&tx, fence.root_generation)?, scan_now())?;
        let directory = Self::manifest_context(&tx, |context| {
            crate::scan_checkpoint::manifest_authority(
                prepared.plan.header(),
                context.preferences,
                context.catalog,
                context.catalog_revision,
                context.now,
            )?;
            origin_directory::finish_open(
                &tx,
                &prepared.find,
                &prepared.encrypted_capsule,
                std::mem::take(&mut *plaintext),
                context,
                &mut check,
            )
        })?;
        prepared.plan.validate_directory(&directory)?;
        check()?;
        sql(tx.commit())?;
        Ok(Admitted {
            plan: prepared.plan,
            directory,
        })
    }
}
#[cfg(test)]
#[path = "storage_resume_admission_tests.rs"]
mod tests;
