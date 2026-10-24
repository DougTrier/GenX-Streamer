# Instant replay on live TV (REPLAY01)

> Public copy. Evidence paths (`artifacts/...`) and linked internal reports are kept in the project's private archive; the measurements and decisions are summarised here.

Owner request, October 21, 2026: one-click slow-motion replay on a live stream. Owner decisions the same day:
- Replay reaches back **30 seconds**.
- It starts from a **Replay button in the bottom dock**, which touch and remote navigation can reach. The remote's **Rewind key** also starts it where the remote has one; the Google TV Streamer's remote has none.
- **On phones**, Replay is a round ⟲ icon at the **bottom right of the picture** instead of a dock button. It appears once a replay is possible. The replay controls still open in the dock under the picture.

## What the viewer gets

1. **Starting a replay:** pressing **Replay** (or the ⟲ icon on a phone) jumps back 10 seconds (or as far as the buffer holds) and plays at **¼ speed**, with the sound muted.
2. **The replay controls:** while a replay runs, they take the place of the dock's own buttons (which return with Live). Sharing one row with them overflowed the Sansui's dock on both sides.
   - **−10s** goes back 10 more seconds, within the 30-second reach. Replay, the ⟲ icon and the Rewind key do the same while a replay runs.
   - **◀ Frame** and **Frame ▶** step one original picture back or forward, and pause.
   - **Pause / Play** pauses or continues the replay.
   - The **speed** button cycles through ¼×, ½×, 1× and ⅛×.
   - The position shows how far behind live you are, for example "−8.4 s".
   - **Live** returns to the live picture at normal speed.
3. **Ending a replay:** when the replay reaches the moment Replay was pressed, GenX returns to live by itself. Back, a channel change, Stop, an error, backgrounding the app and exit also end it.

Original pictures only: GenX never invents in-between frames. At ¼ speed a 60 fps channel shows 15 real pictures a second, which is what an accurate review of a play needs.

## How it works

Nothing new is recorded. Each player already keeps a little of what has just played (its *back buffer*: compressed media, never decoded pictures). Replay enlarges that buffer to 30 seconds and moves the playing position inside it.

| Player | Channels | Back buffer (before → now) | Slow playback and stepping |
| --- | --- | --- | --- |
| hls.js (WebView, Windows and Android) | HLS live | `backBufferLength` 15 s → 30 s | `playbackRate`; a step sets `currentTime` one frame period away |
| mpegts.js (WebView) | direct `.ts` live | trimmed 30 → 15 s, now 40 → 30 s | the same |
| Media3 (Android) | live MPEG-2 channels, including Trier MPEG Video on the S25 | default (none kept) → 30 s from the previous key frame | `setPlaybackParameters`; a step is an exact seek while paused |

- **Window:** the buffered media containing the playing position. Replay is offered once at least 2 seconds are buffered behind the playing position.
- **Reach, measured from the live picture:** Replay remembers where the live picture was when it was pressed and moves that point on in real time. Jumps and steps never go more than 30 s behind it. The newest *downloaded* moment is not live: on the S25, hls.js had already downloaded about 15 s ahead of the picture, and a first version that counted from the download returned to live by itself mid-replay (found on the phone, October 21, 2026).
- **One-minute limit:** a replay that falls 60 s behind live (a long pause, or the slowest speeds) returns to live with a notice. This also bounds what a continuous live download (mpegts.js) buffers meanwhile. At ⅛× a 10-second replay therefore ends about 3 s before the moment Replay was pressed.
- **Frame period:** measured from the decoder's own frame counter during normal playback (web), or from the stream's frame rate (Media3). It is 1/30 s until measured, limited to 1/120 to 1/10 s.
- **Stepping back on the Media3 path:** MPEG-2 cannot be decoded backwards. Stepping back one picture means decoding again from the previous key frame, typically 15–60 pictures earlier. At Trier's measured 870–1,100 pictures/s on one thread, that takes a few hundredths of a second.

**Memory:** about 30 seconds of compressed video. At 8 Mbit/s that is about 30 MB, against the 15–30 s the web players kept before. Nothing is written to disk, and nothing outlives the channel.

## Rules

| ID | Rule | Proof |
| --- | --- | --- |
| RP01 | **Bounded.** Replay jumps reach at most 30 s behind the live picture, and a replay 60 s behind live returns to live. The only media held is the players' compressed back buffer, sized as above. Nothing is written to disk or kept after the channel ends. | Unit tests of the window and of the player settings; browser test of the behind-live readout; device check on the S25 |
| RP02 | **Owned by the playing channel.** Replay belongs to the current playback attempt. A channel change, Stop, failure, background suspension or disposal ends it. A control pressed for an older channel never acts on the new one (generation guard). | Unit tests: replay commands after a channel change, Stop or failure have no effect |
| RP03 | **Honest availability.** Replay is enabled only for live playback with at least 2 s buffered behind. Otherwise it is disabled and says why: on-demand videos have their own −10s, and a channel that has just started needs a few seconds first. | Unit tests; device check |
| RP04 | **Original pictures only.** Slow speeds show the decoded pictures at a slower pace. A step moves exactly one frame period. No interpolation. | Unit tests of step targets; device check |
| RP05 | **Sound.** Muted below 1×. The viewer's own Mute and volume are never changed; they apply again at 1× and on return to live. | Unit tests |
| RP06 | **Return to live.** Live, Back, or reaching the moment Replay was pressed returns to the live edge at 1×. If the replay cannot seek or stalls, GenX returns to live with a notice instead of retrying old media. | Unit tests; device check |
| RP07 | **Controls.** Replay is reachable by touch, mouse, keyboard and remote arrows, and the Rewind key opens it. On phones it is a single icon on the picture's bottom right, never also in the dock. The replay controls live in the dock, and Back leaves replay before anything else. While a replay runs, its controls replace the dock's buttons, in one row inside the picture's card (or across the full-screen dock). Steps never disable their button, so the remote keeps its focus. | UI tests at six sizes (phone portrait and landscape, handheld, desktop, TV 1080p and 540p), each in the window and in full screen, with Replay offered and running, checking every control lies inside the picture's card; device check with the Sansui's remote |
| RP08 | **True playback state.** A replay pause or step is not a stall: no "Buffering", no timeout and no reconnect. Slow playback counts as playing. While replay is open, the dock's Pause and Play act on the replay. | Unit tests of the engine's hold and stall paths |

## Not covered by this version

- **Interpolated slow motion** (made-up in-between frames): deliberately left out (RP04).
- **Saving a replay clip.**
- **LAN sharing:** viewers follow the host's channel, not its replay position. Replay is local to each device.
- **Casting:** a receiver plays the channel itself; Replay applies only to the picture on this device.
