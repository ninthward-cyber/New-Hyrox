'use strict';

const path = require('path');
const fs = require('fs');
if (fs.existsSync('/workspace/hyrox-p2/tools/node_modules/@playwright/test')) {
  module.paths.unshift('/workspace/hyrox-p2/tools/node_modules');
}
const { expect } = require('@playwright/test');

const FIXTURES = path.join(__dirname, 'fixtures');

const SYNTH = {
  kg: '72.5',
  activityFull: 'SkiErg intervals',
  durationFull: '45',
  activityPartial: 'Half sim',
  durationPartial: '20',
  meal: 'Test oats',
  calories: '350',
  protein: '22.5',
};

// Phase 3: the classic forms live under Add -> Quick log; backup/restore under Settings.
async function gotoClassic(page) {
  await page.getByTestId('tab-add').click();
  await page.getByTestId('add-mode-classic').click();
}
async function gotoSettings(page) {
  await page.getByTestId('tab-settings').click();
}

async function addWeight(page, kg) {
  await gotoClassic(page);
  await page.getByTestId('weight-kg').fill(String(kg));
  await page.getByTestId('weight-submit').click();
}

async function addWorkout(page, { activity, durationMin, partial, notes }) {
  await gotoClassic(page);
  await page.getByTestId('workout-activity').fill(activity);
  await page.getByTestId('workout-duration').fill(String(durationMin));
  const box = page.getByTestId('workout-partial');
  if (partial) await box.check();
  else await box.uncheck();
  if (notes != null) await page.getByTestId('workout-notes').fill(notes);
  await page.getByTestId('workout-submit').click();
}

async function addNutrition(page, { label, calories, proteinG }) {
  await gotoClassic(page);
  if (label != null) await page.getByTestId('nutrition-label').fill(label);
  await page.getByTestId('nutrition-calories').fill(String(calories));
  await page.getByTestId('nutrition-protein').fill(String(proteinG));
  await page.getByTestId('nutrition-submit').click();
}

async function logFourSynthetic(page) {
  await addWeight(page, SYNTH.kg);
  await addWorkout(page, {
    activity: SYNTH.activityFull,
    durationMin: SYNTH.durationFull,
    partial: false,
    notes: 'Made-up session',
  });
  await addWorkout(page, {
    activity: SYNTH.activityPartial,
    durationMin: SYNTH.durationPartial,
    partial: true,
    notes: '',
  });
  await addNutrition(page, {
    label: SYNTH.meal,
    calories: SYNTH.calories,
    proteinG: SYNTH.protein,
  });
}

async function expectFourSyntheticVisible(page) {
  await gotoClassic(page);
  await page.getByTestId('weight-item').filter({ hasText: '72.5' }).waitFor();
  await page.getByTestId('workout-item').filter({ hasText: SYNTH.activityFull }).waitFor();
  const partial = page.getByTestId('workout-item').filter({ hasText: SYNTH.activityPartial });
  await partial.waitFor();
  await partial.getByTestId('workout-partial-badge').waitFor();
  await page.getByTestId('nutrition-item').filter({ hasText: SYNTH.meal }).waitFor();
  const totals = page.getByTestId('nutrition-total');
  await totals.waitFor();
  const text = await totals.innerText();
  if (!/350/.test(text) || !/22\.5/.test(text)) {
    throw new Error('nutrition totals did not show 350 kcal / 22.5 g, got: ' + text);
  }
}

function fixture(name) {
  return path.join(FIXTURES, name);
}

async function pickBackup(page, filePath) {
  await gotoSettings(page);
  await page.getByTestId('import-file').setInputFiles(filePath);
}

async function expectPreviewCounts(page, { weight, workouts, nutrition, partial }) {
  const preview = page.getByTestId('import-preview');
  await preview.waitFor({ state: 'visible' });
  await page.getByTestId('import-count-weight').waitFor({ state: 'visible' });
  await expect(page.getByTestId('import-count-weight')).toHaveText(String(weight));
  await expect(page.getByTestId('import-count-workouts')).toHaveText(String(workouts));
  await expect(page.getByTestId('import-count-nutrition')).toHaveText(String(nutrition));
  if (partial != null) {
    await expect(page.getByTestId('import-partial-count')).toHaveText(String(partial));
  }
  await expect(page.getByTestId('import-warning')).toBeVisible();
  await expect(page.getByTestId('import-confirm')).toBeVisible();
  await expect(page.getByTestId('import-cancel')).toBeVisible();
}

async function expectImportError(page) {
  await expect(page.getByTestId('import-error')).toBeVisible();
  await expect(page.getByTestId('import-error-message')).not.toHaveText('');
  // Liya 8d3afbf: one status line, always starting with "Not restored."
  await expect(page.getByTestId('import-status')).toBeVisible();
  await expect(page.getByTestId('import-status')).toHaveText(/^Not restored\./);
  await expect(page.getByTestId('import-preview')).toBeHidden();
  await expect(page.getByTestId('import-result')).toBeHidden();
  await expect(page.getByTestId('import-confirm')).toBeHidden();
}

module.exports = {
  SYNTH,
  gotoClassic,
  gotoSettings,
  FIXTURES,
  addWeight,
  addWorkout,
  addNutrition,
  logFourSynthetic,
  expectFourSyntheticVisible,
  fixture,
  pickBackup,
  expectPreviewCounts,
  expectImportError,
  fs,
  path,
};
