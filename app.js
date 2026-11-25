/*
 * HYROX Tracker UI (classic script, no modules, works from file://).
 * Depends on window.HyroxData from src/data/hyrox-data.js.
 */
/*
 * Restore (import) logic: pure functions, no DOM. Exposed as
 * window.HyroxImportUI so the flow can be unit-tested without a browser.
 * Contract: dawit-import-blueprint.md §3, §8, §9 (REPLACE only, no Undo in P0).
 */
var HyroxImportUI = (function () {
  'use strict';

  var LISTS = ['weight', 'workouts', 'nutrition'];
  var BLOCKED_STATES = { unavailable: 1, unreadable: 1, newer: 1 };

  // Calls target[name](...args) and never throws. Returns
  //   {ok:true, value}  or  {ok:false, code:'ui_missing'|'ui_exception', message}
  function safeCall(target, name, args) {
    var fn;
    try { fn = target ? target[name] : undefined; } catch (e) { fn = undefined; }
    if (typeof fn !== 'function') {
      return { ok: false, code: 'ui_missing', message: 'This feature is not available in this version of the app.' };
    }
    try {
      return { ok: true, value: fn.apply(target, args || []) };
    } catch (e) {
      return { ok: false, code: 'ui_exception', message: 'Unexpected error: ' + (e && e.message ? e.message : String(e)) };
    }
  }

  // Delivers a safeCall result to cb as a plain result object. If the contract
  // function returns a Promise, waits for it (the caller stays "busy").
  function settle(call, cb) {
    if (!call || !call.ok) { cb(call); return; }
    var v = call.value;
    if (v && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function') {
      var done = false;
      try {
        v.then(function (r) { if (!done) { done = true; cb(r); } },
          function (e) {
            if (!done) { done = true; cb({ ok: false, code: 'ui_exception', message: 'Unexpected error: ' + (e && e.message ? e.message : String(e)) }); }
          });
      } catch (e) {
        if (!done) { done = true; cb({ ok: false, code: 'ui_exception', message: 'Unexpected error: ' + (e && e.message ? e.message : String(e)) }); }
      }
      return;
    }
    cb(v);
  }

  function isCount(n) { return typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n; }

  function isCounts(c) {
    return !!c && typeof c === 'object' && isCount(c.weight) && isCount(c.workouts) && isCount(c.nutrition);
  }

  function totalOf(c) { return isCounts(c) ? c.weight + c.workouts + c.nutrition : 0; }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function fmtCounts(c) {
    if (!isCounts(c)) return 'no readable data';
    return plural(c.weight, 'weight', 'weight') + ' · ' +
      plural(c.workouts, 'workout', 'workouts') + ' · ' +
      plural(c.nutrition, 'nutrition entry', 'nutrition entries');
  }

  // ISO timestamp -> "10 Nov 2026, 23:48 (Qatar)"; falls back to the raw text.
  function fmtStamp(iso) {
    if (typeof iso !== 'string' || !iso) return 'an unknown time';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    try {
      return d.toLocaleString('en-GB', {
        timeZone: 'Asia/Qatar', day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
      }) + ' (Qatar)';
    } catch (e) { return iso; }
  }

  function limitsOf(HD) {
    var l = HD && HD.IMPORT_LIMITS;
    if (!l || typeof l !== 'object') return null;
    return {
      maxBytes: typeof l.maxBytes === 'number' && l.maxBytes > 0 ? l.maxBytes : null,
      maxPerList: typeof l.maxPerList === 'number' && l.maxPerList > 0 ? l.maxPerList : null
    };
  }

  // UI pre-check before reading: size only. Never the name, extension or MIME type.
  function sizeCheck(size, limits) {
    if (typeof size !== 'number' || size === 0) return { ok: false, code: 'empty_file' };
    if (limits && limits.maxBytes && size > limits.maxBytes) return { ok: false, code: 'too_large', maxBytes: limits.maxBytes };
    return { ok: true };
  }

  function mb(bytes) { return (Math.round(bytes / 100000) / 10) + ' MB'; }

  // Short, plain message per code (contract §3 codes + UI-only codes).
  var MESSAGES = {
    // UI-only
    empty_file: 'This file is empty.',
    read_failed: 'This file could not be read. Try choosing it again.',
    ui_missing: 'Restore is not available in this version of the app.',
    ui_exception: 'Something went wrong in the app.',
    bad_result: 'The app got an unexpected answer and stopped to keep your data safe.',
    busy: 'Please wait, the app is still working.',
    // validation (preview and apply)
    too_large: 'This file is too big to be a HYROX backup.',
    not_json: 'This file is not a readable backup (it is not valid JSON).',
    not_hyrox: 'This file is not a HYROX Tracker backup.',
    raw_recovery_file: 'This is an emergency raw recovery file, not a normal backup, so it cannot be restored here. Keep it safe; nothing was changed.',
    unsupported_version: 'This backup is from a version of the app that is not supported.',
    too_many: 'This backup has more entries than the app can restore.',
    invalid_records: 'Some entries in this backup are not valid, so the whole file was rejected.',
    duplicate_ids: 'This backup contains duplicate entries, so the whole file was rejected.',
    // storage state
    storage_unavailable: 'Storage is unavailable in this browser (private browsing or blocked site data).',
    storage_unreadable: 'Your saved data could not be read. Reload the page and try again.',
    storage_newer: 'Your saved data is from a newer version of this app, so it will not be replaced.',
    // apply
    backup_failed: 'A safety copy of your current data could not be saved, so nothing was restored.',
    write_failed: 'The backup could not be saved on this device.',
    verify_failed: 'The restored data did not check out after saving.',
    rollback_failed: 'The restore failed and your previous data could not be put back automatically.',
    not_confirmed: 'The restore was not confirmed.',
    stale_plan: 'Your data changed since the preview. Choose the file again.',
    // P5 (CONTRACT.md): fallbacks only; the data layer's own message is shown when it gives one.
    empty_replace_not_confirmed: 'This backup is empty and would remove the entries on this device, but the second confirmation was not given.',
    prior_copy_unresolved: 'A previous restore did not finish. Its safety copy is the only copy of your earlier data, so this restore was refused to protect it.'
  };

  // Codes returned before anything is written, per contract §4.
  var NOTHING_WRITTEN = {
    empty_file: 1, read_failed: 1, ui_missing: 1, busy: 1,
    too_large: 1, not_json: 1, not_hyrox: 1, raw_recovery_file: 1, unsupported_version: 1, too_many: 1,
    invalid_records: 1, duplicate_ids: 1, storage_unavailable: 1, storage_unreadable: 1,
    storage_newer: 1, backup_failed: 1, not_confirmed: 1, stale_plan: 1,
    empty_replace_not_confirmed: 1, prior_copy_unresolved: 1
  };

  // P4-F02 recovery advice shown under the data layer's refusal message.
  var PRIOR_COPY_HELP = 'Nothing was changed. To keep that earlier data, use "Download emergency raw copy" in Backup above: it contains the safety copy exactly as saved. Do not clear site data for this page.';

  function messageFor(code, extra) {
    var m = MESSAGES[code] || 'Something went wrong.';
    if (code === 'too_large' && extra && extra.maxBytes) m += ' The limit is ' + mb(extra.maxBytes) + '.';
    return m;
  }

  function listLabel(list) {
    return list === 'weight' ? 'Weight' : list === 'workouts' ? 'Workouts' : list === 'nutrition' ? 'Nutrition' : String(list || 'Entry');
  }

  // errors[] item {list,index,field,message} -> "Workouts entry 3 · durationMin: ..."
  // index is assumed 0-based in the contract and shown 1-based.
  function fmtRecordError(e) {
    if (!e || typeof e !== 'object') return String(e);
    var where = listLabel(e.list);
    if (typeof e.index === 'number' && isFinite(e.index)) where += ' entry ' + (e.index + 1);
    if (e.field) where += ' · ' + String(e.field);
    return where + ': ' + String(e.message == null ? 'invalid' : e.message);
  }

  var DETAILS_MAX = 20;
  function txt(v) { return v === null || v === undefined ? '' : String(v); }
  function normDetails(res) {
    if (!res || !Array.isArray(res.details) || !res.details.length) return null;
    var list = res.details.slice(0, DETAILS_MAX).filter(function (d) { return d && typeof d === 'object'; }).map(function (d) {
      return { collection: txt(d.collection) || 'entry', index: typeof d.index === 'number' && isFinite(d.index) ? d.index : null,
        id: d.id === null || d.id === undefined ? null : txt(d.id), date: d.date === null || d.date === undefined ? null : txt(d.date),
        field: txt(d.field), hasValue: 'value' in d, value: d.value, valueType: txt(d.valueType), valueTruncated: d.valueTruncated === true,
        valueLength: typeof d.valueLength === 'number' ? d.valueLength : null, rule: txt(d.rule), code: txt(d.code), message: txt(d.message), howToCorrect: txt(d.howToCorrect) };
    });
    return list.length ? list : null;
  }
  function trimText(s, max) {
    s = String(s);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  // Data-layer messages start with "Not restored: ..."; the status line already says that.
  function cleanMessage(m) {
    if (typeof m !== 'string') return '';
    m = m.trim().replace(/^not (restored|saved)\s*[:.,\u2013\u2014-]\s*/i, '');
    return m ? m.charAt(0).toUpperCase() + m.slice(1) : '';
  }

  var STORAGE_CODES = { storage_unavailable: 1, storage_unreadable: 1, storage_newer: 1 };
  var UI_CODES = { empty_file: 1, read_failed: 1, ui_missing: 1, ui_exception: 1, bad_result: 1, busy: 1 };

  // Normalises any failure (preview, apply, UI) into what the UI shows:
  //   status   short line for #import-status ("Not restored. ...")
  //   headline the reason (#import-error-message): the data layer's plain message,
  //            or the UI's own message for UI codes / missing messages
  //   detail   extra advice (#import-error-detail), e.g. rollback_failed key
  // phase: 'preview' | 'apply'
  function describeFailure(res, phase, extra) {
    res = res && typeof res === 'object' ? res : {};
    var code = typeof res.code === 'string' && res.code ? res.code : 'bad_result';
    var own = messageFor(code, extra);
    var theirs = UI_CODES[code] || code === 'not_confirmed' || code === 'rollback_failed' ? '' : cleanMessage(res.message);
    var out = {
      code: code,
      // P5: refusals that explain how to recover are shown in full (CONTRACT.md §1/§2 messages).
      headline: trimText(theirs || own, code === 'prior_copy_unresolved' || code === 'empty_replace_not_confirmed' ? 1000 : 240),
      detail: null,
      errors: [],
      moreErrors: 0,
      unchanged: false,
      backupKey: null,
      urgent: false,
      status: null
    };
    // t54u: per-record refusal details (invalid_records / duplicate_ids). Shown instead of the short
    // errors list when present; the errors list stays the fallback when details are missing or malformed.
    out.details = normDetails(res);
    if (out.details) {
      out.detailsTotal = typeof res.detailsTotal === 'number' && isFinite(res.detailsTotal) && res.detailsTotal >= out.details.length ? res.detailsTotal : out.details.length;
      out.detailsTruncated = res.detailsTruncated === true || out.detailsTotal > out.details.length;
    } else if (Array.isArray(res.errors)) {
      out.errors = res.errors.slice(0, 3).map(fmtRecordError).map(function (s) { return trimText(s, 160); });
      out.moreErrors = Math.max(0, res.errors.length - 3);
    }
    if (phase === 'apply') {
      if (code === 'rollback_failed') {
        out.urgent = true;
        out.backupKey = typeof res.backupKey === 'string' && res.backupKey ? res.backupKey : null;
        out.detail = (out.backupKey
          ? 'Your previous data is saved in this browser under "' + out.backupKey + '". '
          : 'Your previous data may still be saved in this browser. ') +
          'Do not clear site data for this page. Reload and check your data.';
      } else if (res.rolledBack === true || NOTHING_WRITTEN[code]) {
        out.unchanged = true;
        if (code === 'prior_copy_unresolved') { out.urgent = true; out.detail = PRIOR_COPY_HELP; }
      } else {
        // Unknown outcome (e.g. exception, or write/verify failure without rolledBack:true).
        out.detail = (out.detail ? out.detail + ' ' : '') + 'Reload the page and check your data before trying again.';
      }
    } else {
      out.unchanged = true; // preview never writes (§3)
    }
    if (phase === 'preview') {
      out.status = STORAGE_CODES[code] ? 'Not restored. Restore cannot run right now; your data on this device was not changed.'
        : UI_CODES[code] && code !== 'empty_file' && code !== 'read_failed' ? 'Not restored. Your data on this device was not changed.'
          : 'Not restored. This file was rejected; your data on this device was not changed.';
    } else {
      out.status = out.unchanged ? 'Not restored. Your data on this device was not changed.' : 'Not restored.';
    }
    return out;
  }

  // status().state -> the matching storage code (for a pick made while storage went bad)
  function stateCode(state) {
    return state === 'unreadable' ? 'storage_unreadable' : state === 'newer' ? 'storage_newer'
      : state === 'unavailable' ? 'storage_unavailable' : 'ui_missing';
  }

  // Restore availability from a safeCall(store,'status') result.
  function availability(statusCall, store) {
    var reason = null;
    var s = statusCall && statusCall.ok ? statusCall.value : null;
    if (!s || typeof s !== 'object') {
      reason = 'Restore is unavailable because the app could not check your storage. Reload the page.';
    } else if (!s.persistent || s.state === 'unavailable') {
      reason = 'Restore is unavailable: storage is blocked in this browser (private browsing or blocked site data).';
    } else if (s.state === 'unreadable') {
      reason = 'Restore is paused: your saved data could not be read. Reload the page to try again.';
    } else if (s.state === 'newer') {
      reason = 'Restore is paused: your saved data is from a newer version of this app and will not be replaced.';
    } else if (!store || typeof store.previewImport !== 'function' || typeof store.applyImport !== 'function') {
      reason = 'Restore is not available in this version of the app.';
    }
    var ib = s && s.importBackup && typeof s.importBackup === 'object' ? s.importBackup : null;
    return {
      enabled: reason === null,
      reason: reason,
      state: s ? s.state : null,
      corrupt: !!s && s.state === 'corrupt',
      importBackup: ib,
      // CONTRACT.md §2 (final): top-level status().priorCopy, absent when there is no slot.
      priorCopy: s && s.priorCopy && typeof s.priorCopy === 'object' ? s.priorCopy : null
    };
  }

  function hasStamp(ib) { return !!ib && typeof ib.savedAt === 'string' && ib.savedAt !== ''; }

  // "(saved 10 Nov 2026, 23:30 (Qatar): 2 weight · ...)" or null when the slot's details can't be read.
  function slotDetails(ib) {
    if (!ib) return null;
    if (!hasStamp(ib) && !isCounts(ib.counts)) return null;
    return (hasStamp(ib) ? 'saved ' + fmtStamp(ib.savedAt) : 'save time unknown') + ': ' + fmtCounts(ib.counts);
  }

  function backupNoteText(ib, pc) {
    var d = ib ? slotDetails(ib) : null;
    // CONTRACT.md §2 status().priorCopy.blocksNextRestore
    if (pc && pc.blocksNextRestore === true) {
      return 'A previous restore did not finish. Your earlier data is kept in this browser' + (d ? ' (' + d + ')' : '') +
        ' and is the only copy, so the next restore will be refused to protect it. Use "Download emergency raw copy" in Backup above to keep it.';
    }
    if (!ib) return null;
    if (!d) {
      return 'A copy of your previous data is kept in this browser, but its details can\'t be read. ' +
        'It is replaced by the next restore, so export a backup if you want to keep your data.';
    }
    return 'Your previous data is kept in this browser (' + d +
      '). This copy is replaced by the next restore, so export a backup if you want to keep it.';
  }

  function replacedBackupText(ib) {
    if (!ib) return null;
    var d = slotDetails(ib);
    return (d ? 'This replaces the previous restore backup (' + d + ').'
      : 'This replaces the previous restore backup. A saved backup exists, but its details can\'t be read.') +
      ' Only the data on this device right now will be kept.';
  }

  var DAMAGED_NOTE = 'Your saved data is damaged. If you restore, the damaged data will be kept: it is saved as the pre-restore copy first, and the existing recovery copy is not touched.';

  function warningText(w) {
    if (typeof w === 'string') return w;
    if (w && typeof w === 'object' && typeof w.message === 'string') return w.message;
    try { return JSON.stringify(w); } catch (e) { return String(w); }
  }

  // previewImport result + status -> view model, or {ok:false, failure}.
  function previewModel(res, avail) {
    if (!res || typeof res !== 'object') return { ok: false, failure: describeFailure({ code: 'bad_result' }, 'preview') };
    if (res.ok !== true) return { ok: false, failure: describeFailure(res, 'preview') };
    var p = res.preview;
    if (!p || typeof p !== 'object' || !isCounts(p.counts) || !isCounts(p.current) || !isCount(p.partialCount)) {
      return { ok: false, failure: describeFailure({ code: 'bad_result' }, 'preview') };
    }
    var currentState = typeof p.currentState === 'string' ? p.currentState : (avail && avail.state) || null;
    var corrupt = currentState === 'corrupt';
    var ib = avail ? avail.importBackup : null;
    var stateText = corrupt ? ' (damaged)' : currentState === 'empty' ? ' (empty)' : '';
    return {
      ok: true,
      preview: p, // the exact object; p.current is passed back as expectCurrent
      source: 'Backup from ' + fmtStamp(p.exportedAt),
      counts: { weight: String(p.counts.weight), workouts: String(p.counts.workouts), nutrition: String(p.counts.nutrition) },
      partialCount: String(p.partialCount),
      current: 'This device now: ' + (corrupt ? 'damaged data that cannot be shown' : fmtCounts(p.current)) + stateText + '. Restore replaces all of it.',
      replacedBackup: replacedBackupText(ib),
      warnings: Array.isArray(p.warnings) ? p.warnings.map(warningText).map(function (s) { return trimText(s, 200); }) : [],
      extLine: extLineText(p),
      emptyBackup: totalOf(p.counts) === 0 && extTotal(p.extCounts) === 0,
      // P4-O1 (owner-approved): an empty backup over a device that has entries needs a second,
      // separate confirmation. Uses only previewImport's own preview.current / preview.currentExt.
      // CONTRACT.md §1 preview.emptyReplacesPopulated; derived from counts only if an older data layer lacks it.
      emptyOverData: typeof p.emptyReplacesPopulated === 'boolean' ? p.emptyReplacesPopulated
        : totalOf(p.counts) === 0 && extTotal(p.extCounts) === 0 && (totalOf(p.current) + extTotal(p.currentExt)) > 0,
      emptyRows: emptyRows(p),
      emptyText: emptyText(p, currentState),
      // CONTRACT.md §2 preview.priorCopy.blocksRestore (early warning; applyImport refuses anyway).
      priorBlocked: !!(p.priorCopy && typeof p.priorCopy === 'object' && p.priorCopy.blocksRestore === true),
      priorText: p.priorCopy && p.priorCopy.blocksRestore === true ? priorBlockedText(p.priorCopy) : null,
      showDamaged: corrupt,
      showExportFirst: !(corrupt || currentState === 'empty')
    };
  }

  var EXT_LABELS = { sessions: 'Workout sessions', meals: 'Meals', body: 'Body measurements', daily: 'Daily check-ins', walks: 'Walks',
    dayStates: 'Day states', planEvents: 'Plan changes', ownerSettings: 'Settings' };
  function rowLabel(k) { return LISTS.indexOf(k) >= 0 ? listLabel(k) : EXT_LABELS[k] || String(k); }

  // P4-O1: per-collection "on this device now" vs "in this backup" rows. Prefers CONTRACT.md
  // preview.replaceSummary (stored records incl. damaged); falls back to counts/current/currentExt.
  // Only lists with an entry on either side are listed, then a Total row.
  function emptyRows(p) {
    var rs = p.replaceSummary && typeof p.replaceSummary === 'object' ? p.replaceSummary : null;
    if (rs && rs.current && typeof rs.current === 'object' && rs.incoming && typeof rs.incoming === 'object') {
      var keys = LISTS.concat(Object.keys(rs.current), Object.keys(rs.incoming)).filter(function (k, i, a) { return k !== 'total' && a.indexOf(k) === i; });
      var out = keys.map(function (k) {
        return { key: k, label: rowLabel(k), current: isCount(rs.current[k]) ? rs.current[k] : 0, incoming: isCount(rs.incoming[k]) ? rs.incoming[k] : 0 };
      }).filter(function (r) { return r.current > 0 || r.incoming > 0; });
      out.push({ key: 'total', label: 'Total', current: isCount(rs.current.total) ? rs.current.total : out.reduce(function (a, r) { return a + r.current; }, 0),
        incoming: isCount(rs.incoming.total) ? rs.incoming.total : out.reduce(function (a, r) { return a + r.incoming; }, 0) });
      return out;
    }
    return legacyRows(p);
  }
  function emptyText(p, currentState) {
    var rs = p.replaceSummary && typeof p.replaceSummary === 'object' ? p.replaceSummary : null;
    var st = rs && typeof rs.currentState === 'string' ? rs.currentState : currentState;
    var rows = emptyRows(p), tot = rows.length ? rows[rows.length - 1].current : 0;
    if (st === 'corrupt') return 'This backup contains no entries at all. The data on this device is damaged and cannot be counted; restoring replaces it with nothing.';
    return 'This backup contains no entries at all. Restoring it replaces ' + plural(tot, 'entry', 'entries') + ' on this device with nothing.';
  }
  function priorBlockedText(pc) {
    return 'Restore is blocked: a previous restore' + (typeof pc.savedAt === 'string' && pc.savedAt ? ' (started ' + fmtStamp(pc.savedAt) + ')' : '') +
      ' did not finish, and its safety copy is the only copy of your earlier data. Nothing will be changed. ' +
      'To keep that data, use "Download emergency raw copy" in Backup above.';
  }
  function legacyRows(p) {
    var rows = LISTS.map(function (k) {
      return { key: k, label: listLabel(k), current: isCount(p.current && p.current[k]) ? p.current[k] : 0, incoming: isCount(p.counts && p.counts[k]) ? p.counts[k] : 0 };
    });
    var cx = p.currentExt && typeof p.currentExt === 'object' ? p.currentExt : {};
    var ix = p.extCounts && typeof p.extCounts === 'object' ? p.extCounts : {};
    Object.keys(cx).concat(Object.keys(ix).filter(function (k) { return !(k in cx); })).forEach(function (k) {
      rows.push({ key: k, label: rowLabel(k), current: isCount(cx[k]) ? cx[k] : 0, incoming: isCount(ix[k]) ? ix[k] : 0 });
    });
    rows = rows.filter(function (r) { return r.current > 0 || r.incoming > 0; });
    rows.push({ key: 'total', label: 'Total', current: rows.reduce(function (a, r) { return a + r.current; }, 0), incoming: rows.reduce(function (a, r) { return a + r.incoming; }, 0) });
    return rows;
  }

  // P4-F01: CONTRACT.md §3 store.exportChecked() -> {ok,text,restorable,reasons[],reasonsTotal,reasonsTruncated}.
  // Returns a view model; never says "restorable" unless restorable === true.
  function exportCheckModel(res) {
    if (!res || typeof res !== 'object') return { ok: false, message: 'The app got an unexpected answer, so no backup was downloaded.' };
    if (res.ok !== true || typeof res.text !== 'string') {
      return { ok: false, code: typeof res.code === 'string' ? res.code : 'bad_result',
        message: typeof res.message === 'string' && res.message ? res.message : 'No backup was downloaded.' };
    }
    var reasons = Array.isArray(res.reasons) ? res.reasons.filter(function (r) { return r && typeof r === 'object'; }) : [];
    var list = reasons.slice(0, DETAILS_MAX).map(function (r) {
      var where = [r.collection ? rowLabel(r.collection) : null, typeof r.index === 'number' && r.index >= 0 ? 'entry ' + (r.index + 1) : null,
        r.id != null ? 'id ' + txt(r.id) : null, r.date != null ? txt(r.date) : null, r.field ? 'field ' + txt(r.field) : null].filter(Boolean).join(' · ');
      return trimText((where ? where + ': ' : '') + (txt(r.message) || txt(r.code) || 'not accepted') + (r.howToCorrect ? ' How to correct: ' + txt(r.howToCorrect) : ''), 400);
    });
    var total = typeof res.reasonsTotal === 'number' && res.reasonsTotal >= list.length ? res.reasonsTotal : list.length;
    return { ok: true, text: res.text, restorable: res.restorable === true, reasons: list, more: Math.max(0, total - list.length) };
  }

  // Phase 3 lists (sessions, meals, ...) shown alongside the classic counts.
  function extTotal(c) {
    if (!c || typeof c !== 'object') return 0;
    return Object.keys(c).reduce(function (a, k) { return a + (isCount(c[k]) ? c[k] : 0); }, 0);
  }
  function extLineText(p) {
    if (!p.extCounts && !p.currentExt) return '';
    function f(c) { var k = Object.keys(c || {}); return k.length ? k.map(function (x) { return x + ' ' + c[x]; }).join(', ') : 'none'; }
    return 'Detailed records in backup: ' + f(p.extCounts) + '. On this device now: ' + f(p.currentExt) + '.';
  }

  // applyImport result -> {restored:true, text, counts} or {restored:false, failure}
  function applyOutcome(res) {
    if (res && typeof res === 'object' && res.ok === true) {
      if (!isCounts(res.counts)) {
        return {
          restored: false,
          failure: {
            code: 'bad_result',
            headline: 'Restore could not be confirmed.',
            detail: 'The app could not verify the result. Reload the page and check your data.',
            errors: [], moreErrors: 0, unchanged: false, backupKey: null, urgent: true,
            status: 'Not restored.'
          }
        };
      }
      return { restored: true, counts: res.counts, text: 'Restored ' + fmtCounts(res.counts) + ' (verified).' };
    }
    return { restored: false, failure: describeFailure(res, 'apply') };
  }

  // exportSummary() call -> warning text or null (only when omitted > 0).
  function omittedText(summaryCall) {
    var s = summaryCall && summaryCall.ok ? summaryCall.value : null;
    if (!s || typeof s !== 'object' || !s.omitted || typeof s.omitted !== 'object') return null;
    var o = s.omitted, total = 0, parts = [];
    LISTS.forEach(function (k) {
      var n = isCount(o[k]) ? o[k] : 0;
      total += n;
      if (n > 0) parts.push(listLabel(k).toLowerCase() + ' ' + n);
    });
    // Phase 3 records that are stored but too damaged to export.
    var ox = s.omittedExt && typeof s.omittedExt === 'object' ? s.omittedExt : {};
    Object.keys(ox).forEach(function (k) {
      var n = isCount(ox[k]) ? ox[k] : 0;
      total += n;
      if (n > 0) parts.push(k + ' ' + n);
    });
    if (total === 0) return null;
    return plural(total, 'damaged entry was', 'damaged entries were') + ' not included in this backup (' + parts.join(', ') +
      '). They are still stored on this device.';
  }

  return {
    LISTS: LISTS, MESSAGES: MESSAGES, BLOCKED_STATES: BLOCKED_STATES,
    safeCall: safeCall, settle: settle, isCounts: isCounts, fmtCounts: fmtCounts, fmtStamp: fmtStamp,
    limitsOf: limitsOf, sizeCheck: sizeCheck, messageFor: messageFor, fmtRecordError: fmtRecordError,
    describeFailure: describeFailure, stateCode: stateCode, cleanMessage: cleanMessage, replacedBackupText: replacedBackupText, availability: availability, backupNoteText: backupNoteText,
    DAMAGED_NOTE: DAMAGED_NOTE, previewModel: previewModel, applyOutcome: applyOutcome, omittedText: omittedText,
    exportCheckModel: exportCheckModel, PRIOR_COPY_HELP: PRIOR_COPY_HELP
  };
})();
if (typeof window !== 'undefined') window.HyroxImportUI = HyroxImportUI;

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function showFatal(msg) {
    var box = $('app-error');
    if (box) {
      box.textContent = msg;
      box.hidden = false;
    }
    var main = $('app');
    if (main) main.hidden = true;
  }

  var IUI = window.HyroxImportUI;
  var HD = window.HyroxData;
  if (!HD || typeof HD.createStore !== 'function') {
    showFatal('Could not load the data layer (src/data/hyrox-data.js). ' +
      'Make sure the file exists next to index.html, then reload the page.');
    return;
  }

  var store;
  try {
    store = HD.createStore();
  } catch (e) {
    showFatal('Could not start the data store: ' + (e && e.message ? e.message : String(e)));
    return;
  }

  function today() {
    try { return HD.todayQatar(); } catch (e) {
      var d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
  }

  // ---------- helpers ----------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  // Blank stays '' so the data layer reports "required"; otherwise a number.
  function numVal(input) {
    var s = input.value.trim();
    if (s === '') return '';
    var n = Number(s);
    return isFinite(n) ? n : s;
  }

  function fmtNum(n) {
    var x = Number(n);
    if (!isFinite(x)) return String(n == null ? '' : n);
    return (Math.round(x * 10) / 10).toLocaleString('en-US');
  }

  function fmtDate(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return String(iso || '');
    var y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
    var dt = new Date(Date.UTC(y, m - 1, d));
    try {
      return dt.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) { return iso; }
  }

  function byDateDesc(arr) {
    return arr.slice().sort(function (a, b) {
      var da = String((a && a.date) || ''), db = String((b && b.date) || '');
      return da < db ? 1 : da > db ? -1 : 0; // stable sort keeps store's order within a date
    });
  }

  function safeList(type) {
    try {
      var l = store.list(type);
      return Array.isArray(l) ? byDateDesc(l) : [];
    } catch (e) { return []; }
  }

  // ---------- forms & errors ----------

  var FORMS = {
    weight: { fields: ['date', 'kg'] },
    workout: { fields: ['date', 'activity', 'durationMin', 'partial', 'notes'] },
    nutrition: { fields: ['date', 'label', 'calories', 'proteinG'] }
  };

  var FIELD_INPUT = {
    weight: { date: 'weight-date', kg: 'weight-kg' },
    workout: { date: 'workout-date', activity: 'workout-activity', durationMin: 'workout-duration', partial: 'workout-partial', notes: 'workout-notes' },
    nutrition: { date: 'nutrition-date', label: 'nutrition-label', calories: 'nutrition-calories', proteinG: 'nutrition-protein' }
  };

  function clearErrors(prefix) {
    FORMS[prefix].fields.forEach(function (f) {
      var p = $(prefix + '-error-' + f);
      if (p) p.textContent = '';
      var inp = $(FIELD_INPUT[prefix][f]);
      if (inp) inp.removeAttribute('aria-invalid');
    });
    $(prefix + '-error-form').textContent = '';
  }

  function showErrors(prefix, errors) {
    clearErrors(prefix);
    var general = [];
    var firstInvalid = null;
    Object.keys(errors || {}).forEach(function (key) {
      var msg = String(errors[key]);
      var p = FORMS[prefix].fields.indexOf(key) !== -1 ? $(prefix + '-error-' + key) : null;
      if (p) {
        p.textContent = msg;
        var inp = $(FIELD_INPUT[prefix][key]);
        if (inp) {
          inp.setAttribute('aria-invalid', 'true');
          if (!firstInvalid) firstInvalid = inp;
        }
      } else {
        general.push(msg); // e.g. errors.storage
      }
    });
    if (!Object.keys(errors || {}).length) general.push('Could not save this entry.');
    $(prefix + '-error-form').textContent = general.join(' ');
    if (firstInvalid) firstInvalid.focus();
  }

  function handleResult(prefix, res, form, resetFn) {
    if (res && res.ok) {
      clearErrors(prefix);
      resetFn();
      renderAll();
      return;
    }
    showErrors(prefix, res && res.errors);
    renderStatus();
  }

  // ---------- storage health banner ----------

  function renderStatus() {
    var box = $('storage-warning');
    if (!box) return;
    var sc = IUI.safeCall(store, 'status');
    var s = sc.ok && sc.value && typeof sc.value === 'object' ? sc.value : null;
    var msgs = [];
    if (s) {
      if (!s.persistent || s.state === 'unavailable') {
        msgs.push('Storage is unavailable in this browser (private browsing or blocked site data). Entries cannot be saved.');
      } else if (s.state === 'unreadable') {
        msgs.push('Your saved data could not be read. Saving is paused so nothing is overwritten. Reload the page to try again.');
      } else if (s.state === 'corrupt') {
        msgs.push('Your saved data is damaged and cannot be shown. It has not been deleted; it will be kept for recovery.' +
          (s.damagedList ? ' (Damaged part: the "' + s.damagedList + '" records.)' : ''));
      } else if (s.state === 'newer') {
        msgs.push('Your saved data is from a newer version of this app. Saving is paused so nothing is overwritten.');
      }
      if (s.recoveryKey) {
        msgs.push('A copy of damaged data was preserved in this browser\'s storage under "' + s.recoveryKey +
          '" for recovery. Do not clear site data for this page.');
      }
    }
    box.textContent = msgs.join(' ');
    box.hidden = msgs.length === 0;
    try { renderContext(s); } catch (e) { /* diagnostic is best effort and read-only */ }
  }

  // ---------- P6 storage context (read-only; RC-1) ----------
  // Uses store.status().keyPresent / .counts (CONTRACT-P6.md §1) plus location and display mode. Never writes.
  var COUNT_LABELS = { weight: 'weight', workouts: 'workouts', nutrition: 'nutrition', sessions: 'sessions', meals: 'meals', body: 'body', daily: 'check-ins', walks: 'walks', dayStates: 'day states', planEvents: 'plan changes', ownerSettings: 'settings' };
  function contextFacts(s) {
    var host;
    try { host = location.protocol === 'file:' ? 'file (opened from a file on this device)' : (location.host || 'unknown'); } catch (e) { host = 'unknown'; }
    var mode = 'unknown';
    try {
      var standalone = (typeof navigator !== 'undefined' && navigator.standalone === true) || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
      mode = standalone ? 'Home Screen app (standalone)' : 'Browser tab (not a Home Screen app)';
    } catch (e) { /* unknown */ }
    var key = !s || s.keyPresent === undefined ? 'not reported by this version' : s.keyPresent === true ? 'yes' : s.keyPresent === false ? 'no' : 'unknown';
    var counts = 'unknown';
    if (!s || s.counts === undefined) counts = 'not reported by this version';
    else if (s.counts && typeof s.counts === 'object') {
      var parts = Object.keys(COUNT_LABELS).filter(function (k) { return typeof s.counts[k] === 'number'; }).map(function (k) { return COUNT_LABELS[k] + ' ' + s.counts[k]; });
      counts = (typeof s.counts.total === 'number' ? s.counts.total + ' in total' + (parts.length ? ' (' : '') : '') + parts.join(', ') + (typeof s.counts.total === 'number' && parts.length ? ')' : '');
    }
    return [['Web address', host], ['Opened as', mode], ['Saved-data key (hyrox.v1) present', key], ['Records stored here', counts]];
  }
  function fillFacts(ul, s) {
    ul.replaceChildren();
    contextFacts(s).forEach(function (f) {
      var li = el('li', null, f[0] + ': ' + f[1]);
      li.setAttribute('data-testid', 'storage-fact');
      ul.appendChild(li);
    });
  }
  function renderContext(s) {
    var banner = $('storage-context');
    var diag = $('storage-diagnostic-list');
    if (diag) fillFacts(diag, s);
    if (!banner) return;
    var empty = !!s && s.persistent !== false && (s.state === 'empty' || (s.state === 'ok' && s.counts && s.counts.total === 0));
    if (empty) fillFacts($('storage-context-list'), s);
    banner.hidden = !empty;
  }

  function safeForm(prefix, fn) {
    try { return fn(); } catch (e) {
      return { ok: false, errors: { _: 'Unexpected error: ' + (e && e.message ? e.message : String(e)) } };
    }
  }

  // Weight
  $('weight-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var res = safeForm('weight', function () {
      // P1.1: with the pounds preference the typed number is pounds; it is converted once and stored in kg as always.
      if (weightUnit() === 'lb') {
        var p = window.HyroxMorning.weightParse($('weight-kg').value, 'lb');
        if (p.ok) return store.addWeight({ date: $('weight-date').value, kg: p.kg });
        if (!p.blank) return { ok: false, errors: { kg: p.error } };
      }
      return store.addWeight({ date: $('weight-date').value, kg: numVal($('weight-kg')) });
    });
    handleResult('weight', res, this, function () { $('weight-kg').value = ''; });
  });

  // Workouts
  $('workout-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var res = safeForm('workout', function () {
      return store.addWorkout({
        date: $('workout-date').value,
        activity: $('workout-activity').value,
        durationMin: numVal($('workout-duration')),
        partial: $('workout-partial').checked,
        notes: $('workout-notes').value
      });
    });
    handleResult('workout', res, this, function () {
      $('workout-activity').value = '';
      $('workout-duration').value = '';
      $('workout-partial').checked = false;
      $('workout-notes').value = '';
    });
  });

  // Nutrition
  $('nutrition-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var res = safeForm('nutrition', function () {
      return store.addNutrition({
        date: $('nutrition-date').value,
        label: $('nutrition-label').value,
        calories: numVal($('nutrition-calories')),
        proteinG: numVal($('nutrition-protein'))
      });
    });
    handleResult('nutrition', res, this, function () {
      $('nutrition-label').value = '';
      $('nutrition-calories').value = '';
      $('nutrition-protein').value = '';
    });
  });

  // ---------- rendering ----------

  function emptyItem(testid, text) {
    var li = el('li', 'empty', text);
    li.setAttribute('data-testid', testid);
    return li;
  }

  function deleteButton(testid, type, entry, desc, prefix) {
    var b = el('button', 'btn btn-delete', 'Delete');
    b.type = 'button';
    b.setAttribute('data-testid', testid);
    b.setAttribute('aria-label', 'Delete ' + desc);
    b.addEventListener('click', function () {
      if (!window.confirm('Delete ' + desc + '?')) return;
      var ok;
      try { ok = store.remove(type, entry.id); } catch (e) { ok = false; }
      if (ok === false) {
        var refuse = store.lastRemoveResult && store.lastRemoveResult();
        $(prefix + '-error-form').textContent = (refuse && refuse.message) || 'Could not delete this entry. Please try again.';
      } else {
        $(prefix + '-error-form').textContent = '';
      }
      renderAll();
    });
    return b;
  }

  function item(testid, title, meta, extra) {
    var li = el('li', 'entry');
    li.setAttribute('data-testid', testid);
    var body = el('div', 'entry-body');
    var t = el('div', 'entry-title');
    t.appendChild(el('span', null, title));
    if (extra) t.appendChild(extra);
    body.appendChild(t);
    meta.forEach(function (m) { if (m) body.appendChild(el('div', 'entry-meta', m)); });
    li.appendChild(body);
    return li;
  }

  // P1.1: body-weight unit preference (one field on the shared settings record; anything but a saved 'lb' is kg).
  function weightUnit() {
    try { return window.HyroxMorning ? window.HyroxMorning.unitFromSettings(store.settings().record) : 'kg'; } catch (e) { return 'kg'; }
  }
  function weightShown(kg, u) { return u === 'lb' ? window.HyroxMorning.weightText(kg, 'lb') : fmtNum(kg) + ' kg'; }
  function renderWeightUnit(u) {
    var l = $('weight-kg-label'), i = $('weight-kg');
    if (l) l.textContent = 'Weight (' + u + ')';
    if (i) i.placeholder = u === 'lb' ? 'e.g. 172.8' : 'e.g. 78.4';
  }
  function renderWeight() {
    var unit = weightUnit(); // read once per redraw (reading settings parses the stored data)
    renderWeightUnit(unit);
    var ul = $('weight-list');
    ul.replaceChildren();
    var list = safeList('weight');
    if (!list.length) { ul.appendChild(emptyItem('weight-empty', 'No weight entries yet.')); return; }
    list.forEach(function (e) {
      var li = item('weight-item', weightShown(e.kg, unit), [fmtDate(e.date)]);
      li.appendChild(deleteButton('weight-delete', 'weight', e, 'weight entry ' + weightShown(e.kg, unit) + ' on ' + e.date, 'weight'));
      ul.appendChild(li);
    });
  }

  function renderWorkouts() {
    var ul = $('workout-list');
    ul.replaceChildren();
    var list = safeList('workouts');
    if (!list.length) { ul.appendChild(emptyItem('workout-empty', 'No workouts logged yet.')); return; }
    list.forEach(function (e) {
      var badge = null;
      if (e.partial === true) {
        badge = el('span', 'badge', 'Partial');
        badge.setAttribute('data-testid', 'workout-partial-badge');
      }
      var li = item('workout-item', e.activity || 'Workout',
        [fmtDate(e.date) + ' · ' + fmtNum(e.durationMin) + ' min', e.notes ? e.notes : null], badge);
      li.appendChild(deleteButton('workout-delete', 'workouts', e, 'workout ' + (e.activity || '') + ' on ' + e.date, 'workout'));
      ul.appendChild(li);
    });
  }

  // Real shape (hyrox-data.js): array of {date, calories, proteinG, count}, newest first.
  // Also tolerates an object keyed by date.
  function normalizeTotals(raw) {
    var arr = [];
    if (Array.isArray(raw)) {
      arr = raw.filter(function (t) { return t && typeof t === 'object'; });
    } else if (raw && typeof raw === 'object') {
      arr = Object.keys(raw).map(function (d) {
        var v = raw[d] || {};
        return { date: v.date || d, calories: v.calories, proteinG: v.proteinG, count: v.count };
      });
    }
    return byDateDesc(arr);
  }

  function renderNutrition() {
    var tl = $('nutrition-totals');
    tl.replaceChildren();
    var totals;
    try { totals = normalizeTotals(store.dailyNutritionTotals()); } catch (e) { totals = []; }
    if (!totals.length) {
      tl.appendChild(el('li', 'empty', 'No totals yet.'));
    } else {
      totals.forEach(function (t) {
        var li = el('li', 'entry total');
        li.setAttribute('data-testid', 'nutrition-total');
        li.setAttribute('data-date', String(t.date));
        var body = el('div', 'entry-body');
        body.appendChild(el('div', 'entry-title', fmtDate(t.date)));
        if (t.count != null) body.appendChild(el('div', 'entry-meta', t.count + (t.count === 1 ? ' entry' : ' entries')));
        li.appendChild(body);
        var nums = el('div', 'total-nums');
        nums.appendChild(el('span', 'pill', fmtNum(t.calories) + ' kcal'));
        nums.appendChild(el('span', 'pill', fmtNum(t.proteinG) + ' g protein'));
        li.appendChild(nums);
        tl.appendChild(li);
      });
    }

    var ul = $('nutrition-list');
    ul.replaceChildren();
    var list = safeList('nutrition');
    if (!list.length) { ul.appendChild(emptyItem('nutrition-empty', 'No nutrition entries yet.')); return; }
    list.forEach(function (e) {
      var title = e.label ? e.label : 'Entry';
      var li = item('nutrition-item', title,
        [fmtDate(e.date) + ' · ' + fmtNum(e.calories) + ' kcal · ' + fmtNum(e.proteinG) + ' g protein']);
      li.appendChild(deleteButton('nutrition-delete', 'nutrition', e, 'nutrition entry ' + title + ' on ' + e.date, 'nutrition'));
      ul.appendChild(li);
    });
  }

  // Detailed (Phase 3) saves and deletes happen in app-ext.js; keep the storage banner and the
  // restore notes in step with them (e.g. after damaged data was copied to the recovery slot).
  // P1.1: the morning log can add a weight, and Settings can switch kg/lb; redraw the classic weight list for both.
  window.addEventListener('hyrox:weight-unit', function () { try { renderWeight(); } catch (e) { /* list refresh is best effort */ } });
  window.addEventListener('hyrox:ext-saved', function () {
    try { renderStatus(); renderImportState(); renderRawRecovery(); } catch (e) { /* banner refresh is best effort */ }
  });

  function renderAll() {
    renderStatus();
    renderRawRecovery();
    renderBackupNote();
    renderImportState();
    renderWeight();
    renderWorkouts();
    renderNutrition();
    try { window.dispatchEvent(new CustomEvent('hyrox:changed')); } catch (e) { /* older browsers */ }
  }

  // ---------- export ----------

  // Returns true when a download was started.
  // Starts a browser download of text. Throws on failure (callers report it).
  function downloadText(text, filename) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // ---------- P0: quiet backup reminder ----------
  // One small note, kept OUTSIDE hyrox.v1 and outside every backup: when this device last started a normal backup download.
  // It records a hand-off to the browser, nothing more - the app cannot see whether the file was kept, moved or copied.
  // Reading or writing it never touches the saved records, and a failure here never fails an export.
  var BACKUP_NOTE_KEY = 'hyrox.backup-note';
  function readBackupNote() {
    try {
      var raw = window.localStorage.getItem(BACKUP_NOTE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object' || typeof o.at !== 'string' || isNaN(Date.parse(o.at))) return null;
      var day = HD.todayQatar(new Date(o.at)), td = today();
      var days = Math.round((Date.parse(td + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z')) / 86400000);
      if (!(days >= 0)) return null; // a note dated in the future is not trusted
      return { at: o.at, day: day, days: days, file: typeof o.file === 'string' ? o.file.slice(0, 120) : null,
        restorable: o.restorable === true ? true : o.restorable === false ? false : null };
    } catch (e) { return null; }
  }
  function writeBackupNote(file, restorable) {
    try { window.localStorage.setItem(BACKUP_NOTE_KEY, JSON.stringify({ v: 1, at: new Date().toISOString(), file: file, restorable: restorable })); } catch (e) { /* the export itself already succeeded */ }
  }
  function renderBackupNote() {
    var p = $('backup-last');
    if (!p) return;
    var n = readBackupNote();
    if (!n) {
      p.textContent = 'Last backup export from this device: no record (unknown). That only means this app has no note of one here; it is not proof that no backup exists.';
      p.setAttribute('data-state', 'unknown');
      return;
    }
    var time = '';
    try { time = new Date(n.at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Qatar', hour: '2-digit', minute: '2-digit' }); } catch (e) { time = ''; }
    p.textContent = 'Last backup file prepared on this device: ' + fmtDate(n.day) + (time ? ' at ' + time + ' (Qatar)' : '') + ' — ' +
      (n.days === 0 ? 'today' : n.days === 1 ? 'yesterday' : n.days + ' days ago') + (n.file ? ' · ' + n.file : '') +
      '. The download was started here; this app cannot check that the file was kept, or copied to Files or Drive.' +
      (n.restorable === false ? ' That file was marked NOT-RESTORABLE.' : '');
    p.setAttribute('data-state', 'recorded');
  }
  try { window.HyroxBackupNote = { read: readBackupNote }; } catch (e) { /* */ }

  function rawRecoveryAvailable() {
    try { return !!store && typeof store.rawRecoveryExport === 'function'; } catch (e) { return false; }
  }

  function doExport() {
    var errBox = $('export-error');
    var omitBox = $('export-omitted');
    errBox.textContent = '';
    omitBox.textContent = '';
    omitBox.hidden = true;
    hideNotRestorable();
    var rawHint = rawRecoveryAvailable() ? ' You can still download the emergency raw copy below.' : '';
    // P4-F01: prefer CONTRACT.md §3 store.exportChecked() (text + restorable flag from one read);
    // fall back to exportJSON() only when this data layer does not have it.
    var text, checked = null;
    var chk = IUI.safeCall(store, 'exportChecked');
    if (chk.ok) {
      checked = IUI.exportCheckModel(chk.value);
      if (!checked.ok) {
        errBox.textContent = 'Export failed: ' + checked.message + rawHint;
        renderRawRecovery();
        return false;
      }
      text = checked.text;
    } else if (chk.code === 'ui_missing') {
      var call = IUI.safeCall(store, 'exportJSON');
      if (!call.ok || typeof call.value !== 'string') {
        errBox.textContent = 'Export failed: ' + (call.ok ? 'no data was returned.' : call.message.replace(/^Unexpected error: /, '')) + rawHint;
        return false;
      }
      text = call.value;
    } else {
      errBox.textContent = 'Export failed: ' + chk.message.replace(/^Unexpected error: /, '') + rawHint;
      return false;
    }
    try {
      // Claude P5 (P4-F01 labelling): a backup this build's own restore would refuse says so in its file
      // name too, so it cannot later be mistaken for a good backup in Files. The file content is unchanged.
      downloadText(text, 'hyrox-backup-' + today() + (checked && !checked.restorable ? '-NOT-RESTORABLE' : '') + '.json');
    } catch (e) {
      errBox.textContent = 'Export failed: ' + (e && e.message ? e.message : String(e));
      return false;
    }
    // P0: note that a download was started (never that a backup was saved anywhere).
    writeBackupNote('hyrox-backup-' + today() + (checked && !checked.restorable ? '-NOT-RESTORABLE' : '') + '.json', checked ? checked.restorable === true : null);
    renderBackupNote();
    try { window.dispatchEvent(new CustomEvent('hyrox:backup-note')); } catch (e) { /* older browsers */ }
    if (checked && !checked.restorable) showNotRestorable(checked);
    // P0: say when damaged entries were left out. No general success line (P1).
    var omitted = IUI.omittedText(IUI.safeCall(store, 'exportSummary'));
    // Round 2: also say when a record was written with one invalid value marked as invalid,
    // or with an older-rule value kept exactly as saved.
    var sum = IUI.safeCall(store, 'exportSummary'), sv = sum.ok && sum.value && typeof sum.value === 'object' ? sum.value : {};
    function total(o) { return o && typeof o === 'object' ? Object.keys(o).reduce(function (a, k) { return a + (typeof o[k] === 'number' ? o[k] : 0); }, 0) : 0; }
    var nAlt = total(sv.salvagedExt), nLeg = total(sv.legacyExt), extra = [];
    if (nAlt) extra.push(nAlt + (nAlt === 1 ? ' record was' : ' records were') + ' written with an invalid value marked as invalid (the original value is noted in the record; the rest is intact).');
    if (nLeg) extra.push(nLeg + (nLeg === 1 ? ' walk was' : ' walks were') + ' written exactly as saved, including a step count that is not a whole number and is not counted.');
    if (omitted || extra.length) {
      omitBox.textContent = [omitted].concat(extra).filter(Boolean).join(' ') + (rawRecoveryAvailable() ? ' To keep an untouched copy of everything exactly as saved, use "Download emergency raw copy" below.' : '');
      omitBox.hidden = false;
    }
    return true;
  }

  // P4-F01: never "verified/restorable" when this build's own restore check refused the file.
  function hideNotRestorable() {
    $('export-not-restorable').hidden = true;
    $('export-not-restorable-reasons').replaceChildren();
  }
  function showNotRestorable(m) {
    $('export-not-restorable-head').textContent = 'The backup file was downloaded (its name ends in NOT-RESTORABLE), but this app could NOT restore it as it is, so it is NOT a verified restorable backup. Keep it; nothing on this device was changed or removed.' +
      (m.reasons.length ? ' Reasons:' : '');
    var ul = $('export-not-restorable-reasons');
    ul.replaceChildren();
    m.reasons.forEach(function (t) { var li = el('li', null, t); li.setAttribute('data-testid', 'export-not-restorable-reason'); ul.appendChild(li); });
    ul.hidden = !m.reasons.length;
    show('export-not-restorable-more', m.more > 0 ? '…and ' + m.more + ' more not shown.' : null);
    renderRawRecovery();
    show('export-not-restorable-raw', rawRecoveryAvailable() && !$('raw-recovery').hidden
      ? 'Also use "Download emergency raw copy" below: it keeps everything exactly as saved on this device.' : null);
    $('export-not-restorable').hidden = false;
  }

  $('export-btn').addEventListener('click', function () { doExport(); });

  // ---------- emergency raw recovery copy (read-only; never restores) ----------
  // Contract source: Dawit's store.rawRecoveryExport() -> {ok:true, text, filename, warning, omittedTotal,
  // normalExport, sources:[{key,length,checksum}]} or {ok:false, code, message}. PROVISIONAL until his
  // written API contract lands; every call goes through safeCall and the section stays hidden without it.
  // Offered (dawit-recovery-api.md) when the normal export omits records, is refused (damaged/newer
  // storage), or a recovery copy / pre-import slot exists. The data layer's warning is shown verbatim
  // BEFORE the download. rawRecoveryExport() is read-only (zero writes), so calling it to preview is safe.
  function rawRecoveryNeeded() {
    var sc = IUI.safeCall(store, 'status');
    var st = sc.ok && sc.value && typeof sc.value === 'object' ? sc.value : {};
    if (st.state === 'corrupt' || st.state === 'newer' || st.recoveryKey || st.importBackup || st.priorCopy) return true;
    var es = IUI.safeCall(store, 'exportSummary');
    var v = es.ok && es.value && typeof es.value === 'object' ? es.value : {};
    function anyPositive(o) { return !!o && typeof o === 'object' && Object.keys(o).some(function (k) { return typeof o[k] === 'number' && o[k] > 0; }); }
    if (anyPositive(v.omitted) || anyPositive(v.omittedExt) || anyPositive(v.salvagedExt) || anyPositive(v.legacyExt)) return true;
    // P4-F01: keep the raw copy offered when the normal backup would be refused by this build's own restore
    // (CONTRACT.md §3 rawRecoveryExport().normalRestorable; read-only call).
    var rr = IUI.safeCall(store, 'rawRecoveryExport');
    return !!(rr.ok && rr.value && rr.value.normalRestorable === false);
  }

  function renderRawRecovery() {
    var box = $('raw-recovery');
    if (!box) return;
    var on = rawRecoveryAvailable() && rawRecoveryNeeded();
    box.hidden = !on;
    if (!on) return;
    var call = IUI.safeCall(store, 'rawRecoveryExport');
    var r = call.ok && call.value && typeof call.value === 'object' ? call.value : null;
    var btn = $('raw-recovery-btn');
    if (r && r.ok === true && typeof r.warning === 'string' && r.warning) {
      show('raw-recovery-pre', r.warning);
      btn.disabled = false;
    } else {
      show('raw-recovery-pre', 'Emergency raw copy unavailable: ' + (r && typeof r.message === 'string' && r.message ? r.message : call.ok ? 'unexpected answer from the app.' : call.message) + ' Nothing was changed.');
      btn.disabled = true;
    }
  }

  function doRawRecovery() {
    var errBox = $('raw-recovery-error');
    errBox.textContent = '';
    show('raw-recovery-warning', null);
    show('raw-recovery-sources', null);
    $('raw-recovery-result').hidden = true;
    var call = IUI.safeCall(store, 'rawRecoveryExport');
    var r = call.ok ? call.value : null;
    if (!call.ok || !r || typeof r !== 'object') {
      errBox.textContent = 'Raw copy not downloaded: ' + (call.ok ? 'no data was returned.' : call.message) + ' Nothing was changed.';
      return false;
    }
    if (r.ok !== true || typeof r.text !== 'string') {
      errBox.textContent = 'Raw copy not downloaded: ' + (typeof r.message === 'string' && r.message ? r.message : 'unknown error (' + String(r.code || 'no code') + ').') +
        (/nothing (was|is) changed/i.test(String(r.message || '')) ? '' : ' Nothing was changed.');
      return false;
    }
    var name = typeof r.filename === 'string' && /^[A-Za-z0-9._-]{1,80}\.json$/.test(r.filename) ? r.filename : 'hyrox-RAW-RECOVERY-' + today() + '.json';
    try { downloadText(r.text, name); } catch (e) {
      errBox.textContent = 'Raw copy not downloaded: ' + (e && e.message ? e.message : String(e));
      return false;
    }
    // The omission warning comes from the data layer; never claim "complete" on our own.
    var warn = typeof r.warning === 'string' && r.warning ? r.warning
      : 'This emergency copy is the exact stored text. It is NOT a normal backup and cannot be restored with Restore.';
    if (typeof r.omittedTotal === 'number' && r.omittedTotal > 0 && !/leaves out/i.test(warn)) {
      warn = 'The normal backup leaves out ' + r.omittedTotal + ' damaged record(s); this copy keeps them exactly as stored. ' + warn;
    }
    show('raw-recovery-warning', 'Download started (' + name + '). ' + warn);
    var src = Array.isArray(r.sources) ? r.sources.filter(function (x) { return x && typeof x.key === 'string'; }) : [];
    show('raw-recovery-sources', src.length ? 'Copied exactly: ' + src.map(function (x) {
      return x.key + (typeof x.length === 'number' ? ' (' + x.length + ' characters' + (typeof x.checksum === 'string' ? ', check ' + x.checksum : '') + ')' : '');
    }).join('; ') + '.' : null);
    $('raw-recovery-result').hidden = false;
    return true;
  }

  $('raw-recovery-btn').addEventListener('click', function () { doRawRecovery(); });

  // ---------- restore (REPLACE only; P0 has no Undo) ----------

  var imp = {
    text: null,      // raw file text, kept in memory until confirm or cancel
    preview: null,   // the exact preview object from previewImport
    vm: null,        // the preview view model (P4-O1 / P4-F02 gates)
    busy: false,
    token: 0         // invalidates a file read that finishes after cancel
  };

  function show(id, text) {
    var n = $(id);
    if (text == null || text === '') { n.textContent = ''; n.hidden = true; }
    else { n.textContent = String(text); n.hidden = false; }
  }

  function setBusy(on, statusText) {
    imp.busy = on;
    ['import-confirm', 'import-cancel', 'import-export-first', 'import-empty-confirm'].forEach(function (id) { $(id).disabled = on; });
    show('import-status', on ? statusText : null);
    renderImportState();
    gateConfirm();
  }

  // P4-O1 / P4-F02: "Replace my data" stays off until the second confirmation is ticked (empty backup over
  // a populated device), and while a previous restore's only safety copy blocks restores.
  function gateConfirm() {
    var btn = $('import-confirm'), vm = imp.vm;
    var needTick = !!(vm && vm.emptyOverData), ticked = $('import-empty-confirm').checked;
    var blocked = !!(vm && vm.priorBlocked);
    btn.disabled = imp.busy || blocked || (needTick && !ticked);
    var desc = blocked ? 'import-prior-blocked' : needTick ? 'import-empty-hint' : '';
    if (desc) btn.setAttribute('aria-describedby', desc); else btn.removeAttribute('aria-describedby');
  }
  $('import-empty-confirm').addEventListener('change', gateConfirm);

  // The offending value exactly as in the file, as plain text (never parsed as HTML).
  function detailValueText(d) {
    if (d.valueType === 'missing' || !d.hasValue) return '(missing)';
    if (d.value === null) return 'null';
    if (typeof d.value === 'string') return d.value === '' ? '(empty text)' : d.value;
    if (typeof d.value === 'object') { try { return JSON.stringify(d.value); } catch (e) { return String(d.value); } }
    return String(d.value);
  }

  // t54u restore refusal details. Every string goes through textContent (el()). No repair, rounding or
  // auto-fix control exists: the owner corrects the backup file and restores again.
  function renderDetails(f) {
    var box = $('import-details');
    if (!box) return;
    box.replaceChildren();
    if (!f || !f.details) { box.hidden = true; return; }
    var head = el('p', 'details-summary', (f.detailsTotal === 1 ? '1 problem found' : f.detailsTotal + ' problems found') +
      (f.detailsTruncated ? ' — showing the first ' + f.details.length + '.' : '.'));
    head.setAttribute('data-testid', 'import-details-total');
    box.appendChild(head);
    if (f.unchanged) {
      var nc = el('p', 'details-unchanged', 'Nothing was changed: your data on this device is exactly as it was.');
      nc.setAttribute('data-testid', 'import-details-unchanged');
      box.appendChild(nc);
    }
    var ol = el('ol', 'details-list');
    ol.setAttribute('data-testid', 'import-details-list');
    f.details.forEach(function (d) {
      var li = el('li', 'details-item');
      li.setAttribute('data-testid', 'import-detail');
      var where = [d.collection, d.index === null ? null : d.index < 0 ? 'the whole list' : 'entry ' + (d.index + 1),
        d.id !== null ? 'id ' + d.id : 'no id', d.date !== null ? d.date : 'no date'].filter(Boolean).join(' · ');
      var w = el('p', 'details-where', where); w.setAttribute('data-testid', 'import-detail-where'); li.appendChild(w);
      if (d.message) { var m = el('p', null, d.message); m.setAttribute('data-testid', 'import-detail-message'); li.appendChild(m); }
      var fl = el('p', null, 'Field: ' + (d.field && d.field !== 'entry' ? d.field : 'the whole entry'));
      fl.setAttribute('data-testid', 'import-detail-field'); li.appendChild(fl);
      var vp = el('p', null, 'Value in the file: ');
      var code = el('code', 'details-value', detailValueText(d)); code.setAttribute('data-testid', 'import-detail-value'); vp.appendChild(code);
      var vt = el('span', 'details-type', ' (' + (d.valueType || typeof d.value) + ')'); vt.setAttribute('data-testid', 'import-detail-type'); vp.appendChild(vt);
      li.appendChild(vp);
      if (d.valueTruncated) {
        var tr = el('p', 'hint', 'This value is shortened here' + (d.valueLength !== null ? ' (the file has ' + d.valueLength + ' characters)' : '') + '; the file itself is unchanged.');
        tr.setAttribute('data-testid', 'import-detail-truncated'); li.appendChild(tr);
      }
      if (d.rule) { var r = el('p', null, 'Rule: ' + d.rule); r.setAttribute('data-testid', 'import-detail-rule'); li.appendChild(r); }
      if (d.howToCorrect) { var hc = el('p', 'details-how', 'How to correct: ' + d.howToCorrect); hc.setAttribute('data-testid', 'import-detail-how'); li.appendChild(hc); }
      ol.appendChild(li);
    });
    box.appendChild(ol);
    if (f.detailsTruncated) {
      var more = el('p', 'details-more', '…and ' + (f.detailsTotal - f.details.length) + ' more not shown. Fix these, then restore again to see the rest.');
      more.setAttribute('data-testid', 'import-details-more'); box.appendChild(more);
    }
    var how = el('p', 'details-guide', 'How to fix the backup: open the backup file in a text editor (on iPhone, a text editor app from the Files app), find each entry by its list name and id, change the value so it follows the rule, save the file, then choose it again here. The app will not round, repair or change any value for you; a decimal step total must be corrected in the file.');
    how.setAttribute('data-testid', 'import-details-guide'); box.appendChild(how);
    box.hidden = false;
  }

  function clearImportMessages() {
    show('import-status', null);
    show('import-result', null);
    $('import-error').hidden = true;
    show('import-error-message', null);
    show('import-error-detail', null);
    var ul = $('import-error-list');
    ul.replaceChildren();
    ul.hidden = true;
    renderDetails(null);
    $('import-error').classList.remove('urgent');
  }

  function discardPending() {
    imp.text = null;
    imp.preview = null;
    imp.vm = null;
    $('import-empty-confirm').checked = false;
    imp.token++;
    $('import-preview').hidden = true;
    renderImportState();
  }

  function showFailure(f) {
    show('import-result', null);
    show('import-status', f.status || 'Not restored.');
    show('import-error-message', f.headline);
    show('import-error-detail', f.detail);
    var ul = $('import-error-list');
    ul.replaceChildren();
    f.errors.forEach(function (t) {
      var li = el('li', null, t);
      li.setAttribute('data-testid', 'import-error-item');
      ul.appendChild(li);
    });
    if (f.moreErrors > 0) {
      var more = el('li', null, '…and ' + f.moreErrors + ' more.');
      more.setAttribute('data-testid', 'import-error-more');
      ul.appendChild(more);
    }
    ul.hidden = ul.childNodes.length === 0;
    renderDetails(f);
    $('import-error').classList.toggle('urgent', !!f.urgent);
    $('import-error').hidden = false;
  }

  // Disabled state, damaged-data note and previous-data note. Never touches the pending preview.
  function renderImportState() {
    var av = IUI.availability(IUI.safeCall(store, 'status'), store);
    var input = $('import-file');
    var btn = $('import-btn');
    var off = !av.enabled || imp.busy;
    input.disabled = off;
    btn.classList.toggle('is-disabled', off);
    btn.setAttribute('aria-disabled', off ? 'true' : 'false');
    show('import-disabled-reason', av.reason);
    var damaged = av.corrupt || !!(imp.preview && imp.preview.currentState === 'corrupt');
    show('import-damaged-note', damaged && av.enabled ? IUI.DAMAGED_NOTE : null);
    show('import-backup-note', IUI.backupNoteText(av.importBackup, av.priorCopy));
    $('import-backup-note').classList.toggle('note-danger', !!(av.priorCopy && av.priorCopy.blocksNextRestore === true));
    if (!av.enabled && imp.text !== null && !imp.busy) {
      // Storage went bad while a preview was open: drop it.
      imp.text = null; imp.preview = null; imp.token++;
      $('import-preview').hidden = true;
    }
    return av;
  }

  function renderPreview(vm) {
    show('import-preview-source', vm.source);
    show('import-count-weight', vm.counts.weight);
    show('import-count-workouts', vm.counts.workouts);
    show('import-count-nutrition', vm.counts.nutrition);
    show('import-partial-count', vm.partialCount);
    show('import-current', vm.current);
    show('import-replaced-backup', vm.replacedBackup);
    var ext = $('import-ext-counts');
    if (ext) { ext.textContent = vm.extLine || ''; ext.hidden = !vm.extLine; }
    var ul = $('import-preview-warnings');
    ul.replaceChildren();
    vm.warnings.forEach(function (t) {
      var li = el('li', null, t);
      li.setAttribute('data-testid', 'import-preview-warning');
      ul.appendChild(li);
    });
    // Phase 12: what restoring this backup does to the device's training plan blocks (read-only comparison).
    var pbNote = null;
    try { pbNote = window.HyroxBlocks && imp.text ? window.HyroxBlocks.restoreNote(localStorage.getItem(HD.STORAGE_KEY), imp.text) : null; } catch (e) { pbNote = null; }
    if (pbNote) { var pli = el('li', null, pbNote); pli.setAttribute('data-testid', 'import-preview-plan-blocks'); ul.appendChild(pli); }
    // RC2 review: restore replaces the whole settings record, so it also replaces (or removes) this device's saved foods
    // and favourites. Say so before the owner confirms (read-only comparison; nothing is written here).
    var sfNote = null;
    try { sfNote = window.HyroxFoodSearch && window.HyroxFoodSearch.restoreNote && imp.text ? window.HyroxFoodSearch.restoreNote(localStorage.getItem(HD.STORAGE_KEY), imp.text) : null; } catch (e) { sfNote = null; }
    if (sfNote) { var sli = el('li', null, sfNote); sli.setAttribute('data-testid', 'import-preview-saved-foods'); ul.appendChild(sli); }
    // P1.3: the same for the Nutrition Coach profile and confirmed targets (read-only comparison; nothing is written here).
    var ncNote = null;
    try { ncNote = window.HyroxCoach && window.HyroxCoach.restoreNote && imp.text ? window.HyroxCoach.restoreNote(localStorage.getItem(HD.STORAGE_KEY), imp.text) : null; } catch (e) { ncNote = null; }
    if (ncNote) { var nli = el('li', null, ncNote); nli.setAttribute('data-testid', 'import-preview-coach'); ul.appendChild(nli); }
    ul.hidden = vm.warnings.length === 0 && !pbNote && !sfNote && !ncNote;
    // P4-O1: plain note for an empty backup on an empty device; the danger block + second confirmation otherwise.
    $('import-empty-note').hidden = !(vm.emptyBackup && !vm.emptyOverData);
    $('import-empty-warning').hidden = !vm.emptyOverData;
    $('import-empty-confirm').checked = false;
    var tb = $('import-empty-rows');
    tb.replaceChildren();
    if (vm.emptyOverData) {
      $('import-empty-text').textContent = vm.emptyText;
      vm.emptyRows.forEach(function (r) {
        var tr = el('tr', r.key === 'total' ? 'empty-danger-total' : null);
        tr.setAttribute('data-testid', 'import-empty-row');
        tr.setAttribute('data-key', r.key);
        var th = el('th', null, r.label); th.setAttribute('scope', 'row'); tr.appendChild(th);
        var c1 = el('td', null, String(r.current)); c1.setAttribute('data-label', 'On this device now'); tr.appendChild(c1);
        var c2 = el('td', null, String(r.incoming)); c2.setAttribute('data-label', 'In this backup'); tr.appendChild(c2);
        tb.appendChild(tr);
      });
    }
    show('import-prior-blocked', vm.priorText);
    $('import-export-first').hidden = !vm.showExportFirst;
    $('import-preview').hidden = false;
    gateConfirm();
    // Keyboard / screen-reader users land on the danger heading first.
    if (vm.emptyOverData) { try { $('import-empty-title').focus({ preventScroll: false }); } catch (e) { /* best effort */ } }
  }

  function previewText(text, token) {
    if (token !== imp.token) return;
    var av = renderImportState();
    if (!av.enabled) {
      setBusy(false);
      showFailure(IUI.describeFailure({ code: IUI.stateCode(av.state) }, 'preview'));
      return;
    }
    IUI.settle(IUI.safeCall(store, 'previewImport', [text]), function (res) {
      if (token !== imp.token) { setBusy(false); return; }
      var vm = IUI.previewModel(res, av);
      setBusy(false);
      if (!vm.ok) {
        discardPending();
        showFailure(vm.failure);
        return;
      }
      imp.text = text;
      imp.preview = vm.preview;
      imp.vm = vm;
      renderPreview(vm);
      renderImportState();
    });
  }

  $('import-file').addEventListener('change', function () {
    var input = this;
    var file = input.files && input.files[0];
    input.value = ''; // picking the same file again still fires change
    if (!file || imp.busy) return; // picker cancelled: no call, no write
    discardPending();
    clearImportMessages();
    var av = renderImportState();
    if (!av.enabled) return;
    var chk = IUI.sizeCheck(file.size, IUI.limitsOf(HD));
    if (!chk.ok) {
      showFailure(IUI.describeFailure({ code: chk.code }, 'preview', chk));
      return;
    }
    var token = imp.token;
    setBusy(true, 'Checking the file…');
    var reader;
    try { reader = new FileReader(); } catch (e) { reader = null; }
    if (!reader) {
      setBusy(false);
      showFailure(IUI.describeFailure({ code: 'read_failed' }, 'preview'));
      return;
    }
    reader.onload = function () {
      if (token !== imp.token) return;
      if (typeof reader.result !== 'string') {
        setBusy(false);
        showFailure(IUI.describeFailure({ code: 'read_failed' }, 'preview'));
        return;
      }
      previewText(reader.result, token);
    };
    reader.onerror = function () {
      if (token !== imp.token) return;
      setBusy(false);
      showFailure(IUI.describeFailure({ code: 'read_failed' }, 'preview'));
    };
    try { reader.readAsText(file); } catch (e) {
      setBusy(false);
      showFailure(IUI.describeFailure({ code: 'read_failed' }, 'preview'));
    }
  });

  function cancelImport() {
    if (imp.busy) return;
    discardPending(); // nothing is written
    clearImportMessages();
    show('import-status', 'Restore cancelled. Nothing was changed.');
  }
  $('import-cancel').addEventListener('click', cancelImport);
  // Escape anywhere in the open preview = Cancel (writes nothing); focus returns to the file picker.
  $('import-preview').addEventListener('keydown', function (ev) {
    if ((ev.key === 'Escape' || ev.key === 'Esc') && !imp.busy && !$('import-preview').hidden) {
      ev.preventDefault();
      cancelImport();
      try { $('import-file').focus(); } catch (e) { /* best effort */ }
    }
  });
  // Leaving Settings un-ticks the second confirmation, so it is never carried over unseen.
  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[role="tab"]') : null;
    if (t && t.id !== 'tab-settings' && $('import-empty-confirm').checked) { $('import-empty-confirm').checked = false; gateConfirm(); }
  });

  $('import-export-first').addEventListener('click', function () {
    if (imp.busy) return;
    doExport();
  });

  $('import-confirm').addEventListener('click', function () {
    if (imp.busy || imp.text === null || !imp.preview) return; // double-tap guard
    var vm = imp.vm;
    if (vm && vm.priorBlocked) return; // P4-F02 early block: nothing is written
    var emptyConfirmed = !!(vm && vm.emptyOverData && $('import-empty-confirm').checked);
    if (vm && vm.emptyOverData && !emptyConfirmed) { gateConfirm(); return; } // P4-O1: second confirmation missing
    var text = imp.text;
    var preview = imp.preview;
    var opts = { confirm: 'REPLACE', expectCurrent: preview.current, expectCurrentExt: preview.currentExt };
    if (emptyConfirmed) opts.confirmEmptyReplace = true; // CONTRACT.md §1: only after the second confirmation
    clearImportMessages();
    setBusy(true, 'Restoring…');
    IUI.settle(IUI.safeCall(store, 'applyImport', [text, opts]), function (res) {
      var out = IUI.applyOutcome(res);
      imp.text = null; // one attempt per pick; re-pick the file to try again
      imp.preview = null;
      imp.vm = null;
      $('import-empty-confirm').checked = false;
      imp.token++;
      $('import-preview').hidden = true;
      setBusy(false);
      renderAll(); // lists, totals, banner, notes
      if (out.restored) {
        var ec = IUI.safeCall(store, 'extCounts');
        var keys = ec.ok && ec.value ? Object.keys(ec.value) : [];
        show('import-result', out.text + (keys.length ? ' Detailed records: ' + keys.map(function (k) { return k + ' ' + ec.value[k]; }).join(', ') + '.' : ''));
      }
      else showFailure(out.failure);
    });
  });

  window.addEventListener('pagehide', function () { imp.text = null; imp.preview = null; imp.vm = null; $('import-empty-confirm').checked = false; });

  // ---------- init ----------

  var t = today();
  ['weight-date', 'workout-date', 'nutrition-date'].forEach(function (id) {
    $(id).value = t;
    $(id).max = t;
  });
  renderAll();
})();
