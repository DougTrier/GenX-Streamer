# Open tasks

Carried over from the private project on October 23, 2026. IDs match the
specification. Everything not listed was finished, accepted by the owner, or
dropped.

## Release

- **T082 Android release APK**: create a permanent release key (owner-held,
  never committed), sign a stripped release build, and confirm that installing
  it over the current app keeps settings.
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

## Known limits

- The program-guide invariants G01–G08 have no named fixture suites yet.
- 12 shipped Rust crates (permissive licenses) have no license text in their
  packages; they are listed in the Windows notices.
