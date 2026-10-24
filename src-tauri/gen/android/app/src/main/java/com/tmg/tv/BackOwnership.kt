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
// One outstanding Back delivery; stale acknowledgments/timers cannot consume another press.
class BackOwnership {
  private var sequence = 0L
  private var pending: String? = null
  fun issue(): String? {
    if (pending != null) return null
    check(sequence < Long.MAX_VALUE) { "back-owner-exhausted" }
    val id = "back-${++sequence}"
    pending = id
    return id
  }
  fun acknowledge(id: String): Boolean {
    if (pending != id) return false
    pending = null
    return true
  }
  fun expire(id: String): Boolean = acknowledge(id)
  fun clear() { pending = null }
}
