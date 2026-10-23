import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'genxtra-dock-layout.spec.ts',
  workers: 1,
  timeout: 30000,
  reporter: [['list'], ['json', { outputFile: 'artifacts/tests/vod-dock-layout.json' }]],
  outputDir: '../../artifacts/tests/vod-dock-layout',
  use: {
    baseURL: 'http://127.0.0.1:1421',
    browserName: 'chromium',
    launchOptions: { executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/ui-source-server.mjs',
    cwd: '../..',
    url: 'http://127.0.0.1:1421',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
