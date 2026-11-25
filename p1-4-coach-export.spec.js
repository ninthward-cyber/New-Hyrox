'use strict';
// Sprint D (P1.4) Export for AI Coaching, browser tests CE-E-01..09 (HNC-E-COACH-001 section 10). The iPhone share sheet is
// EMULATED by stubbing navigator.share / navigator.canShare; this proves the app's labels and fallbacks, NOT that iOS accepts
// a JSON file (device test CE-D-02). Synthetic data only. CHROME EMULATION, NOT SAFARI/WEBKIT, not a physical iPhone.
const fs = require('fs');
const { test, expect } = require('@playwright/test');

const NOW = '2026-11-18T09:00:00.000Z'; // Wed 18 Nov 2026 12:00 Qatar
const FORBIDDEN = ['synced', 'uploaded', 'saved to drive', 'sent to chatgpt', 'backed up', 'up to date'];
const seedFn = () => {
  const HD = window.HyroxData, st = HD.createStore(), ts = new Date().toISOString();
  const E = (v) => ({ value: v, state: 'ESTIMATED' }), U = () => ({ value: null, state: 'UNKNOWN' });
  const put = (t, r) => { const x = st.putRecord(t, r); if (!x.ok) throw new Error(t + JSON.stringify(x.errors)); };
  put('meals', { id: 'm-1', date: '2026-11-16', time: '13:00', label: 'FT-LABEL', description: 'FT-DESC', source: 'DESCRIPTION', lifecycle: 'CONFIRMED', confirmedAt: ts, mealCategory: 'LUNCH',
    components: [{ name: 'Chicken', role: 'MAIN', portion: '200 g', preparation: '', eatenFraction: null, kcal: E(330), proteinG: E(62), carbsG: E(0), fatG: E(7) }, { name: 'Oil', role: 'OIL', portion: '', preparation: '', eatenFraction: null, kcal: U(), proteinG: U(), carbsG: U(), fatG: U() }] });
  put('meals', { id: 'm-2', date: '2026-11-17', time: '19:00', label: '', description: '', source: 'MANUAL', lifecycle: 'DRAFT', components: [{ name: 'SECRET-DRAFT-NAME', role: 'MAIN', portion: '', preparation: '', eatenFraction: null, kcal: E(700), proteinG: E(20), carbsG: E(90), fatG: E(20) }] });
  put('sessions', { id: 's-1', date: '2026-11-16', title: 'Strength A', status: 'COMPLETED', modified: false, variant: 'ORIGINAL_60', planSlotId: 'v2.1-W1-MON', planVersion: 'v2.1', scheduledDate: '2026-11-16', durationMin: 55, rpe: 7, notes: 'FT-NOTE', blocks: [] });
  put('daily', { date: '2026-11-16', steps: { state: 'OBSERVED', value: 7000 }, sleepH: { state: 'OBSERVED', value: 6 }, pain: { state: 'OBSERVED', value: 3 } });
  if (!st.addWeight({ date: '2026-11-16', kg: '98.4' }).ok) throw new Error('w');
  localStorage.setItem('hyrox.ai-owner-code', 'OWNER-CODE-SYNTH-1');
};
async function boot(page, opts) {
  opts = opts || {};
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  const reqs = []; page.on('request', (r) => { if (!/^(data|blob):/.test(r.url())) reqs.push(r.url()); });
  await page.clock.setFixedTime(new Date(NOW));
  await page.addInitScript((mode) => {
    window.__shared = [];
    if (mode === 'none') { try { delete Navigator.prototype.share; delete Navigator.prototype.canShare; } catch (e) { /* */ } Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true }); return; }
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d) => mode !== 'reject' && !!(d && d.files && d.files.length) });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => {
      const f = d.files[0]; window.__shared.push({ name: f.name, type: f.type, text: await f.text() });
      if (mode === 'abort') { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; }
      if (mode === 'error') { const e = new Error('blocked'); e.name = 'NotAllowedError'; throw e; }
    } });
  }, opts.share || 'ok');
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  if (opts.seed !== false) await page.evaluate(seedFn);
  await page.reload();
  await expect(page.getByTestId('app-error')).toBeHidden();
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('coach-export').scrollIntoViewIfNeeded();
  return { errs, reqs };
}
const allKeys = (page) => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
const panelText = async (page) => (await page.getByTestId('coach-export').innerText()).toLowerCase();

for (const W of [320, 390]) {
  test(`CE-E-01 ${W}px: review screen, defaults, counts, 16 px inputs and 44 px targets; no file before Create (Chrome emulation, not Safari/WebKit)`, async ({ page }) => {
    await page.setViewportSize({ width: W, height: 844 });
    const { errs } = await boot(page);
    await expect(page.getByTestId('ce-range')).toHaveValue('14');
    for (const [k, on] of [['training', true], ['nutrition', true], ['body', true], ['steps', true], ['recovery', false], ['symptoms', false], ['goals', true], ['freeText', false]])
      expect(await page.getByTestId('ce-cat-' + k).isChecked(), k).toBe(on);
    await expect(page.getByTestId('ce-preview')).toContainText('Training 1');
    await expect(page.getByTestId('ce-preview')).toContainText('Nutrition 1');
    await expect(page.getByTestId('ce-preview')).toContainText('No file exists yet');
    expect(await page.evaluate(() => window.__shared.length)).toBe(0);
    const sizes = await page.getByTestId('coach-export').evaluate((c) => [...c.querySelectorAll('select, input[type=date]')].map((e) => parseFloat(getComputedStyle(e).fontSize)));
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(16);
    for (const id of ['ce-create', 'ce-range']) expect((await page.getByTestId(id).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.getByTestId('ce-cat-freeText').check();
    await expect(page.getByTestId('ce-freetext-warning')).toContainText('Notes can contain anything you typed');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const w of FORBIDDEN) expect(await panelText(page)).not.toContain(w);
    expect(errs).toEqual([]);
  });
}

test.describe('Export for AI Coaching 390px (Chrome emulation, not Safari/WebKit)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('CE-E-02/06/09 share resolves (stubbed): one JSON file handed over with honest wording, zero network requests, storage and backup unchanged', async ({ page }) => {
    const { reqs, errs } = await boot(page);
    const [dl0] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-btn').click()]);
    const backup0 = JSON.parse(fs.readFileSync(await dl0.path(), 'utf8'));
    const before = await allKeys(page); // after the normal backup (which records its own backup note)
    const n0 = reqs.length;
    await page.getByTestId('ce-create').click();
    await expect(page.getByTestId('ce-status')).toHaveAttribute('data-kind', 'handed');
    await expect(page.getByTestId('ce-status')).toContainText('cannot see where the file went');
    await expect(page.getByTestId('ce-ready')).toContainText('Snapshot ready: 14 days, 5 categories,');
    await expect(page.getByTestId('ce-privacy')).toContainText('Do not create a sharing link');
    expect(reqs.slice(n0)).toEqual([]);
    const shared = await page.evaluate(() => window.__shared);
    expect(shared.length).toBe(1);
    expect(shared[0].type).toBe('application/json');
    expect(shared[0].name).toMatch(/^hyrox-coaching-20261118-120000-[a-z0-9]{4}\.json$/);
    const snap = JSON.parse(shared[0].text);
    expect(snap.kind).toBe('hyrox-coaching-snapshot');
    expect(snap.range).toEqual({ from: '2026-11-05', to: '2026-11-18', days: 14 });
    expect(snap.training.planned.find((p) => p.slotId === 'v2.1-W1-MON')).toMatchObject({ date: '2026-11-16', slotStatus: 'COMPLETED', linkedSessionIds: ['s-1'] });
    expect(snap.training.noActivePlanDates).toEqual(['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
    expect(snap.nutrition.unconfirmedMeals).toEqual([{ id: 'm-2', date: '2026-11-17', lifecycle: 'DRAFT' }]);
    for (const bad of ['SECRET-DRAFT-NAME', 'OWNER-CODE-SYNTH-1', 'FT-NOTE', 'FT-DESC', 'FT-LABEL', 'sleepH', '"pain"']) expect(shared[0].text).not.toContain(bad);
    for (const w of FORBIDDEN) expect(await panelText(page)).not.toContain(w);
    expect(await allKeys(page)).toEqual(before);
    // The snapshot cannot be restored; the normal backup is unchanged before/after.
    await page.getByTestId('import-file').setInputFiles({ name: shared[0].name, mimeType: 'application/json', buffer: Buffer.from(shared[0].text) });
    await expect(page.getByTestId('panel-settings')).toContainText('not a HYROX tracker backup');
    const [dl1] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-btn').click()]);
    const backup1 = JSON.parse(fs.readFileSync(await dl1.path(), 'utf8'));
    delete backup0.exportedAt; delete backup1.exportedAt;
    expect(backup1).toEqual(backup0);
    const after = await allKeys(page);
    expect(after['hyrox.v1']).toBe(before['hyrox.v1']);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(errs).toEqual([]);
  });

  test('CE-E-03 share cancelled (AbortError): "Share cancelled", snapshot still ready, no success wording; Share again works', async ({ page }) => {
    await boot(page, { share: 'abort' });
    await page.getByTestId('ce-create').click();
    await expect(page.getByTestId('ce-status')).toHaveAttribute('data-kind', 'cancelled');
    await expect(page.getByTestId('ce-status')).toContainText('Share cancelled. Nothing was sent.');
    await expect(page.getByTestId('ce-ready')).toBeVisible();
    expect(await panelText(page)).not.toContain('handed to');
    await page.waitForTimeout(750);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ce-download').click()]);
    expect(dl.suggestedFilename()).toMatch(/^hyrox-coaching-.*\.json$/);
    await expect(page.getByTestId('ce-status')).toHaveAttribute('data-kind', 'downloaded');
    await expect(page.getByTestId('ce-status')).toHaveText(/^Download started\./);
  });

  test('CE-E-04 file sharing not available: the download fallback runs and says so', async ({ page }) => {
    await boot(page, { share: 'none' });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ce-create').click()]);
    const text = fs.readFileSync(await dl.path(), 'utf8');
    expect(JSON.parse(text).kind).toBe('hyrox-coaching-snapshot');
    await expect(page.getByTestId('ce-status')).toHaveAttribute('data-kind', 'fallback');
    await expect(page.getByTestId('ce-status')).toContainText('Sharing a file is not available here, so the file was sent to Downloads.');
  });

  test('CE-E-04b the phone refuses this file type (canShare false): download fallback', async ({ page }) => {
    await boot(page, { share: 'reject' });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ce-create').click()]);
    expect(dl.suggestedFilename()).toMatch(/\.json$/);
    await expect(page.getByTestId('ce-status')).toHaveAttribute('data-kind', 'fallback');
    expect(await page.evaluate(() => window.__shared.length)).toBe(0);
  });

  test('CE-E-05 share throws another error: error label, storage unchanged', async ({ page }) => {
    await boot(page, { share: 'error' });
    const before = await allKeys(page);
    await page.getByTestId('ce-create').click();
    await expect(page.getByTestId('ce-status')).toHaveAttribute('data-kind', 'error');
    await expect(page.getByTestId('ce-status')).toContainText('Could not hand over the file: NotAllowedError. Nothing was changed. Try Download instead.');
    expect(await allKeys(page)).toEqual(before);
  });

  test('CE-E-06b offline: creating and sharing still works with zero network requests', async ({ page, context }) => {
    const { reqs } = await boot(page);
    await context.setOffline(true);
    const n0 = reqs.length;
    await page.getByTestId('ce-create').click();
    await expect(page.getByTestId('ce-status')).toHaveAttribute('data-kind', 'handed');
    expect(reqs.slice(n0)).toEqual([]);
    await context.setOffline(false);
  });

  test('CE-E-08 navigation and double tap: one file per tap; leaving Settings drops the snapshot and the selection', async ({ page }) => {
    await boot(page);
    await page.getByTestId('ce-cat-recovery').check();
    await page.getByTestId('ce-create').dblclick();
    await expect(page.getByTestId('ce-status')).toHaveAttribute('data-kind', 'handed');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__shared.length)).toBe(1);
    expect(JSON.parse(await page.evaluate(() => window.__shared[0].text)).selection.recovery).toBe(true);
    await page.getByTestId('tab-today').click();
    await page.getByTestId('tab-settings').click();
    await expect(page.getByTestId('ce-ready')).toHaveCount(0);
    expect(await page.getByTestId('ce-cat-recovery').isChecked()).toBe(false);
    await page.getByTestId('ce-create').click();
    await expect(page.getByTestId('ce-status')).toHaveAttribute('data-kind', 'handed');
    const names = await page.evaluate(() => window.__shared.map((s) => s.name));
    expect(names.length).toBe(2); expect(names[0]).not.toBe(names[1]);
  });

  test('nothing in range / no data: no file and an honest message; custom future dates cannot be chosen', async ({ page }) => {
    await boot(page, { seed: false });
    await expect(page.getByTestId('ce-preview')).toContainText('No records in this range for the selected categories. No file was created.');
    await expect(page.getByTestId('ce-create')).toBeDisabled();
    await page.getByTestId('ce-range').selectOption('custom');
    await expect(page.getByTestId('ce-to')).toHaveAttribute('max', '2026-11-18');
    expect(await page.evaluate(() => window.__shared.length)).toBe(0);
  });
});
