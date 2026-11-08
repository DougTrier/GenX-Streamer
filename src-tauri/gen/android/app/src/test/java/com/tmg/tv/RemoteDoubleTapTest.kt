package com.tmg.tv

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteDoubleTapTest {
  private val gesture = RemoteDoubleTap()

  private fun tap(down: Long, up: Long = down + 30): Boolean {
    gesture.press(down)
    return gesture.release(up)
  }

  @Test fun twoQuickTapsFireOnce() {
    assertFalse(tap(100))
    assertTrue(tap(290))
    assertFalse(tap(460))
  }

  @Test fun slowTapsAndHoldPulsesDoNotFire() {
    assertFalse(tap(100))
    assertFalse(tap(175))
    assertFalse(tap(250))
    assertFalse(tap(800))
    assertFalse(tap(980, 1260))
    assertFalse(tap(1430))
  }

  @Test fun googleVoiceRemoteAcceptsTheCapturedFastGap() {
    gesture.press(100)
    assertFalse(gesture.release(240, googleVoiceRemote = true))
    gesture.press(300)
    assertTrue(gesture.release(444, googleVoiceRemote = true))
  }

  @Test fun googleVoiceRemoteAcceptsTheCapturedLongerTap() {
    gesture.press(100)
    assertFalse(gesture.release(380, googleVoiceRemote = true))
    gesture.press(480)
    assertTrue(gesture.release(580, googleVoiceRemote = true))
  }

  @Test fun interruptionAndMissingReleaseBreakThePair() {
    assertFalse(tap(100))
    gesture.reset()
    assertFalse(tap(290))
    gesture.press(490)
    assertFalse(tap(650))
    assertTrue(tap(820))
  }
}
