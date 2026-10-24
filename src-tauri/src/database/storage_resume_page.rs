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

//! Bounded containing-page acquisition after full native plan admission. No
//! checkpoint body or whole canonical pair is read here. The outer retained
//! Store owner must compare root generations across platform crypto.
use super::*;
use crate::scan_candidate_manifest::{
    self as manifest, AuthenticatedPage, EncryptedPage, Find, Read,
};
use crate::scan_checkpoint::resume_plan::Fence;
use rusqlite::OptionalExtension;
use zeroize::Zeroizing;

pub(crate) struct PreparedResumePage {
    pub encrypted_page: EncryptedPage,
    pub start_index: usize,
    pub requested_index: usize,
    request: Read,
    fence: Fence,
}
// One request-local page only. Private fields prevent caller-built cache proofs.
// URLs live solely in AuthenticatedPage and are zeroized by its Drop.
pub(crate) struct CachedResumePage {
    page: AuthenticatedPage,
    image: manifest::ReadIdentity,
    request: Read,
    fence: Fence,
}
impl CachedResumePage {
    pub(crate) fn matches(&self, fence: Fence, job: &str, digest: &str, index: usize) -> bool {
        self.fence == fence
            && self.request.job_id == job
            && self.request.review_digest == digest
            && index >= self.page.page.start_index
            && index < self.page.page.next_index
    }
}
fn check_fence(c: &Connection, expected: Fence) -> Result<(), String> {
    let (catalog, health): (i64, i64) = sql(c.query_row(
        "SELECT catalog_revision,health_revision FROM metadata WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    let checkpoint: i64 = sql(c.query_row(
        "SELECT revision FROM scan_checkpoint WHERE singleton=1",
        [],
        |r| r.get(0),
    ))?;
    if catalog != expected.catalog || health != expected.health || checkpoint != expected.checkpoint
    {
        return Err("scan-resume-plan-stale".into());
    }
    Ok(())
}
impl PairStore {
    pub(crate) fn prepare_scan_resume_page(
        &self,
        plan_fence: Fence,
        job_id: &str,
        digest: &str,
        requested_index: usize,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<PreparedResumePage, String> {
        if requested_index >= 100_000
            || plan_fence.catalog < 0
            || plan_fence.health < 0
            || plan_fence.checkpoint < 0
        {
            return Err("scan-resume-page-invalid".into());
        }
        check()?;
        let mut c = connect_background(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        check_fence(&tx, plan_fence)?;
        let find = Find {
            job_id: job_id.to_owned(),
            review_digest: digest.to_owned(),
            expected_catalog_revision: plan_fence.catalog.to_string(),
            expected_checkpoint_revision: plan_fence.checkpoint.to_string(),
        };
        let (request, encrypted_page) = Self::manifest_context(&tx, |context| {
            // find/read_page validate current job, immutable source authority,
            // captured policy and TTL. They do not load the checkpoint graph.
            let header = manifest::find(&tx, &find, context)?
                .header
                .ok_or("scan-manifest-absent")?;
            if requested_index >= header.candidate_count {
                return Err("scan-resume-page-invalid".into());
            }
            // Composite primary key(manifest_id,start_index) gives an indexed
            // predecessor seek, followed by exact containment validation.
            let row:Option<(i64,i64)>=sql(tx.query_row(
                "SELECT start_index,item_count FROM scan_manifest_page WHERE manifest_id=?1 AND start_index<=?2 ORDER BY start_index DESC LIMIT 1",
                params![header.manifest_id,requested_index as i64],|r|Ok((r.get(0)?,r.get(1)?))
            ).optional())?;
            let (start, count) = row.ok_or("scan-manifest-page-absent")?;
            if start < 0
                || !(1..=64).contains(&count)
                || start
                    .checked_add(count)
                    .is_none_or(|end| requested_index as i64 >= end)
            {
                return Err("scan-manifest-page-absent".into());
            }
            check()?;
            let request = Read {
                manifest_id: header.manifest_id,
                job_id: find.job_id.clone(),
                review_digest: find.review_digest.clone(),
                start_index: start as usize,
                expected_catalog_revision: find.expected_catalog_revision.clone(),
                expected_checkpoint_revision: find.expected_checkpoint_revision.clone(),
            };
            let page = manifest::read_page(&tx, &request, context)?;
            Ok((request, page))
        })?;
        sql(tx.commit())?;
        check()?;
        Ok(PreparedResumePage {
            start_index: request.start_index,
            requested_index,
            encrypted_page,
            request,
            fence: plan_fence,
        })
    }
    #[cfg(test)]
    pub(crate) fn finish_scan_resume_page(
        &self,
        proof: PreparedResumePage,
        plaintext: Vec<u8>,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<AuthenticatedPage, String> {
        self.finish_cached_scan_resume_page(proof, plaintext, check)
            .map(|cached| cached.page)
    }
    pub(crate) fn finish_cached_scan_resume_page(
        &self,
        mut proof: PreparedResumePage,
        plaintext: Vec<u8>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<CachedResumePage, String> {
        let mut plaintext = Zeroizing::new(plaintext);
        check()?;
        let image = proof.encrypted_page.take_identity();
        let mut c = connect_background(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        check_fence(&tx, proof.fence)?;
        Self::manifest_context(&tx, |context| {
            manifest::verify_read(&tx, &proof.request, context, &proof.encrypted_page)?;
            manifest::verify_cached_read(&tx, &proof.request, context, &image, &mut check)
        })?;
        sql(tx.commit())?;
        check()?;
        let result = manifest::finish_page_authenticated(
            proof.encrypted_page,
            std::mem::take(&mut *plaintext),
        )?;
        if result.page.start_index != proof.start_index
            || proof.requested_index < result.page.start_index
            || proof.requested_index >= result.page.next_index
        {
            return Err("scan-resume-page-invalid".into());
        }
        check()?;
        Ok(CachedResumePage {
            page: result,
            image,
            request: proof.request,
            fence: proof.fence,
        })
    }
    pub(crate) fn verify_cached_scan_resume_page(
        &self,
        cached: &CachedResumePage,
        fence: Fence,
        job: &str,
        digest: &str,
        index: usize,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<AuthenticatedPage, String> {
        check()?;
        if !cached.matches(fence, job, digest, index) {
            return Err("scan-resume-plan-stale".into());
        }
        let mut c = connect_background(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        check_fence(&tx, fence)?;
        // Re-run the original indexed containing-page selection. An overlapping
        // row inserted without a revision bump must not make the old MRU proof
        // stand in for the page the fresh full-read path would now select.
        let containing: Option<(i64,i64)> = sql(tx.query_row(
            "SELECT start_index,item_count FROM scan_manifest_page WHERE manifest_id=?1 AND start_index<=?2 ORDER BY start_index DESC LIMIT 1",
            params![cached.request.manifest_id,index as i64], |r|Ok((r.get(0)?,r.get(1)?))
        ).optional())?;
        if containing
            != Some((
                cached.page.page.start_index as i64,
                cached.page.page.entries.len() as i64,
            ))
        {
            return Err("scan-manifest-page-absent".into());
        }
        Self::manifest_context(&tx, |context| {
            manifest::verify_cached_read(&tx, &cached.request, context, &cached.image, &mut check)
        })?;
        sql(tx.commit())?;
        check()?;
        let selected = cached.page.selected(index)?;
        check()?;
        Ok(selected)
    }
}
#[cfg(test)]
#[path = "storage_resume_page_tests.rs"]
mod tests;
