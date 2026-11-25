'use strict';
/* Fail-first Garmin contract tests. Synthetic fixtures only. No live Garmin, no network, no key.
   Chrome/Safari are not involved (Node unit). Run under TZ=UTC and TZ=America/Los_Angeles. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireGarmin, loadFixture, TODAY, MIDNIGHT_Z } = require('./garmin-helpers');

// File: tests/garmin-meron-delete-resync.test.js — 5 cases

test('G-SYNC-03 — Edited activity title/distance is Garmin differs', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-SYNC-03', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Compare only mapped fields.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-SYNC-03 not implemented or failing');
});

test('G-SYNC-06 — 28-day steps payload refused as a step source', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-SYNC-06', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Endpoint is outside the allowlist.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-SYNC-06 not implemented or failing');
});

test('G-DEL-01 — Upstream delete is Missing only if complete:true', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-DEL-01', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Page cap => complete:false, no Missing.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-DEL-01 not implemented or failing');
});

test('G-DEL-02 — User-deleted import is not resurrected', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-DEL-02', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Tombstone in daily garminLedger / bag; survives restore (D1).' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-DEL-02 not implemented or failing');
});

test('G-DEL-03 — New activity reuses old title', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-DEL-03', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Key on activityId as string, never title.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-DEL-03 not implemented or failing');
});
