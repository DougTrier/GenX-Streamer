// Copyright 2026 Doug Trier. Licensed under the Apache License, Version 2.0.
package com.tmg.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NativeVideoGeometryTest {
  @Test fun windowOriginAndParentPaddingAreNotAddedTwice() {
    // Parent at (10,20), padding (24,30), WebView begins at (34,50).
    // FrameLayout itself adds (24,30), so margins need no additional inset.
    assertEquals(0, NativeVideoGeometry.parentOffset(34, 10, 24))
    assertEquals(0, NativeVideoGeometry.parentOffset(50, 20, 30))
    assertEquals(12, NativeVideoGeometry.parentOffset(46, 10, 24))
  }

  @Test fun fireTvViewportDoesNotDoubleTheMeasuredOrigin() {
    // A 1920x1080 CSS viewport rendered into a 1920x1080 view, regardless
    // of DPR/display density: the reported 1568,515 must become 784,258.
    assertEquals(NativePictureBounds(784, 258, 1088, 612), NativeVideoGeometry.bounds(
      784.0, 257.5, 1088.0, 612.0, 1920, 1080, 1920, 1080, 0, 0))
  }

  @Test fun ordinaryHighDensityHandheldKeepsItsScale() {
    // Flip 2 / ordinary Android: two view pixels per CSS pixel stays 2x.
    assertEquals(NativePictureBounds(784, 258, 1088, 612), NativeVideoGeometry.bounds(
      392.0, 128.75, 544.0, 306.0, 960, 540, 1920, 1080, 0, 0))
  }

  @Test fun fullscreenAndReturningToEmbeddedUseFreshBounds() {
    assertEquals(NativePictureBounds(0, 0, 1920, 1080), NativeVideoGeometry.bounds(
      0.0, 0.0, 1920.0, 1080.0, 1920, 1080, 1920, 1080, 0, 0))
    assertEquals(NativePictureBounds(784, 258, 1088, 612), NativeVideoGeometry.bounds(
      784.0, 257.5, 1088.0, 612.0, 1920, 1080, 1920, 1080, 0, 0))
  }

  @Test fun parentOriginIsAddedOnceAndDoesNotScaleTheInset() {
    assertEquals(NativePictureBounds(804, 288, 1088, 612), NativeVideoGeometry.bounds(
      392.0, 128.75, 544.0, 306.0, 960, 540, 1920, 1080, 20, 30))
  }

  @Test fun legacyPixelsStayPixelsAndInvalidOrHiddenBoundsStayHidden() {
    assertEquals(NativePictureBounds(784, 258, 1088, 612), NativeVideoGeometry.bounds(
      784.0, 257.5, 1088.0, 612.0, 0, 0, 1920, 1080, 0, 0))
    for (viewport in listOf(0 to 1080, -1 to 1080, 1920 to 16_385))
      assertNull(NativeVideoGeometry.bounds(0.0, 0.0, 100.0, 100.0,
        viewport.first, viewport.second, 1920, 1080, 0, 0))
    assertNull(NativeVideoGeometry.bounds(0.0, 0.0, 0.0, 0.0, 1920, 1080, 1920, 1080, 0, 0))
    assertNull(NativeVideoGeometry.bounds(Double.NaN, 0.0, 100.0, 100.0, 1920, 1080, 1920, 1080, 0, 0))
    assertNull(NativeVideoGeometry.bounds(0.0, 0.0, 100.0, 100.0, 1920, 1080, 0, 0, 0, 0))
  }
}
