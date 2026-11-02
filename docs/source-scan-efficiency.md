# Avoiding repeated source work

Included-source scans preserve the complete playlist when a publisher offers both
a complete index and documented filtered copies. For IPTV Nexus, its
[published contract](https://github.com/dearbulut/iptv#quick-start) says `index.m3u`
contains every stream, while `best.m3u` and `online.m3u` are filtered versions.
When the complete index is selected with the same HTTP permission, the scan skips
those two subsets. Choosing the curated lists without the complete index still
works. Other hosts, query-bearing URLs and differing permissions are retained.
This changes the scan plan, not saved channels, favorites or source configuration.

An October 31, 2026 audit of the local Thor configuration found 12 included
channel providers and 103 guide suggestions. The fetched `best` and `online`
documents contained 10,308 and 8,467 entries respectively, all present in `index`
with identical entry metadata and guide headers. Skipping both avoids 18,775
repeated candidate entries in that snapshot; elapsed-time savings depend on the
network and scan. Other large lists contributed unique endpoints and remain.
Included README templates on reserved example domains and literal `FILENAME.m3u`
links are skipped automatically; explicit custom sources remain available.

Exact document requests are deduplicated with queries and HTTP permissions
preserved. Guide discovery keeps a bounded cache of parsed playlist header links
for one operation, so identical playlist aliases are read once while retaining
each source's outcome and name. It retains no complete playlist bodies in this
cache. XMLTV suggestions already merge by exact location. Combined worldwide and
country guide feeds are not removed merely because they overlap: unique station
IDs, schedules, coverage and existing mappings must be preserved.

After source documents are parsed, the native scan counts distinct transport
targets before probing. Identical URLs share a result only within the same HTTP
permission, device platform, playback profile and probe budget. Signed query
strings remain significant. Channel names, guide mappings and source provenance
remain separate, and different backup addresses remain available. Concurrent
aliases wait for the same probe instead of opening duplicate requests.

Shared observations retain their original timestamps. Continue restores validated
observations from that job; a new scan starts with an empty transport registry.
Each recipient still requires its own current source, permission and publication
checks. Refresh separately uses stored health: unchanged working entries are
normally trusted for seven days, while explicit full recheck bypasses that cache.
Playlist disappearance marks source membership unavailable; it does not itself
delete a saved channel or prove that its stream stopped working.

Automatic cleanup runs during a full Refresh or Rescan with an empty search over
the configured sources. It first captures the current library and source grants.
Every applicable list must then finish a complete, fresh promotion. Failed,
partial, unknown or unrefreshed coverage keeps the saved channels. Continue,
Slow checks and selected-source/search subsets do not authorize removal.

Cleanup compares every saved address, including backups, with every address in
the refreshed lists. Listed addresses, possible replacement entries, favorites
and recent working evidence are retained. Only genuinely missing candidates need
additional checks: one pass has a 20-second total network budget and checks at
most 256 unique targets. Unfinished candidates remain for a later Refresh.
Every address of a channel must have current, local, target-bound HTTP 404/410
evidence before it can be archived. Auth errors, busy servers, timeouts,
unsupported formats and failed HLS keys or segments do not establish that its
stream address is dead.

Removal updates the canonical removed-channel preferences and their derived
views together, with backup and revision checks; the channel data is retained.
Use Restore removed channels in Settings to bring an archived entry back.
Cleanup is deferred visibly while playback or a retained playback choice is
active, including paused playback and Web pages. Normal list refresh can still
continue. Source/root changes, cancellation and newer working observations
prevent stale cleanup from removing a channel.

## Cooperative scan and visible lists

The saved scan queue remains in SQLite and is read, checked and published in bounded batches. Stop/Continue does not require rebuilding the whole candidate list or treating another device's observations as local playback proof. Work yields between batches, and ordinary publication defers broad channel-window reconstruction and automatic Guide reconnection instead of repeating them for every committed batch. The scan-end handoff performs the required reconciliation once. It does not claim that an uncompleted source has complete coverage.

Channel-list updates preserve the browsed channel and scroll offset when that identity survives. The Guide keeps already mapped rows usable while an owned read catches up to a newer catalog revision, with coalesced retries and current native scope checks. New mappings from a scan are admitted by the scan-end Guide reload/build. Selection-only tuning reuses an assembled normal page model when its catalog/location scope and model epoch are unchanged; it does not suspend the grid or reread every source/mapping. Actual configuration changes and advanced/single-channel views still reload. Compact layouts intentionally hide the preview while browsing; after a successful Free or Paid Guide Watch, the current foreground page returns to visible playback, while TVs retain their visible mini player and Guide. A newer page intent cancels that presentation handoff.

## Guide cache and location scope

Program schedules and mappings already use the local SQLite guide database; no separate SQL cache table or full catalog scan is needed to open saved listings. A per-open-store inventory cache avoids recomputing whole-catalog endpoint grouping for each 1,024-channel Guide page. It retains at most 100,000 rows and 16 MiB, falls back to bounded uncached pages when that budget is exceeded, and never publishes a partial result after cancellation. Catalog, view, Guide, root/file identity, grouping policy, location, search and time-window fences prevent stale reuse. Unrelated health commits do not force the same unchanged inventory to be regrouped.

Free Guide membership inherits the channel browser's declared country/region/state scope before alias grouping; category facts are derived only from matching aliases. Country aliases such as US/USA resolve through the existing metadata normalizer. Paid Guide inherits country choices from the provider's original groups, while absent location remains Unknown. Guide/program search can use available titles, descriptions and categories in addition to channel names. Overlapping feeds are retained when they contain distinct useful schedules or identities; matching a channel name alone does not justify dropping one.

Approved Free URL feeds and a selected Paid account's already cached guide are due for renewal about every three hours, independently of channel-scan cadence. The existing foreground scheduler defers acquisitions during playback, while Guide is in use or while other work owns the resources, and cancels/joins a running automatic acquisition when viewing needs them. It does not run after the app closes. Free feeds keep conditional validators; Paid renewal fetches guide metadata, not a media stream. Saved permission, due time, cache/account revision and publication checks are revalidated natively. Failed, expired or canceled automatic responses retain the last good schedule; a manual update remains available.

Release validation uses bounded regression cases and targeted device playback.
A complete catalog scan can be performed by the owner after receiving the
verified build and does not block the release. Playback quality gates still
require five minutes of sustained playback on the selected test channels.

The raw source-list audit documents remain in ignored local test artifacts.
That list-comparison audit used no Paid TV account data or channel media requests.
