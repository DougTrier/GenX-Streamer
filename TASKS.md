# Open tasks

Carried over from the private project on October 23, 2026. IDs match the
specification. Everything not listed was finished, accepted by the owner, or
dropped.

## Release

- ~~**T082 Android release APK**~~: done October 24, 2026.
  - The owner created the release key (`new-release-key.ps1`; fingerprint
    `464c4278…72ff`).
  - `build-android-release.ps1` signs the universal APK.
  - In-place updates on a Galaxy S25 kept settings, repeatedly.
- **T081 Clean Windows launch**: launch from a clean Windows (Windows Sandbox) as
  a standard user and from a read-only folder. The spaces/Unicode-path launch
  already passes. Retry `scripts/windows-sandbox-launch-check.ps1` after a reboot
  (sandbox sessions were dropping).
- **T084 Android notices and hashes**: produce them for the final Android APK
  (the Windows ones are done).
- **T088 Delivery**: the Windows ZIP plus the Android APK, with the user guide.
- **T085 Antivirus/EDR scan**: of the final Windows ZIP (Defender and the work
  EDR).

## Needs the owner

- **T027**: rotate an Android device while a channel plays; confirm a single
  player engine.
- **T061 / T074**: phone and browser pairing trust for sharing, and the phone
  remote.
- **T068**: sharing under a network change and a firewall refusal.
- **T071–T073, T100**: casting to real Chromecast/DLNA receivers, at home and
  away.
- **Casting to several TVs at once** (October 24, 2026): two or three of the
  owner's TVs (Sony BRAVIA, Google TV Streamer, Sansui) each playing a
  different channel while the PC plays another; Back or Home on one TV, one
  TV turned off, and another phone taking one over, each releasing only that
  TV and its pin. Fixture tests pass; not yet seen on the TVs.

## Pass It Along and Install on TV (next)

- **SH-022**: nearby sharing on Android as a foreground service with a
  notification and Stop (docs/share-links.md).
- **UP-011 resume**: resuming an interrupted update download (today it
  restarts from zero, which meets the rule; docs/updates.md).
- **Shared links, per-connection check**: enforce the public-address check on
  every connection (redirects, playlist variants, segments) for shared
  streams, not only once before playback (review finding M3,
  docs/share-links.md).
- **Install on TV, update case**: update a TV that already has an older
  official copy (needs a build with a higher version number).
- **TV to TV and TV to phone**: GenX on a TV already offers Pass It Along.
  Install on TV must leave the TV itself out of its list; then test both
  routes on the Sansui and the Streamer.
- **Scan save failure on the Google TV Streamer**: "Channels could not be
  saved" after a fresh install (October 24, 2026). The log had rolled over;
  reproduce with logging running.
- **Install counts**: GitHub release download counts are available once
  releases are public. An opt-in install count would change the privacy
  promise and is an owner decision.
- **Website**: publish `site/` (GitHub Pages) when the repository goes public;
  share links and the download page depend on it.

## Known limits

- The program-guide invariants G01–G08 have no named fixture suites yet.
- 12 shipped Rust crates (permissive licenses) have no license text in their
  packages; they are listed in the Windows notices.
