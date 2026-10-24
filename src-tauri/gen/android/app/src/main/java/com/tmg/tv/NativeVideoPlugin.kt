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
class NativeVideoArgs {
  var session: Long = 0
  var url: String = ""
  /** The picture's place in WebView pixels; a width of 0 or less hides it. */
  var left: Int = 0
  var top: Int = 0
  var width: Int = 0
  var height: Int = 0
  var positionMs: Long = 0
  var volume: Double = 1.0
  var track: String = ""
  /** A live channel's HLS playlist through GenX's loopback live relay. */
  var hls: Boolean = false
  /** Replay only: a speed from NativeVideoRules.REPLAY_RATES; 0 leaves it. */
  var rate: Double = 0.0
  /** Replay only: a stream position (see streamOffsetMs); -1 leaves it. */
  var streamMs: Long = -1
  /** Replay only: 1 plays, 0 pauses, -1 leaves it. */
  var playing: Int = -1
}

/** Pure rules, unit-tested without a device (NativeVideoRulesTest). */
object NativeVideoRules {
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
  /** Media3 error groups to GenX's fixed failure codes (no provider text). */
  fun failure(code: Int): String = when (code) {
    in 2000..2999 -> if (code == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS) "missing" else "network"
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

  override fun load(webView: WebView) {
    this.webView = webView
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
    val target = view ?: return
    val web = webView ?: return
    if (args.width <= 0 || args.height <= 0) {
      target.visibility = View.GONE
      return
    }
    // WebView pixels to the container's coordinates (the WebView's offset).
    val container = target.parent as? ViewGroup ?: return
    val webAt = IntArray(2).also { web.getLocationInWindow(it) }
    val boxAt = IntArray(2).also { container.getLocationInWindow(it) }
    target.layoutParams = FrameLayout.LayoutParams(args.width, args.height).apply {
      leftMargin = webAt[0] - boxAt[0] + args.left
      topMargin = webAt[1] - boxAt[1] + args.top
    }
    target.visibility = View.VISIBLE
  }

  @Command
  fun open(invoke: Invoke) {
    val args = invoke.parseArgs(NativeVideoArgs::class.java)
    val admitted = if (args.hls) NativeVideoRules.liveRelay(args.url) else NativeVideoRules.relay(args.url)
    if (!admitted || args.session <= 0) {
      invoke.reject("native-video-source-refused")
      return
    }
    onUi(invoke) {
      stop()
      session = args.session
      failure = null
      // MPEG-2: Android's software decoder first, the TV's own as fallback.
      // The Sansui's Realtek decoder accepts MPEG-2 but never outputs a frame
      // to Media3 (October 19, 2026); MPEG-2 is light enough for any CPU here.
      // GenXRenderersFactory: GenX's own MPEG Layer I/II sound first (TrierMpegRenderer).
      val renderers = GenXRenderersFactory(activity)
        .setEnableDecoderFallback(true)
        .setMediaCodecSelector { mime, secure, tunneling ->
          NativeVideoRules.decoders(mime, args.hls, MediaCodecUtil.getDecoderInfos(mime, secure, tunneling)) { it.softwareOnly }
        }
      val builder = ExoPlayer.Builder(activity, renderers)
      // Live channels keep 30 s already played, from its key frame, so
      // instant replay seeks back without fetching the media again.
      if (args.hls) builder.setLoadControl(
        DefaultLoadControl.Builder().setBackBuffer(NativeVideoRules.REPLAY_BACK_BUFFER_MS, true).build(),
      )
      val engine = builder.build()
      engine.addListener(object : Player.Listener {
        override fun onPlayerError(error: PlaybackException) {
          // A live channel that fell behind its window rejoins the live edge.
          if (args.hls && error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
            engine.setPlaybackSpeed(1f)
            engine.seekToDefaultPosition()
            engine.prepare()
            return
          }
          failure = NativeVideoRules.failure(error.errorCode)
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
    player?.release()
    player = null
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
    result.put("positionMs", engine.currentPosition.coerceAtLeast(0))
    result.put("durationMs", if (engine.duration == C.TIME_UNSET) -1 else engine.duration)
    if (engine.isCurrentMediaItemLive) {
      val offset = streamOffsetMs(engine)
      result.put("streamMs", (engine.currentPosition + offset).coerceAtLeast(0))
      result.put("streamBufferedMs", (engine.bufferedPosition + offset).coerceAtLeast(0))
      result.put("rate", engine.playbackParameters.speed.toDouble())
      result.put("frameMicros", NativeVideoRules.frameMicros(engine.videoFormat?.frameRate ?: -1f))
    }
    failure?.let { result.put("error", it) }
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
