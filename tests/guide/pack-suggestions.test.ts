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

import { describe, expect, it } from 'vitest';
import { readPackSuggestions, validatePackSuggestions } from '../../src/guide/pack-suggestions';

const row = (path = 'SamsungTVPlus/us', channels = 3) => ({
  name: `Publisher guide · ${path}`,
  location: `https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/${path}.xml.gz`,
  channels,
});
describe('publisher guide pack suggestions', () => {
  it('admits bounded exact publisher feed locations only', () => {
    expect(validatePackSuggestions([row(), row('Roku/all', 1)])).toHaveLength(2);
    for (const bad of [
      [{ ...row(), location: 'https://evil.invalid/SamsungTVPlus/us.xml.gz' }],
      [{ ...row(), location: row().location.replace('.xml.gz', '.xml.gz?x=1') }],
      [{ ...row(), location: row().location.replace('SamsungTVPlus', '..') }],
      [{ ...row(), channels: 0 }],
      [row(), row()],
      Array.from({ length: 17 }, (_, i) => row(`Feed${i}/us`)),
      'not-an-array',
    ])
      expect(validatePackSuggestions(bad)).toEqual([]);
  });
  it('treats native failure as no suggestions but still honors cancellation', async () => {
    const signal = new AbortController().signal;
    expect(await readPackSuggestions(async () => [row()], signal)).toHaveLength(1);
    expect(
      await readPackSuggestions(async () => {
        throw new Error('unavailable');
      }, signal),
    ).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    await expect(readPackSuggestions(async () => [row()], controller.signal)).rejects.toThrow();
  });
});
