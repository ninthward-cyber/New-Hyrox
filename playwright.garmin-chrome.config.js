'use strict';
// Chrome mobile emulation, NOT WebKit and NOT iPhone Safari.
const path = require('path');
const { defineConfig, devices } = require('@playwright/test');
const port = Number(process.env.HYROX_APP_PORT || 4177);
const chrome = process.env.HYROX_CHROME || '/usr/bin/google-chrome';
function mobile(width, height) {
  return {
    viewport: { width, height }, isMobile: true, hasTouch: true,
    timezoneId: 'Asia/Qatar', locale: 'en-US',
    browserName: 'chromium',
    launchOptions: { executablePath: chrome, args: ['--no-sandbox', '--disable-dev-shm-usage'] }
  };
}
module.exports = defineConfig({
  testDir: path.join(__dirname, 'e2e'),
  testMatch: ['garmin-preview-viewport.spec.js', 'garmin-flag-wiring.spec.js', 't118u-zero-steps-ui.spec.js', 't124u-held-date-ui.spec.js', 'f1-food-quantity.spec.js'],
  workers: 1,
  timeout: 45000,
  expect: { timeout: 8000 },
  outputDir: '/workspace/hyrox-garmin-build/qa/regression/playwright-results',
  reporter: [['list'], ['json', { outputFile: '/workspace/hyrox-garmin-build/qa/regression/playwright-report.json' }]],
  use: { baseURL: 'http://127.0.0.1:' + port + '/', acceptDownloads: true },
  projects: [
    { name: 'chrome-emulation-320-not-safari', use: mobile(320, 568) },
    { name: 'chrome-emulation-390-not-safari', use: mobile(390, 844) }
  ],
  webServer: {
    command: process.execPath + ' ' + JSON.stringify(path.join(__dirname, 'static-server.js')),
    url: 'http://127.0.0.1:' + port + '/',
    reuseExistingServer: false,
    timeout: 20000,
    env: { HYROX_APP_ROOT: path.resolve(__dirname, '..'), HYROX_APP_PORT: String(port) }
  }
});
