package com.tmg.tv

import org.junit.Assert.*
import org.junit.Test

class ViewingLifecycleOwnerTest {
  @Test fun activityResumeCoalescesPluginFocusAndLoadRequestsUntilOneDispatch() {
    val owner = ViewingLifecycleOwner()
    assertNull(owner.request(true))
    owner.resume()
    val ticket = owner.request(true)!!
    assertNull(owner.request(true))
    var calls = 0
    assertTrue(owner.complete(ticket, true) { calls++; true })
    assertEquals(1, calls)
    assertNull(owner.request(true))
  }
  @Test fun actualFocusPermissionAttachmentAndVisibilityAreRecheckedBeforeDispatch() {
    val owner = ViewingLifecycleOwner(); owner.resume()
    assertNull(owner.request(false))
    val ticket = owner.request(true)!!
    assertFalse(owner.complete(ticket, false) { fail("Protected state"); true })
    assertNotNull(owner.request(true))
  }
  @Test fun pauseInvalidatesQueuedResumeAndBackgroundSequenceDominatesOldReplay() {
    val owner = ViewingLifecycleOwner(); owner.resume()
    val old = owner.request(true)!!
    val background = owner.pause()!!
    assertFalse(background.foreground)
    assertTrue(background.sequence > old.sequence)
    assertFalse(owner.complete(old, true) { fail("Paused owner"); true })
    assertNull(owner.request(true))
    assertNull(owner.pause())
    owner.resume()
    val current = owner.request(true)!!
    assertTrue(current.sequence > background.sequence)
    assertFalse(owner.complete(old, true) { fail("Old generation"); true })
    assertTrue(owner.complete(current, true) { true })
  }
  @Test fun destroyRebindAndFocusLossRejectOldPostedCallbacks() {
    val owner = ViewingLifecycleOwner(); owner.resume()
    val old = owner.request(true)!!
    owner.rebind()
    val current = owner.request(true)!!
    assertFalse(owner.complete(old, true) { fail("Old binding"); true })
    owner.cancelReplay()
    assertFalse(owner.complete(current, true) { fail("Focus lost"); true })
    val final = owner.request(true)!!
    owner.destroy()
    assertFalse(owner.complete(final, true) { fail("Destroyed owner"); true })
    owner.resume()
    assertNull(owner.request(true))
    assertFalse(owner.isResumed())
  }
  @Test fun failedDispatchRemainsRetryableWithoutClaimingDelivery() {
    val owner = ViewingLifecycleOwner(); owner.resume()
    assertFalse(owner.complete(owner.request(true)!!, true) { false })
    assertTrue(owner.complete(owner.request(true)!!, true) { true })
    assertNull(owner.request(true))
  }
}
