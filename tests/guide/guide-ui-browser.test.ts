import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'guide-remote-fixture',
        resolveId(id) {
          if (id.endsWith('virtual:guide-remote')) return '\0guide-remote';
        },
        load(id) {
          if (id === '\0guide-remote')
            return `export * from ${JSON.stringify(resolve('src/ui/guide.ts'))}; export {ChannelCoverageCleanupError} from ${JSON.stringify(resolve('src/guide/native.ts'))}; export {createShell} from ${JSON.stringify(resolve('src/ui/shell.ts'))}; export {installRemoteNavigation, createRemoteEditMode} from ${JSON.stringify(resolve('src/ui/remote-navigation.ts'))};`;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:guide-remote', formats: ['iife'], name: 'GuideUI' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing bundle');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing chunk');
  bundle = chunk.code;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
async function chooseGuide(page: Page, label: string, value: string) {
  const names: Record<string, string> = {
    channel: 'Channel guide',
    choose: 'Choose channel / day',
    search: 'Search programs',
    sources: 'Program guide setup',
    mapping: 'Channel mapping',
    add: 'Add source',
    manage: 'Manage sources',
    preview: 'Review schedule preview',
  };
  if (label === 'Guide view' && ['sources', 'mapping'].includes(value))
    await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('option', { name: names[value], exact: true }).click();
  if (value === 'sources')
    await page
      .locator('.guide-manual-source')
      .evaluate((el) => ((el as HTMLDetailsElement).open = true));
}
async function fixture(manualClock = false, timeline = false, tv = false): Promise<Page> {
  const page = await browser.newPage(
    tv ? { viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 } : {},
  );
  page.setDefaultTimeout(3000);
  await page.route('http://127.0.0.1/guide-fixture', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<main id="guide"></main>' }),
  );
  await page.goto('http://127.0.0.1/guide-fixture');
  await page.addScriptTag({ content: bundle });
  if (timeline) {
    await page.addStyleTag({
      content:
        (await readFile('src/ui/guide.css', 'utf8')) +
        (await readFile('src/ui/guide-timeline.css', 'utf8')),
    });
  }
  await page.addScriptTag({
    content: `
    const instant=1700000000000;
    window.calls={sources:0,queries:[],commits:[],discard:[],watch:[],mapping:[]};
    window.mode='normal';window.previewMode='normal';window.commitMode='normal';window.stale=false;
    const channel={id:'fox',sourceId:'catalog',name:'FOX Chicago'};
    const source={id:'guide',name:'Regional guide',location:'https://fixture.invalid/guide',kind:'url',allowHttp:false,revision:1,updatedMs:instant};
    const mapping={catalogSourceId:'catalog',appChannelId:'fox',guideSourceId:'guide',xmltvChannelId:'wfld'};
    const program=(title,startMs,stopMs,ordinal)=>({...mapping,startMs,stopMs,title,description:'Description '+title,ordinal});
    const preview={ticket:'ticket',sourceId:'guide',sourceRevision:1,channels:2,programs:20,firstStartMs:instant,lastStartMs:instant+300000,lastKnownStopMs:instant+600000};
    const host={discover:async(signal)=>{window.discoveryCalls=(window.discoveryCalls||0)+1;if(window.blockDiscovery)await new Promise(resolve=>window.resolveDiscovery=resolve);return window.discoveryResult||{candidates:[],outcomes:[]}},selectedChannel:()=>channel,channels:()=>[channel],now:()=>instant,formatTime:ms=>String(ms),
      sources:async()=>{window.calls.sources++;return window.mode==='missing'?[]:[source]},mappings:async()=>window.mode==='unmapped'?[]:[mapping],
      query:async(query,signal)=>{window.calls.queries.push(query);if(window.mode==='blocked')await new Promise(resolve=>window.resolveQuery=resolve);return {programs:window.mode==='unknown'?[program('Unknown',instant-1000,null,0)]:[program('Current <img src=x>',instant-1000,instant+100000,0),program('Chicago Bears',instant+200000,instant+300000,1)],nextCursor:null,sourceRevision:1,databaseRevision:1}},
      coverage:async()=>({publishedRevision:1,updatedMs:window.stale?instant-90000000:instant,startMs:instant-100000,endMs:instant+604800000}),
      guideChannels:async()=>({channels:[{id:'wfld',names:['Chicago <img src=x>']}],nextCursor:null,sourceRevision:1}),
      preview:async(input,signal)=>{if(window.previewMode==='blocked')await new Promise(resolve=>{window.resolvePreview=resolve;window.previewSignal=signal});return preview},
      commitPreview:async(ticket)=>{window.calls.commits.push(ticket);if(window.commitMode==='fail')throw new Error('private');if(window.commitMode==='blocked')await new Promise(resolve=>window.resolveCommit=resolve);return {committed:true}},
      discardPreview:async(ticket)=>{window.calls.discard.push(ticket);if(window.discardMode==='fail')throw new Error('private');if(window.discardMode==='blocked')await new Promise(resolve=>window.resolveDiscard=resolve)},removeSource:async()=>{},setMapping:async(value)=>window.calls.mapping.push(value),watch:async(value)=>window.calls.watch.push(value)};
    window.host=host;
    window.summaryCalls=[];window.summaryMode='normal';window.catalogRevision='1';
    host.catalogRevision=()=>window.catalogRevision;
    window.cancelCalls=[];window.cancelFail=false;host.cancelSummary=async id=>{window.cancelCalls.push(id);if(window.cancelFail)throw new Error('Fixture cancel acknowledgment failed');};
    host.summary=async(query,signal)=>{
      window.summaryCalls.push(query);
      if(window.summaryMode==='blocked') await new Promise(resolve=>{window.resolveSummary=resolve;window.summarySignal=signal});
      const now=query.atMs;
      const current=window.summaryMode==='overlap'||window.mode==='unknown'?null:now<instant+100000?{title:'Current <img src=x>',startMs:instant-1000,stopMs:instant+100000}:now>=instant+200000&&now<instant+300000?{title:'Chicago Bears',startMs:instant+200000,stopMs:instant+300000}:null;
      const next=now<instant+200000?{title:'Chicago Bears',startMs:instant+200000,stopMs:instant+300000}:null;
      return {...query,catalogRevision:window.catalogRevision,databaseRevision:1,mappingStatus:'mapped',mapping:{...mapping,catalogSourceId:query.catalogSourceId,appChannelId:query.appChannelId},sourceRevision:1,publishedRevision:1,updatedMs:instant,coverage:{startMs:instant-1000,endMs:instant+300000},cacheStatus:window.stale?'stale':'current',currentStatus:window.summaryMode==='overlap'?'overlap':window.mode==='unknown'?'unknown-end':current?'current':'gap',nextStatus:next?'next':'none',current,next};
    };
    if(${manualClock}) {
      window.clock=instant;window.clockTimers=new Map();window.clockTimerId=0;
      host.now=()=>window.clock;
      host.summaryClock={now:()=>window.clock,setTimeout:(callback,delay)=>{const id=++window.clockTimerId;window.clockTimers.set(id,{callback,at:window.clock+delay});return id;},clearTimeout:id=>window.clockTimers.delete(id)};
      window.advanceClock=ms=>{window.clock+=ms;for(const [id,timer] of [...window.clockTimers])if(timer.at<=window.clock){window.clockTimers.delete(id);timer.callback();}};
    }
    host.enableTimeline=${timeline};
    window.guide=GuideUI.mountGuide(document.getElementById('guide'),host);
  `,
  });
  return page;
}
async function open(page: Page, query = ''): Promise<void> {
  await page.evaluate(
    (value) => (window as unknown as { guide: { open(query?: string): void } }).guide.open(value),
    query,
  );
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Guide programs"]')?.children.length ||
      document.querySelector('[role="status"]')?.textContent?.includes('No program guide') ||
      document
        .querySelector('[role="status"]')
        ?.textContent?.includes('No program guide is connected'),
  );
}
async function dispose(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { guide: { dispose(): Promise<void> } }).guide.dispose(),
  );
  await page.close();
}
it('opens contextual Map guide without advanced setup and saves only after explicit confirmation', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'unmapped');
      Reflect.get(window, 'guide').openMapping(Reflect.get(window, 'host').selectedChannel());
    });
    await page.getByRole('heading', { name: 'Map guide for FOX Chicago' }).waitFor();
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Mapping guide channel"]')?.children.length,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'calls').mapping.length)).toBe(0);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    await page.getByRole('button', { name: 'Map selected channel', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'calls').mapping.length === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
    expect(await page.locator('.guide-mapping-panel').isVisible()).toBe(false);
  } finally {
    await dispose(page);
  }
});
it('normal timeline keeps discovery simple and joins its work when closed', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => Reflect.set(window, 'mode', 'missing'));
    await page.evaluate(() => Reflect.get(window, 'guide').open());
    await page.waitForFunction(
      () => document.querySelector('.gx-timeline-note')?.textContent === 'Guide not linked',
    );
    expect(
      await page.getByRole('button', { name: 'Find program guides', exact: true }).isVisible(),
    ).toBe(true);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').queries.length)).toBe(0);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog')?.open);
    const queries = await page.evaluate(() => Reflect.get(window, 'calls').queries.length);
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').queries.length)).toBe(queries);
  } finally {
    await dispose(page);
  }
});
it('normal timeline preserves program search and Back returns from details before closing', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => Reflect.get(window, 'guide').open());
    await page.waitForFunction(() => document.querySelectorAll('.gx-timeline-cell').length > 0);
    await page.locator('.gx-timeline-cell').first().click();
    if (await page.getByRole('button', { name: 'Chicago Bears', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Chicago Bears', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.gx-timeline-details strong'));
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
    await page.keyboard.press('Escape');
    expect(await page.locator('dialog').isVisible()).toBe(true);
    expect(await page.locator('.gx-timeline-details').isVisible()).toBe(false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog')?.open);
    await open(page, 'Chicago Bears');
    expect(await page.locator('.gx-timeline').isVisible()).toBe(false);
    expect(await page.getByRole('button', { name: /Chicago Bears/ }).count()).toBeGreaterThan(0);
  } finally {
    await dispose(page);
  }
});
it('program search preserves provider categories through the native page conversion', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host');
      const originalQuery = host.query;
      host.query = async (...args: unknown[]) => {
        const response = await originalQuery(...args);
        return {
          ...response,
          programs: response.programs.slice(0, 1).map((program: Record<string, unknown>) => ({
            ...program,
            title: 'Silent film',
            description: null,
            categories: [{ text: 'Drama', language: 'en' }],
          })),
        };
      };
    });
    await open(page, 'Drama');
    expect(await page.getByRole('button', { name: /Silent film/ }).count()).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
  } finally {
    await dispose(page);
  }
});
it('normal empty Guide offers actual discovery without technical controls or automatic remote work', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => Reflect.set(window, 'mode', 'missing'));
    await open(page);
    expect(
      await page.getByRole('button', { name: 'Find program guides', exact: true }).isVisible(),
    ).toBe(true);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    expect(await page.getByLabel('Mapping guide source').isVisible()).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'discoveryCalls') ?? 0)).toBe(0);
    await page.getByRole('button', { name: 'Guide view', exact: true }).click();
    expect(
      await page.getByRole('option', { name: 'Program guide setup', exact: true }).isVisible(),
    ).toBe(false);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'discoveryCalls') === 1);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    expect(
      await page.getByRole('button', { name: 'Go back to Guide', exact: true }).isVisible(),
    ).toBe(true);
    await page.getByRole('button', { name: 'Go back to Guide', exact: true }).click();
    expect(await page.getByRole('button', { name: 'Guide view', exact: true }).isVisible()).toBe(
      true,
    );
  } finally {
    await dispose(page);
  }
});
it('normal Find obtains exact-match listings through one automatic callback without technical steps', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'missing');
      Reflect.set(window, 'buildCalls', 0);
      Reflect.get(window, 'host').buildForChannels = async () => {
        Reflect.set(window, 'buildCalls', Reflect.get(window, 'buildCalls') + 1);
        return { connected: 2, unmatched: 1, checked: 1, failed: 0, skipped: 0 };
      };
    });
    await open(page);
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'buildCalls') === 1);
    expect(await page.evaluate(() => Reflect.get(window, 'discoveryCalls') ?? 0)).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').commits)).toEqual([]);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    expect(
      await page.getByRole('button', { name: 'Save reviewed schedule', exact: true }).isVisible(),
    ).toBe(false);
  } finally {
    await dispose(page);
  }
});
it('post-Scan automatic build stays in the existing operation owner and disposal joins its real settlement', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.get(window, 'host').buildForChannels = (signal: AbortSignal) =>
        new Promise((resolve) => {
          Reflect.set(window, 'buildSignal', signal);
          Reflect.set(window, 'finishBuild', () =>
            resolve({ connected: 0, unmatched: 1, checked: 1, failed: 0, skipped: 1 }),
          );
        });
      Reflect.set(window, 'buildWork', Reflect.get(window, 'guide').buildForChannels());
    });
    expect(await page.getByRole('dialog').isVisible()).toBe(false);
    await page.evaluate(() => {
      Reflect.set(window, 'disposedBuild', false);
      Reflect.set(
        window,
        'disposeWork',
        Reflect.get(window, 'guide')
          .dispose()
          .then(() => Reflect.set(window, 'disposedBuild', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'buildSignal').aborted)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'disposedBuild'))).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'finishBuild')());
    await page.evaluate(() => Reflect.get(window, 'disposeWork'));
    expect(await page.evaluate(() => Reflect.get(window, 'disposedBuild'))).toBe(true);
  } finally {
    await dispose(page);
  }
});
it('normal discovered guide requires deliberate selection and reviewed Save, while Settings Advanced retains editing', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'missing');
      Reflect.set(window, 'discoveryResult', {
        candidates: [
          {
            name: 'Regional schedule',
            limitations:
              'Regional channel identifiers need review; exact sports coverage is unconfirmed.',
            location: 'https://fixture.invalid/guide',
            playlistNames: ['My channels'],
            allowHttp: false,
            requiresHttpPermission: false,
          },
        ],
        outcomes: [],
      });
    });
    await open(page);
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Regional channel identifiers need review'),
    );
    await page
      .getByRole('button', { name: 'Regional schedule \u00b7 My channels', exact: true })
      .click();
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLButtonElement>('[aria-label="Save reviewed schedule"]')
          ?.disabled && document.body.textContent?.includes('guide channels'),
    );
    expect(await page.evaluate(() => Reflect.get(window, 'calls').commits.length)).toBe(0);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    await page.getByRole('button', { name: 'Save reviewed schedule', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'calls').commits.length === 1);
    await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
    await page
      .locator('.guide-manual-source')
      .evaluate((node) => ((node as HTMLDetailsElement).open = true));
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Go back to Guide', exact: true }).click();
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
  } finally {
    await dispose(page);
  }
});
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
            (await readFile('src/ui/style.css', 'utf8')) +
            '\n' +
            (await readFile('src/ui/guide.css', 'utf8')),
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

describe('guide background suspension ownership', () => {
  it('aborts and drains a preview fetch, discarding a late ticket', async () => {
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
      await page.evaluate(() => {
        const f = window as unknown as { guide: { suspend(): Promise<void> }; suspended?: boolean };
        f.suspended = false;
        void f.guide.suspend().then(() => {
          f.suspended = true;
        });
      });
      expect(
        await page.evaluate(
          () => (window as unknown as { previewSignal: AbortSignal }).previewSignal.aborted,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() => (window as unknown as { suspended: boolean }).suspended),
      ).toBe(false);
      await page.evaluate(() => (window as unknown as { resolvePreview(): void }).resolvePreview());
      await page.waitForFunction(() => (window as unknown as { suspended: boolean }).suspended);
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { discard: string[] } }).calls.discard,
        ),
      ).toEqual(['ticket']);
      await chooseGuide(page, 'Guide source task', 'preview');
      expect(await page.getByRole('button', { name: 'Save reviewed schedule' }).isDisabled()).toBe(
        true,
      );
      expect(await page.locator('dialog').textContent()).toContain('Retry when ready');
    } finally {
      await dispose(page);
    }
  });

  it('drains a late query without rendering it or automatically restarting', async () => {
    const page = await fixture();
    try {
      await open(page);
      await page.evaluate(() => {
        const f = window as unknown as { mode: string; guide: { open(query?: string): void } };
        f.mode = 'blocked';
        f.guide.open('suspend-only-result');
      });
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { resolveQuery?: () => void }).resolveQuery === 'function',
      );
      await page.evaluate(() => {
        const f = window as unknown as { guide: { suspend(): Promise<void> }; suspended?: boolean };
        f.suspended = false;
        void f.guide.suspend().then(() => {
          f.suspended = true;
        });
      });
      expect(
        await page.evaluate(() => (window as unknown as { suspended: boolean }).suspended),
      ).toBe(false);
      const before = await page.evaluate(
        () => (window as unknown as { calls: { queries: unknown[] } }).calls.queries.length,
      );
      await page.evaluate(() => (window as unknown as { resolveQuery(): void }).resolveQuery());
      await page.waitForFunction(() => (window as unknown as { suspended: boolean }).suspended);
      expect(await page.locator('dialog').textContent()).toContain('Retry when ready');
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { queries: unknown[] } }).calls.queries.length,
        ),
      ).toBe(before);
      await page.evaluate(() => {
        const f = window as unknown as { mode: string; guide: { open(): void } };
        f.mode = 'normal';
        void Reflect.get(window, 'guide')
          .setForeground(true)
          .then(() => f.guide.open());
      });
      await page.waitForFunction(
        (count) =>
          (window as unknown as { calls: { queries: unknown[] } }).calls.queries.length > count,
        before,
      );
    } finally {
      await dispose(page);
    }
  });
  it('retains a reviewed preview and waits crossed publication without aborting it', async () => {
    const page = await fixture();
    try {
      await open(page);
      await chooseGuide(page, 'Guide view', 'sources');
      await page.getByLabel('Guide source name', { exact: true }).fill('Reviewed guide');
      await page.getByRole('button', { name: 'Save source and preview' }).click();
      await chooseGuide(page, 'Guide source task', 'preview');
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (b) => b.textContent === 'Save reviewed schedule' && !b.disabled,
        ),
      );
      await page.evaluate(() =>
        (window as unknown as { guide: { suspend(): Promise<void> } }).guide.suspend(),
      );
      expect(await page.getByRole('button', { name: 'Save reviewed schedule' }).isEnabled()).toBe(
        true,
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { discard: string[] } }).calls.discard.length,
        ),
      ).toBe(0);
      await page.evaluate(() => {
        (window as unknown as { commitMode: string }).commitMode = 'blocked';
        return Reflect.get(window, 'guide').setForeground(true);
      });
      await page.getByRole('button', { name: 'Save reviewed schedule' }).click();
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { resolveCommit?: () => void }).resolveCommit === 'function',
      );
      const before = await page.evaluate(
        () => (window as unknown as { calls: { sources: number } }).calls.sources,
      );
      await page.evaluate(() => {
        const f = window as unknown as { guide: { suspend(): Promise<void> }; suspended?: boolean };
        f.suspended = false;
        void f.guide.suspend().then(() => {
          f.suspended = true;
        });
      });
      expect(
        await page.evaluate(() => (window as unknown as { suspended: boolean }).suspended),
      ).toBe(false);
      await page.evaluate(() => (window as unknown as { resolveCommit(): void }).resolveCommit());
      await page.waitForFunction(() => (window as unknown as { suspended: boolean }).suspended);
      expect(await page.locator('dialog').textContent()).toContain(
        'Reviewed guide schedule saved.',
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { sources: number } }).calls.sources,
        ),
      ).toBe(before);
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { commits: string[] } }).calls.commits,
        ),
      ).toEqual(['ticket']);
    } finally {
      await dispose(page);
    }
  });
});

describe('guide terminal cleanup receipt', () => {
  it('retains an unconfirmed preview and waits retried discard before removing its dialog', async () => {
    const page = await fixture();
    try {
      await open(page);
      await chooseGuide(page, 'Guide view', 'sources');
      await page.getByLabel('Guide source name', { exact: true }).fill('Owned preview');
      await page.getByRole('button', { name: 'Save source and preview' }).click();
      await chooseGuide(page, 'Guide source task', 'preview');
      await expect
        .poll(() => page.getByRole('button', { name: 'Save reviewed schedule' }).isEnabled())
        .toBe(true);
      await page.evaluate(() => {
        const f = window as unknown as {
          discardMode: string;
          failed: boolean;
          guide: { dispose(): Promise<void> };
        };
        f.discardMode = 'fail';
        f.failed = false;
        void f.guide.dispose().catch(() => {
          f.failed = true;
        });
      });
      await page.waitForFunction(() => (window as unknown as { failed: boolean }).failed);
      expect(await page.locator('dialog').count()).toBe(1);
      expect(await page.locator('dialog').textContent()).toContain('2 guide channels');
      await page.evaluate(() => {
        const f = window as unknown as {
          discardMode: string;
          finished: boolean;
          samePromise: boolean;
          guide: { dispose(): Promise<void>; open(): void };
        };
        f.discardMode = 'blocked';
        f.finished = false;
        const work = f.guide.dispose();
        f.samePromise = work === f.guide.dispose();
        void work.then(() => {
          f.finished = true;
        });
        f.guide.open();
      });
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { resolveDiscard?: () => void }).resolveDiscard ===
          'function',
      );
      expect(await page.evaluate(() => (window as unknown as { finished: boolean }).finished)).toBe(
        false,
      );
      expect(
        await page.evaluate(() => (window as unknown as { samePromise: boolean }).samePromise),
      ).toBe(true);
      expect(await page.locator('dialog').count()).toBe(1);
      await page.evaluate(() => (window as unknown as { resolveDiscard(): void }).resolveDiscard());
      await page.waitForFunction(() => (window as unknown as { finished: boolean }).finished);
      expect(await page.locator('dialog').count()).toBe(0);
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { discard: string[] } }).calls.discard,
        ),
      ).toEqual(['ticket', 'ticket']);
    } finally {
      await page.close();
    }
  });
});

it('foreground return joins pending background cleanup then restores the open timeline', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => Reflect.set(window, 'mode', 'blocked'));
    await page.evaluate(() => Reflect.get(window, 'guide').open());
    await page.waitForFunction(() => typeof Reflect.get(window, 'resolveQuery') === 'function');
    await page.evaluate(() => {
      const guide = Reflect.get(window, 'guide');
      Reflect.set(window, 'resumed', false);
      void guide.suspend();
      const first = guide.setForeground(true);
      Reflect.set(window, 'sameResume', first === guide.setForeground(true));
      void first.then(() => Reflect.set(window, 'resumed', true));
      guide.open();
    });
    expect(await page.evaluate(() => Reflect.get(window, 'resumed'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'sameResume'))).toBe(true);
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'normal');
      Reflect.get(window, 'resolveQuery')();
    });
    await page.waitForFunction(() => Reflect.get(window, 'resumed'));
    await expect.poll(() => page.locator('.gx-timeline-row').count()).toBe(1);
    expect(await page.locator('.guide-feedback').textContent()).not.toContain(
      'paused in the background',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
    await page.getByRole('button', { name: 'FOX Chicago', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(1);
  } finally {
    await dispose(page);
  }
});

it('a renewed background signal while cleanup is pending prevents a queued Guide resume', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => Reflect.set(window, 'mode', 'blocked'));
    await page.evaluate(() => Reflect.get(window, 'guide').open());
    await page.waitForFunction(() => typeof Reflect.get(window, 'resolveQuery') === 'function');
    await page.evaluate(() => {
      const guide = Reflect.get(window, 'guide');
      void guide.suspend();
      Reflect.set(window, 'resumed', false);
      void guide.setForeground(true).then(() => Reflect.set(window, 'resumed', true));
      void guide.setForeground(false);
      Reflect.set(window, 'mode', 'normal');
      Reflect.get(window, 'resolveQuery')();
    });
    await page.waitForFunction(() => Reflect.get(window, 'resumed'));
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').queries.length)).toBe(1);
    await page.evaluate(() => Reflect.get(window, 'guide').setForeground(true));
    await expect.poll(() => page.locator('.gx-timeline-row').count()).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
  } finally {
    await dispose(page);
  }
});

describe('complete Guide summary and foreground clock ownership', () => {
  it('uses complete overlap status instead of fifty duplicate page entries, and missing adapters never infer Now', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        Reflect.set(window, 'summaryMode', 'overlap');
        const owner = Reflect.get(window, 'host');
        owner.query = async () => ({
          programs: Array.from({ length: 50 }, () => ({
            catalogSourceId: 'catalog',
            appChannelId: 'fox',
            guideSourceId: 'guide',
            xmltvChannelId: 'wfld',
            startMs: 1699999999000,
            stopMs: 1700000100000,
            title: 'Current <img src=x>',
            description: 'Same duplicate',
            ordinal: 0,
          })),
          nextCursor: null,
          sourceRevision: 1,
          databaseRevision: 1,
        });
      });
      await open(page);
      await expect
        .poll(() => page.locator('.guide-coverage:not(.guide-search-options)').textContent())
        .toContain('Current listings overlap');
      await page
        .getByRole('button', { name: /Current <img/ })
        .first()
        .click();
      expect(await page.getByRole('button', { name: 'Watch channel' }).count()).toBe(0);
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        Reflect.get(window, 'host').summary = undefined;
        Reflect.get(window, 'guide').catalogChanged(true);
      });
      await expect
        .poll(() => page.locator('.guide-coverage:not(.guide-search-options)').textContent())
        .toContain('Current / next unavailable');
      expect(
        await page.locator('.guide-coverage:not(.guide-search-options)').textContent(),
      ).not.toContain('Now:');
    } finally {
      await dispose(page);
    }
  });
  it('updates live labels/detail eligibility at boundaries, preserves focus, and Back returns details before closing', async () => {
    const page = await fixture(true);
    try {
      await open(page);
      await expect
        .poll(() => page.locator('.guide-coverage:not(.guide-search-options)').textContent())
        .toContain('Now: Current');
      const queries = await page.evaluate(() => Reflect.get(window, 'calls').queries.length);
      await page.getByRole('button', { name: /Current <img/ }).click();
      await page.getByRole('button', { name: 'Watch channel' }).focus();
      await page.evaluate(() => Reflect.get(window, 'advanceClock')(100000));
      await expect
        .poll(() => page.locator('.guide-detail-panel').textContent())
        .toContain('This listing has ended');
      expect(await page.getByRole('button', { name: 'Watch channel' }).isDisabled()).toBe(true);
      expect(
        await page
          .getByRole('button', { name: 'Back to programs' })
          .evaluate((button) => button === document.activeElement),
      ).toBe(true);
      await page.keyboard.press('Escape');
      expect(
        await page.locator('dialog').evaluate((dialog) => (dialog as HTMLDialogElement).open),
      ).toBe(true);
      expect(
        await page
          .getByRole('button', { name: /Current <img/ })
          .evaluate((button) => button === document.activeElement),
      ).toBe(true);
      await page.getByRole('button', { name: /Chicago Bears/ }).click();
      expect(await page.getByRole('button', { name: 'Watch channel' }).count()).toBe(0);
      await page.evaluate(() => Reflect.get(window, 'advanceClock')(100000));
      await expect.poll(() => page.getByRole('button', { name: 'Watch channel' }).count()).toBe(1);
      expect(await page.getByRole('button', { name: 'Watch channel' }).isEnabled()).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, 'calls').queries.length)).toBe(queries);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect
        .poll(() => page.locator('dialog').evaluate((dialog) => (dialog as HTMLDialogElement).open))
        .toBe(false);
    } finally {
      await dispose(page);
    }
  });
  it('keeps search timing a snapshot while current-event details obtain their own exact channel summary', async () => {
    const page = await fixture(true);
    try {
      await page.evaluate(() => {
        const host = Reflect.get(window, 'host');
        host.channels = () => [
          { id: 'fox', sourceId: 'catalog', name: 'FOX Chicago' },
          { id: 'other', sourceId: 'catalog2', name: 'Other channel' },
        ];
        const mappings = host.mappings;
        host.mappings = async (signal: AbortSignal) => [
          ...(await mappings(signal)),
          {
            catalogSourceId: 'catalog2',
            appChannelId: 'other',
            guideSourceId: 'guide',
            xmltvChannelId: 'wfld',
          },
        ];
        host.query = async () => ({
          programs: [
            {
              catalogSourceId: 'catalog2',
              appChannelId: 'other',
              guideSourceId: 'guide',
              xmltvChannelId: 'wfld',
              startMs: 1699999999000,
              stopMs: 1700000100000,
              title: 'Current <img src=x>',
              description: 'Search current',
              ordinal: 0,
            },
          ],
          nextCursor: null,
          sourceRevision: 1,
          databaseRevision: 1,
        });
      });
      await open(page, 'current');
      expect(await page.getByRole('button', { name: /Current <img/ }).textContent()).toContain(
        'As of',
      );
      await page.getByRole('button', { name: /Current <img/ }).click();
      await expect.poll(() => page.getByRole('button', { name: 'Watch channel' }).count()).toBe(1);
      const before = await page.evaluate(() => Reflect.get(window, 'summaryCalls').length);
      await page.evaluate(() => Reflect.get(window, 'guide').catalogChanged());
      expect(
        await page
          .getByRole('button', { name: 'Watch channel' })
          .evaluate((button) => !(button as HTMLButtonElement).hidden),
      ).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'summaryCalls').length)).toBe(before);
      await page.getByRole('button', { name: 'Watch channel' }).click();
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'calls').watch.length))
        .toBe(1);
      expect(await page.evaluate(() => Reflect.get(window, 'calls').watch[0].id)).toBe('other');
    } finally {
      await dispose(page);
    }
  });
  it('joins canceled summary work, resumes once with fresh metadata, and never publishes a late old summary', async () => {
    const page = await fixture(true);
    try {
      await page.evaluate(() => Reflect.set(window, 'summaryMode', 'blocked'));
      await open(page);
      await page.waitForFunction(() => !!Reflect.get(window, 'resolveSummary'));
      await page.evaluate(() => {
        Reflect.set(window, 'suspended', false);
        void Reflect.get(window, 'guide')
          .setForeground(false)
          .then(() => Reflect.set(window, 'suspended', true));
      });
      expect(await page.evaluate(() => Reflect.get(window, 'summarySignal').aborted)).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'suspended'))).toBe(false);
      const before = await page.evaluate(() => Reflect.get(window, 'summaryCalls').length);
      await page.evaluate(() => Reflect.get(window, 'resolveSummary')());
      await page.waitForFunction(() => Reflect.get(window, 'suspended'));
      expect(
        await page.locator('.guide-coverage:not(.guide-search-options)').textContent(),
      ).not.toContain('Now:');
      await page.evaluate(() => {
        Reflect.set(window, 'summaryMode', 'normal');
        return Reflect.get(window, 'guide').setForeground(true);
      });
      await expect
        .poll(() => page.locator('.guide-coverage:not(.guide-search-options)').textContent())
        .toContain('Now: Current');
      expect(await page.evaluate(() => Reflect.get(window, 'summaryCalls').length)).toBe(
        before + 1,
      );
      await page.evaluate(() => Reflect.get(window, 'guide').setForeground(true));
      expect(await page.evaluate(() => Reflect.get(window, 'summaryCalls').length)).toBe(
        before + 1,
      );
    } finally {
      await dispose(page);
    }
  });
});

it('suppresses delayed pre-remap metadata under an unchanged catalog revision and refreshes only the new exact mapping', async () => {
  const page = await fixture(true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'summaryMode', 'blocked');
      Reflect.set(window, 'summaryTitle', 'Old regional');
      Reflect.set(window, 'xmltvId', 'wfld');
      const host = Reflect.get(window, 'host'),
        original = host.summary;
      host.summary = async (query: unknown, signal: AbortSignal) => {
        const title = Reflect.get(window, 'summaryTitle'),
          xmltv = Reflect.get(window, 'xmltvId');
        const value = await original(query, signal);
        return {
          ...value,
          mapping: { ...value.mapping, xmltvChannelId: xmltv },
          current: { ...value.current, title },
        };
      };
    });
    await open(page);
    await page.waitForFunction(() => !!Reflect.get(window, 'resolveSummary'));
    await page.evaluate(() => {
      Reflect.set(window, 'summaryMode', 'normal');
      Reflect.set(window, 'summaryTitle', 'New regional');
      Reflect.set(window, 'xmltvId', 'wfld2');
      const host = Reflect.get(window, 'host');
      host.mappings = async () => [
        {
          catalogSourceId: 'catalog',
          appChannelId: 'fox',
          guideSourceId: 'guide',
          xmltvChannelId: 'wfld2',
        },
      ];
      const original = host.query;
      host.query = async (query: unknown, signal: AbortSignal) => {
        const value = await original(query, signal);
        return {
          ...value,
          programs: value.programs.map((p: Record<string, unknown>) => ({
            ...p,
            xmltvChannelId: 'wfld2',
          })),
        };
      };
      Reflect.get(window, 'guide').catalogChanged(true);
    });
    expect(await page.evaluate(() => Reflect.get(window, 'summarySignal').aborted)).toBe(true);
    expect(
      await page.locator('.guide-coverage:not(.guide-search-options)').textContent(),
    ).not.toContain('Old regional');
    await page.evaluate(() => Reflect.get(window, 'resolveSummary')());
    await expect
      .poll(() => page.locator('.guide-coverage:not(.guide-search-options)').textContent())
      .toContain('Now: New regional');
    expect(
      await page.locator('.guide-coverage:not(.guide-search-options)').textContent(),
    ).not.toContain('Old regional');
  } finally {
    await dispose(page);
  }
});
it('refuses false summary cleanup acknowledgment and retries the retained cancellation before terminal disposal', async () => {
  const page = await fixture(true);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host');
      host.summary = async (_query: unknown, signal: AbortSignal) => {
        await new Promise((resolve) => Reflect.set(window, 'resolveSummary', resolve));
        if (signal.aborted) throw new Error('Unconfirmed cancellation fixture');
        throw new Error('No fixture response');
      };
      Reflect.set(window, 'cancelFail', true);
    });
    await open(page);
    await page.waitForFunction(() => !!Reflect.get(window, 'resolveSummary'));
    await page.evaluate(() => {
      Reflect.set(window, 'drainResult', 'pending');
      void Reflect.get(window, 'guide')
        .suspend()
        .then(
          () => Reflect.set(window, 'drainResult', 'passed'),
          () => Reflect.set(window, 'drainResult', 'failed'),
        );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'drainResult'))).toBe('pending');
    await page.evaluate(() => Reflect.get(window, 'resolveSummary')());
    await page.waitForFunction(() => Reflect.get(window, 'drainResult') === 'failed');
    const refused = await page.evaluate(async () => {
      try {
        await Reflect.get(window, 'guide').dispose();
        return false;
      } catch {
        return true;
      }
    });
    expect(refused).toBe(true);
    expect(await page.locator('dialog').count()).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'cancelCalls').length)).toBeGreaterThan(0);
    await page.evaluate(() => {
      Reflect.set(window, 'cancelFail', false);
      return Reflect.get(window, 'guide').dispose();
    });
    expect(await page.locator('dialog').count()).toBe(0);
  } finally {
    await dispose(page);
  }
});
it('closed Guide selector Down leaves for timeline controls; OK opens choices and Back closes choices first', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => Reflect.get(window, 'guide').open());
    await page.waitForFunction(() => document.querySelector('.gx-timeline-channel'));
    await page.evaluate(() => {
      const api = Reflect.get(window, 'GuideUI');
      Reflect.set(
        window,
        'removeGuideRemote',
        api.installRemoteNavigation({ editMode: api.createRemoteEditMode() }),
      );
    });
    const trigger = page.getByRole('button', { name: 'Guide view', exact: true });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    expect(await trigger.getAttribute('aria-expanded')).toBe('false');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.guide-dropdown'))).toBe(
      false,
    );
    expect(await page.locator('.gx-timeline').isVisible()).toBe(true);
    await trigger.focus();
    await page.keyboard.press('Enter');
    expect(await trigger.getAttribute('aria-expanded')).toBe('true');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('option');
    await page.keyboard.press('Escape');
    expect(await trigger.getAttribute('aria-expanded')).toBe('false');
    expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await page.getByRole('dialog', { name: 'Program guide' }).isVisible()).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'removeGuideRemote')?.());
    await dispose(page);
  }
});
it('in-app guide dropdown uses bounded options and Escape returns to trigger without closing Guide', async () => {
  const page = await fixture();
  try {
    await open(page);
    await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
    await page.getByRole('button', { name: 'Guide view', exact: true }).click();
    expect(await page.getByRole('listbox', { name: 'Guide view choices' }).isVisible()).toBe(true);
    await page.keyboard.press('End');
    expect(
      await page
        .getByRole('option', { name: 'Channel mapping', exact: true })
        .evaluate((el) => el === document.activeElement),
    ).toBe(true);
    await page.keyboard.press('Escape');
    expect(await page.getByRole('dialog', { name: 'Program guide' }).isVisible()).toBe(true);
    expect(
      await page
        .getByRole('button', { name: 'Guide view', exact: true })
        .evaluate((el) => el === document.activeElement),
    ).toBe(true);
    expect(
      await page
        .getByRole('button', { name: 'Guide view', exact: true })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
    await page.getByRole('button', { name: 'Guide view', exact: true }).click();
    await page.getByRole('option', { name: 'Program guide setup', exact: true }).click();
    expect(
      await page.getByRole('button', { name: 'Find program guides', exact: true }).isVisible(),
    ).toBe(true);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    await page.getByRole('button', { name: 'Guide source task', exact: true }).click();
    const trigger = page.getByRole('button', { name: 'Guide source task', exact: true });
    expect(await trigger.getAttribute('aria-controls')).toBeTruthy();
    await page
      .getByRole('dialog')
      .evaluate((dialog) => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
    expect(await page.getByRole('dialog').isVisible()).toBe(true);
    expect(await trigger.getAttribute('aria-expanded')).toBe('false');
    expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true);
    await page
      .getByRole('dialog')
      .evaluate((dialog) => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
    await expect.poll(() => page.getByRole('dialog').isVisible()).toBe(false);
  } finally {
    await page.close();
  }
});
it('Find program guides only discovers, selected HTTP candidate prefills without grant or publication', async () => {
  const page = await fixture();
  try {
    await open(page);
    await page.evaluate(() =>
      Reflect.set(window, 'discoveryResult', {
        candidates: [
          {
            name: 'Regional <img>',
            location: 'http://guide.invalid/feed.xml',
            playlistNames: ['My playlist'],
            allowHttp: false,
            requiresHttpPermission: true,
          },
        ],
        outcomes: [],
      }),
    );
    await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
    await page.getByRole('button', { name: 'Guide view', exact: true }).click();
    await page.getByRole('option', { name: 'Program guide setup', exact: true }).click();
    expect(await page.evaluate(() => Reflect.get(window, 'discoveryCalls') || 0)).toBe(0);
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.getByRole('button', { name: 'Regional <img> · My playlist', exact: true }).click();
    expect(await page.getByLabel('Online XMLTV URL').inputValue()).toBe(
      'http://guide.invalid/feed.xml',
    );
    expect(await page.getByLabel('Allow HTTP for this guide source').isChecked()).toBe(false);
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').commits)).toEqual([]);
    expect(await page.getByRole('button', { name: 'Save reviewed schedule' }).isVisible()).toBe(
      false,
    );
  } finally {
    await page.close();
  }
});
it('late canceled guide discovery cannot prefill or publish and manual guide input remains available', async () => {
  const page = await fixture();
  try {
    await open(page);
    await page.evaluate(() => {
      Reflect.set(window, 'blockDiscovery', true);
      Reflect.set(window, 'discoveryResult', {
        candidates: [
          {
            name: 'Late',
            location: 'https://guide.invalid/feed',
            playlistNames: ['Playlist'],
            allowHttp: false,
            requiresHttpPermission: false,
          },
        ],
        outcomes: [],
      });
    });
    await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
    await page.getByRole('button', { name: 'Guide view', exact: true }).click();
    await page.getByRole('option', { name: 'Program guide setup', exact: true }).click();
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel guide operation', exact: true }).click();
    await page.evaluate(() => Reflect.get(window, 'resolveDiscovery')());
    await expect
      .poll(() =>
        page.getByRole('button', { name: 'Find program guides', exact: true }).isDisabled(),
      )
      .toBe(false);
    expect(await page.getByRole('button', { name: 'Late · Playlist' }).count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').commits)).toEqual([]);
    await page.getByText('Add guide link or file', { exact: true }).click();
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(true);
  } finally {
    await page.close();
  }
});

it('partial timeline keeps Find available and reports exact linked channel count', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host');
      const original = host.channels()[0];
      host.channels = () => [original, { ...original, id: 'unmapped', name: 'Other channel' }];
      host.buildForChannels = async () => ({
        connected: 1,
        unmatched: 1,
        checked: 1,
        failed: 0,
        skipped: 0,
      });
      Reflect.get(window, 'guide').open();
    });
    await expect.poll(() => page.locator('.gx-timeline-channel').count()).toBe(2);
    expect(
      await page
        .getByText(
          '1 of 2 channels linked to program guides. Links do not confirm available schedules.',
          { exact: true },
        )
        .isVisible(),
    ).toBe(true);
    const find = page.getByRole('button', { name: 'Find program guides', exact: true });
    expect(await find.isVisible()).toBe(true);
    await find.click();
    await expect.poll(() => find.isDisabled()).toBe(false);
    expect(await find.isVisible()).toBe(true);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host');
      const originalMappings = host.mappings;
      host.mappings = async () => {
        const mappings = await originalMappings();
        return [...mappings, { ...mappings[0], appChannelId: 'unmapped' }];
      };
      Reflect.get(window, 'guide').catalogChanged(true);
    });
    await expect.poll(() => find.isVisible()).toBe(true);
    expect(
      await page
        .getByText(
          '2 of 2 channels linked to program guides. Links do not confirm available schedules.',
          { exact: true },
        )
        .isVisible(),
    ).toBe(true);
  } finally {
    await dispose(page);
  }
});

it('held normal Find presents real phase and settled feed progress without acquiring or tuning elsewhere', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host');
      host.buildForChannels = () =>
        new Promise((resolve) => Reflect.set(window, 'finishBuild', resolve));
      Reflect.get(window, 'guide').open();
    });
    await page.locator('.gx-timeline-row').first().waitFor();
    const find = page.getByRole('button', { name: 'Find program guides', exact: true });
    // An explicit retry remains available even when every channel has a mapping.
    await find.click();
    await page.waitForFunction(() => typeof Reflect.get(window, 'finishBuild') === 'function');
    await page.evaluate(() =>
      Reflect.get(window, 'guide').presentAutomaticProgress({
        connected: 1,
        unmatched: 0,
        checked: 1,
        failed: 1,
        skipped: 0,
        total: 4,
        attempted: 2,
        phase: 'fetching',
      }),
    );
    const update = page.getByRole('status', { name: 'Guide update' });
    expect(await update.textContent()).toContain('Fetching schedules · 2 of 4 feeds settled');
    expect(await update.textContent()).toContain('1 could not be checked');
    expect(await find.isDisabled()).toBe(true);
    expect(
      await page.getByRole('button', { name: 'Cancel guide operation', exact: true }).isEnabled(),
    ).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').commits)).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'discoveryCalls') ?? 0)).toBe(0);
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBuild',
      )({ connected: 1, unmatched: 0, checked: 3, failed: 1, skipped: 0 }),
    );
    await expect.poll(() => find.isDisabled()).toBe(false);
  } finally {
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBuild',
      )?.({ connected: 1, unmatched: 0, checked: 3, failed: 1, skipped: 0 }),
    );
    await dispose(page);
  }
});

it('canceled Find retains the actual join and never leaves stale pending progress after settlement', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'missing');
      Reflect.get(window, 'host').buildForChannels = (signal: AbortSignal) =>
        new Promise((resolve) => {
          Reflect.set(window, 'buildSignal', signal);
          Reflect.set(window, 'finishBuild', resolve);
        });
      Reflect.get(window, 'guide').open();
    });
    const find = page.getByRole('button', { name: 'Find program guides', exact: true });
    await find.click();
    await page.waitForFunction(() => typeof Reflect.get(window, 'finishBuild') === 'function');
    await page.evaluate(() =>
      Reflect.get(window, 'guide').presentAutomaticProgress({
        connected: 0,
        unmatched: 1,
        checked: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        attempted: 0,
        phase: 'capturing',
      }),
    );
    const update = page.getByRole('status', { name: 'Guide update' });
    expect(await update.textContent()).toBe('Preparing guide check');
    await page.getByRole('button', { name: 'Cancel guide operation', exact: true }).click();
    expect(await page.evaluate(() => Reflect.get(window, 'buildSignal').aborted)).toBe(true);
    expect(await find.isDisabled()).toBe(true);
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBuild',
      )({ connected: 1, unmatched: 0, checked: 1, failed: 0, skipped: 0 }),
    );
    await expect.poll(() => find.isDisabled()).toBe(false);
    expect(await update.isVisible()).toBe(false);
    expect(await page.getByRole('alert').textContent()).toContain('Operation canceled');
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
  } finally {
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBuild',
      )?.({ connected: 0, unmatched: 1, checked: 0, failed: 0, skipped: 0 }),
    );
    await dispose(page);
  }
});

it('partial Find failure remains visible after mapping reload and later catalog refresh', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'missing');
      Reflect.get(window, 'host').buildForChannels = async () => {
        Reflect.set(window, 'mode', 'normal');
        return {
          connected: 1,
          unmatched: 0,
          checked: 1,
          failed: 2,
          skipped: 1,
          discoveryFailed: 3,
        };
      };
      Reflect.get(window, 'guide').open();
    });
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.locator('.gx-timeline-cell').first().waitFor();
    const update = page.getByRole('status', { name: 'Guide update' });
    expect(await update.textContent()).toContain('2 could not be checked');
    expect(await update.textContent()).toContain('1 skipped');
    expect(await update.textContent()).toContain('3 playlists could not be checked');
    await page.evaluate(() => Reflect.get(window, 'guide').catalogChanged(true));
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'calls').sources))
      .toBeGreaterThan(1);
    expect(await update.isVisible()).toBe(true);
    expect(await update.textContent()).toContain('2 could not be checked');
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
  } finally {
    await dispose(page);
  }
});

it('six linked channels with no schedule keep manual Find reachable without claiming usable schedules', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host');
      const original = host.channels()[0];
      host.channels = () =>
        Array.from({ length: 6 }, (_, i) => ({ ...original, id: 'channel' + i }));
      host.mappings = async () =>
        host.channels().map((channel: { id: string }) => ({
          catalogSourceId: 'catalog',
          appChannelId: channel.id,
          guideSourceId: 'guide',
          xmltvChannelId: 'wfld',
        }));
      host.coverage = async () => null;
      host.query = async () => ({
        programs: [],
        nextCursor: null,
        sourceRevision: 1,
        databaseRevision: 1,
      });
      Reflect.get(window, 'guide').open();
    });
    await expect.poll(() => page.locator('.gx-timeline-channel').count()).toBe(6);
    expect(
      await page
        .getByText(
          '6 of 6 channels linked to program guides. Links do not confirm available schedules.',
          { exact: true },
        )
        .isVisible(),
    ).toBe(true);
    expect(
      await page.getByRole('button', { name: 'Find program guides', exact: true }).isEnabled(),
    ).toBe(true);
    expect(await page.locator('.gx-timeline-cell').count()).toBe(0);
    expect(await page.locator('.gx-timeline-row').first().textContent()).toContain(
      'No listings for this time',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
  } finally {
    await dispose(page);
  }
});

it('normal Guide forwards complete listed membership, keeps Find reachable and reports listings instead of linked counts', async () => {
  const page = await fixture(false, true, true);
  try {
    await page.evaluate(async () => {
      await Reflect.get(window, 'guide').dispose();
      const host = Reflect.get(window, 'host');
      Reflect.set(window, 'listedRequests', []);
      Reflect.set(window, 'listedEmpty', false);
      host.listedChannels = async (start: number, end: number, signal: AbortSignal) => {
        Reflect.get(window, 'listedRequests').push([start, end]);
        Reflect.set(window, 'listedSignal', signal);
        if (Reflect.get(window, 'listedRequests').length === 1)
          await new Promise<void>((resolve) => Reflect.set(window, 'releaseListed', resolve));
        return {
          catalogRevision: '1',
          databaseRevision: 1,
          channels: Reflect.get(window, 'listedEmpty')
            ? []
            : [
                {
                  catalogSourceId: 'catalog',
                  appChannelId: 'fox',
                  guideSourceId: 'guide',
                  xmltvChannelId: 'wfld',
                  sourceRevision: 1,
                },
              ],
        };
      };
      host.presentation = 'page';
      Reflect.set(
        window,
        'guide',
        Reflect.get(window, 'GuideUI').mountGuide(document.getElementById('guide'), host),
      );
      Reflect.get(window, 'guide').open();
    });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'listedRequests').length))
      .toBe(1);
    const guideStatus = page.locator('.guide-feedback > p').first();
    expect(await guideStatus.textContent()).toBe('Checking saved listings…');
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    expect(
      await page.getByRole('button', { name: 'Find program guides', exact: true }).isEnabled(),
    ).toBe(true);
    await page.evaluate(() => Reflect.get(window, 'releaseListed')());
    await expect.poll(() => page.locator('.gx-timeline-row').count()).toBe(1);
    expect(await guideStatus.textContent()).toBe('1 channel with listings');
    expect(await guideStatus.getAttribute('title')).toContain('selected time');
    expect(await guideStatus.textContent()).not.toContain('linked');
    await page.evaluate(() => {
      Reflect.set(window, 'listedEmpty', true);
      Reflect.get(window, 'guide').catalogChanged(true);
    });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'listedRequests').length))
      .toBe(2);
    await expect.poll(() => guideStatus.textContent()).toBe('0 channels with listings');
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    expect(await page.locator('.gx-timeline-status').textContent()).toBe(
      'No saved listings for this time. Find program guides or choose another time.',
    );
    expect(
      await page.getByRole('button', { name: 'Find program guides', exact: true }).isEnabled(),
    ).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
  } finally {
    await dispose(page);
  }
});

it('1920 TV at 960 CSS pixels keeps held progress and retained failure readable outside navigation clipping', async () => {
  const page = await fixture(false, true, true);
  try {
    await page.addStyleTag({
      content: (
        await Promise.all(
          [
            'style',
            'management',
            'guide',
            'guide-timeline',
            'responsive',
            'in-app-select',
            'modal-viewport',
            'guide-panel',
          ].map((name) => readFile(`src/ui/${name}.css`, 'utf8')),
        )
      ).join('\n'),
    });
    await page.addScriptTag({
      type: 'module',
      content: `
      await window.guide.dispose();
      const app=document.getElementById('guide');app.id='app';app.dataset.deviceKind='tv';
      GuideUI.createShell(app);
      app.dataset.guidePanel='open';app.dataset.compactView='watch';
      document.getElementById('primary-view-host').hidden=false;
      host.presentation='page';
      const saved=Array.from({length:30},(_,i)=>({id:'channel'+i,sourceId:'catalog',name:'Channel '+i}));
      host.channels=()=>saved;host.selectedChannel=()=>saved[0];
      host.mappings=async()=>saved.slice(0,6).map(c=>({...mapping,appChannelId:c.id}));
      host.query=async()=>({programs:[],nextCursor:null,sourceRevision:1,databaseRevision:1});
      host.buildForChannels=()=>new Promise(resolve=>window.finishBuild=resolve);
      window.guide=GuideUI.mountGuide(document.getElementById('primary-view-host'),host);
      await window.guide.open();
    `,
    });
    await page.locator('.gx-timeline-row').nth(7).waitFor();
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.waitForFunction(() => typeof Reflect.get(window, 'finishBuild') === 'function');
    await page.evaluate(() =>
      Reflect.get(window, 'guide').presentAutomaticProgress({
        connected: 6,
        unmatched: 24,
        checked: 1,
        failed: 2,
        skipped: 1,
        total: 12,
        attempted: 4,
        phase: 'fetching',
      }),
    );
    const readable = () =>
      page.evaluate(() => {
        const feedback = document.querySelector<HTMLElement>('.guide-feedback')!;
        const toolbar = document.querySelector<HTMLElement>('.gx-timeline-toolbar')!;
        const viewport = document.querySelector<HTMLElement>('.gx-timeline-viewport')!;
        const f = feedback.getBoundingClientRect(),
          t = toolbar.getBoundingClientRect(),
          v = viewport.getBoundingClientRect();
        const update = feedback.querySelector('[aria-label="Guide update"]')!;
        const range = document.createRange();
        range.selectNodeContents(update);
        return {
          local: !toolbar.contains(feedback),
          readable: [...range.getClientRects()].every(
            (r) =>
              r.top >= f.top &&
              r.bottom <= f.bottom + 1 &&
              r.left >= f.left &&
              r.right <= f.right + 1,
          ),
          belowNavigation: f.top >= t.bottom,
          aboveRows: f.bottom <= v.top,
          rowsUsable: v.height >= 180,
          overflow: document.documentElement.scrollWidth > innerWidth,
          scale: devicePixelRatio,
        };
      });
    expect(await readable()).toEqual({
      local: true,
      readable: true,
      belowNavigation: true,
      aboveRows: true,
      rowsUsable: true,
      overflow: false,
      scale: 2,
    });
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBuild',
      )({ connected: 6, unmatched: 24, checked: 9, failed: 2, skipped: 1 }),
    );
    await expect
      .poll(() =>
        page.getByRole('button', { name: 'Find program guides', exact: true }).isDisabled(),
      )
      .toBe(false);
    expect(await page.getByRole('status', { name: 'Guide update' }).textContent()).toContain(
      '2 could not be checked',
    );
    expect(await readable()).toEqual({
      local: true,
      readable: true,
      belowNavigation: true,
      aboveRows: true,
      rowsUsable: true,
      overflow: false,
      scale: 2,
    });
    const text = await page.getByRole('status', { name: 'Guide update' }).textContent();
    await page.evaluate(async () => {
      await Reflect.get(window, 'guide').setForeground(false);
      Reflect.get(window, 'guide').presentAutomaticProgress({
        connected: 0,
        unmatched: 30,
        checked: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        attempted: 0,
        phase: 'capturing',
      });
    });
    expect(await page.getByRole('status', { name: 'Guide update' }).textContent()).toBe(text);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').commits)).toEqual([]);
  } finally {
    await page.evaluate(() =>
      Reflect.get(
        window,
        'finishBuild',
      )?.({ connected: 6, unmatched: 24, checked: 9, failed: 2, skipped: 1 }),
    );
    await dispose(page);
  }
});

it('empty normal timeline Find connects schedules without opening technical source setup', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'missing');
      Reflect.set(window, 'buildCalls', 0);
      Reflect.set(window, 'manualPreviewCalls', 0);
      const host = Reflect.get(window, 'host');
      host.preview = async () => {
        Reflect.set(window, 'manualPreviewCalls', Reflect.get(window, 'manualPreviewCalls') + 1);
        throw new Error('Manual preview must not be entered from normal Find.');
      };
      host.buildForChannels = (_signal: AbortSignal) => {
        Reflect.set(window, 'buildCalls', Reflect.get(window, 'buildCalls') + 1);
        return new Promise((resolve) => {
          Reflect.set(window, 'finishBuild', () => {
            Reflect.set(window, 'mode', 'normal');
            resolve({ connected: 1, unmatched: 0, checked: 1, failed: 0, skipped: 0 });
          });
        });
      };
      Reflect.get(window, 'guide').open();
    });
    await page.waitForFunction(
      () => document.querySelector('.gx-timeline-note')?.textContent === 'Guide not linked',
    );
    await page.getByRole('button', { name: 'Find program guides', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'buildCalls') === 1);
    expect(await page.locator('.gx-timeline').isVisible()).toBe(true);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    expect(
      await page.getByRole('button', { name: 'Save reviewed schedule', exact: true }).isVisible(),
    ).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
    await page.evaluate(() => Reflect.get(window, 'finishBuild')());
    await page.waitForFunction(() => document.querySelectorAll('.gx-timeline-cell').length > 0);
    expect(await page.locator('.gx-timeline').isVisible()).toBe(true);
    expect(await page.getByLabel('Online XMLTV URL').isVisible()).toBe(false);
    expect(
      await page.getByRole('button', { name: 'Save reviewed schedule', exact: true }).isVisible(),
    ).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'buildCalls'))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'manualPreviewCalls'))).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').commits)).toEqual([]);
  } finally {
    await dispose(page);
  }
});

for (const unmapped of [false, true]) {
  for (const activation of ['click', 'Enter']) {
    it(`timeline channel ${activation} starts the exact saved stream and closes Guide, mapped=${!unmapped}`, async () => {
      const page = await fixture(false, true);
      try {
        await page.evaluate((missing) => {
          if (missing) Reflect.set(window, 'mode', 'unmapped');
          Reflect.get(window, 'guide').open();
        }, unmapped);
        const row = page.locator('.gx-timeline-channel').filter({ hasText: 'FOX Chicago' });
        await row.waitFor();
        if (unmapped) expect(await page.locator('.gx-timeline-cell').count()).toBe(0);
        expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
        if (activation === 'Enter') {
          await row.focus();
          await page.keyboard.press('Enter');
        } else await row.click();
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'calls').watch.length))
          .toBe(1);
        expect(await page.evaluate(() => Reflect.get(window, 'calls').watch[0])).toEqual({
          id: 'fox',
          sourceId: 'catalog',
          name: 'FOX Chicago',
        });
        await expect.poll(() => page.getByRole('dialog').isVisible()).toBe(false);
      } finally {
        await page.close();
      }
    });
  }
}

it('failed channel-row Watch stays open and a stale removed row cannot start a stream', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => {
      Reflect.get(window, 'host').watch = async () => {
        throw new Error('private-sentinel');
      };
      Reflect.get(window, 'guide').open();
    });
    const row = page.locator('.gx-timeline-channel').first();
    await row.waitFor();
    await row.click();
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('Guide action failed');
    expect(await page.getByRole('dialog').isVisible()).toBe(true);
    expect(await page.getByRole('alert').textContent()).not.toContain('private-sentinel');
    await page.evaluate(() => {
      Reflect.get(window, 'host').channels = () => [];
    });
    await row.click();
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
  } finally {
    await page.close();
  }
});

for (const size of [
  // Dense right-panel rows on a TV: at least fifteen channels at once, like a
  // set-top guide (the picture sits above the channel list instead).
  // Twelve rows fill the TV guide (owner request, October 19, 2026).
  { width: 960, height: 540, enlarged: false, deviceKind: 'tv', completeRows: 12 },
  // Twelve rows fill the TV guide (owner request, October 19, 2026).
  { width: 1280, height: 720, enlarged: false, deviceKind: 'tv', completeRows: 12 },
  { width: 854, height: 432, enlarged: false, deviceKind: 'personal', completeRows: 3 },
  { width: 320, height: 640, enlarged: true, deviceKind: 'personal', completeRows: 0 },
  { width: 390, height: 844, enlarged: true, deviceKind: 'personal', completeRows: 0 },
  { width: 640, height: 360, enlarged: true, deviceKind: 'personal', completeRows: 0 },
]) {
  // The Guide sits in the right panel beside the channel list: the grid needs
  // a panel of at least PANEL_AGENDA_WIDTH, which an 854-wide screen lacks.
  it(`normal Guide uses the real shell with readable ${size.width < 900 ? 'agenda' : 'grid'} ${size.width}x${size.height}`, async () => {
    const page = await fixture(false, true);
    try {
      await page.setViewportSize(size);
      await page.addStyleTag({
        content: (
          await Promise.all(
            [
              'style',
              'management',
              'guide',
              'guide-timeline',
              'responsive',
              'in-app-select',
              'modal-viewport',
              'guide-panel',
              // The TV's compact-control rules, which once made cells spill.
              ...(size.deviceKind === 'tv' ? ['tv-density'] : []),
            ].map((name) => readFile(`src/ui/${name}.css`, 'utf8')),
          )
        ).join('\n'),
      });
      await page.addScriptTag({
        content: `
        await window.guide.dispose();
        const app=document.getElementById('guide');app.id='app';app.dataset.deviceKind=${JSON.stringify(size.deviceKind)};
        GuideUI.createShell(app);
        app.dataset.guidePanel='open';app.dataset.compactView='watch';
        document.getElementById('primary-view-host').hidden=false;
        document.getElementById('cast-button').hidden=true;
        const saved=Array.from({length:31},(_,i)=>({id:'channel'+i,sourceId:'catalog',name:'A complete long channel name '+i+' (1080p)',category:'Sports'}));
        host.presentation='page';host.channels=()=>saved;host.selectedChannel=()=>saved[0];
        host.mappings=async()=>saved.slice(0,3).map((c,i)=>({...mapping,appChannelId:c.id,xmltvChannelId:'xml'+i}));
        const agenda=${JSON.stringify(size.width < 900)};
        const listing=(id,title,startMs,stopMs,ordinal)=>({catalogSourceId:'catalog',appChannelId:id,guideSourceId:'guide',xmltvChannelId:'xml'+saved.findIndex(c=>c.id===id),title,startMs,stopMs,ordinal,description:'Complete controlled listing details',categories:[{text:'Sports'}]});
        host.query=async q=>{calls.queries.push(q);return {programs:agenda?[listing(q.appChannelIds[0],'Readable current programme',instant-1000,instant+100000,0),listing(q.appChannelIds[0],'Upcoming programme with complete title',instant+200000,instant+300000,1)]:[],nextCursor:null,sourceRevision:1,databaseRevision:1};};
        if(agenda)host.summary=async q=>({...q,catalogRevision:'1',databaseRevision:1,mappingStatus:'mapped',mapping:{catalogSourceId:'catalog',appChannelId:q.appChannelId,guideSourceId:'guide',xmltvChannelId:'xml'+saved.findIndex(c=>c.id===q.appChannelId)},sourceRevision:1,publishedRevision:1,updatedMs:instant,coverage:{startMs:instant-1000,endMs:instant+300000},cacheStatus:'current',currentStatus:'current',nextStatus:'next',current:{title:'Readable current programme',startMs:instant-1000,stopMs:instant+100000},next:{title:'Upcoming programme with complete title',startMs:instant+200000,stopMs:instant+300000}});

        window.guide=GuideUI.mountGuide(document.getElementById('primary-view-host'),host);
        window.removeGuideRemote=GuideUI.installRemoteNavigation();
        await window.guide.open();
      `,
        type: 'module',
      });
      const agenda = size.width < 900;
      if (agenda)
        await page
          .getByRole('button', { name: 'Readable current programme', exact: true })
          .waitFor();
      else {
        await page.locator('.gx-timeline-row').first().waitFor();
        await page.locator('.gx-timeline-status[data-state="ready"]').waitFor();
      }
      if (size.enlarged) {
        await page.evaluate(() => {
          const sizes = [...document.querySelectorAll<HTMLElement>('#app, #app *')].map((node) => ({
            node,
            size: parseFloat(getComputedStyle(node).fontSize),
          }));
          for (const { node, size } of sizes) node.style.fontSize = `${size * 2}px`;
        });
      }
      expect(await page.getByRole('button', { name: 'Guide view', exact: true }).isVisible()).toBe(
        false,
      );
      expect(
        await page
          .locator('.guide-feedback [role="status"]:not([aria-label="Guide update"])')
          .getAttribute('aria-label'),
      ).toContain('3 of 31 channels linked');
      expect(await page.locator('.gx-timeline-status').textContent()).not.toContain('GMT');
      if (agenda && size.enlarged)
        await expect
          .poll(() => page.locator('.gx-timeline').getAttribute('data-agenda-compact'))
          .toBe('true');
      const controls = page.getByRole('button', { name: 'Guide controls', exact: true });
      if (agenda && (await controls.isVisible())) await controls.click();
      for (const label of [
        'All channels',
        'Favorites',
        'Now',
        'Find program guides',
        'Close guide',
      ]) {
        // The channel row beside the guide has its own Favorites button.
        const target = page
          .locator('.guide-dialog')
          .getByRole('button', { name: label, exact: true });
        await target.scrollIntoViewIfNeeded();
        // Touch screens need 44 px targets; a TV uses its 34 px remote size.
        const minimum = size.deviceKind === 'tv' ? 34 : 44;
        expect(
          await target.evaluate((node, minimum) => {
            const r = node.getBoundingClientRect();
            return (
              r.height >= minimum &&
              r.width >= minimum &&
              r.top >= 0 &&
              r.bottom <= innerHeight &&
              r.left >= 0 &&
              r.right <= innerWidth &&
              node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            );
          }, minimum),
          label,
        ).toBe(true);
      }
      if (agenda && (await controls.isVisible())) await controls.click();
      const first = agenda
        ? page.locator('.gx-agenda-channel')
        : page.locator('.gx-timeline-channel').first();
      await first.evaluate((node) => (node as HTMLElement).focus({ preventScroll: true }));
      expect(await first.textContent()).toContain('A complete long channel name 0');
      if (!agenda) {
        const geometry = await page.locator('.gx-timeline-viewport').evaluate((node) => {
          const v = node.getBoundingClientRect();
          return [...node.querySelectorAll('.gx-timeline-row')].filter((row) => {
            const r = row.getBoundingClientRect();
            return r.top >= v.top && r.bottom <= v.bottom;
          }).length;
        });
        expect(geometry).toBeGreaterThanOrEqual(size.completeRows);
        // Every toolbar control, Close included, is on screen: on the Sansui TV
        // the toolbar ran off the right edge and Close was out of the remote's
        // reach (October 19, 2026).
        const offscreen = await page.locator('.gx-timeline-toolbar').evaluateAll((toolbars) =>
          toolbars
            .filter((toolbar) => toolbar.getBoundingClientRect().width > 0)
            .flatMap((toolbar) => {
              const box = toolbar.getBoundingClientRect();
              const problems =
                toolbar.scrollWidth > toolbar.clientWidth + 1
                  ? [`toolbar scrolls ${toolbar.scrollWidth}>${toolbar.clientWidth}`]
                  : [];
              for (const control of toolbar.querySelectorAll('button, input')) {
                if (!control.getClientRects().length) continue;
                const r = control.getBoundingClientRect();
                if (
                  r.left < box.left - 0.5 ||
                  r.right > Math.min(box.right, innerWidth) + 0.5 ||
                  r.top < 0 ||
                  r.bottom > innerHeight
                )
                  problems.push(control.textContent || control.getAttribute('aria-label') || '?');
              }
              return problems;
            }),
        );
        expect(offscreen, `${size.width}x${size.height}`).toEqual([]);
        // Every programme box fits inside its row (no spilling into the next).
        const spill = await page.locator('.gx-timeline-row').evaluateAll((rows) =>
          rows.flatMap((row) => {
            const r = row.getBoundingClientRect();
            return [...row.querySelectorAll('.gx-timeline-cell, .gx-timeline-channel')]
              .map((cell) => cell.getBoundingClientRect())
              .filter((c) => c.top < r.top - 1 || c.bottom > r.bottom + 1)
              .map((c) => `${Math.round(c.height)}>${Math.round(r.height)}`);
          }),
        );
        expect(spill).toEqual([]);
        expect(await first.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('nowrap');
        await page.screenshot({
          path: `artifacts/guide-timeline/${new Date().toISOString().replaceAll(':', '-')}-post-back-geometry/normal-page-${size.width}x${size.height}.png`,
        });
        if (size.width === 854) {
          expect(
            await page
              .locator('.gx-timeline-row')
              .first()
              .evaluate((node) => node.getBoundingClientRect().height),
          ).toBe(64);
          await page.getByRole('button', { name: 'All channels', exact: true }).focus();
          for (let step = 0; step < 8; step++) {
            await page.keyboard.press('Tab');
            expect(
              await page.evaluate(() => {
                const node = document.activeElement;
                // Toolbar controls are buttons plus the Guide search field.
                if (!(node instanceof HTMLButtonElement || node instanceof HTMLInputElement))
                  return false;
                const r = node.getBoundingClientRect();
                return (
                  r.width >= 44 &&
                  r.height >= 44 &&
                  r.left >= 0 &&
                  r.right <= innerWidth &&
                  r.top >= 0 &&
                  r.bottom <= innerHeight &&
                  node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
                );
              }),
            ).toBe(true);
          }
          expect(
            await page
              .getByRole('button', { name: 'Close guide', exact: true })
              .evaluate((node) => node === document.activeElement),
          ).toBe(true);
          await first.evaluate((node) => (node as HTMLElement).focus({ preventScroll: true }));
        }
      }
      if (!agenda) {
        await page.keyboard.press('ArrowDown');
        await page.waitForFunction(
          () =>
            document.activeElement?.querySelector('.media-result-title')?.textContent ===
            'A complete long channel name 1 (1080p)',
        );
      } else {
        await first.scrollIntoViewIfNeeded();
        expect(await first.evaluate((node) => node.getBoundingClientRect().height >= 44)).toBe(
          true,
        );
        expect(await first.getAttribute('aria-label')).toBe(
          'Browse guide channel: A complete long channel name 0 (1080p)',
        );
        expect(await page.locator('.gx-timeline-axis').isVisible()).toBe(false);
        const watchChannel = page.getByRole('button', {
          name: 'Watch channel: A complete long channel name 0 (1080p)',
          exact: true,
        });
        await watchChannel.scrollIntoViewIfNeeded();
        if (size.width === 320)
          expect(
            await first.evaluate((node) => node.getBoundingClientRect().width >= innerWidth / 2),
          ).toBe(true);
        expect(
          await watchChannel.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return (
              r.width >= 44 &&
              r.height >= 44 &&
              r.left >= 0 &&
              r.right <= innerWidth &&
              r.top >= 0 &&
              r.bottom <= innerHeight &&
              node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            );
          }),
        ).toBe(true);
        const current = page.getByRole('button', {
          name: 'Readable current programme',
          exact: true,
        });
        await current.scrollIntoViewIfNeeded();
        expect(
          await current.evaluate((n) => {
            const r = n.getBoundingClientRect(),
              v = n.closest('.gx-timeline-viewport')!.getBoundingClientRect();
            return (
              r.height >= 44 &&
              r.width >= 44 &&
              r.left >= v.left &&
              r.right <= v.right &&
              r.top >= v.top &&
              r.bottom <= v.bottom &&
              n.scrollWidth <= n.clientWidth &&
              [...n.querySelectorAll<HTMLElement>('strong,.gx-agenda-time')].every((element) => {
                const bounds = element.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(element);
                return (
                  bounds.top >= r.top &&
                  bounds.bottom <= r.bottom &&
                  bounds.left >= r.left &&
                  bounds.right <= r.right &&
                  [...range.getClientRects()].every(
                    (text) =>
                      text.top >= bounds.top &&
                      text.bottom <= bounds.bottom &&
                      text.left >= bounds.left &&
                      text.right <= bounds.right,
                  )
                );
              }) &&
              n.contains(
                document.elementFromPoint(
                  r.x + r.width / 2,
                  Math.max(v.top, Math.min(v.bottom - 1, r.y + r.height / 2)),
                ),
              )
            );
          }),
        ).toBe(true);
        expect(await page.locator('.gx-agenda-listing').count()).toBe(2);
        expect(
          await page.evaluate(
            () =>
              document.querySelector<HTMLVideoElement>('video')!.paused &&
              // The channel list stays beside the right-panel Guide.
              !document.querySelector<HTMLElement>('.workspace')!.hidden &&
              Reflect.get(window, 'calls').watch.length === 0 &&
              (Reflect.get(window, 'discoveryCalls') || 0) === 0,
          ),
        ).toBe(true);
        await first.click();
        expect(await page.locator('.gx-agenda-channel-option').count()).toBeLessThanOrEqual(8);
        expect(await page.getByRole('button', { name: 'More channels', exact: true }).count()).toBe(
          0,
        );
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await expect.poll(() => first.textContent()).toContain('A complete long channel name 1');
        await current.focus();
        await page.keyboard.press('ArrowDown');
        const upcoming = page.getByRole('button', {
          name: 'Upcoming programme with complete title',
          exact: true,
        });
        expect(await upcoming.evaluate((n) => n === document.activeElement)).toBe(true);
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: 'Back to timeline', exact: true }).waitFor();
        expect(
          await page.getByRole('button', { name: 'Watch current channel', exact: true }).count(),
        ).toBe(0);
        await page.keyboard.press('Escape');
        expect(await upcoming.evaluate((n) => n === document.activeElement)).toBe(true);
        if (size.width === 640 && size.enlarged) {
          expect(await upcoming.locator('strong').textContent()).toBe(
            'Upcoming programme with complete title',
          );
          expect(await upcoming.locator('.gx-agenda-time').textContent()).toMatch(/\S.+ – \S.+/);
          await page.screenshot({
            path: `artifacts/guide-timeline/${new Date().toISOString().replaceAll(':', '-')}-post-back-diagnostic/upcoming-640x360.png`,
          });
          const metrics = await upcoming.evaluate((node) => {
            const target = node.getBoundingClientRect();
            const viewport = node.closest('.gx-timeline-viewport')!.getBoundingClientRect();
            const navigation = document.querySelector('.gx-agenda-header')!.getBoundingClientRect();
            const elements = [
              node.querySelector<HTMLElement>('strong')!,
              node.querySelector<HTMLElement>('.gx-agenda-time')!,
            ];
            const inside = (r: DOMRect, outer: DOMRect) =>
              r.top >= outer.top &&
              r.bottom <= outer.bottom &&
              r.left >= outer.left &&
              r.right <= outer.right;
            return {
              focused: node === document.activeElement,
              minTarget: target.width >= 44 && target.height >= 44,
              targetInside: inside(target, viewport),
              navigationClear: target.top >= navigation.bottom,
              screenInside:
                target.top >= 0 &&
                target.bottom <= innerHeight &&
                target.left >= 0 &&
                target.right <= innerWidth,
              children: elements.map((element) => {
                const r = element.getBoundingClientRect();
                return {
                  inside: inside(r, target),
                  nonempty: r.width > 0 && r.height > 0,
                  notClipped: (() => {
                    const range = document.createRange();
                    range.selectNodeContents(element);
                    return (
                      element.scrollWidth <= element.clientWidth &&
                      element.scrollHeight <= element.clientHeight &&
                      [...range.getClientRects()].every((text) => inside(text, r))
                    );
                  })(),
                  rect: r.toJSON(),
                  client: [element.clientWidth, element.clientHeight],
                  scroll: [element.scrollWidth, element.scrollHeight],
                  textRects: (() => {
                    const range = document.createRange();
                    range.selectNodeContents(element);
                    return [...range.getClientRects()].map((r) => r.toJSON());
                  })(),
                };
              }),
              hit: node.contains(
                document.elementFromPoint(
                  target.x + target.width / 2,
                  target.y + target.height / 2,
                ),
              ),
              target: target.toJSON(),
              viewport: viewport.toJSON(),
              navigation: navigation.toJSON(),
            };
          });
          expect(metrics).toMatchObject({
            focused: true,
            minTarget: true,
            targetInside: true,
            navigationClear: true,
            screenInside: true,
            hit: true,
            children: [
              { inside: true, nonempty: true, notClipped: true },
              { inside: true, nonempty: true, notClipped: true },
            ],
          });
        }
        expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <= innerWidth &&
              document.documentElement.scrollHeight <= innerHeight,
          ),
        ).toBe(true);
        await page.screenshot({
          path: `artifacts/guide-timeline/${new Date().toISOString().replaceAll(':', '-')}-real-guide-agenda/normal-page-${size.width}x${size.height}.png`,
        });
      }
      await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
      await page
        .getByRole('button', { name: 'Guide view', exact: true })
        .waitFor({ state: 'visible' });
    } finally {
      await page.evaluate(() => Reflect.get(window, 'removeGuideRemote')?.());
      await dispose(page);
    }
  });
}

it('Guide force reload applies favorite metadata by saved source identity without tuning', async () => {
  const page = await fixture(false, true);
  try {
    await page.setViewportSize({ width: 960, height: 540 });
    await page.evaluate(async () => {
      const host = Reflect.get(window, 'host');
      Reflect.set(window, 'favoriteChannels', [
        { id: 'a', sourceId: 'catalog', name: 'Same channel name', favorite: false },
        { id: 'b', sourceId: 'other-catalog', name: 'Same channel name', favorite: true },
      ]);
      host.channels = () => Reflect.get(window, 'favoriteChannels');
      host.selectedChannel = () => host.channels()[0];
      host.mappings = async () =>
        host.channels().map((c: { id: string; sourceId: string }) => ({
          appChannelId: c.id,
          catalogSourceId: c.sourceId,
          guideSourceId: 'guide',
          xmltvChannelId: 'xml-' + c.id,
        }));
      host.query = async (query: unknown) => {
        Reflect.get(window, 'calls').queries.push(query);
        return { programs: [], nextCursor: null, sourceRevision: 1, databaseRevision: 1 };
      };
      await Reflect.get(window, 'guide').open();
    });
    await page.locator('.gx-timeline-row').nth(1).waitFor();
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await expect.poll(() => page.locator('.gx-timeline-row').count()).toBe(1);
    expect(
      JSON.parse(
        (await page.locator('.gx-timeline-row').getAttribute('data-channel-key')) ?? 'null',
      ).slice(0, 2),
    ).toEqual(['b', 'other-catalog']);
    const beforeEmptyQueries = await page.evaluate(
      () => Reflect.get(window, 'calls').queries.length,
    );
    await page.evaluate(() => {
      Reflect.set(
        window,
        'favoriteChannels',
        Reflect.get(window, 'favoriteChannels').map((c: { favorite: boolean }) => ({
          ...c,
          favorite: false,
        })),
      );
      Reflect.get(window, 'guide').catalogChanged(true);
    });
    await expect
      .poll(() => page.locator('.gx-timeline-status').textContent())
      .toBe('No favorite channels. Choose All to browse saved channels.');
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    expect(await page.locator('.gx-timeline-now').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').queries.length)).toBe(
      beforeEmptyQueries,
    );
    await page.getByRole('button', { name: 'All channels', exact: true }).click();
    await page.locator('.gx-timeline-row').nth(1).waitFor();
    expect(await page.locator('.gx-timeline-status').textContent()).not.toContain(
      'No favorite channels',
    );
    await page.evaluate(() => {
      Reflect.set(
        window,
        'favoriteChannels',
        Reflect.get(window, 'favoriteChannels').map((c: { id: string }) => ({
          ...c,
          favorite: c.id === 'b',
        })),
      );
      Reflect.get(window, 'guide').catalogChanged(true);
    });
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await expect.poll(() => page.locator('.gx-timeline-row').count()).toBe(1);
    await page.evaluate(() => {
      Reflect.set(
        window,
        'favoriteChannels',
        Reflect.get(window, 'favoriteChannels').filter((c: { id: string }) => c.id !== 'b'),
      );
      Reflect.get(window, 'guide').catalogChanged(true);
    });
    await expect
      .poll(() => page.locator('.gx-timeline-status').textContent())
      .toBe('No favorite channels. Choose All to browse saved channels.');
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    expect(await page.locator('.gx-timeline-now').count()).toBe(0);
    await page.getByRole('button', { name: 'All channels', exact: true }).click();
    await expect.poll(() => page.locator('.gx-timeline-row').count()).toBe(1);
    expect(
      await page.evaluate(() => ({
        watch: Reflect.get(window, 'calls').watch.length,
        revision: Reflect.get(window, 'catalogRevision'),
      })),
    ).toEqual({ watch: 0, revision: '1' });
  } finally {
    await dispose(page);
  }
});

for (const unmapped of [false, true]) {
  for (const activation of ['click', 'Enter']) {
    it(`agenda deliberate channel ${activation} plays current saved identity without requiring EPG, mapped=${!unmapped}`, async () => {
      const page = await fixture(false, true);
      try {
        await page.setViewportSize({ width: 320, height: 640 });
        await page.evaluate((missing) => {
          if (missing) Reflect.set(window, 'mode', 'unmapped');
          Reflect.get(window, 'guide').open();
        }, unmapped);
        const chooser = page.locator('.gx-agenda-channel');
        await chooser.waitFor();
        await chooser.focus();
        expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
        await chooser.click();
        await page.locator('.gx-agenda-channel-option').first().click();
        expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
        if (unmapped) {
          expect(await page.locator('.gx-agenda-listing[data-program-key]').count()).toBe(0);
          expect(
            await page.getByRole('button', { name: 'Schedule details', exact: true }).count(),
          ).toBe(1);
        }
        const watch = page.getByRole('button', { name: 'Watch channel: FOX Chicago', exact: true });
        await watch.scrollIntoViewIfNeeded();
        expect(
          await watch.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return (
              r.width >= 44 &&
              r.height >= 44 &&
              r.left >= 0 &&
              r.right <= innerWidth &&
              node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            );
          }),
        ).toBe(true);
        if (activation === 'Enter') {
          await watch.focus();
          await page.keyboard.press('Enter');
        } else await watch.click();
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'calls').watch.length))
          .toBe(1);
        expect(await page.evaluate(() => Reflect.get(window, 'calls').watch[0])).toEqual({
          id: 'fox',
          sourceId: 'catalog',
          name: 'FOX Chicago',
        });
        await expect.poll(() => page.getByRole('dialog').isVisible()).toBe(false);
      } finally {
        await dispose(page);
      }
    });
  }
}
it('agenda channel activation rechecks saved identity and refuses a removed channel', async () => {
  const page = await fixture(false, true);
  try {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'unmapped');
      Reflect.get(window, 'guide').open();
    });
    const watch = page.getByRole('button', { name: 'Watch channel: FOX Chicago', exact: true });
    await watch.waitFor();
    await page.evaluate(() => {
      Reflect.get(window, 'host').channels = () => [];
    });
    await watch.click();
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('Guide action failed');
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
    expect(await page.getByRole('dialog').isVisible()).toBe(true);
  } finally {
    await dispose(page);
  }
});

it('explicit Map reports durable connection before optional targeted hydration; opening is read-only', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'unmapped');
      Reflect.set(window, 'hydrateCalls', 0);
      Reflect.get(window, 'host').mapAndHydrate = async (
        mapping: unknown,
        _signal: AbortSignal,
        saved: () => void,
      ) => {
        Reflect.set(window, 'hydrateCalls', Reflect.get(window, 'hydrateCalls') + 1);
        Reflect.get(window, 'calls').mapping.push(mapping);
        saved();
        await new Promise<void>((resolve) => Reflect.set(window, 'releaseHydration', resolve));
        return { status: 'saved-but-failed', published: false };
      };
      Reflect.get(window, 'guide').openMapping(Reflect.get(window, 'host').selectedChannel());
    });
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Mapping guide channel"]')?.children.length,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'hydrateCalls'))).toBe(0);
    await page.getByRole('button', { name: 'Map selected channel', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'calls').mapping.length))
      .toBe(1);
    await expect
      .poll(() => page.getByRole('dialog').textContent())
      .toContain('Guide connection saved. Checking its schedule');
    await page.evaluate(() => Reflect.get(window, 'releaseHydration')());
    await expect
      .poll(() => page.getByRole('dialog').textContent())
      .toContain('Guide connection saved. Its schedule could not be updated');
    expect(await page.evaluate(() => Reflect.get(window, 'discoveryCalls') ?? 0)).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
  } finally {
    await dispose(page);
  }
});

it('Map hydration suspension aborts and joins original acquisition before cleanup', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'unmapped');
      Reflect.get(window, 'host').mapAndHydrate = async (
        mapping: unknown,
        signal: AbortSignal,
        saved: () => void,
      ) => {
        Reflect.get(window, 'calls').mapping.push(mapping);
        Reflect.set(window, 'hydrationSignal', signal);
        saved();
        await new Promise<void>((resolve) => Reflect.set(window, 'releaseHydration', resolve));
        return { status: 'canceled', published: false };
      };
      Reflect.get(window, 'host').settleMappingHydration = async () => {
        Reflect.set(window, 'cleanupEntered', true);
      };
      Reflect.get(window, 'guide').openMapping(Reflect.get(window, 'host').selectedChannel());
    });
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Mapping guide channel"]')?.children.length,
    );
    await page.getByRole('button', { name: 'Map selected channel', exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, 'hydrationSignal'));
    await page.evaluate(() => {
      Reflect.set(window, 'suspensionDone', false);
      void Reflect.get(window, 'guide')
        .suspend()
        .then(() => Reflect.set(window, 'suspensionDone', true));
    });
    expect(await page.evaluate(() => Reflect.get(window, 'hydrationSignal').aborted)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'suspensionDone'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'cleanupEntered') ?? false)).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'releaseHydration')());
    await page.waitForFunction(() => Reflect.get(window, 'suspensionDone'));
    expect(await page.evaluate(() => Reflect.get(window, 'cleanupEntered'))).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').mapping.length)).toBe(1);
  } finally {
    await dispose(page);
  }
});

it('unconfirmed mapping cleanup prevents successful Guide close and remains retryable', async () => {
  const page = await fixture();
  try {
    await open(page);
    await page.evaluate(() => {
      Reflect.get(window, 'host').settleMappingHydration = async () => {
        throw new Error('controlled cleanup failure');
      };
    });
    expect(
      await page.evaluate(async () => {
        try {
          await Reflect.get(window, 'guide').close();
          return 'closed';
        } catch {
          return 'retained';
        }
      }),
    ).toBe('retained');
    expect(await page.getByRole('dialog').isVisible()).toBe(true);
    await page.evaluate(() => {
      Reflect.get(window, 'host').settleMappingHydration = async () => {};
    });
    await page.evaluate(() => Reflect.get(window, 'guide').close());
    expect(await page.getByRole('dialog').isVisible()).toBe(false);
  } finally {
    await dispose(page);
  }
});
