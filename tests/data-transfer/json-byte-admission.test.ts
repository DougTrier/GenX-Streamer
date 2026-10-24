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
  boundedJsonUtf8Bytes,
  JsonByteLimitError,
} from '../../src/data-transfer/json-byte-admission';
import { validateBackup, validateCommitRecord } from '../../src/data-transfer';
import { serializeCatalog, type CatalogRecord } from '../../src/catalog';
import { defaultPreferences } from '../../src/preferences';

const source = { id: 'source', name: 'Chosen file', kind: 'file' as const, location: 'chosen.m3u' };
const catalog: CatalogRecord = {
  schemaVersion: 1,
  sources: [source],
  channels: [
    {
      id: 'unicode',
      sourceId: source.id,
      providerId: 'provider',
      name: '世界 🏈 \\ "',
      category: 'Sports',
      urls: ['https://media.test/one', 'https://media.test/two'],
      geography: { country: 'US', state: 'US-IL' },
      geographyProvenance: [
        {
          kind: 'user',
          scope: 'user-reviewed',
          field: 'country',
          value: 'US',
          sourceId: source.id,
        },
      ],
    },
  ],
};
const backup = (value = catalog) => ({
  format: 'genx-tv-backup' as const,
  schemaVersion: 1 as const,
  catalog: value,
  preferences: { ...defaultPreferences(), sources: value.sources },
});

describe('exact incremental JSON byte admission', () => {
  it('matches stored catalog bytes with Unicode and optional nested fields', () => {
    const normalized = validateBackup(backup()).catalog;
    const text = serializeCatalog(normalized);
    const bytes = new TextEncoder().encode(text).length;
    expect(boundedJsonUtf8Bytes(normalized, bytes)).toBe(bytes);
    expect(validateCommitRecord(backup())).toEqual(validateBackup(backup()));
    expect(() => boundedJsonUtf8Bytes(normalized, bytes - 1)).toThrow(JsonByteLimitError);
  });
  it('preserves exact20MiB normalized catalog admission and existing lone-surrogate refusal', () => {
    const limit = 20 * 1024 * 1024;
    const large: CatalogRecord = {
      schemaVersion: 1,
      sources: [source],
      channels: Array.from({ length: 1300 }, (_, index) => ({
        id: `channel-${index}`,
        sourceId: source.id,
        name: 'x'.repeat(16000),
        category: '',
        urls: [`https://media.test/${index}`],
      })),
    };
    let remaining = limit - boundedJsonUtf8Bytes(large, limit);
    expect(remaining).toBeGreaterThan(0);
    for (const row of large.channels) {
      const fill = Math.min(remaining, 16384);
      row.category = 'x'.repeat(fill);
      remaining -= fill;
      if (!remaining) break;
    }
    expect(remaining).toBe(0);
    expect(boundedJsonUtf8Bytes(validateCommitRecord(backup(large)).catalog, limit)).toBe(limit);
    expect(
      new TextEncoder().encode(serializeCatalog(validateBackup(backup(large)).catalog)).length,
    ).toBe(limit);
    large.channels.at(-1)!.category += 'x';
    expect(() => validateCommitRecord(backup(large))).toThrow('20 MiB storage limit');
    expect(() => validateBackup(backup(large))).toThrow('20 MiB storage limit');
    const invalid = structuredClone(catalog);
    invalid.channels[0]!.name = '\ud800';
    expect(() => validateCommitRecord(backup(invalid))).toThrow('Invalid catalog channel');
    expect(() => validateBackup(backup(invalid))).toThrow('Invalid catalog channel');
  });
  it.each([
    null,
    true,
    -0,
    1.25,
    'quoted"\\\t\r\n\udfff😀',
    [],
    {},
    [1, ['a'], { optional: null }],
  ])('counts exact JSON punctuation and scalar encodings (%j)', (value) => {
    const expected = new TextEncoder().encode(JSON.stringify(value)).length;
    expect(boundedJsonUtf8Bytes(value, expected)).toBe(expected);
    expect(() => boundedJsonUtf8Bytes(value, expected - 1)).toThrow(JsonByteLimitError);
  });
  it('accepts exactly20MiB and rejects one extra byte without an aggregate string', () => {
    const limit = 20 * 1024 * 1024;
    // Array punctuation plus bounded individual fields, not one giant string field.
    const fields = Array.from({ length: 1279 }, () => 'x'.repeat(16384));
    const size = boundedJsonUtf8Bytes(fields, limit);
    const last = 'x'.repeat(limit - size - 3);
    fields.push(last);
    expect(boundedJsonUtf8Bytes(fields, limit)).toBe(limit);
    fields[fields.length - 1] += 'x';
    expect(() => boundedJsonUtf8Bytes(fields, limit)).toThrow(JsonByteLimitError);
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    1n,
    Symbol('invalid'),
    () => 1,
    new Date(),
    new Array(1),
    { bad: undefined },
    { toJSON: () => ({}) },
  ])('refuses unsupported data rather than measuring a different serialization (%s)', (value) => {
    expect(() => boundedJsonUtf8Bytes(value, 1024)).toThrow(/normalized plain data/);
  });
  it('does not invoke accessors and refuses cycles or excessive depth', () => {
    const value = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        throw new Error('must not run');
      },
    });
    expect(() => boundedJsonUtf8Bytes(value, 1024)).toThrow(/normalized plain data/);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => boundedJsonUtf8Bytes(cyclic, 1024)).toThrow(/normalized plain data/);
    let deep: unknown = null;
    for (let index = 0; index < 34; index++) deep = [deep];
    expect(() => boundedJsonUtf8Bytes(deep, 1024)).toThrow(/normalized plain data/);
  });
  it('preserves cancellation and invalid limit refusal', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => boundedJsonUtf8Bytes(catalog, 1024, controller.signal)).toThrow();
    expect(() => validateCommitRecord(backup(), controller.signal)).toThrow();
    expect(() => boundedJsonUtf8Bytes(null, -1)).toThrow(/limit is invalid/);
  });
});
