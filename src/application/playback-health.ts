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

import type { Channel, Source } from '../catalog';
import type {
  PlaybackController,
  ChannelSelection,
  DecodedPlaybackObservation,
} from '../playback/controller';
import { prepareDecodedHealthInWorker } from './decoded-health';
import type { PrepareDecodedHealthInput, PreparedDecodedHealth } from './prepare-decoded-health';
export interface PlaybackHealthContext {
  platform: string;
  observerProfile: string;
  scope: string;
}
export interface PlaybackHealthTarget {
  channel: Channel;
  source: Source;
  catalogRevision: string;
}
export interface PlaybackHealthHost {
  player: Pick<PlaybackController, 'subscribeDecoded' | 'isDecodedCurrent' | 'subscribe'>;
  resolve(selection: ChannelSelection): PlaybackHealthTarget | null;
  context(): PlaybackHealthContext | null;
  isContextCurrent(context: PlaybackHealthContext): boolean;
  readRecordPair(signal: AbortSignal): Promise<{ catalogRevision: string; healthRevision: string }>;
  writeHealth(
    input: { health: string; expectedCatalogRevision: string; expectedHealthRevision: string },
    signal: AbortSignal,
  ): Promise<{ committed: true; catalogRevision: string; healthRevision: string }>;
  enqueue(work: () => Promise<void>): Promise<void>;
  prepare?(input: PrepareDecodedHealthInput, signal: AbortSignal): Promise<PreparedDecodedHealth>;
  now?(): number;
  notice?(message: string): void;
  isRevisionConflict?(error: unknown): boolean;
}
/** Observes deliberately selected local playback; this owner never fetches or probes media. */
export function createPlaybackHealthCapture(host: PlaybackHealthHost): {
  settled(): Promise<void>;
  dispose(): Promise<void>;
} {
  let disposed = false;
  let pending: { observation: DecodedPlaybackObservation; controller: AbortController } | null =
    null;
  let latest: DecodedPlaybackObservation | null = null;
  const attempted = new WeakSet<object>();
  let work: Promise<void> = Promise.resolve();
  let disposePromise: Promise<void> | null = null;
  const canceled = () => new DOMException('Decoder observation superseded.', 'AbortError');
  function receive(observation: DecodedPlaybackObservation): void {
    if (
      disposed ||
      attempted.has(observation.attempt) ||
      !host.player.isDecodedCurrent(observation)
    )
      return;
    if (pending && !pending.controller.signal.aborted) return;
    latest = {
      ...observation,
      selection: { ...observation.selection },
      evidence: structuredClone(observation.evidence),
    };
    if (!pending) pump();
  }
  function pump(): void {
    if (disposed || pending || !latest) return;
    const observation = latest;
    latest = null;
    if (!host.player.isDecodedCurrent(observation)) return;
    const target = host.resolve(observation.selection);
    const context = host.context();
    if (!target || !context || !host.isContextCurrent(context)) return;
    const captured = structuredClone(target);
    const capturedContext = { ...context };
    const checkedUrlOrdinal = captured.channel.urls.indexOf(observation.selection.url);
    if (
      checkedUrlOrdinal < 0 ||
      captured.channel.urls.filter((url) => url === observation.selection.url).length !== 1 ||
      captured.channel.id !== observation.selection.id ||
      captured.source.id !== captured.channel.sourceId
    )
      return;
    attempted.add(observation.attempt);
    const observedAt = (host.now ?? Date.now)();
    const controller = new AbortController();
    pending = { observation, controller };
    const current = () => {
      controller.signal.throwIfAborted();
      const now = host.resolve(observation.selection);
      if (
        disposed ||
        !host.player.isDecodedCurrent(observation) ||
        !host.isContextCurrent(capturedContext) ||
        !now ||
        now.catalogRevision !== captured.catalogRevision ||
        now.channel.id !== captured.channel.id ||
        now.channel.urls[checkedUrlOrdinal] !== observation.selection.url ||
        now.channel.urls.filter((url) => url === observation.selection.url).length !== 1 ||
        now.channel.sourceId !== captured.source.id ||
        now.source.id !== captured.source.id ||
        now.source.location !== captured.source.location ||
        now.source.kind !== captured.source.kind ||
        (now.source.allowHttp === true) !== (captured.source.allowHttp === true)
      )
        throw canceled();
    };
    work = (async () => {
      try {
        await host.enqueue(async () => {
          let conflictedRevision: string | undefined;
          let conflictError: unknown;
          for (let attempt = 0; attempt < 3; attempt++) {
            current();
            const snapshot = await host.readRecordPair(controller.signal);
            current();
            if (snapshot.catalogRevision !== captured.catalogRevision) throw canceled();
            if (conflictedRevision === snapshot.healthRevision) throw conflictError;
            const prepared = await (host.prepare ?? prepareDecodedHealthInWorker)(
              {
                channel: captured.channel,
                source: captured.source,
                checkedUrlOrdinal,
                evidence: observation.evidence,
                platform: capturedContext.platform,
                observerProfile: capturedContext.observerProfile,
                observedAt,
              },
              controller.signal,
            );
            current();
            let receipt: Awaited<ReturnType<PlaybackHealthHost['writeHealth']>>;
            try {
              receipt = await host.writeHealth(
                {
                  health: prepared.health,
                  expectedCatalogRevision: snapshot.catalogRevision,
                  expectedHealthRevision: snapshot.healthRevision,
                },
                controller.signal,
              );
            } catch (error) {
              current();
              if (attempt === 2 || !host.isRevisionConflict?.(error)) throw error;
              conflictedRevision = snapshot.healthRevision;
              conflictError = error;
              continue;
            }
            if (
              receipt.committed !== true ||
              receipt.catalogRevision !== snapshot.catalogRevision ||
              !/^\d+$/.test(receipt.healthRevision)
            )
              throw new Error('Missing health publication receipt.');
            // A definite durable receipt wins cancellation after the backend committed.
            return;
          }
        });
      } catch {
        if (!disposed && !controller.signal.aborted && host.player.isDecodedCurrent(observation))
          host.notice?.('Your channel is playing. Its saved check could not be updated.');
      } finally {
        if (pending?.controller === controller) pending = null;
        if (!disposed && latest) pump();
      }
    })();
  }
  const unsubscribeDecoded = host.player.subscribeDecoded(receive);
  const unsubscribe = host.player.subscribe(() => {
    if (pending && !host.player.isDecodedCurrent(pending.observation)) pending.controller.abort();
    if (latest && !host.player.isDecodedCurrent(latest)) latest = null;
  });
  async function settled(): Promise<void> {
    let captured;
    do {
      captured = work;
      await captured;
    } while (captured !== work);
  }
  return {
    settled,
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      latest = null;
      unsubscribeDecoded();
      unsubscribe();
      pending?.controller.abort();
      const attempt = settled();
      disposePromise = attempt;
      void attempt.catch(() => {
        if (disposePromise === attempt) disposePromise = null;
      });
      return attempt;
    },
  };
}
