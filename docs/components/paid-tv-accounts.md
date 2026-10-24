# Paid TV accounts

Xtream-style accounts the viewer already pays for: credentials kept in an
encrypted vault, the provider's live channels and categories, its guide,
video on demand (movies and series), and playback through a local proxy that
cleans manifests and keeps the provider's connection limits.

## Where the code is

| Layer | Where |
| --- | --- |
| Application | `src/application/accounts/` (browsing an account's channels, account preferences and scope, the account player, Paid TV now-playing, account set-up in Settings) |
| Screens | `src/ui/accounts/` (`accounts.ts`, account management; `account-vod.ts` and `account-vod-rows.ts`, the on-demand screen) |
| Native wrappers | `src/platform/account-*.ts` |
| Native (Rust) | `src-tauri/src/accounts/` (the vault, acquisition from the provider with its Xtream reader in `account_acquisition/`, catalog queries, the guide, VOD, `account_playback_proxy.rs` with its parts) |

## Start here

- [iptv-accounts.md](../iptv-accounts.md): how accounts work and what is kept.
- `src-tauri/src/accounts/account_acquisition.rs`: reading an account.
- `src-tauri/src/accounts/account_playback_proxy.rs`: playing a channel
  through the proxy.

## Rules it keeps

XC-003–XC-040 and SC-001 in the
[Xtream interoperability audit](../research/xtream-interoperability-audit-2026-10-18.md)
and [iptv-accounts.md](../iptv-accounts.md). Credentials never leave the vault
in clear text and never appear in diagnostics.

## Tests

```powershell
npx vitest run tests/platform/account tests/application/account
npx playwright test vod-cinema paid-guide
cd src-tauri; cargo test --lib accounts::
```
