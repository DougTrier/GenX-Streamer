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
