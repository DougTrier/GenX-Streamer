/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

it('restores a Free endpoint override after rescan IDs and display metadata are replaced', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const api = await import('../../src/application/playback/stream-buffer-state');
  const original = {
    id: 'old-scan-id',
    name: 'Original label',
    url: 'https://example.test/live.m3u8?feed=1',
  };
  const key = await api.streamBufferKey(original);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  await api.saveStreamBufferPreference(key!, { mode: 'manual', targetSeconds: 12 });
  expect(
    await api.savedStreamBufferPreference({
      ...original,
      id: 'new-scan-id',
      name: 'Updated label',
    }),
  ).toEqual({ mode: 'manual', targetSeconds: 12 });
  expect(
    await api.savedStreamBufferPreference({ ...original, url: 'https://example.test/other.m3u8' }),
  ).toEqual({ mode: 'auto' });
  const persisted = [...values.values()].join('');
  expect(persisted).not.toContain('example.test');
  expect(persisted).not.toContain('scan-id');
  expect(persisted).not.toContain('Original label');
  await api.saveStreamBufferPreference(key!, { mode: 'auto' });
  expect(await api.savedStreamBufferPreference(original)).toEqual({ mode: 'auto' });
});

it('uses an issued opaque private key and never persists a temporary relay identity', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const api = await import('../../src/application/playback/stream-buffer-state');
  const selection = {
    id: 'account-private',
    name: 'Private fixture',
    url: 'http://127.0.0.1/temporary/capability',
    liveBufferKey: 'b'.repeat(64),
    playMode: 'on-demand' as const,
  };
  expect(await api.streamBufferKey(selection)).toBe('b'.repeat(64));
  await api.saveStreamBufferPreference(selection.liveBufferKey, {
    mode: 'manual',
    targetSeconds: 9,
  });
  expect(
    await api.savedStreamBufferPreference({
      ...selection,
      url: 'http://127.0.0.1/replaced/capability',
    }),
  ).toEqual({ mode: 'manual', targetSeconds: 9 });
  expect(await api.streamBufferKey({ ...selection, liveBufferKey: undefined })).toBeNull();
  expect([...values.values()].join('')).not.toContain('capability');
});

it('keeps playback on Auto when device preference storage is unavailable', async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('Fixture storage unavailable');
    },
  });
  const api = await import('../../src/application/playback/stream-buffer-state');
  expect(
    await api.savedStreamBufferPreference({
      id: 'live',
      name: 'Fixture',
      url: 'https://example.test/live.m3u8',
    }),
  ).toEqual({ mode: 'auto' });
});
