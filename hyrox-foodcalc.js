/*
 * hyrox-foodcalc.js - typed-food nutrition estimates from the bundled USDA FoodData Central database (CC0).
 * Pure functions, offline, deterministic. No storage, no network, no AI. UMD: window.HyroxFoodCalc / module.exports.
 *
 * Input:  "2 eggs, 150 g rice, 1 cup milk, 1 tbsp olive oil, half an avocado"
 * Output: per item {status, chosen, portion, grams, nutrients, provenance, candidates, portions} and totals.
 * Rules: an item is 'matched' only through the explicit alias table or ONE unambiguous strong text match;
 * 'ambiguous' lists candidates and has NO nutrients until the user picks; 'no_match' is "no match", never a guess;
 * 'no_portion' = a food was chosen but the unit cannot be turned into grams from USDA portion rows (no density guessing).
 * Every number is an ESTIMATE per 100 g of USDA's reference food scaled by grams. Nothing here counts toward day totals:
 * a meal built from these components still has to be CONFIRMED by the owner (existing HyroxNutrition rule).
 * See CONTRACT-P6.md (section 3-4) and src/data/FOOD-DB-PROVENANCE.md.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.HyroxFoodCalc = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var MAX_INPUT_CHARS = 2000;   // longer input is cut (parse/estimate report truncated:true)
  var MAX_ITEMS = 50;           // a meal holds at most 50 components
  var MAX_AMOUNT = 100000;
  // Limits the meals validator enforces per component macro (hyrox-data.js MACRO_MAX); an estimate above them is refused
  // instead of producing a component that would make the whole meal DAMAGED.
  var MACRO_LIMIT = { kcal: 10000, proteinG: 1000, carbsG: 2000, fatG: 1000 };
  var SOURCE = 'USDA_FDC';

  // ---------- alias table ----------
  // [names[], dataset, fdcId, default count portion (exact USDA portion label of that food, or null), note]
  // Each fdcId is verified against the built DB by tests/p6-dawit-foodcalc.test.js; the default count portion is the USDA
  // household-measure row the typed count ("2 eggs", "1 banana") is multiplied by (grams per ONE unit = row grams / row amount).
  // null = USDA lists no per-item row for this food: counts need a unit (cup, tbsp, g ...). Notes state the assumption made.
  var ALIASES = [
    [["egg", "eggs", "whole egg", "whole eggs", "large egg", "large eggs", "raw egg"], "SR", 171287, "large", "USDA whole egg, raw. Type 'boiled egg', 'fried egg' or 'scrambled egg' for cooked."],
    [["boiled egg", "boiled eggs", "hard boiled egg", "hard boiled eggs", "hard-boiled egg", "hard-boiled eggs"], "SR", 173424, "large", ""],
    [["fried egg", "fried eggs"], "SR", 173423, "large", ""],
    [["scrambled egg", "scrambled eggs"], "SR", 172187, "large", ""],
    [["egg white", "egg whites"], "SR", 172183, "large", ""],
    [["egg yolk", "egg yolks"], "SR", 172184, "large", ""],
    [["rice", "white rice", "cooked rice", "cooked white rice", "boiled rice", "steamed rice", "rice cooked"], "SR", 168878, null, "Assumed cooked white long-grain rice. Type 'uncooked rice' for dry rice."],
    [["brown rice", "cooked brown rice"], "SR", 169704, null, "Cooked brown rice."],
    [["uncooked rice", "raw rice", "dry rice", "uncooked white rice", "raw white rice"], "SR", 168877, null, "Dry (uncooked) white rice."],
    [["pasta", "cooked pasta", "pasta cooked", "spaghetti", "cooked spaghetti", "macaroni", "penne"], "SR", 169737, null, "Assumed cooked pasta (enriched)."],
    [["dry pasta", "uncooked pasta", "raw pasta", "dry spaghetti", "uncooked spaghetti"], "SR", 169736, null, "Dry (uncooked) pasta."],
    [["oats", "rolled oats", "dry oats", "oat flakes", "porridge oats"], "SR", 173904, null, "Dry rolled/quick oats. Type 'oatmeal' or 'cooked oats' for cooked porridge."],
    [["oatmeal", "cooked oats", "porridge", "cooked oatmeal"], "SR", 173905, null, "Oatmeal cooked with water."],
    [["quinoa", "cooked quinoa", "quinoa cooked"], "SR", 168917, null, "Cooked quinoa."],
    [["couscous", "cooked couscous"], "SR", 169700, "cup, cooked", "Cooked couscous."],
    [["bulgur", "cooked bulgur", "bulgur cooked"], "SR", 170287, null, "Cooked bulgur."],
    [["cornflakes", "corn flakes"], "SR", 174648, null, "Ralston corn flakes (brand row; USDA only lists a cup)."],
    [["granola"], "SR", 171646, null, "Homemade-style granola."],
    [["bread", "white bread", "slice of bread", "bread slice", "bread slices"], "SR", 174924, "slice", "Commercially prepared white bread."],
    [["whole wheat bread", "wholemeal bread", "whole-wheat bread"], "SR", 172688, "slice", ""],
    [["rye bread"], "SR", 172684, "slice, regular", ""],
    [["pita", "pita bread", "pitta", "pitta bread"], "SR", 174915, "pita, large (6-1/2\" dia)", "Large white pita (6.5 in)."],
    [["naan", "naan bread"], "SR", 171845, "piece", ""],
    [["tortilla", "tortillas"], "SR", 175037, "tortilla (approx 10\" dia)", "Flour tortilla, 10 in."],
    [["bagel", "bagels"], "SR", 174899, "bagel", ""],
    [["croissant", "croissants"], "SR", 174987, "croissant, medium", ""],
    [["milk", "whole milk", "full fat milk", "full cream milk"], "SR", 171265, null, "Whole milk (3.25% fat)."],
    [["skim milk", "skimmed milk", "nonfat milk", "fat free milk"], "SR", 171269, null, ""],
    [["2% milk", "semi skimmed milk", "semi-skimmed milk", "reduced fat milk"], "SR", 171267, null, ""],
    [["1% milk", "low fat milk", "lowfat milk"], "SR", 170872, null, ""],
    [["almond milk"], "SR", 174832, null, "Unsweetened shelf-stable almond milk."],
    [["coconut water"], "SR", 174831, null, "Ready-to-drink, unsweetened."],
    [["yogurt", "yoghurt", "plain yogurt", "plain yoghurt"], "SR", 171284, "container (6 oz)", "Assumed plain whole-milk yogurt. Type 'low fat yogurt' or 'greek yogurt' for others."],
    [["low fat yogurt", "low fat yoghurt", "lowfat yogurt"], "SR", 170886, "container (6 oz)", ""],
    [["greek yogurt", "greek yoghurt", "plain greek yogurt"], "SR", 170894, "container", "Plain nonfat Greek yogurt."],
    [["cheddar", "cheddar cheese"], "SR", 170899, "slice (1 oz)", "Sharp cheddar, sliced."],
    [["feta", "feta cheese"], "SR", 173420, "wedge (1.33 oz)", ""],
    [["mozzarella", "mozzarella cheese"], "SR", 170847, null, "Part-skim mozzarella."],
    [["cream cheese"], "SR", 173418, null, ""],
    [["cottage cheese"], "SR", 172179, null, "Creamed cottage cheese."],
    [["parmesan", "parmesan cheese"], "SR", 171247, null, "Grated parmesan."],
    [["swiss cheese"], "SR", 171251, null, ""],
    [["sour cream"], "SR", 171257, null, ""],
    [["heavy cream", "double cream", "whipping cream"], "SR", 170859, null, ""],
    [["butter"], "SR", 173410, null, "Salted butter."],
    [["ghee"], "SR", 171314, null, "Clarified butter (USDA lists no household measure)."],
    [["olive oil", "extra virgin olive oil"], "SR", 171413, null, ""],
    [["vegetable oil", "cooking oil", "sunflower oil", "canola oil"], "SR", 172370, null, "USDA refined soybean oil (all refined cooking oils are about 884 kcal per 100 g)."],
    [["coconut oil"], "SR", 171412, null, ""],
    [["mayonnaise", "mayo"], "SR", 171009, null, "Regular mayonnaise."],
    [["peanut butter"], "SR", 174294, null, "Smooth peanut butter."],
    [["tahini"], "SR", 169410, null, "Tahini from raw and stone-ground kernels."],
    [["hummus", "houmous", "hommus"], "SR", 174289, null, "Commercial hummus."],
    [["honey"], "SR", 169640, null, ""],
    [["sugar", "white sugar", "granulated sugar"], "SR", 169655, null, ""],
    [["jam"], "SR", 169641, null, "Jams and preserves."],
    [["maple syrup"], "SR", 169661, null, ""],
    [["salt", "table salt"], "SR", 173468, null, "0 kcal."],
    [["soy sauce"], "SR", 174277, null, "Shoyu."],
    [["cocoa", "cocoa powder"], "SR", 169593, null, "Unsweetened cocoa powder."],
    [["avocado", "avocados"], "SR", 171705, "avocado, NS as to Florida or California", "All commercial varieties; USDA 'avocado' portion row (201 g, edible flesh)."],
    [["banana", "bananas"], "SR", 173944, "medium (7\" to 7-7/8\" long)", "Medium banana, peeled (118 g)."],
    [["apple", "apples"], "SR", 171688, "medium (3\" dia)", "Raw apple with skin."],
    [["orange", "oranges"], "SR", 169097, "fruit (2-5/8\" dia)", "Orange, 2-5/8 in."],
    [["pear", "pears"], "SR", 169118, "medium", ""],
    [["peach", "peaches"], "SR", 169928, "medium (2-2/3\" dia)", ""],
    [["mango", "mangoes", "mangos"], "SR", 169910, "fruit without refuse", "Whole fruit without refuse (336 g)."],
    [["kiwi", "kiwis", "kiwifruit"], "SR", 168153, "fruit (2\" dia)", ""],
    [["fig", "figs"], "SR", 173021, "medium (2-1/4\" dia)", ""],
    [["date", "dates", "medjool date", "medjool dates"], "SR", 168191, "date, pitted", "Medjool dates (24 g each, pitted)."],
    [["grapes"], "SR", 174683, "grapes", "USDA row: 10 grapes = 49 g."],
    [["strawberries", "strawberry"], "SR", 167762, null, "USDA lists only an extra-large berry (27 g) and cups; use cups or grams."],
    [["blueberries"], "SR", 171711, "berries", "USDA row: 50 berries = 68 g."],
    [["watermelon"], "SR", 167765, null, "USDA wedge row is 1/16 of a melon (286 g); use cups or grams."],
    [["pineapple"], "SR", 169124, null, "Use cups or grams."],
    [["raisins"], "SR", 168165, null, "Dark seedless raisins."],
    [["dried apricots"], "SR", 173941, null, "USDA lists only single halves (3.5 g); use grams or cups."],
    [["orange juice"], "SR", 169098, null, "Raw orange juice."],
    [["lemon juice"], "SR", 167747, null, ""],
    [["olives", "black olives"], "SR", 169094, "large", ""],
    [["chicken breast", "cooked chicken breast", "grilled chicken breast", "chicken breasts", "chicken breast cooked"], "SR", 171477, "breast, bone and skin removed", "Assumed cooked (roasted), meat only. Type 'raw chicken breast' for raw."],
    [["raw chicken breast"], "SR", 171077, "piece", "Raw, skinless boneless."],
    [["chicken thigh", "chicken thighs"], "SR", 172388, "thigh without skin", "Cooked roasted, meat only."],
    [["ground beef", "minced beef", "beef mince", "cooked ground beef"], "SR", 174033, "patty ( yield from 1/4 lb raw meat )", "85% lean, pan-broiled patty (cooked)."],
    [["sirloin steak", "beef sirloin steak"], "SR", 168634, "piece, cooked, excluding refuse (yield from 1 lb raw meat with refuse)", "Top sirloin, lean only, cooked."],
    [["salmon", "cooked salmon", "salmon fillet", "salmon cooked"], "SR", 175168, null, "Atlantic farmed salmon, cooked, dry heat."],
    [["cod", "cooked cod", "cod fillet", "cod cooked"], "SR", 171956, "fillet", ""],
    [["tuna", "canned tuna", "tin of tuna"], "SR", 173709, "can", "Light tuna in water, drained (can = 165 g)."],
    [["shrimp", "prawns", "cooked shrimp", "cooked prawns"], "SR", 175180, null, "Cooked shrimp (USDA lists only 3 oz)."],
    [["turkey breast"], "SR", 171496, null, "Roasted turkey breast, meat only."],
    [["bacon"], "SR", 168322, "slice", "Pan-fried bacon, pre-sliced."],
    [["ham"], "SR", 173864, "slice", ""],
    [["falafel"], "SR", 172455, "patty (approx 2-1/4\" dia)", "Home-prepared falafel patty (17 g)."],
    [["tofu"], "SR", 172475, null, ""],
    [["lentils", "cooked lentils", "lentils cooked"], "SR", 172421, null, "Cooked (boiled) lentils."],
    [["chickpeas", "cooked chickpeas", "chickpeas cooked"], "SR", 173757, null, "Cooked (boiled) chickpeas."],
    [["canned chickpeas"], "SR", 173800, "can drained", ""],
    [["black beans", "cooked black beans", "black beans cooked"], "SR", 173735, null, "Cooked black beans."],
    [["kidney beans", "cooked kidney beans", "kidney beans cooked"], "SR", 175194, null, "Cooked red kidney beans."],
    [["potato", "potatoes", "boiled potato", "boiled potatoes"], "SR", 170438, "potato (2-1/2\" dia, sphere)", "Boiled potato (flesh), 136 g each."],
    [["baked potato"], "SR", 170093, "potato medium", ""],
    [["sweet potato", "sweet potatoes"], "SR", 168483, "medium (2\" dia, 5\" long, raw)", "Baked in skin."],
    [["tomato", "tomatoes"], "SR", 170457, "medium whole (2-3/5\" dia)", ""],
    [["cucumber", "cucumbers"], "SR", 168409, "cucumber (8-1/4\")", "With peel."],
    [["carrot", "carrots"], "SR", 170393, "medium", "Raw."],
    [["broccoli"], "SR", 170379, "stalk", "Raw broccoli."],
    [["cooked broccoli", "steamed broccoli", "boiled broccoli"], "SR", 169967, null, ""],
    [["spinach"], "SR", 168462, null, "Raw spinach."],
    [["lettuce", "romaine"], "SR", 169247, null, "Cos/romaine, raw."],
    [["onion", "onions"], "SR", 170000, "medium (2-1/2\" dia)", "Raw."],
    [["red pepper", "bell pepper", "red bell pepper"], "SR", 170108, "medium (approx 2-3/4\" long, 2-1/2 dia.)", ""],
    [["mushrooms"], "SR", 169251, null, "White, raw."],
    [["sweetcorn", "sweet corn"], "SR", 169999, "cup cut", "Cooked boiled yellow corn kernels."],
    [["green peas", "peas"], "SR", 170420, null, "Cooked boiled green peas."],
    [["zucchini", "courgette"], "SR", 169291, "medium", ""],
    [["eggplant", "aubergine"], "SR", 169228, null, ""],
    [["almonds"], "SR", 170567, null, "USDA lists only 1 oz = 23 kernels; use oz or grams."],
    [["walnuts"], "SR", 170187, null, ""],
    [["cashews", "cashew nuts"], "SR", 170162, null, ""],
    [["peanuts"], "SR", 172430, null, "Raw peanuts."],
    [["pistachios"], "SR", 170184, null, ""],
    [["sunflower seeds"], "SR", 170562, null, ""],
    [["chia seeds"], "SR", 170554, null, ""],
    [["water"], "SR", 173647, null, "0 kcal."],
    [["coffee", "black coffee"], "SR", 171890, "cup (8 fl oz)", "Brewed coffee, no milk or sugar."],
    [["tea", "black tea"], "SR", 173227, "cup (8 fl oz)", "Brewed black tea, no milk or sugar."],
    [["cola", "coke"], "SR", 174852, "can or bottle (12 fl oz)", "Regular cola."],
    [["beer"], "SR", 168746, "can", ""],
    [["dark chocolate"], "SR", 170273, "bar", "70-85% cacao."],
    [["milk chocolate"], "SR", 167587, "bar (1.55 oz)", ""],
    [["popcorn"], "SR", 167959, null, "Air-popped popcorn."],
    [["rice cake", "rice cakes"], "SR", 170250, "cake", "Plain unsalted brown-rice cake."]
  ];

  // ---------- units ----------
  var UNIT_WORDS = {
    g: 'g', gr: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
    kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
    mg: 'mg', mgs: 'mg', milligram: 'mg', milligrams: 'mg',
    ml: 'ml', mls: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
    l: 'l', lt: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
    oz: 'oz', ounce: 'oz', ounces: 'oz',
    floz: 'fl oz', 'fl oz': 'fl oz', 'fl.oz': 'fl oz', 'fl. oz': 'fl oz', 'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz', 'fluid oz': 'fl oz',
    qt: 'quart', qts: 'quart', quart: 'quart', quarts: 'quart',
    lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
    cup: 'cup', cups: 'cup',
    tbsp: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tbl: 'tbsp', tbspn: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
    tsp: 'tsp', tsps: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
    slice: 'slice', slices: 'slice',
    piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece'
  };
  var MASS_G = { g: 1, kg: 1000, mg: 0.001, oz: 28.3495, lb: 453.592 };
  var IN_ML = { 'fl oz': 29.5735, quart: 946.353 }; // typed US fluid ounces / quarts -> millilitres
  var ML_PER = { cup: 236.5882365, tbsp: 14.78676478, tsp: 4.92892159, floz: 29.5735295625 };
  var NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  var UNICODE_FRACTIONS = { '\u00bd': '1/2', '\u2153': '1/3', '\u2154': '2/3', '\u00bc': '1/4', '\u00be': '3/4', '\u2155': '1/5', '\u2156': '2/5',
    '\u2157': '3/5', '\u2158': '4/5', '\u2159': '1/6', '\u215a': '5/6', '\u215b': '1/8', '\u215c': '3/8', '\u215d': '5/8', '\u215e': '7/8' };
  var SIZE_RE = /^(extra[ -]large|extra[ -]small|jumbo|large|medium|small|mini|big)\s+/;
  var STOP = { of: 1, the: 1, a: 1, an: 1, 'with': 1, and: 1, 'in': 1, 'for': 1, to: 1 };

  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function round1(n) { return Math.round(n * 10) / 10; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function collapse(s) { return s.replace(/\s+/g, ' ').replace(/^ | $/g, ''); }

  // ---------- database ----------
  function validateDb(db) {
    if (!db || typeof db !== 'object' || Array.isArray(db)) return 'The food database is not an object.';
    var m = db.meta;
    if (!m || typeof m !== 'object' || m.schema !== 1) return 'The food database meta/schema is missing or not schema 1.';
    if (typeof m.dbVersion !== 'string' || !m.dbVersion) return 'The food database has no dbVersion.';
    if (!Array.isArray(db.foods) || !db.foods.length) return 'The food database has no foods.';
    var seen = Object.create(null);
    for (var i = 0; i < db.foods.length; i++) {
      var f = db.foods[i], bad = 'The food database row ' + i + ' is malformed.';
      if (!Array.isArray(f) || f.length !== 8) return bad;
      if (typeof f[0] !== 'number' || f[0] % 1 !== 0 || f[0] <= 0) return bad;
      if (f[1] !== 'SR' && f[1] !== 'FF') return bad;
      if (typeof f[2] !== 'string' || !f[2]) return bad;
      if (!isNum(f[3]) || !isNum(f[4]) || !isNum(f[5]) || !isNum(f[6])) return bad;
      if (!Array.isArray(f[7])) return bad;
      for (var j = 0; j < f[7].length; j++) {
        var p = f[7][j];
        if (!Array.isArray(p) || p.length !== 3 || !isNum(p[0]) || p[0] <= 0 || typeof p[1] !== 'string' || !isNum(p[2]) || p[2] <= 0) return bad;
      }
      var k = f[1] + ':' + f[0];
      if (seen[k]) return 'The food database repeats ' + k + '.';
      seen[k] = 1;
    }
    return null;
  }

  function loadDb(input) {
    var db = input;
    try {
      if (typeof input === 'string') db = JSON.parse(input);
      if (db && typeof db === 'object' && db.ok === true && db.db) db = db.db; // accept the result of loadDb itself
    } catch (e) { return { ok: false, code: 'db_invalid', message: 'The food database text is not valid JSON.' }; }
    var err;
    try { err = validateDb(db); } catch (e2) { err = 'The food database could not be checked.'; }
    if (err) return { ok: false, code: 'db_invalid', message: err };
    return { ok: true, db: db };
  }

  var prepared = null; // one-entry cache: {db, index...} keyed by object identity

  function globalDb() {
    var cands = [];
    try { cands.push(root); } catch (e) { /* ignore */ }
    if (typeof window !== 'undefined') cands.push(window);
    if (typeof globalThis !== 'undefined') cands.push(globalThis);
    for (var i = 0; i < cands.length; i++) { if (cands[i] && cands[i].HyroxFoodDb) return cands[i].HyroxFoodDb; }
    return null;
  }

  // -> {ok:true, p} | {ok:false, code, message, items:[]}
  function resolveDb(db) {
    var raw = db === undefined || db === null ? globalDb() : db;
    if (raw === null || raw === undefined) {
      return { ok: false, code: 'db_not_loaded', message: 'The food database is not loaded. Enter the food values by hand.', items: [] };
    }
    if (prepared && (prepared.db === raw || (raw && raw.ok === true && prepared.db === raw.db))) return { ok: true, p: prepared };
    var l = loadDb(raw);
    if (!l.ok) return { ok: false, code: 'db_invalid', message: l.message, items: [] };
    prepared = prepare(l.db);
    return { ok: true, p: prepared };
  }

  function stem(t) {
    if (t.length > 4 && /ies$/.test(t)) return t.slice(0, -3) + 'y';
    if (t.length > 4 && /(oes|ches|shes|sses|xes)$/.test(t)) return t.slice(0, -2);
    if (t.length > 3 && /[^su]s$/.test(t)) return t.slice(0, -1);
    return t;
  }
  function tokens(s) {
    var m = s.toLowerCase().match(/[a-z0-9]+/g) || [], out = [], seen = Object.create(null);
    for (var i = 0; i < m.length; i++) {
      var t = stem(m[i]);
      if (STOP[t] || seen[t]) continue;
      seen[t] = 1; out.push(t);
    }
    return out;
  }

  function prepare(db) {
    var p = { db: db, byKey: Object.create(null), post: Object.create(null), toks: [], head: [], aliasMap: null, rawCache: Object.create(null), phraseMemo: Object.create(null) };
    for (var i = 0; i < db.foods.length; i++) {
      var f = db.foods[i], tk = tokens(f[2]);
      p.byKey[f[1] + ':' + f[0]] = i;
      p.toks.push(tk.length);
      p.head.push(tokens(f[2].split(',')[0]));
      for (var j = 0; j < tk.length; j++) { (p.post[tk[j]] || (p.post[tk[j]] = [])).push(i); }
    }
    p.aliasMap = Object.create(null);
    for (var a = 0; a < ALIASES.length; a++) {
      var al = ALIASES[a], idx = p.byKey[al[1] + ':' + al[2]];
      if (idx === undefined) continue; // alias food not in this database (custom/test DBs): no alias
      for (var n = 0; n < al[0].length; n++) p.aliasMap[aliasKey(al[0][n])] = { names: al[0], idx: idx, label: al[3], note: al[4] };
    }
    return p;
  }

  // "large eggs" -> {size:'large', rest:'eggs'}; no leading size word -> {size:null, rest:food}
  function stripSize(food) {
    var m = SIZE_RE.exec(food + ' ');
    if (!m) return { size: null, rest: food };
    return { size: m[1].replace('-', ' '), rest: collapse(food.slice(m[0].length)) };
  }

  function aliasKey(s) { return collapse(String(s).toLowerCase().replace(/[^a-z0-9%\s]/g, ' ')); }

  function lookupAlias(p, food) {
    var key = aliasKey(food), size = null, hit;
    if (!key) return null;
    if (own(p.aliasMap, key)) return { a: p.aliasMap[key], size: null };
    var sz = stripSize(key);
    size = sz.size; key = sz.rest;
    var words = key.split(' '), last = words[words.length - 1], head = words.slice(0, -1).join(' ');
    var variants = [key];
    var forms = [];
    if (/ies$/.test(last)) forms.push(last.slice(0, -3) + 'y');
    if (/(oes|ches|shes|sses|xes)$/.test(last)) forms.push(last.slice(0, -2));
    if (/s$/.test(last)) forms.push(last.slice(0, -1));
    for (var i = 0; i < forms.length; i++) variants.push((head ? head + ' ' : '') + forms[i]);
    for (var v = 0; v < variants.length; v++) { if (variants[v] && own(p.aliasMap, variants[v])) { hit = p.aliasMap[variants[v]]; return { a: hit, size: size }; } }
    return null;
  }

  // ---------- parse ----------
  function normalizeInput(text) {
    var s = typeof text === 'string' ? text : '';
    var truncated = false;
    if (s.length > MAX_INPUT_CHARS) { s = s.slice(0, MAX_INPUT_CHARS); truncated = true; }
    s = s.replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
      .replace(/[\t\v\f\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
      .replace(/[\u2013\u2014\u2212]/g, '-').replace(/\u2044/g, '/');
    s = s.replace(/(\d)\s*([\u00bc-\u00be\u2153-\u215e])/g, function (m0, d, fr) { return d + ' ' + UNICODE_FRACTIONS[fr]; })
      .replace(/[\u00bc-\u00be\u2153-\u215e]/g, function (fr) { return ' ' + UNICODE_FRACTIONS[fr] + ' '; });
    s = s.replace(/(\d),(\d{3})(?!\d)/g, '$1$2'); // 1,000 g
    // the only phrase-level normalization: "mac and cheese" / "mac & cheese" / "mac n cheese" -> "macaroni and cheese"
    s = s.replace(/\bmac\s*(?:and|&|n|['\u2019]n['\u2019]?)\s*cheese\b/gi, 'macaroni and cheese');
    // "1 and a half cups", "one and a half cups": keep as ONE quantity before splitting on " and "
    s = s.replace(/\b(\d+)\s+and\s+(?:a\s+)?half\b/gi, '$1 1/2')
      .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+and\s+(?:a\s+)?half\b/gi, function (m0, w) { return NUMBER_WORDS[w.toLowerCase()] + ' 1/2'; });
    return { text: s, truncated: truncated };
  }

  // ---------- " and " : one dish or two items? ----------
  // Commas, semicolons, newlines, "&" and " + " always split. Inside one comma segment, " and " splits UNLESS the whole phrase is
  // ONE known food: its food part (after the quantity) is an alias name, or some database description contains the phrase's words
  // in order with "and" between them ("macaroni and cheese"). A later part that carries its own quantity ("2 eggs and 1 banana",
  // "... and a banana") is always a separate item. Without a database only alias names can keep a phrase whole.
  var staticAlias = null, staticAliasN = -1;
  function staticAliasP() {
    if (!staticAlias || staticAliasN !== ALIASES.length) {
      staticAliasN = ALIASES.length;
      staticAlias = { aliasMap: Object.create(null) };
      for (var a = 0; a < ALIASES.length; a++) for (var n = 0; n < ALIASES[a][0].length; n++) staticAlias.aliasMap[aliasKey(ALIASES[a][0][n])] = { names: ALIASES[a][0] };
    }
    return staticAlias;
  }
  function rawTokens(s) {
    var m = s.toLowerCase().match(/[a-z0-9]+/g) || [], out = [];
    for (var i = 0; i < m.length; i++) out.push(stem(m[i]));
    return out;
  }
  function dbHasPhrase(p, groups) {
    var g, t, rare = null, rareLen = 0, flat = [];
    for (g = 0; g < groups.length; g++) for (t = 0; t < groups[g].length; t++) flat.push(groups[g][t]);
    for (t = 0; t < flat.length; t++) {
      var post = p.post[flat[t]];
      if (!post) return false;
      if (rare === null || post.length < rareLen) { rare = post; rareLen = post.length; }
    }
    for (var c = 0; c < rare.length; c++) {
      var idx = rare[c], toks = p.rawCache[idx] || (p.rawCache[idx] = rawTokens(p.db.foods[idx][2])), pos = 0, ok = true;
      for (g = 0; g < groups.length && ok; g++) {
        for (t = 0; t < groups[g].length && ok; t++) { var k = toks.indexOf(groups[g][t], pos); if (k < 0) ok = false; else pos = k + 1; }
        if (ok && g < groups.length - 1) { var a = toks.indexOf('and', pos); if (a < 0) ok = false; else pos = a + 1; }
      }
      if (ok) return true;
    }
    return false;
  }
  function wholeHit(p, phrase) {
    var food = parseOne(phrase).food;
    if (!food || food.indexOf(' and ') === -1) return false;
    if (lookupAlias(p || staticAliasP(), food)) return true;
    if (!p) return false;
    if (own(p.phraseMemo, food)) return p.phraseMemo[food];
    var parts = food.split(/\s+and\s+/), groups = [];
    for (var i = 0; i < parts.length; i++) {
      var g = rawTokens(parts[i]).filter(function (t) { return !STOP[t]; });
      if (!g.length) { p.phraseMemo[food] = false; return false; }
      groups.push(g);
    }
    return (p.phraseMemo[food] = dbHasPhrase(p, groups));
  }
  var BREAD_BUTTER = /\bbread and butter\b/i, PICKLE = /\bpickles?\b/i;
  var MAX_JOIN = 4; // at most this many " and " parts are tried as one dish
  function mergeAnd(parts, p, pickle) {
    var out = [], i = 0, n = parts.length;
    while (i < n) {
      var best = i;
      for (var j = Math.min(n - 1, i + MAX_JOIN - 1); j > i; j--) {
        var ok = true;
        for (var k = i + 1; k <= j; k++) if (parseOne(parts[k]).amount !== null) { ok = false; break; }
        var cand = parts.slice(i, j + 1).join(' and ');
        // narrow exclusion (owner): "bread and butter" is bread + butter, unless the segment is about pickles
        if (ok && !pickle && BREAD_BUTTER.test(cand)) ok = false;
        if (ok && wholeHit(p, cand)) { best = j; break; }
      }
      out.push({ text: parts.slice(i, best + 1).join(' and '), joined: best > i });
      i = best + 1;
    }
    return out;
  }

  function splitItems(text, p, limit) {
    var segs = text.split(/[,;\n\r\u2028\u2029]+/), out = [];
    for (var si = 0; si < segs.length; si++) {
      var seg = collapse(segs[si]), pickle = PICKLE.test(seg);
      if (pickle) seg = seg.replace(/\bbread\s*&\s*butter\b/gi, 'bread and butter'); // "bread & butter pickles" is one food, like the "and" spelling
      var chunks = seg.split(/\s*&\s*|\s\+\s/);
      for (var ci = 0; ci < chunks.length; ci++) {
        var raw = collapse(chunks[ci]).replace(/^(?:and\s+)+/i, ''), parts = [], pp = raw ? raw.split(/\s+and\s+/i) : [];
        for (var k = 0; k < pp.length; k++) { var t = collapse(pp[k]).replace(/^(?:and\s+)+/i, ''); if (t && !/^and$/i.test(t)) parts.push(t); }
        var merged = mergeAnd(parts, p, pickle);
        for (var m = 0; m < merged.length; m++) out.push(merged[m]);
        if (out.length > limit) return out;
      }
    }
    return out;
  }

  function parseOne(piece) {
    var raw = collapse(piece), s = raw.toLowerCase(), amount = null, unit = null, problem = null, m;
    s = s.replace(/^(?:about|approximately|approx\.?|around|roughly|~)\s*/, '');
    if ((m = /^(\d+)\s+(\d+)\s*\/\s*(\d+)(?![\d.])/.exec(s)) && +m[3] !== 0) { amount = +m[1] + +m[2] / +m[3]; }
    else if ((m = /^(\d+)\s*\/\s*(\d+)(?![\d.])/.exec(s)) && +m[2] !== 0) { amount = +m[1] / +m[2]; }
    else if ((m = /^(\d+(?:\.\d+)?|\.\d+)/.exec(s))) { amount = parseFloat(m[1]); }
    else if ((m = /^(?:a\s+)?(half|quarter)(?:\s+of)?(?:\s+(?:a|an))?(?=\s|$)/.exec(s))) { amount = m[1] === 'half' ? 0.5 : 0.25; }
    else if ((m = /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?=\s|$)/.exec(s))) { amount = NUMBER_WORDS[m[1]]; }
    else if ((m = /^(?:a|an)(?=\s)/.exec(s))) { amount = 1; }
    var rest = s;
    if (amount !== null) {
      rest = s.slice(m[0].length);
      if (/^\s*(?:-|to)\s*\d/.test(rest)) problem = 'range';
      else if (!(amount > 0)) problem = 'zero';
      else if (amount > MAX_AMOUNT) problem = 'toolarge';
      rest = rest.replace(/^\s+/, '');
      var um = /^(fl\.?\s*oz|fluid\s+(?:ounces?|oz))\.?(?=\s|$)/.exec(rest);
      if (um) { unit = 'fl oz'; rest = rest.slice(um[0].length).replace(/^\s+/, ''); }
      else um = /^([a-z]+)\.?(?=\s|$)/.exec(rest);
      if (!unit && um && own(UNIT_WORDS, um[1])) { unit = UNIT_WORDS[um[1]]; rest = rest.slice(um[0].length).replace(/^\s+/, ''); }
      rest = rest.replace(/^of(?=\s|$)\s*/, '');
    }
    var food = collapse(rest.replace(/[()\[\]"*:.!?]+/g, ' ').replace(/^[\s\-']+|[\s\-']+$/g, ''));
    var item = { raw: raw, amount: problem === 'range' ? null : amount, unit: unit, food: food };
    if (problem) item.problem = problem;
    return item;
  }

  // parse(text [, db]): db (or a ready prepared index, internal) lets a known dish with "and" stay one item; no DB needed.
  function parse(text, db, preparedIdx) {
    var p = preparedIdx || null;
    if (!p) { try { var r = resolveDb(db); if (r.ok) p = r.p; } catch (e) { p = null; } }
    var n = normalizeInput(text), pieces = splitItems(n.text, p, MAX_ITEMS), truncated = n.truncated, items = [];
    if (pieces.length > MAX_ITEMS) { pieces = pieces.slice(0, MAX_ITEMS); truncated = true; }
    for (var i = 0; i < pieces.length; i++) {
      var it = parseOne(pieces[i].text);
      if (pieces[i].joined) it.joined = true;
      items.push(it);
    }
    return { ok: true, items: items, truncated: truncated };
  }

  // ---------- matching ----------
  function textSearch(p, food) {
    var q = tokens(stripSize(food).rest);
    if (!q.length) return { cands: [], full: 0, q: q };
    var counts = Object.create(null), touched = [], i, j;
    for (i = 0; i < q.length; i++) {
      var lst = p.post[q[i]];
      if (!lst) continue;
      for (j = 0; j < lst.length; j++) {
        var k = lst[j];
        if (counts[k] === undefined) { counts[k] = 0; touched.push(k); }
        counts[k]++;
      }
    }
    var need = Math.ceil(q.length * 0.6), rows = [], full = 0;
    for (i = 0; i < touched.length; i++) {
      var idx = touched[i], c = counts[idx];
      if (c < need) continue;
      var hd = 0;
      for (j = 0; j < p.head[idx].length; j++) { if (q.indexOf(p.head[idx][j]) !== -1) hd = 1; }
      if (c === q.length) full++;
      rows.push({ idx: idx, score: c / q.length, hd: hd });
    }
    rows.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (b.hd !== a.hd) return b.hd - a.hd;
      if (p.toks[a.idx] !== p.toks[b.idx]) return p.toks[a.idx] - p.toks[b.idx];
      var fa = p.db.foods[a.idx], fb = p.db.foods[b.idx];
      if (fa[1] !== fb[1]) return fa[1] === 'SR' ? -1 : 1;
      return fa[0] - fb[0];
    });
    return { cands: rows, full: full, q: q };
  }

  function candOf(p, idx, score) {
    var f = p.db.foods[idx];
    return { fdcId: f[0], dataset: f[1], description: f[2], score: round2(score) };
  }

  // ---------- portions ----------
  var CLASS_RES = [['cup', /^cups?\b/], ['tbsp', /^(?:tbsp|tablespoons?)\b/], ['tsp', /^(?:tsp|teaspoons?)\b/], ['floz', /^fl oz\b/],
    ['oz', /^oz\b/], ['lb', /^lbs?\b/], ['g', /^grams?\b/], ['slice', /^slices?\b/], ['piece', /^pieces?\b/]];
  var BARE = { cup: ['cup'], tbsp: ['tbsp', 'tablespoon'], tsp: ['tsp', 'teaspoon'], floz: ['fl oz'], slice: ['slice'], piece: ['piece'] };

  function labelClass(label) {
    var l = label.toLowerCase();
    for (var i = 0; i < CLASS_RES.length; i++) { if (CLASS_RES[i][1].test(l)) return CLASS_RES[i][0]; }
    if (/^(?:racc|nlea serving|serving)\b/.test(l)) return 'serving';
    return 'count';
  }
  function isBare(cls, label) { var b = BARE[cls]; return !!b && b.indexOf(label.toLowerCase()) !== -1; }

  function portionList(food) {
    var out = [];
    for (var i = 0; i < food[7].length; i++) out.push({ index: i, amount: food[7][i][0], unit: food[7][i][1], label: food[7][i][1], grams: food[7][i][2] });
    return out;
  }
  function perUnit(row) { return row[2] / row[0]; }

  // rows of one class, bare first; unique non-bare accepted; else null (several variants: the user must pick)
  function pickClassRow(food, cls) {
    var rows = [], i;
    for (i = 0; i < food[7].length; i++) if (labelClass(food[7][i][1]) === cls) rows.push(i);
    for (i = 0; i < rows.length; i++) if (isBare(cls, food[7][rows[i]][1])) return rows[i];
    return rows.length === 1 ? rows[0] : null;
  }
  function pickVolumeRowForMl(food) {
    var order = ['cup', 'tbsp', 'tsp', 'floz'];
    for (var o = 0; o < order.length; o++) {
      for (var i = 0; i < food[7].length; i++) {
        if (labelClass(food[7][i][1]) === order[o] && isBare(order[o], food[7][i][1])) return { idx: i, cls: order[o] };
      }
    }
    return null;
  }
  function sizeRow(food, size) {
    var s = size.replace(' ', '[ -]'), re = new RegExp('^' + s + '\\b', 'i');
    for (var i = 0; i < food[7].length; i++) if (re.test(food[7][i][1]) && labelClass(food[7][i][1]) === 'count') return i;
    return null;
  }
  function countRows(food) {
    var r = [];
    for (var i = 0; i < food[7].length; i++) if (labelClass(food[7][i][1]) === 'count') r.push(i);
    return r;
  }

  var UNIT_NAME = { cup: 'cup', tbsp: 'tablespoon', tsp: 'teaspoon', slice: 'slice', piece: 'piece' };

  // -> {grams, label, unit, basis, note?} | {fail:message}
  function resolvePortion(food, amount, unit, size, alias, opts) {
    var i, row, g;
    if (opts && isNum(opts.grams) && opts.grams > 0) {
      return { grams: opts.grams, amount: opts.grams, unit: 'g', label: 'g', basis: 'user_grams' };
    }
    if (opts && typeof opts.portionIndex === 'number' && opts.portionIndex % 1 === 0 && opts.portionIndex >= 0 && opts.portionIndex < food[7].length) {
      row = food[7][opts.portionIndex];
      return { grams: amount * perUnit(row), amount: amount, unit: row[1], label: row[1], basis: 'usda_portion' };
    }
    if (own(MASS_G, unit)) return { grams: amount * MASS_G[unit], amount: amount, unit: unit, label: unit, basis: 'mass' };
    if (unit === 'fl oz') {
      for (i = 0; i < food[7].length; i++) if (labelClass(food[7][i][1]) === 'floz' && isBare('floz', food[7][i][1])) { // the food's own USDA fl oz row is used as is
        row = food[7][i];
        return { grams: amount * perUnit(row), amount: amount, unit: unit, label: row[1], basis: 'usda_portion' };
      }
    }
    if (unit === 'ml' || unit === 'l' || unit === 'fl oz' || unit === 'quart') {
      var ml = unit === 'l' ? amount * 1000 : own(IN_ML, unit) ? amount * IN_ML[unit] : amount, vr = pickVolumeRowForMl(food),
        what = unit === 'fl oz' ? 'fluid ounces' : unit === 'quart' ? 'quarts' : 'millilitres', Cap = what.charAt(0).toUpperCase() + what.slice(1);
      if (!vr) return { fail: 'USDA lists no cup, tablespoon, teaspoon or fl oz measure for this food, so ' + what + ' cannot be turned into grams (no density is guessed). Enter grams.' };
      row = food[7][vr.idx];
      return { grams: ml * perUnit(row) / ML_PER[vr.cls], amount: amount, unit: unit, label: unit, basis: 'usda_portion',
        note: Cap + ' converted with the USDA "' + row[1] + '" row (' + row[2] + ' g per ' + row[0] + ' ' + vr.cls + ').' };
    }
    if (unit === 'cup' || unit === 'tbsp' || unit === 'tsp') {
      i = pickClassRow(food, unit);
      if (i === null) {
        var has = false; for (var k = 0; k < food[7].length; k++) if (labelClass(food[7][k][1]) === unit) has = true;
        return { fail: has ? 'USDA lists several "' + UNIT_NAME[unit] + '" measures for this food. Pick one from the measure list or enter grams.'
          : 'USDA lists no "' + UNIT_NAME[unit] + '" measure for this food (no density is guessed). Pick another measure or enter grams.' };
      }
      row = food[7][i];
      return { grams: amount * perUnit(row), amount: amount, unit: unit, label: row[1], basis: 'usda_portion' };
    }
    if (unit === 'slice') {
      if (alias && alias.label && labelClass(alias.label) === 'slice') { i = indexOfLabel(food, alias.label); if (i !== null) { row = food[7][i]; return { grams: amount * perUnit(row), amount: amount, unit: 'slice', label: row[1], basis: 'alias_default' }; } }
      i = pickClassRow(food, 'slice');
      if (i === null) return { fail: 'USDA lists no single "slice" measure for this food. Pick a measure or enter grams.' };
      row = food[7][i];
      return { grams: amount * perUnit(row), amount: amount, unit: 'slice', label: row[1], basis: 'usda_portion' };
    }
    // count (unit null) or piece
    if (unit === 'piece') {
      i = pickClassRow(food, 'piece');
      if (i !== null) { row = food[7][i]; return { grams: amount * perUnit(row), amount: amount, unit: 'piece', label: row[1], basis: 'usda_portion' }; }
    }
    var shown = unit === 'piece' ? 'piece' : null, note = null;
    if (size) {
      i = sizeRow(food, size);
      if (i !== null) { row = food[7][i]; return { grams: amount * perUnit(row), amount: amount, unit: row[1], label: row[1], basis: 'usda_portion' }; }
      note = 'USDA has no "' + size + '" measure for this food; the default measure was used.';
    }
    if (alias && alias.label) {
      i = indexOfLabel(food, alias.label);
      if (i !== null) { row = food[7][i]; return { grams: amount * perUnit(row), amount: amount, unit: shown || row[1], label: row[1], basis: 'alias_default', note: note }; }
    }
    if (!alias) {
      var cr = countRows(food);
      if (cr.length === 1) { row = food[7][cr[0]]; return { grams: amount * perUnit(row), amount: amount, unit: shown || row[1], label: row[1], basis: 'usda_portion', note: note }; }
      return { fail: cr.length ? 'USDA lists several measures for this food (' + cr.length + '); pick one from the measure list or enter grams.'
        : 'USDA lists no per-item measure for this food. Use a unit (g, cup, tbsp, ...) or enter grams.' };
    }
    return { fail: 'USDA lists no per-item measure for this food. Use a unit (g, cup, tbsp, ...) or enter grams.' };
  }
  function indexOfLabel(food, label) {
    for (var i = 0; i < food[7].length; i++) if (food[7][i][1] === label) return i;
    return null;
  }

  // ---------- estimate ----------
  function blankItem(pi) {
    return { raw: pi.raw, food: pi.food, amount: pi.amount, unit: pi.unit, status: 'unparsed', candidates: [], chosen: null,
      portion: null, grams: null, nutrients: null, provenance: null, portions: [], message: '' };
  }

  function unitKey(u) {
    if (u === null) return null;
    var k = typeof u === 'string' ? u.toLowerCase().replace(/\.$/, '') : '';
    if (k === 'count' || k === 'each' || k === '') return null;
    return own(UNIT_WORDS, k) ? UNIT_WORDS[k] : undefined;
  }

  var JOIN_HINT = ' Typed as one food because the database has a dish with that name; use a comma to enter the foods separately.';
  function estimateParsed(p, pi, opts) {
    var it = estimateCore(p, pi, opts);
    if (pi.joined && it && typeof it.message === 'string') it.message = (it.message + JOIN_HINT).replace(/^ /, '');
    return it;
  }

  function estimateCore(p, pi, opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    var it = blankItem(pi), amount = pi.amount, unit = pi.unit, food = pi.food;
    if (isNum(opts.amount)) amount = opts.amount;
    if (own(opts, 'unit') && opts.unit !== undefined) {
      var uk = unitKey(opts.unit);
      if (uk !== undefined) unit = uk;
    }
    it.amount = amount; it.unit = unit;
    var idx = null, alias = null, size = null, i;
    var hasPick = isNum(opts.fdcId);
    if (pi.problem && !hasPick) {
      it.message = pi.problem === 'range' ? 'Give one quantity, not a range (for example "2 eggs", not "2-3 eggs").'
        : pi.problem === 'zero' ? 'The quantity must be above 0.' : 'The quantity is too large.';
      return it;
    }
    size = stripSize(food).size;

    var ts = food ? textSearch(p, food) : { cands: [], full: 0, q: [] };
    if (hasPick) {
      var key = (typeof opts.dataset === 'string' ? opts.dataset : null);
      var ix = key ? p.byKey[key + ':' + opts.fdcId] : (p.byKey['SR:' + opts.fdcId] !== undefined ? p.byKey['SR:' + opts.fdcId] : p.byKey['FF:' + opts.fdcId]);
      if (ix === undefined) { it.status = 'no_match'; it.message = 'No match: food ' + opts.fdcId + ' is not in the database.'; return it; }
      idx = ix;
      var la = food ? lookupAlias(p, food) : null;
      if (la && la.a.idx === idx) alias = la.a;
    } else {
      if (!food) { it.message = 'No food name found. Type what you ate, for example "2 eggs".'; return it; }
      var found = lookupAlias(p, food);
      if (found) { alias = found.a; idx = alias.idx; if (found.size) size = found.size; }
    }
    // candidates: chosen/alias food first, then the best text matches (top 5)
    var cands = [], used = Object.create(null);
    if (idx !== null) { cands.push(candOf(p, idx, 1)); used[idx] = 1; }
    for (i = 0; i < ts.cands.length && cands.length < 5; i++) { if (!used[ts.cands[i].idx]) { cands.push(candOf(p, ts.cands[i].idx, ts.cands[i].score)); used[ts.cands[i].idx] = 1; } }
    it.candidates = cands;

    if (idx === null) {
      if (!ts.cands.length) { it.status = 'no_match'; it.message = 'No match in the USDA food list. Enter the values by hand.'; it.candidates = []; return it; }
      // Claude P6 review: "exactly one food contains every typed word" alone chose foods the owner did not mean
      // ("1 bowl rice" -> frozen chicken rice bowl entree, "1 baked egg" -> egg custard dessert, "1 baked cheddar"
      // -> one Goldfish cracker). A text match is now chosen by itself only when the USDA description has no words
      // beyond the ones typed (same word set). Otherwise it is offered first in the list and the owner picks it.
      if (ts.full === 1 && ts.cands[0].score === 1 && p.toks[ts.cands[0].idx] === ts.q.length) { idx = ts.cands[0].idx; }
      else {
        it.status = 'ambiguous';
        it.message = ts.full === 1 && ts.cands[0].score === 1
          ? 'One USDA food contains all the words you typed (“' + p.db.foods[ts.cands[0].idx][2] + '”), but it also says more. Check it is what you ate and choose it; nothing is counted until you do.'
          : 'Several USDA foods fit. Pick one; nothing is counted until you do.';
        return it;
      }
    }
    var f = p.db.foods[idx];
    it.chosen = { fdcId: f[0], dataset: f[1], description: f[2] };
    it.portions = portionList(f);
    var userGrams = isNum(opts.grams) && opts.grams > 0;
    if (amount === null && !userGrams) { it.status = 'unparsed'; it.message = 'Add a quantity (for example "150 g" or "2") for ' + f[2] + '.'; return it; }
    if (amount === null) amount = 1;
    var pr = resolvePortion(f, amount, unit, size, alias, opts);
    if (pr.fail) { it.status = 'no_portion'; it.message = pr.fail; return it; }
    var grams = round2(pr.grams);
    if (!(grams > 0)) { it.status = 'unparsed'; it.message = 'The quantity is too small to estimate.'; return it; }
    var k100 = [f[3], f[4], f[5] < 0 ? 0 : f[5], f[6]], notes = [];
    if (f[5] < 0) notes.push('USDA lists a slightly negative carbohydrate-by-difference for this food; it is counted as 0 g.');
    var nut = { kcal: Math.round(k100[0] * grams / 100), proteinG: round1(k100[1] * grams / 100), carbsG: round1(k100[2] * grams / 100), fatG: round1(k100[3] * grams / 100) };
    if (nut.kcal > MACRO_LIMIT.kcal || nut.proteinG > MACRO_LIMIT.proteinG || nut.carbsG > MACRO_LIMIT.carbsG || nut.fatG > MACRO_LIMIT.fatG) {
      it.status = 'unparsed'; it.grams = grams;
      it.message = 'The quantity is too large for one item (' + grams + ' g). Check the number.'; return it;
    }
    it.status = 'matched';
    it.portion = { amount: pr.amount, unit: pr.unit, label: pr.label, grams: grams, basis: pr.basis };
    it.grams = grams;
    it.nutrients = nut;
    it.provenance = { source: SOURCE, dataset: f[1], fdcId: f[0], description: f[2],
      portion: pr.amount + ' ' + pr.label + ' [' + pr.basis + ']', grams: grams, dbVersion: p.db.meta.dbVersion };
    if (alias && alias.note) notes.push(alias.note);
    if (pr.note) notes.push(pr.note);
    it.message = notes.join(' ');
    return it;
  }

  function emptyTotals() { return { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, matchedCount: 0, unmatchedCount: 0 }; }

  function estimate(text, db) {
    try {
      var r = resolveDb(db);
      if (!r.ok) return r;
      var ps = parse(text, null, r.p), items = [], t = emptyTotals(), i;
      for (i = 0; i < ps.items.length; i++) {
        var it = estimateParsed(r.p, ps.items[i], null);
        items.push(it);
        if (it.status === 'matched') {
          t.kcal += it.nutrients.kcal; t.proteinG += it.nutrients.proteinG; t.carbsG += it.nutrients.carbsG; t.fatG += it.nutrients.fatG; t.matchedCount++;
        } else t.unmatchedCount++;
      }
      t.kcal = Math.round(t.kcal); t.proteinG = round1(t.proteinG); t.carbsG = round1(t.carbsG); t.fatG = round1(t.fatG);
      return { ok: true, dbVersion: r.p.db.meta.dbVersion, items: items, totals: t, truncated: ps.truncated };
    } catch (e) {
      return { ok: false, code: 'db_invalid', message: 'The estimate could not be computed.', items: [] };
    }
  }

  function estimateItem(raw, db, opts) {
    try {
      var r = resolveDb(db);
      if (!r.ok) return r;
      var n = normalizeInput(typeof raw === 'string' ? raw : '');
      var pi = parseOne(n.text.replace(/[\n\r\u2028\u2029]+/g, ' '));
      return estimateParsed(r.p, pi, opts);
    } catch (e) {
      return { ok: false, code: 'db_invalid', message: 'The estimate could not be computed.', items: [] };
    }
  }

  // ---------- meal components ----------
  function cap(s, n) { s = String(s); return s.length > n ? s.slice(0, n) : s; }
  function est(v) { return { value: v, state: 'ESTIMATED' }; }

  function toComponents(result) {
    var out = { components: [], unmatched: [] };
    if (!result || result.ok !== true || !Array.isArray(result.items)) return out;
    for (var i = 0; i < result.items.length && i < MAX_ITEMS; i++) {
      var it = result.items[i];
      if (!it || typeof it !== 'object') continue;
      if (it.status !== 'matched' || !it.nutrients || !it.provenance || !it.portion) {
        out.unmatched.push({ raw: String(it && it.raw || ''), status: String(it && it.status || 'unparsed'), message: String(it && it.message || '') });
        continue;
      }
      var base = it.food ? it.food.charAt(0).toUpperCase() + it.food.slice(1) : it.chosen.description;
      var p = it.portion;
      var portion = (p.basis === 'mass' || p.basis === 'user_grams') ? p.amount + ' ' + p.unit : p.amount + ' ' + p.label + ' (' + p.grams + ' g)';
      out.components.push({
        name: cap(base, 80), role: 'OTHER', portion: cap(portion, 80), preparation: '', eatenFraction: null,
        kcal: est(it.nutrients.kcal), proteinG: est(it.nutrients.proteinG), carbsG: est(it.nutrients.carbsG), fatG: est(it.nutrients.fatG),
        provenance: { source: it.provenance.source, dataset: it.provenance.dataset, fdcId: it.provenance.fdcId, description: it.provenance.description,
          portion: it.provenance.portion, grams: it.provenance.grams, dbVersion: it.provenance.dbVersion }
      });
    }
    return out;
  }

  return {
    loadDb: loadDb, parse: parse, estimate: estimate, estimateItem: estimateItem, toComponents: toComponents,
    ALIASES: ALIASES, MAX_INPUT_CHARS: MAX_INPUT_CHARS, MAX_ITEMS: MAX_ITEMS, MACRO_LIMIT: MACRO_LIMIT
  };
});
