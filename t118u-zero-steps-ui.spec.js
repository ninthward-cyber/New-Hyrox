'use strict';
// t119u / Claude QA t118u — Fetch → Preview → Apply in Chrome mobile emulation (NOT Safari, NOT an iPhone).
// Real Fetch path: same-origin proxy stub body from the source-tree handleProxy. A 0-step day (0 intensity
// and 35 intensity) must show the locked owner line and Open Morning, and must write nothing. Neighbouring
// worn days remain importable. Synthetic data; any non-local request is aborted and recorded.
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

async function setup(page, body, outside) {
  await page.clock.setFixedTime(new Date('2026-11-24T06:00:00.000Z'));
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/.netlify/functions/garmin-personal-proxy') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.body || body) });
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
}

for (const [label, mod, vig] of [['0 intensity', 0, 0], ['35 intensity min', 25, 5]]) {
  test('Fetch → Preview → Apply: 0 steps with ' + label + ' is locked not-worn and writes nothing', async ({ page }) => {
    const daily = { data: [row('2026-11-22', 0, mod, vig), row('2026-11-23', 8400, 30, 8)] };
    const body = makeProxyFetchBody({ dataset: 'daily', dailyDoc: daily, startDate: '2026-11-22', endDate: '2026-11-24', weightDoc: null });
    const proxyRow = ((body.body || body).rows && (body.body || body).rows.daily || []).find((r) => r.calendarDate === '2026-11-22');
    expect(proxyRow && proxyRow.steps, 'proxy keeps 0 as 0, not null').toBe(0);
    expect(proxyRow && proxyRow.intensity, '0-step day supplies no intensity').toBeNull();

    const outside = [];
    await setup(page, body, outside);
    await page.getByTestId('garmin-import-fetch').click();
    await expect(page.getByTestId('garmin-import-preview')).toBeVisible();
    const preview = page.getByTestId('garmin-import-preview');
    await expect(preview).toContainText('Garmin shows 0 steps, likely not worn');
    const ticks = await page.getByTestId('garmin-preview-tick').evaluateAll((els) => els.map((e) => ({
      label: (e.closest('label') || e.parentElement).innerText.replace(/\s+/g, ' ').slice(0, 120),
      disabled: e.disabled,
      checked: e.checked
    })));
    const zero = ticks.find((t) => /likely not worn/.test(t.label));
    expect(zero, 'preview has the locked not-worn line: ' + JSON.stringify(ticks)).toBeTruthy();
    expect(zero.disabled, 'not-worn line must not be tickable').toBe(true);
    expect(zero.checked).toBe(false);
    expect(ticks.filter((t) => /2026-11-22|22 Nov/.test(t.label) && /ntensity/.test(t.label) && !t.disabled).length, 'no tickable intensity for the not-worn day').toBe(0);
    await expect(page.getByTestId('garmin-zero-steps-morning')).toHaveCount(1);

    for (const t of await page.getByTestId('garmin-preview-tick').all()) {
      const lab = await t.evaluate((e) => (e.closest('label') || e.parentElement).innerText);
      if (/2026-11-22|22 Nov/.test(lab) && !(await t.isDisabled())) await t.check();
    }
    // also try ticking the neighbouring worn day so the apply button has work, then confirm 22 is still absent
    for (const t of await page.getByTestId('garmin-preview-tick').all()) {
      const lab = await t.evaluate((e) => (e.closest('label') || e.parentElement).innerText);
      if (/2026-11-23|23 Nov/.test(lab) && !(await t.isDisabled())) await t.check();
    }
    await page.getByTestId('garmin-import-apply').click();
    await expect(page.getByTestId('garmin-import-flag-on')).not.toHaveText(/Fetching…/);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hyrox.v1') || 'null'));
    const d22 = saved && (saved.daily || []).find((d) => d.date === '2026-11-22');
    expect(d22 || null, 'not-worn day must not be imported: ' + JSON.stringify(d22)).toBeNull();
    expect(outside, 'no outside network').toEqual([]);
  });
}

test('Open Morning from the 0-step preview reuses Add > Morning; a later non-zero Garmin day stays importable', async ({ page }) => {
  const daily = { data: [row('2026-11-22', 0, 25, 5), row('2026-11-23', 8400, 30, 8)] };
  const body = makeProxyFetchBody({ dataset: 'daily', dailyDoc: daily, startDate: '2026-11-22', endDate: '2026-11-24', weightDoc: null });
  const outside = [];
  await setup(page, body, outside);
  await page.getByTestId('garmin-import-fetch').click();
  await expect(page.getByTestId('garmin-import-preview')).toBeVisible();
  await expect(page.getByTestId('garmin-import-preview')).toContainText('Garmin shows 0 steps, likely not worn');
  const btn = page.getByTestId('garmin-zero-steps-morning');
  await expect(btn).toHaveCount(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'Open Morning must not break 320/390 layout').toBeLessThanOrEqual(0);
  const bb = await btn.boundingBox();
  expect(bb && bb.height, 'Open Morning touch target >= 24px').toBeGreaterThanOrEqual(24);
  expect(bb && bb.height, 'prefer 44px iOS target').toBeGreaterThanOrEqual(44);
  await btn.click();
  await expect(page.getByTestId('add-mode-morning')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('morning-form')).toBeVisible();
  // F-B: keyboard/screen-reader focus must land on the Morning heading or first input after the form is mounted.
  // VoiceOver and a physical iPhone are untested; this is Chrome mobile emulation on Linux.
  const focus = await page.evaluate(() => {
    const a = document.activeElement;
    const form = document.querySelector('[data-testid="morning-form"]');
    return {
      tag: a && a.tagName,
      testid: a && a.getAttribute && a.getAttribute('data-testid'),
      inside: !!(form && a && form.contains(a)),
      isBody: !!(a && a.tagName === 'BODY')
    };
  });
  expect(focus.isBody, 'focus must leave BODY after Open Morning: ' + JSON.stringify(focus)).toBe(false);
  expect(focus.inside, 'focus must be inside morning-form: ' + JSON.stringify(focus)).toBe(true);
  expect(['H1', 'H2', 'H3', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(focus.tag), 'focus target: ' + JSON.stringify(focus)).toBe(true);
  expect(outside).toEqual([]);
});
