// Moved out of src/integrations/garmin-import.js (R7, 24 Nov 2026, Claude QA).
// Contract tests, fakes, and the synchronous unit proxy. Not shipped in the  app package.
'use strict';
const path = require('path');
const G = require('../src/integrations/garmin-import.js');
const HD = require('../src/data/hyrox-data.js');

const applyMerge = G.applyMerge;
const preview = G.preview;
const mapSleep = G.mapSleep;
const mapDailyList = G.mapDailyList;
const mapWeightRange = G.mapWeightRange;
const mapActivityList = G.mapActivityList;
const evaluateTimezone = G.evaluateTimezone;
const inclusiveDays = G.inclusiveDays;
const todayQatarFromNow = G.todayQatarFromNow;
const FEATURE_GARMIN_IMPORT = G.FEATURE_GARMIN_IMPORT;
const API_SOURCE = G.API_SOURCE;
const isIsoDate = G.isIsoDate;
const chronologyCheck = G.chronologyCheck;
const mapDailyRow = G.mapDailyRow;
const mapIntensity = G.mapIntensity;
const mapActivity = G.mapActivity;
const MANUAL_SOURCE = G.MANUAL_SOURCE;
const findWorkoutLocal = G.findWorkoutLocal;
const findWeightLocal = G.findWeightLocal;
const findTombstone = G.findTombstone;
const mapSteps = G.mapSteps;
const renderPreview = G.renderPreview;

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
function ok(detail) { return { ok: true, detail: detail || null }; }
function bad(reason, detail) { return { ok: false, reason: reason, detail: detail || null }; }

function loadHyroxData() { return HD; }
function loadMorning() {
  try { return require('../src/data/hyrox-morning.js'); } catch (e) { return null; }
}
function loadMorningUnextended() {
  try { return require('../../../../vendor/p1-3-rc3-b1de280e2a65/src/data/hyrox-morning.js'); } catch (e) { return null; }
}
function loadWellness() {
  try { return require('../src/data/hyrox-wellness.js'); } catch (e) { return null; }
}

const HOST = 'https://personal.connectapi.garmin.com';
const DATASETS = ['weight', 'daily', 'sleep', 'hrv', 'vo2max', 'activities'];
const UNAUTH_BODY = '{"ok":false,"code":"AUTH"}';

const _proxy = require('../netlify/lib/garmin-personal-proxy-sync.cjs');
const handleProxy = _proxy.handleProxy;
const resetProxyState = _proxy.resetProxyState;
const IN_FLIGHT = _proxy.IN_FLIGHT;
const TOKEN_CACHE = _proxy.TOKEN_CACHE;

function mem() {
  var m = new Map();
  return { getItem: function (k) { return m.has(k) ? m.get(k) : null; }, setItem: function (k, v) { m.set(k, String(v)); }, removeItem: function (k) { m.delete(k); }, _m: m };
}
function seedStore(parts, now) {
  var D = loadHyroxData();
  var s = mem();
  var data = {
    version: 2,
    weight: deepClone(parts.weight || []),
    workouts: deepClone(parts.workouts || []),
    nutrition: deepClone(parts.nutrition || []),
    daily: (parts.daily || []).map(function (d) {
      var x = deepClone(d);
      if (!x.createdAt) x.createdAt = (x.date || '2026-11-16') + 'T05:00:00.000Z';
      return x;
    }),
    sessions: deepClone(parts.sessions || []),
    meals: [], body: [], walks: [], dayStates: [], planEvents: [],
    ownerSettings: deepClone(parts.ownerSettings || [])
  };
  if (parts.version != null) data.version = parts.version;
  s.setItem(D.STORAGE_KEY, JSON.stringify(data));
  if (parts.backup) s.setItem(D.IMPORT_BACKUP_KEY, typeof parts.backup === 'string' ? parts.backup : JSON.stringify(parts.backup));
  var nowFn = function () { return now || new Date('2026-11-23T20:00:00.000Z'); };
  return { D: D, storage: s, api: D.createStore(s, { now: nowFn }), data: data };
}
function rawOf(st) { return st.storage.getItem(st.D.STORAGE_KEY); }
function parsed(st) { return JSON.parse(rawOf(st)); }
function defaultSettings() { return { timeZone: 'Asia/Qatar', preferredLocale: 'en' }; }
function existingApp(ctx) {
  var dailies = ctx.loadFixture('existing-app-dailies.json');
  var rest = ctx.loadFixture('existing-app-weight-and-sessions.json');
  return { daily: dailies, weight: rest.weight, workouts: rest.workouts, sessions: rest.sessions };
}
function fakeJwt(exp) {
  function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
  return b64({ alg: 'none' }) + '.' + b64({ exp: exp }) + '.x';
}

var CONTRACTS = {};
CONTRACTS['G-TZ-01'] = function (ctx) {
  var al = mapActivityList(ctx.loadFixture('activities-midnight-crossing.json'));
  var late = al.activities.filter(function (a) { return a.activityId === '90000000016'; })[0];
  if (!late || late.skip || late.date !== '2026-11-16' || late.crossesMidnight !== true || late.durationMin !== 60) return bad('midnight activity not dated 2026-11-16 with warning');
  if (late.startUtcMs !== Date.UTC(2026, 10, 16, 20, 30, 0)) return bad('GMT parse drifted with process TZ');
  return ok(late);
};
CONTRACTS['G-TZ-02'] = function (ctx) {
  var wr = mapWeightRange(ctx.loadFixture('weight-range-gtz02-utc-vs-qatar.json'));
  if (!wr.latest || wr.latest.date !== '2026-11-20') return bad('expected Qatar date 2026-11-20, got ' + (wr.latest && wr.latest.date));
  var utcDate = new Date(wr.latest.timestampGMT).toISOString().slice(0, 10);
  if (utcDate !== '2026-11-19') return bad('UTC date should be 19th');
  return ok(wr.latest);
};
CONTRACTS['G-TZ-03'] = function (ctx) {
  var cases = [
    ['userprofile-settings-timezone-mismatch.json', 'TIMEZONE_MISMATCH'],
    ['userprofile-settings-timezone-riyadh.json', 'TIMEZONE_MISMATCH'],
    ['userprofile-settings-timezone-gmt.json', 'TIMEZONE_MISMATCH'],
    ['userprofile-settings-timezone-missing.json', 'TIMEZONE_MISSING'],
    ['userprofile-settings-timezone-null.json', 'TIMEZONE_MISSING'],
    ['userprofile-settings-lookup-failed.json', 'SETTINGS_LOOKUP_FAILED']
  ];
  for (var i = 0; i < cases.length; i++) {
    var fx = ctx.loadFixture(cases[i][0]);
    var tz = evaluateTimezone(fx.error ? { error: fx.error } : fx);
    if (tz.accepted) return bad('should hold ' + cases[i][0]);
    if (tz.reason !== cases[i][1]) return bad('reason ' + tz.reason + ' for ' + cases[i][0]);
    var st = seedStore(existingApp(ctx));
    var before = rawOf(st);
    var r = applyMerge(st.api, { applySteps: { '2026-11-16': true } }, { settings: fx.error ? { error: fx.error } : fx, todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json') });
    if (r.ok && r.wrote) return bad('wrote despite hold ' + cases[i][0]);
    if (rawOf(st) !== before) return bad('bytes changed on hold');
  }
  var good = evaluateTimezone(ctx.loadFixture('userprofile-settings-timezone.json'));
  if (!good.accepted) return bad('Asia/Qatar should be accepted');
  return ok();
};
CONTRACTS['G-TZ-04'] = function (ctx) {
  var a = mapSleep(ctx.loadFixture('daily-sleep-sample.json'));
  var b = mapSleep(ctx.loadFixture('daily-sleep-epoch-ms.json'));
  var c = mapSleep(ctx.loadFixture('daily-sleep-unparseable.json'));
  if (a.skip || a.wakeDate !== '2026-11-21' || a.sleepH !== 7) return bad('ISO sleep');
  if (b.skip || b.wakeDate !== '2026-11-21' || b.sleepH !== 7) return bad('epoch-ms sleep ' + JSON.stringify(b));
  if (!c.skip || c.reason !== 'UNPARSEABLE_WAKE') return bad('unparseable should HOLD not calendarDate write');
  return ok();
};
CONTRACTS['G-TZ-05'] = function (ctx) {
  var b = mapSleep(ctx.loadFixture('daily-sleep-epoch-ms.json'));
  if (b.skip || b.sleepH !== 7 || b.napsAdded || !b.napsListed || b.napTimeSeconds !== 1800) return bad('naps must be listed not added: ' + JSON.stringify(b));
  return ok();
};
CONTRACTS['G-TZ-06'] = function (ctx) {
  var al = mapActivityList(ctx.loadFixture('activities-midnight-crossing.json'));
  var mon = al.activities.filter(function (a) { return a.activityId === '90000000017'; })[0];
  if (!mon || mon.date !== '2026-11-16') return bad('week-boundary date');
  return ok();
};
CONTRACTS['G-TZ-07'] = function (ctx) {
  var al = mapActivityList(ctx.loadFixture('activities-midnight-crossing.json'));
  if (al.activities.some(function (a) { return a.skip && a.reason === 'DST_AMBIGUOUS'; })) return bad('GMT present should not be DST-ambiguous');
  var tz = evaluateTimezone({ timeZone: 'Europe/London' });
  if (tz.accepted) return bad('non-Qatar already holds');
  return ok();
};
CONTRACTS['G-TZ-08'] = function (ctx) {
  var names = ['dailysummaries-v2-normal-7d.json', 'dailysummaries-v2-edge-cases.json', 'dailysummaries-v2-today-in-progress.json'];
  for (var i = 0; i < names.length; i++) {
    var rows = ctx.loadFixture(names[i]).data;
    for (var j = 0; j < rows.length; j++) {
      if (!rows[j].wellnessChronology || !rows[j].calendarDate) continue;
      var c = chronologyCheck(rows[j]);
      if (!c.ok) return bad(names[i] + ' ' + rows[j].calendarDate + ' ' + c.reason);
    }
  }
  return ok();
};
CONTRACTS['G-TZ-09'] = function (ctx) {
  var fx = ctx.loadFixture('dailysummaries-v2-gtz09-chronology-mismatch.json');
  var mapped = mapDailyList(fx, { todayQatar: ctx.todayQatar });
  if (mapped.rows.length) return bad('should not map mismatched row');
  if (!mapped.issues.some(function (i) { return i.reason === 'CALENDAR_MISMATCH'; })) return bad('expected CALENDAR_MISMATCH');
  var st = seedStore(existingApp(ctx));
  var before = rawOf(st);
  var r = applyMerge(st.api, { applySteps: { '2026-11-22': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: fx });
  if (r.wrote || rawOf(st) !== before) return bad('wrote the mismatch row');
  return ok({ uuid: fx.data[0].uuid });
};
CONTRACTS['G-TZ-10'] = function (ctx) {
  var fx = ctx.loadFixture('dailysummaries-v2-today-in-progress.json');
  var m = mapDailyList(fx, { todayQatar: '2026-11-23' });
  if (!m.rows[0] || !m.rows[0].inProgress || m.rows[0].writableSteps || m.rows[0].writableIntensity) return bad('today should be preview-only');
  var st = seedStore({ daily: [{ id: 'daily-2026-11-23', date: '2026-11-23', createdAt: '2026-11-23T01:00:00.000Z' }] }, new Date('2026-11-23T20:00:00.000Z'));
  applyMerge(st.api, { applySteps: { '2026-11-23': true }, applyIntensity: { '2026-11-23': true } }, { settings: defaultSettings(), todayQatar: '2026-11-23', dailyPayload: fx });
  var rec = parsed(st).daily.filter(function (d) { return d.date === '2026-11-23'; })[0];
  if (rec && rec.steps && rec.steps.state === 'OBSERVED') return bad('persisted today steps');
  if (rec && rec.intensityMin && rec.intensityMin.state === 'OBSERVED') return bad('persisted today intensity');
  return ok();
};
CONTRACTS['G-SYNC-01'] = CONTRACTS['G-TZ-10'];
CONTRACTS['G-SYNC-02'] = function (ctx) {
  var fx = ctx.loadFixture('dailysummaries-v2-today-in-progress.json');
  var beforeMidnight = mapDailyList(fx, { todayQatar: todayQatarFromNow(new Date('2026-11-23T20:59:59.000Z')) });
  if (!beforeMidnight.rows[0].inProgress) return bad('20:59Z is still 23 Nov Qatar');
  var afterMidnight = mapDailyList(fx, { todayQatar: todayQatarFromNow(new Date('2026-11-23T21:00:00.000Z')) });
  if (afterMidnight.rows[0].inProgress) return bad('21:00Z is 24 Nov Qatar; 23 Nov must be writable');
  if (todayQatarFromNow(new Date('2026-11-23T21:00:00.000Z')) !== '2026-11-24') return bad('UTC today leak');
  var st = seedStore({ daily: [{ id: 'daily-2026-11-23', date: '2026-11-23', createdAt: '2026-11-23T01:00:00.000Z' }] }, new Date('2026-11-24T00:00:00+03:00'));
  var r = applyMerge(st.api, { applySteps: { '2026-11-23': true }, applyIntensity: { '2026-11-23': true } }, { settings: defaultSettings(), todayQatar: '2026-11-24', dailyPayload: fx, nowIso: '2026-11-24T00:05:00.000Z' });
  if (!r.ok || !r.wrote) return bad('should write once the day is final: ' + JSON.stringify(r));
  var rec = parsed(st).daily.filter(function (d) { return d.date === '2026-11-23'; })[0];
  if (!rec || !rec.steps || rec.steps.value !== 4200) return bad('final day steps not written');
  return ok();
};
CONTRACTS['G-WT-01'] = function (ctx) {
  var wr = mapWeightRange(ctx.loadFixture('weight-range-sample.json'));
  var d20 = wr.samples.filter(function (s) { return s.date === '2026-11-20'; });
  if (d20.length !== 2) return bad('expected 2 samples on 20 Nov');
  var latest20 = d20[d20.length - 1];
  if (latest20.kg !== 97.4 || latest20.timestampGMT !== 1795154400000) return bad('latest on 20 Nov should be 09:00 Qatar 97.4, got ' + JSON.stringify(latest20));
  if (!d20.some(function (s) { return s.timestampGMT === 1795143600000 && s.kg === 97.8; })) return bad('06:00 sample missing');
  return ok();
};
CONTRACTS['G-WT-02'] = function (ctx) {
  // t112 CC #2 re-point: tick only one completed past day's steps (not a second date).
  var fx = ctx.loadFixture('dailysummaries-v2-normal-7d.json');
  var store = existingApp(ctx);
  var pv = preview({ settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: fx, storeData: store });
  if (pv.preTicked || pv.tickAll || pv.items.some(function (i) { return i.ticked; })) return bad('pre-ticked');
  var st = seedStore(store);
  var conf = { applySteps: { '2026-11-22': true } };
  var r = applyMerge(st.api, conf, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: fx });
  if (!r.ok || !r.wrote) return bad('single-date tick should write ' + JSON.stringify(r));
  var after = parsed(st);
  var d22 = after.daily.filter(function (d) { return d.date === '2026-11-22' && d.steps && d.steps.value; });
  if (!d22.length) return bad('22 Nov steps not written: ' + JSON.stringify(after.daily));
  var others = after.daily.filter(function (d) { return d.date !== '2026-11-22' && d.steps && d.steps.source === 'GARMIN_PERSONAL_API'; });
  if (others.length) return bad('only the ticked date should be written, also got ' + others.map(function (d) { return d.date; }).join(','));
  return ok();
};
CONTRACTS['G-WT-03'] = function (ctx) {
  var doc = { dailyWeightSummaries: [{ summaryDate: '2026-11-20', allWeightMetrics: [
    { calendarDate: '2026-11-20', timestampGMT: 1795143600000, weight: 97.8 },
    { calendarDate: '2026-11-20', timestampGMT: 1795143600000, weight: 97.4 }
  ] }] };
  var wr = mapWeightRange(doc);
  if (wr.samples.length !== 0) return bad('conflict should hold both');
  if (!wr.held.some(function (h) { return h.reason === 'DUPLICATE_TIMESTAMP_DIFF_KG'; })) return bad('expected HOLD reason');
  return ok();
};
CONTRACTS['G-WT-04'] = CONTRACTS['G-WT-03'];
CONTRACTS['G-WT-05'] = function (ctx) {
  // Re-pointed t111u (Dawit): preview offered Replace against a same-date manual row but apply added w-g-* beside it.
  // Preview and apply now agree: manual wins; no Replace; apply does not add a second weigh-in and does not overwrite 97.6.
  var store = existingApp(ctx);
  var pv = preview({ settings: defaultSettings(), todayQatar: ctx.todayQatar, weightPayload: ctx.loadFixture('weight-range-sample.json'), storeData: store });
  var wItems = pv.items.filter(function (i) { return i.collection === 'weight' && i.date === '2026-11-20'; });
  if (wItems.some(function (i) { return i.replaceOffered === true; })) return bad('must not offer Replace against a different-id manual row');
  var st = seedStore(store);
  var wr = mapWeightRange(ctx.loadFixture('weight-range-sample.json'));
  var afternoon = wr.samples.filter(function (s) { return s.timestampGMT === 1795154400000; })[0];
  var conf = { applyWeight: {}, replaceWeight: {} };
  conf.applyWeight[afternoon.timestampGMT] = true;
  conf.replaceWeight[afternoon.timestampGMT] = true;
  var r = applyMerge(st.api, conf, { settings: defaultSettings(), todayQatar: ctx.todayQatar, weightPayload: ctx.loadFixture('weight-range-sample.json') });
  if (r.wrote) return bad('manual same-date must not be overwritten or joined by a w-g-* row: ' + JSON.stringify(r));
  var after = parsed(st);
  var manual = after.weight.filter(function (w) { return w.id === 'w-manual-2026-11-20'; })[0];
  if (!manual || manual.kg !== 97.6) return bad('manual coach value changed');
  if (after.weight.some(function (w) { return String(w.id).indexOf('w-g-') === 0; })) return bad('garmin sample must not be added beside the manual row');
  if (after.weight.length !== store.weight.length) return bad('weight list changed');
  return ok();
};
CONTRACTS['G-UNIT-01'] = function (ctx) {
  var wr = mapWeightRange(ctx.loadFixture('weight-range-implausible.json'));
  if (wr.samples.some(function (s) { return s.raw === 75000 || s.kg === 75000; })) return bad('75000 converted or stored');
  if (!wr.held.some(function (h) { return h.raw === 75000 && h.reason === 'OUT_OF_RANGE'; })) return bad('75000 should be refused');
  return ok();
};
CONTRACTS['G-UNIT-02'] = function (ctx) {
  var first = mapWeightRange({ dailyWeightSummaries: [{ allWeightMetrics: [{ calendarDate: '2026-11-16', timestampGMT: 1794798000000, weight: 75 }] }] });
  if (first.samples[0].kg !== 75) return bad('75 kg first');
  var second = mapWeightRange({ dailyWeightSummaries: [{ allWeightMetrics: [{ calendarDate: '2026-11-16', timestampGMT: 1794798000000, weight: 75000 }] }] });
  if (second.samples.length) return bad('75000 must not map');
  return ok();
};
CONTRACTS['G-UNIT-03'] = function (ctx) {
  var wr = mapWeightRange(ctx.loadFixture('weight-range-implausible.json'));
  if (!wr.samples.some(function (s) { return s.raw === 97.4000015 && s.kg === 97.4; })) return bad('half-up residue');
  return ok();
};
CONTRACTS['G-UNIT-04'] = function (ctx) {
  var wr = mapWeightRange(ctx.loadFixture('weight-range-implausible.json'));
  if (!wr.samples.some(function (s) { return s.raw === 75.45 && s.kg === 75.5; })) return bad('75.45 -> 75.5 got ' + JSON.stringify(wr.samples));
  return ok();
};
CONTRACTS['G-UNIT-05'] = function (ctx) {
  var wr = mapWeightRange(ctx.loadFixture('weight-range-implausible.json'));
  if (wr.samples.some(function (s) { return s.raw === 8 || s.raw === 0 || s.raw === -1; })) return bad('refused values stored');
  if (!wr.samples.some(function (s) { return s.raw === 29.9 && s.implausible && s.kg === 29.9; })) return bad('29.9 should flag implausible but stay in range');
  if (!wr.samples.some(function (s) { return s.raw === 301 && s.implausible; })) return bad('301 should flag');
  return ok();
};
CONTRACTS['G-UNIT-06'] = function (ctx) {
  var wr = mapWeightRange({ dailyWeightSummaries: [{ allWeightMetrics: [{ calendarDate: '2026-11-16', timestampGMT: 1794798000000 }] }] });
  if (!wr.held.some(function (h) { return h.reason === 'MISSING_OR_NON_NUMBER'; })) return bad('missing weight');
  return ok();
};

CONTRACTS['G-SYNC-03'] = function (ctx) {
  var data = existingApp(ctx);
  data.daily = data.daily.map(function (d) {
    if (d.date === '2026-11-20') d.garminLedger = { v: 1, keys: { workouts: [{ localId: 'wo-g-90000000001', activityId: '90000000001' }] }, tombstones: [] };
    return d;
  });
  data.workouts = [{ id: 'wo-g-90000000001', createdAt: '2026-11-20T03:40:00.000Z', date: '2026-11-20', activity: 'Easy run', durationMin: 31, partial: false, notes: 'mine' }];
  var st = seedStore(data);
  preview({ settings: defaultSettings(), todayQatar: ctx.todayQatar, activityPayload: ctx.loadFixture('activities-search-sample.json'), storeData: parsed(st) });
  var existingId = findWorkoutLocal(parsed(st), '90000000001');
  if (existingId !== 'wo-g-90000000001') return bad('key must be activityId');
  return ok();
};
CONTRACTS['G-SYNC-04'] = function (ctx) {
  var st = seedStore({ daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z' }] });
  var fx = ctx.loadFixture('dailysummaries-v2-normal-7d.json');
  var conf = { applySteps: { '2026-11-16': true }, applyIntensity: { '2026-11-16': true } };
  var ctxA = { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: fx, nowIso: '2026-11-23T08:00:00.000Z' };
  var r1 = applyMerge(st.api, conf, ctxA);
  if (!r1.ok || !r1.wrote) return bad('first write ' + JSON.stringify(r1));
  var after1 = rawOf(st);
  var r2 = applyMerge(st.api, conf, ctxA);
  var r3 = applyMerge(st.api, conf, ctxA);
  if (r2.wrote || r3.wrote) return bad('replay wrote');
  if (rawOf(st) !== after1) return bad('replay changed bytes (updatedAt?)');
  return ok();
};
CONTRACTS['G-SYNC-05'] = function (ctx) {
  var st = seedStore({ daily: existingApp(ctx).daily });
  var fx = ctx.loadFixture('dailysummaries-v2-normal-7d.json');
  applyMerge(st.api, { applyIntensity: { '2026-11-16': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: fx });
  var rec = parsed(st).daily.filter(function (d) { return d.date === '2026-11-16'; })[0];
  if (!rec || rec.intensityMin.value !== 46 || rec.intensityMin.source !== MANUAL_SOURCE) return bad('source flipped or value lost ' + JSON.stringify(rec && rec.intensityMin));
  return ok();
};
CONTRACTS['G-SYNC-06'] = function (ctx) {
  var fx = ctx.loadFixture('steps-daily-28d-sample.json');
  var mapped = mapDailyList(fx, { todayQatar: ctx.todayQatar });
  if (mapped.rows.length) return bad('28-day steps shape must not map as v2 dailies');
  return ok();
};

CONTRACTS['G-DEL-01'] = function (ctx) {
  var al = mapActivityList(ctx.loadFixture('activities-page-cap-incomplete.json'));
  if (al.complete !== false || !al.pageCapHit || al.activities.length !== 200) return bad('page cap');
  var pv = preview({ settings: defaultSettings(), todayQatar: ctx.todayQatar, activityPayload: ctx.loadFixture('activities-page-cap-incomplete.json'), storeData: { daily: existingApp(ctx).daily, workouts: [] } });
  if (pv.items.some(function (i) { return i.status === 'Missing'; })) return bad('Missing on incomplete fetch');
  if (pv.warnings.indexOf('ACTIVITIES_INCOMPLETE') === -1) return bad('expected incomplete warning');
  return ok();
};
CONTRACTS['G-DEL-02'] = function (ctx) {
  var data = existingApp(ctx);
  data.daily = data.daily.map(function (d) {
    if (d.date === '2026-11-20') d.garminLedger = { v: 1, keys: {}, tombstones: [{ collection: 'workouts', activityId: '90000000001', deletedAt: '2026-11-22T10:00:00.000Z' }] };
    return d;
  });
  var st = seedStore(data);
  applyMerge(st.api, { applyActivity: { '90000000001': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, activityPayload: ctx.loadFixture('activities-search-sample.json') });
  if (parsed(st).workouts && parsed(st).workouts.some(function (w) { return String(w.id).indexOf('90000000001') !== -1 || w.activity === 'Easy run'; })) return bad('resurrected');
  var led = parsed(st).daily.filter(function (d) { return d.date === '2026-11-20'; })[0];
  if (!led.garminLedger.tombstones.length) return bad('tombstone lost');
  return ok();
};
CONTRACTS['G-DEL-03'] = function (ctx) {
  var data = existingApp(ctx);
  data.workouts = [{ id: 'wo-old', createdAt: '2026-11-01T00:00:00.000Z', date: '2026-11-01', activity: 'Easy run', durationMin: 20, partial: false, notes: '' }];
  var st = seedStore(data);
  applyMerge(st.api, { applyActivity: { '90000000001': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, activityPayload: ctx.loadFixture('activities-search-sample.json') });
  var ws = parsed(st).workouts;
  if (ws.length !== 2) return bad('should add by activityId not title, got ' + ws.length);
  if (!ws.some(function (w) { return w.id === 'wo-old'; })) return bad('old id lost');
  return ok();
};
CONTRACTS['G-WO-01'] = function (ctx) {
  var data = existingApp(ctx);
  data.workouts = [{ id: 'wo-man', createdAt: '2026-11-20T03:00:00.000Z', date: '2026-11-20', activity: 'Easy run', durationMin: 30, partial: false, notes: 'keep me' }];
  var st = seedStore(data);
  var pv = preview({ settings: defaultSettings(), todayQatar: ctx.todayQatar, activityPayload: ctx.loadFixture('activities-search-sample.json'), storeData: parsed(st) });
  if (pv.items.some(function (i) { return i.ticked; })) return bad('pre-ticked');
  var before = rawOf(st);
  applyMerge(st.api, {}, { settings: defaultSettings(), todayQatar: ctx.todayQatar, activityPayload: ctx.loadFixture('activities-search-sample.json') });
  if (rawOf(st) !== before) return bad('wrote without tick');
  if (parsed(st).workouts[0].notes !== 'keep me') return bad('notes lost');
  return ok();
};
CONTRACTS['G-WO-02'] = function (ctx) {
  var data = existingApp(ctx);
  data.sessions = [{ id: 'ses-2026-11-20-run', createdAt: '2026-11-20T00:00:00.000Z', date: '2026-11-20', status: 'PARTIAL', variant: 'ORIGINAL_60', modified: false, title: 'Planned run', planSlotId: 'mon-run', runSteps: 400 }];
  var st = seedStore(data);
  var sess = JSON.stringify(parsed(st).sessions);
  applyMerge(st.api, { applyActivity: { '90000000001': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, activityPayload: ctx.loadFixture('activities-search-sample.json') });
  if (JSON.stringify(parsed(st).sessions) !== sess) return bad('session touched');
  if (parsed(st).sessions[0].status !== 'PARTIAL' || parsed(st).sessions[0].runSteps !== 400) return bad('runSteps/status changed');
  return ok();
};
CONTRACTS['G-WO-03'] = function (ctx) {
  var data = existingApp(ctx);
  var st = seedStore(data);
  var sess = JSON.stringify(parsed(st).sessions);
  applyMerge(st.api, { applySteps: { '2026-11-16': true }, applyActivity: { '90000000001': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json'), activityPayload: ctx.loadFixture('activities-search-sample.json') });
  if (JSON.stringify(parsed(st).sessions) !== sess) return bad('sessions not byte-exact');
  if (parsed(st).sessions[0].status !== 'NOT_STARTED') return bad('auto-completed');
  return ok();
};
CONTRACTS['G-WO-04'] = function (ctx) {
  var W = loadWellness();
  var data = existingApp(ctx);
  var st = seedStore(data);
  applyMerge(st.api, { applyActivity: { '90000000001': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, activityPayload: ctx.loadFixture('activities-search-sample.json') });
  var after = parsed(st);
  if ((after.walks || []).length) return bad('created a walk');
  var ds20 = W.daySteps('2026-11-20', { dailies: after.daily, walks: after.walks || [], sessions: after.sessions || [] });
  if (ds20.total != null) return bad('20 Nov daily is MISSING; activity must not invent steps: ' + JSON.stringify(ds20));
  var ds16 = W.daySteps('2026-11-16', { dailies: after.daily, walks: after.walks || [], sessions: after.sessions || [] });
  if (ds16.total !== 9000 || ds16.source !== 'daily') return bad('16 Nov daily steps lost or mixed: ' + JSON.stringify(ds16));
  return ok();
};
CONTRACTS['G-WO-05'] = function (ctx) {
  var st = seedStore(existingApp(ctx));
  applyMerge(st.api, { applyActivity: { '90000000001': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, activityPayload: ctx.loadFixture('activities-search-sample.json') });
  if ((parsed(st).walks || []).length) return bad('activity written as walk');
  if (!parsed(st).workouts.length) return bad('expected a workout');
  return ok();
};
CONTRACTS['G-WO-06'] = function (ctx) {
  var data = existingApp(ctx);
  data.sessions = [{ id: 'ses-skip', createdAt: '2026-11-20T00:00:00.000Z', date: '2026-11-20', status: 'SKIPPED', title: 'Plan run' }];
  var st = seedStore(data);
  applyMerge(st.api, { applyActivity: { '90000000001': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, activityPayload: ctx.loadFixture('activities-search-sample.json') });
  var s = parsed(st).sessions[0];
  if (s.status !== 'SKIPPED' || s.runSteps != null) return bad('skipped session mutated');
  return ok();
};
CONTRACTS['G-STEP-01'] = CONTRACTS['G-WO-04'];
CONTRACTS['G-STEP-02'] = function (ctx) {
  var data = existingApp(ctx);
  data.sessions = [{ id: 'ses', createdAt: '2026-11-20T00:00:00.000Z', date: '2026-11-20', status: 'NOT_STARTED', title: 'Plan run', runSteps: 0 }];
  var st = seedStore(data);
  applyMerge(st.api, { applyActivity: { '90000000001': true }, applySteps: { '2026-11-16': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json'), activityPayload: ctx.loadFixture('activities-search-sample.json') });
  var s = parsed(st).sessions[0];
  if (s.runSteps !== 0) return bad('importer wrote runSteps');
  return ok();
};
CONTRACTS['G-STEP-03'] = function (ctx) {
  var issues = mapDailyList(ctx.loadFixture('dailysummaries-v2-edge-cases.json'), { todayQatar: ctx.todayQatar });
  var r10 = issues.rows.filter(function (r) { return r.calendarDate === '2026-11-10'; })[0];
  if (r10 && r10.steps.state === 'OBSERVED') return bad('no-wellness produced steps');
  return ok();
};
CONTRACTS['G-STEP-04'] = function (ctx) {
  var row = { calendarDate: '2026-11-15', source: 'garmin', includesWellnessData: true,
    wellnessChronology: { startTimestampGmt: '2026-11-14T21:00:00.0', startTimestampLocal: '2026-11-15T00:00:00.0', endTimestampGmt: '2026-11-15T20:59:00.0', endTimestampLocal: '2026-11-15T23:59:00.0' },
    movement: { steps: { goal: 10000, distanceInMeters: 5000 } } };
  var m = mapDailyRow(row, { todayQatar: ctx.todayQatar });
  if (m.steps.state === 'OBSERVED') return bad('steps invented from distance');
  return ok();
};
CONTRACTS['G-STEP-05'] = function (ctx) {
  var r = mapDailyList(ctx.loadFixture('dailysummaries-v2-edge-cases.json'), { todayQatar: ctx.todayQatar }).rows.filter(function (x) { return x.calendarDate === '2026-11-13'; })[0];
  if (!r.steps.refused || r.steps.value != null) return bad('250001 should be refused not clamped');
  return ok();
};

function edgeRow(ctx, date) {
  return mapDailyList(ctx.loadFixture('dailysummaries-v2-edge-cases.json'), { todayQatar: ctx.todayQatar }).rows.filter(function (r) { return r.calendarDate === date; })[0];
}
CONTRACTS['G-INT-01'] = function (ctx) {
  var r = mapDailyList(ctx.loadFixture('dailysummaries-v2-normal-7d.json'), { todayQatar: ctx.todayQatar }).rows.filter(function (x) { return x.calendarDate === '2026-11-16'; })[0];
  if (!r || r.intensity.value !== 46 || r.intensity.moderate !== 30 || r.intensity.vigorous !== 8) return bad(JSON.stringify(r && r.intensity));
  return ok();
};
CONTRACTS['G-INT-02'] = function (ctx) {
  var r = edgeRow(ctx, '2026-11-11');
  if (!r || r.intensity.state !== 'UNKNOWN') return bad('missing vigorous should be unknown');
  return ok();
};
CONTRACTS['G-INT-03'] = function (ctx) {
  var im = mapIntensity({ vigorous: 8 });
  if (im.state !== 'UNKNOWN' || im.value != null) return bad('missing moderate');
  return ok();
};
// RE-POINTED, not deleted (Claude QA t118u, 24 Nov 2026). Owner decision t118u: Garmin 0 steps = not worn and the
// DATE is not imported. The arithmetic "0+0 = 0 (real zero)" is still asserted on mapIntensity; the 14 Nov fixture day
// (0 steps, 0+0 intensity) must now map to a not-worn row with nothing writable.
CONTRACTS['G-INT-04'] = function (ctx) {
  var im = mapIntensity({ moderate: 0, vigorous: 0 });
  if (im.state !== 'OBSERVED' || im.value !== 0) return bad('0+0 should be 0');
  var r = edgeRow(ctx, '2026-11-14');
  if (!r || !r.steps.zeroAsMissing || r.writableSteps || r.writableIntensity) return bad('t118u: a 0-step day must not be writable: ' + JSON.stringify(r && { s: r.steps, i: r.intensity }));
  return ok();
};
CONTRACTS['G-INT-05'] = function (ctx) {
  var r = edgeRow(ctx, '2026-11-10');
  if (r && r.intensity.state === 'OBSERVED') return bad('no wellness should not be observed');
  return ok();
};
CONTRACTS['G-INT-06'] = function (ctx) {
  var im = mapIntensity({ moderate: 0, vigorous: 8 });
  if (im.state !== 'OBSERVED' || im.value !== 16) return bad(JSON.stringify(im));
  return ok();
};
CONTRACTS['G-INT-07'] = function (ctx) {
  var im = mapIntensity({ moderate: 30, vigorous: 2000 });
  if (im.state !== 'UNKNOWN' || !im.overCap) return bad('over cap');
  return ok();
};
CONTRACTS['G-INT-08'] = function (ctx) {
  var r = edgeRow(ctx, '2026-11-13');
  if (!r || r.intensity.state !== 'UNKNOWN') return bad('negative');
  return ok();
};
CONTRACTS['G-INT-09'] = function (ctx) {
  var st = seedStore({ daily: existingApp(ctx).daily });
  applyMerge(st.api, { applyIntensity: { '2026-11-16': true, '2026-11-18': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json') });
  var days = parsed(st).daily;
  var d16 = days.filter(function (d) { return d.date === '2026-11-16'; })[0];
  if (d16.intensityMin.source !== MANUAL_SOURCE || d16.intensityMin.value !== 46) return bad('manual 46 lost');
  var HM = loadMorning();
  var week = HM.weeklyIntensity('2026-11-22', days, 1);
  if (!week[0] || week[0].total < 46) return bad('weekly lost manual');
  var unext = loadMorningUnextended();
  var apiRow = { intensityMin: { state: 'OBSERVED', value: 46, source: API_SOURCE, moderate: 30, vigorous: 8 } };
  if (unext) {
    var u = unext.intensityRead(apiRow);
    if (u.state !== 'INVALID' || u.value !== null) return bad('unextended must be INVALID not 0: ' + JSON.stringify(u));
  }
  var ext = HM.intensityRead(apiRow);
  if (ext.state !== 'OBSERVED' || ext.value !== 46) return bad('extended reader should accept API source');
  return ok();
};
CONTRACTS['G-INT-10'] = function (ctx) {
  resetProxyState();
  var logs = [];
  var body = ctx.loadFixture('dailysummaries-v2-normal-7d.json');
  var res = handleProxy({
    allowOfflineHandler: true, garminConfigured: true, ownerCodeAccepted: true,
    origin: 'https://hyrox-phase7-private-test.netlify.app', appOrigin: 'https://hyrox-phase7-private-test.netlify.app',
    op: 'fetch', dataset: 'daily', startDate: '2026-11-16', endDate: '2026-11-16', todayQatar: ctx.todayQatar,
    nowMs: Date.UTC(2026, 10, 23, 10, 0, 0), logs: logs, tokenDailyCap: 6, tokenExchangeCount: { n: 0 },
    fetch: function (url, init) {
      if (init && init.redirect !== 'manual') throw new Error('redirect not manual');
      if (/personal-api-key\/token/.test(url)) return { status: 200, bodyText: fakeJwt(Date.UTC(2026, 10, 23, 10, 0, 0) / 1000 + 12 * 3600) };
      if (/userprofile\/settings/.test(url)) return { status: 200, body: defaultSettings() };
      return { status: 200, body: body };
    }
  });
  var s = JSON.stringify(res.body);
  if (s.indexOf('calories') !== -1 || s.indexOf('heartRate') !== -1 || s.indexOf('burnedTotal') !== -1) return bad('calories/HR leaked');
  return ok();
};
CONTRACTS['G-BK-01'] = function (ctx) {
  var st = seedStore({ daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z', steps: { state: 'OBSERVED', value: 9000 } }], weight: [], workouts: [] });
  var fx = ctx.loadFixture('dailysummaries-v2-normal-7d.json');
  var conf = { applySteps: { '2026-11-16': true }, replaceSteps: { '2026-11-16': true } };
  var r = applyMerge(st.api, conf, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: fx, nowIso: '2026-11-23T20:00:00.000Z' });
  if (!r.ok || !r.wrote) return bad(JSON.stringify(r));
  var after = parsed(st);
  var set = (after.ownerSettings || []).filter(function (s) { return s && s.id === 'app-settings'; })[0];
  if (!set || !set.garminLedger) return bad('settings ledger missing after apply: ' + JSON.stringify(after.ownerSettings));
  var text = st.api.exportJSON();
  if (String(text).indexOf('garminLedger') === -1) return bad('export omitted the settings ledger');
  var s2 = mem();
  var api2 = st.D.createStore(s2, { now: function () { return new Date('2026-11-23T20:00:00Z'); } });
  var pv = api2.previewImport(text);
  var rr = api2.applyImport(text, { confirm: 'REPLACE', expectCurrent: pv.preview.current, expectCurrentExt: pv.preview.currentExt });
  if (!rr.ok) return bad('restore failed ' + JSON.stringify(rr));
  var back = JSON.parse(s2.getItem(st.D.STORAGE_KEY));
  var set2 = (back.ownerSettings || []).filter(function (s) { return s && s.id === 'app-settings'; })[0];
  if (!set2 || !set2.garminLedger) return bad('ledger lost on restore');
  var d16 = (back.daily || []).filter(function (d) { return d.date === '2026-11-16'; })[0];
  if (!d16 || !d16.steps || d16.steps.source !== 'GARMIN_PERSONAL_API') return bad('steps provenance lost on restore');
  return ok();
};
CONTRACTS['G-BK-02'] = function (ctx) {
  var st = seedStore({ daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z' }] });
  var fx = ctx.loadFixture('dailysummaries-v2-normal-7d.json');
  var conf = { applySteps: { '2026-11-16': true }, applyIntensity: { '2026-11-16': true } };
  applyMerge(st.api, conf, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: fx });
  var n1 = parsed(st).daily.length;
  applyMerge(st.api, conf, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: fx });
  if (parsed(st).daily.length !== n1) return bad('duplicate daily');
  return ok();
};
CONTRACTS['G-BK-03'] = function (ctx) {
  var st = seedStore({ daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z' }] });
  var before = rawOf(st);
  var origSet = st.storage.setItem.bind(st.storage);
  var first = true;
  st.storage.setItem = function (k, v) {
    if (k === st.D.STORAGE_KEY && first) { first = false; throw new Error('save fail'); }
    return origSet(k, v);
  };
  var r = applyMerge(st.api, { applySteps: { '2026-11-16': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json') });
  if (r.ok && r.wrote) return bad('should fail');
  if (rawOf(st) !== before) return bad('partial write / no rollback');
  if (!r.rolledBack && r.code !== 'save_failed') return bad('expected rollback mark');
  return ok();
};
CONTRACTS['G-BK-04'] = function (ctx) {
  var st = seedStore({ daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z' }] });
  if (st.storage.getItem(st.D.IMPORT_BACKUP_KEY)) return bad('pre-existing slot');
  applyMerge(st.api, { applySteps: { '2026-11-16': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json') });
  if (st.storage.getItem(st.D.IMPORT_BACKUP_KEY) != null) return bad('wrote prior-copy slot');
  return ok();
};
CONTRACTS['G-BK-05'] = function (ctx) {
  var pend = ctx.loadFixture('store-restore-pending.json');
  var D = loadHyroxData();
  var s = mem();
  var v2 = pend['hyrox.v1'];
  v2.daily = [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z' }];
  v2.sessions = []; v2.meals = []; v2.body = []; v2.walks = []; v2.dayStates = []; v2.planEvents = []; v2.ownerSettings = [];
  s.setItem(D.STORAGE_KEY, JSON.stringify(v2));
  s.setItem(D.IMPORT_BACKUP_KEY, JSON.stringify(pend['hyrox.v1.pre-import-backup']));
  var api = D.createStore(s, { now: function () { return new Date('2026-11-23T20:00:00Z'); } });
  var before = s.getItem(D.STORAGE_KEY);
  var slot = s.getItem(D.IMPORT_BACKUP_KEY);
  var r = applyMerge(api, { applySteps: { '2026-11-16': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json') });
  if (r.ok && r.wrote) return bad('wrote while pending');
  if (s.getItem(D.STORAGE_KEY) !== before || s.getItem(D.IMPORT_BACKUP_KEY) !== slot) return bad('bytes changed');
  var sN = mem();
  sN.setItem(D.STORAGE_KEY, JSON.stringify({ version: 3, weight: [], workouts: [], nutrition: [], daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z' }] }));
  var apiN = D.createStore(sN, { now: function () { return new Date('2026-11-23T20:00:00Z'); } });
  var rN = applyMerge(apiN, { applySteps: { '2026-11-16': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json') });
  if (rN.ok && rN.wrote) return bad('wrote newer store');
  var sC = mem();
  sC.setItem(D.STORAGE_KEY, '{not-json');
  var apiC = D.createStore(sC, { now: function () { return new Date('2026-11-23T20:00:00Z'); } });
  var rC = applyMerge(apiC, { applySteps: { '2026-11-16': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json') });
  if (rC.ok && rC.wrote) return bad('wrote corrupt store');
  if (sC.getItem(D.STORAGE_KEY) !== '{not-json') return bad('corrupt bytes changed');
  return ok();
};
CONTRACTS['G-BK-06'] = function (ctx) {
  var st = seedStore({ daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z', steps: { state: 'OBSERVED', value: 1 } }] });
  var before = rawOf(st);
  var r = applyMerge(st.api, {}, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json') });
  if (r.wrote || rawOf(st) !== before) return bad('zero accepted rows wrote / empty-replace');
  return ok();
};
CONTRACTS['G-BK-07'] = function (ctx) {
  var st = seedStore({ daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z', steps: { state: 'OBSERVED', value: 9120, source: API_SOURCE }, garminLedger: { v: 1, keys: { daily: { calendarDate: '2026-11-16' } }, tombstones: [] } }] });
  var chk = st.api.exportChecked();
  if (!chk.ok || chk.restorable !== true) return bad('ledger on daily should be restorable: ' + JSON.stringify(chk));
  return ok();
};

CONTRACTS['G-VER-01'] = function (ctx) {
  var fx = ctx.loadFixture('store-schema-1.json');
  var D = loadHyroxData();
  var s = mem();
  var raw = JSON.stringify(fx);
  s.setItem(D.STORAGE_KEY, raw);
  var api = D.createStore(s, { now: function () { return new Date('2026-11-23T20:00:00Z'); } });
  var r = applyMerge(api, { applySteps: { '2026-11-16': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json') });
  if (r.ok && r.wrote) return bad('schema-1 wrote');
  if (s.getItem(D.STORAGE_KEY) !== raw) return bad('schema-1 bytes changed (auto-stamp?)');
  return ok();
};
CONTRACTS['G-VER-02'] = function (ctx) {
  var D = loadHyroxData();
  var s = mem();
  s.setItem(D.STORAGE_KEY, JSON.stringify({ version: 3, weight: [], workouts: [], nutrition: [], daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z' }] }));
  var before = s.getItem(D.STORAGE_KEY);
  var api = D.createStore(s, { now: function () { return new Date('2026-11-23T20:00:00Z'); } });
  var r = applyMerge(api, { applySteps: { '2026-11-16': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json') });
  if (r.wrote || s.getItem(D.STORAGE_KEY) !== before) return bad('v3 mutated');
  return ok();
};
CONTRACTS['G-VER-03'] = function (ctx) {
  var st = seedStore({ daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z', futureField: 'keep-me', steps: { state: 'OBSERVED', value: 1 } }] });
  applyMerge(st.api, { applySteps: { '2026-11-16': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json') });
  if (parsed(st).daily[0].futureField !== 'keep-me') return bad('unknown field dropped');
  var text = st.api.exportJSON();
  if (text.indexOf('keep-me') === -1) return bad('unknown field dropped from export');
  return ok();
};
CONTRACTS['G-VER-04'] = function (ctx) {
  var unext = loadMorningUnextended();
  var rec = { intensityMin: { state: 'OBSERVED', value: 46, source: API_SOURCE, moderate: 30, vigorous: 8 } };
  if (unext) {
    var u = unext.intensityRead(rec);
    if (u.state !== 'INVALID' || u.value !== null) return bad('P1.3 must be INVALID not 0');
  }
  var ext = loadMorning().intensityRead(rec);
  if (ext.state !== 'OBSERVED' || ext.value !== 46) return bad('roll-forward reader');
  return ok();
};
CONTRACTS['G-VER-05'] = function (ctx) {
  var D = loadHyroxData();
  if (typeof D.createStore().applyImport !== 'function') return bad('applyImport still exists for backups');
  return ok();
};
CONTRACTS['G-VER-06'] = function (ctx) {
  var D = loadHyroxData();
  if (D.VERSION !== 2) return bad('VERSION bumped');
  var st = seedStore({ daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z' }] });
  applyMerge(st.api, { applyWeight: (function () { var o = {}; mapWeightRange(ctx.loadFixture('weight-range-sample.json')).samples.forEach(function (s) { o[s.timestampGMT] = true; }); return o; })() }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, weightPayload: ctx.loadFixture('weight-range-sample.json') });
  if (parsed(st).version !== 2) return bad('version changed');
  if (st.storage.getItem('hyrox.v2')) return bad('hyrox.v2 key created');
  if (parsed(st).daily.length !== 1) return bad('stub daily');
  return ok();
};
CONTRACTS['G-ADV-01'] = function (ctx) {
  if (mapDailyList(null, { todayQatar: ctx.todayQatar }).empty !== true) return bad('null');
  if (mapDailyList({ data: [] }, { todayQatar: ctx.todayQatar }).rows.length) return bad('empty');
  return ok();
};
CONTRACTS['G-ADV-02'] = function (ctx) {
  var st = seedStore({ daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z' }] });
  var r = st.api.applyAtomic(function (data) {
    data.daily = data.daily || [];
    for (var i = 0; i < 10001; i++) data.daily.push({ id: 'daily-x-' + i, date: '2026-01-01', createdAt: '2026-01-01T00:00:00.000Z' });
    return { write: true, data: data };
  });
  if (r.ok && r.wrote) return bad('accepted 10001 rows');
  return ok();
};
CONTRACTS['G-ADV-03'] = function (ctx) {
  // Re-pointed t112b Meron R4-D5: conflicting same-date rows HOLD the date (first must not win).
  var first = ctx.loadFixture('dailysummaries-v2-normal-7d.json').data[0];
  var fx = { data: [
    first,
    Object.assign({}, first, { uuid: 'other', movement: { steps: { value: 1, goal: 10000 } } })
  ] };
  var m = mapDailyList(fx, { todayQatar: ctx.todayQatar });
  if (m.rows.length !== 0) return bad('conflicting same-date rows must HOLD, not first-wins');
  if (!m.issues.some(function (i) { return i.reason === 'DUPLICATE_DATE_CONFLICT'; })) return bad('expected DUPLICATE_DATE_CONFLICT');
  var ident = { data: [first, Object.assign({}, first, { uuid: 'other' })] };
  var m2 = mapDailyList(ident, { todayQatar: ctx.todayQatar });
  if (m2.rows.length !== 1) return bad('identical same-date rows may keep one');
  return ok();
};
CONTRACTS['G-ADV-04'] = function (ctx) {
  var st = seedStore({ daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z', steps: { state: 'OBSERVED', value: 1 } }] });
  applyMerge(st.api, { applyActivity: { '90000000001': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, activityPayload: ctx.loadFixture('activities-search-sample.json') });
  if (!parsed(st).daily.some(function (d) { return d.id === 'daily-2026-11-16'; })) return bad('daily id overwritten');
  return ok();
};
CONTRACTS['G-ADV-05'] = function (ctx) {
  if (mapIntensity({ moderate: NaN, vigorous: 1 }).state !== 'UNKNOWN') return bad('NaN');
  if (mapIntensity({ moderate: 1.5, vigorous: 1 }).state !== 'UNKNOWN') return bad('1.5');
  if (mapSteps({ steps: { value: Infinity } }).state === 'OBSERVED') return bad('Infinity');
  return ok();
};
CONTRACTS['G-ADV-06'] = function (ctx) {
  var row = Object.assign({}, ctx.loadFixture('dailysummaries-v2-normal-7d.json').data[0], { calendarDate: '2026-11-24' });
  row.wellnessChronology = { startTimestampGmt: '2026-11-23T21:00:00.0', startTimestampLocal: '2026-11-24T00:00:00.0', endTimestampGmt: '2026-11-24T20:59:00.0', endTimestampLocal: '2026-11-24T23:59:00.0' };
  var m = mapDailyRow(row, { todayQatar: '2026-11-23' });
  if (!m.skip || m.reason !== 'FUTURE_OR_INVALID_DATE') return bad(JSON.stringify(m));
  return ok();
};
CONTRACTS['G-ADV-07'] = function (ctx) {
  var days = inclusiveDays('2026-10-01', '2026-11-23');
  if (days <= 31) return bad('fixture span');
  if (inclusiveDays('2026-10-24', '2026-11-23') !== 31) return bad('31 inclusive');
  if (inclusiveDays('2026-10-23', '2026-11-23') !== 32) return bad('32 should be over cap');
  return ok();
};
CONTRACTS['G-ADV-08'] = function (ctx) {
  var a = mapActivity({ activityId: 1, activityName: '</script>{{constructor}}', startTimeGMT: '2026-11-16 06:00:00', startTimeLocal: '2026-11-16 09:00:00', duration: 1800, activityType: { typeKey: 'running' } });
  if (a.activityName.length > 60) return bad('name not cut');
  var jsdom;
  try { jsdom = require('jsdom'); } catch (e) { jsdom = null; }
  var el;
  if (jsdom && jsdom.JSDOM) {
    el = new jsdom.JSDOM('<!doctype html><div id="p"></div>').window.document.getElementById('p');
  } else {
    // No jsdom in this NODE_PATH. The stub must support setAttribute (tick metadata)
    // and a live innerHTML so the XSS assertion inspects what was actually rendered.
    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function serialize(n) {
      if (!n) return '';
      if (n._rawInnerHTML != null) return n._rawInnerHTML;
      var name = String(n.nodeName || 'div').toLowerCase();
      var attrs = '';
      if (n.attrs) Object.keys(n.attrs).forEach(function (k) {
        attrs += ' ' + k + '="' + String(n.attrs[k]).replace(/"/g, '&quot;') + '"';
      });
      var inner = '';
      if (n.childNodes && n.childNodes.length) inner = n.childNodes.map(serialize).join('');
      else if (n.textContent) inner = escapeHtml(n.textContent);
      if (name === 'input') return '<input' + attrs + '>';
      return '<' + name + attrs + '>' + inner + '</' + name + '>';
    }
    function node(n) {
      var eln = {
        nodeName: n, textContent: '', type: '', checked: false, disabled: false, childNodes: [], attrs: {}, _rawInnerHTML: null,
        setAttribute: function (k, v) { this.attrs[k] = String(v); },
        getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
        appendChild: function (c) { this.childNodes.push(c); this.firstChild = this.childNodes[0]; this._rawInnerHTML = null; return c; }
      };
      Object.defineProperty(eln, 'innerHTML', {
        get: function () { return this._rawInnerHTML != null ? this._rawInnerHTML : (this.childNodes || []).map(serialize).join(''); },
        set: function (v) { this._rawInnerHTML = String(v); this.childNodes = []; this.firstChild = null; }
      });
      return eln;
    }
    el = node('div');
    el.ownerDocument = { createElement: node };
    el.removeChild = function () { this.firstChild = null; this.childNodes = []; this._rawInnerHTML = null; };
  }
  var model = { forceRender: true, items: [{ status: 'New', date: '2026-11-16', collection: 'workouts', activity: a }] };
  var r = renderPreview(el, model);
  if (!r.ok || r.preTicked || r.tickAll) return bad('preview ticks');
  var html = el.innerHTML || '';
  function treeText(n) {
    if (!n) return '';
    var s = n.textContent || '';
    (n.childNodes || []).forEach(function (c) { s += ' ' + treeText(c); });
    return s;
  }
  var text = treeText(el);
  if (text.indexOf('</script>') === -1 && text.indexOf('{{constructor}}') === -1) return bad('payload not shown as text; html=' + html);
  if (/<script[\s>]/i.test(html)) return bad('script injected via innerHTML: ' + html);
  return ok();
};
CONTRACTS['G-ADV-09'] = function (ctx) {
  var fx = ctx.loadFixture('apply-fitbit-row.json');
  var m = mapDailyList(fx, { todayQatar: ctx.todayQatar });
  if (m.rows.length) return bad('fitbit mapped');
  var st = seedStore(existingApp(ctx));
  var before = rawOf(st);
  var r = applyMerge(st.api, { applySteps: { '2026-11-12': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: fx });
  if (r.wrote || rawOf(st) !== before) return bad('fitbit applied');
  var pv = preview({ settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: fx, storeData: existingApp(ctx) });
  if (pv.items.some(function (i) { return i.status === 'Missing'; })) return bad('marked existing Missing');
  return ok();
};
CONTRACTS['G-ADV-10'] = function (ctx) {
  var daily = ctx.loadFixture('dailysummaries-v2-normal-7d.json');
  var badConfirms = [{ applySteps: { '2026-11-16': 'true' } }, { applySteps: { '2026-11-16': 1 } }, { confirmEmptyReplace: { ok: true } }, { acceptAll: true }, { applySteps: { '2026-11-16': true }, confirmEmptyReplace: true }];
  for (var i = 0; i < badConfirms.length; i++) {
    var stI = seedStore({ daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z' }] });
    var b = rawOf(stI);
    var r = applyMerge(stI.api, badConfirms[i], { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: daily });
    if (badConfirms[i].acceptAll || badConfirms[i].confirmEmptyReplace != null) {
      if (r.ok && r.wrote) return bad('accepted malformed ' + i);
    } else if (r.wrote) return bad('string/1 treated as true');
    if (rawOf(stI) !== b && (badConfirms[i].acceptAll || badConfirms[i].confirmEmptyReplace != null)) return bad('mutated ' + i);
  }
  var stG = seedStore({ daily: [{ id: 'daily-2026-11-16', date: '2026-11-16', createdAt: '2026-11-16T05:00:00.000Z' }] });
  var rG = applyMerge(stG.api, { applySteps: { '2026-11-16': true } }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: daily });
  if (!rG.ok || !rG.wrote) return bad('strict true should write');
  return ok();
};
CONTRACTS['G-ADV-11'] = function (ctx) {
  var pv = preview({ settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json'), storeData: existingApp(ctx) });
  if (pv.preTicked || pv.tickAll || pv.acceptAllAllowed || pv.items.some(function (i) { return i.ticked; })) return bad('pre-ticked or tick-all');
  var st = seedStore(existingApp(ctx));
  var r = applyMerge(st.api, { acceptAll: true }, { settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: ctx.loadFixture('dailysummaries-v2-normal-7d.json') });
  if (r.ok && r.wrote) return bad('acceptAll wrote');
  return ok();
};
CONTRACTS['G-ADV-12'] = function (ctx) {
  var fx = ctx.loadFixture('apply-fitbit-row.json');
  var pv = preview({ settings: defaultSettings(), todayQatar: ctx.todayQatar, dailyPayload: fx, storeData: { daily: [{ id: 'daily-2026-11-12', date: '2026-11-12', createdAt: '2026-11-12T00:00:00.000Z', steps: { state: 'OBSERVED', value: 1 } }] } });
  if (pv.items.some(function (i) { return i.status === 'Missing'; })) return bad('existing day marked Missing');
  return ok();
};

function proxyBase(over) {
  var o = {
    allowOfflineHandler: true, garminConfigured: true, ownerCodeAccepted: true,
    origin: 'https://hyrox-phase7-private-test.netlify.app', appOrigin: 'https://hyrox-phase7-private-test.netlify.app',
    op: 'fetch', startDate: '2026-11-16', endDate: '2026-11-16', todayQatar: '2026-11-23',
    nowMs: Date.UTC(2026, 10, 23, 10, 0, 0), logs: [], tokenDailyCap: 6, tokenExchangeCount: { n: 0 },
    dataset: 'daily'
  };
  Object.keys(over || {}).forEach(function (k) { o[k] = over[k]; });
  return o;
}
function mockFetch(settings, daily) {
  return function (url, init) {
    if (!init || init.redirect !== 'manual') return { status: 500, body: { err: 'redirect' } };
    if (/personal-api-key\/token/.test(url)) return { status: 200, bodyText: fakeJwt(Date.UTC(2026, 10, 23, 10, 0, 0) / 1000 + 12 * 3600) };
    if (/userprofile\/settings/.test(url)) return { status: 200, body: settings || defaultSettings() };
    if (/connectapi\.garmin\.com/.test(url) === false) return { status: 500, body: { err: 'host' } };
    return { status: 200, body: daily || { data: [] } };
  };
}
CONTRACTS['G-PROXY-allowlist'] = function (ctx) {
  resetProxyState();
  var hosts = [];
  var res = handleProxy(proxyBase({
    fetch: function (url, init) {
      hosts.push(url);
      return mockFetch()(url, init);
    }
  }));
  if (!res.body || !res.body.ok) return bad(JSON.stringify(res.body));
  if (hosts.some(function (u) { return u.indexOf('personal.connectapi.garmin.com') === -1; })) return bad('non-hardcoded host');
  if (hosts.filter(function (u) { return /userprofile\/settings/.test(u); }).length !== 1) return bad('settings not called once');
  resetProxyState();
  var badDs = handleProxy(proxyBase({ dataset: 'calories', fetch: mockFetch() }));
  if (badDs.status !== 400) return bad('calories dataset allowed');
  return ok();
};
CONTRACTS['G-PROXY-31-days'] = function (ctx) {
  resetProxyState();
  var ok31 = handleProxy(proxyBase({ startDate: '2026-10-24', endDate: '2026-11-23', fetch: mockFetch() }));
  if (ok31.status !== 200 || ok31.body.range.inclusiveDays !== 31) return bad('31 should pass ' + JSON.stringify(ok31.body));
  resetProxyState();
  var over = handleProxy(proxyBase({ startDate: '2026-10-23', endDate: '2026-11-23', fetch: mockFetch() }));
  if (over.status !== 400 || String(over.body.message).indexOf('31') === -1) return bad('32 not refused');
  var future = handleProxy(proxyBase({ startDate: '2026-11-20', endDate: '2026-11-24', fetch: mockFetch() }));
  if (future.status !== 400) return bad('end > today');
  var impossible = handleProxy(proxyBase({ startDate: '2026-02-31', endDate: '2026-03-01', fetch: mockFetch() }));
  if (impossible.status !== 400) return bad('31 Feb');
  if (ok31.body.tokenCached != null) return bad('tokenCached leaked');
  return ok();
};
CONTRACTS['G-PROXY-redirect-manual'] = function (ctx) {
  resetProxyState();
  var res = handleProxy(proxyBase({
    fetch: function (url, init) {
      if (init.redirect !== 'manual') return { status: 200, body: {} };
      if (/token/.test(url)) return { status: 302, headers: { location: 'https://evil.example/' } };
      return { status: 200, body: defaultSettings() };
    }
  }));
  if (res.status !== 502 || res.body.code !== 'UPSTREAM_REDIRECT') return bad(JSON.stringify(res));
  return ok();
};
CONTRACTS['G-PROXY-origin-null'] = function (ctx) {
  resetProxyState();
  var a = handleProxy(proxyBase({ origin: 'null', fetch: mockFetch() }));
  var b = handleProxy(proxyBase({ origin: null, fetch: mockFetch() }));
  var c = handleProxy(proxyBase({ origin: 'https://evil.example', fetch: mockFetch() }));
  if (a.status !== 403 || b.status !== 403 || c.status !== 403) return bad('origin gate');
  return ok();
};
CONTRACTS['G-PROXY-status-oracle'] = function (ctx) {
  var a = handleProxy(proxyBase({ op: 'status', ownerCodeAccepted: false, garminConfigured: true, fetch: mockFetch() }));
  var b = handleProxy(proxyBase({ op: 'status', ownerCodeAccepted: false, garminConfigured: false, fetch: mockFetch() }));
  if (a.bodyText !== b.bodyText || a.bodyText !== UNAUTH_BODY) return bad('oracle ' + a.bodyText + ' vs ' + b.bodyText);
  var c = handleProxy(proxyBase({ op: 'status', ownerCodeAccepted: true, garminConfigured: true, allowOfflineHandler: true, fetch: mockFetch() }));
  if (!c.body || c.body.configured !== true) return bad('authed status should reveal configured');
  return ok();
};
CONTRACTS['G-PROXY-mapped-only'] = function (ctx) {
  resetProxyState();
  var canaryKey = 'CANARY_KEY_VALUE_9f3c', canaryToken = 'CANARY_TOKEN_VALUE_aa21', canaryHealth = 'CANARY_HEALTH_SECRET';
  var logs = [];
  var res = handleProxy(proxyBase({
    logs: logs, canaryKey: canaryKey, canaryToken: canaryToken, canaryHealth: canaryHealth,
    fetch: function (url, init) {
      if (/token/.test(url)) return { status: 200, bodyText: fakeJwt(Date.UTC(2026, 10, 23, 10, 0, 0) / 1000 + 12 * 3600) };
      if (/settings/.test(url)) return { status: 200, body: defaultSettings() };
      return { status: 200, body: { data: [Object.assign({}, ctx.loadFixture('dailysummaries-v2-normal-7d.json').data[0], { userProfilePk: 999, canary: canaryHealth })] } };
    }
  }));
  var blob = JSON.stringify(res.body) + JSON.stringify(logs);
  if (blob.indexOf(canaryKey) !== -1 || blob.indexOf(canaryToken) !== -1 || blob.indexOf(canaryHealth) !== -1) return bad('canary leaked');
  if (blob.indexOf('userProfilePk') !== -1) return bad('userProfilePk leaked');
  return ok();
};
CONTRACTS['G-PROXY-lease-token'] = function (ctx) {
  resetProxyState();
  IN_FLIGHT.until = Date.UTC(2026, 10, 23, 10, 0, 30);
  var res = handleProxy(proxyBase({ nowMs: Date.UTC(2026, 10, 23, 10, 0, 0), fetch: mockFetch() }));
  if (res.status !== 409) return bad('expected 409 in-flight');
  resetProxyState();
  var n = { n: 0 };
  handleProxy(proxyBase({ tokenExchangeCount: n, fetch: mockFetch() }));
  if (n.n !== 1) return bad('first exchange');
  var n2 = { n: n.n };
  handleProxy(proxyBase({ tokenExchangeCount: n2, fetch: mockFetch() }));
  if (n2.n !== n.n) return bad('token cache not used');
  if (TOKEN_CACHE.jwt == null) return bad('expected in-memory token after success');
  return ok();
};

function runContract(id, ctx) {
  ctx = ctx || {};
  if (!CONTRACTS[id]) return bad('UNKNOWN_CONTRACT ' + id);
  try { return CONTRACTS[id](ctx); } catch (e) { return bad('EXCEPTION ' + (e && e.stack || e)); }
}


module.exports = {
  runContract: runContract,
  handleProxy: handleProxy,
  resetProxyState: resetProxyState,
  CONTRACTS: CONTRACTS
};
