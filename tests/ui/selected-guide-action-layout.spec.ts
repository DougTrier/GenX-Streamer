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
