export interface EnduranceBudgets {
  browsingPssMiB: number;
  playbackPssMiB: number;
  growthMiBPerHour: number;
  longFramePercent: number;
  playbackFailures: number;
}
export interface EnduranceCheck {
  name: string;
  value: number | null;
  limit: number;
  ok: boolean;
}
export const BUDGETS: EnduranceBudgets;
export function growthPerHour(points: Array<[number, number]>): number | null;
export function judge(
  samples: Array<{ elapsedMs: number; totalPssMiB: number | null; playing?: boolean }>,
  steps: Array<{ kind: string; ok?: boolean; frames?: { count: number; long: number } }>,
  budgets?: EnduranceBudgets,
): { verdict: 'PASS' | 'FAIL' | 'INCOMPLETE'; reason?: string; checks: EnduranceCheck[] };
