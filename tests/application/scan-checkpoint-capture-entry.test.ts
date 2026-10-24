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

import { afterEach, expect, it, vi } from 'vitest';
import { ScanReconstructionError } from '../../src/discovery/scan-checkpoint';

const state = vi.hoisted(() => ({ failure: null as unknown }));
vi.mock('../../src/application/discovery/scan-checkpoint-capture', () => {
  const capture = () => Promise.reject(state.failure);
  return {
    captureScanCheckpoint: capture,
    captureInitialProgressCheckpoint: capture,
    captureInitialPackedProgressCheckpoint: capture,
    parseCapturedScanCheckpoint: capture,
    captureStoredScanCheckpoint: capture,
    parseStoredCapturedScanCheckpoint: capture,
    restoreReferencedCapturedScanCheckpoint: capture,
    restorePackedCapturedScanCheckpoint: capture,
  };
});
afterEach(() => vi.unstubAllGlobals());

it('worker strips arbitrary exception details and codes outside restoration operations', async () => {
  const endpoint = {
    onmessage: null as ((event: MessageEvent) => Promise<void>) | null,
    postMessage: vi.fn(),
  };
  vi.stubGlobal('self', endpoint);
  await import('../../src/application/discovery/scan-checkpoint-capture-worker');
  for (const operation of ['restore-reference', 'restore-packed-reference']) {
    state.failure = new ScanReconstructionError('needed-source-failed');
    await endpoint.onmessage!({ data: { operation, input: null } } as MessageEvent);
    expect(endpoint.postMessage).toHaveBeenLastCalledWith({
      operation,
      ok: false,
      reconstructionFailure: 'needed-source-failed',
    });
    state.failure = Object.assign(new Error('https://private.invalid/?credential=secret'), {
      code: 'needed-source-failed',
    });
    await endpoint.onmessage!({ data: { operation, input: null } } as MessageEvent);
    expect(endpoint.postMessage).toHaveBeenLastCalledWith({ operation, ok: false });
  }
  for (const operation of ['prepare', 'parse']) {
    state.failure = new ScanReconstructionError('needed-source-failed');
    await endpoint.onmessage!({ data: { operation, input: 'wire' } } as MessageEvent);
    expect(endpoint.postMessage).toHaveBeenLastCalledWith({ operation, ok: false });
  }
  expect(JSON.stringify(endpoint.postMessage.mock.calls)).not.toMatch(/private|credential|secret/u);
});
