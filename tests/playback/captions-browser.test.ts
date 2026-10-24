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

import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';

import { resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { readStylesheet } from '../support/stylesheet';
let browser: Browser, code: string, css: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'fullscreen-fixture',
        resolveId(id) {
          if (id.endsWith('virtual:fullscreen')) return '\0fullscreen';
        },
        load(id) {
          if (id === '\0fullscreen')
            return `export {createShell} from ${JSON.stringify(resolve('src/ui/shell.ts'))}; export {installFullscreenPresentation} from ${JSON.stringify(resolve('src/ui/fullscreen-presentation.ts'))}; export {installCaptions,setSubtitleChoices} from ${JSON.stringify(resolve('src/ui/captions.ts'))}; export {installRemoteNavigation,createRemoteEditMode} from ${JSON.stringify(resolve('src/ui/remote-navigation.ts'))};`;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:fullscreen', formats: ['iife'], name: 'Fixture' },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing fixture bundle');
  const chunk = output.output.find((x) => x.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing fixture code');
  code = chunk.code;
  css = (
    await Promise.all(
      ['style', 'management', 'guide', 'responsive'].map((name) =>
        readStylesheet(`src/ui/${name}.css`),
      ),
    )
  ).join('\n');
  for (const asset of output.output)
    if (asset.type === 'asset' && asset.fileName.endsWith('.css'))
      css += '\n' + String(asset.source);
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

async function mount(size = { width: 640, height: 360 }) {
  const page = await browser.newPage({ viewport: size });
  await page.setContent('<div id="app"></div>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: code });
  await page.addScriptTag({
    content: `Fixture.createShell(document.querySelector('#app'));window.video=document.querySelector('#video');window.button=document.querySelector('#captions-button');window.remove=Fixture.installCaptions(window.video,window.button);window.removeRemote=Fixture.installRemoteNavigation({editMode:Fixture.createRemoteEditMode()});`,
  });
  return page;
}
it('defaults Off, enforces exactly one English caption renderer, and preserves metadata', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => {
      Reflect.get(window, 'remove')();
      const v = Reflect.get(window, 'video');
      const a = v.addTextTrack('subtitles', 'caption_6', 'eng'),
        b = v.addTextTrack('captions', 'English', 'eng'),
        m = v.addTextTrack('metadata', 'ID3', '');
      a.mode = b.mode = 'showing';
      m.mode = 'hidden';
      Reflect.set(window, 'tracks', [a, b, m]);
      Reflect.set(
        window,
        'remove',
        Reflect.get(window, 'Fixture').installCaptions(v, Reflect.get(window, 'button')),
      );
    });
    expect(
      await page.evaluate(() => Reflect.get(window, 'tracks').map((t: TextTrack) => t.mode)),
    ).toEqual(['disabled', 'disabled', 'hidden']);
    await page.locator('#captions-button').focus();
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    expect(
      await page.evaluate(() => Reflect.get(window, 'tracks').map((t: TextTrack) => t.mode)),
    ).toEqual(['disabled', 'showing', 'hidden']);
    expect(await page.locator('#captions-button').getAttribute('aria-pressed')).toBe('true');
    await page.evaluate(() => {
      Reflect.get(window, 'tracks')[0].mode = 'showing';
    });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'tracks').map((t: TextTrack) => t.mode)))
      .toEqual(['disabled', 'showing', 'hidden']);
    await page.keyboard.press('Enter');
    expect(
      await page.evaluate(() => Reflect.get(window, 'tracks').map((t: TextTrack) => t.mode)),
    ).toEqual(['disabled', 'disabled', 'hidden']);
  } finally {
    await page.evaluate(() => {
      Reflect.get(window, 'remove')();
      Reflect.get(window, 'removeRemote')();
    });
    await page.close();
  }
});
it('late track availability remains Off, active removal falls back, and disposal fences late events', async () => {
  const page = await mount();
  try {
    expect(await page.locator('#captions-button').isDisabled()).toBe(true);
    await page.evaluate(() => {
      const v = Reflect.get(window, 'video');
      const a = v.addTextTrack('subtitles', 'English', 'en');
      Reflect.set(window, 'fallback', a);
      const el = document.createElement('track');
      el.kind = 'captions';
      el.label = 'English CC';
      el.srclang = 'eng';
      v.append(el);
      Reflect.set(window, 'element', el);
    });
    await expect.poll(() => page.locator('#captions-button').isDisabled()).toBe(false);
    expect(await page.locator('#captions-button').getAttribute('aria-pressed')).toBe('false');
    await page.locator('#captions-button').click();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'element').track.mode))
      .toBe('showing');
    await page.evaluate(() => Reflect.get(window, 'element').remove());
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'fallback').mode))
      .toBe('showing');
    await page.evaluate(() => Reflect.get(window, 'remove')());
    expect(await page.evaluate(() => Reflect.get(window, 'fallback').mode)).toBe('disabled');
    await page.evaluate(async () => {
      const video = Reflect.get(window, 'video') as HTMLVideoElement;
      const added = new Promise<void>((resolve) =>
        video.textTracks.addEventListener('addtrack', () => resolve(), { once: true }),
      );
      Reflect.get(window, 'fallback').mode = 'showing';
      video.addTextTrack('captions', 'Late', 'eng');
      await added;
    });
    expect(await page.evaluate(() => Reflect.get(window, 'fallback').mode)).toBe('showing');
    expect(await page.locator('#captions-button').getAttribute('aria-pressed')).toBe('false');
  } finally {
    await page.evaluate(() => {
      Reflect.get(window, 'remove')();
      Reflect.get(window, 'removeRemote')();
    });
    await page.close();
  }
});
for (const size of [
  { width: 320, height: 480 },
  { width: 640, height: 360 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
]) {
  it(`CC target and dock remain inside normal/fullscreen ${size.width}x${size.height}`, async () => {
    const page = await mount(size);
    try {
      await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>('#app')!;
        root.dataset.compactView = 'watch';
        Reflect.set(
          window,
          'presentation',
          Reflect.get(window, 'Fixture').installFullscreenPresentation(root),
        );
        Reflect.get(window, 'video').addTextTrack('captions', 'English', 'eng');
        document.querySelector<HTMLButtonElement>('#pause-button')!.disabled = false;
      });
      for (const active of [false, true]) {
        await page.evaluate((active) => Reflect.get(window, 'presentation').set(active), active);
        expect(await page.locator('#expand-button').isVisible()).toBe(!active);
        for (const id of ['captions-button', 'pause-button', 'mute-button', 'fullscreen-button']) {
          const r = await page.locator('#' + id).boundingBox();
          expect(r!.height).toBeGreaterThanOrEqual(44);
          if (id === 'captions-button') expect(r!.width).toBeGreaterThanOrEqual(44);
          expect(r!.x).toBeGreaterThanOrEqual(0);
          expect(r!.y).toBeGreaterThanOrEqual(0);
          expect(r!.x + r!.width).toBeLessThanOrEqual(size.width);
          expect(r!.y + r!.height).toBeLessThanOrEqual(size.height);
          expect(
            await page.locator('#' + id).evaluate((el) => {
              const r = el.getBoundingClientRect();
              return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
            }),
          ).toBe(true);
        }
      }
    } finally {
      await page.evaluate(() => {
        Reflect.get(window, 'presentation')?.dispose();
        Reflect.get(window, 'remove')();
        Reflect.get(window, 'removeRemote')();
      });
      await page.close();
    }
  });
}

it('new session resets On without reviving old captions, and reused native tracks accept new cues', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => {
      const video = Reflect.get(window, 'video') as HTMLVideoElement;
      const captions = video.addTextTrack('captions', 'English', 'eng');
      captions.addCue(new VTTCue(0, 60, 'OLD CHANNEL'));
      Reflect.set(window, 'sessionTrack', captions);
      const metadata = video.addTextTrack('metadata', 'ID3', '');
      metadata.mode = 'hidden';
      metadata.addCue(new VTTCue(0, 60, 'provider metadata'));
      Reflect.set(window, 'sessionMetadata', metadata);
    });
    await expect.poll(() => page.locator('#captions-button').isDisabled()).toBe(false);
    await page.locator('#captions-button').click();
    expect(await page.evaluate(() => Reflect.get(window, 'sessionTrack').mode)).toBe('showing');
    await page.evaluate(() => {
      Reflect.get(window, 'video').dispatchEvent(new Event('caption-session-reset'));
    });
    expect(await page.locator('#captions-button').getAttribute('aria-pressed')).toBe('false');
    expect(await page.evaluate(() => Reflect.get(window, 'sessionTrack').mode)).toBe('disabled');
    // Model the engine's independent cue cleanup; the CC module never copies or removes cues.
    await page.evaluate(() => {
      const track = Reflect.get(window, 'sessionTrack') as TextTrack;
      track.mode = 'hidden';
      for (const cue of [...(track.cues ?? [])]) track.removeCue(cue);
      track.mode = 'disabled';
      track.addCue(new VTTCue(0, 60, 'NEW CHANNEL'));
    });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'sessionTrack').mode))
      .toBe('disabled');
    await page.locator('#captions-button').click();
    expect(
      await page.evaluate(() => {
        const track = Reflect.get(window, 'sessionTrack') as TextTrack;
        return {
          mode: track.mode,
          texts: [...(track.cues ?? [])].map((cue) => (cue as VTTCue).text),
          metadataMode: Reflect.get(window, 'sessionMetadata').mode,
          metadataCues: Reflect.get(window, 'sessionMetadata').cues.length,
        };
      }),
    ).toEqual({ mode: 'showing', texts: ['NEW CHANNEL'], metadataMode: 'hidden', metadataCues: 1 });
  } finally {
    await page.evaluate(() => {
      Reflect.get(window, 'remove')();
      Reflect.get(window, 'removeRemote')();
    });
    await page.close();
  }
});

it('embedded subtitles from the native player: each CC press steps to the next language, then off', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => {
      const tracks = [
        { id: '2:0', label: '', language: 'en', selected: false, supported: true },
        { id: '2:1', label: 'Forced', language: 'es', selected: false, supported: true },
        { id: '2:2', label: '', language: 'de', selected: false, supported: false },
      ];
      const choices: string[] = [];
      Reflect.set(window, 'choices', choices);
      const video = Reflect.get(window, 'video') as HTMLVideoElement;
      const publish = (selected: string | null) =>
        Reflect.get(window, 'Fixture').setSubtitleChoices(video, {
          tracks: tracks.map((track) => ({ ...track, selected: track.id === selected })),
          select: (id: string | null) => {
            choices.push(id ?? 'off');
            publish(id); // the native player answers with its new state
          },
        });
      publish(null);
    });
    const button = page.locator('#captions-button');
    await expect.poll(() => button.getAttribute('aria-label')).toBe('Subtitles off');
    expect(await button.isDisabled()).toBe(false);
    await button.click();
    expect(await button.getAttribute('aria-label')).toBe('Subtitles: English');
    expect(await button.getAttribute('aria-pressed')).toBe('true');
    await button.click();
    expect(await button.getAttribute('aria-label')).toBe('Subtitles: Forced');
    // An unsupported track is skipped; after the last usable one, subtitles go off.
    await button.click();
    expect(await button.getAttribute('aria-label')).toBe('Subtitles off');
    expect(await page.evaluate(() => Reflect.get(window, 'choices'))).toEqual([
      '2:0',
      '2:1',
      'off',
    ]);
    // When the native player stops, the CC button returns to the web player's captions.
    await page.evaluate(() =>
      Reflect.get(window, 'Fixture').setSubtitleChoices(Reflect.get(window, 'video'), null),
    );
    expect(await button.getAttribute('aria-label')).toBe('Closed captions');
    expect(await button.isDisabled()).toBe(true);
  } finally {
    await page.close();
  }
});
