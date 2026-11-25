/*
 * hyrox-fibersodium.js - Phase 11.3: optional fiber (g) and sodium (mg) per meal item and per day.
 * Pure functions, no storage, no network. UMD: window.HyroxFiberSodium / module.exports.
 *
 * Stored on a meal component as optional fields in the same shape as the macros: fiberG / sodiumMg = {value, state}
 * (state KNOWN | ESTIMATED). Absent, UNKNOWN, null or invalid = unknown - never 0. A real 0 (e.g. USDA's 0 g fiber for
 * eggs) is a known 0. These fields never change kcal/macros, day states (D1-D5), averages or any target; there are no
 * fiber or sodium targets.
 *
 * Per item: value x eaten fraction, applied ONCE (item fraction, else the meal fraction, else 1; a photographed meal
 * with no stated fraction is unknown) - the same rule as hyrox-nutrition.js mealTotals.
 * Per day (CONFIRMED meals only; an item with eaten fraction 0 was not consumed and is left out):
 *   NONE      no confirmed consumed item
 *   UNKNOWN   none of them has the nutrient quantified
 *   PARTIAL   some have it          -> "known subtotal — incomplete" (k of n items)
 *   SO_FAR    all have it, but the day is not marked complete -> "so far"
 *   COMPLETE  all have it AND the day is marked complete (day state D4 or D5)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HyroxFiberSodium = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var KEYS = ['fiberG', 'sodiumMg'];
  var LIMIT = { fiberG: 500, sodiumMg: 100000 };
  var NAME = { fiberG: 'Fiber', sodiumMg: 'Sodium' }, UNIT = { fiberG: 'g', sodiumMg: 'mg' };

  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function round(k, n) { return k === 'sodiumMg' ? Math.round(n) : Math.round(n * 10) / 10; }
  // The quantified value of one item, or null (unknown).
  function itemValue(c, k) {
    var m = c && c[k];
    if (!m || typeof m !== 'object' || m.state === 'UNKNOWN' || !isNum(m.value) || m.value < 0 || m.value > LIMIT[k]) return null;
    return { value: m.value, state: m.state === 'KNOWN' ? 'KNOWN' : 'ESTIMATED' };
  }
  function eatenFractionOf(meal, c) {
    if (c && typeof c.eatenFraction === 'number') return c.eatenFraction;
    if (meal && typeof meal.eatenFraction === 'number') return meal.eatenFraction;
    return meal && meal.source === 'PHOTO_AI' ? null : 1;
  }
  function addMeal(acc, meal, k) {
    (meal.components || []).forEach(function (c) {
      var f = eatenFractionOf(meal, c);
      if (f === 0) return;                       // not consumed
      acc.items++;
      var v = itemValue(c, k);
      if (!v || f === null) return;              // unknown item (or unstated photo fraction)
      acc.known++; acc.sum += v.value * f; if (v.state === 'ESTIMATED') acc.estimated++;
    });
    return acc;
  }
  function mealTotal(meal, k) {
    var a = addMeal({ sum: 0, known: 0, items: 0, estimated: 0 }, meal, k);
    return finish(a, k, false);
  }
  function finish(a, k, dayComplete) {
    var state = !a.items ? 'NONE' : !a.known ? 'UNKNOWN' : a.known < a.items ? 'PARTIAL' : dayComplete ? 'COMPLETE' : 'SO_FAR';
    return { key: k, state: state, value: a.known ? round(k, a.sum) : null, known: a.known, items: a.items, estimated: a.estimated };
  }
  // meals: all meals (any date); dayState: HyroxNutrition.dayState(...) for that date (for "complete").
  function dayTotal(meals, date, k, dayState) {
    var a = { sum: 0, known: 0, items: 0, estimated: 0 };
    (meals || []).forEach(function (m) { if (m && m.date === date && m.lifecycle === 'CONFIRMED') addMeal(a, m, k); });
    var complete = !!dayState && (dayState.code === 'D4' || dayState.code === 'D5');
    return finish(a, k, complete);
  }
  function fmtNum(k, v) { return k === 'sodiumMg' ? String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(Math.round(v * 10) / 10); }
  function text(t) {
    var n = NAME[t.key], u = UNIT[t.key], cnt = ' (' + t.known + ' of ' + t.items + (t.items === 1 ? ' item' : ' items') + ' known' + (t.estimated ? ', estimates included' : '') + ')';
    if (t.state === 'NONE') return n + ': nothing confirmed';
    if (t.state === 'UNKNOWN') return n + ': unknown' + cnt;
    var v = fmtNum(t.key, t.value) + ' ' + u;
    if (t.state === 'PARTIAL') return n + ': ' + v + ' known subtotal — incomplete' + cnt;
    if (t.state === 'SO_FAR') return n + ': ' + v + ' so far' + cnt;
    return n + ': ' + v + ' — complete day total' + cnt;
  }
  return { KEYS: KEYS, LIMIT: LIMIT, NAME: NAME, UNIT: UNIT, itemValue: itemValue, eatenFractionOf: eatenFractionOf, mealTotal: mealTotal, dayTotal: dayTotal, text: text, fmtNum: fmtNum };
});
