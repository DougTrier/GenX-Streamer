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

//! Independent protocol fixture harness; does not stand in for the Tauri platform build.
#[path = "../mod.rs"]
#[allow(
    unused_imports,
    reason = "casting re-exports ReceiverRelay for the Android native player, which this harness does not build"
)]
pub mod casting;
#[path = "../../relay.rs"]
pub mod relay;
#[path = "../../relay_clients.rs"]
mod relay_clients;
#[path = "../../sharing_policy.rs"]
pub mod sharing_policy;
// Modules from other components that the casting code uses.
#[cfg(test)]
#[path = "../../../platform/close_owner.rs"]
pub mod close_owner;
#[path = "../../../playback/ts_align.rs"]
pub mod ts_align;
// Playback reports belong to the app's platform build. Keep their side-channel
// hooks inert here while exercising the real relay, pool and protocol modules.
mod platform {
    pub(crate) mod playback_trace {
        pub(crate) fn native_failure(
            _mode: &str,
            _code: &str,
            _timeout: bool,
            _body_error: bool,
            _response_started: bool,
        ) {
        }
        pub(crate) fn native_hls_delivery(_bytes: usize, _elapsed_ms: f64, _status: u16) {}
    }
}
