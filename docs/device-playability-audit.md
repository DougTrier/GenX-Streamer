# Physical Android playback and layout audit

November 3, 2026. Private signed 0.1.26 candidates. The S25 used Wi-Fi with
mobile data off. The Google TV Streamer ran the 32-bit Android build.

Signed build `B60A18485346344FF8ABFD08DA01CCC45F33AF6AB719C4762DEA8359F67FE943`
showed bitrate and buffered seconds on a single row during ESPN on the S25
in portrait and landscape fullscreen, and during 00s Replay on the
Streamer in the normal player and fullscreen.

On signed build `84A04429CC86D64A2D8BEE60C28F8FC726FD45D4F8B4CCDC495367943C1D9DAA`,
the S25 reported “Online discovery stopped. Your saved channels are
retained” after stopping an early Rescan, with Finish scan, Rescan and
Close above the channel list. A later-stage cancellation reported
“Scan stopped. Added channels retained.” The Streamer started its saved
scan from Finish scan, accepted Stop, and returned to the channel list.

On signed build `2B57D649B13D9C40AEC65406491FA76407941192B6BF3E113C8DDB90A1740C14`,
the Streamer resumed The Outer Limits from its saved position and accepted
seek and Pause near the edges of their buttons. On the earlier phone build,
GenXtra search added 12 results and an episode started in the Browse
preview. Watch collapsed the active picture. The revised portrait layout
passed the browser matrix and awaits the S25 retest.
The Streamer also played Discovery HD from its Paid TV provider and
played a movie from the VOD gallery on this build. Stop returned to the
gallery and restored focus to the selected movie card.

| Area | Samsung S25 | Google TV Streamer |
| --- | --- | --- |
| Existing library and scan checkpoint | Opened in portrait and landscape. Finish scan, Rescan and Close remained above the channel list. | The signed dropdown fix opened the 11.4K-channel Free TV library and showed the saved checkpoint. |
| Free TV | ESPN and 00s Replay played. Watch used the available picture width. The one-line buffer meter remained visible. | ESPN 2 US played at 720p after searching for the channel. Playback continued with Guide open. |
| Fullscreen | Checked portrait and landscape controls, Replay, Return to Live, and exit. | Checked picture, visible remote focus, quality control, and Back to the playing channel. |
| GenXtra | Online search populated the empty catalog. After the portrait fix, The Outer Limits resumed in Watch with the full picture. Switching from live TV to GenXtra retained the live picture without exposing a VOD Stop action. | Opened the saved library and resumed an episode of The Outer Limits. |
| Paid TV | Paid live TV and a gallery movie played over Wi-Fi. After the empty-response retry fix, the gallery populated and Stop restored the selected poster. | Opened the saved channel list and played Discovery HD. The movie gallery loaded, a selected VOD title played, and remote Stop restored its poster. |
| Web | The MDN sample MP4 reached the end in the native Web view. The signed fix opened the address controls from Watch and switched back to Watch when the page loaded. | Opened and played the MDN sample MP4 in the native Web view. |
| Cast | ESPN and 00s Replay played on the Streamer over Chromecast. The S25 confirmed the 00s Replay session and Stop casting returned it to local playback. | Confirmed ESPN video and sustained 00s Replay playback. The receiver stopped playing when the S25 ended the session. |
| Guide | Opened saved listings and returned to playback. A separate provider refresh warning remained visible in Settings. | Opened Guide over live playback and closed it with Back. |

On the S25, the signed portrait feedback layout fix displayed the full
queued-update message and the full failure message. With no channel
playing, Find program guides queued while Guide was open. After closing
Guide and reopening it, the refresh reported that work could not finish,
and 2,093 channels still had saved listings. The underlying deferred
failure reached the deferred failure handler as a native `canceled`
response. The builder now recognizes that response when its own canceled
request has settled. On signed build
`DCCB4C8ED89A410F5B980627FC03EB67F0916AB6624CB17CB6DFF67885376BB0`,
reopening Guide after the same sequence showed 2,114 available listings
and a queued status rather than the earlier failure. A completed refresh
after this sequence has yet to be observed.

On that same build, 00s Replay played directly on the Streamer with Guide
open and after remote Back. During that tune, a separate warning reported
that its saved channel check could not be updated. Playback continued.
The Streamer event history attributed the warning to a storage read
failure. Playback health now uses the existing revision-only native read
when supported. On signed build
`BB064ACA49D9A29CFCC357270A7E8894980150E37F71E68EF7796D6349F2B964`,
the repeated 00s Replay tune played and persisted no new playback-health
failure event. On a subsequent run of the same app code with temporary
WebView diagnostics, tuning 00s Replay advanced the stored health revision
from 1330 to 1331 while the catalog revision stayed at 991. The regular
signed build was restored after the read. The S25 showed
2,116 channels with listings and still reported a queued refresh on reopen.
The cache-only connection now emits its own completion status. On signed
build `E6CC5194746F02C44232AC4F629175396BFC53685CBF524624C19BF43B585012`,
the S25 showed “Saved guide listings checked” with 2,117 channels. A
separate manual Find reached “Guide check finished,” reported 55 guide
sources and one playlist it could not check, and retained those listings.
The Streamer opened Guide with 2,140 channels. After manually requesting
Find and allowing the deferred update to run with Guide closed, it showed
2,159 channels with listings and the generic “Program guide work could
not finish” status. The failure cause on the Streamer is unverified.
On a subsequent run with the same app code and temporary WebView
diagnostics, the Streamer settled all 128 feeds, optimized its saved data,
and reached “Guide check finished.” It reported 55 feeds and one playlist
that could not be checked. The app retained listings for 2,159 channels.
The regular signed build was restored after collecting the result.

On the later signed build, a fresh Find followed by closing Guide and
tuning 1+1 International HD allowed live playback. Reopening Guide
while video continued showed the queued-update message, with no cleanup
failure in that handoff.

The S25 trace identified a native segment size refusal during ESPN playback.
Both sides of the native HLS bridge now accept up to 16 MiB. Native tests
accepted 9 MiB and rejected a response above 16 MiB.

On the Streamer, WebView sampling found repeated remote dropdown refreshes
after the library had loaded. Ignoring unrelated visibility mutations in the
diagnostic session restored startup, and the signed observer fix also opened
the library. The menu still closes when its parent becomes hidden.

After provider setup, the S25 played Paid live TV in portrait and
landscape fullscreen and played a movie from the Paid gallery over Wi-Fi
with mobile data off. Near-edge taps worked for pause, resume, fullscreen
and Back to channels. GenXtra resumed The Outer Limits at 8:31 and
showed the full picture in portrait Watch. Seek, pause and Stop
responded near their edges. Stop then left GenXtra Watch blank. Paid VOD
opening also left the filter sheet over the gallery, and stopping a
movie from Watch hid the gallery navigation. Fixes for these return
paths and the stretched Paid VOD controls passed the phone browser
matrix. On signed build
`8D4BB795259FA48460A642DE4B22383B39D714F27293C81B4A350DEB9E839B78`,
the S25 opened Paid VOD directly from Search & Filters, kept category
buttons compact during playback, and restored them on Stop. GenXtra
Stop returned to the selected episode list. The same build installed on
the Streamer.

The S25 tap-through also reached Free TV Search & Filters, the scrolling
Location and sort sheet, the native search keyboard, Guide and Watch
from a listing, Web's Results and Websites, Cast discovery, and
Settings. From Settings, it reached Sources, Advanced, Settings backup,
Full backup, Import previous app, Find channels, LAN viewing, About,
Quick Guide, Program guide settings, Event history and Playback
diagnostics, and the scrollable Pass It Along sheet. The Event history
title was truncated in portrait. On signed build
`B79D750051E0C6565109A268C4E2067BA7150DB23805CE443E304D6B717AD1BA`,
the full title displayed, swiping scrolled the event list, and an
edge tap on Close history returned to Advanced Settings. This build
played ESPN on the S25 over Wi-Fi and 1AlmereTV on the Streamer.
The Streamer also showed a timeout on an ESPN Colombia result and a
decode error on Mundo F. In a later ESPN search on the signed build,
ESPN (United States) HD and ESPN 2 (United States) HD both played. The
temporary Streamer trace reproduced response-body failures on ESPN 2
Latin America Colombia. A direct GET of three media URLs from that tune
returned only 188 bytes per segment. The sampled bytes were one MPEG-TS
null packet (PID 8191), carrying no program media. Mundo F remains
unclassified. The regular signed build was restored after tracing.

On signed build `A62C79FBD69C8399DFED9C75B9C5DE8E5A3191AA98FD96880725F90543A0244D`,
the S25 reproduced the original cleanup notice while tuning ESPN in
landscape. Restarting the app cleared the condition and the same
channel played. Search, Clear and tune succeeded after the restart.
A diagnostic repeat did not capture a rejected cleanup owner.
The regular signed build was restored on the S25.
On the next pass in portrait, Search & Filters → ESPN → Show channels →
Clear → ESPN (United States) HD (720p) played over Wi-Fi with mobile data
disabled. Repeating the sequence while the same channel was active kept
playback running. Android logs for the pass contained no cleanup warning.
See the later signed-build retest below for the cleanup changes and the
remaining uncertainty about the original native failure.

The Streamer remote-only pass used D-pad, Select and Back. Free TV
tuned 1+1 International HD. Guide opened over continuing playback
and Back restored focus to Guide. Paid TV opened the VOD gallery,
focused its first title, moved focus between titles and categories,
and returned to the VOD button after backing out.
The D-pad pass also reached GenXtra language filters, title details and
resume, then played The Outer Limits from its saved position. Settings
opened Find channels, Scan sources and Find sources, and Back restored
focus to the invoking control. Scan sources showed a retained checkpoint
of 3,540 checked and 2,771 saved. Expanding Advanced confined its controls
to a short nested scrolling area while leaving most of the dialog unused.
Advanced Settings opened Event history, where Down focused and scrolled
the event list.
From Web, Select opened WLS-TV in the embedded browser and Back
returned to app controls. On Free TV, the on-screen keyboard accepted
the ESPN query using only D-pad and Select. The first hit was the
Colombia feed. The U.S. ESPN 2 HD (720p) result appeared farther down,
played live video, and entered and exited full screen from the remote.
Signed build `3AB88D5EE480272C681FB3FD36654FBF449F52E1CB83051E5762E423B7623690`
was installed on both devices. On the Streamer, Advanced displayed
its setup controls in the larger dialog, and the remote reached
Finish saved scan directly from Settings. On the S25 the same button
was reachable by touch. Both saved checkpoints were refused for
continuation and offered Rescan. The saved counts remained visible.
This did not establish physical resume of an eligible aged checkpoint.
Event History now distinguishes which joined guide cleanup operation
failed. The earlier S25 warning has not recurred during the signed
diagnostic retests.
The subsequent source audit found a 24-hour limit in native checkpoint
header validation. It ran before the resume plan's seven-day check.
Both native gates and the frontend now reject at seven days, and the
native test admits a six-day checkpoint and refuses one at seven days.
The full native checkpoint suite passed (62 tests), as did the focused
frontend checkpoint and resume suite (48 tests).
Signed APK `CAFC625B891EBA29F4A4C199689EB1C5D749D36707D20BDF6072708AB6B9FFC0`
was installed on both devices. On the Streamer, the same checkpoint
that the prior build refused resumed from 18% and 2,771 saved channels.
Remote Cancel joined the scan and saved the new checkpoint at 19% and
2,804 saved. Reopening Scan sources showed the same paused counts.
On the S25, the checkpoint with 665 of 1,669 checked and 56 saved
was outside the seven-day window. The complete refusal and recovery
message was visible, and ESPN 720p played after dismissing Settings,
with mobile data still off.
The S25 touch pass on that build checked portrait fullscreen, Mute
and Unmute near the button edge, the quality menu, exit from fullscreen,
and Pause. After queuing another Guide update and leaving Guide,
00s Replay played, its caption button toggled, and the audio menu
showed the available tracks. The most recent Event History records
did not show a guide cleanup failure. Event History previously opened
on its oldest entry, so the display order was changed to newest first.
The Streamer D-pad reached Settings backup, Full backup, Import
previous app, LAN viewing, and About. In About, Down from Close skipped
the tabs and could reach a support link. The keyboard test now checks
Down to the active tab, Right to Quick Guide, Select, and Back to Settings.
On signed build `862CD2A49F87E3717E0C09B2DE87BAD06CF7F44B5EF0B95391C821814E24AEA1`,
the S25 opened Event History with the latest entry at the top. On the
Streamer, Down → Right → Select from About's Close opened Quick Guide,
and Up → Select closed About and restored focus to its Settings button.
The guide owner audit found a reproducible route to blocking later
tunes. A changed scope detected before cached mapping entered the
native writer was indistinguishable from an unresolved cleanup.
Background wake could also propagate a recognized preflight refusal
after cleanup had already settled. The fix uses the existing
preflight proof for the scope checks and resolves background wake only
for that recognized outcome with confirmed cleanup. The fixture still
blocks playback after an unknown cancellation or publication receipt.
The focused guide and playback suite passed 69 tests.
Signed build `5A1553A86104E4099BEFA4A7849D083D04193E40D91F8C95256D7E73A2042B67`
played U.S. ESPN 720p on the S25 after Search, Clear and a fresh tune.
Mobile data was disabled. The playback buffer reached 24 seconds.
The original intermittent cleanup failure was not reproduced during this
physical test.

The bulk and quiet checks already sample HLS media resources. Their
MPEG-TS signature check accepted any two packets with sync bytes, even
if every packet used the null PID. Padding-only samples now fail the
media check. Valid samples with padding followed by non-null packets
still pass. The final source passed 27 native media-probe tests and
19 focused frontend diagnostics tests.
Signed probe build `1AE5BFCF1E41744D8A8F440A52D00AC7B10A6E1A72B4E90ED0264F92F9DB4B21`
was installed on the S25. U.S. ESPN 720p played over Wi-Fi with cellular
data off and reached 39.5 seconds buffered. The Streamer was in active
use, so deployment and on-device probe verification there are pending.
The quiet checker now probes configured backups after a confirmed
primary failure and shares results only across identical candidate
sets and HTTP policy. Scan results for a failed primary alone no
longer contribute a negative mark when a saved channel has backups.
The scheduling fixture verifies that two channels sharing a failed
primary receive separate results when only one has a working backup.
The quiet checker suite passed 11 tests and the native channel check
suite passed 4. Signed APK
`E68798E6BF20368D129D121B45E0DB1263A4C37E73F8E695766B285C17EF2471`
was installed on the S25 and played U.S. ESPN 720p over Wi-Fi with
cellular data off, reaching 23.3 seconds buffered. The Streamer
continued its active playback session on the previous build.
After the user made the Streamer available, the same signed APK was
installed there. Remote-only search and tuning played both U.S. ESPN
720p feeds with 42.2 seconds buffered on ESPN and 28.1 on ESPN 2.
The Not responding category was reachable by remote and offered
Remove all 99 while the ESPN query matched zero flagged channels.
The bulk strip now states its library-wide scope in the source. No
channels were removed during the physical check.
Failure streaks for channels with backups now carry the ordered URL
set that was checked. A legacy streak without that evidence or a
streak for an earlier backup set stays out of Not responding and is
eligible for a fresh quiet check. Bulk removal rereads the current
native results. Five native health tests, 30 native catalog query
tests, and 11 frontend scheduling tests passed.
Signed build `BCE397866D9E1ABD038AC8AD7DF52506A0E2A4F1153427C926D10F5A25A7B2EB`
was installed on both devices. The Streamer remote reached the updated
Not responding strip, displayed 99 rows across Free TV, and focused
Remove all 99 without activating it. Returning to All played 1+1
International. The S25 played U.S. ESPN 720p in landscape over Wi-Fi
with cellular data off and entered and exited fullscreen by touch.
The broad frontend audit passed 987 tests after aligning one older
test with the observed owned native cancellation behavior. Both
devices initially showed empty Paid TV movie categories. Reopening
the gallery now retries empty category responses. The controlled
browser test opened an empty gallery, closed it, and loaded titles
on reopening. Signed build
`C69352C3C949AD768CF63FE4075A9D049826615FFDCE6EDB79A9BC42E89E1207`
was installed on the Streamer. Movies and category rows populated,
but selecting a movie reproduced the original guide cleanup warning.
The newest Event History entry identified the automatic guide builder
as the failing owner. The underlying native result remains unknown.
The S25 was no longer visible to ADB at deployment.
After reconnecting the S25 over wireless ADB, signed build
`9D3B4753A7AEF7829ADD1C65643DB54E5C8E75F457E7C77B2427E1E63AE74425`
was installed on both devices. The cached guide connection bridge
now recognizes four exact native noncommit scope refusals. The
unknown cleanup path remains guarded. The focused tests passed (127).
On the Streamer, the same Paid TV movie that previously hit the
guide cleanup warning played from the remote and buffered 50 seconds.
On the S25, Search → Clear → ESPN played over Wi-Fi with mobile data
off. Paid TV then played the same movie in portrait Watch, and Stop
restored the gallery and selected poster by touch.
The provider allows one Paid TV session. The earlier movie smoke
tests overlapped briefly. Subsequent tests must stop and verify
release on one device before starting Paid TV on the other.
Remote Stop restored the selected Streamer movie poster. With both
paid players stopped, the S25 opened Free TV Guide, requested an
update, closed Guide, and played ESPN 720p over Wi-Fi with cellular
data off and no visible cleanup warning.
On the same signed build, the Streamer requested Free TV guide work
and tuned 3sat from the Guide using the remote. It then tuned 1+1
International and continued showing moving video across the subsequent
checks, including while Settings and Event History were open.
The previous 1+1 stall did not recur in this pass. Event History on
both devices showed no new guide-cleanup entry. Paid TV stayed stopped
on both devices during this pass.

On a repeated 00s Replay cast, both devices reported established TCP
connections from the Streamer to the S25's ephemeral cast relay port.
A separate temporary listener on the phone received a test payload from
the Streamer with cellular data off. This verifies the Wi-Fi path to the
relay. A temporary signed diagnostic build then recorded four upstream
HTTP 400 responses to unranged GET requests during one cast attempt.
The relay received no manifest on those requests, so the failure occurs
before playlist rewriting or receiver decoding. The reason for the
upstream rejection was reproduced with a controlled request to the same
redirect chain. No User-Agent produced HTTP 400, while the existing GenX
playback User-Agent produced HTTP 200. The relay now sends that header.
The signed build with the header showed 00s Replay video on the Streamer,
but the sender timed out confirming the session. The sender now polls
media status during startup, retaining the existing ownership check and
deadline. The fixture and the full 118-test casting harness passed.
With signed universal APK SHA-256
`E012B54D70C42F82FE92692E36F059ECCBFD2714443AC5A8D8F368A51C8BD909`
on both devices and cellular data off, the phone confirmed the cast, the
Streamer reported PLAYING at 55.6 seconds, and Stop casting ended receiver
playback and resumed local playback.
On signed build `9D3B4753A7AEF7829ADD1C65643DB54E5C8E75F457E7C77B2427E1E63AE74425`,
the S25 cast Free TV ESPN 720p over Wi-Fi with mobile data off.
The sender confirmed Casting, the Google TV Streamer showed ESPN,
and tapping Stop casting returned the Streamer to Google TV Home
and resumed local ESPN playback on the S25.
Signed build `0ED51B87C693B71D6951D29BB1EAC0E6834F1D9D95BEEB50F26FFA7AD0DAB223`
was installed on both devices. The S25 cast picker fit each discovered
unique name and model on one line. The Streamer showed ESPN after
selecting its compact row. Its row-specific Stop button ended the cast
and the Streamer returned to Google TV Home. The 19 casting UI tests
passed, including the unverified identity confirmation paths.
Signed build `773B565543B4BE659B9E7084F576349004FBDC78FC920156EB10EE0F4E4372F9`
was installed on both devices. After casting ESPN and using the
receiver-specific Stop button, the S25 kept its selected channel and
displayed “Select your TV to watch on it.” The Streamer returned to
Google TV Home. All 19 casting UI tests passed with the new status.

The short TV layout fix passed all 15 TV and About browser checks at
the audited viewports, including the paused panel at 960×540. All 45
phone layout, scan panel, and buffer control checks passed. Signed build
`96825096F9A7AF90F7CF9D85A3105728B4D6FB92ADDF229EDD169FC65146ADE2`
installed on the Streamer. The remote reached Finish saved scan in
Settings. Cancel during preparation reported both that the scan stopped
and that it could not resume. A second attempt resumed at 19% with 2,804
saved and paused at 2,812 saved. The cancellation fix keeps the prior
checkpoint available after preparation has settled and cleanup succeeds.
The bounded resume and inline scan panel suites passed all 29 tests.

On signed Streamer build
`80C6D13EA06D197A26A146ECEF519416D22FB7B249A1A761EF27149C2613E508`,
remote cancellation during preparation reported only that the scan was
stopped and channels were retained. Back restored focus to Finish saved
scan, and a second attempt resumed at 19% with 2,812 channels saved.
During that second attempt, the prior stopped status briefly remained
visible while the app checked the saved scan. The source now shows a
preparation status as soon as the user chooses Finish saved scan.

On signed Streamer build
`2217C33161E96F1A577B326C46B9D06F5726C9C6D9151CE4226A4A0904F859AF`,
Finish saved scan displayed “Checking saved scan progress…” and early
Cancel again retained the checkpoint. Closing the progress dialog during
an active resume could leave Finish saved scan without visible feedback.
The existing operation now reopens the dialog and returns the same work
promise. The regression check verifies one native preparation and a
visible dialog after reopening. Both focused suites passed 30 tests.
One earlier Exit app attempt showed “Closing could not finish” while
scan cleanup was pending. Retry closing succeeded. Its exact owner was
not captured in the device log.

On signed Streamer build
`BB29233475E19350889A68FBCFCA7E4A5CAABE3D752E7A5CBAEF2AE10844E045`,
the remote closed the active scan dialog and opened it again from Finish
saved scan. The reopened dialog displayed 19% with 2,874 channels saved.
Cancel paused at 20% with 2,877 saved. Settings still showed Finish saved
scan, and Exit app returned directly to Google TV Home. The S25 was
actively playing during the install window and remained on its previous
signed build.

After the owner confirmed the S25 was available, the same `BB292334…`
build installed on the phone. With mobile data off, near-edge taps in
portrait reached Finish saved scan, Rescan, Cancel, and Done. The phone
checkpoint correctly reported expiration after seven days and 56 saved.
Rescan briefly displayed the old checkpoint status while preparing;
the source now displays “Preparing channel scan…” in that interval.
The three scan suites passed 43 tests. After canceling the rescan,
tapping ESPN (United States) HD played 720p with 24.1 seconds buffered
and no visible guide cleanup warning.

Final device retest used signed universal 0.1.26 build
`7883508E80C6D5CE8A3EDE5B2C291A792D68103B6E975EFEE8EB9A518D14E647`
on both devices. On the S25, Rescan showed “Preparing channel scan…”,
Cancel retained the channels, and Clear followed by U.S. ESPN played
720p over Wi-Fi with cellular data off and 20.4 seconds buffered.
On the Streamer, the remote tuned 1+1 International HD and opened Guide
while video continued. Listings loaded for 2,179 channels. Back restored
focus to Guide and the full player showed 18.2 seconds buffered. These
are targeted checks for the final status-only change. The earlier
device results above cover the unchanged playback and layout paths.

The public 0.1.27 / build 1027 Android package
`F918F9290965BDF42A45F956D8C55CFFA7C54A302B3DCE69804A27C7786290A7`
installed on both devices. The S25 played U.S. ESPN at 720p with 27
seconds buffered over Wi-Fi and cellular data off, then exited normally.
The Streamer remote loaded Guide with 2,179 channels, tuned 3sat, and
returned to the full player with 15.3 seconds buffered. The resumed scan
paused at 20% with 2,892 channels saved. Exit returned to Google TV Home.
The 1+1 Ukraina feed returned a format error before the successful 3sat
tune. The exact-build smoke tests used Free TV.
