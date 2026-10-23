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
