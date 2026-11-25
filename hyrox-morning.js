/*
 * hyrox-morning.js - P1.1 helpers for the morning log. Pure functions: this file reads and writes no storage and no network.
 * Plain-JS UMD: classic <script> (window.HyroxMorning) or require() in Node. No dependencies.
 *
 *  - Garmin intensity minutes: ONE already-weighted whole number per Asia/Qatar day, typed by the owner from Garmin
 *    (Garmin counts vigorous minutes double: 30 moderate + 8 vigorous = 46). It is stored on that day's existing
 *    check-in record as  intensityMin: { state: 'OBSERVED', value: 46, source: 'GARMIN_MANUAL' }.
 *    The data layer (hyrox-data.js) is NOT changed: it keeps fields it does not know, in storage, export and restore.
 *    Because the data layer therefore does not validate this field, every reader here validates it and treats anything
 *    malformed as INVALID (unknown) - never as 0 and never as a number.
 *  - Weekly sum: Monday-Sunday (Asia/Qatar dates), recorded days only, with coverage. Missing days are never scaled or
 *    filled in. Never combined with workouts, steps or calories.
 *  - Weight unit preference (kg / lb, field weightUnit on the existing settings record): display and input only. Stored weights stay in kg with one decimal, exactly as
 *    before. Every conversion starts from the stored kg value, so nothing drifts when a value is shown or edited.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HyroxMorning = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var INTENSITY_SOURCE = 'GARMIN_MANUAL';
  var INTENSITY_SOURCE_API = 'GARMIN_PERSONAL_API';
  var INTENSITY_MAX = 2880;            // 24 h of vigorous minutes counted double: the arithmetic ceiling of one day
  var INTENSITY_REFERENCE_WEEK = 150;  // moderate-equivalent minutes a week (general activity guideline; shown as a reference only)
  var LB_PER_KG = 2.2046226218487757;  // 1 / 0.45359237 (exact definition of the pound)
  var KG_MIN = 20, KG_MAX = 400;       // the data layer's own weight range

  function isIsoDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var d = new Date(v + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }
  function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  // Monday of the week that holds this date.
  function weekStart(iso) { var dow = new Date(iso + 'T00:00:00Z').getUTCDay(); return addDays(iso, -((dow + 6) % 7)); }
  function round1(n) { return Math.round((n + Number.EPSILON) * 10) / 10; }

  // ---------- Garmin intensity minutes ----------

  // What a stored check-in says: MISSING (nothing recorded), OBSERVED (a valid whole number 0..2880 from GARMIN_MANUAL or GARMIN_PERSONAL_API),
  // or INVALID (something is stored but it is not a valid value - unknown, never 0).
  function intensityRead(rec) {
    if (!rec || typeof rec !== 'object' || !Object.prototype.hasOwnProperty.call(rec, 'intensityMin') || rec.intensityMin === null || rec.intensityMin === undefined) return { state: 'MISSING', value: null };
    var o = rec.intensityMin;
    if (typeof o !== 'object' || Array.isArray(o)) return { state: 'INVALID', value: null };
    if (o.state === 'MISSING' && (o.value === null || o.value === undefined)) return { state: 'MISSING', value: null };
    if (o.state !== 'OBSERVED' || (o.source !== INTENSITY_SOURCE && o.source !== INTENSITY_SOURCE_API)) return { state: 'INVALID', value: null };
    if (typeof o.value !== 'number' || !isFinite(o.value) || !Number.isInteger(o.value) || o.value < 0 || o.value > INTENSITY_MAX) return { state: 'INVALID', value: null };
    return { state: 'OBSERVED', value: o.value };
  }

  // Typed text -> { blank: true } | { ok: true, value } | { ok: false, error }. Blank is "leave as it is", never 0.
  function intensityParse(raw) {
    var t = String(raw == null ? '' : raw).trim().replace(/[,\s  ]/g, '');
    if (t === '') return { blank: true };
    if (!/^\d{1,4}$/.test(t)) return { ok: false, error: 'Intensity minutes must be a whole number from 0 to ' + INTENSITY_MAX + '.' };
    var v = Number(t);
    if (v > INTENSITY_MAX) return { ok: false, error: 'Intensity minutes must be a whole number from 0 to ' + INTENSITY_MAX + '.' };
    return { ok: true, value: v };
  }

  // The record to save for a day's intensity minutes WITHOUT touching anything else in that day's check-in: same record
  // identity ('daily-' + date, or the existing record's own id), every other field copied unchanged.
  function intensityUpdate(existing, date, value, todayIso) {
    if (!isIsoDate(date)) return { ok: false, error: 'Choose a valid date.' };
    if (!isIsoDate(todayIso) || date > todayIso) return { ok: false, error: 'Intensity minutes cannot be logged for a future date (Asia/Qatar calendar).' };
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > INTENSITY_MAX) return { ok: false, error: 'Intensity minutes must be a whole number from 0 to ' + INTENSITY_MAX + '.' };
    var prev = intensityRead(existing);
    var rec = existing ? JSON.parse(JSON.stringify(existing)) : { id: 'daily-' + date, date: date };
    if (prev.state === 'OBSERVED' && prev.value === value && existing && existing.intensityMin) {
      rec.intensityMin = JSON.parse(JSON.stringify(existing.intensityMin));
    } else {
      rec.intensityMin = { state: 'OBSERVED', value: value, source: INTENSITY_SOURCE };
    }
    return { ok: true, rec: rec, previous: prev.state === 'OBSERVED' ? prev.value : null, previousState: prev.state, changed: !(prev.state === 'OBSERVED' && prev.value === value) };
  }
  // Remove the value (the check-in form's "blank = missing"). Everything else in the record is kept.
  function intensityClear(existing) {
    if (!existing) return null;
    var rec = JSON.parse(JSON.stringify(existing));
    delete rec.intensityMin;
    return rec;
  }

  // Weekly sums, oldest week first. endDate is "today" (Asia/Qatar); the week that holds it is counted up to endDate only.
  // total is null when no day of the week has a valid value (unknown, not 0). Nothing is scaled, averaged up or projected.
  function weeklyIntensity(endDate, dailies, weeks) {
    var out = [];
    if (!isIsoDate(endDate)) return out;
    var byDate = {};
    (dailies || []).forEach(function (r) { if (r && isIsoDate(r.date) && !Object.prototype.hasOwnProperty.call(byDate, r.date)) byDate[r.date] = r; });
    var start = weekStart(endDate);
    for (var w = (weeks || 4) - 1; w >= 0; w--) {
      var ws = addDays(start, -7 * w), total = 0, rec = 0, inv = 0, elapsed = 0;
      for (var i = 0; i < 7; i++) {
        var d = addDays(ws, i);
        if (d > endDate) break;
        elapsed++;
        var r = intensityRead(byDate[d]);
        if (r.state === 'OBSERVED') { total += r.value; rec++; }
        else if (r.state === 'INVALID') inv++;
      }
      out.push({ weekStart: ws, weekEnd: addDays(ws, 6), daysElapsed: elapsed, daysRecorded: rec, daysInvalid: inv,
        daysMissing: elapsed - rec - inv, total: rec ? total : null, complete: elapsed === 7, reference: INTENSITY_REFERENCE_WEEK });
    }
    return out;
  }

  // ---------- weight unit (display / input only; storage stays kg, one decimal) ----------

  function kgToLb(kg) { return round1(kg * LB_PER_KG); }
  function lbToKg(lb) { return round1(lb / LB_PER_KG); }
  function normUnit(u) { return u === 'lb' ? 'lb' : 'kg'; }
  // A stored kg value as text in the chosen unit, e.g. "98.4 kg" or "216.9 lb".
  function weightText(kg, unit) {
    if (typeof kg !== 'number' || !isFinite(kg)) return '';
    var u = normUnit(unit), v = u === 'lb' ? kgToLb(kg) : round1(kg);
    return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 }) + ' ' + u;
  }
  // A change between two stored kg values in the chosen unit (the difference is converted, not two rounded values subtracted).
  function weightDelta(kgDiff, unit) { return normUnit(unit) === 'lb' ? round1(kgDiff * LB_PER_KG) : round1(kgDiff); }
  // Typed text in the chosen unit -> { blank: true } | { ok: true, kg } | { ok: false, error }. kg has one decimal (the stored form).
  function weightParse(raw, unit) {
    var u = normUnit(unit), t = String(raw == null ? '' : raw).trim().replace(',', '.');
    if (t === '') return { blank: true };
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(t)) return { ok: false, error: 'Weight must be a number in ' + u + ' (for example ' + (u === 'lb' ? '215.4' : '97.6') + ').' };
    var n = Number(t), kg = u === 'lb' ? lbToKg(n) : round1(n);
    if (!(kg >= KG_MIN && kg <= KG_MAX)) return { ok: false, error: 'Weight must be between ' + (u === 'lb' ? kgToLb(KG_MIN) + ' and ' + kgToLb(KG_MAX) + ' lb' : KG_MIN + ' and ' + KG_MAX + ' kg') + '.' };
    return { ok: true, kg: kg };
  }
  // True when typed text means the same stored value that is already there (so re-saving what is shown changes nothing).
  function sameWeight(raw, unit, storedKg) {
    var p = weightParse(raw, unit);
    if (!p.ok || typeof storedKg !== 'number') return false;
    if (p.kg === round1(storedKg)) return true;
    return normUnit(unit) === 'lb' && Number(String(raw).trim().replace(',', '.')) === kgToLb(storedKg);
  }

  // ---------- unit preference: one field (weightUnit) on the existing shared settings record ----------
  // Anything other than exactly 'lb' means kg, so a missing, older or damaged record always shows kg.
  function unitFromSettings(rec) { return rec && typeof rec === 'object' && rec.weightUnit === 'lb' ? 'lb' : 'kg'; }
  // The record to save: every other field of the fresh stored record is kept. kg is stored as "no field" so a record that
  // never chose pounds is byte-for-byte what it was before this feature.
  function settingsWithUnit(freshRecord, unit, settingsId, todayIso) {
    var rec = freshRecord ? JSON.parse(JSON.stringify(freshRecord)) : { id: settingsId };
    if (!rec.date) rec.date = todayIso;
    if (unit === 'lb') rec.weightUnit = 'lb'; else delete rec.weightUnit;
    return rec;
  }

  return { INTENSITY_SOURCE: INTENSITY_SOURCE, INTENSITY_SOURCE_API: INTENSITY_SOURCE_API, INTENSITY_MAX: INTENSITY_MAX, INTENSITY_REFERENCE_WEEK: INTENSITY_REFERENCE_WEEK, LB_PER_KG: LB_PER_KG,
    isIsoDate: isIsoDate, addDays: addDays, weekStart: weekStart,
    intensityRead: intensityRead, intensityParse: intensityParse, intensityUpdate: intensityUpdate, intensityClear: intensityClear, weeklyIntensity: weeklyIntensity,
    kgToLb: kgToLb, lbToKg: lbToKg, weightText: weightText, weightDelta: weightDelta, weightParse: weightParse, sameWeight: sameWeight,
    unitFromSettings: unitFromSettings, settingsWithUnit: settingsWithUnit };
});
