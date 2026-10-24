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

import type {
  HostAction,
  HostObservation,
  RemoteCommand,
  SharingApi,
  SharingHost,
  SharingSettings,
  SharingSnapshot,
} from './contracts';
import { createNativeSharingApi } from './native-api';
import { scopedChannels, validateSettings, validCommand } from './validation';
import { combineAbortSignals } from '../platform/abort';
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(new DOMException('Canceled', 'AbortError'));
    };
    if (signal.aborted) {
      void promise.catch(() => {});
      aborted();
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}
export class SharingService {
  private current: SharingSnapshot = {
    state: 'stopped',
    address: null,
    invitation: null,
    viewers: [],
    error: null,
    publishedGeneration: null,
  };
  private listeners = new Set<(snapshot: SharingSnapshot) => void>();
  private lifecycle: Promise<void> = Promise.resolve();
  private publication: Promise<void> = Promise.resolve();
  private publicationRunning = false;
  private publicationDirty = false;
  private generation = 0;
  private announced = -1;
  private runtime: AbortController | null = null;
  private command: AbortController | null = null;
  private commandId: string | null = null;
  private polling: Promise<void> | null = null;
  private disposed = false;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly host: SharingHost,
    private readonly api: SharingApi = createNativeSharingApi(),
  ) {
    this.unsubscribe = host.subscribe(() => {
      this.synchronize();
    });
  }
  get snapshot(): SharingSnapshot {
    return {
      ...this.current,
      viewers: [...this.current.viewers],
      invitation: this.current.invitation ? { ...this.current.invitation } : null,
    };
  }
  subscribe(listener: (snapshot: SharingSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private change(update: Partial<SharingSnapshot>): void {
    if (this.disposed) return;
    this.current = { ...this.current, ...update };
    for (const listener of this.listeners) listener(this.snapshot);
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(work);
    this.lifecycle = result.catch(() => {});
    return result;
  }
  async start(settings: SharingSettings): Promise<void> {
    validateSettings(settings);
    if (this.disposed) throw new Error('Sharing settings have closed.');
    if (this.current.state !== 'stopped')
      throw new Error('Stop the current sharing session before starting another.');
    const generation = ++this.generation;
    this.change({ state: 'starting', error: null });
    return this.enqueue(async () => {
      let started = false;
      try {
        const info = await this.api.start({ ...settings });
        started = true;
        if (this.disposed || generation !== this.generation) {
          await this.api.stop();
          return;
        }
        this.runtime = new AbortController();
        this.announced = -1;
        this.change({
          state: 'sharing',
          address: info.address,
          invitation: { secret: info.pairingSecret, role: 'viewer' },
          publishedGeneration: null,
        });
        await this.beforeSelection(this.host.snapshot().generation);
        this.synchronize();
        this.polling = this.poll(this.runtime.signal, generation);
        if (this.host.saveSettings) {
          try {
            await this.host.saveSettings({ ...settings });
          } catch {
            this.change({ error: 'Sharing is active, but its settings could not be saved.' });
          }
        }
      } catch {
        if (started) {
          this.runtime?.abort();
          await this.api.stop().catch(() => {});
        }
        if (generation === this.generation) {
          this.change({
            state: 'failed',
            error:
              'Sharing could not start. Check the selected interface, port, certificate and client trust.',
          });
        }
        throw new Error(
          'Sharing could not start. Check the selected interface, port, certificate and client trust.',
        );
      }
    });
  }
  /** Reserve host action ownership; local pause/resume retains the viewer's media publication. */
  async beforeSelection(
    generation: number,
    commandId?: string,
    preservePublication = false,
  ): Promise<void> {
    if (!Number.isSafeInteger(generation) || generation < 0)
      throw new Error('Playback generation is invalid.');
    if (this.current.state !== 'sharing' || !this.runtime || this.runtime.signal.aborted) return;
    const owner = this.generation;
    const receipt = preservePublication
      ? await this.api.selectionChanged(generation, commandId, true)
      : await this.api.selectionChanged(generation, commandId);
    if (
      receipt !== undefined &&
      (receipt === null ||
        typeof receipt !== 'object' ||
        receipt.generation !== generation ||
        !Number.isSafeInteger(receipt.publicationRevision) ||
        receipt.publicationRevision < 0)
    )
      throw new Error('The sharing transition could not be confirmed.');
    if (owner === this.generation && !this.runtime.signal.aborted && generation >= this.announced) {
      this.announced = generation;
      const retained = receipt
        ? receipt.publicationRevision > 0
        : preservePublication && this.current.publishedGeneration !== null;
      this.change({ publishedGeneration: retained ? generation : null });
    }
  }
  private synchronize(): void {
    if (this.current.state !== 'sharing' || this.runtime?.signal.aborted || this.disposed) return;
    this.publicationDirty = true;
    if (this.publicationRunning) return;
    this.publicationRunning = true;
    const owner = this.generation;
    this.publication = (async () => {
      while (this.publicationDirty && owner === this.generation) {
        this.publicationDirty = false;
        try {
          const observed = this.host.snapshot();
          if (observed.generation !== this.announced)
            await this.beforeSelection(observed.generation, this.commandId ?? undefined);
          if (this.commandId || owner !== this.generation) continue;
          const latest = this.host.snapshot();
          if (
            latest.generation !== observed.generation ||
            latest.playback.state !== 'playing' ||
            latest.playback.selection?.mediaKind !== 'hls' ||
            this.current.publishedGeneration === latest.generation
          )
            continue;
          const result = await this.api.publish(latest.playback.selection.url, latest.generation);
          if (!Number.isSafeInteger(result.revision) || result.revision < 1)
            throw new Error('Invalid publication.');
          if (owner === this.generation && this.host.snapshot().generation === latest.generation)
            this.change({ publishedGeneration: latest.generation, error: null });
        } catch {
          if (owner === this.generation && this.current.state === 'sharing')
            this.change({
              error:
                'The current channel could not be shared. Choose an admitted HLS stream or review source permissions.',
            });
        }
      }
    })().finally(() => {
      this.publicationRunning = false;
      if (this.publicationDirty) this.synchronize();
    });
  }

  async invite(role: 'viewer' | 'controller', ids: ReadonlyArray<string> = []): Promise<void> {
    if (this.current.state !== 'sharing') throw new Error('Start sharing first.');
    const owner = this.generation;
    const channels = role === 'controller' ? scopedChannels(this.host.channels(), ids) : [];
    const secret = await this.api.invite(role === 'controller', channels);
    if (owner === this.generation && this.current.state === 'sharing')
      this.change({ invitation: { secret, role }, error: null });
  }
  async refreshViewers(): Promise<void> {
    const owner = this.generation;
    const viewers = await this.api.viewers();
    if (owner === this.generation && this.current.state === 'sharing')
      this.change({ viewers: [...viewers] });
  }
  async revoke(viewerId: string): Promise<void> {
    await this.api.revoke(viewerId);
    await this.refreshViewers();
  }
  private action(command: RemoteCommand, observation: HostObservation): HostAction | null {
    if (command.action === 'select')
      return this.host.channels().some((channel) => channel.id === command.channelId)
        ? { kind: 'select', channelId: command.channelId! }
        : null;
    if (command.action === 'next' || command.action === 'previous') {
      const allowed = new Set(command.allowedChannelIds);
      const channels = this.host.channels().filter((channel) => allowed.has(channel.id));
      if (!channels.length) return null;
      const position = channels.findIndex(
        (channel) => channel.id === observation.playback.selection?.id,
      );
      const index =
        position < 0
          ? 0
          : (position + (command.action === 'next' ? 1 : channels.length - 1)) % channels.length;
      return { kind: 'select', channelId: channels[index].id };
    }
    if (command.action === 'mute') return { kind: 'mute', muted: command.muted! };
    if (command.action === 'volume') return { kind: 'volume', volume: command.volume! };
    return { kind: command.action };
  }
  private matches(action: HostAction, observation: HostObservation, generation: number): boolean {
    if (observation.generation !== generation) return false;
    if (action.kind === 'select')
      return (
        observation.playback.state === 'playing' &&
        observation.playback.selection?.id === action.channelId
      );
    if (action.kind === 'pause') return observation.playback.state === 'paused';
    if (action.kind === 'resume') return observation.playback.state === 'playing';
    if (action.kind === 'mute') return observation.muted === action.muted;
    return Math.abs(observation.volume - action.volume) < 0.001;
  }
  private async dispatch(command: RemoteCommand, signal: AbortSignal): Promise<void> {
    let applied = false;
    const cancellation = new AbortController();
    // Forward the long-lived session only while this command is owned. A confirmed
    // action keeps its signal settled without accumulating session listeners.
    const sessionEnded = () => cancellation.abort(signal.reason);
    signal.addEventListener('abort', sessionEnded, { once: true });
    if (signal.aborted) sessionEnded();
    const owned = combineAbortSignals([cancellation.signal]);
    const timer = setTimeout(() => cancellation.abort(), 2400);
    this.command = cancellation;
    this.commandId = command.commandId;
    try {
      if (!validCommand(command)) return;
      const action = this.action(command, this.host.snapshot());
      if (!action) return;
      const authorized = async () =>
        !owned.aborted &&
        (await this.api.active(command.commandId)) &&
        (action.kind !== 'select' || (await this.api.allows(command.commandId, action.channelId)));
      if (!(await untilAbort(authorized(), owned))) return;
      const result = await untilAbort(
        this.host.apply(action, { signal: owned, commandId: command.commandId, authorized }),
        owned,
      );
      if (!Number.isSafeInteger(result.generation)) return;
      while (!owned.aborted) {
        if (!(await untilAbort(authorized(), owned))) return;
        const current = this.host.snapshot();
        if (current.generation !== result.generation) return;
        if (this.matches(action, current, result.generation)) {
          applied = true;
          return;
        }
        await delay(50, owned);
      }
    } catch {
      /* Aborted, revoked, failed or superseded applications are unconfirmed. */
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', sessionEnded);
      if (!applied) cancellation.abort();
      try {
        await this.api.acknowledge(command.commandId, applied && !signal.aborted);
      } catch {
        /* Native service may already have ended or consumed this command. */
      }
      if (this.command === cancellation) {
        this.command = null;
        this.commandId = null;
      }
      this.synchronize();
    }
  }
  private async poll(signal: AbortSignal, owner: number): Promise<void> {
    while (!signal.aborted && owner === this.generation) {
      try {
        const command = await this.api.nextCommand();
        if (signal.aborted) return;
        if (command) await this.dispatch(command, signal);
        else await delay(50, signal);
      } catch {
        if (!signal.aborted && owner === this.generation)
          this.change({
            error: 'Phone control is unavailable. Stop and restart sharing to reconnect.',
          });
        await delay(1000, signal);
      }
    }
  }
  async stop(): Promise<void> {
    ++this.generation;
    this.runtime?.abort();
    this.command?.abort();
    this.change({ state: 'stopping', invitation: null });
    return this.enqueue(async () => {
      try {
        await this.api.stop();
        await this.polling;
        await this.publication;
        this.runtime = null;
        this.polling = null;
        this.announced = -1;
        this.change({
          state: 'stopped',
          address: null,
          viewers: [],
          publishedGeneration: null,
          error: null,
        });
      } catch {
        this.change({
          state: 'failed',
          error: 'Sharing has not confirmed shutdown. Retry Stop before starting again.',
        });
        throw new Error('Sharing has not confirmed shutdown.');
      }
    });
  }
  async dispose(): Promise<void> {
    this.unsubscribe();
    this.disposed = true;
    await this.stop();
    this.listeners.clear();
  }
}
