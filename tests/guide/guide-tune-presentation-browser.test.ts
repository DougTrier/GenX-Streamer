// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { resolve } from 'node:path';
import { fixture, useGuideUiBrowser } from './guide-ui-browser.fixture';
import { readStylesheet } from '../support/stylesheet';

useGuideUiBrowser();
let playbackBundle: string, styles: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'guide-tune-playback',
        resolveId: (id) => (id.endsWith('virtual:guide-tune') ? '\0guide-tune' : undefined),
        load: (id) =>
          id === '\0guide-tune'
            ? [
                ['PlaybackController', 'src/playback/controller.ts'],
                ['createNativeVodEngine', 'src/playback/native-vod-engine.ts'],
                ['createNativePictureHost', 'src/ui/player/native-picture.ts'],
                ['createPageController', 'src/application/shell/page-controller.ts'],
                ['createPageState', 'src/application/shell/page-state.ts'],
                ['createLibraryState', 'src/application/genxtra/library-state.ts'],
              ]
                .map(([name, file]) => `export {${name}} from ${JSON.stringify(resolve(file!))};`)
                .join('\n')
            : undefined,
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:guide-tune', formats: ['iife'], name: 'Playback' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing playback bundle');
  const chunk = output.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing playback entry');
  playbackBundle = chunk.code;
  styles = (
    await Promise.all(
      [
        'style',
        'management',
        'guide',
        'guide-timeline',
        'responsive',
        'in-app-select',
        'modal-viewport',
        'fullscreen',
        'tv-density',
        'account-vod',
        'genxtra',
        'media-results',
        'guide-panel',
        'native-video',
      ].map((name) => readStylesheet(`src/ui/${name}.css`)),
    )
  ).join('\n');
});

async function playingGuide(
  native: boolean,
  pagePresentation = true,
  notifySelection = false,
  size?: { width: number; height: number },
) {
  const page = await fixture(false, true, true);
  if (size) await page.setViewportSize(size);
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: playbackBundle });
  await page.addScriptTag({
    type: 'module',
    content: `
    await window.guide.dispose();
    const app=document.getElementById('guide');app.id='app';GuideUI.createShell(app);
    app.dataset.deviceKind='tv';app.dataset.playerIdle='true';app.dataset.compactView='watch';
    document.getElementById('cast-button').hidden=true;
    const screen=document.getElementById('screen'),video=document.getElementById('video');
    const box=()=>{const r=screen.getBoundingClientRect();return [r.left,r.top,r.width,r.height]};
    window.observations=[];window.requests=[];window.watchDone=0;window.watchStarted=0;
    let observing=false,stopped=false;
    const observe=()=>{if(observing)observations.push({guide:app.dataset.guidePanel,hidden:document.getElementById('primary-view-host').hidden,rect:box()})};
    const frame=()=>{observe();if(!stopped)requestAnimationFrame(frame)};requestAnimationFrame(frame);
    const mutations=new MutationObserver(observe);mutations.observe(app,{attributes:true,attributeFilter:['data-guide-panel','data-player-idle','class']});
    let position=0;
    const picture=Playback.createNativePictureHost(async request=>{
      requests.push(structuredClone(request));position+=40;
      return {session:request.session,state:request.action==='close'?'closed':'ready',playing:request.action!=='close',positionMs:position,durationMs:-1,audio:[],text:[]};
    },{app,screen,video});
    const player=new Playback.PlaybackController(emit=>${native} ? Playback.createNativeVodEngine(emit,picture,{live:true}) : ({
      async start(){observe();emit({type:'progress'})},pause(){},async resume(){},setMuted(){},setVolume(){},dispose(){}
    }));
    let renderedSelection=null;
    player.subscribe(snapshot=>{app.dataset.playerIdle=String(!snapshot.selection&&snapshot.state==='idle');document.getElementById('player-overlay').hidden=snapshot.state==='playing';observe();const selected=snapshot.selection?.id??null;if(${notifySelection}&&selected!==renderedSelection){renderedSelection=selected;window.guide.selectedChannelChanged()}});
    const pageState=Playback.createPageState(),library=Playback.createLibraryState();
    const pageController=Playback.createPageController({pageState,library,element:id=>document.getElementById(id),applicationClosing:false,
      get guide(){return window.guide},paidGuide:{async hide(){}},archiveDiscovery:{async suspend(){}},nativeViewingForeground:true,
      accountBrowser:{selectedAccount:null},libraryQueries:{live:'',genxtra:''}});
    const saved=[{id:'fox',sourceId:'catalog',name:'FOX Chicago',category:'Sports'},{id:'other',sourceId:'catalog',name:'Other Sports',category:'Sports'},...(${notifySelection}?Array.from({length:38},(_,i)=>({id:'extra-'+i,sourceId:'catalog',name:'Extra sports '+i,category:'Sports'})):[])];
    const mapped=c=>({catalogSourceId:c.sourceId,appChannelId:c.id,guideSourceId:'guide',xmltvChannelId:c.id==='fox'?'wfld':'other-xml'});
    const programme=c=>({...mapped(c),title:'Live '+c.name,startMs:instant-1000,stopMs:instant+100000,ordinal:0,description:'Current sports programme'});
    host.channels=()=>saved;host.selectedChannel=()=>saved.find(c=>c.id===player.snapshot.selection?.id)||null;
    host.mappings=async()=>saved.map(mapped);host.catalogRevision=()=> '1';
    host.query=async q=>{if(window.holdStatusReads)await new Promise(resolve=>window.statusReadGates.push(resolve));return {programs:saved.filter(c=>q.appChannelIds.includes(c.id)).map(programme),nextCursor:null,sourceRevision:1,databaseRevision:1}};
    host.summary=async q=>{const c=saved.find(c=>c.id===q.appChannelId);return {...q,catalogRevision:'1',databaseRevision:1,mappingStatus:'mapped',mapping:mapped(c),sourceRevision:1,publishedRevision:1,updatedMs:instant,coverage:{startMs:instant-1000,endMs:instant+100000},cacheStatus:'current',currentStatus:'current',nextStatus:'none',current:programme(c),next:null}};
    host.presentation=${pagePresentation}?'page':undefined;host.enableTimeline=true;
    host.opened=async()=>pageController.presentPrimaryPage('guide');
    host.closed=async()=>{pageController.presentPrimaryPage('watch');observe()};
    host.watch=async(c,signal)=>{signal.throwIfAborted();window.watchStarted++;observing=true;await player.select({id:c.id,name:c.name,url:'http://127.0.0.1:41234/media/'+c.id,mediaKind:'hls'});window.watchDone++;observe()};
    window.guide=GuideUI.mountGuide(${pagePresentation} ? document.getElementById('primary-view-host') : document.body,host);
    window.tuneFixture={player,pageController,pageState,box,async dispose(){stopped=true;mutations.disconnect();await guide.dispose();await player.dispose()}};
    await guide.open();
  `,
  });
  await page.locator('.gx-timeline-channel:visible, .gx-agenda-watch:visible').first().waitFor();
  return page;
}

for (const size of [
  { width: 960, height: 540, name: 'Google TV' },
  { width: 833, height: 397, name: 'compact Thor' },
])
  it(`${size.name} page status settles a held visible-window read without shifting its focused row or panes`, async () => {
    const page = await playingGuide(true, true, true, size);
    try {
      await page.waitForFunction(
        () => document.querySelector('.gx-timeline-status')?.getAttribute('data-state') === 'ready',
      );
      await page.evaluate(() => {
        Reflect.set(window, 'statusReadGates', []);
        Reflect.set(window, 'holdStatusReads', true);
        const viewport = document.querySelector<HTMLElement>('.gx-timeline-viewport')!;
        const pitch = parseFloat(
          getComputedStyle(document.querySelector('.gx-timeline')!).getPropertyValue(
            '--gx-row-height',
          ),
        );
        viewport.scrollTop = 30 * pitch;
        viewport.dispatchEvent(new Event('scroll'));
      });
      await page.waitForFunction(
        () =>
          Reflect.get(window, 'statusReadGates').length > 0 &&
          document.querySelector('.gx-timeline-status')?.textContent ===
            'Loading visible listings…',
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const pending = await page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('.gx-timeline-viewport')!;
        const clip = viewport.getBoundingClientRect();
        const labels = [...document.querySelectorAll<HTMLElement>('.gx-timeline-channel')].filter(
          (label) => {
            const box = label.getBoundingClientRect();
            return box.top >= clip.top && box.bottom <= clip.bottom;
          },
        );
        const label = labels.at(-1)!;
        label.focus({ preventScroll: true });
        Reflect.set(window, 'statusRetainedLabel', label);
        Reflect.set(window, 'statusRetainedRow', label.closest('.gx-timeline-row'));
        const box = (selector: string) => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height];
        };
        Reflect.set(window, 'statusGeometry', () => ({
          scroll: viewport.scrollTop,
          viewport: box('.gx-timeline-viewport'),
          axis: box('.gx-timeline-axis'),
          status: box('.gx-timeline-status'),
          pane: box('#primary-view-host'),
          preview: box('#screen'),
          label: (() => {
            const r = label.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          })(),
          connected: label.isConnected && Reflect.get(window, 'statusRetainedRow').isConnected,
          focused: document.activeElement === label,
        }));
        return Reflect.get(window, 'statusGeometry')();
      });
      expect(pending.focused).toBe(true);
      expect(pending.scroll).toBeGreaterThan(0);
      await page.evaluate(() => {
        document.querySelector('.gx-timeline-status')!.textContent =
          'Loading visible listings while saved schedule details are checked… '.repeat(12);
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await page.evaluate(() => Reflect.get(window, 'statusGeometry')())).toEqual(pending);
      expect(
        await page.locator('.gx-timeline-status').evaluate((status) => ({
          whiteSpace: getComputedStyle(status).whiteSpace,
          overflowsOneLine: status.scrollWidth > status.clientWidth,
          singleLineHeight:
            Math.abs(
              status.getBoundingClientRect().height -
                parseFloat(getComputedStyle(status).lineHeight),
            ) < 1,
        })),
      ).toEqual({ whiteSpace: 'nowrap', overflowsOneLine: true, singleLineHeight: true });
      await page.evaluate(() => {
        Reflect.set(window, 'holdStatusReads', false);
        for (const release of Reflect.get(window, 'statusReadGates').splice(0)) release();
      });
      await page.waitForFunction(
        () => document.querySelector('.gx-timeline-status')?.getAttribute('data-state') === 'ready',
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await page.evaluate(() => Reflect.get(window, 'statusGeometry')())).toEqual(pending);
    } finally {
      await page.evaluate(async () => {
        Reflect.set(window, 'holdStatusReads', false);
        for (const release of Reflect.get(window, 'statusReadGates') ?? []) release();
        await Reflect.get(window, 'tuneFixture').dispose();
      });
      await page.close();
    }
  });

for (const native of [false, true]) {
  it(`${native ? 'native' : 'browser'} actual selection notification preserves remote Guide row focus after tuning`, async () => {
    const page = await playingGuide(native, true, true);
    try {
      const other = page.locator('.gx-timeline-channel[title="Other Sports"]');
      await other.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => Reflect.get(window, 'watchDone') === 1);
      await expect
        .poll(() => page.locator('.gx-timeline-status').getAttribute('data-state'))
        .toBe('ready');
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
        .toBe('Other Sports');
      await page.keyboard.press('ArrowUp');
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
        .toBe('FOX Chicago');
    } finally {
      await page.evaluate(() => Reflect.get(window, 'tuneFixture').dispose());
      await page.close();
    }
  });
  it(`${native ? 'native' : 'browser'} channel tuning preserves the page Guide and mini bounds from the first selection`, async () => {
    const page = await playingGuide(native);
    try {
      const sports = page
        .locator('.guide-dialog')
        .getByRole('button', { name: 'Sports', exact: true });
      await sports.click();
      for (const [index, id] of ['fox', 'other'].entries()) {
        await page.locator('.gx-timeline-channel').nth(index).click();
        await page.waitForFunction(
          (count) => Reflect.get(window, 'watchDone') === count,
          index + 1,
        );
        await expect.poll(() => page.locator('.guide-dialog').getAttribute('open')).not.toBeNull();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
        const result = await page.evaluate(() => {
          const f = Reflect.get(window, 'tuneFixture');
          return {
            state: f.player.snapshot.state,
            id: f.player.snapshot.selection?.id,
            primary: f.pageState.primaryPage,
            observations: Reflect.get(window, 'observations'),
            requests: Reflect.get(window, 'requests'),
          };
        });
        expect(result).toMatchObject({ state: 'playing', id, primary: 'guide' });
        expect(await sports.getAttribute('aria-pressed')).toBe('true');
        expect(result.observations.length).toBeGreaterThan(1);
        for (const sample of result.observations) {
          expect(sample.guide).toBe('open');
          expect(sample.hidden).toBe(false);
          expect(sample.rect[0]).toBeLessThan(100);
          expect(sample.rect[2]).toBeGreaterThan(100);
          expect(sample.rect[2]).toBeLessThan(390);
          expect(sample.rect[3]).toBeLessThan(240);
        }
        if (native) {
          const positioned = result.requests.filter((request: { rect?: number[] }) => request.rect);
          expect(positioned.length).toBeGreaterThan(0);
          for (const request of positioned) {
            expect(request.viewport).toEqual([960, 540]);
            expect(request.rect[0]).toBeLessThan(100);
            expect(request.rect[2]).toBeLessThan(390);
            expect(request.rect[3]).toBeLessThan(240);
          }
        }
      }
      await page.locator('.gx-timeline-cell').first().click();
      await page.getByRole('button', { name: 'Watch current channel', exact: true }).click();
      await page.waitForFunction(() => Reflect.get(window, 'watchDone') === 3);
      expect(await page.locator('.guide-dialog').getAttribute('open')).not.toBeNull();
      expect(
        await page.evaluate(() => Reflect.get(window, 'tuneFixture').pageState.primaryPage),
      ).toBe('guide');
      expect(await sports.getAttribute('aria-pressed')).toBe('true');
      await page.getByRole('button', { name: 'Back to timeline', exact: true }).click();
      await page.evaluate(() => Reflect.get(window, 'guide').openAdvanced());
      expect(await page.locator('.guide-dialog').evaluate((node) => node.matches(':modal'))).toBe(
        true,
      );
    } finally {
      await page.evaluate(() => Reflect.get(window, 'tuneFixture').dispose());
      await page.close();
    }
  });
}

it('a modal Guide still dismisses after direct channel selection', async () => {
  const page = await playingGuide(false, false);
  try {
    expect(await page.locator('.guide-dialog').evaluate((node) => node.matches(':modal'))).toBe(
      true,
    );
    await page.locator('.gx-timeline-channel:visible, .gx-agenda-watch:visible').first().click();
    await page.waitForFunction(() => Reflect.get(window, 'watchDone') === 1);
    await expect.poll(() => page.locator('.guide-dialog').getAttribute('open')).toBeNull();
  } finally {
    await page.evaluate(() => Reflect.get(window, 'tuneFixture').dispose());
    await page.close();
  }
});
