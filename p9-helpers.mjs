// Test harness for the Netlify function: in-memory Blobs-compatible store (with etags + failure injection),
// a stub OpenAI endpoint (injected fetch), and request builders. No network. No real key.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../netlify/lib/handler.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIX = (n) => path.join(HERE, 'fixtures', n);
export const jpegB64 = (n = 'p9-clean-square.jpg') => fs.readFileSync(FIX(n)).toString('base64');
export const OWNER_CODE = 'hx-TEST-' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2';
export const OWNER_HASH = createHash('sha256').update(OWNER_CODE).digest('hex');
export const FAKE_KEY = 'sk-test-FAKEKEYFAKEKEYFAKEKEY0123456789';
export const BASE_ENV = Object.freeze({ HYROX_PHOTO_ENABLED: 'true', OPENAI_API_KEY: FAKE_KEY, HYROX_OWNER_CODE_HASH: OWNER_HASH, HYROX_MIN_GAP_SECONDS: '0' });

export function memStore() {
  const m = new Map(); let v = 0;
  const s = { m, down: false, ops: 0, failNextPutMatch: 0,
    chk() { s.ops++; if (s.down) throw new Error('blobs down'); },
    async get(k) { s.chk(); const r = m.get(k); return r ? { data: JSON.parse(JSON.stringify(r.data)), etag: r.etag } : null; },
    async put(k, data, o = {}) { s.chk(); const cur = m.get(k);
      if (o.onlyIfNew && cur) return false;
      if (o.onlyIfMatch && (!cur || cur.etag !== o.onlyIfMatch)) return false;
      m.set(k, { data: JSON.parse(JSON.stringify(data)), etag: 'e' + (++v) }); return true; },
    async del(k) { s.chk(); m.delete(k); },
    async list(p) { s.chk(); return [...m.keys()].filter((k) => k.startsWith(p)); } };
  return s;
}

export const goodModelJson = (over = {}) => JSON.stringify({
  items: [
    { name: 'Grilled chicken breast', role: 'MAIN', preparation: 'grilled', portion: 'about one palm', notVisible: false, kcal: 220, proteinG: 40, carbsG: 0, fatG: 5, confidence: 'MEDIUM', uncertainty: 'portion ±30%' },
    { name: 'White rice', role: 'SIDE', preparation: 'boiled', portion: 'about one cup', notVisible: false, kcal: 240, proteinG: 5, carbsG: 53, fatG: 1, confidence: 'MEDIUM', uncertainty: 'portion ±30%' },
    { name: 'Cooking oil', role: 'OIL', preparation: null, portion: null, notVisible: true, kcal: 120, proteinG: 0, carbsG: 0, fatG: 14, confidence: 'HIGH', uncertainty: null },
  ], warnings: ['Sauce unknown.'], ...over });

export const openaiOk = (text = goodModelJson(), usage = { input_tokens: 2700, output_tokens: 900 }) =>
  ({ status: 200, body: { id: 'resp_x', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage } });

// stub: script = function(call) -> {status, body} | Promise | 'hang'
export function stubFetch(script) {
  const f = async (url, init) => {
    f.calls.push({ url, init, body: JSON.parse(init.body) });
    const r = await script(f.calls[f.calls.length - 1], f.calls.length);
    if (r === 'hang') return new Promise((_, rej) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
  };
  f.calls = [];
  return f;
}

export function setup({ env = {}, script = () => openaiOk(), store = memStore(), clock = { t: Date.UTC(2026, 10, 16, 6, 0, 0) } } = {}) {
  const fetchStub = stubFetch(script);
  const logs = [];
  const fullEnv = { ...BASE_ENV, ...env };
  for (const k of Object.keys(fullEnv)) if (fullEnv[k] === undefined) delete fullEnv[k];
  const handle = createHandler({ env: fullEnv, fetch: fetchStub, getStore: () => store, now: () => clock.t, log: (s) => logs.push(s) });
  return { handle, fetchStub, store, logs, clock, env: fullEnv };
}

export function analyzeReq(over = {}) {
  const { headers = {}, body, bodyObj = {}, token = OWNER_CODE, url = 'https://hyrox.test/api/food-photo/analyze', method = 'POST' } = over;
  const h = { 'Content-Type': 'application/json', 'X-Hyrox-Consent': 'send-once', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers };
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  const b = body !== undefined ? body : JSON.stringify({ imageBase64: jpegB64(), mimeType: 'image/jpeg', description: '', consent: true, requestId: 'req-' + Math.random().toString(36).slice(2, 10), ...bodyObj });
  return new Request(url, { method, headers: h, body: method === 'GET' ? undefined : b });
}
export const statusReq = (token, headers = {}) => new Request('https://hyrox.test/api/food-photo/status', { method: 'GET', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } });
export const j = async (res) => ({ status: res.status, body: await res.json(), headers: res.headers });
