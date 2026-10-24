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
 * Guide screen in a real browser: feed bounds, coverage, continuation
 * windows, previews and mappings.
 */
import { describe, expect, it } from 'vitest';
import { readStylesheet } from '../support/stylesheet';
import { useGuideUiBrowser, fixture, open, dispose, chooseGuide } from './guide-ui-browser.fixture';

useGuideUiBrowser();

describe('actual Chromium guide component', () => {
  it.each(['short', 'holes', 'unknown-end'])(
    'does not turn shared seven-day feed extrema into selected-channel coverage (%s)',
    async (schedule) => {
      const page = await fixture();
      try {
        await page.addScriptTag({
          content: `
            const otherChannel={id:'other',sourceId:'catalog',name:'Other channel'};
            const otherMapping={...mapping,appChannelId:'other',xmltvChannelId:'other-guide'};
            const selectedPrograms=${JSON.stringify(schedule)}==='holes'
              ? [program('Selected first hour',instant,instant+3600000,0),program('Selected last hour',instant+601200000,instant+604800000,1)]
              : [program('Selected first hour',instant,${JSON.stringify(schedule)}==='unknown-end'?null:instant+3600000,0)];
            const feedPrograms=[{...otherMapping,startMs:instant-100000,stopMs:instant+604800000,title:'Other seven days',description:null,ordinal:0},...selectedPrograms];
            host.channels=()=>[channel,otherChannel];
            host.mappings=async()=>[mapping,otherMapping];
            host.query=async(query)=>{
              window.calls.queries.push(query);
              return {programs:selectedPrograms,nextCursor:null,sourceRevision:1,databaseRevision:1};
            };
            host.coverage=async()=>({publishedRevision:1,updatedMs:instant,
              startMs:Math.min(...feedPrograms.map(p=>p.startMs)),
              endMs:Math.max(...feedPrograms.filter(p=>p.stopMs!==null).map(p=>p.stopMs))});
          `,
        });
        await open(page);
        const details = page.locator('.guide-coverage:not(.guide-search-options)');
        await expect
          .poll(() => details.textContent())
          .toContain('Feed time range spans this window');
        const label = await details.textContent();
        expect(label).toContain('Channel schedule coverage not assessed.');
        expect(label).toContain('Listings do not confirm stream availability.');
        expect(label).not.toMatch(/Time span covers|Partial schedule coverage|complete coverage/i);
        expect(await page.getByLabel('Guide programs').textContent()).toContain(
          'Selected first hour',
        );
        expect(await page.getByLabel('Guide programs').textContent()).not.toContain(
          'Other seven days',
        );
        expect(
          await page.evaluate(() => Reflect.get(window, 'calls').queries[0].appChannelIds),
        ).toEqual(['fox']);
      } finally {
        await dispose(page);
      }
    },
  );
  it.each([
    {
      startMs: 1700000000000,
      endMs: 1700000001000,
      label: 'Feed time range does not span this window',
    },
    { startMs: 1700000000000, endMs: null, label: 'Feed time range unknown' },
    { startMs: null, endMs: null, label: 'Feed time range unknown' },
  ])('keeps partial or unknown feed bounds honest ($label)', async ({ startMs, endMs, label }) => {
    const page = await fixture();
    try {
      await page.addScriptTag({
        content: `host.coverage=async()=>({publishedRevision:1,updatedMs:instant,startMs:${JSON.stringify(startMs)},endMs:${JSON.stringify(endMs)}});`,
      });
      await open(page);
      const details = page.locator('.guide-coverage:not(.guide-search-options)');
      await expect.poll(() => details.textContent()).toContain(label);
      expect(await details.textContent()).toContain('Channel schedule coverage not assessed.');
      expect(await details.textContent()).toContain('Guide updated');
    } finally {
      await dispose(page);
    }
  });
  it.each([
    { gaps: [], unknownEnds: 0, label: 'No schedule gaps in this window' },
    { gaps: [[3600000, 86400000]], unknownEnds: 0, label: 'Schedule has 1 gap in this window' },
    {
      gaps: [
        [3600000, 7200000],
        [10800000, 86400000],
      ],
      unknownEnds: 1,
      label: 'Schedule has 2 gaps in this window',
    },
  ])(
    'shows validated selected-channel interval assessment ($label)',
    async ({ gaps, unknownEnds, label }) => {
      const page = await fixture();
      try {
        await page.addScriptTag({
          content: `
        window.coverageQueries=[];
        host.channelCoverage=async(q)=>{
          window.coverageQueries.push(q);
          const gaps=${JSON.stringify(gaps)}.map(([start,end])=>({startMs:q.startMs+start,endMs:q.startMs+end}));
          return {schemaVersion:1,startMs:q.startMs,endMs:q.endMs,status:'assessed',reason:null,
            sourceRevision:1,publishedRevision:1,coveredMs:q.endMs-q.startMs-gaps.reduce((sum,g)=>sum+g.endMs-g.startMs,0),
            gapCount:gaps.length,unknownEndCount:${unknownEnds},gaps,gapsComplete:true};
        };`,
        });
        await open(page);
        const details = page.locator('.guide-coverage:not(.guide-search-options)');
        await expect.poll(() => details.textContent()).toContain(label);
        expect(await details.textContent()).toContain('Feed time range spans this window');
        expect(await details.textContent()).not.toContain('programme accuracy');
        if (unknownEnds)
          expect(await details.textContent()).toContain('1 program end time unknown');
        expect(await page.getByLabel('Guide programs').textContent()).toContain('Chicago Bears');
        expect(await page.evaluate(() => Reflect.get(window, 'coverageQueries'))).toEqual([
          {
            schemaVersion: 1,
            sourceId: 'guide',
            xmltvChannelId: 'wfld',
            startMs: 1700000000000,
            endMs: 1700086400000,
            expectedSourceRevision: 1,
            expectedPublishedRevision: 1,
          },
        ]);
      } finally {
        await dispose(page);
      }
    },
  );
  it.each(['failure', 'source-stale', 'malformed'])(
    'retains listings when channel coverage is not assessed (%s)',
    async (result) => {
      const page = await fixture();
      try {
        await page.addScriptTag({
          content: `host.channelCoverage=async(q)=>{
          if(${JSON.stringify(result)}==='failure')throw new Error('private provider error');
          return {schemaVersion:1,startMs:q.startMs,endMs:q.endMs,status:'not-assessed',reason:'source-stale',
            sourceRevision:${result === 'malformed' ? 1 : 2},publishedRevision:1,coveredMs:null,gapCount:null,unknownEndCount:null,gaps:[],gapsComplete:false};
        };`,
        });
        await open(page);
        const details = page.locator('.guide-coverage:not(.guide-search-options)');
        await expect
          .poll(() => details.textContent())
          .toContain(
            result === 'source-stale' ? 'Guide changed' : 'Channel schedule coverage not assessed',
          );
        expect(await details.textContent()).not.toMatch(
          /private provider|No schedule gaps|Schedule has/,
        );
        expect(await page.getByLabel('Guide programs').textContent()).toContain('Chicago Bears');
      } finally {
        await dispose(page);
      }
    },
  );
  it('joins held channel coverage on suspension and never renders its obsolete result', async () => {
    const page = await fixture();
    try {
      await page.addScriptTag({
        content: `
        host.channelCoverage=async(q,signal)=>{
          window.coverageSignal=signal;
          await new Promise(resolve=>window.resolveCoverage=resolve);
          return {schemaVersion:1,startMs:q.startMs,endMs:q.endMs,status:'assessed',reason:null,
            sourceRevision:1,publishedRevision:1,coveredMs:q.endMs-q.startMs,gapCount:0,unknownEndCount:0,gaps:[],gapsComplete:true};
        };
        window.guide.open();`,
      });
      await page.waitForFunction(() => !!Reflect.get(window, 'resolveCoverage'));
      await page.evaluate(() => {
        Reflect.set(window, 'coverageSuspended', false);
        void Reflect.get(window, 'guide')
          .suspend()
          .then(() => Reflect.set(window, 'coverageSuspended', true));
      });
      expect(await page.evaluate(() => Reflect.get(window, 'coverageSignal').aborted)).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'coverageSuspended'))).toBe(false);
      await page.evaluate(() => Reflect.get(window, 'resolveCoverage')());
      await page.waitForFunction(() => Reflect.get(window, 'coverageSuspended'));
      expect(await page.getByLabel('Guide programs').textContent()).not.toContain('Chicago Bears');
      expect(
        await page.locator('.guide-coverage:not(.guide-search-options)').textContent(),
      ).not.toContain('No schedule gaps');
    } finally {
      await dispose(page);
    }
  });
  it('keeps unconfirmed coverage cancellation blocking cleanup after actual request settlement', async () => {
    const page = await fixture();
    try {
      await page.addScriptTag({
        content: `host.channelCoverage=async(q,signal)=>{
          window.coverageSignal=signal;
          await new Promise(resolve=>window.resolveCoverage=resolve);
          throw new GuideUI.ChannelCoverageCleanupError();
        };window.guide.open();`,
      });
      await page.waitForFunction(() => !!Reflect.get(window, 'resolveCoverage'));
      await page.evaluate(() => {
        Reflect.set(window, 'coverageCleanup', 'pending');
        void Reflect.get(window, 'guide')
          .suspend()
          .then(
            () => Reflect.set(window, 'coverageCleanup', 'passed'),
            () => Reflect.set(window, 'coverageCleanup', 'failed'),
          );
      });
      expect(await page.evaluate(() => Reflect.get(window, 'coverageSignal').aborted)).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'coverageCleanup'))).toBe('pending');
      await page.evaluate(() => Reflect.get(window, 'resolveCoverage')());
      await page.waitForFunction(() => Reflect.get(window, 'coverageCleanup') === 'failed');
      expect(await page.getByLabel('Guide programs').textContent()).not.toContain('Chicago Bears');
      expect(
        await page.locator('.guide-coverage:not(.guide-search-options)').textContent(),
      ).not.toContain('No schedule gaps');
      expect(
        await page.evaluate(async () => {
          try {
            await Reflect.get(window, 'guide').dispose();
            return true;
          } catch {
            return false;
          }
        }),
      ).toBe(false);
      expect(await page.locator('dialog').count()).toBe(1);
    } finally {
      // The synthetic acknowledgment refusal is intentionally unrecoverable; all fixture work settled.
      await page.close();
    }
  });
  it.each([false, true])(
    'normal Guide forwards selected three-hour coverage and joins its cleanup failure=%s',
    async (cleanupFailure) => {
      const page = await fixture(false, true);
      try {
        await page.evaluate(() => Reflect.get(window, 'guide').dispose());
        await page.addScriptTag({
          content: `
        window.timelineCoverageQueries=[];
        host.channelCoverage=async(q,signal)=>{
          window.timelineCoverageQueries.push(q);window.timelineCoverageSignal=signal;
          if(${cleanupFailure}) {
            await new Promise(resolve=>window.releaseTimelineCoverage=resolve);
            throw new GuideUI.ChannelCoverageCleanupError();
          }
          return {schemaVersion:1,startMs:q.startMs,endMs:q.endMs,status:'assessed',reason:null,
            sourceRevision:1,publishedRevision:1,coveredMs:q.endMs-q.startMs,gapCount:0,unknownEndCount:0,gaps:[],gapsComplete:true};
        };
        window.guide=GuideUI.mountGuide(document.getElementById('guide'),host);
        window.guide.open();`,
        });
        await page.locator('.gx-timeline-cell').first().click();
        if (await page.locator('.gx-timeline-choices').count())
          await page
            .locator('.gx-timeline-choices')
            .getByRole('button', { name: /Current/ })
            .click();
        if (cleanupFailure) {
          await page.waitForFunction(() => !!Reflect.get(window, 'releaseTimelineCoverage'));
          await page.evaluate(() => {
            Reflect.set(window, 'timelineCoverageDrain', 'pending');
            void Reflect.get(window, 'guide')
              .suspend()
              .then(
                () => Reflect.set(window, 'timelineCoverageDrain', 'passed'),
                () => Reflect.set(window, 'timelineCoverageDrain', 'failed'),
              );
          });
          expect(
            await page.evaluate(() => Reflect.get(window, 'timelineCoverageSignal').aborted),
          ).toBe(true);
          expect(await page.evaluate(() => Reflect.get(window, 'timelineCoverageDrain'))).toBe(
            'pending',
          );
          await page.evaluate(() => Reflect.get(window, 'releaseTimelineCoverage')());
          await page.waitForFunction(
            () => Reflect.get(window, 'timelineCoverageDrain') === 'failed',
          );
          expect(
            await page.locator('.gx-timeline-channel-coverage').allTextContents(),
          ).not.toContain(
            'No schedule gaps in this window. Listings do not confirm stream availability.',
          );
        } else {
          await expect
            .poll(() => page.locator('.gx-timeline-channel-coverage').textContent())
            .toContain('No schedule gaps in this window');
          const queries = await page.evaluate(() => Reflect.get(window, 'timelineCoverageQueries'));
          expect(queries).toEqual([
            {
              schemaVersion: 1,
              sourceId: 'guide',
              xmltvChannelId: 'wfld',
              startMs: Math.floor(1700000000000 / 1800000) * 1800000,
              endMs: Math.floor(1700000000000 / 1800000) * 1800000 + 10800000,
              expectedSourceRevision: 1,
              expectedPublishedRevision: 1,
            },
          ]);
          expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
        }
      } finally {
        if (cleanupFailure) await page.close();
        else await dispose(page);
      }
    },
  );
  it('keeps continuation windows and context fixed as the clock advances, while explicit actions reset them', async () => {
    const page = await fixture();
    try {
      await page.addScriptTag({
        content: `
          window.clock=instant;
          host.now=()=>window.clock;
          host.query=async(query)=>{
            window.calls.queries.push(query);
            return {programs:[program('Page '+window.calls.queries.length,instant+200000,instant+300000,1)],
              nextCursor:{queryKey:'owned-query',guideSourceId:'guide',sourceRevision:1,databaseRevision:1,startMs:instant+200000,ordinal:1,appChannelId:'fox'},sourceRevision:1,databaseRevision:1};
          };
        `,
      });
      await open(page);
      await page.evaluate(() => {
        const state = window as unknown as { clock: number };
        state.clock += 60000;
      });
      await page.getByLabel('Program navigation').selectOption('more');
      await page.getByRole('button', { name: 'Run program action' }).click();
      await expect.poll(() => page.getByRole('button', { name: /Page 2/ }).count()).toBe(1);
      expect(await page.getByRole('button', { name: /Page 2/ }).textContent()).toContain(
        'As of 1700000000000',
      );
      expect(
        await page.locator('.guide-coverage:not(.guide-search-options)').textContent(),
      ).toContain('Schedule snapshot as of 1700000000000');
      const queries = await page.evaluate(
        () =>
          (
            window as unknown as {
              calls: { queries: import('../../src/guide/native').ProgramQuery[] };
            }
          ).calls.queries,
      );
      expect(queries[1]).toEqual({
        ...queries[0],
        cursor: expect.objectContaining({ queryKey: 'owned-query' }),
      });
      await page.getByLabel('Program navigation').selectOption('now');
      await page.getByRole('button', { name: 'Run program action' }).click();
      await expect.poll(() => page.getByRole('button', { name: /Page 3/ }).count()).toBe(1);
      const reset = await page.evaluate(
        () =>
          (
            window as unknown as {
              calls: { queries: import('../../src/guide/native').ProgramQuery[] };
            }
          ).calls.queries[2],
      );
      expect(reset.cursor).toBeNull();
      expect(reset.windowStartMs).toBe(queries[0].windowStartMs + 60000);
      expect(reset.contextAtMs).toBe(queries[0].contextAtMs! + 60000);
      await chooseGuide(page, 'Guide view', 'choose');
      await page.getByLabel('Guide day').selectOption('1');
      await expect.poll(() => page.getByRole('button', { name: /Page 4/ }).count()).toBe(1);
      const dayQuery = await page.evaluate(
        () =>
          (
            window as unknown as {
              calls: { queries: import('../../src/guide/native').ProgramQuery[] };
            }
          ).calls.queries[3],
      );
      expect(dayQuery.cursor).toBeNull();
      expect(dayQuery.contextAtMs).toBeUndefined();
      expect(dayQuery.windowStartMs).toBe(reset.windowStartMs + 86400000);
      await chooseGuide(page, 'Guide view', 'search');
      await expect.poll(() => page.getByRole('button', { name: /Page 5/ }).count()).toBe(1);
      await page.getByText('Change program search', { exact: true }).click();
      await page.getByLabel('Find a program').fill('Chicago');
      await page.getByLabel('Find a program').press('Tab');
      await expect.poll(() => page.getByRole('button', { name: /Page 6/ }).count()).toBe(1);
      const filtered = await page.evaluate(() =>
        (
          window as unknown as {
            calls: { queries: import('../../src/guide/native').ProgramQuery[] };
          }
        ).calls.queries.at(-1)!,
      );
      expect(filtered.search).toBe('Chicago');
      expect(filtered.cursor).toBeNull();
      expect(filtered.windowEndMs - filtered.windowStartMs).toBe(7 * 86400000);
    } finally {
      await dispose(page);
    }
  });
  it('captures inputs before asynchronous configuration and suppresses obsolete completion', async () => {
    const page = await fixture();
    try {
      await page.addScriptTag({
        content: `
          window.firstSource=true;
          host.sources=async()=>{
            if(window.firstSource){window.firstSource=false;await new Promise(resolve=>window.releaseSources=resolve)}
            return [source];
          };
          host.query=async(query)=>{window.calls.queries.push(query);return {programs:[program(query.search,instant+200000,instant+300000,1)],nextCursor:null,sourceRevision:1,databaseRevision:1}};
          window.guide.open('Obsolete');
        `,
      });
      await page.waitForFunction(() => Reflect.get(window, 'releaseSources'));
      await page.evaluate(() => {
        const state = window as unknown as {
          guide: { open(query: string): void };
          releaseSources(): void;
        };
        state.guide.open('Current');
        state.releaseSources();
      });
      await expect.poll(() => page.getByRole('button', { name: /Current/ }).count()).toBe(1);
      const searches = await page.evaluate(() =>
        (window as unknown as { calls: { queries: { search: string }[] } }).calls.queries.map(
          (q) => q.search,
        ),
      );
      expect(searches).toEqual(['Current']);
      expect(await page.getByRole('button', { name: /Obsolete/ }).count()).toBe(0);
    } finally {
      await dispose(page);
    }
  });
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 640, height: 360 },
  ]) {
    it(`keeps guide controls reachable in ${viewport.width}x${viewport.height} with 200% text`, async () => {
      const page = await fixture();
      try {
        await page.setViewportSize(viewport);
        await page.addStyleTag({
          content:
            (await readStylesheet('src/ui/style.css')) +
            '\n' +
            (await readStylesheet('src/ui/guide.css')),
        });
        await open(page);
        await page.locator('dialog').evaluate((element) => {
          const sizes = [...element.querySelectorAll<HTMLElement>('*')].map((node) => ({
            node,
            size: parseFloat(getComputedStyle(node).fontSize),
          }));
          for (const { node, size } of sizes) node.style.fontSize = `${size * 2}px`;
        });
        const bounds = await page.locator('dialog').evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          };
        });
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(viewport.height);
        expect(bounds.width).toBeLessThanOrEqual(viewport.width);
        expect(bounds.scrollHeight).toBeLessThanOrEqual(bounds.clientHeight + 1);
        const closeBox = await page.getByRole('button', { name: 'Close guide' }).boundingBox();
        expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(viewport.height);
        expect(await page.getByLabel('Find a program').isVisible()).toBe(false);
        await page.getByRole('button', { name: /Chicago Bears/ }).click();
        expect(await page.locator('[aria-label="Guide programs"]').isVisible()).toBe(false);
        await page.getByRole('button', { name: 'Back to programs' }).click();
        await chooseGuide(page, 'Guide view', 'sources');
        expect(await page.getByLabel('Find a channel').isVisible()).toBe(false);
        await chooseGuide(page, 'Guide source task', 'manage');
        expect(await page.getByLabel('Guide source name', { exact: true }).isVisible()).toBe(false);
        await page.getByRole('button', { name: 'Close guide' }).click();
        expect(
          await page.locator('dialog').evaluate((element) => (element as HTMLDialogElement).open),
        ).toBe(false);
      } finally {
        await dispose(page);
      }
    });
  }
  it('finds a mapped program in a second guide without inventing or tuning a stream', async () => {
    const page = await fixture();
    try {
      await page.addScriptTag({
        content: `
        const second={id:'sports',sourceId:'catalog-two',name:'Sports channel'};
        host.channels=()=>[channel,second];
        host.sources=async()=>[source,{...source,id:'guide-two',name:'Second guide'}];
        host.mappings=async()=>[mapping,{catalogSourceId:'catalog-two',appChannelId:'sports',guideSourceId:'guide-two',xmltvChannelId:'sports-guide'}];
        host.query=async(query)=>{window.calls.queries.push(query);return {programs:[{catalogSourceId:'catalog-two',appChannelId:'sports',guideSourceId:'guide-two',xmltvChannelId:'sports-guide',startMs:instant+100000,stopMs:instant+200000,title:'Chicago Bears',description:null,ordinal:1}],nextCursor:null,sourceRevision:1,databaseRevision:1}};
      `,
      });
      await open(page, 'Chicago Bears');
      expect(await page.locator('[aria-label="Guide programs"]').textContent()).toContain(
        'Sports channel',
      );
      await page.getByRole('button', { name: /Chicago Bears/ }).click();
      expect(await page.getByRole('button', { name: 'Watch channel' }).count()).toBe(0);
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { watch: unknown[] } }).calls.watch,
        ),
      ).toEqual([]);
    } finally {
      await dispose(page);
    }
  });
  it('waits for owned query settlement during disposal and never renders its late result', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        const state = window as unknown as { mode: string; guide: { open(): void } };
        state.mode = 'blocked';
        state.guide.open();
      });
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { resolveQuery?: () => void }).resolveQuery === 'function',
      );
      await page.evaluate(() => {
        const state = window as unknown as {
          settled?: boolean;
          guide: { dispose(): Promise<void> };
        };
        state.settled = false;
        void state.guide.dispose().then(() => {
          state.settled = true;
        });
      });
      expect(await page.evaluate(() => (window as unknown as { settled: boolean }).settled)).toBe(
        false,
      );
      await page.evaluate(() => (window as unknown as { resolveQuery: () => void }).resolveQuery());
      await page.waitForFunction(() => (window as unknown as { settled: boolean }).settled);
      expect(await page.locator('dialog').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('protects a pending durable save from Escape and waits for its receipt before disposal', async () => {
    const page = await fixture();
    try {
      await open(page);
      await chooseGuide(page, 'Guide view', 'sources');
      await page.getByLabel('Guide source name', { exact: true }).fill('New guide');
      await page.getByRole('button', { name: 'Save source and preview' }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (b) => b.textContent === 'Save reviewed schedule' && !b.disabled,
        ),
      );
      await page.evaluate(() => {
        (window as unknown as { commitMode: string }).commitMode = 'blocked';
        return Reflect.get(window, 'guide').setForeground(true);
      });
      await page.getByRole('button', { name: 'Save reviewed schedule' }).click();
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { resolveCommit?: () => void }).resolveCommit === 'function',
      );
      await page.keyboard.press('Escape');
      expect(
        await page.locator('dialog').evaluate((element) => (element as HTMLDialogElement).open),
      ).toBe(true);
      expect(await page.getByRole('button', { name: 'Cancel guide operation' }).isDisabled()).toBe(
        true,
      );
      await page.evaluate(() => {
        const state = window as unknown as {
          settled?: boolean;
          guide: { dispose(): Promise<void> };
        };
        state.settled = false;
        void state.guide.dispose().then(() => {
          state.settled = true;
        });
      });
      expect(await page.evaluate(() => (window as unknown as { settled: boolean }).settled)).toBe(
        false,
      );
      await page.evaluate(() =>
        (window as unknown as { resolveCommit: () => void }).resolveCommit(),
      );
      await page.waitForFunction(() => (window as unknown as { settled: boolean }).settled);
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { discard: string[] } }).calls.discard,
        ),
      ).toEqual([]);
    } finally {
      await page.close();
    }
  });
  it('has no startup fetch, safe metadata and explicit current playback only', async () => {
    const page = await fixture();
    try {
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { sources: number } }).calls.sources,
        ),
      ).toBe(0);
      await open(page);
      expect(await page.locator('img').count()).toBe(0);
      await page.getByRole('button', { name: /Chicago Bears/ }).click();
      expect(await page.getByRole('button', { name: 'Watch channel' }).count()).toBe(0);
      await page.getByRole('button', { name: 'Back to programs' }).click();
      await page.getByRole('button', { name: /Current <img/ }).click();
      await page.getByRole('button', { name: 'Watch channel' }).click();
      await page.waitForFunction(
        () => (window as unknown as { calls: { watch: unknown[] } }).calls.watch.length === 1,
      );
    } finally {
      await dispose(page);
    }
  });
  it('inherits an explicit search and uses all mapped channels over seven days', async () => {
    const page = await fixture();
    try {
      await open(page, 'Chicago Bears');
      const queries = await page.evaluate(
        () =>
          (
            window as unknown as {
              calls: {
                queries: {
                  appChannelIds: string[];
                  windowEndMs: number;
                  windowStartMs: number;
                  search: string;
                }[];
              };
            }
          ).calls.queries,
      );
      expect(queries[0]?.appChannelIds).toEqual([]);
      expect(
        await page.evaluate(
          () =>
            'contextAtMs' in
            (window as unknown as { calls: { queries: object[] } }).calls.queries[0],
        ),
      ).toBe(false);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { calls: { queries: { guideSourceId: string }[] } }).calls
              .queries[0]?.guideSourceId,
        ),
      ).toBe('');
      expect(queries[0]?.search).toBe('Chicago Bears');
      expect((queries[0]?.windowEndMs ?? 0) - (queries[0]?.windowStartMs ?? 0)).toBe(604800000);
      expect(await page.locator('[aria-label="Guide programs"] li').count()).toBeLessThanOrEqual(
        50,
      );
    } finally {
      await dispose(page);
    }
  });
  it('keeps failed schedule preview reviewable and retries explicit durable publication', async () => {
    const page = await fixture();
    try {
      await open(page);
      await chooseGuide(page, 'Guide view', 'sources');
      await page.getByLabel('Guide source name', { exact: true }).fill('New guide');
      await page.getByLabel('Online XMLTV URL').fill('https://fixture.invalid/new');
      await page.getByRole('button', { name: 'Save source and preview' }).click();
      await page.getByRole('button', { name: 'Save reviewed schedule' }).waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (b) => b.textContent === 'Save reviewed schedule' && !b.disabled,
        ),
      );
      await page.evaluate(() => {
        (window as unknown as { commitMode: string }).commitMode = 'fail';
      });
      await page.getByRole('button', { name: 'Save reviewed schedule' }).click();
      await page.waitForFunction(() =>
        document.querySelector('[role="alert"]')?.textContent?.includes('failed'),
      );
      expect(await page.getByRole('button', { name: 'Save reviewed schedule' }).isEnabled()).toBe(
        true,
      );
      expect(await page.locator('dialog').textContent()).toContain('20 programs');
      await page.evaluate(() => {
        (window as unknown as { commitMode: string }).commitMode = 'normal';
      });
      await page.getByRole('button', { name: 'Save reviewed schedule' }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (b) => b.textContent === 'Save reviewed schedule' && b.disabled,
        ),
      );
    } finally {
      await dispose(page);
    }
  });
  it('discards a late canceled preview instead of enabling publication', async () => {
    const page = await fixture();
    try {
      await open(page);
      await chooseGuide(page, 'Guide view', 'sources');
      await page.getByLabel('Guide source name', { exact: true }).fill('New guide');
      await page.evaluate(() => {
        (window as unknown as { previewMode: string }).previewMode = 'blocked';
      });
      await page.getByRole('button', { name: 'Save source and preview' }).click();
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { resolvePreview?: () => void }).resolvePreview ===
          'function',
      );
      await page.getByRole('button', { name: 'Cancel guide operation' }).click();
      await page.evaluate(() =>
        (window as unknown as { resolvePreview: () => void }).resolvePreview(),
      );
      await page.waitForFunction(
        () => (window as unknown as { calls: { discard: string[] } }).calls.discard.length === 1,
      );
      await chooseGuide(page, 'Guide source task', 'preview');
      expect(await page.getByRole('button', { name: 'Save reviewed schedule' }).isDisabled()).toBe(
        true,
      );
    } finally {
      await dispose(page);
    }
  });
  it('labels stale and unknown-end listings without offering playback', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        const fixture = window as unknown as { mode: string; stale: boolean };
        fixture.mode = 'unknown';
        fixture.stale = true;
      });
      await open(page);
      expect(await page.locator('dialog').textContent()).toContain('Stale guide');
      await expect
        .poll(() => page.locator('dialog').textContent())
        .toContain('Current program end unknown');
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { calls: { queries: { contextAtMs?: number }[] } }).calls
              .queries[0].contextAtMs,
        ),
      ).toBe(1700000000000);
      await page.getByRole('button', { name: /Unknown · End unknown/ }).click();
      expect(await page.getByRole('button', { name: 'Watch channel' }).count()).toBe(0);
    } finally {
      await dispose(page);
    }
  });
  it('saves exact source-scoped mapping from safe guide-channel lookup', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        (window as unknown as { mode: string }).mode = 'unmapped';
      });
      await open(page);
      await chooseGuide(page, 'Guide view', 'mapping');
      await page.getByLabel('Mapping guide source').selectOption('guide');
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Mapping guide channel"]')?.children.length === 1,
      );
      expect(await page.locator('img').count()).toBe(0);
      await page.getByRole('button', { name: 'Map selected channel' }).click();
      await page.waitForFunction(
        () => (window as unknown as { calls: { mapping: unknown[] } }).calls.mapping.length === 1,
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { mapping: unknown[] } }).calls.mapping[0],
        ),
      ).toEqual({
        catalogSourceId: 'catalog',
        appChannelId: 'fox',
        guideSourceId: 'guide',
        xmltvChannelId: 'wfld',
      });
    } finally {
      await dispose(page);
    }
  });
});
