// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { captureGuideLocation, guideLocationKey } from '../../src/guide/location-filter';

it('snapshots declared countries, region/state and Unknown without widening scope', () => {
  const countries = ['US', 'CA'];
  const captured = captureGuideLocation({ countries });
  countries.push('UK');
  expect(captured).toEqual({ countries: ['CA', 'US'] });
  expect(guideLocationKey({ countries: ['US', 'CA'] })).toBe(
    guideLocationKey({ countries: ['CA', 'US'] }),
  );
  expect(captureGuideLocation({ country: 'US', region: 'NA', state: 'US-IL' })).toEqual({
    country: 'US',
    region: 'NA',
    state: 'US-IL',
  });
  expect(guideLocationKey({ country: null })).not.toBe(guideLocationKey({}));
  expect(captureGuideLocation({ country: null })).toEqual({ country: null });
});

it('rejects malformed filters rather than silently showing all countries', () => {
  for (const bad of [
    { countries: ['US'] },
    { countries: ['US', 'US'] },
    { countries: ['US', 'CA'], state: 'US-IL' },
    { country: 'US\u0007' },
    { region: 12 },
    { other: 'US' },
  ])
    expect(() => captureGuideLocation(bad as never)).toThrow('location filter');
});
