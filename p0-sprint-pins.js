'use strict';
// P0 sprint (23 Nov 2026, photo + note fix): three RC2-pinned files change ON PURPOSE (src/ai/photo-ai.js,
// netlify/lib/openai.mjs, netlify/lib/handler.mjs). The RC2 pin file is kept unchanged as history; this helper checks every
// other pinned file against its RC2 hash, and each of the three against BOTH its documented RC2 hash (so the re-pin is
// explicit) and its new P0-sprint hash (so any further change is still caught). Used by the re-pointed scope tests.
// RE-POINTED by P1.4-RC3 (Claude independent QA, 23 Nov 2026): photo-ai.js changed once more on purpose (fix A1, note matching);
// the fixture keeps Grok's P1.4-RC2 hash as "p14rc2" and pins the new one as "sprint". The two server files are unchanged.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
function checkRc2PinsWithSprint(root) {
// RE-POINTED R1-R8 (24 Nov 2026): src/data/hyrox-data.js hash is pinned in fixtures/garmin-r-pins.json; other RC2 pins unchanged.
  const PINS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rc2-unchanged-pins.json'), 'utf8'));
  const SPRINT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'p0-sprint-photo-pins.json'), 'utf8'));
  const GARMIN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'garmin-r-pins.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(SPRINT).sort(), ['netlify/lib/handler.mjs', 'netlify/lib/openai.mjs', 'src/ai/photo-ai.js']);
  Object.keys(PINS).forEach((f) => {
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');
    if (SPRINT[f]) { assert.strictEqual(SPRINT[f].rc2, PINS[f], f + ' (documented RC2 hash)'); if (SPRINT[f].p14rc2) assert.match(SPRINT[f].p14rc2, /^[0-9a-f]{64}$/); assert.strictEqual(got, SPRINT[f].sprint, f + ' (P0 sprint hash)'); }
    else if (GARMIN[f]) { assert.strictEqual(got, GARMIN[f], f + ' (R1-R8 pin; was RC2 ' + PINS[f] + ')'); }
    else assert.strictEqual(got, PINS[f], f);
  });
  return Object.keys(PINS).length;
}
module.exports = { checkRc2PinsWithSprint };
