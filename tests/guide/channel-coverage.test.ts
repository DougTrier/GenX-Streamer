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
import {
  validateChannelCoverageReply,
  validateChannelCoverageRequest,
  type ChannelCoverageRequest,
} from '../../src/guide/channel-coverage';
const request: ChannelCoverageRequest = {
  schemaVersion: 1,
  sourceId: 'source',
  xmltvChannelId: 'channel',
  startMs: 1000,
  endMs: 1100,
  expectedSourceRevision: 3,
  expectedPublishedRevision: 3,
};
const assessed = () => ({
  schemaVersion: 1,
  startMs: 1000,
  endMs: 1100,
  status: 'assessed',
  reason: null,
  sourceRevision: 3,
  publishedRevision: 3,
  coveredMs: 70,
  gapCount: 2,
  unknownEndCount: 0,
  gaps: [
    { startMs: 1000, endMs: 1010 },
    { startMs: 1080, endMs: 1100 },
  ],
  gapsComplete: true,
});
const notAssessed = (reason: string) => ({
  ...assessed(),
  status: 'not-assessed',
  reason,
  coveredMs: null,
  gapCount: null,
  unknownEndCount: null,
  gaps: [],
  gapsComplete: false,
});
const validate = (v: unknown) => validateChannelCoverageReply(v, request);
describe('channel interval coverage contract', () => {
  it('owns and freezes the request, gaps and reply without claiming accuracy', () => {
    const q = { ...request };
    const input = assessed();
    const output = validateChannelCoverageReply(input, q);
    q.sourceId = 'changed';
    input.gaps[0]!.endMs = 1009;
    expect(output.gaps[0]!.endMs).toBe(1010);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.gaps)).toBe(true);
    expect(Object.isFrozen(output.gaps[0])).toBe(true);
    expect(validateChannelCoverageRequest(request)).toEqual(request);
  });
  it('accepts full coverage, empty cache and unknown ends without inferred duration', () => {
    expect(validate({ ...assessed(), coveredMs: 100, gapCount: 0, gaps: [] })).toMatchObject({
      coveredMs: 100,
    });
    expect(
      validate({
        ...assessed(),
        coveredMs: 0,
        gapCount: 1,
        gaps: [{ startMs: 1000, endMs: 1100 }],
        unknownEndCount: 4096,
      }),
    ).toMatchObject({ coveredMs: 0, unknownEndCount: 4096 });
  });
  it('accepts bounded eight-gap preview with an explicitly incomplete remainder', () => {
    const gaps = Array.from({ length: 8 }, (_, i) => ({
      startMs: 1000 + i * 2,
      endMs: 1001 + i * 2,
    }));
    expect(
      validate({ ...assessed(), coveredMs: 91, gapCount: 9, gaps, gapsComplete: false }),
    ).toMatchObject({ gapCount: 9, gapsComplete: false });
  });
  it.each(['channel-missing', 'work-limit'])('accepts exact-revision unassessed %s', (reason) => {
    expect(validate(notAssessed(reason))).toMatchObject({ reason, coveredMs: null });
  });
  it('accepts missing source and stale unpublished or mismatched source without assessment', () => {
    expect(
      validate({ ...notAssessed('source-missing'), sourceRevision: null, publishedRevision: null }),
    ).toMatchObject({ reason: 'source-missing' });
    expect(validate({ ...notAssessed('source-stale'), publishedRevision: null })).toMatchObject({
      reason: 'source-stale',
    });
    expect(
      validate({ ...notAssessed('source-stale'), sourceRevision: 4, publishedRevision: 4 }),
    ).toMatchObject({ reason: 'source-stale' });
  });
  it('accepts native UTC boundaries and exactly seven days', () => {
    expect(
      validateChannelCoverageRequest({
        ...request,
        startMs: -62135647200000,
        endMs: -62135647200000 + 604800000,
      }),
    ).toBeDefined();
    expect(
      validateChannelCoverageRequest({
        ...request,
        startMs: 253402351199999,
        endMs: 253402351200000,
      }),
    ).toBeDefined();
  });
  it.each([
    { schemaVersion: 2 },
    { extra: 1 },
    { sourceId: '' },
    { sourceId: 'a\n' },
    { sourceId: 'é'.repeat(129) },
    { xmltvChannelId: 'é'.repeat(8193) },
    { startMs: NaN },
    { startMs: -62135647200001 },
    { endMs: 253402351200001 },
    { endMs: 1000 },
    { endMs: 1000 + 604800001 },
    { expectedSourceRevision: -1 },
    { expectedPublishedRevision: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects malformed request %j', (delta) => {
    expect(() => validateChannelCoverageRequest({ ...request, ...delta })).toThrow(
      'Program guide interval coverage is invalid.',
    );
  });
  it.each([
    { schemaVersion: 2 },
    { startMs: 999 },
    { endMs: 1101 },
    { extra: 1 },
    { status: 'usable' },
    { reason: 'accurate' },
    { reason: 'source-missing' },
    { sourceRevision: 4 },
    { publishedRevision: null },
    { publishedRevision: 4 },
    { coveredMs: 101 },
    { coveredMs: -1 },
    { coveredMs: 1.5 },
    { gapCount: 0 },
    { gapCount: 3 },
    { unknownEndCount: 4097 },
    { unknownEndCount: 4096 },
    { gapsComplete: false },
    { gaps: [] },
    {
      gaps: [
        { startMs: 999, endMs: 1009 },
        { startMs: 1080, endMs: 1100 },
      ],
    },
    {
      gaps: [
        { startMs: 1000, endMs: 1010, extra: true },
        { startMs: 1080, endMs: 1100 },
      ],
    },
    {
      gaps: [
        { startMs: 1080, endMs: 1100 },
        { startMs: 1000, endMs: 1010 },
      ],
    },
    {
      gaps: [
        { startMs: 1000, endMs: 1090 },
        { startMs: 1080, endMs: 1100 },
      ],
    },
    {
      gaps: [
        { startMs: 1000, endMs: 1000 },
        { startMs: 1080, endMs: 1100 },
      ],
    },
  ])('rejects incoherent assessed reply %j', (delta) => {
    expect(() => validate({ ...assessed(), ...delta })).toThrow();
  });
  it.each([
    { reason: null },
    { reason: 'source-missing' },
    { reason: 'source-stale' },
    { coveredMs: 0 },
    { gapCount: 0 },
    { unknownEndCount: 0 },
    { gapsComplete: true },
    { gaps: [{ startMs: 1000, endMs: 1010 }] },
    { sourceRevision: null },
  ])('rejects incoherent unassessed reply %j', (delta) => {
    expect(() => validate({ ...notAssessed('channel-missing'), ...delta })).toThrow();
  });
  it('refuses assessment when expected source and publication differ', () => {
    expect(() =>
      validateChannelCoverageReply(assessed(), { ...request, expectedPublishedRevision: 2 }),
    ).toThrow();
  });
  it('rejects forged complete and incomplete gap sums/counts', () => {
    const gaps = Array.from({ length: 8 }, (_, i) => ({
      startMs: 1000 + i * 2,
      endMs: 1001 + i * 2,
    }));
    for (const delta of [
      { coveredMs: 92 },
      { gapCount: 8 },
      { gapsComplete: true },
      { gapCount: 10, coveredMs: 91 },
      { gaps: gaps.slice(0, 7) },
    ])
      expect(() =>
        validate({
          ...assessed(),
          coveredMs: 91,
          gapCount: 9,
          gaps,
          gapsComplete: false,
          ...delta,
        }),
      ).toThrow();
    expect(() => validate({ ...assessed(), coveredMs: 0, gapCount: 2 })).toThrow();
  });
  it('rejects inherited fields, symbols, sparse arrays and accessors without invoking them', () => {
    const read = vi.fn(() => 3);
    const input = assessed();
    Object.defineProperty(input, 'sourceRevision', { get: read });
    expect(() => validate(input)).toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(() => validate(Object.assign(Object.create({ hidden: true }), assessed()))).toThrow();
    expect(() => validate({ ...assessed(), [Symbol('extra')]: true })).toThrow();
    expect(() => validate({ ...assessed(), gaps: new Array(2) })).toThrow();
    const gaps = assessed().gaps;
    Object.defineProperty(gaps, 0, { get: read });
    expect(() => validate({ ...assessed(), gaps })).toThrow();
    expect(read).not.toHaveBeenCalled();
    const conversion = vi.fn();
    expect(() => validate({ ...assessed(), status: { toString: conversion } })).toThrow();
    expect(conversion).not.toHaveBeenCalled();
  });
});
import { createChannelCoverageAdapter, ChannelCoverageCleanupError } from '../../src/guide/native';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe('owned native channel coverage adapter', () => {
  it('dispatches an owned query with one opaque requestId and validates reply', async () => {
    const invoke = vi.fn(async () => assessed());
    const read = createChannelCoverageAdapter({ isNative: () => true, invoke });
    expect(await read(request, new AbortController().signal)).toMatchObject({ coveredMs: 70 });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, args] = invoke.mock.calls[0]! as unknown as [
      string,
      { query: ChannelCoverageRequest; requestId: string },
    ];
    expect(command).toBe('guide_channel_coverage');
    expect(args.query).toEqual(request);
    expect(args.query).not.toBe(request);
    expect(Object.keys(args).sort()).toEqual(['query', 'requestId']);
    expect(args.requestId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('rejects malformed replies and redacts rejected native text', async () => {
    const malformed = createChannelCoverageAdapter({
      isNative: () => true,
      invoke: async () => ({ ...assessed(), coveredMs: 101 }),
    });
    await expect(malformed(request, new AbortController().signal)).rejects.toThrow(
      'Program guide interval coverage is invalid.',
    );
    const fail = createChannelCoverageAdapter({
      isNative: () => true,
      invoke: async () => {
        throw 'https://private.invalid/secret';
      },
    });
    await expect(fail(request, new AbortController().signal)).rejects.toThrow(
      'Program guide could not refresh. Retry or review Guide.',
    );
  });
  it('refuses preaborted or browser acquisition without invoke', async () => {
    const invoke = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createChannelCoverageAdapter({ isNative: () => true, invoke })(request, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      createChannelCoverageAdapter({ isNative: () => false, invoke })(
        request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'SelectedGuideUnavailableError' });
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each(['main-first', 'cancel-first'])(
    'joins both actual operations, suppresses late valid reply: %s',
    async (order) => {
      const main = deferred<unknown>(),
        cancel = deferred<unknown>(),
        controller = new AbortController();
      const invoke = vi.fn((command: string) =>
        command === 'cancel_playlist' ? cancel.promise : main.promise,
      );
      let settled = false;
      const work = createChannelCoverageAdapter({ isNative: () => true, invoke })(
        request,
        controller.signal,
      );
      const result = work.then(
        () => {
          settled = true;
          return 'unexpected';
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      controller.abort();
      await Promise.resolve();
      expect(invoke).toHaveBeenCalledTimes(2);
      const args = invoke.mock.calls as unknown as [string, { requestId: string }][];
      expect(args[0]![1].requestId).toBe(args[1]![1].requestId);
      if (order === 'main-first') main.resolve(assessed());
      else cancel.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      if (order === 'main-first') cancel.resolve(undefined);
      else main.resolve(assessed());
      expect(await result).toMatchObject({ name: 'AbortError' });
    },
  );
  it('retains cancellation rejection until actual main settlement and reports typed cleanup', async () => {
    const main = deferred<unknown>(),
      cancel = deferred<unknown>(),
      controller = new AbortController();
    const read = createChannelCoverageAdapter({
      isNative: () => true,
      invoke: (command) => (command === 'cancel_playlist' ? cancel.promise : main.promise),
    });
    let settled = false;
    const result = read(request, controller.signal).then(
      () => {
        settled = true;
        return null;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    controller.abort();
    await Promise.resolve();
    cancel.reject('https://private.invalid/secret');
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    main.resolve(assessed());
    const error = await result;
    expect(error).toBeInstanceOf(ChannelCoverageCleanupError);
    expect(error.message).toBe('Program guide cancellation could not finish. Retry closing.');
  });
  it('allows work-limit unknown revisions only as an unassessed pair', () => {
    expect(
      validate({ ...notAssessed('work-limit'), sourceRevision: null, publishedRevision: null }),
    ).toMatchObject({ status: 'not-assessed', coveredMs: null });
    for (const revisions of [
      { sourceRevision: null, publishedRevision: 3 },
      { sourceRevision: 3, publishedRevision: null },
      { sourceRevision: 4, publishedRevision: 4 },
    ])
      expect(() => validate({ ...notAssessed('work-limit'), ...revisions })).toThrow();
  });
});
