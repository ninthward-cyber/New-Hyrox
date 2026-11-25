'use strict';

// Playwright config lives under tests/ so the app repo needs no package.json.
// Run via the tools install: see tests/P2-RUN.md

const fs = require('fs');
const path = require('path');

const TOOLS_PW = '/workspace/hyrox-p2/tools/node_modules/@playwright/test';
if (fs.existsSync(TOOLS_PW)) {
  module.paths.unshift('/workspace/hyrox-p2/tools/node_modules');
}

const { defineConfig, devices } = require('@playwright/test');

const appRoot = path.resolve(process.env.HYROX_APP_ROOT || path.join(__dirname, '..'));
const port = Number(process.env.HYROX_APP_PORT || 4173);
const iphone13 = devices['iPhone 13'];
const CHROME_PATH = '/usr/bin/google-chrome';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const mobileViewport = {
  viewport: { width: 390, height: 844 },
  screen: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  timezoneId: 'Asia/Qatar',
  locale: 'en-US',
};

module.exports = defineConfig({
  testDir: path.join(__dirname, 'e2e'),
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 8000 },
  outputDir: path.join(__dirname, 'out/playwright-results'),
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(__dirname, 'out/playwright-report'), open: 'never' }],
  ],
  use: {
    ...mobileViewport,
    baseURL: 'http://127.0.0.1:' + port + '/',
    acceptDownloads: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'iphone-webkit',
      use: {
        ...iphone13,
        ...mobileViewport,
        browserName: 'webkit',
        userAgent: iphone13.userAgent,
      },
    },
    {
      // Chromium substitute, not Safari. Uses the installed system Chrome.
      name: 'chromium-substitute',
      use: {
        ...mobileViewport,
        browserName: 'chromium',
        userAgent: IPHONE_UA,
        launchOptions: {
          executablePath: CHROME_PATH,
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        },
      },
    },
  ],
  webServer: {
    command: process.execPath + ' ' + JSON.stringify(path.join(__dirname, 'static-server.js')),
    url: 'http://127.0.0.1:' + port + '/',
    reuseExistingServer: false,
    timeout: 15000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      HYROX_APP_ROOT: appRoot,
      HYROX_APP_PORT: String(port),
    },
  },
});
