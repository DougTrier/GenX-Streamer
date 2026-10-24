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

import android.app.Activity
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.security.cert.X509Certificate
import java.security.interfaces.RSAPublicKey
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLSocket

@InvokeArg
class TvHostArgs { var host: String = ""; var name: String = "" }

@InvokeArg
class TvCodeArgs { var code: String = "" }

@InvokeArg
class TvLinkArgs { var link: String = "" }

/** A private IPv4 address on this network, as a TV's address must be. */
internal object TvAddress {
  fun local(host: String): Boolean {
    val parts = host.split('.').map { it.toIntOrNull() ?: return false }
    if (parts.size != 4 || parts.any { it !in 0..255 } || host != parts.joinToString(".")) return false
    val (a, b) = parts
    return a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168)
  }
}

/**
 * Send to TV (docs/send-to-tv.md): finds TVs with the built-in remote
 * service, pairs with the code the TV shows, then opens GenX's nearby file
 * address on the TV and reports which app is in front, so the page can tell
 * the person what to do next. It never presses anything on the TV.
 */
@TauriPlugin
class TvRemotePlugin(private val activity: Activity) : Plugin(activity) {
  private val worker = Executors.newSingleThreadExecutor()
  private val identity by lazy { TvRemoteIdentity(activity) }
  private var pairing: Pair<SSLSocket, PairedTv>? = null
  @Volatile private var session: TvRemoteSession? = null

  private fun version() = try {
    activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: "0"
  } catch (_: Exception) { "0" }

  private fun work(invoke: Invoke, failure: String, block: () -> Unit) = worker.execute {
    try { block() } catch (error: Exception) {
      val code = error.message?.takeIf { it.startsWith("tv-") && it.length <= 40 } ?: failure
      invoke.reject(code)
    }
  }

  private fun connect(host: String, port: Int, pinned: Set<String>?): SSLSocket {
    if (!TvAddress.local(host)) throw IllegalStateException("tv-address")
    val socket = identity.tls(pinned).socketFactory.createSocket() as SSLSocket
    try {
      socket.connect(InetSocketAddress(host, port), 8000)
      socket.soTimeout = 10_000
      socket.startHandshake()
    } catch (error: Exception) {
      socket.close()
      throw error
    }
    return socket
  }

  /** The TVs on this Wi-Fi that offer the remote service (about four seconds). */
  @Command
  fun tvFind(invoke: Invoke) = work(invoke, "tv-find-failed") {
    val nsd = activity.getSystemService(NsdManager::class.java) ?: throw IllegalStateException("tv-find-failed")
    val found = java.util.Collections.synchronizedList(mutableListOf<NsdServiceInfo>())
    val listener = object : NsdManager.DiscoveryListener {
      override fun onServiceFound(info: NsdServiceInfo) { if (found.size < 16) found.add(info) }
      override fun onServiceLost(info: NsdServiceInfo) {}
      override fun onDiscoveryStarted(type: String) {}
      override fun onDiscoveryStopped(type: String) {}
      override fun onStartDiscoveryFailed(type: String, code: Int) {}
      override fun onStopDiscoveryFailed(type: String, code: Int) {}
    }
    // Bounded: about four seconds to listen and ten in all, however many TVs answer.
    val deadline = System.currentTimeMillis() + 10_000
    nsd.discoverServices("_androidtvremote2._tcp", NsdManager.PROTOCOL_DNS_SD, listener)
    Thread.sleep(4000)
    try { nsd.stopServiceDiscovery(listener) } catch (_: Exception) {}
    val tvs = mutableListOf<Map<String, Any>>()
    for (info in found.toList().distinctBy { it.serviceName }) {
      if (System.currentTimeMillis() > deadline - 500) break
      val resolved = resolve(nsd, info, minOf(3000L, deadline - System.currentTimeMillis())) ?: continue
      val host = address(resolved) ?: continue
      if (tvs.none { it["host"] == host }) tvs.add(mapOf("name" to resolved.serviceName.take(80), "host" to host))
    }
    invoke.resolveObject(mapOf("tvs" to tvs))
  }

  @Suppress("DEPRECATION")
  private fun resolve(nsd: NsdManager, info: NsdServiceInfo, waitMs: Long): NsdServiceInfo? {
    val done = CountDownLatch(1)
    var result: NsdServiceInfo? = null
    nsd.resolveService(info, object : NsdManager.ResolveListener {
      override fun onServiceResolved(resolved: NsdServiceInfo) { result = resolved; done.countDown() }
      override fun onResolveFailed(failed: NsdServiceInfo, code: Int) { done.countDown() }
    })
    done.await(waitMs.coerceAtLeast(1), TimeUnit.MILLISECONDS)
    return result
  }

  @Suppress("DEPRECATION")
  private fun address(info: NsdServiceInfo): String? {
    val addresses = if (Build.VERSION.SDK_INT >= 34) info.hostAddresses else listOfNotNull(info.host)
    return addresses.filterIsInstance<Inet4Address>().map { it.hostAddress ?: "" }.firstOrNull(TvAddress::local)
  }

  /** Starts pairing: the TV then shows a code (SH-026). */
  @Command
  fun tvPairStart(invoke: Invoke) {
    val args = invoke.parseArgs(TvHostArgs::class.java)
    work(invoke, "tv-pair-failed") {
      pairing?.first?.close()
      pairing = null
      val socket = connect(args.host, 6467, null)
      try {
        fun step(message: ByteArray, field: Int) {
          socket.outputStream.write(TvWire.frame(message)); socket.outputStream.flush()
          if (!TvPairing.accepted(TvWire.readFrame(socket.inputStream), field)) throw IllegalStateException("tv-pair-refused")
        }
        step(TvPairing.request("GenX Streamer"), 11)
        step(TvPairing.options(), 20)
        step(TvPairing.configuration(), 31)
      } catch (error: Exception) { socket.close(); throw error }
      // The person reads the code off the TV; the TV waits about a minute.
      socket.soTimeout = 60_000
      val tv = socket.session.peerCertificates.first() as X509Certificate
      pairing = socket to PairedTv(PairedTvs.fingerprint(tv), args.name.take(80))
      invoke.resolveObject(mapOf("codeShown" to true))
    }
  }

  /** Finishes pairing with the code the person typed. A wrong code is refused here or by the TV. */
  @Command
  fun tvPairFinish(invoke: Invoke) {
    val args = invoke.parseArgs(TvCodeArgs::class.java)
    work(invoke, "tv-pair-failed") {
      val (socket, tv) = pairing ?: throw IllegalStateException("tv-pair-expired")
      val server = socket.session.peerCertificates.first().publicKey as RSAPublicKey
      val client = identity.publicKey()
      val hash = TvPairing.secretHash(client.modulus, client.publicExponent, server.modulus, server.publicExponent, args.code)
        ?: throw IllegalStateException("tv-pair-wrong-code")
      try {
        socket.outputStream.write(TvWire.frame(TvPairing.secret(hash))); socket.outputStream.flush()
        if (!TvPairing.accepted(TvWire.readFrame(socket.inputStream), 41)) throw IllegalStateException("tv-pair-wrong-code")
      } finally {
        socket.close()
        pairing = null
      }
      identity.remember(tv)
      invoke.resolveObject(mapOf("paired" to true))
    }
  }

  /** Connects to a paired TV; "tv-not-paired" when it does not know this phone (or is another device). */
  @Command
  fun tvConnect(invoke: Invoke) {
    val args = invoke.parseArgs(TvHostArgs::class.java)
    work(invoke, "tv-connect-failed") {
      session?.close()
      val pinned = identity.paired().map { it.fingerprint }.toSet()
      if (pinned.isEmpty()) throw IllegalStateException("tv-not-paired")
      val socket = try { connect(args.host, 6466, pinned) } catch (error: javax.net.ssl.SSLException) {
        throw IllegalStateException("tv-not-paired")
      }
      // The TV pings about every five seconds; silence for 30 means it is gone.
      socket.soTimeout = 30_000
      val connected = TvRemoteSession(socket.inputStream, socket.outputStream, version()) { socket.close() }
      session = connected
      Thread(connected::run, "send-to-tv").apply { isDaemon = true }.start()
      val deadline = System.currentTimeMillis() + 6000
      while (!connected.ready && connected.open && System.currentTimeMillis() < deadline) Thread.sleep(50)
      if (!connected.ready) { connected.close(); throw IllegalStateException("tv-connect-failed") }
      // Wake the TV (asleep: HDMI shows no signal; or in its screensaver) with one
      // Home press, then wait for its screen, so the person sees every step.
      connected.send(TvRemote.home())
      val awake = System.currentTimeMillis() + 5000
      while (connected.screenOn != true && connected.open && System.currentTimeMillis() < awake) Thread.sleep(50)
      invoke.resolveObject(status(connected))
    }
  }

  private fun status(current: TvRemoteSession?) = mapOf(
    "connected" to (current?.open == true && current.ready),
    "model" to (current?.model ?: ""),
    "frontApp" to (current?.front ?: ""),
    "changes" to (current?.changes ?: 0))

  /** Opens one of the links GenX may open on a TV (TvLinks). */
  @Command
  fun tvOpen(invoke: Invoke) {
    val args = invoke.parseArgs(TvLinkArgs::class.java)
    work(invoke, "tv-connect-failed") {
      if (!TvLinks.allowed(args.link)) throw IllegalStateException("tv-link-refused")
      val current = session?.takeIf { it.open && it.ready } ?: throw IllegalStateException("tv-disconnected")
      current.send(TvRemote.openLink(args.link))
      invoke.resolveObject(status(current))
    }
  }

  @Command
  fun tvStatus(invoke: Invoke) { invoke.resolveObject(status(session)) }

  @Command
  fun tvDisconnect(invoke: Invoke) {
    session?.close()
    session = null
    invoke.resolve()
  }

  /** Forgets this phone's TV key and every paired TV (each TV then asks to pair again). */
  @Command
  fun tvForget(invoke: Invoke) = work(invoke, "tv-forget-failed") {
    session?.close()
    session = null
    identity.forget()
    invoke.resolve()
  }

  override fun onDestroy() {
    session?.close()
    pairing?.first?.close()
    worker.shutdownNow()
    super.onDestroy()
  }
}
