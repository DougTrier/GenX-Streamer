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
import type { CatalogRecord } from '../../src/catalog';
import {
  collectFavorites,
  decodeFavorites,
  encodeFavorites,
  indexFavoriteMatches,
  planFavorites,
} from '../../src/sharing/favorites';

const stream = 'https://tv.example.com/live.m3u8';
const other = 'https://tv.example.com/other.m3u8';
const channel = { name: 'News 24', category: 'News', stream, providerId: 'news24' };
const catalog: CatalogRecord = {
  schemaVersion: 1,
  sources: [
    { id: 'free', name: 'Free TV', kind: 'url', location: 'https://tv.example.com/playlist.m3u' },
  ],
  channels: [
    {
      id: 'saved',
      sourceId: 'free',
      name: channel.name,
      category: channel.category,
      providerId: channel.providerId,
      urls: [stream],
    },
  ],
};

describe('Free TV favorites bundles', () => {
  it('exports fingerprints and skips private URLs, credentials, PPV, and removed favorites', async () => {
    const saved = catalog.channels[0]!;
    const input = {
      ...catalog,
      channels: [
        saved,
        { ...saved, id: 'local', urls: [`http://${[192, 168, 1, 2].join('.')}/feed.m3u8`] },
        { ...saved, id: 'token', urls: ['https://tv.example.com/feed.m3u8?token=secret'] },
        { ...saved, id: 'ppv', category: 'PPV' },
        { ...saved, id: 'removed', urls: [other] },
      ],
    };
    const { items, skipped } = await collectFavorites(
      input,
      ['saved', 'local', 'token', 'ppv', 'removed'],
      ['removed'],
    );
    expect(items).toEqual([
      {
        name: channel.name,
        category: channel.category,
        endpoint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        provider: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ]);
    expect(encodeFavorites(items)).not.toContain(stream);
    expect(encodeFavorites(items)).not.toContain(channel.providerId);
    expect(skipped).toBe(4);
    expect(decodeFavorites(encodeFavorites(items))).toEqual(items);
  });

  it('refuses non-favorites files and address-based entries', () => {
    expect(() =>
      decodeFavorites('{"format":"genx-tv-backup","version":1,"channels":[]}'),
    ).toThrow();
    expect(() =>
      decodeFavorites(
        JSON.stringify({
          format: 'genx-free-tv-favorites',
          version: 1,
          channels: [{ ...channel, stream: `http://${[10, 0, 0, 1].join('.')}/a.m3u8` }],
        }),
      ),
    ).toThrow();
  });

  it.each([
    'https://tv.example.com/feed.m3u8?X-Amz-Signature=secret',
    'https://tv.example.com/%6cive/name/secret/123.ts',
    'https://tv.example.com/live%2Fname%2Fsecret%2F123.ts',
    'https://tv.example.com/%256cive/name/secret/123.ts',
  ])('skips signed or disguised account URLs', async (address) => {
    const local = { ...catalog, channels: [{ ...catalog.channels[0]!, urls: [address] }] };
    expect((await collectFavorites(local, ['saved'], [])).items).toEqual([]);
  });

  it('matches an exact endpoint even if renamed, and reports unknown fingerprints', async () => {
    const exported = (await collectFavorites(catalog, ['saved'], [])).items[0]!;
    const items = [
      { ...exported, name: 'Renamed' },
      { name: 'Other', category: 'Local', endpoint: 'f'.repeat(64) },
    ];
    const index = await indexFavoriteMatches(catalog, items, new AbortController().signal);
    const plan = planFavorites(index, [], [], items);
    expect(plan.matched).toEqual(['saved']);
    expect(plan.unmatched).toBe(1);
    expect(planFavorites(index, plan.matched, [], items)).toMatchObject({
      matched: [],
      unmatched: 1,
      alreadySaved: 1,
    });
  });

  it('uses a unique provider identity with a matching name, and keeps removed channels hidden', async () => {
    const exported = (await collectFavorites(catalog, ['saved'], [])).items[0]!;
    const item = { ...exported, endpoint: 'f'.repeat(64) };
    const index = await indexFavoriteMatches(catalog, [item], new AbortController().signal);
    expect(planFavorites(index, [], [], [item]).matched).toEqual(['saved']);
    const hidden = planFavorites(index, [], ['saved'], [item]);
    expect(hidden.previouslyRemoved).toBe(1);
    expect(hidden.unmatched).toBe(0);
  });
});
