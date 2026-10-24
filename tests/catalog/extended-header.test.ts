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

import { expect, it } from 'vitest';
import { parseM3u } from '../../src/catalog/parser';

const entry = '\n#EXTINF:-1 tvg-id="Fox.us@KDFW",KDFW\nhttps://fixture.invalid/live\n';

it('admits whitespace-separated extended header data without fetching its guide hint', () => {
  for (const header of [
    '#EXTM3U',
    '#EXTM3U x-tvg-url="https://fixture.invalid/guide.xml.gz"',
    '#EXTM3U\turl-tvg="https://fixture.invalid/a.xml,https://fixture.invalid/b.xml"',
  ]) {
    const parsed = parseM3u('\uFEFF' + header + entry, 'owned');
    expect(parsed.channels).toHaveLength(1);
    expect(parsed.channels[0].providerId).toBe('Fox.us@KDFW');
    expect(parsed.channels[0].urls).toEqual(['https://fixture.invalid/live']);
    expect(parsed.warnings).toEqual([]);
  }
});

it('refuses header-prefix collisions and oversized header metadata', () => {
  for (const header of ['#EXTM3U8', '#EXTM3Ux-tvg-url="x"', '#EXTM3U:wrong'])
    expect(() => parseM3u(header + entry, 'owned')).toThrow('not an extended M3U');
  expect(() => parseM3u('#EXTM3U ' + 'x'.repeat(16_384) + entry, 'owned')).toThrow(
    'line size limit',
  );
});
