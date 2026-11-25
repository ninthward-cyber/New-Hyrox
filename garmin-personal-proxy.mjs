// Offline S7-shaped Garmin Personal API proxy (R7/R8, 24 Nov 2026).
// Async ESM, importable from the deploy package. Computes today (Asia/Qatar)
// itself. Uses the shared lockout helper when a store is provided. Not deployed
// in this pass. No live Garmin call, no key handling.
import { checkCode, LOCKED_BODY } from './auth-lockout-shared.mjs';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
function loadGarminImport() {
  for (const p of [
    join(here, '../../src/integrations/garmin-import.js'),
    join(here, '../../publish/src/integrations/garmin-import.js')
  ]) {
    if (!existsSync(p)) continue;
    const mod = require(p);
    const api = (mod && typeof mod.todayQatarFromNow === 'function') ? mod
      : (mod && mod.default && typeof mod.default.todayQatarFromNow === 'function') ? mod.default
      : (typeof globalThis !== 'undefined' && globalThis.HyroxGarminImport) ? globalThis.HyroxGarminImport
      : null;
    if (api && typeof api.todayQatarFromNow === 'function') return api;
  }
  throw new Error('garmin-import.js not found or did not export todayQatarFromNow (source or publish/)');
}
const GI = loadGarminImport();
const { handleProxy: syncHandle, resetProxyState } = require('./garmin-personal-proxy-sync.cjs');

function todayFromNow(nowMs) {
  return GI.todayQatarFromNow(nowMs != null ? nowMs : Date.now());
}

/**
 * Async proxy entry. Today is derived from nowMs (the clock); the caller cannot widen it.
 * opts.fetch may be async. Lockout uses checkCode when opts.store is provided.
 */
export async function handleProxy(opts) {
  opts = Object.assign({}, opts || {});
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  opts.nowMs = nowMs;
  const computedToday = todayFromNow(nowMs);
  if (computedToday) opts.todayQatar = computedToday;
  if (opts.store && opts.ownerHash && opts.code != null && opts.ownerCodeAccepted == null) {
    const r = await checkCode({
      store: opts.store, now: nowMs, ip: opts.ip || 'unknown',
      ownerHash: opts.ownerHash, code: opts.code
    });
    if (!r.ok) {
      return {
        status: r.status,
        body: r.body,
        bodyText: r.bodyText || (r.status === 429 ? LOCKED_BODY : '{"ok":false,"code":"AUTH"}'),
        compared: r.compared
      };
    }
    opts.ownerCodeAccepted = true;
  }
  const result = syncHandle(opts);
  return result && typeof result.then === 'function' ? await result : result;
}

export async function handler(event) {
  const origin = event && event.headers && (event.headers.origin || event.headers.Origin);
  let body = {};
  try { body = event && event.body ? JSON.parse(event.body) : {}; } catch (e) { body = {}; }
  const res = await handleProxy({
    origin: origin,
    op: body.op || 'fetch',
    startDate: body.startDate,
    endDate: body.endDate,
    dataset: body.dataset,
    nowMs: Date.now(),
    garminConfigured: false,
    ownerCodeAccepted: false,
    fetch: async () => { throw new Error('NO_LIVE_GARMIN'); }
  });
  return {
    statusCode: res.status,
    headers: { 'Content-Type': 'application/json' },
    body: res.bodyText || JSON.stringify(res.body)
  };
}

export { resetProxyState, todayFromNow, LOCKED_BODY };
