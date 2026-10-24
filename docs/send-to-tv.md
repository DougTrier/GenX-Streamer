# Install on TV

**Install on TV** in Pass It Along (Android phones and tablets) puts GenX
Streamer on a Google TV or Android TV on the same Wi-Fi. The person picks
the TV, enters the code the TV shows, and approves on the TV. GenX does the
rest: no address to type, no settings to find (owner's decision, October 24,
2026).

## How it works

0. **Wake (TV-010).** A sleeping TV (its HDMI shows "No signal") shows
   nothing. Right after connecting, the TV reports whether its screen is on.
   - Only when it says off does GenX press Home, once, and wait up to six
     seconds for the screen. A TV that stays dark gets "Your TV didn't wake.
     Turn it on with its remote, then try again."
   - An awake TV is never pressed.
   - Measured on the Streamer: on in 1.3 s after Home. Wake (KEYCODE_WAKEUP)
     did nothing, and Power switched an awake TV off, so neither is used.
   - That Home wakes this Streamer does not prove it wakes every TV; the
     screen report is what GenX trusts.
   - A TV in its screensaver may still report its screen on; that case is
     not tested yet.
1. **Find.** GenX looks for TVs offering the built-in remote service: the one
   the Google TV phone app uses, `_androidtvremote2._tcp`.
2. **Pair, once per TV.** The TV shows a six-character code; the person
   enters it in GenX. GenX keeps its own key in Android Keystore and the TV's
   certificate fingerprint. **Forget paired TVs** removes both.
3. **Send.** GenX starts Share with everyone nearby (if it is not on) and
   opens GenX's file address on the TV, `http://<phone>:8080/<code>/GenX-Streamer.apk`.
   The file is checked against the TV like any nearby download (SH-009, SH-019).
4. **Watch.** The TV reports which app is in front, and the card shows one
   line for what is happening:
   - "Sending GenX Streamer…" while an app on the TV downloads;
   - "Please approve on your TV." at the installer or at Android's
     install-from-this-source setting.
5. **No download app on the TV.** Many TVs have no browser; the Google TV
   Streamer has none. Then nothing takes the link, and GenX opens the free
   download helper (Downloader, `com.esaba.downloader`) in the TV's Play
   Store: "Your TV needs a download helper. Press Install on your TV to
   continue." When the person opens it, GenX sends the file to it.
6. **Verify.** When the installer closes, GenX opens
   `genx://open?reply=<phone's nearby address>/installed` on the TV. GenX on
   the TV opens and reports the SHA-256 of its own installed file to that
   address. The card says "Ready! GenX Streamer is installed." only when it
   matches the file sent.
   - GenX coming to the front is not enough: an older copy could open instead.
     A copy that reports a different file gets "Your TV has an older GenX
     Streamer. Uninstall it on your TV, then try again."
   - One that opens but never reports gets "GenX Streamer is on your TV, but
     its version couldn't be checked."
   - A finished download without the report is said as a download.

   Then GenX disconnects and ends the nearby share it started.
7. **Several apps for links.** When the TV has several apps that open links,
   Android shows its own "Open with" list; the card says "On your TV, pick an
   app to open it." (seen on the Sansui).

Failures are one short line and one **Try Again** button: no network
details, no technical terms.

Code: `src-tauri/gen/android/app/src/main/java/com/tmg/tv/TvRemoteWire.kt`
(protocol), `TvRemoteIdentity.kt` (key and paired TVs), `TvRemotePlugin.kt`;
`src-tauri/src/sharing/send_to_tv.rs`; `src/platform/tv-remote.ts`,
`src/sharing/tv-install.ts` (the steps), `src/ui/settings/send-app-tv.ts`.
It is a module of its own: if Google changes the remote protocol, Share with
everyone nearby, the share sheet and Windows sharing are untouched.

The stages are separate, so another install route can be added beside the
current one without changing the card. The stages: find, pair, deliver the
right file, the person approves, verify. The current route is a browser or
the download helper, opened by link. A manufacturer's built-in receiver
would be another route; TCL firmware has one, which other projects use.

The connection is bounded:
- finding TVs takes at most about ten seconds;
- connecting takes 8 seconds, plus 6 for the TV's setup;
- pairing waits 60 seconds for the code;
- the TV pings every five seconds (measured on the Streamer), so 30 seconds
  of silence ends the session as "Couldn't connect."

Every network call runs off the interface thread
(`TvRemoteSession.kt`, tested against a stand-in TV).

## Rules (TV-001 to TV-010)

| Code | Rule |
| --- | --- |
| TV-001 | Pairing needs the code the TV shows, typed by the person; GenX never pairs on its own. |
| TV-002 | GenX keeps only its own key (Android Keystore) and each paired TV's certificate fingerprint and name; **Forget paired TVs** removes them all. |
| TV-003 | The person never enters an IP address, URL, port or download code in the normal Install on TV workflow. |
| TV-004 | GenX may open links on the TV but never approves anything. The only key it sends is the single Home press of TV-010, before any prompt exists. Installing the helper, allowing installs from it and installing GenX are always the person's choice on the TV. |
| TV-005 | The whole normal workflow is understandable and operable on one screen: no scrolling, no technical terms, no network setup. |
| TV-006 | "Installed" is said only after GenX on the TV reported the SHA-256 of the very file sent; otherwise the card says what is known (downloaded, an older copy, or not installed). The TV reports only to a private address with the nearby share's shape. |
| TV-007 | GenX opens only three links on a TV: its own nearby file address, the download helper's store page, and `genx://open`. Remote connections go only to private addresses and only to a TV whose certificate matches the one paired. |
| TV-008 | Install on TV is separate from the transfer: a remote-protocol failure never affects nearby sharing, the share sheet or Windows sharing. |
| TV-010 | GenX establishes that the TV is awake before opening anything: it presses Home only when the TV reports its screen off, at most once per connection, never during a prompt; a TV that does not wake within the time limit is a plain, recoverable failure. |
| TV-009 | Finding or pairing with a TV is never taken as proof that it can install GenX: each step (a download app took the link, the installer appeared, GenX opened) is established from what the TV reports. |

## Limits, plainly

- The remote protocol is Google's, unofficial and reverse-engineered by open
  projects; an update could change it. If pairing fails, Share with everyone
  nearby still shows the short address to type.
- On TVs without a browser, the download helper is needed once. Removing that
  step (a built-in receiving route on some TVs) remains a research goal.
- Tested on October 24, 2026 with a research client, on a Google TV Streamer
  and a Sansui Google TV (Realtek, Android 14):
  - discovery, pairing, front-app reports and link opening worked on both;
  - the Streamer pings every five seconds;
  - on the Sansui, a link opened Android's "Open with" list and then
    Downloader, with the address filled in.
- A read-only probe of both TVs found no built-in app receiver: only Google's
  services listen, and nothing built in except Android's installer may
  install apps.
- The Sansui has Android's Bluetooth file receiver (the Streamer does not),
  tested on October 24, 2026:
  - pairing worked and the file arrived;
  - Android asks to accept it only in a notification, which Google TV never
    shows, so the transfer is rejected after about 50 seconds.

  Not a usable route on Google TV.
- Published research found built-in app receivers only on China-market TCL
  and Xiaomi TVs.
- **First installs with GenX itself, October 24, 2026:** an S25 sending the
  official release; both verified "Ready! GenX Streamer is installed.", with
  the installed file's SHA-256 equal to the file sent.
  - **Sansui Google TV (Realtek, Android 14, 32-bit):** Android's "Open with"
    list, then the TV's own browser app, then Android's installer.
  - **Google TV Streamer (Android 14, 32-bit, no browser):** no app took the
    link, so the download helper's Play Store page opened. Then Downloader,
    the allow-installs setting, Android's installer and Google Play Protect's
    scan prompt (treated as part of the approval); Downloader removed its
    copy of the file afterwards.
- Three fixes came out of those runs (see git history): the pairing key for
  TLS 1.3, a hang in the vendored tao when a `genx://` link arrives while GenX
  runs, and "couldn't be checked" instead of guessing an older copy.
- A browser that saves the file to Downloads leaves it there; Android 11+
  lets GenX delete only its own files, so it cannot remove it.
- Still to test: an update over an older official copy on a TV.

## Testing

```bash
npx vitest run tests/sharing/tv-install.test.ts
npx playwright test tests/ui/share-links.spec.ts
cd src-tauri; cargo test --lib send_to_tv
cd src-tauri/gen/android; ./gradlew :app:testArm64DebugUnitTest --tests com.tmg.tv.TvRemoteWireTest
```

The Kotlin test checks the pairing secret against the independent research
client that paired with the Streamer.
