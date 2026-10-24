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

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.security.MessageDigest

@InvokeArg
class UpdateInstallArgs {var path:String=""}

/**
 * Voluntary updates (docs/updates.md). The rules an APK must meet before
 * Android's installer is opened for it: this app's package, a newer version,
 * and exactly this copy's signing certificates, so an update is never offered
 * from another publisher and saved data survives (UP-005, UP-008).
 */
internal object UpdateRules {
  /** Null when the update may be offered; otherwise the viewer's reason code. */
  fun refusal(installedPackage: String, archivePackage: String?, installedCode: Long, archiveCode: Long,
              installedSigners: Set<String>, archiveSigners: Set<String>): String? = when {
    archivePackage == null -> "update-not-an-app"
    archivePackage != installedPackage -> "update-wrong-app"
    installedSigners.isEmpty() || archiveSigners.isEmpty() -> "update-unverifiable"
    installedSigners != archiveSigners -> "update-signature-mismatch"
    archiveCode <= installedCode -> "update-not-newer"
    else -> null
  }

  /** The update file must be GenX's own download in its cache. */
  fun ownFile(cacheDir: File, path: String): File? {
    val folder = File(cacheDir, "updates").canonicalFile
    val file = File(path).canonicalFile
    return if (file.parentFile == folder && file.name.endsWith(".apk") && file.isFile) file else null
  }

  fun digest(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}

@TauriPlugin
class AppUpdatePlugin(private val activity: Activity) : Plugin(activity) {
  @Suppress("DEPRECATION")
  private fun signers(info: PackageInfo?): Set<String> {
    if (info == null) return emptySet()
    val certificates = if (Build.VERSION.SDK_INT >= 28) {
      val signing = info.signingInfo ?: return emptySet()
      if (signing.hasMultipleSigners()) signing.apkContentsSigners else signing.signingCertificateHistory
    } else info.signatures
    return certificates?.map { UpdateRules.digest(it.toByteArray()) }?.toSet() ?: emptySet()
  }

  @Suppress("DEPRECATION")
  private fun code(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

  /** Opens Android's own installer for a verified update; Android asks the viewer before installing. */
  @Command
  fun installUpdate(invoke: Invoke) {
    val args = invoke.parseArgs(UpdateInstallArgs::class.java)
    Thread {
      val refusal = try {
        val file = UpdateRules.ownFile(activity.cacheDir, args.path)
        if (file == null) "update-file-missing" else {
          @Suppress("DEPRECATION")
          val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
          val installed = activity.packageManager.getPackageInfo(activity.packageName, flags)
          val archive = activity.packageManager.getPackageArchiveInfo(file.path, flags)
          UpdateRules.refusal(activity.packageName, archive?.packageName, code(installed),
            archive?.let { code(it) } ?: 0L, signers(installed), signers(archive))
            ?.also { file.delete() }
        }
      } catch (_: Exception) { "update-install-failed" }
      activity.runOnUiThread {
        if (refusal != null) { invoke.reject(refusal); return@runOnUiThread }
        if (!(activity as MainActivity).isViewingForeground()) { invoke.reject("update-background"); return@runOnUiThread }
        try {
          val file = File(args.path).canonicalFile
          val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
          activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, ApkRules.MIME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
          invoke.resolveObject(mapOf("installerOpened" to true, "restartRequired" to false))
        } catch (_: Exception) { invoke.reject("update-no-installer") }
      }
    }.also { it.name = "genx-update-check"; it.isDaemon = true }.start()
  }
}
