// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
//! Normalized transport targets for one authenticated scan episode. Metadata
//! aliases retain their identities; a target is inspected once, not per alias.
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use zeroize::{Zeroize, Zeroizing};
const CONTRACT: &[u8] = b"genx-resource-inspector/fixed-ua/no-custom-headers/no-cookies/episode/v2";
const MAX_ENTRIES: usize = 100_000;
const MAX_INFLIGHT: usize = 16;
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Key([u8; 32]);
impl Drop for Key {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
impl Key {
    pub(crate) fn new(
        url: &str,
        allow_http: bool,
        platform: &str,
        profile: &str,
        budget: u64,
    ) -> Self {
        Self::from_url_hash(
            Sha256::digest(Zeroizing::new(
                serde_json::to_vec(url).expect("URL string encoding"),
            ))
            .into(),
            allow_http,
            platform,
            profile,
            budget,
        )
    }
    pub(crate) fn from_url_hash(
        url: [u8; 32],
        allow_http: bool,
        platform: &str,
        profile: &str,
        budget: u64,
    ) -> Self {
        let mut h = Sha256::new();
        for part in [
            CONTRACT,
            url.as_slice(),
            platform.as_bytes(),
            profile.as_bytes(),
        ] {
            h.update((part.len() as u64).to_le_bytes());
            h.update(part);
        }
        h.update([u8::from(allow_http)]);
        h.update(budget.to_le_bytes());
        Self(h.finalize().into())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Reachable,
    Http(u16),
    Slow,
    TimedOut,
    NetworkFailure,
    Unsupported,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct ObservedTarget {
    pub observed_at: u64,
    pub outcome: Outcome,
}
impl ObservedTarget {
    // Preserve the original observation time. Each recipient still checks the
    // current plan fence, permissions and episode expiry before reuse.
    pub(crate) fn valid(self, now: u64) -> bool {
        self.observed_at <= now
    }
}
#[derive(Default)]
pub(crate) struct Memo {
    entries: BTreeMap<Key, ObservedTarget>,
    inflight: BTreeSet<Key>,
}
impl Memo {
    pub(crate) fn get(&mut self, key: &Key, now: u64, _budget: u64) -> Option<ObservedTarget> {
        let value = *self.entries.get(key)?;
        if value.valid(now) {
            Some(value)
        } else {
            self.entries.remove(key);
            None
        }
    }
    pub(crate) fn insert(&mut self, key: Key, value: ObservedTarget) {
        if self.entries.contains_key(&key) || self.entries.len() < MAX_ENTRIES {
            self.entries.insert(key, value);
        }
    }
    pub(crate) fn claim(&mut self, key: Key) -> bool {
        if self.inflight.len() >= MAX_INFLIGHT {
            return false;
        }
        self.inflight.insert(key)
    }
    pub(crate) fn release(&mut self, key: &Key) {
        self.inflight.remove(key);
    }
    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.inflight.clear();
    }
    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty() && self.inflight.is_empty()
    }
}
impl Drop for Memo {
    fn drop(&mut self) {
        self.clear();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn key(url: &str) -> Key {
        Key::new(url, false, "android", "resource-v1", 20_000)
    }
    fn fact(at: u64) -> ObservedTarget {
        ObservedTarget {
            observed_at: at,
            outcome: Outcome::Reachable,
        }
    }
    #[test]
    fn exact_request_scope_preserves_queries_permissions_and_profile() {
        let mut m = Memo::default();
        m.insert(key("https://fixture.invalid/x?q=A&b=2"), fact(100));
        for k in [
            key("https://fixture.invalid/x?b=2&q=A"),
            key("https://fixture.invalid/x?q=a&b=2"),
            Key::new(
                "https://fixture.invalid/x?q=A&b=2",
                true,
                "android",
                "resource-v1",
                20_000,
            ),
            Key::new(
                "https://fixture.invalid/x?q=A&b=2",
                false,
                "windows",
                "resource-v1",
                20_000,
            ),
            Key::new(
                "https://fixture.invalid/x?q=A&b=2",
                false,
                "android",
                "resource-v2",
                20_000,
            ),
            Key::new(
                "https://fixture.invalid/x?q=A&b=2",
                false,
                "android",
                "resource-v1",
                45_000,
            ),
        ] {
            assert!(m.get(&k, 101, 20_000).is_none());
        }
        assert_eq!(
            m.get(&key("https://fixture.invalid/x?q=A&b=2"), 101, 20_000)
                .unwrap()
                .observed_at,
            100
        );
    }
    #[test]
    fn whole_episode_reuse_keeps_original_timestamp_and_rejects_clock_reversal() {
        let mut m = Memo::default();
        m.insert(key("one"), fact(100));
        assert_eq!(
            m.get(&key("one"), 3_600_100, 20_000).unwrap().observed_at,
            100
        );
        assert!(m.get(&key("one"), 99, 20_000).is_none());
        assert!(m.is_empty());
    }
    #[test]
    fn retains_large_normalized_scans_and_clears_at_episode_end() {
        let mut m = Memo::default();
        for n in 0..20_000 {
            m.insert(key(&n.to_string()), fact(100));
        }
        assert_eq!(m.entries.len(), 20_000);
        assert!(m.get(&key("0"), 3_600_000, 20_000).is_some());
        m.clear();
        assert!(m.is_empty());
        assert!(Memo::default().get(&key("0"), 101, 20_000).is_none());
        assert_eq!(std::mem::size_of::<Key>(), 32);
        assert!(std::mem::size_of::<ObservedTarget>() <= 24);
    }
    #[test]
    fn one_owner_claims_a_target_while_aliases_wait() {
        let mut m = Memo::default();
        assert!(m.claim(key("one")));
        assert!(!m.claim(key("one")));
        m.release(&key("one"));
        assert!(m.claim(key("one")));
        m.clear();
        assert!(m.is_empty());
    }
}
