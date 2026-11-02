# GenX Streamer user guide

**Release status:** 0.1.25 / build 1025 has been withdrawn because of phone/handheld layout and Football/NFL search issues. Public downloads currently provide [0.1.3 / build 1003](https://github.com/DougTrier/GenX-Streamer/releases/tag/v0.1.3). Features and checks below describe the withdrawn development version unless another version is stated; they do not establish acceptance of a replacement release.

## Supported devices

GenX Streamer supports Windows 10/11 (64-bit) and Android 7.0 or newer on
32- or 64-bit ARM devices: Android TV, Google TV, Android phones, tablets and
handhelds, and Amazon Fire TV / Fire TV Stick running Android-based Fire OS.
Fire TV uses the same Android APK from the official release.

Version 0.1.3 is verified on the first-generation Fire TV Stick 4K Max
(AFTKA/kara), Fire OS 7 / Android 9. Launch, embedded and fullscreen playback,
returning to embedded playback, sound and channel switching passed owner
testing. This verifies that model; other Amazon models have not been
individually tested. See the [Fire TV installation guide](https://dougtrier.github.io/GenX-Streamer/getting-started/#fire-tv).

## Add your channels

Inside **Settings**, choose the current section name to reveal the section list within the same window. Select a section to return to its controls. Back/Escape first collapses the list, then closes Settings; directional remote keys move focus, and OK opens the list.

Choose **Add channels**. Enter your source URL and choose **Add source**, or select a playlist file. The app checks the content; a particular filename extension is not required. Enable **Allow unencrypted HTTP** only when your source needs it. GenX does not supply a channel subscription or built-in provider addresses.

**Review source** lets you choose channels before saving. For several configured URL sources, use **Settings → Find channels → Scan configured sources**, select the results you want, then **Save channels**. Optional **Check selected channels** uses the chosen check time. “Stream responded” means the stream responded to that check; it does not guarantee playback. **Saved checks** shows when and where earlier checks occurred. Imported history and different check settings are identified separately.

To find sources, choose **Add channels → Find sources**, enter a website or GitHub page URL, then **Scan website**. Select a possible source and review its channels before saving. The same action is available under **Settings → Find channels → Find sources**. This examines that page's links without running its scripts or searching the whole web. Close or Back returns to the control that opened it.

**Refresh** below the channel list updates configured sources and reuses recent working checks for unchanged streams. New addresses are checked once even when several lists contain them. File sources need their file selected again. Failures and cancellation retain saved channels; the progress dialog reports incomplete work.

Large scans work in bounded batches and yield between them so browsing and controls remain responsive. **Stop** retains resumable progress; **Continue scan** reopens the saved job when its source and check settings are still compatible. Visible list updates keep their browsing anchor. Expensive guide reconnection is coalesced until the scan episode finishes; newly scanned channels may therefore gain their program links at that point. A complete catalog scan can take much longer than a playback check and is not required before receiving a verified release.

A full Refresh or Rescan with an empty search can also clean up missing Free TV channels. Every applicable list must refresh successfully, and every saved address of a missing channel must return HTTP 404 or 410. Favorites, listed addresses, recent working streams and uncertain failures stay saved. Cleanup pauses while playback or a Web page is active and limits extra checks to 20 seconds and 256 unique addresses per pass; deferred entries stay for another refresh. Removed entries remain recoverable through **Settings → Sources → Restore removed channels**. Selected-source or search scans do not authorize this cleanup.

## Browse and watch

Select a channel to watch. Use **All**, **Favorites**, **News**, **Sports**, **Movies**, **PPV**, or search to narrow the list. **Favorite** remembers the selected channel. Under **Location and sort**, choose **Country**, **Region**, **State / subdivision** and an ordering. **Unknown** means location metadata is missing; it does not mean the stream is local or accessible in your location.

**PPV:** choose **PPV** to see channels explicitly marked PPV or Pay Per View by their names or categories. All, Favorites and regular genres normally exclude those channels. PPV still respects country and typed search; star actions remain available, but PPV and Favorites are separate filters. A local category change does not erase the provider's original PPV marker. Paid, premium, sports and league/event names alone do not identify PPV, so unmarked provider entries cannot be classified reliably. Automatic source selection stays inside the selected channel's ordinary/PPV classification. This does not change Paid TV movies or series.

All primary channel-card headings, including channel names and cached programme titles, wrap fully in slightly smaller text. When a programme title is shown, the original channel name remains on its own line. On a short screen, the list reserves space for the measured card and the surrounding controls can scroll out of the way. Use Up to return through the list to the filters. If a card is taller than the available sidebar, Down and Up first page through its text; after reaching the edge, the next press moves to the next or previous channel. A following short card reveals its own text immediately instead of making you scroll through blank padding. When growing search controls require separate panes, the pane containing your active controls stays visible.

**Sports search (0.1.25 Android package):** Sports gains separate Sport and League choices. A specific sport or league, or an explicit league/full-team query, may include positively matching PPV results and must show that inclusion. Country and typed text remain constraints. Without specific sport/league/full-team intent, generic Sports, All, News and Movies keep PPV separate. Typing only “football” keeps literal results and adds positively evidenced American Football; it does not infer Soccer or automatically include PPV.

Free TV and Paid TV keep separate browsing choices: genre/PPV, sport/league, typed search, location filter and sort order. A change affects the active tab and its Guide; returning to the other tab restores its choices during the browsing session. The home location saved in Settings remains global. These tab choices do not change provider accounts or the saved home location.

Channel rows keep the complete cached current-programme title visible alongside the original provider label. For a clearly identified NFL matchup with exactly two recognized opponents, the display can expand their full franchise names. Unrecognized abbreviations, missing listings and ambiguous titles remain as supplied; the app does not invent opponents or establish that an event is live. Updating a saved guide refreshes matching list membership, keeps the browsing scope and retains position when the anchor remains in the updated results.

The initial reviewed vocabulary covers American Football, Baseball, Basketball, Soccer and Hockey; ten explicit league/group labels; and the 32 current NFL full franchise names. Bare Bears, Cardinals, Giants, city names, or generic NCAA/college do not establish a league. Nicknames can match a full-team query only when the stored row independently identifies that league. Other franchises and sports remain literal matches or Unknown rather than being guessed. This phase reads existing channel/programme metadata; it does not add per-search network calls, local-station discovery or a stream rescan.

Live TV's left list shows channels you can select for live playback, with no separate Programs window. Playing a channel keeps your search text. As scan batches or saved stream checks update the list, GenX keeps the channel you are browsing and its scroll position when that channel remains available. The right pane is reserved for video and the compact controls below it. Open **Guide** for program listings, details and channel mapping; guide availability does not guarantee that a stream will play.

**Remove channel** hides a channel across refreshes. Restore these channels through **Settings → Sources → Restore removed channels**. Removing a source in Settings removes its catalog channels. If all channels have been removed, the channel panel points you to restoration; if saved sources contain no channels, it points you to updating or replacing a source.

Controls below the video provide **Pause / Resume**, **Mute / Unmute**, volume, **Expand / Show channels**, and **Full screen / Exit full screen**. Expand gives the video more space without entering fullscreen. Drag the divider to resize the panels; with keyboard focus on the divider, use Left/Right. On compact screens, **Viewing panel** switches between Watch and Channels.

Connecting and Buffering messages describe work in progress. If the app pauses playback in the background, return and choose **Resume** explicitly. Resuming a live stream reconnects to its current live position. Background-canceled imports and scans need an explicit retry; they do not restart automatically.

With a directional remote, arrows move focus and OK/Enter activates. From the channel list, Right moves to player controls; Left returns from the first control. A text field reached by directional navigation needs OK/Enter to begin editing. Back/Escape first leaves editing, then closes the open dialog. Back closes the current chooser or program details before leaving Guide, and exits fullscreen before leaving its previous view. At the main screen it does not exit the app; use **Settings → Exit app**. **Show channels** restores an expanded panel. Pointer and Tab navigation keep normal text editing. Available keys depend on the remote and operating system.

## Programs and voice

To close the application, choose **Settings → Exit app**. This uses the normal cleanup process for playback, casting, source scans and sharing. If cleanup fails, the app remains open with Retry closing and a separate explicit Force quit choice. Browser previews explain that you must close their browser tab.

Open **Guide** for Free TV or the selected Paid TV account. Wide Guide layouts use a channel/program grid; narrow layouts can use a compact channel agenda. Guide inherits the current **Location and sort** country choice, including multiple countries and **Unknown**. Free TV can also use its declared region/state metadata. Paid TV country matches come from the provider's original channel groups; missing metadata stays Unknown. Location filters do not infer where you are or guarantee that a stream is available there.

The normal Guide has its own **All**, **Favorites**, **News**, **Sports**, **PPV**, and channel/program search controls. On TVs with a visible mini player, tuning a channel keeps the Guide open and preserves its filters, browsing position and focus when the saved configuration is unchanged. In compact layouts that hide the player while the Guide is open, Watch returns to the picture. Wide, short handheld layouts with a mini preview keep the Guide open. On a TV remote, Left from the first control in a Guide row reaches the mini player or channel pane; Right returns to that row. An overlapping program cell opens a chooser. Arrows stay inside that chooser or its program details until Back returns to the original cell.

Explicitly marked PPV program titles or categories stay out of ordinary Guide results, even on an otherwise regular channel. Choose **PPV** to find those events; the 0.1.25 specific Sports scope can also include positively matching PPV. This is a listing filter, not a subscription or playback entitlement check. The 0.1.25 Android package passed its own local development and package checks; this does not establish provider entitlement or owner-device compatibility.

Saved schedules are stored locally in SQLite. With **Settings → Advanced → Update program guides automatically** enabled, GenX checks approved Free TV feeds and the selected Paid account's already downloaded guide about every three hours while the app is active and idle. Playback, an open Guide and other busy work defer the check. Closing the app does not run a background refresh. A failed or canceled download keeps the previous schedule. Open Paid TV Guide to download a missing provider guide, or choose **Update guide** to retry it manually.

For source management, open **Settings → Advanced → Program guide settings**. Use **Guide view** to choose **Program guide setup**, **Channel mapping**, **Choose channel / day**, or **Search programs**. Add your XMLTV URL or file under **Program guide setup**. **Save source and preview** saves its configuration; schedule data changes only after you review and save the preview. A failed refresh retains the previous schedule. Map your catalog channel to the correct guide channel, checking its affiliate, region and time variant. Suggested matches need your review.

For program search, type a phrase such as “Chicago Bears” in the normal Guide search, or choose **Search programs** in Program guide settings. Guide search uses available channel names and program titles, descriptions and categories; the feed must actually contain that metadata. Live TV’s search shows channel results only and keeps your query when you play a channel. **All guides** searches mapped channels across your configured feeds. The search window runs from now to just before seven days later. Listed freshness and coverage tell you what the feeds actually provide; seven-day search does not promise seven days of listings. Missing end times and overlapping listings may prevent a definite current-program result. Selecting a future program opens its details; it does not schedule recording or automatically tune. **Watch channel** deliberately opens its live channel.

**Voice search** captures one request using available on-device recognition. Choose it to start and **Stop voice input** to finish. The final text enters the editable search field; it does not tune a channel. The current app refuses cloud fallback. If microphone permission, language models or recognition are unavailable, type instead.

## Local Web TV research

Automatic official-station Web TV discovery, a dedicated Live TV Web TV filter, My Local and precise ZIP/area-code station coverage matching are not part of 0.1.25. The [discovery design](local-tv-discovery.md) reuses your saved Settings location across regions; the Illinois examples are samples, not a regional restriction. Current location filters use declared metadata; local website searches do not prove coverage or current live programming. [NCTV17 Watch Now](https://www.nctv17.org/watch-now/) and [ABC7 Chicago Live](https://abc7chicago.com/watch/live/) are official research references, not newly added GenX channels or verified GenX playback.

## Playback diagnostics

Use **Settings → Advanced → Playback diagnostics** to record a problem with Free TV, Paid TV, GenXtra or Web playback. Include the channel or title, approximate time, whether the player was embedded or fullscreen, and the steps that reproduce it. The report includes playback/recovery events and available player-position measurements so app layout faults can be distinguished from delivery or decoding failures. See [Playback diagnostics](playback-diagnostics.md) for the report controls and limitations.

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

**Settings → Settings backup** exports or imports settings. **Full backup** saves channels, preferences, favorites, removed-channel markers and saved check history. Its reviewed import replaces those saved records. Imported checks remain historical rather than fresh playback proof. Guide sources, mappings and schedules are not included: keep their source details separately. Backups can contain private provider URLs; store them privately.

**Import previous app** accepts a JSON file you choose and previews supported channels, favorites and removals. It preserves unrelated sources and does not modify the previous project. Review unresolved or ambiguous entries before saving.

On Windows, extract the entire portable ZIP to a writable folder before opening the executable. Windows needs WebView2 Runtime; the executable alone does not supply it. Windows normally uses its application-data folder. For a portable candidate, `tmg-portable.flag` beside the executable selects a sibling `data` folder when writable. An explicit absolute `TMG_DATA_DIR` selects another folder.

If **Saved data needs attention** appears, retry or use the offered **Writable data folder** / **Use this folder** controls. The chosen folder opens its existing library or starts an empty one; your previous library stays untouched. This is not automatic migration. The alternate choice is remembered for that executable location, so moving the executable may require choosing again. With `TMG_DATA_DIR`, correct that location and restart. Android uses private app storage and offers retry/exit rather than an external-folder choice.

If the message says saved data is **in use**, close other apps using that library and choose **Retry saved data**. A locked library is not replaced from backup, and this state offers retry rather than a different data folder.

On Android, open the supplied APK with your device's package installer. If prompted, permit installation for the file manager or browser you deliberately used to open it. The Android APK supports both 32-bit and 64-bit ARM devices. Back up before Android updates. An APK update must use a compatible signing identity; uninstalling or clearing app data removes the library.

## Development builds

This guide describes implemented controls, not a guarantee for every provider or device. The 0.1.25 Android package uses the official release certificate; other development builds may be unsigned or debug-signed. Receiver compatibility, phone-sharing and clean-environment portability are limited to their separately recorded checks; the scoped release checks do not verify every device or provider. A browser development preview cannot provide native casting or native guide/storage behavior. Do not assume a development APK can update to a differently signed release without preserving its data first.

**Moving to the official release on Android:** a release-signed GenX Streamer cannot install over a differently signed development copy. First save a **Full backup** (Settings → Full backup), then uninstall the development copy, install the release, and import the backup. About GenX Streamer → **This copy** shows the version, Android build number, platform, and **Release build**, **Unofficial build**, or **Development build**.

For a large saved Guide, the first sport/league filter or Guide opening can take several seconds. The saved-listing status remains visible while the current query finishes.

## Stream buffering and History

The player footer shows the current engine’s measured incoming rate and buffered seconds when available. Use the footer arrows and Auto to choose a manual target from 1 to 20 seconds in one-second steps, or return to the engine’s automatic profile. Supported browser live routes can also reuse their session-local learned target. Manual choices apply to this channel/source, stay on this device across restart, and survive a full rescan when the actual stream/source identity is unchanged.

Automatic selection can choose another feed of the same channel; each feed keeps its own buffer choice.

Choosing Auto resets this one manual setting. The same controls are available in the fullscreen player HUD. Fullscreen controls wrap into rows and the HUD can scroll when space is limited. Within the buffer panel, Left/Right moves focus between available controls; OK/Enter activates the selected button. Initial playback can start before the target is full. During native rebuffering, the player waits for the target for up to 12 seconds, then returns to its normal readiness policy. Some playback engines can show measurements but cannot control the target, and opaque measurements remain unavailable. Changing a supported target does not retune the channel.

Choose History in the active Free TV or Paid TV list to see live channels that reached a current decoded frame, newest first. Search and location choices still narrow the list, and adult-content visibility still applies. Use a row’s remove action to delete that entry without changing the channel or its favorite. Clear History removes all saved entries in the current Free/account scope, including hidden entries, without displaying hidden adult names. Adult-content visibility continues to apply. This device-local list stores IDs and timestamps, not programme titles or stream addresses. A regenerated Free catalog identity is not guessed from its title. Finite videos, GenXtra and Web pages do not enter live-channel History.

On wide, short handheld screens, Guide keeps a small player preview beside a scrollable toolbar, with the programme grid spanning the width below. Choosing a channel keeps that Guide open. Left/Right reveals the next toolbar control; Down enters the programme rows and Up returns to the toolbar. Narrow phones retain the full-workspace Guide and return to the picture when a channel is chosen.
