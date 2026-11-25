/*
 * garmin-import.js - offline Garmin Personal API mapping, preview, atomic apply, and injected proxy.
 * Feature flag FEATURE_GARMIN_IMPORT is off. No live network. Synthetic / injected fetch only.
 * Storage: canonical garminLedger on the existing owner-settings record (t112 CC #4).
 * Garmin weight is never imported (CC #2).
 * Never creates metadata-only stub dailies; refuses apply when the store has no daily record.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HyroxGarminImport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FEATURE_GARMIN_IMPORT = false;
  var API_SOURCE = 'GARMIN_PERSONAL_API';
  var MANUAL_SOURCE = 'GARMIN_MANUAL';
  var DATASETS = ['daily', 'sleep', 'hrv', 'vo2max', 'activities'];
  var INTENSITY_MAX = 2880;
  var STEP_MAX = 200000;
  // t118u owner decision (24 Nov 2026): a Garmin 0 means not worn. Do not import it.
  // Preview shows "Garmin shows 0 steps, likely not worn" (unticked, not tickable) and
  // points to the existing Morning / Daily check-in path. Flip only if the owner revisits this.
  var TREAT_ZERO_STEPS_AS_MISSING = true;
  var ZERO_STEPS_STATUS = 'Garmin shows 0 steps, likely not worn';
  var ZERO_STEPS_HINT = 'You can log steps for that day in Morning or Daily check-in (Add).';
  var KG_STORE_MIN = 20, KG_STORE_MAX = 400, KG_WARN_MIN = 30, KG_WARN_MAX = 300;

  function loadHyroxData() {
    if (typeof require === 'function') {
      try { return require('../data/hyrox-data.js'); } catch (e) { /* browser */ }
    }
    return (typeof HyroxData !== 'undefined') ? HyroxData : null;
  }
  function loadMorning() {
    if (typeof require === 'function') {
      try { return require('../data/hyrox-morning.js'); } catch (e) { /* browser */ }
    }
    return (typeof HyroxMorning !== 'undefined') ? HyroxMorning : null;
  }
  function loadWellness() {
    if (typeof require === 'function') {
      try { return require('../data/hyrox-wellness.js'); } catch (e) { /* browser */ }
    }
    return (typeof HyroxWellness !== 'undefined') ? HyroxWellness : null;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isIsoDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && validYmd(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)); }
  function validYmd(y, m, d) {
    if (!y || m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  function inclusiveDays(a, b) {
    if (!isIsoDate(a) || !isIsoDate(b) || a > b) return null;
    var ms = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
    return Math.round(ms / 86400000) + 1;
  }
  function todayQatarFromNow(now) {
    var ms = (now instanceof Date) ? +now : (typeof now === 'number' ? now : Date.parse(String(now)));
    if (!isFinite(ms)) return null;
    return qatarDateFromUtcMs(ms);
  }
  function qatarDateFromUtcMs(ms) {
    var t = ms + 3 * 3600 * 1000;
    var d = new Date(t);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function wallDateFromMs(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  var EPOCH_MS_MIN = Date.UTC(2020, 0, 1);
  // R1/R6: the data layer derives "today" from the store clock (or now). ctx.todayQatar cannot widen it.
  function resolveToday(ctx, api) {
    ctx = ctx || {};
    var now = null;
    if (api && typeof api.now === 'function') now = api.now();
    else if (api && typeof api.todayQatar === 'function') return api.todayQatar();
    else if (ctx.now instanceof Date) now = ctx.now;
    else if (typeof ctx.nowMs === 'number') now = new Date(ctx.nowMs);
    else if (ctx.nowIso) now = new Date(ctx.nowIso);
    else now = new Date();
    var storeToday = todayQatarFromNow(now);
    if (api && typeof api.todayQatar === 'function') {
      var tq = api.todayQatar();
      if (tq) storeToday = tq;
    }
    return storeToday || null;
  }
  function tsOutOfRange(ts, today) {
    if (typeof ts !== 'number' || !isFinite(ts)) return 'NO_TIMESTAMP';
    if (ts < 1e11 || ts < EPOCH_MS_MIN) return 'TIMESTAMP_BEFORE_2020';
    var q = qatarDateFromUtcMs(ts);
    if (!isIsoDate(q) || q < '2020-01-01') return 'TIMESTAMP_BEFORE_2020';
    if (today && q > today) return 'FUTURE_OR_INVALID_DATE';
    return null;
  }
  var WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?$/;
  function parseWall(s) {
    var m = WALL_RE.exec(String(s));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], se = +m[6];
    if (!validYmd(y, mo, d) || h > 23 || mi > 59 || se > 59) return null;
    return { y: y, mo: mo, d: d, h: h, mi: mi, se: se };
  }
  function parseGmtToUtcMs(s) {
    var w = parseWall(s);
    if (!w) return null;
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.se);
  }
  function parseLocalQatarToUtcMs(s) {
    var w = parseWall(s);
    if (!w) return null;
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.se) - 3 * 3600 * 1000;
  }
  function parseIsoOrMs(v, asUtc) {
    if (typeof v === 'number' && isFinite(v) && v > 0) return v;
    if (typeof v === 'string') return asUtc ? parseGmtToUtcMs(v) : parseLocalQatarToUtcMs(v);
    return null;
  }
  function roundHalfUp1(n) {
    if (typeof n !== 'number' || !isFinite(n)) return null;
    var s = n < 0 ? -1 : 1;
    return s * Math.round(Math.abs(n) * 10 + 1e-8) / 10;
  }
  function whole(n) { return typeof n === 'number' && isFinite(n) && Number.isInteger(n); }
  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
  function ok(detail) { return { ok: true, detail: detail || null }; }
  function bad(reason, detail) { return { ok: false, reason: reason, detail: detail || null }; }

  function evaluateTimezone(settings) {
    if (!settings || settings.error) return { accepted: false, reason: 'SETTINGS_LOOKUP_FAILED', value: null };
    if (!Object.prototype.hasOwnProperty.call(settings, 'timeZone') || settings.timeZone == null || settings.timeZone === '') {
      return { accepted: false, reason: 'TIMEZONE_MISSING', value: settings && settings.timeZone };
    }
    if (settings.timeZone !== 'Asia/Qatar') return { accepted: false, reason: 'TIMEZONE_MISMATCH', value: settings.timeZone };
    return { accepted: true, value: 'Asia/Qatar', reason: null };
  }

  function chronologyCheck(row) {
    var ch = row && row.wellnessChronology;
    if (!ch) return { ok: false, reason: 'NO_CHRONOLOGY' };
    var sg = parseGmtToUtcMs(ch.startTimestampGmt);
    var sl = parseLocalQatarToUtcMs(ch.startTimestampLocal);
    var eg = parseGmtToUtcMs(ch.endTimestampGmt);
    var el = parseLocalQatarToUtcMs(ch.endTimestampLocal);
    if (sg == null || sl == null || eg == null || el == null) return { ok: false, reason: 'UNPARSEABLE_CHRONOLOGY' };
    // sl/el are already UTC instants of Qatar wall times; they must match the GMT instants (UTC+3).
    if (Math.abs(sl - sg) > 1 || Math.abs(el - eg) > 1) return { ok: false, reason: 'OFFSET_NOT_QATAR', offS: (sl - sg) / 3600000, offE: (el - eg) / 3600000 };
    var qDate = qatarDateFromUtcMs(sg);
    var wall = parseWall(ch.startTimestampLocal);
    var isMidnight = wall && wall.h === 0 && wall.mi === 0 && wall.se === 0;
    if (!isMidnight) return { ok: false, reason: 'NOT_LOCAL_MIDNIGHT', qDate: qDate };
    if (row.calendarDate && row.calendarDate !== qDate) return { ok: false, reason: 'CALENDAR_MISMATCH', chronologyDate: qDate, calendarDate: row.calendarDate };
    // Meron R4-D2: a completed past day must also end at local 23:59 or next midnight.
    // Start-only midnight used to accept a day that ended at 10:00 local.
    var wallEnd = parseWall(ch.endTimestampLocal);
    if (!wallEnd) return { ok: false, reason: 'UNPARSEABLE_CHRONOLOGY' };
    var endQ = qatarDateFromUtcMs(el);
    var completeSame = endQ === qDate && wallEnd.h === 23 && wallEnd.mi === 59;
    var next = addDaysIso(qDate, 1);
    var completeNext = next && endQ === next && wallEnd.h === 0 && wallEnd.mi === 0 && wallEnd.se === 0;
    if (!completeSame && !completeNext) return { ok: false, reason: 'INCOMPLETE_DAY', qDate: qDate };
    return { ok: true, qDate: qDate };
  }

  function sourceIsGarmin(row) {
    return row && typeof row.source === 'string' && row.source.toLowerCase() === 'garmin';
  }
  function mapIntensity(im) {
    if (!im || typeof im !== 'object') return { state: 'UNKNOWN', value: null, moderate: null, vigorous: null };
    var hasM = Object.prototype.hasOwnProperty.call(im, 'moderate') && im.moderate != null;
    var hasV = Object.prototype.hasOwnProperty.call(im, 'vigorous') && im.vigorous != null;
    if (!hasM || !hasV) return { state: 'UNKNOWN', value: null, moderate: hasM ? im.moderate : null, vigorous: hasV ? im.vigorous : null };
    if (!whole(im.moderate) || !whole(im.vigorous) || im.moderate < 0 || im.vigorous < 0) {
      return { state: 'UNKNOWN', value: null, moderate: im.moderate, vigorous: im.vigorous, invalid: true };
    }
    var w = im.moderate + 2 * im.vigorous;
    if (w > INTENSITY_MAX) return { state: 'UNKNOWN', value: null, moderate: im.moderate, vigorous: im.vigorous, overCap: true };
    return { state: 'OBSERVED', value: w, moderate: im.moderate, vigorous: im.vigorous };
  }

  function mapSteps(movement) {
    var st = movement && movement.steps;
    if (!st || !Object.prototype.hasOwnProperty.call(st, 'value') || st.value == null) {
      return { state: 'UNKNOWN', value: null };
    }
    if (st.value === 0 && TREAT_ZERO_STEPS_AS_MISSING) {
      return { state: 'UNKNOWN', value: null, zeroAsMissing: true };
    }
    if (!whole(st.value) || st.value < 0 || st.value > STEP_MAX) return { state: 'UNKNOWN', value: null, refused: true, raw: st.value };
    return { state: 'OBSERVED', value: st.value, goal: st.goal };
  }

  function mapDailyRow(row, ctx) {
    ctx = ctx || {};
    var skipped = [];
    if (!row || typeof row !== 'object') return { skip: true, reason: 'NOT_A_ROW' };
    if (!isIsoDate(row.calendarDate)) return { skip: true, reason: 'FUTURE_OR_INVALID_DATE', calendarDate: row.calendarDate };
    if (!ctx.todayQatar) return { skip: true, reason: 'NO_STORE_TODAY', calendarDate: row.calendarDate };
    if (row.calendarDate > ctx.todayQatar) return { skip: true, reason: 'FUTURE_OR_INVALID_DATE', calendarDate: row.calendarDate };
    if (!sourceIsGarmin(row)) return { skip: true, reason: 'NON_GARMIN_SOURCE', source: row.source, calendarDate: row.calendarDate };
    var chron = chronologyCheck(row);
    if (!chron.ok) return { skip: true, reason: chron.reason, chronologyDate: chron.qDate, calendarDate: row.calendarDate, uuid: row.uuid };
    var today = ctx.todayQatar;
    var inProgress = row.calendarDate === today;
    var intensity = { state: 'UNKNOWN', value: null, moderate: null, vigorous: null };
    var steps = { state: 'UNKNOWN', value: null };
    if (row.includesWellnessData === true) {
      intensity = mapIntensity(row.intensityMinutes);
      steps = mapSteps(row.movement);
      // Claude QA t118u: Garmin 0 steps = not worn, so the whole date is not imported (intensity too).
      if (steps.zeroAsMissing) intensity = { state: 'UNKNOWN', value: null, moderate: null, vigorous: null, notWorn: true };
    } else {
      skipped.push('NO_WELLNESS');
    }
    return {
      skip: false,
      calendarDate: row.calendarDate,
      uuid: row.uuid != null ? String(row.uuid) : null,
      source: 'garmin',
      inProgress: inProgress,
      intensity: intensity,
      steps: steps,
      stepGoal: row.movement && row.movement.steps ? row.movement.steps.goal : null,
      skipped: skipped,
      writableSteps: !inProgress && steps.state === 'OBSERVED',
      writableIntensity: !inProgress && intensity.state === 'OBSERVED'
    };
  }

  function mapDailyList(payload, ctx) {
    var rows = payload && payload.data;
    if (payload == null) return { rows: [], empty: true, issues: [] };
    if (!Array.isArray(rows)) return { rows: [], empty: true, bad: true, issues: [] };
    var seen = Object.create(null);
    var held = Object.create(null);
    var out = [], issues = [];
    function sameWellness(a, b) {
      return JSON.stringify({ s: a.steps, i: a.intensity }) === JSON.stringify({ s: b.steps, i: b.intensity });
    }
    rows.forEach(function (r) {
      var m = mapDailyRow(r, ctx);
      if (m.skip) { issues.push(m); return; }
      if (held[m.calendarDate]) return;
      if (seen[m.calendarDate]) {
        var prev = seen[m.calendarDate];
        if (sameWellness(prev, m)) return;
        // Meron R4-D5: conflicting same-date rows HOLD the date; first must not win.
        out = out.filter(function (x) { return x.calendarDate !== m.calendarDate; });
        delete seen[m.calendarDate];
        held[m.calendarDate] = true;
        issues.push({ skip: true, reason: 'DUPLICATE_DATE_CONFLICT', calendarDate: m.calendarDate });
        return;
      }
      seen[m.calendarDate] = m;
      out.push(m);
    });
    return { rows: out, issues: issues, empty: out.length === 0 && issues.length === 0 };
  }

  function mapWeightSample(w) {
    if (!w || typeof w !== 'object') return { skip: true, reason: 'NOT_A_SAMPLE' };
    if (typeof w.weight !== 'number' || !isFinite(w.weight)) return { skip: true, reason: 'MISSING_OR_NON_NUMBER' };
    var kg = roundHalfUp1(w.weight);
    if (kg == null) return { skip: true, reason: 'MISSING_OR_NON_NUMBER' };
    if (kg < KG_STORE_MIN || kg > KG_STORE_MAX) return { skip: true, reason: 'OUT_OF_RANGE', kg: kg, raw: w.weight };
    var ts = w.timestampGMT;
    if (typeof ts !== 'number' || !isFinite(ts)) return { skip: true, reason: 'NO_TIMESTAMP' };
    var badTs = tsOutOfRange(ts, w._today || null);
    if (badTs) return { skip: true, reason: badTs, timestampGMT: ts };
    var qDate = qatarDateFromUtcMs(ts);
    return {
      skip: false,
      timestampGMT: ts,
      date: qDate,
      kg: kg,
      raw: w.weight,
      implausible: kg < KG_WARN_MIN || kg > KG_WARN_MAX
    };
  }

  function mapWeightRange(doc, ctx) {
    var samples = [], seen = Object.create(null), hold = [];
    var today = ctx && ctx.todayQatar;
    (doc && doc.dailyWeightSummaries || []).forEach(function (s) {
      (s.allWeightMetrics || (s.latestWeight ? [s.latestWeight] : [])).forEach(function (w) {
        if (today && w && typeof w === 'object') w = Object.assign({ _today: today }, w);
        var m = mapWeightSample(w);
        if (m.skip) { hold.push(m); return; }
        var key = String(m.timestampGMT);
        if (seen[key]) {
          if (seen[key].kg !== m.kg) {
            hold.push({ skip: true, reason: 'DUPLICATE_TIMESTAMP_DIFF_KG', timestampGMT: m.timestampGMT });
            seen[key].conflict = true;
          }
          return;
        }
        seen[key] = m;
        samples.push(m);
      });
    });
    var conflictTs = Object.create(null);
    hold.concat(samples).forEach(function (h) {
      if (h.reason === 'DUPLICATE_TIMESTAMP_DIFF_KG' || h.conflict) conflictTs[h.timestampGMT] = true;
    });
    var clean = samples.filter(function (s) { return !s.conflict && !s.skip && !conflictTs[s.timestampGMT]; });
    clean.sort(function (a, b) { return a.timestampGMT - b.timestampGMT; });
    var latest = clean.length ? clean[clean.length - 1] : null;
    return { samples: clean, held: hold.concat(samples.filter(function (s) { return s.conflict; })), latest: latest };
  }

  function mapActivity(a) {
    if (!a || typeof a !== 'object') return { skip: true, reason: 'NOT_AN_ACTIVITY' };
    var gmt = parseGmtToUtcMs(a.startTimeGMT);
    if (gmt == null) return { skip: true, reason: 'UNPARSEABLE_START' };
    var date = qatarDateFromUtcMs(gmt);
    var durS = a.duration;
    if (typeof durS !== 'number' || !isFinite(durS) || durS < 30 || durS / 60 > 600) return { skip: true, reason: 'DURATION', duration: durS };
    var durationMin = Math.round(durS / 60);
    if (durationMin < 1) return { skip: true, reason: 'DURATION' };
    var typeKey = a.activityType && a.activityType.typeKey ? String(a.activityType.typeKey) : 'activity';
    var name = (a.activityName != null && String(a.activityName).trim()) ? String(a.activityName).trim() : typeKey;
    if (name.length > 60) name = name.slice(0, 60);
    var endMs = gmt + durS * 1000;
    var endDate = qatarDateFromUtcMs(endMs);
    var id = a.activityId != null ? String(a.activityId) : null;
    if (!id) return { skip: true, reason: 'NO_ACTIVITY_ID' };
    return {
      skip: false,
      activityId: id,
      activityName: name,
      typeKey: typeKey,
      date: date,
      startUtcMs: gmt,
      durationMin: durationMin,
      distanceM: typeof a.distance === 'number' ? a.distance : null,
      averageHR: typeof a.averageHR === 'number' ? a.averageHR : null,
      maxHR: typeof a.maxHR === 'number' ? a.maxHR : null,
      crossesMidnight: endDate !== date,
      caloriesPresent: Object.prototype.hasOwnProperty.call(a, 'calories'),
      gpsPresent: !!(a.hasPolyline || a.startLatitude != null)
    };
  }

  function mapActivityList(doc) {
    var list = doc && doc.activities;
    if (!Array.isArray(list)) return { activities: [], complete: doc && doc.pageCapHit ? false : true };
    var cap = doc && (doc.pageCapHit === true || (doc.pagesFetched >= 4 && list.length >= 200));
    return { activities: list.map(mapActivity), complete: !cap, pageCapHit: !!cap };
  }

  function mapSleep(doc) {
    if (!doc || typeof doc !== 'object') return { skip: true, reason: 'NOT_SLEEP' };
    if (doc.sleepWindowConfirmed !== true) return { skip: true, reason: 'WINDOW_UNCONFIRMED' };
    if (!whole(doc.sleepTimeSeconds) || doc.sleepTimeSeconds < 0 || doc.sleepTimeSeconds > 24 * 3600) {
      return { skip: true, reason: 'BAD_DURATION' };
    }
    var wakeDate = null;
    if (typeof doc.sleepEndTimestampLocal === 'number' && isFinite(doc.sleepEndTimestampLocal)) {
      // Local epoch-ms is a wall-clock encoding (not UTC). Do not apply the Qatar +3 h offset again.
      if (doc.sleepEndTimestampLocal < 1e11 || doc.sleepEndTimestampLocal < EPOCH_MS_MIN) {
        return { skip: true, reason: 'UNPARSEABLE_WAKE' };
      }
      wakeDate = wallDateFromMs(doc.sleepEndTimestampLocal);
    } else {
      var endLocal = parseIsoOrMs(doc.sleepEndTimestampLocal, false);
      var endGmt = parseIsoOrMs(doc.sleepEndTimestampGMT, true);
      var wakeMs = endLocal != null ? endLocal : endGmt;
      if (typeof doc.sleepEndTimestampGMT === 'number' && doc.sleepEndTimestampLocal == null) {
        if (tsOutOfRange(doc.sleepEndTimestampGMT, null)) return { skip: true, reason: 'UNPARSEABLE_WAKE' };
        wakeMs = doc.sleepEndTimestampGMT;
      }
      if (wakeMs == null) return { skip: true, reason: 'UNPARSEABLE_WAKE' };
      wakeDate = qatarDateFromUtcMs(wakeMs);
    }
    if (!isIsoDate(wakeDate) || wakeDate < '2020-01-01') return { skip: true, reason: 'UNPARSEABLE_WAKE' };
    var hours = roundHalfUp1(doc.sleepTimeSeconds / 3600);
    var naps = doc.napTimeSeconds || 0;
    return {
      skip: false,
      wakeDate: wakeDate,
      sleepH: hours,
      napTimeSeconds: naps,
      napsListed: !!(naps || (doc.dailyNapDTOS && doc.dailyNapDTOS.length)),
      napsAdded: false
    };
  }

  function item(status, collection, date, extra) {
    var o = { status: status, collection: collection, date: date, ticked: false };
    if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
  }


  function normalizeMappedDailyRows(rows, ctx) {
    // Meron R4-D3: today is derived from the store / Qatar midnight, never from the body's inProgress.
    // Future or unusable values skip only that row; they must not be written as OBSERVED.
    // Meron R5-D4: conflicting same-date Fetch rows HOLD the date, matching mapDailyList / the raw path.
    var today = ctx && ctx.todayQatar;
    var out = [], issues = [];
    var seen = Object.create(null);
    var heldDates = Object.create(null);
    function sameWellness(a, b) {
      return JSON.stringify({ s: a.steps, i: a.intensity }) === JSON.stringify({ s: b.steps, i: b.intensity });
    }
    (rows || []).forEach(function (r) {
      if (!r || typeof r !== 'object' || !isIsoDate(r.calendarDate)) {
        issues.push({ skip: true, reason: 'FUTURE_OR_INVALID_DATE', calendarDate: r && r.calendarDate });
        return;
      }
      if (!today) { issues.push({ skip: true, reason: 'NO_STORE_TODAY', calendarDate: r.calendarDate }); return; }
      if (r.calendarDate > today) { issues.push({ skip: true, reason: 'FUTURE_OR_INVALID_DATE', calendarDate: r.calendarDate }); return; }
      var inProgress = r.calendarDate === today;
      var stepVal = (r.steps && typeof r.steps === 'object' && Object.prototype.hasOwnProperty.call(r.steps, 'value')) ? r.steps.value
        : (typeof r.steps === 'number' ? r.steps : undefined);
      var stepsObj = mapSteps({ steps: { value: stepVal } });
      if (stepVal !== undefined && stepsObj.refused) {
        issues.push({ skip: true, reason: 'REFUSED_VALUE', calendarDate: r.calendarDate, field: 'steps' });
      }
      if (stepsObj.zeroAsMissing) {
        issues.push({ skip: true, reason: 'ZERO_STEPS_AS_MISSING', calendarDate: r.calendarDate });
      }
      var intensity;
      if (r.intensity && typeof r.intensity === 'object' && (r.intensity.moderate != null || r.intensity.vigorous != null)) {
        intensity = mapIntensity({ moderate: r.intensity.moderate, vigorous: r.intensity.vigorous });
      } else if (r.intensity && typeof r.intensity === 'object' && r.intensity.state === 'OBSERVED' && typeof r.intensity.value === 'number') {
        intensity = mapIntensity({ moderate: r.intensity.moderate, vigorous: r.intensity.vigorous != null ? r.intensity.vigorous : 0 });
        if (typeof r.intensity.value === 'number' && intensity.state === 'OBSERVED') intensity.value = r.intensity.value;
      } else {
        intensity = { state: 'UNKNOWN', value: null };
      }
      // Claude QA t118u: same rule on the Fetch path — a not-worn day imports nothing.
      if (stepsObj.zeroAsMissing) intensity = { state: 'UNKNOWN', value: null, notWorn: true };
      if (intensity && (intensity.invalid || intensity.overCap)) {
        issues.push({ skip: true, reason: 'REFUSED_VALUE', calendarDate: r.calendarDate, field: 'intensity' });
        intensity = { state: 'UNKNOWN', value: null, moderate: intensity.moderate, vigorous: intensity.vigorous };
      }
      var mappedRow = {
        calendarDate: r.calendarDate,
        inProgress: inProgress,
        steps: stepsObj,
        intensity: intensity,
        writableSteps: !inProgress && stepsObj.state === 'OBSERVED',
        writableIntensity: !inProgress && intensity.state === 'OBSERVED',
        uuid: r.uuid || r.providerUuid || undefined
      };
      if (heldDates[mappedRow.calendarDate]) return;
      if (seen[mappedRow.calendarDate]) {
        var prev = seen[mappedRow.calendarDate];
        if (sameWellness(prev, mappedRow)) return;
        out = out.filter(function (x) { return x.calendarDate !== mappedRow.calendarDate; });
        delete seen[mappedRow.calendarDate];
        heldDates[mappedRow.calendarDate] = true;
        issues.push({ skip: true, reason: 'DUPLICATE_DATE_CONFLICT', calendarDate: mappedRow.calendarDate });
        return;
      }
      seen[mappedRow.calendarDate] = mappedRow;
      out.push(mappedRow);
    });
    return { rows: out, issues: issues };
  }

  function sleepNightsFromCtx(ctx) {
    if (ctx.sleepPayload) return [mapSleep(ctx.sleepPayload)];
    if (ctx.mappedRows && Array.isArray(ctx.mappedRows.sleep)) {
      return ctx.mappedRows.sleep.filter(function (s) { return s && isIsoDate(s.wakeDate); }).map(function (s) {
        return { skip: false, wakeDate: s.wakeDate, sleepH: s.sleepH };
      });
    }
    return [];
  }

  function activityListFromCtx(ctx) {
    if (ctx.activityPayload) return mapActivityList(ctx.activityPayload);
    if (ctx.mappedRows && Array.isArray(ctx.mappedRows.activities)) {
      return { activities: ctx.mappedRows.activities, complete: true, pageCapHit: false };
    }
    return null;
  }

  function sleepTicked(confirms, wakeDate) {
    if (!confirms) return false;
    if (confirmTrue(confirms.applySleep)) return true;
    return !!(confirms.applySleep && confirmTrue(confirms.applySleep[wakeDate]));
  }

  function sleepReplaceTicked(confirms, wakeDate) {
    if (!confirms) return false;
    if (confirmTrue(confirms.replaceSleep)) return true;
    return !!(confirms.replaceSleep && confirmTrue(confirms.replaceSleep[wakeDate]));
  }

  function preview(ctx) {
    ctx = ctx || {};
    var tz = evaluateTimezone(ctx.settings);
    if (!tz.accepted) return { ok: false, hold: true, reason: tz.reason, timezone: tz, items: [], preTicked: false, tickAll: false };
    var items = [], warnings = [];
    var today = resolveToday(ctx, ctx.api);
    if (!today) return { ok: false, hold: true, reason: 'NO_STORE_TODAY', items: [], preTicked: false, tickAll: false };
    var store = ctx.storeData || { daily: [], weight: [], workouts: [], sessions: [] };
    var dailies = store.daily || [];
    var byDate = Object.create(null);
    dailies.forEach(function (d) { if (d && d.date && !byDate[d.date]) byDate[d.date] = d; });

    var previewDailyRows = [];
    if (ctx.dailyPayload !== undefined) {
      var mapped = mapDailyList(ctx.dailyPayload, { todayQatar: today });
      mapped.issues.forEach(function (iss) {
        if (iss.reason === 'NON_GARMIN_SOURCE') items.push(item('REFUSED', 'daily', iss.calendarDate, { reason: iss.reason, source: iss.source }));
        else if (iss.reason === 'CALENDAR_MISMATCH' || iss.reason === 'INCOMPLETE_DAY' || iss.reason === 'DUPLICATE_DATE_CONFLICT') {
          items.push(item('HOLD', 'daily', iss.calendarDate, { reason: iss.reason }));
        } else if (iss.reason === 'ZERO_STEPS_AS_MISSING') {
          items.push(item(ZERO_STEPS_STATUS, 'steps', iss.calendarDate, { reason: iss.reason, writable: false, ticked: false, hint: ZERO_STEPS_HINT }));
        } else items.push(item('SKIPPED', 'daily', iss.calendarDate, { reason: iss.reason }));
      });
      previewDailyRows = mapped.rows;
    } else if (ctx.mappedRows && Array.isArray(ctx.mappedRows.daily)) {
      var mappedProxy = normalizeMappedDailyRows(ctx.mappedRows.daily, { todayQatar: today });
      mappedProxy.issues.forEach(function (iss) {
        if (iss.reason === 'INCOMPLETE_DAY' || iss.reason === 'DUPLICATE_DATE_CONFLICT') items.push(item('HOLD', 'daily', iss.calendarDate, { reason: iss.reason }));
        else if (iss.reason === 'ZERO_STEPS_AS_MISSING') items.push(item(ZERO_STEPS_STATUS, 'steps', iss.calendarDate, { reason: iss.reason, writable: false, ticked: false, hint: ZERO_STEPS_HINT }));
        else items.push(item('SKIPPED', 'daily', iss.calendarDate, { reason: iss.reason }));
      });
      previewDailyRows = mappedProxy.rows;
    }
    // Claude QA F2 / t119u: held dates forwarded by the proxy must appear as owner-visible HOLD lines.
    var heldIn = [].concat(ctx.held || [], (ctx.mappedRows && ctx.mappedRows.held) || []);
    heldIn.forEach(function (h) {
      if (!h || !isIsoDate(h.calendarDate)) return; // Claude QA t120: held entries come from the Fetch body; show only real dates
      if (h.reason !== 'INCOMPLETE_DAY' && h.reason !== 'DUPLICATE_DATE_CONFLICT') return;
      var already = items.some(function (x) { return x.date === h.calendarDate && x.status === 'HOLD' && x.reason === h.reason; });
      if (!already) items.push(item('HOLD', 'daily', h.calendarDate, { reason: h.reason, writable: false, ticked: false }));
    });
    previewDailyRows.forEach(function (row) {
        // Meron R5-D2: a held date that also has a Fetch row stays HOLD only, never New.
        if (items.some(function (x) { return x.date === row.calendarDate && x.status === 'HOLD'; })) return;
        function field(kind, mappedField, existPath) {
          if (row.inProgress && (kind === 'steps' || kind === 'intensity')) {
            items.push(item('IN_PROGRESS', kind, row.calendarDate, { previewOnly: true, writable: false, mapped: mappedField }));
            return;
          }
          if (kind === 'steps' && mappedField.refused) {
            items.push(item('REFUSED', 'steps', row.calendarDate, { reason: 'OUT_OF_RANGE', raw: mappedField.raw }));
            return;
          }
          if (kind === 'steps' && mappedField.zeroAsMissing) {
            items.push(item(ZERO_STEPS_STATUS, 'steps', row.calendarDate, { reason: 'ZERO_STEPS_AS_MISSING', writable: false, ticked: false, mapped: mappedField, hint: ZERO_STEPS_HINT }));
            return;
          }
          if (mappedField.state !== 'OBSERVED') {
            items.push(item('UNKNOWN', kind, row.calendarDate, { mapped: mappedField }));
            return;
          }
          var ev = existPath;
          if (!ev || ev.state !== 'OBSERVED') {
            items.push(item('New', kind, row.calendarDate, { mapped: mappedField, ticked: false }));
            return;
          }
          if (kind === 'intensity' && ev.source === MANUAL_SOURCE) {
            items.push(item(ev.value === mappedField.value ? 'Already in HYROX' : 'Garmin differs', kind, row.calendarDate, { existing: ev, mapped: mappedField, keepManual: true, ticked: false }));
            return;
          }
          if (ev.value === mappedField.value) items.push(item('Already in HYROX', kind, row.calendarDate, { existing: ev, mapped: mappedField, ticked: false }));
          else items.push(item('Garmin differs', kind, row.calendarDate, { existing: ev, mapped: mappedField, ticked: false }));
        }
        if (findTombstone(store, 'daily', row.calendarDate) || findTombstone(store, 'daily', 'daily-' + row.calendarDate)) {
          items.push(item('Deleted by you', 'steps', row.calendarDate, { mapped: row.steps, ticked: false, writable: false }));
          items.push(item('Deleted by you', 'intensity', row.calendarDate, { mapped: row.intensity, ticked: false, writable: false }));
          return;
        }
        if (row.steps && row.steps.zeroAsMissing && !row.inProgress) {
          // Claude QA t118u: one locked "not worn" line per date, never a second tickable row.
          if (!items.some(function (x) { return x.date === row.calendarDate && x.reason === 'ZERO_STEPS_AS_MISSING'; })) {
            items.push(item(ZERO_STEPS_STATUS, 'steps', row.calendarDate, { reason: 'ZERO_STEPS_AS_MISSING', writable: false, ticked: false, mapped: row.steps, hint: ZERO_STEPS_HINT }));
          }
          return;
        }
        if (!byDate[row.calendarDate] && !row.inProgress) {
          if (row.steps && row.steps.zeroAsMissing) items.push(item(ZERO_STEPS_STATUS, 'steps', row.calendarDate, { reason: 'ZERO_STEPS_AS_MISSING', writable: false, ticked: false, mapped: row.steps, hint: ZERO_STEPS_HINT }));
          else if (row.writableSteps) field('steps', row.steps, null);
          else if (row.steps && row.steps.state !== 'OBSERVED') items.push(item('UNKNOWN', 'steps', row.calendarDate, { mapped: row.steps }));
          if (row.writableIntensity) field('intensity', row.intensity, null);
          else if (row.intensity && row.intensity.state !== 'OBSERVED') items.push(item('UNKNOWN', 'intensity', row.calendarDate, { mapped: row.intensity }));
          return;
        }
        field('steps', row.steps, byDate[row.calendarDate] && byDate[row.calendarDate].steps);
        field('intensity', row.intensity, byDate[row.calendarDate] && byDate[row.calendarDate].intensityMin);
      });
    if (ctx.weightPayload || (ctx.mappedRows && Array.isArray(ctx.mappedRows.weight) && ctx.mappedRows.weight.length)) {
      warnings.push('GARMIN_WEIGHT_EXCLUDED');
    }
    var al = activityListFromCtx(ctx);
    if (al) {
      al.activities.forEach(function (a) {
        if (a.skip) { items.push(item('SKIPPED', 'workouts', null, { reason: a.reason })); return; }
        if (a.date > today) { items.push(item('SKIPPED', 'workouts', a.date, { reason: 'FUTURE_OR_INVALID_DATE', activity: a })); return; }
        var existId = findWorkoutLocal(store, a.activityId);
        var exist = existId && (store.workouts || []).filter(function (w) { return w.id === existId; })[0];
        if (findTombstone(store, 'workouts', a.activityId) || (existId && !exist)) {
          items.push(item('Deleted by you', 'workouts', a.date, { activity: a, ticked: false, complete: al.complete }));
          return;
        }
        if (exist && exist.durationMin === a.durationMin && exist.date === a.date) {
          items.push(item('Already in HYROX', 'workouts', a.date, { activity: a, existing: exist, ticked: false, complete: al.complete }));
        } else if (exist) {
          items.push(item('Garmin differs', 'workouts', a.date, { activity: a, existing: exist, ticked: false, complete: al.complete }));
        } else items.push(item('New', 'workouts', a.date, { activity: a, ticked: false, complete: al.complete }));
      });
      if (al.pageCapHit) warnings.push('ACTIVITIES_INCOMPLETE');
    }
    sleepNightsFromCtx(ctx).forEach(function (sl) {
      if (sl.skip) items.push(item('HOLD', 'sleep', null, { reason: sl.reason }));
      else if (sl.wakeDate > today) items.push(item('SKIPPED', 'sleep', sl.wakeDate, { reason: 'FUTURE_OR_INVALID_DATE', sleep: sl }));
      else {
        if (!byDate[sl.wakeDate]) {
          items.push(item('HOLD', 'sleep', sl.wakeDate, { reason: 'NO_DAILY_FOR_DATE', previewOnly: true, writable: false, sleep: sl }));
        } else {
          var dSleep = byDate[sl.wakeDate] && byDate[sl.wakeDate].sleepH;
          if (dSleep && dSleep.state === 'OBSERVED' && dSleep.value === sl.sleepH) items.push(item('Already in HYROX', 'sleep', sl.wakeDate, { sleep: sl, existing: dSleep, ticked: false }));
          else if (dSleep && dSleep.state === 'OBSERVED') items.push(item('Garmin differs', 'sleep', sl.wakeDate, { sleep: sl, existing: dSleep, ticked: false, replaceOffered: true }));
          else items.push(item('New', 'sleep', sl.wakeDate, { sleep: sl, ticked: false }));
        }
      }
    });
    return { ok: true, hold: false, timezone: tz, items: items, preTicked: false, tickAll: false, acceptAllAllowed: false, warnings: warnings };
  }
  function listOrCorrupt(v) {
    if (v == null) return [];
    if (Array.isArray(v)) return v;
    var err = new Error('LEDGER_CORRUPT');
    err.code = 'LEDGER_CORRUPT';
    throw err;
  }
  function eachLedger(data, fn) {
    var rec = data && data.ownerSettings && data.ownerSettings.filter(function (e) { return e && e.id === 'app-settings'; })[0];
    if (rec && Object.prototype.hasOwnProperty.call(rec, 'garminLedger') && rec.garminLedger != null) {
      if (typeof rec.garminLedger !== 'object' || Array.isArray(rec.garminLedger)) {
        var errShape = new Error('LEDGER_CORRUPT'); errShape.code = 'LEDGER_CORRUPT'; throw errShape;
      }
      listOrCorrupt(rec.garminLedger.tombstones);
      if (rec.garminLedger.byDate != null && (typeof rec.garminLedger.byDate !== 'object' || Array.isArray(rec.garminLedger.byDate))) {
        var errBy = new Error('LEDGER_CORRUPT'); errBy.code = 'LEDGER_CORRUPT'; throw errBy;
      }
      fn(rec.garminLedger, null, rec);
      if (rec.garminLedger.byDate) {
        Object.keys(rec.garminLedger.byDate).forEach(function (dt) { fn(rec.garminLedger.byDate[dt], dt, rec); });
      }
    }
    (data && data.daily || []).forEach(function (d) {
      if (d && Object.prototype.hasOwnProperty.call(d, 'garminLedger') && d.garminLedger != null) {
        if (typeof d.garminLedger !== 'object' || Array.isArray(d.garminLedger)) {
          var errDaily = new Error('LEDGER_CORRUPT'); errDaily.code = 'LEDGER_CORRUPT'; throw errDaily;
        }
        fn(d.garminLedger, d.date, d);
      }
      if (d && d.garminLedgerBag && d.garminLedgerBag.byDate) {
        Object.keys(d.garminLedgerBag.byDate).forEach(function (dt) { fn(d.garminLedgerBag.byDate[dt], dt, d); });
      }
    });
  }
  function findTombstone(data, collection, key) {
    var hit = false;
    eachLedger(data, function (led) {
      listOrCorrupt(led.tombstones).forEach(function (t) {
        if (t.collection === collection && (
          String(t.activityId) === String(key) ||
          String(t.timestampGMT) === String(key) ||
          String(t.localId) === String(key) ||
          String(t.date) === String(key)
        )) hit = true;
      });
    });
    return hit;
  }
  function findWeightLocal(data, timestampGMT) {
    var found = null;
    eachLedger(data, function (led) {
      (led.keys && led.keys.weight || []).forEach(function (k) {
        if (k.timestampGMT === timestampGMT) found = k.localId;
      });
    });
    return found;
  }
  function findWorkoutLocal(data, activityId) {
    var found = null;
    eachLedger(data, function (led) {
      (led.keys && led.keys.workouts || []).forEach(function (k) {
        if (String(k.activityId) === String(activityId)) found = k.localId;
      });
    });
    return found;
  }
  function pickCarrier(daily, preferDate) {
    if (!Array.isArray(daily) || !daily.length) return null;
    var same = daily.filter(function (d) { return d && d.date === preferDate; })[0];
    if (same) return same;
    var copy = daily.slice().filter(Boolean).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    return copy[0] || null;
  }
  function mergeLed(a, patch) {
    // Dawit: reuse the data-layer deduping merge so repeated applies do not bloat keys/tombstones.
    var HD = loadHyroxData();
    if (HD && typeof HD.mergeGarminLedgerDoc === 'function') return HD.mergeGarminLedgerDoc(a, patch);
    var o = a ? deepClone(a) : { v: 1, keys: {}, tombstones: [] };
    o.v = 1; o.keys = o.keys || {}; o.tombstones = o.tombstones || [];
    if (patch && patch.keys) {
      Object.keys(patch.keys).forEach(function (k) {
        if (k === 'daily') o.keys.daily = patch.keys.daily;
        else {
          var cur = o.keys[k] || [];
          var add = patch.keys[k] || [];
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
    if (patch && patch.tombstones) {
      var have = Object.create(null);
      (o.tombstones || []).forEach(function (x) {
        have[String(x.collection) + ':' + String(x.timestampGMT || x.activityId || x.localId)] = true;
      });
      (patch.tombstones || []).forEach(function (x) {
        var id = String(x.collection) + ':' + String(x.timestampGMT || x.activityId || x.localId);
        if (!have[id]) { o.tombstones.push(x); have[id] = true; }
      });
    }
    return o;
  }
  function attachLedger(data, date, patch) {
    var HD = loadHyroxData();
    var nowIso = (data && data._nowIso) || null;
    var today = date || null;
    if (HD && typeof HD.attachGarminLedgerToSettings === 'function') {
      return HD.attachGarminLedgerToSettings(data, date, patch, nowIso, today);
    }
    data.ownerSettings = data.ownerSettings || [];
    var rec = data.ownerSettings.filter(function (e) { return e && e.id === 'app-settings'; })[0];
    if (!rec) {
      rec = { id: 'app-settings', date: today || '1970-01-01', createdAt: nowIso || '1970-01-01T00:00:00.000Z' };
      data.ownerSettings.push(rec);
    }
    rec.garminLedger = mergeLed(rec.garminLedger, { identity: patch && patch.identity, tombstones: patch && patch.tombstones });
    if (date) {
      rec.garminLedger.byDate = rec.garminLedger.byDate || {};
      rec.garminLedger.byDate[date] = mergeLed(rec.garminLedger.byDate[date], patch);
    }
    return rec;
  }

  function confirmTrue(v) { return v === true; }

  function applyMerge(api, confirms, ctx) {
    confirms = confirms || {};
    if (confirms.acceptAll === true) return { ok: false, code: 'ACCEPT_ALL_REJECTED', wrote: false };
    if (confirms.confirmEmptyReplace != null) return { ok: false, code: 'EMPTY_REPLACE_NOT_ON_GARMIN_PATH', wrote: false };
    var tz = evaluateTimezone(ctx.settings);
    if (!tz.accepted) return { ok: false, code: tz.reason, wrote: false, hold: true };
    var today = resolveToday(ctx, api);
    if (!today) return { ok: false, code: 'NO_STORE_TODAY', wrote: false };
    if (payloadsAreEmpty({
      dailyPayload: ctx.dailyPayload,
      weightPayload: ctx.weightPayload,
      sleepPayload: ctx.sleepPayload,
      activityPayload: ctx.activityPayload,
      mappedRows: ctx.mappedRows,
      held: ctx.held
    })) {
      var weightOnly = !!(ctx.weightPayload || (ctx.mappedRows && ctx.mappedRows.weight && ctx.mappedRows.weight.length));
      return { ok: false, wrote: false, reason: 'NO_ROWS', code: 'NO_ROWS', weightOnly: weightOnly, message: weightOnly ? WEIGHT_EXCLUDED_OWNER : NO_ROWS_OWNER };
    }
    var applyOpts = Object.assign({ allowFirstCreate: true }, ctx.applyOpts || {});
    var result = api.applyAtomic(function (data) {
      var wrote = false;
      var sessionsBefore = JSON.stringify(data.sessions || []);
      data.daily = Array.isArray(data.daily) ? data.daily : [];
      data.ownerSettings = Array.isArray(data.ownerSettings) ? data.ownerSettings : [];

      function existingDaily(date) { return (data.daily || []).filter(function (d) { return d && d.date === date; })[0]; }
      function ensureObservedDaily(date) {
        var rec = existingDaily(date);
        if (rec) return rec;
        if (findTombstone(data, 'daily', date) || findTombstone(data, 'daily', 'daily-' + date)) return null;
        rec = { id: 'daily-' + date, date: date, createdAt: ctx.nowIso || new Date().toISOString() };
        data.daily.push(rec);
        wrote = true;
        return rec;
      }

      var applyDailyRows = [];
      if (ctx.dailyPayload !== undefined) {
        applyDailyRows = mapDailyList(ctx.dailyPayload, { todayQatar: today }).rows;
      } else if (ctx.mappedRows && Array.isArray(ctx.mappedRows.daily)) {
        applyDailyRows = normalizeMappedDailyRows(ctx.mappedRows.daily, { todayQatar: today }).rows;
      }
      var heldApplyDates = Object.create(null);
      ([].concat(ctx.held || [], (ctx.mappedRows && ctx.mappedRows.held) || [])).forEach(function (h) {
        if (h && h.calendarDate && (h.reason === 'INCOMPLETE_DAY' || h.reason === 'DUPLICATE_DATE_CONFLICT')) heldApplyDates[h.calendarDate] = h.reason;
      });
      applyDailyRows.forEach(function (row) {
          // Meron R5-D2: a held date that also has a Fetch row must write nothing.
          if (heldApplyDates[row.calendarDate]) return;
          var stepsTick = confirms.applySteps && confirms.applySteps[row.calendarDate];
          var intTick = confirms.applyIntensity && confirms.applyIntensity[row.calendarDate];
          if (!confirmTrue(stepsTick) && !confirmTrue(intTick)) return;
          if (row.inProgress) return;
          if (findTombstone(data, 'daily', row.calendarDate) || findTombstone(data, 'daily', 'daily-' + row.calendarDate)) return;
          var rec = existingDaily(row.calendarDate);
          if (!rec) {
            // Meron R4-D1: create only when a *ticked* field is actually writable.
            // A valid unticked field plus a ticked unwritable one must not make a stub daily.
            var canWrite = (confirmTrue(stepsTick) && row.writableSteps) || (confirmTrue(intTick) && row.writableIntensity);
            if (!canWrite) return;
            rec = ensureObservedDaily(row.calendarDate);
            if (!rec) return;
          }
          var wroteThis = false;
          if (confirmTrue(stepsTick) && row.writableSteps) {
            var prevS = rec.steps;
            if (!(prevS && prevS.state === 'OBSERVED') || confirmTrue(confirms.replaceSteps && confirms.replaceSteps[row.calendarDate])) {
              if (!(prevS && prevS.state === 'OBSERVED' && prevS.value === row.steps.value && prevS.source === API_SOURCE)) {
                rec.steps = { state: 'OBSERVED', value: row.steps.value, source: API_SOURCE };
                wrote = true;
                wroteThis = true;
              }
            }
          }
          if (confirmTrue(intTick) && row.writableIntensity) {
            var prevI = rec.intensityMin;
            var keepManual = prevI && prevI.source === MANUAL_SOURCE && !confirmTrue(confirms.replaceIntensity && confirms.replaceIntensity[row.calendarDate]);
            if (!keepManual) {
              var nextI = { state: 'OBSERVED', value: row.intensity.value, source: API_SOURCE, moderate: row.intensity.moderate, vigorous: row.intensity.vigorous };
              if (!(prevI && prevI.state === 'OBSERVED' && prevI.value === nextI.value && prevI.source === API_SOURCE && prevI.moderate === nextI.moderate && prevI.vigorous === nextI.vigorous)) {
                rec.intensityMin = nextI;
                wrote = true;
                wroteThis = true;
              }
            }
          }
          // Meron R5-D1: do not attach a Garmin ledger link for a 0-step or manual-wins date that wrote nothing.
          // A later delete of that manual day must not write a Garmin tombstone.
          if (wroteThis) {
            attachLedger(data, row.calendarDate, {
              identity: { provider: 'garmin-personal-api' },
              keys: { daily: { calendarDate: row.calendarDate, providerUuid: row.uuid, localId: rec.id } }
            });
          }
        });

      var al = activityListFromCtx(ctx);
      if (al) {
        al.activities.forEach(function (a) {
          if (a.skip) return;
          var tick = confirms.applyActivity && (confirms.applyActivity[a.activityId] === true);
          if (!confirmTrue(tick)) return;
          if (a.date > today) return;
          if (findTombstone(data, 'workouts', a.activityId)) return;
          var existingId = findWorkoutLocal(data, a.activityId);
          var id = existingId || ('wo-g-' + a.activityId);
          var ex = (data.workouts || []).filter(function (w) { return w && (w.id === existingId || w.id === id); })[0];
          if (ex) {
            if (ex.durationMin === a.durationMin && ex.date === a.date) {
              attachLedger(data, a.date, { keys: { workouts: [{ localId: ex.id, activityId: a.activityId }] } });
              return;
            }
            return;
          }
          if (!existingId) {
            data.workouts = data.workouts || [];
            data.workouts.push({
              id: id, createdAt: ctx.nowIso || new Date().toISOString(), date: a.date,
              activity: a.activityName, durationMin: a.durationMin, partial: false, notes: ''
            });
            wrote = true;
          }
          attachLedger(data, a.date, { keys: { workouts: [{ localId: id, activityId: a.activityId }] } });
        });
      }

      sleepNightsFromCtx(ctx).forEach(function (sl) {
        if (sl.skip || sl.wakeDate > today || !sleepTicked(confirms, sl.wakeDate)) return;
        var rec = existingDaily(sl.wakeDate);
        if (!rec) {
          // D1: never invent a stub (or any) check-in. Sleep applies only onto an existing daily for that wake date.
          return;
        }
        var prevSleep = rec.sleepH;
        var sameVal = prevSleep && prevSleep.state === 'OBSERVED' && prevSleep.value === sl.sleepH;
        if (sameVal) {
          attachLedger(data, sl.wakeDate, { keys: { daily: { sleep: true, wakeDate: sl.wakeDate } } });
          return;
        }
        if (prevSleep && prevSleep.state === 'OBSERVED' && !sleepReplaceTicked(confirms, sl.wakeDate)) return;
        rec.sleepH = { state: 'OBSERVED', value: sl.sleepH, source: API_SOURCE };
        wrote = true;
        attachLedger(data, sl.wakeDate, { keys: { daily: { sleep: true, wakeDate: sl.wakeDate } } });
      });

      if (ctx.tombstone) {
        attachLedger(data, ctx.tombstone.date || (data.daily[0] && data.daily[0].date), { tombstones: [ctx.tombstone] });
        wrote = true;
      }

      if (JSON.stringify(data.sessions || []) !== sessionsBefore) return { write: false, reason: 'SESSIONS_TOUCHED' };
      if (!wrote) return { write: false, reason: 'UNCHANGED' };
      return { write: true, data: data };
    }, applyOpts);
    if (result && (result.code === 'schema_1' || result.code === 'empty')) {
      return { ok: false, wrote: false, reason: result.code, code: result.code, message: SCHEMA_REFUSED_OWNER };
    }
    if (result && (result.code === 'restore_pending' || result.code === 'prior_copy_unreadable')) {
      return { ok: false, wrote: false, reason: result.code, code: result.code, message: RESTORE_PENDING_OWNER };
    }
    if (result && (result.code === 'corrupt' || result.code === 'newer' || result.code === 'unavailable' || result.code === 'unreadable')) {
      return { ok: false, wrote: false, reason: result.code, code: result.code, message: STORE_REFUSED_OWNER };
    }
    if (result && (result.reason === 'LEDGER_CORRUPT' || result.code === 'LEDGER_CORRUPT')) {
      return { ok: false, wrote: false, reason: 'LEDGER_CORRUPT', code: 'LEDGER_CORRUPT', message: LEDGER_CORRUPT_OWNER };
    }
    if (result && (result.code === 'DUPLICATE_ID' || result.reason === 'DUPLICATE_ID')) {
      return { ok: false, wrote: false, reason: 'DUPLICATE_ID', code: 'DUPLICATE_ID', message: DUPLICATE_SETTINGS_OWNER };
    }
    // Meron R4-D3/D5: skip issues never fail the whole batch with raw validator text.
    if (result && result.code !== 'INVALID_RECORD' && result.code !== 'schema_1' && result.code !== 'empty'
        && result.code !== 'restore_pending' && result.code !== 'prior_copy_unreadable'
        && result.code !== 'corrupt' && result.code !== 'newer' && result.code !== 'unavailable' && result.code !== 'unreadable'
        && result.code !== 'LEDGER_CORRUPT' && result.code !== 'DUPLICATE_ID' && result.code !== 'save_failed') {
      var dailyIssues = [];
      if (ctx.dailyPayload !== undefined) {
        var mappedApply = mapDailyList(ctx.dailyPayload, { todayQatar: today });
        dailyIssues = (mappedApply.issues || []).slice();
        (mappedApply.rows || []).forEach(function (row) {
          if (row && row.steps && row.steps.zeroAsMissing) dailyIssues.push({ skip: true, reason: 'ZERO_STEPS_AS_MISSING', calendarDate: row.calendarDate });
        });
      } else if (ctx.mappedRows && Array.isArray(ctx.mappedRows.daily)) {
        dailyIssues = normalizeMappedDailyRows(ctx.mappedRows.daily, { todayQatar: today }).issues || [];
      }
      var heldApply = [].concat(ctx.held || [], (ctx.mappedRows && ctx.mappedRows.held) || []);
      heldApply.forEach(function (h) {
        if (!h || !h.reason) return;
        var already = dailyIssues.some(function (i) { return i.calendarDate === h.calendarDate && i.reason === h.reason; });
        if (!already) dailyIssues.push({ skip: true, reason: h.reason, calendarDate: h.calendarDate });
      });
      if (dailyIssues.length) {
        var reasons = dailyIssues.map(function (i) { return i.reason; });
        var msg = result.wrote ? SKIPPED_ROW_OWNER : SKIPPED_ROW_ONLY_OWNER;
        if (reasons.indexOf('DUPLICATE_DATE_CONFLICT') !== -1) msg = DUPLICATE_DATE_OWNER;
        else if (reasons.indexOf('INCOMPLETE_DAY') !== -1 && !result.wrote) msg = INCOMPLETE_DAY_OWNER;
        else if (reasons.indexOf('ZERO_STEPS_AS_MISSING') !== -1 && !result.wrote) msg = ZERO_STEPS_OWNER;
        result = Object.assign({}, result, { message: result.message || msg, skipped: dailyIssues });
        if (!result.wrote && (result.reason === 'UNCHANGED' || result.code === 'UNCHANGED' || !result.code)) {
          if (reasons.indexOf('DUPLICATE_DATE_CONFLICT') !== -1) { result.code = 'DUPLICATE_DATE_CONFLICT'; result.reason = 'DUPLICATE_DATE_CONFLICT'; }
          else if (reasons.indexOf('INCOMPLETE_DAY') !== -1) { result.code = 'INCOMPLETE_DAY'; result.reason = 'INCOMPLETE_DAY'; }
          else if (reasons.indexOf('ZERO_STEPS_AS_MISSING') !== -1) { result.code = 'ZERO_STEPS_AS_MISSING'; result.reason = 'ZERO_STEPS_AS_MISSING'; }
        }
      }
    }
    return result;
  }

  // Retired wording (F6): first-day Garmin create no longer requires an existing check-in.
  var NO_DAILY_CARRIER_OWNER = 'Garmin could not be saved on this device. Nothing was changed.';
  var NO_ROWS_OWNER = 'Garmin returned no days for that range; nothing changed.';
  var WEIGHT_EXCLUDED_OWNER = 'Weight is logged in HYROX only; Garmin weight is not imported. Nothing changed.';
  var SCHEMA_REFUSED_OWNER = 'This device still has an earlier or unreadable data format, so Garmin could not be saved. Nothing was changed.';
  var RESTORE_PENDING_OWNER = 'A previous restore is still unfinished, so Garmin could not be saved. Nothing was changed.';
  var STORE_REFUSED_OWNER = 'Saved data could not be used, so Garmin could not be saved. Nothing was changed.';
  var LEDGER_CORRUPT_OWNER = 'The Garmin import links in your settings could not be read. Nothing was changed. Download a backup and keep this data until it can be repaired.';
  var DUPLICATE_SETTINGS_OWNER = 'Saved settings could not be used, so Garmin could not be saved. Nothing was changed.';
  var DUPLICATE_DATE_OWNER = 'Two Garmin rows for the same day did not agree, so that day was not saved. Nothing was changed for that day.';
  var INCOMPLETE_DAY_OWNER = 'That Garmin day is not complete yet, so it was not saved. Nothing was changed for that day.';
  var SKIPPED_ROW_OWNER = 'A Garmin day could not be used and was skipped. Other days were not affected.';
  var SKIPPED_ROW_ONLY_OWNER = 'A Garmin day could not be used and was not saved. Nothing was changed.';
  var ZERO_STEPS_OWNER = 'Garmin shows 0 steps, likely not worn, so that day was not saved. You can log steps in Morning or Daily check-in.';

  function ownerMessageForApply(r) {
    if (!r) return 'Could not apply — nothing changed.';
    var code = r.reason || r.code;
    if (code === 'NO_DAILY_CARRIER') return NO_DAILY_CARRIER_OWNER;
    if (code === 'schema_1' || code === 'empty') return SCHEMA_REFUSED_OWNER;
    if (code === 'restore_pending' || code === 'prior_copy_unreadable') return RESTORE_PENDING_OWNER;
    if (code === 'corrupt' || code === 'newer' || code === 'unavailable' || code === 'unreadable') return STORE_REFUSED_OWNER;
    if (code === 'NO_ROWS') {
      if (r.weightOnly) return WEIGHT_EXCLUDED_OWNER;
      return NO_ROWS_OWNER;
    }
    if (code === 'LEDGER_CORRUPT') return r.message || LEDGER_CORRUPT_OWNER;
    if (code === 'DUPLICATE_ID') return r.message || DUPLICATE_SETTINGS_OWNER;
    if (code === 'DUPLICATE_DATE_CONFLICT') return r.message || DUPLICATE_DATE_OWNER;
    if (code === 'INCOMPLETE_DAY') return r.message || INCOMPLETE_DAY_OWNER;
    if (code === 'ZERO_STEPS_AS_MISSING') return r.message || ZERO_STEPS_OWNER;
    if (code === 'save_failed' && r.rolledBack === false) {
      return r.message || 'The save could not be finished and may be incomplete. Please check your data or export a backup.';
    }
    if (r.ok === true && r.wrote === false) {
      // F-D: a verified no-write is not a failure. Do not mask a more specific skip or hold reason.
      return r.message || 'Nothing new to apply.';
    }
    if (r.message) return r.message;
    return 'Could not apply — nothing changed.';
  }

  function addDaysIso(iso, delta) {
    if (!isIsoDate(iso)) return null;
    var ms = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) + delta * 86400000;
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function storeApi() {
    var HD = loadHyroxData();
    if (!HD || typeof HD.createStore !== 'function') return null;
    try {
      var storage = (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : null;
      return HD.createStore(storage);
    } catch (e) { return null; }
  }

  function readStoreData(api) {
    var out = { daily: [], weight: [], workouts: [], sessions: [], ownerSettings: [] };
    if (!api) return out;
    try { if (typeof api.records === 'function') out.daily = api.records('daily') || []; } catch (e) {}
    try { if (typeof api.list === 'function') out.weight = api.list('weight') || []; } catch (e) {}
    try { if (typeof api.list === 'function') out.workouts = api.list('workouts') || []; } catch (e) {}
    try { if (typeof api.records === 'function') out.sessions = api.records('sessions') || []; } catch (e) {}
    try { if (typeof api.records === 'function') out.ownerSettings = api.records('ownerSettings') || []; } catch (e) {}
    return out;
  }

  function mappedRowsToPayloads(rows) {
    var out = { mappedRows: rows };
    if (rows && Array.isArray(rows.weight) && rows.weight.length) {
      out.weightPayload = {
        dailyWeightSummaries: [{
          allWeightMetrics: rows.weight.map(function (s) {
            return { calendarDate: s.date, timestampGMT: s.timestampGMT, weight: s.kg };
          })
        }]
      };
    }
    return out;
  }

  function payloadsFromFetchBody(body) {
    if (!body || typeof body !== 'object') return null;
    // N-2: the same-origin proxy returns already-mapped { ok, timezone, rows:{ daily, weight, activities, sleep } }.
    if (body.rows && typeof body.rows === 'object') {
      var fromRows = mappedRowsToPayloads(body.rows);
      if (Array.isArray(body.held) && body.held.length) fromRows.held = body.held;
      return fromRows;
    }
    if (body.payloads && typeof body.payloads === 'object') return body.payloads;
    var out = {}, any = false;
    if (body.dailyPayload !== undefined) { out.dailyPayload = body.dailyPayload; any = true; }
    if (body.weightPayload !== undefined) { out.weightPayload = body.weightPayload; any = true; }
    if (body.sleepPayload !== undefined) { out.sleepPayload = body.sleepPayload; any = true; }
    if (body.activityPayload !== undefined) { out.activityPayload = body.activityPayload; any = true; }
    if (body.daily !== undefined) { out.dailyPayload = body.daily; any = true; }
    if (body.weight !== undefined) { out.weightPayload = body.weight; any = true; }
    if (body.sleep !== undefined) { out.sleepPayload = body.sleep; any = true; }
    if (body.activities !== undefined) { out.activityPayload = body.activities; any = true; }
    return any ? out : null;
  }

  function payloadsAreEmpty(p) {
    if (!p) return true;
    if (Array.isArray(p.held) && p.held.length) return false;
    if (p.mappedRows) {
      var r = p.mappedRows;
      function nonempty(v) { return Array.isArray(v) && v.length > 0; }
      if (nonempty(r.held)) return false;
      return !nonempty(r.daily) && !nonempty(r.sleep) && !nonempty(r.activities);
    }
    function rawEmpty(v) {
      if (v == null) return true;
      if (Array.isArray(v)) return v.length === 0;
      if (typeof v !== 'object') return true;
      if (Array.isArray(v.data) && v.data.length === 0) return true;
      if (Array.isArray(v.dailyWeightSummaries) && v.dailyWeightSummaries.length === 0) return true;
      if (Array.isArray(v.activities) && v.activities.length === 0) return true;
      return false;
    }
    var hasRaw = p.dailyPayload != null || p.weightPayload != null || p.sleepPayload != null || p.activityPayload != null;
    if (!hasRaw) return true;
    return rawEmpty(p.dailyPayload) && rawEmpty(p.sleepPayload) && rawEmpty(p.activityPayload);
  }

  function confirmsFromPreview(el) {
    var confirms = {
      applyWeight: {}, applySteps: {}, applySleep: {}, applyIntensity: {}, applyActivity: {},
      replaceSleep: {}, replaceWeight: {}, replaceSteps: {}
    };
    if (!el || !el.querySelectorAll) return confirms;
    var boxes = el.querySelectorAll('input[type="checkbox"][data-garmin-tick="1"]');
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      if (!box.checked || box.disabled) continue;
      var kind = box.getAttribute('data-kind');
      var date = box.getAttribute('data-date') || '';
      var ts = box.getAttribute('data-ts') || '';
      var act = box.getAttribute('data-activity-id') || '';
      var status = box.getAttribute('data-status') || '';
      if (kind === 'steps' && date) {
        confirms.applySteps[date] = true;
        if (status === 'Garmin differs') confirms.replaceSteps[date] = true;
      } else if (kind === 'intensity' && date) {
        confirms.applyIntensity[date] = true;
      } else if (kind === 'weight' && ts) {
        confirms.applyWeight[ts] = true;
        if (status === 'Garmin differs') confirms.replaceWeight[ts] = true;
      } else if (kind === 'sleep' && date) {
        confirms.applySleep[date] = true;
        if (status === 'Garmin differs') confirms.replaceSleep = true;
      } else if ((kind === 'activity' || kind === 'workouts' || kind === 'activities') && act) {
        confirms.applyActivity[act] = true;
      }
    }
    return confirms;
  }

  function renderPreview(el, model) {
    if (!el) return { ok: false, reason: 'NO_EL' };
    while (el.firstChild) el.removeChild(el.firstChild);
    if (!FEATURE_GARMIN_IMPORT && !(model && (model.forceRender || model.enabled))) {
      el.textContent = 'Garmin import is off.';
      return { ok: true, rendered: false, flag: false };
    }
    var doc = el.ownerDocument;
    var title = doc.createElement('h3');
    title.textContent = 'Garmin import preview';
    el.appendChild(title);
    if (model && model.warnings && model.warnings.indexOf('GARMIN_WEIGHT_EXCLUDED') !== -1) {
      var wn = doc.createElement('p');
      wn.textContent = 'Weight is logged in HYROX only; Garmin weight is not imported';
      wn.setAttribute('data-testid', 'garmin-weight-excluded');
      el.appendChild(wn);
    }
    if (model && model.hold) {
      var p = doc.createElement('p');
      p.textContent = 'Import held: ' + (model.reason || 'timezone') + (model.timezone && model.timezone.value ? ' (account ' + String(model.timezone.value) + ')' : '');
      el.appendChild(p);
      return { ok: true, rendered: true, preTicked: false, tickAll: false };
    }
    var list = doc.createElement('ul');
    (model && model.items || []).forEach(function (it) {
      var li = doc.createElement('li');
      var label = doc.createElement('span');
      var name = (it.activity && it.activity.activityName) || it.collection || '';
      var zeroSteps = it.reason === 'ZERO_STEPS_AS_MISSING' || it.status === ZERO_STEPS_STATUS;
      var holdReason = '';
      if (it.status === 'HOLD') {
        if (it.reason === 'INCOMPLETE_DAY') holdReason = 'That Garmin day is not complete yet';
        else if (it.reason === 'DUPLICATE_DATE_CONFLICT') holdReason = 'Two Garmin rows for the same day did not agree';
      }
      // Claude QA t120: dates shown to the owner must be real calendar dates; long Garmin text wraps inside 320 px.
      var shownDate = isIsoDate(it.date) ? it.date : '';
      if (label.style) label.style.overflowWrap = 'anywhere';
      label.textContent = zeroSteps
        ? (ZERO_STEPS_STATUS + (shownDate ? ' — ' + shownDate : '') + '. ' + (it.hint || ZERO_STEPS_HINT))
        : ((it.status || '') + ' ' + shownDate + ' ' + name + (holdReason ? ' — ' + holdReason : ''));
      var box = doc.createElement('input');
      box.type = 'checkbox';
      box.checked = false;
      box.disabled = it.status === 'UNKNOWN' || it.status === 'IN_PROGRESS' || it.status === 'REFUSED' || it.status === 'HOLD' || it.status === 'Deleted by you' || it.writable === false || zeroSteps;
      box.setAttribute('data-garmin-tick', '1');
      box.setAttribute('data-kind', it.collection || '');
      box.setAttribute('data-date', it.date || '');
      box.setAttribute('data-status', it.status || '');
      box.setAttribute('data-testid', 'garmin-preview-tick');
      var ts = (it.sample && it.sample.timestampGMT != null) ? it.sample.timestampGMT : it.timestampGMT;
      if (ts != null) box.setAttribute('data-ts', String(ts));
      var actId = (it.activity && (it.activity.activityId || it.activity.activityUUID)) || it.activityId;
      if (actId != null) box.setAttribute('data-activity-id', String(actId));
      li.appendChild(box);
      li.appendChild(label);
      if (zeroSteps) {
        label.setAttribute('data-testid', 'garmin-zero-steps');
        var open = doc.createElement('button');
        open.type = 'button';
        open.textContent = 'Open Morning';
        open.setAttribute('data-testid', 'garmin-zero-steps-morning');
        // Meron R5-D3: at least 24 px (WCAG 2.5.8), preferably 44 px; keep 320 px layout (no overflow).
        if (!open.style) open.style = {};
        open.style.boxSizing = 'border-box';
        open.style.minHeight = '44px';
        open.style.minWidth = '44px';
        open.style.padding = '10px 12px';
        open.style.fontSize = '16px';
        open.style.marginTop = '8px';
        open.style.display = 'inline-block';
        open.style.maxWidth = '100%';
        open.addEventListener('click', function () {
          // Reuse the existing Add > Morning controls; no new manual-entry UI.
          var tab = doc.querySelector('[data-testid="tab-add"]');
          if (tab && typeof tab.click === 'function') tab.click();
          var morn = doc.querySelector('[data-testid="add-mode-morning"]');
          if (morn && typeof morn.click === 'function') morn.click();
          // F-B: after the Morning form is mounted, move keyboard focus to its heading or first input.
          // VoiceOver and a physical iPhone are untested; this is a DOM focus sequence only.
          function focusMorning() {
            var form = doc.querySelector('[data-testid="morning-form"]');
            if (!form) return false;
            var heading = form.querySelector('h2, h1, [data-testid="mlog-morning-heading"]');
            var input = form.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled])');
            var target = heading || input || form;
            if (!target) return false;
            if (heading && typeof heading.setAttribute === 'function' && typeof heading.hasAttribute === 'function' && !heading.hasAttribute('tabindex')) {
              heading.setAttribute('tabindex', '-1');
            }
            if (typeof target.focus === 'function') target.focus();
            return true;
          }
          if (focusMorning()) return;
          var tries = 0;
          function retry() {
            tries += 1;
            if (focusMorning() || tries >= 8) return;
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(retry);
          }
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(retry);
        });
        li.appendChild(open);
      }
      list.appendChild(li);
    });
    el.appendChild(list);
    return { ok: true, rendered: true, preTicked: false, tickAll: false, usedTextContent: true };
  }

  function isEnabled() {
    // Product/deploy code has no test hook. Offline e2e injects isEnabled after load.
    return FEATURE_GARMIN_IMPORT === true;
  }
  function proxyPath() { return '/.netlify/functions/garmin-personal-proxy'; }
  // Same-origin only. Offline tests mock this path. The product flag stays off.
  // The Garmin proxy endpoint is kept out of the deploy package until S7/S9
  // (pending CC confirmation, Claude decision 2); the stub stays in the source tree for tests.
  function requestGarmin(body, opts) {
    opts = opts || {};
    var fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) return Promise.reject(new Error('NO_FETCH'));
    return fetchFn(proxyPath(), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {})
    });
  }
  function boot(root, opts) {
    // Test-only seam (Meron N-1): e2e may pass { enabled: true }. Product boot() from
    // app-ext never passes opts. Not a URL, hash, localStorage or window.__ hook.
    var enabled = (opts && opts.enabled === true) || isEnabled();
    if (!enabled) return { ok: true, enabled: false };
    if (!root) return { ok: true, enabled: true, proxy: proxyPath() };
    var doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return { ok: true, enabled: true, proxy: proxyPath() };
    root.hidden = false;
    root.setAttribute('data-testid', 'garmin-import-root');
    root.textContent = '';

    var heading = doc.createElement('h2');
    heading.textContent = 'Garmin import';
    root.appendChild(heading);

    var status = doc.createElement('p');
    status.setAttribute('data-testid', 'garmin-import-flag-on');
    status.textContent = 'Fetch a preview, tick the rows you want, then confirm. Nothing is pre-ticked. Today stays preview-only.';
    root.appendChild(status);

    var fetchBtn = doc.createElement('button');
    fetchBtn.type = 'button';
    fetchBtn.textContent = 'Fetch';
    fetchBtn.setAttribute('data-testid', 'garmin-import-fetch');
    root.appendChild(fetchBtn);

    var previewHost = doc.createElement('div');
    previewHost.setAttribute('data-testid', 'garmin-import-preview');
    root.appendChild(previewHost);

    var applyBtn = doc.createElement('button');
    applyBtn.type = 'button';
    applyBtn.textContent = 'Apply selected';
    applyBtn.setAttribute('data-testid', 'garmin-import-apply');
    applyBtn.disabled = true;
    root.appendChild(applyBtn);

    var lastCtx = null;

    fetchBtn.addEventListener('click', function () {
      status.textContent = 'Fetching…';
      applyBtn.disabled = true;
      lastCtx = null;
      while (previewHost.firstChild) previewHost.removeChild(previewHost.firstChild);
      var api = storeApi();
      var today = (api && typeof api.todayQatar === 'function') ? api.todayQatar() : todayQatarFromNow(new Date());
      var start = addDaysIso(today, -6) || today;
      requestGarmin({ op: 'fetch', startDate: start, endDate: today }).then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          try { body = JSON.parse(text); } catch (e) { body = null; }
          if (!body || body.ok === false || body.hold) {
            status.textContent = 'Fetch could not run: ' + ((body && (body.reason || body.code || body.message)) || ('HTTP ' + res.status));
            return;
          }
          var payloads = payloadsFromFetchBody(body);
          if (!payloads || payloadsAreEmpty(payloads)) {
            var weightOnly = !!(payloads && (payloads.weightPayload || (payloads.mappedRows && payloads.mappedRows.weight && payloads.mappedRows.weight.length)));
            status.textContent = weightOnly ? WEIGHT_EXCLUDED_OWNER : NO_ROWS_OWNER;
            return;
          }
          var storeData = readStoreData(api);
          lastCtx = {
            api: api,
            // N-5: honour the proxy timezone so a mismatch can still HOLD client-side.
            settings: (body.timezone && typeof body.timezone.value === 'string') ? { timeZone: body.timezone.value } : { timeZone: 'Asia/Qatar' },
            storeData: storeData,
            dailyPayload: payloads.dailyPayload,
            weightPayload: payloads.weightPayload,
            sleepPayload: payloads.sleepPayload,
            activityPayload: payloads.activityPayload,
            mappedRows: payloads.mappedRows,
            held: payloads.held || body.held || []
          };
          var model;
          try { model = preview(lastCtx); } catch (e) {
            // Claude QA t124u: a stored Garmin ledger that cannot be read must give the owner sentence, not "Fetch failed."
            lastCtx = null;
            status.textContent = (e && e.code === 'LEDGER_CORRUPT') ? LEDGER_CORRUPT_OWNER : 'Fetch failed.';
            return;
          }
          model.enabled = true;
          renderPreview(previewHost, model);
          applyBtn.disabled = false;
          status.textContent = 'Preview ready. Tick a completed past day to save a Garmin-derived observation. Nothing is pre-ticked. Today is preview-only.';
        });
      }).catch(function () {
        status.textContent = 'Fetch failed.';
      });
    });

    applyBtn.addEventListener('click', function () {
      if (!lastCtx) {
        status.textContent = 'Fetch a preview first.';
        return;
      }
      var api = lastCtx.api || storeApi();
      if (!api) {
        status.textContent = 'Could not apply — nothing changed.';
        return;
      }
      lastCtx.api = api;
      lastCtx.storeData = readStoreData(api);
      var confirms = confirmsFromPreview(previewHost);
      var result = applyMerge(api, confirms, lastCtx);
      status.textContent = (result && result.ok && result.wrote) ? 'Applied (verified).' : ownerMessageForApply(result);
    });

    return { ok: true, enabled: true, proxy: proxyPath() };
  }

  return {
    FEATURE_GARMIN_IMPORT: FEATURE_GARMIN_IMPORT,
    API_SOURCE: API_SOURCE,
    isIsoDate: isIsoDate,
    evaluateTimezone: evaluateTimezone,
    chronologyCheck: chronologyCheck,
    mapDailyList: mapDailyList,
    mapDailyRow: mapDailyRow,
    mapWeightRange: mapWeightRange,
    mapActivityList: mapActivityList,
    mapSleep: mapSleep,
    mapIntensity: mapIntensity,
    mapSteps: mapSteps,
    preview: preview,
    applyMerge: applyMerge,
    renderPreview: renderPreview,
    inclusiveDays: inclusiveDays,
    todayQatarFromNow: todayQatarFromNow,
    MANUAL_SOURCE: MANUAL_SOURCE,
    findWorkoutLocal: findWorkoutLocal,
    findWeightLocal: findWeightLocal,
    findTombstone: findTombstone,
    mapActivity: mapActivity,
    isEnabled: isEnabled,
    proxyPath: proxyPath,
    requestGarmin: requestGarmin,
    ownerMessageForApply: ownerMessageForApply,
    NO_DAILY_CARRIER_OWNER: NO_DAILY_CARRIER_OWNER,
    NO_ROWS_OWNER: NO_ROWS_OWNER,
    WEIGHT_EXCLUDED_OWNER: WEIGHT_EXCLUDED_OWNER,
    SCHEMA_REFUSED_OWNER: SCHEMA_REFUSED_OWNER,
    RESTORE_PENDING_OWNER: RESTORE_PENDING_OWNER,
    STORE_REFUSED_OWNER: STORE_REFUSED_OWNER,
    LEDGER_CORRUPT_OWNER: LEDGER_CORRUPT_OWNER,
    DUPLICATE_SETTINGS_OWNER: DUPLICATE_SETTINGS_OWNER,
    DUPLICATE_DATE_OWNER: DUPLICATE_DATE_OWNER,
    INCOMPLETE_DAY_OWNER: INCOMPLETE_DAY_OWNER,
    SKIPPED_ROW_OWNER: SKIPPED_ROW_OWNER,
    ZERO_STEPS_OWNER: ZERO_STEPS_OWNER,
    TREAT_ZERO_STEPS_AS_MISSING: TREAT_ZERO_STEPS_AS_MISSING,
    ZERO_STEPS_STATUS: ZERO_STEPS_STATUS,
    ZERO_STEPS_HINT: ZERO_STEPS_HINT,
    confirmsFromPreview: confirmsFromPreview,
    payloadsFromFetchBody: payloadsFromFetchBody,
    payloadsAreEmpty: payloadsAreEmpty,
    boot: boot
  };
});
