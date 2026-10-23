package com.tmg.tv

/** Activity lifecycle authority; process callbacks may only request a guarded replay. */
internal class ViewingLifecycleOwner {
  data class Ticket(val generation: Long, val sequence: Long, val foreground: Boolean)
  private var generation = 0L
  private var sequence = 0L
  private var resumed = false
  private var closed = false
  private var delivered = false
  private var backgroundSent = false
  private var pending: Ticket? = null
  private fun advance(): Boolean {
    pending = null
    if (generation == LIMIT) { closed = true; resumed = false; return false }
    generation++
    return !closed
  }
  private fun issue(foreground: Boolean): Ticket? {
    if (sequence == LIMIT) { closed = true; resumed = false; return null }
    return Ticket(generation, ++sequence, foreground)
  }
  fun resume() {
    if (!advance()) return
    resumed = true; delivered = false; backgroundSent = false
  }
  fun pause(): Ticket? {
    advance(); resumed = false; delivered = false
    if (closed || backgroundSent) return null
    backgroundSent = true
    return issue(false)
  }
  fun destroy(): Ticket? {
    val background = pause()
    closed = true
    return background
  }
  fun rebind() { if (advance()) delivered = false }
  fun cancelReplay() { pending = null }
  fun request(eligible: Boolean): Ticket? {
    if (closed || !resumed || !eligible || delivered || pending != null) return null
    return issue(true)?.also { pending = it }
  }
  fun complete(ticket: Ticket, eligible: Boolean, dispatch: (Long) -> Boolean): Boolean {
    if (pending != ticket || ticket.generation != generation || closed) return false
    pending = null
    if (!resumed || !eligible) return false
    delivered = dispatch(ticket.sequence)
    return delivered
  }
  fun isResumed(): Boolean = resumed && !closed
  fun diagnostics(): Map<String, Any> = mapOf("generation" to generation, "sequence" to sequence,
    "resumed" to isResumed(), "closed" to closed, "delivered" to delivered, "pending" to (pending != null))
  companion object { private const val LIMIT = 9007199254740991L }
}
