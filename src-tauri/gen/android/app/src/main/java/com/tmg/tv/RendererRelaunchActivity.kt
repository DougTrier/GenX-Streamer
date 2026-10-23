package com.tmg.tv

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.content.Intent
import android.system.Os
import android.system.ErrnoException
import android.system.OsConstants

/** Nonexported foreground helper. Never loads Rust, a WebView, a library or a scan. */
class RendererRelaunchActivity : Activity() {
  private val handler = Handler(Looper.getMainLooper())
  private var retiredPid = 0
  private var deadline = 0L
  private var launched = false
  private var foreground = false
  private var blocked = false
  private var refusal: AlertDialog? = null
  private val check = Runnable { inspectRetiredProcess() }
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    retiredPid = intent.getIntExtra("retiredPid", 0)
    if (retiredPid <= 0 || retiredPid == Process.myPid()) { refuse(); return }
    setContentView(android.widget.TextView(this).apply { text = "Waiting for the previous screen to close…"; textSize = 20f; setPadding(32,32,32,32) })
  }
  override fun onResume() {
    super.onResume(); foreground = true
    if (!blocked) { if (deadline == 0L) beginWait() else inspectRetiredProcess() }
  }
  override fun onPause() { foreground = false; handler.removeCallbacks(check); super.onPause() }
  private fun beginWait() {
    if (retiredPid <= 0 || retiredPid == Process.myPid()) { refuse(); return }
    blocked = false; deadline = SystemClock.elapsedRealtime() + 5000; inspectRetiredProcess()
  }
  private fun inspectRetiredProcess() {
    if (!foreground || blocked || isFinishing || isDestroyed || launched) return
    val absent = try { Os.kill(retiredPid, 0); false }
      catch (error: ErrnoException) { if (error.errno != OsConstants.ESRCH) { refuse(); return }; true }
    if (absent) {
      try {
        launched = true
        startActivity(Intent(this, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
          .putExtra("genxRendererRecovered", true))
        finishAndRemoveTask()
      } catch (_: RuntimeException) { launched = false; refuse() }
    } else if (SystemClock.elapsedRealtime() >= deadline) refuse()
    else handler.postDelayed(check, 40)
  }
  private fun refuse() {
    blocked = true
    handler.removeCallbacks(check)
    refusal?.dismiss()
    refusal = AlertDialog.Builder(this).setTitle("Reopen not ready")
      .setMessage("The previous app process has not been confirmed closed. Retry or close this screen.")
      .setCancelable(false).setPositiveButton("Retry") { _, _ -> beginWait() }
      .setNegativeButton("Close") { _, _ -> finishAndRemoveTask() }.create().also { it.show() }
  }
  override fun onDestroy() {
    handler.removeCallbacks(check); refusal?.dismiss(); refusal = null; super.onDestroy()
    if (isFinishing) Process.killProcess(Process.myPid()) // Dedicated helper process, never the replacement.
  }
}
