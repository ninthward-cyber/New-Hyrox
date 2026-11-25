/*
 * hyrox-data.js - on-device data layer for the HYROX tracker.
 * Plain-JS UMD: classic <script> (window.HyroxData) or require() in Node.
 * No dependencies. Storage key: 'hyrox.v1'.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HyroxData = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEY = 'hyrox.v1';
  // Damaged data found under KEY is copied here, byte-for-byte, before anything
  // new is written. It is never overwritten once set.
  var RECOVERY_KEY = 'hyrox.v1.corrupt-backup';
  // Highest schema version this build reads and writes.
  //   1 = classic lists only (weight / workouts / nutrition) - what Phase 1/2 builds understand.
  //   2 = classic lists + Phase 3 collections. Older builds (64427c2 and earlier) refuse version 2
  //       both in storage ('newer') and on restore ('unsupported_version'), so they can no longer
  //       silently discard the Phase 3 collections. Data that has no Phase 3 collection stays 1.
  var VERSION = 2;
  var LEGACY_VERSION = 1;
  // Exact previous KEY text saved before an import replaces it:
  // JSON.stringify({kind:'hyrox-pre-import', savedAt, raw, restoreState}). Latest import wins, EXCEPT
  // (P5 / P4-F02) while restoreState is 'pending' (a restore did not finish verified): that copy may be
  // the only one left of the previous data, so a new restore is refused (prior_copy_unresolved).
  var BACKUP_KEY = 'hyrox.v1.pre-import-backup';
  var BACKUP_KIND = 'hyrox-pre-import';
  var APP_ID = 'hyrox-app';
  // maxBytes counts characters of the backup file. Claude P5 review: it was 2,000,000, but this build's
  // own normal export is indented JSON (about twice the stored size), so roughly eight months of daily
  // logging produced a backup this same build refused as too_large. 10,000,000 covers a pretty-printed
  // export of anything browser storage can hold (about 5 MB per site on Safari); it only bounds parsing.
  var IMPORT_LIMITS = Object.freeze({ maxBytes: 10000000, maxPerList: 10000 });
  // Emergency raw recovery file (DAWIT 2). Deliberately NOT app 'hyrox-app', so this build's
  // import and every older build refuse it as a normal backup.
  var RAW_KIND = 'hyrox-raw-recovery';
  var RAW_FORMAT = 1;
  var MAX_IMPORT_ERRORS = 20;
  var TYPES = ['weight', 'workouts', 'nutrition'];
  // Phase 3 optional collections. Stored as extra top-level arrays inside the
  // same hyrox.v1 object ONLY when used, so legacy data/backups are unchanged.
  var EXT_TYPES = ['sessions', 'meals', 'body', 'daily', 'walks', 'dayStates', 'planEvents', 'ownerSettings'];
  // (Named ownerSettings, not settings: Phase 2 data may already carry an unrelated top-level
  // 'settings' field that must keep round-tripping untouched.)
  // The single owner-settings record lives in the 'ownerSettings' list under this id.
  var SETTINGS_ID = 'app-settings';
  // Owner decision 2026-11-11: resting-HR baseline is 76 bpm until the owner changes it.
  var DEFAULT_SETTINGS = Object.freeze({ rhrBaselineBpm: 76 });

  var MSG = {
    unavailable: 'Not saved: storage is unavailable in this browser (private browsing or blocked site data).',
    unreadable: 'Not saved: your saved data could not be read, so nothing was changed. Reload and try again.',
    newer: 'Not saved: your saved data is from a newer version of this app, so nothing was changed.',
    corrupt: 'Not saved: your saved data is damaged and could not be backed up safely, so nothing was changed.',
    write: 'Could not save on this device (storage full or blocked).'
  };

  // ---------- helpers ----------

  function todayQatar(now) {
    var d = now instanceof Date ? now : (now != null ? new Date(now) : new Date());
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Qatar', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d);
    var p = {};
    parts.forEach(function (x) { p[x.type] = x.value; });
    return p.year + '-' + p.month + '-' + p.day;
  }

  function emptyData() {
    return { version: LEGACY_VERSION, weight: [], workouts: [], nutrition: [] };
  }

  // Fresh v2 document used only by applyAtomic({ allowFirstCreate: true }) when
  // readState() is 'empty' (no hyrox.v1 yet). Never used to auto-upgrade a stored schema-1 document.
  function emptyV2Data() {
    var d = { version: VERSION, weight: [], workouts: [], nutrition: [] };
    EXT_TYPES.forEach(function (t) { d[t] = []; });
    return d;
  }

  function hasExtList(data) {
    return EXT_TYPES.some(function (t) { return Array.isArray(data[t]); });
  }

  // Data holding any Phase 3 collection is stamped version 2 (never downgraded here).
  function stampVersion(data) {
    if (hasExtList(data) && !(typeof data.version === 'number' && data.version >= VERSION)) data.version = VERSION;
    return data;
  }

  function memoryStorage() {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); }
    };
  }

  function isBlank(v) {
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  }

  function toNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') return Number(v.trim());
    return NaN;
  }

  function maxOneDecimal(n) {
    return Math.abs(Math.round(n * 10) - n * 10) < 1e-9;
  }

  function newId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // ---------- field validators (each returns {value} or {error}) ----------

  // Format + real calendar date + not after `ceiling` (a YYYY-MM-DD string).
  function vDateUpTo(v, ceiling) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: 'Date must be YYYY-MM-DD.' };
    var y = +v.slice(0, 4), m = +v.slice(5, 7), d = +v.slice(8, 10);
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      return { error: 'Date is not a real calendar date.' };
    }
    if (v > ceiling) return { error: 'Date cannot be in the future.' };
    return { value: v };
  }

  function vDate(v, now) {
    return vDateUpTo(v, todayQatar(now));
  }

  function vNumber(v, opts) {
    if (isBlank(v)) return { error: opts.label + ' is required.' };
    var n = toNumber(v);
    if (!isFinite(n)) return { error: opts.label + ' must be a number.' };
    if (opts.integer && !Number.isInteger(n)) return { error: opts.label + ' must be a whole number.' };
    if (opts.oneDecimal && !maxOneDecimal(n)) return { error: opts.label + ' can have at most 1 decimal place.' };
    if (n < opts.min || n > opts.max) return { error: opts.label + ' must be between ' + opts.min + ' and ' + opts.max + '.' };
    return { value: opts.oneDecimal ? Math.round(n * 10) / 10 : n };
  }

  function vText(v, opts) {
    if (isBlank(v)) {
      if (opts.required) return { error: opts.label + ' is required.' };
      return { value: '' };
    }
    if (typeof v !== 'string') return { error: opts.label + ' must be text.' };
    var s = v.trim();
    if (s.length > opts.max) return { error: opts.label + ' must be at most ' + opts.max + ' characters.' };
    return { value: s };
  }

  function vBool(v, label) {
    if (v === undefined || v === null || v === '') return { value: false };
    if (v === true || v === 'true') return { value: true };
    if (v === false || v === 'false') return { value: false };
    return { error: label + ' must be true or false.' };
  }

  function runRules(input, rules) {
    input = input && typeof input === 'object' ? input : {};
    var out = {}, errors = {}, bad = false;
    Object.keys(rules).forEach(function (field) {
      var r = rules[field](input[field]);
      if (r.error) { errors[field] = r.error; bad = true; } else { out[field] = r.value; }
    });
    return bad ? { errors: errors } : { value: out };
  }

  // ---------- store ----------

  function isValidEntry(e) {
    return !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.date === 'string';
  }

  // Classifies non-empty stored text. Pure: never touches storage.
  //   ok      -> data keeps every stored entry and unknown field
  //   corrupt -> not a valid hyrox object;  newer -> newer schema version
  function classifyRaw(raw) {
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return { state: 'corrupt', raw: raw }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'corrupt', raw: raw };
    if (typeof parsed.version === 'number' && parsed.version > VERSION) return { state: 'newer', raw: raw };
    for (var i = 0; i < TYPES.length; i++) {
      var v = parsed[TYPES[i]];
      if (v !== undefined && v !== null && !Array.isArray(v)) return { state: 'corrupt', raw: raw };
    }
    // A Phase 3 collection that is present but is not a list is damage, exactly like a damaged
    // classic list: the raw text is kept and nothing may overwrite it without a recovery copy.
    for (i = 0; i < EXT_TYPES.length; i++) {
      var x = parsed[EXT_TYPES[i]];
      if (x !== undefined && x !== null && !Array.isArray(x)) return { state: 'corrupt', raw: raw, damagedList: EXT_TYPES[i] };
    }
    // Keep unknown top-level fields and every entry (even ones we cannot
    // display) so a later save never silently drops data.
    // defineProperty, not assignment: a stored "__proto__" key stays an ordinary own field (P4-D2).
    var data = {};
    Object.keys(parsed).forEach(function (k) {
      Object.defineProperty(data, k, { value: parsed[k], enumerable: true, writable: true, configurable: true });
    });
    if (data.version === undefined) data.version = LEGACY_VERSION;
    TYPES.forEach(function (t) { data[t] = Array.isArray(parsed[t]) ? parsed[t].slice() : []; });
    return { state: 'ok', data: data, raw: raw };
  }

  // ---------- import validation (pure: never touches storage) ----------
  // Import never coerces: numbers must be numbers, booleans must be booleans,
  // text is kept exactly as written. Entries are rebuilt from known fields only.

  var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

  function isIsoTimestamp(v) {
    return typeof v === 'string' && ISO_RE.test(v) && !isNaN(new Date(v).getTime());
  }

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function iNumber(opts) {
    return function (v) {
      if (v === undefined || v === null) return { error: opts.label + ' is required.' };
      if (typeof v !== 'number' || !isFinite(v)) return { error: opts.label + ' must be a number.' };
      if (opts.integer && !Number.isInteger(v)) return { error: opts.label + ' must be a whole number.' };
      if (opts.oneDecimal && !maxOneDecimal(v)) return { error: opts.label + ' can have at most 1 decimal place.' };
      if (v < opts.min || v > opts.max) return { error: opts.label + ' must be between ' + opts.min + ' and ' + opts.max + '.' };
      return { value: v };
    };
  }

  function iText(opts) {
    return function (v) {
      if (v === undefined || v === null) {
        return opts.required ? { error: opts.label + ' is required.' } : { value: '' };
      }
      if (typeof v !== 'string') return { error: opts.label + ' must be text.' };
      if (opts.required && v.trim() === '') return { error: opts.label + ' is required.' };
      if (v.length > opts.max) return { error: opts.label + ' must be at most ' + opts.max + ' characters.' };
      return { value: v };
    };
  }

  function iBool(label) {
    return function (v) {
      if (v === undefined || v === null) return { value: false };
      if (typeof v !== 'boolean') return { error: label + ' must be true or false.' };
      return { value: v };
    };
  }

  function iId(v) {
    if (typeof v !== 'string' || v.length < 1 || v.length > 64) return { error: 'Id must be text of 1 to 64 characters.' };
    return { value: v };
  }

  function iCreatedAt(v) {
    if (!isIsoTimestamp(v)) return { error: 'createdAt must be an ISO date-time.' };
    return { value: v };
  }

  // Field order here is the stored field order (matches add*).
  function importRules(ceiling) {
    var date = function (v) { return vDateUpTo(v, ceiling); };
    return {
      weight: [['id', iId], ['createdAt', iCreatedAt], ['date', date],
        ['kg', iNumber({ label: 'Weight', min: 20, max: 400, oneDecimal: true })]],
      workouts: [['id', iId], ['createdAt', iCreatedAt], ['date', date],
        ['activity', iText({ label: 'Activity', max: 60, required: true })],
        ['durationMin', iNumber({ label: 'Duration', min: 1, max: 600, integer: true })],
        ['partial', iBool('Partial')],
        ['notes', iText({ label: 'Notes', max: 500 })]],
      nutrition: [['id', iId], ['createdAt', iCreatedAt], ['date', date],
        ['label', iText({ label: 'Label', max: 60 })],
        ['calories', iNumber({ label: 'Calories', min: 0, max: 10000, integer: true })],
        ['proteinG', iNumber({ label: 'Protein', min: 0, max: 1000, oneDecimal: true })]]
    };
  }

  // ---------- Phase 3 extension record validation (pure) ----------
  // Returns an array of {field, message}. Empty array = valid. Unknown fields
  // are kept (not rejected) so later versions round-trip through this one.
  var ENUMS = {
    status: ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'PARTIAL', 'SKIPPED'],
    variant: ['ORIGINAL_60', 'SOURCE_45_MIN', 'SOURCE_25_MIN', 'OTHER_EXECUTION', 'NONE'],
    blockKind: ['run', 'walk', 'sled_push', 'sled_pull', 'skierg', 'row', 'bike', 'elliptical', 'farmer_carry',
      'lunges', 'wall_balls', 'burpee_broad_jumps', 'strength_set', 'rest', 'warmup', 'cooldown', 'mobility', 'other'],
    omission: ['MISSED_MONDAY_CASCADE', 'MISSED_WEDNESDAY_CASCADE'],
    lifecycle: ['DRAFT', 'NEEDS_REVIEW', 'CONSUMED_INTENT', 'CONFIRMED'],
    mealSource: ['MANUAL', 'DESCRIPTION', 'PHOTO_AI', 'COPY'],
    role: ['MAIN', 'SIDE', 'OIL', 'SAUCE', 'DRINK', 'CONDIMENT', 'OTHER'],
    macroState: ['KNOWN', 'ESTIMATED', 'UNKNOWN'],
    obsState: ['OBSERVED', 'MISSING', 'DECLINED', 'NOT_TRACKED', 'INVALID'],
    attestation: ['COMPLETE', 'INCOMPLETE'],
    planEvent: ['MISSED_MONDAY', 'MISSED_WEDNESDAY'],
    // Owner rule 4: what the owner chose when explicitly skipping a planned session.
    skipDecision: ['RESCHEDULE', 'SKIP_PERMANENT', 'ADJUST_WEEK'],
    // Owner rule 3: the owner's answer to "intentional fast, or food not logged?".
    fastAnswer: ['CONFIRMED_FULL_DAY_FAST', 'NOT_LOGGED'],
    stepBaselineMode: ['AUTO', 'MANUAL'],
    // How a recorded step count was obtained. There is deliberately no "estimated" value:
    // steps are never derived from distance, duration or pace.
    stepsSource: ['DEVICE', 'MANUAL'],
    metric: ['waist_cm'],
    // Round 2 (owner decision 3): which HNC-BASE v2.1 section 9 prescription a session follows.
    variantKind: ['ORIGINAL', 'MAIN_LIFT_45', 'MAIN_CIRCUIT_45', 'STRENGTH_25', 'HYROX_25'],
    // Round 2 (owner decision 2): the owner's own statement of how hard a session was.
    // Phase 8: MODERATE added between the two (additive; every older value is unchanged and still valid).
    intensity: ['EASY', 'MODERATE', 'DEMANDING'],
    blockSourceStatus: ['SOURCE', 'UNSPECIFIED']
  };
  // variant -> prescribed minutes / allowed variantKind values (v2.1 section 9).
  var VARIANT_MINUTES = { ORIGINAL_60: 60, SOURCE_45_MIN: 45, SOURCE_25_MIN: 25 };
  var VARIANT_KINDS = { ORIGINAL_60: ['ORIGINAL'], SOURCE_45_MIN: ['MAIN_LIFT_45', 'MAIN_CIRCUIT_45'], SOURCE_25_MIN: ['STRENGTH_25', 'HYROX_25'] };
  var STRENGTH_KINDS = ['MAIN_LIFT_45', 'STRENGTH_25'], HYROX_KINDS = ['MAIN_CIRCUIT_45', 'HYROX_25'];
  // Owner-configurable adaptive-step suggestion settings (app defaults, NOT from v2.1): [min, max].
  var STEP_RULE_SETTINGS = { stepLightDayPct: [0, 30], stepAfterDemandingPct: [-50, 0], stepHighFatiguePct: [-70, 0],
    stepHistoryDays: [7, 28], stepMinObservations: [3, 28] };
  var MACROS = ['kcal', 'proteinG', 'carbsG', 'fatG'];
  var MACRO_MAX = { kcal: 10000, proteinG: 1000, carbsG: 2000, fatG: 1000 };
  var DAILY_FIELDS = { steps: [0, 200000], sleepH: [0, 24], sleepQuality: [1, 10], soreness: [0, 10],
    pain: [0, 10], readiness: [1, 10], rhr: [25, 220],
    // Round 2: v2.1 section 6 10k readiness check (first-step heel/arch/Achilles pain; stair knee pain).
    footPain: [0, 10], stairKneePain: [0, 10] };

  function isNumIn(v, min, max) { return typeof v === 'number' && isFinite(v) && v >= min && v <= max; }
  function optNum(errs, o, k, min, max, label) {
    if (o[k] === undefined || o[k] === null) return;
    if (!isNumIn(o[k], min, max)) errs.push({ field: k, message: (label || k) + ' must be empty or a number from ' + min + ' to ' + max + '.', rule: 'must be empty or a number from ' + min + ' to ' + max });
  }
  function optText(errs, o, k, max) {
    if (o[k] === undefined || o[k] === null) return;
    if (typeof o[k] !== 'string' || o[k].length > max) errs.push({ field: k, message: k + ' must be text up to ' + max + ' characters.' });
  }
  function inEnum(errs, o, k, list, required) {
    if (!required && (o[k] === undefined || o[k] === null)) return;
    if (list.indexOf(o[k]) === -1) errs.push({ field: k, message: k + ' must be one of ' + list.join(', ') + '.' });
  }

  // Optional recorded step count + its required source. Whole number 0..200000 or null/absent.
  function vRecordedSteps(errs, o, k, srcKey, label) {
    var v = o[k], src = o[srcKey];
    if (v === undefined || v === null) {
      if (src !== undefined && src !== null) errs.push({ field: srcKey, message: srcKey + ' is only allowed with a recorded ' + k + ' value.' });
      return;
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 200000) {
      errs.push({ field: k, message: label + ' must be empty or a whole number from 0 to 200000.', rule: 'must be empty or a whole number 0..200000', code: 'WHOLE_NUMBER_0_200000' });
    }
    if (ENUMS.stepsSource.indexOf(src) === -1) errs.push({ field: srcKey, message: label + ' need a source: DEVICE or MANUAL.' });
  }

  // Path of the first NaN/Infinity number inside v, '' for v itself, or null when none.
  function nonFinitePath(v, path, depth) {
    if (typeof v === 'number') return isFinite(v) ? null : path;
    if (depth > 8 || !v || typeof v !== 'object') return null;
    var keys = Object.keys(v);
    for (var i = 0; i < keys.length; i++) {
      var r = nonFinitePath(v[keys[i]], Array.isArray(v) ? path + '[' + keys[i] + ']' : (path ? path + '.' : '') + keys[i], depth + 1);
      if (r !== null) return r;
    }
    return null;
  }

  // No image bytes may ever be stored or exported.
  function containsImageBytes(v, depth) {
    if (depth > 8) return true;
    if (typeof v === 'string') return /^data:/i.test(v) || v.length > 4000;
    if (Array.isArray(v)) return v.some(function (x) { return containsImageBytes(x, depth + 1); });
    if (v && typeof v === 'object') return Object.keys(v).some(function (k) { return containsImageBytes(v[k], depth + 1); });
    return false;
  }

  // ---------- P7: meal component provenance (the optional USDA source note of an estimated component) ----------
  // What hyrox-foodcalc.js toComponents() writes: {source, dataset, fdcId, description, portion, grams, dbVersion}.
  // Rules (owner decision P6-1): it must be a plain record; every KNOWN field has a type and a length/range limit;
  // `source` and `fdcId` are required (a note that cannot name its source is not a source note); the optional
  // marker fields `carbsClampedToZero` (true) and `note` (text) are known, so a USDA negative carbohydrate that was
  // counted as 0 g can be recorded and restored. UNKNOWN keys are never dropped: they are kept exactly as written,
  // but only a few, with a safe name and a short scalar value. Anything else is refused (nothing is changed) with the
  // path of the offending value. Total size is bounded. Pure: never touches storage.
  var PROV_KNOWN = {
    source: { type: 'text', min: 1, max: 40, required: true },
    dataset: { type: 'text', min: 1, max: 20 },
    fdcId: { type: 'int', min: 1, max: 2147483647, required: true },
    description: { type: 'text', min: 0, max: 200 },
    portion: { type: 'text', min: 0, max: 200 },
    grams: { type: 'num', min: 0, max: 1000000000, exclusiveMin: true },
    dbVersion: { type: 'text', min: 1, max: 80 },
    carbsClampedToZero: { type: 'true' },
    note: { type: 'text', min: 0, max: 300 }
  };
  var PROV_MAX_UNKNOWN_KEYS = 6, PROV_UNKNOWN_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/, PROV_UNKNOWN_TEXT_MAX = 200;
  var PROV_MAX_JSON = 2048, PROV_FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

  function vProvenance(errs, prov, path) {
    if (prov === undefined || prov === null) return;   // optional: older backups and ordinary meals have none
    function bad(sub, what, rule) {
      var at = sub ? path + '.' + sub : path;
      errs.push({ field: at, message: at + ' ' + what + '.', path: at, rule: rule, code: 'INVALID_PROVENANCE' });
    }
    if (typeof prov !== 'object' || Array.isArray(prov)) { bad('', 'must be a record (an object) or left out', 'must be a record (an object) or absent'); return; }
    var keys = Object.keys(prov), unknown = 0, shapeOk = true, i;
    for (i = 0; i < keys.length; i++) {
      var k = keys[i], v = prov[k];
      if (PROV_FORBIDDEN_KEYS.indexOf(k) !== -1) { bad(k, 'uses a reserved name that is not allowed', 'must not use the reserved name "' + k + '"'); shapeOk = false; continue; }
      var d = hasOwn(PROV_KNOWN, k) ? PROV_KNOWN[k] : null;
      if (!d) {
        unknown++;
        if (!PROV_UNKNOWN_NAME_RE.test(k)) { bad(k.length > 40 ? k.slice(0, 40) + '…' : k, 'has a field name that is not allowed (letters, digits and _ only, up to 40 characters)', 'must have a plain field name (letters, digits, _; at most 40 characters)'); shapeOk = false; continue; }
        if (!(typeof v === 'string' ? v.length <= PROV_UNKNOWN_TEXT_MAX : (typeof v === 'number' ? isFinite(v) : (typeof v === 'boolean' || v === null)))) {
          bad(k, 'is an extra field whose value must be short text (up to ' + PROV_UNKNOWN_TEXT_MAX + ' characters), a number, true/false or empty', 'must be short text, a number, true/false or empty'); shapeOk = false;
        }
        continue;
      }
      if (d.type === 'text') {
        if (typeof v !== 'string') { bad(k, 'must be text', 'must be text'); shapeOk = false; }
        else if (v.length > d.max || v.length < d.min) { bad(k, 'must be text of ' + (d.min ? d.min + ' to ' : 'up to ') + d.max + ' characters', 'must be text of ' + (d.min ? d.min + ' to ' : 'up to ') + d.max + ' characters'); shapeOk = false; }
      } else if (d.type === 'int') {
        if (typeof v !== 'number' || !isFinite(v) || !Number.isInteger(v)) { bad(k, 'must be a whole number', 'must be a whole number'); shapeOk = false; }
        else if (v < d.min || v > d.max) { bad(k, 'must be a whole number from ' + d.min + ' to ' + d.max, 'must be a whole number from ' + d.min + ' to ' + d.max); shapeOk = false; }
      } else if (d.type === 'num') {
        if (typeof v !== 'number' || !isFinite(v)) { bad(k, 'must be a number', 'must be a number'); shapeOk = false; }
        else if (v < d.min || v > d.max || (d.exclusiveMin && v === d.min)) { bad(k, 'must be a number above ' + d.min + ' and up to ' + d.max, 'must be a number above ' + d.min + ' and up to ' + d.max); shapeOk = false; }
      } else if (d.type === 'true') {
        if (v !== true) { bad(k, 'must be true when present', 'must be true when present'); shapeOk = false; }
      }
    }
    Object.keys(PROV_KNOWN).forEach(function (k) {
      if (PROV_KNOWN[k].required && !hasOwn(prov, k)) { bad(k, 'is required', 'is required in a source note'); shapeOk = false; }
    });
    if (unknown > PROV_MAX_UNKNOWN_KEYS) { bad('', 'has more than ' + PROV_MAX_UNKNOWN_KEYS + ' extra fields', 'must have at most ' + PROV_MAX_UNKNOWN_KEYS + ' extra fields'); shapeOk = false; }
    if (shapeOk) {   // only plain scalars are left, so this cannot throw or recurse
      var size = JSON.stringify(prov).length;
      if (size > PROV_MAX_JSON) bad('', 'is too large (' + size + ' characters; at most ' + PROV_MAX_JSON + ')', 'must be at most ' + PROV_MAX_JSON + ' characters in total');
    }
  }

  function vMacro(errs, m, path) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) { errs.push({ field: path, message: path + ' must be {value, state}.' }); return; }
    if (ENUMS.macroState.indexOf(m.state) === -1) { errs.push({ field: path, message: path + '.state must be KNOWN, ESTIMATED or UNKNOWN.', path: path + '.state', rule: 'must be KNOWN, ESTIMATED or UNKNOWN' }); return; }
    var key = path.split('.').pop();
    if (m.state === 'UNKNOWN') {
      if (m.value !== null) errs.push({ field: path, message: path + ': UNKNOWN must have value null (unknown is not 0).', path: path + '.value', rule: 'must be null when the state is UNKNOWN (unknown is not 0)' });
    } else if (!isNumIn(m.value, 0, MACRO_MAX[key])) {
      errs.push({ field: path, message: path + ': ' + m.state + ' needs a number from 0 to ' + MACRO_MAX[key] + '.', path: path + '.value', rule: 'must be a number from 0 to ' + MACRO_MAX[key] });
    }
  }

  // `p` (optional) is the real field path prefix used in import refusal details; defaults to `path`.
  function vObs(errs, o, path, range, p) {
    p = p === undefined ? path + '.' : p;
    if (!o || typeof o !== 'object' || Array.isArray(o)) { errs.push({ field: path, message: path + ' must be {state, value}.', path: p ? p.slice(0, -1) : 'entry', rule: 'must be {state, value}' }); return; }
    if (ENUMS.obsState.indexOf(o.state) === -1) { errs.push({ field: path, message: path + '.state is invalid.', path: p + 'state', rule: 'must be one of ' + ENUMS.obsState.join(', ') }); return; }
    if (o.state === 'OBSERVED') {
      if (!isNumIn(o.value, range[0], range[1])) errs.push({ field: path, message: path + ' must be a number from ' + range[0] + ' to ' + range[1] + '.', path: p + 'value', rule: 'must be a number from ' + range[0] + ' to ' + range[1] });
    } else if (o.value !== null && o.value !== undefined) {
      errs.push({ field: path, message: path + ': only OBSERVED values may hold a number.', path: p + 'value', rule: 'must be null unless the state is OBSERVED' });
    }
  }

  // Like vObs, but an OBSERVED value must be true/false (e.g. "limp this morning").
  function vObsBool(errs, o, path) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) { errs.push({ field: path, message: path + ' must be {state, value}.', rule: 'must be {state, value}' }); return; }
    if (ENUMS.obsState.indexOf(o.state) === -1) { errs.push({ field: path, message: path + '.state is invalid.', path: path + '.state', rule: 'must be one of ' + ENUMS.obsState.join(', ') }); return; }
    if (o.state === 'OBSERVED') {
      if (typeof o.value !== 'boolean') errs.push({ field: path, message: path + ' must be true or false.', path: path + '.value', rule: 'must be true or false' });
    } else if (o.value !== null && o.value !== undefined) {
      errs.push({ field: path, message: path + ': only OBSERVED values may hold a value.', path: path + '.value', rule: 'must be null unless the state is OBSERVED' });
    }
  }

  // v2.1 slot id -> 'STRENGTH' | 'HYROX' | null (no dependency on hyrox-plan.js).
  function slotFamily(id) {
    var m = typeof id === 'string' ? /^v2\.1-W[1-4]-(MON|TUE|WED|THU|FRI)$/.exec(id) : null;
    if (!m) return null;
    return m[1] === 'MON' || m[1] === 'WED' ? 'STRENGTH' : 'HYROX';
  }

  // Round 2 variant fields. All optional so older sessions stay valid.
  function vVariantFields(e, errs) {
    if (e.intensity != null) inEnum(errs, e, 'intensity', ENUMS.intensity, true);
    if (e.prescribedDurationMin != null) {
      var want = VARIANT_MINUTES[e.variant];
      if (want === undefined) errs.push({ field: 'prescribedDurationMin', message: 'A prescribed duration is only allowed with ORIGINAL_60, SOURCE_45_MIN or SOURCE_25_MIN.' });
      else if (e.prescribedDurationMin !== want) errs.push({ field: 'prescribedDurationMin', message: e.variant + ' is prescribed as ' + want + ' min.' });
    }
    if (e.variantKind != null) {
      inEnum(errs, e, 'variantKind', ENUMS.variantKind, true);
      var allowed = VARIANT_KINDS[e.variant];
      if (ENUMS.variantKind.indexOf(e.variantKind) !== -1) {
        if (!allowed || allowed.indexOf(e.variantKind) === -1) errs.push({ field: 'variantKind', message: e.variantKind + ' does not match variant ' + e.variant + '.' });
        var fam = slotFamily(e.planSlotId);
        if (fam === 'STRENGTH' && HYROX_KINDS.indexOf(e.variantKind) !== -1) errs.push({ field: 'variantKind', message: 'A HYROX fallback cannot be logged against a planned strength session.' });
        if (fam === 'HYROX' && STRENGTH_KINDS.indexOf(e.variantKind) !== -1) errs.push({ field: 'variantKind', message: 'A strength fallback cannot be logged against a planned HYROX session.' });
      }
    }
  }

  var EXT_VALIDATORS = {
    sessions: function (e, errs) {
      inEnum(errs, e, 'status', ENUMS.status, true);
      if (typeof e.modified !== 'boolean') errs.push({ field: 'modified', message: 'modified must be true or false.' });
      inEnum(errs, e, 'variant', ENUMS.variant, true);
      optText(errs, e, 'title', 80); optText(errs, e, 'notes', 2000); optText(errs, e, 'planSlotId', 40);
      optText(errs, e, 'planVersion', 20);
      if (e.status === 'SKIPPED' && e.skipConfirmed !== true) errs.push({ field: 'skipConfirmed', message: 'SKIPPED needs explicit user confirmation.' });
      if (e.sourceOmission !== undefined && e.sourceOmission !== null) inEnum(errs, e, 'sourceOmission', ENUMS.omission, true);
      optNum(errs, e, 'durationMin', 0, 600, 'Total duration (min)'); optNum(errs, e, 'rpe', 1, 10, 'Session RPE');
      // Skip decision is recorded separately from the original planned slot (planSlotId / scheduledDate never change).
      if (e.skipDecision !== undefined && e.skipDecision !== null) {
        inEnum(errs, e, 'skipDecision', ENUMS.skipDecision, true);
        if (e.status !== 'SKIPPED') errs.push({ field: 'skipDecision', message: 'Only a SKIPPED session can carry a skip decision.' });
      }
      if (e.skipDecision === 'RESCHEDULE') {
        if (vDateUpTo(e.rescheduledTo, '9999-12-31').error) errs.push({ field: 'rescheduledTo', message: 'Rescheduling needs a real date (YYYY-MM-DD).' });
      } else if (e.rescheduledTo !== undefined && e.rescheduledTo !== null) {
        errs.push({ field: 'rescheduledTo', message: 'rescheduledTo is only allowed with the RESCHEDULE decision.' });
      }
      // Owner step rule: running steps recorded for this session. null/absent = not recorded (never 0).
      vRecordedSteps(errs, e, 'runSteps', 'runStepsSource', 'Running steps');
      vVariantFields(e, errs);
      if (typeof e.runSteps === 'number' && ['IN_PROGRESS', 'COMPLETED', 'PARTIAL'].indexOf(e.status) === -1) {
        errs.push({ field: 'runSteps', message: 'Running steps can only be recorded on a started, partial or completed session.' });
      }
      if (!Array.isArray(e.blocks) || e.blocks.length > 200) { errs.push({ field: 'blocks', message: 'blocks must be a list (max 200).' }); return; }
      e.blocks.forEach(function (b, i) {
        var p = 'blocks[' + i + ']';
        if (!b || typeof b !== 'object' || Array.isArray(b)) { errs.push({ field: p, message: p + ' is not a record.' }); return; }
        if (ENUMS.blockKind.indexOf(b.kind) === -1) errs.push({ field: p + '.kind', message: p + '.kind is invalid.' });
        ['durationSec', 'distanceM', 'loadKg', 'reps', 'sets', 'rpe', 'count', 'prescribedSets', 'prescribedDurationSec'].forEach(function (k) {
          var lim = { durationSec: 36000, distanceM: 100000, loadKg: 1000, reps: 1000, sets: 100, rpe: 10, count: 10000, prescribedSets: 100, prescribedDurationSec: 36000 }[k];
          if (b[k] !== undefined && b[k] !== null && !isNumIn(b[k], k === 'rpe' ? 1 : 0, lim)) errs.push({ field: p + '.' + k, message: p + '.' + k + ' must be empty or 0–' + lim + '.' });
        });
        optText(errs, b, 'exercise', 80); optText(errs, b, 'notes', 500); optText(errs, b, 'equipment', 80);
        if (b.setType != null && ['WARMUP', 'WORKING'].indexOf(b.setType) === -1) errs.push({ field: p + '.setType', message: p + '.setType must be WARMUP or WORKING.' });
        if (b.omitted != null && typeof b.omitted !== 'boolean') errs.push({ field: p + '.omitted', message: p + '.omitted must be boolean.' });
        if (b.optional != null && typeof b.optional !== 'boolean') errs.push({ field: p + '.optional', message: p + '.optional must be boolean.' });
        if (b.sourceStatus != null && ENUMS.blockSourceStatus.indexOf(b.sourceStatus) === -1) errs.push({ field: p + '.sourceStatus', message: p + '.sourceStatus must be SOURCE or UNSPECIFIED.' });
        if (b.stationOptions != null && (!Array.isArray(b.stationOptions) || b.stationOptions.length > 20 ||
            b.stationOptions.some(function (x) { return typeof x !== 'string' || x.length > 40; }))) errs.push({ field: p + '.stationOptions', message: p + '.stationOptions must be a short list of names.' });
      });
    },
    meals: function (e, errs) {
      inEnum(errs, e, 'lifecycle', ENUMS.lifecycle, true);
      inEnum(errs, e, 'source', ENUMS.mealSource, true);
      optText(errs, e, 'label', 80); optText(errs, e, 'description', 1000); optText(errs, e, 'time', 5);
      if (e.lifecycle === 'CONFIRMED' && !isIsoTimestamp(e.confirmedAt)) errs.push({ field: 'confirmedAt', message: 'CONFIRMED meals need confirmedAt.' });
      if (e.lifecycle !== 'CONFIRMED' && e.confirmedAt != null) errs.push({ field: 'confirmedAt', message: 'Only CONFIRMED meals may have confirmedAt.' });
      // Meal-level eaten fraction (0-1). null/absent = not stated. Components may override it.
      optNum(errs, e, 'eatenFraction', 0, 1, 'Eaten fraction');
      if (!Array.isArray(e.components) || e.components.length < 1 || e.components.length > 50) {
        errs.push({ field: 'components', message: 'A meal needs 1–50 components.' }); return;
      }
      // Owner rule 2: a photographed meal is never assumed to be eaten whole. It can only be
      // CONFIRMED once the eaten fraction is stated for the meal or for every item.
      if (e.lifecycle === 'CONFIRMED' && e.source === 'PHOTO_AI' && typeof e.eatenFraction !== 'number' &&
          e.components.some(function (c) { return !c || typeof c.eatenFraction !== 'number'; })) {
        errs.push({ field: 'eatenFraction', message: 'Say how much of the photographed meal you ate (25%, 50%, 75%, 100% or a custom amount) before confirming.' });
      }
      e.components.forEach(function (c, i) {
        var p = 'components[' + i + ']';
        if (!c || typeof c !== 'object' || Array.isArray(c)) { errs.push({ field: p, message: p + ' is not a record.' }); return; }
        if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80) errs.push({ field: p + '.name', message: p + '.name is required (max 80).' });
        inEnum(errs, c, 'role', ENUMS.role, true);
        optText(errs, c, 'portion', 80); optText(errs, c, 'preparation', 80);
        optNum(errs, c, 'eatenFraction', 0, 1);
        MACROS.forEach(function (k) { vMacro(errs, c[k], p + '.' + k); });
        if (hasOwn(c, 'provenance')) vProvenance(errs, c.provenance, p + '.provenance');
      });
      if (e.ai !== undefined && e.ai !== null) {
        if (typeof e.ai !== 'object' || ['MOCK', 'REAL'].indexOf(e.ai.mode) === -1) errs.push({ field: 'ai.mode', message: 'ai.mode must be MOCK or REAL.' });
      }
    },
    body: function (e, errs) {
      inEnum(errs, e, 'metric', ENUMS.metric, true);
      vObs(errs, { state: e.state, value: e.value }, 'value', [40, 250], '');
      optText(errs, e, 'notes', 300);
    },
    daily: function (e, errs) {
      Object.keys(DAILY_FIELDS).forEach(function (k) { if (e[k] !== undefined && e[k] !== null) vObs(errs, e[k], k, DAILY_FIELDS[k]); });
      if (e.limp !== undefined && e.limp !== null) vObsBool(errs, e.limp, 'limp');
      // F7: a recorded daily step total is a whole number (contract: integer 0..200000).
      if (e.steps && e.steps.state === 'OBSERVED' && typeof e.steps.value === 'number' && !Number.isInteger(e.steps.value)) {
        errs.push({ field: 'steps', message: 'Daily steps must be a whole number.', path: 'steps.value', rule: 'must be a whole number 0..200000', code: 'WHOLE_NUMBER_0_200000' });
      }
      // Owner rule 5: manual override of that day's step target. null/absent = no override.
      optNum(errs, e, 'stepTargetOverride', 0, 200000, 'Step target override');
      if (e.stepTargetOverride != null && !Number.isInteger(e.stepTargetOverride)) errs.push({ field: 'stepTargetOverride', message: 'Step target override must be a whole number.' });
      optText(errs, e, 'notes', 500);
    },
    walks: function (e, errs) {
      if (!isNumIn(e.durationMin, 1, 600)) errs.push({ field: 'durationMin', message: 'Walk duration must be 1–600 min.' });
      optNum(errs, e, 'distanceKm', 0, 100, 'Distance (km)'); optNum(errs, e, 'steps', 0, 200000, 'Steps'); optNum(errs, e, 'effort', 1, 10, 'Effort');
      // A walk step count is a whole number, like daily totals and session running steps. `legacy`
      // marks a rule that older builds did not enforce: new entries are refused, but a record already
      // stored or held in an older backup is kept exactly as written (never rounded, never dropped)
      // and its count is simply not used until the owner corrects it. Whether a restore should refuse
      // such backups instead is an open owner decision; restore behaviour is unchanged here.
      if (isNumIn(e.steps, 0, 200000) && !Number.isInteger(e.steps)) {
        errs.push({ field: 'steps', message: 'Walk steps must be a whole number.', path: 'steps', rule: 'must be empty or a whole number 0..200000', code: 'WHOLE_NUMBER_0_200000', legacy: true });
      }
      // Optional source for walk steps (older walks have none and stay valid).
      if (e.stepsSource !== undefined && e.stepsSource !== null) {
        inEnum(errs, e, 'stepsSource', ENUMS.stepsSource, true);
        if (typeof e.steps !== 'number') errs.push({ field: 'stepsSource', message: 'stepsSource needs a recorded step count.' });
      }
      optText(errs, e, 'notes', 300);
    },
    dayStates: function (e, errs) {
      inEnum(errs, e, 'attestation', ENUMS.attestation, true);
      if (typeof e.basis !== 'string' || e.basis.length > 4000) errs.push({ field: 'basis', message: 'basis must be text.' });
      if (e.fast !== undefined && e.fast !== null) {
        inEnum(errs, e, 'fast', ENUMS.fastAnswer, true);
        // A confirmed fast is a statement about a complete day; "not logged" can never be complete.
        if (e.fast === 'CONFIRMED_FULL_DAY_FAST' && e.attestation !== 'COMPLETE') errs.push({ field: 'fast', message: 'A confirmed full-day fast must be declared as a complete day.' });
        if (e.fast === 'NOT_LOGGED' && e.attestation !== 'INCOMPLETE') errs.push({ field: 'fast', message: '"Food not logged" must be declared as an incomplete day.' });
      }
    },
    planEvents: function (e, errs) {
      inEnum(errs, e, 'kind', ENUMS.planEvent, true);
      if (!isNumIn(e.week, 1, 4) || !Number.isInteger(e.week)) errs.push({ field: 'week', message: 'week must be 1–4.' });
    },
    ownerSettings: function (e, errs) {
      if (e.id !== SETTINGS_ID) errs.push({ field: 'id', message: 'There is exactly one settings record (' + SETTINGS_ID + ').' });
      optNum(errs, e, 'rhrBaselineBpm', DAILY_FIELDS.rhr[0], DAILY_FIELDS.rhr[1], 'Resting HR baseline');
      if (e.stepBaselineMode !== undefined && e.stepBaselineMode !== null) inEnum(errs, e, 'stepBaselineMode', ENUMS.stepBaselineMode, true);
      optNum(errs, e, 'stepBaselineManual', 0, 200000, 'Manual step baseline');
      if (e.stepBaselineManual != null && !Number.isInteger(e.stepBaselineManual)) errs.push({ field: 'stepBaselineManual', message: 'Manual step baseline must be a whole number.' });
      if (e.stepBaselineMode === 'MANUAL' && typeof e.stepBaselineManual !== 'number') errs.push({ field: 'stepBaselineManual', message: 'A manual step baseline needs a number.' });
      Object.keys(STEP_RULE_SETTINGS).forEach(function (k) {
        var r = STEP_RULE_SETTINGS[k];
        optNum(errs, e, k, r[0], r[1], k);
        if (e[k] != null && !Number.isInteger(e[k])) errs.push({ field: k, message: k + ' must be a whole number.' });
      });
    }
  };

  // True when a stored Phase 3 record passes every rule as stored.
  // (Dates are not re-checked against today here; that is an entry/import rule.)
  function isUsableExt(type, e) {
    return isValidEntry(e) && validateExtRecord(type, e, '9999-12-31').length === 0;
  }

  // ---------- stored records with a bad field (round 2 repair) ----------
  // One bad value must not make a whole record disappear. Fields listed here are independent of
  // the rest of their record, so a stored record whose ONLY problems are in such fields is still
  // shown and used, with each bad field neutralised in the copy handed to the app:
  //   'OBS'  -> {state:'INVALID', value:null}  (unknown; never a pass, never 0)
  //   'NULL' -> null                            (not recorded)
  // The stored text itself is never changed by reading. It is only replaced when the owner
  // explicitly approves a correction (putRecord/removeRecord with the approval option).
  var ISOLATABLE = {
    daily: function (f) { return DAILY_FIELDS[f] || f === 'limp' ? 'OBS' : f === 'stepTargetOverride' ? 'NULL' : null; },
    walks: function (f) { return ['steps', 'stepsSource', 'distanceKm', 'effort'].indexOf(f) !== -1 ? 'NULL' : null; }
  };
  var MAX_PROBLEMS = 10;

  function problemOf(e, x) {
    var path = typeof x.path === 'string' && x.path ? x.path : x.field;
    var sv = safeDetailValue(readPath(e, path));
    return { field: x.field, path: path, value: sv.value, valueType: sv.valueType, rule: x.rule || String(x.message).replace(/\.$/, ''), message: x.message, legacy: x.legacy === true };
  }

  // Classifies one stored Phase 3 entry. Pure.
  //   OK       -> valid as stored; view is the entry itself
  //   LEGACY   -> only rules older builds did not enforce are broken; usable copy, exported as stored
  //   SALVAGED -> only independent fields are bad; usable copy with those fields marked invalid
  //   DAMAGED  -> cannot be used safely; kept in storage, not shown, not exported
  function classifyExt(type, e) {
    if (!isValidEntry(e)) {
      var sv0 = safeDetailValue(e);
      return { kind: 'DAMAGED', view: null, problems: [{ field: 'entry', path: '', value: sv0.value, valueType: sv0.valueType, rule: 'must be a record with a text id and date', message: 'Entry is not a usable record.', legacy: false }] };
    }
    var errs = validateExtRecord(type, e, '9999-12-31');
    if (!errs.length) return { kind: 'OK', view: e, problems: [] };
    var problems = errs.slice(0, MAX_PROBLEMS).map(function (x) { return problemOf(e, x); });
    var iso = ISOLATABLE[type];
    if (iso && errs.every(function (x) { return !!iso(x.field); })) {
      var allLegacy = errs.every(function (x) { return x.legacy === true; });
      var view = JSON.parse(JSON.stringify(e)), seen = {}, orig = [];
      errs.forEach(function (x) {
        if (seen[x.field]) return;
        seen[x.field] = true;
        var raw;
        try { raw = JSON.stringify(e[x.field]); } catch (err) { raw = undefined; }
        orig.push({ field: x.field, stored: clipText(typeof raw === 'string' ? raw : '[unreadable]', 200).text, rule: x.rule || String(x.message).replace(/\.$/, '') });
        view[x.field] = iso(x.field) === 'OBS' ? { state: 'INVALID', value: null } : null;
        if (type === 'walks' && x.field === 'steps') view.stepsSource = null;
      });
      // A salvaged copy carries a note of exactly what was stored, so the normal backup keeps it too.
      if (!allLegacy) view.invalidOriginal = (Array.isArray(e.invalidOriginal) ? e.invalidOriginal.slice(-20) : []).concat(orig);
      if (validateExtRecord(type, view, '9999-12-31').length === 0) return { kind: allLegacy ? 'LEGACY' : 'SALVAGED', view: view, problems: problems };
    }
    return { kind: 'DAMAGED', view: null, problems: problems };
  }

  // The copy of a non-OK record handed to the app carries a hidden (non-enumerable) marker, so it
  // can never be written back to storage by accident: JSON cloning drops it.
  function markedView(c) {
    Object.defineProperty(c.view, '_storedDamaged', { value: { kind: c.kind, problems: c.problems }, enumerable: false });
    return c.view;
  }

  var DAMAGED_MSG = 'Not saved: the stored record for this entry has a damaged value. Review it and approve the correction first; nothing was changed.';

  function validateExtRecord(type, e, ceiling) {
    var errs = [];
    if (!e || typeof e !== 'object' || Array.isArray(e)) return [{ field: 'entry', message: 'Entry is not a valid record.', path: '', rule: 'must be a record (an object)' }];
    if (iId(e.id).error) errs.push({ field: 'id', message: 'Id must be text of 1 to 64 characters.' });
    if (!isIsoTimestamp(e.createdAt)) errs.push({ field: 'createdAt', message: 'createdAt must be an ISO date-time.' });
    if (e.updatedAt != null && !isIsoTimestamp(e.updatedAt)) errs.push({ field: 'updatedAt', message: 'updatedAt must be an ISO date-time.' });
    var d = vDateUpTo(e.date, ceiling);
    if (d.error) errs.push({ field: 'date', message: d.error });
    if (e.scheduledDate != null && vDateUpTo(e.scheduledDate, '9999-12-31').error) errs.push({ field: 'scheduledDate', message: 'scheduledDate must be YYYY-MM-DD.' });
    if (containsImageBytes(e, 0)) errs.push({ field: 'entry', message: 'Entry contains image data or an oversized text value; photos are never stored.', path: '', rule: 'must not contain image data or text over 4000 characters' });
    EXT_VALIDATORS[type](e, errs);
    return errs;
  }

  function importFail(code, message, errors) {
    return { ok: false, code: code, message: message, errors: errors || [] };
  }

  // ---------- t54u: per-record import refusal details (display only; nothing is repaired) ----------
  var DETAIL_VALUE_MAX = 120, DUP_RULE = { path: 'id', rule: 'must be unique within the collection', code: 'DUPLICATE_ID' };
  function clipText(str, max) { return str.length > max ? { text: str.slice(0, max) + '…', truncated: true } : { text: str, truncated: false }; }
  // The offending value exactly as parsed from the file, made safe to show: long text/objects are clipped.
  function safeDetailValue(v) {
    if (v === undefined) return { value: null, valueType: 'missing', valueTruncated: false };
    if (v === null) return { value: null, valueType: 'null', valueTruncated: false };
    if (typeof v === 'number') return { value: isFinite(v) ? v : String(v), valueType: 'number', valueTruncated: false };
    if (typeof v === 'boolean') return { value: v, valueType: 'boolean', valueTruncated: false };
    var t = Array.isArray(v) ? 'array' : typeof v, str;
    if (t === 'string') str = v;
    else { try { str = JSON.stringify(v); } catch (e) { str = null; } if (typeof str !== 'string') str = '[unreadable ' + t + ']'; }
    var c = clipText(str, DETAIL_VALUE_MAX);
    var out = { value: c.text, valueType: t, valueTruncated: c.truncated };
    if (c.truncated) out.valueLength = str.length;
    return out;
  }
  // Reads 'a.b[2].c' from rec without throwing; '' is rec itself.
  function readPath(rec, path) {
    if (!path) return rec;
    var parts = path.replace(/\[(\d+)\]/g, '.$1').split('.'), cur = rec;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || typeof cur !== 'object' || !hasOwn(cur, parts[i])) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }
  function refusalDetail(list, index, field, message, rec, x) {
    var isRec = rec && typeof rec === 'object' && !Array.isArray(rec);
    var path = typeof x.path === 'string' ? x.path : field;
    var id = isRec && typeof rec.id === 'string' ? clipText(rec.id, 64).text : null;
    var date = isRec && typeof rec.date === 'string' ? clipText(rec.date, 20).text : null;
    var rule = x.rule || String(message).replace(/\.$/, '');
    var code = x.code || (field === 'list' ? 'INVALID_LIST' : 'INVALID_VALUE');
    var where = index < 0 ? 'the "' + list + '" list' : list + ' record ' + (id !== null ? '"' + id + '"' : 'number ' + (index + 1)) + (date !== null ? ' (' + date + ')' : '');
    var how;
    if (code === 'WHOLE_NUMBER_0_200000') how = 'Open the backup file, change ' + path + ' in ' + where + ' to a whole number from 0 to 200000 (no decimals), save it, then restore again.';
    else if (code === 'DUPLICATE_ID') how = 'Open the backup file, remove the repeated copy of ' + where + ' or give it a different id, save it, then restore again.';
    else how = 'Open the backup file, fix ' + (path ? path + ' in ' : '') + where + ' (it ' + rule + '), save it, then restore again.';
    var d = { collection: list, index: index, id: id, date: date, field: path || field };
    var sv = safeDetailValue(path ? readPath(rec, path) : rec);
    Object.keys(sv).forEach(function (k) { d[k] = sv[k]; });
    d.rule = rule; d.code = code; d.message = message;
    d.howToCorrect = how + ' Nothing on this device was changed.';
    return d;
  }

  function countLists(data) {
    var c = {};
    TYPES.forEach(function (t) { c[t] = data[t].length; });
    return c;
  }

  // Counts of Phase 3 lists that are present; null when none are present.
  function extCounts(data) {
    var c = null;
    EXT_TYPES.forEach(function (t) {
      if (data && Array.isArray(data[t])) { c = c || {}; c[t] = data[t].length; }
    });
    return c;
  }

  function countValid(data) {
    var c = {};
    TYPES.forEach(function (t) { c[t] = data[t].filter(isValidEntry).length; });
    return c;
  }

  // Parses and fully validates an import file. Returns
  // {ok:true, data:{version,weight,workouts,nutrition}, exportedAt, warnings[]}
  // or {ok:false, code, message, errors[]}.
  // 32-bit FNV-1a over UTF-16 code units (the exact unit localStorage stores), hex.
  // An integrity check against truncation/editing, not a security hash.
  function checksum(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function isRawRecovery(o) {
    return !!o && typeof o === 'object' && !Array.isArray(o) && (o.kind === RAW_KIND || o.app === RAW_KIND);
  }

  // Pure. Reads an emergency raw recovery file and checks every copy is intact.
  // {ok:true, exportedAt, state, sources:[{key, raw, length, checksum}]} or {ok:false, code, message}.
  function parseRawRecovery(text) {
    var o;
    try { o = typeof text === 'string' ? JSON.parse(text) : null; } catch (e) { o = null; }
    if (!isRawRecovery(o) || o.format !== RAW_FORMAT || !Array.isArray(o.sources)) {
      return { ok: false, code: 'not_raw_recovery', message: 'This is not a HYROX emergency raw recovery file.' };
    }
    var out = [];
    for (var i = 0; i < o.sources.length; i++) {
      var x = o.sources[i];
      if (!x || typeof x.key !== 'string' || typeof x.raw !== 'string' || x.length !== x.raw.length || x.checksum !== checksum(x.raw)) {
        return { ok: false, code: 'damaged', message: 'This raw recovery file has been changed or is incomplete (copy ' + (i + 1) + ' does not match its checksum).' };
      }
      out.push({ key: x.key, raw: x.raw, length: x.length, checksum: x.checksum });
    }
    return { ok: true, exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : null, state: o.state || null, sources: out };
  }

  // ---------- P4: emergency-file markers (edited raw recovery copies) ----------
  // Keys only rawRecoveryExport writes (checked on the root and, since P4-D5, on any wrapper object). normalExport/omitted/omittedTotal/warning and a
  // sources-like key refuse on their own. `format` and `state` refuse only together: a genuine
  // backup fixture carries an unknown top-level `format`, and `state` alone is too generic.
  // Keys are compared after NFKC, removing zero-width/BOM/soft-hyphen, trimming and case-folding.
  // Look-alike letters (e.g. Cyrillic) are NOT folded: accepted limit P4-L1.
  var RAW_MARKERS_ALONE = { normalexport: 'normalExport', omitted: 'omitted', omittedtotal: 'omittedTotal', warning: 'warning' };
  var INVISIBLE_RE = /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g;
  function normKey(k) {
    var x = String(k);
    if (typeof x.normalize === 'function') { try { x = x.normalize('NFKC'); } catch (e) { /* keep as is */ } }
    return x.replace(INVISIBLE_RE, '').trim().toLowerCase();
  }
  function showKey(k) {
    var t = String(k);
    if (t.length > 20) t = t.slice(0, 20) + '...';
    return '"' + t.replace(/[^\x20-\x7E]|"/g, function (c) { return c === '"' ? '\\"' : '\\u' + ('000' + c.charCodeAt(0).toString(16).toUpperCase()).slice(-4); }) + '"';
  }
  function isPlainObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  // Marker rules for ONE object outside the record lists (the root or a wrapper at any depth).
  // A sources-like key, normalExport/omitted/omittedTotal/warning on their own, or format+state
  // together. Returns a short description or null.
  function wrapperMarker(o) {
    var keys = Object.keys(o), i, n, hasFormat = null, hasState = null, other = null;
    // The sources copies are the strongest marker, so they are named first when present.
    if (hasOwn(o, 'sources')) return 'a "sources" field';
    for (i = 0; i < keys.length; i++) {
      n = normKey(keys[i]);
      if (n === 'sources') return 'a field ' + showKey(keys[i]) + ' that reads as "sources"';
      if (other === null && hasOwn(RAW_MARKERS_ALONE, n)) other = keys[i];
      if (n === 'format') hasFormat = keys[i];
      if (n === 'state') hasState = keys[i];
    }
    if (other !== null) {
      n = RAW_MARKERS_ALONE[normKey(other)];
      return other === n
        ? 'a "' + other + '" field, which only emergency copies have'
        : 'a field ' + showKey(other) + ' that reads as "' + n + '", which only emergency copies have';
    }
    if (hasFormat !== null && hasState !== null) return 'both a ' + showKey(hasFormat) + ' and a ' + showKey(hasState) + ' field, which together only emergency copies have';
    return null;
  }

  // One emergency copy as rawRecoveryExport writes it into `sources`: {key, length, checksum, raw}
  // with key and raw as text. No record type in any phase has all four of these fields.
  function isEmergencyCopy(v) {
    return isPlainObj(v) && hasOwn(v, 'key') && typeof v.key === 'string' && hasOwn(v, 'raw') && typeof v.raw === 'string' &&
      hasOwn(v, 'checksum') && hasOwn(v, 'length');
  }

  // Normal exports nest at most ~6 levels (root > list > record > blocks > block > stationOptions).
  var MARKER_SCAN_MAX_DEPTH = 64;
  var TOO_DEEP = { tooDeep: true };

  // P4-D5: ONE iterative pass over the whole parsed file (objects AND arrays, any depth, no
  // recursion, cycle-safe). Returns a description of the first emergency marker found, TOO_DEEP
  // when nesting passes MARKER_SCAN_MAX_DEPTH (fails closed), or null.
  //   Everywhere (including inside Phase 3 records): an emergency copy object {key, raw, checksum, length},
  //   except an element sitting directly in an unknown top-level array (P4-L1, see below).
  //   Outside the record lists (root and any wrapper object, at any depth, also inside arrays):
  //     wrapperMarker(). Normal exports have no wrapper objects at all.
  //   Directly on a weight/workouts/nutrition entry: a sources-like key (core entries only hold rule fields).
  //   NOT inside records by name: putRecord keeps unknown fields, and real records carry `state`
  //   ({state, value}), session blocks carry `omitted`, so names there are not markers.
  function rawMarker(root) {
    if (!isPlainObj(root)) return null;
    var top = wrapperMarker(root);
    if (top) return top;
    var seen = typeof WeakSet === 'function' ? new WeakSet() : null;
    // Node: [value, depth, zone, parentNode, key]; zone 'W' wrapper, 'C' core entry, 'R' record data.
    var stack = [], rootKeys = Object.keys(root), i, k, v;
    if (seen) seen.add(root);
    for (i = rootKeys.length - 1; i >= 0; i--) {
      k = rootKeys[i]; v = root[k];
      var isCore = TYPES.indexOf(k) !== -1, isList = (isCore || EXT_TYPES.indexOf(k) !== -1) && Array.isArray(v);
      if (!isList) {
        // Elements directly in an unknown top-level array skip only the copy-shape check (names
        // are still checked): that is the P4-L1 look-alike case, e.g. a Cyrillic "sources" key
        // holding the copies, kept as an accepted limit by its characterization test.
        if (Array.isArray(v)) {
          var wrapNode = [v, 1, 'W', null, k];
          if (seen) seen.add(v);
          for (var w = v.length - 1; w >= 0; w--) stack.push([v[w], 2, 'W0', wrapNode, w]);
        } else stack.push([v, 1, 'W', null, k]);
        continue;
      }
      var listNode = [v, 1, 'R', null, k];
      for (var e = v.length - 1; e >= 0; e--) stack.push([v[e], 2, isCore ? 'C' : 'R', listNode, e]);
    }
    function pathOf(node) {
      var chain = [], t = '';
      for (var x = node; x; x = x[3]) chain.unshift(x[4]);
      for (var j = 0; j < chain.length; j++) t += typeof chain[j] === 'number' ? '[' + chain[j] + ']' : (j ? '.' : '') + String(chain[j]);
      if (t.length > 80) t = t.slice(0, 80) + '...';
      return t.replace(/[^\x20-\x7E]/g, function (c) { return '\\u' + ('000' + c.charCodeAt(0).toString(16).toUpperCase()).slice(-4); });
    }
    while (stack.length) {
      var node = stack.pop(), val = node[0], depth = node[1], zone = node[2];
      if (!val || typeof val !== 'object') continue;
      if (depth > MARKER_SCAN_MAX_DEPTH) return TOO_DEEP;
      if (seen) { if (seen.has(val)) continue; seen.add(val); }
      var childZone = zone === 'W' || zone === 'W0' ? 'W' : 'R';
      if (Array.isArray(val)) {
        for (i = val.length - 1; i >= 0; i--) if (val[i] && typeof val[i] === 'object') stack.push([val[i], depth + 1, childZone, node, i]);
        continue;
      }
      if (zone !== 'W0' && isEmergencyCopy(val)) return 'an emergency copy (key, raw, checksum, length) at ' + pathOf(node);
      var ks = Object.keys(val);
      if (zone === 'W' || zone === 'W0') {
        var m = wrapperMarker(val);
        if (m) return m + ' inside ' + pathOf(node);
      } else if (zone === 'C') {
        for (i = 0; i < ks.length; i++) {
          if (normKey(ks[i]) === 'sources') return 'a ' + showKey(ks[i]) + ' field inside ' + pathOf(node);
        }
      }
      for (i = ks.length - 1; i >= 0; i--) {
        var c = val[ks[i]];
        if (c && typeof c === 'object') stack.push([c, depth + 1, childZone, node, ks[i]]);
      }
    }
    return null;
  }

  function parseImport(text, now) {
    if (typeof text !== 'string' || text.length === 0) {
      return importFail('not_json', 'This file is empty or is not a backup file.');
    }
    if (text.length > IMPORT_LIMITS.maxBytes) {
      return importFail('too_large', 'This file is too large to be a HYROX backup (limit ' + (IMPORT_LIMITS.maxBytes / 1000000) + ' million characters, about ' + (IMPORT_LIMITS.maxBytes / 1000000) + ' MB).');
    }
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) {
      return importFail('not_json', 'This file is not valid JSON. It may be damaged or incomplete.');
    }
    if (isRawRecovery(parsed)) {
      return importFail('raw_recovery_file', 'This is an emergency raw recovery copy, not a normal backup, so it cannot be restored here. Keep it safe; nothing was changed.');
    }
    // An edited emergency copy (app relabelled / kind removed) still carries emergency-file
    // markers. No normal export (any phase) writes them, so refuse before any acceptance.
    var marker = rawMarker(parsed);
    if (marker === TOO_DEEP) {
      return importFail('raw_recovery_file', 'This file is nested too deeply (more than ' + MARKER_SCAN_MAX_DEPTH + ' levels) to be checked, so it is not a normal backup (it may be an edited emergency raw recovery copy) and cannot be restored here. Keep the original file safe; nothing was changed.');
    }
    if (marker) {
      return importFail('raw_recovery_file', 'This looks like an emergency raw recovery copy (it has ' + marker + '), not a normal backup, even if it was edited, so it cannot be restored here. Keep the original file safe; nothing was changed.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.app !== APP_ID) {
      return importFail('not_hyrox', 'This file is not a HYROX tracker backup.');
    }
    if (parsed.version !== LEGACY_VERSION && parsed.version !== VERSION) {
      return importFail('unsupported_version', 'This backup is from an unsupported app version, so it cannot be restored.');
    }
    for (var i = 0; i < TYPES.length; i++) {
      if (!Array.isArray(parsed[TYPES[i]])) {
        return importFail('not_hyrox', 'This file is not a HYROX tracker backup (the ' + TYPES[i] + ' list is missing or damaged).');
      }
    }
    for (i = 0; i < TYPES.length; i++) {
      if (parsed[TYPES[i]].length > IMPORT_LIMITS.maxPerList) {
        return importFail('too_many', 'This backup has more than ' + IMPORT_LIMITS.maxPerList + ' ' + TYPES[i] + ' entries, so it cannot be restored.');
      }
    }

    var nowDate = now instanceof Date ? now : new Date(now);
    var today = todayQatar(nowDate);
    var exportedAt = hasOwn(parsed, 'exportedAt') ? parsed.exportedAt : null;
    var ceiling = today;
    var warnings = [];
    if (exportedAt !== null && !isIsoTimestamp(exportedAt)) {
      warnings.push('This backup\'s export date is unreadable, so entries dated after today are not accepted.');
    }
    if (isIsoTimestamp(exportedAt)) {
      var exportedDay = todayQatar(new Date(exportedAt));
      if (exportedDay > ceiling) ceiling = exportedDay;
      if (new Date(exportedAt).getTime() > nowDate.getTime()) {
        warnings.push('This backup says it was exported in the future (' + exportedAt + '). Check this device\'s date and time before restoring.');
      }
    }

    var rules = importRules(ceiling);
    var errors = [], errorCount = 0, dupCount = 0, extraFields = 0, legacyCount = 0;
    var out = { version: LEGACY_VERSION, weight: [], workouts: [], nutrition: [] };
    var details = [];
    // rec: the record as stored in the file (or the list for list-level errors); x: optional {path, rule, code}.
    function addError(list, index, field, message, rec, x) {
      errorCount++;
      if (errors.length < MAX_IMPORT_ERRORS) errors.push({ list: list, index: index, field: field, message: message });
      if (details.length < MAX_IMPORT_ERRORS) details.push(refusalDetail(list, index, field, message, rec, x || {}));
    }
    TYPES.forEach(function (t) {
      var seen = Object.create(null);
      var known = Object.create(null);
      rules[t].forEach(function (r) { known[r[0]] = true; });
      parsed[t].forEach(function (e, idx) {
        if (!e || typeof e !== 'object' || Array.isArray(e)) {
          addError(t, idx, 'entry', 'Entry is not a valid record.', e, { path: '', rule: 'must be a record (an object)' });
          return;
        }
        var entry = {}, bad = false;
        rules[t].forEach(function (r) {
          var res = r[1](hasOwn(e, r[0]) ? e[r[0]] : undefined);
          if (res.error) { bad = true; addError(t, idx, r[0], res.error, e); } else { entry[r[0]] = res.value; }
        });
        Object.keys(e).forEach(function (k) { if (!known[k]) extraFields++; });
        if (!bad) {
          if (seen[entry.id]) { dupCount++; addError(t, idx, 'id', 'Duplicate id "' + entry.id + '" (also at index ' + (seen[entry.id] - 1) + ').', e, DUP_RULE); }
          else seen[entry.id] = idx + 1;
        }
        out[t].push(entry);
      });
    });
    var extPresent = [];
    EXT_TYPES.forEach(function (t) {
      if (!hasOwn(parsed, t)) return;
      if (!Array.isArray(parsed[t]) || parsed[t].length > IMPORT_LIMITS.maxPerList) {
        addError(t, -1, 'list', 'The ' + t + ' list is damaged or too long.', parsed[t], { path: '', rule: 'must be a list of at most ' + IMPORT_LIMITS.maxPerList + ' records' });
        return;
      }
      extPresent.push(t);
      var seen = Object.create(null);
      out[t] = [];
      parsed[t].forEach(function (e, idx) {
        // Rules older builds did not enforce do not refuse a restore (see the walks validator).
        var errs = validateExtRecord(t, e, ceiling).filter(function (x) { if (x.legacy === true) { legacyCount++; return false; } return true; });
        errs.forEach(function (x) { addError(t, idx, x.field, x.message, e, x); });
        if (!errs.length) {
          if (seen[e.id]) { dupCount++; addError(t, idx, 'id', 'Duplicate id "' + e.id + '".', e, DUP_RULE); }
          else seen[e.id] = true;
          out[t].push(JSON.parse(JSON.stringify(e)));
        }
      });
    });
    if (errorCount > 0) {
      var onlyDups = dupCount === errorCount;
      var fail = importFail(onlyDups ? 'duplicate_ids' : 'invalid_records',
        (onlyDups ? 'This backup has repeated entry ids' : 'This backup has ' + errorCount + ' invalid ' + (errorCount === 1 ? 'value' : 'values')) +
        ', so nothing was restored.', errors);
      fail.details = details;
      fail.detailsTotal = errorCount;
      fail.detailsTruncated = errorCount > details.length;
      return fail;
    }
    var topKnown = { app: 1, exportedAt: 1, version: 1, weight: 1, workouts: 1, nutrition: 1 };
    EXT_TYPES.forEach(function (t) { topKnown[t] = 1; });
    var extraTop = Object.keys(parsed).filter(function (k) { return !hasOwn(topKnown, k); }).length;
    stampVersion(out);
    if (legacyCount > 0) warnings.push(legacyCount + ' walk step ' + (legacyCount === 1 ? 'count is' : 'counts are') + ' not a whole number. ' + (legacyCount === 1 ? 'It' : 'They') + ' will be restored exactly as written and not counted in any step total until you correct ' + (legacyCount === 1 ? 'it' : 'them') + '.');
    if (extraFields > 0) warnings.push(extraFields + ' unknown ' + (extraFields === 1 ? 'field' : 'fields') + ' in entries will be ignored.');
    if (extraTop > 0) warnings.push(extraTop + ' unknown top-level ' + (extraTop === 1 ? 'field' : 'fields') + ' will be ignored.');
    return { ok: true, data: out, exportedAt: typeof exportedAt === 'string' ? exportedAt : null, warnings: warnings };
  }


  // R2/R4 (24 Nov 2026, Claude QA): keep garminLedger / garminLedgerBag durable across an ordinary
  // History delete of the carrier check-in. Additive on existing v2 dailies; never invent a stub daily.
  // t112 CC #4: the canonical ledger lives on owner-settings; the last Garmin day is deletable (tombstone on settings).
  function mergeGarminLedgerDoc(a, b) {
    if ((a != null && !isLedgerDoc(a)) || (b != null && !isLedgerDoc(b))) {
      var err = new Error('LEDGER_CORRUPT');
      err.code = 'LEDGER_CORRUPT';
      throw err;
    }
    var o = a ? JSON.parse(JSON.stringify(a)) : { v: 1, keys: {}, tombstones: [] };
    o.v = 1; o.keys = o.keys || {}; o.tombstones = o.tombstones || [];
    if (b && b.keys) {
      Object.keys(b.keys).forEach(function (k) {
        if (k === 'daily') o.keys.daily = b.keys.daily;
        else {
          var cur = o.keys[k] || [];
          var add = b.keys[k] || [];
          var seen = Object.create(null);
          o.keys[k] = cur.concat(add).filter(function (x) {
            var id = x && (x.timestampGMT != null ? 'w:' + x.timestampGMT : x.activityId != null ? 'a:' + x.activityId : x.localId);
            if (!id || seen[id]) return false;
            seen[id] = true;
            return true;
          });
        }
      });
    }
    if (b && b.tombstones) {
      var have = Object.create(null);
      (o.tombstones || []).forEach(function (x) {
        have[String(x.collection) + ':' + String(x.timestampGMT || x.activityId || x.localId || x.date)] = true;
      });
      (b.tombstones || []).forEach(function (x) {
        var id = String(x.collection) + ':' + String(x.timestampGMT || x.activityId || x.localId || x.date);
        if (!have[id]) { o.tombstones.push(x); have[id] = true; }
      });
    }
    if (!o.identity && b && b.identity && typeof b.identity === 'object') {
      o.identity = JSON.parse(JSON.stringify(b.identity));
    }
    if (b && b.byDate && typeof b.byDate === 'object' && !Array.isArray(b.byDate)) {
      o.byDate = o.byDate || {};
      Object.keys(b.byDate).forEach(function (dt) {
        o.byDate[dt] = mergeGarminLedgerDoc(o.byDate[dt], b.byDate[dt]);
      });
    }
    return o;
  }
  function pickGarminCarrier(daily, preferDate) {
    if (!Array.isArray(daily) || !daily.length) return null;
    var same = daily.filter(function (d) { return d && d.date === preferDate; })[0];
    if (same) return same;
    var copy = daily.slice().filter(Boolean).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    return copy[0] || null;
  }
  var LEDGER_CARRIER_MSG = 'Garmin import links are kept in your settings. Nothing was deleted.';
  var LEDGER_CORRUPT_MSG = 'The Garmin import links in your settings could not be read. Nothing was deleted. Download a backup and keep this data until it can be repaired.';
  var LEDGER_CORRUPT_APPLY_MSG = 'The Garmin import links in your settings could not be read. Nothing was changed. Download a backup and keep this data until it can be repaired.';
  var NO_TOMBSTONE_MSG = 'Log a check-in first so this delete is remembered. Nothing was deleted.';
  var DUP_ID_DELETE_MSG = 'Two saved entries share an id. Download a backup and repair them first. Nothing was deleted.';

  function countIds(list) {
    var o = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(function (e) {
      if (e && typeof e.id === 'string') o[e.id] = (o[e.id] || 0) + 1;
    });
    return o;
  }

  function isLedgerDoc(v) {
    if (v == null) return true;
    if (typeof v !== 'object' || Array.isArray(v)) return false;
    if (v.tombstones != null && !Array.isArray(v.tombstones)) return false;
    if (v.keys != null && (typeof v.keys !== 'object' || Array.isArray(v.keys))) return false;
    if (v.byDate != null && (typeof v.byDate !== 'object' || Array.isArray(v.byDate))) return false;
    if (v.byDate) {
      var k;
      for (k in v.byDate) {
        if (Object.prototype.hasOwnProperty.call(v.byDate, k) && !isLedgerDoc(v.byDate[k])) return false;
      }
    }
    return true;
  }
  function ledgerCorruptOn(rec) {
    if (!rec) return false;
    return !isLedgerDoc(rec.garminLedger) || !isLedgerDoc(rec.garminLedgerBag);
  }

  function relocateGarminLedgers(data, removed) {
    var dest = pickGarminCarrier(data.daily, removed && removed.date);
    if (!dest) return false;
    if (ledgerCorruptOn(removed) || ledgerCorruptOn(dest)) return false;
    // Same rule as attachGarminTombstone (Dawit): same-date merges into dest.garminLedger;
    // a different date goes into dest.garminLedgerBag.byDate[removed.date] so dest keys.daily is not overwritten.
    if (removed.garminLedger) {
      if (removed.date && dest.date === removed.date) {
        dest.garminLedger = mergeGarminLedgerDoc(dest.garminLedger, removed.garminLedger);
      } else {
        var dt = removed.date || dest.date;
        dest.garminLedgerBag = dest.garminLedgerBag || { v: 1, byDate: {} };
        dest.garminLedgerBag.byDate[dt] = mergeGarminLedgerDoc(dest.garminLedgerBag.byDate[dt], removed.garminLedger);
      }
    }
    if (removed.garminLedgerBag && removed.garminLedgerBag.byDate) {
      dest.garminLedgerBag = dest.garminLedgerBag || { v: 1, byDate: {} };
      Object.keys(removed.garminLedgerBag.byDate).forEach(function (bagDate) {
        dest.garminLedgerBag.byDate[bagDate] = mergeGarminLedgerDoc(dest.garminLedgerBag.byDate[bagDate], removed.garminLedgerBag.byDate[bagDate]);
      });
    }
    return true;
  }
  function pickSettingsRecord(data) {
    if (!data || !Array.isArray(data.ownerSettings)) return null;
    var hits = data.ownerSettings.filter(function (e) { return e && e.id === SETTINGS_ID; });
    return hits.length ? hits[0] : null;
  }
  function ensureSettingsCarrier(data, nowIso, today) {
    data.ownerSettings = Array.isArray(data.ownerSettings) ? data.ownerSettings : [];
    var rec = pickSettingsRecord(data);
    if (rec) return rec;
    rec = { id: SETTINGS_ID, date: today || (nowIso && String(nowIso).slice(0, 10)) || '1970-01-01', createdAt: nowIso || '1970-01-01T00:00:00.000Z' };
    data.ownerSettings.push(rec);
    return rec;
  }
  // t112 CC #4: canonical identity + deletion ledger lives on the existing owner-settings record.
  // Legacy t111u daily garminLedger / garminLedgerBag is merged in and then stripped from dailies.
  function migrateLegacyGarminLedgersToSettings(data, nowIso, today) {
    var rec = ensureSettingsCarrier(data, nowIso, today);
    rec.garminLedger = rec.garminLedger || { v: 1, keys: {}, tombstones: [] };
    (Array.isArray(data.daily) ? data.daily : []).forEach(function (d) {
      if (!d) return;
      if (d.garminLedger) {
        rec.garminLedger = mergeGarminLedgerDoc(rec.garminLedger, { identity: d.garminLedger.identity, tombstones: d.garminLedger.tombstones || [] });
        if (d.date) {
          rec.garminLedger.byDate = rec.garminLedger.byDate || {};
          rec.garminLedger.byDate[d.date] = mergeGarminLedgerDoc(rec.garminLedger.byDate[d.date], d.garminLedger);
        } else {
          rec.garminLedger = mergeGarminLedgerDoc(rec.garminLedger, d.garminLedger);
        }
        delete d.garminLedger;
      }
      if (d.garminLedgerBag && d.garminLedgerBag.byDate) {
        rec.garminLedger = mergeGarminLedgerDoc(rec.garminLedger, { byDate: d.garminLedgerBag.byDate, identity: d.garminLedgerBag.identity, tombstones: d.garminLedgerBag.tombstones || [] });
        delete d.garminLedgerBag;
      }
    });
    return rec.garminLedger;
  }
  function attachGarminLedgerToSettings(data, date, patch, nowIso, today) {
    migrateLegacyGarminLedgersToSettings(data, nowIso, today);
    var rec = ensureSettingsCarrier(data, nowIso, today);
    rec.garminLedger = mergeGarminLedgerDoc(rec.garminLedger, { identity: patch && patch.identity, tombstones: patch && patch.tombstones });
    if (date) {
      rec.garminLedger.byDate = rec.garminLedger.byDate || {};
      rec.garminLedger.byDate[date] = mergeGarminLedgerDoc(rec.garminLedger.byDate[date], patch);
    } else if (patch) {
      rec.garminLedger = mergeGarminLedgerDoc(rec.garminLedger, patch);
    }
    return rec.garminLedger;
  }
  function dailyIsGarminLinked(data, rec) {
    if (!rec) return false;
    if (rec.garminLedger || rec.garminLedgerBag) return true;
    var srcFields = ['steps', 'intensityMin', 'sleepH'];
    if (srcFields.some(function (k) { return rec[k] && rec[k].source === 'GARMIN_PERSONAL_API'; })) return true;
    var led = (pickSettingsRecord(data) || {}).garminLedger;
    if (!led) return false;
    if (led.keys && led.keys.daily && (led.keys.daily.calendarDate === rec.date || led.keys.daily.localId === rec.id)) return true;
    var bag = led.byDate && rec.date && led.byDate[rec.date];
    if (bag && bag.keys && bag.keys.daily) return true;
    return false;
  }
  function attachGarminTombstone(data, tomb) {
    // t112 CC #4: tombstones go to the owner-settings ledger so the last daily can be deleted.
    if (!tomb) return false;
    attachGarminLedgerToSettings(data, tomb.date || null, { tombstones: [tomb] });
    return true;
  }
  function validateCoreRecord(type, rec, ceiling) {
    var rules = importRules(ceiling)[type];
    if (!rules) return ['Unknown record type.'];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return ['Entry is not a valid record.'];
    var errs = [];
    rules.forEach(function (r) {
      var res = r[1](hasOwn(rec, r[0]) ? rec[r[0]] : undefined);
      if (res.error) errs.push(r[0] + ': ' + res.error);
    });
    return errs;
  }
  function recordIdSet(list) {
    var o = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(function (e) { if (e && typeof e.id === 'string') o[e.id] = e; });
    return o;
  }

  function createStore(storage, options) {
    // persistent=false means we are running on throwaway in-memory storage:
    // reads work (always empty) but every write is refused with an error.
    var persistent = true;
    var lastRemoveResult = null;
    if (!storage) {
      try {
        storage = (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : null;
      } catch (e) { storage = null; }
      if (!storage) { storage = memoryStorage(); persistent = false; }
    }
    var nowFn = options && typeof options.now === 'function' ? options.now : function () { return new Date(); };

    // Reads KEY and classifies it. Never writes.
    //   ok | empty        -> data is usable (data keeps every stored entry and field)
    //   unreadable        -> getItem threw; we do not know what is stored
    //   corrupt           -> stored text is not a valid hyrox object (raw kept)
    //   newer             -> stored by a newer schema version (raw kept)
    function readState() {
      if (!persistent) return { state: 'unavailable', data: emptyData() };
      var raw;
      try { raw = storage.getItem(KEY); } catch (e) { return { state: 'unreadable' }; }
      if (raw === undefined) raw = null;
      if (raw === null || raw === '') return { state: 'empty', data: emptyData(), raw: raw };
      return classifyRaw(raw);
    }

    // For display: only well-formed entries; damaged/unreadable storage reads as empty.
    function load() {
      var s = readState();
      var data = emptyData();
      if (s.data) TYPES.forEach(function (t) { data[t] = s.data[t].filter(isValidEntry); });
      return data;
    }

    // Copies damaged raw text to RECOVERY_KEY and verifies it. Never replaces
    // an existing, different recovery copy.
    function preserveCorrupt(raw) {
      var existing;
      try { existing = storage.getItem(RECOVERY_KEY); } catch (e) { return false; }
      if (existing !== null && existing !== undefined) return existing === raw;
      try {
        storage.setItem(RECOVERY_KEY, raw);
        return storage.getItem(RECOVERY_KEY) === raw;
      } catch (e) { return false; }
    }

    // Returns {data} that is safe to modify and save, or {error}.
    function loadForWrite() {
      var s = readState();
      if (s.state === 'unavailable') return { error: MSG.unavailable };
      if (s.state === 'unreadable') return { error: MSG.unreadable };
      if (s.state === 'newer') return { error: MSG.newer };
      if (s.state === 'corrupt') {
        if (!preserveCorrupt(s.raw)) return { error: MSG.corrupt };
        return { data: emptyData() };
      }
      return { data: s.data };
    }

    // Writes and reads back; success only if the stored text matches exactly.
    function save(data) {
      if (!persistent) return false;
      var json = JSON.stringify(stampVersion(data));
      try {
        storage.setItem(KEY, json);
        return storage.getItem(KEY) === json;
      } catch (e) { return false; }
    }

    // ---------- import / restore (REPLACE only) ----------

    var STORAGE_FAIL = {
      unavailable: ['storage_unavailable', MSG.unavailable.replace('Not saved', 'Not restored')],
      unreadable: ['storage_unreadable', MSG.unreadable.replace('Not saved', 'Not restored')],
      newer: ['storage_newer', MSG.newer.replace('Not saved', 'Not restored')]
    };

    function currentCounts(s) {
      return s.data ? countValid(s.data) : { weight: 0, workouts: 0, nutrition: 0 };
    }

    function applyFail(code, message, extra) {
      var r = importFail(code, message, extra && extra.errors);
      if (extra && Array.isArray(extra.details)) { r.details = extra.details; r.detailsTotal = extra.detailsTotal; r.detailsTruncated = extra.detailsTruncated; }
      r.rolledBack = !!(extra && extra.rolledBack);
      r.backupKey = extra && extra.backupKey ? extra.backupKey : null;
      return r;
    }

    function readBackupSlot() {
      try {
        var v = storage.getItem(BACKUP_KEY);
        return { value: v === undefined ? null : v };
      } catch (e) { return { error: true }; }
    }

    // Saves the exact previous KEY text (or null) in the single pre-import slot
    // and verifies it. If verification fails, the previous slot value is put back.
    function saveImportBackup(raw) {
      var prev = readBackupSlot();
      if (prev.error) return false;
      var envelope = JSON.stringify({ kind: BACKUP_KIND, savedAt: nowFn().toISOString(), raw: raw, restoreState: 'pending' });
      try {
        storage.setItem(BACKUP_KEY, envelope);
        var back = storage.getItem(BACKUP_KEY);
        if (back === envelope && JSON.parse(back).raw === raw) return envelope;
      } catch (e) { /* fall through to restore the earlier slot */ }
      try {
        if (prev.value === null) { if (typeof storage.removeItem === 'function') storage.removeItem(BACKUP_KEY); }
        else storage.setItem(BACKUP_KEY, prev.value);
      } catch (e) { /* best effort */ }
      return false;
    }

    // Records how the restore ended in the slot (pending -> completed | rolled_back). Written and read
    // back; if that fails the earlier envelope text is put back, so the saved copy is never torn.
    // Returns false if the slot could not be updated (it then stays 'pending': fail closed).
    function markSlot(envelope, stateName) {
      try {
        var env = JSON.parse(envelope);
        env.restoreState = stateName;
        var next = JSON.stringify(env);
        storage.setItem(BACKUP_KEY, next);
        if (storage.getItem(BACKUP_KEY) === next) return true;
      } catch (e) { /* fall through */ }
      try { storage.setItem(BACKUP_KEY, envelope); } catch (e) { /* best effort */ }
      return false;
    }

    // What the pre-import slot says about the NEXT restore. null = no slot.
    //   restoreState: pending | completed | rolled_back | unknown (older build, or not readable as ours)
    //   blocksRestore: true only for 'pending' whose saved text would be lost: it has content AND differs
    //   byte-for-byte from what is stored now (if equal, or if there was nothing saved, nothing is lost).
    function priorCopyInfo(currentRaw) {
      var slot = readBackupSlot();
      if (slot.error || slot.value === null) return null;
      var env;
      try { env = JSON.parse(slot.value); } catch (e) { env = null; }
      if (!env || typeof env !== 'object' || env.kind !== BACKUP_KIND) return { restoreState: 'unknown', savedAt: null, blocksRestore: false };
      var st = env.restoreState === 'pending' || env.restoreState === 'completed' || env.restoreState === 'rolled_back' ? env.restoreState : 'unknown';
      var blocks = st === 'pending' && typeof env.raw === 'string' && env.raw !== '' && env.raw !== currentRaw;
      return { restoreState: st, savedAt: typeof env.savedAt === 'string' ? env.savedAt : null, blocksRestore: blocks };
    }

    // Records per collection (all of them), as stored (damaged ones count) or as parsed.
    var ALL_COLLECTIONS = TYPES.concat(EXT_TYPES);
    function collectionCounts(data) {
      var c = { total: 0 };
      ALL_COLLECTIONS.forEach(function (t) {
        var n = data && Array.isArray(data[t]) ? data[t].length : 0;
        c[t] = n; c.total += n;
      });
      return c;
    }

    // P4-O1: an incoming backup with zero records in EVERY collection replacing a populated device.
    // Populated = any stored record (valid or damaged) in any collection. Stored text that is not readable
    // as HYROX data (state 'corrupt') is NOT counted: its bytes are kept untouched in the corrupt-backup key
    // and in the pre-import slot, so nothing is lost. This cannot tell a fully stripped forged file from a
    // truly empty backup, and never claims to.
    function replaceSummary(incomingData, s) {
      var incoming = collectionCounts(incomingData), current = collectionCounts(s.data);
      var populated = current.total > 0;
      return { summary: { incoming: incoming, current: current, currentState: s.state },
        emptyReplacesPopulated: incoming.total === 0 && populated };
    }

    // Puts the exact previous KEY text back (never the envelope), or removes
    // KEY if there was none. Returns true only if verified.
    function rollback(raw) {
      try {
        if (raw === null) {
          storage.removeItem(KEY);
          var gone = storage.getItem(KEY);
          return gone === null || gone === undefined;
        }
        storage.setItem(KEY, raw);
        return storage.getItem(KEY) === raw;
      } catch (e) { return false; }
    }

    function sameCounts(a, b) {
      if (!a || typeof a !== 'object') return false;
      return TYPES.every(function (t) { return a[t] === b[t]; });
    }

    function previewImport(text) {
      var p;
      try { p = parseImport(text, nowFn()); } catch (e) { return importFail('not_json', 'This file could not be read.'); }
      if (!p.ok) return p;
      var s = readState();
      if (STORAGE_FAIL[s.state]) return importFail(STORAGE_FAIL[s.state][0], STORAGE_FAIL[s.state][1]);
      var partialCount = p.data.workouts.filter(function (w) { return w.partial === true; }).length;
      var preview = {
        version: p.data.version,
        exportedAt: p.exportedAt,
        counts: countLists(p.data),
        partialCount: partialCount,
        current: currentCounts(s),
        currentState: s.state,
        warnings: p.warnings
      };
      var ec = extCounts(p.data), cc = extCounts(s.data || {});
      if (ec || cc) { preview.extCounts = ec || {}; preview.currentExt = cc || {}; }
      // P5 additive fields (see /workspace/hyrox-p5/CONTRACT.md).
      var rs = replaceSummary(p.data, s);
      preview.emptyReplacesPopulated = rs.emptyReplacesPopulated;
      preview.replaceSummary = rs.summary;
      var pc = priorCopyInfo(s.raw === undefined ? null : s.raw);
      preview.priorCopy = pc ? { blocksRestore: pc.blocksRestore, restoreState: pc.restoreState, savedAt: pc.savedAt } : null;
      return { ok: true, preview: preview };
    }

    function applyImportUnsafe(text, opts) {
      if (!opts || opts.confirm !== 'REPLACE') {
        return applyFail('not_confirmed', 'Not restored: the replace was not confirmed.');
      }
      var p = parseImport(text, nowFn());
      if (!p.ok) return applyFail(p.code, p.message, { errors: p.errors, details: p.details, detailsTotal: p.detailsTotal, detailsTruncated: p.detailsTruncated });
      var s = readState();
      if (STORAGE_FAIL[s.state]) return applyFail(STORAGE_FAIL[s.state][0], STORAGE_FAIL[s.state][1]);
      var extNow = extCounts(s.data || {}) || {};
      if (!sameCounts(opts.expectCurrent, currentCounts(s)) ||
          (opts.expectCurrentExt !== undefined && JSON.stringify(opts.expectCurrentExt) !== JSON.stringify(extNow))) {
        return applyFail('stale_plan', 'Not restored: your data changed since the preview. Choose the file again.');
      }
      var raw = s.raw === undefined ? null : s.raw;
      // P4-F02: never overwrite the only copy of data from a restore that did not finish verified.
      var pc = priorCopyInfo(raw);
      if (pc && pc.blocksRestore) {
        return applyFail('prior_copy_unresolved', 'Not restored: an earlier restore did not finish, and the only saved copy of your previous data is kept in this browser under ' + BACKUP_KEY + '. A new restore would overwrite it, so nothing was changed. Save a raw recovery copy first and do not clear site data.', { backupKey: BACKUP_KEY });
      }
      // P4-O1 (owner-approved): an empty backup replacing a populated device needs a second confirmation.
      if (replaceSummary(p.data, s).emptyReplacesPopulated && opts.confirmEmptyReplace !== true) {
        return applyFail('empty_replace_not_confirmed', 'Not restored: this backup is empty, and restoring it would replace the data on this device with nothing. Nothing was changed. Confirm a second time to restore an empty backup.');
      }
      if (s.state === 'corrupt') preserveCorrupt(raw); // best effort; the pre-import slot keeps it too

      var envelope = saveImportBackup(raw);
      if (!envelope) {
        return applyFail('backup_failed', 'Not restored: a safety copy of your current data could not be saved (storage full or blocked). Nothing was changed.');
      }

      var json = JSON.stringify(p.data);
      var code = null, after = null;
      try {
        storage.setItem(KEY, json);
      } catch (e) { code = 'write_failed'; }
      if (!code) {
        var back;
        try { back = storage.getItem(KEY); } catch (e) { back = null; }
        after = back === json ? readState() : null;
        if (!after || after.state !== 'ok' || !sameCounts(countLists(p.data), countLists(after.data)) ||
            JSON.stringify(extCounts(p.data) || {}) !== JSON.stringify(extCounts(after.data) || {})) code = 'verify_failed';
      }
      if (!code) {
        markSlot(envelope, 'completed'); // if this fails the slot stays 'pending' (fail closed), the restore itself is done
        return { ok: true, counts: countLists(after.data), backupKey: BACKUP_KEY };
      }

      if (rollback(raw)) {
        markSlot(envelope, 'rolled_back');
        return applyFail(code, code === 'write_failed'
          ? 'Not restored: the backup could not be saved on this device (storage full or blocked). Your previous data was put back.'
          : 'Not restored: the saved data did not check out. Your previous data was put back.',
        { rolledBack: true, backupKey: BACKUP_KEY });
      }
      return applyFail('rollback_failed', 'Not restored, and your previous data could not be put back automatically. It is kept in this browser under ' + BACKUP_KEY + '. Do not clear site data.',
        { rolledBack: false, backupKey: BACKUP_KEY });
    }

    function applyImport(text, opts) {
      try { return applyImportUnsafe(text, opts); } catch (e) {
        // Should be unreachable; never throw and never report success.
        return applyFail('write_failed', 'Not restored: an unexpected error occurred.');
      }
    }

    function importBackupInfo() {
      if (!persistent) return null;
      var slot = readBackupSlot();
      if (slot.error || slot.value === null) return null;
      var env;
      try { env = JSON.parse(slot.value); } catch (e) { env = null; }
      if (!env || typeof env !== 'object' || env.kind !== BACKUP_KIND) return { key: BACKUP_KEY, savedAt: null, counts: null };
      var counts = null;
      if (typeof env.raw === 'string' && env.raw !== '') {
        var c = classifyRaw(env.raw);
        if (c.state === 'ok') counts = countValid(c.data);
      }
      return { key: BACKUP_KEY, savedAt: typeof env.savedAt === 'string' ? env.savedAt : null, counts: counts };
    }

    // What the normal backup does with stored Phase 3 entries that are not valid as stored:
    //   omitted (DAMAGED) / altered (SALVAGED: bad field marked INVALID, original noted) / legacy (kept as stored).
    function extExportCounts(s) {
      var out = { omitted: {}, altered: {}, legacy: {}, omittedTotal: 0, alteredTotal: 0, legacyTotal: 0 };
      EXT_TYPES.forEach(function (t) {
        if (!s.data || !Array.isArray(s.data[t])) return;
        s.data[t].forEach(function (e) {
          var k = classifyExt(t, e).kind;
          var b = k === 'DAMAGED' ? 'omitted' : k === 'SALVAGED' ? 'altered' : k === 'LEGACY' ? 'legacy' : null;
          if (b) { out[b][t] = (out[b][t] || 0) + 1; out[b + 'Total']++; }
        });
      });
      return out;
    }

    function omittedFromNormalExport(s) {
      var om = {}, total = 0;
      TYPES.forEach(function (t) { var n = s.data[t].length - s.data[t].filter(isValidEntry).length; if (n) { om[t] = n; total += n; } });
      var x = extExportCounts(s);
      Object.keys(x.omitted).forEach(function (t) { om[t] = x.omitted[t]; total += x.omitted[t]; });
      return { omitted: om, total: total, altered: x.altered, alteredTotal: x.alteredTotal };
    }

    // P4-F01: the normal export text, built from one read of storage (exportJSON() and exportChecked() share it).
    function buildExportText(s) {
      var data = emptyData();
      TYPES.forEach(function (t) { data[t] = s.data[t].filter(isValidEntry); });
      var out = {
        app: 'hyrox-app',
        exportedAt: nowFn().toISOString(),
        version: hasExtList(s.data) ? VERSION : LEGACY_VERSION,
        weight: data.weight,
        workouts: data.workouts,
        nutrition: data.nutrition
      };
      // Phase 3 lists only when present; image bytes are rejected at write time.
      EXT_TYPES.forEach(function (t) {
        if (!Array.isArray(s.data[t])) return;
        out[t] = [];
        s.data[t].forEach(function (e) {
          var c = classifyExt(t, e);
          // LEGACY records are written exactly as stored; SALVAGED ones as the usable copy (bad field
          // marked INVALID + a note of the original); DAMAGED ones are left out and reported.
          if (c.kind === 'OK' || c.kind === 'LEGACY') out[t].push(e);
          else if (c.kind === 'SALVAGED') out[t].push(c.view);
        });
      });
      return JSON.stringify(out, null, 2);
    }

    // P4-F01: would THIS build's own restore accept exactly this export text right now? Read-only; nothing in
    // the export is omitted, rewritten or rounded to make it pass. Fails closed: if the check itself cannot
    // run, restorable is false.
    var MAX_REASONS = 20;
    function restorableCheck(text) {
      var reasons = [], total = 0, warnings = [];
      try {
        var p = parseImport(text, nowFn());
        if (p.ok) return { restorable: true, reasons: [], reasonsTotal: 0, reasonsTruncated: false, warnings: p.warnings || [] };
        if (Array.isArray(p.details) && p.details.length) {
          p.details.forEach(function (d) {
            reasons.push({ code: d.code, restoreCode: p.code, collection: d.collection, index: d.index, id: d.id, date: d.date, field: d.field, message: d.message, howToCorrect: d.howToCorrect });
          });
          total = typeof p.detailsTotal === 'number' ? p.detailsTotal : reasons.length;
        } else {
          reasons.push({ code: p.code, restoreCode: p.code, collection: null, index: null, id: null, date: null, field: null, message: p.message, howToCorrect: null });
          total = 1;
        }
      } catch (e) {
        reasons = [{ code: 'check_failed', restoreCode: 'check_failed', collection: null, index: null, id: null, date: null, field: null, message: 'The restore check could not be run, so this backup is not verified.', howToCorrect: null }];
        total = 1;
      }
      reasons = reasons.slice(0, MAX_REASONS);
      return { restorable: false, reasons: reasons, reasonsTotal: total, reasonsTruncated: total > reasons.length, warnings: warnings };
    }

    function exportChecked() {
      if (!persistent) return { ok: false, code: 'storage_unavailable', message: 'Storage is unavailable in this browser, so there is no saved data to export.' };
      var s = readState();
      if (s.state === 'unreadable') return { ok: false, code: 'storage_unreadable', message: 'The saved data could not be read. Reload and try again.' };
      if (s.state === 'corrupt' || s.state === 'newer') return { ok: false, code: 'export_unavailable', message: 'Saved data is damaged or from a newer app version and was not exported. It has been kept, not deleted.' };
      var text = buildExportText(s);
      var c = restorableCheck(text);
      return { ok: true, text: text, exportedAt: JSON.parse(text).exportedAt, restorable: c.restorable, reasons: c.reasons,
        reasonsTotal: c.reasonsTotal, reasonsTruncated: c.reasonsTruncated, warnings: c.warnings };
    }

    function rawRecoveryExport() {
      if (!persistent) return { ok: false, code: 'storage_unavailable', message: 'Storage is unavailable in this browser, so there is nothing saved to copy.' };
      var s = readState();
      if (s.state === 'unreadable') return { ok: false, code: 'storage_unreadable', message: 'The saved data could not be read. Reload and try again. Nothing was changed.' };
      var sources = [];
      [KEY, RECOVERY_KEY, BACKUP_KEY].forEach(function (k) {
        var v = storage.getItem(k);
        if (typeof v === 'string') sources.push({ key: k, length: v.length, checksum: checksum(v), raw: v });
      });
      if (!sources.length) return { ok: false, code: 'nothing_stored', message: 'Nothing is saved on this device, so there is nothing to copy.' };
      var normal, omitted = null, omittedTotal = null, warning, restorable = false, restorableReasons = [];
      if (s.state === 'ok' || s.state === 'empty') {
        var rc = restorableCheck(buildExportText(s));
        restorable = rc.restorable; restorableReasons = rc.reasons;
        var o = omittedFromNormalExport(s);
        omitted = o.omitted; omittedTotal = o.total;
        normal = o.total ? 'partial' : 'complete';
        warning = o.total
          ? 'The normal backup leaves out ' + o.total + ' damaged ' + (o.total === 1 ? 'record' : 'records') + ' (' +
            Object.keys(o.omitted).map(function (t) { return o.omitted[t] + ' ' + t; }).join(', ') + '). This emergency copy keeps them exactly as stored.'
          : 'The normal backup includes every record; this emergency copy is the exact stored text.';
        if (o.alteredTotal) warning += ' The normal backup also marks ' + o.alteredTotal + ' invalid stored ' + (o.alteredTotal === 1 ? 'value' : 'values') + ' as invalid (the original is noted beside it); this emergency copy keeps ' + (o.alteredTotal === 1 ? 'it' : 'them') + ' exactly as stored.';
      } else {
        normal = 'refused';
        warning = s.state === 'newer'
          ? 'Your saved data is from a newer app version, so the normal backup cannot include any of it. This emergency copy keeps it exactly as stored.'
          : 'Your saved data is damaged, so the normal backup cannot include any of it. This emergency copy keeps it exactly as stored.';
      }
      if ((s.state === 'ok' || s.state === 'empty') && !restorable) {
        warning += ' The normal backup would be refused by this app\'s own Restore (' + restorableReasons.length + (restorableReasons.length === 1 ? ' problem' : ' or more problems') + '), so do not rely on it as a restorable backup; this emergency copy keeps the exact stored text.';
      }
      warning += ' It is NOT a normal backup and cannot be restored with Restore.';
      var exportedAt = nowFn().toISOString();
      var env = { app: RAW_KIND, kind: RAW_KIND, format: RAW_FORMAT, exportedAt: exportedAt, state: s.state,
        normalExport: normal, omitted: omitted, omittedTotal: omittedTotal, warning: warning, sources: sources };
      var text = JSON.stringify(env, null, 2);
      return { ok: true, text: text, filename: 'hyrox-RAW-RECOVERY-' + todayQatar(nowFn()) + '.json', exportedAt: exportedAt,
        state: s.state, normalExport: normal, normalRestorable: restorable, normalRestorableReasons: restorableReasons, omitted: omitted, omittedTotal: omittedTotal, warning: warning,
        altered: normal === 'refused' ? null : omittedFromNormalExport(s).altered, alteredTotal: normal === 'refused' ? null : omittedFromNormalExport(s).alteredTotal,
        sources: sources.map(function (x) { return { key: x.key, length: x.length, checksum: x.checksum }; }) };
    }

    function add(type, input, rules) {
      var res = runRules(input, rules);
      if (res.errors) return { ok: false, errors: res.errors };
      var entry = { id: newId(), createdAt: nowFn().toISOString() };
      Object.keys(res.value).forEach(function (k) { entry[k] = res.value[k]; });
      var w = loadForWrite();
      if (w.error) return { ok: false, errors: { storage: w.error } };
      w.data[type].push(entry);
      if (!save(w.data)) return { ok: false, errors: { storage: MSG.write } };
      return { ok: true, entry: entry };
    }

    function dateRule(v) { return vDate(v, nowFn()); }

    function sortNewest(arr) {
      return arr
        .map(function (e, i) { return { e: e, i: i }; })
        .sort(function (a, b) {
          if (a.e.date !== b.e.date) return a.e.date < b.e.date ? 1 : -1;
          var ca = String(a.e.createdAt || ''), cb = String(b.e.createdAt || '');
          if (ca !== cb) return ca < cb ? 1 : -1;
          return b.i - a.i;
        })
        .map(function (x) { return x.e; });
    }

    return {
      now: function () { return nowFn(); },
      todayQatar: function () { return todayQatar(nowFn()); },
      addWeight: function (input) {
        return add('weight', input, {
          date: dateRule,
          kg: function (v) { return vNumber(v, { label: 'Weight', min: 20, max: 400, oneDecimal: true }); }
        });
      },
      addWorkout: function (input) {
        return add('workouts', input, {
          date: dateRule,
          activity: function (v) { return vText(v, { label: 'Activity', max: 60, required: true }); },
          durationMin: function (v) { return vNumber(v, { label: 'Duration', min: 1, max: 600, integer: true }); },
          partial: function (v) { return vBool(v, 'Partial'); },
          notes: function (v) { return vText(v, { label: 'Notes', max: 500 }); }
        });
      },
      addNutrition: function (input) {
        return add('nutrition', input, {
          date: dateRule,
          label: function (v) { return vText(v, { label: 'Label', max: 60 }); },
          calories: function (v) { return vNumber(v, { label: 'Calories', min: 0, max: 10000, integer: true }); },
          proteinG: function (v) { return vNumber(v, { label: 'Protein', min: 0, max: 1000, oneDecimal: true }); }
        });
      },
      list: function (type) {
        if (TYPES.indexOf(type) === -1) return [];
        return sortNewest(load()[type]);
      },
      remove: function (type, id) {
        function failRemove(reason, message) {
          lastRemoveResult = { ok: false, reason: reason || null, message: message || 'Could not delete — nothing changed.' };
          return false;
        }
        if (TYPES.indexOf(type) === -1) return failRemove('unknown_type');
        var s = readState();
        if (s.state !== 'ok') return failRemove(s.state || 'unreadable'); // never rewrite damaged/unknown storage
        var hits = (s.data[type] || []).filter(function (e) { return isValidEntry(e) && e.id === id; });
        if (!hits.length) return failRemove('not_found');
        // pending CC confirmation, likely pre-existing (Meron D-5 / Dawit): a duplicate-id
        // pair must not be silently deleted as one row. Refuse and ask for a backup repair.
        if (hits.length > 1) return failRemove('DUPLICATE_ID', DUP_ID_DELETE_MSG);
        var hit = hits[0];
        // applyAtomic refuses schema 1. Legacy logs (weight/workout/nutrition) still delete
        // through the original save path so existing v1 tests and devices keep working.
        // Garmin-linked records and tombstones live on schema 2 only.
        if (typeof s.data.version !== 'number' || s.data.version < VERSION) {
          s.data[type] = s.data[type].filter(function (e) { return !(isValidEntry(e) && e.id === id); });
          var saved = save(s.data);
          if (saved) lastRemoveResult = { ok: true };
          else failRemove('save_failed');
          return saved;
        }
        var result = this.applyAtomic(function (data) {
          var rec = (data[type] || []).filter(function (e) { return isValidEntry(e) && e.id === id; })[0];
          if (!rec) return { write: false, reason: 'not_found' };
          var ts = null;
          if (type === 'weight' && typeof rec.id === 'string' && rec.id.indexOf('w-g-') === 0) ts = Number(rec.id.slice(4));
          var act = null;
          if (type === 'workouts' && typeof rec.id === 'string' && rec.id.indexOf('wo-g-') === 0) act = rec.id.slice(5);
          if (ts || act) {
            if (!attachGarminTombstone(data, { collection: type, timestampGMT: ts || undefined, activityId: act || undefined, localId: rec.id, date: rec.date, at: nowFn().toISOString() })) {
              return { write: false, reason: 'NO_TOMBSTONE_CARRIER', message: NO_TOMBSTONE_MSG };
            }
          }
          data[type] = data[type].filter(function (e) { return !(isValidEntry(e) && e.id === id); });
          return { write: true, data: data, allowRemove: [{ type: type, id: id }] };
        });
        var ok = !!(result && result.ok && result.wrote);
        if (ok) { lastRemoveResult = { ok: true }; return true; }
        var reason = (result && (result.reason || result.code)) || null;
        lastRemoveResult = {
          ok: false,
          reason: reason,
          message: (result && result.message) || (reason === 'NO_TOMBSTONE_CARRIER' ? NO_TOMBSTONE_MSG : 'Could not delete — nothing changed.')
        };
        return false;
      },
      // Storage health for the UI. ok=false means saving is blocked or data could not be read.
      status: function () {
        var s = readState();
        var recovery = null;
        if (persistent) {
          try { recovery = storage.getItem(RECOVERY_KEY); } catch (e) { recovery = null; }
        }
        var out = {
          persistent: persistent,
          state: s.state,
          ok: s.state === 'ok' || s.state === 'empty',
          recoveryKey: recovery !== null && recovery !== undefined ? RECOVERY_KEY : null,
          importBackup: importBackupInfo()
        };
        // P5 / P4-F02 (additive): how the pre-import slot's restore ended, and whether it blocks the next restore.
        // null when there is no slot. Never throws, never writes.
        var pcs = null;
        try { if (persistent) { var cs = s.state === 'unreadable' ? { raw: undefined } : s; var pci = priorCopyInfo(cs.raw === undefined ? null : cs.raw); if (pci) pcs = { restoreState: pci.restoreState, blocksNextRestore: pci.blocksRestore, savedAt: pci.savedAt }; } } catch (e) { pcs = null; }
        if (pcs) out.priorCopy = pcs; // absent when there is no slot (status() shape unchanged for devices without one)
        // Name of a Phase 3 collection stored in a damaged (non-list) form; only present when damaged.
        if (s.damagedList) out.damagedList = s.damagedList;
        // P6 (additive, read-only, never throws): storage context for the "no data in THIS browser context"
        // message. keyPresent: true when hyrox.v1 holds any stored text (even damaged), false when absent,
        // null when unknown (unreadable / unavailable). counts: STORED records per collection (damaged ones
        // count; no contents), or null when the state is unreadable, corrupt, newer or unavailable.
        var kp = null, cnt = null;
        try {
          if (s.state === 'empty' || s.state === 'ok' || s.state === 'corrupt' || s.state === 'newer') {
            kp = s.raw !== null && s.raw !== undefined;
          }
          if ((s.state === 'ok' || s.state === 'empty') && s.data) {
            cnt = {};
            var total = 0;
            TYPES.concat(EXT_TYPES).forEach(function (t) {
              var n = Array.isArray(s.data[t]) ? s.data[t].length : 0;
              cnt[t] = n; total += n;
            });
            cnt.total = total;
          }
        } catch (e) { kp = null; cnt = null; }
        out.keyPresent = kp;
        out.counts = cnt;
        return out;
      },
      dailyNutritionTotals: function () {
        // Keyed by stored date text, so no prototype: a date such as "__proto__" stays data (P4-D1).
        var by = Object.create(null);
        load().nutrition.forEach(function (e) {
          var t = by[e.date] || (by[e.date] = { date: e.date, calories: 0, proteinG: 0, count: 0 });
          t.calories += Number(e.calories) || 0;
          t.proteinG += Number(e.proteinG) || 0;
          t.count += 1;
        });
        return Object.keys(by).sort().reverse().map(function (d) {
          by[d].proteinG = Math.round(by[d].proteinG * 10) / 10;
          return by[d];
        });
      },
      // Read-only; never throws. Tells the UI how many entries an export leaves out.
      exportSummary: function () {
        var s;
        try { s = readState(); } catch (e) { s = { state: 'unreadable' }; }
        if (s.state !== 'ok' && s.state !== 'empty') return { included: null, omitted: null, state: s.state };
        var all = countLists(s.data), included = countValid(s.data), omitted = {};
        TYPES.forEach(function (t) { omitted[t] = all[t] - included[t]; });
        var out = { included: included, omitted: omitted };
        // Phase 3 records that are stored but too damaged to export (kept on this device), and
        // records exported with a bad field marked invalid / with an older-rule value kept as stored.
        var x = extExportCounts(s);
        if (x.omittedTotal) out.omittedExt = x.omitted;
        if (x.alteredTotal) out.salvagedExt = x.altered;
        if (x.legacyTotal) out.legacyExt = x.legacy;
        return out;
      },
      previewImport: previewImport,
      applyImport: applyImport,
      // Emergency raw recovery export (read-only, zero writes). Copies the EXACT stored text of
      // hyrox.v1, the corrupt-backup copy and the pre-import slot (each only if present) into one
      // file, and says how many records the normal export leaves out.
      rawRecoveryExport: function () {
        try { return rawRecoveryExport(); } catch (e) {
          return { ok: false, code: 'storage_unreadable', message: 'The saved data could not be read for a raw copy. Nothing was changed.' };
        }
      },
      exportJSON: function () {
        var s = readState();
        if (s.state === 'unavailable') throw new Error('storage is unavailable in this browser, so there is no saved data to export.');
        if (s.state === 'unreadable') throw new Error('saved data could not be read. Reload and try again.');
        if (s.state === 'corrupt' || s.state === 'newer') {
          throw new Error('saved data is damaged or from a newer app version and was not exported. It has been kept, not deleted.');
        }
        return buildExportText(s);
      },
      // P5 / P4-F01: the export text plus whether this build's own restore accepts it (atomic; never throws).
      exportChecked: function () {
        try { return exportChecked(); } catch (e) {
          return { ok: false, code: 'export_unavailable', message: 'The backup could not be built. Nothing was changed.' };
        }
      },

      // ---------- Phase 3 extension records ----------
      records: function (type) {
        if (EXT_TYPES.indexOf(type) === -1) return [];
        var s = readState();
        if (!s.data || !Array.isArray(s.data[type])) return [];
        var out = [];
        s.data[type].forEach(function (e) {
          var c = classifyExt(type, e);
          if (c.kind === 'OK') out.push(e);
          else if (c.kind !== 'DAMAGED') out.push(markedView(c));
        });
        return sortNewest(out);
      },
      // Read-only list of every stored entry that is not valid as stored, with the exact field,
      // stored value and rule. usable=true means the rest of the record is still shown and used.
      damagedRecords: function () {
        var s, out = [];
        try { s = readState(); } catch (e) { return out; }
        if (!s.data) return out;
        TYPES.forEach(function (t) {
          s.data[t].forEach(function (e, i) {
            if (isValidEntry(e) || out.length >= 200) return;
            var sv = safeDetailValue(e);
            out.push({ collection: t, index: i, id: e && typeof e.id === 'string' ? e.id : null, date: e && typeof e.date === 'string' ? e.date : null, kind: 'DAMAGED', usable: false,
              problems: [{ field: 'entry', path: '', value: sv.value, valueType: sv.valueType, rule: 'must be a record with a text id and date', message: 'Entry is not a usable record.', legacy: false }] });
          });
        });
        EXT_TYPES.forEach(function (t) {
          if (!Array.isArray(s.data[t])) return;
          s.data[t].forEach(function (e, i) {
            var c = classifyExt(t, e);
            if (c.kind === 'OK' || out.length >= 200) return;
            out.push({ collection: t, index: i, id: e && typeof e.id === 'string' ? clipText(e.id, 64).text : null, date: e && typeof e.date === 'string' ? clipText(e.date, 20).text : null,
              kind: c.kind, usable: c.kind !== 'DAMAGED', problems: c.problems });
          });
        });
        return out;
      },
      // Owner settings with defaults filled in. Never writes. `stored` is false until the owner saves.
      settings: function () {
        var s = readState();
        var rec = s.data && Array.isArray(s.data.ownerSettings)
          ? s.data.ownerSettings.filter(function (e) { return isUsableExt('ownerSettings', e) && e.id === SETTINGS_ID; })[0] : null;
        return {
          stored: !!rec,
          rhrBaselineBpm: rec && typeof rec.rhrBaselineBpm === 'number' ? rec.rhrBaselineBpm : DEFAULT_SETTINGS.rhrBaselineBpm,
          rhrBaselineSource: rec && typeof rec.rhrBaselineBpm === 'number' ? 'OWNER_SET' : 'OWNER_DEFAULT',
          stepBaselineMode: rec && rec.stepBaselineMode === 'MANUAL' ? 'MANUAL' : 'AUTO',
          stepBaselineManual: rec && typeof rec.stepBaselineManual === 'number' ? rec.stepBaselineManual : null,
          // Adaptive step suggestion settings: app defaults (not from v2.1) unless the owner set them.
          stepLightDayPct: rec && typeof rec.stepLightDayPct === 'number' ? rec.stepLightDayPct : 10,
          stepAfterDemandingPct: rec && typeof rec.stepAfterDemandingPct === 'number' ? rec.stepAfterDemandingPct : -15,
          stepHighFatiguePct: rec && typeof rec.stepHighFatiguePct === 'number' ? rec.stepHighFatiguePct : -30,
          stepHistoryDays: rec && typeof rec.stepHistoryDays === 'number' ? rec.stepHistoryDays : 14,
          stepMinObservations: rec && typeof rec.stepMinObservations === 'number' ? rec.stepMinObservations : 3,
          record: rec ? JSON.parse(JSON.stringify(rec)) : null
        };
      },
      // Insert or replace by id. Validates, writes, reads back. Never reports a false save.
      // Replacing a stored entry that is not valid as stored needs opts.approveCorrection === true
      // (the owner's explicit approval); otherwise nothing is written.
      putRecord: function (type, record, opts) {
        if (EXT_TYPES.indexOf(type) === -1) return { ok: false, errors: { _: 'Unknown record type.' } };
        // F6: JSON.stringify would silently turn NaN/Infinity into null ("not recorded"). Refuse instead.
        var bad = nonFinitePath(record, '', 0);
        if (bad !== null) { var be = {}; be[bad || 'entry'] = (bad || 'A value') + ' must be a real number (not NaN or Infinity).'; return { ok: false, errors: be }; }
        var now = nowFn().toISOString();
        var rec = JSON.parse(JSON.stringify(record || {}));
        if (!rec.id) rec.id = newId();
        if (!rec.createdAt) rec.createdAt = now;
        rec.updatedAt = now;
        var errs = validateExtRecord(type, rec, todayQatar(nowFn()));
        if (errs.length) {
          var e = {};
          errs.forEach(function (x) { if (!e[x.field]) e[x.field] = x.message; });
          return { ok: false, errors: e };
        }
        var w = loadForWrite();
        if (w.error) return { ok: false, errors: { storage: w.error } };
        var list = Array.isArray(w.data[type]) ? w.data[type] : (w.data[type] = []);
        var idx = -1;
        for (var i = 0; i < list.length; i++) { if (list[i] && list[i].id === rec.id) { idx = i; break; } }
        if (idx >= 0 && classifyExt(type, list[idx]).kind !== 'OK' && !(opts && opts.approveCorrection === true)) {
          return { ok: false, code: 'STORED_RECORD_DAMAGED', errors: { damaged: DAMAGED_MSG } };
        }
        if (idx >= 0) {
          var prev = list[idx];
          rec.createdAt = prev.createdAt || rec.createdAt;
          // Dawit: the data layer itself preserves garminLedger / garminLedgerBag on a
          // check-in edit unless the caller explicitly sent those fields.
          // Meron R4-D6: garminLedger:undefined serialises away (JSON.stringify drops it)
          // while hasOwnProperty is still true, which used to wipe the settings ledger.
          function ledgerFieldSent(recIn, key) {
            // Meron R4-D6 / Claude QA F3: undefined *or* null is not a sent ledger (JSON or a hostile copy can supply either).
            return recIn && Object.prototype.hasOwnProperty.call(recIn, key) && recIn[key] !== undefined && recIn[key] !== null;
          }
          if (type === 'daily' && record && typeof record === 'object') {
            if (!ledgerFieldSent(record, 'garminLedger') && prev.garminLedger) {
              rec.garminLedger = JSON.parse(JSON.stringify(prev.garminLedger));
            }
            if (!ledgerFieldSent(record, 'garminLedgerBag') && prev.garminLedgerBag) {
              rec.garminLedgerBag = JSON.parse(JSON.stringify(prev.garminLedgerBag));
            }
          }
          if (type === 'ownerSettings' && record && typeof record === 'object') {
            if (!ledgerFieldSent(record, 'garminLedger') && prev.garminLedger) {
              rec.garminLedger = JSON.parse(JSON.stringify(prev.garminLedger));
            }
          }
          var revs = Array.isArray(prev.revisions) ? prev.revisions.slice(-19) : [];
          revs.push({ at: now, prevUpdatedAt: prev.updatedAt || prev.createdAt || null });
          rec.revisions = revs;
          list[idx] = rec;
        } else list.push(rec);
        if (!save(w.data)) return { ok: false, errors: { storage: MSG.write } };
        return { ok: true, entry: rec };
      },
      // Deleting a stored entry that is not valid as stored needs opts.approveDamaged === true.
      removeRecord: function (type, id, opts) {
        function failRemove(reason, message) {
          lastRemoveResult = { ok: false, reason: reason || null, message: message || 'Could not delete — nothing changed.' };
          return false;
        }
        if (EXT_TYPES.indexOf(type) === -1) return failRemove('unknown_type');
        var s = readState();
        if (s.state !== 'ok' || !Array.isArray(s.data[type])) return failRemove(s.state || 'unreadable');
        var hit = s.data[type].filter(function (e) { return isValidEntry(e) && e.id === id; });
        if (hit.some(function (e) { return classifyExt(type, e).kind !== 'OK'; }) && !(opts && opts.approveDamaged === true)) return failRemove('damaged');
        if (!hit.length) return failRemove('not_found');
        if (hit.length > 1) return failRemove('DUPLICATE_ID', DUP_ID_DELETE_MSG);
        var result = this.applyAtomic(function (data) {
          var rec = (data[type] || []).filter(function (e) { return isValidEntry(e) && e.id === id; })[0];
          if (!rec) return { write: false, reason: 'not_found' };
          if (type === 'daily') {
            var settings = pickSettingsRecord(data);
            if (ledgerCorruptOn(rec) || ledgerCorruptOn(settings)) {
              return { write: false, reason: 'LEDGER_CORRUPT', message: LEDGER_CORRUPT_MSG };
            }
            var linked = dailyIsGarminLinked(data, rec);
            data.daily = data.daily.filter(function (e) { return !(isValidEntry(e) && e.id === id); });
            try {
              migrateLegacyGarminLedgersToSettings(data, rec.createdAt || rec.updatedAt, rec.date);
              // The removed record itself may still carry a legacy ledger (already stripped from data.daily).
              if (rec.garminLedger || rec.garminLedgerBag) {
                var tmp = { ownerSettings: data.ownerSettings, daily: [rec] };
                migrateLegacyGarminLedgersToSettings(tmp, rec.createdAt || rec.updatedAt, rec.date);
                data.ownerSettings = tmp.ownerSettings;
              }
              if (linked) {
                if (!attachGarminTombstone(data, { collection: 'daily', date: rec.date, localId: rec.id })) {
                  return { write: false, reason: 'LEDGER_CORRUPT', message: LEDGER_CORRUPT_MSG };
                }
              }
            } catch (e) {
              if (e && e.code === 'LEDGER_CORRUPT') return { write: false, reason: 'LEDGER_CORRUPT', message: LEDGER_CORRUPT_MSG };
              throw e;
            }
            return { write: true, data: data, allowRemove: [{ type: type, id: id }] };
          }
          data[type] = data[type].filter(function (e) { return !(isValidEntry(e) && e.id === id); });
          return { write: true, data: data, allowRemove: [{ type: type, id: id }] };
        }, opts);
        var ok = !!(result && result.ok && result.wrote);
        if (ok) {
          lastRemoveResult = { ok: true };
          return true;
        }
        var reason = (result && (result.reason || result.code)) || null;
        lastRemoveResult = {
          ok: false,
          reason: reason,
          message: (result && result.message) || (reason === 'LEDGER_CARRIER' ? LEDGER_CARRIER_MSG : (reason === 'LEDGER_CORRUPT' ? LEDGER_CORRUPT_MSG : (reason === 'DUPLICATE_ID' ? DUP_ID_DELETE_MSG : 'Could not delete — nothing changed.')))
        };
        return false;
      },
      lastRemoveResult: function () { return lastRemoveResult; },
      extCounts: function () { var s = readState(); return extCounts(s.data || {}) || {}; },
      // S1 (24 Nov 2026, Garmin import): one in-memory merge, one save, read-back verify, rollback.
      // Never writes hyrox.v1.pre-import-backup and never calls applyImport.
      // Refuses schema 1, pending restore, corrupt, newer. Zero writes when the mutator says write:false.
      applyAtomic: function (mutator, opts) {
        opts = opts || {};
        var s = readState();
        if (s.state === 'unavailable') return { ok: false, code: 'unavailable', wrote: false };
        if (s.state === 'unreadable') return { ok: false, code: 'unreadable', wrote: false };
        if (s.state === 'newer') return { ok: false, code: 'newer', wrote: false };
        if (s.state === 'corrupt') return { ok: false, code: 'corrupt', wrote: false };
        var snapshot;
        try { snapshot = storage.getItem(KEY); } catch (e) { return { ok: false, code: 'unreadable', wrote: false }; }
        if (snapshot === undefined) snapshot = null;
        var slot;
        try { slot = storage.getItem(BACKUP_KEY); } catch (e) { return { ok: false, code: 'unreadable', wrote: false }; }
        if (slot) {
          try {
            var env = JSON.parse(slot);
            if (env && env.kind === BACKUP_KIND && env.restoreState === 'pending') {
              return { ok: false, code: 'restore_pending', wrote: false };
            }
          } catch (e) { return { ok: false, code: 'prior_copy_unreadable', wrote: false }; }
        }
        // t112 CC #4: a brand-new empty store (no hyrox.v1) may receive the first
        // Garmin day + owner-settings carrier in this one save. An *existing*
        // schema-1 document is never auto-upgraded, even when allowFirstCreate is set.
        var startingFromEmpty = s.state === 'empty' && opts.allowFirstCreate === true;
        if (!s.data && !startingFromEmpty) return { ok: false, code: 'empty', wrote: false };
        if (!startingFromEmpty && (typeof s.data.version !== 'number' || s.data.version < VERSION)) {
          return { ok: false, code: 'schema_1', wrote: false };
        }
        if (!startingFromEmpty && s.data.version > VERSION) return { ok: false, code: 'newer', wrote: false };
        var working;
        try { working = startingFromEmpty ? emptyV2Data() : JSON.parse(JSON.stringify(s.data)); } catch (e) { return { ok: false, code: 'corrupt', wrote: false }; }
        var plan;
        try { plan = mutator(working, opts) || { write: false }; } catch (e) {
          if (e && e.code === 'LEDGER_CORRUPT') {
            return { ok: false, code: 'LEDGER_CORRUPT', wrote: false, message: LEDGER_CORRUPT_APPLY_MSG };
          }
          return { ok: false, code: 'mutator', wrote: false, message: 'merge failed' };
        }
        if (plan.write === false || plan.write == null) return { ok: true, wrote: false, reason: plan.reason || 'no_write', message: plan.message };
        var next = plan.data || working;
        var lists = TYPES.concat(EXT_TYPES), i, t;
        for (i = 0; i < lists.length; i++) {
          t = lists[i];
          if (Array.isArray(next[t]) && next[t].length > IMPORT_LIMITS.maxPerList) {
            return { ok: false, code: 'too_large', wrote: false };
          }
        }
        // R5: validate every new or changed record; refuse any removal the mutator was not asked for.
        var ceiling = todayQatar(nowFn());
        var allowed = Object.create(null);
        (plan.allowRemove || []).forEach(function (r) {
          if (r && r.type && r.id) allowed[r.type + '\0' + r.id] = true;
        });
        for (i = 0; i < lists.length; i++) {
          t = lists[i];
          var beforeList = Array.isArray((s.data || {})[t]) ? (s.data || {})[t] : [];
          var afterList = Array.isArray(next[t]) ? next[t] : [];
          var beforeMap = recordIdSet(beforeList);
          var afterMap = recordIdSet(afterList);
          var id;
          for (id in beforeMap) {
            if (!Object.prototype.hasOwnProperty.call(afterMap, id) && !allowed[t + '\0' + id]) {
              return { ok: false, code: 'UNEXPECTED_REMOVE', wrote: false, message: 'Refused an unsolicited removal of ' + t + ' ' + id + '.' };
            }
          }
          // Validate every new or changed record in the raw after-list (not recordIdSet last-wins; Dawit / Meron R5-10).
          // Pre-existing errors on a stored record do not block a write that does not introduce new ones (Dawit D-4).
          var ai;
          for (ai = 0; ai < afterList.length; ai++) {
            var recA = afterList[ai];
            if (!recA || typeof recA.id !== 'string') continue;
            var unchangedCopy = beforeList.some(function (b) { return b && b.id === recA.id && JSON.stringify(b) === JSON.stringify(recA); });
            if (unchangedCopy) continue;
            var recErrs;
            if (TYPES.indexOf(t) !== -1) recErrs = validateCoreRecord(t, recA, ceiling);
            else recErrs = validateExtRecord(t, recA, ceiling).map(function (e) { return e.message; });
            if (recErrs && recErrs.length) {
              var beforeSame = beforeList.filter(function (b) { return b && b.id === recA.id; })[0];
              var beforeErrs = [];
              if (beforeSame) {
                if (TYPES.indexOf(t) !== -1) beforeErrs = validateCoreRecord(t, beforeSame, ceiling) || [];
                else beforeErrs = validateExtRecord(t, beforeSame, ceiling).map(function (e) { return e.message; });
              }
              var newErrs = recErrs.filter(function (e) { return beforeErrs.indexOf(e) === -1; });
              if (newErrs.length) return { ok: false, code: 'INVALID_RECORD', wrote: false, errors: newErrs };
            }
          }
          // pending CC confirmation (Claude decision 1 / Dawit verdict 1, t111u):
          // uniqueness is checked against the full after-list; refuse only when a
          // touched id is not unique, or this write increased the copy-count of an id.
          var beforeCount = countIds(beforeList);
          var afterCount = countIds(afterList);
          var did;
          for (did in afterCount) {
            if (afterCount[did] > 1) {
              var increased = afterCount[did] > (beforeCount[did] || 0);
              var touchedDup = afterList.some(function (recT) {
                if (!recT || recT.id !== did) return false;
                return !beforeList.some(function (b) { return b && b.id === recT.id && JSON.stringify(b) === JSON.stringify(recT); });
              });
              if (increased || touchedDup) {
                return { ok: false, code: 'DUPLICATE_ID', wrote: false, message: t + ' id ' + did };
              }
            }
          }
        }
        // Never let stampVersion silently promote a schema-1 document (guarded above).
        var json;
        try { json = JSON.stringify(stampVersion(next)); } catch (e) { return { ok: false, code: 'serialize', wrote: false }; }
        if (json.length > IMPORT_LIMITS.maxBytes) return { ok: false, code: 'too_large', wrote: false };
        try {
          storage.setItem(KEY, json);
          if (storage.getItem(KEY) !== json) throw new Error('verify');
        } catch (e) {
          var rolledBack = false;
          try {
            // Populated diaries are restored in place (P6-DL-6: never delete a populated KEY here).
            // First-day / previously absent KEY (snapshot null): Dawit R4-D1 — removeItem so a
            // failed read-back does not leave a stray hyrox.v1. rolledBack reflects the verified empty state.
            if (snapshot !== null && snapshot !== undefined) {
              storage.setItem(KEY, snapshot);
              rolledBack = storage.getItem(KEY) === snapshot;
            } else {
              rolledBack = rollback(null);
            }
          } catch (e2) { /* best effort */ }
          var saveMsg = rolledBack ? undefined : 'The save could not be finished and may be incomplete. Please check your data or export a backup.';
          return { ok: false, code: 'save_failed', wrote: false, rolledBack: rolledBack, message: saveMsg };
        }
        return { ok: true, wrote: true, entry: plan.entry || null };
      }
    };
  }

  return {
    todayQatar: todayQatar, createStore: createStore, STORAGE_KEY: KEY, RECOVERY_KEY: RECOVERY_KEY, VERSION: VERSION,
    mergeGarminLedgerDoc: mergeGarminLedgerDoc,
    emptyV2Data: emptyV2Data,
    attachGarminLedgerToSettings: attachGarminLedgerToSettings,
    migrateLegacyGarminLedgersToSettings: migrateLegacyGarminLedgersToSettings,
    pickSettingsRecord: pickSettingsRecord,
    IMPORT_BACKUP_KEY: BACKUP_KEY, IMPORT_LIMITS: IMPORT_LIMITS,
    LEGACY_VERSION: LEGACY_VERSION, SETTINGS_ID: SETTINGS_ID, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    EXT_TYPES: EXT_TYPES, ENUMS: ENUMS, validateExtRecord: validateExtRecord, classifyExtRecord: classifyExt,
    RAW_RECOVERY_KIND: RAW_KIND, parseRawRecovery: parseRawRecovery, rawChecksum: checksum
  };
});
