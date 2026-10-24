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
import {
  mapGuideAndHydrate,
  MappedGuideCleanupError,
  type MappedGuideHydrationHost,
  type MappedGuidePreview,
  type MappedGuideReceipt,
} from '../../src/application/mapped-guide-schedule';
import { createMappedGuideNativeHost } from '../../src/application/mapped-guide-native';

const mapping = {
  catalogSourceId: 'catalog',
  appChannelId: 'channel',
  guideSourceId: 'guide',
  xmltvChannelId: 'selected',
};
const receipt: MappedGuideReceipt = {
  schemaVersion: 1,
  mapping,
  rootGeneration: '1',
  catalogRevision: '2',
  guideRevision: 3,
  sourceRevision: 4,
  sourceFingerprint: 'a'.repeat(64),
};
const preview = {
  ticket: 'b'.repeat(32),
  sourceId: 'guide',
  sourceRevision: 4,
  channels: 2,
  programs: 3,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const turn = () => new Promise<void>((done) => setTimeout(done, 0));
function fixture(overrides: Partial<MappedGuideHydrationHost> = {}) {
  const events: string[] = [],
    controller = new AbortController();
  let checks = 0;
  const host: MappedGuideHydrationHost = {
    save: async (m, _signal, ack) => {
      events.push('save');
      expect(m).toEqual(mapping);
      ack(receipt);
      return receipt;
    },
    status: async (_receipt, revision) => {
      events.push('status:' + revision);
      return { kind: 'url', listed: ++checks > 1 };
    },
    preview: async () => {
      events.push('preview');
      return preview;
    },
    publish: async (_preview, _signal, ack) => {
      events.push('publish');
      ack(5);
      return 5;
    },
    discard: async (ticket) => {
      expect(ticket).toBe(preview.ticket);
      events.push('discard');
    },
    ...overrides,
  };
  return {
    host,
    events,
    controller,
    run: () =>
      mapGuideAndHydrate(host, mapping, controller.signal, () => events.push('mappingACK')),
  };
}
it('acknowledges explicit Map before one target preview, cache publication and final status', async () => {
  const f = fixture();
  expect(await f.run()).toEqual({ status: 'ready', published: true });
  expect(f.events).toEqual(['save', 'mappingACK', 'status:4', 'preview', 'publish', 'status:5']);
});
it('uses retained target listings without acquisition', async () => {
  const f = fixture({ status: async () => ({ kind: 'url', listed: true }) });
  expect(await f.run()).toEqual({ status: 'ready', published: false });
  expect(f.events).toEqual(['save', 'mappingACK']);
});
it('reports a missing local-file schedule without opening a picker', async () => {
  const f = fixture({ status: async () => ({ kind: 'file', listed: false }) });
  expect(await f.run()).toEqual({ status: 'file-required', published: false });
  expect(f.events).toEqual(['save', 'mappingACK']);
});
it('establishes no listings from the actual target rather than the full-feed count', async () => {
  const f = fixture({ status: async () => ({ kind: 'url', listed: false }) });
  expect(await f.run()).toEqual({ status: 'no-listings', published: true });
});
it('does not acquire a schedule after mapping save refusal', async () => {
  const f = fixture({
    save: async () => {
      throw new Error('save refused');
    },
  });
  await expect(f.run()).rejects.toThrow('save refused');
  expect(f.events).toEqual([]);
});
it('does not save or acquire for a pre-aborted intent', async () => {
  const f = fixture();
  f.controller.abort();
  await expect(f.run()).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.events).toEqual([]);
});
it('preserves durable mapping on late abort without starting network work', async () => {
  const f = fixture();
  f.host.save = async (_mapping, _signal, ack) => {
    ack(receipt);
    f.controller.abort();
    return receipt;
  };
  expect(await f.run()).toEqual({ status: 'canceled', published: false });
  expect(f.events).toEqual(['mappingACK']);
});
it('keeps the separately acknowledged mapping when acquisition fails', async () => {
  const f = fixture({
    preview: async () => {
      throw new Error('provider failure');
    },
  });
  expect(await f.run()).toEqual({ status: 'saved-but-failed', published: false });
  expect(f.events).toContain('mappingACK');
  expect(f.events).not.toContain('publish');
});
it('joins the original preview and disposes its ticket before canceled settlement', async () => {
  const wait = deferred<MappedGuidePreview>();
  const f = fixture({ preview: () => wait.promise });
  let settled = false;
  const run = f.run().then((result) => {
    settled = true;
    return result;
  });
  await turn();
  f.controller.abort();
  await turn();
  expect(settled).toBe(false);
  wait.resolve(preview);
  expect(await run).toEqual({ status: 'canceled', published: false });
  expect(f.events.at(-1)).toBe('discard');
});
it('disposes only the adopted ticket when publication is refused', async () => {
  const f = fixture({
    publish: async () => {
      throw new Error('scope changed');
    },
  });
  expect(await f.run()).toEqual({ status: 'saved-but-failed', published: false });
  expect(f.events.filter((event) => event === 'discard')).toHaveLength(1);
});
it('reports failed disposal as cleanup failure instead of successful cancellation', async () => {
  const f = fixture({
    publish: async () => {
      throw new Error('scope changed');
    },
    discard: async () => {
      throw new Error('held');
    },
  });
  await expect(f.run()).rejects.toBeInstanceOf(MappedGuideCleanupError);
});
it('retains publication truth when abort follows the actual publication acknowledgment', async () => {
  const f = fixture();
  f.host.publish = async (_preview, _signal, ack) => {
    ack(5);
    f.controller.abort();
    return 5;
  };
  expect(await f.run()).toEqual({ status: 'canceled', published: true });
  expect(f.events).not.toContain('discard');
});
it('does not undo an acknowledged publication when final status observation fails', async () => {
  let checks = 0;
  const f = fixture({
    status: async () => {
      if (++checks > 1) throw new Error('root changed');
      return { kind: 'url', listed: false };
    },
  });
  expect(await f.run()).toEqual({ status: 'saved-but-failed', published: true });
  expect(f.events).not.toContain('discard');
});
it('cannot publish after native admission refuses a same-ID changed root', async () => {
  const f = fixture({
    preview: async (saved) => {
      expect(saved.rootGeneration).toBe('1');
      throw new Error('scan-manifest-root-changed');
    },
  });
  expect(await f.run()).toEqual({ status: 'saved-but-failed', published: false });
  expect(f.events).not.toContain('publish');
});
it('rejects a missing durable save callback before status or acquisition', async () => {
  const f = fixture({ save: async () => receipt });
  await expect(f.run()).rejects.toThrow('acknowledgment missing');
  expect(f.events).toEqual([]);
});
it('validates and reports native mapping acknowledgment despite a late abort', async () => {
  const controller = new AbortController();
  let acknowledged = false;
  const host = createMappedGuideNativeHost(
    () => {},
    async (command) => {
      if (command === 'guide_save_mapping_receipt') {
        controller.abort();
        return receipt;
      }
      return undefined;
    },
  );
  const saved = await host.save(mapping, controller.signal, () => {
    acknowledged = true;
  });
  expect(saved.rootGeneration).toBe('1');
  expect(acknowledged).toBe(true);
  await host.settle();
});
it('adopts a malformed native preview ticket and joins disposal before rejection', async () => {
  const cleanup = deferred<void>();
  const calls: string[] = [];
  const host = createMappedGuideNativeHost(
    () => {},
    async (command) => {
      calls.push(command);
      if (command === 'guide_preview_mapped') return { ...preview, sourceId: 'wrong' };
      if (command === 'guide_discard') return cleanup.promise;
      return undefined;
    },
  );
  let settled = false;
  const outcome = host.preview(receipt, new AbortController().signal).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => {
      settled = true;
      return { ok: false as const, error };
    },
  );
  await turn();
  expect(settled).toBe(false);
  expect(calls).toEqual(['guide_preview_mapped', 'guide_discard']);
  cleanup.resolve();
  const result = await outcome;
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining('preview invalid') }),
    );
});
it('joins original native preview and cancel acknowledgment while retaining the adopted ticket', async () => {
  const body = deferred<unknown>(),
    cancel = deferred<unknown>(),
    controller = new AbortController();
  const host = createMappedGuideNativeHost(
    () => {},
    async (command) =>
      command === 'guide_preview_mapped'
        ? body.promise
        : command === 'cancel_playlist'
          ? cancel.promise
          : undefined,
  );
  let settled = false;
  const work = host.preview(receipt, controller.signal).then((value) => {
    settled = true;
    return value;
  });
  controller.abort();
  body.resolve(preview);
  await turn();
  expect(settled).toBe(false);
  cancel.resolve(undefined);
  expect((await work).ticket).toBe(preview.ticket);
  await host.discard(preview.ticket);
  await host.settle();
});
it('retains failed native disposal and blocks new work until successful settlement', async () => {
  let fail = true;
  const host = createMappedGuideNativeHost(
    () => {},
    async (command) => {
      if (command === 'guide_preview_mapped') return { ...preview, sourceId: 'wrong' };
      if (command === 'guide_discard' && fail) throw new Error('refused');
      return undefined;
    },
  );
  await expect(host.preview(receipt, new AbortController().signal)).rejects.toBeInstanceOf(
    MappedGuideCleanupError,
  );
  await expect(host.save(mapping, new AbortController().signal, () => {})).rejects.toBeInstanceOf(
    MappedGuideCleanupError,
  );
  fail = false;
  await host.settle();
});
it('publishes with cache-only commit and never invokes matching or source save', async () => {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const host = createMappedGuideNativeHost(
    () => {},
    async (command, args) => {
      calls.push({ command, args });
      if (command === 'guide_preview_mapped') return preview;
      if (command === 'guide_commit') return 5;
      return undefined;
    },
  );
  const selected = await host.preview(receipt, new AbortController().signal);
  let acknowledged = false;
  expect(
    await host.publish(selected, new AbortController().signal, () => {
      acknowledged = true;
    }),
  ).toBe(5);
  expect(acknowledged).toBe(true);
  expect(calls[1].args.allowEmpty).toBe(false);
  expect(calls.map(({ command }) => command)).toEqual(['guide_preview_mapped', 'guide_commit']);
  expect(calls[1].args.requestId).toBe(calls[0].args.requestId);
  await host.settle();
});
