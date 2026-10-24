#!/usr/bin/env node

/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Deterministic scan report (owner request, October 22, 2026: audits should not
// need hand analysis). Reads GenX database copies only; prints no addresses.
//
//   node scripts/scan-report.mjs pull <adb-serial> <out.sqlite3>
//       Copies a debug build's database from an Android device (run-as) and
//       checks it with PRAGMA quick_check. Take it with GenX closed (ordinary
//       exit): copies taken while GenX was starting up or frozen in the
//       background came out torn, and the check refused them.
//   node scripts/scan-report.mjs report <db.sqlite3> <scan-start ISO> [--json]
//       The scan's results since its start: totals, verdicts by kind, checks
//       per 5 minutes, sites in the last tenth of checks, Slow list, host-down.
//   node scripts/scan-report.mjs compare <a.sqlite3> <a-start> <b.sqlite3> <b-start> [--json]
//       Two devices' scans stream by stream (matched by first stream address).
//
// Requires Node 22 or newer (node:sqlite). Exit code 1 on a bad copy or input.
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ADB = process.env.ADB ?? 'adb';
const [command, ...args] = process.argv.slice(2);
const json = args.includes('--json');
const positional = args.filter((a) => a !== '--json');

function fail(message) {
  console.error(message);
  process.exit(1);
}
function open(path) {
  const d = new DatabaseSync(path, { readOnly: true });
  const check = d.prepare('PRAGMA quick_check').get();
  if (check.quick_check !== 'ok')
    fail(`${path}: database copy is not intact (${check.quick_check})`);
  return d;
}
function since(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) fail(`not a time: ${iso}`);
  return t;
}
const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
};
/** One stable label per result, the same words the docs use. */
function label(r) {
  if (!r) return 'not checked';
  if (r.v === 'Reachable' || r.v === 'PlayedHere') return 'working';
  if (r.v === 'UnsupportedHere') return 'not playable here';
  if (r.k === 'http') return 'server error';
  if (r.k === 'slow') return 'slow list';
  if (r.k === 'host-down') return 'host down';
  if (r.k === 'timeout') return 'timeout';
  return 'no connection';
}
function rows(d, start) {
  return d
    .prepare(
      `SELECT check_ms t, check_verdict v, json_extract(evidence,'$.records[0].evidence.kind') k, json_extract(channel,'$.urls[0]') url FROM source_snapshot_entry WHERE check_ms >= ? AND available=1 ORDER BY check_ms, entry_id`,
    )
    .all(start);
}
function sorted(counts) {
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
  );
}
function count(list, key) {
  const out = {};
  for (const item of list) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return sorted(out);
}

function report(path, startIso) {
  const d = open(path);
  const start = since(startIso);
  const checks = rows(d, start);
  // One result per stream: its newest check (copies of a stream share it).
  const streams = new Map();
  for (const r of checks) streams.set(r.url, r);
  const results = [...streams.values()];
  const first = checks[0]?.t ?? start;
  const pace = {};
  for (const r of checks) {
    const minute = Math.floor((r.t - first) / 300000) * 5;
    pace[`${minute}m`] = (pace[`${minute}m`] ?? 0) + 1;
  }
  const tail = checks.slice(Math.floor(checks.length * 0.9));
  const tailSites = count(tail, (r) => host(r.url));
  const working = results.filter((r) => label(r) === 'working').length;
  const out = {
    scanStart: new Date(start).toISOString(),
    firstCheck: checks.length ? new Date(first).toISOString() : null,
    lastCheck: checks.length ? new Date(checks.at(-1).t).toISOString() : null,
    checks: checks.length,
    streams: results.length,
    working,
    workingShare: results.length ? Math.round((working / results.length) * 1000) / 10 : 0,
    results: count(results, label),
    sites: new Set(results.map((r) => host(r.url))).size,
    checksPer5Minutes: pace,
    lastTenth: {
      checks: tail.length,
      sites: Object.keys(tailSites).length,
      biggestSites: Object.values(tailSites).slice(0, 5),
    },
  };
  return out;
}

function compare(aPath, aStart, bPath, bStart) {
  const read = (path, start) => {
    const m = new Map();
    for (const r of rows(open(path), since(start))) m.set(r.url, r);
    return m;
  };
  const A = read(aPath, aStart);
  const B = read(bPath, bStart);
  const urls = new Set([...A.keys(), ...B.keys()]);
  let both = 0;
  let onlyA = 0;
  let onlyB = 0;
  let neither = 0;
  const whyNotA = {};
  const whyNotB = {};
  for (const u of urls) {
    const wa = label(A.get(u)) === 'working';
    const wb = label(B.get(u)) === 'working';
    if (wa && wb) both++;
    else if (wa) {
      onlyA++;
      const k = label(B.get(u));
      whyNotB[k] = (whyNotB[k] ?? 0) + 1;
    } else if (wb) {
      onlyB++;
      const k = label(A.get(u));
      whyNotA[k] = (whyNotA[k] ?? 0) + 1;
    } else neither++;
  }
  return {
    streams: urls.size,
    workingOnBoth: both,
    workingOnlyOnA: onlyA,
    workingOnlyOnB: onlyB,
    workingOnNeither: neither,
    whyBMissedA: sorted(whyNotB),
    whyAMissedB: sorted(whyNotA),
  };
}

function print(value) {
  if (json) {
    console.log(JSON.stringify(value, null, 1));
    return;
  }
  for (const [key, item] of Object.entries(value))
    console.log(
      `${key}: ${typeof item === 'object' && item !== null ? JSON.stringify(item) : item}`,
    );
}

if (command === 'pull') {
  const [serial, out] = positional;
  if (!serial || !out) fail('usage: pull <adb-serial> <out.sqlite3>');
  let bytes;
  try {
    bytes = execFileSync(
      ADB,
      ['-s', serial, 'exec-out', 'run-as', 'com.tmg.tv', 'cat', 'genx.sqlite3'],
      { maxBuffer: 2 ** 31 - 1, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    fail(`${serial}: could not read GenX's database (device offline or asleep?)`);
  }
  if (!bytes.length) fail(`${serial}: GenX's database came back empty`);
  writeFileSync(out, bytes);
  open(out);
  console.log(`copied ${bytes.length} bytes; quick_check ok`);
} else if (command === 'report') {
  const [path, start] = positional;
  if (!path || !start) fail('usage: report <db.sqlite3> <scan-start ISO> [--json]');
  print(report(path, start));
} else if (command === 'compare') {
  const [a, aStart, b, bStart] = positional;
  if (!a || !aStart || !b || !bStart)
    fail('usage: compare <a.sqlite3> <a-start> <b.sqlite3> <b-start> [--json]');
  print(compare(a, aStart, b, bStart));
} else {
  fail('usage: scan-report.mjs pull|report|compare … (see the header)');
}
