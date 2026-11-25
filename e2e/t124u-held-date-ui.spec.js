'use strict';
// t124u F-A: Fetch held/skip dates from the proxy body are untrusted. Chrome mobile emulation, not Safari, not an iPhone.
// A malformed or hostile calendarDate must not become a date, must not overflow 320/390, and a legitimate HOLD still blocks writes.
const { test, expect } = require('@playwright/test');
const { makeProxyFetchBody } = require('../garmin-proxy-shaped-body');

const prevDay = (d) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
const row = (date, steps, mod, vig) => ({
  uuid: 'u-' + date, calendarDate: date, source: 'garmin', includesWellnessData: true, includesActivityData: true,
  wellnessChronology: {
    startTimestampGmt: prevDay(date) + 'T21:00:00.0', startTimestampLocal: date + 'T00:00:00.0',
    endTimestampGmt: date + 'T20:59:00.0', endTimestampLocal: date + 'T23:59:00.0', totalDurationInMillis: 86340000
  },
  movement: { steps: { goal: 10000, value: steps } }, intensityMinutes: { goal: 150, moderate: mod, vigorous: vig }
});
function isOutside(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'data:' || u.protocol === 'blob:') return false;
    return u.hostname !== '127.0.0.1' && u.hostname !== 'localhost';
  } catch (e) { return true; }
}

test('F-A: malformed and hostile held dates are not shown and do not overflow; legitimate HOLD still blocks writes', async ({ page }) => {
  const daily = { data: [row('2026-11-23', 8400, 30, 8), row('2026-11-21', 1200, 10, 0)] };
  const raw = makeProxyFetchBody({ dataset: 'daily', dailyDoc: daily, startDate: '2026-11-21', endDate: '2026-11-24', weightDoc: null });
  const body = raw.body || raw;
  body.held = [
    { calendarDate: '<b id="qa">2026-11-19</b>', reason: 'DUPLICATE_DATE_CONFLICT' },
    { calendarDate: 'x'.repeat(300), reason: 'INCOMPLETE_DAY' },
    { calendarDate: '2026-11-21', reason: 'INCOMPLETE_DAY' }
  ];
  if (body.rows && body.rows.daily) {
    body.rows.daily.push({ calendarDate: 'y'.repeat(200), steps: 5, inProgress: false });
  }
  const outside = [];
  await page.clock.setFixedTime(new Date('2026-11-24T06:00:00.000Z'));
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/.netlify/functions/garmin-personal-proxy') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    outside.push(u.href);
    return route.abort();
  });
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => window.HyroxGarminImport.boot(document.getElementById('garmin-import-root'), { enabled: true }));
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('garmin-import-fetch').click();
  const preview = page.getByTestId('garmin-import-preview');
  await expect(preview).toBeVisible();
  const text = await preview.innerText();
  expect(text).not.toMatch(/xxxxxxxxxx|yyyyyyyyyy|<b id=/);
  expect(text).toMatch(/2026-11-21/);
  expect(text).toMatch(/not complete yet|HOLD/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'hostile date must not widen the page').toBeLessThanOrEqual(0);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, 'page must stay at the emulated width').toBeLessThanOrEqual(400);

  for (const t of await page.getByTestId('garmin-preview-tick').all()) {
    if (!(await t.isDisabled())) await t.check();
  }
  await page.getByTestId('garmin-import-apply').click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hyrox.v1') || 'null'));
  const dates = (saved && saved.daily || []).map((d) => d.date);
  expect(dates, 'held 21 Nov must not be written').not.toContain('2026-11-21');
  expect(dates).toContain('2026-11-23');
  expect(outside, 'no outside network').toEqual([]);
});
