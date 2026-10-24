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

//! Retained request/work/root owner for indexed activation. OS protection occurs
//! after each SQL/store lease ends. IPC receives no candidate/checkpoint graph.
use crate::{
    scan_candidate_manifest::Seal,
    scan_manifest_work,
    storage_transaction::source_snapshot_activation::{Reply, Request},
};
use std::io::Write;
use tauri::Emitter;
#[path = "source_snapshot_activation_progress.rs"]
mod progress;

pub(crate) async fn activate(
    request: Request,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Reply, String> {
    let protection_app = app.clone();
    let progress_app = app.clone();
    let progress_request_id = request_id.clone();
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (activation, generation) = owner
            .storage(None, move |store, check| {
                store.prepare_source_snapshot_activation(request, std::env::consts::OS, check)
            })
            .await?;
        let request = activation.request;
        let started = std::time::Instant::now();
        let mut publisher = progress::Publisher::new(
            progress_request_id,
            generation,
            activation.header.as_ref().map_or(0, |h| h.candidate_count),
        )
        .ok();
        let mut delivery_failed = false;
        let mut publish = |prepared, phase| {
            if owner.check().is_err() {
                return;
            }
            if let Some(publisher) = publisher.as_mut() {
                if let Ok(Some(payload)) = publisher.sample(
                    prepared,
                    phase,
                    started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                ) {
                    if progress_app
                        .emit("source-activation-progress", payload)
                        .is_err()
                        && !delivery_failed
                    {
                        delivery_failed = true;
                        let _ = writeln!(
                            std::io::stderr().lock(),
                            "source-activation-progress-unavailable"
                        );
                    }
                }
            }
        };
        publish(
            activation.header.as_ref().map_or(0, |h| h.next_index),
            progress::Phase::Preparing,
        );
        let Some(mut header) = activation.header else {
            return Ok(Reply {
                schema_version: 1,
                job_id: None,
                review_digest: None,
                candidate_count: 0,
                catalog_revision: request.expected_catalog_revision,
                checkpoint_revision: request.expected_checkpoint_revision,
            });
        };
        while header.next_index < header.candidate_count {
            owner.check()?;
            let page_request = request.clone();
            let page_header = header.clone();
            let (prepared, _) = owner
                .storage(Some(generation), move |store, check| {
                    store.prepare_source_snapshot_activation_page(
                        &page_request,
                        &page_header,
                        check,
                    )
                })
                .await?;
            owner.check()?;
            let ciphertext = crate::protect_scan_manifest_page(
                protection_app.clone(),
                prepared.binding.clone(),
                prepared.plaintext.clone(),
                false,
            )
            .await?;
            owner.check()?;
            let (next, _) = owner
                .storage(Some(generation), move |store, check| {
                    store.append_scan_candidate_manifest_page(&prepared, &ciphertext, check)
                })
                .await?;
            header = next;
            // Count only the candidates whose encrypted pages actually committed.
            publish(header.next_index, progress::Phase::Preparing);
        }
        publish(header.next_index, progress::Phase::Sealing);
        owner.check()?;
        let seal = Seal {
            manifest_id: header.manifest_id.clone(),
            expected_manifest_revision: header.manifest_revision.clone(),
            expected_catalog_revision: request.expected_catalog_revision.clone(),
            expected_checkpoint_revision: request.expected_checkpoint_revision.clone(),
        };
        let ((seal, prepared), _) = owner
            .storage(Some(generation), move |store, check| {
                let prepared = store.prepare_scan_candidate_manifest_seal(&seal, check)?;
                Ok((seal, prepared))
            })
            .await?;
        owner.check()?;
        let ciphertext = crate::protect_scan_manifest_page(
            protection_app,
            prepared.binding.clone(),
            prepared.plaintext.clone(),
            false,
        )
        .await?;
        owner.check()?;
        let (receipt, _) = owner
            .storage(Some(generation), move |store, check| {
                store.seal_source_snapshot_activation(
                    &request,
                    &seal,
                    &prepared,
                    &ciphertext,
                    check,
                )
            })
            .await?;
        // A durable seal survives cancellation after COMMIT. Opening a Registry
        // episode is a separate existing owned command using these exact fences.
        Ok(Reply {
            schema_version: 1,
            job_id: Some(header.job_id),
            review_digest: Some(header.review_digest),
            candidate_count: header.candidate_count,
            catalog_revision: receipt.catalog_revision,
            checkpoint_revision: receipt
                .checkpoint_revision
                .ok_or("source-activation-receipt-invalid")?,
        })
    })
    .await
}
