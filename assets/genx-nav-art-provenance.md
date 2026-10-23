# Header button artwork

The owner supplied `Neon Cyberpunk TV Button Sprite Sheet.png` (1672×941, transparent background, three rows of five buttons, designed with ChatGPT) on October 19, 2026 and chose the **middle row** for GenX's top buttons. The original is kept unchanged.

| Button | Display copy (120 px tall, PNG with transparency) | Cut from the sheet (x, y, right, bottom; plus 4 px of glow) |
| --- | --- | --- |
| Free TV | `genx-nav-free-tv.png` (239×120) | 41, 381, 377, 546 |
| Paid TV | `genx-nav-paid-tv.png` (232×120) | 399, 381, 726, 546 |
| Local TV and radio (globe) | `genx-nav-globe.png` (117×120) | 741, 364, 935, 563 |
| Cast | `genx-nav-cast.png` (230×120) | 951, 381, 1275, 546 |
| Settings | `genx-nav-settings.png` (241×120) | 1293, 381, 1633, 546 |
| Cast, icon only (phones) | `genx-nav-cast-icon.png` (96×96) | the glyph inside the Cast button, its dark face made transparent |
| Settings, icon only (phones) | `genx-nav-settings-icon.png` (96×96) | the gear inside the Settings button, its dark face made transparent |

Edges were found from the sheet's transparency; copies were scaled with Pillow's Lanczos filter. 120 px stays sharp at the 40–54 px button heights on 2× screens without wasting memory on the 1.7 GB Sansui TV.

`src/ui/header-art.css` paints them. Labels are part of the art; each button keeps its accessible name. On TVs and wider screens the width follows each picture's shape; on phones Cast and Settings show only their icons on the usual glass, because six buttons share about 360 px. The GenXtra badge keeps its own art.
