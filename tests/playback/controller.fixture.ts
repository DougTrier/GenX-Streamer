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
 * What the playback controller tests share: channels, the engine harness and
 * events.
 */
import {
  PlaybackController,
  type ChannelSelection,
  type EngineEvent,
  type PlaybackEngine,
} from '../../src/playback/controller';
import { createResourceOwners } from '../../src/playback/resource-owners';
import { vi } from 'vitest';

export const channel = (id: string): ChannelSelection => ({
  id,
  name: id,
  url: `https://example.test/${id}.m3u8`,
});

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

export function harness(options: { holdInitialCancellation?: boolean } = {}) {
  const resources = createResourceOwners();
  const owners: Array<{
    engine: PlaybackEngine;
    emit: (event: EngineEvent) => void;
    signal?: AbortSignal;
    reject?: (error: Error) => void;
    resolve?: () => void;
  }> = [];
  const controller = new PlaybackController(
    (emit) => {
      const owner: (typeof owners)[number] = { engine: null as unknown as PlaybackEngine, emit };
      const holdCancellation = options.holdInitialCancellation && owners.length === 0;
      let cancelInitialization: (() => void) | undefined;
      owner.engine = {
        start: vi.fn((_selection, signal) => {
          owner.signal = signal;
          return new Promise<void>((resolve, reject) => {
            const canceled = () => {
              if (!holdCancellation) owner.resolve?.();
            };
            const settle = (failure?: Error) => {
              signal.removeEventListener('abort', canceled);
              if (failure) reject(failure);
              else resolve();
            };
            owner.resolve = () => settle();
            owner.reject = (failure) => settle(failure);
            cancelInitialization = canceled;
            signal.addEventListener('abort', canceled, { once: true });
            if (signal.aborted) canceled();
          });
        }),
        pause: vi.fn(),
        resume: vi.fn(async () => {}),
        setMuted: vi.fn(),
        setVolume: vi.fn(),
        dispose: vi.fn(() => cancelInitialization?.()),
      };
      owners.push(owner);
      return owner.engine;
    },
    undefined,
    resources,
  );
  return { controller, owners, resources };
}

export const temporary: EngineEvent = {
  type: 'error',
  failure: { code: 'network', message: 'Network unavailable', retryable: true },
};
