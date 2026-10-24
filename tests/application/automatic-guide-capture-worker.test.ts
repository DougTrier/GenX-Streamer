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

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { captureAutomaticGuideInWorker } from '../../src/application/automatic-guide-capture-service';
import { captureAutomaticGuide } from '../../src/application/automatic-guide-capture';
class FakeCaptureWorker {
  static instances: FakeCaptureWorker[] = [];
  static failPost = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown;
  terminated = 0;
  constructor() {
    FakeCaptureWorker.instances.push(this);
  }
  postMessage(value: unknown) {
    if (FakeCaptureWorker.failPost) throw new Error('transfer');
    this.posted = structuredClone(value);
  }
  terminate() {
    this.terminated++;
  }
}
const snapshot = () => ({ catalog: null, preferences: null, catalogRevision: '0' });
const current = () => FakeCaptureWorker.instances.at(-1)!;
beforeEach(() => {
  FakeCaptureWorker.instances = [];
  FakeCaptureWorker.failPost = false;
  vi.stubGlobal('Worker', FakeCaptureWorker);
});
afterEach(() => vi.unstubAllGlobals());
it('terminates once before successful validated settlement and ignores duplicate completion', async () => {
  const value = snapshot();
  const pending = captureAutomaticGuideInWorker(value, new AbortController().signal);
  const worker = current();
  expect(worker.posted).toEqual(value);
  value.catalogRevision = 'changed';
  expect((worker.posted as ReturnType<typeof snapshot>).catalogRevision).toBe('0');
  const reply = captureAutomaticGuide(snapshot());
  worker.onmessage?.({ data: { ok: true, value: reply } } as MessageEvent);
  expect(await pending).toEqual(reply);
  expect(worker.terminated).toBe(1);
  worker.onmessage?.({ data: { ok: true, value: {} } } as MessageEvent);
  worker.onerror?.();
  expect(worker.terminated).toBe(1);
});
it('abort terminates exactly once and late success/error cannot publish', async () => {
  const controller = new AbortController();
  const pending = captureAutomaticGuideInWorker(snapshot(), controller.signal);
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const worker = current();
  controller.abort();
  worker.onmessage?.({
    data: { ok: true, value: captureAutomaticGuide(snapshot()) },
  } as MessageEvent);
  worker.onerror?.();
  worker.onmessageerror?.();
  await rejection;
  expect(worker.terminated).toBe(1);
});
it.each(['error', 'messageerror', 'invalid', 'worker-refusal', 'post'] as const)(
  'settles %s failures with one termination and no later callback effects',
  async (kind) => {
    FakeCaptureWorker.failPost = kind === 'post';
    const controller = new AbortController();
    const pending = captureAutomaticGuideInWorker(snapshot(), controller.signal);
    const rejection = expect(pending).rejects.toThrow();
    const worker = current();
    if (kind === 'error') worker.onerror?.();
    if (kind === 'messageerror') worker.onmessageerror?.();
    if (kind === 'invalid')
      worker.onmessage?.({ data: { ok: true, value: { catalogRevision: '0' } } } as MessageEvent);
    if (kind === 'worker-refusal')
      worker.onmessage?.({ data: { ok: false, value: null } } as MessageEvent);
    await rejection;
    controller.abort();
    worker.onmessage?.({
      data: { ok: true, value: captureAutomaticGuide(snapshot()) },
    } as MessageEvent);
    expect(worker.terminated).toBe(1);
  },
);
it('already aborted owner cannot acquire a worker', () => {
  const controller = new AbortController();
  controller.abort();
  expect(() => captureAutomaticGuideInWorker(snapshot(), controller.signal)).toThrow();
  expect(FakeCaptureWorker.instances).toHaveLength(0);
});
