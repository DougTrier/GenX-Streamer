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

//! Pure policy for the future TLS listener. No sockets, keys, timers or logging here.
//! The transport must supply cryptographically random IDs and validate DNS/redirects.
use std::{
    collections::{HashMap, HashSet},
    net::IpAddr,
};

const LEASE_MS: u64 = 30_000;
const MAX_VIEWERS: usize = 8;
const MAX_RESOURCES: usize = 4096;

#[derive(Clone, Debug, PartialEq)]
pub struct ChannelRevision {
    pub revision: u64,
    pub media_id: String,
}

struct Viewer {
    expires: u64,
    paused: bool,
}
struct Resource {
    revision: u64,
    target: String,
}

pub struct SharingPolicy {
    running: bool,
    pairing_secret: String,
    pairing_expires: u64,
    pairing_attempts: u8,
    viewers: HashMap<String, Viewer>,
    resources: HashMap<String, Resource>,
    channel: Option<ChannelRevision>,
    next_revision: u64,
}

fn opaque(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn equal_secret(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

impl SharingPolicy {
    pub fn start(pairing_secret: String, now: u64) -> Result<Self, &'static str> {
        if !opaque(&pairing_secret) {
            return Err("invalid-server-secret");
        }
        Ok(Self {
            running: true,
            pairing_secret,
            pairing_expires: now.saturating_add(120_000),
            pairing_attempts: 0,
            viewers: HashMap::new(),
            resources: HashMap::new(),
            channel: None,
            next_revision: 1,
        })
    }

    pub fn pair(&mut self, secret: &str, token: String, now: u64) -> Result<(), &'static str> {
        self.expire(now);
        if !self.running || now >= self.pairing_expires || self.pairing_attempts >= 5 {
            return Err("pairing-expired-or-locked");
        }
        self.pairing_attempts += 1;
        if !equal_secret(secret, &self.pairing_secret) {
            return Err("pairing-refused");
        }
        if self.viewers.len() >= MAX_VIEWERS {
            return Err("viewer-limit");
        }
        if !opaque(&token) || self.viewers.contains_key(&token) {
            return Err("invalid-server-token");
        }
        self.viewers.insert(
            token,
            Viewer {
                expires: now.saturating_add(LEASE_MS),
                paused: false,
            },
        );
        // One-time pairing: host explicitly creates a new invite for another client.
        self.pairing_expires = now;
        self.pairing_secret.clear();
        Ok(())
    }

    pub fn invite(&mut self, secret: String, now: u64) -> Result<(), &'static str> {
        if !self.running || !opaque(&secret) {
            return Err("invite-refused");
        }
        self.pairing_secret = secret;
        self.pairing_expires = now.saturating_add(120_000);
        self.pairing_attempts = 0;
        Ok(())
    }

    pub fn heartbeat(
        &mut self,
        token: &str,
        paused: bool,
        now: u64,
    ) -> Result<Option<ChannelRevision>, &'static str> {
        self.expire(now);
        let viewer = self.viewers.get_mut(token).ok_or("viewer-unauthorized")?;
        viewer.expires = now.saturating_add(LEASE_MS);
        viewer.paused = paused;
        Ok(self.channel.clone())
    }

    pub fn publish(&mut self, media_id: String) -> Result<ChannelRevision, &'static str> {
        if !self.running || !opaque(&media_id) {
            return Err("publication-refused");
        }
        let revision = self.next_revision;
        self.next_revision = self
            .next_revision
            .checked_add(1)
            .ok_or("revision-exhausted")?;
        let channel = ChannelRevision { revision, media_id };
        self.resources.clear();
        self.channel = Some(channel.clone());
        Ok(channel)
    }
    pub fn invalidate_publication(&mut self) {
        self.channel = None;
        self.resources.clear();
    }

    pub fn admit_resource(
        &mut self,
        revision: u64,
        resource_id: String,
        validated_target: String,
    ) -> Result<(), &'static str> {
        if self.channel.as_ref().map(|channel| channel.revision) != Some(revision) {
            return Err("obsolete-revision");
        }
        if !opaque(&resource_id) || self.resources.contains_key(&resource_id) {
            return Err("invalid-resource-id");
        }
        if self.resources.len() >= MAX_RESOURCES {
            return Err("resource-limit");
        }
        self.resources.insert(
            resource_id,
            Resource {
                revision,
                target: validated_target,
            },
        );
        Ok(())
    }

    /// Admit a fully staged rewrite atomically. Targets are already validated by the transport;
    /// this policy never fetches, logs or resolves them. Failure consumes no resource IDs.
    pub fn admit_resources(
        &mut self,
        revision: u64,
        resources: Vec<(String, String)>,
    ) -> Result<(), &'static str> {
        if self.channel.as_ref().map(|channel| channel.revision) != Some(revision) {
            return Err("obsolete-revision");
        }
        let mut ids = HashSet::new();
        for (id, _) in &resources {
            if !opaque(id) || self.resources.contains_key(id) || !ids.insert(id.as_str()) {
                return Err("invalid-resource-id");
            }
        }
        if resources.len() > MAX_RESOURCES.saturating_sub(self.resources.len()) {
            return Err("resource-limit");
        }
        drop(ids);
        // All fallible policy admission checks precede the first mutation.
        for (id, target) in resources {
            self.resources.insert(id, Resource { revision, target });
        }
        Ok(())
    }

    pub fn resource(
        &mut self,
        token: &str,
        revision: u64,
        id: &str,
        now: u64,
    ) -> Result<String, &'static str> {
        self.expire(now);
        let viewer = self.viewers.get(token).ok_or("viewer-unauthorized")?;
        if viewer.paused {
            return Err("viewer-paused");
        }
        let resource = self.resources.get(id).ok_or("resource-not-admitted")?;
        if resource.revision != revision {
            return Err("obsolete-revision");
        }
        // Return an owned URL so a caller never keeps the registry locked over I/O.
        Ok(resource.target.clone())
    }

    pub fn revoke(&mut self, token: &str) {
        self.viewers.remove(token);
    }
    pub fn expire(&mut self, now: u64) {
        self.viewers.retain(|_, viewer| viewer.expires > now);
    }
    pub fn active_consumers(&mut self, now: u64) -> usize {
        self.expire(now);
        self.viewers
            .values()
            .filter(|viewer| !viewer.paused)
            .count()
    }
    pub fn stop(&mut self) {
        self.running = false;
        self.viewers.clear();
        self.resources.clear();
        self.channel = None;
        self.pairing_secret.clear();
    }
}

pub fn public_upstream(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_unspecified()
                || ip.is_multicast()
                || a == 0
                || a >= 240
                || (a == 192 && b == 0)
                || (a == 100 && (64..=127).contains(&b))
                || (a == 198 && (b == 18 || b == 19))
                || ip.is_documentation())
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_upstream(IpAddr::V4(v4));
            }
            let first = ip.segments()[0];
            !ip.is_loopback()
                && !ip.is_unspecified()
                && first & 0xe000 == 0x2000
                && first != 0x2002
                && first != 0x3ffe
                && first != 0x3fff
                && !(first == 0x2001 && (ip.segments()[1] < 0x0200 || ip.segments()[1] == 0x0db8))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id(value: char) -> String {
        value.to_string().repeat(64)
    }
    #[test]
    fn pairing_is_one_time_rate_bounded_and_revocable() {
        let mut policy = SharingPolicy::start(id('a'), 0).unwrap();
        for _ in 0..5 {
            assert!(policy.pair("wrong", id('b'), 1).is_err());
        }
        assert!(policy.pair(&id('a'), id('b'), 1).is_err());
        policy.invite(id('c'), 2).unwrap();
        policy.pair(&id('c'), id('b'), 3).unwrap();
        assert!(policy.pair(&id('c'), id('d'), 3).is_err());
        assert!(policy.heartbeat(&id('b'), false, 4).is_ok());
        policy.revoke(&id('b'));
        assert!(policy.heartbeat(&id('b'), false, 5).is_err());
    }
    #[test]
    fn revision_lease_pause_and_shutdown_are_independent() {
        let mut policy = SharingPolicy::start(id('a'), 0).unwrap();
        policy.pair(&id('a'), id('b'), 0).unwrap();
        let channel = policy.publish(id('c')).unwrap();
        policy
            .admit_resource(
                channel.revision,
                id('d'),
                "https://admitted.test/secret".into(),
            )
            .unwrap();
        assert!(policy.resource(&id('b'), 1, &id('d'), 1).is_ok());
        assert_eq!(
            policy
                .heartbeat(&id('b'), true, 2)
                .unwrap()
                .unwrap()
                .revision,
            1
        );
        assert_eq!(policy.active_consumers(3), 0);
        assert!(policy.resource(&id('b'), 1, &id('d'), 3).is_err());
        policy.heartbeat(&id('b'), false, 3).unwrap();
        assert_eq!(policy.active_consumers(4), 1);
        assert_eq!(policy.publish(id('e')).unwrap().revision, 2);
        assert!(policy.resource(&id('b'), 1, &id('d'), 4).is_err());
        assert!(policy
            .admit_resource(1, id('f'), "obsolete".into())
            .is_err());
        assert_eq!(policy.active_consumers(30_003), 0);
        policy.stop();
        assert!(policy.publish(id('c')).is_err());
        assert!(policy.invite(id('a'), 40_000).is_err());
    }
    #[test]
    fn upstream_policy_rejects_internal_ipv4_and_mapped_ipv6() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "198.18.0.1",
            "0.1.2.3",
            "::1",
            "::ffff:127.0.0.1",
            "fe80::1",
            "fc00::1",
            "2001:db8::1",
        ] {
            assert!(!public_upstream(address.parse().unwrap()), "{address}");
        }
        for address in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(public_upstream(address.parse().unwrap()), "{address}");
        }
    }

    fn admitted_snapshot(policy: &SharingPolicy) -> Vec<(String, u64, String)> {
        let mut snapshot: Vec<_> = policy
            .resources
            .iter()
            .map(|(id, value)| (id.clone(), value.revision, value.target.clone()))
            .collect();
        snapshot.sort();
        snapshot
    }
    fn batch_policy() -> (SharingPolicy, u64) {
        let mut policy = SharingPolicy::start(id('a'), 0).unwrap();
        policy.pair(&id('a'), id('b'), 0).unwrap();
        let revision = policy.publish(id('c')).unwrap().revision;
        policy
            .admit_resource(revision, id('d'), "https://fixture.example/original".into())
            .unwrap();
        (policy, revision)
    }
    #[test]
    fn resource_batch_invalid_later_id_and_duplicate_ids_preserve_all_prior_resources() {
        let (mut policy, revision) = batch_policy();
        let before = admitted_snapshot(&policy);
        for batch in [
            vec![
                (id('e'), "first".into()),
                ("invalid".into(), "later".into()),
            ],
            vec![(id('e'), "first".into()), (id('e'), "duplicate".into())],
            vec![
                (id('e'), "first".into()),
                (id('d'), "already admitted".into()),
            ],
        ] {
            assert_eq!(
                policy.admit_resources(revision, batch),
                Err("invalid-resource-id")
            );
            assert_eq!(admitted_snapshot(&policy), before);
        }
    }
    #[test]
    fn resource_batch_obsolete_revision_and_capacity_overflow_are_whole_failures() {
        let (mut policy, revision) = batch_policy();
        let before = admitted_snapshot(&policy);
        assert_eq!(
            policy.admit_resources(revision + 1, vec![(id('e'), "future".into())]),
            Err("obsolete-revision")
        );
        assert_eq!(admitted_snapshot(&policy), before);
        policy
            .admit_resources(
                revision,
                (0..4094)
                    .map(|i| {
                        (
                            format!("{i:064x}"),
                            format!("https://fixture.example/item/{i}"),
                        )
                    })
                    .collect(),
            )
            .unwrap();
        assert_eq!(policy.resources.len(), 4095);
        let before = admitted_snapshot(&policy);
        assert_eq!(
            policy.admit_resources(
                revision,
                vec![
                    (id('e'), "first would fit".into()),
                    (id('f'), "later would overflow".into())
                ]
            ),
            Err("resource-limit")
        );
        assert_eq!(admitted_snapshot(&policy), before);
        // Exactly the remaining slot succeeds; the legacy single-admission API is unchanged.
        policy
            .admit_resource(revision, id('e'), "https://fixture.example/final".into())
            .unwrap();
        assert_eq!(policy.resources.len(), MAX_RESOURCES);
        assert_eq!(policy.admit_resources(revision, Vec::new()), Ok(()));
    }
    #[test]
    fn valid_resource_batch_preserves_exact_targets_and_invalidated_revision_cannot_admit() {
        let (mut policy, revision) = batch_policy();
        let targets = [
            (
                id('e'),
                "https://fixture.example/segment?token=fixture&a=1".to_owned(),
            ),
            (
                id('f'),
                "https://fixture.example/key?variant=alternate".to_owned(),
            ),
        ];
        policy.admit_resources(revision, targets.to_vec()).unwrap();
        for (resource, target) in targets {
            assert_eq!(
                policy.resource(&id('b'), revision, &resource, 1).unwrap(),
                target
            );
        }
        assert_eq!(
            policy.resource(&id('b'), revision, &id('d'), 1).unwrap(),
            "https://fixture.example/original"
        );
        policy.invalidate_publication();
        assert_eq!(
            policy.admit_resources(revision, vec![(id('e'), "obsolete".into())]),
            Err("obsolete-revision")
        );
        assert!(policy.resources.is_empty());
    }
}
