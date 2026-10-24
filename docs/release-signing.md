# Signing Android releases

An Android app's signing key is its identity. Every update must be signed with
the same key, or Android refuses to install it over the copy people have. GenX
Streamer's release key is the owner's: it is never committed, never shared,
and nobody else creates or uses it.

Development builds (`build-android.ps1` without `-Release`) are signed with
Android's debug key. They are fine for testing but are not official: they
cannot send their own APK (Pass It Along), and a release-signed copy will not
install over them without uninstalling first.

## Creating the release key (owner, once)

Run this yourself in your own terminal, so the passwords never appear
anywhere else. Keep the keystore outside the repository:

```powershell
& 'C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe' -genkeypair -v -keystore 'D:\GenX-Release\genx-release.jks' -alias genx-release -keyalg RSA -keysize 4096 -validity 36500 -dname 'CN=Doug Trier, O=GenX Streamer'
```

keytool asks for the passwords. Then, before anything else:

- **Back it up in two places** (for example an encrypted USB drive and your
  password manager), with its passwords. If the key is lost, no installed copy
  can ever be updated again; everyone would have to uninstall and lose their
  saved channels.
- **Never commit it.** `.gitignore` already refuses `*.jks`, `*.keystore` and
  `keystore.properties`.

## The signing file

Beside the key, create a properties file (also outside the repository) that
the build reads; nothing else reads it:

```properties
storeFile=D:/GenX-Release/genx-release.jks
storePassword=<the keystore password>
keyAlias=genx-release
keyPassword=<the key password>
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

Take the `SHA256:` line, remove the colons and lowercase it, and put it in
`RELEASE_CERTIFICATE_SHA256` in `src-tauri/src/platform/app_identity.rs`. Only
then does a release-signed copy count as an official release (About → This
copy → Official release, and Pass It Along can send the APK). The same
fingerprint goes into the share links' `assetlinks.json`
([share-links.md](share-links.md)).

## Building a signed release

```powershell
pwsh -NoProfile -File src-tauri/scripts/build-android.ps1 -Architecture aarch64 -Release
```

This builds Rust and Gradle in their release profiles, signs with the key the
signing file names, then verifies the APK's signature with `apksigner` and
refuses the build unless its certificate is exactly the one
`RELEASE_CERTIFICATE_SHA256` names. The APK is
`src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk`;
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
