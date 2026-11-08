package com.tmg.tv

internal class RemoteDoubleTap {
  private var pressedAt: Long? = null
  private var previousRelease: Long? = null

  fun press(at: Long) {
    if (pressedAt != null) reset()
    pressedAt = at
  }

  fun release(at: Long, googleVoiceRemote: Boolean = false): Boolean {
    val down = pressedAt ?: return false
    pressedAt = null
    val maxPress = if (googleVoiceRemote) 300L else 220L
    if (at - down !in 0L..maxPress) {
      reset()
      return false
    }
    // This Bluetooth remote sends distinct key releases, including gaps under 90 ms.
    // Preserve the longer gap for remotes that emulate a hold with infrared pulses.
    val minGap = if (googleVoiceRemote) 25L else 90L
    val matched = previousRelease?.let { down - it in minGap..350L } == true
    previousRelease = if (matched) null else at
    return matched
  }

  fun reset() {
    pressedAt = null
    previousRelease = null
  }
}
