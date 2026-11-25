'use strict';
// R8 t111u (pending CC confirmation, Claude decision 2): S6 helper stays in the package;
// the Garmin proxy endpoint is excluded until S7/S9. The stub is imported from the source tree.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');

test('deploy package includes garmin-import.js and the S6 helper, and excludes the Garmin proxy endpoint', (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hyrox-pkg-'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/build-deploy-package.mjs'), out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /source id [0-9a-f]{12}/);
  assert.equal(fs.existsSync(path.join(out, 'publish/src/integrations/garmin-import.js')), true);
  assert.equal(fs.existsSync(path.join(out, 'netlify/lib/auth-lockout-shared.mjs')), true);
  assert.equal(fs.existsSync(path.join(out, 'netlify/functions/garmin-personal-proxy.mjs')), false, 'Garmin function stays out of the package until S7/S9');
  assert.equal(fs.existsSync(path.join(out, 'netlify/lib/garmin-personal-proxy.mjs')), false);
  assert.equal(fs.existsSync(path.join(out, 'netlify/lib/garmin-personal-proxy-sync.cjs')), false);
  const hits = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const pth = path.join(d, f.name);
      if (f.isDirectory()) walk(pth);
      else if (/garmin-personal-proxy/.test(f.name)) hits.push(path.relative(out, pth));
    }
  })(out);
  assert.deepEqual(hits, [], 'throwaway package must contain no garmin-personal-proxy* file');

  return (async () => {
    const lock = await import(pathToFileURL(path.join(out, 'netlify/lib/auth-lockout-shared.mjs')).href);
    assert.equal(typeof lock.checkCode, 'function');
    const proxy = await import(pathToFileURL(path.join(ROOT, 'netlify/lib/garmin-personal-proxy.mjs')).href);
    assert.equal(typeof proxy.handleProxy, 'function');
    // Clock: 2026-11-24 06:00Z is 09:00 Asia/Qatar. Caller cannot widen today to the 23rd.
    const nowMs = Date.UTC(2026, 10, 24, 6, 0, 0);
    const today = proxy.todayFromNow(nowMs);
    assert.equal(today, '2026-11-24');
    const res = await proxy.handleProxy({
      nowMs,
      todayQatar: '2026-11-23', // must be ignored
      origin: 'http://127.0.0.1:4177',
      op: 'validate',
      garminConfigured: false,
      ownerCodeAccepted: true,
      fetch: async () => { throw new Error('NO_LIVE_GARMIN'); }
    });
    assert.ok(res);
    fs.rmSync(out, { recursive: true, force: true });
  })();
});
