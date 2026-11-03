/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import {
  OFFICIAL_COMET_LOCATION,
  OFFICIAL_COMET_NAME,
  OFFICIAL_PBS_KIDS_LOCATION,
  OFFICIAL_PBS_KIDS_NAME,
  isOfficialGuideSuggestion,
} from '../../src/guide/official-suggestions';
import { readPackSuggestions, validatePackSuggestions } from '../../src/guide/pack-suggestions';

const comet = { name: OFFICIAL_COMET_NAME, location: OFFICIAL_COMET_LOCATION, channels: 1 };

it('passes the exact official main-feed suggestion through the existing full Guide discovery adapter', async () => {
  const signal = new AbortController().signal;
  expect(isOfficialGuideSuggestion(comet)).toBe(true);
  expect(await readPackSuggestions(async () => [comet], signal)).toEqual([comet]);
  expect(validatePackSuggestions([{ ...comet, channels: 2 }])).toHaveLength(1);
});

it('admits only the exact official PBS KIDS national descriptor through normal Find suggestions', async () => {
  const pbs = { name: OFFICIAL_PBS_KIDS_NAME, location: OFFICIAL_PBS_KIDS_LOCATION, channels: 1 };
  expect(await readPackSuggestions(async () => [pbs, comet], new AbortController().signal)).toEqual(
    [pbs, comet],
  );
  expect(validatePackSuggestions([{ ...pbs, channels: 2 }])).toHaveLength(1);
  for (const value of [
    { ...pbs, location: 'https://graph.services.pbskids.org/' },
    { ...pbs, location: OFFICIAL_PBS_KIDS_LOCATION + '/' },
    { ...pbs, location: OFFICIAL_PBS_KIDS_LOCATION + '?station=KERA' },
    { ...pbs, location: 'https://pbskids.org.evil.invalid/videos/watch/live' },
    { ...pbs, name: 'PBS KIDS regional' },
    { ...pbs, channels: 3 },
    { ...pbs, channels: 0 },
  ])
    expect(validatePackSuggestions([value])).toEqual([]);
});

it('cannot turn alternate hosts, regional counts, endpoints or queries into approved API acquisition', () => {
  for (const value of [
    { ...comet, location: 'https://comettv.com.evil.invalid/schedule/' },
    { ...comet, location: 'http://comettv.com/schedule/' },
    { ...comet, location: OFFICIAL_COMET_LOCATION + '?timezone=America/Los_Angeles' },
    { ...comet, location: 'https://comettv.com/wp-json/comet/v1/fetch-all-schedule-days' },
    { ...comet, name: 'Regional COMET' },
    { ...comet, channels: 3 },
    { ...comet, channels: 0 },
  ]) {
    expect(isOfficialGuideSuggestion(value)).toBe(false);
    expect(validatePackSuggestions([value])).toEqual([]);
  }
  expect(validatePackSuggestions([comet, comet])).toEqual([]);
});
