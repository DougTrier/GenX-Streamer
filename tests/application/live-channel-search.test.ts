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

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Execute the actual application wiring without platform setup or media/network authority.
function fixture() {
  const source = readFileSync('src/main.ts', 'utf8');
  const handlers = new Map<string, (event: { key?: string; preventDefault(): void }) => void>();
  const calls = {
    channelQueries: [] as string[],
    guideQueries: [] as string[],
    acquired: 0,
    focus: '',
    blurred: 0,
  };
  const search = { value: 'evening news', blur: () => calls.blurred++ };
  const nodes = new Map<string, object>([['search', search]]);
  const element = (id: string) => {
    if (!nodes.has(id))
      nodes.set(id, {
        hidden: true,
        focus: () => {
          calls.focus = id;
        },
        addEventListener: (
          type: string,
          callback: typeof handlers extends Map<string, infer T> ? T : never,
        ) => handlers.set(`${id}:${type}`, callback),
      });
    const node = nodes.get(id)!;
    if (id === 'search')
      Object.assign(node, {
        addEventListener: (
          type: string,
          callback: (event: { key?: string; preventDefault(): void }) => void,
        ) => handlers.set(`${id}:${type}`, callback),
      });
    return node;
  };
  const context = {
    element,
    contentLibrary: 'live',
    liveBrowseSuspended: false,
    browser: { search: (query: string) => calls.channelQueries.push(query) },
    libraryQueries: { live: '', genxtra: '' },
    playbackAction: (work: unknown) => work,
    switchPrimaryPage: (page: string, query: string) => {
      expect(page).toBe('guide');
      calls.guideQueries.push(query);
    },
    startInlineDiscovery: () => {
      calls.acquired++;
    },
  };
  const start = source.indexOf("element('guide-button').addEventListener('click'");
  const end = source.indexOf('function genxtraNavigation(', start);
  const inputStart = source.indexOf("element('search-programs').addEventListener('click'");
  const inputEnd = source.indexOf("element('clear-search').addEventListener", inputStart);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(inputEnd).toBeGreaterThan(inputStart);
  runInNewContext(
    ts.transpileModule(source.slice(start, end) + source.slice(inputStart, inputEnd), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText,
    context,
  );
  return { calls, context, search, handlers, source };
}
it('Live typing and Enter search actual channels only, retain text, and do not acquire or allocate a program-results owner', () => {
  const f = fixture();
  let prevented = 0;
  f.handlers.get('search:input')!({ preventDefault() {} });
  f.handlers.get('search:keydown')!({ key: 'Enter', preventDefault: () => prevented++ });
  expect(f.calls.channelQueries).toEqual(['evening news', 'evening news']);
  expect(f.context.libraryQueries.live).toBe('evening news');
  expect(f.search.value).toBe('evening news');
  expect(f.calls.focus).toBe('channel-list');
  expect(prevented).toBe(1);
  expect(f.calls.acquired).toBe(0);
  expect(f.calls.guideQueries).toEqual([]);
  expect(f.source).not.toMatch(
    /mountProgramSearch|programSearchPane|programSearchPendingCancellation/,
  );
});
// Owner request, October 19, 2026: the Guide button always opens the grid;
// text left in the channel search no longer turns it into Program search.
it('Guide opens on the grid and leaves the channel search text alone', () => {
  const f = fixture();
  f.handlers.get('guide-button:click')!({ preventDefault() {} });
  expect(f.calls.guideQueries).toEqual([undefined]);
  expect(f.calls.channelQueries).toEqual([]);
  expect(f.search.value).toBe('evening news');
  expect(f.calls.acquired).toBe(0);
});
it('background Live Enter cannot start a query or move focus', () => {
  const f = fixture();
  f.context.liveBrowseSuspended = true;
  f.handlers.get('search:keydown')!({
    key: 'Enter',
    preventDefault() {
      throw Error('Unexpected interception');
    },
  });
  expect(f.calls.channelQueries).toEqual([]);
  expect(f.calls.focus).toBe('');
  expect(f.search.value).toBe('evening news');
});
