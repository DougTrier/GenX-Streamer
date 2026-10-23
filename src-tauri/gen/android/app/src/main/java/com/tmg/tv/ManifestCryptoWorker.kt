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
