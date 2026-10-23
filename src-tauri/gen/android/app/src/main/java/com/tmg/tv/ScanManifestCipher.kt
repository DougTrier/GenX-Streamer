package com.tmg.tv

import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

internal interface ScanManifestKeys {
  fun sealingKey(): SecretKey
  fun openingKey(): SecretKey?
}

internal enum class ManifestProtectionFailure(val code: String) {
  Invalid("manifest-protection-invalid"),
  KeyUnavailable("manifest-protection-key-unavailable"),
  Authentication("manifest-protection-authentication-failed"),
  Platform("manifest-protection-platform-failed"),
  Busy("manifest-protection-busy")
}

internal class ManifestProtectionException(val failure: ManifestProtectionFailure) :
  Exception(failure.code)

/**
 * Binary, bounded page protection. The key provider is injected for JVM fixtures.
 *
 * Version 2 (sealed now): the Keystore key wraps a fresh random 32-byte page key
 * (AES-GCM, fresh nonce, a short fixed AAD), and the page is AES-GCM sealed in
 * software with that page key, a fresh nonce and the full binding as AAD. The
 * Keystore only ever handles 32 bytes: some keystores (Galaxy S25, Android 17)
 * refuse whole pages with IllegalBlockSizeException. Without the Keystore key no
 * page key can be unwrapped, so key loss still refuses recovery.
 *   "GXMP" | 2 | wrap nonce (12) | wrapped key + tag (48) | page nonce (12) | page + tag
 * Version 1 (older installs): the page sealed directly by the Keystore key;
 * still opened, never written.
 *   "GXMP" | 1 | nonce (12) | page + tag
 */
internal class ScanManifestCipher(private val keys: ScanManifestKeys) {
  companion object {
    const val MAX_PLAINTEXT = 1024 * 1024
    const val MAX_BINDING = 128 * 1024
    /** Version 1 header and tag. */
    const val OVERHEAD = 33
    /** Version 2 header, wrapped page key and tag. */
    const val WRAPPED_OVERHEAD = 5 + 12 + 48 + 12 + 16
    const val MAX_CIPHERTEXT = MAX_PLAINTEXT + WRAPPED_OVERHEAD
    private val MAGIC = byteArrayOf(0x47, 0x58, 0x4d, 0x50)
    private val DOMAIN = "GenX.scan-manifest.v1\u0000".toByteArray(Charsets.UTF_8)
    private val KEY_DOMAIN = "GenX.scan-manifest.page-key.v2\u0000".toByteArray(Charsets.UTF_8)
    /** Data goes through a cipher in pieces of this size (bounded memory per call). */
    const val CHUNK = 16 * 1024
    private val random = java.security.SecureRandom()
  }

  private fun authenticate(cipher: Cipher, aad: ByteArray) {
    var at = 0
    while (at < aad.size) {
      val n = minOf(CHUNK, aad.size - at)
      cipher.updateAAD(aad, at, n)
      at += n
    }
  }

  /** [input] from [from] through the cipher in pieces, into exactly [size] bytes. */
  private fun stream(cipher: Cipher, input: ByteArray, from: Int, size: Int): ByteArray {
    val out = ByteArray(size)
    var written = 0
    fun take(part: ByteArray?) {
      if (part == null || part.isEmpty()) return
      try {
        if (written + part.size > out.size) {
          out.fill(0)
          throw ManifestProtectionException(ManifestProtectionFailure.Platform)
        }
        System.arraycopy(part, 0, out, written, part.size)
        written += part.size
      } finally {
        part.fill(0)
      }
    }
    var at = from
    while (at < input.size) {
      val n = minOf(CHUNK, input.size - at)
      take(cipher.update(input, at, n))
      at += n
    }
    take(cipher.doFinal())
    if (written != out.size) {
      out.fill(0)
      throw ManifestProtectionException(ManifestProtectionFailure.Platform)
    }
    return out
  }

  private fun aad(binding: String): ByteArray {
    if (binding.isEmpty() || binding.length > MAX_BINDING)
      throw ManifestProtectionException(ManifestProtectionFailure.Invalid)
    val encoded = try {
      Charsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(binding))
    } catch (_: Exception) {
      throw ManifestProtectionException(ManifestProtectionFailure.Invalid)
    }
    if (encoded.remaining() > MAX_BINDING)
      throw ManifestProtectionException(ManifestProtectionFailure.Invalid)
    return DOMAIN + ByteArray(encoded.remaining()).also { encoded.get(it) }
  }

  fun seal(binding: String, plaintext: ByteArray): ByteArray {
    if (plaintext.size > MAX_PLAINTEXT)
      throw ManifestProtectionException(ManifestProtectionFailure.Invalid)
    val authenticated = aad(binding)
    val input = plaintext.copyOf()
    val pageKey = ByteArray(32).also { random.nextBytes(it) }
    try {
      val key = keys.sealingKey()
      // The Keystore wraps only the page key; it supplies a fresh IV itself.
      val wrap = Cipher.getInstance("AES/GCM/NoPadding")
      wrap.init(Cipher.ENCRYPT_MODE, key)
      val wrapNonce = wrap.iv
      if (wrapNonce.size != 12) throw ManifestProtectionException(ManifestProtectionFailure.Platform)
      wrap.updateAAD(KEY_DOMAIN)
      val wrapped = wrap.doFinal(pageKey)
      if (wrapped.size != 48) throw ManifestProtectionException(ManifestProtectionFailure.Platform)
      val nonce = ByteArray(12).also { random.nextBytes(it) }
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(pageKey, "AES"), GCMParameterSpec(128, nonce))
      authenticate(cipher, authenticated)
      val encrypted = stream(cipher, input, 0, input.size + 16)
      return ByteBuffer.allocate(5 + 12 + 48 + 12 + encrypted.size).put(MAGIC).put(2.toByte())
        .put(wrapNonce).put(wrapped).put(nonce).put(encrypted).array()
    } catch (failure: ManifestProtectionException) {
      ScanManifestLog.failed("seal", failure.failure.code, failure.cause)
      throw failure
    } catch (error: Exception) {
      ScanManifestLog.failed("seal", ManifestProtectionFailure.Platform.code, error)
      throw ManifestProtectionException(ManifestProtectionFailure.Platform)
    } finally {
      pageKey.fill(0)
      input.fill(0)
      authenticated.fill(0)
    }
  }

  fun open(binding: String, ciphertext: ByteArray): ByteArray {
    val version = if (ciphertext.size >= 5) ciphertext[4].toInt() else 0
    val overhead = when (version) { 1 -> OVERHEAD; 2 -> WRAPPED_OVERHEAD; else -> -1 }
    if (overhead < 0 || ciphertext.size < overhead || ciphertext.size > MAX_CIPHERTEXT ||
      ciphertext.size - overhead > MAX_PLAINTEXT || !ciphertext.copyOfRange(0, 4).contentEquals(MAGIC))
      throw ManifestProtectionException(ManifestProtectionFailure.Invalid)
    val authenticated = aad(binding)
    val input = ciphertext.copyOf()
    var pageKey: ByteArray? = null
    try {
      // Never create or replace a key while opening an existing page.
      val key = keys.openingKey()
        ?: throw ManifestProtectionException(ManifestProtectionFailure.KeyUnavailable)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      val start = if (version == 1) {
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, input.copyOfRange(5, 17)))
        17
      } else {
        val unwrap = Cipher.getInstance("AES/GCM/NoPadding")
        unwrap.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, input.copyOfRange(5, 17)))
        unwrap.updateAAD(KEY_DOMAIN)
        val unwrapped = unwrap.doFinal(input, 17, 48)
        pageKey = unwrapped
        if (unwrapped.size != 32) throw ManifestProtectionException(ManifestProtectionFailure.Authentication)
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(unwrapped, "AES"), GCMParameterSpec(128, input.copyOfRange(65, 77)))
        77
      }
      authenticate(cipher, authenticated)
      return stream(cipher, input, start, input.size - start - 16)
    } catch (failure: ManifestProtectionException) {
      throw failure
    } catch (_: javax.crypto.AEADBadTagException) {
      throw ManifestProtectionException(ManifestProtectionFailure.Authentication)
    } catch (_: java.security.InvalidKeyException) {
      throw ManifestProtectionException(ManifestProtectionFailure.KeyUnavailable)
    } catch (error: Exception) {
      ScanManifestLog.failed("open", ManifestProtectionFailure.Platform.code, error)
      throw ManifestProtectionException(ManifestProtectionFailure.Platform)
    } finally {
      pageKey?.fill(0)
      input.fill(0)
      authenticated.fill(0)
    }
  }
}

/**
 * One line per failed seal/open: the step, GenX's failure code and the
 * platform exception's class only. Never data, bindings, keys or messages.
 */
internal object ScanManifestLog {
  fun failed(step: String, code: String, error: Throwable?) {
    try {
      android.util.Log.w("GenXManifest", "$step failed: $code${error?.let { " (" + it.javaClass.name + ")" } ?: ""}")
    } catch (_: Throwable) {
      // JVM fixtures have no Android log.
    }
  }
}
