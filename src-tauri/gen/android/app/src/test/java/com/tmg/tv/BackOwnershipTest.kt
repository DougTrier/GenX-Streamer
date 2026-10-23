package com.tmg.tv
import org.junit.Assert.*
import org.junit.Test
class BackOwnershipTest {
  @Test fun coalescesPendingPressAndAckPreventsFallback() {val owner=BackOwnership();val id=owner.issue()!!;assertNull(owner.issue());assertTrue(owner.acknowledge(id));assertFalse(owner.expire(id));assertNotNull(owner.issue())}
  @Test fun staleAckOrTimerCannotConsumeNewPress() {val owner=BackOwnership();val first=owner.issue()!!;assertTrue(owner.expire(first));val next=owner.issue()!!;assertFalse(owner.acknowledge(first));assertFalse(owner.expire(first));assertTrue(owner.acknowledge(next))}
  @Test fun backgroundClearsPendingAndLateAckStaysObsolete() {val owner=BackOwnership();val old=owner.issue()!!;owner.clear();val next=owner.issue()!!;assertFalse(owner.expire(old));assertTrue(owner.acknowledge(next))}
}
