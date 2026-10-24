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

//! Platform adapters: what differs between Windows and Android. Close and
//! shutdown ownership, device capabilities, speech, VPN status, renderer
//! recovery, diagnostics, start-up milestones and the request registry.
//!
//! Guide for contributors: docs/components/platform-adapters.md.

#[cfg(any(target_os = "android", test))]
#[cfg_attr(
    all(test, not(target_os = "android")),
    allow(
        dead_code,
        reason = "Compile Android envelope tests on the Windows test host; production callers are Android-only."
    )
)]
pub(crate) mod android_manifest_protector;
#[cfg(any(target_os = "android", test))]
pub(crate) mod android_task_finish;
pub(crate) mod app_update;
pub(crate) mod close_owner;
pub(crate) mod device_capabilities;
pub(crate) mod diagnostics;
#[cfg(any(target_os = "android", test))]
pub(crate) mod native_debug_stages;
pub(crate) mod native_shutdown;
pub(crate) mod native_speech;
#[cfg(test)]
pub(crate) mod renderer_loss;
pub(crate) mod renderer_recovery;
pub(crate) mod requests;
pub(crate) mod startup_milestones;
pub(crate) mod vpn_status;
#[cfg(windows)]
pub(crate) mod windows_manifest_protector;
#[cfg(windows)]
pub(crate) mod windows_speech;
