import { expect, it } from 'vitest';
import { ScanSourcesChanged, sourcesChangedRefusal } from '../../src/ui/source-scan';

it('explains a native Continue refusal caused by changed sources or grants', () => {
  const original = new Error('Native command could not finish.');
  for (const code of ['scan-checkpoint-policy-stale', 'scan-checkpoint-source-not-resumable'])
    expect(sourcesChangedRefusal(code, original)).toBeInstanceOf(ScanSourcesChanged);
  for (const code of [null, undefined, 'scan-resume-plan-stale', 'scan-checkpoint-policy-stale-x'])
    expect(sourcesChangedRefusal(code, original)).toBe(original);
});
