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

import { expect, it } from 'vitest';
import { ScanSourcesChanged, sourcesChangedRefusal } from '../../src/ui/source-scan';

it('explains a native Continue refusal caused by changed sources or grants', () => {
  const original = new Error('Native command could not finish.');
  for (const code of ['scan-checkpoint-policy-stale', 'scan-checkpoint-source-not-resumable'])
    expect(sourcesChangedRefusal(code, original)).toBeInstanceOf(ScanSourcesChanged);
  for (const code of [null, undefined, 'scan-resume-plan-stale', 'scan-checkpoint-policy-stale-x'])
    expect(sourcesChangedRefusal(code, original)).toBe(original);
});
