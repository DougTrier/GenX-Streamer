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
import {
  classifyScanPreparationFailure,
  isScanPreparationFailureCode,
} from '../../src/discovery/selection-failure';
import { defaultPreferences } from '../../src/preferences';
import { prepareScanInWorker } from '../../src/discovery/selection';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it.each([
  ['Invalid media MIME type.', 'prepare-source-mime'],
  ['Reviewed health ownership or canonical mapping changed.', 'prepare-health-ownership'],
  ['Duplicate catalog channel identity.', 'prepare-catalog-validation'],
  ['Invalid preferred region.', 'prepare-preferences-validation'],
  ['Health HTTP evidence is invalid.', 'prepare-health-validation'],
  ['Catalog exceeds the 20 MiB storage limit.', 'prepare-capacity'],
])('classifies exact owned validation failure %s', (message, code) => {
  expect(classifyScanPreparationFailure(new Error(message))).toBe(code);
});
it('never exposes arbitrary errors, payloads, inherited map names or engine messages', () => {
  for (const failure of [
    new Error('https://user:SECRET@private.invalid'),
    new Error('toString'),
    'Invalid media MIME type.',
    { message: 'Invalid media MIME type.' },
  ])
    expect(classifyScanPreparationFailure(failure)).toBe('prepare-unknown');
  expect(classifyScanPreparationFailure(new DOMException('SECRET', 'NotSupportedError'))).toBe(
    'prepare-runtime-unsupported',
  );
  expect(classifyScanPreparationFailure(new DOMException('SECRET', 'OperationError'))).toBe(
    'prepare-crypto-failed',
  );
  expect(isScanPreparationFailureCode('prepare-source-mime SECRET')).toBe(false);
});
it('actual worker catch classifies invalid persisted catalog without returning its payload', async () => {
  const postMessage = vi.fn();
  vi.stubGlobal('self', { postMessage, onmessage: null });
  await import('../../src/discovery/selection-worker');
  self.onmessage?.({
    data: {
      catalog: { schemaVersion: 1, sources: [], channels: [{ id: 'SECRET' }] },
      preferences: defaultPreferences(),
      selection: { sessionRevision: '1', sources: [], failedSourceIds: [] },
      scope: [],
    },
  } as MessageEvent);
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
  expect(postMessage.mock.calls[0]?.[0]).toEqual({ ok: false, code: 'prepare-catalog-validation' });
  expect(JSON.stringify(postMessage.mock.calls)).not.toContain('SECRET');
});
it.each(['prepare-health-ownership', 'https://user:SECRET@private.invalid', undefined])(
  'service accepts only fixed worker failure codes and terminates once (%s)',
  async (code) => {
    const holder: { current?: { onmessage: ((event: MessageEvent) => void) | null } } = {};
    const terminate = vi.fn();
    class WorkerFixture {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      constructor() {
        holder.current = this;
      }
      postMessage() {}
      terminate = terminate;
    }
    vi.stubGlobal('Worker', WorkerFixture);
    const pending = prepareScanInWorker(
      { schemaVersion: 1, sources: [], channels: [] },
      defaultPreferences(),
      { sessionRevision: '1', sources: [], failedSourceIds: [] },
      [],
      new AbortController().signal,
    );
    const assertion = expect(pending).rejects.toThrow(
      code === 'prepare-health-ownership' ? code : 'prepare-worker-protocol',
    );
    holder.current!.onmessage?.({ data: { ok: false, code, message: 'SECRET' } } as MessageEvent);
    await assertion;
    expect(terminate).toHaveBeenCalledTimes(1);
  },
);
