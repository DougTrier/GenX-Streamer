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

import {
  prepareOwnedScanCommit,
  prepareOwnedNativeScanBatch,
  type ReviewedScanHealthContext,
  prepareOwnedCompactScanCommit,
  type ScanPreparationHealthOptions,
} from './prepare-selection';
import type { CatalogRecord } from '../catalog';
import type { Preferences } from '../preferences';
import type { ScanSource, StagedScanSelection } from './scan';
import { classifyScanPreparationFailure } from './selection-failure';
self.onmessage = (
  event: MessageEvent<{
    catalog: CatalogRecord;
    preferences: Preferences;
    selection: StagedScanSelection;
    scope: ScanSource[];
    health?: ScanPreparationHealthOptions;
    operation?: 'compact' | 'native-batch';
    review?: ReviewedScanHealthContext;
  }>,
) => {
  void run(event.data);
};
async function run(data: {
  catalog: CatalogRecord;
  preferences: Preferences;
  selection: StagedScanSelection;
  scope: ScanSource[];
  health?: ScanPreparationHealthOptions;
  operation?: 'compact' | 'native-batch';
  review?: ReviewedScanHealthContext;
}): Promise<void> {
  try {
    self.postMessage({
      ok: true,
      result:
        data.operation === 'native-batch'
          ? await prepareOwnedNativeScanBatch(
              data.catalog,
              data.preferences,
              data.selection,
              data.scope,
              data.review,
            )
          : await (
              data.operation === 'compact' ? prepareOwnedCompactScanCommit : prepareOwnedScanCommit
            )(data.catalog, data.preferences, data.selection, data.scope, data.health),
    });
  } catch (failure) {
    self.postMessage({
      ok: false,
      code: classifyScanPreparationFailure(failure),
    });
  }
}
