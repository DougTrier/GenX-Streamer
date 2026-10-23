package com.tmg.tv

/** Explicit ownership of the Activity window and exactly its bound WebView. */
object ViewingWakePolicy {
  fun shouldHold(requestedActive: Boolean, foreground: Boolean): Boolean = requestedActive && foreground
}

class ViewingWakeOwner(private val windowFlag: (Boolean) -> Unit, private val webViewFlag: (Boolean) -> Unit) {
  var requestedActive: Boolean = false
    private set
  fun request(active: Boolean, foreground: Boolean) {
    requestedActive = active
    val hold = ViewingWakePolicy.shouldHold(active, foreground)
    windowFlag(hold)
    webViewFlag(hold)
  }
  fun clear() { request(false, false) }
  fun reconcile(foreground: Boolean) { request(requestedActive, foreground) }
}

/** Read-only bounded traversal. Caller supplies getters only, never flags/text mutation. */
object ViewingWakeReader {
  fun <T> read(root: T?, children: (T) -> Int, child: (T, Int) -> T,
              observe: (T, String) -> Map<String, Any?>): Pair<List<Map<String, Any?>>, Boolean> {
    if (root == null) return Pair(emptyList(), false)
    val queue = java.util.ArrayDeque<Triple<T, String, Int>>()
    queue.add(Triple(root, "webview", 0))
    val rows = mutableListOf<Map<String, Any?>>()
    var truncated = false
    while (queue.isNotEmpty()) {
      val (node, path, depth) = queue.removeFirst()
      rows.add(observe(node, path))
      val count = children(node)
      if (depth >= 16) { if (count > 0) truncated = true; continue }
      val admitted = minOf(count, 128 - rows.size - queue.size)
      if (admitted < count) truncated = true
      for (index in 0 until admitted) queue.add(Triple(child(node, index), "$path/$index", depth + 1))
    }
    return Pair(rows, truncated)
  }
}
