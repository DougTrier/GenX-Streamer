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
import { createCloseProgressObserver } from '../../src/application/shell/close-progress';
const progress = {
  schemaVersion: 1,
  generation: 2,
  running: true,
  stage: 'frontend',
  reason: 'observation-deadline',
  frontendSettled: false,
  nativeSettled: true,
};
describe('native close scalar diagnostic admission', () => {
  it('copies only allowed fields, rejects stale generations and preserves frozen snapshots', () => {
    const observer = createCloseProgressObserver();
    observer.receive({ ...progress, token: 'private-secret' });
    const before = observer.snapshot();
    expect(Object.isFrozen(before)).toBe(true);
    expect(JSON.stringify(before)).not.toContain('secret');
    observer.receive({ ...progress, generation: 1, stage: 'failed' });
    expect(observer.snapshot()).toBe(before);
    observer.receive({ ...progress, running: false, stage: 'settled', reason: null });
    expect(observer.snapshot()?.stage).toBe('settled');
    expect(before?.stage).toBe('frontend');
  });
  it('rejects malformed or unknown native event contracts without losing prior evidence', () => {
    const observer = createCloseProgressObserver();
    observer.receive(progress);
    const before = observer.snapshot();
    for (const value of [
      null,
      'private-error',
      { ...progress, reason: 'secret-url' },
      { ...progress, generation: NaN },
      { ...progress, stage: 'unknown' },
      { ...progress, frontendSettled: 1 },
      { ...progress, schemaVersion: 2 },
    ])
      observer.receive(value);
    expect(observer.snapshot()).toBe(before);
  });
});
