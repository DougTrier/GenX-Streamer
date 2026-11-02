// Copyright 2026 Doug Trier. Licensed under the Apache License, Version 2.0.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke, isTauri: () => true }));
import { pageRect, pageView } from '../../src/platform/local-streams';

const element = {
  getBoundingClientRect: () => ({ left: 784, top: 257.5, width: 1088, height: 612 }),
} as unknown as HTMLElement;
beforeEach(() => {
  api.invoke.mockReset().mockResolvedValue({});
  vi.stubGlobal('window', { devicePixelRatio: 2, innerWidth: 1920, innerHeight: 1080 });
});
afterEach(() => vi.unstubAllGlobals());

it('Android Web viewer sends unscaled CSS bounds and a fresh viewport for every placement', async () => {
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 9; AFTKA)' });
  expect(pageRect(element)).toEqual([784, 257.5, 1088, 612]);
  await pageView.open('https://example.com/', pageRect(element));
  expect(api.invoke).toHaveBeenLastCalledWith('web_page', {
    action: 'open',
    url: 'https://example.com/',
    rect: [784, 257.5, 1088, 612],
    viewport: [1920, 1080],
  });
  window.innerWidth = 960;
  window.innerHeight = 540;
  await pageView.place([0, 0, 960, 540]);
  expect(api.invoke).toHaveBeenLastCalledWith('web_page', {
    action: 'place',
    url: null,
    rect: [0, 0, 960, 540],
    viewport: [960, 540],
  });
});

it('Windows Web viewer keeps the physical-pixel contract', async () => {
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' });
  expect(pageRect(element)).toEqual([1568, 515, 2176, 1224]);
  await pageView.place(pageRect(element));
  expect(api.invoke).toHaveBeenLastCalledWith('web_page', {
    action: 'place',
    url: null,
    rect: [1568, 515, 2176, 1224],
  });
});
