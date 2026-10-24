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
import {
  formatCompactViewingTime,
  formatGuideTime,
  formatLocalGuideTime,
  parseXmltvTime,
} from '../../src/guide/time';
const instant = (text: string) => {
  const result = parseXmltvTime(text);
  if (result.status !== 'instant') throw new Error('Fixture instant expected.');
  return result.epochMs;
};
describe('XMLTV time policy and injected local display', () => {
  it('normalizes positive, negative and absent offsets exactly once', () => {
    const utc = Date.UTC(2026, 9, 10, 12, 0, 0);
    expect(instant('20261010173000 +0530')).toBe(utc);
    expect(instant('20261010083000 -0330')).toBe(utc);
    expect(instant('20261010120000')).toBe(utc);
    expect(instant('20261010120000 -0000')).toBe(utc);
  });
  it('explicitly supports minute precision and refuses invented instants for partial dates', () => {
    expect(parseXmltvTime('202610101200 +0000')).toEqual({
      status: 'instant',
      epochMs: Date.UTC(2026, 9, 10, 12),
      precision: 'minute',
    });
    for (const input of [null, undefined, '', '2026', '202610', '20261010', '2026101012'])
      expect(parseXmltvTime(input)).toEqual({ status: 'incomplete' });
    expect(parseXmltvTime('20261010120000 BST')).toEqual({ status: 'unsupported' });
    expect(parseXmltvTime('20261010120000 UTC')).toEqual({ status: 'unsupported' });
  });
  it.each([
    '20260229000000',
    '20260431000000',
    '20261301000000',
    '20260001000000',
    '20261000000000',
    '00001010000000',
    '20261010240000',
    '20261010126000',
    '20261010120060',
    '20261010120000 +1460',
    '20261010120000 +1401',
    '20261010120000 -1500',
    '20261010120000 +0060',
    '20261010120000 +02:00',
    '2026101012000',
  ])('rejects calendar rollover and offset bounds: %s', (input) => {
    expect(parseXmltvTime(input)).toEqual({ status: 'invalid' });
  });
  it('validates leap days and avoids the JavaScript Date.UTC year-99 shortcut', () => {
    expect(parseXmltvTime('20240229000000').status).toBe('instant');
    expect(parseXmltvTime('19000229000000').status).toBe('invalid');
    expect(parseXmltvTime('20000229000000').status).toBe('instant');
    expect(new Date(instant('00990101000000')).getUTCFullYear()).toBe(99);
  });
  it('formats Chicago spring transition with the actual offset and no nonexistent 02 hour', () => {
    const before = formatGuideTime(instant('20260308075900 +0000'), {
      timeZone: 'America/Chicago',
    });
    const after = formatGuideTime(instant('20260308080000 +0000'), { timeZone: 'America/Chicago' });
    expect(before).toEqual({ date: '03/08/2026', time: '01:59', zone: 'GMT-06:00' });
    expect(after).toEqual({ date: '03/08/2026', time: '03:00', zone: 'GMT-05:00' });
  });
  it('distinguishes both Chicago autumn 01:30 instants', () => {
    const first = formatGuideTime(instant('20261101063000 +0000'), { timeZone: 'America/Chicago' });
    const second = formatGuideTime(instant('20261101073000 +0000'), {
      timeZone: 'America/Chicago',
    });
    expect(first.time).toBe('01:30');
    expect(second.time).toBe('01:30');
    expect(first.zone).toBe('GMT-05:00');
    expect(second.zone).toBe('GMT-06:00');
  });
  it('formats local midnight and timezone changes without rewriting stored UTC', () => {
    const time = instant('20261010050000');
    expect(formatGuideTime(time, { timeZone: 'America/Chicago' })).toMatchObject({
      date: '10/10/2026',
      time: '00:00',
    });
    expect(formatGuideTime(time, { timeZone: 'America/Los_Angeles' })).toMatchObject({
      date: '10/09/2026',
      time: '22:00',
    });
    expect(time).toBe(Date.UTC(2026, 9, 10, 5));
    expect(() => formatGuideTime(time, { timeZone: '' })).toThrow('explicit');
    expect(() => formatGuideTime(time, { timeZone: 'Invalid/Zone' })).toThrow('unsupported');
    expect(() => formatGuideTime(Infinity, { timeZone: 'UTC' })).toThrow('instant');
  });
});

it('viewing times use the actual local day, retain minutes and label another day', () => {
  const nowMs = Date.UTC(2026, 9, 12, 0);
  const context = { timeZone: 'America/Chicago', locale: 'en-US', nowMs };
  expect(formatCompactViewingTime(Date.UTC(2026, 9, 12, 1), context)).toBe('8PM');
  expect(formatCompactViewingTime(Date.UTC(2026, 9, 12, 1, 30), context)).toBe('8:30PM');
  expect(formatCompactViewingTime(Date.UTC(2026, 9, 12, 13), context)).toBe('Mon 8AM');
  expect(formatCompactViewingTime(Date.UTC(2026, 9, 12, 1), { ...context, locale: 'en-GB' })).toBe(
    '20:00',
  );
  expect(formatLocalGuideTime(Date.UTC(2026, 9, 12, 1), context)).toContain('GMT-05:00');
  expect(() => formatCompactViewingTime(NaN, context)).toThrow();
  expect(() => formatCompactViewingTime(nowMs, { ...context, timeZone: 'Invalid/Zone' })).toThrow();
});
