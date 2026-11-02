// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke }));
beforeEach(() => {
  vi.resetModules();
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(async (_command, args) => ({
    active: args?.request?.action === 'start',
    untilMs: Date.now() + 900000,
    records: [],
    droppedEvents: 0,
  }));
});
it('exports an explicit GenXtra startup error before any decoder selection', async () => {
  const trace = await import('../../src/diagnostics/playback-trace');
  const startup = await import('../../src/diagnostics/archive-startup');
  const platform = await import('../../src/platform/archive-playback');
  const playback = platform.createArchivePlayback({
    invoke: async () => {
      throw 'archive-rate-limited';
    },
  });
  const error = await playback
    .start({ schemaVersion: 1, fileRef: 'a'.repeat(64), expectedRevision: '1' })
    .catch((error) => error);
  startup.recordArchiveStartupFailure('allocate', error);
  expect(bridge.invoke).not.toHaveBeenCalled();
  await trace.playbackTrace.start();
  startup.recordArchiveStartupFailure('allocate', error);
  await trace.playbackTrace.read();
  const calls = bridge.invoke.mock.calls.filter(([, args]) => args?.request?.action === 'record');
  expect(calls).toHaveLength(1);
  expect(calls[0][1].request.record).toEqual({
    mode: 'genxtra',
    event: 'error',
    values: {
      initiator: 'startup',
      startupPhase: 'allocate',
      startupReason: 'archive-rate-limited',
      code: 'unknown',
      phase: 'startup-progress',
      evidence: 'opaque',
      frontendDroppedEvents: 0,
    },
  });
  await trace.playbackTrace.dispose();
});
it('keeps bookmark and unowned cancellation failures distinct', async () => {
  const { archiveStartupFailureFacts } = await import('../../src/diagnostics/archive-startup');
  const { ArchiveBookmarkError: Bookmark } = await import('../../src/platform/archive-bookmarks');
  expect(archiveStartupFailureFacts('bookmark', new Bookmark('stale')).startupReason).toBe(
    'bookmark-stale',
  );
  expect(
    archiveStartupFailureFacts('before-start', new DOMException('private', 'AbortError'))
      .startupReason,
  ).toBe('cancelled');
  const { ArchivePlayerCleanupError, ArchiveFileRemovedError } =
    await import('../../src/application/genxtra/archive-player');
  expect(archiveStartupFailureFacts('release', new ArchivePlayerCleanupError()).startupReason).toBe(
    'cleanup',
  );
  const removed = new ArchiveFileRemovedError({ private: 'https://secret.invalid' } as never);
  expect(archiveStartupFailureFacts('allocate', removed).startupReason).toBe('unavailable');
  expect(JSON.stringify(archiveStartupFailureFacts('allocate', removed))).not.toMatch(
    /https|secret/,
  );
});
it('does not inspect arbitrary payloads, messages, getters or private causes', async () => {
  const { archiveStartupFailureFacts } = await import('../../src/diagnostics/archive-startup');
  const getter = vi.fn(() => {
    throw Error('private');
  });
  const payloads = [
    'sqlite-busy https://secret.invalid/token',
    Error('archive-request-timeout private'),
    {
      get message() {
        return getter();
      },
      cause: 'private',
    },
    new Proxy({}, { getPrototypeOf: getter }),
  ];
  for (const error of payloads) {
    const facts = archiveStartupFailureFacts('allocate', error);
    expect(facts.startupReason).toBe('unknown');
    expect(JSON.stringify(facts)).not.toMatch(/secret|https|private|token/);
  }
  expect(getter).toHaveBeenCalledTimes(1); // Proxy prototype probe is caught, not its message getter.
  expect(archiveStartupFailureFacts('https://private.invalid' as never, null).startupPhase).toBe(
    'unknown',
  );
});
