use crate::lan::{self, LanManager};
use base64::Engine;
use std::{fs::File, io::Read, path::Path, sync::Arc};

fn identity_file(path: &str) -> Result<Vec<u8>, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("tls-identity-absolute-path-required".into());
    }
    for ancestor in path.ancestors() {
        let Ok(metadata) = std::fs::symlink_metadata(ancestor) else {
            continue;
        };
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("tls-identity-link-refused".into());
            }
        }
        if metadata.file_type().is_symlink() {
            return Err("tls-identity-link-refused".into());
        }
    }
    let file = File::open(path).map_err(|_| "tls-identity-unreadable".to_string())?;
    if !file
        .metadata()
        .map_err(|_| "tls-identity-unreadable")?
        .is_file()
    {
        return Err("tls-identity-file-required".into());
    }
    let mut bytes = Vec::new();
    file.take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|_| "tls-identity-unreadable")?;
    if bytes.is_empty() || bytes.len() > 65_536 {
        return Err("tls-identity-size-refused".into());
    }
    Ok(bytes)
}

fn pem(bytes: Vec<u8>, certificate: bool) -> Result<Vec<Vec<u8>>, String> {
    if !bytes.starts_with(b"-----BEGIN ") {
        return Ok(vec![bytes]);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "tls-identity-format")?;
    let mut blocks = Vec::new();
    let mut remaining = text;
    while !remaining.trim().is_empty() {
        let start = remaining
            .trim_start()
            .strip_prefix("-----BEGIN ")
            .ok_or("tls-identity-format")?;
        let (label, body) = start.split_once("-----").ok_or("tls-identity-format")?;
        if !(certificate && label == "CERTIFICATE"
            || !certificate
                && ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"].contains(&label))
        {
            return Err("tls-identity-unsupported-key-or-certificate".into());
        }
        let end = format!("-----END {label}-----");
        let (encoded, rest) = body.split_once(&end).ok_or("tls-identity-format")?;
        let encoded: String = encoded
            .chars()
            .filter(|value| !value.is_ascii_whitespace())
            .collect();
        let der = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "tls-identity-format")?;
        if der.is_empty() {
            return Err("tls-identity-format".into());
        }
        blocks.push(der);
        if blocks.len() > if certificate { 8 } else { 1 } {
            return Err("tls-identity-chain-size".into());
        }
        remaining = rest;
    }
    Ok(blocks)
}

#[tauri::command]
pub async fn start_server(
    bind_address: String,
    port: u16,
    cert_path: String,
    key_path: String,
    allow_http: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<LanManager>>,
) -> Result<lan::StartInfo, String> {
    if !cfg!(windows) {
        return Err("sharing-host-windows-only".into());
    }
    if app
        .state::<crate::NativeState>()
        .closing
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("application-closing".into());
    }
    let address = bind_address
        .parse::<std::net::IpAddr>()
        .map_err(|_| "lan-bind-address-invalid")?;
    let work = app.state::<crate::NativeState>().admit_work()?;
    let (certificate_chain, private_key) = tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        Ok::<_, String>((
            pem(identity_file(&cert_path)?, true)?,
            pem(identity_file(&key_path)?, false)?.remove(0),
        ))
    })
    .await
    .map_err(|_| "tls-identity-worker-failed")??;
    state
        .start(lan::StartConfig {
            bind: std::net::SocketAddr::new(address, port),
            certificate_chain,
            private_key,
            allow_http_upstream: allow_http,
        })
        .await
        .map_err(str::to_string)
}

#[tauri::command]
pub async fn stop_server(state: tauri::State<'_, Arc<LanManager>>) -> Result<(), String> {
    state.stop().await.map_err(str::to_string)
}
#[tauri::command]
pub async fn sharing_invite(
    app: tauri::AppHandle,
    controller: bool,
    channel_ids: Option<Vec<String>>,
    channel_labels: Option<Vec<lan::ControllerChannel>>,
    state: tauri::State<'_, Arc<LanManager>>,
) -> Result<String, String> {
    if app
        .state::<crate::NativeState>()
        .closing
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("application-closing".into());
    }
    if controller {
        state
            .invite_controller_labeled(
                channel_ids.unwrap_or_default(),
                channel_labels.unwrap_or_default(),
            )
            .await
    } else {
        state.invite().await
    }
    .map_err(str::to_string)
}
#[tauri::command]
pub async fn sharing_publish(
    app: tauri::AppHandle,
    url: String,
    generation: u64,
    state: tauri::State<'_, Arc<LanManager>>,
) -> Result<lan::Publication, String> {
    if app
        .state::<crate::NativeState>()
        .closing
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("application-closing".into());
    }
    state
        .publish_guarded(&url, generation)
        .await
        .map_err(str::to_string)
}

#[tauri::command]
pub async fn sharing_selection_changed(
    app: tauri::AppHandle,
    generation: u64,
    command_id: Option<String>,
    preserve_publication: Option<bool>,
    state: tauri::State<'_, Arc<LanManager>>,
) -> Result<lan::HostTransitionReceipt, String> {
    if preserve_publication.unwrap_or(false)
        && app
            .state::<crate::NativeState>()
            .closing
            .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("application-closing".into());
    }
    state
        .selection_changed_with_publication(
            generation,
            command_id.as_deref(),
            preserve_publication.unwrap_or(false),
        )
        .await
        .map_err(str::to_string)
}
#[tauri::command]
pub async fn sharing_viewers(
    state: tauri::State<'_, Arc<LanManager>>,
) -> Result<Vec<String>, String> {
    state.viewers().await.map_err(str::to_string)
}
#[tauri::command]
pub async fn sharing_revoke(
    viewer_id: String,
    state: tauri::State<'_, Arc<LanManager>>,
) -> Result<(), String> {
    state.revoke(&viewer_id).await.map_err(str::to_string)
}
#[tauri::command]
pub async fn next_remote_control(
    state: tauri::State<'_, Arc<LanManager>>,
) -> Result<Option<lan::ControlCommand>, String> {
    state.next_control().await.map_err(str::to_string)
}
#[tauri::command]
pub async fn remote_control_active(
    command_id: String,
    state: tauri::State<'_, Arc<LanManager>>,
) -> Result<bool, String> {
    Ok(state.control_active(&command_id).await)
}

#[tauri::command]
pub async fn remote_control_allows(
    command_id: String,
    channel_id: String,
    state: tauri::State<'_, Arc<LanManager>>,
) -> Result<bool, String> {
    Ok(state.control_allows(&command_id, &channel_id).await)
}

#[tauri::command]
pub async fn sharing_control_allows(
    command_id: String,
    channel_id: String,
    state: tauri::State<'_, Arc<LanManager>>,
) -> Result<bool, String> {
    Ok(state.control_allows(&command_id, &channel_id).await)
}
#[tauri::command]
pub async fn acknowledge_remote_control(
    command_id: String,
    applied: bool,
    state: tauri::State<'_, Arc<LanManager>>,
) -> Result<bool, String> {
    state
        .acknowledge_control(&command_id, applied)
        .await
        .map_err(str::to_string)
}

use tauri::Manager;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_parser_bounds_types_chains_and_refuses_unrequested_paths() {
        assert!(identity_file("relative.key").is_err());
        assert_eq!(
            pem(
                b"-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n".to_vec(),
                true
            )
            .unwrap(),
            vec![vec![1, 2, 3]]
        );
        assert!(pem(
            b"-----BEGIN ENCRYPTED PRIVATE KEY-----\nAQID\n-----END ENCRYPTED PRIVATE KEY-----"
                .to_vec(),
            false
        )
        .is_err());
        assert!(pem(
            b"-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----".to_vec(),
            true
        )
        .is_err());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oversize");
        std::fs::write(&path, vec![0u8; 65_537]).unwrap();
        assert!(identity_file(path.to_str().unwrap()).is_err());
    }
}
