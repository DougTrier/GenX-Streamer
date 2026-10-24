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

import java.io.InputStream
import java.io.OutputStream

/**
 * One remote connection to a paired TV (docs/send-to-tv.md), on its own
 * thread: it answers the TV's setup and keep-alive pings, and records which
 * app is in front. When the TV stops answering or the connection breaks,
 * `open` turns false, so the page reports "Couldn't connect." instead of
 * waiting: nothing here is silently swallowed into an apparent success.
 */
internal class TvRemoteSession(
  private val input: InputStream,
  private val output: OutputStream,
  private val version: String,
  private val closer: () -> Unit,
) {
  @Volatile var model = ""
  @Volatile var front = ""
  @Volatile var changes = 0
  @Volatile var ready = false
  @Volatile var open = true
  /** null until the TV says. */
  @Volatile var screenOn: Boolean? = null

  @Synchronized fun send(message: ByteArray) {
    if (!open) throw IllegalStateException("tv-disconnected")
    try {
      output.write(TvWire.frame(message))
      output.flush()
    } catch (error: Exception) {
      close()
      throw IllegalStateException("tv-disconnected")
    }
  }

  fun run() {
    try {
      while (open) {
        when (val event = TvRemote.read(TvWire.readFrame(input))) {
          is TvEvent.Configure -> { model = event.model; send(TvRemote.configureReply(version)) }
          is TvEvent.SetActive -> { send(TvRemote.setActiveReply()); ready = true }
          is TvEvent.Ping -> send(TvRemote.pingReply(event.value))
          is TvEvent.FrontApp -> { front = event.app; changes += 1 }
          is TvEvent.Screen -> screenOn = event.on
          TvEvent.Other -> {}
        }
      }
    } catch (_: Exception) {
      // The connection ended or the TV sent something unreadable: reported as closed below.
    } finally { close() }
  }

  fun close() {
    open = false
    try { closer() } catch (_: Exception) {}
  }
}
