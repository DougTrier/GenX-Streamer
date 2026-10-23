/* global document, window, performance, requestAnimationFrame, Event */
/** Measures the actual shared UI inside a packaged WebView, without media requests. */
export async function measureCatalogSearch(page) {
  const samples = [];
  const groups = ['cold-reloaded-document', 'warm-current-document'];
  for (const group of groups) {
    for (let run = 0; run < 30; run++) {
      if (group === groups[0]) await page.reload();
      await page.locator('#app[data-ready="true"]').waitFor();
      // Reset through the actual input handler, not a private application method.
      await page.locator('#search').fill('');
      const sports = page.locator('[data-filter="sports"]');
      if (await sports.isVisible()) await sports.click();
      else await page.locator('#compact-filter').selectOption('sports');
      await page.waitForFunction(
        () => document.querySelector('#channel-count')?.textContent === '50,000 channels',
      );
      const query = `Bench ${String(90000 + run * 2).padStart(6, '0')}`;
      const sample = await page.evaluate(
        async ({ query, group, run }) => {
          const input = document.querySelector('#search');
          const started = performance.now();
          input.value = query;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          // Include rendering through the next visible frame and layout read.
          return await new Promise((resolve, reject) => {
            const timeout = window.setTimeout(
              () => reject(new Error('Search measurement deadline')),
              5000,
            );
            requestAnimationFrame(() => {
              window.clearTimeout(timeout);
              const rows = [...document.querySelectorAll('.channel')];
              const count = document.querySelector('#channel-count')?.textContent;
              const title = rows[0]?.querySelector('strong')?.textContent;
              const box = rows[0]?.getBoundingClientRect();
              if (
                count !== '1 channels' ||
                title !== query ||
                rows.length !== 1 ||
                !box?.width ||
                !box?.height
              )
                return reject(new Error('Search result was not visibly committed'));
              resolve({
                group,
                run,
                query,
                elapsedMs: performance.now() - started,
                rows: rows.length,
              });
            });
          });
        },
        { query, group, run },
      );
      samples.push(sample);
    }
  }
  const quantile = (values, fraction) => values[Math.ceil(values.length * fraction) - 1];
  const summary = groups.map((group) => {
    const values = samples
      .filter((sample) => sample.group === group)
      .map((sample) => sample.elapsedMs)
      .sort((a, b) => a - b);
    return {
      group,
      runs: values.length,
      p50Ms: quantile(values, 0.5),
      p95Ms: quantile(values, 0.95),
      maxMs: values.at(-1),
      within200Ms: quantile(values, 0.95) <= 200,
    };
  });
  return {
    scope:
      'Actual UI input event through filtered visible frame; cold document reloads and warm searches; not full process cold starts',
    fixtureEntries: 100000,
    categoryFilteredEntries: 50000,
    thresholdMs: 200,
    summary,
    samples,
  };
}

export function createSearchFixture() {
  const entries = ['#EXTM3U'];
  for (let index = 0; index < 100000; index++)
    entries.push(
      `#EXTINF:-1 group-title="${index % 2 === 0 ? 'Sports' : 'News'}",Bench ${String(index).padStart(6, '0')}\nhttps://example.invalid/x`,
    );
  return Buffer.from(entries.join('\n') + '\n');
}
