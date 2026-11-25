'use strict';
// P1.1: morning log helpers (src/data/hyrox-morning.js) - Garmin intensity minutes (one weighted daily total, Mon-Sun weekly
// sum with coverage), kg/lb display and input, and that the UNCHANGED data layer (and the older data layers kept for rollback)
// keep the new check-in field through save, export and restore. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const HM = require(path.join(ROOT, 'src', 'data', 'hyrox-morning.js'));
const HD = require(path.join(ROOT, 'src', 'data', 'hyrox-data.js'));
const NOW = new Date('2026-11-22T09:00:00.000Z'); // Sun 22 Nov 2026, 12:00 Asia/Qatar
const T = '2026-11-22T09:00:00.000Z';
function mem() { const m = {}; return { getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, _m: m }; }
const im = (v) => ({ state: 'OBSERVED', value: v, source: 'GARMIN_MANUAL' });
const day = (date, extra) => Object.assign({ id: 'daily-' + date, date, createdAt: T }, extra || {});

test('P1.1 intensity: 30 moderate + 8 vigorous is entered as Garmin shows it - 46 - and is never multiplied again', () => {
  const p = HM.intensityParse('46');
  assert.deepStrictEqual(p, { ok: true, value: 46 });
  const u = HM.intensityUpdate(null, '2026-11-21', p.value, '2026-11-22');
  assert.strictEqual(u.ok, true);
  assert.deepStrictEqual(u.rec, { id: 'daily-2026-11-21', date: '2026-11-21', intensityMin: { state: 'OBSERVED', value: 46, source: 'GARMIN_MANUAL' } });
  assert.deepStrictEqual(HM.intensityRead(u.rec), { state: 'OBSERVED', value: 46 });
  assert.strictEqual(HM.weeklyIntensity('2026-11-22', [u.rec], 1)[0].total, 46); // not 92
});

test('P1.1 intensity: blank is "leave as it is", explicit 0 is a recorded zero, bad input is refused', () => {
  assert.deepStrictEqual(HM.intensityParse(''), { blank: true });
  assert.deepStrictEqual(HM.intensityParse('   '), { blank: true });
  assert.deepStrictEqual(HM.intensityParse('0'), { ok: true, value: 0 });
  assert.deepStrictEqual(HM.intensityParse('1,200'), { ok: true, value: 1200 });
  assert.deepStrictEqual(HM.intensityParse('2880'), { ok: true, value: 2880 });
  for (const bad of ['-5', '12.5', '2881', '99999', 'abc', '4 6x', '1e2']) assert.strictEqual(HM.intensityParse(bad).ok, false, bad);
  const z = HM.intensityUpdate(null, '2026-11-21', 0, '2026-11-22');
  assert.deepStrictEqual(HM.intensityRead(z.rec), { state: 'OBSERVED', value: 0 });
  for (const v of [-1, 2881, 1.5, NaN, '46', null]) assert.strictEqual(HM.intensityUpdate(null, '2026-11-21', v, '2026-11-22').ok, false, String(v));
});

test('P1.1 intensity: future and impossible dates are refused; today and past dates are accepted', () => {
  assert.strictEqual(HM.intensityUpdate(null, '2026-11-23', 10, '2026-11-22').ok, false);
  assert.match(HM.intensityUpdate(null, '2026-11-23', 10, '2026-11-22').error, /future date/);
  assert.strictEqual(HM.intensityUpdate(null, '2026-02-30', 10, '2026-11-22').ok, false);
  assert.strictEqual(HM.intensityUpdate(null, 'yesterday', 10, '2026-11-22').ok, false);
  assert.strictEqual(HM.intensityUpdate(null, '2026-11-22', 10, '2026-11-22').ok, true);
  assert.strictEqual(HM.intensityUpdate(null, '2025-12-31', 10, '2026-11-22').ok, true);
});

test('P1.1 intensity: an edit upserts the same record and leaves every other check-in value exactly as it was', () => {
  const existing = day('2026-11-21', { steps: { state: 'OBSERVED', value: 8123 }, sleepH: { state: 'OBSERVED', value: 6.5 }, rhr: { state: 'DECLINED', value: null },
    limp: { state: 'OBSERVED', value: false }, stepTargetOverride: 9000, notes: 'keep me', futureField: { a: [1, 2] }, intensityMin: im(30) });
  const before = JSON.stringify(existing);
  const u = HM.intensityUpdate(existing, '2026-11-21', 46, '2026-11-22');
  assert.strictEqual(JSON.stringify(existing), before, 'the input record is not modified');
  assert.strictEqual(u.previous, 30); assert.strictEqual(u.changed, true); assert.strictEqual(u.rec.id, 'daily-2026-11-21');
  const rest = Object.assign({}, u.rec); delete rest.intensityMin;
  const want = JSON.parse(before); delete want.intensityMin;
  assert.deepStrictEqual(rest, want);
  assert.strictEqual(HM.intensityUpdate(u.rec, '2026-11-21', 46, '2026-11-22').changed, false);
  const c = HM.intensityClear(u.rec);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(c, 'intensityMin'), false);
  assert.deepStrictEqual(c, want);
});

test('P1.1 intensity: anything malformed in storage reads as INVALID (unknown) - never as 0 and never as a number', () => {
  const bad = [im(-1), im(2881), im(4.5), im('46'), im(NaN), { state: 'OBSERVED', value: 46 }, { state: 'OBSERVED', value: 46, source: 'DEVICE' },
    { state: 'ESTIMATED', value: 46, source: 'GARMIN_MANUAL' }, 46, '46', [46], true, { state: 'MISSING', value: 3 }];
  for (const b of bad) assert.deepStrictEqual(HM.intensityRead(day('2026-11-21', { intensityMin: b })), { state: 'INVALID', value: null }, JSON.stringify(b));
  for (const m of [undefined, null, { state: 'MISSING', value: null }]) assert.deepStrictEqual(HM.intensityRead(day('2026-11-21', m === undefined ? {} : { intensityMin: m })), { state: 'MISSING', value: null });
  assert.deepStrictEqual(HM.intensityRead(null), { state: 'MISSING', value: null });
});

test('P1.1 weekly sum: Monday-Sunday, recorded days only, coverage reported, nothing scaled or filled in', () => {
  // week Mon 16 - Sun 22 Nov 2026; previous week Mon 9 - Sun 15
  const d = [day('2026-11-16', { intensityMin: im(46) }), day('2026-11-18', { intensityMin: im(0) }), day('2026-11-20', { intensityMin: im(92) }),
    day('2026-11-19', { intensityMin: im(-3) }), day('2026-11-15', { intensityMin: im(30) }), day('2026-11-09', { intensityMin: im(20) }), day('2026-11-08', { intensityMin: im(999) }),
    day('2026-11-17', { steps: { state: 'OBSERVED', value: 9000 } })];
  const w = HM.weeklyIntensity('2026-11-22', d, 2);
  assert.strictEqual(w.length, 2);
  assert.deepStrictEqual(w[1], { weekStart: '2026-11-16', weekEnd: '2026-11-22', daysElapsed: 7, daysRecorded: 3, daysInvalid: 1, daysMissing: 3, total: 138, complete: true, reference: 150 });
  assert.deepStrictEqual(w[0], { weekStart: '2026-11-09', weekEnd: '2026-11-15', daysElapsed: 7, daysRecorded: 2, daysInvalid: 0, daysMissing: 5, total: 50, complete: true, reference: 150 });
  // Sunday 8 Nov belongs to the week before (Mon 2 - Sun 8), not to Mon 9's week
  assert.strictEqual(HM.weeklyIntensity('2026-11-22', d, 3)[0].total, 999);
});

test('P1.1 weekly sum: an unfinished week counts only the days so far; a week with no value is unknown (null), not 0; an explicit 0 is 0', () => {
  const d = [day('2026-11-16', { intensityMin: im(46) }), day('2026-11-20', { intensityMin: im(60) })];
  const wed = HM.weeklyIntensity('2026-11-18', d, 1)[0];
  assert.deepStrictEqual([wed.daysElapsed, wed.daysRecorded, wed.daysMissing, wed.total, wed.complete], [3, 1, 2, 46, false]); // Friday's 60 is not counted yet
  assert.strictEqual(HM.weeklyIntensity('2026-11-22', [], 1)[0].total, null);
  assert.strictEqual(HM.weeklyIntensity('2026-11-22', [day('2026-11-17', { intensityMin: im(-1) })], 1)[0].total, null);
  const zero = HM.weeklyIntensity('2026-11-22', [day('2026-11-17', { intensityMin: im(0) })], 1)[0];
  assert.deepStrictEqual([zero.total, zero.daysRecorded], [0, 1]);
  assert.deepStrictEqual(HM.weeklyIntensity('not-a-date', d, 1), []);
});

test('P1.1 weekly sum: week rollover at the Monday boundary; sessions, walks and steps never change it', () => {
  const d = [day('2026-11-22', { intensityMin: im(40), steps: { state: 'OBSERVED', value: 15000 } }), day('2026-11-23', { intensityMin: im(10) })];
  assert.strictEqual(HM.weeklyIntensity('2026-11-22', d, 1)[0].total, 40);
  const mon = HM.weeklyIntensity('2026-11-23', d, 2);
  assert.deepStrictEqual([mon[0].weekStart, mon[0].total, mon[1].weekStart, mon[1].total, mon[1].daysElapsed], ['2026-11-16', 40, '2026-11-23', 10, 1]);
  assert.strictEqual(HM.weeklyIntensity.length, 3); // (endDate, dailies, weeks): no workout, walk, step or calorie input exists
});

test('P1.1 units: kg stays the stored unit; lb is display and input; values round to one decimal', () => {
  assert.strictEqual(HM.kgToLb(100), 220.5);
  assert.strictEqual(HM.lbToKg(220.5), 100);
  assert.strictEqual(HM.kgToLb(97.5), 215);
  assert.strictEqual(HM.weightText(98.4, 'kg'), '98.4 kg');
  assert.strictEqual(HM.weightText(98.4, 'lb'), '216.9 lb');
  assert.strictEqual(HM.weightText(98.4, 'stone'), '98.4 kg'); // anything unknown falls back to kg
  assert.strictEqual(HM.weightText(NaN, 'lb'), '');
  assert.deepStrictEqual(HM.weightParse('215', 'lb'), { ok: true, kg: 97.5 });
  assert.deepStrictEqual(HM.weightParse('97,6', 'kg'), { ok: true, kg: 97.6 });
  assert.deepStrictEqual(HM.weightParse('', 'lb'), { blank: true });
  for (const bad of ['abc', '-200', '12.345', '1e3', '215lb']) assert.strictEqual(HM.weightParse(bad, 'lb').ok, false, bad);
  assert.strictEqual(HM.weightParse('19.9', 'kg').ok, false); assert.strictEqual(HM.weightParse('400.1', 'kg').ok, false);
  assert.deepStrictEqual(HM.weightParse('44', 'lb'), { ok: true, kg: 20 }); // 19.96 kg stores as 20.0 kg - the range is judged on the stored value
  assert.strictEqual(HM.weightParse('43.9', 'lb').ok, false); // would store as 19.9 kg
  assert.strictEqual(HM.weightParse('881.8', 'lb').ok, true); assert.strictEqual(HM.weightParse('882.5', 'lb').ok, false);
});

test('P1.1 units: no cumulative drift - showing a stored value in lb and saving what is shown, any number of times, never moves the stored kg', () => {
  let worst = 0;
  for (let i = 200; i <= 4000; i++) { // every storable weight from 20.0 to 400.0 kg
    const kg = i / 10;
    let cur = kg;
    for (let n = 0; n < 5; n++) { const shown = HM.kgToLb(cur); const back = HM.weightParse(String(shown), 'lb'); assert.strictEqual(back.ok, true); cur = back.kg; }
    assert.strictEqual(cur, kg, 'drift at ' + kg + ' kg');
    assert.strictEqual(HM.sameWeight(String(HM.kgToLb(kg)), 'lb', kg), true);
    worst = Math.max(worst, Math.abs(HM.kgToLb(kg) - kg * HM.LB_PER_KG));
  }
  assert.ok(worst <= 0.05 + 1e-9);
  // a typed lb value is stored as the nearest 0.1 kg, so it can come back up to 0.1 lb different (documented limit, never more)
  let maxDiff = 0;
  for (let i = 441; i <= 8818; i++) { const lb = i / 10; const p = HM.weightParse(String(lb), 'lb'); if (p.ok) maxDiff = Math.max(maxDiff, Math.abs(HM.kgToLb(p.kg) - lb)); }
  assert.ok(maxDiff <= 0.1 + 1e-9, String(maxDiff));
  assert.strictEqual(HM.weightDelta(-0.5, 'lb'), -1.1); assert.strictEqual(HM.weightDelta(-0.5, 'kg'), -0.5);
});

test('P1.1 preference: the unit is one field on the shared settings record; missing or anything else means kg; other fields are kept', () => {
  assert.strictEqual(HM.unitFromSettings(null), 'kg');
  for (const bad of [{}, { weightUnit: 'LB' }, { weightUnit: 5 }, { weightUnit: 'stone' }, 'lb', []]) assert.strictEqual(HM.unitFromSettings(bad), 'kg', JSON.stringify(bad));
  assert.strictEqual(HM.unitFromSettings({ weightUnit: 'lb' }), 'lb');
  const fresh = { id: 'app-settings', date: '2026-11-01', rhrBaselineBpm: 61, stepBaselineMode: 'AUTO', myFoods: [{ k: 1 }], favFoods: ['a'], planBlocks: [{ id: 'b2' }], later: { x: 1 } };
  const before = JSON.stringify(fresh);
  const lb = HM.settingsWithUnit(fresh, 'lb', 'app-settings', '2026-11-22');
  assert.strictEqual(JSON.stringify(fresh), before);
  assert.deepStrictEqual(lb, Object.assign({}, JSON.parse(before), { weightUnit: 'lb' }));
  assert.deepStrictEqual(HM.settingsWithUnit(lb, 'kg', 'app-settings', '2026-11-22'), JSON.parse(before)); // back to kg = exactly the record as it was
  assert.deepStrictEqual(HM.settingsWithUnit(null, 'lb', 'app-settings', '2026-11-22'), { id: 'app-settings', date: '2026-11-22', weightUnit: 'lb' });
});

test('P1.1 preference: the unchanged data layer saves, exports and restores the unit with the rest of the settings record', () => {
  const storage = mem(), st = HD.createStore(storage, { now: () => NOW });
  assert.strictEqual(st.putRecord('ownerSettings', { id: HD.SETTINGS_ID, date: '2026-11-20', rhrBaselineBpm: 61, stepBaselineMode: 'AUTO', favFoods: ['x:1'] }).ok, true);
  const r = st.putRecord('ownerSettings', HM.settingsWithUnit(st.settings().record, 'lb', HD.SETTINGS_ID, '2026-11-22')); assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  const set = HD.createStore(storage, { now: () => NOW }).settings();
  assert.strictEqual(HM.unitFromSettings(set.record), 'lb'); assert.strictEqual(set.rhrBaselineBpm, 61); assert.deepStrictEqual(set.record.favFoods, ['x:1']);
  const text = st.exportJSON(), s2 = mem(), st2 = HD.createStore(s2, { now: () => NOW });
  const p = st2.previewImport(text); assert.strictEqual(p.ok, true);
  assert.strictEqual(st2.applyImport(text, { confirm: 'REPLACE', expectCurrent: p.preview.current, expectCurrentExt: p.preview.currentExt }).ok, true);
  assert.strictEqual(HM.unitFromSettings(HD.createStore(s2, { now: () => NOW }).settings().record), 'lb');
  // weights themselves are stored in kg whatever the preference is
  assert.strictEqual(st2.addWeight({ date: '2026-11-22', kg: HM.weightParse('215', 'lb').kg }).ok, true);
  assert.deepStrictEqual(JSON.parse(s2._m['hyrox.v1']).weight.map((w) => w.kg), [97.5]);
});

// ---------- the unchanged data layer keeps the field: save, read, export, restore ----------
function seedStore(HDx, storage) {
  const st = HDx.createStore(storage, { now: () => NOW });
  const base = day('2026-11-21', { steps: { state: 'OBSERVED', value: 8123 }, sleepH: { state: 'OBSERVED', value: 6.5 } });
  let r = st.putRecord('daily', base); assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  const u = HM.intensityUpdate(st.records('daily').find((x) => x.date === '2026-11-21'), '2026-11-21', 46, '2026-11-22');
  r = st.putRecord('daily', u.rec); assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  r = st.putRecord('daily', HM.intensityUpdate(null, '2026-11-20', 0, '2026-11-22').rec); assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  return st;
}
const intens = (list) => list.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).map((x) => [x.date, HM.intensityRead(x), x.steps ? x.steps.value : null]);
const WANT = [['2026-11-20', { state: 'OBSERVED', value: 0 }, null], ['2026-11-21', { state: 'OBSERVED', value: 46 }, 8123]];

test('P1.1 storage: the data layer (byte-identical to RC2) saves the field through its normal validated path, one record per date, data version 2', () => {
  const storage = mem(), st = seedStore(HD, storage);
  const list = st.records('daily');
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(intens(list), WANT);
  const raw = JSON.parse(storage._m['hyrox.v1']);
  assert.strictEqual(raw.version, 2);
  assert.deepStrictEqual(raw.daily.find((x) => x.date === '2026-11-21').intensityMin, { state: 'OBSERVED', value: 46, source: 'GARMIN_MANUAL' });
  assert.strictEqual(raw.daily.find((x) => x.date === '2026-11-21').sleepH.value, 6.5);
  // the existing rules still apply to the same record: a future date is refused and nothing is written
  const before = storage._m['hyrox.v1'];
  assert.strictEqual(st.putRecord('daily', { id: 'daily-2026-11-25', date: '2026-11-25', intensityMin: im(10) }).ok, false);
  assert.strictEqual(storage._m['hyrox.v1'], before);
});

test('P1.1 backup: export carries the field; preview and restore bring it back exactly; an RC2-era backup without it restores unchanged', () => {
  const st = seedStore(HD, mem());
  const chk = st.exportChecked();
  assert.strictEqual(chk.ok, true); assert.strictEqual(chk.restorable, true, JSON.stringify(chk.reasons));
  const text = chk.text, parsed = JSON.parse(text);
  assert.strictEqual(parsed.app, 'hyrox-app'); assert.strictEqual(parsed.version, 2);
  assert.deepStrictEqual(intens(parsed.daily), WANT);
  const s2 = mem(), st2 = HD.createStore(s2, { now: () => NOW });
  const p = st2.previewImport(text); assert.strictEqual(p.ok, true, JSON.stringify(p.errors || p.message));
  const r = st2.applyImport(text, { confirm: 'REPLACE', expectCurrent: p.preview.current, expectCurrentExt: p.preview.currentExt }); assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(intens(HD.createStore(s2, { now: () => NOW }).records('daily')), WANT);
  // an older backup (no intensity field anywhere) is untouched by this feature
  const old = fs.readFileSync(path.join(__dirname, 'fixtures', 'p3-phase3-export.json'), 'utf8');
  assert.strictEqual(old.includes('intensityMin'), false);
  const s3 = mem(), st3 = HD.createStore(s3, { now: () => NOW });
  const p3 = st3.previewImport(old); assert.strictEqual(p3.ok, true, JSON.stringify(p3.errors || p3.message));
  assert.strictEqual(st3.applyImport(old, { confirm: 'REPLACE', expectCurrent: p3.preview.current, expectCurrentExt: p3.preview.currentExt }).ok, true);
  const after = HD.createStore(s3, { now: () => NOW });
  assert.ok(after.records('daily').every((x) => HM.intensityRead(x).state === 'MISSING'));
  assert.strictEqual(HM.weeklyIntensity('2026-11-22', after.records('daily'), 1)[0].total, null);
});

test('P1.1 storage: a restored backup with a malformed intensity value is kept as stored but read as unknown, and its other values still count', () => {
  const st = seedStore(HD, mem());
  const o = JSON.parse(st.exportJSON());
  o.daily.find((x) => x.date === '2026-11-21').intensityMin = { state: 'OBSERVED', value: 'lots', source: 'GARMIN_MANUAL' };
  const s2 = mem(), st2 = HD.createStore(s2, { now: () => NOW });
  const text = JSON.stringify(o), p = st2.previewImport(text); assert.strictEqual(p.ok, true, JSON.stringify(p.errors || p.message));
  assert.strictEqual(st2.applyImport(text, { confirm: 'REPLACE', expectCurrent: p.preview.current, expectCurrentExt: p.preview.currentExt }).ok, true);
  const rec = HD.createStore(s2, { now: () => NOW }).records('daily').find((x) => x.date === '2026-11-21');
  assert.deepStrictEqual(HM.intensityRead(rec), { state: 'INVALID', value: null });
  assert.strictEqual(rec.steps.value, 8123);
  const w = HM.weeklyIntensity('2026-11-22', HD.createStore(s2, { now: () => NOW }).records('daily'), 1)[0];
  assert.deepStrictEqual([w.total, w.daysRecorded, w.daysInvalid], [0, 1, 1]); // only the valid explicit 0 of 20 Nov counts
});

// ---------- downgrade: the older data layers keep the field ----------
const OLD = {
  'claude-p11.2': process.env.P113_P112_SRC || '/workspace/hyrox-p11-3-before/src',
  'claude-p11': process.env.P112_P11_SRC || '/workspace/hyrox-p11-2-before/src',
  'claude-p10b': process.env.P112_P10B_SRC || '/workspace/hyrox-p11-before/src',
  p9: process.env.P112_P9_SRC || '/workspace/hyrox-p9/src',
};
for (const [name, dir] of Object.entries(OLD)) {
  const present = fs.existsSync(path.join(dir, 'data', 'hyrox-data.js'));
  (present ? test : test.skip)(`P1.1 rollback: the ${name} data layer restores a P1.1 backup, keeps intensity minutes through its own save of the same check-in, and exports them again`, () => {
    const seeded = seedStore(HD, mem());
    assert.strictEqual(seeded.putRecord('ownerSettings', HM.settingsWithUnit({ id: HD.SETTINGS_ID, date: '2026-11-20', rhrBaselineBpm: 61, stepBaselineMode: 'AUTO' }, 'lb', HD.SETTINGS_ID, '2026-11-22')).ok, true);
    const text = seeded.exportJSON();
    const OLDHD = require(path.join(dir, 'data', 'hyrox-data.js'));
    const storage = mem(), st = OLDHD.createStore(storage, { now: () => NOW });
    const p = st.previewImport(text); assert.strictEqual(p.ok, true, JSON.stringify(p.errors || p.message));
    const r = st.applyImport(text, { confirm: 'REPLACE', expectCurrent: p.preview.current, expectCurrentExt: p.preview.currentExt }); assert.strictEqual(r.ok, true, JSON.stringify(r));
    const st2 = OLDHD.createStore(storage, { now: () => NOW });
    assert.deepStrictEqual(intens(st2.records('daily')), WANT);
    // the older build's own field-preserving save of that check-in (what its steps / check-in forms do: clone, change one value, put)
    const cur = JSON.parse(JSON.stringify(st2.records('daily').find((x) => x.date === '2026-11-21')));
    cur.steps = { state: 'OBSERVED', value: 9001 };
    assert.strictEqual(st2.putRecord('daily', cur).ok, true);
    const st3 = OLDHD.createStore(storage, { now: () => NOW });
    assert.deepStrictEqual(intens(st3.records('daily')), [WANT[0], ['2026-11-21', { state: 'OBSERVED', value: 46 }, 9001]]);
    assert.deepStrictEqual(intens(JSON.parse(st3.exportJSON()).daily), [WANT[0], ['2026-11-21', { state: 'OBSERVED', value: 46 }, 9001]]);
    // the older build's own baseline save (clone the fresh settings record, change one field, put) keeps the unit
    const set = JSON.parse(JSON.stringify(st3.settings().record)); set.rhrBaselineBpm = 60;
    assert.strictEqual(st3.putRecord('ownerSettings', set).ok, true);
    const back = OLDHD.createStore(storage, { now: () => NOW }).settings();
    assert.strictEqual(back.record.weightUnit, 'lb'); assert.strictEqual(back.rhrBaselineBpm, 60);
  });
}

// ---------- scope pins ----------
test('P1.1 scope: every RC2-pinned data, plan, block, nutrition, wellness, estimator, food, photo and server file is still byte-identical', () => {
  // Re-pointed by the P0 sprint photo + note fix (23 Nov 2026): see tests/p0-sprint-pins.js (3 photo/server files re-pinned on purpose).
  require('./p0-sprint-pins.js').checkRc2PinsWithSprint(ROOT);
  const src = fs.readFileSync(path.join(ROOT, 'src', 'data', 'hyrox-morning.js'), 'utf8');
  for (const banned of [/localStorage/, /fetch\(/, /XMLHttpRequest/, /kcal|calorie/i, /sessions|walks|workout/i.source ? /\b(sessions|walks)\b/ : null].filter(Boolean)) assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), banned);
});
