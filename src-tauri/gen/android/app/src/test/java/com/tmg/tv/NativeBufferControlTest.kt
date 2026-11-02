// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
package com.tmg.tv

import androidx.media3.common.C
import androidx.media3.common.Timeline
import androidx.media3.exoplayer.LoadControl
import androidx.media3.exoplayer.analytics.PlayerId
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.TrackGroupArray
import androidx.media3.exoplayer.trackselection.ExoTrackSelection
import androidx.media3.exoplayer.upstream.DefaultAllocator
import org.junit.Assert.*
import org.junit.Test

class NativeBufferControlTest {
  private class Defaults : LoadControl {
    var continueLoading = true
    var startPlayback = false
    var lifecycleCalls = 0
    var selectedCalls = 0
    val allocator = DefaultAllocator(true, 65536)
    override fun getAllocator(playerId: PlayerId) = allocator
    override fun getBackBufferDurationUs(playerId: PlayerId) = 30_000_000L
    override fun retainBackBufferFromKeyframe(playerId: PlayerId) = true
    override fun shouldContinueLoading(parameters: LoadControl.Parameters) = continueLoading
    override fun shouldStartPlayback(parameters: LoadControl.Parameters) = startPlayback
    override fun onPrepared(playerId: PlayerId) { lifecycleCalls++ }
    override fun onStopped(playerId: PlayerId) { lifecycleCalls++ }
    override fun onReleased(playerId: PlayerId) { lifecycleCalls++ }
    override fun onTracksSelected(parameters: LoadControl.Parameters, trackGroups: TrackGroupArray, trackSelections: Array<out ExoTrackSelection?>) { selectedCalls++ }
    override fun shouldContinuePreloading(playerId: PlayerId, timeline: Timeline, mediaPeriodId: MediaSource.MediaPeriodId, bufferedDurationUs: Long) = true
  }
  private fun parameters(bufferMs: Long, rebuffering: Boolean = false) = LoadControl.Parameters(
    PlayerId.UNSET, Timeline.EMPTY, MediaSource.MediaPeriodId("fixture"), 0L,
    bufferMs * 1000, 1f, true, rebuffering, C.TIME_UNSET, C.TIME_UNSET,
  )
  @Test fun autoPreservesOriginalLoadPolicyAllocatorAndReplayBackBuffer() {
    val defaults = Defaults(); val control = NativeBufferControl(defaults)
    assertNull(control.targetSeconds())
    for (allowed in listOf(true, false)) {
      defaults.continueLoading = allowed
      assertEquals(allowed, control.shouldContinueLoading(parameters(100)))
      defaults.startPlayback = allowed
      assertEquals(allowed, control.shouldStartPlayback(parameters(100)))
    }
    assertSame(defaults.allocator, control.getAllocator(PlayerId.UNSET))
    assertEquals(30_000_000L, control.getBackBufferDurationUs(PlayerId.UNSET))
    assertTrue(control.retainBackBufferFromKeyframe(PlayerId.UNSET))
    control.onTracksSelected(parameters(100), TrackGroupArray.EMPTY, emptyArray())
    assertEquals(1, defaults.selectedCalls)
    assertTrue(control.shouldContinuePreloading(PlayerId.UNSET, Timeline.EMPTY, MediaSource.MediaPeriodId("fixture"), 0L))
  }
  @Test fun runtimeTargetChangesLoadingInPlaceAndAutoRestoresDefault() {
    val defaults = Defaults(); val control = NativeBufferControl(defaults)
    control.onPrepared(PlayerId.UNSET)
    assertTrue(control.setPreference("manual", 12))
    assertTrue(control.shouldContinueLoading(parameters(11_999)))
    assertFalse(control.shouldContinueLoading(parameters(12_000)))
    assertTrue(control.setPreference("manual", 2))
    assertFalse(control.shouldContinueLoading(parameters(10_000)))
    assertTrue(control.shouldContinueLoading(parameters(1_999)))
    assertTrue(control.setPreference("auto", 0))
    assertTrue(control.shouldContinueLoading(parameters(12_000)))
    assertNull(control.targetSeconds())
    assertEquals(1, defaults.lifecycleCalls)
  }
  @Test fun sdkMemoryCeilingWinsAndHighGoalDoesNotDelayNormalStartup() {
    val defaults = Defaults(); val control = NativeBufferControl(defaults)
    control.setPreference("manual", 20)
    defaults.continueLoading = false
    assertFalse(control.shouldContinueLoading(parameters(1_000)))
    defaults.startPlayback = true
    assertTrue(control.shouldStartPlayback(parameters(2_500)))
    control.setPreference("manual", 1)
    defaults.startPlayback = false
    assertFalse(control.shouldStartPlayback(parameters(999)))
    assertTrue(control.shouldStartPlayback(parameters(1_000)))
  }
  @Test fun malformedTargetsCannotChangeTheActiveGoal() {
    val control = NativeBufferControl(Defaults()); control.setPreference("manual", 7)
    for ((mode, target) in listOf("manual" to 0, "manual" to 21, "manual" to -1, "auto" to 3, "other" to 8)) {
      assertFalse(control.setPreference(mode, target)); assertEquals(7, control.targetSeconds())
    }
  }
  @Test fun manualRebufferRequiresTheChosenTargetRatherThanDefaultShortGate() {
    val defaults = Defaults(); defaults.startPlayback = true
    val control = NativeBufferControl(defaults) { 0L }; control.setPreference("manual", 12)
    assertFalse(control.shouldStartPlayback(parameters(2_500, true)))
    assertFalse(control.shouldStartPlayback(parameters(11_999, true)))
    assertTrue(control.shouldStartPlayback(parameters(12_000, true)))
  }
  @Test fun manualRebufferWaitIsBoundedAndOriginalPolicyStillGovernsFallback() {
    var now = 100L
    val defaults = Defaults(); defaults.startPlayback = true
    val control = NativeBufferControl(defaults) { now }; control.setPreference("manual", 20)
    assertFalse(control.shouldStartPlayback(parameters(2_500, true)))
    now = 12_099L; assertFalse(control.shouldStartPlayback(parameters(2_500, true)))
    now = 12_100L; assertTrue(control.shouldStartPlayback(parameters(2_500, true)))
    defaults.startPlayback = false
    now = 19_000L; assertFalse(control.shouldStartPlayback(parameters(2_500, true)))
    defaults.startPlayback = true
    now = 20_000L; assertTrue(control.shouldStartPlayback(parameters(2_500, true)))
    assertEquals(20, control.targetSeconds())
  }
  @Test fun targetAutoInitialPlaybackAndLifecycleResetOnlyTheRebufferWait() {
    var now = 0L
    val defaults = Defaults(); defaults.startPlayback = true
    val control = NativeBufferControl(defaults) { now }; control.setPreference("manual", 12)
    assertTrue(control.shouldStartPlayback(parameters(2_500)))
    assertFalse(control.shouldStartPlayback(parameters(2_500, true)))
    now = 11_000L; control.setPreference("manual", 13)
    assertFalse(control.shouldStartPlayback(parameters(2_500, true)))
    now = 12_000L; assertFalse(control.shouldStartPlayback(parameters(2_500, true)))
    control.setPreference("auto", 0)
    assertTrue(control.shouldStartPlayback(parameters(2_500, true)))
    control.setPreference("manual", 13)
    for (reset in listOf<() -> Unit>(
      { control.onPrepared(PlayerId.UNSET) },
      { control.onStopped(PlayerId.UNSET) },
      { control.onReleased(PlayerId.UNSET) },
    )) {
      assertFalse(control.shouldStartPlayback(parameters(2_500, true)))
      now += 12_000L; assertTrue(control.shouldStartPlayback(parameters(2_500, true)))
      reset()
      assertFalse(control.shouldStartPlayback(parameters(2_500, true)))
      assertEquals(13, control.targetSeconds())
      assertTrue(control.shouldStartPlayback(parameters(2_500)))
    }
    assertEquals(3, defaults.lifecycleCalls)
  }
  @Test fun repeatedSameGoalCannotExtendTheBoundAndLowGoalStartsWithoutDeadlock() {
    var now = 0L
    val defaults = Defaults(); defaults.startPlayback = true
    val control = NativeBufferControl(defaults) { now }; control.setPreference("manual", 12)
    assertFalse(control.shouldStartPlayback(parameters(2_500, true)))
    now = 11_999L; control.setPreference("manual", 12)
    assertFalse(control.shouldStartPlayback(parameters(2_500, true)))
    now = 12_000L; assertTrue(control.shouldStartPlayback(parameters(2_500, true)))
    control.setPreference("manual", 1)
    assertFalse(control.shouldStartPlayback(parameters(999, true)))
    assertTrue(control.shouldStartPlayback(parameters(1_000, true)))
    defaults.startPlayback = false
    assertFalse(control.shouldStartPlayback(parameters(999)))
    assertTrue(control.shouldStartPlayback(parameters(1_000)))
  }
  @Test fun ingressIsMeasuredFromBytesAndExpiresWithinTheBoundedWindow() {
    var now = 0L; val meter = NativeTransferMeter { now }
    assertNull(meter.incomingBitsPerSecond(true))
    meter.received(false, 9000); assertNull(meter.incomingBitsPerSecond(true))
    now = 500; meter.received(true, 1000)
    now = 1000; assertEquals(8000.0, meter.incomingBitsPerSecond(true)!!, 0.001)
    now = 1500; meter.received(true, 2000)
    now = 2000; assertEquals(12000.0, meter.incomingBitsPerSecond(true)!!, 0.001)
    now = 2600; assertEquals(8000.0, meter.incomingBitsPerSecond(true)!!, 0.001)
    now = 3700; assertEquals(0.0, meter.incomingBitsPerSecond(true)!!, 0.001)
    assertNull(meter.incomingBitsPerSecond(false))
  }
  @Test fun concurrentMediaTransfersAreCountedWithoutCrossSessionCarry() {
    var now = 0L; val meter = NativeTransferMeter { now }
    now = 500
    val workers = (1..2).map { Thread { repeat(1000) { meter.received(true, 10) } }.also { it.start() } }
    workers.forEach { it.join() }
    now = 1000; assertEquals(160000.0, meter.incomingBitsPerSecond(true)!!, 0.001)
    assertNull(NativeTransferMeter { now }.incomingBitsPerSecond(true))
  }
}
