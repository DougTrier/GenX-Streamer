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
 * GenXtra banner in a real browser: Play text, the TV capability layout and
 * screen sizes.
 */
import { expect, it } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { useGenxtraBannerBrowser, mount } from './genxtra-banner-browser.fixture';

useGenxtraBannerBrowser();

it('fits actual-font Play text on one line in the 42px TV episode action without changing its neighbors', async () => {
  const page = await mount(960, 540, true, true);
  try {
    await page.locator('.gx-archive-title-button').first().click();
    const play = page.locator('.gx-archive-file-button').first();
    await browserExpect(play).toHaveText('Play');
    const geometry = await play.evaluate((button) => {
      const box = button.getBoundingClientRect(),
        style = getComputedStyle(button);
      const range = document.createRange();
      range.selectNodeContents(button);
      const lines = [...range.getClientRects()].map((rect) => ({
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
      }));
      const more = button.nextElementSibling!.querySelector('summary')!.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        font: style.font,
        size: style.fontSize,
        weight: style.fontWeight,
        available:
          button.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        lines,
        moreWidth: more.width,
        moreHeight: more.height,
        gap: more.left - box.right,
      };
    });
    await writeFile(
      'artifacts/tv-navigation/2026-10-15/tv-play-text-geometry.json',
      JSON.stringify(geometry, null, 2),
    );
    await page.screenshot({ path: 'artifacts/tv-navigation/2026-10-15/tv-play-text.png' });
    expect(geometry).toMatchObject({
      width: 42,
      height: 34,
      size: '14px',
      weight: '600',
      moreWidth: 26,
      moreHeight: 34,
      gap: 8,
    });
    expect(geometry.lines).toHaveLength(1);
    expect(geometry.lines[0]!.width).toBeLessThanOrEqual(geometry.available);
    expect(geometry.lines[0]!.left).toBeGreaterThanOrEqual(geometry.left);
    expect(geometry.lines[0]!.right).toBeLessThanOrEqual(geometry.right);
    expect(geometry.lines[0]!.bottom).toBeLessThanOrEqual(geometry.bottom);
    const more = page.locator('.gx-archive-file-details > summary');
    await browserExpect(more.first()).toHaveText('⌄');
    await browserExpect(more.first()).toHaveAttribute(
      'aria-label',
      'Video details for Controlled episode 1',
    );
    // The real selected-file renderer reveals and focuses its first Play.
    await browserExpect(play).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await browserExpect(more.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await browserExpect(more.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await browserExpect(page.locator('.gx-archive-file-button').nth(1)).toBeFocused();
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
  } finally {
    await page.close();
  }
});
it('sizes and centers the full TV capability dock to its text in normal and fullscreen views', async () => {
  const page = await mount(960, 540, true);
  try {
    await page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>('video')!;
      const tracks = Object.assign(new EventTarget(), { length: 2 });
      for (let i = 0; i < 2; i++)
        Reflect.set(tracks, i, {
          enabled: i === 0,
          label: `Controlled track ${i}`,
          language: 'English supplementary description',
        });
      Object.defineProperty(video, 'audioTracks', { value: tracks, configurable: true });
      const audio = Reflect.get(window, 'LayoutAudio').createBrowserAudioTracks(video, {
        current: () => true,
        canSelect: () => true,
        emit: () => {},
        owners: Reflect.get(window, 'LayoutAudio').createResourceOwners(),
      });
      audio.activate();
      audio.attachNative();
      Reflect.set(window, 'dockAudioOwner', audio);
      Reflect.set(
        window,
        'dockAudioDispose',
        Reflect.get(window, 'LayoutAudio').installAudioTracks(
          video,
          document.getElementById('audio-tracks'),
        ),
      );
      Reflect.set(
        window,
        'dockQualityDispose',
        Reflect.get(window, 'LayoutQuality').installVideoQuality(
          video,
          document.getElementById('video-quality'),
          {
            read: () => ({
              auto: true,
              currentLevel: 0,
              availableLevels: [{ index: 0, height: 2160, bitrate: 8000000 }],
              levelsTruncated: false,
            }),
            set: () => {
              throw Error('Unexpected quality activation');
            },
          },
        ),
      );
      Reflect.set(
        window,
        'dockFullscreen',
        Reflect.get(window, 'LayoutFullscreen').installFullscreenPresentation(
          document.getElementById('app'),
        ),
      );
    });
    const measurements = [];
    for (const fullscreen of [false, true]) {
      await page.evaluate((active) => {
        Reflect.get(window, 'dockFullscreen').set(active);
        document.getElementById('fullscreen-button')!.textContent = active
          ? 'Exit full screen'
          : 'Full screen';
      }, fullscreen);
      const measured = await page.locator('.dock').evaluate((dock) => {
        const rect = dock.getBoundingClientRect();
        const buttons = [...dock.querySelectorAll<HTMLButtonElement>('button')].filter(
          (button) => button.getClientRects().length > 0,
        );
        return {
          left: rect.left,
          right: rect.right,
          height: rect.height,
          buttons: buttons.map((button) => {
            const box = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            const range = document.createRange();
            range.selectNodeContents(button);
            return {
              label: button.getAttribute('aria-label') || button.textContent!,
              left: box.left,
              right: box.right,
              top: box.top,
              width: box.width,
              height: box.height,
              textWidth: range.getBoundingClientRect().width,
              padding: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
              ellipsis: style.textOverflow === 'ellipsis',
              fullAccessibleLabel: button.getAttribute('aria-label'),
              textFits:
                button.scrollWidth <= button.clientWidth &&
                button.scrollHeight <= button.clientHeight,
            };
          }),
        };
      });
      measurements.push({ fullscreen, ...measured });
      expect(measured.buttons).toHaveLength(fullscreen ? 6 : 7);
      expect(new Set(measured.buttons.map((button) => button.top)).size).toBe(1);
      const first = measured.buttons[0]!,
        last = measured.buttons.at(-1)!;
      expect(first.left - measured.left).toBeCloseTo(measured.right - last.right, 0);
      for (let i = 0; i < measured.buttons.length; i++) {
        const button = measured.buttons[i]!;
        expect(button.height).toBe(34);
        expect(button.left).toBeGreaterThanOrEqual(measured.left);
        expect(button.right).toBeLessThanOrEqual(measured.right);
        if (i) expect(button.left - measured.buttons[i - 1]!.right).toBeGreaterThanOrEqual(8);
        if (button.ellipsis) {
          expect(button.width).toBeLessThanOrEqual(120);
          expect(button.fullAccessibleLabel).toMatch(/Video quality|Audio track/);
        } else {
          expect(button.textFits).toBe(true);
          expect(button.width).toBeLessThanOrEqual(
            Math.max(34, button.textWidth + button.padding + 30),
          );
        }
      }
      await page.screenshot({
        path: `artifacts/tv-navigation/2026-10-15/tv-content-width-${fullscreen ? 'fullscreen' : 'normal'}.png`,
      });
    }
    await page.getByRole('button', { name: 'Audio track', exact: true }).click();
    const audioChoice = page.getByRole('menuitemradio').filter({ hasText: 'Controlled track 0' });
    await browserExpect(audioChoice).toHaveAttribute('title', /English supplementary description/);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      Reflect.get(window, 'dockFullscreen').set(false);
      document.getElementById('fullscreen-button')!.textContent = 'Full screen';
      const vod = Reflect.get(window, 'LayoutVODDock').installVODDock(
        document.getElementById('app'),
      );
      vod.render(true);
      Reflect.set(window, 'dockVOD', vod);
      document.getElementById('vod-transport')!.hidden = false;
    });
    const vod = await page.locator('.dock').evaluate((node) => {
      const dock = node.getBoundingClientRect();
      const controls = [...node.querySelectorAll<HTMLElement>('button,output')].filter(
        (control) => control.getClientRects().length > 0,
      );
      return controls.map((control) => {
        const box = control.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          center: box.top + box.height / 2,
          height: box.height,
          contained: box.left >= dock.left && box.right <= dock.right,
        };
      });
    });
    expect(vod.every((control) => control.contained)).toBe(true);
    expect(new Set(vod.map((control) => control.center)).size).toBe(1);
    expect(vod.filter((control) => control.height === 34)).toHaveLength(8);
    for (let i = 1; i < vod.length; i++)
      expect(vod[i]!.left - vod[i - 1]!.right).toBeGreaterThanOrEqual(8);
    await page.screenshot({ path: 'artifacts/tv-navigation/2026-10-15/tv-content-width-vod.png' });
    await writeFile(
      'artifacts/tv-navigation/2026-10-15/tv-content-width-geometry.json',
      JSON.stringify(measurements, null, 2),
    );
    await writeFile(
      'artifacts/tv-navigation/2026-10-15/tv-content-width-vod-geometry.json',
      JSON.stringify(vod, null, 2),
    );
  } finally {
    await page.evaluate(() => {
      Reflect.get(window, 'dockFullscreen')?.dispose();
      Reflect.get(window, 'dockVOD')?.dispose();
      Reflect.get(window, 'dockQualityDispose')?.();
      Reflect.get(window, 'dockAudioDispose')?.();
      Reflect.get(window, 'dockAudioOwner')?.dispose();
    });
    await page.close();
  }
});
for (const [width, height] of [
  [1280, 825],
  [390, 844],
]) {
  it(`keeps real shell filter labels single-line without phantom icons and contains a decoded JPEG at ${width}x${height}`, async () => {
    const page = await mount(width, height);
    try {
      const controls = page.locator('#genxtra-browse-filters select');
      await browserExpect(controls).toHaveCount(2);
      for (const control of await controls.all()) {
        await browserExpect(control).toBeVisible();
        const layout = await control.evaluate((button) => {
          const select = button as HTMLSelectElement;
          const style = getComputedStyle(select);
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d')!;
          context.font = style.font;
          const textWidth = context.measureText(select.selectedOptions[0]!.label).width;
          const before = getComputedStyle(button, '::before');
          const rect = button.getBoundingClientRect();
          return {
            iconAbsent: before.display === 'none' || ['none', 'normal'].includes(before.content),
            textLines: style.whiteSpace === 'nowrap' ? 1 : 0,
            textWidth,
            width: rect.width,
            height: rect.height,
          };
        });
        expect(layout.iconAbsent).toBe(true);
        expect(layout.textLines).toBe(1);
        expect(layout.textWidth).toBeLessThanOrEqual(layout.width);
        expect(layout.height).toBeGreaterThanOrEqual(44);
      }
      const titleButton = page.locator('.gx-archive-title-button');
      const titleGeometry = () =>
        titleButton.evaluate((node) => {
          const marker = getComputedStyle(node, '::after');
          const name = node.querySelector('.gx-archive-result-name')!;
          return {
            expanded: node.getAttribute('aria-expanded'),
            marker: marker.content,
            markerWidth: parseFloat(marker.width),
            markerBorder: marker.borderRightStyle,
            markerPosition: marker.position,
            markerTransform: marker.transform,
            nameWidth: name.getBoundingClientRect().width,
            nameFont: getComputedStyle(name).fontSize,
            buttonHeight: node.getBoundingClientRect().height,
          };
        });
      const collapsed = await titleGeometry();
      expect(collapsed).toMatchObject({
        expanded: 'false',
        marker: '""',
        markerWidth: 4,
        markerBorder: 'solid',
        markerPosition: 'absolute',
        nameFont: '17px',
      });
      await titleButton.click();
      const expanded = await titleGeometry();
      expect(expanded.expanded).toBe('true');
      expect(expanded.markerTransform).not.toBe(collapsed.markerTransform);
      expect(expanded.nameFont).toBe(collapsed.nameFont);
      const image = page.locator('#archive-details .gx-archive-detail-artwork img');
      await browserExpect(image).toBeVisible();
      await image.evaluate((node) => (node as HTMLImageElement).decode());
      const geometry = await image.evaluate((node) => {
        const img = node as HTMLImageElement;
        const box = img.getBoundingClientRect();
        const hero = img.parentElement!;
        const outer = hero.getBoundingClientRect();
        const fit = getComputedStyle(img).objectFit;
        const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
        return {
          natural: [img.naturalWidth, img.naturalHeight],
          mime: img.src.slice(0, 23),
          fit,
          contained:
            box.left >= outer.left &&
            box.top >= outer.top &&
            box.right <= outer.right + 0.5 &&
            box.bottom <= outer.bottom + 0.5,
          drawnWidth: img.naturalWidth * scale,
          drawnHeight: img.naturalHeight * scale,
          width: box.width,
          height: box.height,
          heroHeight: outer.height,
        };
      });
      expect(geometry.natural).toEqual([180, 135]);
      expect(geometry.mime).toBe('data:image/jpeg;base64,');
      expect(geometry.fit).toBe('contain');
      expect(geometry.contained).toBe(true);
      expect(geometry.heroHeight).toBeLessThanOrEqual(200);
      expect(geometry.drawnWidth / geometry.drawnHeight).toBeCloseTo(4 / 3, 6);
      expect(geometry.drawnWidth).toBeLessThanOrEqual(geometry.width);
      expect(geometry.drawnHeight).toBeLessThanOrEqual(geometry.height);
      if (width < 650)
        await page.evaluate(() => {
          document.getElementById('app')!.dataset.compactView = 'channels';
        });
      const visibleExpanded = await titleGeometry();
      expect(visibleExpanded.nameWidth).toBe(collapsed.nameWidth);
      // Opening the existing episode section can remove the collapsed row's
      // stretch, but the absolute marker never adds another control or height.
      expect(visibleExpanded.buttonHeight).toBeLessThanOrEqual(collapsed.buttonHeight);
      await titleButton.click();
      if (width < 650)
        await page.evaluate(() => {
          document.getElementById('app')!.dataset.compactView = 'channels';
        });
      const restored = await titleGeometry();
      expect(restored.expanded).toBe('false');
      expect(restored.markerTransform).toBe(collapsed.markerTransform);
      expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
      expect(await page.locator('video[src]').count()).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'archiveLayout').dispose());
      await page.close();
    }
  });
}
