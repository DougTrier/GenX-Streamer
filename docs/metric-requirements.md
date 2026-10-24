# Metric requirements

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

Required measurement gates for GenX Streamer, moved unchanged from the former `Code Metrics.MD` on October 18, 2026,
when that file became the generated Project Metrics summary. Thresholds, roles and cadence:
operational gates. Past measurements: measurement history.

These are required gates, not measured claims. Apply operational gates for thresholds/tolerances, roles, developer versus release cadence, v1 scope, prospective budgets, canonical evidence and failure policy. Historical receipts remain in measurement history and implementation progress.

The read-only helper reports reproducible file/line counts, task arithmetic and input hashes: `python -B -X utf8 scripts/tmg.py metrics --json`. Context is bounded to10,000 characters and checkpoint4KiB. Tooling results do not prove product acceptance or token savings.

## Correctness and lifecycle metrics

| Metric | Acceptance requirement | Measurement |
| --- | --- | --- |
| Effective local player sessions | At most one per device | Track engine owners, loader ownership, generation, listeners, timers, and workers during every session transition |
| Obsolete callback effects | Zero | Deterministically reorder responses; assert no old attachment, UI update, history success, or sharing publication |
| Normal disposal | Owned loaders/handles released within 2 seconds | Real request logs and engine counters after repeated stop, close-during-load, and fatal error |
| Recovery episode | At most 20 seconds and two automatic retries | Inject clock/network; include engine retries, sleeps, Retry-After, and all application retries |
| Rapid-switch regression | 500 requests satisfy LIFE02 | Latest identity, stale-effect guards, disposed owners/observer baseline and separately budgeted process memory |
| Android resume regression | 50 background/resume cycles pass | Physical-device instrumentation; session and resource counts remain valid |
| Soak duration | At least two hours and RESOURCE01 acceptance on both platforms | Real decoded supported fixtures; prospectively budgeted memory/CPU/frame/owner measurements, complete disposal |
| Abrupt remote-client expiry | At most 30 seconds | Kill/suspend client without stop; observe lease removal and unused upstream closure |
| Persistence correctness | Zero lost acknowledged writes or partial committed records | Concurrent edits, process termination, disk-full, recovery, and schema migration tests |
| Cancel correctness | No publication after confirmed precommit cancellation | Cancel every phase; deliver obsolete results; crossed irreversible commits return truthful completed receipts, as defined by DATA01 |

## UI and catalog metrics

| Metric | Target or limit | Measurement conditions |
| --- | --- | --- |
| Playlist bytes | Maximum 20 MiB | Count bytes during reading/download, before unbounded buffering |
| Playlist entries | Maximum 100,000 | Parser enforces the limit before committing |
| Large-catalog search | p95 response at or below 200 ms | 100,000-entry fixture on named reference Windows and Android devices; include filtering and visible list update |
| Responsiveness during import | Pause, select, and cancel remain operable | Measure action latency/event-loop delay during download, parse, copy, and commit; freeze failures block release |
| List rendering | DOM rows scale with viewport and overscan | Record rendered row count at small and large catalog sizes; never mount all 100,000 rows |
| Layout widths | 320, 570, 736, 1024 pixels plus native resize | No horizontal overflow, overlapping controls, or lost actions; test portrait/landscape separately |
| Compact/short layouts | 320×480, 320×640, 360×480, 640×360, 800×600, 1280×720; 100% and 200% text | Test fixed close/navigation actions, ancestor clipping and hit targets; viewing/review outer surfaces do not scroll, bounded lists/form panels may scroll; native device evidence remains required |
| Video proportion | UI03: relative aspect error ≤1%, boundary rounding ≤1 CSS pixel | Compare decoded content with contain-rendered bounds; letterboxing allowed; container ratio is independent |
| Keyboard/touch access | UI02: every essential action reachable, targets≥44×44 CSS pixels | Named focus paths, accessible name, visible focus, fullscreen exit and no hover-only controls; remote paths follow remote-navigation.md |

Response time starts at user input and ends when the requested visible result is committed. Record cold and warm runs separately. Use at least 30 measured runs for percentile reports; retain samples and report p50/p95 rather than a single best run. Public provider timing is recorded separately from controlled-fixture timing.

## Resource and performance baselines

Memory ceilings, package-size budgets, decoder CPU/GPU budgets, frame-drop tolerance, and per-client media-cache ceilings are pending baseline measurements. Set them before release against named hardware, bitrate, resolution, codec, OS, and WebView/runtime versions. Do not substitute arbitrary universal ceilings for device measurements.

For soak tests, capture renderer heap, native/process working set, decoder resources, network activity, and session-owned counts. Sample at a documented interval and compare equal-duration post-warm-up windows. Reject persistent accumulation or leaked owners; transient GC cycles and expected decoder allocations are not automatically leaks. Keep raw evidence and explain the resulting ceiling.

When idle with playback and sharing stopped, there must be no media requests, scanning activity, decorative animation loops, or retained playback worker. Essential application events are allowed. Resource measurements during minimized/background states must respect the foreground-only playback policy.

Battery efficiency and confirmed graceful shutdown are required acceptance gates (T103/P08). Measure named Windows laptop and physical Android hardware with fixed brightness, audio, power mode, codec, resolution and bitrate. Use controlled idle, playback, pause, background, foreground-without-autoplay, explicit resume and exit phases. Record whole owned process-tree CPU-time deltas with stated core normalization, private/working memory, Android PSS, threads/handles, wake locks/screen-on/audio ownership, network requests/bytes and decoded progress. Compare an unplugged app-closed baseline with equal-duration idle/background measurements; charging or unavailable energy sensors cannot establish battery-drain acceptance. Set enforceable budgets from measured baselines before release.

Background scans/imports/guide refreshes need an explicit cancellation policy and visible recovery state; playback counters alone cannot prove whole-application quiet. Graceful exit must confirm frontend cancellation/storage settlement as well as native owner shutdown, with zero owned processes, connections and workers afterward. Forced exit is separate failure evidence. User-enabled LAN sharing is an intentionally active service and gets its own bounded resource budget; do not silently interrupt remote viewers to satisfy local idle measurements. Audit identified gaps October 10; these policies and measurements are not yet accepted.

Benchmark sharing with two concurrent viewers and one deliberately slow client. Record upstream connections, media bytes, request counts, queue/cache bounds, and fast-client playback progress. Define the supported viewer limit from measured results and enforce admission rather than claiming unlimited scalability.

## Code health metrics

| Metric | Gate |
| --- | --- |
| Invariant evidence coverage | Original 30 plus guide G01 through G08 supported by appropriate automated or recorded native/release evidence; mapping is not acceptance |
| Requirement coverage | All 14 UX/PL/DATA/GUIDE/SHARE/DIST/CAST/REMOTE requirements map to tasks and acceptance evidence |
| Type checking and lint | No errors; new warnings resolved or explained with specific consequences |
| Formatting | Consistent committed formatting; automated check passes |
| Tests | Required suites run and pass; missing/skipped required native evidence remains incomplete |
| Test integrity | A deliberately failing assertion and a missing required report make verification fail |
| Dependency integrity | Lockfiles committed; supported versions; no unexplained security findings; licenses/notices recorded |
| Complexity | Review functions over 20 cyclomatic branches or 80 nonblank lines and modules over 500 nonblank lines; split when it improves ownership/testing |

Complexity thresholds are review triggers, not proof of quality or instructions to split cohesive logic mechanically. Coverage percentage is a diagnostic. Set a baseline once implementation exists and ratchet it for changed critical code, while requiring behavior coverage for cleanup, stale work, cancellation, storage, authentication, and relay boundaries. Do not invent a current coverage baseline or satisfy a gate by excluding hard-to-test production paths.

## Evidence format

Store generated results under `artifacts/verification/<run-id>/`, outside source control unless a sanitized summary is intentionally committed. Each run records UTC timestamps, local timezone, source revision/dirty state, build configuration, toolchain/dependency versions, device/OS/WebView, commands and exit codes, fixtures and seed, target, observed value, pass/fail, and artifact paths.

Use a release evidence index mapping all invariant IDs and specification requirement IDs to reports. Missing fields or reports fail the applicable gate. Redact credentials before reports are written. Signatures and hashes identify the exact final artifacts; changing an artifact invalidates evidence that depended on its prior bytes.
