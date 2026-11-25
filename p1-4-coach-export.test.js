'use strict';
// Sprint D (P1.4) Export for AI Coaching: unit tests CE-U-01..25 from HNC-E-COACH-001 section 10 (synthetic data only).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const HD = require(path.resolve(__dirname, '../src/data/hyrox-data.js'));
const HN = require(path.resolve(__dirname, '../src/data/hyrox-nutrition.js'));
const HC = require(path.resolve(__dirname, '../src/data/hyrox-coach.js'));
const F = require('./fixtures/p1-4-coach-export-seed.js');
const modPath = path.resolve(__dirname, '../src/data/hyrox-coach-export.js');
const X = fs.existsSync(modPath) ? require(modPath) : null;

const RANGE = { from: '2026-11-05', to: '2026-11-18' }; // 14 days ending today (Qatar)
const ALL_ON = { training: true, nutrition: true, body: true, steps: true, recovery: true, symptoms: true, goals: true, freeText: true };
function run(opts, seedOpts) {
  const { s, st } = F.seed(seedOpts);
  const input = X.collect(st, { HD, HN, HC, to: (opts && opts.to) || RANGE.to, planned: (opts && opts.planned) || [], noActivePlanDates: (opts && opts.noActivePlanDates) || [] });
  const res = X.build(input, Object.assign({ from: RANGE.from, to: RANGE.to, now: F.NOW, rand: () => 0.5 }, opts || {}));
  return { s, st, input, res };
}
const keysDeep = (o, out = new Set()) => { if (o && typeof o === 'object') for (const k of Object.keys(o)) { out.add(k); keysDeep(o[k], out); } return out; };

describe('P1.4 coaching export (module present)', () => {
  it('the module exists and loads as plain UMD (window.HyroxCoachExport / require)', () => {
    assert.ok(X, 'src/data/hyrox-coach-export.js is missing');
    assert.equal(typeof X.build, 'function'); assert.equal(typeof X.collect, 'function');
  });
});

describe('P1.4 coaching export: envelope, dates and range', () => {
  it('CE-U-01 envelope: kind, schema version, snapshotId, generatedAt +03:00, timezone, range and selection', () => {
    const { res } = run();
    assert.equal(res.ok, true, JSON.stringify(res));
    const s = res.snapshot;
    assert.equal(s.kind, 'hyrox-coaching-snapshot'); assert.equal(s.coachSchemaVersion, '1.0');
    assert.match(s.snapshotId, /^cs-20261118-120000-[a-z0-9]{4}$/);
    assert.equal(s.generatedAt, '2026-11-18T12:00:00+03:00');
    assert.equal(s.timezone, 'Asia/Qatar');
    assert.deepEqual(s.range, { from: '2026-11-05', to: '2026-11-18', days: 14 });
    assert.deepEqual(s.selection, X.DEFAULTS);
    assert.equal(res.fileName, 'hyrox-coaching-' + s.snapshotId.slice(3) + '.json');
    assert.ok(!/backup/i.test(res.fileName));
    assert.equal(s.source.dataVersion, 2); assert.equal(s.source.storageState, 'ok');
  });
  it('CE-U-02 Qatar date boundary: 23:59:59 and 00:00:01 Qatar give the Qatar date in the id, file name and range check', () => {
    const before = X.qatarClock(new Date('2026-11-18T20:59:59.000Z'));
    const after = X.qatarClock(new Date('2026-11-18T21:00:01.000Z'));
    assert.equal(before.date, '2026-11-18'); assert.equal(after.date, '2026-11-19');
    assert.equal(before.compact, '20261118-235959'); assert.equal(after.compact, '20261119-000001');
    const { res } = run({ now: new Date('2026-11-18T21:00:01.000Z'), from: '2026-11-06', to: '2026-11-19' });
    assert.equal(res.ok, true); assert.match(res.fileName, /^hyrox-coaching-20261119-000001-/);
    const fut = run({ now: new Date('2026-11-18T20:59:59.000Z'), from: '2026-11-06', to: '2026-11-19' }).res;
    assert.equal(fut.ok, false); assert.equal(fut.code, 'range_future');
  });
  it('CE-U-03 range filter: only records inside the range; outside ones are counted, never exported; bad ranges refused', () => {
    const { res } = run();
    const w = res.snapshot.body.weight.map((x) => x.date);
    assert.deepEqual(w, ['2026-11-16', '2026-11-18']);
    assert.equal(res.snapshot.coverage.body.excluded.outOfRange, 1);
    assert.equal(X.checkRange('2026-11-10', '2026-11-09', '2026-11-18').code, 'range_order');
    assert.equal(X.checkRange('2025-01-01', '2026-11-18', '2026-11-18').code, 'range_long');
    assert.equal(X.checkRange('2026-02-30', '2026-11-18', '2026-11-18').code, 'range_invalid');
    assert.deepEqual(X.presetRange(14, '2026-11-18'), RANGE);
  });
});

describe('P1.4 coaching export: values, states and day codes', () => {
  it('CE-U-04 record match: exported sessions, walks, weights and waist equal the stored fields', () => {
    const { st, res } = run({ selection: ALL_ON });
    const ses = st.records('sessions').find((x) => x.id === 's-c1');
    const out = res.snapshot.training.sessions.find((x) => x.id === 's-c1');
    for (const k of ['date', 'title', 'status', 'variant', 'planSlotId', 'durationMin', 'rpe', 'createdAt', 'updatedAt', 'notes']) assert.deepEqual(out[k], ses[k], k);
    assert.equal(out.blocks[0].loadKg, 80); assert.equal(out.blocks[0].reps, 5);
    const wk = res.snapshot.training.walks[0], wr = st.records('walks')[0];
    assert.equal(wk.id, wr.id); assert.equal(wk.steps, 4200); assert.equal(wk.durationMin, 40);
    assert.equal(res.snapshot.body.waist[0].valueCm, 101.5);
  });
  it('CE-U-05 unknown is not zero: UNKNOWN exports null, an entered 0 stays 0, and every UNKNOWN in the file has value null', () => {
    const { res } = run();
    const m1 = res.snapshot.nutrition.meals.find((m) => m.id === 'm-c1');
    const oil = m1.components.find((c) => c.name === 'Cooking oil');
    assert.deepEqual(oil.kcal, { value: null, state: 'UNKNOWN' });
    const coffee = res.snapshot.nutrition.meals.find((m) => m.id === 'm-c2').components.find((c) => c.name === 'Black coffee');
    assert.deepEqual(coffee.kcal, { value: 0, state: 'KNOWN' });
    const bad = []; (function walk(o, p) { if (o && typeof o === 'object') { if (o.state === 'UNKNOWN' && o.value !== null) bad.push(p); for (const k of Object.keys(o)) walk(o[k], p + '.' + k); } })(res.snapshot, '');
    assert.deepEqual(bad, []);
    assert.deepEqual(res.snapshot.nutrition.quickEntries[0].carbsG, null);
  });
  it('CE-U-06 totals and states equal the app\u2019s own mealTotals (PARTIAL kept)', () => {
    const { st, res } = run();
    for (const m of st.records('meals').filter((x) => x.lifecycle === 'CONFIRMED')) assert.deepEqual(res.snapshot.nutrition.meals.find((x) => x.id === m.id).totals, HN.mealTotals(m));
    assert.equal(res.snapshot.nutrition.meals.find((x) => x.id === 'm-c1').totals.kcal.state, 'PARTIAL');
  });
  it('CE-U-07 unconfirmed meals appear only as id, date, lifecycle: no names or numbers leak', () => {
    const { res } = run({ selection: ALL_ON });
    assert.deepEqual(res.snapshot.nutrition.unconfirmedMeals, [{ id: 'm-d1', date: '2026-11-17', lifecycle: 'DRAFT' }]);
    assert.ok(!res.text.includes('FT-DRAFT-NAME'));
    assert.equal(res.snapshot.coverage.nutrition.excluded.unconfirmed, 1);
  });
  it('CE-U-08 day codes equal the app\u2019s dayState; fullDayKcal is null except D5/DF; one entry per date incl. D1', () => {
    const { st, res } = run();
    const meals = st.records('meals').concat(st.list('nutrition').map(HN.legacyToMeal));
    const atts = st.records('dayStates');
    assert.equal(res.snapshot.nutrition.days.length, 14);
    for (const d of res.snapshot.nutrition.days) {
      const want = HN.dayState(d.date, meals, atts.find((a) => a.date === d.date) || null);
      assert.equal(d.code, want.code, d.date); assert.equal(d.fullDayKcal, want.dayKcal, d.date);
      if (d.code !== 'D5' && d.code !== 'DF') assert.equal(d.fullDayKcal, null, d.date);
    }
    assert.equal(res.snapshot.nutrition.days.find((d) => d.date === '2026-11-05').code, 'D1');
    assert.equal(res.snapshot.nutrition.days.find((d) => d.date === '2026-11-16').code, 'D2');
    assert.ok(!('basis' in res.snapshot.nutrition.days[0]), 'the internal basis text is never exported');
  });
  it('CE-U-09 a photographed meal without an eaten amount stays unknown (nothing assumes 100%)', () => {
    const { input } = run();
    input.records.meals = input.records.meals.concat([{ id: 'm-ph', date: '2026-11-18', source: 'PHOTO_AI', lifecycle: 'CONFIRMED', ai: { mode: 'REAL' },
      components: [{ name: 'Strawberry yogurt', role: 'MAIN', kcal: { value: 150, state: 'ESTIMATED' }, proteinG: { value: 6, state: 'ESTIMATED' }, carbsG: { value: 25, state: 'ESTIMATED' }, fatG: { value: 3, state: 'ESTIMATED' }, basis: 'BOTH' }] }]);
    const res = X.build(input, { from: RANGE.from, to: RANGE.to, now: F.NOW });
    const m = res.snapshot.nutrition.meals.find((x) => x.id === 'm-ph');
    assert.deepEqual(m.totals.kcal, { value: null, state: 'UNKNOWN', unknownCount: 1 });
    assert.equal(m.components[0].eatenFraction, null); assert.equal(m.aiMode, 'REAL'); assert.equal(m.components[0].basis, 'BOTH');
  });
  it('CE-U-10 sessions: only COMPLETED counts as completed; PARTIAL keeps its status', () => {
    const { res } = run();
    const by = Object.fromEntries(res.snapshot.training.sessions.map((s) => [s.id, s]));
    assert.equal(by['s-c1'].countsAsCompleted, true); assert.equal(by['s-p1'].countsAsCompleted, false); assert.equal(by['s-p1'].status, 'PARTIAL');
  });
  it('CE-U-11/12 planned slots and no-active-plan dates are copied for the range only (the caller passes ACTIVATED plans only)', () => {
    const planned = [{ slotId: 'v2.1-W1-MON', date: '2026-11-16', slotStatus: 'COMPLETED', linkedSessionIds: ['s-c1'] }, { slotId: 'x-old', date: '2026-10-01', slotStatus: 'NOT_LOGGED', linkedSessionIds: [] }];
    const { res } = run({ planned, noActivePlanDates: ['2026-11-05', '2026-11-06', '2026-10-01'] });
    assert.deepEqual(res.snapshot.training.planned.map((p) => p.slotId), ['v2.1-W1-MON']);
    assert.deepEqual(res.snapshot.training.noActivePlanDates, ['2026-11-05', '2026-11-06']);
  });
});

describe('P1.4 coaching export: privacy and selection', () => {
  it('CE-U-13 water is stated once as not recorded and appears nowhere else', () => {
    const { res } = run({ selection: ALL_ON });
    assert.equal(res.snapshot.unavailable.water.status, 'NOT_RECORDED_IN_APP');
    const keys = [...keysDeep(res.snapshot)].filter((k) => /water/i.test(k));
    assert.deepEqual(keys, ['water']);
  });
  it('CE-U-14 a category switched off is absent (not empty) and none of its field names appear', () => {
    const { res } = run(); // defaults: recovery, symptoms, free text off
    for (const k of ['recovery', 'symptoms']) assert.ok(!(k in res.snapshot), k);
    const keys = keysDeep(res.snapshot);
    for (const f of ['sleepH', 'sleepQuality', 'soreness', 'readiness', 'rhr', 'pain', 'footPain', 'stairKneePain', 'limp', 'rhrBaselineBpm']) assert.ok(!keys.has(f), f);
    const off = run({ selection: { training: false, nutrition: true, body: false, steps: false, recovery: false, symptoms: false, goals: false, freeText: false } }).res;
    for (const k of ['training', 'body', 'steps', 'goals']) assert.ok(!(k in off.snapshot), k);
    assert.ok(!keysDeep(off.snapshot).has('sessions'));
    // selected but empty: an empty list, not an absent key
    const emp = run({ from: '2026-11-18', to: '2026-11-18', selection: Object.assign({}, X.DEFAULTS, { recovery: true }) }).res;
    assert.equal(emp.ok, true); assert.deepEqual(emp.snapshot.recovery.daily, []);
  });
  it('CE-U-15 free text OFF: no marker from any notes, description, label or portion field appears', () => {
    const { res } = run({ selection: Object.assign({}, ALL_ON, { freeText: false }) });
    for (const m of F.MARKERS) assert.ok(!res.text.includes(m), m);
    assert.ok(!keysDeep(res.snapshot).has('notes')); assert.ok(!keysDeep(res.snapshot).has('description'));
  });
  it('CE-U-16 free text ON: the markers appear, but only under selected categories', () => {
    const on = run({ selection: ALL_ON }).res;
    for (const m of ['FT-SESSION-NOTE', 'FT-MEAL-DESC', 'FT-MEAL-LABEL', 'FT-BODY-NOTE', 'FT-WALK-NOTE', 'FT-BLOCK-NOTE', 'FT-PORTION', 'FT-WORKOUT-NOTE', 'FT-DAILY-NOTE']) assert.ok(on.text.includes(m), m);
    assert.ok(!on.text.includes('FT-DRAFT-NAME'));
    const part = run({ selection: { training: false, nutrition: true, body: false, steps: true, recovery: false, symptoms: false, goals: false, freeText: true } }).res;
    for (const m of ['FT-SESSION-NOTE', 'FT-BODY-NOTE', 'FT-WALK-NOTE', 'FT-DAILY-NOTE', 'FT-WORKOUT-NOTE']) assert.ok(!part.text.includes(m), m);
    assert.ok(part.text.includes('FT-MEAL-DESC'));
  });
  it('CE-U-17 secrets and photos: owner code, AI settings, recovery copies and the workout draft never appear; no "data:" string', () => {
    const { res } = run({ selection: ALL_ON });
    for (const v of [F.SECRETS.ownerCode, 'AI-SETTINGS-SYNTH', 'PRE-IMPORT-SYNTH', 'DRAFT-WORKOUT-SYNTH', 'data:', 'base64', 'privacyAckAt']) assert.ok(!res.text.includes(v), v);
    for (const k of ['heightCm', 'ageYears', 'sexForEquation', 'profile', 'favourites', 'myFoods', 'planBlocks']) assert.ok(!keysDeep(res.snapshot).has(k), k);
  });
  it('CE-U-18 malformed records: DAMAGED left out and counted; SALVAGED exported with recordQuality; neighbours unaffected', () => {
    const { s } = F.seed();
    const raw = JSON.parse(s.getItem('hyrox.v1'));
    raw.daily.push({ id: 'd-bad', date: '2026-11-17', createdAt: '2026-11-17T06:00:00.000Z', steps: { state: 'OBSERVED', value: 'lots' } });
    raw.sessions.push('not a record');
    s.setItem('hyrox.v1', JSON.stringify(raw));
    const st = HD.createStore(s, { now: () => F.NOW });
    const res = X.build(X.collect(st, { HD, HN, HC, to: RANGE.to }), { from: RANGE.from, to: RANGE.to, now: F.NOW, selection: ALL_ON });
    assert.equal(res.ok, true);
    const dmg = st.damagedRecords();
    const salv = dmg.filter((d) => d.kind === 'SALVAGED').map((d) => d.id), dead = dmg.filter((d) => d.kind === 'DAMAGED');
    assert.ok(dead.length >= 1);
    assert.equal(res.snapshot.coverage.training.excluded.damaged, dead.filter((d) => d.collection === 'sessions').length);
    for (const id of salv) { const r = res.snapshot.steps.daily.find((x) => x.id === id); if (r) assert.equal(r.recordQuality, 'SALVAGED'); }
    assert.ok(res.snapshot.training.sessions.find((x) => x.id === 's-c1'), 'valid neighbour still exported');
  });
  it('CE-U-19 bad storage (corrupt, newer, unreadable, unavailable): refusal, no file', () => {
    for (const [raw, code] of [['{not json', 'storage_corrupt'], [JSON.stringify({ version: 99, weight: [], workouts: [], nutrition: [] }), 'storage_newer']]) {
      const st = HD.createStore(F.mem({ 'hyrox.v1': raw }), { now: () => F.NOW });
      const res = X.build(X.collect(st, { HD, HN, HC, to: RANGE.to }), { from: RANGE.from, to: RANGE.to, now: F.NOW });
      assert.equal(res.ok, false); assert.equal(res.code, code); assert.ok(!res.text);
      assert.match(res.message, /Snapshot not created: saved data could not be read safely\. Nothing was changed\./);
    }
    const thrower = { status() { throw new Error('denied'); } };
    assert.equal(X.build(X.collect(thrower, { HD, HN }), { from: RANGE.from, to: RANGE.to, now: F.NOW }).code, 'storage_unreadable');
    assert.equal(X.build({ storageState: 'unavailable' }, { from: RANGE.from, to: RANGE.to, now: F.NOW }).ok, false);
  });
  it('CE-U-20 source unchanged: every storage key is byte-identical before and after, with clean and with damaged data', () => {
    for (const damage of [false, true]) {
      const { s } = F.seed();
      if (damage) { const raw = JSON.parse(s.getItem('hyrox.v1')); raw.meals.push({ id: 'm-x', date: 'bad' }); s.setItem('hyrox.v1', JSON.stringify(raw)); }
      const before = JSON.stringify(s.m);
      const st = HD.createStore(s, { now: () => F.NOW });
      X.build(X.collect(st, { HD, HN, HC, to: RANGE.to }), { from: RANGE.from, to: RANGE.to, now: F.NOW, selection: ALL_ON });
      assert.equal(JSON.stringify(s.m), before);
    }
  });
  it('CE-U-21 not a backup: this build\u2019s restore refuses a snapshot (not_hyrox) and the snapshot has no app/version/classic lists', () => {
    const { res } = run({ selection: ALL_ON });
    for (const k of ['app', 'version', 'weight', 'workouts']) assert.ok(!(k in res.snapshot), k);
    assert.ok(!Array.isArray(res.snapshot.nutrition));
    const target = HD.createStore(F.mem(), { now: () => F.NOW });
    const p = target.previewImport(res.text);
    assert.equal(p.ok, false); assert.equal(p.code, 'not_hyrox');
  });
  it('CE-U-22 derived metrics name their inputs; fewer than 2 weights or no D5 day gives null with a reason', () => {
    const { res } = run();
    const wc = res.snapshot.derived.find((d) => d.name === 'weightChange');
    assert.equal(wc.value, -0.4); assert.equal(wc.inputs.observations, 2); assert.equal(wc.method, 'last minus first; no smoothing');
    const ea = res.snapshot.derived.find((d) => d.name === 'eatingDayAverage');
    const d5 = res.snapshot.nutrition.days.filter((d) => d.code === 'D5').map((d) => d.date);
    assert.deepEqual(ea.inputs.daysUsed, d5);
    if (!d5.length) { assert.equal(ea.value, null); assert.equal(ea.reason, 'NO_COMPLETE_QUANTIFIED_DAYS'); }
    const one = run({ from: '2026-11-17', to: '2026-11-18' }).res.snapshot.derived.find((d) => d.name === 'weightChange');
    assert.equal(one.value, null); assert.equal(one.reason, 'INSUFFICIENT_OBSERVATIONS');
  });
  it('CE-U-23 repeated exports: different snapshotId and file name; otherwise identical content', () => {
    const { st } = F.seed();
    const inp = () => X.collect(st, { HD, HN, HC, to: RANGE.to });
    const a = X.build(inp(), { from: RANGE.from, to: RANGE.to, now: F.NOW, rand: () => 0.1 }), b = X.build(inp(), { from: RANGE.from, to: RANGE.to, now: F.NOW, rand: () => 0.9 });
    assert.notEqual(a.snapshot.snapshotId, b.snapshot.snapshotId); assert.notEqual(a.fileName, b.fileName);
    const strip = (x) => Object.assign({}, x.snapshot, { snapshotId: null });
    assert.deepEqual(strip(a), strip(b));
  });
  it('CE-U-24 valid JSON: parses back equal; no NaN/Infinity/undefined; stable key order', () => {
    const { res } = run({ selection: ALL_ON });
    assert.deepEqual(JSON.parse(res.text), res.snapshot);
    assert.ok(!/NaN|Infinity|undefined/.test(res.text));
    assert.deepEqual(Object.keys(res.snapshot).slice(0, 6), ['kind', 'coachSchemaVersion', 'notABackup', 'snapshotId', 'generatedAt', 'timezone']);
  });
  it('CE-U-25 large data: a synthetic year (1,460 meals, 365 sessions, 365 check-ins) exports a 366-day range quickly', () => {
    const { input } = run();
    const meals = [], sessions = [], daily = [];
    for (let i = 0; i < 365; i++) {
      const d = new Date(Date.UTC(2025, 10, 19 + i)).toISOString().slice(0, 10);
      for (let j = 0; j < 4; j++) meals.push({ id: 'm' + i + '-' + j, date: d, source: 'MANUAL', lifecycle: 'CONFIRMED', components: [{ name: 'Food', role: 'MAIN', kcal: { value: 500, state: 'ESTIMATED' }, proteinG: { value: 30, state: 'ESTIMATED' }, carbsG: { value: 50, state: 'ESTIMATED' }, fatG: { value: 15, state: 'ESTIMATED' } }] });
      sessions.push({ id: 's' + i, date: d, status: 'COMPLETED', blocks: [] });
      daily.push({ id: 'd' + i, date: d, steps: { state: 'OBSERVED', value: 8000 } });
    }
    Object.assign(input.records, { meals, sessions, daily });
    const t0 = Date.now();
    const res = X.build(input, { from: '2025-11-18', to: '2026-11-18', now: F.NOW });
    const ms = Date.now() - t0;
    assert.equal(res.ok, true); assert.equal(res.snapshot.nutrition.meals.length, 1460);
    assert.ok(ms < 3000, 'took ' + ms + ' ms');
  });
  it('nothing in range for the selected categories: no file', () => {
    const r = run({ from: '2026-10-01', to: '2026-10-02', selection: { training: true, nutrition: false, body: false, steps: false, recovery: false, symptoms: false, goals: true, freeText: false } }).res;
    assert.equal(r.ok, false); assert.equal(r.code, 'empty');
    assert.equal(r.message, 'No records in this range for the selected categories. No file was created.');
  });
  it('goals: provisional reference is labelled provisional; the coach profile (height, age, sex) is never exported', () => {
    const { res } = run();
    assert.equal(res.snapshot.goals.nutritionTarget.status, 'PROVISIONAL_SOURCE_DEFAULT');
    assert.equal(res.snapshot.goals.nutritionTarget.kcal, 2400);
  });
  it('the feature text never uses forbidden words (synced, uploaded, saved to Drive, backed up, up to date)', () => {
    const { res } = run({ selection: ALL_ON });
    const low = (res.text + ' ' + res.message).toLowerCase();
    for (const w of X.FORBIDDEN_WORDS) assert.ok(!low.includes(w), w);
  });
});
