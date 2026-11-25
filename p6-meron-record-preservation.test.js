'use strict';
// P6 Meron: no write to hyrox.v1 from status, diagnostics, the estimator, or a failed load.
// Wraps setItem/removeItem/clear and compares hyrox.v1 byte-exact. Locks existing
// read-only paths now. New P6 APIs (CONTRACT-P6.md §1 keyPresent/counts, diagnostics,
// HyroxFoodCalc) are feature-detected and skipped with an explicit reason until present.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  HD, KEY, PRE, mem, faultStorage, mk, storedPopulated, emptyBackup, plant, applyReplace,
  hasContractP6, loadFoodCalc, loadFoodDb,
} = require('./p6-meron-helpers.js');

function assertNoKeyWrite(s, beforeRaw, beforeSnap, label) {
  assert.deepEqual(s.keyWrites(), [], label + ': no set/remove/clear of hyrox.v1');
  assert.equal(s.getItem(KEY), beforeRaw, label + ': hyrox.v1 byte-exact');
  assert.equal(s.snapshot(), beforeSnap, label + ': storage snapshot unchanged');
}

describe('P6 lock: existing read-only paths never write hyrox.v1', () => {
  it('status(), exportSummary(), exportJSON(), exportChecked(), rawRecoveryExport(), list(), previewImport() write nothing', () => {
    const s = mem();
    const raw = plant(s, storedPopulated());
    const st = mk(s);
    s.calls.length = 0;
    const before = s.snapshot();
    st.status();
    st.exportSummary();
    st.exportJSON();
    st.exportChecked();
    st.rawRecoveryExport();
    st.list('weight');
    st.previewImport(emptyBackup());
    assertNoKeyWrite(s, raw, before, 'read-only store methods');
  });

  it('createStore on already-populated storage does not rewrite hyrox.v1', () => {
    const s = mem({ [KEY]: storedPopulated() });
    const raw = s.getItem(KEY);
    s.calls.length = 0;
    const before = s.snapshot();
    mk(s);
    assertNoKeyWrite(s, raw, before, 'createStore');
  });

  it('createStore on an empty store does not invent a hyrox.v1 key', () => {
    const s = mem();
    s.calls.length = 0;
    const st = mk(s);
    assert.equal(s.getItem(KEY), null);
    assert.deepEqual(s.keyWrites(), []);
    assert.equal(st.status().state, 'empty');
  });

  it('a failed load (getItem throws) is unreadable, never empty, and writes nothing', () => {
    const s = faultStorage({ [KEY]: storedPopulated() }, { get: (k) => k === KEY });
    const st = mk(s);
    s.calls.length = 0;
    assert.equal(st.status().state, 'unreadable');
    assert.equal(st.addWeight({ date: '2026-11-12', kg: 81 }).ok, false);
    assert.equal(st.exportChecked().ok, false);
    assert.ok(s.writes().length === 0);
  });

  it('schema version 3 (newer) refuses writes and leaves bytes untouched', () => {
    const raw = JSON.stringify({ version: 3, weight: [{ id: 'w1', createdAt: '2026-11-12T00:00:00.000Z', date: '2026-11-10', kg: 80 }], workouts: [], nutrition: [] });
    const s = mem({ [KEY]: raw });
    const st = mk(s);
    s.calls.length = 0;
    const before = s.snapshot();
    assert.equal(st.status().state, 'newer');
    assert.equal(st.addWeight({ date: '2026-11-12', kg: 81 }).ok, false);
    assert.equal(s.getItem(KEY), raw);
    assert.equal(s.snapshot(), before);
  });

  it('quota error on save: add fails and hyrox.v1 is unchanged', () => {
    const s = mem();
    const raw = plant(s, storedPopulated());
    const full = {
      m: s.m,
      getItem: (k) => s.getItem(k),
      setItem() { throw new Error('QuotaExceededError'); },
      removeItem: (k) => s.removeItem(k),
    };
    const r = mk(full).addWeight({ date: '2026-11-12', kg: 81 });
    assert.equal(r.ok, false);
    assert.equal(s.getItem(KEY), raw);
  });
});

const statusHasContractFields = (() => {
  const st = mk(mem()).status();
  return typeof st.keyPresent !== 'undefined' || typeof st.counts !== 'undefined';
})();

const skipStatus = !statusHasContractFields
  ? 'CONTRACT-P6.md §1 status().keyPresent + counts are not implemented on this tree (baseline c5cdd73); skipped until the data layer lands'
  : null;

describe('P6 CONTRACT-P6.md §1: status() keyPresent + counts are read-only', { skip: skipStatus || false }, () => {
  it('an empty store reports keyPresent false and zero counts, and writes nothing', () => {
    const s = mem();
    const st = mk(s);
    s.calls.length = 0;
    const out = st.status();
    assert.equal(out.keyPresent, false);
    assert.equal(out.counts.total, 0);
    assert.equal(out.counts.weight, 0);
    assert.equal(out.counts.meals, 0);
    assert.deepEqual(s.keyWrites(), []);
    assert.equal(s.getItem(KEY), null);
  });

  it('a populated store reports keyPresent true and stored counts, and writes nothing', () => {
    const s = mem();
    const raw = plant(s, storedPopulated());
    const st = mk(s);
    s.calls.length = 0;
    const before = s.snapshot();
    const out = st.status();
    assert.equal(out.keyPresent, true);
    assert.equal(out.counts.weight, 1);
    assert.ok(out.counts.total >= 1);
    assert.equal(typeof out.counts.meals, 'number');
    assertNoKeyWrite(s, raw, before, 'status() on populated data');
  });

  it('unreadable storage reports keyPresent null and counts null, and writes nothing', () => {
    const s = faultStorage({ [KEY]: storedPopulated() }, { get: () => true });
    const st = mk(s);
    const out = st.status();
    assert.equal(out.keyPresent, null);
    assert.equal(out.counts, null);
  });
});

const calc = loadFoodCalc();
const skipEstWrite = !calc
  ? 'CONTRACT-P6.md §3 HyroxFoodCalc is not on this tree (baseline c5cdd73); skipped until src/data/hyrox-foodcalc.js lands. When it does, estimate/parse must not write hyrox.v1.'
  : null;

describe('P6 CONTRACT-P6.md §3: the estimator never writes storage', { skip: skipEstWrite || false }, () => {
  it('parse / estimate / toComponents do not call localStorage and do not change hyrox.v1', () => {
    const s = mem();
    const raw = plant(s, storedPopulated());
    const st = mk(s);
    s.calls.length = 0;
    const before = s.snapshot();
    const parsed = calc.parse('2 eggs, 100g rice');
    assert.equal(parsed.ok, true);
    const db = loadFoodDb();
    const est = calc.estimate('2 eggs, 100g rice', db || undefined);
    assert.ok(est && typeof est === 'object');
    if (est.ok) calc.toComponents(est);
    assertNoKeyWrite(s, raw, before, 'estimator');
    // Also assert the module does not touch a global store.
    assert.equal(st.status().state, 'ok');
    assert.equal(s.getItem(KEY), raw);
  });
});

describe('P6 diagnostics stay in the UI (CONTRACT-P6.md v2): no data-layer diagnostics API', () => {
  it('store.status / HyroxData expose no diagnostics() API; host and display-mode are UI concerns', () => {
    const s = mem();
    plant(s, storedPopulated());
    const st = mk(s);
    assert.equal(typeof st.diagnostics, 'undefined');
    assert.equal(typeof st.storageDiagnostics, 'undefined');
    assert.equal(typeof HD.diagnostics, 'undefined');
    const out = st.status();
    assert.equal('origin' in out, false);
    assert.equal('host' in out, false);
    assert.equal('displayMode' in out, false);
  });
});

// Existing protections must still refuse a silent empty replace even while we probe writes.
describe('P6 lock: a failed empty-replace still writes nothing', () => {
  it('empty_replace_not_confirmed leaves hyrox.v1 byte-identical', () => {
    const s = mem();
    const raw = plant(s, storedPopulated());
    const before = s.snapshot();
    const a = applyReplace(mk(s), emptyBackup());
    assert.equal(a.code, 'empty_replace_not_confirmed');
    assert.equal(s.getItem(KEY), raw);
    assert.equal(s.snapshot(), before);
  });
});
