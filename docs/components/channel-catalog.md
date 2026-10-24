# Channel Catalog

The saved channel list and everything kept with it: sources and their
channels, groups and categories, favorites, logos, countries and regions,
channel and program search, saved-channel checks, and the SQLite database
that stores it all (shared with the guide and GenXtra).

## Where the code is

| Layer | Where |
| --- | --- |
| Domain (TypeScript) | `src/catalog/` (the catalog model, M3U parsing in a worker, page by page, playlist export, provider geography, daily refresh), `src/search/` (channel search, category aliases, voice search), `src/location/` (countries and regions), `src/preferences/` (the settings model) |
| Application | `src/application/catalog/` (the channel list as shown, channel edits, logos, data transfer), `src/application/health/` (saved-channel checks and health history) |
| Screens | `src/ui/channels/` (the channel browser, channel actions, categories, region and viewing choices, provider management) |
| Native wrappers | `src/platform/catalog-query.ts`, `catalog-group.ts`, `channel-checks.ts`, `channel-logos.ts`, `records.ts`, `record-transaction.ts`, `series-identity.ts` |
| Native (Rust) | `src-tauri/src/catalog/` (catalog pages and projections, groups, logos, favorites, health storage), `src-tauri/src/database/` (the SQLite store: `storage_transaction.rs` and its parts in `storage_transaction/`, backups, recovery, leases, budgets, start-up) |

## Start here

- `src/application/catalog/catalog-view.ts`: how the list is rendered and
  settings applied.
- `src/ui/channels/channel-browser.ts`: the list itself (virtual rows, focus).
- `src-tauri/src/catalog/catalog_query.rs` and `catalog_query/query.rs`: how a
  page of channels is read.
- `src-tauri/src/database/storage_transaction.rs`: `PairStore`, the one way
  catalog data is written; its methods are spread by area over
  `storage_transaction/*.rs`.

## Rules it keeps

D01–D05 (a refresh never loses data; writes are atomic) in
[streaming-invariants.md](../streaming-invariants.md); DATA01 and the UX
requirements in the [Engineering Spec](../../Engineering%20Spec.MD). Decisions:
[SQLite storage](../decisions/sqlite-storage.md), the
[saved-channel health check](../decisions/saved-channel-health-check.md),
[daily source refresh](../daily-source-refresh.md).

## Tests

```powershell
npx vitest run tests/catalog tests/search tests/preferences tests/data-transfer
npx playwright test channel-actions catalog-empty-state saved-channel-check data-transfer region-settings source-management
cd src-tauri; cargo test --lib -- catalog:: database::
```
