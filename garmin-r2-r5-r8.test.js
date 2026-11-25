'use strict';
// t111u: R2 ledger-carrier tests (GAP-1 / migrate / last-carrier + owner message),
// R5 GAP-2/GAP-3 and scoped duplicate-id (pending CC confirmation, Claude decision 1),
// R8 owner-visible NO_DAILY_CARRIER and no product test hook.
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireGarmin, loadData, mem } = require('./garmin-helpers');

const D = loadData();
const G = requireGarmin();
const NOW = () => new Date('2026-11-24T06:00:00Z');
const QA = { timeZone: 'Asia/Qatar' };
const t20 = Date.parse('2026-11-20T03:00:00Z');
const wdoc = { dailyWeightSummaries: [{ allWeightMetrics: [{ weight: 97.4, timestampGMT: t20 }] }] };
const DLY = (id, date, extra) => Object.assign({ id, createdAt: date + 'T05:00:00.000Z', date, soreness: { state: 'OBSERVED', value: 2 } }, extra || {});
const W = (id, date, kg) => ({ id, createdAt: date + 'T05:00:00.000Z', date, kg });
const base = (o) => Object.assign({
  version: 2, weight: [], workouts: [], nutrition: [], sessions: [], meals: [], body: [],
  daily: [], walks: [], dayStates: [], planEvents: [], ownerSettings: []
}, o);
const LEDGER_MSG = 'Garmin import links are kept in your settings. Nothing was deleted.';

function storeWith(data) {
  const s = mem();
  s.setItem(D.STORAGE_KEY, JSON.stringify(base(data)));
  return { storage: s, api: D.createStore(s, { now: NOW }) };
}

test('GAP-1 / R2 RE-POINTED t112: tombstone survives on the owner-settings ledger after the linked check-in is deleted', () => {
  const { storage, api } = storeWith({
    daily: [DLY('d-old', '2026-11-10', { steps: { state: 'OBSERVED', value: 8000, source: 'GARMIN_PERSONAL_API' } }), DLY('d-new', '2026-11-12')],
    ownerSettings: [{ id: 'app-settings', date: '2026-11-20', createdAt: '2026-11-20T05:00:00.000Z', garminLedger: { v: 1, identity: { provider: 'garmin-personal-api' }, keys: {}, tombstones: [], byDate: { '2026-11-10': { v: 1, keys: { daily: { calendarDate: '2026-11-10', localId: 'd-old' } }, tombstones: [] } } } }]
  });
  assert.equal(api.removeRecord('daily', 'd-old'), true);
  const migrated = JSON.parse(storage.getItem(D.STORAGE_KEY));
  const set = (migrated.ownerSettings || []).find((s) => s.id === 'app-settings');
  const blob = JSON.stringify(set && set.garminLedger);
  assert.ok(blob.includes('d-old') || blob.includes('2026-11-10'), 'tombstone must live on settings: ' + blob);
  assert.equal(migrated.daily.some((d) => d.id === 'd-old'), false);
  assert.ok(migrated.daily.some((d) => d.id === 'd-new'));
});

test('R2 RE-POINTED t112: the last Garmin day is deletable; the settings ledger and lastRemoveResult stay consistent', () => {
  const { api } = storeWith({
    daily: [DLY('only', '2026-11-10', { steps: { state: 'OBSERVED', value: 1000, source: 'GARMIN_PERSONAL_API' }, garminLedger: { v: 1, keys: { daily: { calendarDate: '2026-11-10', localId: 'only' } }, tombstones: [] } })]
  });
  const ok = api.removeRecord('daily', 'only');
  assert.equal(ok, true, JSON.stringify(api.lastRemoveResult()));
  const last = api.lastRemoveResult();
  assert.equal(last.ok, true);
  assert.equal(api.records('daily').length, 0);
  const set = api.records('ownerSettings').find((s) => s.id === 'app-settings');
  assert.ok(set && set.garminLedger, 'settings ledger remains after the last day is deleted');
});

test('R2: ledger migrates onto the remaining check-in when another daily exists', () => {
  const { storage, api } = storeWith({
    daily: [
      DLY('keep', '2026-11-12'),
      DLY('carrier', '2026-11-10', { garminLedger: { v: 1, keys: { weight: ['w-g-' + t20] }, tombstones: [{ collection: 'weight', timestampGMT: t20 }] } })
    ]
  });
  const ok = api.removeRecord('daily', 'carrier');
  assert.equal(ok, true);
  const last = api.lastRemoveResult();
  assert.equal(last.ok, true);
  const data = JSON.parse(storage.getItem(D.STORAGE_KEY));
  const keep = data.daily.find((d) => d.id === 'keep');
  assert.ok(keep);
  assert.ok(!keep.garminLedger && !keep.garminLedgerBag, 'canonical ledger is not on the remaining daily');
  const set = (data.ownerSettings || []).find((s) => s.id === 'app-settings');
  const blob = JSON.stringify(set && set.garminLedger);
  assert.ok(blob.includes('w-g-' + t20) || blob.includes(String(t20)) || blob.includes('2026-11-10'), 'ledger must land on settings: ' + blob);
});

test('GAP-2 / R5: applyAtomic refuses a mutator that creates a duplicate id', () => {
  const { api } = storeWith({
    daily: [DLY('d1', '2026-11-10')],
    weight: [W('w1', '2026-11-20', 97.4)]
  });
  const r = api.applyAtomic((d) => {
    d.weight.push(W('w1', '2026-11-21', 97.3));
    return { write: true, data: d };
  });
  assert.equal(r.wrote, false);
  assert.equal(r.code, 'DUPLICATE_ID');
});

test('GAP-3 / R5: applyAtomic refuses a valid mutator that silently drops a record', () => {
  const { storage, api } = storeWith({ daily: [DLY('d1', '2026-11-10'), DLY('d2', '2026-11-11')] });
  const r = api.applyAtomic((d) => {
    d.daily = d.daily.slice(0, 1);
    return { write: true, data: d };
  });
  assert.equal(r.wrote, false);
  assert.equal(r.code, 'UNEXPECTED_REMOVE');
  assert.equal(JSON.parse(storage.getItem(D.STORAGE_KEY)).daily.length, 2);
});

test('R5 scoped duplicate-id (pending CC confirmation): ordinary weigh-in delete still works when old data holds an unrelated duplicate-id pair', () => {
  const { api } = storeWith({
    weight: [W('w1', '2026-11-20', 97.4), W('dup', '2026-11-18', 97.9), W('dup', '2026-11-19', 97.8)]
  });
  const ok = api.remove('weight', 'w1');
  assert.equal(ok, true, 'RC3 allowed this delete; scoped check must not refuse it');
  const left = api.list('weight').map((w) => w.id).sort();
  assert.deepEqual(left, ['dup', 'dup']);
});

test('R5 scoped duplicate-id (pending CC confirmation): ordinary check-in delete still works when another pair shares an id', () => {
  const { api } = storeWith({
    daily: [DLY('d1', '2026-11-10'), DLY('dup', '2026-11-11'), DLY('dup', '2026-11-12')]
  });
  const ok = api.removeRecord('daily', 'd1');
  assert.equal(ok, true);
  assert.equal(api.records('daily').length, 2);
});

test('R5: adding a second record with an existing id is still refused after scoping', () => {
  const { api } = storeWith({ weight: [W('w1', '2026-11-20', 97.4)] });
  const r = api.applyAtomic((d) => {
    d.weight.push(W('w1', '2026-11-21', 96.0));
    return { write: true, data: d };
  });
  assert.equal(r.wrote, false);
  assert.equal(r.code, 'DUPLICATE_ID');
});

test('R8 RE-POINTED t112: a weight-only apply on empty daily[] is NO_ROWS with a plain-language owner message (no product hook change)', () => {
  const { api } = storeWith({ daily: [] });
  const r = G.applyMerge(api, { applyWeight: { [t20]: true } }, { settings: QA, weightPayload: wdoc });
  assert.equal(r.wrote, false);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NO_ROWS');
  assert.equal(r.code, 'NO_ROWS');
  const msg = G.ownerMessageForApply(r);
  assert.match(msg, /Weight is logged in HYROX only|no days for that range/i);
  assert.doesNotMatch(msg, /NO_ROWS/);
  assert.doesNotMatch(msg, /NO_DAILY_CARRIER/);
});

test('R8: product isEnabled has no test hook and stays false while FEATURE_GARMIN_IMPORT is off', () => {
  const prev = global.window;
  global.window = { __HYROX_GARMIN_IMPORT_TEST__: true };
  try {
    assert.equal(G.FEATURE_GARMIN_IMPORT, false);
    assert.equal(G.isEnabled(), false);
    const src = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../src/integrations/garmin-import.js'), 'utf8');
    assert.doesNotMatch(src, /__HYROX_GARMIN_IMPORT_TEST__/);
  } finally {
    global.window = prev;
  }
});
