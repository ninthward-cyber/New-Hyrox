'use strict';
/* Fail-first Garmin contract tests. Synthetic fixtures only. No live Garmin, no network, no key.
   Chrome/Safari are not involved (Node unit). Run under TZ=UTC and TZ=America/Los_Angeles. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireGarmin, loadFixture, TODAY, MIDNIGHT_Z } = require('./garmin-helpers');

// File: tests/garmin-meron-tz.test.js — 10 cases

test('G-TZ-01 — Activity crosses Qatar midnight', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-TZ-01', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'activities-midnight-crossing.json: Late run starts 2026-11-16 23:30 Qatar, duration 3600s. Date is 2026-11-16; cross-midnight warning. Official startTimeGMT/Local, never Date.parse.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-TZ-01 not implemented or failing');
});

test('G-TZ-02 — UTC date differs from Qatar date', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-TZ-02', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'weight-range-gtz02: instant 2026-11-19T22:00Z is diary date 2026-11-20. Key official timestampGMT.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-TZ-02 not implemented or failing');
});

test('G-TZ-04 — Sleep crosses midnight, wake date', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-TZ-04', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'ISO strings and epoch-ms both yield wake 2026-11-21; unparseable = HOLD, no calendarDate write.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-TZ-04 not implemented or failing');
});

test('G-TZ-05 — Nap vs main sleep', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-TZ-05', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'napTimeSeconds / dailyNapDTOS listed, never added to sleepH. sleepTimeSeconds only.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-TZ-05 not implemented or failing');
});

test('G-TZ-06 — Sunday/Monday week boundary', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-TZ-06', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Monday morning run 2026-11-16 00:15 Qatar uses official fields; date is 2026-11-16.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-TZ-06 not implemented or failing');
});

test('G-TZ-07 — DST fold/gap only if GMT missing', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-TZ-07', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'With startTimeGMT present there is no ambiguity. Non-Qatar zone already holds the whole fetch (G-TZ-03).' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-TZ-07 not implemented or failing');
});

test('G-TZ-08 — Fixture chronology is Qatar midnight', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-TZ-08', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Corrected 7-day + edges: local midnight = previous day 21:00 GMT.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-TZ-08 not implemented or failing');
});

test('G-TZ-09 — calendarDate vs chronology mismatch, no write', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-TZ-09', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'gtz09 fixture: 22 vs 21. uuid may be non-hex. No write.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-TZ-09 not implemented or failing');
});

test('G-TZ-10 — Partial current day is preview-only', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-TZ-10', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'today-in-progress 23 Nov; inject todayQatar=2026-11-23. Steps/intensity not writable. After 2026-11-23T21:00:00Z the day may be accepted.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-TZ-10 not implemented or failing');
});

test('G-SYNC-02 — Partial day becomes final after Qatar midnight', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-SYNC-02', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'P0. At 2026-11-23T21:00:00Z = 00:00 Qatar 24 Nov, 23 Nov may be accepted. UTC "today" must not leak.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-SYNC-02 not implemented or failing');
});
