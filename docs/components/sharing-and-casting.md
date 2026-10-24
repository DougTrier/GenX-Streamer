# LAN sharing and casting

Watching on another screen. LAN sharing starts only when the viewer turns it
on: a phone pairs (view-only, encrypted, revocable) and watches or controls
what plays. Casting sends the stream to a Chromecast or DLNA receiver, through
a public-only relay when the receiver cannot reach the source itself.

Several TVs can be cast to at once (four at most), each playing its own
channel, while this device plays whatever the viewer picks next: casting
follows only the cast panel, never local playback. Choosing a TV casts the
current channel there without touching the other TVs; choosing a TV that is
already casting replaces only its cast. Each casting TV's row in the panel
shows its channel and its own Stop; Stop casting stops them all. Channels
being cast are pinned above the channel list with their TVs' names
(`src/ui/channels/cast-pins.ts`), so they top every view of it. When a TV ends
the cast on its side (Back or Home on its remote, another phone taking it
over, turned off, gone from the network), the next status check (every two
seconds) reports it ended or fails, and GenX releases that TV's session,
updates the panel and unpins its channel; the other TVs play on.
A TV on another input or in standby shows "Not on screen"; a TV that is not
casting offers its last channel again in one tap ("↻ AccuWeather").

## Where the code is

| Layer | Where |
| --- | --- |
| Domain (TypeScript) | `src/sharing/` (contracts, the service, settings), `src/casting/` (the casting controller, receiver confirmation and validation) |
| Application | `src/application/sharing/` (`sharing-and-casting.ts`, `sharing-host.ts`) |
| Screens | `src/ui/player/casting.ts` (the cast panel), `src/ui/channels/cast-pins.ts` (cast channels pinned above the list); the sharing settings live with `src/sharing/settings.ts` |
| Native (Rust) | `src-tauri/src/sharing/` (`lan/` the sharing server, its routes and the viewer page; `casting/` Chromecast and DLNA; `relay.rs`; `sharing_policy.rs`; `native_sharing.rs` with the commands) |

## Start here

- `src-tauri/src/sharing/lan/mod.rs`: starting and stopping the server.
- `src-tauri/src/sharing/lan/routes.rs`: what a paired viewer may ask for.
- `src-tauri/src/sharing/casting/mod.rs`: discovery and receiver validation.
- `src-tauri/src/sharing/casting/sessions.rs`: the cast sessions, one per TV
  (start, status, stop, closing).
- `src/casting/controller.ts`: the interface's side of those sessions, one
  per TV, each with its own queue.

## Rules it keeps

S01–S06 in [streaming-invariants.md](../streaming-invariants.md); C01–C08 in
[casting-invariants.md](../casting-invariants.md) and
[travel-casting.md](../travel-casting.md); SHARE01 and CAST01 in the
[Engineering Spec](../../Engineering%20Spec.MD).

## Tests

```powershell
npx vitest run tests/sharing tests/casting
npx playwright test lan-viewer casting-confirmation casting-multi-tv
cd src-tauri; cargo test --lib sharing::
cargo test --manifest-path src/sharing/casting/verify/Cargo.toml   # the casting code on its own
```

Packaged check: `tests/native/sharing-pause-smoke.mjs`.
