'use strict';
// Local fallback when Playwright's bundled browsers cannot be downloaded: drives an already
// installed Chrome/Chromium in mobile emulation. This is NOT WebKit and NOT iPhone Safari.
// Usage:
//   HYROX_CHROME=/usr/bin/google-chrome NODE_PATH=<dir with @playwright/test>/node_modules \
//     npx playwright test -c tests/playwright.local-chrome.config.js
const path = require('path');
const { defineConfig } = require('@playwright/test');

const port = Number(process.env.HYROX_APP_PORT || 4173);
const mobile = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Qatar', locale: 'en-US' };

module.exports = defineConfig({
  testDir: path.join(__dirname, 'e2e'),
  testMatch: '**/*.spec.js',
  workers: 1,
  timeout: 30000,
  expect: { timeout: 8000 },
  outputDir: path.join(__dirname, 'out/playwright-results'),
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:' + port + '/', acceptDownloads: true },
  projects: [
    { name: 'installed-chrome-mobile', use: { ...mobile, browserName: 'chromium',
      launchOptions: { executablePath: process.env.HYROX_CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] } } },
  ],
  webServer: {
    command: process.execPath + ' ' + JSON.stringify(path.join(__dirname, 'static-server.js')),
    url: 'http://127.0.0.1:' + port + '/',
    reuseExistingServer: false,
    timeout: 15000,
    env: { HYROX_APP_ROOT: path.resolve(__dirname, '..'), HYROX_APP_PORT: String(port) },
  },
});
