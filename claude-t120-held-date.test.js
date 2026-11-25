'use strict';
// Claude QA t120 (24 Nov 2026), fail-first: held entries and invalid dates in the Fetch body are untrusted. The preview must
// not turn a non-date into a HOLD line, and the rendered text must never show a non-date as the date. Fails on c06af0b.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const G = require(path.join(__dirname, '..', 'src/integrations/garmin-import.js'));
const NOWISO = '2026-11-24T06:00:00.000Z', QA = { timeZone: 'Asia/Qatar' };
function body() { return { ok: true, rows: { daily: [{ calendarDate: '2026-11-23', steps: 8400, intensity: { moderate: 30, vigorous: 8, value: 46 }, inProgress: false }, { calendarDate: 'y'.repeat(200), steps: 5, inProgress: false }] },
  held: [{ calendarDate: '<b id="qa">2026-11-19</b>', reason: 'DUPLICATE_DATE_CONFLICT' }, { calendarDate: 'x'.repeat(300), reason: 'INCOMPLETE_DAY' }, { calendarDate: '2026-11-21', reason: 'INCOMPLETE_DAY' }] }; }
test('t120: held entries need a real calendar date; the valid one still shows as HOLD', () => {
  const pv = G.preview(Object.assign({ settings: QA, storeData: { daily: [] }, nowIso: NOWISO }, G.payloadsFromFetchBody(body())));
  const holds = pv.items.filter((i) => i.status === 'HOLD').map((i) => i.date);
  assert.deepEqual(holds, ['2026-11-21']);
});
function fakeDoc() { const mk = (tag) => { const el = { tagName: tag, children: [], style: {}, attrs: {}, textContent: '', appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, set innerHTML(v) { this.children = []; }, get innerHTML() { return ''; } }; return el; };
  return { createElement: mk, querySelector: () => null }; }
function texts(el, acc) { acc = acc || []; if (el.textContent) acc.push(el.textContent); (el.children || []).forEach((c) => texts(c, acc)); return acc; }
test('t120: rendered preview never prints a non-date (wrapping is checked in Chrome)', () => {
  const doc = fakeDoc(); const host = doc.createElement('div'); host.ownerDocument = doc;
  const pv = G.preview(Object.assign({ settings: QA, storeData: { daily: [] }, nowIso: NOWISO }, G.payloadsFromFetchBody(body())));
  const prev = global.document; global.document = doc;
  try { G.renderPreview(host, Object.assign({}, pv, { enabled: true })); } finally { global.document = prev; }
  const all = texts(host).join('\n');
  assert.equal(/xxxxxxxxxx|yyyyyyyyyy|<b id=/.test(all), false, all.slice(0, 400));
});
