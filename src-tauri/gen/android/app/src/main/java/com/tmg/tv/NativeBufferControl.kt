// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
package com.tmg.tv

import android.os.SystemClock
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import androidx.media3.exoplayer.LoadControl
import androidx.media3.common.Timeline
import androidx.media3.exoplayer.analytics.PlayerId
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.TrackGroupArray
import androidx.media3.exoplayer.trackselection.ExoTrackSelection

/** Changes only the forward-loading goal; the player/session and queued media stay intact. */
class NativeBufferControl(
  private val defaults: LoadControl,
  private val clock: () -> Long = { SystemClock.elapsedRealtime() },
) : LoadControl {
  @Volatile private var seconds = 0 // Auto uses the original Media3 policy.
  private var rebufferSince: Long? = null
  private var rebufferFallback = false

  companion object {
    fun validPreference(mode: String, targetSeconds: Int): Boolean =
      (mode == "auto" && targetSeconds == 0) || (mode == "manual" && targetSeconds in 1..20)
  }

  @Synchronized fun setPreference(mode: String, targetSeconds: Int): Boolean {
    if (!validPreference(mode, targetSeconds)) return false
    val next = when {
      mode == "auto" && targetSeconds == 0 -> 0
      mode == "manual" && targetSeconds in 1..20 -> targetSeconds
      else -> return false
    }
    if (seconds != next) resetRebufferWait()
    seconds = next
    return true
  }

  fun targetSeconds(): Int? = seconds.takeIf { it > 0 }

  private fun resetRebufferWait() {
    rebufferSince = null
    rebufferFallback = false
  }

  // Kotlin delegation does not forward Java default interface methods. Forward
  // Media3's current lifecycle explicitly so its allocator and replay policy survive.
  @Synchronized override fun onPrepared(playerId: PlayerId) {
    resetRebufferWait()
    defaults.onPrepared(playerId)
  }
  override fun getAllocator(playerId: PlayerId) = defaults.getAllocator(playerId)
  @Synchronized override fun onStopped(playerId: PlayerId) {
    resetRebufferWait()
    defaults.onStopped(playerId)
  }
  @Synchronized override fun onReleased(playerId: PlayerId) {
    resetRebufferWait()
    defaults.onReleased(playerId)
  }
  override fun onTracksSelected(parameters: LoadControl.Parameters, trackGroups: TrackGroupArray, trackSelections: Array<out ExoTrackSelection?>) =
    defaults.onTracksSelected(parameters, trackGroups, trackSelections)
  override fun getBackBufferDurationUs(playerId: PlayerId) = defaults.getBackBufferDurationUs(playerId)
  override fun retainBackBufferFromKeyframe(playerId: PlayerId) = defaults.retainBackBufferFromKeyframe(playerId)
  override fun shouldContinuePreloading(playerId: PlayerId, timeline: Timeline, mediaPeriodId: MediaSource.MediaPeriodId, bufferedDurationUs: Long) =
    defaults.shouldContinuePreloading(playerId, timeline, mediaPeriodId, bufferedDurationUs)

  override fun shouldContinueLoading(parameters: LoadControl.Parameters): Boolean {
    // Keep Media3's allocator/memory ceiling even when the requested goal is larger.
    val allowed = defaults.shouldContinueLoading(parameters)
    val target = seconds
    return allowed && (target == 0 || parameters.bufferedDurationUs < target * 1_000_000L)
  }

  @Synchronized override fun shouldStartPlayback(parameters: LoadControl.Parameters): Boolean {
    val original = defaults.shouldStartPlayback(parameters)
    val target = seconds
    if (target == 0) {
      resetRebufferWait()
      return original
    }
    val ready = parameters.bufferedDurationUs >= target * 1_000_000L
    if (!parameters.rebuffering) {
      resetRebufferWait()
      // Keep normal initial startup; a 1s loading cap must not deadlock below
      // Media3's startup threshold. Larger targets fill while already playing.
      return original || ready
    }
    if (ready) {
      resetRebufferWait()
      return true
    }
    if (rebufferFallback) return original
    val now = clock()
    val start = rebufferSince
    if (start == null || now < start) rebufferSince = now
    else if (now - start >= 12_000L) {
      // Stop extending an unavailable goal before the controller's 20s
      // progress deadline. Original readiness remains required after fallback.
      rebufferFallback = true
      return original
    }
    return false
  }
}

/** Payload bytes actually delivered to this player, in a bounded two-second window. */
class NativeTransferMeter(private val clock: () -> Long = { SystemClock.elapsedRealtime() }) : TransferListener {
  private val openedAt = clock()
  private val ticks = LongArray(20) { Long.MIN_VALUE }
  private val amounts = LongArray(20)
  private var observedBytes = false

  @Synchronized internal fun received(isNetwork: Boolean, bytes: Int) {
    if (!isNetwork || bytes <= 0) return
    val now = clock()
    if (now < openedAt) return
    val tick = now / 100
    val index = (tick % ticks.size).toInt()
    if (ticks[index] != tick) { ticks[index] = tick; amounts[index] = 0 }
    amounts[index] = (amounts[index] + bytes).coerceAtMost(9_007_199_254_740_991L)
    observedBytes = true
  }

  @Synchronized fun incomingBitsPerSecond(activeLoading: Boolean): Double? {
    if (!activeLoading || !observedBytes) return null
    val now = clock()
    if (now <= openedAt) return null
    val current = now / 100
    var bytes = 0.0
    for (index in ticks.indices) if (ticks[index] in (current - 19)..current) bytes += amounts[index]
    val rate = bytes * 8_000.0 / (now - openedAt).coerceAtMost(2_000L)
    return rate.takeIf { it.isFinite() && it in 0.0..1.0e12 }
  }

  override fun onTransferInitializing(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {}
  override fun onTransferStart(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {}
  override fun onBytesTransferred(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean, bytesTransferred: Int) {
    received(isNetwork, bytesTransferred)
  }
  override fun onTransferEnd(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {}
}
