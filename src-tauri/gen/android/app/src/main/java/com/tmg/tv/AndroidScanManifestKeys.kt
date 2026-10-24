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

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** Installation-local nonexportable key; no file, preference or backup key copy. */
internal class AndroidScanManifestKeys : ScanManifestKeys {
  companion object {
    private const val ALIAS = "genx.scan-manifest.aes-gcm.v1"
    private const val PROVIDER = "AndroidKeyStore"
    private val KEY_LOCK = Any()
  }

  private fun store() = KeyStore.getInstance(PROVIDER).apply { load(null) }

  override fun sealingKey(): SecretKey = synchronized(KEY_LOCK) {
    try {
      val store = store()
      if (store.containsAlias(ALIAS)) return@synchronized store.getKey(ALIAS, null) as? SecretKey
        ?: throw ManifestProtectionException(ManifestProtectionFailure.KeyUnavailable)
      val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
      generator.init(KeyGenParameterSpec.Builder(ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256).setRandomizedEncryptionRequired(true)
        .setUserAuthenticationRequired(false).build())
      return@synchronized generator.generateKey()
    } catch (failure: ManifestProtectionException) {
      throw failure
    } catch (error: Exception) {
      ScanManifestLog.failed("key", ManifestProtectionFailure.KeyUnavailable.code, error)
      throw ManifestProtectionException(ManifestProtectionFailure.KeyUnavailable)
    }
  }

  override fun openingKey(): SecretKey? = synchronized(KEY_LOCK) {
    try {
      val store = store()
      if (!store.containsAlias(ALIAS)) return@synchronized null
      return@synchronized store.getKey(ALIAS, null) as? SecretKey
        ?: throw ManifestProtectionException(ManifestProtectionFailure.KeyUnavailable)
    } catch (failure: ManifestProtectionException) {
      throw failure
    } catch (_: Exception) {
      throw ManifestProtectionException(ManifestProtectionFailure.KeyUnavailable)
    }
  }
}
