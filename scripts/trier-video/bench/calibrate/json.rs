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

//! The JSON written by calibrate, yoyo and validate: registry, machine, runs
//! and samples.

use super::*;

pub(super) fn s(text: &str) -> String {
    let mut out = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub(super) fn arr(items: impl Iterator<Item = String>) -> String {
    format!("[{}]", items.collect::<Vec<_>>().join(","))
}

pub(super) fn num(v: f64) -> String {
    if v.is_finite() {
        format!("{v}")
    } else {
        "null".into()
    }
}

pub(super) fn opt<T: std::fmt::Display>(v: Option<T>) -> String {
    v.map_or("null".into(), |v| v.to_string())
}

pub(super) fn registry_json() -> String {
    arr(kit::KITS.iter().map(|k| {
        format!(
            "{{\"name\":{},\"parts\":{},\"requires\":{},\"contract\":{},\"available\":{}}}",
            s(k.name),
            arr(k.parts.iter().map(|p| s(p))),
            arr(k.requires.names().into_iter().map(s)),
            s(&format!("{:?}", k.contract)),
            kit::Features::detected().covers(k.requires)
        )
    }))
}

pub(super) fn machine_json(m: &platform::Machine) -> String {
    format!(
        "{{\"arch\":{},\"features\":{},\"usableCores\":{},\"allowed\":{},\"clusters\":{},\"memoryAvailable\":{},\"processor\":{}}}",
        s(m.arch),
        arr(m.features.names().into_iter().map(s)),
        m.usable_cores,
        m.allowed.as_ref().map_or("null".into(), |a| arr(a.iter().map(|c| c.to_string()))),
        arr(m.clusters.iter().map(|c| format!(
            "{{\"maxKhz\":{},\"capacity\":{},\"cpus\":{}}}",
            c.max_khz,
            opt(c.capacity),
            arr(c.cpus.iter().map(|c| c.to_string()))
        ))),
        opt(m.memory_available),
        m.processor.as_deref().map_or("null".into(), s)
    )
}

pub(super) fn run_json(r: &tune::Run) -> String {
    format!(
        "{{\"pictures\":{},\"frames\":{},\"refused\":{},\"wallUs\":{},\"cpuUs\":{},\"cycles\":{},\"meanUs\":{},\"p95Us\":{},\"p99Us\":{},\"maxUs\":{},\"overBudget\":{},\"longestOver\":{},\"maxPressureUs\":{},\"peakRss\":{},\"peakIsProcess\":{}}}",
        r.pictures,
        r.frames,
        r.refused,
        num(r.wall_us),
        r.cpu_us.map_or("null".into(), num),
        opt(r.cycles),
        num(r.mean_us),
        num(r.p95_us),
        num(r.p99_us),
        num(r.max_us),
        r.over_budget,
        r.longest_over,
        num(r.max_pressure_us),
        opt(r.peak_rss),
        r.peak_is_process
    )
}

pub(super) fn sample_json(
    e: &Entry,
    sample: &tune::Sample,
    prints: &[(tune::Config, u64)],
    excluded: &[(tune::Config, String)],
    trials: &[tune::Trial],
) -> String {
    format!(
        "{{\"name\":{},\"class\":{},\"kind\":{},\"bytes\":{},\"fnv64\":{},\"pictures\":{},\"passes\":{},\"periodUs\":{},\"outputs\":{},\"excluded\":{},\"trials\":{}}}",
        s(&e.name),
        s(&e.class),
        s(&e.kind),
        e.bytes,
        s(&e.fnv),
        sample.units.len(),
        sample.passes,
        num(sample.period_us),
        arr(prints.iter().map(|(c, h)| format!("{{\"config\":{},\"fingerprint\":\"{h:016x}\"}}", s(&c.label())))),
        arr(excluded.iter().map(|(c, why)| format!("{{\"config\":{},\"why\":{}}}", s(&c.label()), s(why)))),
        arr(trials.iter().map(|t| format!(
            "{{\"a\":{},\"b\":{},\"metric\":{},\"noise\":{},\"threshold\":{},\"changes\":{},\"verdict\":{},\"budgetHit\":{},\"rounds\":{}}}",
            s(&t.a.label()),
            s(&t.b.label()),
            s(t.metric.name()),
            num(t.noise),
            num(t.threshold),
            arr(t.changes.iter().map(|c| num(*c))),
            s(&format!("{:?}", t.verdict)),
            t.budget_hit,
            arr(t.rounds.iter().map(|round| arr(round.iter().map(|(side, r)| format!(
                "{{\"side\":{},\"run\":{}}}",
                s(&format!("{side:?}")),
                run_json(r)
            )))))
        )))
    )
}
