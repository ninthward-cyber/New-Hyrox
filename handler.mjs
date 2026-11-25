// Same-origin API for the HYROX app: GET /api/food-photo/status, POST /api/food-photo/analyze.
// All collaborators are injected (env, fetch, store, clock) so the exact production code path is testable offline.
import { timingSafeEqual, createHash } from 'node:crypto';
import { readConfig, IMAGE_LABELS, worstCaseUsd } from './config.mjs';
import { checkImages, requestSetHash } from './image.mjs';
import { callProvider, estimateCostUsd, normalizeModelOutput, requestTextChars, shapeForClient } from './openai.mjs';
import { sha, reserve, settle, readLedger, idemBegin, idemDone, idemFail, idemPurge, lockState, recordAuthFailure } from './store.mjs';

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function reply(status, body, extra) { return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...(extra || {}) } }); }
function fail(status, code, message, extra) {
  const detail = { code, message };
  // P10: allowlisted operator diagnostics only (category, provider HTTP status, allowlisted provider code, provider request id).
  const d = extra && extra.diag;
  if (d) {
    if (typeof d.category === 'string') detail.category = d.category;
    if (Number.isInteger(d.providerStatus)) detail.providerStatus = d.providerStatus;
    if (typeof d.providerCode === 'string') detail.providerCode = d.providerCode;
    if (typeof d.providerRequestId === 'string') detail.providerRequestId = d.providerRequestId;
  }
  return reply(status, { detail }, extra && extra.retryAfter ? { 'Retry-After': String(extra.retryAfter) } : undefined);
}

// Safe operational log: event name and numbers only. Never image data, keys, tokens, descriptions or meal text.
function logEvent(log, evt, fields) { try { log(JSON.stringify({ evt, ...fields })); } catch (e) { /* ignore */ } }

function bearer(req) {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(\S{1,512})$/i.exec(h.trim());
  return m ? m[1] : '';
}

function codeMatches(code, hashHex) {
  const a = createHash('sha256').update(code).digest();
  const b = Buffer.from(hashHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function originOk(req) {
  const o = req.headers.get('origin');
  if (!o) return true; // non-browser callers (curl) carry no Origin; the bearer token is the real gate
  try {
    const oh = new URL(o).host;
    const hosts = [new URL(req.url).host, req.headers.get('host'), req.headers.get('x-forwarded-host')].filter(Boolean);
    return hosts.includes(oh);
  } catch (e) { return false; }
}

async function readBody(req, max) {
  const cl = Number(req.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > max) return { tooLarge: true };
  if (!req.body) return { text: '' };
  const reader = req.body.getReader();
  const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { try { await reader.cancel(); } catch (e) { /* ignore */ } return { tooLarge: true }; }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8') };
}

export function createHandler(deps) {
  const env = deps.env, now = deps.now || (() => Date.now()), log = deps.log || ((s) => console.log(s));
  const getStore = deps.getStore; // () => store, may throw
  const fetchImpl = deps.fetch;
  let CFG = null;

  function ipOf(req, context) { return (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || ''; }

  // Returns null when authorised, otherwise a Response.
  async function authorise(req, context, store, cfg, { optional }) {
    const code = bearer(req);
    if (code === null) return optional ? { anonymous: true } : fail(401, 'AUTH', 'Owner access code required. Enter it in Settings.');
    const ip = ipOf(req, context);
    const lk = await lockState(store, ip, now());
    if (lk.locked) return fail(429, 'LOCKED_OUT', 'Too many wrong codes. Try again later.', { retryAfter: lk.retryAfter });
    if (!code || !codeMatches(code, cfg.ownerHash)) {
      await recordAuthFailure(store, ip, now());
      return fail(401, 'AUTH', 'Owner access code is wrong. Check it in Settings.');
    }
    return null;
  }
  async function status(req, context) {
    const c = readConfig(env);
    if (!c.ok) { logEvent(log, 'status_not_configured', { problems: c.problems.length }); return reply(503, { configured: false, detail: { code: 'NOT_CONFIGURED', message: 'Photo analysis is not set up on the server.' } }); }
    CFG = c.config;
    if (!originOk(req)) return fail(403, 'NOT_AUTHORIZED', 'Request origin not allowed.');
    if (bearer(req) === null) return reply(200, { configured: true, status: 'OK', authRequired: true, authorized: false });
    let store;
    try {
      store = getStore();
      const denied = await authorise(req, context, store, CFG, { optional: false });
      if (denied) return denied;
      const usage = await readLedger(store, CFG, now());
      return reply(200, { configured: true, status: 'OK', authRequired: true, authorized: true, mode: 'REAL', provider: 'openai', model: CFG.model, imageDetail: CFG.detail, usage });
    } catch (e) {
      logEvent(log, 'storage_error', { where: 'status' });
      return fail(503, 'STORAGE_UNAVAILABLE', 'Usage storage is unavailable, so analysis is switched off.');
    }
  }

  async function analyze(req, context) {
    const t0 = now();
    const c = readConfig(env);
    if (!c.ok) { logEvent(log, 'analyze_not_configured', { problems: c.problems.length }); return fail(503, 'NOT_CONFIGURED', 'Photo analysis is not set up on the server. Nothing was sent.'); }
    CFG = c.config;
    if (!originOk(req)) return fail(403, 'NOT_AUTHORIZED', 'Request origin not allowed.');
    let store;
    try {
      // 1. authentication (no Blobs access at all when no credential is presented)
      if (bearer(req) === null) return fail(401, 'AUTH', 'Owner access code required. Enter it in Settings.');
      store = getStore();
      const denied = await authorise(req, context, store, CFG, { optional: false });
      if (denied) return denied;
    } catch (e) {
      logEvent(log, 'storage_error', { where: 'auth' });
      return fail(503, 'STORAGE_UNAVAILABLE', 'Usage storage is unavailable, so analysis is switched off. Nothing was sent.');
    }
    // 2. consent
    if (req.headers.get('x-hyrox-consent') !== 'send-once') return fail(403, 'NO_CONSENT', 'Nothing was sent: per-request consent missing.');
    // 3. body
    const ct = (req.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('application/json')) return fail(400, 'BAD_REQUEST', 'Request must be JSON.');
    const body = await readBody(req, CFG.maxBodyBytes);
    if (body.tooLarge) return fail(413, 'TOO_LARGE', 'The photo is too large. Nothing was sent.');
    let j;
    try { j = JSON.parse(body.text); } catch (e) { return fail(400, 'BAD_REQUEST', 'Malformed request.'); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return fail(400, 'BAD_REQUEST', 'Malformed request.');
    if (j.consent !== true) return fail(403, 'NO_CONSENT', 'Nothing was sent: per-request consent missing.');
    if (typeof j.requestId !== 'string' || !/^[A-Za-z0-9_.-]{4,64}$/.test(j.requestId)) return fail(400, 'BAD_REQUEST', 'Missing or invalid request id.');
    if (j.description !== undefined && (typeof j.description !== 'string' || j.description.length > 500)) return fail(400, 'BAD_REQUEST', 'Description is too long.');
    // 4. image gate: one photo (P9 shape) or 1-3 photos of one meal (P10). Every photo is validated and stripped.
    const img = checkImages(j, CFG, IMAGE_LABELS);
    if (!img.ok) return fail(img.code === 'TOO_LARGE' ? 413 : 400, img.code, img.message);
    if (j.itemBasis !== undefined && typeof j.itemBasis !== 'boolean') return fail(400, 'BAD_REQUEST', 'Malformed request.');
    const wantBasis = j.itemBasis === true; // P0 sprint: only apps that understand item bases receive them
    const note = typeof j.description === 'string' ? j.description : '';
    const photos = img.multi ? img.images.map((im) => ({ b64: im.bytes.toString('base64'), label: im.label })) : img.images[0].bytes.toString('base64');
    // P10: a request is sent only if its worst case provably fits inside the fixed reservation.
    // Claude P10 review: this now applies to single photos too (on Grok's P10 only 2-3 photo requests were checked).
    {
      const worst = worstCaseUsd(CFG, img.images, requestTextChars(CFG, photos, note));
      if (worst > CFG.reserveUsd) {
        logEvent(log, 'analyze_cost_bound', { images: img.images.length });
        return fail(413, 'TOO_LARGE', img.multi
          ? 'These photos are too large to analyse within the cost limit. Use fewer or smaller photos. Nothing was sent.'
          : 'This photo cannot be analysed within the per-photo cost limit for the configured model (raise HYROX_RESERVE_USD or use the default model). Nothing was sent.');
      }
    }
    const setHash = requestSetHash(img.images, note);
    // 5. idempotency, budget, provider, validation, settle
    const reqId = j.requestId;
    let idem = null, reserved = false;
    const resId = sha('res:' + reqId + ':' + t0 + ':' + Math.random()).slice(0, 24);
    try {
      idem = await idemBegin(store, CFG, now(), reqId, setHash);
      if (idem.kind === 'replay') { logEvent(log, 'analyze_replay', { ms: now() - t0 }); return reply(200, shapeForClient(idem.result, wantBasis), { 'X-Hyrox-Replay': 'true' }); }
      if (idem.kind === 'inflight') return fail(409, 'IN_FLIGHT', 'This photo is already being analysed. Wait for it to finish.');
      if (idem.kind === 'conflict') return fail(409, 'BAD_REQUEST', 'Request id was already used for different photos or a different note.');
      const rv = await reserve(store, CFG, now(), resId);
      if (!rv.ok) { await idemFail(store, idem.key); return fail(rv.status, rv.code, rv.message, { retryAfter: rv.retryAfter }); }
      reserved = true;
    } catch (e) {
      try { if (idem && idem.kind === 'new') await idemFail(store, idem.key); } catch (e2) { /* ignore */ }
      logEvent(log, 'storage_error', { where: 'reserve' });
      return fail(503, 'STORAGE_UNAVAILABLE', 'Usage storage is unavailable, so analysis is switched off. Nothing was sent.');
    }
    const p = await callProvider(CFG, fetchImpl, photos, note);
    const usage = p.usage || null;
    let cost = estimateCostUsd(CFG, usage);
    // Claude P9 review: unknown usage on a call that was (or may have been) billed is charged at the reservation. A successful
    // answer is always billed; on fd-P9 it carried no `billed` flag, so a success without a usage figure was recorded as $0.
    if (cost === null) cost = (p.ok || p.billed) ? CFG.reserveUsd : 0;
    const done = async (extra) => { try { await settle(store, CFG, now(), resId, { usd: cost, refundCall: !p.billed && !extra }); } catch (e) { logEvent(log, 'settle_failed', {}); } };
    if (!p.ok) {
      await done();
      try { await idemFail(store, idem.key); } catch (e) { /* ignore */ }
      const dg = p.diag || {};
      logEvent(log, 'analyze_provider_fail', { code: p.code, category: dg.category || null, pStatus: dg.providerStatus || null, pCode: dg.providerCode || null, pReq: dg.providerRequestId || null, images: img.images.length, ms: now() - t0, costUsd: cost });
      return fail(p.status, p.code, p.message, { diag: dg });
    }
    const n = normalizeModelOutput(p.text, CFG);
    await done(true);
    if (!n.ok) {
      try { await idemFail(store, idem.key); } catch (e) { /* ignore */ }
      logEvent(log, 'analyze_invalid_output', { reason: n.reason, pReq: p.providerRequestId || null, ms: now() - t0, costUsd: cost });
      return fail(502, 'INVALID_RESPONSE', 'The model response failed validation and was discarded.', { diag: { category: 'INVALID_OUTPUT', providerRequestId: p.providerRequestId || undefined } });
    }
    try { await idemDone(store, idem.key, setHash, now(), n.value); await idemPurge(store, CFG, now()); } catch (e) { logEvent(log, 'idem_store_failed', {}); }
    logEvent(log, 'analyze_ok', { ms: now() - t0, items: n.value.items.length, images: img.images.length, pReq: p.providerRequestId || null, costUsd: Math.round(cost * 1e6) / 1e6, inTok: usage && usage.input_tokens, outTok: usage && usage.output_tokens });
    return reply(200, shapeForClient(n.value, wantBasis));
  }

  // Routed by suffix when the original /api/food-photo/... path is preserved, otherwise by method
  // (a redirect to /.netlify/functions/food-photo may drop the suffix): GET = status, POST = analyze.
  async function route(req, context, path) {
    const isStatus = path.endsWith('/status') || (!path.endsWith('/analyze') && req.method === 'GET');
    const isAnalyze = path.endsWith('/analyze') || (!path.endsWith('/status') && req.method === 'POST');
    if (isStatus) return req.method === 'GET' ? status(req, context) : fail(405, 'BAD_REQUEST', 'Use GET.');
    if (isAnalyze) return req.method === 'POST' ? analyze(req, context) : fail(405, 'BAD_REQUEST', 'Use POST.');
    return fail(405, 'BAD_REQUEST', 'Use GET for status or POST for analyze.');
  }

  return async function handle(req, context) {
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    let res;
    try { res = await route(req, context, path); } catch (e) {
      logEvent(log, 'unhandled', { name: e && e.name });
      res = fail(500, 'PROVIDER_ERROR', 'Unexpected server error. Nothing was saved.');
    }
    let code = null;
    if (res.status >= 400) { try { const b = await res.clone().json(); code = b && b.detail && b.detail.code; } catch (e) { /* ignore */ } }
    logEvent(log, 'req', { ep: path.endsWith('/analyze') ? 'analyze' : path.endsWith('/status') ? 'status' : req.method, status: res.status, code });
    return res;
  };
}
