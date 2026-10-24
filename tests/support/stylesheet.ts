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
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Stylesheets such as src/ui/style.css are indexes that @import their parts.
// The build and the browser follow those imports; a test that injects a
// sheet's text into a page must inline them itself, in the same order.
const importRule = /^@import '(\.\/[^']+\.css)';.*$/gm;

/** A stylesheet's text with its local @import rules replaced by the imported text. */
export function readStylesheetSync(path: string): string {
  return readFileSync(path, 'utf8').replace(importRule, (_rule, target: string) =>
    readStylesheetSync(join(dirname(path), target)),
  );
}

/** As readStylesheetSync, for tests that read files asynchronously. */
export async function readStylesheet(path: string): Promise<string> {
  const text = await readFile(path, 'utf8');
  const parts = await Promise.all(
    [...text.matchAll(importRule)].map(([, target]) => readStylesheet(join(dirname(path), target))),
  );
  let index = 0;
  return text.replace(importRule, () => parts[index++]);
}
