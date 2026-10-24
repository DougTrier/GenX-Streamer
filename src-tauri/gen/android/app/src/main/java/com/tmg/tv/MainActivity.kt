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

import android.webkit.WebView
import android.view.accessibility.AccessibilityNodeInfo
import android.Manifest
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.result.contract.ActivityResultContracts
import android.view.KeyEvent
import android.view.WindowManager
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.WindowInsets
import android.view.WindowInsetsAnimation
import android.graphics.Rect
import android.os.Build
import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.OnBackPressedCallback
import androidx.core.graphics.Insets
import androidx.core.view.WindowCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  /** While a website is shown inside the app, remote keys reach its view first, whatever has focus. */
  var pageKeys: ((KeyEvent) -> Boolean)? = null
  override fun dispatchKeyEvent(event: KeyEvent): Boolean =
    pageKeys?.invoke(event) == true || super.dispatchKeyEvent(event)
  private var rendererRetired = false
  private var rendererDestroyConfirmed = false
  fun retireRenderer(dead: WebView): Boolean {
    if (rendererDestroyConfirmed) return true
    setViewingFullscreen(false)
    rendererRetired = true
    viewingForeground = false
    cancelViewingForegroundPost()
    viewingLifecycleOwner.destroy()
    shellFocusOwner.invalidate()
    clearShellFocusLayout(); clearImeObservation()
    dead.removeOnAttachStateChangeListener(shellFocusAttachment)
    viewingWakeOwner.clear(); clearBackOwner(); cancelSpeechPermission()
    notifyNativeResourcesStopped?.invoke()
    notifyAppForeground = null; notifyAppBackground = null
    notifyFullscreenExit = null; notifyBackRequest = null
    viewingWakeWebView = null
    rendererDestroyConfirmed = retireOwnedRenderer(
      clearPhysical = {
        dead.clearFocus()
        dead.performAccessibilityAction(AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS, null)
      },
      clearVirtual = {
        // Public API clears the owned host AND virtual descendants through ViewRoot while attached.
        // Do not call AccessibilityNodeInfo.performAction (AccessibilityService-only), use hidden
        // ViewRoot methods, guess virtual IDs, or disable accessibility for the Activity/dialog.
        dead.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      },
      detach = { (dead.parent as? ViewGroup)?.removeView(dead) },
      destroy = { dead.destroy() })
    return rendererDestroyConfirmed
  }

  private var speechPermissionResult: ((Boolean) -> Unit)? = null
  private var speechPermissionOwner: String? = null
  private var speechPermissionPending = false
  private val speechPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    speechPermissionPending = false
    val callback = speechPermissionResult
    speechPermissionResult = null
    speechPermissionOwner = null
    callback?.invoke(granted)
    requestViewingForegroundReplay()
  }
  fun requestSpeechPermission(id: String, callback: (Boolean) -> Unit) {
    if (!isViewingForeground() || speechPermissionPending) {callback(false);return}
    speechPermissionOwner = id
    speechPermissionResult = callback
    speechPermissionPending = true
    speechPermission.launch(Manifest.permission.RECORD_AUDIO)
  }
  fun cancelSpeechPermission(id: String? = null) {
    if (id == null || speechPermissionOwner == id) {
      val callback = speechPermissionResult
      speechPermissionResult = null
      speechPermissionOwner = null
      callback?.invoke(false)
    }
  }
  override val handleBackNavigation: Boolean = false
  private val backOwner=BackOwnership()
  private val backHandler=Handler(Looper.getMainLooper())
  private var backFallback:Runnable?=null
  private var viewingFullscreen = false
  private var viewingForeground = false
  private val viewingLifecycleOwner = ViewingLifecycleOwner()
  private val viewingLifecycleHandler = Handler(Looper.getMainLooper())
  private var viewingForegroundPost: Runnable? = null
  private var viewingWakeWebView: WebView? = null
  // Observe our own sibling view; never replace Wry/the WebView's inset listener.
  private var imeProbe: View? = null
  private var imeLayoutObserver: ViewTreeObserver? = null
  private var imeSequence = 0L
  private var imeLastMeasurement: String? = null
  private val imeGlobalLayout = ViewTreeObserver.OnGlobalLayoutListener { publishImeInsets() }
  private val shellFocusOwner = TelevisionShellFocusOwner()
  private var shellFocusLayoutView: WebView? = null
  private val shellFocusFirstLayout = View.OnLayoutChangeListener { view, _, _, _, _, _, _, _, _ ->
    if (view === viewingWakeWebView && view.width > 0 && view.height > 0 &&
      ViewCompat.getRootWindowInsets(view) != null) {
      clearShellFocusLayout()
      requestShellFocus()
      requestViewingForegroundReplay()
    }
  }
  private val shellFocusAttachment = object : View.OnAttachStateChangeListener {
    override fun onViewAttachedToWindow(view: View) {
      if (view === viewingWakeWebView) {
        bindImeObservation(view as WebView)
        armShellFocusLayout(view as WebView)
        requestShellFocus()
        requestViewingForegroundReplay()
      }
    }
    override fun onViewDetachedFromWindow(view: View) {
      if (view === viewingWakeWebView) {
        shellFocusOwner.invalidate()
        cancelViewingForegroundPost()
        clearImeObservation()
        clearShellFocusLayout()
      }
    }
  }
  private val viewingWakeOwner = ViewingWakeOwner({ hold ->
    if (hold) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }, { hold -> viewingWakeWebView?.keepScreenOn = hold })
  private val fullscreenBack = object : OnBackPressedCallback(true) {
    override fun handleOnBackPressed() {
      if (notifyBackRequest == null) {
        if (viewingFullscreen) exitNativeFullscreen()
        return
      }
      val id = backOwner.issue() ?: return
      val fallback=Runnable {
        if (backOwner.expire(id) && viewingFullscreen) exitNativeFullscreen()
        backFallback=null
      }
      backFallback=fallback
      backHandler.postDelayed(fallback,1500)
      notifyBackRequest?.invoke(id)
    }
  }
  fun acknowledgeBack(id:String) {
    if(backOwner.acknowledge(id)) {
      backFallback?.let {backHandler.removeCallbacks(it)}
      backFallback=null
    }
  }
  private fun exitNativeFullscreen() {
    setViewingFullscreen(false)
    notifyFullscreenExit?.invoke()
  }
  private fun clearBackOwner() {
    backOwner.clear()
    backFallback?.let {backHandler.removeCallbacks(it)}
    backFallback=null
  }
  var notifyFullscreenExit: (() -> Unit)? = null
  var notifyBackRequest: ((String) -> Unit)? = null
  var notifyAppBackground: ((Long) -> Unit)? = null
  var notifyAppForeground: ((Long) -> Unit)? = null
  var notifyNativeResourcesStopped: (() -> Unit)? = null

  override fun onPause() {
    viewingForeground = false
    cancelViewingForegroundPost()
    val background = viewingLifecycleOwner.pause()
    publishImeInsets(clear = true)
    shellFocusOwner.invalidate()
    clearBackOwner()
    viewingWakeOwner.clear()
    notifyNativeResourcesStopped?.invoke()
    // Run before Wry's process lifecycle observer pauses the WebView runtime.
    background?.let { notifyAppBackground?.invoke(it.sequence) }
    super.onPause()
  }

  override fun onResume() {
    super.onResume()
    // Foreground is not explicit playback consent; clear framework-restored owned bits.
    viewingWakeOwner.clear()
    viewingForeground = true
    viewingLifecycleOwner.resume()
    requestViewingForegroundReplay()
    imeLastMeasurement = null
    viewingWakeWebView?.let { ViewCompat.requestApplyInsets(it) }
    publishImeInsets()
    requestShellFocus()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // Reassert only the saved explicit viewing policy after framework focus handling.
    if (hasFocus) viewingWakeOwner.reconcile(isViewingForeground())
    if (hasFocus) requestShellFocus() else shellFocusOwner.invalidate()
    if (hasFocus) requestViewingForegroundReplay() else cancelViewingForegroundPost()
  }

  override fun onStop() {
    viewingForeground = false
    cancelViewingForegroundPost()
    viewingLifecycleOwner.pause()?.let { notifyAppBackground?.invoke(it.sequence) }
    shellFocusOwner.invalidate()
    viewingWakeOwner.clear()
    notifyNativeResourcesStopped?.invoke()
    super.onStop()
  }

  override fun onDestroy() {
    viewingForeground = false
    cancelViewingForegroundPost()
    viewingLifecycleOwner.destroy()?.let { notifyAppBackground?.invoke(it.sequence) }
    shellFocusOwner.invalidate()
    clearShellFocusLayout()
    clearImeObservation()
    viewingWakeWebView?.removeOnAttachStateChangeListener(shellFocusAttachment)
    viewingWakeOwner.clear()
    clearBackOwner()
    cancelSpeechPermission()
    notifyNativeResourcesStopped?.invoke()
    NativeVideoPlugin.release?.invoke()
    notifyAppForeground = null
    notifyAppBackground = null
    super.onDestroy()
  }

  fun isViewingForeground(): Boolean = !rendererRetired && viewingForeground && viewingLifecycleOwner.isResumed() && !isFinishing && !isDestroyed

  fun viewingLifecycleDiagnostics(): Map<String, Any?> = mapOf(
    "resumed" to viewingLifecycleOwner.isResumed(), "activityForeground" to viewingForeground,
    "windowFocused" to hasWindowFocus(), "bound" to (viewingWakeWebView != null),
    "attached" to viewingWakeWebView?.isAttachedToWindow, "shown" to viewingWakeWebView?.isShown,
    "permissionPending" to speechPermissionPending, "finishing" to isFinishing,
    "destroyed" to isDestroyed, "foregroundPostPending" to (viewingForegroundPost != null),
    "policy" to viewingLifecycleOwner.diagnostics())

  private fun cancelViewingForegroundPost() {
    viewingForegroundPost?.let { viewingLifecycleHandler.removeCallbacks(it) }
    viewingForegroundPost = null
    viewingLifecycleOwner.cancelReplay()
  }

  private fun canReplayViewingForeground(): Boolean {
    val view = viewingWakeWebView ?: return false
    return isViewingForeground() && hasWindowFocus() && !speechPermissionPending &&
      view.isAttachedToWindow && view.isShown
  }

  fun requestViewingForegroundReplay() {
    val ticket = viewingLifecycleOwner.request(canReplayViewingForeground()) ?: return
    val view = viewingWakeWebView
    val work = Runnable {
      viewingForegroundPost = null
      viewingLifecycleOwner.complete(ticket, viewingWakeWebView === view && canReplayViewingForeground()) { sequence ->
        val callback = notifyAppForeground ?: return@complete false
        try { callback(sequence); true } catch (_: RuntimeException) { false }
      }
    }
    viewingForegroundPost = work
    if (!viewingLifecycleHandler.post(work)) cancelViewingForegroundPost()
  }

  fun bindViewingWakeWebView(webView: WebView) {
    if (rendererRetired) return
    cancelViewingForegroundPost()
    viewingLifecycleOwner.rebind()
    // Own only this application's bound WebView, never its descendants or unrelated views.
    shellFocusOwner.invalidate()
    clearShellFocusLayout()
    if (viewingWakeWebView !== webView) {
      viewingWakeWebView?.keepScreenOn = false
      viewingWakeWebView?.removeOnAttachStateChangeListener(shellFocusAttachment)
      webView.addOnAttachStateChangeListener(shellFocusAttachment)
    }
    viewingWakeWebView = webView
    viewingWakeOwner.clear()
    bindImeObservation(webView)
    armShellFocusLayout(webView)
    requestShellFocus()
    requestViewingForegroundReplay()
  }

  private fun clearShellFocusLayout() {
    shellFocusLayoutView?.removeOnLayoutChangeListener(shellFocusFirstLayout)
    shellFocusLayoutView = null
  }

  private fun clearImeObservation() {
    imeLayoutObserver?.let { if (it.isAlive) it.removeOnGlobalLayoutListener(imeGlobalLayout) }
    imeLayoutObserver = null
    imeProbe?.let { (it.parent as? ViewGroup)?.removeView(it) }
    imeProbe = null
    imeLastMeasurement = null
  }

  private fun bindImeObservation(webView: WebView) {
    clearImeObservation()
    val content = findViewById<ViewGroup>(android.R.id.content)
    if (content != null) {
      val probe = object : View(this) {
        override fun onApplyWindowInsets(insets: WindowInsets): WindowInsets {
          publishImeInsets(insets)
          return super.onApplyWindowInsets(insets)
        }
      }
      probe.isFocusable = false
      probe.isClickable = false
      probe.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      if (Build.VERSION.SDK_INT >= 30) {
        probe.setWindowInsetsAnimationCallback(object : WindowInsetsAnimation.Callback(WindowInsetsAnimation.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
          override fun onProgress(insets: WindowInsets, runningAnimations: MutableList<WindowInsetsAnimation>): WindowInsets {
            publishImeInsets(insets)
            return insets
          }
          override fun onEnd(animation: WindowInsetsAnimation) { publishImeInsets() }
        })
      }
      content.addView(probe, ViewGroup.LayoutParams(0, 0))
      imeProbe = probe
      ViewCompat.requestApplyInsets(probe)
    }
    imeLayoutObserver = window.decorView.viewTreeObserver.also {
      it.addOnGlobalLayoutListener(imeGlobalLayout)
    }
    webView.post { if (viewingWakeWebView === webView) publishImeInsets() }
  }

  private fun publishImeInsets(applied: WindowInsets? = null, clear: Boolean = false) {
    val webView = viewingWakeWebView ?: return
    if (!webView.isAttachedToWindow || webView.height <= 0 || window.decorView.height <= 0) return
    val location = IntArray(2)
    val decorLocation = IntArray(2)
    webView.getLocationOnScreen(location)
    window.decorView.getLocationOnScreen(decorLocation)
    var visible = false
    var bottom = 0
    var imeTop = decorLocation[1] + window.decorView.height
    if (!clear && isViewingForeground()) {
      if (Build.VERSION.SDK_INT >= 30) {
        val insets = applied ?: window.decorView.rootWindowInsets ?: webView.rootWindowInsets
        if (insets != null) {
          visible = insets.isVisible(WindowInsets.Type.ime())
          bottom = if (visible) insets.getInsets(WindowInsets.Type.ime()).bottom else 0
          imeTop -= bottom
        }
      } else {
        // API24-29 do not provide platform Type.ime. Prefer the compat owner,
        // then use the actual OS-visible window frame, never JS viewport guesses.
        val compat = ViewCompat.getRootWindowInsets(webView)
        val frame = Rect()
        window.decorView.getWindowVisibleDisplayFrame(frame)
        val bars = compat?.getInsets(WindowInsetsCompat.Type.systemBars())?.bottom ?: 0
        val hidden = (decorLocation[1] + window.decorView.height - frame.bottom - bars).coerceAtLeast(0)
        visible = compat?.isVisible(WindowInsetsCompat.Type.ime()) == true ||
          hidden > (100 * resources.displayMetrics.density).toInt()
        if (visible) {
          bottom = (compat?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0).coerceAtLeast(hidden)
          val alreadyResized = window.decorView.height < resources.displayMetrics.heightPixels -
            (100 * resources.displayMetrics.density).toInt()
          imeTop = if (hidden > 0 || alreadyResized) frame.bottom else imeTop - bottom
        }
      }
    }
    bottom = bottom.coerceIn(0, window.decorView.height)
    val overlap = if (visible) (location[1] + webView.height - imeTop).coerceIn(0, webView.height) else 0
    val measurement = "$visible:$bottom:$overlap:${webView.height}"
    if (imeLastMeasurement == measurement) return
    imeLastMeasurement = measurement
    imeSequence += 1
    // Numeric geometry only: no input values, labels, credentials or UI snapshots.
    val script = """(() => {
      const detail={schemaVersion:1,visible:$visible,bottomPx:$bottom,overlapPx:$overlap,webViewHeightPx:${webView.height},sequence:$imeSequence};
      window.__genxImeInsets=detail;
      window.dispatchEvent(new CustomEvent('native-ime-insets',{detail}));
    })()""".trimIndent()
    webView.post {
      if (viewingWakeWebView === webView && !isDestroyed) {
        try { webView.evaluateJavascript(script, null) } catch (_: Exception) { /* Geometry can be reissued after rebind/resume. */ }
      }
    }
  }

  private fun armShellFocusLayout(webView: WebView) {
    clearShellFocusLayout()
    shellFocusLayoutView = webView
    webView.addOnLayoutChangeListener(shellFocusFirstLayout)
  }

  private fun shellFocusState(webView: WebView): ShellFocusState {
    val mode = (getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager)?.currentModeType
    val focus = currentFocus
    var ancestor: android.view.ViewParent? = webView.parent
    var structuralFocus = focus == null || focus === window.decorView
    while (ancestor is View) {
      if (ancestor === focus) structuralFocus = true
      ancestor = ancestor.parent
    }
    return ShellFocusState(
      TelevisionCapability.isTelevision(mode,
        packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK),
        packageManager.hasSystemFeature(PackageManager.FEATURE_TELEVISION)),
      isViewingForeground(), hasWindowFocus(), webView.isAttachedToWindow, webView.isShown,
      viewingFullscreen, webView.hasFocus(),
      ViewCompat.getRootWindowInsets(webView)?.isVisible(WindowInsetsCompat.Type.ime()),
      webView.onCheckIsTextEditor(), !structuralFocus && !webView.hasFocus(),
    )
  }

  private fun requestShellFocus() {
    val webView = viewingWakeWebView ?: return
    val ticket = shellFocusOwner.begin(shellFocusState(webView)) ?: return
    // Event-owned UI dispatch, not a timer or an application-readiness polling loop.
    if (!webView.post {
      if (viewingWakeWebView !== webView) return@post
      try {
        webView.evaluateJavascript("""(() => {
          const a = document.activeElement;
          const editor = !!a && (a.matches('textarea,select,[contenteditable]:not([contenteditable="false"])') ||
            (a instanceof HTMLInputElement && !a.readOnly && !a.disabled &&
              !['checkbox','radio','range','button','submit','reset','hidden','file','color'].includes(a.type)));
          return [!!document.querySelector('dialog[open]:not([data-primary-page])'), editor,
            !!document.fullscreenElement || !!document.querySelector('.viewing-fullscreen')];
        })()""".trimIndent()) { raw ->
          if (viewingWakeWebView === webView) {
            shellFocusOwner.complete(ticket, shellFocusState(webView), ShellFocusDomState.parse(raw)) {
              val previousFocusable = webView.isFocusable
              val previousTouchFocusable = webView.isFocusableInTouchMode
              webView.isFocusable = true
              webView.isFocusableInTouchMode = true
              val accepted = webView.isFocusable && webView.isFocusableInTouchMode && webView.requestFocus()
              if (!accepted) {
                webView.isFocusableInTouchMode = previousTouchFocusable
                webView.isFocusable = previousFocusable
              }
              accepted
            }
          }
        }
      } catch (_: Exception) {
        shellFocusOwner.complete(ticket, shellFocusState(webView), null) { false }
      }
    }) shellFocusOwner.complete(ticket, shellFocusState(webView), null) { false }
  }

  fun requestedViewingActive(): Boolean = viewingWakeOwner.requestedActive

  fun setViewingActive(enabled: Boolean) {
    if (rendererRetired) return
    viewingWakeOwner.request(enabled, isViewingForeground())
  }

  fun setViewingFullscreen(enabled: Boolean) {
    if (rendererRetired && enabled) return
    shellFocusOwner.invalidate()
    WindowCompat.setDecorFitsSystemWindows(window, !enabled)
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    if (enabled) controller.hide(WindowInsetsCompat.Type.systemBars())
    else controller.show(WindowInsetsCompat.Type.systemBars())
    viewingFullscreen = enabled
    findViewById<View>(android.R.id.content)?.let { ViewCompat.requestApplyInsets(it) }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, true)
    // Android 15+ draws every app edge to edge, under the status and navigation
    // bars and the camera cutout. Keep GenX clear of them, except in full screen
    // (bars hidden, picture edge to edge). Where the system already fits the
    // window (Android 14 and earlier, TVs) these insets arrive as zero.
    findViewById<ViewGroup>(android.R.id.content)?.let { content ->
      content.setBackgroundColor(0xFF080F24.toInt())
      ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
        val bars = if (viewingFullscreen) Insets.NONE
          else insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
        insets
      }
    }
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
    }
    onBackPressedDispatcher.addCallback(this, fullscreenBack)
    // Trier AutoTune: Stage A calibration in the background when idle.
    TrierAutoTune.schedule(this)
  }
}
