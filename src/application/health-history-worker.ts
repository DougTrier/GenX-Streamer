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

import { decodeSavedHealth, decodeSavedHealthOnly, evaluateHealthHistory } from './health-history';
import type { HistoryRequest } from './health-history-read';
self.onmessage = async (event: MessageEvent<HistoryRequest>) => {
  try {
    const request = event.data;
    if (request.kind !== 'decode' && request.kind !== 'decode-health' && request.kind !== 'page')
      throw new Error('Unsupported saved check operation.');
    const value =
      request.kind === 'decode'
        ? decodeSavedHealth(request.snapshot)
        : request.kind === 'decode-health'
          ? decodeSavedHealthOnly(request.snapshot)
          : await evaluateHealthHistory(request.snapshot, request.query, request.context);
    self.postMessage({ ok: true, value });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Saved checks could not be read.',
    });
  }
};
