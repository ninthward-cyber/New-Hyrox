'use strict';
/* Fail-first Garmin contract tests. Synthetic fixtures only. No live Garmin, no network, no key.
   Chrome/Safari are not involved (Node unit). Run under TZ=UTC and TZ=America/Los_Angeles. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireGarmin, loadFixture, TODAY, MIDNIGHT_Z } = require('./garmin-helpers');

// File: tests/garmin-meron-backup-version.test.js — 13 cases

test('G-BK-01 — Provenance/tombstones survive export/restore on P1.4 and P1.3', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-BK-01', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Ledger on existing daily records (D1). Core ids stable. No stub dailies.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-BK-01 not implemented or failing');
});

test('G-BK-02 — Old backup then re-import', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-BK-02', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'No duplicates; already-in-HYROX.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-BK-02 not implemented or failing');
});

test('G-BK-03 — Failed write mid-import rolls back', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-BK-03', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Single-save batch; in-memory rollback; no partial apply.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-BK-03 not implemented or failing');
});

test('G-BK-04 — Prior-copy slot untouched', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-BK-04', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'No applyImport; no write to hyrox.v1.pre-import-backup.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-BK-04 not implemented or failing');
});

test('G-BK-05 — Refuse while restore pending / newer / corrupt', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-BK-05', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'store-restore-pending.json. Bytes unchanged.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-BK-05 not implemented or failing');
});

test('G-BK-06 — Zero accepted rows is not empty-replace', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-BK-06', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'No write.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-BK-06 not implemented or failing');
});

test('G-BK-07 — exportChecked honest after import', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-BK-07', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'If any field would be dropped on restore, restorable/warning must say so.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-BK-07 not implemented or failing');
});

test('G-VER-01 — Schema-1 store: REFUSE, bytes unchanged', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-VER-01', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'save() auto-stamps v2, so the apply guard must be explicit. store-schema-1.json.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-VER-01 not implemented or failing');
});

test('G-VER-02 — Version 3 store refused', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-VER-02', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'No Garmin write.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-VER-02 not implemented or failing');
});

test('G-VER-03 — Unknown fields preserved on daily', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-VER-03', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Additive ledger + future fields survive put, export, restore, no-op apply.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-VER-03 not implemented or failing');
});

test('G-VER-04 — Downgrade to P1.3-RC3: INVALID not 0', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-VER-04', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Fields stay stored; roll-forward restores the reader.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-VER-04 not implemented or failing');
});

test('G-VER-06 — No hyrox.v2 / no VERSION 3', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-VER-06', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'Additive fields on version 2 only. No stub daily that bumps counts.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-VER-06 not implemented or failing');
});

test('G-ADV-02 — Over 10_000_000 characters or 10_000 rows refused', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function', 'RED: runContract(id, ctx) not implemented');
  const result = G.runContract('G-ADV-02', { todayQatar: TODAY, nowIso: MIDNIGHT_Z, loadFixture, note: 'No partial apply. Same caps as storage.' });
  assert.ok(result && result.ok === true, (result && result.reason) || 'RED: G-ADV-02 not implemented or failing');
});
