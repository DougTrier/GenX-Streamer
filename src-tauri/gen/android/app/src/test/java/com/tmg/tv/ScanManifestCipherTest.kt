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
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class ScanManifestCipherTest {
  private class FixtureKeys : ScanManifestKeys {
    var key: SecretKey? = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    var sealReads = 0
    var openReads = 0
    override fun sealingKey(): SecretKey { sealReads++; return key!! }
    override fun openingKey(): SecretKey? { openReads++; return key }
  }
  private val binding = "{\"namespace\":\"fixture-store\",\"job\":\"job1\",\"page\":0,\"digest\":\"abc\"}"

  private fun refused(expected: ManifestProtectionFailure, action: () -> Unit) {
    val error = assertThrows(ManifestProtectionException::class.java) { action() }
    assertEquals(expected, error.failure)
    assertEquals(expected.code, error.message)
    assertNull(error.cause)
  }

  @Test fun roundTripUsesDifferentNoncesAndOwnsCallerBytes() {
    val keys = FixtureKeys()
    val cipher = ScanManifestCipher(keys)
    val original = "fixture-url-page".toByteArray()
    val input = original.copyOf()
    val first = cipher.seal(binding, input)
    input.fill(0)
    val second = cipher.seal(binding, original)
    assertFalse(first.copyOfRange(5, 17).contentEquals(second.copyOfRange(5, 17)))
    assertEquals(original.size + ScanManifestCipher.WRAPPED_OVERHEAD, first.size)
    assertEquals(2, first[4].toInt())
    assertArrayEquals(original, cipher.open(binding, first))
    assertArrayEquals(original, cipher.open(binding, second))
  }

  @Test fun tagTamperAndSwappedBindingRefuseWithoutPlaintext() {
    val cipher = ScanManifestCipher(FixtureKeys())
    val encrypted = cipher.seal(binding, "private fixture".toByteArray())
    val changed = encrypted.copyOf().apply { this[lastIndex] = (this[lastIndex].toInt() xor 1).toByte() }
    refused(ManifestProtectionFailure.Authentication) { cipher.open(binding, changed) }
    refused(ManifestProtectionFailure.Authentication) { cipher.open(binding.replace("job1", "job2"), encrypted) }
    refused(ManifestProtectionFailure.Authentication) { cipher.open(binding.replace("page\":0", "page\":1"), encrypted) }
  }

  @Test fun missingKeyDoesNotGenerateReplacementAndDifferentInstallationKeyRefuses() {
    val keys = FixtureKeys()
    val cipher = ScanManifestCipher(keys)
    val encrypted = cipher.seal(binding, byteArrayOf(1, 2, 3))
    keys.key = null
    refused(ManifestProtectionFailure.KeyUnavailable) { cipher.open(binding, encrypted) }
    assertEquals(1, keys.sealReads)
    assertEquals(1, keys.openReads)
    refused(ManifestProtectionFailure.Authentication) { ScanManifestCipher(FixtureKeys()).open(binding, encrypted) }
  }

  @Test fun oneMiBPageAndBindingBoundaryAreExact() {
    val cipher = ScanManifestCipher(FixtureKeys())
    val input = ByteArray(ScanManifestCipher.MAX_PLAINTEXT) { (it % 251).toByte() }
    val bindingAtLimit = "a".repeat(ScanManifestCipher.MAX_BINDING)
    val encrypted = cipher.seal(bindingAtLimit, input)
    assertEquals(ScanManifestCipher.MAX_CIPHERTEXT, encrypted.size)
    assertArrayEquals(input, cipher.open(bindingAtLimit, encrypted))
    refused(ManifestProtectionFailure.Invalid) { cipher.seal(binding, ByteArray(input.size + 1)) }
    refused(ManifestProtectionFailure.Invalid) { cipher.seal(bindingAtLimit + "a", byteArrayOf(1)) }
    refused(ManifestProtectionFailure.Invalid) { cipher.seal("\u00e9".repeat(ScanManifestCipher.MAX_BINDING), byteArrayOf(1)) }
  }

  @Test fun malformedEnvelopeAndSurrogateRefuseBeforeKeyAccess() {
    val keys = FixtureKeys()
    val cipher = ScanManifestCipher(keys)
    refused(ManifestProtectionFailure.Invalid) { cipher.open(binding, ByteArray(32)) }
    refused(ManifestProtectionFailure.Invalid) { cipher.open(binding, ByteArray(ScanManifestCipher.MAX_CIPHERTEXT + 1)) }
    refused(ManifestProtectionFailure.Invalid) { cipher.seal("\ud800", byteArrayOf(1)) }
    refused(ManifestProtectionFailure.Invalid) { cipher.seal("", byteArrayOf(1)) }
    assertEquals(0, keys.sealReads)
    assertEquals(0, keys.openReads)
    val valid = cipher.seal(binding, byteArrayOf(1))
    for (index in listOf(0, 4)) {
      val bad = valid.copyOf().apply { this[index] = (this[index].toInt() xor 1).toByte() }
      refused(ManifestProtectionFailure.Invalid) { cipher.open(binding, bad) }
    }
    assertEquals(0, keys.openReads)
  }

  /** The bytes GenX authenticates for a binding (domain + UTF-8 binding). */
  private fun aad(binding: String) = "GenX.scan-manifest.v1\u0000".toByteArray() + binding.toByteArray()

  @Test fun versionTwoPageIsAWrappedKeyAndAOrdinaryGcmPage() {
    val keys = FixtureKeys()
    val page = ByteArray(ScanManifestCipher.MAX_PLAINTEXT) { (it * 31).toByte() }
    val sealed = ScanManifestCipher(keys).seal(binding, page)
    // The installation key opens only the 32-byte page key...
    val pageKey = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(javax.crypto.Cipher.DECRYPT_MODE, keys.key, javax.crypto.spec.GCMParameterSpec(128, sealed.copyOfRange(5, 17)))
      updateAAD("GenX.scan-manifest.page-key.v2\u0000".toByteArray())
    }.doFinal(sealed, 17, 48)
    assertEquals(32, pageKey.size)
    // ...and that key opens the page in one ordinary GCM call, bound to the binding.
    val plain = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(javax.crypto.Cipher.DECRYPT_MODE, javax.crypto.spec.SecretKeySpec(pageKey, "AES"),
        javax.crypto.spec.GCMParameterSpec(128, sealed.copyOfRange(65, 77)))
      updateAAD(aad(binding))
    }.doFinal(sealed, 77, sealed.size - 77)
    assertArrayEquals(page, plain)
  }

  @Test fun tamperedWrappedKeyOrForeignInstallationRefuses() {
    val keys = FixtureKeys()
    val sealed = ScanManifestCipher(keys).seal(binding, "private fixture".toByteArray())
    for (index in listOf(20, 60, 70)) {
      val bad = sealed.copyOf().apply { this[index] = (this[index].toInt() xor 1).toByte() }
      refused(ManifestProtectionFailure.Authentication) { ScanManifestCipher(keys).open(binding, bad) }
    }
    refused(ManifestProtectionFailure.Authentication) { ScanManifestCipher(FixtureKeys()).open(binding, sealed) }
  }

  @Test fun pagesSealedInOneCallStillOpen() {
    val keys = FixtureKeys()
    val page = ByteArray(300_000) { (it % 251).toByte() }
    val oneCall = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(javax.crypto.Cipher.ENCRYPT_MODE, keys.key)
      updateAAD(aad(binding))
    }
    val encrypted = oneCall.doFinal(page)
    val stored = byteArrayOf(0x47, 0x58, 0x4d, 0x50, 1) + oneCall.iv + encrypted
    assertArrayEquals(page, ScanManifestCipher(keys).open(binding, stored))
  }
}
