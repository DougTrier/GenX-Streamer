/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.tmg.tv

import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.util.Log
import androidx.media3.common.MimeTypes
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Trier AutoTune in the app (docs/trier-adaptive-engine.md, milestone 6).
 *
 * `configure` tells the native decoder where its device profile lives, the OS
 * it is keyed by and the policy; every Trier decoder then applies the
 * profile's choice for its stream's class (resolution and scan), and keeps
 * the known-good settings where there is none.
 *
 * `schedule` runs Stage A calibration on the bundled samples (assets/
 * trier-calibration) in the background, only on devices that use Trier, at
 * the lowest thread priority, after start-up, when charging or above half
 * battery and not thermally stressed, at most once a day unless the profile
 * needs it. Playback starting cancels it within a picture (native side), and
 * an interrupted or unconfirmed result records nothing.
 */
object TrierAutoTune {
  private const val TAG = "TrierAutoTune"
  /** The app's policy: frame deadlines with headroom, then the least CPU. */
  private const val POLICY = "balanced"
  private const val PREFS = "trier-autotune"
  private const val LAST_ATTEMPT = "lastAttemptMs"
  private const val RETRY_MS = 24L * 60 * 60 * 1000
  private const val START_DELAY_MS = 90_000L
  private const val BUDGET_SECONDS = 120
  private val configured = AtomicBoolean(false)
  private val scheduled = AtomicBoolean(false)

  fun configure(context: Context) {
    if (!configured.compareAndSet(false, true)) return
    val dir = File(context.applicationContext.filesDir, "trier").apply { mkdirs() }
    val os = "Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})"
    runCatching { TrierMpegVideoNative.configure(dir.path, os, POLICY) }
      .onFailure { Log.w(TAG, "configure failed", it) }
  }

  fun schedule(context: Context) {
    val app = context.applicationContext
    configure(app)
    if (!scheduled.compareAndSet(false, true)) return
    val usesTrier = runCatching {
      NativeVideoRules.needsTrierMpegVideo(
        MediaCodecUtil.getDecoderInfos(MimeTypes.VIDEO_MPEG2, false, false).size,
      )
    }.getOrDefault(false)
    if (!usesTrier) return
    val now = debugProperty("debug.genx.trier.calibrate") == "now"
    Thread({
      Process.setThreadPriority(Process.THREAD_PRIORITY_LOWEST)
      runCatching {
        Thread.sleep(if (now) 5_000L else START_DELAY_MS)
        calibrateIfIdle(app, now)
      }.onFailure { Log.w(TAG, "calibration failed", it) }
    }, "trier-autotune").apply {
      isDaemon = true
      start()
    }
  }

  private fun calibrateIfIdle(context: Context, now: Boolean) {
    if (!TrierMpegVideoNative.needsCalibration()) {
      Log.i(TAG, "profile complete; no calibration needed")
      return
    }
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val last = prefs.getLong(LAST_ATTEMPT, 0L)
    if (!now && System.currentTimeMillis() - last < RETRY_MS) {
      Log.i(TAG, "calibration tried within the last day; waiting")
      return
    }
    val battery = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
    val level = battery?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
    val charging = battery?.isCharging == true
    val thermal = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.currentThermalStatus ?: 0
    } else 0
    val conditions = "app, ${if (charging) "charging" else "battery"} $level%, thermal status $thermal"
    if ((!charging && level in 0 until 50) || thermal > PowerManager.THERMAL_STATUS_LIGHT) {
      Log.i(TAG, "calibration deferred: $conditions")
      return
    }
    prefs.edit().putLong(LAST_ATTEMPT, System.currentTimeMillis()).apply()
    val sample = { name: String -> context.assets.open("trier-calibration/$name.m2v").use { it.readBytes() } }
    Log.i(TAG, "calibration starting: $conditions")
    val result = TrierMpegVideoNative.calibrate(sample("sd"), sample("hd720"), sample("hd1080i"), BUDGET_SECONDS, conditions)
    Log.i(TAG, "calibration finished: ${result.replace("\n", " | ")}")
  }

  /** A system property (debug overrides for testing); null when unset. */
  private fun debugProperty(name: String): String? = runCatching {
    Class.forName("android.os.SystemProperties").getMethod("get", String::class.java)
      .invoke(null, name) as String
  }.getOrNull()?.takeIf { it.isNotEmpty() }
}
