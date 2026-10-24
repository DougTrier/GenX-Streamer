# Signing Android releases

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
Settings → Audio and preferences → **Full backup** (save the file somewhere
you can reach), uninstall GenX Streamer, install the release APK, then import
the backup. Uninstalling removes the app's saved channels, favorites and
settings, so the backup comes first.

## Size of the universal APK

Measured October 24, 2026 (release builds, signed with a throwaway pipeline
key): universal 84.9 MiB, 64-bit-only 50.9 MiB. The difference (+34 MiB,
+67%) is the 32-bit library (`armeabi-v7a`, 33.9 MiB); Android keeps native
libraries uncompressed in the APK. Startup, memory and playback on devices are
not yet compared.
