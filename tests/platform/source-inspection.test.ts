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

import { beforeEach, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke, isTauri: () => true }));
import { inspectSource } from '../../src/platform/records';
import { validateSource } from '../../src/catalog/codec';
beforeEach(() => bridge.invoke.mockReset());
it.each(['text/plain; charset=utf-8', 'TEXT/PLAIN; Charset=UTF-8', ' text/plain '])(
  'canonicalizes native Content-Type %s before strict source persistence',
  async (mime) => {
    bridge.invoke.mockResolvedValue({ kind: 'catalog', text: '#EXTM3U\n', mime });
    const result = await inspectSource(
      'https://fixture.invalid/source',
      false,
      new AbortController().signal,
    );
    expect(result).toEqual({ kind: 'catalog', text: '#EXTM3U\n', mime: 'text/plain' });
    expect(
      validateSource({
        id: 'source',
        name: 'Fixture',
        kind: 'url',
        location: 'https://fixture.invalid/source',
        mediaMime: result.mime,
      }).mediaMime,
    ).toBe('text/plain');
  },
);
it.each(['bad MIME', 'text/plain\r\nx-secret: value', 'x'.repeat(129) + '/plain'])(
  'does not persist malformed optional header metadata',
  async (mime) => {
    bridge.invoke.mockResolvedValue({ kind: 'catalog', text: '#EXTM3U\n', mime });
    expect(
      await inspectSource('https://fixture.invalid/source', false, new AbortController().signal),
    ).toEqual({ kind: 'catalog', text: '#EXTM3U\n' });
  },
);
