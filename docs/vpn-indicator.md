# VPN shield

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

Owner request, October 18, 2026: a small shield marked "V" in the header (first drafted with "VPN"; the owner chose the single letter) shows whether a VPN connection is up on this device. GenX does not include, start, stop or configure a VPN; it only looks.

## What it shows

| State | Shield | Label (tooltip and spoken) |
|---|---|---|
| A VPN connection is up | green | `VPN connected` (Windows adds the adapter name, e.g. `· NordLynx Tunnel`) |
| No VPN connection | red | `No VPN connected` |
| The device could not answer | grey | `VPN status could not be checked` |

Nothing shows until the first answer, and nothing shows in a browser (only the installed app can ask the system). It is checked on start, every 15 seconds while the app is visible, when the app comes back to the foreground and when the network goes on or off line. Status is shown only; it is never logged.

## How each platform answers

- **Android** (`VpnStatusPlugin`): any connected network with the VPN transport (`NetworkCapabilities.TRANSPORT_VPN`), including a VPN that excludes GenX by split tunnelling. It needs the ordinary `ACCESS_NETWORK_STATE` permission, which Android grants without asking. Android does not say which app owns the VPN, so there is no name.
- **Windows** (`vpn_status.rs`): an adapter that is up and has an address, and is either a Windows VPN connection (PPP: IKEv2, L2TP, PPTP, SSTP) or named like a VPN client (NordLynx, WireGuard, Wintun, OpenVPN/TAP, NordVPN, Proton, ExpressVPN, Surfshark, Mullvad, or "VPN"). Always-on system tunnels (Teredo, ISATAP, 6to4, IP-HTTPS) and loopback never count. A VPN whose adapter has an unusual name may read as "No VPN connected".

## Turning a VPN on or off

Not from GenX. Android does not let one app switch another app's VPN, and NordVPN publishes no command other apps may use. A possible follow-up is a tap on the shield that opens the VPN app or the system's VPN settings.

## Where it sits

Below "Streamer", centred between the end of the tagline ("…GETS OLD") and the first library button, sized from the wordmark (13–20 px tall, about a third of its height; the owner asked for a small badge) and kept clear of the "Streamer" script. It is absolutely placed, so the header's layout does not change; where there is no room (phones, where the header has no wordmark, or wrapped buttons) it steps aside. It is not a control and takes no remote focus.

Tests: `src-tauri/src/platform/vpn_status.rs` (adapter rules, names, a real read of the build machine's adapters), `tests/guide/vpn-indicator-browser.test.ts` (placement at TV/PC/large sizes, colours and labels, stale answers, disposal, phones, reply validation).
