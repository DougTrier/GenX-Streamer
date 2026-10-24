# Browser

Web pages the app shows itself. A station that only streams from its own
website plays in GenX's viewing area through that website's player, in a
WebView kept apart from the app (no access to its data, its commands or the
viewer's other pages). The fixed donation and author pages also open through
here.

## Where the code is

| Layer | Where |
| --- | --- |
| Native (Rust) | `src-tauri/src/browser/` (`web_page.rs`: opening, showing and closing a station page; `donation.rs`: the fixed destinations) |
| Page scripts | `src-tauri/page-scripts/` (scripts injected into station pages: guarding the page, showing only the video, preferring H.264, hiding ads) |
| Android | `WebPagePlugin.kt`, `WebPageService.kt`, `PageController.kt` |

## Start here

- [web-viewer-invariants.md](../web-viewer-invariants.md): what a hostile
  website must never be able to do, and how each rule is tested.
- `src-tauri/src/browser/web_page.rs`.

## Rules it keeps

W01–W16 in [web-viewer-invariants.md](../web-viewer-invariants.md); the
support links in [about-and-support.md](../about-and-support.md).

## Tests

```powershell
npx playwright test hostile-pages station-video-only about-support
cd src-tauri; cargo test --lib browser::
```
