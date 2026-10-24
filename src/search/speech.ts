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

/** Adapter capability describes the selected provider, not browser constructor presence. */
export interface SpeechCapability {
  available: boolean;
  mode: 'on-device' | 'cloud' | 'unknown';
  reason?:
    | 'unsupported'
    | 'permission-denied'
    | 'language-unavailable'
    | 'service-unavailable'
    | 'package-identity-required';
  languages: readonly string[];
}
export type SpeechResult =
  | { status: 'final'; transcript: string }
  | { status: 'no-match' | 'canceled' }
  | {
      status: 'failed';
      reason:
        | 'permission-denied'
        | 'service-unavailable'
        | 'network'
        | 'timeout'
        | 'language-unavailable';
    };
/**
 * One start owns one recognizer/listener/microphone. Only final text enters the
 * shared typed-search path. Cancel/dispose resolve after release, including a
 * pending initializer. No retry, auto restart, raw audio or transcript logging.
 */
export interface OneShotRecognizer {
  capability(): Promise<SpeechCapability>;
  recognize(options: {
    language: string;
    signal: AbortSignal;
    /** Absolute epoch-millisecond deadline; owner/adapter enforces and releases capture. */
    deadlineMs: number;
    allowCloud: boolean;
  }): Promise<SpeechResult>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}
