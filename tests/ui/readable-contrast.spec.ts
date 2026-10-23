import { expect, test } from '@playwright/test';

// Readable contrast (T043, October 23, 2026). GenX draws its text over
// pictures and gradients, so the background is measured from real pixels: the
// page is captured with its text hidden, and each visible text's colour is
// compared with the background behind it, taking the worst case (the brightest
// pixels behind light text, the darkest behind dark text). WCAG AA: 4.5:1, or
// 3:1 for large text.
for (const viewport of [
  { width: 1280, height: 720 },
  { width: 360, height: 780 },
  { width: 697, height: 330 },
])
  test(`text contrast at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    const items = await page.evaluate(() => {
      const found: {
        text: string;
        rect: { x: number; y: number; w: number; h: number };
        color: number[];
        large: boolean;
      }[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim() ?? '';
        const element = node.parentElement;
        // Decorative brand art (aria-hidden, such as the header slogan) is exempt.
        if (
          !text ||
          !element ||
          element.closest('dialog:not([open]), [hidden], video, select, [aria-hidden="true"]')
        )
          continue;
        const style = getComputedStyle(element);
        const size = Number.parseFloat(style.fontSize);
        if (!size || style.visibility !== 'visible' || Number(style.opacity) < 0.5) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        if (box.width < 4 || box.height < 4 || box.right < 0 || box.bottom < 0) continue;
        if (box.left > innerWidth || box.top > innerHeight) continue;
        const color = (style.color.match(/[\d.]+/g) ?? []).map(Number);
        if ((color[3] ?? 1) < 0.95) continue;
        found.push({
          text: text.slice(0, 40),
          rect: { x: box.left, y: box.top, w: box.width, h: box.height },
          color: color.slice(0, 3),
          large: size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700),
        });
      }
      return found;
    });
    await page.addStyleTag({
      content:
        '* { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }',
    });
    const shot = (await page.screenshot()).toString('base64');
    const failures = await page.evaluate(
      async ({ shot, items }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${shot}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        context.drawImage(image, 0, 0);
        const scale = image.width / innerWidth;
        const luminance = ([r, g, b]: number[]) => {
          const channel = (c: number) => {
            const v = c / 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
        };
        const out: string[] = [];
        for (const item of items) {
          const x = Math.max(0, Math.round(item.rect.x * scale));
          const y = Math.max(0, Math.round(item.rect.y * scale));
          const w = Math.min(canvas.width - x, Math.round(item.rect.w * scale));
          const h = Math.min(canvas.height - y, Math.round(item.rect.h * scale));
          if (w < 2 || h < 2) continue;
          const data = context.getImageData(x, y, w, h).data;
          const values: number[] = [];
          for (let i = 0; i < data.length; i += 4)
            values.push(luminance([data[i]!, data[i + 1]!, data[i + 2]!]));
          values.sort((a, b) => a - b);
          const text = luminance(item.color);
          const median = values[Math.floor(values.length / 2)]!;
          // The worst case behind the text, ignoring the outer 5% of pixels.
          const back =
            text > median
              ? values[Math.floor(values.length * 0.95)]!
              : values[Math.floor(values.length * 0.05)]!;
          const [light, dark] = text > back ? [text, back] : [back, text];
          const ratio = (light + 0.05) / (dark + 0.05);
          if (ratio < (item.large ? 3 : 4.5)) out.push(`${item.text}: ${ratio.toFixed(2)}`);
        }
        return out;
      },
      { shot, items },
    );
    expect(items.length).toBeGreaterThan(5);
    expect(failures).toEqual([]);
  });
