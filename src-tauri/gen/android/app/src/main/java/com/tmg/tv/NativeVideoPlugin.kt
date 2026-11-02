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
import android.graphics.Color
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class PlaybackReportArgs { var report: String = "" }

@InvokeArg
class NativeVideoArgs {
  var session: Long = 0
  var url: String = ""
  /** CSS pixels with viewport dimensions; legacy view pixels without them. */
  var left: Double = 0.0
  var top: Double = 0.0
  var width: Double = 0.0
  var height: Double = 0.0
  var viewportWidth: Int = 0
  var viewportHeight: Int = 0
  var positionMs: Long = 0
  var volume: Double = 1.0
  var track: String = ""
  /** A live channel's HLS playlist through GenX's loopback live relay. */
  var hls: Boolean = false
  var archive: Boolean = false
  var accountLive: Boolean = false
  var publicLive: Boolean = false
  /** Replay only: a speed from NativeVideoRules.REPLAY_RATES; 0 leaves it. */
  var rate: Double = 0.0
  /** Replay only: a stream position (see streamOffsetMs); -1 leaves it. */
  var streamMs: Long = -1
  /** Replay only: 1 plays, 0 pauses, -1 leaves it. */
  var playing: Int = -1
  /** Runtime forward-buffer policy; empty means the unchanged automatic policy on open. */
  var bufferMode: String = ""
  var bufferTargetSeconds: Int = 0
}

/** Pure rules, unit-tested without a device (NativeVideoRulesTest). */
object NativeVideoRules {
  /** Exact active URL is checked in Rust; this is the decoder's additional shape check. */
  fun archiveRelay(raw: String): Boolean {
    val uri = try { java.net.URI(raw) } catch (_: Exception) { return false }
    val parts = (uri.rawPath ?: "").split('/')
    val file = parts.lastOrNull()?.split('.') ?: return false
    return uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port in 1..65535 &&
      uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
      parts.size == 4 && parts[0].isEmpty() && parts[1] == "archive" && HEX64.matches(parts[2]) &&
      file.size == 2 && HEX64.matches(file[0]) && Regex("^[a-z0-9]{1,12}$").matches(file[1])
  }
  private val HEX64 = Regex("^[0-9a-fA-F]{64}$")
  /** Only the loopback account relay (never a provider address or the sign-in). */
  fun relay(raw: String): Boolean {
    val uri = try { java.net.URI(raw) } catch (_: Exception) { return false }
    val parts = (uri.rawPath ?: "").split('/')
    return uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port in 1..65535 &&
      uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
      parts.size == 5 && parts[0].isEmpty() && parts[1] == "account" &&
      HEX64.matches(parts[2]) && parts[3] == "media" && HEX64.matches(parts[4])
  }
  /** A live channel's loopback relay (http://127.0.0.1:port/media/<64 hex>). */
  fun liveRelay(raw: String): Boolean {
    val uri = try { java.net.URI(raw) } catch (_: Exception) { return false }
    val parts = (uri.rawPath ?: "").split('/')
    return uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port in 1..65535 &&
      uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
      parts.size == 3 && parts[0].isEmpty() && parts[1] == "media" && HEX64.matches(parts[2])
  }
  /** MPEG-2 video tries software decoders first; every other format keeps the device order. */
  fun <T> decoderOrder(mime: String, decoders: List<T>, software: (T) -> Boolean): List<T> =
    if (mime == "video/mpeg2") decoders.sortedBy { if (software(it)) 0 else 1 } else decoders
  /**
   * Decoders for a stream. Live channels skip platform MPEG Layer I/II audio
   * decoders: the Streamer and Flip 2 have none, and the Sansui's Realtek one
   * accepts the sound but never outputs it, which held the whole channel at
   * buffering (October 19, 2026). GenX's own TrierMpegRenderer, tried first,
   * plays that sound instead.
   */
  fun <T> decoders(mime: String, live: Boolean, decoders: List<T>, software: (T) -> Boolean): List<T> =
    if (live && (mime == "audio/mpeg-L1" || mime == "audio/mpeg-L2")) emptyList()
    else decoderOrder(mime, decoders, software)
  /**
   * Whether the stream's picture can be shown: "shown" when a video track has
   * a decoder here, "unsupported" when it has video but none decodes, "none"
   * for sound-only streams, null before tracks are known. The Galaxy S25 has
   * no MPEG-2 video decoder (Android's own is listed only on TVs and refuses
   * creation by name), so MPEG-2 channels played as sound over black
   * (October 19, 2026).
   */
  fun picture(videoGroups: List<List<Boolean>>): String? = when {
    videoGroups.isEmpty() -> null
    videoGroups.any { group -> group.any { it } } -> "shown"
    else -> "unsupported"
  }
  /**
   * Trier MPEG Video is used only where the device lists no MPEG-2 video
   * decoder (Galaxy S25); TVs and the Flip 2 keep their own.
   */
  fun needsTrierMpegVideo(listedMpeg2Decoders: Int): Boolean = listedMpeg2Decoders == 0
  /** Instant replay speeds (docs/instant-replay.md); anything else is refused. */
  val REPLAY_RATES = listOf(0.125, 0.25, 0.5, 1.0)
  fun replayRate(raw: Double): Float? = if (raw in REPLAY_RATES) raw.toFloat() else null
  /** Already-played live media kept for instant replay: 30 s (REPLAY01). */
  const val REPLAY_BACK_BUFFER_MS = 30_000
  /** One picture in microseconds from a frame rate; 0 when unknown. */
  fun frameMicros(frameRate: Float): Long =
    if (frameRate.isFinite() && frameRate in 10f..120f) (1_000_000.0 / frameRate).toLong() else 0
  /** "group:index" from the track list this plugin published. */
  fun track(raw: String): Pair<Int, Int>? {
    val parts = raw.split(':')
    if (parts.size != 2) return null
    val group = parts[0].toIntOrNull() ?: return null
    val index = parts[1].toIntOrNull() ?: return null
    return if (group >= 0 && index >= 0) group to index else null
  }
  /** Bound automatic live-window rejoins to the owning session, including storms. */
  fun canRejoinLiveWindow(live: Boolean, code: Int, recoveries: Int): Boolean =
    live && code == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW && recoveries in 0..1
  /** Media3 error groups to GenX's fixed failure codes (no provider text). */
  fun failure(code: Int, httpStatus: Int? = null): String = when (code) {
    PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW -> "network"
    PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> when(httpStatus) {
      401,403,407 -> "access"
      404,410 -> "missing"
      else -> "network"
    }
    in 2000..2999 -> "network"
    in 3000..3999 -> "unsupported"
    in 4000..4999 -> if (code == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED ||
      code == PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED ||
      code == PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES) "unsupported" else "decode"
    in 5000..5999 -> "decode"
    else -> "unknown"
  }
}

/**
 * Native on-demand player (docs/native-vod-player.md): Paid TV movies and
 * episodes play in Media3 so their embedded audio languages and subtitles can
 * be chosen. The picture sits beneath GenX's WebView, which turns transparent
 * while it plays; GenX's own controls and menus stay above it. One player at a
 * time; every command names its session and older sessions are ignored.
 */
@TauriPlugin
class NativeVideoPlugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null
  private var player: ExoPlayer? = null
  private var view: PlayerView? = null
  private var session = 0L
  private var failure: String? = null
  private var liveWindowRecoveries = 0
  private var lastNativeErrorCode: Int? = null
  private var lastHttpStatus: Int? = null
  private var lastPlacement: NativeVideoArgs? = null
  private var bufferControl: NativeBufferControl? = null
  private var transferMeter: NativeTransferMeter? = null

  override fun load(webView: WebView) {
    this.webView = webView
    webView.addOnLayoutChangeListener { _, l, t, r, b, oldL, oldT, oldR, oldB ->
      if (l != oldL || t != oldT || r != oldR || b != oldB)
        lastPlacement?.let { applyPlacement(it) }
    }
    release = { activity.runOnUiThread { stop() } }
  }

  private fun onUi(invoke: Invoke, block: () -> Unit) = activity.runOnUiThread {
    try { block() } catch (_: Exception) { invoke.reject("native-video-failed") }
  }
  private fun current(invoke: Invoke, args: NativeVideoArgs): ExoPlayer? {
    val active = player
    if (active == null || args.session != session) {
      invoke.reject("native-video-stale")
      return null
    }
    return active
  }

  private fun place(args: NativeVideoArgs) {
    lastPlacement = args
    applyPlacement(args)
  }

  private fun applyPlacement(args: NativeVideoArgs) {
    val target = view ?: return
    val web = webView ?: return
    if (args.width <= 0 || args.height <= 0) {
      target.visibility = View.GONE
      return
    }
    // Window origins share one coordinate space. FrameLayout adds its padding
    // to child margins, so subtract it here rather than applying the inset twice.
    val container = target.parent as? ViewGroup ?: return
    val webAt = IntArray(2).also { web.getLocationInWindow(it) }
    val boxAt = IntArray(2).also { container.getLocationInWindow(it) }
    val bounds = NativeVideoGeometry.bounds(
      args.left, args.top, args.width, args.height,
      args.viewportWidth, args.viewportHeight, web.width, web.height,
      NativeVideoGeometry.parentOffset(webAt[0], boxAt[0], container.paddingLeft),
      NativeVideoGeometry.parentOffset(webAt[1], boxAt[1], container.paddingTop),
    ) ?: run { target.visibility = View.GONE; return }
    target.layoutParams = FrameLayout.LayoutParams(bounds.width, bounds.height).apply {
      leftMargin = bounds.left
      topMargin = bounds.top
    }
    target.visibility = View.VISIBLE
  }

  @Command
  fun open(invoke: Invoke) {
    val args = invoke.parseArgs(NativeVideoArgs::class.java)
    val admitted = if ((args.archive && (args.hls || args.accountLive || args.publicLive)) || (args.publicLive && args.accountLive)) false
      else if (args.publicLive) NativeVideoRules.liveRelay(args.url) || NativeVideoRules.relay(args.url)
      else if (args.accountLive) NativeVideoRules.relay(args.url)
      else if (args.archive) NativeVideoRules.archiveRelay(args.url)
      else if (args.hls) NativeVideoRules.liveRelay(args.url) else NativeVideoRules.relay(args.url)
    if (!admitted || args.session <= 0) {
      invoke.reject("native-video-source-refused")
      return
    }
    if (!NativeBufferControl.validPreference(args.bufferMode.ifEmpty { "auto" }, args.bufferTargetSeconds)) {
      invoke.reject("native-video-invalid")
      return
    }
    onUi(invoke) {
      stop()
      val liveContent = args.hls || args.accountLive || args.publicLive
      session = args.session
      failure = null
      liveWindowRecoveries = 0
      lastNativeErrorCode = null
      lastHttpStatus = null
      // MPEG-2: Android's software decoder first, the TV's own as fallback.
      // The Sansui's Realtek decoder accepts MPEG-2 but never outputs a frame
      // to Media3 (October 19, 2026); MPEG-2 is light enough for any CPU here.
      // GenXRenderersFactory: GenX's own MPEG Layer I/II sound first (TrierMpegRenderer).
      val renderers = GenXRenderersFactory(activity)
        .setEnableDecoderFallback(true)
        .setMediaCodecSelector { mime, secure, tunneling ->
          NativeVideoRules.decoders(mime, liveContent, MediaCodecUtil.getDecoderInfos(mime, secure, tunneling)) { it.softwareOnly }
        }
      val builder = ExoPlayer.Builder(activity, renderers)
      val meter = NativeTransferMeter()
      val http = DefaultHttpDataSource.Factory()
      if (liveContent) http.setConnectTimeoutMs(5000).setReadTimeoutMs(20_000)
      builder.setMediaSourceFactory(DefaultMediaSourceFactory(activity).setDataSourceFactory(
        DefaultDataSource.Factory(activity, http).setTransferListener(meter),
      ))
      // Live channels keep 30 s already played, from its key frame, so
      // instant replay seeks back without fetching the media again.
      val loadDefaults = DefaultLoadControl.Builder()
      if (liveContent) loadDefaults.setBackBuffer(NativeVideoRules.REPLAY_BACK_BUFFER_MS, true)
      val buffering = NativeBufferControl(loadDefaults.build())
      if (!buffering.setPreference(args.bufferMode.ifEmpty { "auto" }, args.bufferTargetSeconds)) {
        invoke.reject("native-video-invalid")
        return@onUi
      }
      builder.setLoadControl(buffering)
      val engine = builder.build()
      val ownedSession = args.session
      engine.addListener(object : Player.Listener {
        override fun onPlayerError(error: PlaybackException) {
          if (player !== engine || session != ownedSession) return
          lastNativeErrorCode = error.errorCode
          lastHttpStatus = generateSequence<Throwable>(error) { it.cause }.take(8)
            .filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()?.responseCode
            ?.takeIf { it in 100..599 }
          // Fixed facts only: never log the throwable, source URL or provider text.
          Log.w("GenXPlayback", "native-error code=${error.errorCode} http=${lastHttpStatus?:0} recoveries=$liveWindowRecoveries")
          if (NativeVideoRules.canRejoinLiveWindow(liveContent, error.errorCode, liveWindowRecoveries)) {
            liveWindowRecoveries++
            engine.setPlaybackSpeed(1f)
            engine.seekToDefaultPosition()
            engine.prepare()
            return
          }
          failure = NativeVideoRules.failure(error.errorCode,lastHttpStatus)
        }
      })
      val picture = PlayerView(activity).apply {
        useController = false
        isFocusable = false
        isFocusableInTouchMode = false
        descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
        resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
        setShutterBackgroundColor(Color.BLACK)
        setBackgroundColor(Color.BLACK)
        player = engine
      }
      // Beneath the WebView: GenX's dock, menus and overlays stay on top.
      val content = activity.findViewById<ViewGroup>(android.R.id.content)
      content.addView(picture, 0, FrameLayout.LayoutParams(0, 0))
      player = engine
      bufferControl = buffering
      transferMeter = meter
      view = picture
      place(args)
      webView?.setBackgroundColor(Color.TRANSPARENT)
      engine.setMediaItem(
        if (args.hls) MediaItem.Builder().setUri(args.url).setMimeType(MimeTypes.APPLICATION_M3U8).build()
        else MediaItem.fromUri(args.url)
      )
      engine.prepare()
      if (args.positionMs > 0) engine.seekTo(args.positionMs)
      engine.playWhenReady = true
      invoke.resolve(status())
    }
  }

  @Command
  fun place(invoke: Invoke) {
    val args = invoke.parseArgs(NativeVideoArgs::class.java)
    onUi(invoke) { current(invoke, args) ?: return@onUi; place(args); invoke.resolve(status()) }
  }
  @Command
  fun play(invoke: Invoke) {
    val args = invoke.parseArgs(NativeVideoArgs::class.java)
    onUi(invoke) {
      val engine = current(invoke, args) ?: return@onUi
      // A live channel resumes at the live edge: after a minute or more paused
      // its old position has left the stream's window, and resuming there
      // stalled until "Unable to play" (Retroid Flip 2, October 19, 2026).
      // Play also ends an instant replay: normal speed at the live edge.
      if (engine.isCurrentMediaItemLive) {
        engine.setPlaybackSpeed(1f)
        engine.seekToDefaultPosition()
      }
      if (engine.playbackState == Player.STATE_IDLE) engine.prepare()
      engine.play()
      invoke.resolve(status())
    }
  }
  @Command
  fun pause(invoke: Invoke) {
    val args = invoke.parseArgs(NativeVideoArgs::class.java)
    onUi(invoke) { (current(invoke, args) ?: return@onUi).pause(); invoke.resolve(status()) }
  }
  /** Applies to the exact existing decoder session; no restart, seek, pause or prepare. */
  @Command
  fun buffer(invoke: Invoke) {
    val args = invoke.parseArgs(NativeVideoArgs::class.java)
    onUi(invoke) {
      current(invoke, args) ?: return@onUi
      if (bufferControl?.setPreference(args.bufferMode, args.bufferTargetSeconds) != true) {
        invoke.reject("native-video-invalid")
        return@onUi
      }
      invoke.resolve(status())
    }
  }
  @Command
  fun seek(invoke: Invoke) {
    val args = invoke.parseArgs(NativeVideoArgs::class.java)
    onUi(invoke) { (current(invoke, args) ?: return@onUi).seekTo(args.positionMs); invoke.resolve(status()) }
  }
  /**
   * Instant replay on a live channel (docs/instant-replay.md): a speed, a
   * stream position and play/pause, each optional. Positions are stream
   * positions, which stay put while the live window slides; they become
   * window positions here, at the moment of the seek.
   */
  @Command
  fun replay(invoke: Invoke) {
    val args = invoke.parseArgs(NativeVideoArgs::class.java)
    onUi(invoke) {
      val engine = current(invoke, args) ?: return@onUi
      val rate = if (args.rate == 0.0) null else NativeVideoRules.replayRate(args.rate)
      if (!engine.isCurrentMediaItemLive || (args.rate != 0.0 && rate == null)) {
        invoke.reject("native-video-invalid")
        return@onUi
      }
      rate?.let { engine.setPlaybackSpeed(it) }
      if (args.streamMs >= 0) engine.seekTo((args.streamMs - streamOffsetMs(engine)).coerceAtLeast(0))
      when (args.playing) {
        1 -> engine.play()
        0 -> engine.pause()
      }
      invoke.resolve(status())
    }
  }
  /** Where the current window starts in its period: stream = window + this. */
  private fun streamOffsetMs(engine: ExoPlayer): Long {
    val timeline = engine.currentTimeline
    if (timeline.isEmpty) return 0
    return timeline.getWindow(engine.currentMediaItemIndex, Timeline.Window()).positionInFirstPeriodMs
  }
  @Command
  fun volume(invoke: Invoke) {
    val args = invoke.parseArgs(NativeVideoArgs::class.java)
    onUi(invoke) {
      (current(invoke, args) ?: return@onUi).volume = args.volume.toFloat().coerceIn(0f, 1f)
      invoke.resolve(status())
    }
  }
  /** Choose an audio track ("group:index" from status). */
  @Command
  fun audio(invoke: Invoke) {
    val args = invoke.parseArgs(NativeVideoArgs::class.java)
    onUi(invoke) {
      val engine = current(invoke, args) ?: return@onUi
      if (!choose(engine, C.TRACK_TYPE_AUDIO, args.track)) {
        invoke.reject("native-video-track-unknown")
        return@onUi
      }
      invoke.resolve(status())
    }
  }
  /** Choose a subtitle track, or "" for none. */
  @Command
  fun text(invoke: Invoke) {
    val args = invoke.parseArgs(NativeVideoArgs::class.java)
    onUi(invoke) {
      val engine = current(invoke, args) ?: return@onUi
      if (args.track.isEmpty()) {
        engine.trackSelectionParameters = engine.trackSelectionParameters.buildUpon()
          .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
      } else if (!choose(engine, C.TRACK_TYPE_TEXT, args.track)) {
        invoke.reject("native-video-track-unknown")
        return@onUi
      }
      invoke.resolve(status())
    }
  }
  private fun choose(engine: ExoPlayer, type: Int, id: String): Boolean {
    val (groupIndex, trackIndex) = NativeVideoRules.track(id) ?: return false
    val group = engine.currentTracks.groups.getOrNull(groupIndex) ?: return false
    if (group.type != type || trackIndex >= group.length || !group.isTrackSupported(trackIndex)) return false
    engine.trackSelectionParameters = engine.trackSelectionParameters.buildUpon()
      .setTrackTypeDisabled(type, false)
      .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, trackIndex))
      .build()
    return true
  }

  @Command fun exportDiagnostics(invoke: Invoke) = onUi(invoke) {
    val text=invoke.parseArgs(PlaybackReportArgs::class.java).report
    if (text.toByteArray(Charsets.UTF_8).size > 1024*1024) {invoke.reject("playback-trace-size");return@onUi}
    val directory=activity.getExternalFilesDir(null) ?: run {invoke.reject("playback-trace-storage");return@onUi}
    val destination=java.io.File(directory,"GenX-playback-diagnostics-${System.currentTimeMillis()}.json")
    val temporary=java.io.File(directory,destination.name+".tmp")
    temporary.writeText(text,Charsets.UTF_8)
    if (!temporary.renameTo(destination)) {temporary.delete();invoke.reject("playback-trace-write");return@onUi}
    invoke.resolve(JSObject().put("path",destination.absolutePath))
  }

  /** Read-only diagnostic capture; all rectangles use absolute screen pixels. */
  @Command
  fun diagnostics(invoke: Invoke) = onUi(invoke) {
    fun box(target: View): JSArray {
      val at=IntArray(2).also { target.getLocationOnScreen(it) }
      val result=JSArray(); result.put(at[0]); result.put(at[1]); result.put(target.width); result.put(target.height); return result
    }
    val metrics=activity.resources.displayMetrics
    val result=JSObject().put("sdk", android.os.Build.VERSION.SDK_INT)
      .put("density", metrics.density.toDouble()).put("displaySize", JSArray().put(metrics.widthPixels).put(metrics.heightPixels))
      .put("native", player != null).put("engine", if (player != null) "media3" else "webview")
    webView?.let { result.put("webViewNative",box(it)).put("webViewScale",it.scale.toDouble()) }
    val target=view
    if (target != null) {
      result.put("playerNative",box(target)).put("visible",target.isShown).put("layoutPending",target.isLayoutRequested)
      target.videoSurfaceView?.let { surface ->
        result.put("surfaceNative",box(surface))
        player?.let { engine ->
          val at=IntArray(2).also {target.getLocationOnScreen(it)}
          val expected=NativeVideoGeometry.fitted(NativePictureBounds(at[0],at[1],target.width,target.height),engine.videoSize.width,engine.videoSize.height,engine.videoSize.pixelWidthHeightRatio)
          if(expected!=null) {
            val where=IntArray(2).also {surface.getLocationOnScreen(it)}
            val measured=NativePictureBounds(where[0],where[1],surface.width,surface.height)
            val delta=NativeVideoGeometry.delta(expected,measured)
            result.put("expectedSurfaceNative",JSArray().put(expected.left).put(expected.top).put(expected.width).put(expected.height))
              .put("surfaceDeltaNative",JSArray().put(delta[0]).put(delta[1]).put(delta[2]).put(delta[3]))
              .put("surfaceAligned",NativeVideoGeometry.aligned(expected,measured))
          }
        }
        val a=IntArray(2).also {target.getLocationOnScreen(it)}
        val b=IntArray(2).also {surface.getLocationOnScreen(it)}
        result.put("surfaceContained",b[0]>=a[0]-2 && b[1]>=a[1]-2 && b[0]+surface.width<=a[0]+target.width+2 && b[1]+surface.height<=a[1]+target.height+2)
      }
      val args=lastPlacement
      val web=webView
      if (args != null && web != null) {
        val at=IntArray(2).also {web.getLocationOnScreen(it)}
        val desired=NativeVideoGeometry.bounds(args.left,args.top,args.width,args.height,args.viewportWidth,args.viewportHeight,web.width,web.height,at[0],at[1])
        if (desired != null) {
          val actual=IntArray(2).also {target.getLocationOnScreen(it)}
          val delta=intArrayOf(actual[0]-desired.left,actual[1]-desired.top,target.width-desired.width,target.height-desired.height)
          result.put("expectedPlayerNative",JSArray().put(desired.left).put(desired.top).put(desired.width).put(desired.height))
            .put("deltaNative",JSArray().put(delta[0]).put(delta[1]).put(delta[2]).put(delta[3]))
            .put("aligned",delta.all {kotlin.math.abs(it)<=2})
        }
      }
    }
    player?.let { engine ->
      result.put("nativeSession",session).put("liveWindowRecoveries",liveWindowRecoveries)
      if (!engine.currentTimeline.isEmpty) {
        val window=engine.currentTimeline.getWindow(engine.currentMediaItemIndex,Timeline.Window())
        fun measured(key:String,value:Long){if(value!=C.TIME_UNSET && value in 0..9_007_199_254_740_991L)result.put(key,value)}
        measured("windowDurationMs",window.durationMs)
        measured("windowDefaultPositionMs",window.defaultPositionMs)
        measured("windowStartMs",window.windowStartTimeMs)
        measured("targetLiveOffsetMs",window.liveConfiguration?.targetOffsetMs?:C.TIME_UNSET)
        measured("liveOffsetMs",engine.currentLiveOffset)
        val offset=streamOffsetMs(engine)
        result.put("streamMs",(engine.currentPosition+offset).coerceAtLeast(0))
          .put("streamBufferedMs",(engine.bufferedPosition+offset).coerceAtLeast(0))
      }
      lastNativeErrorCode?.let { result.put("nativeErrorCode",it) }
      lastHttpStatus?.let { result.put("httpStatus",it) }
      result.put("videoWidth",engine.videoSize.width).put("videoHeight",engine.videoSize.height)
        .put("positionMs",engine.currentPosition.coerceAtLeast(0))
        .put("bufferedAheadMs",(engine.bufferedPosition-engine.currentPosition).coerceAtLeast(0))
        .put("playing",engine.isPlaying)
      bufferControl?.let { control ->
        val target = control.targetSeconds()
        result.put("incomingMediaBitsPerSecond",transferMeter?.incomingBitsPerSecond(engine.isLoading && engine.playWhenReady) ?: org.json.JSONObject.NULL)
          .put("bufferTargetSeconds",target ?: org.json.JSONObject.NULL)
          .put("manualBuffer",target != null)
      }
      engine.videoDecoderCounters?.let { counters ->
        counters.ensureUpdated()
        result.put("renderedFrames",counters.renderedOutputBufferCount).put("droppedFrames",counters.droppedBufferCount)
      }
    }
    // View/surface alignment is measured. Content pixels still need visual verification.
    result.put("pixelPositionVerified",false)
    invoke.resolve(result)
  }

  @Command
  fun status(invoke: Invoke) {
    val args = invoke.parseArgs(NativeVideoArgs::class.java)
    onUi(invoke) { current(invoke, args) ?: return@onUi; invoke.resolve(status()) }
  }
  @Command
  fun close(invoke: Invoke) {
    val args = invoke.parseArgs(NativeVideoArgs::class.java)
    onUi(invoke) {
      // An older session's close never stops a newer title.
      if (args.session == session) stop()
      invoke.resolve(JSObject().put("closed", true))
    }
  }

  private fun stop() {
    lastPlacement = null
    val old = player
    player = null // Invalidate listener ownership before release invokes callbacks.
    bufferControl = null
    transferMeter = null
    old?.release()
    view?.let { (it.parent as? ViewGroup)?.removeView(it) }
    view = null
    webView?.setBackgroundColor(Color.parseColor("#080F24"))
  }

  private fun status(): JSObject {
    val engine = player
    val result = JSObject().put("session", session)
    if (engine == null) return result.put("state", "closed")
    val state = when {
      failure != null -> "error"
      engine.playbackState == Player.STATE_BUFFERING -> "buffering"
      engine.playbackState == Player.STATE_READY -> "ready"
      engine.playbackState == Player.STATE_ENDED -> "ended"
      else -> "idle"
    }
    result.put("state", state)
    result.put("playing", engine.isPlaying)
    result.put("videoWidth", engine.videoSize.width).put("videoHeight", engine.videoSize.height)
      .put("liveWindowRecoveries", liveWindowRecoveries)
    engine.videoDecoderCounters?.let { counters ->
      counters.ensureUpdated()
      result.put("renderedFrames", counters.renderedOutputBufferCount.coerceAtLeast(0))
    }
    engine.audioDecoderCounters?.let { counters ->
      counters.ensureUpdated()
      result.put("audioRenderedFrames", counters.renderedOutputBufferCount.coerceAtLeast(0))
    }
    result.put("positionMs", engine.currentPosition.coerceAtLeast(0))
    result.put("durationMs", if (engine.duration == C.TIME_UNSET) -1 else engine.duration)
    bufferControl?.let { control ->
      val target = control.targetSeconds()
      val incoming = transferMeter?.incomingBitsPerSecond(engine.isLoading && engine.playWhenReady)
      val telemetry = JSObject().put("mode", if (target == null) "auto" else "manual")
        .put("capability", "controlled")
        .put("incomingBitsPerSecond", incoming ?: org.json.JSONObject.NULL)
        .put("bufferedSeconds", (engine.bufferedPosition - engine.currentPosition).coerceAtLeast(0) / 1000.0)
        .put("targetSeconds", target ?: org.json.JSONObject.NULL)
      result.put("liveBuffer", telemetry)
    }
    if (engine.isCurrentMediaItemLive) {
      val offset = streamOffsetMs(engine)
      result.put("streamMs", (engine.currentPosition + offset).coerceAtLeast(0))
      result.put("streamBufferedMs", (engine.bufferedPosition + offset).coerceAtLeast(0))
      result.put("rate", engine.playbackParameters.speed.toDouble())
      result.put("frameMicros", NativeVideoRules.frameMicros(engine.videoFormat?.frameRate ?: -1f))
    }
    failure?.let { result.put("error", it) }
    lastHttpStatus?.let { result.put("httpStatus",it) }
    NativeVideoRules.picture(
      engine.currentTracks.groups.filter { it.type == C.TRACK_TYPE_VIDEO }
        .map { group -> (0 until group.length).map { group.isTrackSupported(it) } },
    )?.let { result.put("picture", it) }
    val audio = JSArray()
    val text = JSArray()
    val textOff = engine.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)
    engine.currentTracks.groups.forEachIndexed { groupIndex, group ->
      if (group.type != C.TRACK_TYPE_AUDIO && group.type != C.TRACK_TYPE_TEXT) return@forEachIndexed
      for (i in 0 until group.length) {
        val format = group.getTrackFormat(i)
        val track = JSObject()
          .put("id", "$groupIndex:$i")
          .put("label", format.label ?: "")
          .put("language", format.language ?: "")
          .put("selected", group.isTrackSelected(i) && !(group.type == C.TRACK_TYPE_TEXT && textOff))
          .put("supported", group.isTrackSupported(i))
        if (group.type == C.TRACK_TYPE_AUDIO) {
          track.put("channels", if (format.channelCount == androidx.media3.common.Format.NO_VALUE) 0 else format.channelCount)
          audio.put(track)
        } else text.put(track)
      }
    }
    result.put("audio", audio)
    result.put("text", text)
    return result
  }

  companion object {
    /** Released with the activity (MainActivity.onDestroy). */
    var release: (() -> Unit)? = null
  }
}
