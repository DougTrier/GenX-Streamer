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
import { exactGuideMapArguments } from './guide-map-hydration-smoke.mjs';
import {
  CURRENT_TITLE,
  NEXT_TITLE,
  MAP_HEADER,
  guideMapXml,
  startGuideMapFixture,
} from './guide-map-hydration-fixture.mjs';
test('packaged harness requires an exact hash and refuses protected user binary', () => {
  assert.throws(() => exactGuideMapArguments([]));
  assert.throws(() => exactGuideMapArguments(['owned.exe']));
  assert.throws(() =>
    exactGuideMapArguments([
      'owned.exe',
      '--sha256=ad34eea1db81faaa2658d29aea3c4d697bfc470fc22df92d8fb3e49ac5da23cc',
    ]),
  );
  assert.throws(() =>
    exactGuideMapArguments([
      'owned.exe',
      '--sha256=' + 'a'.repeat(64),
      '--sha256=' + 'b'.repeat(64),
    ]),
  );
  assert.equal(
    exactGuideMapArguments(['owned.exe', '--sha256=' + 'a'.repeat(64)]).expected,
    'a'.repeat(64),
  );
});
test('clocked XML has one independent header and exact current-next intervals', () => {
  const xml = guideMapXml(Date.UTC(2026, 9, 16, 6));
  assert.equal((xml.match(/<channel /g) || []).length, 1);
  assert.equal((xml.match(/<programme /g) || []).length, 2);
  assert.ok(xml.includes(CURRENT_TITLE));
  assert.ok(xml.includes(NEXT_TITLE));
  assert.ok(xml.includes(`channel="${MAP_HEADER}"`));
  assert.ok(xml.includes('20261016055000 +0000'));
  assert.ok(xml.includes('20261016065000 +0000'));
  assert.ok(xml.includes('20261016075000 +0000'));
  assert.throws(() => guideMapXml(NaN));
});
test('local fixture distinguishes initial preview, failure and actual refetch, and joins sockets', async () => {
  const fixture = await startGuideMapFixture('http://127.0.0.1:1');
  try {
    const catalog = await (
      await fetch(`${fixture.origin}/catalog.m3u`, { redirect: 'error' })
    ).text();
    assert.ok(!catalog.includes('tvg-id'));
    assert.ok(catalog.includes('http://127.0.0.1:1/hls/live.m3u8'));
    const first = await fetch(`${fixture.origin}/guide.xml`, { redirect: 'error' });
    assert.equal(first.status, 200);
    await first.text();
    fixture.failGuide(true);
    const denied = await fetch(`${fixture.origin}/guide.xml`, { redirect: 'error' });
    assert.equal(denied.status, 403);
    await denied.text();
    fixture.failGuide(false);
    const fresh = await fetch(`${fixture.origin}/guide.xml`, { redirect: 'error' });
    assert.equal(fresh.status, 200);
    await fresh.text();
    assert.equal(fixture.stats().guideRequests, 3);
    assert.equal(fixture.stats().failedGuideRequests, 1);
    assert.equal(fixture.stats().catalogRequests, 1);
  } finally {
    await Promise.all([fixture.close(), fixture.close()]);
  }
  assert.equal(fixture.stats().activeSockets, 0);
  assert.equal(fixture.stats().activeResponses, 0);
  assert.equal(fixture.stats().closed, true);
});
