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

//! Small authority recheck immediately around owned network work; no full pair/CP read.
use super::*;
use crate::scan_checkpoint::resume_plan::Fence;
impl PairStore {
    pub(crate) fn validate_scan_resume_authority(
        &self,
        fence: Fence,
        header: &Value,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        check()?;
        let mut c = connect_background(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let (catalog, health): (i64, i64) = sql(tx.query_row(
            "SELECT catalog_revision,health_revision FROM metadata WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        let checkpoint: i64 = sql(tx.query_row(
            "SELECT revision FROM scan_checkpoint WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        if (catalog, health, checkpoint) != (fence.catalog, fence.health, fence.checkpoint) {
            return Err("scan-resume-plan-stale".into());
        }
        Self::manifest_context(&tx, |context| {
            crate::scan_checkpoint::manifest_authority(
                header,
                context.preferences,
                context.catalog,
                context.catalog_revision,
                context.now,
            )
        })?;
        check()?;
        sql(tx.commit())?;
        Ok(())
    }
}
