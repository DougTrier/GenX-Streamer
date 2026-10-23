package com.tmg.tv

import org.junit.Assert.*
import org.junit.Test

class TelevisionShellFocusOwnerTest {
  private val idle = ShellFocusState(true, true, true, true, true, false, false, false, false, false)
  private val normal = ShellFocusDomState(false, false, false)

  @Test fun shellAttemptHonorsActualRequestResultAndCoalesces() {
    val owner = TelevisionShellFocusOwner()
    val ticket = owner.begin(idle)!!
    assertNull(owner.begin(idle))
    var calls = 0
    assertFalse(owner.complete(ticket, idle, normal) { calls++; false })
    assertEquals(1, calls)
    assertFalse(owner.complete(ticket, idle, normal) { calls++; true })
    assertTrue(owner.complete(owner.begin(idle)!!, idle, normal) { calls++; true })
    assertEquals(2, calls)
  }

  @Test fun everyNativeProtectionRefusesBeforeDispatch() {
    val blocked = listOf(idle.copy(television = false), idle.copy(foreground = false),
      idle.copy(windowFocused = false), idle.copy(attached = false), idle.copy(shown = false),
      idle.copy(fullscreen = true), idle.copy(webViewFocused = true), idle.copy(imeVisible = true),
      idle.copy(imeVisible = null), idle.copy(textEditor = true), idle.copy(foreignFocus = true))
    for (state in blocked) assertNull(TelevisionShellFocusOwner().begin(state))
  }

  @Test fun callbackRechecksNativeLeaseBeforeEffect() {
    for (state in listOf(idle.copy(foreground = false), idle.copy(imeVisible = true),
      idle.copy(foreignFocus = true), idle.copy(webViewFocused = true))) {
      val owner = TelevisionShellFocusOwner()
      val ticket = owner.begin(idle)!!
      assertFalse(owner.complete(ticket, state, normal) { fail("Must not steal focus"); true })
      assertNotNull(owner.begin(idle))
    }
  }

  @Test fun pauseRebindAndDetachInvalidateOldCallbackWithoutConsumingNewAttempt() {
    val owner = TelevisionShellFocusOwner()
    val old = owner.begin(idle)!!
    owner.invalidate()
    val current = owner.begin(idle)!!
    assertFalse(owner.complete(old, idle, normal) { fail("Stale lease"); true })
    assertTrue(owner.complete(current, idle, normal) { true })
  }

  @Test fun completedTicketCannotMatchLaterAttemptInSameGeneration() {
    val owner = TelevisionShellFocusOwner()
    val old = owner.begin(idle)!!
    assertFalse(owner.complete(old, idle, null) { true })
    val current = owner.begin(idle)!!
    assertFalse(owner.complete(old, idle, normal) { fail("Stale sequence"); true })
    assertTrue(owner.complete(current, idle, normal) { true })
  }

  @Test fun modalEditorFullscreenAndUnavailableDomNeverRequestFocus() {
    for (dom in listOf(null, ShellFocusDomState(true, false, false),
      ShellFocusDomState(false, true, false), ShellFocusDomState(false, false, true))) {
      val owner = TelevisionShellFocusOwner()
      assertFalse(owner.complete(owner.begin(idle)!!, idle, dom) { fail("Protected document"); true })
    }
  }

  @Test fun onlyFixedBooleanDomShapeIsAdmittedWithoutPayload() {
    assertEquals(normal, ShellFocusDomState.parse("[false,false,false]"))
    assertEquals(ShellFocusDomState(true, false, true), ShellFocusDomState.parse(" [ true, false, true ] "))
    for (raw in listOf(null, "null", "[0,false,false]", "[false,false,false,false]",
      "[false,false,false]secret", "\"[false,false,false]\"", " ".repeat(129))) {
      assertNull(ShellFocusDomState.parse(raw))
    }
  }
}
