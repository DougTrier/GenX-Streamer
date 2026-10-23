package com.tmg.tv
import org.junit.Assert.*
import org.junit.Test
class ActivityTaskFinishTest {
  @Test fun rejectsUnavailableOrUnownedWithoutFinishing() {
    var calls=0
    for ((api,destroyed,root,finishing) in listOf(listOf(23,0,1,0),listOf(34,1,1,0),listOf(34,0,0,0),listOf(34,0,1,1))) {
      assertFalse(ActivityTaskFinish().request(api,{destroyed==1},{root==1},{finishing==1}){calls++})
    }
    assertEquals(0,calls)
  }
  @Test fun actualFinishingReadbackAndDuplicateRequest() {
    val owner=ActivityTaskFinish();var finishing=false;var calls=0;var root=true
    assertTrue(owner.request(24,{false},{root},{finishing}){calls++;finishing=true;root=false})
    assertTrue(owner.request(34,{false},{root},{finishing}){calls++})
    assertEquals(1,calls)
  }
  @Test fun exceptionOrIgnoredFinishNeverAcknowledgedAndCanRetry() {
    val owner=ActivityTaskFinish();var finishing=false
    assertFalse(owner.request(34,{false},{true},{finishing}){throw IllegalStateException("private")})
    assertFalse(owner.request(34,{false},{true},{finishing}){})
    assertTrue(owner.request(34,{false},{true},{finishing}){finishing=true})
  }
}
