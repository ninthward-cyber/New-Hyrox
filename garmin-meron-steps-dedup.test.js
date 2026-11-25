'use strict';
/* Fail-first Garmin contract tests. Synthetic fixtures only. No live Garmin, no network, no key.
   Chrome/Safari are not involved (Node unit). Run under TZ=UTC and TZ=America/Los_Angeles. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireGarmin, loadFixture, TODAY, MIDNIGHT_Z } = require('./garmin-helpers');

// File: tests/garmin-meron-steps-dedup.test.js — 5 cases

test('G-WO-04 — No double-counted steps', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-WO-04', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Once daily.steps is OBSERVED, walks and activity steps are not added. No walk created from an activity.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-WO-04 not implemented or failing');
});

test('G-WO-05 — Activities go to workouts only, never walks', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-WO-05', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'walks.stepsSource stays DEVICE|MANUAL only.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-WO-05 not implemented or failing');
});

test('G-WO-06 — Skipped session + Garmin run', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-WO-06', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Session stays SKIPPED, no runSteps.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-WO-06 not implemented or failing');
});

test('G-STEP-01 — Daily vs activity vs walks matrix', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-STEP-01', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Agrees with current daySteps.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-STEP-01 not implemented or failing');
});

test('G-STEP-02 — Importer never writes runSteps', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-STEP-02', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'runSteps only on started/partial/completed sessions, and the importer never writes them.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-STEP-02 not implemented or failing');
});
