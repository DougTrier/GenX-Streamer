# Saved-channel health check and a week of scan trust

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

Date: October 19, 2026. Decided by the owner.

## Context

The owner asked whether a second full scan has to retest every channel, or whether GenX could keep the channels it has and probe them to make sure they are still alive.

A scan already re-downloads the source lists and checks only due streams: new or changed ones, failures after 5 minutes, and good checks older than 24 hours. Duplicate streams are checked once, and Full recheck checks everything. What was missing was a way to find saved channels that have stopped working without running a scan, and to act on them.

## Decision

"Yes: build the saved-channel health check (Not responding mark after two failed days, filter, Remove dead channels, never auto-delete) and let full scans trust a good check for a week."

- **Quiet check** (`src/application/saved-channel-check.ts`). While GenX is open and in front, and nothing is playing, connecting or scanning, it checks saved Free TV channels about a dozen at a time, two at once. Each channel is checked at most once every 20 hours. Failing channels go first, then channels never checked, then the oldest checks. Channels sharing one stream address are checked once. The check is the scan's own stream check (`inspectStreamEvidence` in `src/main.ts`): it yields to playback and keeps each site's pacing and Retry-After. It starts 90 seconds after start-up and rests 15 seconds between batches and 30 minutes when nothing is due. A saved channel that plays here is recorded as working.
- **Native store** (`src-tauri/src/database/channel_check.rs`). The table `channel_check_v1` is created lazily on the first write (no schema migration), with one row per saved channel. A response clears the failure streak; a failure starts or extends it. Times come from the native clock, never the page. Rows of channels no longer in the catalog are dropped.
- **Not responding.** A channel is Not responding when it failed at least 20 hours apart with no response between. Measuring 20 hours ("two different days") needs no time zone. One response clears the mark.
- **No false marks while offline.** A device that reports itself offline records nothing. When nothing in a batch answered, the channel that answered most recently is checked too; if it fails as well, the whole batch is discarded as a connection problem.
- **What the viewer sees.** Marked rows read "Not responding · News". The category menu gains "Not responding · N", shown only when N > 0 and only in Free TV. In that view, a strip offers "Remove all N" ("Remove it" for one). Removal uses the ordinary channel removal, so Settings → Restore removed channels brings them back.
- **Never automatic.** Nothing is removed or hidden without that tap.
- **Scan trust.** A stream that answered a scan is now trusted for 7 days, up from 24 hours (`POSITIVE_TTL` in `source_snapshot_activation.rs`, and the matching `positive_ttl_ms` bound). The daily quiet check covers saved channels in between. Failures are still retried after 5 minutes, and Full recheck still checks everything.

## Consequences

- A second scan is mostly a list download plus checks of new or changed streams. Saved channels are watched daily while GenX idles, rather than retested by every scan.
- A channel whose site blocks this device but plays elsewhere can be marked (Access denied or Unsupported here count as failures). It is only a mark, and removal can be undone.
- Paid TV accounts are not checked; their channels come from the provider.
- The checks use the network only while nothing plays. On a TV left playing all day, checks happen in pauses and when GenX sits idle.
- The table lives in the same SQLite database, so the app's own database backups carry it; the JSON export does not. It is observational and rebuilds itself within a day or two.
