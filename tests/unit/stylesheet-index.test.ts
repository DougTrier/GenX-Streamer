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

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readStylesheet, readStylesheetSync } from '../support/stylesheet';

const sheets = readdirSync('src/ui').filter((name) => name.endsWith('.css'));
const indexes = sheets.filter((name) => /^@import /m.test(readFileSync(`src/ui/${name}`, 'utf8')));

it('style.css and responsive.css are indexes of their parts', () => {
  expect(indexes).toEqual(expect.arrayContaining(['style.css', 'responsive.css']));
});

it.each(indexes)('%s only imports existing parts, before any rule', (name) => {
  // Browsers ignore an @import that follows a rule, so an index holds nothing else.
  const text = readFileSync(`src/ui/${name}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const line of text.split('\n').filter((line) => line.trim()))
    expect(line).toMatch(/^@import '\.\/[a-z0-9-]+\.css';\s*$/);
  for (const [, part] of text.matchAll(/@import '\.\/([a-z0-9-]+\.css)'/g))
    expect(existsSync(`src/ui/${part}`)).toBe(true);
});

it.each(indexes)('%s reads back with every part inlined, in order', async (name) => {
  const text = readStylesheetSync(`src/ui/${name}`);
  expect(text).not.toMatch(/^@import /m);
  expect(await readStylesheet(`src/ui/${name}`)).toBe(text);
  const parts = [...readFileSync(`src/ui/${name}`, 'utf8').matchAll(/@import '\.\/([^']+)'/g)];
  let at = -1;
  for (const [, part] of parts) {
    const position = text.indexOf(readFileSync(`src/ui/${part}`, 'utf8'));
    expect(position).toBeGreaterThan(at);
    at = position;
  }
});
