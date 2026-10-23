import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { startLargeScanFixtureServer } from '../../scripts/large-scan-fixture-server.mjs';

const origins = Array.from({ length: 16 }, (_, i) => `http://127.0.0.1:${24000 + i}`);
async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Fixture condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('13,256 deterministic unique entries distribute across 16 explicit origins within playlist bounds', async () => {
  const fixture = await startLargeScanFixtureServer({ deviceOrigins: origins });
  try {
    const response = await fetch(`${fixture.url}/catalog.m3u`);
    assert.equal(response.status, 200);
    const body = Buffer.from(await response.arrayBuffer());
    const text = body.toString('utf8'), entries = text.trim().split('\n').slice(1);
    assert.equal(body.length, fixture.playlistBytes);
    assert.ok(body.length <= 20 * 1024 * 1024);
    assert.equal(createHash('sha256').update(body).digest('hex'), fixture.playlistSha256);
    assert.equal(entries.length, 13256 * 2);
    const descriptors = fixture.descriptors();
    assert.equal(new Set(descriptors.map((d) => d.providerId)).size, 13256);
    assert.equal(new Set(descriptors.map((d) => d.url)).size, 13256);
    assert.deepEqual(new Set(descriptors.map((d) => new URL(d.url).origin)), new Set(origins));
    for (const index of [0, 15, 16, 13255]) {
      assert.equal(entries[index * 2 + 1], descriptors[index].url);
      assert.ok(entries[index * 2].includes(`tvg-id="${descriptors[index].providerId}"`));
      assert.ok(entries[index * 2].endsWith(descriptors[index].name));
    }
    descriptors[0].url = 'changed';
    assert.equal(fixture.descriptors()[0].url, entries[1]);
  } finally { await fixture.close(); }
  assert.equal(fixture.stats().activeSockets, 0);
});

test('controlled HLS references actual MPEG-TS and honors HEAD and bounded byte ranges', async () => {
  const fixture = await startLargeScanFixtureServer({ deviceOrigins: origins, count: 2 });
  try {
    const response = await fetch(`${fixture.url}/channel/1/index.m3u8`);
    assert.equal(response.headers.get('content-type'), 'application/vnd.apple.mpegurl');
    const manifest = await response.text();
    assert.match(manifest, /^#EXTM3U\n#EXT-X-VERSION:3\n/u);
    assert.ok(manifest.includes(`${origins[1]}/media/segment000.ts`));
    assert.ok(manifest.endsWith('#EXT-X-ENDLIST\n'));
    const head = await fetch(`${fixture.url}/media/segment000.ts`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.ok(Number(head.headers.get('content-length')) > 188);
    const segment = await fetch(`${fixture.url}/media/segment000.ts`, { headers: { Range: 'bytes=0-187' } });
    assert.equal(segment.status, 206);
    const packet = new Uint8Array(await segment.arrayBuffer());
    assert.equal(packet.length, 188);
    assert.equal(packet[0], 0x47);
    assert.match(segment.headers.get('content-range'), /^bytes 0-187\/\d+$/u);
    const bad = await fetch(`${fixture.url}/media/segment000.ts`, { headers: { Range: 'bytes=999999-' } });
    assert.equal(bad.status, 416);
  } finally { await fixture.close(); }
});

test('unknown routes/methods are refused and request history stays bounded', async () => {
  const fixture = await startLargeScanFixtureServer({ deviceOrigins: origins, count: 1, historyLimit: 8 });
  try {
    for (let i = 0; i < 70; i++) {
      const response = await fetch(`${fixture.url}/channel/0/index.m3u8`);
      await response.arrayBuffer();
    }
    for (const route of ['/channel/1/index.m3u8', '/channel/00/index.m3u8', '/catalog.m3u?private=x', '/unknown', '/media/private.ts'])
      assert.equal((await fetch(`${fixture.url}${route}`)).status, 404);
    assert.equal((await fetch(`${fixture.url}/catalog.m3u`, { method: 'POST' })).status, 405);
    const stats = fixture.stats();
    assert.equal(stats.manifests, 70);
    assert.equal(stats.rejected, 6);
    assert.equal(stats.history.length, 8);
    assert.ok(stats.history.every((entry) => Object.keys(entry).sort().join(',') === 'index,kind'));
    stats.history[0].kind = 'changed';
    assert.notEqual(fixture.stats().history[0].kind, 'changed');
  } finally { await fixture.close(); }
});

test('close cancels held response timers, joins actual sockets and is idempotent', async () => {
  const fixture = await startLargeScanFixtureServer({ deviceOrigins: origins, count: 1, responseDelayMs: 1000 });
  const request = fetch(`${fixture.url}/channel/0/index.m3u8`).then(
    (response) => response.arrayBuffer().then(() => 'finished'),
    () => 'canceled',
  );
  await waitFor(() => fixture.stats().timers === 1);
  const close = fixture.close();
  assert.equal(fixture.close(), close);
  await close;
  assert.equal(await request, 'canceled');
  assert.equal(fixture.stats().activeResponses, 0);
  assert.equal(fixture.stats().activeSockets, 0);
  assert.equal(fixture.stats().timers, 0);
  assert.equal(fixture.stats().aborted, 1);
});

test('unsafe origins, duplicate origins, count/seed bounds and oversized playlist fail admission', async () => {
  for (const deviceOrigins of [[], [...origins, 'http://127.0.0.1:25000'], [origins[0], origins[0]], ['https://127.0.0.1:24000'], ['http://example.com:24000'], ['http://user:secret@127.0.0.1:24000'], ['http://127.0.0.1:24000/path'], ['http://127.0.0.1:24000?x=1']])
    await assert.rejects(startLargeScanFixtureServer({ deviceOrigins }));
  for (const count of [0, 100001, 1.5])
    await assert.rejects(startLargeScanFixtureServer({ deviceOrigins: origins, count }));
  await assert.rejects(startLargeScanFixtureServer({ deviceOrigins: origins, seed: 'bad\nseed' }));
  await assert.rejects(startLargeScanFixtureServer({ deviceOrigins: origins, count: 100000, seed: 'x'.repeat(64) }), /20 MiB/u);
  await assert.rejects(startLargeScanFixtureServer({ deviceOrigins: origins, indexedSegments: 'true' }));
});

test('indexed acquisition snapshots distinguish settled keys from later cold Continue requests without growing stats', async () => {
  const fixture = await startLargeScanFixtureServer({ deviceOrigins: origins, count: 13256, indexedSegments: true });
  try {
    assert.deepEqual(fixture.countsFor([0, 16, 13255]), [0, 16, 13255].map(index => ({ index, manifests: 0, segments: 0, overflow: false })));
    async function acquire(index) {
      const response = await fetch(`${fixture.url}/channel/${index}/index.m3u8`);
      const manifest = await response.text();
      assert.ok(manifest.includes(`${origins[index % 16]}/channel/${index}/segment000.ts`));
      const segment = await fetch(`${fixture.url}/channel/${index}/segment000.ts`, { headers: { Range: 'bytes=0-187' } });
      assert.equal(segment.status, 206);
      assert.match(segment.headers.get('content-range'), /^bytes 0-187\/\d+$/u);
      const bytes = new Uint8Array(await segment.arrayBuffer());
      assert.equal(bytes.length, 188); assert.equal(bytes[0], 0x47);
    }
    await acquire(0); await acquire(16);
    const settled = fixture.countsFor([0, 16]);
    assert.ok(Object.isFrozen(settled)); assert.ok(settled.every(Object.isFrozen));
    await acquire(13255);
    assert.deepEqual(fixture.countsFor([0, 16]), settled);
    assert.deepEqual(fixture.countsFor([13255]), [{ index: 13255, manifests: 1, segments: 1, overflow: false }]);
    await acquire(16);
    assert.deepEqual(fixture.countsFor([16]), [{ index: 16, manifests: 2, segments: 2, overflow: false }]);
    assert.equal(settled[1].manifests, 1);
    await (await fetch(`${fixture.url}/media/segment000.ts`)).arrayBuffer();
    assert.equal(fixture.stats().segments, 5);
    assert.equal(fixture.stats().counterOverflowIndices, 0);
    assert.equal(JSON.stringify(fixture.stats()).includes('manifestCounts'), false);
    assert.ok(JSON.stringify(fixture.stats()).length < 4096);
    for (const route of ['/channel/13256/segment000.ts', '/channel/00/segment000.ts', '/channel/0/segment000.ts?private=x'])
      assert.equal((await fetch(`${fixture.url}${route}`)).status, 404);
    assert.deepEqual(fixture.countsFor([0, 16]), [{ index: 0, manifests: 1, segments: 1, overflow: false }, { index: 16, manifests: 2, segments: 2, overflow: false }]);
  } finally { await fixture.close(); }
  assert.equal(fixture.stats().activeSockets, 0);
  assert.equal(fixture.stats().timers, 0);
});

test('counter index admission rejects malformed whole requests before reading accessors or mutating evidence', async () => {
  const fixture = await startLargeScanFixtureServer({ deviceOrigins: origins, count: 2 });
  try {
    let accesses = 0;
    const accessor = Object.defineProperty([0], 0, { get() { accesses++; return 0; } });
    const baseline = fixture.countsFor([0, 1]);
    for (const indices of [null, {}, [0, 0], [2], [-1], [0.5], ['0'], [0, 1, 0], new Array(1), accessor])
      assert.throws(() => fixture.countsFor(indices), /counter indices/u);
    assert.equal(accesses, 0);
    assert.deepEqual(fixture.countsFor([0, 1]), baseline);
    assert.deepEqual(fixture.countsFor([]), []);
    assert.equal((await fetch(`${fixture.url}/channel/0/segment000.ts`)).status, 404);
    assert.equal((await fetch(`${fixture.url}/channel/0/index.m3u8`)).status, 200);
    assert.deepEqual(fixture.countsFor([0]), [{ index: 0, manifests: 1, segments: 0, overflow: false }]);
  } finally { await fixture.close(); }
});

test('opt-in index511 returns real404 while sibling and all segment resources remain healthy', async () => {
  const selected=[511];
  const fixture=await startLargeScanFixtureServer({deviceOrigins:origins,count:512,indexedSegments:true,unavailableIndices:selected});
  selected[0]=510;
  try {
    const failed=await fetch(`${fixture.url}/channel/511/index.m3u8`);
    assert.equal(failed.status,404);
    assert.equal(failed.headers.get('content-type'),'text/plain');
    assert.equal(await failed.text(),'Fixture channel unavailable.\n');
    const head=await fetch(`${fixture.url}/channel/511/index.m3u8`,{method:'HEAD'});
    assert.equal(head.status,404);assert.equal((await head.arrayBuffer()).byteLength,0);
    const healthy=await fetch(`${fixture.url}/channel/510/index.m3u8`);
    assert.equal(healthy.status,200);assert.match(await healthy.text(),/^#EXTM3U/u);
    const segment=await fetch(`${fixture.url}/channel/511/segment000.ts`,{headers:{Range:'bytes=0-187'}});
    assert.equal(segment.status,206);assert.equal(new Uint8Array(await segment.arrayBuffer())[0],0x47);
    const shared=await fetch(`${fixture.url}/media/segment000.ts`);
    assert.equal(shared.status,200);await shared.arrayBuffer();
    assert.deepEqual(fixture.countsFor([510,511]),[
      {index:510,manifests:1,segments:0,overflow:false},
      {index:511,manifests:2,segments:1,overflow:false},
    ]);
    const stats=fixture.stats();
    assert.equal(stats.requests,5);assert.equal(stats.manifests,3);assert.equal(stats.segments,2);assert.equal(stats.rejected,2);
    assert.deepEqual(stats.history.slice(0,2),[{kind:'manifest',index:511},{kind:'manifest',index:511}]);
  } finally {await fixture.close();}
  for(const field of ['activeResponses','activeSockets','timers'])assert.equal(fixture.stats()[field],0);
});

test('unavailable list defaults leave catalog bytes and healthy routes identical, max1000 is admitted', async () => {
  const defaults=await startLargeScanFixtureServer({deviceOrigins:origins,count:512});
  const explicit=await startLargeScanFixtureServer({deviceOrigins:origins,count:512,unavailableIndices:[]});
  try {
    assert.equal(defaults.playlistSha256,explicit.playlistSha256);
    assert.deepEqual(defaults.descriptors(),explicit.descriptors());
    for(const fixture of [defaults,explicit]) {
      const response=await fetch(`${fixture.url}/channel/511/index.m3u8`);
      assert.equal(response.status,200);assert.match(await response.text(),/^#EXTM3U/u);
      assert.equal(fixture.stats().rejected,0);
    }
  } finally {await Promise.all([defaults.close(),explicit.close()]);}
  const maximum=await startLargeScanFixtureServer({deviceOrigins:origins,count:1000,unavailableIndices:Array.from({length:1000},(_,i)=>i)});
  try {
    assert.equal((await fetch(`${maximum.url}/channel/999/index.m3u8`)).status,404);
    assert.equal(maximum.count,1000);
    assert.equal(maximum.descriptors().length,1000);
  } finally {await maximum.close();}
});

test('invalid unavailable indices refuse before listen without reading getters', async () => {
  const reservation=http.createServer();
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  let reads=0;
  const accessor=Object.defineProperty([0],0,{get(){reads++;return 0;}});
  const extra=[0];extra.private='not-an-index';
  const symbolic=[0];symbolic[Symbol('extra')]=1;
  const invalid=[null,{},'0',[0,0],[512],[-1],[0.5],['0'],new Array(1),accessor,extra,symbolic,Array.from({length:1001},(_,i)=>i)];
  try {
    for(const unavailableIndices of invalid)
      await assert.rejects(startLargeScanFixtureServer({deviceOrigins:origins,count:512,port:reservation.address().port,unavailableIndices}),/Invalid (?:large scan fixture configuration|unavailable fixture indices)\./u);
    assert.equal(reads,0);
  } finally {await new Promise(resolve=>reservation.close(resolve));}
});
