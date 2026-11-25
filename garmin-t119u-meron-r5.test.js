'use strict';
// Meron R5 fail-first tests (HEAD ca344d6 findings), 24 Nov 2026.
// Cases follow r5-meron-fixtures/probe-r5.js (A-04b/c, B-04/05/06) plus HOLD reason text and Open Morning target size.
// Synthetic in-memory storage only. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const HD = require(path.join(ROOT, 'src/data/hyrox-data.js'));
const G = require(path.join(ROOT, 'src/integrations/garmin-import.js'));

const QA = { timeZone: 'Asia/Qatar' };
const KEY = HD.STORAGE_KEY;
const NOWISO = '2026-11-24T06:00:00.000Z';
const Z = '2026-11-21', N1 = '2026-11-20', N2 = '2026-11-22';

function mem(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k)
  };
}
function v2(o) {
  return Object.assign({
    version: 2, weight: [], workouts: [], nutrition: [], sessions: [], meals: [], body: [],
    daily: [], walks: [], dayStates: [], planEvents: [], ownerSettings: []
  }, o || {});
}
function mk(doc) {
  const init = {};
  if (doc) init[KEY] = JSON.stringify(doc);
  const s = mem(init);
  return { s, api: HD.createStore(s, { now: () => new Date(NOWISO) }), raw: () => s.getItem(KEY), data: () => JSON.parse(s.getItem(KEY) || 'null') };
}
function chron(date) {
  const [y, m, d] = date.split('-').map(Number);
  const ls = Date.UTC(y, m - 1, d);
  const f = (ms) => new Date(ms).toISOString().slice(0, 19) + '.0';
  return {
    startTimestampGmt: f(ls - 10800000), startTimestampLocal: f(ls),
    endTimestampGmt: f(ls + 86340000 - 10800000), endTimestampLocal: f(ls + 86340000),
    totalDurationInMillis: 86340000
  };
}
function rawRow(date, steps, mod, vig) {
  const r = { calendarDate: date, source: 'garmin', uuid: 'syn-' + date, includesWellnessData: true, movement: { steps: { value: steps } }, wellnessChronology: chron(date) };
  if (mod !== undefined) r.intensityMinutes = { moderate: mod, vigorous: vig };
  return r;
}
function mRow(date, steps, mod, vig) {
  return { calendarDate: date, steps: steps, intensity: mod === undefined ? null : { moderate: mod, vigorous: vig, value: mod + 2 * vig }, inProgress: false };
}
const allTicks = (dates) => {
  const o = {}; dates.forEach((d) => { o[d] = true; });
  return { applySteps: Object.assign({}, o), applyIntensity: Object.assign({}, o), replaceSteps: Object.assign({}, o), replaceIntensity: Object.assign({}, o) };
};
const tickOnly = (dates) => {
  const o = {}; dates.forEach((d) => { o[d] = true; });
  return { applySteps: Object.assign({}, o), applyIntensity: Object.assign({}, o) };
};
function applyBoth(t, kind, rows, conf) {
  if (kind === 'raw') return G.applyMerge(t.api, conf, { settings: QA, dailyPayload: { data: rows.map((r) => rawRow(...r)) }, nowIso: NOWISO });
  const body = { ok: true, timezone: { value: 'Asia/Qatar' }, rows: { daily: rows.map((r) => mRow(...r)), weight: [], activities: [], sleep: [] }, held: [] };
  return G.applyMerge(t.api, conf, Object.assign({ settings: QA, nowIso: NOWISO }, G.payloadsFromFetchBody(body)));
}
function settingsOf(d) { return ((d && d.ownerSettings) || []).find((e) => e && e.id === 'app-settings') || null; }
function ledgerHas(d, date) {
  const s = settingsOf(d);
  return !!(s && s.garminLedger && s.garminLedger.byDate && s.garminLedger.byDate[date]);
}

for (const kind of ['raw', 'fetch']) {
  for (const [lbl, manual] of [['manual 0', { state: 'OBSERVED', value: 0 }], ['manual 8000', { state: 'OBSERVED', value: 8000 }]]) {
    test('Meron R5-D1 / A-04b ' + kind + ' ' + lbl + ': 0-step date is not linked in the Garmin ledger when a neighbour writes', () => {
      const doc = v2({ daily: [{ id: 'daily-' + Z, date: Z, createdAt: '2026-11-21T05:00:00.000Z', steps: manual, intensityMin: { state: 'OBSERVED', value: 12, source: 'GARMIN_MANUAL' } }] });
      const t = mk(doc);
      applyBoth(t, kind, [[Z, 0, 35, 0], [N2, 7000, 20, 0]], allTicks([Z, N2]));
      const after = t.data().daily.find((d) => d.id === 'daily-' + Z);
      assert.equal(after.steps.value, manual.value, 'manual day must stay: ' + JSON.stringify(after));
      assert.equal(ledgerHas(t.data(), Z), false, 'ledger byDate keys=' + Object.keys(((settingsOf(t.data()) || {}).garminLedger || {}).byDate || {}));
      assert.equal(ledgerHas(t.data(), N2), true, 'neighbour that wrote should still have a ledger link');
    });
  }
}

test('Meron R5-D1 / A-04c: deleting the manual 0 day afterwards writes no Garmin tombstone', () => {
  const doc = v2({ daily: [{ id: 'daily-' + Z, date: Z, createdAt: '2026-11-21T05:00:00.000Z', steps: { state: 'OBSERVED', value: 0 }, intensityMin: { state: 'OBSERVED', value: 12, source: 'GARMIN_MANUAL' } }] });
  const t = mk(doc);
  applyBoth(t, 'raw', [[Z, 0, 35, 0], [N2, 7000, 20, 0]], allTicks([Z, N2]));
  const ok = t.api.removeRecord('daily', 'daily-' + Z);
  const tombs = JSON.stringify(((settingsOf(t.data()) || {}).garminLedger || {}).tombstones || []);
  assert.equal(ok, true);
  assert.equal(tombs.includes(Z), false, 'tombs=' + tombs);
});

test('Meron R5-D1: a manual-wins worn day with no Replace gets no ledger link when a neighbour writes', () => {
  const doc = v2({ daily: [{ id: 'daily-' + N1, date: N1, createdAt: '2026-11-20T05:00:00.000Z', steps: { state: 'OBSERVED', value: 8000 }, intensityMin: { state: 'OBSERVED', value: 12, source: 'GARMIN_MANUAL' } }] });
  const t = mk(doc);
  applyBoth(t, 'raw', [[N1, 7000, 20, 0], [N2, 7000, 20, 0]], tickOnly([N1, N2]));
  const kept = t.data().daily.find((d) => d.date === N1);
  assert.equal(kept.steps.value, 8000);
  assert.equal(kept.intensityMin && kept.intensityMin.value, 12);
  assert.equal(ledgerHas(t.data(), N1), false, 'manual-wins date must not be linked');
  assert.equal(ledgerHas(t.data(), N2), true);
});

test('Meron R5-D2 / B-04: a held date that also has a Fetch row stays HOLD only, never New', () => {
  const t = mk(v2());
  const p = G.payloadsFromFetchBody({ ok: true, rows: { daily: [mRow(N1, 5000, 1, 1)] }, held: [{ calendarDate: N1, reason: 'INCOMPLETE_DAY' }] });
  const pv = G.preview(Object.assign({ settings: QA, storeData: v2(), api: t.api }, p));
  const n1 = (pv.items || []).filter((i) => i.date === N1);
  assert.ok(n1.some((i) => i.status === 'HOLD'), 'expected HOLD: ' + JSON.stringify(n1));
  assert.equal(n1.some((i) => i.status === 'New' || i.writable === true), false, JSON.stringify(n1.map((i) => [i.status, i.collection, i.writable])));
});

test('Meron R5-D2 / B-05: apply writes nothing for a held date that also has a Fetch row, even when ticked', () => {
  const t = mk(v2());
  const r = G.applyMerge(t.api, allTicks([N1]), Object.assign({ settings: QA, nowIso: NOWISO }, G.payloadsFromFetchBody({
    ok: true, rows: { daily: [mRow(N1, 5000, 1, 1)] }, held: [{ calendarDate: N1, reason: 'INCOMPLETE_DAY' }]
  })));
  assert.equal(!!(t.data() && (t.data().daily || []).some((d) => d.date === N1)), false, 'r=' + JSON.stringify({ wrote: r.wrote, code: r.code }) + ' daily=' + JSON.stringify(t.data() && t.data().daily));
  assert.equal(!!r.wrote, false);
});

test('Meron R5-D4 / B-06: conflicting same-date Fetch rows HOLD the date, like the raw path', () => {
  const t = mk(v2());
  const p = G.payloadsFromFetchBody({ ok: true, rows: { daily: [mRow(N2, 5000, 1, 1), mRow(N2, 15000, 1, 1)] }, held: [] });
  const pv = G.preview(Object.assign({ settings: QA, storeData: v2(), api: t.api }, p));
  const items = (pv.items || []).filter((i) => i.date === N2);
  assert.ok(items.some((i) => i.status === 'HOLD' && i.reason === 'DUPLICATE_DATE_CONFLICT'), 'preview=' + JSON.stringify(items));
  assert.equal(items.some((i) => i.status === 'New'), false, 'must not offer New: ' + JSON.stringify(items));
  const r = G.applyMerge(t.api, allTicks([N2]), Object.assign({ settings: QA, nowIso: NOWISO }, p));
  const d = t.data() && (t.data().daily || []).find((x) => x.date === N2);
  assert.equal(d, undefined, 'must not write last-wins 15000: ' + JSON.stringify(d) + ' ' + JSON.stringify({ wrote: r.wrote, code: r.code }));
});

test('Meron R5: Fetch HOLD lines show a sanitized held reason, not a raw or hostile code', () => {
  const t = mk(v2());
  const p = G.payloadsFromFetchBody({
    ok: true,
    rows: { daily: [mRow(N2, 7000, 20, 0)], weight: [], activities: [], sleep: [] },
    held: [{ calendarDate: N1, reason: 'INCOMPLETE_DAY' }, { calendarDate: Z, reason: 'DUPLICATE_DATE_CONFLICT' }, { calendarDate: '2026-11-19', reason: 'EVIL<script>' }]
  });
  const pv = G.preview(Object.assign({ settings: QA, storeData: v2(), api: t.api }, p));
  function previewHost() {
    function el(tag) {
      const n = {
        tagName: String(tag).toUpperCase(), attrs: {}, children: [], textContent: '', disabled: false, checked: false, type: '',
        style: {}, listeners: {},
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k]; },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        appendChild(c) { this.children.push(c); return c; }
      };
      return n;
    }
    const host = {
      children: [], textContent: '',
      get firstChild() { return this.children[0] || null; },
      appendChild(c) { this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
    };
    host.ownerDocument = { createElement: el, querySelector() { return null; } };
    return host;
  }
  const host = previewHost();
  const out = G.renderPreview(host, Object.assign({ forceRender: true }, pv));
  assert.equal(out.ok, true);
  const texts = [];
  function walk(n) { if (!n) return; if (n.textContent) texts.push(n.textContent); (n.children || []).forEach(walk); }
  host.children.forEach(walk);
  const blob = texts.join('\n');
  assert.match(blob, /HOLD/);
  assert.match(blob, /2026-11-20/);
  assert.match(blob, /not complete yet/i);
  assert.match(blob, /2026-11-21/);
  assert.match(blob, /did not agree/i);
  assert.doesNotMatch(blob, /INCOMPLETE_DAY|DUPLICATE_DATE_CONFLICT|EVIL|<script>/);
  // 0-step status stays exact when present; this fixture has no 0-step day
});

test('Meron R5-D3: Open Morning tap target is at least 24 px high, preferably 44 px', () => {
  const t = mk(v2());
  const pv = G.preview({
    settings: QA,
    dailyPayload: { data: [rawRow(Z, 0, 35, 0)] },
    storeData: v2(), api: t.api, nowIso: NOWISO
  });
  function el(tag) {
    const n = {
      tagName: String(tag).toUpperCase(), attrs: {}, children: [], textContent: '', disabled: false, checked: false, type: '',
      style: {}, listeners: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      appendChild(c) { this.children.push(c); return c; }
    };
    return n;
  }
  const host = {
    children: [], textContent: '',
    get firstChild() { return this.children[0] || null; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    ownerDocument: { createElement: el, querySelector() { return null; } }
  };
  G.renderPreview(host, Object.assign({ forceRender: true }, pv));
  const all = [];
  function walk(n) { if (!n) return; all.push(n); (n.children || []).forEach(walk); }
  host.children.forEach(walk);
  const label = all.find((n) => n.attrs && n.attrs['data-testid'] === 'garmin-zero-steps');
  const btn = all.find((n) => n.attrs && n.attrs['data-testid'] === 'garmin-zero-steps-morning');
  assert.ok(label, 'zero-steps label');
  assert.equal(label.textContent.startsWith('Garmin shows 0 steps, likely not worn'), true, label.textContent);
  assert.ok(btn, 'Open Morning button');
  const minH = parseFloat(btn.style.minHeight || btn.style.height || '0');
  assert.ok(minH >= 24, 'minHeight must be at least 24px, got ' + JSON.stringify(btn.style));
  assert.ok(minH >= 44, 'prefer 44px iOS target, got ' + minH);
});

test('Meron R5: 0-step status stays exactly “Garmin shows 0 steps, likely not worn”', () => {
  assert.equal(G.ZERO_STEPS_STATUS, 'Garmin shows 0 steps, likely not worn');
  const t = mk(v2());
  const pv = G.preview({ settings: QA, dailyPayload: { data: [rawRow(Z, 0, 35, 0)] }, storeData: v2(), api: t.api, nowIso: NOWISO });
  const zi = (pv.items || []).filter((i) => i.date === Z);
  assert.ok(zi.length >= 1);
  zi.forEach((i) => assert.equal(i.status, 'Garmin shows 0 steps, likely not worn'));
});
