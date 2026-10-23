package com.tmg.tv

import com.tmg.tv.TrierMpegTestFrames.Spec
import kotlin.math.abs
import kotlin.random.Random
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** docs/trier-mpeg.md: each test names the invariants it proves. */
class TrierMpegDecoderTest {
  private val out = ShortArray(1152 * 2)

  /** Every Layer I/II variant: versions, rates, modes, the four Layer II tables. */
  private val variants: List<Spec> = buildList {
    for (version in listOf(3, 2, 0)) for (rate in 0..2) for (mode in 0..3) {
      add(Spec(version, 1, rate, if (version == 3) 6 else 8, mode, modeExtension = rate))
      add(Spec(version, 2, rate, if (version == 3) 9 else 10, mode, modeExtension = rate))
    }
    // MPEG-1 Layer II low-rate tables C (44.1/48 kHz) and D (32 kHz), and B (44.1 kHz high rate).
    for (rate in 0..2) for (mode in listOf(0, 3)) add(Spec(3, 2, rate, if (mode == 3) 2 else 4, mode))
    add(Spec(3, 2, 0, 12, 0))
  }

  private fun decode(decoder: TrierMpegDecoder, bytes: ByteArray, at: Int = 0, length: Int = bytes.size - at) =
    decoder.decode(bytes, at, length, out)

  @Test
  fun everyVariantDecodesToItsFrameLength_MA04_MA06() {
    val random = Random(1)
    for (spec in variants) {
      val frame = TrierMpegTestFrames.frame(spec, random)
      val header = TrierMpegDecoder.header(frame, 0, frame.size)
      assertNotNull("$spec", header)
      assertEquals("$spec", TrierMpegTestFrames.rate(spec), header!!.sampleRate)
      assertEquals("$spec", frame.size, header.frameBytes)
      val samples = decode(TrierMpegDecoder(), frame)
      assertEquals("$spec", if (spec.layer == 1) 384 else 1152, samples)
      assertTrue("$spec makes sound", (0 until samples * 2).any { out[it] != 0.toShort() })
    }
  }

  @Test
  fun headersRejectReservedValuesAndLayerThree_MA02() {
    val good = TrierMpegTestFrames.frame(Spec(3, 2, 1, 6, 0), Random(2))
    fun with(byte: Int, value: Int) = good.copyOf().also { it[byte] = value.toByte() }
    assertNotNull(TrierMpegDecoder.header(good, 0, good.size))
    assertNull(TrierMpegDecoder.header(with(1, 0xEB), 0, good.size)) // reserved version
    assertNull(TrierMpegDecoder.header(with(1, 0xFB), 0, good.size)) // Layer III
    assertNull(TrierMpegDecoder.header(with(1, 0xF9), 0, good.size)) // reserved layer
    assertNull(TrierMpegDecoder.header(with(2, 0xF4), 0, good.size)) // bitrate index 15
    assertNull(TrierMpegDecoder.header(with(2, 0x6C), 0, good.size)) // reserved rate
    assertNull(TrierMpegDecoder.header(with(0, 0xFE), 0, good.size)) // no sync
    assertNull(TrierMpegDecoder.header(good, 0, 3))
    assertNull(TrierMpegDecoder.header(good, good.size - 2, 2))
    // Known sizes: Layer II 128 kbit/s 44.1 kHz; Layer I 384 kbit/s 48 kHz; MPEG-2 Layer II 64 kbit/s 24 kHz.
    assertEquals(417, TrierMpegTestFrames.frameBytes(Spec(3, 2, 0, 8, 0)))
    assertEquals(384, TrierMpegTestFrames.frameBytes(Spec(3, 1, 1, 12, 0)))
    assertEquals(384, TrierMpegTestFrames.frameBytes(Spec(2, 2, 1, 8, 0)))
  }

  @Test
  fun anyDamageNeverThrowsAndKeepsTheTimeline_MA01_MA03() {
    val random = Random(3)
    for (spec in variants) {
      val frame = TrierMpegTestFrames.frame(spec, random)
      val expected = if (spec.layer == 1) 384 else 1152
      val decoder = TrierMpegDecoder()
      // Every truncation: a frame with its header always yields its full length.
      for (cut in 0..frame.size) {
        val n = decode(decoder, frame, 0, cut)
        assertTrue("$spec cut $cut", n == 0 || n == expected)
        if (cut >= 4) assertEquals("$spec cut $cut", expected, n)
        if (cut in 4 until frame.size) assertTrue("$spec truncated is silent", out.take(n * 2).all { it == 0.toShort() })
      }
      // Single-bit damage anywhere, and random bytes after a good header.
      for (bit in 0 until frame.size * 8 step 3) {
        val damaged = frame.copyOf()
        damaged[bit / 8] = (damaged[bit / 8].toInt() xor (0x80 shr (bit % 8))).toByte()
        val n = decode(decoder, damaged)
        assertTrue(n == 0 || n == 384 || n == 1152)
      }
      val noise = frame.copyOf()
      for (i in 4 until noise.size) noise[i] = random.nextInt(256).toByte()
      assertEquals(expected, decode(decoder, noise))
    }
    val junk = ByteArray(4096) { random.nextInt(256).toByte() }
    for (at in junk.indices step 7) decode(TrierMpegDecoder(), junk, at, junk.size - at)
  }

  @Test
  fun unusualButReadableBitrateModePairsAreDecoded_MA04() {
    // 11172-3 calls these combinations disallowed for Layer II; streams carry them anyway.
    for (spec in listOf(Spec(3, 2, 0, 1, 0), Spec(3, 2, 1, 2, 1), Spec(3, 2, 0, 14, 3), Spec(3, 2, 2, 13, 3))) {
      val frame = TrierMpegTestFrames.frame(spec, Random(4))
      assertEquals("$spec", 1152, decode(TrierMpegDecoder(), frame))
      assertTrue("$spec", out.any { it != 0.toShort() })
    }
  }

  @Test
  fun freeFormatTakesItsLengthFromTheContainer_MA05() {
    for (spec in listOf(Spec(3, 2, 1, 0, 0, freeBytes = 1200), Spec(3, 1, 0, 0, 3, freeBytes = 800))) {
      val frame = TrierMpegTestFrames.frame(spec, Random(5))
      assertEquals(0, TrierMpegDecoder.header(frame, 0, frame.size)!!.frameBytes)
      assertEquals(if (spec.layer == 1) 384 else 1152, decode(TrierMpegDecoder(), frame))
      assertTrue(out.any { it != 0.toShort() })
    }
  }

  @Test
  fun channelsKeepTheirRoles_MA06() {
    val mono = TrierMpegTestFrames.frame(Spec(3, 2, 1, 6, 3), Random(6))
    decode(TrierMpegDecoder(), mono)
    for (i in 0 until 1152) assertEquals(out[2 * i], out[2 * i + 1])
    // Dual channel: the first program on both speakers (Windows and TVs do the same).
    val dual = TrierMpegTestFrames.frame(Spec(3, 2, 1, 10, 2), Random(7))
    decode(TrierMpegDecoder(), dual)
    for (i in 0 until 1152) assertEquals(out[2 * i], out[2 * i + 1])
    assertTrue(out.any { it != 0.toShort() })
    // Stereo keeps two different channels.
    decode(TrierMpegDecoder(), TrierMpegTestFrames.frame(Spec(3, 2, 1, 10, 0), Random(7)))
    assertTrue((0 until 1152).any { out[2 * it] != out[2 * it + 1] })
  }

  @Test
  fun scaleFactorsAndCodesScaleExactly_MA07_MA13() {
    // One subband (Layer I, mono, subband 0, 4-bit samples), every sample code c.
    fun frame(scale: Int, code: Int): ByteArray {
      val w = TrierMpegTestFrames.Writer(TrierMpegTestFrames.frameBytes(Spec(3, 1, 1, 6, 3)))
      w.put(11, 0x7ff); w.put(2, 3); w.put(2, 3); w.put(1, 1); w.put(4, 6); w.put(2, 1)
      w.put(1, 0); w.put(1, 0); w.put(2, 3); w.put(2, 0); w.put(4, 0)
      w.put(4, 3); repeat(31) { w.put(4, 0) } // subband 0: 4-bit samples
      w.put(6, scale)
      repeat(12) { w.put(4, code) }
      return w.bytes
    }
    val loud = ShortArray(384 * 2).also { TrierMpegDecoder().decode(frame(9, 2), 0, 1000, it) }
    val half = ShortArray(384 * 2).also { TrierMpegDecoder().decode(frame(12, 2), 0, 1000, it) }
    for (i in loud.indices) assertTrue(abs(loud[i] / 2.0 - half[i]) <= 1.0) // 3 steps = half (2^-1)
    val flipped = ShortArray(384 * 2).also { TrierMpegDecoder().decode(frame(9, 12), 0, 1000, it) }
    for (i in loud.indices) assertTrue(abs(loud[i] + flipped[i]) <= 1) // codes c and L-1-c mirror
    // Scale factor 63 is not a scale factor: silence, not noise.
    val bad = ShortArray(384 * 2).also { TrierMpegDecoder().decode(frame(63, 2), 0, 1000, it) }
    assertTrue(bad.all { it == 0.toShort() })
    // The loudest legal frame clamps instead of wrapping around.
    val decoder = TrierMpegDecoder()
    val loudest = Spec(3, 2, 1, 14, 0, loudest = 0)
    repeat(20) { decoder.decode(TrierMpegTestFrames.frame(loudest, Random(it), 1.0), 0, 2000, out) }
  }

  @Test
  fun invalidSamplesAndForbiddenAllocationMuteTheFrame_MA10_MA11() {
    val spec = Spec(3, 1, 1, 6, 3)
    val size = TrierMpegTestFrames.frameBytes(spec)
    fun layerOne(allocation: Int, sample: Int): ByteArray {
      val w = TrierMpegTestFrames.Writer(size)
      w.put(11, 0x7ff); w.put(2, 3); w.put(2, 3); w.put(1, 1); w.put(4, 6); w.put(2, 1)
      w.put(1, 0); w.put(1, 0); w.put(2, 3); w.put(2, 0); w.put(4, 0)
      w.put(4, allocation); repeat(31) { w.put(4, 0) }
      w.put(6, 9)
      if (allocation != 15) repeat(12) { w.put(allocation + 1, sample) }
      return w.bytes
    }
    assertEquals(384, decode(TrierMpegDecoder(), layerOne(15, 0)))
    assertTrue(out.take(768).all { it == 0.toShort() })
    assertEquals(384, decode(TrierMpegDecoder(), layerOne(3, 15))) // all-ones sample
    assertTrue(out.take(768).all { it == 0.toShort() })
  }

  @Test
  fun crcProtectedFramesDecodeLikeTheirUnprotectedTwins_MA12() {
    for (layer in 1..2) {
      val plain = Spec(3, layer, 1, if (layer == 1) 6 else 9, 0)
      val a = TrierMpegTestFrames.frame(plain, Random(8), 0.15)
      val b = TrierMpegTestFrames.frame(plain.copy(crc = true), Random(8), 0.15)
      val first = out.copyOf().also { TrierMpegDecoder().decode(a, 0, a.size, it) }
      val second = out.copyOf().also { TrierMpegDecoder().decode(b, 0, b.size, it) }
      assertTrue("frame makes sound", first.any { it != 0.toShort() })
      assertArrayEquals(first, second)
    }
  }

  @Test
  fun resetForgetsTheFilterHistory_MA09() {
    val spec = Spec(3, 2, 1, 6, 0)
    val one = TrierMpegTestFrames.frame(spec, Random(9))
    val two = TrierMpegTestFrames.frame(spec, Random(10))
    val fresh = out.copyOf().also { TrierMpegDecoder().decode(two, 0, two.size, it) }
    val decoder = TrierMpegDecoder()
    decoder.decode(one, 0, one.size, out)
    decoder.reset()
    val afterReset = out.copyOf().also { decoder.decode(two, 0, two.size, it) }
    assertArrayEquals(fresh, afterReset)
  }

  @Test
  fun tenSecondsDecodeQuickly_MA14() {
    val spec = Spec(3, 2, 1, 12, 0)
    val frames = List(20) { TrierMpegTestFrames.frame(spec, Random(it)) }
    val decoder = TrierMpegDecoder()
    repeat(50) { for (f in frames) decoder.decode(f, 0, f.size, out) } // warm up
    val start = System.nanoTime()
    repeat(420) { decoder.decode(frames[it % 20], 0, frames[it % 20].size, out) } // ~10 s of 48 kHz
    val ms = (System.nanoTime() - start) / 1_000_000
    assertTrue("10 s of audio took $ms ms", ms < 2000)
  }
}
