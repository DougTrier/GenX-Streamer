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
/**
 * Saved channels' health as the viewer sees it: the quiet daily check of saved
 * Free TV channels, slow and not-responding marks, removing one channel or
 * every confirmed-dead channel, and Refresh (remove dead, then look for new).
 * Moved out of main.ts; main.ts passes the shared state it owns through the
 * environment.
 */
import { isTauri } from '@tauri-apps/api/core';
import { createChannelCheckStore, type ChannelCheck } from '../../platform/channel-checks';
import { createSavedChannelCheck } from './saved-channel-check';
import { healthVerdict } from '../../discovery/health';
import { type PlaybackController, type PlaybackSnapshot } from '../../playback/controller';
import { CATALOG_GROUP_BATCH_LIMIT, type CatalogGroupAction } from '../../platform/catalog-group';
import { type createSharingHost } from '../sharing/sharing-host';
import { type createScanController } from '../discovery/scan-controller';
import { type createAccountBrowser } from '../accounts/account-browser';
import {
  type AccountPreferencesMutation,
  type AccountPreferencesReceipt,
} from '../../platform/account-preferences';
import { type createAccountPlayer } from '../accounts/account-player';
import { type Preferences } from '../../preferences';
import { type CatalogRecord } from '../../catalog';
import { type ChannelBrowser } from '../../ui/channels/channel-browser';
import { type ContentLibrary } from '../genxtra/content-library';

/** What this area reads from, and writes back to, the rest of the application. */
export interface ChannelHealthEnvironment {
  readonly applicationClosing: boolean;
  readonly writeAccountPreference: (
    mutation: AccountPreferencesMutation,
  ) => Promise<AccountPreferencesReceipt>;
  readonly player: PlaybackController;
  readonly accountPlayer: ReturnType<typeof createAccountPlayer> | undefined;
  readonly notice: (message: string) => void;
  readonly editPublicChannelGroup: (
    id: string,
    action: CatalogGroupAction | (() => CatalogGroupAction),
    moreIds?: readonly string[],
  ) => Promise<void>;
  readonly settings: Preferences;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
  readonly saveSettings: (
    mutate: (draft: Preferences) => void,
    guard?: () => Promise<boolean>,
    allowDuringScan?: boolean,
  ) => Promise<boolean>;
  readonly renderCatalog: () => void;
  readonly catalog: CatalogRecord;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly nativeViewingForeground: boolean;
  readonly scanController: ReturnType<typeof createScanController>;
  readonly sourceScan: ReturnType<typeof createScanController>['sourceScan'];
  readonly inspectStreamEvidence: ReturnType<typeof createScanController>['inspectStreamEvidence'];
  channelCheckMarks: ReadonlyMap<string, ChannelCheck>;
  slowChannelIds: ReadonlySet<string>;
  readonly browser: ChannelBrowser;
  catalogBrowseViewRevision: number;
  readonly contentLibrary: ContentLibrary;
  readonly accountBrowser: ReturnType<typeof createAccountBrowser>;
  readonly addChannelsEntryWork: Promise<void> | null;
  readonly startInlineDiscovery: (rescan?: boolean) => void;
  readonly playbackAction: (work: Promise<unknown>) => void;
}

export function createChannelHealthController(env: ChannelHealthEnvironment) {
  async function removeSavedChannel(id: string): Promise<void> {
    if (env.applicationClosing) throw new Error('Application closing.');
    if (/^archive-[a-f0-9]{64}$/u.test(id))
      throw new Error('GenXtra titles are managed separately from channels.');
    if (/^account-[a-f0-9]{32}-[a-f0-9]{64}$/u.test(id)) {
      const receipt = await env.writeAccountPreference({ kind: 'remove', channelId: id });
      try {
        if (env.player.snapshot.selection?.id === id) await env.accountPlayer!.stop();
        env.notice('Channel removed. You can restore it in Settings.');
      } catch {
        env.notice('Channel removed. Playback cleanup needs a retry.');
      }
      if (receipt.cleanupPending) env.notice('Channel removed. Playback cleanup needs a retry.');
      return;
    }
    if (isTauri()) {
      await env.editPublicChannelGroup(id, { kind: 'remove' });
      try {
        const selected = env.player.snapshot.selection?.id;
        if (selected && env.settings.removedChannels.includes(selected))
          await env.sharingBridge.stop();
        env.notice('Channel removed. You can restore removed channels in Settings.');
      } catch {
        env.notice('Channel removed, but playback cleanup needs attention.');
      }
      return;
    }
    const saved = await env.saveSettings((draft) => {
      if (!draft.removedChannels.includes(id)) draft.removedChannels.push(id);
    });
    if (!saved) throw new Error('Channel was not removed.');
    if (saved) {
      try {
        if (env.player.snapshot.selection?.id === id) await env.sharingBridge.stop();
        env.notice('Channel removed. You can restore removed channels in Settings.');
      } catch {
        env.notice(
          'Channel removed, but playback cleanup needs attention. Retry stopping playback.',
        );
      } finally {
        env.renderCatalog();
      }
    }
  }
  // The quiet saved-channel check (Free TV, native store only).
  const channelCheckStore = createChannelCheckStore();
  const savedChannelCheck = createSavedChannelCheck({
    channels: () => {
      const removed = new Set(env.settings.removedChannels);
      const allowHttp = new Map(
        env.catalog.sources.map((source) => [source.id, !!source.allowHttp]),
      );
      return env.catalog.channels
        .filter((channel) => !removed.has(channel.id) && channel.urls.length > 0)
        .map((channel) => ({
          id: channel.id,
          url: channel.urls[0],
          allowHttp: allowHttp.get(channel.sourceId) ?? false,
        }));
    },
    idle: () =>
      !env.applicationClosing &&
      env.element('app').dataset.ready === 'true' &&
      !document.hidden &&
      env.nativeViewingForeground &&
      env.scanController.healthPlatform !== null &&
      ['idle', 'paused', 'failed'].includes(env.player.snapshot.state) &&
      !env.scanController.automaticScanActive &&
      !env.sourceScan.snapshot().busy,
    read: (signal) => channelCheckStore.read(signal),
    record: (observations, signal) => channelCheckStore.record(observations, signal),
    probe: async (channel, signal) =>
      healthVerdict(await env.inspectStreamEvidence(channel.url, channel.allowHttp, signal, 20000)),
    changed: (checks, slow) => {
      env.channelCheckMarks = checks;
      adoptSlowChannels(slow);
      presentNotResponding();
    },
    wait: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, ms);
        signal.addEventListener(
          'abort',
          () => {
            window.clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  });
  let lastCheckPlayback: PlaybackSnapshot['state'] | null = null;
  /**
   * How long a saved Free TV channel takes from selection to playing sets or
   * clears its Slow badge (owner design, October 21, 2026): under 3 s clears it,
   * over 5 s sets it (native rule). Measured once per selection, page clock.
   */
  let channelStart: { id: string; at: number; recorded: boolean } | null = null;
  /**
   * Slow channels sort after fast ones (owner design, October 21, 2026). A
   * badge change advances the native list's view revision, so the list is read
   * again at once in the new order rather than paging with a refused cursor.
   */
  function adoptSlowChannels(ids: ReadonlySet<string>): void {
    const same =
      ids.size === env.slowChannelIds.size && [...ids].every((id) => env.slowChannelIds.has(id));
    env.browser.setSlow(ids);
    if (same) return;
    env.slowChannelIds = new Set(ids);
    env.catalogBrowseViewRevision++;
    if (!env.applicationClosing) env.browser.search(env.element<HTMLInputElement>('search').value);
  }
  env.player.subscribe((snapshot) => {
    const id = snapshot.selection?.id;
    if (!id || ['idle', 'failed', 'disposed'].includes(snapshot.state)) channelStart = null;
    else if (snapshot.state === 'connecting' && channelStart?.id !== id)
      channelStart = { id, at: performance.now(), recorded: false };
    else if (
      snapshot.state === 'playing' &&
      channelStart?.id === id &&
      !channelStart.recorded &&
      isTauri() &&
      env.catalog.channels.some((channel) => channel.id === id)
    ) {
      channelStart.recorded = true;
      const startMs = Math.round(performance.now() - channelStart.at);
      if (startMs <= 120_000)
        void channelCheckStore
          .recordStart(id, startMs, new AbortController().signal)
          .then((slow) => {
            if (slow !== null && slow !== env.slowChannelIds.has(id)) {
              const next = new Set(env.slowChannelIds);
              if (slow) next.add(id);
              else next.delete(id);
              adoptSlowChannels(next);
            }
            savedChannelCheck.poke();
          })
          .catch(() => undefined);
    }
  });
  env.player.subscribe((snapshot) => {
    const selected = snapshot.selection?.id;
    // A saved Free TV channel playing here is working: record it.
    if (
      snapshot.state === 'playing' &&
      lastCheckPlayback !== 'playing' &&
      selected &&
      env.catalog.channels.some((channel) => channel.id === selected)
    )
      savedChannelCheck.played(selected);
    if (snapshot.state !== lastCheckPlayback) savedChannelCheck.poke();
    lastCheckPlayback = snapshot.state;
  });
  let removingDeadChannels = false;
  /** Marks, the Not responding category and its Remove strip follow the newest checks. */
  function presentNotResponding(): void {
    const removed = new Set(env.settings.removedChannels);
    const ids = new Set<string>();
    for (const check of env.channelCheckMarks.values())
      if (check.notResponding && !removed.has(check.channelId)) ids.add(check.channelId);
    env.browser.setNotResponding(ids);
    const freeTv = env.contentLibrary === 'live' && !env.accountBrowser.selectedAccount;
    const offered = freeTv && ids.size > 0;
    const item = document.querySelector<HTMLButtonElement>('.filters [data-filter="unresponsive"]');
    const option = document.querySelector<HTMLOptionElement>(
      '#compact-filter option[value="unresponsive"]',
    );
    if (!item || !option) return;
    const chosen = item.getAttribute('aria-pressed') === 'true';
    item.hidden = !offered;
    item.dataset.count = ids.size.toLocaleString();
    option.hidden = option.disabled = !offered;
    option.textContent = `Not responding (${ids.size.toLocaleString()})`;
    env.element('dead-channels').hidden = !(offered && chosen);
    if (!removingDeadChannels) {
      env.element('dead-channels-text').textContent =
        `${ids.size.toLocaleString()} saved ${ids.size === 1 ? 'channel' : 'channels'} failed checks on two different days.`;
      env.element('remove-dead-channels').textContent =
        ids.size === 1 ? 'Remove it' : `Remove all ${ids.size.toLocaleString()}`;
    }
    // Nothing left to show (removed, recovered, or Paid TV): back to All.
    if (chosen && !offered && !removingDeadChannels)
      document.querySelector<HTMLButtonElement>('.filters [data-filter="all"]')?.click();
  }
  /**
   * Removes saved channels the quiet check confirmed Not responding (failed on
   * two different days). Refresh keeps favorites (owner decision, October 21,
   * 2026); the Not responding view's own button removes them all. Every removal
   * is the ordinary one, restorable in Settings.
   */
  async function removeDeadChannels(options: { keepFavorites?: boolean } = {}): Promise<number> {
    if (removingDeadChannels) return 0;
    const removed = new Set(env.settings.removedChannels);
    const favorites = new Set(options.keepFavorites ? env.settings.favorites : []);
    const ids = [...env.channelCheckMarks.values()]
      .filter(
        (check) =>
          check.notResponding && !removed.has(check.channelId) && !favorites.has(check.channelId),
      )
      .map((check) => check.channelId);
    if (!ids.length) return 0;
    removingDeadChannels = true;
    const button = env.element<HTMLButtonElement>('remove-dead-channels');
    button.disabled = true;
    try {
      // One native write and one list refresh per 5,001 channels (owner design,
      // October 21, 2026); each removal takes the channel's duplicates with it.
      for (let start = 0; start < ids.length; start += CATALOG_GROUP_BATCH_LIMIT + 1) {
        if (env.applicationClosing) break;
        const [first, ...more] = ids.slice(start, start + CATALOG_GROUP_BATCH_LIMIT + 1);
        env.element('dead-channels-text').textContent =
          `Removing ${ids.length.toLocaleString()} ${ids.length === 1 ? 'channel' : 'channels'}…`;
        await env.editPublicChannelGroup(first!, { kind: 'remove' }, more);
      }
      const selected = env.player.snapshot.selection?.id;
      if (selected && env.settings.removedChannels.includes(selected))
        await env.sharingBridge.stop();
      env.notice(
        `${ids.length.toLocaleString()} not responding ${ids.length === 1 ? 'channel' : 'channels'} removed. You can restore removed channels in Settings.`,
      );
    } finally {
      removingDeadChannels = false;
      button.disabled = false;
      presentNotResponding();
    }
    return ids.length;
  }
  /**
   * Refresh (owner request, October 21, 2026): remove the channels the daily
   * check confirmed dead (favorites kept), then look for new channels only.
   * The scan's Refresh mode checks just what is due: never-seen streams, and
   * failures past their trust window (source_snapshot_activation.rs). Rescan
   * still checks everything from scratch.
   */
  async function refreshFreeTv(): Promise<void> {
    if (env.applicationClosing || env.addChannelsEntryWork) return;
    await removeDeadChannels({ keepFavorites: true });
    env.startInlineDiscovery(false);
  }
  env
    .element('remove-dead-channels')
    .addEventListener('click', () =>
      env.playbackAction(removeDeadChannels().then(() => undefined)),
    );
  env.element('remove-channel').addEventListener('click', () => {
    const id = env.player.snapshot.selection?.id;
    if (id) env.playbackAction(removeSavedChannel(id));
  });
  return {
    channelCheckStore,
    savedChannelCheck,
    removeSavedChannel,
    presentNotResponding,
    refreshFreeTv,
  };
}
