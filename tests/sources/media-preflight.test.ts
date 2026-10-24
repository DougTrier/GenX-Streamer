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

import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ native: true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => api.native, invoke: api.invoke }));
import {
  inspectCheckedMediaSource,
  mediaPreflightDiagnosticsSnapshot,
} from '../../src/sources/media-preflight';
beforeEach(() => {
  api.native = true;
  api.invoke.mockReset();
});
const input = () =>
  inspectCheckedMediaSource('https://fixture.invalid/master', false, new AbortController().signal);
it('resource availability produces reachability information without a decoder claim', async () => {
  api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
    requestId: args.requestId,
    status: 'resources-responded',
    reasonCode: 'media-resources-responded',
    checkedResources: 3,
  }));
  await expect(input()).resolves.toEqual({ status: 200, kind: 'media' });
  expect(api.invoke.mock.calls[0]![0]).toBe('inspect_media_resources');
});
it('segment failure is not converted to recognized media and retains server cooldown', async () => {
  api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
    requestId: args.requestId,
    status: 'unavailable',
    reasonCode: 'http-failure',
    checkedResources: 2,
    httpStatus: 429,
    retryAfter: '60',
  }));
  await expect(input()).resolves.toEqual({ status: 429, retryAfter: '60' });
});
it.each([0, 1, 2])(
  'retains actual HTTP502 at resource depth %i without recognized-media evidence',
  async (depth) => {
    api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
      requestId: args.requestId,
      status: 'unavailable',
      reasonCode: 'resource-http-unavailable',
      checkedResources: depth + 1,
      httpStatus: 502,
    }));
    await expect(input()).resolves.toEqual({ status: 502 });
  },
);
it.each([
  ['timeout', undefined, 'timeout'],
  ['network-unavailable', undefined, 'network-failure'],
  ['resource-read-unavailable', 200, 'network-failure'],
  ['unknown-unavailable-reason', undefined, 'network-failure'],
] as const)(
  'preserves %s transport failure without fabricating HTTP status',
  async (reason, status, expected) => {
    api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
      requestId: args.requestId,
      status: 'unavailable',
      reasonCode: reason,
      checkedResources: 2,
      ...(status === undefined ? {} : { httpStatus: status }),
    }));
    await expect(input()).rejects.toBe(expected);
  },
);
it('unsupported streams remain unverified rather than fabricated decoded successes', async () => {
  api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
    requestId: args.requestId,
    status: 'unverified',
    reasonCode: 'unsupported-codec',
    checkedResources: 1,
  }));
  await expect(input()).resolves.toEqual({ status: 200, kind: 'unsupported' });
});
it.each([
  'timeout',
  'dns-failure',
  'tls-failure',
  'connectivity-failure',
  'network-failure',
  'redirect-refused',
  'url-policy-refused',
  'playlist-too-large',
  'playlist-invalid-utf8',
])('preserves only the inspector-supported fixed native category %s', async (reasonCode) => {
  for (const httpStatus of [undefined, 200]) {
    api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
      requestId: args.requestId,
      status: 'unavailable',
      reasonCode,
      checkedResources: 1,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    }));
    await expect(input()).rejects.toBe(reasonCode);
  }
});
it('unknown or malicious reason text never escapes through a fixed category', async () => {
  for (const reasonCode of ['unrecognized-native-category', 'dns-failure-secret-token']) {
    api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
      requestId: args.requestId,
      status: 'unavailable',
      reasonCode,
      checkedResources: 1,
    }));
    await expect(input()).rejects.toBe('network-failure');
  }
  for (const reasonCode of [
    'https://secret.invalid/token',
    'tls-failure\nsecret',
    'dns-failure'.repeat(20),
  ]) {
    api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
      requestId: args.requestId,
      status: 'unavailable',
      reasonCode,
      checkedResources: 1,
    }));
    const failure = await input().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'The source health check failed. Check connectivity and access restrictions.',
    );
    expect((failure as Error).message).not.toContain(reasonCode);
  }
});
it('an actual failing HTTP status remains authoritative even with a fixed transport category', async () => {
  api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
    requestId: args.requestId,
    status: 'unavailable',
    reasonCode: 'dns-failure',
    checkedResources: 1,
    httpStatus: 502,
  }));
  await expect(input()).resolves.toEqual({ status: 502 });
});
it('rejects mismatched requests, excessive resources and unsafe native diagnostic content', async () => {
  for (const change of [
    { requestId: 'other' },
    { checkedResources: 9 },
    { reasonCode: 'https://secret.invalid/token' },
    { retryAfter: '10\nunsafe' },
  ]) {
    api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
      requestId: args.requestId,
      status: 'unavailable',
      reasonCode: 'http-failure',
      checkedResources: 2,
      ...change,
    }));
    await expect(input()).rejects.toThrow('source health check failed');
  }
});
it('owned diagnostic counts real matching receipts while retaining only safe negative summaries', async () => {
  const before = mediaPreflightDiagnosticsSnapshot();
  api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
    requestId: args.requestId,
    status: 'resources-responded',
    reasonCode: 'media-resources-responded',
    checkedResources: 2,
  }));
  await expect(input()).resolves.toEqual({ status: 200, kind: 'media' });
  expect(mediaPreflightDiagnosticsSnapshot().receipts).toBe(before.receipts + 1);
  expect(mediaPreflightDiagnosticsSnapshot().negativeReceipts).toBe(before.negativeReceipts);
  for (const [reasonCode, httpStatus] of [
    ['dns-failure', undefined],
    ['resource-read-unavailable', 200],
    ['private-provider-token', undefined],
  ] as const) {
    api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
      requestId: args.requestId,
      status: 'unavailable',
      reasonCode,
      checkedResources: 2,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    }));
    await expect(input()).rejects.toBe(
      reasonCode === 'dns-failure' ? 'dns-failure' : 'network-failure',
    );
  }
  const after = mediaPreflightDiagnosticsSnapshot();
  expect(after.receipts).toBe(before.receipts + 4);
  expect(after.negativeReceipts).toBe(before.negativeReceipts + 3);
  expect(after.negatives.slice(-3).map((record) => [record.reasonCode, record.httpStatus])).toEqual(
    [
      ['dns-failure', null],
      ['resource-read-unavailable', 200],
      ['unknown', null],
    ],
  );
  expect(JSON.stringify(after)).not.toContain('private-provider-token');
  expect(
    after.negatives.every(
      (record) =>
        Object.keys(record).sort().join(',') ===
        'checkedResources,httpStatus,ordinal,reasonCode,status,timestampMs',
    ),
  ).toBe(true);
});
it('invalid or mismatched receipts never increment validated diagnostic counters', async () => {
  const before = mediaPreflightDiagnosticsSnapshot();
  for (const patch of [
    { requestId: 'foreign' },
    { checkedResources: 9 },
    { reasonCode: 'https://secret.invalid/token' },
  ]) {
    api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
      requestId: args.requestId,
      status: 'unavailable',
      reasonCode: 'dns-failure',
      checkedResources: 1,
      ...patch,
    }));
    await expect(input()).rejects.toBeInstanceOf(Error);
  }
  expect(mediaPreflightDiagnosticsSnapshot()).toEqual(before);
});
it('canceled late native receipt is excluded and actual cancellation cleanup is still joined', async () => {
  let finish!: (receipt: unknown) => void, finishCancel!: () => void;
  let requestId = '';
  api.invoke.mockImplementation((command: string, args: { requestId: string }) => {
    if (command === 'cancel_playlist')
      return new Promise<void>((resolve) => {
        finishCancel = resolve;
      });
    requestId = args.requestId;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const before = mediaPreflightDiagnosticsSnapshot(),
    abort = new AbortController();
  const work = inspectCheckedMediaSource('https://fixture.invalid/master', false, abort.signal);
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  let settled = false;
  void work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  abort.abort();
  await Promise.resolve();
  await Promise.resolve();
  finish({ requestId, status: 'unavailable', reasonCode: 'dns-failure', checkedResources: 1 });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(mediaPreflightDiagnosticsSnapshot()).toEqual(before);
  finishCancel();
  await rejected;
  expect(mediaPreflightDiagnosticsSnapshot()).toEqual(before);
});
it.each(['resources-responded', 'unavailable', 'unverified'] as const)(
  'records valid one-retry final %s without upgrading final health',
  async (status) => {
    const before = mediaPreflightDiagnosticsSnapshot();
    api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
      requestId: args.requestId,
      status,
      reasonCode:
        status === 'resources-responded' ? 'media-resources-responded' : 'network-failure',
      checkedResources: 2,
      headerRetryCount: 1,
      headerRetryReason: 'network-failure',
    }));
    if (status === 'unavailable') await expect(input()).rejects.toBe('network-failure');
    else
      await expect(input()).resolves.toEqual({
        status: 200,
        kind: status === 'resources-responded' ? 'media' : 'unsupported',
      });
    const after = mediaPreflightDiagnosticsSnapshot();
    expect(after.retriedReceipts).toBe(before.retriedReceipts + 1);
    expect(after.successfulRetryReceipts).toBe(
      before.successfulRetryReceipts + (status === 'resources-responded' ? 1 : 0),
    );
    expect(after.negativeReceipts).toBe(
      before.negativeReceipts + (status === 'resources-responded' ? 0 : 1),
    );
    expect(after.retries.at(-1)).toMatchObject({
      status,
      headerRetryCount: 1,
      headerRetryReason: 'network-failure',
    });
  },
);
it('legacy omitted retry fields continue as zero without affecting retry counters', async () => {
  const before = mediaPreflightDiagnosticsSnapshot();
  api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
    requestId: args.requestId,
    status: 'resources-responded',
    reasonCode: 'media-resources-responded',
    checkedResources: 2,
  }));
  await expect(input()).resolves.toEqual({ status: 200, kind: 'media' });
  const after = mediaPreflightDiagnosticsSnapshot();
  expect(after.retriedReceipts).toBe(before.retriedReceipts);
  expect(after.successfulRetryReceipts).toBe(before.successfulRetryReceipts);
  expect(after.retries).toEqual(before.retries);
});
it.each([
  { headerRetryCount: 1 },
  { headerRetryReason: 'network-failure' },
  { headerRetryCount: 0, headerRetryReason: 'network-failure' },
  { headerRetryCount: 2, headerRetryReason: 'network-failure' },
  { headerRetryCount: 1, headerRetryReason: 'timeout' },
  { headerRetryCount: 1, headerRetryReason: 'network-failure\nsecret' },
  { headerRetryCount: 1, headerRetryReason: 'https://secret.invalid' },
  { headerRetryCount: undefined, headerRetryReason: undefined },
  { headerRetryCount: 1, headerRetryReason: 'network-failure', checkedResources: 1 },
])('refuses malformed retry metadata without diagnostic mutation %j', async (patch) => {
  const before = mediaPreflightDiagnosticsSnapshot();
  api.invoke.mockImplementation(async (_command: string, args: { requestId: string }) => ({
    requestId: args.requestId,
    status: 'resources-responded',
    reasonCode: 'media-resources-responded',
    checkedResources: 2,
    ...patch,
  }));
  await expect(input()).rejects.toThrow(
    'The source health check failed. Check connectivity and access restrictions.',
  );
  expect(mediaPreflightDiagnosticsSnapshot()).toEqual(before);
});
it('canceled late retry receipt joins actual cancel and contributes no success or retry evidence', async () => {
  let finish!: (value: unknown) => void,
    finishCancel!: () => void,
    requestId = '';
  const before = mediaPreflightDiagnosticsSnapshot(),
    abort = new AbortController();
  api.invoke.mockImplementation((command: string, args: { requestId: string }) => {
    if (command === 'cancel_playlist')
      return new Promise<void>((r) => {
        finishCancel = r;
      });
    requestId = args.requestId;
    return new Promise((r) => {
      finish = r;
    });
  });
  let settled = false;
  const work = inspectCheckedMediaSource('https://fixture.invalid/master', false, abort.signal);
  const result = work.catch((error) => {
    settled = true;
    return error;
  });
  abort.abort();
  await Promise.resolve();
  await Promise.resolve();
  finish({
    requestId,
    status: 'resources-responded',
    reasonCode: 'media-resources-responded',
    checkedResources: 3,
    headerRetryCount: 1,
    headerRetryReason: 'network-failure',
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(mediaPreflightDiagnosticsSnapshot()).toEqual(before);
  finishCancel();
  expect(await result).toMatchObject({ name: 'AbortError' });
  expect(mediaPreflightDiagnosticsSnapshot()).toEqual(before);
});
it('an expired late native retry success contributes no diagnostics and retains timeout truth', async () => {
  vi.useFakeTimers();
  try {
    let finish!: (value: unknown) => void,
      requestId = '';
    const before = mediaPreflightDiagnosticsSnapshot();
    api.invoke.mockImplementation((command: string, args: { requestId: string }) => {
      if (command === 'cancel_playlist') return Promise.resolve();
      requestId = args.requestId;
      return new Promise((r) => {
        finish = r;
      });
    });
    const work = input();
    const result = work.catch((error) => error);
    await vi.advanceTimersByTimeAsync(20000);
    finish({
      requestId,
      status: 'resources-responded',
      reasonCode: 'media-resources-responded',
      checkedResources: 3,
      headerRetryCount: 1,
      headerRetryReason: 'network-failure',
    });
    expect(await result).toBe('timeout');
    expect(mediaPreflightDiagnosticsSnapshot()).toEqual(before);
  } finally {
    vi.useRealTimers();
  }
});
