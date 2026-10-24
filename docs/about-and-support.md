# About and support

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

Settings contains an **About GenX Streamer** button. The modal shows the native app version returned by Tauri on Windows/Android, or the package version explicitly labeled as a browser development preview. A failed native version lookup displays an unavailable message rather than a guessed version.

The offline quick guide covers sources, watching and removing channels, XMLTV matching and seven-day program search, screen controls, compatible casting, supported remote navigation, and explicit Windows LAN viewing/phone pairing. Its close control remains outside the scrolling content. Escape/Back returns to the settings opener through the existing modal navigation owner.

**Share GenX Streamer** (above the support cards) sends the download link through the share sheet or copies it, and sends the installed app itself: the APK on Android, GenX Streamer.exe on Windows. See [share-links.md](share-links.md).

The support message is: **If you enjoy the application, please support the project.** Destinations were retrieved from [Trier OS funding configuration](https://github.com/DougTrier/trier-os/blob/main/.github/FUNDING.yml) on October 10, 2026:

- GitHub Sponsors: https://github.com/sponsors/dougtrier
- Buy Me a Coffee: https://www.buymeacoffee.com/dougtrier
- Open Collective: https://opencollective.com/trier-os

Native browser opening accepts only the three fixed target IDs; imported metadata cannot provide URLs or launch commands. Windows uses the existing Windows API dependency and Android uses ACTION_VIEW through the existing native plugin. No new npm/crate dependency or generic opener permission is introduced. The OS launch acknowledgment does not claim that a page loaded or a donation succeeded. Failed launch messages are static, with visible selectable addresses for manual use. No support website is contacted until the user selects a support button.

Validation: `tests/ui/about.spec.ts` covers actual bundled version/help content, support destinations, paused player preservation, nested modal focus return, and reachable close/support controls at 360×480, 640×360 and 1280×800 with enlarged text. `tests/ui/about-support.spec.ts` separately exercises the native UI boundary with an injected platform version, bounded repeated clicks, redacted failure, retry and disposal. Injected platform tests do not establish installed OS browser launch; native source/build evidence is recorded separately in implementation progress.

October 10 native proof: fresh Windows and installed Flip2 Android development apps show actual version0.1.0 and pass ordinary About navigation/content, unknown-target refusal, unchanged data and normal cleanup. Exact receipts and retained failure chains are in implementation progress. Native source validation passes274 Rust tests (2 existing ignored), strictClippy/ARM64 and18 Kotlin tests. Live external page opening and payment were not exercised.
