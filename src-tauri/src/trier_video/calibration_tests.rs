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

use super::*;

/// The app's SD calibration sample (assets), for the tests only.
const SD: &[u8] = include_bytes!("../../gen/android/app/src/main/assets/trier-calibration/sd.m2v");
/// The cancel flag is process-wide: these tests take turns.
static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("trier-stage-a-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let path = dir.join(name);
    let _ = std::fs::remove_file(&path);
    path
}

/// A stream with no picture is skipped: nothing recorded, no profile.
#[test]
fn nothing_decodable_records_nothing() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    let path = temp("empty.profile");
    // A sequence header (720x480, 29.97) and nothing else.
    let es = [
        0, 0, 1, 0xB3, 0x2D, 0x01, 0xE0, 0x34, 0xFF, 0xFF, 0xE0, 0x18,
    ];
    let lines = stage_a(
        &[Input {
            name: "empty",
            es: &es,
        }],
        &path,
        "test",
        Policy::Balanced,
        Bounds::default(),
        "test",
    );
    assert!(
        lines.iter().any(|l| l.contains("no picture decoded")),
        "{lines:?}"
    );
    assert!(!path.exists());
    assert_eq!(tune::frame_period_us(&es).map(|p| p.round()), Some(33367.0));
}

/// Playback starting cancels a running calibration within a picture:
/// nothing is recorded and no profile is written.
#[test]
fn playback_cancels_and_records_nothing() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    let path = temp("cancel.profile");
    let started = std::time::Instant::now();
    let canceller = std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(300));
        tune::cancel();
    });
    let bounds = Bounds {
        seconds: 60.0,
        trials: 24,
        pictures: 150,
    };
    let lines = stage_a(
        &[Input { name: "sd", es: SD }],
        &path,
        "test",
        Policy::Balanced,
        bounds,
        "test",
    );
    canceller.join().expect("canceller");
    tune::clear_cancel();
    assert!(lines.iter().any(|l| l.contains("cancelled")), "{lines:?}");
    assert!(!path.exists(), "nothing recorded");
    assert!(
        started.elapsed().as_secs_f64() < 10.0,
        "stopped promptly: {:?}",
        started.elapsed()
    );
}

/// A completed calibration stores only a confirmed choice; run again, the
/// class is kept rather than recalibrated.
#[test]
fn a_confirmed_choice_is_saved_and_kept() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    let path = temp("run.profile");
    let bounds = Bounds {
        seconds: 30.0,
        trials: 8,
        pictures: 60,
    };
    let lines = stage_a(
        &[Input { name: "sd", es: SD }],
        &path,
        "test",
        Policy::Efficiency,
        bounds,
        "test",
    );
    if lines
        .iter()
        .any(|l| l.contains("locked") || l.contains("settled"))
    {
        let key = HardwareKey::of(&Machine::detect(), "test");
        let Load::Valid(p) = Profile::load(&path, &key) else {
            panic!("saved profile loads: {lines:?}");
        };
        assert!(p.choice("sdi", Policy::Efficiency).is_some());
        let again = stage_a(
            &[Input { name: "sd", es: SD }],
            &path,
            "test",
            Policy::Efficiency,
            bounds,
            "test",
        );
        assert!(again.iter().any(|l| l.contains("kept")), "{again:?}");
    } else {
        assert!(
            lines.iter().any(|l| l.contains("nothing recorded")),
            "{lines:?}"
        );
        assert!(!path.exists());
    }
}

/// With the floor at the operating ceiling only the kits differ; a complete
/// search that confirms nothing better settles on the known-good settings
/// (no daily retries), and the floor stays.
#[test]
fn a_complete_search_settles_on_the_known_good() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    let path = temp("settle.profile");
    let key = HardwareKey::of(&Machine::detect(), "test");
    let ceiling = Resources::detect().threads;
    let mut p = Profile::new(key.clone());
    p.record(profile::Entry {
        class: "sdi".into(),
        policy: Policy::Balanced,
        config: Config {
            kit: kit::KitId::Default,
            workers: 1,
            adaptive: false,
        },
        change: -0.4,
        noise: 0.01,
        trials: 10,
        stability: "single".into(),
        date: profile::utc_now(),
        conditions: "test".into(),
        source: "test".into(),
        degradations: 0,
        floor: 1,
    });
    // Playback failed twice: the floor reaches the ceiling.
    for _ in 0..8 {
        p.record_playback_failure("sdi", Policy::Balanced, ceiling);
    }
    p.save(&path).expect("saves");
    let bounds = Bounds {
        seconds: 60.0,
        trials: 12,
        pictures: 60,
    };
    let lines = stage_a(
        &[Input { name: "sd", es: SD }],
        &path,
        "test",
        Policy::Balanced,
        bounds,
        "test",
    );
    let Load::Valid(q) = Profile::load(&path, &key) else {
        panic!("loads: {lines:?}")
    };
    match q.choice("sdi", Policy::Balanced) {
        Some(e) => {
            assert_eq!(e.config.workers, ceiling, "{lines:?}");
            assert_eq!(e.floor, ceiling);
        }
        None => assert!(lines.iter().any(|l| l.contains("budget")), "{lines:?}"),
    }
}

/// A choice that is the known-good settings themselves cannot be
/// reverted: there is nothing to fall back to and nothing to learn.
#[test]
fn the_known_good_is_never_reverted() {
    use crate::trier_video::{AutoTuneStatus, Decoder, Resources};
    let key = HardwareKey::of(&Machine::detect(), "test");
    let mut p = Profile::new(key);
    p.record(profile::Entry {
        class: "sdi".into(),
        policy: Policy::Balanced,
        config: Config {
            kit: kit::KitId::Default,
            workers: 4,
            adaptive: false,
        },
        change: 0.0,
        noise: 0.0,
        trials: 10,
        stability: "known-good".into(),
        date: profile::utc_now(),
        conditions: "test".into(),
        source: "test".into(),
        degradations: 0,
        floor: 4,
    });
    let mut d = Decoder::new();
    d.set_resources(Resources {
        threads: 4,
        spare_frames: 2,
        adaptive: false,
    });
    d.set_autotune(p, Policy::Balanced, 4);
    for (i, u) in tune::access_units(SD).iter().take(3).enumerate() {
        d.decode(u, i as i64).expect("decodes");
    }
    assert_eq!(d.autotune_status().0, AutoTuneStatus::Applied);
    assert!(!d.autotune_revert());
    assert_eq!(d.autotune_status().0, AutoTuneStatus::Applied);
}

#[test]
fn the_policy_check_uses_real_playback_times() {
    let period = 16_677;
    let steady = vec![6_000u32; POLICY_WINDOW];
    assert!(!policy_trips(Policy::Balanced, 1000, &steady, period));
    let mut tail = steady.clone();
    for t in tail.iter_mut().step_by(50) {
        *t = 22_000;
    }
    assert!(
        policy_trips(Policy::Balanced, 1000, &tail, period),
        "p99 22 ms > 60% of 16.7 ms"
    );
    assert!(
        policy_trips(Policy::Efficiency, 1000, &tail, period),
        "> 85% too"
    );
    assert!(
        !policy_trips(Policy::Balanced, 100, &tail, period),
        "not during warm-up"
    );
    assert!(
        !policy_trips(Policy::Balanced, 1000, &tail[..100], period),
        "a full window first"
    );
}

#[test]
fn the_guard_trips_only_on_real_pressure() {
    let period = 33_367;
    assert!(!guard_trips(100, 5, 50_000, period), "not during warm-up");
    assert!(
        !guard_trips(1000, 1, 10_000, period),
        "one slow picture absorbed"
    );
    assert!(guard_trips(1000, 2, 0, period), "two in a row");
    assert!(guard_trips(1000, 0, period, period), "a frame owed");
    assert!(
        !guard_trips(1000, 5, 50_000, 0),
        "no frame period known yet"
    );
}

/// A profile choice applied at the first picture, then reverted in the
/// middle of the stream (the guard), gives exactly the pictures of a
/// decoder without AutoTune (INV-AUTOTUNE-002, -004), and after the revert
/// the choice is not applied again.
#[test]
fn applying_and_reverting_mid_stream_keeps_the_pictures() {
    use crate::trier_video::kit::KitId;
    use crate::trier_video::{Decoder, Resources};
    let key = HardwareKey::of(&Machine::detect(), "test");
    let mut p = Profile::new(key);
    p.record(profile::Entry {
        class: "sdi".into(),
        policy: Policy::Balanced,
        config: Config {
            kit: KitId::Pairs12,
            workers: 1,
            adaptive: false,
        },
        change: -0.3,
        noise: 0.01,
        trials: 10,
        stability: "single".into(),
        date: profile::utc_now(),
        conditions: "test".into(),
        source: "test".into(),
        degradations: 0,
        floor: 1,
    });
    let units = tune::access_units(SD);
    let base = Resources {
        threads: 4,
        spare_frames: 2,
        adaptive: false,
    };
    let decode = |tuned: bool| -> Vec<Vec<u8>> {
        let mut d = Decoder::new();
        d.set_resources(base);
        if tuned {
            d.set_autotune(p.clone(), Policy::Balanced, 4);
        }
        let mut out = Vec::new();
        for (i, u) in units.iter().enumerate() {
            if tuned && i == 1 {
                assert_eq!(
                    d.autotune_status().0,
                    crate::trier_video::AutoTuneStatus::Applied
                );
                assert_eq!((d.threads(), d.kit()), (1, KitId::Pairs12));
            }
            if tuned && i == units.len() / 2 {
                assert!(d.autotune_revert());
                assert_eq!((d.threads(), d.kit()), (4, KitId::Default));
            }
            for f in d.decode(u, i as i64).expect("decodes") {
                out.push([f.planes.y.clone(), f.planes.cb.clone(), f.planes.cr.clone()].concat());
            }
        }
        for f in d.flush() {
            out.push([f.planes.y.clone(), f.planes.cb.clone(), f.planes.cr.clone()].concat());
        }
        if tuned {
            assert_eq!(
                d.autotune_status().0,
                crate::trier_video::AutoTuneStatus::Reverted
            );
            assert_eq!(d.threads(), 4, "not applied again after the revert");
        }
        out
    };
    let plain = decode(false);
    assert!(!plain.is_empty());
    assert!(plain == decode(true), "identical pictures");
}

#[test]
fn access_units_carry_their_headers() {
    // seq, gop, pic, slice, pic, slice, seq, pic, slice
    let mut es = Vec::new();
    for code in [0xB3u8, 0xB8, 0x00, 0x01, 0x00, 0x01, 0xB3, 0x00, 0x01] {
        es.extend_from_slice(&[0, 0, 1, code, 0x55, 0x55]);
    }
    let units = tune::access_units(&es);
    assert_eq!(units.len(), 3);
    assert_eq!(&units[0][..4], &[0, 0, 1, 0xB3]);
    assert_eq!(&units[1][..4], &[0, 0, 1, 0x00]);
    assert_eq!(&units[2][..4], &[0, 0, 1, 0xB3]);
    assert_eq!(units.iter().map(|u| u.len()).sum::<usize>(), es.len());
}
