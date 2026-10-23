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
