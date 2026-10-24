# Reference-derived wordmark

`genx-wordmark-v2.png` is a transparent bitmap derived with the built-in image-generation tool from the user's flattened `Design Concepts/GenX_Streamer_Concept_2_Screens/01_Home_Live_TV.png` reference on October 11, 2026. The request preserved chrome GenX lettering, magenta Streamer script and the cyan tagline while excluding the GX icon, navigation, channels and video. It is a reference-guided recreation, not a pixel-identical crop or recovered original font.

The existing GX television icon remains the application/platform icon. The earlier editable SVG wordmark is retained. The bitmap is static; no glow animation, video filtering or additional playback owner is introduced. Responsive artwork failure retains the existing textual fallback. Visual acceptance against the supplied reference and installed Windows/TV captures remains separate from successful decoding and layout tests.

`genx-wordmark-v2-display.png` (724×241, October 17, 2026) is the same artwork downscaled to a third with Pillow's Lanczos filter on premultiplied alpha. The app shows the wordmark at most 244×54 CSS pixels, so the display copy still covers 2× screens while decoding to about 0.7 MiB instead of 6 MiB, which matters on 1.7 GB Android TVs. The full-size source is kept unchanged.
