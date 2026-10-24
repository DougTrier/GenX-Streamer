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
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.PixelFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.view.KeyEvent
import android.view.SurfaceControlViewHost
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg
class WebPageArgs {
  var url: String = ""
  /** The viewing area in window pixels; a width of 0 or less means the whole window. */
  var left: Int = 0
  var top: Int = 0
  var width: Int = 0
  var height: Int = 0
}

/**
 * A website inside GenX's viewing area (Local station pages and Websites).
 * On Android 11+ the page runs in the separate ":web" process (WebPageService)
 * and is shown here through a SurfaceView, so a hostile page cannot crash or
 * stall GenX (W10, docs/web-viewer-invariants.md). On Android 7-10 the same
 * PageController runs in GenX's process. Either way the page has no bridge to
 * GenX; remote keys reach it only while "entered".
 */
@TauriPlugin
class WebPagePlugin(private val activity: Activity) : Plugin(activity) {
  private val separate = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
  private val root get() = activity.window.decorView as ViewGroup
  private val ui = Handler(Looper.getMainLooper())

  /** The page's place in the window: the in-process container or the SurfaceView. */
  private var frame: View? = null
  private var local: PageController? = null
  private var entered = false
  private val notes = ArrayList<String>()
  private fun log(note: String) {
    synchronized(notes) { if (notes.size < 100) notes.add("${System.currentTimeMillis()} $note") }
  }

  private fun bounds(args: WebPageArgs): FrameLayout.LayoutParams =
    if (args.width <= 0 || args.height <= 0) {
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    } else {
      FrameLayout.LayoutParams(args.width, args.height).apply {
        // The rectangle is in GenX's WebView; the page sits in the window, so
        // add where that WebView starts (it is inset from the system bars on
        // Android 15+, and at the window's corner elsewhere).
        val origin = IntArray(2).also { appView()?.getLocationInWindow(it) }
        leftMargin = args.left.coerceAtLeast(0) + origin[0]
        topMargin = args.top.coerceAtLeast(0) + origin[1]
      }
    }
  private fun size(args: WebPageArgs) =
    if (args.width > 0 && args.height > 0) args.width to args.height else root.width to root.height

  /** GenX's own WebView (not the page). */
  private fun appView(): WebView? {
    fun find(group: ViewGroup): WebView? {
      for (i in 0 until group.childCount) {
        val child = group.getChildAt(i)
        if (child is WebView && child.parent !== frame) return child
        if (child is ViewGroup && child !== frame) find(child)?.let { return it }
      }
      return null
    }
    return find(root)
  }

  /**
   * Page events into GenX's interface, from a fixed list and rebuilt from
   * plain values, so nothing the page supplies runs as code (W07).
   */
  // A downloaded app left from an earlier session is deleted at start-up (W15).
  private val apps = ApkInstaller(activity).also { it.cleanup() }
  private fun dispatch(name: String, detail: JSONObject?) {
    if (name == "genx-apk-offer") {
      detail ?: return
      val text = { key: String, max: Int -> detail.optString(key).take(max).ifEmpty { null } }
      apps.start(text("url", 16_384) ?: return, text("userAgent", 512), text("referer", 2048),
        text("disposition", 1024), text("mime", 256), text("cookie", 8192))
      return
    }
    if (name == "genx-download-refused") {
      apps.refused(if (detail?.optString("kind") == "bundle") "bundle" else "file")
      return
    }
    val safe = when (name) {
      "genx-page-save" -> JSONObject()
        .put("url", detail?.optString("url")?.take(2048) ?: "")
        .put("title", detail?.optString("title")?.take(400) ?: "")
      "genx-page-left" -> JSONObject().put("reason", detail?.optString("reason").takeIf { it in setOf("Back", "edge", "address") } ?: "other")
      "genx-page-address", "genx-page-closed" -> null
      else -> return
    }
    val script = "dispatchEvent(new CustomEvent(${JSONObject.quote(name)}${if (safe != null) ",{detail:$safe}" else ""}))"
    appView()?.evaluateJavascript(script, null)
  }
  private fun toggleFullscreen() =
    appView()?.evaluateJavascript("document.getElementById('fullscreen-button')?.click()", null)

  // Keys: while entered, GenX hands the remote to the page.
  private fun keysOn() {
    entered = true
    (activity as? MainActivity)?.pageKeys = { event -> onKey(event) }
    // Web process: focusing the SurfaceView gives the embedded page real
    // window focus, so keys go straight to it and the keyboard can type into
    // the site's own fields. Forwarding above stays as the fallback.
    (frame as? SurfaceView)?.apply {
      isFocusable = true
      isFocusableInTouchMode = true
      requestFocus()
    }
  }
  /** The remote returns to GenX; when the viewer left the page, GenX is told how (Back, the left edge, Address). */
  private fun keysOff(reason: String? = null) {
    entered = false
    (activity as? MainActivity)?.pageKeys = null
    appView()?.requestFocus()
    if (reason != null) dispatch("genx-page-left", JSONObject().put("reason", reason))
  }
  private val pageCodes = setOf(
    KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER,
    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_BACK,
    KeyEvent.KEYCODE_MENU,
  )
  private fun onKey(event: KeyEvent): Boolean {
    local?.let { return it.handleKey(event.keyCode, event) }
    if (event.keyCode !in pageCodes) return false
    send(WebPageService.KEY, Bundle().apply { putParcelable("key", event) })
    return true
  }

  // In-process page (Android 7-10).
  private val localHost = object : PageHost {
    override fun left(reason: String) = keysOff(reason)
    override fun genxEvent(name: String, detail: JSONObject?) = dispatch(name, detail)
    override fun toggleFullscreen() { this@WebPagePlugin.toggleFullscreen() }
  }

  // Web process (Android 11+).
  private var service: Messenger? = null
  private var bound = false
  private val waiting = ArrayList<Message>()
  private val statusWaits = HashMap<Int, Invoke>()
  private var nextStatus = 1
  private val replies = Messenger(Handler(Looper.getMainLooper()) { message -> reply(message); true })
  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName, binder: IBinder) {
      service = Messenger(binder)
      try {
        binder.linkToDeath({ ui.post { gone("web process ended") } }, 0)
      } catch (_: Exception) {
        ui.post { gone("web process ended") }
        return
      }
      val queued = ArrayList(waiting)
      waiting.clear()
      queued.forEach { deliver(it) }
    }
    override fun onServiceDisconnected(name: ComponentName) = gone("web process ended")
    override fun onBindingDied(name: ComponentName) = gone("web process ended")
  }
  private fun send(what: Int, data: Bundle? = null, arg1: Int = 0) {
    val message = Message.obtain(null, what, arg1, 0).apply {
      replyTo = replies
      if (data != null) this.data = data
    }
    if (service == null) waiting.add(message) else deliver(message)
  }
  private fun deliver(message: Message) {
    try { service?.send(message) } catch (_: Exception) { gone("web process ended") }
  }
  private fun bind() {
    if (bound) return
    bound = activity.bindService(Intent(activity, WebPageService::class.java), connection, Context.BIND_AUTO_CREATE)
  }
  private fun unbind() {
    if (bound) try { activity.unbindService(connection) } catch (_: Exception) { }
    bound = false
    service = null
    waiting.clear()
  }
  /** The web process went away (a hostile page crashed it, or Android ended it): GenX carries on. */
  private fun gone(reason: String) {
    val hadPage = frame != null
    frame?.let { root.removeView(it) }
    frame = null
    if (entered) keysOff()
    statusWaits.values.forEach { it.resolve(JSObject().put("schemaVersion", 1).put("open", false)) }
    statusWaits.clear()
    unbind()
    log(reason)
    if (hadPage) dispatch("genx-page-closed", null)
  }
  private fun reply(message: Message) {
    val data = message.data
    when (message.what) {
      WebPageService.SURFACE -> {
        @Suppress("DEPRECATION")
        val pkg = data.getParcelable<SurfaceControlViewHost.SurfacePackage>("package") ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) (frame as? SurfaceView)?.setChildSurfacePackage(pkg)
        // Focus can only pass to the page once its surface is attached.
        if (entered) keysOn()
      }
      WebPageService.LEFT -> keysOff(data.getString("reason") ?: "other")
      WebPageService.EVENT -> dispatch(
        data.getString("name") ?: return,
        data.getString("detail")?.let { runCatching { JSONObject(it) }.getOrNull() },
      )
      WebPageService.TOGGLE_FULLSCREEN -> toggleFullscreen()
      // The surface is in GenX's window, so its flag holds the screen on.
      WebPageService.AWAKE -> frame?.keepScreenOn = message.arg1 == 1
      WebPageService.STATUS_REPLY -> statusWaits.remove(message.arg1)?.resolve(
        runCatching { JSObject(data.getString("status") ?: "{}") }.getOrElse { JSObject() }
          .put("separateProcess", true),
      )
    }
  }

  private fun closePage() {
    local?.close()
    local = null
    if (frame != null) send(WebPageService.CLOSE)
    frame?.let { root.removeView(it) }
    frame = null
    if (entered) keysOff()
  }

  @Command fun open(invoke: Invoke) {
    val args = invoke.parseArgs(WebPageArgs::class.java)
    if (!args.url.startsWith("https://") || args.url.length > 4096) {
      invoke.reject("web-page-invalid"); return
    }
    activity.runOnUiThread {
      closePage()
      if (separate) {
        bind()
        val surface = SurfaceView(activity).apply {
          // The page is a layer above GenX's window; GenX hides it for dialogs.
          setZOrderOnTop(true)
          holder.setFormat(PixelFormat.TRANSLUCENT)
        }
        root.addView(surface, bounds(args))
        frame = surface
        surface.post {
          if (frame !== surface) return@post
          val (width, height) = size(args)
          send(WebPageService.OPEN, Bundle().apply {
            putString("url", args.url)
            putInt("width", width)
            putInt("height", height)
            putInt("display", activity.display?.displayId ?: 0)
            putBinder("hostToken", surface.hostToken)
          })
          send(WebPageService.ENTER, Bundle().apply { putBoolean("value", true) })
        }
      } else {
        // A PageFrame so touches reach the page's control bar here too (Android 7-10).
        val container = PageFrame(activity)
        root.addView(container, bounds(args))
        frame = container
        local = PageController(activity, container, localHost).also { it.open(args.url); it.enter() }
      }
      keysOn()
      log("open ${args.url.take(120)}")
      invoke.resolve(JSObject().apply { put("schemaVersion", 1); put("opened", true); put("separateProcess", separate) })
    }
  }

  /** Follows the viewing area (layout changes, fullscreen). */
  @Command fun place(invoke: Invoke) {
    val args = invoke.parseArgs(WebPageArgs::class.java)
    activity.runOnUiThread {
      frame?.layoutParams = bounds(args)
      val (width, height) = size(args)
      local?.resized(width, height)
      if (separate && frame != null)
        send(WebPageService.RESIZE, Bundle().apply { putInt("width", width); putInt("height", height) })
      invoke.resolve(JSObject().apply { put("schemaVersion", 1); put("placed", frame != null) })
    }
  }

  @Command fun enter(invoke: Invoke) {
    activity.runOnUiThread {
      if (frame != null) {
        keysOn()
        local?.enter()
        if (separate) send(WebPageService.ENTER, Bundle().apply { putBoolean("value", true) })
      }
      invoke.resolve(JSObject().apply { put("schemaVersion", 1); put("entered", frame != null) })
    }
  }

  /** GenX fullscreen: only the page's video. */
  @Command fun video(invoke: Invoke) = setVideoOnly(invoke, true)
  /** Back to the whole page. */
  @Command fun page(invoke: Invoke) = setVideoOnly(invoke, false)
  private fun setVideoOnly(invoke: Invoke, value: Boolean) {
    activity.runOnUiThread {
      local?.setVideoOnly(value)
      if (separate && frame != null) send(WebPageService.VIDEO, Bundle().apply { putBoolean("value", value) })
      invoke.resolve(JSObject().apply { put("schemaVersion", 1); put("videoOnly", value) })
    }
  }

  /** The page's own history. */
  @Command fun back(invoke: Invoke) = step(invoke, back = true)
  @Command fun forward(invoke: Invoke) = step(invoke, back = false)
  private fun step(invoke: Invoke, back: Boolean) {
    activity.runOnUiThread {
      local?.history(back)
      if (separate && frame != null) send(WebPageService.HISTORY, Bundle().apply { putBoolean("back", back) })
      invoke.resolve(JSObject().apply { put("schemaVersion", 1); put("moved", frame != null) })
    }
  }

  // W11: the page pauses with GenX (only the page; never global timers).
  override fun onPause() {
    activity.runOnUiThread {
      local?.pause()
      if (separate && frame != null) send(WebPageService.PAUSE, Bundle().apply { putBoolean("value", true) })
    }
  }
  override fun onResume() {
    activity.runOnUiThread {
      local?.resume()
      if (separate && frame != null) send(WebPageService.PAUSE, Bundle().apply { putBoolean("value", false) })
    }
  }

  /** GenX's dock Pause and Mute, sent to the page's videos in every frame. */
  @Command fun play(invoke: Invoke) = sendRemote(invoke, "play")
  @Command fun mute(invoke: Invoke) = sendRemote(invoke, "mute")
  private fun sendRemote(invoke: Invoke, command: String) {
    activity.runOnUiThread {
      local?.remote(command)
      if (separate && frame != null) send(WebPageService.REMOTE, Bundle().apply { putString("cmd", command) })
      invoke.resolve(JSObject().apply { put("schemaVersion", 1); put("sent", frame != null) })
    }
  }

  /** A GenX dialog is open: the page (drawn above GenX) steps aside until it closes. */
  @Command fun hide(invoke: Invoke) = setShown(invoke, false)
  @Command fun show(invoke: Invoke) = setShown(invoke, true)
  private fun setShown(invoke: Invoke, shown: Boolean) {
    activity.runOnUiThread {
      frame?.visibility = if (shown) View.VISIBLE else View.GONE
      if (!shown && entered) {
        local?.leave("dialog", notify = false)
        if (separate && frame != null) send(WebPageService.ENTER, Bundle().apply { putBoolean("value", false) })
        keysOff()
      }
      invoke.resolve(JSObject().apply { put("schemaVersion", 1); put("shown", shown) })
    }
  }

  @Command fun status(invoke: Invoke) {
    activity.runOnUiThread {
      local?.let { controller ->
        invoke.resolve(JSObject(controller.status().toString()).put("separateProcess", false))
        return@runOnUiThread
      }
      if (frame == null || !separate) {
        invoke.resolve(JSObject().put("schemaVersion", 1).put("open", false).put("separateProcess", separate))
        return@runOnUiThread
      }
      val id = nextStatus++
      statusWaits[id] = invoke
      send(WebPageService.STATUS, null, id)
      // A busy or stuck page process must not hold GenX's question forever.
      ui.postDelayed({
        statusWaits.remove(id)?.resolve(JSObject().put("schemaVersion", 1).put("open", true).put("unanswered", true))
      }, 3000)
    }
  }

  @Command fun close(invoke: Invoke) {
    activity.runOnUiThread {
      closePage()
      if (separate) unbind()
      log("closed")
      invoke.resolve(JSObject().apply { put("schemaVersion", 1); put("closed", true) })
    }
  }
}
