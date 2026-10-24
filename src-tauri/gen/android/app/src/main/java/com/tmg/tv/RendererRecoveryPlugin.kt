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
import android.app.AlertDialog
import android.content.Intent
import android.os.Process
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.security.SecureRandom

/** Called only by the original Wry client's extension; no JavaScript or provider payload. */
object RendererRecoveryBridge {
  private var bound: WebView? = null
  private var loss: (() -> Unit)? = null
  fun bind(view: WebView, callback: () -> Unit) { bound = view; loss = callback }
  fun gone(view: WebView): Boolean {
    if (bound !== view) return false
    val callback = loss ?: return false
    callback(); return true
  }
  fun detach(view: WebView?) { if (bound === view) { bound = null; loss = null } }
}
@InvokeArg
class RendererSettlementArgs { var token: String = ""; var joined: Boolean = false }
@TauriPlugin
class RendererRecoveryPlugin(private val activity: Activity) : Plugin(activity) {
  private val owner = RendererRecoveryOwner()
  private var view: WebView? = null
  private var token = ""
  private var dialog: AlertDialog? = null
  override fun load(webView: WebView) {
    if (owner.phase != RendererRecoveryOwner.Phase.Alive) return
    view = webView
    RendererRecoveryBridge.bind(webView) { lost(webView) }
  }
  private fun lost(dead: WebView) {
    if (view !== dead || !owner.lost()) return
    token = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    // Native admission is revoked immediately, before any platform focus/teardown call.
    report()
    owner.retirementSettled((activity as MainActivity).retireRenderer(dead))
    showStatus()
  }
  private fun report() {
    if (hasListener("rendererLost")) triggerObject("rendererLost", mapOf("schemaVersion" to 1, "token" to token))
  }
  // Native Channel delivery remains available after JavaScript dies.
  @Command override fun registerListener(invoke: Invoke) {
    super.registerListener(invoke)
    if (owner.phase == RendererRecoveryOwner.Phase.Joining) report()
  }
  @Command fun complete(invoke: Invoke) {
    val args = invoke.parseArgs(RendererSettlementArgs::class.java)
    activity.runOnUiThread {
      if (args.token != token || token.isEmpty() || !owner.nativeSettled(args.joined)) {
        invoke.reject("renderer-recovery-stale"); return@runOnUiThread
      }
      showStatus(); invoke.resolve()
    }
  }
  @Command fun observerFailed(invoke: Invoke) {
    activity.runOnUiThread {
      val current = view
      if (current != null && owner.phase == RendererRecoveryOwner.Phase.Alive) lost(current)
      if (token.isEmpty()) invoke.reject("renderer-recovery-unavailable")
      else invoke.resolveObject(mapOf("schemaVersion" to 1, "token" to token))
    }
  }
  @Command fun bootstrap(invoke: Invoke) {
    invoke.resolveObject(mapOf("schemaVersion" to 1,
      "recoveredRenderer" to activity.intent.getBooleanExtra("genxRendererRecovered", false)))
  }
  private fun showStatus() {
    if (activity.isFinishing || activity.isDestroyed) return
    val joined = owner.phase == RendererRecoveryOwner.Phase.Joined
    val failed = owner.phase == RendererRecoveryOwner.Phase.Failed
    // One WindowRoot for the complete terminal episode. Dismissing/recreating on cleanup
    // settlement races queued platform accessibility queries against a root whose mView is null.
    val current = dialog ?: AlertDialog.Builder(activity).setTitle("Viewing screen stopped")
      .setMessage("Closing viewing work. Your saved library will be retained.")
      .setCancelable(false).setPositiveButton("Reopen", null).create().also {
        dialog = it; it.show()
      }
    current.setMessage(if (joined) "Your saved library is retained. Reopen the app to continue."
      else if (failed) "Viewing work could not finish closing. Retry cleanup before reopening."
      else "Closing viewing work. Your saved library will be retained.")
    current.getButton(AlertDialog.BUTTON_POSITIVE).apply {
      val becomingAvailable = visibility != android.view.View.VISIBLE || !isEnabled
      text = if (failed) "Retry cleanup" else "Reopen"
      visibility = if (joined || failed) android.view.View.VISIBLE else android.view.View.GONE
      isEnabled = joined || failed
      if (becomingAvailable && isEnabled && current.window?.decorView?.hasWindowFocus() == true)
        requestFocus()
      setOnClickListener {
        if (owner.phase == RendererRecoveryOwner.Phase.Joined) reopen()
        else if (owner.retry()) {
          if (!owner.nativeCleanupConfirmed) report()
          if (!owner.retirementConfirmed) view?.let {
            owner.retirementSettled((activity as MainActivity).retireRenderer(it))
          }
          showStatus()
        }
      }
    }
  }
  private fun reopen() {
    if (!owner.reopen()) return
    try {
      activity.startActivity(Intent(activity, RendererRelaunchActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("retiredPid", Process.myPid()))
    } catch (_: RuntimeException) { owner.launchFailed(); showStatus(); return }
    // Confirmed native joins precede this explicit native user action.
    Process.killProcess(Process.myPid())
  }
  override fun onDestroy() {
    dialog?.dismiss(); dialog = null
    RendererRecoveryBridge.detach(view); view = null
  }
}
