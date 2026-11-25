'use strict';
/* Fail-first Garmin contract tests. Synthetic fixtures only. No live Garmin, no network, no key.
   Chrome/Safari are not involved (Node unit). Run under TZ=UTC and TZ=America/Los_Angeles. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireGarmin, loadFixture, TODAY, MIDNIGHT_Z } = require('./garmin-helpers');

// File: tests/garmin-meron-manual-wins.test.js — 9 cases

test('G-WT-02 — Tick only the morning sample', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-WT-02', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'No pre-ticked rows. Ticking only the 06:00 sample writes that one.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-WT-02 not implemented or failing');
});

test('G-WT-05 — Manual weigh-in same day', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-WT-05', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 't111u Dawit: manual kg stays the coach value; preview/apply agree; no w-g-* added beside a same-date manual row.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-WT-05 not implemented or failing');
});

test('G-SYNC-01 — D3: later same-day steps stay preview-only', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-SYNC-01', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: '14:00 fetch of today is not written until the day is final.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-SYNC-01 not implemented or failing');
});

test('G-SYNC-04 — Idempotent re-import x3 is zero writes', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-SYNC-04', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Skip unchanged records (putRecord would stamp updatedAt).' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-SYNC-04 not implemented or failing');
});

test('G-WO-01 — Match manual workout by time overlap', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-WO-01', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Default Keep manual; notes survive.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-WO-01 not implemented or failing');
});

test('G-WO-02 — Partial session vs Garmin activity', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-WO-02', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Session status and runSteps untouched.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-WO-02 not implemented or failing');
});

test('G-WO-03 — Never auto-complete a prescribed session', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-WO-03', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Byte-exact sessions[] even in a steps-only apply.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-WO-03 not implemented or failing');
});

test('G-ADV-10 — Truthy confirm strings refused', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-ADV-10', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'apply-truthy-and-malformed-confirm.json. Only === true.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-ADV-10 not implemented or failing');
});

test('G-ADV-11 — Apply with everything pre-ticked is rejected', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-ADV-11', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'No acceptAll. Data layer re-validates timezone, source, today, ranges. No Tick-all New in the UI.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-ADV-11 not implemented or failing');
});
