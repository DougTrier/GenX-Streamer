import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'tv-surface-audit.spec.ts',
  workers: 1,
  timeout: 30000,
  reporter: [
    ['list'],
    ['json', { outputFile: '../../artifacts/tv-navigation/2026-10-15/tv-surface-audit.json' }],
  ],
  outputDir: '../../artifacts/tests/tv-surface-audit',
  use: {
    viewport: { width: 960, height: 540 },
    baseURL: 'http://127.0.0.1:1421',
    browserName: 'chromium',
    launchOptions: { executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/ui-source-server.mjs',
    cwd: '../..',
    url: 'http://127.0.0.1:1421',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
