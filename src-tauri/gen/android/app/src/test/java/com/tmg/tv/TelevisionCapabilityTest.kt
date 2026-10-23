package com.tmg.tv
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
class TelevisionCapabilityTest {
 @Test fun televisionModeAndLeanbackEachIndependentlyIdentifyTv() {
  assertTrue(TelevisionCapability.isTelevision(4,false))
  assertTrue(TelevisionCapability.isTelevision(1,true))
  assertTrue(TelevisionCapability.isTelevision(null,true))
  assertTrue(TelevisionCapability.isTelevision(4,true))
 }
 @Test fun strippedLeanbackTelevisionFeatureStillIdentifiesTv() {
  assertTrue(TelevisionCapability.isTelevision(1,false,true))
  assertTrue(TelevisionCapability.isTelevision(null,false,true))
 }
 @Test fun normalCarAndMissingModeWithoutLeanbackDoNotInferTvFromDisplay() {
  assertFalse(TelevisionCapability.isTelevision(1,false))
  assertFalse(TelevisionCapability.isTelevision(3,false))
  assertFalse(TelevisionCapability.isTelevision(null,false))
 }
}
