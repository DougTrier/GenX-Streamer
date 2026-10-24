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

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::net::IpAddr;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiverNetworkScope {
    pub generation: u64,
    pub scope_id: String,
    pub observation: String,
}
#[derive(Default)]
pub(super) struct NetworkTracker {
    fingerprint: Option<String>,
    scope: Option<ReceiverNetworkScope>,
}
impl NetworkTracker {
    pub(super) fn invalidate(&mut self) {
        self.fingerprint = None;
    }
    pub(super) fn observe(
        &mut self,
        fingerprint: String,
        routes: bool,
    ) -> Result<ReceiverNetworkScope, &'static str> {
        if self.fingerprint.as_ref() != Some(&fingerprint) {
            let generation = self.scope.as_ref().map_or(Ok(0), |v| {
                v.generation
                    .checked_add(1)
                    .ok_or("cast-network-generation-limit")
            })?;
            self.scope = Some(ReceiverNetworkScope {
                generation,
                scope_id: super::token()?,
                observation: if routes {
                    "interfaces-and-routes"
                } else {
                    "interfaces-only"
                }
                .into(),
            });
            self.fingerprint = Some(fingerprint);
        }
        self.scope.clone().ok_or("cast-network-unavailable")
    }
}
pub(super) fn snapshot() -> Result<(String, bool), &'static str> {
    let mut interfaces = Vec::new();
    for interface in if_addrs::get_if_addrs().map_err(|_| "cast-network-interfaces-unavailable")? {
        if super::private_address(interface.ip()) {
            if interface.name.len() > 256 || interfaces.len() >= 32 {
                return Err("cast-network-interface-limit");
            }
            interfaces.push(format!("{}:{:?}", interface.name, interface.addr));
        }
    }
    if interfaces.is_empty() {
        return Err("cast-network-no-lan-interface");
    }
    let routes = routes();
    Ok((fingerprint(interfaces, routes.as_ref()), routes.is_some()))
}
fn fingerprint(mut interfaces: Vec<String>, routes: Option<&Vec<String>>) -> String {
    interfaces.sort();
    interfaces.dedup();
    let mut routes = routes.cloned();
    if let Some(rows) = routes.as_mut() {
        rows.sort();
        rows.dedup();
    }
    let data = serde_json::to_vec(&(interfaces, routes)).expect("bounded string records serialize");
    format!("{:x}", Sha256::digest(data))
}
#[cfg(windows)]
fn routes() -> Option<Vec<String>> {
    use windows_sys::Win32::{
        NetworkManagement::IpHelper::{FreeMibTable, GetIpForwardTable2, MIB_IPFORWARD_TABLE2},
        Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR_INET},
    };
    unsafe fn address(v: SOCKADDR_INET) -> Option<String> {
        match unsafe { v.si_family } {
            AF_INET => Some(
                IpAddr::V4(std::net::Ipv4Addr::from(
                    unsafe { v.Ipv4.sin_addr.S_un.S_addr }.to_ne_bytes(),
                ))
                .to_string(),
            ),
            AF_INET6 => Some(
                IpAddr::V6(std::net::Ipv6Addr::from(unsafe { v.Ipv6.sin6_addr.u.Byte }))
                    .to_string(),
            ),
            _ => None,
        }
    }
    let mut table: *mut MIB_IPFORWARD_TABLE2 = std::ptr::null_mut();
    // OS-owned route memory is copied under a strict row limit and always freed; no network probe or subprocess.
    unsafe {
        if GetIpForwardTable2(AF_UNSPEC, &mut table) != 0 || table.is_null() {
            return None;
        }
        let count = (*table).NumEntries as usize;
        if count > 4096 {
            FreeMibTable(table.cast());
            return None;
        }
        let entries = std::slice::from_raw_parts((*table).Table.as_ptr(), count);
        let mut result = Vec::new();
        for row in entries {
            if let (Some(destination), Some(hop)) =
                (address(row.DestinationPrefix.Prefix), address(row.NextHop))
            {
                result.push(format!(
                    "{}:{}/{}:{}:{}:{}",
                    row.InterfaceIndex,
                    destination,
                    row.DestinationPrefix.PrefixLength,
                    hop,
                    row.Metric,
                    row.Protocol
                ));
            }
        }
        FreeMibTable(table.cast());
        Some(result)
    }
}
#[cfg(any(target_os = "linux", target_os = "android"))]
fn routes() -> Option<Vec<String>> {
    use std::io::Read;
    let mut rows = Vec::new();
    for path in ["/proc/net/route", "/proc/net/ipv6_route"] {
        let mut text = String::new();
        let mut file = std::fs::File::open(path).ok()?.take(262_145);
        file.read_to_string(&mut text).ok()?;
        if text.len() > 262_144 {
            return None;
        }
        for line in text
            .lines()
            .skip(if path.ends_with("/route") { 1 } else { 0 })
        {
            let fields: Vec<_> = line.split_whitespace().collect();
            // IPv4 refcount/use and IPv6 counters change with traffic and are not topology identity.
            let stable = if path.ends_with("/route") {
                if fields.len() < 11 {
                    return None;
                }
                vec![
                    fields[0], fields[1], fields[2], fields[3], fields[6], fields[7],
                ]
            } else {
                if fields.len() < 10 {
                    return None;
                }
                vec![
                    fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[8],
                    fields[9],
                ]
            };
            rows.push(stable.join(":"));
            if rows.len() > 4096 {
                return None;
            }
        }
    }
    Some(rows)
}
#[cfg(not(any(windows, target_os = "linux", target_os = "android")))]
fn routes() -> Option<Vec<String>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_observed_unavailable_network_cannot_revive_an_old_grant_epoch() {
        let mut tracker = NetworkTracker::default();
        let before = tracker.observe("same".into(), true).unwrap();
        tracker.invalidate();
        let after = tracker.observe("same".into(), true).unwrap();
        assert_ne!(before.scope_id, after.scope_id);
        assert_eq!(after.generation, before.generation + 1);
    }
    #[test]
    fn topology_order_is_stable_but_route_or_interface_changes_invalidate_epoch_without_identity_leaks(
    ) {
        let mut tracker = NetworkTracker::default();
        let first = tracker
            .observe(
                fingerprint(
                    vec!["wifi:192.168.1.2".into(), "vpn:10.0.0.2".into()],
                    Some(&vec!["route-a".into()]),
                ),
                true,
            )
            .unwrap();
        let same = tracker
            .observe(
                fingerprint(
                    vec!["vpn:10.0.0.2".into(), "wifi:192.168.1.2".into()],
                    Some(&vec!["route-a".into()]),
                ),
                true,
            )
            .unwrap();
        assert_eq!(first, same);
        let changed = tracker
            .observe(
                fingerprint(
                    vec!["wifi:192.168.1.2".into(), "vpn:10.0.0.2".into()],
                    Some(&vec!["route-b".into()]),
                ),
                true,
            )
            .unwrap();
        assert_eq!(changed.generation, first.generation + 1);
        assert_ne!(changed.scope_id, first.scope_id);
        let limited = tracker
            .observe(fingerprint(vec!["wifi:192.168.1.2".into()], None), false)
            .unwrap();
        assert_eq!(limited.observation, "interfaces-only");
        let serialized = serde_json::to_string(&limited).unwrap();
        assert!(
            !serialized.contains("wifi")
                && !serialized.contains("192.168")
                && !serialized.contains("route")
        );
    }
}
