package com.tmg.tv

/** Native shell focus only; never changes the document's active control. */
internal data class ShellFocusState(
  val television: Boolean,
  val foreground: Boolean,
  val windowFocused: Boolean,
  val attached: Boolean,
  val shown: Boolean,
  val fullscreen: Boolean,
  val webViewFocused: Boolean,
  val imeVisible: Boolean?,
  val textEditor: Boolean,
  val foreignFocus: Boolean,
) {
  fun permitsFocus(): Boolean = television && foreground && windowFocused && attached && shown &&
    !fullscreen && !webViewFocused && imeVisible == false && !textEditor && !foreignFocus
}

internal data class ShellFocusDomState(val modal: Boolean, val editor: Boolean, val fullscreen: Boolean) {
  fun permitsFocus(): Boolean = !modal && !editor && !fullscreen
  companion object {
    private val shape = Regex("^\\s*\\[\\s*(true|false)\\s*,\\s*(true|false)\\s*,\\s*(true|false)\\s*]\\s*$")
    fun parse(raw: String?): ShellFocusDomState? {
      if (raw == null || raw.length > 128) return null
      val values = shape.matchEntire(raw)?.groupValues ?: return null
      return ShellFocusDomState(values[1] == "true", values[2] == "true", values[3] == "true")
    }
  }
}

internal class TelevisionShellFocusOwner {
  data class Ticket(val generation: Long, val sequence: Long)
  private var generation = 0L
  private var sequence = 0L
  private var pending: Ticket? = null
  private var closed = false

  fun invalidate() {
    pending = null
    if (generation == Long.MAX_VALUE) closed = true else generation++
  }

  fun begin(state: ShellFocusState): Ticket? {
    if (closed || pending != null || !state.permitsFocus()) return null
    if (sequence == Long.MAX_VALUE) { closed = true; return null }
    return Ticket(generation, ++sequence).also { pending = it }
  }

  fun complete(ticket: Ticket, state: ShellFocusState, dom: ShellFocusDomState?, request: () -> Boolean): Boolean {
    if (pending != ticket || closed) return false
    pending = null
    return state.permitsFocus() && dom?.permitsFocus() == true && request()
  }
}
