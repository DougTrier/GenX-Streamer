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
import { createStartTiming } from '../../src/playback/start-timing';

describe('channel start timing (measurement only)', () => {
  it('records each stage once, relative to the choice, on the same clock as hls.js stats', () => {
    let now = 1000;
    const timing = createStartTiming(() => now);
    timing.begin('account');
    now = 1400;
    timing.mark('session-ready');
    now = 1450;
    timing.enterPlayer();
    timing.mark('manifest-request', 1500);
    timing.mark('manifest-first-byte', 1900.4);
    timing.mark('manifest-first-byte', 2500);
    timing.fact('first-segment-bytes', 812345);
    timing.fact('first-segment-bytes', 1);
    timing.count('retries');
    timing.count('retries');
    expect(timing.snapshot()).toEqual([
      {
        kind: 'account',
        stages: {
          requested: 0,
          'session-ready': 400,
          'player-select': 450,
          'manifest-request': 500,
          'manifest-first-byte': 900,
        },
        facts: { 'first-segment-bytes': 812345, retries: 2 },
      },
    ]);
  });

  it('a player start without a Paid TV session begins its own record; old records roll off', () => {
    let now = 0;
    const timing = createStartTiming(() => now);
    timing.begin('account');
    timing.enterPlayer();
    now = 50;
    timing.enterPlayer();
    expect(timing.snapshot().map((r) => r.kind)).toEqual(['account', 'player']);
    for (let i = 0; i < 20; i++) timing.enterPlayer();
    expect(timing.snapshot()).toHaveLength(12);
  });

  it('adds the relay wall-clock times to the Paid TV start that reached playback', () => {
    let now = 100;
    const timing = createStartTiming(
      () => now,
      () => 1_000_000,
    );
    const calls: string[] = [];
    timing.enrichAccountStarts((add) => {
      calls.push('enrich');
      add.wallStage('relay-request', 1_000_900);
      add.wallStage('upstream-first-byte', 1_002_100);
      add.wallStage('player-first-byte', null);
      // Before this start's choice: an older start's relay time, ignored.
      add.wallStage('upstream-headers', 1_000_050);
      add.fact('provider-busy-retries', 0);
    });
    timing.begin('account');
    now = 3100;
    timing.mark('playback-start');
    timing.mark('playback-start');
    expect(calls).toEqual(['enrich']);
    expect(timing.snapshot()[0]).toEqual({
      kind: 'account',
      stages: {
        requested: 0,
        'playback-start': 3000,
        'relay-request': 800,
        'upstream-first-byte': 2000,
      },
      facts: { 'provider-busy-retries': 0 },
    });
    // Free TV starts have no relay.
    timing.begin('player');
    timing.mark('playback-start');
    expect(calls).toEqual(['enrich']);
  });

  it('ignores marks before any start, non-finite times and text-like fact names', () => {
    const timing = createStartTiming(() => 0);
    timing.mark('playback-start');
    expect(timing.snapshot()).toEqual([]);
    timing.begin('player');
    timing.mark('first-visible-frame', Number.NaN);
    timing.fact('https://x', 1);
    timing.fact('hop1-dns-ms', 12);
    timing.fact('size', Number.POSITIVE_INFINITY);
    expect(timing.snapshot()[0]).toEqual({
      kind: 'player',
      stages: { requested: 0 },
      facts: { 'hop1-dns-ms': 12 },
    });
  });
});
