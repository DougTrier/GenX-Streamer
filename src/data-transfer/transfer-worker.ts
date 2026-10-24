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

import { migrateLegacyJson, prepareBackupImport, prepareTransfer } from './index';
import type { TransferRequest } from './worker';
self.onmessage = async (event: MessageEvent<TransferRequest>) => {
  try {
    const request = event.data;
    if (request.kind !== 'backup' && request.kind !== 'legacy' && request.kind !== 'export')
      throw new Error('Unsupported import operation.');
    const result =
      request.kind === 'export'
        ? prepareTransfer(request.record)
        : request.kind === 'backup'
          ? prepareBackupImport(request.text)
          : await migrateLegacyJson(request.text, request.options);
    self.postMessage({ ok: true, result });
  } catch (error) {
    // Our codecs emit fixed categories; never echo untrusted fields, URLs or serialized input.
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Import preparation failed.',
    });
  }
};
