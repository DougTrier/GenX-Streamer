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
import android.content.ClipData
import android.content.Intent
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class ShareArgs {var title:String="";var text:String=""}

/** The links GenX opens (AndroidManifest.xml intent filters): shape only; the interface checks every field. */
internal object IncomingLink {
  const val MAX = 6000
  fun admit(raw:String?):String? {
    val link=raw?.trim() ?: return null
    if (link.isEmpty() || link.length > MAX || link.any { it.isISOControl() || it.isWhitespace() }) return null
    val lower=link.take(48).lowercase()
    return if (lower.startsWith("genx://watch") ||
      lower.startsWith("https://dougtrier.github.io/genx-streamer/watch")) link else null
  }
}

/**
 * Share links (docs/share-links.md): links that open GenX, the system share
 * sheet for "Watch News 24 on GenX Streamer: <link>", and the installed app
 * itself, sent phone to phone with Quick Share, Bluetooth or a messaging app.
 * A link is never put into page script: the page is told one is waiting and
 * asks for it (takeIncomingLink), so its text is only ever data.
 */
@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {
  private var pending: String? = null
  private var webView: WebView? = null

  override fun load(webView: WebView) {
    this.webView = webView
    // The link GenX was started with; consumed so a rotation never offers it again.
    receive(activity.intent)
  }

  override fun onNewIntent(intent: Intent) {
    if (receive(intent)) webView?.evaluateJavascript(
      "window.dispatchEvent(new Event('native-incoming-link'))", null)
  }

  private fun receive(intent: Intent?): Boolean {
    if (intent?.action != Intent.ACTION_VIEW) return false
    val link = IncomingLink.admit(intent.dataString)
    intent.data = null
    if (link == null) return false
    pending = link
    return true
  }

  @Command
  fun takeIncomingLink(invoke: Invoke) {
    activity.runOnUiThread {
      val link = pending
      pending = null
      invoke.resolveObject(mapOf("link" to link))
    }
  }

  private fun foreground(): Boolean = (activity as MainActivity).isViewingForeground()

  /** Shows the chooser; TVs often have no app that takes shared text, which is said plainly. */
  private fun choose(send: Intent, title: String, invoke: Invoke) {
    if (!foreground()) { invoke.reject("share-background"); return }
    if (send.resolveActivity(activity.packageManager) == null) { invoke.reject("share-no-target"); return }
    try {
      activity.startActivity(Intent.createChooser(send, title))
      invoke.resolveObject(mapOf("shown" to true))
    } catch (_: RuntimeException) { invoke.reject("share-unavailable") }
  }

  @Command
  fun shareText(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)
    activity.runOnUiThread {
      val send = Intent(Intent.ACTION_SEND).setType("text/plain")
        .putExtra(Intent.EXTRA_SUBJECT, args.title).putExtra(Intent.EXTRA_TEXT, args.text)
      choose(send, args.title, invoke)
    }
  }

  /** Is this copy genuine? Its signing fingerprints, whether it is debuggable, and whether it is split. */
  @Command
  fun appIdentity(invoke: Invoke) {
    try {
      val info = activity.packageManager.getPackageInfo(activity.packageName, AppSigning.flags)
      val application = activity.applicationInfo
      invoke.resolveObject(mapOf(
        "signers" to AppSigning.signers(info).sorted(),
        "debuggable" to ((application.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0),
        "split" to !application.splitSourceDirs.isNullOrEmpty()))
    } catch (_: Exception) { invoke.reject("identity-unavailable") }
  }

  /** This copy's APK, for Share with everyone nearby (served as it is, never copied). */
  @Command
  fun appFile(invoke: Invoke) {
    val info = activity.applicationInfo
    invoke.resolveObject(mapOf("path" to info.sourceDir, "split" to !info.splitSourceDirs.isNullOrEmpty()))
  }

  /**
   * Shares this installed copy's APK (its own sourceDir) through
   * InstalledApkProvider, without copying it. An app installed as several
   * split APKs cannot be sent as one file, which is said plainly.
   */
  @Command
  fun shareApp(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)
    val info = activity.applicationInfo
    if (!info.splitSourceDirs.isNullOrEmpty()) { invoke.reject("share-app-split"); return }
    // Earlier versions copied the APK to the cache; that copy is no longer needed.
    File(activity.cacheDir, "share").listFiles()?.forEach { it.delete() }
    activity.runOnUiThread {
      // The installed file itself, read through InstalledApkProvider: no copy.
      val uri = InstalledApkProvider.uri(activity.packageName)
      val send = Intent(Intent.ACTION_SEND).setType(InstalledApkProvider.MIME)
        .putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_SUBJECT, args.title)
        .putExtra(Intent.EXTRA_TEXT, args.text).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      send.clipData = ClipData.newRawUri(args.title, uri)
      choose(send, args.title, invoke)
    }
  }
}
