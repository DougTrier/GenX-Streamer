import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => native);
import {
  previewProposedNativeGuide,
  validateProposedGuidePreview,
} from '../../src/guide/proposed-preview';
const reply = (sourceId = 'source') => ({
  ticket: 'ticket',
  sourceId,
  sourceRevision: 0,
  channels: 1,
  programs: 1,
  firstStartMs: 1000,
  lastStartMs: 1000,
  lastKnownStopMs: 2000,
  proposed: true,
});
beforeEach(() => {
  native.invoke.mockReset();
  native.isTauri.mockReturnValue(true);
});
it('only the strict proposal reply can carry revision zero', () => {
  expect(validateProposedGuidePreview(reply(), 'source')).toEqual(reply());
  for (const patch of [
    { proposed: false },
    { proposed: undefined },
    { sourceRevision: 1 },
    { sourceId: 'wrong' },
    { channels: 0 },
    { programs: -1 },
    { firstStartMs: null },
    { lastKnownStopMs: 1000 },
    { extra: true },
  ]) {
    expect(() => validateProposedGuidePreview({ ...reply(), ...patch }, 'source')).toThrow();
  }
  const getter = vi.fn();
  const row = reply();
  Object.defineProperty(row, 'ticket', { get: getter });
  expect(() => validateProposedGuidePreview(row, 'source')).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it.each([
  'http://fixture.invalid/x',
  'https://u:p@fixture.invalid/x',
  'https://fixture.invalid/x#fragment',
])('refuses ungranted proposal %s before native work', async (location) => {
  await expect(
    previewProposedNativeGuide(location, 'Guide', new AbortController().signal, vi.fn()),
  ).rejects.toThrow();
  expect(native.invoke).not.toHaveBeenCalled();
});
it('stages only a new HTTPS descriptor; never invokes save/commit', async () => {
  native.invoke.mockImplementation(async (command, args) => {
    expect(command).toBe('guide_preview_proposed_source');
    expect(args.source).toMatchObject({
      location: 'https://fixture.invalid/x',
      revision: 0,
      updatedMs: null,
      allowHttp: false,
    });
    return reply(args.source.id);
  });
  const result = await previewProposedNativeGuide(
    'https://fixture.invalid/x',
    'Guide',
    new AbortController().signal,
    vi.fn(),
  );
  expect(result.proposed).toBe(true);
  expect(native.invoke).toHaveBeenCalledOnce();
});
it.each([
  'http-404',
  'guide-input-too-large',
  'guide-expanded-too-large',
  'Guide XML is malformed.',
])('failure %s cancels owned work without saving', async (failure) => {
  native.invoke.mockImplementation(async (command) => {
    if (command === 'guide_preview_proposed_source') throw new Error(failure);
  });
  await expect(
    previewProposedNativeGuide(
      'https://fixture.invalid/x',
      'Guide',
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toThrow(failure);
  expect(native.invoke.mock.calls.map((c) => c[0])).toEqual([
    'guide_preview_proposed_source',
    'cancel_playlist',
  ]);
});
it('abort waits for actual held preview and transfers the late ticket to its owner before rejecting', async () => {
  let resolve!: (value: unknown) => void;
  let args: { source: { id: string } };
  const held = new Promise<unknown>((done) => {
    resolve = done;
  });
  native.invoke.mockImplementation(async (command, input) => {
    if (command === 'guide_preview_proposed_source') {
      args = input;
      return held;
    }
  });
  const controller = new AbortController();
  const adopted = vi.fn();
  let settled = false;
  const work = previewProposedNativeGuide(
    'https://fixture.invalid/x',
    'Guide',
    controller.signal,
    adopted,
  ).finally(() => {
    settled = true;
  });
  const outcome = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  resolve(reply(args!.source.id));
  await outcome;
  expect(adopted).toHaveBeenCalledExactlyOnceWith('ticket');
  expect(native.invoke.mock.calls.map((c) => c[0])).toEqual([
    'guide_preview_proposed_source',
    'cancel_playlist',
  ]);
});
it('malformed late reply transfers its ticket before rejecting without racing owner discard', async () => {
  native.invoke.mockImplementation(async (command) =>
    command === 'guide_preview_proposed_source' ? reply('wrong') : undefined,
  );
  const adopted = vi.fn();
  await expect(
    previewProposedNativeGuide(
      'https://fixture.invalid/x',
      'Guide',
      new AbortController().signal,
      adopted,
    ),
  ).rejects.toThrow('invalid');
  expect(adopted).toHaveBeenCalledExactlyOnceWith('ticket');
  expect(native.invoke.mock.calls.map((c) => c[0])).toEqual([
    'guide_preview_proposed_source',
    'cancel_playlist',
  ]);
});

it('accepts native XMLTV negative UTC bounds and refuses values outside the same bounds', () => {
  const old = {
    ...reply(),
    firstStartMs: -62_135_647_200_000,
    lastStartMs: -1000,
    lastKnownStopMs: 0,
  };
  expect(validateProposedGuidePreview(old, 'source')).toEqual(old);
  for (const patch of [
    { firstStartMs: -62_135_647_200_001 },
    { lastKnownStopMs: 253_402_351_200_001 },
  ]) {
    expect(() => validateProposedGuidePreview({ ...old, ...patch }, 'source')).toThrow('invalid');
  }
});
