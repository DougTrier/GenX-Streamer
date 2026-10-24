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

import type { ChannelSelection, PlaybackController, RecoveryPlan } from '../../playback/controller';
import { createOwnedAbortSignals } from '../../platform/abort';
import { startTiming } from '../../playback/start-timing';
import {
  validateAccountChannel,
  type AccountChannel,
  type AccountCatalogFence,
} from '../../platform/account-catalog';
import {
  createAccountPlayback,
  validateAccountPlaybackReceipt,
  validateAccountPlaybackStopReceipt,
  type AccountPlaybackReceipt,
  type AccountPlaybackRequest,
  type AccountVodPlayRequest,
  listenAccountPlaybackBusy,
  type AccountPlaybackBusyListen,
} from '../../platform/account-playback';
import { viewingSettings, type PlaybackBuffer } from '../../platform/viewing-settings';

export interface AccountPlayerHost {
  /** The application's existing local player: this owner never allocates a second engine. */
  player: Pick<PlaybackController, 'select' | 'stop' | 'suspend'> &
    Partial<Pick<PlaybackController, 'note'>>;
  /** Native "provider busy" notices; defaults to the application's event. */
  busy?: AccountPlaybackBusyListen;
  playback?: Pick<ReturnType<typeof createAccountPlayback>, 'start' | 'stop' | 'retryCleanup'>;
  /** The account's live buffering choice (Settings); defaults to the shared store. */
  bufferFor?(accountId: string): PlaybackBuffer;
}
export interface AccountPlayerSelection {
  channel: AccountChannel;
  fence: AccountCatalogFence;
}
/** A provider movie or episode, played through the same single account session. */
export interface AccountVodTitle {
  kind: 'movie' | 'episode';
  itemId: string;
  extension: string;
  name: string;
}
interface Session {
  receipt: AccountPlaybackReceipt;
  /** The live channel; null for an on-demand title (never resumed or remembered). */
  choice: AccountPlayerSelection | null;
  /** This session already is the other-format try: it never bounces back. */
  alternateUsed: boolean;
}
const canceled = () => new DOMException('Channel selection was canceled.', 'AbortError');
class AccountPlayerCleanupError extends Error {
  constructor() {
    super('The previous player could not stop. Retry Stop before choosing another channel.');
  }
}
const cleanupFailed = () => new AccountPlayerCleanupError();
/** Shown while a one-connection provider still counts the previous channel. */
export const PROVIDER_BUSY_MESSAGE =
  'The provider is still closing your previous channel. This can take up to 30 seconds.';
/** First-start window for paid live channels: the relay waits out a busy
 *  provider for up to 30 s, then the stream still needs time to begin. */
const PAID_LIVE_STARTUP_MS = 35_000;
function fence(value: AccountCatalogFence): AccountCatalogFence {
  const validRevision = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^[1-9][0-9]{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, 'accountId') ||
    !Object.hasOwn(value, 'accountRevision') ||
    !Object.hasOwn(value, 'mediaRevision') ||
    typeof value.accountId !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(value.accountId) ||
    !validRevision(value.accountRevision) ||
    !validRevision(value.mediaRevision)
  )
    throw new Error('The saved account selection is invalid. Reload its channels.');
  return {
    accountId: value.accountId,
    accountRevision: value.accountRevision,
    mediaRevision: value.mediaRevision,
  };
}

/** Serializes the native account capability and the application's one local player. */
export function createAccountPlayer(host: AccountPlayerHost) {
  const playback = host.playback ?? createAccountPlayback();
  let unlistenBusy: Promise<() => void> | null = null;
  const watchBusy = () => {
    unlistenBusy ??= (host.busy ?? listenAccountPlaybackBusy)((sessionGeneration) => {
      // Only the live channel this exact session is starting is told to wait.
      if (session?.choice && session.receipt.sessionGeneration === sessionGeneration)
        host.player.note?.(session.choice.channel.id, PROVIDER_BUSY_MESSAGE);
    }).catch(() => () => undefined);
  };
  const bufferFor = (accountId: string) =>
    (host.bufferFor ?? ((id: string) => viewingSettings.bufferFor(id)))(accountId);
  let session: Session | null = null;
  let grantedUrl: string | null = null;
  let requestScope: { origin: string; prefix: string } | null = null;
  let generation = 0;
  let owner: AbortController | null = null;
  let queue: Promise<void> = Promise.resolve();
  let closing = false;
  let closed = false;
  let disposal: Promise<void> | null = null;
  let pendingAccount: AccountPlayerSelection | null = null;
  let pendingPublic = false;
  let backgroundChoice: AccountPlayerSelection | null = null;
  let suspension: Promise<void> | null = null;
  let backgroundRelease: Promise<void> | null = null;
  const revoke = () => {
    grantedUrl = null;
    requestScope = null;
  };
  const stopPlayer = (): Promise<void> => {
    try {
      return Promise.resolve(host.player.stop());
    } catch {
      return Promise.reject(cleanupFailed());
    }
  };
  const suspendPlayer = (): Promise<void> => {
    try {
      return Promise.resolve(host.player.suspend());
    } catch {
      return Promise.reject(cleanupFailed());
    }
  };
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const work = queue.then(operation);
    queue = work.catch(() => undefined);
    return work;
  };
  /** Native cleanup cannot run until the decoder and its loaders have actually stopped. */
  const release = async (playerStop: Promise<void>): Promise<void> => {
    revoke();
    try {
      await playerStop;
      const previous = session;
      if (previous) {
        const receipt = await playback.stop(previous.receipt.sessionGeneration);
        validateAccountPlaybackStopReceipt(receipt, previous.receipt.sessionGeneration);
        if (session === previous) session = null;
      }
      await playback.retryCleanup();
    } catch {
      // Keep session identity on failed cleanup. Every replacement retries release first.
      throw cleanupFailed();
    }
  };
  const begin = (allowClosing = false) => {
    if (closed || (closing && !allowClosing)) throw new Error('The account player is closed.');
    if (suspension && !allowClosing) throw canceled();
    const current = ++generation;
    pendingAccount = null;
    pendingPublic = false;
    backgroundChoice = null;
    owner?.abort();
    revoke();
    const owned = new AbortController();
    owner = owned;
    // Stop is invoked synchronously, before waiting on a stale account startup queue.
    const stopped = stopPlayer();
    void stopped.catch(() => undefined);
    return { current, owned, stopped };
  };
  const current = (owned: AbortController, captured: number, signal: AbortSignal): boolean =>
    !closed && !closing && owner === owned && captured === generation && !signal.aborted;

  async function stop(): Promise<void> {
    if (closed) return;
    const { owned, stopped } = begin(true);
    await enqueue(async () => {
      try {
        await release(stopped);
      } finally {
        if (owner === owned) owner = null;
      }
    });
  }
  function suspend(): Promise<void> {
    if (closed) return Promise.resolve();
    if (suspension) return suspension;
    const choice = pendingPublic
      ? null
      : (pendingAccount ?? (session ? session.choice : backgroundChoice));
    backgroundChoice = choice
      ? { channel: { ...choice.channel }, fence: { ...choice.fence } }
      : null;
    // Keep the actual controller's paused selection while invalidating every
    // queued/public/private startup. Native cleanup still joins the old queue.
    const stopped = suspendPlayer();
    backgroundRelease = stopped;
    const work = enqueue(async () => release(stopped)).finally(() => {
      if (suspension === work) {
        suspension = null;
        backgroundRelease = null;
      }
    });
    suspension = work;
    owner?.abort();
    ++generation;
    owner = null;
    pendingPublic = false;
    revoke();
    return work;
  }
  async function startSession(
    choice: AccountPlayerSelection | null,
    input: AccountPlaybackRequest | { vod: AccountVodPlayRequest },
    shown: { id: string; name: string },
    failure: string,
    signal?: AbortSignal,
    alternate = false,
  ): Promise<void> {
    const { current: captured, owned, stopped } = begin();
    pendingAccount = choice;
    if (choice) watchBusy();
    const combined = createOwnedAbortSignals(signal ? [owned.signal, signal] : [owned.signal]);
    let canceledPlayerStop: Promise<void> | null = null;
    const interrupt = () => {
      if (owner !== owned || generation !== captured) return;
      revoke();
      canceledPlayerStop ??= backgroundRelease ?? stopPlayer();
      void canceledPlayerStop.catch(() => undefined);
    };
    combined.signal.addEventListener('abort', interrupt, { once: true });
    await enqueue(async () => {
      let issued: Session | null = null;
      try {
        await release(stopped);
        startTiming.mark('previous-released');
        if (!current(owned, captured, combined.signal)) throw canceled();
        const result = alternate
          ? await playback.start(input, combined.signal, { alternate: true })
          : await playback.start(input, combined.signal);
        const receipt = validateAccountPlaybackReceipt(result);
        startTiming.mark('session-ready');
        issued = { receipt, choice, alternateUsed: alternate };
        session = issued;
        if (!current(owned, captured, combined.signal)) throw canceled();
        grantedUrl = receipt.mediaUrl;
        const parsed = new URL(receipt.mediaUrl);
        requestScope = {
          origin: parsed.origin,
          prefix: parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1),
        };
        // The URL exists only inside the live player session, never a catalog/preferences record.
        await host.player.select({
          id: shown.id,
          name: shown.name,
          url: receipt.mediaUrl,
          // A known format skips the player's separate check request.
          ...(receipt.mediaHint === 'hls'
            ? { mediaKind: 'hls' as const }
            : receipt.mediaHint === 'mpegts'
              ? { mediaKind: 'media' as const, mediaMime: 'video/mp2t' }
              : {}),
          // A file plays from the video element itself; CORS mode makes it send the
          // Origin header the relay requires of cross-site requests.
          ...(choice ? {} : { playMode: 'on-demand' as const, crossOrigin: 'anonymous' as const }),
          ...(choice ? { startupMs: PAID_LIVE_STARTUP_MS } : {}),
          ...(choice && bufferFor(choice.fence.accountId) !== 'balanced'
            ? { buffer: bufferFor(choice.fence.accountId) }
            : {}),
          ...(receipt.mediaHint === 'file' ? { mediaKind: 'media' as const } : {}),
        });
        if (!current(owned, captured, combined.signal)) throw canceled();
      } catch (error) {
        if (issued && session === issued) {
          await release(canceledPlayerStop ?? stopPlayer());
        } else if (canceledPlayerStop) {
          try {
            await canceledPlayerStop;
          } catch {
            throw cleanupFailed();
          }
        }
        if (error instanceof AccountPlayerCleanupError) throw error;
        if (!current(owned, captured, combined.signal)) throw canceled();
        // Native/provider errors may contain credential-bearing URLs; expose only the safe symptom.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(failure);
      } finally {
        combined.signal.removeEventListener('abort', interrupt);
        combined.dispose();
        if (owner === owned) owner = null;
        if (choice && pendingAccount === choice) pendingAccount = null;
      }
    });
  }
  function startAccount(
    choice: AccountPlayerSelection,
    signal: AbortSignal | undefined,
    alternate: boolean,
  ): Promise<void> {
    return startSession(
      choice,
      {
        schemaVersion: 1,
        accountId: choice.fence.accountId,
        expectedAccountRevision: choice.fence.accountRevision,
        expectedMediaRevision: choice.fence.mediaRevision,
        streamReference: choice.channel.streamReference,
      },
      { id: choice.channel.id, name: choice.channel.name },
      'This account channel could not start. Reload its channels or sign in again.',
      signal,
      alternate,
    );
  }
  return {
    get selection(): AccountPlayerSelection | null {
      const choice = session ? session.choice : backgroundChoice;
      return choice ? { channel: { ...choice.channel }, fence: { ...choice.fence } } : null;
    },
    get backgroundPaused(): boolean {
      return backgroundChoice !== null;
    },
    /** Initial engine admission authorizes only the exact issued root URL. */
    allowsHttp(url: string): boolean {
      return session !== null && grantedUrl !== null && url === grantedUrl;
    },
    /** Native HLS rewrites may issue more opaque resources within this same session. */
    allowsRequest(url: string): boolean {
      if (
        !session ||
        !requestScope ||
        typeof url !== 'string' ||
        url.length > 1024 ||
        /[\p{Cc}\p{White_Space}?#]/u.test(url)
      )
        return false;
      try {
        const parsed = new URL(url);
        return (
          parsed.origin === requestScope.origin &&
          parsed.protocol === 'http:' &&
          parsed.hostname === '127.0.0.1' &&
          !parsed.username &&
          !parsed.password &&
          !parsed.search &&
          !parsed.hash &&
          parsed.href === url &&
          parsed.pathname.startsWith(requestScope.prefix) &&
          /^[a-f0-9]{64}$/u.test(parsed.pathname.slice(requestScope.prefix.length))
        );
      } catch {
        return false;
      }
    },
    async selectAccount(
      channel: AccountChannel,
      accountFence: AccountCatalogFence,
      signal?: AbortSignal,
    ): Promise<void> {
      const admittedFence = fence(accountFence);
      const admittedChannel = validateAccountChannel(channel, admittedFence.accountId);
      if (signal?.aborted) throw canceled();
      await startAccount({ channel: admittedChannel, fence: admittedFence }, signal, false);
    },
    /** A failed live start may try the provider's other stored format, once. */
    get alternateAvailable(): boolean {
      return (
        !!session?.choice && session.receipt.alternateAvailable === true && !session.alternateUsed
      );
    },
    async retryAlternate(signal?: AbortSignal): Promise<boolean> {
      const choice = session?.choice;
      if (!choice || session?.receipt.alternateAvailable !== true || session.alternateUsed)
        return false;
      await startAccount(choice, signal, true);
      return true;
    },
    /** Play a provider movie or episode in place of the current channel. */
    async selectVod(
      title: AccountVodTitle,
      account: { accountId: string; accountRevision: string },
      signal?: AbortSignal,
    ): Promise<void> {
      if (signal?.aborted) throw canceled();
      const name = typeof title?.name === 'string' ? title.name.slice(0, 300) : '';
      await startSession(
        null,
        {
          vod: {
            schemaVersion: 1,
            accountId: account.accountId,
            expectedRevision: account.accountRevision,
            kind: title.kind,
            itemId: title.itemId,
            extension: title.extension,
          },
        },
        { id: `vod:${title.kind}:${title.itemId}`, name },
        'This title could not start. The provider may not allow it on this account.',
        signal,
      );
    },
    async selectPublic(
      selection: ChannelSelection,
      recovery?: RecoveryPlan,
      signal?: AbortSignal,
    ): Promise<void> {
      if (signal?.aborted) throw canceled();
      const admitted = { ...selection };
      const { current: captured, owned, stopped } = begin();
      pendingPublic = true;
      const combined = createOwnedAbortSignals(signal ? [owned.signal, signal] : [owned.signal]);
      let canceledPlayerStop: Promise<void> | null = null;
      const interrupt = () => {
        if (owner !== owned || generation !== captured) return;
        revoke();
        canceledPlayerStop ??= backgroundRelease ?? stopPlayer();
        void canceledPlayerStop.catch(() => undefined);
      };
      combined.signal.addEventListener('abort', interrupt, { once: true });
      await enqueue(async () => {
        try {
          await release(stopped);
          if (!current(owned, captured, combined.signal)) throw canceled();
          await host.player.select(admitted, recovery);
          if (!current(owned, captured, combined.signal)) throw canceled();
        } catch (error) {
          if (canceledPlayerStop) {
            try {
              await canceledPlayerStop;
            } catch {
              throw cleanupFailed();
            }
          }
          if (error instanceof AccountPlayerCleanupError) throw error;
          if (!current(owned, captured, combined.signal)) throw canceled();
          // Keep untrusted stream URLs and provider response text out of public diagnostics.
          // eslint-disable-next-line preserve-caught-error
          throw new Error('The selected channel could not start. Retry or choose another channel.');
        } finally {
          combined.signal.removeEventListener('abort', interrupt);
          combined.dispose();
          if (owner === owned) owner = null;
          if (generation === captured) pendingPublic = false;
        }
      });
    },
    stop,
    suspend,
    dispose(): Promise<void> {
      if (closed) return Promise.resolve();
      if (disposal) return disposal;
      closing = true;
      const attempt = stop().then(() => {
        closed = true;
        revoke();
        void unlistenBusy?.then((unlisten) => unlisten());
      });
      disposal = attempt;
      void attempt.catch(() => {
        if (disposal === attempt) disposal = null;
      });
      return attempt;
    },
  };
}

/** The channel or title an account player is currently playing. */
export type AccountPlaybackChoice = NonNullable<
  ReturnType<typeof createAccountPlayer>['selection']
>;
