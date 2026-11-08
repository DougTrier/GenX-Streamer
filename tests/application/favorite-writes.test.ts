// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import {
  createChannelEdits,
  type ChannelEditsEnvironment,
} from '../../src/application/catalog/channel-edits';

const { invoke, queryCatalogPage } = vi.hoisted(() => ({
  invoke: vi.fn(),
  queryCatalogPage: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }));
vi.mock('../../src/platform/catalog-query', () => ({ queryCatalogPage }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  vi.stubGlobal('document', { hidden: false });
  const settings = { favorites: [] as string[] };
  const notice = vi.fn();
  const applySettings = vi.fn();
  const renderCatalog = vi.fn();
  const writeAccountPreference = vi.fn().mockResolvedValue({ changed: true });
  const selectionFor = vi.fn();
  const accountSelection = { controller: new AbortController() };
  const env = {
    catalogWrites: Promise.resolve(),
    persistedCatalogRevision: '7',
    nativeViewingForeground: true,
    settings,
    catalogBrowseViewRevision: 0,
    preferences: {
      mutateExternally: async (commit: () => Promise<void>) => {
        await commit();
        return settings;
      },
    },
    accountBrowser: {
      selectionFor,
      get selectionSignal() {
        return accountSelection.controller.signal;
      },
    },
    writeAccountPreference,
    element: () => ({ dataset: { ready: 'true' }, querySelectorAll: () => [] }),
    guide: { catalogChanged: vi.fn() },
    applySettings,
    renderCatalog,
    notice,
    friendlyError: (error: Error) => error.message,
  };
  const edits = createChannelEdits(env as unknown as ChannelEditsEnvironment);
  return {
    edits,
    settings,
    notice,
    applySettings,
    renderCatalog,
    selectionFor,
    writeAccountPreference,
    accountSelection,
  };
}

it('retries a rejected favorite revision once with a fresh native view and the same target', async () => {
  const { edits, settings, notice } = fixture();
  queryCatalogPage
    .mockResolvedValueOnce({ catalogRevision: '7', viewRevision: '20' })
    .mockResolvedValueOnce({ catalogRevision: '7', viewRevision: '21' });
  invoke.mockRejectedValueOnce('catalog-group-revision-stale').mockImplementationOnce(async () => {
    settings.favorites.push('free');
    return {
      schemaVersion: 1,
      committed: true,
      catalogRevision: '7',
      viewRevision: '22',
      affectedCount: 1,
    };
  });
  edits.toggleChannelFavorite('free');
  await vi.waitFor(() => expect(edits.pendingChannelFavorite('free')).toBeUndefined());
  expect(
    invoke.mock.calls.map(([command, { request }]) => [
      command,
      request.expectedViewRevision,
      request.action,
    ]),
  ).toEqual([
    ['mutate_catalog_group', '20', { kind: 'favorite', value: true }],
    ['mutate_catalog_group', '21', { kind: 'favorite', value: true }],
  ]);
  expect(settings.favorites).toEqual(['free']);
  expect(notice).not.toHaveBeenCalled();
});

it('a pending Paid favorite from a former selection cannot swallow a press after reopening it', async () => {
  const { edits, notice, accountSelection, selectionFor, writeAccountPreference } = fixture();
  const id = 'paid-row';
  selectionFor.mockReturnValue({ favorite: false });
  let rejectOld!: (reason: Error) => void;
  writeAccountPreference.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      }),
  );
  edits.toggleChannelFavorite(id);
  await vi.waitFor(() => expect(writeAccountPreference).toHaveBeenCalledTimes(1));
  accountSelection.controller.abort();
  accountSelection.controller = new AbortController();
  expect(edits.pendingChannelFavorite(id)).toBeUndefined();
  edits.toggleChannelFavorite(id);
  expect(edits.pendingChannelFavorite(id)).toBe(true);
  rejectOld(new Error('Canceled old selection'));
  await vi.waitFor(() => expect(edits.pendingChannelFavorite(id)).toBeUndefined());
  expect(writeAccountPreference.mock.calls.map(([mutation]) => mutation.favorite)).toEqual([
    true,
    true,
  ]);
  expect(notice).not.toHaveBeenCalled();
});

it('does not retry ambiguous native failures or expose the native payload', async () => {
  const { edits, notice, settings } = fixture();
  queryCatalogPage.mockResolvedValue({ catalogRevision: '7', viewRevision: '20' });
  invoke.mockRejectedValue('unexpected private native payload');
  edits.toggleChannelFavorite('free');
  await vi.waitFor(() => expect(edits.pendingChannelFavorite('free')).toBeUndefined());
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(notice).toHaveBeenCalledWith('The channel change could not be saved. Try again.');
  expect(settings.favorites).toEqual([]);
});

it('keeps the Free TV list in place until the last queued favorite state is saved', async () => {
  const { edits, settings, applySettings, notice } = fixture();
  queryCatalogPage.mockResolvedValue({ catalogRevision: '7', viewRevision: '20' });
  let finishFirst!: () => void;
  const receipt = {
    schemaVersion: 1,
    committed: true,
    catalogRevision: '7',
    viewRevision: '21',
    affectedCount: 1,
  };
  invoke
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () => {
            settings.favorites.push('free');
            resolve(receipt);
          };
        }),
    )
    .mockImplementationOnce(async () => {
      expect(applySettings).not.toHaveBeenCalled();
      settings.favorites = [];
      return { ...receipt, viewRevision: '22' };
    });
  edits.toggleChannelFavorite('free');
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  edits.toggleChannelFavorite('free');
  finishFirst();
  await vi.waitFor(() => expect(edits.pendingChannelFavorite('free')).toBeUndefined());
  expect(invoke.mock.calls.map(([, { request }]) => request.action.value)).toEqual([true, false]);
  expect(applySettings).toHaveBeenCalledTimes(1);
  expect(notice).not.toHaveBeenCalled();
  expect(settings.favorites).toEqual([]);
});

it('keeps the latest Paid favorite state and serializes writes across rows', async () => {
  const { edits, notice, renderCatalog, selectionFor, writeAccountPreference } = fixture();
  const first = 'paid-first';
  const second = 'paid-second';
  selectionFor.mockReturnValue({ favorite: false });
  let release!: () => void;
  writeAccountPreference.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ changed: true });
      }),
  );
  edits.toggleChannelFavorite(first);
  await vi.waitFor(() => expect(writeAccountPreference).toHaveBeenCalledTimes(1));
  for (let tap = 0; tap < 19; tap++) edits.toggleChannelFavorite(first);
  edits.toggleChannelFavorite(second);
  expect(edits.pendingChannelFavorite(first)).toBe(false);
  expect(edits.pendingChannelFavorite(second)).toBe(true);
  expect(writeAccountPreference).toHaveBeenCalledTimes(1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(renderCatalog).not.toHaveBeenCalled();
  expect(edits.pendingChannelFavorite(first)).toBe(false);
  await vi.waitFor(() => expect(edits.pendingChannelFavorite(second)).toBeUndefined());
  expect(writeAccountPreference.mock.calls.map(([mutation]) => mutation)).toEqual([
    { kind: 'favorite', channelId: first, favorite: true },
    { kind: 'favorite', channelId: first, favorite: false },
    { kind: 'favorite', channelId: second, favorite: true },
  ]);
  expect(renderCatalog).toHaveBeenCalledTimes(2);
  expect(notice).not.toHaveBeenCalled();
});
