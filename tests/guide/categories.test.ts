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

import { describe, it, expect } from 'vitest';
import { guideCategoryKey, validateGuideCategories } from '../../src/guide/categories';
import { validateProgramPageCategories } from '../../src/guide/native';
import { queryGuide, type GuideProgram } from '../../src/guide/query';
describe('published program categories', () => {
  it('accepts legacy absent metadata, native null language and preserves original first language spelling', () => {
    expect(validateGuideCategories(undefined)).toEqual([]);
    expect(validateGuideCategories([{ text: ' Action ', language: null }])).toEqual([
      { text: 'Action' },
    ]);
    expect(
      validateGuideCategories([
        { text: 'Ｄｒａｍａ', language: 'EN' },
        { text: 'drama', language: 'en' },
      ]),
    ).toEqual([{ text: 'Ｄｒａｍａ', language: 'EN' }]);
    expect(guideCategoryKey([{ text: 'Drama' }, { text: 'Action' }])).toBe(
      guideCategoryKey([{ text: 'action' }, { text: 'Ｄｒａｍａ' }]),
    );
    expect(
      guideCategoryKey([{ text: 'Science\n Fiction', language: 'EN' }, { text: 'Action' }]),
    ).toBe('[["action",null],["science fiction","en"]]');
    expect(guideCategoryKey([{ text: '\uFEFFAction\uFEFF' }])).toBe('[["action",null]]');
  });
  it('bounds raw categories before dedup, text bytes/language and aggregate without truncation', () => {
    expect(
      validateGuideCategories(Array.from({ length: 32 }, () => ({ text: 'Action' }))),
    ).toHaveLength(1);
    expect(() =>
      validateGuideCategories(Array.from({ length: 33 }, () => ({ text: 'Action' }))),
    ).toThrow();
    expect(() => validateGuideCategories([{ text: 'é'.repeat(257) }])).toThrow();
    expect(() =>
      validateGuideCategories(Array.from({ length: 9 }, () => ({ text: 'x'.repeat(512) }))),
    ).toThrow();
    for (const value of [
      [{ text: '' }],
      [{ text: 'x', language: 'en_US' }],
      [{ text: 'x', genre: 'guess' }],
      null,
    ])
      expect(() => validateGuideCategories(value)).toThrow();
  });
  it('preserves absent category page compatibility and refuses malformed native category metadata', () => {
    const page = {
      programs: [
        {
          catalogSourceId: 's',
          appChannelId: 'c',
          guideSourceId: 'g',
          xmltvChannelId: 'x',
          startMs: 1,
          stopMs: 2,
          title: 'Title',
          description: null,
          ordinal: 0,
        },
      ],
      nextCursor: null,
      sourceRevision: 1,
      databaseRevision: 1,
    };
    expect(validateProgramPageCategories(page).programs[0].categories).toEqual([]);
    expect(() =>
      validateProgramPageCategories({
        ...page,
        programs: [
          { ...page.programs[0], categories: [{ text: 'Action', language: 'invalid_language' }] },
        ],
      }),
    ).toThrow();
  });
  it('normalized duplicate genres do not invent overlap but genuinely different tags remain distinct', () => {
    const p: GuideProgram = {
      guideSourceId: 'g',
      channelId: 'x',
      startMs: 1,
      stopMs: 100,
      title: 'Title',
      categories: [{ text: 'Action' }],
    };
    const scope = {
      guideSourceId: 'g',
      channelId: 'x',
      nowMs: 50,
      windowStartMs: 0,
      windowEndMs: 200,
    };
    expect(
      queryGuide([p, { ...p, categories: [{ text: 'Ａｃｔｉｏｎ' }] }], scope).currentStatus,
    ).toBe('current');
    expect(queryGuide([p, { ...p, categories: [{ text: 'Drama' }] }], scope).currentStatus).toBe(
      'overlap',
    );
  });
});
