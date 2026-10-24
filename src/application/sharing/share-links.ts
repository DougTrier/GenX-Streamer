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
 * Share what I'm watching (docs/share-links.md): the Share button beside the
 * playing channel opens the system share sheet with "Watch News 24 on GenX
 * Streamer: <link>", and links others shared open the share card
 * (shared-incoming.ts). Free TV channels and GenXtra titles only: Paid TV
 * never gets a Share button, and the link builder refuses account addresses.
 */
import { type CatalogRecord } from '../../catalog';
import { type Preferences, type SerializedPreferencesStore } from '../../preferences';
import { type PlaybackController } from '../../playback/controller';
import {
  buildShareMessage,
  shareRefusalMessage,
  ShareLinkError,
  type SharedItem,
} from '../../sharing/share-link';
import {
  copyText,
  onIncomingLink,
  shareFailureCode,
  shareText,
  takeIncomingLink,
} from '../../platform/share-sheet';
import { mountShareCard } from '../../ui/sharing/share-card';
import { type createArchiveCatalog } from '../../platform/archive-catalog';
import { type createSharingHost } from './sharing-host';
import { type createAccountPlayer } from '../accounts/account-player';
import { type createArchivePlayer } from '../genxtra/archive-player';
import { type createLibraryState } from '../genxtra/library-state';
import { type createLibraryController } from '../genxtra/library-controller';
import { type ContentLibrary } from '../genxtra/content-library';
import { type mountArchiveSearch } from '../../ui/genxtra/archive-search';
import { createSharedIncoming } from './shared-incoming';

/** What this area reads from, and writes back to, the rest of the application. */
export interface ShareLinksEnvironment {
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly player: PlaybackController;
  readonly accountPlayer: ReturnType<typeof createAccountPlayer> | undefined;
  readonly accountVodSelected: () => boolean;
  readonly archivePlayer: ReturnType<typeof createArchivePlayer> | undefined;
  readonly archiveCatalog: ReturnType<typeof createArchiveCatalog>;
  readonly archiveSearch: ReturnType<typeof mountArchiveSearch> | undefined;
  readonly library: ReturnType<typeof createLibraryState>;
  readonly libraryQueries: Record<ContentLibrary, string>;
  readonly switchLibrary: ReturnType<typeof createLibraryController>['switchLibrary'];
  readonly recordArchiveRevision: (revision: string) => void;
  readonly clearArchiveResume: () => void;
  readonly presentPrimaryPage: (page: 'watch') => void;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
  readonly playbackAction: (work: Promise<unknown>) => void;
  readonly toggleChannelFavorite: (id: string) => void;
  readonly applySettings: () => void;
  readonly notice: (message: string) => void;
  readonly preferences: SerializedPreferencesStore;
  readonly applicationClosing: boolean;
  readonly importRunning: boolean;
  readonly transferBusy: boolean;
  settings: Preferences;
  catalog: CatalogRecord;
  catalogWrites: Promise<unknown>;
  persistedCatalogRevision: string;
  catalogRevision: number;
}

const ACCOUNT_ID = /^account-[a-f0-9]{32}-[a-f0-9]{64}$/u;

export function createShareLinks(env: ShareLinksEnvironment) {
  const card = mountShareCard(env.element('app'), copyText);
  const incoming = createSharedIncoming(env, card);
  const button = env.element<HTMLButtonElement>('share-channel');

  /** Paid TV is selected or playing: no Share button at all. */
  const paidTv = () =>
    !!env.accountPlayer?.selection ||
    env.accountVodSelected() ||
    ACCOUNT_ID.test(env.player.snapshot.selection?.id ?? '');

  /** What may be shared from the player now: a Free TV channel or a GenXtra title, or nothing. */
  function subject(): SharedItem | null {
    if (paidTv()) return null;
    const selection = env.player.snapshot.selection;
    if (!selection) return null;
    const title = env.archivePlayer?.selection;
    if (selection.playMode === 'on-demand')
      return title ? { kind: 'title', name: title.title, titleRef: title.titleRef } : null;
    const shared = incoming.sharedItem(selection.id);
    if (shared) return shared;
    const channel = env.catalog.channels.find((entry) => entry.id === selection.id);
    if (!channel || !env.catalog.sources.some((source) => source.id === channel.sourceId))
      return null;
    // The saved (playlist) address, never one a server handed this device for its session.
    const stream = channel.urls.includes(selection.url) ? selection.url : channel.urls[0];
    return stream ? { kind: 'channel', name: channel.name, stream, logo: null } : null;
  }

  function render(): void {
    const paid = paidTv();
    if (button.hidden !== paid) button.hidden = paid;
    const disabled = paid || subject() === null;
    if (button.disabled !== disabled) button.disabled = disabled;
  }

  let sharing = false;
  async function shareCurrent(): Promise<void> {
    const item = subject();
    if (!item || sharing || env.applicationClosing) return;
    let message: ReturnType<typeof buildShareMessage>;
    try {
      message = buildShareMessage(item);
    } catch (error) {
      env.notice(shareRefusalMessage(error instanceof ShareLinkError ? error.code : ''));
      return;
    }
    // The card: the code to scan (a TV across the room, a phone beside you), the
    // link to copy, and Send through the share sheet.
    const send = async () => {
      if (sharing) return;
      sharing = true;
      try {
        await shareText(message.title, message.text);
        card.close();
      } catch (error) {
        const code = shareFailureCode(error);
        // The viewer closed a browser share, or GenX went to the background: nothing to say.
        if (
          code === 'share-background' ||
          (error instanceof DOMException && error.name === 'AbortError')
        )
          return;
        card.say(
          code === 'share-no-target'
            ? 'No app on this device can send links. Scan the code or copy the link.'
            : 'The share sheet is not available here. Scan the code or copy the link.',
        );
      } finally {
        sharing = false;
      }
    };
    card.show({
      title: `Share ${message.title}`,
      message: `Watch ${message.title} on GenX Streamer: scan the code, copy the link, or send it.`,
      link: message.link,
      qr: message.link,
      actions: [
        { label: 'Send…', run: () => void send() },
        { label: 'Close', run: card.close },
      ],
    });
  }
  button.addEventListener('click', () => void shareCurrent());
  const unsubscribe = env.player.subscribe(render);
  render();

  // Incoming links wait until the saved channels are ready, then show the card.
  let draining: Promise<void> | null = null;
  const app = env.element('app');
  const ready = () => app.dataset.ready === 'true';
  function drain(): void {
    if (!ready() || draining || env.applicationClosing) return;
    draining = (async () => {
      for (let link = await takeIncomingLink().catch(() => null); link;) {
        await incoming.receive(link);
        link = await takeIncomingLink().catch(() => null);
      }
    })().finally(() => {
      draining = null;
    });
  }
  const readiness = new MutationObserver(drain);
  readiness.observe(app, { attributes: true, attributeFilter: ['data-ready'] });
  const stopListening = onIncomingLink(drain);
  drain();

  return {
    render,
    channel: incoming.channel,
    allowsHttp: incoming.allowsHttp,
    dispose() {
      readiness.disconnect();
      stopListening();
      unsubscribe();
      card.dispose();
    },
  };
}
