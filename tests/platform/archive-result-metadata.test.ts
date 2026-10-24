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
import { validateArchiveTitle } from '../../src/platform/archive-catalog';

const title = {
  favorite: false,
  titleRef: 'a'.repeat(64),
  title: 'Gilligan episode',
  kind: 'tv',
  releaseYear: 1964,
  curated: false,
  titleProvenance: 'provider-item',
  fileCount: 1,
  durationSeconds: 1464,
  rights: null,
  rank: 1,
  quality: 'metadata-h264',
  observedMs: 1,
};
describe('Archive result metadata boundary', () => {
  it('preserves legacy results without inventing language or match evidence', () => {
    expect(validateArchiveTitle(title).providerLanguages).toBeUndefined();
  });
  it('admits only consistent closed version-one IA item-date assessments', () => {
    const dateAssessment = {
      version: 1,
      providerListedYear: 1964,
      originalReleaseYear: null,
      status: 'unverified-item-date',
      provenance: 'legacy-item-year',
      field: 'unknown',
    };
    expect(validateArchiveTitle({ ...title, dateAssessment }).dateAssessment).toEqual(
      dateAssessment,
    );
    expect(
      validateArchiveTitle({
        ...title,
        releaseYear: null,
        dateAssessment: { ...dateAssessment, providerListedYear: null, status: 'unknown' },
      }).dateAssessment?.status,
    ).toBe('unknown');
    for (const patch of [
      { version: 2 },
      { providerListedYear: 1965 },
      { providerListedYear: 1964.5 },
      { originalReleaseYear: 1964 },
      { status: 'verified' },
      { status: 'unknown' },
      { provenance: 'upload-date' },
      { field: 'year' },
      { extra: true },
    ])
      expect(() =>
        validateArchiveTitle({ ...title, dateAssessment: { ...dateAssessment, ...patch } }),
      ).toThrow();
    for (const invalid of [null, [], { ...dateAssessment, [Symbol('hidden')]: true }]) {
      expect(() => validateArchiveTitle({ ...title, dateAssessment: invalid })).toThrow();
    }
    const accessed = { ...dateAssessment };
    Object.defineProperty(accessed, 'version', {
      get: () => {
        throw new Error('must not invoke accessor');
      },
    });
    expect(() => validateArchiveTitle({ ...title, dateAssessment: accessed })).toThrow('Archive');
    expect(() =>
      validateArchiveTitle({
        ...title,
        providerId: 'loc',
        sourceUrl: 'https://www.loc.gov/item/00694220/',
        rank: 0,
        quality: 'metadata-listed',
        dateAssessment,
      }),
    ).toThrow();
  });
  it('retains distinct provider language and subject evidence', () => {
    const enriched = {
      ...title,
      providerLanguages: ['spa'],
      languageProvenance: 'provider-item',
      providerSubjects: ['Comedy', 'Television'],
      providerDescription: 'A television episode.',
      matchBasis: 'series',
    };
    expect(validateArchiveTitle(enriched)).toEqual(enriched);
  });
  it('retains truthful provider genre-category evidence', () => {
    expect(validateArchiveTitle({ ...title, matchBasis: 'genre' }).matchBasis).toBe('genre');
  });

  it('keeps actual provider types and optional image proof distinct from historical kind', () => {
    const enriched = {
      ...title,
      contentType: 'tv',
      contentTypeProvenance: 'provider-item',
      providerSeries: 'Actual series label',
      artwork: {
        schemaVersion: 1,
        artworkRef: 'b'.repeat(64),
        itemId: 'actual-item',
        fileName: '__ia_thumb.jpg',
        sizeBytes: '7326',
        mimeType: 'image/jpeg',
        provenance: 'provider-item',
      },
    };
    expect(validateArchiveTitle(enriched)).toEqual(enriched);
    expect(
      validateArchiveTitle({
        ...title,
        contentType: 'unknown',
        contentTypeProvenance: 'unknown',
        artwork: null,
      }).contentType,
    ).toBe('unknown');
    expect(validateArchiveTitle(title).contentType).toBeUndefined();
    for (const patch of [
      { contentType: 'tv', contentTypeProvenance: 'unknown' },
      { contentType: 'all', contentTypeProvenance: 'provider-item' },
      { providerSeries: 'https://bad.invalid/' },
      { artwork: { ...enriched.artwork, fileName: '../secret' } },
      { artwork: { ...enriched.artwork, sizeBytes: '524289' } },
    ])
      expect(() => validateArchiveTitle({ ...title, ...patch })).toThrow();
  });
  it('rejects contradictory language provenance, oversized labels and unknown match claims', () => {
    for (const patch of [
      { providerLanguages: ['English'], languageProvenance: 'unknown' },
      { providerLanguages: [], languageProvenance: 'provider-item' },
      { providerLanguages: Array(17).fill('eng') },
      { providerSubjects: ['x'.repeat(129)] },
      { providerDescription: 'x'.repeat(2049) },
      { matchBasis: 'verified-audio' },
    ])
      expect(() => validateArchiveTitle({ ...title, ...patch })).toThrow();
  });
});
