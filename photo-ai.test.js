'use strict';
// Photo AI adapter tests: metadata stripping on a synthetic EXIF/GPS fixture, consent gates, schema validation,
// mock labelling, failure modes. No network: the HTTP provider is exercised with a fake fetch only.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AI = require(path.resolve(__dirname, '../src/ai/photo-ai.js'));

const FIX = path.join(__dirname, 'fixtures');
const exifJpeg = new Uint8Array(fs.readFileSync(path.join(FIX, 'synthetic-food-exif.jpg')));
const contains = (bytes, ascii) => Buffer.from(bytes).includes(Buffer.from(ascii));
function cleanImage() { return { sanitized: true, mime: 'image/jpeg', bytes: AI.stripJpegMetadata(exifJpeg) }; }
const CONSENT = { privacyAck: true, sendThisPhoto: true };

describe('metadata sanitization', () => {
  it('fixture really has EXIF + GPS + comment before stripping', () => {
    assert.equal(AI.hasMetadata(exifJpeg), true);
    assert.equal(contains(exifJpeg, 'Exif'), true);
    assert.equal(contains(exifJpeg, 'SyntheticCam'), true);
    assert.equal(contains(exifJpeg, 'synthetic fixture comment'), true);
  });
  it('strip removes EXIF/GPS/comment and keeps a valid JPEG', () => {
    const out = AI.stripJpegMetadata(exifJpeg);
    assert.equal(AI.hasMetadata(out), false);
    assert.equal(contains(out, 'Exif'), false);
    assert.equal(contains(out, 'SyntheticCam'), false);
    assert.equal(contains(out, 'synthetic fixture comment'), false);
    assert.equal(out[0], 0xFF); assert.equal(out[1], 0xD8);
    assert.equal(out[out.length - 2], 0xFF); assert.equal(out[out.length - 1], 0xD9);
    assert.ok(out.length < exifJpeg.length);
  });
  it('non-JPEG and truncated input are rejected', () => {
    assert.throws(() => AI.stripJpegMetadata(new Uint8Array(fs.readFileSync(path.join(FIX, 'not-an-image.jpg')))), /NOT_JPEG/);
    assert.throws(() => AI.stripJpegMetadata(exifJpeg.subarray(0, 10)), /CORRUPT_JPEG/);
  });
  it('file validation: type, empty, size', () => {
    assert.equal(AI.validateFile({ type: 'image/jpeg', size: 1000 }).ok, true);
    assert.equal(AI.validateFile({ type: 'image/heic', size: 1000 }).ok, true);
    assert.equal(AI.validateFile({ type: 'application/pdf', size: 1000 }).code, 'UNSUPPORTED_TYPE');
    assert.equal(AI.validateFile({ type: 'image/jpeg', size: 0 }).code, 'EMPTY_FILE');
    assert.equal(AI.validateFile({ type: 'image/jpeg', size: 16 * 1024 * 1024 }).code, 'TOO_LARGE');
    assert.equal(AI.validateFile(null).code, 'NO_FILE');
  });
});

describe('consent and transfer gates', () => {
  it('unconfigured provider never analyzes', async () => {
    const r = await AI.createSession(AI.providers.unconfigured()).analyze({ image: cleanImage(), consent: CONSENT });
    assert.equal(r.ok, false); assert.equal(r.code, 'NOT_CONFIGURED');
  });
  it('no consent -> provider is never called', async () => {
    const p = AI.providers.mock({ delayMs: 0 });
    const s = AI.createSession(p);
    assert.equal((await s.analyze({ image: cleanImage() })).code, 'NO_CONSENT');
    assert.equal((await s.analyze({ image: cleanImage(), consent: { privacyAck: true } })).code, 'NO_CONSENT');
    assert.equal((await s.analyze({ image: cleanImage(), consent: { sendThisPhoto: true } })).code, 'NO_CONSENT');
    assert.equal(p.calls, 0);
  });
  it('unsanitized image (metadata present) is never sent', async () => {
    let called = 0;
    const p = AI.providers.http({ endpoint: '/x', fetchImpl: () => { called++; return Promise.reject(new Error('no')); } });
    const r = await AI.createSession(p).analyze({ image: { sanitized: true, bytes: exifJpeg }, consent: CONSENT });
    assert.equal(r.code, 'NOT_SANITIZED'); assert.equal(called, 0);
    const r2 = await AI.createSession(p).analyze({ image: { sanitized: false, bytes: cleanImage().bytes }, consent: CONSENT });
    assert.equal(r2.code, 'NOT_SANITIZED'); assert.equal(called, 0);
  });
  it('single-flight: a double tap does not send twice', async () => {
    const p = AI.providers.mock({ delayMs: 20 });
    const s = AI.createSession(p);
    const [a, b] = await Promise.all([s.analyze({ image: cleanImage(), consent: CONSENT }), s.analyze({ image: cleanImage(), consent: CONSENT })]);
    assert.equal(a.ok, true); assert.equal(b.code, 'IN_FLIGHT'); assert.equal(p.calls, 1);
  });
  it('HTTP payload carries consent header, sanitized bytes only, no filename', async () => {
    let seen;
    const p = AI.providers.http({ endpoint: '/api/food-photo/', fetchImpl: (url, init) => { seen = { url, init }; return Promise.resolve({ status: 200, json: () => Promise.resolve(AI.MOCK_FIXTURES.plate) }); } });
    const r = await AI.createSession(p).analyze({ image: cleanImage(), description: 'half rice', consent: CONSENT });
    assert.equal(seen.url, '/api/food-photo/analyze');
    assert.equal(seen.init.headers['X-Hyrox-Consent'], 'send-once');
    const body = JSON.parse(seen.init.body);
    assert.deepEqual(Object.keys(body).sort(), ['consent', 'description', 'imageBase64', 'itemBasis', 'mimeType', 'requestId']); // re-pointed by the P0 sprint fix (itemBasis)
    const sent = Buffer.from(body.imageBase64, 'base64');
    assert.equal(AI.hasMetadata(new Uint8Array(sent)), false);
    assert.equal(sent.includes(Buffer.from('SyntheticCam')), false);
    assert.equal(r.ok, true); assert.equal(r.result.mode, 'REAL');
  });
});

describe('results', () => {
  it('mock results are always labelled MOCK and carry the MOCK TEST warning', async () => {
    const r = await AI.createSession(AI.providers.mock({ delayMs: 0 })).analyze({ image: cleanImage(), consent: CONSENT });
    assert.equal(r.ok, true); assert.equal(r.result.mode, 'MOCK');
    assert.match(r.result.warnings[0], /MOCK TEST/);
  });
  it('unknown oil stays UNKNOWN (null), never 0, after conversion', async () => {
    const r = await AI.createSession(AI.providers.mock({ delayMs: 0 })).analyze({ image: cleanImage(), consent: CONSENT });
    const comps = AI.resultToComponents(r.result);
    const oil = comps.find((c) => c.role === 'OIL');
    assert.deepEqual(oil.kcal, { value: null, state: 'UNKNOWN' });
    assert.equal(comps[0].kcal.state, 'ESTIMATED');
  });
  it('invalid / unsafe response is discarded', async () => {
    const r = await AI.createSession(AI.providers.mock({ scenario: 'invalid', delayMs: 0 })).analyze({ image: cleanImage(), consent: CONSENT });
    assert.equal(r.ok, false); assert.equal(r.code, 'INVALID_RESPONSE');
  });
  it('impossible macros are rejected', async () => {
    const r = await AI.createSession(AI.providers.mock({ scenario: 'impossible', delayMs: 0 })).analyze({ image: cleanImage(), consent: CONSENT });
    assert.equal(r.code, 'INVALID_RESPONSE');
  });
  it('unexpected fields rejected; zero and null both allowed', () => {
    const base = JSON.parse(JSON.stringify(AI.MOCK_FIXTURES.plate));
    assert.equal(AI.validateResult(base).ok, true);
    base.items[0].secret = 1; assert.equal(AI.validateResult(base).ok, false);
    const z = JSON.parse(JSON.stringify(AI.MOCK_FIXTURES.plate)); z.items[0].fatG = 0; z.items[0].kcal = 200;
    assert.equal(AI.validateResult(z).ok, true);
    const extra = JSON.parse(JSON.stringify(AI.MOCK_FIXTURES.plate)); extra.debug = true;
    assert.equal(AI.validateResult(extra).ok, false);
  });
  it('empty items = no food recognised, still valid', async () => {
    const r = await AI.createSession(AI.providers.mock({ scenario: 'unknown', delayMs: 0 })).analyze({ image: cleanImage(), consent: CONSENT });
    assert.equal(r.ok, true); assert.equal(r.result.items.length, 0);
  });
  it('provider error, budget exhaustion and timeout fail safely', async () => {
    const e = await AI.createSession(AI.providers.mock({ scenario: 'error', delayMs: 0 })).analyze({ image: cleanImage(), consent: CONSENT });
    assert.equal(e.code, 'PROVIDER_ERROR');
    const q = await AI.createSession(AI.providers.mock({ scenario: 'quota', delayMs: 0 })).analyze({ image: cleanImage(), consent: CONSENT });
    assert.equal(q.code, 'BUDGET_EXHAUSTED');
    const t = await AI.createSession(AI.providers.mock({ scenario: 'timeout' }), { timeoutMs: 30 }).analyze({ image: cleanImage(), consent: CONSENT });
    assert.equal(t.code, 'TIMEOUT');
  });
  it('HTTP status codes map to explicit failures, never success', async () => {
    for (const [status, code] of [[503, 'NOT_CONFIGURED'], [402, 'BUDGET_EXHAUSTED'], [401, 'AUTH'], [502, 'PROVIDER_ERROR']]) {
      const p = AI.providers.http({ endpoint: '/x', fetchImpl: () => Promise.resolve({ status, json: () => Promise.resolve({}) }) });
      const r = await AI.createSession(p).analyze({ image: cleanImage(), consent: CONSENT });
      assert.equal(r.ok, false); assert.equal(r.code, code);
    }
  });
});
