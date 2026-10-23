//! Trier AutoTune's device profiles (docs/trier-adaptive-engine.md §7,
//! milestone 5): what calibration chose for each workload class and policy on
//! this device, with the evidence behind each choice (INV-AUTOTUNE-009).
//!
//! A profile is a small versioned text file, written atomically (a temporary
//! file, then a rename) so a crash never leaves half a profile. It is keyed by
//! the decoder version, the kit registry and the hardware; a profile that does
//! not match the running decoder and device is stale and is not applied. A
//! missing, unreadable, corrupt or stale profile means the known-good
//! configuration (INV-AUTOTUNE-007): the profile can only ever improve on the
//! default, never break decoding.

use super::kit::{self, Features};
use super::platform::Machine;
use super::tune::{Config, Policy};
use std::path::Path;

/// Changes whenever decoding behaviour may change: profiles from another
/// version are stale.
pub const DECODER_VERSION: &str = "trier-video 2026.10.21";
const HEADER: &str = "trier-autotune-profile 1";
/// Results kept per workload class and policy (the newest first).
const HISTORY: usize = 20;
/// Sessions with playback pressure on a locked choice before it must be
/// recalibrated.
pub const DEGRADATIONS_BEFORE_RECALIBRATION: u32 = 3;

/// The registry's identity: its kits' names and parts (FNV-1a 64).
pub fn registry_hash() -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for k in kit::KITS {
        for part in std::iter::once(k.name).chain(k.parts) {
            for b in part.bytes().chain(std::iter::once(0)) {
                h = (h ^ b as u64).wrapping_mul(0x100_0000_01b3);
            }
        }
    }
    format!("{h:016x}")
}

/// The workload class of a stream: its resolution band and scan, the unit a
/// profile's choices are kept per (720p and 1080i may differ on one device).
pub fn workload_class(width: usize, height: usize, progressive: bool) -> String {
    // The larger of the height and the width's 16:9 height, so anamorphic
    // and unusual aspect ratios fall in the band of their pixel load.
    let band = match height.max(width * 9 / 16) {
        0..=576 => "sd",
        577..=720 => "hd720",
        721..=1088 => "hd1080",
        _ => "uhd",
    };
    format!("{band}{}", if progressive { "p" } else { "i" })
}

/// The hardware and platform a profile was measured on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HardwareKey {
    pub arch: String,
    pub features: String,
    pub processor: String,
    /// "count x kHz / capacity" per cluster, slowest first.
    pub clusters: String,
    /// The CPUs present (from the clusters where the kernel lists them):
    /// not the cores usable at the moment, which Android changes as it takes
    /// cores on and offline (the Flip 2 showed 6, then 7).
    pub cores: usize,
    /// The operating system as the caller identifies it (Android release
    /// and SDK, Windows build); a change means revalidation.
    pub os: String,
}
impl HardwareKey {
    pub fn of(machine: &Machine, os: &str) -> Self {
        Self {
            arch: machine.arch.to_string(),
            features: machine.features.names().join(","),
            processor: machine.processor.clone().unwrap_or_default(),
            clusters: machine
                .clusters
                .iter()
                .map(|c| {
                    format!(
                        "{}x{}/{}",
                        c.cpus.len(),
                        c.max_khz,
                        c.capacity.map_or("-".into(), |v| v.to_string())
                    )
                })
                .collect::<Vec<_>>()
                .join(","),
            cores: match machine.clusters.iter().map(|c| c.cpus.len()).sum::<usize>() {
                0 => machine.usable_cores,
                present => present,
            },
            os: clean(os),
        }
    }
}

/// One calibrated choice and its evidence.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub class: String,
    pub policy: Policy,
    pub config: Config,
    /// The confirmation against the known-good configuration (relative).
    pub change: f64,
    pub noise: f64,
    pub trials: usize,
    /// "repeatable", "equivalent", "unstable" or "single" (one session).
    pub stability: String,
    /// UTC, ISO 8601.
    pub date: String,
    /// Power, temperature and anything else that conditioned the result.
    pub conditions: String,
    /// "stage-a" (calibration), "stage-b" (playback) or "bench".
    pub source: String,
    /// Playback sessions with pressure on this choice since it was locked.
    pub degradations: u32,
    /// The fewest workers calibration may choose for this class: raised when
    /// a choice missed the policy's deadline share in real playback.
    pub floor: usize,
}
impl Entry {
    /// Whether this choice may be applied: not unstable, not due for
    /// recalibration, and its kit runs on this CPU.
    pub fn usable(&self) -> bool {
        self.stability != "unstable"
            && self.degradations < DEGRADATIONS_BEFORE_RECALIBRATION
            && Features::detected().covers(kit::info_of(self.config.kit).requires)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    pub decoder: String,
    pub registry: String,
    pub hardware: HardwareKey,
    /// The current choice per class and policy.
    pub entries: Vec<Entry>,
    /// Earlier results, newest first (at most HISTORY per class and policy).
    pub history: Vec<Entry>,
}

/// What loading a profile found.
#[derive(Debug, PartialEq)]
pub enum Load {
    Missing,
    /// Unreadable or corrupt: the known-good configuration applies.
    Invalid(String),
    /// Made by another decoder version, registry, device or OS: the
    /// known-good configuration applies until recalibration.
    Stale(String),
    Valid(Profile),
}

impl Profile {
    pub fn new(hardware: HardwareKey) -> Self {
        Self {
            decoder: DECODER_VERSION.into(),
            registry: registry_hash(),
            hardware,
            entries: Vec::new(),
            history: Vec::new(),
        }
    }

    /// The usable choice for `class` under `policy`, if any.
    pub fn choice(&self, class: &str, policy: Policy) -> Option<&Entry> {
        self.entries
            .iter()
            .find(|e| e.class == class && e.policy == policy)
            .filter(|e| e.usable())
    }

    /// Records a new result: it replaces the current entry for its class and
    /// policy, and the old one moves to the history (bounded).
    pub fn record(&mut self, entry: Entry) {
        if let Some(i) = self
            .entries
            .iter()
            .position(|e| e.class == entry.class && e.policy == entry.policy)
        {
            let old = self.entries.remove(i);
            self.history.insert(0, old);
        }
        self.history.insert(0, entry.clone());
        self.entries.push(entry);
        // Keep HISTORY per class and policy.
        let mut seen: Vec<(String, Policy, usize)> = Vec::new();
        self.history.retain(|e| {
            match seen
                .iter_mut()
                .find(|(c, p, _)| *c == e.class && *p == e.policy)
            {
                Some((_, _, n)) => {
                    *n += 1;
                    *n <= HISTORY
                }
                None => {
                    seen.push((e.class.clone(), e.policy, 1));
                    true
                }
            }
        });
    }

    /// The worker floor playback has taught for `class` under `policy`.
    pub fn floor(&self, class: &str, policy: Policy) -> usize {
        self.entries
            .iter()
            .chain(&self.history)
            .filter(|e| e.class == class && e.policy == policy)
            .map(|e| e.floor)
            .max()
            .unwrap_or(1)
            .max(1)
    }

    /// Real playback showed the current choice missing the policy's deadline
    /// share (decisive, not noise): the choice is retired at once and the
    /// floor rises above its workers (at most `ceiling`), so calibration
    /// climbs to a setting that holds in playback.
    pub fn record_playback_failure(
        &mut self,
        class: &str,
        policy: Policy,
        ceiling: usize,
    ) -> Option<usize> {
        let e = self
            .entries
            .iter_mut()
            .find(|e| e.class == class && e.policy == policy)?;
        // At the ceiling there is nothing higher to climb to: keep the choice.
        if e.config.workers >= ceiling.max(1) {
            return None;
        }
        e.degradations = e.degradations.max(DEGRADATIONS_BEFORE_RECALIBRATION);
        e.floor = (e.config.workers + 1).min(ceiling.max(1)).max(e.floor);
        Some(e.floor)
    }

    /// Notes a playback session with pressure on the current choice; true
    /// when that choice is now due for recalibration.
    pub fn note_degradation(&mut self, class: &str, policy: Policy) -> bool {
        match self
            .entries
            .iter_mut()
            .find(|e| e.class == class && e.policy == policy)
        {
            Some(e) => {
                e.degradations += 1;
                e.degradations >= DEGRADATIONS_BEFORE_RECALIBRATION
            }
            None => false,
        }
    }

    pub fn render(&self) -> String {
        let mut out = format!("{HEADER}\n");
        let kv = |out: &mut String, k: &str, v: &str| {
            out.push_str(k);
            out.push('\t');
            out.push_str(&clean(v));
            out.push('\n');
        };
        kv(&mut out, "decoder", &self.decoder);
        kv(&mut out, "registry", &self.registry);
        kv(&mut out, "arch", &self.hardware.arch);
        kv(&mut out, "features", &self.hardware.features);
        kv(&mut out, "processor", &self.hardware.processor);
        kv(&mut out, "clusters", &self.hardware.clusters);
        kv(&mut out, "cores", &self.hardware.cores.to_string());
        kv(&mut out, "os", &self.hardware.os);
        for (tag, list) in [("entry", &self.entries), ("history", &self.history)] {
            for e in list {
                out.push_str(&format!(
                    "{tag}\tclass={}\tpolicy={}\tconfig={}\tchange={}\tnoise={}\ttrials={}\tstability={}\tdate={}\tconditions={}\tsource={}\tdegradations={}\tfloor={}\n",
                    clean(&e.class),
                    e.policy.name(),
                    e.config.label(),
                    e.change,
                    e.noise,
                    e.trials,
                    clean(&e.stability),
                    clean(&e.date),
                    clean(&e.conditions),
                    clean(&e.source),
                    e.degradations,
                    e.floor
                ));
            }
        }
        out
    }

    /// Parses a rendered profile; any defect is an error, never a panic.
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut lines = text.lines();
        if lines.next() != Some(HEADER) {
            return Err("not a version-1 Trier profile".into());
        }
        let mut fields = std::collections::HashMap::new();
        let mut entries = Vec::new();
        let mut history = Vec::new();
        for line in lines.filter(|l| !l.is_empty()) {
            let (tag, rest) = line.split_once('\t').ok_or("line without a tab")?;
            match tag {
                "entry" | "history" => {
                    let e = parse_entry(rest)?;
                    if tag == "entry" {
                        entries.push(e);
                    } else {
                        history.push(e);
                    }
                }
                _ => {
                    fields.insert(tag.to_string(), rest.to_string());
                }
            }
        }
        let get = |k: &str| -> Result<String, String> {
            fields.get(k).cloned().ok_or_else(|| format!("missing {k}"))
        };
        Ok(Self {
            decoder: get("decoder")?,
            registry: get("registry")?,
            hardware: HardwareKey {
                arch: get("arch")?,
                features: get("features")?,
                processor: get("processor")?,
                clusters: get("clusters")?,
                cores: get("cores")?.parse().map_err(|_| "bad cores")?,
                os: get("os")?,
            },
            entries,
            history,
        })
    }

    /// Loads the profile at `path` for this decoder and `hardware`.
    pub fn load(path: &Path, hardware: &HardwareKey) -> Load {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Load::Missing,
            Err(e) => return Load::Invalid(e.to_string()),
        };
        let p = match Self::parse(&text) {
            Ok(p) => p,
            Err(why) => return Load::Invalid(why),
        };
        if p.decoder != DECODER_VERSION {
            return Load::Stale(format!("made by {}, running {DECODER_VERSION}", p.decoder));
        }
        if p.registry != registry_hash() {
            return Load::Stale("the kit registry changed".into());
        }
        if p.hardware.os != hardware.os {
            return Load::Stale(format!(
                "the OS changed ({} -> {})",
                p.hardware.os, hardware.os
            ));
        }
        if p.hardware != *hardware {
            return Load::Stale("the hardware differs".into());
        }
        Load::Valid(p)
    }

    /// Writes the profile atomically: a temporary file beside it, flushed to
    /// storage, then renamed over the old one.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        use std::io::Write;
        let tmp = path.with_extension("tmp");
        {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(self.render().as_bytes())?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, path)
    }
}

fn parse_entry(rest: &str) -> Result<Entry, String> {
    let mut m = std::collections::HashMap::new();
    for kv in rest.split('\t') {
        let (k, v) = kv.split_once('=').ok_or("field without =")?;
        m.insert(k, v);
    }
    let get = |k: &str| -> Result<&str, String> {
        m.get(k)
            .copied()
            .ok_or_else(|| format!("entry without {k}"))
    };
    let num = |k: &str| -> Result<f64, String> { get(k)?.parse().map_err(|_| format!("bad {k}")) };
    Ok(Entry {
        class: get("class")?.into(),
        policy: Policy::parse(get("policy")?).ok_or("bad policy")?,
        config: Config::parse(get("config")?).ok_or("bad config")?,
        change: num("change")?,
        noise: num("noise")?,
        trials: get("trials")?.parse().map_err(|_| "bad trials")?,
        stability: get("stability")?.into(),
        date: get("date")?.into(),
        conditions: get("conditions")?.into(),
        source: get("source")?.into(),
        degradations: get("degradations")?
            .parse()
            .map_err(|_| "bad degradations")?,
        // Absent in profiles written before the floor existed.
        floor: m.get("floor").and_then(|v| v.parse().ok()).unwrap_or(1),
    })
}

/// Field text without the separators (tabs, newlines, '=').
fn clean(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c == '\t' || c == '\n' || c == '\r' || c == '=' {
                ' '
            } else {
                c
            }
        })
        .collect()
}

/// The current UTC time in ISO 8601 (no external clock crate).
pub fn utc_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trier_video::kit::KitId;

    fn key() -> HardwareKey {
        HardwareKey {
            arch: "aarch64".into(),
            features: "neon,dotprod".into(),
            processor: "SUN".into(),
            clusters: "6x3532800/765,2x4473600/1024".into(),
            cores: 8,
            os: "Android 15 (SDK 35)".into(),
        }
    }
    fn entry(class: &str, policy: Policy, workers: usize) -> Entry {
        Entry {
            class: class.into(),
            policy,
            config: Config {
                kit: KitId::Default,
                workers,
                adaptive: false,
            },
            change: -0.2165,
            noise: 0.0089,
            trials: 32,
            stability: "repeatable".into(),
            date: "2026-10-21T04:00:00Z".into(),
            conditions: "battery 59%, 42 C".into(),
            source: "bench".into(),
            degradations: 0,
            floor: 1,
        }
    }
    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("trier-profile-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join(name)
    }

    #[test]
    fn round_trips_and_applies_choices() {
        let mut p = Profile::new(key());
        p.record(entry("hd1080i", Policy::Balanced, 1));
        p.record(entry("hd1080i", Policy::Performance, 8));
        let path = temp("round.profile");
        p.save(&path).expect("saves");
        let Load::Valid(q) = Profile::load(&path, &key()) else {
            panic!("valid profile");
        };
        assert_eq!(p, q);
        assert_eq!(
            q.choice("hd1080i", Policy::Balanced)
                .map(|e| e.config.workers),
            Some(1)
        );
        assert!(q.choice("sdi", Policy::Balanced).is_none());
    }

    /// Any damage to the file falls back to the known-good configuration
    /// and never panics.
    #[test]
    fn corruption_falls_back() {
        let mut p = Profile::new(key());
        p.record(entry("sdi", Policy::Efficiency, 1));
        let text = p.render();
        let path = temp("corrupt.profile");
        for cut in (0..text.len()).step_by(7) {
            std::fs::write(&path, &text.as_bytes()[..cut]).expect("write");
            match Profile::load(&path, &key()) {
                Load::Valid(q) => assert!(q.entries.len() <= 1),
                Load::Invalid(_) | Load::Stale(_) | Load::Missing => {}
            }
        }
        for junk in [
            "",
            "garbage",
            "trier-autotune-profile 2\n",
            "trier-autotune-profile 1\nentry\tclass=x\n",
        ] {
            std::fs::write(&path, junk).expect("write");
            assert!(
                matches!(Profile::load(&path, &key()), Load::Invalid(_)),
                "{junk:?}"
            );
        }
        assert_eq!(
            Profile::load(&temp("absent.profile"), &key()),
            Load::Missing
        );
    }

    /// A decoder update, a registry change, a different device or a new OS
    /// version makes the profile stale.
    #[test]
    fn changes_make_it_stale() {
        let p = Profile::new(key());
        let path = temp("stale.profile");
        p.save(&path).expect("saves");
        let mut other = key();
        other.processor = "KONA".into();
        assert!(matches!(Profile::load(&path, &other), Load::Stale(_)));
        let mut newer_os = key();
        newer_os.os = "Android 16 (SDK 36)".into();
        assert!(matches!(Profile::load(&path, &newer_os), Load::Stale(w) if w.contains("OS")));
        let mut old = p.clone();
        old.decoder = "trier-video 2026.10.01".into();
        old.save(&path).expect("saves");
        assert!(matches!(Profile::load(&path, &key()), Load::Stale(w) if w.contains("running")));
        let mut moved = p.clone();
        moved.registry = "0000000000000000".into();
        moved.save(&path).expect("saves");
        assert!(matches!(Profile::load(&path, &key()), Load::Stale(w) if w.contains("registry")));
    }

    /// A failed save leaves the previous profile intact, and a leftover
    /// temporary file does not affect loading.
    #[test]
    fn saving_is_atomic() {
        let mut p = Profile::new(key());
        p.record(entry("sdi", Policy::Balanced, 1));
        let path = temp("atomic.profile");
        p.save(&path).expect("saves");
        std::fs::write(path.with_extension("tmp"), "half a prof").expect("leftover");
        assert!(matches!(Profile::load(&path, &key()), Load::Valid(_)));
        let missing_dir = temp("no-such-dir").join("x.profile");
        assert!(p.save(&missing_dir).is_err());
        assert!(matches!(Profile::load(&path, &key()), Load::Valid(_)));
    }

    /// Unstable choices and choices with repeated playback pressure are not
    /// applied; history is kept and bounded.
    #[test]
    fn unusable_choices_and_history() {
        let mut p = Profile::new(key());
        let mut e = entry("hd1080i", Policy::Performance, 7);
        e.stability = "unstable".into();
        p.record(e);
        assert!(p.choice("hd1080i", Policy::Performance).is_none());
        p.record(entry("hd1080i", Policy::Balanced, 1));
        assert!(!p.note_degradation("hd1080i", Policy::Balanced));
        assert!(!p.note_degradation("hd1080i", Policy::Balanced));
        assert!(p.note_degradation("hd1080i", Policy::Balanced));
        assert!(p.choice("hd1080i", Policy::Balanced).is_none());
        for w in 0..30 {
            p.record(entry("sdi", Policy::Efficiency, 1 + w % 4));
        }
        assert_eq!(
            p.history.iter().filter(|e| e.class == "sdi").count(),
            HISTORY
        );
        assert_eq!(p.entries.iter().filter(|e| e.class == "sdi").count(), 1);
    }

    /// A choice that missed its deadline share in playback is retired at once
    /// and raises the floor, which survives recalibration.
    #[test]
    fn playback_failures_raise_the_floor() {
        let mut p = Profile::new(key());
        p.record(entry("hd720p", Policy::Balanced, 1));
        assert_eq!(
            p.record_playback_failure("hd720p", Policy::Balanced, 4),
            Some(2)
        );
        assert!(p.choice("hd720p", Policy::Balanced).is_none());
        assert_eq!(p.floor("hd720p", Policy::Balanced), 2);
        let mut again = entry("hd720p", Policy::Balanced, 2);
        again.floor = p.floor("hd720p", Policy::Balanced);
        p.record(again);
        assert!(p.choice("hd720p", Policy::Balanced).is_some());
        assert_eq!(
            p.record_playback_failure("hd720p", Policy::Balanced, 4),
            Some(3)
        );
        // A choice already at the ceiling is kept: nothing higher to try.
        let mut top = entry("hd1080i", Policy::Balanced, 4);
        top.floor = 4;
        p.record(top);
        assert_eq!(
            p.record_playback_failure("hd1080i", Policy::Balanced, 4),
            None
        );
        assert!(p.choice("hd1080i", Policy::Balanced).is_some());
        let text = p.render();
        assert_eq!(Profile::parse(&text).expect("parses"), p);
        // Older profiles without the field read as floor 1.
        // The floor is each line's last field: cut it off every line.
        let old: String = text
            .lines()
            .map(|l| l.split("\tfloor=").next().unwrap_or(l))
            .map(|l| format!("{l}\n"))
            .collect();
        assert!(Profile::parse(&old)
            .expect("parses")
            .entries
            .iter()
            .all(|e| e.floor == 1));
    }

    /// The key does not change when Android takes cores on or offline.
    #[test]
    fn the_key_ignores_cores_going_offline() {
        use crate::trier_video::platform::Cluster;
        let mut m = Machine::detect();
        m.clusters = vec![
            Cluster {
                max_khz: 1_804_800,
                capacity: Some(351),
                cpus: vec![0, 1, 2, 3],
            },
            Cluster {
                max_khz: 2_419_200,
                capacity: Some(871),
                cpus: vec![4, 5, 6],
            },
            Cluster {
                max_khz: 2_841_600,
                capacity: Some(1024),
                cpus: vec![7],
            },
        ];
        m.usable_cores = 6;
        let a = HardwareKey::of(&m, "Android 13 (SDK 33)");
        m.usable_cores = 7;
        let b = HardwareKey::of(&m, "Android 13 (SDK 33)");
        assert_eq!(a, b);
        assert_eq!(a.cores, 8);
    }

    #[test]
    fn classes_and_dates() {
        assert_eq!(workload_class(720, 480, false), "sdi");
        assert_eq!(workload_class(1280, 720, true), "hd720p");
        assert_eq!(workload_class(1920, 1080, false), "hd1080i");
        assert_eq!(workload_class(3840, 2160, true), "uhdp");
        assert_eq!(workload_class(1440, 1080, false), "hd1080i");
        assert_eq!(workload_class(1280, 544, true), "hd720p");
        let now = utc_now();
        assert!(
            now.len() == 20 && now.ends_with('Z') && now.starts_with("20"),
            "{now}"
        );
    }
}
