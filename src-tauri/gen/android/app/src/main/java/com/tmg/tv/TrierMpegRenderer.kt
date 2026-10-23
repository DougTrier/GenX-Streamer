package com.tmg.tv

import android.content.Context
import android.os.Handler
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.Util
import androidx.media3.decoder.CryptoConfig
import androidx.media3.decoder.DecoderException
import androidx.media3.decoder.DecoderInputBuffer
import androidx.media3.decoder.SimpleDecoder
import androidx.media3.decoder.SimpleDecoderOutputBuffer
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.audio.AudioRendererEventListener
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DecoderAudioRenderer
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import androidx.media3.exoplayer.video.VideoRendererEventListener
import java.nio.ByteOrder

private const val BUFFERS = 16

@Suppress("UNCHECKED_CAST")
private inline fun <reified T> emptyBuffers(): Array<T> = arrayOfNulls<T>(BUFFERS) as Array<T>

/**
 * Media3 decoder around Trier MPEG, GenX's own [TrierMpegDecoder] (MPEG audio
 * Layer I and II; docs/trier-mpeg.md).
 * The Android devices here either have no such decoder (Google TV Streamer,
 * Flip 2) or one that never outputs (Sansui's Realtek). Always 16-bit stereo.
 */
class TrierMpegMediaDecoder(private val sampleRate: Int, private val layer: Int, maxInputSize: Int) :
  SimpleDecoder<DecoderInputBuffer, SimpleDecoderOutputBuffer, DecoderException>(
    // SimpleDecoder fills both arrays through createInputBuffer/createOutputBuffer.
    emptyBuffers<DecoderInputBuffer>(),
    emptyBuffers<SimpleDecoderOutputBuffer>(),
  ) {
  private val decoder = TrierMpegDecoder()
  private val pcm = ShortArray(1152 * 2)
  private var frame = ByteArray(0)

  init {
    setInitialInputBufferSize(if (maxInputSize > 0) maxInputSize else MAX_FRAME_BYTES)
  }

  fun outputFormat(): Format = Util.getPcmFormat(C.ENCODING_PCM_16BIT, 2, sampleRate)

  override fun getName() = "genx.trier-mpeg"
  override fun createInputBuffer() = DecoderInputBuffer(DecoderInputBuffer.BUFFER_REPLACEMENT_MODE_DIRECT)
  override fun createOutputBuffer() = SimpleDecoderOutputBuffer(this::releaseOutputBuffer)
  override fun createUnexpectedDecodeException(error: Throwable) = DecoderException("trier-mpeg-decode-failed", error)

  override fun decode(
    input: DecoderInputBuffer,
    output: SimpleDecoderOutputBuffer,
    reset: Boolean,
  ): DecoderException? {
    if (reset) decoder.reset()
    val data = input.data ?: return null
    val length = data.remaining()
    if (frame.size < length) frame = ByteArray(length)
    data.get(frame, 0, length)
    // A damaged frame plays as silence of its own length; the stream goes on (MA03).
    var samples = decoder.decode(frame, 0, length, pcm)
    if (samples == 0) {
      samples = if (layer == 1) 384 else 1152
      pcm.fill(0, 0, samples * 2)
    }
    val bytes = output.init(input.timeUs, samples * 4)
    bytes.order(ByteOrder.nativeOrder()).asShortBuffer().put(pcm, 0, samples * 2)
    bytes.position(0)
    bytes.limit(samples * 4)
    return null
  }

  private companion object {
    const val MAX_FRAME_BYTES = 2881 // largest fixed-rate frame: Layer II, 160 kbit/s at 8 kHz, padded
  }
}

/** Plays MPEG audio Layer I and II through Trier MPEG. */
class TrierMpegRenderer(handler: Handler?, listener: AudioRendererEventListener?, sink: AudioSink) :
  DecoderAudioRenderer<TrierMpegMediaDecoder>(handler, listener, sink) {
  override fun getName() = "GenXTrierMpegRenderer"

  override fun supportsFormatInternal(format: Format): Int {
    layerOf(format) ?: return C.FORMAT_UNSUPPORTED_TYPE
    if (format.sampleRate !in RATES) return C.FORMAT_UNSUPPORTED_SUBTYPE
    return if (sinkSupportsFormat(Util.getPcmFormat(C.ENCODING_PCM_16BIT, 2, format.sampleRate)))
      C.FORMAT_HANDLED
    else C.FORMAT_UNSUPPORTED_SUBTYPE
  }

  override fun createDecoder(format: Format, cryptoConfig: CryptoConfig?) =
    TrierMpegMediaDecoder(format.sampleRate, layerOf(format) ?: 2, format.maxInputSize)

  override fun getOutputFormat(decoder: TrierMpegMediaDecoder): Format = decoder.outputFormat()

  private companion object {
    /** MPEG-1, MPEG-2 and MPEG-2.5 sampling rates (MA06). */
    val RATES = setOf(44100, 48000, 32000, 22050, 24000, 16000, 11025, 12000, 8000)

    fun layerOf(format: Format): Int? = when (format.sampleMimeType) {
      MimeTypes.AUDIO_MPEG_L1 -> 1
      MimeTypes.AUDIO_MPEG_L2 -> 2
      else -> null
    }
  }
}

/** Media3's renderers with Trier MPEG tried before the platform's Layer I/II decoders. */
class GenXRenderersFactory(context: Context) : DefaultRenderersFactory(context) {
  init {
    // Trier AutoTune: the device profile's choices apply to every decoder.
    TrierAutoTune.configure(context)
  }

  /**
   * Trier MPEG Video when this device gives apps no MPEG-2 video decoder
   * (Galaxy S25); devices that have one keep it (TVs, Flip 2).
   */
  override fun buildVideoRenderers(
    context: Context,
    extensionRendererMode: Int,
    mediaCodecSelector: MediaCodecSelector,
    enableDecoderFallback: Boolean,
    eventHandler: Handler,
    eventListener: VideoRendererEventListener,
    allowedVideoJoiningTimeMs: Long,
    out: ArrayList<Renderer>,
  ) {
    super.buildVideoRenderers(
      context, extensionRendererMode, mediaCodecSelector, enableDecoderFallback,
      eventHandler, eventListener, allowedVideoJoiningTimeMs, out,
    )
    if (NativeVideoRules.needsTrierMpegVideo(MediaCodecUtil.getDecoderInfos(MimeTypes.VIDEO_MPEG2, false, false).size)) {
      out.add(TrierMpegVideoRenderer(allowedVideoJoiningTimeMs, eventHandler, eventListener))
    }
  }

  override fun buildAudioRenderers(
    context: Context,
    extensionRendererMode: Int,
    mediaCodecSelector: MediaCodecSelector,
    enableDecoderFallback: Boolean,
    audioSink: AudioSink,
    eventHandler: Handler,
    eventListener: AudioRendererEventListener,
    out: ArrayList<Renderer>,
  ) {
    out.add(TrierMpegRenderer(eventHandler, eventListener, audioSink))
    super.buildAudioRenderers(
      context, extensionRendererMode, mediaCodecSelector, enableDecoderFallback,
      audioSink, eventHandler, eventListener, out,
    )
  }
}
