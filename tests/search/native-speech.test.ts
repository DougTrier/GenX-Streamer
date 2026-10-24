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

import { describe, it, expect, vi } from 'vitest';
import { NativeSpeech, type NativeSpeechOptions } from '../../src/search/native-speech';
const id = '11111111-1111-4111-8111-111111111111';
const capability = {
  platform: 'android',
  onDeviceAvailable: true,
  serviceAvailable: true,
  permissionGranted: true,
  cloudConsentRequired: true,
};
const reply = {
  requestId: id,
  text: ' Chicago Bears ',
  provider: 'android-on-device',
  cloudPossible: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(dispatch: (command: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  let expire = () => {};
  const options: NativeSpeechOptions = {
    available: () => true,
    now: () => 1000,
    requestId: () => id,
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return (await dispatch(command, args)) as T;
    },
    timer: {
      set: (callback) => {
        expire = callback;
        return 1;
      },
      clear: () => {},
    },
  };
  return { speech: new NativeSpeech(options), calls, expire: () => expire() };
}
const start = (speech: NativeSpeech, signal = new AbortController().signal) =>
  speech.recognize({ language: 'en-US', signal, deadlineMs: 16000, allowCloud: false });
describe('native speech ownership', () => {
  it('admits confirmed Windows local capability and final with cloud disabled, without Android assumptions', async () => {
    const f = fixture(async (command) =>
      command === 'speech_capabilities'
        ? { ...capability, platform: 'windows', serviceAvailable: false }
        : { ...reply, provider: 'windows-sapi-local' },
    );
    expect(await f.speech.capability()).toEqual({
      available: true,
      mode: 'on-device',
      languages: [],
    });
    expect(await start(f.speech)).toEqual({ status: 'final', transcript: 'Chicago Bears' });
    expect(f.calls.filter((call) => call.command === 'speech_request_permission')).toHaveLength(0);
    expect(f.calls.at(-1)).toEqual({
      command: 'speech_start',
      args: { requestId: id, language: 'en-US', allowCloud: false },
    });
    await f.speech.dispose();
  });
  it.each([
    { platform: 'windows', provider: 'windows-sapi-local', cloudPossible: true, allowCloud: false },
    { platform: 'windows', provider: 'windows-sapi-local', cloudPossible: true, allowCloud: true },
    { platform: 'windows', provider: 'android-on-device', cloudPossible: false, allowCloud: false },
    {
      platform: 'android',
      provider: 'windows-sapi-local',
      cloudPossible: false,
      allowCloud: false,
    },
    { platform: 'android', provider: 'android-on-device', cloudPossible: true, allowCloud: true },
  ])(
    'rejects platform/provider or local privacy mismatches: $platform $provider cloud=$cloudPossible',
    async (value) => {
      const f = fixture(async (command) =>
        command === 'speech_capabilities'
          ? { ...capability, platform: value.platform }
          : { ...reply, provider: value.provider, cloudPossible: value.cloudPossible },
      );
      expect(
        await f.speech.recognize({
          language: 'en-US',
          signal: new AbortController().signal,
          deadlineMs: 16000,
          allowCloud: value.allowCloud,
        }),
      ).toEqual({ status: 'failed', reason: 'service-unavailable' });
      await f.speech.dispose();
    },
  );
  it('does not infer a Windows cloud provider from an unavailable local engine', async () => {
    const f = fixture(async () => ({
      ...capability,
      platform: 'windows',
      onDeviceAvailable: false,
      serviceAvailable: true,
    }));
    expect(await f.speech.capability()).toMatchObject({ available: false, mode: 'unknown' });
    expect(
      await f.speech.recognize({
        language: 'en-US',
        signal: new AbortController().signal,
        deadlineMs: 16000,
        allowCloud: true,
      }),
    ).toEqual({ status: 'failed', reason: 'service-unavailable' });
    expect(f.calls.some((call) => call.command === 'speech_start')).toBe(false);
  });
  it('preserves explicit Android system-service cloud consent', async () => {
    const f = fixture(async (command) =>
      command === 'speech_capabilities'
        ? { ...capability, onDeviceAvailable: false }
        : { ...reply, provider: 'android-system-service', cloudPossible: true },
    );
    expect(
      await f.speech.recognize({
        language: 'en-US',
        signal: new AbortController().signal,
        deadlineMs: 16000,
        allowCloud: true,
      }),
    ).toEqual({ status: 'final', transcript: 'Chicago Bears' });
    await f.speech.dispose();
  });
  it('uses final local reply and the same UUID for permission and capture', async () => {
    const f = fixture(async (command) =>
      command === 'speech_capabilities'
        ? { ...capability, permissionGranted: false }
        : command === 'speech_request_permission'
          ? { granted: true }
          : reply,
    );
    expect(f.calls).toEqual([]);
    expect(await start(f.speech)).toEqual({ status: 'final', transcript: 'Chicago Bears' });
    expect(f.calls.map((value) => value.command)).toEqual([
      'speech_capabilities',
      'speech_request_permission',
      'speech_start',
    ]);
    expect(f.calls[1]?.args).toEqual({ requestId: id });
    expect(f.calls[2]?.args).toEqual({ requestId: id, language: 'en-US', allowCloud: false });
    await f.speech.dispose();
  });
  it('permission refusal never starts the recognizer', async () => {
    const f = fixture(async (command) =>
      command === 'speech_capabilities'
        ? { ...capability, permissionGranted: false }
        : { granted: false },
    );
    expect(await start(f.speech)).toEqual({ status: 'failed', reason: 'permission-denied' });
    expect(f.calls.some((value) => value.command === 'speech_start')).toBe(false);
  });
  it('cancels pending permission with its UUID and ignores a late grant', async () => {
    const permission = deferred<{ granted: boolean }>();
    const controller = new AbortController();
    const f = fixture(async (command) =>
      command === 'speech_capabilities'
        ? { ...capability, permissionGranted: false }
        : command === 'speech_request_permission'
          ? permission.promise
          : undefined,
    );
    const work = start(f.speech, controller.signal);
    await vi.waitFor(() => expect(f.calls.at(-1)?.command).toBe('speech_request_permission'));
    controller.abort();
    let settled = false;
    const canceled = f.speech.cancel().then(() => {
      settled = true;
    });
    await vi.waitFor(() =>
      expect(f.calls.at(-1)).toEqual({ command: 'speech_cancel', args: { requestId: id } }),
    );
    expect(settled).toBe(false);
    permission.resolve({ granted: true });
    expect(await work).toEqual({ status: 'canceled' });
    await canceled;
    expect(f.calls.some((value) => value.command === 'speech_start')).toBe(false);
  });
  it('deadline releases capture and suppresses late final; busy cannot reopen it', async () => {
    const result = deferred<typeof reply>();
    const f = fixture(async (command) =>
      command === 'speech_capabilities'
        ? capability
        : command === 'speech_start'
          ? result.promise
          : undefined,
    );
    const work = start(f.speech);
    await vi.waitFor(() => expect(f.calls.at(-1)?.command).toBe('speech_start'));
    f.expire();
    let settled = false;
    void work.then(() => {
      settled = true;
    });
    expect(await start(f.speech)).toEqual({ status: 'failed', reason: 'service-unavailable' });
    expect(settled).toBe(false);
    result.resolve(reply);
    expect(await work).toEqual({ status: 'failed', reason: 'timeout' });
    expect(f.calls.filter((value) => value.command === 'speech_cancel')).toHaveLength(1);
  });
  it('end stops input while awaiting the final capture reply', async () => {
    const result = deferred<typeof reply>();
    const f = fixture(async (command) =>
      command === 'speech_capabilities'
        ? capability
        : command === 'speech_start'
          ? result.promise
          : undefined,
    );
    const work = start(f.speech);
    await vi.waitFor(() => expect(f.calls.at(-1)?.command).toBe('speech_start'));
    await f.speech.finish();
    expect(f.calls.at(-1)).toEqual({ command: 'speech_end', args: { requestId: id } });
    result.resolve(reply);
    expect((await work).status).toBe('final');
  });
  it.each([
    { ...reply, requestId: 'wrong' },
    { ...reply, text: 'x'.repeat(513) },
    { ...reply, text: 'bad\ntext' },
    { ...reply, provider: 'android-system-service', cloudPossible: true },
  ])('refuses malformed or unexpected cloud final replies', async (value) => {
    const f = fixture(async (command) => (command === 'speech_capabilities' ? capability : value));
    expect(await start(f.speech)).toEqual({ status: 'failed', reason: 'service-unavailable' });
  });
  it('retains an unconfirmed cleanup owner and retries the same UUID', async () => {
    const result = deferred<typeof reply>();
    let refusals = 1;
    const f = fixture(async (command) => {
      if (command === 'speech_capabilities') return capability;
      if (command === 'speech_start') return result.promise;
      if (command === 'speech_cancel' && refusals-- > 0) throw 'speech-stop-unconfirmed';
      return undefined;
    });
    const work = start(f.speech);
    await vi.waitFor(() => expect(f.calls.at(-1)?.command).toBe('speech_start'));
    const cancel = f.speech.cancel();
    result.resolve(reply);
    await expect(cancel).rejects.toThrow('could not be confirmed');
    expect(await work).toEqual({ status: 'failed', reason: 'service-unavailable' });
    expect(await start(f.speech)).toEqual({ status: 'failed', reason: 'service-unavailable' });
    await f.speech.cancel();
    expect(f.calls.filter((value) => value.command === 'speech_cancel')).toHaveLength(2);
  });
  it('unsupported Windows reports typed fallback without opening capture', async () => {
    const f = fixture(async () => ({
      ...capability,
      platform: 'windows',
      onDeviceAvailable: false,
      serviceAvailable: false,
    }));
    expect(await f.speech.capability()).toMatchObject({ available: false, reason: 'unsupported' });
    await Promise.all([f.speech.dispose(), f.speech.dispose()]);
    expect(f.calls).toHaveLength(1);
  });
  it('does not forget native unconfirmed-stop failures and retries cleanup with the same owner', async () => {
    const f = fixture(async (command) => {
      if (command === 'speech_capabilities') return capability;
      if (command === 'speech_start') throw 'speech-stop-unconfirmed';
      return undefined;
    });
    expect(await start(f.speech)).toEqual({ status: 'failed', reason: 'service-unavailable' });
    expect(await start(f.speech)).toEqual({ status: 'failed', reason: 'service-unavailable' });
    expect(f.calls.filter((value) => value.command === 'speech_start')).toHaveLength(1);
    await f.speech.cancel();
    expect(f.calls.at(-1)).toEqual({ command: 'speech_cancel', args: { requestId: id } });
  });
});
