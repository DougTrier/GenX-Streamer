"""Thread scaling of Trier MPEG Video and FFmpeg on the same stream: pictures/s
and the cores each actually used (CPU time / wall time), at each thread count.
Both are timed the same way here: the whole process decoding the stream three
times, frames discarded (Trier: `trier-video-bench <file> 3 ... nohash`, wall
from the process; FFmpeg: `-stream_loop 2 ... -f null -`).

  python -B -X utf8 scripts/trier-video/scaling.py --lab <trier-video-bench.exe> <file.m2v> [threads ...]
"""
import argparse
import os
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FFMPEG = ROOT / "node_modules" / "ffmpeg-static" / "ffmpeg.exe"


def timed(cmd, env=None):
    """Wall seconds and CPU seconds (user + system, all threads) of a process."""
    started = time.perf_counter()
    p = subprocess.Popen([str(c) for c in cmd], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         env={**os.environ, **(env or {})})
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        out, err = p.communicate()
        wall = time.perf_counter() - started
        # GetProcessTimes on the finished process: kernel and user time.
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, p.pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            handle = int(p._handle)
        ft = [wintypes.FILETIME() for _ in range(4)]
        kernel32.GetProcessTimes(int(p._handle), *[ctypes.byref(f) for f in ft])
        to_s = lambda f: ((f.dwHighDateTime << 32) | f.dwLowDateTime) / 1e7
        cpu = to_s(ft[2]) + to_s(ft[3])
    else:
        _, status, usage = os.wait4(p.pid, 0)
        out, err = p.stdout.read(), p.stderr.read()
        wall = time.perf_counter() - started
        cpu = usage.ru_utime + usage.ru_stime
    return wall, cpu, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def frames_of(text):
    found = re.findall(r"frame=\s*(\d+)", text)
    return int(found[-1]) if found else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lab", required=True)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("file")
    ap.add_argument("threads", nargs="*", type=int, default=[1, 2, 4, 8, 0])
    a = ap.parse_args()
    print(f"{a.file}: whole process, 3 passes, median of {a.rounds} rounds")
    print(f"{'threads':>8} | {'Trier pictures/s':>16} {'cores used':>10} | {'FFmpeg pictures/s':>17} {'cores used':>10}")
    for t in a.threads:
        rows = {"trier": [], "ffmpeg": []}
        for _ in range(a.rounds):
            if t != 0:
                wall, cpu, out, _ = timed([a.lab, a.file, "3", "16683", "nohash"],
                                          env={"TRIER_VIDEO_THREADS": str(t)})
                m = re.search(r"(\d+) frames out", out)
                if m:
                    rows["trier"].append((int(m.group(1)) / wall, cpu / wall))
            wall, cpu, _, err = timed([FFMPEG, "-hide_banner", "-threads", str(t), "-stream_loop", "2",
                                       "-i", a.file, "-f", "null", "-"])
            n = frames_of(err)
            if n:
                rows["ffmpeg"].append((n / wall, cpu / wall))
        cell = lambda r: (f"{statistics.median(x for x, _ in r):16.0f} {statistics.median(c for _, c in r):10.2f}"
                          if r else f"{'-':>16} {'-':>10}")
        label = "auto" if t == 0 else str(t)
        print(f"{label:>8} | {cell(rows['trier'])} | {cell(rows['ffmpeg']).replace('16', '17', 0)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
