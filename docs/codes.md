# Requirement and invariant codes

Comments and tests cite short codes such as `P09`, `LX06` or `W16`. Each code
names one rule, and the document listed here defines it, says why it exists
and how it is tested.

| Codes | Area | Defined in |
| --- | --- | --- |
| UX01–UX06, PL01–PL02, DATA01, GUIDE01, SHARE01, DIST01, CAST01, REMOTE01, REPLAY01 | Product requirements | [Engineering Spec.MD](../Engineering%20Spec.MD) |
| P01–P09 | Playback: one session per device, ownership, deadlines, truthful state | [streaming-invariants.md](streaming-invariants.md) |
| D01–D05 | Catalog and storage: refresh never loses data, atomic writes | [streaming-invariants.md](streaming-invariants.md) |
| S01–S06 | LAN sharing: explicit start, pairing, revocation, bounded resources | [streaming-invariants.md](streaming-invariants.md) |
| R01–R02 | Release packaging | [streaming-invariants.md](streaming-invariants.md) |
| C01–C08 | Casting to Chromecast and DLNA receivers | [casting-invariants.md](casting-invariants.md), [travel-casting.md](travel-casting.md) |
| G01–G08 | Program guide | [guide-invariants.md](guide-invariants.md), [guide-architecture.md](guide-architecture.md) |
| W01–W16 | Station web pages (hostile websites) | [web-viewer-invariants.md](web-viewer-invariants.md) |
| LX01–LX12, MP01–MP08 | Native lifecycle (exit, background) and the media pipeline | [lifecycle-media-invariants.md](lifecycle-media-invariants.md) |
| NV01–NV14 | Remote, keyboard and touch navigation | [navigation-invariants.md](navigation-invariants.md) |
| RP01–RP08 | Instant replay on live TV | [instant-replay.md](instant-replay.md) |
| UP-001–UP-010 | Voluntary updates: optional, approved, verified, reversible | [updates.md](updates.md) |
| MV01–MV14 | Trier MPEG Video (MPEG-2 video decoder) | [trier-mpeg-video.md](trier-mpeg-video.md) |
| MA01–MA15 | Trier MPEG (MPEG audio decoder) | [trier-mpeg.md](trier-mpeg.md) |
| INV-AUTOTUNE-001–011 | Trier's self-tuning (AutoTune) | [trier-adaptive-engine.md](trier-adaptive-engine.md) |
| XC-003–XC-040, SC-001 | Xtream-style account compatibility | [research/xtream-interoperability-audit-2026-10-18.md](research/xtream-interoperability-audit-2026-10-18.md), [iptv-accounts.md](iptv-accounts.md) |
| T001–T115 | Tasks in the original project ledger (kept private); the open ones are in [TASKS.md](../TASKS.md) | — |

Other design notes: [about-and-support.md](about-and-support.md),
[share-links.md](share-links.md),
[automatic-guide-control.md](automatic-guide-control.md),
[daily-source-refresh.md](daily-source-refresh.md),
[event-history.md](event-history.md), [native-vod-player.md](native-vod-player.md),
[vpn-indicator.md](vpn-indicator.md), [metric-requirements.md](metric-requirements.md),
and the decisions on [SQLite storage](decisions/sqlite-storage.md) and the
[saved-channel health check](decisions/saved-channel-health-check.md).
