/*
 * app-ext.js - Phase 3 UI: tabs, Today, detailed workouts, meals (manual / description / photo+AI),
 * body + check-in + walks, History, Trends, Settings. Plain DOM, no dependencies.
 * Every save goes through store.putRecord (validated write + read-back); no false "Saved".
 */
(function () {
  'use strict';
  var HD = window.HyroxData, HP = window.HyroxPlan, HN = window.HyroxNutrition, HW = window.HyroxWellness, AI = window.HyroxPhotoAI;
  // Phase 12: later training blocks (Block 2+). Optional: without it the app is exactly the Block 1 app.
  var HB = window.HyroxBlocks || null;
  if (!HD || !HP || !HN || !HW || !AI) return;
  var HM = window.HyroxMorning; // P1.1: morning log helpers (intensity minutes, kg/lb)
  var store;
  try { store = HD.createStore(); } catch (e) { return; }
  var AI_SETTINGS_KEY = 'hyrox.ai-settings';
  // P9: the owner access code lives in its own key, only on this device. It is never part of hyrox.v1, exports or backups.
  var AI_CODE_KEY = 'hyrox.ai-owner-code';

  // ---------- tiny DOM helpers ----------
  function $(id) { return document.getElementById(id); }
  function h(tag, a) {
    var n = document.createElement(tag);
    a = a || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = String(v);
      else if (k === 'testid') n.setAttribute('data-testid', v);
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = !!v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(n, arguments[i]);
    return n;
  }
  function append(n, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(n, x); }); return; }
    n.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function card(title, testid) {
    var c = h('section', { class: 'card', testid: testid });
    if (title) c.appendChild(h('h2', { text: title }));
    return c;
  }
  function field(label, input, hint) {
    var id = input.id || ('f-' + Math.random().toString(36).slice(2, 9));
    input.id = id;
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, hint ? h('p', { class: 'hint', text: hint }) : null);
  }
  function select(opts, value, a) {
    var s = h('select', a || {});
    opts.forEach(function (o) {
      var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o;
      s.appendChild(h('option', { value: v, text: l, selected: String(v) === String(value) ? 'selected' : null }));
    });
    return s;
  }
  function numIn(value, a) {
    var i = h('input', Object.assign({ type: 'number', inputmode: 'decimal', step: 'any', min: '0' }, a || {}));
    i.value = value === null || value === undefined ? '' : String(value);
    return i;
  }
  function numOrNull(s) { s = String(s == null ? '' : s).trim(); if (s === '') return null; var n = Number(s); return isFinite(n) ? n : NaN; }
  function badge(text, kind, testid) { return h('span', { class: 'badge badge-' + (kind || 'info'), text: text, testid: testid }); }
  function today() { return HD.todayQatar(); }
  function fmtDate(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return String(iso || '');
    var d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
    return d.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  }
  function fmt(n) { return n === null || n === undefined ? '—' : String(Math.round(n * 10) / 10); }
  // ---- v2.1 source references (HNC-BASE-v2.1 §6, §9). Dawit round-2 contract (dawit-round2-contract.md,
  // DRAFT v1, API frozen): HW.stepReferenceGoal / HW.tenKGate / HP.variantPrescription / HP.dayLoad,
  // slotStatus().weekendWork. Used when present; otherwise the verbatim source values below are shown. ----
  var SRC_STEP_FLOOR = { 1: 7000, 2: 8000, 3: 9000, 4: 10000 };
  function isWeekend(iso) { var d = new Date(String(iso) + 'T00:00:00Z').getUTCDay(); return d === 0 || d === 6; }
  function callOpt(obj, name, args) { try { return obj && typeof obj[name] === 'function' ? obj[name].apply(obj, args) : undefined; } catch (e) { return undefined; } }
  // Phase 12 D7 (ST0): a Block 2 day has no plan step reference goal and 10,000/day is never assumed; adaptive guidance is unchanged.
  function stepReference(d, ctx) {
    var bb = PL.blockStatus(d);
    if (bb && bb.active) return { week: null, goal: null, block2: true, doNotForce: [], fromApi: false,
      text: bb.label + ' (week ' + bb.week + ' of 4): no plan step reference goal in this block (ST0). Adaptive guidance only; 10,000 steps/day is not assumed.' };
    return stepReference1(d, ctx);
  }
  function stepReference1(d, ctx) {
    var api = callOpt(HW, 'stepReferenceGoal', [d, ctx || stepContext()(d)]);
    if (api && typeof api === 'object' && 'goal' in api) return { week: api.week, goal: typeof api.goal === 'number' ? api.goal : null, goalKind: api.goalKind,
      status: api.status, doNotForce: Array.isArray(api.doNotForce) ? api.doNotForce : [], gate: api.gate || null, met: api.met,
      optional10k: api.week >= 1 && api.week < 4, offered10k: api.optional10k && api.optional10k.offered, conditional: api.goalKind === 'TARGET_IF_TOLERATED', text: api.note || null, fromApi: true };
    var bs = HP.blockStatus(d);
    if (!bs.active || !(bs.week >= 1 && bs.week <= 4)) return { week: null, goal: null, text: bs.text, fromApi: false };
    return { week: bs.week, goal: SRC_STEP_FLOOR[bs.week], conditional: bs.week === 4, optional10k: bs.week < 4, fromApi: false };
  }
  var INTENSITY_LABEL = { EASY: 'Easy', MODERATE: 'Moderate', DEMANDING: 'Demanding' };
  var VARIANT_LABEL = { ORIGINAL_60: 'Original 60 min', SOURCE_45_MIN: 'Source 45-min fallback', SOURCE_25_MIN: 'Source 25-min fallback', OTHER_EXECUTION: 'Other execution', NONE: 'None' };
  // Verbatim HNC-BASE-v2.1 §9 text for the fallback variants. Nothing beyond the source is added.
  function variantRx(slot, variant) {
    var api = slot ? PL.variantPrescription(slot.id, variant) : undefined;
    if (api && typeof api === 'object' && Array.isArray(api.prescription)) return { lines: api.prescription.map(String), fromApi: true, api: api,
      keep: (api.keep || []).map(String), drop: (api.drop || []).map(String), unspecified: (api.unspecified || []).map(function (u) { return u && u.text ? String(u.text) : String(u); }) };
    if (!slot) return null;
    if (variant === 'SOURCE_45_MIN') return { lines: ['45 minutes: keep main lift or main HYROX circuit, drop accessories.'], fromApi: false };
    if (variant === 'SOURCE_25_MIN') {
      if (slot.type === 'STRENGTH_A') return { lines: ['25 minutes strength: warm up then 2 working sets each of squat + bench (Monday).'], fromApi: false };
      if (slot.type === 'STRENGTH_B') return { lines: ['25 minutes strength: warm up then 2 working sets each of deadlift + press (Wednesday).'], fromApi: false };
      return { lines: ['25 minutes HYROX: 5 min warm-up, two short run/station rounds, 3 min cooldown.'], fromApi: false };
    }
    return null;
  }

  var toastTimer;
  function toast(msg, bad) {
    var t = $('ext-toast'); if (!t) return;
    t.textContent = msg; t.className = 'toast ' + (bad ? 'toast-bad' : 'toast-ok'); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 4500);
  }
  function errorsText(errs) { return Object.keys(errs || {}).map(function (k) { return errs[k]; }).join(' '); }
  function persist(type, rec, errBox, opts) {
    var res;
    dropReadMemo();
    try { res = store.putRecord(type, rec, opts); } catch (e) { res = { ok: false, errors: { _: 'Unexpected error.' } }; }
    dropReadMemo();
    if (res.ok) { if (errBox) errBox.textContent = ''; toast('Saved on this device (verified by read-back).'); refresh(); extSaved(); }
    else { var m = 'Not saved: ' + errorsText(res.errors); if (errBox) errBox.textContent = m; toast(m, true); }
    return res;
  }
  // Claude P5 review (performance): one screen update used to re-read and re-validate the whole stored
  // database for every day shown (dayStateFor -> allMeals/attestationFor), e.g. ~15 s to open the app with a
  // year of daily logging. Reads are now remembered for the rest of the CURRENT synchronous update only:
  // the memo is dropped at the end of the task (microtask), at the start of every refresh(), and right after
  // every save or delete made here, so a screen can never show data older than what is stored.
  // Callers never modify these results (edit forms work on JSON copies).
  var readMemo = null;
  function dropReadMemo() { readMemo = null; }
  function memoRead(key, fn) {
    if (!readMemo) {
      readMemo = Object.create(null);
      var mine = readMemo;
      Promise.resolve().then(function () { if (readMemo === mine) readMemo = null; });
    }
    if (!(key in readMemo)) readMemo[key] = fn();
    return readMemo[key];
  }
  function recs(t) { return memoRead('r:' + t, function () { try { return store.records(t); } catch (e) { return []; } }); }
  // Stored entries that are not valid as stored (read-only list from the data layer).
  function damaged() { try { return typeof store.damagedRecords === 'function' ? store.damagedRecords() : []; } catch (e) { return []; } }
  // ---- Phase 12: plan blocks. Block 1 (HP, v2.1) is untouched; later blocks come from the optional settings field planBlocks.
  // Read from the raw stored settings record so a damaged settings value never hides an active block (writes are refused then).
  function rawSettingsRecord() {
    try { var raw = JSON.parse(localStorage.getItem(HD.STORAGE_KEY) || 'null');
      return raw && Array.isArray(raw.ownerSettings) ? raw.ownerSettings.filter(function (x) { return x && x.id === HD.SETTINGS_ID; })[0] || null : null; } catch (e) { return null; }
  }
  function planRead() { return memoRead('planBlocks', function () { var r = rawSettingsRecord(); return HB ? HB.readBlocks(r ? r.planBlocks : undefined) : { blocks: [], invalid: [], malformed: false }; }); }
  function blocks() { return planRead().blocks; }
  function nowIso() { return new Date().toISOString(); }
  // One dispatcher: v2.1 slot ids go to HyroxPlan exactly as before; block slot ids go to HyroxBlocks (activated blocks only).
  var PL = {
    isB: function (id) { return !!HB && HB.isBlockSlotId(id); },
    slotById: function (id) { return HP.slotById(id) || (HB && HB.isBlockSlotId(id) ? HB.slotById(id, blocks()) : null); },
    slotStatus: function (id, sessions, events) { return PL.isB(id) ? (HB.slotStatus(blocks(), id, sessions) || { code: 'NOT_LOGGED', session: null, omission: null }) : HP.slotStatus(id, sessions, events); },
    omissionFor: function (id, events) { if (!PL.isB(id)) return HP.omissionFor(id, events); var b = HB.blockOfSlot(id, blocks()); return b ? HB.omissionFor(b, id) : null; },
    rescheduleCheck: function (id, date, sessions, events, t) { return PL.isB(id) ? HB.rescheduleCheck(blocks(), id, date, sessions, t) : HP.rescheduleCheck(id, date, sessions, events, t); },
    skipAdvice: function (id, sessions, events, t) { return PL.isB(id) ? HB.skipAdvice(blocks(), id, sessions, t) : HP.skipAdvice(id, sessions, events, t); },
    rescheduledOn: function (date, sessions) { return HP.rescheduledOn(date, sessions).concat(HB ? HB.rescheduledOn(date, sessions, blocks()) : []); },
    plannedOn: function (date, events) { return HP.plannedOn(date, events).concat(HB ? HB.plannedOn(date, blocks()) : []); },
    templateBlocks: function (slot) { return PL.isB(slot.id) ? HB.templateBlocks(slot) : HP.templateBlocks(slot.type, slot.week); },
    variantPrescription: function (id, variant) { if (!PL.isB(id)) return callOpt(HP, 'variantPrescription', [id, variant]); var sl = PL.slotById(id); return sl ? callOpt(HB, 'variantPrescription', [sl, variant]) : undefined; },
    blockStatus: function (d) { return HB ? HB.blockStatus(d, blocks()) : null; }
  };
  // Every plan-block write: fresh re-read of the stored settings record, only planBlocks changes, read-back verified.
  function blocksWrite(fn, opts) {
    var r;
    dropReadMemo();
    try { r = HB.writeBlocks(store, HD, today(), fn, opts); } catch (e) { r = { ok: false, errors: { _: 'Unexpected error.' } }; }
    dropReadMemo();
    if (r.ok) { toast((r.text || 'Saved.') + ' Saved on this device (verified by read-back).'); extSaved(); }
    else toast('Not saved: ' + errorsText(r.errors) + ' Nothing was changed.', true);
    refresh();
    return r;
  }
  var FIELD_NAMES = { steps: 'steps', sleepH: 'sleep hours', sleepQuality: 'sleep quality', soreness: 'soreness', pain: 'pain', readiness: 'readiness', rhr: 'resting HR',
    footPain: 'first-step foot pain', stairKneePain: 'stair knee pain', limp: 'limp', stepTargetOverride: 'step target override', stepsSource: 'step source', distanceKm: 'distance', effort: 'effort', eatenFraction: 'amount eaten' };
  function shownValue(p) { return p.valueType === 'missing' ? 'nothing' : p.valueType === 'null' ? 'empty' : p.valueType === 'string' ? '"' + p.value + '"' : String(p.value); }
  // "pain: stored 14 (must be a number from 0 to 10)" for each bad field of a record.
  function problemsText(problems) {
    return (problems || []).map(function (p) { return (FIELD_NAMES[p.field] || p.field) + ': stored ' + shownValue(p) + ' (' + p.rule + ')'; }).join('; ');
  }
  function storedDamage(rec) { return rec && rec._storedDamaged ? rec._storedDamaged : null; }
  function legacy(t) { return memoRead('l:' + t, function () { try { return store.list(t); } catch (e) { return []; } }); }
  function allMeals() { return memoRead('allMeals', function () { return recs('meals').concat(legacy('nutrition').map(HN.legacyToMeal)); }); }
  function settings() {
    try { return store.settings(); } catch (e) {
      return { stored: false, rhrBaselineBpm: HD.DEFAULT_SETTINGS.rhrBaselineBpm, rhrBaselineSource: 'OWNER_DEFAULT', stepBaselineMode: 'AUTO', stepBaselineManual: null, record: null };
    }
  }
  // P1.1: display/input unit for body weight. Stored weights are always kg; anything but a saved 'lb' means kg.
  // (Read through the per-update memo: one settings read per screen update, dropped after every save.)
  function wUnit() { return memoRead('wUnit', function () { return HM ? HM.unitFromSettings(settings().record) : 'kg'; }); }
  function wText(kg) { return HM ? HM.weightText(kg, wUnit()) : fmt(kg) + ' kg'; }
  // Returns ctx(date) for HW.stepTarget, reading storage once.
  function stepContext() {
    var sessions = recs('sessions'), events = recs('planEvents'), dailies = recs('daily'), walks = recs('walks'), set = settings();
    var recent = sessions.map(function (s) { var sl = s.planSlotId ? PL.slotById(s.planSlotId) : null; return { date: s.date, status: s.status, rpe: s.rpe, type: sl ? sl.type : null }; });
    return function (date) {
      return { dailies: dailies, walks: walks, sessions: sessions, settings: set, recentSessions: recent,
        plannedToday: PL.plannedOn(date, events).length + PL.rescheduledOn(date, sessions).length };
    };
  }
  // Earliest date anything was recorded; days before it are never asked about.
  function firstUseDate() {
    var min = null;
    function see(list) { list.forEach(function (r) { if (r && typeof r.date === 'string' && (min === null || r.date < min)) min = r.date; }); }
    ['sessions', 'meals', 'body', 'daily', 'walks', 'dayStates'].forEach(function (t) { see(recs(t)); });
    ['weight', 'workouts', 'nutrition'].forEach(function (t) { see(legacy(t)); });
    return min;
  }

  // ---------- tabs ----------
  var currentTab = 'today', addMode = 'meal';
  function showTab(name) {
    // Claude P11 review: an UNTOUCHED dedicated logger closes when the owner leaves it by the tab bar, so the Add tab
    // shows its normal Meal / Workout / Body choices again. Anything typed, chosen or analysed keeps it open (Back asks).
    if (currentTab === 'add' && name !== 'add' && logCtx && !mealDirty()) { logCtx = null; resetMealDraft(prefPath); renderAdd(); }
    // C-04 (Claude 11.2 review): leaving Today clears the "just saved" marker; Today is redrawn (hidden) so it is gone on return.
    if (name !== currentTab) closeoutMsg = null; // P1.3: a closeout message belongs to the screen it was shown on
    if (name !== 'settings') ce = null; // Sprint D: leaving Settings drops any prepared snapshot and the selection
    var clearMark = name !== 'add' && !!diaryJustSaved;
    if (clearMark) diaryJustSaved = null;
    currentTab = name;
    ['today', 'add', 'history', 'trends', 'settings'].forEach(function (t) {
      $('panel-' + t).hidden = t !== name;
      $('tab-' + t).setAttribute('aria-selected', t === name ? 'true' : 'false');
      $('tab-' + t).classList.toggle('active', t === name);
    });
    if (typeof syncLogger === 'function') syncLogger();
    if (clearMark) { try { renderDiary(); } catch (e) { /* the diary redraws on its next refresh */ } }
    window.scrollTo(0, 0);
  }
  function showAddMode(mode) {
    addMode = mode;
    Array.prototype.forEach.call(document.querySelectorAll('[data-add-mode]'), function (s) { s.hidden = s.getAttribute('data-add-mode').split(' ').indexOf(mode) === -1; });
    Array.prototype.forEach.call(document.querySelectorAll('.seg'), function (b) {
      var on = b.getAttribute('data-mode') === mode; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderAdd();
  }
  function go(tab, mode) { if (mode) showAddMode(mode); showTab(tab); }

  // ================= TODAY =================
  // Phase 8 (owner request 14 Nov 2026): Today is a quiet daily dashboard. Above the fold: date and Week X/4, today's
  // workout, readiness status, steps, confirmed nutrition. Triggered safety warnings stay prominent (today-alerts).
  // Everything else - the engineering explanations, source citations, 76-bpm caveat, RHR arithmetic, 10k gate,
  // multipliers and cascade text - is unchanged but sits under "Why? Detailed guidance"; the 4-week calendar is
  // under "Full plan". Display only: no threshold, calculation, classification or safety rule changed here.
  var whyOpen = false, planOpen = false;
  function renderToday() {
    var root = $('today-root'); root.replaceChildren();
    var d = today(), bs = HP.blockStatus(d), events = recs('planEvents'), sessions = recs('sessions');
    var bb = PL.blockStatus(d); // Phase 12: non-null only on a later-block date (active block day, or a gap before an activated block)
    var set = settings();
    var r = HW.readiness(d, recs('daily'), set);
    var alerts = h('section', { class: 'alerts', testid: 'today-alerts', role: 'region', 'aria-label': 'Warnings for today' });

    // ---- 1. date, Week X/4, today's workout ----
    var weekLbl = bb && bb.active ? bb.label + ' · Week ' + bb.week + '/4' : bs.active && bs.week >= 1 ? 'Week ' + bs.week + '/4' : bs.active ? 'Day 0' : d > HP.BLOCK_END ? 'no active block' : 'Week 1 starts ' + HP.humanShort(HP.BLOCK_START);
    var c = card(fmtDate(d) + ' · ' + weekLbl, 'today-card');
    if (bb) c.appendChild(h('p', { class: bb.active ? 'hint' : 'note note-warn', testid: 'block-status',
      text: bb.active ? bb.label + (bb.deload ? ' · deload week' : '') + ' · content approved by you · not medical clearance' : bb.text }));
    else c.appendChild(h('p', { class: bs.active ? 'hint' : 'note note-warn', testid: 'block-status',
      text: bs.active && bs.week >= 1 ? 'Block ' + HP.PLAN_VERSION + ' · conditional approval, not medical clearance' : bs.text }));
    if (bb && bb.active) {
      blockToday(c, alerts, d, bb, sessions);
    } else if (bs.active && bs.week >= 1) {
      var eff = HP.effectiveWeek(bs.week, events);
      var day = eff.days.filter(function (x) { return x.date === d; })[0];
      var wo = Array.isArray(eff.weekendOptions) ? eff.weekendOptions.filter(function (o) { return o.date === d; })[0] : null;
      if (!day) c.appendChild(h('p', { class: 'muted spaced', testid: 'today-weekend', text: (wo ? (wo.available ? wo.text : 'No optional Saturday session this week (v2.1: from Week 2).')
        : eff.weekend && eff.weekend.date === d ? eff.weekend.text : 'Weekend: optional activity only.') + ' Not counted in the 20 programmed slots, and not a gym make-up for a missed weekday session.' }));
      else {
        day.show.forEach(function (x) { c.appendChild(slotRow(x.slot, x.movedFrom, sessions, events, null, { today: true })); });
        day.omitted.forEach(function (o) { c.appendChild(omittedRow(o, sessions, events, 'today-omitted')); });
        if (!day.show.length && !day.omitted.length) c.appendChild(h('p', { class: 'muted', text: 'Session moved by source cascade.' }));
      }
      HP.rescheduledOn(d, sessions).forEach(function (sl) { c.appendChild(slotRow(sl, null, sessions, events, 'Rescheduled to today by you. Original plan date: ' + fmtDate(sl.date) + '.', { today: true })); });
      if (eff.unresolved) alerts.appendChild(h('p', { class: 'note note-warn', text: eff.unresolved, testid: 'cascade-unresolved' }));
      HP.cascadeConflicts(bs.week, sessions, events).forEach(function (x) { alerts.appendChild(h('p', { class: 'note note-warn', testid: 'cascade-conflict', text: x.text })); });
    } else if (bs.active) {
      c.appendChild(h('p', { class: 'muted', text: 'No session today. Week 1 starts ' + fmtDate(HP.BLOCK_START) + '.' }));
    }
    var load = callOpt(HP, 'dayLoad', [d, sessions, events]);
    if (load && load.flag === 'TWO_DEMANDING_SESSIONS_LOGGED') alerts.appendChild(h('p', { class: 'note note-warn', testid: 'today-two-demanding', text: 'Two demanding sessions are logged today. Nothing was blocked or changed; v2.1 says never stack two hard sessions, so put recovery first.' }));
    var dr = loadDraft();
    if (dr) c.appendChild(workoutDraftNote(dr));
    root.appendChild(c);
    var mdr = loadMealDraft();
    if (mdr) root.appendChild(mealDraftNote(mdr, 'today'));

    // ---- 2. readiness / steps / nutrition (one line each) ----
    var ds = dayStateFor(d);
    root.appendChild(dashboard(d, r, ds));

    // ---- 3. triggered safety warnings: prominent, never folded away ----
    if (r.flags.length) alerts.appendChild(h('div', { class: 'note note-warn', testid: 'readiness-flags-box' }, h('p', { class: 'list-heading', text: 'Readiness flags' }),
      h('ul', { class: 'flags' }, r.flags.map(function (f) { return h('li', { text: f, testid: 'readiness-flag' }); }))));
    if (r.painNote) alerts.appendChild(h('p', { class: 'note note-warn', text: r.painNote }));
    var todayRec = recs('daily').filter(function (x) { return x.date === d; })[0] || null, dmg = storedDamage(todayRec);
    if (dmg || (r.invalid && r.invalid.length)) {
      alerts.appendChild(h('div', { class: 'note note-warn', testid: 'today-invalid-values', role: 'status' },
        h('p', { text: 'Today\'s check-in has ' + (dmg ? 'a stored value that is not valid' : 'a value marked invalid') + ' — ' + (dmg ? problemsText(dmg.problems) : r.invalid.map(function (k) { return FIELD_NAMES[k] || k; }).join(', ')) +
          '. It is treated as unknown (never as 0 or as fine). Your other values are still shown and used. Nothing was changed or deleted.' }),
        r.painUnknown ? h('p', { testid: 'today-pain-unknown', text: r.painUnknown }) : null,
        h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Review and correct in the check-in', testid: 'today-invalid-fix', onclick: function () { go('add', 'daily'); } })));
    }
    var dnf = doNotForceNote(d);
    if (dnf) alerts.appendChild(dnf);
    if (ds.pendingCount) alerts.appendChild(h('p', { class: 'note note-warn', testid: 'today-pending', text: ds.pendingCount + ' meal(s) marked "I ate this" but not confirmed — not counted; full-day status suppressed.' }));
    if (alerts.childNodes.length) root.appendChild(alerts);
    // P0 (owner decision 22 Nov 2026): the meal diary is no longer a second card on Today. The Nutrition row above is the
    // only meal surface here; the diary lives on Add > Meal (opened by "Log meal").

    // ---- 4. on demand: Why? / Detailed guidance ----
    var why = h('details', { class: 'fold', testid: 'today-why', ontoggle: function (e) { whyOpen = e.target.open; } }, h('summary', { text: 'Why? Detailed guidance', testid: 'today-why-toggle' }));
    if (whyOpen) why.open = true;
    why.appendChild(h('p', { class: 'hint', testid: 'block-status-detail', text: bb ? bb.text : bs.text }));
    var rc = card('Readiness', 'readiness-card');
    rc.appendChild(h('p', { testid: 'readiness-guidance', text: r.guidance }));
    if (r.missing.length) rc.appendChild(h('p', { class: 'muted', testid: 'readiness-missing', text: 'Unknown (not assumed fine): ' + r.missing.join(', ') + '.' }));
    rc.appendChild(h('p', { class: 'hint', testid: 'rhr-baseline', text: 'Resting-HR baseline — configured: ' + set.rhrBaselineBpm + ' bpm (' +
      (set.rhrBaselineSource === 'OWNER_SET' ? 'set by you' : 'owner default') + ', a setting not a measurement; change in Settings) · observed 7-day mean: ' +
      (r.rhr.observed.valid ? r.rhr.observed.value + ' bpm (n=' + r.rhr.observed.n + ')' : 'not available (' + r.rhr.observed.n + ' of 4 readings needed; not estimated)') +
      '.' }));
    rc.appendChild(rhrComparisons(r.rhr));
    rc.appendChild(stepsBlock(d, { skipDoNotForce: true }));
    rc.appendChild(h('p', { class: 'hint', text: r.safety }));
    why.appendChild(rc);
    var nc = card('Nutrition today', 'today-nutrition');
    nc.appendChild(h('p', {}, badge(ds.label, ds.code === 'D5' || ds.code === 'DF' ? 'ok' : 'info', 'today-day-state')));
    nc.appendChild(subtotalLine(ds, 'today-subtotal'));
    nc.appendChild(h('p', { class: 'hint', text: ds.caveat }));
    // P1.3: with the coach on and a confirmed target in force for this date, that target is the reference; otherwise the
    // provisional text exactly as before (coach off or nothing confirmed: unchanged).
    var tref = coachRef(d), useRef = coachOn() && tref.origin !== 'PROVISIONAL';
    if (coachRead().unavailable) nc.appendChild(h('p', { class: 'note note-warn', testid: 'today-coach-unavailable', text: 'Nutrition Coach did not load, so your confirmed target cannot be shown. The reference below is the provisional one, not your target. Reload the page; nothing was changed.' }));
    nc.appendChild(h('p', { class: 'hint', testid: 'today-target', text: ds.fullDay
      ? (useRef ? 'Your confirmed target ' + n0(tref.kcal) + ' kcal / ' + n0(tref.proteinG) + ' g protein (' + (tref.origin === 'COMPUTED' ? 'computed estimate you confirmed' : 'entered by you') + ', since ' + fmtDate(tref.effectiveDate) + '). An estimate, not a measured maintenance.'
        : 'Provisional example target ~' + HN.PROVISIONAL.kcal + ' kcal / ~' + HN.PROVISIONAL.proteinG + ' g protein. ' + HN.PROVISIONAL.note)
      : 'Target comparison hidden: this is not a complete, quantified day.' }));
    why.appendChild(nc);
    root.appendChild(why);

    // ---- 5. on demand: Full plan ----
    root.appendChild(planCalendar(sessions, events));
    var pf = plannerFold(); if (pf) root.appendChild(pf);
    var bn = backupHint(); if (bn) root.appendChild(bn);
  }
  // P0: quiet backup reminder. One muted line at the very end of Today, only when records exist and this device has no
  // note of a backup download in the last 7 days. It states what the app knows, never that a backup exists or is missing.
  var BACKUP_HINT_DAYS = 7;
  function backupHint() {
    var first = firstUseDate();
    if (first === null) return null;
    var note = null;
    try { note = window.HyroxBackupNote ? window.HyroxBackupNote.read() : null; } catch (e) { note = null; }
    if (note && note.days < BACKUP_HINT_DAYS) return null;
    if (!note && first > HP.addDays(today(), -BACKUP_HINT_DAYS)) return null;
    return h('p', { class: 'hint backup-hint', testid: 'today-backup-note' },
      h('span', { text: note ? 'Last backup download started here ' + note.days + ' days ago. ' : 'No backup download is recorded on this device. ' }),
      h('button', { type: 'button', class: 'link-btn', text: 'Open Backup in Settings', testid: 'today-backup-open', onclick: function () { go('settings'); renderSettings(); var b = document.getElementById('export-btn'); if (b && b.scrollIntoView) b.scrollIntoView({ block: 'center' }); } }));
  }
  // Phase 12: today's row(s) on a Block 2 day. Same row component and rules as Block 1, scoped to this block's own events.
  function blockToday(c, alerts, d, bb, sessions) {
    var b = HB.blockById(blocks(), bb.blockId), eff = HB.effectiveWeek(b, bb.week);
    var day = eff.days.filter(function (x) { return x.date === d; })[0];
    var wo = eff.weekendOptions.filter(function (o) { return o.date === d; })[0];
    if (!day) c.appendChild(h('p', { class: 'muted spaced', testid: 'today-weekend', text: (wo ? wo.text : 'Weekend: optional activity only.') + ' Not counted in the 20 programmed slots, and not a gym make-up for a missed weekday session.' }));
    else {
      if (day.possibleClosure) c.appendChild(h('p', { class: 'note', testid: 'today-possible-closure', text: 'Possible gym closure today (' + day.possibleClosure + '). Only a flag: nothing was marked missed or cancelled. If the gym is closed, ' + (day.day === 'FRI' ? 'skip it (no weekend make-up).' : 'log it as skipped and choose what happens.') }));
      day.show.forEach(function (x) { c.appendChild(slotRow(x.slot, x.movedFrom, sessions, [], null, { today: true })); });
      day.omitted.forEach(function (o) { c.appendChild(omittedRow(o, sessions, [], 'today-omitted')); });
      if (!day.show.length && !day.omitted.length) c.appendChild(h('p', { class: 'muted', text: 'Session moved by source cascade.' }));
    }
    HB.rescheduledOn(d, sessions, [b]).forEach(function (sl) { c.appendChild(slotRow(sl, null, sessions, [], 'Rescheduled to today by you. Original plan date: ' + fmtDate(sl.date) + '.', { today: true })); });
    if (eff.unresolved) alerts.appendChild(h('p', { class: 'note note-warn', text: eff.unresolved, testid: 'cascade-unresolved' }));
    HB.cascadeConflicts(b, bb.week, sessions).forEach(function (x) { alerts.appendChild(h('p', { class: 'note note-warn', testid: 'cascade-conflict', text: x.text })); });
  }

  // The v2.1 "do not force the reference goal" warning (data-layer status DO_NOT_FORCE). Shown prominently when triggered.
  function doNotForceNote(d) {
    var ref = stepReference(d);
    if (ref.goal === null || ref.status !== 'DO_NOT_FORCE' || !ref.doNotForce.length) return null;
    var DNF = { READINESS_GATE_FAILED: 'a readiness check item failed', READINESS_GATE_UNKNOWN: 'Week 4 tolerance cannot be confirmed (readiness check items not recorded)',
      PAIN_OVER_3: 'pain above 3/10 (v2.1 §8)', READINESS_FLAGS: 'a readiness flag is raised', TOUGH_TRAINING_DAY: 'a demanding session is logged today' };
    return h('p', { class: 'note note-warn', testid: 'today-step-do-not-force', text: 'Recovery first — do not force the reference goal today: ' + ref.doNotForce.map(function (c) { return DNF[c] || String(c); }).join('; ') + '. Reduce activity to tolerance.' });
  }

  // P6 readiness: each missing/invalid input of HW.readiness() as {id, text, field}; field = check-in input to focus.
  // No new rule: same r.missing / r.invalid the Readiness card uses. Unknown stays unknown.
  function readinessGaps(r) {
    var out = [];
    (r.missing || []).forEach(function (m) {
      if (m === 'sleep') out.push({ id: 'sleepH', field: 'sleepH', text: 'Sleep hours — not recorded' });
      else if (m === 'soreness') out.push({ id: 'soreness', field: 'soreness', text: 'Soreness — not recorded' });
      else if (m === 'resting HR') out.push({ id: 'rhr', field: 'rhr', text: 'Resting HR — not recorded' });
      else if (/baseline/.test(m)) out.push({ id: 'rhr-baseline', field: 'rhr', text: 'Resting-HR baseline — none yet (needs 4 readings in the prior 7 days; enter resting HR)' });
      else out.push({ id: 'other-' + out.length, field: null, text: m + ' — not recorded' });
    });
    (r.invalid || []).forEach(function (k) { out.push({ id: 'invalid-' + k, field: k, text: (FIELD_NAMES[k] || k).replace(/^./, function (c) { return c.toUpperCase(); }) + ' — invalid value, counts as unknown' }); });
    return out;
  }
  function jumpToDaily(field) {
    go('add', 'daily');
    var target = (field && document.querySelector('[data-testid="daily-' + field + '"]')) || document.querySelector('[data-testid="daily-date"]');
    if (!target) return;
    try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    try { target.scrollIntoView({ block: 'center' }); } catch (e) { /* older browsers */ }
  }

  // Today dashboard (Phase 8): one quiet line each for readiness, steps and nutrition. Display only: every figure comes
  // from the same functions as the detail cards. Unknown is shown as unknown, never as 0, and a missing check-in is
  // never presented as "no problem". The row ids keep the glance-* test ids.
  var SHORT_GAP = { sleepH: 'Sleep', soreness: 'Soreness', rhr: 'Resting HR', 'rhr-baseline': 'Resting-HR baseline' };
  function dashboard(d, r, dstate) {
    function row(key, tone, testid) { return h('div', { class: 'dash-row' + (tone ? ' dash-' + tone : ''), testid: testid || 'glance-' + key }); }
    var box = h('section', { class: 'card dash', testid: 'today-glance', 'aria-label': 'Today at a glance' });

    // readiness
    var unknown = r.missing.length + (r.invalid ? r.invalid.length : 0), gaps = readinessGaps(r);
    var rr = row('readiness', r.flags.length >= 2 ? 'bad' : r.flags.length === 1 || unknown ? 'warn' : 'ok');
    var names = [];
    gaps.forEach(function (g) { var nm = (SHORT_GAP[g.id] || (g.id.indexOf('invalid-') === 0 ? (FIELD_NAMES[g.field] || g.field) + ' (invalid)' : g.id.replace(/^other-\d+$/, 'other')));
      nm = nm.charAt(0).toLowerCase() + nm.slice(1); if (g.id === 'rhr-baseline' && names.indexOf('resting HR') !== -1) return; if (names.indexOf(nm) === -1) names.push(nm); });
    var rtext;
    if (r.flags.length) rtext = 'Readiness: ' + r.flags.length + (r.flags.length === 1 ? ' flag — consider less volume' : ' flags — easy movement only') + (names.length ? '; also log ' + names.join(', ') : '') + '.';
    else if (unknown) rtext = (unknown >= 3 && !r.invalid.length ? 'Readiness not checked' : 'Readiness incomplete') + ' — log ' + names.join(', ');
    else rtext = 'Readiness: No flags in the recorded data.';
    rr.appendChild(h('span', { class: 'dash-label', text: 'Readiness' }));
    rr.appendChild(document.createTextNode(' '));
    rr.appendChild(h('span', { class: 'dash-text', text: rtext, testid: 'glance-readiness-text' }));
    if (gaps.length) {
      // each missing / invalid input is a link that opens the check-in and focuses that field (P6)
      var ul = h('ul', { class: 'chip-row', testid: 'glance-readiness-missing', 'aria-label': gaps.length + (gaps.length === 1 ? ' input needed' : ' inputs needed') });
      ul.appendChild(h('li', { class: 'chip-lead', text: gaps.length + (gaps.length === 1 ? ' input needed:' : ' inputs needed:') }));
      gaps.forEach(function (g) {
        var short = SHORT_GAP[g.id] || g.text; // an invalid value keeps its full wording ("Pain — invalid value, counts as unknown")
        ul.appendChild(h('li', {}, h('button', { type: 'button', class: 'chip', text: short, testid: 'glance-missing-' + g.id,
          'data-input': g.id, 'data-target': 'daily-' + (g.field || 'date'),
          'aria-label': g.text + ' — open the daily check-in at this field', onclick: function () { jumpToDaily(g.field); } })));
      });
      ul.appendChild(h('li', {}, h('button', { type: 'button', class: 'chip chip-plain', text: 'Daily check-in', testid: 'today-checkin', onclick: function () { go('add', 'daily'); } })));
      rr.appendChild(ul);
    }
    if (!gaps.length) rr.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small dash-btn', text: 'Daily check-in', testid: 'today-checkin', onclick: function () { go('add', 'daily'); } }));
    box.appendChild(rr);

    // steps: a recorded daily total vs a partial lower bound (walk / run steps only)
    var ctx = stepContext()(d);
    var ds = HW.daySteps(d, { dailies: ctx.dailies, walks: ctx.walks, sessions: recs('sessions') });
    var sr = row('steps', null);
    sr.appendChild(h('span', { class: 'dash-label', text: 'Steps' }));
    sr.appendChild(h('span', { class: 'dash-text', testid: 'glance-steps-text',
      text: ds.total === null ? 'Steps not recorded (unknown)' : ds.complete ? 'Steps ' + n0(ds.total) + ' (daily total)' : 'Steps ' + n0(ds.total) + '+ recorded (daily total unknown)' }));
    sr.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small dash-btn', text: qsteps.open ? 'Close' : 'Log steps', testid: 'today-log-steps', 'aria-expanded': qsteps.open ? 'true' : 'false',
      onclick: function () { qsteps.open = !qsteps.open; if (qsteps.open) { qsteps.mode = 'TODAY'; qsteps.date = null; qsteps.msg = null; } renderToday(); } }));
    // P11.2 part 2 (healthy habits): the day's existing guidance target (adaptive or your override), never a new target.
    var stT = callOpt(HW, 'stepTarget', [d, ctx]);
    if (stT && stT.target !== null) sr.appendChild(h('span', { class: 'dash-sub', testid: 'glance-steps-target',
      text: 'Target ' + n0(stT.target) + (stT.source === 'OVERRIDE' ? ' (your override)' : ' (adaptive suggestion)') + (stT.met === true ? ' · reached' : stT.met === false ? ' · not reached yet' : ' · progress unknown') }));
    if (qsteps.open) sr.appendChild(quickStepsPanel());
    box.appendChild(sr);
    box.appendChild(exerciseRow(d));
    box.appendChild(weightRow(d));

    // nutrition: confirmed subtotal only
    var kc = dstate.subtotal.kcal;
    var nr = row('nutrition', dstate.fullDay || dstate.fastDay ? 'ok' : null);
    nr.appendChild(h('span', { class: 'dash-label', text: 'Nutrition' }));
    nr.appendChild(h('span', { class: 'dash-text', testid: 'glance-nutrition-text',
      text: dstate.fastDay ? 'Nutrition: confirmed fast day'
        : kc.value === null ? 'Nutrition: nothing confirmed (unknown)'
        : 'Nutrition ' + n0(kc.value) + (kc.mealsWithUnknown ? '+' : '') + ' kcal confirmed' + (dstate.fullDay ? ' — complete day' : ' so far — not full day') + '.' }));
    if (kc.value !== null && !dstate.fastDay) nr.appendChild(macroGrid(dstate, 'glance-macros'));
    // P1.3 Delivery D: one compact coaching status line (coach on only) about the last COMPLETED week, never about today.
    if (coachOn()) nr.appendChild(coachStatusLine(d));
    var first = firstUseDate(), yd = HP.addDays(d, -1);
    if (first !== null && yd >= first) {
      var ys = dayStateFor(yd);
      if (ys.fastQuestionOpen) nr.appendChild(fastQuestion(yd, ys, attestationFor(yd), 'today-fast-question'));
    }
    nr.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn btn-primary', text: 'Log meal', testid: 'today-add-meal', onclick: function () { openDiary(today()); } }),
      h('button', { type: 'button', class: 'btn btn-secondary', text: 'Photo meal', testid: 'today-photo-meal', onclick: function () { openLogger(null, today(), 'PHOTO_AI'); } })));
    // P1.3 Delivery A: the existing day closeout ("All food & drink entered" / "Day is incomplete") for the DISPLAYED Qatar
    // date, directly beneath the compact Nutrition section. Same handlers and rules as History (one shared component).
    nr.appendChild(closeoutControls(d, dstate, attestationFor(d), { home: true }));
    box.appendChild(nr);
    return box;
  }
  // ---- P11.2 part 2: healthy-habit rows on Today (latest valid value, its date, status; one tap to the existing form) ----
  // Exercise = sessions and walks RECORDED for the day (no calorie burn, no automatic calorie credit, no inferred load).
  var SESSION_WORD = { COMPLETED: 'completed', PARTIAL: 'partial', IN_PROGRESS: 'in progress', NOT_STARTED: 'not started', SKIPPED: 'skipped' };
  function exerciseRow(d) {
    var ss = recs('sessions').filter(function (x) { return x.date === d; }), ws = recs('walks').filter(function (x) { return x.date === d; });
    var parts = [];
    ss.forEach(function (x) { parts.push((x.title || 'Session') + ' ' + (SESSION_WORD[x.status] || String(x.status || '').toLowerCase()) + (typeof x.durationMin === 'number' ? ' (' + n0(x.durationMin) + ' min)' : '')); });
    if (ws.length) {
      var mins = ws.reduce(function (a, w) { return a + (typeof w.durationMin === 'number' ? w.durationMin : 0); }, 0);
      parts.push(ws.length + (ws.length === 1 ? ' walk' : ' walks') + (mins ? ' (' + n0(mins) + ' min)' : ''));
    }
    var done = ss.some(function (x) { return x.status === 'COMPLETED'; });
    var row = h('div', { class: 'dash-row' + (done ? ' dash-ok' : ''), testid: 'glance-exercise' });
    row.appendChild(h('span', { class: 'dash-label', text: 'Exercise' }));
    row.appendChild(h('span', { class: 'dash-text', testid: 'glance-exercise-text', text: parts.length ? parts.join(' · ') : 'Nothing logged today (not assumed rest)' }));
    row.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small dash-btn', text: 'Log workout', testid: 'glance-exercise-log', 'aria-label': 'Log a workout or walk', onclick: function () { go('add', 'workout'); } }));
    return row;
  }
  // Weight = the latest MEASURED entry (classic weight list, kg as stored), with its own date; never carried forward as today's.
  function weightRow(d) {
    var list = legacy('weight').filter(function (w) { return w && typeof w.kg === 'number' && isFinite(w.kg) && typeof w.date === 'string' && w.date <= d; });
    list.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    var last = list[0] || null;
    var row = h('div', { class: 'dash-row', testid: 'glance-weight' });
    row.appendChild(h('span', { class: 'dash-label', text: 'Weight' }));
    row.appendChild(h('span', { class: 'dash-text', testid: 'glance-weight-text', text: last ? wText(last.kg) + ' · ' + (last.date === d ? 'today' : 'last measured ' + fmtDate(last.date)) : 'No weight recorded' }));
    row.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small dash-btn', text: 'Log weight', testid: 'glance-weight-log', onclick: function () {
      go('add', 'classic'); var k = document.getElementById('weight-kg'); if (k) { try { k.focus({ preventScroll: false }); } catch (e) { k.focus(); } }
    } }));
    return row;
  }
  // P10: Quick "Log steps" on Today. Saves ONLY the whole-day step total of the chosen day, through the same validated
  // store path and record identity as the daily check-in; every other value of that day is kept as it is.
  var qsteps = { open: false, mode: 'TODAY', date: null, msg: null };
  function quickStepsPanel() {
    var td = today(), yd = AI.addDaysIso(td, -1);
    var dateFor = function () { return qsteps.mode === 'TODAY' ? td : qsteps.mode === 'YESTERDAY' ? yd : (qsteps.date || ''); };
    var p = h('div', { class: 'quick-steps', testid: 'quick-steps', role: 'group', 'aria-label': 'Log steps' });
    var seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Which day' });
    [['TODAY', 'Today'], ['YESTERDAY', 'Yesterday'], ['CHOOSE', 'Choose date']].forEach(function (m) {
      var on = qsteps.mode === m[0];
      seg.appendChild(h('button', { type: 'button', class: 'seg' + (on ? ' active' : ''), 'aria-pressed': on ? 'true' : 'false', text: m[1], testid: 'qsteps-' + m[0].toLowerCase(),
        onclick: function () { qsteps.mode = m[0]; qsteps.msg = null; if (m[0] === 'CHOOSE' && !qsteps.date) qsteps.date = yd; renderToday(); } }));
    });
    p.appendChild(seg);
    if (qsteps.mode === 'CHOOSE') p.appendChild(field('Date', h('input', { type: 'date', value: qsteps.date || '', max: td, testid: 'qsteps-date',
      onchange: function () { qsteps.date = this.value; qsteps.msg = null; renderToday(); } })));
    var d = dateFor();
    var ex = d ? recs('daily').filter(function (x) { return x.date === d; })[0] || null : null;
    var cur = ex && ex.steps && ex.steps.state === 'OBSERVED' && typeof ex.steps.value === 'number' ? ex.steps.value : null;
    var whole = d ? HW.daySteps(d, { dailies: recs('daily'), walks: recs('walks'), sessions: recs('sessions') }) : null;
    p.appendChild(h('p', { class: 'hint', testid: 'qsteps-existing', text: !d ? 'Choose a date.' : d > td ? 'That date is in the future.'
      : fmtDate(d) + ': ' + (cur !== null ? 'saved daily total ' + n0(cur) + ' steps.' : ex && ex.steps && ex.steps.state && ex.steps.state !== 'MISSING' ? 'daily total ' + ex.steps.state.toLowerCase().replace('_', ' ') + '.' : 'no daily total saved (missing, not zero).')
        + (whole && !whole.complete && whole.total !== null ? ' Walk/run steps recorded: ' + n0(whole.total) + ' (a lower bound; a daily total replaces them, it is never added on top).' : '') }));
    var err = h('p', { class: 'form-error', testid: 'qsteps-error', 'aria-live': 'polite', text: qsteps.msg || '' });
    if (storedDamage(ex)) {
      // a damaged check-in is only ever replaced with the owner's explicit approval, in the full check-in
      p.appendChild(h('div', { class: 'note note-warn', testid: 'qsteps-damaged' }, h('p', { text: 'The saved check-in for this date has a value that is not valid, so it cannot be changed here. Open the full check-in to review and approve a correction. Nothing was changed.' }),
        h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Open the check-in', testid: 'qsteps-open-checkin', onclick: function () { dailyDatePreset = d; qsteps.open = false; renderToday(); go('add', 'daily'); } })));
      p.appendChild(err);
      return p;
    }
    var inp = h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', maxlength: '8', placeholder: cur !== null ? 'new total (now ' + n0(cur) + ')' : 'e.g. 8500', testid: 'qsteps-input', 'aria-label': 'Whole-day steps' + (d ? ' for ' + d : '') });
    p.appendChild(field('Whole-day steps (from your phone or watch)', inp));
    var rep = null;
    if (cur !== null) {
      rep = h('input', { type: 'checkbox', testid: 'qsteps-replace' });
      p.appendChild(h('label', { class: 'check' }, rep, h('span', { text: 'Replace the saved ' + n0(cur) + ' with the new total' })));
    }
    var renderedFor = td;
    p.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-small', text: 'Save steps', testid: 'qsteps-save', onclick: function () {
      var now = today();
      if (now !== renderedFor && qsteps.mode !== 'CHOOSE') { qsteps.msg = 'The date changed at midnight (Asia/Qatar). Check the day and save again. Nothing was saved.'; renderToday(); return; }
      var dd = dateFor();
      var fresh = recs('daily').filter(function (x) { return x.date === dd; })[0] || null;
      if (storedDamage(fresh)) { qsteps.msg = 'The saved check-in for this date has an invalid value. Open the full check-in to approve a correction. Nothing was saved.'; renderToday(); return; }
      var r = AI.quickStepsUpdate(fresh, dd, inp.value, now);
      if (!r.ok) { err.textContent = 'Not saved: ' + r.error; return; }
      if (r.previous !== null && !r.changed) { err.textContent = 'Already saved: ' + n0(r.previous) + ' steps. Nothing changed.'; return; }
      if (r.previous !== null && !(rep && rep.checked)) { err.textContent = 'Not saved: tick “Replace the saved ' + n0(r.previous) + '” to change the total. Nothing was changed.'; return; }
      var res = persist('daily', r.rec, err);
      if (res.ok) { qsteps.msg = null; renderToday(); }
    } }));
    p.appendChild(err);
    p.appendChild(h('p', { class: 'hint', text: 'Blank stays missing; type 0 only for a day with no steps. No catch-up targets are set from past days.' }));
    return p;
  }
  // Protein / carbs / fat as three separate, labelled cells (confirmed subtotal; unknown stays unknown).
  function macroGrid(dstate, testid) {
    var g = h('dl', { class: 'macro-cells', testid: testid });
    [['proteinG', 'Protein'], ['carbsG', 'Carbs'], ['fatG', 'Fat']].forEach(function (m) {
      var v = dstate.subtotal[m[0]];
      g.appendChild(h('div', { class: 'macro-cell' }, h('dt', { text: m[1] }), ' ', h('dd', { text: v.value === null ? 'unknown' : fmt(v.value) + ' g' + (v.mealsWithUnknown ? ' +?' : '') })));
    });
    return g;
  }

  // Phase 11.3: fiber and sodium for the day, each on its own line; never a target, never part of kcal/day states.
  function extraLines(d, ds) {
    var all = allMeals(), wrap = h('div', { class: 'diary-extra', testid: 'diary-extra' });
    FSX.KEYS.forEach(function (k) {
      var t = FSX.dayTotal(all, d, k, ds);
      wrap.appendChild(h('p', { class: 'diary-extra-line', testid: 'diary-' + (k === 'fiberG' ? 'fiber' : 'sodium'), 'data-state': t.state, text: FSX.text(t) }));
    });
    return wrap;
  }
  // ================= P11 MEAL DIARY (P0: shown on Add > Meal, no longer on Today) =================
  // Breakfast / Lunch / Dinner / Snacks for one Asia/Qatar calendar date, with the day's confirmed calories and macros
  // (the same qualified semantics as everywhere: only CONFIRMED meals count, unknown is never 0, a partly logged day is
  // never "complete"). diaryDate null = follow today (it moves at midnight); a past date chosen with ‹ stays put.
  var diaryDate = null, diaryOpen = {}, diaryAll = false;
  // Claude 11.2 review (C-04): the "just saved" marker belongs to the moment of return; changing day clears it.
  function setDiaryDate(d) { diaryDate = !d || d >= today() ? null : d; diaryJustSaved = null; }
  function catBadge(m) {
    if (!m || m.legacy) return null;
    if (knownCat(m.mealCategory)) return badge(catName(m.mealCategory), 'muted', 'meal-category-badge');
    if (m.mealCategory !== undefined && m.mealCategory !== null) return badge('Unrecognised category', 'warn', 'meal-category-badge');
    return null;
  }
  function catSubtotal(list) {
    var conf = list.filter(function (m) { return m.lifecycle === 'CONFIRMED'; }), kc = 0, any = false, unk = false;
    conf.forEach(function (m) { var t = HN.mealTotals(m).kcal; if (t.value !== null) { kc += t.value; any = true; } if (t.state === 'PARTIAL' || t.state === 'UNKNOWN') unk = true; });
    return { confirmed: conf.length, pending: list.length - conf.length, kcal: any ? Math.round(kc) : null, unknown: unk };
  }
  function mealName(m) { return m.label || (m.components && m.components[0] && m.components[0].name) || 'Meal'; }
  // P0: outside the diary a meal without a custom name is titled by its diary meal ("Lunch"); display only, nothing is stored.
  function mealTitle(m) { return String(m.label || '').trim() ? m.label : (!m.legacy && knownCat(m.mealCategory) ? catName(m.mealCategory) : 'Meal'); }
  function diaryEntry(m) {
    var t = HN.mealTotals(m).kcal;
    var lc = { DRAFT: 'Draft — not counted', NEEDS_REVIEW: 'Needs review — not counted', CONSUMED_INTENT: 'Not confirmed — not counted', CONFIRMED: null }[m.lifecycle];
    var orphan = m.mealCategory !== undefined && m.mealCategory !== null && !knownCat(m.mealCategory);
    var just = !!diaryJustSaved && m.id === diaryJustSaved;
    return h('li', { class: 'diary-entry' + (just ? ' diary-entry-new' : ''), testid: 'diary-entry', 'data-just-saved': just ? 'true' : null },
      h('div', { class: 'diary-entry-body' },
        h('span', { class: 'diary-entry-name', text: mealName(m) + (m.time ? ' · ' + m.time : '') }),
        h('span', { class: 'diary-entry-meta', testid: 'diary-entry-meta', text: (t.value === null ? 'kcal unknown' : fmt(t.value) + (t.state === 'PARTIAL' ? '+' : '') + ' kcal') + (lc ? ' · ' + lc : '') + (m.legacy ? ' · classic entry' : '') }),
        orphan ? h('span', { class: 'diary-entry-meta', testid: 'diary-entry-orphan', text: 'Saved with a category this version does not recognise; kept as saved.' }) : null),
      m.legacy ? null : h('button', { type: 'button', class: 'btn btn-small btn-secondary diary-edit', text: m.lifecycle === 'CONFIRMED' ? 'Edit' : 'Review', testid: 'diary-entry-edit',
        'aria-label': (m.lifecycle === 'CONFIRMED' ? 'Edit ' : 'Review ') + mealName(m),
        onclick: function () { editMeal(m, { cat: knownCat(m.mealCategory) ? m.mealCategory : null, date: m.date, fixed: true, edit: true }); } }));
  }
  function diaryRow(key, name, list, d, canLog) {
    var k = key.toLowerCase(), open = list.length && (diaryAll || !!diaryOpen[key]), s = catSubtotal(list);
    var sub = !list.length ? 'Not logged'
      : list.length + (list.length === 1 ? ' entry' : ' entries') + ' · ' + (s.confirmed ? (s.kcal === null ? 'kcal unknown' : n0(s.kcal) + (s.unknown ? '+' : '') + ' kcal') : 'none confirmed') +
        (s.pending ? ' · ' + s.pending + ' not confirmed (not counted)' : '');
    var row = h('div', { class: 'diary-row' + (list.length ? '' : ' diary-empty'), testid: 'diary-row-' + k });
    var label = h('span', { class: 'diary-cat' }, h('span', { class: 'diary-cat-name', text: name }), h('span', { class: 'diary-cat-sub', testid: 'diary-sub-' + k, text: sub }));
    var head = h('div', { class: 'diary-head' });
    if (list.length) head.appendChild(h('button', { type: 'button', class: 'diary-toggle', testid: 'diary-toggle-' + k, 'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'diary-list-' + k,
      onclick: function () { diaryOpen[key] = !open; if (open && diaryAll) { diaryAll = false; MEAL_CATS.concat([['UNCAT']]).forEach(function (x) { if (x[0] !== key) diaryOpen[x[0]] = true; }); } renderDiary(); } }, label));
    else head.appendChild(h('div', { class: 'diary-toggle diary-static' }, label));
    if (canLog) head.appendChild(h('button', { type: 'button', class: 'btn btn-small btn-secondary diary-log', text: '+ Log', testid: 'diary-log-' + k,
      'aria-label': 'Log ' + name.toLowerCase() + ' for ' + fmtDate(d), onclick: function () { openLogger(key, d); } }));
    row.appendChild(head);
    if (!canLog) row.appendChild(h('p', { class: 'hint', testid: 'diary-uncat-note', text: 'Meals saved before diary categories, or without one. They count in the day total as before; open one and choose a category to file it.' }));
    if (open) { var ul = h('ul', { class: 'diary-list', id: 'diary-list-' + k }); list.forEach(function (m) { ul.appendChild(diaryEntry(m)); }); row.appendChild(ul); }
    return row;
  }
  // P0: the diary is drawn into its own host on Add > Meal, so its date / open-row changes never rebuild the form below it.
  function renderDiary() { var host = document.getElementById('meal-diary-host'); if (host) host.replaceChildren(mealDiary()); }
  // "Log meal" on Today: the diary for that date (an open logger or unfinished entry is shown as it is, never dropped).
  function openDiary(d) {
    if (!logCtx) setDiaryDate(d);
    go('add', 'meal'); renderAdd();
    focusTestid(logCtx ? 'logger-title' : 'diary-heading');
  }
  function mealDiary() {
    var td = today();
    if (diaryDate !== null && diaryDate >= td) diaryDate = null;
    var d = diaryDate || td, ds = dayStateFor(d), kc = ds.subtotal.kcal;
    var box = h('section', { class: 'card diary', testid: 'meal-diary', 'aria-labelledby': 'diary-heading' });
    box.appendChild(h('div', { class: 'diary-top' }, h('h2', { id: 'diary-heading', tabindex: '-1', text: 'Meals', testid: 'diary-heading' }),
      h('button', { type: 'button', class: 'btn btn-small btn-secondary diary-photo', text: 'Photo meal', testid: 'diary-photo', 'aria-label': 'Photo meal for ' + fmtDate(d), onclick: function () { openLogger(null, d, 'PHOTO_AI'); } }),
      h('button', { type: 'button', class: 'btn btn-small btn-secondary diary-all', text: diaryAll ? 'Compact view' : 'View diary', testid: 'diary-view-all', 'aria-expanded': diaryAll ? 'true' : 'false',
        onclick: function () { diaryAll = !diaryAll; if (!diaryAll) diaryOpen = {}; renderDiary(); } })));
    box.appendChild(h('div', { class: 'diary-nav', role: 'group', 'aria-label': 'Diary date' },
      h('button', { type: 'button', class: 'diary-step', text: '‹', testid: 'diary-prev', 'aria-label': 'Previous day', onclick: function () { setDiaryDate(HP.addDays(d, -1)); diaryOpen = {}; renderDiary(); } }),
      h('p', { class: 'diary-date', testid: 'diary-date', 'aria-live': 'polite' }, h('span', { text: fmtDate(d) + (d === td ? ' · today' : '') }), d !== td ? badge('not today', 'warn', 'diary-not-today') : null),
      h('button', { type: 'button', class: 'diary-step', text: '›', testid: 'diary-next', 'aria-label': 'Next day', disabled: d >= td, onclick: function () { setDiaryDate(HP.addDays(d, 1)); diaryOpen = {}; renderDiary(); } }),
      d !== td ? h('button', { type: 'button', class: 'btn btn-small btn-secondary', text: 'Today', testid: 'diary-today', onclick: function () { diaryDate = null; diaryOpen = {}; renderDiary(); } }) : null));
    box.appendChild(h('p', { class: 'diary-total', testid: 'diary-total', text: ds.fastDay ? 'Confirmed fast day (0 kcal recorded).'
      : kc.value === null ? 'Nothing confirmed for this day — calories unknown, not 0.'
      : n0(Math.round(kc.value)) + (kc.mealsWithUnknown ? '+' : '') + ' kcal confirmed' + (ds.fullDay ? ' — complete day.' : ' so far — not a full day.') }));
    if (kc.value !== null && !ds.fastDay) box.appendChild(macroGrid(ds, 'diary-macros'));
    if (FSX && ds.confirmedCount && !ds.fastDay) box.appendChild(extraLines(d, ds));
    var meals = allMeals().filter(function (m) { return m.date === d; });
    var rows = h('div', { class: 'diary-rows', testid: 'diary-rows' });
    MEAL_CATS.forEach(function (c) { rows.appendChild(diaryRow(c[0], c[1], meals.filter(function (m) { return m.mealCategory === c[0]; }), d, true)); });
    var uncat = meals.filter(function (m) { return !knownCat(m.mealCategory); });
    if (uncat.length) rows.appendChild(diaryRow('UNCAT', 'Uncategorized / Earlier meals', uncat, d, false));
    box.appendChild(rows);
    box.appendChild(h('p', { class: 'hint', text: 'Only confirmed meals count; drafts and unconfirmed meals are listed but not added. Categories only group meals — they never change totals.' }));
    return box;
  }
  // In the meal form: which diary meal this entry belongs to. Chosen by the owner, never from the clock.
  function mealCategoryPicker() {
    var cur = ms.mealCategory;
    var wrap = h('div', { class: 'meal-cat', testid: 'meal-category' });
    wrap.appendChild(h('p', { class: 'meal-cat-label', id: 'meal-cat-label', text: 'Diary meal' }));
    var none = cur === undefined || cur === null;
    wrap.appendChild(h('div', { class: 'segmented cat-seg', role: 'group', 'aria-labelledby': 'meal-cat-label' }, MEAL_CATS.map(function (x) {
      var on = cur === x[0];
      return h('button', { type: 'button', class: 'seg' + (on ? ' active' : ''), 'aria-pressed': on ? 'true' : 'false', text: x[1], testid: 'meal-cat-' + x[0].toLowerCase(),
        onclick: function () { if (on) return; ms.mealCategory = x[0]; uncatChosen = false; if (logCtx) logCtx.cat = x[0]; renderAdd(); } });
    }).concat([
      // P0: an explicit "Uncategorized" choice. It stores NO category (exactly what an unfiled meal always had) - never a made-up value.
      h('button', { type: 'button', class: 'seg' + (none && uncatChosen ? ' active' : ''), 'aria-pressed': none && uncatChosen ? 'true' : 'false', text: 'Uncategorized', testid: 'meal-cat-none',
        onclick: function () { if (none && uncatChosen) return; delete ms.mealCategory; uncatChosen = true; if (logCtx) logCtx.cat = null; renderAdd(); } })
    ])));
    if (cur !== undefined && cur !== null && !knownCat(cur)) wrap.appendChild(h('p', { class: 'note note-warn', testid: 'meal-category-unknown', text: 'This meal was saved with a category this version does not recognise. It is kept exactly as saved unless you choose one above.' }));
    else if (!knownCat(cur)) wrap.appendChild(h('p', { class: 'hint', testid: 'meal-category-none', text: uncatChosen ? 'Listed under Uncategorized. It counts in the day total like any other meal.' : ms.id ? 'No diary meal yet (an earlier meal). Choose one to file it, or leave it under Uncategorized.' : 'Choose where this goes in the diary. Without a choice it is listed under Uncategorized.' }));
    return wrap;
  }

  function rhrComparisons(ra) {
    var box = h('div', { class: 'note', testid: 'rhr-comparisons' });
    var reading = typeof ra.reading === 'number' ? ra.reading : null;
    box.appendChild(h('p', { testid: 'rhr-reading', text: 'Resting HR today: ' + (reading === null ? 'not recorded (unknown, not assumed normal)' : reading + ' bpm') }));
    // Rounded to one decimal for display (61 - 61.3 is otherwise shown as -0.29999999999999716).
    function diff(base) { var d = Math.round((reading - base) * 10) / 10; return (d > 0 ? '+' : '') + d + ' bpm'; }
    var L = ra.labels || {};
    if (L.configured || L.observed) box.appendChild(h('p', { class: 'hint', testid: 'rhr-labels', text: (L.configured || '') + (L.configured && L.observed ? ' · ' : '') + (L.observed || '') }));
    var cfg = ra.configured && typeof ra.configured.value === 'number' ? ra.configured.value : null;
    box.appendChild(h('p', { testid: 'rhr-compare-owner', text: 'Comparison 1 — vs your owner-set baseline ' + (cfg === null ? '(none set)' : cfg + ' bpm' + (ra.configured.source === 'OWNER_SET' ? ' (set by you)' : ' (owner default)')) +
      (reading === null || cfg === null ? ': no comparison.' : ': ' + diff(cfg) + (reading >= cfg + 7 ? ' — 7 or more above.' : ' — less than 7 above.')) }));
    var ob = ra.observed || {};
    box.appendChild(h('p', { testid: 'rhr-compare-observed', text: 'Comparison 2 — vs your observed 7-day mean ' + (ob.valid ? ob.value + ' bpm (n=' + ob.n + ')' : '(not available: ' + (ob.n || 0) + ' of 4 readings; not estimated)') +
      (reading === null || !ob.valid ? ': no comparison.' : ': ' + diff(ob.value) + (reading >= ob.value + 7 ? ' — 7 or more above.' : ' — less than 7 above.')) }));
    box.appendChild(h('p', { class: 'hint', testid: 'rhr-one-flag-note', text: 'These are two comparisons of the same reading, not two separate flags: together they count as at most ONE readiness flag' + (typeof ra.flagCount === 'number' ? ' (today: ' + ra.flagCount + ')' : '') + '. v2.1 says "personal weekly baseline" without defining it; the observed mean is shown for comparison only and is not an approved source rule. Information, not a diagnosis.' }));
    return box;
  }

  // Steps today, the adaptive target and the owner's per-day override (owner rule 5).
  function stepsBlock(d, opts) {
    var box = h('div', { testid: 'steps-block' });
    var t = HW.stepTarget(d, stepContext()(d)), st = t.steps;
    stepsLines(box, d, st);
    box.appendChild(stepReferenceBlock(d, opts));
    box.appendChild(h('p', { class: 'list-heading', testid: 'today-step-guidance-label', text: 'Daily guidance target (adaptive app suggestion)' }));
    var line;
    if (t.target === null) line = 'Step target: none yet. ' + t.baseline.reason;
    else {
      line = 'Step target today: ' + t.target.toLocaleString('en-US') + (t.source === 'OVERRIDE'
        ? ' (your override' + (t.adaptive !== null ? '; adaptive suggestion was ' + t.adaptive.toLocaleString('en-US') : '') + ')'
        : ' (adaptive: baseline ' + t.baseline.value.toLocaleString('en-US') + (t.baseline.source === 'MANUAL' ? ' set by you' : ' = median of ' + t.baseline.n + ' recorded days') + '. ' + t.reason + ')');
      line += t.met === true ? ' Reached.' : t.met === false ? ' Not reached yet.' : ' Progress unknown (no daily total recorded).';
    }
    box.appendChild(h('p', { testid: 'today-step-target', text: line }));
    if (t.target !== null && t.recoveryUnknown.length) box.appendChild(h('p', { class: 'hint', testid: 'step-recovery-unknown', text: 'Not recorded today: ' + t.recoveryUnknown.join(', ') + ' — recovery was not assumed to be fine; do a check-in to adapt the target.' }));
    var ov = numIn(t.override, { step: '100', testid: 'step-override', placeholder: 'your target', 'aria-label': 'My step target for today' });
    box.appendChild(h('div', { class: 'btn-row' }, ov,
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Set my target for today', testid: 'step-override-save', onclick: function () {
        var v = numOrNull(ov.value);
        if (v === null || isNaN(v) || !Number.isInteger(v)) { toast('Not saved: enter a whole number of steps.', true); return; }
        saveStepOverride(d, v);
      } }),
      t.override !== null ? h('button', { type: 'button', class: 'btn btn-small btn-delete', text: 'Clear my override', testid: 'step-override-clear', onclick: function () { saveStepOverride(d, null); } }) : null));
    box.appendChild(h('p', { class: 'hint', testid: 'step-guidance-unapproved', text: 'The +10% (light day), −15% (after a demanding session) and −30% (soreness, pain or low readiness) adjustments and the 3-of-14-days history rule are app suggestions that the owner has NOT approved; they are not part of plan v2.1. You can override any day. ' + t.note }));
    return box;
  }
  // Plan v2.1 §6 reference goal, shown apart from the adaptive guidance target (owner decision t47u, 1).
  function stepReferenceBlock(d, opts) {
    var ref = stepReference(d), box = h('div', { class: 'note', testid: 'today-step-reference-box' });
    box.appendChild(h('p', { class: 'list-heading', text: 'Plan reference goal (v2.1 §6)' }));
    if (ref.goal === null) { box.appendChild(h('p', { testid: 'today-step-reference', text: 'No plan reference goal today. ' + (ref.text || '') })); return box; }
    box.appendChild(h('p', { testid: 'today-step-reference', text: 'Week ' + ref.week + ' reference goal: ' + (ref.week === 4 ? 'up to 10,000 steps/day, only if you are tolerating the walking volume' : ref.goal.toLocaleString('en-US') + ' steps/day') +
      (ref.optional10k ? ' (10,000 is optional, not compulsory, and only if pain-free and recovered).' : '.') }));
    // Status against the reference goal, never from the lowered guidance target.
    var ds = typeof HW.daySteps === 'function' ? HW.daySteps(d, { dailies: recs('daily'), walks: recs('walks'), sessions: recs('sessions') }) : null;
    var total = ds ? ds.total : null, complete = ds ? ds.source === 'daily' : false;
    if (!ds) { var cs = HW.canonicalSteps(d, recs('daily'), recs('walks')); total = cs.value; complete = cs.value !== null && !cs.partial; }
    // Recovery and the readiness check come first (data layer: status DO_NOT_FORCE).
    if (ref.status === 'DO_NOT_FORCE' && ref.doNotForce.length && !(opts && opts.skipDoNotForce)) {
      var DNF = { READINESS_GATE_FAILED: 'a readiness check item failed', READINESS_GATE_UNKNOWN: 'Week 4 tolerance cannot be confirmed (readiness check items not recorded)',
        PAIN_OVER_3: 'pain above 3/10 (v2.1 §8)', READINESS_FLAGS: 'a readiness flag is raised', TOUGH_TRAINING_DAY: 'a demanding session is logged today' };
      box.appendChild(h('p', { class: 'note note-warn', testid: 'today-step-do-not-force', text: 'Recovery first — do not force the reference goal today: ' + ref.doNotForce.map(function (c) { return DNF[c] || String(c); }).join('; ') + '. Reduce activity to tolerance.' }));
    }
    var met = ref.fromApi ? ref.met : (total === null ? null : total >= ref.goal ? true : complete ? false : null);
    box.appendChild(h('p', { testid: 'today-step-reference-status', text: total === null ? 'Reference goal today: unknown (no steps recorded — unknown, not 0).'
      : met === true ? 'Reference goal today: reached (' + total.toLocaleString('en-US') + (complete ? '' : ', a partial lower bound') + ').'
      : met === false ? 'Reference goal today: not reached (' + total.toLocaleString('en-US') + ' of ' + ref.goal.toLocaleString('en-US') + ').'
      : 'Reference goal today: unknown (only a partial lower bound of ' + total.toLocaleString('en-US') + ' is recorded).' }));
    box.appendChild(stepGate(d, ref));
    box.appendChild(h('p', { class: 'hint', testid: 'today-step-reference-rules', text: 'Reaching a lowered guidance target does NOT meet the plan reference goal. Never walk through pain or other symptoms, poor recovery or a hard training day to reach either number. Missed steps are not made up the next day, and no catch-up target is ever created.' }));
    return box;
  }
  // v2.1 §6 morning readiness check for 10k. The app never says it passed unless every item is recorded.
  // 10,000-step readiness check (v2.1 §6). The verdict comes ONLY from the data layer (tenKGate /
  // step10kGate: checks[], invalid[], status); the UI never applies its own thresholds. An input outside
  // its valid range (e.g. pain 11 or -1) is listed in g.invalid and shown as invalid / unknown, never pass or fail.
  function stepGate(d, ref) {
    var rec = recs('daily').filter(function (x) { return x.date === d; })[0] || null;
    function raw(key) { var o = rec && rec[key]; return o && typeof o === 'object' && 'value' in o && o.state === 'OBSERVED' ? o.value : (o && typeof o !== 'object' ? o : null); }
    var g = ref.gate && Array.isArray(ref.gate.checks) ? ref.gate : callOpt(HW, 'tenKGate', [d, recs('daily')]);
    if (!g || !Array.isArray(g.checks)) {
      var vals = { footPain: raw('footPain'), limp: raw('limp'), stairKneePain: raw('stairKneePain'), sleepH: raw('sleepH') };
      g = callOpt(HW, 'step10kGate', [vals]);
    }
    var head = '10,000-step readiness check (v2.1 §6' + (ref.week === 4 ? ', applies to the Week 4 goal' : ', for the optional 10k') + '): ';
    if (!g || !Array.isArray(g.checks))
      return h('p', { class: 'note note-warn', testid: 'today-step-gate', 'data-gate-status': 'UNKNOWN', text: head + 'unknown — this version of the data layer cannot evaluate it, so the check is NOT passed. If any item fails, do not force 10,000.' });
    var invalid = Array.isArray(g.invalid) ? g.invalid : [];
    var status = g.status === 'PASS' || g.status === 'FAIL' ? g.status : 'UNKNOWN';
    var box = h('div', { class: status === 'PASS' ? 'hint' : 'note note-warn', testid: 'today-step-gate', 'data-gate-status': status });
    var parts = g.checks.map(function (c) {
      var bad = invalid.indexOf(c.key) !== -1;
      var v;
      if (bad) { var rv = raw(c.key);
        if ((c.key === 'footPain' || c.key === 'stairKneePain') && typeof rv === 'number' && rv >= 0 && rv <= 10) rv = null; // never show a valid reading as "invalid"
        v = (rv === null || rv === undefined ? 'recorded value' : 'recorded value ' + (typeof rv === 'string' ? '"' + rv + '"' : String(rv))) + ' is invalid' + (c.key === 'sleepH' || c.key === 'limp' ? '' : ' (pain must be 0–10)'); }
      else v = c.value === null || c.value === undefined ? 'not recorded' : typeof c.value === 'boolean' ? (c.value ? 'limp recorded' : 'no limp recorded') : String(c.value) + (c.key === 'sleepH' ? ' h' : '/10');
      var res = bad ? 'invalid — unknown' : c.result === 'PASS' ? 'ok' : c.result === 'FAIL' ? 'FAILS' : 'unknown';
      return c.label + ' — ' + v + ' (' + res + ')';
    });
    var gtxt = status === 'PASS' ? 'All four items recorded and passed.' : status === 'FAIL' ? 'At least one item fails: do not force 10,000; reduce activity to tolerance.'
      : 'Unknown: not every item is recorded with a valid value, so the check is NOT passed. If any item fails, do not force 10,000.';
    box.appendChild(h('span', { text: head + parts.join('; ') + '. ' + gtxt }));
    if (invalid.length) box.appendChild(h('span', { testid: 'today-step-gate-invalid', 'data-invalid': invalid.join(','),
      text: ' Invalid input: ' + invalid.map(function (k) { return ({ footPain: 'first-step foot pain', stairKneePain: 'stair knee pain', limp: 'limp', sleepH: 'sleep hours' })[k] || k; }).join(', ') + '. Out-of-range values are treated as unknown, never as pass or fail — correct them in the check-in.' }));
    return box;
  }
  // Owner step rule (dawit-steps-contract.md v1): a recorded daily total wins and nothing is added to it;
  // without one, walk + running-workout steps are only a PARTIAL LOWER BOUND, never a day total.
  // Missing stays missing (never 0). Nothing is derived from distance or time.
  function n0(v) { return v.toLocaleString('en-US'); }
  function stepsLines(box, d, st) {
    var ds = typeof HW.daySteps === 'function' ? HW.daySteps(d, { dailies: recs('daily'), walks: recs('walks'), sessions: recs('sessions') }) : null;
    if (!ds) {
      // Data layer without the running-steps contract: walk steps only.
      box.appendChild(h('p', { testid: 'today-steps', text: 'Steps today: ' + (st.value === null ? 'not recorded' : n0(st.value) + ' (' + st.source + ')') }));
      if (recs('sessions').some(function (s) { return s.date === d && typeof s.runSteps === 'number'; })) box.appendChild(h('p', { class: 'hint', testid: 'steps-run-not-counted', text: 'Running steps are saved on today\'s workout, but this version of the data layer does not count them yet.' }));
      return;
    }
    var parts = [];
    if (ds.walkSteps !== null) parts.push('walks ' + n0(ds.walkSteps));
    if (ds.runSteps !== null) parts.push('running workouts ' + n0(ds.runSteps));
    if (ds.source === 'daily') {
      box.appendChild(h('p', { testid: 'today-steps', text: 'Steps today: ' + n0(ds.total) + ' (declared daily total' + (parts.length ? '; walk and run steps are already in it and are not added' : '') + ')' }));
      if (ds.flags.indexOf('DAILY_BELOW_WORKOUT_STEPS') !== -1) box.appendChild(h('p', { class: 'hint', testid: 'steps-daily-below', text: 'Your daily total is lower than the steps recorded on today\'s walks/workouts (' + parts.join(' + ') + '). Nothing was changed; the daily total is used. Check the numbers if this looks wrong.' }));
    } else if (ds.source === 'partial_lower_bound') {
      box.appendChild(h('p', { testid: 'today-steps' }, badge('Partial lower bound', 'warn', 'steps-partial-badge'), ' Steps today: at least ' + n0(ds.total) +
        ' — a partial lower bound, NOT a day total (' + parts.join(' + ') + '). No daily total is recorded, so other steps today are unknown, not 0.'));
    } else {
      box.appendChild(h('p', { testid: 'today-steps', text: 'Steps today: not recorded (unknown, not 0).' }));
    }
    if (ds.flags.indexOf('INVALID_STEP_COUNT_IGNORED') !== -1) box.appendChild(h('p', { class: 'note note-warn', testid: 'steps-invalid-ignored',
      text: ds.ignoredInvalid + ' step count' + (ds.ignoredInvalid === 1 ? '' : 's') + ' on today\'s walks or workouts ' + (ds.ignoredInvalid === 1 ? 'is' : 'are') + ' not a whole number, so ' + (ds.ignoredInvalid === 1 ? 'it is' : 'they are') + ' not counted and not rounded. Correct ' + (ds.ignoredInvalid === 1 ? 'it' : 'them') + ' in History.' }));
  }
  function saveStepOverride(d, v) {
    var ex = recs('daily').filter(function (x) { return x.date === d; })[0];
    var rec = ex ? JSON.parse(JSON.stringify(ex)) : { id: 'daily-' + d, date: d };
    rec.stepTargetOverride = v;
    persist('daily', rec);
  }

  // A source-omitted prescription. If something was actually logged for it, the log is shown too.
  function omittedRow(o, sessions, events, testid) {
    var box = h('div', {});
    box.appendChild(h('p', { class: 'note', testid: testid, text: o.slot.title + ' — omitted by source rule (' + o.reason + '). Not user-skipped.' }));
    if (PL.slotStatus(o.slot.id, sessions, events).session) box.appendChild(slotRow(o.slot, null, sessions, events));
    return box;
  }

  var SKIP_TEXT = { RESCHEDULE: 'You skipped this and rescheduled it', SKIP_PERMANENT: 'You skipped this permanently.',
    ADJUST_WEEK: 'You skipped this and chose to adjust the rest of the week (source cascade).' };
  // Concise one-paragraph summary of a slot's own (source) prescription lines: the main work only, in source wording.
  function slotSummary(slot) {
    var skip = /^(\d+(–\d+)? min warm-up|warm-up|buffer|transition|record |rpe 7 ≈|rest |optional light|no heavy rdl|remaining time|cooldown|then 8 min)/i;
    var main = slot.prescription.filter(function (l) { return !skip.test(l); });
    var lines = main.length ? main : slot.prescription;
    return lines.slice(0, 2).join(' · ') + (lines.length > 2 ? ' · +' + (lines.length - 2) + ' more' : '');
  }
  function slotRow(slot, movedFrom, sessions, events, extraNote, opts) {
    opts = opts || {};
    var st = PL.slotStatus(slot.id, sessions, events);
    var row = h('div', { class: 'slot', testid: 'slot-' + slot.id });
    row.appendChild(h('div', { class: 'entry-title' }, h('span', { text: slot.title + (movedFrom ? ' (moved from ' + movedFrom + ')' : '') }),
      statusBadge(st), st.omission && st.session ? badge('Prescription source-omitted', 'info', 'slot-omission') : null,
      st.modified ? badge('Modified', 'warn') : null, slot.benchmark ? badge('Benchmark ' + slot.benchmark, 'info') : null,
      slot.revision ? badge(slot.revision.ownerWritten ? 'Owner-written (not source)' : 'Revised by you', 'warn', 'slot-revised') : null));
    if (extraNote) row.appendChild(h('p', { class: 'hint', testid: 'slot-note', text: extraNote }));
    var wkWork = Array.isArray(st.weekendWork) ? st.weekendWork : (st.session && HP.isActualWork && HP.isActualWork(st.session) && st.session.date !== slot.date && isWeekend(st.session.date) ? [st.session] : []);
    wkWork.forEach(function (ws2) { var sx = ws2 && ws2.session ? ws2.session : ws2; if (!sx || !sx.date) return;
      row.appendChild(h('p', { class: 'note note-warn', testid: 'slot-weekend-actual', text: 'Logged as ACTUAL work on ' + fmtDate(sx.date) + '. Plan v2.1 has no weekend gym make-up, so this is not a source-approved reschedule. The original ' + fmtDate(slot.date) + ' prescription stays on record below.' })); });
    if (st.rescheduleNotSourceApproved === true || (st.code === 'SKIPPED' && st.skipDecision === 'RESCHEDULE' && st.rescheduledTo && isWeekend(st.rescheduledTo)))
      row.appendChild(h('p', { class: 'note note-warn', testid: 'slot-weekend-reschedule-legacy', text: 'This reschedule to a weekend was recorded before the v2.1 "no weekend make-up" rule was enforced. It is kept as recorded, but it is not a source-approved make-up.' }));
    if (st.conflict) row.appendChild(h('p', { class: 'note note-warn', testid: 'slot-conflict', text: 'An actual session is logged for a slot the source cascade omits. The log is kept and shown; it was not skipped and not erased.' }));
    if (st.code === 'SKIPPED') {
      row.appendChild(h('p', { class: 'hint', testid: 'slot-skip-decision', text: st.skipDecision === 'RESCHEDULE' ? SKIP_TEXT.RESCHEDULE + ' to ' + fmtDate(st.rescheduledTo) + '. Original plan date kept: ' + fmtDate(slot.date) + '.'
        : st.skipDecision ? SKIP_TEXT[st.skipDecision] : 'Skipped, but no decision is recorded yet: reschedule, skip permanently or adjust the week.' }));
    }
    var rxItems = slot.prescription.map(function (l) { return h('li', { text: l }); });
    var viewBtn = null;
    if (opts.today) {
      // Today: concise summary + a "View workout" toggle beside the log button; the full prescription opens on demand.
      row.appendChild(h('p', { class: 'slot-summary', testid: 'slot-summary', text: slotSummary(slot) }));
      var panel = h('ul', { class: 'rx rx-panel', hidden: true, testid: 'slot-rx-' + slot.id }, rxItems);
      viewBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'View workout', testid: 'slot-view-' + slot.id, 'aria-expanded': 'false',
        onclick: function () { var open = panel.hidden; panel.hidden = !open; viewBtn.setAttribute('aria-expanded', open ? 'true' : 'false'); viewBtn.textContent = open ? 'Hide workout' : 'View workout'; } });
      row.appendChild(panel);
    } else {
      row.appendChild(h('details', { open: opts.openRx || null }, h('summary', { text: PL.isB(slot.id) ? 'Planned prescription (' + slot.planVersion + ', approved by you)' : 'Planned prescription (source ' + slot.planVersion + ')', testid: 'slot-view-' + slot.id }),
        h('ul', { class: 'rx' }, rxItems)));
    }
    if (st.code === 'SKIPPED') {
      row.appendChild(h('div', { class: 'btn-row' }, viewBtn,
        h('button', { type: 'button', class: 'btn btn-secondary btn-small', testid: 'log-slot-' + slot.id, text: 'Log workout', onclick: function () { startSession(slot); } }),
        h('button', { type: 'button', class: 'btn btn-secondary btn-small', testid: 'skip-edit-' + slot.id, text: st.skipDecision ? 'Change skip decision' : 'Decide what happens', onclick: function () { editSession(st.session); } })));
    } else if (st.code !== 'SOURCE_OMITTED') row.appendChild(h('div', { class: 'btn-row' }, viewBtn, h('button', { type: 'button', class: 'btn btn-secondary btn-small', testid: 'log-slot-' + slot.id,
      text: st.session ? 'Edit workout log' : 'Log workout', onclick: function () { st.session ? editSession(st.session) : startSession(slot); } })));
    else if (viewBtn) row.appendChild(h('div', { class: 'btn-row' }, viewBtn));
    return row;
  }
  function statusBadge(st) {
    var map = { NOT_LOGGED: ['Not logged', 'muted'], SOURCE_OMITTED: ['Source-omitted', 'info'], COMPLETED: ['Completed', 'ok'], PARTIAL: ['Partial', 'warn'],
      SKIPPED: ['Skipped (confirmed)', 'bad'], IN_PROGRESS: ['In progress', 'info'], NOT_STARTED: ['Not started', 'muted'],
      PLANNED_REST: ['Planned rest (your choice)', 'info'], NOT_IN_PLAN: ['Not in plan (block ended early)', 'muted'] };
    var m = map[st.code] || [st.code, 'info'];
    return badge(m[0], m[1], 'slot-status');
  }

  var calWeek = null, calBlock = undefined, calWeekB = {};
  // Phase 12: calendar of one activated later block. Its missed-day buttons write only this block's own events.
  function blockCalendar(b, sessions) {
    var t = today(), c = card((b.label || 'Block 2') + ' calendar · ' + fmtDate(b.startDate) + ' – ' + fmtDate(HB.lastDay(b)), 'plan-calendar-b2');
    c.appendChild(h('p', { class: 'hint', testid: 'b2-cal-approval', text: (b.approval ? b.approval.text + ' ' : '') + 'Activated ' + qatarTime(b.activatedAt) + '. Conditional training plan, not medical clearance.' }));
    if (b.endedEarlyOn) c.appendChild(h('p', { class: 'note', testid: 'b2-cal-ended', text: 'Ended early by you: sessions from ' + fmtDate(b.endedEarlyOn) + ' are "not in plan" (not missed, not skipped).' }));
    var tw = HB.weekOf(b, t);
    if (!calWeekB[b.id]) calWeekB[b.id] = tw || 1;
    var w = calWeekB[b.id];
    c.appendChild(h('div', { class: 'segmented' }, [1, 2, 3, 4].map(function (n) {
      return h('button', { type: 'button', class: 'seg' + (n === w ? ' active' : ''), text: 'Week ' + n + (n === 4 ? ' (deload)' : ''), testid: 'b2-week-' + n, onclick: function () { calWeekB[b.id] = n; renderToday(); } });
    })));
    var eff = HB.effectiveWeek(b, w);
    eff.days.forEach(function (d) {
      var box = h('div', { class: 'plan-day', testid: 'b2-day' }, h('h3', { class: 'list-heading', text: fmtDate(d.date) }));
      if (d.possibleClosure) box.appendChild(h('p', { class: 'note', testid: 'b2-possible-closure', text: 'Possible gym closure (' + d.possibleClosure + '). Only a flag: nothing is marked missed or cancelled.' }));
      d.show.forEach(function (x) { box.appendChild(slotRow(x.slot, x.movedFrom, sessions, [], null, { openRx: d.date === t })); });
      d.omitted.forEach(function (o) { box.appendChild(omittedRow(o, sessions, [], 'calendar-omitted')); });
      HB.rescheduledOn(d.date, sessions, [b]).forEach(function (sl) { box.appendChild(slotRow(sl, null, sessions, [], 'Rescheduled here by you. Original plan date: ' + fmtDate(sl.date) + '.')); });
      if (!d.show.length && !d.omitted.length) box.appendChild(h('p', { class: 'muted', text: 'Session moved by cascade.' }));
      c.appendChild(box);
    });
    HB.cascadeConflicts(b, w, sessions).forEach(function (x) { c.appendChild(h('p', { class: 'note note-warn', testid: 'calendar-cascade-conflict', text: x.text })); });
    if (eff.unresolved) c.appendChild(h('p', { class: 'note note-warn', text: eff.unresolved, testid: 'calendar-cascade-unresolved' }));
    eff.weekendOptions.forEach(function (o) { c.appendChild(h('p', { class: 'hint', testid: 'b2-weekend-option', text: fmtDate(o.date) + ' (optional, not counted, not a gym make-up): ' + o.text })); });
    c.appendChild(h('p', { class: 'hint', text: eff.fridayNote }));
    c.appendChild(h('h3', { class: 'list-heading', text: 'Source busy-day cascade (explicit only, this block only)' }));
    ['MISSED_MONDAY', 'MISSED_WEDNESDAY'].forEach(function (kind) {
      var ex = (b.events || []).filter(function (e) { return e.week === w && e.kind === kind; })[0];
      var chk = HB.eventCheck(b, kind, w, t);
      c.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small', testid: 'b2-cascade-' + kind.toLowerCase(), disabled: !ex && !chk.ok, title: !ex && !chk.ok ? chk.text : null,
        text: ex ? 'Undo ' + kind.replace('_', ' ').toLowerCase() : 'Mark ' + (kind === 'MISSED_MONDAY' ? 'Monday' : 'Wednesday') + ' missed (apply source cascade)',
        onclick: function () {
          if (ex) { if (window.confirm('Remove this cascade?')) blocksWrite(function (raw) { return HB.removeEvent(raw, b.id, ex.id); }); return; }
          if (!window.confirm('Apply the source rule for a missed ' + (kind === 'MISSED_MONDAY' ? 'Monday' : 'Wednesday') + ' in ' + (b.label || 'Block 2') + ' week ' + w + '? Thursday aerobic will be omitted by source rule (not marked skipped). Block 1 is not affected.')) return;
          blocksWrite(function (raw) { return HB.addEvent(raw, b.id, kind, w, today(), nowIso()); });
        } }));
    });
    var sum = HB.summary(b, sessions);
    c.appendChild(h('p', { class: 'hint', testid: 'b2-summary', text: sum.denominator + ' planned weekday sessions. Logged so far: ' + sum.COMPLETED + ' completed, ' + sum.PARTIAL + ' partial, ' + sum.SKIPPED + ' skipped, ' +
      sum.SOURCE_OMITTED + ' source-omitted, ' + sum.PLANNED_REST + ' planned rest (your choice), ' + sum.NOT_IN_PLAN + ' not in plan, ' + sum.NOT_LOGGED + ' not logged; ' + sum.fallback + ' fallback-variant, ' + sum.modified + ' modified' +
      (sum.weekendActual ? '; ' + sum.weekendActual + ' weekend session(s) logged as actual work (not make-ups)' : '') + '. ' + sum.note }));
    var bm = HB.benchmarks(b, sessions)[0];
    c.appendChild(h('p', { class: 'hint', testid: 'b2-benchmark3', text: 'Benchmark 3 (' + fmtDate(bm.date) + '): ' + bm.status + '. ' + bm.note }));
    return c;
  }
  function planCalendar(sessions, events) {
    var fold = h('details', { class: 'fold', testid: 'today-fullplan', ontoggle: function (e) { if (e.target === fold) planOpen = fold.open; } },
      h('summary', { text: 'Full plan (4 weeks)', testid: 'today-fullplan-toggle' }));
    if (planOpen) fold.open = true;
    var acts = HB ? HB.activated(blocks()) : [];
    if (calBlock === undefined) { var bb0 = PL.blockStatus(today()); calBlock = bb0 && bb0.active ? bb0.blockId : null; }
    if (calBlock && !HB.blockById(acts, calBlock)) calBlock = null;
    if (acts.length) fold.appendChild(h('div', { class: 'segmented', testid: 'plan-block-picker' }, [h('button', { type: 'button', class: 'seg' + (!calBlock ? ' active' : ''), text: 'Block 1', testid: 'plan-block-b1', 'aria-pressed': !calBlock ? 'true' : 'false', onclick: function () { calBlock = null; renderToday(); } })]
      .concat(acts.map(function (b) { return h('button', { type: 'button', class: 'seg' + (calBlock === b.id ? ' active' : ''), text: (b.label || 'Block 2') + ' · ' + HP.humanShort(b.startDate), testid: 'plan-block-' + b.id, 'aria-pressed': calBlock === b.id ? 'true' : 'false',
        onclick: function () { calBlock = b.id; renderToday(); } }); }))));
    if (calBlock) { fold.appendChild(blockCalendar(HB.blockById(acts, calBlock), sessions)); return fold; }
    var c = card('Training block ' + HP.PLAN_VERSION + ' calendar', 'plan-calendar');
    fold.appendChild(c);
    var bs = HP.blockStatus(today());
    if (calWeek === null) calWeek = bs.active && bs.week >= 1 && bs.week <= 4 ? bs.week : 1;
    c.appendChild(h('div', { class: 'segmented' }, [1, 2, 3, 4].map(function (w) {
      return h('button', { type: 'button', class: 'seg' + (w === calWeek ? ' active' : ''), text: 'Week ' + w, testid: 'plan-week-' + w,
        onclick: function () { calWeek = w; renderToday(); } });
    })));
    var eff = HP.effectiveWeek(calWeek, events);
    eff.days.forEach(function (d) {
      var box = h('div', { class: 'plan-day' }, h('h3', { class: 'list-heading', text: fmtDate(d.date) }));
      var isToday = d.date === today();
      d.show.forEach(function (x) { box.appendChild(slotRow(x.slot, x.movedFrom, sessions, events, null, { openRx: isToday })); });
      d.omitted.forEach(function (o) { box.appendChild(omittedRow(o, sessions, events, 'calendar-omitted')); });
      HP.rescheduledOn(d.date, sessions).forEach(function (sl) { box.appendChild(slotRow(sl, null, sessions, events, 'Rescheduled here by you. Original plan date: ' + fmtDate(sl.date) + '.')); });
      if (!d.show.length && !d.omitted.length) box.appendChild(h('p', { class: 'muted', text: 'Session moved by cascade.' }));
      c.appendChild(box);
    });
    [5, 6].forEach(function (off) {
      var wd = HP.addDays(HP.BLOCK_START, (calWeek - 1) * 7 + off), moved = HP.rescheduledOn(wd, sessions);
      if (!moved.length) return;
      var box = h('div', { class: 'plan-day' }, h('h3', { class: 'list-heading', text: fmtDate(wd) }));
      moved.forEach(function (sl) { box.appendChild(slotRow(sl, null, sessions, events, 'Rescheduled here by you. Original plan date: ' + fmtDate(sl.date) + '.')); });
      c.appendChild(box);
    });
    HP.cascadeConflicts(calWeek, sessions, events).forEach(function (x) { c.appendChild(h('p', { class: 'note note-warn', testid: 'calendar-cascade-conflict', text: x.text })); });
    if (eff.unresolved) c.appendChild(h('p', { class: 'note note-warn', text: eff.unresolved, testid: 'calendar-cascade-unresolved' }));
    if (Array.isArray(eff.weekendOptions)) eff.weekendOptions.forEach(function (o) {
      c.appendChild(h('p', { class: 'hint', testid: 'calendar-weekend-option', text: fmtDate(o.date) + ' (optional, not counted, not a gym make-up): ' + (o.available ? o.text : 'no optional Saturday session this week (v2.1: from Week 2).') })); });
    else if (eff.weekend) c.appendChild(h('p', { class: 'hint', text: fmtDate(eff.weekend.date) + ': ' + eff.weekend.text }));
    c.appendChild(h('p', { class: 'hint', text: eff.fridayNote }));
    var wkEvents = events.filter(function (e) { return e.week === calWeek && !HP.isPreBlockEvent(e); });
    c.appendChild(h('h3', { class: 'list-heading', text: 'Source busy-day cascade (explicit only)' }));
    ['MISSED_MONDAY', 'MISSED_WEDNESDAY'].forEach(function (kind) {
      var ex = wkEvents.filter(function (e) { return e.kind === kind; })[0];
      var target = HP.SLOTS.filter(function (s) { return s.week === calWeek && s.day === (kind === 'MISSED_MONDAY' ? 'MON' : 'WED'); })[0];
      var future = !ex && target.date > today();
      c.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small', testid: 'cascade-' + kind.toLowerCase(), disabled: future, title: future ? 'Cannot mark a future session as missed' : null,
        text: ex ? 'Undo ' + kind.replace('_', ' ').toLowerCase() : 'Mark ' + (kind === 'MISSED_MONDAY' ? 'Monday' : 'Wednesday') + ' missed (apply source cascade)',
        onclick: function () {
          if (ex) { if (window.confirm('Remove this cascade?')) { store.removeRecord('planEvents', ex.id) ? toast('Cascade removed.') : toast('Could not remove.', true); refresh(); } return; }
          var slot = HP.SLOTS.filter(function (s) { return s.week === calWeek && s.day === (kind === 'MISSED_MONDAY' ? 'MON' : 'WED'); })[0];
          if (!window.confirm('Apply the source rule for a missed ' + slot.day + ' in week ' + calWeek + '? Thursday aerobic will be omitted by source rule (not marked skipped).')) return;
          if (slot.date > today()) { toast('Cannot mark a future session as missed.', true); return; }
          persist('planEvents', { kind: kind, week: calWeek, date: slot.date });
        } }));
    });
    var sum = HP.summary(sessions, events);
    c.appendChild(h('p', { class: 'hint', testid: 'plan-summary', text: sum.denominator + ' planned weekday sessions. Logged so far: ' + sum.COMPLETED + ' completed, ' + sum.PARTIAL + ' partial, ' +
      sum.SKIPPED + ' skipped, ' + sum.SOURCE_OMITTED + ' source-omitted, ' + sum.NOT_LOGGED + ' not logged; ' + sum.fallback + ' fallback-variant, ' + sum.modified + ' modified' +
      (sum.omittedWithActual ? '; ' + sum.omittedWithActual + ' logged on a source-omitted slot (counted under its logged status)' : '') +
      (sum.rescheduledPending ? '; ' + sum.rescheduledPending + ' of the skipped rescheduled and not yet done' : '') +
      (sum.weekendActual ? '; ' + sum.weekendActual + ' weekend session(s) logged as actual work (not source-approved make-ups)' : '') + '. ' + sum.note }));
    var preS = HP.preBlockSessions(sessions).length, preE = HP.preBlockEvents(events).length;
    if (preS || preE) c.appendChild(h('p', { class: 'hint', testid: 'plan-preblock-note', text: 'Kept in History, not counted here: ' + (preS ? preS + ' workout record' + (preS === 1 ? '' : 's') : '') + (preS && preE ? ' and ' : '') +
      (preE ? preE + ' plan change' + (preE === 1 ? '' : 's') : '') + ' dated before Day 0 (' + HP.humanShort(HP.DAY0) + '), made under the earlier calendar. Nothing was changed or deleted.' }));
    return fold;
  }

  // ================= PHASE 12: TRAINING BLOCK PLANNER =================
  // Owner / Command Center decisions D1-D12 (19 Nov 2026). Everything here is an explicit owner action with a preview
  // and a confirm: creating a draft never activates it; a draft has no effect anywhere; options open only from 11 Dec,
  // are never pre-selected, and activation needs the owner's approval tick. No AI, no automatic progression or rollover.
  var plannerOpen = false, plannerUi = {};
  var REVISION_LABEL = { PLANNED_REST: 'Planned rest (not a skip, not missed)', LOW_IMPACT: 'Lower-impact version', REDUCED_VOLUME: 'Reduced volume (about 20–30% less)',
    FALLBACK_45: 'Source 45-min fallback', FALLBACK_25: 'Source 25-min fallback', OWNER_TEXT: 'Write my own (marked owner-written; not in the deload week)' };
  function rawBlocks() { var r = rawSettingsRecord(); return r && Array.isArray(r.planBlocks) ? r.planBlocks : []; }
  function plannerFold() {
    if (!HB) return null;
    var fold = h('details', { class: 'fold', testid: 'today-planner', ontoggle: function (e) { if (e.target === fold) plannerOpen = fold.open; } },
      h('summary', { text: 'Next training block (Block 2 planner)', testid: 'today-planner-toggle' }));
    if (plannerOpen) fold.open = true;
    var c = card('Training blocks', 'planner-card'), t = today(), pr = planRead(), sessions = recs('sessions'), events = recs('planEvents');
    fold.appendChild(c);
    if (pr.malformed) c.appendChild(h('p', { class: 'note note-danger', testid: 'planner-malformed', role: 'alert', text: 'The saved plan blocks are damaged (not a list). They are not used, and the planner will not overwrite them. Export a backup (Settings) and ask for a repair.' }));
    pr.invalid.forEach(function (x) { c.appendChild(h('p', { class: 'note note-warn', testid: 'planner-invalid', text: 'A saved plan block (' + (x.id || 'no id') + ') is not valid and is not used: ' + x.problems[0].message + ' It is kept exactly as saved.' })); });
    // Block 1 review (read-only)
    var s1 = HP.summary(sessions, events), bm = HP.benchmarks(sessions);
    c.appendChild(h('div', { class: 'note', testid: 'planner-b1-review' }, h('p', { class: 'list-heading', text: 'Block 1 review (v2.1, ' + HP.humanShort(HP.BLOCK_START) + ' – ' + HP.human(HP.BLOCK_END) + ', read-only)' }),
      h('p', { text: s1.COMPLETED + ' completed · ' + s1.PARTIAL + ' partial · ' + s1.SKIPPED + ' skipped · ' + s1.SOURCE_OMITTED + ' source-omitted · ' + s1.NOT_LOGGED + ' not logged, of ' + s1.denominator + '. ' +
        bm.map(function (x) { return 'Benchmark ' + x.benchmark + ' (' + HP.humanShort(x.date) + '): ' + x.status + (x.status !== 'NOT_LOGGED' ? (x.comparable ? ', comparable' : ', not directly comparable') : ''); }).join(' · ') + '.' }),
      h('p', { class: 'hint', text: 'The planner never changes Block 1. Which sessions count toward the 17-of-20 review stays your open decision.' })));
    pr.blocks.forEach(function (b) { c.appendChild(b.state === 'DRAFT' ? draftPanel(b, t, sessions) : b.state === 'ACTIVATED' ? activePanel(b, t, sessions) :
      h('p', { class: 'hint', testid: 'planner-cancelled', text: (b.label || 'Block 2') + ' ' + fmtDate(b.startDate) + ' – ' + fmtDate(b.endDate) + ': cancelled before it started (' + qatarTime(b.cancelledAt) + '). Kept for the record; it has no effect.' })); });
    if (!pr.malformed && !pr.blocks.some(function (b) { return b.state === 'DRAFT'; })) c.appendChild(createPanel(t));
    c.appendChild(h('p', { class: 'hint', testid: 'planner-rules-note', text: 'Nothing here changes by itself: no automatic progression, no automatic next block, no AI. Readiness, pain and stop rules are unchanged. Export a backup before you activate (Settings → Export JSON backup).' }));
    return fold;
  }
  function createPanel(t) {
    var box = h('div', { class: 'note', testid: 'planner-create-box' });
    var mondays = HB.mondaysFrom(t, 6), last = HB.activated(blocks()).map(function (b) { return HB.lastDay(b); }).sort().pop();
    if (last) mondays = mondays.filter(function (m) { return m > last; });
    box.appendChild(h('p', { class: 'list-heading', text: 'Create a Block 2 draft' }));
    box.appendChild(h('p', { class: 'hint', text: 'Conservative Hold template (Block 1 Week 2/3 level as the ceiling, Week 4 deload, Benchmark 3 on the Week 4 Friday). Starts on a Monday: earliest ' + HP.human(HB.FIRST_START) + ' (no early start, no overlap). A later Monday is fine; the days in between are not counted and not missed. A draft has no effect until you activate it.' }));
    var sel = select(mondays.map(function (m) { return [m, fmtDate(m) + (m === HB.FIRST_START ? ' (first allowed)' : '')]; }), mondays[0], { testid: 'planner-start' });
    box.appendChild(field('Start Monday', sel));
    box.appendChild(h('button', { type: 'button', class: 'btn btn-secondary', text: 'Create draft (inactive)', testid: 'planner-create', onclick: function () {
      blocksWrite(function (raw) { return HB.createDraft(raw, sel.value, today(), nowIso()); });
    } }));
    return box;
  }
  function draftPanel(b, t, sessions) {
    var ui = plannerUi[b.id] || (plannerUi[b.id] = { opts: HB.normOptions(b.options), approved: false, preview: false });
    var stampAtRender = HB.settingsStamp(store), hashAtRender = HB.contentHash(b.slots);
    // RC1 review (B-01): the approval tick belongs to the exact content previewed. The preview must be opened for this
    // content before the tick is offered, and a tick given for other content (changed here, in another tab or by a
    // restore) is cleared on the next draw.
    if (ui.preview) ui.seenHash = hashAtRender;
    var approvalStale = !!ui.approved && ui.approvedHash !== hashAtRender;
    if (ui.approved && (approvalStale || ui.seenHash !== hashAtRender)) { ui.approved = false; ui.approvedHash = null; }
    var box = h('div', { class: 'note', testid: 'planner-draft' });
    box.appendChild(h('div', { class: 'entry-title' }, h('span', { text: (b.label || 'Block 2') + ' draft · ' + fmtDate(b.startDate) + ' – ' + fmtDate(b.endDate) }), badge(HB.DRAFT_LABEL, 'warn', 'planner-draft-label')));
    box.appendChild(h('p', { class: 'hint', testid: 'planner-draft-inactive', text: 'Inactive draft: no effect on Today, logging, steps or any rule until you activate it. Options: ' + (HB.chosenOptions(b.options).length ? HB.chosenOptions(b.options).join(', ') : 'none (Hold everywhere)') + '.' }));
    // preview
    var pv = HB.preview(b);
    var approveBox = null;
    var det = h('details', { class: 'planned', testid: 'planner-preview', ontoggle: function (e) {
      if (e.target !== det) return;
      ui.preview = det.open;
      if (det.open) { ui.seenHash = hashAtRender; if (approveBox) approveBox.disabled = t < HB.DECISION_FROM; }
    } }, h('summary', { text: 'Preview all 4 weeks (' + HB.DRAFT_LABEL.toLowerCase() + ')', testid: 'planner-preview-toggle' }));
    if (ui.preview) det.open = true;
    pv.weeks.forEach(function (wk) {
      det.appendChild(h('h3', { class: 'list-heading', text: 'Week ' + wk.week + (wk.deload ? ' — deload' : '') }));
      wk.days.forEach(function (d) {
        det.appendChild(h('div', { class: 'plan-day', testid: 'planner-preview-day' },
          h('p', {}, h('strong', { text: fmtDate(d.slot.date) + ' · ' + d.slot.title + (d.slot.benchmark ? ' · Benchmark 3' : '') })),
          d.possibleClosure ? h('p', { class: 'note', testid: 'planner-preview-closure', text: 'Possible gym closure (' + d.possibleClosure + '): flag only — nothing is pre-marked missed or cancelled.' }) : null,
          h('ul', { class: 'rx' }, d.slot.prescription.map(function (l) { return h('li', { text: l }); })),
          h('p', { class: 'hint', testid: 'planner-preview-diff', text: d.sameAsBlock1Ref ? 'Same as Block 1 ' + d.block1Ref + '.' : 'Differs from Block 1 ' + d.block1Ref + (wk.deload ? ' (Block 2 deload / Benchmark 3 wording).' : HB.chosenOptions(b.options).length ? ' (your option).' : ' (Hold wording).') })));
      });
      wk.weekend.forEach(function (o) { det.appendChild(h('p', { class: 'hint', text: fmtDate(o.date) + ': ' + o.text })); });
    });
    det.appendChild(h('p', { class: 'list-heading', text: 'Rules in this block' }));
    det.appendChild(h('ul', { class: 'rx', testid: 'planner-rules' }, pv.rules.map(function (r) { return h('li', { text: r }); })));
    box.appendChild(det);
    // options (D2): owner choices only, from 11 Dec, never pre-selected
    var ob = h('div', { testid: 'planner-options' }, h('p', { class: 'list-heading', text: 'Progression options (your choice, optional)' }));
    var locked = t < HB.DECISION_FROM;
    if (locked) ob.appendChild(h('p', { class: 'hint', testid: 'planner-options-locked', text: 'Options open on ' + HP.human(HB.DECISION_FROM) + ', after Benchmark 2. Until then this draft stays at Hold. Nothing is pre-selected; final intensity stays pending your decision.' }));
    Object.keys(HB.OPTION_GROUPS).forEach(function (g) {
      var grp = HB.OPTION_GROUPS[g], fs = h('fieldset', { class: 'field', testid: 'planner-opt-group-' + g }, h('legend', { text: grp.label }));
      [['', 'Hold (no change)']].concat(Object.keys(grp.choices).map(function (k) { return [k, k + ': ' + grp.choices[k]]; })).forEach(function (o) {
        fs.appendChild(h('label', { class: 'check' }, h('input', { type: 'radio', name: 'opt-' + b.id + '-' + g, value: o[0], disabled: locked, checked: (ui.opts[g] || '') === o[0], testid: 'planner-opt-' + g + '-' + (o[0] || 'hold'),
          onchange: function () { ui.opts[g] = o[0] || null; if (!HB.bothIncreases(ui.opts)) ui.opts.bothConfirmed = false; renderToday(); } }), h('span', { text: o[1] })));
      });
      ob.appendChild(fs);
    });
    if (HB.bothIncreases(ui.opts)) ob.appendChild(h('div', { class: 'note note-warn', testid: 'planner-both-warning', role: 'status' }, h('p', { text: HB.BOTH_WARNING }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ui.opts.bothConfirmed === true, testid: 'planner-both-confirm', onchange: function () { ui.opts.bothConfirmed = this.checked; } }), h('span', { text: 'I confirm both: my Block 1 recovery was good.' }))));
    if (!locked) ob.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Apply options to the draft', testid: 'planner-apply-options', onclick: function () {
      var r = blocksWrite(function (raw) { return HB.setOptions(raw, b.id, ui.opts, today()); }, { expectStamp: stampAtRender });
      if (r.ok) { ui.approved = false; renderToday(); }
    } }));
    box.appendChild(ob);
    // approval + activation (separate from creation)
    var chk = HB.activationCheck(rawBlocks(), b.id, t, { approved: ui.approved, previewHash: hashAtRender });
    approveBox = h('input', { type: 'checkbox', checked: ui.approved, disabled: locked || ui.seenHash !== hashAtRender, testid: 'planner-approve',
      onchange: function () { ui.approved = this.checked; ui.approvedHash = this.checked ? hashAtRender : null; renderToday(); } });
    box.appendChild(h('label', { class: 'check' }, approveBox,
      h('span', { text: 'I reviewed the preview and approve this content for ' + (b.label || 'Block 2') + '.' })));
    if (!locked && ui.seenHash !== hashAtRender) box.appendChild(h('p', { class: 'hint', testid: 'planner-approve-needs-preview', text: 'Open "Preview all 4 weeks" above first; the approval applies to the content shown there.' }));
    if (approvalStale) box.appendChild(h('p', { class: 'note note-warn', testid: 'planner-approval-cleared', role: 'status', text: 'The draft changed since you ticked approval (here or in another tab), so the tick was cleared. Review the preview again.' }));
    box.appendChild(h('p', { class: chk.ok ? 'hint' : 'note note-warn', testid: 'planner-activate-status', text: chk.ok ? 'Ready: activating makes this block the plan from ' + HP.human(b.startDate) + '.' : chk.text }));
    box.appendChild(h('p', { class: 'hint', testid: 'planner-export-reminder', text: 'Before activating: export a backup (Settings → Export JSON backup). If you ever roll back to an older app version, do not edit Block 2 workouts there.' }));
    box.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn btn-primary', text: 'Activate ' + (b.label || 'Block 2'), testid: 'planner-activate', disabled: !chk.ok, onclick: function () {
        if (!window.confirm('Activate ' + (b.label || 'Block 2') + ' from ' + HP.human(b.startDate) + ' to ' + HP.human(b.endDate) + '?\n\nOptions: ' + (HB.chosenOptions(b.options).join(', ') || 'none (Hold)') + '. You can cancel it before it starts or end it early later; logged workouts are never changed.')) return;
        var r = blocksWrite(function (raw) { return HB.activate(raw, b.id, today(), nowIso(), { approved: ui.approved, previewHash: hashAtRender }); }, { expectStamp: stampAtRender });
        if (r.ok) { delete plannerUi[b.id]; calBlock = undefined; renderToday(); }
      } }),
      h('button', { type: 'button', class: 'btn btn-small btn-delete', text: 'Delete draft', testid: 'planner-delete', onclick: function () {
        if (!window.confirm('Delete this inactive draft? Nothing else changes.')) return;
        blocksWrite(function (raw) { return HB.deleteDraft(raw, b.id); }, { expectStamp: stampAtRender });
      } })));
    return box;
  }
  function activePanel(b, t, sessions) {
    var ui = plannerUi[b.id] || (plannerUi[b.id] = { slot: '', kind: 'PLANNED_REST', text: '' });
    var stampAtRender = HB.settingsStamp(store);
    var box = h('div', { class: 'note', testid: 'planner-active' });
    var phase = t < b.startDate ? 'scheduled' : t > HB.lastDay(b) ? 'finished' : 'active';
    box.appendChild(h('div', { class: 'entry-title' }, h('span', { text: (b.label || 'Block 2') + ' · ' + fmtDate(b.startDate) + ' – ' + fmtDate(HB.lastDay(b)) }), badge(phase === 'active' ? 'Active' : phase === 'scheduled' ? 'Activated · starts ' + HP.humanShort(b.startDate) : 'Finished', phase === 'active' ? 'ok' : 'info', 'planner-active-state')));
    box.appendChild(h('p', { class: 'hint', testid: 'planner-approval', text: (b.approval ? b.approval.text : '') + ' ' + qatarTime(b.activatedAt) + '.' }));
    if (phase === 'scheduled') box.appendChild(h('p', { class: 'hint', text: 'Days before ' + HP.human(b.startDate) + ' are not counted and not missed.' }));
    var sum = HB.summary(b, sessions);
    box.appendChild(h('p', { class: 'hint', testid: 'planner-active-summary', text: sum.denominator + ' planned sessions: ' + sum.COMPLETED + ' completed · ' + sum.SKIPPED + ' skipped · ' + sum.PLANNED_REST + ' planned rest · ' + sum.NOT_IN_PLAN + ' not in plan · ' + sum.NOT_LOGGED + ' not logged. The 17-of-20 count stays your open decision.' }));
    (b.revisions || []).forEach(function (r) {
      var sl = b.slots.filter(function (x) { return x.id === r.slotId; })[0];
      box.appendChild(h('p', { class: 'hint', testid: 'planner-revision', text: (sl ? 'W' + sl.week + ' ' + sl.day + ' ' + fmtDate(sl.date) : r.slotId) + ': ' + (REVISION_LABEL[r.kind] || r.kind) + ' — set by you ' + qatarTime(r.at) + '.' }));
    });
    // revise a future, unlogged session (D10)
    var eligible = HB.effectiveSlots(b).filter(function (s) { return s.date > t && !s.notInPlan && !sessions.some(function (x) { return x.planSlotId === s.id; }); });
    // The revise controls redraw only themselves on change (focus stays on the control; the rest of Today is untouched).
    function reviseBox(focusId) {
      var rv = h('div', { testid: 'planner-revise-box' }, h('p', { class: 'list-heading', text: 'Change a future session (before the day, nothing logged yet)' }));
      function redraw(id) { var nb = reviseBox(id); rv.replaceWith(nb); }
      if (!ui.slot || !eligible.some(function (s) { return s.id === ui.slot; })) ui.slot = eligible[0].id;
      rv.appendChild(field('Session', select(eligible.map(function (s) { return [s.id, 'W' + s.week + ' ' + s.day + ' ' + fmtDate(s.date) + ' — ' + s.title + (s.plannedRest ? ' (planned rest)' : '')]; }), ui.slot, { testid: 'planner-revise-slot', onchange: function () { ui.slot = this.value; redraw('planner-revise-slot'); } })));
      rv.appendChild(field('Change to', select(HB.REVISION_KINDS.map(function (k) { return [k, REVISION_LABEL[k]]; }), ui.kind, { testid: 'planner-revise-kind', onchange: function () { ui.kind = this.value; redraw('planner-revise-kind'); } })));
      if (ui.kind === 'OWNER_TEXT') { var ta = h('textarea', { rows: '3', maxlength: '2300', testid: 'planner-revise-text', oninput: function () { ui.text = this.value; } }); ta.value = ui.text; rv.appendChild(field('Your prescription (1–8 lines; shown as owner-written)', ta)); }
      var rc = HB.revisionCheck(b, ui.slot, ui.kind, sessions, t, ui.kind === 'OWNER_TEXT' ? (ui.text || 'x') : '');
      if (!rc.ok) rv.appendChild(h('p', { class: 'note note-warn', testid: 'planner-revise-status', role: 'status', text: rc.text }));
      rv.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Save this change', testid: 'planner-revise', disabled: !rc.ok, onclick: function () {
        if (!window.confirm('Change this session to: ' + REVISION_LABEL[ui.kind] + '? The original plan stays in the block history. The 20-session count is unchanged.')) return;
        var r = blocksWrite(function (raw) { return HB.revise(raw, b.id, ui.slot, ui.kind, ui.text, recs('sessions'), today(), nowIso()); }, { expectStamp: stampAtRender });
        if (r.ok) { ui.text = ''; renderToday(); }
      } }));
      if (focusId) setTimeout(function () { var el = rv.querySelector('[data-testid="' + focusId + '"]'); if (el) el.focus(); }, 0);
      return rv;
    }
    if (eligible.length && phase !== 'finished') box.appendChild(reviseBox(null));
    var btns = h('div', { class: 'btn-row' });
    if (phase === 'scheduled') btns.appendChild(h('button', { type: 'button', class: 'btn btn-small btn-delete', text: 'Cancel this block (before it starts)', testid: 'planner-cancel', onclick: function () {
      if (!window.confirm('Cancel ' + (b.label || 'Block 2') + '? It has not started; it is kept for the record and has no effect.')) return;
      blocksWrite(function (raw) { return HB.cancel(raw, b.id, today(), nowIso()); }, { expectStamp: stampAtRender });
    } }));
    if (phase === 'active' && !b.endedEarlyOn) btns.appendChild(h('button', { type: 'button', class: 'btn btn-small btn-delete', text: 'End this block early (from tomorrow)', testid: 'planner-end-early', onclick: function () {
      if (!window.confirm('End ' + (b.label || 'Block 2') + ' from tomorrow? Later sessions show as "not in plan" (not missed, not skipped). Everything you logged is kept.')) return;
      blocksWrite(function (raw) { return HB.endEarly(raw, b.id, today()); }, { expectStamp: stampAtRender });
    } }));
    if (btns.childNodes.length) box.appendChild(btns);
    return box;
  }

  // ================= ADD: WORKOUT =================
  var ws = null;
  function blankSession() {
    return { date: today(), title: '', status: 'COMPLETED', modified: false, variant: 'ORIGINAL_60', planSlotId: null, planVersion: null,
      scheduledDate: null, durationMin: null, rpe: null, notes: '', blocks: [] };
  }
  function startSession(slot) {
    ws = blankSession();
    if (slot) applySlot(slot);
    go('add', 'workout');
  }
  function editSession(s) { ws = JSON.parse(JSON.stringify(s)); go('add', 'workout'); }
  function applySlot(slot) {
    ws.planSlotId = slot.id; ws.planVersion = slot.planVersion; ws.scheduledDate = slot.date; ws.title = slot.title;
    ws.blocks = PL.templateBlocks(slot);
    if (slot.date <= today()) ws.date = slot.date;
  }
  var BLOCK_NUMS = [['durationSec', 'Time (s)'], ['distanceM', 'Dist (m)'], ['loadKg', 'Load (kg)'], ['sets', 'Sets'], ['reps', 'Reps'], ['count', 'Count'], ['rpe', 'RPE']];

  function renderWorkoutForm(root) {
    if (!ws) ws = blankSession();
    var c = card(ws.id ? 'Edit workout log' : 'Log a workout (detailed)', 'session-form');
    if (draftRestoredAt) c.appendChild(h('p', { class: 'note note-warn', testid: 'workout-draft-restored', text: 'Unsaved workout restored on this device (last change ' + qatarTime(draftRestoredAt) +
      '). It is NOT saved yet: tap "' + (ws.id ? 'Save changes' : 'Save workout') + '" to keep it, or "Clear form" to discard it.' +
      (draftStartDay && draftStartDay !== today() ? ' It was started on ' + fmtDate(draftStartDay) + ' (Qatar date); its workout date is ' + fmtDate(ws.date) + ' and is never moved to today by itself.' : '') }));
    // Sprint B (P1.2): the same unsaved workout was saved or discarded in another tab of this app.
    if (draftOtherTab && !ws.id) c.appendChild(h('div', { class: 'note note-warn', role: 'alert', testid: 'session-other-tab' },
      h('p', { text: 'This unsaved workout was saved or discarded in another tab of this app. Saving it here as well could create a duplicate workout. Nothing has been saved from this tab.' }),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-secondary', text: 'Discard this copy', testid: 'session-other-tab-discard', onclick: function () { draftOtherTab = false; ws = blankSession(); clearDraft(); renderAdd(); } }),
        h('button', { type: 'button', class: 'btn btn-secondary', text: 'Keep it as a separate workout', testid: 'session-other-tab-keep', onclick: function () { draftOtherTab = false; draftId = null; saveDraft(); renderAdd(); } }))));
    var conflictBox = h('div', { testid: 'session-conflict-slot' });
    var err = h('p', { class: 'form-error', testid: 'session-error', 'aria-live': 'polite' });
    var slotOpts = [['', 'Not linked to the plan']].concat(HP.SLOTS.map(function (s) { return [s.id, 'W' + s.week + ' ' + s.day + ' ' + fmtDate(s.date) + ' — ' + s.title]; }));
    if (HB) HB.activated(blocks()).forEach(function (b) { HB.effectiveSlots(b).forEach(function (s) {
      slotOpts.push([s.id, (b.label || 'Block 2').replace(/^Block /, 'B') + ' W' + s.week + ' ' + s.day + ' ' + fmtDate(s.date) + ' — ' + s.title + (s.plannedRest ? ' (planned rest)' : s.notInPlan ? ' (not in plan)' : '')]); }); });
    // A link to a block that is no longer active is kept exactly as saved (never silently dropped).
    if (ws.planSlotId && !slotOpts.some(function (o) { return o[0] === ws.planSlotId; })) slotOpts.push([ws.planSlotId, 'Kept as saved: ' + ws.planSlotId + ' (not an active plan block)']);
    var slotSel = select(slotOpts, ws.planSlotId || '', { testid: 'session-slot' });
    slotSel.addEventListener('change', function () {
      var s = PL.slotById(slotSel.value);
      if (!s) { ws.planSlotId = null; ws.planVersion = null; ws.scheduledDate = null; renderAdd(); return; }
      if (ws.blocks.length && !window.confirm('Replace the current blocks with this session template? (No loads or times are filled in.)')) { slotSel.value = ws.planSlotId || ''; return; }
      applySlot(s); renderAdd();
    });
    c.appendChild(field('Planned session (source slot)', slotSel));
    var slot = ws.planSlotId ? PL.slotById(ws.planSlotId) : null;
    if (slot) {
      c.appendChild(h('details', { class: 'planned', open: true }, h('summary', { text: 'PLANNED (original, read-only) — scheduled ' + fmtDate(slot.date) }),
        h('ul', { class: 'rx' }, slot.prescription.map(function (l) { return h('li', { text: l }); }))));
      if (slot.revision) c.appendChild(h('p', { class: 'note note-warn', testid: 'session-slot-revised', text: slot.revision.ownerWritten ? 'Owner-written prescription (not source, not reviewed).' : 'Revised by you before the day (' + slot.revision.kind.replace(/_/g, ' ').toLowerCase() + '). The original plan is kept in the block history.' }));
      if (slot.plannedRest) c.appendChild(h('p', { class: 'note', testid: 'session-slot-planned-rest', text: 'Planned rest (your choice): not a skip, not missed. Log it only if you trained anyway.' }));
      var om = PL.omissionFor(slot.id, recs('planEvents'));
      if (om) c.appendChild(h('p', { class: 'note note-warn', text: 'This slot is omitted by source rule (' + om + ').' }));
    }
    c.appendChild(h('h3', { class: 'list-heading', text: 'ACTUAL' }));
    var date = h('input', { type: 'date', value: ws.date, max: today(), testid: 'session-date', onchange: function () { ws.date = this.value; renderAdd(); } });
    var title = h('input', { type: 'text', value: ws.title, maxlength: '80', testid: 'session-title', oninput: function () { ws.title = this.value; } });
    var status = select(HD.ENUMS.status.map(function (s) { return [s, s.replace('_', ' ')]; }), ws.status, { testid: 'session-status' });
    status.addEventListener('change', function () { ws.status = status.value; renderAdd(); });
    var variant = select([['ORIGINAL_60', 'Original 60 min'], ['SOURCE_45_MIN', 'Source 45-min fallback'], ['SOURCE_25_MIN', 'Source 25-min fallback'], ['OTHER_EXECUTION', 'Other execution'], ['NONE', 'None']], ws.variant, { testid: 'session-variant', onchange: function () { ws.variant = this.value; applyVariant(); renderAdd(); } });
    var modified = h('input', { type: 'checkbox', checked: ws.modified, testid: 'session-modified', onchange: function () { ws.modified = this.checked; } });
    c.appendChild(h('div', { class: 'row' }, field('Performed date', date), field('Actual completion', status)));
    if (slot && ws.date && ws.date !== slot.date && isWeekend(ws.date)) c.appendChild(h('p', { class: 'note note-warn', testid: 'session-weekend-note', text: 'Performed on a weekend: this is logged as ACTUAL work, not as a source-approved reschedule (v2.1 has no weekend gym make-up). The original ' + fmtDate(slot.date) + ' prescription is kept.' }));
    c.appendChild(field('Title', title));
    c.appendChild(h('div', { class: 'row' }, field('Prescribed variant (what you set out to follow)', variant), h('div', { class: 'field' }, h('label', { class: 'check' }, modified, h('span', { text: 'Modified from plan' })))));
    var vrx = variantRx(slot, ws.variant);
    if (vrx) c.appendChild(h('div', { class: 'note', testid: 'session-variant-rx' }, h('p', {}, h('strong', { text: 'Prescribed ' + VARIANT_LABEL[ws.variant] + (vrx.fromApi ? '' : ' (v2.1 §9, verbatim)') + ':' })),
      h('ul', { class: 'rx' }, vrx.lines.map(function (l) { return h('li', { text: l }); })),
      vrx.keep && vrx.keep.length ? h('p', { class: 'hint', testid: 'session-variant-keep', text: 'Kept: ' + vrx.keep.join('; ') }) : null,
      vrx.drop && vrx.drop.length ? h('p', { class: 'hint', testid: 'session-variant-drop', text: 'Dropped: ' + vrx.drop.join('; ') }) : null,
      vrx.unspecified && vrx.unspecified.length ? h('p', { class: 'hint', testid: 'session-variant-unspecified', text: 'Not specified by v2.1 (left for you to choose): ' + vrx.unspecified.join('; ') }) : null,
      h('p', { class: 'hint', text: 'Station choice, distances, loads, splits and reps are not specified by the source and are not filled in. Record only what you actually did; mark template blocks you did not do as "Not done".' })));
    if (ws.status === 'SKIPPED') {
      c.appendChild(h('label', { class: 'check note note-warn' }, h('input', { type: 'checkbox', checked: ws.skipConfirmed === true, testid: 'session-skip-confirm', onchange: function () { ws.skipConfirmed = this.checked; } }),
        h('span', { text: 'I confirm I skipped this session (never set automatically).' })));
      if (slot) c.appendChild(skipDecisionBlock(slot));
    }
    var dur = numIn(ws.durationMin, { testid: 'session-duration', oninput: function () { ws.durationMin = numOrNull(this.value); if (vsum) vsum.textContent = variantSummary(); } });
    var vsum = null;
    function variantSummary() { return 'Prescribed: ' + (VARIANT_LABEL[ws.variant] || ws.variant) + ' · Actual duration: ' + (typeof ws.durationMin === 'number' && !isNaN(ws.durationMin) ? ws.durationMin + ' min' : 'not recorded') + ' · Actual completion: ' + String(ws.status).replace('_', ' ') + '. Choosing a variant never marks a session done.'; }
    var rpe = numIn(ws.rpe, { min: '1', max: '10', testid: 'session-rpe', oninput: function () { ws.rpe = numOrNull(this.value); } });
    c.appendChild(h('div', { class: 'row' }, field('Actual duration (min)', dur), field('Session RPE (1–10)', rpe)));
    c.appendChild(field('How hard was it? (your own statement, optional)', select([['', 'Not stated'], ['EASY', 'Easy'], ['MODERATE', 'Moderate'], ['DEMANDING', 'Demanding']], ws.intensity || '', { testid: 'session-intensity',
      onchange: function () { if (this.value) ws.intensity = this.value; else delete ws.intensity; } }), 'Easy ≈ RPE 1–4 · Moderate ≈ RPE 5–6 · Demanding ≈ RPE 7–10 (hints only: the RPE number above is what you record). An easy walk and a workout can both be logged on the same day; Moderate and Demanding count as hard for the "never stack" rule.'));
    vsum = h('p', { class: 'hint', testid: 'session-variant-summary', text: variantSummary() });
    c.appendChild(vsum);
    if (RUN_STEP_STATUSES.indexOf(ws.status) !== -1) c.appendChild(runStepsBlock());

    c.appendChild(h('h3', { class: 'list-heading', text: 'Blocks in order (' + ws.blocks.length + ')' }));
    var list = h('div', { class: 'blocks', testid: 'session-blocks' });
    ws.blocks.forEach(function (b, i) { list.appendChild(blockRow(b, i)); });
    c.appendChild(list);
    var kindSel = select(HD.ENUMS.blockKind, 'run', { testid: 'block-add-kind', 'aria-label': 'Block type' });
    c.appendChild(h('div', { class: 'btn-row' }, kindSel, h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Add block', testid: 'block-add',
      onclick: function () { ws.blocks.push({ kind: kindSel.value, label: kindSel.value.replace(/_/g, ' '), machine: ['skierg', 'row', 'bike', 'elliptical'].indexOf(kindSel.value) !== -1 }); renderAdd(); } })));
    var notes = h('textarea', { rows: '2', maxlength: '2000', testid: 'session-notes', oninput: function () { ws.notes = this.value; } }); notes.value = ws.notes || '';
    c.appendChild(field('Notes', notes));
    c.appendChild(conflictBox);
    c.appendChild(err);
    c.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn btn-primary', text: ws.id ? 'Save changes' : 'Save workout', testid: 'session-save', onclick: function saveSession() {
        if (draftOtherTab && !ws.id) { err.textContent = 'Not saved: this workout was already saved or discarded in another tab. Choose "Discard this copy" or "Keep it as a separate workout" above.'; return; }
        if (sessionConflict(conflictBox, err, saveSession)) return;
        var bad = ws.blocks.some(function (b) { return BLOCK_NUMS.some(function (f) { return typeof b[f[0]] === 'number' && isNaN(b[f[0]]); }); });
        if (bad || (typeof ws.durationMin === 'number' && isNaN(ws.durationMin))) { err.textContent = 'Not saved: some numbers are invalid.'; return; }
        var rec = JSON.parse(JSON.stringify(ws));
        // Running steps (optional): whole number with a stated source, or not recorded (null). Never 0 for blank.
        // Only started, partial or completed sessions can carry running steps (contract); otherwise not recorded.
        if (RUN_STEP_STATUSES.indexOf(rec.status) === -1 || rec.runSteps === null || rec.runSteps === undefined) { rec.runSteps = null; rec.runStepsSource = null; }
        else { var rsErr = runStepsError(rec); if (rsErr) { err.textContent = 'Not saved: ' + rsErr; return; } }
        var applyCascade = null;
        // Phase 12: a link to a no-longer-active block keeps its skip decision exactly as saved.
        if (rec.status !== 'SKIPPED' || (!slot && !PL.isB(rec.planSlotId))) { delete rec.skipDecision; delete rec.rescheduledTo; }
        if (rec.status !== 'SKIPPED') delete rec.skipConfirmed;
        else if (slot) {
          // Owner rule 4: an explicit skip of a planned session always carries the owner's decision.
          if (!rec.skipDecision) { err.textContent = 'Not saved: choose what should happen to this skipped session — reschedule, skip permanently or adjust the rest of the week.'; return; }
          var others = recs('sessions').filter(function (x) { return x.id !== rec.id; });
          var stored = recs('sessions').filter(function (x) { return x.id === rec.id; })[0];
          if (rec.skipDecision === 'RESCHEDULE') {
            if ((!stored || stored.rescheduledTo !== rec.rescheduledTo) && rec.rescheduledTo && isWeekend(rec.rescheduledTo)) { err.textContent = 'Not saved: plan v2.1 has no weekend gym make-up. Choose "Skip permanently", or log weekend work as an actual session.'; return; }
            if (!stored || stored.rescheduledTo !== rec.rescheduledTo) {
              var chk = PL.rescheduleCheck(slot.id, rec.rescheduledTo, others, recs('planEvents'), today());
              if (!chk.ok) { err.textContent = 'Not saved: ' + chk.reason; return; }
            }
          } else delete rec.rescheduledTo;
          if (rec.skipDecision === 'ADJUST_WEEK') {
            var adv = PL.skipAdvice(slot.id, others, recs('planEvents'), today()).options.ADJUST_WEEK;
            if (adv.available) applyCascade = PL.isB(slot.id) ? { blockId: slot.blockId, kind: adv.kind, week: slot.week } : { kind: adv.kind, week: slot.week, date: slot.date };
            else if (!(stored && stored.skipDecision === 'ADJUST_WEEK')) { err.textContent = 'Not saved: ' + adv.note; return; }
          }
        }
        if (slot) { var o = PL.omissionFor(slot.id, recs('planEvents')); rec.sourceOmission = o || null; }
        if (slot && PL.isB(slot.id)) { var fe = HB.variantFamilyError(slot, rec.variantKind); if (fe) { err.textContent = 'Not saved: ' + fe; return; } }
        var res = persist('sessions', rec, err);
        if (res.ok && applyCascade && applyCascade.blockId) {
          // Phase 12: a Block 2 week adjustment is stored in that block only (never in the legacy week-only planEvents).
          var bev = blocksWrite(function (raw) { return HB.addEvent(raw, applyCascade.blockId, applyCascade.kind, applyCascade.week, today(), nowIso()); });
          if (!bev.ok) toast('The skip was saved, but the week adjustment was NOT saved. Apply it from the calendar on Today.', true);
        } else if (res.ok && applyCascade) {
          var ev = persist('planEvents', applyCascade);
          if (!ev.ok) toast('The skip was saved, but the week adjustment was NOT saved. Apply it from the calendar on Today.', true);
        }
        if (res.ok) { ws = null; clearDraft(); go('history'); }
      } }),
      h('button', { type: 'button', class: 'btn btn-secondary', text: 'Clear form', testid: 'session-clear', onclick: function () { ws = blankSession(); clearDraft(); renderAdd(); } })));
    root.appendChild(c);
  }

  // ---- running steps (dawit-steps-contract.md v1: sessions[].runSteps + runStepsSource) ----
  var RUN_STEP_STATUSES = ['IN_PROGRESS', 'COMPLETED', 'PARTIAL'];
  var STEP_SOURCES = [['', 'Choose where the number came from…'], ['DEVICE', 'Counted by my watch or phone'], ['MANUAL', 'I counted / typed it myself']];
  function runStepsError(r) {
    var v = r.runSteps;
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 200000) return 'running steps must be a whole number from 0 to 200,000, or left blank (= not recorded).';
    if (r.runStepsSource !== 'DEVICE' && r.runStepsSource !== 'MANUAL') return 'say where the running-steps number came from (watch/phone, or counted yourself).';
    return null;
  }
  function runStepsBlock() {
    var box = h('div', { class: 'note', testid: 'session-run-steps-box' });
    var inp = numIn(typeof ws.runSteps === 'number' ? ws.runSteps : null, { inputmode: 'numeric', step: '1', min: '0', max: '200000', placeholder: 'not recorded', testid: 'session-run-steps',
      oninput: function () { var v = numOrNull(this.value); ws.runSteps = v; if (v === null) { ws.runStepsSource = null; src.value = ''; } } });
    var src = select(STEP_SOURCES, ws.runStepsSource || '', { testid: 'session-run-steps-source', 'aria-label': 'Source of the running steps',
      onchange: function () { ws.runStepsSource = this.value || null; } });
    box.appendChild(field('Running steps (optional, whole number)', inp));
    box.appendChild(field('Where the number came from', src));
    box.appendChild(h('p', { class: 'hint', testid: 'session-run-steps-help', text: 'Steps taken during the running parts of THIS workout, as counted by your watch or phone, or counted by you. Leave blank if not measured: blank is saved as "not recorded", never 0. The app never estimates steps from distance or time. If you record a daily step total, that total is used and these steps are not added to it.' }));
    return box;
  }
  function qatarTime(iso) {
    var d = new Date(iso); if (isNaN(d)) return 'unknown time';
    return d.toLocaleString('en-GB', { timeZone: 'Asia/Qatar', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' Qatar';
  }
  // ---- unsaved workout draft (UI-only, survives a reload between sets; never part of hyrox.v1 or backups) ----
  // Sprint B (P1.2): same key and same {savedAt, ws} shape as before (older builds still read it). Added, optional
  // envelope fields: day (Qatar date the draft was started) and draftId (to notice a save in another tab). Bounded size,
  // shape-checked on load (a damaged draft is never restored silently), explicit two-step Discard, and a revision
  // check before an edit replaces a saved workout that changed elsewhere (another tab, a restore or a rollback).
  var DRAFT_KEY = 'hyrox.ui.workout-draft', draftRestoredAt = null, draftStartDay = null, draftId = null, draftOtherTab = false, conflictAck = null;
  var DRAFT_MAX_CHARS = 200000;
  function plainObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function draftShapeOk(w) {
    if (!plainObj(w) || !Array.isArray(w.blocks) || w.blocks.length > 300 || !w.blocks.every(plainObj)) return false;
    if (w.date != null && !(typeof w.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w.date))) return false;
    var strOk = ['id', 'title', 'notes', 'status', 'variant', 'planSlotId', 'scheduledDate', 'updatedAt', 'createdAt', 'intensity'].every(function (k) { return w[k] == null || typeof w[k] === 'string'; });
    var numOk = ['durationMin', 'rpe', 'runSteps'].every(function (k) { return w[k] == null || (typeof w[k] === 'number' && isFinite(w[k])); });
    return strOk && numOk;
  }
  function qatarDayOf(iso) {
    var d = new Date(iso); if (isNaN(d)) return null;
    try { return HD.todayQatar(d); } catch (e) { return null; }
  }
  function newDraftId() { return 'wd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function workoutDraftNote(dr) {
    var box = h('div', { class: 'note note-warn', testid: dr.invalid ? 'today-workout-draft-invalid' : 'today-workout-draft' });
    if (dr.invalid) box.appendChild(h('p', { text: 'An unsaved workout on this device could not be read (damaged or too large), so it was not restored. Nothing in your saved records is affected.' }));
    else {
      box.appendChild(h('p', { text: 'You have an unsaved workout on this device (last change ' + qatarTime(dr.savedAt) + '). It is not saved yet and does not count as done.' }));
      if (dr.day && dr.day !== today()) box.appendChild(h('p', { class: 'hint', testid: 'today-workout-draft-day', text: 'Started on ' + fmtDate(dr.day) + ' (Qatar date). Its workout date stays ' + fmtDate(dr.ws.date) + ' unless you change it.' }));
    }
    var row = h('div', { class: 'btn-row' });
    function buttons() {
      row.replaceChildren();
      if (!dr.invalid) row.appendChild(h('button', { type: 'button', class: 'btn btn-secondary', text: 'Resume unsaved workout', testid: 'today-workout-draft-continue', onclick: function () {
        if (!ws) { ws = dr.ws; draftRestoredAt = dr.savedAt; draftStartDay = dr.day || null; draftId = dr.draftId || null; } go('add', 'workout'); } }));
      row.appendChild(h('button', { type: 'button', class: 'btn btn-secondary', text: 'Discard…', testid: 'today-workout-draft-discard', onclick: function () {
        row.replaceChildren(h('p', { class: 'hint', text: 'Discard this unsaved workout? This cannot be undone. Saved workouts are not affected.' }),
          h('button', { type: 'button', class: 'btn btn-danger', text: 'Yes, discard it', testid: 'today-workout-draft-discard-yes', onclick: function () {
            if (!dr.invalid) ws = null; // the in-memory form IS this draft (every change is written to it)
            clearDraft(); renderToday(); } }),
          h('button', { type: 'button', class: 'btn btn-secondary', text: 'Keep it', testid: 'today-workout-draft-discard-keep', onclick: buttons }));
      } }));
    }
    buttons(); box.appendChild(row);
    return box;
  }
  // Before an edit replaces a stored workout: was that workout changed or removed since this edit started?
  function sessionConflict(slot, err, retry) {
    slot.replaceChildren();
    if (!ws.id) return false;
    var cur = recs('sessions').filter(function (x) { return x.id === ws.id; })[0] || null;
    if (!cur && damaged().some(function (d) { return d && d.id === ws.id; })) return false; // damaged records keep their own approval path
    var curStamp = cur ? (cur.updatedAt || cur.createdAt || null) : null;
    var missing = !cur, changed = !!cur && !!ws.updatedAt && curStamp !== ws.updatedAt;
    if (!missing && !changed) return false;
    if (conflictAck && conflictAck.id === ws.id && conflictAck.stamp === curStamp) return false;
    err.textContent = 'Not saved yet: choose below.';
    var box = h('div', { class: 'note note-warn', role: 'alert', testid: 'session-conflict' },
      h('p', { text: missing ? 'The saved workout this edit belongs to is no longer on this device (deleted, restored from an older backup or rolled back). Saving will store it again as a workout.'
        : 'This workout was changed elsewhere (another tab, or a restore) after you started this edit (saved version from ' + qatarTime(curStamp) + '). Saving would replace that newer version.' }));
    var row = h('div', { class: 'btn-row' });
    row.appendChild(h('button', { type: 'button', class: 'btn btn-secondary', text: missing ? 'Save it again' : 'Keep my version (replace it)', testid: 'session-conflict-keep-mine', onclick: function () {
      conflictAck = { id: ws.id, stamp: curStamp }; slot.replaceChildren(); retry(); } }));
    if (cur) row.appendChild(h('button', { type: 'button', class: 'btn btn-secondary', text: 'Load the saved version', testid: 'session-conflict-load-saved', onclick: function () {
      ws = JSON.parse(JSON.stringify(cur)); conflictAck = null; draftRestoredAt = null; saveDraft(); renderAdd(); } }));
    box.appendChild(row); slot.appendChild(box);
    try { box.scrollIntoView({ block: 'center' }); } catch (e) { /* */ }
    return true;
  }
  function draftWorthKeeping(w) {
    if (!w || typeof w !== 'object') return false;
    if (w.id || (w.notes && String(w.notes).trim()) || w.durationMin != null || w.rpe != null || w.runSteps != null || (w.status && w.status !== 'COMPLETED')) return true;
    if (!w.planSlotId && w.title && String(w.title).trim()) return true;
    return (w.blocks || []).some(function (b) { return b && (b.omitted || (b.exercise && String(b.exercise).trim()) || BLOCK_NUMS.some(function (f) { return b[f[0]] !== null && b[f[0]] !== undefined; })); });
  }
  function saveDraft() {
    if (draftOtherTab) return; // never re-create a draft another tab just saved or discarded
    try {
      if (!draftWorthKeeping(ws)) { localStorage.removeItem(DRAFT_KEY); draftStartDay = null; draftId = null; return; }
      if (!draftStartDay) draftStartDay = today();
      if (!draftId) draftId = newDraftId();
      var txt = JSON.stringify({ savedAt: new Date().toISOString(), ws: ws, day: draftStartDay, draftId: draftId });
      if (txt.length > DRAFT_MAX_CHARS) return; // bounded: an oversized draft is not kept (the last good one stays)
      localStorage.setItem(DRAFT_KEY, txt);
    } catch (e) { /* storage full or blocked: the draft simply is not kept */ }
  }
  function loadDraft() {
    var raw = null;
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return null; }
    if (raw === null || raw === undefined) return null;
    if (raw.length > DRAFT_MAX_CHARS) return { invalid: true };
    var d; try { d = JSON.parse(raw); } catch (e) { return { invalid: true }; }
    if (!plainObj(d) || !draftShapeOk(d.ws)) return { invalid: true };
    var day = typeof d.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day) ? d.day : qatarDayOf(d.savedAt);
    return { savedAt: d.savedAt, ws: d.ws, day: day, draftId: typeof d.draftId === 'string' ? d.draftId.slice(0, 40) : null };
  }
  function clearDraft() {
    draftRestoredAt = null; draftStartDay = null; draftId = null; conflictAck = null;
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
    Array.prototype.forEach.call(document.querySelectorAll('[data-testid="today-workout-draft"],[data-testid="today-workout-draft-invalid"]'), function (n) { n.remove(); });
  }

  // ---- Sprint B2 (owner decision M1, 23 Nov 2026): unsaved MEAL draft, UI-only key hyrox.ui.meal-draft ----
  // Never part of hyrox.v1, backups or restore; never counted (it is not a record). Restored ONLY by an explicit Resume.
  // Holds the typed meal (description, items, portions, amounts, edits) - never photo files, bytes, data/blob URLs, the
  // owner access code or any credential. Cleared only by a verified save or an explicit Discard; a refused or failed
  // save, leaving the form, or a reload keep it. Bounded size; a damaged draft is offered for Discard only.
  var MEAL_DRAFT_KEY = 'hyrox.ui.meal-draft', MEAL_DRAFT_MAX_CHARS = 200000;
  var mdId = null, mdDay = null, mdResumed = null, mdOtherTab = false, mdConflictAck = null, mdBlocked = false, mdTooBig = false, mdPhotoSeen = 0;
  var MD_DROP_KEYS = { image: 1, images: 1, photo: 1, photos: 1, dataUrl: 1, dataURL: 1, bytes: 1, blob: 1, url: 1, thumbnail: 1, originalBytes: 1, base64: 1, ownerCode: 1, apiKey: 1, authorization: 1, token: 1 };
  function resetMealDraftLink() { mdPhotoSeen = 0; mdId = null; mdDay = null; mdResumed = null; mdOtherTab = false; mdConflictAck = null; mdBlocked = false; mdTooBig = false; }
  function mdSecrets() {
    var out = [], code = ownerCode(); if (code && code.length >= 4) out.push(code);
    try { var s = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || 'null'); if (s && typeof s === 'object') Object.keys(s).forEach(function (k) { if (/key|token|secret|code/i.test(k) && typeof s[k] === 'string' && s[k].length >= 8) out.push(s[k]); }); } catch (e) { /* */ }
    return out;
  }
  // Deep copy keeping only plain data; drops photo/credential fields and any data:/blob: URL; removes stored secrets from text.
  function mdSanitize(x, secrets, depth) {
    if (depth > 12) return null;
    if (typeof x === 'string') {
      if (/^\s*(data|blob):/i.test(x)) return '';
      var t = x; secrets.forEach(function (sec) { while (t.indexOf(sec) !== -1) t = t.replace(sec, '[removed]'); });
      return t;
    }
    if (x === null || typeof x === 'number' || typeof x === 'boolean') return typeof x === 'number' && !isFinite(x) ? null : x;
    if (Array.isArray(x)) return x.slice(0, 300).map(function (v) { return mdSanitize(v, secrets, depth + 1); });
    if (typeof x === 'object') { var o = {}; Object.keys(x).forEach(function (k) { if (!MD_DROP_KEYS[k] && x[k] !== undefined && typeof x[k] !== 'function') o[k] = mdSanitize(x[k], secrets, depth + 1); }); return o; }
    return null;
  }
  function mdValOk(v) { return v == null || (plainObj(v) && typeof v.state === 'string' && (v.value === null || v.value === undefined || (typeof v.value === 'number' && isFinite(v.value)))); }
  function mealDraftShapeOk(m) {
    if (!plainObj(m) || !Array.isArray(m.components) || m.components.length > 200) return false;
    if (!(typeof m.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.date))) return false;
    if (!['id', 'time', 'label', 'source', 'description', 'lifecycle', 'mealCategory', 'updatedAt', 'createdAt'].every(function (k) { return m[k] == null || typeof m[k] === 'string'; })) return false;
    if (!(m.eatenFraction == null || (typeof m.eatenFraction === 'number' && isFinite(m.eatenFraction)))) return false;
    if (!(m.ai == null || plainObj(m.ai))) return false;
    return m.components.every(function (c) { return plainObj(c) && (c.name == null || typeof c.name === 'string') && HN.MACROS.every(function (k) { return mdValOk(c[k]); }); });
  }
  function newMealDraftId() { return 'md-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function mdStoredId() {
    var raw = null; try { raw = localStorage.getItem(MEAL_DRAFT_KEY); } catch (e) { return { none: true }; }
    if (raw === null || raw === undefined) return { none: true };
    try { var d = JSON.parse(raw); return { id: d && typeof d.draftId === 'string' ? d.draftId : null }; } catch (e) { return { id: null }; }
  }
  function estPendingNow() { return !!(est && Array.isArray(est.items) && est.items.length && !est.applied); }
  function saveMealDraft() {
    if (!ms || mdOtherTab) return;
    try {
      var dirty = draftKey(ms) !== msBase, st = mdStoredId();
      if (!dirty) { if (mdId && !st.none && st.id === mdId && !mdResumed) localStorage.removeItem(MEAL_DRAFT_KEY); return; }
      if (!st.none && (!mdId || st.id !== mdId)) { mdBlocked = true; return; } // an earlier draft waits: never overwrite it (its note is on the form and on Today)
      mdBlocked = false;
      if (photos.length > mdPhotoSeen) mdPhotoSeen = photos.length;
      if (!mdId) mdId = newMealDraftId();
      if (!mdDay) mdDay = today();
      var ctx = logCtx ? { cat: logCtx.cat || null, date: logCtx.date, fixed: !!logCtx.fixed, edit: !!logCtx.edit } : null;
      var env = { v: 1, kind: 'hyrox-meal-draft', savedAt: new Date().toISOString(), day: mdDay, draftId: mdId, baseUpdatedAt: ms.id ? (ms.updatedAt || null) : null,
        photoCount: Math.max(photos.length, mdPhotoSeen, mdResumed && !photos.length ? mdResumed.photoCount : 0), estimatePending: estPendingNow(), ctx: ctx, fromHistory: !!mealFromHistory, ms: mdSanitize(ms, mdSecrets(), 0) };
      var txt = JSON.stringify(env);
      if (txt.length > MEAL_DRAFT_MAX_CHARS) { mdTooBig = true; return; } // bounded: the last good copy stays
      mdTooBig = false;
      localStorage.setItem(MEAL_DRAFT_KEY, txt);
    } catch (e) { /* storage full or blocked: the draft simply is not kept */ }
  }
  function loadMealDraft() {
    var raw = null;
    try { raw = localStorage.getItem(MEAL_DRAFT_KEY); } catch (e) { return null; }
    if (raw === null || raw === undefined) return null;
    if (raw.length > MEAL_DRAFT_MAX_CHARS) return { invalid: true };
    var d; try { d = JSON.parse(raw); } catch (e) { return { invalid: true }; }
    if (!plainObj(d) || !mealDraftShapeOk(d.ms) || typeof d.savedAt !== 'string' || isNaN(new Date(d.savedAt))) return { invalid: true };
    var day = typeof d.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day) ? d.day : qatarDayOf(d.savedAt);
    var ctx = plainObj(d.ctx) && typeof d.ctx.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.ctx.date) ? { cat: knownCat(d.ctx.cat) ? d.ctx.cat : null, date: d.ctx.date, fixed: !!d.ctx.fixed, edit: !!d.ctx.edit } : null;
    var pc = typeof d.photoCount === 'number' && isFinite(d.photoCount) ? Math.max(0, Math.min(9, Math.round(d.photoCount))) : 0;
    return { savedAt: d.savedAt, day: day, draftId: typeof d.draftId === 'string' ? d.draftId.slice(0, 40) : null, photoCount: pc, estimatePending: d.estimatePending === true,
      ctx: ctx, fromHistory: d.fromHistory === true, ms: mdSanitize(d.ms, mdSecrets(), 0) };
  }
  // own=true: remove only the draft this form wrote (a different, earlier draft that waits is never removed by it).
  function clearMealDraft(own) {
    try { var st = mdStoredId(); if (!st.none && (!own || (mdId && st.id === mdId))) localStorage.removeItem(MEAL_DRAFT_KEY); } catch (e) { /* */ }
    Array.prototype.forEach.call(document.querySelectorAll('[data-testid="today-meal-draft"],[data-testid="today-meal-draft-invalid"]'), function (n) { n.remove(); });
  }
  function resumeMealDraft(md) {
    if (mdId && md.draftId === mdId && mealDirty()) { go('add', 'meal'); if (renderedMs !== ms) renderAdd(); return; } // already open in this tab
    withDraftDiscard(function () {
      resetMealDraft();
      logCtx = md.ctx; mealFromHistory = md.fromHistory && !md.ctx;
      ms = md.ms; msBase = '\u0000resumed'; // a resumed meal is unsaved work: leaving it always asks first
      mdId = md.draftId || newMealDraftId(); mdDay = md.day || today(); mdResumed = { savedAt: md.savedAt, photoCount: md.photoCount, estimatePending: md.estimatePending };
      go('add', 'meal'); renderAdd(); saveMealDraft();
      Array.prototype.forEach.call(document.querySelectorAll('[data-testid="today-meal-draft"]'), function (n) { n.remove(); });
    }, false, true);
  }
  function mealDraftNote(md, where) {
    var P = (where === 'today' ? 'today-meal-draft' : 'meal-draft-pending') + (md.invalid ? '-invalid' : '');
    var mine = !md.invalid && mdId && md.draftId === mdId;
    var box = h('div', { class: 'note note-warn', role: 'status', testid: P });
    if (md.invalid) box.appendChild(h('p', { text: 'An unsaved meal on this device could not be read (damaged or too large), so it was not restored. Nothing in your saved meals or day totals is affected.' }));
    else {
      box.appendChild(h('p', { text: (mine ? 'You are working on an unsaved meal' : 'You have an unsaved meal on this device') + ' (last change ' + qatarTime(md.savedAt) + '). It is not saved yet and does not count toward any day total.' }));
      if (md.ms.id) box.appendChild(h('p', { class: 'hint', testid: P + '-edit', text: 'It holds changes to a meal saved for ' + fmtDate(md.ms.date) + '; the saved meal stays as it is until you save.' }));
      if (md.day && md.day !== today()) box.appendChild(h('p', { class: 'hint', testid: P + '-day', text: 'Started on ' + fmtDate(md.day) + ' (Qatar date). Its meal date stays ' + fmtDate(md.ms.date) + ' unless you change it.' }));
      if (md.photoCount) box.appendChild(h('p', { class: 'hint', testid: P + '-photos', text: 'It had ' + md.photoCount + ' photo' + (md.photoCount === 1 ? '' : 's') + '. Photos are never kept in an unsaved meal: attach ' + (md.photoCount === 1 ? 'it' : 'them') + ' again after Resume if you want a new analysis.' }));
      if (where !== 'today' && !mine && mealDirty()) box.appendChild(h('p', { class: 'hint', testid: P + '-blocked', text: 'Until you resume or discard it, the meal you are typing now is not kept if the app is closed.' }));
    }
    var row = h('div', { class: 'btn-row' });
    function buttons() {
      row.replaceChildren();
      if (!md.invalid) row.appendChild(h('button', { type: 'button', class: 'btn btn-secondary', text: mine ? 'Open unsaved meal' : 'Resume unsaved meal', testid: P + '-resume', onclick: function () { resumeMealDraft(md); } }));
      row.appendChild(h('button', { type: 'button', class: 'btn btn-secondary', text: 'Discard…', testid: P + '-discard', onclick: function () {
        row.replaceChildren(h('p', { class: 'hint', text: 'Discard this unsaved meal? This cannot be undone. Saved meals are not affected.' }),
          h('button', { type: 'button', class: 'btn btn-danger', text: 'Yes, discard it', testid: P + '-discard-yes', onclick: function () {
            clearMealDraft(false);
            if (mine) { resetMealDraft(prefPath); logCtx = null; } else if (mdBlocked) mdBlocked = false;
            if (currentTab === 'today') renderToday(); if (addMode === 'meal') renderAdd(); } }),
          h('button', { type: 'button', class: 'btn btn-secondary', text: 'Keep it', testid: P + '-discard-keep', onclick: buttons }));
      } }));
    }
    buttons(); box.appendChild(row);
    return box;
  }
  function mealDraftFormNotes(c) {
    var md = loadMealDraft();
    if (md && (md.invalid || !mdId || md.draftId !== mdId)) c.appendChild(mealDraftNote(md, 'form'));
    if (mdResumed) {
      var rb = h('div', { class: 'note note-warn', role: 'status', testid: 'meal-draft-restored' },
        h('p', { text: 'Unsaved meal restored on this device (last change ' + qatarTime(mdResumed.savedAt) + '). It is NOT saved and not counted yet: tap "Confirm I ate this" to count it' + (ms.id ? ', or leave it to keep the saved meal as it was.' : ', or "Discard this draft".') }));
      if (mdDay && mdDay !== today()) rb.appendChild(h('p', { class: 'hint', testid: 'meal-draft-restored-day', text: 'Started on ' + fmtDate(mdDay) + ' (Qatar date); its meal date is ' + fmtDate(ms.date) + ' and is never moved to today by itself.' }));
      if (mdResumed.photoCount && !photos.length) rb.appendChild(h('p', { class: 'hint', testid: 'meal-draft-photos-reattach', text: 'Photos are not kept in unsaved meals. This meal had ' + mdResumed.photoCount + ' photo' + (mdResumed.photoCount === 1 ? '' : 's') + ': attach ' + (mdResumed.photoCount === 1 ? 'it' : 'them') + ' again below to analyse again. The items already listed are kept as they were.' }));
      if (mdResumed.estimatePending) rb.appendChild(h('p', { class: 'hint', testid: 'meal-draft-estimate-dropped', text: 'An estimate you had not added to the meal was not kept. Press the estimate button again if you need it.' }));
      if (ms.id) rb.appendChild(h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Discard my unsaved changes', testid: 'meal-discard-edit',
        onclick: function () { withDraftDiscard(function () { logCtx = null; resetMealDraft(prefPath); go('add', 'meal'); renderAdd(); }); } })));
      c.appendChild(rb);
    }
    if (mdTooBig) c.appendChild(h('p', { class: 'note note-warn', testid: 'meal-draft-too-big', text: 'This meal is too large to keep as an unsaved copy on this device; the last copy that fitted is kept. Save it to be safe.' }));
    if (mdOtherTab && !ms.id) c.appendChild(h('div', { class: 'note note-warn', role: 'alert', testid: 'meal-other-tab' },
      h('p', { text: 'This unsaved meal was saved or discarded in another tab of this app. Saving it here as well could count the same food twice. Nothing has been saved from this tab.' }),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-secondary', text: 'Discard this copy', testid: 'meal-other-tab-discard', onclick: function () { logCtx = null; resetMealDraft(prefPath); renderAdd(); } }),
        h('button', { type: 'button', class: 'btn btn-secondary', text: 'Keep it as a separate meal', testid: 'meal-other-tab-keep', onclick: function () { mdOtherTab = false; mdId = null; saveMealDraft(); renderAdd(); } }))));
  }
  // Before an edit replaces a stored meal: was that meal changed or removed since this edit started (another tab, a restore)?
  function mealConflict(slot, err, retry) {
    slot.replaceChildren();
    if (!ms.id) return false;
    var cur = recs('meals').filter(function (x) { return x.id === ms.id; })[0] || null;
    if (!cur && damaged().some(function (d) { return d && d.id === ms.id; })) return false;
    var curStamp = cur ? (cur.updatedAt || cur.createdAt || null) : null;
    var missing = !cur, changed = !!cur && !!ms.updatedAt && curStamp !== ms.updatedAt;
    if (!missing && !changed) return false;
    if (mdConflictAck && mdConflictAck.id === ms.id && mdConflictAck.stamp === curStamp) return false;
    err.textContent = 'Not saved yet: choose below. Nothing was saved.';
    var box = h('div', { class: 'note note-warn', role: 'alert', testid: 'meal-conflict' },
      h('p', { text: missing ? 'The saved meal this edit belongs to is no longer on this device (deleted, restored from an older backup or rolled back). Saving will store it again.'
        : 'This meal was changed elsewhere (another tab, or a restore) after you started this edit (saved version from ' + qatarTime(curStamp) + '). Saving would replace that newer version.' }));
    var row = h('div', { class: 'btn-row' });
    row.appendChild(h('button', { type: 'button', class: 'btn btn-secondary', text: missing ? 'Save it again' : 'Keep my version (replace it)', testid: 'meal-conflict-keep-mine', onclick: function () {
      mdConflictAck = { id: ms.id, stamp: curStamp }; slot.replaceChildren(); retry(); } }));
    if (cur) row.appendChild(h('button', { type: 'button', class: 'btn btn-secondary', text: 'Load the saved version', testid: 'meal-conflict-load-saved', onclick: function () {
      clearMealDraft(true); var keepCtx = logCtx, fromH = mealFromHistory; resetMealDraft(); logCtx = keepCtx; mealFromHistory = fromH; setDraft(JSON.parse(JSON.stringify(cur))); renderAdd(); } }));
    box.appendChild(row); slot.appendChild(box);
    try { box.scrollIntoView({ block: 'center' }); } catch (e) { /* */ }
    return true;
  }
  // Owner rule 4: the app asks and recommends; the owner chooses. The planned slot itself is never edited.
  function skipDecisionBlock(slot) {
    var others = recs('sessions').filter(function (x) { return x.id !== ws.id; });
    var adv = noWeekendMakeup(PL.skipAdvice(slot.id, others, recs('planEvents'), today()));
    var box = h('div', { class: 'note', testid: 'skip-decision' });
    box.appendChild(h('p', {}, h('strong', { text: 'What should happen to this session?' }), ' The original planned session stays on record whatever you choose.'));
    box.appendChild(h('p', { class: 'hint', testid: 'skip-recommendation', text: adv.recommendation }));
    [['RESCHEDULE', 'Reschedule to another day'], ['SKIP_PERMANENT', 'Skip permanently'], ['ADJUST_WEEK', 'Adjust the rest of the week']].forEach(function (o) {
      var opt = adv.options[o[0]], current = ws.skipDecision === o[0];
      box.appendChild(h('label', { class: 'check' }, h('input', { type: 'radio', name: 'skip-decision', value: o[0], checked: current, disabled: !opt.available && !current, testid: 'skip-' + o[0].toLowerCase(),
        onchange: function () { ws.skipDecision = o[0]; if (o[0] !== 'RESCHEDULE') ws.rescheduledTo = null; else if (!ws.rescheduledTo) ws.rescheduledTo = (opt.dates || []).filter(function (x) { return !isWeekend(x); })[0] || null; renderAdd(); } }),
        h('span', { text: o[1] + (adv.recommended === o[0] ? ' (recommended)' : '') })));
      box.appendChild(h('p', { class: 'hint', testid: 'skip-' + o[0].toLowerCase() + '-note', text: opt.note }));
    });
    if (ws.skipDecision === 'RESCHEDULE') {
      // Only weekdays are ever offered. A weekend date already saved on this record (legacy, before the
      // no-weekend rule) is kept truthfully as a labelled legacy entry; a weekend date from a draft is dropped.
      var dates = adv.options.RESCHEDULE.dates.filter(function (d) { return !isWeekend(d); });
      var storedRec = recs('sessions').filter(function (x) { return x.id === ws.id; })[0];
      var legacyWknd = ws.rescheduledTo && isWeekend(ws.rescheduledTo) && storedRec && storedRec.rescheduledTo === ws.rescheduledTo ? ws.rescheduledTo : null;
      if (ws.rescheduledTo && isWeekend(ws.rescheduledTo) && !legacyWknd) ws.rescheduledTo = dates[0] || null;
      var opts = dates.map(function (d) { return [d, fmtDate(d)]; });
      if (legacyWknd) opts.unshift([legacyWknd, 'Kept from earlier record: ' + fmtDate(legacyWknd) + ' (weekend — not a source-approved make-up)']);
      else if (ws.rescheduledTo && dates.indexOf(ws.rescheduledTo) === -1) opts.unshift([ws.rescheduledTo, fmtDate(ws.rescheduledTo)]);
      if (!opts.length) opts = [['', 'No weekday available']];
      var sel = select(opts, ws.rescheduledTo || '', { testid: 'skip-reschedule-date', onchange: function () { ws.rescheduledTo = this.value; renderAdd(); } });
      box.appendChild(field('Reschedule to', sel));
      var chk = PL.rescheduleCheck(slot.id, ws.rescheduledTo, others, recs('planEvents'), today());
      box.appendChild(h('p', { class: 'hint', testid: 'skip-reschedule-caution', text: chk.ok ? chk.caution : chk.reason }));
    }
    return box;
  }

  // Dawit D3: prescribed variant fields come only from HP.variantPrescription; the actual duration and
  // completion are never touched. Template blocks are offered, never forced, and carry no loads/reps/splits.
  function applyVariant() {
    var slot = ws.planSlotId ? PL.slotById(ws.planSlotId) : null;
    var api = slot ? PL.variantPrescription(slot.id, ws.variant) : undefined;
    if (!api || typeof api !== 'object') { delete ws.variantKind; delete ws.prescribedDurationMin; return; }
    ws.variantKind = api.variantKind; ws.prescribedDurationMin = api.prescribedDurationMin;
    if (Array.isArray(api.blocks) && api.blocks.length) {
      var hasValues = ws.blocks.some(function (b) { return BLOCK_NUMS.some(function (f) { return b[f[0]] !== null && b[f[0]] !== undefined; }); });
      if (window.confirm('Use the ' + (VARIANT_LABEL[ws.variant] || ws.variant) + ' block list from the source?' + (hasValues ? ' Numbers you already typed in the current blocks will be replaced.' : '') + ' (No loads, reps or times are filled in.)'))
        ws.blocks = JSON.parse(JSON.stringify(api.blocks));
    }
  }

  // Owner decision t47u, 2 (v2.1 §5/§9): Saturday/Sunday are never offered as a make-up for a missed
  // Mon–Fri gym session. UI guard until Dawit's plan layer drops them (PENDING round-2 contract).
  function noWeekendMakeup(adv) {
    if (!adv || !adv.options || !adv.options.RESCHEDULE) return adv;
    var r = adv.options.RESCHEDULE, dates = (r.dates || []).filter(function (d) { return !isWeekend(d); });
    if (dates.length === (r.dates || []).length) return adv;
    adv.options.RESCHEDULE = { available: dates.length > 0, dates: dates, weekendRemoved: true,
      note: dates.length ? 'Free weekdays without another session: ' + dates.join(', ') + '. Outside the approved cascade - your decision. Weekends are not offered (v2.1: no weekend gym make-up).'
        : 'Not available: plan v2.1 has no weekend gym make-up, and every weekday already has a session (two hard sessions are never stacked). Optional light Saturday activity and Sunday mobility are not make-ups.' };
    if (adv.recommended === 'RESCHEDULE') adv.recommended = 'SKIP_PERMANENT';
    return adv;
  }

  function blockRow(b, i) {
    var row = h('div', { class: 'block', testid: 'block-row' });
    var comp = HP.machineCompliance(b);
    row.appendChild(h('div', { class: 'entry-title' },
      h('span', { text: (i + 1) + '. ' }),
      select(HD.ENUMS.blockKind, b.kind, { 'aria-label': 'Block ' + (i + 1) + ' type', onchange: function () { b.kind = this.value; renderAdd(); } }),
      comp ? badge(comp === 'WITHIN_LIMIT' ? '≤15 min' : comp, comp === 'OVERRUN' || comp === 'CONFLICT' ? 'bad' : comp === 'UNVERIFIED' ? 'muted' : 'ok', 'block-compliance') : null));
    row.appendChild(h('input', { type: 'text', value: b.label || '', maxlength: '80', 'aria-label': 'Block ' + (i + 1) + ' label', oninput: function () { b.label = this.value; } }));
    if (b.kind === 'strength_set') {
      row.appendChild(h('div', { class: 'row' },
        field('Exercise', h('input', { type: 'text', value: b.exercise || '', maxlength: '80', oninput: function () { b.exercise = this.value; } })),
        field('Set type', select(['WORKING', 'WARMUP'], b.setType || 'WORKING', { onchange: function () { b.setType = this.value; } }))));
    }
    if (b.optional || b.sourceStatus === 'UNSPECIFIED' || typeof b.prescribedSets === 'number' || typeof b.prescribedDurationSec === 'number' || (Array.isArray(b.stationOptions) && b.stationOptions.length))
      row.appendChild(h('p', { class: 'hint', testid: 'block-prescribed', text: [b.optional ? 'Optional' : null, b.sourceStatus === 'UNSPECIFIED' ? 'not specified by v2.1 §9' : null,
        typeof b.prescribedSets === 'number' ? 'prescribed ' + b.prescribedSets + ' working sets' : null, typeof b.prescribedDurationSec === 'number' ? 'prescribed ' + Math.round(b.prescribedDurationSec / 60) + ' min' : null,
        Array.isArray(b.stationOptions) && b.stationOptions.length ? 'station options: ' + b.stationOptions.join(', ') : null].filter(Boolean).join(' · ') + '. Record only what you actually did.' }));
    var grid = h('div', { class: 'num-grid' });
    BLOCK_NUMS.forEach(function (f) {
      var inp = numIn(b[f[0]], { 'aria-label': f[1], testid: 'block-' + f[0], oninput: function () { b[f[0]] = numOrNull(this.value); if (f[0] === 'durationSec') { var badgeEl = row.querySelector('[data-testid="block-compliance"]'); var nc = HP.machineCompliance(b); if (badgeEl && nc) badgeEl.textContent = nc === 'WITHIN_LIMIT' ? '≤15 min' : nc; } } });
      grid.appendChild(h('label', { class: 'mini' }, h('span', { text: f[1] }), inp));
    });
    row.appendChild(grid);
    row.appendChild(h('div', { class: 'btn-row' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: b.machine === true, onchange: function () { b.machine = this.checked; renderAdd(); } }), h('span', { text: 'Machine bout' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: b.omitted === true, testid: 'block-omitted', onchange: function () { b.omitted = this.checked; } }), h('span', { text: 'Not done (omitted)' })),
      h('button', { type: 'button', class: 'btn btn-small btn-secondary', text: '↑', 'aria-label': 'Move up', onclick: function () { if (i > 0) { ws.blocks.splice(i - 1, 0, ws.blocks.splice(i, 1)[0]); renderAdd(); } } }),
      h('button', { type: 'button', class: 'btn btn-small btn-delete', text: 'Remove', 'aria-label': 'Remove block ' + (i + 1), onclick: function () { ws.blocks.splice(i, 1); renderAdd(); } })));
    return row;
  }

  // ================= ADD: MEAL =================
  var ms = null, photos = [], aiSession = null;
  // eatenFraction null on an item = use the meal-level amount.
  function blankComponent() { return { name: '', role: 'MAIN', portion: '', preparation: '', eatenFraction: null, kcal: HN.unknown(), proteinG: HN.unknown(), carbsG: HN.unknown(), fatG: HN.unknown() }; }
  function blankMeal(source) {
    var t = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Qatar', hour: '2-digit', minute: '2-digit' });
    // A typed meal defaults to 100% eaten (the owner enters what they ate). A photographed meal has
    // NO default: how much was eaten must be stated before it can be confirmed.
    return { date: today(), time: t, label: '', source: source || 'MANUAL', description: '', eatenFraction: source === 'PHOTO_AI' ? null : 1,
      components: source === 'PHOTO_AI' ? [] : [blankComponent()], ai: null, lifecycle: 'DRAFT' };
  }
  // P10b (owner P0, 18 Nov 2026): the meal form never shows or reuses a previous meal. msBase is the draft as it was
  // started or loaded; anything typed, chosen or analysed since makes it "unsaved", and it is never discarded silently.
  var msBase = null, renderedMs = null;
  // P11: for a NEW entry the diary category alone is not "unsaved work" (it is kept when the input path changes), so
  // choosing Lunch never triggers a discard prompt; for an edit of a saved meal a changed category does count.
  function draftKey(m) { if (!m) return null; if (m.id) return JSON.stringify(m); var c = {}; Object.keys(m).forEach(function (k) { if (k !== 'mealCategory') c[k] = m[k]; }); return JSON.stringify(c); }
  var uncatChosen = false; // P0: the owner pressed "Uncategorized" for the draft on screen (UI state only, never stored)
  function setDraft(m) { ms = m; msBase = draftKey(m); uncatChosen = false; }
  // ignorePhotos: switching the input path inside the form only drops photos that were never analysed (they are
  // still on the phone and can be chosen again); typed or analysed content always asks first.
  function mealDirty(ignorePhotos) { // ignorePhotos is no longer used by any caller (Claude P10b review)
    if (!ignorePhotos && (photos.length || photoBusy > 0)) return true;
    if (est && Array.isArray(est.items) && est.items.length && !est.applied) return true;
    return !!ms && draftKey(ms) !== msBase;
  }
  // Claude P10b review: an in-app dialog instead of window.confirm. iOS Safari is documented to stop showing
  // alert/confirm after back/forward (BFCache) navigation, which this app restores from (pageshow); a confirm that
  // silently returned false would leave the owner unable to start a new meal. The safe choice is focused first,
  // Escape keeps, and only one dialog can be open.
  var choiceOpen = null;
  function askChoice(o) {
    if (choiceOpen) choiceOpen.remove();
    var titleId = 'choice-title-' + Date.now(), bodyId = titleId + '-body';
    function close(fn) { if (box.parentNode) box.remove(); choiceOpen = null; document.removeEventListener('keydown', onKey, true); if (fn) fn(); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(o.onNo); } }
    var keep = h('button', { type: 'button', class: 'btn btn-primary', text: o.no, testid: 'choice-keep', onclick: function () { close(o.onNo); } });
    var go2 = h('button', { type: 'button', class: 'btn btn-delete', text: o.yes, testid: 'choice-yes', onclick: function () { close(o.onYes); } });
    var box = h('div', { class: 'choice-overlay', testid: 'choice-dialog' },
      h('div', { class: 'choice-box', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': bodyId },
        h('p', { class: 'choice-title', id: titleId, testid: 'choice-title', text: o.title }),
        h('p', { id: bodyId, testid: 'choice-body', text: o.body }),
        h('div', { class: 'btn-row' }, keep, go2)));
    document.body.appendChild(box); choiceOpen = box;
    document.addEventListener('keydown', onKey, true);
    keep.focus();
  }
  // Runs proceed() at once for an empty or unchanged draft; otherwise asks first. Keeping the draft shows it again.
  function withDraftDiscard(proceed, ignorePhotos, keepStored) {
    if (!mealDirty(ignorePhotos)) { proceed(); return; }
    askChoice({ title: 'Discard the meal you have not saved yet?',
      body: 'Its items, note' + (photos.length || photoBusy > 0 ? ', photos' : '') + ' and any estimate will be cleared' + (ms && ms.date ? ' (meal dated ' + ms.date + ')' : '') + '. Saved meals are not affected.',
      yes: 'Discard it', no: 'Keep editing', onYes: function () { if (!keepStored) clearMealDraft(true); proceed(); }, onNo: function () { go('add', 'meal'); if (renderedMs !== ms) renderAdd(); } });
  }
  // Everything that belongs to one meal draft is cleared: items, note, amounts, estimate, photos (and their bytes),
  // consent (rendered per form), request id (draftNonce, in dropPhoto) and messages. Saved meals are never touched.
  var mealNameOpen = false;
  function resetMealDraft(source) { mealNameOpen = false; dropPhoto(); dropEstimate(); eatenCustom = false; lastAiWarnings = null; mealFromHistory = false; foodScr = null; setDraft(blankMeal(source || 'MANUAL')); resetMealDraftLink(); }
  var mealFromHistory = false, diaryJustSaved = null;
  function startMeal(source) { withDraftDiscard(function () { logCtx = null; resetMealDraft(source); go('add', 'meal'); renderAdd(); }); }
  // History Edit / Copy keep their Phase 10b behaviour (Add tab, then back to History); the diary passes a logger context.
  // P11.1: History's own Edit / Copy (no diary context) keep returning to History after a save (existing behaviour);
  // every other meal started on Add > Meal returns to the diary of its date after a CONFIRMED save.
  function editMeal(m, ctx) { withDraftDiscard(function () { logCtx = ctx || null; resetMealDraft(); setDraft(JSON.parse(JSON.stringify(m))); mealFromHistory = !logCtx; go('add', 'meal'); renderAdd(); if (logCtx) focusTestid('logger-title'); }); }
  function copyMeal(m, keepCtx) { withDraftDiscard(function () { if (!keepCtx) logCtx = null; copyMealNow(m); if (!keepCtx) mealFromHistory = true; }); }
  function copyMealNow(m) {
    resetMealDraft();
    ms = JSON.parse(JSON.stringify(m));
    ['id', 'createdAt', 'updatedAt', 'confirmedAt', 'revisions', 'legacy'].forEach(function (k) { delete ms[k]; });
    ms.source = 'COPY'; ms.copiedFrom = m.id; ms.lifecycle = 'DRAFT'; ms.date = logCtx ? logCtx.date : today();
    // P11: a copy made inside "Log lunch" goes to that diary slot; elsewhere it keeps the category it was saved with.
    if (logCtx && logCtx.cat) ms.mealCategory = logCtx.cat;
    msBase = draftKey(ms);
    go('add', 'meal'); renderAdd(); toast('Copied as a new DRAFT for ' + (ms.date === today() ? 'today' : fmtDate(ms.date)) + ' — review and confirm it.');
  }
  // ---------- P11 meal diary categories and the dedicated logger ----------
  // Optional record field `mealCategory` (BREAKFAST | LUNCH | DINNER | SNACKS). Absent = an earlier or uncategorised
  // meal; it is never filled in from the time of day, and records are never rewritten to add one. A value this build
  // does not know is kept exactly as stored and the meal is listed under "Uncategorized / Earlier meals".
  var MEAL_CATS = [['BREAKFAST', 'Breakfast'], ['LUNCH', 'Lunch'], ['DINNER', 'Dinner'], ['SNACKS', 'Snacks']];
  function knownCat(c) { return MEAL_CATS.some(function (x) { return x[0] === c; }); }
  function catName(c) { var f = MEAL_CATS.filter(function (x) { return x[0] === c; })[0]; return f ? f[1] : null; }
  // logCtx: the dedicated full-screen logger is open for {cat, date}. fixed = the date was chosen on purpose (not today)
  // and is never moved at midnight. edit = an existing record was opened from the diary.
  var logCtx = null, prefPath = 'MANUAL';
  function openLogger(cat, date, source) {
    withDraftDiscard(function () {
      logCtx = { cat: cat || null, date: date, fixed: date !== today(), edit: false };
      resetMealDraft(source || prefPath);
      ms.date = date; if (cat) ms.mealCategory = cat;
      msBase = draftKey(ms);
      go('add', 'meal'); renderAdd(); focusTestid('logger-title');
    });
  }
  function loggerTitle() {
    var c = ms && knownCat(ms.mealCategory) ? catName(ms.mealCategory).toLowerCase() : null;
    return (ms && ms.id ? 'Edit ' : 'Log ') + (c || (ms && ms.id ? 'meal' : 'a meal'));
  }
  // Back / Cancel: an unfinished entry (typed, chosen, analysed or with photos) is never dropped without the Keep/Discard dialog.
  function loggerBack() {
    var ctx = logCtx;
    withDraftDiscard(function () {
      logCtx = null; resetMealDraft(prefPath);
      // a past day chosen on purpose stays in the diary; a logger opened for "today" returns to the current today
      if (ctx && ctx.fixed) setDiaryDate(ctx.date); else diaryDate = null;
      renderAdd(); go('add', 'meal'); refresh();
      focusTestid(ctx && knownCat(ctx.cat) ? 'diary-log-' + ctx.cat.toLowerCase() : 'diary-heading');
    });
  }
  // Claude P11 review: the tapped "+ Log" / "Back" / "Confirm" button is removed by the re-render, which left keyboard and
  // VoiceOver focus on <body>. Focus now moves to the logger heading on open and back to that meal's diary row on return.
  function focusTestid(id) {
    var el = id && document.querySelector('[data-testid="' + id + '"]');
    if (!el) el = document.getElementById('diary-heading');
    if (!el || !el.focus) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }
  function syncLogger() { document.body.classList.toggle('logger-open', currentTab === 'add' && addMode === 'meal' && (!!logCtx || !!foodScr)); }
  // ---------- P6 text nutrition estimate (Dawit's HyroxFoodCalc; USDA FoodData Central) ----------
  // The UI only drives parse/estimate/estimateItem/toComponents. It owns loading of the lazy food-db.js script.
  // Nothing here saves or counts anything: estimates become DRAFT components; only "Confirm I ate this" confirms.
  var est = null, estComps = [];
  function dropEstimate() { est = null; estComps = []; }
  var dbLoad = null; // null | 'loading' | 'ready' | {code,message}
  var DATASETS = { SR: 'SR Legacy', FF: 'Foundation Foods', FN: 'FNDDS 2021-2023 (survey)' };
  function dsName(d) { return DATASETS[d] || String(d || 'USDA'); }
  function loadFoodDb(cb) {
    var FC = window.HyroxFoodCalc;
    if (!FC) { cb({ code: 'db_not_loaded', message: 'The food estimate module is not available in this version.' }); return; }
    if (window.HyroxFoodDb) { cb(null); return; }
    var sc = document.createElement('script');
    sc.src = 'src/data/food-db.js';
    sc.onload = function () { cb(window.HyroxFoodDb ? null : { code: 'db_not_loaded', message: 'The food data file loaded but contained no data.' }); };
    sc.onerror = function () { cb({ code: 'db_not_loaded', message: 'The food data file (src/data/food-db.js) could not be loaded.' }); };
    document.head.appendChild(sc);
  }
  // Phase 11.3: the larger US list (USDA FNDDS 2021-2023 + fiber/sodium for the original foods), one more static file loaded
  // only when Add foods opens. Optional: if it cannot load, search still runs on the original 8,167 foods and says so.
  var usLoad = null; // null | 'loading' | 'ready' | 'failed'
  // RC1 review (A-01): one request at a time. Every caller waits for the same in-flight load (the Describe path and Add
  // foods used to add a second <script> for the same 1.25 MB file, and a failed second copy could leave search on the
  // 8,167 foods although the first copy had loaded). After a failure the next Add foods open tries again.
  var usWaiters = [];
  function loadFoodDbUs(cb) {
    if (window.HyroxFoodDbUs) { usLoad = 'ready'; cb(true); return; }
    usWaiters.push(cb);
    if (usLoad === 'loading') return;
    usLoad = 'loading';
    function done() {
      usLoad = window.HyroxFoodDbUs ? 'ready' : 'failed';
      var ws = usWaiters; usWaiters = [];
      ws.forEach(function (f) { try { f(usLoad === 'ready'); } catch (e) { /* one caller never blocks the others */ } });
    }
    var sc = document.createElement('script');
    sc.src = 'src/data/food-db-us.js';
    sc.onload = done;
    sc.onerror = function () { if (sc.parentNode) sc.parentNode.removeChild(sc); done(); };
    document.head.appendChild(sc);
  }
  function round1(x) { return Math.round(x * 10) / 10; }
  function estTotals(items) {
    var t = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, matched: 0, unmatched: 0 };
    items.forEach(function (it) {
      if (it.status === 'matched' && it.nutrients) { t.matched++; ['kcal', 'proteinG', 'carbsG', 'fatG'].forEach(function (k) { t[k] += Number(it.nutrients[k]) || 0; }); }
      else t.unmatched++;
    });
    t.kcal = Math.round(t.kcal); ['proteinG', 'carbsG', 'fatG'].forEach(function (k) { t[k] = round1(t[k]); });
    return t;
  }
  function nutrLine(n) { return fmt(n.kcal) + ' kcal · protein ' + fmt(n.proteinG) + ' g · carbs ' + fmt(n.carbsG) + ' g · fat ' + fmt(n.fatG) + ' g'; }
  var BASIS = { mass: 'as typed, grams', usda_portion: 'USDA household measure', alias_default: 'assumed default size', user_grams: 'grams you entered' };
  function portionText(t) { var m = /^(.*?)\s*\[(\w+)\]$/.exec(String(t)); return m ? m[1] + ' (' + (BASIS[m[2]] || m[2]) + ')' : String(t); }
  function provText(p) {
    if (!p) return '';
    return 'USDA FoodData Central (' + dsName(p.dataset) + '), fdcId ' + p.fdcId + ', “' + (p.description || '') + '”' + (p.portion ? '; portion used: ' + portionText(typeof p.portion === 'string' ? p.portion : p.portion.label || '') : '') +
      (typeof p.grams === 'number' ? ' (' + fmt(p.grams) + ' g)' : '') + (p.dbVersion ? '; data ' + p.dbVersion : '');
  }

  function estimateBlock(rerenderMeal) {
    var FC = window.HyroxFoodCalc;
    var box = h('section', { class: 'estimate-box', testid: 'meal-estimate', 'aria-labelledby': 'meal-estimate-title' });
    box.appendChild(h('h3', { class: 'list-heading', id: 'meal-estimate-title', text: 'Estimate nutrition from what you typed' }));
    box.appendChild(h('p', { class: 'hint', testid: 'estimate-help', text: 'Type foods with amounts in the description, e.g. “2 eggs, 150 g rice, 1 cup milk”. Numbers are ESTIMATES from USDA FoodData Central reference foods (per 100 g); real dishes differ. Items with no match are never guessed. Nothing counts until you press “Confirm I ate this”.' }));
    var out = h('div', { testid: 'estimate-out', 'aria-live': 'polite' });
    var run = h('button', { type: 'button', class: 'btn btn-secondary', text: 'Estimate from description', testid: 'estimate-run' });
    box.appendChild(run); box.appendChild(out);

    var applyBtn = null, applyHint = null, appliedNote = null, errSeq = 0;
    function anyBad() { return !!est && !!est.bad && Object.keys(est.bad).length > 0; }
    function syncApply() {
      var bad = anyBad();
      if (applyBtn) { applyBtn.disabled = bad; applyBtn.setAttribute('aria-disabled', bad ? 'true' : 'false'); }
      if (applyHint) { applyHint.hidden = !bad; }
      // an edit after "Use these estimates" makes the meal differ from the screen: the "added" note must go
      if (appliedNote && !(est && est.applied)) { appliedNote.remove(); appliedNote = null; }
    }
    // An invalid quantity/grams (empty, NaN, <= 0) must never leave the previous estimate standing in for it.
    function markBad(i, which, node, tot, qtyEl, gramsEl) {
      var cur = est.items[i];
      if (!est.bad[i]) est.items[i] = Object.assign({}, cur, { status: 'unparsed', nutrients: null, provenance: null, grams: null, portion: null, message: 'Enter an amount greater than 0.' });
      est.bad[i] = which; est.applied = false;
      ['estimate-nutrients', 'estimate-source', 'estimate-note', 'estimate-noportion', 'estimate-needqty'].forEach(function (id) { var e = node.querySelector('[data-testid="' + id + '"]'); if (e) e.remove(); });
      node.setAttribute('data-status', 'unparsed'); node.setAttribute('data-invalid', 'true');
      var bd = node.querySelector('[data-testid="estimate-status"]'); if (bd) { bd.textContent = 'Enter an amount'; bd.className = 'badge badge-warn'; }
      var err = node.querySelector('[data-testid="estimate-input-error"]');
      if (!err) {
        err = h('p', { class: 'note note-warn', testid: 'estimate-input-error', id: 'estimate-err-' + (++errSeq) });
        err.setAttribute('role', 'alert');
        node.appendChild(err);
      }
      err.textContent = (which === 'grams' ? 'Grams' : 'Quantity') + ' must be a number greater than 0. This item is left out of the total until you fix it.';
      [qtyEl, gramsEl].forEach(function (el) { if (el) el.setAttribute('aria-describedby', err.id); });
      var badEl = which === 'grams' ? gramsEl : qtyEl; if (badEl) badEl.setAttribute('aria-invalid', 'true');
      drawTotals(tot); syncApply();
    }
    function msg(text, kind) { out.replaceChildren(h('p', { class: 'note' + (kind ? ' note-' + kind : ''), text: text, testid: 'estimate-message' })); }
    function sourceLine(it) {
      return it.provenance ? h('p', { class: 'hint', testid: 'estimate-source', text: 'Source: ' + provText(it.provenance) + '. Estimate, not a measurement.' }) : null;
    }
    function drawTotals(tot) {
      tot.replaceChildren();
      var t = estTotals(est.items);
      tot.appendChild(h('p', { class: 'estimate-total', testid: 'estimate-totals', text: 'Estimated total (' + t.matched + ' matched item' + (t.matched === 1 ? '' : 's') + '): ' + (t.matched ? nutrLine(t) : 'nothing matched yet') + '. ESTIMATE — not counted until you confirm the meal.' }));
      if (t.unmatched) tot.appendChild(h('p', { class: 'note note-warn', testid: 'estimate-unmatched-note', text: t.unmatched + ' item' + (t.unmatched === 1 ? ' is' : 's are') + ' not included above (no match / needs your choice). They will be added as components with unknown values for you to enter manually.' }));
    }
    function itemNode(i, tot) {
      var it = est.items[i];
      var node = h('div', { class: 'estimate-item', testid: 'estimate-item', 'data-status': it.status });
      node.appendChild(h('div', { class: 'row-between' }, h('strong', { text: it.raw, testid: 'estimate-item-raw' }),
        badge(it.status === 'matched' ? 'Estimate' : it.status === 'ambiguous' ? 'Choose a food' : it.status === 'no_portion' ? 'Enter grams' : it.status === 'unparsed' ? 'Not understood' : 'No match', it.status === 'matched' ? 'info' : 'warn', 'estimate-status')));
      function redo(opts, focusId) {
        var n = FC.estimateItem(it.raw, undefined, Object.assign({ fdcId: it.chosen && it.chosen.fdcId, dataset: it.chosen && it.chosen.dataset }, opts));
        if (n && n.status) { est.items[i] = n; est.applied = false; delete est.bad[i]; var nn = itemNode(i, tot); node.replaceWith(nn); drawTotals(tot); syncApply(); var f = focusId && nn.querySelector('[data-testid="' + focusId + '"]'); if (f) f.focus(); }
      }
      if (it.status === 'no_match' || (it.status === 'unparsed' && !it.chosen)) {
        if (it.status === 'no_match') node.appendChild(h('p', { class: 'note note-warn', testid: 'estimate-nomatch', text: 'no match, enter manually' + (it.message ? ' — ' + it.message : '') }));
        else node.appendChild(h('p', { class: 'note note-warn', testid: 'estimate-unparsed', text: 'Not understood, enter manually — ' + (it.message || it.problem || 'check the amount.') }));
        return node;
      }
      var cands = Array.isArray(it.candidates) ? it.candidates : [];
      if (cands.length > 1 || it.status === 'ambiguous') {
        var opts = cands.map(function (c) { return [c.dataset + ':' + c.fdcId, c.description + ' (' + dsName(c.dataset) + ')']; });
        if (!it.chosen) opts.unshift(['', '— choose the food —']);
        var fs = select(opts, it.chosen ? it.chosen.dataset + ':' + it.chosen.fdcId : '', { testid: 'estimate-food' });
        fs.addEventListener('change', function () { if (!fs.value) return; var c = cands.filter(function (x) { return x.dataset + ':' + x.fdcId === fs.value; })[0]; if (!c) return;
          var n = FC.estimateItem(it.raw, undefined, { fdcId: c.fdcId, dataset: c.dataset }); if (n && n.status) { est.items[i] = n; est.applied = false; delete est.bad[i]; var nn = itemNode(i, tot); node.replaceWith(nn); drawTotals(tot); syncApply(); var f = nn.querySelector('[data-testid="estimate-food"]'); if (f) f.focus(); } });
        node.appendChild(field('Food', fs));
      } else if (it.chosen) node.appendChild(h('p', { testid: 'estimate-food-name', text: it.chosen.description }));
      if (it.chosen) {
        // Foundation "RACC" rows are regulatory reference amounts: never offered as a household measure (contract v2)
        var ports = (Array.isArray(it.portions) ? it.portions : []).filter(function (p) { return !/RACC/i.test(String(p.unit || '') + ' ' + String(p.label || '')); });
        var curIdx = it.portion && it.portion.basis !== 'mass' && it.portion.basis !== 'user_grams' ? (ports.filter(function (p) { return p.label === it.portion.label; })[0] || {}).index : undefined;
        if (!it.portion && ports.length) curIdx = ports[0].index; // no quantity typed yet: the owner enters a count of the first measure
        var mOpts = ports.map(function (p) { return [String(p.index), p.label + ' (' + fmt(p.grams) + ' g)']; }).concat([['g', 'grams']]);
        var qty = numIn(it.amount, { testid: 'estimate-qty', 'aria-label': 'Quantity for ' + it.raw });
        var meas = select(mOpts, curIdx === undefined ? 'g' : String(curIdx), { testid: 'estimate-measure', 'aria-label': 'Household measure for ' + it.raw });
        var grams = numIn(it.grams, { testid: 'estimate-grams', 'aria-label': 'Grams for ' + it.raw, placeholder: 'grams' });
        var enterKey = false; // refocus after a recompute only when the owner pressed Enter in the field: a blur caused by tapping another control (e.g. the apply button) must not be stolen back
        function badVal(el) { var v = numOrNull(el.value); return v === null || isNaN(v) || v <= 0 || !!(el.validity && el.validity.badInput); }
        [qty, grams].forEach(function (el) { el.addEventListener('keydown', function (e) { enterKey = e.key === 'Enter'; }); });
        qty.addEventListener('input', function () { if (badVal(qty)) markBad(i, 'qty', node, tot, qty, grams); else if (est.bad[i]) qty.dispatchEvent(new Event('change')); });
        grams.addEventListener('input', function () { if (badVal(grams)) markBad(i, 'grams', node, tot, qty, grams); else if (est.bad[i]) grams.dispatchEvent(new Event('change')); });
        qty.addEventListener('change', function () { var v = numOrNull(qty.value); if (badVal(qty)) { markBad(i, 'qty', node, tot, qty, grams); return; } redo(meas.value === 'g' ? { amount: v, unit: 'g' } : { portionIndex: Number(meas.value), amount: v }, enterKey ? 'estimate-qty' : null); enterKey = false; });
        meas.addEventListener('change', function () { /* switching measure restarts at 1 of that measure (or the current grams for 'grams') */ redo(meas.value === 'g' ? { amount: it.grams || 1, unit: 'g' } : { portionIndex: Number(meas.value), amount: 1 }, 'estimate-measure'); });
        grams.addEventListener('change', function () { var v = numOrNull(grams.value); if (badVal(grams)) { markBad(i, 'grams', node, tot, qty, grams); return; } redo({ grams: v }, enterKey ? 'estimate-grams' : null); enterKey = false; });
        node.appendChild(h('div', { class: 'row' }, field('Quantity', qty), field('Measure', meas)));
        node.appendChild(field('Grams (edit to override)', grams));
      }
      if (it.status === 'matched' && it.nutrients) {
        node.appendChild(h('p', { class: 'estimate-nutr', testid: 'estimate-nutrients', text: 'Estimate: ' + nutrLine(it.nutrients) }));
        var sl = sourceLine(it); if (sl) node.appendChild(sl);
        if (it.message) node.appendChild(h('p', { class: 'hint', testid: 'estimate-note', text: 'Note: ' + it.message }));
      } else if (it.status === 'no_portion') node.appendChild(h('p', { class: 'note note-warn', testid: 'estimate-noportion', text: 'No household measure for this unit — type the grams above. ' + (it.message || '') }));
      else if (it.status === 'unparsed') node.appendChild(h('p', { class: 'note note-warn', testid: 'estimate-needqty', text: (it.message || 'Enter an amount.') + ' Nothing is counted until you enter an amount.' }));
      else if (it.status === 'ambiguous') node.appendChild(h('p', { class: 'note note-warn', testid: 'estimate-ambiguous', text: (cands.length === 1 ? 'Check the food above and choose it if it is what you ate, or edit the text and estimate again — nothing is assumed. ' : 'More than one food fits. Choose one below, or edit the text above and estimate again — nothing is assumed. ') + (it.message || '') }));
      return node;
    }
    function show(result) {
      est = { items: result.items.slice(), dbVersion: result.dbVersion || null, truncated: result.truncated === true, bad: result.bad || {}, applied: result.applied === true };
      out.replaceChildren();
      var list = h('div', { testid: 'estimate-items' });
      var tot = h('div');
      est.items.forEach(function (it, i) { list.appendChild(itemNode(i, tot)); });
      if (est.truncated) out.appendChild(h('p', { class: 'note note-warn', testid: 'estimate-truncated', text: 'Your text was long, so only the first part was read. Split it into smaller meals or enter the rest by hand.' }));
      out.appendChild(list); drawTotals(tot); out.appendChild(tot);
      applyHint = h('p', { class: 'note note-warn', testid: 'estimate-apply-hint', text: 'Fix the amount marked above to use these estimates.' }); applyHint.hidden = true;
      applyBtn = h('button', { type: 'button', class: 'btn btn-primary', text: 'Use these estimates in the meal', testid: 'estimate-apply', onclick: function () {
        // flush a half-edited field first so the estimate can never be stale when the button is tapped
        var ae = document.activeElement; if (ae && out.contains(ae) && (ae.getAttribute('data-testid') === 'estimate-qty' || ae.getAttribute('data-testid') === 'estimate-grams')) ae.dispatchEvent(new Event('change'));
        if (anyBad()) { syncApply(); return; }
        var conv = FC.toComponents({ ok: true, dbVersion: est.dbVersion, items: est.items, totals: estTotals(est.items) });
        var comps = (conv && Array.isArray(conv.components)) ? conv.components : [], un = (conv && Array.isArray(conv.unmatched)) ? conv.unmatched : [];
        ms.components = ms.components.filter(function (c) { return !c.provenance && estComps.indexOf(c) === -1 && !(blankIsEmpty(c)); });
        estComps = [];
        var fx = fsIndexNow();
        comps.forEach(function (c) { if (fx) c = FS.withFiberSodium(fx, c); ms.components.push(c); estComps.push(c); });
        un.forEach(function (u) { var b = blankComponent(); b.name = String(u.raw || '').slice(0, 80); ms.components.push(b); estComps.push(b); });
        est.applied = true;
        toast('Added ' + comps.length + ' estimated component' + (comps.length === 1 ? '' : 's') + (un.length ? ' and ' + un.length + ' to enter manually' : '') + '. The meal is still a draft: check it, then confirm.');
        rerenderMeal();
      } });
      // Claude P6 review: the owner can drop an estimate they do not want, so it never blocks a manual entry.
      var clearBtn = h('button', { type: 'button', class: 'btn btn-secondary', text: 'Clear estimate', testid: 'estimate-clear', onclick: function () {
        dropEstimate(); out.replaceChildren(h('p', { class: 'hint', testid: 'estimate-message', text: 'Estimate cleared. The components below are unchanged.' }));
      } });
      out.appendChild(applyHint);
      appliedNote = null;
      if (est.applied) out.appendChild(appliedNote = h('p', { class: 'note', testid: 'estimate-applied', role: 'status', text: 'Added to the meal below. Check the components, then confirm. If you change an item above, press “Use these estimates in the meal” again.' }));
      out.appendChild(h('div', { class: 'btn-row' }, applyBtn, clearBtn)); syncApply();
    }
    function blankIsEmpty(c) { return !String(c.name || '').trim() && HN.MACROS.every(function (k) { return c[k] && c[k].value === null; }); }
    run.addEventListener('click', function () {
      var text = String(ms.description || '').trim();
      if (!text) { msg('Type what you ate in the description above first.', 'warn'); return; }
      if (!FC) { msg('The food estimate module is not available in this version. Enter the values by hand below. Nothing was changed.', 'warn'); return; }
      msg('Loading food data…');
      run.disabled = true;
      loadFoodDb(function (err) {
        run.disabled = false;
        if (!err && FS && !window.HyroxFoodDbUs && usLoad === null) loadFoodDbUs(function () {}); // P11.3: fiber/sodium for the estimate, if it arrives in time
        if (err) { msg('Food data could not be loaded (' + err.message + ') Enter the values by hand below. Nothing was changed.', 'warn'); return; }
        var r;
        try { r = FC.estimate(text); } catch (e) { r = { ok: false, message: 'The estimate failed.' }; }
        if (!r || r.ok !== true || !Array.isArray(r.items)) { msg('No estimate: ' + (r && r.message ? r.message : 'unexpected answer') + ' Enter the values by hand below. Nothing was changed.', 'warn'); return; }
        if (!r.items.length) { msg('No foods were found in the text. Enter the values by hand below.', 'warn'); return; }
        show(r);
        var f = out.querySelector('[data-testid="estimate-item"] select, [data-testid="estimate-item"] input'); if (f) { try { f.focus({ preventScroll: true }); } catch (e) { /* */ } }
      });
    });
    if (est) show({ items: est.items, dbVersion: est.dbVersion, truncated: est.truncated, bad: est.bad, applied: est.applied });
    return box;
  }

  var photoGen = 0; // bumped whenever the photo set is cleared: encodes still running for the old set are dropped
  function dropPhoto() { photoGen++; photos.forEach(function (p) { if (p.url) URL.revokeObjectURL(p.url); }); photos = []; photoError = null; aiBasis = null; draftNonce = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // P3 rule kept: a photo that cannot be read clears the photo set and Send (no stale preview can be sent);
  // the typed meal draft (note, items, amounts) is never touched.
  function failedPhoto(msg) {
    var had = photos.length;
    dropPhoto();
    photoError = msg + (had ? ' The photos were cleared so nothing stale is sent; add them again.' : '') + ' Your typed meal draft is unchanged.';
    renderAdd();
  }
  // ================= P11.2 part 4: "Add foods" — local food search into the CURRENT meal draft =================
  // A dedicated screen opened from the meal form / diary logger. Searches the bundled USDA list (in memory, no network
  // after the one static food-db.js load, no AI, no cost) plus the owner's own saved foods. Nothing is chosen, added,
  // saved or confirmed by itself: the owner taps a food, picks a serving and quantity, adds it to this draft, and later
  // confirms the whole meal once on the meal form. My foods / favourites live in the owner-settings record (optional
  // fields myFoods / favFoods; older versions keep them untouched). Saved foods are copies: changing or deleting one
  // never rewrites a meal already saved.
  var FS = window.HyroxFoodSearch || null, FSX = window.HyroxFiberSodium || null;
  // Phase 11.3: the search index, built at once if both food files are already loaded (used to add USDA fiber/sodium to
  // Describe-path estimates); otherwise null and those items keep fiber/sodium unknown.
  function fsIndexNow() {
    if (foodIx) return foodIx;
    if (!FS || !window.HyroxFoodDb || !window.HyroxFoodDbUs) return null;
    var ix = FS.buildIndex(window.HyroxFoodDb, window.HyroxFoodCalc && window.HyroxFoodCalc.ALIASES, window.HyroxFoodDbUs);
    if (ix.ok) foodIx = ix;
    return foodIx;
  }
  var foodScr = null, foodIx = null, foodTimer = null, foodSeq = 0;
  // F-1: the search box redraws the result list 120 ms after the last keystroke. Any explicit action on this screen
  // (picking a result, a tab, Add, Favorite, opening or leaving the screen) supersedes that pending redraw. Without this
  // it could fire after a result was picked and replace the open detail - including the quantity field being typed in -
  // so the typed quantity was lost and 1x was stored.
  function cancelFoodRedraw() { clearTimeout(foodTimer); foodTimer = null; foodSeq++; }
  // F-1 (second half): a typing redraw that lands between finger-down and finger-up on a result replaces the row under
  // the finger and the tap is lost (nothing opens). While a press on the result list is in progress the redraw waits.
  // A press older than 1.5 s is ignored, so a missed finger-up can never stop the search from updating.
  var foodPressAt = 0;
  function foodPressActive() { return foodPressAt && Date.now() - foodPressAt >= 0 && Date.now() - foodPressAt < 1500; }
  ['pointerup', 'pointercancel'].forEach(function (ev) { window.addEventListener(ev, function () { foodPressAt = 0; }, true); });
  function scheduleFoodRedraw() {
    clearTimeout(foodTimer); var my = ++foodSeq;
    (function wait() { foodTimer = setTimeout(function () {
      if (!foodScr || my !== foodSeq || foodScr.sel) return;   // superseded, or a detail is open: never replace it
      if (foodPressActive()) { wait(); return; }
      drawFoods(true);
    }, 120); })();
  }
  // Read-only: the saved foods / favourites inside the stored settings record even when that record fails validation
  // (store.settings() then returns no record). Only these two lists are taken, normalised; nothing is written here.
  function rawSettingsFoodLists() {
    var out = { myFoods: [], favFoods: [] };
    try {
      var raw = JSON.parse(localStorage.getItem(HD.STORAGE_KEY) || 'null');
      var r = raw && Array.isArray(raw.ownerSettings) ? raw.ownerSettings.filter(function (x) { return x && x.id === HD.SETTINGS_ID; })[0] : null;
      if (!r) return out;
      out.myFoods = FS ? FS.validMyFoods(r.myFoods) : [];
      out.favFoods = Array.isArray(r.favFoods) ? r.favFoods.filter(function (k) { return typeof k === 'string' && k.length <= 80; }).slice(0, 200) : [];
    } catch (e) { /* unreadable storage: nothing to carry over */ }
    return out;
  }
  function foodPrefs() {
    var r = settings().record || null;
    return { myFoods: FS ? FS.validMyFoods(r && r.myFoods) : [], favFoods: r && Array.isArray(r.favFoods) ? r.favFoods.filter(function (k) { return typeof k === 'string'; }).slice(0, 200) : [] };
  }
  function saveFoodPrefs(mutate, err) {
    if (damaged().some(function (d) { return d.collection === 'ownerSettings'; })) { toast('Not saved: your saved settings need attention first (Settings).', true); return { ok: false }; }
    var cur = settings().record, rec = cur ? JSON.parse(JSON.stringify(cur)) : { id: HD.SETTINGS_ID };
    if (!rec.date) rec.date = today();
    var p = foodPrefs(); rec.myFoods = p.myFoods; rec.favFoods = p.favFoods;
    mutate(rec);
    if (!rec.myFoods.length) delete rec.myFoods;
    if (!rec.favFoods.length) delete rec.favFoods;
    return persist('ownerSettings', rec, err || null);
  }
  // A-01: an index built while the US list could not load is rebuilt once that list loads on a later Add foods open.
  function foodIxNeedsUs() { return !!foodIx && !foodIx.usCount && usLoad === 'failed'; }
  function ensureFoodIndex(cb) {
    if (foodIx && !foodIxNeedsUs()) { cb(null); return; }
    if (!FS) { cb({ message: 'Food search is not available in this version.' }); return; }
    loadFoodDb(function (e) {
      if (e) { cb(e); return; }
      loadFoodDbUs(function (okUs) {
        if (foodIx && !okUs) { cb(null); return; } // retry failed again: keep the 8,167-food index already built
        var ix = FS.buildIndex(window.HyroxFoodDb, window.HyroxFoodCalc && window.HyroxFoodCalc.ALIASES, okUs ? window.HyroxFoodDbUs : null);
        if (!ix.ok) { cb({ message: ix.message }); return; }
        foodIx = ix; cb(null);
      });
    });
  }
  function openFoods() {
    var needIx = !foodIx || foodIxNeedsUs();
    cancelFoodRedraw();
    foodScr = { tab: 'SEARCH', q: '', sel: null, servingId: null, qty: '1', added: 0, loadErr: null, loading: needIx };
    renderAdd(); focusTestid('foods-q');
    if (needIx) ensureFoodIndex(function (e) { if (!foodScr) return; foodScr.loading = false; foodScr.loadErr = e ? e.message : null; drawFoods(); });
  }
  function closeFoods() { cancelFoodRedraw(); foodScr = null; renderAdd(); focusTestid('meal-add-foods'); }
  function foodKeyOf(c) { var p = c && c.provenance; return p && p.source === 'USDA_FDC' && p.dataset && typeof p.fdcId === 'number' ? p.dataset + ':' + p.fdcId : null; }
  function addFoodComponent(comp) {
    var isBlank = function (x) { return !String(x.name || '').trim() && HN.MACROS.every(function (k) { return x[k].value === null; }); };
    function doAdd() {
      if (ms.components.length >= 50) { toast('Not added: a meal holds at most 50 items.', true); return; }
      if (ms.components.length === 1 && isBlank(ms.components[0])) ms.components = [comp]; else ms.components.push(comp);
      markCorrected();
      foodScr.added++; foodScr.sel = null; foodScr.q = ''; foodScr.tab = 'SEARCH';
      var qi = document.querySelector('[data-testid="foods-q"]'); if (qi) qi.value = '';
      toast('Added to this meal: ' + comp.name + ' (' + (comp.kcal.value === null ? 'kcal unknown' : comp.kcal.value + ' kcal, ' + comp.kcal.state.toLowerCase()) + '). Not saved yet.');
      drawFoods(); focusTestid('foods-q');
    }
    var k = foodKeyOf(comp);
    var dup = ms.components.some(function (x) { return (k && foodKeyOf(x) === k) || String(x.name || '').trim().toLowerCase() === comp.name.trim().toLowerCase(); });
    if (dup) askChoice({ title: 'Already in this meal', body: '“' + comp.name + '” is already in this meal. Add another portion as a separate item? (If you added a whole dish, do not also add its parts.)', yes: 'Add another', no: 'Cancel', onYes: doAdd, onNo: function () { focusTestid('food-add'); } });
    else doAdd();
  }
  var foodHost = null;
  function renderFoodScreen(root) {
    var ctx = logCtx && knownCat(logCtx.cat) ? catName(logCtx.cat) : (knownCat(ms.mealCategory) ? catName(ms.mealCategory) : 'this meal');
    root.appendChild(h('header', { class: 'logger-head', testid: 'foods-head' },
      h('button', { type: 'button', class: 'logger-back', testid: 'foods-done', 'aria-label': 'Back to the meal (' + itemCount() + ')', onclick: closeFoods }, h('span', { 'aria-hidden': 'true', text: '‹' }), ' Meal'),
      h('div', { class: 'logger-titles' }, h('h2', { class: 'logger-title', testid: 'foods-title', tabindex: '-1', text: 'Add foods' }),
        h('p', { class: 'logger-date', testid: 'foods-context', text: ctx + ' · ' + fmtDate(ms.date) + (ms.date === today() ? ' · today' : '') }))));
    var c = h('section', { class: 'card foods', testid: 'foods-screen', 'aria-labelledby': 'foods-title-h' });
    var q = h('input', { type: 'search', class: 'foods-q', testid: 'foods-q', value: foodScr.q, maxlength: String(FS ? FS.MAX_QUERY : 80), autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'search',
      placeholder: 'Search foods, e.g. eggs, big mac, oatmeal', 'aria-label': 'Search foods', 'aria-describedby': 'foods-status',
      oninput: function () { var v = this.value; foodScr.q = v; foodScr.sel = null; if (foodScr.tab !== 'SEARCH') foodScr.tab = 'SEARCH'; scheduleFoodRedraw(); } });
    c.appendChild(q);
    var tabs = h('div', { class: 'segmented foods-tabs', role: 'group', 'aria-label': 'Food lists' });
    [['SEARCH', 'Search'], ['RECENT', 'Recent'], ['FAV', 'Favorites'], ['MY', 'My foods']].forEach(function (t) {
      tabs.appendChild(h('button', { type: 'button', class: 'seg' + (foodScr.tab === t[0] ? ' active' : ''), 'aria-pressed': foodScr.tab === t[0] ? 'true' : 'false', text: t[1], testid: 'foods-tab-' + t[0].toLowerCase(),
        onclick: function () { foodScr.tab = t[0]; foodScr.sel = null; drawFoods(); } }));
    });
    c.appendChild(tabs);
    c.appendChild(h('p', { class: 'hint foods-status', id: 'foods-status', testid: 'foods-status', role: 'status', 'aria-live': 'polite' }));
    foodHost = h('div', { testid: 'foods-results', onpointerdown: function () { foodPressAt = Date.now(); } });
    c.appendChild(foodHost);
    c.appendChild(h('div', { class: 'btn-row foods-alt' },
      h('span', { class: 'hint', text: 'Or:' }),
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Photo', testid: 'foods-alt-photo', onclick: function () { altPath('photo_ai'); } }),
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Describe whole meal', testid: 'foods-alt-describe', onclick: function () { altPath('description'); } }),
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Enter manually', testid: 'foods-manual', onclick: function () { manualFromQuery(); } })));
    c.appendChild(h('p', { class: 'hint', testid: 'foods-caveat', text: 'USDA values are estimates for a reference food: SR Legacy (2018), Foundation Foods and FNDDS 2021-2023 (US survey foods). Restaurant items are US-market USDA estimates, not official chain values, and may be out of date; portions and recipes elsewhere can differ. Nothing counts until you confirm the meal. Source: U.S. Department of Agriculture, Agricultural Research Service. FoodData Central.' }));
    root.appendChild(c);
    drawFoods();
  }
  function itemCount() { var n = ms.components.filter(function (x) { return String(x.name || '').trim(); }).length; return n + (n === 1 ? ' item' : ' items'); }
  function altPath(p) { foodScr = null; renderAdd(); var b = document.querySelector('[data-testid="meal-path-' + p + '"]'); if (b) b.click(); }
  function manualFromQuery() {
    var name = String(foodScr && foodScr.q || '').trim().slice(0, 80);
    var comp = blankComponent(); comp.name = name;
    if (ms.components.length === 1 && !String(ms.components[0].name || '').trim() && HN.MACROS.every(function (k) { return ms.components[0][k].value === null; })) ms.components = [comp];
    else if (name || !ms.components.length) ms.components.push(comp);
    foodScr = null; renderAdd();
    var rows = document.querySelectorAll('[data-testid="component-kcal"]'); var el = rows[rows.length - 1]; if (el) el.focus();
  }
  // Phase 11.3: restaurant labels for Recent / Favorites rows (search results carry them already).
  function usNote() { return usLoad === 'failed' ? ' (The larger US list could not be loaded; searching the original 8,167 foods only.)' : ''; }
  function withRk(it) {
    var rk = FS.restaurantKind ? FS.restaurantKind(it.name, it.dataset) : null;
    it.restaurantKind = rk; it.restaurant = rk === 'CHAIN';
    it.restaurantBadge = rk === 'CHAIN' ? (it.dataset === 'FN' ? 'Chain item · USDA survey estimate (US)' : 'Restaurant · US 2018') : rk === 'GENERIC' ? 'Restaurant-style · generic USDA' : null;
    return it;
  }
  function drawFoods(fromTyping) {
    if (!foodScr || !foodHost) return;
    if (!fromTyping) cancelFoodRedraw(); // F-1: this redraw is the result of an explicit action; a pending typing redraw must not follow it
    var host = foodHost, status = document.querySelector('[data-testid="foods-status"]');
    document.querySelectorAll('[data-testid^="foods-tab-"]').forEach(function (b) { var on = b.getAttribute('data-testid') === 'foods-tab-' + foodScr.tab.toLowerCase(); b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    var done = document.querySelector('[data-testid="foods-done"]'); if (done) done.setAttribute('aria-label', 'Back to the meal (' + itemCount() + ')');
    host.replaceChildren();
    var prefs = foodPrefs(), favSet = {}; prefs.favFoods.forEach(function (k) { favSet[k] = 1; });
    function say(t) { if (status) status.textContent = t; }
    if (foodScr.added) host.appendChild(h('p', { class: 'note', testid: 'foods-added', text: foodScr.added + (foodScr.added === 1 ? ' food' : ' foods') + ' added to this meal (not saved yet). Add more, or go back to the meal to review and confirm it once.' }));
    var list = [];
    if (foodScr.tab === 'MY') {
      if (!prefs.myFoods.length) { say('No saved foods yet. Save items from a confirmed meal in History (“Save to My foods”).'); }
      else { say(prefs.myFoods.length + ' saved food(s).'); list = prefs.myFoods.map(function (m) { return { kind: 'MY', key: 'my:' + m.id, id: m.id, name: m.name, sourceLabel: 'My food · ' + (m.basis || 'saved'), favorite: !!favSet['my:' + m.id] }; }); }
    } else if (foodScr.loading) { say('Loading the food list (one local file, no account, no cost)…'); return; }
    else if (foodScr.loadErr && foodScr.tab !== 'MY') {
      say('The food list could not be loaded (' + foodScr.loadErr + '). You can still use My foods, enter the item manually or describe the meal.');
    } else if (foodScr.tab === 'RECENT') {
      var keys = FS.recentKeys(allMeals(), 20).filter(function (k) { return foodIx.byKey[k] !== undefined; });
      say(keys.length ? keys.length + ' recently confirmed food(s). Nothing is chosen for you.' : 'No recently confirmed foods yet.');
      list = keys.map(function (k) { var f = foodIx.foods[foodIx.byKey[k]]; return withRk({ kind: 'USDA', key: k, dataset: f.dataset, name: f.name, sourceLabel: FS.sourceLabel(f.dataset), recent: true, favorite: !!favSet[k] }); });
    } else if (foodScr.tab === 'FAV') {
      var mine = {}; prefs.myFoods.forEach(function (m) { mine['my:' + m.id] = m; });
      list = prefs.favFoods.map(function (k) {
        if (mine[k]) return { kind: 'MY', key: k, id: mine[k].id, name: mine[k].name, sourceLabel: 'My food', favorite: true };
        var i = foodIx.byKey[k]; if (i === undefined) return null; var f = foodIx.foods[i];
        return withRk({ kind: 'USDA', key: k, dataset: f.dataset, name: f.name, sourceLabel: FS.sourceLabel(f.dataset), favorite: true });
      }).filter(Boolean);
      say(list.length ? list.length + ' favourite(s).' : 'No favourites yet. Open a food and tap “☆ Favorite”.');
    } else {
      var qq = String(foodScr.q || '').trim();
      if (!qq) { say('Type at least one word. Results come from the USDA lists on this device (' + String(foodIx.foods.length).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' foods) and your saved foods.' + usNote()); }
      else {
        var r = FS.search(foodIx, qq, { recentKeys: FS.recentKeys(allMeals(), 20), favKeys: prefs.favFoods, myFoods: prefs.myFoods });
        list = r.results;
        if (!list.length) {
          say('No match for “' + qq + '”. Try fewer or different words (e.g. the main food), check the spelling, or enter it manually.');
          host.appendChild(h('div', { class: 'note', testid: 'foods-none' },
            h('p', { text: 'Nothing on this device matches “' + qq + '”. Restaurant coverage is limited to USDA estimates (SR Legacy 2018, FNDDS 2021-2023); nothing is guessed. Search for one food at a time.' }),
            h('button', { type: 'button', class: 'btn btn-secondary', text: 'Enter “' + qq.slice(0, 30) + '” manually', testid: 'foods-none-manual', onclick: manualFromQuery })));
        } else say(r.count + (r.count === 1 ? ' match' : ' matches') + (r.count > list.length ? ', showing the best ' + list.length : '') + '. Tap one to choose a serving; nothing is added until you press Add.' + usNote());
      }
    }
    if (!list.length) return;
    var ul = h('ul', { class: 'food-list', testid: 'food-list' });
    list.forEach(function (it) {
      var open = foodScr.sel === it.key;
      var meta = [it.sourceLabel];
      if (it.kind === 'USDA') {
        var sv = FS.servingsFor(foodIx, it.key, it.aliasLabel).filter(function (s) { return s.isDefault; })[0];
        var n = sv ? FS.nutrients(foodIx, it.key, sv.grams) : null;
        if (sv && n && !n.tooLarge) meta.unshift(sv.label + ' (' + sv.grams + ' g) · ' + n.kcal + ' kcal est.');
      } else {
        var mf = prefs.myFoods.filter(function (m) { return m.id === it.id; })[0];
        if (mf) meta.unshift((mf.portion || '1 serving') + ' · ' + (mf.kcal.value === null ? 'kcal unknown' : mf.kcal.value + ' kcal' + (mf.kcal.state === 'ESTIMATED' ? ' est.' : '')));
      }
      var li = h('li', { class: 'food-item' + (open ? ' food-open' : ''), testid: 'food-result', 'data-key': it.key });
      li.appendChild(h('button', { type: 'button', class: 'food-pick', 'aria-expanded': open ? 'true' : 'false', testid: 'food-pick',
        onclick: function () { foodScr.sel = open ? null : it.key; foodScr.servingId = null; foodScr.qty = '1'; drawFoods(); if (!open) focusTestid('food-serving'); } },
        h('span', { class: 'food-name', text: it.name }),
        h('span', { class: 'food-meta', text: meta.join(' · ') }),
        h('span', { class: 'food-badges' },
          it.restaurantBadge ? badge(it.restaurantBadge, 'muted', it.restaurantKind === 'CHAIN' ? 'food-restaurant' : 'food-restaurant-style') : null,
          it.matchType === 'typo' ? badge('Spelling-tolerant match', 'muted', 'food-typo') : null,
          it.recent ? badge('Recent', 'muted', 'food-recent') : null,
          it.favorite ? badge('★ Favorite', 'muted', 'food-fav-badge') : null)));
      if (open) li.appendChild(foodDetail(it, prefs));
      ul.appendChild(li);
    });
    host.appendChild(ul);
    if (fromTyping) { /* keep focus in the search field while typing */ }
  }
  function foodDetail(it, prefs) {
    var box = h('div', { class: 'food-detail', testid: 'food-detail' });
    var err = h('p', { class: 'form-error', testid: 'food-error', 'aria-live': 'polite' });
    var preview = h('p', { class: 'food-preview', testid: 'food-preview', 'aria-live': 'polite' });
    var macros = h('dl', { class: 'macro-cells', testid: 'food-macros' });
    var qty = h('input', { type: 'number', inputmode: 'decimal', min: '0.1', max: String(FS.MAX_QTY), step: '0.25', value: foodScr.qty, testid: 'food-qty', 'aria-label': 'Quantity (number of servings)',
      oninput: function () { foodScr.qty = this.value; upd(); } });
    var comp = null, servings = [], sel = null, mf = null;
    if (it.kind === 'USDA') {
      servings = FS.servingsFor(foodIx, it.key, it.aliasLabel);
      var cur = foodScr.servingId || (servings.filter(function (s) { return s.isDefault; })[0] || servings[0]).id;
      sel = h('select', { testid: 'food-serving', 'aria-label': 'Serving size', onchange: function () { foodScr.servingId = this.value; upd(); } },
        servings.map(function (s) { var o = h('option', { value: s.id, text: s.label + ' (' + s.grams + ' g)' + (s.racc ? ' — label reference amount' : '') }); if (s.id === cur) o.selected = true; return o; }));
      box.appendChild(h('div', { class: 'row' }, field('Serving', sel), field('Quantity', qty)));
    } else {
      mf = prefs.myFoods.filter(function (m) { return m.id === it.id; })[0];
      box.appendChild(h('p', { class: 'hint', text: 'Saved serving: ' + ((mf && mf.portion) || '1 serving') + '. Quantity multiplies it.' }));
      box.appendChild(field('Quantity', qty));
    }
    function upd() {
      err.textContent = ''; comp = null;
      var n = Number(foodScr.qty);
      var r = it.kind === 'USDA' ? FS.usdaComponent(foodIx, it.key, servings.filter(function (s) { return s.id === (sel ? sel.value : null); })[0], n) : FS.myFoodComponent(mf, n);
      macros.replaceChildren();
      if (!r.ok) { preview.textContent = ''; err.textContent = r.message; return; }
      comp = r.component;
      preview.textContent = comp.portion + ' · ' + (comp.kcal.value === null ? 'kcal unknown' : comp.kcal.value + ' kcal') + ' · ' + (comp.kcal.state === 'ESTIMATED' ? 'estimate' : comp.kcal.state === 'KNOWN' ? 'your values' : 'unknown');
      [['proteinG', 'Protein'], ['carbsG', 'Carbs'], ['fatG', 'Fat']].forEach(function (m) {
        var v = comp[m[0]];
        macros.appendChild(h('div', { class: 'macro-cell' }, h('dt', { text: m[1] }), ' ', h('dd', { text: v.value === null ? 'unknown' : fmt(v.value) + ' g' })));
      });
      if (FSX) FSX.KEYS.forEach(function (k) { var v = FSX.itemValue(comp, k); macros.appendChild(h('div', { class: 'macro-cell' }, h('dt', { text: FSX.NAME[k] }), ' ', h('dd', { testid: 'food-' + k, text: v ? FSX.fmtNum(k, v.value) + ' ' + FSX.UNIT[k] : 'unknown' }))); });
    }
    box.appendChild(preview);
    box.appendChild(h('details', { class: 'fold food-more', testid: 'food-more' }, h('summary', { text: 'Macros, fiber, sodium and source' }), macros,
      h('p', { class: 'hint', testid: 'food-source', text: it.kind === 'USDA' ? it.sourceLabel + ', fdcId ' + it.key.split(':')[1] + '. Estimate for USDA\'s reference food; your portion or recipe may differ.' + (it.note ? ' ' + it.note : '') + (it.restaurantKind === 'CHAIN' ? (it.dataset === 'FN' ? ' USDA survey (FNDDS 2021-2023) estimate for a US chain item as people reported eating it — NOT the restaurant\'s official figure.' : ' USDA\'s 2018 analysis of a US restaurant item — NOT the restaurant\'s official figure.') + ' Current recipes, portions and other countries (including Qatar branches) may differ. For the official value, check the chain\'s own app, enter it manually, confirm the meal, then “Save to My foods” to reuse it.'
          : it.restaurantKind === 'GENERIC' ? ' Generic restaurant-style USDA estimate (no specific chain); not any restaurant\'s official figure.' : '')
        : 'Saved by you' + (mf && mf.basis ? ' (' + mf.basis + ')' : '') + '. Values are copied into the meal; changing this saved food later never changes saved meals.' })));
    box.appendChild(err);
    var isFav = !!it.favorite;
    box.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn btn-primary', text: 'Add to meal', testid: 'food-add', onclick: function () { foodScr.qty = qty.value; upd(); if (!comp) return; addFoodComponent(comp); } }), // F-1: what is stored is computed from what the quantity field shows at this moment
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: isFav ? '★ Favorite' : '☆ Favorite', testid: 'food-fav', 'aria-pressed': isFav ? 'true' : 'false',
        onclick: function () { var r = saveFoodPrefs(function (rec) { var i = rec.favFoods.indexOf(it.key); if (i === -1) rec.favFoods.unshift(it.key); else rec.favFoods.splice(i, 1); rec.favFoods = rec.favFoods.slice(0, 200); }); if (r.ok) { drawFoods(); focusTestid('food-fav'); } } }),
      it.kind === 'MY' ? h('button', { type: 'button', class: 'btn btn-small btn-delete', text: 'Delete saved food', testid: 'myfood-delete',
        onclick: function () { askChoice({ title: 'Delete “' + it.name + '” from My foods?', body: 'Meals you already saved with it keep their values. This cannot be undone.', yes: 'Delete it', no: 'Keep it',
          onYes: function () { var r = saveFoodPrefs(function (rec) { rec.myFoods = rec.myFoods.filter(function (m) { return m.id !== it.id; }); rec.favFoods = rec.favFoods.filter(function (k) { return k !== it.key; }); }); if (r.ok) { foodScr.sel = null; drawFoods(); } }, onNo: function () {} }); } }) : null));
    if (it.kind === 'MY' && mf) {
      var nm = h('input', { type: 'text', maxlength: '80', value: mf.name, testid: 'myfood-name', 'aria-label': 'Saved food name' });
      box.appendChild(h('div', { class: 'row' }, field('Rename saved food', nm),
        h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Save name', testid: 'myfood-rename', onclick: function () {
          var v = nm.value.trim(); if (!v) { err.textContent = 'A saved food needs a name.'; return; }
          var r = saveFoodPrefs(function (rec) { rec.myFoods.forEach(function (m) { if (m.id === it.id) m.name = v.slice(0, 80); }); }); if (r.ok) drawFoods();
        } })));
    }
    upd();
    return box;
  }
  // Explicit "Save to My foods" from a CONFIRMED meal (History). Keeps source and estimate status; never edits the meal.
  function saveMealToMyFoods(m, picks) {
    var prefs = foodPrefs(), added = 0, skipped = 0, full = false;
    var r = saveFoodPrefs(function (rec) {
      picks.forEach(function (i) {
        var c = m.components[i]; if (!c) return;
        var exists = rec.myFoods.some(function (f) { return f.name.toLowerCase() === String(c.name).trim().toLowerCase() && (f.portion || '') === (c.portion || ''); });
        if (exists) { skipped++; return; }
        if (rec.myFoods.length >= FS.MAX_MY_FOODS) { full = true; return; }
        var x = FS.myFoodFromComponent(c, { id: 'mf-' + Date.now().toString(36) + '-' + i + '-' + Math.floor(Math.random() * 1e6).toString(36), savedAt: new Date().toISOString(), mealId: m.id, mealSource: m.source });
        if (x.ok) { rec.myFoods.unshift(x.food); added++; }
      });
    });
    if (r.ok) toast('My foods: ' + added + ' saved' + (skipped ? ', ' + skipped + ' already there' : '') + (full ? ' (limit of ' + FS.MAX_MY_FOODS + ' reached)' : '') + '. The meal itself was not changed.');
    void prefs;
    return r;
  }
  function myFoodsPanel(m) {
    var box = h('div', { class: 'note myfoods-pick', testid: 'myfoods-pick' });
    box.appendChild(h('p', { class: 'list-heading', text: 'Save to My foods' }));
    var checks = [];
    m.components.forEach(function (c, i) {
      if (!String(c.name || '').trim()) return;
      var cb = h('input', { type: 'checkbox', testid: 'myfoods-pick-item', checked: true });
      checks.push([cb, i]);
      box.appendChild(h('label', { class: 'check' }, cb, h('span', { text: c.name + (c.portion ? ' · ' + c.portion : '') })));
    });
    box.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn btn-primary btn-small', text: 'Save selected', testid: 'myfoods-pick-save', onclick: function () {
        var picks = checks.filter(function (x) { return x[0].checked; }).map(function (x) { return x[1]; });
        if (!picks.length) { toast('Nothing selected.', true); return; }
        var r = saveMealToMyFoods(m, picks); if (r.ok) { myFoodsOpenFor = null; renderHistory(); }
      } }),
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Cancel', testid: 'myfoods-pick-cancel', onclick: function () { myFoodsOpenFor = null; renderHistory(); } })));
    return box;
  }
  var myFoodsOpenFor = null;
  function renderMealForm(root) {
    if (!ms) setDraft(blankMeal('MANUAL'));
    renderedMs = ms;
    if (foodScr) { renderFoodScreen(root); return; }
    // P0: Add > Meal opens on the diary (date, Breakfast / Lunch / Dinner / Snacks, Uncategorized). Not while a dedicated
    // logger is open or a saved meal / a History copy is being worked on.
    if (!logCtx && !ms.id && !mealFromHistory) root.appendChild(h('div', { id: 'meal-diary-host' }, mealDiary()));
    var c = card(ms.id ? 'Edit meal' : 'Add a meal', 'meal-form');
    var hdDate = null;
    if (logCtx) {
      // P11: dedicated logger. The title and the date it logs for are always visible; Back asks before dropping anything.
      c.classList.add('logger-form');
      hdDate = h('p', { class: 'logger-date', testid: 'logger-date' });
      root.appendChild(h('header', { class: 'logger-head', testid: 'logger-head' },
        h('button', { type: 'button', class: 'logger-back', testid: 'logger-back', 'aria-label': 'Back to the meal diary', onclick: loggerBack }, h('span', { 'aria-hidden': 'true', text: '‹' }), ' Back'),
        h('div', { class: 'logger-titles' }, h('h2', { class: 'logger-title', testid: 'logger-title', tabindex: '-1', text: loggerTitle() }), hdDate)));
    }
    function drawHeaderDate() {
      if (!hdDate) return;
      var td = today();
      hdDate.replaceChildren(document.createTextNode(fmtDate(ms.date) + (ms.date === td ? ' · today' : '')));
      if (ms.date !== td) hdDate.appendChild(h('span', { class: 'badge badge-warn', testid: 'logger-not-today', text: ms.date > td ? 'future date' : 'not today' }));
    }
    drawHeaderDate();
    c.appendChild(mealCategoryPicker());
    // P11.2: the search-and-select food logger is the main way in; Photo, Description and Manual stay as alternatives.
    if (ms.source !== 'REUSE' && FS) c.appendChild(h('div', { class: 'foods-entry' },
      h('button', { type: 'button', class: 'btn btn-primary foods-open', testid: 'meal-add-foods', text: 'Add foods (search)', 'aria-describedby': 'meal-add-foods-hint', onclick: openFoods }),
      h('p', { class: 'hint', id: 'meal-add-foods-hint', text: 'Search USDA foods and your saved foods; add several, then confirm the meal once.' })));
    c.appendChild(h('p', { class: 'meal-cat-label', id: 'meal-path-label', text: 'Log with' }));
    c.appendChild(h('div', { class: 'segmented', role: 'group', 'aria-label': 'Meal input path' }, [['PHOTO_AI', 'Photo + description'], ['DESCRIPTION', 'Description only'], ['MANUAL', 'Manual'], ['REUSE', 'Reuse a meal']].map(function (p) {
      var on = p[0] === 'REUSE' ? ms.source === 'REUSE' : ms.source === p[0] || (p[0] === 'MANUAL' && ms.source === 'COPY');
      return h('button', { type: 'button', class: 'seg' + (on ? ' active' : ''), text: p[1], testid: 'meal-path-' + p[0].toLowerCase(),
        onclick: function () {
          if (on) return; // tapping the path already in use changes nothing and never asks (Claude P10b review)
          // Claude P10b review (owner decision): switching path never drops chosen photos (analysed or not, or still
          // being prepared) or typed content without asking. Editing a saved meal keeps its items; only photos go.
          if (ms.id) {
            var dropOnly = function () { ms.source = p[0] === 'REUSE' ? ms.source : p[0]; if (p[0] !== 'PHOTO_AI') dropPhoto(); dropEstimate(); renderAdd(); };
            if (p[0] !== 'PHOTO_AI' && (photos.length || photoBusy > 0)) askChoice({ title: 'Remove the chosen photos?', body: 'Switching away from Photo removes the photos you chose for this meal. Its saved items are kept.', yes: 'Remove photos', no: 'Keep photos', onYes: dropOnly, onNo: function () {} });
            else dropOnly();
            return;
          }
          withDraftDiscard(function () {
            var keepCat = ms.mealCategory; // P11: the chosen diary meal and the logger's date survive a path switch
            dropPhoto(); eatenCustom = false; setDraft(blankMeal(p[0] === 'REUSE' ? 'MANUAL' : p[0])); if (p[0] === 'REUSE') ms.source = 'REUSE';
            resetMealDraftLink(); // Claude QA of P1.4-RC2: the discarded meal's draft link must not follow the new blank meal (the "Unsaved meal restored" banner stayed on it)
            if (knownCat(keepCat)) ms.mealCategory = keepCat;
            if (logCtx) ms.date = logCtx.date;
            msBase = draftKey(ms); dropEstimate(); renderAdd(); });
        } });
    })));
    if (ms.source === 'REUSE') { c.appendChild(reuseList()); root.appendChild(c); return; }
    var err = h('p', { class: 'form-error', testid: 'meal-error', 'aria-live': 'polite' });
    mealDraftFormNotes(c);
    var mealConflictBox = h('div', { testid: 'meal-conflict-slot' });
    // Claude P10b review (owner decision): an unsaved meal started on an earlier Asia/Qatar day keeps its date and says so.
    // P11: not for a past date the owner chose on purpose in the diary (the logger header names that date).
    if (!ms.id && ms.date && ms.date < today() && !(logCtx && logCtx.fixed && logCtx.date === ms.date)) c.appendChild(h('div', { class: 'note note-warn', role: 'status', testid: 'meal-draft-date' },
      h('p', { text: 'This unsaved meal is dated ' + ms.date + ', not today (' + today() + '). Change the date below if it was eaten today, or discard it.' })));
    if (!ms.id) c.appendChild(h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Discard this draft', testid: 'meal-discard',
      onclick: function () { var src = ms.source === 'REUSE' || ms.source === 'COPY' ? 'MANUAL' : ms.source; withDraftDiscard(function () { resetMealDraft(src); go('add', 'meal'); renderAdd(); }); } })));
    if (ms.source === 'PHOTO_AI') c.appendChild(photoBlock());
    c.appendChild(h('div', { class: 'row' },
      field('Date', h('input', { type: 'date', value: ms.date, max: today(), testid: 'meal-date', onchange: function () { ms.date = this.value; drawHeaderDate(); } })),
      field('Time', h('input', { type: 'time', value: ms.time || '', testid: 'meal-time', onchange: function () { ms.time = this.value; } }))));
    // P0 (owner decision): no routine "Meal name" field - the diary meal already says Breakfast / Lunch / Dinner / Snacks.
    // A custom name stays possible here; a name the meal already has is shown (fold open) and kept exactly unless edited.
    var nameFold = h('details', { class: 'fold meal-name-fold', testid: 'meal-name-fold', ontoggle: function (e) { if (e.target === nameFold) mealNameOpen = nameFold.open; } },
      h('summary', { text: 'Edit details: custom name (optional)', testid: 'meal-name-toggle' }),
      field('Custom name', h('input', { type: 'text', value: ms.label || '', maxlength: '80', testid: 'meal-label', oninput: function () { ms.label = this.value; } })),
      h('p', { class: 'hint', text: 'Leave empty to show the diary meal (or Uncategorized) instead. Nothing is filled in for you.' }));
    if (mealNameOpen || String(ms.label || '').trim()) nameFold.open = true;
    var desc = h('textarea', { rows: '2', maxlength: '1000', testid: 'meal-description', placeholder: 'e.g. one plate rice and chicken, half eaten, sauce unknown', oninput: function () { ms.description = this.value; if (staleHook) staleHook(); if (reviewHook) reviewHook(); } });
    desc.value = ms.description || '';
    c.appendChild(field(ms.source === 'DESCRIPTION' ? 'Description (household portions are fine — no weighing needed)' : 'Description (optional)', desc));
    if (ms.source === 'DESCRIPTION') c.appendChild(estimateBlock(renderAdd));
    if (ms.ai) c.appendChild(h('p', {}, aiBadge(ms.ai), ms.ai.userCorrected ? badge('User-corrected', 'info') : null));
    reviewHook = null;
    if ((ms.components.some(function (x) { return String(x.name || '').trim(); }) && (ms.ai || AI.noteFractions(ms.description, ms.components).any || AI.overlapWarnings(ms.components).length)) || noteGate().open) c.appendChild(reviewBlock());
    var eatenHost = h('div');
    c.appendChild(eatenHost);
    c.appendChild(nameFold);
    c.appendChild(h('h3', { class: 'list-heading', text: 'Components (main, sides, oils, sauces, drinks)' }));
    var list = h('div', { testid: 'meal-components' });
    ms.components.forEach(function (comp, i) { list.appendChild(componentRow(comp, i)); });
    c.appendChild(list);
    c.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Add component', testid: 'meal-add-component', onclick: function () { ms.components.push(blankComponent()); markCorrected(); renderAdd(); } }));
    var totals = h('div', { class: 'totals-box', testid: 'meal-totals' });
    function drawTotals() {
      totals.replaceChildren();
      var t = HN.mealTotals(ms);
      HN.MACROS.forEach(function (k) {
        var x = t[k];
        totals.appendChild(h('span', { class: 'pill', testid: 'meal-total-' + k, text: label(k) + ': ' + (x.value === null ? 'unknown' : fmt(x.value)) + ' (' + x.state.toLowerCase() + (x.unknownCount && x.value !== null ? ', ' + x.unknownCount + ' unknown part' : '') + ')' }));
      });
      if (FSX) FSX.KEYS.forEach(function (k) {
        var t = FSX.mealTotal(ms, k);
        if (t.state === 'NONE') return;
        totals.appendChild(h('span', { class: 'pill pill-extra', testid: 'meal-total-' + k, text: FSX.NAME[k] + ': ' + (t.value === null ? 'unknown' : FSX.fmtNum(k, t.value) + ' ' + FSX.UNIT[k]) + ' (' + t.known + ' of ' + t.items + ' known)' }));
      });
      if (reviewHook) reviewHook();
    }
    drawTotals(); c._drawTotals = drawTotals; mealTotalsHook = drawTotals;
    eatenHost.appendChild(eatenBlock(drawTotals));
    c.appendChild(totals);
    c.appendChild(mealConflictBox);
    c.appendChild(err);
    function save(lifecycle) {
      // Sprint B2 (owner M1): the same unsaved meal was already saved or discarded in another tab of this app.
      if (mdOtherTab && !ms.id) { err.textContent = 'Not saved: this meal was already saved or discarded in another tab. Choose "Discard this copy" or "Keep it as a separate meal" above. Nothing was saved.'; return; }
      // Claude P6 review: an estimate on screen that is not in the meal must not be dropped without a word (the old
      // message, "every component needs a name", did not say what to do), nor must older components be confirmed under it.
      if (est && Array.isArray(est.items) && est.items.length && !est.applied) { err.textContent = 'Not saved: the estimate above is not in the meal yet. Press “Use these estimates in the meal”, or “Clear estimate” to enter the values yourself.'; return; }
      if (!ms.components.length) { err.textContent = 'Not saved: add at least one component (it can have unknown values).'; return; }
      if (ms.components.some(function (x) { return !String(x.name || '').trim(); })) { err.textContent = 'Not saved: every component needs a name.'; return; }
      if (ms.components.some(function (x) { return HN.MACROS.some(function (k) { return x[k].value !== null && isNaN(x[k].value); }); })) { err.textContent = 'Not saved: a number is invalid.'; return; }
      if (badFraction(ms.eatenFraction) || ms.components.some(function (x) { return badFraction(x.eatenFraction); })) { err.textContent = 'Not saved: an eaten amount must be between 0 and 100%.'; return; }
      // P0 sprint: a food named in the note that no item accounts for (or a food listed twice) must be added, edited or
      // acknowledged before the meal can count. Drafts may still be parked (they never count toward totals).
      if (lifecycle !== 'DRAFT' && noteGate().open) { err.textContent = 'Not saved: ' + noteGateText(noteGate()) + ' Add or edit an item, or acknowledge it in the review above. Nothing was saved.'; var nb = document.querySelector('[data-testid="meal-unaccounted"]'); if (nb && nb.scrollIntoView) nb.scrollIntoView({ block: 'center' }); return; }
      if (lifecycle === 'CONFIRMED' && estimateStale()) { err.textContent = 'Not confirmed: the photos or the note changed after the estimate. Analyze again, or press “Keep values as mine” above. Nothing was saved.'; return; }
      if (lifecycle === 'CONFIRMED' && !HN.fractionStated(ms)) { err.textContent = 'Not confirmed: say how much of the photographed meal you ate (25%, 50%, 75%, 100% or a custom amount). A photo is never assumed to be fully eaten.'; return; }
      if (mealConflict(mealConflictBox, err, function () { save(lifecycle); })) return;
      var rec = JSON.parse(JSON.stringify(ms));
      rec.lifecycle = lifecycle;
      rec.confirmedAt = lifecycle === 'CONFIRMED' ? new Date().toISOString() : null;
      if (rec.source === 'REUSE') rec.source = 'MANUAL';
      var res = persist('meals', rec, err);
      // P10b: after a verified save the Add form is rebuilt as an EMPTY draft on the same input path (it used to keep
      // showing the saved meal while the draft behind it was gone, so the next meal's typing was lost).
      if (res.ok) {
        var nextPath = ['PHOTO_AI', 'DESCRIPTION'].indexOf(rec.source) !== -1 && !rec.id ? rec.source : 'MANUAL';
        if (!ms.id) prefPath = nextPath; // P10b: a fresh entry keeps the input path of the last new meal
        var fromLogger = !!logCtx, fromHistory = mealFromHistory;
        clearMealDraft(true); // Sprint B2: only after a verified save; a refused or failed save keeps the local draft
        resetMealDraft(ms.id ? 'MANUAL' : nextPath);
        // P11.1: a CONFIRMED save on the general Add > Meal form (not History's own Edit / Copy) now also returns to the diary.
        if (fromLogger || (lifecycle === 'CONFIRMED' && !fromHistory)) {
          // P11: back to the diary of the day the meal was saved for, with its category open so the new record is visible.
          var key = knownCat(rec.mealCategory) ? rec.mealCategory : 'UNCAT';
          logCtx = null; setDiaryDate(rec.date); diaryOpen[key] = true;
          var justId = res.entry && res.entry.id ? res.entry.id : null;
          go('add', 'meal'); diaryJustSaved = justId; renderAdd(); refresh();
          var row = document.querySelector('[data-testid="diary-row-' + key.toLowerCase() + '"]');
          if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
          focusTestid('diary-toggle-' + key.toLowerCase());
        } else { renderAdd(); go('history'); }
      }
    }
    c.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn btn-primary', text: 'Confirm I ate this', testid: 'meal-confirm', onclick: function () { save('CONFIRMED'); } }),
      h('button', { type: 'button', class: 'btn btn-secondary', text: 'I ate this (confirm later)', testid: 'meal-consumed-intent', onclick: function () { save('CONSUMED_INTENT'); } }),
      h('button', { type: 'button', class: 'btn btn-secondary', text: 'Save draft', testid: 'meal-save-draft', onclick: function () { save('DRAFT'); } })));
    c.appendChild(h('p', { class: 'hint', text: 'Only confirmed meals count toward totals. Drafts and "I ate this" meals are not counted. Blank = unknown (never 0); type 0 only when you know it is zero.' }));
    root.appendChild(c);
  }
  var mealTotalsHook = null, eatenCustom = false, reviewHook = null;
  // P10: one compact, editable review of the draft: what was found, how much of each item counts, and the eaten
  // amounts read from the note (offered, never applied without a tap). All local: no analysis call is ever made here.
  function reviewBlock() {
    var box = h('section', { class: 'review-box', testid: 'meal-review-box', 'aria-label': 'Meal review' });
    box.appendChild(h('h3', { class: 'list-heading', text: 'Review' }));
    var lines = h('ul', { class: 'review-lines', testid: 'review-items' });
    var tot = h('p', { class: 'review-total', testid: 'review-total' });
    var noteBox = h('div', { testid: 'meal-note-fractions-host' });
    var overlap = h('div', { testid: 'meal-overlap-host' });
    var gateBox = h('div', { testid: 'meal-unaccounted-host' });
    box.appendChild(gateBox); box.appendChild(lines); box.appendChild(tot); box.appendChild(noteBox); box.appendChild(overlap);
    function v(m) { return m && m.value !== null && m.value !== undefined ? fmt(m.value) : '?'; }
    var gate = null;
    function draw() {
      lines.replaceChildren();
      gate = noteGateApplies() ? noteGate() : null;
      ms.components.forEach(function (comp) {
        if (!String(comp.name || '').trim()) return;
        var f = HN.eatenFractionOf(ms, comp);
        var own = typeof comp.eatenFraction === 'number' && !isNaN(comp.eatenFraction);
        var li = h('li', { testid: 'review-item', text: comp.name + (comp.portion ? ' — ' + comp.portion : '') + ' · ' + v(comp.kcal) + ' kcal · P ' + v(comp.proteinG) + ' · C ' + v(comp.carbsG) + ' · F ' + v(comp.fatG) +
          (ms.ai ? ' (as served)' : '') + ' · eaten: ' + (f === null || isNaN(f) ? 'not stated' : pct(f) + '%' + (own ? '' : ' (meal amount)')) });
        // P0 sprint: where the item came from and how sure the estimate is, on the review line itself (not only in details)
        if (gate) {
          var ci = ms.components.indexOf(comp);
          li.appendChild(h('span', { class: 'review-origin', testid: 'review-origin', text: ' · ' + (AI.ORIGIN_TEXT[gate.origin[ci]] || 'from photo') }));
          if (comp.confidence || comp.uncertainty) li.appendChild(h('span', { class: 'review-uncertainty', testid: 'review-uncertainty', text: ' · ' + (comp.confidence ? comp.confidence.toLowerCase() + ' confidence' : '') + (comp.uncertainty ? (comp.confidence ? ': ' : '') + comp.uncertainty : '') }));
        }
        lines.appendChild(li);
      });
      var t = HN.mealTotals(ms), k = t.kcal;
      tot.textContent = 'Counts as eaten: ' + (k.value === null ? 'unknown' : fmt(k.value) + ' kcal') + ' · protein ' + (t.proteinG.value === null ? '?' : fmt(t.proteinG.value)) + ' g · carbs ' + (t.carbsG.value === null ? '?' : fmt(t.carbsG.value)) + ' g · fat ' + (t.fatG.value === null ? '?' : fmt(t.fatG.value)) + ' g' +
        (k.state === 'PARTIAL' ? ' — partial: some items are unknown and are NOT counted as 0' : k.state === 'UNKNOWN' ? ' — not known yet' : '') + '.';
      // eaten amounts typed in the note
      noteBox.replaceChildren();
      var nf = AI.noteFractions(ms.description, ms.components);
      if (nf.suggestions.length || nf.meal || nf.unmatched.length) {
        var applied = nf.suggestions.every(function (sg) { return ms.components[sg.index] && ms.components[sg.index].eatenFraction === sg.fraction; }) && (!nf.meal || ms.eatenFraction === nf.meal.fraction);
        var nb = h('div', { class: 'note', testid: 'meal-note-fractions' }, h('p', { class: 'list-heading', text: applied && (nf.suggestions.length || nf.meal) ? 'Eaten amounts from your note — applied' : 'Eaten amounts from your note' }));
        var ul = h('ul');
        nf.suggestions.forEach(function (sg) { ul.appendChild(h('li', { testid: 'note-fraction', text: sg.name + ': ' + pct(sg.fraction) + '% eaten (from “' + sg.phrase + '”)' })); });
        if (nf.meal) ul.appendChild(h('li', { testid: 'note-fraction-meal', text: 'Whole meal: ' + pct(nf.meal.fraction) + '% eaten (from “' + nf.meal.text + '”), for items without their own amount' }));
        nf.unmatched.forEach(function (u) { ul.appendChild(h('li', { testid: 'note-fraction-unmatched', text: 'Not matched to an item: “' + u + '”. Set it on the item below.' })); });
        nb.appendChild(ul);
        if ((nf.suggestions.length || nf.meal) && !applied) nb.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Use these eaten amounts', testid: 'meal-note-fractions-apply', onclick: function () {
          // sets (never multiplies) each matched item's own amount: applying twice gives the same result
          nf.suggestions.forEach(function (sg) { if (ms.components[sg.index]) ms.components[sg.index].eatenFraction = sg.fraction; });
          if (nf.meal) { ms.eatenFraction = nf.meal.fraction; eatenCustom = HN.EATEN_PRESETS.indexOf(nf.meal.fraction) === -1; }
          renderAdd();
        } }));
        if (applied && (nf.suggestions.length || nf.meal)) nb.appendChild(h('p', { class: 'hint', testid: 'note-fractions-applied', text: 'Applied once to the items below. Edit any item to change it; nothing is sent again.' }));
        noteBox.appendChild(nb);
      }
      overlap.replaceChildren();
      AI.overlapWarnings(ms.components).forEach(function (w) { overlap.appendChild(h('p', { class: 'note note-warn', testid: 'meal-overlap-warning', text: 'Possible double count: ' + w.text })); });
      drawGate(gateBox, gate);
    }
    reviewHook = draw;
    draw();
    return box;
  }
  // ---- P0 sprint: photo + note reconciliation (pure checks in photo-ai.js; nothing is sent, nothing is confirmed) ----
  function noteGateApplies() { return !!(ms && ms.source === 'PHOTO_AI' && ms.ai && String(ms.description || '').trim()); }
  function noteGate() {
    if (!noteGateApplies()) return { open: 0, unaccounted: [], twice: [], origin: [], foods: [] };
    var named = ms.components.filter(function (c) { return String(c.name || '').trim(); });
    var r = AI.reconcileNote(ms.description, ms.components, ms.ai.acks);
    if (!named.length) r.origin = [];
    return r;
  }
  function noteGateText(g) {
    var parts = [];
    if (g.unaccounted.length) parts.push((g.unaccounted.length === 1 ? 'your note names a food' : 'your note names ' + g.unaccounted.length + ' foods') + ' that the estimate does not account for (' + g.unaccounted.map(function (u) { return '“' + u.text + '”'; }).join(', ') + ').');
    if (g.twice.length) parts.push(g.twice.map(function (t) { return '“' + t.text + '” is listed more than once.'; }).join(' '));
    return parts.join(' ');
  }
  function drawGate(host, g) {
    host.replaceChildren();
    if (!g || !g.open) return;
    var box = h('div', { class: 'note note-warn unaccounted-box', role: 'alert', testid: 'meal-unaccounted' },
      h('p', { class: 'list-heading', text: 'Not accounted for — check before saving' }),
      h('p', { text: 'The photo and your note are one meal. ' + noteGateText(g) + ' The meal cannot be confirmed until each line below is added, edited or acknowledged.' }));
    var ul = h('ul', { class: 'unaccounted-list' });
    g.unaccounted.forEach(function (u) {
      ul.appendChild(h('li', { testid: 'unaccounted-item' }, h('span', { class: 'unaccounted-text', text: '“' + u.text + '” — not in the estimate' }),
        h('span', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Add as item', testid: 'unaccounted-add', 'aria-label': 'Add “' + u.text + '” as an item with unknown values', onclick: function () {
            var c = blankComponent();
            c.name = noteItemName(u.text); c.portion = u.text.slice(0, 80); c.basis = 'USER';
            c.uncertainty = 'Added from your note; amounts unknown until you fill them in.';
            ms.components.push(c); markCorrected(); renderAdd();
            var rows = document.querySelectorAll('[data-testid="component-name"]'); if (rows.length) rows[rows.length - 1].focus();
          } }),
          h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Already included / not eaten', testid: 'unaccounted-ack', 'aria-label': 'Acknowledge “' + u.text + '”: already included or not eaten', onclick: function () {
            ms.ai.acks = (Array.isArray(ms.ai.acks) ? ms.ai.acks : []).concat([{ kind: 'FOOD', key: u.key, text: u.text.slice(0, 120) }]).slice(0, 40);
            renderAdd();
          } }))));
    });
    g.twice.forEach(function (t) {
      ul.appendChild(h('li', { testid: 'unaccounted-twice' }, h('span', { class: 'unaccounted-text', text: '“' + t.text + '” appears ' + t.indexes.length + ' times in the items. Remove the extra item below if it is the same food.' }),
        h('span', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'They are separate servings', testid: 'unaccounted-twice-ack', onclick: function () {
          ms.ai.acks = (Array.isArray(ms.ai.acks) ? ms.ai.acks : []).concat([{ kind: 'TWICE', key: t.key, text: t.text.slice(0, 120) }]).slice(0, 40);
          renderAdd();
        } }))));
    });
    box.appendChild(ul);
    box.appendChild(h('p', { class: 'hint', text: 'Added items start with unknown values (never 0). Nothing is sent again and nothing is confirmed for you.' }));
    host.appendChild(box);
  }
  function noteItemName(text) {
    var t = String(text || '').replace(/^\s*(?:\d{1,3}(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|some|a few|a couple of)\s+/i, '').trim();
    t = t || String(text || '').trim();
    return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 80);
  }
  function badFraction(f) { return f !== null && f !== undefined && !(typeof f === 'number' && f >= 0 && f <= 1); }
  function pct(f) { return Math.round(f * 1000) / 10; }
  // Owner rule 2: meal-level amount eaten. Scales kcal, protein, carbs and fat of every item
  // that has no amount of its own.
  function eatenBlock(redraw) {
    var box = h('div', { class: 'eaten-box', testid: 'meal-eaten' });
    var cur = typeof ms.eatenFraction === 'number' && !isNaN(ms.eatenFraction) ? ms.eatenFraction : null;
    var isPreset = cur !== null && HN.EATEN_PRESETS.indexOf(cur) !== -1;
    var custom = eatenCustom || (cur !== null && !isPreset);
    box.appendChild(h('h3', { class: 'list-heading', text: 'How much of this meal did you eat?' }));
    var seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Amount eaten' });
    HN.EATEN_PRESETS.forEach(function (f) {
      var on = !custom && cur === f;
      seg.appendChild(h('button', { type: 'button', class: 'seg' + (on ? ' active' : ''), 'aria-pressed': on ? 'true' : 'false', text: (f * 100) + '%', testid: 'meal-eaten-' + (f * 100),
        onclick: function () { eatenCustom = false; ms.eatenFraction = f; renderAdd(); } }));
    });
    seg.appendChild(h('button', { type: 'button', class: 'seg' + (custom ? ' active' : ''), 'aria-pressed': custom ? 'true' : 'false', text: 'Custom', testid: 'meal-eaten-custom',
      onclick: function () { eatenCustom = true; renderAdd(); } }));
    box.appendChild(seg);
    var state = h('p', { class: 'hint', testid: 'meal-eaten-state' });
    function describe() {
      var f = ms.eatenFraction;
      state.textContent = typeof f === 'number' && !badFraction(f)
        ? 'Counting ' + pct(f) + '% of calories, protein, carbs and fat for every item without its own amount.'
        : ms.source === 'PHOTO_AI' ? 'Not stated yet. A photographed meal is never assumed to be fully eaten — choose an amount (or set one per item) before confirming.'
        : 'No meal-level amount set: items without their own amount count in full.';
    }
    if (custom) {
      var inp = numIn(cur === null ? null : pct(cur), { min: '0', max: '100', testid: 'meal-eaten-custom-pct', placeholder: '% eaten', 'aria-label': 'Custom percent eaten' });
      inp.addEventListener('input', function () {
        var v = numOrNull(inp.value);
        ms.eatenFraction = v === null ? null : (isNaN(v) ? NaN : v / 100);
        describe(); redraw();
      });
      box.appendChild(field('Custom amount eaten (%)', inp));
    }
    describe();
    box.appendChild(state);
    return box;
  }
  function label(k) { return { kcal: 'kcal', proteinG: 'Protein g', carbsG: 'Carbs g', fatG: 'Fat g' }[k]; }
  function markCorrected() { if (ms && ms.ai && !ms.ai.userCorrected) { ms.ai.userCorrected = true; } }
  function aiBadge(ai) {
    return ai.mode === 'MOCK' ? badge('MOCK TEST — not a real analysis', 'warn', 'meal-ai-badge') : badge('REAL MODEL ESTIMATE — ' + ai.provider + ' / ' + ai.model, 'info', 'meal-ai-badge');
  }

  function componentRow(comp, i) {
    var row = h('div', { class: 'component', testid: 'component-row' });
    // P10: for a photo estimate the row stays compact (name, portion, eaten %, numbers); type, preparation, certainty and
    // confidence move into “Edit details”. Typed/manual meals keep every field open, as before.
    var compact = !!(ms && ms.ai);
    var more = compact ? h('details', { class: 'fold comp-details', testid: 'component-details' }, h('summary', { text: 'Edit details (type, preparation, certainty)' })) : row;
    var foodField = field('Food', h('input', { type: 'text', value: comp.name, maxlength: '80', testid: 'component-name', oninput: function () { comp.name = this.value; markCorrected(); if (reviewHook) reviewHook(); } }));
    var typeField = field('Type', select(HD.ENUMS.role.map(function (r) { return [r, r.charAt(0) + r.slice(1).toLowerCase()]; }), comp.role, { testid: 'component-role', onchange: function () { comp.role = this.value; markCorrected(); } }));
    if (compact) { row.appendChild(h('div', { class: 'row' }, foodField)); more.appendChild(typeField); }
    else row.appendChild(h('div', { class: 'row' }, foodField, typeField));
    row.appendChild(h('div', { class: 'row' },
      field('Portion (household)', h('input', { type: 'text', value: comp.portion || '', maxlength: '80', placeholder: 'one bowl, half plate…', testid: 'component-portion', oninput: function () { comp.portion = this.value; markCorrected(); } })),
      field('This item eaten (%)', numIn(typeof comp.eatenFraction === 'number' && !isNaN(comp.eatenFraction) ? pct(comp.eatenFraction) : null, { min: '0', max: '100', placeholder: 'same as meal', testid: 'component-eaten',
        oninput: function () { var v = numOrNull(this.value); comp.eatenFraction = v === null ? null : (isNaN(v) ? NaN : v / 100); if (mealTotalsHook) mealTotalsHook(); } }), 'Blank = same as the meal.')));
    more.appendChild(field('Preparation / cooking', h('input', { type: 'text', value: comp.preparation || '', maxlength: '80', placeholder: 'grilled, fried, raw…', testid: 'component-prep', oninput: function () { comp.preparation = this.value; markCorrected(); } })));
    var grid = h('div', { class: 'macro-grid' }), sgrid = compact ? h('div', { class: 'macro-grid' }) : null;
    HN.MACROS.forEach(function (k) {
      var m = comp[k];
      var inp = numIn(m.value, { 'aria-label': label(k), testid: 'component-' + k, placeholder: 'unknown' });
      var st = select([['KNOWN', 'Known'], ['ESTIMATED', 'Estimate'], ['UNKNOWN', 'Unknown']], m.state, { 'aria-label': label(k) + ' certainty', testid: 'component-' + k + '-state' });
      inp.addEventListener('input', function () {
        var v = numOrNull(inp.value);
        if (v === null) { comp[k] = HN.unknown(); st.value = 'UNKNOWN'; }
        else { comp[k] = { value: v, state: comp[k].state === 'UNKNOWN' ? 'ESTIMATED' : comp[k].state }; st.value = comp[k].state; }
        if (comp.provenance) {
          delete comp.provenance; var pv = row.querySelector('[data-testid="component-provenance"]'); if (pv) pv.textContent = 'You changed a number, so this is now your own value (the USDA source note was removed).';
          // P11.3: USDA fiber/sodium belonged to that USDA amount; they become unknown (not kept, not guessed) unless you type them.
          var cleared = false;
          ['fiberG', 'sodiumMg'].forEach(function (x) { if (comp[x] && comp[x].state === 'ESTIMATED' && !ownerExtra(comp[x])) { delete comp[x]; cleared = true; var el = row.querySelector('[data-testid="component-' + x + '"]'); if (el) el.value = ''; var se = row.querySelector('[data-testid="component-' + x + '-state"]'); if (se) se.value = 'UNKNOWN'; } });
          if (cleared) { var xn = row.querySelector('[data-testid="component-extra-note"]'); if (xn) xn.textContent = 'Fiber/sodium from USDA were cleared because you changed a number; type them if you know them.'; }
        }
        markCorrected(); if (mealTotalsHook) mealTotalsHook();
      });
      st.addEventListener('change', function () {
        if (st.value === 'UNKNOWN') { comp[k] = HN.unknown(); inp.value = ''; }
        else if (comp[k].value === null) { st.value = 'UNKNOWN'; toast('Enter a number first; blank stays unknown.', true); return; }
        else comp[k] = { value: comp[k].value, state: st.value };
        markCorrected(); if (mealTotalsHook) mealTotalsHook();
      });
      if (compact) { grid.appendChild(h('div', { class: 'macro' }, h('span', { class: 'mini-label', text: label(k) }), inp)); sgrid.appendChild(h('div', { class: 'macro' }, h('span', { class: 'mini-label', text: label(k) + ' certainty' }), st)); }
      else grid.appendChild(h('div', { class: 'macro' }, h('span', { class: 'mini-label', text: label(k) }), inp, st));
    });
    row.appendChild(grid);
    row.appendChild(extraFields(comp, row));
    if (compact) { more.appendChild(sgrid); row.appendChild(more); }
    if (comp.provenance && typeof comp.provenance === 'object') more.appendChild(h('p', { class: 'hint', testid: 'component-provenance', text: 'Estimate. Source: ' + provText(comp.provenance) + '. If you change a number above it becomes your own number and this source note is removed.' }));
    if (comp.uncertainty || comp.confidence) more.appendChild(h('p', { class: 'hint', text: 'AI confidence: ' + (comp.confidence || '—') + (comp.uncertainty ? ' · ' + comp.uncertainty : '') }));
    row.appendChild(h('button', { type: 'button', class: 'btn btn-small btn-delete', text: 'Remove component', testid: 'component-remove', onclick: function () { ms.components.splice(i, 1); markCorrected(); renderAdd(); } }));
    return row;
  }

  // Phase 11.3: optional fiber (g) and sodium (mg) for one item, in a fold. Blank = unknown (the field is not stored), never 0.
  // These never change kcal/macros or day states. Values are for the whole item; the eaten fraction is applied once in totals.
  // RC1 review (A-02): a fiber/sodium number the owner typed in this form is the owner's, even when its certainty is left
  // at "Estimate"; changing kcal/macros afterwards removes only the USDA-derived values, never a typed one.
  // RC2 review: that origin is now stored on the value itself ({value, state, by: 'OWNER'}), so it survives saving,
  // reopening, Edit, Copy, My foods, backup and restore (RC1 kept it only in memory for the open form). Older versions
  // ignore the extra field and keep it. Values without the marker (USDA-derived, or typed before RC2) behave as in RC1.
  function ownerExtra(m) { return FS && FS.isOwnerExtra ? FS.isOwnerExtra(m) : !!(m && m.by === 'OWNER'); }
  function extraFields(comp, row) {
    var have = FSX && FSX.KEYS.some(function (k) { return FSX.itemValue(comp, k); });
    var d = h('details', { class: 'fold comp-extra', testid: 'component-extra' }, h('summary', { text: 'Fiber & sodium (optional)' + (have ? ' · ' + FSX.KEYS.map(function (k) { var v = FSX.itemValue(comp, k); return v ? FSX.fmtNum(k, v.value) + ' ' + FSX.UNIT[k] : '?'; }).join(' / ') : '') }));
    if (!FSX) return d;
    var g = h('div', { class: 'macro-grid' });
    FSX.KEYS.forEach(function (k) {
      var v = FSX.itemValue(comp, k), lab = FSX.NAME[k] + ' (' + FSX.UNIT[k] + ')';
      var inp = numIn(v ? v.value : null, { 'aria-label': lab, testid: 'component-' + k, placeholder: 'unknown', min: '0', max: String(FSX.LIMIT[k]) });
      var st = select([['KNOWN', 'Known'], ['ESTIMATED', 'Estimate'], ['UNKNOWN', 'Unknown']], v ? v.state : 'UNKNOWN', { 'aria-label': lab + ' certainty', testid: 'component-' + k + '-state' });
      inp.addEventListener('input', function () {
        var n = numOrNull(inp.value);
        if (n === null || isNaN(n) || n < 0 || n > FSX.LIMIT[k]) { delete comp[k]; st.value = 'UNKNOWN'; }
        else { var cur = FSX.itemValue(comp, k); comp[k] = { value: n, state: cur ? cur.state : 'KNOWN', by: 'OWNER' }; st.value = comp[k].state; }
        markCorrected(); if (mealTotalsHook) mealTotalsHook();
      });
      st.addEventListener('change', function () {
        if (st.value === 'UNKNOWN') { delete comp[k]; inp.value = ''; }
        else if (!FSX.itemValue(comp, k)) { st.value = 'UNKNOWN'; toast('Enter a number first; blank stays unknown.', true); return; }
        else { var was = ownerExtra(comp[k]); comp[k] = { value: comp[k].value, state: st.value }; if (was) comp[k].by = 'OWNER'; }
        markCorrected(); if (mealTotalsHook) mealTotalsHook();
      });
      g.appendChild(h('div', { class: 'macro' }, h('span', { class: 'mini-label', text: lab }), inp, st));
    });
    d.appendChild(g);
    d.appendChild(h('p', { class: 'hint', testid: 'component-extra-note', text: 'For the whole item as listed; the eaten amount is applied in totals. Blank = unknown (not 0). Type 0 only if it really has none.' }));
    if (have) d.open = true;
    return d;
  }
  function reuseList() {
    var box = h('div', { testid: 'reuse-list' });
    var confirmed = allMeals().filter(function (m) { return m.lifecycle === 'CONFIRMED'; }).slice(0, 30);
    if (!confirmed.length) box.appendChild(h('p', { class: 'muted', text: 'No confirmed meals to reuse yet.' }));
    confirmed.forEach(function (m) {
      var t = HN.mealTotals(m);
      box.appendChild(h('div', { class: 'entry', testid: 'reuse-item' }, h('div', { class: 'entry-body' }, h('div', { class: 'entry-title', text: (m.label || 'Meal') + (m.legacy ? ' (classic)' : '') }),
        h('div', { class: 'entry-meta', text: fmtDate(m.date) + ' · ' + (t.kcal.value === null ? 'kcal unknown' : fmt(t.kcal.value) + ' kcal') })),
        h('button', { type: 'button', class: 'btn btn-small btn-secondary', text: 'Copy as draft', testid: 'reuse-copy', onclick: function () { copyMeal(m, true); } })));
    });
    return box;
  }

  // ---------- photo + AI ----------
  function aiSettings() {
    try { var s = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || 'null'); if (s && typeof s === 'object') return s; } catch (e) { /* ignore */ }
    return { provider: 'none', endpoint: '/api/food-photo', privacyAckAt: null };
  }
  function saveAiSettings(s) {
    try { localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(s)); return localStorage.getItem(AI_SETTINGS_KEY) === JSON.stringify(s); } catch (e) { return false; }
  }
  function ownerCode() { try { return localStorage.getItem(AI_CODE_KEY) || ''; } catch (e) { return ''; } }
  function saveOwnerCode(c) { try { localStorage.setItem(AI_CODE_KEY, c || ''); return true; } /* clearing stores '' - never deletes a key (P6-DL-6 audit) */ catch (e) { return false; } }
  // Cached connection state of the live (private server) provider. Re-checked at most once a minute, or when forced.
  var liveStatus = { state: null, at: 0, checking: false };
  function refreshLive(force, onChange) {
    var prov = currentProvider();
    if (!prov.live || liveStatus.checking) return;
    if (!force && liveStatus.state && Date.now() - liveStatus.at < 60000) return;
    liveStatus.checking = true;
    var before = liveStatus.state;
    prov.check().then(function (r) {
      liveStatus = { state: r.state, info: r.info || null, at: Date.now(), checking: false };
      if (onChange && r.state !== before) onChange();
    });
  }
  function currentProvider() {
    var s = aiSettings();
    if (s.provider === 'live') return AI.providers.http({ endpoint: '/api/food-photo', live: true, label: 'Photo analysis (OpenAI, via your private server)', getToken: ownerCode });
    if (s.provider === 'mock') return AI.providers.mock({ scenario: s.mockScenario || 'plate' });
    if (s.provider === 'http') return AI.providers.http({ endpoint: s.endpoint || '/api/food-photo' });
    return AI.providers.unconfigured();
  }

  // P10: 1-3 photos of ONE meal, kept only in memory (never in localStorage, backups or logs).
  // photos[i] = { pid, image, url, label, originalBytes }. aiBasis = what the current estimate was made from.
  var photoSeq = 0, photoBusy = 0, aiBasis = null, staleHook = null, draftNonce = 'n' + Date.now().toString(36);
  function photoBasis() { return photos.map(function (p) { return p.pid + ':' + p.label; }).join(',') + '|' + AI.analysisNote(ms ? ms.description : ''); }
  function estimateStale() { return aiBasis !== null && !!ms && !!ms.ai && photoBasis() !== aiBasis; }
  // fingerprint of the ORIGINAL file (kept in memory only), so choosing the same file twice is caught even when the
  // browser's re-encode is not byte-identical
  function srcPrint(f) {
    if (!f || typeof f.arrayBuffer !== 'function') return Promise.resolve(null);
    return f.arrayBuffer().then(function (buf) {
      var u = new Uint8Array(buf), h1 = 2166136261, h2 = 2166136261 ^ 0x5bd1e995;
      for (var i = 0; i < u.length; i++) { h1 = Math.imul(h1 ^ u[i], 16777619) >>> 0; h2 = Math.imul(h2 ^ u[u.length - 1 - i], 16777619) >>> 0; }
      return u.length + ':' + h1.toString(36) + ':' + h2.toString(36);
    }, function () { return null; });
  }
  function samePhoto(a, b) {
    if (a.bytes.length !== b.bytes.length) return false;
    for (var i = 0; i < a.bytes.length; i++) if (a.bytes[i] !== b.bytes[i]) return false;
    return true;
  }
  function photoBlock() {
    var box = h('div', { class: 'photo-box', testid: 'photo-box' });
    var prov = currentProvider(), s = aiSettings();
    var max = AI.LIMITS.maxImages || 3;
    box.appendChild(h('p', { class: 'note', testid: 'photo-food-only', text: 'FOOD ONLY: frame just the plate. No people, faces, badges, screens, documents, signage, locations or facility interiors. Removing metadata does NOT remove anything visible in the picture.' }));
    var status = h('p', { class: 'note', testid: 'photo-status', role: 'status', 'aria-live': 'polite' });
    function onFiles(list) {
      var files = Array.prototype.slice.call(list || []);
      if (!files.length) return; // picker cancelled: the draft is unchanged
      photoError = null;
      var room = max - photos.length - photoBusy;
      var take = files.slice(0, Math.max(0, room)), skipped = files.length - take.length;
      if (skipped > 0) photoError = 'At most ' + max + ' photos per meal. ' + skipped + (skipped === 1 ? ' photo was' : ' photos were') + ' not added.';
      if (!take.length) { renderAdd(); return; }
      photoBusy += take.length; renderAdd();
      var st = document.querySelector('[data-testid="photo-status"]');
      if (st) st.textContent = 'Preparing ' + (take.length === 1 ? 'photo' : take.length + ' photos') + ' on this device (removing metadata)…';
      take.forEach(function (f) {
        var seq = ++photoSeq, gen = photoGen; // photos keep the order they were chosen in, whatever order their encodes finish
        Promise.all([AI.sanitizeInBrowser(f), srcPrint(f)]).then(function (both) {
          var r = both[0], src = both[1];
          photoBusy = Math.max(0, photoBusy - 1);
          if (!ms || ms.source !== 'PHOTO_AI') return; // the owner left the photo meal meanwhile: keep nothing
          if (gen !== photoGen) { renderAdd(); return; } // the set was cleared meanwhile (failed photo / new meal): keep nothing
          if (!r.ok) { failedPhoto(r.message); return; }
          if (photos.some(function (p) { return (src && p.src === src) || samePhoto(p.image, r.image); })) { photoError = (photoError ? photoError + ' ' : '') + 'That photo is already added, so it was not added twice.'; renderAdd(); return; }
          if (photos.length >= max) { photoError = 'At most ' + max + ' photos per meal. A photo was not added.'; renderAdd(); return; }
          photos.push({ pid: seq, src: src, image: r.image, url: URL.createObjectURL(r.image.blob), label: 'SAME_PLATE', originalBytes: f.size });
          photos.sort(function (x, y) { return x.pid - y.pid; });
          renderAdd();
        }, function () { photoBusy = Math.max(0, photoBusy - 1); if (gen !== photoGen) { renderAdd(); return; } failedPhoto('This photo could not be prepared.'); });
      });
    }
    var full = photos.length + photoBusy >= max;
    var camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden', id: 'photo-camera', testid: 'photo-camera-input', disabled: full, onchange: function () { var f = this.files; var c = f ? Array.prototype.slice.call(f) : []; this.value = ''; onFiles(c); } });
    var library = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif', multiple: true, class: 'visually-hidden', id: 'photo-library', testid: 'photo-library-input', disabled: full, onchange: function () { var f = this.files; var c = f ? Array.prototype.slice.call(f) : []; this.value = ''; onFiles(c); } });
    var more = photos.length > 0;
    box.appendChild(h('div', { class: 'btn-row' }, camera, h('label', { for: 'photo-camera', class: 'btn btn-secondary btn-file' + (full ? ' is-disabled' : ''), 'aria-disabled': full ? 'true' : 'false', text: more ? 'Take another photo' : 'Take photo', testid: 'photo-camera-btn' }),
      library, h('label', { for: 'photo-library', class: 'btn btn-secondary btn-file' + (full ? ' is-disabled' : ''), 'aria-disabled': full ? 'true' : 'false', text: more ? 'Add from library' : 'Choose from library', testid: 'photo-library-btn' })));
    box.appendChild(h('p', { class: 'hint', testid: 'photo-count', text: photos.length + ' of ' + max + ' photos' + (full ? ' — the maximum for one meal.' : '. Add up to ' + max + ' views of the SAME meal (other angles, before/after, or another dish of this meal); they are estimated together as one meal, never added up per photo.') }));
    if (photos.length) {
      var strip = h('div', { class: 'photo-strip', testid: 'photo-strip' });
      photos.forEach(function (p, i) {
        var cell = h('div', { class: 'photo-cell', testid: 'photo-cell' });
        cell.appendChild(h('img', { src: p.url, alt: 'Photo ' + (i + 1) + ' of the meal (kept only in memory)', class: 'photo-preview', testid: 'photo-preview' }));
        cell.appendChild(field('View', select(AI.LABELS.map(function (l) { return [l, AI.LABEL_NAMES[l]]; }), p.label, { testid: 'photo-label', 'aria-label': 'What photo ' + (i + 1) + ' shows',
          onchange: function () { p.label = this.value; if (staleHook) staleHook(); } })));
        cell.appendChild(h('p', { class: 'hint', testid: 'photo-sanitized', text: 'Metadata removed on this device (EXIF/GPS/XMP stripped, re-encoded ' + p.image.width + '×' + p.image.height + ', ' + Math.round(p.image.bytes.length / 1024) + ' KB). Never saved or exported.' }));
        cell.appendChild(h('button', { type: 'button', class: 'btn btn-small btn-delete', text: photos.length > 1 ? 'Remove photo ' + (i + 1) : 'Discard photo', testid: 'photo-discard', onclick: function () {
          if (p.url) URL.revokeObjectURL(p.url);
          photos.splice(photos.indexOf(p), 1); photoError = null; renderAdd();
        } }));
        strip.appendChild(cell);
      });
      box.appendChild(strip);
    }
    if (photoBusy) box.appendChild(h('p', { class: 'hint', testid: 'photo-busy', text: 'Preparing photo… you can keep typing.' }));
    var sentNote = AI.analysisNote(ms.description);
    if (photos.length) {
      box.appendChild(h('p', { testid: 'photo-provider' }, 'Analysis provider: ', h('strong', { text: prov.label }), prov.mode === 'MOCK' ? badge('MOCK TEST', 'warn') : null));
      if (prov.mode === 'NONE') {
        box.appendChild(h('p', { class: 'note note-warn', testid: 'photo-not-configured', text: 'Photo analysis not configured. Nothing will be sent. Describe the meal and add components manually below (or set up a provider in Settings).' }));
      } else if (prov.live && liveStatus.state !== 'ready') {
        refreshLive(false, function () { if (photos.length && ms && ms.source === 'PHOTO_AI') renderAdd(); });
        box.appendChild(liveStateNote());
      } else {
        if (!s.privacyAckAt) {
          box.appendChild(h('label', { class: 'check note' }, h('input', { type: 'checkbox', testid: 'photo-privacy-ack', onchange: function () { var n = aiSettings(); n.privacyAckAt = this.checked ? new Date().toISOString() : null; saveAiSettings(n); renderAdd(); } }),
            h('span', { text: prov.live ? 'One-time privacy acknowledgment: I understand a food photo (metadata removed) goes to OpenAI through my private server only when I press Analyze, that OpenAI may keep it up to 30 days for abuse monitoring and does not train on it by default, that results are estimates, and that anything visible in the picture is not removed.'
              : 'One-time privacy acknowledgment: I understand food photos (metadata removed) may be sent for analysis only when I press Send, that results are estimates, and that visible content is not removed.' })));
        } else {
          var n = photos.length;
          var send = h('input', { type: 'checkbox', testid: 'photo-send-consent' });
          var btn = h('button', { type: 'button', class: 'btn btn-primary', disabled: true, testid: 'photo-send', text: prov.mode === 'MOCK' ? 'Run MOCK TEST (nothing is sent)' : prov.live ? (n > 1 ? 'Analyze ' + n + ' photos' : 'Analyze photo') : 'Send this photo for estimate' });
          send.addEventListener('change', function () { btn.disabled = !send.checked || photoBusy > 0; });
          box.appendChild(h('label', { class: 'check' }, send, h('span', { text: prov.mode === 'MOCK' ? 'Use the MOCK TEST provider for ' + (n > 1 ? 'these photos' : 'this photo') + ' (fixture data, no network).'
            : prov.live ? (n > 1 ? 'Send THESE ' + n + ' photos to OpenAI (through your private server) as ONE request to estimate this meal.' : 'Send THIS photo to OpenAI (through your private server) to estimate the meal.')
            : 'Send THIS photo to ' + prov.label + '. ' + (prov.mode === 'REAL' ? 'This is a REAL model call. Real food photos are not approved yet — approved synthetic test image only.' : '') })));
          if (sentNote !== String(ms.description || '').trim() && String(ms.description || '').trim()) box.appendChild(h('p', { class: 'hint', testid: 'photo-note-local', text: 'Eaten amounts in your note stay on this phone and are not sent. Sent note: ' + (sentNote ? '“' + sentNote + '”' : '(none)') + '.' }));
          box.appendChild(btn);
          btn.addEventListener('click', function () {
            if (!send.checked || !photos.length || photoBusy) return;
            btn.disabled = true; send.disabled = true;
            var set = photos.map(function (p) { return { image: p.image, label: p.label }; }), basis = photoBasis(), note = AI.analysisNote(ms.description);
            var forMs = ms, forGen = photoGen; // P10b: an answer that arrives after this draft was saved or replaced is not applied
            status.textContent = prov.mode === 'MOCK' ? 'Running MOCK TEST…' : prov.live ? 'Analyzing… this can take up to 45 seconds.' : 'Sending to analysis service…';
            if (diagHost) diagHost.replaceChildren();
            aiSession = aiSession && aiSession.provider === prov.id ? aiSession : { provider: prov.id, s: AI.createSession(prov) };
            // A retry of the same photos + note reuses the same request id: the server replays or refuses an overlapping call.
            var reqId = set.length === 1 && !prov.live ? 'r' + Date.now() : AI.requestKey(set, note, draftNonce);
            aiSession.s.analyze({ images: set, description: note, consent: { privacyAck: true, sendThisPhoto: true }, requestId: reqId }).then(function (res) {
              if (ms !== forMs || photoGen !== forGen) { if (res.ok) toast('An estimate arrived for a meal you already saved or discarded. It was not added to the current meal.'); return; }
              if (!res.ok && prov.live) {
                if (['AUTH', 'LOCKED_OUT', 'NOT_CONFIGURED', 'STORAGE_UNAVAILABLE'].indexOf(res.code) !== -1) liveStatus = { state: null, at: 0, checking: false }; // re-check next time
                status.textContent = AI.friendlyMessage(res.code, res.message, res.diag) + ' You can enter the meal manually below.';
                showDiag(res);
                btn.disabled = true; send.disabled = false; send.checked = false; return;
              }
              if (!res.ok) { status.textContent = 'No estimate (' + res.code + '): ' + res.message + (/nothing was (saved|sent)/i.test(res.message) ? '' : ' Nothing was saved.') + ' You can enter the meal manually below.'; btn.disabled = false; send.disabled = false; send.checked = false; btn.disabled = true; return; }
              var comps = AI.resultToComponents(res.result);
              // Re-analysis never silently overwrites the owner's edits, and never confirms anything.
              var applyEstimate = function () {
              if (ms !== forMs || photoGen !== forGen) { toast('An estimate arrived for a meal you already saved or discarded. It was not added to the current meal.'); return; }
              ms.components = comps.length ? comps : [blankComponent()];
              // P0 sprint: a new estimate starts with no acknowledgements; every food named in the note is checked again
              ms.ai = { mode: res.result.mode, provider: res.result.provider, model: res.result.model, analyzedAt: res.result.analyzedAt, warnings: res.result.warnings, userCorrected: false, acks: [] };
              ms.lifecycle = 'NEEDS_REVIEW';
              aiBasis = basis;
              lastAiWarnings = res.result.warnings;
              renderAdd();
              toast(res.result.mode === 'MOCK' ? 'MOCK TEST result loaded — not a real analysis. Review before saving.' : 'Estimate received — review every value before confirming.');
              };
              // Re-analysis never silently overwrites the owner's edits, and never confirms anything (Claude P10b: in-app dialog).
              if (ms.components.some(function (x) { return x.name; })) askChoice({ title: 'Replace the current items with the estimate?', body: 'Your items for this meal will be replaced by the new estimate. Nothing is saved until you confirm the meal.', yes: 'Replace items', no: 'Keep my items', onYes: applyEstimate, onNo: function () { status.textContent = 'Estimate discarded. Analysing the same photos again does not charge again.'; } });
              else applyEstimate();
            });
          });
        }
      }
    }
    var diagHost = h('div', { testid: 'photo-diag-host' });
    function showDiag(res) {
      diagHost.replaceChildren();
      if (!res || !res.diag) return;
      var d = res.diag, parts = [];
      if (d.category) parts.push('Category: ' + d.category);
      if (d.providerStatus) parts.push('OpenAI HTTP status: ' + d.providerStatus);
      if (d.providerCode) parts.push('OpenAI code: ' + d.providerCode);
      if (d.providerRequestId) parts.push('OpenAI request id: ' + d.providerRequestId);
      diagHost.appendChild(h('details', { class: 'fold', testid: 'photo-error-details' }, h('summary', { text: 'Details for the owner' }), h('p', { class: 'hint', testid: 'photo-error-diag', text: parts.join(' · ') + '. No photo, note, key or access code is included.' })));
    }
    var staleBox = h('div', { testid: 'photo-stale-host' });
    staleHook = function () {
      staleBox.replaceChildren();
      if (!estimateStale()) return;
      staleBox.appendChild(h('div', { class: 'note note-warn', testid: 'photo-estimate-stale', role: 'status' },
        h('p', { text: 'The photos or the note changed after this estimate, so it may not match any more. Analyze again, or keep the values below as your own. Changing only how much you ate never needs a new analysis.' }),
        h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Keep values as mine', testid: 'photo-stale-keep', onclick: function () { aiBasis = photoBasis(); markCorrected(); renderAdd(); } })));
    };
    staleHook();
    box.appendChild(staleBox);
    if (ms.ai && ms.ai.mode === 'REAL' && ms.lifecycle === 'NEEDS_REVIEW') box.appendChild(h('p', { class: 'note', testid: 'photo-review-note', text: 'Review & save: check each item, fix anything wrong, say how much you ate, then press “Confirm I ate this”. Nothing is saved until you do.' }));
    if (ms.ai && ms.ai.warnings && ms.ai.warnings.length) box.appendChild(h('ul', { class: 'preview-warnings', testid: 'photo-warnings' }, ms.ai.warnings.map(function (w) { return h('li', { text: w }); })));
    if (photoError) status.textContent = photoError;
    box.appendChild(status);
    box.appendChild(diagHost);
    return box;
  }
  var lastAiWarnings = null, photoError = null;
  function liveStateNote() {
    var st = liveStatus.state, msg;
    if (!st) msg = 'Checking photo analysis…';
    else if (st === 'not_configured') msg = AI.friendlyMessage('NOT_CONFIGURED');
    else if (st === 'needs_code') msg = 'Enter your owner access code in Settings to use photo analysis. Nothing is sent without it.';
    else if (st === 'bad_code') msg = AI.friendlyMessage('AUTH');
    else if (st === 'locked') msg = AI.friendlyMessage('LOCKED_OUT');
    else if (st === 'offline') msg = AI.friendlyMessage('OFFLINE');
    else msg = AI.friendlyMessage('NETWORK');
    var n = h('div', { class: 'note note-warn', testid: 'photo-live-state', 'data-state': st || 'checking', role: 'status' }, h('p', { text: msg + (st && st !== 'needs_code' && st !== 'bad_code' ? ' You can still describe the meal or enter it manually below.' : '') }));
    var row = h('div', { class: 'btn-row' });
    if (st === 'needs_code' || st === 'bad_code') row.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Open Settings', testid: 'photo-live-settings', onclick: function () { go('settings'); } }));
    if (st && st !== 'needs_code') row.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Check again', testid: 'photo-live-retry', onclick: function () { liveStatus = { state: null, at: 0, checking: false }; renderAdd(); } }));
    if (row.childNodes.length) n.appendChild(row);
    return n;
  }

  // ================= ADD: BODY / DAILY / WALK =================
  function renderBodyForm(root) {
    var c = card('Waist (at navel)', 'waist-form');
    var err = h('p', { class: 'form-error', testid: 'waist-error' });
    var date = h('input', { type: 'date', value: today(), max: today(), testid: 'waist-date' });
    var val = numIn(null, { testid: 'waist-cm', placeholder: 'cm' });
    var st = select([['OBSERVED', 'Measured'], ['MISSING', 'Not measured'], ['DECLINED', 'Declined'], ['NOT_TRACKED', 'Not tracked']], 'OBSERVED', { testid: 'waist-state' });
    c.appendChild(h('div', { class: 'row' }, field('Measured on', date), field('Waist (cm)', val)));
    c.appendChild(field('Status', st));
    c.appendChild(err);
    c.appendChild(h('button', { type: 'button', class: 'btn btn-primary', text: 'Save waist', testid: 'waist-submit', onclick: function () {
      var v = numOrNull(val.value);
      var res = persist('body', { metric: 'waist_cm', date: date.value, state: st.value, value: st.value === 'OBSERVED' ? v : null, source: 'manual' }, err);
      if (res.ok) val.value = '';
    } }));
    root.appendChild(c);
  }

  // ================= P1.1: UNITS (Settings) =================
  // One preference: show and type body weight in kg or lb. Saved as one field on the existing settings record, read fresh
  // at save time so anything changed meanwhile (baselines, saved foods, plan blocks) is kept. Stored weights stay in kg.
  function unitsCard() {
    var c = card('Units', 'units-card'), cur = wUnit();
    var err = h('p', { class: 'form-error', testid: 'units-error', 'aria-live': 'polite' });
    var seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Body weight unit' });
    [['kg', 'Kilograms (kg)'], ['lb', 'Pounds (lb)']].forEach(function (u) {
      seg.appendChild(h('button', { type: 'button', class: 'seg' + (cur === u[0] ? ' active' : ''), 'aria-pressed': cur === u[0] ? 'true' : 'false', text: u[1], testid: 'unit-' + u[0], onclick: function () {
        if (damaged().some(function (d) { return d.collection === 'ownerSettings'; })) { err.textContent = 'Not saved: your saved settings have a value that is not valid. Fix it under “My baselines” first. Nothing was changed.'; return; }
        dropReadMemo();
        if (wUnit() === u[0]) { err.textContent = ''; return; }
        var res = persist('ownerSettings', HM.settingsWithUnit(settings().record, u[0], HD.SETTINGS_ID, today()), err);
        if (res.ok) { try { window.dispatchEvent(new CustomEvent('hyrox:weight-unit')); } catch (e) { /* older browsers */ } renderSettings(); if (addMode === 'morning') renderAdd(); var b = document.querySelector('[data-testid="unit-' + u[0] + '"]'); if (b) b.focus(); }
      } }));
    });
    c.appendChild(seg);
    c.appendChild(h('p', { class: 'hint', testid: 'units-note', text: 'Body weight only. Your weights are always stored in kg with one decimal; pounds are worked out from the stored kg each time they are shown, so switching back and forth never changes a saved value. A weight typed in pounds is stored as the nearest 0.1 kg, so it can read back up to 0.1 lb different. Backups stay in kg.' }));
    c.appendChild(err);
    return c;
  }

  // ================= P1.1: MORNING LOG (Add > Morning) =================
  // One optional, compact form for what is read off the scale and the watch in the morning. It writes only through the
  // existing validated paths and record identities: weight (classic list, kg), waist (body), sleep + resting HR (that
  // morning's check-in), steps + Garmin intensity minutes (the previous day's check-in). A blank field changes nothing;
  // 0 is saved only where typed. Every other value of those check-ins is kept exactly as it is.
  var morn = { mode: 'TODAY', date: null, msg: null, bad: false };
  function mornDate(td) { return morn.mode === 'TODAY' ? td : morn.mode === 'YESTERDAY' ? AI.addDaysIso(td, -1) : (morn.date || ''); }
  function obsVal(rec, k) { return rec && rec[k] && rec[k].state === 'OBSERVED' && typeof rec[k].value === 'number' ? rec[k].value : null; }
  function mornRead(M) {
    var P = AI.addDaysIso(M, -1), daily = recs('daily');
    return { M: M, P: P,
      weights: legacy('weight').filter(function (w) { return w && w.date === M && typeof w.kg === 'number' && isFinite(w.kg); }),
      waists: recs('body').filter(function (b) { return b && b.metric === 'waist_cm' && b.date === M; }),
      dM: daily.filter(function (x) { return x.date === M; })[0] || null,
      dP: daily.filter(function (x) { return x.date === P; })[0] || null };
  }
  function renderMorningForm(root) {
    var c = card('Morning log', 'morning-form');
    if (!HM) { c.appendChild(h('p', { class: 'hint', text: 'The morning log did not load. Use Check-in, Weight & waist or Quick log instead.' })); root.appendChild(c); return; }
    var td = today(), unit = wUnit();
    c.appendChild(h('p', { class: 'hint', text: 'Optional. Fill in only what you have; a blank field changes nothing.' }));
    var seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Which morning' });
    [['TODAY', 'Today'], ['YESTERDAY', 'Yesterday'], ['CHOOSE', 'Other date']].forEach(function (m) {
      var on = morn.mode === m[0];
      seg.appendChild(h('button', { type: 'button', class: 'seg' + (on ? ' active' : ''), 'aria-pressed': on ? 'true' : 'false', text: m[1], testid: 'mlog-' + m[0].toLowerCase(),
        onclick: function () { morn.mode = m[0]; morn.msg = null; if (m[0] === 'CHOOSE' && !morn.date) morn.date = td; renderAdd(); var b = document.querySelector('[data-testid="mlog-' + m[0].toLowerCase() + '"]'); if (b) b.focus(); } }));
    });
    c.appendChild(seg);
    if (morn.mode === 'CHOOSE') c.appendChild(field('Morning of', h('input', { type: 'date', value: morn.date || '', max: td, testid: 'mlog-date', onchange: function () { morn.date = this.value; morn.msg = null; renderAdd(); } })));
    var M = mornDate(td);
    var msg = h('p', { class: morn.bad ? 'form-error' : 'hint', testid: 'mlog-result', role: 'status', 'aria-live': 'polite', text: morn.msg || '' });
    if (!HM.isIsoDate(M) || M > td) {
      c.appendChild(h('p', { class: 'form-error', testid: 'mlog-date-error', text: !HM.isIsoDate(M) ? 'Choose a valid date.' : 'That date is in the future (Asia/Qatar calendar). Nothing can be logged for it.' }));
      c.appendChild(msg); root.appendChild(c); return;
    }
    var cur = mornRead(M), P = cur.P;
    var txt = function (a) { return h('input', Object.assign({ type: 'text', autocomplete: 'off', maxlength: '8' }, a)); };
    var shown = function (v) { return v === null || v === undefined ? '' : String(v); };

    // ---- that morning ----
    c.appendChild(h('h3', { class: 'list-heading', testid: 'mlog-morning-heading', text: 'Morning of ' + fmtDate(M) + (M === td ? ' (today)' : '') + ' — weight, waist, last night’s sleep, resting HR' }));
    var w1 = cur.weights.length === 1 ? cur.weights[0] : null;
    var wIn = txt({ inputmode: 'decimal', testid: 'mlog-weight', value: w1 ? shown(unit === 'lb' ? HM.kgToLb(w1.kg) : w1.kg) : '', placeholder: unit === 'lb' ? 'e.g. 215.4' : 'e.g. 97.6', disabled: cur.weights.length > 1 ? 'disabled' : null });
    var wa1 = cur.waists.length === 1 ? cur.waists[0] : null, waCur = wa1 && wa1.state === 'OBSERVED' && typeof wa1.value === 'number' ? wa1.value : null;
    var waBlocked = cur.waists.length > 1 || !!storedDamage(wa1);
    var waIn = txt({ inputmode: 'decimal', testid: 'mlog-waist', value: shown(waCur), placeholder: 'optional', disabled: waBlocked ? 'disabled' : null });
    c.appendChild(h('div', { class: 'row' },
      field('Weight (' + unit + ')', wIn, cur.weights.length > 1 ? cur.weights.length + ' weights are saved for this date. Manage them in Quick log; nothing is changed here.' : w1 ? 'Saved: ' + wText(w1.kg) + '.' : 'Not recorded.'),
      field('Waist (cm)', waIn, cur.waists.length > 1 ? cur.waists.length + ' waist entries are saved for this date. Manage them in History; nothing is changed here.' : storedDamage(wa1) ? 'The saved entry is not valid. Review it in History; nothing is changed here.' : waCur !== null ? 'Saved: ' + fmt(waCur) + ' cm.' : 'Not recorded.')));
    var dmgM = !!storedDamage(cur.dM), dmgP = !!storedDamage(cur.dP);
    var slCur = obsVal(cur.dM, 'sleepH'), rhCur = obsVal(cur.dM, 'rhr');
    var slIn = txt({ inputmode: 'decimal', testid: 'mlog-sleep', value: shown(slCur), placeholder: 'hours', disabled: dmgM ? 'disabled' : null });
    var rhIn = txt({ inputmode: 'numeric', testid: 'mlog-rhr', value: shown(rhCur), placeholder: 'bpm', disabled: dmgM ? 'disabled' : null });
    c.appendChild(h('div', { class: 'row' },
      field('Sleep (hours)', slIn, slCur !== null ? 'Saved: ' + fmt(slCur) + ' h.' : 'Not recorded.'),
      field('Resting HR (bpm)', rhIn, rhCur !== null ? 'Saved: ' + fmt(rhCur) + ' bpm.' : 'Not recorded.')));
    if (dmgM) c.appendChild(damagedNote('mlog-damaged-morning', M));

    // ---- the day before ----
    c.appendChild(h('h3', { class: 'list-heading', testid: 'mlog-prev-heading', text: 'The day before — ' + fmtDate(P) + ' — whole-day totals' }));
    var stCur = obsVal(cur.dP, 'steps'), im = HM.intensityRead(cur.dP);
    var stIn = txt({ inputmode: 'numeric', testid: 'mlog-steps', value: shown(stCur), placeholder: 'e.g. 8500', disabled: dmgP ? 'disabled' : null });
    var imIn = txt({ inputmode: 'numeric', testid: 'mlog-intensity', value: im.state === 'OBSERVED' ? String(im.value) : '', placeholder: 'e.g. 46', disabled: dmgP ? 'disabled' : null });
    c.appendChild(h('div', { class: 'row' },
      field('Steps', stIn, stCur !== null ? 'Saved: ' + n0(stCur) + '.' : 'Not recorded.'),
      field('Intensity min (Garmin)', imIn, im.state === 'OBSERVED' ? 'Saved: ' + n0(im.value) + '.' : im.state === 'INVALID' ? 'The saved value is not valid (treated as unknown). Type the correct total to replace it.' : 'Not recorded.')));
    c.appendChild(h('p', { class: 'hint', testid: 'mlog-intensity-hint', text: 'Intensity minutes: type the day’s total exactly as Garmin shows it. Garmin already counts vigorous minutes double (30 moderate + 8 vigorous shows as 46) — do not double it yourself.' }));
    if (dmgP) c.appendChild(damagedNote('mlog-damaged-prev', P));

    var err = h('p', { class: 'form-error', testid: 'mlog-error', 'aria-live': 'polite' });
    c.appendChild(err);
    var renderedFor = td;
    c.appendChild(h('button', { type: 'button', class: 'btn btn-primary', text: 'Save morning log', testid: 'mlog-save', onclick: function () {
      err.textContent = '';
      var now = today();
      if (now !== renderedFor && morn.mode !== 'CHOOSE') { morn.msg = 'The date changed at midnight (Asia/Qatar). Check the day and save again. Nothing was saved.'; morn.bad = true; renderAdd(); return; }
      var MM = mornDate(now);
      if (!HM.isIsoDate(MM) || MM > now) { err.textContent = 'Not saved: choose a date that is not in the future. Nothing was changed.'; return; }
      dropReadMemo();
      var f = mornRead(MM), problems = [], ops = [], same = [];
      var blank = function (el) { return el.disabled || String(el.value).trim() === ''; };
      // weight
      if (!blank(wIn)) {
        var wp = HM.weightParse(wIn.value, unit), fw = f.weights.length === 1 ? f.weights[0] : null;
        if (f.weights.length > 1) problems.push('Weight: ' + f.weights.length + ' weights are saved for ' + fmtDate(MM) + '; manage them in Quick log.');
        else if (!wp.ok) problems.push(wp.error);
        else if (fw && HM.sameWeight(wIn.value, unit, fw.kg)) same.push('weight');
        else ops.push({ label: 'weight ' + HM.weightText(wp.kg, unit), run: function () {
          var r = store.addWeight({ date: MM, kg: wp.kg });
          if (!r.ok) return { ok: false, why: errorsText(r.errors) };
          if (fw && !store.remove('weight', fw.id)) return { ok: true, warn: 'the earlier ' + HM.weightText(fw.kg, unit) + ' entry for that date could not be removed — both are saved; remove the old one in Quick log' };
          return { ok: true };
        } });
      }
      // waist
      if (!blank(waIn)) {
        var wv = numOrNull(String(waIn.value).replace(',', '.')), fa = f.waists.length === 1 ? f.waists[0] : null;
        var faCur = fa && fa.state === 'OBSERVED' && typeof fa.value === 'number' ? fa.value : null;
        if (f.waists.length > 1 || storedDamage(fa)) problems.push('Waist: the saved waist for ' + fmtDate(MM) + ' needs attention in History first.');
        else if (wv === null || isNaN(wv) || wv < 40 || wv > 250) problems.push('Waist must be a number from 40 to 250 cm.');
        else if (faCur === wv) same.push('waist');
        else ops.push({ label: 'waist ' + fmt(wv) + ' cm', run: function () {
          var rec = fa ? JSON.parse(JSON.stringify(fa)) : { metric: 'waist_cm', date: MM, source: 'manual' };
          rec.state = 'OBSERVED'; rec.value = wv;
          var r = store.putRecord('body', rec); return r.ok ? { ok: true } : { ok: false, why: errorsText(r.errors) };
        } });
      }
      // that morning's check-in: sleep + resting HR (one write, every other value kept)
      var setM = {};
      if (!blank(slIn)) {
        var sv = numOrNull(String(slIn.value).replace(',', '.'));
        if (sv === null || isNaN(sv) || sv < 0 || sv > 24) problems.push('Sleep must be a number of hours from 0 to 24.');
        else if (obsVal(f.dM, 'sleepH') === sv) same.push('sleep'); else setM.sleepH = sv;
      }
      if (!blank(rhIn)) {
        var rv = numOrNull(rhIn.value);
        if (rv === null || isNaN(rv) || !Number.isInteger(rv) || rv < 25 || rv > 220) problems.push('Resting HR must be a whole number from 25 to 220 bpm.');
        else if (obsVal(f.dM, 'rhr') === rv) same.push('resting HR'); else setM.rhr = rv;
      }
      if (Object.keys(setM).length) {
        if (storedDamage(f.dM)) problems.push('The saved check-in for ' + fmtDate(MM) + ' has a value that is not valid. Open the full check-in to approve a correction.');
        else ops.push({ label: Object.keys(setM).map(function (k) { return k === 'sleepH' ? 'sleep ' + fmt(setM[k]) + ' h' : 'resting HR ' + setM[k] + ' bpm'; }).join(', ') + ' (' + fmtDate(MM) + ')', run: function () {
          var rec = f.dM ? JSON.parse(JSON.stringify(f.dM)) : { id: 'daily-' + MM, date: MM };
          Object.keys(setM).forEach(function (k) { rec[k] = { state: 'OBSERVED', value: setM[k] }; });
          var r = store.putRecord('daily', rec); return r.ok ? { ok: true } : { ok: false, why: errorsText(r.errors) };
        } });
      }
      // the day before's check-in: steps + intensity minutes (one write, every other value kept)
      var recP = f.dP, labP = [], changedP = false;
      if (!blank(stIn)) {
        var sr = AI.quickStepsUpdate(recP, f.P, stIn.value, now);
        if (!sr.ok) problems.push(sr.error);
        else if (sr.previous !== null && !sr.changed) same.push('steps');
        else { recP = sr.rec; changedP = true; labP.push('steps ' + n0(sr.rec.steps.value)); }
      }
      if (!blank(imIn)) {
        var ip = HM.intensityParse(imIn.value), ir = ip.ok ? HM.intensityUpdate(recP, f.P, ip.value, now) : ip;
        if (!ir.ok) problems.push(ir.error);
        else if (!ir.changed) same.push('intensity minutes');
        else { recP = ir.rec; changedP = true; labP.push('intensity minutes ' + n0(ip.value)); }
      }
      if (changedP) {
        if (storedDamage(f.dP)) problems.push('The saved check-in for ' + fmtDate(f.P) + ' has a value that is not valid. Open the full check-in to approve a correction.');
        else ops.push({ label: labP.join(', ') + ' (' + fmtDate(f.P) + ')', run: function () { var r = store.putRecord('daily', recP); return r.ok ? { ok: true } : { ok: false, why: errorsText(r.errors) }; } });
      }
      if (problems.length) { err.textContent = 'Not saved: ' + problems.join(' ') + ' Nothing was changed.'; toast('Not saved. Nothing was changed.', true); return; }
      if (!ops.length) { err.textContent = same.length ? 'Nothing to save: ' + same.join(', ') + ' already saved with ' + (same.length === 1 ? 'that value' : 'those values') + '. Nothing was changed.' : 'Nothing to save: every field is blank. Nothing was changed.'; return; }
      var done = [], warn = [], failed = null;
      for (var i = 0; i < ops.length && !failed; i++) {
        var r; dropReadMemo();
        try { r = ops[i].run(); } catch (e) { r = { ok: false, why: 'Unexpected error.' }; }
        if (r.ok) { done.push(ops[i].label); if (r.warn) warn.push(r.warn); } else failed = { label: ops[i].label, why: r.why, rest: ops.slice(i + 1).map(function (o) { return o.label; }) };
      }
      dropReadMemo();
      morn.bad = !!failed || warn.length > 0;
      morn.msg = (done.length ? 'Saved on this device: ' + done.join('; ') + '.' : '') + (warn.length ? ' Note: ' + warn.join('; ') + '.' : '') +
        (failed ? (done.length ? ' ' : '') + 'NOT saved: ' + failed.label + ' — ' + failed.why + (failed.rest.length ? ' Also not saved: ' + failed.rest.join('; ') + '.' : '') : '') +
        (!failed && same.length ? ' Unchanged: ' + same.join(', ') + '.' : '');
      toast(failed ? 'Part of the morning log was not saved — see the message.' : 'Saved on this device (verified by read-back).', !!failed);
      refresh(); extSaved(); try { window.dispatchEvent(new CustomEvent('hyrox:weight-unit')); } catch (e) { /* older browsers */ }
      renderAdd();
      var res = document.querySelector('[data-testid="mlog-result"]'); if (res) { try { res.scrollIntoView({ block: 'nearest' }); } catch (e) { /* */ } }
    } }));
    c.appendChild(msg);
    c.appendChild(h('p', { class: 'hint', text: 'Blank never means 0 and never deletes. To remove a value, use Check-in, History or Quick log.' }));
    root.appendChild(c);
    morn.msg = null; morn.bad = false;
  }
  function damagedNote(testid, date) {
    return h('div', { class: 'note note-warn', testid: testid }, h('p', { text: 'The saved check-in for ' + fmtDate(date) + ' has a value that is not valid, so it cannot be changed here. Open the full check-in to review and approve a correction. Nothing was changed.' }),
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Open the check-in', testid: testid + '-open', onclick: function () { dailyDatePreset = date; go('add', 'daily'); } }));
  }

  var DAILY = [['steps', 'Steps (daily total)', '0', '1'], ['sleepH', 'Sleep (hours)', '0', '0.1'], ['sleepQuality', 'Sleep quality (1–10)', '1', '1'],
    ['soreness', 'Soreness (0–10)', '0', '1'], ['pain', 'Pain: foot/knee/heel (0–10)', '0', '1'], ['readiness', 'Readiness (1–10)', '1', '1'], ['rhr', 'Resting HR (bpm, manual)', '25', '1'],
    ['footPain', 'First-step heel/arch/Achilles pain (0–10)', '0', '1'], ['stairKneePain', 'Stair knee pain (0–10)', '0', '1']];
  var dailyDatePreset = null;
  function renderDailyForm(root) {
    var c = card('Daily check-in', 'daily-form');
    var err = h('p', { class: 'form-error', testid: 'daily-error' });
    var date = h('input', { type: 'date', value: dailyDatePreset && dailyDatePreset <= today() ? dailyDatePreset : today(), max: today(), testid: 'daily-date' });
    dailyDatePreset = null;
    c.appendChild(field('Date', date));
    var body = h('div');
    c.appendChild(body);
    var inputs = {}, limpSel = null, approve = null;
    function fill() {
      body.replaceChildren(); approve = null;
      var ex = recs('daily').filter(function (d) { return d.date === date.value; })[0] || {};
      var dmg = storedDamage(ex);
      if (dmg) {
        // The stored record for this date has a bad value. Saving replaces it, so that needs the owner's say-so.
        approve = h('input', { type: 'checkbox', testid: 'daily-approve-correction' });
        body.appendChild(h('div', { class: 'note note-warn', testid: 'daily-damaged', role: 'status' },
          h('p', {}, h('strong', { text: 'The saved check-in for this date has a value that is not valid: ' }), problemsText(dmg.problems) + '.'),
          h('p', { text: 'That field is shown empty below and counts as unknown. Enter the correct value, or leave it empty. Your other values are unchanged. The saved record is only replaced when you tick the box and save; for an untouched copy first, use Settings → Download emergency raw copy.' }),
          h('label', { class: 'check' }, approve, h('span', { text: 'Replace the saved check-in for this date with what is shown below' }))));
      }
      DAILY.forEach(function (f) {
        var o = ex[f[0]] || { state: 'MISSING', value: null };
        var inp = numIn(o.value, { min: f[2], step: f[3], testid: 'daily-' + f[0] });
        var stOpts = [['OBSERVED', 'Recorded'], ['MISSING', 'Missing'], ['DECLINED', 'Declined'], ['NOT_TRACKED', 'Not tracked']];
        if (o.state === 'INVALID') stOpts.push(['INVALID', 'Invalid (unknown)']);
        var st = select(stOpts, o.state, { testid: 'daily-' + f[0] + '-state', 'aria-label': f[1] + ' status' });
        inp.addEventListener('input', function () { st.value = inp.value.trim() === '' ? (st.value === 'OBSERVED' ? 'MISSING' : st.value) : 'OBSERVED'; });
        inputs[f[0]] = [inp, st];
        body.appendChild(h('div', { class: 'row' }, field(f[1], inp), field('Status', st)));
      });
      var lx = ex.limp && ex.limp.state === 'OBSERVED' ? (ex.limp.value ? 'yes' : 'no') : ex.limp && ex.limp.state === 'INVALID' ? 'invalid' : '';
      limpSel = select([['', 'Not recorded'], ['no', 'No limp'], ['yes', 'Limping']].concat(lx === 'invalid' ? [['invalid', 'Invalid (unknown)']] : []), lx, { testid: 'daily-limp' });
      body.appendChild(field('Limp this morning (10,000-step readiness check)', limpSel));
      body.appendChild(h('p', { class: 'hint', testid: 'daily-steps-help', text: 'Steps (daily total) = your whole day\'s steps from your phone or watch. When it is recorded it is used as the day total, and walk or running-workout steps are never added on top. Blank = missing, not zero.' }));
    }
    date.addEventListener('change', fill); fill();
    c.appendChild(err);
    c.appendChild(h('button', { type: 'button', class: 'btn btn-primary', text: 'Save check-in', testid: 'daily-submit', onclick: function () {
      var ex = recs('daily').filter(function (d) { return d.date === date.value; })[0];
      var rec = ex ? JSON.parse(JSON.stringify(ex)) : { id: 'daily-' + date.value, date: date.value };
      var bad = false;
      DAILY.forEach(function (f) {
        var v = numOrNull(inputs[f[0]][0].value), s = inputs[f[0]][1].value;
        if (s === 'OBSERVED' && (v === null || isNaN(v))) bad = true;
        var prev = ex && ex[f[0]];
        if (prev && prev.state === s && ((s === 'OBSERVED' && prev.value === v) || (s !== 'OBSERVED' && (prev.value == null || prev.value === v)))) {
          rec[f[0]] = JSON.parse(JSON.stringify(prev));
        } else {
          rec[f[0]] = { state: s, value: s === 'OBSERVED' ? v : null };
        }
      });
      if (bad) { err.textContent = 'Not saved: a "Recorded" field needs a number.'; return; }
      if (limpSel && limpSel.value === 'invalid') rec.limp = { state: 'INVALID', value: null };
      else if (limpSel && limpSel.value) rec.limp = { state: 'OBSERVED', value: limpSel.value === 'yes' };
      else if (rec.limp) rec.limp = { state: 'MISSING', value: null };
      if (storedDamage(ex)) {
        if (!approve || !approve.checked) { err.textContent = 'Not saved: the saved check-in for this date has an invalid value. Tick "Replace the saved check-in…" above to approve the correction. Nothing was changed.'; return; }
        var res = persist('daily', rec, err, { approveCorrection: true });
        if (res.ok) fill();
        return;
      }
      persist('daily', rec, err);
    } }));
    root.appendChild(c);
  }

  function renderWalkForm(root) {
    var c = card('Walk session', 'walk-form');
    var err = h('p', { class: 'form-error', testid: 'walk-error' });
    var date = h('input', { type: 'date', value: today(), max: today(), testid: 'walk-date' });
    var dur = numIn(null, { testid: 'walk-duration', step: '1' }), dist = numIn(null, { testid: 'walk-distance' }), steps = numIn(null, { testid: 'walk-steps', step: '1' }), eff = numIn(null, { testid: 'walk-effort', min: '1', max: '10' });
    var notes = h('input', { type: 'text', maxlength: '300', testid: 'walk-notes' });
    steps.setAttribute('inputmode', 'numeric'); steps.setAttribute('placeholder', 'not recorded');
    var stepsSrc = select(STEP_SOURCES.map(function (o) { return o[0] ? o : ['', 'Source (optional)']; }), '', { testid: 'walk-steps-source', 'aria-label': 'Source of the walk steps' });
    c.appendChild(h('div', { class: 'row' }, field('Date', date), field('Duration (min)', dur)));
    c.appendChild(h('div', { class: 'row' }, field('Distance (km, optional)', dist), field('Steps on this walk (optional)', steps)));
    c.appendChild(field('Where the step number came from', stepsSrc));
    c.appendChild(h('p', { class: 'hint', testid: 'walk-steps-help', text: 'Only steps counted by your watch/phone or by you; never estimated from distance or time. Blank = not recorded. Without a daily total, walk + running steps give only a partial lower bound for the day.' }));
    c.appendChild(h('div', { class: 'row' }, field('Effort (1–10, optional)', eff), field('Notes', notes)));
    c.appendChild(err);
    c.appendChild(h('button', { type: 'button', class: 'btn btn-primary', text: 'Save walk', testid: 'walk-submit', onclick: function () {
      var sv = numOrNull(steps.value);
      if (sv !== null && (isNaN(sv) || !Number.isInteger(sv) || sv < 0)) { err.textContent = 'Not saved: steps must be a whole number (or blank = not recorded).'; return; }
      if (sv === null && stepsSrc.value) { err.textContent = 'Not saved: a step source needs a step number (or clear the source).'; return; }
      var wrec = { date: date.value, durationMin: numOrNull(dur.value), distanceKm: numOrNull(dist.value), steps: sv, effort: numOrNull(eff.value), notes: notes.value };
      if (stepsSrc.value) wrec.stepsSource = stepsSrc.value;
      var res = persist('walks', wrec, err);
      if (res.ok) { dur.value = ''; dist.value = ''; steps.value = ''; stepsSrc.value = ''; eff.value = ''; notes.value = ''; }
    } }));
    root.appendChild(c);
  }

  function renderAdd() {
    var root = $('add-root'); root.replaceChildren(); mealTotalsHook = null;
    syncLogger();
    if (addMode === 'workout') renderWorkoutForm(root);
    else if (addMode === 'meal') renderMealForm(root);
    else if (addMode === 'body') renderBodyForm(root);
    else if (addMode === 'daily') renderDailyForm(root);
    else if (addMode === 'morning') renderMorningForm(root);
    else if (addMode === 'walk') renderWalkForm(root);
    else if (addMode === 'classic') root.appendChild(h('p', { class: 'hint', text: 'Quick log keeps the original Phase 1/2 forms. Classic kcal/protein entries count as confirmed with carbs/fat unknown.' }));
  }

  // ================= HISTORY =================
  var histFilter = 'all';
  function attestationFor(date) { return recs('dayStates').filter(function (d) { return d.date === date; })[0] || null; }
  function dayStateFor(date) { return HN.dayState(date, allMeals(), attestationFor(date)); }
  // Owner rule 3: asked every time a day has no food recorded. Nothing is inferred from silence.
  function fastQuestion(date, st, att, testid) {
    var can = HN.canConfirmFast(st);
    return h('div', { class: 'note note-warn', testid: testid || 'fast-question' },
      h('p', { text: 'No food is recorded for ' + fmtDate(date) + '. Was it an intentional full-day fast, or was food not logged? Until you answer, calories for that day stay unknown (not 0) and the day is left out of averages.' }),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-small btn-secondary', text: 'Intentional full-day fast (record 0 kcal)', testid: 'fast-confirm', disabled: !can.ok, onclick: function () { answerFast(date, 'CONFIRMED_FULL_DAY_FAST', st, att); } }),
        h('button', { type: 'button', class: 'btn btn-small btn-secondary', text: 'Food not logged (calories unknown)', testid: 'fast-not-logged', onclick: function () { answerFast(date, 'NOT_LOGGED', st, att); } })),
      can.ok ? null : h('p', { class: 'hint', text: can.reason }));
  }
  function answerFast(date, answer, st, existing) {
    var rec = existing ? JSON.parse(JSON.stringify(existing)) : { date: date };
    rec.attestation = answer === 'CONFIRMED_FULL_DAY_FAST' ? 'COMPLETE' : 'INCOMPLETE';
    rec.fast = answer; rec.basis = st.basis; rec.attestedAt = new Date().toISOString();
    persist('dayStates', rec);
  }
  // The last 7 finished days (since first use) with no food recorded and no answer yet.
  function openFastDays() {
    var out = [], first = firstUseDate(), t = today();
    if (first === null) return out;
    for (var i = 1; i <= 7; i++) { var d = HP.addDays(t, -i); if (d < first) break; if (dayStateFor(d).fastQuestionOpen) out.push(d); }
    return out;
  }
  var MACRO_LABEL = { kcal: ['Calories', ' kcal'], proteinG: ['Protein', ' g'], carbsG: ['Carbs', ' g'], fatG: ['Fat', ' g'] };
  function subtotalLine(ds, testid) {
    return h('div', { class: 'subtotal', testid: testid }, HN.MACROS.map(function (k) {
      var s = ds.subtotal[k], m = MACRO_LABEL[k];
      return h('span', { class: 'pill macro-pill' }, h('span', { class: 'macro-l', text: m[0] }), ' ',
        h('span', { class: 'macro-v', text: (s.value === null ? 'unknown' : fmt(s.value) + m[1]) + (s.mealsWithUnknown && s.value !== null ? ' + unknown' : '') }));
    }));
  }
  function renderHistory() {
    var root = $('history-root'); root.replaceChildren();
    root.appendChild(h('div', { class: 'segmented' }, [['all', 'All'], ['workouts', 'Workouts'], ['meals', 'Meals'], ['body', 'Body & check-ins'], ['walks', 'Walks']].map(function (f) {
      return h('button', { type: 'button', class: 'seg' + (histFilter === f[0] ? ' active' : ''), text: f[1], testid: 'history-filter-' + f[0], onclick: function () { histFilter = f[0]; renderHistory(); } });
    })));
    if (histFilter === 'all' || histFilter === 'workouts') root.appendChild(historySessions());
    if (histFilter === 'all' || histFilter === 'meals') root.appendChild(historyMeals());
    if (histFilter === 'all' || histFilter === 'body') root.appendChild(historyBody());
    if (histFilter === 'all' || histFilter === 'walks') root.appendChild(historyWalks());
  }
  function delBtn(type, rec, desc, testid) {
    return h('button', { type: 'button', class: 'btn btn-small btn-delete', text: 'Delete', testid: testid, 'aria-label': 'Delete ' + desc, onclick: function () {
      var dmg = storedDamage(rec);
      if (!window.confirm('Delete ' + desc + '?' + (dmg ? '\n\nThis saved record has a value that is not valid (' + problemsText(dmg.problems) + '). Deleting removes the whole record, valid values included. For an untouched copy first, use Settings → Download emergency raw copy.' : ''))) return;
      var ok; try { ok = store.removeRecord(type, rec.id, dmg ? { approveDamaged: true } : undefined); } catch (e) { ok = false; }
      dropReadMemo();
      var refuse = (!ok && store.lastRemoveResult) ? store.lastRemoveResult() : null;
      toast(ok ? 'Deleted (verified).' : ((refuse && refuse.message) || 'Could not delete — nothing changed.'), !ok); refresh(); extSaved();
    } });
  }
  function historySessions() {
    var c = card('Workout log', 'history-sessions');
    var list = recs('sessions');
    if (!list.length) c.appendChild(h('p', { class: 'muted', text: 'No detailed workouts yet. Classic quick workouts are listed under Add → Quick log.' }));
    list.forEach(function (s) {
      var slot = s.planSlotId ? PL.slotById(s.planSlotId) : null;
      var comps = s.blocks.map(HP.machineCompliance).filter(Boolean);
      var over = comps.filter(function (x) { return x === 'OVERRUN'; }).length, unv = comps.filter(function (x) { return x === 'UNVERIFIED'; }).length;
      c.appendChild(h('div', { class: 'entry', testid: 'history-session' }, h('div', { class: 'entry-body' },
        h('div', { class: 'entry-title', text: s.title || 'Workout' }),
        h('div', { class: 'badge-line' }, statusBadge({ code: s.status }), s.modified ? badge('Modified', 'warn') : null, s.variant !== 'ORIGINAL_60' ? badge(s.variant, 'info') : null, s.intensity ? badge(INTENSITY_LABEL[s.intensity] || s.intensity, 'info', 'history-session-intensity') : null,
          HP.isPreBlockSession(s) ? badge('Before Week 1 — not counted in the plan', 'muted', 'history-preblock') : null,
          slot && s.date !== slot.date && isWeekend(s.date) && HP.isActualWork && HP.isActualWork(s) ? badge('Weekend actual work — not a source reschedule', 'warn', 'history-weekend-actual') : null),
        h('div', { class: 'entry-meta', testid: 'history-session-variant', text: 'Prescribed: ' + (VARIANT_LABEL[s.variant] || s.variant) + ' · Actual duration: ' + (s.durationMin != null ? s.durationMin + ' min' : 'not recorded') + ' · Actual completion: ' + String(s.status).replace('_', ' ') }),
        h('div', { class: 'entry-meta', text: 'Performed ' + fmtDate(s.date) + (slot ? (HP.isPreBlockSession(s) ? ' · linked to ' + slot.id + ' under the earlier calendar (not counted in Weeks 1–4)' : ' · planned ' + slot.id + ' (' + fmtDate(slot.date) + ')') : ' · unplanned') + (s.durationMin != null ? ' · ' + s.durationMin + ' min' : '') + (s.rpe != null ? ' · RPE ' + s.rpe : '') }),
        runStepsMeta(s),
        h('div', { class: 'entry-meta', text: s.blocks.length + ' blocks' + (s.blocks.filter(function (b) { return b.omitted; }).length ? ' · ' + s.blocks.filter(function (b) { return b.omitted; }).length + ' omitted' : '') + (comps.length ? ' · machine bouts: ' + over + ' overrun, ' + unv + ' unverified' : '') }),
        s.notes ? h('div', { class: 'entry-meta', text: s.notes }) : null),
        h('div', { class: 'btn-col' }, h('button', { type: 'button', class: 'btn btn-small btn-secondary', text: 'Edit', testid: 'history-session-edit', onclick: function () { editSession(s); } }),
          delBtn('sessions', s, 'workout ' + (s.title || '') + ' on ' + s.date, 'history-session-delete'))));
    });
    return c;
  }
  function runStepsMeta(s) {
    var SRC = { DEVICE: 'watch/phone', MANUAL: 'counted by you' };
    if (typeof s.runSteps === 'number') return h('div', { class: 'entry-meta', testid: 'history-session-run-steps', text: 'Running steps: ' + n0(s.runSteps) + ' (' + (SRC[s.runStepsSource] || 'source not stated') + ')' });
    if (s.blocks.some(function (b) { return b && b.kind === 'run'; })) return h('div', { class: 'entry-meta', testid: 'history-session-run-steps', text: 'Running steps: not recorded' });
    return null;
  }
  function historyMeals() {
    var c = card('Meals by day', 'history-meals');
    var meals = allMeals();
    var dates = {}; meals.forEach(function (m) { dates[m.date] = true; });
    recs('dayStates').forEach(function (d) { dates[d.date] = true; });
    openFastDays().forEach(function (d) { dates[d] = true; });
    var ds = Object.keys(dates).sort().reverse();
    if (!ds.length) c.appendChild(h('p', { class: 'muted', text: 'No meals yet.' }));
    ds.forEach(function (date) {
      var st = dayStateFor(date);
      var att = recs('dayStates').filter(function (d) { return d.date === date; })[0];
      var day = h('div', { class: 'day-group', testid: 'history-day' });
      day.appendChild(h('h3', { class: 'list-heading' }, fmtDate(date) + ' ', badge(st.label, st.code === 'D5' || st.code === 'DF' ? 'ok' : 'info', 'history-day-state')));
      day.appendChild(h('p', { class: 'hint', testid: 'history-day-kcal', text: 'Full-day calories: ' + (st.dayKcal === null ? 'unknown (not counted as 0, not in averages)' : fmt(st.dayKcal) + ' kcal' + (st.fastDay ? ' — confirmed fast, tracked separately' : '')) }));
      if (st.fastAnswer === 'NOT_LOGGED') day.appendChild(h('p', { class: 'hint', testid: 'history-day-not-logged', text: 'You said food was not logged for this day.' }));
      if (st.fastQuestionOpen) day.appendChild(fastQuestion(date, st, att));
      day.appendChild(subtotalLine(st, 'history-day-subtotal'));
      day.appendChild(h('p', { class: 'hint', text: st.caveat }));
      if (st.staleAttestation) day.appendChild(h('p', { class: 'note note-warn', testid: 'history-day-stale', text: 'Your day declaration is out of date because a meal changed. Declare again.' }));
      // P1.3 Delivery A: the same shared closeout component as Home (date-specific; History keeps the Clear action).
      day.appendChild(closeoutControls(date, st, att, { home: false }));
      meals.filter(function (m) { return m.date === date; }).forEach(function (m) { day.appendChild(mealRow(m)); });
      c.appendChild(day);
    });
    return c;
  }
  // ---- P1.3 Delivery A: one shared day-closeout component (Home for the displayed Qatar date; History per date) ----
  // Reuses canAttest / waterOnly / attest() unchanged. Every press re-reads the stored day first and refuses (writing
  // nothing) when the Qatar date changed since the screen was drawn, when the day's meals changed since then, when the
  // same declaration is already current, or when the existing eligibility rules say no. Never automatic.
  var closeoutMsg = null; // { date, text, bad } shown once under the controls of that date
  function closeoutStateText(st, att) {
    if (st.fastDay) return 'Declared: intentional full-day fast (0 kcal).';
    if (att && st.staleAttestation) return 'Your declaration is out of date because a meal changed. Declare again.';
    if (att && att.fast === 'NOT_LOGGED') return 'Declared: food not logged (calories unknown).';
    if (att && att.attestation === 'COMPLETE') return 'Declared: all food & drink entered — ' + st.label + '.';
    if (att && att.attestation === 'INCOMPLETE') return 'Declared: day is incomplete — not a full day, not in averages.';
    return 'Not declared yet — ' + st.label + '. Nothing is declared automatically.';
  }
  function closeoutPress(date, kind, shownBasis, opts) {
    var now = today();
    function say(text, bad) { closeoutMsg = { date: date, text: text, bad: !!bad }; if (bad) toast(text, true); if (opts.home) renderToday(); else renderHistory(); }
    if (opts.home && now !== opts.renderedFor) { closeoutMsg = null; toast('The date changed at midnight (Asia/Qatar). Home now shows ' + fmtDate(now) + '. Nothing was saved.', true); refresh(); return; }
    if (date > now) { say('That date is in the future. Nothing was saved.', true); return; }
    dropReadMemo();
    var st = dayStateFor(date), att = attestationFor(date);
    if (storedDamage(att)) { say('The saved declaration for ' + fmtDate(date) + ' is not valid as stored. Review it in History. Nothing was saved.', true); return; }
    if (st.basis !== shownBasis) { say('The meals for ' + fmtDate(date) + ' changed since this screen was drawn. Check the day and press again. Nothing was saved.', true); return; }
    var can = HN.canAttest(st);
    if (kind === 'COMPLETE' && !can.ok) { say(can.reason + ' Nothing was saved.', true); return; }
    // A day with no food recorded is never declared complete without the fasting answer.
    if (kind === 'COMPLETE' && st.waterOnly) { say('No food is recorded for this day, so it cannot simply be declared complete. Answer the fasting question for it (delete the current declaration first to answer again).', true); return; }
    var wantFast = kind === 'INCOMPLETE' && st.waterOnly ? 'NOT_LOGGED' : null;
    if (att && !st.staleAttestation && att.attestation === kind && (att.fast || null) === wantFast) { say('Already declared for ' + fmtDate(date) + '. Nothing changed.', false); return; }
    var res = attest(date, kind, st, att);
    if (res && res.ok) say((kind === 'COMPLETE' ? 'Saved: all food & drink entered for ' : 'Saved: ' + fmtDate(date) + ' is incomplete') + (kind === 'COMPLETE' ? fmtDate(date) : '') + '.', false);
    else { closeoutMsg = { date: date, text: 'Not saved — nothing was changed. ' + (res && res.errors ? errorsText(res.errors) : ''), bad: true }; if (opts.home) renderToday(); else renderHistory(); }
  }
  function closeoutControls(date, st, att, opts) {
    opts = opts || {};
    var home = !!opts.home, pre = home ? 'today-' : '', can = HN.canAttest(st), td = today();
    var dayTxt = fmtDate(date) + (date === td ? ' (today)' : '');
    var curKind = att && !st.staleAttestation ? att.attestation : null;
    var wrap = h('div', { class: 'closeout' + (home ? ' closeout-home' : ''), testid: home ? 'today-closeout' : 'history-closeout', role: 'group', 'aria-label': 'Day closeout for ' + dayTxt, 'data-date': date });
    if (home) wrap.appendChild(h('p', { class: 'closeout-head', testid: 'today-closeout-date' }, h('strong', { text: 'Day closeout · ' + dayTxt })));
    if (home) wrap.appendChild(h('p', { class: 'hint', testid: 'today-closeout-state', text: closeoutStateText(st, att) }));
    if (home && st.draftCount) wrap.appendChild(h('p', { class: 'hint', testid: 'today-closeout-drafts', text: st.draftCount + (st.draftCount === 1 ? ' draft is' : ' drafts are') + ' listed but not counted until confirmed.' }));
    var shown = st.basis, ro = { home: home, renderedFor: td };
    wrap.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn btn-small btn-secondary', text: 'All food & drink entered', testid: pre + 'attest-complete', disabled: !can.ok,
        'aria-label': 'All food & drink entered for ' + dayTxt, 'aria-pressed': home ? (curKind === 'COMPLETE' && !st.fastDay ? 'true' : 'false') : null,
        onclick: function () { closeoutPress(date, 'COMPLETE', shown, ro); } }),
      h('button', { type: 'button', class: 'btn btn-small btn-secondary', text: 'Day is incomplete', testid: pre + 'attest-incomplete',
        'aria-label': 'Day is incomplete: ' + dayTxt, 'aria-pressed': home ? (curKind === 'INCOMPLETE' ? 'true' : 'false') : null,
        onclick: function () { closeoutPress(date, 'INCOMPLETE', shown, ro); } }),
      !home && att ? delBtn('dayStates', att, 'day declaration for ' + date, 'attest-clear') : null));
    if (!can.ok) wrap.appendChild(h('p', { class: 'hint', testid: pre + 'attest-blocked', text: can.reason }));
    if (closeoutMsg && closeoutMsg.date === date && (home ? currentTab === 'today' : currentTab === 'history'))
      wrap.appendChild(h('p', { class: closeoutMsg.bad ? 'form-error' : 'hint closeout-ok', testid: pre + 'closeout-msg', role: 'status', 'aria-live': 'polite', text: closeoutMsg.text }));
    if (home) wrap.appendChild(h('p', { class: 'hint', testid: 'today-closeout-note', text: 'Applies to ' + fmtDate(date) + ' only. A later change to this day’s meals makes the declaration out of date. Earlier days: History.' }));
    return wrap;
  }
  function attest(date, kind, st, existing) {
    var rec = existing ? JSON.parse(JSON.stringify(existing)) : { date: date };
    rec.attestation = kind; rec.basis = st.basis; rec.attestedAt = new Date().toISOString();
    // "Day is incomplete" on a day with no food recorded is the "food not logged" answer.
    rec.fast = kind === 'INCOMPLETE' && st.waterOnly ? 'NOT_LOGGED' : null;
    return persist('dayStates', rec);
  }
  function mealRow(m) {
    var t = HN.mealTotals(m);
    var lc = { DRAFT: ['Draft — not counted', 'muted'], NEEDS_REVIEW: ['Needs review — not counted', 'warn'], CONSUMED_INTENT: ['I ate this — unconfirmed, not counted', 'warn'], CONFIRMED: ['Confirmed', 'ok'] }[m.lifecycle];
    var comp = HN.completeness(m);
    return h('div', { class: 'entry', testid: 'history-meal' }, h('div', { class: 'entry-body' },
      h('div', { class: 'entry-title' }, h('span', { text: mealTitle(m) + (m.time ? ' · ' + m.time : '') }), badge(lc[0], lc[1], 'meal-lifecycle'),
        m.legacy ? badge('Classic entry', 'muted') : badge(m.source, 'info'), catBadge(m), m.ai ? aiBadge(m.ai) : null, comp === 'CONFIRMED_INCOMPLETE' ? badge('Incomplete macros', 'muted') : null),
      h('div', { class: 'entry-meta', text: HN.MACROS.map(function (k) { return label(k) + ' ' + (t[k].value === null ? '?' : fmt(t[k].value)) + (t[k].state === 'PARTIAL' ? '+?' : '') + (t[k].state === 'ESTIMATED' ? '~' : ''); }).join(' · ') }),
      h('div', { class: 'entry-meta', text: m.components.map(function (x) { return x.name + (x.portion ? ' (' + x.portion + ')' : ''); }).join(', ') }),
      myFoodsOpenFor === m.id ? myFoodsPanel(m) : null),
      m.legacy ? null : h('div', { class: 'btn-col' },
        m.lifecycle !== 'CONFIRMED' ? h('button', { type: 'button', class: 'btn btn-small btn-primary', text: 'Review & confirm', testid: 'meal-review', onclick: function () { editMeal(m); } }) : h('button', { type: 'button', class: 'btn btn-small btn-secondary', text: 'Edit', testid: 'meal-edit', onclick: function () { editMeal(m); } }),
        h('button', { type: 'button', class: 'btn btn-small btn-secondary', text: 'Copy', testid: 'meal-copy', onclick: function () { copyMeal(m); } }),
        m.lifecycle === 'CONFIRMED' && FS && myFoodsOpenFor !== m.id ? h('button', { type: 'button', class: 'btn btn-small btn-secondary', text: 'Save to My foods', testid: 'meal-save-myfoods', onclick: function () { myFoodsOpenFor = m.id; renderHistory(); focusTestid('myfoods-pick-save'); } }) : null,
        delBtn('meals', m, 'meal ' + (m.label || '') + ' on ' + m.date, 'meal-delete')),
      m.legacy ? h('div', { class: 'btn-col' }, h('button', { type: 'button', class: 'btn btn-small btn-secondary', text: 'Copy', testid: 'meal-copy-legacy', onclick: function () { copyMeal(m); } })) : null);
  }
  function historyBody() {
    var c = card('Body & check-ins', 'history-body');
    recs('body').forEach(function (b) {
      c.appendChild(h('div', { class: 'entry', testid: 'history-waist' }, h('div', { class: 'entry-body' }, h('div', { class: 'entry-title', text: 'Waist ' + (b.state === 'OBSERVED' ? fmt(b.value) + ' cm' : b.state.toLowerCase().replace('_', ' ')) }),
        h('div', { class: 'entry-meta', text: 'Measured ' + fmtDate(b.date) + ' · entered ' + String(b.createdAt).slice(0, 16).replace('T', ' ') + ' UTC' })), delBtn('body', b, 'waist entry on ' + b.date, 'history-waist-delete')));
    });
    recs('daily').forEach(function (d) {
      c.appendChild(h('div', { class: 'entry', testid: 'history-daily' }, h('div', { class: 'entry-body' }, h('div', { class: 'entry-title', text: (function () {
          var api = ['steps', 'intensityMin', 'sleepH'].some(function (k) { return d[k] && d[k].source === 'GARMIN_PERSONAL_API'; });
          return api ? ('Garmin-derived observation ' + fmtDate(d.date)) : ('Check-in ' + fmtDate(d.date));
        })() }),
        h('div', { class: 'entry-meta', text: DAILY.map(function (f) { var o = d[f[0]]; var src = o && o.source === 'GARMIN_PERSONAL_API' ? ' (Garmin-derived)' : (o && o.source === 'GARMIN_MANUAL' ? ' (owner-typed)' : ''); return f[0] + ': ' + (o && o.state === 'OBSERVED' ? o.value : (o ? o.state.toLowerCase() : 'missing')) + src; }).join(' · ') }),
        storedDamage(d) ? h('p', { class: 'note note-warn', testid: 'history-daily-invalid', text: 'Saved value not valid — ' + problemsText(storedDamage(d).problems) + '. Treated as unknown; the other values are kept. Correct it under Add → Daily check-in for this date.' }) : null),
        delBtn('daily', d, 'check-in on ' + d.date, 'history-daily-delete')));
    });
    if (!recs('body').length && !recs('daily').length) c.appendChild(h('p', { class: 'muted', text: 'No waist or check-in entries yet. Weight history is under Add → Weight & waist.' }));
    return c;
  }
  // A saved walk with a value that is not valid (e.g. an older fractional step count). The owner
  // types the correct whole number, or leaves it empty for "not recorded"; nothing is rounded for them.
  function walkCorrection(w, dmg) {
    var inp = numIn(null, { step: '1', min: '0', testid: 'walk-fix-steps', placeholder: 'whole number, or empty', 'aria-label': 'Correct step count for the walk on ' + w.date });
    inp.setAttribute('inputmode', 'numeric');
    var err = h('p', { class: 'form-error', testid: 'walk-fix-error', 'aria-live': 'polite' });
    return h('div', { class: 'note note-warn', testid: 'history-walk-invalid' },
      h('p', { text: 'Saved value not valid — ' + problemsText(dmg.problems) + '. It is not counted and has not been rounded or changed.' }),
      h('div', { class: 'btn-row' }, inp,
        h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Save corrected steps', testid: 'walk-fix-save', onclick: function () {
          var v = numOrNull(inp.value);
          if (v !== null && (isNaN(v) || !Number.isInteger(v) || v < 0)) { err.textContent = 'Not saved: enter a whole number, or leave it empty for "not recorded".'; return; }
          if (!window.confirm('Replace the saved step count for this walk with ' + (v === null ? '"not recorded"' : v) + '?')) return;
          var rec = JSON.parse(JSON.stringify(w));
          rec.steps = v; if (v === null) rec.stepsSource = null;
          dmg.problems.forEach(function (p) { if (p.field !== 'steps') rec[p.field] = null; });
          persist('walks', rec, err, { approveCorrection: true });
        } })), err);
  }
  function historyWalks() {
    var c = card('Walks', 'history-walks');
    var l = recs('walks');
    if (!l.length) c.appendChild(h('p', { class: 'muted', text: 'No walks yet.' }));
    l.forEach(function (w) {
      var dmg = storedDamage(w);
      c.appendChild(h('div', { class: 'entry', testid: 'history-walk' }, h('div', { class: 'entry-body' }, h('div', { class: 'entry-title', text: 'Walk ' + w.durationMin + ' min' + (w.distanceKm != null ? ' · ' + w.distanceKm + ' km' : '') }),
        h('div', { class: 'entry-meta', text: fmtDate(w.date) + (w.steps != null ? ' · ' + w.steps + ' steps (info only — never added to a daily total' + (w.stepsSource ? '; ' + (w.stepsSource === 'DEVICE' ? 'watch/phone' : 'counted by you') : '') + ')' : dmg ? ' · steps not usable' : ' · steps not recorded') + (w.notes ? ' · ' + w.notes : '') }),
        dmg ? walkCorrection(w, dmg) : null), delBtn('walks', w, 'walk on ' + w.date, 'history-walk-delete')));
    });
    return c;
  }

  // ================= TRENDS =================
  function chart(points, unit, testid) {
    var W = 320, H = 120, P = 22;
    if (points.length < 2) return h('p', { class: 'muted', testid: testid, text: points.length ? 'Only 1 observation (' + fmt(points[0].value) + ' ' + unit + ' on ' + fmtDate(points[0].date) + ') — need 2+ for a trend.' : 'No observations yet — nothing is assumed.' });
    var vals = points.map(function (p) { return p.value; }), mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    if (mx === mn) { mx += 1; mn -= 1; }
    var t0 = Date.parse(points[0].date), t1 = Date.parse(points[points.length - 1].date) || t0 + 1; if (t1 === t0) t1 = t0 + 86400000;
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (H + 12)); svg.setAttribute('class', 'chart'); // C-05: +12 strip below the plot for the date labels svg.setAttribute('role', 'img');
    svg.setAttribute('data-testid', testid);
    var st = HW.stats(points);
    svg.setAttribute('aria-label', 'n=' + st.n + ', from ' + fmt(st.first.value) + ' to ' + fmt(st.last.value) + ' ' + unit);
    var pts = points.map(function (p) { var x = P + (Date.parse(p.date) - t0) / (t1 - t0) * (W - 2 * P); var y = H - P - (p.value - mn) / (mx - mn) * (H - 2 * P); return [x, y]; });
    var pl = document.createElementNS(NS, 'polyline'); pl.setAttribute('points', pts.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' ')); pl.setAttribute('class', 'chart-line'); svg.appendChild(pl);
    pts.forEach(function (q) { var c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', q[0]); c.setAttribute('cy', q[1]); c.setAttribute('r', 3); c.setAttribute('class', 'chart-dot'); svg.appendChild(c); });
    [[fmt(mx) + ' ' + unit, P - 8], [fmt(mn) + ' ' + unit, H - 6]].forEach(function (l) { var t = document.createElementNS(NS, 'text'); t.setAttribute('x', 2); t.setAttribute('y', l[1]); t.setAttribute('class', 'chart-label'); t.textContent = l[0]; svg.appendChild(t); });
    // P11.2 part 3: the real first / last observation dates on the time axis (no interpolated or smoothed points)
    [[fmtDate(points[0].date), P, 'start'], [fmtDate(points[points.length - 1].date), W - P, 'end']].forEach(function (l) { var t = document.createElementNS(NS, 'text'); t.setAttribute('x', l[1]); t.setAttribute('y', H + 9); t.setAttribute('text-anchor', l[2]); t.setAttribute('class', 'chart-label chart-date'); t.textContent = l[0]; svg.appendChild(t); });
    return h('div', {}, svg, h('p', { class: 'hint', text: 'n=' + st.n + ' · ' + fmtDate(st.first.date) + ' → ' + fmtDate(st.last.date) + ' · change ' + (st.change > 0 ? '+' : '') + fmt(st.change) + ' ' + unit }));
  }
  // ---- P11.2 part 3: Trends presentation. A time window and a short "latest" summary on top of the SAME computations
  // (HW.series/stats/weeklySteps, HP.summary, HN.dayAverages). Only recorded observations are drawn; missing stays missing.
  var trendWin = 'ALL';
  var TREND_WINS = [['4W', '4 weeks', 28], ['12W', '12 weeks', 84], ['ALL', 'All', null]];
  function winStart() { var w = TREND_WINS.filter(function (x) { return x[0] === trendWin; })[0]; return w && w[2] ? HP.addDays(today(), -(w[2] - 1)) : null; }
  function inWin(points) { var s0 = winStart(); return s0 ? points.filter(function (p) { return p.date >= s0 && p.date <= today(); }) : points; }
  function trendsSummary(weightPts, daily, sessions) {
    var c = card('Summary', 'trends-summary');
    var seg = h('div', { class: 'segmented trends-win', role: 'group', 'aria-label': 'Time window' });
    TREND_WINS.forEach(function (w) {
      seg.appendChild(h('button', { type: 'button', class: 'seg' + (trendWin === w[0] ? ' active' : ''), 'aria-pressed': trendWin === w[0] ? 'true' : 'false', text: w[1], testid: 'trends-win-' + w[0].toLowerCase(),
        onclick: function () { trendWin = w[0]; renderTrends(); var b = document.querySelector('[data-testid="trends-win-' + w[0].toLowerCase() + '"]'); if (b) b.focus(); } }));
    });
    c.appendChild(seg);
    var s0 = winStart();
    c.appendChild(h('p', { class: 'hint', testid: 'trends-window', text: s0 ? 'Showing ' + fmtDate(s0) + ' – ' + fmtDate(today()) + ' (Asia/Qatar dates).' : 'Showing all recorded dates.' }));
    var dl = h('dl', { class: 'trend-sum' });
    function item(key, label, text) { dl.appendChild(h('div', { class: 'trend-sum-row', testid: 'trends-sum-' + key }, h('dt', { text: label }), h('dd', { text: text }))); }
    var st = HW.stats(weightPts);
    item('weight', 'Weight', !st.n ? 'No weight recorded in this window' : wText(st.last.value) + ' on ' + fmtDate(st.last.date) +
      (st.n >= 2 ? ' · ' + (st.change > 0 ? '+' : '') + fmt(HM ? HM.weightDelta(st.change, wUnit()) : st.change) + ' ' + wUnit() + ' since ' + fmtDate(st.first.date) + ' (' + st.n + ' measurements)' : ' · only 1 measurement, no comparison'));
    var wk = HW.weeklySteps(today(), daily, null, 1)[0];
    item('steps', 'Steps (this week)', !wk || wk.mean === null ? 'No daily totals recorded this week' : 'Average ' + n0(wk.mean) + ' over ' + wk.daysRecorded + ' recorded day(s); ' + wk.daysMissing + ' missing (not 0)');
    var inS = sessions.filter(function (x) { return !s0 || (x.date >= s0 && x.date <= today()); });
    var cnt = { COMPLETED: 0, PARTIAL: 0, SKIPPED: 0 }; inS.forEach(function (x) { if (cnt[x.status] !== undefined) cnt[x.status]++; });
    item('workouts', 'Workouts logged', inS.length ? cnt.COMPLETED + ' completed · ' + cnt.PARTIAL + ' partial · ' + cnt.SKIPPED + ' skipped' : 'No sessions logged in this window');
    var dates = {}; allMeals().forEach(function (m) { if (!s0 || (m.date >= s0 && m.date <= today())) dates[m.date] = true; });
    recs('dayStates').forEach(function (d) { if (!s0 || (d.date >= s0 && d.date <= today())) dates[d.date] = true; });
    var avg = HN.dayAverages(Object.keys(dates).sort().map(dayStateFor));
    item('nutrition', 'Nutrition', avg.eatingDays.kcalMean === null ? 'No complete, quantified eating day in this window (averages need complete days)'
      : fmt(avg.eatingDays.kcalMean) + ' kcal average over ' + avg.eatingDays.n + ' complete day(s)' + (avg.eatingDays.proteinMean === null ? '' : ' · ' + fmt(avg.eatingDays.proteinMean) + ' g protein'));
    c.appendChild(dl);
    c.appendChild(h('p', { class: 'hint', text: 'Latest values and changes use recorded measurements only; nothing is estimated, smoothed or filled in.' }));
    return c;
  }
  // P1.1: Garmin intensity minutes by week (Monday-Sunday, Asia/Qatar). The sum of the daily totals the owner typed, with how
  // many days were recorded. Never scaled for missing days and never combined with workouts, steps or calories.
  function intensityText(w) {
    var dayWord = function (n) { return n + (n === 1 ? ' day' : ' days'); };
    var t = 'Week of ' + fmtDate(w.weekStart) + ': ';
    t += w.total === null ? 'no intensity minutes recorded (unknown, not 0)' : n0(w.total) + ' intensity min from ' + dayWord(w.daysRecorded) + ' recorded';
    t += ' · ' + w.daysMissing + ' of ' + w.daysElapsed + ' not recorded' + (w.complete ? '' : ' (week in progress, ' + dayWord(w.daysElapsed) + ' so far)');
    if (w.daysInvalid) t += ' · ' + dayWord(w.daysInvalid) + ' with a saved value that is not valid (not counted)';
    if (w.total !== null) t += ' · reference ' + w.reference + ': ' + (w.total >= w.reference ? 'reached on the recorded days' : (w.reference - w.total) + ' below on the recorded days' + (w.daysMissing || w.daysInvalid ? ' (the days not recorded are unknown)' : ''));
    return t;
  }
  function intensityCard(daily) {
    var c = card('Intensity minutes — weekly (Garmin, typed by you)', 'trends-intensity');
    HM.weeklyIntensity(today(), daily, 4).forEach(function (w) {
      c.appendChild(h('p', { testid: 'intensity-week', 'data-week': w.weekStart, 'data-total': w.total === null ? '' : String(w.total), 'data-recorded': String(w.daysRecorded), text: intensityText(w) }));
    });
    c.appendChild(h('p', { class: 'hint', testid: 'intensity-note', text: 'Each day is the weighted total Garmin shows (Garmin already counts vigorous minutes double — it is not doubled again here). Weeks run Monday to Sunday. Days you did not record are left out, never estimated or scaled up. ' +
      'This is kept apart from your workout records, steps and calories. ' + HM.INTENSITY_REFERENCE_WEEK + ' moderate-equivalent minutes a week is a general activity reference, not a target from plan v2.1 and not medical advice.' }));
    return c;
  }
  function renderTrends() {
    var root = $('trends-root'); root.replaceChildren();
    var daily = recs('daily');
    var weightAll = HW.series(legacy('weight'), function (r) { return r.kg; });
    root.appendChild(trendsSummary(inWin(weightAll), daily, recs('sessions')));
    if (HC && coachOn()) root.appendChild(coachReviewCard()); // P1.3 Delivery D
    var b = card('Body', 'trends-body');
    var wu = wUnit(), wPts = inWin(weightAll);
    if (wu === 'lb') wPts = wPts.map(function (pt) { return { date: pt.date, value: HM.kgToLb(pt.value) }; }); // shown in lb; every point converted from its stored kg
    b.appendChild(h('h3', { class: 'list-heading', testid: 'chart-weight-heading', text: 'Weight (' + wu + ')' })); b.appendChild(chart(wPts, wu, 'chart-weight'));
    b.appendChild(h('h3', { class: 'list-heading', text: 'Waist (cm)' })); b.appendChild(chart(inWin(HW.series(recs('body').filter(function (r) { return r.state === 'OBSERVED'; }), function (r) { return r.value; })), 'cm', 'chart-waist'));
    root.appendChild(b);
    var sw = card('Steps — weekly trend & consistency', 'trends-steps');
    var ctxFor = stepContext();
    HW.weeklySteps(today(), daily, function (d) { return HW.stepTarget(d, ctxFor(d)).target; }, 4).forEach(function (w) {
      sw.appendChild(h('p', { testid: 'steps-week', text: 'Week of ' + fmtDate(w.weekStart) + ': ' +
        (w.mean === null ? 'no daily totals recorded' : 'average ' + w.mean.toLocaleString('en-US') + ' steps over ' + w.daysRecorded + ' recorded day(s)') +
        ' · ' + w.daysMissing + ' of ' + w.daysElapsed + ' day(s) missing (not counted as 0)' +
        (w.daysWithTarget ? ' · guidance target reached on ' + w.daysMetTarget + ' of ' + w.daysWithTarget + ' day(s) with a target' : '') +
        (function () { var rf = stepReference(w.weekStart); return rf.goal === null ? '' : ' · plan reference goal (W' + rf.week + '): ' + (rf.week === 4 ? 'up to 10,000/day if tolerated' : rf.goal.toLocaleString('en-US') + '/day'); })() }));
    });
    sw.appendChild(h('p', { class: 'hint', text: 'Consistency compares each recorded day with that day\'s own guidance target. A lowered guidance target does not meet the plan reference goal. Missing days are shown as missing and never raise later targets.' }));
    root.appendChild(sw);
    if (HM) root.appendChild(intensityCard(daily));
    var r = card('Activity & recovery', 'trends-recovery');
    [['steps', 'Daily steps (declared total)', ''], ['sleepH', 'Sleep (h)', 'h'], ['soreness', 'Soreness (0–10)', ''], ['rhr', 'Resting HR (bpm)', 'bpm']].forEach(function (f) {
      r.appendChild(h('h3', { class: 'list-heading', text: f[1] })); r.appendChild(chart(inWin(HW.series(daily, function (d) { return HW.obs(d, f[0]); })), f[2], 'chart-' + f[0]));
    });
    root.appendChild(r);
    var n = card('Nutrition (qualified)', 'trends-nutrition');
    var meals = allMeals(), dates = {}; meals.forEach(function (m) { dates[m.date] = true; });
    recs('dayStates').forEach(function (d) { dates[d.date] = true; });
    var states = Object.keys(dates).sort().map(dayStateFor);
    var full = states.filter(function (s) { return s.fullDay; });
    var avg = HN.dayAverages(states);
    n.appendChild(h('p', { class: 'hint', text: states.length + ' days with meals or a declaration; ' + full.length + ' complete & quantified (D5). Full-day kcal/protein trends use D5 days only.' }));
    n.appendChild(h('p', { testid: 'avg-eating', text: 'Eating-day average (D5 days only, n=' + avg.eatingDays.n + '): ' + (avg.eatingDays.kcalMean === null ? 'no complete eating days yet' : fmt(avg.eatingDays.kcalMean) + ' kcal' + (avg.eatingDays.proteinMean === null ? '' : ' · ' + fmt(avg.eatingDays.proteinMean) + ' g protein')) }));
    n.appendChild(h('p', { testid: 'avg-fasting', text: 'Confirmed full-day fasts (tracked separately, never averaged into eating days): ' + avg.fastingDays.n + (avg.fastingDays.n ? ' — ' + avg.fastingDays.dates.map(fmtDate).join(', ') : '') }));
    n.appendChild(h('p', { class: 'hint', testid: 'avg-excluded', text: avg.excluded.n + ' day(s) excluded from averages. ' + avg.excluded.note }));
    n.appendChild(h('h3', { class: 'list-heading', text: 'Full-day kcal (D5 days only)' })); n.appendChild(chart(inWin(full.map(function (s) { return { date: s.date, value: s.subtotal.kcal.value }; })), 'kcal', 'chart-kcal-d5'));
    n.appendChild(h('h3', { class: 'list-heading', text: 'Known confirmed protein subtotal (all days — excludes unknown/unlogged)' }));
    n.appendChild(chart(inWin(states.filter(function (s) { return s.subtotal.proteinG.value !== null; }).map(function (s) { return { date: s.date, value: s.subtotal.proteinG.value }; })), 'g', 'chart-protein-subtotal'));
    n.appendChild(h('p', { class: 'hint', text: HN.PROVISIONAL.note }));
    root.appendChild(n);
    var t = card('Training', 'trends-training');
    var sessions = recs('sessions'), sum = HP.summary(sessions, recs('planEvents'));
    t.appendChild(h('p', { testid: 'trends-plan-summary', text: 'Plan v2.1: ' + sum.denominator + ' planned weekday sessions. Logged: ' + sum.COMPLETED + ' completed · ' + sum.PARTIAL + ' partial · ' + sum.SKIPPED + ' skipped · ' + sum.SOURCE_OMITTED + ' source-omitted · ' + sum.NOT_LOGGED + ' not logged.' }));
    t.appendChild(h('p', { class: 'hint', testid: 'trends-no-numerator', text: 'No qualifying "x of 20" count is shown: which sessions count toward the 17-of-20 review is an open owner decision. ' + sum.note }));
    var bm = HP.benchmarks(sessions);
    t.appendChild(h('ul', { class: 'entry-list', testid: 'trends-benchmarks' }, bm.map(function (x) {
      return h('li', { class: 'entry' }, h('div', { class: 'entry-body' }, h('div', { class: 'entry-title', text: 'Benchmark ' + x.benchmark + ' (' + fmtDate(x.date) + ')' }),
        h('div', { class: 'entry-meta', text: x.status + (x.durationMin != null ? ' · ' + x.durationMin + ' min' : '') + (x.status !== 'NOT_LOGGED' ? (x.comparable ? ' · comparable' : ' · NOT directly comparable (modified/partial/variant)') : '') })));
    })));
    if (HB) HB.activated(blocks()).forEach(function (b) {
      var bs2 = HB.summary(b, sessions), bm3 = HB.benchmarks(b, sessions)[0];
      t.appendChild(h('p', { testid: 'trends-b2-summary', text: (b.label || 'Block 2') + ' (' + fmtDate(b.startDate) + ' – ' + fmtDate(HB.lastDay(b)) + '): ' + bs2.denominator + ' planned weekday sessions. Logged: ' + bs2.COMPLETED + ' completed · ' + bs2.PARTIAL + ' partial · ' + bs2.SKIPPED + ' skipped · ' + bs2.SOURCE_OMITTED + ' source-omitted · ' + bs2.PLANNED_REST + ' planned rest · ' + bs2.NOT_IN_PLAN + ' not in plan · ' + bs2.NOT_LOGGED + ' not logged. Benchmark 3 (' + fmtDate(bm3.date) + '): ' + bm3.status + (bm3.status !== 'NOT_LOGGED' ? (bm3.comparable ? ' · comparable' : ' · NOT directly comparable') : '') + '.' }));
    });
    var lifts = {};
    sessions.forEach(function (s) { s.blocks.forEach(function (bl) { if (bl.kind === 'strength_set' && bl.setType !== 'WARMUP' && typeof bl.loadKg === 'number' && !bl.omitted) { var k = bl.exercise || bl.label; (lifts[k] = lifts[k] || []).push({ date: s.date, value: bl.loadKg }); } }); });
    Object.keys(lifts).forEach(function (k) {
      var by = {}; lifts[k].forEach(function (p) { by[p.date] = Math.max(by[p.date] || 0, p.value); });
      t.appendChild(h('h3', { class: 'list-heading', text: k + ' — top working-set load (kg)' }));
      t.appendChild(chart(inWin(Object.keys(by).sort().map(function (d) { return { date: d, value: by[d] }; })), 'kg', 'chart-lift'));
    });
    var runs = [];
    sessions.forEach(function (s) { s.blocks.forEach(function (bl) { if (bl.kind === 'run' && bl.distanceM > 0 && bl.durationSec > 0 && !bl.omitted) runs.push({ date: s.date, value: Math.round(bl.durationSec / (bl.distanceM / 1000)) }); }); });
    t.appendChild(h('h3', { class: 'list-heading', text: 'Run pace (sec/km, only where distance & time were recorded)' }));
    t.appendChild(chart(inWin(runs.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })), 's/km', 'chart-run-pace'));
    root.appendChild(t);
  }

  // ================= SETTINGS =================
  function renderSettings() {
    var root = $('settings-root'); root.replaceChildren();
    var s = aiSettings();
    var c = card('Photo food analysis', 'ai-settings');
    var opts = [['none', 'Not configured (default — nothing is ever sent)'], ['live', 'Photo analysis — OpenAI via your private server (needs the owner access code)'], ['mock', 'MOCK TEST provider (fixture data, no network, no cost)'], ['http', 'Local test backend — REAL model call (synthetic test image only; real photos NOT approved)']];
    opts.forEach(function (o) {
      c.appendChild(h('label', { class: 'check' }, h('input', { type: 'radio', name: 'ai-provider', value: o[0], checked: s.provider === o[0], testid: 'ai-provider-' + o[0],
        onchange: function () {
          // A real provider is never switched on by a stray tap: the owner has NOT approved real photos.
          if (o[0] === 'http' && !window.confirm('Switch on the REAL model backend?\n\nReal food photos are NOT approved yet (provider, privacy and cost are still owner decisions). Only the approved synthetic test image may be sent. Choose Cancel to keep it off.')) { renderSettings(); return; }
          var n = aiSettings(); n.provider = o[0]; if (!saveAiSettings(n)) toast('Could not save setting.', true); aiSession = null; liveStatus = { state: null, at: 0, checking: false }; renderSettings();
        } }), h('span', { text: o[1] })));
    });
    if (s.provider === 'mock') {
      c.appendChild(field('Mock scenario (testing)', select([['plate', 'Plate: chicken + rice + unknown oil'], ['butterChicken', 'Butter chicken: chicken pieces + sauce'], ['unknown', 'No food recognised'], ['invalid', 'Invalid / unsafe response'], ['impossible', 'Impossible macros'], ['error', 'Provider error'], ['timeout', 'Timeout (45 s)'], ['quota', 'Budget exhausted']], s.mockScenario || 'plate',
        { testid: 'ai-mock-scenario', onchange: function () { var n = aiSettings(); n.mockScenario = this.value; saveAiSettings(n); aiSession = null; } })));
    }
    if (s.provider === 'live') {
      var codeIn = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', testid: 'ai-owner-code',
        placeholder: ownerCode() ? 'Code saved on this device' : 'Paste owner access code', 'aria-label': 'Owner access code' });
      c.appendChild(field('Owner access code', codeIn, 'Stored only on this device (not in backups or exports). The server keeps only a hash.'));
      var liveOut = h('p', { class: 'note', testid: 'ai-live-status', role: 'status', 'aria-live': 'polite' });
      var LIVE_TXT = { ready: 'Ready. Photo analysis is switched on.', needs_code: 'Server is set up. Enter the owner access code.', bad_code: AI.friendlyMessage('AUTH'), locked: AI.friendlyMessage('LOCKED_OUT'),
        not_configured: AI.friendlyMessage('NOT_CONFIGURED'), offline: AI.friendlyMessage('OFFLINE'), error: AI.friendlyMessage('NETWORK') };
      function checkLive() {
        liveOut.textContent = 'Checking…';
        currentProvider().check().then(function (r) { liveStatus = { state: r.state, info: r.info || null, at: Date.now(), checking: false };
          liveOut.textContent = LIVE_TXT[r.state] + (r.state === 'ready' && r.info && r.info.usage ? ' Left: ' + (r.info.usage.day.cap - r.info.usage.day.calls) + ' photos today, about $' + r.info.usage.remainingUsd.toFixed(2) + ' of budget.' : ''); });
      }
      c.appendChild(h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-primary btn-small', text: 'Save code', testid: 'ai-owner-code-save', onclick: function () {
          var v = codeIn.value.trim();
          if (!/^[\x21-\x7E]{16,256}$/.test(v)) { toast('That does not look like the owner access code.', true); return; }
          if (!saveOwnerCode(v)) { toast('Could not save the code on this device.', true); return; }
          codeIn.value = ''; liveStatus = { state: null, at: 0, checking: false }; toast('Code saved on this device.'); renderSettings();
        } }),
        h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Check connection', testid: 'ai-live-check', onclick: checkLive }),
        ownerCode() ? h('button', { type: 'button', class: 'btn btn-small btn-delete', text: 'Remove code', testid: 'ai-owner-code-remove', onclick: function () { saveOwnerCode(''); liveStatus = { state: null, at: 0, checking: false }; renderSettings(); } }) : null));
      c.appendChild(liveOut);
    }
    if (s.provider === 'http') {
      var ep = h('input', { type: 'text', value: s.endpoint || '/api/food-photo', testid: 'ai-endpoint', onchange: function () { var n = aiSettings(); n.endpoint = this.value.trim(); saveAiSettings(n); } });
      c.appendChild(field('Backend endpoint', ep, 'API keys stay on the backend; the browser never sees them.'));
      var out = h('p', { class: 'note', testid: 'ai-backend-status', role: 'status' });
      c.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Check backend status', testid: 'ai-check-status', onclick: function () {
        out.textContent = 'Checking…';
        currentProvider().status().then(function (st) {
          out.textContent = (st.configured ? 'Configured: ' : 'NOT configured: ') + st.provider + ' / ' + st.model + ' · real-call budget ' + st.budgetRemaining + ' of ' + st.budgetTotal + ' remaining. ' + st.terms;
        }, function () { out.textContent = 'Backend unreachable — photo analysis unavailable. Manual entry still works.'; });
      } }));
      c.appendChild(out);
    }
    c.appendChild(h('p', { class: 'hint', testid: 'ai-privacy-state', text: s.privacyAckAt ? 'Privacy acknowledged ' + s.privacyAckAt.slice(0, 10) + '. Each photo still needs its own Send confirmation.' : 'No privacy acknowledgment given yet.' }));
    if (s.privacyAckAt) c.appendChild(h('button', { type: 'button', class: 'btn btn-small btn-delete', text: 'Revoke privacy acknowledgment', testid: 'ai-privacy-revoke', onclick: function () { var n = aiSettings(); n.privacyAckAt = null; saveAiSettings(n); renderSettings(); } }));
    c.appendChild(h('p', { class: 'hint', testid: 'ai-settings-footnote', text: s.provider === 'live'
      ? 'Photos are processed in memory only: never stored in this app, backups or logs. OpenAI may keep a sent photo up to 30 days for abuse monitoring; it is not used for training by default.'
      : 'Photos are processed in memory only: never stored in this app, backups or logs. Live AI use beyond the single owner-approved synthetic test remains BLOCKED pending owner approval of provider, region, retention and cost.' }));
    root.appendChild(c);

    root.appendChild(ownerSettingsCard());
    root.appendChild(coachCard()); // P1.3 Delivery B
    var att = attentionCard();
    if (att) root.appendChild(att);
    var after = $('settings-after'); after.replaceChildren();
    if (HM) after.appendChild(unitsCard());
    after.appendChild(buildCard());
    after.appendChild(coachExportCard()); // Sprint D (P1.4)
    // Sprint C: the inactive integration placeholders are folded into one closed section (nothing to tap inside;
    // the stubs themselves are unchanged and still answer NOT_ACTIVATED without any network call).
    var FUTURE_TEXT = {
      'owner-auth': 'A sign-in for you only. Not built: the app has no login and keeps everything on this phone.',
      'cloud-sync': 'An automatic cloud copy of your data. Not built: use Export backup in Settings.',
      'health-import': 'Automatic Garmin / Apple Health import. Not built: you enter steps and intensity minutes yourself.',
      'food-catalogue': 'A licensed food database. Not built: the built-in food lists are used.',
      'text-ai': 'An AI estimate from a text description alone. Not built. Photo analysis (a photo plus an optional note) is a separate feature that works: see Photo food analysis above.'
    };
    var fut = window.HyroxIntegrations ? window.HyroxIntegrations.list() : [];
    var fold = h('details', { class: 'fold fold-future', testid: 'integrations-fold' }, h('summary', { text: 'Advanced / Future integrations (' + fut.length + ', none active)', testid: 'integrations-fold-summary' }));
    fold.appendChild(h('p', { class: 'hint', text: 'Placeholders for possible later features. None is switched on: nothing here connects, signs in or sends data, and each needs your separate approval before it is ever built.' }));
    fut.forEach(function (x) {
      fold.appendChild(h('div', { class: 'entry', testid: 'integration-' + x.id }, h('div', { class: 'entry-body' }, h('div', { class: 'entry-title' }, h('span', { text: x.name }), badge('Not active', 'muted')), h('div', { class: 'entry-meta', text: FUTURE_TEXT[x.id] || 'Not built.' }))));
    });
    after.appendChild(fold);
    var a = card('About your data & safety', 'about');
    a.appendChild(h('p', { class: 'hint', text: 'All data stays in this browser (localStorage key hyrox.v1). Safari tabs and the Home-Screen app may have separate storage; clearing site data deletes it. Export backups regularly. Units: weight is stored in kg (shown in kg or lb — your choice under Units), cm (waist), metres and seconds (workout blocks), km (walks). Dates: Asia/Qatar.' }));
    a.appendChild(h('p', { class: 'hint', text: 'Training source: Block v2.1 (7 Nov 2026), conditional approval — not medical clearance. Block ' + HP.humanShort(HP.BLOCK_START) + ' – ' + HP.human(HP.BLOCK_END) + ' (Week 1 starts ' + HP.humanShort(HP.BLOCK_START) + '); after that: "' + HP.NO_BLOCK_TEXT + '". Block 2 exists only if you create, review and activate it yourself (Today → Next training block). No automatic Block 2, progression, calorie changes or medical advice.' }));
    a.appendChild(h('p', { class: 'hint', text: HW.SAFETY }));
    after.appendChild(a);
  }

  // Every saved entry that is not valid as saved, with the exact field, value and rule. Read-only.
  var COLLECTION_NAMES = { daily: 'Check-in', walks: 'Walk', sessions: 'Workout', meals: 'Meal', body: 'Waist entry', dayStates: 'Day declaration', planEvents: 'Plan change',
    ownerSettings: 'Settings', weight: 'Weight entry', workouts: 'Quick workout', nutrition: 'Quick nutrition entry' };
  function attentionCard() {
    var list = damaged();
    if (!list.length) return null;
    var c = card('Records needing attention', 'attention-card');
    c.appendChild(h('p', { class: 'note note-warn', testid: 'attention-summary', role: 'status', text: list.length + ' saved ' + (list.length === 1 ? 'entry has' : 'entries have') +
      ' a value that is not valid. Nothing has been deleted or changed. To keep an untouched copy of everything exactly as saved, use "Download emergency raw copy" below.' }));
    list.forEach(function (d) {
      var how = d.kind === 'DAMAGED'
        ? 'Not shown, not counted and left out of the normal backup. It stays saved on this device and is included in the emergency raw copy.'
        : d.collection === 'daily' ? 'The rest of this check-in is shown and used; the value above counts as unknown. Correct it under Add → Daily check-in for that date. The normal backup keeps the record with this value marked invalid and the original noted.'
        : 'The rest of this walk is shown; the value above is not counted. Correct it in History → Walks. The normal backup keeps it exactly as saved.';
      c.appendChild(h('div', { class: 'entry', testid: 'attention-item', 'data-kind': d.kind, 'data-collection': d.collection },
        h('div', { class: 'entry-body' },
          h('div', { class: 'entry-title' }, h('span', { text: (COLLECTION_NAMES[d.collection] || d.collection) + (d.date ? ' · ' + fmtDate(d.date) : ' · no usable date') }),
            badge(d.kind === 'DAMAGED' ? 'Not usable' : 'One value not usable', d.kind === 'DAMAGED' ? 'bad' : 'warn')),
          h('div', { class: 'entry-meta', testid: 'attention-problems', text: problemsText(d.problems) }),
          h('p', { class: 'hint', text: how }))));
    });
    return c;
  }

  // Owner rules 1 and 5: configurable resting-HR baseline and step baseline.
  // ================= P1.3 Delivery B: Settings > Nutrition Coach (profile, goal, confirmed targets) =================
  // Everything lives in the ONE optional settings field nutritionCoach (hyrox-coach.js validates it). Every write re-reads
  // the stored settings record, refuses when it changed since this screen was drawn (another tab / another writer), keeps
  // every other field (plan blocks, saved foods, favourites, baselines, weight unit, later-version fields) and is verified
  // by read-back. No target ever changes without the confirm screen. Profile is shown only here, never on Home.
  var HC = window.HyroxCoach || null;
  var coachUi = { profileOpen: false, unit: null, mode: null, pending: null, msg: null, bad: false };
  // ---- P1.3 Delivery C: computed estimate (Stage A starting estimate, Stage B personal estimate) and the goal proposal ----
  // Day facts for the coach from the app's own day states: an intake figure only for D5; DF counted apart; the kcal share that is
  // ESTIMATED (any component whose kcal is not KNOWN) is reported, never hidden.
  function coachDays(from, to) {
    var out = [], meals = allMeals();
    for (var d = from; d <= to; d = HC.addDays(d, 1)) {
      var st = HN.dayState(d, meals, attestationFor(d)), est = 0;
      if (st.code === 'D5') meals.forEach(function (m) {
        if (m.date !== d || m.lifecycle !== 'CONFIRMED') return;
        (m.components || []).forEach(function (c) { var f = HN.eatenFractionOf(m, c); if (c.kcal && c.kcal.state !== 'KNOWN' && typeof c.kcal.value === 'number' && f !== null) est += c.kcal.value * f; });
      });
      out.push({ date: d, code: st.code, kcal: st.code === 'D5' ? st.dayKcal : null, estKcal: st.code === 'D5' ? Math.round(est) : null, proteinG: st.code === 'D5' ? st.subtotal.proteinG.value : null });
    }
    return out;
  }
  // Recovery facts for one completed week from the EXISTING readiness rules and check-ins (nothing new is judged here).
  function coachRecovery(wk) {
    var dailies = recs('daily'), set = settings(), flagDays = 0, maxPain = null, painDays = 0;
    for (var d = wk.start; d <= wk.end; d = HC.addDays(d, 1)) {
      var r = HW.readiness(d, dailies, set); if (r.flags.length >= 2) flagDays++;
      var pv = HW.obs(dailies.filter(function (x) { return x.date === d; })[0], 'pain');
      if (pv !== null) { painDays++; if (maxPain === null || pv > maxPain) maxPain = pv; }
    }
    var pl = coachPlanned(wk);
    return { flagDays: flagDays, maxPain: maxPain, painDays: painDays, slots: pl.slots, planned: pl };
  }
  // Planned vs completed for one review week from the existing plan (v2.1 and activated blocks) and session records.
  function coachPlanned(wk) {
    // Independent review C3: SOURCE_OMITTED is the source cascade's own decision (not a miss) and is kept out of every count;
    // NOT_LOGGED, NOT_STARTED and IN_PROGRESS in a finished week are UNKNOWN (never "skipped"); SKIPPED is only an explicit skip.
    var sessions = recs('sessions'), events = recs('planEvents'), n = { total: 0, COMPLETED: 0, PARTIAL: 0, SKIPPED: 0, OMITTED: 0, UNLOGGED: 0 };
    for (var d = wk.start; d <= wk.end; d = HC.addDays(d, 1)) {
      PL.plannedOn(d, events).forEach(function (sl) {
        var code = (PL.slotStatus(sl.id, sessions, events) || {}).code;
        n.total++;
        if (code === 'COMPLETED' || code === 'PARTIAL' || code === 'SKIPPED') n[code]++;
        else if (code === 'SOURCE_OMITTED') n.OMITTED++;
        else n.UNLOGGED++;
      });
    }
    n.slots = { planned: n.total, completed: n.COMPLETED, partial: n.PARTIAL, skipped: n.SKIPPED, unlogged: n.UNLOGGED, omitted: n.OMITTED };
    return n;
  }
  function coachSets() {
    var out = [];
    recs('sessions').forEach(function (s) { (s.blocks || []).forEach(function (bl) { if (bl && bl.kind === 'strength_set' && bl.setType !== 'WARMUP' && !bl.omitted) out.push({ date: s.date, exercise: bl.exercise || bl.label, loadKg: bl.loadKg, reps: bl.reps }); }); });
    return out;
  }
  function coachContext(td) {
    return memoRead('coachCtx:' + td, function () {
      var weeks = HC.reviewWeeks(td, HC.STAGEB.weeks), days = coachDays(weeks[0].start, td), sb = HC.stageB(days, legacy('weight'), td);
      var rc = coachRead(), co = rc.valid && rc.coach ? rc.coach : HC.emptyCoach(), sex = co.profile ? co.profile.sexForEquation : null;
      var last = weeks[weeks.length - 1], rec = coachRecovery(last), sets = coachSets();
      var loss = co.goal && HC.goalById(co.goal.id) && HC.goalById(co.goal.id).lbPerWeek < 0;
      var down = loss ? HC.strengthDownTwice(sets, weeks) : [];
      var est = HC.startingEstimate(co, legacy('weight'), td), tgt = HC.targetFor(co, td, HN.PROVISIONAL);
      return { weeks: weeks, days: days, sb: sb, last: last, recovery: rec, sets: sets, strength: HC.strengthCompare(sets, weeks), coach: co,
        floorKcal: HC.PROVISIONAL_FLOOR[sex === 'FEMALE' ? 'FEMALE' : 'MALE'],
        concerns: HC.concerns(sb, days, { floorKcal: HC.PROVISIONAL_FLOOR[sex === 'FEMALE' ? 'FEMALE' : 'MALE'], restingKcal: est.ok ? est.resting : null, target: tgt, recovery: rec, strengthDown: down }) };
    });
  }
  function coachEstimateNow(co) { return HC.startingEstimate(co, legacy('weight'), today()); }
  // ---- P1.3 Delivery D: Home status line and the Trends weekly review ----
  function coachStatus(td) { var ctx = coachContext(td); return { ctx: ctx, st: HC.status(ctx.sb, ctx.concerns, ctx.coach.goal ? ctx.coach.goal.id : null, wUnit()) }; }
  function coachStatusLine(d) {
    var cs = coachStatus(d), st = cs.st, last = cs.ctx.last;
    return h('p', { class: 'coach-status coach-status-' + st.level.toLowerCase(), testid: 'coach-status', 'data-level': st.level, role: 'status' },
      h('span', { class: 'coach-status-icon', 'aria-hidden': 'true', text: st.icon }),
      h('span', { class: 'coach-status-text', testid: 'coach-status-text', text: 'Coach · ' + st.label + ' (week to ' + fmtDate(last.end) + '): ' + st.text + ' Today’s food above is “logged so far”, not this result.' }));
  }
  function nextMonday(td) { var k = new Date(td + 'T00:00:00Z').getUTCDay(); return HC.addDays(td, k === 1 ? 0 : (8 - k) % 7); }
  function coachReviewCard() {
    var td = today(), cs = coachStatus(td), ctx = cs.ctx, st = cs.st, wk = ctx.last, f = ctx.sb.weeks[ctx.sb.weeks.length - 1], co = ctx.coach;
    var c = card('Weekly review (coach)', 'trends-coach-review');
    var ns = nextMonday(td);
    c.appendChild(h('p', { class: 'hint', testid: 'review-week', text: 'Completed week ' + shortRange(wk.start, wk.end) + ' (Monday–Sunday, Asia/Qatar, the same weeks as the training plan). ' + (ns === td ? 'Today is review day.' : 'Next review ' + fmtDate(ns) + '.') + ' The current week is not judged until it is complete.' }));
    c.appendChild(h('p', { class: 'coach-status coach-status-' + st.level.toLowerCase(), testid: 'review-status', 'data-level': st.level }, h('span', { class: 'coach-status-icon', 'aria-hidden': 'true', text: st.icon }), h('span', { text: st.label + ': ' + st.text })));
    var gaps = [];
    function sec(title, tid) { var box = h('div', { class: 'review-sec', testid: tid }); box.appendChild(h('h3', { class: 'list-heading', text: title })); c.appendChild(box); return box; }
    // weight (weekly means vs the latest raw reading)
    var ws = sec('Weight', 'review-weight');
    ctx.sb.weeks.forEach(function (w) { ws.appendChild(h('p', { testid: 'review-weight-week', text: shortRange(w.start, w.end) + ': ' + (w.meanKg !== null ? 'weekly mean ' + wText(w.meanKg) + ' (' + w.weighDays + ' weigh-in days)' : w.weighDays + ' weigh-in day' + (w.weighDays === 1 ? '' : 's') + ' — no weekly mean (3 needed)') })); });
    var wl = HC.validWeights(legacy('weight'), td);
    if (wl.length) { var lw = wl[wl.length - 1]; ws.appendChild(h('p', { class: 'hint', testid: 'review-weight-latest', text: 'Latest recorded: ' + wText(Math.round(lw.kg * 10) / 10) + ' on ' + fmtDate(lw.date) + ' — a single reading, not the trend.' })); }
    if (f.weighDays < 3) gaps.push(f.weighDays + ' weigh-in day' + (f.weighDays === 1 ? '' : 's') + ' last week (3 needed)');
    // waist and waist-to-height (informational)
    var wa = sec('Waist', 'review-waist');
    var waists = recs('body').filter(function (b) { return b && b.metric === 'waist_cm' && b.state === 'OBSERVED' && typeof b.value === 'number' && b.date <= wk.end; }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var lwst = waists.length ? waists[waists.length - 1] : null;
    if (!lwst || lwst.date < ctx.sb.weeks[0].start) { wa.appendChild(h('p', { testid: 'review-waist-line', text: 'No waist measurement in these 4 weeks (a gap, not "no change").' })); gaps.push('no waist measurement in 4 weeks'); }
    else {
      wa.appendChild(h('p', { testid: 'review-waist-line', text: 'Latest waist ' + lwst.value + ' cm on ' + fmtDate(lwst.date) + '.' }));
      var r = HC.waistToHeight(lwst.value, co.profile ? co.profile.heightCm : null);
      wa.appendChild(h('p', { class: 'hint', testid: 'review-whtr', text: r === null ? 'Waist-to-height needs your height (Settings > Nutrition Coach > Profile).' : 'Waist-to-height ratio ' + r.toFixed(2) + ' (informational only). For reference, NICE guideline NG246 (rec. 1.9.14) describes 0.4–0.49 as healthy, 0.5–0.59 as increased and 0.6 or more as high central adiposity for adults with a BMI under 35. Not a diagnosis; nothing about fat or muscle is concluded from waist alone.' }));
    }
    // strength retention (like with like only)
    var sr = sec('Strength (comparable working sets)', 'review-strength');
    if (!ctx.strength.length) sr.appendChild(h('p', { testid: 'review-strength-line', text: 'No working sets with load and reps recorded in these 4 weeks.' }));
    ctx.strength.forEach(function (x) { sr.appendChild(h('p', { testid: 'review-strength-line', 'data-result': x.result, text: x.text })); });
    // nutrition coverage
    var nu = sec('Nutrition coverage', 'review-nutrition');
    nu.appendChild(h('p', { testid: 'review-nutrition-line', text: f.d5 + ' of 7 days complete and quantified (D5), ' + f.weekendD5 + ' of them at the weekend' + (f.fastDays ? '; ' + f.fastDays + ' confirmed fast day' + (f.fastDays === 1 ? '' : 's') + ' (kept apart)' : '') + '; ' + f.excludedDays + ' day' + (f.excludedDays === 1 ? '' : 's') + ' not complete (no intake figure, not 0).' + (f.d5 ? ' Average on complete days ' + n0(f.kcalMean) + ' kcal; estimated share ' + (f.kcalSum > 0 ? Math.round(f.estKcal / f.kcalSum * 100) : 0) + ' %.' : '') }));
    nu.appendChild(h('p', { class: 'hint', testid: 'review-stage-b', text: ctx.sb.ready ? ctx.sb.text : ctx.sb.text + ' Shortfall: ' + ctx.sb.shortfall.map(function (x) { return shortRange(x.start, x.end) + ' — ' + x.text; }).join('; ') + '.' }));
    if (f.d5 < 4) gaps.push(f.d5 + ' complete food day' + (f.d5 === 1 ? '' : 's') + ' last week (4 needed for the personal estimate)');
    if (f.weekendD5 < 1) gaps.push('no complete weekend food day last week');
    // Garmin intensity minutes and steps (context only; never calories)
    var dailies = recs('daily'), act = sec('Activity (context only — never adds calories or changes a target)', 'review-activity');
    var imin = 0, irec = 0, stp = 0, srec = 0;
    for (var dd = wk.start; dd <= wk.end; dd = HC.addDays(dd, 1)) {
      var rec = dailies.filter(function (x) { return x.date === dd; })[0];
      if (HM) { var ir = HM.intensityRead(rec); if (ir.state === 'OBSERVED') { imin += ir.value; irec++; } }
      var sv = HW.obs(rec, 'steps'); if (sv !== null) { stp += sv; srec++; }
    }
    act.appendChild(h('p', { testid: 'review-intensity', text: 'Garmin intensity minutes: ' + (irec ? imin + ' over ' + irec + ' recorded day' + (irec === 1 ? '' : 's') + ' (as Garmin shows them, already weighted — not doubled again)' : 'none recorded') + '.' }));
    act.appendChild(h('p', { testid: 'review-steps', text: 'Steps: ' + (srec ? 'average ' + n0(Math.round(stp / srec)) + ' over ' + srec + ' recorded day' + (srec === 1 ? '' : 's') : 'none recorded') + '.' }));
    if (irec < 7) gaps.push('intensity minutes missing on ' + (7 - irec) + ' day' + (7 - irec === 1 ? '' : 's'));
    if (srec < 7) gaps.push('steps missing on ' + (7 - srec) + ' day' + (7 - srec === 1 ? '' : 's'));
    // planned vs completed, recovery
    var pl = ctx.recovery.planned, tr = sec('Training and recovery', 'review-training');
    tr.appendChild(h('p', { testid: 'review-planned', text: pl.total ? 'Planned sessions: ' + pl.total + ' · completed ' + pl.COMPLETED + ' · partial ' + pl.PARTIAL + ' · skipped (logged as skipped) ' + pl.SKIPPED + ' · not logged (unknown) ' + pl.UNLOGGED + (pl.OMITTED ? ' · omitted by the plan’s own rules ' + pl.OMITTED + ' (not a miss)' : '') + '.' : 'No planned sessions in this week.' }));
    if (pl.UNLOGGED) gaps.push(pl.UNLOGGED + ' planned session' + (pl.UNLOGGED === 1 ? '' : 's') + ' not logged');
    var rv = ctx.recovery;
    tr.appendChild(h('p', { testid: 'review-recovery', text: 'Days with 2 or more readiness flags: ' + rv.flagDays + ' · highest pain recorded: ' + (rv.maxPain === null ? 'none recorded' : rv.maxPain + '/10') + ' (pain recorded on ' + rv.painDays + ' of 7 days). Existing stop and readiness rules always come first.' }));
    if (rv.painDays < 7) gaps.push('pain not recorded on ' + (7 - rv.painDays) + ' day' + (7 - rv.painDays === 1 ? '' : 's'));
    if (ctx.concerns.length) { var cc = sec('Concerns', 'review-concerns'); ctx.concerns.forEach(function (x) { cc.appendChild(h('p', { class: x.level === 'HOLD' ? 'note' : 'note note-warn', testid: 'review-concern', 'data-code': x.code, 'data-level': x.level, text: x.text })); }); }
    var gp = sec('Gaps', 'review-gaps');
    if (!gaps.length) gp.appendChild(h('p', { testid: 'review-gap', text: 'No gaps last week.' }));
    gaps.forEach(function (g) { gp.appendChild(h('p', { testid: 'review-gap', text: g + '.' })); });
    c.appendChild(h('p', { class: 'hint', text: 'Nothing here changes your target. A change is only ever proposed in Settings > Nutrition Coach and needs your confirmation.' }));
    return c;
  }
  function shortRange(a, b) { return fmtDate(a) + ' – ' + fmtDate(b); }
  function coachEstimateBlock(co, cur, stamp) {
    var td = today(), est = coachEstimateNow(co), ctx = coachContext(td), sb = ctx.sb;
    var box = h('section', { class: 'note coach-estimate', testid: 'coach-estimate', 'aria-label': 'Computed estimate' });
    box.appendChild(h('h3', { class: 'coach-sub', text: 'Computed estimate (approximate)' }));
    // Stage A
    if (!est.ok) box.appendChild(h('p', { class: 'hint', testid: 'coach-stage-a-needs', text: est.code === 'NO_EQUATION' ? est.need[0] : 'Starting estimate needs: ' + est.need.join(', ') + '.' + (est.weight && !est.weight.ok ? ' ' + est.weight.text : '') }));
    else {
      // P1.3-RC3 (owner decision 5): the estimate is SHOWN rounded to the nearest 50 kcal; data-maintenance, the arithmetic below
      // and anything a Confirm stores keep the exact figure.
      var actL = HC.activityById(est.activity);
      box.appendChild(h('p', { testid: 'coach-stage-a', 'data-maintenance': String(est.maintenance), text: 'Starting estimate: maintenance ' + HC.estimateKcalText(est.maintenance) + ' a day (resting ' + HC.estimateKcalText(est.resting) + ' × activity ' + est.factor + ', your assumed activity: “' + (actL ? actL.label : est.activity) + '”). Approximate — not a measured maintenance, and no confidence range is claimed. Shown rounded to the nearest 50 kcal.' }));
      var wi = est.weight;
      box.appendChild(h('p', { class: 'hint', testid: 'coach-stage-a-inputs', text: 'Inputs: weight ' + wText(wi.kg) + (wi.basis === 'MEAN_7D' ? ' (mean of ' + wi.days + ' weigh-in day' + (wi.days === 1 ? '' : 's') + ', ' + (wi.from === wi.to ? fmtDate(wi.from) : shortRange(wi.from, wi.to)) + ')' : ' (latest weigh-in, ' + fmtDate(wi.from) + ')') +
        ' · height ' + co.profile.heightCm + ' cm · age ' + co.profile.ageYears + ' · equation: Mifflin–St Jeor (' + (co.profile.sexForEquation === 'MALE' ? 'male' : 'female') + ' constant) · activity ' + est.factor + '. Workouts, steps and Garmin minutes are never added on top.' }));
    }
    // Stage B
    if (sb.ready) {
      box.appendChild(h('p', { testid: 'coach-stage-b', 'data-ready': 'true', 'data-maintenance': String(sb.maintenance), text: sb.text }));
      box.appendChild(h('p', { class: 'hint', testid: 'coach-stage-b-days', text: 'Window ' + shortRange(sb.window.from, sb.window.to) + ' (completed Monday–Sunday weeks; the same dates for weight and food). Included: ' + sb.includedDays + ' complete days and ' + sb.weighDays + ' weigh-in days in ' + sb.qualifying + ' qualifying weeks. Excluded: ' + sb.excludedDays + ' days that were not complete (unlogged, in progress, pending or not fully quantified — not counted as 0)' + (sb.fastDays ? '; ' + sb.fastDays + ' confirmed fast day' + (sb.fastDays === 1 ? '' : 's') + ' kept apart, not in the intake mean' : '') + '. Estimated share of the counted kcal: ' + sb.estimatedShare + ' %.' }));
    } else {
      box.appendChild(h('p', { class: 'hint', testid: 'coach-stage-b', 'data-ready': 'false', text: sb.text }));
      var ul = h('ul', { class: 'entry-list', testid: 'coach-stage-b-shortfall' });
      sb.shortfall.forEach(function (w) { ul.appendChild(h('li', { testid: 'coach-stage-b-week', text: shortRange(w.start, w.end) + ': ' + w.text })); });
      box.appendChild(ul);
    }
    // Proposal for the chosen goal
    var src = sb.ready ? 'STAGE_B' : est.ok ? 'STAGE_A' : null;
    if (!co.goal) { box.appendChild(h('p', { class: 'hint', testid: 'coach-proposal', 'data-state': 'NEEDS_INPUT', text: 'Choose a goal to see a suggested target.' })); return box; }
    if (!src) { box.appendChild(h('p', { class: 'hint', testid: 'coach-proposal', 'data-state': 'NEEDS_INPUT', text: 'No suggested target until an estimate is available. You can enter your own target below.' })); return box; }
    var wkg = est.ok ? est.weight.kg : (HC.recentWeight(legacy('weight'), td).kg || null);
    var conc = ctx.concerns.filter(function (c) { return c.level !== 'HOLD'; }).map(function (c) { return c.text; });
    var red = cur.origin === 'PROVISIONAL' ? { allowed: true, why: '' } : HC.reductionCheck(sb, co.goal.id, co.target, ctx.concerns);
    var pr = HC.proposal({ maintenance: src === 'STAGE_B' ? sb.maintenance : est.maintenance, resting: est.ok ? est.resting : null, source: src, weightKg: wkg,
      sex: co.profile ? co.profile.sexForEquation : null, goalId: co.goal.id, current: cur, concerns: conc, reductionAllowed: red.allowed, reductionWhy: red.why });
    var STATE = { AVAILABLE: 'Suggested target', GATED: 'No computed target offered', HELD: 'Suggestion held — no reduction now' };
    var pbox = h('div', { class: 'coach-proposal', testid: 'coach-proposal', 'data-state': pr.state });
    pbox.appendChild(h('p', { class: 'entry-title', testid: 'coach-proposal-line', text: STATE[pr.state] + ' (' + HC.goalById(co.goal.id).label.toLowerCase() + ', from the ' + (src === 'STAGE_B' ? 'personal estimate' : 'starting estimate') + '): ' + targetLine(pr.target) }));
    pbox.appendChild(h('p', { class: 'hint', testid: 'coach-proposal-arith', text: 'Calculation (exact figures): ' + pr.arithmetic }));
    // CC decision 4: a first suggestion from the equation is optional; the provisional reference stays until the owner confirms.
    if (cur.origin === 'PROVISIONAL') pbox.appendChild(h('p', { class: 'hint', testid: 'coach-proposal-reference', text: 'Until you confirm a target yourself, the provisional reference of ' + n0(HN.PROVISIONAL.kcal) + ' kcal / protein ' + HN.PROVISIONAL.proteinG + ' g (protein floor ' + HN.PROVISIONAL.proteinFloorG + ' g) stays in force. This suggestion is optional and based on an estimate, not a measured maintenance.' }));
    pr.gates.forEach(function (g) { pbox.appendChild(h('p', { class: 'note note-warn', testid: 'coach-proposal-gate', 'data-gate': g.id, text: g.text })); });
    pr.held.forEach(function (t) { pbox.appendChild(h('p', { class: 'note note-warn', testid: 'coach-proposal-held', text: t })); });
    pr.warnings.forEach(function (t) { pbox.appendChild(h('p', { class: 'note note-warn', testid: 'coach-proposal-warning', text: t })); });
    var same = cur.origin !== 'PROVISIONAL' && cur.kcal === pr.target.kcal && cur.proteinG === pr.target.proteinG && cur.fatG === pr.target.fatG && cur.carbsG === pr.target.carbsG;
    if (pr.state === 'AVAILABLE' && same) pbox.appendChild(h('p', { class: 'hint', testid: 'coach-proposal-same', text: 'This matches the target you already confirmed. Nothing to change.' }));
    else if (pr.state === 'AVAILABLE') pbox.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Review this suggestion', testid: 'coach-proposal-review', onclick: function () {
      var inputs = { stage: src === 'STAGE_B' ? 'B' : 'A', maintenance: pr.maintenance, goal: co.goal.id, deltaKcal: pr.delta, proteinRefG: pr.target.proteinG, fatShare: HC.FAT_SHARE };
      if (est.ok) { inputs.resting = est.resting; inputs.factor = est.factor; inputs.activity = est.activity; inputs.weightKg = est.weight.kg; inputs.weightFrom = est.weight.from; inputs.weightTo = est.weight.to; inputs.heightCm = est.inputs.heightCm; inputs.ageYears = est.inputs.ageYears; inputs.sexForEquation = est.inputs.sexForEquation; }
      if (src === 'STAGE_B') { inputs.stageBDays = sb.includedDays; inputs.stageBIntakeMean = sb.intakeMean; inputs.stageBSlopeKgWk = sb.slopeKgPerWeek; inputs.stageBCoverage = sb.coverage; inputs.estimatedSharePct = sb.estimatedShare; inputs.windowFrom = sb.window.from; inputs.windowTo = sb.window.to; }
      coachUi.mode = 'confirm';
      coachUi.pending = { target: pr.target, origin: 'COMPUTED', method: src === 'STAGE_B' ? 'STAGE_B_GOAL' : 'MSJ_ACTIVITY_GOAL', inputs: inputs, inputsText: pr.arithmetic,
        warnings: pr.warnings.map(function (t) { return { code: 'RATE_FASTER_THAN_PREFERRED', text: t }; }),
        reason: (src === 'STAGE_B' ? 'Personal estimate' : 'Starting estimate') + ', goal ' + HC.goalById(co.goal.id).label.toLowerCase() + (red.allowed && cur.origin !== 'PROVISIONAL' && pr.target.kcal < cur.kcal ? '; Monday review: ' + red.why : '') };
      renderSettings(); focusTestid('coach-confirm-title');
    } }));
    box.appendChild(pbox);
    return box;
  }
  // Independent review C6: if hyrox-coach.js did not load, a stored coach is reported UNAVAILABLE (never as switched off).
  function coachRead() { return memoRead('coach', function () { var r = rawSettingsRecord(); if (HC) return HC.readCoach(r);
    var has = !!r && r.nutritionCoach !== undefined && r.nutritionCoach !== null;
    return { present: has, valid: !has, unavailable: has, coach: null, problems: has ? ['the Nutrition Coach part of the app did not load'] : [] }; }); }
  function coachOn() { var rc = coachRead(); return !!(rc.valid && rc.coach && rc.coach.enabled === true); }
  function coachRef(date) { var rc = coachRead(); return HC ? HC.targetFor(rc.valid ? rc.coach : null, date, HN.PROVISIONAL) : { kcal: HN.PROVISIONAL.kcal, proteinG: HN.PROVISIONAL.proteinG, proteinFloorG: HN.PROVISIONAL.proteinFloorG, fatG: null, carbsG: null, origin: 'PROVISIONAL', effectiveDate: null }; }
  function coachSay(text, bad) { coachUi.msg = text; coachUi.bad = !!bad; }
  function coachWrite(mutate, stamp, okText) {
    var r;
    dropReadMemo();
    try {
      r = HB.writeSettings(store, HD, today(), function (rec) {
        var rc = HC.readCoach(rec);
        if (!rc.valid) return { ok: false, code: 'COACH_INVALID', errors: { coach: 'The saved coach settings are not valid. Nothing was changed.' } };
        var next = mutate(rc.coach ? rc.coach : HC.emptyCoach());
        if (next && next.ok === false) return { ok: false, errors: { coach: next.error } };
        var errs = HC.validateCoach(next);
        if (errs.length) return { ok: false, errors: { coach: errs.join('; ') } };
        rec[HC.FIELD] = next;
        return null;
      }, { expectStamp: stamp });
    } catch (e) { r = { ok: false, errors: { _: 'Unexpected error.' } }; }
    dropReadMemo();
    if (r.ok) { coachSay(okText + ' Saved on this device (verified by read-back).', false); toast(okText + ' Saved on this device (verified by read-back).'); extSaved(); }
    else { coachSay('Not saved: ' + errorsText(r.errors) + ' Nothing was changed.', true); toast('Not saved: ' + errorsText(r.errors) + ' Nothing was changed.', true); }
    refresh(); renderSettings();
    return r;
  }
  function kcalText(v) { return v === null || v === undefined ? '—' : n0(v) + ' kcal'; }
  function gText(v) { return v === null || v === undefined ? '—' : n0(v) + ' g'; }
  function targetLine(t) {
    if (!t) return 'none';
    return kcalText(t.kcal) + ' · protein ' + gText(t.proteinG) + (t.origin === 'PROVISIONAL' ? ' (floor ' + gText(t.proteinFloorG) + ')' : '') + ' · fat ' + gText(t.fatG) + ' · carbs ' + gText(t.carbsG);
  }
  var ORIGIN_TEXT = { PROVISIONAL: 'provisional reference (not an individual prescription)', COMPUTED: 'computed starting estimate, confirmed by you', OWNER_ENTERED: 'entered by you' };
  function coachCard() {
    var c = card('Nutrition Coach', 'coach-card');
    if (!HC || !HB) { var un = coachRead().unavailable; c.appendChild(h('p', { class: un ? 'note note-warn' : 'hint', testid: 'coach-unavailable', 'data-state': un ? 'LOAD_ERROR' : 'NOT_LOADED', text: un
      ? 'UNAVAILABLE — load error: the Nutrition Coach part of the app did not load. Your saved coach settings and targets are kept unchanged, but they cannot be shown or used now, and nothing can be changed here. Reload the page.'
      : 'The coach is not available in this copy of the app.' })); return c; }
    var td = today(), rc = coachRead(), stamp = HB.settingsStamp(store);
    var badSet = damaged().filter(function (d) { return d.collection === 'ownerSettings'; })[0] || null;
    c.appendChild(h('p', { class: 'note', testid: 'coach-notice', text: 'Estimates only, not medical advice. Talk to a clinician before a large deficit, a goal faster than 1 lb a week, or if you have a medical condition or take medication. The coach uses local arithmetic only: no AI, no network.' }));
    if (coachUi.msg) c.appendChild(h('p', { class: coachUi.bad ? 'form-error' : 'hint closeout-ok', testid: 'coach-msg', role: 'status', 'aria-live': 'polite', text: coachUi.msg }));
    if (badSet) { c.appendChild(h('p', { class: 'note note-warn', testid: 'coach-settings-damaged', text: 'Your saved settings need attention first (see above). The coach shows nothing and proposes nothing until then. Nothing was changed.' })); return c; }
    if (!rc.valid) {
      c.appendChild(h('div', { class: 'note note-warn', testid: 'coach-invalid' }, h('p', { text: 'The saved coach settings are not valid (' + rc.problems.slice(0, 3).join('; ') + '). The coach shows nothing and proposes nothing; your other settings, plan blocks and saved foods are not affected. Nothing was changed.' }),
        h('button', { type: 'button', class: 'btn btn-small btn-delete', text: 'Reset coach settings only', testid: 'coach-reset', onclick: function () {
          if (!window.confirm('Remove the saved coach settings (profile, goal, targets and their history)? Everything else is kept. Export a backup first if you want a copy.')) return;
          dropReadMemo();
          var r; try { r = HB.writeSettings(store, HD, today(), function (rec) { delete rec[HC.FIELD]; return null; }, { expectStamp: stamp }); } catch (e) { r = { ok: false, errors: { _: 'Unexpected error.' } }; }
          dropReadMemo(); coachSay(r.ok ? 'Coach settings removed. Everything else was kept.' : 'Not saved: ' + errorsText(r.errors) + ' Nothing was changed.', !r.ok); refresh(); renderSettings();
        } })));
      return c;
    }
    var co = rc.coach || HC.emptyCoach(), on = co.enabled === true, p = co.profile || {};
    c.appendChild(h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn btn-small ' + (on ? 'btn-primary' : 'btn-secondary'), testid: 'coach-toggle', 'aria-pressed': on ? 'true' : 'false',
      text: on ? 'Coach: On' : 'Coach: Off', onclick: function () { coachWrite(function (x) { x.enabled = !on; return x; }, stamp, on ? 'Coach switched off.' : 'Coach switched on.'); } })));
    c.appendChild(h('p', { class: 'hint', testid: 'coach-onoff-note', text: on ? 'On: Home shows one coaching status line; Trends shows the weekly review; your confirmed target is used as the reference.' : 'Off: nothing changes anywhere; every screen keeps the provisional ' + n0(HN.PROVISIONAL.kcal) + ' kcal / ' + HN.PROVISIONAL.proteinG + ' g reference.' }));

    // ---- Profile (collapsed by default) ----
    var det = h('details', { class: 'coach-profile', testid: 'coach-profile', open: coachUi.profileOpen ? true : null });
    det.addEventListener('toggle', function () { coachUi.profileOpen = det.open; });
    det.appendChild(h('summary', { testid: 'coach-profile-summary', text: 'Profile' + (p.heightCm || p.ageYears ? '' : ' (not set)') }));
    var unit = coachUi.unit || p.heightUnit || 'cm';
    var seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Height unit' });
    [['cm', 'cm'], ['ftin', 'ft / in']].forEach(function (u) { seg.appendChild(h('button', { type: 'button', class: 'seg' + (unit === u[0] ? ' active' : ''), 'aria-pressed': unit === u[0] ? 'true' : 'false', text: u[1], testid: 'coach-height-unit-' + u[0],
      onclick: function () { coachUi.unit = u[0]; coachUi.profileOpen = true; renderSettings(); } })); });
    det.appendChild(seg);
    var fi = HC.cmToFtIn(p.heightCm);
    var hcm = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', maxlength: '6', testid: 'coach-height-cm', value: p.heightCm != null ? String(p.heightCm) : '', placeholder: 'cm' });
    var hft = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '1', testid: 'coach-height-ft', value: fi ? String(fi.ft) : '', placeholder: 'ft' });
    var hin = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', maxlength: '4', testid: 'coach-height-in', value: fi ? String(fi.inch) : '', placeholder: 'in' });
    if (unit === 'cm') det.appendChild(field('Height (cm)', hcm));
    else det.appendChild(h('div', { class: 'field coach-ftin' }, h('span', { class: 'meal-cat-label', text: 'Height (feet and inches)' }), h('label', { class: 'visually-hidden', for: 'coach-ft', text: 'feet' }), hft, h('span', { text: ' ft ' }), hin, h('span', { text: ' in' })));
    hft.id = 'coach-ft'; hin.setAttribute('aria-label', 'inches');
    var age = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '3', testid: 'coach-age', value: p.ageYears != null ? String(p.ageYears) : '', placeholder: 'years' });
    var as = HC.ageStatus(p, td);
    det.appendChild(field('Age (years)', age, p.ageYears != null ? 'Last confirmed ' + fmtDate(as.confirmedOn) + '. No date of birth is stored; you will be asked to confirm your age once a year.' : 'Whole years. No date of birth is collected.'));
    var ageOk = null;
    if (as.needsConfirm) { ageOk = h('input', { type: 'checkbox', testid: 'coach-age-confirm' }); det.appendChild(h('div', { class: 'note note-warn', testid: 'coach-age-due' }, h('p', { text: 'Your age was last confirmed on ' + fmtDate(as.confirmedOn) + '. Check it and update it if needed; the starting estimate waits until you confirm.' }), h('label', { class: 'check' }, ageOk, h('span', { text: 'My age above is correct today' })))); }
    var method = p.estimateMethod === 'EQUATION' ? 'EQUATION' : 'NONE';
    var mEq = h('input', { type: 'radio', name: 'coach-method', value: 'EQUATION', testid: 'coach-method-equation', checked: method === 'EQUATION' });
    var mNo = h('input', { type: 'radio', name: 'coach-method', value: 'NONE', testid: 'coach-method-none', checked: method === 'NONE' });
    det.appendChild(h('fieldset', { class: 'coach-fs' }, h('legend', { text: 'Starting estimate' }),
      h('label', { class: 'check' }, mEq, h('span', { text: 'Use the equation-based starting estimate (needs the sex used by the equation)' })),
      h('label', { class: 'check' }, mNo, h('span', { text: 'No computed estimate — I will enter my own target' }))));
    var sexBox = h('fieldset', { class: 'coach-fs', testid: 'coach-sex' }, h('legend', { text: 'Sex used by the equation' }));
    var sM = h('input', { type: 'radio', name: 'coach-sex', value: 'MALE', testid: 'coach-sex-male', checked: p.sexForEquation === 'MALE' });
    var sF = h('input', { type: 'radio', name: 'coach-sex', value: 'FEMALE', testid: 'coach-sex-female', checked: p.sexForEquation === 'FEMALE' });
    sexBox.appendChild(h('label', { class: 'check' }, sM, h('span', { text: 'Male' })));
    sexBox.appendChild(h('label', { class: 'check' }, sF, h('span', { text: 'Female' })));
    sexBox.appendChild(h('p', { class: 'hint', text: 'Why? The Mifflin–St Jeor equation has a different constant for men and women. It is asked only for this estimate, never guessed, and not shown anywhere else.' }));
    sexBox.hidden = method !== 'EQUATION';
    [mEq, mNo].forEach(function (r) { r.addEventListener('change', function () { sexBox.hidden = !mEq.checked; }); });
    det.appendChild(sexBox);
    var act = select([['', 'Choose…']].concat(HC.ACTIVITY.map(function (a) { return [a.id, a.label]; })), p.activity || '', { testid: 'coach-activity' });
    det.appendChild(field('Usual activity (for the starting estimate only)', act, 'A plain assumption, not a measurement. It already includes your training and steps: workouts, steps and Garmin minutes are never added on top.'));
    var perr = h('p', { class: 'form-error', testid: 'coach-profile-error', 'aria-live': 'polite' });
    det.appendChild(perr);
    det.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-small', text: 'Save profile', testid: 'coach-profile-save', onclick: function () {
      var pr = HC.parseProfile({ heightUnit: unit, heightCm: hcm.value, heightFt: hft.value, heightIn: hin.value, ageYears: age.value, confirmAge: !!(ageOk && ageOk.checked),
        estimateMethod: mEq.checked ? 'EQUATION' : 'NONE', sexForEquation: sM.checked ? 'MALE' : sF.checked ? 'FEMALE' : null, activity: act.value }, today(), p);
      if (!pr.ok) { perr.textContent = 'Not saved: ' + Object.keys(pr.errors).map(function (k) { return pr.errors[k]; }).join(' ') + ' Nothing was changed.'; return; }
      coachUi.profileOpen = true; coachUi.unit = null;
      coachWrite(function (x) { x.profile = pr.profile; return x; }, stamp, 'Profile saved.');
    } }));
    c.appendChild(det);

    // ---- Goal ----
    var gfs = h('fieldset', { class: 'coach-fs', testid: 'coach-goal' }, h('legend', { text: 'Goal' }));
    HC.GOALS.forEach(function (g) {
      var on2 = co.goal && co.goal.id === g.id;
      gfs.appendChild(h('label', { class: 'check' }, h('input', { type: 'radio', name: 'coach-goal', value: g.id, testid: 'coach-goal-' + g.id.toLowerCase(), checked: on2,
        onchange: function () { coachWrite(function (x) { x.goal = { id: g.id, setAt: today() }; return x; }, stamp, 'Goal set: ' + g.label.toLowerCase() + '.'); } }),
        h('span', { text: g.label + (g.note ? ' — ' + g.note : '') })));
    });
    gfs.appendChild(h('p', { class: 'hint', text: 'A goal is a preference, not a promise. The coach never changes your target by itself and never promises a rate.' }));
    c.appendChild(gfs);

    // ---- Current reference, computed estimate (Delivery C), own target, confirm ----
    var cur = HC.targetFor(co, td, HN.PROVISIONAL);
    var refBox = h('div', { class: 'note', testid: 'coach-current' }, h('p', { testid: 'coach-current-line', text: 'In use today: ' + targetLine(on ? cur : HC.targetFor(null, td, HN.PROVISIONAL)) }),
      h('p', { class: 'hint', testid: 'coach-current-origin', text: on ? (ORIGIN_TEXT[cur.origin] || cur.origin) + (cur.effectiveDate ? ' · since ' + fmtDate(cur.effectiveDate) : '') : 'Coach off: the provisional reference is used everywhere.' }));
    if (co.target && co.target.effectiveDate > td) refBox.appendChild(h('p', { class: 'hint', testid: 'coach-upcoming', text: 'Confirmed for ' + fmtDate(co.target.effectiveDate) + ': ' + targetLine(co.target) + '.' }));
    c.appendChild(refBox);
    if (coachUi.mode === 'confirm' && coachUi.pending) { c.appendChild(coachConfirmScreen(co, cur, stamp)); return c; }
    if (typeof coachEstimateBlock === 'function') { var eb = coachEstimateBlock(co, cur, stamp); if (eb) c.appendChild(eb); }
    c.appendChild(coachOwnTargetForm(co, cur));
    c.appendChild(coachHistory(co));
    c.appendChild(h('details', { class: 'coach-gates', testid: 'coach-gates' }, h('summary', { text: 'Open gates (numbers still provisional)' }),
      h('ul', { class: 'entry-list' }, HC.OPEN_GATES.map(function (g) { return h('li', { testid: 'coach-gate', 'data-gate': g.id, text: g.id + ': ' + g.text }); }))));
    return c;
  }
  // "Enter my own target": checked on the spot; errors block, warnings are shown and kept with the confirmed target.
  function coachOwnTargetForm(co, cur) {
    var box = h('details', { class: 'coach-own', testid: 'coach-own', open: coachUi.mode === 'own' ? true : null });
    box.addEventListener('toggle', function () { if (box.open) coachUi.mode = 'own'; else if (coachUi.mode === 'own') coachUi.mode = null; });
    box.appendChild(h('summary', { text: 'Enter my own target' }));
    function inp(tid, ph) { return h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '5', testid: tid, placeholder: ph }); }
    var k = inp('coach-own-kcal', 'kcal'), pr = inp('coach-own-protein', 'g'), ft = inp('coach-own-fat', 'g (optional)'), cb = inp('coach-own-carbs', 'g (optional)');
    box.appendChild(field('Calories per day', k)); box.appendChild(field('Protein (g)', pr)); box.appendChild(field('Fat (g)', ft)); box.appendChild(field('Carbs (g)', cb));
    var err = h('p', { class: 'form-error', testid: 'coach-own-error', 'aria-live': 'polite' });
    box.appendChild(err);
    box.appendChild(h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Review this target', testid: 'coach-own-review', onclick: function () {
      var est = typeof coachEstimateNow === 'function' ? coachEstimateNow(co) : null;
      var chk = HC.checkOwnerTarget({ kcal: k.value, proteinG: pr.value, fatG: ft.value, carbsG: cb.value }, { restingKcal: est && est.ok ? est.resting : null, sex: co.profile ? co.profile.sexForEquation : null, currentKcal: cur.kcal });
      if (!chk.ok) { err.textContent = 'Not ready: ' + chk.errors.join(' ') + ' Nothing was changed.'; return; }
      coachUi.mode = 'confirm';
      coachUi.pending = { target: chk.target, origin: 'OWNER_ENTERED', warnings: chk.warnings, inputs: null, reason: 'Entered by me' };
      renderSettings(); focusTestid('coach-confirm-title');
    } }));
    return box;
  }
  function coachConfirmScreen(co, cur, stamp) {
    var pd = coachUi.pending, t = pd.target, td = today();
    var box = h('section', { class: 'note coach-confirm', testid: 'coach-confirm', 'aria-labelledby': 'coach-confirm-title' });
    box.appendChild(h('h3', { id: 'coach-confirm-title', tabindex: '-1', testid: 'coach-confirm-title', text: 'Confirm a new target' }));
    box.appendChild(h('p', { testid: 'coach-confirm-old', text: 'Now: ' + targetLine(cur) + ' (' + (ORIGIN_TEXT[cur.origin] || cur.origin) + ')' }));
    box.appendChild(h('p', { testid: 'coach-confirm-new', text: 'New: ' + targetLine(t) + ' (' + (pd.origin === 'COMPUTED' ? 'computed starting estimate' : 'entered by you') + ')' }));
    var remain = t.fatG !== null && t.carbsG === null ? Math.floor((t.kcal - 4 * t.proteinG - 9 * t.fatG) / 4) : null;
    box.appendChild(h('p', { class: 'hint', testid: 'coach-confirm-arith', text: 'Arithmetic: protein ' + n0(4 * t.proteinG) + ' kcal' + (t.fatG !== null ? ' + fat ' + n0(9 * t.fatG) + ' kcal' : '') + (t.carbsG !== null ? ' + carbs ' + n0(4 * t.carbsG) + ' kcal' : '') + ' = ' + n0(HC.macroKcal(t)) + ' of ' + n0(t.kcal) + ' kcal' + (remain !== null ? '; carbs from the remainder: about ' + remain + ' g' : '') + '.' }));
    if (pd.inputs) box.appendChild(h('p', { class: 'hint', testid: 'coach-confirm-inputs', text: pd.inputsText || '' }));
    (pd.warnings || []).forEach(function (w) { box.appendChild(h('p', { class: 'note note-warn', testid: 'coach-confirm-warning', 'data-code': w.code, text: w.text })); });
    var eff = h('input', { type: 'date', value: td, min: td, max: HC.addDays(td, 14), testid: 'coach-confirm-date' });
    box.appendChild(field('Effective from', eff, 'Today or up to 14 days ahead. Earlier days keep the reference that applied then.'));
    var why = h('input', { type: 'text', maxlength: '200', value: pd.reason || '', testid: 'coach-confirm-reason' });
    box.appendChild(field('Reason (kept with the history)', why));
    var err = h('p', { class: 'form-error', testid: 'coach-confirm-error', 'aria-live': 'polite' });
    box.appendChild(err);
    box.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn btn-primary btn-small', text: 'Confirm target', testid: 'coach-confirm-ok', onclick: function () {
        var now = today();
        if (now !== td) { err.textContent = 'The date changed at midnight (Asia/Qatar). Review again. Nothing was saved.'; coachUi.mode = null; coachUi.pending = null; renderSettings(); return; }
        var effDate = eff.value;
        var done = coachWrite(function (x) {
          var prev = HC.targetFor(x, now, HN.PROVISIONAL);
          var r = HC.confirmTarget(x, t, { today: now, nowIso: nowIso(), effectiveDate: effDate, origin: pd.origin, method: pd.method, reason: why.value, inputs: pd.inputs, warnings: pd.warnings, previous: prev });
          return r.ok ? r.coach : { ok: false, error: r.error };
        }, stamp, 'Target confirmed from ' + (HC.isIsoDate(effDate) ? fmtDate(effDate) : effDate) + '.');
        if (done.ok) { coachUi.mode = null; coachUi.pending = null; renderSettings(); }
      } }),
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Cancel', testid: 'coach-confirm-cancel', onclick: function () { coachUi.mode = null; coachUi.pending = null; coachSay('Cancelled. Nothing was changed.', false); renderSettings(); } })));
    return box;
  }
  function coachHistory(co) {
    var list = (co.history || []).slice().reverse();
    var box = h('details', { class: 'coach-history', testid: 'coach-history' }, h('summary', { text: 'Target history (' + list.length + ')' }));
    if (!list.length) box.appendChild(h('p', { class: 'hint', text: 'No confirmed targets yet. The provisional ' + n0(HN.PROVISIONAL.kcal) + ' kcal / ' + HN.PROVISIONAL.proteinG + ' g reference stays in force.' }));
    list.forEach(function (t) {
      box.appendChild(h('div', { class: 'entry', testid: 'coach-history-entry' }, h('div', { class: 'entry-body' },
        h('div', { class: 'entry-title', text: 'From ' + fmtDate(t.effectiveDate) + ': ' + targetLine(t) }),
        h('div', { class: 'entry-meta', text: (t.origin === 'COMPUTED' ? 'Computed starting estimate' : 'Entered by you') + ' · confirmed ' + qatarTime(t.confirmedAt) + (t.replaced ? ' · replaced ' + targetLine(t.replaced) : '') + (t.reason ? ' · ' + t.reason : '') + (t.warnings && t.warnings.length ? ' · warnings: ' + t.warnings.join(', ') : '') }))));
    });
    return box;
  }
  function ownerSettingsCard() {
    var set = settings();
    var c = card('My baselines', 'owner-settings');
    var err = h('p', { class: 'form-error', testid: 'owner-settings-error', 'aria-live': 'polite' });
    var rhr = numIn(set.rhrBaselineBpm, { min: '25', max: '220', step: '1', testid: 'set-rhr-baseline' });
    c.appendChild(field('Resting heart-rate baseline (bpm)', rhr, set.rhrBaselineSource === 'OWNER_SET' ? 'Set by you.' : 'Owner default 76 bpm (decided 11 Nov 2026) — not yet changed.'));
    var ob = HW.rhrBaseline(today(), recs('daily'));
    c.appendChild(h('p', { class: 'hint', testid: 'set-rhr-observed', text: 'For comparison only — observed mean of your last 7 days: ' + (ob.valid ? ob.value + ' bpm from ' + ob.n + ' readings' : 'not available (' + ob.n + ' of 4 readings needed)') + '. It never replaces your configured baseline. A reading 7+ bpm above either is flagged; this is information, not a diagnosis.' }));
    var mode = select([['AUTO', 'Automatic — median of my recorded daily totals (last 14 days)'], ['MANUAL', 'Manual — I set the number']], set.stepBaselineMode, { testid: 'set-step-mode' });
    var manual = numIn(set.stepBaselineManual, { step: '100', testid: 'set-step-manual', placeholder: 'steps per day' });
    var manualField = field('Manual step baseline (steps/day)', manual);
    manualField.hidden = mode.value !== 'MANUAL';
    mode.addEventListener('change', function () { manualField.hidden = mode.value !== 'MANUAL'; });
    c.appendChild(field('Daily step baseline', mode));
    c.appendChild(manualField);
    var auto = HW.stepBaseline(today(), recs('daily'), { stepBaselineMode: 'AUTO' });
    c.appendChild(h('p', { class: 'hint', testid: 'set-step-auto', text: 'Automatic baseline right now: ' + (auto.value === null ? 'not available. ' + auto.reason : auto.value.toLocaleString('en-US') + ' steps (median of ' + auto.n + ' recorded days; missing days are left out, not counted as 0).') +
      ' Guidance target = baseline, +10% on light days, −15% after a demanding session, −30% when soreness, pain or low readiness is recorded. These percentages and the 3-of-14-days rule are unapproved app suggestions, NOT part of plan v2.1; you can override any day on Today. The plan reference goal (v2.1 §6: W1 7,000, W2 8,000, W3 9,000, W4 up to 10,000 if tolerated) is shown separately on Today.' }));
    // If the saved settings record itself has an invalid value, the app falls back to the defaults
    // shown here. Saving replaces that record, which needs the owner's approval.
    var badSet = damaged().filter(function (d) { return d.collection === 'ownerSettings'; })[0] || null, approveSet = null;
    // Claude 11.2 review (C-01): replacing a damaged settings record must not delete the owner's saved foods and
    // favourites, which live in the same record (the Add foods screen sends the owner here to fix it).
    var keptFoods = badSet ? rawSettingsFoodLists() : null;
    // Phase 12: the same repair also keeps every other valid field of that record (plan blocks, later-version fields).
    var OWN_FIELDS = ['rhrBaselineBpm', 'stepBaselineMode', 'stepBaselineManual', 'rhrBaselineSource', 'myFoods', 'favFoods'];
    var carry = badSet && HB ? HB.repairCarry(rawSettingsRecord(), (badSet.problems || []).map(function (p) { return p.field; }), OWN_FIELDS, HD, today()) : { carry: {}, dropped: [] };
    if (badSet) {
      approveSet = h('input', { type: 'checkbox', testid: 'set-approve-correction' });
      var keptText = keptFoods && (keptFoods.myFoods.length || keptFoods.favFoods.length)
        ? ' Your ' + keptFoods.myFoods.length + (keptFoods.myFoods.length === 1 ? ' saved food' : ' saved foods') + ' and ' + keptFoods.favFoods.length + (keptFoods.favFoods.length === 1 ? ' favourite' : ' favourites') + ' are kept.' : '';
      if (carry.carry.planBlocks !== undefined) keptText += ' Your training plan blocks are kept.';
      if (carry.carry.nutritionCoach !== undefined) keptText += ' Your Nutrition Coach profile and targets are kept.'; // P1.3
      c.appendChild(h('div', { class: 'note note-warn', testid: 'owner-settings-damaged', role: 'status' },
        h('p', { text: 'Your saved settings have a value that is not valid (' + problemsText(badSet.problems) + '), so the defaults above are in use. Nothing was changed.' }),
        h('label', { class: 'check' }, approveSet, h('span', { text: 'Replace the saved settings with the values shown here.' + keptText }))));
    }
    c.appendChild(err);
    c.appendChild(h('button', { type: 'button', class: 'btn btn-primary', text: 'Save my baselines', testid: 'set-save', onclick: function () {
      var r = numOrNull(rhr.value), m = numOrNull(manual.value);
      if (r === null || isNaN(r)) { err.textContent = 'Not saved: enter a resting heart-rate baseline in bpm.'; return; }
      if (mode.value === 'MANUAL' && (m === null || isNaN(m))) { err.textContent = 'Not saved: enter a manual step baseline, or choose Automatic.'; return; }
      // Phase 12: re-read the stored record at save time (never the copy shown when this screen was drawn), so a change
      // made meanwhile (another tab, Add foods, the Block 2 planner) is kept. Only the baseline fields change here.
      var fresh = badSet ? null : settings().record;
      var rec = fresh ? JSON.parse(JSON.stringify(fresh)) : { id: HD.SETTINGS_ID };
      if (badSet) Object.keys(carry.carry).forEach(function (k) { rec[k] = carry.carry[k]; });
      rec.date = today(); rec.rhrBaselineBpm = r; rec.stepBaselineMode = mode.value; rec.stepBaselineManual = mode.value === 'MANUAL' ? m : (typeof rec.stepBaselineManual === 'number' ? rec.stepBaselineManual : null);
      if (badSet && !(approveSet && approveSet.checked)) { err.textContent = 'Not saved: tick "Replace the saved settings…" to approve replacing the invalid saved settings. Nothing was changed.'; return; }
      if (badSet && keptFoods) { if (keptFoods.myFoods.length) rec.myFoods = keptFoods.myFoods; if (keptFoods.favFoods.length) rec.favFoods = keptFoods.favFoods; }
      var res = persist('ownerSettings', rec, err, badSet ? { approveCorrection: true } : undefined);
      if (res.ok) renderSettings();
    } }));
    return c;
  }

  // P0: which build is this? Read from the page's own <meta> tags (stamped when the deploy package is assembled).
  // It names the files this page loaded. It does not look anywhere else, so it never claims to be the newest release.
  function buildInfo() {
    function meta(n) { var m = document.querySelector('meta[name="' + n + '"]'); return m ? String(m.getAttribute('content') || '').trim() : ''; }
    var id = meta('hyrox-build-id'), rel = meta('hyrox-release'), date = meta('hyrox-build-date');
    return { release: rel || null, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null, id: /^[0-9a-f]{12}$/.test(id) ? id : null, packaged: /^[0-9a-f]{12}$/.test(id) };
  }
  function buildCard() {
    var b = buildInfo(), c = card('About this build', 'build-card');
    c.appendChild(h('p', { testid: 'build-label', text: b.packaged
      ? 'Build ' + (b.release || 'unnamed') + ' · source ' + b.id + ' · built ' + (b.date ? fmtDate(b.date) : 'date not recorded')
      : 'Development copy' + (b.release ? ' of ' + b.release : '') + ' (not a packaged build — no source id).' }));
    c.appendChild(h('p', { class: 'hint', testid: 'build-note', text: 'This identifies the files this page is running. Compare the source id with the release checksum file. It does not check whether a newer build exists.' }));
    return c;
  }

  // ================= Sprint D (P1.4): Export for AI Coaching (HNC-E-COACH-001) =================
  // Manual, read-only snapshot built on this phone from one read of storage; handed to the iOS share sheet as a file, or
  // downloaded when file sharing is not available. No network request, no stored state (nothing remembered between visits),
  // no change to hyrox.v1, the backup format or any key. The app can never know whether the file reached Drive.
  var HCE = window.HyroxCoachExport || null;
  function ceNow() { try { return performance.now(); } catch (e) { return Date.now(); } } // monotonic: the tap guard ignores wall-clock changes
  var ce = null;
  function ceState() {
    if (!ce) ce = { preset: 14, from: null, to: null, sel: HCE ? HCE.normSelection(null) : {}, snap: null, status: null, lockUntil: 0 };
    return ce;
  }
  function ceRange(st) {
    var t = today();
    if (st.preset !== 'custom') return HCE.presetRange(st.preset, t);
    return { from: st.from || t, to: st.to || t };
  }
  function cePlanned(rg) {
    var sessions = recs('sessions'), events = recs('planEvents'), planned = [], none = [];
    var act = HB ? HB.activated(blocks()) : [];
    function nextDay(x) { var t = new Date(x + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); }
    for (var d = rg.from; d <= rg.to; d = nextDay(d)) {
      var slots = [];
      var s1 = HP.slotForDate(d); if (s1) slots.push(s1);
      act.forEach(function (b) { HB.effectiveSlots(b).forEach(function (s) { if (s.date === d) slots.push(s); }); });
      slots.forEach(function (sl) {
        var stt = PL.slotStatus(sl.id, sessions, events) || {};
        planned.push({ slotId: sl.id, blockId: sl.blockId || null, planVersion: sl.planVersion || null, date: sl.date, week: sl.week, day: sl.day || null, type: sl.type || null, title: sl.title || null,
          durationMinPlanned: typeof sl.durationMin === 'number' ? sl.durationMin : null, prescription: Array.isArray(sl.prescription) ? sl.prescription.slice() : [],
          slotStatus: stt.code || 'NOT_LOGGED', linkedSessionIds: sessions.filter(function (x) { return x.planSlotId === sl.id; }).map(function (x) { return x.id; }).sort() });
      });
      var b1 = HP.blockStatus(d), b2 = HB ? HB.blockStatus(d, blocks()) : null;
      if (!slots.length && !(b1 && b1.active) && !(b2 && b2.active)) none.push(d);
      if (none.length + planned.length > 2000) break;
    }
    return { planned: planned, none: none };
  }
  function ceBuild(st, now, rand) {
    var rg = ceRange(st);
    var chk = HCE.checkRange(rg.from, rg.to, today());
    if (!chk.ok) return { ok: false, code: chk.code, message: chk.message };
    var pl = st.sel.training ? cePlanned(rg) : { planned: [], none: [] };
    var b = null; try { b = buildInfo(); } catch (e) { b = null; }
    var input = HCE.collect(store, { HD: HD, HN: HN, HC: HC, to: rg.to, planned: pl.planned, noActivePlanDates: pl.none, appBuild: b && b.packaged ? (b.release || '') + ' ' + b.id : null });
    return HCE.build(input, { from: rg.from, to: rg.to, selection: st.sel, now: now || new Date(), rand: rand });
  }
  function ceDownload(text, name) {
    var blob = new Blob([text], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click();
    setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) { /* */ } }, 1000);
  }
  function ceRedraw() { var old = document.querySelector('[data-testid="coach-export"]'); if (old) old.replaceWith(coachExportCard()); }
  function ceHandOver(mode) {
    var st = ceState(), snap = st.snap; if (!snap) return;
    var file = null;
    try { file = new File([snap.text], snap.fileName, { type: 'application/json' }); } catch (e) { file = null; }
    var can = false;
    if (mode !== 'download' && file && navigator.share && navigator.canShare) { try { can = navigator.canShare({ files: [file] }) === true; } catch (e) { can = false; } }
    if (can) {
      st.status = { kind: 'sharing' }; ceRedraw();
      var p; try { p = navigator.share({ files: [file], title: snap.fileName }); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function () { if (ce === st) { st.status = { kind: 'handed' }; ceRedraw(); } },
        function (e) { if (ce !== st) return; st.status = e && e.name === 'AbortError' ? { kind: 'cancelled' } : { kind: 'error', reason: (e && (e.name || e.message)) || 'unknown error' }; ceRedraw(); });
      return;
    }
    try { ceDownload(snap.text, snap.fileName); st.status = { kind: mode === 'download' ? 'downloaded' : 'fallback' }; }
    catch (e) { st.status = { kind: 'error', reason: (e && e.message) || 'unknown error' }; }
    ceRedraw();
  }
  // Claude QA of P1.4-RC2: can this device hand THIS file to the share sheet? (checked the same way ceHandOver does)
  function ceCanShare(snap) {
    try { var f = new File([snap.text], snap.fileName, { type: 'application/json' }); return !!(navigator.share && navigator.canShare) && navigator.canShare({ files: [f] }) === true; } catch (e) { return false; }
  }
  var CE_TEXT = {
    sharing: 'Opening the iPhone share sheet…',
    handed: 'Handed to the iPhone share sheet. This app cannot see where the file went or whether it arrived. Open Drive and check that the file is there.',
    cancelled: 'Share cancelled. Nothing was sent. Your snapshot is still ready: Share again, Download instead, or Discard.',
    // (the cancelled state only exists where sharing is possible, so its wording still matches the buttons)
    fallback: 'Sharing a file is not available here, so the file was sent to Downloads. Move it to your Drive folder yourself.',
    downloaded: 'Download started. Move the file to your private Drive folder yourself.'
  };
  function coachExportCard() {
    var c = card('Export for AI Coaching', 'coach-export');
    if (!HCE) { c.appendChild(h('p', { class: 'note note-warn', testid: 'ce-unavailable', text: 'Not available: this part of the app did not load. Nothing was changed. Reload the page.' })); return c; }
    var st = ceState();
    c.appendChild(h('p', { class: 'hint', testid: 'ce-standing', text: 'A manual, read-only snapshot of the data you choose, for a coaching chat. It is not a backup and cannot be restored. A snapshot is a copy from the moment you create it. It does not update. Create a new one before each coaching request.' }));
    if (st.snap) {
      var res = h('div', { class: 'note', testid: 'ce-result', role: 'status', 'aria-live': 'polite' });
      res.appendChild(h('p', { testid: 'ce-ready', text: 'Snapshot ready: ' + st.snap.days + ' days, ' + st.snap.categories + ' categories, ' + st.snap.total + ' records. File: ' + st.snap.fileName }));
      if (st.status && st.status.kind === 'error') res.appendChild(h('p', { class: 'form-error', testid: 'ce-status', 'data-kind': 'error', text: 'Could not hand over the file: ' + st.status.reason + '. Nothing was changed. Try Download instead.' }));
      else if (st.status) res.appendChild(h('p', { testid: 'ce-status', 'data-kind': st.status.kind, text: CE_TEXT[st.status.kind] }));
      res.appendChild(h('p', { class: 'hint', testid: 'ce-privacy', text: 'This file contains health and fitness data. Keep it in a private folder. Do not create a sharing link.' }));
      res.appendChild(h('p', { class: 'hint', testid: 'ce-next', text: 'Next: 1) open Drive and check the file is there; 2) in ChatGPT, give it the file link; 3) ask it to report the date, range, categories and counts before any advice.' }));
      var guard = function (fn) { return function () { if (ceNow() < st.lockUntil || (st.status && st.status.kind === 'sharing')) return; st.lockUntil = ceNow() + 700; fn(); }; };
      // Claude QA of P1.4-RC2: "Share again" was offered even where sharing a file is not possible (it then downloaded again).
      // Where the share sheet cannot take the file, the only hand-over is a download, and the button says so.
      var canShare = ceCanShare(st.snap);
      res.appendChild(h('div', { class: 'btn-row' },
        canShare ? h('button', { type: 'button', class: 'btn btn-secondary', text: 'Share again', testid: 'ce-share', onclick: guard(function () { ceHandOver('share'); }) }) : null,
        h('button', { type: 'button', class: 'btn btn-secondary', text: canShare ? 'Download instead' : 'Download again', testid: 'ce-download', onclick: guard(function () { ceHandOver('download'); }) }),
        h('button', { type: 'button', class: 'btn btn-secondary', text: 'Discard', testid: 'ce-discard', onclick: guard(function () { st.snap = null; st.status = null; ceRedraw(); }) })));
      c.appendChild(res);
      return c;
    }
    var rsel = select([['7', 'Last 7 days'], ['14', 'Last 14 days'], ['28', 'Last 28 days'], ['custom', 'Custom dates']], String(st.preset), { testid: 'ce-range', 'aria-label': 'Date range',
      onchange: function () { st.preset = this.value === 'custom' ? 'custom' : Number(this.value); if (st.preset === 'custom' && !st.from) { var r = HCE.presetRange(14, today()); st.from = r.from; st.to = r.to; } ceRedraw(); } });
    c.appendChild(field('Date range (Asia/Qatar dates)', rsel));
    if (st.preset === 'custom') {
      c.appendChild(field('From', h('input', { type: 'date', value: st.from, max: today(), testid: 'ce-from', onchange: function () { st.from = this.value; ceRedraw(); } })));
      c.appendChild(field('To', h('input', { type: 'date', value: st.to, max: today(), testid: 'ce-to', onchange: function () { st.to = this.value; ceRedraw(); } })));
    }
    var cats = h('fieldset', { class: 'ce-cats', testid: 'ce-cats' }, h('legend', { text: 'What to include' }));
    HCE.CATEGORIES.forEach(function (k) {
      var box = h('input', { type: 'checkbox', testid: 'ce-cat-' + k, onchange: function () { st.sel[k] = this.checked; ceRedraw(); } }); box.checked = !!st.sel[k];
      cats.appendChild(h('label', { class: 'check' }, box, h('span', { text: HCE.LABELS[k] + (HCE.DEFAULTS[k] ? '' : ' (off unless you choose it)') })));
    });
    c.appendChild(cats);
    // Claude QA of P1.4-RC2: with "Free-text notes" off, the short names the owner typed still go out with their category.
    c.appendChild(h('p', { class: 'hint', testid: 'ce-names-note', text: 'A shared category always includes its names as you typed them: food names, workout and session titles, exercise names. "Free-text notes" adds the longer notes, meal descriptions and portions.' }));
    if (st.sel.freeText) c.appendChild(h('p', { class: 'note note-warn', testid: 'ce-freetext-warning', text: 'Notes can contain anything you typed. Review before sharing.' }));
    // Preview: the same build as "Create", nothing is kept or handed over.
    var pv = ceBuild(st, new Date(), function () { return 0; });
    var prev = h('p', { class: 'hint', testid: 'ce-preview', 'aria-live': 'polite' });
    if (pv.ok) {
      var inc = HCE.CATEGORIES.filter(function (k) { return k !== 'freeText' && st.sel[k] && k !== 'goals'; }).map(function (k) { return HCE.LABELS[k] + ' ' + (pv.counts[k] || 0); });
      if (st.sel.goals) inc.push(HCE.LABELS.goals);
      var out = HCE.CATEGORIES.filter(function (k) { return !st.sel[k]; }).map(function (k) { return HCE.LABELS[k]; });
      prev.textContent = 'Will include (' + pv.snapshot.range.from + ' to ' + pv.snapshot.range.to + ', ' + pv.snapshot.range.days + ' days): ' + inc.join(' · ') + '. Left out: ' + (out.length ? out.join(', ') : 'nothing') + '. No file exists yet.';
    } else prev.textContent = pv.message;
    c.appendChild(prev);
    var err = h('p', { class: 'form-error', testid: 'ce-error', 'aria-live': 'polite' });
    c.appendChild(err);
    c.appendChild(h('button', { type: 'button', class: 'btn btn-primary', text: 'Create snapshot', testid: 'ce-create', disabled: pv.ok ? null : 'disabled', onclick: function () {
      if (st.snap || ceNow() < st.lockUntil) return; // one file per tap
      st.lockUntil = ceNow() + 700;
      var r = ceBuild(st);
      if (!r.ok) { err.textContent = r.message; return; }
      st.snap = { text: r.text, fileName: r.fileName, days: r.snapshot.range.days, categories: r.categories, total: r.total };
      st.status = null;
      ceHandOver('share');
      if (!st.status) ceRedraw();
    } }));
    return c;
  }

  // ---------- wiring ----------
  function extSaved() { try { window.dispatchEvent(new CustomEvent('hyrox:ext-saved')); } catch (e) { /* older browsers */ } }
  function refresh() {
    dropReadMemo();
    try { renderToday(); } catch (e) { /* keep other panels alive */ }
    try { renderDiary(); } catch (e) { /* */ }
    try { renderHistory(); } catch (e) { /* */ }
    try { renderTrends(); } catch (e) { /* */ }
  }
  // P10b: a new Asia/Qatar day (app left open past midnight) re-renders every screen for the new date; an untouched
  // new-meal draft is moved to the new day, an unsaved one keeps its date (it is shown and editable).
  var shownDay = today();
  function checkDay() {
    var d = today();
    if (d === shownDay) return false;
    shownDay = d;
    if (ms && !ms.id && !mealDirty() && !(logCtx && logCtx.fixed)) {
      // Claude P10b review: an untouched COPY is deliberate content, so only its date moves; a blank draft is rebuilt.
      var keepCat = ms.mealCategory;
      if (ms.source === 'COPY') { ms.date = d; msBase = draftKey(ms); }
      else { setDraft(blankMeal(ms.source === 'REUSE' ? 'MANUAL' : ms.source)); if (keepCat) { ms.mealCategory = keepCat; msBase = draftKey(ms); } }
      if (logCtx) logCtx.date = d;
    }
    // P11: a diary that follows "today" moves to the new day; a past date chosen on purpose stays.
    if (diaryDate !== null && diaryDate > d) diaryDate = null;
    if (currentTab === 'add' || addMode === 'meal') renderAdd();
    refresh();
    return true;
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.addEventListener('click', function () {
    var t = b.getAttribute('data-tab');
    checkDay();
    // the Add form must always show the current draft (never a saved or discarded one)
    if (t === 'add' && addMode === 'meal' && renderedMs !== ms) renderAdd();
    showTab(t); if (t === 'settings') renderSettings(); }); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkDay(); });
  window.addEventListener('hyrox:backup-note', function () { try { renderToday(); } catch (e) { /* */ } });
  window.addEventListener('pageshow', function (e) { if (!checkDay() && e && e.persisted && addMode === 'meal') renderAdd(); });
  setInterval(checkDay, 30000);
  Array.prototype.forEach.call(document.querySelectorAll('.seg[data-mode]'), function (b) { b.addEventListener('click', function () { showAddMode(b.getAttribute('data-mode')); }); });
  window.addEventListener('hyrox:changed', refresh);
  // Keep an unsaved workout across a reload between sets. Runs after the field handlers updated ws.
  ['input', 'change', 'click'].forEach(function (ev) { $('add-root').addEventListener(ev, function () { if (addMode === 'workout' && ws) saveDraft(); }); });
  (function () { var d = loadDraft(); if (d && !d.invalid) { ws = d.ws; draftRestoredAt = d.savedAt; draftStartDay = d.day || null; draftId = d.draftId || null; } })();
  // Sprint B (P1.2): another tab saved or discarded the unsaved workout this tab also holds.
  window.addEventListener('storage', function (e) {
    if (e.key !== DRAFT_KEY || e.newValue !== null) return;
    if (ws && !ws.id && draftId && draftWorthKeeping(ws)) { draftOtherTab = true; if (addMode === 'workout') renderAdd(); }
  });
  // Sprint B2 (owner M1): keep an unfinished meal across a reload (UI-only key; never restored without Resume).
  ['input', 'change', 'click'].forEach(function (ev) { $('add-root').addEventListener(ev, function () { if (addMode === 'meal') saveMealDraft(); }); });
  window.addEventListener('storage', function (e) {
    if (e.key !== MEAL_DRAFT_KEY) return;
    var oldId = null; try { oldId = (JSON.parse(e.oldValue || 'null') || {}).draftId || null; } catch (x) { /* */ }
    if (e.newValue === null && ms && !ms.id && mdId && oldId === mdId && mealDirty()) { mdOtherTab = true; if (addMode === 'meal' && currentTab === 'add') renderAdd(); }
    if (currentTab === 'today') renderToday();
  });
  window.addEventListener('pagehide', saveMealDraft);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') saveMealDraft(); });
  window.addEventListener('pagehide', dropPhoto);
  showAddMode('meal');
  renderSettings();
  refresh();
  showTab('today');
  if (window.HyroxGarminImport && typeof window.HyroxGarminImport.boot === 'function') {
    try { window.HyroxGarminImport.boot(document.getElementById('garmin-import-root')); } catch (e) { /* flag-off path is a no-op; boot must never break the app */ }
  }
  window.HyroxExtUI = { showTab: showTab, showAddMode: showAddMode };
  window.HyroxExtReady = true; // P6 load guard flag: set only when this script ran to the end
})();
