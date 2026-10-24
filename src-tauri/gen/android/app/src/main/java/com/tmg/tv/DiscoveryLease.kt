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

/** Called only on the Activity UI thread; callbacks own the actual platform lock. */
internal class DiscoveryLease(private val acquire: () -> Unit, private val release: () -> Unit) {
  private val owners = mutableSetOf<String>()

  fun begin(id: String, foreground: Boolean) {
    if (!foreground) throw IllegalStateException("cast-discovery-background")
    if (id.isEmpty() || id.length > 64) throw IllegalStateException("cast-discovery-invalid-owner")
    if (owners.contains(id)) return
    if (owners.size >= 4) throw IllegalStateException("cast-discovery-busy")
    if (owners.isEmpty()) acquire()
    owners.add(id)
  }

  fun end(id: String) {
    if (!owners.contains(id)) return
    if (owners.size == 1) release()
    owners.remove(id)
  }

  fun cancel() {
    if (owners.isEmpty()) return
    // Retain ownership if the platform refuses release, so cleanup can retry.
    release()
    owners.clear()
  }
}
