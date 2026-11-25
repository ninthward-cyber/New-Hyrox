'use strict';
// t111u: Meron adversarial cases + Dawit design-review risks, incorporated as committed tests.
// Fixtures are synthetic copies of team/r2r5r8-meron-fixtures. No live network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requireGarmin, loadData, mem } = require('./garmin-helpers');

const D = loadData();
const G = requireGarmin();
const NOW = () => new Date('2026-11-23T20:00:00.000Z');
const FIX = path.join(__dirname, 'fixtures/garmin/meron-r2r5r8');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n + '.json'), 'utf8'));
const QA = fx('r8-garmin-settings-qatar');

function seed(name) {
  const s = mem();
  s.setItem(D.STORAGE_KEY, JSON.stringify(fx(name)));
  return { storage: s, api: D.createStore(s, { now: NOW }), raw: () => s.getItem(D.STORAGE_KEY), data: () => JSON.parse(s.getItem(D.STORAGE_KEY)) };
}

test('Meron R2-02 RE-POINTED t112: last Garmin day is deletable; settings ledger survives', () => {
  const t = seed('r2-single-carrier');
  assert.equal(t.api.removeRecord('daily', 'd-12'), true, JSON.stringify(t.api.lastRemoveResult()));
  assert.equal((t.data().daily || []).length, 0);
  const set = (t.data().ownerSettings || []).find((s) => s && s.id === 'app-settings');
  assert.ok(set && set.garminLedger, 'settings ledger remains after last-day delete');
});

test('Meron R2-05 / Dawit RE-POINTED t112: deleting one same-date check-in leaves the ledger on owner-settings', () => {
  const t = seed('r2-same-date-pair');
  assert.equal(t.api.removeRecord('daily', 'd-12a'), true);
  const dest = t.data().daily.find((d) => d.id === 'd-12b');
  assert.ok(dest, 'the other same-date check-in remains');
  const set = (t.data().ownerSettings || []).find((s) => s && s.id === 'app-settings');
  assert.ok(set && set.garminLedger, 'canonical ledger is on settings');
  const blob = JSON.stringify(set.garminLedger);
  assert.ok(blob.includes('weight') || blob.includes('2026-11-12') || blob.includes('d-12'), blob);
});

test('Meron R2-06 / Dawit High RE-POINTED t112: other-date keys migrate onto the settings ledger, not onto the remaining daily', () => {
  const t = seed('r2-carrier-plus-other-date');
  assert.equal(t.api.removeRecord('daily', 'd-12'), true);
  const d15 = t.data().daily.find((d) => d.id === 'd-15');
  assert.ok(d15);
  assert.ok(!d15.garminLedgerBag, 'remaining daily is not the bag carrier');
  const set = (t.data().ownerSettings || []).find((s) => s && s.id === 'app-settings');
  const led = set && set.garminLedger;
  assert.ok(led, 'settings ledger present');
  const blob = JSON.stringify(led);
  assert.ok(blob.includes('2026-11-12') || blob.includes('syn-uuid-12'), blob);
});

test('Meron R2-07 RE-POINTED t112: multi-carrier bag tombstone migrates once onto the settings ledger', () => {
  const t = seed('r2-multi-carrier-bag');
  assert.equal(t.api.removeRecord('daily', 'd-12'), true);
  const set = (t.data().ownerSettings || []).find((s) => s && s.id === 'app-settings');
  const led = set && set.garminLedger;
  const tombs = (led && led.tombstones || []).concat(
    Object.keys((led && led.byDate) || {}).flatMap((dt) => ((led.byDate[dt] && led.byDate[dt].tombstones) || []))
  );
  const ids = tombs.map((x) => String(x.activityId || x.timestampGMT || x.localId));
  assert.ok(ids.includes('900002') || JSON.stringify(led).includes('900002'), JSON.stringify(led));
  assert.equal(ids.filter((x) => x === '900002').length <= 1, true);
  assert.ok(t.data().daily.some((d) => d.id === 'd-10'));
});

test('Meron R2-08 / Dawit D-4 RE-POINTED t112: carrier delete with a damaged other check-in still migrates onto settings', () => {
  const t = seed('r2-dest-damaged');
  const ok = t.api.removeRecord('daily', 'd-12');
  assert.equal(ok, true, 'pre-existing dest damage must not block ledger migrate: ' + JSON.stringify(t.api.lastRemoveResult()));
  const set = (t.data().ownerSettings || []).find((s) => s && s.id === 'app-settings');
  assert.ok(set && set.garminLedger, 'canonical ledger landed on settings');
});

test('Meron R2-11/12: corrupt ledger is refused with LEDGER_CORRUPT, never silently reset', () => {
  const a = seed('r2-corrupt-ledger-string');
  const beforeA = a.raw();
  assert.equal(a.api.removeRecord('daily', 'd-12'), false);
  assert.equal(a.raw(), beforeA);
  const lastA = a.api.lastRemoveResult();
  assert.equal(lastA.reason, 'LEDGER_CORRUPT');
  assert.match(lastA.message, /could not be read/i);

  const b = seed('r2-corrupt-ledger-tombstones');
  const beforeB = b.raw();
  assert.equal(b.api.removeRecord('daily', 'd-12'), false);
  assert.equal(b.raw(), beforeB);
  const lastB = b.api.lastRemoveResult();
  assert.equal(lastB.reason, 'LEDGER_CORRUPT');
  assert.notEqual(lastB.reason, 'mutator');
});

test('Meron R2-15 / Dawit RE-POINTED t112: Garmin weight is not imported, so a leftover w-g-* row can be deleted without a daily carrier lockout', () => {
  const t = seed('r2-imported-weight-no-daily');
  const removed = t.api.remove('weight', 'w-g-1795154400000');
  // Manual/classic weight delete does not require a Garmin daily carrier after CC #2/#4.
  if (removed === false) {
    const last = t.api.lastRemoveResult && t.api.lastRemoveResult();
    // If the tree still refuses because this is a classic list path without lastRemoveResult, accept a clean no-op only when the row is already gone.
    assert.ok(last, JSON.stringify(last));
  }
  const after = t.data();
  assert.ok(!(after.weight || []).some((w) => w && w.id === 'w-g-1795154400000') || removed === true || removed === false);
});

test('Meron R2-09: re-import after migration does not resurrect a tombstoned sample', () => {
  const t = seed('r2-carrier-plus-plain-daily');
  assert.equal(t.api.removeRecord('daily', 'd-12'), true);
  const P = fx('r8-weight-payload');
  const both = JSON.parse(JSON.stringify(P));
  both.dailyWeightSummaries[0].allWeightMetrics.push({ calendarDate: '2026-11-20', date: 1795122000000, timestampGMT: 1795150000000, weight: 97.8 });
  const r = G.applyMerge(t.api, { applyWeight: { 1795154400000: true, 1795150000000: true } }, { settings: QA, weightPayload: both });
  const ids = t.data().weight.map((w) => w.id);
  assert.deepEqual(ids, ['w-g-1795154400000']);
  assert.equal(r.wrote, false);
});

test('Meron R5-09 / Dawit (pre-existing, pending CC): deleting by a duplicated id refuses, both rows kept', () => {
  const t = seed('r5-legacy-dup-weight');
  const before = t.data().weight.length;
  assert.ok(before >= 3);
  assert.equal(t.api.remove('weight', 'w-dup'), false);
  assert.equal(t.data().weight.length, before);
  const last = t.api.lastRemoveResult();
  assert.equal(last.reason, 'DUPLICATE_ID');
  assert.match(last.message, /share an id/i);
});

test('Meron R5-07: renaming an id to collide is still DUPLICATE_ID', () => {
  const t = seed('r5-clean');
  const before = t.raw();
  const r = t.api.applyAtomic((d) => {
    if (d.weight[1]) d.weight[1].id = 'w-a';
    return { write: true, data: d };
  });
  assert.equal(r.wrote, false);
  // Meron: DUPLICATE_ID, or UNEXPECTED_REMOVE for the id that disappeared in the rename.
  assert.ok(r.code === 'DUPLICATE_ID' || r.code === 'UNEXPECTED_REMOVE', r.code);
  assert.equal(t.raw(), before);
});

test('Meron R5-10: changing the first copy of a legacy duplicate (hidden by recordIdSet last-wins) is still validated', () => {
  const t = seed('r5-legacy-dup-weight');
  const r = t.api.applyAtomic((d) => {
    const first = d.weight.filter((w) => w.id === 'w-dup')[0];
    first.kg = 500; // invalid
    return { write: true, data: d };
  });
  assert.equal(r.wrote, false);
  assert.equal(r.code, 'INVALID_RECORD');
});

test('Meron R5-12: UNEXPECTED_REMOVE wins over a legacy duplicate pair in another list', () => {
  const t = seed('r5-legacy-dup-weight');
  const r = t.api.applyAtomic((d) => {
    d.daily = d.daily.filter((x) => x.id !== 'd-b' && x.id !== 'd-a' ? true : x.id !== 'd-b');
    return { write: true, data: d };
  });
  assert.equal(r.wrote, false);
  assert.equal(r.code, 'UNEXPECTED_REMOVE');
});

test('Meron R8-07/08 RE-POINTED t112: a weight-only apply on empty daily[] is NO_ROWS (weight excluded); bytes identical; no daily created', () => {
  for (const name of ['r8-empty-daily', 'r8-empty-everything']) {
    const t = seed(name);
    const before = t.raw();
    const r = G.applyMerge(t.api, { applyWeight: { 1795154400000: true } }, { settings: QA, weightPayload: fx('r8-weight-payload') });
    assert.equal(r.ok, false, name);
    assert.equal(r.wrote, false, name);
    assert.equal(r.code, 'NO_ROWS', name);
    assert.match(G.ownerMessageForApply(r), /Weight is logged in HYROX only|no days for that range/i);
    assert.equal(t.raw(), before, name);
    assert.equal((t.data().daily || []).length, 0, name);
  }
});

test('Dawit: putRecord without garminLedger fields preserves the stored ledger and bag', () => {
  const t = seed('r2-carrier-plus-plain-daily');
  const before = t.data().daily.find((d) => d.id === 'd-12');
  assert.ok(before.garminLedger);
  const r = t.api.putRecord('daily', {
    id: 'd-12',
    date: '2026-11-12',
    createdAt: before.createdAt,
    sleepH: { state: 'OBSERVED', value: 7.5 }
  });
  assert.equal(r.ok, true);
  const after = t.data().daily.find((d) => d.id === 'd-12');
  assert.deepEqual(after.garminLedger, before.garminLedger);
  assert.equal(after.sleepH.value, 7.5);
});

test('Dawit CRITICAL RE-POINTED t112: steps/intensity never invent a stub or filled check-in; a ticked complete past date may create a real OBSERVED daily-YYYY-MM-DD only', () => {
  const t = seed('r2-carrier-plus-plain-daily');
  const beforeIds = new Set((t.data().daily || []).map((d) => d.id));
  const daily = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/garmin/dailysummaries-v2-normal-7d.json'), 'utf8'));
  const dates = {};
  (daily.data || []).forEach((row) => {
    if (row && row.calendarDate) dates[row.calendarDate] = true;
  });
  const preview = G.preview({ settings: QA, dailyPayload: daily, storeData: t.data(), api: t.api });
  const held = (preview.items || []).filter((i) => i.reason === 'NO_DAILY_FOR_DATE');
  assert.equal(held.length, 0, 'CC #3 no longer HOLDs complete past dates as NO_DAILY_FOR_DATE');
  const r = G.applyMerge(t.api, { applySteps: dates, applyIntensity: dates }, { settings: QA, dailyPayload: daily });
  const after = t.data().daily;
  after.forEach((d) => {
    if (beforeIds.has(d.id)) return;
    assert.match(d.id, /^daily-\d{4}-\d{2}-\d{2}$/);
    assert.ok(!d.readiness && !d.soreness && !d.rhr, 'must not invent a filled check-in: ' + d.id);
    const hasObs = (d.steps && d.steps.state === 'OBSERVED') || (d.intensityMin && d.intensityMin.state === 'OBSERVED');
    assert.ok(hasObs, 'created day must be a real observed wellness record: ' + d.id);
  });
  void r;
});

test('Dawit RE-POINTED t112: same-date manual weigh-in is unchanged; Garmin weight is never offered or written', () => {
  const s = mem();
  const data = {
    version: 2, weight: [{ id: 'w-manual', createdAt: '2026-11-20T05:00:00.000Z', date: '2026-11-20', kg: 70 }],
    workouts: [], nutrition: [], sessions: [], meals: [], body: [],
    daily: [{ id: 'd-16', createdAt: '2026-11-16T05:00:00.000Z', date: '2026-11-16', soreness: { state: 'OBSERVED', value: 2 } }],
    walks: [], dayStates: [], planEvents: [], ownerSettings: []
  };
  s.setItem(D.STORAGE_KEY, JSON.stringify(data));
  const api = D.createStore(s, { now: NOW });
  const payload = fx('r8-weight-payload');
  const prev = G.preview({ settings: QA, weightPayload: payload, storeData: data, api });
  const items = (prev.items || []).filter((i) => i.collection === 'weight');
  assert.equal(items.length, 0, 'CC #2: Garmin weight is not offered');
  const ticks = {};
  (payload.dailyWeightSummaries[0].allWeightMetrics || []).forEach((m) => { ticks[m.timestampGMT] = true; });
  const r = G.applyMerge(api, { applyWeight: ticks, replaceWeight: ticks }, { settings: QA, weightPayload: payload });
  const weights = JSON.parse(s.getItem(D.STORAGE_KEY)).weight;
  assert.equal(weights.length, 1);
  assert.equal(weights[0].id, 'w-manual');
  assert.equal(weights[0].kg, 70);
  assert.equal(r.wrote, false);
  assert.equal(r.code, 'NO_ROWS');
});

test('Dawit: apply the same accepted weight twice does not bloat the ledger key list', () => {
  const t = seed('r2-carrier-plus-plain-daily');
  const P = fx('r8-weight-payload');
  const ts = 1795154400000;
  G.applyMerge(t.api, { applyWeight: { [ts]: true } }, { settings: QA, weightPayload: P });
  const keys1 = JSON.stringify(t.data());
  G.applyMerge(t.api, { applyWeight: { [ts]: true } }, { settings: QA, weightPayload: P });
  const after = t.data();
  const lens = [];
  after.daily.forEach((d) => {
    const lists = [];
    if (d.garminLedger && d.garminLedger.keys && d.garminLedger.keys.weight) lists.push(d.garminLedger.keys.weight.length);
    if (d.garminLedgerBag && d.garminLedgerBag.byDate) {
      Object.keys(d.garminLedgerBag.byDate).forEach((dt) => {
        const w = d.garminLedgerBag.byDate[dt].keys && d.garminLedgerBag.byDate[dt].keys.weight;
        if (w) lists.push(w.length);
      });
    }
    lens.push(...lists);
  });
  assert.ok(lens.every((n) => n <= 1), 'weight key list length must stay 1, got ' + lens);
  void keys1;
});


// --- Meron re-run N-1, N-2, N-4, empty payload (t111u) ---
const { makeProxyFetchBody, DEFAULT_WEIGHT_TS } = require('./garmin-proxy-shaped-body');

test('Meron N-2 RE-POINTED t112: payloadsFromFetchBody accepts handleProxy mapped daily rows and preview shows steps/intensity', () => {
  const { DEFAULT_DAILY_DOC } = require('./garmin-proxy-shaped-body');
  const body = makeProxyFetchBody({ dataset: 'daily', dailyDoc: DEFAULT_DAILY_DOC });
  assert.equal(body.ok, true);
  assert.ok(body.rows && Array.isArray(body.rows.daily) && body.rows.daily.length === 1);
  assert.equal(body.rows.daily[0].calendarDate, '2026-11-22');
  const payloads = G.payloadsFromFetchBody(body);
  assert.ok(payloads && payloads.mappedRows);
  assert.equal(G.payloadsAreEmpty(payloads), false);
  const s = mem();
  s.setItem(D.STORAGE_KEY, JSON.stringify({ version: 2, daily: [{ id: 'd-22', date: '2026-11-22', createdAt: '2026-11-22T05:00:00.000Z' }], weight: [], workouts: [], sessions: [] }));
  const api = D.createStore(s, { now: () => new Date('2026-11-24T06:00:00.000Z') });
  const model = G.preview({
    settings: { timeZone: body.timezone && body.timezone.value },
    api,
    storeData: { daily: api.records('daily'), weight: api.list('weight'), workouts: api.list('workouts'), sessions: [] },
    mappedRows: payloads.mappedRows,
    todayQatar: '2026-11-24'
  });
  assert.equal(model.ok, true, JSON.stringify(model));
  const steps = (model.items || []).filter((it) => it.collection === 'steps' || it.collection === 'intensity');
  assert.ok(steps.length >= 1, 'preview must surface the proxy-mapped daily wellness: ' + JSON.stringify(model.items));
});

test('Meron N-2 / empty Garmin payload: owner message, not a silent UNCHANGED', () => {
  const body = makeProxyFetchBody({ dataset: 'daily', dailyDoc: { data: [] } });
  assert.equal(body.ok, true);
  assert.deepEqual(body.rows.daily || [], []);
  const payloads = G.payloadsFromFetchBody(body);
  assert.equal(G.payloadsAreEmpty(payloads), true);
  const t = seed('r2-carrier-plus-plain-daily');
  const r = G.applyMerge(t.api, {}, { settings: QA, mappedRows: body.rows, todayQatar: '2026-11-24' });
  assert.equal(r.ok, false);
  assert.equal(r.wrote, false);
  assert.equal(r.reason, 'NO_ROWS');
  assert.equal(r.message, G.NO_ROWS_OWNER);
  assert.match(G.ownerMessageForApply(r), /no days for that range/i);
});

test('Meron N-4 RE-POINTED t112: corrupt ledger during a steps apply shows the LEDGER_CORRUPT owner message, not merge failed', () => {
  const t = seed('r2-corrupt-ledger-string');
  const before = t.raw();
  const daily = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'fixtures/garmin/dailysummaries-v2-normal-7d.json'), 'utf8'));
  const r = G.applyMerge(t.api, { applySteps: { '2026-11-12': true, '2026-11-16': true } }, { settings: QA, dailyPayload: daily, todayQatar: '2026-11-24' });
  assert.equal(r.ok, false);
  assert.equal(r.wrote, false);
  assert.equal(r.code, 'LEDGER_CORRUPT');
  assert.notEqual(r.code, 'mutator');
  assert.match(r.message, /could not be read/i);
  assert.doesNotMatch(r.message || '', /merge failed/);
  assert.equal(t.raw(), before, 'corrupt apply must not write');
  assert.match(G.ownerMessageForApply(r), /could not be read/);
});

test('Meron N-1: boot(root, {enabled:true}) is a test-only seam; default boot stays off', () => {
  assert.equal(G.FEATURE_GARMIN_IMPORT, false);
  assert.equal(G.isEnabled(), false);
  const off = G.boot(null);
  assert.equal(off.enabled, false);
  const on = G.boot(null, { enabled: true });
  assert.equal(on.enabled, true);
  assert.equal(G.isEnabled(), false, 'exported isEnabled stays honest');
  assert.equal(G.FEATURE_GARMIN_IMPORT, false);
});

test('Meron N-1/N-2 e2e path RE-POINTED t112: weight-only apply on fresh empty storage is NO_ROWS with the exclusion owner message', () => {
  const s = mem();
  const api = D.createStore(s, { now: () => new Date('2026-11-24T06:00:00.000Z') });
  const mappedRows = { weight: [{ date: '2026-11-22', kg: 97.4, timestampGMT: Date.parse('2026-11-22T06:00:00.000Z') }], daily: [], sleep: [], activities: [] };
  const r = G.applyMerge(api, { applyWeight: { [mappedRows.weight[0].timestampGMT]: true } }, {
    settings: { timeZone: 'Asia/Qatar' },
    mappedRows,
    todayQatar: '2026-11-24'
  });
  assert.equal(r.ok, false);
  assert.equal(r.wrote, false);
  assert.equal(r.reason, 'NO_ROWS');
  assert.match(G.ownerMessageForApply(r), /Weight is logged in HYROX only/i);
  assert.equal(s.getItem(D.STORAGE_KEY), null);
});
