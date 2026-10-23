"""Trier MPEG Video scorecard: the same fixed corpus through Trier MPEG Video,
FFmpeg and libmpeg2 (when the lab is built with it, --libmpeg2), scored on seven tests
(docs/trier-mpeg-video.md, "Comparison"):

  1 valid streams          conformant reconstruction
  2 pixel-by-pixel         zero differences where exact equivalence is expected
  3 reference compliance   within the reconstruction tolerances (IEEE 1180 IDCT)
  4 malformed streams      no unsafe failures (panic, crash, hang)
  5 damaged pictures       controlled recovery, measured visual quality
  6 frame count and order  correct and consistent
  7 speed                  Trier against the others on the targeted workloads

Reference decoders are measuring sticks only; nothing here ships.

  python -B -X utf8 scripts/trier-video/compare.py --lab <trier-video-bench.exe>
      --captures <dir of .m2v> --work <work folder>
      [--out artifacts/trier-video-compare] [--seeds 3] [--quick]

Writes report.json and report.md in a new dated folder under --out. Exits
nonzero when a mandatory result fails or is missing.
"""
import argparse
import json
import os
import platform
import re
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FFMPEG = ROOT / "node_modules" / "ffmpeg-static" / "ffmpeg.exe"

# The generated fixtures of src-tauri/src/trier_video/tests.rs (testsrc2, 25 fps, 2 s).
FIXTURES = [
    ("progressive", 352, 288, ["-g", "12", "-bf", "2", "-b:v", "1500k"]),
    ("intra", 352, 288, ["-g", "1", "-q:v", "2"]),
    ("options", 352, 288, ["-g", "12", "-bf", "2", "-intra_vlc", "1", "-alternate_scan", "1",
                           "-non_linear_quant", "1", "-qmax", "28", "-dc", "10", "-b:v", "2000k"]),
    ("interlaced", 720, 576, ["-g", "12", "-bf", "2", "-flags", "+ildct+ilme", "-top", "1", "-b:v", "4000k"]),
    ("hd", 1280, 720, ["-g", "15", "-bf", "2", "-b:v", "8000k", "-intra_vlc", "1"]),
]
DAMAGE = ["flip:20", "flip:200", "loss:20", "loss:100", "drop:5", "drop:20", "cut:0.5"]
TIMEOUT = 300


def run(cmd, timeout=TIMEOUT, env=None):
    started = time.perf_counter()
    try:
        p = subprocess.run([str(c) for c in cmd], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout,
                           env={**os.environ, **env} if env else None)
        return p.returncode, p.stdout, p.stderr, time.perf_counter() - started
    except subprocess.TimeoutExpired:
        return "timeout", "", "", time.perf_counter() - started


def last_json(text):
    for line in reversed(text.strip().splitlines()):
        if line.startswith("{"):
            return json.loads(line)
    return None


def size_of(path):
    """Width and height from the first sequence header."""
    data = Path(path).read_bytes()
    i = data.find(b"\x00\x00\x01\xb3")
    if i < 0:
        raise ValueError(f"no sequence header in {path}")
    b = data[i + 4:i + 7]
    return (b[0] << 4) | (b[1] >> 4), ((b[1] & 15) << 8) | b[2]


def ffmpeg_decode(src, out, idct="faani", threads=1):
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-threads", str(threads)]
    if idct:
        cmd += ["-idct", idct]
    cmd += ["-i", src, "-f", "rawvideo", "-pix_fmt", "yuv420p", out]
    code, _, err, seconds = run(cmd)
    return {"decoder": "ffmpeg", "exit": code, "seconds": round(seconds, 3),
            "stderrLines": len(err.splitlines()), "frames": frames_in(out, src)}


def frames_in(yuv, src):
    try:
        w, h = size_of(src)
        return os.path.getsize(yuv) // (w * h * 3 // 2)
    except (OSError, ValueError):
        return 0


def trier_decode(lab, src, out):
    code, stdout, _, seconds = run([lab, "decode", src, out])
    result = last_json(stdout) or {}
    result.update({"exit": code, "seconds": round(seconds, 3)})
    return result


def libmpeg2_decode(lab, src, out):
    code, stdout, _, seconds = run([lab, "decode-libmpeg2", src, out])
    result = last_json(stdout) or {}
    # A crash inside libmpeg2 ends the process: reported as its unsafe failure.
    result.update({"exit": code, "seconds": round(seconds, 3)})
    return result


def libmpeg2_speed(lab, src, repeats=3):
    code, stdout, _, _ = run([lab, "speed-libmpeg2", src, str(repeats)])
    r = last_json(stdout) if code == 0 else None
    return r.get("picturesPerSecond") if r else None


def compare(lab, ref, test, w, h, align=False):
    cmd = [lab, "compare", ref, test, w, h] + (["align"] if align else [])
    code, stdout, _, _ = run(cmd)
    return last_json(stdout) if code == 0 else {"error": f"compare exit {code}"}


def ffmpeg_speed(src, threads=1, repeats=3):
    rates = []
    for _ in range(repeats):
        code, _, err, _ = run([FFMPEG, "-hide_banner", "-threads", str(threads), "-benchmark",
                               "-i", src, "-f", "null", "-"])
        frames = re.findall(r"frame=\s*(\d+)", err)
        rtime = re.search(r"rtime=([\d.]+)s", err)
        if code == 0 and frames and rtime:
            rates.append(int(frames[-1]) / float(rtime.group(1)))
    return round(statistics.median(rates), 1) if rates else None


def trier_speed(lab, src, repeats=3, threads=1):
    code, stdout, _, _ = run([lab, src, str(repeats), "16683", "nohash"],
                             env={"TRIER_VIDEO_THREADS": str(threads)})
    m = re.search(r"([\d.]+) pictures/s decoding", stdout)
    tail = re.search(r"all: n=\s*\d+ mean\s+(\d+) us\s+p50\s+(\d+) p95\s+(\d+) p99\s+(\d+) max\s+(\d+)", stdout)
    return {"picturesPerSecond": float(m.group(1)) if m else None,
            "meanUs": int(tail.group(1)) if tail else None,
            "p95Us": int(tail.group(3)) if tail else None,
            "p99Us": int(tail.group(4)) if tail else None,
            "maxUs": int(tail.group(5)) if tail else None}


def remove(*paths):
    for p in paths:
        try:
            os.remove(p)
        except FileNotFoundError:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lab", required=True, help="trier-video-bench executable (PC build)")
    ap.add_argument("--captures", help="folder of broadcast .m2v captures")
    ap.add_argument("--work", required=True, help="scratch folder for raw frames (deleted as it goes)")
    ap.add_argument("--out", default=str(ROOT / "artifacts" / "trier-video-compare"))
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--quick", action="store_true", help="damage only the hd fixture and two captures")
    ap.add_argument("--libmpeg2", action="store_true", help="the lab was built with libmpeg2 (build.rs)")
    ap.add_argument("--speed-only", action="store_true",
                    help="test 7 only: pictures/s of each decoder on every stream (for stage-by-stage A/B)")
    a = ap.parse_args()
    lab = Path(a.lab)
    work = Path(a.work)
    work.mkdir(parents=True, exist_ok=True)
    if not FFMPEG.exists() or not lab.exists():
        print("missing ffmpeg or lab executable", file=sys.stderr)
        return 2

    corpus = []
    for name, w, h, args in FIXTURES:
        es = work / f"{name}.m2v"
        code, _, err, _ = run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                               f"testsrc2=size={w}x{h}:rate=25", "-t", "2", "-c:v", "mpeg2video", *args,
                               "-f", "mpeg2video", es])
        if code != 0:
            print(f"fixture {name} failed: {err}", file=sys.stderr)
            return 2
        corpus.append({"name": name, "kind": "generated", "path": es})
    if a.captures:
        for es in sorted(Path(a.captures).glob("*.m2v")):
            corpus.append({"name": es.stem, "kind": "broadcast", "path": es})

    if a.speed_only:
        return speed_only(a, lab, corpus)

    results = {"started": datetime.now(timezone.utc).isoformat(), "host": platform.node(),
               "cpu": platform.processor(), "ffmpeg": run([FFMPEG, "-hide_banner", "-version"])[1].splitlines()[0],
               "lab": str(lab), "seeds": a.seeds, "libmpeg2": a.libmpeg2, "streams": [], "damage": []}

    for item in corpus:
        src = item["path"]
        w, h = size_of(src)
        faani, default, trier = work / "ref-faani.yuv", work / "ref-default.yuv", work / "trier.yuv"
        entry = {"name": item["name"], "kind": item["kind"], "width": w, "height": h,
                 "bytes": os.path.getsize(src)}
        entry["ffmpegFaani"] = ffmpeg_decode(src, faani, "faani")
        entry["ffmpegDefault"] = ffmpeg_decode(src, default, None)
        entry["trier"] = trier_decode(lab, src, trier)
        entry["trierVsFaani"] = compare(lab, faani, trier, w, h)
        entry["trierVsDefault"] = compare(lab, default, trier, w, h)
        # How far FFmpeg's own two inverse DCTs are apart: the tolerance yardstick.
        entry["faaniVsDefault"] = compare(lab, faani, default, w, h)
        entry["speed"] = {"trier": trier_speed(lab, src), "ffmpeg1": ffmpeg_speed(src, 1),
                          "trier2": trier_speed(lab, src, threads=2), "ffmpeg2": ffmpeg_speed(src, 2),
                          "ffmpegAuto": ffmpeg_speed(src, 0)}
        if a.libmpeg2:
            lm = work / "libmpeg2.yuv"
            entry["libmpeg2"] = libmpeg2_decode(lab, src, lm)
            entry["libmpeg2VsFaani"] = compare(lab, faani, lm, w, h)
            entry["speed"]["libmpeg2"] = libmpeg2_speed(lab, src)
            remove(lm)
        results["streams"].append(entry)
        print(f"{item['name']}: trier {entry['trier'].get('frames')} frames, vs faani "
              f"{entry['trierVsFaani'].get('psnrMin')} dB min, identical {entry['trierVsFaani'].get('identicalFrames')}; "
              f"speed trier {entry['speed']['trier']['picturesPerSecond']} vs ffmpeg {entry['speed']['ffmpeg1']} pictures/s",
              flush=True)

        damage_this = not a.quick or item["name"] in ("hd", "aande", "bbcamerica")
        if damage_this:
            for mode in DAMAGE:
                for seed in range(1, a.seeds + 1):
                    dmg = work / "damaged.m2v"
                    run([lab, "damage", src, dmg, seed, mode])
                    t_out, f_out = work / "d-trier.yuv", work / "d-ffmpeg.yuv"
                    t = trier_decode(lab, dmg, t_out)
                    f = ffmpeg_decode(dmg, f_out, "faani")
                    row = {"stream": item["name"], "mode": mode, "seed": seed,
                           "trier": {k: t.get(k) for k in ("exit", "panic", "frames", "errors", "concealedSlices", "seconds")},
                           "ffmpeg": {k: f.get(k) for k in ("exit", "frames", "seconds", "stderrLines")},
                           "trierQuality": compare(lab, faani, t_out, w, h, align=True),
                           "ffmpegQuality": compare(lab, faani, f_out, w, h, align=True)}
                    if a.libmpeg2:
                        l_out = work / "d-libmpeg2.yuv"
                        lm = libmpeg2_decode(lab, dmg, l_out)
                        row["libmpeg2"] = {k: lm.get(k) for k in ("exit", "frames", "seconds")}
                        row["libmpeg2Quality"] = compare(lab, faani, l_out, w, h, align=True)
                        remove(l_out)
                    results["damage"].append(row)
                    remove(dmg, t_out, f_out)
            print(f"  damage: {len(DAMAGE) * a.seeds} variants", flush=True)
        remove(faani, default, trier)

    results["finished"] = datetime.now(timezone.utc).isoformat()
    verdict = score(results)
    results["scorecard"] = verdict
    out = Path(a.out) / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(results, indent=1, default=str), encoding="utf-8")
    (out / "report.md").write_text(markdown(results, verdict), encoding="utf-8")
    print(f"report: {out}")
    for row in verdict:
        print(f"  {row['test']}: {row['status']} - {row['summary']}")
    return 0 if all(r["status"] in ("PASS", "INFO") for r in verdict) else 1


def speed_only(a, lab, corpus):
    rows = []
    for item in corpus:
        t = trier_speed(lab, item["path"])
        t2 = trier_speed(lab, item["path"], threads=2)
        row = {"name": item["name"], "trier": t["picturesPerSecond"], "trierMeanUs": t["meanUs"],
               "trierP99Us": t["p99Us"], "ffmpeg1": ffmpeg_speed(item["path"], 1),
               "trier2": t2["picturesPerSecond"], "ffmpeg2": ffmpeg_speed(item["path"], 2),
               "libmpeg2": libmpeg2_speed(lab, item["path"]) if a.libmpeg2 else None}
        rows.append(row)
        print(f"{row['name']}: Trier {row['trier']} / FFmpeg {row['ffmpeg1']} / libmpeg2 {row['libmpeg2']} pictures/s"
              f" (Trier {row['trier'] / row['ffmpeg1']:.2f}x FFmpeg"
              + (f", {row['trier'] / row['libmpeg2']:.2f}x libmpeg2" if row["libmpeg2"] else "")
              + f"); two cores Trier {row['trier2']} / FFmpeg {row['ffmpeg2']}", flush=True)
    out = Path(a.out) / ("speed-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    out.mkdir(parents=True, exist_ok=True)
    (out / "speed.json").write_text(json.dumps({"host": platform.node(), "lab": str(lab), "rows": rows}, indent=1),
                                    encoding="utf-8")
    print(f"report: {out}")
    return 0


def score(r):
    streams, damage = r["streams"], r["damage"]
    rows = []

    def add(test, status, summary):
        rows.append({"test": test, "status": status, "summary": summary})

    if not streams:
        add("all", "MISSING", "no streams decoded")
        return rows
    worst = min(s["trierVsFaani"].get("psnrMin", 0) for s in streams)
    clean_fail = [s["name"] for s in streams if s["trier"].get("exit") != 0 or s["trier"].get("errors")]
    lm_note = ""
    if all("libmpeg2VsFaani" in s for s in streams):
        lm_worst = min(s["libmpeg2VsFaani"].get("psnrMin", 0) for s in streams)
        lm_note = f"; libmpeg2 worst frame {lm_worst:.2f} dB against the same reference"
    add("1 valid streams", "PASS" if worst >= 45 and not clean_fail else "FAIL",
        f"{len(streams)} streams decoded; Trier worst frame {worst:.2f} dB against FFmpeg (float IDCT)"
        + lm_note + (f"; failed: {clean_fail}" if clean_fail else ""))
    exact = [s for s in streams if s["trierVsFaani"].get("identicalFrames") == s["trierVsFaani"].get("compared")]
    add("2 pixel-by-pixel", "INFO",
        f"bit-identical to FFmpeg's float IDCT in {len(exact)} of {len(streams)} streams "
        f"({', '.join(s['name'] for s in exact) or 'none'}); elsewhere samples differ in "
        f"{max(s['trierVsFaani'].get('samplesDiffering', 0) for s in streams):.4%} at most. MPEG-2 does not define one "
        "exact IDCT, so exact equality is expected only where both use the same arithmetic")
    beyond = [(s["name"], s["trierVsFaani"].get("samplesBeyondOne", 0), s["faaniVsDefault"].get("samplesBeyondOne", 0)) for s in streams]
    within = all(t <= max(f, 1e-4) * 1.5 for _, t, f in beyond)
    add("3 reference compliance", "PASS" if within else "FAIL",
        "IDCT meets IEEE 1180 (unit test); per stream, samples off by more than 1 from FFmpeg's float IDCT, "
        "against how far FFmpeg's own two IDCTs are apart: "
        + "; ".join(f"{n} {t:.4%} vs {f:.4%}" for n, t, f in beyond))
    unsafe = [d for d in damage if d["trier"].get("exit") not in (0,) or d["trier"].get("panic")]
    ff_unsafe = [d for d in damage if d["ffmpeg"].get("exit") not in (0,)]
    lm_unsafe = [d for d in damage if "libmpeg2" in d and d["libmpeg2"].get("exit") not in (0,)]
    add("4 malformed streams", "PASS" if damage and not unsafe else ("MISSING" if not damage else "FAIL"),
        f"{len(damage)} damaged variants: Trier unsafe failures {len(unsafe)} (panic, crash or hang); "
        f"FFmpeg nonzero exits {len(ff_unsafe)}"
        + (f"; libmpeg2 crashes or hangs {len(lm_unsafe)}" if any("libmpeg2" in d for d in damage) else ""))
    if damage:
        by_mode = {}
        for d in damage:
            m = by_mode.setdefault(d["mode"], {"t": [], "f": [], "l": []})
            m["t"].append(d["trierQuality"].get("psnrMean", 0) or 0)
            m["f"].append(d["ffmpegQuality"].get("psnrMean", 0) or 0)
            if "libmpeg2Quality" in d:
                m["l"].append(d["libmpeg2Quality"].get("psnrMean", 0) or 0)
        add("5 damaged pictures", "INFO", "mean PSNR against the clean decode, Trier / FFmpeg / libmpeg2: " + "; ".join(
            f"{k} {statistics.mean(v['t']):.1f} / {statistics.mean(v['f']):.1f} / "
            + (f"{statistics.mean(v['l']):.1f}" if v["l"] else "-") + " dB" for k, v in by_mode.items()))
    else:
        add("5 damaged pictures", "MISSING", "no damaged variants")
    order = [s["name"] for s in streams if s["trier"].get("frames") != s["ffmpegFaani"].get("frames")
             or s["trierVsFaani"].get("psnrMin", 0) < 45]
    add("6 frame count and order", "PASS" if not order else "FAIL",
        "every stream: same frame count as FFmpeg and every frame matched in display order"
        if not order else f"mismatch: {order}")
    wins = [s["name"] for s in streams if (s["speed"]["trier"]["picturesPerSecond"] or 0) >= (s["speed"]["ffmpeg1"] or 1e9)]
    add("7b speed (two cores)", "INFO", "pictures/s Trier / FFmpeg, two threads each: " + "; ".join(
        f"{s['name']} {s['speed']['trier2']['picturesPerSecond']:.0f} / {s['speed']['ffmpeg2']}" for s in streams))
    add("7 speed (one core)", "PASS" if len(wins) == len(streams) else "OPEN",
        "pictures/s Trier / FFmpeg one thread / libmpeg2 / FFmpeg all threads: " + "; ".join(
            f"{s['name']} {s['speed']['trier']['picturesPerSecond']:.0f} / {s['speed']['ffmpeg1']} / "
            f"{s['speed'].get('libmpeg2') or '-'} / {s['speed']['ffmpegAuto']}"
            for s in streams))
    return rows


def markdown(r, verdict):
    lines = [f"# Trier MPEG Video scorecard", "", f"Run {r['started']} to {r['finished']} on {r['host']} ({r['cpu']}); {r['ffmpeg']}; lab {r['lab']}.", "",
             "| Test | Status | Result |", "| --- | --- | --- |"]
    lines += [f"| {v['test']} | {v['status']} | {v['summary']} |" for v in verdict]
    lines += ["", "## Streams", "", "| Stream | Size | Frames T/F/L | Trier vs FFmpeg float: min / mean dB, identical frames | Trier vs FFmpeg default IDCT min dB | FFmpeg IDCTs apart min dB | libmpeg2 vs FFmpeg float min dB | pictures/s T / F1 / L / Fauto |",
              "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for s in r["streams"]:
        c, d, fd, sp = s["trierVsFaani"], s["trierVsDefault"], s["faaniVsDefault"], s["speed"]
        lm = s.get("libmpeg2VsFaani", {})
        lines.append(f"| {s['name']} | {s['width']}x{s['height']} | {s['trier'].get('frames')}/{s['ffmpegFaani'].get('frames')}/{s.get('libmpeg2', {}).get('frames', '-')} | "
                     f"{c.get('psnrMin')} / {c.get('psnrMean')}, {c.get('identicalFrames')}/{c.get('compared')} | {d.get('psnrMin')} | {fd.get('psnrMin')} | {lm.get('psnrMin', '-')} | "
                     f"{sp['trier']['picturesPerSecond']} / {sp['ffmpeg1']} / {sp.get('libmpeg2') or '-'} / {sp['ffmpegAuto']} |")
    if r["damage"]:
        lines += ["", "## Damage", "", "| Stream | Mode | Seed | Trier exit, frames, concealed slices | FFmpeg exit, frames | libmpeg2 exit, frames | PSNR mean T / F / L |", "| --- | --- | --- | --- | --- | --- | --- |"]
        for d in r["damage"]:
            t, f, l = d["trier"], d["ffmpeg"], d.get("libmpeg2", {})
            lines.append(f"| {d['stream']} | {d['mode']} | {d['seed']} | {t.get('exit')}, {t.get('frames')}, {t.get('concealedSlices')} | "
                         f"{f.get('exit')}, {f.get('frames')} | {l.get('exit', '-')}, {l.get('frames', '-')} | {d['trierQuality'].get('psnrMean')} / {d['ffmpegQuality'].get('psnrMean')} / {d.get('libmpeg2Quality', {}).get('psnrMean', '-')} |")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    sys.exit(main())
