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
import org.junit.Assert.*
import org.junit.Test
class SpeechOwnershipTest {
 @Test fun oldCallbackCannotConsumeLaterRecordingWithReusedId() {val owner=SpeechOwnership();val first=owner.start("a");assertTrue(owner.active("a",first));owner.clear();val second=owner.start("a");assertFalse(owner.active("a",first));assertTrue(owner.active("a",second))}
 @Test fun backgroundCancelsAndLateResultIsObsolete() {val owner=SpeechOwnership();val token=owner.start("old");assertTrue(owner.cancel(null));assertFalse(owner.active("old",token));val next=owner.start("next");assertFalse(owner.cancel("old"));assertTrue(owner.active("next",next))}
 @Test fun cancellationBeforePluginRegistrationCannotOpenMicrophone() {val owner=SpeechOwnership();assertFalse(owner.cancel("race"));try {owner.start("race");fail("Expected pre-cancel refusal")} catch(e:IllegalStateException) {assertEquals("speech-canceled",e.message)};assertTrue(owner.active("fresh",owner.start("fresh")))}
 @Test fun boundedTombstonesAndConcurrentStartRefusal() {val owner=SpeechOwnership();repeat(200) {owner.cancel("c$it")};val token=owner.start("c0");try {owner.start("other");fail("Concurrent owner admitted")} catch(e:IllegalStateException) {assertEquals("speech-busy",e.message)};assertTrue(owner.active("c0",token));assertFalse(owner.cancel("unknown"));assertTrue(owner.active("c0",token))}
}
