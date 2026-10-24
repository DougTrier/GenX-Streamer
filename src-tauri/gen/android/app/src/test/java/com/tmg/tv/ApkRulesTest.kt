/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.tmg.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** W16 (docs/web-viewer-invariants.md), with header shapes measured October 19, 2026. */
class ApkRulesTest {
  private val apkType = "application/vnd.android.package-archive"

  @Test
  fun realRepositoriesAreRecognized() {
    // GitHub release asset after its redirect.
    val github = "https://release-assets.githubusercontent.com/github-production-release-asset/44804216/d68bd505?sp=r"
    val githubDisposition = "attachment; filename=termux-app_v0.118.3+github-debug_arm64-v8a.apk"
    assertTrue(ApkRules.isApk(github, apkType, githubDisposition))
    assertTrue(ApkRules.isApk(github, "application/octet-stream", githubDisposition))
    // The release link itself, before the redirect.
    assertTrue(ApkRules.isApk("https://github.com/termux/termux-app/releases/download/v0.118.3/termux-app_v0.118.3%2Bgithub-debug_arm64-v8a.apk", null, null))
    // F-Droid: a plain link.
    assertTrue(ApkRules.isApk("https://f-droid.org/repo/org.fdroid.fdroid_1021050.apk", apkType, null))
    // APKPure: the file name is only in the header (plus signs are spaces).
    val apkpure = "https://data.winudf.com/APK/b3JnLnZpZGVvbGFu?_p=b3Jn"
    val apkpureDisposition = "attachment; filename=\"VLC+for+Android_3.7.2_APKPure.apk\""
    assertTrue(ApkRules.isApk(apkpure, apkType, apkpureDisposition))
    assertEquals("VLC for Android_3.7.2_APKPure.apk", ApkRules.fileName(apkpure, apkpureDisposition))
    // A site that labels the APK as something else is still taken by its name.
    assertTrue(ApkRules.isApk("https://example.org/get?id=1", "application/zip", "attachment; filename=\"tool.apk\""))
  }

  @Test
  fun bundlesAndOtherFilesAreNotApps() {
    val xapk = "https://data.winudf.com/XAPK/Y29tLndoYXRzYXBw?_p=Y29t"
    val xapkDisposition = "attachment; filename=\"WhatsApp+Messenger_2.26.40.76_APKPure.xapk\""
    assertFalse(ApkRules.isApk(xapk, "application/octet-stream", xapkDisposition))
    assertTrue(ApkRules.isBundle(xapk, "application/octet-stream", xapkDisposition))
    assertTrue(ApkRules.isBundle("https://www.apkmirror.com/x", null, "attachment; filename=\"app.apkm\""))
    assertFalse(ApkRules.isApk("https://example.org/movie.mp4", "video/mp4", null))
    assertFalse(ApkRules.isApk("https://example.org/setup.exe", "application/octet-stream", null))
    assertFalse(ApkRules.isBundle("https://example.org/movie.mp4", "video/mp4", null))
  }

  @Test
  fun onlySecureAddressesWithoutCredentials() {
    assertFalse(ApkRules.isApk("http://f-droid.org/repo/a.apk", apkType, null))
    assertFalse(ApkRules.isApk("https://user:pass@example.org/a.apk", apkType, null))
    assertFalse(ApkRules.isApk("file:///sdcard/a.apk", apkType, null))
    assertFalse(ApkRules.isApk("content://downloads/a.apk", apkType, null))
    assertFalse(ApkRules.isApk("not a url", apkType, null))
  }

  @Test
  fun fileNamesCannotEscapeTheDownloadFolder() {
    assertEquals("evil.apk", ApkRules.fileName("https://example.org/x", "attachment; filename=\"../../evil.apk\""))
    assertEquals("evil.apk", ApkRules.fileName("https://example.org/a%2F..%2Fevil.apk", null))
    assertTrue(ApkRules.fileName("https://example.org/x", "attachment; filename=\"${"a".repeat(500)}.apk\"").length <= 120)
  }

  @Test
  fun cookiesStayWithTheSiteClicked() {
    assertTrue(ApkRules.sameHost("https://www.apkmirror.com/download.php?id=1", "https://www.apkmirror.com/x"))
    assertFalse(ApkRules.sameHost("https://cdn.example.net/file.apk", "https://www.apkmirror.com/x"))
  }

  @Test
  fun anApkIsAZipArchive() {
    assertTrue(ApkRules.looksLikeZip(byteArrayOf(0x50, 0x4B, 0x03, 0x04, 0x14)))
    assertFalse(ApkRules.looksLikeZip("<!DOCTYPE html>".toByteArray()))
    assertFalse(ApkRules.looksLikeZip(byteArrayOf(0x50, 0x4B)))
  }
}
