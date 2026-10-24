# Components

GenX Streamer is built from eleven components. Each page below says what the
component does, where its code lives in each layer, where to start reading,
which requirement codes it must keep, and how to run only its tests. Pick the
component you want to work on; you do not need to know the rest of the app to
make a change there.

| Component | What it does | Native folder (Rust) |
| --- | --- | --- |
| [Channel Catalog](channel-catalog.md) | The saved channel list: storage, pages, groups, favorites, logos, search, channel checks | `catalog/`, `database/` |
| [Source Discovery](source-discovery.md) | Finding channels: playlist and website scans, stream checks, resumable scans, imports | `discovery/` |
| [Playback Engine](playback-engine.md) | Playing a channel or title: one session at a time, hls.js and native players, buffering, replay | `playback/` |
| [Trier MPEG](trier-mpeg.md) | GenX's own MPEG-2 video and MPEG audio decoders, and their self-tuning | `trier_video/` |
| [GenXtra](genxtra.md) | The public-domain archive library: discovery, catalog, artwork, downloads, playback | `genxtra/` |
| [Program Guide (EPG)](program-guide.md) | XMLTV guides: sources, matching listings to channels, the guide and timeline screens | `guide/` |
| [Browser](browser.md) | Web pages the app shows: a station's own player, isolated from the app | `browser/` |
| [Paid TV accounts](paid-tv-accounts.md) | Xtream-style accounts: the vault, channels, guide, video on demand, the playback proxy | `accounts/` |
| [LAN sharing and casting](sharing-and-casting.md) | Watching on other devices: the sharing server and pairing, Chromecast and DLNA | `sharing/` |
| [Platform adapters](platform-adapters.md) | What differs between Windows and Android: start-up, closing, speech, VPN, renderer recovery | `platform/`, `commands/` |
| [UI components](ui-components.md) | The screens, the shell, remote navigation and the stylesheets | — |

Where the layers are:

- Interface (TypeScript): domain code in `src/<area>/`, the application's
  wiring in `src/application/<component>/`, screens in `src/ui/<screen>/`,
  typed calls to the native layer in `src/platform/`.
- Native layer (Rust): `src-tauri/src/<component>/`. Each folder's `mod.rs`
  says what it holds; `lib.rs` re-exports every module under its own name, so
  code refers to them as `crate::<module>`.
- Android (Kotlin): `src-tauri/gen/android/app/src/main/java/com/tmg/tv/`.

[ARCHITECTURE.md](../../ARCHITECTURE.md) explains how the layers talk to each
other, and [CONTRIBUTING.md](../../CONTRIBUTING.md) how to make and check a
change.
