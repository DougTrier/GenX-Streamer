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
import {
  emptyCatalog,
  parseCatalog,
  serializeCatalog,
  validateCatalog,
} from '../../src/catalog/codec';
import { MAX_PLAYLIST_BYTES } from '../../src/catalog/parser';
const fixture = () => ({
  schemaVersion: 1 as const,
  sources: [
    { id: 's', name: 'Source', kind: 'url' as const, location: 'https://example.org/list' },
  ],
  channels: [
    {
      id: 'one',
      sourceId: 's',
      providerId: 'station',
      name: 'Station',
      category: 'News',
      urls: ['https://example.org/live'],
    },
  ],
});

describe('untrusted catalog record codec', () => {
  it('matches native UTF-8 boundaries without truncating valid Unicode names', () => {
    const value = fixture();
    value.sources[0]!.name = 'é'.repeat(256);
    value.channels[0]!.name = '界'.repeat(5461) + 'A';
    expect(parseCatalog(serializeCatalog(value))).toEqual(value);
    value.channels[0]!.name += 'A';
    expect(() => serializeCatalog(value)).toThrow('Invalid catalog channel');
    value.channels[0]!.name = '😀'.repeat(4096);
    expect(parseCatalog(serializeCatalog(value)).channels[0]!.name).toBe(value.channels[0]!.name);
    value.sources[0]!.name += 'é';
    expect(() => serializeCatalog(value)).toThrow('Invalid playlist source');
  });
  it('refuses unpaired surrogate metadata before native JSON persistence', () => {
    const value = fixture();
    value.channels[0]!.name = 'Broken \ud800 name';
    expect(() => serializeCatalog(value)).toThrow('Invalid catalog channel');
  });
  it('round trips source definitions and channels in a single record', () => {
    expect(parseCatalog(serializeCatalog(fixture()))).toEqual(fixture());
    expect(parseCatalog(serializeCatalog(emptyCatalog()))).toEqual(emptyCatalog());
  });
  it('makes detached copies and strips unknown fields', () => {
    const original = fixture();
    const parsed = validateCatalog({ ...original, unknown: 'ignored' });
    original.channels[0]!.urls.push('https://example.org/other');
    original.sources[0]!.name = 'Changed';
    expect(parsed).toEqual(fixture());
  });
  it('requires explicit HTTP permission and preserves that permission across restart', () => {
    const record = fixture();
    record.channels[0]!.urls = ['http://example.org/live'];
    expect(() => serializeCatalog(record)).toThrow('explicit');
    const permitted = {
      ...record,
      sources: record.sources.map((s) => ({
        ...s,
        location: 'http://example.org/list',
        allowHttp: true,
      })),
    };
    expect(parseCatalog(serializeCatalog(permitted)).sources[0]!.allowHttp).toBe(true);
    expect(() =>
      serializeCatalog({
        ...permitted,
        sources: permitted.sources.map((s) => ({ ...s, allowHttp: false })),
      }),
    ).toThrow('explicit');
  });
  it.each([
    'not json',
    '{',
    JSON.stringify({ schemaVersion: 2, sources: [], channels: [] }),
    JSON.stringify({ schemaVersion: 1, sources: {}, channels: [] }),
  ])('rejects corrupt or unsupported records (%#)', (text) => {
    expect(() => parseCatalog(text)).toThrow();
  });
  it('rejects duplicate identities and missing source references', () => {
    const value = fixture();
    expect(() =>
      validateCatalog({ ...value, channels: [...value.channels, ...value.channels] }),
    ).toThrow('Duplicate catalog channel');
    expect(() =>
      validateCatalog({ ...value, sources: [...value.sources, ...value.sources] }),
    ).toThrow('Duplicate catalog source');
    expect(() => validateCatalog({ ...value, sources: [] })).toThrow('missing catalog source');
  });
  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://user:password@example.org/live',
    'not a URL',
  ])('rejects dangerous channel URLs (%#)', (url) => {
    const value = fixture();
    value.channels[0]!.urls = [url];
    expect(() => serializeCatalog(value)).toThrow();
  });
  it('bounds entire multi-source channel count, bytes, stream candidates and metadata', () => {
    const value = fixture();
    expect(() =>
      validateCatalog({ ...value, channels: Array(100_001).fill(value.channels[0]) }),
    ).toThrow('limits');
    expect(() => parseCatalog(' '.repeat(MAX_PLAYLIST_BYTES + 1))).toThrow('20 MiB');
    expect(() =>
      validateCatalog({
        ...value,
        channels: [{ ...value.channels[0], urls: Array(17).fill('https://example.org') }],
      }),
    ).toThrow('Invalid catalog channel');
    expect(() =>
      validateCatalog({ ...value, channels: [{ ...value.channels[0], name: 'x'.repeat(16_385) }] }),
    ).toThrow('Invalid catalog channel');
  });
});
