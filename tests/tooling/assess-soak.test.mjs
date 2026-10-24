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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assessSoak, summarizeSoak } from '../../scripts/assess-soak.mjs';

const samples = () => Array.from({ length: 20 }, (_, index) => ({
  elapsedSeconds: index * 60,
  heapBytes: 1000 + index * 60,
  appTotalPssKb: 1024 + index,
  processes: [
    { PrivateMemorySize64: 10000 + index, WorkingSet64: 20000, HandleCount: 10 },
    { PrivateMemorySize64: 1000, WorkingSet64: 2000, HandleCount: 2 },
  ],
  fixture: { activeSockets: 2, activeResponses: 1, timers: 0 },
}));
test('warmup excluded; aggregate memory, KiB conversion and measured trend remain descriptive', () => {
  const input = samples(); input[0].heapBytes = 99999999;
  const result = summarizeSoak({ status: 'PASS' }, input);
  assert.equal(result.status, 'MEASUREMENTS_ONLY');
  assert.match(result.memoryAcceptance, /NOT_VERIFIED/);
  assert.equal(result.measurements.heapBytes.samples, 15);
  assert.equal(result.measurements.heapBytes.maximum, 2140);
  assert.ok(Math.abs(result.measurements.heapBytes.linearChangePerHour - 3600) < 1e-6);
  assert.equal(result.measurements.privateBytes.maximum, 11019);
  assert.equal(result.measurements.appPssBytes.maximum, 1043 * 1024);
  assert.equal(result.measurements.handles.maximum, 12);
  assert.deepEqual(result.maximumObservedFixtureResources.timers, { maximum: 0, samples: 20 });
});
test('failure, incomplete report and missing memory/resources never become accepted or zero measurements', () => {
  for (const report of [{ status: 'FAIL' }, {}, { status: 'secret-url' }]) {
    const result = summarizeSoak(report, [{ elapsedSeconds: 301 }, { elapsedSeconds: 302 }]);
    assert.notEqual(result.status, 'PASS');
    assert.equal(result.measurements.heapBytes.status, 'MISSING');
    assert.deepEqual(result.maximumObservedFixtureResources.activeSockets, { maximum: null, samples: 0 });
    assert.ok(!JSON.stringify(result).includes('secret-url'));
  }
});
test('short observations do not extrapolate an hourly memory trend', () => {
  const result = summarizeSoak({}, samples().slice(0, 3), 0);
  assert.equal(result.measurements.heapBytes.trendStatus, 'TOO_SHORT');
  assert.equal(result.measurements.heapBytes.linearChangePerHour, null);
  assert.equal(result.measurements.heapBytes.observedSpanSeconds, 120);
});
test('nonmonotonic timestamps and invalid counts/warmup fail without silently pruning evidence', () => {
  assert.throws(() => summarizeSoak({}, []), /count/);
  assert.throws(() => summarizeSoak({}, [{ elapsedSeconds: 2 }, { elapsedSeconds: 2 }]), /increasing/);
  assert.throws(() => summarizeSoak({}, [{ elapsedSeconds: 2 }, { elapsedSeconds: 1 }]), /increasing/);
  assert.throws(() => summarizeSoak({}, samples(), NaN), /warmup/);
  assert.throws(() => summarizeSoak({}, samples(), 3601), /warmup/);
});
async function temporary(work) {
  const parent = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(parent, 'genx-soak-assessment-'));
  try { await work(directory); }
  finally {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    assert.match(path.basename(directory), /^genx-soak-assessment-/);
    await rm(directory, { recursive: true, force: true });
  }
}
test('streamed JSONL retains hashes and drops provider histories/process names', async () => {
  await temporary(async (directory) => {
    const report = path.join(directory, 'report.json'), input = path.join(directory, 'samples.jsonl');
    await writeFile(report, JSON.stringify({ status: 'FAIL', secret: 'do-not-export' }));
    const data = samples(); data[0].fixture.requests = ['https://secret-provider/path?key=secret'];
    data[0].processes[0].ProcessName = 'secret-name';
    await writeFile(input, data.map((sample) => JSON.stringify(sample)).join('\r\n') + '\r\n');
    const result = await assessSoak(report, input);
    assert.match(result.reportSha256, /^[a-f0-9]{64}$/);
    assert.match(result.samplesSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.samples, 20);
    assert.ok(!/secret-provider|secret-name|do-not-export/.test(JSON.stringify(result)));
    assert.equal(result.terminalReportStatus, 'FAIL');
  });
});
test('oversized individual line and malformed sample fail rather than truncate', async () => {
  await temporary(async (directory) => {
    const report = path.join(directory, 'report.json'), input = path.join(directory, 'samples.jsonl');
    await writeFile(report, '{}');
    await writeFile(input, JSON.stringify({ elapsedSeconds: 1, extra: 'x'.repeat(512 * 1024) }));
    await assert.rejects(assessSoak(report, input), /bounds/);
    await writeFile(input, '{malformed}\n');
    await assert.rejects(assessSoak(report, input), SyntaxError);
  });
});
