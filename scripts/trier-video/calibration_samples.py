# Copyright 2026 Doug Trier
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Trier AutoTune calibration samples (docs/trier-adaptive-engine.md, milestone 2).

Generates the fixed, deterministic streams the calibration harness measures:
three workload classes (SD 480i, 720p60, 1080i) with inter-heavy (GOP 15, two
B pictures) and intra-heavy (every picture an I picture) material. The source
is ffmpeg's synthetic test pattern with seeded noise for texture, encoded
single-threaded in bit-exact mode by the project's ffmpeg (node_modules/
ffmpeg-static, a measuring yardstick only, never shipped), so the same tool
gives the same bytes. No user content and no network.

  python -B -X utf8 scripts/trier-video/calibration_samples.py [--out DIR]
      [--check]   compare with the recorded manifest (exit 1 on a difference)
      [--record]  write the manifest (scripts/trier-video/calibration-samples.tsv)
      [--app]     the app's short samples instead (sd, hd720, hd1080i: half a
                  second of inter material each), written to the app's assets
                  (src-tauri/gen/android/app/src/main/assets/trier-calibration)
                  with the manifest calibration-samples-app.tsv

Writes <out>/<name>.m2v and <out>/samples.tsv, the harness's manifest:
name, class, kind, width, height, frame rate, bytes, FNV-1a 64 of the file.
"""
import argparse
import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FFMPEG = ROOT / "node_modules" / "ffmpeg-static" / "ffmpeg.exe"
RECORDED = Path(__file__).with_name("calibration-samples.tsv")
SECONDS = 2
APP_RECORDED = Path(__file__).with_name("calibration-samples-app.tsv")
APP_OUT = ROOT / "src-tauri" / "gen" / "android" / "app" / "src" / "main" / "assets" / "trier-calibration"
# The app's Stage A samples: the broadcast classes, inter material, short.
APP_SAMPLES = [
    ("sd", "sd", "inter", 720, 480, (30000, 1001), True, 6000),
    ("hd720", "hd720", "inter", 1280, 720, (60000, 1001), False, 12000),
    ("hd1080i", "hd1080i", "inter", 1920, 1080, (30000, 1001), True, 18000),
]

# name, class, kind, width, height, rate (num, den), interlaced, bitrate kbit/s
SAMPLES = [
    ("sd-inter", "sd", "inter", 720, 480, (30000, 1001), True, 6000),
    ("sd-intra", "sd", "intra", 720, 480, (30000, 1001), True, 8000),
    ("hd720-inter", "hd720", "inter", 1280, 720, (60000, 1001), False, 12000),
    ("hd720-intra", "hd720", "intra", 1280, 720, (60000, 1001), False, 16000),
    ("hd1080i-inter", "hd1080i", "inter", 1920, 1080, (30000, 1001), True, 18000),
    ("hd1080i-intra", "hd1080i", "intra", 1920, 1080, (30000, 1001), True, 24000),
]


def fnv1a64(data: bytes) -> str:
    h = 0xCBF29CE484222325
    for b in data:
        h = ((h ^ b) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"


def encode(name, kind, width, height, rate, interlaced, kbps, out: Path, seconds=SECONDS) -> None:
    num, den = rate
    source = (
        f"testsrc2=size={width}x{height}:rate={num}/{den},"
        "noise=alls=10:allf=t:all_seed=20261021"
    )
    flags = "+bitexact" + ("+ildct+ilme" if interlaced else "")
    gop = ["-g", "1", "-bf", "0"] if kind == "intra" else ["-g", "15", "-bf", "2"]
    args = [
        str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", source, "-t", str(seconds),
        "-threads", "1", "-fflags", "+bitexact", "-flags", flags,
        "-c:v", "mpeg2video", "-pix_fmt", "yuv420p", *gop,
        "-b:v", f"{kbps}k", "-maxrate", f"{kbps}k", "-bufsize", f"{kbps // 2}k",
    ]
    if interlaced:
        args += ["-top", "1"]
    args += ["-f", "mpeg2video", str(out)]
    subprocess.run(args, check=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "artifacts" / "trier-video-calibration" / "samples"))
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--record", action="store_true")
    ap.add_argument("--app", action="store_true")
    a = ap.parse_args()
    samples, recorded, seconds = SAMPLES, RECORDED, SECONDS
    if a.app:
        samples, recorded, seconds = APP_SAMPLES, APP_RECORDED, 0.5
        if a.out == ap.get_default("out"):
            a.out = str(APP_OUT)
    if not FFMPEG.exists():
        print(f"ffmpeg not found: {FFMPEG}", file=sys.stderr)
        return 1
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for name, cls, kind, w, h, rate, interlaced, kbps in samples:
        path = out / f"{name}.m2v"
        encode(name, kind, w, h, rate, interlaced, kbps, path, seconds)
        data = path.read_bytes()
        rows.append(
            "\t".join([name, cls, kind, str(w), str(h), str(rate[0]), str(rate[1]),
                       str(len(data)), fnv1a64(data)])
        )
        print(f"{name}: {len(data)} bytes sha256 {hashlib.sha256(data).hexdigest()[:16]}")
    manifest = "name\tclass\tkind\twidth\theight\trate_num\trate_den\tbytes\tfnv64\n" + "\n".join(rows) + "\n"
    (out / "samples.tsv").write_text(manifest, encoding="utf-8", newline="\n")
    version = subprocess.run([str(FFMPEG), "-version"], capture_output=True, text=True).stdout.splitlines()[0]
    print(version)
    if a.record:
        recorded.write_text(manifest, encoding="utf-8", newline="\n")
        print(f"recorded {recorded}")
    if a.check:
        if not recorded.exists():
            print("no recorded manifest", file=sys.stderr)
            return 1
        if recorded.read_text(encoding="utf-8") != manifest:
            print("samples differ from the recorded manifest", file=sys.stderr)
            return 1
        print("samples match the recorded manifest")
    return 0


if __name__ == "__main__":
    sys.exit(main())
