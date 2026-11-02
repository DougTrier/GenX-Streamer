// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
/** Document identity preserves queries and transport permissions. */
export function sourceDocumentKey(source: { location: string; allowHttp?: boolean }): string {
  return JSON.stringify([new URL(source.location).href, source.allowHttp === true]);
}
/** Reserved/sample links from published instructions are not automatic providers.
 * Explicit custom sources remain the owner's choice. */
export function publishedSourceTemplate(location: string): boolean {
  const url = new URL(location);
  return (
    ['example.com', 'example.org', 'example.net'].includes(url.hostname) ||
    /(?:^|\/)FILENAME\.m3u8?$/.test(url.pathname)
  );
}
const nexus = 'https://dearbulut.github.io/iptv/playlists/';
/** This publisher documents index as every stream and best/online as subsets:
 * https://github.com/dearbulut/iptv#quick-start
 * The October 31 audit also confirmed exact entry metadata and guide headers.
 * Keep curated lists when index is absent, and never fold differing permissions,
 * queries, foreign hosts or other providers with merely overlapping channels.
 * This reduces a scan plan; saved channels, favorites and provider choices stay intact. */
export function distinctSourceDocuments<T extends { location: string; allowHttp?: boolean }>(
  sources: readonly T[],
): T[] {
  const full = new Set(
    sources
      .filter((s) => new URL(s.location).href === `${nexus}index.m3u`)
      .map((s) => s.allowHttp === true),
  );
  const seen = new Set<string>();
  return sources.filter((source) => {
    const location = new URL(source.location).href;
    if (
      (location === `${nexus}best.m3u` || location === `${nexus}online.m3u`) &&
      full.has(source.allowHttp === true)
    )
      return false;
    const key = sourceDocumentKey(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
