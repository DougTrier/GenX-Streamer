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

//! Episode-local transport facts only. This is neither a decoder claim nor a
//! candidate/identity cache. Keys are exact bytes, including signed URL queries.
use std::collections::VecDeque;
use zeroize::Zeroizing;

const CONTRACT: &[u8] =
    b"genx-resource-inspector/fixed-ua/no-custom-headers/no-cookies/fresh-client/v1";
const MAX_ENTRIES: usize = 256;
const MAX_BYTES: usize = 1024 * 1024;

pub(crate) struct Key(Zeroizing<Vec<u8>>);
impl Key {
    pub(crate) fn new(
        url: &str,
        allow_http: bool,
        platform: &str,
        profile: &str,
        budget: u64,
    ) -> Self {
        let mut bytes = Vec::new();
        for part in [
            CONTRACT,
            url.as_bytes(),
            platform.as_bytes(),
            profile.as_bytes(),
        ] {
            bytes.extend_from_slice(&(part.len() as u64).to_le_bytes());
            bytes.extend_from_slice(part);
        }
        bytes.push(u8::from(allow_http));
        bytes.extend_from_slice(&budget.to_le_bytes());
        Self(Zeroizing::new(bytes))
    }
    fn matches(&self, other: &Self) -> bool {
        self.0.as_slice() == other.0.as_slice()
    }
}

/// Only construction is through a recognized Reachable inspection in the probe
/// adapter. No producer reservation, metadata, headers or request counts survive.
#[derive(Clone, Copy)]
pub(crate) struct Recognized {
    pub observed_at: u64,
}
impl Recognized {
    pub(crate) fn fresh(self, now: u64, budget: u64) -> bool {
        now.checked_sub(self.observed_at)
            .is_some_and(|age| age < budget)
    }
}
struct Entry {
    key: Key,
    value: Recognized,
    bytes: usize,
}
#[derive(Default)]
pub(crate) struct Memo {
    entries: VecDeque<Entry>,
    bytes: usize,
}
impl Memo {
    pub(crate) fn get(&mut self, key: &Key, now: u64, budget: u64) -> Option<Recognized> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.key.matches(key))?;
        let entry = &self.entries[index];
        if entry.value.fresh(now, budget) {
            return Some(entry.value);
        }
        let removed = self.entries.remove(index)?;
        self.bytes -= removed.bytes;
        None
    }
    pub(crate) fn insert(&mut self, key: Key, value: Recognized) {
        // Account retained allocation, not merely URL length; bound both the
        // variable keys and all entry slots independently of network body limits.
        let Some(bytes) = key.0.capacity().checked_add(std::mem::size_of::<Entry>()) else {
            return;
        };
        // Reserve room for the deque's maximum retained slot allocation too,
        // including slots kept after eviction/clear. Counting entry sizes again
        // below is deliberately conservative.
        let capacity = MAX_BYTES - MAX_ENTRIES * std::mem::size_of::<Entry>();
        if bytes > capacity {
            return;
        }
        if let Some(index) = self
            .entries
            .iter()
            .position(|entry| entry.key.matches(&key))
        {
            let previous = self.entries.remove(index).expect("located memo entry");
            self.bytes -= previous.bytes;
        }
        while self.entries.len() >= MAX_ENTRIES || self.bytes > capacity - bytes {
            let Some(previous) = self.entries.pop_front() else {
                return;
            };
            self.bytes -= previous.bytes;
        }
        self.bytes += bytes;
        self.entries.push_back(Entry { key, value, bytes });
    }
    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }
    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
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
    #[test]
    fn exact_request_scope_never_normalizes_url_or_policy() {
        let mut memo = Memo::default();
        memo.insert(
            key("https://fixture.invalid/x?q=A&b=2"),
            Recognized { observed_at: 100 },
        );
        for mismatch in [
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
            assert!(memo.get(&mismatch, 101, 20_000).is_none());
        }
        assert_eq!(
            memo.get(&key("https://fixture.invalid/x?q=A&b=2"), 101, 20_000)
                .unwrap()
                .observed_at,
            100
        );
    }
    #[test]
    fn strict_expiry_and_backwards_clock_remove_entry() {
        for now in [99, 20_100, 30_000] {
            let mut memo = Memo::default();
            memo.insert(key("x"), Recognized { observed_at: 100 });
            assert!(memo.get(&key("x"), now, 20_000).is_none());
            assert!(memo.entries.is_empty());
        }
        let mut memo = Memo::default();
        memo.insert(key("x"), Recognized { observed_at: 100 });
        assert!(memo.get(&key("x"), 20_099, 20_000).is_some());
    }
    #[test]
    fn deterministic_fifo_entry_and_allocation_caps_and_clear() {
        let mut memo = Memo::default();
        for n in 0..257 {
            memo.insert(key(&n.to_string()), Recognized { observed_at: 100 });
        }
        assert_eq!(memo.entries.len(), 256);
        assert!(memo.get(&key("0"), 101, 20_000).is_none());
        assert!(memo.get(&key("1"), 101, 20_000).is_some());
        memo.clear();
        assert_eq!(memo.bytes, 0);
        for n in 0..256 {
            memo.insert(
                key(&format!("{n}{}", "x".repeat(16_384))),
                Recognized { observed_at: 100 },
            );
            assert!(memo.bytes <= MAX_BYTES);
        }
        assert!(memo.entries.len() < 256);
        assert!(memo
            .get(&key(&format!("0{}", "x".repeat(16_384))), 101, 20_000)
            .is_none());
        memo.insert(
            key(&"x".repeat(MAX_BYTES + 1)),
            Recognized { observed_at: 100 },
        );
        assert!(memo.bytes <= MAX_BYTES);
        memo.clear();
        assert!(memo.entries.is_empty());
    }
}
