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
/**
 * The main screen (watching or the program guide) and the state of a switch
 * between them: the requested and active intent, the pending transition and
 * its diagnostics.
 */
import type { PrimaryPage } from './primary-page';

export type PrimaryTransitionStage =
  | 'idle'
  | 'queued'
  | 'closing-guide'
  | 'closing-search'
  | 'refused'
  | 'opening'
  | 'completed'
  | 'failed';
export type PrimaryTransitionReason =
  | 'none'
  | 'application-closing'
  | 'superseded'
  | 'document-hidden'
  | 'native-background'
  | 'operation-failed';

export interface PageState {
  primaryPage: PrimaryPage;
  primaryIntent: number;
  primaryTransitions: Promise<void>;
  primaryTransitionStage: PrimaryTransitionStage;
  primaryTransitionReason: PrimaryTransitionReason;
  primaryTransitionRevision: number;
  primaryTransitionActiveIntent: number;
  primaryTransitionRequestedIntent: number;
  primaryTransitionPending: number;
  primaryTransitionErrorCount: number;
  guideOpenedFrom: string;
}

export function createPageState(): PageState {
  return {
    primaryPage: 'watch',
    primaryIntent: 0,
    primaryTransitions: Promise.resolve(),
    primaryTransitionStage: 'idle',
    primaryTransitionReason: 'none',
    primaryTransitionRevision: 0,
    primaryTransitionActiveIntent: 0,
    primaryTransitionRequestedIntent: 0,
    primaryTransitionPending: 0,
    primaryTransitionErrorCount: 0,
    guideOpenedFrom: 'watch',
  };
}
