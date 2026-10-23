package com.tmg.tv

import android.app.Activity
import android.util.Base64
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class ManifestSealArgs {
  var binding: String = ""
  var plaintext: String = ""
}

@InvokeArg
class ManifestOpenArgs {
  var binding: String = ""
  var ciphertext: String = ""
}

/** Rust mobile bridge only: no frontend command handler exports page material. */
@TauriPlugin
class ScanManifestProtectorPlugin(activity: Activity) : Plugin(activity) {
  private val vaultContext = activity.applicationContext
  private val cipher = ScanManifestCipher(AndroidScanManifestKeys())
  // One actual crypto job, one bounded handoff page, no permanent idle worker.
  private val worker = ManifestCryptoWorker()

  override fun onDestroy(activity: AppCompatActivity) {
    // Root native WorkGuard shutdown joins admitted calls before activity exit.
    // An unexpected lifecycle destruction still cannot interrupt actual crypto.
    worker.shutdown()
  }

  private fun reply(invoke: Invoke, failure: ManifestProtectionFailure) {
    invoke.resolveObject(mapOf("schemaVersion" to 1, "code" to failure.code))
  }

  private fun decode(value: String, limit: Int): ByteArray {
    if (value.length > ((limit + 2) / 3) * 4)
      throw ManifestProtectionException(ManifestProtectionFailure.Invalid)
    val bytes = try { Base64.decode(value, Base64.NO_WRAP) }
      catch (_: IllegalArgumentException) { throw ManifestProtectionException(ManifestProtectionFailure.Invalid) }
    if (bytes.size > limit || Base64.encodeToString(bytes, Base64.NO_WRAP) != value) {
      bytes.fill(0)
      throw ManifestProtectionException(ManifestProtectionFailure.Invalid)
    }
    return bytes
  }

  private fun run(invoke: Invoke, binding: String, value: String, sealing: Boolean) {
    val limit = if (sealing) ScanManifestCipher.MAX_PLAINTEXT else ScanManifestCipher.MAX_CIPHERTEXT
    if (binding.isEmpty() || binding.length > ScanManifestCipher.MAX_BINDING ||
      value.length > ((limit + 2) / 3) * 4) {
      reply(invoke, ManifestProtectionFailure.Invalid)
      return
    }
    val admitted = worker.execute {
        var input: ByteArray? = null
        var output: ByteArray? = null
        var payload: String? = null
        var failure: ManifestProtectionFailure? = null
        try {
          input = decode(value, limit)
          output = if (sealing) cipher.seal(binding, input!!) else cipher.open(binding, input!!)
          payload = Base64.encodeToString(output, Base64.NO_WRAP)
        } catch (error: ManifestProtectionException) {
          failure = error.failure
        } catch (_: Exception) {
          failure = ManifestProtectionFailure.Platform
        } finally {
          input?.fill(0)
          output?.fill(0)
        }
        // Receipt follows actual crypto and owned byte-buffer cleanup.
        if (failure != null) ScanManifestLog.failed(if (sealing) "seal page" else "open page", failure!!.code, null)
        if (failure != null) reply(invoke, failure!!)
        else invoke.resolveObject(mapOf("schemaVersion" to 1, "payload" to payload!!))
    }
    if (!admitted) {
      ScanManifestLog.failed(if (sealing) "seal page" else "open page", ManifestProtectionFailure.Busy.code, null)
      reply(invoke, ManifestProtectionFailure.Busy)
    }
  }

  @Command fun sealManifestPage(invoke: Invoke) {
    val args = try { invoke.parseArgs(ManifestSealArgs::class.java) }
      catch (_: Exception) { reply(invoke, ManifestProtectionFailure.Invalid); return }
    run(invoke, args.binding, args.plaintext, true)
  }

  @Command fun openManifestPage(invoke: Invoke) {
    val args = try { invoke.parseArgs(ManifestOpenArgs::class.java) }
      catch (_: Exception) { reply(invoke, ManifestProtectionFailure.Invalid); return }
    run(invoke, args.binding, args.ciphertext, false)
  }
  @Command fun getNoBackupDirectory(invoke: Invoke) {
    try {
      invoke.resolveObject(mapOf("schemaVersion" to 1, "path" to vaultContext.noBackupFilesDir.canonicalPath))
    } catch (_: Exception) {
      invoke.resolveObject(mapOf("schemaVersion" to 1, "code" to "account-vault-path-unavailable"))
    }
  }
}
