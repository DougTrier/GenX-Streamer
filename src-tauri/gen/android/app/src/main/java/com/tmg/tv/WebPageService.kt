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

import android.app.Service
import android.content.Intent
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.view.KeyEvent
import android.view.SurfaceControlViewHost
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.annotation.RequiresApi
import org.json.JSONObject
import java.io.File

/**
 * The website runs here, in the separate ":web" process (W10,
 * docs/web-viewer-invariants.md): a page that crashes or exhausts this process
 * cannot take GenX's own process or WebView with it. GenX shows this process's
 * view through a SurfaceControlViewHost placed over the viewing area and talks
 * to it only through these messages; nothing here can call into GenX.
 */
@RequiresApi(Build.VERSION_CODES.R)
class WebPageService : Service() {
  companion object {
    // GenX -> page
    const val OPEN = 1
    const val RESIZE = 2
    const val KEY = 3
    const val VIDEO = 4
    const val REMOTE = 5
    const val HISTORY = 6
    const val ENTER = 7
    const val STATUS = 8
    const val CLOSE = 9
    const val PAUSE = 10
    // page -> GenX
    const val SURFACE = 101
    const val LEFT = 102
    const val EVENT = 103
    const val TOGGLE_FULLSCREEN = 104
    const val STATUS_REPLY = 105
    const val AWAKE = 106
  }

  private var viewHost: SurfaceControlViewHost? = null
  private var container: FrameLayout? = null
  private var controller: PageController? = null
  private var client: Messenger? = null

  private fun send(what: Int, data: Bundle? = null, arg1: Int = 0) {
    val message = Message.obtain(null, what, arg1, 0)
    if (data != null) message.data = data
    try { client?.send(message) } catch (_: Exception) { /* GenX went away; nothing to tell. */ }
  }

  private val host = object : PageHost {
    override fun left(reason: String) = send(LEFT, Bundle().apply { putString("reason", reason) })
    override fun genxEvent(name: String, detail: JSONObject?) =
      send(EVENT, Bundle().apply { putString("name", name); putString("detail", detail?.toString()) })
    override fun toggleFullscreen() = send(TOGGLE_FULLSCREEN)
    override fun keepAwake(on: Boolean) = send(AWAKE, arg1 = if (on) 1 else 0)
  }

  private val inbox = Messenger(Handler(Looper.getMainLooper()) { message -> handle(message); true })

  override fun onCreate() {
    super.onCreate()
    // W15: a new page process starts with no site data at all. These folders
    // hold only websites' data, and nothing here has opened them yet, so what
    // a crash or a site's service worker left behind is removed whole.
    File(dataDir, "app_webview_web").deleteRecursively()
    File(cacheDir, "webview_web").deleteRecursively()
    // Each process using WebView needs its own data directory.
    try { WebView.setDataDirectorySuffix("web") } catch (_: IllegalStateException) { /* already set */ }
  }

  override fun onBind(intent: Intent): IBinder = inbox.binder

  override fun onUnbind(intent: Intent): Boolean {
    close()
    return false
  }

  private fun close() {
    controller?.close()
    controller = null
    viewHost?.release()
    viewHost = null
    container = null
  }

  private fun handle(message: Message) {
    val data = message.data
    when (message.what) {
      OPEN -> {
        client = message.replyTo
        close()
        val display = getSystemService(DisplayManager::class.java).getDisplay(data.getInt("display")) ?: return
        val token = data.getBinder("hostToken") ?: return
        val width = data.getInt("width").coerceAtLeast(1)
        val height = data.getInt("height").coerceAtLeast(1)
        val context = createDisplayContext(display)
        val frame = PageFrame(context)
        val surface = SurfaceControlViewHost(context, display, token)
        surface.setView(frame, width, height)
        container = frame
        viewHost = surface
        controller = PageController(context, frame, host).also { it.open(data.getString("url") ?: return) }
        send(SURFACE, Bundle().apply { putParcelable("package", surface.surfacePackage) })
      }
      RESIZE -> {
        val width = data.getInt("width").coerceAtLeast(1)
        val height = data.getInt("height").coerceAtLeast(1)
        viewHost?.relayout(width, height)
        controller?.resized(width, height)
      }
      KEY -> {
        @Suppress("DEPRECATION")
        val event = data.getParcelable<KeyEvent>("key") ?: return
        controller?.handleKey(event.keyCode, event)
      }
      VIDEO -> controller?.setVideoOnly(data.getBoolean("value"))
      REMOTE -> controller?.remote(if (data.getString("cmd") == "mute") "mute" else "play")
      HISTORY -> controller?.history(data.getBoolean("back"))
      ENTER -> if (data.getBoolean("value")) controller?.enter() else controller?.leave("GenX", notify = false)
      PAUSE -> if (data.getBoolean("value")) controller?.pause() else controller?.resume()
      STATUS -> send(
        STATUS_REPLY,
        Bundle().apply { putString("status", (controller?.status() ?: JSONObject().put("open", false)).toString()) },
        message.arg1,
      )
      CLOSE -> close()
    }
  }
}
