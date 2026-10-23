package com.tmg.tv
import org.junit.Assert.*
import org.junit.Test
class DonationTargetsTest {
 @Test fun exactTargetsOnly() {
  assertEquals("https://github.com/sponsors/dougtrier",DonationTargets.url("github"))
  assertEquals("https://opencollective.com/trier-os",DonationTargets.url("opencollective"))
  assertEquals("https://www.buymeacoffee.com/dougtrier",DonationTargets.url("coffee"))
  listOf("","Github","github ","https://github.com/sponsors/dougtrier","coffee?x=1","file:///C:/","cmd.exe").forEach { assertNull(DonationTargets.url(it)) }
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
