# Program Guide (EPG)

What is on and when: XMLTV guides from sources the viewer chose, matching
their listings to channels (by exact identity, reviewed aliases and the
crosswalk pack), automatic daily updates, and the guide, timeline and
selected-channel screens.

## Where the code is

| Layer | Where |
| --- | --- |
| Domain (TypeScript) | `src/guide/` (matching, coverage, categories, queries, summaries, automatic building and permissions, time) |
| Application | `src/application/guide/` (`guide-controller.ts`, automatic guide capture in a worker, the guide views, the visible guide rows) |
| Screens | `src/ui/guide/` (`guide.ts` with its parts `guide-view.ts`, `guide-reload.ts`, `guide-sources.ts`, `guide-presentation.ts`, `guide-dropdown.ts`; `guide-timeline.ts` with its parts; the selected-channel, Paid TV and channel guides; program search) |
| Native wrappers | `src/platform/guide-capture-record.ts`, `guide-grabber.ts` |
| Native (Rust) | `src-tauri/src/guide/` (the XMLTV parser, `database.rs` and its parts in `database/`, refresh and retention, the crosswalk pack, `native_guide.rs` with the guide commands) |

## Start here

- [guide-architecture.md](../guide-architecture.md): how the pieces fit.
- `src/application/guide/guide-controller.ts`: how the app keeps guides fresh.
- `src-tauri/src/guide/database.rs`: what is stored; replacing, matching and
  querying are in `database/`.

## Rules it keeps

G01–G08 in [guide-invariants.md](../guide-invariants.md); GUIDE01 in the
[Engineering Spec](../../Engineering%20Spec.MD); automatic updates in
[automatic-guide-control.md](../automatic-guide-control.md).

## Tests

```powershell
npx vitest run tests/guide
npx playwright test guide selected-guide paid-guide program-search daily-guide automatic-guide
cd src-tauri; cargo test --lib guide::
```
