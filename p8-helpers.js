'use strict';
// Phase 8: copy of p3-helpers.js with NOW shifted +7 days (plan re-anchored: Week 1 = 16-22 Nov). Used by the date-shifted test files.
const path = require('node:path');
const HD = require(path.resolve(__dirname, '../src/data/hyrox-data.js'));
const NOW = new Date('2026-11-18T09:00:00Z');
const KEY = 'hyrox.v1', RECOVERY = 'hyrox.v1.corrupt-backup', PRE = 'hyrox.v1.pre-import-backup';
function mem(init, fail) {
  const m = Object.assign({}, init || {});
  return {
    m, writes: 0,
    getItem(k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem(k, v) { if (fail && fail(k, v)) throw new Error('QuotaExceeded'); this.writes++; m[k] = String(v); },
    removeItem(k) { this.writes++; delete m[k]; },
  };
}
const mk = (s) => HD.createStore(s, { now: () => NOW });
const O = (v) => ({ state: 'OBSERVED', value: v });
const MISSING = { state: 'MISSING', value: null };
const U = { value: null, state: 'UNKNOWN' };
const K = (v) => ({ value: v, state: 'KNOWN' });
const ts = NOW.toISOString();
function backup(extra, version) {
  return JSON.stringify(Object.assign({ app: 'hyrox-app', version: version === undefined ? 2 : version, exportedAt: ts, weight: [], workouts: [], nutrition: [] }, extra));
}
function restore(st, text) {
  const p = st.previewImport(text);
  if (!p.ok) return p;
  return st.applyImport(text, { confirm: 'REPLACE', expectCurrent: p.preview.current, expectCurrentExt: p.preview.currentExt });
}
module.exports = { HD, NOW, KEY, RECOVERY, PRE, mem, mk, O, MISSING, U, K, ts, backup, restore };
