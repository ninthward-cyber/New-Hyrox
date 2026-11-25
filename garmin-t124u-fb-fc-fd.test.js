'use strict';
// t124u fail-first tests (Claude QA t120 F-B, F-C, F-D) on c06af0b, 24 Nov 2026.
// Synthetic in-memory storage only. No network. VoiceOver and a physical iPhone are untested.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const HD = require(path.join(ROOT, 'src/data/hyrox-data.js'));
const G = require(path.join(ROOT, 'src/integrations/garmin-import.js'));

const QA = { timeZone: 'Asia/Qatar' };
const KEY = HD.STORAGE_KEY;
const NOWISO = '2026-11-24T06:00:00.000Z';
const P = '2026-11-23';
const H = '2026-11-21';

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
  return {
    calendarDate: date, source: 'garmin', uuid: 'syn-' + date, includesWellnessData: true,
    movement: { steps: { value: steps } }, intensityMinutes: { moderate: mod, vigorous: vig },
    wellnessChronology: chron(date)
  };
}
function settingsRec(ledger) {
  const rec = { id: 'app-settings', date: '2026-11-20', createdAt: '2026-11-20T05:00:00.000Z' };
  if (arguments.length) rec.garminLedger = ledger;
  return rec;
}
function applyWorn(t, date) {
  return G.applyMerge(t.api, { applySteps: { [date]: true }, applyIntensity: { [date]: true } }, {
    settings: QA, dailyPayload: { data: [rawRow(date, 8400, 30, 8)] }, nowIso: NOWISO
  });
}

// ---- F-A extras: calendar validation, wrap, legitimate HOLD still blocks, 0-step / manual-wins stay ----
test('t124u F-A: a non-calendar YYYY-MM-DD (2026-11-31) is not shown as a HOLD date', () => {
  const pv = G.preview(Object.assign({ settings: QA, storeData: { daily: [] }, nowIso: NOWISO }, G.payloadsFromFetchBody({
    ok: true, rows: { daily: [{ calendarDate: '2026-11-23', steps: 8400, intensity: { moderate: 30, vigorous: 8, value: 46 }, inProgress: false }] },
    held: [{ calendarDate: '2026-11-31', reason: 'INCOMPLETE_DAY' }, { calendarDate: '2026-11-21', reason: 'INCOMPLETE_DAY' }]
  })));
  const holds = (pv.items || []).filter((i) => i.status === 'HOLD').map((i) => i.date);
  assert.deepEqual(holds, ['2026-11-21']);
  assert.equal(G.isIsoDate('2026-11-31'), false);
  assert.equal(G.isIsoDate('2026-11-21'), true);
});

test('t124u F-A: preview labels wrap long text (overflow-wrap:anywhere) and a legitimate HOLD still blocks writes', () => {
  const t = mk(v2());
  const payloads = G.payloadsFromFetchBody({
    ok: true,
    rows: { daily: [
      { calendarDate: '2026-11-23', steps: 8400, intensity: { moderate: 30, vigorous: 8, value: 46 }, inProgress: false },
      { calendarDate: '2026-11-21', steps: 1200, intensity: { moderate: 10, vigorous: 0, value: 10 }, inProgress: false }
    ] },
    held: [{ calendarDate: '2026-11-21', reason: 'INCOMPLETE_DAY' }]
  });
  const pv = G.preview(Object.assign({ settings: QA, storeData: { daily: [] }, nowIso: NOWISO }, payloads));
  assert.ok((pv.items || []).some((i) => i.date === '2026-11-21' && i.status === 'HOLD'));
  const r = G.applyMerge(t.api, { applySteps: { '2026-11-21': true, '2026-11-23': true }, applyIntensity: { '2026-11-21': true, '2026-11-23': true } }, Object.assign({ settings: QA, nowIso: NOWISO }, payloads));
  const daily = t.data() && t.data().daily || [];
  assert.equal(daily.some((d) => d.date === '2026-11-21'), false, 'held date must not be written');
  assert.ok(r.wrote && daily.some((d) => d.date === '2026-11-23' && d.steps && d.steps.value === 8400));

  const doc = { createElement(tag) { return { tagName: tag, children: [], style: {}, attrs: {}, textContent: '', appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {} }; }, querySelector() { return null; } };
  const host = doc.createElement('div'); host.ownerDocument = doc;
  const prev = global.document; global.document = doc;
  try { G.renderPreview(host, Object.assign({}, pv, { enabled: true })); } finally { global.document = prev; }
  const wraps = [];
  (function walk(n) { if (!n) return; if (n.style && n.style.overflowWrap) wraps.push(n.style.overflowWrap); (n.children || []).forEach(walk); })(host);
  assert.ok(wraps.some((w) => w === 'anywhere'), 'labels must set overflow-wrap:anywhere: ' + JSON.stringify(wraps));
});

test('t124u F-A: raw and Fetch 0 steps with 0 or 35 min still import nothing under force tick/Replace; worn intensity and manual-wins hold', () => {
  for (const [kind, build] of [
    ['raw', (date, steps, mod, vig) => ({ dailyPayload: { data: [rawRow(date, steps, mod, vig)] } })],
    ['fetch', (date, steps, mod, vig) => G.payloadsFromFetchBody({ ok: true, rows: { daily: [{ calendarDate: date, steps, intensity: steps === 0 ? null : { moderate: mod, vigorous: vig, value: mod + 2 * vig }, inProgress: false }] } })]
  ]) {
    for (const [steps, mod, vig] of [[0, 0, 0], [0, 25, 5]]) {
      const t = mk(v2());
      const r = G.applyMerge(t.api, {
        applySteps: { [P]: true }, applyIntensity: { [P]: true }, replaceSteps: { [P]: true }, replaceIntensity: { [P]: true }
      }, Object.assign({ settings: QA, nowIso: NOWISO }, build(P, steps, mod, vig)));
      assert.equal((t.data() && t.data().daily || []).some((d) => d.date === P), false, kind + ' 0-step ' + steps + '/' + mod + ' must write nothing: ' + JSON.stringify(r));
    }
  }
  const worn = mk(v2({ daily: [{ id: 'daily-' + P, date: P, createdAt: P + 'T05:00:00.000Z', steps: { state: 'OBSERVED', value: 8000 } }] }));
  const wr = G.applyMerge(worn.api, { applySteps: { [P]: true }, applyIntensity: { [P]: true } }, {
    settings: QA, dailyPayload: { data: [rawRow(P, 7000, 30, 8)] }, nowIso: NOWISO
  });
  const d = worn.data().daily.find((x) => x.date === P);
  assert.equal(d.steps.value, 8000, 'manual steps win without Replace');
  assert.equal(d.intensityMin && d.intensityMin.value, 46, 'worn-day intensity still imports');
  assert.equal(!!wr.wrote, true);
});

// ---- F-B: after Open Morning, focus a Morning heading or first input once the form is mounted ----
test('t124u F-B: Open Morning moves focus to the Morning form heading or first input after the form is mounted', () => {
  const r0 = rawRow(P, 0, 0, 0);
  delete r0.intensityMinutes;
  r0.movement.steps.value = 0;
  const pv = G.preview({ settings: QA, dailyPayload: { data: [r0] }, storeData: v2(), nowIso: NOWISO });

  function el(tag) {
    const n = {
      tagName: String(tag).toUpperCase(), attrs: {}, children: [], textContent: '', style: {},
      disabled: false, tabIndex: -1,
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'data-testid') this._testid = String(v); if (k === 'tabindex') this.tabIndex = Number(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
      addEventListener(type, fn) { (this.listeners = this.listeners || {})[type] = (this.listeners[type] || []).concat(fn); },
      click() { (this.listeners && this.listeners.click || []).forEach((fn) => fn()); },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      focus() { n._doc.activeElement = n; },
      querySelector(sel) {
        const all = [];
        (function walk(x) { all.push(x); (x.children || []).forEach(walk); })(n);
        if (sel === 'h2, h1, [data-testid="mlog-morning-heading"]') return all.find((x) => x.tagName === 'H2' || x.tagName === 'H1' || (x.attrs && x.attrs['data-testid'] === 'mlog-morning-heading')) || null;
        if (sel === 'input:not([disabled]), textarea:not([disabled]), select:not([disabled])') return all.find((x) => x.tagName === 'INPUT' && !x.disabled) || null;
        if (/^\[data-testid="(.+)"\]$/.test(sel)) { const id = RegExp.$1; return all.find((x) => x.attrs && x.attrs['data-testid'] === id) || null; }
        if (sel === 'h2' || sel === 'h1') return all.find((x) => x.tagName === sel.toUpperCase()) || null;
        return null;
      }
    };
    return n;
  }
  const form = el('section');
  form.setAttribute('data-testid', 'morning-form');
  const heading = el('h2'); heading.textContent = 'Morning log';
  const input = el('input'); input.setAttribute('data-testid', 'mlog-weight');
  form.appendChild(heading); form.appendChild(input);

  const registry = {
    '[data-testid="tab-add"]': { click() { registry._add = true; } },
    '[data-testid="add-mode-morning"]': { click() { registry._morn = true; registry['[data-testid="morning-form"]'] = form; } }
  };
  const doc = {
    activeElement: { tagName: 'BODY' },
    createElement: el,
    querySelector(sel) { return registry[sel] || null; }
  };
  form._doc = doc; heading._doc = doc; input._doc = doc;
  const host = el('div'); host.ownerDocument = doc; host._doc = doc;
  const prev = global.document; global.document = doc;
  try {
    G.renderPreview(host, Object.assign({ forceRender: true, enabled: true }, pv));
    const all = [];
    (function walk(n) { if (!n) return; all.push(n); (n.children || []).forEach(walk); })(host);
    const btn = all.find((n) => n.attrs && n.attrs['data-testid'] === 'garmin-zero-steps-morning');
    assert.ok(btn, 'expected Open Morning');
    btn.click();
    assert.equal(registry._add, true);
    assert.equal(registry._morn, true);
    const focused = doc.activeElement;
    assert.ok(focused && focused !== doc && focused.tagName !== 'BODY', 'focus must leave BODY: ' + (focused && focused.tagName));
    const inside = focused === heading || focused === input || focused === form;
    assert.equal(inside, true, 'focus must be the Morning heading or first input, got ' + (focused && focused.tagName) + ' ' + JSON.stringify(focused && focused.attrs));
    assert.ok(focused.tagName === 'H2' || focused.tagName === 'H1' || focused.tagName === 'H3' || focused.tagName === 'INPUT', focused.tagName);
  } finally { global.document = prev; }
});

// ---- F-C: '', 0, false are LEDGER_CORRUPT; missing and null follow no-ledger; F3 null save preserved ----
for (const [label, value] of [['empty string', ''], ['zero', 0], ['false', false]]) {
  test('t124u F-C: persisted garminLedger ' + label + ' is LEDGER_CORRUPT and preserves original bytes', () => {
    const doc = v2({
      daily: [{ id: 'daily-' + P, date: P, createdAt: P + 'T05:00:00.000Z', steps: { state: 'OBSERVED', value: 1000 } }],
      ownerSettings: [settingsRec(value)]
    });
    const t = mk(doc);
    const before = t.raw();
    const r = applyWorn(t, P);
    assert.equal(r.ok, false);
    assert.equal(r.wrote, false);
    assert.equal(r.code, 'LEDGER_CORRUPT');
    assert.equal(t.raw(), before, 'original bytes must be unchanged');
    assert.match(G.ownerMessageForApply(r), /Garmin import links in your settings could not be read/i);
    assert.match(G.ownerMessageForApply(r), /Nothing was changed/);
    assert.doesNotMatch(G.ownerMessageForApply(r), /this check-in/i);
    assert.equal(t.api.removeRecord('daily', 'daily-' + P), false);
    assert.equal(t.raw(), before);
    const last = t.api.lastRemoveResult();
    assert.equal(last.reason, 'LEDGER_CORRUPT');
    assert.match(last.message, /Nothing was deleted/);
  });
}

test('t124u F-C: a missing garminLedger property follows no-ledger handling and can write a new ledger', () => {
  const t = mk(v2({ ownerSettings: [settingsRec()] })); // no garminLedger key
  const rec = (t.data().ownerSettings || []).find((e) => e.id === 'app-settings');
  assert.equal(Object.prototype.hasOwnProperty.call(rec, 'garminLedger'), false);
  const r = applyWorn(t, P);
  assert.equal(r.ok, true);
  assert.equal(r.wrote, true);
  const led = (t.data().ownerSettings || []).find((e) => e.id === 'app-settings').garminLedger;
  assert.ok(led && typeof led === 'object' && !Array.isArray(led));
  assert.ok(led.byDate && led.byDate[P]);
});

test('t124u F-C: a persisted null garminLedger follows no-ledger handling (fresh ledger on apply)', () => {
  const t = mk(v2({ ownerSettings: [settingsRec(null)] }));
  const rec = (t.data().ownerSettings || []).find((e) => e.id === 'app-settings');
  assert.equal(rec.garminLedger, null);
  const r = applyWorn(t, P);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.wrote, true);
  const led = (t.data().ownerSettings || []).find((e) => e.id === 'app-settings').garminLedger;
  assert.ok(led && led.byDate && led.byDate[P], 'null stored ledger is treated as none, so a real import may create a ledger');
});

test('t124u F-C / F3: garminLedger:null on a settings save keeps an existing valid ledger and tombstones byte-for-byte', () => {
  const t = mk(v2());
  const r0 = applyWorn(t, P);
  assert.equal(r0.wrote, true);
  assert.equal(t.api.removeRecord('daily', 'daily-' + P), true);
  const settings = (t.data().ownerSettings || []).find((e) => e && e.id === 'app-settings');
  const before = JSON.stringify(settings.garminLedger);
  assert.ok(settings.garminLedger && Array.isArray(settings.garminLedger.tombstones) && settings.garminLedger.tombstones.length);
  const nr = JSON.parse(JSON.stringify(settings));
  nr.garminLedger = null;
  nr.rhrBaselineBpm = 53;
  const saved = t.api.putRecord('ownerSettings', nr);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const led = (t.data().ownerSettings || []).find((e) => e.id === 'app-settings').garminLedger;
  assert.equal(JSON.stringify(led), before);
});

// ---- F-D: ok:true, wrote:false is "Nothing new to apply.", not a failure; real errors stay ----
test('t124u F-D: a no-write success is “Nothing new to apply.”, not Applied or a failure', () => {
  const t = mk(v2());
  const first = applyWorn(t, P);
  assert.equal(first.ok, true);
  assert.equal(first.wrote, true);
  const before = t.raw();
  const second = applyWorn(t, P);
  assert.equal(second.ok, true);
  assert.equal(second.wrote, false);
  assert.equal(t.raw(), before);
  const msg = G.ownerMessageForApply(second);
  assert.equal(msg, 'Nothing new to apply.');
  assert.doesNotMatch(msg, /Could not apply/);
  assert.doesNotMatch(msg, /Applied \(verified\)/);
});

test('t124u F-D: real errors are not masked by the no-write success wording', () => {
  const corrupt = mk(v2({ ownerSettings: [settingsRec('not-an-object')] }));
  const bad = applyWorn(corrupt, P);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'LEDGER_CORRUPT');
  assert.match(G.ownerMessageForApply(bad), /could not be read/i);
  assert.doesNotMatch(G.ownerMessageForApply(bad), /Nothing new to apply/);

  const heldOnly = mk(v2());
  const held = G.applyMerge(heldOnly.api, { applySteps: { [H]: true } }, Object.assign({ settings: QA, nowIso: NOWISO }, G.payloadsFromFetchBody({
    ok: true, rows: { daily: [] }, held: [{ calendarDate: H, reason: 'INCOMPLETE_DAY' }]
  })));
  assert.equal(held.ok, true);
  assert.equal(held.wrote, false);
  assert.match(G.ownerMessageForApply(held), /not complete yet/);
  assert.doesNotMatch(G.ownerMessageForApply(held), /Nothing new to apply/);
  assert.doesNotMatch(G.ownerMessageForApply(held), /Applied \(verified\)/);
});
