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

//! PairStore's scan checkpoint reads and the scan candidate manifest.

use super::*;

impl PairStore {
    pub fn read_scan_checkpoint(&self) -> Result<crate::scan_checkpoint::Snapshot, String> {
        self.read_checkpoint_after_capture(|| Ok(()))
    }

    pub(super) fn manifest_context<T>(
        c: &Connection,
        action: impl FnOnce(&crate::scan_candidate_manifest::Context<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        // Only authority fields are needed per page: no channel/URL/health/checkpoint body read.
        let mut sources_stmt =
            sql(c.prepare("SELECT id,name,kind,location,allow_http,content_kind,media_mime FROM source ORDER BY ordinal LIMIT 101"))?;
        let sources=sql(sources_stmt.query_map([],|r|{
            let mut value=json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"location":r.get::<_,String>(3)?});
            if r.get::<_,bool>(4)?{value["allowHttp"]=json!(true);}
            if let Some(kind)=r.get::<_,Option<String>>(5)?{value["contentKind"]=json!(kind);}
            if let Some(mime)=r.get::<_,Option<String>>(6)?{value["mediaMime"]=json!(mime);}
            Ok(value)
        }))?.collect::<rusqlite::Result<Vec<_>>>();
        let sources = sql(sources)?;
        if sources.len() > 100 {
            return Err("scan-manifest-source-limit".into());
        }
        let catalog = json!({"schemaVersion":1,"sources":sources,"channels":[]});
        let (present,providers,region):(bool,Option<String>,Option<String>)=sql(c.query_row("SELECT metadata.preferences_present,preference.reviewed_channel_providers,preference.preferred_region FROM metadata JOIN preference ON preference.singleton=metadata.singleton WHERE metadata.singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))))?;
        if !present {
            return Err("scan-checkpoint-preferences-required".into());
        }
        let mut preferences = json!({});
        for (name, raw) in [
            ("reviewedChannelProviders", providers),
            ("preferredRegion", region),
        ] {
            if let Some(raw) = raw {
                if raw.len() > 2 * 1024 * 1024 {
                    return Err("scan-manifest-authority-limit".into());
                }
                // These columns contain an extension array/object, not a schemaVersion record.
                preferences[name] =
                    serde_json::from_str(&raw).map_err(|_| "record-invalid-json")?;
            }
        }
        preference_extensions::normalize(&mut preferences)?;
        let catalog_revision: i64 = sql(c.query_row(
            "SELECT catalog_revision FROM metadata WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        let exists: bool = sql(c.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_checkpoint')",
            [],
            |r| r.get(0),
        ))?;
        let checkpoint_revision = if exists {
            sql(c.query_row(
                "SELECT revision FROM scan_checkpoint WHERE singleton=1",
                [],
                |r| r.get::<_, i64>(0),
            ))?
        } else {
            0
        };
        action(&crate::scan_candidate_manifest::Context {
            preferences: &preferences,
            catalog: &catalog,
            catalog_revision,
            checkpoint_revision,
            now: scan_now(),
        })
    }

    pub(crate) fn begin_scan_candidate_manifest(
        &self,
        request: &crate::scan_candidate_manifest::Begin,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::Header, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), false)?;
        self.backup_with_check(&c, &mut check)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        // Initial semantic validation needs the full catalog once, including published targets.
        let pair = Self::read_connection(&tx)?;
        let full_catalog = pair
            .catalog
            .as_deref()
            .map(parse)
            .transpose()?
            .unwrap_or_else(|| json!({"schemaVersion":1,"sources":[],"channels":[]}));
        let result = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::begin(
                &tx,
                request,
                &crate::scan_candidate_manifest::Context {
                    catalog: &full_catalog,
                    ..*context
                },
                &mut check,
            )
        })?;
        check()?;
        sql(tx.commit())?;
        Ok(result)
    }

    pub(crate) fn prepare_scan_candidate_manifest_page(
        &self,
        request: crate::scan_candidate_manifest::Append,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::PreparedPage, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let result = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::prepare_page(&tx, request, context, &mut check)
        })?;
        sql(tx.commit())?;
        check()?;
        Ok(result)
    }

    pub(crate) fn append_scan_candidate_manifest_page(
        &self,
        prepared: &crate::scan_candidate_manifest::PreparedPage,
        ciphertext: &[u8],
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::Header, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), false)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let result = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::append_page(
                &tx, prepared, ciphertext, context, &mut check,
            )
        })?;
        check()?;
        sql(tx.commit())?;
        Ok(result)
    }

    pub(crate) fn prepare_scan_candidate_manifest_seal(
        &self,
        request: &crate::scan_candidate_manifest::Seal,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::origin_directory::PreparedCapsule, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let prepared = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::origin_directory::prepare_seal(
                &tx, request, context, &mut check,
            )
        })?;
        sql(tx.commit())?;
        check()?;
        Ok(prepared)
    }

    #[cfg(test)]
    pub(crate) fn seal_scan_candidate_manifest(
        &self,
        request: &crate::scan_candidate_manifest::Seal,
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.seal_scan_candidate_manifest_inner(request, None, check)
    }

    pub(crate) fn seal_protected_scan_candidate_manifest(
        &self,
        request: &crate::scan_candidate_manifest::Seal,
        prepared: &crate::scan_candidate_manifest::origin_directory::PreparedCapsule,
        ciphertext: &[u8],
        check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        self.seal_scan_candidate_manifest_inner(request, Some((prepared, ciphertext)), check)
    }

    pub(super) fn seal_scan_candidate_manifest_inner(
        &self,
        request: &crate::scan_candidate_manifest::Seal,
        protection: Option<(
            &crate::scan_candidate_manifest::origin_directory::PreparedCapsule,
            &[u8],
        )>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<CommitReceipt, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), false)?;
        self.backup_with_check(&c, &mut check)?;
        let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let seed = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::seal_seed(&tx, request, context)
        })?;
        if let Some((prepared, ciphertext)) = protection {
            Self::manifest_context(&tx, |context| {
                crate::scan_candidate_manifest::origin_directory::finish_seal(
                    &tx, request, prepared, ciphertext, context, &mut check,
                )
            })?;
        }
        let mutation = crate::scan_checkpoint::Mutation::Save { checkpoint: seed };
        let expected = crate::scan_checkpoint::revision(&request.expected_catalog_revision)?;
        let scan_revision =
            crate::scan_checkpoint::revision(&request.expected_checkpoint_revision)?;
        let pair = RecordPair::default();
        let validated = validate(&pair)?;
        let receipt = Self::apply_scan_transaction(
            &tx,
            &pair,
            None,
            (Some(expected), None),
            Some((&mutation, scan_revision, scan_now())),
            PairReuse {
                validated,
                before: None,
                projection_ids: None,
                health_groups: None,
                observer: None,
            },
            &mut |_| check(),
        )?;
        crate::scan_candidate_manifest::seal(&tx, request)?;
        check()?;
        sql(tx.commit())?;
        Ok(receipt)
    }

    pub(crate) fn find_scan_candidate_manifest(
        &self,
        request: &crate::scan_candidate_manifest::Find,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::Found, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let result = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::find(&tx, request, context)
        })?;
        sql(tx.commit())?;
        check()?;
        Ok(result)
    }

    pub(crate) fn read_scan_candidate_manifest_page(
        &self,
        request: &crate::scan_candidate_manifest::Read,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::EncryptedPage, String> {
        check()?;
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let result = Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::read_page(&tx, request, context)
        })?;
        sql(tx.commit())?;
        check()?;
        Ok(result)
    }

    pub(crate) fn finish_scan_candidate_manifest_page(
        &self,
        request: &crate::scan_candidate_manifest::Read,
        page: crate::scan_candidate_manifest::EncryptedPage,
        plaintext: Vec<u8>,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<crate::scan_candidate_manifest::Page, String> {
        let mut plaintext = zeroize::Zeroizing::new(plaintext);
        check()?;
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        Self::manifest_context(&tx, |context| {
            crate::scan_candidate_manifest::verify_read(&tx, request, context, &page)
        })?;
        sql(tx.commit())?;
        check()?;
        crate::scan_candidate_manifest::finish_page(page, std::mem::take(&mut *plaintext))
    }

    pub(crate) fn read_checkpoint_after_capture(
        &self,
        after: impl FnOnce() -> Result<(), String>,
    ) -> Result<crate::scan_checkpoint::Snapshot, String> {
        let mut c = connect(&self.root.join(DB), true)?;
        let tx = sql(c.transaction())?;
        let revision: i64 = sql(tx.query_row(
            "SELECT catalog_revision FROM metadata WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        let captured = crate::scan_checkpoint::capture(&tx)?;
        let captured_pair = if captured.has_contents() {
            Some(Self::capture_pair(&tx)?)
        } else {
            None
        };
        sql(tx.commit())?;
        after()?;
        let mut snapshot = crate::scan_checkpoint::finish(captured, revision)?;
        if let Some(raw) = &snapshot.checkpoint {
            let pair = Self::finish_pair(captured_pair.ok_or("scan-checkpoint-invalid")?)?;
            let catalog = pair
                .catalog
                .as_deref()
                .map(parse)
                .transpose()?
                .unwrap_or_else(|| json!({"schemaVersion":1,"sources":[],"channels":[]}));
            let prefs = pair
                .preferences
                .as_deref()
                .map(parse)
                .transpose()?
                .unwrap_or_else(|| json!({}));
            if crate::scan_checkpoint::validate(raw, &prefs, &catalog, revision, scan_now())
                .is_err()
            {
                snapshot.checkpoint_status = "invalid";
                snapshot.checkpoint = None;
            }
        }
        Ok(snapshot)
    }
}
