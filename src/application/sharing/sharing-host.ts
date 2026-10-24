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

import type { Channel } from '../../catalog';
import type {
  ChannelSelection,
  PlaybackController,
  PlaybackSnapshot,
  RecoveryPlan,
} from '../../playback/controller';
import type { HostAction, HostObservation, SharingHost } from '../../sharing/contracts';
export interface SharingActionContext {
  signal: AbortSignal;
  commandId: string;
  authorized: () => Promise<boolean>;
}
export interface SharingHostOptions {
  player: PlaybackController;
  /** Optional local session owner; observations/audio still use the one controller. */
  localSelection?: Pick<PlaybackController, 'select' | 'stop'>;
  /** Rechecked after asynchronous publication/phone gates, immediately before local playback. */
  playbackAllowed?(): boolean;
  /** Private native transports must never enter LAN/phone publication snapshots. */
  publishSelectionAllowed?: (selection: ChannelSelection) => boolean;
  channels: () => readonly Channel[];
  /** Playable outside the catalog (Local radio); never listed to the phone. */
  extraChannel?: (id: string) => Pick<Channel, 'id' | 'name' | 'urls'> | undefined;
  settings: () => { muted: boolean; volume: number; removedChannels: readonly string[] };
  saveAudio: (
    patch: { muted?: boolean; volume?: number },
    context?: SharingActionContext,
    generation?: number,
  ) => Promise<void>;
}
export function createSharingHost(options: SharingHostOptions) {
  const { player } = options;
  let generation = 0;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let pending: PlaybackSnapshot | null = null;
  let beforeSelection:
    | ((generation: number, commandId?: string, preservePublication?: boolean) => Promise<void>)
    | null = null;
  let abortOwner: (() => void) | null = null;
  let pendingCommand: {
    generation: number;
    selectionId: string | null;
    state: 'playing' | 'paused';
  } | null = null;
  let recoveryAuthority: { generation: number; context?: SharingActionContext } | null = null;
  const listeners = new Set<(observation: HostObservation) => void>();
  const selections = new Set<Promise<{ generation: number }>>();
  const snapshot = (): HostObservation => {
    const settings = options.settings();
    const playback = pending ?? player.snapshot;
    const selection =
      playback.selection && options.publishSelectionAllowed?.(playback.selection) !== false
        ? { ...playback.selection }
        : null;
    return {
      generation,
      muted: settings.muted,
      volume: settings.volume,
      playback: { ...playback, selection },
    };
  };
  const emit = () => {
    if (!disposed) for (const listener of listeners) listener(snapshot());
  };
  const detach = () => {
    abortOwner?.();
    abortOwner = null;
    pendingCommand = null;
  };
  const canceled = () =>
    new DOMException('Playback action was canceled or superseded.', 'AbortError');
  const current = (owner: number, context?: SharingActionContext) => {
    if (disposed || owner !== generation || context?.signal.aborted) throw canceled();
  };
  const gate = async (owner: number, context?: SharingActionContext) => {
    current(owner, context);
    if (context && !(await context.authorized())) throw canceled();
    current(owner, context);
  };
  const channels = () => {
    const removed = new Set(options.settings().removedChannels);
    return options.channels().filter((channel) => !removed.has(channel.id));
  };
  const admitted = (id: string) => {
    const channel = channels().find((channel) => channel.id === id) ?? options.extraChannel?.(id);
    if (!channel || !channel.urls.length)
      throw new Error('The channel is no longer available in this catalog.');
    return channel;
  };
  async function mutate(
    target: PlaybackSnapshot,
    action: () => Promise<void> | void,
    context?: SharingActionContext,
    observedState: 'playing' | 'paused' = 'playing',
    preservePublication = false,
  ): Promise<{ generation: number }> {
    const previous = generation;
    // Local actions reserve immediately. Remote admission must not supersede a local change during authorization.
    if (context) await gate(previous, context);
    current(previous, context);
    detach();
    const owner = ++generation;
    if (preservePublication && recoveryAuthority) recoveryAuthority.generation = owner;
    else recoveryAuthority = null;
    pending = target;
    if (context) {
      const cancel = () => {
        if (owner !== generation || disposed) return;
        // stop() reserves a new generation immediately, so repeated cancellation cannot affect a newer selection.
        void stop().catch(() => {});
      };
      context.signal.addEventListener('abort', cancel, { once: true });
      abortOwner = () => context.signal.removeEventListener('abort', cancel);
      pendingCommand = {
        generation: owner,
        selectionId: target.selection?.id ?? null,
        state: observedState,
      };
    }
    try {
      if (beforeSelection) await beforeSelection(owner, context?.commandId, preservePublication);
      if (context) await gate(owner, context);
      // No await between the final signal/generation gate and decoder mutation.
      current(owner, context);
      pending = null;
      await action();
      current(owner, context);
      emit();
      return { generation: owner };
    } catch (error) {
      if (owner === generation) {
        pending = {
          state: 'failed',
          selection: target.selection,
          error: 'Playback could not complete the sharing transition. Retry the channel.',
        };
        emit();
      }
      throw error;
    }
  }
  async function select(selection: ChannelSelection, context?: SharingActionContext) {
    const channel = admitted(selection.id);
    if (!channel.urls.includes(selection.url))
      throw new Error('The stream is no longer admitted for this channel.');
    const work = mutate(
      { state: 'connecting', selection: { ...selection, name: channel.name }, error: null },
      async () => {
        const latest = admitted(selection.id);
        if (!latest.urls.includes(selection.url))
          throw new Error('The stream changed during selection.');
        const authority = { generation, context };
        recoveryAuthority = authority;
        const urls = [selection.url, ...latest.urls.filter((url) => url !== selection.url)];
        if (urls.length > 16) throw new Error('The channel has too many recovery sources.');
        const checkRecovery = (candidate: ChannelSelection, signal: AbortSignal) => {
          if (recoveryAuthority !== authority) throw canceled();
          current(authority.generation, authority.context);
          if (signal.aborted) throw canceled();
          if (!admitted(candidate.id).urls.includes(candidate.url))
            throw new Error('The recovery stream is no longer admitted.');
        };
        const recovery: RecoveryPlan = {
          urls,
          async beforeRetry(candidate, signal) {
            checkRecovery(candidate, signal);
            await gate(authority.generation, authority.context);
            checkRecovery(candidate, signal);
          },
          async beforeCandidate(candidate, signal) {
            const check = () => checkRecovery(candidate, signal);
            check();
            await gate(authority.generation, authority.context);
            check();
            // A pending remote command has not published media and must retain the
            // generation returned by apply(). Once confirmed, a new URL is a new
            // sharing publication generation, just as it is for local recovery.
            const commandPending = pendingCommand?.generation === authority.generation;
            if (!commandPending) authority.generation = ++generation;
            pending = { state: 'reconnecting', selection: { ...candidate }, error: null };
            try {
              if (beforeSelection)
                await beforeSelection(
                  authority.generation,
                  commandPending ? context?.commandId : undefined,
                );
              check();
              await gate(authority.generation, authority.context);
              check();
              pending = null;
              emit();
            } catch (error) {
              if (recoveryAuthority === authority && authority.generation === generation)
                pending = null;
              throw error;
            }
          },
        };
        if (options.playbackAllowed?.() === false) throw canceled();
        await (options.localSelection ?? player).select(
          { ...selection, name: latest.name },
          recovery,
        );
      },
      context,
    );
    selections.add(work);
    void work.then(
      () => selections.delete(work),
      () => selections.delete(work),
    );
    return work;
  }
  async function resume(context?: SharingActionContext) {
    if (player.snapshot.state !== 'paused') {
      await gate(generation, context);
      return { generation };
    }
    const selection = player.snapshot.selection;
    if (!selection) throw new Error('Choose a channel before resuming.');
    const validateSelection = () => {
      if (!admitted(selection.id).urls.includes(selection.url))
        throw new Error('The stream is no longer admitted for this channel.');
    };
    validateSelection();
    return mutate(
      { state: 'connecting', selection, error: null },
      () => {
        validateSelection();
        if (options.playbackAllowed?.() === false) throw canceled();
        return player.resume();
      },
      context,
      'playing',
      true,
    );
  }
  async function pause(context?: SharingActionContext) {
    const selection = player.snapshot.selection;
    return mutate(
      { state: 'connecting', selection, error: null },
      () => player.pause(),
      context,
      'paused',
      true,
    );
  }
  async function stop() {
    return mutate({ state: 'idle', selection: null, error: null }, () =>
      (options.localSelection ?? player).stop(),
    );
  }
  async function suspend() {
    // Invalidating a generation prevents late decoder admission, but its
    // publication gate/local handoff remains owned until the original settles.
    const pendingSelections = [...selections];
    const suspended = mutate(
      { state: 'paused', selection: player.snapshot.selection, error: null },
      () => player.suspend(),
      undefined,
      'paused',
      true,
    );
    const [paused, ...joined] = await Promise.allSettled([suspended, ...pendingSelections]);
    if (paused.status === 'rejected') throw paused.reason;
    for (const result of joined)
      if (
        result.status === 'rejected' &&
        !(result.reason instanceof DOMException && result.reason.name === 'AbortError')
      )
        throw result.reason;
    return paused.value;
  }
  async function audio(
    action: Extract<HostAction, { kind: 'mute' | 'volume' }>,
    context: SharingActionContext,
  ) {
    const owner = generation;
    await gate(owner, context);
    if (
      action.kind === 'volume' &&
      (!Number.isFinite(action.volume) || action.volume < 0 || action.volume > 1)
    )
      throw new Error('Volume is outside its allowed range.');
    await options.saveAudio(
      action.kind === 'mute' ? { muted: action.muted } : { volume: action.volume },
      context,
      owner,
    );
    await gate(owner, context);
    current(owner, context);
    const settings = options.settings();
    player.setMuted(settings.muted);
    player.setVolume(settings.volume);
    emit();
    return { generation: owner };
  }
  const host: SharingHost = {
    snapshot,
    subscribe(listener) {
      if (disposed) throw new Error('The sharing host has closed.');
      listeners.add(listener);
      listener(snapshot());
      return () => {
        listeners.delete(listener);
      };
    },
    channels: () => channels().map(({ id, name }) => ({ id, name })),
    async apply(action, context) {
      if (action.kind === 'select') {
        const channel = admitted(action.channelId);
        return select({ id: channel.id, name: channel.name, url: channel.urls[0] }, context);
      }
      if (action.kind === 'resume') return resume(context);
      if (action.kind === 'pause') return pause(context);
      return audio(action, context);
    },
  };
  const unsubscribe = player.subscribe((playback) => {
    if (
      !pending &&
      pendingCommand?.generation === generation &&
      playback.state === pendingCommand.state &&
      playback.selection?.id === pendingCommand.selectionId
    )
      detach();
    emit();
  });
  return {
    host,
    select,
    resume,
    pause,
    stop,
    suspend,
    bindBeforeSelection(
      callback: (
        generation: number,
        commandId?: string,
        preservePublication?: boolean,
      ) => Promise<void>,
    ) {
      beforeSelection = callback;
    },
    notifySettings: emit,
    async dispose() {
      if (disposed) return;
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        await stop();
        await player.dispose();
        disposed = true;
        detach();
        unsubscribe();
        listeners.clear();
      })().catch((error: unknown) => {
        disposePromise = null;
        throw error;
      });
      return disposePromise;
    },
  };
}
