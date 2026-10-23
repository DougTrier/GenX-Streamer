import { build } from 'vite';
import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';

it('settings require explicit start, render scoped names safely and keep setup collapsed when connected', async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/sharing/settings.ts', formats: ['iife'], name: 'SharingUI' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Unexpected bundle');
  const bundle = result.output.find((item) => item.type === 'chunk');
  if (!bundle || bundle.type !== 'chunk') throw new Error('Missing bundle');
  const fixture = `
      window.starts=0;
      const channels=Array.from({length:101},(_,id)=>({id:String(id),name:id===0?'<img src=x onerror=alert(1)>':'Channel '+id}));
      const host={snapshot:()=>({generation:1,muted:false,volume:1,playback:{state:'idle',selection:null,error:null}}),subscribe:()=>()=>{},channels:()=>channels,apply:async()=>({generation:1})};
      const api={start:async()=>{window.starts++;return {address:'https://fixture.invalid',pairingSecret:'invite'}},stop:async()=>{},selectionChanged:async()=>{},publish:async()=>({revision:1,mediaId:'media'}),invite:async()=> 'next',viewers:async()=>[],revoke:async()=>{},nextCommand:async()=>null,active:async()=>true,allows:async()=>true,acknowledge:async()=>true};
      window.sharing=SharingUI.mountSharingSettings(document.getElementById('sharing'),host,{api});
    `;
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    await page.setContent('<main id="sharing"></main>');
    await page.addScriptTag({ content: bundle.code });
    await page.addScriptTag({ content: fixture });
    await page.getByText('Sharing is off', { exact: true }).waitFor();
    expect(await page.evaluate(() => (window as unknown as { starts: number }).starts)).toBe(0);
    expect(await page.locator('select option').count()).toBe(50);
    expect(await page.locator('img').count()).toBe(0);
    await page.getByLabel('Private interface IPv4 address').fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill('9443');
    await page.getByLabel('Trusted certificate file').fill('C:\\cert.pem');
    await page.getByLabel('Certificate private key file').fill('C:\\key.pem');
    await page.getByRole('button', { name: 'Start sharing' }).click();
    await page.getByText('Sharing is on', { exact: true }).waitFor();
    expect(
      await page.locator('details').evaluate((element) => (element as HTMLDetailsElement).open),
    ).toBe(false);
    await page.getByLabel('Search channels for phone scope').fill('Channel 100');
    expect(await page.locator('select option').count()).toBe(1);
    await page.getByRole('button', { name: 'Stop sharing' }).click();
    await page.getByText('Sharing is off', { exact: true }).waitFor();
    await page.evaluate(async () =>
      (window as unknown as { sharing: { dispose(): Promise<void> } }).sharing.dispose(),
    );
  } finally {
    await browser.close();
  }
}, 10000);
