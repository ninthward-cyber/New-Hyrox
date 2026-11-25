'use strict';
// Claude QA (24 Nov 2026), Chrome mobile emulation at 320 x 568 and 390 x 844 — NOT Safari/WebKit, not a physical iPhone.
// FAIL-FIRST: on P1.4-RC3 (and the live P1.3-RC3 layout) choosing a planned slot in Add > Workout makes the page 367 px wide at
// 320 px: the block type select cannot shrink and the UNVERIFIED badge is pushed past the edge. Mobile Chrome then widens the
// layout viewport, and taps land in the wrong place (the reported "notes textarea intercepts Save"). Save must be reachable by a
// plain tap, with no force and no sideways overflow.
const { test, expect } = require('@playwright/test');
for (const [w, hgt] of [[320, 568], [390, 844]]) {
  test.describe(`${w} x ${hgt}`, () => {
    test.use({ viewport: { width: w, height: hgt }, screen: { width: w, height: hgt }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    test(`${w}: Add > Workout with a planned slot fits the screen and "Save workout" saves with a plain tap`, async ({ page }) => {
      await page.goto('./'); await page.evaluate(() => localStorage.clear()); await page.reload();
      await page.getByTestId('tab-add').click(); await page.getByTestId('add-mode-workout').click();
      await page.getByTestId('session-slot').selectOption('v2.1-W1-TUE');
      await expect(page.getByTestId('block-row').first()).toBeVisible();
      const dims = await page.evaluate(() => ({ iw: window.innerWidth, sw: document.documentElement.scrollWidth }));
      expect(dims.iw).toBe(w);                      // the layout viewport was not widened
      expect(dims.sw).toBeLessThanOrEqual(w + 1);   // nothing sticks out sideways
      await page.getByTestId('session-status').selectOption('PARTIAL');
      await page.getByTestId('session-save').tap({ timeout: 8000 });
      await expect(page.getByTestId('ext-toast')).toContainText('Saved');
    });
  });
}
