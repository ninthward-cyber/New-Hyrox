'use strict';
// Claude independent QA of Grok's P1.4-RC2 (source bcbc7b4d2959), 23 Nov 2026: browser tests for the fixes delivered as P1.4-RC3
// and for the owner's decision on clearing the local meal draft. Helpers are the ones of p1-2b-meal-draft.spec.js.
// B2 FAIL-FIRST: a discarded, resumed draft must not leave its "Unsaved meal restored" banner on the next blank meal.
// B2 GUARD (owner decision 23 Nov): "Save draft" / "I ate this (confirm later)" may clear the local copy ONLY when the uncounted
//    record was saved and verified AND can be reopened, edited and confirmed without a duplicate; a failed save keeps the local copy.
// Synthetic data only; no network, no paid call. CHROME MOBILE EMULATION, NOT SAFARI/WEBKIT, not a physical iPhone.
const path = require('path');
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const FX = require('../fixtures/p0-photo-note-fixtures.js');

const KEY = 'hyrox.ui.meal-draft';
const FIX = path.join(__dirname, '..', 'fixtures');
let H;
test.beforeAll(() => {
  const out = path.join(__dirname, '..', 'out', 'p9-helpers.bundle.cjs');
  const esbuild = process.env.P9_ESBUILD || (() => { try { return require.resolve('esbuild/bin/esbuild'); } catch (e) { return '/workspace/p9-tools/node_modules/.bin/esbuild'; } })();
  require('child_process').execFileSync(esbuild, [path.join(__dirname, '..', 'p9-helpers.mjs'), '--bundle', '--platform=node', '--format=cjs', '--log-level=error', '--define:import.meta.url=' + JSON.stringify(require('url').pathToFileURL(path.join(__dirname, '..', 'p9-helpers.mjs')).href), '--outfile=' + out]);
  H = require(out);
});
async function installApi(page, text) {
  const ctx = H.setup({ script: () => H.openaiOk(text), clock: { t: Date.UTC(2026, 10, 18, 6, 0, 0) } });
  await page.route('**/api/food-photo/**', async (route) => {
    const r = route.request();
    const req = new Request(r.url(), { method: r.method(), headers: r.headers(), body: r.method() === 'GET' ? undefined : r.postData() });
    const res = await ctx.handle(req, { ip: '203.0.113.5' });
    try { await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() }); } catch (e) { /* page moved on */ }
  });
}
const NOW = '2026-11-18T09:00:00.000Z'; // Wed 18 Nov 2026, 12:00 Asia/Qatar
const TS = '2026-11-18T05:00:00.000Z';
const E = (v) => ({ value: v, state: 'ESTIMATED' }), U = () => ({ value: null, state: 'UNKNOWN' });
const SEED_MEAL = { id: 'meal-seed-1', date: '2026-11-18', time: '08:00', label: '', source: 'MANUAL', description: 'seed breakfast', eatenFraction: 1, lifecycle: 'CONFIRMED',
  confirmedAt: TS, createdAt: TS, updatedAt: TS, mealCategory: 'BREAKFAST', components: [{ name: 'Oats', role: 'MAIN', portion: '1 bowl', preparation: '', eatenFraction: null, kcal: E(500), proteinG: E(20), carbsG: E(80), fatG: E(8) }] };
async function open(page, opts = {}) {
  page._errs = []; page.on('pageerror', (e) => page._errs.push(e.message));
  await page.clock.setFixedTime(new Date(opts.at || NOW));
  await page.goto('./');
  await page.evaluate((o) => { localStorage.clear(); if (o.data) localStorage.setItem('hyrox.v1', JSON.stringify(o.data)); if (o.draft !== undefined) localStorage.setItem('hyrox.ui.meal-draft', o.draft); }, { data: opts.data || null, draft: opts.draft });
  await page.reload();
  await expect(page.getByTestId('app-error')).toBeHidden();
}
const raw = (page, k) => page.evaluate((x) => localStorage.getItem(x), k);
const draft = async (page) => JSON.parse((await raw(page, KEY)) || 'null');
const meals = async (page) => (JSON.parse((await raw(page, 'hyrox.v1')) || '{}').meals || []);
const noHScroll = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
async function toAddMeal(page) { await page.getByTestId('tab-add').click(); await page.getByTestId('add-mode-meal').click(); }
async function portion(page, i, v) {
  const p = page.getByTestId('component-portion').nth(i);
  if (!(await p.isVisible())) await page.getByTestId('component-details').nth(i).locator('summary').click();
  await p.fill(v);
}
async function typeManual(page, o) {
  await toAddMeal(page);
  await page.getByTestId('meal-path-manual').click();
  await page.getByTestId('meal-description').fill(o.desc || 'DRAFT-DESC rice and chicken');
  await page.getByTestId('component-name').first().fill(o.name || 'Chicken rice');
  await page.getByTestId('component-kcal').first().fill(String(o.kcal || 900));
  await portion(page, 0, o.portion || '1.5 plates');
}
async function reloadToToday(page) { await page.reload(); await expect(page.getByTestId('app-error')).toBeHidden(); await expect(page.getByTestId('panel-today')).toBeVisible(); }


for (const W of [390, 320]) {
  test.describe(`P1.4-RC3 Claude QA: meal draft ${W}px (Chrome emulation, not Safari/WebKit)`, () => {
    test.use({ viewport: { width: W, height: W === 320 ? 568 : 844 } });

    test(`${W}: FAIL-FIRST — Resume, then switch the input path and choose "Discard it": no "restored" banner follows onto the new blank meal or its draft`, async ({ page }) => {
      await open(page);
      await typeManual(page, {});
      await reloadToToday(page);
      await page.getByTestId('today-meal-draft-resume').click();
      await expect(page.getByTestId('meal-draft-restored')).toBeVisible();
      await page.getByTestId('meal-path-description').click();
      await page.getByRole('button', { name: 'Discard it' }).click();
      await expect(page.getByTestId('meal-description')).toHaveValue('');
      expect(await raw(page, KEY)).toBeNull();                                    // the explicit Discard removed the stored copy
      await expect(page.getByTestId('meal-draft-restored')).toHaveCount(0);       // and its banner does not stay on a blank meal
      await page.getByTestId('meal-description').fill('a brand new meal');
      await expect.poll(async () => (await draft(page)) && (await draft(page)).ms.description).toBe('a brand new meal');
      await expect(page.getByTestId('meal-draft-restored')).toHaveCount(0);
      await page.getByTestId('tab-today').click(); await page.getByTestId('tab-add').click();
      await expect(page.getByTestId('meal-draft-restored')).toHaveCount(0);
      expect(page._errs).toEqual([]);
    });

    for (const [btn, lc, label] of [['meal-save-draft', 'DRAFT', 'Save draft'], ['meal-consumed-intent', 'CONSUMED_INTENT', 'I ate this (confirm later)']]) {
      test(`${W}: GUARD (passes before and after) — "${label}": local copy cleared only with a verified uncounted record that reopens, edits and confirms as ONE meal`, async ({ page }) => {
        await open(page);
        await typeManual(page, {});
        await expect.poll(() => raw(page, KEY)).not.toBeNull();
        await page.getByTestId(btn).click();
        await expect.poll(async () => (await meals(page)).length).toBe(1);
        const saved = (await meals(page))[0];
        expect([saved.lifecycle, saved.description, saved.components[0].name, saved.components[0].kcal.value, saved.components[0].portion]).toEqual([lc, 'DRAFT-DESC rice and chicken', 'Chicken rice', 900, '1.5 plates']);
        expect(await raw(page, KEY)).toBeNull();                                  // cleared only now, after the verified save
        await reloadToToday(page);
        await expect(page.getByTestId('today-meal-draft')).toHaveCount(0);        // no second, local copy is offered
        await expect(page.getByTestId('today-subtotal')).not.toContainText('900'); // and the record is not counted
        // it can be reopened and edited
        await page.getByTestId('tab-history').click();
        await expect(page.getByTestId('history-meal')).toHaveCount(1);
        await page.getByTestId('meal-review').click();
        await expect(page.getByTestId('meal-description')).toHaveValue('DRAFT-DESC rice and chicken');
        await expect(page.getByTestId('component-kcal').first()).toHaveValue('900');
        await page.getByTestId('component-kcal').first().fill('950');
        // the edit itself is protected as a local draft tied to the stored record (not a new meal)
        await expect.poll(async () => { const d = await draft(page); return d && [d.ms.id, d.ms.components[0].kcal.value]; }).toEqual([saved.id, 950]);
        await page.reload(); await expect(page.getByTestId('app-error')).toBeHidden();
        await page.getByTestId('today-meal-draft-resume').click();
        await expect(page.getByTestId('component-kcal').first()).toHaveValue('950');
        await page.getByTestId('meal-confirm').click();
        await expect.poll(async () => (await meals(page)).map((m) => m.lifecycle).join()).toBe('CONFIRMED');
        const fin = await meals(page);
        expect(fin.length).toBe(1);                                               // one meal, no duplicate
        expect([fin[0].id, fin[0].components[0].kcal.value]).toEqual([saved.id, 950]);
        expect(await raw(page, KEY)).toBeNull();
        await page.getByTestId('tab-today').click();
        await expect(page.getByTestId('today-subtotal')).toContainText('950');     // counted once, only after Confirm
        expect(page._errs).toEqual([]);
      });
    }

    test(`${W}: GUARD (passes before and after) — a "Save draft" that fails to store keeps the local copy and writes no record`, async ({ page }) => {
      await open(page);
      await typeManual(page, {});
      await expect.poll(() => raw(page, KEY)).not.toBeNull();
      const kept = await raw(page, KEY);
      await page.evaluate(() => { const real = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'hyrox.v1') throw new DOMException('quota', 'QuotaExceededError'); return real.call(this, k, v); }; });
      await page.getByTestId('meal-save-draft').click();
      await expect(page.locator('.form-error').filter({ hasText: 'Not saved' }).first()).toBeVisible();
      expect((await meals(page)).length).toBe(0);
      expect(JSON.parse(await raw(page, KEY)).ms.description).toBe(JSON.parse(kept).ms.description);
      await page.getByTestId('meal-consumed-intent').click();
      expect((await meals(page)).length).toBe(0);
      expect(await raw(page, KEY)).not.toBeNull();
      expect(page._errs).toEqual([]);
    });
  });
}
