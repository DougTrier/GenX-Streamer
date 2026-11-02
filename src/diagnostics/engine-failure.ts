// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import type { TraceValues } from './playback-trace';
/** Library messages may contain provider URLs. Retain only known categories/numbers. */
export function engineFailureFacts(
  transport: 'mpegts' | 'hls' | 'html5',
  detail: unknown,
  info?: unknown,
): TraceValues {
  const known: Record<string, string> = {
    Exception: 'network-exception',
    HttpStatusCodeInvalid: 'http-status',
    ConnectingTimeout: 'connect-timeout',
    UnrecoverableEarlyEof: 'early-eof',
    EarlyEof: 'early-eof',
    MediaMSEError: 'mse-error',
    FormatError: 'format-error',
    FormatUnsupported: 'unsupported-format',
    CodecUnsupported: 'unsupported-codec',
    manifestLoadError: 'manifest-error',
    manifestLoadTimeOut: 'manifest-timeout',
    levelLoadError: 'playlist-error',
    levelLoadTimeOut: 'playlist-timeout',
    fragLoadError: 'segment-error',
    fragLoadTimeOut: 'segment-timeout',
    fragParsingError: 'format-error',
    bufferAppendError: 'mse-error',
    bufferAppendingError: 'mse-error',
    bufferStalledError: 'buffer-stalled',
    bufferSeekOverHole: 'buffer-gap',
    bufferNudgeOnStall: 'buffer-nudge',
    bufferFullError: 'buffer-full',
    bufferIncompatibleCodecsError: 'unsupported-codec',
    manifestIncompatibleCodecsError: 'unsupported-codec',
    fragGap: 'segment-gap',
    levelParsingError: 'format-error',
    manifestParsingError: 'format-error',
    levelEmptyError: 'playlist-empty',
    playlistUnchangedError: 'playlist-unchanged',
    levelSwitchError: 'playlist-error',
    bufferAppendNoProgress: 'mse-no-progress',
    bufferAddCodecError: 'mse-error',
    remuxAllocError: 'allocation-error',
    internalException: 'internal-exception',
    attachMediaError: 'attach-error',
    mediaSourceRequiresReset: 'mse-reset',
    aborted: 'cancelled',
    audioTrackLoadError: 'audio-track-error',
    audioTrackLoadTimeOut: 'audio-track-timeout',
    subtitleTrackLoadError: 'subtitle-track-error',
    subtitleTrackLoadTimeOut: 'subtitle-track-timeout',
    fragDecryptError: 'decrypt-error',
    keyLoadError: 'key-error',
    keyLoadTimeOut: 'key-timeout',
    assetListLoadError: 'asset-error',
    assetListLoadTimeout: 'asset-timeout',
    assetListParsingError: 'asset-error',
    interstitialAssetItemError: 'asset-error',
  };
  const token =
    typeof detail === 'string' && Object.hasOwn(known, detail) ? known[detail] : 'unknown';
  const values: TraceValues = {
    transport,
    detail: token,
    code:
      token === 'early-eof'
        ? 'upstream-eof'
        : token.includes('timeout')
          ? 'timeout'
          : token.startsWith('unsupported') || (transport === 'html5' && detail === 4)
            ? 'unsupported'
            : [
                  'mse-error',
                  'format-error',
                  'mse-no-progress',
                  'mse-reset',
                  'attach-error',
                  'allocation-error',
                  'decrypt-error',
                ].includes(token) ||
                (transport === 'html5' && detail === 3)
              ? 'decode'
              : token === 'cancelled' || (transport === 'html5' && detail === 1)
                ? 'cancelled'
                : token === 'unknown' ||
                    token === 'internal-exception' ||
                    token.startsWith('buffer-')
                  ? 'unknown'
                  : 'network',
  };
  const row = info && typeof info === 'object' ? (info as Record<string, unknown>) : null;
  if (Number.isInteger(row?.code) && Number(row?.code) >= 300 && Number(row?.code) <= 599)
    values.httpStatus = Number(row?.code);
  if (
    transport === 'html5' &&
    Number.isInteger(detail) &&
    Number(detail) >= 1 &&
    Number(detail) <= 4
  )
    values.mediaErrorCode = Number(detail);
  return values;
}

/** Nonfatal HLS recovery can precede a watchdog failure without a fatal library error.
 * Bound duplicate observations per engine; unknown free text becomes one fixed bucket.
 */
export function createEngineWarningTrace(now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return (detail: unknown, info?: unknown): TraceValues | null => {
    const facts = engineFailureFacts('hls', detail, info);
    const key = String(facts.detail);
    const at = now();
    const previous = seen.get(key);
    if (previous !== undefined && at - previous < 10_000) return null;
    seen.set(key, at);
    return facts;
  };
}
