/** Display provider claims without turning missing metadata into an audio verdict. */
const aliases: Readonly<Record<string, string>> = {
  eng: 'en',
  english: 'en',
  spa: 'es',
  spanish: 'es',
  fre: 'fr',
  fra: 'fr',
  french: 'fr',
  ger: 'de',
  deu: 'de',
  german: 'de',
  por: 'pt',
  portuguese: 'pt',
  jpn: 'ja',
  japanese: 'ja',
  dut: 'nl',
  nld: 'nl',
  dutch: 'nl',
  ita: 'it',
  italian: 'it',
  rus: 'ru',
  russian: 'ru',
  chi: 'zh',
  zho: 'zh',
  chinese: 'zh',
  kor: 'ko',
  korean: 'ko',
  und: 'und',
};
let displayNames: Intl.DisplayNames | undefined;
export function archiveLanguageName(label: string): string {
  const original = label.trim();
  if (!original) return '';
  const code = aliases[original.toLowerCase()] ?? original;
  if (code === 'und') return 'Undetermined';
  try {
    displayNames ??= new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
    return displayNames.of(code) ?? original;
  } catch {
    return original;
  }
}
export function archiveLanguageSummary(labels: readonly string[] = []): string {
  const names = [...new Set(labels.map(archiveLanguageName).filter(Boolean))];
  return names.length ? `Language listed: ${names.join(', ')}` : 'Language not listed';
}
