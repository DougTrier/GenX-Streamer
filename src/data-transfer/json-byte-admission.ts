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

export class JsonByteLimitError extends Error {
  constructor() {
    super('JSON record exceeds its storage bound.');
  }
}

/** Exact JSON UTF-8 size for normalized plain data, without an aggregate JSON string. */
export function boundedJsonUtf8Bytes(input: unknown, limit: number, signal?: AbortSignal): number {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 64 * 1024 * 1024)
    throw new Error('JSON byte admission limit is invalid.');
  const encoder = new TextEncoder();
  const ancestors = new Set<object>();
  let size = 0;
  const add = (bytes: number) => {
    size += bytes;
    if (size > limit) throw new JsonByteLimitError();
  };
  const unsupported = () => new Error('JSON byte admission requires normalized plain data.');
  const scalar = (value: string | number | boolean | null) => {
    // Only one bounded field/key is serialized at a time, never a record or array.
    add(encoder.encode(JSON.stringify(value)).byteLength);
  };
  const visit = (value: unknown, depth: number): void => {
    signal?.throwIfAborted();
    if (depth > 32) throw unsupported();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      scalar(value);
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw unsupported();
      scalar(value);
      return;
    }
    if (typeof value !== 'object' || ancestors.has(value)) throw unsupported();
    if ('toJSON' in value) throw unsupported();
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw unsupported();
    if (Object.getOwnPropertySymbols(value).length) throw unsupported();
    ancestors.add(value);
    add(2); // [] or {}
    if (array) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw unsupported();
      let entries = 0;
      // Avoid allocating a full string-key array for the large channel list.
      for (const key in value) {
        if (
          !Object.hasOwn(value, key) ||
          !/^(0|[1-9]\d*)$/.test(key) ||
          Number(key) >= value.length
        )
          throw unsupported();
        entries++;
      }
      if (entries !== value.length) throw unsupported();
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor || !('value' in descriptor)) throw unsupported();
        if (index) add(1);
        visit(descriptor.value, depth + 1);
      }
    } else {
      let first = true;
      for (const key of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) throw unsupported();
        if (!first) add(1);
        first = false;
        scalar(key);
        add(1); // :
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(value);
  };
  visit(input, 0);
  return size;
}
