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
import type { OneShotRecognizer, SpeechCapability, SpeechResult } from './speech';
export interface NativeSpeechCapabilities {
  platform: 'android' | 'windows';
  onDeviceAvailable: boolean;
  serviceAvailable: boolean;
  permissionGranted: boolean;
  cloudConsentRequired: true;
}
export interface NativeSpeechOptions {
  invoke?<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  available?(): boolean;
  now?(): number;
  requestId?(): string;
  timer?: {
    set(callback: () => void, milliseconds: number): unknown;
    clear(handle: unknown): void;
  };
}
interface Job {
  id: string;
  reason: 'canceled' | 'timeout' | null;
  startIssued: boolean;
  done: Promise<SpeechResult>;
  cancellation: Promise<void> | null;
  cancelError: boolean;
}
function failure(error: unknown): SpeechResult {
  const code = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (['speech-canceled', 'speech-background'].includes(code)) return { status: 'canceled' };
  if (['speech-no-match', 'speech-no-input'].includes(code)) return { status: 'no-match' };
  const reason: Extract<SpeechResult, { status: 'failed' }>['reason'] = [
    'speech-permission-required',
    'speech-permission-denied',
  ].includes(code)
    ? 'permission-denied'
    : ['speech-language-unsupported', 'speech-language-unavailable'].includes(code)
      ? 'language-unavailable'
      : code === 'speech-network-failed'
        ? 'network'
        : code === 'speech-timeout'
          ? 'timeout'
          : 'service-unavailable';
  return { status: 'failed', reason };
}
/** Native final replies occur only after recognizer cleanup; cancellation also waits owned IPC settlement. */
export class NativeSpeech implements OneShotRecognizer {
  private active: Job | null = null;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private call: NonNullable<NativeSpeechOptions['invoke']>;
  private present: () => boolean;
  private now: () => number;
  private timer: NonNullable<NativeSpeechOptions['timer']>;
  constructor(private options: NativeSpeechOptions = {}) {
    this.call = options.invoke ?? invoke;
    this.present = options.available ?? isTauri;
    this.now = options.now ?? Date.now;
    this.timer = options.timer ?? {
      set: (callback, delay) => setTimeout(callback, delay),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }
  private async capabilities(): Promise<NativeSpeechCapabilities> {
    const value = await this.call<NativeSpeechCapabilities>('speech_capabilities');
    if (
      !value ||
      !['android', 'windows'].includes(value.platform) ||
      ['onDeviceAvailable', 'serviceAvailable', 'permissionGranted'].some(
        (key) => typeof value[key as keyof NativeSpeechCapabilities] !== 'boolean',
      ) ||
      value.cloudConsentRequired !== true ||
      (value.platform === 'windows' && value.serviceAvailable)
    )
      throw new Error('speech-provider-unavailable');
    return value;
  }
  async capability(): Promise<SpeechCapability> {
    if (this.disposed || !this.present())
      return { available: false, mode: 'unknown', reason: 'unsupported', languages: [] };
    try {
      const value = await this.capabilities();
      return {
        available: value.onDeviceAvailable || value.serviceAvailable,
        mode: value.onDeviceAvailable ? 'on-device' : value.serviceAvailable ? 'cloud' : 'unknown',
        ...(!value.onDeviceAvailable && !value.serviceAvailable
          ? {
              reason:
                value.platform === 'windows'
                  ? ('unsupported' as const)
                  : ('service-unavailable' as const),
            }
          : {}),
        languages: [],
      };
    } catch {
      return { available: false, mode: 'unknown', reason: 'service-unavailable', languages: [] };
    }
  }
  recognize(options: Parameters<OneShotRecognizer['recognize']>[0]): Promise<SpeechResult> {
    if (this.disposed || this.active || !this.present())
      return Promise.resolve({ status: 'failed', reason: 'service-unavailable' });
    if (
      !/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/.test(options.language) ||
      options.language.length > 64
    )
      return Promise.resolve({ status: 'failed', reason: 'language-unavailable' });
    const instant = this.now();
    if (
      !Number.isSafeInteger(instant) ||
      !Number.isSafeInteger(options.deadlineMs) ||
      options.deadlineMs <= instant
    )
      return Promise.resolve({ status: 'failed', reason: 'timeout' });
    const id = this.options.requestId?.() ?? crypto.randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      return Promise.resolve({ status: 'failed', reason: 'service-unavailable' });
    let complete!: (result: SpeechResult) => void;
    const job: Job = {
      id,
      reason: null,
      startIssued: false,
      done: new Promise((resolve) => {
        complete = resolve;
      }),
      cancellation: null,
      cancelError: false,
    };
    this.active = job;
    void this.execute(job, options).then(complete, () =>
      complete({ status: 'failed', reason: 'service-unavailable' }),
    );
    return job.done;
  }
  private cancellation(job: Job, reason: 'canceled' | 'timeout'): Promise<void> {
    job.reason ??= reason;
    if (!job.cancellation)
      job.cancellation = Promise.resolve()
        .then(() => this.call<void>('speech_cancel', { requestId: job.id }))
        .catch(() => {
          job.cancelError = true;
        });
    return job.cancellation;
  }
  private async execute(
    job: Job,
    options: Parameters<OneShotRecognizer['recognize']>[0],
  ): Promise<SpeechResult> {
    const abort = () => {
      void this.cancellation(job, 'canceled');
    };
    let handle: unknown;
    let scheduled = false;
    const stopped = () => {
      if (this.now() >= options.deadlineMs) void this.cancellation(job, 'timeout');
      return job.reason !== null || this.disposed || options.signal.aborted;
    };
    let result!: SpeechResult;
    try {
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
      handle = this.timer.set(
        () => {
          void this.cancellation(job, 'timeout');
        },
        Math.max(0, Math.min(15000, options.deadlineMs - this.now())),
      );
      scheduled = true;
      result = await (async (): Promise<SpeechResult> => {
        if (stopped()) return { status: 'canceled' };
        const capability = await this.capabilities();
        if (stopped()) return { status: 'canceled' };
        if (!capability.onDeviceAvailable && !options.allowCloud)
          return { status: 'failed', reason: 'service-unavailable' };
        if (!capability.onDeviceAvailable && !capability.serviceAvailable)
          return { status: 'failed', reason: 'service-unavailable' };
        // Windows advertises only its confirmed local SAPI engine, never an implied cloud fallback.
        if (capability.platform === 'windows' && !capability.onDeviceAvailable)
          return { status: 'failed', reason: 'service-unavailable' };
        if (!capability.permissionGranted) {
          const permission = await this.call<{ granted: boolean }>('speech_request_permission', {
            requestId: job.id,
          });
          if (stopped()) return { status: 'canceled' };
          if (permission?.granted !== true)
            return { status: 'failed', reason: 'permission-denied' };
        }
        if (stopped()) return { status: 'canceled' };
        job.startIssued = true;
        const reply = await this.call<{
          requestId: string;
          text: string;
          provider: string;
          cloudPossible: boolean;
        }>('speech_start', {
          requestId: job.id,
          language: options.language,
          allowCloud: options.allowCloud,
        });
        if (stopped()) return { status: 'canceled' };
        if (
          !reply ||
          reply.requestId !== job.id ||
          typeof reply.text !== 'string' ||
          !reply.text.trim() ||
          reply.text.length > 512 ||
          [...reply.text].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) ||
          !(capability.platform === 'windows'
            ? reply.provider === 'windows-sapi-local' && reply.cloudPossible === false
            : ['android-on-device', 'android-system-service'].includes(reply.provider)) ||
          typeof reply.cloudPossible !== 'boolean' ||
          (reply.provider === 'android-on-device' && reply.cloudPossible) ||
          (!options.allowCloud &&
            (reply.cloudPossible ||
              !['android-on-device', 'windows-sapi-local'].includes(reply.provider)))
        )
          throw new Error('speech-provider-unavailable');
        return { status: 'final', transcript: reply.text.trim() };
      })();
    } catch (error) {
      result = failure(error);
      if (
        error === 'speech-stop-unconfirmed' ||
        (error instanceof Error && error.message === 'speech-stop-unconfirmed')
      )
        job.cancelError = true;
    } finally {
      options.signal.removeEventListener('abort', abort);
      if (scheduled) {
        try {
          this.timer.clear(handle);
        } catch {
          result = { status: 'failed', reason: 'service-unavailable' };
        }
      }
      if (job.cancellation) await job.cancellation;
      if (this.active === job && !job.cancelError) this.active = null;
    }
    return job.cancelError
      ? { status: 'failed', reason: 'service-unavailable' }
      : job.reason === 'timeout'
        ? { status: 'failed', reason: 'timeout' }
        : job.reason === 'canceled'
          ? { status: 'canceled' }
          : result;
  }
  async finish(): Promise<void> {
    const job = this.active;
    if (!job) return;
    if (!job.startIssued) {
      await this.cancel();
      return;
    }
    try {
      await this.call<void>('speech_end', { requestId: job.id });
    } catch {
      await this.cancel();
      throw new Error('Voice input could not finish; type your search instead.');
    }
  }
  async cancel(): Promise<void> {
    const job = this.active;
    if (!job) return;
    if (job.cancelError) {
      job.cancelError = false;
      job.cancellation = null;
    }
    await this.cancellation(job, 'canceled');
    await job.done;
    if (job.cancelError) throw new Error('Voice input cancellation could not be confirmed.');
    if (this.active === job) this.active = null;
  }
  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true;
      this.disposal = this.cancel();
    }
    return this.disposal;
  }
}
