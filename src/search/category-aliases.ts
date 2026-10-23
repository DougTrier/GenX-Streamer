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
