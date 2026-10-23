package com.tmg.tv

import java.io.File
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Evidence run against an independent decoder (docs/trier-mpeg.md,
 * MA08): with GENX_TRIER_MPEG_YARDSTICK_DIR set, decodes every *.mpa stream in that
 * folder to <name>.genx.pcm (16-bit stereo) for comparison with Windows Media
 * Foundation's output (scripts in the evidence folder). Skipped otherwise.
 */
class TrierMpegYardstickTest {
  @Test
  fun decodeYardstickStreams() {
    val dir = System.getenv("GENX_TRIER_MPEG_YARDSTICK_DIR")
    assumeTrue(dir != null && File(dir).isDirectory)
    // Generated streams for every variant (seeded, so a run can be repeated).
    if (System.getenv("GENX_TRIER_MPEG_GENERATE") == "1") {
      var seed = 100
      for (version in listOf(3, 2, 0)) for (layer in 1..2) for (rate in 0..2) for (mode in 0..3) {
        val bitrate = if (version == 3) (if (layer == 1) 6 else 9) else (if (layer == 1) 8 else 10)
        val spec = TrierMpegTestFrames.Spec(version, layer, rate, bitrate, mode, modeExtension = (rate + mode) % 4)
        File(dir, "gen-v$version-l$layer-r$rate-m$mode.mpa").writeBytes(TrierMpegTestFrames.stream(spec, 40, seed++))
      }
      // MPEG-1 Layer II tables C/D (low rate) and B (high rate at 44.1/32 kHz).
      for (rate in 0..2) {
        File(dir, "gen-tableCD-r$rate.mpa").writeBytes(TrierMpegTestFrames.stream(TrierMpegTestFrames.Spec(3, 2, rate, 4, 0), 40, seed++))
        File(dir, "gen-tableCD-mono-r$rate.mpa").writeBytes(TrierMpegTestFrames.stream(TrierMpegTestFrames.Spec(3, 2, rate, 2, 3), 40, seed++))
      }
      File(dir, "gen-tableB-r0.mpa").writeBytes(TrierMpegTestFrames.stream(TrierMpegTestFrames.Spec(3, 2, 0, 12, 0), 40, seed++))
      File(dir, "gen-tableB-r2.mpa").writeBytes(TrierMpegTestFrames.stream(TrierMpegTestFrames.Spec(3, 2, 2, 12, 0), 40, seed++))
    }
    for (file in File(dir!!).listFiles { f -> f.name.endsWith(".mpa") }!!.sorted()) {
      val input = file.readBytes()
      val decoder = TrierMpegDecoder()
      val out = ShortArray(1152 * 2)
      val pcm = java.io.ByteArrayOutputStream()
      var at = 0
      var frames = 0
      while (at + 4 <= input.size) {
        val header = TrierMpegDecoder.header(input, at, input.size - at)
        if (header == null || header.frameBytes == 0 || at + header.frameBytes > input.size) {
          at++
          continue
        }
        val samples = decoder.decode(input, at, header.frameBytes, out)
        for (i in 0 until samples * 2) {
          pcm.write(out[i].toInt() and 0xff)
          pcm.write((out[i].toInt() shr 8) and 0xff)
        }
        frames++
        at += header.frameBytes
      }
      File(dir, file.name.removeSuffix(".mpa") + ".genx.pcm").writeBytes(pcm.toByteArray())
      println("yardstick ${file.name}: $frames frames")
    }
  }
}
