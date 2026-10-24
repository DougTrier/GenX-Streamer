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

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.TextUtils
import android.view.Choreographer
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

/**
 * Ad and tracker hosts refused inside station pages. Ads served inside the
 * stream itself cannot be removed this way; players skip a refused pre-roll.
 */
object PageAds {
  private val hosts = setOf(
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
    "googletagservices.com", "amazon-adsystem.com", "adnxs.com", "taboola.com", "outbrain.com",
    "criteo.com", "criteo.net", "pubmatic.com", "rubiconproject.com", "openx.net", "casalemedia.com",
    "moatads.com", "adsrvr.org", "teads.tv", "yieldmo.com", "33across.com", "sharethrough.com",
    "indexww.com", "smartadserver.com", "media.net", "quantserve.com", "zergnet.com", "springserve.com",
    "spotxchange.com", "spotx.tv", "lijit.com", "sovrn.com", "triplelift.com", "3lift.com", "gumgum.com",
    "kargo.com", "adform.net", "bidswitch.net", "scorecardresearch.com", "adlightning.com",
    "confiant-integrations.net", "permutive.com", "permutive.app", "bounceexchange.com", "nativo.com",
    "ntv.io", "revcontent.com", "mgid.com", "primis.tech", "aniview.com", "vidazoo.com", "minutemedia-prebid.com",
  )
  fun blocked(host: String?): Boolean {
    var name = host?.lowercase() ?: return false
    while (true) {
      if (name in hosts) return true
      val dot = name.indexOf('.')
      if (dot < 0 || name.indexOf('.', dot + 1) < 0) return false
      name = name.substring(dot + 1)
    }
  }
  /** Hides the empty frames ad slots leave behind. */
  const val hide = """
    (() => {
      if (document.getElementById('genx-hide-ads')) return;
      const s = document.createElement('style');
      s.id = 'genx-hide-ads';
      s.textContent = '[id^="google_ads"],[id^="div-gpt-ad"],[id^="taboola"],.trc_related_container,.OUTBRAIN,iframe[src*="doubleclick"],iframe[src*="googlesyndication"],[data-ad-slot],[data-google-query-id],.adsbygoogle{display:none!important}';
      document.documentElement.appendChild(s);
    })()
  """
}

/** An arrow pointer drawn above the page, moved with the remote; in GenX fullscreen also a control bar. */
class RemotePointer(context: Context) : View(context) {
  var px = 0f
  var py = 0f
  /** Control bar (top-left): the pointer clicks these instead of the page. */
  var bar = false
  /** The third button: "Full screen" in the window, "Exit full screen" in fullscreen. */
  var fullscreen = false
  /** The page's name and address, shown above the buttons. */
  var address = ""
  /** Fingers drive the page (touch screens): the remote's arrow is not drawn. */
  var touchMode = false
  val buttons get() = listOf(
    "back" to "\u25C0 Back", "forward" to "Forward \u25B6", "save" to "\u2605 Save", "address" to "Address",
    "play" to "Play / Pause", "mute" to "Mute", "full" to if (fullscreen) "Exit full screen" else "Full screen",
  )
  val rects = List(7) { RectF() }
  private val addressPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(127, 234, 250) }
  private val barFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(215, 10, 14, 32); style = Paint.Style.FILL }
  private val barEdge = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(34, 227, 255); style = Paint.Style.STROKE; strokeWidth = 3f }
  private val hot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(255, 54, 180); style = Paint.Style.STROKE; strokeWidth = 4f }
  private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textAlign = Paint.Align.CENTER }
  /** The button just pressed, drawn filled for a moment so the press shows at once. */
  var pressed: String? = null
  private val pressFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(255, 54, 180); style = Paint.Style.FILL }
  /** The bar button under the pointer, if any. */
  fun buttonAt(x: Float, y: Float): String? =
    if (!bar) null else buttons.indices.firstOrNull { rects[it].contains(x, y) }?.let { buttons[it].first }
  /** The bar's lower edge, as last drawn. */
  private var barBottom = 0f
  /** The pointer is on the bar or just below it (the bar stays while it is used). */
  fun nearBar(y: Float) = bar && y <= barBottom + 24f
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.FILL }
  private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; style = Paint.Style.STROKE; strokeWidth = 3f }
  private val arrow = Path().apply {
    moveTo(0f, 0f); lineTo(0f, 34f); lineTo(9f, 26f); lineTo(16f, 40f); lineTo(22f, 37f); lineTo(15f, 24f); lineTo(27f, 24f); close()
  }
  override fun onDraw(canvas: Canvas) {
    if (bar) {
      // Top-left, where sites keep only their logo: players put their own
      // controls along the bottom, and the bar must never cover them.
      // Fingers need bigger buttons than the remote's pointer: at least 44dp.
      val h = (height * 0.06f).coerceIn(40f, 72f).let {
        if (touchMode) maxOf(it, 44f * resources.displayMetrics.density).coerceAtMost(height * 0.14f) else it
      }
      val gap = h * 0.2f
      val count = buttons.size
      val w = ((width - h * 0.8f - gap * (count - 1)) / count).coerceIn(90f, 260f)
      var x = h * 0.4f
      // The page's name and address on a strip, the buttons below it.
      addressPaint.textSize = h * 0.36f
      val strip = RectF(h * 0.3f, h * 0.2f, width - h * 0.3f, h * 0.2f + h * 0.7f)
      canvas.drawRoundRect(strip, h * 0.2f, h * 0.2f, barFill)
      val text = TextUtils.ellipsize(address, android.text.TextPaint(addressPaint), strip.width() - h * 0.6f, TextUtils.TruncateAt.END)
      canvas.drawText(text, 0, text.length, strip.left + h * 0.3f, strip.centerY() + addressPaint.textSize * 0.35f, addressPaint)
      val y = strip.bottom + h * 0.2f
      buttons.forEachIndexed { i, (_, text) ->
        val r = rects[i].apply { set(x, y, x + w, y + h) }
        // Each label fits inside its button (taller touch buttons, narrow screens).
        label.textSize = h * 0.34f
        val room = w - h * 0.4f
        label.measureText(text).let { if (it > room) label.textSize *= room / it }
        canvas.drawRoundRect(r, h / 2, h / 2, if (buttons[i].first == pressed) pressFill else barFill)
        canvas.drawRoundRect(r, h / 2, h / 2, if (!touchMode && r.contains(px, py)) hot else barEdge)
        canvas.drawText(text, r.centerX(), r.centerY() + label.textSize * 0.35f, label)
        x += w + gap
      }
      barBottom = y + h
    }
    if (touchMode) return
    canvas.save()
    canvas.translate(px, py)
    canvas.drawPath(arrow, fill)
    canvas.drawPath(arrow, edge)
    canvas.restore()
  }
}

/**
 * The page's container. When the page holds real focus (web process), keys go
 * to Chromium's own focused view inside the WebView; catching them here first
 * gives the remote's pointer keys to the controller, everything else (typing)
 * to the page.
 */
class PageFrame(context: Context) : FrameLayout(context) {
  var keys: ((KeyEvent) -> Boolean)? = null
  /** Finger touches: the control bar's buttons first, everything else to the page. */
  var touches: ((MotionEvent) -> Boolean)? = null
  override fun dispatchKeyEvent(event: KeyEvent): Boolean =
    keys?.invoke(event) == true || super.dispatchKeyEvent(event)
  override fun dispatchTouchEvent(event: MotionEvent): Boolean =
    touches?.invoke(event) == true || super.dispatchTouchEvent(event)
}

/** What a page needs from GenX; in-process or across the web process boundary. */
interface PageHost {
  /** The remote returns to GenX (Back, Left at the edge, Address). */
  fun left(reason: String)
  /** One of GenX's page events: genx-page-save, genx-page-address, genx-page-closed. */
  fun genxEvent(name: String, detail: JSONObject?)
  /** GenX's own Full screen button (a toggle). */
  fun toggleFullscreen()
  /**
   * The page's video asks to keep the screen on. In GenX's process the
   * WebView's own flag already does; the web process's window cannot, so GenX
   * holds it for the page.
   */
  fun keepAwake(on: Boolean) {}
}

/**
 * One website inside GenX's viewing area (docs/web-viewer-invariants.md): a
 * plain WebView with no bridge to GenX, the remote pointer and on-screen bar,
 * and the hostile-page rules. Everything lives in [container], the size of the
 * viewing area; a site's own full screen asks GenX to go full screen. Runs in
 * GenX's process on Android 7-10 and in the separate web process on 11+.
 */
class PageController(
  private val context: Context,
  private val container: FrameLayout,
  private val host: PageHost,
) {
  init {
    (container as? PageFrame)?.keys = { event -> entered && handleKey(event.keyCode, event) }
    (container as? PageFrame)?.touches = { event -> touch(event) }
  }
  /** The bar button a finger went down on, pressed when it lifts on the same button. */
  private var barTouch: String? = null

  /**
   * Touch screens: any touch shows the control bar (Back, Forward, Save,
   * Address, Play/Pause, Mute, Full screen) and hides the remote's arrow; a tap
   * on a bar button presses it and never reaches the page; every other touch
   * (taps, scrolling, the site's own controls) goes to the page unchanged.
   */
  private fun touch(event: MotionEvent): Boolean {
    val arrow = pointer ?: return false
    return when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        if (!arrow.touchMode) { arrow.touchMode = true; arrow.invalidate() }
        val button = arrow.buttonAt(event.x, event.y)
        barTouch = button
        wakeBar(touch = true)
        button != null
      }
      MotionEvent.ACTION_UP -> {
        val button = barTouch ?: return false
        barTouch = null
        if (arrow.buttonAt(event.x, event.y) == button) barAction(button)
        true
      }
      MotionEvent.ACTION_CANCEL -> { val had = barTouch != null; barTouch = null; had }
      else -> barTouch != null
    }
  }
  private var page: WebView? = null
  private var custom: View? = null
  private var customExit: WebChromeClient.CustomViewCallback? = null
  private var pointer: RemotePointer? = null
  /** GenX is fullscreen: only the page's video (or player frame) shows. */
  private var videoOnly = false
  /** GenX went full screen because the site asked; undone when the viewer leaves it. */
  private var fullscreenForSite = false
  private val ui = Handler(Looper.getMainLooper())
  private val hideBar = Runnable { pointer?.let { it.bar = false; it.invalidate() } }
  /** Whether the page's video keeps the screen on (WebView marks a view for it). */
  private var awake = false
  private val awakeCheck = object : Runnable {
    override fun run() {
      if (page == null) return
      val on = keepsScreenOn(container, 0)
      if (on != awake) { awake = on; host.keepAwake(on); log("screen kept on $on") }
      ui.postDelayed(this, 3000)
    }
  }
  private fun keepsScreenOn(view: View, depth: Int): Boolean {
    if (view.keepScreenOn) return true
    if (view !is ViewGroup || depth >= 6) return false
    for (index in 0 until view.childCount) if (keepsScreenOn(view.getChildAt(index), depth + 1)) return true
    return false
  }
  /** The remote drives the page (pointer shown). */
  var entered = false
    private set
  /** The site whose address the bar last showed on arrival (W12). */
  private var shownHost = ""
  /** Set while GenX itself ends the site's fullscreen (Back, the bar). */
  private var exitingSiteFullscreen = false
  val open get() = page != null
  private val events = ArrayList<String>()
  @Volatile private var adsBlocked = 0
  private fun log(event: String) {
    synchronized(events) { if (events.size < 300) events.add("${System.currentTimeMillis()} $event") }
  }

  /**
   * The control bar covers the top of the page (where sites keep their search
   * boxes), so the remote shows it only when asked: briefly on entering the
   * page or changing full screen, then by pushing Up at the top of the page or
   * pressing Menu. It fades after 5 s, and at once when the pointer moves below it.
   */
  private fun wakeBar(touch: Boolean = false) {
    val arrow = pointer ?: return
    ui.removeCallbacks(hideBar)
    page?.let { view ->
      val name = view.url?.let { android.net.Uri.parse(it).host?.removePrefix("www.") } ?: ""
      val title = view.title?.takeIf { it.isNotBlank() && it != view.url } ?: ""
      arrow.address = if (title.isEmpty()) name else "$title \u00B7 $name"
    }
    arrow.fullscreen = videoOnly || custom != null
    if (!touch && !entered && custom == null) { if (arrow.bar) { arrow.bar = false; arrow.invalidate() }; return }
    arrow.bar = true
    arrow.invalidate()
    ui.postDelayed(hideBar, 5000)
  }
  // Remote commands reach the video in every frame (players often live in
  // another site's frame): each frame acts on its own visible videos and
  // passes the command to its child frames.
  private val remoteToken = java.util.UUID.randomUUID().toString()
  private val frameAgent get() = """
    (() => {
      if (window.__genxAgent) return;
      window.__genxAgent = true;
      const videos = (root, out = []) => {
        root.querySelectorAll('video').forEach((v) => out.push(v));
        root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) videos(e.shadowRoot, out); });
        return out;
      };
      addEventListener('message', (event) => {
        const data = event.data;
        if (!data || data.genxRemote !== '$remoteToken') return;
        const shown = videos(document).filter((v) => v.clientWidth * v.clientHeight > 0 && v.readyState > 0);
        for (const v of shown) {
          if (data.cmd === 'play') { if (v.paused) v.play().catch(() => {}); else v.pause(); }
          if (data.cmd === 'mute') v.muted = !v.muted;
        }
        for (let i = 0; i < frames.length; i++) { try { frames[i].postMessage(data, '*'); } catch (e) {} }
      });
      // A video starting to play tells the page which frame holds it, so GenX's
      // Full screen shows the video being watched, not the biggest one.
      document.addEventListener('playing', (event) => {
        if (event.target instanceof HTMLMediaElement && parent !== window)
          parent.postMessage({ genxPlaying: '$remoteToken' }, '*');
      }, true);
      addEventListener('message', (event) => {
        const data = event.data;
        if (!data || data.genxPlaying !== '$remoteToken') return;
        for (const frame of document.querySelectorAll('iframe'))
          if (frame.contentWindow === event.source) frame.dataset.genxPlaying = String(Date.now());
        if (parent !== window) parent.postMessage(data, '*');
      });
    })()
  """.trimIndent()
  fun remote(cmd: String) {
    page?.evaluateJavascript("window.postMessage({genxRemote:'$remoteToken',cmd:'$cmd'},'*')", null)
  }

  /** Remote keys go to the page and its pointer. */
  fun enter() {
    val view = page ?: return
    pointer?.visibility = View.VISIBLE
    entered = true
    view.requestFocus()
    wakeBar()
  }
  /** Remote keys return to GenX; the page stays in the viewing area. */
  fun leave(reason: String, notify: Boolean = true) {
    held.clear()
    released.clear()
    pulsing.clear()
    entered = false
    pointer?.visibility = View.GONE
    log("left by $reason")
    if (notify) host.left(reason)
  }
  private fun barAction(action: String) {
    val view = page ?: return
    pointer?.let { arrow ->
      arrow.pressed = action
      // Full screen flips its label now; the screen follows a moment later.
      if (action == "full") arrow.fullscreen = !arrow.fullscreen
      arrow.invalidate()
      ui.postDelayed({ if (arrow.pressed == action) { arrow.pressed = null; arrow.invalidate() } }, 250)
    }
    when (action) {
      "play", "mute" -> remote(action)
      "full" -> if (custom != null) exitSiteFullscreen() else host.toggleFullscreen()
      "back" -> if (view.canGoBack()) view.goBack()
      "forward" -> if (view.canGoForward()) view.goForward()
      // GenX keeps saved websites; the page never writes them itself.
      "save" -> host.genxEvent("genx-page-save", JSONObject().put("url", view.url ?: "").put("title", view.title ?: ""))
      "address" -> {
        if (custom != null) exitSiteFullscreen()
        leave("address")
        host.genxEvent("genx-page-address", null)
      }
    }
    if (entered) wakeBar()
    log("bar $action")
  }

  // Lets the page's video (else its player frame) fill the page, the way a
  // site's own fullscreen does; GenX's bar gives Play/Pause, Mute and Exit.
  // Players often create their video only after Play, so the page keeps
  // watching while GenX is fullscreen.
  // Low-memory TVs: VP9/AV1 hardware decoding cost the Sansui (1.7 GB) about
  // 200 MB more than H.264 and twice got the page killed by Android; on the
  // 4 GB Streamer they cost the same (artifacts/web-viewer/2026-10-18). Sites
  // on low-memory devices are offered H.264 only; other devices keep all codecs.
  private val preferH264 = context.getSystemService(ActivityManager::class.java)?.let { am ->
    am.isLowRamDevice || ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }.totalMem < (3L shl 30)
  } ?: false
  private val h264Only = """
    (() => {
      // Low-memory TVs only (PageController): sites are told VP9 and AV1 do not
      // play, so they send H.264, which the TV decodes in far less memory.
      const other = (type) => /vp0?9|av01|av1/i.test(String(type));
      const source = window.MediaSource;
      if (source?.isTypeSupported) {
        const supported = source.isTypeSupported.bind(source);
        source.isTypeSupported = (type) => !other(type) && supported(type);
      }
      const capabilities = navigator.mediaCapabilities;
      if (capabilities?.decodingInfo) {
        const decoding = capabilities.decodingInfo.bind(capabilities);
        capabilities.decodingInfo = (config) =>
          other(config?.video?.contentType)
            ? Promise.resolve({ supported: false, smooth: false, powerEfficient: false })
            : decoding(config);
      }
      const canPlay = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (type) {
        return other(type) ? '' : canPlay.call(this, type);
      };
    })();
  """.trimIndent()
  private val showVideo = """
    (() => {
      window.__genxVideo = true;
      const size = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
      const fits = (e) => { const r = e.getBoundingClientRect(); return r.width >= 160 && r.height >= 90; };
      const all = (selector, root = document, out = []) => {
        root.querySelectorAll(selector).forEach((e) => out.push(e));
        root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) all(selector, e.shadowRoot, out); });
        return out;
      };
      const up = (e) => e.parentElement || (e.getRootNode() instanceof ShadowRoot ? e.getRootNode().host : null);
      const restore = () => {
        for (const [e, css] of window.__genxTouched || []) {
          e.style.cssText = css;
          e.removeAttribute('data-genx-player');
          e.removeAttribute('data-genx-anc');
        }
        window.__genxTouched = [];
        for (const sheet of window.__genxSheets || []) sheet.remove();
        window.__genxSheets = [];
        if (window.__genxGuard) { window.__genxGuard.disconnect(); window.__genxGuard = null; }
        window.__genxHeld = null;
        document.getElementById('genx-backdrop')?.remove();
      };
      window.__genxRestore = restore;
      const touch = (e, extra) => {
        window.__genxTouched.push([e, e.style.cssText]);
        e.style.cssText += extra;
      };
      // YouTube's mobile site picks 360p for itself whatever the screen. Full
      // screen asks its player for the best level the screen can show, never above.
      const sharpen = () => {
        const player = document.getElementById('movie_player');
        if (typeof player?.setPlaybackQualityRange !== 'function') return;
        try {
          const tall = Math.round(screen.height * devicePixelRatio);
          const heights = { highres: 4320, hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360 };
          const level = (player.getAvailableQualityLevels?.() ?? []).find((l) => heights[l] <= tall);
          if (level && player.getPlaybackQuality?.() !== level) player.setPlaybackQualityRange(level, level);
        } catch { /* the site's player, its rules */ }
      };
      const run = () => {
        if (!window.__genxVideo) return 'off';
        sharpen();
        if (window.__genxHeld && window.__genxHeld.isConnected) return 'kept';
        // The video being watched: one playing here, else the frame whose video
        // started most recently (frames report it), else the biggest.
        const largest = (list) => list.sort((a, b) => size(b) - size(a))[0];
        const videos = all('video').filter(fits);
        const frames = all('iframe').filter(fits);
        const playing = largest(videos.filter((v) => !v.paused && v.readyState > 2));
        const reported = frames.filter((f) => f.dataset.genxPlaying).sort((a, b) => Number(b.dataset.genxPlaying) - Number(a.dataset.genxPlaying))[0];
        // Only a frame that is a video player stands in for the video: one that may
        // go full screen or autoplay, or comes from a video host. Schedules, ads and
        // other boxes never do; with no player the page itself fills the screen.
        const playerLike = (f) =>
          f.hasAttribute('allowfullscreen') ||
          /fullscreen|autoplay|encrypted-media/.test(f.getAttribute('allow') || '') ||
          /youtube|vimeo|jwplayer|jwpcdn|brightcove|twitch|dailymotion|livestream|player|video|stream/i.test(f.src || '');
        const pick = playing || reported || largest(videos) || largest(frames.filter(playerLike));
        if (!pick) return 'none';
        // A player frame scales its own picture to the frame's width, so on a wide
        // screen (21:9, 32:9) a full-window frame runs off the top and bottom. The
        // frame keeps its own shape instead: the largest such box, centred.
        const box = pick.getBoundingClientRect();
        const shape = pick.tagName === 'IFRAME' ? Math.min(2.4, Math.max(1, box.width / box.height || 16 / 9)) : 0;
        restore();
        // Anything that makes an ancestor a containing block would trap the
        // fixed video inside the page (transforms, containment, filters), and
        // an ancestor's stacking context would let the site's header paint over it.
        const ancestor = 'transform:none!important;translate:none!important;scale:none!important;rotate:none!important;filter:none!important;backdrop-filter:none!important;perspective:none!important;contain:none!important;container-type:normal!important;content-visibility:visible!important;will-change:auto!important;z-index:auto!important;isolation:auto!important;transition:none!important';
        const roots = new Set();
        for (let p = up(pick); p && p !== document.documentElement; p = up(p)) {
          touch(p, ';' + ancestor);
          p.setAttribute('data-genx-anc', '');
          roots.add(p.getRootNode());
        }
        const fill = shape
          ? `width:min(100vw, calc(100vh * ${'$'}{shape}))!important;height:min(100vh, calc(100vw / ${'$'}{shape}))!important;margin:auto!important`
          : 'width:100vw!important;height:100vh!important;margin:0!important';
        const player = `position:fixed!important;inset:0!important;top:0!important;left:0!important;right:0!important;bottom:0!important;${'$'}{fill};max-width:none!important;max-height:none!important;padding:0!important;transform:none!important;z-index:2147483647!important;background:#000!important;object-fit:contain!important`;
        touch(pick, ';' + player);
        pick.setAttribute('data-genx-player', '');
        roots.add(pick.getRootNode());
        // Players rewrite their own size and place (YouTube does on every
        // resize). The same rules in a style sheet win over those writes, in
        // every document or shadow root holding a marked element (W02).
        window.__genxSheets = [];
        for (const root of roots) {
          const sheet = document.createElement('style');
          sheet.textContent = `[data-genx-player]{${'$'}{player}}[data-genx-anc]{${'$'}{ancestor}}`;
          (root === document ? document.documentElement : root).appendChild(sheet);
          window.__genxSheets.push(sheet);
        }
        // A site that strips the marker gets it back.
        window.__genxGuard = new MutationObserver(() => {
          if (pick.isConnected && !pick.hasAttribute('data-genx-player')) pick.setAttribute('data-genx-player', '');
        });
        window.__genxGuard.observe(pick, { attributes: true, attributeFilter: ['data-genx-player'] });
        // Black behind the picture, so the page never shows around it.
        const backdrop = document.createElement('div');
        backdrop.id = 'genx-backdrop';
        backdrop.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483646';
        document.documentElement.appendChild(backdrop);
        touch(document.documentElement, ';overflow:hidden!important');
        window.__genxHeld = pick;
        return pick.tagName.toLowerCase();
      };
      if (!window.__genxWatch) {
        let timer = 0;
        // At most one check every 400 ms: a page that never stops changing
        // (W02) cannot starve it, as waiting for quiet would.
        window.__genxWatch = new MutationObserver(() => { if (!timer) timer = setTimeout(() => { timer = 0; run(); }, 400); });
        window.__genxWatch.observe(document.documentElement, { childList: true, subtree: true });
      }
      return run();
    })()
  """.trimIndent()
  private val showPage = """
    (() => {
      window.__genxVideo = false;
      if (window.__genxWatch) { window.__genxWatch.disconnect(); window.__genxWatch = null; }
      if (window.__genxRestore) window.__genxRestore();
      // YouTube chooses its own quality again outside full screen.
      try { document.getElementById('movie_player')?.setPlaybackQualityRange?.('auto', 'auto'); } catch { /* site's player */ }
      return 'page';
    })()
  """.trimIndent()
  fun setVideoOnly(value: Boolean) {
    videoOnly = value
    if (!value) fullscreenForSite = false
    page?.let { view ->
      view.evaluateJavascript(if (videoOnly) showVideo else showPage) { result ->
        log("${if (videoOnly) "video" else "page"} $result")
      }
    }
    wakeBar()
  }

  @SuppressLint("SetJavaScriptEnabled")
  fun open(url: String) {
    close()
    val view = WebView(context)
    view.setBackgroundColor(Color.BLACK)
    view.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      mediaPlaybackRequiresUserGesture = false
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      allowFileAccess = false
      allowContentAccess = false
      setSupportMultipleWindows(false)
      // Hostile pages: no automatic windows, no location, Safe Browsing on.
      javaScriptCanOpenWindowsAutomatically = false
      setGeolocationEnabled(false)
      if (android.os.Build.VERSION.SDK_INT >= 26) safeBrowsingEnabled = true
    }
    view.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
        // Only https pages; never hand a link to another app.
        return request.url.scheme != "https"
      }
      override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse? {
        if (!PageAds.blocked(request.url.host)) return null
        adsBlocked++
        return WebResourceResponse("text/plain", "utf-8", 204, "No Content", emptyMap(), ByteArrayInputStream(ByteArray(0)))
      }
      // W10: the page's renderer dying is this view's loss, handled here; the
      // page closes and GenX is told (returning false would end the process).
      override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
        if (v !== page) return true
        log("renderer gone crashed=${detail.didCrash()}")
        close()
        host.genxEvent("genx-page-closed", null)
        return true
      }
      override fun onReceivedError(v: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (!request.isForMainFrame) return
        log("error ${error.errorCode} ${request.url.host}")
        val name = (request.url.host ?: "").replace(Regex("[^A-Za-z0-9.-]"), "")
        v.loadDataWithBaseURL(
          null,
          "<html><body style=\"margin:0;height:100vh;display:grid;place-items:center;background:#070d1c;color:#7feafa;font:24px sans-serif;text-align:center\"><div><p style=\"color:#fff0fc;font-size:30px\">This website isn't responding.</p><p>$name</p><p style=\"color:#9fb2c4\">Press Back, then choose another.</p></div></body></html>",
          "text/html", "utf-8", null,
        )
      }
      override fun onPageFinished(v: WebView, url: String) {
        v.evaluateJavascript(PageAds.hide, null)
        if (videoOnly) setVideoOnly(true)
        // W12: arriving on another site shows its real address on the bar.
        val host = android.net.Uri.parse(url).host?.removePrefix("www.") ?: ""
        if (host != shownHost) { shownHost = host; if (entered && !videoOnly) wakeBar() }
        log("loaded ${v.title?.take(80)} (ads refused $adsBlocked)")
      }
    }
    view.webChromeClient = object : WebChromeClient() {
      // W04: no modal trap; dialogs are answered without being shown.
      override fun onJsAlert(v: WebView, url: String?, message: String?, result: JsResult): Boolean {
        result.confirm(); log("dialog refused"); return true
      }
      override fun onJsConfirm(v: WebView, url: String?, message: String?, result: JsResult): Boolean {
        result.cancel(); log("dialog refused"); return true
      }
      override fun onJsPrompt(v: WebView, url: String?, message: String?, defaultValue: String?, result: JsPromptResult): Boolean {
        result.cancel(); log("dialog refused"); return true
      }
      override fun onJsBeforeUnload(v: WebView, url: String?, message: String?, result: JsResult): Boolean {
        result.confirm(); return true
      }
      // W05: no permission prompts.
      override fun onPermissionRequest(request: PermissionRequest) {
        request.deny(); log("permission refused")
      }
      override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
        callback.invoke(origin, false, false)
      }
      // A site's own full screen: its video fills the viewing area and GenX
      // goes full screen around it, so it covers the screen like before.
      override fun onShowCustomView(v: View, callback: CustomViewCallback) {
        custom = v
        customExit = callback
        v.isFocusable = true
        v.setOnKeyListener { _, code, event -> handleKey(code, event) }
        container.addView(v, container.indexOfChild(pointer).coerceAtLeast(0), FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        if (!videoOnly) { fullscreenForSite = true; host.toggleFullscreen() }
        v.requestFocus()
        log("fullscreen")
        wakeBar()
      }
      override fun onHideCustomView() {
        if (custom == null) return
        custom?.let { container.removeView(it) }
        custom = null
        customExit = null
        // The viewer left the site's full screen: GenX leaves it too. The site
        // leaving it by itself (often rolling to its next video) keeps GenX's
        // full screen, so the new player stays big.
        if (exitingSiteFullscreen && fullscreenForSite) host.toggleFullscreen()
        fullscreenForSite = false
        page?.requestFocus()
        wakeBar()
      }
    }
    // W06: downloads are never started here. W16: an Android app (APK) the
    // viewer clicked goes to GenX, which downloads it and opens Android's
    // installer; everything else is refused.
    view.setDownloadListener { url, userAgent, disposition, mime, _ ->
      if (ApkRules.isApk(url, mime, disposition)) {
        host.genxEvent("genx-apk-offer", JSONObject().put("url", url).put("userAgent", userAgent ?: "")
          .put("referer", view.url ?: "").put("disposition", disposition ?: "").put("mime", mime ?: "")
          .put("cookie", CookieManager.getInstance().getCookie(url) ?: ""))
        log("app download offered")
      } else {
        host.genxEvent("genx-download-refused", JSONObject().put("kind", if (ApkRules.isBundle(url, mime, disposition)) "bundle" else "file"))
        log("download refused")
      }
    }
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      WebViewCompat.addDocumentStartJavaScript(view, frameAgent, setOf("*"))
      if (preferH264) { WebViewCompat.addDocumentStartJavaScript(view, h264Only, setOf("*")); log("codecs: H.264 (low memory)") }
    } else log("frame agent unavailable")
    videoOnly = false
    container.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    val arrow = RemotePointer(context)
    container.addView(arrow, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    pointer = arrow
    page = view
    container.post {
      arrow.px = container.width / 2f
      arrow.py = container.height / 2f
      arrow.invalidate()
    }
    // Starts clean too, so a page that ended in a crash leaves nothing.
    forgetSites(view) { if (page === view) view.loadUrl(url) }
    ui.postDelayed(awakeCheck, 3000)
    log("open ${url.take(120)}")
  }

  // W15: websites leave nothing on the device. Their cache, cookies and stored
  // data go when a page closes and again before the next one opens. GenX's own
  // origin keeps its data (Android 7-10 run pages inside GenX's process).
  private fun forgetSites(view: WebView, then: (() -> Unit)? = null) {
    view.clearCache(true)
    val storage = WebStorage.getInstance()
    storage.getOrigins { origins ->
      origins?.keys?.forEach { origin ->
        if (Uri.parse(origin.toString()).host != "tauri.localhost") storage.deleteOrigin(origin.toString())
      }
    }
    val cookies = CookieManager.getInstance()
    cookies.removeAllCookies { cookies.flush(); then?.invoke() }
  }

  /** The viewing area changed size: keep the pointer inside it. */
  fun resized(width: Int, height: Int) {
    pointer?.let { arrow ->
      arrow.px = arrow.px.coerceIn(0f, (width - 4f).coerceAtLeast(0f))
      arrow.py = arrow.py.coerceIn(0f, (height - 4f).coerceAtLeast(0f))
      arrow.invalidate()
    }
  }

  fun history(back: Boolean) {
    page?.let { if (back && it.canGoBack()) it.goBack() else if (!back && it.canGoForward()) it.goForward() }
  }
  fun pause() { page?.onPause() }
  fun resume() { page?.onResume() }

  fun status(): JSONObject {
    val list = JSONArray()
    synchronized(events) { events.forEach { list.put(it) } }
    return JSONObject()
      .put("schemaVersion", 1)
      .put("open", page != null)
      .put("title", page?.title ?: "")
      .put("url", page?.url?.take(2048) ?: "")
      .put("adsBlocked", adsBlocked)
      .put("pointer", pointer?.let { "${it.px.toInt()},${it.py.toInt()}" } ?: "")
      .put("entered", entered)
      .put("videoOnly", videoOnly)
      .put("events", list)
  }

  /** Arrow keys held down, with when each was pressed. */
  private val held = LinkedHashMap<Int, Long>()
  /** Last press or repeat per held arrow; a lost key-up ends the glide after 3 s. */
  private val seen = HashMap<Int, Long>()
  /** When each held arrow was let go; it keeps gliding through infrared gaps. */
  private val released = HashMap<Int, Long>()
  private val RELEASE_GRACE_MS = 90L
  /** Arrows seen pulsing (infrared); only these keep moving between pulses. */
  private val pulsing = HashSet<Int>()
  private var gliding = false
  private var lastFrame = 0L
  private fun direction(code: Int): Pair<Float, Float> = when (code) {
    KeyEvent.KEYCODE_DPAD_LEFT -> -1f to 0f
    KeyEvent.KEYCODE_DPAD_RIGHT -> 1f to 0f
    KeyEvent.KEYCODE_DPAD_UP -> 0f to -1f
    else -> 0f to 1f
  }
  /** About 8 px on a 1080p screen. */
  private fun nudge() = (container.height.takeIf { it > 0 } ?: 1080) / 135f
  /**
   * Moves the pointer; past the top or bottom edge the page scrolls by the
   * same amount, so edge scrolling glides too.
   */
  private fun glide(dx: Float, dy: Float) {
    val arrow = pointer ?: return
    if (page == null) return
    val maxX = container.width - 4f
    val maxY = container.height - 4f
    arrow.px = (arrow.px + dx).coerceIn(0f, maxX.coerceAtLeast(0f))
    val y = arrow.py + dy
    arrow.py = y.coerceIn(0f, maxY.coerceAtLeast(0f))
    val overflow = y - arrow.py
    if (overflow != 0f && custom == null) page?.scrollBy(0, overflow.toInt())
    // Up at the top of a page that can scroll no further asks for the bar.
    if (overflow < 0f && (custom != null || page?.canScrollVertically(-1) != true)) wakeBar()
    else if (arrow.bar && !arrow.touchMode) {
      if (arrow.nearBar(arrow.py)) wakeBar() else { ui.removeCallbacks(hideBar); arrow.bar = false }
    }
    arrow.invalidate()
    hover()
  }
  /**
   * Each display frame while an arrow is held: after a short pause (so a tap
   * stays a tap) the pointer starts slowly and speeds up smoothly over two
   * seconds, from under a fifth of the screen height per second to a full
   * screen per second.
   */
  private val frame: Choreographer.FrameCallback = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      if (held.isEmpty() || page == null) { gliding = false; return }
      val now = SystemClock.uptimeMillis()
      held.keys.retainAll { code ->
        val up = released[code]
        val keep = if (up != null) now - up < RELEASE_GRACE_MS else now - (seen[code] ?: 0L) < 3000L
        if (!keep) { released.remove(code); seen.remove(code); pulsing.remove(code) }
        keep
      }
      if (held.isEmpty()) { gliding = false; return }
      val dt = if (lastFrame == 0L) 0f else ((frameTimeNanos - lastFrame) / 1e9f).coerceAtMost(0.05f)
      lastFrame = frameTimeNanos
      val screen = (container.height.takeIf { it > 0 } ?: 1080).toFloat()
      var dx = 0f
      var dy = 0f
      for ((code, since) in held) {
        // A released key waits for its next infrared pulse without moving,
        // unless it has already shown that pattern (then it glides through).
        if (released.containsKey(code) && code !in pulsing) continue
        val heldFor = now - since - 250L
        if (heldFor <= 0) continue
        val ramp = (heldFor / 2000f).coerceAtMost(1f)
        val speed = screen * (0.18f + 0.82f * ramp * ramp)
        val (x, y) = direction(code)
        dx += x * speed * dt
        dy += y * speed * dt
      }
      if (dx != 0f || dy != 0f) glide(dx, dy)
      Choreographer.getInstance().postFrameCallback(this)
    }
  }

  /**
   * Remote keys on the page: arrows nudge the pointer, or glide it smoothly
   * while held, scrolling past the top or bottom edge; OK clicks under it,
   * Play/Pause toggles the page's video; Back leaves full screen first, then
   * (like Left at the left edge) returns the remote to GenX; Menu shows or
   * hides the control bar.
   */
  fun handleKey(code: Int, event: KeyEvent): Boolean {
    page ?: return false
    val arrow = pointer ?: return false
    val down = event.action == KeyEvent.ACTION_DOWN
    if (down && arrow.touchMode) { arrow.touchMode = false; arrow.invalidate() }
    when (code) {
      KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> {
        val now = SystemClock.uptimeMillis()
        if (!down) { released[code] = now; return true }
        if (event.repeatCount > 0) { seen[code] = now; return true } // the glide follows the held key
        // Infrared remotes send press/release pairs every ~100 ms while a
        // button is held; a press soon after a release continues the glide.
        val wasReleased = released.remove(code)
        if (held.containsKey(code) && wasReleased != null && now - wasReleased < RELEASE_GRACE_MS) {
          seen[code] = now
          pulsing.add(code)
          return true
        }
        pulsing.remove(code)
        // A fresh Left press at the left edge returns the remote to GenX (like Back).
        if (code == KeyEvent.KEYCODE_DPAD_LEFT && arrow.px <= 0f && custom == null) {
          held.clear(); leave("edge"); return true
        }
        val (dx, dy) = direction(code)
        // A tap is a small, exact nudge; holding then glides.
        glide(dx * nudge(), dy * nudge())
        held[code] = now
        seen[code] = now
        if (!gliding) { gliding = true; lastFrame = 0L; Choreographer.getInstance().postFrameCallback(frame) }
        return true
      }
      KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
        if (down && event.repeatCount == 0) click(arrow.px, arrow.py)
        return true
      }
      KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> {
        if (down) remote("play")
        return true
      }
      KeyEvent.KEYCODE_BACK -> {
        // Full screen (the site's or GenX's) ends first; the pointer stays on the page.
        if (!down) {
          if (custom != null) exitSiteFullscreen()
          else if (videoOnly) host.toggleFullscreen()
          else leave("Back")
        }
        return true
      }
      KeyEvent.KEYCODE_MENU -> {
        if (down && event.repeatCount == 0) {
          if (arrow.bar) { ui.removeCallbacks(hideBar); arrow.bar = false; arrow.invalidate() } else wakeBar()
        }
        return true
      }
    }
    return false
  }

  /** Asks the site's player to leave its fullscreen; it then hides the view. */
  private fun exitSiteFullscreen() {
    exitingSiteFullscreen = true
    try {
      val exit = customExit
      if (exit != null) exit.onCustomViewHidden() else page?.webChromeClient?.onHideCustomView()
      // Some players never answer; the view must still go.
      if (custom != null) page?.webChromeClient?.onHideCustomView()
    } finally {
      exitingSiteFullscreen = false
    }
  }

  /** A tap at the pointer, delivered to the page (or its fullscreen video). */
  private fun click(x: Float, y: Float) {
    pointer?.buttonAt(x, y)?.let { barAction(it); return }
    val target = custom ?: page ?: return
    val at = SystemClock.uptimeMillis()
    for (action in intArrayOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
      val tap = pointerEvent(action, x, y, at, at + if (action == MotionEvent.ACTION_UP) 60 else 0, MotionEvent.TOOL_TYPE_FINGER)
      target.dispatchTouchEvent(tap)
      tap.recycle()
    }
    log("click ${x.toInt()},${y.toInt()}")
  }

  /**
   * An event exactly at (x, y). Taps carry no touch size, so the browser never
   * moves them to a nearby link ("touch adjustment"); hover is a mouse event,
   * so links and buttons under the pointer highlight as it moves.
   */
  private fun pointerEvent(action: Int, x: Float, y: Float, down: Long, at: Long, tool: Int): MotionEvent {
    val properties = arrayOf(MotionEvent.PointerProperties().apply { id = 0; toolType = tool })
    val coords = arrayOf(MotionEvent.PointerCoords().apply {
      this.x = x; this.y = y
      pressure = if (tool == MotionEvent.TOOL_TYPE_MOUSE) 0f else 1f
      size = 0f; touchMajor = 0f; touchMinor = 0f; toolMajor = 0f; toolMinor = 0f
    })
    val source = if (tool == MotionEvent.TOOL_TYPE_MOUSE) InputDevice.SOURCE_MOUSE else InputDevice.SOURCE_TOUCHSCREEN
    return MotionEvent.obtain(down, at, action, 1, properties, coords, 0, 0, 1f, 1f, 0, 0, source, 0)
  }
  private var lastHover = 0L
  private fun hover() {
    val arrow = pointer ?: return
    val target = custom ?: page ?: return
    val at = SystemClock.uptimeMillis()
    if (at - lastHover < 32) return
    lastHover = at
    val move = pointerEvent(MotionEvent.ACTION_HOVER_MOVE, arrow.px, arrow.py, at, at, MotionEvent.TOOL_TYPE_MOUSE)
    target.dispatchGenericMotionEvent(move)
    move.recycle()
  }

  fun close() {
    ui.removeCallbacks(hideBar)
    ui.removeCallbacks(awakeCheck)
    if (awake) { awake = false; host.keepAwake(false) }
    entered = false
    held.clear()
    pointer?.let { container.removeView(it) }
    pointer = null
    custom?.let { container.removeView(it) }
    custom = null
    page?.let { view ->
      container.removeView(view)
      view.stopLoading()
      forgetSites(view)
      view.destroy()
    }
    page = null
    videoOnly = false
    fullscreenForSite = false
  }
}
