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

import java.io.EOFException
import java.io.InputStream
import java.math.BigInteger
import java.security.MessageDigest

/**
 * Send to TV (docs/send-to-tv.md): the messages of the remote service built
 * into Google TV and Android TV (the one the Google TV phone app pairs with),
 * written from its public protocol description: pairing on port 6467, the
 * remote on 6466, protocol buffers framed by a varint length. Only what Send
 * to TV needs: pairing, keeping the session alive, opening a link and
 * hearing which app is in front, and one Home press to wake a TV that says
 * its screen is off (TV-010). Home is the only key GenX ever sends, before any
 * prompt exists; it cannot approve anything (TV-004).
 */
internal object TvWire {
  const val MAX_FRAME = 64 * 1024

  fun varint(value: Long): ByteArray {
    val out = ArrayList<Byte>()
    var rest = value
    while (true) {
      val low = (rest and 0x7F).toInt()
      rest = rest ushr 7
      out.add((if (rest != 0L) low or 0x80 else low).toByte())
      if (rest == 0L) return out.toByteArray()
    }
  }

  fun int(field: Int, value: Long) = varint((field shl 3).toLong()) + varint(value)
  fun bytes(field: Int, data: ByteArray) = varint(((field shl 3) or 2).toLong()) + varint(data.size.toLong()) + data
  fun text(field: Int, value: String) = bytes(field, value.toByteArray(Charsets.UTF_8))
  fun frame(message: ByteArray) = varint(message.size.toLong()) + message

  /** Field number → values (Long for numbers, ByteArray for nested or text); null when malformed. */
  fun parse(data: ByteArray): Map<Int, List<Any>>? {
    val out = LinkedHashMap<Int, MutableList<Any>>()
    var at = 0
    fun next(): Long? {
      var value = 0L
      var shift = 0
      while (at < data.size && shift < 64) {
        val b = data[at++].toInt() and 0xFF
        value = value or ((b and 0x7F).toLong() shl shift)
        if (b and 0x80 == 0) return value
        shift += 7
      }
      return null
    }
    while (at < data.size) {
      val key = next() ?: return null
      val field = (key ushr 3).toInt()
      if (field <= 0) return null
      val value: Any = when ((key and 7).toInt()) {
        0 -> next() ?: return null
        1 -> { if (at + 8 > data.size) return null; data.copyOfRange(at, at + 8).also { at += 8 } }
        2 -> {
          val length = next() ?: return null
          if (length < 0 || length > data.size - at) return null
          data.copyOfRange(at, at + length.toInt()).also { at += length.toInt() }
        }
        5 -> { if (at + 4 > data.size) return null; data.copyOfRange(at, at + 4).also { at += 4 } }
        else -> return null
      }
      out.getOrPut(field) { mutableListOf() }.add(value)
    }
    return out
  }

  fun number(message: Map<Int, List<Any>>?, field: Int): Long? = message?.get(field)?.firstOrNull() as? Long
  fun nested(message: Map<Int, List<Any>>?, field: Int): Map<Int, List<Any>>? =
    (message?.get(field)?.firstOrNull() as? ByteArray)?.let(::parse)
  fun string(message: Map<Int, List<Any>>?, field: Int): String? =
    (message?.get(field)?.firstOrNull() as? ByteArray)?.toString(Charsets.UTF_8)

  /** One framed message; EOFException at the end, IllegalStateException when too big. */
  fun readFrame(input: InputStream): ByteArray {
    var length = 0L
    var shift = 0
    while (true) {
      val b = input.read()
      if (b < 0) throw EOFException()
      length = length or ((b and 0x7F).toLong() shl shift)
      if (b and 0x80 == 0) break
      shift += 7
      if (shift > 28) throw IllegalStateException("tv-protocol")
    }
    if (length > MAX_FRAME) throw IllegalStateException("tv-protocol")
    val data = ByteArray(length.toInt())
    var read = 0
    while (read < data.size) {
      val n = input.read(data, read, data.size - read)
      if (n < 0) throw EOFException()
      read += n
    }
    return data
  }
}

/** Pairing (port 6467): the TV shows a six-character code that the person types into GenX. */
internal object TvPairing {
  const val OK = 200L
  private const val VERSION = 2L
  private val hexSix = TvWire.int(1, 3) + TvWire.int(2, 6)

  private fun outer(field: Int, payload: ByteArray) =
    TvWire.int(1, VERSION) + TvWire.int(2, OK) + TvWire.bytes(field, payload)

  fun request(client: String) = outer(10, TvWire.text(1, "atvremote") + TvWire.text(2, client))
  /** Hexadecimal, six symbols, GenX types it in (input role). */
  fun options() = outer(20, TvWire.bytes(1, hexSix) + TvWire.int(3, 1))
  fun configuration() = outer(30, TvWire.bytes(1, hexSix) + TvWire.int(2, 1))
  fun secret(hash: ByteArray) = outer(40, TvWire.bytes(1, hash))

  /** A reply with status 200 that carries `field` (11 request ack, 20 options, 31 configuration ack, 41 secret ack). */
  fun accepted(reply: ByteArray, field: Int): Boolean {
    val message = TvWire.parse(reply) ?: return false
    return TvWire.number(message, 2) == OK && message.containsKey(field)
  }

  /** Six hexadecimal digits as typed (spaces and case ignored), or null. */
  fun code(typed: String): String? =
    typed.filterNot { it.isWhitespace() }.uppercase().takeIf { Regex("[0-9A-F]{6}").matches(it) }

  /** A number's bytes, big-endian, without a sign byte. */
  fun unsigned(value: BigInteger): ByteArray {
    val bytes = value.toByteArray()
    return if (bytes.size > 1 && bytes[0] == 0.toByte()) bytes.copyOfRange(1, bytes.size) else bytes
  }

  /**
   * The pairing secret: SHA-256 over both public keys (modulus, exponent;
   * GenX's first) and the code's last four digits. The code's first two
   * digits are the hash's first byte, so a mistyped code is caught here (null).
   */
  fun secretHash(
    clientModulus: BigInteger, clientExponent: BigInteger,
    serverModulus: BigInteger, serverExponent: BigInteger, typed: String,
  ): ByteArray? {
    val code = code(typed) ?: return null
    val digest = MessageDigest.getInstance("SHA-256")
    for (part in listOf(clientModulus, clientExponent, serverModulus, serverExponent)) digest.update(unsigned(part))
    digest.update(ByteArray(2) { i -> code.substring(2 + 2 * i, 4 + 2 * i).toInt(16).toByte() })
    val hash = digest.digest()
    return if ((hash[0].toInt() and 0xFF) == code.substring(0, 2).toInt(16)) hash else null
  }
}

/** What the TV says on the remote connection (port 6466). */
internal sealed class TvEvent {
  data class Configure(val model: String, val vendor: String) : TvEvent()
  object SetActive : TvEvent()
  data class Ping(val value: Long) : TvEvent()
  /** The app now in front of the TV (its package name). */
  data class FrontApp(val app: String) : TvEvent()
  /** Whether the TV's screen is on (off: asleep, HDMI shows no signal). */
  data class Screen(val on: Boolean) : TvEvent()
  object Other : TvEvent()
}

internal object TvRemote {
  private const val FEATURES = 622L

  fun configureReply(version: String): ByteArray {
    val device = TvWire.text(1, "GenX Streamer") + TvWire.text(2, "GenX") + TvWire.int(3, 1) +
      TvWire.text(4, "1") + TvWire.text(5, "com.tmg.tv") + TvWire.text(6, version)
    return TvWire.bytes(1, TvWire.int(1, FEATURES) + TvWire.bytes(2, device))
  }
  fun setActiveReply() = TvWire.bytes(2, TvWire.int(1, FEATURES))
  fun pingReply(value: Long) = TvWire.bytes(9, TvWire.int(1, value))
  fun openLink(link: String) = TvWire.bytes(90, TvWire.text(1, link))
  /** KEYCODE_HOME, one short press: sent only to a TV that reports its screen off (TV-010). */
  fun home() = TvWire.bytes(10, TvWire.int(1, 3) + TvWire.int(2, 3))

  fun read(data: ByteArray): TvEvent {
    val message = TvWire.parse(data) ?: return TvEvent.Other
    TvWire.nested(message, 1)?.let { configure ->
      val device = TvWire.nested(configure, 2)
      return TvEvent.Configure(
        TvWire.string(device, 1)?.take(80) ?: "", TvWire.string(device, 2)?.take(80) ?: "")
    }
    if (message.containsKey(2)) return TvEvent.SetActive
    if (message.containsKey(8)) return TvEvent.Ping(TvWire.number(TvWire.nested(message, 8), 1) ?: 0)
    if (message.containsKey(40)) return TvEvent.Screen(TvWire.number(TvWire.nested(message, 40), 1) == 1L)
    TvWire.nested(message, 20)?.let { ime ->
      val app = TvWire.string(TvWire.nested(ime, 1), 12)
      if (app != null && Regex("[A-Za-z0-9_.]{1,200}").matches(app)) return TvEvent.FrontApp(app)
    }
    return TvEvent.Other
  }
}

/**
 * The only links GenX opens on a TV (TV-007): its own file on this phone's
 * nearby share, the Play Store page of Downloader (for TVs with no app to
 * download with), and GenX itself with the address to report back to (TV-006).
 */
internal object TvLinks {
  const val DOWNLOADER_STORE = "market://details?id=com.esaba.downloader"
  const val OPEN_GENX = "genx://open?reply="
  private val nearby = Regex("""http://(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}/\d{6}/GenX-Streamer\.apk""")

  fun allowed(link: String) = link == DOWNLOADER_STORE || nearby.matches(link) || TvCheckIn.reply(link) != null
}

/**
 * The installed check (TV-006), on the TV: genx://open?reply=<phone's nearby
 * address>/installed opens GenX, which then tells that address the SHA-256 of
 * its own installed file. The phone says "installed" only when it matches the
 * file it sent, so an older copy that opens instead is never taken for it.
 * Only a private address with the nearby share's shape is ever contacted.
 */
internal object TvCheckIn {
  private val shape = Regex("""genx://open\?reply=(http://((?:\d{1,3}\.){3}\d{1,3}):\d{1,5}/\d{6}/installed)""")

  fun reply(link: String?): String? {
    val match = shape.matchEntire(link ?: return null) ?: return null
    return if (TvAddress.local(match.groupValues[2])) match.groupValues[1] else null
  }

  fun report(reply: String, sha256: String): String? =
    if (Regex("[0-9a-f]{64}").matches(sha256)) "$reply?sha256=$sha256" else null
}
