// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import type { TraceValues } from './playback-trace';

/** Library messages may contain addresses or credentials. Only fixed categories escape. */
export function mpegtsExceptionKind(message: unknown): string {
  if (typeof message !== 'string' || message.length > 2048) return 'unknown';
  const text = message.trim();
  if (
    /^(?:RangeError:\s*)?(?:array\s?buffer allocation failed|invalid array\s?buffer length)\b/i.test(
      text,
    )
  )
    return 'arraybuffer-allocation';
  if (
    /(?:invalid typed array length|offset is outside the bounds of the typed array|(?:start offset|byte length) of \w+Array should be a multiple of|typed\s?array.*out of bounds)/i.test(
      text,
    )
  )
    return 'typedarray-bounds';
  if (
    /(?:offset is outside the bounds of the DataView|invalid DataView length|(?:DataView|data view).*(?:out of bounds|outside the bounds))/i.test(
      text,
    )
  )
    return 'dataview-bounds';
  if (
    /^(?:(?:Range|Internal)Error:\s*)?(?:out of memory|memory allocation failed|allocation size overflow)\b/i.test(
      text,
    )
  )
    return 'memory';
  if (
    /^(?:TypeError:\s*)?(?:failed to fetch|fetch failed|load failed|NetworkError when attempting to fetch resource\.?)$/i.test(
      text,
    )
  )
    return 'fetch-failed';
  if (/^(?:TypeError:\s*)?(?:network error|network request failed|NetworkError)$/i.test(text))
    return 'network-error';
  if (
    /^(?:AbortError:\s*)?(?:the (?:operation|request) was aborted|the user aborted a request|signal is aborted without reason)\.?$/i.test(
      text,
    )
  )
    return 'aborted';
  if (
    /^(?:TimeoutError:\s*)?(?:the (?:operation|request) (?:was |has )?timed out|the operation was aborted due to timeout|signal timed out|timeout|timed out)\.?$/i.test(
      text,
    )
  )
    return 'timeout';
  if (
    /^(?:TypeError:|cannot (?:read|set) propert(?:y|ies)\b|undefined is not (?:an object|a function)\b)/i.test(
      text,
    )
  )
    return 'type-error';
  return 'unknown';
}

const data = (value: unknown, key: string): unknown =>
  value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
const integer = (value: unknown, maximum: number, minimum = 0): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
const read = (work: () => unknown): unknown => {
  try {
    return work();
  } catch {
    return undefined;
  }
};

/** Snapshot before recovery aborts the owner. This never changes playback policy. */
export function mpegtsFailureProvenance(
  libraryErrorType: 'network' | 'media' | 'unknown',
  info: unknown,
  video: HTMLVideoElement,
  statistics: () => unknown,
  ownerAborted: boolean,
): TraceValues {
  const kinds: Record<string, string> = {
    'fetch-stream-loader': 'fetch-stream',
    'xhr-range-loader': 'xhr-range',
    'xhr-moz-chunked-loader': 'moz-chunked',
    'websocket-loader': 'websocket',
  };
  const loader = read(() => data(statistics(), 'loaderType'));
  const facts: TraceValues = {
    initiator: 'engine',
    libraryErrorType,
    ownerAborted,
    loaderKind:
      typeof loader === 'string' && Object.hasOwn(kinds, loader) ? kinds[loader]! : 'unknown',
    exceptionKind: mpegtsExceptionKind(read(() => data(info, 'msg'))),
  };
  const code = read(() => data(info, 'code'));
  if (integer(code, 999, -1)) facts.loaderCode = code;
  for (const [key, maximum, value] of [
    ['readyState', 4, read(() => video.readyState)],
    ['networkState', 3, read(() => video.networkState)],
    ['mediaErrorCode', 4, read(() => video.error?.code)],
    ['videoWidth', 16384, read(() => video.videoWidth)],
    ['videoHeight', 16384, read(() => video.videoHeight)],
  ] as const)
    if (integer(value, maximum, key === 'mediaErrorCode' ? 1 : 0)) facts[key] = value;
  const position = read(() => video.currentTime);
  if (
    typeof position === 'number' &&
    Number.isFinite(position) &&
    position >= 0 &&
    position <= Number.MAX_SAFE_INTEGER / 1000
  ) {
    facts.positionMs = position * 1000;
    const ahead = read(() => {
      const ranges = video.buffered;
      if (!integer(ranges.length, 64, 1)) return undefined;
      for (let i = 0; i < ranges.length; i++) {
        const start = ranges.start(i),
          end = ranges.end(i);
        if (
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          start >= 0 &&
          end >= start &&
          start <= position + 0.1 &&
          position <= end &&
          end - position <= Number.MAX_SAFE_INTEGER / 1000
        )
          return (end - position) * 1000;
      }
      return 0;
    });
    if (typeof ahead === 'number') facts.bufferedAheadMs = ahead;
  }
  const quality = read(() => video.getVideoPlaybackQuality?.()) as VideoPlaybackQuality | undefined;
  const total = read(() => quality?.totalVideoFrames);
  const dropped = read(() => quality?.droppedVideoFrames);
  if (integer(total, Number.MAX_SAFE_INTEGER)) {
    facts.totalFrames = total;
    if (integer(dropped, total)) facts.droppedFrames = dropped;
  }
  return facts;
}
