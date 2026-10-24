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

//! Trier AutoTune's Stage A calibration (docs/trier-adaptive-engine.md §6,
//! milestone 6): the Yo-Yo search on fixed samples, run by the app in the
//! background (and by the bench, to test it), with the results stored in the
//! device profile. It never competes with viewing: it does not start while a
//! decoder is alive, and starting playback cancels it within a picture
//! (`tune::cancel`); an interrupted or unconfirmed search records nothing, so
//! the known-good configuration stays and the next idle period tries again.

use super::platform::Machine;
use super::profile::{self, HardwareKey, Load, Profile};
use super::tune::{self, Config, Policy, Rule};
use super::{kit, yoyo, Resources};
use std::path::Path;

/// Pictures after a decoder starts before the playback guard watches (start-up
/// and channel changes are heavy by nature).
pub const GUARD_WARM_UP: i64 = 300;

/// The playback guard (milestone 7): whether a profile's choice must give
/// way to the known-good settings, from the INV-PERF-TAIL counters after
/// `pictures` pictures: two consecutive pictures over the frame period, or a
/// whole frame period of decode time owed (a frame at risk of being late).
pub fn guard_trips(pictures: i64, consecutive_over: i64, pressure_us: i64, period_us: i64) -> bool {
    pictures > GUARD_WARM_UP && period_us > 0 && (consecutive_over >= 2 || pressure_us >= period_us)
}

/// Pictures of real playback the policy check looks back over.
pub const POLICY_WINDOW: usize = 600;

/// The policy check in playback (INV-AUTOTUNE-011): whether the p99 of the
/// last POLICY_WINDOW pictures breaks `policy`'s share of the frame period.
/// The bench chooses under calibration load; playback runs at the clocks the
/// governor picks for a light, periodic load, and has the last word.
pub fn policy_trips(policy: Policy, pictures: i64, recent: &[u32], period_us: i64) -> bool {
    if pictures <= GUARD_WARM_UP || period_us <= 0 || recent.len() < POLICY_WINDOW {
        return false;
    }
    let mut window: Vec<u32> = recent[recent.len() - POLICY_WINDOW..].to_vec();
    window.sort_unstable();
    let p99 = window[(window.len() - 1) * 99 / 100] as f64;
    p99 > policy.p99_share() * period_us as f64
}

/// One calibration sample: a name and an MPEG-2 elementary stream.
pub struct Input<'a> {
    pub name: &'a str,
    pub es: &'a [u8],
}

/// How far Stage A may go.
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    /// Wall-clock budget for the whole calibration, in seconds.
    pub seconds: f64,
    /// Trials per sample (the confirmation is one more).
    pub trials: usize,
    /// Pictures per run (short samples are decoded over several passes).
    pub pictures: usize,
}
impl Default for Bounds {
    fn default() -> Self {
        Self {
            seconds: 120.0,
            trials: 24,
            pictures: 150,
        }
    }
}

/// Calibrates every sample whose workload class has no usable choice under
/// `policy` in the profile at `path`, and saves the profile. Returns one
/// line per sample for the log.
pub fn stage_a(
    inputs: &[Input],
    path: &Path,
    os: &str,
    policy: Policy,
    bounds: Bounds,
    conditions: &str,
) -> Vec<String> {
    tune::clear_cancel();
    let machine = Machine::detect();
    let key = HardwareKey::of(&machine, os);
    let mut lines = Vec::new();
    let mut prof = match Profile::load(path, &key) {
        Load::Valid(p) => p,
        other => {
            lines.push(format!("profile: {other:?}; starting a new one"));
            Profile::new(key)
        }
    };
    // Balanced and Efficiency select within the operating ceiling (MV13), so
    // that is all they explore here; Performance explores the usable cores.
    let ceiling = Resources::detect().threads;
    let explore = if policy.capped() {
        ceiling
    } else {
        machine.usable_cores.clamp(1, 8)
    };
    let start = Config {
        kit: kit::KitId::Default,
        workers: ceiling.min(explore),
        adaptive: false,
    };
    let rule = Rule::Policy {
        policy,
        ceiling,
        objective: policy.objective(tune::LiveJudge::cycles_counted()),
    };
    let deadline = tune::deadline(bounds.seconds);
    let mut changed = false;
    for (i, input) in inputs.iter().enumerate() {
        let units = tune::access_units(input.es);
        let Some(period_us) = tune::frame_period_us(input.es) else {
            lines.push(format!("{}: no frame rate; skipped", input.name));
            continue;
        };
        let sample = tune::Sample {
            name: input.name.to_string(),
            class: String::new(),
            passes: tune::Sample::passes_for(units.len(), bounds.pictures),
            units,
            period_us,
        };
        let Some((w, h, progressive)) = tune::shape(&sample) else {
            lines.push(format!("{}: no picture decoded; skipped", input.name));
            continue;
        };
        let class = profile::workload_class(w, h, progressive);
        // What playback has taught: no fewer workers than this.
        let floor = prof.floor(&class, policy).min(explore);
        if let Some(e) = prof.choice(&class, policy) {
            lines.push(format!(
                "{} ({class}): kept {} from {}",
                input.name,
                e.config.label(),
                e.date
            ));
            continue;
        }
        if tune::cancelled() {
            lines.push(format!(
                "{} ({class}): cancelled (playback started)",
                input.name
            ));
            break;
        }
        // An equal share of what is left of the budget.
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        let share = left.as_secs_f64() / (inputs.len() - i) as f64;
        // The search gets 70% of the share; the rest is kept so whatever it
        // found can still be confirmed.
        let mut judge =
            match tune::LiveJudge::new(&sample, start, rule, 0.01, tune::deadline(0.7 * share)) {
                Ok(mut j) => {
                    j.confirm_deadline = Some(tune::deadline(share));
                    j
                }
                Err(why) => {
                    lines.push(format!("{} ({class}): {why}", input.name));
                    continue;
                }
            };
        let space = yoyo::decoder_space_from(floor, explore);
        let start = Config {
            workers: start.workers.max(floor),
            ..start
        };
        let limits = yoyo::Limits {
            max_trials: bounds.trials,
            restarts: 1,
            ..yoyo::Limits::default()
        };
        let o = yoyo::search(&space, &mut judge, &yoyo::point_of(start), limits);
        let label = |p: &[usize]| yoyo::config_of(p).map_or("?".into(), |c| c.label());
        let confirmed = o
            .confirmation
            .filter(|c| c.verdict == tune::Verdict::Better);
        match (confirmed, yoyo::config_of(&o.locked)) {
            (Some(c), Some(config)) => {
                prof.record(profile::Entry {
                    class: class.clone(),
                    policy,
                    config,
                    change: c.change,
                    noise: c.noise,
                    trials: o.trials,
                    stability: "single".into(),
                    date: profile::utc_now(),
                    conditions: conditions.to_string(),
                    source: "stage-a".into(),
                    degradations: 0,
                    floor,
                });
                changed = true;
                lines.push(format!(
                    "{} ({class}): locked {} ({:+.1}% against {}, {} trials)",
                    input.name,
                    config.label(),
                    100.0 * c.change,
                    start.label(),
                    o.trials
                ));
            }
            // A complete search that confirmed nothing better: the known-good
            // settings are the answer for this class. Recorded as settled, so
            // calibration does not retry every day (a new decoder, device or
            // playback failure still reopens it).
            _ if !o.budget_hit && !tune::cancelled() => {
                prof.record(profile::Entry {
                    class: class.clone(),
                    policy,
                    config: start,
                    change: 0.0,
                    noise: o.confirmation.map_or(0.0, |c| c.noise),
                    trials: o.trials,
                    stability: "known-good".into(),
                    date: profile::utc_now(),
                    conditions: conditions.to_string(),
                    source: "stage-a".into(),
                    degradations: 0,
                    floor,
                });
                changed = true;
                lines.push(format!(
                    "{} ({class}): settled on the known-good {} (found {}, not confirmed better; {} trials)",
                    input.name,
                    start.label(),
                    label(&o.found),
                    o.trials
                ));
            }
            _ => lines.push(format!(
                "{} ({class}): nothing confirmed better than {} (found {}, {} trials{}); nothing recorded",
                input.name,
                start.label(),
                label(&o.found),
                o.trials,
                if tune::cancelled() { ", cancelled" } else { ", budget reached" }
            )),
        }
    }
    if changed {
        match prof.save(path) {
            Ok(()) => lines.push(format!("profile saved: {}", path.display())),
            Err(e) => lines.push(format!("profile not saved: {e}")),
        }
    }
    lines
}

#[cfg(test)]
#[path = "calibration_tests.rs"]
mod tests;
