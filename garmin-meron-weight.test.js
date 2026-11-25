'use strict';
/* Fail-first Garmin contract tests. Synthetic fixtures only. No live Garmin, no network, no key.
   Chrome/Safari are not involved (Node unit). Run under TZ=UTC and TZ=America/Los_Angeles. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireGarmin, loadFixture, TODAY, MIDNIGHT_Z } = require('./garmin-helpers');

// File: tests/garmin-meron-weight.test.js — 9 cases

test('G-WT-01 — Two samples same Qatar day', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-WT-01', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'weight-range-sample.json: two timestampGMT keys on 2026-11-20, both kept if ticked; headline latest 97.4 at 09:00 Qatar.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-WT-01 not implemented or failing');
});

test('G-WT-03 — Duplicate timestampGMT different kg is malformed', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-WT-03', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'HOLD both; no official sample id.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-WT-03 not implemented or failing');
});

test('G-WT-04 — Same timestamp different value', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-WT-04', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Merged with G-WT-03 under timestampGMT.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-WT-04 not implemented or failing');
});

test('G-UNIT-01 — 75000 kg refused, never converted', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-UNIT-01', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'No unit field. 75000 refused (>400).' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-UNIT-01 not implemented or failing');
});

test('G-UNIT-02 — Second 75000 payload refused; first unchanged', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-UNIT-02', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'No duplicate.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-UNIT-02 not implemented or failing');
});

test('G-UNIT-03 — Float residue rounds half-up to one decimal', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-UNIT-03', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: '97.4000015 -> 97.4 before compare/store.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-UNIT-03 not implemented or failing');
});

test('G-UNIT-04 — 75.45 rounds half-up to 75.5', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-UNIT-04', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'One documented rule.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-UNIT-04 not implemented or failing');
});

test('G-UNIT-05 — Refuse outside 20-400; flag outside 30-300', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-UNIT-05', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: '8, 0, negative refused. 29.9 and 301 flagged implausible.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-UNIT-05 not implemented or failing');
});

test('G-UNIT-06 — Missing or non-number weight refused', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-UNIT-06', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'A unit field is not expected.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-UNIT-06 not implemented or failing');
});
