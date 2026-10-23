"""Why are some pictures slow? Reads Trier MPEG Video's per-picture trace from
the app (logcat tag TrierMpegVideoTrace, lines "T,...") and reports whether the
slowest pictures are explained by their content (computational) or by clock,
core moves and scheduling (environmental). docs/trier-mpeg-video.md, INV-PERF-TAIL.

  adb shell setprop debug.genx.trier.trace 1      (before the player starts)
  adb logcat -d -s TrierMpegVideoTrace:I | grep -o "T,.*" > trace.csv
  python -B -X utf8 scripts/trier-video/tail_analysis.py trace.csv [skip]

Columns: call, type (1 I, 2 P, 3 B), structure, coefficients, coded, intra and
skipped macroblocks, wall us, thread CPU us, core, moved (0/1), kHz after the
call, frames held, pressure us, and the thread's own user-mode CPU cycles for
the call (0 where the system gives no counter). With cycles, each picture's
work is exact and its average clock is cycles / CPU time.
"""
import statistics
import sys

FIELDS = ["n", "type", "structure", "coef", "coded", "intra", "skipped", "wall", "cpu",
          "core", "moved", "khz", "held", "pressure", "cycles"]


def load(path, skip):
    rows = []
    for line in open(path, encoding="utf-8"):
        parts = line.strip().split(",")
        if parts[0] != "T" or len(parts) not in (len(FIELDS), len(FIELDS) + 1):
            continue
        row = dict(zip(FIELDS, map(int, parts[1:])))
        row.setdefault("cycles", 0)
        if row["cycles"] and row["cpu"]:
            row["mhz"] = row["cycles"] / row["cpu"]
        else:
            row["mhz"] = row["khz"] / 1000
            row["cycles"] = int(row["cpu"] * row["khz"] / 1000)
        rows.append(row)
    return rows[skip:]


def pct(values, q):
    v = sorted(values)
    return v[min(len(v) - 1, round((len(v) - 1) * q))]


def pearson(xs, ys):
    mx, my = statistics.mean(xs), statistics.mean(ys)
    sx = sum((x - mx) ** 2 for x in xs) ** 0.5
    sy = sum((y - my) ** 2 for y in ys) ** 0.5
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy) if sx and sy else 0.0


def least_squares(features, target):
    """Plain normal equations, small and dependency-free."""
    k = len(features[0])
    a = [[sum(f[i] * f[j] for f in features) for j in range(k)] for i in range(k)]
    b = [sum(f[i] * t for f, t in zip(features, target)) for i in range(k)]
    for col in range(k):
        pivot = max(range(col, k), key=lambda r: abs(a[r][col]))
        a[col], a[pivot] = a[pivot], a[col]
        b[col], b[pivot] = b[pivot], b[col]
        for r in range(k):
            if r != col and a[col][col]:
                f = a[r][col] / a[col][col]
                a[r] = [x - f * y for x, y in zip(a[r], a[col])]
                b[r] -= f * b[col]
    return [b[i] / a[i][i] if a[i][i] else 0.0 for i in range(k)]


def describe(name, rows, all_rows):
    if not rows:
        return
    n = len(rows)
    share = lambda f: sum(1 for r in rows if f(r)) / n
    print(f"  {name}: {n} pictures")
    print(f"    I {share(lambda r: r['type'] == 1):.0%}  P {share(lambda r: r['type'] == 2):.0%}  "
          f"B {share(lambda r: r['type'] == 3):.0%}  field pictures {share(lambda r: r['structure'] != 3):.0%}")
    print(f"    coefficients mean {statistics.mean(r['coef'] for r in rows):,.0f} "
          f"(all pictures {statistics.mean(r['coef'] for r in all_rows):,.0f}); coded MBs "
          f"{statistics.mean(r['coded'] for r in rows):,.0f}; intra MBs {statistics.mean(r['intra'] for r in rows):,.0f}")
    print(f"    wall {statistics.mean(r['wall'] for r in rows):,.0f} us, thread CPU "
          f"{statistics.mean(r['cpu'] for r in rows):,.0f} us (waiting {statistics.mean(r['wall'] - r['cpu'] for r in rows):,.0f} us); "
          f"cycles {statistics.mean(r['cycles'] for r in rows) / 1e6:,.2f} M at {statistics.mean(r['mhz'] for r in rows):,.0f} MHz on average; moved core {share(lambda r: r['moved'] == 1):.0%}; "
          f"frames held min {min(r['held'] for r in rows)}")


def main():
    path = sys.argv[1]
    skip = int(sys.argv[2]) if len(sys.argv) > 2 else 300
    rows = load(path, skip)
    if len(rows) < 200:
        print("not enough trace lines", file=sys.stderr)
        return 1
    walls = [r["wall"] for r in rows]
    p50, p95, p99 = pct(walls, 0.5), pct(walls, 0.95), pct(walls, 0.99)
    print(f"{len(rows)} pictures after the first {skip}: wall p50 {p50} us, p95 {p95}, p99 {p99}, max {max(walls)}")

    describe("all", rows, rows)
    describe("slowest 5% (over p95)", [r for r in rows if r["wall"] > p95], rows)
    describe("slowest 1% (over p99)", [r for r in rows if r["wall"] > p99], rows)
    for t, name in [(1, "I pictures"), (2, "P pictures"), (3, "B pictures")]:
        sel = [r["wall"] for r in rows if r["type"] == t]
        if sel:
            print(f"  {name}: {len(sel)}, wall p50 {pct(sel, .5)} us p95 {pct(sel, .95)} p99 {pct(sel, .99)} max {max(sel)}")

    # Work model: cycles against the content.
    work = [r["cycles"] / 1e6 for r in rows]
    # (Coded plus skipped macroblocks is the picture's size: only coded is used.)
    feats = [[1.0, r["coef"] / 1e3, r["coded"] / 1e3, r["intra"] / 1e3] for r in rows]
    c = least_squares(feats, work)
    predicted = [sum(a * f for a, f in zip(c, fe)) for fe in feats]
    ss_res = sum((w - q) ** 2 for w, q in zip(work, predicted))
    ss_tot = sum((w - statistics.mean(work)) ** 2 for w in work)
    print(f"  content explains {1 - ss_res / ss_tot:.0%} of the variation in cycles per picture: M cycles = "
          f"{c[0]:.2f} + {c[1]:.3f} per 1,000 coefficients + {c[2]:.3f} per 1,000 coded MBs + "
          f"{c[3]:.3f} per 1,000 intra MBs")
    print(f"  correlation of wall time with: cycles {pearson(work, walls):.2f}, coefficients "
          f"{pearson([r['coef'] for r in rows], walls):.2f}, clock {pearson([r['mhz'] for r in rows], walls):.2f}, "
          f"waiting {pearson([r['wall'] - r['cpu'] for r in rows], walls):.2f}, core moves "
          f"{pearson([r['moved'] for r in rows], walls):.2f}")
    # Each of the slowest 1% against the median picture of its own type:
    # wall = cycles / clock + waiting, so the excess splits exactly into more
    # cycles (content), a lower clock, and more waiting.
    slow = [r for r in rows if r["wall"] > p99]
    med = {}
    for t in (1, 2, 3):
        sel = [r for r in rows if r["type"] == t]
        if sel:
            med[t] = {k: statistics.median(r[k] for r in sel) for k in ("wall", "cpu", "cycles", "mhz")}
            med[t]["wait"] = statistics.median(r["wall"] - r["cpu"] for r in sel)
    content = clock = waiting = 0.0
    for r in slow:
        m = med[r["type"]]
        content += (r["cycles"] - m["cycles"]) / m["mhz"]
        clock += r["cycles"] / r["mhz"] - r["cycles"] / m["mhz"]
        waiting += (r["wall"] - r["cpu"]) - m["wait"]
    total = content + clock + waiting
    for t, name in [(1, "I"), (2, "P")]:
        if t in med:
            print(f"  median {name} picture: {med[t]['cycles'] / 1e6:.2f} M cycles at {med[t]['mhz']:.0f} MHz, wall {med[t]['wall']:.0f} us")
    if total > 0:
        print(f"  slowest 1% ({len(slow)} pictures), excess over the median of their type: more work (content) "
              f"{content / total:.0%}, lower clock {clock / total:.0%}, waiting for a core {waiting / total:.0%}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
