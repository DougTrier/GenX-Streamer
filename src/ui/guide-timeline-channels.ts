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
  validateChannelCoverageReply,
  type ChannelCoverageRequest,
} from '../guide/channel-coverage';
import { describeChannelCoverage } from '../guide/coverage-presentation';
import { ChannelCoverageCleanupError } from '../guide/native';
import {
  WEEK,
  aborted,
  channelKey,
  type TimelineChannel,
  type TimelineHost,
} from './guide-timeline-model';

/** What this part reads from, and writes back to, mountGuideTimeline. */
export interface TimelineChannelsEnvironment {
  readonly host: TimelineHost;
  readonly doc: Document;
  readonly closed: boolean;
  readonly foreground: boolean;
  readonly channelCards: Map<HTMLButtonElement, TimelineChannel>;
  readonly viewport: HTMLDivElement;
  readonly browseChannel: HTMLButtonElement;
  readonly root: HTMLElement;
  indexedChannels: readonly TimelineChannel[] | null;
  channelIndex: Map<string, TimelineChannel>;
  readonly button: (label: string, action: () => void) => HTMLButtonElement;
  readonly launch: (job: Promise<void>) => Promise<void>;
  cleanupError: unknown;
  readonly report: () => void;
  readonly details: HTMLElement;
}

/**
 * The timeline guide's channel cards, their artwork, and the week of
 * listings each channel covers. Part of mountGuideTimeline.
 */
export function createTimelineChannels(env: TimelineChannelsEnvironment) {
  function channelArtwork(card: HTMLButtonElement, channel: TimelineChannel): void {
    const artwork = card.querySelector<HTMLElement>('.media-result-artwork');
    if (!artwork) return;
    const fallback =
      (channel.name.match(/[\p{L}\p{N}]+/gu) ?? [])
        .slice(0, 2)
        .map((word) => Array.from(word)[0])
        .join('')
        .toUpperCase() || 'TV';
    artwork.dataset.artwork = 'fallback';
    artwork.textContent = fallback;
    const logo = env.host.logos?.get(channel);
    // Artwork is supplied by the admitted native logo owner, never playlist URLs.
    if (
      !logo ||
      logo.length > 350000 ||
      !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(logo)
    )
      return;
    const image = env.doc.createElement('img');
    image.className = 'channel-logo-image';
    image.alt = '';
    image.decoding = 'async';
    image.addEventListener(
      'error',
      () => {
        if (
          env.closed ||
          !env.foreground ||
          !card.isConnected ||
          image.parentElement !== artwork ||
          env.channelCards.get(card) !== channel
        )
          return;
        env.host.logos?.rejected(channel);
        artwork.dataset.artwork = 'fallback';
        artwork.textContent = fallback;
      },
      { once: true },
    );
    image.src = logo;
    artwork.dataset.artwork = 'logo';
    artwork.replaceChildren(image);
  }
  function channelCard(
    card: HTMLButtonElement,
    channel: TimelineChannel,
    label = channel.name,
  ): void {
    card.setAttribute('aria-label', label);
    const artwork = env.doc.createElement('span');
    artwork.className = 'monogram media-result-artwork';
    artwork.setAttribute('aria-hidden', 'true');
    const category = (channel.category ?? '').toLowerCase();
    artwork.dataset.category =
      ['news', 'sports', 'movies', 'kids', 'nature', 'food', 'history'].find((c) =>
        category.includes(c),
      ) ?? 'other';
    const copy = env.doc.createElement('span');
    copy.className = 'media-result-copy';
    const name = env.doc.createElement('strong');
    name.className = 'media-result-title';
    name.textContent = channel.name;
    const meta = env.doc.createElement('small');
    meta.className = 'media-result-subtitle';
    meta.textContent = channel.category || 'Live channel';
    copy.append(name, meta);
    card.replaceChildren(artwork, copy);
    env.channelCards.set(card, channel);
    channelArtwork(card, channel);
  }
  function refreshArtwork(): void {
    if (env.closed || !env.foreground) return;
    for (const [card, channel] of env.channelCards)
      if (card.isConnected && currentChannel(channel)) channelArtwork(card, channel);
  }
  function visibleArtwork(): void {
    const bounds = env.viewport.getBoundingClientRect();
    const visible: TimelineChannel[] = [];
    if (
      !env.closed &&
      env.foreground &&
      env.viewport.getClientRects().length &&
      bounds.width > 0 &&
      bounds.height > 0
    )
      for (const [card, channel] of env.channelCards) {
        const box = card.getBoundingClientRect();
        const frame = card === env.browseChannel ? env.root.getBoundingClientRect() : bounds;
        if (
          card.isConnected &&
          box.bottom > Math.max(0, frame.top) &&
          box.top < Math.min(innerHeight, frame.bottom) &&
          box.right > frame.left &&
          box.left < frame.right
        )
          visible.push(channel);
      }
    env.host.logos?.visible(visible.slice(0, 32));
  }
  const currentChannel = (channel: TimelineChannel) => {
    const channels = env.host.channels();
    if (channels !== env.indexedChannels) {
      env.indexedChannels = channels;
      env.channelIndex = new Map(channels.map((c) => [JSON.stringify([c.sourceId, c.id]), c]));
    }
    const actual = env.channelIndex.get(JSON.stringify([channel.sourceId, channel.id]));
    return actual !== undefined && channelKey(actual) === channelKey(channel);
  };
  const addWeekCoverage = (
    channel: TimelineChannel,
    abort: AbortController,
    valid: () => boolean,
  ) => {
    if (
      !env.host.channelCoverage ||
      !channel.guideSourceId ||
      !channel.xmltvChannelId ||
      channel.guideRevision === undefined
    )
      return;
    const section = env.doc.createElement('details');
    const heading = env.doc.createElement('summary');
    heading.textContent = 'Next seven days';
    const result = env.doc.createElement('p');
    result.className = 'gx-timeline-week-coverage';
    result.textContent = 'Check this channel’s saved schedule. No guide download is started.';
    const check = env.button('Check next seven days', () => {
      if (!valid() || check.disabled) return;
      check.disabled = true;
      const start = env.host.now();
      result.textContent = 'Checking saved schedule…';
      void env
        .launch(
          (async () => {
            try {
              const query: ChannelCoverageRequest = {
                schemaVersion: 1,
                sourceId: channel.guideSourceId!,
                xmltvChannelId: channel.xmltvChannelId!,
                startMs: start,
                endMs: start + WEEK,
                expectedSourceRevision: channel.guideRevision!,
                expectedPublishedRevision: channel.guideRevision!,
              };
              const reply = validateChannelCoverageReply(
                await env.host.channelCoverage!(query, abort.signal),
                query,
              );
              if (valid())
                result.textContent = describeChannelCoverage(
                  reply,
                  env.host.formatTime,
                  'the next seven days',
                );
            } catch (error) {
              if (
                error instanceof ChannelCoverageCleanupError ||
                (abort.signal.aborted && !aborted(error))
              ) {
                env.cleanupError = error;
                throw error;
              }
              if (valid())
                result.textContent =
                  'Schedule could not be checked. Saved listings are retained; refresh Guide or review the mapping.';
            } finally {
              if (valid()) check.disabled = false;
            }
          })(),
        )
        .catch(env.report);
    });
    section.append(heading, result, check);
    env.details.append(section);
  };
  return {
    addWeekCoverage,
    channelCard,
    currentChannel,
    visibleArtwork,
    refreshArtwork,
  };
}
