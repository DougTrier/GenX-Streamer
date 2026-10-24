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

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/**
 * The installed APK itself, for Send the app (docs/share-links.md): Quick
 * Share, Bluetooth and messaging apps read this copy's own file through one
 * read-only address, so no second 85 MB copy is made. Not exported; a
 * receiving app reads it only through the grant on the share intent.
 * Nothing else is reachable here: no other path, no writes.
 */
class InstalledApkProvider : ContentProvider() {
  companion object {
    const val MIME = "application/vnd.android.package-archive"
    /** The only path this provider answers. */
    const val PATH = "/GenX-Streamer.apk"
    fun uri(packageName: String): Uri = Uri.parse("content://$packageName.installedapk$PATH")
  }

  private fun apk(uri: Uri): File {
    if (uri.path != PATH) throw FileNotFoundException("Only the installed app is shared here")
    val info = context?.applicationInfo ?: throw FileNotFoundException("No application")
    // A split install is never shared as one file (it would not install).
    if (!info.splitSourceDirs.isNullOrEmpty()) throw FileNotFoundException("Split install")
    return File(info.sourceDir)
  }

  override fun onCreate(): Boolean = true

  override fun getType(uri: Uri): String? = if (uri.path == PATH) MIME else null

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw SecurityException("Read only")
    return ParcelFileDescriptor.open(apk(uri), ParcelFileDescriptor.MODE_READ_ONLY)
  }

  override fun query(uri: Uri, projection: Array<out String>?, selection: String?,
                     selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
    val file = apk(uri)
    val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
    val row = columns.map { column ->
      when (column) {
        OpenableColumns.DISPLAY_NAME -> "GenX-Streamer.apk"
        OpenableColumns.SIZE -> file.length()
        else -> null
      }
    }.toTypedArray()
    return MatrixCursor(columns, 1).apply { addRow(row) }
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? = throw SecurityException("Read only")
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int =
    throw SecurityException("Read only")
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
    throw SecurityException("Read only")
}
