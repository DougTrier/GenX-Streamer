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
