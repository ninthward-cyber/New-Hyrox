'use strict';
// F-1 (owner-authorised narrow fix, 22 Nov 2026): a quantity typed in Add foods must never be lost and saved as 1x.
// Root cause: the search box redraws the result list 120 ms after the last keystroke. That pending redraw was not cancelled
// when a result was picked, so it could fire afterwards and replace the open detail - including the quantity field the
// owner had just tapped. What was typed next went nowhere and "Add to meal" stored 1x.
// These tests make that timing DETERMINISTIC: the 120 ms search timer is held and released at an exact point, instead of
// hoping a loaded machine reproduces it. Synthetic data only, no network, no paid call.
// CHROME MOBILE EMULATION, NOT SAFARI/WEBKIT and not a physical iPhone.
const { test, expect } = require('@playwright/test');

const NOW = '2026-11-22T09:00:00.000Z';
async function open(page) {
  page._errs = []; page.on('pageerror', (e) => page._errs.push(e.message));
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId('app-error')).toBeHidden();
  // Hold/release for the 120 ms search debounce only. Everything else uses the real timers.
  // (Installed after the page has loaded, on top of whatever timer functions the page then has.)
  await page.evaluate(() => {
    const realSet = window.setTimeout.bind(window), realClear = window.clearTimeout.bind(window);
    const held = new Map(); let next = -1;
    window.__f1 = { hold: false, pending: () => held.size, release: () => { const fns = [...held.values()]; held.clear(); fns.forEach((f) => f()); return fns.length; } };
    window.setTimeout = function (fn, ms, ...a) { if (window.__f1.hold && ms === 120 && typeof fn === 'function') { const id = next--; held.set(id, () => fn(...a)); return id; } return realSet(fn, ms, ...a); };
    window.clearTimeout = function (id) { if (held.has(id)) { held.delete(id); return; } return realClear(id); };
  });
  expect(await page.evaluate(() => { window.__f1.hold = true; const id = setTimeout(() => {}, 120); const n = window.__f1.pending(); clearTimeout(id); window.__f1.hold = false; return [n, window.__f1.pending()]; })).toEqual([1, 0]); // the hook works
}
const meals = async (page) => (JSON.parse((await page.evaluate(() => localStorage.getItem('hyrox.v1'))) || '{}').meals || []);
const hold = (page, on) => page.evaluate((v) => { window.__f1.hold = v; }, on);
const release = (page) => page.evaluate(() => window.__f1.release());
const pending = (page) => page.evaluate(() => window.__f1.pending());
async function foods(page, cat = 'lunch') {
  await page.getByTestId('today-add-meal').click();
  await page.getByTestId('diary-log-' + cat).click();
  await page.getByTestId('meal-add-foods').click();
  await expect(page.getByTestId('foods-screen')).toBeVisible();
  await expect(page.getByTestId('foods-status')).not.toContainText('Loading');
}
const banana = (page) => page.getByTestId('food-result').filter({ hasText: /^Bananas, raw/ }).first();
// what one serving is, read from the app's own preview ("1 medium (118 g) · 105 kcal · estimate")
async function oneServing(page) {
  const t = await page.getByTestId('food-preview').textContent();
  const m = /\((\d+(?:\.\d+)?) g\) · (\d+) kcal/.exec(t); expect(m, t).not.toBeNull();
  return { grams: Number(m[1]), kcal: Number(m[2]) };
}
// the owner's keystrokes: whatever has the focus receives them (select-all, then the digits)
async function typeOver(page, text) { await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(text); }
async function confirmAndCheck(page, want) {
  await page.getByTestId('foods-done').click();
  // the review shows what will be stored
  await expect(page.getByTestId('component-row')).toHaveCount(want.length);
  for (let i = 0; i < want.length; i++) {
    await expect(page.getByTestId('component-portion').nth(i)).toHaveValue(want[i].portion);
    await expect(page.getByTestId('component-kcal').nth(i)).toHaveValue(String(want[i].kcal));
  }
  await page.getByTestId('meal-confirm').click();
  const all = await meals(page); const m = all[all.length - 1];
  expect(m.lifecycle).toBe('CONFIRMED');
  expect(m.components.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    const c = m.components[i];
    expect(c.portion).toBe(want[i].portion);
    expect(c.kcal).toEqual({ value: want[i].kcal, state: 'ESTIMATED' });
    if (want[i].grams !== undefined) expect(c.provenance.grams).toBe(want[i].grams);
    if (want[i].check) want[i].check(c);
  }
  return m;
}

for (const W of [390, 320]) {
  test.describe(`F-1 Add foods quantity ${W}px (Chrome emulation, not Safari/WebKit)`, () => {
    test.use({ viewport: { width: W, height: W === 320 ? 568 : 844 } });

    test(`${W}: FAIL-FIRST — a result picked while a search redraw is still pending keeps its quantity field; the typed 3 is stored as 3x, not 1x`, async ({ page }) => {
      await open(page);
      await foods(page);
      await page.getByTestId('foods-q').fill('banan');           // results for "banan" are on screen
      await expect(banana(page)).toBeVisible();
      await hold(page, true);
      await page.getByTestId('foods-q').pressSequentially('a');   // "banana": its redraw is now pending (held)
      expect(await pending(page)).toBe(1);
      await banana(page).getByTestId('food-pick').click();        // the owner taps the result straight away
      const one = await oneServing(page);
      await page.getByTestId('food-qty').focus();                 // ...and taps the quantity field
      await release(page);                                        // the pending redraw (if any is left) fires NOW
      await hold(page, false);
      await typeOver(page, '3');                                  // ...and types
      await expect(page.getByTestId('food-qty')).toBeFocused();
      await expect(page.getByTestId('food-qty')).toHaveValue('3');
      await expect(page.getByTestId('food-preview')).toContainText(one.kcal * 3 + ' kcal');
      await page.getByTestId('food-add').click();
      await confirmAndCheck(page, [{ portion: '3 × 1 medium (7" to 7-7/8" long) (' + one.grams * 3 + ' g)', kcal: one.kcal * 3, grams: one.grams * 3 }].map((w) => w));
      expect(page._errs).toEqual([]);
    });

    test(`${W}: FAIL-FIRST — My food picked from Favorites right after typing in the search box (the path of the flaky test): 2 is stored as 2x`, async ({ page }) => {
      await open(page);
      // a confirmed banana meal -> save it to My foods -> favourite it
      await foods(page, 'snacks');
      await page.getByTestId('foods-q').fill('banana'); await banana(page).getByTestId('food-pick').click();
      const one = await oneServing(page);
      await page.getByTestId('food-add').click(); await page.getByTestId('foods-done').click(); await page.getByTestId('meal-confirm').click();
      await page.getByTestId('tab-history').click();
      await page.getByTestId('meal-save-myfoods').click(); await page.getByTestId('myfoods-pick-save').click();
      await page.getByTestId('tab-today').click();
      await foods(page, 'dinner');
      await page.getByTestId('foods-tab-my').click();
      await page.getByTestId('food-result').first().getByTestId('food-pick').click();
      await page.getByTestId('food-fav').click();
      await page.getByTestId('foods-tab-fav').click();
      await expect(page.getByTestId('food-result')).toHaveCount(1);
      await hold(page, true);
      await page.getByTestId('foods-q').pressSequentially('banana');   // typing switches to Search; the list on screen is still Favorites
      await page.getByTestId('food-result').first().getByTestId('food-pick').click();
      await page.getByTestId('food-qty').focus();
      await release(page); await hold(page, false);
      await typeOver(page, '2');
      await expect(page.getByTestId('food-qty')).toHaveValue('2');
      await page.getByTestId('food-add').click();
      await page.getByTestId('foods-done').click();
      await expect(page.getByTestId('component-kcal')).toHaveValue(String(one.kcal * 2));
      await page.getByTestId('meal-confirm').click();
      const m = (await meals(page))[1];
      expect(m.components.length).toBe(1);
      expect(m.components[0].kcal.value).toBe(one.kcal * 2);
      expect(m.components[0].portion.startsWith('2 × ')).toBe(true);
      expect(page._errs).toEqual([]);
    });

    test(`${W}: FAIL-FIRST — a search redraw left over from before never replaces an open detail, however late it fires`, async ({ page }) => {
      await open(page);
      await foods(page);
      await page.getByTestId('foods-q').fill('banan');
      await expect(banana(page)).toBeVisible();
      await hold(page, true);
      await page.getByTestId('foods-q').pressSequentially('a');
      await banana(page).getByTestId('food-pick').click();
      const marker = await page.getByTestId('food-qty').evaluate((el) => { el.__same = 'yes'; return true; });
      expect(marker).toBe(true);
      expect(await pending(page)).toBe(0);                         // picking a result cancels the pending redraw
      await release(page); await hold(page, false);
      // it is still the very same field, not a rebuilt copy
      expect(await page.getByTestId('food-qty').evaluate((el) => el.__same)).toBe('yes');
      expect(page._errs).toEqual([]);
    });

    test(`${W}: FAIL-FIRST — a search redraw never replaces the row under a finger that is already down; the tap opens the result`, async ({ page }) => {
      await open(page);
      await foods(page);
      await page.getByTestId('foods-q').fill('banan');
      await expect(banana(page)).toBeVisible();
      await hold(page, true);
      await page.getByTestId('foods-q').pressSequentially('a');     // redraw pending
      const btn = banana(page).getByTestId('food-pick');
      await btn.evaluate((el) => { el.__same = 'yes'; });
      await btn.scrollIntoViewIfNeeded();
      const box = await btn.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();                                      // finger down on the result
      await release(page);                                          // the redraw comes due while it is down
      expect(await btn.evaluate((el) => el.__same)).toBe('yes');    // the row was not replaced
      expect(await pending(page)).toBe(1);                          // the redraw is waiting, not dropped
      await page.mouse.up();                                        // finger up: an ordinary tap
      await expect(page.getByTestId('food-detail')).toBeVisible();
      await expect(page.getByTestId('food-qty')).toHaveValue('1');
      expect(await pending(page)).toBe(0);
      await hold(page, false);
      expect(page._errs).toEqual([]);
    });

    test(`${W}: the search still updates after a press that never ended (no stuck list): results follow the text once the press is stale`, async ({ page }) => {
      await open(page);
      await foods(page);
      await page.getByTestId('foods-q').fill('banan');
      await expect(banana(page)).toBeVisible();
      await page.getByTestId('foods-results').dispatchEvent('pointerdown'); // a finger-down with no finger-up ever reported
      await page.clock.setFixedTime(new Date(Date.parse(NOW) + 2000));      // 2 s later
      await page.getByTestId('foods-q').fill('egg whole boiled');
      await expect(page.getByTestId('food-result').first()).toContainText('Egg, whole');
      await page.getByTestId('foods-q').fill('');
      await expect(page.getByTestId('food-result')).toHaveCount(0);
      expect(page._errs).toEqual([]);
    });

    test(`${W}: quantity survives a serving change, a Favorite toggle (redraw), and leaving and reopening Add foods; stored macros match the review`, async ({ page }) => {
      await open(page);
      await foods(page);
      await page.getByTestId('foods-q').fill('banana');
      await banana(page).getByTestId('food-pick').click();
      await page.getByTestId('food-qty').fill('2.5');
      const opts = await page.getByTestId('food-serving').locator('option').allTextContents();
      const other = opts.find((o) => /^1 large/.test(o)) || opts[opts.length - 1];
      await page.getByTestId('food-serving').selectOption({ label: other });
      await expect(page.getByTestId('food-qty')).toHaveValue('2.5');                 // serving change keeps the quantity
      await page.getByTestId('food-fav').click();                                    // redraws the detail
      await expect(page.getByTestId('food-qty')).toHaveValue('2.5');
      await expect(page.getByTestId('food-serving').locator('option:checked')).toHaveText(other);
      const prev = await page.getByTestId('food-preview').textContent();
      const m0 = /^(2\.5 × .+ \((\d+(?:\.\d+)?) g\)) · (\d+) kcal/.exec(prev); expect(m0, prev).not.toBeNull();
      await page.getByTestId('food-add').click();
      // leave and reopen Add foods before confirming: the item is still 2.5x in the draft
      await page.getByTestId('foods-done').click();
      await expect(page.getByTestId('component-portion')).toHaveValue(m0[1]);
      await page.getByTestId('meal-add-foods').click();
      await expect(page.getByTestId('foods-screen')).toBeVisible();
      await confirmAndCheck(page, [{ portion: m0[1], kcal: Number(m0[3]), grams: Number(m0[2]), check: (c) => {
        expect(c.proteinG.state).toBe('ESTIMATED'); expect(c.carbsG.value).toBeGreaterThan(0); } }]);
      // History shows the same stored item
      await page.getByTestId('tab-history').click();
      await expect(page.getByTestId('panel-history')).toContainText(m0[3] + ' kcal');
      expect(page._errs).toEqual([]);
    });

    test(`${W}: no silent 1x — an empty or zero quantity is refused with a message and nothing is added; a new pick visibly starts at 1`, async ({ page }) => {
      await open(page);
      await foods(page);
      await page.getByTestId('foods-q').fill('banana');
      await banana(page).getByTestId('food-pick').click();
      for (const bad of ['', '0']) {
        await page.getByTestId('food-qty').fill(bad);
        await page.getByTestId('food-add').click();
        await expect(page.getByTestId('food-error')).toContainText('quantity between 0.1 and');
        await expect(page.getByTestId('foods-added')).toHaveCount(0);
      }
      await page.getByTestId('food-qty').fill('4');
      await banana(page).getByTestId('food-pick').click();   // close
      await banana(page).getByTestId('food-pick').click();   // open again: the field shows 1, so what is stored is what is shown
      await expect(page.getByTestId('food-qty')).toHaveValue('1');
      const one = await oneServing(page);
      await page.getByTestId('food-add').click();
      await confirmAndCheck(page, [{ portion: '1 medium (7" to 7-7/8" long) (' + one.grams + ' g)', kcal: one.kcal, grams: one.grams }]);
      expect(page._errs).toEqual([]);
    });

    test(`${W}: two foods in a row, fast — each keeps its own quantity (1.5 and 2) and the day total is their sum`, async ({ page }) => {
      await open(page);
      await foods(page);
      const got = [];
      for (const [q, re, qty] of [['banana', /^Bananas, raw/, '1.5'], ['egg whole boiled', /^Egg, whole, cooked, hard-boiled/, '2']]) {
        await hold(page, true);
        await page.getByTestId('foods-q').fill(q);
        await release(page);                                   // results for the full query
        await page.getByTestId('foods-q').pressSequentially(' ');   // one more keystroke: a redraw is pending again
        const item = page.getByTestId('food-result').filter({ hasText: re }).first();
        await item.getByTestId('food-pick').click();
        await page.getByTestId('food-qty').focus();
        await release(page); await hold(page, false);
        await typeOver(page, qty);
        await expect(page.getByTestId('food-qty')).toHaveValue(qty);
        const t = await page.getByTestId('food-preview').textContent();
        const m = /^(.+ \((\d+(?:\.\d+)?) g\)) · (\d+) kcal/.exec(t); expect(m, t).not.toBeNull();
        expect(m[1].startsWith(qty + ' × ')).toBe(true);
        got.push({ portion: m[1], grams: Number(m[2]), kcal: Number(m[3]) });
        await page.getByTestId('food-add').click();
        await expect(page.getByTestId('foods-q')).toHaveValue('');
      }
      const m = await confirmAndCheck(page, got);
      expect(m.components.reduce((a, c) => a + c.kcal.value, 0)).toBe(got[0].kcal + got[1].kcal);
      expect(page._errs).toEqual([]);
    });
  });
}
