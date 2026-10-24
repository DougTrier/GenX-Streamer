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
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
class UpdateRulesTest {
  @get:Rule val folder = TemporaryFolder()
  private val ours = setOf("a1")

  @Test fun onlyANewerBuildOfThisAppWithThisCopysSignatureIsOffered() {
    assertNull(UpdateRules.refusal("com.tmg.tv", "com.tmg.tv", 1, 2, ours, ours))
    assertEquals("update-not-an-app", UpdateRules.refusal("com.tmg.tv", null, 1, 2, ours, ours))
    assertEquals("update-wrong-app", UpdateRules.refusal("com.tmg.tv", "com.other", 1, 2, ours, ours))
    assertEquals("update-signature-mismatch", UpdateRules.refusal("com.tmg.tv", "com.tmg.tv", 1, 2, ours, setOf("b2")))
    assertEquals("update-signature-mismatch", UpdateRules.refusal("com.tmg.tv", "com.tmg.tv", 1, 2, ours, setOf("a1", "b2")))
    assertEquals("update-unverifiable", UpdateRules.refusal("com.tmg.tv", "com.tmg.tv", 1, 2, ours, emptySet()))
    assertEquals("update-not-newer", UpdateRules.refusal("com.tmg.tv", "com.tmg.tv", 2, 2, ours, ours))
    assertEquals("update-not-newer", UpdateRules.refusal("com.tmg.tv", "com.tmg.tv", 3, 2, ours, ours))
  }

  @Test fun onlyGenXsOwnDownloadedApkIsOpened() {
    val cache = folder.newFolder("cache")
    val updates = File(cache, "updates").apply { mkdirs() }
    val apk = File(updates, "GenX-Streamer-1.1.0-Android-arm64.apk").apply { writeText("x") }
    assertEquals(apk.canonicalFile, UpdateRules.ownFile(cache, apk.path))
    assertNull(UpdateRules.ownFile(cache, File(updates, "missing.apk").path))
    assertNull(UpdateRules.ownFile(cache, File(updates, "note.txt").apply { writeText("x") }.path))
    assertNull(UpdateRules.ownFile(cache, File(cache, "other.apk").apply { writeText("x") }.path))
    assertNull(UpdateRules.ownFile(cache, File(updates, "../other.apk").path))
  }

  @Test fun certificateDigestsAreSha256Hex() {
    assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", UpdateRules.digest("abc".toByteArray()))
  }
}
