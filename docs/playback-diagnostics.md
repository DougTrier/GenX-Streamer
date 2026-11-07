# Playback diagnostics

**Release status:** 0.1.25 / build 1025 has been withdrawn because of phone/handheld layout and Football/NFL search issues. Public downloads provide [0.1.28 / build 1028](https://github.com/DougTrier/GenX-Streamer/releases/tag/v0.1.28). See the [candidate status](../README.md#release-status) and [physical device audit](device-playability-audit.md) for the current development build. Results in this document apply to the builds named alongside them.

Open **Settings → Advanced → Playback diagnostics** and select
**Start 15-minute capture**. Close Settings, reproduce the problem, then return
to the same panel and select **Stop recording → Export report**. Starting a new
capture replaces the previous one, so export before testing another section.

Record the APK version/build, device model, channel or title, and approximate
time of the problem alongside the report. The report deliberately excludes
channel names, account details and stream addresses. Nothing uploads automatically.

Test each section: **Free TV, Paid TV, GenXtra and Web Stream**. For each one,
check the small player, fullscreen, returning to the small player, and switching
channels or titles. In GenXtra, also select Expand and then Stop: the channel/title
navigation must return. Stop any other Paid TV device before testing an account
that permits only one connection.

For current release acceptance, use short targeted tests on the exact candidate APK:
Finish/Stop scan and saved progress, Menu and Guide navigation/loading, native keyboard
dismissal, fullscreen/return and expanded/fullscreen Stop. The owner removed the
additional five-minute capture requirement on November 1, 2026. Existing long captures
remain supporting evidence. Buffering, automatic recovery, a frozen/black picture,
offset video or inaccessible navigation observed during a test still needs investigation;
eventual recovery does not make that failure a pass.

On Android, Export displays a path similar to:

```text
/sdcard/Android/data/com.tmg.tv/files/GenX-playback-diagnostics-<timestamp>.json
```

Copy that exact file using a file manager that can access the app directory, or
ADB from a computer already connected to the device:

```powershell
adb -s <device-address> pull "<exact-exported-path>" "playback-report.json"
```

On Windows, Export opens a file picker. Captures remain available after restarting
the app, but recording does not resume automatically. Capture lasts at most fifteen
minutes and retains at most 800 observations / 1 MiB; removed observations are counted.

The report includes state changes, recovery/error events, buffering, available
frame counters, video dimensions, CSS coordinates, viewport size, device pixel
ratio, and Android display density/WebView scale. Native player and surface
screen bounds are compared against expected placement, with two pixels of
tolerance. A mismatch records the coordinate and size differences.

These measurements detect incorrect view/surface placement. They cannot prove
that the final GPU-composited picture matches those bounds; visually verify the
whole picture and its corners. Third-party Web Stream pages expose their outer
host geometry and resource/renderer failures, but not their internal video frame
counters. Missing counters are unverified, not zero. Review Android logs alongside
the report for decoder, network and graphics issues.

For fault attribution, correlate the earliest engine detail with upstream relay
EOF/read failures and controller recovery. A consumer disconnect after a player
restart is a downstream consequence, not proof of a provider fault. Fixed library
categories and numeric HTTP/media errors are retained; raw error messages are not.


## Deciding where a failure starts

Use the first event in time, not the last cleanup warning. Preserve the failed
capture alongside the successful comparison; a successful retry does not explain
the original failure.

| Evidence | What it establishes | Response |
| --- | --- | --- |
| Relay HTTP 401/403, 404/410, 429/503 | The upstream request was refused, missing, or rate-limited. It does not establish whether the saved account/address was correct. | Check source/account settings; respect Retry-After and avoid concurrent account streams. Use another authorized source when available. |
| Upstream EOF, body timeout, or connection reset before recovery | Delivery stopped at the upstream connection. Provider, network path, and client timeout policy still need separating. | Compare independent channels and devices one at a time; inspect request timing and retry budgets. A timeout alone is not proof of provider fault. |
| Local write timeout/consumer disconnect after decoder release | The local player stopped reading or closed the relay. | Find the earlier engine/controller event. Do not blame the provider for a cleanup consequence. |
| Decoder/MSE failure with arriving data | A device/format/player compatibility problem; malformed source data is also possible. | Check codec/container and decoder facts; use the compatible native route or an authorized alternate format. |
| Expected/actual view bounds differ | App/native placement error. | Fix conversion, parent offsets, or transition layout; verify small/full/small on the affected device. |
| Bounds match but picture is dark/cropped | Geometry measurements alone are insufficient. | Review graphics/surface logs and physical screenshots; investigate compositing before declaring success. |
| Generic network exception without an earlier cause | Unattributed failure. | Retain the failure and gather the next capture; do not label it provider-side. |

Current recovery already bounds retries, honors known Retry-After delays, releases
the previous playback owner before reconnecting, and can try supplied authorized
alternatives. It cannot repair a provider outage, invalid account, unavailable
channel, or missing media. Repeated stop/restart gaps still fail release acceptance.
The live timeout fix tolerates a six-second delivery pause without reopening the
connection; it does not promise uninterrupted pictures when a provider supplies
no playable data for longer than the buffered video.


## Independent source tuning and winner selection

A channel and its exact source are separate playback identities. Browser live
adaptive buffering is learned per channel/source URL for this session; reconnects
to the same source retain that goal, while another source does not inherit it.
That automatic-learning cache remains session-local. It is separate from the saved manual buffer choice in 0.1.25 / build 1025: supported engines accept a target from 1 to 20 seconds, and this device retains the choice for the same stream across restart and unchanged-source rescans. Auto resets only that stream's manual choice. Automatic selection can choose another feed of the same channel; each feed keeps its own buffer choice. Unsupported control or unavailable measurements remain explicit.

Equivalent-feed ranking, introduced in 0.1.17 and retained in the current source, ranks admitted equivalent feeds using observed decoder
progress, buffering and failures. At least 60 seconds of decoded evidence with
no recorded stall/failure outranks an unknown feed; failed or repeatedly stalling feeds rank
below unknown alternatives. A single buffering interval remains uncertain, so it
does not promote an untested format over the requested source. Among stable feeds, positive audio-decoder evidence,
measured resolution and frame rate break ties. Decoder evidence does not prove
speaker output or final composited pixels. The cache is bounded at 256 entries,
scoped to this app process/device/player, and expires unused records after 15
minutes. It is not a persistent quality database.

Public equivalence requires the current canonical guide-feed mapping, one
unambiguous current programme and matching known country/region/state. Paid TV
requires the same account and current catalog revisions, an exact EPG identity,
one current programme, matching known country and channel identity with regional
and delay qualifiers preserved. Names or generic sports titles alone never
grant equivalence. Removed/revoked entries are excluded. These metadata lookups
never probe competing streams in parallel.

Selection and bounded recovery use the best known equivalent. Two genuine
mid-play stalls in a minute or a failed source may request another admitted feed,
with at most two automatic feed changes per user selection. The existing
one-time stored Paid format fallback remains separate and bounded. Stop,
replacement, background suspension and account changes invalidate pending choices.
Healthy playback is not interrupted to test competitors. Pause/replay/VOD do not
count as source instability. **Retest this stream** in the channel menu bypasses
automatic choice and clears that feed's health history. Paid default/alternate
formats retain independent identities. Public duplicate labels for the exact
same endpoint share health, avoiding retries of the same failing URL under a
different name.

Paid live buffer learning uses the owner's account/catalog/stream/format identity
instead of a short-lived loopback URL. Quality-choice diagnostics contain
candidate count, whether the source changed and whether equivalence was available,
with no feed identity or address. Persistent ranking, if added later, must retain
device/player/app-version provenance so an old app defect does not permanently
disqualify a good source.

The learned startup cushion applies to both HLS and live MPEG-TS. A source that
has already stalled can wait for its own learned buffered amount before starting,
with a twelve-second deadline and cancellation on Stop/replacement. Fresh sources
keep their existing startup behavior; on-demand playback is excluded.

Browser HLS transport pools belong to the individual playback session. Requests
within that session can reuse TCP/TLS connections; Stop, channel replacement and
application shutdown release the pool. HTTPS-only and HTTP-enabled requests use
separate clients with the existing URL, redirect, range, size and timeout limits.
This avoids a new connection for every fragment without sharing account or
connection ownership across concurrent sources. Connection reuse is an efficiency
change, not proof that a previously stalling source now passes sustained playback.

Routine HLS body timing and buffered-fragment facts are independently sampled at
most once every five seconds. Short fragments/low-latency parts must not fill the
800-entry recorder before a 15-minute capture finishes. Playback state changes,
errors and recovery remain immediate; the delivery sampler does not gate them.

The 0.1.15 forced-native comparison of the exact failing ACC HLS feed exposed
Media3 `BehindLiveWindowException` (R8 class `ee`, confirmed against that APK's
mapping). The plugin automatically sought to the default position and prepared
again without recording a recovery. This identifies a restart mechanism in that
test; it does not establish the cause of the owner's Paid TV Weather report.

The 0.1.16 diagnostic candidate bounds these rejoins to two per player session,
rejects stale player callbacks, records a fixed numeric native error code and a
session recovery counter, and fails the release assessment when that counter
advances. Its comparison captured both rejoins and the exhausted failure; it
did not pass. The 0.1.17 candidate reports exhaustion as a network failure,
preserves observed HTTP status, and distinguishes access refusals, missing
resources and retryable HTTP failures. Assessment counts recovery deltas across
native-session replacement. Live progress uses absolute stream positions when both
samples provide them; a sliding window's clamped relative position must not
produce a false progress timeout. VOD and older status replies retain their
relative-position behavior.

The 0.1.16 short-window startup/hold experiment is **removed** from 0.1.17.
It failed both comparisons: browser playback had seven buffering interruptions
in 664.1 seconds; native playback had two rejoins followed by an exhausted
failure. Restricting the client's cache to the server's current playlist was too
aggressive: downloaded media can remain usable after leaving that playlist.
Starting closer to live also reduces the buffering margin; see
[RFC 8216 sections 4.3.5.2 and 6.3.3](https://www.rfc-editor.org/rfc/rfc8216.html#section-6.3.3).
No injected start directive or playlist-size-based hold reduction remains.
Failed reports and the experimental helper remain in ignored test artifacts.

The 0.1.17 native Media3 HLS relay reuses clients within its own session, with
at most eight origin/resolved-address sets and two idle connections per host.
Every request and redirect still resolves and validates its public destination;
changed address sets use separate pinned clients. Stop/replacement closes the
pool and joins the relay's work. Casting retains its transport path. A socket
test proves two bodies use one TCP connection and session close releases it;
destination-refusal and bounded-pin tests also pass. This efficiency change
was followed by separately recorded device observations. Current acceptance uses
short targeted checks; that historical efficiency investigation does not impose a
new sustained-duration gate.

Native samples include session identity, absolute stream positions, window
duration/default position/start time, live offset/target offset and frame counters.
Native HLS body delivery is sampled at most once every five seconds. These facts
help distinguish delivery, window timing and decoding without provider URLs or
credentials. They do not alone establish that a failure is the provider's fault.


Opt-in captures also record a closed startup stage and fixed reason if GenXtra fails
before selecting a decoder. Raw error messages, URLs, paths and account details are
not included. Earlier first-Play failures remain unclassified. Three targeted cold starts
succeeded on the historical 0.1.23 candidate 16; those observations did not
establish the cause of the earlier failures or exercise the failure branch
on a physical device, and do not verify 0.1.25.
