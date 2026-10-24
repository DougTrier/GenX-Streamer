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

//! What keeps a short code safe (SH-021, SH-023, SH-024): a fresh six-digit
//! code per session, few connections per client, a lockout for a client that
//! keeps guessing, an end to the session when guesses add up, and an end when
//! this device leaves the network it shared on.
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

/// Connections at a time from one client, so one phone cannot take every slot.
const PER_CLIENT: u32 = 3;
/// Wrong codes after which a client is no longer answered.
pub(crate) const CLIENT_GUESSES: u32 = 5;
/// Wrong codes, from anyone, after which the session ends. With a million
/// codes, the chance that guessing finds the code first is 1 in 50,000.
pub(crate) const SESSION_GUESSES: u32 = 20;

/// A session's code: six random digits, every value equally likely
/// (draws above the largest multiple of a million are drawn again).
pub(crate) fn code() -> Result<String, String> {
    loop {
        let mut bytes = [0u8; 4];
        getrandom::fill(&mut bytes).map_err(|_| "nearby-unavailable".to_string())?;
        let draw = u32::from_le_bytes(bytes);
        if draw < 4_294_000_000 {
            return Ok(format!("{:06}", draw % 1_000_000));
        }
    }
}

/// Connections now open, per client address.
#[derive(Default)]
pub(crate) struct Clients(Mutex<HashMap<IpAddr, u32>>);

/// One admitted connection; dropping it frees the client's slot.
pub(crate) struct ClientSlot(Arc<Clients>, IpAddr);

impl Clients {
    pub(crate) fn admit(self: &Arc<Self>, ip: IpAddr) -> Option<ClientSlot> {
        let mut open = self.0.lock().ok()?;
        let count = open.entry(ip).or_insert(0);
        if *count >= PER_CLIENT {
            return None;
        }
        *count += 1;
        Some(ClientSlot(self.clone(), ip))
    }
}

impl Drop for ClientSlot {
    fn drop(&mut self) {
        if let Ok(mut open) = (self.0).0.lock() {
            if let Some(count) = open.get_mut(&self.1) {
                *count -= 1;
                if *count == 0 {
                    open.remove(&self.1);
                }
            }
        }
    }
}

/// Wrong codes tried in one session.
#[derive(Default)]
pub(crate) struct Guesses {
    by_client: Mutex<HashMap<IpAddr, u32>>,
    total: AtomicU32,
}

impl Guesses {
    pub(crate) fn record(&self, ip: IpAddr) {
        if let Ok(mut by_client) = self.by_client.lock() {
            // Bounded: past the session limit nothing more is needed.
            if by_client.len() < 1024 {
                *by_client.entry(ip).or_insert(0) += 1;
            }
        }
        self.total.fetch_add(1, Ordering::SeqCst);
    }
    pub(crate) fn locked_out(&self, ip: IpAddr) -> bool {
        self.by_client.lock().map_or(true, |by_client| {
            by_client.get(&ip).copied().unwrap_or(0) >= CLIENT_GUESSES
        })
    }
    pub(crate) fn exhausted(&self) -> bool {
        self.total.load(Ordering::SeqCst) >= SESSION_GUESSES
    }
}

/// Whether this device still has the address the session listens on.
pub(crate) fn still_has(ip: IpAddr, addresses: &[IpAddr]) -> bool {
    addresses.contains(&ip)
}

pub(crate) fn addresses() -> Vec<IpAddr> {
    if_addrs::get_if_addrs()
        .map(|found| found.into_iter().map(|interface| interface.ip()).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_six_digits_and_vary() {
        let codes: Vec<String> = (0..50).map(|_| code().unwrap()).collect();
        assert!(codes
            .iter()
            .all(|code| code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit())));
        let distinct: std::collections::HashSet<_> = codes.iter().collect();
        assert!(distinct.len() > 40, "{distinct:?}");
    }

    #[test]
    fn one_client_gets_three_connections_at_a_time() {
        let clients = Arc::new(Clients::default());
        let phone: IpAddr = "192.168.1.20".parse().unwrap();
        let other: IpAddr = "192.168.1.21".parse().unwrap();
        let held: Vec<_> = (0..3).map(|_| clients.admit(phone).unwrap()).collect();
        assert!(clients.admit(phone).is_none());
        assert!(clients.admit(other).is_some());
        drop(held);
        assert!(clients.admit(phone).is_some());
    }

    #[test]
    fn a_guessing_client_is_locked_out_and_many_guesses_end_the_session() {
        let guesses = Guesses::default();
        let phone: IpAddr = "192.168.1.20".parse().unwrap();
        for _ in 0..CLIENT_GUESSES - 1 {
            guesses.record(phone);
        }
        assert!(!guesses.locked_out(phone));
        guesses.record(phone);
        assert!(guesses.locked_out(phone));
        assert!(!guesses.exhausted());
        for last in 0..(SESSION_GUESSES - CLIENT_GUESSES) {
            let other = IpAddr::from([10, 0, 0, (last + 1) as u8]);
            assert!(!guesses.locked_out(other));
            guesses.record(other);
        }
        assert!(guesses.exhausted());
    }

    #[test]
    fn the_session_ends_when_this_device_leaves_the_network() {
        let here: IpAddr = "192.168.1.5".parse().unwrap();
        assert!(still_has(here, &["127.0.0.1".parse().unwrap(), here]));
        assert!(!still_has(here, &["10.0.0.7".parse().unwrap()]));
        assert!(!still_has(here, &[]));
    }
}
