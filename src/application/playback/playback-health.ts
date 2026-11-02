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

import type { Channel, Source } from '../../catalog';
import type {
  PlaybackController,
  ChannelSelection,
  DecodedPlaybackObservation,
} from '../../playback/controller';
import { prepareDecodedHealthInWorker } from '../health/decoded-health';
import type {
  PrepareDecodedHealthInput,
  PreparedDecodedHealth,
} from '../health/prepare-decoded-health';
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
export type PlaybackHealthPhase = 'queue' | 'read' | 'prepare' | 'write' | 'receipt';
type SupersededReason =
  | 'disposed'
  | 'decoder-changed'
  | 'context-changed'
  | 'target-missing'
  | 'catalog-changed'
  | 'url-slot-changed'
  | 'source-grant-changed';
export interface PlaybackHealthDiagnostic {
  readonly phase: PlaybackHealthPhase;
  readonly outcome: 'canceled' | 'failed';
  readonly reason:
    | SupersededReason
    | 'owned-abort'
    | 'unowned-abort'
    | 'enqueue-failed'
    | 'read-failed'
    | 'prepare-failed'
    | 'write-failed'
    | 'receipt-invalid'
    | 'health-conflict-exhausted'
    | 'health-revision-unchanged';
  readonly attempt: number;
}
/** Only this module can assert that its immutable capture lost authority. */
class CaptureSuperseded extends Error {
  constructor(readonly reason: SupersededReason) {
    super('Decoder observation superseded.');
  }
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
  diagnostic?(event: Readonly<PlaybackHealthDiagnostic>): void;
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
      if (disposed) throw new CaptureSuperseded('disposed');
      if (!host.player.isDecodedCurrent(observation))
        throw new CaptureSuperseded('decoder-changed');
      if (!host.isContextCurrent(capturedContext)) throw new CaptureSuperseded('context-changed');
      if (!now) throw new CaptureSuperseded('target-missing');
      if (now.catalogRevision !== captured.catalogRevision)
        throw new CaptureSuperseded('catalog-changed');
      if (
        now.channel.id !== captured.channel.id ||
        now.channel.urls[checkedUrlOrdinal] !== observation.selection.url ||
        now.channel.urls.filter((url) => url === observation.selection.url).length !== 1
      )
        throw new CaptureSuperseded('url-slot-changed');
      if (
        now.channel.sourceId !== captured.source.id ||
        now.source.id !== captured.source.id ||
        now.source.location !== captured.source.location ||
        now.source.kind !== captured.source.kind ||
        (now.source.allowHttp === true) !== (captured.source.allowHttp === true)
      )
        throw new CaptureSuperseded('source-grant-changed');
    };
    let phase: PlaybackHealthPhase = 'queue',
      tries = 0;
    let failureReason: PlaybackHealthDiagnostic['reason'] | null = null;
    work = (async () => {
      try {
        await host.enqueue(async () => {
          let conflictedRevision: string | undefined;
          let conflictError: unknown;
          for (let attempt = 0; attempt < 3; attempt++) {
            tries = attempt + 1;
            current();
            phase = 'read';
            const snapshot = await host.readRecordPair(controller.signal);
            current();
            if (snapshot.catalogRevision !== captured.catalogRevision)
              throw new CaptureSuperseded('catalog-changed');
            if (conflictedRevision === snapshot.healthRevision) {
              failureReason = 'health-revision-unchanged';
              throw conflictError;
            }
            phase = 'prepare';
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
              phase = 'write';
              receipt = await host.writeHealth(
                {
                  health: prepared.health,
                  expectedCatalogRevision: snapshot.catalogRevision,
                  expectedHealthRevision: snapshot.healthRevision,
                },
                controller.signal,
              );
            } catch (error) {
              // A real worker/storage refusal remains observable even if its
              // owner changes concurrently; only an actual CAS is rebased.
              if (!host.isRevisionConflict?.(error)) throw error;
              current();
              if (attempt === 2) {
                failureReason = 'health-conflict-exhausted';
                throw error;
              }
              conflictedRevision = snapshot.healthRevision;
              conflictError = error;
              continue;
            }
            phase = 'receipt';
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
      } catch (error) {
        const owned = error instanceof CaptureSuperseded;
        const abort = error instanceof DOMException && error.name === 'AbortError';
        const canceled = owned || (abort && controller.signal.aborted);
        const defaults: Record<PlaybackHealthPhase, PlaybackHealthDiagnostic['reason']> = {
          queue: 'enqueue-failed',
          read: 'read-failed',
          prepare: 'prepare-failed',
          write: 'write-failed',
          receipt: 'receipt-invalid',
        };
        const event: PlaybackHealthDiagnostic = {
          phase,
          outcome: canceled ? 'canceled' : 'failed',
          reason: owned
            ? error.reason
            : canceled
              ? 'owned-abort'
              : abort
                ? 'unowned-abort'
                : (failureReason ?? defaults[phase]),
          attempt: tries,
        };
        try {
          host.diagnostic?.(Object.freeze(event));
        } catch {
          /* Observations never replace the original save outcome. */
        }
        if (
          !canceled &&
          !disposed &&
          !controller.signal.aborted &&
          host.player.isDecodedCurrent(observation)
        )
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
