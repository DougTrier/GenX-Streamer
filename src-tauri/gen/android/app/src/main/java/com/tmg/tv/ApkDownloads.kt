package com.tmg.tv

import android.app.Activity
import android.content.Intent
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * W16 (docs/web-viewer-invariants.md): a website may hand GenX an Android app
 * (APK) to install. The viewer's click on the site's download link is the
 * consent to download (owner decision, October 19, 2026); installing always
 * passes Android's own installer confirmation. Every other download stays
 * refused (W06). Pure rules here; unit-tested in ApkRulesTest.
 */
object ApkRules {
  const val MIME = "application/vnd.android.package-archive"
  /** Larger than any real app GenX would be asked for; bounds storage use. */
  const val MAX_BYTES = 512L * 1024 * 1024
  const val MAX_REDIRECTS = 5

  /** An https address without credentials. */
  fun secure(raw: String): Boolean {
    val uri = try { URI(raw) } catch (_: Exception) { return false }
    return uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null
  }

  /** The file name a download names, from Content-Disposition or the address. */
  fun fileName(url: String, disposition: String?): String {
    val fromHeader = disposition?.let {
      Regex("filename\\*=(?:UTF-8'')?\"?([^\";]+)\"?", RegexOption.IGNORE_CASE).find(it)?.groupValues?.get(1)
        ?: Regex("filename=\"?([^\";]+)\"?", RegexOption.IGNORE_CASE).find(it)?.groupValues?.get(1)
    }
    val fromPath = try { URI(url).rawPath?.substringAfterLast('/') } catch (_: Exception) { null }
    val raw = try { java.net.URLDecoder.decode(fromHeader ?: fromPath ?: "", "UTF-8") } catch (_: Exception) { fromHeader ?: fromPath ?: "" }
    return raw.substringAfterLast('/').substringAfterLast('\\').filter { it.isLetterOrDigit() || it in "._-+ ()" }.trim().take(120)
  }

  /**
   * An Android app (APK) by its type or its .apk name, whatever type the site
   * labels it; never XAPK/APKS bundles or other files. Android must still read
   * the downloaded file as an app before it is opened.
   */
  fun isApk(url: String, mime: String?, disposition: String?): Boolean {
    if (!secure(url)) return false
    val type = mime?.substringBefore(';')?.trim()?.lowercase()
    return type == MIME || fileName(url, disposition).lowercase().endsWith(".apk")
  }

  /** App bundles (XAPK, APKS, APKM) that Android's installer cannot open. */
  fun isBundle(url: String, mime: String?, disposition: String?): Boolean {
    val type = mime?.substringBefore(';')?.trim()?.lowercase()
    val name = fileName(url, disposition).lowercase()
    return type == "application/xapk-package-archive" ||
      listOf(".xapk", ".apks", ".apkm").any { name.endsWith(it) }
  }

  /** Same host (cookies are sent only there, never to a redirect elsewhere). */
  fun sameHost(a: String, b: String): Boolean = try {
    URI(a).host.equals(URI(b).host, ignoreCase = true)
  } catch (_: Exception) { false }

  /** The first 4 bytes of an APK: it is a ZIP archive. */
  fun looksLikeZip(head: ByteArray) =
    head.size >= 4 && head[0] == 0x50.toByte() && head[1] == 0x4B.toByte() && head[2] == 0x03.toByte() && head[3] == 0x04.toByte()
}

/**
 * Downloads one offered APK at a time into GenX's cache (https only, redirects
 * kept on https, size-capped), checks that Android reads it as an app, then
 * opens Android's installer. The file is deleted before the next download, at
 * start-up and when GenX closes (W15).
 */
class ApkInstaller(private val activity: Activity) {
  private val busy = AtomicBoolean(false)
  private val folder get() = File(activity.cacheDir, "apk-downloads")

  fun cleanup() { folder.listFiles()?.forEach { it.delete() } }

  private fun tell(message: String) = activity.runOnUiThread {
    Toast.makeText(activity, message, Toast.LENGTH_LONG).show()
  }

  fun refused(kind: String) = tell(
    if (kind == "bundle") "That is an app bundle (XAPK/APKM), which Android's installer can't open. Choose the site's APK version."
    else "GenX downloads Android apps (APK) only; this file was not downloaded.",
  )

  fun start(url: String, userAgent: String?, referer: String?, disposition: String?, mime: String?, cookie: String? = null) {
    if (!ApkRules.isApk(url, mime, disposition)) return
    if (!busy.compareAndSet(false, true)) { tell("An app is already downloading."); return }
    val name = ApkRules.fileName(url, disposition).ifEmpty { "app.apk" }
    tell("Downloading $name…")
    Thread {
      try {
        cleanup()
        folder.mkdirs()
        val file = File(folder, "download.apk")
        val failure = download(url, userAgent, referer, cookie, file)
        if (failure != null) { file.delete(); tell(failure); return@Thread }
        // Android must read it as an app; anything else is deleted unopened.
        if (activity.packageManager.getPackageArchiveInfo(file.path, 0) == null) {
          file.delete(); tell("$name is not an Android app, so it was not opened."); return@Thread
        }
        activity.runOnUiThread { install(file, name) }
      } catch (_: Exception) {
        tell("$name could not be downloaded.")
      } finally {
        busy.set(false)
      }
    }.also { it.name = "genx-apk-download"; it.isDaemon = true }.start()
  }

  /** Null when the file is complete; otherwise the viewer's reason. */
  private fun download(start: String, userAgent: String?, referer: String?, cookie: String?, file: File): String? {
    var address = start
    repeat(ApkRules.MAX_REDIRECTS + 1) {
      if (!ApkRules.secure(address)) return "That download is not secure (https), so it was refused."
      val connection = (URL(address).openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
        connectTimeout = 15_000
        readTimeout = 30_000
        userAgent?.takeIf { it.length < 512 }?.let { setRequestProperty("User-Agent", it) }
        referer?.takeIf { ApkRules.secure(it) }?.let { setRequestProperty("Referer", it) }
        // The page's own cookies for this site (some download links need its
        // session), only to the site the viewer clicked on.
        cookie?.takeIf { ApkRules.sameHost(address, start) && it.length < 8192 }?.let { setRequestProperty("Cookie", it) }
      }
      try {
        val status = connection.responseCode
        if (status in 300..399) {
          address = URL(URL(address), connection.getHeaderField("Location") ?: return "The download link did not lead to a file.").toString()
          return@repeat
        }
        if (status !in 200..299) return "The site refused the download ($status)."
        if (connection.contentLengthLong > ApkRules.MAX_BYTES) return "That app is too large to download here."
        connection.inputStream.use { input ->
          file.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024)
            var total = 0L
            var head = ByteArray(0)
            while (true) {
              val n = input.read(buffer)
              if (n < 0) break
              total += n
              if (total > ApkRules.MAX_BYTES) return "That app is too large to download here."
              if (head.size < 4) head += buffer.copyOf(minOf(n, 4 - head.size))
              output.write(buffer, 0, n)
            }
            if (!ApkRules.looksLikeZip(head)) return "That download is not an Android app, so it was not opened."
          }
        }
        return null
      } finally {
        connection.disconnect()
      }
    }
    return "The download link redirected too many times."
  }

  private fun install(file: File, name: String) {
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, ApkRules.MIME)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      activity.startActivity(intent)
      tell("Android will ask before installing $name.")
    } catch (_: Exception) {
      tell("This device has no app installer to open $name.")
    }
  }
}
