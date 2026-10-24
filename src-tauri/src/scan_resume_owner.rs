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

//! Operational reservation scheduler. Networking and durable publication have distinct owners.
//! Every ordinal/token must originate in a fully admitted authenticated native directory.
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
const ERR: &str = "scan-resume-owner-invalid";
/// Scan checks at once across sites, one at a time per site. Must leave room
/// under the app's native request ceiling (`requests::MAX_RUNNING_REQUESTS`,
/// 24) for playback and control work: 32 was tried on October 21, 2026 and
/// the Sansui's scan failed with "network-concurrency-limit".
pub(crate) const MAX_ACTIVE_PROBES: usize = 16;
/// Checks at once on one site (owner design, October 21, 2026: "1–2 per
/// host"). With one, a site listing hundreds of streams became a single-file
/// queue that set the scan's length: on the S25 the last 1,112 of 16,512
/// checks were on 5 sites and ran at 10–38 a minute. Each site's gap after a
/// check and its Retry-After still apply.
pub(crate) const MAX_PROBES_PER_ORIGIN: u8 = 2;
pub(crate) type Origin = [u8; 32];
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Work {
    Probe,
    Publish,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Reserved,
    Active,
    Observed,
}
#[derive(Clone)]
pub(crate) struct Reservation {
    pub id: String,
    pub ordinal: usize,
    pub origin: Origin,
    pub work: Work,
    state: State,
}
pub(crate) struct Scheduler {
    groups: BTreeMap<Origin, BTreeSet<usize>>,
    heads: BTreeSet<(usize, Origin)>,
    origin_heads: BTreeMap<Origin, usize>,
    work: HashMap<usize, Work>,
    held: HashMap<String, Reservation>,
    /// Probes reserved or running per site (at most MAX_PROBES_PER_ORIGIN).
    busy: HashMap<Origin, u8>,
    eligible_at: BTreeMap<Origin, u64>,
    acknowledged: HashSet<String>,
    acknowledgment_order: VecDeque<String>,
    closed: bool,
}
impl Scheduler {
    pub(crate) fn new(
        rows: impl IntoIterator<Item = (usize, Origin, Work)>,
    ) -> Result<Self, String> {
        let mut value = Self {
            groups: BTreeMap::new(),
            heads: BTreeSet::new(),
            origin_heads: BTreeMap::new(),
            work: HashMap::new(),
            held: HashMap::new(),
            busy: HashMap::new(),
            eligible_at: BTreeMap::new(),
            acknowledged: HashSet::new(),
            acknowledgment_order: VecDeque::new(),
            closed: false,
        };
        for (ordinal, origin, work) in rows {
            if ordinal >= 100_000 || value.work.insert(ordinal, work).is_some() {
                return Err(ERR.into());
            }
            value.groups.entry(origin).or_default().insert(ordinal);
        }
        for (origin, group) in &value.groups {
            if let Some(ordinal) = group.first() {
                value.heads.insert((*ordinal, *origin));
                value.origin_heads.insert(*origin, *ordinal);
            }
        }
        Ok(value)
    }
    fn busy_count(&self, origin: &Origin) -> u8 {
        self.busy.get(origin).copied().unwrap_or(0)
    }
    fn release_busy(&mut self, origin: Origin) {
        if let Some(count) = self.busy.get_mut(&origin) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.busy.remove(&origin);
            }
        }
    }
    fn check(&self) -> Result<(), String> {
        if self.closed {
            Err("scan-resume-owner-closed".into())
        } else {
            Ok(())
        }
    }
    fn refresh_head(&mut self, origin: Origin) {
        if let Some(previous) = self.origin_heads.remove(&origin) {
            self.heads.remove(&(previous, origin));
        }
        if let Some(ordinal) = self.groups.get(&origin).and_then(BTreeSet::first) {
            self.heads.insert((*ordinal, origin));
            self.origin_heads.insert(origin, *ordinal);
        }
    }
    pub(crate) fn reserve(
        &mut self,
        limit: usize,
        blocked: &[Origin],
        now: u64,
        mut random: impl FnMut() -> Result<String, String>,
    ) -> Result<Vec<Reservation>, String> {
        self.check()?;
        if !(1..=MAX_ACTIVE_PROBES).contains(&limit)
            || blocked.len() > MAX_ACTIVE_PROBES
            || self.held.len() + limit > 256
        {
            return Err(ERR.into());
        }
        let blocked: HashSet<_> = blocked.iter().copied().collect();
        let selected: Vec<_> = self
            .heads
            .iter()
            .copied()
            .filter(|(_, o)| {
                self.busy_count(o) < MAX_PROBES_PER_ORIGIN
                    && !blocked.contains(o)
                    && self.eligible_at.get(o).is_none_or(|at| *at <= now)
            })
            .take(limit)
            .collect();
        let mut ids = HashSet::new();
        let mut result = Vec::new();
        // Admit all opaque identities before mutating pending state.
        for (ordinal, origin) in selected {
            let id = random()?;
            if id.len() != 64
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || self.held.contains_key(&id)
                || !ids.insert(id.clone())
            {
                return Err(ERR.into());
            }
            result.push(Reservation {
                id,
                ordinal,
                origin,
                work: *self.work.get(&ordinal).ok_or(ERR)?,
                state: State::Reserved,
            });
        }
        for r in &mut result {
            self.groups
                .get_mut(&r.origin)
                .ok_or(ERR)?
                .remove(&r.ordinal);
            self.refresh_head(r.origin);
            if r.work == Work::Probe {
                *self.busy.entry(r.origin).or_insert(0) += 1;
            } else {
                r.state = State::Observed;
            }
            self.held.insert(r.id.clone(), r.clone());
        }
        Ok(result)
    }
    pub(crate) fn start_probe(&mut self, id: &str) -> Result<(), String> {
        self.check()?;
        if self
            .held
            .values()
            .filter(|r| r.state == State::Active)
            .count()
            >= MAX_ACTIVE_PROBES
        {
            return Err("scan-resume-probe-capacity".into());
        }
        let r = self.held.get_mut(id).ok_or(ERR)?;
        if r.work != Work::Probe || r.state != State::Reserved {
            return Err("scan-resume-probe-stale".into());
        }
        r.state = State::Active;
        Ok(())
    }
    /// Caller invokes only after the actual native probe/transport has joined.
    pub(crate) fn finish_probe(
        &mut self,
        id: &str,
        now: u64,
        retry_after_ms: u64,
    ) -> Result<(), String> {
        self.check()?;
        let r = self.held.get_mut(id).ok_or(ERR)?;
        if r.state != State::Active {
            return Err("scan-resume-probe-stale".into());
        }
        let next = now.checked_add(350.max(retry_after_ms)).ok_or(ERR)?;
        r.state = State::Observed;
        let origin = r.origin;
        self.release_busy(origin);
        self.eligible_at.insert(origin, next);
        Ok(())
    }
    pub(crate) fn reservation(&self, id: &str) -> Result<&Reservation, String> {
        self.check()?;
        self.held.get(id).ok_or_else(|| ERR.into())
    }
    /// Validate the entire release/defer/ACK list before changing any ordinal.
    fn settled_ids(&self, ids: &[String]) -> Result<Vec<Reservation>, String> {
        self.check()?;
        if ids.is_empty() || ids.len() > 256 {
            return Err(ERR.into());
        }
        let mut unique = HashSet::new();
        let mut rows = Vec::new();
        for id in ids {
            if !unique.insert(id) {
                return Err(ERR.into());
            }
            let r = self.held.get(id).ok_or(ERR)?;
            if r.state == State::Active {
                return Err("scan-resume-probe-unjoined".into());
            }
            rows.push(r.clone());
        }
        Ok(rows)
    }
    pub(crate) fn release(&mut self, ids: &[String]) -> Result<(), String> {
        self.check()?;
        if ids.is_empty() || ids.len() > 256 {
            return Err(ERR.into());
        }
        let mut unique = HashSet::new();
        let mut held = Vec::new();
        for id in ids {
            if !unique.insert(id) {
                return Err(ERR.into());
            }
            if self.held.contains_key(id) {
                held.push(id.clone());
            } else if !self.acknowledged.contains(id) {
                return Err(ERR.into());
            }
        }
        let rows = if held.is_empty() {
            Vec::new()
        } else {
            self.settled_ids(&held)?
        };
        for r in rows {
            self.held.remove(&r.id);
            if r.state == State::Reserved && r.work == Work::Probe {
                self.release_busy(r.origin);
            }
            self.groups.entry(r.origin).or_default().insert(r.ordinal);
            self.refresh_head(r.origin);
        }
        Ok(())
    }
    /// Episode-only removal. It changes no durable observation or count.
    pub(crate) fn defer(&mut self, ids: &[String]) -> Result<(), String> {
        let rows = self.settled_ids(ids)?;
        for r in rows {
            self.held.remove(&r.id);
            if r.state == State::Reserved && r.work == Work::Probe {
                self.release_busy(r.origin);
            }
        }
        Ok(())
    }
    /// Actual committed proof must precede this call; caller cannot expose a rebase IPC.
    pub(crate) fn acknowledge(&mut self, ids: &[String]) -> Result<(), String> {
        self.acknowledge_and_requeue_publish(ids, &[])
    }
    pub(crate) fn acknowledge_and_requeue_publish(
        &mut self,
        ids: &[String],
        indices: &[usize],
    ) -> Result<(), String> {
        self.validate_acknowledgment(ids, indices)?;
        let rows = self.settled_ids(ids)?;
        let retry: HashSet<_> = indices.iter().copied().collect();
        for r in rows {
            self.held.remove(&r.id);
            self.acknowledged.insert(r.id.clone());
            self.acknowledgment_order.push_back(r.id.clone());
            while self.acknowledgment_order.len() > 256 {
                if let Some(previous) = self.acknowledgment_order.pop_front() {
                    self.acknowledged.remove(&previous);
                }
            }
            if retry.contains(&r.ordinal) {
                self.work.insert(r.ordinal, Work::Publish);
                self.groups.entry(r.origin).or_default().insert(r.ordinal);
                self.refresh_head(r.origin);
            } else {
                self.work.remove(&r.ordinal);
            }
        }
        Ok(())
    }
    pub(crate) fn validate_acknowledgment(
        &self,
        ids: &[String],
        indices: &[usize],
    ) -> Result<(), String> {
        let rows = self.settled_ids(ids)?;
        if rows.iter().any(|row| row.state != State::Observed) {
            return Err("scan-resume-observation-unconfirmed".into());
        }
        let retry: HashSet<_> = indices.iter().copied().collect();
        if retry.len() != indices.len()
            || retry
                .iter()
                .any(|index| !rows.iter().any(|row| row.ordinal == *index))
        {
            return Err(ERR.into());
        }
        Ok(())
    }
    pub(crate) fn exhausted(&self) -> bool {
        self.heads.is_empty()
    }
    pub(crate) fn next_eligible_at(&self, now: u64) -> Option<u64> {
        self.heads
            .iter()
            .filter(|(_, o)| self.busy_count(o) < MAX_PROBES_PER_ORIGIN)
            .filter_map(|(_, o)| self.eligible_at.get(o).copied())
            .filter(|at| *at > now)
            .min()
    }
    /// Only cooldown can justify an owned wait; busy/blocked origins remain
    /// owned by their actual producers. Probe receipts cap Retry-After at 60s.
    pub(crate) fn cooling_delay(
        &self,
        blocked: &[Origin],
        now: u64,
    ) -> Result<Option<u64>, String> {
        self.check()?;
        let next = self
            .heads
            .iter()
            .filter(|(_, origin)| {
                self.busy_count(origin) < MAX_PROBES_PER_ORIGIN && !blocked.contains(origin)
            })
            .filter_map(|(_, origin)| self.eligible_at.get(origin).copied())
            .filter(|at| *at > now)
            .min();
        next.map(|at| {
            at.checked_sub(now)
                .filter(|delay| (1..=60_000).contains(delay))
                .ok_or_else(|| "scan-resume-clock-invalid".into())
        })
        .transpose()
    }
    pub(crate) fn close(&mut self) -> Result<(), String> {
        if self.held.values().any(|r| r.state == State::Active) {
            return Err("scan-resume-probe-unjoined".into());
        }
        self.closed = true;
        self.held.clear();
        self.busy.clear();
        self.heads.clear();
        self.origin_heads.clear();
        self.groups.clear();
        self.work.clear();
        self.eligible_at.clear();
        self.acknowledged.clear();
        self.acknowledgment_order.clear();
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cooling_delay_only_reports_unblocked_settled_work_and_refuses_invalid_time() {
        let mut s = Scheduler::new([(0, [1; 32], Work::Probe), (1, [1; 32], Work::Probe)]).unwrap();
        let first = s.reserve(1, &[], 100, ids()).unwrap().pop().unwrap();
        s.start_probe(&first.id).unwrap();
        assert_eq!(
            s.cooling_delay(&[], 100).unwrap(),
            None,
            "active producer is not cooling work"
        );
        s.finish_probe(&first.id, 100, 60_000).unwrap();
        s.acknowledge(&[first.id]).unwrap();
        assert_eq!(s.cooling_delay(&[[1; 32]], 100).unwrap(), None);
        assert_eq!(s.cooling_delay(&[], 100).unwrap(), Some(60_000));
        assert_eq!(s.cooling_delay(&[], 60_100).unwrap(), None);
        assert_eq!(
            s.cooling_delay(&[], 99),
            Err("scan-resume-clock-invalid".into())
        );
        s.close().unwrap();
        assert!(s.cooling_delay(&[], 100).is_err());
    }
    fn ids() -> impl FnMut() -> Result<String, String> {
        let mut n = 0u64;
        move || {
            n += 1;
            Ok(format!("{n:064x}"))
        }
    }
    #[test]
    fn acknowledged_positive_without_publication_returns_as_publish_only() {
        let mut scheduler = Scheduler::new([(0, [1; 32], Work::Probe)]).unwrap();
        let mut random = ids();
        let first = scheduler
            .reserve(1, &[], 0, &mut random)
            .unwrap()
            .pop()
            .unwrap();
        scheduler.start_probe(&first.id).unwrap();
        scheduler.finish_probe(&first.id, 0, 0).unwrap();
        assert!(scheduler
            .acknowledge_and_requeue_publish(&[first.id.clone()], &[1])
            .is_err());
        scheduler
            .acknowledge_and_requeue_publish(&[first.id], &[0])
            .unwrap();
        let second = scheduler
            .reserve(1, &[], 350, &mut random)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(second.work, Work::Publish);
        assert!(scheduler.start_probe(&second.id).is_err());
        scheduler.acknowledge(&[second.id]).unwrap();
        assert!(scheduler.exhausted());
    }
    #[test]
    fn large_prefix_does_not_starve_second_origin() {
        let mut s = Scheduler::new(
            (0..63193).map(|i| (i, if i < 63192 { [1; 32] } else { [2; 32] }, Work::Probe)),
        )
        .unwrap();
        let rows = s.reserve(16, &[], 0, ids()).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.ordinal).collect::<Vec<_>>(),
            vec![0, 63192]
        );
        assert_eq!(s.held.len(), 2);
    }
    #[test]
    fn settled_probe_releases_network_origin_before_durable_publication() {
        let mut s = Scheduler::new((0..100).map(|i| (i, [1; 32], Work::Probe))).unwrap();
        let mut random = ids();
        // Two checks at once on one site, never a third; a finished check
        // frees its slot before anything is published.
        for i in 0..32u64 {
            let mut pair = Vec::new();
            for k in 0..2 {
                let r = s
                    .reserve(16, &[], i * 350, &mut random)
                    .unwrap()
                    .pop()
                    .unwrap();
                assert_eq!(r.ordinal, (2 * i + k) as usize);
                s.start_probe(&r.id).unwrap();
                pair.push(r);
            }
            assert!(s.reserve(16, &[], i * 350, &mut random).unwrap().is_empty());
            for r in pair {
                s.finish_probe(&r.id, i * 350, 0).unwrap();
            }
        }
        assert_eq!(s.held.len(), 64);
        let held = s.held.keys().cloned().collect::<Vec<_>>();
        s.acknowledge(&held).unwrap();
        assert!(s.held.is_empty());
    }
    #[test]
    fn defer_is_episode_only_and_unknown_batch_changes_nothing() {
        let mut s = Scheduler::new([(0, [1; 32], Work::Probe), (1, [2; 32], Work::Probe)]).unwrap();
        let mut random = ids();
        let rows = s.reserve(16, &[], 0, &mut random).unwrap();
        assert!(s.defer(&[rows[0].id.clone(), "unknown".into()]).is_err());
        assert_eq!(s.held.len(), 2);
        s.defer(&[rows[0].id.clone()]).unwrap();
        assert_eq!(s.held.len(), 1);
        assert!(s.work.contains_key(&0));
        let cold = Scheduler::new([(0, [1; 32], Work::Probe)]).unwrap();
        assert!(!cold.exhausted());
    }
    #[test]
    fn deferred_observed_sibling_cannot_free_new_active_origin() {
        let mut s = Scheduler::new([
            (0, [1; 32], Work::Probe),
            (1, [1; 32], Work::Probe),
            (2, [1; 32], Work::Probe),
            (3, [1; 32], Work::Publish),
        ])
        .unwrap();
        let mut random = ids();
        let a = s.reserve(1, &[], 0, &mut random).unwrap().pop().unwrap();
        s.start_probe(&a.id).unwrap();
        s.finish_probe(&a.id, 0, 0).unwrap();
        // The site's two slots are both running again.
        let b = s.reserve(1, &[], 350, &mut random).unwrap().pop().unwrap();
        s.start_probe(&b.id).unwrap();
        let c = s.reserve(1, &[], 350, &mut random).unwrap().pop().unwrap();
        s.start_probe(&c.id).unwrap();
        // Deferring the finished sibling must not free a third slot.
        s.defer(&[a.id.clone()]).unwrap();
        assert!(s.reserve(1, &[], 700, &mut random).unwrap().is_empty());
        assert!(s.close().is_err());
        s.finish_probe(&b.id, 700, 0).unwrap();
        let d = s.reserve(1, &[], 1050, &mut random).unwrap().pop().unwrap();
        assert_eq!(d.work, Work::Publish);
        s.acknowledge(&[d.id]).unwrap();
        assert!(s.close().is_err(), "c still runs");
        s.finish_probe(&c.id, 1050, 0).unwrap();
        s.close().unwrap();
    }
    #[test]
    fn close_waits_actual_probe_and_cooldown_remains_bounded() {
        let mut s = Scheduler::new([(0, [1; 32], Work::Probe), (1, [1; 32], Work::Probe)]).unwrap();
        let mut random = ids();
        let r = s.reserve(1, &[], 0, &mut random).unwrap().pop().unwrap();
        s.start_probe(&r.id).unwrap();
        assert!(s.close().is_err());
        assert!(s.release(&[r.id.clone()]).is_err());
        s.finish_probe(&r.id, 1000, 7000).unwrap();
        assert_eq!(s.next_eligible_at(1000), Some(8000));
        assert!(s.reserve(1, &[], 7999, &mut random).unwrap().is_empty());
        assert_eq!(s.reserve(1, &[], 8000, &mut random).unwrap()[0].ordinal, 1);
        s.close().unwrap();
        assert!(s.reserve(1, &[], 8000, &mut random).is_err());
    }
}
