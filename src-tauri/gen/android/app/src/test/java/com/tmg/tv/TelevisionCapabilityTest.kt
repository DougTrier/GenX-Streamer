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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
class TelevisionCapabilityTest {
 @Test fun onlyFireOs7TelevisionsPreferNativeArchivePlayback() {
  assertTrue(TelevisionCapability.nativeEmbeddedPlayback(true,"Amazon","AFTKA",28))
  assertFalse(TelevisionCapability.nativeEmbeddedPlayback(false,"Amazon","AFTKA",28))
  assertFalse(TelevisionCapability.nativeEmbeddedPlayback(true,"Amazon","AFTKA",30))
  assertFalse(TelevisionCapability.nativeEmbeddedPlayback(true,"Amazon","Tablet",28))
  assertFalse(TelevisionCapability.nativeEmbeddedPlayback(true,"Google","Streamer",34))
  assertFalse(TelevisionCapability.nativeEmbeddedPlayback(false,"Retroid","Flip 2",33))
 }
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
