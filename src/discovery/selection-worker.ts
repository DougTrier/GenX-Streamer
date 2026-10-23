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
