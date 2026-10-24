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
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.EOFException
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.math.BigInteger

class TvRemoteWireTest {
  private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }
  private fun hex(data: ByteArray) = data.joinToString("") { "%02x".format(it) }

  @Test fun numbersAndFieldsAreEncodedAsTheProtocolHasThem() {
    assertArrayEquals(bytes(0), TvWire.varint(0))
    assertArrayEquals(bytes(0x96, 0x01), TvWire.varint(150))
    assertArrayEquals(bytes(0xEE, 0x04), TvWire.varint(622))
    assertArrayEquals(bytes(0x08, 0xC8, 0x01), TvWire.int(1, 200))
    assertArrayEquals(bytes(0x0A, 0x02, 'h'.code, 'i'.code), TvWire.text(1, "hi"))
    val message = TvWire.int(1, 2) + TvWire.int(2, 200) + TvWire.bytes(11, ByteArray(0))
    val parsed = TvWire.parse(message)!!
    assertEquals(2L, TvWire.number(parsed, 1))
    assertEquals(200L, TvWire.number(parsed, 2))
    assertTrue(parsed.containsKey(11))
  }

  @Test fun damagedMessagesAreRefusedNotGuessed() {
    assertNull(TvWire.parse(bytes(0x0A, 0x05, 1)))          // length past the end
    assertNull(TvWire.parse(bytes(0x08)))                   // number cut off
    assertNull(TvWire.parse(bytes(0x0B)))                   // group wire type
    assertNull(TvWire.parse(bytes(0x00, 0x01)))             // field zero
    assertEquals(TvEvent.Other, TvRemote.read(bytes(0xFF)))
  }

  @Test fun framesAreReadWholeAndBounded() {
    val one = TvWire.frame(TvWire.int(1, 5))
    val input = ByteArrayInputStream(one + one)
    assertArrayEquals(TvWire.int(1, 5), TvWire.readFrame(input))
    assertArrayEquals(TvWire.int(1, 5), TvWire.readFrame(input))
    assertThrows(EOFException::class.java) { TvWire.readFrame(input) }
    assertThrows(EOFException::class.java) { TvWire.readFrame(ByteArrayInputStream(bytes(5, 1, 2))) }
    val huge = TvWire.varint(TvWire.MAX_FRAME + 1L)
    assertThrows(IllegalStateException::class.java) { TvWire.readFrame(ByteArrayInputStream(huge)) }
  }

  @Test fun pairingAsksForASixDigitHexCodeTypedOnThePhone() {
    val options = TvWire.parse(TvPairing.options())!!
    assertEquals(200L, TvWire.number(options, 2))
    val encoding = TvWire.nested(TvWire.nested(options, 20), 1)
    assertEquals(3L, TvWire.number(encoding, 1))  // hexadecimal
    assertEquals(6L, TvWire.number(encoding, 2))  // six symbols
    assertEquals(1L, TvWire.number(TvWire.nested(options, 20), 3))  // GenX types it in
    assertTrue(TvPairing.accepted(TvWire.int(1, 2) + TvWire.int(2, 200) + TvWire.bytes(41, ByteArray(0)), 41))
    assertFalse(TvPairing.accepted(TvWire.int(1, 2) + TvWire.int(2, 402) + TvWire.bytes(41, ByteArray(0)), 41))
    assertFalse(TvPairing.accepted(TvWire.int(1, 2) + TvWire.int(2, 200), 41))
  }

  @Test fun codesAreReadAsTyped() {
    assertEquals("3FA9C1", TvPairing.code("3fa9c1"))
    assertEquals("3FA9C1", TvPairing.code(" 3F A9 C1 "))
    assertNull(TvPairing.code("3FA9C"))
    assertNull(TvPairing.code("3FA9CG"))
    assertNull(TvPairing.code("3FA9C17"))
  }

  /**
   * The vector was computed by the independent Python client that paired
   * with a Google TV Streamer on October 24, 2026 (random 2048-bit numbers,
   * not keys of any device).
   */
  @Test fun theSecretMatchesTheClientThatPairedWithARealTv() {
    val client = BigInteger("9377a26098225d2243bbf7d3e10550973caef31279879f9d552362c15b3b8a02099756b57247fde3fe8517a37bb41cc2c97b5a94f508fb71c66c524d22bff969fe2935efd4890956a61ec9dacaf15039c7cce89971e9678d489d802bcd48b0f8179bae0c4780c44a1dd74148d76acc208cc98904320df1163ad5bf8531e8de90cf46affc83e91d23e92b1445417304703038048ddc5b74f2dfe766a5112427c56cf509a09ad6e61411508077a9800650e21ece674af28f5058a5e73b8c9f89756046c4c90e851195d12f5f4d515bb3ba6fec99bb6013c89e09064bf5d024e13c80817212c0fc1ed91b8d2522731d440026a87050df77407684ca37d1dad3148f", 16)
    val server = BigInteger("d88388bf586655df29a673f1a074b560e711f5f944d002c1a262ef0d6920e67e97b55b476050d46d81c525e5e2237f5e269520ac72291bb4d5348972ae0fa242b8b08ecc52b6be4bfcbab8fac180605e0cc3cb5b5b58c18322b7c70b6cd6c6836dbdb5a5a3cd6ffa83e94d5f7a9654d2aa308712f9dac081b8d20e4522587038235a372e72916e84611dabe230ae9e97849e09afe1e89f0eadc50f2f57c3d8e51d3ead0b0429140ac43051ba4b204ffa5c9a559727444de13ca38619669fc013524421f7a427520ed4ca2d199da79224578915dcec35f59de08b69fef078d503bd258acc95018b3fb1ca088faf80a49376981b1f8311b8256708340e97510385", 16)
    val e = BigInteger.valueOf(65537)
    val hash = TvPairing.secretHash(client, e, server, e, "241a2b")
    assertEquals("2476051bb4144a0cc8d848b18a5c911ea40fab2ce76349c2868ed57b09e562cb", hex(hash!!))
    // A mistyped code fails its check digits before anything is sent.
    assertNull(TvPairing.secretHash(client, e, server, e, "251A2B"))
    assertArrayEquals(bytes(1, 0, 1), TvPairing.unsigned(e))
    assertEquals(256, TvPairing.unsigned(client).size)
  }

  /** Messages as a Google TV Streamer sent them (remote service 7.00). */
  @Test fun theTvsMessagesAreUnderstood() {
    val device = TvWire.text(1, "Google TV Streamer") + TvWire.text(2, "Google") + TvWire.int(3, 1) +
      TvWire.text(4, "14") + TvWire.text(5, "com.google.android.tv.remote.service") + TvWire.text(6, "7.00.999235495")
    val configure = TvWire.bytes(1, TvWire.int(1, 2687) + TvWire.bytes(2, device) + TvWire.int(3, 1))
    assertEquals(TvEvent.Configure("Google TV Streamer", "Google"), TvRemote.read(configure))
    assertEquals(TvEvent.SetActive, TvRemote.read(TvWire.bytes(2, TvWire.int(1, 622))))
    assertEquals(TvEvent.Ping(7), TvRemote.read(TvWire.bytes(8, TvWire.int(1, 7))))
    // Screen state, as the Streamer reported it asleep and after waking.
    assertEquals(TvEvent.Screen(false), TvRemote.read(TvWire.bytes(40, TvWire.int(1, 0))))
    assertEquals(TvEvent.Screen(true), TvRemote.read(TvWire.bytes(40, TvWire.int(1, 1))))
    // Home, one short press: the only key GenX sends.
    val home = TvWire.nested(TvWire.parse(TvRemote.home()), 10)
    assertEquals(3L, TvWire.number(home, 1))
    assertEquals(3L, TvWire.number(home, 2))
    val front = TvWire.bytes(20, TvWire.bytes(1, TvWire.text(12, "com.esaba.downloader")))
    assertEquals(TvEvent.FrontApp("com.esaba.downloader"), TvRemote.read(front))
    val odd = TvWire.bytes(20, TvWire.bytes(1, TvWire.text(12, "x y; rm")))
    assertEquals(TvEvent.Other, TvRemote.read(odd))
    // Replies GenX sends.
    assertEquals(622L, TvWire.number(TvWire.nested(TvWire.parse(TvRemote.setActiveReply()), 2), 1))
    assertEquals(7L, TvWire.number(TvWire.nested(TvWire.parse(TvRemote.pingReply(7)), 9), 1))
    assertEquals("genx://open", TvWire.string(TvWire.nested(TvWire.parse(TvRemote.openLink("genx://open")), 90), 1))
  }

  @Test fun onlyGenXsOwnLinksAreOpenedOnATv() {
    assertTrue(TvLinks.allowed("http://192.168.1.20:8080/482913/GenX-Streamer.apk"))
    assertTrue(TvLinks.allowed(TvLinks.DOWNLOADER_STORE))
    assertTrue(TvLinks.allowed("genx://open?reply=http://192.168.1.20:8080/482913/installed"))
    assertFalse(TvLinks.allowed("genx://open"))
    assertFalse(TvLinks.allowed("genx://open?reply=http://8.8.8.8:8080/482913/installed"))
    assertFalse(TvLinks.allowed("genx://open?reply=http://192.168.1.20:8080/482913/other"))
    for (refused in listOf("https://example.com/", "http://192.168.1.20:8080/482913/other.apk",
        "http://192.168.1.20:8080/48291/GenX-Streamer.apk", "market://details?id=com.other",
        "genx://watch?x=1", "intent://x#Intent;end", "")) {
      assertFalse(refused, TvLinks.allowed(refused))
    }
  }

  @Test fun onlyTvsOnThisNetworkAreContacted() {
    for (local in listOf("192.168.1.30", "10.0.0.4", "172.16.0.9")) assertTrue(local, TvAddress.local(local))
    for (other in listOf("8.8.8.8", "172.32.0.1", "127.0.0.1", "192.168.1.300", "192.168.01.3", "tv.local", ""))
      assertFalse(other, TvAddress.local(other))
  }

  @Test fun pairedTvsAreStoredBoundedAndReplacedByFingerprint() {
    val a = PairedTv("a".repeat(64), "Living room")
    val b = PairedTv("b".repeat(64), "Den")
    val stored = PairedTvs.encode(PairedTvs.add(PairedTvs.add(listOf(a), b), a.copy(name = "Living room TV")))
    assertEquals(listOf(b, a.copy(name = "Living room TV")), PairedTvs.decode(stored))
    assertEquals(emptyList<PairedTv>(), PairedTvs.decode("not a fingerprint\n"))
    val many = (0 until 40).map { PairedTv("%064x".format(it), "TV $it") }
    assertEquals(PairedTvs.MAX, PairedTvs.decode(PairedTvs.encode(many)).size)
  }
  /**
   * A stand-in TV over pipes, as the Streamer behaves (setup, a ping every
   * five seconds, front-app reports): GenX answers each, and a dropped
   * connection is reported as closed, never as a silent success.
   */
  @Test fun theSessionAnswersTheTvAndReportsADroppedConnection() {
    val toGenX = PipedOutputStream(); val genxReads = PipedInputStream(toGenX, 65536)
    val toTv = PipedOutputStream(); val tvReads = PipedInputStream(toTv, 65536)
    var closed = false
    val session = TvRemoteSession(genxReads, toTv, "0.1.0") { closed = true; toGenX.close() }
    val thread = Thread(session::run).apply { start() }
    fun tvSends(message: ByteArray) { toGenX.write(TvWire.frame(message)); toGenX.flush() }
    fun tvHears(): Map<Int, List<Any>> = TvWire.parse(TvWire.readFrame(tvReads))!!

    val device = TvWire.text(1, "Google TV Streamer") + TvWire.text(2, "Google")
    tvSends(TvWire.bytes(1, TvWire.int(1, 2687) + TvWire.bytes(2, device)))
    assertTrue(tvHears().containsKey(1))
    tvSends(TvWire.bytes(2, TvWire.int(1, 622)))
    assertTrue(tvHears().containsKey(2))
    tvSends(TvWire.bytes(8, TvWire.int(1, 41)))
    assertEquals(41L, TvWire.number(TvWire.nested(tvHears(), 9), 1))
    tvSends(TvWire.bytes(20, TvWire.bytes(1, TvWire.text(12, "com.android.vending"))))
    session.send(TvRemote.openLink("genx://open"))
    assertEquals("genx://open", TvWire.string(TvWire.nested(tvHears(), 90), 1))
    // The session reads on its own thread: wait (bounded) for the front-app report.
    val until = System.currentTimeMillis() + 2000
    while (session.front.isEmpty() && System.currentTimeMillis() < until) Thread.sleep(10)
    assertTrue(session.ready)
    assertEquals("Google TV Streamer", session.model)
    assertEquals("com.android.vending", session.front)
    tvSends(TvWire.bytes(40, TvWire.int(1, 1)))
    val lit = System.currentTimeMillis() + 2000
    while (session.screenOn != true && System.currentTimeMillis() < lit) Thread.sleep(10)
    assertEquals(true, session.screenOn)

    // The TV goes away mid-session.
    toGenX.close()
    thread.join(2000)
    assertFalse(session.open)
    assertTrue(closed)
    assertThrows(IllegalStateException::class.java) { session.send(TvRemote.openLink("genx://open")) }
  }

  /** On the TV: only a check address on this network is ever contacted, with a SHA-256. */
  @Test fun genxOnTheTvReportsOnlyToThePhonesNearbyShare() {
    val reply = "http://192.168.1.20:8080/482913/installed"
    assertEquals(reply, TvCheckIn.reply("genx://open?reply=$reply"))
    for (refused in listOf(null, "genx://open", "genx://open?reply=http://8.8.8.8:8080/482913/installed",
        "genx://open?reply=https://192.168.1.20:8080/482913/installed",
        "genx://open?reply=http://192.168.1.20:8080/48291/installed",
        "genx://open?reply=http://192.168.1.20:8080/482913/installed&x=1",
        "genx://watch?reply=http://192.168.1.20:8080/482913/installed")) {
      assertNull(refused, TvCheckIn.reply(refused))
    }
    assertEquals("$reply?sha256=${"ab".repeat(32)}", TvCheckIn.report(reply, "ab".repeat(32)))
    assertNull(TvCheckIn.report(reply, "AB".repeat(32)))
    assertNull(TvCheckIn.report(reply, "x"))
  }
}
