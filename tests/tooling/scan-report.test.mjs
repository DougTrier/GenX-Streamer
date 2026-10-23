import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const script = path.resolve('scripts/scan-report.mjs');
const start = Date.parse('2026-10-22T04:00:00Z');
/** A controlled database copy: entries with checks of each kind. */
function fixture(file, rows) {
  const d = new DatabaseSync(file);
  d.exec(
    'CREATE TABLE source_snapshot_entry(source_id TEXT,entry_id TEXT,available INTEGER,check_ms INTEGER,check_verdict TEXT,evidence TEXT,channel TEXT)',
  );
  const insert = d.prepare('INSERT INTO source_snapshot_entry VALUES(?,?,1,?,?,?,?)');
  rows.forEach(([id, minute, verdict, kind, site], i) =>
    insert.run(
      's',
      id,
      start + minute * 60000 + i,
      verdict,
      JSON.stringify({ schemaVersion: 1, records: [{ evidence: { kind } }] }),
      JSON.stringify({ urls: [`https://${site}.test/${id}.m3u8`] }),
    ),
  );
  d.close();
}
const run = (...args) =>
  JSON.parse(execFileSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));

test('report: totals, kinds, pace and the per-site tail, with no addresses', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'scan-report-'));
  try {
    const file = path.join(dir, 'a.sqlite3');
    fixture(file, [
      ['w1', 1, 'Reachable', 'http', 'a'],
      ['w2', 2, 'Reachable', 'http', 'b'],
      ['s1', 3, 'TimedOut', 'slow', 'c'],
      ['h1', 6, 'TemporaryUnavailable', 'host-down', 'd'],
      ['e1', 7, 'TemporaryUnavailable', 'http', 'e'],
      ['n1', 8, 'TemporaryUnavailable', 'network-failure', 'f'],
      ['u1', 9, 'UnsupportedHere', 'unsupported', 'g'],
      ['t1', 11, 'TimedOut', 'timeout', 'big'],
      ['t2', 12, 'Reachable', 'http', 'big'],
      ['t3', 13, 'Reachable', 'http', 'big'],
    ]);
    const r = run('report', file, '2026-10-22T04:00:00Z');
    assert.equal(r.checks, 10);
    assert.equal(r.working, 4);
    assert.equal(r.workingShare, 40);
    assert.deepEqual(r.results, {
      working: 4,
      'host down': 1,
      'no connection': 1,
      'not playable here': 1,
      'server error': 1,
      'slow list': 1,
      timeout: 1,
    });
    assert.deepEqual(r.checksPer5Minutes, { '0m': 3, '5m': 4, '10m': 3 });
    assert.deepEqual(r.lastTenth, { checks: 1, sites: 1, biggestSites: [1] });
    assert.ok(!JSON.stringify(r).includes('.test/'), 'no addresses');
    // Deterministic: the same copy gives the same report.
    assert.deepEqual(run('report', file, '2026-10-22T04:00:00Z'), r);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('compare: streams working on both, on one, and why the other missed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'scan-report-'));
  try {
    const a = path.join(dir, 'a.sqlite3');
    const b = path.join(dir, 'b.sqlite3');
    fixture(a, [
      ['x', 1, 'Reachable', 'http', 'one'],
      ['y', 2, 'Reachable', 'http', 'two'],
      ['z', 3, 'TimedOut', 'slow', 'three'],
    ]);
    fixture(b, [
      ['x', 1, 'Reachable', 'http', 'one'],
      ['y', 2, 'TemporaryUnavailable', 'host-down', 'two'],
      ['z', 3, 'Reachable', 'http', 'three'],
    ]);
    const c = run('compare', a, '2026-10-22T04:00:00Z', b, '2026-10-22T04:00:00Z');
    assert.deepEqual(c, {
      streams: 3,
      workingOnBoth: 1,
      workingOnlyOnA: 1,
      workingOnlyOnB: 1,
      workingOnNeither: 0,
      whyBMissedA: { 'host down': 1 },
      whyAMissedB: { 'slow list': 1 },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
