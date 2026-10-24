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
  DiscoveryInputError,
  extractPageCandidates,
  MAX_DISCOVERY_BYTES,
} from '../../src/discovery/candidates';
const extract = (html: string) =>
  extractPageCandidates({
    pageUrl: 'https://origin.invalid/redirect?source=1',
    responseUrl: 'https://final.invalid/list/index?token=page',
    html,
  });
describe('supplied page discovery candidates', () => {
  it('uses the actual response base and keeps signed queries while stripping fragments', () => {
    const result = extract(
      '<base href="https://wrong.invalid/"><a href="../watch?sig=a%2Fb&amp;expires=7#player">Watch</a><video src="/live?token=secret" type="custom/hint"></video>',
    );
    expect(result.candidates.map((c) => [c.url, c.role, c.label])).toEqual([
      ['https://final.invalid/watch?sig=a%2Fb&expires=7', 'link', 'Watch'],
      ['https://final.invalid/live?token=secret', 'media-candidate', ''],
    ]);
    expect(result.candidates[0].provenance).toEqual({
      pageUrl: 'https://origin.invalid/redirect?source=1',
      responseUrl: 'https://final.invalid/list/index?token=page',
    });
    expect(result.candidates[1].mime).toBe('custom/hint');
  });
  it('does not classify file extensions as playable or identify stream format', () => {
    const result = extract(
      '<a href="/thing.m3u8">Link</a><source src="/extensionless?token=1" type="video/mp4">',
    );
    expect(result.candidates.map((c) => c.role)).toEqual(['link', 'media-candidate']);
    expect(result.candidates[0]).not.toHaveProperty('playable');
    expect(result.candidates[0]).not.toHaveProperty('mediaKind');
  });
  it('never extracts scripts, comments, embedded HTML, frames, templates, SVG or forms', () => {
    const html = `<!-- <a href="/comment"> -->
  <script>const x='<video src="/script">';</script><style>.x{content:'<a href="/style">'}</style>
  <template><template><a href="/nested"></a></template><a href="/outer"></a></template>
  <iframe src="/frame" srcdoc="<a href='/embedded'>"></iframe><svg><a href="/svg">SVG</a></svg>
  <textarea><a href="/textarea"></textarea><form action="/submit"></form><img src="/image"><a href="/safe">Safe</a>`;
    expect(extract(html).candidates.map((c) => c.url)).toEqual(['https://final.invalid/safe']);
  });
  it('refuses non-web schemes, obfuscated JavaScript, URL credentials and unsupported URL entities', () => {
    const html =
      '<a href="javascript&colon;alert(1)">JS</a><video src="data:video/mp4,x"></video><a href="file:///private">File</a><a href="https://user:password@secret.invalid/">Credentials</a><a href="/a&unknown;">Unknown entity</a><a href="//public.invalid/live">Web</a>';
    expect(extract(html).candidates.map((c) => c.url)).toEqual(['https://public.invalid/live']);
  });
  it('parses quoted angle brackets, numeric entities and duplicate attributes deterministically', () => {
    const result = extract(
      '<A HREF="/first?x=1&amp;y=2" href="/ignored" title="One > two"><span>ignored label</span></A><audio src=&#47;audio></audio>',
    );
    expect(result.candidates.map((c) => [c.url, c.label])).toEqual([
      ['https://final.invalid/first?x=1&y=2', 'One > two'],
      ['https://final.invalid/audio', ''],
    ]);
  });
  it('deduplicates complete URL/role/metadata tuples in original order, preserving distinct names and roles', () => {
    const html =
      '<a href="/one">One</a><a href="/one">One</a><a href="/one">Another</a><video src="/one" title="One"></video><a href="/two">Two</a>';
    const first = extract(html);
    expect(first.candidates.map((c) => [c.url, c.role, c.label])).toEqual([
      ['https://final.invalid/one', 'link', 'One'],
      ['https://final.invalid/one', 'link', 'Another'],
      ['https://final.invalid/one', 'media-candidate', 'One'],
      ['https://final.invalid/two', 'link', 'Two'],
    ]);
    expect(extract(html)).toEqual(first);
  });
  it('source/page provenance prevents cross-source identity merging', () => {
    const first = extractPageCandidates({
      pageUrl: 'https://first.invalid/',
      html: '<a href="https://stream.invalid/live">Same</a>',
    });
    const second = extractPageCandidates({
      pageUrl: 'https://second.invalid/',
      html: '<a href="https://stream.invalid/live">Same</a>',
    });
    expect(first.candidates[0].url).toBe(second.candidates[0].url);
    expect(first.candidates[0].key).not.toBe(second.candidates[0].key);
  });
  it('accepts 1000 unique candidates and explicitly rejects overflow without returning a prefix', () => {
    const html = Array.from({ length: 1000 }, (_, i) => `<a href="/c${i}">C${i}</a>`).join('');
    expect(extract(html).candidates).toHaveLength(1000);
    expect(() => extract(html + '<a href="/extra">Extra</a>')).toThrowError(
      expect.objectContaining({ code: 'candidate-limit' }),
    );
    expect(extract(html + '<a href="/c0">C0</a>').candidates).toHaveLength(1000);
  });
  it('bounds UTF-8 bytes, metadata and URL lengths explicitly', () => {
    expect(extract(' '.repeat(MAX_DISCOVERY_BYTES)).candidates).toEqual([]);
    expect(() => extract('é'.repeat(MAX_DISCOVERY_BYTES / 2 + 1))).toThrowError(
      expect.objectContaining({ code: 'byte-limit' }),
    );
    expect(() => extract(`<a href="/safe">${'a'.repeat(513)}</a>`)).toThrowError(
      expect.objectContaining({ code: 'field-limit' }),
    );
    expect(() => extract(`<video src="/${'a'.repeat(16384)}">`)).toThrowError(
      expect.objectContaining({ code: 'field-limit' }),
    );
  });
  it('gives actionable script-only and malformed page results without exposing supplied content', () => {
    expect(
      extract('<script src="https://secret.invalid/app?token=private"></script>').unsupportedReason,
    ).toContain('explicit source URL');
    for (const html of ['<a href="unfinished', '<!-- unfinished', '<script>unfinished'])
      expect(() => extract(html)).toThrow(DiscoveryInputError);
    try {
      extractPageCandidates({ pageUrl: 'https://user:secret@private.invalid/', html: '' });
    } catch (error) {
      expect((error as Error).message).not.toMatch(/secret|private\.invalid/);
    }
  });
});
