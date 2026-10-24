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

import { beforeEach, describe, expect, it, vi } from 'vitest';
const { invoke, isTauri } = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri }));
import { readListedGuideChannels } from '../../src/guide/listed-channels';
const item = (id = 'a') => ({
  catalogSourceId: 'catalog',
  appChannelId: id,
  guideSourceId: 'guide',
  xmltvChannelId: `xml-${id}`,
  sourceRevision: 3,
  filterMask: 0,
});
const page = (channels: unknown[] = [item()], nextCursor: string | null = null) => ({
  startMs: 1000,
  endMs: 2000,
  rootGeneration: 12,
  catalogRevision: '7',
  databaseRevision: 9,
  viewRevision: '11',
  groupingPolicy: 'exact-ordered-endpoints-policy-v2',
  channels,
  nextCursor,
});
const read = (signal = new AbortController().signal) => readListedGuideChannels(1000, 2000, signal);
beforeEach(() => {
  invoke.mockReset();
  isTauri.mockReturnValue(true);
});
describe('complete listed Guide membership native bridge', () => {
  it('joins pages with per-page request IDs and exact opaque channel identities', async () => {
    invoke
      .mockResolvedValueOnce(page([item('https://opaque/?a=文&b="')], 'opaque1'))
      .mockResolvedValueOnce(page([item('z')]));
    const result = await read();
    expect(result.channels.map((v) => v.appChannelId)).toEqual(['https://opaque/?a=文&b="', 'z']);
    expect(result).toMatchObject({ catalogRevision: '7', databaseRevision: 9 });
    expect(invoke.mock.calls[0]![1].requestId).not.toBe(invoke.mock.calls[1]![1].requestId);
    expect(invoke.mock.calls[1]![1].query.cursor).toBe('opaque1');
  });
  it('sends a search with every page and refuses unsafe searches before IPC', async () => {
    invoke
      .mockResolvedValueOnce(page([item('a')], 'next'))
      .mockResolvedValueOnce(page([item('b')]));
    await readListedGuideChannels(1000, 2000, new AbortController().signal, 'NFL live');
    expect(invoke.mock.calls.map((call) => call[1].query.search)).toEqual(['NFL live', 'NFL live']);
    invoke.mockClear();
    invoke.mockResolvedValueOnce(page());
    await read();
    expect(invoke.mock.calls[0]![1].query).not.toHaveProperty('search');
    for (const bad of ['ab', 'x'.repeat(257)])
      await expect(
        readListedGuideChannels(1000, 2000, new AbortController().signal, bad),
      ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('admits an empty terminal inventory', async () => {
    invoke.mockResolvedValue(page([]));
    expect((await read()).channels).toEqual([]);
  });
  it.each(['catalogRevision', 'databaseRevision', 'rootGeneration', 'viewRevision'] as const)(
    'rejects %s changes without publishing a partial inventory',
    async (key) => {
      invoke.mockResolvedValueOnce(page([item('a')], 'one')).mockResolvedValueOnce({
        ...page([item('b')]),
        [key]: key === 'catalogRevision' || key === 'viewRevision' ? '8' : 13,
      });
      await expect(read()).rejects.toThrow('invalid');
    },
  );
  it.each([
    { startMs: 999 },
    { endMs: 2001 },
    { catalogRevision: '07' },
    { rootGeneration: 1.1 },
    { databaseRevision: -1 },
    { viewRevision: '01' },
    { groupingPolicy: 'future-policy' },
    { channels: [{ ...item(), filterMask: undefined }] },
    { channels: [{ ...item(), sourceRevision: 0 }] },
    { channels: [{ ...item(), appChannelId: '\u0000' }] },
    { channels: Array.from({ length: 1025 }, (_, i) => item(String(i))) },
    { nextCursor: '', channels: [] },
  ])('rejects malformed page %j', async (bad) => {
    invoke.mockResolvedValue({ ...page(), ...bad });
    await expect(read()).rejects.toThrow('invalid');
  });
  it('rejects repeated identities, nonadvancing order and conflicting source revisions', async () => {
    for (const channels of [[item('a')], [item('0')], [{ ...item('b'), sourceRevision: 4 }]]) {
      invoke.mockReset();
      invoke.mockResolvedValueOnce(page([item('a')], 'one')).mockResolvedValueOnce(page(channels));
      await expect(read()).rejects.toThrow('invalid');
    }
  });
  it('rejects repeating cursor or nonterminal empty page', async () => {
    invoke
      .mockResolvedValueOnce(page([item('a')], 'one'))
      .mockResolvedValueOnce(page([item('b')], 'one'));
    await expect(read()).rejects.toThrow('invalid');
    invoke.mockReset();
    invoke.mockResolvedValue(page([], 'one'));
    await expect(read()).rejects.toThrow('invalid');
  });
  it('propagates stale native cursor error without fallback', async () => {
    invoke
      .mockResolvedValueOnce(page([item()], 'one'))
      .mockRejectedValueOnce(new Error('guide-listed-stale-cursor'));
    await expect(read()).rejects.toThrow('stale-cursor');
  });
  it('joins producer and cancellation acknowledgement before rejecting abort', async () => {
    const controller = new AbortController();
    let resolveRead!: (v: unknown) => void, resolveCancel!: (v: unknown) => void;
    invoke.mockImplementation(
      (command: string) =>
        new Promise((resolve) => {
          if (command === 'cancel_playlist') resolveCancel = resolve;
          else resolveRead = resolve;
        }),
    );
    let settled = false;
    const result = read(controller.signal).finally(() => {
      settled = true;
    });
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveRead(page());
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveCancel(undefined);
    await expect(result).rejects.toThrow();
    expect(settled).toBe(true);
    expect(invoke.mock.calls).toHaveLength(2);
  });
  it('rejects pre-abort and unavailable native runtime without invoking', async () => {
    const c = new AbortController();
    c.abort();
    await expect(read(c.signal)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    isTauri.mockReturnValue(false);
    await expect(read()).rejects.toThrow('unavailable');
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each(['canceled', 'guide-cancelled', 'application-closing'])(
    'normalizes native %s only after the original command and cancellation join',
    async (code) => {
      const controller = new AbortController();
      let rejectRead!: (error: unknown) => void, resolveCancel!: () => void;
      invoke.mockImplementation((command: string) =>
        command === 'cancel_playlist'
          ? new Promise<void>((resolve) => {
              resolveCancel = resolve;
            })
          : new Promise((_, reject) => {
              rejectRead = reject;
            }),
      );
      let settled = false;
      const pending = read(controller.signal).finally(() => {
        settled = true;
      });
      const refused = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      rejectRead(code);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      resolveCancel();
      await refused;
      expect(settled).toBe(true);
      expect(invoke.mock.calls[1]![1].requestId).toBe(invoke.mock.calls[0]![1].requestId);
    },
  );
  it.each(['canceled', 'guide-cancelled', 'application-closing'])(
    'preserves native %s when this owner was not aborted',
    async (code) => {
      invoke.mockRejectedValue(code);
      await expect(read()).rejects.toBe(code);
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );
  it('preserves unrelated producer failure after an owned abort and successful cancellation join', async () => {
    const controller = new AbortController();
    let rejectRead!: (error: unknown) => void, resolveCancel!: () => void;
    invoke.mockImplementation((command: string) =>
      command === 'cancel_playlist'
        ? new Promise<void>((resolve) => {
            resolveCancel = resolve;
          })
        : new Promise((_, reject) => {
            rejectRead = reject;
          }),
    );
    let settled = false;
    const pending = read(controller.signal).finally(() => {
      settled = true;
    });
    const refused = expect(pending).rejects.toBe('sqlite-operation-failed');
    controller.abort();
    rejectRead('sqlite-operation-failed');
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveCancel();
    await refused;
  });
  it('does not replace a failed cancellation acknowledgement with a normal native abort', async () => {
    const controller = new AbortController();
    let rejectRead!: (error: unknown) => void;
    invoke.mockImplementation((command: string) =>
      command === 'cancel_playlist'
        ? Promise.reject(new Error('request-lock'))
        : new Promise((_, reject) => {
            rejectRead = reject;
          }),
    );
    const pending = read(controller.signal);
    const refused = expect(pending).rejects.toThrow('cancellation acknowledgement failed');
    controller.abort();
    rejectRead('guide-cancelled');
    await refused;
  });
  it('reports failed cancellation acknowledgement after joining the actual producer', async () => {
    const controller = new AbortController();
    let settle!: (v: unknown) => void;
    invoke.mockImplementation((command: string) =>
      command === 'cancel_playlist'
        ? Promise.reject(new Error('request-lock'))
        : new Promise((resolve) => {
            settle = resolve;
          }),
    );
    let finished = false;
    const pending = read(controller.signal).finally(() => {
      finished = true;
    });
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    settle(page());
    await expect(pending).rejects.toThrow('cancellation acknowledgement failed');
  });
  it('refuses aggregate capacity without returning the preceding valid pages', async () => {
    let n = 0;
    invoke.mockImplementation(async () => {
      const prefix = String(n++).padStart(4, '0');
      return page(
        Array.from({ length: 24 }, (_, i) =>
          item(`${prefix}-${String(i).padStart(3, '0')}-${'x'.repeat(9000)}`),
        ),
        `cursor-${prefix}`,
      );
    });
    await expect(read()).rejects.toThrow('safe capacity');
    expect(n).toBeLessThan(30);
  });
  it('rejects unknown protocol fields on both pages and rows', async () => {
    invoke.mockResolvedValue({ ...page(), unexpected: true });
    await expect(read()).rejects.toThrow('invalid');
    const malformed = { ...item(), unexpected: true };
    invoke.mockResolvedValue(page([malformed]));
    await expect(read()).rejects.toThrow('invalid');
  });
});

describe('Live display-group membership protocol', () => {
  it('admits bounded native group filter facts without exporting aliases or endpoints', async () => {
    invoke.mockResolvedValue({
      ...page([{ ...item(), filterMask: 6 }]),
      viewRevision: '11',
      groupingPolicy: 'exact-ordered-endpoints-policy-v2',
    });
    const result = await read();
    expect(result).toMatchObject({
      viewRevision: '11',
      groupingPolicy: 'exact-ordered-endpoints-policy-v2',
      channels: [{ filterMask: 6 }],
    });
  });
  it.each([{ filterMask: 8 }, { filterMask: -1 }, { filterMask: 1.5 }, { filterMask: true }])(
    'refuses malformed group mask %j',
    async (bad) => {
      invoke.mockResolvedValue({
        ...page([{ ...item(), ...bad }]),
        viewRevision: '11',
        groupingPolicy: 'exact-ordered-endpoints-policy-v2',
      });
      await expect(read()).rejects.toThrow('invalid');
    },
  );
  it.each(['viewRevision', 'groupingPolicy'])(
    'rejects changed %s between pages without partial publication',
    async (key) => {
      const grouped = (id: string, nextCursor: string | null) => ({
        ...page([{ ...item(id), filterMask: 0 }], nextCursor),
        viewRevision: '11',
        groupingPolicy: 'exact-ordered-endpoints-policy-v2',
      });
      invoke.mockResolvedValueOnce(grouped('a', 'one')).mockResolvedValueOnce({
        ...grouped('b', null),
        [key]: key === 'viewRevision' ? '12' : 'future-policy',
      });
      await expect(read()).rejects.toThrow('invalid');
    },
  );
});
