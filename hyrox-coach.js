/*
 * hyrox-coach.js - P1.3 Nutrition Coach (CC execution order 23 Nov 2026; HNC-E-NUTR-002 v1.0 + HNC-E-PLAN-003 Part D rev 1.1).
 * Pure functions: this file reads and writes no storage and makes no network request. Plain-JS UMD (window.HyroxCoach / require()).
 *
 * Storage: ONE optional nested object `nutritionCoach` on the existing owner-settings record (id app-settings). The data layer
 * (hyrox-data.js, unchanged) keeps fields it does not know in storage, export and restore, so the data version stays 2. Because
 * the data layer does not validate this object, every reader here validates it and treats anything malformed as INVALID: the
 * coach then shows nothing, proposes nothing and refuses to write until the owner resets ONLY this object.
 *
 * SAFE NUMERICAL GATE. Every number below marked PROVISIONAL is a placeholder for owner (and, where stated, clinician) review.
 * None is an individual clinical safety limit. Provisional figures are used here only to WITHHOLD a computed suggestion
 * (the conservative direction) or to show a warning - never to produce a more aggressive number, never to change a target
 * automatically. A 2 lb/week computed target and any numeric adjustment proposal are DISABLED (see OPEN_GATES).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HyroxCoach = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 'coach-1';
  var FIELD = 'nutritionCoach';
  var SCHEMA = 1;
  var CM_PER_IN = 2.54;
  var LB_PER_KG = 2.2046226218487757;
  var HISTORY_MAX = 12;
  var REASON_MAX = 200;
  // Data-entry ranges (sanity, not clinical): outside these nothing is written.
  var RANGE = { heightCm: [100, 250], ageYears: [18, 100], kcal: [1000, 6000], proteinG: [0, 400], fatG: [0, 300], carbsG: [0, 1000] };
  // The four goals the owner chooses from (lb per week; negative = loss). Never a promised rate.
  var GOALS = [
    { id: 'LOSE_1', lbPerWeek: -1, label: 'Lose 1 lb a week', note: 'Recommended to start.' },
    { id: 'LOSE_2', lbPerWeek: -2, label: 'Lose 2 lb a week', note: 'Faster loss is gated: no computed 2 lb/week target is offered yet (open gate G-RATE).' },
    { id: 'MAINTAIN', lbPerWeek: 0, label: 'Maintain', note: '' },
    { id: 'GAIN_1', lbPerWeek: 1, label: 'Gain 1 lb a week', note: 'The app does not claim a gain is muscle.' }];
  // PROVISIONAL activity assumptions for the STARTING estimate only (HNC-E-NUTR-002 D-7). The factor already stands for
  // training and steps: logged workouts, steps and Garmin minutes are never added on top.
  var ACTIVITY = [
    { id: 'A1', factor: 1.3, label: 'Mostly sitting during the day; training sessions on top' },
    { id: 'A2', factor: 1.45, label: 'Some walking most days, plus regular training' },
    { id: 'A3', factor: 1.6, label: 'On my feet a lot, or long training most days' },
    { id: 'A4', factor: 1.75, label: 'Physically hard job, or very high training volume' }];
  var KCAL_PER_LB_WEEK = 500;     // conventional "3,500 kcal per lb" rule / 7 days (Hall & Chow 2013: approximate; over-predicts over time)
  var FAT_SHARE = 0.25;           // PROVISIONAL default for a computed suggestion; inside the 20-35 % adult AMDR (IOM/NASEM)
  var FAT_SHARE_WARN = 0.20;      // AMDR lower bound: below it a warning (not a block)
  var CARB_RDA_G = 130;           // IOM/NASEM carbohydrate RDA for adults: below it a computed suggestion is withheld, an entered one warned
  var PROVISIONAL_FLOOR = { MALE: 1500, FEMALE: 1200 }; // PROVISIONAL (HNC-E-NUTR-002 S-02) - screening only
  var DEFICIT_SCREEN = 0.30;      // PROVISIONAL (S-03) - screening only
  var RATE_SCREEN = 0.01;         // PROVISIONAL (S-04 / D-R2) - share of body weight per week; above it a computed loss target is withheld
  var RATE_PREFERRED = 0.007;     // PROVISIONAL (D-R2) - above it the rate is labelled "faster than preferred"
  var OPEN_GATES = [
    { id: 'G-RATE', text: 'Loss-rate limits (preferred about 0.5-0.7 % of body weight a week, nothing computed above about 1 %): provisional. Until reviewed, no computed 2 lb/week target is offered.' },
    { id: 'G-FLOOR', text: 'Energy floor (the higher of 1,500 kcal for men / 1,200 for women and the resting estimate): provisional. Used only to withhold a computed suggestion and to warn on an entered target.' },
    { id: 'G-DEFICIT', text: 'Deficit cap (30 % below the maintenance estimate): provisional, used only to withhold a computed suggestion.' },
    { id: 'G-PROTEIN', text: 'Protein: the existing provisional 190 g reference / 170 g floor stays until you enter and confirm your own figure. No weight-based protein target is computed.' },
    { id: 'G-ADJUST', text: 'Fixed weekly adjustment steps (e.g. 150 kcal): disabled. A LOWER computed target is offered only after the Monday review finds 2 qualifying weeks under the current target with slower loss than half the goal rate, enough food coverage and no recovery, rapid-loss or low-intake flag. Nothing changes until you confirm.' },
    { id: 'G-STAGEB', text: 'Personal estimate thresholds (28 days; 3 weigh-ins and 4 complete days incl. a weekend day in at least 3 of 4 weeks): provisional; revisit after real use.' },
    { id: 'G-STATUS', text: 'Status bands (green within half to 1.5x the goal rate; amber above 1 %/week; red above 1.5 %/week for 2 weeks or recovery flags): provisional.' }];

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function fmtKcal(n) { return Math.round(n).toLocaleString('en-US'); }
  // P1.3-RC3 (owner decision 5): computed calorie ESTIMATES are SHOWN rounded to the nearest 50 kcal (ties up). Display only:
  // stored values, calculations, suggested targets, own targets and every alert boundary keep their exact values.
  function roundKcal50(n) { return isNum(n) ? Math.floor(n / 50 + 0.5) * 50 : null; }
  function estimateKcalText(n) { var r = roundKcal50(n); return r === null ? '' : 'about ' + fmtKcal(r) + ' kcal'; }
  function isIsoDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var d = new Date(v + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }
  function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
  function round1(n) { return Math.round((n + Number.EPSILON) * 10) / 10; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function inRange(v, k) { return isNum(v) && v >= RANGE[k][0] && v <= RANGE[k][1]; }
  function goalById(id) { return GOALS.filter(function (g) { return g.id === id; })[0] || null; }
  function activityById(id) { return ACTIVITY.filter(function (a) { return a.id === id; })[0] || null; }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  // ---------- validation of the stored object ----------
  function validateTargetShape(t, path, errs) {
    if (!isObj(t)) { errs.push(path + ' must be an object'); return; }
    if (!inRange(t.kcal, 'kcal') || !Number.isInteger(t.kcal)) errs.push(path + '.kcal must be a whole number ' + RANGE.kcal.join('-'));
    if (!inRange(t.proteinG, 'proteinG') || !Number.isInteger(t.proteinG)) errs.push(path + '.proteinG must be a whole number ' + RANGE.proteinG.join('-'));
    ['fatG', 'carbsG'].forEach(function (k) { if (t[k] !== null && t[k] !== undefined && (!inRange(t[k], k) || !Number.isInteger(t[k]))) errs.push(path + '.' + k + ' must be empty or a whole number ' + RANGE[k].join('-')); });
    if (t.origin !== 'COMPUTED' && t.origin !== 'OWNER_ENTERED') errs.push(path + '.origin must be COMPUTED or OWNER_ENTERED');
    if (!isIsoDate(t.effectiveDate)) errs.push(path + '.effectiveDate must be a date');
    if (typeof t.confirmedAt !== 'string' || isNaN(Date.parse(t.confirmedAt))) errs.push(path + '.confirmedAt must be a time');
    if (t.reason !== undefined && t.reason !== null && (typeof t.reason !== 'string' || t.reason.length > REASON_MAX)) errs.push(path + '.reason must be short text');
    if (isNum(t.kcal) && isNum(t.proteinG) && macroKcal(t) > t.kcal) errs.push(path + ': protein, fat and carbs add up to more than the calories');
  }
  function validateCoach(c) {
    var errs = [];
    if (!isObj(c)) return ['nutritionCoach must be an object'];
    if (c.schema !== SCHEMA) errs.push('nutritionCoach.schema must be ' + SCHEMA);
    if (c.enabled !== undefined && typeof c.enabled !== 'boolean') errs.push('enabled must be true or false');
    var p = c.profile;
    if (p !== undefined && p !== null) {
      if (!isObj(p)) errs.push('profile must be an object');
      else {
        if (p.heightCm !== null && p.heightCm !== undefined && !inRange(p.heightCm, 'heightCm')) errs.push('profile.heightCm must be ' + RANGE.heightCm.join('-') + ' cm');
        if (p.heightUnit !== undefined && p.heightUnit !== 'cm' && p.heightUnit !== 'ftin') errs.push('profile.heightUnit must be cm or ftin');
        if (p.ageYears !== null && p.ageYears !== undefined && (!inRange(p.ageYears, 'ageYears') || !Number.isInteger(p.ageYears))) errs.push('profile.ageYears must be a whole number ' + RANGE.ageYears.join('-'));
        ['ageEnteredOn', 'ageConfirmedOn'].forEach(function (k) { if (p[k] !== null && p[k] !== undefined && !isIsoDate(p[k])) errs.push('profile.' + k + ' must be a date'); });
        if (p.estimateMethod !== undefined && p.estimateMethod !== 'EQUATION' && p.estimateMethod !== 'NONE') errs.push('profile.estimateMethod must be EQUATION or NONE');
        if (p.sexForEquation !== null && p.sexForEquation !== undefined && p.sexForEquation !== 'MALE' && p.sexForEquation !== 'FEMALE') errs.push('profile.sexForEquation must be MALE or FEMALE');
        if (p.activity !== null && p.activity !== undefined && !activityById(p.activity)) errs.push('profile.activity is not one of the choices');
      }
    }
    if (c.goal !== undefined && c.goal !== null) {
      if (!isObj(c.goal) || !goalById(c.goal.id)) errs.push('goal is not one of the four goals');
      else if (!isIsoDate(c.goal.setAt)) errs.push('goal.setAt must be a date');
    }
    if (c.target !== undefined && c.target !== null) validateTargetShape(c.target, 'target', errs);
    if (c.history !== undefined) {
      if (!Array.isArray(c.history) || c.history.length > HISTORY_MAX) errs.push('history must be a list of at most ' + HISTORY_MAX);
      else c.history.forEach(function (t, i) { validateTargetShape(t, 'history[' + i + ']', errs); });
    }
    return errs;
  }
  // { present, valid, coach (a copy, or null), problems }
  function readCoach(settingsRecord) {
    var raw = isObj(settingsRecord) ? settingsRecord[FIELD] : undefined;
    if (raw === undefined || raw === null) return { present: false, valid: true, coach: null, problems: [] };
    var errs = validateCoach(raw);
    return errs.length ? { present: true, valid: false, coach: null, problems: errs } : { present: true, valid: true, coach: clone(raw), problems: [] };
  }
  function emptyCoach() { return { schema: SCHEMA, enabled: false, profile: null, goal: null, target: null, history: [] }; }
  // Field-preserving: a copy of the FRESH stored settings record where only nutritionCoach is replaced (or removed with null).
  function withCoach(freshRecord, coach, settingsId, todayIso) {
    var rec = freshRecord ? clone(freshRecord) : { id: settingsId };
    if (!rec.date) rec.date = todayIso;
    if (coach === null) delete rec[FIELD]; else rec[FIELD] = clone(coach);
    return rec;
  }

  // ---------- profile helpers ----------
  function ftInToCm(ft, inch) {
    if (!isNum(ft) || !isNum(inch) || ft < 0 || inch < 0 || inch >= 12) return null;
    return round1((ft * 12 + inch) * CM_PER_IN);
  }
  function cmToFtIn(cm) { if (!isNum(cm)) return null; var t = cm / CM_PER_IN, ft = Math.floor(t / 12), inch = round1(t - ft * 12); if (inch >= 12) { ft++; inch = 0; } return { ft: ft, inch: inch }; }
  // Parses typed profile input. Returns { ok, profile, errors }. Nothing is guessed: blank stays null.
  function parseProfile(input, todayIso, prev) {
    var errs = {}, p = { heightUnit: input.heightUnit === 'ftin' ? 'ftin' : 'cm' };
    function num(v) { var t = String(v == null ? '' : v).trim().replace(',', '.'); return t === '' ? null : (/^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN); }
    if (p.heightUnit === 'cm') {
      var h = num(input.heightCm);
      if (h === null) p.heightCm = null; else if (!inRange(h, 'heightCm')) errs.height = 'Height must be ' + RANGE.heightCm[0] + '–' + RANGE.heightCm[1] + ' cm.'; else p.heightCm = round1(h);
    } else {
      var ft = num(input.heightFt), inch = num(input.heightIn);
      if (ft === null && inch === null) p.heightCm = null;
      else { var cm = ftInToCm(ft === null ? NaN : ft, inch === null ? 0 : inch); if (cm === null || !inRange(cm, 'heightCm') || !Number.isInteger(ft)) errs.height = 'Height must be whole feet and 0–11.9 inches (' + RANGE.heightCm[0] + '–' + RANGE.heightCm[1] + ' cm).'; else p.heightCm = cm; }
    }
    var a = num(input.ageYears);
    if (a === null) { p.ageYears = null; p.ageEnteredOn = null; p.ageConfirmedOn = null; }
    else if (!inRange(a, 'ageYears') || !Number.isInteger(a)) errs.age = 'Age must be a whole number of years, ' + RANGE.ageYears[0] + '–' + RANGE.ageYears[1] + '.';
    else {
      p.ageYears = a;
      var same = prev && prev.ageYears === a && isIsoDate(prev.ageEnteredOn);
      p.ageEnteredOn = same ? prev.ageEnteredOn : todayIso;
      p.ageConfirmedOn = input.confirmAge || !same || !isIsoDate(prev.ageConfirmedOn) ? todayIso : prev.ageConfirmedOn;
    }
    p.estimateMethod = input.estimateMethod === 'EQUATION' ? 'EQUATION' : 'NONE';
    // Sex is asked, and kept, only for the equation-based estimate; never defaulted.
    p.sexForEquation = p.estimateMethod === 'EQUATION' && (input.sexForEquation === 'MALE' || input.sexForEquation === 'FEMALE') ? input.sexForEquation : null;
    p.activity = activityById(input.activity) ? input.activity : null;
    var ok = !Object.keys(errs).length;
    return { ok: ok, profile: ok ? p : null, errors: errs };
  }
  // Age is never advanced automatically (no birthday is inferred from the entry date); it is re-confirmed yearly.
  function ageStatus(profile, todayIso) {
    if (!profile || !isNum(profile.ageYears)) return { years: null, needsConfirm: false, confirmedOn: null };
    var c = isIsoDate(profile.ageConfirmedOn) ? profile.ageConfirmedOn : profile.ageEnteredOn;
    var due = c ? addDays(c, 365) : null;
    return { years: profile.ageYears, confirmedOn: c, dueOn: due, needsConfirm: !!due && todayIso >= due };
  }

  // ---------- targets ----------
  function macroKcal(t) { return 4 * (t.proteinG || 0) + 4 * (t.carbsG || 0) + 9 * (t.fatG || 0); }
  // Reference in force on a date: the confirmed target whose effective date is the latest on or before that date (ties: the
  // later confirmation); otherwise the provisional reference (HN.PROVISIONAL), unchanged. Coach off -> provisional.
  function targetFor(coach, dateIso, provisional) {
    var fallback = { kcal: provisional.kcal, proteinG: provisional.proteinG, proteinFloorG: provisional.proteinFloorG, fatG: null, carbsG: null, origin: 'PROVISIONAL', effectiveDate: null };
    if (!coach || coach.enabled !== true || !Array.isArray(coach.history)) return fallback;
    var best = null;
    coach.history.forEach(function (t) {
      if (!t || !isIsoDate(t.effectiveDate) || t.effectiveDate > dateIso) return;
      if (!best || t.effectiveDate > best.effectiveDate || (t.effectiveDate === best.effectiveDate && String(t.confirmedAt) > String(best.confirmedAt))) best = t;
    });
    return best ? clone(best) : fallback;
  }
  // Checks a target typed by the owner. errors block saving; warnings are shown and the owner may still confirm.
  // ctx: { restingKcal|null, sex|null, currentKcal|null }
  function checkOwnerTarget(input, ctx) {
    ctx = ctx || {};
    var errs = [], warn = [], t = {};
    function num(v) { var s = String(v == null ? '' : v).trim().replace(/[,\s]/g, ''); return s === '' ? null : (/^\d+$/.test(s) ? Number(s) : NaN); }
    [['kcal', 'Calories'], ['proteinG', 'Protein'], ['fatG', 'Fat'], ['carbsG', 'Carbs']].forEach(function (k) {
      var v = num(input[k[0]]);
      if (v === null) { if (k[0] === 'kcal' || k[0] === 'proteinG') errs.push(k[1] + ' is needed.'); t[k[0]] = null; return; }
      if (isNaN(v) || !inRange(v, k[0])) { errs.push(k[1] + ' must be a whole number from ' + RANGE[k[0]][0] + ' to ' + RANGE[k[0]][1] + '.'); return; }
      t[k[0]] = v;
    });
    if (!errs.length) {
      var mk = macroKcal(t);
      if (mk > t.kcal) errs.push('Protein, fat and carbs add up to ' + mk + ' kcal, more than the ' + t.kcal + ' kcal target. Lower a macro or raise calories.');
      else {
        // P1.3-RC3 (owner decision 1): an own target below the provisional floor is REFUSED - never clamped, never changed.
        // Floor = the higher of 1,500 kcal (men; also when sex is not given) / 1,200 kcal (women) and the EXACT resting estimate.
        var floor = Math.max(ctx.sex === 'FEMALE' ? PROVISIONAL_FLOOR.FEMALE : PROVISIONAL_FLOOR.MALE, isNum(ctx.restingKcal) ? ctx.restingKcal : 0);
        if (t.kcal < floor) errs.push(fmtKcal(t.kcal) + ' kcal is below the provisional floor of ' + fmtKcal(floor) + ' kcal (' + (isNum(ctx.restingKcal) && ctx.restingKcal >= (ctx.sex === 'FEMALE' ? PROVISIONAL_FLOOR.FEMALE : PROVISIONAL_FLOOR.MALE) ? 'your resting estimate' : 'the general floor') +
          '), so it is not accepted here. The floor is a provisional product default, not a medical rule; a lower target would need a separate, clinician-supervised arrangement.');
        if (t.proteinG < 170) warn.push({ code: 'PROTEIN_BELOW_REFERENCE_FLOOR', text: 'Protein is below the existing provisional 170 g reference floor.' });
        if (t.fatG !== null && t.fatG * 9 < FAT_SHARE_WARN * t.kcal) warn.push({ code: 'FAT_LOW', text: 'Fat is under 20 % of calories (the lower end of the usual adult range).' });
        var carbs = t.carbsG !== null ? t.carbsG : t.fatG !== null ? Math.floor((t.kcal - 4 * t.proteinG - 9 * t.fatG) / 4) : null;
        if (carbs !== null && carbs < CARB_RDA_G) warn.push({ code: 'CARBS_LOW', text: 'Carbs ' + (t.carbsG === null ? '(the remainder) ' : '') + 'are ' + carbs + ' g, under 130 g a day. Review fueling for training days.' });
        if (t.fatG !== null && t.carbsG !== null && t.kcal - mk > 100) warn.push({ code: 'UNASSIGNED', text: (t.kcal - mk) + ' kcal are not assigned to protein, fat or carbs.' });
        if (isNum(ctx.currentKcal) && Math.abs(t.kcal - ctx.currentKcal) > 500) warn.push({ code: 'LARGE_CHANGE', text: 'A change of more than 500 kcal from your current reference (' + ctx.currentKcal + ' kcal).' });
      }
    }
    return { ok: !errs.length, target: errs.length ? null : t, errors: errs, warnings: errs.length ? [] : warn };
  }
  // A confirmed target: the coach object to save (old/new kept in history with the reason). Never called without the owner's
  // explicit confirmation in the UI. effectiveDate: today .. today+14.
  function confirmTarget(coach, t, opts) {
    var c = coach ? clone(coach) : emptyCoach();
    if (!isIsoDate(opts.effectiveDate) || opts.effectiveDate < opts.today || opts.effectiveDate > addDays(opts.today, 14)) return { ok: false, error: 'The effective date must be today or within the next 14 days.' };
    var rec = { kcal: t.kcal, proteinG: t.proteinG, fatG: t.fatG === undefined ? null : t.fatG, carbsG: t.carbsG === undefined ? null : t.carbsG,
      origin: opts.origin, method: opts.origin === 'COMPUTED' ? (opts.method === 'STAGE_B_GOAL' ? 'STAGE_B_GOAL' : 'MSJ_ACTIVITY_GOAL') : 'OWNER', effectiveDate: opts.effectiveDate, confirmedAt: opts.nowIso,
      reason: String(opts.reason || '').slice(0, REASON_MAX), version: VERSION, goal: c.goal ? c.goal.id : null,
      inputs: opts.inputs ? clone(opts.inputs) : null, warnings: (opts.warnings || []).map(function (w) { return w.code || String(w); }),
      replaced: opts.previous ? { kcal: opts.previous.kcal, proteinG: opts.previous.proteinG, fatG: opts.previous.fatG === undefined ? null : opts.previous.fatG, carbsG: opts.previous.carbsG === undefined ? null : opts.previous.carbsG, origin: opts.previous.origin } : null };
    var errs = []; validateTargetShape(rec, 'target', errs);
    if (errs.length) return { ok: false, error: errs.join('; ') };
    c.target = rec;
    c.history = (Array.isArray(c.history) ? c.history : []).concat([rec]).slice(-HISTORY_MAX);
    if (c.enabled !== true) c.enabled = true;
    return { ok: true, coach: c, target: rec };
  }


  // ======================= P1.3 Delivery C: starting estimate (Stage A), proposals, personal estimate (Stage B) =======================
  // Pure local arithmetic. Inputs are the owner's own dated records passed in by the UI; nothing is fetched, nothing is stored.
  var KCAL_PER_KG = 7700;          // conventional energy content of 1 kg body-weight change (Hall & Chow 2013: approximate)
  var KG_PER_LB = 0.45359237;
  var WEIGHT_MEAN_DAYS = 7, WEIGHT_STALE_DAYS = 14;
  // PROVISIONAL (HNC-E-NUTR-002 5.2 + Part D D-R10): 4 completed review weeks; a week qualifies with >= 3 weigh-in days,
  // >= 4 complete quantified (D5) days and >= 1 complete weekend day (Sat/Sun); Stage B needs >= 3 qualifying weeks.
  var STAGEB = { weeks: 4, minWeighDays: 3, minD5: 4, minWeekendD5: 1, minQualifyingWeeks: 3 };

  function validWeights(weights, today) {
    var byDate = {};
    (Array.isArray(weights) ? weights : []).forEach(function (w) {
      if (!w || !isIsoDate(w.date) || w.date > today || !isNum(w.kg) || w.kg < 30 || w.kg > 350) return;
      (byDate[w.date] = byDate[w.date] || []).push(w.kg);
    });
    // one value per day (the mean of that day's weigh-ins): three weigh-ins in one morning are one day of evidence
    return Object.keys(byDate).sort().map(function (d) { var a = byDate[d]; return { date: d, kg: a.reduce(function (x, y) { return x + y; }, 0) / a.length, n: a.length }; });
  }
  // Recent weight for the starting estimate: the mean of the weigh-in days in the last 7 days; otherwise the latest one within
  // 14 days; otherwise none (stale). Never extrapolated, never filled in.
  function recentWeight(weights, today) {
    var v = validWeights(weights, today);
    var last7 = v.filter(function (w) { return daysBetween(w.date, today) < WEIGHT_MEAN_DAYS; });
    if (last7.length) return { ok: true, kg: round1(last7.reduce(function (a, w) { return a + w.kg; }, 0) / last7.length), days: last7.length, from: last7[0].date, to: last7[last7.length - 1].date, basis: 'MEAN_7D' };
    var last14 = v.filter(function (w) { return daysBetween(w.date, today) < WEIGHT_STALE_DAYS; });
    if (last14.length) { var l = last14[last14.length - 1]; return { ok: true, kg: round1(l.kg), days: 1, from: l.date, to: l.date, basis: 'LATEST_14D' }; }
    var latest = v.length ? v[v.length - 1].date : null;
    return { ok: false, code: latest ? 'STALE' : 'NONE', latestDate: latest,
      text: latest ? 'Your latest weigh-in (' + latest + ') is more than 14 days old. Weigh in to get a starting estimate.' : 'No weigh-in recorded yet. Weigh in to get a starting estimate.' };
  }
  // Mifflin-St Jeor resting energy expenditure (Mifflin et al., Am J Clin Nutr 1990;51:241-247):
  // 10 x kg + 6.25 x cm - 5 x years + 5 (men) or - 161 (women). Returns the unrounded value.
  function mifflin(kg, cm, years, sex) {
    if (!isNum(kg) || !isNum(cm) || !isNum(years) || (sex !== 'MALE' && sex !== 'FEMALE')) return null;
    return 10 * kg + 6.25 * cm - 5 * years + (sex === 'MALE' ? 5 : -161);
  }
  // Stage A. Everything it needs, or the exact list of what is missing. Rounding: resting and maintenance are rounded to whole
  // kcal at the end (maintenance = round(unrounded resting x factor)).
  function startingEstimate(coach, weights, today) {
    var p = coach && isObj(coach.profile) ? coach.profile : {}, need = [];
    if (p.estimateMethod !== 'EQUATION') return { ok: false, code: 'NO_EQUATION', need: ['You chose "no computed estimate". Enter your own target, or choose the equation in Profile.'] };
    if (!inRange(p.heightCm, 'heightCm')) need.push('height');
    if (!inRange(p.ageYears, 'ageYears')) need.push('age');
    else if (ageStatus(p, today).needsConfirm) need.push('age confirmation (yearly)');
    if (p.sexForEquation !== 'MALE' && p.sexForEquation !== 'FEMALE') need.push('the sex used by the equation');
    var act = activityById(p.activity);
    if (!act) need.push('usual activity');
    var w = recentWeight(weights, today);
    if (!w.ok) need.push(w.code === 'STALE' ? 'a weigh-in in the last 14 days' : 'a weigh-in');
    if (need.length) return { ok: false, code: 'NEEDS_INPUT', need: need, weight: w };
    var raw = mifflin(w.kg, p.heightCm, p.ageYears, p.sexForEquation);
    return { ok: true, approximate: true, version: VERSION, resting: Math.round(raw), restingRaw: raw, factor: act.factor, activity: act.id,
      maintenance: Math.round(raw * act.factor), weight: w,
      inputs: { weightKg: w.kg, weightBasis: w.basis, weightFrom: w.from, weightTo: w.to, weightDays: w.days, heightCm: p.heightCm, ageYears: p.ageYears,
        sexForEquation: p.sexForEquation, activity: act.id, factor: act.factor, method: 'MIFFLIN_ST_JEOR_x_ACTIVITY' } };
  }
  // Macros for a computed suggestion. Protein: the reference in force (never derived from weight). Fat: 25 % of kcal, rounded to
  // whole g. Carbohydrate: the remainder, rounded DOWN to whole g so protein + fat + carbs kcal never exceed the total.
  function macrosFor(kcal, proteinG) {
    var fat = Math.round(kcal * FAT_SHARE / 9);
    var carbs = Math.floor((kcal - 4 * proteinG - 9 * fat) / 4);
    return { kcal: kcal, proteinG: proteinG, fatG: fat, carbsG: carbs };
  }
  // A computed target for the chosen goal from a maintenance figure, with every PROVISIONAL screen applied. It is a proposal only:
  // state AVAILABLE (may be confirmed), GATED (withheld, with the rule that withheld it), HELD (a reduction withheld because of a
  // concern or because the weekly-review conditions are not met) or NEEDS_INPUT.
  // ctx: { maintenance, resting, source: 'STAGE_A'|'STAGE_B', weightKg, sex, goalId, current: target in force, concerns: [text],
  //        reductionAllowed: bool, reductionWhy: text }
  function proposal(ctx) {
    var g = goalById(ctx && ctx.goalId);
    if (!g) return { state: 'NEEDS_INPUT', gates: [], warnings: [], text: 'Choose a goal first.' };
    if (!isNum(ctx.maintenance)) return { state: 'NEEDS_INPUT', gates: [], warnings: [], text: 'No maintenance estimate yet.' };
    var delta = g.lbPerWeek * KCAL_PER_LB_WEEK, kcal = Math.round(ctx.maintenance + delta), gates = [], warnings = [];
    var cur = ctx.current || {}, protein = isNum(cur.proteinG) ? cur.proteinG : 190;
    if (g.id === 'LOSE_2') gates.push({ id: 'G-RATE', text: 'A computed 2 lb/week target is not offered in this release (open gate G-RATE). You can still enter and confirm your own target, with the warnings shown.' });
    if (g.lbPerWeek < 0) {
      var floor = Math.max(PROVISIONAL_FLOOR[ctx.sex === 'FEMALE' ? 'FEMALE' : 'MALE'], isNum(ctx.resting) ? ctx.resting : 0);
      if (kcal < floor) gates.push({ id: 'G-FLOOR', text: 'It would be ' + kcal + ' kcal, below the provisional floor of ' + floor + ' kcal.' });
      if (-delta / ctx.maintenance > DEFICIT_SCREEN) gates.push({ id: 'G-DEFICIT', text: 'It would be ' + Math.round(-delta / ctx.maintenance * 100) + ' % below the maintenance estimate (provisional limit 30 %).' });
      if (isNum(ctx.weightKg)) {
        var share = (-g.lbPerWeek * KG_PER_LB) / ctx.weightKg;
        if (share > RATE_SCREEN) gates.push({ id: 'G-RATE', text: 'The goal rate is about ' + round1(share * 100) + ' % of body weight a week (provisional limit about 1 %).' });
        else if (share > RATE_PREFERRED) warnings.push('The goal rate is about ' + round1(share * 100) + ' % of body weight a week: faster than the preferred 0.5-0.7 % (provisional). Consider discussing it with a clinician.');
      }
    }
    var m = macrosFor(kcal, protein);
    if (m.carbsG < 0) gates.push({ id: 'IMPOSSIBLE', text: 'Protein ' + protein + ' g and fat ' + m.fatG + ' g alone exceed ' + kcal + ' kcal.' });
    else if (m.carbsG < CARB_RDA_G) gates.push({ id: 'LOW_CARB', text: 'Carbohydrate would be only ' + m.carbsG + ' g after protein and fat (below the adult RDA of 130 g). The coach does not silently cut carbohydrate; review fueling or enter your own target.' });
    var lower = isNum(cur.kcal) && kcal < cur.kcal;
    // the dedupe keeps one G-RATE line
    gates = gates.filter(function (x, i) { return gates.map(function (y) { return y.id; }).indexOf(x.id) === i || x.id !== 'G-RATE'; });
    var state = gates.length ? 'GATED' : 'AVAILABLE', held = [];
    if (!gates.length && lower && (ctx.concerns || []).length) { state = 'HELD'; held = ctx.concerns.slice(); }
    else if (!gates.length && lower && ctx.reductionAllowed === false) { state = 'HELD'; held = [ctx.reductionWhy || 'A lower target is offered only after the Monday review.']; }
    return { state: state, goal: g.id, source: ctx.source, target: m, delta: delta, maintenance: Math.round(ctx.maintenance), gates: gates, warnings: warnings, held: held,
      arithmetic: 'Maintenance estimate ' + Math.round(ctx.maintenance) + ' kcal ' + (delta < 0 ? '- ' + -delta : '+ ' + delta) + ' kcal (conventional ' + KCAL_PER_LB_WEEK + ' kcal a day per lb a week) = ' + kcal + ' kcal. Protein ' + protein + ' g (reference in force) = ' + 4 * protein + ' kcal; fat 25 % = ' + m.fatG + ' g = ' + 9 * m.fatG + ' kcal; carbohydrate the remainder = ' + m.carbsG + ' g = ' + 4 * m.carbsG + ' kcal (rounded down).' };
  }

  // ---- review weeks: completed MONDAY-SUNDAY weeks in Asia/Qatar dates (the same weeks as the training plan, the Garmin
  // weekly sum and every other weekly figure in the app). Monday is review day: it covers the week that ended the day before.
  // On Sunday the current week is still open, so the review still covers the week before (independent review C2, 23 Nov 2026).
  function dow(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); } // 0 = Sunday
  function lastCompletedSunday(today) { var back = dow(today) || 7; return addDays(today, -back); }
  function isReviewDay(today) { return isIsoDate(today) && dow(today) === 1; }
  function reviewWeeks(today, n) {
    var end = lastCompletedSunday(today), out = [];
    for (var i = n - 1; i >= 0; i--) { var we = addDays(end, -7 * i); out.push({ start: addDays(we, -6), end: we }); }
    return out;
  }
  // Per-week facts for the review and Stage B. days: [{date, code, kcal (D5 only), estKcal, proteinG}] from the app's own day
  // states (D1-D5, DF); weights: dated weigh-ins. Missing, pending, unknown, D1-D4 days carry no intake figure; DF is counted apart.
  function weekFacts(wk, days, wts) {
    var inW = function (d) { return d >= wk.start && d <= wk.end; };
    var dd = (days || []).filter(function (x) { return x && inW(x.date); });
    var d5 = dd.filter(function (x) { return x.code === 'D5' && isNum(x.kcal); });
    var weigh = wts.filter(function (w) { return inW(w.date); });
    var kcalSum = d5.reduce(function (a, x) { return a + x.kcal; }, 0), est = d5.reduce(function (a, x) { return a + (isNum(x.estKcal) ? x.estKcal : 0); }, 0);
    var f = { start: wk.start, end: wk.end, weighDays: weigh.length, meanKg: weigh.length >= STAGEB.minWeighDays ? round1(weigh.reduce(function (a, w) { return a + w.kg; }, 0) / weigh.length) : null,
      d5: d5.length, weekendD5: d5.filter(function (x) { var k = dow(x.date); return k === 0 || k === 6; }).length,
      fastDays: dd.filter(function (x) { return x.code === 'DF'; }).length, excludedDays: 7 - d5.length - dd.filter(function (x) { return x.code === 'DF'; }).length,
      kcalSum: kcalSum, estKcal: est, kcalMean: d5.length ? Math.round(kcalSum / d5.length) : null,
      lowIntakeDays: 0, shortfall: [] };
    if (f.weighDays < STAGEB.minWeighDays) f.shortfall.push(f.weighDays + ' weigh-in day' + (f.weighDays === 1 ? '' : 's') + ' (' + STAGEB.minWeighDays + ' needed)');
    if (f.d5 < STAGEB.minD5) f.shortfall.push(f.d5 + ' complete day' + (f.d5 === 1 ? '' : 's') + ' (' + STAGEB.minD5 + ' needed)');
    if (f.weekendD5 < STAGEB.minWeekendD5) f.shortfall.push('no complete weekend day (1 needed)');
    f.weightOk = f.weighDays >= STAGEB.minWeighDays;
    f.qualifies = f.shortfall.length === 0;
    return f;
  }
  // Least-squares slope of daily weights against day number, in kg per week. Needs >= 2 distinct days.
  function slopeKgPerWeek(pts) {
    if (pts.length < 2) return null;
    var x0 = pts[0].date, xs = pts.map(function (p) { return daysBetween(x0, p.date); }), ys = pts.map(function (p) { return p.kg; });
    var mx = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length, my = ys.reduce(function (a, b) { return a + b; }, 0) / ys.length;
    var num = 0, den = 0; for (var i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) * (xs[i] - mx); }
    return den ? num / den * 7 : null;
  }
  // Stage B: observed maintenance = mean intake on D5 days - weight trend (kg/week) x 7,700 / 7, using ONLY the qualifying weeks,
  // so intake and weight come from the same dates. Not ready -> the exact shortfall per week; never a zero, never a guess.
  function stageB(days, weights, today) {
    var wts = validWeights(weights, today), weeks = reviewWeeks(today, STAGEB.weeks).map(function (wk) { return weekFacts(wk, days, wts); });
    var q = weeks.filter(function (w) { return w.qualifies; });
    var base = { weeks: weeks, qualifying: q.length, needed: STAGEB.minQualifyingWeeks, window: { from: weeks[0].start, to: weeks[weeks.length - 1].end } };
    if (q.length < STAGEB.minQualifyingWeeks) {
      return Object.assign(base, { ready: false, coverage: 'LOW',
        text: 'Not enough data for a personal estimate: ' + q.length + ' of ' + STAGEB.weeks + ' completed weeks qualify (' + STAGEB.minQualifyingWeeks + ' needed).',
        shortfall: weeks.filter(function (w) { return !w.qualifies; }).map(function (w) { return { start: w.start, end: w.end, text: w.shortfall.join('; ') }; }) });
    }
    var inQ = function (d) { return q.some(function (w) { return d >= w.start && d <= w.end; }); };
    var pts = wts.filter(function (w) { return inQ(w.date); });
    var n = q.reduce(function (a, w) { return a + w.d5; }, 0), sum = q.reduce(function (a, w) { return a + w.kcalSum; }, 0), est = q.reduce(function (a, w) { return a + w.estKcal; }, 0);
    var mean = sum / n, slope = slopeKgPerWeek(pts);
    var maint = Math.round(mean - slope * KCAL_PER_KG / 7);
    var high = q.length === STAGEB.weeks && q.every(function (w) { return w.d5 >= 5; });
    return Object.assign(base, { ready: true, coverage: high ? 'HIGH' : 'MEDIUM', maintenance: maint, intakeMean: Math.round(mean), slopeKgPerWeek: Math.round(slope * 1000) / 1000,
      includedDays: n, weighDays: pts.length, fastDays: q.reduce(function (a, w) { return a + w.fastDays; }, 0), excludedDays: q.reduce(function (a, w) { return a + w.excludedDays; }, 0),
      estimatedShare: sum > 0 ? Math.round(est / sum * 100) : 0,
      text: 'Personal estimate ' + estimateKcalText(maint) + ' a day (' + (high ? 'HIGH' : 'MEDIUM') + ' coverage; shown rounded to the nearest 50 kcal): ' + n + ' complete days averaging ' + Math.round(mean) + ' kcal, weight trend ' + (Math.round(slope * 100) / 100) + ' kg a week over ' + q.length + ' weeks. An estimate, not a measurement.' });
  }
  // Week-over-week change of weekly mean weight (only between consecutive weeks that both have >= 3 weigh-in days).
  function weeklyChanges(weeks) {
    var out = [];
    for (var i = 1; i < weeks.length; i++) {
      var a = weeks[i - 1], b = weeks[i];
      out.push({ start: b.start, end: b.end, changeKg: a.meanKg !== null && b.meanKg !== null ? round1(b.meanKg - a.meanKg) : null,
        sharePerWeek: a.meanKg !== null && b.meanKg !== null ? (b.meanKg - a.meanKg) / a.meanKg : null });
    }
    return out;
  }
  // Can the Monday review allow a LOWER computed target? Needs the last 2 completed weeks to qualify, both to lie wholly under the
  // current target, loss slower than half the goal rate in both, coverage MEDIUM or HIGH, and no concern. Returns {allowed, why}.
  function reductionCheck(sb, goalId, current, concerns) {
    var g = goalById(goalId);
    if (!g || g.lbPerWeek >= 0) return { allowed: false, why: 'Your goal is not a loss goal.' };
    if ((concerns || []).length) return { allowed: false, why: 'No reduction while there is a concern: ' + concerns.map(function (c) { return isObj(c) ? c.text : String(c); }).join(' ') };
    if (!sb || !sb.ready) return { allowed: false, why: 'A lower target needs the personal estimate first (enough weigh-ins and complete days).' };
    var w = sb.weeks, last2 = w.slice(-2), ch = weeklyChanges(w).slice(-2);
    if (!last2.every(function (x) { return x.qualifies; })) return { allowed: false, why: 'A lower target needs the last 2 completed weeks to qualify.' };
    if (current && current.effectiveDate && current.effectiveDate > last2[0].start) return { allowed: false, why: 'A lower target needs 2 completed weeks under the current target (since ' + current.effectiveDate + ').' };
    var half = -g.lbPerWeek * KG_PER_LB / 2;
    if (!ch.every(function (c) { return c.changeKg !== null && -c.changeKg < half; })) return { allowed: false, why: 'Loss in the last 2 weeks was not slower than half your goal rate, so no reduction is needed.' };
    return { allowed: true, why: '2 qualifying weeks with loss slower than half your goal rate, ' + sb.coverage + ' coverage, no recovery or rapid-loss flag.' };
  }


  // Concerns that stop any reduction (Part D D-R3/D-R5, S-02/S-08/S-09; thresholds PROVISIONAL). Looks at the last completed week.
  // opts: { floorKcal, recovery: { flagDays (days with >= 2 readiness flags), maxPain (null = unknown), plannedDone, plannedTotal } }
  function concerns(sb, days, opts) {
    var out = [], o = opts || {}, weeks = sb && sb.weeks ? sb.weeks : [], last = weeks[weeks.length - 1];
    var ch = weeklyChanges(weeks).slice(-2);
    if (ch.length === 2 && ch.every(function (c) { return c.sharePerWeek !== null && c.sharePerWeek < -RATE_SCREEN; }))
      out.push({ code: 'RAPID_LOSS', level: ch.every(function (c) { return c.sharePerWeek < -1.5 * RATE_SCREEN; }) ? 'RED' : 'AMBER', text: 'Weight fell faster than about 1 % a week for 2 weeks.' });
    if (last && isNum(o.floorKcal)) {
      var low = (days || []).filter(function (x) { return x && x.code === 'D5' && isNum(x.kcal) && x.date >= last.start && x.date <= last.end && x.kcal < o.floorKcal; }).length;
      if (low >= 3) out.push({ code: 'LOW_INTAKE', level: 'RED', text: 'Complete days below ' + o.floorKcal + ' kcal on ' + low + ' days last week.' });
    }
    var r = o.recovery || {};
    if (isNum(r.flagDays) && r.flagDays >= 3) out.push({ code: 'RECOVERY', level: 'RED', text: 'Two or more readiness flags on ' + r.flagDays + ' days last week.' });
    if (isNum(r.maxPain) && r.maxPain >= 5) out.push({ code: 'PAIN', level: 'RED', text: 'Pain of ' + r.maxPain + '/10 recorded last week.' });
    if (Array.isArray(o.strengthDown) && o.strengthDown.length) out.push({ code: 'STRENGTH', level: 'AMBER', text: 'Comparable working sets were lower 2 weeks in a row (' + o.strengthDown.join(', ') + ').' });
    // Planned slots (independent review C3): COUNTS only, never session records or their effort. Counts come from the plan's own slot statuses: completed, partial, skipped (an explicit
    // skip the owner logged), unlogged (nothing logged, not started or left in progress: UNKNOWN) and omitted (the source cascade
    // dropped the slot: not a miss, not in any denominator). Unlogged is never treated as skipped and never judged as a training
    // or recovery problem; when most of the week is unlogged it only HOLDS a reduction (level HOLD: no colour, no amber status).
    var s = r.slots;
    if (isObj(s) && isNum(s.planned)) {
      var logged = (s.completed || 0) + (s.partial || 0) + (s.skipped || 0), counted = s.planned - (s.omitted || 0), unl = s.unlogged || 0;
      if ((s.skipped || 0) >= 2 && s.skipped > logged / 2)
        out.push({ code: 'SESSIONS', level: 'AMBER', text: s.skipped + ' of the ' + logged + ' logged planned sessions were skipped last week.' });
      if (counted > 0 && unl > counted / 2)
        out.push({ code: 'SESSION_LOG', level: 'HOLD', text: unl + ' of ' + counted + ' eligible planned sessions last week are not logged (unknown, not counted as missed)' + ((s.omitted || 0) ? '; ' + s.omitted + ' omitted by the plan’s own rules are excluded' : '') + '. A lower target waits until training is logged; nothing else changes.' });
    }
    // An own confirmed target below the provisional floor or the resting estimate (independent review C4). Never "on track".
    var tg = o.target;
    if (isObj(tg) && tg.origin !== 'PROVISIONAL' && isNum(tg.kcal)) {
      var fl = Math.max(isNum(o.floorKcal) ? o.floorKcal : 0, isNum(o.restingKcal) ? o.restingKcal : 0);
      if (fl > 0 && tg.kcal < fl) out.push({ code: 'LOW_TARGET', level: 'AMBER', text: 'Your confirmed target of ' + fmtKcal(tg.kcal) + ' kcal is below the provisional floor of ' + fmtKcal(fl) + ' kcal' +
        (isNum(o.restingKcal) && o.restingKcal >= (o.floorKcal || 0) ? ' (your resting estimate)' : '') + '. The coach does not call this on track and suggests nothing lower. Discuss a target this low with a clinician.' });
    }
    return out;
  }


  // ======================= P1.3 Delivery D: weekly status and review helpers =======================
  // Status of the LAST COMPLETED review week (never today's partial day). HOLD items never colour it. Order: red concern > amber concern > not enough data >
  // amber band/coverage > green. Bands PROVISIONAL (G-STATUS). Always text + icon; colour is never the only signal.
  var STATUS_ICON = { GREEN: '✓', AMBER: '!', RED: '▲', GRAY: '…' };
  var STATUS_LABEL = { GREEN: 'On track', AMBER: 'Needs attention', RED: 'Check recovery', GRAY: 'Not enough data' };
  function rateText(kgPerWeek, unit) {
    var v = unit === 'lb' ? kgPerWeek * LB_PER_KG : kgPerWeek, r = Math.round(v * 10) / 10;
    return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(1) + ' ' + (unit === 'lb' ? 'lb' : 'kg') + ' a week';
  }
  function inBand(changeKg, goal, refKg) {
    if (goal.lbPerWeek === 0) return Math.abs(changeKg) <= 0.0025 * refKg;
    var target = goal.lbPerWeek * KG_PER_LB, ratio = changeKg / target;
    return ratio >= 0.5 && ratio <= 1.5;
  }
  function status(sb, cons, goalId, unit) {
    function out(level, text) { return { level: level, icon: STATUS_ICON[level], label: STATUS_LABEL[level], text: text }; }
    var red = (cons || []).filter(function (c) { return c.level === 'RED'; }), amb = (cons || []).filter(function (c) { return c.level === 'AMBER'; });
    if (red.length) return out('RED', red.map(function (c) { return c.text; }).join(' ') + ' No reduction is suggested; consider holding steady or a maintenance week.');
    if (amb.length) return out('AMBER', amb.map(function (c) { return c.text; }).join(' ') + (amb.some(function (c) { return c.code === 'RAPID_LOSS'; }) ? ' Faster is not better here: consider eating a little more and review on Monday.' : ' Review on Monday.'));
    var g = goalById(goalId);
    if (!g) return out('GRAY', 'Choose a goal in Settings to see a weekly status.');
    var weeks = sb && sb.weeks ? sb.weeks : [], last = weeks[weeks.length - 1];
    if (!last) return out('GRAY', 'Not enough data yet.');
    if (!last.weightOk) return out('GRAY', 'Not enough data: ' + last.weighDays + ' weigh-in day' + (last.weighDays === 1 ? '' : 's') + ' last week, 3 needed.');
    var ch = weeklyChanges(weeks), c2 = ch.slice(-2);
    if (c2.length < 2 || c2[0].changeKg === null || c2[1].changeKg === null) return out('GRAY', 'Not enough weeks yet for a trend: 3 weeks in a row with 3+ weigh-in days are needed. One week is not a trend.');
    var rate = (c2[0].changeKg + c2[1].changeKg) / 2, ref = last.meanKg;
    var outs = c2.filter(function (c) { return !inBand(c.changeKg, g, ref); }).length;
    if (outs === 2) {
      var why = g.lbPerWeek === 0 ? 'Weight moved more than about 0.25 % a week for 2 weeks (' + rateText(rate, unit) + ').'
        : (rate / (g.lbPerWeek * KG_PER_LB) < 0.5 ? 'Slower than your goal for 2 weeks (' + rateText(rate, unit) + ').' : 'Faster than your goal for 2 weeks (' + rateText(rate, unit) + ').');
      return out('AMBER', why + ' Review on Monday.');
    }
    var lowFood = weeks.slice(-2).every(function (w) { return w.d5 < STAGEB.minD5; });
    if (lowFood) return out('AMBER', 'Weight ' + rateText(rate, unit) + ' over 2 weeks, but food was logged completely on fewer than ' + STAGEB.minD5 + ' days in each week, so the picture is uncertain.');
    return out('GREEN', 'On track: ' + rateText(rate, unit) + ' over 2 weeks.');
  }
  // Strength retention: like with like only (D-R13). sets: [{date, exercise, loadKg, reps}] WORKING sets. For each exercise, the top
  // set (highest load) of each review week; it is compared with the latest EARLIER week whose top set has reps within +/-2.
  function strengthCompare(sets, weeks) {
    var byEx = {};
    (sets || []).forEach(function (x) {
      if (!x || typeof x.exercise !== 'string' || !x.exercise || !isNum(x.loadKg) || x.loadKg <= 0 || !isNum(x.reps) || x.reps <= 0) return;
      var wk = -1; weeks.forEach(function (w, i) { if (x.date >= w.start && x.date <= w.end) wk = i; });
      if (wk < 0) return;
      var e = byEx[x.exercise] = byEx[x.exercise] || {};
      if (!e[wk] || x.loadKg > e[wk].loadKg || (x.loadKg === e[wk].loadKg && x.reps > e[wk].reps)) e[wk] = { week: wk, loadKg: x.loadKg, reps: x.reps, date: x.date };
    });
    var lastWk = weeks.length - 1;
    return Object.keys(byEx).sort().map(function (ex) {
      var e = byEx[ex], cur = e[lastWk];
      if (!cur) return { exercise: ex, result: 'NO_SET', text: ex + ': no working set last week.' };
      for (var i = lastWk - 1; i >= 0; i--) {
        var pr = e[i];
        if (pr && Math.abs(pr.reps - cur.reps) <= 2) {
          var res = cur.loadKg > pr.loadKg ? 'UP' : cur.loadKg < pr.loadKg ? 'DOWN' : 'SAME';
          return { exercise: ex, result: res, current: cur, previous: pr, text: ex + ': ' + cur.loadKg + ' kg × ' + cur.reps + ' vs ' + pr.loadKg + ' kg × ' + pr.reps + ' (' + { UP: 'higher', DOWN: 'lower', SAME: 'same' }[res] + ').' };
        }
      }
      return { exercise: ex, result: 'NOT_COMPARABLE', current: cur, text: ex + ': ' + cur.loadKg + ' kg × ' + cur.reps + ' — not comparable (no earlier working set with similar reps).' };
    });
  }
  // Exercises whose comparable top set was lower in BOTH of the last two weekly comparisons (D-R3: falling strength -> no reduction).
  function strengthDownTwice(sets, weeks) {
    if (!weeks || weeks.length < 3) return [];
    var a = strengthCompare(sets, weeks), b = strengthCompare(sets, weeks.slice(0, -1));
    return a.filter(function (x) { return x.result === 'DOWN' && b.some(function (y) { return y.exercise === x.exercise && y.result === 'DOWN'; }); }).map(function (x) { return x.exercise; });
  }
  // Waist-to-height ratio (informational only). NICE NG246 rec. 1.9.14 (adults with BMI under 35): 0.4-0.49 healthy central
  // adiposity, 0.5-0.59 increased, 0.6 or more high. Shown as a dated number with that reference, never as a verdict on fat or muscle.
  function waistToHeight(waistCm, heightCm) { return isNum(waistCm) && inRange(heightCm, 'heightCm') && waistCm > 0 ? Math.round(waistCm / heightCm * 100) / 100 : null; }

  // Restore preview (read-only): restore replaces the whole settings record, so say what happens to the coach profile/targets.
  function restoreNote(currentRawText, importText) {
    function coachOf(text) {
      try { var o = JSON.parse(text || 'null'); var r = o && Array.isArray(o.ownerSettings) ? o.ownerSettings.filter(function (x) { return x && x.id === 'app-settings'; })[0] : null;
        return r && r[FIELD] !== undefined && r[FIELD] !== null ? r[FIELD] : null; } catch (e) { return null; }
    }
    var cur = coachOf(currentRawText), inc = coachOf(importText);
    if (!cur) return null;
    if (JSON.stringify(cur) === JSON.stringify(inc)) return null;
    var n = Array.isArray(cur.history) ? cur.history.length : 0;
    if (!inc) return 'Restoring removes this device\'s Nutrition Coach profile, goal and ' + n + ' confirmed target(s) (this backup has none; it may be from an older version). Export a backup first if you want to keep them.';
    return 'Nutrition Coach differs: restoring replaces this device\'s coach profile, goal and ' + n + ' confirmed target(s) with the backup\'s.';
  }

  return { VERSION: VERSION, FIELD: FIELD, SCHEMA: SCHEMA, RANGE: RANGE, GOALS: GOALS, ACTIVITY: ACTIVITY, OPEN_GATES: OPEN_GATES, HISTORY_MAX: HISTORY_MAX,
    KCAL_PER_LB_WEEK: KCAL_PER_LB_WEEK, FAT_SHARE: FAT_SHARE, CARB_RDA_G: CARB_RDA_G, PROVISIONAL_FLOOR: PROVISIONAL_FLOOR, DEFICIT_SCREEN: DEFICIT_SCREEN,
    RATE_SCREEN: RATE_SCREEN, RATE_PREFERRED: RATE_PREFERRED, LB_PER_KG: LB_PER_KG,
    isIsoDate: isIsoDate, addDays: addDays, daysBetween: daysBetween, goalById: goalById, activityById: activityById,
    validateCoach: validateCoach, readCoach: readCoach, emptyCoach: emptyCoach, withCoach: withCoach,
    ftInToCm: ftInToCm, cmToFtIn: cmToFtIn, parseProfile: parseProfile, ageStatus: ageStatus,
    macroKcal: macroKcal, targetFor: targetFor, checkOwnerTarget: checkOwnerTarget, confirmTarget: confirmTarget, restoreNote: restoreNote,
    KCAL_PER_KG: KCAL_PER_KG, KG_PER_LB: KG_PER_LB, STAGEB: STAGEB, validWeights: validWeights, recentWeight: recentWeight, mifflin: mifflin,
    startingEstimate: startingEstimate, roundKcal50: roundKcal50, estimateKcalText: estimateKcalText, macrosFor: macrosFor, proposal: proposal, lastCompletedSunday: lastCompletedSunday, isReviewDay: isReviewDay, reviewWeeks: reviewWeeks,
    weekFacts: weekFacts, slopeKgPerWeek: slopeKgPerWeek, stageB: stageB, weeklyChanges: weeklyChanges, reductionCheck: reductionCheck, concerns: concerns,
    STATUS_ICON: STATUS_ICON, STATUS_LABEL: STATUS_LABEL, rateText: rateText, status: status, strengthCompare: strengthCompare, strengthDownTwice: strengthDownTwice, waistToHeight: waistToHeight };
});
