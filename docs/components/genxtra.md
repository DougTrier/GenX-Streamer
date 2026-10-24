# GenXtra

The public-domain archive library: shows and movies discovered from public
providers (Internet Archive, Library of Congress, NASA, Wikimedia Commons),
kept in a local catalog with languages, decades, types and favorites, with
artwork, downloads for offline viewing and resume.

## Where the code is

| Layer | Where |
| --- | --- |
| Application | `src/application/genxtra/` (archive discovery, downloads, the archive player, remote navigation, the library switch between Live and GenXtra) |
| Screens | `src/ui/genxtra/` (`archive-search.ts`, the GenXtra screen, with its parts `archive-search-render.ts`, `archive-search-actions.ts`, `archive-search-api.ts`, `archive-search-artwork.ts`, `archive-search-navigation.ts`, `archive-search-removal.ts`; languages, resume, downloads, the library switcher) |
| Native wrappers | `src/platform/archive-*.ts` (`archive-catalog.ts` with its types and validation in `archive-catalog-types.ts` and `archive-catalog-validation.ts`) |
| Native (Rust) | `src-tauri/src/genxtra/` (providers `archive_provider_*`, the catalog `archive_catalog.rs`, discovery, artwork, bookmarks, downloads, the library store, the playback proxy) |

## Start here

- `src/ui/genxtra/archive-search.ts`: what the screen holds and how its parts
  are created.
- `src-tauri/src/genxtra/archive_discovery.rs`: one discovery step against the
  providers.
- `src-tauri/src/genxtra/archive_catalog.rs` and `archive_catalog/search.rs`:
  how titles are stored and searched.

## Rules it keeps

Public providers only; nothing a provider says is rendered as markup;
downloads are bounded and resumable; removing a title is durable. See the
[user guide](../user-guide.md) for how it behaves.

## Tests

```powershell
npx vitest run tests/archive tests/catalog/archive tests/catalog/genxtra tests/platform/archive
npx playwright test archive genxtra library-switcher
cd src-tauri; cargo test --lib genxtra::
```
