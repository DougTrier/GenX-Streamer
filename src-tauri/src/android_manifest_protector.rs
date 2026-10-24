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

//! Native-only Android candidate-page protection; callers retain their WorkGuard
//! and join this actual mobile invocation before cancellation/close acknowledgement.
#[cfg(any(target_os = "android", test))]
use base64::{engine::general_purpose::STANDARD, Engine};
#[cfg(any(target_os = "android", test))]
use serde::Deserialize;
#[cfg(target_os = "android")]
use tauri::Manager;

pub const MAX_PLAINTEXT: usize = 1024 * 1024;
pub const MAX_BINDING: usize = 128 * 1024;
/// Version 1 pages carry 33 bytes of header and tag; version 2 (written now,
/// a Keystore-wrapped page key) carries 93 (ScanManifestCipher.kt).
pub const MAX_CIPHERTEXT: usize = MAX_PLAINTEXT + 93;
#[cfg(target_os = "android")]
pub(crate) async fn vault_directory(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Directory {
        schema_version: u8,
        path: Option<String>,
        code: Option<String>,
    }
    let response = app
        .state::<AndroidManifestProtector>()
        .0
        .run_mobile_plugin_async::<serde_json::Value>("getNoBackupDirectory", serde_json::json!({}))
        .await
        .map_err(|_| "account-vault-path-unavailable")?;
    let result: Directory =
        serde_json::from_value(response).map_err(|_| "account-vault-path-unavailable")?;
    let path = result
        .path
        .filter(|p| !p.is_empty() && p.len() <= 16384 && !p.chars().any(char::is_control))
        .ok_or("account-vault-path-unavailable")?;
    let path = std::path::PathBuf::from(path);
    if result.schema_version != 1 || result.code.is_some() || !path.is_absolute() {
        return Err("account-vault-path-unavailable".into());
    }
    Ok(path.join("genx-accounts"))
}

fn validate_envelope(value: &[u8]) -> Result<(), String> {
    let minimum = match value.get(..5) {
        Some(b"GXMP\x01") => 33,
        Some(b"GXMP\x02") => 93,
        _ => return Err("manifest-protection-invalid".into()),
    };
    if value.len() < minimum || value.len() > MAX_CIPHERTEXT {
        return Err("manifest-protection-invalid".into());
    }
    Ok(())
}

#[cfg(target_os = "android")]
struct AndroidManifestProtector(tauri::plugin::PluginHandle<tauri::Wry>);

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry, ()>::new("scan-manifest-protector")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            app.manage(AndroidManifestProtector(api.register_android_plugin(
                "com.tmg.tv",
                "ScanManifestProtectorPlugin",
            )?));
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(any(target_os = "android", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    schema_version: u8,
    payload: Option<String>,
    code: Option<String>,
}

#[cfg(any(target_os = "android", test))]
fn validate_reply(value: serde_json::Value, limit: usize) -> Result<Vec<u8>, String> {
    let reply: Reply =
        serde_json::from_value(value).map_err(|_| "manifest-protection-platform-failed")?;
    if reply.schema_version != 1 {
        return Err("manifest-protection-platform-failed".into());
    }
    match (reply.payload, reply.code) {
        (None, Some(code)) => {
            if matches!(
                code.as_str(),
                "manifest-protection-invalid"
                    | "manifest-protection-key-unavailable"
                    | "manifest-protection-authentication-failed"
                    | "manifest-protection-platform-failed"
                    | "manifest-protection-busy"
            ) {
                Err(code)
            } else {
                Err("manifest-protection-platform-failed".into())
            }
        }
        (Some(payload), None) => {
            if payload.len() > limit.div_ceil(3) * 4 {
                return Err("manifest-protection-platform-failed".into());
            }
            let decoded = STANDARD
                .decode(&payload)
                .map_err(|_| "manifest-protection-platform-failed")?;
            if decoded.len() > limit || STANDARD.encode(&decoded) != payload {
                return Err("manifest-protection-platform-failed".into());
            }
            Ok(decoded)
        }
        _ => Err("manifest-protection-platform-failed".into()),
    }
}

async fn call(
    app: &tauri::AppHandle,
    binding: &str,
    input: &[u8],
    sealing: bool,
) -> Result<Vec<u8>, String> {
    let input_limit = if sealing {
        MAX_PLAINTEXT
    } else {
        MAX_CIPHERTEXT
    };
    if binding.is_empty() || binding.len() > MAX_BINDING || input.len() > input_limit {
        return Err("manifest-protection-invalid".into());
    }
    if !sealing {
        validate_envelope(input)?;
    }
    #[cfg(target_os = "android")]
    {
        let owner = app
            .try_state::<AndroidManifestProtector>()
            .ok_or("manifest-protection-platform-failed")?;
        let value = owner
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                if sealing {
                    "sealManifestPage"
                } else {
                    "openManifestPage"
                },
                if sealing {
                    serde_json::json!({"binding": binding, "plaintext": STANDARD.encode(input)})
                } else {
                    serde_json::json!({"binding": binding, "ciphertext": STANDARD.encode(input)})
                },
            )
            .await
            .map_err(|_| "manifest-protection-platform-failed")?;
        let result = validate_reply(
            value,
            if sealing {
                MAX_CIPHERTEXT
            } else {
                MAX_PLAINTEXT
            },
        )?;
        if sealing {
            validate_envelope(&result).map_err(|_| "manifest-protection-platform-failed")?;
        }
        Ok(result)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("manifest-protection-unavailable".into())
    }
}

pub async fn seal(
    app: &tauri::AppHandle,
    binding: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    call(app, binding, plaintext, true).await
}

pub async fn open(
    app: &tauri::AppHandle,
    binding: &str,
    ciphertext: &[u8],
) -> Result<Vec<u8>, String> {
    call(app, binding, ciphertext, false).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelope_bound_and_version_precede_mobile_dispatch() {
        let mut valid = vec![0; MAX_CIPHERTEXT];
        valid[..5].copy_from_slice(b"GXMP\x01");
        assert!(validate_envelope(&valid).is_ok());
        valid.push(0);
        assert!(validate_envelope(&valid).is_err());
        // Version 2 (wrapped page key) needs its 93-byte header and tag.
        valid.truncate(93);
        valid[4] = 2;
        assert!(validate_envelope(&valid).is_ok());
        valid.truncate(92);
        assert!(validate_envelope(&valid).is_err());
        valid.truncate(33);
        valid[4] = 1;
        assert!(validate_envelope(&valid).is_ok());
        valid[4] = 3;
        assert!(validate_envelope(&valid).is_err());
        assert!(validate_envelope(&[0; 32]).is_err());
    }

    #[test]
    fn canonical_bounded_reply_only_and_no_unknown_error_text() {
        assert_eq!(
            validate_reply(json!({"schemaVersion":1,"payload":"AAE="}), 2),
            Ok(vec![0, 1])
        );
        for value in [
            json!({"schemaVersion":1,"payload":"AAE"}),
            json!({"schemaVersion":1,"payload":"AAE=\n"}),
            json!({"schemaVersion":2,"payload":"AAE="}),
            json!({"schemaVersion":1,"payload":"AAE=","code":"manifest-protection-busy"}),
            json!({"schemaVersion":1,"code":"https://secret.invalid"}),
            json!({"schemaVersion":1,"payload":"AAE=","extra":true}),
        ] {
            assert_eq!(
                validate_reply(value, 2).unwrap_err(),
                "manifest-protection-platform-failed"
            );
        }
        assert!(validate_reply(json!({"schemaVersion":1,"payload":"AAE="}), 1).is_err());
        assert_eq!(
            validate_reply(
                json!({"schemaVersion":1,"code":"manifest-protection-key-unavailable"}),
                2
            )
            .unwrap_err(),
            "manifest-protection-key-unavailable"
        );
    }
}
