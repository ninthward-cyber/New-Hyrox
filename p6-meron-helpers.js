'use strict';
// Shared helpers for Meron Phase 6 tests. Synthetic data only. Does not edit src/.
const fs = require('node:fs');
const path = require('node:path');
const HD = require(path.resolve(__dirname, '../src/data/hyrox-data.js'));

const NOW = new Date('2026-11-13T09:00:00Z');
const TS = NOW.toISOString();
const KEY = HD.STORAGE_KEY;
const PRE = HD.IMPORT_BACKUP_KEY;
const RECOVERY = HD.RECOVERY_KEY;
const ALL = Object.freeze([
  'weight', 'workouts', 'nutrition',
  'sessions', 'meals', 'body', 'daily', 'walks', 'dayStates', 'planEvents', 'ownerSettings',
]);
const CONTRACT_P6 = '/workspace/hyrox-p6/CONTRACT-P6.md';
const hasContractP6 = () => fs.existsSync(CONTRACT_P6);

function mem(init) {
  const m = Object.assign({}, init || {});
  const calls = [];
  return {
    m, calls,
    writes() { return calls.filter((c) => c[0] !== 'get'); },
    keyWrites() { return calls.filter((c) => (c[0] === 'set' || c[0] === 'remove' || c[0] === 'clear') && (c[0] === 'clear' || c[1] === KEY)); },
    snapshot() { return JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]])); },
    getItem(k) {
      calls.push(['get', k]);
      return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null;
    },
    setItem(k, v) {
      calls.push(['set', k, String(v)]);
      m[k] = String(v);
    },
    removeItem(k) {
      calls.push(['remove', k]);
      delete m[k];
    },
    clear() {
      calls.push(['clear']);
      Object.keys(m).forEach((k) => { delete m[k]; });
    },
  };
}

function faultStorage(seed, faults) {
  faults = faults || {};
  const m = Object.assign({}, seed || {});
  const calls = [];
  const setCount = {};
  const getCount = {};
  return {
    m, calls,
    writes() { return calls.filter((c) => c[0] !== 'get'); },
    snapshot() { return JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]])); },
    getItem(k) {
      calls.push(['get', k]);
      getCount[k] = (getCount[k] || 0) + 1;
      if (faults.get && faults.get(k, getCount[k])) throw new Error('SecurityError');
      return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null;
    },
    setItem(k, v) {
      const s = String(v);
      calls.push(['set', k, s]);
      setCount[k] = (setCount[k] || 0) + 1;
      const f = faults.set && faults.set(k, s, setCount[k]);
      if (f === 'throw') throw new Error('QuotaExceededError');
      if (f === 'ignore') return;
      if (f === 'truncate') { m[k] = s.slice(0, 7); return; }
      m[k] = s;
    },
    removeItem(k) {
      calls.push(['remove', k]);
      if (faults.remove && faults.remove(k)) throw new Error('SecurityError');
      delete m[k];
    },
    clear() {
      calls.push(['clear']);
      Object.keys(m).forEach((k) => { delete m[k]; });
    },
  };
}

const mk = (s) => HD.createStore(s, { now: () => NOW });

function validWeight(id, kg) {
  return { id: id || 'w-live', createdAt: TS, date: '2026-11-12', kg: kg == null ? 80.2 : kg };
}

function storedPopulated() {
  return JSON.stringify({
    version: 2,
    weight: [validWeight()],
    workouts: [],
    nutrition: [],
  });
}

function emptyBackup() {
  return JSON.stringify({
    app: 'hyrox-app', version: 2, exportedAt: TS,
    weight: [], workouts: [], nutrition: [],
  });
}

function backup(extra) {
  return JSON.stringify(Object.assign({
    app: 'hyrox-app', version: 2, exportedAt: TS,
    weight: [], workouts: [], nutrition: [],
  }, extra));
}

function plant(s, raw) {
  if (typeof raw !== 'string') raw = JSON.stringify(raw);
  s.setItem(KEY, raw);
  s.calls.length = 0;
  return raw;
}

function applyReplace(st, text, extra) {
  const p = st.previewImport(text);
  const opts = Object.assign({
    confirm: 'REPLACE',
    expectCurrent: p.ok ? p.preview.current : undefined,
    expectCurrentExt: p.ok ? p.preview.currentExt : undefined,
  }, extra || {});
  return st.applyImport(text, opts);
}

function loadFoodCalc() {
  const p = path.resolve(__dirname, '../src/data/hyrox-foodcalc.js');
  if (!fs.existsSync(p)) return null;
  return require(p);
}

function loadFoodDb() {
  const p = path.resolve(__dirname, '../src/data/food-db.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function usdaRef() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/p6-usda-reference.json'), 'utf8'));
}

function skipUnless(cond, reason, fn) {
  const it = require('node:test').it;
  if (cond) return it(fn ? fn.name || 'test' : 'test', fn);
  return it(reason, { skip: reason }, () => {});
}

module.exports = {
  HD, NOW, TS, KEY, PRE, RECOVERY, ALL, CONTRACT_P6,
  hasContractP6, mem, faultStorage, mk, validWeight, storedPopulated,
  emptyBackup, backup, plant, applyReplace, loadFoodCalc, loadFoodDb, usdaRef, skipUnless,
};
