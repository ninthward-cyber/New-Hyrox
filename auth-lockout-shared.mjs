/* Shared CAS auth lockout for photo + Garmin (S6).
 * ESM module (auth-lockout-shared.mjs) so it can be imported from the deploy package
 * (deploy/package.json has "type":"module"). Fake-store tests only in this series.
 * Do not point this helper at live Netlify Blobs. Not wired into food-photo.mjs / handler.mjs.
 *
 * D2 is no longer pending. The Command Center running decisions document
 * (https://docs.google.com/document/d/1xBtFUixZh_ouXIBFfC0pR89wjPBJpr2wONdTNUPKYZ8)
 * records both owner answers: the user explicitly answered YES to both, and Command Center
 * readback verified prior entry — "accepts risk of third-party induced global photo/Garmin
 * lockout up to 24 h; confirms >=16 randomly generated character code." These are owner
 * attestations, NOT authorization for live photo security changes, Garmin API, Netlify writes,
 * staging/production deploy, key handling, spending, or GitHub publish. D2 implementation
 * and verified recovery still open.
 *
 * Reuses the photo SHA-256 owner-code hash (no second scrypt code).
 */
import crypto from 'node:crypto';

const LOCKED_BODY = '{"ok":false,"code":"RATE_LIMITED"}';
const THRESHOLDS = Object.freeze({
  perIp: { failures: 5, windowMs: 15 * 60 * 1000, lockMs: 30 * 60 * 1000, maxLockMs: 24 * 60 * 60 * 1000 },
  global: { failures: 20, windowMs: 24 * 60 * 60 * 1000, lockMs: 60 * 60 * 1000, maxLockMs: 24 * 60 * 60 * 1000 }
});
const CAS_ATTEMPTS = 80;
const RESERVE_TTL_MS = 30 * 1000;
// After this quiet period past a lock's end (`until`), nextLockMs decays back to the base length.
const DECAY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function lockKeyIp(ip) { return 'lock/ip/' + sha256hex('ip:' + (ip || 'unknown')).slice(0, 32); }
function lockKeyGlobal() { return 'lock/global'; }

function constantLocked(retryAfter) {
  return { ok: false, status: 429, bodyText: LOCKED_BODY, body: JSON.parse(LOCKED_BODY), compared: false, retryAfter: retryAfter || 0 };
}

function fresh(tier) {
  return { v: 1, fails: [], reserved: [], until: 0, nextLockMs: THRESHOLDS[tier].lockMs };
}

function maybeDecay(doc, now, tier) {
  const th = THRESHOLDS[tier];
  if (doc && doc.until && doc.until <= now && (now - doc.until) >= DECAY_AFTER_MS) {
    doc.nextLockMs = th.lockMs;
  }
  return doc;
}

function prune(doc, now, windowMs, tier) {
  maybeDecay(doc, now, tier);
  doc.fails = (doc.fails || []).filter((t) => now - t < windowMs);
  doc.reserved = (doc.reserved || []).filter((r) => now - r.at < RESERVE_TTL_MS);
  return doc;
}

function occupied(doc) { return (doc.fails || []).length + (doc.reserved || []).length; }

async function casUpdate(store, key, now, tier, mutator) {
  const windowMs = THRESHOLDS[tier].windowMs;
  for (let a = 0; a < CAS_ATTEMPTS; a++) {
    let cur;
    try { cur = await store.get(key); } catch (e) { return { failClosed: true }; }
    const doc = prune(cur ? JSON.parse(JSON.stringify(cur.data)) : fresh(tier), now, windowMs, tier);
    const plan = mutator(doc) || { write: false };
    if (plan.abort) return plan.abort;
    if (plan.write === false) return plan.done || { ok: true, doc: doc };
    let ok;
    try {
      ok = cur
        ? await store.put(key, plan.doc || doc, { onlyIfMatch: cur.etag })
        : await store.put(key, plan.doc || doc, { onlyIfNew: true });
    } catch (e) { return { failClosed: true }; }
    if (ok) return plan.done || { ok: true, doc: plan.doc || doc };
  }
  return { failClosed: true };
}

async function readState(store, key, now, tier) {
  try {
    const cur = await store.get(key);
    if (!cur) return { doc: fresh(tier), locked: false };
    const doc = prune(JSON.parse(JSON.stringify(cur.data)), now, THRESHOLDS[tier].windowMs, tier);
    if (doc.until && doc.until > now) return { doc: doc, locked: true, retryAfter: Math.ceil((doc.until - now) / 1000) };
    return { doc: doc, locked: false };
  } catch (e) { return { failClosed: true }; }
}

/**
 * Reserve a compare slot (CAS) BEFORE the hash compare.
 * Returns locked/fail-closed without calling compareFn when the slot cannot be reserved.
 * compareFn is only invoked after both IP and global reservations succeed.
 */
async function checkCode(opts) {
  const store = opts.store;
  const now = opts.now != null ? opts.now : Date.now();
  const ip = opts.ip || 'unknown';
  const reserveId = opts.reserveId || ('r-' + crypto.randomBytes(8).toString('hex'));
  const ipKey = lockKeyIp(ip);
  const gKey = lockKeyGlobal();

  const ipSt = await readState(store, ipKey, now, 'perIp');
  const gSt = await readState(store, gKey, now, 'global');
  if (ipSt.failClosed || gSt.failClosed) return constantLocked(0);
  if (ipSt.locked || gSt.locked) return constantLocked(ipSt.retryAfter || gSt.retryAfter || 0);

  // Reserve IP then global. Release IP if global fails.
  const ipRes = await casUpdate(store, ipKey, now, 'perIp', function (doc) {
    if (doc.until && doc.until > now) return { abort: constantLocked(Math.ceil((doc.until - now) / 1000)) };
    if (occupied(doc) >= THRESHOLDS.perIp.failures) {
      const retry = doc.until && doc.until > now ? Math.ceil((doc.until - now) / 1000) : Math.ceil(THRESHOLDS.perIp.windowMs / 1000);
      return { abort: constantLocked(retry) };
    }
    doc.reserved = doc.reserved.concat([{ id: reserveId, at: now }]);
    return { write: true, doc: doc, done: { ok: true, reserved: true } };
  });
  if (ipRes.failClosed) return constantLocked(0);
  if (ipRes.status === 429) return ipRes;

  const gRes = await casUpdate(store, gKey, now, 'global', function (doc) {
    if (doc.until && doc.until > now) return { abort: constantLocked(Math.ceil((doc.until - now) / 1000)) };
    if (occupied(doc) >= THRESHOLDS.global.failures) {
      const retry = doc.until && doc.until > now ? Math.ceil((doc.until - now) / 1000) : Math.ceil(THRESHOLDS.global.windowMs / 1000);
      return { abort: constantLocked(retry) };
    }
    doc.reserved = doc.reserved.concat([{ id: reserveId, at: now }]);
    return { write: true, doc: doc, done: { ok: true, reserved: true } };
  });
  if (gRes.failClosed || gRes.status === 429) {
    await casUpdate(store, ipKey, now, 'perIp', function (doc) {
      doc.reserved = (doc.reserved || []).filter((r) => r.id !== reserveId);
      return { write: true, doc: doc };
    });
    if (gRes.failClosed) return constantLocked(0);
    return gRes;
  }

  // Compare only after both reservations.
  let match = false;
  try {
    if (typeof opts.compareFn === 'function') match = !!opts.compareFn();
    else if (opts.ownerHash && opts.code != null) match = timingSafeHashEqual(opts.ownerHash, sha256hex(opts.code));
  } catch (e) { match = false; }

  if (match) {
    await releaseReservation(store, ipKey, gKey, reserveId, now);
    return { ok: true, status: 200, compared: true, body: { ok: true } };
  }

  await recordFailure(store, ipKey, gKey, reserveId, now);
  return { ok: false, status: 401, compared: true, bodyText: '{"ok":false,"code":"AUTH"}', body: { ok: false, code: 'AUTH' } };
}

function timingSafeHashEqual(expectedHex, actualHex) {
  try {
    const a = Buffer.from(String(expectedHex), 'hex');
    const b = Buffer.from(String(actualHex), 'hex');
    if (a.length !== 32 || b.length !== 32) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

async function releaseReservation(store, ipKey, gKey, reserveId, now) {
  async function drop(key, tier) {
    await casUpdate(store, key, now, tier, function (doc) {
      doc.reserved = (doc.reserved || []).filter((r) => r.id !== reserveId);
      return { write: true, doc: doc };
    });
  }
  await drop(ipKey, 'perIp');
  await drop(gKey, 'global');
}

async function recordFailure(store, ipKey, gKey, reserveId, now) {
  async function fail(key, tier) {
    await casUpdate(store, key, now, tier, function (doc) {
      doc.reserved = (doc.reserved || []).filter((r) => r.id !== reserveId);
      doc.fails = (doc.fails || []).concat([now]);
      const th = THRESHOLDS[tier];
      if (doc.fails.length >= th.failures) {
        const dur = doc.nextLockMs || th.lockMs;
        doc.until = now + dur;
        doc.nextLockMs = Math.min(th.maxLockMs, dur * 2);
        doc.fails = [];
      }
      return { write: true, doc: doc };
    });
  }
  await fail(ipKey, 'perIp');
  await fail(gKey, 'global');
}

// In-memory store for offline tests only. Never wrap the Netlify Blobs factory or the live photo store here.
function createFakeStore(opts) {
  opts = opts || {};
  const m = new Map();
  let n = 1;
  return {
    _m: m,
    failGets: !!opts.failGets,
    failPuts: !!opts.failPuts,
    staleTimes: opts.staleTimes || 0,
    _staleLeft: opts.staleTimes || 0,
    async get(key) {
      if (this.failGets) throw new Error('STORE_DOWN');
      if (!m.has(key)) return null;
      const e = m.get(key);
      return { data: JSON.parse(JSON.stringify(e.data)), etag: e.etag };
    },
    async put(key, data, o) {
      o = o || {};
      if (this.failPuts) throw new Error('STORE_DOWN');
      if (this._staleLeft > 0) { this._staleLeft--; return false; }
      const cur = m.get(key);
      if (o.onlyIfNew && cur) return false;
      if (o.onlyIfMatch && (!cur || cur.etag !== o.onlyIfMatch)) return false;
      m.set(key, { data: JSON.parse(JSON.stringify(data)), etag: 'e' + (n++) });
      return true;
    }
  };
}

export {
  LOCKED_BODY,
  THRESHOLDS,
  DECAY_AFTER_MS,
  sha256hex,
  lockKeyIp,
  lockKeyGlobal,
  timingSafeHashEqual,
  checkCode,
  createFakeStore,
  readState,
  RESERVE_TTL_MS
};
