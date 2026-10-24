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

const normalize = (value: string): string =>
  value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
const groups: readonly (readonly string[])[] = [
  ['kids', 'children', "children's", 'childrens'],
  ['animation', 'cartoon', 'cartoons'],
];
/** Exact declared category vocabulary only; no names, genres or channel inference. */
export function declaredCategoryAliases(category: string): readonly string[] {
  const key = normalize(category);
  return groups.find((group) => group.includes(key))?.filter((term) => term !== key) ?? [];
}
export function categoryAliasMatches(aliases: readonly string[], query: string): boolean {
  const key = normalize(query);
  return key.length > 0 && aliases.some((term) => term.includes(key));
}
