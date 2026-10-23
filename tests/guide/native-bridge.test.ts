import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ invoke: vi.fn(), native: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke, isTauri: () => api.native }));
import {
  nativeGuide,
  previewNativeGuide,
  readDailyGuidePlan,
  refreshDailyGuide,
} from '../../src/guide/native';
const preview = {
  ticket: 'ticket',
  sourceId: 'source',
  sourceRevision: 1,
  channels: 1,
  programs: 2,
  firstStartMs: 0,
  lastStartMs: 900,
  lastKnownStopMs: 1000,
};
beforeEach(() => {
  api.invoke.mockReset();
  api.invoke.mockImplementation((command: string) =>
    Promise.resolve(command === 'runtime_info' ? { platform: 'windows' } : preview),
  );
  api.native = true;
});

it('daily guide plan rejects malformed and over-limit native schedules', async () => {
  api.invoke.mockResolvedValue({
    nowMs: 1000,
    sources: [{ sourceId: 'g', sourceRevision: 0, nextDueMs: 2000 }],
  });
  await expect(readDailyGuidePlan(new AbortController().signal)).rejects.toThrow(
    'schedule is invalid',
  );
  api.invoke.mockResolvedValue({
    nowMs: 1000,
    sources: Array.from({ length: 1001 }, () => ({
      sourceId: 'g',
      sourceRevision: 1,
      nextDueMs: 2000,
    })),
  });
  await expect(readDailyGuidePlan(new AbortController().signal)).rejects.toThrow(
    'schedule is invalid',
  );
});
it.each([101, 1000])('admits a bounded %i-source native guide refresh plan', async (count) => {
  const sources = Array.from({ length: count }, (_, i) => ({
    sourceId: `guide-${i}`,
    sourceRevision: 1,
    nextDueMs: 2000,
  }));
  api.invoke.mockResolvedValue({ nowMs: 1000, sources });
  expect((await readDailyGuidePlan(new AbortController().signal)).sources).toEqual(sources);
});

it('daily refresh cancellation joins the exact request and does not accept an unrelated receipt', async () => {
  let finish!: (value: unknown) => void;
  let cancelFinish!: () => void;
  api.invoke.mockImplementation((command: string) =>
    command === 'cancel_playlist'
      ? new Promise<void>((resolve) => {
          cancelFinish = resolve;
        })
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  const abort = new AbortController();
  const result = refreshDailyGuide(
    { sourceId: 'g', sourceRevision: 1, nextDueMs: 0 },
    abort.signal,
  );
  let settled = false;
  const caught = result
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  const request = api.invoke.mock.calls[0]![1] as { requestId: string };
  abort.abort();
  expect(api.invoke).toHaveBeenLastCalledWith('cancel_playlist', { requestId: request.requestId });
  finish({
    requestId: 'wrong',
    sourceId: 'g',
    sourceRevision: 2,
    status: 'refreshed',
    nextDueMs: 100,
    updatedMs: 1,
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  cancelFinish();
  expect(await caught).toBeInstanceOf(DOMException);
});

it('daily refresh preserves a valid durable commit receipt arriving after cancellation', async () => {
  let finish!: (value: unknown) => void;
  api.invoke.mockImplementation((command: string) =>
    command === 'cancel_playlist'
      ? Promise.resolve()
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  const abort = new AbortController();
  const result = refreshDailyGuide(
    { sourceId: 'g', sourceRevision: 1, nextDueMs: 0 },
    abort.signal,
  );
  const request = api.invoke.mock.calls[0]![1] as { requestId: string };
  abort.abort();
  const receipt = {
    requestId: request.requestId,
    sourceId: 'g',
    sourceRevision: 2,
    status: 'refreshed',
    nextDueMs: 100,
    updatedMs: 1,
  };
  finish(receipt);
  await expect(result).resolves.toEqual(receipt);
});
describe('guide native input ownership', () => {
  it('rejects an oversized file before reading or invoking native code', async () => {
    const file = { size: 20 * 1024 * 1024 + 1, arrayBuffer: vi.fn() } as unknown as File;
    await expect(previewNativeGuide('source', new AbortController().signal, file)).rejects.toThrow(
      '20 MiB',
    );
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(api.invoke).not.toHaveBeenCalled();
  });
  it('sends admitted files as raw binary without expanding a JSON number array', async () => {
    const bytes = new Uint8Array([0x1f, 0x8b, 0]).buffer;
    const file = { size: 3, arrayBuffer: async () => bytes } as File;
    await expect(previewNativeGuide('source', new AbortController().signal, file)).resolves.toEqual(
      preview,
    );
    expect(api.invoke).toHaveBeenCalledWith('guide_preview_file', bytes, {
      headers: {
        'x-genx-guide-source': 'source',
        'x-genx-guide-request': expect.any(String),
      },
    });
  });
  it('cancel during file reading prevents native work', async () => {
    const abort = new AbortController();
    const file = {
      size: 1,
      arrayBuffer: async () => {
        abort.abort();
        return new ArrayBuffer(1);
      },
    } as File;
    await expect(previewNativeGuide('source', abort.signal, file)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(api.invoke.mock.calls.some(([command]) => command.startsWith('guide_'))).toBe(false);
  });
  it('discards a late native ticket before acknowledging cancellation', async () => {
    let settle!: (value: typeof preview) => void;
    api.invoke.mockImplementation((command: string) =>
      command === 'guide_preview'
        ? new Promise((resolve) => {
            settle = resolve;
          })
        : Promise.resolve(),
    );
    const abort = new AbortController();
    const pending = previewNativeGuide('source', abort.signal);
    abort.abort();
    settle(preview);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.invoke).toHaveBeenCalledWith('cancel_playlist', { requestId: expect.any(String) });
    expect(api.invoke).toHaveBeenCalledWith('guide_discard', { ticket: 'ticket' });
  });
  it('removes the request abort listener after a successful preview', async () => {
    api.invoke.mockResolvedValue(preview);
    const abort = new AbortController();
    await previewNativeGuide('source', abort.signal);
    abort.abort();
    expect(api.invoke).toHaveBeenCalledTimes(1);
  });
  it('browser and unsafe opaque source IDs cannot start native input', async () => {
    await expect(
      previewNativeGuide('source\r\nheader', new AbortController().signal),
    ).rejects.toThrow('identity');
    api.native = false;
    await expect(previewNativeGuide('source', new AbortController().signal)).rejects.toThrow(
      'installed app',
    );
    expect(api.invoke).not.toHaveBeenCalled();
  });

  function androidTransport(
    change?: (command: string, args: Record<string, unknown>) => unknown,
  ): void {
    api.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      const override = change?.(command, args);
      if (override !== undefined) return override;
      if (command === 'runtime_info') return { platform: 'android' };
      if (command === 'guide_file_begin') return { uploadId: 'owned-upload', chunkBytes: 32768 };
      if (command === 'guide_file_append')
        return { receivedBytes: Number(args.offset) + (args.bytes as number[]).length };
      if (command === 'guide_file_finish') return preview;
    });
  }

  it('Android slices sequential bounded chunks, retains exact bytes and never reads the whole file', async () => {
    androidTransport();
    const content = Uint8Array.from({ length: 70000 }, (_, index) => index % 256);
    const file = new File([content], 'owned.xml');
    const wholeRead = vi.spyOn(file, 'arrayBuffer');
    const slicing = vi.spyOn(file, 'slice');
    await expect(previewNativeGuide('source', new AbortController().signal, file)).resolves.toEqual(
      preview,
    );
    expect(wholeRead).not.toHaveBeenCalled();
    expect(slicing.mock.calls).toEqual([
      [0, 32768],
      [32768, 65536],
      [65536, 70000],
    ]);
    const chunks = api.invoke.mock.calls.filter(([command]) => command === 'guide_file_append');
    expect(chunks.map(([, args]) => args.offset)).toEqual([0, 32768, 65536]);
    expect(
      chunks.every(([, args]) => Array.isArray(args.bytes) && args.bytes.length <= 32768),
    ).toBe(true);
    expect(new Uint8Array(chunks.flatMap(([, args]) => args.bytes))).toEqual(content);
    expect(api.invoke).not.toHaveBeenCalledWith(
      'guide_preview_file',
      expect.anything(),
      expect.anything(),
    );
    expect(api.invoke).toHaveBeenLastCalledWith('guide_file_discard', { uploadId: 'owned-upload' });
  });

  it('cancel during a late Android admission discards it without reading or appending', async () => {
    const abort = new AbortController();
    androidTransport((command) => {
      if (command === 'guide_file_begin') {
        abort.abort();
        return { uploadId: 'owned-upload', chunkBytes: 32768 };
      }
    });
    const file = new File(['xml'], 'owned.xml');
    const slicing = vi.spyOn(file, 'slice');
    await expect(previewNativeGuide('source', abort.signal, file)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(slicing).not.toHaveBeenCalled();
    expect(api.invoke.mock.calls.some(([command]) => command === 'guide_file_append')).toBe(false);
    expect(api.invoke).toHaveBeenCalledWith('guide_file_discard', { uploadId: 'owned-upload' });
  });

  it('cancel during a chunk acknowledgment prevents subsequent chunks and finish', async () => {
    const abort = new AbortController();
    androidTransport((command, args) => {
      if (command === 'guide_file_append') {
        abort.abort();
        return { receivedBytes: (args.bytes as number[]).length };
      }
    });
    await expect(
      previewNativeGuide('source', abort.signal, new File([new Uint8Array(70000)], 'owned.xml')),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      api.invoke.mock.calls.filter(([command]) => command === 'guide_file_append'),
    ).toHaveLength(1);
    expect(api.invoke.mock.calls.some(([command]) => command === 'guide_file_finish')).toBe(false);
    expect(api.invoke).toHaveBeenCalledWith('guide_file_discard', { uploadId: 'owned-upload' });
  });

  it.each([0, 32769, 1.5])(
    'refuses invalid chunk admission %s before reading and releases its owner',
    async (chunkBytes) => {
      androidTransport((command) =>
        command === 'guide_file_begin' ? { uploadId: 'owned-upload', chunkBytes } : undefined,
      );
      const file = new File(['xml'], 'owned.xml');
      const slicing = vi.spyOn(file, 'slice');
      await expect(
        previewNativeGuide('source', new AbortController().signal, file),
      ).rejects.toThrow('admission');
      expect(slicing).not.toHaveBeenCalled();
      expect(api.invoke).toHaveBeenCalledWith('cancel_playlist', { requestId: expect.any(String) });
      expect(api.invoke).toHaveBeenCalledWith('guide_file_discard', { uploadId: 'owned-upload' });
    },
  );

  it('incorrect acknowledgment abandons the upload instead of skipping bytes', async () => {
    androidTransport((command) =>
      command === 'guide_file_append' ? { receivedBytes: 999 } : undefined,
    );
    await expect(
      previewNativeGuide('source', new AbortController().signal, new File(['xml'], 'owned.xml')),
    ).rejects.toThrow('acknowledgment');
    expect(api.invoke.mock.calls.some(([command]) => command === 'guide_file_finish')).toBe(false);
    expect(api.invoke).toHaveBeenLastCalledWith('guide_file_discard', { uploadId: 'owned-upload' });
  });

  it('malformed native admission cancels the request without reading the file', async () => {
    androidTransport((command) => (command === 'guide_file_begin' ? null : undefined));
    const file = new File(['xml'], 'owned.xml');
    const slicing = vi.spyOn(file, 'slice');
    await expect(previewNativeGuide('source', new AbortController().signal, file)).rejects.toThrow(
      'admission',
    );
    expect(slicing).not.toHaveBeenCalled();
    expect(api.invoke).toHaveBeenCalledWith('cancel_playlist', { requestId: expect.any(String) });
  });

  it('incomplete file slices abandon the upload before appending or finishing', async () => {
    androidTransport();
    const file = new File(['xml'], 'owned.xml');
    vi.spyOn(file, 'slice').mockReturnValue(new Blob(['x']));
    await expect(previewNativeGuide('source', new AbortController().signal, file)).rejects.toThrow(
      'incomplete',
    );
    expect(
      api.invoke.mock.calls.some(
        ([command]) => command === 'guide_file_append' || command === 'guide_file_finish',
      ),
    ).toBe(false);
    expect(api.invoke).toHaveBeenLastCalledWith('guide_file_discard', { uploadId: 'owned-upload' });
  });

  it('discards a late Android preview ticket and upload before acknowledging cancellation', async () => {
    const abort = new AbortController();
    androidTransport((command) => {
      if (command === 'guide_file_finish') {
        abort.abort();
        return preview;
      }
    });
    await expect(
      previewNativeGuide('source', abort.signal, new File(['xml'], 'owned.xml')),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.invoke).toHaveBeenCalledWith('guide_discard', { ticket: 'ticket' });
    expect(api.invoke).toHaveBeenLastCalledWith('guide_file_discard', { uploadId: 'owned-upload' });
  });
});

function reviewedAliases() {
  return {
    schemaVersion: 1 as const,
    guideLocation:
      'https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/PlutoTV/us.xml.gz',
    provenanceLocation:
      'https://raw.githubusercontent.com/iptv-org/epg/master/sites/pluto.tv/pluto.tv_us.channels.xml',
    provenanceSha256: 'dc1eaca8b90b1d227850f81fb02793c74a804c473eb26dd674cd1eaa8084c89e',
    pairs: [
      {
        catalogSourceId: 'saved-source',
        appChannelId: 'canonical-channel',
        providerId: 'PGATour.us@SD',
        xmltvChannelId: '5de94dacb394a300099fa22a',
      },
    ],
  };
}
it('keeps the legacy commit IPC arguments when optional aliases are absent', async () => {
  const receipt = { committed: true, matched: 1, unmatched: 0 };
  api.invoke.mockResolvedValue(receipt);
  expect(await nativeGuide.commitIfMatched('ticket', 2, '7')).toEqual(receipt);
  expect(api.invoke).toHaveBeenCalledExactlyOnceWith('guide_commit_if_matched', {
    ticket: 'ticket',
    expectedGuideRevision: 2,
    expectedCatalogRevision: '7',
  });
});
it('passes only a validated copied reviewed alias descriptor to native publication', async () => {
  const aliases = reviewedAliases();
  api.invoke.mockResolvedValue({ committed: true, matched: 1, unmatched: 0 });
  const pending = nativeGuide.commitIfMatched('ticket', 2, '7', aliases);
  const payload = api.invoke.mock.calls[0]![1] as { aliases: typeof aliases };
  expect(payload.aliases).toEqual(aliases);
  expect(payload.aliases).not.toBe(aliases);
  expect(Object.isFrozen(payload.aliases.pairs[0])).toBe(true);
  aliases.pairs[0]!.appChannelId = 'edited';
  expect(payload.aliases.pairs[0]!.appChannelId).toBe('canonical-channel');
  await pending;
});
it('refuses malformed or unreviewed aliases without invoking any native command', () => {
  const aliases = reviewedAliases();
  for (const invalid of [
    { ...aliases, guideLocation: 'https://other.invalid/guide' },
    { ...aliases, provenanceSha256: 'a'.repeat(64) },
    { ...aliases, pairs: [{ ...aliases.pairs[0]!, providerId: 'PGATour.us' }] },
    { ...aliases, pairs: [{ ...aliases.pairs[0]!, xmltvChannelId: 'unknown' }] },
  ]) {
    expect(() => nativeGuide.commitIfMatched('ticket', 2, '7', invalid)).toThrow();
  }
  expect(api.invoke).not.toHaveBeenCalled();
});

it('accepts not-modified only with the original publication revision and timestamp', async () => {
  api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
    requestId: args.requestId,
    sourceId: 'g',
    sourceRevision: 3,
    status: 'not-modified',
    nextDueMs: 100000,
    updatedMs: 1200,
  }));
  const result = await refreshDailyGuide(
    { sourceId: 'g', sourceRevision: 3, nextDueMs: 0 },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ status: 'not-modified', sourceRevision: 3, updatedMs: 1200 });
});
for (const invalid of [
  { sourceRevision: 4, updatedMs: 1200 },
  { sourceRevision: 3, updatedMs: null },
])
  it(`refuses not-modified without unchanged published evidence ${JSON.stringify(invalid)}`, async () => {
    api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
      requestId: args.requestId,
      sourceId: 'g',
      status: 'not-modified',
      nextDueMs: 100000,
      ...invalid,
    }));
    await expect(
      refreshDailyGuide(
        { sourceId: 'g', sourceRevision: 3, nextDueMs: 0 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('receipt is invalid');
  });
