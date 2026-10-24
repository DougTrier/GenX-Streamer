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
  suggestGuideMappings,
  type MappingChannel,
  type MappingGuideChannel,
  type MappingInput,
} from '../../src/guide/matching';
const channel = (patch: Partial<MappingChannel> = {}): MappingChannel => ({
  id: 'app',
  sourceId: 'catalog',
  name: 'News',
  ...patch,
});
const guide = (patch: Partial<MappingGuideChannel> = {}): MappingGuideChannel => ({
  guideSourceId: 'selected',
  id: 'xml',
  names: ['News'],
  ...patch,
});
const suggest = (channels: MappingChannel[], guides: MappingGuideChannel[]) =>
  suggestGuideMappings({
    guideSourceId: 'selected',
    catalogChannels: channels,
    guideChannels: guides,
  });
describe('review-only deterministic guide mapping suggestions', () => {
  it('refuses oversized review output and invalid Unicode instead of partial suggestions', () => {
    const guides = Array.from({ length: 20 }, (_, i) =>
      guide({ id: `${String(i).padStart(2, '0')}${'x'.repeat(16_382)}` }),
    );
    const channels = Array.from({ length: 210 }, (_, i) => channel({ id: `app-${i}` }));
    expect(() => suggest(channels, guides)).toThrow('review batch limit');
    expect(() => suggest([channel({ name: '\ud800' })], [guide()])).toThrow('invalid');
  });
  it('prefers exact provider ID over ambiguous names, without claiming availability', () => {
    const result = suggest(
      [channel({ providerId: 'provider' })],
      [guide(), guide({ id: 'other' }), guide({ id: 'provider', names: ['Different listing'] })],
    )[0];
    expect(result).toMatchObject({
      match: 'provider-id',
      candidateCount: 1,
      reviewRequired: true,
      candidatesPreview: [{ xmltvChannelId: 'provider', displayName: 'Different listing' }],
    });
    expect(result).not.toHaveProperty('playable');
    expect(result).not.toHaveProperty('url');
  });
  it('provider IDs remain byte-exact and guide source scoped', () => {
    const result = suggest(
      [channel({ name: 'Unlisted', providerId: 'XML' })],
      [guide({ id: 'xml' }), guide({ guideSourceId: 'other', id: 'XML' })],
    )[0];
    expect(result.match).toBe('unmatched');
    expect(result.candidateCount).toBe(0);
  });
  it('matches complete NFKC names across aliases, case and whitespace', () => {
    const result = suggest(
      [channel({ name: '  ＡＢＣ\t NEWS  ' })],
      [guide({ names: ['ABC News International', 'abc  news', 'ABC NEWS'] })],
    )[0];
    expect(result.match).toBe('display-name');
    expect(result.candidateCount).toBe(1);
  });
  it('keeps region, feed variant, accents and punctuation rather than guessing', () => {
    for (const name of ['News HD', 'News Chicago', 'News-East', 'Café']) {
      expect(
        suggest([channel({ name })], [guide({ names: ['News', 'News East', 'Cafe'] })])[0].match,
      ).toBe('unmatched');
    }
  });
  it('exposes duplicate names as ambiguity and never chooses a first match', () => {
    const result = suggest([channel()], [guide({ id: 'z' }), guide({ id: 'a' })])[0];
    expect(result.match).toBe('ambiguous');
    expect(result.candidateCount).toBe(2);
    expect(result.candidatesPreview.map((c) => c.xmltvChannelId)).toEqual(['a', 'z']);
    expect(result.reviewRequired).toBe(true);
  });
  it('reports an explicit incomplete 20-candidate preview for large ambiguous sets', () => {
    const guides = Array.from({ length: 25 }, (_, i) =>
      guide({ id: `xml-${String(i).padStart(2, '0')}` }),
    );
    const result = suggest([channel()], guides)[0];
    expect(result).toMatchObject({
      match: 'ambiguous',
      candidateCount: 25,
      previewComplete: false,
    });
    expect(result.candidatesPreview).toHaveLength(20);
    expect(result.candidatesPreview[19].xmltvChannelId).toBe('xml-19');
  });
  it('is stable under shuffled input, deduplicates exact records and keeps catalog sources separate', () => {
    const channels = [
      channel({ sourceId: 'z' }),
      channel({ sourceId: 'a' }),
      channel({ sourceId: 'a' }),
    ];
    const guides = [guide({ id: 'z' }), guide({ id: 'a' }), guide({ id: 'a' })];
    const first = suggest(channels, guides);
    expect(suggest([...channels].reverse(), [...guides].reverse())).toEqual(first);
    expect(first.map((c) => c.catalogSourceId)).toEqual(['a', 'z']);
  });
  it('refuses conflicting IDs instead of silently retaining one record', () => {
    expect(() => suggest([channel()], [guide(), guide({ names: ['Changed'] })])).toThrow(
      'conflicting',
    );
    expect(() => suggest([channel(), channel({ name: 'Changed' })], [guide()])).toThrow(
      'conflicting',
    );
    expect(() =>
      suggest(
        [channel()],
        [guide({ guideSourceId: 'other' }), guide({ guideSourceId: 'other', names: ['Changed'] })],
      ),
    ).toThrow('conflicting');
  });
  it('returns copied review data and preserves hostile labels as plain metadata', () => {
    const guides = [guide({ names: ['<img onerror=alert(1)>'] })];
    const result = suggest(
      [
        channel({ name: '<img onerror=alert(1)>' }),
        channel({ id: 'app2', name: '<img onerror=alert(1)>' }),
      ],
      guides,
    );
    expect(result[0].candidatesPreview[0].displayName).toBe('<img onerror=alert(1)>');
    result[0].candidatesPreview[0].displayName = 'Changed';
    expect(result[1].candidatesPreview[0].displayName).toBe('<img onerror=alert(1)>');
    expect(guides[0].names[0]).toBe('<img onerror=alert(1)>');
  });
  it('handles an empty selected guide as unmatched without cross-feed fallback', () => {
    expect(suggest([channel()], [guide({ guideSourceId: 'elsewhere' })])[0]).toMatchObject({
      match: 'unmatched',
      candidateCount: 0,
      previewComplete: true,
      reviewRequired: true,
    });
  });
  it('fails malformed or oversized input in full rather than truncating it', () => {
    const input: MappingInput = {
      guideSourceId: 'selected',
      catalogChannels: [channel()],
      guideChannels: [guide()],
    };
    expect(() => suggestGuideMappings({ ...input, guideSourceId: '' })).toThrow();
    expect(() =>
      suggest([channel()], [guide({ names: Array(33).fill('Name') as string[] })]),
    ).toThrow();
    expect(() => suggest([channel()], [guide({ names: ['x'.repeat(513)] })])).toThrow();
    expect(() =>
      suggestGuideMappings({
        ...input,
        catalogChannels: Array(100_001).fill(channel()) as MappingChannel[],
      }),
    ).toThrow('record limit');
  });
});
