/*
 * hyrox-blocks.js - Phase 12 training-block planner (Block 2+), pure functions + one store helper.
 * Plain-JS UMD: classic <script> (window.HyroxBlocks) or require() in Node. Reads HyroxPlan (Block 1) read-only.
 *
 * Block 1 (v2.1, 16 Nov - 13 Dec 2026) stays the built-in, immutable block in hyrox-plan.js: its slots, ids, dates,
 * planEvents and every rule are untouched (this file never writes them). Later blocks live in the OPTIONAL field
 * `planBlocks` of the existing owner-settings record (data v2, no new collection, no new enum value).
 *
 * Owner / Command Center decisions (19 Nov 2026, D1-D12): conservative Hold template as an INACTIVE DRAFT whose content
 * stays "draft - pending owner approval after 11 Dec"; Block 1 W2/W3 prescriptions are a ceiling; no automatic
 * progression or load increase; progression options are owner choices only from 11 Dec and are never pre-selected;
 * Monday-only start from Mon 14 Dec, no early start, no overlap; holiday Fridays flagged only; optional uncounted
 * Saturday; ST0 steps; Benchmark 3 on the W4 Friday; future-only unlogged revisions; 20-slot denominator; planned rest
 * separate from skip / omission; no upward deload change; the 17/20 numerator and the both-missed rule stay unresolved.
 * Block-scoped missed-day events live in the block record, never in the legacy week-only planEvents list.
 * No AI, no network, no automatic rollover. All dates are Asia/Qatar calendar dates (ISO strings).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hyrox-plan.js'));
  else root.HyroxBlocks = factory(root.HyroxPlan);
})(typeof self !== 'undefined' ? self : this, function (HP) {
  'use strict';

  var TEMPLATE_ID = 'HNC-B2-HOLD';
  var TEMPLATE_VERSION = 'b2-hold-1';          // goes into sessions.planVersion (max 20 chars)
  var FIRST_START = '2026-12-14';              // D3/D4: first allowed start (the Monday after Block 1 ends)
  var DECISION_FROM = '2026-12-11';            // Block 1 Benchmark 2 (Fri 11 Dec): options + activation from this date
  var WEEKS = 4, DELOAD_WEEK = 4, MAX_BLOCKS = 12, MAX_TEXT = 300;
  var DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
  var DRAFT_LABEL = 'Draft — pending owner approval after 11 Dec';
  var ID_RE = /^b-\d{8}-[a-z0-9]{4}$/;
  var SLOT_ID_RE = /^(b-\d{8}-[a-z0-9]{4})-W([1-4])-(MON|TUE|WED|THU|FRI)$/;
  var ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  var ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
  var STATES = ['DRAFT', 'ACTIVATED', 'CANCELLED'];
  var EVENT_KINDS = ['MISSED_MONDAY', 'MISSED_WEDNESDAY'];
  var REVISION_KINDS = ['PLANNED_REST', 'LOW_IMPACT', 'REDUCED_VOLUME', 'FALLBACK_45', 'FALLBACK_25', 'OWNER_TEXT'];
  // D5: possible gym closures. Flag only: nothing is pre-marked missed, skipped or cancelled.
  var POSSIBLE_CLOSURES = { '2026-12-18': 'Qatar National Day', '2026-12-25': 'possible work holiday', '2027-01-01': 'possible work holiday' };
  // D2 progression menu. Owner choices only, from DECISION_FROM; none is ever pre-selected (default = Hold everywhere).
  var OPTION_GROUPS = {
    running: { label: 'Running volume', choices: {
      I1: 'Tue intervals W2–W3: 4 rounds with 500 m runs (the Block 1 Week 3 level, not above it)',
      I2: 'Tue intervals W3 only: 5 rounds × 400 m (above the Block 1 ceiling — only with clear Block 1 evidence)',
      A1: 'Thu run-walk W2–W3: 2× (6 min jog / 1 min walk) + 1 min walk = 15 min (longer jog bouts than Block 1 — only with clear evidence)' } },
    race: { label: 'Race skills', choices: {
      R1L: 'Fri W3: walking lunges 20 m → 30 m, only if recovered (v2.1 §5 wording); wall balls unchanged',
      R1W: 'Fri W3: wall balls 15 → 20, only if recovered (v2.1 §5 wording); lunges unchanged' } },
    lifting: { label: 'Lifting', choices: {
      S1: 'Mon W2–W3: light Romanian deadlift 2×8 @ RPE 6 instead of the back extension (only with no back / hamstring pain)' } }
  };
  var BOTH_WARNING = 'v2.1 §10: do not increase both running volume and lifting load if recovery is poor. You chose both; confirm only if your Block 1 recovery was good.';
  // D10 revision texts (lower or equal load only).
  var LOW_IMPACT = {
    STRENGTH_A: ['Low-impact version (your choice): goblet or box squat instead of back squat, same sets at RPE ≤ 7', 'Bench press or DB press + chest-supported DB row, same or fewer sets', 'Dead bug 2x8/side; skip back extension if the back is sore', 'Cooldown'],
    STRENGTH_B: ['Low-impact version (your choice): trap-bar or block-pull deadlift, lighter load, same or fewer sets at RPE ≤ 7', 'Landmine or seated DB press + lat pulldown, same or fewer sets', 'Light farmer carry or skip', 'Cooldown'],
    INTERVALS: ['Low-impact version (your choice): bike or elliptical instead of the runs, same work time at RPE 6', 'SkiErg 250 m per round as planned, or bike', 'Sled: lighter or omit', 'Every machine bout ≤ 15 min continuous'],
    AEROBIC: ['Low-impact version (your choice): incline treadmill walk 15 min instead of run-walk', 'Rower or bike 15 min easy', 'SkiErg 10 min easy, or bike', 'Every machine bout ≤ 15 min continuous'],
    RACE: ['Low-impact version (your choice): bike or rower instead of the runs (≤ 15 min continuous)', 'Step-back burpee + 2 long steps instead of burpee broad jumps, or omit', 'Split squat or step-ups instead of walking lunges; lighter ball / lower target for wall balls', 'Record every change; a changed benchmark is not comparable']
  };
  var REDUCED = ['Reduced volume (your choice): about 20–30% less — fewer rounds or sets, same or lower intensity (v2.1 §8 one-flag rule)', 'Keep the warm-up and cooldown', 'Record what you actually did'];

  // ---------- small helpers ----------
  function addDays(iso, n) { return HP.addDays(iso, n); }
  function dow(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); }
  function isWeekend(iso) { var d = dow(iso); return d === 0 || d === 6; }
  function isIsoDate(v) { return typeof v === 'string' && ISO_DATE.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function res(ok, code, text, extra) { var o = { ok: ok, code: code, text: text }; if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; }); return o; }
  // Deterministic content checksum (FNV-1a 32-bit), usable synchronously in the browser. Integrity hint only.
  function checksum(str) { var h = 0x811c9dc5; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }

  // ---------- the Hold template (D1): Block 1 W2/W3 prescriptions are the ceiling; W4 = Block 1 deload ----------
  var RACE_ROUND = '400 m run + 250 m row + 20 m farmer carry + 10 m burpee broad jumps + 20 m bodyweight lunges + 15 light wall balls';
  function holdLines(type, w, opt) {
    var dl = w === DELOAD_WEEK;
    opt = opt || {};
    if (type === 'STRENGTH_A') {
      return ['0–8 min warm-up: easy machine + mobility',
        'Back squat: progressive warm-up, then ' + (dl ? '2 work sets @ RPE 6–7 (deload)' : '3x5 @ RPE 7'),
        'Bench press ' + (dl ? '2 work sets' : '3x5') + ' + chest-supported DB row ' + (dl ? '2' : '3') + 'x8–10',
        opt.lifting === 'S1' && (w === 2 || w === 3) ? 'Light Romanian deadlift 2x8 @ RPE 6 (your option S1) + dead bug 2x8/side' : 'Back extension 2x12 + dead bug 2x8/side',
        'Buffer, then 8 min cooldown',
        'Loads: from your own recent clean sets. Hold never raises weights automatically; the v2.1 §4 load rule is yours to apply, subject to recovery.'];
    }
    if (type === 'STRENGTH_B') {
      return ['Warm-up + hinge drills', 'Deadlift (conventional or trap bar) ' + (dl ? '2 work sets @ RPE 6–7 (deload)' : '3x5 @ RPE 7, cap RPE 8'),
        'Overhead press ' + (dl ? '2' : '3') + 'x5 + pull-ups / lat pulldown ' + (dl ? '2 sets' : '3 sets') + ' of 6–10',
        'Incline DB press 2x8–10 + farmer carries up to 3x30 m', 'Transition and cooldown', 'RPE 7 ≈ 3 reps in reserve. Record actual loads only.'];
    }
    if (type === 'INTERVALS') {
      var rounds = dl ? 3 : 4, run = 400;
      if (opt.running === 'I1' && (w === 2 || w === 3)) run = 500;
      if (opt.running === 'I2' && w === 3) rounds = 5;
      return ['10 min warm-up', rounds + ' rounds: ' + run + ' m controlled run @ RPE 6, 250 m SkiErg, 90 s walking rest',
        'Then up to 3 rounds: 15 m sled push + 15 m sled pull, smooth light load, 90 s rest',
        'Record actual equipment, load, splits, omissions and partial completion'];
    }
    if (type === 'AEROBIC') {
      var rw = w === 1 || dl ? '5x (2 min jog / 1 min walk)' : '3x (4 min jog / 1 min walk)';
      if (opt.running === 'A1' && (w === 2 || w === 3)) rw = '2x (6 min jog / 1 min walk) + 1 min walk (your option A1)';
      return ['5 min warm-up', 'Treadmill run-walk ≤15 min: ' + rw, 'Switch: rower 15 min easy (bike if back is tired)', 'SkiErg 10 min easy',
        'Remaining time: transitions / mobility. Distinct bouts with real machine changes.'];
    }
    // RACE
    if (dl) {
      return ['10 min warm-up', '2 rounds (BENCHMARK 3 — exact repeat of the Benchmark 1/2 protocol): ' + RACE_ROUND, 'Rest 3–4 min between rounds',
        'Same effort, equipment and stop rules as Benchmarks 1 and 2. If anything changes, log it as Modified: it is then not comparable.', 'Cooldown'];
    }
    var round = RACE_ROUND;
    if (w === 3 && opt.race === 'R1L') round = round.replace('20 m bodyweight lunges', '30 m bodyweight lunges (your option R1L, only if recovered)');
    if (w === 3 && opt.race === 'R1W') round = round.replace('15 light wall balls', '20 light wall balls (your option R1W, only if recovered)');
    return ['10 min warm-up', '2 rounds: ' + round, 'Rest 3–4 min between rounds', 'Optional light sled technique, cooldown'];
  }
  var TITLES = { STRENGTH_A: 'Strength A', INTERVALS: 'Run / SkiErg intervals + light sled', STRENGTH_B: 'Strength B', AEROBIC: 'Aerobic HYROX (run-walk / row / SkiErg)', RACE: 'Race skills' };
  var SCHEDULE = { MON: 'STRENGTH_A', TUE: 'INTERVALS', WED: 'STRENGTH_B', THU: 'AEROBIC', FRI: 'RACE' };

  function normOptions(o) {
    o = isObj(o) ? o : {};
    var out = {};
    Object.keys(OPTION_GROUPS).forEach(function (g) { out[g] = typeof o[g] === 'string' && hasOwn(OPTION_GROUPS[g].choices, o[g]) ? o[g] : null; });
    out.bothConfirmed = o.bothConfirmed === true;
    return out;
  }
  function chosenOptions(o) { var n = normOptions(o); return Object.keys(OPTION_GROUPS).filter(function (g) { return n[g]; }).map(function (g) { return n[g]; }); }
  function bothIncreases(o) { var n = normOptions(o); return !!n.running && !!n.lifting; }

  function buildSlots(id, startDate, options) {
    var slots = [];
    for (var w = 1; w <= WEEKS; w++) {
      DAYS.forEach(function (d, i) {
        var type = SCHEDULE[d];
        slots.push({ id: id + '-W' + w + '-' + d, week: w, day: d, date: addDays(startDate, (w - 1) * 7 + i), type: type, title: TITLES[type],
          durationMin: 60, prescription: holdLines(type, w, options), benchmark: d === 'FRI' && w === DELOAD_WEEK ? 3 : null, deload: w === DELOAD_WEEK });
      });
    }
    return slots;
  }
  function contentHash(slots) { return checksum(JSON.stringify(slots.map(function (s) { return [s.week, s.day, s.type, s.prescription]; }))); }

  // ---------- validation (read side: a bad block is reported and not used; it never invalidates the settings record) ----------
  function textOk(v, max) { return typeof v === 'string' && v.length <= (max || MAX_TEXT); }
  function validateBlock(b) {
    var e = [];
    function bad(f, m) { e.push({ field: f, message: m }); }
    if (!isObj(b)) return [{ field: 'block', message: 'A plan block must be a record.' }];
    if (typeof b.id !== 'string' || !ID_RE.test(b.id)) bad('id', 'id must look like b-YYYYMMDD-xxxx.');
    if (STATES.indexOf(b.state) === -1) bad('state', 'state must be DRAFT, ACTIVATED or CANCELLED.');
    if (b.templateId !== TEMPLATE_ID) bad('templateId', 'Unknown template.');
    if (!textOk(b.templateVersion, 20)) bad('templateVersion', 'templateVersion must be short text.');
    if (!isIsoDate(b.startDate) || dow(b.startDate) !== 1) bad('startDate', 'startDate must be a Monday (YYYY-MM-DD).');
    else if (b.endDate !== addDays(b.startDate, WEEKS * 7 - 1)) bad('endDate', 'endDate must be the Sunday 4 weeks after the start.');
    if (b.weeks !== WEEKS || b.deloadWeek !== DELOAD_WEEK) bad('weeks', 'A block has 4 weeks with the deload in week 4.');
    if (!isObj(b.options)) bad('options', 'options must be a record.');
    else Object.keys(OPTION_GROUPS).forEach(function (g) { if (b.options[g] != null && !hasOwn(OPTION_GROUPS[g].choices, b.options[g])) bad('options.' + g, 'Unknown option.'); });
    if (!ISO_TS.test(String(b.createdAt))) bad('createdAt', 'createdAt must be a date-time.');
    if (b.state === 'ACTIVATED' && !ISO_TS.test(String(b.activatedAt))) bad('activatedAt', 'An activated block needs activatedAt.');
    if (b.state === 'ACTIVATED' && !(isObj(b.approval) && ISO_TS.test(String(b.approval.at)) && textOk(b.approval.text))) bad('approval', 'An activated block needs the owner approval record.');
    if (b.endedEarlyOn != null && !(isIsoDate(b.endedEarlyOn) && isIsoDate(b.startDate) && b.endedEarlyOn > b.startDate && b.endedEarlyOn <= b.endDate)) bad('endedEarlyOn', 'endedEarlyOn must be a date inside the block.');
    if (!Array.isArray(b.slots) || b.slots.length !== WEEKS * 5) bad('slots', 'A block has exactly 20 weekday slots.');
    else b.slots.forEach(function (s, i) {
      var w = Math.floor(i / 5) + 1, d = DAYS[i % 5];
      if (!isObj(s) || s.id !== b.id + '-W' + w + '-' + d || s.week !== w || s.day !== d || (isIsoDate(b.startDate) && s.date !== addDays(b.startDate, (w - 1) * 7 + (i % 5))) ||
        SCHEDULE[d] !== s.type || !Array.isArray(s.prescription) || s.prescription.length > 12 || !s.prescription.every(function (l) { return textOk(l); }) ||
        !textOk(s.title, 80) || s.durationMin !== 60) bad('slots[' + i + ']', 'Slot ' + (i + 1) + ' does not match the block calendar.');
    });
    if (!Array.isArray(b.events) || b.events.length > 40) bad('events', 'events must be a short list.');
    else b.events.forEach(function (x, i) {
      if (!isObj(x) || typeof x.id !== 'string' || EVENT_KINDS.indexOf(x.kind) === -1 || !(x.week >= 1 && x.week <= WEEKS && Number.isInteger(x.week)) || !isIsoDate(x.date) || !ISO_TS.test(String(x.createdAt)))
        bad('events[' + i + ']', 'Missed-day event ' + (i + 1) + ' is not valid.');
    });
    if (!Array.isArray(b.revisions) || b.revisions.length > 100) bad('revisions', 'revisions must be a list.');
    else b.revisions.forEach(function (r, i) {
      if (!isObj(r) || typeof r.id !== 'string' || REVISION_KINDS.indexOf(r.kind) === -1 || typeof r.slotId !== 'string' || !ISO_TS.test(String(r.at)) ||
        !isObj(r.after) || !Array.isArray(r.after.prescription) || !r.after.prescription.every(function (l) { return textOk(l); }) || (r.note != null && !textOk(r.note)))
        bad('revisions[' + i + ']', 'Revision ' + (i + 1) + ' is not valid.');
    });
    return e;
  }

  // Splits a stored planBlocks value into usable blocks and reported problems. Never changes the input.
  function readBlocks(value) {
    if (value === undefined || value === null) return { blocks: [], invalid: [], malformed: false };
    if (!Array.isArray(value)) return { blocks: [], invalid: [], malformed: true };
    var blocks = [], invalid = [], seen = {};
    value.forEach(function (b, i) {
      var errs = validateBlock(b);
      if (!errs.length && seen[b.id]) errs = [{ field: 'id', message: 'Duplicate block id.' }];
      if (errs.length) invalid.push({ index: i, id: isObj(b) && typeof b.id === 'string' ? b.id.slice(0, 40) : null, problems: errs.slice(0, 5) });
      else { seen[b.id] = true; blocks.push(b); }
    });
    return { blocks: blocks, invalid: invalid, malformed: false };
  }
  function activated(blocks) { return (blocks || []).filter(function (b) { return b && b.state === 'ACTIVATED'; }); }
  function lastDay(b) { return b.endedEarlyOn ? addDays(b.endedEarlyOn, -1) : b.endDate; }
  function blockById(blocks, id) { return (blocks || []).filter(function (b) { return b && b.id === id; })[0] || null; }

  // ---------- effective content (revisions applied; the snapshot itself is never edited) ----------
  function effectiveSlots(b) {
    var slots = clone(b.slots);
    var by = {}; slots.forEach(function (s) { s.blockId = b.id; s.planVersion = b.templateVersion; by[s.id] = s; });
    (b.revisions || []).forEach(function (r) {
      var s = by[r.slotId]; if (!s) return;
      s.prescription = r.after.prescription.slice();
      s.revision = { kind: r.kind, at: r.at, ownerWritten: r.kind === 'OWNER_TEXT', note: r.note || null };
      s.plannedRest = r.kind === 'PLANNED_REST';
    });
    slots.forEach(function (s) { if (b.endedEarlyOn && s.date >= b.endedEarlyOn) s.notInPlan = true; });
    return slots;
  }
  function blockForDate(date, blocks) {
    return activated(blocks).filter(function (b) { return b.startDate <= date && date <= lastDay(b); })[0] || null;
  }
  function nextBlockAfter(date, blocks) {
    return activated(blocks).filter(function (b) { return b.startDate > date; }).sort(function (a, b) { return a.startDate < b.startDate ? -1 : 1; })[0] || null;
  }
  function isBlockSlotId(id) { return typeof id === 'string' && SLOT_ID_RE.test(id); }
  // Only ACTIVATED blocks resolve: a draft or cancelled block has no effect on logging or rules.
  function slotById(id, blocks) {
    var m = isBlockSlotId(id) ? SLOT_ID_RE.exec(id) : null;
    if (!m) return null;
    var b = activated(blocks).filter(function (x) { return x.id === m[1]; })[0];
    if (!b) return null;
    return effectiveSlots(b).filter(function (s) { return s.id === id; })[0] || null;
  }
  function blockOfSlot(id, blocks) { var m = isBlockSlotId(id) ? SLOT_ID_RE.exec(id) : null; return m ? activated(blocks).filter(function (x) { return x.id === m[1]; })[0] || null : null; }
  function weekOf(b, date) { if (!b || date < b.startDate || date > b.endDate) return null; return Math.floor(Math.round((Date.parse(date) - Date.parse(b.startDate)) / 86400000) / 7) + 1; }

  function blockStatus(date, blocks) {
    var b = blockForDate(date, blocks);
    if (b) { var w = weekOf(b, date); return { active: true, blockId: b.id, label: b.label || 'Block 2', week: w, deload: w === DELOAD_WEEK,
      text: (b.label || 'Block 2') + ' — Week ' + w + ' of 4' + (w === DELOAD_WEEK ? ' (deload)' : '') + '. Ends ' + HP.human(lastDay(b)) + '. Conditional training plan, not medical clearance.' }; }
    var n = nextBlockAfter(date, blocks);
    if (n && date > HP.BLOCK_END) return { active: false, upcoming: n.id, text: HP.NO_BLOCK_TEXT + ' — ' + (n.label || 'Block 2') + ' starts ' + HP.human(n.startDate) + '. Days before it are not counted and not missed.' };
    return null; // not a later-block date: Block 1's own status applies unchanged
  }

  // ---------- schedule: cascade from this block's OWN events (same source rule as Block 1) ----------
  function weekendOptions(b, w) {
    var sat = addDays(b.startDate, (w - 1) * 7 + 5), sun = addDays(b.startDate, (w - 1) * 7 + 6);
    return [{ date: sat, day: 'SAT', kind: 'OPTIONAL_LIGHT_SATURDAY', available: true, counted: false, gymMakeUp: false,
      text: 'Optional, easy (RPE 3–4): 15 min treadmill + 15 min bike + 15 min elliptical, OR easy jog intervals in the evening walk. Not counted. Not a make-up for a missed gym session.' },
    { date: sun, day: 'SUN', kind: 'SUNDAY_MOBILITY', available: true, counted: false, gymMakeUp: false,
      text: 'Optional 15–20 min mobility. No gym required. Not counted. Not a make-up for a missed gym session.' }];
  }
  function effectiveWeek(b, week) {
    var evs = (b.events || []).filter(function (e) { return e.week === week; });
    var mon = evs.some(function (e) { return e.kind === 'MISSED_MONDAY'; }), wed = evs.some(function (e) { return e.kind === 'MISSED_WEDNESDAY'; });
    var slots = effectiveSlots(b).filter(function (s) { return s.week === week; });
    var by = {}; slots.forEach(function (s) { by[s.day] = s; });
    var days = slots.map(function (s) { return { date: s.date, day: s.day, show: [{ slot: s, movedFrom: null }], omitted: [], possibleClosure: POSSIBLE_CLOSURES[s.date] || null }; });
    var unresolved = null;
    if (mon && wed) unresolved = 'Both Monday and Wednesday marked missed: the source has no rule for this. Nothing was moved or omitted — decide manually.';
    else if (mon) { days[0].show = []; days[1].show = [{ slot: by.MON, movedFrom: 'MON' }]; days[3].show = [{ slot: by.TUE, movedFrom: 'TUE' }]; days[3].omitted = [{ slot: by.THU, reason: 'MISSED_MONDAY_CASCADE' }]; }
    else if (wed) { days[2].show = []; days[3].show = [{ slot: by.WED, movedFrom: 'WED' }]; days[3].omitted = [{ slot: by.THU, reason: 'MISSED_WEDNESDAY_CASCADE' }]; }
    return { blockId: b.id, week: week, days: days, unresolved: unresolved, weekendOptions: weekendOptions(b, week),
      fridayNote: 'If Friday is missed (including a holiday closure): skip it, no weekend make-up (source rule). Never stack two hard sessions.' };
  }
  function omissionFor(b, slotId) {
    var s = effectiveSlots(b).filter(function (x) { return x.id === slotId; })[0];
    if (!s || s.day !== 'THU') return null;
    var o = effectiveWeek(b, s.week).days[3].omitted[0];
    return o ? o.reason : null;
  }

  // ---------- statuses (same semantics as Block 1: actual work is never hidden by a later note) ----------
  var ACTUAL = ['COMPLETED', 'PARTIAL', 'IN_PROGRESS'];
  function isActualWork(s) { return !!s && ACTUAL.indexOf(s.status) !== -1; }
  function byNewest(a, b) { return String(b.updatedAt || b.createdAt) < String(a.updatedAt || a.createdAt) ? -1 : 1; }
  function linked(slotId, sessions) { return (sessions || []).filter(function (x) { return x && x.planSlotId === slotId; }); }
  function latestFor(slotId, sessions) {
    var m = linked(slotId, sessions), work = m.filter(isActualWork).sort(byNewest);
    if (work.length) return work[0];
    m.sort(byNewest);
    return m[0] || null;
  }
  function slotStatus(blocks, slotId, sessions) {
    var b = blockOfSlot(slotId, blocks); if (!b) return null;
    var slot = effectiveSlots(b).filter(function (s) { return s.id === slotId; })[0];
    var om = omissionFor(b, slotId);
    var weekendWork = linked(slotId, sessions).filter(function (x) { return isActualWork(x) && typeof x.date === 'string' && isWeekend(x.date); });
    var rest = (sessions || []).filter(function (x) { return weekendWork.indexOf(x) === -1; });
    var s = latestFor(slotId, rest), out;
    if (!s) {
      if (om) out = { code: 'SOURCE_OMITTED', reason: om, omission: om, session: null };
      else if (slot.notInPlan) out = { code: 'NOT_IN_PLAN', omission: null, session: null };
      else if (slot.plannedRest) out = { code: 'PLANNED_REST', omission: null, session: null };
      else out = { code: 'NOT_LOGGED', omission: null, session: null };
    } else {
      out = { code: s.status, modified: !!s.modified, variant: s.variant, session: s, omission: om };
      if (s.variantKind) out.variantKind = s.variantKind;
      if (om) { out.reason = om; if (s.status === 'NOT_STARTED') out.code = 'SOURCE_OMITTED'; else if (isActualWork(s)) out.conflict = 'ACTUAL_SESSION_ON_SOURCE_OMITTED_SLOT'; }
      if (s.status === 'SKIPPED') { out.skipDecision = s.skipDecision || null; out.rescheduledTo = s.skipDecision === 'RESCHEDULE' ? s.rescheduledTo || null : null; if (out.rescheduledTo && isWeekend(out.rescheduledTo)) out.rescheduleNotSourceApproved = true; }
    }
    if (weekendWork.length) { out.weekendWork = weekendWork.slice().sort(byNewest); out.offPlan = 'WEEKEND_ACTUAL_NOT_SOURCE_RESCHEDULE'; }
    if (slot.plannedRest) out.plannedRest = true;
    return out;
  }

  // Honest list of disagreements between this block's own cascade events and logged sessions (nothing is changed).
  function cascadeConflicts(b, week, sessions) {
    var out = [], evs = (b.events || []).filter(function (e) { return e.week === week; });
    function ev(kind) { return evs.filter(function (e) { return e.kind === kind; })[0] || null; }
    var slots = effectiveSlots(b).filter(function (s) { return s.week === week; });
    function slot(day) { return slots.filter(function (s) { return s.day === day; })[0]; }
    var mon = ev('MISSED_MONDAY'), wed = ev('MISSED_WEDNESDAY');
    if (mon && wed) return out;
    [['MON', mon], ['WED', wed]].forEach(function (p) {
      if (!p[1]) return;
      var sl = slot(p[0]), s = latestFor(sl.id, sessions);
      if (isActualWork(s) && s.date <= sl.date) out.push({ slotId: sl.id, code: 'MISSED_DAY_HAS_ACTUAL_SESSION', text: sl.title + ' is marked missed, but a session is logged as performed on ' + s.date + ' (' + s.status + '). The log is kept; check whether the cascade should be removed.' });
    });
    if (mon || wed) {
      var thu = slot('THU'), ts = latestFor(thu.id, sessions);
      if (isActualWork(ts)) out.push({ slotId: thu.id, code: 'ACTUAL_SESSION_ON_SOURCE_OMITTED_SLOT', text: 'Thursday aerobic is omitted by the source cascade, but an actual session is logged for it (' + ts.status + ', performed ' + ts.date + '). The logged work is kept and counted as logged.' });
    }
    if (mon) {
      var tue = slot('TUE'), us = latestFor(tue.id, sessions);
      if (isActualWork(us) && us.date <= tue.date) out.push({ slotId: tue.id, code: 'MOVED_SLOT_DONE_ON_ORIGINAL_DAY', text: 'The cascade moves Tuesday\'s session to Thursday, but it is logged as performed on ' + us.date + '. The log is kept; do not repeat it on Thursday.' });
    }
    return out;
  }
  function summary(b, sessions) {
    var c = { blockId: b.id, denominator: WEEKS * 5, NOT_LOGGED: 0, NOT_STARTED: 0, IN_PROGRESS: 0, COMPLETED: 0, PARTIAL: 0, SKIPPED: 0, SOURCE_OMITTED: 0,
      PLANNED_REST: 0, NOT_IN_PLAN: 0, modified: 0, fallback: 0, omittedWithActual: 0, weekendActual: 0, plannedRestRevised: 0,
      qualifyingNumerator: null, numeratorStatus: 'OWNER_DECISION_PENDING' };
    var blocks = [b];
    effectiveSlots(b).forEach(function (s) {
      var st = slotStatus(blocks, s.id, sessions);
      c[st.code] = (c[st.code] || 0) + 1;
      if (st.plannedRest) c.plannedRestRevised++;
      if (st.conflict) c.omittedWithActual++;
      if (st.session && st.session.modified) c.modified++;
      if (st.session && (st.session.variant === 'SOURCE_45_MIN' || st.session.variant === 'SOURCE_25_MIN')) c.fallback++;
      if (st.weekendWork) c.weekendActual += st.weekendWork.length;
    });
    c.note = 'Denominator is the original 20 slots (planned rest, make-ups and an early end never change it; they are shown separately). Which sessions count toward a review numerator is still an OPEN owner decision.';
    return c;
  }
  function benchmarks(b, sessions) {
    var slot = effectiveSlots(b).filter(function (s) { return s.benchmark === 3; })[0];
    var s = latestFor(slot.id, sessions);
    var comparable = !!s && s.status === 'COMPLETED' && !s.modified && s.variant === 'ORIGINAL_60';
    return [{ benchmark: 3, slotId: slot.id, date: slot.date, status: s ? s.status : 'NOT_LOGGED', durationMin: s && typeof s.durationMin === 'number' ? s.durationMin : null, comparable: comparable,
      note: comparable ? 'Logged as the unmodified protocol: comparable with Benchmarks 1/2 only if those were also unmodified.' : s ? 'Not comparable: ' + (s.modified ? 'logged as modified' : s.status !== 'COMPLETED' ? 'not completed' : 'not the original 60-min protocol') + '.' : 'Not logged yet.' }];
  }

  // ---------- never-stack, reschedule, skip advice (same source rules, scoped to the block) ----------
  function isDemanding(s, blocks) {
    if (!s) return false;
    if (isBlockSlotId(s.planSlotId) || HP.slotById(s.planSlotId)) return true;
    return HP.isDemandingSession(s);
  }
  function plannedOn(date, blocks) {
    var b = blockForDate(date, blocks); if (!b) return [];
    var w = weekOf(b, date), day = effectiveWeek(b, w).days.filter(function (d) { return d.date === date; })[0];
    return day ? day.show.map(function (x) { return x.slot; }).filter(function (s) { return !s.plannedRest && !s.notInPlan; }) : [];
  }
  function rescheduledOn(date, sessions, blocks) {
    var out = [];
    activated(blocks).forEach(function (b) { effectiveSlots(b).forEach(function (sl) {
      var s = latestFor(sl.id, sessions);
      if (s && s.status === 'SKIPPED' && s.skipDecision === 'RESCHEDULE' && s.rescheduledTo === date) out.push(sl);
    }); });
    return out;
  }
  function rescheduleCheck(blocks, slotId, date, sessions, today) {
    var b = blockOfSlot(slotId, blocks), slot = b ? effectiveSlots(b).filter(function (s) { return s.id === slotId; })[0] : null;
    function rc(ok, code, text) { var o = { ok: ok, code: code }; o[ok ? 'caution' : 'reason'] = text; return o; }
    if (!slot) return rc(false, 'UNKNOWN_SLOT', 'Unknown planned session.');
    if (!isIsoDate(date)) return rc(false, 'NO_DATE', 'Choose a date.');
    if (date < today) return rc(false, 'PAST', 'A session cannot be rescheduled into the past.');
    if (date === slot.date) return rc(false, 'ORIGINAL_DATE', 'That is the original planned date.');
    if (date < b.startDate || date > lastDay(b)) return rc(false, 'OUTSIDE_BLOCK', 'That date is outside ' + (b.label || 'Block 2') + ' (' + b.startDate + ' to ' + lastDay(b) + '). Sessions never move between blocks.');
    if (isWeekend(date)) {
      if (slot.day === 'FRI') return rc(false, 'FRIDAY_NO_WEEKEND_MAKEUP', 'Source rule: a missed Friday has no weekend make-up.');
      return rc(false, 'WEEKEND_NO_GYM_MAKEUP', 'Source rule (v2.1): no weekend make-up for a missed weekday HYROX gym session. Optional Saturday activity and Sunday mobility are not make-ups.');
    }
    var w = weekOf(b, date), day = effectiveWeek(b, w).days.filter(function (d) { return d.date === date; })[0];
    if (day && day.show.some(function (x) { return x.slot.plannedRest && x.slot.id !== slotId; })) return rc(false, 'PLANNED_REST_DAY', 'You planned rest on that day. It stays a rest day.');
    var others = plannedOn(date, blocks).filter(function (s) { return s.id !== slotId; });
    if (others.length) return rc(false, 'PLANNED_SESSION_ON_DAY', 'That day already has ' + others[0].title + ' planned. Two demanding sessions are never stacked on one day.');
    if (rescheduledOn(date, sessions, blocks).filter(function (s) { return s.id !== slotId; }).length) return rc(false, 'ALREADY_RESCHEDULED_TO_DAY', 'Another session is already rescheduled to that day. Two demanding sessions are never stacked on one day.');
    if ((sessions || []).some(function (s) { return s.date === date && isActualWork(s) && s.planSlotId !== slotId && isDemanding(s, blocks); })) return rc(false, 'DEMANDING_SESSION_LOGGED', 'A demanding session is already logged on that day. Two demanding sessions are never stacked on one day.');
    return rc(true, 'OK', 'This is outside the approved Monday/Wednesday cascade, so it is your decision. It uses a free weekday; drop it if recovery, soreness or pain is not good that day.');
  }
  function rescheduleDates(blocks, slotId, sessions, today) {
    var b = blockOfSlot(slotId, blocks); if (!b) return [];
    var out = [], from = today > b.startDate ? today : b.startDate;
    for (var d = from; d <= lastDay(b); d = addDays(d, 1)) if (rescheduleCheck(blocks, slotId, d, sessions, today).ok) out.push(d);
    return out;
  }
  function skipAdvice(blocks, slotId, sessions, today) {
    var b = blockOfSlot(slotId, blocks), slot = b ? effectiveSlots(b).filter(function (s) { return s.id === slotId; })[0] : null;
    if (!slot) return null;
    var evs = (b.events || []).filter(function (e) { return e.week === slot.week; });
    var hasMon = evs.some(function (e) { return e.kind === 'MISSED_MONDAY'; }), hasWed = evs.some(function (e) { return e.kind === 'MISSED_WEDNESDAY'; });
    var adjust = { available: false, kind: null, note: 'The source defines a week adjustment only for a missed Monday or Wednesday.' };
    if (slot.day === 'MON' || slot.day === 'WED') {
      var kind = slot.day === 'MON' ? 'MISSED_MONDAY' : 'MISSED_WEDNESDAY', mine = slot.day === 'MON' ? hasMon : hasWed, other = slot.day === 'MON' ? hasWed : hasMon;
      adjust.kind = kind;
      if (mine) adjust.note = 'The source cascade for this day is already applied.';
      else if (other) adjust.note = 'The other of Monday/Wednesday is already marked missed this week. The source has no rule for both, so nothing can be adjusted automatically.';
      else if (slot.date > today) adjust.note = 'A future session cannot be marked missed.';
      else { adjust.available = true; adjust.note = slot.day === 'MON' ? 'Approved source cascade: Strength A moves to Tuesday, Tuesday\'s intervals move to Thursday, Thursday aerobic is omitted by source rule.' : 'Approved source cascade: Strength B moves to Thursday, Thursday aerobic is omitted by source rule.'; }
    }
    var dates = rescheduleDates(blocks, slotId, sessions, today);
    var reschedule = { available: dates.length > 0, dates: dates, note: dates.length ? 'Free days without another session: ' + dates.join(', ') + '. Outside the approved cascade - your decision.'
      : (slot.day === 'FRI' ? 'Source rule: a missed Friday has no weekend make-up, and every other day already has a session.' : 'No free weekday is left in this block without stacking two demanding sessions, and weekends are not gym make-up days.') };
    var omitted = omissionFor(b, slotId);
    var recommended = adjust.available ? 'ADJUST_WEEK' : 'SKIP_PERMANENT';
    var why = adjust.available ? 'Recommended: adjust the rest of the week with the approved source cascade.' : slot.day === 'FRI' ? 'Recommended: leave it skipped. Source rule: no weekend make-up for a missed Friday.' : 'Recommended: leave it skipped. That never stacks sessions or costs a recovery day.';
    if (omitted) why = 'This session is already omitted by the source cascade (' + omitted + '); it does not need to be skipped. ' + why;
    return { slotId: slotId, day: slot.day, sourceOmission: omitted || null, recommended: recommended, recommendation: why,
      options: { RESCHEDULE: reschedule, SKIP_PERMANENT: { available: true, note: 'Stays skipped. The original planned session is kept for the record.' }, ADJUST_WEEK: adjust } };
  }

  // ---------- §9 fallbacks + loggable templates for a block slot (Block 1 shapes, no values filled) ----------
  function shapeWeek(slot) { return slot.week === DELOAD_WEEK ? 4 : 2; } // W1-W3 have the Block 1 W2/W3 shape; W4 the Block 1 deload shape
  function templateBlocks(slot) {
    var b = HP.templateBlocks(slot.type, shapeWeek(slot));
    if (slot.type === 'INTERVALS') {
      var rounds = (/^(\d+) rounds:/.exec(slot.prescription[1] || '') || [])[1] | 0;
      var have = b.filter(function (x) { return x.kind === 'walk'; }).length;
      for (var r = have + 1; r <= rounds && r <= 6; r++) {
        var at = b.map(function (x) { return x.kind; }).lastIndexOf('walk') + 1;
        b.splice(at, 0, { kind: 'run', label: 'Round ' + r + ' run' }, { kind: 'skierg', label: 'Round ' + r + ' SkiErg', machine: true }, { kind: 'walk', label: 'Round ' + r + ' walk rest' });
      }
    }
    if (slot.type === 'STRENGTH_A' && /Romanian deadlift/.test(slot.prescription.join(' '))) b.forEach(function (x) { if (x.exercise === 'Back extension') { x.exercise = 'Romanian deadlift'; x.label = 'Romanian deadlift'; } });
    return b;
  }
  function variantPrescription(slot, variant) {
    if (!slot || !isBlockSlotId(slot.id)) return null;
    var p = HP.variantPrescription(HP.SLOTS.filter(function (s) { return s.week === shapeWeek(slot) && s.day === slot.day; })[0].id, variant);
    if (!p) return null;
    p = clone(p);
    p.slotId = slot.id; p.week = slot.week;
    if (variant === 'ORIGINAL_60') { p.prescription = slot.prescription.slice(); p.blocks = templateBlocks(slot); }
    else p.prescription = p.prescription.map(function (l) { return l.replace(/\(BENCHMARK [12]\)|\(repeat W2 exactly — BENCHMARK 2\)/g, '').replace(/\s{2,}/g, ' '); });
    if (slot.benchmark && variant !== 'ORIGINAL_60') p.prescription.push('Benchmark 3 needs the full session: this fallback is not benchmark-comparable.');
    return p;
  }
  var FAMILY = { STRENGTH_A: 'STRENGTH', STRENGTH_B: 'STRENGTH', INTERVALS: 'HYROX', AEROBIC: 'HYROX', RACE: 'HYROX' };
  // The data layer's fallback-family check only knows v2.1 ids; this is the same check for block slots (UI save guard).
  function variantFamilyError(slot, variantKind) {
    if (!slot || !variantKind) return null;
    var fam = FAMILY[slot.type];
    if (fam === 'STRENGTH' && (variantKind === 'MAIN_CIRCUIT_45' || variantKind === 'HYROX_25')) return 'A HYROX fallback cannot be logged against a planned strength session.';
    if (fam === 'HYROX' && (variantKind === 'MAIN_LIFT_45' || variantKind === 'STRENGTH_25')) return 'A strength fallback cannot be logged against a planned HYROX session.';
    return null;
  }
  // 15-minute cap: every continuous row / SkiErg / bike / elliptical / treadmill bout named in a prescription line.
  function machineMinutes(lines) {
    var out = [];
    (lines || []).forEach(function (l) {
      var re = /(rower|row|skierg|bike|elliptical|treadmill[^:]*?)[^0-9]{0,12}(\d+) min|(\d+) min (treadmill|bike|elliptical|rower|skierg)/gi, m;
      while ((m = re.exec(l))) out.push(+(m[2] || m[3]));
      var rw = /≤\s*(\d+) min/.exec(l); if (rw) out.push(+rw[1]);
    });
    return out;
  }

  // ---------- lifecycle (pure: each returns {ok, code, text, blocks?, block?}; input arrays are never mutated) ----------
  function compact(iso) { return iso.replace(/-/g, ''); }
  function randId(rand) { var s = ''; var alpha = 'abcdefghijklmnopqrstuvwxyz0123456789'; for (var i = 0; i < 4; i++) s += alpha[Math.floor((rand ? rand() : Math.random()) * 36) % 36]; return s; }
  function startCheck(startDate, today) {
    if (!isIsoDate(startDate)) return res(false, 'NO_DATE', 'Choose a start date.');
    if (dow(startDate) !== 1) return res(false, 'START_NOT_MONDAY', 'A block starts on a Monday.');
    if (startDate < FIRST_START) return res(false, 'EARLY_START', 'No early start: Block 1 (with its deload) runs to ' + HP.human(HP.BLOCK_END) + '. The earliest start is ' + HP.human(FIRST_START) + '.');
    if (startDate < today) return res(false, 'START_IN_PAST', 'That Monday has passed. Choose a later Monday (days before the start are not counted).');
    return res(true, 'OK', 'Starts ' + HP.human(startDate) + ', ends ' + HP.human(addDays(startDate, WEEKS * 7 - 1)) + '.');
  }
  function mondaysFrom(today, n) {
    var d = today > FIRST_START ? today : FIRST_START; while (dow(d) !== 1) d = addDays(d, 1);
    var out = []; for (var i = 0; i < (n || 6); i++) out.push(addDays(d, i * 7));
    return out;
  }
  function createDraft(raw, startDate, today, nowIso, rand) {
    raw = Array.isArray(raw) ? raw : [];
    if (raw.length >= MAX_BLOCKS) return res(false, 'TOO_MANY', 'There are already ' + MAX_BLOCKS + ' plan blocks. Delete an unused draft first.');
    var sc = startCheck(startDate, today); if (!sc.ok) return sc;
    var id; do { id = 'b-' + compact(startDate) + '-' + randId(rand); } while (blockById(raw, id));
    var options = normOptions({});
    var slots = buildSlots(id, startDate, options);
    var b = { id: id, label: 'Block 2', templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION, templateHash: contentHash(slots), state: 'DRAFT',
      startDate: startDate, endDate: addDays(startDate, WEEKS * 7 - 1), weeks: WEEKS, deloadWeek: DELOAD_WEEK,
      schedule: { preset: 'STANDARD_MON_FRI', MON: SCHEDULE.MON, TUE: SCHEDULE.TUE, WED: SCHEDULE.WED, THU: SCHEDULE.THU, FRI: SCHEDULE.FRI },
      options: options, slots: slots, revisions: [], events: [], approval: null, createdAt: nowIso, activatedAt: null, cancelledAt: null, endedEarlyOn: null };
    return res(true, 'CREATED', 'Draft saved. It has no effect on Today, logging or any rule until you activate it.', { block: b, blocks: raw.concat([b]) });
  }
  function replaceBlock(raw, b) { return raw.map(function (x) { return x && x.id === b.id ? b : x; }); }
  function setOptions(raw, id, options, today) {
    var b = blockById(raw, id);
    if (!b || validateBlock(b).length) return res(false, 'NOT_FOUND', 'Draft not found.');
    if (b.state !== 'DRAFT') return res(false, 'NOT_DRAFT', 'Only a draft can be changed. An activated block is revised session by session.');
    var n = normOptions(options);
    if (chosenOptions(n).length && today < DECISION_FROM) return res(false, 'OPTIONS_LOCKED', 'Progression options open on ' + HP.human(DECISION_FROM) + ', after Benchmark 2. Until then the draft stays at Hold.');
    if (!bothIncreases(n)) n.bothConfirmed = false;
    var nb = clone(b); nb.options = n; nb.slots = buildSlots(b.id, b.startDate, n); nb.templateHash = contentHash(nb.slots); nb.approval = null;
    return res(true, 'UPDATED', chosenOptions(n).length ? 'Options applied to the draft. Review the preview again.' : 'Draft set to Hold everywhere.', { block: nb, blocks: replaceBlock(raw, nb) });
  }
  function deleteDraft(raw, id) {
    var b = blockById(raw, id);
    if (!b) return res(false, 'NOT_FOUND', 'Draft not found.');
    if (b.state !== 'DRAFT') return res(false, 'NOT_DRAFT', 'Only a draft can be deleted. An activated block is kept for the record (cancel or end it instead).');
    return res(true, 'DELETED', 'Draft deleted.', { blocks: raw.filter(function (x) { return x !== b; }) });
  }
  function activationCheck(raw, id, today, opts) {
    opts = opts || {};
    var b = blockById(raw, id);
    if (!b) return res(false, 'NOT_FOUND', 'Draft not found.');
    var errs = validateBlock(b); if (errs.length) return res(false, 'INVALID', 'This draft is damaged: ' + errs[0].message);
    if (b.state === 'ACTIVATED') return res(false, 'ALREADY_ACTIVE', 'This block is already active. Nothing was changed.');
    if (b.state !== 'DRAFT') return res(false, 'NOT_DRAFT', 'Only a draft can be activated.');
    if (today < DECISION_FROM) return res(false, 'BEFORE_DECISION_DATE', 'Activation opens on ' + HP.human(DECISION_FROM) + ', after Benchmark 2. Final content stays pending your approval until then.');
    var sc = startCheck(b.startDate, today); if (!sc.ok) return sc;
    var clash = activated(raw.filter(function (x) { return !validateBlock(x).length; })).filter(function (x) { return x.id !== b.id && !(lastDay(x) < b.startDate || x.startDate > b.endDate); })[0];
    if (clash) return res(false, 'OVERLAP', 'Another active block (' + (clash.label || clash.id) + ', ' + clash.startDate + ' to ' + lastDay(clash) + ') covers these dates. Blocks never overlap.');
    if (b.startDate <= HP.BLOCK_END) return res(false, 'OVERLAP', 'Block 1 runs to ' + HP.BLOCK_END + '. Blocks never overlap.');
    if (bothIncreases(b.options) && b.options.bothConfirmed !== true) return res(false, 'BOTH_NOT_CONFIRMED', BOTH_WARNING);
    if (opts.approved !== true) return res(false, 'CONTENT_NOT_APPROVED', 'Tick "I approve this content" after reviewing the preview.');
    if (opts.previewHash && opts.previewHash !== contentHash(b.slots)) return res(false, 'STALE', 'The draft changed since the preview. Review it again.');
    return res(true, 'OK', 'Ready to activate.');
  }
  function activate(raw, id, today, nowIso, opts) {
    var c = activationCheck(raw, id, today, opts); if (!c.ok) return c;
    var nb = clone(blockById(raw, id));
    nb.state = 'ACTIVATED'; nb.activatedAt = nowIso;
    nb.approval = { at: nowIso, text: 'Owner approved this Block 2 content (' + TEMPLATE_VERSION + (chosenOptions(nb.options).length ? ', options ' + chosenOptions(nb.options).join('+') : ', Hold') + ') and activated it.' };
    return res(true, 'ACTIVATED', 'Activated. ' + (nb.startDate > today ? 'It starts ' + HP.human(nb.startDate) + '.' : 'It starts today.'), { block: nb, blocks: replaceBlock(raw, nb) });
  }
  function cancel(raw, id, today, nowIso) {
    var b = blockById(raw, id);
    if (!b || b.state !== 'ACTIVATED') return res(false, 'NOT_ACTIVE', 'Only an active block can be cancelled.');
    if (today >= b.startDate) return res(false, 'STARTED', 'This block has started. Use "End early" instead; logged sessions stay as they are.');
    var nb = clone(b); nb.state = 'CANCELLED'; nb.cancelledAt = nowIso;
    return res(true, 'CANCELLED', 'Cancelled before it started. The record is kept.', { block: nb, blocks: replaceBlock(raw, nb) });
  }
  function endEarly(raw, id, today) {
    var b = blockById(raw, id);
    if (!b || b.state !== 'ACTIVATED') return res(false, 'NOT_ACTIVE', 'Only an active block can be ended.');
    if (today < b.startDate) return res(false, 'NOT_STARTED', 'This block has not started. Cancel it instead.');
    var from = addDays(today, 1);
    if (from > b.endDate || b.endedEarlyOn) return res(false, 'NOTHING_LEFT', 'Nothing is left to end.');
    var nb = clone(b); nb.endedEarlyOn = from;
    return res(true, 'ENDED_EARLY', 'Ended. From ' + HP.human(from) + ' its sessions show as "not in plan" (not missed, not skipped). Everything you logged is kept.', { block: nb, blocks: replaceBlock(raw, nb) });
  }
  function eventCheck(b, kind, week, today) {
    if (!b || b.state !== 'ACTIVATED') return res(false, 'NOT_ACTIVE', 'This block is not active.');
    if (EVENT_KINDS.indexOf(kind) === -1 || !(week >= 1 && week <= WEEKS)) return res(false, 'INVALID', 'Unknown missed-day change.');
    var day = kind === 'MISSED_MONDAY' ? 'MON' : 'WED', slot = effectiveSlots(b).filter(function (s) { return s.week === week && s.day === day; })[0];
    if (slot.date > today) return res(false, 'FUTURE', 'A future session cannot be marked missed.');
    if (slot.plannedRest || slot.notInPlan) return res(false, 'NOT_PLANNED', 'That day is not a planned session.');
    if ((b.events || []).some(function (e) { return e.week === week && e.kind === kind; })) return res(false, 'ALREADY', 'Already marked.');
    return res(true, 'OK', 'OK', { slot: slot });
  }
  function addEvent(raw, id, kind, week, today, nowIso, rand) {
    var b = blockById(raw, id), c = eventCheck(b, kind, week, today); if (!c.ok) return c;
    var nb = clone(b);
    nb.events.push({ id: 'ev-' + randId(rand) + randId(rand), kind: kind, week: week, date: c.slot.date, createdAt: nowIso });
    return res(true, 'ADDED', 'Source cascade applied for this block only.', { block: nb, blocks: replaceBlock(raw, nb) });
  }
  function removeEvent(raw, id, eventId) {
    var b = blockById(raw, id); if (!b) return res(false, 'NOT_FOUND', 'Block not found.');
    var nb = clone(b), before = nb.events.length; nb.events = nb.events.filter(function (e) { return e.id !== eventId; });
    if (nb.events.length === before) return res(false, 'NOT_FOUND', 'Nothing to remove.');
    return res(true, 'REMOVED', 'Cascade removed.', { block: nb, blocks: replaceBlock(raw, nb) });
  }
  // D10: only a FUTURE slot (after today, Asia/Qatar) with NO session record of any status can be revised.
  function revisionCheck(b, slotId, kind, sessions, today, text) {
    if (!b || b.state !== 'ACTIVATED') return res(false, 'NOT_ACTIVE', 'Only an active block can be revised.');
    var slot = effectiveSlots(b).filter(function (s) { return s.id === slotId; })[0];
    if (!slot) return res(false, 'UNKNOWN_SLOT', 'Unknown session.');
    if (REVISION_KINDS.indexOf(kind) === -1) return res(false, 'UNKNOWN_KIND', 'Choose how to revise it.');
    if (slot.date <= today) return res(false, 'NOT_FUTURE', 'Only future sessions can be revised. Today and past sessions keep their plan; log what you actually did.');
    if (slot.notInPlan) return res(false, 'NOT_IN_PLAN', 'This session is after the early end.');
    if (linked(slotId, sessions).length) return res(false, 'HAS_RECORD', 'A workout record already exists for this session, so its plan is kept as it was.');
    if (kind === 'OWNER_TEXT') {
      if (slot.week === DELOAD_WEEK) return res(false, 'DELOAD_NO_UPWARD', 'The deload week cannot get owner-written content (no upward change). Use rest, low-impact, reduced volume or a fallback.');
      var lines = String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      if (!lines.length || lines.length > 8 || lines.some(function (l) { return l.length > 280; })) return res(false, 'TEXT', 'Write 1–8 lines (up to 280 characters each).');
    }
    if ((kind === 'FALLBACK_45' || kind === 'FALLBACK_25') && !variantPrescription(slot, kind === 'FALLBACK_45' ? 'SOURCE_45_MIN' : 'SOURCE_25_MIN')) return res(false, 'NO_FALLBACK', 'No source fallback for this session.');
    return res(true, 'OK', 'OK', { slot: slot });
  }
  function revisionLines(slot, kind, text, today) {
    if (kind === 'PLANNED_REST') return ['Planned rest (set by you on ' + HP.humanShort(today) + ', before the day). Not a skip, not missed, not a source omission.', 'Easy walk or mobility only if you feel like it.'];
    if (kind === 'LOW_IMPACT') return LOW_IMPACT[slot.type].slice();
    if (kind === 'REDUCED_VOLUME') return REDUCED.concat(['Planned session for reference: ' + slot.title]);
    if (kind === 'FALLBACK_45' || kind === 'FALLBACK_25') return ['Planned as the source ' + (kind === 'FALLBACK_45' ? '45' : '25') + '-minute fallback (your choice):'].concat(variantPrescription(slot, kind === 'FALLBACK_45' ? 'SOURCE_45_MIN' : 'SOURCE_25_MIN').prescription).slice(0, 12);
    return ['Owner-written (not source, not reviewed):'].concat(String(text).split('\n').map(function (l) { return l.trim(); }).filter(Boolean));
  }
  function revise(raw, id, slotId, kind, text, sessions, today, nowIso, rand) {
    var b = blockById(raw, id), c = revisionCheck(b, slotId, kind, sessions, today, text); if (!c.ok) return c;
    var nb = clone(b);
    nb.revisions.push({ id: 'rv-' + randId(rand) + randId(rand), slotId: slotId, kind: kind, at: nowIso, after: { prescription: revisionLines(c.slot, kind, text, today) }, note: null });
    return res(true, 'REVISED', 'Future session revised. The original plan is kept in the block history.', { block: nb, blocks: replaceBlock(raw, nb) });
  }

  // ---------- preview (what the owner reviews before confirming) ----------
  function preview(b) {
    var slots = effectiveSlots(b), b1 = HP.SLOTS;
    return { blockId: b.id, label: b.label || 'Block 2', state: b.state, draftLabel: b.state === 'DRAFT' ? DRAFT_LABEL : null, startDate: b.startDate, endDate: b.endDate,
      options: normOptions(b.options), chosen: chosenOptions(b.options), bothWarning: bothIncreases(b.options) ? BOTH_WARNING : null, contentHash: contentHash(b.slots),
      weeks: [1, 2, 3, 4].map(function (w) {
        return { week: w, deload: w === DELOAD_WEEK, days: slots.filter(function (s) { return s.week === w; }).map(function (s) {
          var ref = b1.filter(function (x) { return x.week === (w === DELOAD_WEEK ? 4 : w === 1 ? 2 : 3) && x.day === s.day; })[0];
          return { slot: s, possibleClosure: POSSIBLE_CLOSURES[s.date] || null, block1Ref: ref.id, sameAsBlock1Ref: JSON.stringify(ref.prescription) === JSON.stringify(s.prescription) };
        }), weekend: weekendOptions(b, w) };
      }),
      rules: ['Every continuous rower, SkiErg, bike, elliptical or treadmill bout ≤ 15 min (returning after changing equipment is fine).',
        'Missed Monday / Wednesday: the source cascade only when you mark it. Both missed: unresolved, decide manually. Missed Friday: skip, no weekend make-up.',
        'Never stack two hard sessions on one day. Optional Saturday / Sunday activity is never counted and never a make-up.',
        'Readiness: 1 flag → reduce volume 20–30%; 2+ flags → easy movement only. Stop for pain > 3/10, gait change, swelling or next-morning worsening.',
        'Stop immediately and get urgent care (999 in Qatar) for chest pain/pressure, disproportionate breathlessness, fainting, severe dizziness or concerning palpitations.',
        'Steps: no plan reference goal in this block (ST0) — adaptive guidance only; 10,000/day is not assumed.',
        'Hold never raises loads by itself. No automatic progression and no automatic next block.'] };
  }

  // ---------- one store helper: field-preserving settings write (re-reads storage at write time) ----------
  // mutate(rec) changes ONLY the caller's own fields on a fresh copy of the stored record; every other field
  // (myFoods, favFoods, planBlocks, later-version fields) is carried exactly as stored.
  function writeSettings(store, HD, today, mutate, opts) {
    opts = opts || {};
    var bad = (typeof store.damagedRecords === 'function' ? store.damagedRecords() : []).some(function (d) { return d.collection === 'ownerSettings'; });
    if (bad) return { ok: false, code: 'SETTINGS_DAMAGED', errors: { settings: 'Your saved settings need attention first (Settings). Nothing was changed.' } };
    var cur = store.settings().record;
    if (opts.expectStamp !== undefined && stampOf(cur) !== opts.expectStamp)
      return { ok: false, code: 'STALE', errors: { stale: 'Your plan changed since you opened this screen (another tab or a save). Nothing was changed; review it again.' } };
    var rec = cur ? clone(cur) : { id: HD.SETTINGS_ID };
    if (!rec.date) rec.date = today;
    var r = mutate(rec);
    if (r && r.ok === false) return r;
    return store.putRecord('ownerSettings', rec);
  }
  // Stamp = checksum of the whole stored settings record: any change by another tab or writer (even in the same millisecond) changes it.
  function stampOf(rec) { return rec ? checksum(JSON.stringify(rec)) + ':' + JSON.stringify(rec).length : 'none'; }
  function settingsStamp(store) { return stampOf(store.settings().record); }
  // Applies a lifecycle function to the stored planBlocks list, keeping invalid entries exactly as stored.
  function writeBlocks(store, HD, today, fn, opts) {
    var out = null;
    var w = writeSettings(store, HD, today, function (rec) {
      if (rec.planBlocks !== undefined && rec.planBlocks !== null && !Array.isArray(rec.planBlocks)) return { ok: false, code: 'PLAN_BLOCKS_MALFORMED', errors: { planBlocks: 'The saved plan blocks are damaged. Nothing was changed; export a backup and ask for a repair.' } };
      var r = fn(Array.isArray(rec.planBlocks) ? rec.planBlocks.slice() : []);
      if (!r.ok) return { ok: false, code: r.code, errors: { plan: r.text } };
      out = r;
      if (r.blocks.length) rec.planBlocks = r.blocks; else delete rec.planBlocks;
      return null;
    }, opts);
    if (!w.ok) return w;
    return Object.assign({}, out, { ok: true, entry: w.entry });
  }
  // Damaged-settings repair: which stored fields to carry over unchanged (everything except the bad fields and the
  // fields the repair form sets itself). Each carried field is kept only if the repaired record still validates.
  function repairCarry(rawRec, problemFields, ownFields, HD, today) {
    var skip = ['id', 'createdAt', 'updatedAt', 'revisions', 'date'].concat(problemFields || [], ownFields || []);
    var carry = {}, dropped = [];
    if (!isObj(rawRec)) return { carry: carry, dropped: dropped };
    Object.keys(rawRec).forEach(function (k) {
      if (skip.indexOf(k) !== -1) return;
      var test = { id: HD.SETTINGS_ID, date: today, createdAt: '2026-01-01T00:00:00.000Z' }; test[k] = rawRec[k];
      if (HD.validateExtRecord('ownerSettings', test, '9999-12-31').length) dropped.push(k); else carry[k] = clone(rawRec[k]);
    });
    return { carry: carry, dropped: dropped };
  }
  // Restore preview: what replacing this device's data does to its plan blocks.
  function restoreNote(currentRawText, importText) {
    function blocksIn(text) {
      try { var o = JSON.parse(text || 'null'); var s = o && Array.isArray(o.ownerSettings) ? o.ownerSettings.filter(function (x) { return x && x.id === 'app-settings'; })[0] : null;
        return s && Array.isArray(s.planBlocks) ? s.planBlocks.filter(isObj) : []; } catch (e) { return []; }
    }
    var cur = blocksIn(currentRawText), inc = blocksIn(importText);
    function desc(list) { var a = list.filter(function (b) { return b.state === 'ACTIVATED'; }).length, d = list.filter(function (b) { return b.state === 'DRAFT'; }).length; return a + ' active and ' + d + ' draft'; }
    if (!cur.length && !inc.length) return null;
    var same = JSON.stringify(cur) === JSON.stringify(inc);
    if (same) return null;
    if (cur.length && !inc.length) return 'This device has Block 2 plan data (' + desc(cur) + ' block(s)); this backup has none (it may be from an older version). Restoring removes Block 2 from this device. Logged workouts in the backup are kept as they are in it. Export a backup first if unsure.';
    return 'Plan blocks differ: this device has ' + desc(cur) + ', the backup has ' + desc(inc) + '. Restoring replaces this device\'s plan blocks with the backup\'s.';
  }

  return { TEMPLATE_ID: TEMPLATE_ID, TEMPLATE_VERSION: TEMPLATE_VERSION, FIRST_START: FIRST_START, DECISION_FROM: DECISION_FROM, DRAFT_LABEL: DRAFT_LABEL,
    POSSIBLE_CLOSURES: POSSIBLE_CLOSURES, OPTION_GROUPS: OPTION_GROUPS, REVISION_KINDS: REVISION_KINDS, BOTH_WARNING: BOTH_WARNING, SLOT_ID_RE: SLOT_ID_RE,
    holdLines: holdLines, buildSlots: buildSlots, contentHash: contentHash, checksum: checksum, normOptions: normOptions, chosenOptions: chosenOptions, bothIncreases: bothIncreases,
    validateBlock: validateBlock, readBlocks: readBlocks, activated: activated, lastDay: lastDay, blockById: blockById, effectiveSlots: effectiveSlots,
    blockForDate: blockForDate, nextBlockAfter: nextBlockAfter, isBlockSlotId: isBlockSlotId, slotById: slotById, blockOfSlot: blockOfSlot, weekOf: weekOf, blockStatus: blockStatus,
    effectiveWeek: effectiveWeek, omissionFor: omissionFor, cascadeConflicts: cascadeConflicts, slotStatus: slotStatus, summary: summary, benchmarks: benchmarks, isDemanding: isDemanding,
    plannedOn: plannedOn, rescheduledOn: rescheduledOn, rescheduleCheck: rescheduleCheck, rescheduleDates: rescheduleDates, skipAdvice: skipAdvice,
    templateBlocks: templateBlocks, variantPrescription: variantPrescription, variantFamilyError: variantFamilyError, machineMinutes: machineMinutes,
    startCheck: startCheck, mondaysFrom: mondaysFrom, createDraft: createDraft, setOptions: setOptions, deleteDraft: deleteDraft, activationCheck: activationCheck, activate: activate,
    cancel: cancel, endEarly: endEarly, eventCheck: eventCheck, addEvent: addEvent, removeEvent: removeEvent, revisionCheck: revisionCheck, revise: revise, preview: preview,
    writeSettings: writeSettings, settingsStamp: settingsStamp, writeBlocks: writeBlocks, repairCarry: repairCarry, restoreNote: restoreNote };
});
