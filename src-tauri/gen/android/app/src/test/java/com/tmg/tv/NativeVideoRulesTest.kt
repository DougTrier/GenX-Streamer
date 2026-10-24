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

import androidx.media3.common.PlaybackException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeVideoRulesTest {
  private val cap = "a".repeat(64)
  private val id = "b".repeat(64)
  private val relay = "http://127.0.0.1:41234/account/$cap/media/$id"

  @Test
  fun onlyTheLoopbackAccountRelayIsPlayed() {
    assertTrue(NativeVideoRules.relay(relay))
    for (refused in listOf(
      "http://provider.invalid:8080/movie/user/pass/1.mkv",
      "https://127.0.0.1:41234/account/$cap/media/$id",
      "http://localhost:41234/account/$cap/media/$id",
      "http://127.0.0.1/account/$cap/media/$id",
      "$relay?x=1",
      "$relay#f",
      "$relay/extra",
      "http://u:p@127.0.0.1:41234/account/$cap/media/$id",
      "http://127.0.0.1:41234/account/short/media/$id",
      "file:///sdcard/movie.mkv",
      "not a url",
    )) assertFalse(refused, NativeVideoRules.relay(refused))
  }

  @Test
  fun aLiveChannelPlaysOnlyThroughTheLoopbackLiveRelay() {
    assertTrue(NativeVideoRules.liveRelay("http://127.0.0.1:41000/media/$id"))
    for (refused in listOf(
      relay,
      "http://23.239.31.26:8989/accnetwork/index.m3u8",
      "https://127.0.0.1:41000/media/$id",
      "http://localhost:41000/media/$id",
      "http://127.0.0.1/media/$id",
      "http://127.0.0.1:41000/media/$id?x=1",
      "http://127.0.0.1:41000/media/$id/extra",
      "http://127.0.0.1:41000/media/short",
    )) assertFalse(refused, NativeVideoRules.liveRelay(refused))
  }

  @Test
  fun mpeg2TriesSoftwareDecodersFirstAndNothingElseChanges() {
    val decoders = listOf("hw.a" to false, "sw.b" to true, "hw.c" to false)
    val software = { d: Pair<String, Boolean> -> d.second }
    assertEquals(listOf("sw.b", "hw.a", "hw.c"), NativeVideoRules.decoderOrder("video/mpeg2", decoders, software).map { it.first })
    assertEquals(decoders, NativeVideoRules.decoderOrder("video/avc", decoders, software))
  }

  @Test
  fun liveChannelsSkipPlatformLayerTwoSoundButMoviesKeepIt() {
    val decoders = listOf("OMX.realtek.audio.decoder" to false)
    val software = { d: Pair<String, Boolean> -> d.second }
    assertTrue(NativeVideoRules.decoders("audio/mpeg-L2", true, decoders, software).isEmpty())
    assertTrue(NativeVideoRules.decoders("audio/mpeg-L1", true, decoders, software).isEmpty())
    assertEquals(decoders, NativeVideoRules.decoders("audio/mpeg-L2", false, decoders, software))
    assertEquals(decoders, NativeVideoRules.decoders("audio/mpeg", true, decoders, software))
    assertEquals(decoders, NativeVideoRules.decoders("audio/mp4a-latm", true, decoders, software))
  }

  @Test
  fun trackIdentitiesAreGroupAndIndex() {
    assertEquals(2 to 0, NativeVideoRules.track("2:0"))
    assertNull(NativeVideoRules.track(""))
    assertNull(NativeVideoRules.track("2"))
    assertNull(NativeVideoRules.track("-1:0"))
    assertNull(NativeVideoRules.track("a:b"))
    assertNull(NativeVideoRules.track("1:2:3"))
  }

  @Test
  fun failuresMapToFixedCodes() {
    assertEquals("network", NativeVideoRules.failure(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED))
    assertEquals("missing", NativeVideoRules.failure(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS))
    assertEquals("unsupported", NativeVideoRules.failure(PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED))
    assertEquals("unsupported", NativeVideoRules.failure(PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED))
    assertEquals("decode", NativeVideoRules.failure(PlaybackException.ERROR_CODE_DECODING_FAILED))
    assertEquals("decode", NativeVideoRules.failure(PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED))
    assertEquals("unknown", NativeVideoRules.failure(PlaybackException.ERROR_CODE_UNSPECIFIED))
  }

  @Test fun pictureIsUnsupportedOnlyWhenNoVideoTrackDecodes() {
    assertNull(NativeVideoRules.picture(emptyList()))
    assertEquals("shown", NativeVideoRules.picture(listOf(listOf(false, true))))
    assertEquals("unsupported", NativeVideoRules.picture(listOf(listOf(false), listOf(false))))
  }

  @Test fun replayAcceptsOnlyItsFourSpeeds() {
    assertEquals(0.25f, NativeVideoRules.replayRate(0.25))
    assertEquals(1f, NativeVideoRules.replayRate(1.0))
    assertEquals(0.125f, NativeVideoRules.replayRate(0.125))
    for (refused in listOf(0.0, 2.0, 0.3, -0.25, Double.NaN, Double.POSITIVE_INFINITY))
      assertNull(NativeVideoRules.replayRate(refused))
    assertEquals(30_000, NativeVideoRules.REPLAY_BACK_BUFFER_MS)
  }
  @Test fun replayFramePeriodComesFromAPlausibleFrameRate() {
    assertEquals(33_366L, NativeVideoRules.frameMicros(29.97f))
    assertEquals(16_666L, NativeVideoRules.frameMicros(60f))
    for (unknown in listOf(-1f, 0f, 5f, 240f, Float.NaN)) assertEquals(0L, NativeVideoRules.frameMicros(unknown))
  }
  @Test fun trierMpegVideoOnlyWithoutADeviceDecoder() {
    assertTrue(NativeVideoRules.needsTrierMpegVideo(0))
    assertFalse(NativeVideoRules.needsTrierMpegVideo(1))
  }
}
