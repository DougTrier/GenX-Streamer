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

//! Native device identity capability; display dimensions are never an admission signal.
use crate::NativeState;
use serde::{Deserialize, Serialize};
use tauri::Manager;
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeviceCapabilities {
    pub is_television: bool,
}
impl DeviceCapabilities {
    pub fn allow_cast_entry(&self) -> Result<(), String> {
        if self.is_television {
            Err("casting-unavailable-on-television".into())
        } else {
            Ok(())
        }
    }
}
#[tauri::command]
pub(crate) async fn device_capabilities(
    app: tauri::AppHandle,
) -> Result<DeviceCapabilities, String> {
    let state = app.state::<NativeState>();
    let _work = state.admit_work()?;
    #[cfg(target_os = "android")]
    {
        let work = state.admit_work()?;
        let closing = state.closing.clone();
        crate::viewing_wake::spawn_owned(work, closing, true, async move {
            app.state::<crate::AndroidViewing>()
                .0
                .run_mobile_plugin_async::<DeviceCapabilities>(
                    "deviceCapabilities",
                    serde_json::json!({}),
                )
                .await
                .map_err(|_| "device-capabilities-unavailable".into())
        })
        .await
        .map_err(|_| "device-capabilities-unavailable".to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(DeviceCapabilities {
            is_television: false,
        })
    }
}
pub(crate) async fn require_cast_entry(app: &tauri::AppHandle) -> Result<(), String> {
    device_capabilities(app.clone()).await?.allow_cast_entry()?;
    if app
        .state::<NativeState>()
        .closing
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("application-closing".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tv_refusal_precedes_network_entry_and_non_tv_remains_available() {
        for is_television in [true, false] {
            let capabilities = DeviceCapabilities { is_television };
            let mut network_actions = 0;
            let result = capabilities.allow_cast_entry().map(|_| {
                network_actions += 1;
            });
            assert_eq!(network_actions, usize::from(!is_television));
            if is_television {
                assert_eq!(result.unwrap_err(), "casting-unavailable-on-television");
            } else {
                assert!(result.is_ok());
            }
        }
    }
    #[test]
    fn missing_malformed_or_extra_fields_do_not_default_to_non_tv() {
        for value in [
            "{}",
            r#"{"isTelevision":null}"#,
            r#"{"isTelevision":"false"}"#,
            r#"{"isTelevision":false,"width":1920}"#,
        ] {
            assert!(serde_json::from_str::<DeviceCapabilities>(value).is_err());
        }
        assert!(
            serde_json::from_str::<DeviceCapabilities>(r#"{"isTelevision":true}"#)
                .unwrap()
                .is_television
        );
    }
}
