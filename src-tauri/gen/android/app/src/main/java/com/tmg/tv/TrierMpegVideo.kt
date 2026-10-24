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

import android.os.Handler
import android.view.Surface
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.decoder.CryptoConfig
import androidx.media3.decoder.DecoderException
import androidx.media3.decoder.DecoderInputBuffer
import androidx.media3.decoder.SimpleDecoder
import androidx.media3.decoder.VideoDecoderOutputBuffer
import androidx.media3.exoplayer.RendererCapabilities
import androidx.media3.exoplayer.video.DecoderVideoRenderer
import androidx.media3.exoplayer.video.VideoRendererEventListener
import java.nio.ByteBuffer

private const val VIDEO_BUFFERS = 8

/**
 * Trier MPEG Video, GenX's own MPEG-2 video decoder (Rust, src-tauri/src/
 * trier_video; docs/trier-mpeg-video.md), for devices that give apps no
 * MPEG-2 decoder: the Galaxy S25 played MPEG-2 channels as sound over black
 * (owner decision, October 19, 2026). Frames are drawn by the native side
 * straight onto the player's surface.
 */
object TrierMpegVideoNative {
  external fun create(): Long
  external fun destroy(handle: Long)
  /** 0 on success, -1 unsupported stream, -2 bad input. */
  external fun decode(handle: Long, data: ByteBuffer, size: Int, timeUs: Long): Int
  /** The next frame in display order (0 when none); out = [timeUs, width, height]. */
  external fun next(handle: Long, out: LongArray): Long
  external fun release(handle: Long, id: Long)
  external fun flush(handle: Long)
  /** 0 on success. */
  external fun render(handle: Long, id: Long, surface: Surface): Int
  /** out (32) = see trier_video/android.rs: decode counts and tail times, over-budget run, CPU time, clock, frames held, latency, calls per CPU. */
  external fun counters(handle: Long, out: LongArray)
  /** Trier AutoTune (TrierAutoTune.kt): profile directory, OS text, policy. */
  external fun configure(dir: String, os: String, policy: String)
  external fun needsCalibration(): Boolean
  /** Stage A on the three bundled samples within `seconds`; the log lines. */
  external fun calibrate(sd: ByteArray, hd720: ByteArray, hd1080: ByteArray, seconds: Int, conditions: String): String
}

@Suppress("UNCHECKED_CAST")
class TrierMpegVideoDecoder(maxInputSize: Int) :
  SimpleDecoder<DecoderInputBuffer, VideoDecoderOutputBuffer, DecoderException>(
    // SimpleDecoder fills both arrays through createInputBuffer/createOutputBuffer.
    arrayOfNulls<DecoderInputBuffer>(VIDEO_BUFFERS) as Array<DecoderInputBuffer>,
    arrayOfNulls<VideoDecoderOutputBuffer>(VIDEO_BUFFERS) as Array<VideoDecoderOutputBuffer>,
  ) {
  private val handle = TrierMpegVideoNative.create()
  private val info = LongArray(3)
  private val counters = LongArray(36)
  private var decoded = 0L

  init {
    setInitialInputBufferSize(maxInputSize)
  }

  override fun getName() = "genx.trier-mpeg-video"
  override fun createInputBuffer() = DecoderInputBuffer(DecoderInputBuffer.BUFFER_REPLACEMENT_MODE_DIRECT)
  override fun createOutputBuffer() = VideoDecoderOutputBuffer { releaseOutputBuffer(it) }
  override fun createUnexpectedDecodeException(error: Throwable) = DecoderException("trier-mpeg-video-failed", error)

  override fun releaseOutputBuffer(buffer: VideoDecoderOutputBuffer) {
    if (buffer.decoderPrivate != 0L) TrierMpegVideoNative.release(handle, buffer.decoderPrivate)
    buffer.decoderPrivate = 0L
    super.releaseOutputBuffer(buffer)
  }

  override fun decode(
    inputBuffer: DecoderInputBuffer,
    outputBuffer: VideoDecoderOutputBuffer,
    reset: Boolean,
  ): DecoderException? {
    if (reset) TrierMpegVideoNative.flush(handle)
    val data = inputBuffer.data ?: return null
    when (TrierMpegVideoNative.decode(handle, data, data.limit(), inputBuffer.timeUs)) {
      -1 -> return DecoderException("trier-mpeg-video-unsupported")
      else -> {}
    }
    // Pictures arrive in coded order and leave in display order, so a call can
    // have no frame to give yet (the first reference, a first field).
    val id = TrierMpegVideoNative.next(handle, info)
    if (++decoded % 1800 == 0L) {
      TrierMpegVideoNative.counters(handle, counters)
      val calls = counters[0].coerceAtLeast(1)
      android.util.Log.i(
        "TrierMpegVideo",
        "in=${counters[0]} out=${counters[1]} drawn=${counters[2]} lastDraw=${counters[3]} " +
          "meanUs=${counters[4] / calls} p95Us=${counters[5]} p99Us=${counters[6]} maxUs=${counters[7]} " +
          "overRun=${counters[8]} cpuUs=${counters[9] / calls} mhz=${counters[11] / counters[10].coerceAtLeast(1) / 1000} " +
          "held=${counters[12]} heldMax=${counters[13]} latencyUs=${counters[14]} latencyP95Us=${counters[15]} " +
          "latencyMaxUs=${counters[16]} periodUs=${counters[17]} cpus=${counters.copyOfRange(18, 26).joinToString(",")} " +
          "maxPressureUs=${counters[26]} bursts=${counters[27]} recoveryPictures=${counters[28]} " +
          "recoveryUs=${counters[29]} heldMin=${counters[30]} moves=${counters[31]} " +
          "autotune=${counters[32]} workers=${counters[33]} kit=${counters[34]} decodeCpuUs=${counters[35] / calls}",
      )
    }
    outputBuffer.init(if (id == 0L) inputBuffer.timeUs else info[0], C.VIDEO_OUTPUT_MODE_SURFACE_YUV, null)
    if (id == 0L) {
      outputBuffer.shouldBeSkipped = true
      return null
    }
    outputBuffer.decoderPrivate = id
    outputBuffer.width = info[1].toInt()
    outputBuffer.height = info[2].toInt()
    return null
  }

  /**
   * Draws the frame, then gives its buffer back: in surface mode the decoder
   * that draws owns the release (without it every output buffer stayed taken
   * and the picture froze after the first frame).
   */
  fun render(outputBuffer: VideoDecoderOutputBuffer, surface: Surface) {
    val result = TrierMpegVideoNative.render(handle, outputBuffer.decoderPrivate, surface)
    outputBuffer.release()
    if (result != 0) throw DecoderException("trier-mpeg-video-render-$result")
  }

  override fun release() {
    super.release()
    TrierMpegVideoNative.destroy(handle)
  }

}

class TrierMpegVideoRenderer(
  allowedJoiningTimeMs: Long,
  handler: Handler?,
  listener: VideoRendererEventListener?,
) : DecoderVideoRenderer(allowedJoiningTimeMs, handler, listener, MAX_DROPPED_FRAMES_TO_NOTIFY) {
  private var decoder: TrierMpegVideoDecoder? = null

  override fun getName() = "GenXTrierMpegVideoRenderer"

  override fun supportsFormat(format: Format): Int =
    if (format.sampleMimeType == MimeTypes.VIDEO_MPEG2) RendererCapabilities.create(C.FORMAT_HANDLED)
    else RendererCapabilities.create(C.FORMAT_UNSUPPORTED_TYPE)

  override fun createDecoder(format: Format, cryptoConfig: CryptoConfig?) =
    TrierMpegVideoDecoder(if (format.maxInputSize != Format.NO_VALUE) format.maxInputSize else DEFAULT_INPUT_SIZE)
      .also { decoder = it }

  override fun renderOutputBufferToSurface(outputBuffer: VideoDecoderOutputBuffer, surface: Surface) {
    (decoder ?: throw DecoderException("trier-mpeg-video-no-decoder")).render(outputBuffer, surface)
  }

  /** Only surface output: the native side draws each frame. */
  override fun setDecoderOutputMode(outputMode: Int) {}

  companion object {
    private const val MAX_DROPPED_FRAMES_TO_NOTIFY = 50
    /** A 1080i MPEG-2 picture at broadcast rates fits well within this. */
    private const val DEFAULT_INPUT_SIZE = 2 * 1024 * 1024
  }
}
