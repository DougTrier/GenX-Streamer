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

import { describe, expect, it, vi } from 'vitest';
import { checkpointFixture, checkpointProviders } from './helpers/scan-checkpoint';
import {
  MAX_REACQUIRED_SCAN_URL_BYTES,
  ScanReconstructionError,
  isScanReconstructionFailureCode,
  scanReconstructionFailureCode,
  prepareReferencedScanCheckpoint,
  preparePackedScanCheckpoint,
  restoreReferencedScanCheckpoint,
  restorePackedScanCheckpoint,
} from '../../src/discovery/scan-checkpoint';
import { packedReviewDigest, packedHash } from '../../src/discovery/scan-checkpoint-packed';
async function fixture() {
  const {
    schemaVersion: _schema,
    policyFingerprint: _policy,
    sourceDefinitions,
    ...state
  } = await checkpointFixture(true);
  state.review.query = 'Original';
  state.review.candidates[0].channel.name = 'Original';
  state.review.candidates[0].channel.urls = [
    'https://fixture.invalid/original?token=private-test-sentinel',
    'https://fixture.invalid/backup',
  ];
  state.review.candidates[0].channel.geography = { country: 'US', state: 'US-IL' };
  return {
    ...state,
    sources: sourceDefinitions.map((d) => d.source),
    providers: checkpointProviders,
  };
}
for (const version of [2, 3] as const) {
  describe(`immutable original-job URL reconstruction v${version}`, () => {
    const prepare = version === 2 ? prepareReferencedScanCheckpoint : preparePackedScanCheckpoint;
    const restore = version === 2 ? restoreReferencedScanCheckpoint : restorePackedScanCheckpoint;
    it('ignores added/reordered entries and metadata/warning drift, restores original query and progress exactly', async () => {
      const input = await fixture();
      const checkpoint = await prepare(input);
      const before = structuredClone(checkpoint);
      const fresh = structuredClone(input.review);
      fresh.query = '';
      fresh.sources[0].warnings = 7;
      fresh.sources[0].inspected = 2;
      fresh.sources[0].matched = 2;
      fresh.counts.inspected = 2;
      fresh.counts.matched = 2;
      const original = fresh.candidates[0];
      original.key = 'new-position';
      original.channel.name = 'Renamed';
      original.channel.providerId = 'Different.id';
      original.channel.category = 'Sports';
      original.channel.geography = { country: 'CA' };
      original.channel.geographyProvenance = [];
      original.channel.urls.reverse();
      fresh.candidates.unshift({
        ...structuredClone(original),
        key: 'new-entry',
        channel: { ...structuredClone(original.channel), urls: ['https://fixture.invalid/new'] },
      });
      const runtime = await restore(checkpoint as never, fresh);
      expect(runtime.review).toEqual(input.review);
      expect(runtime.observations).toEqual(input.observations);
      expect(runtime.publishedKeys).toEqual(input.publishedKeys);
      expect(runtime.sourceDefinitions[0].source.allowHttp).toBe(false);
      expect(runtime.policyFingerprint).toBe(checkpoint.policyFingerprint);
      expect(runtime.jobId).toBe(input.jobId);
      expect(checkpoint).toEqual(before);
    });
    it.each([
      'missing',
      'changed',
      'failed-source',
      'fingerprint',
      'unknown-source',
      'session',
    ] as const)('refuses %s without dropping settled original entries', async (kind) => {
      const input = await fixture();
      const checkpoint = await prepare(input);
      const fresh = structuredClone(input.review);
      if (kind === 'missing') fresh.candidates = [];
      if (kind === 'changed') fresh.candidates[0].channel.urls[0] += 'changed';
      if (kind === 'failed-source') {
        fresh.sources[0].status = 'failed';
        fresh.candidates = [];
      }
      if (kind === 'fingerprint') {
        fresh.sources[0].fingerprint = 'changed';
        fresh.candidates[0].sourceFingerprint = 'changed';
      }
      if (kind === 'unknown-source') {
        fresh.candidates[0].sourceId = 'unknown';
        fresh.candidates[0].channel.sourceId = 'unknown';
      }
      if (kind === 'session') {
        fresh.sessionRevision = 'changed';
        fresh.candidates[0].sessionRevision = 'changed';
      }
      await expect(restore(checkpoint as never, fresh)).rejects.toMatchObject({
        code:
          kind === 'missing' || kind === 'changed'
            ? 'original-url-missing'
            : kind === 'failed-source'
              ? 'needed-source-failed'
              : 'source-scope-mismatch',
      });
      expect(input.observations).toHaveLength(1);
      expect(checkpoint.jobId).toBe(input.jobId);
    });
    it('does not use an exact URL from another authorized source', async () => {
      const input = await fixture();
      const second = {
        ...input.sources[0],
        id: 'other-source',
        location: checkpointProviders[1].location,
      };
      input.sources.push(second);
      input.review.sources.push({
        sourceId: second.id,
        fingerprint: 'other-fingerprint',
        status: 'completed',
        inspected: 0,
        matched: 0,
        warnings: 0,
      });
      const checkpoint = await prepare(input);
      const fresh = structuredClone(input.review);
      const old = fresh.candidates[0];
      fresh.candidates = [
        {
          ...old,
          key: 'other-key',
          sourceId: second.id,
          sourceFingerprint: 'other-fingerprint',
          channel: { ...old.channel, sourceId: second.id, geography: undefined },
        },
      ];
      await expect(restore(checkpoint as never, fresh)).rejects.toMatchObject({
        code: 'original-url-missing',
      });
    });
    it('captures public inputs before async hashing and checks cancellation after a joined hash', async () => {
      const input = await fixture();
      const checkpoint = await prepare(input);
      const fresh = structuredClone(input.review);
      const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let first = true;
      const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
        if (first) {
          first = false;
          await gate;
        }
        return originalDigest(...args);
      });
      try {
        const job = restore(checkpoint as never, fresh);
        fresh.candidates[0].channel.urls[0] = 'https://fixture.invalid/mutated';
        fresh.sources[0].fingerprint = 'mutated';
        if (checkpoint.schemaVersion === 2)
          checkpoint.review.candidates[0].channel.name = 'Mutated';
        else checkpoint.review.candidates[0][3] = 'Mutated';
        release();
        expect((await job).review).toEqual(input.review);
      } finally {
        spy.mockRestore();
      }
      const abort = new AbortController();
      abort.abort();
      await expect(
        restore((await prepare(input)) as never, input.review, abort.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
    it('awaits the actual held hash before an in-flight cancellation settles', async () => {
      const input = await fixture();
      const checkpoint = await prepare(input);
      const original = crypto.subtle.digest.bind(crypto.subtle);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first = true;
      const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
        if (first) {
          first = false;
          await gate;
        }
        return original(...args);
      });
      try {
        const abort = new AbortController();
        const job = restore(checkpoint as never, input.review, abort.signal);
        let settled = false;
        const joined = job.finally(() => {
          settled = true;
        });
        const rejected = expect(joined).rejects.toMatchObject({ name: 'AbortError' });
        abort.abort();
        await Promise.resolve();
        expect(settled).toBe(false);
        release();
        await rejected;
        expect(settled).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
    it('refuses >100000 fresh candidates before reading their entries', async () => {
      const input = await fixture();
      const checkpoint = await prepare(input);
      const fresh = structuredClone(input.review);
      const candidates = Array(100001);
      let reads = 0;
      Object.defineProperty(candidates, 0, {
        get() {
          reads++;
          throw new Error('should not traverse');
        },
      });
      fresh.candidates = candidates;
      await expect(restore(checkpoint as never, fresh)).rejects.toMatchObject({
        code: 'reacquisition-limit',
      });
      expect(reads).toBe(0);
    });
  });
}
it('rejects a corrupted original candidate target even when the enclosing packed review digest is valid', async () => {
  const input = await fixture();
  const packed = await preparePackedScanCheckpoint(input);
  packed.review.candidates[0][7] = packedHash('0'.repeat(64));
  packed.reviewDigest = await packedReviewDigest(packed);
  await expect(restorePackedScanCheckpoint(packed, input.review)).rejects.toMatchObject({
    code: 'candidate-digest-mismatch',
  });
});

it('admits the exact 64 MiB Unicode URL-text boundary and refuses overflow before any hash', async () => {
  const input = await fixture();
  const prefix = 'https://fixture.invalid/';
  const bytes = 16384;
  const remainder = bytes - new TextEncoder().encode(prefix).byteLength;
  const url = prefix + 'é'.repeat(Math.floor(remainder / 2)) + 'a'.repeat(remainder % 2);
  expect(new TextEncoder().encode(url).byteLength).toBe(bytes);
  input.review.candidates[0].channel.urls = [url];
  const packed = await preparePackedScanCheckpoint(input);
  const fresh = structuredClone(input.review);
  const count = MAX_REACQUIRED_SCAN_URL_BYTES / bytes;
  fresh.candidates = Array.from({ length: count }, (_, i) => ({
    ...input.review.candidates[0],
    key: `fresh-${i}`,
    channel: { ...input.review.candidates[0].channel, urls: [url] },
  }));
  fresh.sources[0].inspected = count;
  fresh.sources[0].matched = count;
  fresh.counts.inspected = count;
  fresh.counts.matched = count;
  expect((await restorePackedScanCheckpoint(packed, fresh)).review).toEqual(input.review);
  fresh.candidates.push({ ...fresh.candidates[0], key: 'overflow' });
  const spy = vi.spyOn(crypto.subtle, 'digest');
  try {
    await expect(restorePackedScanCheckpoint(packed, fresh)).rejects.toMatchObject({
      code: 'reacquisition-limit',
    });
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

it('accepts only typed allowlisted failures and never arbitrary error messages or payloads', () => {
  const codes = [
    'reacquisition-limit',
    'reacquisition-admission',
    'source-scope-mismatch',
    'needed-source-failed',
    'original-url-missing',
    'candidate-digest-mismatch',
    'stored-checkpoint-invalid',
    'reconstructed-checkpoint-invalid',
  ] as const;
  for (const code of codes) {
    const error = new ScanReconstructionError(code);
    expect(isScanReconstructionFailureCode(code)).toBe(true);
    expect(scanReconstructionFailureCode(error)).toBe(code);
    expect(error.message).toBe('Saved scan could not safely resume. Rescan may be required.');
    expect(Object.keys(error)).toEqual(['code', 'name']);
  }
  const raw = new Error('https://secret-user:secret-pass@private.invalid/token');
  Object.assign(raw, { code: 'original-url-missing' });
  expect(scanReconstructionFailureCode(raw)).toBeNull();
  expect(scanReconstructionFailureCode({ code: 'original-url-missing' })).toBeNull();
  expect(isScanReconstructionFailureCode('private-token')).toBe(false);
  expect(() => new ScanReconstructionError('private-token' as never)).toThrow(
    'Invalid scan reconstruction failure code.',
  );
});
for (const version of [2, 3] as const) {
  it(`classifies malformed stored and reacquired data for v${version} without underlying diagnostics`, async () => {
    const input = await fixture();
    const checkpoint =
      version === 2
        ? await prepareReferencedScanCheckpoint(input)
        : await preparePackedScanCheckpoint(input);
    const restore = version === 2 ? restoreReferencedScanCheckpoint : restorePackedScanCheckpoint;
    const corrupted = structuredClone(checkpoint);
    corrupted.reviewDigest = '0'.repeat(64);
    await expect(restore(corrupted as never, input.review)).rejects.toMatchObject({
      code: 'stored-checkpoint-invalid',
    });
    const fresh = structuredClone(input.review);
    fresh.candidates[0].channel.urls = ['https://private-user:private-pass@private.invalid/path'];
    await expect(restore(checkpoint as never, fresh)).rejects.toMatchObject({
      code: 'reacquisition-admission',
      message: 'Saved scan could not safely resume. Rescan may be required.',
    });
  });
}
