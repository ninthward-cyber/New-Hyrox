/*
 * hyrox-foodsearch.js - Phase 11.2: local food search ("Add foods") over the bundled USDA FoodData Central database (CC0)
 * plus the owner's own saved foods. Pure functions, offline, deterministic. No storage, no network, no AI, no cost.
 * UMD: window.HyroxFoodSearch / module.exports.
 *
 * Ranking: exact name / alias first, then names whose first part (before the comma) holds the typed words, then token
 * coverage. Every typed word must match (exactly, as a prefix, through a common-US-name synonym, or within a small typo
 * distance). Recently CONFIRMED foods and favourites get a small boost but are never chosen automatically: search only
 * returns a ranked list; the owner taps one, picks a serving and quantity, and adds it to the meal draft.
 * The index lives in memory only (built from the static food-db.js); nothing here goes to localStorage.
 * Values are USDA reference-food ESTIMATES per 100 g scaled by grams, rounded like hyrox-foodcalc.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HyroxFoodSearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_RESULTS = 25, MAX_QUERY = 80, MAX_MY_FOODS = 200, MAX_QTY = 50;
  var MACRO_LIMIT = { kcal: 10000, proteinG: 1000, carbsG: 2000, fatG: 1000 };
  // Phase 11.3: optional per-item fiber / sodium (same {value, state} shape as macros; absent or UNKNOWN = unknown, never 0).
  var EXTRA = ['fiberG', 'sodiumMg'], EXTRA_LIMIT = { fiberG: 500, sodiumMg: 100000 };
  var STOP = { of: 1, the: 1, a: 1, an: 1, 'with': 1, and: 1, 'in': 1, 'for': 1, to: 1, or: 1 };
  // Common US words -> words USDA uses in descriptions. Each typed word may match itself OR one of these.
  // RC2 review: search-only shortcuts (offered first, labelled, never chosen by themselves). They are added after the
  // estimator's aliases (hyrox-foodcalc.js ALIASES, unchanged) and never override one. A shortcut whose food is not loaded
  // (the US list is optional) is simply absent.
  var SEARCH_ALIASES = [
    [['fries', 'french fries', 'french fry', 'potato fries', 'chips and fries'], 'FN', 2709456, null, 'Plain French fries (USDA survey, not further specified). Type a restaurant name, "sweet potato fries" or "home fries" for others.'],
    [['burger', 'burgers', 'hamburger', 'hamburgers'], 'FN', 2706920, null, 'Plain hamburger (USDA survey, not further specified). Type "cheeseburger", "veggie burger" or a restaurant name for others.']
  ];
  var SYNONYMS = {
    burger: ['hamburger', 'cheeseburger', 'burger'], soda: ['carbonated', 'cola', 'soda'],
    pop: ['carbonated', 'cola'], coke: ['cola'], ketchup: ['catsup', 'ketchup'], hotdog: ['frankfurter'], frank: ['frankfurter'],
    nugget: ['nugget', 'nuggets'], chip: ['chip', 'chips'], latte: ['latte', 'coffee'],
    mcdonald: ['mcdonald'], mcdonalds: ['mcdonald'], bk: ['burger', 'king'], sub: ['sub', 'submarine', 'subway'], hoagie: ['submarine'],
    yoghurt: ['yogurt'], yogurt: ['yogurt'], doughnut: ['doughnut', 'donut'], donut: ['doughnut', 'donut'], oatmeal: ['oatmeal', 'oat'],
    chickpea: ['chickpea', 'garbanzo'], garbanzo: ['garbanzo', 'chickpea'], zucchini: ['zucchini', 'squash'], cilantro: ['coriander', 'cilantro'],
    scallion: ['onion', 'scallion'], shrimp: ['shrimp', 'crustacean'], tuna: ['tuna', 'fish'], salmon: ['salmon', 'fish']
  };

  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function round1(n) { return Math.round(n * 10) / 10; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function cap(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }
  function stem(t) {
    if (t.length > 4 && /ies$/.test(t)) return t.slice(0, -3) + 'y';
    if (t.length > 4 && /(oes|ches|shes|sses|xes)$/.test(t)) return t.slice(0, -2);
    if (t.length > 3 && /[^su]s$/.test(t)) return t.slice(0, -1);
    return t;
  }
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/['\u2019]s\b/g, 's').replace(/[\u2019']/g, '').replace(/[^a-z0-9%]+/g, ' ').replace(/^ +| +$/g, ''); }
  function tokens(s) {
    var m = norm(s).split(' '), out = [], seen = Object.create(null);
    for (var i = 0; i < m.length; i++) {
      if (!m[i] || m[i].length < 2 && !/\d/.test(m[i])) continue;
      var t = stem(m[i]);
      if (STOP[t] || seen[t]) continue;
      seen[t] = 1; out.push(t);
    }
    return out;
  }
  // Damerau-Levenshtein (adjacent swap) with an early cut-off at `max`.
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev2 = null, prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i]; var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v; if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev; prev = cur;
    }
    return prev[b.length];
  }
  function typoMax(len) { return len >= 8 ? 2 : len >= 4 ? 1 : 0; }

  // ---------- index ----------
  // Phase 11.3: `us` (optional) is window.HyroxFoodDbUs (food-db-us.js): FNDDS 2021-2023 rows (dataset "FN") added AFTER the
  // original 8,167 rows (which are never changed or removed), and per-100 g fiber/sodium for SR/FF rows. Without it the index
  // is exactly the Phase 11.2 one. fs = [fiberG, sodiumMg] per 100 g, each null when USDA gives no value (unknown, never 0).
  function fsNum(v) { return isNum(v) && v >= 0 ? v : null; }
  function buildIndex(db, aliases, us) {
    if (!db || !db.meta || !Array.isArray(db.foods)) return { ok: false, message: 'The food database is not loaded.' };
    var ix = { ok: true, dbVersion: db.meta.dbVersion, foods: [], byKey: Object.create(null), post: Object.create(null), vocab: [], alias: Object.create(null), aliasList: [],
      baseCount: db.foods.length, usCount: 0, usVersion: null };
    function addRec(f, dbVersion, fs) {
      var name = String(f[2]), parts = name.split(','), head = parts[0].replace(/\s*\(.*\)\s*$/, ''), brand = null;
      // RC2 review: in a chain item ("BURGER KING, Onion Rings", "Big Mac (McDonalds)") the brand is not the food. The
      // leading food words are the item after the brand, and the brand words are kept apart (see search: brandToks).
      if (f[1] !== 'FN' && isRestaurant(name) && parts.length > 1) { brand = parts[0]; head = parts[1]; }
      else if (f[1] === 'FN') { var fm = FN_CHAINS.exec(name); if (fm) brand = fm[1]; }
      var rec = { key: f[1] + ':' + f[0], dataset: f[1], fdcId: f[0], name: name, nameN: norm(name), toks: tokens(name), headToks: tokens(head), per100: [f[3], f[4], f[5], f[6]], portions: f[7] || [],
        dbVersion: dbVersion, fs: fs || null, brandToks: brand ? tokens(brand) : null, words: norm(name).split(' ') };
      if (own(ix.byKey, rec.key)) return;
      ix.byKey[rec.key] = ix.foods.length; ix.foods.push(rec);
      for (var t = 0; t < rec.toks.length; t++) { var tk = rec.toks[t]; if (!own(ix.post, tk)) { ix.post[tk] = []; ix.vocab.push(tk); } ix.post[tk].push(ix.foods.length - 1); }
    }
    var fsMap = Object.create(null), usOk = !!(us && us.meta && Array.isArray(us.foods));
    if (usOk && us.fs && typeof us.fs === 'object') ['SR', 'FF'].forEach(function (ds) { (Array.isArray(us.fs[ds]) ? us.fs[ds] : []).forEach(function (r) { fsMap[ds + ':' + r[0]] = [fsNum(r[1]), fsNum(r[2])]; }); });
    for (var i = 0; i < db.foods.length; i++) { var f0 = db.foods[i]; addRec(f0, db.meta.dbVersion, fsMap[f0[1] + ':' + f0[0]] || null); }
    if (usOk) {
      ix.usVersion = String(us.meta.dbVersion || '');
      us.foods.forEach(function (f) { if (Array.isArray(f) && isNum(f[0]) && f[1] === 'FN' && [3, 4, 5, 6].every(function (j) { return isNum(f[j]); })) { addRec(f, ix.usVersion, [fsNum(f[8]), fsNum(f[9])]); ix.usCount++; } });
    }
    (aliases || []).concat(SEARCH_ALIASES).forEach(function (a) {
      var idx = ix.byKey[a[1] + ':' + a[2]];
      if (idx === undefined) return;
      a[0].forEach(function (n) { var k = norm(n); if (!own(ix.alias, k)) { ix.alias[k] = { idx: idx, label: a[3], note: a[4] || '' }; ix.aliasList.push(k); } });
    });
    return ix;
  }

  // For one typed word: food index -> best weight (1 exact, .9 synonym, .8 prefix, .6 typo) and whether a typo was used.
  function wordHits(ix, w, isLast) {
    var hits = Object.create(null), typo = Object.create(null);
    function add(tok, wt, isTypo) { var l = ix.post[tok]; if (!l) return; for (var i = 0; i < l.length; i++) { if (!(hits[l[i]] >= wt)) { hits[l[i]] = wt; if (isTypo) typo[l[i]] = 1; else delete typo[l[i]]; } } }
    add(w, 1);
    var raw = w.replace(/s$/, '');
    if (own(SYNONYMS, w) || own(SYNONYMS, raw)) (SYNONYMS[w] || SYNONYMS[raw]).forEach(function (s) { add(stem(s), 0.9); });
    var maxD = typoMax(w.length);
    for (var v = 0; v < ix.vocab.length; v++) {
      var tok = ix.vocab[v];
      if (tok === w) continue;
      if ((isLast ? w.length >= 1 : w.length >= 3) && tok.length > w.length && tok.lastIndexOf(w, 0) === 0) { add(tok, 0.8); continue; }
      if (maxD && Math.abs(tok.length - w.length) <= maxD && tok.charAt(0) === w.charAt(0) && editDistance(w, tok, maxD) <= maxD) add(tok, 0.6, true);
    }
    return { hits: hits, typo: typo };
  }

  function servingsFor(ix, key, preferLabel) {
    var f = ix.foods[ix.byKey[key]];
    if (!f) return [];
    var out = [], def = -1;
    f.portions.forEach(function (p, i) {
      if (!(p[0] > 0 && p[2] > 0)) return;
      var unit = String(p[1]), racc = /racc/i.test(unit);
      out.push({ id: 'p' + i, label: (p[0] === 1 ? '1 ' : round2(p[0]) + ' ') + unit, grams: round2(p[2]), racc: racc });
      if (def === -1 && preferLabel && unit === preferLabel) def = out.length - 1;
    });
    if (def === -1) for (var j = 0; j < out.length; j++) if (!out[j].racc) { def = j; break; }
    out.push({ id: 'g100', label: '100 g', grams: 100 });
    out.push({ id: 'oz', label: '1 oz', grams: 28.35 });
    out.push({ id: 'g', label: '1 g', grams: 1 });
    if (def === -1) def = out.length - 3;
    return out.map(function (s, k) { s.isDefault = k === def; return s; });
  }

  function nutrients(ix, key, grams) {
    var f = ix.foods[ix.byKey[key]];
    if (!f || !(grams > 0)) return null;
    var clamped = f.per100[2] < 0;
    var n = { kcal: Math.round(f.per100[0] * grams / 100), proteinG: round1(f.per100[1] * grams / 100), carbsG: round1((clamped ? 0 : f.per100[2]) * grams / 100), fatG: round1(f.per100[3] * grams / 100) };
    if (n.kcal > MACRO_LIMIT.kcal || n.proteinG > MACRO_LIMIT.proteinG || n.carbsG > MACRO_LIMIT.carbsG || n.fatG > MACRO_LIMIT.fatG) return { tooLarge: true };
    n.carbsClamped = clamped;
    // Phase 11.3: fiber (g, 1 decimal) and sodium (mg, whole) scaled by the same grams; null when USDA gives no value.
    n.fiberG = f.fs && f.fs[0] !== null ? round1(f.fs[0] * grams / 100) : null;
    n.sodiumMg = f.fs && f.fs[1] !== null ? Math.round(f.fs[1] * grams / 100) : null;
    if ((n.fiberG !== null && n.fiberG > EXTRA_LIMIT.fiberG) || (n.sodiumMg !== null && n.sodiumMg > EXTRA_LIMIT.sodiumMg)) return { tooLarge: true };
    return n;
  }

  function sourceLabel(dataset) {
    return dataset === 'FF' ? 'USDA Foundation Foods (2026)' : dataset === 'FN' ? 'USDA FNDDS 2021-2023 (survey)' : 'USDA SR Legacy (2018)';
  }
  // US restaurant chains that USDA SR Legacy (2018) lists by name. Labelled so they are never mistaken for current or local menus.
  var RESTAURANTS = ["MCDONALD'S", 'KFC', 'BURGER KING', 'POPEYES', "DENNY'S", "WENDY'S", "WEND'YS", "APPLEBEE'S", 'SUBWAY', 'TACO BELL', 'CRACKER BARREL',
    "T.G.I. FRIDAY'S", 'ON THE BORDER', 'OLIVE GARDEN', "CARRABBA'S ITALIAN GRILL", 'CHICK-FIL-A', 'PIZZA HUT', "ARBY'S", "DOMINO'S", "PAPA JOHN'S", 'LITTLE CAESARS'];
  function isRestaurant(name) { var u = String(name).toUpperCase(); return RESTAURANTS.some(function (r) { return u.lastIndexOf(r, 0) === 0; }); }
  // Phase 11.3: FNDDS names a chain in brackets at the end ("Big Mac (McDonalds)"); generic restaurant-style items say
  // "from fast food" / "restaurant". Both are USDA estimates, never the chain's official figures.
  var FN_CHAINS = /\((mcdonalds|burger king|wendys|kfc|taco bell|subway|pizza hut|dominos|popeyes|arbys|chick-fil-a|starbucks|dunkin)\)\s*$/i;
  function restaurantKind(name, dataset) {
    if (dataset === 'FN') return FN_CHAINS.test(name) ? 'CHAIN' : /fast food|restaurant/i.test(name) ? 'GENERIC' : null;
    if (isRestaurant(name)) return 'CHAIN';
    return /fast food|restaurant/i.test(name) ? 'GENERIC' : null;
  }
  function restaurantBadge(kind, dataset) {
    if (kind === 'CHAIN') return dataset === 'FN' ? 'Chain item · USDA survey estimate (US)' : 'Restaurant · US 2018';
    if (kind === 'GENERIC') return 'Restaurant-style · generic USDA';
    return null;
  }

  // Claude 11.2 review (C-03): a typed count or unit ("2 eggs", "1 can tuna", "chicken 200g", "1.5 tbsp …") is not a
  // food word. Such words are ignored for MATCHING only when at least one other word remains; they never set the
  // quantity (the owner still picks serving and quantity after tapping a food). A query of only numbers searches as typed.
  // Units are ignored only when the query also holds a number ("2 slices pizza"); alone they may describe the food
  // ("slice cheese" -> sliced cheeses).
  var UNIT_WORDS = { g: 1, gr: 1, gram: 1, kg: 1, mg: 1, ml: 1, l: 1, oz: 1, ounce: 1, lb: 1, lbs: 1, pound: 1, cup: 1, tbsp: 1, tablespoon: 1, tsp: 1, teaspoon: 1,
    slice: 1, piece: 1, pc: 1, pcs: 1, serving: 1, can: 1, bowl: 1, plate: 1, handful: 1, glass: 1, scoop: 1, portion: 1, bottle: 1, x: 1 };
  var NUMBER_WORDS = { one: 1, two: 1, three: 1, four: 1, five: 1, six: 1, seven: 1, eight: 1, nine: 1, ten: 1, half: 1, quarter: 1 };
  function isNumberWord(w) { return /^\d+(?:g|gr|kg|mg|ml|l|oz|lb|lbs|x)?$/.test(w) || own(NUMBER_WORDS, w); }
  function isUnitWord(w) { return own(UNIT_WORDS, w) || own(UNIT_WORDS, stem(w)); }
  function foodWords(q) {
    var words = q.split(' ').filter(Boolean), hasNum = words.some(isNumberWord);
    if (!hasNum) return q;
    var kept = words.filter(function (w) { return !isNumberWord(w) && !isUnitWord(w); });
    return kept.length ? kept.join(' ') : q;
  }

  // ---------- search ----------
  // opts: { recentKeys: [key], favKeys: [key], myFoods: [myFood], limit }
  function search(ix, query, opts) {
    opts = opts || {};
    var typed = norm(cap(query, MAX_QUERY)), q = foodWords(typed), qt = tokens(q);
    var hint = q === typed ? [] : typed.split(' ').filter(function (w) { return w.length >= 3 && !isNumberWord(w) && isUnitWord(w); }).map(stem);
    if (!q || !qt.length) return { query: typed, results: [], count: 0 };
    var recent = Object.create(null), fav = Object.create(null);
    (opts.recentKeys || []).forEach(function (k, i) { if (!own(recent, k)) recent[k] = i; });
    (opts.favKeys || []).forEach(function (k) { fav[k] = 1; });
    var out = [];
    // my foods first-class: same word rule over their names
    (opts.myFoods || []).forEach(function (m) {
      var mt = tokens(m.name), all = true, sum = 0;
      qt.forEach(function (w, wi) {
        var best = 0; mt.forEach(function (t) { var s = t === w ? 1 : (t.lastIndexOf(w, 0) === 0 && (wi === qt.length - 1 || w.length >= 3)) ? 0.8 : (typoMax(w.length) && editDistance(w, t, typoMax(w.length)) <= typoMax(w.length)) ? 0.6 : 0; if (s > best) best = s; });
        if (!best) all = false; sum += best;
      });
      if (!all) return;
      var score = 100 * sum / qt.length + (norm(m.name) === q ? 400 : 0) + 60 + (fav['my:' + m.id] ? 15 : 0);
      out.push({ kind: 'MY', key: 'my:' + m.id, id: m.id, name: m.name, score: score, matchType: norm(m.name) === q ? 'exact' : 'match', sourceLabel: 'My food' + (m.basis ? ' · ' + m.basis : ''), favorite: !!fav['my:' + m.id] });
    });
    if (ix && ix.ok) {
      var per = qt.map(function (w, i) { return wordHits(ix, w, i === qt.length - 1); });
      var first = per[0].hits, cand = [];
      for (var k in first) {
        var ok = true;
        for (var j = 1; j < per.length; j++) if (!(per[j].hits[k] > 0)) { ok = false; break; }
        if (ok) cand.push(+k);
      }
      var aliasHit = own(ix.alias, q) ? ix.alias[q] : null;
      // only an "-ies" plural whose stem is another word ("fries" -> "fry" as in "Fry sauce"); other plurals are unchanged
      var rawPlural = q.split(' ').filter(function (w) { return w.length > 4 && /ies$/.test(w) && stem(w) !== w; });
      cand.forEach(function (fi) {
        var f = ix.foods[fi], sum = 0, typo = false;
        per.forEach(function (p) { sum += p.hits[fi]; if (p.typo[fi]) typo = true; });
        var headCover = qt.filter(function (w) { return f.headToks.some(function (t) { return t === w; }); }).length / qt.length;
        var score = 100 * sum / qt.length + 60 * headCover - 3 * Math.max(0, f.toks.length - qt.length);
        if (qt.length > 1 && f.nameN.indexOf(q) !== -1) score += 80; // the typed words, in order, as a phrase
        // Phase 11.3 (larger list): a name whose leading part is exactly the typed food ("Pancakes, NFS" for "pancakes", not
        // "Pancake syrup") ranks up; a dropped unit word that the name spells out ("1 can tuna" -> "..., canned") is a hint.
        if (f.headToks.length && f.headToks.every(function (t) { return qt.indexOf(t) !== -1; })) score += 40;
        if (hint.length && hint.some(function (u) { return f.toks.some(function (t) { return t.lastIndexOf(u, 0) === 0; }); })) score += 70;
        var mt = typo ? 'typo' : 'match';
        if (f.nameN === q) { score += 400; mt = 'exact'; }
        if (aliasHit && aliasHit.idx === fi) { score += 450; mt = 'alias'; }
        // RC2 review: a chain item ranks below plain foods unless a brand word was typed ("mcdonalds fries" still finds it);
        // a typed "-ies" plural that the name spells out ("fries", not just "fry") ranks above a different word with that stem.
        if (f.brandToks && !qt.some(function (w) { return f.brandToks.indexOf(w) !== -1; })) score -= 45;
        if (rawPlural.length && rawPlural.every(function (w) { return f.words.indexOf(w) !== -1; })) score += 30;
        if (own(recent, f.key)) score += 25;
        if (fav[f.key]) score += 15;
        var rk = restaurantKind(f.name, f.dataset);
        out.push({ kind: 'USDA', key: f.key, dataset: f.dataset, name: f.name, score: score, matchType: mt, sourceLabel: sourceLabel(f.dataset), restaurant: rk === 'CHAIN', restaurantKind: rk, restaurantBadge: restaurantBadge(rk, f.dataset),
          recent: own(recent, f.key), favorite: !!fav[f.key], aliasLabel: aliasHit && aliasHit.idx === fi ? aliasHit.label : null, note: aliasHit && aliasHit.idx === fi ? aliasHit.note : '' });
      });
      // an alias whose food did not survive the word filter (e.g. "porridge" -> oatmeal) is still offered first
      if (aliasHit && !out.some(function (r) { return r.kind === 'USDA' && r.key === ix.foods[aliasHit.idx].key; })) {
        var af = ix.foods[aliasHit.idx];
        var ark = restaurantKind(af.name, af.dataset);
        out.push({ kind: 'USDA', key: af.key, dataset: af.dataset, name: af.name, score: 900, matchType: 'alias', sourceLabel: sourceLabel(af.dataset), restaurant: ark === 'CHAIN', restaurantKind: ark, restaurantBadge: restaurantBadge(ark, af.dataset), recent: own(recent, af.key), favorite: !!fav[af.key], aliasLabel: aliasHit.label, note: aliasHit.note });
      }
    }
    out.sort(function (a, b) { return b.score - a.score || (a.name.length - b.name.length) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    var lim = opts.limit || MAX_RESULTS;
    return { query: typed, results: out.slice(0, lim), count: out.length };
  }

  // ---------- components ----------
  function est(v) { return { value: v, state: 'ESTIMATED' }; }
  function usdaComponent(ix, key, serving, qty) {
    var f = ix.foods[ix.byKey[key]];
    if (!f || !serving || !(serving.grams > 0) || !(isNum(qty) && qty > 0 && qty <= MAX_QTY)) return { ok: false, message: 'Choose a serving and a quantity between 0.1 and ' + MAX_QTY + '.' };
    var grams = round2(serving.grams * qty), n = nutrients(ix, key, grams);
    if (!n) return { ok: false, message: 'The quantity is too small to estimate.' };
    if (n.tooLarge) return { ok: false, message: 'The quantity is too large for one item (' + grams + ' g). Check the number.' };
    var portion = (qty === 1 ? '' : round2(qty) + ' × ') + serving.label + ' (' + grams + ' g)';
    var prov = { source: 'USDA_FDC', dataset: f.dataset, fdcId: f.fdcId, description: cap(f.name, 200), portion: cap(portion, 200), grams: grams, dbVersion: cap(f.dbVersion || ix.dbVersion, 80) };
    if (n.carbsClamped) { prov.carbsClampedToZero = true; prov.note = 'USDA lists a slightly negative carbohydrate-by-difference; counted as 0 g.'; }
    var comp = { name: cap(f.name, 80), role: 'OTHER', portion: cap(portion, 80), preparation: '', eatenFraction: null,
      kcal: est(n.kcal), proteinG: est(n.proteinG), carbsG: est(n.carbsG), fatG: est(n.fatG), provenance: prov };
    // Phase 11.3: only a value USDA gives is written (a USDA 0 is a real 0); a missing one is left out = unknown.
    if (n.fiberG !== null) comp.fiberG = est(n.fiberG);
    if (n.sodiumMg !== null) comp.sodiumMg = est(n.sodiumMg);
    return { ok: true, component: comp };
  }

  // ---------- My foods (explicitly saved by the owner from a CONFIRMED meal component) ----------
  var STATES = { KNOWN: 1, ESTIMATED: 1, UNKNOWN: 1 };
  function cleanMacro(m) {
    if (!m || typeof m !== 'object') return { value: null, state: 'UNKNOWN' };
    var st = own(STATES, m.state) ? m.state : (m.value === null || m.value === undefined ? 'UNKNOWN' : 'ESTIMATED');
    return { value: isNum(m.value) && m.value >= 0 ? m.value : null, state: isNum(m.value) && m.value >= 0 ? (st === 'UNKNOWN' ? 'ESTIMATED' : st) : 'UNKNOWN' };
  }
  // A quantified fiber/sodium value {value >= 0, state KNOWN|ESTIMATED} (a copy), or null for absent / UNKNOWN / invalid.
  // RC2 review: by: 'OWNER' marks a value the owner typed (stored on the record, so it survives reopening, copies, My foods,
  // backup and restore). Only that exact marker is kept; a value without it is treated as derived (USDA) as before.
  function isOwnerExtra(m) { return !!m && typeof m === 'object' && m.by === 'OWNER'; }
  function cleanExtra(m, k) {
    if (!m || typeof m !== 'object' || !isNum(m.value) || m.value < 0 || m.value > EXTRA_LIMIT[k] || m.state === 'UNKNOWN') return null;
    var o = { value: m.value, state: m.state === 'KNOWN' ? 'KNOWN' : 'ESTIMATED' };
    if (isOwnerExtra(m)) o.by = 'OWNER';
    return o;
  }
  // Phase 11.3: add USDA fiber/sodium to a component that already carries a USDA source note with grams (the Describe path),
  // when the food has them and the component has none. Returns a new component; never overwrites an owner value.
  function withFiberSodium(ix, c) {
    var p = c && c.provenance, f = ix && ix.ok && p && p.source === 'USDA_FDC' && isNum(p.fdcId) && isNum(p.grams) && p.grams > 0 ? ix.foods[ix.byKey[p.dataset + ':' + p.fdcId]] : null;
    if (!f || !f.fs) return c;
    var o = JSON.parse(JSON.stringify(c));
    if (f.fs[0] !== null && !own(o, 'fiberG')) o.fiberG = est(round1(f.fs[0] * p.grams / 100));
    if (f.fs[1] !== null && !own(o, 'sodiumMg')) o.sodiumMg = est(Math.round(f.fs[1] * p.grams / 100));
    return o;
  }
  function myFoodFromComponent(c, meta) {
    meta = meta || {};
    if (!c || typeof c.name !== 'string' || !c.name.trim()) return { ok: false, message: 'Only a named item can be saved.' };
    var known = ['kcal', 'proteinG', 'carbsG', 'fatG'].map(function (k) { return cleanMacro(c[k]); });
    var anyEst = known.some(function (m) { return m.state === 'ESTIMATED'; });
    var basis = c.provenance && c.provenance.source === 'USDA_FDC' ? 'USDA estimate' : meta.mealSource === 'PHOTO_AI' ? 'photo estimate' : meta.mealSource === 'DESCRIPTION' ? 'text estimate' : anyEst ? 'estimate' : 'your values';
    var f = { id: cap(meta.id || ('mf-' + Date.now().toString(36)), 40), name: cap(c.name.trim(), 80), portion: cap(c.portion || '', 80),
      kcal: known[0], proteinG: known[1], carbsG: known[2], fatG: known[3], basis: basis, savedAt: meta.savedAt || null, fromMealId: meta.mealId ? cap(meta.mealId, 60) : null };
    // Phase 11.3: fiber / sodium copied only when quantified (KNOWN or ESTIMATED, 0 included); unknown is left out.
    EXTRA.forEach(function (k) { var m = cleanExtra(c[k], k); if (m) f[k] = m; });
    if (c.provenance && typeof c.provenance === 'object' && isNum(c.provenance.fdcId)) {
      var p = {}; ['source', 'dataset', 'fdcId', 'description', 'portion', 'grams', 'dbVersion', 'carbsClampedToZero', 'note'].forEach(function (k) { if (own(c.provenance, k)) p[k] = c.provenance[k]; });
      f.provenance = p;
    }
    return { ok: true, food: f };
  }
  // A copy for the meal draft, scaled by qty (1 = as saved). States are kept: an estimate stays an estimate.
  function myFoodComponent(f, qty) {
    if (!f || !(isNum(qty) && qty > 0 && qty <= MAX_QTY)) return { ok: false, message: 'Choose a quantity between 0.1 and ' + MAX_QTY + '.' };
    function sc(m, k) { var c = cleanMacro(m); return c.value === null ? c : { value: k === 'kcal' ? Math.round(c.value * qty) : round1(c.value * qty), state: c.state }; }
    var comp = { name: cap(f.name, 80), role: 'OTHER', portion: cap((qty === 1 ? '' : round2(qty) + ' × ') + (f.portion || '1 serving'), 80), preparation: '', eatenFraction: null,
      kcal: sc(f.kcal, 'kcal'), proteinG: sc(f.proteinG), carbsG: sc(f.carbsG), fatG: sc(f.fatG) };
    EXTRA.forEach(function (k) { var m = cleanExtra(f[k], k); if (m) { comp[k] = { value: k === 'sodiumMg' ? Math.round(m.value * qty) : round1(m.value * qty), state: m.state }; if (m.by) comp[k].by = m.by; } });
    if (f.provenance && isNum(f.provenance.fdcId)) { comp.provenance = JSON.parse(JSON.stringify(f.provenance)); if (qty !== 1 && isNum(comp.provenance.grams)) { comp.provenance.grams = round2(comp.provenance.grams * qty); comp.provenance.portion = cap(comp.portion, 200); } }
    return { ok: true, component: comp };
  }
  // Claude 11.2 review (C-02): each entry is also normalised (a copy; the input is not changed) so an older or hand-edited
  // saved food without macro objects cannot break the list. A well-formed entry comes back with the same values; other
  // fields are kept. A missing or invalid value becomes UNKNOWN (never 0).
  function validMyFoods(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (f) { return f && typeof f === 'object' && typeof f.id === 'string' && typeof f.name === 'string' && f.name.trim(); }).slice(0, MAX_MY_FOODS)
      .map(function (f) {
        var o = JSON.parse(JSON.stringify(f));
        ['kcal', 'proteinG', 'carbsG', 'fatG'].forEach(function (k) { o[k] = cleanMacro(f[k]); });
        EXTRA.forEach(function (k) { if (own(o, k)) { var m = cleanExtra(f[k], k); if (m) o[k] = m; else delete o[k]; } });
        o.portion = typeof f.portion === 'string' ? cap(f.portion, 80) : '';
        if (o.provenance !== undefined && !(o.provenance && typeof o.provenance === 'object' && isNum(o.provenance.fdcId))) delete o.provenance;
        return o;
      });
  }
  // Recent foods: USDA keys of components in CONFIRMED meals, newest first, distinct.
  function recentKeys(meals, limit) {
    var list = (meals || []).filter(function (m) { return m && m.lifecycle === 'CONFIRMED' && Array.isArray(m.components); })
      .sort(function (a, b) { var x = (a.confirmedAt || a.date || ''), y = (b.confirmedAt || b.date || ''); return x < y ? 1 : x > y ? -1 : 0; });
    var out = [], seen = Object.create(null);
    list.forEach(function (m) { m.components.forEach(function (c) { var p = c && c.provenance; if (p && p.source === 'USDA_FDC' && isNum(p.fdcId) && p.dataset) { var k = p.dataset + ':' + p.fdcId; if (!seen[k]) { seen[k] = 1; out.push(k); } } }); });
    return out.slice(0, limit || 20);
  }

  // RC2 review: what restoring a backup does to this device's saved foods and favourites (read-only comparison of the two
  // raw texts; nothing is written). Restore replaces the whole settings record, so these lists come from the backup.
  // Returns a warning only when this device has saved foods or favourites that the restore would remove or replace.
  function restoreNote(currentRawText, importText) {
    function lists(text) {
      try { var o = JSON.parse(text || 'null'); var r = o && Array.isArray(o.ownerSettings) ? o.ownerSettings.filter(function (x) { return x && x.id === 'app-settings'; })[0] : null;
        return { my: r && Array.isArray(r.myFoods) ? r.myFoods.filter(function (f) { return f && typeof f === 'object'; }) : [], fav: r && Array.isArray(r.favFoods) ? r.favFoods.filter(function (k) { return typeof k === 'string'; }) : [] };
      } catch (e) { return { my: [], fav: [] }; }
    }
    function n(c, one, many) { return c + ' ' + (c === 1 ? one : many); }
    function desc(l) { return n(l.my.length, 'saved food', 'saved foods') + ' and ' + n(l.fav.length, 'favourite', 'favourites'); }
    var cur = lists(currentRawText), inc = lists(importText);
    if (!cur.my.length && !cur.fav.length) return null;
    if (JSON.stringify(cur) === JSON.stringify(inc)) return null;
    if (!inc.my.length && !inc.fav.length) return 'Restoring removes your ' + desc(cur) + ' from this device (this backup has none; it may be from an older version). Meals already logged are not changed. Export a backup first if you want to keep them.';
    return 'Saved foods differ: restoring replaces this device\'s ' + desc(cur) + ' with the backup\'s ' + desc(inc) + '. Meals already logged are not changed.';
  }

  return { buildIndex: buildIndex, search: search, restoreNote: restoreNote, isOwnerExtra: isOwnerExtra, servingsFor: servingsFor, nutrients: nutrients, usdaComponent: usdaComponent,
    myFoodFromComponent: myFoodFromComponent, withFiberSodium: withFiberSodium, cleanExtra: cleanExtra, restaurantKind: restaurantKind, EXTRA: EXTRA, EXTRA_LIMIT: EXTRA_LIMIT, myFoodComponent: myFoodComponent, validMyFoods: validMyFoods, recentKeys: recentKeys,
    sourceLabel: sourceLabel, norm: norm, tokens: tokens, editDistance: editDistance, MAX_MY_FOODS: MAX_MY_FOODS, MAX_QTY: MAX_QTY, MAX_QUERY: MAX_QUERY };
});
