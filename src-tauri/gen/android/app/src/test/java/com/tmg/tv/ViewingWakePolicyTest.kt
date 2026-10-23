package com.tmg.tv

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ViewingWakePolicyTest {
  @Test fun lateBackgroundEnableAndAllDisablesClearOwnedWindow() {
    assertTrue(ViewingWakePolicy.shouldHold(true, true))
    assertFalse(ViewingWakePolicy.shouldHold(true, false))
    assertFalse(ViewingWakePolicy.shouldHold(false, true))
    assertFalse(ViewingWakePolicy.shouldHold(false, false))
  }
  @Test fun boundWebViewInitialClearAndLifecycleClearDoNotRestorePlayback() {
    var window = false
    var webView = true // Reproduced idle-provider flag before the application binds ownership.
    val owner = ViewingWakeOwner({ window = it }, { webView = it })
    owner.clear()
    assertFalse(window); assertFalse(webView)
    owner.request(true, true)
    assertTrue(window); assertTrue(webView)
    owner.clear() // Pause/Stop/Destroy each call this exact policy.
    assertFalse(window); assertFalse(webView)
    // Foreground arrival alone performs no request; explicit resume must reacquire.
    assertFalse(window); assertFalse(webView)
    owner.request(true, false)
    assertFalse(window); assertFalse(webView)
    owner.request(true, true)
    owner.request(false, true)
    assertFalse(window); assertFalse(webView)
  }
  @Test fun foregroundClearsExternallyRestoredBitsUntilExplicitPlaybackRequest() {
    var window = false
    var webView = false
    val owner = ViewingWakeOwner({ window = it }, { webView = it })
    owner.request(true, true)
    owner.clear() // Background.
    window = true; webView = true // Observed restoration; setter origin is not assumed.
    owner.clear() // onResume after super, before foreground admission.
    assertFalse(window); assertFalse(webView)
    owner.request(false, true)
    assertFalse(window); assertFalse(webView)
    owner.request(true, true) // Only explicit playback request reacquires.
    assertTrue(window); assertTrue(webView)
  }
  @Test fun diagnosticTraversalIsBoundedReadOnlyAndReportsDepthTruncation() {
    data class Node(val keep: Boolean, val children: List<Node>)
    val leaves = List(200) { Node(it % 2 == 0, emptyList()) }
    val root = Node(true, leaves)
    var observations = 0
    val (rows, truncated) = ViewingWakeReader.read(root, { it.children.size }, { node, index -> node.children[index] },
      { node, path -> observations++; mapOf("path" to path, "keepScreenOn" to node.keep) })
    org.junit.Assert.assertEquals(128, rows.size)
    org.junit.Assert.assertEquals(128, observations)
    assertTrue(truncated); assertTrue(root.keep)
    org.junit.Assert.assertEquals(200, root.children.size)
    var chain = Node(true, emptyList())
    repeat(20) { chain = Node(false, listOf(chain)) }
    val (deepRows, deepTruncated) = ViewingWakeReader.read(chain, { it.children.size }, { node, index -> node.children[index] },
      { node, path -> mapOf("path" to path, "keepScreenOn" to node.keep) })
    org.junit.Assert.assertEquals(17, deepRows.size)
    assertTrue(deepTruncated)
    val absent = ViewingWakeReader.read<Node>(null, { it.children.size }, { node,index -> node.children[index] }, { _,_ -> emptyMap() })
    assertTrue(absent.first.isEmpty()); assertFalse(absent.second)
  }
  @Test fun focusReconcilesProviderFlagWithoutRestoringBackgroundPlaybackIntent() {
    var window = false
    var webView = false
    val owner = ViewingWakeOwner({ window = it }, { webView = it })
    owner.request(true, true)
    owner.clear() // Background invalidates the old playback intent.
    webView = true // Actual foreground diagnostic observed this bound-root flag.
    owner.reconcile(true)
    assertFalse(owner.requestedActive); assertFalse(window); assertFalse(webView)
    owner.reconcile(true) // Duplicate focus is idempotent.
    assertFalse(webView)
    owner.request(true, true) // Explicit Resume holds the screen through focus changes.
    owner.reconcile(true)
    assertTrue(window); assertTrue(webView)
    owner.reconcile(false)
    assertFalse(window); assertFalse(webView)
  }
}

