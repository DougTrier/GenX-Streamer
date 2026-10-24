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

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.math.BigInteger
import java.net.Socket
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Calendar
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.X509ExtendedTrustManager
import javax.security.auth.x500.X500Principal

/** A TV this phone paired with: its name and its certificate's SHA-256 (SH-026, SH-029). */
internal data class PairedTv(val fingerprint: String, val name: String)

/** The paired TVs as stored: one "fingerprint name" line each, bounded. */
internal object PairedTvs {
  const val MAX = 16
  fun decode(stored: String?): List<PairedTv> = stored.orEmpty().lineSequence().mapNotNull { line ->
    val fingerprint = line.substringBefore(' ')
    if (!Regex("[0-9a-f]{64}").matches(fingerprint)) null
    else PairedTv(fingerprint, line.substringAfter(' ', "").take(80))
  }.take(MAX).toList()
  fun encode(tvs: List<PairedTv>) = tvs.takeLast(MAX).joinToString("\n") { "${it.fingerprint} ${it.name.replace('\n', ' ')}" }
  fun add(tvs: List<PairedTv>, tv: PairedTv) = tvs.filterNot { it.fingerprint == tv.fingerprint } + tv
  fun fingerprint(certificate: X509Certificate): String =
    MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it) }
}

/**
 * GenX's own remote identity: an RSA key in Android Keystore (never leaves
 * the device) with its self-signed certificate, which the TV remembers when
 * the person pairs. Forget removes the key and every paired TV.
 */
internal class TvRemoteIdentity(context: Context) {
  private val preferences = context.getSharedPreferences("send-to-tv", Context.MODE_PRIVATE)
  private val keys = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  private companion object {
    const val KEYSTORE = "AndroidKeyStore"
    const val ALIAS = "genx-send-to-tv"
    const val PAIRED = "paired"
  }

  fun paired(): List<PairedTv> = PairedTvs.decode(preferences.getString(PAIRED, null))

  fun remember(tv: PairedTv) {
    preferences.edit().putString(PAIRED, PairedTvs.encode(PairedTvs.add(paired(), tv))).apply()
  }

  fun forget() {
    preferences.edit().remove(PAIRED).apply()
    if (keys.containsAlias(ALIAS)) keys.deleteEntry(ALIAS)
  }

  private fun certificate(): X509Certificate {
    if (!keys.containsAlias(ALIAS)) {
      val until = Calendar.getInstance().apply { add(Calendar.YEAR, 20) }.time
      val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
        .setKeySize(2048)
        .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256,
          KeyProperties.DIGEST_SHA384, KeyProperties.DIGEST_SHA512)
        .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1, KeyProperties.SIGNATURE_PADDING_RSA_PSS)
        .setCertificateSubject(X500Principal("CN=GenX Streamer"))
        .setCertificateSerialNumber(BigInteger.ONE)
        .setCertificateNotAfter(until)
        .build()
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, KEYSTORE).apply { initialize(spec) }.generateKeyPair()
    }
    return keys.getCertificate(ALIAS) as X509Certificate
  }

  /** GenX's public key, for the pairing secret. */
  fun publicKey(): java.security.interfaces.RSAPublicKey = certificate().publicKey as java.security.interfaces.RSAPublicKey

  /**
   * TLS presenting GenX's certificate. Pairing accepts any TV certificate
   * (the code binds both keys); the remote accepts only a paired TV's
   * (`pinned`), so another device at the TV's address is refused.
   */
  fun tls(pinned: Set<String>?): SSLContext {
    val certificate = certificate()
    val key = keys.getKey(ALIAS, null) as PrivateKey
    val keyManager = object : X509ExtendedKeyManager() {
      override fun chooseClientAlias(types: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?) = ALIAS
      override fun chooseEngineClientAlias(types: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?) = ALIAS
      override fun getCertificateChain(alias: String?) = arrayOf(certificate)
      override fun getPrivateKey(alias: String?) = key
      override fun getClientAliases(type: String?, issuers: Array<out Principal>?) = arrayOf(ALIAS)
      override fun getServerAliases(type: String?, issuers: Array<out Principal>?): Array<String>? = null
      override fun chooseServerAlias(type: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
    }
    val trustManager = object : X509ExtendedTrustManager() {
      private fun check(chain: Array<out X509Certificate>?) {
        val tv = chain?.firstOrNull() ?: throw CertificateException("tv-not-paired")
        if (pinned != null && PairedTvs.fingerprint(tv) !in pinned) throw CertificateException("tv-not-paired")
      }
      override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = check(chain)
      override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) = check(chain)
      override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) = check(chain)
      override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException()
      override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) = throw CertificateException()
      override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) = throw CertificateException()
      override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
    return SSLContext.getInstance("TLS").apply { init(arrayOf(keyManager), arrayOf(trustManager), null) }
  }
}
