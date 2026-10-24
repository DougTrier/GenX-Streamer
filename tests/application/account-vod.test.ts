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

import { expect, it, vi } from 'vitest';
import { createAccountPlayer } from '../../src/application/accounts/account-player';
import { createAccountPlayback } from '../../src/platform/account-playback';
import {
  createAccountVod,
  validateAccountVodEpisodes,
  validateAccountVodListing,
} from '../../src/platform/account-vod';

const account = { id: 'a'.repeat(32), revision: '2' };
const mediaUrl = `http://127.0.0.1:41234/account/${'b'.repeat(64)}/media/${'c'.repeat(64)}`;
const listing = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  accountId: account.id,
  revision: account.revision,
  categories: [{ id: '10', name: 'Drama' }],
  items: [
    {
      id: '26273',
      name: 'Afire',
      year: '2023',
      rating: '7.1',
      poster: 'https://img.fixture.invalid/afire.jpg',
      extension: 'mkv',
    },
  ],
  skipped: 0,
  ...extra,
});

it('admits a provider listing only for the requested account revision', () => {
  expect(validateAccountVodListing(listing(), account).items[0]).toMatchObject({
    id: '26273',
    extension: 'mkv',
  });
  expect(() => validateAccountVodListing(listing({ revision: '3' }), account)).toThrow();
  expect(() => validateAccountVodListing(listing({ extra: true }), account)).toThrow();
});

it('refuses insecure or credential-bearing artwork and unknown file types', () => {
  const item = (patch: Record<string, unknown>) =>
    listing({ items: [{ id: '1', name: 'Title', ...patch }] });
  expect(() =>
    validateAccountVodListing(item({ poster: 'http://img.invalid/a.jpg' }), account),
  ).toThrow();
  expect(() =>
    validateAccountVodListing(item({ poster: 'https://user:pass@img.invalid/a.jpg' }), account),
  ).toThrow();
  expect(() => validateAccountVodListing(item({ extension: 'exe' }), account)).toThrow();
  expect(() => validateAccountVodListing(item({ id: '../1' }), account)).toThrow();
});

it('validates series episodes', () => {
  const episodes = validateAccountVodEpisodes(
    {
      schemaVersion: 1,
      accountId: account.id,
      revision: account.revision,
      episodes: [
        { id: '9', season: 1, episode: 2, title: 'Two', extension: 'mp4', durationSeconds: 2700 },
      ],
      skipped: 0,
    },
    account,
  );
  expect(episodes).toEqual([
    { id: '9', season: 1, episode: 2, title: 'Two', extension: 'mp4', durationSeconds: 2700 },
  ]);
});

it('asks native for categories, then one category, with a cancellable request', async () => {
  const invoke = vi.fn(async (command: string) =>
    command === 'account_vod_list' ? listing() : undefined,
  );
  const client = createAccountVod({ invoke, idFactory: () => 'request-1' });
  await client.list(account, 'movies', '10');
  expect(invoke).toHaveBeenCalledWith('account_vod_list', {
    request: {
      schemaVersion: 1,
      accountId: account.id,
      expectedRevision: account.revision,
      section: 'movies',
      categoryId: '10',
    },
    requestId: 'request-1',
  });
  expect(() => client.list(account, 'movies', '1; drop')).toThrow();
});

it('starts a movie through the VOD command and refuses unsafe references', async () => {
  const invoke = vi.fn(async () => ({
    schemaVersion: 1,
    sessionGeneration: '5',
    mediaUrl,
    mediaHint: 'file',
  }));
  const playback = createAccountPlayback({ invoke });
  const vod = {
    schemaVersion: 1 as const,
    accountId: account.id,
    expectedRevision: account.revision,
    kind: 'movie' as const,
    itemId: '26273',
    extension: 'mkv',
  };
  await expect(playback.start({ vod })).resolves.toMatchObject({ mediaHint: 'file' });
  expect(invoke).toHaveBeenCalledWith(
    'start_iptv_vod_playback',
    expect.objectContaining({ request: vod }),
  );
  await expect(playback.start({ vod: { ...vod, itemId: '../x' } })).rejects.toThrow();
});

it('plays a title as on-demand media in the one account session, never as a remembered channel', async () => {
  const select = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const start = vi.fn(async () => ({
    schemaVersion: 1 as const,
    sessionGeneration: '7',
    mediaUrl,
    mediaHint: 'file' as const,
  }));
  const nativeStop = vi.fn(async (sessionGeneration: string) => ({
    schemaVersion: 1 as const,
    stopped: true as const,
    sessionGeneration,
  }));
  const owner = createAccountPlayer({
    player: { select, stop, suspend: stop },
    playback: { start, stop: nativeStop, retryCleanup: async () => undefined },
  });
  await owner.selectVod(
    { kind: 'episode', itemId: '9', extension: 'mp4', name: 'Show S1E2' },
    { accountId: account.id, accountRevision: account.revision },
  );
  expect(start).toHaveBeenCalledWith(
    {
      vod: {
        schemaVersion: 1,
        accountId: account.id,
        expectedRevision: account.revision,
        kind: 'episode',
        itemId: '9',
        extension: 'mp4',
      },
    },
    expect.anything(),
  );
  expect(select).toHaveBeenCalledWith({
    id: 'vod:episode:9',
    name: 'Show S1E2',
    url: mediaUrl,
    mediaKind: 'media',
    playMode: 'on-demand',
    crossOrigin: 'anonymous',
  });
  expect(owner.allowsHttp(mediaUrl)).toBe(true);
  expect(owner.selection).toBeNull();
  await owner.stop();
  expect(nativeStop).toHaveBeenCalledWith('7');
  expect(owner.allowsHttp(mediaUrl)).toBe(false);
  await owner.dispose();
});

it('an episode the provider gave no container stays listed (XC-021)', () => {
  const episodes = validateAccountVodEpisodes(
    {
      schemaVersion: 1,
      accountId: account.id,
      revision: account.revision,
      episodes: [{ id: '10', season: 1, episode: 3, title: 'Three' }],
      skipped: 0,
    },
    account,
  );
  expect(episodes).toEqual([{ id: '10', season: 1, episode: 3, title: 'Three' }]);
  // A container that is present must still be a known one.
  expect(() =>
    validateAccountVodEpisodes(
      {
        schemaVersion: 1,
        accountId: account.id,
        revision: account.revision,
        episodes: [{ id: '10', season: 1, episode: 3, title: 'Three', extension: 'null' }],
        skipped: 0,
      },
      account,
    ),
  ).toThrow();
});

it('a title with an unknown container asks native to resolve it, never a guessed one', async () => {
  const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
    const request = (args as { request: { extension: string } }).request;
    expect(request.extension).toBe('');
    return {
      schemaVersion: 1,
      sessionGeneration: '1',
      mediaUrl: `http://127.0.0.1:41234/account/${'c'.repeat(64)}/media/${'d'.repeat(64)}`,
      mediaHint: 'file',
    };
  });
  const playback = createAccountPlayback({ invoke });
  await playback.start({
    vod: {
      schemaVersion: 1,
      accountId: account.id,
      expectedRevision: account.revision,
      kind: 'movie',
      itemId: '7',
      extension: '',
    },
  });
  expect(invoke).toHaveBeenCalled();
});
