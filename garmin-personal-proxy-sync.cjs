// Synchronous Garmin Personal API proxy core (unit + shared by the async ESM wrapper).
// Lives under netlify/lib so the deploy package can import it. No live key, no network.
'use strict';
const fs = require('fs');
const path = require('path');
function resolveGarminImport() {
  const cands = [
    path.join(__dirname, '../../src/integrations/garmin-import.js'),
    path.join(__dirname, '../../publish/src/integrations/garmin-import.js')
  ];
  for (const pth of cands) {
    if (!fs.existsSync(pth)) continue;
    const mod = require(pth);
    const api = (mod && typeof mod.todayQatarFromNow === 'function') ? mod
      : (mod && mod.default && typeof mod.default.todayQatarFromNow === 'function') ? mod.default
      : (typeof globalThis !== 'undefined' && globalThis.HyroxGarminImport) ? globalThis.HyroxGarminImport
      : null;
    if (api && typeof api.todayQatarFromNow === 'function') return api;
  }
  throw new Error('garmin-import.js not found or did not export todayQatarFromNow (source or publish/)');
}
const G = resolveGarminImport();

const evaluateTimezone = G.evaluateTimezone;
const inclusiveDays = G.inclusiveDays;
const isIsoDate = G.isIsoDate;
const mapDailyList = G.mapDailyList;
const mapWeightRange = G.mapWeightRange;
const mapActivityList = G.mapActivityList;
const mapSleep = G.mapSleep;
const FEATURE_GARMIN_IMPORT = G.FEATURE_GARMIN_IMPORT;

const HOST = 'https://personal.connectapi.garmin.com';
const DATASETS = ['daily', 'sleep', 'hrv', 'vo2max', 'activities'];
const UNAUTH_BODY = '{"ok":false,"code":"AUTH"}';
var TOKEN_CACHE = { jwt: null, exp: 0 };
var IN_FLIGHT = { until: 0, holder: null };

function parseJwtExp(tok) {
  if (typeof tok !== 'string') return null;
  var parts = tok.split('.');
  if (parts.length !== 3) return null;
  try {
    var json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    var p = JSON.parse(json);
    if (!p || typeof p.exp !== 'number' || !Number.isInteger(p.exp)) return null;
    return p.exp;
  } catch (e) { return null; }
}

function datasetPath(ds) {
  var map = {
    daily: '/usersummary-service/v2/dailysummaries',
    sleep: '/wellness-service/wellness/dailySleep',
    hrv: '/hrv-service/hrv/daily',
    vo2max: '/userprofile-service/userprofile/vo2max',
    activities: '/activitylist-service/activities/search/activities',
    settings: '/userprofile-service/userprofile/settings'
  };
  return map[ds] || null;
}

function handleProxy(opts) {
  opts = opts || {};
  var logs = opts.logs || [];
  var nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  var origin = opts.origin;
  var expectedOrigin = opts.appOrigin || 'https://hyrox-phase7-private-test.netlify.app';
  function log(entry) { logs.push(entry); }
  function canaryLeak(obj) {
    var s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    var canaries = [].concat(opts.canaryKey || [], opts.canaryToken || [], opts.canaryHealth || []);
    return canaries.some(function (c) { return c && s.indexOf(String(c)) !== -1; });
  }

  if (origin == null || origin === 'null' || origin === '') {
    return { status: 403, body: { ok: false, code: 'NOT_AUTHORIZED' }, logs: logs };
  }
  if (origin !== expectedOrigin) return { status: 403, body: { ok: false, code: 'NOT_AUTHORIZED' }, logs: logs };

  var locked = opts.lockState && opts.lockState.locked;
  if (locked) return { status: 429, body: { ok: false, code: 'RATE_LIMITED' }, bodyText: '{"ok":false,"code":"RATE_LIMITED"}', logs: logs };

  var isStatus = opts.op === 'status';
  var codeOk = opts.ownerCodeAccepted === true;
  if (!codeOk) {
    return { status: 401, bodyText: UNAUTH_BODY, body: JSON.parse(UNAUTH_BODY), logs: logs };
  }

  if (!FEATURE_GARMIN_IMPORT && !opts.allowOfflineHandler) {
    return { status: 503, body: { ok: false, code: 'NOT_ACTIVATED' }, logs: logs };
  }

  var configured = !!opts.garminConfigured;
  if (isStatus) {
    return { status: 200, body: { ok: true, configured: configured, halt: opts.halt || null }, logs: logs };
  }
  if (!configured) return { status: 503, body: { ok: false, code: 'NOT_CONFIGURED' }, logs: logs };
  if (opts.halt) return { status: 503, body: { ok: false, code: 'GARMIN_BLOCKED' }, logs: logs };

  if (IN_FLIGHT.until > nowMs) return { status: 409, body: { ok: false, code: 'IN_FLIGHT' }, logs: logs };

  var start = opts.startDate, end = opts.endDate, today = opts.todayQatar;
  if (!isIsoDate(start) || !isIsoDate(end) || !isIsoDate(today) || start > end || end > today) {
    return { status: 400, body: { ok: false, code: 'RANGE', message: 'Choose up to 31 inclusive days, ending no later than today (Asia/Qatar).' }, logs: logs };
  }
  var days = inclusiveDays(start, end);
  if (days == null || days > 31) {
    return { status: 400, body: { ok: false, code: 'RANGE', message: 'Choose up to 31 inclusive days, ending no later than today (Asia/Qatar).' }, logs: logs };
  }
  var ds = opts.dataset;
  if (ds && DATASETS.indexOf(ds) === -1 && ds !== 'settings') {
    return { status: 400, body: { ok: false, code: 'DATASET' }, logs: logs };
  }

  var fetchFn = opts.fetch;
  if (typeof fetchFn !== 'function') return { status: 503, body: { ok: false, code: 'NO_INJECTED_FETCH' }, logs: logs };

  IN_FLIGHT.until = nowMs + 60000;
  try {
    var exp = TOKEN_CACHE.exp, jwt = TOKEN_CACHE.jwt;
    if (!jwt || !(nowMs / 1000 + 3600 < exp && exp <= nowMs / 1000 + 24 * 3600 + 300)) {
      if (opts.tokenExchangeCount != null) opts.tokenExchangeCount.n = (opts.tokenExchangeCount.n || 0) + 1;
      if (opts.tokenDailyCap && opts.tokenExchangeCount && opts.tokenExchangeCount.n > opts.tokenDailyCap) {
        return { status: 429, body: { ok: false, code: 'TOKEN_CAP' }, logs: logs };
      }
      var tokRes = fetchFn(HOST + '/personalapitoken-service/personal-api/personal-api-key/token', {
        method: 'POST', headers: { Authorization: 'ApiKey [redacted]', Accept: '*/*' }, redirect: 'manual'
      });
      if (tokRes && typeof tokRes.then === 'function') throw new Error('async-not-supported-in-unit-proxy');
      if (tokRes && tokRes.status >= 300 && tokRes.status < 400) return { status: 502, body: { ok: false, code: 'UPSTREAM_REDIRECT' }, logs: logs };
      if (tokRes && (tokRes.status === 401 || tokRes.status === 403 || tokRes.status === 429)) {
        opts.halt = { reason: 'token' };
        return { status: 503, body: { ok: false, code: 'GARMIN_BLOCKED' }, logs: logs };
      }
      var tokBody = tokRes && (tokRes.bodyText || tokRes.body);
      var token = typeof tokBody === 'string' ? tokBody : (tokBody && tokBody.token) || tokBody;
      var ex = parseJwtExp(token);
      if (ex == null || !(nowMs / 1000 + 3600 < ex && ex <= nowMs / 1000 + 24 * 3600 + 300)) {
        opts.halt = { reason: 'bad_exp' };
        return { status: 502, body: { ok: false, code: 'BAD_TOKEN' }, logs: logs };
      }
      TOKEN_CACHE.jwt = token; TOKEN_CACHE.exp = ex;
    }

    var setRes = fetchFn(HOST + datasetPath('settings'), { method: 'GET', headers: { Authorization: 'Bearer [redacted]', Accept: 'application/json' }, redirect: 'manual' });
    if (setRes && setRes.status >= 300 && setRes.status < 400) return { status: 502, body: { ok: false, code: 'UPSTREAM_REDIRECT' }, logs: logs };
    if (!setRes || setRes.status >= 400) return { status: 502, body: { ok: false, code: 'SETTINGS_LOOKUP_FAILED' }, logs: logs };
    var settings = setRes.body || setRes.json;
    var tz = evaluateTimezone(settings);
    if (!tz.accepted) return { status: 200, body: { ok: false, hold: true, reason: tz.reason, timezone: tz }, logs: logs };

    var want = ds ? [ds] : DATASETS.slice();
    var mapped = { timezone: tz, complete: {}, rows: {}, skipped: [] };
    want.forEach(function (name) {
      var url = HOST + datasetPath(name) + '?startDate=' + start + '&endDate=' + end;
      if (name === 'weight') url += '&includeAll=true';
      var res = fetchFn(url, { method: 'GET', headers: { Authorization: 'Bearer [redacted]', Accept: 'application/json' }, redirect: 'manual' });
      log({ reqId: opts.reqId || 'r', dataset: name, days: days, outcome: res && res.status < 400 ? 'ok' : 'error', statusClass: res && String(res.status)[0] + 'xx', ms: 0 });
      if (res && res.status >= 300 && res.status < 400) { mapped.skipped.push({ dataset: name, reason: 'REDIRECT' }); return; }
      if (!res || res.status >= 400) { mapped.complete[name] = false; mapped.skipped.push({ dataset: name, reason: 'UPSTREAM' }); return; }
      var body = res.body || res.json || {};
      if (name === 'daily') {
        var d = mapDailyList(body, { todayQatar: today });
        mapped.rows.daily = d.rows.map(function (r) {
          return { calendarDate: r.calendarDate, steps: r.steps.zeroAsMissing ? 0 : (r.steps.state === 'OBSERVED' ? r.steps.value : null), intensity: !r.steps.zeroAsMissing && r.intensity.state === 'OBSERVED' ? { moderate: r.intensity.moderate, vigorous: r.intensity.vigorous, value: r.intensity.value } : null, inProgress: r.inProgress };
        });
        // Claude QA F2 / t119u: forward held dates and reasons so the preview can show HOLD, not "no days".
        mapped.held = (mapped.held || []).concat((d.issues || []).filter(function (i) {
          return i && (i.reason === 'INCOMPLETE_DAY' || i.reason === 'DUPLICATE_DATE_CONFLICT') && i.calendarDate;
        }).map(function (i) { return { calendarDate: i.calendarDate, reason: i.reason }; }));
        mapped.complete.daily = true;
      } else if (name === 'activities') {
        var a = mapActivityList(body);
        mapped.rows.activities = a.activities.filter(function (x) { return !x.skip; }).map(function (x) {
          return { activityId: x.activityId, activityName: x.activityName, date: x.date, durationMin: x.durationMin, distanceM: x.distanceM, averageHR: x.averageHR, maxHR: x.maxHR, crossesMidnight: x.crossesMidnight };
        });
        mapped.complete.activities = a.complete;
      } else if (name === 'sleep') {
        var sl = Array.isArray(body) ? body.map(mapSleep) : [mapSleep(body)];
        mapped.rows.sleep = sl.filter(function (x) { return !x.skip; }).map(function (x) { return { wakeDate: x.wakeDate, sleepH: x.sleepH }; });
        mapped.complete.sleep = true;
      } else {
        mapped.rows[name] = 'display-only';
        mapped.complete[name] = true;
      }
    });
    if (canaryLeak(mapped) || logs.some(function (l) { return canaryLeak(l); })) {
      return { status: 500, body: { ok: false, code: 'CANARY' }, logs: logs };
    }
    return { status: 200, body: { ok: true, provider: 'garmin-personal-api', range: { startDate: start, endDate: end, inclusiveDays: days }, timezone: tz, complete: mapped.complete, rows: mapped.rows, held: mapped.held || [], skipped: mapped.skipped }, logs: logs };
  } finally {
    IN_FLIGHT.until = 0;
  }
}

function resetProxyState() { TOKEN_CACHE.jwt = null; TOKEN_CACHE.exp = 0; IN_FLIGHT.until = 0; }


module.exports = { handleProxy, resetProxyState, HOST, DATASETS, IN_FLIGHT, TOKEN_CACHE };
