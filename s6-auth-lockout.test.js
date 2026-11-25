'use strict';
/* S6 shared CAS lockout — fake store only. No live Netlify Blobs, no owner key, no network.
   D2: Command Center records both owner attestations (see docs/garmin/OWNER_LOCKOUT_RECOVERY.md).
   Those attestations are not authorization to deploy or wire this helper. */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
let L;
before(async () => {
  L = await import(pathToFileURL(path.resolve(__dirname, '../netlify/lib/auth-lockout-shared.mjs')).href);
});

const FIX = path.join(__dirname, 'fixtures/garmin/lockout-50-parallel-wrong-code.json');
const plan = JSON.parse(fs.readFileSync(FIX, 'utf8'));
const NOW = Date.UTC(2026, 10, 24, 5, 0, 0);
const HASH = crypto.createHash('sha256').update('correct-owner-code-16ch').digest('hex');

function wrong(store, ip, n, now) {
  let compares = 0;
  return L.checkCode({
    store, ip, now: now || NOW, ownerHash: HASH, code: 'wrong-code',
    reserveId: 'r-' + ip + '-' + n,
    compareFn: function () { compares++; return false; }
  }).then((r) => { r._compares = compares; return r; });
}

test('S6: constant locked 429 body is identical in every lock / fail-closed path', async () => {
  const a = await L.checkCode({ store: L.createFakeStore({ failGets: true }), ip: '203.0.113.10', now: NOW, ownerHash: HASH, code: 'x', compareFn: () => { throw new Error('compared'); } });
  const b = await L.checkCode({ store: L.createFakeStore({ failPuts: true }), ip: '203.0.113.10', now: NOW, ownerHash: HASH, code: 'x', compareFn: () => { throw new Error('compared'); } });
  const s = L.createFakeStore();
  for (let i = 0; i < 5; i++) await wrong(s, '203.0.113.10', i);
  const c = await wrong(s, '203.0.113.10', 99);
  assert.equal(a.status, 429);
  assert.equal(a.bodyText, L.LOCKED_BODY);
  assert.equal(a.bodyText, b.bodyText);
  assert.equal(a.bodyText, c.bodyText);
  assert.equal(a.compared, false);
  assert.equal(b.compared, false);
  assert.equal(c.compared, false);
});

test('S6: 50 concurrent wrong codes from one IP — at most 5 compares, rest constant 429', async () => {
  const store = L.createFakeStore();
  const ip = plan.sameIp.ip;
  const results = await Promise.all(Array.from({ length: plan.sameIp.n }, (_, i) => wrong(store, ip, i)));
  const compares = results.reduce((n, r) => n + r._compares, 0);
  const locked = results.filter((r) => r.status === 429 && r.bodyText === L.LOCKED_BODY && !r.compared);
  const auths = results.filter((r) => r.status === 401 && r.compared);
  assert.ok(compares <= plan.thresholds.perIp.failures, 'compares=' + compares);
  assert.equal(auths.length, compares);
  assert.equal(locked.length + auths.length, 50);
  assert.ok(locked.length >= 45, 'locked=' + locked.length);
});

test('S6: 50 distributed IPs consume the global tier; later callers 429 without compare', async () => {
  const store = L.createFakeStore();
  const results = await Promise.all(Array.from({ length: plan.distributed.n }, (_, i) => wrong(store, '198.51.100.' + (i + 1), i)));
  const compares = results.reduce((n, r) => n + r._compares, 0);
  const locked = results.filter((r) => r.status === 429 && !r.compared);
  assert.ok(compares <= plan.thresholds.global.failures, 'compares=' + compares);
  assert.ok(locked.length >= plan.distributed.n - plan.thresholds.global.failures);
  // a further IP after the burst is locked on the global key
  const later = await wrong(store, '203.0.113.99', 1000);
  assert.equal(later.status, 429);
  assert.equal(later.compared, false);
  assert.equal(later.bodyText, L.LOCKED_BODY);
});

test('S6: stale etags retry then fail closed with the constant body and no compare', async () => {
  const store = L.createFakeStore({ staleTimes: 10000 }); // more than CAS attempts
  let compares = 0;
  const r = await L.checkCode({ store, ip: '203.0.113.10', now: NOW, ownerHash: HASH, code: 'wrong-code', compareFn: () => { compares++; return false; } });
  assert.equal(r.status, 429);
  assert.equal(r.bodyText, L.LOCKED_BODY);
  assert.equal(compares, 0);
});

test('S6: store get/put failures fail closed, no compare', async () => {
  let c1 = 0, c2 = 0;
  const g = await L.checkCode({ store: L.createFakeStore({ failGets: true }), ip: '1.1.1.1', now: NOW, ownerHash: HASH, code: 'x', compareFn: () => { c1++; return true; } });
  const p = await L.checkCode({ store: L.createFakeStore({ failPuts: true }), ip: '1.1.1.1', now: NOW, ownerHash: HASH, code: 'x', compareFn: () => { c2++; return true; } });
  assert.equal(g.status, 429); assert.equal(p.status, 429);
  assert.equal(g.bodyText, p.bodyText); assert.equal(g.bodyText, L.LOCKED_BODY);
  assert.equal(c1, 0); assert.equal(c2, 0);
});

test('S6: correct code after reservations is accepted and does not consume a failure slot', async () => {
  const store = L.createFakeStore();
  const r = await L.checkCode({ store, ip: '203.0.113.10', now: NOW, ownerHash: HASH, code: 'correct-owner-code-16ch' });
  assert.equal(r.ok, true);
  assert.equal(r.compared, true);
  // five wrongs still allowed on this IP
  let compares = 0;
  for (let i = 0; i < 5; i++) {
    const w = await L.checkCode({ store, ip: '203.0.113.10', now: NOW + i, ownerHash: HASH, code: 'nope', reserveId: 'w' + i, compareFn: () => { compares++; return false; } });
    assert.equal(w.status, 401);
  }
  assert.equal(compares, 5);
});

test('S6: per-IP lock doubles up to 24h; D2 acceptance is not recorded', async () => {
  const store = L.createFakeStore();
  const ip = '203.0.113.50';
  let now = NOW;
  // first lock: 30 min after 5 fails
  for (let i = 0; i < 5; i++) await wrong(store, ip, i, now);
  const st = await L.readState(store, L.lockKeyIp(ip), now, 'perIp');
  assert.equal(st.locked, true);
  assert.equal(st.doc.until - now, 30 * 60 * 1000);
  // after the first lock expires, 5 more fails → 60 min
  now = st.doc.until + 1;
  for (let i = 0; i < 5; i++) await wrong(store, ip, 10 + i, now);
  const st2 = await L.readState(store, L.lockKeyIp(ip), now, 'perIp');
  assert.equal(st2.locked, true);
  assert.equal(st2.doc.until - now, 60 * 60 * 1000);
  // keep doubling until cap 24h
  now = st2.doc.until + 1;
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 5; i++) await wrong(store, ip, 100 * (round + 2) + i, now);
    const s = await L.readState(store, L.lockKeyIp(ip), now, 'perIp');
    const dur = s.doc.until - now;
    if (dur === 24 * 60 * 60 * 1000) break;
    now = s.doc.until + 1;
  }
  const last = await L.readState(store, L.lockKeyIp(ip), now, 'perIp');
  assert.equal(last.doc.until - now, 24 * 60 * 60 * 1000);
  assert.equal(last.doc.nextLockMs, 24 * 60 * 60 * 1000);
  // Explicit: this test exercises the helper. It is not an owner D2 acceptance record.
  const book = fs.readFileSync(path.resolve(__dirname, '../docs/garmin/OWNER_LOCKOUT_RECOVERY.md'), 'utf8');
  assert.equal(book.includes('D2 is PENDING'), false);
  assert.match(book, /accepts risk of third-party induced global photo\/Garmin lockout up to 24 h/);
  assert.match(book, /confirms >=16 randomly generated character code/);
});

test('S6: helper is not wired to live getStore / hyrox-photo blobs', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../netlify/lib/auth-lockout-shared.mjs'), 'utf8');
  assert.equal(/getStore\s*\(/.test(src), false);
  assert.equal(/blobStore\s*\(/.test(src), false);
  assert.equal(/createFakeStore/.test(src), true);
});

test('S6: lock length decays back to the base after 7 quiet days', async () => {
  const store = L.createFakeStore();
  const ip = '203.0.113.60';
  let now = NOW;
  for (let i = 0; i < 5; i++) await wrong(store, ip, i, now);
  const st = await L.readState(store, L.lockKeyIp(ip), now, 'perIp');
  assert.equal(st.doc.until - now, 30 * 60 * 1000);
  // After the lock ends, escalate once to 60 min, then wait 7 days: next lock is 30 min again.
  now = st.doc.until + 1;
  for (let i = 0; i < 5; i++) await wrong(store, ip, 10 + i, now);
  const st2 = await L.readState(store, L.lockKeyIp(ip), now, 'perIp');
  assert.equal(st2.doc.until - now, 60 * 60 * 1000);
  now = st2.doc.until + L.DECAY_AFTER_MS;
  for (let i = 0; i < 5; i++) await wrong(store, ip, 20 + i, now);
  const st3 = await L.readState(store, L.lockKeyIp(ip), now, 'perIp');
  assert.equal(st3.doc.until - now, 30 * 60 * 1000, 'lock length should have decayed to the 30 min base');
});

test('S6: helper is importable as ESM (deploy package type:module)', async () => {
  const href = pathToFileURL(path.resolve(__dirname, '../netlify/lib/auth-lockout-shared.mjs')).href;
  const mod = await import(href);
  assert.equal(typeof mod.checkCode, 'function');
  assert.equal(typeof mod.createFakeStore, 'function');
  assert.match(mod.LOCKED_BODY, /RATE_LIMITED/);
  assert.equal(/require\s*\(/.test(fs.readFileSync(path.resolve(__dirname, '../netlify/lib/auth-lockout-shared.mjs'), 'utf8')), false);
});
