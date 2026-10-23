package com.tmg.tv

import android.app.Activity
import android.webkit.WebView
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.wifi.WifiManager
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class FullscreenArgs {
  var enabled: Boolean = false
}

@InvokeArg
class DiscoveryArgs {
  var enabled: Boolean = false
  var leaseId: String = ""
}

@InvokeArg
class SpeechArgs {var requestId:String="";var language:String="en-US";var allowCloud:Boolean=false}

@InvokeArg
class DonationArgs {var target:String=""}
internal object DonationTargets {
  fun url(target:String):String? = when(target) {
    "github" -> "https://github.com/sponsors/dougtrier"
    "opencollective" -> "https://opencollective.com/trier-os"
    "coffee" -> "https://www.buymeacoffee.com/dougtrier"
    else -> null
  }
  fun open(target:String, foreground:Boolean, launch:(String)->Unit):String? {
    val fixed=url(target) ?: return "donation-target-refused"
    if(!foreground)return "donation-browser-unavailable"
    return try {launch(fixed);null} catch (_:RuntimeException) {"donation-browser-unavailable"}
  }
}

private enum class WakeDebugStage(val label:String) {
  CommandEnter("wake-command-enter"),
  UiEnter("wake-ui-enter"),
  PolicyApplied("wake-policy-applied"),
  ResolveBefore("wake-resolve-before"),
  ResolveAfter("wake-resolve-after"),
  SpeechShutdownUiEnter("speech-shutdown-ui-enter"),
  SpeechShutdownUiAfter("speech-shutdown-ui-after")
}

@TauriPlugin
class ViewingPlugin(private val activity: Activity) : Plugin(activity) {
  private val taskFinish = ActivityTaskFinish()
  @Command
  fun finishOwnedTask(invoke: Invoke) {
    activity.runOnUiThread {
      val accepted = taskFinish.request(android.os.Build.VERSION.SDK_INT,
        {activity.isDestroyed}, {activity.isTaskRoot}, {activity.isFinishing},
        {activity.finishAndRemoveTask()})
      if (!accepted) invoke.reject("activity-finish-unconfirmed")
      else invoke.resolveObject(mapOf("schemaVersion" to 1,
        "adapterVersion" to "activity-finish-v1", "platform" to "android",
        "requestAccepted" to true, "activityFinishing" to activity.isFinishing,
        "taskRoot" to true)) // Verified by taskFinish before requesting task removal.
    }
  }
  /**
   * Ends GenX's process once its ordinary exit has finished the task and every
   * owned operation has drained (lib.rs finalize_activity_exit). killProcess
   * skips the C exit handlers that app.exit runs: those tore down shared state
   * while WebView's GPU and HWUI threads still ran, so every exit ended in a
   * 'destroyed mutex' abort (Google TV Streamer and Sansui, October 19, 2026).
   */
  @Command
  fun endProcess(invoke: Invoke) {
    activity.runOnUiThread { android.os.Process.killProcess(android.os.Process.myPid()) }
  }
  private fun debugStage(stage:WakeDebugStage) {
    if ((activity.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
      android.util.Log.i("GenXWake",stage.label)
  }
  private val speech=NativeSpeech(activity as MainActivity)
  private var viewingWebView: WebView? = null
  private var multicast: WifiManager.MulticastLock? = null
  private val discovery = DiscoveryLease({
    val manager = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    multicast = manager.createMulticastLock("tmg-explicit-discovery").also {
      it.setReferenceCounted(false)
      it.acquire()
    }
  }, {
    multicast?.let { if (it.isHeld) it.release() }
    multicast = null
  })
  override fun load(webView: WebView) {
    viewingWebView = webView
    (activity as MainActivity).notifyFullscreenExit = {
      webView.evaluateJavascript("window.dispatchEvent(new Event('native-fullscreen-exited'))", null)
    }
    activity.notifyBackRequest = { id ->
      // Document dispatch lets window capture consumers run before main's bubble acknowledgement.
      webView.evaluateJavascript("document.dispatchEvent(new CustomEvent('native-back-requested',{detail:{requestId:'$id'},bubbles:true,cancelable:true}))", null)
    }
    activity.notifyAppBackground = { sequence ->
      publishLifecycle(webView, false, sequence)
    }
    activity.notifyAppForeground = { sequence ->
      publishLifecycle(webView, true, sequence)
    }
    activity.notifyNativeResourcesStopped = {
      cancelDiscovery()
      speech.cancel()
    }
    activity.bindViewingWakeWebView(webView)
    activity.requestViewingForegroundReplay()
  }
  private fun publishLifecycle(webView: WebView, foreground: Boolean, sequence: Long) {
    if (viewingWebView !== webView || activity.isDestroyed) return
    val event = if (foreground) "native-app-foreground" else "native-app-background"
    webView.evaluateJavascript("""(() => {
      const sequence=$sequence;
      if(sequence <= (window.__genxActivityLifecycleSequence || 0)) return;
      window.__genxActivityLifecycleSequence=sequence;
      window.dispatchEvent(new CustomEvent('$event',{detail:{schemaVersion:1,sequence,foreground:$foreground}}));
    })()""".trimIndent(), null)
  }

  override fun onResume() {
    (activity as MainActivity).requestViewingForegroundReplay()
  }

  override fun onStop() {
    if ((activity as MainActivity).isViewingForeground()) return
    speech.cancel()
    cancelDiscovery()
  }

  private fun cancelDiscovery() {
    try { discovery.cancel() } catch (_: RuntimeException) {
      // Retain ownership for the next lifecycle cleanup attempt without crashing the Activity.
    }
  }

  @Command
  fun deviceCapabilities(invoke:Invoke) {
    activity.runOnUiThread {
      try {
        val mode=(activity.getSystemService(Context.UI_MODE_SERVICE) as? android.app.UiModeManager)?.currentModeType
        val leanback=activity.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_LEANBACK)
        val television=activity.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_TELEVISION)
        invoke.resolveObject(mapOf("isTelevision" to TelevisionCapability.isTelevision(mode,leanback,television)))
      } catch (_:RuntimeException) {invoke.reject("device-capabilities-unavailable")}
    }
  }

  @Command
  fun openDonation(invoke:Invoke) {
    val args=invoke.parseArgs(DonationArgs::class.java)
    activity.runOnUiThread {
      val error=DonationTargets.open(args.target,(activity as MainActivity).isViewingForeground()) {url->
        activity.startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE))
      }
      if(error==null)invoke.resolveObject(mapOf("opened" to true,"target" to args.target)) else invoke.reject(error)
    }
  }

  @Command
  fun speechCapabilities(invoke:Invoke) {activity.runOnUiThread {speech.capabilities(invoke)}}
  @Command
  fun speechStart(invoke:Invoke) {val a=invoke.parseArgs(SpeechArgs::class.java);activity.runOnUiThread {speech.start(a.requestId,a.language,a.allowCloud,invoke)}}
  @Command
  fun speechEnd(invoke:Invoke) {val a=invoke.parseArgs(SpeechArgs::class.java);activity.runOnUiThread {speech.end(a.requestId,invoke)}}
  @Command
  fun speechCancel(invoke: Invoke) {
    val args=invoke.parseArgs(SpeechArgs::class.java)
    activity.runOnUiThread {
      if(args.requestId.isNotEmpty() && !args.requestId.matches(Regex("[A-Za-z0-9_-]{1,128}"))) invoke.reject("speech-invalid-request")
      else {
        val id=args.requestId.ifEmpty {null}
        (activity as MainActivity).cancelSpeechPermission(id)
        if(speech.cancel(id)) invoke.resolve() else invoke.reject("speech-stop-unconfirmed")
      }
    }
  }
  @Command
  fun speechShutdown(invoke: Invoke) {activity.runOnUiThread {
    debugStage(WakeDebugStage.SpeechShutdownUiEnter)
    (activity as MainActivity).cancelSpeechPermission()
    if(speech.shutdown()) invoke.resolve() else invoke.reject("speech-stop-unconfirmed")
    debugStage(WakeDebugStage.SpeechShutdownUiAfter)
  }}
  @Command
  fun speechPermission(invoke: Invoke) {
    val args=invoke.parseArgs(SpeechArgs::class.java)
    activity.runOnUiThread {
      if(!args.requestId.matches(Regex("[A-Za-z0-9_-]{1,128}"))) invoke.reject("speech-invalid-request")
      else if(!speech.permissionAllowed(args.requestId)) invoke.resolveObject(mapOf("granted" to false))
      else (activity as MainActivity).requestSpeechPermission(args.requestId) {granted->invoke.resolveObject(mapOf("granted" to granted))}
    }
  }

  @Command
  fun acknowledgeBack(invoke: Invoke) {
    val args=invoke.parseArgs(SpeechArgs::class.java)
    activity.runOnUiThread {
      (activity as MainActivity).acknowledgeBack(args.requestId)
      invoke.resolve()
    }
  }

  @Command
  fun setDiscovery(invoke: Invoke) {
    val args = invoke.parseArgs(DiscoveryArgs::class.java)
    activity.runOnUiThread {
      try {
        if (args.enabled) {
          discovery.begin(args.leaseId, (activity as MainActivity).isViewingForeground())
        } else {
          discovery.end(args.leaseId)
        }
        invoke.resolve()
      } catch (error: IllegalStateException) {
        invoke.reject(when (error.message) {
          "cast-discovery-background" -> "cast-discovery-background"
          "cast-discovery-busy" -> "cast-discovery-busy"
          else -> "cast-discovery-permission-unavailable"
        })
      } catch (_: RuntimeException) { invoke.reject("cast-discovery-permission-unavailable") }
    }
  }

  @Command
  fun setViewingActive(invoke: Invoke) {
    debugStage(WakeDebugStage.CommandEnter)
    val args = invoke.parseArgs(FullscreenArgs::class.java)
    activity.runOnUiThread {
      debugStage(WakeDebugStage.UiEnter)
      (activity as MainActivity).setViewingActive(args.enabled)
      debugStage(WakeDebugStage.PolicyApplied)
      debugStage(WakeDebugStage.ResolveBefore)
      invoke.resolveObject(mapOf(
        "schemaVersion" to 1,
        "adapterVersion" to "viewing-wake-v1",
        "requestedActive" to args.enabled,
        "foreground" to activity.isViewingForeground(),
        "windowKeepScreenOn" to ((activity.window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0),
        "webViewKeepScreenOn" to viewingWebView?.keepScreenOn,
        "decorKeepScreenOn" to activity.window.decorView.keepScreenOn,
        "platform" to "android"
      ))
      debugStage(WakeDebugStage.ResolveAfter)
    }
  }

  @Command
  fun getViewingWakeDiagnostics(invoke: Invoke) {
    activity.runOnUiThread {
      val host = activity as MainActivity
      val (nodes, truncated) = ViewingWakeReader.read<android.view.View>(viewingWebView,
        { node -> if (node is android.view.ViewGroup) node.childCount else 0 },
        { node, index -> (node as android.view.ViewGroup).getChildAt(index) },
        { node, path -> mapOf("path" to path, "className" to node.javaClass.name.take(256),
          "keepScreenOn" to node.keepScreenOn, "visibility" to node.visibility,
          "shown" to node.isShown) })
      invoke.resolveObject(mapOf(
        "schemaVersion" to 1, "adapterVersion" to "viewing-wake-v1",
        "requestedActive" to host.requestedViewingActive(), "foreground" to host.isViewingForeground(),
        "activityLifecycle" to host.viewingLifecycleDiagnostics(),
        "windowKeepScreenOn" to ((host.window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0),
        "webViewKeepScreenOn" to viewingWebView?.keepScreenOn,
        "decorKeepScreenOn" to host.window.decorView.keepScreenOn,
        "platform" to "android", "nodes" to nodes, "truncated" to truncated))
    }
  }

  @Command
  fun setFullscreen(invoke: Invoke) {
    val args = invoke.parseArgs(FullscreenArgs::class.java)
    activity.runOnUiThread {
      (activity as MainActivity).setViewingFullscreen(args.enabled)
      invoke.resolve()
    }
  }
}
