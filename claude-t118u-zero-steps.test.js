'use strict';
// Claude QA t118u (24 Nov 2026), fail-first: owner decision "Garmin 0 steps = not worn; that DATE is not imported".
// Fails on 828dc6e (intensity from a 0-step day is still imported, and the real Fetch path shows UNKNOWN instead of the
// owner sentence). Synthetic, in-memory storage; the proxy body comes from the offline source-tree stub. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'src/data/hyrox-data.js'));
const G = require(path.join(ROOT, 'src/integrations/garmin-import.js'));
const { makeProxyFetchBody } = require('./garmin-proxy-shaped-body');
const NOW = new Date('2026-11-24T06:00:00Z'), QA = { timeZone: 'Asia/Qatar' };
const prevDay = (d) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
const row = (date, steps, mod, vig) => ({ uuid: 'u-' + date, calendarDate: date, source: 'garmin', includesWellnessData: true, includesActivityData: true,
  wellnessChronology: { startTimestampGmt: prevDay(date) + 'T21:00:00.0', startTimestampLocal: date + 'T00:00:00.0', endTimestampGmt: date + 'T20:59:00.0', endTimestampLocal: date + 'T23:59:00.0', totalDurationInMillis: 86340000 },
  movement: { steps: { goal: 10000, value: steps } }, intensityMinutes: { goal: 150, moderate: mod, vigorous: vig } });
function store(daily) { const m = new Map(); const s = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  if (daily) s.setItem(D.STORAGE_KEY, JSON.stringify({ version: 2, weight: [], workouts: [], nutrition: [], sessions: [], meals: [], body: [], daily, walks: [], dayStates: [], planEvents: [], ownerSettings: [] }));
  return { s, st: D.createStore(s, { now: () => NOW }), doc: () => JSON.parse(s.getItem(D.STORAGE_KEY) || 'null') }; }
const tick = { applySteps: { '2026-11-20': true }, applyIntensity: { '2026-11-20': true } };
const CHECKIN = { id: 'd-man-18', createdAt: '2026-11-18T05:00:00.000Z', date: '2026-11-18', soreness: { state: 'OBSERVED', value: 2 } };
const fetchPayloads = (r) => { const res = makeProxyFetchBody({ dataset: 'daily', dailyDoc: { data: [r] }, startDate: '2026-11-18', endDate: '2026-11-24', weightDoc: null }); return G.payloadsFromFetchBody(res.body || res); };
for (const [label, mod, vig] of [['0 steps, 0 intensity', 0, 0], ['0 steps, 35 intensity min', 25, 5]]) {
  test('t118u raw path: ' + label + ', both force-ticked -> nothing for that date', () => {
    const t = store([CHECKIN]); const r = G.applyMerge(t.st, tick, { settings: QA, nowIso: NOW.toISOString(), dailyPayload: { data: [row('2026-11-20', 0, mod, vig)] } });
    assert.equal(t.doc().daily.some((d) => d.date === '2026-11-20'), false, JSON.stringify(r));
  });
  test('t118u Fetch path: ' + label + ' -> preview shows only the locked owner line, nothing written', () => {
    const t = store([CHECKIN]); const p = fetchPayloads(row('2026-11-20', 0, mod, vig));
    const pv = G.preview(Object.assign({ settings: QA, storeData: t.doc(), api: t.st }, p));
    const its = pv.items.filter((i) => i.date === '2026-11-20');
    assert.deepEqual(its.map((i) => [i.collection, i.status, i.writable]), [['steps', 'Garmin shows 0 steps, likely not worn', false]]);
    G.applyMerge(t.st, tick, Object.assign({ settings: QA, nowIso: NOW.toISOString() }, p));
    assert.equal(t.doc().daily.some((d) => d.date === '2026-11-20'), false);
  });
}
test('t118u: Garmin 0 writes nothing onto an existing manual check-in, even with Replace ticked', () => {
  const t = store([Object.assign({}, CHECKIN, { id: 'd-man-20', date: '2026-11-20', steps: { state: 'OBSERVED', value: 6100 } })]); const before = t.s.getItem(D.STORAGE_KEY);
  G.applyMerge(t.st, Object.assign({ replaceSteps: { '2026-11-20': true }, replaceIntensity: { '2026-11-20': true } }, tick), { settings: QA, nowIso: NOW.toISOString(), dailyPayload: { data: [row('2026-11-20', 0, 0, 0)] } });
  assert.equal(t.s.getItem(D.STORAGE_KEY), before);
});
test('t118u: a normal worn day next to a 0-step day is still importable (no over-blocking)', () => {
  const t = store([CHECKIN]); const r = G.applyMerge(t.st, { applySteps: { '2026-11-21': true }, applyIntensity: { '2026-11-21': true } }, { settings: QA, nowIso: NOW.toISOString(), dailyPayload: { data: [row('2026-11-20', 0, 0, 0), row('2026-11-21', 8400, 30, 8)] } });
  const d = t.doc().daily.find((x) => x.date === '2026-11-21'); assert.ok(r.wrote && d && d.steps.value === 8400 && d.intensityMin.value === 46);
});
