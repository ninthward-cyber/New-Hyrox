/*
 * hyrox-coach-export.js - P1.4 "Export for AI Coaching" (HNC-E-COACH-001 v1.0, CC Combined Value Sprint, Priority D).
 * Pure functions: builds a READ-ONLY, versioned coaching snapshot from data the caller has already read. This file reads
 * and writes no storage and makes no network request. Plain-JS UMD (window.HyroxCoachExport / require()).
 *
 * The snapshot is NOT a backup, NOT a sync and cannot be restored: it has no field named "app", no top-level "version"
 * and no top-level weight/workouts/nutrition lists, so the app's restore refuses it (not_hyrox).
 * Rules (section 6.3 of the plan): unknown stays null, never 0; states are copied exactly; only CONFIRMED meals carry
 * numbers; a category that is not selected is ABSENT, a selected category with no records is an EMPTY list; damaged
 * records are left out and counted; nothing is repaired, rounded or invented; stable ids are the app's own ids.
 * Never exported: owner code, AI settings, keys/tokens, photo bytes, recovery copies, the workout draft, saved foods,
 * favourites, draft or cancelled plan blocks, the coach profile (height/age/sex), the dayStates basis text.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HyroxCoachExport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KIND = 'hyrox-coaching-snapshot';
  var SCHEMA_VERSION = '1.0';
  var NOT_A_BACKUP = 'Read-only coaching snapshot. It cannot be restored into the app.';
  var TZ_OFFSET_MIN = 180; // Asia/Qatar, UTC+3, no daylight saving
  var MAX_DAYS = 366;
  var CATEGORIES = ['training', 'nutrition', 'body', 'steps', 'recovery', 'symptoms', 'goals', 'freeText'];
  var DEFAULTS = { training: true, nutrition: true, body: true, steps: true, recovery: false, symptoms: false, goals: true, freeText: false };
  var LABELS = { training: 'Training', nutrition: 'Nutrition', body: 'Body (weight, waist)', steps: 'Steps and intensity minutes', recovery: 'Sleep and recovery',
    symptoms: 'Pain and symptoms', goals: 'Goals and targets', freeText: 'Free-text notes' };
  // Words the feature must never use about itself (plan section 9).
  var FORBIDDEN_WORDS = ['synced', 'uploaded', 'saved to drive', 'sent to chatgpt', 'backed up', 'up to date'];
  var RANGE_PRESETS = [7, 14, 28];
  var MACROS = ['kcal', 'proteinG', 'carbsG', 'fatG'];
  var DAILY_RECOVERY = ['sleepH', 'sleepQuality', 'soreness', 'readiness', 'rhr'];
  var DAILY_SYMPTOMS = ['pain', 'footPain', 'stairKneePain', 'limp'];
  var COLLECTION_CATEGORY = { sessions: ['training'], workouts: ['training'], walks: ['training'], planEvents: ['training'],
    meals: ['nutrition'], dayStates: ['nutrition'], nutrition: ['nutrition'], weight: ['body'], body: ['body'],
    daily: ['steps', 'recovery', 'symptoms'], ownerSettings: ['goals'] };

  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s;
  }
  function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // Qatar wall clock for a Date: { date: 'YYYY-MM-DD', compact: 'YYYYMMDD-HHMMSS', iso: '...+03:00' }
  function qatarClock(now) {
    var t = new Date(now.getTime() + TZ_OFFSET_MIN * 60000);
    var date = t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
    var time = pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()) + ':' + pad(t.getUTCSeconds());
    return { date: date, compact: date.replace(/-/g, '') + '-' + time.replace(/:/g, ''), iso: date + 'T' + time + '+03:00' };
  }
  function randomTag(rand) {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789', out = '';
    var r = typeof rand === 'function' ? rand : Math.random;
    for (var i = 0; i < 4; i++) out += chars.charAt(Math.floor(r() * chars.length) % chars.length);
    return out;
  }
  function v(x) { return x === undefined ? null : x; } // absent -> null (never 0)
  function obs(o) { if (!isObj(o)) return null; var r = { state: v(o.state), value: v(o.value) }; if (o.source != null) r.source = v(o.source); return r; }
  function mac(m) { return isObj(m) ? { value: v(m.value), state: v(m.state) } : { value: null, state: 'UNKNOWN' }; }
  function clone(x) { return x === undefined ? null : JSON.parse(JSON.stringify(x)); }
  function quality(r) {
    var d = r && r._storedDamaged;
    if (d && d.kind === 'SALVAGED') return 'SALVAGED';
    if (d && d.kind === 'LEGACY') return 'LEGACY';
    return null;
  }
  function withQuality(out, r) { var q = quality(r); if (q) out.recordQuality = q; return out; }

  // Range: explicit from/to (inclusive, Qatar dates), never in the future, at most MAX_DAYS.
  function checkRange(from, to, todayIso) {
    if (!isDate(from) || !isDate(to)) return { ok: false, code: 'range_invalid', message: 'Choose a valid start and end date.' };
    if (to > todayIso) return { ok: false, code: 'range_future', message: 'The end date cannot be in the future.' };
    if (from > to) return { ok: false, code: 'range_order', message: 'The start date must be on or before the end date.' };
    var days = daysBetween(from, to) + 1;
    if (days > MAX_DAYS) return { ok: false, code: 'range_long', message: 'Choose at most ' + MAX_DAYS + ' days.' };
    return { ok: true, from: from, to: to, days: days };
  }
  function presetRange(days, todayIso) { return { from: addDays(todayIso, -(days - 1)), to: todayIso }; }
  function normSelection(sel) {
    var out = {};
    CATEGORIES.forEach(function (k) { out[k] = isObj(sel) && typeof sel[k] === 'boolean' ? sel[k] : DEFAULTS[k]; });
    return out;
  }

  function cov() { return { recordCount: 0, firstDate: null, lastDate: null, daysWithData: 0, excluded: { damaged: 0, outOfRange: 0 }, salvagedCount: 0, legacyCount: 0, _days: {} }; }
  function note(c, rec) {
    c.recordCount++;
    if (isDate(rec.date)) {
      c._days[rec.date] = 1;
      if (!c.firstDate || rec.date < c.firstDate) c.firstDate = rec.date;
      if (!c.lastDate || rec.date > c.lastDate) c.lastDate = rec.date;
    }
    var q = quality(rec); if (q === 'SALVAGED') c.salvagedCount++; else if (q === 'LEGACY') c.legacyCount++;
  }
  function inRange(r, rg) { return !!r && isDate(r.date) && r.date >= rg.from && r.date <= rg.to; }
  function split(list, rg, c) {
    var inside = [];
    (list || []).forEach(function (r) { if (!r || typeof r !== 'object') return; if (inRange(r, rg)) inside.push(r); else c.excluded.outOfRange++; });
    inside.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0; });
    return inside;
  }

  function sessionOut(s, ft) {
    var o = { id: s.id, date: s.date, scheduledDate: v(s.scheduledDate), planSlotId: v(s.planSlotId), planVersion: v(s.planVersion), title: v(s.title),
      status: v(s.status), countsAsCompleted: s.status === 'COMPLETED', modified: s.modified === true, variant: v(s.variant), variantKind: v(s.variantKind),
      intensity: v(s.intensity), durationMin: v(s.durationMin), rpe: v(s.rpe), runSteps: v(s.runSteps), runStepsSource: v(s.runStepsSource),
      skipDecision: v(s.skipDecision), rescheduledTo: v(s.rescheduledTo), sourceOmission: v(s.sourceOmission), createdAt: v(s.createdAt), updatedAt: v(s.updatedAt),
      blocks: (Array.isArray(s.blocks) ? s.blocks : []).filter(isObj).map(function (b) {
        var x = {};
        ['kind', 'exercise', 'equipment', 'setType', 'sets', 'reps', 'loadKg', 'distanceM', 'durationSec', 'rpe', 'count', 'prescribedSets', 'prescribedDurationSec', 'optional', 'sourceStatus']
          .forEach(function (k) { x[k] = v(b[k]); });
        // The app's block field "omitted" is exported as "omittedByOwner": the restore code treats any "omitted" key as an
        // emergency-copy marker, and a coaching snapshot must be refused as "not a HYROX backup", not as an emergency copy.
        x.omittedByOwner = b.omitted === true;
        if (ft && typeof b.notes === 'string' && b.notes) x.notes = b.notes;
        return x;
      }) };
    if (ft) o.notes = typeof s.notes === 'string' ? s.notes : null;
    return withQuality(o, s);
  }
  function componentOut(m, c, ft, HN) {
    var o = { name: v(c.name), role: v(c.role), eatenFraction: HN.eatenFractionOf(m, c) };
    MACROS.forEach(function (k) { o[k] = mac(c[k]); });
    ['fiberG', 'sodiumMg'].forEach(function (k) { if (isObj(c[k])) { o[k] = mac(c[k]); if (c[k].by !== undefined) o[k].by = c[k].by; } });
    if (typeof c.basis === 'string') o.basis = c.basis; // photo + note provenance (Sprint A): PHOTO / NOTE / BOTH
    if (typeof c.confidence === 'string') o.confidence = c.confidence;
    if (isObj(c.provenance)) o.provenance = { source: v(c.provenance.source), dataset: v(c.provenance.dataset), fdcId: v(c.provenance.fdcId), dbVersion: v(c.provenance.dbVersion), carbsClampedToZero: v(c.provenance.carbsClampedToZero) };
    if (ft) { o.portion = v(c.portion); o.preparation = v(c.preparation); if (typeof c.uncertainty === 'string') o.uncertainty = c.uncertainty; }
    return o;
  }
  function mealOut(m, ft, HN) {
    var o = { id: m.id, date: m.date, time: v(m.time), mealCategory: v(m.mealCategory), source: v(m.source), aiMode: isObj(m.ai) ? v(m.ai.mode) : null,
      confirmedAt: v(m.confirmedAt), eatenFraction: typeof m.eatenFraction === 'number' ? m.eatenFraction : null, completeness: HN.completeness(m),
      totals: HN.mealTotals(m), components: (m.components || []).filter(isObj).map(function (c) { return componentOut(m, c, ft, HN); }) };
    if (ft) { o.label = v(m.label); o.description = v(m.description); }
    return withQuality(o, m);
  }
  // Claude QA of P1.4-RC2: the daily Garmin intensity minutes the owner types in the morning log (P1.1) were not in the
  // snapshot, although its own note said they are typed by the owner. Same reading rule as hyrox-morning.js: a whole number
  // 0..2880 from GARMIN_MANUAL or GARMIN_PERSONAL_API is OBSERVED; anything else stored is INVALID (unknown, never 0); nothing stored is null.
  function intensityOut(x) {
    if (x === undefined || x === null) return null;
    if (isObj(x) && x.state === 'MISSING' && (x.value === null || x.value === undefined)) return null;
    if (isObj(x) && x.state === 'OBSERVED' && (x.source === 'GARMIN_MANUAL' || x.source === 'GARMIN_PERSONAL_API') && typeof x.value === 'number' && isFinite(x.value) && Math.floor(x.value) === x.value && x.value >= 0 && x.value <= 2880)
      return { state: 'OBSERVED', value: x.value, source: x.source };
    return { state: 'INVALID', value: null };
  }
  function dailyOut(d, fields, extra) {
    var o = { id: d.id, date: d.date };
    fields.forEach(function (k) { o[k] = obs(d[k]); });
    if (extra) extra(o);
    return withQuality(o, d);
  }

  /*
   * build(input, opts) -> { ok:true, snapshot, text, fileName, counts } | { ok:false, code, message }
   * input: { storageState, dataVersion, appBuild, records:{sessions,meals,body,daily,walks,dayStates,planEvents},
   *          classic:{weight,workouts,nutrition}, damaged:[{collection,kind}], settings, planned:[...], noActivePlanDates:[...],
   *          coach:{ target, goal } , HN (HyroxNutrition) }
   * opts: { from, to, selection, now: Date, rand: fn, synthetic: bool }
   */
  function build(input, opts) {
    input = input || {}; opts = opts || {};
    var HN = input.HN;
    if (input.storageState !== 'ok' && input.storageState !== 'empty') return { ok: false, code: 'storage_' + String(input.storageState || 'unknown'), message: 'Snapshot not created: saved data could not be read safely. Nothing was changed.' };
    if (!HN || typeof HN.dayState !== 'function') return { ok: false, code: 'unavailable', message: 'Snapshot not created: part of the app did not load. Nothing was changed.' };
    var now = opts.now instanceof Date && !isNaN(opts.now) ? opts.now : new Date();
    var clk = qatarClock(now);
    var rg = checkRange(opts.from, opts.to, clk.date);
    if (!rg.ok) return { ok: false, code: rg.code, message: rg.message };
    var sel = normSelection(opts.selection);
    var ft = sel.freeText;
    var R = input.records || {}, C = input.classic || {};
    var tag = randomTag(opts.rand);
    var snap = { kind: KIND, coachSchemaVersion: SCHEMA_VERSION, notABackup: NOT_A_BACKUP, snapshotId: 'cs-' + clk.compact + '-' + tag, generatedAt: clk.iso,
      timezone: 'Asia/Qatar', dateBasis: 'All date fields are Asia/Qatar calendar dates (YYYY-MM-DD). Timestamps ending in Z are UTC.' };
    if (opts.synthetic === true) snap.synthetic = true;
    snap.source = { origin: 'HYROX tracker, local data on this phone (the source of truth)', dataVersion: typeof input.dataVersion === 'number' ? input.dataVersion : null, storageState: 'ok', appBuild: input.appBuild || null };
    snap.range = { from: rg.from, to: rg.to, days: rg.days };
    snap.selection = sel;
    snap.coverage = {};
    var garminDerived = false;
    ((R && R.daily) || []).forEach(function (d) {
      if (!d) return;
      ['steps', 'intensityMin', 'sleepH'].forEach(function (k) {
        if (d[k] && d[k].source === 'GARMIN_PERSONAL_API') garminDerived = true;
      });
    });
    snap.unavailable = {
      water: { status: 'NOT_RECORDED_IN_APP', note: 'Water intake is not tracked. Absent, not zero.' },
      raceGoal: { status: 'NOT_RECORDED_IN_APP' }, dietaryPreferences: { status: 'NOT_RECORDED_IN_APP' },
      deviceImportedActivity: { status: garminDerived ? 'RECORDED_IN_APP' : 'NOT_RECORDED_IN_APP', note: 'Apple Health is not imported. When steps or Garmin intensity minutes have source GARMIN_PERSONAL_API they are Garmin-derived observations imported from the Personal API, not owner-typed check-ins. When source is GARMIN_MANUAL they are typed by the owner as Garmin shows them (steps.daily).' } };
    snap.semantics = {
      nullMeansUnknown: 'null means unknown or not recorded, never zero. An explicit 0 was entered as 0.',
      macroStates: 'KNOWN (label or exact), ESTIMATED, UNKNOWN (value null); meal and day totals may be PARTIAL (some parts unknown).',
      observationStates: 'OBSERVED, MISSING, DECLINED, NOT_TRACKED, INVALID.',
      mealConfirmation: 'Only CONFIRMED meals carry numbers. Unconfirmed meals are listed by id, date and lifecycle only.',
      dayCodes: 'D1 unlogged, D2 in progress, D3 declared incomplete, D4 complete but not fully quantified, D5 complete and quantified, DF confirmed full-day fast. fullDayKcal is a number only for D5 (0 only for DF), otherwise null.',
      sessionCompletion: 'A session counts as done only when countsAsCompleted is true (status COMPLETED).',
      categories: 'A category key that is absent was not shared. A shared category with no records has empty lists.',
      omittedByOwner: 'Workout block field: true when the owner marked that block as not done (the app field "omitted").',
      basis: 'Meal component basis: PHOTO (seen in the photo), NOTE (named in the owner note, not in the photo), BOTH.',
      staleness: 'A snapshot is a copy from the moment it was created. It does not update.' };
    var damagedBy = {};
    (input.damaged || []).forEach(function (d) { if (d && d.kind === 'DAMAGED') (COLLECTION_CATEGORY[d.collection] || []).forEach(function (k) { damagedBy[k] = (damagedBy[k] || 0) + 1; }); });
    var counts = {}, total = 0;
    function finish(cat, c) {
      c.daysWithData = Object.keys(c._days).length; delete c._days;
      c.excluded.damaged = damagedBy[cat] || 0;
      snap.coverage[cat] = c; counts[cat] = c.recordCount; total += c.recordCount;
    }

    if (sel.training) {
      var ct = cov(), sessions = split(R.sessions, rg, ct), qw = split(C.workouts, rg, ct), walks = split(R.walks, rg, ct), evs = split(R.planEvents, rg, ct);
      sessions.concat(qw, walks, evs).forEach(function (r) { note(ct, r); });
      snap.training = {
        planned: (input.planned || []).filter(function (p) { return p && isDate(p.date) && p.date >= rg.from && p.date <= rg.to; }).map(clone),
        noActivePlanDates: (input.noActivePlanDates || []).filter(function (d) { return isDate(d) && d >= rg.from && d <= rg.to; }),
        sessions: sessions.map(function (s) { return sessionOut(s, ft); }),
        quickWorkouts: qw.map(function (w) { var o = { id: w.id, date: w.date, activity: v(w.activity), durationMin: v(w.durationMin), partial: w.partial === true, createdAt: v(w.createdAt) }; if (ft) o.notes = v(w.notes); return o; }),
        walks: walks.map(function (w) { var o = { id: w.id, date: w.date, durationMin: v(w.durationMin), distanceKm: v(w.distanceKm), steps: v(w.steps), stepsSource: v(w.stepsSource), effort: v(w.effort) }; if (ft) o.notes = v(w.notes); return withQuality(o, w); }),
        planEvents: evs.map(function (e) { return { id: e.id, date: e.date, kind: v(e.kind), week: v(e.week) }; }),
        note: 'Walk and run steps belong to these activities; never add them to a whole-day step total.' };
      finish('training', ct);
    }

    var states = null;
    if (sel.nutrition || sel.goals) {
      var allMeals = (R.meals || []).filter(isObj).concat((C.nutrition || []).filter(isObj).map(HN.legacyToMeal));
      var att = {}; (R.dayStates || []).forEach(function (d) { if (d && isDate(d.date)) att[d.date] = d; });
      states = [];
      for (var i = 0; i < rg.days; i++) { var day = addDays(rg.from, i); states.push(HN.dayState(day, allMeals, att[day] || null)); }
    }
    if (sel.nutrition) {
      var cn = cov(), meals = split(R.meals, rg, cn), quick = split(C.nutrition, rg, cn);
      var confirmed = meals.filter(function (m) { return m.lifecycle === 'CONFIRMED'; }), other = meals.filter(function (m) { return m.lifecycle !== 'CONFIRMED'; });
      confirmed.concat(quick).forEach(function (r) { note(cn, r); });
      cn.excluded.unconfirmed = other.length;
      snap.nutrition = {
        days: states.map(function (s) {
          var a = att[s.date];
          var sub = {}; MACROS.forEach(function (k) { sub[k] = { value: s.subtotal[k].value, mealsWithUnknown: s.subtotal[k].mealsWithUnknown }; });
          return { date: s.date, code: s.code, canonicalCode: s.canonicalCode, label: s.label, attestation: a && !s.staleAttestation ? v(a.attestation) : null,
            fastAnswer: s.fastAnswer, staleAttestation: s.staleAttestation, confirmedCount: s.confirmedCount, pendingCount: s.pendingCount, draftCount: s.draftCount,
            confirmedSubtotal: sub, fullDayKcal: s.dayKcal, caveat: s.caveat };
        }),
        meals: confirmed.map(function (m) { return mealOut(m, ft, HN); }),
        unconfirmedMeals: other.map(function (m) { return { id: m.id, date: m.date, lifecycle: v(m.lifecycle) }; }),
        quickEntries: quick.map(function (e) { var o = { id: e.id, date: e.date, calories: v(e.calories), proteinG: v(e.proteinG), carbsG: null, fatG: null, macroNote: 'Carbs and fat are not recorded in this entry type.' }; if (ft) o.label = v(e.label); return o; }) };
      finish('nutrition', cn);
    }
    if (sel.body) {
      var cb = cov(), wts = split(C.weight, rg, cb), waist = split((R.body || []).filter(function (b) { return b && b.metric === 'waist_cm'; }), rg, cb);
      wts.concat(waist).forEach(function (r) { note(cb, r); });
      snap.body = { weight: wts.map(function (w) { var o = { id: w.id, date: w.date, kg: v(w.kg), createdAt: v(w.createdAt) }; if (ft) o.notes = v(w.notes); return o; }),
        waist: waist.map(function (b) { var o = { id: b.id, date: b.date, state: v(b.state), valueCm: v(b.value) }; if (ft) o.notes = v(b.notes); return withQuality(o, b); }) };
      finish('body', cb);
    }
    var daily = null;
    function dailyIn(c) { var l = split(R.daily, rg, c); return l; }
    if (sel.steps) {
      var cs = cov(); daily = dailyIn(cs);
      var sd = daily.filter(function (d) { return isObj(d.steps) || d.stepTargetOverride != null || (d.intensityMin !== undefined && d.intensityMin !== null); });
      sd.forEach(function (r) { note(cs, r); });
      snap.steps = { daily: sd.map(function (d) { return dailyOut(d, ['steps'], function (o) { o.stepTargetOverride = v(d.stepTargetOverride); o.garminIntensityMin = intensityOut(d.intensityMin); }); }),
        intensityNote: 'garminIntensityMin is the day\u2019s weighted total from Garmin (Garmin already counts vigorous minutes double). When source is GARMIN_PERSONAL_API it is a Garmin-derived observation imported from the Personal API, not an owner-typed check-in. When source is GARMIN_MANUAL it is the total typed by the owner as Garmin shows it. null = not recorded: unknown, not 0. INVALID = a stored value that is not valid: unknown. Never add it to workouts, steps or calories.' };
      finish('steps', cs);
    }
    if (sel.recovery) {
      var cr = cov(), dr = dailyIn(cr).filter(function (d) { return DAILY_RECOVERY.some(function (k) { return isObj(d[k]); }); });
      dr.forEach(function (r) { note(cr, r); });
      snap.recovery = { daily: dr.map(function (d) { return dailyOut(d, DAILY_RECOVERY, ft ? function (o) { o.notes = v(d.notes); } : null); }) };
      finish('recovery', cr);
    }
    if (sel.symptoms) {
      var cy = cov(), dy = dailyIn(cy).filter(function (d) { return DAILY_SYMPTOMS.some(function (k) { return isObj(d[k]); }); });
      dy.forEach(function (r) { note(cy, r); });
      snap.symptoms = { daily: dy.map(function (d) { return dailyOut(d, DAILY_SYMPTOMS); }) };
      finish('symptoms', cy);
    }
    if (sel.goals) {
      var st = input.settings || {}, co = input.coach || {};
      var t = isObj(co.target) ? co.target : null;
      snap.goals = {
        nutritionTarget: t ? { kcal: v(t.kcal), proteinG: v(t.proteinG), proteinFloorG: v(t.proteinFloorG), fatG: v(t.fatG), carbsG: v(t.carbsG),
          origin: v(t.origin), effectiveDate: v(t.effectiveDate),
          status: t.origin === 'PROVISIONAL' ? 'PROVISIONAL_SOURCE_DEFAULT' : 'OWNER_CONFIRMED',
          note: t.origin === 'PROVISIONAL' ? 'Provisional example targets from the training source. Not measured. Not owner-set.' : 'Target the owner confirmed in the app, in effect on the last day of the range.' } : null,
        goal: isObj(co.goal) ? { id: v(co.goal.id), label: v(co.goal.label), setAt: v(co.goal.setAt) } : null,
        stepSettings: { stepBaselineMode: v(st.stepBaselineMode), stepBaselineManual: v(st.stepBaselineManual), stepLightDayPct: v(st.stepLightDayPct),
          stepAfterDemandingPct: v(st.stepAfterDemandingPct), stepHighFatiguePct: v(st.stepHighFatiguePct) } };
      if (sel.recovery) snap.goals.rhrBaselineBpm = v(st.rhrBaselineBpm);
      snap.coverage.goals = { recordCount: 0, note: 'Settings, not dated records.' };
    }
    // Derived (two only, each naming its inputs and coverage).
    var derived = [];
    if (sel.body) {
      var w = snap.body.weight.filter(function (x) { return typeof x.kg === 'number'; });
      derived.push(w.length >= 2
        ? { name: 'weightChange', value: Math.round((w[w.length - 1].kg - w[0].kg) * 10) / 10, unit: 'kg', method: 'last minus first; no smoothing',
          inputs: { collection: 'body.weight', inputIds: [w[0].id, w[w.length - 1].id], observations: w.length, firstDate: w[0].date, lastDate: w[w.length - 1].date, spanDays: daysBetween(w[0].date, w[w.length - 1].date) } }
        : { name: 'weightChange', value: null, unit: 'kg', reason: 'INSUFFICIENT_OBSERVATIONS', inputs: { collection: 'body.weight', observations: w.length } });
    }
    if (sel.nutrition) {
      var av = HN.dayAverages(states), used = states.filter(function (s) { return s.code === 'D5'; }).map(function (s) { return s.date; });
      var exc = {}; states.forEach(function (s) { if (s.code !== 'D5') exc[s.code] = (exc[s.code] || 0) + 1; });
      derived.push({ name: 'eatingDayAverage', value: av.eatingDays.n ? { kcal: av.eatingDays.kcalMean, proteinG: av.eatingDays.proteinMean } : null,
        reason: av.eatingDays.n ? null : 'NO_COMPLETE_QUANTIFIED_DAYS', method: 'mean over D5 days only (the app\u2019s own dayAverages); other days excluded, never counted as 0',
        inputs: { daysUsed: used, daysInRange: rg.days, daysExcluded: exc } });
    }
    snap.derived = derived;
    if (!total) return { ok: false, code: 'empty', message: 'No records in this range for the selected categories. No file was created.' };
    var text = JSON.stringify(snap, null, 1);
    return { ok: true, snapshot: snap, text: text, fileName: 'hyrox-coaching-' + clk.compact + '-' + tag + '.json', counts: counts, total: total,
      categories: CATEGORIES.filter(function (k) { return k !== 'freeText' && sel[k]; }).length };
  }

  /*
   * collect(store, deps) -> input for build(). Uses ONLY the store's read methods (status, records, list, damagedRecords,
   * settings); never a write, never another storage key. deps: { HD, HN, HC, planned, noActivePlanDates, appBuild }.
   */
  function collect(store, deps) {
    deps = deps || {};
    var st;
    try { st = store.status(); } catch (e) { return { storageState: 'unreadable' }; }
    if (!st || (st.state !== 'ok' && st.state !== 'empty')) return { storageState: st ? st.state : 'unreadable' };
    var records = {};
    ['sessions', 'meals', 'body', 'daily', 'walks', 'dayStates', 'planEvents'].forEach(function (t) { try { records[t] = store.records(t); } catch (e) { records[t] = []; } });
    var classic = {};
    ['weight', 'workouts', 'nutrition'].forEach(function (t) { try { classic[t] = store.list(t); } catch (e) { classic[t] = []; } });
    var damaged = []; try { damaged = store.damagedRecords(); } catch (e) { damaged = []; }
    var settings = {}; try { settings = store.settings(); } catch (e) { settings = {}; }
    var coach = { target: null, goal: null };
    if (deps.HC && deps.HN) {
      try {
        var rc = deps.HC.readCoach(settings.record), c = rc.valid ? rc.coach : null, to = deps.to;
        coach.target = deps.HC.targetFor(c, to, deps.HN.PROVISIONAL);
        if (c && c.enabled === true && isObj(c.goal)) { var g = deps.HC.goalById(c.goal.id); coach.goal = { id: c.goal.id, label: g ? g.label : null, setAt: c.goal.setAt }; }
      } catch (e) { coach = { target: null, goal: null }; }
    } else if (deps.HN) coach.target = { kcal: deps.HN.PROVISIONAL.kcal, proteinG: deps.HN.PROVISIONAL.proteinG, proteinFloorG: deps.HN.PROVISIONAL.proteinFloorG, fatG: null, carbsG: null, origin: 'PROVISIONAL', effectiveDate: null };
    return { storageState: 'ok', dataVersion: deps.HD ? deps.HD.VERSION : null, appBuild: deps.appBuild || null, records: records, classic: classic, damaged: damaged,
      settings: settings, coach: coach, planned: deps.planned || [], noActivePlanDates: deps.noActivePlanDates || [], HN: deps.HN };
  }

  return { KIND: KIND, collect: collect, SCHEMA_VERSION: SCHEMA_VERSION, NOT_A_BACKUP: NOT_A_BACKUP, CATEGORIES: CATEGORIES, DEFAULTS: DEFAULTS, LABELS: LABELS,
    FORBIDDEN_WORDS: FORBIDDEN_WORDS, RANGE_PRESETS: RANGE_PRESETS, MAX_DAYS: MAX_DAYS,
    qatarClock: qatarClock, checkRange: checkRange, presetRange: presetRange, normSelection: normSelection, build: build };
});
