use serde::Serialize;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Phase {
    Preparing,
    Sealing,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Progress {
    schema_version: u8,
    request_id: String,
    root_generation: String,
    prepared_candidates: usize,
    total_candidates: usize,
    phase: Phase,
}
pub(super) struct Publisher {
    request_id: String,
    generation: u64,
    total: usize,
    seen: Option<(usize, Phase)>,
    last_emit_ms: Option<u64>,
    last_seen_ms: u64,
}
impl Publisher {
    pub(super) fn new(
        request_id: String,
        generation: u64,
        total: usize,
    ) -> Result<Self, &'static str> {
        if request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || total > 100_000
        {
            return Err("source-activation-progress-invalid");
        }
        Ok(Self {
            request_id,
            generation,
            total,
            seen: None,
            last_emit_ms: None,
            last_seen_ms: 0,
        })
    }
    pub(super) fn sample(
        &mut self,
        prepared: usize,
        phase: Phase,
        elapsed_ms: u64,
    ) -> Result<Option<Progress>, &'static str> {
        if prepared > self.total
            || elapsed_ms < self.last_seen_ms
            || (phase == Phase::Sealing && prepared != self.total)
            || self.seen.is_some_and(|(n, p)| {
                prepared < n || (p == Phase::Sealing && phase != Phase::Sealing)
            })
        {
            return Err("source-activation-progress-invalid");
        }
        let repeated = self.seen == Some((prepared, phase));
        self.seen = Some((prepared, phase));
        self.last_seen_ms = elapsed_ms;
        if repeated
            || (phase != Phase::Sealing
                && self
                    .last_emit_ms
                    .is_some_and(|last| elapsed_ms.saturating_sub(last) < 250))
        {
            return Ok(None);
        }
        self.last_emit_ms = Some(elapsed_ms);
        Ok(Some(Progress {
            schema_version: 1,
            request_id: self.request_id.clone(),
            root_generation: self.generation.to_string(),
            prepared_candidates: prepared,
            total_candidates: self.total,
            phase,
        }))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn monotonic_bounded_throttle_and_final_are_request_scoped() {
        let mut p = Publisher::new("request-1".into(), 7, 1000).unwrap();
        let v = serde_json::to_value(p.sample(0, Phase::Preparing, 0).unwrap().unwrap()).unwrap();
        assert_eq!(v["requestId"], "request-1");
        assert_eq!(v["rootGeneration"], "7");
        assert_eq!(v.as_object().unwrap().len(), 6);
        assert!(p.sample(64, Phase::Preparing, 10).unwrap().is_none());
        assert!(p.sample(128, Phase::Preparing, 250).unwrap().is_some());
        assert!(p.sample(127, Phase::Preparing, 251).is_err());
        assert!(p.sample(1001, Phase::Preparing, 252).is_err());
        assert!(p.sample(900, Phase::Sealing, 253).is_err());
        assert!(p.sample(1000, Phase::Sealing, 254).unwrap().is_some());
        assert!(p.sample(1000, Phase::Sealing, 255).unwrap().is_none());
        assert!(p.sample(1000, Phase::Preparing, 500).is_err());
    }
    #[test]
    fn empty_bounds_clock_and_large_counter_refuse_without_payload() {
        assert!(Publisher::new("bad space".into(), 1, 1).is_err());
        assert!(Publisher::new("r".into(), 1, 100001).is_err());
        let mut p = Publisher::new("r".into(), u64::MAX, 0).unwrap();
        assert!(p.sample(0, Phase::Preparing, 5).unwrap().is_some());
        assert!(p.sample(0, Phase::Sealing, 4).is_err());
        assert!(p.sample(0, Phase::Sealing, 5).unwrap().is_some());
    }
}
