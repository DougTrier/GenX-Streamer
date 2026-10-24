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

"""Build the embedded program-guide crosswalk pack from published iptv-org API files.

Usage: python -I -B -X utf8 scripts/build-guide-crosswalk-pack.py <dir-with-guides.json-and-feeds.json> <retrieved-utc> [--verify-feeds]

Inputs are the public https://iptv-org.github.io/api/guides.json and feeds.json files,
downloaded separately into a directory outside the checkout. The output is deterministic
(sorted keys, gzip mtime 0) so the pinned SHA-256 in crosswalk_pack.rs is reproducible.

The pack carries exact published tuples only:
  * feeds: i.mjh.nz feed path -> {canonical channel@feed -> exact XMLTV header ID}
    (site_id is "path#header" per iptv-org's i.mjh.nz site configuration).
    A canonical ID listed with two different headers in one feed is quarantined.
  * mainFeeds: feed ID -> channels whose published main feed it is, so a bare
    channel ID and its main-feed-qualified ID are recognized as the same identity.
No names, fuzzy rules or invented IDs are produced.

With --verify-feeds each feed is downloaded once (bounded) and only tuples whose exact
target header is present at generation time are kept; feeds with no present target or an
unavailable response are dropped. Per-feed counts and the verification time are recorded.
"""
import datetime
import gzip
import hashlib
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.&+'_-]{0,255}$")
FEED = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
PATH = re.compile(r"^[A-Za-z0-9_]+(?:/[A-Za-z0-9_]+){0,3}$")
HEADER = re.compile(r"^[^\x00-\x1f\x7f]{1,512}$")
MAX_INPUT = 64 * 1024 * 1024
FEED_PREFIX = "https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/"
FEED_LIMIT = 40 * 1024 * 1024


def feed_headers(path: str) -> set[str] | None:
    """Exact <channel id> values of one published feed, or None if unavailable."""
    request = urllib.request.Request(FEED_PREFIX + path + ".xml.gz", headers={"User-Agent": "genx-pack-builder"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read(FEED_LIMIT + 1)
    except Exception:  # noqa: BLE001 - an unavailable feed is recorded, not guessed
        return None
    if len(raw) > FEED_LIMIT:
        return None
    data = gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
    return {m.decode("utf-8", "replace") for m in re.findall(rb'<channel id="([^"]+)"', data)}


def load(path: Path):
    data = path.read_bytes()
    if len(data) > MAX_INPUT:
        raise SystemExit(f"{path.name} exceeds {MAX_INPUT} bytes")
    return data, json.loads(data.decode("utf-8"))


def main() -> None:
    verify = "--verify-feeds" in sys.argv[3:]
    if len(sys.argv) not in (3, 4) or (len(sys.argv) == 4 and not verify):
        raise SystemExit(__doc__)
    source = Path(sys.argv[1])
    retrieved = sys.argv[2]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", retrieved):
        raise SystemExit("retrieved-utc must look like 2026-10-16T17:00:00Z")
    guides_bytes, guides = load(source / "guides.json")
    feeds_bytes, feeds = load(source / "feeds.json")
    if not isinstance(guides, list) or not isinstance(feeds, list):
        raise SystemExit("unexpected API document shape")

    pairs: dict[str, dict[str, set[str]]] = {}
    for row in guides:
        if row.get("site") != "i.mjh.nz" or not row.get("channel") or not row.get("feed"):
            continue
        channel, feed, site_id = row["channel"], row["feed"], row.get("site_id", "")
        if "#" not in site_id:
            raise SystemExit(f"malformed site_id {site_id!r}")
        path, header = site_id.split("#", 1)
        if not (ID.match(channel) and FEED.match(feed) and PATH.match(path) and HEADER.match(header)):
            raise SystemExit(f"refused row {row!r}")
        pairs.setdefault(path, {}).setdefault(f"{channel}@{feed}", set()).add(header)

    out_feeds: dict[str, dict[str, str]] = {}
    quarantined: dict[str, list[str]] = {}
    for path in sorted(pairs):
        for key, headers in sorted(pairs[path].items()):
            if len(headers) == 1:
                out_feeds.setdefault(path, {})[key] = next(iter(headers))
            else:
                quarantined.setdefault(path, []).append(key)

    verification: dict[str, dict[str, int | str]] = {}
    if verify:
        for path in sorted(out_feeds):
            headers = feed_headers(path)
            table = out_feeds[path]
            if headers is None:
                verification[path] = {"tuples": len(table), "present": 0, "status": "unavailable"}
                del out_feeds[path]
                continue
            kept = {key: header for key, header in table.items() if header in headers}
            verification[path] = {"tuples": len(table), "present": len(kept), "status": "verified" if kept else "no-present-target"}
            if kept:
                out_feeds[path] = kept
            else:
                del out_feeds[path]

    main_feeds: dict[str, list[str]] = {}
    seen: set[str] = set()
    for row in feeds:
        if not row.get("is_main"):
            continue
        channel, feed = row.get("channel"), row.get("id")
        if not (isinstance(channel, str) and ID.match(channel) and isinstance(feed, str) and FEED.match(feed)):
            raise SystemExit(f"refused feed {row!r}")
        if channel in seen:
            raise SystemExit(f"two main feeds for {channel}")
        seen.add(channel)
        main_feeds.setdefault(feed, []).append(channel)
    for channels in main_feeds.values():
        channels.sort()

    pack = {
        "schemaVersion": 1,
        "provenance": {
            "guides": "https://iptv-org.github.io/api/guides.json",
            "guidesSha256": hashlib.sha256(guides_bytes).hexdigest(),
            "feeds": "https://iptv-org.github.io/api/feeds.json",
            "feedsSha256": hashlib.sha256(feeds_bytes).hexdigest(),
            "retrievedUtc": retrieved,
            "site": "i.mjh.nz",
            "siteConfiguration": "https://raw.githubusercontent.com/iptv-org/epg/master/sites/i.mjh.nz/i.mjh.nz.config.js",
            **({"feedVerification": {"verifiedUtc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "feeds": verification}} if verify else {}),
        },
        "feeds": out_feeds,
        "quarantined": quarantined,
        "mainFeeds": dict(sorted(main_feeds.items())),
    }
    text = json.dumps(pack, ensure_ascii=False, sort_keys=False, separators=(",", ":")).encode("utf-8")
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", compresslevel=9, mtime=0, filename="") as stream:
        stream.write(text)
    target = Path(__file__).resolve().parent.parent / "src-tauri" / "src" / "guide" / "crosswalk-pack.json.gz"
    target.write_bytes(buffer.getvalue())
    print(json.dumps({
        "output": str(target),
        "bytes": len(buffer.getvalue()),
        "expandedBytes": len(text),
        "sha256": hashlib.sha256(buffer.getvalue()).hexdigest(),
        "feeds": len(out_feeds),
        "pairs": sum(len(v) for v in out_feeds.values()),
        "quarantined": sum(len(v) for v in quarantined.values()),
        "mainFeedChannels": len(seen),
    }, indent=2))


if __name__ == "__main__":
    main()
