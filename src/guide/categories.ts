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

import { declaredCategoryAliases } from '../search/category-aliases';
export interface GuideCategory {
  text: string;
  language?: string;
}
const utf8 = new TextEncoder();
const normalized = (value: string) =>
  Array.from(value.normalize('NFKC'))
    .map((char) => char.toLowerCase())
    .join('')
    .split(/[\p{White_Space}\uFEFF]+/u)
    .filter(Boolean)
    .join(' ');
const invalidControl = (value: string) =>
  Array.from(value).some((char) => {
    const code = char.codePointAt(0)!;
    return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159);
  });
const compareUnicode = (a: string, b: string): number => {
  const left = Array.from(a),
    right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (diff) return diff;
  }
  return left.length - right.length;
};
/** Bounded native/import metadata. No genre inference or implicit translation. */
export function validateGuideCategories(value: unknown): GuideCategory[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid program categories.');
  let bytes = 0;
  const seen = new Set<string>();
  const result: GuideCategory[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid program categories.');
    const row = raw as Record<string, unknown>;
    if (
      Object.keys(row).some((key) => key !== 'text' && key !== 'language') ||
      typeof row.text !== 'string' ||
      !row.text.trim() ||
      invalidControl(row.text)
    )
      throw new Error('Invalid program categories.');
    const size = utf8.encode(row.text).length;
    bytes += size;
    if (
      size > 512 ||
      bytes > 4096 ||
      (row.language !== undefined &&
        row.language !== null &&
        (typeof row.language !== 'string' || !/^[A-Za-z0-9-]{1,32}$/u.test(row.language)))
    )
      throw new Error('Invalid program categories.');
    const text = row.text.trim(),
      language = typeof row.language === 'string' ? row.language : undefined;
    if (!normalized(text)) throw new Error('Invalid program categories.');
    const key = JSON.stringify([normalized(text), language?.toLowerCase() ?? null]);
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ text, ...(language !== undefined ? { language } : {}) });
    }
  }
  return result;
}
export function guideCategoryKey(value: unknown): string {
  return JSON.stringify(
    validateGuideCategories(value)
      .map((row): [string, string | null] => [
        normalized(row.text),
        row.language?.toLowerCase() ?? null,
      ])
      .sort((a, b) => compareUnicode(a[0], b[0]) || compareUnicode(a[1] ?? '', b[1] ?? '')),
  );
}
export function guideCategorySearchText(value: unknown): string {
  return validateGuideCategories(value)
    .map((row) => [row.text, ...declaredCategoryAliases(row.text)].join(' '))
    .join(' ');
}
