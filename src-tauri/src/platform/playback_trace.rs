// Copyright 2026 Doug Trier
// SPDX-License-Identifier: Apache-2.0
//! Opt-in, bounded playback evidence. No source identities, addresses or free text.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
const LIMIT: usize = 800;
const BYTE_LIMIT: usize = 1024 * 1024;
const DURATION_MS: u64 = 15 * 60 * 1000;
static ACTIVE: OnceLock<Arc<Store>> = OnceLock::new();
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|t| t.as_millis() as u64)
        .unwrap_or(0)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Record {
    pub mode: String,
    pub event: String,
    #[serde(default)]
    pub values: BTreeMap<String, serde_json::Value>,
}
#[derive(Clone, Copy)]
enum RejectionStage {
    Command,
    NativeGeometry,
    WebGeometry,
    Save,
}
impl RejectionStage {
    fn token(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::NativeGeometry => "native-geometry",
            Self::WebGeometry => "web-geometry",
            Self::Save => "save",
        }
    }
}
#[derive(Clone, Copy)]
enum RejectionReason {
    Value,
    Count,
    Event,
    Type,
    Range,
    UnknownField,
    Storage,
}
impl RejectionReason {
    fn token(self) -> &'static str {
        match self {
            Self::Value => "value",
            Self::Count => "count",
            Self::Event => "event",
            Self::Type => "type",
            Self::Range => "range",
            Self::UnknownField => "unknown-field",
            Self::Storage => "storage",
        }
    }
}
fn rejection_line(stage: RejectionStage, field: &'static str, reason: RejectionReason) -> String {
    format!(
        "[GenX playback-trace] rejected stage={} field={field} reason={}",
        stage.token(),
        reason.token()
    )
}
fn invalid_record(
    stage: Option<RejectionStage>,
    field: &'static str,
    reason: RejectionReason,
) -> String {
    if let Some(stage) = stage {
        eprintln!("{}", rejection_line(stage, field, reason));
    }
    "playback-trace-invalid".into()
}
impl Record {
    fn validate(&self) -> Result<(), String> {
        self.validate_at(None)
    }
    fn validate_at(&self, stage: Option<RejectionStage>) -> Result<(), String> {
        if !["free", "paid", "genxtra", "web", "application"].contains(&self.mode.as_str()) {
            return Err(invalid_record(stage, "mode", RejectionReason::Value));
        }
        if ![
            "sample",
            "state",
            "geometry",
            "native-geometry",
            "web-geometry",
            "navigation",
            "relay-error",
            "relay-end",
            "decoder-error",
            "warning",
            "delivery",
            "source-choice",
            "recovery",
            "error",
        ]
        .contains(&self.event.as_str())
        {
            return Err(invalid_record(stage, "event", RejectionReason::Value));
        }
        if self.values.len() > 48 {
            return Err(invalid_record(stage, "values", RejectionReason::Count));
        }
        let startup = self
            .values
            .get("initiator")
            .and_then(|value| value.as_str())
            == Some("startup");
        let has_startup =
            self.values.contains_key("startupPhase") || self.values.contains_key("startupReason");
        if (startup || has_startup)
            && (!startup
                || self.mode != "genxtra"
                || self.event != "error"
                || !self.values.contains_key("startupPhase")
                || !self.values.contains_key("startupReason"))
        {
            return Err(invalid_record(stage, "initiator", RejectionReason::Event));
        }
        const NUMBERS: &[&str] = &[
            "channelSequence",
            "candidateCount",
            "videoWidth",
            "videoHeight",
            "totalFrames",
            "renderedFrames",
            "droppedFrames",
            "bufferedAheadMs",
            "positionMs",
            "streamMs",
            "streamBufferedMs",
            "windowDurationMs",
            "windowDefaultPositionMs",
            "windowStartMs",
            "targetLiveOffsetMs",
            "liveOffsetMs",
            "bandwidthEstimate",
            "ttfbEstimate",
            "dpr",
            "density",
            "webViewScale",
            "sdk",
            "httpStatus",
            "elapsedMs",
            "receivedBytes",
            "frameRate",
            "frontendDroppedEvents",
            "nativeErrorCode",
            "liveWindowRecoveries",
            "nativeSession",
            "mediaErrorCode",
            "mediaStartMs",
            "mediaDurationMs",
            "fragmentSequence",
            "nativeElapsedMs",
            "deliveryOverheadMs",
            "selectedLevel",
            "availableLevelCount",
            "renditionBitrate",
            "incomingMediaBitsPerSecond",
            "bufferTargetSeconds",
        ];
        const FLAGS: &[&str] = &[
            "visible",
            "sourceChanged",
            "autoQuality",
            "playing",
            "paused",
            "fullscreen",
            "expanded",
            "native",
            "aligned",
            "surfaceContained",
            "surfaceAligned",
            "timeout",
            "bodyError",
            "connectError",
            "responseStarted",
            "separateProcess",
            "pixelPositionVerified",
            "mainFrame",
            "layoutPending",
            "manualBuffer",
        ];
        const RECTS: &[&str] = &[
            "expectedCss",
            "actualCss",
            "viewport",
            "webViewNative",
            "expectedPlayerNative",
            "playerNative",
            "surfaceNative",
            "expectedSurfaceNative",
            "surfaceDeltaNative",
            "deltaNative",
            "displaySize",
        ];
        for (key, value) in &self.values {
            // Return a reviewed static token, never the input key or value.
            let field = NUMBERS
                .iter()
                .chain(FLAGS)
                .chain(RECTS)
                .chain(&[
                    "initiator",
                    "loaderKind",
                    "exceptionKind",
                    "libraryErrorType",
                    "loaderCode",
                    "readyState",
                    "networkState",
                    "ownerAborted",
                    "startupPhase",
                    "startupReason",
                    "state",
                    "engine",
                    "container",
                    "transport",
                    "detail",
                    "code",
                    "phase",
                    "authorityPhase",
                    "authorityReason",
                    "evidence",
                ])
                .find(|token| **token == key.as_str())
                .copied()
                .unwrap_or("unknown");
            if matches!(
                key.as_str(),
                "initiator"
                    | "loaderKind"
                    | "exceptionKind"
                    | "libraryErrorType"
                    | "loaderCode"
                    | "readyState"
                    | "networkState"
                    | "ownerAborted"
            ) && self.event != "error"
            {
                return Err(invalid_record(stage, field, RejectionReason::Event));
            }
            let integer_range = match key.as_str() {
                "loaderCode" => Some(-1..=999),
                "readyState" => Some(0..=4),
                "networkState" => Some(0..=3),
                _ => None,
            };
            if let Some(range) = integer_range {
                if value.as_i64().is_some_and(|n| range.contains(&n)) {
                    continue;
                }
                return Err(invalid_record(
                    stage,
                    field,
                    if value.is_number() {
                        RejectionReason::Range
                    } else {
                        RejectionReason::Type
                    },
                ));
            }
            if key == "ownerAborted" {
                if value.is_boolean() {
                    continue;
                }
                return Err(invalid_record(stage, field, RejectionReason::Type));
            }
            if matches!(
                key.as_str(),
                "incomingMediaBitsPerSecond" | "bufferTargetSeconds" | "manualBuffer"
            ) && !matches!(self.event.as_str(), "sample" | "native-geometry")
            {
                return Err(invalid_record(stage, field, RejectionReason::Event));
            }
            if matches!(
                key.as_str(),
                "incomingMediaBitsPerSecond" | "bufferTargetSeconds"
            ) {
                if value.is_null() {
                    continue;
                }
                let valid = value.as_f64().is_some_and(|number| {
                    number.is_finite()
                        && if key == "incomingMediaBitsPerSecond" {
                            (0.0..=1.0e12).contains(&number)
                        } else {
                            (1.0..=20.0).contains(&number)
                                && (self
                                    .values
                                    .get("manualBuffer")
                                    .and_then(|value| value.as_bool())
                                    != Some(true)
                                    || number.fract() == 0.0)
                        }
                });
                if valid {
                    continue;
                }
                return Err(invalid_record(
                    stage,
                    field,
                    if value.is_number() {
                        RejectionReason::Range
                    } else {
                        RejectionReason::Type
                    },
                ));
            }
            if value.is_null() && (NUMBERS.contains(&key.as_str()) || RECTS.contains(&key.as_str()))
            {
                continue;
            }
            if NUMBERS.contains(&key.as_str())
                && value.as_f64().is_some_and(|n| {
                    n.is_finite() && (-1000.0..=9_007_199_254_740_991.0).contains(&n)
                })
            {
                continue;
            }
            if FLAGS.contains(&key.as_str()) && value.is_boolean() {
                continue;
            }
            if RECTS.contains(&key.as_str())
                && value.as_array().is_some_and(|a| {
                    (2..=4).contains(&a.len())
                        && a.iter().all(|v| {
                            v.as_f64().is_some_and(|n| {
                                n.is_finite() && (-16_384.0..=16_384.0).contains(&n)
                            })
                        })
                })
            {
                continue;
            }
            let allowed: &[&str] = match key.as_str() {
                "initiator" => &["engine", "startup"],
                "startupPhase" => &[
                    "release",
                    "guide",
                    "before-start",
                    "allocate",
                    "bookmark",
                    "resume-choice",
                    "bookmark-reset",
                    "decode",
                    "resume-seek",
                    "unknown",
                ],
                "startupReason" => &[
                    "destination",
                    "path",
                    "dns",
                    "encoding",
                    "format",
                    "codec",
                    "inspection",
                    "configuration",
                    "range",
                    "access",
                    "rate-limit",
                    "network",
                    "stale",
                    "unavailable",
                    "cleanup",
                    "local-copy",
                    "unknown",
                    "cancelled",
                    "archive-request-timeout",
                    "archive-dns-unavailable",
                    "archive-network-unavailable",
                    "archive-rate-limited",
                    "archive-server-unavailable",
                    "archive-response-refused",
                    "archive-response-limit",
                    "archive-metadata-invalid",
                    "storage-busy",
                    "storage-locked",
                    "storage-full",
                    "storage-failed",
                    "worker-failed",
                    "bookmark-stale",
                    "bookmark-unproven",
                    "bookmark-failed",
                    "bookmark-unavailable",
                ],
                "loaderKind" => &[
                    "fetch-stream",
                    "xhr-range",
                    "moz-chunked",
                    "websocket",
                    "unknown",
                ],
                "exceptionKind" => &[
                    "fetch-failed",
                    "network-error",
                    "aborted",
                    "timeout",
                    "arraybuffer-allocation",
                    "typedarray-bounds",
                    "dataview-bounds",
                    "memory",
                    "type-error",
                    "unknown",
                ],
                "libraryErrorType" => &["network", "media", "unknown"],
                "state" => &[
                    "idle",
                    "connecting",
                    "buffering",
                    "playing",
                    "reconnecting",
                    "paused",
                    "failed",
                    "disposed",
                    "ready",
                    "ended",
                    "error",
                    "closed",
                    "open",
                    "hidden",
                    "unknown",
                ],
                "engine" => &["webview", "media3", "web-page", "desktop", "unknown"],
                "container" => &["hls", "media", "unknown"],
                "transport" => &["mpegts", "hls", "html5"],
                "detail" => &[
                    "network-exception",
                    "equivalence-unavailable",
                    "source-selected",
                    "http-status",
                    "connect-timeout",
                    "early-eof",
                    "mse-error",
                    "format-error",
                    "unsupported-format",
                    "unsupported-codec",
                    "manifest-error",
                    "manifest-timeout",
                    "playlist-error",
                    "playlist-timeout",
                    "segment-error",
                    "segment-timeout",
                    "buffer-stalled",
                    "buffer-gap",
                    "buffer-nudge",
                    "buffer-full",
                    "segment-gap",
                    "playlist-empty",
                    "playlist-unchanged",
                    "mse-no-progress",
                    "allocation-error",
                    "internal-exception",
                    "attach-error",
                    "mse-reset",
                    "cancelled",
                    "audio-track-error",
                    "audio-track-timeout",
                    "subtitle-track-error",
                    "subtitle-track-timeout",
                    "decrypt-error",
                    "key-error",
                    "key-timeout",
                    "asset-error",
                    "asset-timeout",
                    "unknown",
                ],
                "code" => &[
                    "authority",
                    "network",
                    "dns",
                    "tls",
                    "timeout",
                    "body-error",
                    "connection-reset",
                    "read-timeout",
                    "upstream-eof",
                    "consumer-closed",
                    "write-timeout",
                    "write-error",
                    "decode",
                    "unsupported",
                    "missing",
                    "access",
                    "policy",
                    "unknown",
                    "cancelled",
                    "inspection-unavailable",
                ],
                "phase" => &[
                    "startup-progress",
                    "buffering-progress",
                    "decode",
                    "capability",
                    "connect",
                    "headers",
                    "body",
                    "unknown",
                ],
                "authorityPhase" => &[
                    "generation-before",
                    "live-verify",
                    "live-snapshot",
                    "live-reference",
                    "generation-after",
                    "vod-verify",
                    "callback",
                    "task",
                ],
                "authorityReason" => AUTHORITY_REASONS,
                "evidence" => &[
                    "native",
                    "http",
                    "media",
                    "opaque",
                    "progress",
                    "observed-progress",
                    "unknown",
                ],
                _ => &[],
            };
            if value.as_str().is_some_and(|s| allowed.contains(&s)) {
                continue;
            }
            let reason = if field == "unknown" {
                RejectionReason::UnknownField
            } else if NUMBERS.contains(&key.as_str()) {
                if value.is_number() {
                    RejectionReason::Range
                } else {
                    RejectionReason::Type
                }
            } else if FLAGS.contains(&key.as_str()) {
                RejectionReason::Type
            } else if RECTS.contains(&key.as_str()) {
                if value.is_array() {
                    RejectionReason::Range
                } else {
                    RejectionReason::Type
                }
            } else if value.is_string() {
                RejectionReason::Value
            } else {
                RejectionReason::Type
            };
            return Err(invalid_record(stage, field, reason));
        }
        Ok(())
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    timestamp_ms: u64,
    elapsed_ms: u64,
    record: Record,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Report {
    schema_version: u8,
    version: String,
    build: u64,
    platform: String,
    active: bool,
    started_at_ms: u64,
    until_ms: u64,
    dropped_events: usize,
    records: VecDeque<Entry>,
}
pub(crate) struct Store {
    path: PathBuf,
    data: Mutex<Report>,
    version: String,
    build: u64,
}
impl Store {
    pub fn new(path: PathBuf, version: &str) -> Self {
        let parts: Vec<u64> = version.split('.').map(|s| s.parse().unwrap_or(0)).collect();
        let build = parts.first().unwrap_or(&0) * 1_000_000
            + parts.get(1).unwrap_or(&0) * 1000
            + parts.get(2).unwrap_or(&0);
        let fresh = Report {
            schema_version: 1,
            version: version.into(),
            build,
            platform: std::env::consts::OS.into(),
            active: false,
            started_at_ms: 0,
            until_ms: 0,
            dropped_events: 0,
            records: VecDeque::new(),
        };
        let previous = std::fs::metadata(&path)
            .ok()
            .filter(|m| m.is_file() && m.len() <= BYTE_LIMIT as u64)
            .and_then(|_| std::fs::read(&path).ok())
            .and_then(|b| serde_json::from_slice::<Report>(&b).ok())
            .filter(|r| {
                r.schema_version == 1
                    && r.records.len() <= LIMIT
                    && r.records.iter().all(|e| e.record.validate().is_ok())
            });
        let mut report = previous.unwrap_or(fresh);
        report.active = false;
        report.until_ms = 0;
        Self {
            path,
            data: Mutex::new(report),
            version: version.into(),
            build,
        }
    }
    fn save(&self, report: &mut Report) -> Result<(), String> {
        self.save_inner(report).inspect_err(|_| {
            eprintln!(
                "{}",
                rejection_line(RejectionStage::Save, "storage", RejectionReason::Storage)
            );
        })
    }
    fn save_inner(&self, report: &mut Report) -> Result<(), String> {
        let parent = self.path.parent().ok_or("playback-trace-path")?;
        std::fs::create_dir_all(parent).map_err(|_| "playback-trace-write")?;
        let mut bytes = serde_json::to_vec(report).map_err(|_| "playback-trace-encode")?;
        while bytes.len() > BYTE_LIMIT && !report.records.is_empty() {
            report.records.pop_front();
            report.dropped_events += 1;
            bytes = serde_json::to_vec(report).map_err(|_| "playback-trace-encode")?;
        }
        let mut file =
            tempfile::NamedTempFile::new_in(parent).map_err(|_| "playback-trace-write")?;
        file.write_all(&bytes).map_err(|_| "playback-trace-write")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "playback-trace-write")?;
        file.persist(&self.path)
            .map_err(|_| "playback-trace-write")?;
        Ok(())
    }
    fn enabled(&self) -> bool {
        self.data
            .lock()
            .is_ok_and(|r| r.active && now() < r.until_ms)
    }
    fn record(&self, record: Record) -> Result<(), String> {
        self.record_at(record, RejectionStage::Save)
    }
    fn record_at(&self, record: Record, stage: RejectionStage) -> Result<(), String> {
        record.validate_at(Some(stage))?;
        let mut report = self.data.lock().map_err(|_| "playback-trace-lock")?;
        if !report.active || now() >= report.until_ms {
            report.active = false;
            return Ok(());
        }
        let at = now();
        let elapsed = at.saturating_sub(report.started_at_ms);
        report.records.push_back(Entry {
            timestamp_ms: at,
            elapsed_ms: elapsed,
            record,
        });
        if report.records.len() > LIMIT {
            report.records.pop_front();
            report.dropped_events += 1;
        }
        self.save(&mut report)
    }
    fn action(&self, action: &str) -> Result<serde_json::Value, String> {
        let mut r = self.data.lock().map_err(|_| "playback-trace-lock")?;
        if now() >= r.until_ms {
            r.active = false;
        }
        match action {
            "start" => {
                r.version = self.version.clone();
                r.build = self.build;
                r.records.clear();
                r.dropped_events = 0;
                r.started_at_ms = now();
                r.until_ms = r.started_at_ms + DURATION_MS;
                r.active = true;
                self.save(&mut r)?;
            }
            "stop" => {
                r.active = false;
                r.until_ms = 0;
                self.save(&mut r)?;
            }
            "clear" => {
                r.active = false;
                r.version = self.version.clone();
                r.build = self.build;
                r.started_at_ms = 0;
                r.until_ms = 0;
                r.records.clear();
                r.dropped_events = 0;
                self.save(&mut r)?;
            }
            "read" => {}
            _ => return Err("playback-trace-invalid".into()),
        }
        serde_json::to_value(&*r).map_err(|_| "playback-trace-encode".into())
    }
}
pub(crate) fn initialize(store: Arc<Store>) {
    let _ = ACTIVE.set(store);
}

/// Fixed diagnostic vocabulary only. Never retain the callback's raw error,
/// account/reference identity, provider address or storage path.
const AUTHORITY_REASONS: &[&str] = &[
    "session-replaced",
    "canceled",
    "application-closing",
    "storage-not-ready",
    "root-changed",
    "storage-lock",
    "request-lock",
    "storage-worker",
    "storage-busy",
    "storage-admission-timeout",
    "storage-locked",
    "storage-full",
    "storage-operation",
    "account-storage",
    "media-storage",
    "preferences-storage",
    "account-removed",
    "account-sign-in",
    "account-origin",
    "account-revision",
    "media-revision",
    "media-reference",
    "account-snapshot",
    "media-snapshot",
    "channel-removed",
    "media-not-collected",
    "media-invalid",
    "reference-invalid",
    "task-lost",
    "unknown",
];

#[derive(Clone, Copy)]
pub(crate) enum AuthorityMode {
    Free,
    Paid,
}
impl AuthorityMode {
    fn token(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Paid => "paid",
        }
    }
}
#[derive(Clone, Copy)]
pub(crate) enum AuthorityPhase {
    GenerationBefore,
    LiveVerify,
    LiveSnapshot,
    LiveReference,
    GenerationAfter,
    VodVerify,
    Callback,
    Task,
}
impl AuthorityPhase {
    fn token(self) -> &'static str {
        match self {
            Self::GenerationBefore => "generation-before",
            Self::LiveVerify => "live-verify",
            Self::LiveSnapshot => "live-snapshot",
            Self::LiveReference => "live-reference",
            Self::GenerationAfter => "generation-after",
            Self::VodVerify => "vod-verify",
            Self::Callback => "callback",
            Self::Task => "task",
        }
    }
}
fn authority_reason(error: &str) -> &'static str {
    match error {
        "account-playback-session-replaced" => "session-replaced",
        "canceled" => "canceled",
        "application-closing" => "application-closing",
        "storage-not-ready" | "storage-initializing" => "storage-not-ready",
        "scan-manifest-root-changed" => "root-changed",
        "storage-lock" => "storage-lock",
        "request-lock" => "request-lock",
        "scan-manifest-worker-failed" | "storage-worker-failed" => "storage-worker",
        "sqlite-busy" => "storage-busy",
        "account-authority-read-admission-timeout" => "storage-admission-timeout",
        "sqlite-locked" => "storage-locked",
        "sqlite-storage-full" => "storage-full",
        "sqlite-operation-failed" => "storage-operation",
        "account-catalog-storage-failed" | "account-vault-storage-failed" => "account-storage",
        "account-media-storage-failed" => "media-storage",
        "account-preferences-storage-failed" => "preferences-storage",
        "account-removed" => "account-removed",
        "account-sign-in-required" => "account-sign-in",
        "account-origin-refused" => "account-origin",
        "account-revision-conflict" => "account-revision",
        "account-media-revision-conflict" => "media-revision",
        "account-media-reference-revoked" => "media-reference",
        "account-authority-account-changed" => "account-snapshot",
        "account-authority-media-changed" => "media-snapshot",
        "account-channel-removed" => "channel-removed",
        "account-media-not-collected" => "media-not-collected",
        "account-media-invalid" => "media-invalid",
        "account-reference-invalid" => "reference-invalid",
        "account-authority-task-lost" => "task-lost",
        _ => "unknown",
    }
}
fn authority_failure_record(
    mode: AuthorityMode,
    phase: AuthorityPhase,
    error: &str,
) -> (Record, String) {
    let reason = authority_reason(error);
    let phase = phase.token();
    let line = format!(
        "[GenX authority] mode={} phase={phase} reason={reason}",
        mode.token()
    );
    (
        Record {
            mode: mode.token().into(),
            event: "relay-error".into(),
            values: BTreeMap::from([
                ("code".into(), "authority".into()),
                ("authorityPhase".into(), phase.into()),
                ("authorityReason".into(), reason.into()),
            ]),
        },
        line,
    )
}
/// Observation only: the caller still returns its original authority refusal.
pub(crate) fn native_authority_failure(mode: AuthorityMode, phase: AuthorityPhase, error: &str) {
    let (record, line) = authority_failure_record(mode, phase, error);
    eprintln!("{line}");
    if let Some(store) = ACTIVE.get().filter(|s| s.enabled()) {
        let _ = store.record(record);
    }
}
fn upstream_refusal_record(status: u16) -> Option<(Record, String)> {
    if !(100..=599).contains(&status) {
        return None;
    }
    Some((
        Record {
            // Opening a provider response has no retained presentation owner.
            // This is an application transport fact, not an inferred mode.
            mode: "application".into(),
            event: "relay-error".into(),
            values: BTreeMap::from([
                ("code".into(), "unknown".into()),
                ("phase".into(), "headers".into()),
                ("evidence".into(), "http".into()),
                ("httpStatus".into(), status.into()),
                ("responseStarted".into(), false.into()),
            ]),
        },
        format!("[GenX relay] upstream_refused status={status}"),
    ))
}
/// A numeric provider response, before any local proxy status is generated.
pub(crate) fn native_upstream_refusal(status: u16) {
    let Some((record, line)) = upstream_refusal_record(status) else {
        return;
    };
    eprintln!("{line}");
    if let Some(store) = ACTIVE.get().filter(|s| s.enabled()) {
        let _ = store.record(record);
    }
}
pub(crate) fn native_hls_delivery(bytes: usize, elapsed_ms: f64, status: u16) {
    let Some(store) = ACTIVE.get().filter(|s| s.enabled()) else {
        return;
    };
    let _ = store.record(Record {
        mode: "free".into(),
        event: "delivery".into(),
        values: BTreeMap::from([
            ("engine".into(), "media3".into()),
            ("transport".into(), "hls".into()),
            ("receivedBytes".into(), bytes.into()),
            ("nativeElapsedMs".into(), elapsed_ms.into()),
            ("httpStatus".into(), status.into()),
        ]),
    });
}
pub(crate) fn native_failure(
    mode: &str,
    code: &str,
    timeout: bool,
    body_error: bool,
    response_started: bool,
) {
    let Some(store) = ACTIVE.get().filter(|s| s.enabled()) else {
        return;
    };
    let mapped = if code.contains("consumer-closed") {
        "consumer-closed"
    } else if code.contains("write-timeout") {
        "write-timeout"
    } else if code.contains("write-failed") {
        "write-error"
    } else if code.contains("dns") {
        "dns"
    } else if timeout {
        "read-timeout"
    } else if code.contains("network") {
        "network"
    } else if code.contains("timeout") {
        "timeout"
    } else {
        "unknown"
    };
    let values = BTreeMap::from([
        ("code".into(), mapped.into()),
        ("timeout".into(), timeout.into()),
        ("bodyError".into(), body_error.into()),
        ("responseStarted".into(), response_started.into()),
    ]);
    let _ = store.record(Record {
        mode: mode.into(),
        event: "relay-error".into(),
        values,
    });
}
pub(crate) fn upstream_end(mode: &str, received: usize, elapsed_ms: u64) {
    let Some(store) = ACTIVE.get().filter(|s| s.enabled()) else {
        return;
    };
    let _ = store.record(Record {
        mode: mode.into(),
        event: "relay-end".into(),
        values: BTreeMap::from([
            ("code".into(), "upstream-eof".into()),
            ("receivedBytes".into(), received.into()),
            ("elapsedMs".into(), elapsed_ms.into()),
        ]),
    });
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    action: String,
    record: Option<Record>,
}
#[tauri::command]
pub(crate) async fn playback_trace(
    request: Request,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    if !["start", "stop", "clear", "read", "record"].contains(&request.action.as_str())
        || (request.action == "record") != request.record.is_some()
    {
        return Err("playback-trace-invalid".into());
    }
    let work = app.state::<crate::NativeState>().admit_work()?;
    let store = app.state::<Arc<Store>>().inner().clone();
    if let Some(record) = request.record {
        record.validate_at(Some(RejectionStage::Command))?;
        let mode = record.mode.clone();
        let sample = record.event == "sample" && store.enabled();
        let native = if sample {
            crate::native_video::playback_diagnostics(&app).await
        } else {
            None
        };
        let web = if sample && mode == "web" {
            crate::web_page::playback_diagnostics(&app).await
        } else {
            None
        };
        tauri::async_runtime::spawn_blocking(move || {
            let _work = work;
            store.record(record)?;
            for (event, value, stage) in [
                ("native-geometry", native, RejectionStage::NativeGeometry),
                ("web-geometry", web, RejectionStage::WebGeometry),
            ] {
                if let Some(serde_json::Value::Object(values)) = value {
                    store.record_at(
                        Record {
                            mode: mode.clone(),
                            event: event.into(),
                            values: values.into_iter().collect(),
                        },
                        stage,
                    )?;
                }
            }
            Ok(serde_json::json!({"active":store.enabled(),"recorded":true}))
        })
        .await
        .map_err(|_| "playback-trace-worker".to_string())?
    } else {
        tauri::async_runtime::spawn_blocking(move || {
            let _work = work;
            store.action(&request.action)
        })
        .await
        .map_err(|_| "playback-trace-worker".to_string())?
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejection_diagnostics_keep_known_tokens_and_never_print_input() {
        let cases = [
            (
                serde_json::json!({"trace-private-fixture-key":"https://private.invalid/password"}),
                "unknown",
                RejectionReason::UnknownField,
            ),
            (
                serde_json::json!({"engine":"https://private.invalid/password"}),
                "engine",
                RejectionReason::Value,
            ),
            (
                serde_json::json!({"positionMs":"trace-private-fixture-value"}),
                "positionMs",
                RejectionReason::Type,
            ),
            (
                serde_json::json!({"actualCss":[0,0,99999,1]}),
                "actualCss",
                RejectionReason::Range,
            ),
            (
                serde_json::json!({"loaderCode":999.5}),
                "loaderCode",
                RejectionReason::Range,
            ),
            (
                serde_json::json!({"ownerAborted":"trace-private-fixture-value"}),
                "ownerAborted",
                RejectionReason::Type,
            ),
        ];
        for stage in [
            RejectionStage::Command,
            RejectionStage::NativeGeometry,
            RejectionStage::WebGeometry,
            RejectionStage::Save,
        ] {
            for (values, field, reason) in &cases {
                let record = engine_error(values.clone());
                assert_eq!(
                    record.validate_at(Some(stage)).unwrap_err(),
                    "playback-trace-invalid"
                );
                let expected_line = rejection_line(stage, field, *reason);
                assert!(expected_line.contains(&format!("stage={}", stage.token())));
                assert!(expected_line.contains(&format!("field={field}")));
                assert!(expected_line.contains(&format!("reason={}", reason.token())));
                assert!(!expected_line.contains("private") && !expected_line.contains("password"));
            }
        }
        let mut record = engine_error(serde_json::json!({"loaderCode":1}));
        record.event = "sample".into();
        assert_eq!(
            record
                .validate_at(Some(RejectionStage::Command))
                .unwrap_err(),
            "playback-trace-invalid"
        );
        record.mode = "https://private.invalid/password".into();
        assert_eq!(
            record
                .validate_at(Some(RejectionStage::Command))
                .unwrap_err(),
            "playback-trace-invalid"
        );
        record.mode = "paid".into();
        record.event = "trace-private-fixture-event".into();
        assert_eq!(
            record
                .validate_at(Some(RejectionStage::Command))
                .unwrap_err(),
            "playback-trace-invalid"
        );
        record.event = "error".into();
        record.values = (0..49)
            .map(|i| (format!("trace-private-fixture-{i}"), true.into()))
            .collect();
        assert_eq!(
            record
                .validate_at(Some(RejectionStage::Command))
                .unwrap_err(),
            "playback-trace-invalid"
        );
    }
    #[test]
    fn rejected_collected_geometry_does_not_append_and_save_errors_stay_fixed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("report.json");
        let store = Store::new(path.clone(), "0.1.23");
        store.action("start").unwrap();
        for (event, stage) in [
            ("native-geometry", RejectionStage::NativeGeometry),
            ("web-geometry", RejectionStage::WebGeometry),
        ] {
            let record = Record {
                mode: "paid".into(),
                event: event.into(),
                values: serde_json::from_value(serde_json::json!({"actualCss":[0,0,99999,1]}))
                    .unwrap(),
            };
            assert_eq!(
                store.record_at(record, stage).unwrap_err(),
                "playback-trace-invalid"
            );
            assert_eq!(
                store.action("read").unwrap()["records"]
                    .as_array()
                    .unwrap()
                    .len(),
                0
            );
        }
        let blocker = dir.path().join("trace-private-fixture-blocker");
        std::fs::write(&blocker, b"private").unwrap();
        let blocked = Store::new(blocker.join("report.json"), "0.1.23");
        assert_eq!(blocked.action("start").unwrap_err(), "playback-trace-write");
        assert!(!std::fs::read_to_string(path).unwrap().contains("private"));
    }
    #[test]
    fn upstream_http_refusal_persists_only_bounded_actual_status() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("upstream.json");
        let store = Store::new(path.clone(), "0.1.23");
        store.action("start").unwrap();
        for status in [100, 451, 456, 599] {
            let (record, line) = upstream_refusal_record(status).unwrap();
            assert_eq!(
                line,
                format!("[GenX relay] upstream_refused status={status}")
            );
            assert_eq!(record.mode, "application");
            assert_eq!(record.event, "relay-error");
            assert_eq!(record.values["httpStatus"], status);
            assert_eq!(record.values["phase"], "headers");
            assert_eq!(record.values["responseStarted"], false);
            assert_eq!(record.values.len(), 5);
            store.record(record).unwrap();
        }
        for status in [0, 99, 600, 999, u16::MAX] {
            assert!(upstream_refusal_record(status).is_none());
        }
        let persisted = std::fs::read_to_string(path).unwrap();
        for private in [
            "\"url\"",
            "X-Private-Header",
            "password",
            "https://",
            "stack",
            "message",
        ] {
            assert!(!persisted.contains(private));
        }
        let report = store.action("read").unwrap();
        assert_eq!(report["records"].as_array().unwrap().len(), 4);
        assert_eq!(report["records"][1]["record"]["values"]["httpStatus"], 451);
        assert_eq!(report["records"][2]["record"]["values"]["httpStatus"], 456);
    }
    fn engine_error(values: serde_json::Value) -> Record {
        Record {
            mode: "paid".into(),
            event: "error".into(),
            values: serde_json::from_value(values).unwrap(),
        }
    }
    #[test]
    fn engine_provenance_is_closed_bounded_and_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("engine.json");
        let store = Store::new(path.clone(), "0.1.23");
        store.action("start").unwrap();
        let record = engine_error(serde_json::json!({
            "initiator":"engine", "loaderKind":"fetch-stream",
            "exceptionKind":"typedarray-bounds", "libraryErrorType":"network",
            "loaderCode":-1, "readyState":4, "networkState":2,
            "ownerAborted":false, "mediaErrorCode":3, "transport":"mpegts",
            "positionMs":226590.5, "bufferedAheadMs":17406,
            "totalFrames":13443, "droppedFrames":11,
            "videoWidth":1920, "videoHeight":1080
        }));
        assert!(record.validate().is_ok());
        store.record(record).unwrap();
        let persisted = std::fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains("https://") && !persisted.contains("password"));
        let restarted = Store::new(path, "0.1.23");
        let report = restarted.action("read").unwrap();
        assert_eq!(report["active"], false);
        assert_eq!(
            report["records"][0]["record"]["values"]["initiator"],
            "engine"
        );
        assert_eq!(report["records"][0]["record"]["values"]["loaderCode"], -1);
        assert_eq!(
            report["records"][0]["record"]["values"]["ownerAborted"],
            false
        );
    }
    #[test]
    fn engine_provenance_accepts_only_reviewed_error_enums_and_integer_ranges() {
        for (key, values) in [
            ("initiator", &["engine"][..]),
            (
                "loaderKind",
                &[
                    "fetch-stream",
                    "xhr-range",
                    "moz-chunked",
                    "websocket",
                    "unknown",
                ][..],
            ),
            (
                "exceptionKind",
                &[
                    "fetch-failed",
                    "network-error",
                    "aborted",
                    "timeout",
                    "arraybuffer-allocation",
                    "typedarray-bounds",
                    "dataview-bounds",
                    "memory",
                    "type-error",
                    "unknown",
                ][..],
            ),
            ("libraryErrorType", &["network", "media", "unknown"][..]),
        ] {
            for value in values {
                let record = engine_error(serde_json::json!({key: value}));
                assert!(record.validate().is_ok(), "{key}={value}");
            }
            for invalid in [
                serde_json::json!("https://private.invalid/user/password?token=fixture"),
                serde_json::json!("RangeError: raw stack and source path"),
                serde_json::json!("unreviewed"),
                serde_json::Value::Null,
                serde_json::json!(true),
            ] {
                assert!(engine_error(serde_json::json!({key:invalid}))
                    .validate()
                    .is_err());
            }
        }
        for (key, minimum, maximum) in [
            ("loaderCode", -1, 999),
            ("readyState", 0, 4),
            ("networkState", 0, 3),
        ] {
            for valid in [minimum, 0, maximum] {
                assert!(engine_error(serde_json::json!({key: valid}))
                    .validate()
                    .is_ok());
            }
            for invalid in [
                serde_json::json!(minimum - 1),
                serde_json::json!(maximum + 1),
                serde_json::json!(0.5),
                serde_json::json!(1.0),
                serde_json::json!(u64::MAX),
                serde_json::json!("1"),
                serde_json::Value::Null,
                serde_json::json!(false),
            ] {
                assert!(
                    engine_error(serde_json::json!({key:invalid}))
                        .validate()
                        .is_err(),
                    "{key}"
                );
            }
        }
    }
    #[test]
    fn archive_startup_errors_persist_before_decoder_and_reject_private_or_misowned_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("startup.json");
        let store = Store::new(path.clone(), "0.1.23");
        store.action("start").unwrap();
        let startup = || Record {
            mode: "genxtra".into(),
            event: "error".into(),
            values: serde_json::from_value(serde_json::json!({
                "initiator":"startup", "startupPhase":"allocate",
                "startupReason":"archive-rate-limited", "code":"unknown",
                "phase":"startup-progress", "evidence":"opaque", "frontendDroppedEvents":0
            }))
            .unwrap(),
        };
        for phase in [
            "release",
            "guide",
            "before-start",
            "allocate",
            "bookmark",
            "resume-choice",
            "bookmark-reset",
            "decode",
            "resume-seek",
            "unknown",
        ] {
            let mut record = startup();
            record.values.insert("startupPhase".into(), phase.into());
            assert!(record.validate().is_ok());
        }
        for reason in [
            "archive-request-timeout",
            "archive-dns-unavailable",
            "archive-network-unavailable",
            "archive-rate-limited",
            "archive-server-unavailable",
            "archive-response-refused",
            "archive-response-limit",
            "archive-metadata-invalid",
            "storage-busy",
            "storage-locked",
            "storage-full",
            "storage-failed",
            "worker-failed",
            "bookmark-stale",
            "cancelled",
            "unknown",
        ] {
            let mut record = startup();
            record.values.insert("startupReason".into(), reason.into());
            store.record(record).unwrap();
        }
        let count = store.action("read").unwrap()["records"]
            .as_array()
            .unwrap()
            .len();
        for (key, value) in [
            ("startupPhase", "https://secret.invalid/token"),
            ("startupReason", "sqlite-busy private"),
            ("url", "https://secret.invalid/token"),
        ] {
            let mut record = startup();
            record.values.insert(key.into(), value.into());
            assert_eq!(store.record(record).unwrap_err(), "playback-trace-invalid");
        }
        for (mode, event, initiator) in [
            ("paid", "error", "startup"),
            ("genxtra", "sample", "startup"),
            ("genxtra", "error", "engine"),
        ] {
            let mut record = startup();
            record.mode = mode.into();
            record.event = event.into();
            record.values.insert("initiator".into(), initiator.into());
            assert!(record.validate().is_err());
        }
        for key in ["startupPhase", "startupReason"] {
            let mut record = startup();
            record.values.remove(key);
            assert!(record.validate().is_err());
        }
        assert_eq!(
            store.action("read").unwrap()["records"]
                .as_array()
                .unwrap()
                .len(),
            count
        );
        let persisted = std::fs::read_to_string(path).unwrap();
        assert!(!persisted.contains("secret") && !persisted.contains("https://"));
    }
    #[test]
    fn engine_provenance_rejects_private_fields_and_non_error_records() {
        for value in [true, false] {
            assert!(engine_error(serde_json::json!({"ownerAborted":value}))
                .validate()
                .is_ok());
        }
        for value in [
            serde_json::json!("false"),
            serde_json::json!(0),
            serde_json::Value::Null,
        ] {
            assert!(engine_error(serde_json::json!({"ownerAborted":value}))
                .validate()
                .is_err());
        }
        for key in [
            "msg",
            "message",
            "stack",
            "name",
            "url",
            "sourceUrl",
            "unknownField",
        ] {
            let record =
                engine_error(serde_json::json!({key:"https://private.invalid/user/password"}));
            assert!(record.validate().is_err(), "{key}");
        }
        for (key, value) in [
            ("initiator", serde_json::json!("engine")),
            ("loaderKind", serde_json::json!("fetch-stream")),
            ("exceptionKind", serde_json::json!("unknown")),
            ("libraryErrorType", serde_json::json!("network")),
            ("loaderCode", serde_json::json!(-1)),
            ("readyState", serde_json::json!(4)),
            ("networkState", serde_json::json!(3)),
            ("ownerAborted", serde_json::json!(false)),
        ] {
            let mut record = engine_error(serde_json::json!({key:value}));
            for event in ["sample", "warning", "relay-error", "recovery", "state"] {
                record.event = event.into();
                assert!(record.validate().is_err(), "{event}:{key}");
            }
        }
    }
    #[test]
    fn authority_provenance_is_fixed_redacted_and_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("authority.json");
        let store = Store::new(path.clone(), "0.1.23");
        store.action("start").unwrap();
        let cases = [
            ("canceled", "canceled"),
            ("application-closing", "application-closing"),
            ("scan-manifest-root-changed", "root-changed"),
            ("account-playback-session-replaced", "session-replaced"),
            ("sqlite-busy", "storage-busy"),
            ("sqlite-locked", "storage-locked"),
            ("account-catalog-storage-failed", "account-storage"),
            ("account-media-storage-failed", "media-storage"),
            ("account-revision-conflict", "account-revision"),
            ("account-media-revision-conflict", "media-revision"),
            ("account-media-reference-revoked", "media-reference"),
            ("account-authority-account-changed", "account-snapshot"),
            ("account-authority-media-changed", "media-snapshot"),
            ("account-channel-removed", "channel-removed"),
            (
                "account-authority-read-admission-timeout",
                "storage-admission-timeout",
            ),
            (
                "https://private.invalid/username/password?secret=fixture",
                "unknown",
            ),
            ("canceled https://private.invalid/secret", "unknown"),
        ];
        for (error, expected) in cases {
            let (record, line) =
                authority_failure_record(AuthorityMode::Paid, AuthorityPhase::LiveVerify, error);
            assert_eq!(record.values["authorityReason"], expected);
            assert!(record.validate().is_ok());
            assert!(!line.contains("private.invalid") && !line.contains("secret"));
            store.record(record).unwrap();
        }
        let persisted = std::fs::read_to_string(path).unwrap();
        assert!(!persisted.contains("private.invalid") && !persisted.contains("password"));
        let report = store.action("read").unwrap();
        assert_eq!(report["records"].as_array().unwrap().len(), cases.len());
        assert_eq!(
            report["records"][4]["record"]["values"]["authorityReason"],
            "storage-busy"
        );
        assert_eq!(
            report["records"][5]["record"]["values"]["authorityReason"],
            "storage-locked"
        );
    }
    #[test]
    fn authority_phases_distinguish_callback_loss_without_free_text() {
        for mode in [AuthorityMode::Free, AuthorityMode::Paid] {
            for phase in [
                AuthorityPhase::GenerationBefore,
                AuthorityPhase::LiveVerify,
                AuthorityPhase::LiveSnapshot,
                AuthorityPhase::LiveReference,
                AuthorityPhase::GenerationAfter,
                AuthorityPhase::VodVerify,
                AuthorityPhase::Callback,
                AuthorityPhase::Task,
            ] {
                let (mut record, _) =
                    authority_failure_record(mode, phase, "account-authority-task-lost");
                assert_eq!(record.values["authorityReason"], "task-lost");
                assert_eq!(record.values["authorityPhase"], phase.token());
                assert!(record.validate().is_ok());
                record.values.insert(
                    "authorityReason".into(),
                    "https://private.invalid/secret".into(),
                );
                assert!(record.validate().is_err());
                record
                    .values
                    .insert("authorityReason".into(), "unknown".into());
                record
                    .values
                    .insert("authorityPhase".into(), "unreviewed-string".into());
                assert!(record.validate().is_err());
            }
        }
    }
    #[test]
    fn buffer_measurements_are_closed_nullable_scalars_and_only_sample_events() {
        let record = |event: &str, values: serde_json::Value| Record {
            mode: "free".into(),
            event: event.into(),
            values: serde_json::from_value(values).unwrap(),
        };
        for event in ["sample", "native-geometry"] {
            for values in [
                serde_json::json!({"incomingMediaBitsPerSecond":0,"bufferTargetSeconds":1,"manualBuffer":true}),
                serde_json::json!({"incomingMediaBitsPerSecond":null,"bufferTargetSeconds":null,"manualBuffer":false}),
                serde_json::json!({"incomingMediaBitsPerSecond":1.0e12,"bufferTargetSeconds":2.5,"manualBuffer":false}),
            ] {
                assert!(record(event, values).validate().is_ok());
            }
        }
        for values in [
            serde_json::json!({"incomingMediaBitsPerSecond":-1}),
            serde_json::json!({"incomingMediaBitsPerSecond":1.0e13}),
            serde_json::json!({"incomingMediaBitsPerSecond":"https://private.invalid/password"}),
            serde_json::json!({"bufferTargetSeconds":0}),
            serde_json::json!({"bufferTargetSeconds":21}),
            serde_json::json!({"bufferTargetSeconds":2.5,"manualBuffer":true}),
            serde_json::json!({"manualBuffer":"true"}),
            serde_json::json!({"manualBuffer":null}),
            serde_json::json!({"bufferPreferenceKey":"private-identity"}),
        ] {
            assert_eq!(
                record("sample", values).validate().unwrap_err(),
                "playback-trace-invalid"
            );
        }
        assert!(record("error", serde_json::json!({"manualBuffer":true}))
            .validate()
            .is_err());
    }

    #[test]
    fn buffer_measurements_round_trip_only_with_an_opted_in_capture() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().join("trace.json"), "0.1.25");
        let sample = || {
            Record{mode:"paid".into(),event:"sample".into(),values:serde_json::from_value(serde_json::json!({"incomingMediaBitsPerSecond":32000,"bufferTargetSeconds":12,"manualBuffer":true,"bufferedAheadMs":4200})).unwrap()}
        };
        store.record(sample()).unwrap();
        assert_eq!(
            store.action("read").unwrap()["records"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        store.action("start").unwrap();
        store.record(sample()).unwrap();
        let report = store.action("read").unwrap();
        assert_eq!(
            report["records"][0]["record"]["values"]["incomingMediaBitsPerSecond"],
            32000
        );
        assert_eq!(
            report["records"][0]["record"]["values"]["bufferTargetSeconds"],
            12
        );
        assert_eq!(
            report["records"][0]["record"]["values"]["manualBuffer"],
            true
        );
        assert!(!report.to_string().contains("private"));
    }

    #[test]
    fn rejects_addresses_free_text_unknown_keys_and_unbounded_geometry() {
        for values in [
            serde_json::json!({"url":"https://secret.invalid"}),
            serde_json::json!({"code":"account-password"}),
            serde_json::json!({"playerNative":[0,0,99999,1080]}),
        ] {
            let r = Record {
                mode: "paid".into(),
                event: "sample".into(),
                values: serde_json::from_value(values).unwrap(),
            };
            assert!(r.validate().is_err());
        }
    }
    #[test]
    fn accepts_controller_failure_vocabulary_and_keeps_capturing_after_failure() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("trace.json"), "0.1.10");
        store.action("start").unwrap();
        for (code, phase, evidence) in [
            ("timeout", "buffering-progress", "observed-progress"),
            ("decode", "decode", "media"),
            ("unsupported", "capability", "media"),
            ("dns", "connect", "native"),
            ("tls", "headers", "opaque"),
        ] {
            store.record(Record { mode: "free".into(), event: "error".into(),
                values: serde_json::from_value(serde_json::json!({"state":"failed","code":code,"phase":phase,"evidence":evidence})).unwrap(),
            }).unwrap();
        }
        store
            .record(Record {
                mode: "free".into(),
                event: "state".into(),
                values: serde_json::from_value(serde_json::json!({"state":"playing"})).unwrap(),
            })
            .unwrap();
        let report = store.action("read").unwrap();
        assert_eq!(report["active"], true);
        assert_eq!(report["records"].as_array().unwrap().len(), 6);
    }
    #[test]
    fn bounded_capture_survives_restart_but_does_not_resume_recording() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trace.json");
        let store = Store::new(path.clone(), "0.1.6");
        let record = || Record {
            mode: "free".into(),
            event: "sample".into(),
            values: BTreeMap::from([("videoHeight".into(), 720.into())]),
        };
        store.record(record()).unwrap();
        assert_eq!(
            store.action("read").unwrap()["records"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        store.action("start").unwrap();
        for _ in 0..LIMIT {
            let mut r = store.data.lock().unwrap();
            r.records.push_back(Entry {
                timestamp_ms: now(),
                elapsed_ms: 0,
                record: record(),
            });
        } // exercise bounded persisted snapshot without 800 disk syncs
        store.record(record()).unwrap();
        let next = Store::new(path, "0.1.32");
        let report = next.action("read").unwrap();
        assert_eq!(report["active"], false);
        assert_eq!(report["build"], 1006);
        assert_eq!(report["records"].as_array().unwrap().len(), LIMIT);
        let cleared = next.action("clear").unwrap();
        assert_eq!(cleared["build"], 1032);
        assert_eq!(cleared["startedAtMs"], 0);
        assert_eq!(
            next.action("read").unwrap()["records"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }
}

#[tauri::command]
pub(crate) async fn export_playback_trace(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let work = app.state::<crate::NativeState>().admit_work()?;
    let store = app.state::<Arc<Store>>().inner().clone();
    let report = tauri::async_runtime::spawn_blocking(move || store.action("read"))
        .await
        .map_err(|_| "playback-trace-worker")??;
    let result = crate::native_video::export_playback_diagnostics(&app, report.to_string()).await;
    drop(work);
    result
}
