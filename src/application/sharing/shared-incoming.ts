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
 * A link someone shared with this viewer (docs/share-links.md). It is checked
 * like a scanned source (src/sharing/share-link.ts), its server must be public
 * (check_shared_destination), and the card offers Play and Add to favorites:
 * nothing plays or is saved until one is chosen. Before playing or saving, the
 * stream is checked once more, so an expired, moved or region-locked channel
 * gets a plain explanation instead of a silent failure.
 */
import { exportPreferences } from '../../preferences';
import { parseM3u, serializeCatalog, validateSource, type Channel } from '../../catalog';
import { writeRecordPair } from '../../platform/records';
import { inspectCheckedMediaSource } from '../../sources/media-preflight';
import { checkSharedDestination, shareFailureCode } from '../../platform/share-sheet';
import {
  parseShareLink,
  shareRefusalMessage,
  ShareLinkError,
  type SharedItem,
} from '../../sharing/share-link';
import { type mountShareCard } from '../../ui/sharing/share-card';
import { type ShareLinksEnvironment } from './share-links';

type Card = ReturnType<typeof mountShareCard>;
type SharedChannel = Extract<SharedItem, { kind: 'channel' }>;
type SharedTitle = Extract<SharedItem, { kind: 'title' }>;

/** A shared stream that is not in the saved channels: playable while GenX runs. */
export interface SharedPlayable {
  id: string;
  name: string;
  urls: string[];
}

/** What a stream check means for the viewer, in plain words (null: it can be tried). */
export function streamCheckMessage(name: string, outcome: { status?: number; error?: string }) {
  const status = outcome.status ?? 0;
  if (status === 404 || status === 410)
    return `${name} is no longer at the shared address. The channel may have moved or ended; ask for a new link.`;
  if (status === 401 || status === 403 || status === 451)
    return `${name}'s provider refused this device. Some channels only play in certain countries, or need a fresh link.`;
  if (status >= 500 || status === 429)
    return `${name}'s server is not answering properly right now. Try again later.`;
  if (status >= 400) return `${name} could not be opened (the server answered ${status}).`;
  switch (outcome.error) {
    case undefined:
      return null;
    case 'dns-failure':
    case 'share-destination-unresolved':
      return `${name}'s server could not be found. The link may be out of date, or the server is down.`;
    case 'timeout':
      return `${name}'s server did not answer in time. Try again later.`;
    case 'share-destination-private':
      return shareRefusalMessage('share-stream-private');
    case 'unsupported':
      return `${name} is not a stream GenX Streamer can play.`;
    default:
      return `${name} could not be reached. Check your connection and try again.`;
  }
}

/** Stable, opaque id for a shared stream (never the address itself). */
async function sharedId(stream: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stream));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `shared-${hex.slice(0, 32)}`;
}

export function createSharedIncoming(env: ShareLinksEnvironment, card: Card) {
  const playable = new Map<string, SharedPlayable>();
  let generation = 0;

  const savedChannel = (stream: string): Channel | undefined => {
    const removed = new Set(env.settings.removedChannels);
    return env.catalog.channels.find((c) => !removed.has(c.id) && c.urls.includes(stream));
  };

  /** Checks the stream now: its server is public and it answers as something playable. */
  async function checkStream(item: SharedChannel) {
    try {
      await checkSharedDestination(item.stream);
    } catch (error) {
      return { message: streamCheckMessage(item.name, { error: shareFailureCode(error) }) };
    }
    try {
      const inspection = await inspectCheckedMediaSource(
        item.stream,
        item.stream.startsWith('http:'),
        AbortSignal.timeout(30_000),
      );
      if (inspection.status >= 400)
        return { message: streamCheckMessage(item.name, { status: inspection.status }) };
      if (inspection.kind !== 'hls' && inspection.kind !== 'media')
        return { message: streamCheckMessage(item.name, { error: 'unsupported' }) };
      return { message: null, inspection };
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      return { message: streamCheckMessage(item.name, { error: code }) };
    }
  }

  async function playChannel(item: SharedChannel, owner: number) {
    card.busy(true);
    card.say(`Checking ${item.name}…`);
    const checked = await checkStream(item);
    if (owner !== generation || env.applicationClosing) return;
    card.busy(false);
    if (checked.message) {
      card.say(checked.message);
      return;
    }
    const saved = savedChannel(item.stream);
    const id = saved?.id ?? (await sharedId(item.stream));
    if (!saved) playable.set(id, { id, name: item.name, urls: [item.stream] });
    card.close();
    env.playbackAction(
      (async () => {
        if (env.library.contentLibrary !== 'live') await env.switchLibrary('live');
        env.presentPrimaryPage('watch');
        await env.sharingBridge.select({ id, name: saved?.name ?? item.name, url: item.stream });
      })(),
    );
  }

  /** Saves the shared stream as its own one-channel source (what adding it by address makes), then favorites it. */
  async function favoriteChannel(item: SharedChannel, owner: number) {
    const saved = savedChannel(item.stream);
    if (saved) {
      if (!env.settings.favorites.includes(saved.id)) env.toggleChannelFavorite(saved.id);
      card.close();
      env.notice(`${saved.name} is in your favorites.`);
      return;
    }
    if (env.importRunning || env.transferBusy) {
      card.say('Finish the current import, then choose Add to favorites again.');
      return;
    }
    card.busy(true);
    card.say(`Checking ${item.name}…`);
    const checked = await checkStream(item);
    if (owner !== generation || env.applicationClosing) return;
    if (checked.message || !checked.inspection) {
      card.busy(false);
      card.say(checked.message ?? streamCheckMessage(item.name, { error: 'unsupported' })!);
      return;
    }
    const source = validateSource({
      id: crypto.randomUUID(),
      name: item.name,
      location: item.stream,
      kind: 'url',
      allowHttp: item.stream.startsWith('http:'),
      contentKind: checked.inspection.kind,
      ...(checked.inspection.mime ? { mediaMime: checked.inspection.mime } : {}),
    });
    // The same one-entry playlist a refresh of this source writes (catalog-refresh.ts),
    // so a later refresh keeps the channel and its favorite.
    const playlist = `#EXTM3U\n#EXTINF:-1 tvg-id="direct" group-title="Custom",${source.name}\n${source.location}\n`;
    const candidate = parseM3u(playlist, source.id).channels[0];
    if (!candidate) {
      card.busy(false);
      card.say(streamCheckMessage(item.name, { error: 'unsupported' })!);
      return;
    }
    const channel: Channel = { ...candidate, id: crypto.randomUUID() };
    try {
      const work = env.catalogWrites.then(async () => {
        const next = {
          ...env.catalog,
          sources: [...env.catalog.sources, source],
          channels: [...env.catalog.channels, channel],
        };
        const nextPreferences = await env.preferences.settledSnapshot();
        nextPreferences.sources = [...next.sources];
        env.settings = await env.preferences.replaceAtomically(nextPreferences, async () => {
          const receipt = await writeRecordPair({
            catalog: serializeCatalog(next),
            preferences: exportPreferences(nextPreferences),
            expectedCatalogRevision: env.persistedCatalogRevision,
          });
          env.persistedCatalogRevision = receipt.catalogRevision;
        });
        env.catalog = next;
        env.catalogRevision++;
      });
      env.catalogWrites = work.catch(() => undefined);
      await work;
    } catch {
      if (owner !== generation) return;
      card.busy(false);
      card.say(`${item.name} could not be saved. Try again.`);
      return;
    }
    if (env.applicationClosing) return;
    env.applySettings();
    env.toggleChannelFavorite(channel.id);
    if (owner === generation) card.close();
    env.notice(`${item.name} was added to your channels and favorites.`);
  }

  /** Opens GenXtra on the shared title: the title's first playable file, or a search for it. */
  async function openTitle(item: SharedTitle, owner: number, favorite: boolean) {
    card.busy(true);
    card.say(`Looking for ${item.name} in GenXtra…`);
    await env.switchLibrary('genxtra');
    if (owner !== generation || env.applicationClosing) return;
    const revision = env.library.archiveIndexRevision;
    let file: { fileRef: string; title: string } | undefined;
    if (revision !== null) {
      try {
        const page = await env.archiveCatalog.files({
          schemaVersion: 1,
          titleRef: item.titleRef,
          expectedRevision: revision,
          offset: 0,
          pageSize: 50,
        });
        file = page.files.find(
          (entry) =>
            entry.availability !== 'dead' && entry.providerFacts?.playbackCandidate !== false,
        );
      } catch {
        file = undefined;
      }
    }
    if (owner !== generation || env.applicationClosing) return;
    card.busy(false);
    if (!file || revision === null) {
      // Truthful: the title is not in this library (yet); show what a search finds.
      env.libraryQueries.genxtra = item.name;
      env.element<HTMLInputElement>('search').value = item.name;
      card.close();
      env.notice(
        `${item.name} is not in your GenXtra library yet. Showing what a search finds; search online to look further.`,
      );
      void env.archiveSearch?.query(item.name);
      return;
    }
    if (favorite) {
      try {
        const receipt = await env.archiveCatalog.setFavorite({
          schemaVersion: 1,
          titleRef: item.titleRef,
          expectedRevision: revision,
          value: true,
        });
        env.recordArchiveRevision(receipt.revision);
        card.close();
        env.notice(`${item.name} is in your GenXtra favorites.`);
        void env.archiveSearch?.query();
      } catch {
        card.say(`${item.name} could not be added to favorites. Try again.`);
      }
      return;
    }
    card.close();
    env.recordArchiveRevision(revision);
    env.clearArchiveResume();
    const abort = new AbortController();
    env.playbackAction(
      env.archivePlayer!.select(
        {
          titleRef: item.titleRef,
          fileRef: file.fileRef,
          expectedRevision: revision,
          title: item.name,
          fileTitle: file.title,
        },
        abort.signal,
      ),
    );
  }

  /** Shows the card for an incoming link; nothing plays until the viewer chooses. */
  async function receive(raw: string): Promise<void> {
    const owner = ++generation;
    let item: SharedItem;
    try {
      item = parseShareLink(raw);
    } catch (error) {
      card.show({
        title: 'This link cannot be opened',
        message: shareRefusalMessage(error instanceof ShareLinkError ? error.code : ''),
        actions: [{ label: 'Close', run: card.close }],
      });
      return;
    }
    const title = `${item.name} was shared with you`;
    if (item.kind === 'title') {
      card.show({
        title,
        message: 'A public-domain title from GenXtra.',
        actions: [
          { label: 'Play', run: () => void openTitle(item, owner, false) },
          { label: 'Add to favorites', run: () => void openTitle(item, owner, true) },
        ],
      });
      return;
    }
    const actions = [
      { label: 'Play', run: () => void playChannel(item, owner) },
      { label: 'Add to favorites', run: () => void favoriteChannel(item, owner) },
    ];
    card.show({ title, message: `Checking ${item.name}…`, actions });
    card.busy(true);
    // The logo is fetched only after its server is known to be public.
    const [stream, logo] = await Promise.allSettled([
      checkSharedDestination(item.stream),
      item.logo ? checkSharedDestination(item.logo) : Promise.reject(new Error('no-logo')),
    ]);
    if (owner !== generation || !card.open) return;
    if (stream.status === 'rejected') {
      const message = streamCheckMessage(item.name, { error: shareFailureCode(stream.reason) });
      card.show({
        title,
        message: message ?? undefined,
        actions: [{ label: 'Close', run: card.close }],
      });
      return;
    }
    card.show({
      title,
      logo: logo.status === 'fulfilled' ? item.logo : null,
      message: 'A free channel. Choose Play to watch it now.',
      actions,
    });
  }

  return {
    receive,
    /** A shared stream being played (sharing-host extraChannel). */
    channel: (id: string) => playable.get(id),
    /** Plain-HTTP playback only for a shared stream the viewer chose to play. */
    allowsHttp: (url: string) =>
      url.startsWith('http://') && [...playable.values()].some((entry) => entry.urls[0] === url),
    /** The shared item behind a playing shared stream, so it can be shared on. */
    sharedItem(id: string): SharedChannel | undefined {
      const entry = playable.get(id);
      return entry
        ? { kind: 'channel', name: entry.name, stream: entry.urls[0]!, logo: null }
        : undefined;
    },
  };
}
