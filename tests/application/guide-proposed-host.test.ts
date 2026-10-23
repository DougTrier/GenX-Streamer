import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({
  previewProposedSource: vi.fn(),
  commit: vi.fn(),
  discard: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: vi.fn(() => true) }));
vi.mock('../../src/guide/native', () => ({
  nativeGuide: native,
  previewNativeGuide: vi.fn(),
  readSelectedGuide: vi.fn(),
  readChannelGuideCoverage: vi.fn(),
}));
import { previewProposedNativeGuide } from '../../src/guide/proposed-preview';
import { createAutomaticGuideBuilder } from '../../src/guide/automatic-build';
import { createGuideHost } from '../../src/application/guide-host';
const proposed = () => ({
  ticket: 'proposal',
  sourceId: 'new',
  sourceRevision: 0 as const,
  proposed: true as const,
  channels: 1,
  programs: 1,
  firstStartMs: 1000,
  lastStartMs: 1000,
  lastKnownStopMs: 2000,
});
const host = () =>
  createGuideHost({ channels: () => [], selectedChannel: () => null, watch: async () => {} });
const signal = () => new AbortController().signal;
beforeEach(() => {
  native.previewProposedSource
    .mockReset()
    .mockImplementation(async (_location, _name, _signal, adopt) => {
      adopt('proposal');
      return proposed();
    });
  native.commit.mockReset().mockResolvedValue(1);
  native.discard.mockReset().mockResolvedValue(undefined);
});
it('registers a proposed ticket in the real existing mutation owner and consumes only a definite receipt', async () => {
  const owner = host();
  const result = await owner.previewProposedSource('https://fixture.invalid/x', 'Guide', signal());
  await owner.publishCachedPreview(result.ticket, 0, signal());
  expect(native.commit).toHaveBeenCalledExactlyOnceWith('proposal', 0, false);
  await expect(owner.publishCachedPreview(result.ticket, 0, signal())).rejects.toThrow('changed');
  expect(native.commit).toHaveBeenCalledOnce();
});
it('uncertain commit retains its ticket; retry and an actual late durable receipt remain truthful', async () => {
  const owner = host();
  await owner.previewProposedSource('https://fixture.invalid/x', 'Guide', signal());
  native.commit.mockRejectedValueOnce(new Error('uncertain native result'));
  await expect(owner.publishCachedPreview('proposal', 0, signal())).rejects.toThrow('uncertain');
  const controller = new AbortController();
  native.commit.mockImplementationOnce(async () => {
    controller.abort();
    return 1;
  });
  await expect(
    owner.publishCachedPreview('proposal', 0, controller.signal),
  ).resolves.toBeUndefined();
  expect(native.commit).toHaveBeenCalledTimes(2);
  expect(native.discard).not.toHaveBeenCalled();
});
it('abort before ticket registration joins the late actual ticket discard', async () => {
  let complete!: (value: ReturnType<typeof proposed>) => void;
  let finishDiscard!: () => void;
  native.previewProposedSource.mockImplementationOnce(async (_location, _name, _signal, adopt) => {
    const result = await new Promise<ReturnType<typeof proposed>>((done) => {
      complete = done;
    });
    adopt(result.ticket);
    return result;
  });
  native.discard.mockReturnValueOnce(
    new Promise<void>((done) => {
      finishDiscard = done;
    }),
  );
  const owner = host(),
    controller = new AbortController();
  let settled = false;
  const work = owner
    .previewProposedSource('https://fixture.invalid/x', 'Guide', controller.signal)
    .finally(() => {
      settled = true;
    });
  const outcome = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(native.previewProposedSource).toHaveBeenCalledOnce());
  controller.abort();
  complete(proposed());
  await vi.waitFor(() => expect(native.discard).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  finishDiscard();
  await outcome;
});
it('failed late discard stays owned and is retried before another proposal can begin', async () => {
  const owner = host(),
    controller = new AbortController();
  native.previewProposedSource.mockImplementationOnce(async (_location, _name, _signal, adopt) => {
    controller.abort();
    adopt('proposal');
    return proposed();
  });
  native.discard.mockRejectedValueOnce(new Error('discard not confirmed'));
  await expect(
    owner.previewProposedSource('https://fixture.invalid/x', 'Guide', controller.signal),
  ).rejects.toThrow('not confirmed');
  expect(native.previewProposedSource).toHaveBeenCalledOnce();
  await owner.previewProposedSource('https://fixture.invalid/next', 'Next', signal());
  expect(native.discard).toHaveBeenCalledTimes(2);
  expect(native.discard.mock.invocationCallOrder[1]).toBeLessThan(
    native.previewProposedSource.mock.invocationCallOrder[1]!,
  );
});

it('retains a raw ticket when malformed native reply cleanup fails, and joins retry before new work', async () => {
  native.previewProposedSource.mockImplementation(previewProposedNativeGuide);
  native.invoke.mockImplementation(async (command: string, args: { source?: { id: string } }) => {
    if (command === 'guide_preview_proposed_source')
      return { ...proposed(), sourceId: args.source!.id, channels: -1 };
  });
  native.discard.mockRejectedValueOnce(new Error('transient discard failure'));
  const owner = host();
  await expect(
    owner.previewProposedSource('https://fixture.invalid/x', 'Guide', signal()),
  ).rejects.toThrow('transient discard failure');
  await expect(owner.publishCachedPreview('proposal', 0, signal())).rejects.toThrow('changed');
  native.invoke.mockImplementation(async (command: string, args: { source?: { id: string } }) => {
    if (command === 'guide_preview_proposed_source')
      return { ...proposed(), sourceId: args.source!.id };
  });
  await owner.previewProposedSource('https://fixture.invalid/next', 'Next', signal());
  expect(native.discard).toHaveBeenCalledTimes(2);
  expect(native.invoke.mock.calls.filter((call) => call[0] === 'guide_discard')).toHaveLength(0);
  expect(native.discard.mock.invocationCallOrder[1]).toBeLessThan(
    native.invoke.mock.invocationCallOrder[2]!,
  );
});

it('builder disposal joins unreturned raw ticket cleanup, refuses unconfirmed discard and retries', async () => {
  native.previewProposedSource.mockImplementation(previewProposedNativeGuide);
  native.invoke.mockImplementation(async (command: string, args: { source?: { id: string } }) => {
    if (command === 'guide_preview_proposed_source')
      return { ...proposed(), sourceId: args.source!.id, channels: -1 };
  });
  native.discard.mockRejectedValueOnce(new Error('initial discard failure'));
  const owner = host();
  const builder = createAutomaticGuideBuilder({
    capture: async () => ({
      catalogRevision: '1',
      channelCount: 1,
      providers: [{ name: 'Guide', location: 'https://fixture.invalid/x', allowHttp: false }],
    }),
    canRun: () => true,
    isCurrent: () => true,
    preview: (provider, ownedSignal) =>
      owner.previewProposedSource(provider.location, provider.name, ownedSignal),
    commitMatched: async () => {
      throw new Error('invalid preview cannot commit');
    },
    discard: (ticket) => owner.discardPreview(ticket),
    settlePreviews: () => owner.settleProposedPreviews(),
  });
  expect(await builder.run()).toMatchObject({ failed: 1, connected: 0 });
  let rejectDiscard!: (reason: Error) => void;
  native.discard.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectDiscard = reject;
      }),
  );
  let settled = false;
  const closing = builder.dispose().finally(() => {
    settled = true;
  });
  const refusal = expect(closing).rejects.toThrow('still unconfirmed');
  await vi.waitFor(() => expect(native.discard).toHaveBeenCalledTimes(2));
  expect(settled).toBe(false);
  rejectDiscard(new Error('still unconfirmed'));
  await refusal;
  await builder.dispose();
  expect(native.discard).toHaveBeenCalledTimes(3);
  expect(native.previewProposedSource).toHaveBeenCalledOnce();
});
