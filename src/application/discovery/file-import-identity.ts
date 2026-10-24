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

import { validateSource, type Source } from '../../catalog';

/** A filename is a display label, never an identity or an implicit update. */
export function createFileImportSource(
  filename: string,
  allowHttp: boolean,
  previous?: Source,
  createId: () => string = () => crypto.randomUUID(),
): Source {
  if (previous && previous.kind !== 'file')
    throw new Error('Choose a saved file playlist to update.');
  const id = previous?.id ?? createId();
  return validateSource({
    id,
    name: filename,
    kind: 'file',
    location: previous?.location ?? `import:${id}`,
    allowHttp,
  });
}
