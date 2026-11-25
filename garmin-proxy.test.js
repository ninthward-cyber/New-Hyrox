'use strict';
/* Fail-first Garmin contract tests. Synthetic fixtures only. No live Garmin, no network, no key.
   Chrome/Safari are not involved (Node unit). Run under TZ=UTC and TZ=America/Los_Angeles. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireGarmin, loadFixture, TODAY, MIDNIGHT_Z } = require('./garmin-helpers');


test('G-PROXY-allowlist — only the six datasets plus one internal settings call; host hard-coded; no env override', () => {
  const G = requireGarmin();
  assert.equal(typeof G.runContract, 'function');
  const r = G.runContract('G-PROXY-allowlist', { todayQatar: TODAY, loadFixture });
  assert.ok(r && r.ok === true, (r && r.reason) || 'RED: proxy allowlist not implemented');
});
test('G-PROXY-31-days — 31 inclusive days, end <= today Qatar, impossible dates refused', () => {
  const G = requireGarmin();
  const r = G.runContract('G-PROXY-31-days', { todayQatar: TODAY, loadFixture });
  assert.ok(r && r.ok === true, (r && r.reason) || 'RED: 31-day cap not implemented');
});
test('G-PROXY-redirect-manual — any 3xx is 502; no follow', () => {
  const G = requireGarmin();
  const r = G.runContract('G-PROXY-redirect-manual', { todayQatar: TODAY, loadFixture });
  assert.ok(r && r.ok === true, (r && r.reason) || 'RED');
});
test('G-PROXY-origin-null — Origin null refused; exact origin only; no CORS', () => {
  const G = requireGarmin();
  const r = G.runContract('G-PROXY-origin-null', { todayQatar: TODAY, loadFixture });
  assert.ok(r && r.ok === true, (r && r.reason) || 'RED');
});
test('G-PROXY-status-oracle — unauthenticated status is a constant body whether or not the key exists', () => {
  const G = requireGarmin();
  const r = G.runContract('G-PROXY-status-oracle', { todayQatar: TODAY, loadFixture });
  assert.ok(r && r.ok === true, (r && r.reason) || 'RED');
});
test('G-PROXY-mapped-only — canary key/token/health values never appear in responses or logs; no calorie/HR/GPS', () => {
  const G = requireGarmin();
  const r = G.runContract('G-PROXY-mapped-only', { todayQatar: TODAY, loadFixture });
  assert.ok(r && r.ok === true, (r && r.reason) || 'RED');
});
test('G-PROXY-lease-token — one in-flight lease, bounded token exchange, in-memory token only, halt flag, no token at rest', () => {
  const G = requireGarmin();
  const r = G.runContract('G-PROXY-lease-token', { todayQatar: TODAY, loadFixture });
  assert.ok(r && r.ok === true, (r && r.reason) || 'RED');
});
