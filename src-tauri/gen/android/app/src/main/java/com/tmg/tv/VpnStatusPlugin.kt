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

import android.app.Activity
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * Whether any VPN network is connected on this device, for the header's VPN
 * shield (docs/vpn-indicator.md). Read-only: GenX never starts, stops or
 * configures a VPN. Android does not say which app owns the VPN.
 */
@TauriPlugin
class VpnStatusPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun status(invoke: Invoke) {
        val result = JSObject()
        result.put("connected", VpnStatusRules.connected(activity.getSystemService(ConnectivityManager::class.java)))
        invoke.resolve(result)
    }
}

object VpnStatusRules {
    /** A network counts only while it is connected and carries the VPN transport. */
    @Suppress("DEPRECATION") // allNetworks also sees a VPN that excludes this app.
    fun connected(manager: ConnectivityManager?): Boolean {
        if (manager == null) return false
        return manager.allNetworks.any { network ->
            manager.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
        }
    }
}
