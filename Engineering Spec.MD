# GenX Streamer Engineering Specification

Version 0.1, October 10, 2026. Status: implementation specification; production behavior and native compatibility are not yet verified.

## Product and acceptance direction

GenX Streamer is an original television experience. Competing applications establish capability baselines and provide failure cases to investigate; their feature lists are not the roadmap or the design ceiling. Prioritize intelligent automation, reliable playback, accurate information, effortless navigation and measurable quality by eliminating recurring user problems before adding controls or expanding features.

Assume every external dependency can fail. Handle failures truthfully with deterministic ownership, deadlines, recovery and state preservation. Preserve previously verified behavior. A feature is complete only when its expected behavior, relevant failure modes, recovery paths, performance limits and regression tests have verified evidence on the platforms claimed. Normal-path success, implemented code, a passing fixture, or competitor parity alone cannot close it. Broader product superiority is an objective requiring evidence, not a current claim.

## Product requirements

GenX Streamer plays user-selected publicly available IPTV streams through a premium, restrained interface. Playback failures must be understandable, recoverable, and bounded. Source availability cannot be guaranteed; application resource ownership, data integrity, and UI behavior must remain predictable.

| Requirement | Required behavior |
| --- | --- |
| UX01 | Calm Split desktop layout with scrollable channels on the left and a dominant video surface on the right |
| UX02 | All, Favorites, News, and Sports filters; channel search in Live TV and program search with seven-day upcoming results in Guide; capability-aware push-to-speak; useful empty states; selection remains visible when browsing |
| UX03 | Pause/Resume, Mute/Unmute, Expand/Show channels, and Fullscreen controls in the bottom dock |
| UX04 | User-resizable native window and channel divider; responsive Android portrait/landscape layouts; compact dropdown workflows, no whole-page scrolling in the viewing/review screen, and no clipped actionable controls within the supported size/text-scale matrix |
| UX05 | Retro TV branding with approved GX lettering on the screen; Windows executable/shortcut and Android launcher icons derive from the same TV PNG shown in the app, with adaptive-mask-safe padding; readable contrast; keyboard/touch access; no decorative continuous animation |
| UX06 | Clear playback state and recovery action; technical details in optional diagnostics rather than the main viewing flow |
| PL01 | One active local session per device; real media progress determines Playing |
| PL02 | Standalone Windows and Android playback; Android ordinary viewing does not require the Windows server |
| DATA01 | M3U file/URL import, cached startup, refresh/cancel, preserved favorites, settings export/import, and old-data migration |
| GUIDE01 | Browsable program guide with current, next and upcoming listings; configurable XMLTV data, explicit channel matching, correct local times and cached recovery |
| CAST01 | Explicit Chromecast and DLNA discovery/selection, confirmed receiver playback, session-owned stop and cleanup |
| REMOTE01 | Directional/media-key navigation where exposed by the device, and explicitly authorized phone-controller pairing on capable clients |
| SHARE01 | Optional Windows server; same-network paired viewers follow the host channel; host retains selection control |
| DIST01 | Windows portable ZIP, signed Android APK, dependency notices, checksums, and recorded release verification |

The candidate support matrix is Windows 10/11 x64 and Android phones/tablets on ARM64 with a supported system WebView. Exact minimum Android/API/WebView versions and supported Windows configurations must be selected from platform proof results and stated in the release manifest. No untested combination may be labeled supported. Directional TV remote and media-key navigation are required; a dedicated Android TV distribution requires its own platform verification.

Settings must offer an About button with the actual application version, an offline quick guide, and owner-approved support links. Keep this secondary workflow outside the viewing controls; open support destinations only on explicit selection. See [About contract](docs/about-and-support.md).

## Architecture

The owner's October 10 clarification makes the program guide required for the first release. Add a Guide view with directional/touch navigation while keeping the existing viewing surface. Current, next and upcoming program information, program details and channel mapping belong in Guide; compact metadata may accompany an actual channel result. Missing/stale listings are labeled within Guide; playback remains usable without guide data. Future programs open details and cannot pretend to play future content. User-configured guide sources and mappings are distinct from stream availability. Guide parsing, persistence and navigation require tests for time-zone/daylight-saving transitions, identity ambiguity, malformed/large compressed files, cancellation and last-valid recovery. Supplemental G01 through G08 are defined in `docs/program-guide.md`.

Search uses the same active-workflow query for typing and explicit push-to-speak. Channel names/categories support queries such as Fox; mapped program titles/descriptions support Chicago Bears in Guide when the configured feed contains that metadata. The owner's October 15 layout change keeps Live TV's left results list limited to actual stream channel entries: no standalone Programs pane or event/program-only rows. Guide-aware matching, where supported, must resolve an existing channel identity and its actual stream capability. Playing a channel retains the search query. Guide owns program search, current/upcoming results, details and mapping. Live TV's right pane contains only the video surface and compact playback-control dock, with no guide or guide-status allocation. Normal playback-state feedback remains governed by UX06. This supersedes the prior combined-results and selected-guide-pane presentation without removing program search or G01–G08.

Upcoming search defaults to the next seven elapsed days from an injected current instant; show each start time in the user's display timezone. A shorter feed must display its actual coverage rather than imply a complete week. Unknown program end times cannot establish that an event is live. Search never invents a playable source or starts playback from an upcoming event. An admitted channel entry does not guarantee current network or decoder availability. Final recognized text remains editable; partial/stale speech results cannot tune channels. Recognition is user initiated, single-owner and canceled on background/disposal. Typed search remains available when speech, microphone permission or recognition models are unavailable. Any network recognition requires a clear disclosure; offline recognition is claimed only after platform proof.

Scoped source/browser evidence for the October 15 change is recorded in `artifacts/live-channel-only/2026-10-15/receipt.json` and `artifacts/live-video-pane/2026-10-15/receipt.json`: actual-main search/lifecycle checks, actual-style mapped/unmapped layouts and retained Guide workflow checks. The channel-only receipt retains an initial handheld row-visibility fixture failure and its unchanged isolated pass. These checks do not close native decoder, installed Windows/Android, remote-navigation or full product/release acceptance.

Guide data may be retrieved independently from a user-configured online guide source; the stream does not need to expose program metadata. Explicit mappings connect the station/region/feed variant to a guide channel. Provider IDs can suggest a match but ambiguous names require review. A national affiliate schedule must not silently substitute for a local affiliate or a news-only stream. Guide availability and event listings do not establish playable stream availability.

Development context uses the read-only `scripts/tmg.py` helper and bounded `CONTEXT.md` checkpoint. Topic snippets derive directly from current document sections with source lines and an input fingerprint. The helper checks documentation consistency and calculates counts; product tests and release verification remain independent.

One repository contains shared TypeScript UI/domain code, platform adapters, fixtures, tests, and native packaging. Prefer Vite with straightforward TypeScript components and scoped CSS; introduce a UI framework only for demonstrated implementation benefit. Tauri 2 is the initial shell candidate. HLS.js handles compatible web playback; native playback remains an adapter option. Rust supplies native networking/storage and the optional Windows server where platform proof supports this design.

The product source is distinct from the inline concept. It must bundle dependencies and assets, run outside Codex, and contain no mock server status, sample pairing success, illustrated video, or host-only visualization API in production viewing flows.

Proposed structure, to be created during implementation:

```text
src/
  ui/                 header, browser, video surface, bottom dock
  catalog/            parser, identity reconciliation, refresh service
  preferences/        versioned records and migration
  playback/           session controller, recovery policy, error mapping
  platform/           engine, window, networking, storage adapters
src-tauri/            candidate native shell and Windows sharing service
tests/fixtures/       deterministic manifests, media, network scenarios
tests/                contract, integration, UI, native checks
scripts/              build, packaging, evidence verification
docs/decisions/       tested platform and architecture decisions
artifacts/            generated test/release evidence, excluded from source control
```

UI calls the domain services; the platform boundary performs native operations. The parser performs no network or storage work. The refresh service cannot manipulate the player. The playback controller cannot write catalog data. The sharing service cannot mutate favorites or become a general-purpose proxy.

## Domain records

`Source` has a persisted source ID, origin kind, location, refresh revision, last successful refresh, and contextual error status. Locations can contain secrets and are redacted in diagnostics.

`Channel` has an application identity, source ID, provider ID when available, display name, category/language metadata, and one or more stream candidates. Prefer source ID plus provider `tvg-id` where available. Missing and duplicate provider IDs require reconciliation: persist generated identities and match cautiously by normalized metadata; ambiguous matches remain separate. Neither list index nor stream URL alone is a universal identity.

`Preferences` stores schema version, favorites by application identity, volume/mute, remembered window/panel state, and user-chosen sources. Missing favorites remain recoverable after a refresh. Catalog revisions and user preferences are stored separately so source replacement cannot delete user choices.

`PlaybackSession` owns a session ID, generation, selected channel/stream, state, engine instance, event subscriptions, cancellation controller, retry episode, deadlines, and cleanup handles. `SharedChannelState` carries a monotonically increasing revision and a server-issued channel/media identifier. It does not expose an arbitrary target URL API.

## Playback contract

Provide an engine adapter with operations for attach/play, pause/resume, mute/volume, fullscreen integration, and idempotent dispose. Publish progress, buffering, failure, and capability events. Inject time and network adapters where deterministic testing requires them. Do not let engine-specific APIs spread through UI components.

States: Idle, Connecting, Playing, Buffering, Paused, Reconnecting, Failed, Disposed. Stop is accepted from every state. A disposed session cannot emit effective events. A new selection increments the generation, cancels old work, disposes the old engine, and initializes the latest request. Stale work can finish internally but cannot attach, update UI/history, or publish a shared channel.

Connecting becomes Playing only after observed media progress. Buffering cannot remain indefinite. Startup/recovery uses one coordinated 20-second episode budget with at most two automatic retries; library and application retries share this budget. Fresh manual Retry creates a new episode. Authentication/access errors and unsupported formats do not enter an endless reconnect loop. Respect Retry-After where it fits the remaining budget; otherwise show a retry-later error.

Live resume checks whether the paused position remains available and recovers to the live edge when necessary. Initial Android playback pauses when the app backgrounds and resumes only through the documented foreground flow. Wake locks, if needed, apply only to active foreground viewing and release on pause/disposal. Background audio is deferred.

Keep source video proportions using contain behavior; larger stage dimensions must not stretch decoded content. Fullscreen and Expand are distinct. Desktop Escape and Android Back restore the prior layout while preserving the session. Rotation and resize do not recreate engines unnecessarily.

Offer a bottom-control quality chooser opening upward. New HLS channels request the highest advertised supported rendition before loading, ranked by height, bitrate, width and lowest manifest index for ties. Auto remains an operator choice using measured adaptive HLS bandwidth and supported media capability information; repeated manifest events preserve the operator's selection. Manual choices refer only to advertised renditions in the current engine; labels show offered resolution and bitrate, distinct from actual decoded resolution. Switching quality must preserve the session and avoid a full buffer flush. Missing adaptive levels disable selection rather than inventing choices; over64 renditions omit the partial manual list while retaining Auto. No quality setting claims to reconstruct detail absent from the source. Preserve existing bounded buffers, request limits, retries, and cleanup; physical rendition/buffer/frame evidence is required before claiming TV quality improvement.

## Catalog and persistence contract

Automatic guide updates have an independent Advanced preference, enabled by default. Off pauses publication-triggered and scheduled guide work while retaining manual refresh and cached guide browsing. Joining both guide owners precedes setting or imported-preference acknowledgment; imports acquire that gate before queueing catalog mutation. SQLite schema11 persists explicit choices while preserving legacy field absence and creates the verified schema10 backup before migration. See [automatic guide control](docs/automatic-guide-control.md) for the compatibility and lifecycle contract.

Read UTF-8 M3U with BOM/CRLF support, quoted metadata, comments, category/title fields, missing metadata, duplicate entries, and commas in names. Validate URL scheme and metadata size. Accept HTTP/HTTPS streams only under an explicit networking policy; report unsupported protocols.

Limit input to 20 MiB and 100,000 entries, with explicit errors above those bounds. Parse off the UI thread and virtualize rendering. Expose import progress and real cancellation. After cancellation is acknowledged, no obsolete revision can commit. If an atomic commit already occurred, return completion rather than claiming it was canceled.

Full-backup JSON uses a separate container limit of 60 MiB + 4 KiB so independently admitted catalog, preferences and contextual-health records can round trip together. Each canonical inner record remains limited to 20 MiB; catalog and health counts retain their existing limits. Playlist and previous-app JSON input remain limited to 20 MiB. Oversized containers or inner records fail as a whole; never omit health or truncate records to fit. Backup import preserves evidence timestamps but marks imported health historical, without claiming it proves playback on this device.

Serialize mutations and use atomic versioned persistence with last-valid recovery. Acknowledging a favorite edit requires a successful durable write or a clearly displayed unsaved state. Failed refresh retains the previous valid catalog. Migration reads from the old project/user export without modifying it; create a backup before upgrading new-app schemas. Validate imported preferences before applying them.

Optional update cadence refreshes the same saved URL sources while foregrounded: Off (default), Hourly, Every 6 hours (four times daily), Daily, Weekly, Every 2 weeks or Monthly. Canonical `sourceRefreshCadence` overrides the legacy `automaticSourceRefresh` Daily/Off fallback; serialize the boolean compatibility mirror. Persist actual automatic attempts before acquisition and compute the next interval from that timestamp; Monthly advances the UTC calendar month with end-of-month day clamping. Keep one owned bounded timer and no overlapping jobs. Off performs no automatic startup acquisition; startup/resume checks due work only while enabled, without an OS background wake or catch-up burst. Background/closing cancels and joins work. Preserve favorites/removals and last successful catalogs/schedules after failure/cancel, and retain manual Refresh. JSON remains schema1; native schema8 persists cadence and supplied program categories through backed migration. See [update cadence](docs/daily-source-refresh.md) for scoped evidence and outstanding installed proof.

Use embedded SQLite as the canonical native Windows/Android store. Persist admitted sources, channels, ordered stream URLs, favorites, removed-channel identities and preferences in normalized tables; preserve source-isolated stable identities and unresolved preference identities. Imports/refreshes and paired catalog/preferences replacements use a single transaction, with versioned schema migrations, foreign-key enforcement, bounded lock waits, durable synchronization and verified backup/recovery. Keep the database on local user storage; portable mode carries its data directory. JSON is the validated interchange and prior-version migration format, not the canonical release database. The browser development preview uses IndexedDB transactions. Indexed native search/paging and measured performance require their own implementation evidence; merely storing JSON blobs in SQLite does not satisfy this contract. See [the storage decision](docs/decisions/sqlite-storage.md).

## Networking and diagnostics contract

Define bounded connect, first-byte, read-idle, redirect, body-size, and concurrency behavior. Keep network awaits outside shared-state locks. Confirm IPv4/IPv6 fallback through tests rather than copying Node-specific workarounds into Rust. Keep TLS validation enabled. HTTP-source support must be explicit, narrowly configured where possible, and verified in the packaged Android app.

Separate timeout, missing source, access refusal, TLS, DNS/connectivity, malformed media, unsupported codec, and canceled work. Do not label every HTTP 403 as geoblocking. Record time, session/generation, operation, and sanitized error category. Redact credentials in URL userinfo, paths, queries, headers, keys, and signed URLs before logging or exporting. Logs have a configured size/rotation limit and no raw provider payloads by default. Initial bounded event-history implementation and its remaining coverage/export/correlation limits are documented in [local event history](docs/event-history.md).

Saved-channel health (owner decision, October 19, 2026; [decision](docs/decisions/saved-channel-health-check.md)): while idle in front, GenX quietly rechecks saved Free TV channels at most once per 20 hours and stores the newest result natively. Two failures at least 20 hours apart with no response between mark a channel Not responding; one response clears it. Failures during a connection outage are discarded. The viewer can list marked channels and remove them in one restorable step; GenX never removes or hides a channel by itself. Scans trust a stream that answered for 7 days; Full recheck checks everything.

## Sharing contract

The Windows owner starts sharing explicitly, chooses the listening interface/port, and receives an address and pairing flow. Do not open router ports, alter firewall rules automatically, or install an always-running service. Shutdown stops the listener and owned work. Port conflicts, changed networks, and firewall refusal produce actionable errors.

Pairing establishes revocable, scoped, view-only access. Define an encrypted HTTPS trust path for ordinary browser clients and the Android app. Resolve local certificate trust during the sharing prototype; do not silently bypass TLS checks or describe HTTP plus a pairing code as encrypted. Credentials remain outside public URLs and logs. Pairing attempts are rate-limited; authentication applies to media as well as state endpoints.

Remote clients follow host channel revisions and reject stale responses. Host local pause does not stop remote viewers. Viewer pause affects only that viewer. Sharing stop ends remote viewing while local playback continues. Track active consumers and expire abandoned leases within 30 seconds. Pause/disposal must not retain upstream work beyond an active consumer's need.

Serve HLS playlists and media through server-issued session-scoped identifiers. Rewrite variant/segment references, keys, initialization maps, and relative paths correctly; preserve required query semantics and Range behavior. Admit external targets from validated source sessions, revalidate redirects and resolved addresses, and reject loopback/private/link-local/metadata destinations for upstream media. A paired local server is a different trust boundary from external stream targets.

Static serving stays inside bundled UI files, including Windows path and encoded-traversal cases. Bound per-client queues, caches, requests, and retained media. A slow viewer cannot block a fast viewer. Define resource ceilings from measured tests before shipping. No transcoding is included initially; incompatibility remains explicit.

## Casting contract

Support Chromecast and DLNA through native discovery/control adapters behind a shared session controller. Discovery starts only on user action and ends within 10 seconds. Require explicit receiver selection; never choose the first receiver or use household-specific fallback addresses. Casting is separate from local playback and encrypted browser sharing.

Home and away casting require confirmed receiver selection, fresh protocol identity and network scope, separate control/media checks, and actionable capability failures. Follow venue-provided room pairing where supported; no universal guest PIN or guaranteed arbitrary hotel TV connection. [Travel casting research and workflow](docs/travel-casting.md) extends C01 through C08 without weakening their deadlines, access restrictions or cleanup requirements.

LOAD acceptance remains Connecting. Matching receiver PLAYING status and an owned receiver session prove success. Apply a 20-second startup deadline and 5-second stop deadline. Resolve owned remote playback before replacing a session. Unconfirmed stop remains actionable. Receiver takeover cannot cause commands against another sender's media. Preserve authentication, CORS, geography, DRM, and TLS restrictions.

Validate discovered private LAN control endpoints separately from public media URLs. No arbitrary-target relay, secret forwarding, permanent scanner, or firewall changes. Both native protocol transports and physical receiver tests are required. [Casting contracts and research](docs/casting-invariants.md) defines C01 through C08.

## Source and remote control experience

No built-in provider/playlist URL is required. Users add sources in the app; filenames and URL extensions do not determine acceptance. Inspect MIME/content signatures and report unsupported formats clearly. Support catalog playlists, direct HLS, and browser/native-compatible direct media within the declared codec matrix. Do not download an entire video just to detect its source type. Users can remove sources or individual channels. Explicitly removed channel identities remain excluded after refresh and can be restored; single transient failures never auto-delete channels.

Fresh configuration contains no channels, playlists or guide providers. Local search typing performs no discovery request. Pressing its magnifier explicitly authorizes online directory discovery and aggregation for the captured query, without requiring playlist terminology or per-channel selection. Known directory identities may guide discovery; actual provider locations must resolve online. Persist admitted source choices before probing. Retain existing user choices and provenance; failed discovery cannot erase saved content or grant HTTP access. A paused scan retains its captured scope, with Continue and explicit Rescan as distinct actions. This architecture does not establish third-party content rights or antivirus acceptance.

Provide directional navigation, select/back, and channel/media-key controls without focus traps when the device exposes those capabilities. Not every TV, remote, operating system, or browser exposes these inputs or network protocols; document tested combinations and make unsupported controls actionable instead of claiming universal support. Phone control requires a capable network client and an explicitly issued controller invitation, distinct from default view-only pairing. Authorize every control request, scope commands to admitted channel IDs, reject stale/duplicate commands, and acknowledge actual host application rather than receipt alone. No remote desktop, unrestricted administrative control, or arbitrary URL execution is included.

## Packaging contract

Battery efficiency is part of the product contract. Idle, pause and background states must release unnecessary playback/network/worker/screen-on ownership. Give scans/imports/guide refreshes a defined background cancellation/recovery policy. Graceful exit confirms frontend work and native service shutdown; forced termination cannot count as clean-close acceptance. Measure whole-process CPU/memory/network and physical unplugged battery baselines on named hardware before setting supported budgets (T103/P08). Explicit user-enabled LAN sharing has a separately measured active-service budget.

Windows portable mode stores settings beside the executable when writable. Read-only locations offer an explicit writable storage choice; do not claim the app remained fully portable if data moved to the user profile. State WebView2 requirements and verify clean-machine failure behavior. A bundled-runtime option needs a patching policy and separate size disclosure.

Android delivers an installable signed APK, stable package identity, sandboxed settings, and export/import. Updates preserve settings. Windows releases use a consistent trusted publisher identity. Preserve key material outside source control and logs. Production signatures, checksums, notices, and scan results apply to the final binaries after packaging.

No framework or signature guarantees acceptance by every antivirus/EDR policy. Report reputation prompts, malware detections, firewall prompts, and enterprise policy blocks separately. Do not solve release failures by weakening host protection.

## Acceptance and traceability

All 30 invariant IDs remain required: P01 through P09; D01 through D05; S01 through S06; R01/R02; C01 through C08. Their detailed tests are authoritative in [streaming-invariants.md](docs/streaming-invariants.md) and [casting-invariants.md](docs/casting-invariants.md). Supplemental registers extend them without renumbering: [guide](docs/guide-invariants.md) G01–G08, [web viewer](docs/web-viewer-invariants.md) W01–W16, [lifecycle and media](docs/lifecycle-media-invariants.md) LX/MP, and [navigation](docs/navigation-invariants.md) NV01–NV13 (remote, keyboard and touch, with the remote-only device sweep). [Metric requirements](docs/metric-requirements.md) define measurements; the project's size summary, release-check notes and task ledger are kept in its private archive, and the open tasks are in [TASKS.md](TASKS.md).

Completion requires the Windows artifact, Android artifact, local playback, safe LAN viewing, native-device tests, and a requirement-by-requirement evidence audit. Documentation, mockup checks, and unit tests alone cannot establish completion.

## Private scan candidate persistence

For newly admitted scans, retain original candidate URLs in a private version-1 encrypted SQLite manifest and seal its association atomically with the initial packed-v3 checkpoint before probes start. Preserve source grants, source-definition fingerprints, candidate order, URL hashes, policy, catalog and checkpoint revision fences through recovery. Keep each page at most64 candidates/1 MiB plaintext, binding128 KiB, ciphertext overhead16 KiB per page and96 MiB aggregate; existing candidate/URL limits remain. Platform protectors use current-user Windows DPAPI or Android Keystore AES-GCM; key loss and authentication failure refuse recovery with no plaintext fallback. Ordinary exports omit this namespace. Stop and close join all admitted SQL/cryptographic work. See docs/scan-candidate-manifest-plan.md for current scoped evidence and remaining acceptance. Existing checkpoints without a manifest retain guarded reconstruction and must never silently restart.

## Early startup diagnostics

Install immutable schema1 bootstrap and startup observations before viewing mounts. Distinguish synchronous mounts from actual saved-data/native readiness; fixed stage/reason fields must omit raw errors and private content. On a synchronous mount failure, show human-readable guidance outside the inert viewing shell, without resetting data or automatically replaying partially mounted owners. Retry or Close controls require an actual joined host recovery protocol. Readable error reporting alone does not prove complete startup recovery or identify an intermittent root cause.


## ARCH01 — Archive library and resilient discovery

User-requested October14,2026. Live TV and GenXtra are separate library modes sharing the existing search/player layout. Local typing filters only the active library; Search/magnifier or Enter reads saved results first and then acquires bounded online results. Repeating Search continues acknowledged discovery; a separate Find more button is no longer required. Preserve each mode query, list and navigation state while playing a selected file. Follow docs/archive-search.md for curated ten-program/year1960–1999 scope, explicit older searches, episode identity, provenance and truthful unknowns. User target references in docs/research/archive-targets are not installed content records. No scheduler, automatic interstitial insertion or virtual broadcasts are required.

Use versioned provider/domain DTOs, versioned SQLite tables, compatible migration paths and independently owned discovery/playback adapters. API/schema/format changes reject the new revision without replacing the last valid library. Bound requests, bytes, parsing, concurrency, index size and retry budgets. Continue acknowledged discovery instead of restarting; refresh diffs changed metadata. Existing-item maintenance follows explicit configured source permissions and resource/lifecycle budgets; new discovery remains user-directed. Archive is an external dependency capable of failure, not a guaranteed catalogue.

Allocation checks exact library revision and file reference; active playback pins the selected file proof so unrelated index updates or Find more do not stop an unchanged episode. Actual deletion, file replacement or revoked permission invalidates its capability. Confirmed deletion and durable cleanup return truthful receipts; transient failures do not erase entries. Use one local decoder, scoped native media admission and actual joined shutdown. Natural on-demand completion stops cleanly without reporting a live-stream failure. Windows/Android discovery, navigation, decoding/range behavior and failure recovery require direct evidence before completion. Existing14requirements and all original invariants remain in force.

October15 user clarification: retain media files whose episode/edition/role is unknown and disclose deterministic facts under the individual file caret. Separate provider claims from actual inspected container/decoder facts; represent missing resolution, audio language, track roster and episode identity as unknown. Do not infer Season1/Episode1 from D1 or commentary from a perceived sound. A shared original DVD/ISO may contain several episodes and menu clips; it is not an interchangeable-variant identity. Automatic source repair requires exact work/episode/edition compatibility and cannot transfer playback offsets on title similarity alone.

The approved provider expansion includes Internet Archive, Library of Congress, NASA Image and Video Library, and Wikimedia Commons through anonymous public APIs. No signup, credentials, payment or access-control bypass is required or permitted for these public adapters. Admit actually accessible media with source attribution and item-specific rights information; public metadata or a repository name alone is not proof of unrestricted rights or compatible decoding. Independently bound each provider's requests, continuation, failures and verified last-valid results. October15 implementation has scoped Library of Congress and NASA catalog/playback evidence on Windows and physical Android TV; Wikimedia Commons remains configuration-required until legitimate public application contact is configured. See `docs/decisions/public-archive-providers-v1.md` and its exact evidence manifest. Broader provider failure/recovery, resource and release acceptance remains unverified.

## REPLAY01 — Instant replay on live TV

Owner-requested October 21, 2026. On live TV, a Replay button in the bottom dock (touch, mouse, keyboard and remote arrows; also the remote's Rewind key where present) jumps back 10 s and plays at a quarter of normal speed, muted. While a replay runs, the dock shows −10s, a one-frame step back and forward, Pause/Play, a speed choice (⅛×, ¼×, ½×, 1×), the distance behind live, and Live. Replay reaches back 30 s (owner decision). It uses only the players' compressed back buffers, enlarged to 30 s: no decoded-frame storage, no disk and no recording. It shows original pictures only, with no interpolation. It returns to live by itself once it reaches the moment Replay was pressed, and Live, Back, a channel change, Stop, an error, backgrounding and exit all end it. Rules RP01 through RP08 and their proofs are in [Instant replay](docs/instant-replay.md). Replay never changes the viewer's own Mute or volume, never counts a replay pause as a stall, and never acts on a newer channel than the one it started on.
