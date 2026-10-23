package com.tmg.tv

/** Both real view retirement and native cleanup must settle before replacement consent. */
internal class RendererRecoveryOwner {
  enum class Phase { Alive, Joining, Failed, Joined, Relaunching }
  var phase = Phase.Alive; private set
  private var nativeJoined: Boolean? = null
  private var viewRetired: Boolean? = null
  val retirementConfirmed: Boolean get() = viewRetired == true
  val nativeCleanupConfirmed: Boolean get() = nativeJoined == true
  fun lost(): Boolean { if (phase != Phase.Alive) return false; phase = Phase.Joining; return true }
  fun retry(): Boolean {
    if (phase != Phase.Failed) return false
    if (nativeJoined != true) nativeJoined = null
    if (viewRetired != true) viewRetired = null
    phase = Phase.Joining; return true
  }
  fun nativeSettled(joined: Boolean): Boolean {
    if (phase != Phase.Joining || nativeJoined != null) return false
    nativeJoined = joined; settle(); return true
  }
  fun retirementSettled(retired: Boolean): Boolean {
    if (phase != Phase.Joining || viewRetired != null) return false
    viewRetired = retired; settle(); return true
  }
  private fun settle() {
    if (nativeJoined != null && viewRetired != null)
      phase = if (nativeJoined == true && viewRetired == true) Phase.Joined else Phase.Failed
  }
  fun reopen(): Boolean { if (phase != Phase.Joined) return false; phase = Phase.Relaunching; return true }
  fun launchFailed() { if (phase == Phase.Relaunching) phase = Phase.Joined }
}

/** Supported platform operations are injected only for deterministic ordering/fault fixtures. */
internal fun retireOwnedRenderer(clearPhysical: () -> Unit, clearVirtual: () -> Unit,
  detach: () -> Unit, destroy: () -> Unit): Boolean = try {
  clearPhysical(); clearVirtual(); detach(); destroy(); true
} catch (_: RuntimeException) { false }
