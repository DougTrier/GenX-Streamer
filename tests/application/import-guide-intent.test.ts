/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createImportController } from '../../src/application/discovery/import-controller';
import { createGuidePlaybackIntents } from '../../src/application/playback/guide-playback-intent';
import { joinGuideWork } from '../../src/application/guide/join-guide-work';
import type { AccountMetadata } from '../../src/platform/account-vault';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true }));
vi.mock('../../src/ui/scan/import-entry', () => ({
  installConfiguredImportEntry: () => ({ dispose() {} }),
}));
vi.mock('../../src/ui/guide/guide-grabber-settings', () => ({ installGuideGrabberExport() {} }));

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { hidden: false, querySelector: () => null });
  native.invoke.mockReset();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture(kind: 'free' | 'paid') {
  const refreshDone = gate(),
    cancelDone = gate();
  const events: string[] = [];
  const account: AccountMetadata = {
    schemaVersion: 1,
    id: 'a'.repeat(32),
    name: 'Offline fixture',
    kind: 'xtream',
    serverOrigin: 'https://fixture.invalid',
    allowHttp: false,
    revision: '1',
    requiresSignIn: false,
  };
  const selected = new AbortController();
  const due = { revision: 1, fetchedMs: 0, programs: 1, channels: 1, skipped: 0 };
  native.invoke.mockImplementation(async (command: string) => {
    events.push(command);
    if (command === 'guide_refresh_plan')
      return {
        nowMs: Date.now(),
        sources: kind === 'free' ? [{ sourceId: 'saved', sourceRevision: 1, nextDueMs: 0 }] : [],
      };
    if (command === 'read_iptv_account_guide_status') return due;
    if (command === 'guide_refresh_due' || command === 'refresh_iptv_account_guide') {
      await refreshDone.promise;
      events.push('native-work-settled');
      throw 'canceled';
    }
    if (command === 'cancel_playlist') {
      await cancelDone.promise;
      events.push('cancel-ack');
      return;
    }
    throw new Error('Unexpected offline native command');
  });
  const elements = new Map<string, EventTarget & { dataset: { ready: string } }>();
  const element = (id: string) => {
    if (!elements.has(id))
      elements.set(id, Object.assign(new EventTarget(), { dataset: { ready: 'true' } }));
    return elements.get(id)!;
  };
  const player = {
    snapshot: { state: 'idle' },
    subscribe: () => () => {},
  };
  const env = {
    fileImportTarget: new EventTarget(),
    importDialog: new EventTarget(),
    element,
    accountBrowser: {
      selectedAccount: kind === 'paid' ? account : null,
      selectionSignal: selected.signal,
      identity: () => 'offline-account',
      subscribeSelection: () => () => {},
    },
    paidGuide: { open: false, cacheChanged: async () => {} },
    catalog: { sources: [], channels: [] },
    player,
    settings: { automaticGuideUpdates: true, automaticSourceRefresh: false },
    rendererRecoveryPolicy: { allowAutomaticWork: () => true },
    guideController: { automaticGuideControlPending: 0 },
    nativeViewingForeground: true,
    backgroundSuspension: null,
    applicationClosing: false,
    importRunning: false,
    transferBusy: false,
    primaryPage: 'watch',
    scanPlaybackBusy: () => intents.pending > 0,
    bootstrapBoundary: { run() {} },
  };
  const owner = createImportController(
    env as unknown as Parameters<typeof createImportController>[0],
  );
  const full = { suspend: vi.fn(async () => void events.push('full-guide-joined')) };
  const intents = createGuidePlaybackIntents({
    prepare: () => joinGuideWork([full, owner.dailyGuideRefresh]),
    wake() {},
  });
  const result = { owner, intents, player, refreshDone, cancelDone, events, env };
  cleanups.push(async () => {
    refreshDone.resolve();
    cancelDone.resolve();
    await owner.dailyGuideRefresh.dispose();
    await owner.dailyRefresh.dispose();
  });
  return result;
}

it.each(['free', 'paid'] as const)(
  'does not start a new %s Guide acquisition while a playback intent is pending and decoder is idle',
  async (kind) => {
    const f = await fixture(kind);
    const intent = f.intents.begin();
    const work = f.owner.dailyGuideRefresh.wake();
    try {
      expect(f.player.snapshot.state).toBe('idle');
      await flush();
      expect(native.invoke).not.toHaveBeenCalled();
    } finally {
      const stopping = f.owner.dailyGuideRefresh.suspend();
      f.refreshDone.resolve();
      f.cancelDone.resolve();
      await Promise.allSettled([work, stopping]);
      intent.release();
    }
  },
);

it.each([
  ['free', 'work'],
  ['free', 'ack'],
  ['paid', 'work'],
  ['paid', 'ack'],
] as const)(
  'joins actual %s Guide native refresh and cancellation ACK when %s settles first',
  async (kind, first) => {
    const f = await fixture(kind);
    const work = f.owner.dailyGuideRefresh.wake();
    await flush();
    expect(f.events).toContain(
      kind === 'free' ? 'guide_refresh_due' : 'refresh_iptv_account_guide',
    );
    const intent = f.intents.begin();
    const media = vi.fn(() => void f.events.push('media-acquired'));
    const acquiring = intent.prepare().then(media);
    try {
      await flush();
      expect(f.events).toContain('cancel_playlist');
      expect(media).not.toHaveBeenCalled();
      if (first === 'work') f.refreshDone.resolve();
      else f.cancelDone.resolve();
      await flush();
      expect(media).not.toHaveBeenCalled();
      expect(f.intents.pending).toBe(1);
      if (first === 'work') f.cancelDone.resolve();
      else f.refreshDone.resolve();
      await Promise.all([work, acquiring]);
      expect(media).toHaveBeenCalledOnce();
      expect(f.events.indexOf('media-acquired')).toBeGreaterThan(f.events.indexOf('cancel-ack'));
      expect(f.events.indexOf('media-acquired')).toBeGreaterThan(
        f.events.indexOf('native-work-settled'),
      );
      native.invoke.mockClear();
      await f.owner.dailyGuideRefresh.wake();
      expect(native.invoke).not.toHaveBeenCalled();
    } finally {
      f.refreshDone.resolve();
      f.cancelDone.resolve();
      await Promise.allSettled([work, acquiring]);
      intent.release();
    }
  },
);
