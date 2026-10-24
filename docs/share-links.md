# Share links

Two ways to pass GenX Streamer on (owner's idea, October 24, 2026):

- **Share what I'm watching.** The **Share** button beside the playing channel
  sends "Watch News 24 on GenX Streamer: <link>" through the system share
  sheet. The link opens GenX Streamer where it is installed and plays the
  channel on one tap; elsewhere it opens a small web page that says what was
  shared and how to get GenX Streamer.
- **Send app to a friend.** A button in the Settings header (and **Share
  GenX Streamer** in About) opens **Pass It Along** ("Too rad to keep to
  yourself."), one page with every way to pass GenX on, like a mixtape handed
  to a friend: the installed app itself (the APK phone to phone on Android,
  GenX Streamer.exe on Windows), **Share with everyone nearby**, the download
  link by text or message, or the link to copy (`src/ui/settings/send-app.ts`).
  The app carries the means of its own distribution: no store, website or
  link needed, which Apache-2.0 redistribution allows.

## The link

```
https://dougtrier.github.io/GenX-Streamer/watch/#v=1&c=ch&n=News+24&s=<stream>&l=<logo>
https://dougtrier.github.io/GenX-Streamer/watch/#v=1&c=gx&n=His+Girl+Friday&t=<title reference>
genx://watch?v=1&c=ch&n=...            (the same fields; the app's own scheme)
```

| Field | Meaning | Rule |
| --- | --- | --- |
| `v` | Format version | `1`; anything else says "update GenX Streamer" |
| `c` | Kind | `ch` a Free TV channel, `gx` a GenXtra title |
| `n` | Name | Visible text only (controls, zero-width and bidirectional marks removed), 1–120 characters |
| `s` | Stream (`ch`) | http or https, at most 2,048 characters, no credentials, a public host, a stream-like path |
| `l` | Logo (`ch`, optional) | https, no port or credentials, a public host; dropped if invalid |
| `t` | Title reference (`gx`) | 64 lowercase hex characters: the archive item's fingerprint (`archive_provider_contract::title_ref`), the same on every device |

Unknown or repeated fields make the link invalid. The fields travel in the
fragment (after `#`), which browsers never send to the page's server, so
GitHub Pages never sees which channel was shared. The link carries nothing
about the sender, their device, network or accounts.

Code: `src/sharing/share-link.ts` (building and reading), tested in
`tests/sharing/share-link.test.ts`.

## Paid TV is never shared

Paid TV stream addresses contain the account's user name and password.

- There is no Share button for Paid TV: it is hidden while a Paid TV channel,
  movie or episode is selected (`src/application/sharing/share-links.ts`).
- The link builder refuses any address that looks like an account's:
  credentials in the address, Xtream-style paths (`/live/<user>/<password>/…`
  and the movie, series and catch-up forms), and query fields that carry an
  account, session or signature (`username`, `password`, `token`, `mac`, …).
- An incoming link is held to the same rules, so a crafted link cannot carry
  an account address either.
- A shared Free TV channel uses its saved playlist address, never one a server
  handed this device for its own session.

## Incoming links are untrusted

An incoming link is checked like a scanned source, and more:

1. The native layer admits only its outer shape: `genx://watch` or the page
   address, at most 6,000 characters, no spaces or control characters
   (`share_links::admit_link`, `SharePlugin.kt` `IncomingLink.admit`). A link
   is never placed into page script: the page is told one is waiting and asks
   for it (`take_incoming_link`).
2. The interface reads every field (`parseShareLink`) and shows names as text.
3. `check_shared_destination` resolves the stream's (and logo's) host and
   refuses it unless every address is public (`sharing_policy::public_upstream`),
   so a link can never point GenX at the viewer's own network. The logo is
   shown only after that check.
4. The card says "<name> was shared with you" with **Play** and **Add to
   favorites**. Nothing plays or is saved until one is chosen.
5. Play and Add to favorites check the stream once more
   (`inspect_media_resources`) and explain a failure plainly: gone (404/410:
   moved or ended), refused (401/403/451: some channels only play in certain
   countries, or need a fresh link), the server not answering, not found, or
   not a stream GenX can play.

A played shared channel that is not in the saved channels is playable while
GenX runs (the sharing host's `extraChannel`, like local radio); plain HTTP is
allowed only for that chosen stream. **Add to favorites** saves it as its own
one-channel source, exactly what adding the address under Add channels makes,
so a later refresh keeps the channel and its favorite. A GenXtra title opens in
GenXtra and plays its first playable file; if this device's library does not
have the title yet, GenXtra shows a search for its name instead.

## Opening GenX from a link

**Android** (`AndroidManifest.xml`, `SharePlugin.kt`): two intent filters on
the main activity, the page link (`https://dougtrier.github.io/GenX-Streamer/watch…`,
`autoVerify`) and `genx://watch`. The page link opens GenX directly only once
Android has verified the site belongs to the app (App Links). That needs a
Digital Asset Links file at the domain root,
`https://dougtrier.github.io/.well-known/assetlinks.json` (served by the
`DougTrier.github.io` user-site repository, not this project site), with the
release key's SHA-256 fingerprint:

```json
[{"relation":["delegate_permission/common.handle_all_urls"],
  "target":{"namespace":"android_app","package_name":"com.tmg.tv",
            "sha256_cert_fingerprints":["<release key fingerprint>"]}}]
```

The release key is the owner's; the file is not in this repository. Until it
exists, Android opens the page, whose **Open in GenX Streamer** button uses
`genx://`, which works without verification.

**Windows** (`src-tauri/src/sharing/share_links/windows_links.rs`): the
packaged GenX Streamer.exe registers `genx://` for the current user
(`HKCU\Software\Classes\genx`) to its own path at each start, so a moved
portable copy still opens links. Development builds (another file name) and
isolated test profiles (`TMG_DATA_DIR`) never touch the registry. Windows
starts GenX with the link as its argument; when a copy is already running, the
new process hands the link to it through a hidden message window and ends, so
the saved data keeps one owner. This is what Tauri's deep-link and
single-instance plugins do; their current releases need Tauri 2.12 and GenX
pins 2.11, so GenX does it with the Windows bindings it already has. Windows
cannot open `https://` links in a desktop app without packaging, so on Windows
the page's **Open in GenX Streamer** button is the way in.

## The share sheet

The Share button opens a card first: the link as a QR code (to scan from a
TV across the room), the link with **Copy**, and **Send…** for the share sheet.
The QR code is GenX's own encoder (no library, no web service); a link too
long for a code keeps Copy and Send.

- **Android**: `ACTION_SEND` through the system chooser (Quick Share, Nearby,
  Bluetooth, messaging apps). Many TVs have no app that takes shared text;
  then the card says so and the code and Copy remain.
- **Windows**: Windows' own share (`IDataTransferManagerInterop`, as desktop
  browsers use for `navigator.share`): Nearby Sharing, mail, messaging apps.
  Where it is unavailable, the card shows the link with **Copy**.

A shown share sheet is not proof that anything was sent.

## Sending the app itself

Only an official release copy sends its own app file (owner-approved,
October 24, 2026): on Android the installed copy must be signed with the
owner's release certificate (`RELEASE_CERTIFICATE_SHA256` in
`src-tauri/src/platform/app_identity.rs`, the owner's key since October 24,
2026) and installed as one APK. Development copies
offer the download link and its QR code instead. Windows is unsigned by
decision, so its exe can be sent; the checksum is its check
([verify-a-download.md](verify-a-download.md)). The native layer enforces this
too (`share_app_file`, `nearby_start`), not only the page.

Pass It Along also shows the download page as a QR code, and on Windows offers
the Windows portable ZIP's link (on the release page).

- **Android**: the installed copy's own APK (`applicationInfo.sourceDir`),
  copied to the app's cache and offered through the existing FileProvider as
  `application/vnd.android.package-archive`. Android Beam (NFC) was removed in
  Android 10, so Quick Share or Bluetooth is the phone-to-phone path. The
  receiver is told: "open the received file and, when asked, allow Files or
  Quick Share to install apps." A copy installed as split APKs (from a store
  bundle) cannot be sent as one file, and says so.
- **Windows**: GenX Streamer.exe through Windows' share. The receiver is told
  that Windows may call it an unknown publisher (GenX ships unsigned on
  Windows by decision): More info, then Run anyway.
- **The download link**: https://github.com/DougTrier/GenX-Streamer/releases/latest.
  The repository is private until the owner publishes it; until then the link
  does not work for others.

**Signatures.** Development APKs are debug-signed, and an APK sent from a
phone carries that copy's signature. A later release-signed build will not
install over it; the receiver must uninstall first (which removes their saved
channels: back up first).

## Install on TV

Android phones and tablets can put GenX on a Google TV or Android TV through
the TV's built-in remote service: the person enters the code the TV shows and
approves on the TV, and GenX opens its nearby file address there. See
[send-to-tv.md](send-to-tv.md) (TV-001 to TV-008).

## Share with everyone nearby

For a room full of friends (watching the game at home): GenX serves itself on
the local Wi-Fi for ten minutes (`src-tauri/src/sharing/nearby_download.rs`,
`src/ui/settings/send-app-nearby.ts`).

- Only when the viewer chooses **Start sharing nearby**; it ends after ten
  minutes, on **Stop sharing**, or when GenX closes.
- The page shows a QR code (`src/sharing/qr-code.ts`, GenX's own encoder,
  checked by decoding with OpenCV in `tests/tooling/test_qr_code.py`) and the
  address, `http://<this device>:8080/<six-digit code>` (another port when
  8080 is taken), short enough to type with a TV remote. Friends scan it with
  their camera or type it; their browser (on a TV, its browser or download
  app) opens a small "Get GenX Streamer" page and downloads the app. No
  internet, store or GenX on their side is needed.
- Every session has a fresh, uniformly random six-digit code (owner's
  decision, October 24, 2026: easy to type everywhere, and safe enough for
  people in the same room). Without it nothing is found. A device that tries
  five wrong codes is no longer answered, and twenty wrong codes from anyone
  end the session ("someone kept trying wrong codes"), so guessing finds the
  code first at most once in 50,000 sessions
  (`src-tauri/src/sharing/nearby_download/guard.rs`). Only local clients
  (private, shared or link-local addresses) are answered; at most eight
  connections at a time and three per device, bounded request heads, read
  and write deadlines.
- The page is written for the device that asks (SH-009, SH-011, SH-019,
  SH-020; `src-tauri/src/sharing/compatibility.rs`): an Android phone or TV
  gets the APK with its requirements; a device that cannot be told gets a
  plain warning first; an iPhone or a PC is told the file won't run there
  and is not handed it (the file address refuses it too). The APK is offered
  for what it holds, read from the file itself (`apk_contents.rs`). The page
  shows the file's SHA-256 and, on Android, the official signing fingerprint
  (SH-025). Interrupted downloads resume (HTTP `Range` with `If-Range` on the
  file's SHA-256), never against another file.
- The session ends when this device leaves the network it shared on (SH-021),
  and the sharer is told.
- It serves the installed app itself (Android: the APK in its own install
  folder; Windows: the running exe), never a second copy, and nothing else:
  no settings, channels, accounts or history. The page names nothing about the
  sharer.
- The sharer sees how many devices opened the page and how many downloads
  finished ("Totally tubular! 2 friends are ready to rock.").
- Receivers approve the install themselves: Android's installer asks (and
  asks to allow the browser or Files to install apps); Windows asks to run an
  app from an unknown publisher.

Limits, plainly: it is plain HTTP on the local network, so another device on
the same Wi-Fi could in principle tamper with a download; Android's installer
then still requires a valid signature, and **Check for updates** verifies
official releases against GitHub. It needs a shared Wi-Fi: guest and bar
networks that keep devices apart (client isolation) will not work, and other
phones cannot be notified (no app can push a notice to a stranger's phone;
the QR code is the invitation). The next step for those places is a
temporary hotspot on the sharer's phone (Android's local-only hotspot, with a
Wi-Fi QR code to join), which needs testing on devices.

## Rules for passing the app on (SH-009 to SH-025)

The device that receives GenX decides which build it needs; the sharing
device never assumes (owner, October 24, 2026). The research behind these
rules (Briar, Knit, F-Droid Nearby, LocalSend, TrebleShot, LocalShare) is in
the owner's private notes.

| Code | Rule |
| --- | --- |
| SH-009 | Never offer a package known to be incompatible with the receiving device. |
| SH-010 | A universal Android APK contains every architecture it is offered for (arm64-v8a and armeabi-v7a); the release build and packager refuse it otherwise. |
| SH-011 | Unknown compatibility is disclosed, never assumed. |
| SH-012 | Downloads are chosen only from verified, published release files. |
| SH-013 | Offline sharing never depends on an internet page. |
| SH-014 | Cross-platform offline sharing fails plainly when the right package is not on this device. |
| SH-015 | The person receiving approves every download and installation. |
| SH-016 | Installing keeps the publisher's original signing identity (no re-signing; split installs are not shared). |
| SH-017 | A package is shared only after its integrity, publisher identity (where the platform has one) and declared compatibility are verified. |
| SH-018 | A kept package is verified again before it is offered. |
| SH-019 | No sharing method knowingly delivers an incompatible build. |
| SH-020 | When compatibility cannot be established, the uncertainty is shown and the person confirms. |
| SH-021 | Stop, expiry, exit or a network change closes the nearby listener: the port refuses connections. |
| SH-022 | On Android, a nearby session runs as a foreground service with a visible notification and Stop. |
| SH-023 | A nearby session listens only on the chosen local address and answers only local clients. |
| SH-024 | Every nearby session has a fresh random code (six digits, guessing locked out and capped per session) and fresh hotspot credentials when it makes one. |
| SH-025 | The download page shows the file's SHA-256 and, for Android, the official signing fingerprint. |

Android tells only an installed app its exact architecture; a browser does
not (its user agent is a claim, and a frozen one on Android). So browsers get
the universal APK with its requirements stated, an iPhone or a PC is never
offered an APK, and anything else is told plainly.

## The web page

`site/watch/index.html` (with its icon) is ready for GitHub Pages at
`https://dougtrier.github.io/GenX-Streamer/watch/`; it is not published. It
reads the fragment, checks it by the same rules, shows the name as text,
fetches nothing from the shared link, and offers **Open in GenX Streamer**
(`genx://`) and **Get GenX Streamer**. Its script runs under a
Content-Security-Policy hash: after editing the script, update the
`sha256-…` value (`tests/ui/share-links.spec.ts` fails if they differ).

## Tests

```powershell
npx vitest run tests/sharing/share-link.test.ts
npx playwright test share-links share-button about
python -B -X utf8 -m unittest discover -s tests/tooling -p test_qr_code.py
cd src-tauri; cargo test --lib share_links nearby_download
```

Android: `IncomingLinkTest.kt` (the link shape); the share sheet, intent
filters and APK sending need a device.
