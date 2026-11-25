// Server configuration. Everything comes from environment variables (Netlify UI, Functions scope).
// Fail closed: any missing or malformed required value => not configured => NOT_CONFIGURED, no provider call.

// USD per 1M tokens, Standard processing, from https://platform.openai.com/docs/pricing (read 15 Nov 2026).
// Override with HYROX_PRICE_IN_PER_M / HYROX_PRICE_OUT_PER_M if you choose a model that is not listed.
export const PRICE_TABLE = Object.freeze({
  'gpt-6-luna': { in: 0.10, out: 0.50 },
  'gpt-5.6-luna': { in: 0.20, out: 1.20 },
  'gpt-5.4-nano': { in: 0.20, out: 1.25 },
  'gpt-5.4-mini': { in: 0.75, out: 4.50 },
  'gpt-5-mini': { in: 0.25, out: 2.00 },
  'gpt-6.1-terra': { in: 1.00, out: 5.00 },
  'gpt-4.1-mini': { in: 0.40, out: 1.60 },
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
});

export const DEFAULT_MODEL = 'gpt-6-luna';
// Hard ceilings: even a mistyped env var cannot raise a cap above these.
export const CEILINGS = Object.freeze({ totalUsd: 20, monthlyUsd: 10, dailyCalls: 100, monthlyCalls: 1500, burstCalls: 20 });

const OPENAI_BASE = 'https://api.openai.com';
const TZ_OFFSET_MS = 3 * 3600 * 1000; // Asia/Qatar (UTC+3, no DST): day and month rollover follow the owner's calendar.

function num(env, name, dflt, { min = 0, max = Infinity, int = false } = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return { v: dflt };
  const v = Number(String(raw).trim());
  if (!Number.isFinite(v) || v < min || (int && !Number.isInteger(v))) return { err: name };
  return { v: Math.min(v, max) };
}

export function readConfig(env) {
  const problems = [];
  const get = (k) => (env[k] === undefined || env[k] === null ? '' : String(env[k]).trim());
  const enabled = get('HYROX_PHOTO_ENABLED') === 'true';
  if (!enabled) problems.push('HYROX_PHOTO_ENABLED is not exactly "true"');
  const apiKey = get('OPENAI_API_KEY');
  if (apiKey.length < 20) problems.push('OPENAI_API_KEY missing');
  const ownerHash = get('HYROX_OWNER_CODE_HASH').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(ownerHash)) problems.push('HYROX_OWNER_CODE_HASH missing or not 64 hex characters');
  const model = get('HYROX_PHOTO_MODEL') || DEFAULT_MODEL;
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(model)) problems.push('HYROX_PHOTO_MODEL invalid');
  let price = PRICE_TABLE[model];
  const pin = num(env, 'HYROX_PRICE_IN_PER_M', null, { min: 0.0001, max: 1000 });
  const pout = num(env, 'HYROX_PRICE_OUT_PER_M', null, { min: 0.0001, max: 1000 });
  if (pin.err || pout.err) problems.push('HYROX_PRICE_* invalid');
  if (pin.v !== null && pout.v !== null && !pin.err && !pout.err) price = { in: pin.v, out: pout.v };
  if (!price) problems.push('no price known for model ' + model + ' (set HYROX_PRICE_IN_PER_M and HYROX_PRICE_OUT_PER_M)');
  const detail = get('HYROX_PHOTO_IMAGE_DETAIL') || 'auto';
  if (!['auto', 'low'].includes(detail)) problems.push('HYROX_PHOTO_IMAGE_DETAIL must be auto or low');
  const reasoning = get('HYROX_PHOTO_REASONING') || 'low';
  if (!['none', 'low', 'medium'].includes(reasoning)) problems.push('HYROX_PHOTO_REASONING must be none, low or medium');
  const caps = {
    totalUsd: num(env, 'HYROX_TOTAL_USD_CAP', 5, { min: 0.01, max: CEILINGS.totalUsd }),
    monthlyUsd: num(env, 'HYROX_MONTHLY_USD_CAP', 3, { min: 0.01, max: CEILINGS.monthlyUsd }),
    dailyCalls: num(env, 'HYROX_DAILY_CALL_CAP', 20, { min: 1, max: CEILINGS.dailyCalls, int: true }),
    monthlyCalls: num(env, 'HYROX_MONTHLY_CALL_CAP', 300, { min: 1, max: CEILINGS.monthlyCalls, int: true }),
    burstCalls: num(env, 'HYROX_BURST_CAP', 6, { min: 1, max: CEILINGS.burstCalls, int: true }),
    minGapSeconds: num(env, 'HYROX_MIN_GAP_SECONDS', 4, { min: 0, max: 600 }),
    reserveUsd: num(env, 'HYROX_RESERVE_USD', 0.004, { min: 0.0001, max: 0.25 }),
    timeoutMs: num(env, 'HYROX_PROVIDER_TIMEOUT_MS', 40000, { min: 1000, max: 42000, int: true }),
  };
  for (const [k, c] of Object.entries(caps)) if (c.err) problems.push(c.err + ' invalid');
  let baseUrl = get('HYROX_OPENAI_BASE_URL') || OPENAI_BASE;
  // A non-default base URL is only honoured for a local stub (never reachable from the Netlify runtime).
  if (baseUrl !== OPENAI_BASE && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(baseUrl)) problems.push('HYROX_OPENAI_BASE_URL not allowed');
  if (problems.length) return { ok: false, problems, enabled };
  const c = Object.fromEntries(Object.entries(caps).map(([k, x]) => [k, x.v]));
  return { ok: true, enabled, problems: [], config: Object.freeze({
    apiKey, ownerHash, model, price, detail, reasoning, baseUrl, ...c, burstWindowSeconds: 600, idemTtlSeconds: 900, inflightStaleSeconds: 150,
    maxBodyBytes: 2_400_000, maxImageBytes: 1_650_000, maxOutputTokens: 3000,
    // P10 multi-photo (1-3 photos of ONE meal). The request body limit above is NOT raised: three photos share the same
    // 2.4 MB body and the same 1.65 MB decoded-image budget that one photo had, and each photo is also capped.
    ...MULTI,
  }) };
}

// ---- P10: multiple photos for one meal, and the worst-case cost bound that keeps the fixed reservation safe ----
// Sources (read 17 Nov 2026): Netlify functions configuration (60 s synchronous limit, 6 MB buffered payload),
// OpenAI pricing (gpt-6-luna $0.10 in / $0.50 out per 1M, short context) and OpenAI "Images and vision" (32 px patches,
// per-model multipliers 1.2-2.46; `auto` detail may keep the image's own size on newer models, so the bound below relies
// on our own pixel cap, not on a provider-side resize).
export const IMAGE_LABELS = Object.freeze(['SAME_PLATE', 'BEFORE', 'AFTER', 'EXTRA_DISH']);
export const MULTI = Object.freeze({
  maxImages: 3,
  maxMultiImageBytes: 600_000,      // decoded bytes per photo when 2-3 photos are sent (the app targets <= 500 KB)
  maxMultiTotalBytes: 1_650_000,    // decoded bytes for the whole set (== the single-photo limit)
  multiMaxSide: 1600,               // pixels, longest side, per photo (Claude P10 review: single photos too); the app sends <= 1280
});
// Upper bounds used to prove a request cannot cost more than the fixed reservation BEFORE anything is sent.
export const TOKEN_BOUND = Object.freeze({ patchPx: 32, patchMultiplier: 2.5 /* > every published multiplier (max 2.46) */ });
// Claude P10 review: tile-billed models charge per 512-px tile plus a base, and gpt-4o-mini inflates both (OpenAI
// "Images and vision": gpt-4o-mini 2833 base / 5667 per tile). Patch-billed models in the price table use the patch bound.
// Any model not known to be patch-billed (custom ids, gpt-6.1-terra) gets the larger of both bounds.
export const TILE_TOKENS = Object.freeze({ 'gpt-4o-mini': [2833, 5667] });
const PATCH_MODELS = Object.freeze(['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1-mini']);
const WORST_TILE = [2833, 5667];

// Billable-token upper bound for one image: 32 px patches covering the image at its own size (no provider resize is
// assumed), times a multiplier above every published one. Tile-based models bill far less for the same image.
export function imageTokenBound(width, height, model) {
  const p = Math.ceil(width / TOKEN_BOUND.patchPx) * Math.ceil(height / TOKEN_BOUND.patchPx);
  const patch = Math.ceil(p * TOKEN_BOUND.patchMultiplier);
  if (model === undefined || PATCH_MODELS.includes(model)) return patch; // no model given: the patch bound (P10 API)
  // tiles counted on the image's own size (a provider resize only lowers the count), at the largest published rates
  const t = TILE_TOKENS[model] || WORST_TILE;
  const tile = t[0] + Math.ceil(width / 512) * Math.ceil(height / 512) * t[1];
  return model !== undefined && TILE_TOKENS[model] ? tile : Math.max(patch, tile);
}
// Worst-case USD for one request: every non-image character counted as a whole token (a token is never shorter than
// one character of this ASCII-only prompt), plus the image bound, plus max_output_tokens (reasoning tokens included).
export function worstCaseUsd(cfg, images, textChars) {
  const inTok = Math.max(0, textChars) + images.reduce((a, im) => a + imageTokenBound(im.width, im.height, cfg.model), 0);
  return (inTok * cfg.price.in + cfg.maxOutputTokens * cfg.price.out) / 1e6;
}

export function dayKey(nowMs) { return new Date(nowMs + TZ_OFFSET_MS).toISOString().slice(0, 10); }
export function monthKey(nowMs) { return new Date(nowMs + TZ_OFFSET_MS).toISOString().slice(0, 7); }
