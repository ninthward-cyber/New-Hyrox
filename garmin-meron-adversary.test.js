'use strict';
/* Fail-first Garmin contract tests. Synthetic fixtures only. No live Garmin, no network, no key.
   Chrome/Safari are not involved (Node unit). Run under TZ=UTC and TZ=America/Los_Angeles. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireGarmin, loadFixture, TODAY, MIDNIGHT_Z } = require('./garmin-helpers');

// File: tests/garmin-meron-adversary.test.js — 10 cases

test('G-INT-09 — One value per day; no manual + API', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-INT-09', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Weekly sum uses the kept manual unless Replace. Unextended reader: API source INVALID never 0. Extended reader accepts GARMIN_PERSONAL_API.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-INT-09 not implemented or failing');
});

test('G-INT-10 — Calories/HR never used', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-INT-10', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Proxy mapped response has no calorie/HR fields. Coach targets unchanged.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-INT-10 not implemented or failing');
});

test('G-VER-05 — Mixed sources + classic-only export', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-VER-05', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Classic restore is backup restore, not a Garmin merge.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-VER-05 not implemented or failing');
});

test('G-ADV-03 — Two v2 rows same calendarDate', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-ADV-03', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Refuse or Garmin differs; one date → one daily record.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-ADV-03 not implemented or failing');
});

test('G-ADV-04 — Id collisions across collections', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-ADV-04', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'HYROX id stays local; garmin ids live in the ledger. No overwrite of daily-2026-11-16.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-ADV-04 not implemented or failing');
});

test('G-ADV-05 — NaN / Infinity / 12abc / 1.5', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-ADV-05', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Invalid, unknown, no write.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-ADV-05 not implemented or failing');
});

test('G-ADV-06 — Future Qatar date refused', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-ADV-06', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Server also refuses end > today Qatar.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-ADV-06 not implemented or failing');
});

test('G-ADV-07 — Before tracking start / older than 31 days', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-ADV-07', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Floor = 31 days per fetch; no silent years of backfill.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-ADV-07 not implemented or failing');
});

test('G-ADV-08 — Script / huge / emoji text', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-ADV-08', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'activityName via textContent only, max 60. No HTML injection.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-ADV-08 not implemented or failing');
});

test('G-ADV-12 — Non-Garmin source on an existing day', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-ADV-12', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Refuse incoming; do not mark the existing HYROX day Missing.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-ADV-12 not implemented or failing');
});
