/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { expect, it, vi } from 'vitest';
import { createWatchHistoryRecorder } from '../../src/application/playback/watch-history-recorder';
import type {
  ChannelSelection,
  DecodedPlaybackObservation,
} from '../../src/playback/controller-model';

function fixture(load: () => Promise<void> = async () => {}, admitted: () => boolean = () => true) {
  let listener: (value: DecodedPlaybackObservation) => void = () => {};
  const state = { generation: 1, current: true };
  const unsubscribe = vi.fn();
  const record = vi.fn(async () => {}),
    settle = vi.fn(async () => {}),
    failed = vi.fn();
  const player = {
    get liveBufferGeneration() {
      return state.generation;
    },
    isDecodedCurrent: () => state.current,
    subscribeDecoded: (next: typeof listener) => {
      listener = next;
      return unsubscribe;
    },
  };
  const recorder = createWatchHistoryRecorder(player, { load, record, settle }, failed, admitted);
  const emit = (selection: Partial<ChannelSelection> = {}) =>
    listener({
      selection: {
        id: 'free-1',
        name: 'Fixture',
        url: 'https://example.test/live.m3u8',
        ...selection,
      },
      attempt: {},
      evidence: {
        kind: 'decoded',
        before: { mediaTime: 0, decodedFrames: 0, width: 640, height: 360 },
        after: { mediaTime: 1, decodedFrames: 30, width: 640, height: 360 },
        elapsedMilliseconds: 1000,
      },
    });
  return { state, emit, record, settle, failed, unsubscribe, recorder };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

it('records only decoded admission, once per selection generation rather than every sample or retry', async () => {
  const f = fixture();
  expect(f.record).not.toHaveBeenCalled();
  f.emit();
  await flush();
  f.emit();
  await flush();
  expect(f.record.mock.calls).toEqual([[{ kind: 'free' }, 'free-1']]);
  f.state.generation++;
  f.emit();
  await flush();
  expect(f.record).toHaveBeenCalledTimes(2);
  await f.recorder.dispose();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.settle).toHaveBeenCalledOnce();
});

it('keeps Paid live IDs in their account scope and excludes VOD, GenXtra and malformed private IDs', async () => {
  const f = fixture();
  const accountId = 'a'.repeat(32),
    id = `account-${accountId}-${'b'.repeat(64)}`;
  f.emit({ id });
  await flush();
  expect(f.record.mock.calls).toEqual([[{ kind: 'paid', accountId }, id]]);
  for (const selection of [
    { id: 'archive-item', playMode: 'on-demand' as const },
    { id, playMode: 'on-demand' as const },
    { id: 'account-malformed' },
  ]) {
    f.state.generation++;
    f.emit(selection);
    await flush();
  }
  expect(f.record).toHaveBeenCalledOnce();
  await f.recorder.dispose();
});

it('does not record stale decoder observations or replay removed history while the same channel continues', async () => {
  const f = fixture();
  f.state.current = false;
  f.emit();
  await flush();
  expect(f.record).not.toHaveBeenCalled();
  f.state.current = true;
  f.emit();
  await flush();
  // History removal is a separate store operation; ongoing frames must not re-add it.
  f.record.mockClear();
  f.emit();
  f.emit();
  await flush();
  expect(f.record).not.toHaveBeenCalled();
  await f.recorder.dispose();
});

it('joins a held read and refuses a late history write after Stop or disposal', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const f = fixture(() => gate);
  f.emit();
  f.state.generation++;
  f.state.current = false;
  const closing = f.recorder.dispose();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.record).not.toHaveBeenCalled();
  release();
  await closing;
  expect(f.record).not.toHaveBeenCalled();
});

it('reports a storage failure once for that viewing session without repeated writes from later frames', async () => {
  const f = fixture(async () => {
    throw new Error('Fixture storage failure');
  });
  f.emit();
  await flush();
  f.emit();
  await flush();
  expect(f.failed).toHaveBeenCalledOnce();
  expect(f.record).not.toHaveBeenCalled();
  await f.recorder.dispose();
});

it('excludes unmapped Web selections until a real live catalog capability admits them', async () => {
  let admitted = false;
  const f = fixture(undefined, () => admitted);
  f.emit();
  await flush();
  expect(f.record).not.toHaveBeenCalled();
  admitted = true;
  f.emit();
  await flush();
  expect(f.record).toHaveBeenCalledOnce();
  await f.recorder.dispose();
});
