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

import type { ChannelSelection } from '../playback/controller';
import { createOwnedAbortSignals } from '../platform/abort';

export interface CastDevice {
  id: string;
  name: string;
  protocol: 'chromecast' | 'dlna';
}
export type CastState =
  'idle' | 'connecting' | 'playing' | 'paused' | 'buffering' | 'stopping' | 'failed' | 'disposed';
export interface CastSnapshot {
  state: CastState;
  device: CastDevice | null;
  selection: ChannelSelection | null;
  sessionId: string | null;
  error: string | null;
}
export type CastEvent = {
  sessionId: string;
  selectionId: string;
  state: 'playing' | 'paused' | 'buffering' | 'ended' | 'failed';
  remoteSessionId?: string;
};
export interface CastEngine {
  /** LOAD acceptance alone is not playing. Emit verified receiver transport status separately. */
  start(selection: ChannelSelection, signal: AbortSignal): Promise<void>;
  /** Confirm owned media stopped (or ownership no longer exists), never stop someone else's receiver session. */
  stop(signal: AbortSignal): Promise<{ confirmed: boolean }>;
  /** Release sender sockets/listeners only after remote ownership has been resolved. */
  dispose(): Promise<void>;
}
export interface CastAdapter {
  discover(signal: AbortSignal): Promise<CastDevice[]>;
  create(device: CastDevice, sessionId: string, emit: (event: CastEvent) => void): CastEngine;
}
interface Session {
  id: string;
  engine: CastEngine;
  abort: AbortController;
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class CastingController {
  private current: CastSnapshot = {
    state: 'idle',
    device: null,
    selection: null,
    sessionId: null,
    error: null,
  };
  private session: Session | null = null;
  private generation = 0;
  private listeners = new Set<(snapshot: CastSnapshot) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private closing = false;
  private disposePromise: Promise<void> | null = null;
  private discoveryGeneration = 0;
  private discoveries = new Map<AbortController, Promise<unknown>>();
  constructor(
    private adapter: CastAdapter,
    private id: () => string = () => crypto.randomUUID(),
  ) {}
  get snapshot(): CastSnapshot {
    return {
      ...this.current,
      device: this.current.device ? { ...this.current.device } : null,
      selection: this.current.selection ? { ...this.current.selection } : null,
    };
  }
  subscribe(listener: (snapshot: CastSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(state: CastState, error: string | null = null): void {
    this.current = { ...this.current, state, error };
    for (const listener of this.listeners) listener(this.snapshot);
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private clearDeadline(): void {
    clearTimeout(this.deadline);
    this.deadline = undefined;
  }
  async listDevices(signal?: AbortSignal): Promise<CastDevice[]> {
    if (this.disposed || this.closing) throw new Error('Casting controller is closed.');
    const generation = ++this.discoveryGeneration;
    for (const owner of this.discoveries.keys()) owner.abort();
    const owner = new AbortController();
    const combined = createOwnedAbortSignals(signal ? [signal, owner.signal] : [owner.signal]);
    const timeout = setTimeout(
      () => owner.abort(new DOMException('Discovery timed out.', 'TimeoutError')),
      10_000,
    );
    const previous = [...this.discoveries.values()];
    const work = (async () => {
      await Promise.allSettled(previous);
      combined.signal.throwIfAborted();
      if (generation !== this.discoveryGeneration || this.closing || this.disposed)
        throw new DOMException('Discovery was cancelled.', 'AbortError');
      const devices = await this.adapter.discover(combined.signal);
      combined.signal.throwIfAborted();
      if (generation !== this.discoveryGeneration || this.closing || this.disposed)
        throw new DOMException('Discovery was cancelled.', 'AbortError');
      return devices;
    })();
    this.discoveries.set(owner, work);
    let devices: CastDevice[];
    try {
      devices = await work;
    } finally {
      clearTimeout(timeout);
      combined.dispose();
      this.discoveries.delete(owner);
    }
    if (devices.length > 100) throw new Error('Too many cast devices were discovered.');
    const ids = new Set<string>();
    return devices.map((device) => {
      if (
        !device.id ||
        device.id.length > 512 ||
        !device.name ||
        device.name.length > 512 ||
        !['chromecast', 'dlna'].includes(device.protocol) ||
        ids.has(device.id)
      )
        throw new Error('Cast discovery returned invalid devices.');
      ids.add(device.id);
      return { ...device };
    });
  }
  async cancelDiscovery(): Promise<void> {
    ++this.discoveryGeneration;
    const pending = [...this.discoveries];
    for (const [owner] of pending) owner.abort();
    await Promise.allSettled(pending.map(([, work]) => work));
  }
  private async release(): Promise<void> {
    const session = this.session;
    if (!session) return;
    session.abort.abort();
    const stopSignal = AbortSignal.timeout(5_000);
    const result = await bounded(session.engine.stop(stopSignal), stopSignal);
    if (!result.confirmed) throw new Error('The receiver has not confirmed that casting stopped.');
    await bounded(session.engine.dispose(), AbortSignal.timeout(5_000));
    if (this.session === session) this.session = null;
  }
  async start(device: CastDevice, selection: ChannelSelection): Promise<void> {
    if (this.disposed || this.closing) throw new Error('Casting controller is closed.');
    const generation = ++this.generation;
    this.clearDeadline();
    this.session?.abort.abort();
    const started = await this.enqueue(async () => {
      try {
        await this.release();
      } catch {
        if (generation === this.generation)
          this.publish(
            'failed',
            'Casting could not stop its previous receiver session. Retry Stop casting.',
          );
        return null;
      }
      if (generation !== this.generation || this.disposed) return null;
      const sessionId = this.id();
      const abort = new AbortController();
      this.current = {
        state: 'connecting',
        device: { ...device },
        selection: { ...selection },
        sessionId,
        error: null,
      };
      let engine: CastEngine;
      try {
        engine = this.adapter.create(device, sessionId, (event) => {
          if (
            generation !== this.generation ||
            this.session?.id !== event.sessionId ||
            event.selectionId !== selection.id
          )
            return;
          if (event.state === 'failed') {
            this.fail(
              generation,
              'The receiver could not play this channel. Check its format and network access.',
            );
            return;
          }
          if (event.state === 'ended') {
            void this.stop();
            return;
          }
          if (event.state === 'playing') {
            if (!event.remoteSessionId) return;
            this.clearDeadline();
          }
          this.publish(event.state);
        });
      } catch {
        this.publish(
          'failed',
          'The selected cast device is unavailable. Refresh devices and try again.',
        );
        return null;
      }
      this.session = { id: sessionId, engine, abort };
      this.publish('connecting');
      // A live stream through the relay takes the TV several seconds after its
      // cast app opens; the native start (40 s) gives up first, with cleanup.
      this.deadline = setTimeout(
        () =>
          this.fail(
            generation,
            'The TV did not start playing within 45 seconds. Retry or choose another TV.',
          ),
        45_000,
      );
      return this.session;
    });
    if (!started) return;
    try {
      await bounded(
        started.engine.start({ ...selection }, started.abort.signal),
        started.abort.signal,
      );
    } catch {
      if (generation === this.generation)
        this.fail(generation, 'Casting could not start. Check the receiver and channel access.');
    }
  }
  private fail(generation: number, message: string): void {
    if (generation !== this.generation) return;
    const failedGeneration = ++this.generation;
    this.clearDeadline();
    this.session?.abort.abort();
    this.publish('failed', message);
    void this.enqueue(() => this.release()).catch(() => {
      if (failedGeneration === this.generation)
        this.publish(
          'failed',
          'Casting failed and the receiver may still be active. Retry Stop casting.',
        );
    });
  }
  async stop(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.clearDeadline();
    this.session?.abort.abort();
    this.publish('stopping');
    await this.enqueue(async () => {
      try {
        await this.release();
        if (generation === this.generation) {
          this.current = {
            state: 'idle',
            device: null,
            selection: null,
            sessionId: null,
            error: null,
          };
          this.publish('idle');
        }
      } catch {
        if (generation === this.generation)
          this.publish('failed', 'The receiver may still be playing. Retry Stop casting.');
      }
    });
  }
  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.disposePromise) return this.disposePromise;
    this.closing = true;
    this.disposePromise = (async () => {
      await this.cancelDiscovery();
      await this.stop();
      if (this.session)
        throw new Error('Receiver cleanup is incomplete; casting ownership was retained.');
      this.disposed = true;
      ++this.generation;
      this.publish('disposed');
      this.listeners.clear();
    })().catch((error) => {
      this.closing = false;
      this.disposePromise = null;
      throw error;
    });
    return this.disposePromise;
  }
}
