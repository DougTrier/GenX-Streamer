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

import kotlin.random.Random

/**
 * Writes random but valid MPEG audio Layer I/II frames for tests and for the
 * Windows yardstick (docs/trier-mpeg.md). Built from the bitstream
 * syntax of ISO/IEC 11172-3 and 13818-3, separately from the decoder.
 */
object TrierMpegTestFrames {
  /** version: 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5; mode: 0 stereo, 1 joint, 2 dual, 3 mono. */
  data class Spec(
    val version: Int,
    val layer: Int,
    val rateIndex: Int,
    val bitrateIndex: Int,
    val mode: Int,
    val modeExtension: Int = 0,
    val crc: Boolean = false,
    /** Free format (bitrate index 0) frames need a length; ignored otherwise. */
    val freeBytes: Int = 0,
    /** Lowest scale factor index used; higher means quieter (no clipping). */
    val loudest: Int = 12,
  )

  private val RATES = mapOf(3 to intArrayOf(44100, 48000, 32000), 2 to intArrayOf(22050, 24000, 16000), 0 to intArrayOf(11025, 12000, 8000))
  private val KBPS = mapOf(
    "3/1" to intArrayOf(0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448),
    "3/2" to intArrayOf(0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384),
    "L/1" to intArrayOf(0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256),
    "L/2" to intArrayOf(0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160),
  )

  fun rate(spec: Spec) = RATES.getValue(spec.version)[spec.rateIndex]
  /** The bitrate, or for free format the one the frame length implies. */
  fun kbps(spec: Spec): Int {
    val listed = KBPS.getValue((if (spec.version == 3) "3" else "L") + "/" + spec.layer)[spec.bitrateIndex]
    if (listed != 0) return listed
    return if (spec.layer == 1) spec.freeBytes / 4 * rate(spec) / 12 / 1000 else spec.freeBytes * rate(spec) / 144 / 1000
  }

  fun frameBytes(spec: Spec, padding: Int = 0): Int {
    if (spec.bitrateIndex == 0) return spec.freeBytes
    val kbps = kbps(spec)
    return if (spec.layer == 1) (12 * kbps * 1000 / rate(spec) + padding) * 4
    else 144 * kbps * 1000 / rate(spec) + padding
  }

  class Writer(size: Int) {
    val bytes = ByteArray(size)
    var bit = 0
      private set
    val capacity = size * 8
    fun put(count: Int, value: Int) {
      for (i in count - 1 downTo 0) {
        if (bit >= capacity) throw IllegalStateException("frame overflow")
        if ((value shr i) and 1 == 1) bytes[bit shr 3] = (bytes[bit shr 3].toInt() or (0x80 shr (bit and 7))).toByte()
        bit++
      }
    }
  }

  private fun header(w: Writer, spec: Spec, padding: Int) {
    w.put(11, 0x7ff)
    w.put(2, spec.version)
    w.put(2, 4 - spec.layer)
    w.put(1, if (spec.crc) 0 else 1)
    w.put(4, spec.bitrateIndex)
    w.put(2, spec.rateIndex)
    w.put(1, padding)
    w.put(1, 0)
    w.put(2, spec.mode)
    w.put(2, spec.modeExtension)
    w.put(4, 0)
    if (spec.crc) w.put(16, 0) // CRC field present; GenX does not verify it (MA12)
  }

  /** Layer II allocation rows from 11172-3 Tables 3-B.2a-d and 13818-3 Table B.1. */
  private fun allocationRows(spec: Spec): List<IntArray> {
    val a = intArrayOf(0, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767, 65535)
    val b = intArrayOf(0, 3, 5, 7, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 65535)
    val c = intArrayOf(0, 3, 5, 7, 9, 15, 31, 65535)
    val d = intArrayOf(0, 3, 5, 65535)
    val lowA = intArrayOf(0, 3, 5, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767)
    val lowB = intArrayOf(0, 3, 5, 9, 15, 31, 63, 127)
    if (spec.version != 3) {
      val lsfA = intArrayOf(0, 3, 5, 7, 9, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383)
      val lsfB = intArrayOf(0, 3, 5, 9, 15, 31, 63, 127)
      val lsfC = intArrayOf(0, 3, 5, 9)
      return List(4) { lsfA } + List(7) { lsfB } + List(19) { lsfC }
    }
    val channels = if (spec.mode == 3) 1 else 2
    val perChannel = kbps(spec) / channels
    val rate = rate(spec)
    return when {
      perChannel <= 48 -> List(2) { lowA } + List(if (rate == 32000) 10 else 6) { lowB }
      perChannel <= 80 || rate == 48000 -> List(3) { a } + List(8) { b } + List(12) { c } + List(4) { d }
      else -> List(3) { a } + List(8) { b } + List(12) { c } + List(7) { d }
    }
  }

  private fun width(row: IntArray) = when (row.size) { 16 -> 4; 8 -> 3; else -> 2 }
  private fun bitsFor(levels: Int) = when (levels) { 3 -> 5; 5 -> 7; 9 -> 10; else -> 32 - Integer.numberOfLeadingZeros(levels) }

  /**
   * A random valid frame. [density] is the chance a subband carries sound;
   * it is lowered automatically until the frame's bits fit.
   */
  fun frame(spec: Spec, random: Random, density: Double = 0.7, padding: Int = 0): ByteArray {
    var chance = density
    while (true) {
      try {
        return attempt(spec, random, chance, padding)
      } catch (_: IllegalStateException) {
        chance *= 0.7
      }
    }
  }

  private fun attempt(spec: Spec, random: Random, density: Double, padding: Int): ByteArray {
    val w = Writer(frameBytes(spec, padding))
    header(w, spec, padding)
    val channels = if (spec.mode == 3) 1 else 2
    val scale = { random.nextInt(spec.loudest, 63) }
    if (spec.layer == 1) {
      val bound = if (spec.mode == 1) 4 * (spec.modeExtension + 1) else if (channels == 1) 0 else 32
      val alloc = Array(2) { IntArray(32) }
      for (sb in 0 until 32) for (ch in 0 until channels) {
        if (sb >= bound && ch == 1) { alloc[1][sb] = alloc[0][sb]; continue }
        alloc[ch][sb] = if (random.nextDouble() < density) random.nextInt(1, 15) else 0
        w.put(4, alloc[ch][sb])
      }
      for (sb in 0 until 32) for (ch in 0 until channels) if (alloc[ch][sb] != 0) w.put(6, scale())
      repeat(12) {
        for (sb in 0 until 32) for (ch in 0 until channels) {
          val nb = alloc[ch][sb]
          if (nb == 0 || (sb >= bound && ch == 1)) continue
          w.put(nb + 1, random.nextInt(0, (1 shl (nb + 1)) - 1)) // never all ones
        }
      }
      return w.bytes
    }
    val rows = allocationRows(spec)
    val limit = rows.size
    val bound = if (spec.mode == 1) minOf(4 * (spec.modeExtension + 1), limit) else if (channels == 1) 0 else limit
    val levels = Array(2) { IntArray(32) }
    for (sb in 0 until limit) for (ch in 0 until channels) {
      if (sb >= bound && ch == 1) { levels[1][sb] = levels[0][sb]; continue }
      val row = rows[sb]
      val code = if (random.nextDouble() < density) random.nextInt(1, row.size) else 0
      levels[ch][sb] = row[code]
      w.put(width(row), code)
    }
    val selection = Array(2) { IntArray(32) }
    for (sb in 0 until limit) for (ch in 0 until channels) if (levels[ch][sb] != 0) {
      selection[ch][sb] = random.nextInt(4)
      w.put(2, selection[ch][sb])
    }
    for (sb in 0 until limit) for (ch in 0 until channels) if (levels[ch][sb] != 0) {
      repeat(if (selection[ch][sb] == 0) 3 else if (selection[ch][sb] == 2) 1 else 2) { w.put(6, scale()) }
    }
    repeat(12) {
      for (sb in 0 until limit) for (ch in 0 until channels) {
        val l = levels[ch][sb]
        if (l == 0 || (sb >= bound && ch == 1)) continue
        if (l == 3 || l == 5 || l == 9) w.put(bitsFor(l), random.nextInt(l * l * l))
        else repeat(3) { w.put(bitsFor(l), random.nextInt(l)) }
      }
    }
    return w.bytes
  }

  /** [count] frames back to back, padding as the standard spreads it is not needed here. */
  fun stream(spec: Spec, count: Int, seed: Int): ByteArray {
    val random = Random(seed)
    val out = java.io.ByteArrayOutputStream()
    repeat(count) { out.write(frame(spec, random)) }
    return out.toByteArray()
  }
}
