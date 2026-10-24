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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class ManifestCryptoWorkerTest {
  @Test fun oneRealJobOneHandoffSlotAndShutdownWaitsForActualSettlement() {
    val worker = ManifestCryptoWorker()
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val completed = AtomicBoolean(false)
    val secondRan = AtomicBoolean(false)
    val thirdRan = AtomicBoolean(false)
    try {
      assertTrue(worker.execute {
        entered.countDown()
        release.await()
        completed.set(true)
      })
      assertTrue(entered.await(5, TimeUnit.SECONDS))
      assertTrue(worker.execute { secondRan.set(true) })
      assertFalse(secondRan.get())
      assertFalse(worker.execute { thirdRan.set(true) })
      worker.shutdown()
      assertFalse(worker.execute { thirdRan.set(true) })
      assertFalse(worker.awaitTermination(0))
      assertFalse(completed.get())
      release.countDown()
      assertTrue(worker.awaitTermination(5))
      assertTrue(completed.get())
      assertTrue(secondRan.get())
      assertFalse(thirdRan.get())
    } finally {
      release.countDown()
      worker.shutdown()
      assertTrue(worker.awaitTermination(5))
    }
  }
}
