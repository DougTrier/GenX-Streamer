# LAN sharing and casting

Watching on another screen. LAN sharing starts only when the viewer turns it
on: a phone pairs (view-only, encrypted, revocable) and watches or controls
what plays. Casting sends the stream to a Chromecast or DLNA receiver, through
a public-only relay when the receiver cannot reach the source itself.

## Where the code is

| Layer | Where |
| --- | --- |
| Domain (TypeScript) | `src/sharing/` (contracts, the service, settings), `src/casting/` (the casting controller, receiver confirmation and validation) |
| Application | `src/application/sharing/` (`sharing-and-casting.ts`, `sharing-host.ts`) |
| Screens | `src/ui/player/casting.ts`; the sharing settings live with `src/sharing/settings.ts` |
| Native (Rust) | `src-tauri/src/sharing/` (`lan/` the sharing server, its routes and the viewer page; `casting/` Chromecast and DLNA; `relay.rs`; `sharing_policy.rs`; `native_sharing.rs` with the commands) |

## Start here

- `src-tauri/src/sharing/lan/mod.rs`: starting and stopping the server.
- `src-tauri/src/sharing/lan/routes.rs`: what a paired viewer may ask for.
- `src-tauri/src/sharing/casting/mod.rs`: discovery and the cast protocols.

## Rules it keeps

S01–S06 in [streaming-invariants.md](../streaming-invariants.md); C01–C08 in
[casting-invariants.md](../casting-invariants.md) and
[travel-casting.md](../travel-casting.md); SHARE01 and CAST01 in the
[Engineering Spec](../../Engineering%20Spec.MD).

## Tests

```powershell
npx vitest run tests/sharing tests/casting
npx playwright test lan-viewer casting-confirmation
cd src-tauri; cargo test --lib sharing::
cargo test --manifest-path src/sharing/casting/verify/Cargo.toml   # the casting code on its own
```

Packaged check: `tests/native/sharing-pause-smoke.mjs`.
