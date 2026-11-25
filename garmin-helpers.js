/* Shared helpers for Garmin fail-first contract tests. Synthetic only; no network. */
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');

const FIX = path.join(__dirname, 'fixtures/garmin');
function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}
function loadGarmin() {
  const p = path.resolve(__dirname, '../src/integrations/garmin-import.js');
  try { return require(p); } catch (e) { return null; }
}
function requireGarmin() {
  const G = loadGarmin();
  assert.ok(G, 'RED: src/integrations/garmin-import.js is not implemented yet');
  // R7: contracts and the unit proxy live in tests/, not in the product module.
  const C = require('./garmin-contracts-impl.js');
  return Object.assign({}, G, {
    runContract: C.runContract,
    handleProxy: C.handleProxy,
    resetProxyState: C.resetProxyState
  });
}
function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
function loadData() {
  return require(path.resolve(__dirname, '../src/data/hyrox-data.js'));
}
module.exports = { FIX, loadFixture, loadGarmin, requireGarmin, mem, loadData, TODAY: '2026-11-23', MIDNIGHT_Z: '2026-11-23T21:00:00Z' };
