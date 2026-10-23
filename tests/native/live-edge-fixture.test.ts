import { expect, it } from 'vitest';
// @ts-expect-error The owned Node fixture is a JavaScript-only test helper.
import { startLiveEdgeFixture } from './live-edge-fixture.mjs';

it('slides monotonic live sequences, refuses expired media and admits only bounded exact segment identities', async () => {
  let clock = 100000;
  const fixture = await startLiveEdgeFixture({ now: () => clock });
  try {
    const first = await (await fetch(`${fixture.url}/hls/live.m3u8`)).text();
    expect(first).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    expect(first).not.toContain('#EXT-X-ENDLIST');
    expect(first).toContain('sequence=3');
    const initial = await fetch(`${fixture.url}/media/segment000.ts?sequence=0`);
    expect(initial.status).toBe(200);
    expect((await initial.arrayBuffer()).byteLength).toBeLessThanOrEqual(1024 * 1024);
    clock += 25000;
    const advanced = await (await fetch(`${fixture.url}/hls/live.m3u8`)).text();
    expect(advanced).toContain('#EXT-X-MEDIA-SEQUENCE:12');
    expect(advanced).toContain('sequence=15');
    expect(advanced).not.toContain('#EXT-X-ENDLIST');
    expect((await fetch(`${fixture.url}/media/segment000.ts?sequence=0`)).status).toBe(404);
    expect((await fetch(`${fixture.url}/media/segment000.ts?sequence=12`)).status).toBe(200);
    // One-segment race grace is distinct from the physical resume assertion,
    // which requires its first request at or after the fresh manifest's first.
    expect((await fetch(`${fixture.url}/media/segment003.ts?sequence=11`)).status).toBe(200);
    expect((await fetch(`${fixture.url}/media/segment002.ts?sequence=10`)).status).toBe(404);
    for (const route of [
      '/media/segment001.ts?sequence=12',
      '/media/segment000.ts?sequence=16',
      '/media/segment000.ts?sequence=Infinity',
      '/media/segment000.ts',
      '/media/other.ts?sequence=12',
    ])
      expect((await fetch(fixture.url + route)).status).toBe(404);
    expect(fixture.stats().requests.length).toBe(12);
    for (let index = 12; index < 500; index++) {
      const response = await fetch(`${fixture.url}/hls/live.m3u8`);
      expect(response.status).toBe(200);
      await response.text();
    }
    const refused = await fetch(`${fixture.url}/hls/live.m3u8`);
    expect(refused.status).toBe(503);
    await refused.text();
    expect(fixture.stats().requests.length).toBe(500);
  } finally {
    await fixture.close();
  }
  expect(fixture.stats().activeResponses).toBe(0);
  expect(fixture.stats().activeSockets).toBe(0);
});
