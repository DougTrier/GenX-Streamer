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
  fun delta(expected: NativePictureBounds, actual: NativePictureBounds): IntArray = intArrayOf(
    actual.left-expected.left,actual.top-expected.top,actual.width-expected.width,actual.height-expected.height)
  fun aligned(expected: NativePictureBounds, actual: NativePictureBounds): Boolean = delta(expected,actual).all { kotlin.math.abs(it)<=2 }
  fun fitted(player: NativePictureBounds, videoWidth: Int, videoHeight: Int, pixelAspect: Float): NativePictureBounds? {
    if(videoWidth<=0 || videoHeight<=0 || !pixelAspect.isFinite() || pixelAspect<=0)return null
    val aspect=videoWidth.toDouble()*pixelAspect/videoHeight
    val width=kotlin.math.min(player.width.toDouble(),player.height*aspect).roundToInt()
    val height=kotlin.math.min(player.height.toDouble(),player.width/aspect).roundToInt()
    return NativePictureBounds(player.left+(player.width-width)/2,player.top+(player.height-height)/2,width,height)
  }
}
