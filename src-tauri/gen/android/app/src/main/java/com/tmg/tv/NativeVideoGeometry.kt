// Copyright 2026 Doug Trier. Licensed under the Apache License, Version 2.0.
package com.tmg.tv

import kotlin.math.roundToInt

internal data class NativePictureBounds(val left: Int, val top: Int, val width: Int, val height: Int)

/** CSS viewport -> actual WebView -> parent margins. No density/DPR conversion follows. */
internal object NativeVideoGeometry {
  fun parentOffset(webWindowOrigin: Int, parentWindowOrigin: Int, parentPadding: Int): Int =
    webWindowOrigin - parentWindowOrigin - parentPadding

  fun bounds(
    left: Double, top: Double, width: Double, height: Double,
    viewportWidth: Int, viewportHeight: Int, webWidth: Int, webHeight: Int,
    offsetLeft: Int, offsetTop: Int,
  ): NativePictureBounds? {
    if (listOf(left, top, width, height).any { !it.isFinite() || it < 0 || it > 16_384 } ||
      width <= 0 || height <= 0 || webWidth <= 0 || webHeight <= 0) return null
    // Omitted viewport supports the original physical-pixel command contract.
    val legacy = viewportWidth == 0 && viewportHeight == 0
    if (!legacy && (viewportWidth !in 1..16_384 || viewportHeight !in 1..16_384)) return null
    val sx = if (legacy) 1.0 else webWidth.toDouble() / viewportWidth
    val sy = if (legacy) 1.0 else webHeight.toDouble() / viewportHeight
    fun px(value: Double, scale: Double) = (value * scale).coerceIn(0.0, 16_384.0).roundToInt()
    return NativePictureBounds(
      offsetLeft + px(left, sx), offsetTop + px(top, sy),
      px(width, sx), px(height, sy),
    ).takeIf { it.width > 0 && it.height > 0 }
  }
}
