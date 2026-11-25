'use strict';
// Chrome mobile emulation, not Safari/WebKit, and not a physical iPhone.
// R8 t111u: real wiring path, flag default off. Flag-on uses the test-only
// boot(root, { enabled: true }) seam (Meron N-1). Product isEnabled and
// FEATURE_GARMIN_IMPORT stay false. Talks only to a mocked same-origin stub
// whose body is the exact shape handleProxy returns (Meron N-2). No outside
// request. Synthetic data only.
const { test, expect } = require('@playwright/test');
const { makeProxyFetchBody, DEFAULT_DAILY_DOC } = require('../garmin-proxy-shaped-body');

function isOutside(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'data:' || u.protocol === 'blob:') return false;
    return u.hostname !== '127.0.0.1' && u.hostname !== 'localhost';
  } catch (e) { return true; }
}

async function enableGarminImportForTest(page) {
  await page.evaluate(() => {
    const G = window.HyroxGarminImport;
    const root = document.getElementById('garmin-import-root');
    G.boot(root, { enabled: true });
  });
}

const STUB_FETCH = makeProxyFetchBody({ dataset: 'daily', dailyDoc: DEFAULT_DAILY_DOC });
const STUB_WEIGHT_ONLY = {
  ok: true,
  provider: 'garmin-personal-api',
  range: { startDate: '2026-11-22', endDate: '2026-11-24', inclusiveDays: 3 },
  timezone: { accepted: true, value: 'Asia/Qatar' },
  complete: { weight: true },
  rows: { weight: [{ date: '2026-11-22', kg: 97.4, timestampGMT: Date.parse('2026-11-22T06:00:00.000Z') }] },
  skipped: []
};
const STUB_EMPTY = { ok: true, code: 'STUB', datasets: [] };

test('Chrome emulation, not Safari — Garmin flag default off: module loaded, no flag-on UI, isEnabled false, product hook inert', async ({ page }) => {
  const outside = [];
  page.on('request', (req) => { if (isOutside(req.url())) outside.push(req.url()); });
  await page.addInitScript(() => { window.__HYROX_GARMIN_IMPORT_TEST__ = true; });
  await page.goto('./');
  const state = await page.evaluate(() => {
    const G = window.HyroxGarminImport;
    const root = document.querySelector('[data-testid="garmin-import-root"]');
    const flagOn = document.querySelector('[data-testid="garmin-import-flag-on"]');
    return {
      present: !!G,
      feature: G && G.FEATURE_GARMIN_IMPORT,
      enabled: G && G.isEnabled(),
      proxy: G && G.proxyPath(),
      rootHidden: !root || root.hidden !== false,
      flagOn: !!flagOn,
      hookInSource: !!(G && G.isEnabled.toString().includes('__HYROX_GARMIN_IMPORT_TEST__'))
    };
  });
  expect(state.present, 'HyroxGarminImport global').toBeTruthy();
  expect(state.feature).toBe(false);
  expect(state.enabled).toBe(false);
  expect(state.proxy).toBe('/.netlify/functions/garmin-personal-proxy');
  expect(state.rootHidden).toBeTruthy();
  expect(state.flagOn).toBeFalsy();
  expect(state.hookInSource).toBeFalsy();
  expect(outside, 'no outside request on flag-off boot').toEqual([]);
});

test('Chrome emulation, not Safari — Garmin flag-on via test-only boot seam: mocked same-origin proxy, no outside request', async ({ page }) => {
  const outside = [];
  const proxyHits = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === '/.netlify/functions/garmin-personal-proxy') {
      proxyHits.push({ method: req.method(), url: req.url() });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, code: 'STUB', datasets: [] })
      });
    }
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
      return route.continue();
    }
    outside.push(req.url());
    return route.abort();
  });
  await page.goto('./');
  await enableGarminImportForTest(page);
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('garmin-import-flag-on')).toBeVisible();
  await expect(page.getByTestId('garmin-import-fetch')).toBeVisible();
  const call = await page.evaluate(async () => {
    const r = await window.HyroxGarminImport.requestGarmin({ op: 'fetch', startDate: '2026-11-16', endDate: '2026-11-16' });
    const text = await r.text();
    return { status: r.status, ok: r.ok, text, url: r.url };
  });
  expect(call.status).toBe(200);
  expect(call.text).toContain('STUB');
  expect(proxyHits.length, 'mocked proxy was hit').toBeGreaterThan(0);
  expect(proxyHits[0].method).toBe('POST');
  expect(new URL(proxyHits[0].url).pathname).toBe('/.netlify/functions/garmin-personal-proxy');
  expect(outside, 'no outside request during flag-on injection test').toEqual([]);
  const enabled = await page.evaluate(() => window.HyroxGarminImport.isEnabled());
  expect(enabled).toBe(false); // product isEnabled stays honest; UI is on via boot opts only
  const feature = await page.evaluate(() => window.HyroxGarminImport.FEATURE_GARMIN_IMPORT);
  expect(feature).toBe(false);
});

test('Chrome emulation, not Safari — Fetch→preview→apply: nothing pre-ticked, no Tick-all, first Garmin day can be created on an empty store', async ({ page }) => {
  const outside = [];
  await page.clock.setFixedTime(new Date('2026-11-24T06:00:00.000Z'));
  await page.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === '/.netlify/functions/garmin-personal-proxy') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(STUB_FETCH)
      });
    }
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    outside.push(req.url());
    return route.abort();
  });
  await page.goto('./');
  await enableGarminImportForTest(page);
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('garmin-import-fetch')).toBeVisible();
  await expect(page.getByText('Tick-all', { exact: false })).toHaveCount(0);
  await page.getByTestId('garmin-import-fetch').click();
  await expect(page.getByTestId('garmin-import-preview')).toBeVisible();
  const ticks = page.getByTestId('garmin-preview-tick');
  await expect(ticks.first()).toBeVisible();
  const checked = await ticks.evaluateAll((els) => els.map((el) => el.checked));
  expect(checked.every((c) => c === false), 'nothing pre-ticked').toBeTruthy();
  const status = await page.getByTestId('garmin-import-flag-on').textContent();
  expect(status).toMatch(/Preview ready/i);
  expect(status).not.toMatch(/morning check-in first/i);
  await ticks.first().check();
  await page.getByTestId('garmin-import-apply').click();
  await expect(page.getByTestId('garmin-import-flag-on')).toContainText(/Applied \(verified\)\./i);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hyrox.v1') || 'null'));
  expect(saved && saved.version).toBe(2);
  expect((saved.daily || []).some((d) => d && d.id === 'daily-2026-11-22' && d.steps && d.steps.source === 'GARMIN_PERSONAL_API')).toBeTruthy();
  expect((saved.ownerSettings || []).some((s) => s && s.id === 'app-settings' && s.garminLedger)).toBeTruthy();
  expect(outside, 'no outside request during Fetch UI test').toEqual([]);
});

test('Chrome emulation, not Safari — a weight-only stub is never offered and yields the owner NO_ROWS message', async ({ page }) => {
  const outside = [];
  await page.clock.setFixedTime(new Date('2026-11-24T06:00:00.000Z'));
  await page.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === '/.netlify/functions/garmin-personal-proxy') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(STUB_WEIGHT_ONLY)
      });
    }
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    outside.push(req.url());
    return route.abort();
  });
  await page.goto('./');
  await enableGarminImportForTest(page);
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('garmin-import-fetch').click();
  await expect(page.getByTestId('garmin-import-flag-on')).toContainText(/Weight is logged in HYROX only|no days for that range/i);
  await expect(page.getByTestId('garmin-preview-tick')).toHaveCount(0);
  const raw = await page.evaluate(() => localStorage.getItem('hyrox.v1'));
  expect(raw == null || !String(raw).includes('w-g-')).toBeTruthy();
  expect(outside).toEqual([]);
});
