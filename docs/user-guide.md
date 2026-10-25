# GenX Streamer user guide

## Add your channels

Inside **Settings**, choose the current section name to reveal the section list within the same window. Select a section to return to its controls. Back/Escape first collapses the list, then closes Settings; directional remote keys move focus, and OK opens the list.

Choose **Add channels**. Enter your source URL and choose **Add source**, or select a playlist file. The app checks the content; a particular filename extension is not required. Enable **Allow unencrypted HTTP** only when your source needs it. GenX does not supply a channel subscription or built-in provider addresses.

**Review source** lets you choose channels before saving. For several configured URL sources, use **Settings → Find channels → Scan configured sources**, select the results you want, then **Save channels**. Optional **Check selected channels** uses the chosen check time. “Stream responded” means the stream responded to that check; it does not guarantee playback. **Saved checks** shows when and where earlier checks occurred. Imported history and different check settings are identified separately.

To find sources, choose **Add channels → Find sources**, enter a website or GitHub page URL, then **Scan website**. Select a possible source and review its channels before saving. The same action is available under **Settings → Find channels → Find sources**. This examines that page's links without running its scripts or searching the whole web. Close or Back returns to the control that opened it.

**Refresh** below the channel list updates saved URL sources. File sources need their file selected again. Refresh failures retain that source's saved channels; the progress dialog reports failures and cancellation. Canceling a multi-source refresh retains sources already saved before cancellation. Refresh is unavailable when there are no saved URL sources.

## Browse and watch

Select a channel to watch. Use **All**, **Favorites**, **News**, **Sports**, or search to narrow the list. **Favorite** remembers the selected channel. Under **Location and sort**, choose **Country**, **Region**, **State / subdivision** and an ordering. **Unknown** means location metadata is missing; it does not mean the stream is local or accessible in your location.

Live TV's left list shows channels you can select for live playback, with no separate Programs window. Playing a channel keeps your search text. The right pane is reserved for video and the compact controls below it. Open **Guide** for program listings, details and channel mapping; guide availability does not guarantee that a stream will play.

**Remove channel** hides a channel across refreshes. Restore these channels through **Settings → Sources → Restore removed channels**. Removing a source in Settings removes its catalog channels. If all channels have been removed, the channel panel points you to restoration; if saved sources contain no channels, it points you to updating or replacing a source.

Controls below the video provide **Pause / Resume**, **Mute / Unmute**, volume, **Expand / Show channels**, and **Full screen / Exit full screen**. Expand gives the video more space without entering fullscreen. Drag the divider to resize the panels; with keyboard focus on the divider, use Left/Right. On compact screens, **Viewing panel** switches between Watch and Channels.

Connecting and Buffering messages describe work in progress. If the app pauses playback in the background, return and choose **Resume** explicitly. Resuming a live stream reconnects to its current live position. Background-canceled imports and scans need an explicit retry; they do not restart automatically.

With a directional remote, arrows move focus and OK/Enter activates. From the channel list, Right moves to player controls; Left returns from the first control. A text field reached by directional navigation needs OK/Enter to begin editing. Back/Escape first leaves editing, then closes the open dialog. Outside a dialog, Back exits fullscreen before requesting application exit. **Show channels** restores an expanded panel. Pointer and Tab navigation keep normal text editing. Available keys depend on the remote and operating system.

## Programs and voice

To close the application, choose **Settings → Exit app**. This uses the normal cleanup process for playback, casting, source scans and sharing. If cleanup fails, the app remains open with Retry closing and a separate explicit Force quit choice. Browser previews explain that you must close their browser tab.

Open **Guide**, then use **Guide view** to choose **Guide sources**, **Channel mapping**, **Choose channel / day**, or **Search programs**.

Add your XMLTV URL or file under **Guide sources**. **Save source and preview** saves its configuration; schedule data changes only after you review and save the preview. A failed refresh retains the previous schedule. Map your catalog channel to the correct guide channel, checking its affiliate, region and time variant. Suggested matches need your review.

For program search, open **Guide → Search programs** and type a phrase such as “Chicago Bears”. Live TV’s search shows channel results only and keeps your query when you play a channel. **All guides** searches mapped channels across your configured feeds. The search window runs from now to just before seven days later. Listed freshness and coverage tell you what the feeds actually provide; seven-day search does not promise seven days of listings. Missing end times and overlapping listings may prevent a definite current-program result. Selecting a future program opens its details; it does not schedule recording or automatically tune. **Watch channel** deliberately opens its live channel.

**Voice search** captures one request using available on-device recognition. Choose it to start and **Stop voice input** to finish. The final text enters the editable search field; it does not tune a channel. The current app refuses cloud fallback. If microphone permission, language models or recognition are unavailable, type instead.

## Share what you are watching

Choose **Share** beside the playing channel: GenX shows the link as a QR code to scan, with **Copy** and **Send…** ("Watch News 24 on GenX Streamer" and the link, through your device's share sheet: messages, mail, Quick Share, Nearby Sharing). Free TV channels and GenXtra titles can be shared; Paid TV channels cannot, because their addresses contain your account details. The link carries only the channel's name, logo and public stream address. Where a device has no share sheet (many TVs), GenX shows the link to copy instead.

When someone shares a link with you, it opens GenX Streamer with "<name> was shared with you". Choose **Play** to watch or **Add to favorites** to keep it; nothing plays until you choose. GenX checks the channel first and tells you plainly when it has moved, ended, only plays in certain countries, or cannot be reached. Without GenX Streamer, the link opens a web page that says what was shared and where to get the app.

To pass on GenX Streamer itself, choose **Send app to a friend** at the top of **Settings** (also in **About GenX Streamer**) to open **Pass It Along**. **Install on TV** (Android) puts GenX Streamer on a Google TV or Android TV on the same Wi-Fi: pick the TV, enter the code it shows, and approve on the TV with its remote. If the TV has no app to download with, it asks you to install a free download helper first. The card says **Ready! GenX Streamer is installed.** only once GenX has opened on the TV. **Share with everyone nearby** lets friends on the same Wi-Fi scan a code with their camera, or type the short address it shows (such as `192.168.1.20:8080/482913`, easy on a TV remote), and download GenX Streamer straight from your device, with no internet or store; each device gets the version that runs on it, or is told plainly when none does. It stops after 10 minutes, when you choose **Stop sharing**, when your device leaves the Wi-Fi, or when someone keeps trying wrong codes, and shows how many friends got it. On Android, **Send the app** sends this installed app phone to phone with Quick Share, Bluetooth or a messaging app (the other phone opens the received file and allows Files or Quick Share to install apps when asked); on Windows, **Send the app file** sends GenX Streamer.exe. **Send the download link** shares the download page by text or message, **Show QR code** lets them scan it, and **Copy link** copies it; on Windows, **Send the Windows ZIP link** points to the portable ZIP. Sending the app itself is available from official release copies; a development copy sends the link or the code instead. To check a copy is genuine, see **About GenX Streamer → This copy** (version and build) and **Show checksum**, and compare it with `SHA256SUMS` on the release page. An app sent from your phone carries your copy's signing: a later official build may need it uninstalled first.

## Updates

Updates are always optional; GenX Streamer never updates without your permission and never checks on its own. In **Settings → About GenX Streamer**, choose **Check for updates**. If a newer version is available you see both versions and what's new; **Download update** fetches it and checks it against the official release, and **Install update** installs it: on Windows, choose **Restart now** (or open GenX later) to start the new version; on Android, Android's installer asks you first. Your channels, favorites, accounts and settings stay. **Not now** changes nothing, and without internet GenX keeps working as it is.

## Cast to a TV

Open **Cast** and choose **Nearby TV**, **Venue instructions**, or **Known receiver**. Nearby discovery looks for Chromecast and DLNA receivers. Known receiver checks a local address without sending video. Follow a hotel or conference TV's own pairing instructions; GenX cannot create a room PIN or bypass an isolated network.

Select the receiver, compare its details with the intended TV, then choose **Confirm TV and cast**. Select a channel before casting. If its identity cannot be freshly rechecked, an additional acknowledgment is required. Names and reported identifiers do not establish room ownership. A changed receiver or network needs fresh confirmation.

Under **Stream delivery**, the optional Chromecast relay requires consent to unencrypted HTTP between this device and the TV. It is separate from encrypted LAN viewing. Provider restrictions and receiver codec support can still prevent playback. **Stop casting** stops the owned cast; closing the dialog does not. If Stop is unconfirmed, keep the app open and retry. Receiver and venue compatibility vary and remain subject to device testing.

## Watch or control from another device

Windows **Settings → LAN viewing and phone control** offers **Start sharing** under **Connection setup**. Choose the listening address/port and certificate/private-key files. The other device must trust a certificate valid for that address. The app does not install trust exceptions or change firewall/router settings. Sharing does not start automatically.

Create a **New view-only invitation**, open the displayed HTTPS address on the other device, and pair using that invitation. Press **Watch** on the viewer to begin. This viewer supports the host's published HLS stream; connecting to a channel or importing a catalog does not publish video. Direct non-HLS media is not supported by this viewer.

For phone control, select the allowed channels and choose **Invite scoped phone controller**. This separate invitation permits the offered player actions and selected channels; a viewer invitation grants no control. Use **Disconnect** to revoke a connected device or **Stop sharing** to end the session. Cross-device viewing requires working certificate trust, network access and compatible playback; phone setup is not a universal one-click flow.

## Backups and saved data

**Settings → Audio and preferences** exports or imports settings. **Full backup** saves channels, preferences, favorites, removed-channel markers and saved check history. Its reviewed import replaces those saved records. Imported checks remain historical rather than fresh playback proof. Guide sources, mappings and schedules are not included: keep their source details separately. Backups can contain private provider URLs; store them privately.

**Import previous app** accepts a JSON file you choose and previews supported channels, favorites and removals. It preserves unrelated sources and does not modify the previous project. Review unresolved or ambiguous entries before saving.

On Windows, extract the entire portable ZIP to a writable folder before opening the executable. Windows needs WebView2 Runtime; the executable alone does not supply it. Windows normally uses its application-data folder. For a portable candidate, `tmg-portable.flag` beside the executable selects a sibling `data` folder when writable. An explicit absolute `TMG_DATA_DIR` selects another folder.

If **Saved data needs attention** appears, retry or use the offered **Writable data folder** / **Use this folder** controls. The chosen folder opens its existing library or starts an empty one; your previous library stays untouched. This is not automatic migration. The alternate choice is remembered for that executable location, so moving the executable may require choosing again. With `TMG_DATA_DIR`, correct that location and restart. Android uses private app storage and offers retry/exit rather than an external-folder choice.

If the message says saved data is **in use**, close other apps using that library and choose **Retry saved data**. A locked library is not replaced from backup, and this state offers retry rather than a different data folder.

On Android, open the supplied APK with your device's package installer. If prompted, permit installation for the file manager or browser you deliberately used to open it. The current candidate targets ARM64 devices. Back up before Android updates. An APK update must use a compatible signing identity; uninstalling or clearing app data removes the library.

## Development builds

This guide describes implemented controls, not a signed release guarantee. Current development candidates may be unsigned or debug-signed. Complete receiver, phone-sharing, clean-environment portability and release checks remain pending. A browser development preview cannot provide native casting or native guide/storage behavior. Do not assume a development APK can update to a differently signed release without preserving its data first.

**Moving to the official release on Android:** a release-signed GenX Streamer cannot install over a development copy. First save a **Full backup** (Settings → Audio and preferences), then uninstall the development copy, install the release, and import the backup. About GenX Streamer → **This copy** shows which one you have (Official release or Development build).
