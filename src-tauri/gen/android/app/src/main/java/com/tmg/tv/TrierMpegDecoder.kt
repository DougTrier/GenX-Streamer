package com.tmg.tv

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * Trier MPEG (docs/trier-mpeg.md): GenX's own MPEG audio Layer I and Layer
 * II decoder, written from ISO/IEC
 * 11172-3 (MPEG-1) and the lower-sampling-frequency extension of ISO/IEC
 * 13818-3 (MPEG-2, and the common MPEG-2.5 rates). Live channels such as
 * ACC Network send Layer II sound that the Android devices here cannot
 * decode (docs/native-vod-player.md); its invariants are listed in
 * docs/trier-mpeg.md (MA01–MA14).
 *
 * Pure Kotlin with no Android types, so it is tested on the JVM. One call
 * decodes one whole frame (header included) into interleaved stereo 16-bit
 * samples; mono fills both channels, and so does the first program of a
 * dual-channel stream. A frame that cannot be decoded leaves
 * silence of its own length, so the timeline never breaks (MA03).
 */
class TrierMpegDecoder {
  /** What a frame header says. [frameBytes] is 0 for a free-format frame. */
  class Header(
    val version: Int,
    val layer: Int,
    val sampleRate: Int,
    val channels: Int,
    val samplesPerFrame: Int,
    val frameBytes: Int,
    internal val bitrateKbps: Int,
    internal val mode: Int,
    internal val modeExtension: Int,
    internal val padding: Int,
    internal val crc: Boolean,
  )

  // Subband samples of the current block: [channel][subband], and the
  // synthesis filter history: 16 blocks of 64 values per channel (MA09).
  private val subband = Array(2) { FloatArray(32) }
  private val history = Array(2) { FloatArray(1024) }
  private val historyStart = IntArray(2)

  // Per-frame side information.
  private val allocation = Array(2) { IntArray(32) }
  private val scale = Array(2) { Array(32) { FloatArray(3) } }
  private val values = Array(2) { Array(32) { FloatArray(3) } }
  private val raw = FloatArray(3)

  /** Forget the filter history (a seek or a discontinuity). */
  fun reset() {
    for (ch in 0..1) {
      history[ch].fill(0f)
      historyStart[ch] = 0
    }
  }

  /**
   * Decodes the frame at [offset] into [out] (stereo pairs) and returns its
   * samples per channel. Returns 0, leaving [out] untouched, when there is
   * no MPEG Layer I/II header; a frame with a header but damaged contents
   * comes out as silence of its own length.
   */
  fun decode(frame: ByteArray, offset: Int, length: Int, out: ShortArray): Int {
    val header = header(frame, offset, length) ?: return 0
    val samples = header.samplesPerFrame
    require(out.size >= samples * 2) { "output too small" }
    val size = if (header.frameBytes > 0) header.frameBytes else length
    val kbps = if (header.bitrateKbps > 0) header.bitrateKbps else freeFormatKbps(header, size)
    if (size > length || kbps <= 0) return silence(out, samples)
    val bits = BitReader(frame, offset, offset + size)
    bits.skip(32 + if (header.crc) 16 else 0)
    val decoded = when (header.layer) {
      1 -> layerOne(bits, header, out)
      else -> layerTwo(bits, header, kbps, out)
    }
    return if (decoded && !bits.overrun) samples else silence(out, samples)
  }

  private fun silence(out: ShortArray, samples: Int): Int {
    out.fill(0, 0, samples * 2)
    return samples
  }

  // --- Layer I (ISO/IEC 11172-3, 2.4.1.5 and 2.4.3.2) ---------------------

  private fun layerOne(bits: BitReader, h: Header, out: ShortArray): Boolean {
    val channels = h.channels
    val bound = bound(h, 32)
    for (sb in 0 until 32) {
      for (ch in 0 until channels) {
        if (sb >= bound && ch == 1) {
          allocation[1][sb] = allocation[0][sb]
          continue
        }
        val code = bits.read(4)
        if (code == 15) return false // forbidden (MA11)
        allocation[ch][sb] = code
      }
    }
    for (sb in 0 until 32) {
      for (ch in 0 until channels) {
        if (allocation[ch][sb] != 0) scale[ch][sb][0] = scaleFactor(bits.read(6))
      }
    }
    var at = 0
    for (block in 0 until 12) {
      for (sb in 0 until 32) {
        val shared = sb >= bound
        for (ch in 0 until channels) {
          val nb = allocation[ch][sb]
          if (nb == 0) {
            subband[ch][sb] = 0f
            continue
          }
          if (shared && ch == 1) continue
          val levels = (1 shl (nb + 1)) - 1
          val code = bits.read(nb + 1)
          if (code == levels) return false // all ones is not a valid sample (MA10)
          val raw = dequantize(code, levels)
          subband[ch][sb] = raw * scale[ch][sb][0]
          // Intensity stereo: one sample, each channel's own scale factor.
          if (shared && channels == 2) subband[1][sb] = raw * scale[1][sb][0]
        }
      }
      if (channels == 1 || h.mode == DUAL) subband[0].copyInto(subband[1])
      synthesize(out, at)
      at += 32
    }
    return true
  }

  // --- Layer II (ISO/IEC 11172-3, 2.4.1.6 and 2.4.3.3; 13818-3) ----------

  private fun layerTwo(bits: BitReader, h: Header, kbps: Int, out: ShortArray): Boolean {
    val table = allocationTable(h, kbps)
    val sblimit = table.limit
    val channels = h.channels
    val bound = bound(h, sblimit)
    for (sb in 0 until sblimit) {
      val width = table.width(sb)
      for (ch in 0 until channels) {
        if (sb >= bound && ch == 1) {
          allocation[1][sb] = allocation[0][sb]
          continue
        }
        allocation[ch][sb] = table.levels(sb, bits.read(width))
      }
    }
    val selection = Array(2) { IntArray(32) }
    for (sb in 0 until sblimit) {
      for (ch in 0 until channels) {
        if (allocation[ch][sb] != 0) selection[ch][sb] = bits.read(2)
      }
    }
    for (sb in 0 until sblimit) {
      for (ch in 0 until channels) {
        if (allocation[ch][sb] == 0) continue
        val s = scale[ch][sb]
        when (selection[ch][sb]) {
          0 -> {
            s[0] = scaleFactor(bits.read(6))
            s[1] = scaleFactor(bits.read(6))
            s[2] = scaleFactor(bits.read(6))
          }
          1 -> {
            s[0] = scaleFactor(bits.read(6))
            s[1] = s[0]
            s[2] = scaleFactor(bits.read(6))
          }
          2 -> {
            s[0] = scaleFactor(bits.read(6))
            s[1] = s[0]
            s[2] = s[0]
          }
          else -> {
            s[0] = scaleFactor(bits.read(6))
            s[1] = scaleFactor(bits.read(6))
            s[2] = s[1]
          }
        }
      }
    }
    var at = 0
    for (granule in 0 until 12) {
      val part = granule / 4
      for (sb in 0 until sblimit) {
        for (ch in 0 until channels) {
          val levels = allocation[ch][sb]
          val v = values[ch][sb]
          if (levels == 0) {
            v[0] = 0f
            v[1] = 0f
            v[2] = 0f
            continue
          }
          if (sb >= bound && ch == 1) continue // filled with channel 0's shared triple
          if (!readTriple(bits, levels, raw)) return false
          for (k in 0..2) v[k] = raw[k] * scale[ch][sb][part]
          if (sb >= bound && channels == 2) {
            // Intensity stereo: one triple, each channel's own scale factor.
            for (k in 0..2) values[1][sb][k] = raw[k] * scale[1][sb][part]
          }
        }
      }
      for (k in 0..2) {
        for (ch in 0 until 2) {
          val source = if (channels == 1 || h.mode == DUAL) 0 else ch
          for (sb in 0 until 32) subband[ch][sb] = if (sb < sblimit) values[source][sb][k] else 0f
        }
        synthesize(out, at)
        at += 32
      }
    }
    return true
  }

  /** Three consecutive samples of one subband, grouped or not; false if invalid. */
  private fun readTriple(bits: BitReader, levels: Int, v: FloatArray): Boolean {
    val grouped = levels == 3 || levels == 5 || levels == 9
    if (grouped) {
      var code = bits.read(GROUPED_BITS.getValue(levels))
      if (code >= levels * levels * levels) return false // MA10
      for (k in 0..2) {
        v[k] = dequantize(code % levels, levels)
        code /= levels
      }
    } else {
      val nb = 32 - Integer.numberOfLeadingZeros(levels) // levels = 2^nb - 1
      for (k in 0..2) {
        val code = bits.read(nb)
        if (code == levels) return false // MA10
        v[k] = dequantize(code, levels)
      }
    }
    return true
  }

  // --- Synthesis subband filter (11172-3, Figure 3-A.2) -------------------

  /** One block: 32 subband samples per channel to 32 output samples each, from [at]. */
  private fun synthesize(out: ShortArray, at: Int) {
    for (ch in 0 until 2) {
      val v = history[ch]
      val start = (historyStart[ch] - 64) and 1023
      historyStart[ch] = start
      val s = subband[ch]
      for (i in 0 until 64) {
        var sum = 0f
        val row = i * 32
        for (k in 0 until 32) sum += MATRIX[row + k] * s[k]
        v[(start + i) and 1023] = sum
      }
      for (j in 0 until 32) {
        var sum = 0f
        for (i in 0 until 8) {
          // U[64i + j] = V[128i + j], U[64i + 32 + j] = V[128i + 96 + j]
          sum += v[(start + 128 * i + j) and 1023] * WINDOW[64 * i + j]
          sum += v[(start + 128 * i + 96 + j) and 1023] * WINDOW[64 * i + 32 + j]
        }
        out[((at + j) shl 1) + ch] = toPcm(sum)
      }
    }
  }

  companion object {
    /** Header fields by index (version 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5). */
    private val RATES = mapOf(
      3 to intArrayOf(44100, 48000, 32000),
      2 to intArrayOf(22050, 24000, 16000),
      0 to intArrayOf(11025, 12000, 8000),
    )
    private val MPEG1_LAYER1 = intArrayOf(0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448)
    private val MPEG1_LAYER2 = intArrayOf(0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384)
    private val LSF_LAYER1 = intArrayOf(0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256)
    private val LSF_LAYER2 = intArrayOf(0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)
    private const val JOINT_STEREO = 1
    /** Two separate programs (often two languages): the first plays on both speakers, as TVs and Windows do. */
    private const val DUAL = 2
    private const val MONO = 3
    private val GROUPED_BITS = mapOf(3 to 5, 5 to 7, 9 to 10)

    /** Reads a Layer I/II header (MA02), or null. Layer III is Android's own. */
    fun header(frame: ByteArray, offset: Int, length: Int): Header? {
      if (offset < 0 || length < 4 || offset > frame.size - 4) return null
      val b1 = frame[offset + 1].toInt() and 0xff
      val b2 = frame[offset + 2].toInt() and 0xff
      val b3 = frame[offset + 3].toInt() and 0xff
      if (frame[offset].toInt() and 0xff != 0xff || b1 and 0xe0 != 0xe0) return null
      val version = (b1 shr 3) and 3
      val layerBits = (b1 shr 1) and 3
      if (version == 1 || layerBits == 0 || layerBits == 1) return null
      val layer = 4 - layerBits
      val crc = b1 and 1 == 0
      val bitrateIndex = b2 shr 4
      val rateIndex = (b2 shr 2) and 3
      if (bitrateIndex == 15 || rateIndex == 3) return null
      val padding = (b2 shr 1) and 1
      val mode = b3 shr 6
      val rate = RATES.getValue(version)[rateIndex]
      val table = when {
        version == 3 && layer == 1 -> MPEG1_LAYER1
        version == 3 -> MPEG1_LAYER2
        layer == 1 -> LSF_LAYER1
        else -> LSF_LAYER2
      }
      val kbps = table[bitrateIndex]
      val bytes = when {
        kbps == 0 -> 0 // free format: the container's frame length decides (MA05)
        layer == 1 -> (12 * kbps * 1000 / rate + padding) * 4
        else -> 144 * kbps * 1000 / rate + padding
      }
      return Header(
        version, layer, rate, if (mode == MONO) 1 else 2, if (layer == 1) 384 else 1152,
        bytes, kbps, mode, (b3 shr 4) and 3, padding, crc,
      )
    }

    /** A free-format frame's bitrate, from the length its container gave it. */
    private fun freeFormatKbps(h: Header, size: Int): Int =
      if (h.layer == 1) (size / 4 - h.padding) * h.sampleRate / 12 / 1000
      else (size - h.padding) * h.sampleRate / 144 / 1000

    /** The first subband that shares one sample between the channels. */
    private fun bound(h: Header, limit: Int): Int = when (h.mode) {
      JOINT_STEREO -> minOf(4 * (h.modeExtension + 1), limit)
      MONO -> 0
      else -> limit
    }

    /** 11172-3 Table 3-B.1: 2^(1 - index/3); 63 is not a scale factor (MA07). */
    private val SCALE = FloatArray(64) { if (it == 63) 0f else 2.0.pow(1.0 - it / 3.0).toFloat() }
    private fun scaleFactor(index: Int) = SCALE[index]

    /** Requantization: (2 code - (L - 1)) / L for L levels (Tables 3-B.4/3-B.5, MA07). */
    private fun dequantize(code: Int, levels: Int) = (2f * code - (levels - 1)) / levels

    private fun toPcm(value: Float): Short =
      (value * 32768f).roundToInt().coerceIn(-32768, 32767).toShort() // MA13

    /** Layer II allocation: per subband, the bits read and the levels each code means. */
    private class Table(val limit: Int, private val rows: Array<IntArray>, private val rowOf: IntArray) {
      fun width(sb: Int) = WIDTHS.getValue(rows[rowOf[sb]].size)
      fun levels(sb: Int, code: Int): Int = rows[rowOf[sb]].getOrElse(code) { 0 }
      private companion object {
        val WIDTHS = mapOf(16 to 4, 8 to 3, 4 to 2)
      }
    }

    private val HIGH_A = intArrayOf(0, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767, 65535)
    private val HIGH_B = intArrayOf(0, 3, 5, 7, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 65535)
    private val HIGH_C = intArrayOf(0, 3, 5, 7, 9, 15, 31, 65535)
    private val HIGH_D = intArrayOf(0, 3, 5, 65535)
    private val LOW_A = intArrayOf(0, 3, 5, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767)
    private val LOW_B = intArrayOf(0, 3, 5, 9, 15, 31, 63, 127)
    private val LSF_A = intArrayOf(0, 3, 5, 7, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383)
    private val LSF_B = intArrayOf(0, 3, 5, 9, 15, 31, 63, 127)
    private val LSF_C = intArrayOf(0, 3, 5, 9)

    private fun rows(vararg spans: Pair<Int, Int>): IntArray =
      spans.flatMap { (row, count) -> List(count) { row } }.toIntArray() + IntArray(32)

    /** Tables 3-B.2a/b (high rate, 27/30 subbands). */
    private val TABLE_A = Table(27, arrayOf(HIGH_A, HIGH_B, HIGH_C, HIGH_D), rows(0 to 3, 1 to 8, 2 to 12, 3 to 7))
    private val TABLE_B = Table(30, arrayOf(HIGH_A, HIGH_B, HIGH_C, HIGH_D), rows(0 to 3, 1 to 8, 2 to 12, 3 to 7))
    /** Tables 3-B.2c/d (low rate, 8/12 subbands). */
    private val TABLE_C = Table(8, arrayOf(LOW_A, LOW_B), rows(0 to 2, 1 to 10))
    private val TABLE_D = Table(12, arrayOf(LOW_A, LOW_B), rows(0 to 2, 1 to 10))
    /** 13818-3 Table B.1 (all lower sampling frequencies, 30 subbands). */
    private val TABLE_LSF = Table(30, arrayOf(LSF_A, LSF_B, LSF_C), rows(0 to 4, 1 to 7, 2 to 19))

    private fun allocationTable(h: Header, kbps: Int): Table {
      if (h.version != 3) return TABLE_LSF
      val perChannel = if (h.channels == 1) kbps else kbps / 2
      return when {
        perChannel <= 48 -> if (h.sampleRate == 32000) TABLE_D else TABLE_C
        perChannel <= 80 -> TABLE_A
        h.sampleRate == 48000 -> TABLE_A
        else -> TABLE_B
      }
    }

    /** N[i][k] = cos((16 + i)(2k + 1)π / 64). */
    private val MATRIX = FloatArray(64 * 32) {
      val i = it / 32
      val k = it % 32
      cos((16 + i) * (2 * k + 1) * PI / 64).toFloat()
    }

    /** 11172-3 Table 3-B.3, D[0..511], in units of 2^-15 (every entry is exact). */
    private val WINDOW: FloatArray = floatArrayOf(
    0.0f, -0.5f, -0.5f, -0.5f, -0.5f, -0.5f, -0.5f, -1.0f,
    -1.0f, -1.0f, -1.0f, -1.5f, -1.5f, -2.0f, -2.0f, -2.5f,
    -2.5f, -3.0f, -3.5f, -3.5f, -4.0f, -4.5f, -5.0f, -5.5f,
    -6.5f, -7.0f, -8.0f, -8.5f, -9.5f, -10.5f, -12.0f, -13.0f,
    -14.5f, -15.5f, -17.5f, -19.0f, -20.5f, -22.5f, -24.5f, -26.5f,
    -29.0f, -31.5f, -34.0f, -36.5f, -39.5f, -42.5f, -45.5f, -48.5f,
    -52.0f, -55.5f, -58.5f, -62.5f, -66.0f, -69.5f, -73.5f, -77.0f,
    -80.5f, -84.5f, -88.0f, -91.5f, -95.0f, -98.0f, -101.0f, -104.0f,
    106.5f, 109.0f, 111.0f, 112.5f, 113.5f, 114.0f, 114.0f, 113.5f,
    112.0f, 110.5f, 107.5f, 104.0f, 100.0f, 94.5f, 88.5f, 81.5f,
    73.0f, 63.5f, 53.0f, 41.5f, 28.5f, 14.5f, -1.0f, -18.0f,
    -36.0f, -55.5f, -76.5f, -98.5f, -122.0f, -147.0f, -173.5f, -200.5f,
    -229.5f, -259.5f, -290.5f, -322.5f, -355.5f, -389.5f, -424.0f, -459.5f,
    -495.5f, -532.0f, -568.5f, -605.0f, -641.5f, -678.0f, -714.0f, -749.0f,
    -783.5f, -817.0f, -849.0f, -879.5f, -908.5f, -935.0f, -959.5f, -981.0f,
    -1000.5f, -1016.0f, -1028.5f, -1037.5f, -1042.5f, -1043.5f, -1040.0f, -1031.5f,
    1018.5f, 1000.0f, 976.0f, 946.5f, 911.0f, 869.5f, 822.0f, 767.5f,
    707.0f, 640.0f, 565.5f, 485.0f, 397.0f, 302.5f, 201.0f, 92.5f,
    -22.5f, -144.0f, -272.5f, -407.0f, -547.5f, -694.0f, -846.0f, -1003.0f,
    -1165.0f, -1331.5f, -1502.0f, -1675.5f, -1852.5f, -2031.5f, -2212.5f, -2394.0f,
    -2576.5f, -2758.5f, -2939.5f, -3118.5f, -3294.5f, -3467.5f, -3635.5f, -3798.5f,
    -3955.0f, -4104.5f, -4245.5f, -4377.5f, -4499.0f, -4609.5f, -4708.0f, -4792.5f,
    -4863.5f, -4919.0f, -4958.0f, -4979.5f, -4983.0f, -4967.5f, -4931.5f, -4875.0f,
    -4796.0f, -4694.5f, -4569.5f, -4420.0f, -4246.0f, -4046.0f, -3820.0f, -3567.0f,
    3287.0f, 2979.5f, 2644.0f, 2280.5f, 1888.0f, 1467.5f, 1018.5f, 541.0f,
    35.0f, -499.0f, -1061.0f, -1650.0f, -2266.5f, -2909.0f, -3577.0f, -4270.0f,
    -4987.5f, -5727.5f, -6490.0f, -7274.0f, -8077.5f, -8899.5f, -9739.0f, -10594.5f,
    -11464.5f, -12347.0f, -13241.0f, -14144.5f, -15056.0f, -15973.5f, -16895.5f, -17820.0f,
    -18744.5f, -19668.0f, -20588.0f, -21503.0f, -22410.5f, -23308.5f, -24195.0f, -25068.5f,
    -25926.5f, -26767.0f, -27589.0f, -28389.0f, -29166.5f, -29919.0f, -30644.5f, -31342.0f,
    -32009.5f, -32645.0f, -33247.0f, -33814.5f, -34346.0f, -34839.5f, -35295.0f, -35710.0f,
    -36084.5f, -36417.5f, -36707.5f, -36954.0f, -37156.5f, -37315.0f, -37428.0f, -37496.0f,
    37519.0f, 37496.0f, 37428.0f, 37315.0f, 37156.5f, 36954.0f, 36707.5f, 36417.5f,
    36084.5f, 35710.0f, 35295.0f, 34839.5f, 34346.0f, 33814.5f, 33247.0f, 32645.0f,
    32009.5f, 31342.0f, 30644.5f, 29919.0f, 29166.5f, 28389.0f, 27589.0f, 26767.0f,
    25926.5f, 25068.5f, 24195.0f, 23308.5f, 22410.5f, 21503.0f, 20588.0f, 19668.0f,
    18744.5f, 17820.0f, 16895.5f, 15973.5f, 15056.0f, 14144.5f, 13241.0f, 12347.0f,
    11464.5f, 10594.5f, 9739.0f, 8899.5f, 8077.5f, 7274.0f, 6490.0f, 5727.5f,
    4987.5f, 4270.0f, 3577.0f, 2909.0f, 2266.5f, 1650.0f, 1061.0f, 499.0f,
    -35.0f, -541.0f, -1018.5f, -1467.5f, -1888.0f, -2280.5f, -2644.0f, -2979.5f,
    3287.0f, 3567.0f, 3820.0f, 4046.0f, 4246.0f, 4420.0f, 4569.5f, 4694.5f,
    4796.0f, 4875.0f, 4931.5f, 4967.5f, 4983.0f, 4979.5f, 4958.0f, 4919.0f,
    4863.5f, 4792.5f, 4708.0f, 4609.5f, 4499.0f, 4377.5f, 4245.5f, 4104.5f,
    3955.0f, 3798.5f, 3635.5f, 3467.5f, 3294.5f, 3118.5f, 2939.5f, 2758.5f,
    2576.5f, 2394.0f, 2212.5f, 2031.5f, 1852.5f, 1675.5f, 1502.0f, 1331.5f,
    1165.0f, 1003.0f, 846.0f, 694.0f, 547.5f, 407.0f, 272.5f, 144.0f,
    22.5f, -92.5f, -201.0f, -302.5f, -397.0f, -485.0f, -565.5f, -640.0f,
    -707.0f, -767.5f, -822.0f, -869.5f, -911.0f, -946.5f, -976.0f, -1000.0f,
    1018.5f, 1031.5f, 1040.0f, 1043.5f, 1042.5f, 1037.5f, 1028.5f, 1016.0f,
    1000.5f, 981.0f, 959.5f, 935.0f, 908.5f, 879.5f, 849.0f, 817.0f,
    783.5f, 749.0f, 714.0f, 678.0f, 641.5f, 605.0f, 568.5f, 532.0f,
    495.5f, 459.5f, 424.0f, 389.5f, 355.5f, 322.5f, 290.5f, 259.5f,
    229.5f, 200.5f, 173.5f, 147.0f, 122.0f, 98.5f, 76.5f, 55.5f,
    36.0f, 18.0f, 1.0f, -14.5f, -28.5f, -41.5f, -53.0f, -63.5f,
    -73.0f, -81.5f, -88.5f, -94.5f, -100.0f, -104.0f, -107.5f, -110.5f,
    -112.0f, -113.5f, -114.0f, -114.0f, -113.5f, -112.5f, -111.0f, -109.0f,
    106.5f, 104.0f, 101.0f, 98.0f, 95.0f, 91.5f, 88.0f, 84.5f,
    80.5f, 77.0f, 73.5f, 69.5f, 66.0f, 62.5f, 58.5f, 55.5f,
    52.0f, 48.5f, 45.5f, 42.5f, 39.5f, 36.5f, 34.0f, 31.5f,
    29.0f, 26.5f, 24.5f, 22.5f, 20.5f, 19.0f, 17.5f, 15.5f,
    14.5f, 13.0f, 12.0f, 10.5f, 9.5f, 8.5f, 8.0f, 7.0f,
    6.5f, 5.5f, 5.0f, 4.5f, 4.0f, 3.5f, 3.5f, 3.0f,
    2.5f, 2.5f, 2.0f, 2.0f, 1.5f, 1.5f, 1.0f, 1.0f,
    1.0f, 1.0f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f
    ).let { raw -> FloatArray(512) { raw[it] / 32768f } }
  }

  /** Reads bits most significant first; reading past the frame sets [overrun] (MA01). */
  private class BitReader(private val bytes: ByteArray, start: Int, private val end: Int) {
    private var bit = start.toLong() * 8
    var overrun = false
      private set

    fun read(count: Int): Int {
      var value = 0
      repeat(count) {
        val index = (bit shr 3).toInt()
        val b = if (index < end) (bytes[index].toInt() shr (7 - (bit and 7).toInt())) and 1 else {
          overrun = true
          0
        }
        value = (value shl 1) or b
        bit++
      }
      return value
    }

    fun skip(count: Int) {
      bit += count
      if ((bit + 7) shr 3 > end) overrun = true
    }
  }
}
