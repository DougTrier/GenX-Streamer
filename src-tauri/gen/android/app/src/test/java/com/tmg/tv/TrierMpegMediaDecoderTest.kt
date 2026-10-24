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

import androidx.media3.common.C
import com.tmg.tv.TrierMpegTestFrames.Spec
import java.nio.ByteOrder
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** MP04 (docs/lifecycle-media-invariants.md): what Trier MPEG hands Android's player. */
class TrierMpegMediaDecoderTest {
  private fun decodeOne(decoder: TrierMpegMediaDecoder, frame: ByteArray, timeUs: Long): ShortArray {
    val input = decoder.dequeueInputBuffer()!!
    input.ensureSpaceForWrite(frame.size)
    input.data!!.put(frame)
    input.timeUs = timeUs
    input.flip()
    decoder.queueInputBuffer(input)
    var output = decoder.dequeueOutputBuffer()
    val deadline = System.currentTimeMillis() + 2000
    while (output == null && System.currentTimeMillis() < deadline) {
      Thread.sleep(5)
      output = decoder.dequeueOutputBuffer()
    }
    assertNotNull(output)
    assertEquals(timeUs, output!!.timeUs)
    val data = output.data!!.order(ByteOrder.nativeOrder())
    val pcm = ShortArray(data.remaining() / 2).also { data.asShortBuffer().get(it) }
    output.release()
    return pcm
  }

  @Test
  fun eachFrameBecomesSixteenBitStereoPcmAtTheStreamRate_MP04() {
    for ((spec, rate) in listOf(Spec(3, 2, 1, 6, 0) to 48000, Spec(2, 2, 0, 10, 3) to 22050, Spec(3, 1, 0, 6, 0) to 44100)) {
      val decoder = TrierMpegMediaDecoder(rate, spec.layer, 0)
      val format = decoder.outputFormat()
      assertEquals(C.ENCODING_PCM_16BIT, format.pcmEncoding)
      assertEquals(2, format.channelCount)
      assertEquals(rate, format.sampleRate)
      val pcm = decodeOne(decoder, TrierMpegTestFrames.frame(spec, Random(1)), 1_000_000)
      assertEquals((if (spec.layer == 1) 384 else 1152) * 2, pcm.size)
      assertTrue(pcm.any { it != 0.toShort() })
      decoder.release()
    }
  }

  @Test
  fun aDamagedFrameIsSilenceOfItsFullLengthNotAGap_MP04_MA03() {
    val decoder = TrierMpegMediaDecoder(48000, 2, 0)
    val good = TrierMpegTestFrames.frame(Spec(3, 2, 1, 6, 0), Random(2))
    val noHeader = ByteArray(good.size) // no sync at all
    val pcm = decodeOne(decoder, noHeader, 2_000_000)
    assertEquals(1152 * 2, pcm.size)
    assertTrue(pcm.all { it == 0.toShort() })
    decoder.release()
  }
}
