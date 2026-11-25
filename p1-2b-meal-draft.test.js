'use strict';
// Sprint B2 (owner decision M1, 23 Nov 2026): unsaved MEAL draft in the UI-only key hyrox.ui.meal-draft. Source-level and pure
// checks (the browser behaviour is in tests/e2e/p1-2b-meal-draft.spec.js). Synthetic data only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const ext = rd('src/ui/app-ext.js');

function fnSource(name) {
  const i = ext.indexOf('  function ' + name + '(');
  assert.ok(i !== -1, 'missing function ' + name);
  const j = ext.indexOf('\n  function ', i + 10);
  return ext.slice(i, j);
}

test('B2: the meal draft uses exactly the owner-approved UI key, bounded at 200000 characters', () => {
  assert.match(ext, /var MEAL_DRAFT_KEY = 'hyrox\.ui\.meal-draft', MEAL_DRAFT_MAX_CHARS = 200000;/);
  assert.match(fnSource('saveMealDraft'), /txt\.length > MEAL_DRAFT_MAX_CHARS/);
  assert.match(fnSource('loadMealDraft'), /raw\.length > MEAL_DRAFT_MAX_CHARS\) return \{ invalid: true \}/);
});

test('B2: the data layer, backups and restore never know the draft key (hyrox.v1 and data version 2 untouched)', () => {
  for (const f of ['src/data/hyrox-data.js', 'src/data/hyrox-nutrition.js', 'src/data/hyrox-coach-export.js', 'src/ui/app.js']) assert.doesNotMatch(rd(f), /meal-draft/, f);
  assert.match(rd('src/data/hyrox-data.js'), /VERSION = 2/);
});

test('B2: the sanitiser drops photo fields and data:/blob: URLs and removes stored secrets from text', () => {
  const MD_DROP_KEYS = eval('(' + /var MD_DROP_KEYS = (\{[^;]*\});/.exec(ext)[1] + ')');
  // eslint-disable-next-line no-new-func
  const mdSanitize = new Function('MD_DROP_KEYS', fnSource('mdSanitize') + '; return mdSanitize;')(MD_DROP_KEYS);
  const input = { date: '2026-11-18', description: 'my code OWNER-SYNTH-1234 oops', photos: [{ image: 'data:image/jpeg;base64,/9j/AAAA' }], image: 'x', url: 'blob:http://x/1',
    components: [{ name: 'Rice', portion: 'data:image/png;base64,AAAA', kcal: { value: 200, state: 'ESTIMATED' }, provenance: { dataUrl: 'data:x', grams: 150 } }], ai: { acks: [{ text: 'coffee' }], apiKey: 'sk-x', token: 't' }, n: NaN };
  const out = mdSanitize(input, ['OWNER-SYNTH-1234'], 0);
  const s = JSON.stringify(out);
  assert.doesNotMatch(s, /data:|blob:|base64|OWNER-SYNTH-1234|sk-x|"photos"|"image"|"apiKey"|"token"|"dataUrl"/);
  assert.strictEqual(out.description, 'my code [removed] oops');
  assert.strictEqual(out.components[0].portion, '');
  assert.deepStrictEqual(out.components[0].provenance, { grams: 150 });
  assert.deepStrictEqual(out.ai.acks, [{ text: 'coffee' }]);
  assert.strictEqual(out.n, null);
});

test('B2: the draft is cleared only by a verified save or an explicit Discard', () => {
  const calls = ext.split('\n').filter((l) => /clearMealDraft\(/.test(l) && !/function clearMealDraft/.test(l)).map((l) => l.trim().slice(0, 90));
  assert.strictEqual(calls.length, 4, calls.join('\n'));
  const save = ext.slice(ext.indexOf('var res = persist(\'meals\', rec, err);'), ext.indexOf('resetMealDraft(ms.id ? \'MANUAL\' : nextPath);'));
  assert.match(save, /if \(res\.ok\) \{[\s\S]*clearMealDraft\(true\)/); // only inside the verified-save branch
  assert.match(ext, /onYes: function \(\) \{ if \(!keepStored\) clearMealDraft\(true\); proceed\(\); \}/); // the explicit Discard dialog
  assert.match(fnSource('mealDraftNote'), /discard-yes', onclick: function \(\) \{\s*clearMealDraft\(false\)/); // "Yes, discard it"
  assert.match(fnSource('mealConflict'), /load-saved', onclick: function \(\) \{\s*clearMealDraft\(true\)/); // explicit "Load the saved version"
  // nothing on reload / navigation: the init code only reads it
  assert.doesNotMatch(ext.slice(ext.indexOf('Sprint B2 (owner M1): keep an unfinished meal')), /clearMealDraft|removeItem\(MEAL_DRAFT_KEY\)/);
});

test('B2: a stored draft is restored only by an explicit Resume (never at start-up)', () => {
  const init = ext.slice(ext.indexOf('Sprint B2 (owner M1): keep an unfinished meal'));
  assert.doesNotMatch(init, /resumeMealDraft\(|ms = /);
  const calls = ext.split('\n').filter((l) => /resumeMealDraft\(/.test(l) && !/function resumeMealDraft/.test(l));
  assert.strictEqual(calls.length, 1); assert.match(calls[0], /-resume', onclick/);
});
