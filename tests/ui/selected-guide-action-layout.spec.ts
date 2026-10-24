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

import { expect, test } from '@playwright/test';
import { mountLiveViewingPane, expectLiveVideoOnly } from './helpers/live-viewing-pane';
for (const tv of [false, true])
  for (const mapped of [false, true]) {
    test(`Guide configuration stays out of short Live pane: TV=${tv}, mapped=${mapped}`, async ({
      page,
    }) => {
      await mountLiveViewingPane(page, 960, 540, tv, 2);
      await page.evaluate(
        (mapped) => Reflect.get(window, 'livePaneFixture').update(mapped),
        mapped,
      );
      await expectLiveVideoOnly(page);
      expect(await page.getByRole('button', { name: 'Map guide', exact: true }).count()).toBe(0);
      const guide = page.getByRole('button', { name: 'Free TV guide', exact: true });
      await guide.focus();
      await expect(guide).toBeFocused();
      const bounds = await guide.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(961);
      await page.evaluate(() => Reflect.get(window, 'livePaneFixture').dispose());
    });
  }
