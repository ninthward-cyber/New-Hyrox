// Durable state on Netlify Blobs (free tier): budget ledger, idempotency records, auth lockouts.
// Every write that matters is a compare-and-set (onlyIfNew / onlyIfMatch) so concurrent invocations cannot overspend.
// If Blobs is unavailable every function here throws, and the handler fails closed (no provider call).
import { createHash } from 'node:crypto';
import { dayKey, monthKey } from './config.mjs';

export const sha = (s) => createHash('sha256').update(s).digest('hex');

export function blobStore(getStore) {
  const s = getStore({ name: 'hyrox-photo', consistency: 'strong' });
  return {
    async get(key) { const r = await s.getWithMetadata(key, { type: 'json' }); return r ? { data: r.data, etag: r.etag } : null; },
    async put(key, data, o = {}) {
      const opts = o.onlyIfNew ? { onlyIfNew: true } : o.onlyIfMatch ? { onlyIfMatch: o.onlyIfMatch } : {};
      const r = await s.setJSON(key, data, opts);
      return r.modified !== false;
    },
    async del(key) { await s.delete(key); },
    async list(prefix) { const r = await s.list({ prefix }); return r.blobs.map((b) => b.key); },
  };
}

// ---------------- budget ledger ----------------
const LEDGER = 'ledger/v1';
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const fresh = () => ({ v: 1, total: { usd: 0, calls: 0 }, month: { key: '', usd: 0, calls: 0 }, day: { key: '', calls: 0 }, recent: [], inflight: {} });

function roll(doc, now) {
  const mk = monthKey(now), dk = dayKey(now);
  if (doc.month.key !== mk) doc.month = { key: mk, usd: 0, calls: 0 };
  if (doc.day.key !== dk) doc.day = { key: dk, calls: 0 };
  return doc;
}

export function snapshot(doc, cfg) {
  const reserved = Object.values(doc.inflight).reduce((a, x) => a + x.usd, 0);
  return {
    day: { calls: doc.day.calls, cap: cfg.dailyCalls }, month: { calls: doc.month.calls, cap: cfg.monthlyCalls, usd: r6(doc.month.usd), usdCap: cfg.monthlyUsd },
    total: { usd: r6(doc.total.usd), usdCap: cfg.totalUsd, calls: doc.total.calls }, reservedUsd: r6(reserved),
    remainingUsd: r6(Math.max(0, Math.min(cfg.totalUsd - doc.total.usd, cfg.monthlyUsd - doc.month.usd) - reserved)),
  };
}

async function casLoop(store, fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await store.get(LEDGER);
    const doc = cur ? cur.data : fresh();
    const res = fn(doc);
    if (res.abort) return res.abort;
    const ok = cur ? await store.put(LEDGER, doc, { onlyIfMatch: cur.etag }) : await store.put(LEDGER, doc, { onlyIfNew: true });
    if (ok) return res.done;
  }
  throw new Error('LEDGER_CONTENTION');
}

export async function readLedger(store, cfg, now) {
  const cur = await store.get(LEDGER);
  const doc = roll(cur ? cur.data : fresh(), now);
  return snapshot(doc, cfg);
}

function settleStale(doc, cfg, now) {
  for (const [id, x] of Object.entries(doc.inflight)) {
    if (now - x.at > cfg.inflightStaleSeconds * 1000) { // function died mid-call: assume the worst, charge the reservation
      doc.month.usd = r6(doc.month.usd + x.usd); doc.total.usd = r6(doc.total.usd + x.usd); delete doc.inflight[id];
    }
  }
}

export async function reserve(store, cfg, now, id) {
  return casLoop(store, (doc) => {
    roll(doc, now); settleStale(doc, cfg, now);
    const reserved = Object.values(doc.inflight).reduce((a, x) => a + x.usd, 0);
    const rec = doc.recent.filter((t) => now - t < cfg.burstWindowSeconds * 1000);
    const deny = (status, code, message, retryAfter) => ({ abort: { ok: false, status, code, message, retryAfter } });
    if (rec.length && now - rec[rec.length - 1] < cfg.minGapSeconds * 1000) return deny(429, 'RATE_LIMIT', 'Too many requests. Wait a few seconds and try again.', Math.ceil(cfg.minGapSeconds));
    if (rec.length >= cfg.burstCalls) return deny(429, 'RATE_LIMIT', 'Too many analyses in a short time. Try again in a few minutes.', Math.ceil((rec[0] + cfg.burstWindowSeconds * 1000 - now) / 1000));
    if (doc.day.calls + 1 > cfg.dailyCalls) return deny(429, 'QUOTA_EXHAUSTED', 'Daily photo-analysis limit reached. Nothing was sent. Describe the meal instead.');
    if (doc.month.calls + 1 > cfg.monthlyCalls) return deny(429, 'QUOTA_EXHAUSTED', 'Monthly photo-analysis limit reached. Nothing was sent.');
    if (doc.month.usd + reserved + cfg.reserveUsd > cfg.monthlyUsd) return deny(402, 'BUDGET_EXHAUSTED', 'The monthly photo-analysis budget is used up. Nothing was sent.');
    if (doc.total.usd + reserved + cfg.reserveUsd > cfg.totalUsd) return deny(402, 'BUDGET_EXHAUSTED', 'The trial photo-analysis budget is used up. Nothing was sent.');
    rec.push(now); doc.recent = rec.slice(-50);
    doc.day.calls++; doc.month.calls++; doc.total.calls++;
    doc.inflight[id] = { at: now, usd: cfg.reserveUsd };
    return { done: { ok: true, snapshot: snapshot(doc, cfg) } };
  });
}

// usd: actual estimated spend. refundCall: the provider rejected the call before billing, so the call does not count.
export async function settle(store, cfg, now, id, { usd, refundCall = false }) {
  return casLoop(store, (doc) => {
    roll(doc, now);
    if (!doc.inflight[id]) return { done: { ok: true, alreadyCharged: true } }; // already charged by the stale sweep
    delete doc.inflight[id];
    doc.month.usd = r6(doc.month.usd + usd); doc.total.usd = r6(doc.total.usd + usd);
    if (refundCall) { doc.day.calls = Math.max(0, doc.day.calls - 1); doc.month.calls = Math.max(0, doc.month.calls - 1); doc.total.calls = Math.max(0, doc.total.calls - 1); }
    return { done: { ok: true } };
  });
}

// ---------------- idempotency ----------------
const idemKey = (requestId) => 'idem/' + sha('req:' + requestId).slice(0, 40);

export async function idemBegin(store, cfg, now, requestId, imgHash) {
  const key = idemKey(requestId);
  const fresh1 = { state: 'inflight', imgHash, at: now };
  const cur = await store.get(key);
  if (!cur) return (await store.put(key, fresh1, { onlyIfNew: true })) ? { kind: 'new', key } : { kind: 'inflight' };
  const d = cur.data;
  const age = now - d.at;
  if (age > cfg.idemTtlSeconds * 1000 || (d.state === 'inflight' && age > cfg.inflightStaleSeconds * 1000)) {
    return (await store.put(key, fresh1, { onlyIfMatch: cur.etag })) ? { kind: 'new', key } : { kind: 'inflight' };
  }
  if (d.imgHash !== imgHash) return { kind: 'conflict' };
  if (d.state === 'done') return { kind: 'replay', result: d.result };
  return { kind: 'inflight' };
}
export async function idemDone(store, key, imgHash, now, result) { await store.put(key, { state: 'done', imgHash, at: now, result }); }
export async function idemFail(store, key) { await store.del(key); }
// Opportunistic cleanup of expired records so cached estimates do not linger.
export async function idemPurge(store, cfg, now, max = 10) {
  let n = 0;
  for (const key of await store.list('idem/')) {
    if (n >= max) break;
    const cur = await store.get(key);
    if (cur && now - cur.data.at > cfg.idemTtlSeconds * 1000) { await store.del(key); n++; }
  }
  return n;
}

// ---------------- auth lockout (per client IP) ----------------
export const LOCK = Object.freeze({ maxFails: 5, windowMs: 15 * 60 * 1000, lockMs: 30 * 60 * 1000 });
const lockKey = (ip) => 'lock/' + sha('ip:' + (ip || 'unknown')).slice(0, 32);

export async function lockState(store, ip, now) {
  const cur = await store.get(lockKey(ip));
  if (cur && cur.data.until && cur.data.until > now) return { locked: true, retryAfter: Math.ceil((cur.data.until - now) / 1000) };
  return { locked: false };
}
export async function recordAuthFailure(store, ip, now) {
  const key = lockKey(ip);
  for (let a = 0; a < 6; a++) {
    const cur = await store.get(key);
    let d = cur ? cur.data : { n: 0, first: now, until: 0 };
    if (now - d.first > LOCK.windowMs) d = { n: 0, first: now, until: 0 };
    d.n++;
    if (d.n >= LOCK.maxFails) d.until = now + LOCK.lockMs;
    const ok = cur ? await store.put(key, d, { onlyIfMatch: cur.etag }) : await store.put(key, d, { onlyIfNew: true });
    if (ok) return d;
  }
  return null;
}
