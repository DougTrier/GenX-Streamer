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

/** UI-thread only. Acceptance is not an onDestroy or process-exit acknowledgment. */
internal class ActivityTaskFinish {
  private var accepted = false
  fun request(api:Int, destroyed:()->Boolean, root:()->Boolean, finishing:()->Boolean, finish:()->Unit):Boolean {
    if (accepted) return finishing()
    if (api < 24 || destroyed() || !root() || finishing()) return false
    return try {
      finish()
      // The task may already have been removed; root ownership was checked before the call.
      accepted = finishing()
      accepted
    } catch (_:RuntimeException) { false }
  }
}
