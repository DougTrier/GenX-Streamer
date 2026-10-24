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
const componentSuites = [
  '**/configured-import-entry.spec.ts',
  '**/background-collection.spec.ts',
  '**/data-transfer-cleanup.spec.ts',
  '**/casting-confirmation.spec.ts',
  '**/casting-multi-tv.spec.ts',
  '**/storage-recovery.spec.ts',
  '**/website-discovery.spec.ts',
  '**/text-resize-layout.spec.ts',
  '**/selected-guide-layout.spec.ts',
  '**/selected-guide-action-layout.spec.ts',
  '**/about-support.spec.ts',
  '**/exit-support.spec.ts',
  '**/genxtra-dock-layout.spec.ts',
  '**/archive-status-navigation*.spec.ts',
  '**/archive-resume.spec.ts',
  '**/tv-surface-audit.spec.ts',
  '**/library-switcher.spec.ts',
  '**/paid-guide.spec.ts',
  '**/vod-cinema.spec.ts',
  '**/local-streams.spec.ts',
  '**/first-scan-hint.spec.ts',
  '**/station-video-only.spec.ts',
  '**/hostile-pages.spec.ts',
  '**/live-replay.spec.ts',
  '**/phone-panel-layout.spec.ts',
];
// Source-only invocations need no bundled build; default/full runs retain both servers.
const selectedProjects = process.argv.flatMap((argument, index) =>
  argument.startsWith('--project=')
    ? [argument.slice('--project='.length)]
    : argument === '--project' && process.argv[index + 1]
      ? [process.argv[index + 1]!]
      : [],
);
const sourceOnly =
  selectedProjects.length > 0 &&
  selectedProjects.every((project) => project === 'source-components');
export default defineConfig({
  testDir: './tests/ui',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  workers: 4,
  retries: 0,
  timeout: 30000,
  reporter: [['list'], ['json', { outputFile: 'artifacts/tests/ui.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:1420',
    browserName: 'chromium',
    launchOptions: { executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: 'artifacts/tests/ui',
  projects: [
    { name: 'bundled-application', testIgnore: componentSuites },
    {
      name: 'source-components',
      testMatch: componentSuites,
      use: { baseURL: 'http://127.0.0.1:1421' },
    },
  ],
  webServer: [
    ...(!sourceOnly
      ? [
          {
            // Full application checks use fresh bundles, matching native package inputs.
            command:
              'npm run build && node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 1420 --strictPort',
            url: 'http://127.0.0.1:1420',
            reuseExistingServer: false,
            timeout: 30000,
          },
        ]
      : []),
    {
      // Isolated fixtures intentionally import source modules; retain every case.
      command: 'node scripts/ui-source-server.mjs',
      url: 'http://127.0.0.1:1421',
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
