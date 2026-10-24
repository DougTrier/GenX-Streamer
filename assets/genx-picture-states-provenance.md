# Picture-state artwork

The owner supplied four 1672×941 images on October 19, 2026 for the picture's states. The originals are kept unchanged:

| State | Original | Display copy (1280×720, JPEG quality 86) |
| --- | --- | --- |
| Nothing playing; also the video's poster, in place of Android WebView's default gray play icon | `GenX Play.png` | `genx-play-display.jpg` |
| Opening, buffering, reconnecting | `GenX Buffering.png` | `genx-buffering-display.jpg` |
| Playback failed | `Neon CRT Connection Error.png` | `genx-could-not-connect-display.jpg` |
| Paused (by the viewer, or by GenX in the background) | `Neon Retro PAUSED Screen.png` | `genx-paused-display.jpg` |

The copies were downscaled with Pillow's Lanczos filter (about 150–180 KiB each, about 3.5 MiB decoded instead of about 6 MiB on the 1.7 GB Sansui).

`picture-states.css` fits the artwork as a 16:9 box and places live elements on it by measured position: the real Retry button over the painted TRY AGAIN… button (33.6–66.6% across, 76.6–89.2% down) the real Resume over the painted PRESS PLAY TO RESUME (30.7–69.6% across, 76.6–88.9% down), and a moving light sweep on the painted ring (centered at 50%, 59.5%, 25.5% of the width). A replacement image needs those positions re-measured.

The artwork includes recognizable third-party motifs in the background (a prism album cover, a game-console controller, an arcade-style sprite); fine for this private app, review before any public release.
