# Xtream / IPTV interoperability audit — 2026-10-18

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

Input: `GenX_IPTV_Xtream_Interoperability_Invariants_2026-10-18.md` (40
proposed XC invariants, external research, owner-supplied). This audit maps
each XC item to GenX's current code. XC items remain **proposals**; existing
IDs (A01–A08, W01–W15, G01–G08, C01–C08, the original 30) keep authority. No
fix is made by this document.

Live evidence: trial provider (Xtream, HTTP, one connection, 19,618 live
channels) on the Google TV Streamer, commits 42ff0b1 and 307966b.

Status key: **Covered** (code + test), **Partial**, **Missing**, **Conflict**
(today's code or an owner decision departs from the proposal).

## A. Account, security and connections

| XC | GenX today (where) | Status | Gap / forced-red to add |
|---|---|---|---|
| 001 Independent capabilities | Live import and VOD sections are separate requests; empty VOD `{}`/null reads as empty (`account_vod::rows`) | Partial | Paid TV guide not imported; no per-capability status shown; Catch-up absent. Fixture A01. |
| 002 Account ≠ playback | `inspect` reports `playbackVerified:false`; relay sniffs real media bytes (`sniff_video`); player plays only on progress | Covered (native) | UI collapses to one message (see 037). |
| 003 URL entry normalization | `endpoint()` keeps base path and port (test `request_preserves_base_port…`); form hints a pasted `get.php` link | Partial | A pasted `…/player_api.php` server address likely becomes `…/player_api.php/player_api.php`; no MAG/Stalker refusal message. Fixture A03. |
| 004 Exact credential encoding | Path-segment and query encoding; test covers `&`, `?`, `#`, `/`, space | Partial | Add `%`, `+`, Unicode cases. |
| 005 Account-state classification | Native codes: authentication-refused, inactive-or-expired, rate-limited, timeout, server-response-refused | Partial | All 401/403 read as sign-in refusal; no max-connection code; UI shows one generic message. Fixture A02. |
| 006 No unsafe redirect/origin migration | Owner decision Oct 18: provider redirects are followed (import and playback), public addresses only, no HTTPS→HTTP, nothing added, ≤5 hops; playlist-named segment servers admitted (≤8) | **Conflict (owner-approved)** | XC-006 asks to refuse cross-origin moves of the sign-in or require explicit reconfiguration. GenX sends only what the provider's own redirect contains. Proposed mitigation: show the provider's real server on the account row (visible, not silent) and record it per account. Fixture A04 keeps loopback/private/downgrade refusals. |
| 007 No secret exposure | Device vault; taint markers (`account_acquisition`); opaque relay capabilities; W13/W14 | Covered | — |
| 008 Bounded retries/pacing | Import: no automatic retry, 20 s total; relay: bounded busy backoff (30 s window) | Partial | `Retry-After` ignored for accounts. Fixture A05. |
| 009 Connection ownership | One active session; previous stopped first (`account_playback_owner::start`); import/inspect never open media | Covered | Optional: explain `active_cons` "in use elsewhere". Fixture A06. |
| 010 Scoped HTTP exception | Per-account HTTP grant with risk text; no TLS bypass | Covered | — |

## B. Catalog and M3U

| XC | GenX today | Status | Gap / forced-red |
|---|---|---|---|
| 011 Type-tolerant JSON | `id()` takes string or integer | Partial | Decimal IDs (`12.0`) refused; see 014 for row loss. Fixture C01. |
| 012 Response-shape validation | Live list must be a non-empty array; VOD accepts `{}`/null | Partial | Zero live channels (VOD-only account) fails the whole import. |
| 013 Streaming bounded ingestion | 20 MiB / 20 s per import, 100k live entries; VOD 48 MiB / 20k per section | Partial | Bounded, but large or slow providers fail outright; whole-document parse. Fixture C02. |
| 014 One bad item never destroys a list | VOD skips bad rows | **Missing (live, M3U)** | One bad live row (radio `stream_type`, duplicate id, missing name, bad category/EPG id) or one bad M3U entry fails the import. Fixture C01/C04. |
| 015 Categories independent | Unknown `category_id` → `account-category-reference-invalid` for the whole import | **Missing** | Keep the channel under "Uncategorised". Fixture C03. |
| 016 Stable identity | `stable(account,"xtream",[stream_id])`; favorites keyed by it | Covered (Xtream) | Verify M3U identity under URL rotation (V05). |
| 017 M3U syntax tolerance | Account playlist parser; malformed entry → `account-playlist-entry-invalid` | Partial | Malformed middle row fails all; BOM/CRLF/commas need fixtures (C04). |
| 018 Source-scoped headers | Fixed `TMG-TV/0.1` User-Agent; `#EXTVLCOPT` ignored | **Missing** | Fixture C05. |
| 019 Last-good refresh | Whole catalog acquired before atomic install; revision fences | Covered | Add 200-HTML-after-good fixture (C06). |
| 020 Independent adapters | Separate accounts, ids namespaced by account | Covered | — |

## C. VOD, series and playback

| XC | GenX today | Status | Gap / forced-red |
|---|---|---|---|
| 021 Missing VOD extension | Movies kept but `.mp4` guessed; episodes **dropped** without extension | Partial / Missing | No guessed extension; resolve via detail call or show unresolved. Fixture V01. |
| 022 Media bytes vs metadata | Relay classifies by bytes; codes exist | Partial | UI says "stream connection failed" for everything (037). Fixture P01. |
| 023 Series variants | Season object and array both parsed | Covered | Add sparse/empty-season fixture (V02). |
| 024 Episode identity | Provider episode id and series route | Covered (verify) | Fixture V02. |
| 025 Lazy detail requests | Series detail fetched on open | Covered (verify) | Fixture V03. |
| 026 Output-format negotiation | **Global TS-first since today** (one provider's evidence) | **Conflict (with 040)** | Per-account negotiated format: try preferred, fall back to the other advertised format on non-access failure, remember per account; never switch on 401/403. Fixture V04. |
| 027 Short-lived URLs | Xtream URLs rebuilt from sign-in; M3U URLs stored at refresh | Partial | Bounded re-resolve on expiry for playlist accounts. Fixture V05. |
| 028 One effective session | Singleton session, joined stop | Covered | Fixture V06 (500 rapid selections). |
| 029 Session affinity | Per-session capability; admitted servers per session | Covered | — |
| 030 Observed playback only | "Playing" only after engine progress; decoded evidence | Covered | — |

## D. Guide

| XC | GenX today | Status | Gap |
|---|---|---|---|
| 031 Multiple EPG mechanisms | Public guides: XMLTV pipeline. Paid TV: none (`xmltv.php` URL found, never fetched) | **Missing (Paid TV)** | Fixture E01. |
| 032 Base64/plain titles | Public XMLTV plain; Xtream short EPG unused | n/a until 031 | Fixture E02. |
| 033 Temporal authority | Public guide normalizes XMLTV offsets (G invariants) | Covered (public) | Reuse for Paid TV. |
| 034 EPG identity binding | Public: reviewed exact IDs; Paid TV stores `epg_channel_id` only | Missing (Paid TV) | Fixture E04. |
| 035 XMLTV compression | `guide/input.rs`: bounded gzip by content and header | Covered (public) | Reuse. |
| 036 Last-good EPG | Public retention keeps previous window | Covered (public) | Reuse. |

## E. Operations and scope

| XC | GenX today | Status | Gap |
|---|---|---|---|
| 037 Specific failures | Native codes are specific; account form and player show one generic message each | **Missing (UI)** | Map codes to plain, specific messages. |
| 038 Bounded storage | Storage audit Oct 18 (`artifacts/storage-audit`) | Covered | Paid TV guide will need the same bounds. |
| 039 No bypass behavior | No DRM/geo/CAPTCHA/portal work | Covered | — |
| 040 Provider profiles | Today's TS-first is global | **Conflict** | Resolved by the 026 fix (per-account). |

## Proposed batches (fixtures fail first, then fix)

0. **Format negotiation per account** (XC-026, XC-040): undo the global TS-first; per-account preferred format with bounded fallback on non-access failures; remembered. Fixture V04.
1. **Catalog tolerance** (XC-011, 012, 014, 015, 017, 021 episodes): count-and-skip bad rows, "Uncategorised", decimal IDs, VOD-only accounts, extension-less movies/episodes resolved at play time. Fixtures C01, C03, C04, V01.
2. **Specific messages** (XC-005, 022, 037): account form and player show what failed (sign-in, expired, busy, not video, server moved). Fixtures A02, P01.
3. **Paid TV guide + EPG link field** (XC-031–036): Xtream `xmltv.php`, M3U `url-tvg` or the new field, exact `epg_channel_id` mapping, existing retention and gzip bounds. Fixtures E01–E06.
4. **Scale** (XC-013, 025): category-by-category import, progress-based time budget. Fixtures C02, V03.
5. **Headers and expiring links** (XC-018, 027, 008): source-scoped User-Agent/Referer, bounded re-resolve, `Retry-After`. Fixtures C05, V05, A05.
6. **Entry and transparency** (XC-003, 004, 006 mitigation): pasted `player_api.php`, credential edge cases, show the provider's real server on the account row.

Out of scope until asked: Catch-up/timeshift, MAG/Stalker portals, VPN/proxy routing.

## Progress

- **Batch 0 done (d9f535a):** XC-026/XC-040 — per-account format, one
  evidence-based fallback. Provider error codes are never interpreted (they
  differ between providers); only real video delivered counts.
- **Batch 1 done:** XC-011 (whole-number decimal IDs), XC-014/XC-017 (bad live
  rows and malformed M3U entries are skipped and counted; whole-document
  problems still refuse, and an empty list stays refused to protect XC-019),
  XC-015 (unknown group → "Uncategorised"), XC-021 (no guessed `.mp4`;
  extension-less movies resolve via `get_vod_info` at Play, episodes stay
  listed with a plain refusal). The refresh message states how many entries
  were left out. An M3U entry on another server is skipped and counted
  pending an owner decision under XC-006.
- Later research (owner idea): adaptive buffering that steps the live buffer
  up when stalls repeat and back down once stable.

## Cross-source live-stream invariants (proposed, owner-forwarded)

- **SC-001 Recoverable live interruption.** A transient EOF, socket drop or a
  live stream that ends starts bounded recovery; success needs newly observed
  progress, not just a reconnect. Implemented: the engine passes a live `ended`
  on as "ended" (it was a final error), and the controller reconnects through
  its bounded path (two retries, buffering deadline); progress is required to
  return to Playing. Free TV, Paid TV and Local direct streams share it.
- **SC-002 Keep valid stream evidence during recovery.** A retry of the same
  authorized address keeps its known format instead of re-probing (a probe is
  a second provider connection). A different address is checked again.
  Implemented in `playback/controller.ts` (forced-red test first).
- **Reconciled:** reconnect while the provider still counts the previous
  connection. A reconnect now gets the selection's own startup budget (paid
  live 35 s, covering the relay's 30 s busy wait); free channels keep 20 s.
  One-slot fixture tests in `tests/playback/controller.test.ts`. Buffering and
  reconnection stay separate mechanisms.
- **Field note (Streamer, Bears game):** after a stall the hold resumed with
  ~6 s buffered, which then drained at about two-thirds of real time: the
  provider delivered slower than the stream plays (Wi-Fi -40 dBm, 130 Mbps).
  More buffering only spaces such stalls out.
- **Adaptive live buffering** (owner request): after a stall, playback waits
  for a target lead (profile floor 1/3/6 s, raised ×1.6 per stall, at most
  20 s, kept for that channel this run, never lowered); a hold ends by itself
  after 12 s, inside the player's deadline. Live only.
