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

//! Whether a VPN connection is up on this device, for the header's VPN shield
//! (docs/vpn-indicator.md). GenX only looks: it never starts, stops or
//! configures a VPN, and the answer is shown to the viewer, never logged.

#[cfg(target_os = "android")]
struct VpnStatusPlugin(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry, ()>::new("vpn-status")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                app.manage(VpnStatusPlugin(
                    api.register_android_plugin("com.tmg.tv", "VpnStatusPlugin")?,
                ));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VpnStatus {
    connected: bool,
    /// The connection's adapter name where the system tells (Windows only).
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

/// Adapter names that belong to VPN clients (WireGuard/NordLynx, OpenVPN TAP,
/// Wintun-based clients and the big consumer VPNs).
const VPN_NAMES: [&str; 11] = [
    "nordlynx",
    "wireguard",
    "wintun",
    "tap-windows",
    "tap-nordvpn",
    "openvpn",
    "vpn",
    "proton",
    "expressvpn",
    "surfshark",
    "mullvad",
];
/// System tunnels that are always up and are not VPNs.
const NOT_VPN: [&str; 5] = ["teredo", "isatap", "6to4", "ip-https", "loopback"];
const IF_TYPE_PPP: u32 = 23;
const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;

/// One network adapter as Windows reports it: is it a VPN that is connected?
/// Windows' own VPN connections (IKEv2, L2TP, PPTP, SSTP) are PPP adapters;
/// third-party clients are recognised by their adapter name. An adapter that
/// is down or has no address is not connected.
pub(crate) fn connected_vpn(
    if_type: u32,
    up: bool,
    has_address: bool,
    description: &str,
    friendly: &str,
) -> bool {
    if !up || !has_address || if_type == IF_TYPE_SOFTWARE_LOOPBACK {
        return false;
    }
    let names = format!("{description} {friendly}").to_lowercase();
    if NOT_VPN.iter().any(|word| names.contains(word)) {
        return false;
    }
    if_type == IF_TYPE_PPP || VPN_NAMES.iter().any(|word| names.contains(word))
}

/// A display name: printable, at most 64 characters.
fn display_name(raw: &str) -> Option<String> {
    let clean: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect::<String>()
        .trim()
        .to_string();
    (!clean.is_empty()).then_some(clean)
}

#[cfg(windows)]
fn windows_status() -> Result<VpnStatus, String> {
    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_SUCCESS};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::AF_UNSPEC;

    fn wide(text: *const u16) -> String {
        if text.is_null() {
            return String::new();
        }
        // SAFETY: Windows returns NUL-terminated UTF-16 strings owned by the
        // adapter buffer, which outlives this read; the walk is bounded.
        unsafe {
            let mut len = 0;
            while len < 512 && *text.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(text, len))
        }
    }
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size: u32 = 16 * 1024;
    let mut buffer: Vec<u64> = Vec::new();
    for _ in 0..4 {
        buffer = vec![0u64; (size as usize).div_ceil(8)];
        // SAFETY: the buffer is `size` bytes, 8-byte aligned, and lives across the call.
        let result = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC as u32,
                flags,
                std::ptr::null(),
                buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
                &mut size,
            )
        };
        if result == ERROR_SUCCESS {
            let mut adapter = buffer.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
            let mut seen = 0;
            while !adapter.is_null() && seen < 256 {
                seen += 1;
                // SAFETY: a node of the list Windows just wrote into `buffer`.
                let row = unsafe { &*adapter };
                let description = wide(row.Description);
                let friendly = wide(row.FriendlyName);
                if connected_vpn(
                    row.IfType,
                    row.OperStatus == IfOperStatusUp,
                    !row.FirstUnicastAddress.is_null(),
                    &description,
                    &friendly,
                ) {
                    return Ok(VpnStatus {
                        connected: true,
                        name: display_name(&description).or_else(|| display_name(&friendly)),
                    });
                }
                adapter = row.Next;
            }
            return Ok(VpnStatus {
                connected: false,
                name: None,
            });
        }
        if result != ERROR_BUFFER_OVERFLOW {
            break;
        }
    }
    drop(buffer);
    Err("vpn-status-failed".into())
}

#[tauri::command]
pub(crate) async fn vpn_status(app: tauri::AppHandle) -> Result<VpnStatus, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Reply {
            connected: bool,
        }
        let plugin = app
            .try_state::<VpnStatusPlugin>()
            .ok_or("vpn-status-unavailable")?;
        let reply = plugin
            .0
            .run_mobile_plugin_async::<Reply>("status", serde_json::json!({}))
            .await
            .map_err(|_| "vpn-status-failed".to_string())?;
        return Ok(VpnStatus {
            connected: reply.connected,
            name: None,
        });
    }
    #[cfg(windows)]
    {
        let _ = app;
        return tauri::async_runtime::spawn_blocking(windows_status)
            .await
            .map_err(|_| "vpn-status-failed".to_string())?;
    }
    #[allow(unreachable_code)]
    {
        let _ = app;
        Err("vpn-status-unavailable".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_connected_vpn_adapters_only() {
        // NordVPN (NordLynx and OpenVPN TAP), WireGuard, Windows' own VPN (PPP).
        assert!(connected_vpn(53, true, true, "NordLynx Tunnel", "NordLynx"));
        assert!(connected_vpn(
            6,
            true,
            true,
            "TAP-NordVPN Windows Adapter V9",
            "Ethernet 3"
        ));
        assert!(connected_vpn(53, true, true, "WireGuard Tunnel", "wg0"));
        assert!(connected_vpn(
            23,
            true,
            true,
            "WAN Miniport (IKEv2)",
            "Office"
        ));
        // Down, or up without an address: not connected.
        assert!(!connected_vpn(
            53,
            false,
            true,
            "NordLynx Tunnel",
            "NordLynx"
        ));
        assert!(!connected_vpn(
            53,
            true,
            false,
            "NordLynx Tunnel",
            "NordLynx"
        ));
        // Ordinary adapters and always-on system tunnels are not VPNs.
        assert!(!connected_vpn(
            71,
            true,
            true,
            "Intel(R) Wi-Fi 6E AX211",
            "Wi-Fi"
        ));
        assert!(!connected_vpn(
            6,
            true,
            true,
            "Realtek PCIe GbE",
            "Ethernet"
        ));
        assert!(!connected_vpn(
            6,
            true,
            true,
            "Hyper-V Virtual Ethernet Adapter",
            "vEthernet (WSL)"
        ));
        assert!(!connected_vpn(
            131,
            true,
            true,
            "Teredo Tunneling Pseudo-Interface",
            "Teredo"
        ));
        assert!(!connected_vpn(
            24,
            true,
            true,
            "Software Loopback Interface 1",
            "Loopback"
        ));
    }

    #[test]
    fn display_names_are_printable_and_bounded() {
        assert_eq!(display_name(" NordLynx\u{7}\n "), Some("NordLynx".into()));
        assert_eq!(display_name(&"x".repeat(200)).unwrap().len(), 64);
        assert_eq!(display_name("\u{0}\u{1}"), None);
    }

    #[test]
    fn reply_names_only_what_is_known() {
        let off = serde_json::to_value(VpnStatus {
            connected: false,
            name: None,
        })
        .unwrap();
        assert_eq!(off, serde_json::json!({ "connected": false }));
    }

    #[cfg(windows)]
    #[test]
    fn reads_this_computers_adapters() {
        // A real read of this machine's adapters: it must answer, either way.
        assert!(windows_status().is_ok());
    }
}
