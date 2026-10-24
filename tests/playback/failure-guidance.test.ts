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
import { classifyHttpFailure, classifyTransportFailure } from '../../src/playback/failure';
import { playbackFailureGuidance } from '../../src/playback/failure-guidance';
import type { PlaybackFailure } from '../../src/playback/controller';

describe('plain playback failure guidance preserves observed evidence', () => {
  it.each([429, 503])(
    'HTTP %s explains a busy source without permanent failure claims',
    (status) => {
      const failure = classifyHttpFailure(status, '30');
      expect(failure.httpStatus).toBe(status);
      expect(failure.retryAfterMs).toBe(30000);
      expect(playbackFailureGuidance(failure)).toMatchObject({ title: 'The source is busy' });
    },
  );
  it.each([404, 410])(
    'HTTP %s explains not found without deleting or declaring the channel dead',
    (status) => {
      const failure = classifyHttpFailure(status);
      expect(failure.message).not.toMatch(/no longer|permanent|dead/);
      expect(playbackFailureGuidance(failure).actions).toContain('refresh-sources');
    },
  );
  it('ended media is not falsely presented as an HTTP404', () => {
    const failure: PlaybackFailure = {
      code: 'missing',
      message: 'internal',
      retryable: false,
      evidence: 'media',
    };
    const guidance = playbackFailureGuidance(failure);
    expect(guidance.title).toBe('The stream became unavailable');
    expect(guidance.actions).not.toContain('refresh-sources');
  });
  it.each(['startup-progress', 'buffering-progress', 'body'] as const)(
    'timeout keeps its observed %s stage',
    (phase) => {
      const guidance = playbackFailureGuidance({
        code: 'timeout',
        message: 'secret',
        retryable: true,
        phase,
      });
      expect(guidance.explanation).toMatch(phase === 'body' ? /download/ : /advancing/);
      expect(guidance.explanation).not.toContain('secret');
    },
  );
  it('unknown provider text never becomes a guessed certificate, region, or codec diagnosis', () => {
    const failure = classifyTransportFailure(
      new Error('https://user:password@private.invalid/?token=secret TLS geo codec'),
    );
    const guidance = playbackFailureGuidance(failure);
    expect(guidance.explanation).toContain('could not confirm why');
    expect(JSON.stringify(guidance)).not.toMatch(/private|password|token|TLS|geo|codec/);
  });
  it('HTTP403 preserves uncertainty about geographic restrictions', () => {
    const guidance = playbackFailureGuidance(classifyHttpFailure(403));
    expect(guidance.title).toBe('The source refused access');
    expect(guidance.explanation).not.toMatch(/geograph|region|country/);
  });
  it('secure and policy guidance never offers security bypass', () => {
    for (const category of ['tls-failure', 'url-policy-refused']) {
      const failure = classifyTransportFailure(category);
      expect(failure.retryable).toBe(false);
      const guidance = playbackFailureGuidance(failure);
      expect(guidance.actions).toContain('review-source');
      expect(guidance.actions).not.toContain('refresh-sources');
    }
  });
  it('alternative actions require an actual caller-owned alternative and remain immutable', () => {
    const failure = classifyHttpFailure(0);
    expect(playbackFailureGuidance(failure).actions).not.toContain('alternative');
    const guidance = playbackFailureGuidance(failure, { hasAlternative: true });
    expect(guidance.actions).toContain('alternative');
    expect(Object.isFrozen(guidance)).toBe(true);
    expect(Object.isFrozen(guidance.actions)).toBe(true);
    expect(failure.retryable).toBe(true);
  });
  it('unvalidated or opaque HTTP fields cannot manufacture busy guidance', () => {
    for (const httpStatus of [NaN, 429.5, 999, 429]) {
      const guidance = playbackFailureGuidance({
        code: 'unknown',
        message: 'raw',
        retryable: true,
        httpStatus,
        evidence: 'opaque',
      });
      expect(guidance.title).not.toBe('The source is busy');
    }
    expect(classifyHttpFailure(429.5).httpStatus).toBeUndefined();
  });
  it.each(['unsupported', 'decode'] as const)(
    '%s offers honest alternatives without changing automatic retry',
    (code) => {
      const failure: PlaybackFailure = { code, message: 'raw', retryable: false };
      expect(playbackFailureGuidance(failure, { hasAlternative: true }).actions).toEqual([
        'retry',
        'alternative',
        'choose-channel',
      ]);
      expect(failure.retryable).toBe(false);
    },
  );
});

it('only observed redirect statuses get address review rather than a codec diagnosis', () => {
  const redirect = playbackFailureGuidance(classifyHttpFailure(302));
  expect(redirect.explanation).toContain('redirected');
  expect(redirect.actions).toContain('review-source');
  const other = playbackFailureGuidance(classifyHttpFailure(304));
  expect(other.explanation).not.toContain('redirected');
});

it.each([
  'unknown',
  'access',
  'missing',
  'timeout',
  'dns',
  'tls',
  'policy',
  'unsupported',
  'decode',
  'network',
] as const)(
  'on-demand %s explanation uses video with unchanged actions and no raw message',
  (code) => {
    const failure: PlaybackFailure = {
      code,
      message: 'private provider URL',
      retryable: true,
      phase: 'buffering-progress',
    };
    const live = playbackFailureGuidance(failure);
    expect(playbackFailureGuidance(failure, { playMode: 'live' })).toEqual(live);
    const vod = playbackFailureGuidance(failure, { playMode: 'on-demand' });
    expect(vod.explanation).toBe(live.explanation.replace(/\b(?:channel|stream)\b/g, 'video'));
    expect(vod.explanation).not.toMatch(/\b(?:channel|stream)\b|private|URL/);
    expect(vod.actions).toEqual(live.actions);
  },
);
it.each(['startup-progress', 'buffering-progress', 'body'] as const)(
  'on-demand %s timeout offers another video while Live retains channel wording',
  (phase) => {
    const failure: PlaybackFailure = {
      code: 'timeout',
      message: 'untrusted',
      retryable: true,
      phase,
    };
    expect(playbackFailureGuidance(failure, { playMode: 'on-demand' }).explanation).toContain(
      'another video',
    );
    expect(playbackFailureGuidance(failure).explanation).toContain('another channel');
  },
);

it('an MPEG-2 picture is named, with where it plays, and keeps the usual actions', () => {
  const failure: PlaybackFailure = {
    code: 'unsupported',
    message: 'raw',
    retryable: false,
    nativeFormat: 'mpeg2',
  };
  const guidance = playbackFailureGuidance(failure, { hasAlternative: true });
  expect(guidance.title).toBe('This channel’s picture is MPEG-2');
  expect(guidance.explanation).toContain('Android');
  expect(guidance.actions).toEqual(['retry', 'alternative', 'choose-channel']);
  expect(playbackFailureGuidance({ ...failure, nativeFormat: undefined }).title).toBe(
    'The stream format could not be used',
  );
});
