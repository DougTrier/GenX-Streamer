package com.tmg.tv
import org.junit.Assert.*
import org.junit.Test
class SpeechOwnershipTest {
 @Test fun oldCallbackCannotConsumeLaterRecordingWithReusedId() {val owner=SpeechOwnership();val first=owner.start("a");assertTrue(owner.active("a",first));owner.clear();val second=owner.start("a");assertFalse(owner.active("a",first));assertTrue(owner.active("a",second))}
 @Test fun backgroundCancelsAndLateResultIsObsolete() {val owner=SpeechOwnership();val token=owner.start("old");assertTrue(owner.cancel(null));assertFalse(owner.active("old",token));val next=owner.start("next");assertFalse(owner.cancel("old"));assertTrue(owner.active("next",next))}
 @Test fun cancellationBeforePluginRegistrationCannotOpenMicrophone() {val owner=SpeechOwnership();assertFalse(owner.cancel("race"));try {owner.start("race");fail("Expected pre-cancel refusal")} catch(e:IllegalStateException) {assertEquals("speech-canceled",e.message)};assertTrue(owner.active("fresh",owner.start("fresh")))}
 @Test fun boundedTombstonesAndConcurrentStartRefusal() {val owner=SpeechOwnership();repeat(200) {owner.cancel("c$it")};val token=owner.start("c0");try {owner.start("other");fail("Concurrent owner admitted")} catch(e:IllegalStateException) {assertEquals("speech-busy",e.message)};assertTrue(owner.active("c0",token));assertFalse(owner.cancel("unknown"));assertTrue(owner.active("c0",token))}
}
