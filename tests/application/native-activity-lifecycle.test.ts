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

/**
 * Actual listener source from the foreground controller, isolated from platform
 * setup; no native/device claim. `context` stands in for the controller's
 * environment.
 */
function fixture() {
  const main = readFileSync('src/application/shell/foreground-controller.ts', 'utf8');
  const start = main.indexOf('let nativeActivityLifecycleSequence = 0;');
  const end = main.indexOf("window.addEventListener('native-back-requested'", start);
  if (start < 0 || end < start) throw new Error('Lifecycle listener boundary missing');
  const handlers = new Map<string, (event: { detail?: unknown }) => void>();
  const calls = { suspend: 0, resume: 0, native: [] as boolean[], guide: 0, daily: 0 };
  const context = {
    window: {
      addEventListener: (name: string, callback: (event: { detail?: unknown }) => void) =>
        handlers.set(name, callback),
    },
    nativeViewingForeground: true,
    applicationClosing: false,
    contentLibrary: 'live',
    updateGuideForeground: () => {
      calls.guide++;
    },
    viewingForeground: {
      setNativeForeground: async (value: boolean) => {
        calls.native.push(value);
      },
    },
    playbackAction: () => {},
    suspendForegroundWork: async () => {
      calls.suspend++;
    },
    resumeForegroundScan: () => {
      calls.resume++;
    },
    wakeDailyRefresh: () => {
      calls.daily++;
    },
  };
  runInNewContext(
    ts.transpileModule(main.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText,
    {
      window: context.window,
      env: context,
      suspendForegroundWork: context.suspendForegroundWork,
      resumeForegroundScan: context.resumeForegroundScan,
    },
  );
  const emit = (foreground: boolean, sequence: number) =>
    handlers.get(foreground ? 'native-app-foreground' : 'native-app-background')!({
      detail: { schemaVersion: 1, sequence, foreground },
    });
  return { calls, context, emit, handlers };
}
it('newest activity sequence wins, duplicate process/focus replays cannot repeat drains or resumes', () => {
  const f = fixture();
  f.emit(false, 2);
  f.emit(false, 2);
  f.emit(true, 1);
  expect(f.context.nativeViewingForeground).toBe(false);
  expect(f.calls.suspend).toBe(1);
  expect(f.calls.resume).toBe(0);
  f.emit(true, 3);
  f.emit(true, 4);
  f.emit(false, 2);
  expect(f.context.nativeViewingForeground).toBe(true);
  expect(f.calls.native).toEqual([false, true]);
  expect(f.calls.resume).toBe(1);
  expect(f.calls.guide).toBe(2);
});
it('malformed or mismatched lifecycle envelopes have no effect, and closing never reactivates', () => {
  const f = fixture();
  for (const detail of [
    { schemaVersion: 2, sequence: 1, foreground: false },
    { schemaVersion: 1, sequence: NaN, foreground: false },
    { schemaVersion: 1, sequence: 0, foreground: false },
    { schemaVersion: 1, sequence: 1, foreground: true },
    { schemaVersion: 1, sequence: 1, foreground: false, extra: true },
  ])
    f.handlers.get('native-app-background')!({ detail });
  expect(f.calls.suspend).toBe(0);
  f.emit(false, 2);
  f.context.applicationClosing = true;
  f.emit(true, 3);
  expect(f.context.nativeViewingForeground).toBe(false);
  expect(f.calls.resume).toBe(0);
});
it('legacy ordinary events remain compatible but idempotent', () => {
  const f = fixture();
  f.handlers.get('native-app-background')!({});
  f.handlers.get('native-app-background')!({});
  f.handlers.get('native-app-foreground')!({});
  f.handlers.get('native-app-foreground')!({});
  expect(f.calls.native).toEqual([false, true]);
  expect(f.calls.suspend).toBe(1);
  expect(f.calls.resume).toBe(1);
});
