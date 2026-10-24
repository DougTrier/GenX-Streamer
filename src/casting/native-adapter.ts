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

import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ChannelSelection } from '../playback/controller';
import { inspectSource } from '../platform/records';
import type { ConfiguredSource } from '../sources';
import type { CastAdapter, CastDevice, CastEngine } from './controller';

interface NativeStatus {
  sessionId: string;
  selectionId: string;
  state: 'playing' | 'paused' | 'buffering' | 'ended';
  remoteSessionId: string | null;
}
export function createNativeCastAdapter(
  allowHttp: (selection: ChannelSelection) => boolean = () => false,
  inspect?: (url: string, signal: AbortSignal) => Promise<ConfiguredSource>,
  allowHttpReceiver: () => boolean = () => false,
  authorize: (device: CastDevice, signal: AbortSignal) => Promise<string> = async () => {
    throw new Error('Confirm your TV before starting casting.');
  },
): CastAdapter {
  return {
    discover: async (signal) => {
      if (!isTauri()) throw new Error('Device casting requires the native application.');
      signal.throwIfAborted();
      const requestId = crypto.randomUUID();
      let cancellation: Promise<void> | null = null;
      const cancel = () => {
        cancellation ??= invoke<void>('cast_cancel_discovery', { requestId });
        // Retain the rejection for the joined cleanup below without an unhandled callback rejection.
        void cancellation.catch(() => undefined);
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const devices = await invoke<CastDevice[]>('cast_discover', { requestId });
        signal.throwIfAborted();
        return devices;
      } finally {
        signal.removeEventListener('abort', cancel);
        if (cancellation) await cancellation;
      }
    },
    create: (inputDevice, sessionId, emit) => {
      const device = Object.freeze({ ...inputDevice });
      let selected: ChannelSelection | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let released = false;
      let stopped = false;
      let stopping = false;
      let cancellation: AbortSignal | null = null;
      const clear = () => {
        clearTimeout(timer);
        timer = undefined;
      };
      const publish = (status: NativeStatus) => {
        if (
          released ||
          stopping ||
          cancellation?.aborted ||
          status.sessionId !== sessionId ||
          status.selectionId !== selected?.id
        )
          return;
        emit({
          sessionId,
          selectionId: status.selectionId,
          state: status.state,
          ...(status.remoteSessionId ? { remoteSessionId: status.remoteSessionId } : {}),
        });
      };
      const poll = async () => {
        if (released || stopping || cancellation?.aborted) return;
        try {
          publish(await invoke<NativeStatus>('cast_status', { sessionId }));
        } catch {
          if (!released && !stopping && !cancellation?.aborted && selected)
            emit({ sessionId, selectionId: selected.id, state: 'failed' });
          return;
        }
        if (!released && !stopping && !cancellation?.aborted)
          timer = setTimeout(() => {
            void poll();
          }, 2000);
      };
      const engine: CastEngine = {
        start: async (selection, signal) => {
          if (!isTauri()) throw new Error('Device casting requires the native application.');
          selected = { ...selection };
          const receiverRelay = device.protocol === 'chromecast' && allowHttpReceiver();
          cancellation = signal;
          signal.throwIfAborted();
          signal.addEventListener('abort', clear, { once: true });
          const media =
            selection.mediaKind === 'hls'
              ? { kind: 'hls', mime: 'application/x-mpegURL' }
              : selection.mediaKind === 'media' && selection.mediaMime
                ? { kind: 'media', mime: selection.mediaMime }
                : await (inspect
                    ? inspect(selection.url, signal)
                    : inspectSource(selection.url, allowHttp(selection), signal));
          signal.throwIfAborted();
          const contentType =
            media.kind === 'hls'
              ? 'application/x-mpegURL'
              : media.kind === 'media' && media.mime
                ? media.mime.split(';')[0].trim().toLowerCase()
                : null;
          if (!contentType || !/^(?:audio|video)\/|^application\/x-mpegURL$/.test(contentType))
            throw new Error('The selected source is not a supported media stream.');
          if (released || stopping) throw new Error('The casting session was released.');
          let issuedHandle: string;
          try {
            issuedHandle = await authorize(device, signal);
          } catch {
            signal.throwIfAborted();
            throw new Error('Confirm your TV again before starting casting.');
          }
          signal.throwIfAborted();
          if (released || stopping) throw new Error('The casting session was released.');
          if (
            typeof issuedHandle !== 'string' ||
            issuedHandle.length === 0 ||
            issuedHandle.length > 128 ||
            issuedHandle.trim() !== issuedHandle ||
            issuedHandle === device.id ||
            [...issuedHandle].some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            )
          )
            throw new Error('Receiver authorization was invalid. Confirm your TV again.');
          const startArgs = {
            deviceId: issuedHandle,
            sessionId,
            selection: { ...selection, contentType },
            allowHttp: allowHttp(selection),
            ...(receiverRelay ? { allowHttpReceiver: true } : {}),
          };
          signal.throwIfAborted();
          const result = await invoke<NativeStatus>('cast_start', startArgs);
          publish(result);
          if (!signal.aborted)
            timer = setTimeout(() => {
              void poll();
            }, 2000);
        },
        stop: async (signal) => {
          if (stopped) return { confirmed: true };
          stopping = true;
          clear();
          signal.throwIfAborted();
          try {
            stopped = (await invoke<boolean>('cast_stop', { sessionId })) === true;
          } catch (error) {
            if (error === 'cast-session-not-owned') stopped = true;
            // eslint-disable-next-line preserve-caught-error -- Raw native errors may embed provider secrets; diagnostics intentionally omit them.
            else throw new Error('The receiver has not confirmed that casting stopped.');
          }
          return { confirmed: stopped };
        },
        dispose: async () => {
          released = true;
          clear();
          cancellation?.removeEventListener('abort', clear);
          selected = null;
        },
      };
      return engine;
    },
  };
}
