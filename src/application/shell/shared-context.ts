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

type Readers = Record<string, () => unknown>;
type Writers<R extends Readers> = { [K in keyof R]?: (value: ReturnType<R[K]>) => void };

/** One live property per shared value; only the ones with a writer can be assigned. */
export type SharedContext<R extends Readers, W extends Writers<R>> = {
  readonly [K in Exclude<keyof R, keyof W>]: ReturnType<R[K]>;
} & { -readonly [K in keyof W & keyof R]: ReturnType<R[K]> };

/**
 * Builds the application context main.ts hands to each area controller.
 *
 * `read` gives each shared value's current state. It is read when a controller
 * uses the value, not when the context is built, so values created later in
 * start-up are seen as soon as they exist. `write` lists the values that
 * controllers may assign, and how the assignment reaches main.ts.
 */
export function createSharedContext<R extends Readers, W extends Writers<R>>(
  read: R,
  write: W,
): SharedContext<R, W> {
  const context = {};
  for (const key of Object.keys(read))
    Object.defineProperty(context, key, {
      enumerable: true,
      get: read[key],
      set: (write as Partial<Record<string, (value: unknown) => void>>)[key],
    });
  return context as SharedContext<R, W>;
}
