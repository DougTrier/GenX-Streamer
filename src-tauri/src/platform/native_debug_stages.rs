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

//! Fixed debug-build labels only: no request identifiers, arguments, errors or media data.
use std::ffi::CStr;
#[derive(Clone, Copy)]
pub(crate) enum Stage {
    WakeAdmitted,
    WakePluginDispatchEnter,
    WakePluginResult,
    WakeValidated,
    WakeReturn,
    SpeechShutdownEnter,
    SpeechShutdownSettled,
}
impl Stage {
    fn message(self) -> &'static CStr {
        match self {
            Self::WakeAdmitted => c"wake-admitted",
            Self::WakePluginDispatchEnter => c"wake-plugin-dispatch-enter",
            Self::WakePluginResult => c"wake-plugin-result",
            Self::WakeValidated => c"wake-validated",
            Self::WakeReturn => c"wake-return",
            Self::SpeechShutdownEnter => c"speech-shutdown-enter",
            Self::SpeechShutdownSettled => c"speech-shutdown-settled",
        }
    }
}
pub(crate) fn record(stage: Stage) {
    // Calling this remains a no-op in release builds. The API accepts no dynamic strings.
    let message = stage.message();
    #[cfg(all(target_os = "android", debug_assertions))]
    unsafe {
        #[link(name = "log")]
        extern "C" {
            fn __android_log_write(
                priority: i32,
                tag: *const std::ffi::c_char,
                message: *const std::ffi::c_char,
            ) -> i32;
        }
        let _ = __android_log_write(4, c"GenXWake".as_ptr(), message.as_ptr());
    }
    #[cfg(not(all(target_os = "android", debug_assertions)))]
    let _ = message;
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn debug_stage_schema_is_fixed_unique_and_payload_free() {
        let stages = [
            Stage::WakeAdmitted,
            Stage::WakePluginDispatchEnter,
            Stage::WakePluginResult,
            Stage::WakeValidated,
            Stage::WakeReturn,
            Stage::SpeechShutdownEnter,
            Stage::SpeechShutdownSettled,
        ];
        let mut seen = std::collections::HashSet::new();
        for stage in stages {
            let label = stage.message().to_bytes();
            assert!(label.len() <= 32);
            assert!(label.iter().all(|b| b.is_ascii_lowercase() || *b == b'-'));
            assert!(seen.insert(label));
            record(stage); // Host builds have no platform side effect.
        }
    }
}
