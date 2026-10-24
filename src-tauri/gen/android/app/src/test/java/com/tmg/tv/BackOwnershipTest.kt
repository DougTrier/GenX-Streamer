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
class BackOwnershipTest {
  @Test fun coalescesPendingPressAndAckPreventsFallback() {val owner=BackOwnership();val id=owner.issue()!!;assertNull(owner.issue());assertTrue(owner.acknowledge(id));assertFalse(owner.expire(id));assertNotNull(owner.issue())}
  @Test fun staleAckOrTimerCannotConsumeNewPress() {val owner=BackOwnership();val first=owner.issue()!!;assertTrue(owner.expire(first));val next=owner.issue()!!;assertFalse(owner.acknowledge(first));assertFalse(owner.expire(first));assertTrue(owner.acknowledge(next))}
  @Test fun backgroundClearsPendingAndLateAckStaysObsolete() {val owner=BackOwnership();val old=owner.issue()!!;owner.clear();val next=owner.issue()!!;assertFalse(owner.expire(old));assertTrue(owner.acknowledge(next))}
}
