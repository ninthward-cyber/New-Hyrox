'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function resolveDataPath() {
  if (process.env.HYROX_DATA_PATH) {
    return path.resolve(process.env.HYROX_DATA_PATH);
  }
  // Default: ../src/data/hyrox-data.js relative to tests/ (resolves after merge to main).
  const defaultPath = path.resolve(__dirname, '../src/data/hyrox-data.js');
  if (fs.existsSync(defaultPath)) return defaultPath;
  const fallback = '/workspace/hyrox-wt/data/src/data/hyrox-data.js';
  if (fs.existsSync(fallback)) return fallback;
  throw new Error(
    'hyrox-data.js not found. Set HYROX_DATA_PATH or place the module at ../src/data/hyrox-data.js'
  );
}

function loadHyroxData() {
  const dataPath = resolveDataPath();
  const exported = require(dataPath);
  if (exported && typeof exported.createStore === 'function' && typeof exported.todayQatar === 'function') {
    return exported;
  }
  if (
    typeof globalThis.HyroxData === 'object' &&
    globalThis.HyroxData &&
    typeof globalThis.HyroxData.createStore === 'function'
  ) {
    return globalThis.HyroxData;
  }
  throw new Error('Module did not export HyroxData via module.exports or global HyroxData');
}

const HyroxData = loadHyroxData();
const STORAGE_KEY = HyroxData.STORAGE_KEY || 'hyrox.v1';

// Fixed clock: 2026-11-10 15:00 in Asia/Qatar (UTC+3).
const FIXED_NOW = new Date('2026-11-10T12:00:00.000Z');
const TODAY = '2026-11-10';
const YESTERDAY = '2026-11-09';
const TOMORROW = '2026-11-11';

function memoryStorage(seed) {
  const m = Object.assign({}, seed);
  return {
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null;
    },
    setItem(k, v) {
      m[k] = String(v);
    },
  };
}

function makeStore(storage, now) {
  const clock = now === undefined ? FIXED_NOW : now;
  return HyroxData.createStore(storage, { now: () => (clock instanceof Date ? clock : new Date(clock)) });
}

function assertOk(res) {
  assert.equal(res.ok, true, `expected ok:true, got ${JSON.stringify(res)}`);
  assert.ok(res.entry && typeof res.entry === 'object', 'expected an entry');
  assert.equal(typeof res.entry.id, 'string');
  return res.entry;
}

function assertFail(res, field) {
  assert.equal(res.ok, false, `expected ok:false, got ${JSON.stringify(res)}`);
  assert.ok(res.errors && typeof res.errors === 'object', 'expected errors object');
  assert.equal(typeof res.errors[field], 'string', `expected errors.${field} to be a message, got ${JSON.stringify(res.errors)}`);
  assert.ok(res.errors[field].length > 0);
  return res.errors[field];
}

function assertRequired(res, field) {
  const msg = assertFail(res, field);
  assert.match(msg, /required/i, `expected a 'required' error for ${field}, got ${JSON.stringify(msg)}`);
}

function validWorkout(overrides) {
  return Object.assign(
    { date: TODAY, activity: 'SkiErg intervals', durationMin: 45, partial: false, notes: 'Made-up session' },
    overrides
  );
}

function validNutrition(overrides) {
  return Object.assign(
    { date: TODAY, label: 'Test oats', calories: 350, proteinG: 22.5 },
    overrides
  );
}

describe('todayQatar', () => {
  it('returns YYYY-MM-DD for a given instant', () => {
    assert.equal(HyroxData.todayQatar(FIXED_NOW), TODAY);
  });

  it('treats 2026-11-10T22:30Z as 2026-11-11 in Qatar', () => {
    assert.equal(HyroxData.todayQatar(new Date('2026-11-10T22:30:00.000Z')), '2026-11-11');
  });

  it('treats 2026-11-10T20:59Z as 2026-11-10 in Qatar', () => {
    assert.equal(HyroxData.todayQatar(new Date('2026-11-10T20:59:00.000Z')), '2026-11-10');
  });

  it('treats 2026-11-10T21:00Z as 2026-11-11 in Qatar (midnight)', () => {
    assert.equal(HyroxData.todayQatar(new Date('2026-11-10T21:00:00.000Z')), '2026-11-11');
  });

  it('accepts a timestamp string as well as a Date', () => {
    assert.equal(HyroxData.todayQatar('2026-11-10T22:30:00.000Z'), '2026-11-11');
  });

  it('returns today in Qatar when called with no argument', () => {
    assert.match(HyroxData.todayQatar(), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(HyroxData.todayQatar(), HyroxData.todayQatar(new Date()));
  });
});

describe('createStore fallback', () => {
  // Changed in the data-loss fix: an in-memory fallback is NOT persistent, so it
  // must refuse to save instead of reporting success for data lost on reload.
  it('refuses to save (no false success) when no localStorage is available', () => {
    const store = HyroxData.createStore(undefined, { now: () => FIXED_NOW });
    assert.doesNotThrow(() => store.list('weight'));
    const res = store.addWeight({ date: TODAY, kg: 80 });
    assertFail(res, 'storage');
    assert.equal(store.list('weight').length, 0);
    const st = store.status();
    assert.equal(st.persistent, false);
    assert.equal(st.ok, false);
  });
});

describe('addWeight validation', () => {
  it('accepts the lower and upper kg bounds (20 and 400)', () => {
    const store = makeStore(memoryStorage());
    assertOk(store.addWeight({ date: TODAY, kg: 20 }));
    assertOk(store.addWeight({ date: TODAY, kg: 400 }));
    assert.equal(store.list('weight').length, 2);
  });

  it('rejects kg just outside the bounds', () => {
    const store = makeStore(memoryStorage());
    assertFail(store.addWeight({ date: TODAY, kg: 19.9 }), 'kg');
    assertFail(store.addWeight({ date: TODAY, kg: 400.1 }), 'kg');
    assertFail(store.addWeight({ date: TODAY, kg: 19 }), 'kg');
    assertFail(store.addWeight({ date: TODAY, kg: 401 }), 'kg');
  });

  it('accepts kg with one decimal and rejects more than one', () => {
    const store = makeStore(memoryStorage());
    assertOk(store.addWeight({ date: TODAY, kg: 72.5 }));
    assertFail(store.addWeight({ date: TODAY, kg: 72.55 }), 'kg');
    assertFail(store.addWeight({ date: TODAY, kg: 20.01 }), 'kg');
  });

  it('coerces a numeric kg string such as "72.5"', () => {
    const store = makeStore(memoryStorage());
    const entry = assertOk(store.addWeight({ date: TODAY, kg: '72.5' }));
    assert.equal(entry.kg, 72.5);
    const padded = assertOk(store.addWeight({ date: TODAY, kg: ' 80 ' }));
    assert.equal(padded.kg, 80);
  });

  it('rejects a blank kg with a required error', () => {
    const store = makeStore(memoryStorage());
    assertRequired(store.addWeight({ date: TODAY, kg: '' }), 'kg');
    assertRequired(store.addWeight({ date: TODAY, kg: '   ' }), 'kg');
    assertRequired(store.addWeight({ date: TODAY }), 'kg');
    assertRequired(store.addWeight({ date: TODAY, kg: null }), 'kg');
  });

  it('rejects a non-numeric kg', () => {
    const store = makeStore(memoryStorage());
    assertFail(store.addWeight({ date: TODAY, kg: 'heavy' }), 'kg');
    assertFail(store.addWeight({ date: TODAY, kg: NaN }), 'kg');
  });
});

describe('addWorkout validation', () => {
  it('accepts activity of 1 and 60 characters and rejects 0 and 61', () => {
    const store = makeStore(memoryStorage());
    assertOk(store.addWorkout(validWorkout({ activity: 'S' })));
    assertOk(store.addWorkout(validWorkout({ activity: 'A'.repeat(60) })));
    assertRequired(store.addWorkout(validWorkout({ activity: '' })), 'activity');
    assertRequired(store.addWorkout(validWorkout({ activity: '   ' })), 'activity');
    assertFail(store.addWorkout(validWorkout({ activity: 'A'.repeat(61) })), 'activity');
  });

  it('trims activity text', () => {
    const store = makeStore(memoryStorage());
    const entry = assertOk(store.addWorkout(validWorkout({ activity: '  SkiErg intervals  ' })));
    assert.equal(entry.activity, 'SkiErg intervals');
  });

  it('accepts durationMin bounds 1 and 600 and rejects just outside', () => {
    const store = makeStore(memoryStorage());
    assertOk(store.addWorkout(validWorkout({ durationMin: 1 })));
    assertOk(store.addWorkout(validWorkout({ durationMin: 600 })));
    assertFail(store.addWorkout(validWorkout({ durationMin: 0 })), 'durationMin');
    assertFail(store.addWorkout(validWorkout({ durationMin: 601 })), 'durationMin');
  });

  it('rejects a non-integer durationMin and coerces a whole-number string', () => {
    const store = makeStore(memoryStorage());
    assertFail(store.addWorkout(validWorkout({ durationMin: 30.5 })), 'durationMin');
    assertFail(store.addWorkout(validWorkout({ durationMin: '45.5' })), 'durationMin');
    const entry = assertOk(store.addWorkout(validWorkout({ durationMin: '45' })));
    assert.equal(entry.durationMin, 45);
  });

  it('rejects a blank durationMin with a required error', () => {
    const store = makeStore(memoryStorage());
    assertRequired(store.addWorkout(validWorkout({ durationMin: '' })), 'durationMin');
    assertRequired(store.addWorkout(validWorkout({ durationMin: undefined })), 'durationMin');
  });

  it('accepts notes of 500 characters, rejects 501, trims, and allows blank', () => {
    const store = makeStore(memoryStorage());
    const trimmed = assertOk(store.addWorkout(validWorkout({ notes: '  paced well  ' })));
    assert.equal(trimmed.notes, 'paced well');
    assertOk(store.addWorkout(validWorkout({ notes: 'x'.repeat(500) })));
    assertFail(store.addWorkout(validWorkout({ notes: 'x'.repeat(501) })), 'notes');
    const blank = assertOk(store.addWorkout(validWorkout({ notes: '' })));
    assert.equal(blank.notes, '');
    const missing = assertOk(store.addWorkout(validWorkout({ notes: undefined })));
    assert.equal(missing.notes, '');
  });

  it("defaults partial to false and accepts the strings 'true' and 'false'", () => {
    const store = makeStore(memoryStorage());
    const def = assertOk(store.addWorkout(validWorkout({ partial: undefined })));
    assert.equal(def.partial, false);
    const empty = assertOk(store.addWorkout(validWorkout({ partial: '' })));
    assert.equal(empty.partial, false);
    const asTrue = assertOk(store.addWorkout(validWorkout({ partial: 'true' })));
    assert.equal(asTrue.partial, true);
    const asFalse = assertOk(store.addWorkout(validWorkout({ partial: 'false' })));
    assert.equal(asFalse.partial, false);
    const boolTrue = assertOk(store.addWorkout(validWorkout({ partial: true })));
    assert.equal(boolTrue.partial, true);
  });
});

describe('addNutrition validation', () => {
  it('accepts a label of 60 characters, rejects 61, trims, and allows blank', () => {
    const store = makeStore(memoryStorage());
    const trimmed = assertOk(store.addNutrition(validNutrition({ label: '  Test oats  ' })));
    assert.equal(trimmed.label, 'Test oats');
    assertOk(store.addNutrition(validNutrition({ label: 'L'.repeat(60) })));
    assertFail(store.addNutrition(validNutrition({ label: 'L'.repeat(61) })), 'label');
    const blank = assertOk(store.addNutrition(validNutrition({ label: '' })));
    assert.equal(blank.label, '');
  });

  it('accepts calorie bounds 0 and 10000 and rejects just outside or non-integers', () => {
    const store = makeStore(memoryStorage());
    assertOk(store.addNutrition(validNutrition({ calories: 0 })));
    assertOk(store.addNutrition(validNutrition({ calories: 10000 })));
    assertFail(store.addNutrition(validNutrition({ calories: -1 })), 'calories');
    assertFail(store.addNutrition(validNutrition({ calories: 10001 })), 'calories');
    assertFail(store.addNutrition(validNutrition({ calories: 100.5 })), 'calories');
    const coerced = assertOk(store.addNutrition(validNutrition({ calories: '500' })));
    assert.equal(coerced.calories, 500);
  });

  it('rejects a blank calories value with a required error', () => {
    const store = makeStore(memoryStorage());
    assertRequired(store.addNutrition(validNutrition({ calories: '' })), 'calories');
    assertRequired(store.addNutrition(validNutrition({ calories: undefined })), 'calories');
  });

  it('accepts proteinG bounds 0 and 1000, one decimal, and rejects more decimals or out of range', () => {
    const store = makeStore(memoryStorage());
    assertOk(store.addNutrition(validNutrition({ proteinG: 0 })));
    assertOk(store.addNutrition(validNutrition({ proteinG: 1000 })));
    assertOk(store.addNutrition(validNutrition({ proteinG: 25.5 })));
    assertFail(store.addNutrition(validNutrition({ proteinG: -0.1 })), 'proteinG');
    assertFail(store.addNutrition(validNutrition({ proteinG: 1000.1 })), 'proteinG');
    assertFail(store.addNutrition(validNutrition({ proteinG: 25.55 })), 'proteinG');
    const coerced = assertOk(store.addNutrition(validNutrition({ proteinG: '30.5' })));
    assert.equal(coerced.proteinG, 30.5);
  });

  it('rejects a blank proteinG with a required error', () => {
    const store = makeStore(memoryStorage());
    assertRequired(store.addNutrition(validNutrition({ proteinG: '' })), 'proteinG');
    assertRequired(store.addNutrition(validNutrition({ proteinG: undefined })), 'proteinG');
  });
});

describe('dates', () => {
  it('accepts today in Qatar and rejects tomorrow (future) when a fixed now is injected', () => {
    const store = makeStore(memoryStorage(), FIXED_NOW);
    assertOk(store.addWeight({ date: TODAY, kg: 80 }));
    assertFail(store.addWeight({ date: TOMORROW, kg: 80 }), 'date');
    assertFail(store.addWorkout(validWorkout({ date: TOMORROW })), 'date');
    assertFail(store.addNutrition(validNutrition({ date: TOMORROW })), 'date');
  });

  it('accepts a past date and rejects a malformed or non YYYY-MM-DD date', () => {
    const store = makeStore(memoryStorage());
    assertOk(store.addWeight({ date: YESTERDAY, kg: 80 }));
    assertFail(store.addWeight({ date: '11/10/2026', kg: 80 }), 'date');
    assertFail(store.addWeight({ date: '2026-11-10T00:00:00', kg: 80 }), 'date');
    assertFail(store.addWeight({ date: '20261110', kg: 80 }), 'date');
    assertFail(store.addWeight({ date: '', kg: 80 }), 'date');
    assertFail(store.addWeight({ date: '2026-13-01', kg: 80 }), 'date');
    assertFail(store.addWeight({ date: '2026-02-30', kg: 80 }), 'date');
  });

  it('uses the injected now for the future-date cutoff around Qatar midnight', () => {
    const justBeforeMidnight = new Date('2026-11-10T20:59:00.000Z');
    const atMidnight = new Date('2026-11-10T21:00:00.000Z');
    const before = makeStore(memoryStorage(), justBeforeMidnight);
    assertOk(before.addWeight({ date: '2026-11-10', kg: 70 }));
    assertFail(before.addWeight({ date: '2026-11-11', kg: 70 }), 'date');
    const after = makeStore(memoryStorage(), atMidnight);
    assertOk(after.addWeight({ date: '2026-11-11', kg: 70 }));
    assertFail(after.addWeight({ date: '2026-11-12', kg: 70 }), 'date');
  });
});

describe('list, remove, persistence, and storage errors', () => {
  it('lists each type newest-first by date, then by createdAt', () => {
    const storage = memoryStorage();
    let seconds = 0;
    const store = HyroxData.createStore(storage, {
      now: () => new Date(Date.UTC(2026, 10, 10, 12, 0, seconds++)),
    });
    assertOk(store.addWeight({ date: '2026-11-08', kg: 80 }));
    assertOk(store.addWeight({ date: '2026-11-10', kg: 81 }));
    assertOk(store.addWeight({ date: '2026-11-09', kg: 82 }));
    const byDate = store.list('weight').map((e) => e.kg);
    assert.deepEqual(byDate, [81, 82, 80]);

    assertOk(store.addWorkout(validWorkout({ date: TODAY, activity: 'First', durationMin: 10 })));
    assertOk(store.addWorkout(validWorkout({ date: TODAY, activity: 'Second', durationMin: 10 })));
    const workouts = store.list('workouts');
    assert.equal(workouts[0].activity, 'Second');
    assert.equal(workouts[1].activity, 'First');
  });

  it('remove deletes the entry and leaves other types alone', () => {
    const store = makeStore(memoryStorage());
    const w = assertOk(store.addWeight({ date: TODAY, kg: 75 }));
    const extra = assertOk(store.addWeight({ date: YESTERDAY, kg: 74 }));
    assertOk(store.addNutrition(validNutrition()));
    store.remove('weight', w.id);
    const remaining = store.list('weight');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, extra.id);
    assert.equal(store.list('nutrition').length, 1);
    store.remove('weight', 'missing-id');
    assert.equal(store.list('weight').length, 1);
  });

  it('a new store on the same fake storage sees the old entries', () => {
    const storage = memoryStorage();
    const first = makeStore(storage);
    const entry = assertOk(first.addWeight({ date: TODAY, kg: 72.5 }));
    assertOk(first.addWorkout(validWorkout()));
    assertOk(first.addNutrition(validNutrition()));
    const second = makeStore(storage);
    const weights = second.list('weight');
    assert.equal(weights.length, 1);
    assert.equal(weights[0].id, entry.id);
    assert.equal(weights[0].kg, 72.5);
    assert.equal(second.list('workouts').length, 1);
    assert.equal(second.list('nutrition').length, 1);
  });

  it('falls back to empty lists without throwing when stored JSON is corrupt', () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, '{not-valid-json');
    const store = makeStore(storage);
    assert.doesNotThrow(() => store.list('weight'));
    assert.deepEqual(store.list('weight'), []);
    assert.deepEqual(store.list('workouts'), []);
    assert.deepEqual(store.list('nutrition'), []);
    assertOk(store.addWeight({ date: TODAY, kg: 80 }));
    assert.equal(store.list('weight').length, 1);
  });

  it('returns {ok:false, errors:{storage}} when setItem throws', () => {
    const storage = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error('quota exceeded');
      },
    };
    const store = makeStore(storage);
    const res = store.addWeight({ date: TODAY, kg: 80 });
    assert.equal(res.ok, false);
    assert.ok(res.errors && typeof res.errors.storage === 'string');
    assert.ok(res.errors.storage.length > 0);
  });
});

describe('dailyNutritionTotals and exportJSON', () => {
  it('sums calories, protein, and counts across several days, newest date first', () => {
    const store = makeStore(memoryStorage());
    assertOk(store.addNutrition(validNutrition({ date: '2026-11-08', label: 'Meal A', calories: 400, proteinG: 20.5 })));
    assertOk(store.addNutrition(validNutrition({ date: '2026-11-08', label: 'Meal B', calories: 250, proteinG: 10.3 })));
    assertOk(store.addNutrition(validNutrition({ date: TODAY, label: 'Meal C', calories: 700, proteinG: 40 })));
    assertOk(store.addNutrition(validNutrition({ date: YESTERDAY, label: 'Meal D', calories: 100, proteinG: 5 })));
    const totals = store.dailyNutritionTotals();
    assert.ok(Array.isArray(totals));
    assert.equal(totals.length, 3);
    assert.deepEqual(
      totals.map((t) => t.date),
      [TODAY, YESTERDAY, '2026-11-08']
    );
    assert.equal(totals[0].calories, 700);
    assert.equal(totals[0].proteinG, 40);
    assert.equal(totals[0].count, 1);
    assert.equal(totals[1].calories, 100);
    assert.equal(totals[1].proteinG, 5);
    assert.equal(totals[1].count, 1);
    assert.equal(totals[2].calories, 650);
    assert.equal(totals[2].proteinG, 30.8);
    assert.equal(totals[2].count, 2);
  });

  it('exportJSON is parseable and contains all three lists', () => {
    const store = makeStore(memoryStorage());
    assertOk(store.addWeight({ date: TODAY, kg: 72.5 }));
    assertOk(store.addWorkout(validWorkout()));
    assertOk(store.addNutrition(validNutrition()));
    const raw = store.exportJSON();
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.weight), 'export JSON must contain weight[]');
    assert.ok(Array.isArray(parsed.workouts), 'export JSON must contain workouts[]');
    assert.ok(Array.isArray(parsed.nutrition), 'export JSON must contain nutrition[]');
    assert.equal(parsed.weight.length, 1);
    assert.equal(parsed.workouts.length, 1);
    assert.equal(parsed.nutrition.length, 1);
    assert.equal(parsed.weight[0].kg, 72.5);
    assert.equal(parsed.workouts[0].activity, 'SkiErg intervals');
    assert.equal(parsed.nutrition[0].label, 'Test oats');
  });
});

// ---------- regression: data-loss defects ----------

const RECOVERY_KEY = HyroxData.RECOVERY_KEY;

function seeded(obj) {
  const raw = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { storage: memoryStorage({ [STORAGE_KEY]: raw }), raw };
}

const GOOD = {
  version: 1,
  weight: [{ id: 'w1', createdAt: '2026-11-01T08:00:00.000Z', date: '2026-11-01', kg: 80 }],
  workouts: [],
  nutrition: [],
};

describe('regression: storage failures never report success', () => {
  it('setItem that silently ignores the write returns a storage error', () => {
    const store = makeStore({ getItem: () => null, setItem: () => {} });
    assertFail(store.addWeight({ date: TODAY, kg: 80 }), 'storage');
    assertFail(store.addWorkout(validWorkout()), 'storage');
    assertFail(store.addNutrition(validNutrition()), 'storage');
  });

  it('setItem that stores something different returns a storage error', () => {
    const m = {};
    const storage = { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v).slice(0, 10); } };
    const store = makeStore(storage);
    assertFail(store.addWeight({ date: TODAY, kg: 80 }), 'storage');
  });

  it('getItem that throws blocks the write and leaves existing data untouched', () => {
    const { storage, raw } = seeded(GOOD);
    let fail = true;
    const flaky = { getItem: (k) => { if (fail) throw new Error('SecurityError'); return storage.getItem(k); }, setItem: (k, v) => storage.setItem(k, v) };
    const store = makeStore(flaky);
    assertFail(store.addWeight({ date: TODAY, kg: 81 }), 'storage');
    assert.equal(store.remove('weight', 'w1'), false);
    assert.equal(store.status().state, 'unreadable');
    assert.equal(store.status().ok, false);
    assert.throws(() => store.exportJSON());
    fail = false;
    assert.equal(storage.getItem(STORAGE_KEY), raw, 'original data must be unchanged');
    assert.equal(store.list('weight').length, 1);
  });

  it('a failed setItem leaves the previous data intact', () => {
    const { storage, raw } = seeded(GOOD);
    const store = makeStore({ getItem: (k) => storage.getItem(k), setItem: () => { throw new Error('QuotaExceededError'); } });
    assertFail(store.addWeight({ date: TODAY, kg: 81 }), 'storage');
    assert.equal(storage.getItem(STORAGE_KEY), raw);
  });
});

describe('regression: corrupt stored data is preserved, never silently overwritten', () => {
  const CORRUPT = [
    ['truncated JSON', '{"version":1,"weight":[{"id":"a","date":"2026-11-01","kg":80}'],
    ['JSON null', 'null'],
    ['JSON array', '[1,2,3]'],
    ['JSON number', '42'],
    ['a list that is not an array', JSON.stringify({ version: 1, weight: [], workouts: { a: 1 }, nutrition: [] })],
  ];

  for (const [name, raw] of CORRUPT) {
    it(`${name}: copies the original to the recovery key before saving anything new`, () => {
      const { storage } = seeded(raw);
      const store = makeStore(storage);
      assert.equal(store.status().state, 'corrupt');
      assert.equal(store.status().ok, false);
      assert.deepEqual(store.list('weight'), []);
      assert.throws(() => store.exportJSON(), /not exported/);
      assert.equal(storage.getItem(STORAGE_KEY), raw, 'reading must not modify storage');
      assert.equal(store.remove('weight', 'a'), false);
      assert.equal(storage.getItem(STORAGE_KEY), raw, 'remove must not modify corrupt storage');

      assertOk(store.addWeight({ date: TODAY, kg: 80 }));
      assert.equal(storage.getItem(RECOVERY_KEY), raw, 'original must be preserved byte-for-byte');
      assert.equal(store.list('weight').length, 1);
      const st = store.status();
      assert.equal(st.state, 'ok');
      assert.equal(st.recoveryKey, RECOVERY_KEY, 'status must keep reporting the preserved copy');
    });
  }

  it('refuses to save if the recovery copy cannot be written', () => {
    const raw = '{broken';
    const m = { [STORAGE_KEY]: raw };
    const storage = {
      getItem: (k) => (k in m ? m[k] : null),
      setItem: (k, v) => { if (k === RECOVERY_KEY) throw new Error('quota'); m[k] = String(v); },
    };
    const store = makeStore(storage);
    assertFail(store.addWeight({ date: TODAY, kg: 80 }), 'storage');
    assert.equal(m[STORAGE_KEY], raw);
  });

  it('never overwrites an earlier, different recovery copy', () => {
    const storage = memoryStorage({ [STORAGE_KEY]: '{second-break', [RECOVERY_KEY]: '{first-break' });
    const store = makeStore(storage);
    assertFail(store.addWeight({ date: TODAY, kg: 80 }), 'storage');
    assert.equal(storage.getItem(STORAGE_KEY), '{second-break');
    assert.equal(storage.getItem(RECOVERY_KEY), '{first-break');
  });

  it('data from a newer schema version is not overwritten', () => {
    const { storage, raw } = seeded(Object.assign({}, GOOD, { version: 3 }));
    const store = makeStore(storage);
    assert.equal(store.status().state, 'newer');
    assertFail(store.addWeight({ date: TODAY, kg: 81 }), 'storage');
    assert.equal(store.remove('weight', 'w1'), false);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
  });

  it('keeps unknown fields and malformed entries when saving a new entry', () => {
    const odd = { id: 7, date: '2026-11-02', kg: 79 }; // numeric id: hidden from the list, but kept
    const { storage } = seeded(Object.assign({}, GOOD, { weight: GOOD.weight.concat([odd]), settings: { unit: 'kg' } }));
    const store = makeStore(storage);
    assertOk(store.addWeight({ date: TODAY, kg: 81 }));
    const stored = JSON.parse(storage.getItem(STORAGE_KEY));
    assert.deepEqual(stored.settings, { unit: 'kg' });
    assert.equal(stored.weight.length, 3);
    assert.deepEqual(stored.weight[1], odd);
    assert.equal(store.list('weight').length, 2);
    assert.equal(storage.getItem(RECOVERY_KEY), null, 'valid data must not trigger recovery');
  });
});

describe('regression: normal logging still works end to end', () => {
  it('weight, full workout, partial workout and nutrition persist across reloads', () => {
    const storage = memoryStorage();
    const a = makeStore(storage);
    assert.deepEqual(a.status(), { persistent: true, state: 'empty', ok: true, recoveryKey: null, importBackup: null, keyPresent: false, counts: { weight: 0, workouts: 0, nutrition: 0, sessions: 0, meals: 0, body: 0, daily: 0, walks: 0, dayStates: 0, planEvents: 0, ownerSettings: 0, total: 0 } });
    assertOk(a.addWeight({ date: TODAY, kg: 72.5 }));
    assertOk(a.addWorkout(validWorkout({ activity: 'Full sim', partial: false })));
    assertOk(a.addWorkout(validWorkout({ activity: 'Half sim', partial: true })));
    assertOk(a.addNutrition(validNutrition({ calories: 350, proteinG: 22.5 })));
    assertOk(a.addNutrition(validNutrition({ calories: 150, proteinG: 7.5 })));

    const b = makeStore(storage);
    assert.equal(b.status().state, 'ok');
    assert.equal(b.list('weight')[0].kg, 72.5);
    const byName = Object.fromEntries(b.list('workouts').map((w) => [w.activity, w.partial]));
    assert.deepEqual(byName, { 'Full sim': false, 'Half sim': true });
    const totals = b.dailyNutritionTotals();
    assert.deepEqual(totals, [{ date: TODAY, calories: 500, proteinG: 30, count: 2 }]);
    const exported = JSON.parse(b.exportJSON());
    assert.equal(exported.workouts.length, 2);

    const partial = b.list('workouts').find((w) => w.partial);
    assert.equal(b.remove('workouts', partial.id), true);
    assert.equal(makeStore(storage).list('workouts').length, 1);
  });

  it('stored data format is unchanged (same key, same shape)', () => {
    const storage = memoryStorage();
    assertOk(makeStore(storage).addWeight({ date: TODAY, kg: 70 }));
    const stored = JSON.parse(storage.getItem(STORAGE_KEY));
    assert.deepEqual(Object.keys(stored).sort(), ['nutrition', 'version', 'weight', 'workouts']);
    assert.equal(stored.version, 1);
    assert.deepEqual(Object.keys(stored.weight[0]).sort(), ['createdAt', 'date', 'id', 'kg']);
  });
});

// ---------- Phase 2 P0: safe JSON import / restore (REPLACE only) ----------
// Synthetic data only. Clock is FIXED_NOW (2026-11-10 15:00 Qatar).

const BACKUP_KEY = HyroxData.IMPORT_BACKUP_KEY;
const EXPORTED_AT = '2026-11-10T11:00:00.000Z';

// Storage double with spies and per-key fault injection.
//   faults.set(key, value, n) -> 'throw' | 'truncate' | 'ignore' | 'swap' | undefined (n = nth set on that key, from 1)
//   faults.get(key) -> true to throw;  faults.remove(key) -> true to throw
function faultStorage(seed, faults) {
  faults = faults || {};
  const m = Object.assign({}, seed);
  const calls = [];
  const setCount = {};
  return {
    m,
    calls,
    writes() { return calls.filter((c) => c[0] !== 'get'); },
    snapshot() { return JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]])); },
    getItem(k) {
      calls.push(['get', k]);
      if (faults.get && faults.get(k)) throw new Error('SecurityError');
      return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null;
    },
    setItem(k, v) {
      calls.push(['set', k, String(v)]);
      setCount[k] = (setCount[k] || 0) + 1;
      const f = faults.set && faults.set(k, String(v), setCount[k]);
      if (f === 'throw') throw new Error('QuotaExceededError');
      if (f === 'ignore') return;
      if (f === 'truncate') { m[k] = String(v).slice(0, 7); return; }
      if (f === 'swap') { m[k] = JSON.stringify({ version: 1, weight: [], workouts: [], nutrition: [] }); return; }
      m[k] = String(v);
    },
    removeItem(k) {
      calls.push(['remove', k]);
      if (faults.remove && faults.remove(k)) throw new Error('SecurityError');
      delete m[k];
    },
  };
}

function backupObj(overrides) {
  return Object.assign(
    {
      app: 'hyrox-app',
      exportedAt: EXPORTED_AT,
      version: 1,
      weight: [{ id: 'iw1', createdAt: '2026-11-01T08:00:00.000Z', date: '2026-11-01', kg: 80 }],
      workouts: [
        { id: 'ik1', createdAt: '2026-11-02T08:00:00.000Z', date: '2026-11-02', activity: 'Test sim', durationMin: 60, partial: false, notes: '' },
        { id: 'ik2', createdAt: '2026-11-03T08:00:00.000Z', date: '2026-11-03', activity: 'Half test sim', durationMin: 30, partial: true, notes: 'Synthetic' },
      ],
      nutrition: [{ id: 'in1', createdAt: '2026-11-04T08:00:00.000Z', date: '2026-11-04', label: 'Test oats', calories: 0, proteinG: 0 }],
    },
    overrides
  );
}
const backupText = (o) => JSON.stringify(backupObj(o), null, 2);
const ZERO = { weight: 0, workouts: 0, nutrition: 0 };

function applyReplace(store, text) {
  const p = store.previewImport(text);
  assert.equal(p.ok, true, `preview failed: ${JSON.stringify(p)}`);
  return store.applyImport(text, { confirm: 'REPLACE', expectCurrent: p.preview.current, confirmEmptyReplace: true });
}

function envelope(storage) {
  const v = storage.getItem(BACKUP_KEY);
  assert.equal(typeof v, 'string', 'pre-import backup must exist');
  const env = JSON.parse(v);
  assert.equal(env.kind, 'hyrox-pre-import');
  assert.equal(typeof env.savedAt, 'string');
  return env;
}

function assertImportFail(res, code) {
  assert.equal(res.ok, false, `expected ok:false, got ${JSON.stringify(res).slice(0, 300)}`);
  assert.equal(res.code, code, `expected code ${code}, got ${res.code}: ${res.message}`);
  assert.equal(typeof res.message, 'string');
  assert.ok(res.message.length > 0);
  assert.ok(Array.isArray(res.errors));
  assert.ok(res.errors.length <= 20);
}

describe('import: limits and API surface', () => {
  // Claude P5: limit raised from 2,000,000 (this build's own year-long export exceeded it).
  it('exports IMPORT_LIMITS {maxBytes: 10_000_000, maxPerList: 10000} and the backup key', () => {
    assert.deepEqual({ ...HyroxData.IMPORT_LIMITS }, { maxBytes: 10_000_000, maxPerList: 10000 });
    assert.equal(BACKUP_KEY, 'hyrox.v1.pre-import-backup');
  });

  it('applyImport never throws, even for junk arguments', () => {
    const store = makeStore(faultStorage());
    for (const args of [[], [undefined], [42, null], [null, { confirm: 'REPLACE' }], ['{}', 'REPLACE'], [backupText(), { confirm: 'REPLACE', expectCurrent: 5 }]]) {
      let res;
      assert.doesNotThrow(() => { res = store.applyImport(...args); });
      assert.equal(res.ok, false);
      assert.equal(typeof res.code, 'string');
      assert.equal(res.rolledBack, false);
      assert.equal(res.backupKey, null);
    }
    for (const t of [undefined, null, 42, {}, '']) assert.doesNotThrow(() => store.previewImport(t));
  });
});

describe('import: roundtrip (acceptance 1 and 8)', () => {
  it('export -> import into an empty store -> reload preserves every record exactly', () => {
    const src = makeStore(memoryStorage());
    assertOk(src.addWeight({ date: TODAY, kg: 72.5 }));
    assertOk(src.addWorkout(validWorkout({ activity: 'Full sim', partial: false, notes: '' })));
    assertOk(src.addWorkout(validWorkout({ date: YESTERDAY, activity: 'Half sim', partial: true, notes: 'Stopped at wall balls' })));
    assertOk(src.addNutrition(validNutrition({ label: '', calories: 0, proteinG: 0 })));
    assertOk(src.addNutrition(validNutrition({ calories: 350, proteinG: 22.5 })));
    const file = src.exportJSON();

    const storage = faultStorage();
    const dst = makeStore(storage);
    const p = dst.previewImport(file);
    assert.equal(p.ok, true);
    assert.deepEqual(p.preview.counts, { weight: 1, workouts: 2, nutrition: 2 });
    assert.equal(p.preview.partialCount, 1);
    assert.deepEqual(p.preview.current, ZERO);
    assert.equal(p.preview.currentState, 'empty');
    assert.equal(p.preview.version, 1);
    assert.equal(p.preview.exportedAt, FIXED_NOW.toISOString());
    assert.deepEqual(p.preview.warnings, []);

    const res = dst.applyImport(file, { confirm: 'REPLACE', expectCurrent: p.preview.current });
    assert.deepEqual(res, { ok: true, counts: { weight: 1, workouts: 2, nutrition: 2 }, backupKey: BACKUP_KEY });

    const reloaded = makeStore(storage);
    for (const t of ['weight', 'workouts', 'nutrition']) assert.deepEqual(reloaded.list(t), src.list(t));
    assert.deepEqual(reloaded.dailyNutritionTotals(), src.dailyNutritionTotals());
    const st = reloaded.status();
    assert.equal(st.ok, true);
    assert.equal(st.state, 'ok');
    assert.deepEqual(st.importBackup, { key: BACKUP_KEY, savedAt: FIXED_NOW.toISOString(), counts: null });
    assert.equal(envelope(storage).raw, null, 'empty store before import -> raw null');

    // hyrox.v1 format unchanged
    const stored = JSON.parse(storage.getItem(STORAGE_KEY));
    assert.deepEqual(Object.keys(stored), ['version', 'weight', 'workouts', 'nutrition']);
    assert.deepEqual(Object.keys(stored.workouts[0]), ['id', 'createdAt', 'date', 'activity', 'durationMin', 'partial', 'notes']);
    // re-export is identical apart from exportedAt
    assert.equal(reloaded.exportJSON(), file);
  });

  it('missing optional fields follow add* defaults (notes/label -> "", partial -> false), nothing invented', () => {
    const storage = faultStorage();
    const store = makeStore(storage);
    const text = backupText({
      workouts: [{ id: 'k', createdAt: '2026-11-02T08:00:00Z', date: '2026-11-02', activity: 'Row', durationMin: 10 }],
      nutrition: [{ id: 'n', createdAt: '2026-11-02T08:00:00+03:00', date: '2026-11-02', calories: 5, proteinG: 0.5 }],
    });
    assert.equal(applyReplace(store, text).ok, true);
    const stored = JSON.parse(storage.getItem(STORAGE_KEY));
    assert.deepEqual(stored.workouts[0], { id: 'k', createdAt: '2026-11-02T08:00:00Z', date: '2026-11-02', activity: 'Row', durationMin: 10, partial: false, notes: '' });
    assert.deepEqual(stored.nutrition[0], { id: 'n', createdAt: '2026-11-02T08:00:00+03:00', date: '2026-11-02', label: '', calories: 5, proteinG: 0.5 });
  });

  it('an empty backup is allowed and replaces everything', () => {
    const { storage, raw } = seeded(GOOD);
    const store = makeStore(storage);
    const res = applyReplace(store, backupText({ weight: [], workouts: [], nutrition: [] }));
    assert.deepEqual(res.counts, ZERO);
    assert.equal(store.list('weight').length, 0);
    assert.equal(envelope(storage).raw, raw);
  });
});

describe('import: preview and cancel write nothing (acceptance 2)', () => {
  const inputs = [
    ['valid file', backupText()],
    ['empty string', ''],
    ['truncated JSON', backupText().slice(0, 40)],
    ['bad record', backupText({ weight: [{ id: 'x', createdAt: EXPORTED_AT, date: '2026-02-30', kg: 80 }] })],
    ['too large', 'x'.repeat(2_000_001)],
  ];
  const stores = [
    ['empty', {}],
    ['ok', { [STORAGE_KEY]: JSON.stringify(GOOD) }],
    ['corrupt', { [STORAGE_KEY]: '{broken' }],
    ['corrupt + recovery + old backup', { [STORAGE_KEY]: '{broken', [RECOVERY_KEY]: '{older', [BACKUP_KEY]: '{"kind":"hyrox-pre-import","savedAt":"x","raw":null}' }],
    ['newer', { [STORAGE_KEY]: JSON.stringify({ version: 3 }) }],
  ];
  for (const [sname, seed] of stores) {
    for (const [iname, text] of inputs) {
      it(`previewImport(${iname}) on a ${sname} store makes zero writes`, () => {
        const storage = faultStorage(seed);
        const before = storage.snapshot();
        makeStore(storage).previewImport(text);
        assert.deepEqual(storage.writes(), []);
        assert.equal(storage.snapshot(), before);
      });
    }
  }

  it('cancel (no confirm, wrong confirm) returns not_confirmed and writes nothing', () => {
    const storage = faultStorage({ [STORAGE_KEY]: JSON.stringify(GOOD) });
    const before = storage.snapshot();
    const store = makeStore(storage);
    const p = store.previewImport(backupText());
    for (const opts of [undefined, null, {}, { confirm: 'replace' }, { confirm: true, expectCurrent: p.preview.current }, { expectCurrent: p.preview.current }]) {
      const res = store.applyImport(backupText(), opts);
      assertImportFail(res, 'not_confirmed');
      assert.equal(res.rolledBack, false);
      assert.equal(res.backupKey, null);
    }
    assert.deepEqual(storage.writes(), []);
    assert.equal(storage.snapshot(), before);
  });
});

describe('import: invalid input never overwrites (acceptance 3, 6, 7)', () => {
  const w = (e) => ({ weight: [Object.assign({ id: 'b1', createdAt: EXPORTED_AT, date: '2026-11-01', kg: 80 }, e)] });
  const k = (e) => ({ workouts: [Object.assign({ id: 'b2', createdAt: EXPORTED_AT, date: '2026-11-01', activity: 'Row', durationMin: 10, partial: false, notes: '' }, e)] });
  const n = (e) => ({ nutrition: [Object.assign({ id: 'b3', createdAt: EXPORTED_AT, date: '2026-11-01', label: 'Test oats', calories: 1, proteinG: 1 }, e)] });
  const cases = [
    ['0-byte file', '', 'not_json'],
    ['truncated JSON', backupText().slice(0, -5), 'not_json'],
    ['JSON null', 'null', 'not_hyrox'],
    ['JSON array', '[]', 'not_hyrox'],
    ['app missing', backupText({ app: undefined }), 'not_hyrox'],
    ['app wrong', backupText({ app: 'other-app' }), 'not_hyrox'],
    ['list given as an object', backupText({ workouts: { a: 1 } }), 'not_hyrox'],
    ['list missing', backupText({ nutrition: undefined }), 'not_hyrox'],
    ['version 3', backupText({ version: 3 }), 'unsupported_version'],
    ['version missing', backupText({ version: undefined }), 'unsupported_version'],
    ['version "1" (string)', backupText({ version: '1' }), 'unsupported_version'],
    ['file over the size limit', backupText({ pad: 'x'.repeat(HyroxData.IMPORT_LIMITS.maxBytes + 100_000) }), 'too_large'], // Claude P5: was a fixed 2.1 MB
    ['10,001 entries', backupText({ weight: Array.from({ length: 10001 }, (_, i) => ({ id: 'w' + i, createdAt: EXPORTED_AT, date: '2026-11-01', kg: 80 })) }), 'too_many'],
    ['impossible date 2026-02-30', backupText(w({ date: '2026-02-30' })), 'invalid_records'],
    ['future date', backupText(w({ date: TOMORROW })), 'invalid_records'],
    ['kg "80" as a string', backupText(w({ kg: '80' })), 'invalid_records'],
    ['kg out of range', backupText(w({ kg: 19 })), 'invalid_records'],
    ['calories -1', backupText(n({ calories: -1 })), 'invalid_records'],
    ['calories 1.5', backupText(n({ calories: 1.5 })), 'invalid_records'],
    ['proteinG 1.25', backupText(n({ proteinG: 1.25 })), 'invalid_records'],
    ['61-char activity', backupText(k({ activity: 'a'.repeat(61) })), 'invalid_records'],
    ['blank activity', backupText(k({ activity: '  ' })), 'invalid_records'],
    ['501-char notes', backupText(k({ notes: 'n'.repeat(501) })), 'invalid_records'],
    ['partial "true" as a string', backupText(k({ partial: 'true' })), 'invalid_records'],
    ['durationMin missing', backupText(k({ durationMin: undefined })), 'invalid_records'],
    ['numeric id', backupText(w({ id: 7 })), 'invalid_records'],
    ['empty id', backupText(w({ id: '' })), 'invalid_records'],
    ['65-char id', backupText(w({ id: 'i'.repeat(65) })), 'invalid_records'],
    ['bad createdAt', backupText(w({ createdAt: 'yesterday' })), 'invalid_records'],
    ['entry that is not an object', backupText({ weight: [null] }), 'invalid_records'],
    ['duplicate id within a list', backupText({ weight: [{ id: 'd', createdAt: EXPORTED_AT, date: '2026-11-01', kg: 80 }, { id: 'd', createdAt: EXPORTED_AT, date: '2026-11-02', kg: 81 }] }), 'duplicate_ids'],
  ];
  for (const [name, text, code] of cases) {
    it(`${name} -> ${code}; hyrox.v1 byte-identical, no backup written`, () => {
      const storage = faultStorage({ [STORAGE_KEY]: JSON.stringify(GOOD) });
      const before = storage.snapshot();
      const store = makeStore(storage);
      assertImportFail(store.previewImport(text), code);
      const res = store.applyImport(text, { confirm: 'REPLACE', expectCurrent: { weight: 1, workouts: 0, nutrition: 0 } });
      assertImportFail(res, code);
      assert.equal(res.rolledBack, false);
      assert.equal(res.backupKey, null);
      assert.deepEqual(storage.writes(), []);
      assert.equal(storage.snapshot(), before);
    });
  }

  it('the size limit is checked before parsing', () => {
    const orig = JSON.parse;
    let parsed = 0;
    JSON.parse = function () { parsed++; return orig.apply(this, arguments); };
    try {
      assertImportFail(makeStore(faultStorage()).previewImport('{' + ' '.repeat(HyroxData.IMPORT_LIMITS.maxBytes) + '}'), 'too_large'); // Claude P5: was a fixed 2,000,000
    } finally { JSON.parse = orig; }
    assert.equal(parsed, 0);
  });

  it('accepts exactly maxBytes characters', () => {
    const base = backupText({ pad: '' });
    // Claude P5: was a fixed 2,000,000; now the real boundary.
    const text = base.replace('"pad": ""', '"pad": "' + 'x'.repeat(HyroxData.IMPORT_LIMITS.maxBytes - base.length) + '"');
    assert.equal(text.length, HyroxData.IMPORT_LIMITS.maxBytes);
    assert.equal(makeStore(faultStorage()).previewImport(text).ok, true);
  });

  it('accepts exactly maxPerList entries', () => {
    const weight = Array.from({ length: 10000 }, (_, i) => ({ id: 'w' + i, createdAt: EXPORTED_AT, date: '2026-11-01', kg: 80 }));
    const p = makeStore(faultStorage()).previewImport(JSON.stringify(backupObj({ weight })));
    assert.equal(p.ok, true);
    assert.equal(p.preview.counts.weight, 10000);
  });

  it('one bad record rejects the whole file; errors name list, index and field, capped at 20', () => {
    const weight = Array.from({ length: 30 }, (_, i) => ({ id: 'w' + i, createdAt: EXPORTED_AT, date: '2026-11-01', kg: i < 5 ? 80 : '80' }));
    const res = makeStore(faultStorage()).previewImport(backupText({ weight }));
    assertImportFail(res, 'invalid_records');
    assert.equal(res.errors.length, 20);
    assert.deepEqual(Object.keys(res.errors[0]).sort(), ['field', 'index', 'list', 'message']);
    assert.deepEqual(res.errors[0].list, 'weight');
    assert.equal(res.errors[0].index, 5);
    assert.equal(res.errors[0].field, 'kg');
    assert.match(res.message, /25 invalid/);

    const one = makeStore(faultStorage()).previewImport(backupText(k({ durationMin: 0 })));
    assert.deepEqual(one.errors.map((e) => [e.list, e.index, e.field]), [['workouts', 0, 'durationMin']]);
  });

  it('a duplicate id error points at the repeated entry', () => {
    const res = makeStore(faultStorage()).previewImport(backupText({ nutrition: [
      { id: 'a', createdAt: EXPORTED_AT, date: '2026-11-01', label: 'x', calories: 1, proteinG: 1 },
      { id: 'b', createdAt: EXPORTED_AT, date: '2026-11-01', label: 'x', calories: 1, proteinG: 1 },
      { id: 'a', createdAt: EXPORTED_AT, date: '2026-11-01', label: 'x', calories: 1, proteinG: 1 },
    ] }));
    assertImportFail(res, 'duplicate_ids');
    assert.deepEqual(res.errors.map((e) => [e.list, e.index, e.field]), [['nutrition', 2, 'id']]);
  });

  it('the same id in different lists is allowed', () => {
    const p = makeStore(faultStorage()).previewImport(backupText({ weight: [{ id: 'ik1', createdAt: EXPORTED_AT, date: '2026-11-01', kg: 80 }] }));
    assert.equal(p.ok, true);
  });

  it('__proto__ keys and extra fields are dropped (counted in warnings) and do not pollute Object.prototype', () => {
    const text =
      '{"app":"hyrox-app","exportedAt":"' + EXPORTED_AT + '","version":1,"__proto__":{"polluted":1},"extra":true,' +
      '"weight":[{"id":"__proto__","createdAt":"' + EXPORTED_AT + '","date":"2026-11-01","kg":80,"__proto__":{"polluted":2},"mood":"ok"}],' +
      '"workouts":[{"id":"k","createdAt":"' + EXPORTED_AT + '","date":"2026-11-01","activity":"Row","durationMin":10,"partial":false,"notes":"<script>alert(1)</script>"}],' +
      '"nutrition":[]}';
    const storage = faultStorage();
    const store = makeStore(storage);
    const p = store.previewImport(text);
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal(p.preview.warnings.length, 2);
    assert.ok(p.preview.warnings.every((x) => typeof x === 'string'));
    assert.match(p.preview.warnings.join(' '), /2 unknown fields in entries/);
    assert.match(p.preview.warnings.join(' '), /2 unknown top-level fields/);
    assert.equal(store.applyImport(text, { confirm: 'REPLACE', expectCurrent: ZERO }).ok, true);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    const stored = JSON.parse(storage.getItem(STORAGE_KEY));
    assert.deepEqual(Object.keys(stored), ['version', 'weight', 'workouts', 'nutrition']);
    assert.deepEqual(Object.keys(stored.weight[0]), ['id', 'createdAt', 'date', 'kg']);
    assert.equal(stored.workouts[0].notes, '<script>alert(1)</script>', 'stored as plain text, unchanged');
  });
});

describe('import: restore date ceiling (Meron blocker 3)', () => {
  const entry = (date) => ({ weight: [{ id: 'd1', createdAt: EXPORTED_AT, date, kg: 80 }] });

  it('a date equal to the Qatar date of exportedAt is accepted even when after todayQatar(); the preview warns', () => {
    // 2026-11-10T21:30Z is 2026-11-11 00:30 in Qatar, after FIXED_NOW.
    const text = backupText(Object.assign({ exportedAt: '2026-11-10T21:30:00.000Z' }, entry(TOMORROW)));
    const store = makeStore(faultStorage());
    const p = store.previewImport(text);
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal(p.preview.warnings.length, 1);
    assert.match(p.preview.warnings[0], /future/);
    assert.equal(store.applyImport(text, { confirm: 'REPLACE', expectCurrent: ZERO }).ok, true);
    assert.equal(store.list('weight')[0].date, TOMORROW);
  });

  it('a date after both today and the exportedAt date is rejected', () => {
    const text = backupText(Object.assign({ exportedAt: '2026-11-10T21:30:00.000Z' }, entry('2026-11-12')));
    const res = makeStore(faultStorage()).previewImport(text);
    assertImportFail(res, 'invalid_records');
    assert.equal(res.errors[0].field, 'date');
  });

  it('a past exportedAt keeps the ceiling at todayQatar() and gives no warning', () => {
    const store = makeStore(faultStorage());
    const okText = backupText(Object.assign({ exportedAt: '2026-10-01T00:00:00.000Z' }, entry(TODAY)));
    const p = store.previewImport(okText);
    assert.equal(p.ok, true);
    assert.deepEqual(p.preview.warnings, []);
    assertImportFail(store.previewImport(backupText(Object.assign({ exportedAt: '2026-10-01T00:00:00.000Z' }, entry(TOMORROW)))), 'invalid_records');
  });

  for (const [name, exportedAt] of [['missing', undefined], ['not ISO', 'last Tuesday'], ['a number', 1700000000000], ['an impossible ISO date', '2026-02-30T10:00:00Z']]) {
    it(`exportedAt ${name}: ceiling falls back to todayQatar()`, () => {
      const store = makeStore(faultStorage());
      const p = store.previewImport(backupText(Object.assign({ exportedAt }, entry(TODAY))));
      assert.equal(p.ok, true, JSON.stringify(p));
      assert.equal(p.preview.exportedAt, typeof exportedAt === 'string' ? exportedAt : null);
      assertImportFail(store.previewImport(backupText(Object.assign({ exportedAt }, entry(TOMORROW)))), 'invalid_records');
    });
  }

  it('impossible dates are still rejected with a far-future exportedAt', () => {
    assertImportFail(makeStore(faultStorage()).previewImport(backupText(Object.assign({ exportedAt: '2099-01-01T00:00:00Z' }, entry('2027-02-29')))), 'invalid_records');
  });
});

describe('import: replace, repeat imports, stale plans', () => {
  it('replaces existing data and keeps the exact previous text in the pre-import slot', () => {
    const odd = Object.assign({}, GOOD, { settings: { unit: 'kg' }, weight: GOOD.weight.concat([{ id: 9, date: 'x' }]) });
    const { storage, raw } = seeded(odd);
    const store = makeStore(storage);
    const p = store.previewImport(backupText());
    assert.deepEqual(p.preview.current, { weight: 1, workouts: 0, nutrition: 0 });
    assert.equal(p.preview.currentState, 'ok');
    const res = store.applyImport(backupText(), { confirm: 'REPLACE', expectCurrent: p.preview.current });
    assert.equal(res.ok, true);
    assert.deepEqual(store.list('weight').map((e) => e.id), ['iw1']);
    assert.equal(envelope(storage).raw, raw, 'previous bytes kept exactly, including unknown fields');
    assert.deepEqual(store.status().importBackup, { key: BACKUP_KEY, savedAt: FIXED_NOW.toISOString(), counts: { weight: 1, workouts: 0, nutrition: 0 } });
  });

  it('importing the same file twice gives the same data, no duplicates; latest import wins the slot', () => {
    const storage = faultStorage();
    let clock = new Date('2026-11-10T12:00:00.000Z');
    const store = HyroxData.createStore(storage, { now: () => clock });
    assert.equal(applyReplace(store, backupText()).ok, true);
    const afterFirst = storage.getItem(STORAGE_KEY);
    clock = new Date('2026-11-10T12:05:00.000Z');
    const p = store.previewImport(backupText());
    assert.deepEqual(p.preview.current, { weight: 1, workouts: 2, nutrition: 1 });
    const res = store.applyImport(backupText(), { confirm: 'REPLACE', expectCurrent: p.preview.current });
    assert.deepEqual(res.counts, { weight: 1, workouts: 2, nutrition: 1 });
    assert.equal(storage.getItem(STORAGE_KEY), afterFirst, 'second REPLACE is identical, not doubled');
    const env = envelope(storage);
    assert.equal(env.savedAt, '2026-11-10T12:05:00.000Z');
    assert.equal(env.raw, afterFirst);
    assert.deepEqual(makeStore(storage).status().importBackup.counts, { weight: 1, workouts: 2, nutrition: 1 });
  });

  it('stale_plan when data changed after the preview; nothing written', () => {
    const storage = faultStorage({ [STORAGE_KEY]: JSON.stringify(GOOD) });
    const store = makeStore(storage);
    const p = store.previewImport(backupText());
    assertOk(store.addWeight({ date: TODAY, kg: 81 }));
    const before = storage.snapshot();
    const n = storage.writes().length;
    const res = store.applyImport(backupText(), { confirm: 'REPLACE', expectCurrent: p.preview.current });
    assertImportFail(res, 'stale_plan');
    assert.equal(storage.writes().length, n);
    assert.equal(storage.snapshot(), before);
  });

  it('stale_plan when expectCurrent is missing or malformed', () => {
    const storage = faultStorage({ [STORAGE_KEY]: JSON.stringify(GOOD) });
    const store = makeStore(storage);
    for (const expectCurrent of [undefined, null, {}, { weight: '1', workouts: 0, nutrition: 0 }]) {
      assertImportFail(store.applyImport(backupText(), { confirm: 'REPLACE', expectCurrent }), 'stale_plan');
    }
    assert.deepEqual(storage.writes(), []);
  });

  it('apply re-validates the text: an invalid text with a valid-looking plan is rejected', () => {
    const storage = faultStorage();
    const store = makeStore(storage);
    const res = store.applyImport(backupText({ version: 3 }), { confirm: 'REPLACE', expectCurrent: ZERO });
    assertImportFail(res, 'unsupported_version');
    assert.deepEqual(storage.writes(), []);
  });
});

describe('import: storage states', () => {
  it('newer stored data: storage_newer, untouched', () => {
    const storage = faultStorage({ [STORAGE_KEY]: JSON.stringify({ version: 3, weight: [] }) });
    const before = storage.snapshot();
    const store = makeStore(storage);
    assertImportFail(store.previewImport(backupText()), 'storage_newer');
    assertImportFail(store.applyImport(backupText(), { confirm: 'REPLACE', expectCurrent: ZERO }), 'storage_newer');
    assert.equal(storage.snapshot(), before);
    assert.deepEqual(storage.writes(), []);
  });

  it('getItem throws: storage_unreadable, nothing written', () => {
    const storage = faultStorage({ [STORAGE_KEY]: JSON.stringify(GOOD) }, { get: () => true });
    const store = makeStore(storage);
    assertImportFail(store.previewImport(backupText()), 'storage_unreadable');
    assertImportFail(store.applyImport(backupText(), { confirm: 'REPLACE', expectCurrent: ZERO }), 'storage_unreadable');
    assert.deepEqual(storage.writes(), []);
    assert.equal(store.status().importBackup, null);
  });

  it('no localStorage: storage_unavailable', () => {
    const store = HyroxData.createStore(undefined, { now: () => FIXED_NOW });
    assertImportFail(store.previewImport(backupText()), 'storage_unavailable');
    assertImportFail(store.applyImport(backupText(), { confirm: 'REPLACE', expectCurrent: ZERO }), 'storage_unavailable');
    assert.equal(store.status().importBackup, null);
  });
});

describe('import: corrupt existing storage (Meron blocker 2, acceptance 5)', () => {
  it('a valid REPLACE succeeds; the damaged text is kept in the pre-import slot and copied to the recovery key', () => {
    const storage = faultStorage({ [STORAGE_KEY]: '{broken' });
    const store = makeStore(storage);
    const p = store.previewImport(backupText());
    assert.equal(p.preview.currentState, 'corrupt');
    assert.deepEqual(p.preview.current, ZERO);
    const res = store.applyImport(backupText(), { confirm: 'REPLACE', expectCurrent: p.preview.current });
    assert.equal(res.ok, true);
    assert.equal(envelope(storage).raw, '{broken');
    assert.equal(storage.getItem(RECOVERY_KEY), '{broken');
    const st = makeStore(storage).status();
    assert.equal(st.state, 'ok');
    assert.equal(st.recoveryKey, RECOVERY_KEY);
    assert.deepEqual(st.importBackup, { key: BACKUP_KEY, savedAt: FIXED_NOW.toISOString(), counts: null });
  });

  it('an existing, different corrupt-backup copy stays byte-identical', () => {
    const storage = faultStorage({ [STORAGE_KEY]: '{second-break', [RECOVERY_KEY]: '{first-break' });
    const res = applyReplace(makeStore(storage), backupText());
    assert.equal(res.ok, true);
    assert.equal(storage.getItem(RECOVERY_KEY), '{first-break');
    assert.equal(envelope(storage).raw, '{second-break');
    assert.equal(storage.writes().filter((c) => c[1] === RECOVERY_KEY).length, 0, 'corrupt-backup is never written');
  });

  it('a failing recovery-copy write does not block the restore', () => {
    const storage = faultStorage({ [STORAGE_KEY]: '[1,2,3]' }, { set: (key) => (key === RECOVERY_KEY ? 'throw' : undefined) });
    const res = applyReplace(makeStore(storage), backupText());
    assert.equal(res.ok, true);
    assert.equal(envelope(storage).raw, '[1,2,3]');
  });

  it('if the pre-import copy cannot be saved: backup_failed and hyrox.v1 unchanged', () => {
    const storage = faultStorage({ [STORAGE_KEY]: '{broken' }, { set: (key) => (key === BACKUP_KEY ? 'throw' : undefined) });
    const res = applyReplace(makeStore(storage), backupText());
    assertImportFail(res, 'backup_failed');
    assert.equal(storage.getItem(STORAGE_KEY), '{broken');
    assert.equal(storage.writes().filter((c) => c[1] === STORAGE_KEY).length, 0);
  });
});

describe('import: failure injection, backup and rollback (acceptance 4)', () => {
  const OLD_SLOT = JSON.stringify({ kind: 'hyrox-pre-import', savedAt: '2026-11-01T00:00:00.000Z', raw: '{"version":1}' });

  for (const mode of ['throw', 'truncate', 'ignore']) {
    it(`backup write ${mode}s: backup_failed, hyrox.v1 never written, earlier slot kept`, () => {
      const raw = JSON.stringify(GOOD);
      const storage = faultStorage({ [STORAGE_KEY]: raw, [BACKUP_KEY]: OLD_SLOT }, { set: (key, v, nth) => (key === BACKUP_KEY && nth === 1 ? mode : undefined) });
      const res = applyReplace(makeStore(storage), backupText());
      assertImportFail(res, 'backup_failed');
      assert.equal(res.rolledBack, false);
      assert.equal(res.backupKey, null);
      assert.equal(storage.getItem(STORAGE_KEY), raw);
      assert.equal(storage.writes().filter((c) => c[1] === STORAGE_KEY).length, 0);
      assert.equal(storage.getItem(BACKUP_KEY), OLD_SLOT);
    });
  }

  it('backup write truncates with no earlier slot: the bad slot is removed', () => {
    const storage = faultStorage({ [STORAGE_KEY]: JSON.stringify(GOOD) }, { set: (key) => (key === BACKUP_KEY ? 'truncate' : undefined) });
    assertImportFail(applyReplace(makeStore(storage), backupText()), 'backup_failed');
    assert.equal(storage.getItem(BACKUP_KEY), null);
  });

  const seeds = [
    ['existing data', JSON.stringify(GOOD)],
    ['a corrupt store', '{broken'],
    ['an empty store (raw null)', null],
  ];
  for (const [sname, raw] of seeds) {
    for (const [mode, code] of [['throw', 'write_failed'], ['truncate', 'verify_failed'], ['ignore', 'verify_failed']]) {
      it(`main write ${mode}s over ${sname}: ${code}, rolled back to the unwrapped raw`, () => {
        const seed = raw === null ? {} : { [STORAGE_KEY]: raw };
        const storage = faultStorage(seed, { set: (key, v, nth) => (key === STORAGE_KEY && nth === 1 ? mode : undefined) });
        const res = applyReplace(makeStore(storage), backupText());
        assertImportFail(res, code);
        assert.equal(res.rolledBack, true);
        assert.equal(res.backupKey, BACKUP_KEY);
        assert.equal(storage.getItem(STORAGE_KEY), raw, 'hyrox.v1 byte-identical to its pre-import text');
        if (raw === null) {
          assert.equal(Object.prototype.hasOwnProperty.call(storage.m, STORAGE_KEY), false, 'key removed, not set');
          assert.ok(storage.writes().some((c) => c[0] === 'remove' && c[1] === STORAGE_KEY));
        }
        assert.ok(!storage.writes().some((c) => c[0] === 'set' && c[1] === STORAGE_KEY && c[2].includes('hyrox-pre-import')), 'never writes the wrapper to hyrox.v1');
        assert.equal(envelope(storage).raw, raw, 'pre-import copy readable');
      });
    }
  }

  it('main write stores different valid hyrox data -> verify_failed + rollback', () => {
    const raw = JSON.stringify(GOOD);
    const storage = faultStorage({ [STORAGE_KEY]: raw }, { set: (key, v, nth) => (key === STORAGE_KEY && nth === 1 ? 'swap' : undefined) });
    const res = applyReplace(makeStore(storage), backupText());
    assertImportFail(res, 'verify_failed');
    assert.equal(storage.getItem(STORAGE_KEY), raw);
  });

  it('main write and rollback write both fail: rollback_failed with a readable backupKey', () => {
    const raw = JSON.stringify(GOOD);
    const storage = faultStorage({ [STORAGE_KEY]: raw }, { set: (key) => (key === STORAGE_KEY ? 'truncate' : undefined) });
    const res = applyReplace(makeStore(storage), backupText());
    assertImportFail(res, 'rollback_failed');
    assert.equal(res.rolledBack, false);
    assert.equal(res.backupKey, BACKUP_KEY);
    assert.doesNotMatch(res.message, /unchanged/i);
    assert.equal(envelope(storage).raw, raw, 'the previous data is still readable from backupKey');
    const sets = storage.writes().filter((c) => c[0] === 'set' && c[1] === STORAGE_KEY);
    assert.equal(sets.length, 2);
    assert.equal(sets[1][2], raw, 'rollback attempted with the unwrapped raw');
    assert.deepEqual(makeStore(storage).status().importBackup.counts, { weight: 1, workouts: 0, nutrition: 0 });
  });

  it('main write throws and removeItem throws on an empty store: rollback_failed', () => {
    const storage = faultStorage({}, { set: (key) => (key === STORAGE_KEY ? 'truncate' : undefined), remove: (key) => key === STORAGE_KEY });
    const res = applyReplace(makeStore(storage), backupText());
    assertImportFail(res, 'rollback_failed');
    assert.equal(res.backupKey, BACKUP_KEY);
    assert.equal(envelope(storage).raw, null);
  });

  it('a successful import never leaves ok:true unverified (silent-ignore storage)', () => {
    const store = makeStore({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const res = store.applyImport(backupText(), { confirm: 'REPLACE', expectCurrent: ZERO });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'backup_failed');
  });
});

describe('exportSummary and status().importBackup', () => {
  it('counts included and omitted (malformed) entries', () => {
    const { storage } = seeded(Object.assign({}, GOOD, { weight: GOOD.weight.concat([{ id: 7, date: '2026-11-02', kg: 79 }]) }));
    const store = makeStore(storage);
    assert.deepEqual(store.exportSummary(), {
      included: { weight: 1, workouts: 0, nutrition: 0 },
      omitted: { weight: 1, workouts: 0, nutrition: 0 },
    });
    assert.deepEqual(makeStore(memoryStorage()).exportSummary(), { included: ZERO, omitted: ZERO });
  });

  it('bad storage returns {included:null, omitted:null, state} and never throws', () => {
    assert.deepEqual(makeStore(memoryStorage({ [STORAGE_KEY]: '{x' })).exportSummary(), { included: null, omitted: null, state: 'corrupt' });
    assert.deepEqual(makeStore(memoryStorage({ [STORAGE_KEY]: '{"version":3}' })).exportSummary(), { included: null, omitted: null, state: 'newer' });
    assert.deepEqual(makeStore(faultStorage({}, { get: () => true })).exportSummary(), { included: null, omitted: null, state: 'unreadable' });
    assert.deepEqual(HyroxData.createStore(undefined).exportSummary(), { included: null, omitted: null, state: 'unavailable' });
  });

  it('exportSummary writes nothing', () => {
    const storage = faultStorage({ [STORAGE_KEY]: '{x' });
    makeStore(storage).exportSummary();
    assert.deepEqual(storage.writes(), []);
  });

  it('importBackup is null with no slot; damaged slot reports savedAt/counts null; status writes nothing', () => {
    assert.equal(makeStore(faultStorage()).status().importBackup, null);
    const storage = faultStorage({ [BACKUP_KEY]: '{not json' });
    assert.deepEqual(makeStore(storage).status().importBackup, { key: BACKUP_KEY, savedAt: null, counts: null });
    assert.deepEqual(storage.writes(), []);
  });
});
