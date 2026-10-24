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
class RendererRecoveryOwnerTest {
  @Test fun nativeFirstCannotReopenBeforeActualViewRetirement() {
    val owner=RendererRecoveryOwner(); assertTrue(owner.lost()); assertFalse(owner.lost())
    assertTrue(owner.nativeSettled(true)); assertFalse(owner.reopen()); assertFalse(owner.retry())
    assertTrue(owner.retirementSettled(true)); assertTrue(owner.reopen()); assertFalse(owner.reopen())
  }
  @Test fun viewFirstCannotReopenBeforeActualNativeJoin() {
    val owner=RendererRecoveryOwner(); assertTrue(owner.lost()); assertTrue(owner.retirementSettled(true))
    assertFalse(owner.reopen()); assertTrue(owner.nativeSettled(true)); assertTrue(owner.reopen())
    owner.launchFailed(); assertTrue(owner.reopen())
  }
  @Test fun failedNativeCleanupRetriesOnlyNativeAndKeepsDestroyedViewLatch() {
    val owner=RendererRecoveryOwner(); owner.lost(); owner.retirementSettled(true); owner.nativeSettled(false)
    assertFalse(owner.reopen()); assertTrue(owner.retry()); assertFalse(owner.retry())
    assertTrue(owner.retirementConfirmed); assertFalse(owner.nativeCleanupConfirmed)
    assertFalse(owner.retirementSettled(true)); assertTrue(owner.nativeSettled(true)); assertTrue(owner.reopen())
  }
  @Test fun failedRetirementRetriesLocallyWithoutReemittingJoinedNativeWork() {
    val owner=RendererRecoveryOwner(); owner.lost(); owner.nativeSettled(true); owner.retirementSettled(false)
    assertFalse(owner.reopen()); assertTrue(owner.retry()); assertTrue(owner.nativeCleanupConfirmed)
    assertFalse(owner.retirementConfirmed); assertFalse(owner.nativeSettled(true))
    assertTrue(owner.retirementSettled(true)); assertTrue(owner.reopen())
  }
  @Test fun bothFailuresRetainOneAttemptAndBothMustSettleOnRetry() {
    val owner=RendererRecoveryOwner(); owner.lost(); owner.retirementSettled(false); owner.nativeSettled(false)
    assertTrue(owner.retry()); assertTrue(owner.retirementSettled(true)); assertFalse(owner.reopen())
    assertTrue(owner.nativeSettled(true)); assertTrue(owner.reopen()); assertFalse(owner.nativeSettled(true))
  }
  @Test fun platformFocusOperationsPrecedeDetachDestroyAndFaultNeverConfirmsRetirement() {
    val calls=mutableListOf<String>()
    assertTrue(retireOwnedRenderer({calls.add("physical")},{calls.add("virtual")},
      {calls.add("detach")},{calls.add("destroy")}))
    assertEquals(listOf("physical","virtual","detach","destroy"),calls)
    calls.clear()
    assertFalse(retireOwnedRenderer({calls.add("physical")},{throw IllegalStateException("injected")},
      {calls.add("detach")},{calls.add("destroy")}))
    assertEquals(listOf("physical"),calls)
    assertFalse(retireOwnedRenderer({},{},{},{throw IllegalStateException("injected destroy failure")}))
  }
}
