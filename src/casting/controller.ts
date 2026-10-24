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
  /** The TV's own identity; discovery gives the same TV a new `id` each time. */
  protocolReceiverId?: string;
}
export type CastState = 'connecting' | 'playing' | 'paused' | 'buffering' | 'stopping';
/** One TV being cast to, and the channel it plays. */
export interface ActiveCast {
  device: CastDevice;
  selection: ChannelSelection;
  sessionId: string;
  state: CastState;
}
export interface CastSnapshot {
  /** Every TV being cast to, in the order they were chosen. */
  casts: ActiveCast[];
  /** The latest outcome to tell the viewer (a failure, or a TV that ended). */
  message: string | null;
  disposed: boolean;
}
export type CastEvent = {
  sessionId: string;
  selectionId: string;
  state: 'playing' | 'paused' | 'buffering' | 'ended' | 'failed';
  remoteSessionId?: string;
  /** Why it ended: the TV said so (Back, Home, another phone, idle), or it stopped answering. */
  reason?: 'receiver' | 'unreachable';
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
/** TVs cast to at once, as many as the native layer allows. */
export const MAX_CASTS = 4;
interface Session {
  id: string;
  key: string;
  device: CastDevice;
  selection: ChannelSelection;
  engine: CastEngine;
  abort: AbortController;
  state: CastState;
  deadline: ReturnType<typeof setTimeout> | undefined;
}
/** Which TV this is: its own identity when it reports one, else its roster id. */
export function castDeviceKey(device: CastDevice): string {
  return device.protocolReceiverId
    ? `${device.protocol}:${device.protocolReceiverId}`
    : `id:${device.id}`;
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

/**
 * Casts to several TVs at once, each its own channel (owner request, October
 * 24, 2026). Each TV has one session, its own queue and its own latest
 * intent: choosing a TV that is already casting replaces only that TV's cast,
 * and nothing here follows what this device itself plays.
 */
export class CastingController {
  private sessions = new Map<string, Session>();
  /** The latest start or stop asked of each TV; older work for it gives way. */
  private intents = new Map<string, number>();
  private queues = new Map<string, Promise<unknown>>();
  private message: string | null = null;
  private listeners = new Set<(snapshot: CastSnapshot) => void>();
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
      casts: [...this.sessions.values()].map((session) => ({
        device: { ...session.device },
        selection: { ...session.selection },
        sessionId: session.id,
        state: session.state,
      })),
      message: this.message,
      disposed: this.disposed,
    };
  }
  subscribe(listener: (snapshot: CastSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(message?: string | null): void {
    if (message !== undefined) this.message = message;
    for (const listener of this.listeners) listener(this.snapshot);
  }
  private intent(key: string): number {
    const next = (this.intents.get(key) ?? 0) + 1;
    this.intents.set(key, next);
    return next;
  }
  /** Work for one TV runs in order; other TVs do not wait for it. */
  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return result;
  }
  private current(session: Session): boolean {
    return this.sessions.get(session.key) === session;
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
  /**
   * Asks this TV to stop (five seconds at most), then lets its session go
   * whether or not it answered, and reports whether it confirmed. A TV that
   * does not answer (asleep, unplugged, taken over by another phone) never
   * blocks casting (owner decision, October 24, 2026). The native layer
   * revokes the TV's stream relay first, either way. Other TVs are untouched.
   */
  private async release(key: string): Promise<boolean> {
    const session = this.sessions.get(key);
    if (!session) return true;
    session.abort.abort();
    clearTimeout(session.deadline);
    let confirmed: boolean;
    try {
      const stopSignal = AbortSignal.timeout(5_000);
      confirmed = (await bounded(session.engine.stop(stopSignal), stopSignal)).confirmed;
    } catch {
      confirmed = false;
    }
    try {
      await bounded(session.engine.dispose(), AbortSignal.timeout(5_000));
    } catch {
      // The sender's own timers and listeners go with the session below.
    }
    if (this.current(session)) this.sessions.delete(key);
    return confirmed;
  }
  /** Casts `selection` to `device`; every other TV keeps playing its own channel. */
  async start(device: CastDevice, selection: ChannelSelection): Promise<void> {
    if (this.disposed || this.closing) throw new Error('Casting controller is closed.');
    const key = castDeviceKey(device);
    const intent = this.intent(key);
    const previous = this.sessions.get(key);
    if (previous) {
      previous.abort.abort();
      clearTimeout(previous.deadline);
    }
    const started = await this.enqueue(key, async () => {
      // This TV's previous cast, if any, is asked to stop and let go first.
      await this.release(key);
      if (intent !== this.intents.get(key) || this.disposed || this.closing) return null;
      if (this.sessions.size >= MAX_CASTS) {
        this.publish(`GenX casts to ${MAX_CASTS} TVs at most. Stop one to cast to ${device.name}.`);
        return null;
      }
      const sessionId = this.id();
      const owner: { session: Session | null } = { session: null };
      let engine: CastEngine;
      try {
        engine = this.adapter.create({ ...device }, sessionId, (event) => {
          if (owner.session) this.receive(owner.session, event);
        });
      } catch {
        this.publish(`${device.name} is unavailable. Refresh devices and try again.`);
        return null;
      }
      const session: Session = {
        id: sessionId,
        key,
        device: { ...device },
        selection: { ...selection },
        engine,
        abort: new AbortController(),
        state: 'connecting',
        deadline: undefined,
      };
      owner.session = session;
      this.sessions.set(key, session);
      // A live stream through the relay takes the TV several seconds after its
      // cast app opens; the native start (40 s) gives up first, with cleanup.
      session.deadline = setTimeout(
        () =>
          this.fail(
            session,
            'did not start playing within 45 seconds. Retry or choose another TV.',
          ),
        45_000,
      );
      this.publish(null);
      return session;
    });
    if (!started) return;
    try {
      await bounded(
        started.engine.start({ ...selection }, started.abort.signal),
        started.abort.signal,
      );
    } catch {
      if (this.current(started) && !started.abort.signal.aborted)
        this.fail(started, 'could not start casting. Check the receiver and channel access.');
    }
  }
  /** A status event, bound to its own session and channel (C02). */
  private receive(session: Session, event: CastEvent): void {
    if (
      !this.current(session) ||
      session.abort.signal.aborted ||
      event.sessionId !== session.id ||
      event.selectionId !== session.selection.id
    )
      return;
    if (event.state === 'failed') {
      this.fail(session, 'could not play this channel. Check its format and network access.');
      return;
    }
    if (event.state === 'ended') {
      // Back or Home on the TV, another phone, sleep, or a TV gone from the
      // network: release this TV alone; the rest keeps working.
      this.end(
        session,
        event.reason === 'unreachable'
          ? `${session.device.name} stopped answering, so its cast ended.`
          : `${session.device.name} stopped casting.`,
      );
      return;
    }
    if (event.state === 'playing') {
      if (!event.remoteSessionId) return;
      clearTimeout(session.deadline);
    }
    // Status arrives every two seconds; only a change redraws the panel and pins.
    if (session.state === event.state) return;
    session.state = event.state;
    this.publish();
  }
  /** Lets go of a TV that ended the cast on its side. */
  private end(session: Session, message: string): void {
    const intent = this.intent(session.key);
    session.abort.abort();
    clearTimeout(session.deadline);
    session.state = 'stopping';
    this.publish();
    void this.enqueue(session.key, async () => {
      await this.release(session.key);
      this.publish(intent === this.intents.get(session.key) ? message : undefined);
    });
  }
  private fail(session: Session, problem: string): void {
    if (!this.current(session)) return;
    const message = `${session.device.name} ${problem}`;
    const intent = this.intent(session.key);
    session.abort.abort();
    clearTimeout(session.deadline);
    session.state = 'stopping';
    this.publish(message);
    void this.enqueue(session.key, () => this.release(session.key)).then((confirmed) => {
      if (intent !== this.intents.get(session.key)) return;
      this.publish(
        confirmed
          ? message
          : `${message} If the TV still shows the channel, stop it with the TV's remote.`,
      );
    });
  }
  /** Stops casting to this TV only. */
  async stop(device: CastDevice): Promise<void> {
    if (this.disposed) return;
    const key = castDeviceKey(device);
    const intent = this.intent(key);
    const session = this.sessions.get(key);
    if (session) {
      session.abort.abort();
      clearTimeout(session.deadline);
      session.state = 'stopping';
      this.publish();
    }
    await this.enqueue(key, async () => {
      const name = this.sessions.get(key)?.device.name ?? device.name;
      const confirmed = await this.release(key);
      if (intent !== this.intents.get(key)) return;
      this.publish(
        confirmed
          ? null
          : `${name} did not answer. If it still shows the channel, stop it with the TV's remote.`,
      );
    });
  }
  /** Stops every TV, together. */
  async stopAll(): Promise<void> {
    const devices = new Map<string, CastDevice>();
    for (const session of this.sessions.values()) devices.set(session.key, session.device);
    // A start still waiting in a TV's queue gives way too.
    for (const key of this.queues.keys()) if (!devices.has(key)) this.intent(key);
    await Promise.all([...devices.values()].map((device) => this.stop(device)));
    await Promise.allSettled([...this.queues.values()]);
  }
  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.disposePromise) return this.disposePromise;
    this.closing = true;
    this.disposePromise = (async () => {
      await this.cancelDiscovery();
      await this.stopAll();
      if (this.sessions.size)
        throw new Error('Receiver cleanup is incomplete; casting ownership was retained.');
      this.disposed = true;
      this.publish(null);
      this.listeners.clear();
    })().catch((error) => {
      this.closing = false;
      this.disposePromise = null;
      throw error;
    });
    return this.disposePromise;
  }
}
