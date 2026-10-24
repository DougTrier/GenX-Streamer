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

import type { AccountMetadata } from '../../platform/account-vault';
import type {
  AccountGuide,
  AccountGuideChannel,
  AccountGuideStatus,
} from '../../platform/account-guide';
import type { GuideCursor, MappedProgram } from '../../guide/native';
import { mountGuideTimeline } from './guide-timeline';
import { PANEL_AGENDA_WIDTH, type TimelineChannel } from './guide-timeline-model';

/** A stored guide older than this is downloaded again when the guide opens. */
export const PAID_GUIDE_STALE_MS = 12 * 3_600_000;

export interface PaidGuideHost {
  guide: Pick<AccountGuide, 'refresh' | 'status' | 'channels' | 'listed' | 'programs'>;
  /** Play this Paid TV channel (its opaque playback reference, never a URL). */
  watch(channel: AccountGuideChannel, signal: AbortSignal): Promise<void>;
  /** The viewer closed the guide. */
  close(): void;
  now(): number;
  formatTime(ms: number): string;
}

/** Plain words for native refusal codes; never a provider address or payload. */
export function paidGuideFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code.includes('account-guide-not-offered'))
    return "Your provider doesn't offer a program guide for this account.";
  if (code.includes('account-guide-no-ids'))
    return 'Your provider gives these channels no guide IDs, so listings cannot be matched.';
  if (code.includes('account-guide-busy')) return 'The guide is already updating.';
  if (code.includes('account-guide-too-large') || code.includes('account-response-too-large'))
    return "Your provider's guide is larger than GenX can store.";
  if (code.includes('account-guide-malformed') || code.includes('account-guide-encoding'))
    return "Your provider's guide file is damaged or incomplete.";
  if (code.includes('account-guide-storage'))
    return 'There is not enough space on this device to store the guide.';
  if (code.includes('account-authentication-refused')) return 'Your provider refused the sign-in.';
  if (code.includes('account-rate-limited'))
    return 'Your provider is limiting requests. Try again in a few minutes.';
  if (code.includes('account-timeout')) return 'Your provider took too long to send the guide.';
  if (code.includes('account-dns') || code.includes('account-network') || code.includes('tls'))
    return "Your provider's server could not be reached.";
  if (code.includes('account-revision-conflict'))
    return 'The account changed while the guide was downloading. Open the guide again.';
  return "Your provider's guide could not be downloaded.";
}
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function mountPaidGuide(container: HTMLElement, host: PaidGuideHost) {
  const doc = container.ownerDocument;
  const root = doc.createElement('section');
  root.className = 'paid-guide';
  root.setAttribute('aria-label', 'Paid TV guide');
  root.hidden = true;
  const header = doc.createElement('div');
  header.className = 'paid-guide-head';
  const title = doc.createElement('h2');
  title.textContent = 'Paid TV guide';
  const status = doc.createElement('p');
  status.className = 'paid-guide-status';
  status.setAttribute('role', 'status');
  const update = doc.createElement('button');
  update.type = 'button';
  update.textContent = 'Update guide';
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = 'Close guide';
  header.append(title, status, update, close);
  // One line beside the title: the whole message stays in the tooltip.
  const setStatus = (text: string) => {
    status.textContent = text;
    status.title = text;
  };
  const panel = doc.createElement('div');
  panel.className = 'paid-guide-timeline';
  root.append(header, panel);
  container.append(root);

  let account: AccountMetadata | null = null;
  let stored: AccountGuideStatus | null = null;
  let channels: TimelineChannel[] = [];
  let rows = new Map<string, AccountGuideChannel>();
  const play = (id: string, signal: AbortSignal) => {
    const row = rows.get(id);
    if (!row) return Promise.reject(new Error('This channel is no longer available.'));
    return host.watch(row, signal);
  };
  let owner: AbortController | null = null;
  let disposed = false;
  const source = () => `account:${account?.id ?? ''}`;
  const revision = () => `${account?.id ?? ''}:${account?.revision ?? ''}:${stored?.revision ?? 0}`;
  const describe = (s: AccountGuideStatus) => {
    const parts = [
      `Guide from ${host.formatTime(s.fetchedMs)}`,
      `${s.channels} ${s.channels === 1 ? 'channel' : 'channels'} with listings`,
    ];
    if (s.skipped)
      parts.push(`${s.skipped} unusable ${s.skipped === 1 ? 'listing' : 'listings'} left out`);
    return parts.join(' · ');
  };

  const timeline = mountGuideTimeline(panel, {
    initiallyForeground: false,
    agendaWidth: PANEL_AGENDA_WIDTH,
    channels: () => channels,
    catalogRevision: revision,
    async listedChannels(start, end, signal, search) {
      const current = account;
      if (!current || !stored) throw new Error('Paid TV guide is not loaded.');
      const reply = await host.guide.listed(current, start, end, search ?? '', signal);
      if (reply.revision !== stored.revision) throw new Error('Paid TV guide changed.');
      const listed = new Set(reply.epgIds);
      return {
        catalogRevision: revision(),
        databaseRevision: stored.revision,
        channels: channels
          .filter((channel) => listed.has(channel.xmltvChannelId!))
          .map((channel) => ({
            catalogSourceId: channel.sourceId,
            appChannelId: channel.id,
            guideSourceId: channel.guideSourceId!,
            xmltvChannelId: channel.xmltvChannelId!,
            sourceRevision: stored!.revision,
          })),
      };
    },
    async query(query, signal) {
      const current = account;
      const channel = channels.find((entry) => entry.id === query.appChannelIds[0]);
      if (!current || !stored || !channel || query.appChannelIds.length !== 1)
        throw new Error('Paid TV guide channel is unavailable.');
      const after = query.cursor
        ? { startMs: query.cursor.startMs, ordinal: query.cursor.ordinal }
        : null;
      const pageSize = Math.min(50, query.pageSize);
      const reply = await host.guide.programs(
        current,
        channel.xmltvChannelId!,
        query.windowStartMs,
        query.windowEndMs,
        after,
        pageSize,
        signal,
      );
      if (reply.revision !== stored.revision) throw new Error('Paid TV guide changed.');
      const programs: MappedProgram[] = reply.programs.map((program) => ({
        catalogSourceId: channel.sourceId,
        appChannelId: channel.id,
        guideSourceId: channel.guideSourceId!,
        xmltvChannelId: channel.xmltvChannelId!,
        startMs: program.startMs,
        stopMs: program.stopMs,
        title: program.title,
        description: program.description,
        categories: program.categories,
        ordinal: program.ordinal,
      }));
      const last = programs.at(-1);
      const nextCursor: GuideCursor | null =
        last && programs.length === pageSize
          ? {
              queryKey: JSON.stringify([channel.id, query.windowStartMs, query.windowEndMs]),
              guideSourceId: channel.guideSourceId!,
              sourceRevision: stored.revision,
              databaseRevision: stored.revision,
              startMs: last.startMs,
              ordinal: last.ordinal,
              appChannelId: channel.id,
            }
          : null;
      return {
        programs,
        nextCursor,
        sourceRevision: stored.revision,
        databaseRevision: stored.revision,
      };
    },
    watch: (channel, signal) => play(channel.id, signal),
    channelActivate: (channel) => {
      const work = new AbortController();
      void play(channel.id, work.signal).catch((error: unknown) => {
        if (!aborted(error)) setStatus(`${channel.name} could not start.`);
      });
    },
    now: () => host.now(),
    formatTime: (ms) => host.formatTime(ms),
    formatAxisTime: (ms) =>
      new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(ms),
  });

  async function load(forceDownload: boolean, signal: AbortSignal): Promise<void> {
    const current = account!;
    setStatus("Checking your provider's guide…");
    stored = await host.guide.status(current, signal);
    const stale = !stored || host.now() - stored.fetchedMs > PAID_GUIDE_STALE_MS;
    if (forceDownload || stale) {
      setStatus("Downloading your provider's guide… This can take a minute.");
      update.disabled = true;
      try {
        stored = await host.guide.refresh(current, signal);
      } catch (error) {
        if (aborted(error) || signal.aborted) throw error;
        const reason = paidGuideFailure(error);
        // The last good guide stays (XC-036).
        stored = await host.guide.status(current, signal).catch(() => stored);
        if (!stored) {
          channels = [];
          rows = new Map();
          setStatus(`${reason} Use Update guide to try again.`);
          await timeline.setForeground(true);
          return;
        }
        setStatus(`${reason} Showing the guide from ${host.formatTime(stored.fetchedMs)}.`);
      } finally {
        update.disabled = false;
      }
    }
    const loaded = await host.guide.channels(current, signal);
    rows = new Map(loaded.map((row) => [row.id, row]));
    channels = loaded.map((row) => ({
      id: row.id,
      sourceId: source(),
      name: row.name,
      category: row.category,
      favorite: row.favorite,
      guideSourceId: source(),
      xmltvChannelId: row.epgId,
      guideRevision: stored!.revision,
    }));
    if (!status.textContent?.includes('Showing the guide from')) setStatus(describe(stored!));
    await timeline.setForeground(true);
  }
  function run(forceDownload: boolean): Promise<void> {
    owner?.abort();
    const work = new AbortController();
    owner = work;
    return load(forceDownload, work.signal).catch((error: unknown) => {
      if (aborted(error) || work.signal.aborted) return;
      setStatus(paidGuideFailure(error));
    });
  }
  update.addEventListener('click', () => {
    if (account) void run(true);
  });
  close.addEventListener('click', () => host.close());

  return {
    get open() {
      return !root.hidden;
    },
    /** Show the guide for this account, downloading it if missing or stale. */
    async show(target: AccountMetadata): Promise<void> {
      if (disposed) return;
      if (account?.id !== target.id || account.revision !== target.revision) {
        stored = null;
        channels = [];
        rows = new Map();
      }
      account = target;
      title.textContent = `Paid TV guide · ${target.name}`;
      root.hidden = false;
      await run(false);
    },
    async hide(): Promise<void> {
      owner?.abort();
      owner = null;
      root.hidden = true;
      await timeline.setForeground(false);
    },
    focus() {
      update.focus({ preventScroll: true });
    },
    async dispose() {
      disposed = true;
      owner?.abort();
      await timeline.dispose();
      root.remove();
    },
  };
}
