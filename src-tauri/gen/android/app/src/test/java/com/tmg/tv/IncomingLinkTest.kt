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
class IncomingLinkTest {
  @Test fun ownSchemeAndPageOnly() {
    val page = "https://dougtrier.github.io/GenX-Streamer/watch/#v=1&c=ch&n=News"
    assertEquals(page, IncomingLink.admit(page))
    assertEquals("genx://watch?v=1", IncomingLink.admit("  genx://watch?v=1 "))
    assertEquals("GENX://watch?v=1", IncomingLink.admit("GENX://watch?v=1"))
    listOf(null, "", "genx://settings", "https://example.com/GenX-Streamer/watch/",
      "https://dougtrier.github.io.example/GenX-Streamer/watch/", "http://dougtrier.github.io/GenX-Streamer/watch/",
      "genx://watch?n=a b", "genx://watch?n=a\nb", "intent://watch#Intent;scheme=genx;end"
    ).forEach { assertNull(it, IncomingLink.admit(it)) }
    assertNull(IncomingLink.admit("genx://watch?n=" + "a".repeat(IncomingLink.MAX)))
  }
}
