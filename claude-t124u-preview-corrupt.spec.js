'use strict';
// Claude QA t124u (24 Nov 2026), fail-first: a stored settings garminLedger that cannot be read ('' here) must give the owner
// the corrupt-links sentence on Fetch, not "Fetch failed.", and storage must not change. Fails on c8c2ec7 at 320 and 390.
// Chrome mobile emulation, NOT Safari; mocked same-origin Fetch from the source-tree proxy stub; no outside requests.
const { test, expect } = require('@playwright/test');
const { makeProxyFetchBody } = require('../garmin-proxy-shaped-body');
const prevDay = (d) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
const row = (date, steps, mod, vig) => ({ uuid: 'u-' + date, calendarDate: date, source: 'garmin', includesWellnessData: true, includesActivityData: true,
  wellnessChronology: { startTimestampGmt: prevDay(date) + 'T21:00:00.0', startTimestampLocal: date + 'T00:00:00.0', endTimestampGmt: date + 'T20:59:00.0', endTimestampLocal: date + 'T23:59:00.0', totalDurationInMillis: 86340000 },
  movement: { steps: { goal: 10000, value: steps } }, intensityMinutes: { goal: 150, moderate: mod, vigorous: vig } });
const body = (rows) => { const r = makeProxyFetchBody({ dataset: 'daily', dailyDoc: { data: rows }, startDate: '2026-11-18', endDate: '2026-11-24', weightDoc: null }); return r.body || r; };
async function setup(page, b, outside, seed) {
  await page.clock.setFixedTime(new Date('2026-11-24T06:00:00.000Z'));
  await page.route('**/*', async (route) => { const u = new URL(route.request().url());
    if (u.pathname === '/.netlify/functions/garmin-personal-proxy') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue(); outside.push(u.href); return route.abort(); });
  await page.goto('./'); await page.evaluate((s) => { localStorage.clear(); if (s) localStorage.setItem('hyrox.v1', s); }, seed ? JSON.stringify(seed) : null); await page.reload();
  await page.evaluate(() => window.HyroxGarminImport.boot(document.getElementById('garmin-import-root'), { enabled: true }));
  await page.getByTestId('tab-settings').click(); await page.getByTestId('garmin-import-fetch').click();
}
const focusInfo = (page) => page.evaluate(() => { const a = document.activeElement; const f = document.querySelector('[data-testid="morning-form"]');
  return { tag: a && a.tagName, testid: a && a.getAttribute('data-testid'), text: a && (a.innerText || a.value || '').slice(0, 40), insideMorningForm: !!(f && a && f.contains(a)), tabindex: a && a.getAttribute('tabindex') }; });
test('F-C: a stored settings ledger of "" -> what the owner reads on Fetch, and nothing changes', async ({ page }, info) => {
  const seed = { version: 2, weight: [], workouts: [], nutrition: [], sessions: [], meals: [], body: [], walks: [], dayStates: [], planEvents: [],
    daily: [{ id: 'd-man-18', createdAt: '2026-11-18T05:00:00.000Z', date: '2026-11-18', soreness: { state: 'OBSERVED', value: 2 } }],
    ownerSettings: [{ id: 'app-settings', createdAt: '2026-11-24T06:00:00.000Z', date: '2026-11-24', garminLedger: '' }] };
  const outside = []; await setup(page, body([row('2026-11-23', 8400, 30, 8)]), outside, seed); await page.waitForTimeout(300);
  const statusText = (await page.getByTestId('garmin-import-flag-on').innerText()).trim();
  const raw = await page.evaluate(() => localStorage.getItem('hyrox.v1'));
  console.log('RESULT', info.project.name, 'status', JSON.stringify(statusText), 'unchanged', raw === JSON.stringify(seed));
  expect(raw).toBe(JSON.stringify(seed)); expect(outside).toEqual([]);
  expect(statusText, 'owner should get the corrupt-links sentence, not "Fetch failed."').toMatch(/could not be read/);
});
