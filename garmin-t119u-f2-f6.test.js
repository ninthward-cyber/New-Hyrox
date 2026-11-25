'use strict';
// t119u / Claude QA F2, F3, F4 (24 Nov 2026). Fail-first on 302db98-equivalent HEAD.
// Synthetic in-memory storage only. Fetch bodies come from the offline source-tree proxy stub. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const HD = require(path.join(ROOT, 'src/data/hyrox-data.js'));
const HN = require(path.join(ROOT, 'src/data/hyrox-nutrition.js'));
const HC = require(path.join(ROOT, 'src/data/hyrox-coach.js'));
const X = require(path.join(ROOT, 'src/data/hyrox-coach-export.js'));
const G = require(path.join(ROOT, 'src/integrations/garmin-import.js'));
const { makeProxyFetchBody } = require('./garmin-proxy-shaped-body');

const NOW = new Date('2026-11-24T06:00:00Z');
const NOW_ISO = NOW.toISOString();
const QA = { timeZone: 'Asia/Qatar' };
const KEY = HD.STORAGE_KEY;
const P = '2026-11-20';
const N = '2026-11-21';

function mem() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k)
  };
}
function chron(date, endH, endM) {
  const [y, m, d] = date.split('-').map(Number);
  const ls = Date.UTC(y, m - 1, d);
  const p = (n) => String(n).padStart(2, '0');
  const f = (ms) => {
    const t = new Date(ms);
    return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()) + 'T' + p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) + ':00.0';
  };
  const eh = endH == null ? 23 : endH, em = endM == null ? 59 : endM;
  const el = ls + (eh * 60 + em) * 60000;
  return {
    startTimestampGmt: f(ls - 3 * 3600000),
    startTimestampLocal: f(ls),
    endTimestampGmt: f(el - 3 * 3600000),
    endTimestampLocal: f(el),
    totalDurationInMillis: el - ls
  };
}
function row(date, over) {
  return Object.assign({
    calendarDate: date, source: 'garmin', uuid: 'syn-' + date, includesWellnessData: true,
    movement: { steps: { value: 8421 } },
    intensityMinutes: { moderate: 20, vigorous: 8 },
    wellnessChronology: chron(date)
  }, over || {});
}
function v2(over) {
  return Object.assign({
    version: 2, weight: [], workouts: [], nutrition: [], sessions: [], meals: [], body: [],
    daily: [], walks: [], dayStates: [], planEvents: [], ownerSettings: []
  }, over || {});
}
function store(data) {
  const s = mem();
  if (data) s.setItem(KEY, JSON.stringify(data));
  const api = HD.createStore(s, { now: () => NOW });
  return { s, api, raw: () => s.getItem(KEY), doc: () => JSON.parse(s.getItem(KEY) || 'null') };
}
function fetchBody(dailyDoc) {
  return makeProxyFetchBody({ dataset: 'daily', dailyDoc: { data: dailyDoc }, startDate: '2026-11-18', endDate: '2026-11-24', weightDoc: null });
}
function payloads(dailyDoc) {
  const res = fetchBody(dailyDoc);
  return G.payloadsFromFetchBody(res.body || res);
}

test('F2: Fetch path preserves a conflicting same-date HOLD and does not say “returned no days”', () => {
  const t = store(v2());
  const daily = [row(P, { movement: { steps: { value: 5000 } } }), row(P, { movement: { steps: { value: 15000 } } })];
  const body = fetchBody(daily);
  const b = body.body || body;
  assert.ok(Array.isArray(b.held) && b.held.some((h) => h.calendarDate === P && h.reason === 'DUPLICATE_DATE_CONFLICT'),
    'proxy must forward held: ' + JSON.stringify(b.held));
  const p = G.payloadsFromFetchBody(b);
  const pv = G.preview(Object.assign({ settings: QA, storeData: t.doc() || v2(), api: t.api, nowIso: NOW_ISO }, p));
  const held = (pv.items || []).filter((i) => i.date === P && i.status === 'HOLD');
  assert.ok(held.length, 'preview must show HOLD, not hide the day: ' + JSON.stringify(pv.items));
  const r = G.applyMerge(t.api, { applySteps: { [P]: true }, applyIntensity: { [P]: true } }, Object.assign({ settings: QA, nowIso: NOW_ISO }, p));
  assert.equal(!!(t.doc() && (t.doc().daily || []).some((d) => d.date === P)), false, JSON.stringify(r));
  const msg = G.ownerMessageForApply(r);
  assert.doesNotMatch(msg, /returned no days/i);
  assert.match(msg, /did not agree|not saved|HOLD/i);
});

test('F2: Fetch path holds an incomplete Qatar day and a held-only range is not “no days”', () => {
  const t = store(v2());
  const daily = [row(P, { wellnessChronology: chron(P, 10, 0), movement: { steps: { value: 3100 } } })];
  const p = payloads(daily);
  const pv = G.preview(Object.assign({ settings: QA, storeData: v2(), api: t.api, nowIso: NOW_ISO }, p));
  const held = (pv.items || []).filter((i) => i.date === P && i.status === 'HOLD');
  assert.ok(held.length, 'incomplete Fetch day must be a visible HOLD: ' + JSON.stringify({ held: p.held, items: pv.items }));
  const r = G.applyMerge(t.api, { applySteps: { [P]: true } }, Object.assign({ settings: QA, nowIso: NOW_ISO }, p));
  assert.equal(!!(t.doc() && (t.doc().daily || []).some((d) => d.date === P)), false);
  const msg = G.ownerMessageForApply(r);
  assert.doesNotMatch(msg, /returned no days/i);
  assert.match(msg, /not complete|not saved/i);
});

test('F2: a valid neighbouring day stays importable next to a Fetch HOLD', () => {
  const t = store(v2());
  const daily = [
    row(P, { wellnessChronology: chron(P, 10, 0), movement: { steps: { value: 3100 } } }),
    row(N, { movement: { steps: { value: 8400 } }, intensityMinutes: { moderate: 30, vigorous: 8 } })
  ];
  const p = payloads(daily);
  const pv = G.preview(Object.assign({ settings: QA, storeData: v2(), api: t.api, nowIso: NOW_ISO }, p));
  assert.ok((pv.items || []).some((i) => i.date === P && i.status === 'HOLD'));
  assert.ok((pv.items || []).some((i) => i.date === N && i.writable !== false && (i.status === 'New' || i.collection === 'steps')));
  const r = G.applyMerge(t.api, { applySteps: { [N]: true, [P]: true }, applyIntensity: { [N]: true } }, Object.assign({ settings: QA, nowIso: NOW_ISO }, p));
  const doc = t.doc();
  assert.equal((doc.daily || []).some((d) => d.date === P), false);
  const dN = (doc.daily || []).find((d) => d.date === N);
  assert.ok(r.wrote && dN && dN.steps && dN.steps.value === 8400, JSON.stringify({ r, dN }));
});

test('F3: garminLedger:null in a settings save keeps the ledger and tombstones', () => {
  const t = store(v2());
  const r0 = G.applyMerge(t.api, { applySteps: { [P]: true }, applyIntensity: { [P]: true } }, {
    settings: QA, dailyPayload: { data: [row(P)] }, nowIso: NOW_ISO
  });
  assert.equal(r0.wrote, true);
  assert.equal(t.api.removeRecord('daily', 'daily-' + P), true);
  const settings = (t.doc().ownerSettings || []).filter((e) => e && e.id === 'app-settings')[0];
  assert.ok(settings && settings.garminLedger, 'expected a ledger before the null save');
  const before = JSON.stringify(settings.garminLedger);
  const nr = JSON.parse(JSON.stringify(settings));
  nr.garminLedger = null;
  nr.rhrBaselineBpm = 53;
  const saved = t.api.putRecord('ownerSettings', nr);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const led = (t.doc().ownerSettings || []).filter((e) => e && e.id === 'app-settings')[0].garminLedger;
  assert.ok(led, 'null must not wipe the ledger: ' + JSON.stringify(t.doc().ownerSettings));
  assert.equal(JSON.stringify(led), before);
});

test('F4: when first-day rollback cannot remove the leftover, the owner is told the data may be incomplete', () => {
  const s = mem();
  const realSet = s.setItem.bind(s);
  s.setItem = (k, v) => { realSet(k, k === KEY ? String(v).slice(0, 40) : v); };
  s.removeItem = () => { throw new Error('hostile remove'); };
  const api = HD.createStore(s, { now: () => NOW });
  const r = G.applyMerge(api, { applySteps: { [P]: true }, applyIntensity: { [P]: true } }, {
    settings: QA, dailyPayload: { data: [row(P)] }, nowIso: NOW_ISO
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'save_failed');
  assert.equal(r.rolledBack, false);
  assert.ok(s.getItem(KEY), 'hostile remove leaves a leftover key');
  const msg = G.ownerMessageForApply(r);
  assert.match(msg, /incomplete/i);
  assert.match(msg, /backup|export|verify|check/i);
  assert.doesNotMatch(msg, /nothing changed/i);
});

test('T10: coach export status is RECORDED_IN_APP when a daily has GARMIN_PERSONAL_API source', () => {
  const t = store(v2({
    daily: [{
      id: 'daily-' + P, date: P, createdAt: '2026-11-20T05:00:00.000Z',
      steps: { state: 'OBSERVED', value: 8421, source: 'GARMIN_PERSONAL_API' },
      intensityMin: { state: 'OBSERVED', value: 36, source: 'GARMIN_PERSONAL_API', moderate: 20, vigorous: 8 }
    }]
  }));
  const r = X.build(X.collect(t.api, { HD, HN, HC, to: '2026-11-24', planned: [], noActivePlanDates: [] }), {
    from: '2026-11-17', to: '2026-11-24', now: NOW, rand: () => 0.5
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.snapshot.unavailable.deviceImportedActivity.status, 'RECORDED_IN_APP');
});
