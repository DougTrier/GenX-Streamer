import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { startLargeScanFixtureServer } from '../../scripts/large-scan-fixture-server.mjs';

const count = 65000;
const reachable = new Set(Array.from({ length: 2300 }, (_, i) => Math.floor((i * count) / 2300)));
const unavailableIndices = Array.from({ length: count }, (_, i) => i).filter((i) => !reachable.has(i));
const deviceOrigins = Array.from({ length: 16 }, (_, i) => `http://127.0.0.1:${26000 + i}`);

test('65,000 distinct candidates expose exactly2,300 interleaved reachable manifests with bounded counters', async () => {
  const input = unavailableIndices.slice();
  const fixture = await startLargeScanFixtureServer({
    deviceOrigins, count, seed: 'v17-65000', indexedSegments: true, unavailableIndices: input,
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
  try {
    input.length = 0; // Admission must retain an immutable snapshot of the caller's list.
    assert.equal(fixture.reachableCount, 2300);
    assert.equal(fixture.unavailableCount, 62700);
    const expected = fixture.expectedReachableDescriptors();
    assert.equal(expected.length, 2300);
    assert.equal(new Set(expected.map((d) => d.providerId)).size, 2300);
    assert.deepEqual(expected.map((d) => Number(new URL(d.url).pathname.split('/')[2])), [...reachable]);
    expected[0].name = 'caller mutation';
    assert.notEqual(fixture.expectedReachableDescriptors()[0].name, 'caller mutation');
    const catalog = await fetch(`${fixture.url}/catalog.m3u`);
    const body = Buffer.from(await catalog.arrayBuffer());
    assert.equal(body.length, fixture.playlistBytes);
    assert.ok(body.length < 20 * 1024 * 1024);
    assert.equal(createHash('sha256').update(body).digest('hex'), fixture.playlistSha256);
    const urls = body.toString('utf8').trim().split('\n').filter((line) => !line.startsWith('#'));
    assert.equal(urls.length, count);
    assert.equal(new Set(urls).size, count);
    assert.equal(new Set(fixture.descriptors().map((d) => d.providerId)).size, count);
    let next = 0, healthy = 0, failed = 0;
    const head = (index) => new Promise((resolve, reject) => {
      const request = http.request(`${fixture.url}/channel/${index}/index.m3u8`, { method: 'HEAD', agent }, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
        response.once('error', reject);
      });
      request.once('error', reject);
      request.setTimeout(2000, () => request.destroy(new Error('Local fixture HEAD timed out.')));
      request.end();
    });
    await Promise.all(Array.from({ length: 16 }, async () => {
      while (next < count) {
        const index = next++;
        const status = await head(index);
        assert.equal(status, reachable.has(index) ? 200 : 404, `index${index}`);
        if (status === 200) healthy++; else failed++;
      }
    }));
    assert.equal(healthy, 2300);
    assert.equal(failed, 62700);
    const counters = fixture.countsFor(Array.from({ length: count }, (_, i) => i));
    assert.ok(counters.every((entry) => entry.manifests === 1 && entry.segments === 0 && !entry.overflow));
    const stats = fixture.stats();
    assert.equal(stats.manifests, count);
    assert.equal(stats.rejected, 62700);
    assert.equal(stats.history.length, 64);
    assert.ok(stats.peakResponses <= 16);
    assert.ok(JSON.stringify(stats).length < 4096);
    // Existing indexed media and HEAD/range contracts remain usable for native calibration.
    const manifest = await fetch(`${fixture.url}/channel/0/index.m3u8`);
    assert.match(await manifest.text(), /\/channel\/0\/segment000\.ts\n/u);
    const segment = await fetch(`${fixture.url}/channel/0/segment000.ts`, { headers: { Range: 'bytes=0-187' } });
    assert.equal(segment.status, 206);
    assert.equal(new Uint8Array(await segment.arrayBuffer())[0], 0x47);
  } finally {
    agent.destroy();
    await fixture.close();
  }
  for (const field of ['activeResponses', 'activeSockets', 'timers']) assert.equal(fixture.stats()[field], 0);
});

test('all-unavailable count boundary and changed seed preserve exact endpoints but alter playlist fingerprint', async () => {
  const first = await startLargeScanFixtureServer({ deviceOrigins, count: 1001, seed: 'before', unavailableIndices: Array.from({ length: 1001 }, (_, i) => i) });
  const second = await startLargeScanFixtureServer({ deviceOrigins, count: 1001, seed: 'after' });
  try {
    assert.equal(first.reachableCount, 0);
    assert.deepEqual(first.expectedReachableDescriptors(), []);
    assert.equal(second.reachableCount, 1001);
    assert.notEqual(first.playlistSha256, second.playlistSha256);
    assert.deepEqual(first.descriptors().map((d) => d.url), second.descriptors().map((d) => d.url));
    assert.notEqual(first.descriptors()[0].providerId, second.descriptors()[0].providerId);
    assert.equal((await fetch(`${first.url}/channel/1000/index.m3u8`)).status, 404);
    assert.equal((await fetch(`${second.url}/channel/1000/index.m3u8`)).status, 200);
  } finally { await Promise.all([first.close(), second.close()]); }
});
