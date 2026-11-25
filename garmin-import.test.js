'use strict';
/* Fail-first Garmin contract tests. Synthetic fixtures only. No live Garmin, no network, no key.
   Chrome/Safari are not involved (Node unit). Run under TZ=UTC and TZ=America/Los_Angeles. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireGarmin, loadFixture, TODAY, MIDNIGHT_Z } = require('./garmin-helpers');

// File: tests/garmin-import.test.js — 15 cases

test('G-TZ-03 — Account timezone Europe/London holds the fetch', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-TZ-03', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'userprofile-settings-timezone-mismatch.json. Also missing/failed/Riyadh/gmt hold. No write. Do not use inverted 00:00 GMT / 03:00 local as Qatar-shaped.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-TZ-03 not implemented or failing');
});

test('G-SYNC-05 — Same file twice vs manual 46', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-SYNC-05', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Keep GARMIN_MANUAL 46 even when Garmin also computes 46; source must not flip.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-SYNC-05 not implemented or failing');
});

test('G-STEP-03 — No wellness data', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-STEP-03', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'No steps write; not zero.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-STEP-03 not implemented or failing');
});

test('G-STEP-04 — No steps from distance', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-STEP-04', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'distanceInMeters is ignored as a step source.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-STEP-04 not implemented or failing');
});

test('G-STEP-05 — 250001 steps refused', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-STEP-05', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Outside 0-200000; not clamped.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-STEP-05 not implemented or failing');
});

test('G-INT-01 — 30 + 2*8 = 46', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-INT-01', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Canonical 16 Nov fixture.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-INT-01 not implemented or failing');
});

test('G-INT-02 — vigorous missing = unknown, no write', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-INT-02', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Never 30+2*0.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-INT-02 not implemented or failing');
});

test('G-INT-03 — moderate missing = unknown, no write', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-INT-03', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: '' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-INT-03 not implemented or failing');
});

test('G-INT-04 — 0+0 = 0 (real zero)', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-INT-04', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: '14 Nov edge. Not missing.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-INT-04 not implemented or failing');
});

test('G-INT-05 — both missing / no wellness = unknown', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-INT-05', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: '' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-INT-05 not implemented or failing');
});

test('G-INT-06 — 0 + 2*8 = 16', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-INT-06', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Zero is present, not missing.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-INT-06 not implemented or failing');
});

test('G-INT-07 — total > 2880 = unknown, no write', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-INT-07', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Not clamped to 2880.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-INT-07 not implemented or failing');
});

test('G-INT-08 — negative intensity = unknown', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-INT-08', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: '' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-INT-08 not implemented or failing');
});

test('G-ADV-01 — Not JSON / 204 / null', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-ADV-01', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'No write. Empty/204 = no rows, not zeros.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-ADV-01 not implemented or failing');
});

test('G-ADV-09 — source=fitbit refused at APPLY', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-ADV-09', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'apply-fitbit-row.json. Also preview. Do not mark an existing HYROX day Missing.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-ADV-09 not implemented or failing');
});
