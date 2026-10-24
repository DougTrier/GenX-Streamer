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
