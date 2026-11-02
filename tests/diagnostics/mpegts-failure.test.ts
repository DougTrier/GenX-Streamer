// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { mpegtsExceptionKind, mpegtsFailureProvenance } from '../../src/diagnostics/mpegts-failure';

it.each([
  ['Failed to fetch', 'fetch-failed'],
  ['TypeError: fetch failed', 'fetch-failed'],
  ['NetworkError when attempting to fetch resource.', 'fetch-failed'],
  ['network error', 'network-error'],
  ['The user aborted a request.', 'aborted'],
  ['AbortError: The operation was aborted.', 'aborted'],
  ['TimeoutError: The operation timed out.', 'timeout'],
  ['The operation was aborted due to timeout', 'timeout'],
  ['Array buffer allocation failed', 'arraybuffer-allocation'],
  ['RangeError: Invalid array buffer length', 'arraybuffer-allocation'],
  ['Invalid typed array length: 188', 'typedarray-bounds'],
  ['RangeError: offset is outside the bounds of the DataView', 'dataview-bounds'],
  [
    "Failed to construct 'DataView': Start offset 188 is outside the bounds of the buffer",
    'dataview-bounds',
  ],
  ['RangeError: Invalid DataView length 188', 'dataview-bounds'],
  ['Out of memory', 'memory'],
  ['InternalError: allocation size overflow', 'memory'],
  ['TypeError: unexpected operation https://user:secret@provider.invalid/token', 'type-error'],
  ["Cannot read properties of undefined (reading 'length')", 'type-error'],
  ['https://user:secret@provider.invalid/token', 'unknown'],
  ['unfamiliar provider failure password', 'unknown'],
  ['network error' + 'x'.repeat(2048), 'unknown'],
] as const)('buckets %s as a fixed %s category', (message, expected) => {
  expect(mpegtsExceptionKind(message)).toBe(expected);
});

it('retains bounded loader and media facts without reading secret fields or getters', () => {
  const poison = () => {
    throw new Error('secret getter must not be read');
  };
  const info = Object.freeze({
    code: -1,
    msg: 'Array buffer allocation failed',
    get url() {
      return poison();
    },
    get stack() {
      return poison();
    },
  });
  const before = Object.getOwnPropertyDescriptors(info);
  const video = {
    readyState: 4,
    networkState: 2,
    error: { code: 2 },
    videoWidth: 1920,
    videoHeight: 1080,
    currentTime: 224.215,
    buffered: { length: 1, start: () => 200, end: () => 241.62 },
    getVideoPlaybackQuality: () =>
      Object.create({
        get totalVideoFrames() {
          return 13443;
        },
        get droppedVideoFrames() {
          return 12;
        },
      }),
  } as unknown as HTMLVideoElement;
  const facts = mpegtsFailureProvenance(
    'network',
    info,
    video,
    () => ({
      loaderType: 'fetch-stream-loader',
      url: 'https://user:secret@provider.invalid/token',
    }),
    false,
  );
  expect(facts).toMatchObject({
    initiator: 'engine',
    libraryErrorType: 'network',
    ownerAborted: false,
    loaderKind: 'fetch-stream',
    exceptionKind: 'arraybuffer-allocation',
    loaderCode: -1,
    readyState: 4,
    networkState: 2,
    mediaErrorCode: 2,
    totalFrames: 13443,
    droppedFrames: 12,
    positionMs: 224215,
  });
  expect(facts.bufferedAheadMs).toBeCloseTo(17405);
  expect(JSON.stringify(facts)).not.toMatch(/secret|provider|https|url|stack|allocation failed/);
  expect(Object.getOwnPropertyDescriptors(info)).toEqual(before);
});

it.each([-1, 0, 20, 999])('preserves safe library code %s', (code) => {
  expect(
    mpegtsFailureProvenance('unknown', { code }, {} as HTMLVideoElement, () => null, true),
  ).toMatchObject({
    loaderCode: code,
    ownerAborted: true,
    loaderKind: 'unknown',
    exceptionKind: 'unknown',
  });
});

it.each([-2, 1000, 1.5, NaN, Infinity, '20'])(
  'omits invalid library code %s and untrusted loader strings',
  (code) => {
    const facts = mpegtsFailureProvenance(
      'unknown',
      {
        code,
        get msg() {
          throw Error('private');
        },
      },
      {
        readyState: 5,
        networkState: -1,
        error: { code: 99 },
        currentTime: Infinity,
        videoWidth: -1,
        videoHeight: NaN,
        getVideoPlaybackQuality: () => ({ totalVideoFrames: 12, droppedVideoFrames: 13 }),
      } as unknown as HTMLVideoElement,
      () => ({ loaderType: 'https://private.invalid/token' }),
      false,
    );
    expect(facts).toEqual({
      initiator: 'engine',
      libraryErrorType: 'unknown',
      ownerAborted: false,
      loaderKind: 'unknown',
      exceptionKind: 'unknown',
      totalFrames: 12,
    });
  },
);

it.each([
  ['xhr-range-loader', 'xhr-range'],
  ['xhr-moz-chunked-loader', 'moz-chunked'],
  ['websocket-loader', 'websocket'],
  ['__proto__', 'unknown'],
])('admits only known loader kind %s', (loaderType, loaderKind) => {
  expect(
    mpegtsFailureProvenance('media', null, {} as HTMLVideoElement, () => ({ loaderType }), false)
      .loaderKind,
  ).toBe(loaderKind);
});

it('survives released video/statistics getters and malformed ranges without changing playback', () => {
  const video = {
    currentTime: 5,
    buffered: {
      length: 2,
      start: () => {
        throw Error('released');
      },
    },
    get readyState() {
      throw Error('released');
    },
    get getVideoPlaybackQuality() {
      throw Error('released');
    },
  } as unknown as HTMLVideoElement;
  expect(
    mpegtsFailureProvenance(
      'network',
      null,
      video,
      () => {
        throw Error('disposed');
      },
      false,
    ),
  ).toEqual({
    initiator: 'engine',
    libraryErrorType: 'network',
    ownerAborted: false,
    loaderKind: 'unknown',
    exceptionKind: 'unknown',
    positionMs: 5000,
  });
});
