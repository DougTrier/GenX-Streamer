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
