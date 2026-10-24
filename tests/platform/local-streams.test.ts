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
import { validLocalArea, validateLocalStreams } from '../../src/platform/local-streams';

// Test fixture shaped like the native local_streams_scan reply; no network claims.
const reply = () => ({
  schemaVersion: 1,
  areaCode: '309',
  places: [{ name: 'Peoria', state: 'Illinois' }],
  tv: [
    {
      name: 'Fixture 31',
      callSign: 'WFIX',
      website: 'https://tv.fixture.invalid/',
      place: 'Peoria',
      distanceKm: 3,
    },
  ],
  radio: [
    {
      id: 'r1',
      name: 'Fixture FM',
      stream: 'http://radio.fixture.invalid/live',
      codec: 'MP3',
      bitrate: 128,
      homepage: null,
      area: 'Peoria',
    },
  ],
});

describe('local area input', () => {
  it('accepts a 3-digit area code or a 5-digit ZIP', () => {
    for (const ok of ['309', '217', '61602', '00501']) expect(validLocalArea(ok)).toBe(true);
    for (const bad of ['109', '011', '30', '6160', '616020', '3o9', ' 309', ''])
      expect(validLocalArea(bad)).toBe(false);
  });
});

describe('local scan reply', () => {
  it('passes a well-formed reply through', () => {
    expect(validateLocalStreams(reply()).tv[0].callSign).toBe('WFIX');
  });
  it('refuses a TV site that is not https', () => {
    const value = reply();
    value.tv[0].website = 'http://tv.fixture.invalid/';
    expect(() => validateLocalStreams(value)).toThrow(/could not be read/);
  });
  it('refuses streams with credentials or other schemes', () => {
    for (const stream of [
      'https://user:pw@radio.fixture.invalid/',
      'rtsp://radio.fixture.invalid/',
    ]) {
      const value = reply();
      value.radio[0].stream = stream;
      expect(() => validateLocalStreams(value)).toThrow(/could not be read/);
    }
  });
  it('refuses oversized or unknown-schema replies', () => {
    const many = reply();
    many.tv = Array.from({ length: 61 }, () => reply().tv[0]);
    expect(() => validateLocalStreams(many)).toThrow();
    expect(() => validateLocalStreams({ ...reply(), schemaVersion: 2 })).toThrow();
    expect(() => validateLocalStreams(null)).toThrow();
  });
});

describe('address box input (W13: never a command, never script)', () => {
  it('opens addresses over https and searches everything else', async () => {
    const { webAddress } = await import('../../src/platform/local-streams');
    expect(webAddress('wtvp.org/live')).toBe('https://wtvp.org/live');
    expect(webAddress('http://example.com/x')).toBe('https://example.com/x');
    for (const hostile of [
      'javascript:alert(1)',
      'file:///C:/Users/',
      'intent://scan/#Intent;end',
      'settings delete all accounts',
      'data:text/html,<script>x</script>',
      'tauri://localhost/index.html',
    ]) {
      const url = webAddress(hostile)!;
      expect(url.startsWith('https://duckduckgo.com/?q=')).toBe(true);
      expect(decodeURIComponent(url.slice(url.indexOf('q=') + 2))).toBe(hostile);
    }
    expect(webAddress('   ')).toBeNull();
    expect(webAddress('https://user:pw@example.com/')).toMatch(/^https:\/\/duckduckgo\.com\//);
  });
});
