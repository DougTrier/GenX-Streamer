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

import { describe, expect, it } from 'vitest';
import { checkpointFixture, checkpointProviders } from '../discovery/helpers/scan-checkpoint';
import {
  preparePackedScanCheckpoint,
  createScanCandidateManifestDecoder,
} from '../../src/discovery/scan-checkpoint';
import {
  createOwnedManifestActor,
  type ManifestWorkerCommand,
  type ManifestWorkerReply,
} from '../../src/application/scan-candidate-manifest-worker';
import {
  createScanCandidateManifestTransport,
  type ScanCandidateManifestHeader,
  type ScanCandidateManifestPage,
} from '../../src/application/scan-candidate-manifest';
import { createScanCandidateManifestClient } from '../../src/application/scan-candidate-manifest-service';
async function fixture(count = 130) {
  const {
    schemaVersion: _version,
    policyFingerprint: _policy,
    sourceDefinitions,
    ...state
  } = await checkpointFixture();
  const template = state.review.candidates[0];
  state.review.candidates = Array.from({ length: count }, (_, i) => ({
    ...template,
    key: `candidate-${i}`,
    channel: {
      ...template.channel,
      name: `Channel ${i}`,
      urls: [`https://fixture.invalid/live/private-user/private-pass/${i}?token=sentinel`],
    },
  }));
  state.review.sources[0].inspected = count;
  state.review.sources[0].matched = count;
  state.review.counts.inspected = count;
  state.review.counts.matched = count;
  state.observations = [];
  state.publishedKeys = [];
  const packed = await preparePackedScanCheckpoint({
    ...state,
    sources: sourceDefinitions.map((d) => d.source),
    providers: checkpointProviders,
  });
  return { packed, review: state.review, checkpoint: JSON.stringify(packed) };
}
const cas = { expectedCatalogRevision: '0', expectedCheckpointRevision: '0' };
const signal = () => new AbortController().signal;
class FakeWorker {
  onmessage: ((e: MessageEvent<ManifestWorkerReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  messages: ManifestWorkerCommand[] = [];
  actor: Awaited<ReturnType<typeof createOwnedManifestActor>> | null = null;
  controller = new AbortController();
  active: Promise<unknown> | null = null;
  postMessage(raw: ManifestWorkerCommand) {
    const m = structuredClone(raw);
    this.messages.push(m);
    if (m.operation === 'cancel') {
      this.controller.abort();
      return;
    }
    const job = (async () => {
      if (m.operation === 'dispose') {
        this.controller.abort();
        await Promise.allSettled([this.active]);
        this.actor?.dispose();
        return;
      }
      if (m.operation === 'capture-init' || m.operation === 'restore-init') {
        this.actor = await createOwnedManifestActor(
          m.checkpoint!,
          m.operation === 'capture-init' ? m.review : undefined,
          this.controller.signal,
          m.operation === 'capture-init',
        );
        return this.actor.info;
      }
      if (m.operation === 'next') return this.actor!.next();
      if (m.operation === 'append') return this.actor!.append(m.entries!, m.identities);
      if (m.operation === 'finish') return this.actor!.finish();
    })();
    if (m.operation !== 'dispose') this.active = job;
    void job
      .then(
        (value) =>
          this.onmessage?.({
            data: { id: m.id, ok: true, ...(value === undefined ? {} : { value }) },
          } as MessageEvent<ManifestWorkerReply>),
        () =>
          this.onmessage?.({
            data: { id: m.id, ok: false, canceled: this.controller.signal.aborted },
          } as MessageEvent<ManifestWorkerReply>),
      )
      .finally(() => {
        if (this.active === job) this.active = null;
      });
  }
  terminate() {
    expect(this.onmessage).toBeNull();
    expect(this.onerror).toBeNull();
    expect(this.onmessageerror).toBeNull();
    this.terminated = true;
  }
}
function backend(f: {
  packed: { jobId: string; reviewDigest: string; review: { candidates: unknown[] } };
}) {
  let header: ScanCandidateManifestHeader = {
    schemaVersion: 1,
    manifestId: 'manifest-id',
    manifestRevision: '0',
    jobId: f.packed.jobId,
    reviewDigest: f.packed.reviewDigest,
    candidateCount: f.packed.review.candidates.length,
    nextIndex: 0,
  };
  let sealed = false;
  const pages = new Map<number, ScanCandidateManifestPage>();
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    pages,
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args: structuredClone(args) });
      const r = args.request as {
        entries: { candidateIndex: number; urls: string[] }[];
        startIndex: number;
      };
      if (command === 'cancel_playlist') return null;
      if (command === 'scan_candidate_manifest_capabilities')
        return { schemaVersion: 1, candidateManifest: 1 };
      if (command === 'begin_scan_candidate_manifest') return { ...header };
      if (command === 'append_scan_candidate_manifest_page') {
        const startIndex = header.nextIndex;
        header = {
          ...header,
          manifestRevision: String(BigInt(header.manifestRevision) + 1n),
          nextIndex: header.nextIndex + r.entries.length,
        };
        pages.set(startIndex, {
          schemaVersion: 1,
          manifestId: header.manifestId,
          manifestRevision: header.manifestRevision,
          jobId: header.jobId,
          reviewDigest: header.reviewDigest,
          startIndex,
          nextIndex: header.nextIndex,
          entries: structuredClone(r.entries),
        });
        return { ...header };
      }
      if (command === 'seal_scan_candidate_manifest') {
        sealed = true;
        return {
          committed: true,
          catalogRevision: '0',
          healthRevision: '0',
          checkpointRevision: '1',
        };
      }
      if (command === 'find_scan_candidate_manifest')
        return sealed ? { status: 'sealed', ...header } : { schemaVersion: 1, status: 'absent' };
      if (command === 'read_scan_candidate_manifest_page')
        return { ...pages.get(r.startIndex), manifestRevision: header.manifestRevision };
      throw new Error('private-url-token-must-not-propagate');
    },
    get sealed() {
      return sealed;
    },
  };
}
describe('private scan candidate manifest frontend', () => {
  it('stages bounded pages then seals and restores the original job offline without internet', async () => {
    const f = await fixture();
    expect(f.checkpoint).not.toContain('private-pass');
    const native = backend(f);
    const workers: FakeWorker[] = [];
    const client = createScanCandidateManifestClient(native, {
      supportsManifest: true,
      workerFactory: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    });
    expect(await client.lookup(f.packed.jobId, f.packed.reviewDigest, cas, signal())).toBeNull();
    const receipt = await client.stageAndSeal(
      { ...cas, checkpoint: f.checkpoint, review: f.review },
      signal(),
    );
    expect(receipt.checkpointRevision).toBe('1');
    expect(native.sealed).toBe(true);
    expect(workers[0].messages.filter((m) => m.operation === 'capture-init')).toHaveLength(1);
    expect([...native.pages.values()].map((p) => p.entries.length)).toEqual([64, 64, 2]);
    const revisions = { ...cas, expectedCheckpointRevision: '1' };
    const header = (await client.lookup(
      f.packed.jobId,
      f.packed.reviewDigest,
      revisions,
      signal(),
    ))!;
    const runtime = await client.restore(
      {
        checkpoint: f.checkpoint,
        header,
        readPage: (start, s) => client.readPage(header, start, revisions, s),
      },
      signal(),
    );
    expect(runtime.review).toEqual(f.review);
    expect(runtime.jobId).toBe(f.packed.jobId);
    expect(runtime.observations).toEqual(f.packed.observations);
    expect(workers.every((w) => w.terminated)).toBe(true);
    expect(
      native.calls.every((c) => !c.command.includes('inspect') && !c.command.includes('fetch')),
    ).toBe(true);
  });
  it('retains exact metadata/URL order and refuses missing, swapped or modified manifest entries', async () => {
    const f = await fixture(2);
    const rows = f.review.candidates.map((c, candidateIndex) => ({
      candidateIndex,
      urls: c.channel.urls,
    }));
    for (const kind of ['missing', 'swapped', 'url', 'source-metadata'] as const) {
      const decoder = await createScanCandidateManifestDecoder(f.packed);
      const entries = structuredClone(rows);
      if (kind === 'missing') {
        await decoder.append([entries[0]], { retain: true });
        await expect(decoder.finish()).rejects.toMatchObject({ code: 'original-url-missing' });
        continue;
      }
      if (kind === 'swapped') entries.reverse();
      if (kind === 'url') entries[0].urls[0] += 'changed';
      if (kind === 'source-metadata') {
        const original = structuredClone(f.review.candidates);
        original[0].channel.name = 'changed';
        await expect(decoder.append(entries, { original })).rejects.toMatchObject({
          code: 'candidate-digest-mismatch',
        });
        continue;
      }
      await expect(decoder.append(entries)).rejects.toThrow();
    }
  });
  it('adapts page byte limits without truncating or splitting a candidate', async () => {
    const f = await fixture(12);
    for (const c of f.review.candidates)
      c.channel.urls = Array.from(
        { length: 16 },
        (_, i) => `https://fixture.invalid/${i}/` + 'x'.repeat(16000),
      );
    const { sourceDefinitions, ...state } = await checkpointFixture();
    const packed = await preparePackedScanCheckpoint({
      ...state,
      review: f.review,
      observations: [],
      publishedKeys: [],
      sources: sourceDefinitions.map((d) => d.source),
      providers: checkpointProviders,
    });
    const actor = await createOwnedManifestActor(JSON.stringify(packed), f.review, signal());
    const pages = [];
    while (true) {
      const page = await actor.next();
      if (page === null) break;
      pages.push(page);
    }
    expect(pages.flat()).toHaveLength(12);
    expect(
      pages.every(
        (p) => p.length < 64 && new TextEncoder().encode(JSON.stringify(p)).length < 1024 * 1024,
      ),
    ).toBe(true);
    actor.dispose();
  });
  it('requires an explicit supported capability; unsupported and legacy absence perform no acquisition', async () => {
    const f = await fixture(1);
    const native = backend(f);
    const client = createScanCandidateManifestClient(native, {
      supportsManifest: false,
      workerFactory: () => {
        throw new Error('must not create worker');
      },
    });
    await expect(
      client.stageAndSeal({ ...cas, checkpoint: f.checkpoint, review: f.review }, signal()),
    ).rejects.toThrow('could not be safely');
    expect(native.calls).toHaveLength(0);
    const transport = createScanCandidateManifestTransport(native);
    expect(await transport.capabilities(signal())).toEqual({
      schemaVersion: 1,
      candidateManifest: 1,
    });
  });
  it('joins held native command and cancellation before rejecting; no seal or late page publication', async () => {
    const f = await fixture(1);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let cancelRelease!: () => void;
    const canceled = new Promise<void>((r) => {
      cancelRelease = r;
    });
    const native = backend(f);
    const runtime = {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command === 'begin_scan_candidate_manifest') await held;
        if (command === 'cancel_playlist') await canceled;
        return native.invoke(command, args);
      },
    };
    const transport = createScanCandidateManifestTransport(runtime);
    const abort = new AbortController();
    let settled = false;
    const job = transport.begin(f.checkpoint, cas, abort.signal).finally(() => {
      settled = true;
    });
    const rejected = expect(job).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    release();
    await Promise.resolve();
    expect(settled).toBe(false);
    cancelRelease();
    await rejected;
    expect(native.calls.some((c) => c.command === 'seal_scan_candidate_manifest')).toBe(false);
  });
  it('preserves a confirmed durable seal receipt after late cancellation and retires its worker', async () => {
    const f = await fixture(1);
    const native = backend(f);
    const abort = new AbortController();
    const worker = new FakeWorker();
    const runtime = {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        const result = await native.invoke(command, args);
        if (command === 'seal_scan_candidate_manifest') abort.abort();
        return result;
      },
    };
    const client = createScanCandidateManifestClient(runtime, {
      supportsManifest: true,
      workerFactory: () => worker,
    });
    expect(
      await client.stageAndSeal(
        { ...cas, checkpoint: f.checkpoint, review: f.review },
        abort.signal,
      ),
    ).toMatchObject({ committed: true, checkpointRevision: '1' });
    expect(worker.terminated).toBe(true);
  });
  it('rejects forged/wrong-job headers and raw native error payloads without exposing secrets', async () => {
    const transport = createScanCandidateManifestTransport({
      invoke: async () => ({
        schemaVersion: 1,
        status: 'sealed',
        manifestId: 'manifest',
        manifestRevision: '0',
        jobId: 'different',
        reviewDigest: '0'.repeat(64),
        candidateCount: 1,
        nextIndex: 1,
      }),
    });
    await expect(transport.lookup('job', '1'.repeat(64), cas, signal())).rejects.toThrow(
      'could not be safely',
    );
    const failing = createScanCandidateManifestTransport({
      invoke: async () => {
        throw new Error('https://private:token@secret.invalid');
      },
    });
    await expect(failing.lookup('job', '1'.repeat(64), cas, signal())).rejects.toThrow(
      'Saved scan candidates could not be safely stored or read.',
    );
  });
});

it.each([13256, 63193])(
  'processes %i original candidates as bounded pages with one worker bootstrap and exact offline cold reconstruction',
  async (count) => {
    const f = await fixture(count);
    const native = backend(f);
    const workers: FakeWorker[] = [];
    const client = createScanCandidateManifestClient(native, {
      supportsManifest: true,
      workerFactory: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    });
    await client.stageAndSeal({ ...cas, checkpoint: f.checkpoint, review: f.review }, signal());
    expect(native.pages.size).toBe(Math.ceil(count / 64));
    expect(
      [...native.pages.values()].flatMap((p) => p.entries).map((r) => r.candidateIndex),
    ).toEqual(Array.from({ length: count }, (_, i) => i));
    expect(workers[0].messages.filter((m) => m.review)).toHaveLength(0);
    expect(workers[0].messages.filter((m) => m.operation === 'capture-init')).toHaveLength(1);
    expect(
      workers[0].messages
        .filter((m) => m.operation === 'append')
        .every(
          (m) =>
            m.entries!.length <= 64 &&
            new TextEncoder().encode(JSON.stringify(m)).byteLength < 1024 * 1024,
        ),
    ).toBe(true);
    expect(
      workers[0].messages
        .filter((m) => m.operation === 'next')
        .every((m) => !m.review && !m.checkpoint),
    ).toBe(true);
    const revisions = { ...cas, expectedCheckpointRevision: '1' };
    const header = (await client.lookup(
      f.packed.jobId,
      f.packed.reviewDigest,
      revisions,
      signal(),
    ))!;
    const result = await client.restore(
      {
        checkpoint: f.checkpoint,
        header,
        readPage: (start, s) => client.readPage(header, start, revisions, s),
      },
      signal(),
    );
    expect(result.review.candidates).toEqual(f.review.candidates);
    expect(result.review.query).toBe(f.review.query);
    expect(workers.every((w) => w.terminated)).toBe(true);
  },
  60000,
);
it('awaits a noncooperative read callback on Stop and never submits its late page to the worker', async () => {
  const f = await fixture(1);
  const native = backend(f);
  const worker = new FakeWorker();
  const client = createScanCandidateManifestClient(native, {
    supportsManifest: true,
    workerFactory: () => worker,
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const header: ScanCandidateManifestHeader = {
    schemaVersion: 1,
    manifestId: 'manifest-id',
    manifestRevision: '1',
    jobId: f.packed.jobId,
    reviewDigest: f.packed.reviewDigest,
    candidateCount: 1,
    nextIndex: 1,
  };
  const abort = new AbortController();
  let started = false,
    settled = false;
  const job = client
    .restore(
      {
        checkpoint: f.checkpoint,
        header,
        readPage: async () => {
          started = true;
          await gate;
          return {
            schemaVersion: 1,
            manifestId: header.manifestId,
            manifestRevision: header.manifestRevision,
            jobId: header.jobId,
            reviewDigest: header.reviewDigest,
            startIndex: 0,
            nextIndex: 1,
            entries: [{ candidateIndex: 0, urls: f.review.candidates[0].channel.urls }],
          };
        },
      },
      abort.signal,
    )
    .finally(() => {
      settled = true;
    });
  const rejected = expect(job).rejects.toMatchObject({ name: 'AbortError' });
  while (!started) await new Promise<void>((r) => setTimeout(r, 0));
  abort.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(worker.terminated).toBe(false);
  release();
  await rejected;
  expect(worker.messages.some((m) => m.operation === 'append')).toBe(false);
  expect(worker.terminated).toBe(true);
});
it('a staging failure cannot seal or report initial checkpoint acknowledgement', async () => {
  const f = await fixture(65);
  const native = backend(f);
  const worker = new FakeWorker();
  const runtime = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (command === 'append_scan_candidate_manifest_page')
        throw new Error('private staging failure');
      return native.invoke(command, args);
    },
  };
  const client = createScanCandidateManifestClient(runtime, {
    supportsManifest: true,
    workerFactory: () => worker,
  });
  await expect(
    client.stageAndSeal({ ...cas, checkpoint: f.checkpoint, review: f.review }, signal()),
  ).rejects.toThrow('could not be safely');
  expect(native.sealed).toBe(false);
  expect(native.calls.some((c) => c.command === 'seal_scan_candidate_manifest')).toBe(false);
  expect(worker.terminated).toBe(true);
});
it('decoder refuses >64 rows and oversized pages without retaining partial progress', async () => {
  const f = await fixture(65);
  const decoder = await createScanCandidateManifestDecoder(f.packed);
  await expect(
    decoder.append(
      f.review.candidates.map((c, candidateIndex) => ({ candidateIndex, urls: c.channel.urls })),
    ),
  ).rejects.toThrow();
  const first = await createScanCandidateManifestDecoder(f.packed);
  await expect(
    first.append([{ candidateIndex: 0, urls: ['x'.repeat(1024 * 1024)] }]),
  ).rejects.toThrow();
  await expect(first.finish()).rejects.toThrow();
});

it('offline reconstruction retains denied HTTP candidates without widening the captured false grant', async () => {
  const f = await fixture(2);
  f.review.candidates[1].channel.urls = ['http://fixture.invalid/denied'];
  const { sourceDefinitions, ...state } = await checkpointFixture();
  const packed = await preparePackedScanCheckpoint({
    ...state,
    review: f.review,
    observations: [],
    publishedKeys: [],
    sources: sourceDefinitions.map((d) => d.source),
    providers: checkpointProviders,
  });
  const decoder = await createScanCandidateManifestDecoder(packed);
  await decoder.append(
    f.review.candidates.map((c, candidateIndex) => ({ candidateIndex, urls: c.channel.urls })),
    { retain: true },
  );
  const runtime = await decoder.finish();
  expect(runtime.sourceDefinitions[0].source.allowHttp).toBe(false);
  expect(runtime.review.candidates[1].channel.urls).toEqual(['http://fixture.invalid/denied']);
  expect(runtime.publishedKeys).toEqual([]);
  expect(runtime.observations).toEqual([]);
});

it('enforces aggregate 64MiB URL text across many bounded pages and refuses the complete over-limit job', async () => {
  const f = await fixture(4097);
  const prefix = 'https://fixture.invalid/';
  const url = prefix + 'x'.repeat(16384 - prefix.length);
  for (const c of f.review.candidates) c.channel.urls = [url];
  const { sourceDefinitions, ...state } = await checkpointFixture();
  const packed = await preparePackedScanCheckpoint({
    ...state,
    review: f.review,
    observations: [],
    publishedKeys: [],
    sources: sourceDefinitions.map((d) => d.source),
    providers: checkpointProviders,
  });
  const decoder = await createScanCandidateManifestDecoder(packed);
  for (let start = 0; start < 4096; start += 63) {
    const end = Math.min(start + 63, 4096);
    const rows = Array.from({ length: end - start }, (_, i) => ({
      candidateIndex: start + i,
      urls: [url],
    }));
    const receipt = await decoder.append(rows);
    if (end === 4096) expect(receipt.urlBytes).toBe(64 * 1024 * 1024);
  }
  await expect(decoder.append([{ candidateIndex: 4096, urls: [url] }])).rejects.toMatchObject({
    code: 'reacquisition-limit',
  });
  expect(() => decoder.complete()).toThrow();
}, 30000);
