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
