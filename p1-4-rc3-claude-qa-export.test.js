'use strict';
// Claude independent QA of Grok's P1.4-RC2 (source bcbc7b4d2959), 23 Nov 2026: fixes delivered as P1.4-RC3.
// D  coaching export: the Garmin intensity minutes typed in the morning log are part of the Steps category.
// Synthetic data only. FAIL-FIRST tests fail on bcbc7b4d2959; GUARD tests pass before and after.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const HD = require(path.join(ROOT, 'src', 'data', 'hyrox-data.js'));
const HN = require(path.join(ROOT, 'src', 'data', 'hyrox-nutrition.js'));
const HC = require(path.join(ROOT, 'src', 'data', 'hyrox-coach.js'));
const X = require(path.join(ROOT, 'src', 'data', 'hyrox-coach-export.js'));
// ---------- D: coaching export ----------
const NOW = new Date('2026-11-23T09:00:00Z'), T = '2026-11-20T05:00:00.000Z';
function store(daily) {
  const m = { 'hyrox.v1': JSON.stringify({ version: 2, weight: [{ id: 'w1', date: '2026-11-22', kg: 97.5, createdAt: T }], workouts: [], nutrition: [], daily }) };
  const st = HD.createStore({ getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }, { now: () => NOW });
  return { st, m };
}
const snap = (daily, sel) => { const { st, m } = store(daily); const before = JSON.stringify(m);
  const r = X.build(X.collect(st, { HD, HN, HC, to: '2026-11-23', planned: [], noActivePlanDates: [] }), { from: '2026-11-17', to: '2026-11-23', now: NOW, rand: () => 0.5, selection: sel });
  assert.strictEqual(JSON.stringify(m), before, 'export is read-only'); assert.strictEqual(r.ok, true, JSON.stringify(r)); return r.snapshot; };
const im = (v) => ({ state: 'OBSERVED', value: v, source: 'GARMIN_MANUAL' });
const day = (date, extra) => Object.assign({ id: 'daily-' + date, date, createdAt: T }, extra);

test('D FAIL-FIRST: typed Garmin intensity minutes are in steps.daily; explicit 0 is 0, nothing recorded is null, malformed is INVALID (never 0)', () => {
  const s = snap([day('2026-11-22', { steps: { state: 'OBSERVED', value: 9000 }, intensityMin: im(46) }), day('2026-11-21', { intensityMin: im(0) }),
    day('2026-11-20', { steps: { state: 'OBSERVED', value: 0 } }), day('2026-11-19', { intensityMin: { state: 'OBSERVED', value: 'lots', source: 'GARMIN_MANUAL' } }),
    day('2026-11-18', { intensityMin: { state: 'OBSERVED', value: 30 } }), day('2026-11-17', { sleepH: { state: 'OBSERVED', value: 7 } })]);
  const by = Object.fromEntries(s.steps.daily.map((d) => [d.date, d]));
  assert.deepStrictEqual(by['2026-11-22'].garminIntensityMin, { state: 'OBSERVED', value: 46, source: 'GARMIN_MANUAL' }); // 46, never doubled
  assert.deepStrictEqual(by['2026-11-21'].garminIntensityMin, { state: 'OBSERVED', value: 0, source: 'GARMIN_MANUAL' });
  assert.strictEqual(by['2026-11-21'].steps, null);                                   // intensity only: steps unknown, not 0
  assert.strictEqual(by['2026-11-20'].garminIntensityMin, null);                      // steps 0 recorded, intensity not recorded
  assert.deepStrictEqual(by['2026-11-20'].steps, { state: 'OBSERVED', value: 0 });
  assert.deepStrictEqual(by['2026-11-19'].garminIntensityMin, { state: 'INVALID', value: null });
  assert.deepStrictEqual(by['2026-11-18'].garminIntensityMin, { state: 'INVALID', value: null }); // no source
  assert.strictEqual(by['2026-11-17'], undefined);                                    // a sleep-only day is not a steps row
  assert.match(s.steps.intensityNote, /already counts vigorous minutes double/); assert.match(s.steps.intensityNote, /unknown, not 0/);
  assert.match(s.unavailable.deviceImportedActivity.note, /Garmin-derived observation/);
  assert.match(s.unavailable.deviceImportedActivity.note, /typed by the owner as Garmin shows them \(steps\.daily\)/);
  assert.strictEqual(X.LABELS ? X.LABELS.steps : 'Steps and intensity minutes', 'Steps and intensity minutes');
});

test('D GUARD: intensity minutes follow the Steps choice only; recovery and symptoms stay off by default; no weekly sum is invented', () => {
  const daily = [day('2026-11-22', { steps: { state: 'OBSERVED', value: 9000 }, intensityMin: im(46), pain: { state: 'OBSERVED', value: 3 }, sleepH: { state: 'OBSERVED', value: 7 } })];
  const off = snap(daily, { training: true, nutrition: true, body: true, steps: false, recovery: false, symptoms: false, goals: true, freeText: false });
  assert.strictEqual(off.steps, undefined); assert.strictEqual(JSON.stringify(off).includes('garminIntensityMin'), false);
  const def = snap(daily);
  assert.strictEqual(def.recovery, undefined); assert.strictEqual(def.symptoms, undefined);
  assert.strictEqual(JSON.stringify(def.derived).includes('ntensity'), false);
});
