import type { PlaybackFailure } from './controller';

export type PlaybackRecoveryAction =
  'retry' | 'alternative' | 'choose-channel' | 'review-source' | 'refresh-sources';
export interface PlaybackFailureGuidance {
  readonly title: string;
  readonly explanation: string;
  readonly actions: readonly PlaybackRecoveryAction[];
  readonly retryAdvice?: string;
}

/** Static user copy from observed categories. Provider messages never reach this view. */
export function playbackFailureGuidance(
  failure: PlaybackFailure | null | undefined,
  options: { hasAlternative?: boolean; playMode?: 'live' | 'on-demand' } = {},
): PlaybackFailureGuidance {
  let title = 'Playback could not start';
  let explanation =
    'The app could not confirm why this stream failed. Retry, check your connection, or choose another channel.';
  let retryAdvice: string | undefined;
  const actions: PlaybackRecoveryAction[] = ['retry'];
  const status =
    failure?.evidence === 'http' && Number.isInteger(failure.httpStatus)
      ? failure.httpStatus
      : undefined;
  if (status === 429 || status === 503) {
    title = 'The source is busy';
    explanation =
      'The source is limiting requests or temporarily unavailable. Try again later or choose another channel.';
    retryAdvice = 'Give the source time before retrying.';
  } else
    switch (failure?.code) {
      case 'access':
        title = 'The source refused access';
        explanation =
          'The source refused this request. Check the source settings or choose another channel.';
        actions.push('review-source');
        break;
      case 'missing':
        title =
          status === 404 || status === 410
            ? 'The stream was not found'
            : 'The stream became unavailable';
        explanation =
          status === 404 || status === 410
            ? 'The source could not find the requested stream. Refresh saved sources or choose another channel.'
            : 'The stream ended or became unavailable. Retry or choose another channel.';
        if (status === 404 || status === 410) actions.push('refresh-sources');
        break;
      case 'timeout':
        title = 'The stream took too long';
        explanation =
          failure.phase === 'buffering-progress'
            ? 'Video stopped advancing within the allowed time. Retry or choose another channel.'
            : failure.phase === 'startup-progress'
              ? 'The stream did not produce advancing video within the allowed time. Retry or choose another channel.'
              : failure.phase === 'body'
                ? 'The media download did not finish in time. Retry, check your connection, or choose another channel.'
                : 'The source did not respond in time. Retry, check your connection, or choose another channel.';
        break;
      case 'dns':
        title = 'The source address could not be found';
        explanation =
          'Check your connection and the saved source address, then retry or choose another channel.';
        actions.push('review-source');
        break;
      case 'tls':
        title = 'The secure connection failed';
        explanation =
          'The app could not establish a secure connection to the source. Check its address or contact its provider.';
        actions.push('review-source');
        break;
      case 'policy':
        title = 'The source request was blocked';
        explanation =
          'This request does not meet the app’s source or network rules. Review the source settings or choose another channel.';
        retryAdvice = 'Retry after reviewing the source settings.';
        actions.push('review-source');
        break;
      case 'unsupported':
        if (status !== undefined && [300, 301, 302, 303, 305, 307, 308].includes(status)) {
          title = 'The redirected stream could not be opened';
          explanation =
            'The source redirected this request, but the app could not follow it. Check the saved source address or choose another channel.';
          actions.push('review-source');
        } else if (failure.nativeFormat === 'mpeg2') {
          // Only where no device player took the channel over (Windows).
          title = 'This channel’s picture is MPEG-2';
          explanation =
            'This player cannot show MPEG-2 video. The channel plays in GenX on Android TVs and phones, or choose another stream for it.';
        } else {
          title = 'The stream format could not be used';
          explanation =
            'This player could not use the stream’s format or playback data. Another stream may use a supported format.';
        }
        break;
      case 'decode':
        title = 'This device could not decode the video';
        explanation =
          'The video could not be decoded on this device. Another stream may use a compatible format.';
        break;
      case 'network':
        title = 'The stream connection failed';
        explanation =
          'The connection to the source failed. Check your connection, retry, or choose another channel.';
        break;
    }
  // Only this module's fixed copy is adapted; failure.message is never rendered.
  if (options.playMode === 'on-demand')
    explanation = explanation.replace(/\b(?:channel|stream)\b/g, 'video');
  if (options.hasAlternative === true) actions.push('alternative');
  actions.push('choose-channel');
  return Object.freeze({
    title,
    explanation,
    actions: Object.freeze(actions),
    ...(retryAdvice ? { retryAdvice } : {}),
  });
}
