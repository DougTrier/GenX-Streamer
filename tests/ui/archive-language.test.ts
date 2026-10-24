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
import { archiveLanguageName, archiveLanguageSummary } from '../../src/ui/archive-language';
describe('Archive language presentation', () => {
  it('expands provider codes into readable names', () => {
    expect(['eng', 'spa', 'jpn', 'dut', 'ita', 'rus'].map(archiveLanguageName)).toEqual([
      'English',
      'Spanish',
      'Japanese',
      'Dutch',
      'Italian',
      'Russian',
    ]);
  });
  it('does not invent a language and de-duplicates aliases', () => {
    expect(archiveLanguageSummary()).toBe('Language not listed');
    expect(archiveLanguageSummary(['eng', 'English', 'spa'])).toBe(
      'Language listed: English, Spanish',
    );
    expect(archiveLanguageName('und')).toBe('Undetermined');
    expect(archiveLanguageName('Provider label (ambiguous)')).toBe('Provider label (ambiguous)');
  });
});
