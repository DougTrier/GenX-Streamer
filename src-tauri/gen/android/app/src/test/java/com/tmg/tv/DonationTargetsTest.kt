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
class DonationTargetsTest {
 @Test fun exactTargetsOnly() {
  assertEquals("https://github.com/dougtrier",DonationTargets.url("author"))
  assertEquals("https://github.com/sponsors/dougtrier",DonationTargets.url("github"))
  assertEquals("https://opencollective.com/trier-os",DonationTargets.url("opencollective"))
  assertEquals("https://www.buymeacoffee.com/dougtrier",DonationTargets.url("coffee"))
  listOf("","Author","https://github.com/dougtrier","Github","github ","https://github.com/sponsors/dougtrier","coffee?x=1","file:///C:/","cmd.exe").forEach { assertNull(DonationTargets.url(it)) }
 }
 @Test fun unavailableAndBackgroundNeverPretendSuccess() {
   var calls=0
   assertEquals("donation-target-refused",DonationTargets.open("https://example.invalid",true){calls++})
   assertEquals("donation-browser-unavailable",DonationTargets.open("coffee",false){calls++})
   assertEquals(0,calls)
   assertEquals("donation-browser-unavailable",DonationTargets.open("github",true){throw RuntimeException("sensitive OS detail")})
   assertNull(DonationTargets.open("coffee",true){assertEquals("https://www.buymeacoffee.com/dougtrier",it);calls++})
   assertEquals(1,calls)
 }

}
