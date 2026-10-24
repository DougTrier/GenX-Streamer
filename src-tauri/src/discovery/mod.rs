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

//! Source Discovery: finding channels. Scans of playlists and websites, the
//! network probes that check streams, resumable scan checkpoints and the
//! source directory.
//!
//! Guide for contributors: docs/components/source-discovery.md.

pub(crate) mod discovery_input;
pub(crate) mod discovery_unavailable;
pub(crate) mod local_streams;
pub(crate) mod network;
pub(crate) mod network_media_probe;
pub(crate) mod scan_batch;
pub(crate) mod scan_candidate_manifest;
pub(crate) mod scan_checkpoint;
pub(crate) mod scan_checkpoint_summary;
pub(crate) mod scan_manifest_work;
pub(crate) mod scan_resume_commit_owner;
pub(crate) mod scan_resume_owner;
pub(crate) mod scan_resume_probe;
pub(crate) mod scan_resume_projection;
pub(crate) mod scan_resume_reconcile;
pub(crate) mod scan_resume_registry;
pub(crate) mod scan_resume_release;
pub(crate) mod scan_resume_runtime;
pub(crate) mod scan_resume_take;
pub(crate) mod scan_window;
pub(crate) mod source_directory;
pub(crate) mod source_snapshot_activation_owner;
