# Signing Android releases

**Release status:** 0.1.25 / build 1025 has been withdrawn because of phone/handheld layout and Football/NFL search issues. Public downloads provide [0.1.27 / build 1027](https://github.com/DougTrier/GenX-Streamer/releases/tag/v0.1.27). See the [candidate status](../README.md#release-status) and [physical device audit](device-playability-audit.md) for the current development build. Results in this document apply to the builds named alongside them.

An Android app's signing key is its identity. Every update must be signed with
the same key, or Android refuses to install it over the copy people have. GenX
Streamer's release key is the owner's: it is never committed, never shared,
and nobody else creates or uses it.

Development builds (`build-android.ps1`) are signed with
Android's debug key. They are fine for testing but are not official: they
cannot send their own APK (Pass It Along), and a release-signed copy will not
install over them without uninstalling first.

## Creating the release key (owner, once)

Run this yourself, in your own PowerShell 7 (not through an assistant), so the
password never appears anywhere else:

```powershell
pwsh -NoProfile -File src-tauri/scripts/new-release-key.ps1 -Folder 'D:\GenX-Release'
```

The script asks for the password twice (hidden), creates the key
(`genx-release.jks`, RSA 4096, valid 100 years), writes `signing.properties`
for the release build (readable only by your Windows account) and
`fingerprint.txt`, and prints the public SHA-256 fingerprint. It refuses a
folder inside the repository and never overwrites an existing key.

Then, before anything else:

- **Back up `genx-release.jks` and the password in two places** (for example
  an encrypted USB drive and your password manager). If the key is lost, no
  installed copy can ever be updated again; everyone would have to uninstall
  and lose their saved channels.
- **Never commit it.** `.gitignore` already refuses `*.jks`, `*.keystore` and
  `keystore.properties`, and the folder is outside the repository anyway.

## The signing file

`signing.properties` (written by the script) is what the release build reads:

```properties
storeFile=D:/GenX-Release/genx-release.jks
storePassword=<the password>
keyAlias=genx-release
keyPassword=<the password>
```

Point the build at it in the terminal you build from:

```powershell
$env:GENX_RELEASE_SIGNING = 'D:\GenX-Release\signing.properties'
```

## The fingerprint GenX checks itself against

GenX knows its own official certificate by its SHA-256 fingerprint, which is
public (it is printed in every APK). Read it with:

```powershell
& 'C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe' -list -v -keystore 'D:\GenX-Release\genx-release.jks' -alias genx-release
```

(or open `fingerprint.txt`, which the script wrote). Take the `SHA256:` line,
remove the colons and lowercase it, and put it in
`RELEASE_CERTIFICATE_SHA256` in `src-tauri/src/platform/app_identity.rs`. Only
then does a release-signed copy count as an official release (About → This
copy → Official release, and Pass It Along can send the APK). The same
fingerprint goes into the share links' `assetlinks.json`
([share-links.md](share-links.md)).

## Building a signed release

```powershell
pwsh -NoProfile -File src-tauri/scripts/build-android-release.ps1
```

This builds one universal APK (arm64-v8a and armeabi-v7a, so it runs on 32- and 64-bit ARM devices; `-Architecture aarch64` builds the 64-bit-only APK for comparison). It builds Rust and Gradle in their release profiles, signs with the key the
signing file names, then verifies the APK's signature with `apksigner` and
refuses the build unless its certificate is exactly the one
`RELEASE_CERTIFICATE_SHA256` names. The APK is
`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`;
`scripts/package-candidate.mjs` names it for the release and lists it in
`SHA256SUMS` ([verify-a-download.md](verify-a-download.md)).

`-PipelineTest` exists only to prove the release pipeline with a throwaway
key: it skips the certificate match and reports the APK as not official. Never
install or share such an APK.

## Moving a device from a development copy to the release

A release-signed GenX cannot install over a debug-signed one. On that device:
Settings → **Full backup** (save the file somewhere
you can reach), uninstall GenX Streamer, install the release APK, then import
the backup. Uninstalling removes the app's saved channels, favorites and
settings, so the backup comes first.

## Candidate verification

The signed universal Android package reports `com.tmg.tv`, version
`0.1.27`, build `1027`, minimum API 24, target API 36, and both `arm64-v8a`
and `armeabi-v7a`. APK SHA-256 is
`F918F9290965BDF42A45F956D8C55CFFA7C54A302B3DCE69804A27C7786290A7`.
The signing certificate SHA-256 is
`464c42785a80bb27022527d7e5b703c4ecf2d62f433a0f9f6b162ee95b7872ff`.
Physical S25 and Streamer observations are recorded against build 1026
in the [device audit](device-playability-audit.md).

Type checking and four version-tool tests passed. The full frontend rerun
passed 4,121 tests across 364 files. The targeted Playwright TV surface
and About suites passed all 15 checks. The short scan review now scrolls
when enlarged controls would crowd the results. Browser fixtures cover
the setup state, the active About tab, and the native bulk-removal read.
The exact rebuilt APK passed the targeted S25 and Streamer checks in the
[device audit](device-playability-audit.md). The Windows x64 executable
passed the isolated native playback and normal-exit smoke test. The
release manifest and SHA256SUMS identify the three downloadable packages.

## Recovering from a broken Android release

Keep the last verified release source and its signed APK. Android blocks an
in-place install when the APK has a lower version code. If a release breaks
startup or playback, prepare a rescue update with the same application ID and
signing certificate and a higher version code. Restore the known-good behavior
while retaining support for any database migrations already applied by the
broken release. Host the rescue download outside the app so users can reach it
when startup fails.
[Android app versioning](https://developer.android.com/studio/publish/versioning)

Before offering a rescue build, install it over the affected build on the S25
and Google TV Streamer with populated test libraries. Confirm that channels,
favorites, settings, and saved scan progress survive and that playback starts.
If the app still opens, export a Full backup before an install that requires
uninstalling. Verify that the target version can import the backup before
asking users to uninstall.
[Android app updates](https://developer.android.com/google/play/app-updates)

## Size of the universal APK

Measured October 24, 2026 (release builds, signed with a throwaway pipeline
key): universal 84.9 MiB, 64-bit-only 50.9 MiB. The difference (+34 MiB,
+67%) is the 32-bit library (`armeabi-v7a`, 33.9 MiB); Android keeps native
libraries uncompressed in the APK. Startup, memory and playback on devices are
not yet compared.

## Release acceptance and publication

The owner updated acceptance on November 1, 2026: use short targeted Scan, Menu,
Guide and remote-navigation checks; no additional five-minute playback interval is
required. Existing sustained captures remain supporting evidence. A signed APK and
a successful launch alone are not sufficient. Do not publish
a GitHub release or promote its version/download on the landing page while
repeated rebuffering, automatic restarts, black pictures or view traps remain.

For the exact candidate APK, record its version/build, hash, signing identity,
device/OS, channel, stream type, test duration and results. Use the owner's
configured local Google Streamer for the affected Free TV and Paid TV paths. When
playback code changes, include the reported Weather Channel, multiple US sports sources
and each changed Free TV playback path. For a status-only or navigation change, use
short targeted checks and explicitly retain prior evidence for unchanged playback code.
When a household client is already using a limited Paid provider, keep local Paid
streams closed. Use offline authority/protocol/selection fixtures and explicitly scoped
prior observations; a new local Paid provider stream is not required under that
constraint. Otherwise coordinate one provider client at a time for any authorized
physical Paid check.

Include actual fast-motion sports footage, with more than one US sports source.
Record the channel, observed content, resolution, frame progress/drop counters,
buffering and recovery events. A studio segment or advertisement alone does not
verify fast-motion sports quality. Check embedded/fullscreen/return placement
and channel switching as part of this matrix.

Use short targeted checks of Finish scan, Stop, saved progress, loading/ready Guide
rows and remote focus while browsing or playing. Verify the relevant menus, native
keyboard dismissal, embedded/fullscreen/return, channel switching and expanded/fullscreen
Stop. A full catalog scan and a new five-minute capture per stream are not prerequisites.
Repeated buffering, an unexpected restart or a view trap observed during these checks
still fails acceptance and must be investigated. Keep exact results and unavailable
measurements explicit; do not infer them from a screenshot or call an incomplete
observation a pass.

The accepted publication sequence is exact-candidate automated checks, signed
package verification, scoped local Google Streamer/Thor checks and confirmed
local closing, followed by the GitHub release and source/site update. The owner's
Fire TV Stick and Retroid Pocket Flip 2 in-house upgrades follow publication.
Those devices and their untested paths remain explicitly unverified until the
owner reports results; they are not an additional approval gate before publishing.
Do not substitute synthetic density tests or another model's results for physical
acceptance. Keep GenXtra expanded/fullscreen Stop and usable title navigation in
the relevant local check matrix.

Save redacted reports in the ignored artifacts directory. Automated protocol,
geometry and lifecycle tests must pass, but do not replace physical playback
acceptance. After the accepted local gates pass and the release maintainer confirms the exact
receipts, promote the matching release assets, README version, update manifests
and public landing page together under the existing conditional authorization.
Keep new owner-device follow-up labelled unverified. A public copy must never
claim unperformed Paid-provider, Fire TV Stick, Flip 2 or other-platform tests.

Existing long captures can optionally be assessed with the unchanged historical preflight:

```powershell
node scripts/check-playback-report.mjs --free <free-capture.json> --paid <paid-capture.json> --apk <exact-candidate.apk> --version <x.y.z> --output <acceptance.json>
```

This optional tool requires at least 300 seconds of decoded/rendered progress per selected
Free/Paid stream, excludes only the first five seconds after initial Playing
from buffering checks, and fails recovery, later buffering, stable measured
misalignment or measured frame drops over five percent. Missing frame progress
or a short capture is incomplete for that optional tool, not a failure of the current
short targeted release gate. Do not relabel such output PASS. A frame-counter freeze over fifteen seconds fails; gaps between frame observations over fifteen seconds leave coverage incomplete. The report binds the candidate APK hash and
app version; device identity and low-level compositor/driver warnings still
need the physical acceptance record. Do not treat this preflight alone as Fire
TV, Flip 2, sound or complete release acceptance.
