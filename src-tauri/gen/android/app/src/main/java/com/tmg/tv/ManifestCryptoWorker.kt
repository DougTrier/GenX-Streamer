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

import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** One active page plus one bounded handoff slot; further callers are refused. */
internal class ManifestCryptoWorker {
  private val executor = ThreadPoolExecutor(0, 1, 1, TimeUnit.SECONDS,
    ArrayBlockingQueue<Runnable>(1), { task -> Thread(task, "GenXManifestCrypto").apply { isDaemon = true } })

  fun execute(task: () -> Unit): Boolean = try {
    executor.execute { task() }
    true
  } catch (_: java.util.concurrent.RejectedExecutionException) {
    false
  }

  // Shutdown never interrupts actual crypto or fabricates completion.
  fun shutdown() { executor.shutdown() }
  fun awaitTermination(seconds: Long) = executor.awaitTermination(seconds, TimeUnit.SECONDS)
}
