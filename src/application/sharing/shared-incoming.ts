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
import {
  parseShareLink,
  shareRefusalMessage,
  ShareLinkError,
  type SharedItem,
} from '../../sharing/share-link';
import { type mountShareCard } from '../../ui/sharing/share-card';
import { type ShareLinksEnvironment } from './share-links';

type Card = ReturnType<typeof mountShareCard>;
type SharedTitle = Extract<SharedItem, { kind: 'title' }>;

export function createSharedIncoming(env: ShareLinksEnvironment, card: Card) {
  let generation = 0;
  const savedChannel = (stream: string) => {
    const removed = new Set(env.settings.removedChannels);
    return env.catalog.channels.find(
      (channel) => !removed.has(channel.id) && channel.urls.includes(stream),
    );
  };

  async function playChannel(stream: string, owner: number) {
    if (env.library.contentLibrary !== 'live') await env.switchLibrary('live');
    if (owner !== generation || env.applicationClosing || !card.open) return;
    const channel = savedChannel(stream);
    if (!channel) {
      card.say('This channel is no longer saved on this device.');
      return;
    }
    card.close();
    env.presentPrimaryPage('watch');
    await env.sharingBridge.select({ id: channel.id, name: channel.name, url: stream });
  }

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
  function receive(raw: string): void {
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
    const channel = savedChannel(item.stream);
    if (!channel) {
      card.show({
        title,
        message:
          'Find this channel in Free TV, then open the link again to play it or add it to favorites.',
        actions: [{ label: 'Close', run: card.close }],
      });
      return;
    }
    card.show({
      title: `${channel.name} was shared with you`,
      message: 'This channel is saved on this device.',
      actions: [
        { label: 'Play', run: () => env.playbackAction(playChannel(item.stream, owner)) },
        {
          label: 'Add to favorites',
          run: () => {
            if (owner !== generation || env.applicationClosing) return;
            const current = savedChannel(item.stream);
            if (!current) {
              card.say('This channel is no longer saved on this device.');
              return;
            }
            const favorite =
              env.pendingChannelFavorite(current.id) ?? env.settings.favorites.includes(current.id);
            if (!favorite) env.toggleChannelFavorite(current.id);
            card.close();
          },
        },
      ],
    });
  }

  return { receive };
}
