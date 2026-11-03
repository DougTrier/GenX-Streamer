/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { build } from 'vite';
import { chromium, type Page } from '@playwright/test';
import { readStylesheet } from './stylesheet';

export interface PhoneFixtureOptions {
  deviceKind?: 'personal' | 'tv';
  playing?: boolean;
  ordinary?: boolean;
  rowActions?: boolean;
}

// Real component owners and shipping styles; all catalogue/media records below
// are deterministic local mocks. No decoder, account authority or device claim.
const MODULES = [
  'ui/shell/shell',
  'ui/shell/viewport',
  'ui/shell/remote-navigation',
  'ui/channels/channel-browser',
  'ui/channels/category-menu',
  'ui/channels/geography-controls',
  'ui/player/stream-buffer-controls',
  'ui/player/video-quality',
  'ui/player/vod-dock',
  'ui/scan/local-streams',
  'ui/settings/settings-navigation',
  'application/guide/guide-views',
  'application/shell/page-controller',
  'application/shell/page-state',
  'ui/genxtra/archive-search',
  'ui/accounts/account-vod',
  'ui/player/fullscreen-presentation',
  'application/catalog/live-tab-browse-state',
  'application/catalog/clear-browse-filters',
];

const MOUNT = `
 const p=window.Portrait, e=id=>document.getElementById(id), app=e('app');p.createShell(app);app.dataset.deviceKind=options.deviceKind||'personal';app.dataset.ready='true';app.dataset.contentLibrary='live';app.dataset.playerIdle='true';app.dataset.compactView='watch';
 const face=new FontFace('GenX UI',\`url(data:font/ttf;base64,\${font})\`,{weight:'100 900'});document.fonts.add(await face.load());await document.fonts.ready;
 const channels=Array.from({length:30},(_,i)=>({id:'fixture-'+i,sourceId:'catalog',name:options.ordinary?'Public Sports Channel '+i:i===0?'ACC Digital Network (1080p)':i===1?'Syracuse Football: Boston College Eagles at Syracuse Orange — Complete Game Replay':'Public Sports Channel '+i,category:i<20?'Sports':'News',originalCategory:'US | Sports',geography:{country:'US'},url:'https://fixture.invalid/no-media-'+i}));
 let selected=null, playing=false;let archiveUi=null;let currentSurface='free';const tabStates=p.createLiveTabBrowseState();const actions=[];
 const cb=new p.ChannelBrowser(e('channel-list'),id=>{selected=channels.find(c=>c.id===id);actions.push({select:id});setPlaying(true);},undefined,undefined,{...(options.rowActions?{onManage:()=>{},onFavorite:()=>{}}:{}),sportsControls:e('sports-filters'),logos:{get:()=> 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="60" height="40"%3E%3Crect width="60" height="40" fill="teal"/%3E%3C/svg%3E',visible:()=>{},rejected:()=>{}}});
 const now=Date.now();const programmes=channels.map((c,i)=>({catalogSourceId:c.sourceId,appChannelId:c.id,title:options.ordinary?'Live NFL coverage':i===0?'Boston College Eagles at Syracuse Orange — College Football Replay':i===1?'Chicago Bears at Buffalo Bills — NFL Football':i===2?'Detroit Lions at Green Bay Packers — NFL Football':'Regional sports programme '+i,startMs:now-1800000,stopMs:now+5400000,categories:[{text:i===1||i===2?'NFL':'College Football'}]}));
 function update(){cb.update(channels,[],selected?.id??null);cb.setNowPlaying(programmes);}
 function choose(filter){for(const b of app.querySelectorAll('[data-filter]'))b.setAttribute('aria-pressed',String(b.dataset.filter===filter));e('compact-filter').value=filter;cb.setFilter(filter);}
 e('compact-filter').onchange=()=>choose(e('compact-filter').value);for(const b of app.querySelectorAll('[data-filter]'))b.onclick=()=>choose(b.dataset.filter);e('search').oninput=()=>{cb.search(e('search').value);e('clear-search').hidden=!e('search').value;};e('clear-search').onclick=()=>{e('search').value='';e('search').dispatchEvent(new Event('input'));};
 const geo=p.mountGeographyControls(e('geography-controls'),{channels:()=>channels,apply:({filter,sort,registry})=>cb.setGeography(filter,sort,registry)});geo.update();const locationOff=p.mountLocationDialog(e('geography-controls'));const menu=p.installCategoryMenu(app);
 const local=p.mountLocalStreams({showLive:async()=>{},playRadio:async()=>{},stopPlayback:async()=>{},run:()=>{}},{after:e('genxtra-button'),leave:[e('live-tv-button'),e('paid-tv-button'),e('genxtra-button')],list:e('channel-list'),stage:e('screen')});
 let playbackSelection=null;
 const buffer=p.mountStreamBufferControls(app,{current:()=>({selection:playbackSelection,state:playing?'playing':'idle',generation:1,telemetry:playing?{capability:'controlled',mode:'manual',targetSeconds:4,bufferedSeconds:8,incomingBitsPerSecond:1500000}:null}),key:async()=> 'fixture',save:async()=>{},apply:async()=>true,notice:()=>{}});
 const playbackPresentation=p.installVODDock(app);
 function setPlaying(value,onDemand=false){playing=value;if(value&&!selected)selected=channels[0];playbackSelection=value?{...selected,...(onDemand?{playMode:'on-demand'}:{})}:null;playbackPresentation.render(playbackSelection?playbackSelection.playMode==='on-demand':currentSurface==='genxtra');app.dataset.playerIdle=String(!value);e('player-overlay').hidden=value;e('watch-title').textContent=value?selected.name:'Make yourself comfortable.';e('playback-status').textContent=value?'Playing':'Ready when you are';for(const id of ['pause-button','captions-button','replay-button','vod-stop'])e(id).disabled=!value;e('replay-button').hidden=!value;e('vod-stop').hidden=!value;buffer.render();update();}
 p.installVideoQuality(e('video'),e('video-quality'),{read:()=>playing?{auto:true,currentLevel:1,availableLevelCount:2,levelsTruncated:false,availableLevels:[{index:0,height:720,width:1280,bitrate:3000000},{index:1,height:1080,width:1920,bitrate:8000000}]}:null,set:()=>true});
 const settingsOff=p.mountSettingsNavigation(e('settings-dialog'));e('settings-button').onclick=()=>e('settings-dialog').showModal();for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>e(b.dataset.close).close();
 e('compact-view').onchange=()=>app.dataset.compactView=e('compact-view').value;
 const fullscreen=p.installFullscreenPresentation(app);
 const offViewport=p.installViewport(app,{clearFilters:()=>p.clearActiveBrowseFilters({applicationClosing:false,library,element:e,browser:cb,chooseCategory:choose,geographyControls:geo})}),offRemote=p.installRemoteNavigation({editMode:p.createRemoteEditMode()});
 const mappings=channels.map(c=>({catalogSourceId:'catalog',appChannelId:c.id,guideSourceId:'guide',xmltvChannelId:'xml-'+c.id}));
 const host={presentation:'page',enableTimeline:true,selectedChannel:()=>selected??channels[0],channels:()=>channels,now:()=>now,formatTime:ms=>new Date(ms).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}),sources:async()=>[{id:'guide',name:'Offline saved schedule',location:'https://fixture.invalid/never-read',kind:'url',allowHttp:false,revision:1,updatedMs:now}],mappings:async()=>mappings,query:async q=>({programs:programmes.filter(c=>q.appChannelIds.includes(c.appChannelId)).map(c=>({...mappings.find(m=>m.appChannelId===c.appChannelId),...c,description:'Offline cached schedule fixture',ordinal:0})),nextCursor:null,sourceRevision:1,databaseRevision:1}),listedChannels:async()=>({catalogRevision:'1',databaseRevision:1,viewRevision:'1',groupingPolicy:'exact-ordered-endpoints-policy-v2',channels:mappings.map(m=>({...m,sourceRevision:1,filterMask:4}))}),coverage:async()=>({publishedRevision:1,updatedMs:now,startMs:now-3600000,endMs:now+604800000}),guideChannels:async()=>({channels:channels.map(c=>({id:'xml-'+c.id,names:[c.name]})),nextCursor:null,sourceRevision:1}),watch:async c=>{selected=c;setPlaying(true);},catalogRevision:()=> '1',preview:async()=>{throw Error('not allowed')},commitPreview:async()=>{throw Error('not allowed')},discardPreview:async()=>{},removeSource:async()=>{},setMapping:async()=>{}};
 const state=p.createPageState(),library={contentLibrary:'live',archiveStorageEpoch:0,liveBrowseSuspended:false},accountBrowser={selectedAccount:null,preferenceScope:()=>null},jobs=[];let controller;
 const views=p.createGuideViews({element:e,pageState:state,library,accountBrowser,applicationClosing:false,nativeViewingForeground:true,browser:cb,persistedCatalogRevision:'1',primaryHost:e('primary-view-host'),guideHost:host,guideController:{},automaticGuides:{},wakeDailyRefresh:()=>{},selectAccountPlayback:async()=>{},playbackAction:work=>jobs.push(work),switchPrimaryPage:page=>controller.switchPrimaryPage(page),presentPrimaryPage:page=>controller.presentPrimaryPage(page)});
 controller=p.createPageController({element:e,pageState:state,library,accountBrowser,applicationClosing:false,nativeViewingForeground:true,guide:views.guide,paidGuide:views.paidGuide,archiveDiscovery:{suspend:async()=>{}},libraryQueries:{live:'',genxtra:''}});
 const vodCategories=[{id:'movies',name:'Mock movies'}];
 const vod=p.mountAccountVod({play:async()=>{setPlaying(true,true);},run:work=>jobs.push(work),changed:()=>window.dispatchEvent(new Event('resize'))},{row:app.querySelector('.sidehead'),list:e('channel-list'),stage:e('screen')},{list:async(_account,_section,id)=>id===null?{categories:vodCategories,items:[],skipped:0}:{categories:[],items:Array.from({length:6},(_,i)=>({id:String(i+1),name:'A complete readable Paid movie title '+(i+1),year:'2026',rating:'7.5'})),skipped:0},episodes:async()=>[],details:async()=>({plot:'A local mocked movie description for layout only.',genre:'Drama',durationSeconds:5400})});
 e('guide-button').onclick=()=>jobs.push(controller.switchPrimaryPage('guide'));
 async function setSurface(surface){
 await controller.switchPrimaryPage('watch'); if(archiveUi) await archiveUi.suspend();
 if(currentSurface==='free'||currentSurface==='paid')tabStates.capture(currentSurface,cb.getBrowseState());
 if(surface==='free'||surface==='paid'){const saved=tabStates.restore(surface)||{filter:'all',query:'',sportsFacet:{},geography:{},sort:'source'};cb.restoreBrowseState(saved);e('search').value=saved.query;e('clear-search').hidden=!saved.query;choose(saved.filter);geo.restore({filter:saved.geography,sort:saved.sort});}
 currentSurface=surface;
 vod.present(surface==='paid'?{id:'a'.repeat(32),revision:'1'}:null);
 library.contentLibrary=surface==='genxtra'?'genxtra':'live';app.dataset.contentLibrary=library.contentLibrary;app.dataset.accountScope=surface==='paid'?'mock-paid':'';
 e('channel-list').hidden=surface==='genxtra';e('genxtra-library').hidden=surface!=='genxtra';e('genxtra-browse-filters').hidden=surface!=='genxtra';
 for(const [id,active] of [['live-tv-button',surface==='free'],['paid-tv-button',surface==='paid'],['genxtra-button',surface==='genxtra']])e(id).setAttribute('aria-pressed',String(active));
 if(surface==='genxtra'){
  if(!archiveUi)archiveUi=p.mountArchiveSearch(e('genxtra-library'),{input:e('search'),readyScope:()=> 'phone-offline',detailsContainer:e('archive-details'),onSelect:async()=>{setPlaying(true,true);},catalog:{query:async()=>({schemaVersion:1,revision:'1',offset:0,totalCount:6,more:false,items:Array.from({length:6},(_,i)=>({titleRef:(i+1).toString(16).padStart(64,'0'),itemId:'mock-title-'+i,title:'A complete and readable saved programme title '+(i+1),kind:'tv',contentType:'tv',contentTypeProvenance:'provider-item',releaseYear:2020,curated:false,titleProvenance:'provider-item',fileCount:1,durationSeconds:100,rights:null,rank:i+1,quality:'metadata-h264',observedMs:1}))}),files:async()=>({schemaVersion:1,revision:'1',titleRef:'1'.padStart(64,'0'),offset:0,totalCount:1,more:false,files:[{fileRef:'a'.repeat(64),title:'Episode 1',fileName:'episode.mp4',itemId:'mock-title-0',format:'h.264',durationSeconds:100,sizeBytes:'1024',availability:'unverified',observedMs:1}]})}});
  await archiveUi.resume();
 }else update();
 playbackPresentation.render(playbackSelection?playbackSelection.playMode==='on-demand':surface==='genxtra');window.dispatchEvent(new Event('resize'));
}
for(const [id,surface] of [['live-tv-button','free'],['paid-tv-button','paid'],['genxtra-button','genxtra']])e(id).onclick=()=>jobs.push(setSurface(surface));
e('vod-stop').onclick=()=>setPlaying(false);
update();playbackPresentation.render(false);buffer.render();window.fixture={cb,choose,setPlaying,setSurface,vod,fullscreen,views,controller,jobs,actions,settle:async()=>{await Promise.allSettled(jobs);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));},select:id=>{selected=channels.find(c=>c.id===id);setPlaying(true);},dispose:async()=>{fullscreen.dispose();playbackPresentation.dispose();vod.dispose();if(archiveUi)await archiveUi.dispose();offViewport();offRemote();settingsOff();locationOff();menu?.dispose();geo.dispose();cb.dispose();await local.dispose?.();await buffer.dispose();await Promise.allSettled(jobs);await views.guide.dispose();await views.paidGuide.dispose();await views.guideChannelLogos.dispose();}};

if(options.playing)setPlaying(true);
await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
`;

export async function preparePhoneFixture() {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'phone-surface-offline',
        enforce: 'pre',
        resolveId(id) {
          if (id.endsWith('virtual:phone-surface')) return '\0phone-surface';
          if (/[/\\]platform[/\\]account-guide(?:\.ts)?$/.test(id)) return '\0paid-inert';
        },
        load(id) {
          if (id === '\0paid-inert') return 'export const createAccountGuide=()=>({});';
          if (id === '\0phone-surface')
            return MODULES.map(
              (m) => `export * from ${JSON.stringify(resolve('src/' + m + '.ts'))};`,
            ).join('\n');
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:phone-surface', name: 'Portrait', formats: ['iife'] },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing phone fixture output');
  const chunk = output.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing phone fixture script');
  const code = chunk.code;
  const assets = new Map(
    output.output
      .filter((item) => item.type === 'asset')
      .map((item) => [item.fileName, item.source]),
  );
  const main = await readFile('src/main.ts', 'utf8');
  const cssImports = [...main.matchAll(/^import '(\.\/ui\/[^']+\.css)';/gm)].map((m) => m[1]);
  let css = output.output
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => (item.type === 'asset' ? String(item.source) : ''))
    .join('\n');
  for (const path of cssImports) css += '\n' + (await readStylesheet(resolve('src', path)));
  const font = (
    await readFile('assets/fonts/roboto-condensed/RobotoCondensed-Variable.ttf')
  ).toString('base64');
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  async function mountPage(
    width: number,
    height: number,
    options: PhoneFixtureOptions = {},
  ): Promise<Page> {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
      isMobile: options.deviceKind !== 'tv',
      hasTouch: options.deviceKind !== 'tv',
    });
    page.setDefaultTimeout(5000);
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'portrait.fixture') return route.abort();
      if (url.pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="app"></main></body></html>',
        });
      let key = decodeURIComponent(url.pathname).slice(1);
      let data = assets.get(key) ?? assets.get(key.replace(/^assets\//, ''));
      if (!data && key.includes('assets/')) {
        key = key.slice(key.indexOf('assets/'));
        const target = resolve(key);
        const assetRoot = resolve('assets');
        if (target.startsWith(assetRoot + '\\') || target.startsWith(assetRoot + '/')) {
          try {
            data = await readFile(target);
          } catch {
            /* Unknown fixture asset stays 404. */
          }
        }
      }
      if (!data) return route.fulfill({ status: 404, body: '' });
      const contentType =
        (
          {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.svg': 'image/svg+xml',
            '.ttf': 'font/ttf',
            '.css': 'text/css',
          } as Record<string, string>
        )[extname(key)] ?? 'application/octet-stream';
      return route.fulfill({
        contentType,
        body: typeof data === 'string' ? data : Buffer.from(data),
      });
    });
    await page.goto('http://portrait.fixture/');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code });
    await page.evaluate(
      `(async ({font, options}) => {${MOUNT}})(${JSON.stringify({ font, options })})`,
    );
    return page;
  }
  return { mountPage, close: () => browser.close(), cssImports };
}

export async function closePhonePage(page: Page) {
  if (page.isClosed()) return;
  await page.evaluate(async () => {
    await Reflect.get(window, 'fixture')?.dispose();
  });
  await page.close();
}
