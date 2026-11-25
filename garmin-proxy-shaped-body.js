'use strict';
// Test helper: produce a Fetch body in the exact shape handleProxy returns.
// Used by unit tests and the Chrome e2e stub so the client is exercised against
// the proxy contract, not a hand-written raw payload. No live network.
const path = require('node:path');
const { handleProxy, resetProxyState } = require(path.join(__dirname, '..', 'netlify', 'lib', 'garmin-personal-proxy-sync.cjs'));

function fakeJwt(exp) {
  function b64(o) {
    return Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }
  return b64({ alg: 'none' }) + '.' + b64({ exp: exp }) + '.x';
}

const DEFAULT_WEIGHT_TS = Date.parse('2026-11-22T06:00:00.000Z');
const DEFAULT_DAILY_DOC = {
  data: [{
    calendarDate: '2026-11-22',
    source: 'garmin',
    uuid: 'syn-uuid-22',
    includesWellnessData: true,
    movement: { steps: { value: 8421, goal: 10000 } },
    intensityMinutes: { moderate: 20, vigorous: 8 },
    wellnessChronology: {
      startTimestampGmt: '2026-11-21T21:00:00.0',
      startTimestampLocal: '2026-11-22T00:00:00.0',
      endTimestampGmt: '2026-11-22T20:59:00.0',
      endTimestampLocal: '2026-11-22T23:59:00.0',
      totalDurationInMillis: 86340000
    }
  }]
};
const DEFAULT_WEIGHT_DOC = {
  dailyWeightSummaries: [{
    allWeightMetrics: [{ weight: 97.4, timestampGMT: DEFAULT_WEIGHT_TS, calendarDate: '2026-11-22' }]
  }]
};

function makeProxyFetchBody(opts) {
  opts = opts || {};
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.UTC(2026, 10, 24, 6, 0, 0);
  const todayQatar = opts.todayQatar || '2026-11-24';
  const startDate = opts.startDate || '2026-11-22';
  const endDate = opts.endDate || '2026-11-24';
  const origin = opts.origin || 'https://hyrox-phase7-private-test.netlify.app';
  const weightDoc = opts.weightDoc === undefined ? DEFAULT_WEIGHT_DOC : opts.weightDoc;
  const dailyDoc = opts.dailyDoc === undefined ? { data: [] } : opts.dailyDoc;
  const sleepDoc = opts.sleepDoc === undefined ? {} : opts.sleepDoc;
  const activityDoc = opts.activityDoc === undefined ? [] : opts.activityDoc;
  const dataset = opts.dataset; // undefined = all datasets the proxy would fetch
  resetProxyState();
  const res = handleProxy({
    allowOfflineHandler: true,
    garminConfigured: true,
    ownerCodeAccepted: true,
    origin,
    appOrigin: origin,
    op: 'fetch',
    dataset,
    startDate,
    endDate,
    todayQatar,
    nowMs,
    logs: [],
    tokenDailyCap: 6,
    tokenExchangeCount: { n: 0 },
    fetch: function (url, init) {
      if (!init || init.redirect !== 'manual') return { status: 500, body: { err: 'redirect' } };
      if (/personal-api-key\/token/.test(url)) {
        return { status: 200, bodyText: fakeJwt(nowMs / 1000 + 12 * 3600) };
      }
      if (/userprofile\/settings/.test(url)) {
        return { status: 200, body: opts.settings || { timeZone: 'Asia/Qatar', preferredLocale: 'en' } };
      }
      if (/weight\/dateRange/.test(url)) return { status: 200, body: weightDoc || { dailyWeightSummaries: [] } };
      if (/dailysummaries/.test(url)) return { status: 200, body: dailyDoc };
      if (/dailySleep/.test(url)) return { status: 200, body: sleepDoc };
      if (/activities\/search/.test(url)) return { status: 200, body: activityDoc };
      return { status: 200, body: { data: [] } };
    }
  });
  resetProxyState();
  if (!res || !res.body) throw new Error('handleProxy produced no body');
  return res.body;
}

module.exports = {
  makeProxyFetchBody,
  fakeJwt,
  DEFAULT_DAILY_DOC,
  DEFAULT_WEIGHT_TS,
  DEFAULT_WEIGHT_DOC
};
