/*
 * photo-ai.js - provider-neutral food-photo analysis adapter.
 * - Photos are transient: never written to storage, backups or logs by this module.
 * - Metadata (EXIF/GPS/XMP/comments) is stripped before any provider sees the image.
 * - Nothing is sent without per-request consent; MOCK results are always labelled MOCK.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HyroxPhotoAI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = Object.freeze({ maxInputBytes: 15 * 1024 * 1024, maxSide: 1280, maxUploadBytes: 1500000, timeoutMs: 45000, maxItems: 20,
    // P10: 1-3 photos of ONE meal share the single-photo budget. Each photo is re-encoded to <= targetBytes when it can be.
    maxImages: 3, targetBytes: 500000, multiMaxImageBytes: 550000, multiMaxTotalBytes: 1500000 });
  // Fixed photo labels (never free text): same plate / before / after / additional dish.
  var LABELS = ['SAME_PLATE', 'BEFORE', 'AFTER', 'EXTRA_DISH'];
  var LABEL_NAMES = { SAME_PLATE: 'Same plate', BEFORE: 'Before eating', AFTER: 'After eating', EXTRA_DISH: 'Additional dish' };
  var ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  var EXT_TYPE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
  var CONF = ['LOW', 'MEDIUM', 'HIGH'];
  var ITEM_KEYS = ['name', 'preparation', 'portion', 'eatenFraction', 'kcal', 'proteinG', 'carbsG', 'fatG', 'confidence', 'uncertainty', 'role', 'basis'];
  // P0 sprint: where an estimated item came from (model-reported). USER = added by the owner in the review.
  var BASES = ['PHOTO', 'NOTE', 'BOTH'];
  var TOP_KEYS = ['schemaVersion', 'items', 'warnings', 'model', 'provider'];
  var ROLES = ['MAIN', 'SIDE', 'OIL', 'SAUCE', 'DRINK', 'CONDIMENT', 'OTHER'];
  var MAX = { kcal: 5000, proteinG: 400, carbsG: 800, fatG: 400 };

  function err(code, message) { return { ok: false, code: code, message: message }; }

  function validateFile(f) {
    if (!f) return err('NO_FILE', 'No photo selected.');
    var type = String(f.type || '').toLowerCase();
    if (!type && f.name) type = EXT_TYPE[(String(f.name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1]] || '';
    if (ACCEPT.indexOf(type) === -1) return err('UNSUPPORTED_TYPE', 'Unsupported file type. Use a JPEG, PNG, WebP or iPhone HEIC photo.');
    if (!(f.size > 0)) return err('EMPTY_FILE', 'The photo file is empty.');
    if (f.size > LIMITS.maxInputBytes) return err('TOO_LARGE', 'Photo is larger than 15 MB.');
    return { ok: true };
  }

  // ---------- JPEG metadata stripping (pure, byte level) ----------
  function isJpeg(b) { return b && b.length > 3 && b[0] === 0xFF && b[1] === 0xD8; }

  // Removes APP1–APP15 (EXIF, XMP, GPS, ICC, maker notes) and COM segments. Keeps APP0/JFIF and image data.
  function stripJpegMetadata(bytes) {
    if (!isJpeg(bytes)) throw new Error('NOT_JPEG');
    var out = [bytes.subarray(0, 2)], i = 2, len = bytes.length;
    while (i < len) {
      if (bytes[i] !== 0xFF) throw new Error('CORRUPT_JPEG');
      var marker = bytes[i + 1];
      if (marker === 0xD9) { out.push(bytes.subarray(i, i + 2)); i += 2; break; }
      if (marker === 0xDA) { out.push(bytes.subarray(i)); i = len; break; }
      if (marker >= 0xD0 && marker <= 0xD7 || marker === 0x01) { out.push(bytes.subarray(i, i + 2)); i += 2; continue; }
      if (i + 3 >= len) throw new Error('CORRUPT_JPEG');
      var segLen = (bytes[i + 2] << 8) | bytes[i + 3];
      if (segLen < 2 || i + 2 + segLen > len) throw new Error('CORRUPT_JPEG');
      var drop = (marker >= 0xE1 && marker <= 0xEF) || marker === 0xFE;
      if (!drop) out.push(bytes.subarray(i, i + 2 + segLen));
      i += 2 + segLen;
    }
    var total = out.reduce(function (a, s) { return a + s.length; }, 0);
    var res = new Uint8Array(total), o = 0;
    out.forEach(function (s) { res.set(s, o); o += s.length; });
    return res;
  }

  // True if any APP1..APP15/COM segment remains (EXIF/GPS/XMP/comment).
  function hasMetadata(bytes) {
    if (!isJpeg(bytes)) return false;
    var i = 2;
    while (i + 3 < bytes.length && bytes[i] === 0xFF) {
      var m = bytes[i + 1];
      if (m === 0xDA || m === 0xD9) return false;
      if ((m >= 0xE1 && m <= 0xEF) || m === 0xFE) return true;
      i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    }
    return false;
  }

  function toBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }

  // Browser only: decode, downscale, re-encode to JPEG (canvas output carries no EXIF), then byte-strip again.
  function sanitizeInBrowser(file) {
    var v = validateFile(file);
    if (!v.ok) return Promise.resolve(v);
    // P10: re-encode at falling quality/size until the photo is <= LIMITS.targetBytes (so 3 photos fit one request).
    // The first step is exactly the P9 encode (1280 px, quality 0.85); most food photos stop there.
    var STEPS = [[LIMITS.maxSide, 0.85], [LIMITS.maxSide, 0.72], [1024, 0.7], [800, 0.65]];
    function draw(src, w, h) {
      function step(k) {
        var scale = Math.min(1, STEPS[k][0] / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        var c = document.createElement('canvas'); c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(src, 0, 0, cw, ch);
        return new Promise(function (res) { c.toBlob(function (b) { res({ blob: b, w: cw, h: ch }); }, 'image/jpeg', STEPS[k][1]); }).then(function (r) {
          if (r.blob && r.blob.size > LIMITS.targetBytes && k + 1 < STEPS.length) return step(k + 1);
          return r;
        });
      }
      return step(0);
    }
    function decode() {
      if (typeof createImageBitmap === 'function') {
        return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bm) { return draw(bm, bm.width, bm.height); });
      }
      return new Promise(function (res, rej) {
        var url = URL.createObjectURL(file), img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); res(draw(img, img.naturalWidth, img.naturalHeight)); };
        img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('DECODE')); };
        img.src = url;
      });
    }
    return decode().then(function (r) {
      if (!r.blob) return err('ENCODE_FAILED', 'Could not prepare the photo.');
      return r.blob.arrayBuffer().then(function (ab) {
        var bytes = stripJpegMetadata(new Uint8Array(ab));
        if (hasMetadata(bytes)) return err('METADATA_REMAINS', 'Could not remove photo metadata, so it will not be sent.');
        if (bytes.length > LIMITS.maxUploadBytes) return err('TOO_LARGE', 'Prepared photo is still too large.');
        return { ok: true, image: { sanitized: true, mime: 'image/jpeg', bytes: bytes, width: r.w, height: r.h,
          blob: new Blob([bytes], { type: 'image/jpeg' }) } };
      });
    }).catch(function () { return err('CORRUPT_IMAGE', 'This photo could not be read (damaged or unsupported).'); });
  }

  // ---------- result validation ----------
  function badText(s, max) {
    return typeof s !== 'string' || s.length > max || /[<>]|javascript:|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/i.test(s);
  }
  function numOrNull(v, max) { return v === null || (typeof v === 'number' && isFinite(v) && v >= 0 && v <= max); }

  function validateResult(obj) {
    var errors = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['Response is not an object.'] };
    Object.keys(obj).forEach(function (k) { if (TOP_KEYS.indexOf(k) === -1) errors.push('Unexpected field: ' + k); });
    if (obj.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
    if (!Array.isArray(obj.items) || obj.items.length > LIMITS.maxItems) errors.push('items must be a list of at most ' + LIMITS.maxItems + '.');
    if (!Array.isArray(obj.warnings) || obj.warnings.some(function (w) { return badText(w, 300); })) errors.push('warnings must be safe short texts.');
    if (badText(obj.model, 80) || badText(obj.provider, 80)) errors.push('model/provider must be safe text.');
    (Array.isArray(obj.items) ? obj.items : []).forEach(function (it, i) {
      var p = 'items[' + i + ']';
      if (!it || typeof it !== 'object' || Array.isArray(it)) { errors.push(p + ' is not an object.'); return; }
      Object.keys(it).forEach(function (k) { if (ITEM_KEYS.indexOf(k) === -1) errors.push(p + ' unexpected field: ' + k); });
      if (badText(it.name, 80) || !it.name.trim()) errors.push(p + '.name invalid.');
      ['preparation', 'portion', 'uncertainty'].forEach(function (k) { if (it[k] != null && badText(it[k], 200)) errors.push(p + '.' + k + ' invalid.'); });
      if (it.role != null && ROLES.indexOf(it.role) === -1) errors.push(p + '.role invalid.');
      if (it.basis != null && BASES.indexOf(it.basis) === -1) errors.push(p + '.basis invalid.');
      if (it.eatenFraction != null && !numOrNull(it.eatenFraction, 1)) errors.push(p + '.eatenFraction must be 0–1 or null.');
      Object.keys(MAX).forEach(function (k) { if (!numOrNull(it[k], MAX[k])) errors.push(p + '.' + k + ' must be null or 0–' + MAX[k] + ' (null = unknown).'); });
      if (CONF.indexOf(it.confidence) === -1) errors.push(p + '.confidence must be LOW, MEDIUM or HIGH.');
      if ([it.kcal, it.proteinG, it.carbsG, it.fatG].every(function (v) { return typeof v === 'number'; })) {
        var implied = it.proteinG * 4 + it.carbsG * 4 + it.fatG * 9;
        if (implied > it.kcal * 1.6 + 50 || implied < it.kcal * 0.4 - 50) errors.push(p + ' macros are physically inconsistent with kcal.');
      }
    });
    return errors.length ? { ok: false, errors: errors } : { ok: true, value: JSON.parse(JSON.stringify(obj)) };
  }

  // Converts a validated result into editable meal components. Null stays UNKNOWN.
  function resultToComponents(result) {
    return result.items.map(function (it) {
      function m(v) { return v === null || v === undefined ? { value: null, state: 'UNKNOWN' } : { value: v, state: 'ESTIMATED' }; }
      var c = { name: it.name, role: it.role || 'MAIN', portion: it.portion || '', preparation: it.preparation || '',
        // Owner rule: how much was eaten is never taken from the photo or the model. It stays
        // unstated (null) until the owner says so for the meal or for this item.
        eatenFraction: null,
        kcal: m(it.kcal), proteinG: m(it.proteinG), carbsG: m(it.carbsG), fatG: m(it.fatG),
        confidence: it.confidence, uncertainty: it.uncertainty || '' };
      // P0 sprint: provenance of the item (model-reported), kept only when the server sent a valid one
      if (BASES.indexOf(it.basis) !== -1) c.basis = it.basis;
      return c;
    });
  }

  // ---------- providers ----------
  function unconfigured() {
    return { id: 'none', mode: 'NONE', label: 'Photo analysis not configured', terms: null,
      analyze: function () { return Promise.resolve(err('NOT_CONFIGURED', 'Photo analysis is not configured. Use description or manual entry.')); } };
  }

  var MOCK_FIXTURES = {
    plate: { schemaVersion: 1, provider: 'mock-fixture', model: 'mock-fixture-v1',
      warnings: ['MOCK TEST fixture — not a real analysis.', 'Cooking oil and sauce amounts cannot be seen in a photo.'],
      items: [
        { name: 'Grilled chicken breast', role: 'MAIN', preparation: 'grilled', portion: 'about one palm', eatenFraction: 1, kcal: 220, proteinG: 40, carbsG: 0, fatG: 5, confidence: 'MEDIUM', uncertainty: 'portion ±30%' },
        { name: 'White rice', role: 'SIDE', preparation: 'boiled', portion: 'about one cup', eatenFraction: 1, kcal: 240, proteinG: 5, carbsG: 53, fatG: 1, confidence: 'MEDIUM', uncertainty: 'portion ±30%' },
        { name: 'Cooking oil', role: 'OIL', preparation: 'unknown', portion: 'not visible', eatenFraction: null, kcal: null, proteinG: null, carbsG: null, fatG: null, confidence: 'LOW', uncertainty: 'not knowable from photo' }
      ] },
    // P10 acceptance fixture: chicken pieces and the sauce as two NON-overlapping items, served-portion basis.
    butterChicken: { schemaVersion: 1, provider: 'mock-fixture', model: 'mock-fixture-v1',
      warnings: ['MOCK TEST fixture — not a real analysis.', 'Hidden oil, butter and sauce amounts cannot be seen in a photo. Fill them in if you know them, or leave them unknown.'],
      items: [
        { name: 'Chicken pieces (butter chicken)', role: 'MAIN', preparation: 'tandoor-grilled, in sauce', portion: 'about 150 g cooked', eatenFraction: null, kcal: 250, proteinG: 38, carbsG: 2, fatG: 10, confidence: 'MEDIUM', uncertainty: 'portion ±30%' },
        { name: 'Butter chicken sauce', role: 'SAUCE', preparation: 'tomato, butter and cream gravy', portion: 'about one cup', eatenFraction: null, kcal: 300, proteinG: 4, carbsG: 14, fatG: 26, confidence: 'LOW', uncertainty: 'butter and cream amounts not visible' },
        { name: 'Cooking oil / ghee', role: 'OIL', preparation: 'unknown', portion: 'not visible', eatenFraction: null, kcal: null, proteinG: null, carbsG: null, fatG: null, confidence: 'LOW', uncertainty: 'not knowable from photo' }
      ] },
    unknown: { schemaVersion: 1, provider: 'mock-fixture', model: 'mock-fixture-v1', warnings: ['MOCK TEST fixture — not a real analysis.', 'No food could be identified.'], items: [] },
    invalid: { schemaVersion: 1, provider: 'mock-fixture', model: 'mock-fixture-v1', warnings: [], items: [{ name: '<img src=x onerror=alert(1)>', kcal: -5, confidence: 'SURE', extra: true }] },
    impossible: { schemaVersion: 1, provider: 'mock-fixture', model: 'mock-fixture-v1', warnings: [], items: [{ name: 'Salad', kcal: 50, proteinG: 100, carbsG: 100, fatG: 100, confidence: 'HIGH' }] }
  };

  function mock(opts) {
    var scenario = (opts && opts.scenario) || 'plate';
    var delay = opts && typeof opts.delayMs === 'number' ? opts.delayMs : 300;
    return { id: 'mock', mode: 'MOCK', label: 'MOCK TEST provider (fixture data, nothing is sent anywhere)', terms: 'No network. No cost. Fixed fake responses.',
      calls: 0,
      analyze: function () {
        this.calls++;
        return new Promise(function (resolve, reject) {
          if (scenario === 'timeout') return; // never resolves; caller timeout applies
          setTimeout(function () {
            if (scenario === 'error') return reject(new Error('MOCK_PROVIDER_ERROR'));
            if (scenario === 'quota') return resolve({ httpStatus: 402, body: { detail: { code: 'BUDGET_EXHAUSTED' } } });
            resolve({ httpStatus: 200, body: JSON.parse(JSON.stringify(MOCK_FIXTURES[scenario] || MOCK_FIXTURES.plate)) });
          }, delay);
        });
      } };
  }

  // Calls a same-origin backend (the isolated local test backend, or the P9 Netlify Function).
  // The browser never holds provider API keys. opts.getToken (optional) supplies the owner access code, which is sent
  // only as a bearer header to this endpoint.
  function http(opts) {
    var endpoint = String(opts.endpoint || '').replace(/\/$/, '');
    var f = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(null) : null);
    function authHeaders(h) {
      var t = typeof opts.getToken === 'function' ? opts.getToken() : null;
      if (t) h['Authorization'] = 'Bearer ' + t;
      return h;
    }
    return { id: opts.live ? 'live' : 'http', mode: 'REAL', live: !!opts.live, label: opts.label || ('Local test backend (' + endpoint + ')'), endpoint: endpoint, terms: null,
      status: function () {
        return f(endpoint + '/status', { method: 'GET', headers: authHeaders({}) }).then(function (r) { return r.json(); });
      },
      // Normalised connection state for the settings/photo UI. Never throws.
      check: function () {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve({ state: 'offline' });
        return f(endpoint + '/status', { method: 'GET', headers: authHeaders({}) }).then(function (r) {
          return r.json().catch(function () { return null; }).then(function (b) {
            var code = b && b.detail && b.detail.code;
            if (r.status === 503 || code === 'NOT_CONFIGURED') return { state: 'not_configured' };
            if (r.status === 429 || code === 'LOCKED_OUT') return { state: 'locked' };
            if (r.status === 401 || code === 'AUTH') return { state: 'bad_code' };
            if (r.status === 200 && b && b.configured === true) {
              if (b.authorized === true) return { state: 'ready', info: b };
              return { state: 'needs_code', info: b };
            }
            return { state: 'error' };
          });
        }, function () { return { state: (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'offline' : 'error' }; });
      },
      analyze: function (payload) {
        var b = payload.images
          ? { images: payload.images, description: payload.description, consent: payload.consent, requestId: payload.requestId, itemBasis: payload.itemBasis === true ? true : undefined }
          : { imageBase64: payload.imageBase64, mimeType: payload.mimeType, description: payload.description, consent: payload.consent, requestId: payload.requestId, itemBasis: payload.itemBasis === true ? true : undefined };
        return f(endpoint + '/analyze', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json', 'X-Hyrox-Consent': 'send-once' }),
          body: JSON.stringify(b), signal: payload.signal })
          .then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { return { httpStatus: r.status, body: b }; }); });
      } };
  }

  // Short, plain messages for the states the owner can actually hit. Falls back to the server's message.
  var FRIENDLY = {
    NOT_CONFIGURED: 'Photo analysis is not set up yet. Describe the meal or enter it manually.',
    AUTH: 'Owner access code missing or wrong. Enter it in Settings.',
    LOCKED_OUT: 'Too many wrong codes. Try again in 30 minutes.',
    NOT_AUTHORIZED: 'This request was not allowed.',
    OFFLINE: 'You appear to be offline. Nothing was sent.',
    TIMEOUT: 'The analysis took too long. Nothing was saved. Try again or enter manually.',
    PROVIDER_ERROR: 'The analysis service had a problem. Nothing was saved. Try again or enter manually.',
    INVALID_RESPONSE: 'The service gave an answer that failed safety checks, so it was discarded. Enter the meal manually.',
    RATE_LIMIT: 'Too many analyses too quickly. Wait a minute and try again.',
    QUOTA_EXHAUSTED: 'The daily or monthly photo limit is reached. Nothing was sent. Describe the meal instead.',
    BUDGET_EXHAUSTED: 'The photo-analysis budget is used up. Nothing was sent. Describe the meal instead.',
    STORAGE_UNAVAILABLE: 'Photo analysis is switched off right now (usage tracking unavailable). Nothing was sent.',
    IN_FLIGHT: 'This photo is already being analysed.',
    TOO_LARGE: 'The photo is too large. Try another one.',
    TOO_MANY_IMAGES: 'At most 3 photos per meal. Remove one. Nothing was sent.',
    DUPLICATE_IMAGE: 'The same photo was added twice. Remove the copy. Nothing was sent.',
    NETWORK: 'Could not reach the analysis service. Check your connection. Nothing was sent.'
  };
  function friendlyMessage(code, fallback, diag) {
    if (diag && CATEGORY_ACTION[diag.category] && (code === 'PROVIDER_ERROR' || code === 'INVALID_RESPONSE')) return CATEGORY_ACTION[diag.category];
    return FRIENDLY[code] || fallback || 'The analysis did not return a result.';
  }
  // P10: one plain action per provider failure category (the server sends only allowlisted categories).
  var CATEGORY_ACTION = {
    KEY_INVALID: 'Photo analysis is not working: the server\'s OpenAI key is missing or wrong. Owner: check OPENAI_API_KEY in Netlify. Nothing was saved; enter the meal manually.',
    MODEL_ACCESS: 'Photo analysis is not working: the OpenAI project cannot use the configured model. Owner: check model access for the key\'s project. Nothing was saved.',
    SCHEMA_REJECTED: 'OpenAI rejected the request format. This needs an app fix. Nothing was saved; enter the meal manually.',
    REQUEST_REJECTED: 'OpenAI refused this request (often the photo). Try another photo or enter the meal manually. Nothing was saved.',
    PROVIDER_DOWN: 'The analysis service had a problem (OpenAI is having trouble right now). Nothing was saved. Try again later or enter the meal manually.',
    NETWORK: 'The server could not reach OpenAI. Nothing was saved. Try again in a minute.',
    INCOMPLETE: 'The model did not finish its answer. Nothing was saved. Try again or enter the meal manually.',
    REFUSED: 'The model declined to analyse this photo. Nothing was saved; enter the meal manually.',
    INVALID_OUTPUT: 'The service gave an answer that failed safety checks, so it was discarded. Enter the meal manually.'
  };
  // Keeps only allowlisted, pattern-checked diagnostic fields from a server error (never free text).
  var DIAG_CATS = ['KEY_INVALID', 'MODEL_ACCESS', 'SCHEMA_REJECTED', 'REQUEST_REJECTED', 'QUOTA', 'RATE_LIMITED', 'PROVIDER_DOWN', 'TIMEOUT', 'NETWORK', 'INCOMPLETE', 'REFUSED', 'INVALID_OUTPUT', 'UNKNOWN'];
  function safeDiag(d) {
    if (!d || typeof d !== 'object') return null;
    var o = {};
    if (DIAG_CATS.indexOf(d.category) !== -1) o.category = d.category;
    if (typeof d.providerStatus === 'number' && d.providerStatus >= 100 && d.providerStatus < 600 && Math.floor(d.providerStatus) === d.providerStatus) o.providerStatus = d.providerStatus;
    if (typeof d.providerCode === 'string' && /^[a-z_]{1,48}$/.test(d.providerCode)) o.providerCode = d.providerCode;
    if (typeof d.providerRequestId === 'string' && /^[A-Za-z0-9_-]{6,100}$/.test(d.providerRequestId)) o.providerRequestId = d.providerRequestId;
    return Object.keys(o).length ? o : null;
  }
  // P10: stable request id for one draft's photo set + note: a retry of the SAME photos and note reuses it, so the
  // server replays or refuses an overlapping call instead of paying twice. Different photos/order/labels/note -> new id.
  function fnv(str, seed) { var h = seed >>> 0; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
  function requestKey(set, note, nonce) {
    var parts = [String(nonce || ''), String(note || '')];
    (set || []).forEach(function (p) { parts.push(p.label || 'SAME_PLATE'); parts.push(String(p.image.bytes.length)); parts.push(toBase64(p.image.bytes)); });
    var s = parts.join('|');
    return 'm' + fnv(s, 2166136261).toString(36) + fnv(s, 0x9747b28c).toString(36) + '-' + (set || []).length;
  }

  var HTTP_CODES = { 400: 'BAD_REQUEST', 401: 'AUTH', 402: 'BUDGET_EXHAUSTED', 403: 'NOT_AUTHORIZED', 409: 'IN_FLIGHT', 413: 'TOO_LARGE', 429: 'RATE_LIMIT', 502: 'PROVIDER_ERROR', 503: 'NOT_CONFIGURED', 504: 'TIMEOUT' };

  // Single-flight analysis session. Returns {ok, result} or {ok:false, code, message}. Never fabricates results.
  function createSession(provider, options) {
    var inFlight = false;
    var timeoutMs = options && options.timeoutMs || LIMITS.timeoutMs;
    return {
      analyze: function (req) {
        if (inFlight) return Promise.resolve(err('IN_FLIGHT', 'An analysis is already running.'));
        if (!provider || provider.mode === 'NONE') return provider ? provider.analyze() : Promise.resolve(err('NOT_CONFIGURED', 'Photo analysis is not configured.'));
        if (!req || !req.consent || req.consent.privacyAck !== true || req.consent.sendThisPhoto !== true) {
          return Promise.resolve(err('NO_CONSENT', 'Nothing was sent: consent for this photo was not given.'));
        }
        // P10: req.images = [{ image, label }] (1-3 photos of one meal) or the P9 req.image (one photo).
        var set = Array.isArray(req.images) ? req.images : (req.image ? [{ image: req.image, label: 'SAME_PLATE' }] : []);
        if (!set.length || set.some(function (p) { return !p || !p.image || p.image.sanitized !== true || hasMetadata(p.image.bytes); })) {
          return Promise.resolve(err('NOT_SANITIZED', 'Nothing was sent: the photo was not cleaned of metadata.'));
        }
        if (set.length > LIMITS.maxImages) return Promise.resolve(err('TOO_MANY_IMAGES', 'At most ' + LIMITS.maxImages + ' photos per meal. Nothing was sent.'));
        if (set.some(function (p) { return LABELS.indexOf(p.label || 'SAME_PLATE') === -1; })) return Promise.resolve(err('BAD_REQUEST', 'Unknown photo label. Nothing was sent.'));
        if (set.length > 1) {
          var tot = 0;
          for (var si = 0; si < set.length; si++) {
            if (set[si].image.bytes.length > LIMITS.multiMaxImageBytes) return Promise.resolve(err('TOO_LARGE', 'Photo ' + (si + 1) + ' is too large to send with others. Remove it or retake it. Nothing was sent.'));
            tot += set[si].image.bytes.length;
          }
          if (tot > LIMITS.multiMaxTotalBytes) return Promise.resolve(err('TOO_LARGE', 'These photos are too large together. Remove one. Nothing was sent.'));
        }
        if (typeof navigator !== 'undefined' && navigator.onLine === false && provider.mode === 'REAL') {
          return Promise.resolve(err('OFFLINE', 'You appear to be offline. Nothing was sent.'));
        }
        inFlight = true;
        var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        var timer;
        var timeout = new Promise(function (resolve) {
          timer = setTimeout(function () { if (ctrl) ctrl.abort(); resolve({ timeout: true }); }, timeoutMs);
        });
        var payload = set.length === 1
          ? { imageBase64: toBase64(set[0].image.bytes), mimeType: 'image/jpeg', description: String(req.description || '').slice(0, 500),
            consent: true, requestId: req.requestId || String(Date.now()), itemBasis: true, signal: ctrl ? ctrl.signal : undefined }
          : { images: set.map(function (p) { return { imageBase64: toBase64(p.image.bytes), mimeType: 'image/jpeg', label: p.label || 'SAME_PLATE' }; }),
            description: String(req.description || '').slice(0, 500), consent: true, requestId: req.requestId || String(Date.now()), itemBasis: true, signal: ctrl ? ctrl.signal : undefined };
        return Promise.race([provider.analyze(payload), timeout]).then(function (r) {
          if (r && r.timeout) return err('TIMEOUT', 'The analysis timed out. Nothing was saved; try again or enter manually.');
          if (!r || r.httpStatus !== 200) {
            var code = (r && r.body && r.body.detail && r.body.detail.code) || HTTP_CODES[r && r.httpStatus] || 'PROVIDER_ERROR';
            var msg = (r && r.body && r.body.detail && r.body.detail.message) || 'The analysis service did not return a result.';
            var e = err(code, msg), dg = safeDiag(r && r.body && r.body.detail);
            if (dg) e.diag = dg;
            return e;
          }
          var v = validateResult(r.body);
          if (!v.ok) return { ok: false, code: 'INVALID_RESPONSE', message: 'The analysis response failed safety checks and was discarded.', errors: v.errors };
          v.value.mode = provider.mode;
          v.value.analyzedAt = new Date().toISOString();
          return { ok: true, result: v.value };
        }, function () {
          if (provider.live) return err('NETWORK', FRIENDLY.NETWORK);
          return err('PROVIDER_ERROR', 'The analysis service failed. Nothing was saved; use manual entry.');
        }).then(function (out) { clearTimeout(timer); inFlight = false; payload = null; return out; });
      },
      busy: function () { return inFlight; }
    };
  }

  // ======================================================================================================
  // P10 local helpers (pure, no network, nothing stored). They live in this file, not in src/data/, so the data layer
  // stays byte-identical to Phase 8/9: a rollback to Phase 9 reads every record exactly as before.
  // ======================================================================================================
  // ================= P10: eaten amounts typed in the meal note (deterministic, user-confirmed) =================
  // The photo model never says how much was eaten. When the owner's note says it ("all chicken eaten, 60% sauce"),
  // this reads it with fixed rules and offers it as a SUGGESTION the owner applies with one tap. Applying sets each
  // matched item's own eatenFraction (it replaces, never multiplies), so an amount is applied exactly once.
  // Clauses that state an eaten amount are also removed from the note sent for analysis (served-portion basis), so
  // changing only an eaten amount never makes an estimate stale and never needs a new paid call.
  var QWORDS = [[/\b(all|whole|entire|every bit)\b/, 1], [/\bthree[- ]quarters?\b/, 0.75], [/\bhalf\b/, 0.5], [/\b(a )?quarter\b/, 0.25], [/\bnone\b/, 0]];
  var EAT_VERB = /\b(ate|eaten|eat|finished|had|consumed|drank|drunk)\b/;
  var STOP = ['the', 'of', 'my', 'and', 'with', 'was', 'were', 'were', 'all', 'whole', 'entire', 'every', 'bit', 'half', 'quarter', 'quarters', 'three',
    'none', 'ate', 'eaten', 'eat', 'finished', 'had', 'consumed', 'drank', 'drunk', 'about', 'only', 'just', 'also', 'but', 'its', 'it', 'his', 'her',
    'this', 'that', 'them', 'they', 'from', 'percent', 'pct', 'i', 'a', 'an', 'some', 'of', 'eating', 'left', 'rest'];
  var ROLE_WORDS = { sauce: 'SAUCE', gravy: 'SAUCE', curry: 'SAUCE', dressing: 'SAUCE', oil: 'OIL', ghee: 'OIL', drink: 'DRINK', juice: 'DRINK' };
  var NOT_EATEN_PCT = /^\s*(milk|fat|lean|cocoa|abv|alcohol|dark|whole ?grain|juice concentrate)\b/;
  function words(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9%.\s-]/g, ' ').split(/[\s-]+/).filter(Boolean); }
  function stem(w) { return w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w; }
  function clauses(note) { return String(note || '').split(/[,;\n]+|\.(?!\d)|\s+(?:and|but)\s+/i).map(function (c) { return c.trim(); }).filter(Boolean); }
  // One clause -> { fraction, keywords } when it states an eaten amount, else null.
  function readClause(c) {
    var low = c.toLowerCase(), fraction = null, m = /(\d{1,3}(?:\.\d+)?)\s*(%|percent\b|pct\b)/.exec(low);
    if (m) {
      var v = Number(m[1]);
      if (!(v >= 0 && v <= 100) || NOT_EATEN_PCT.test(low.slice(m.index + m[0].length))) return null;
      if (/\d/.test(low.slice(0, m.index) + low.slice(m.index + m[0].length))) return null; // other numbers = an amount served, not eaten
      fraction = Math.round(v * 10) / 1000;
    } else {
      if (!EAT_VERB.test(low)) return null; // "half portion" or "whole chicken" describe the food, not what was eaten
      if (/\bnone of\b/.test(low)) fraction = 0;
      else for (var i = 0; i < QWORDS.length; i++) if (QWORDS[i][0].test(low)) { fraction = QWORDS[i][1]; break; }
      if (fraction === null) return null;
    }
    var kw = words(low.replace(/\d{1,3}(?:\.\d+)?\s*(%|percent\b|pct\b)/g, ' ')).map(stem).filter(function (w) { return w.length >= 3 && STOP.indexOf(w) === -1 && !/^\d/.test(w); });
    return { text: c, fraction: fraction, keywords: kw };
  }
  // The note sent to the photo model, and the stale-estimate basis: every eaten-amount clause loses its amount and eating
  // words but KEEPS its food words, as typed (Claude P10 review, owner decision 17 Nov 2026: "ate half the rice" keeps
  // "rice" as food context). A clause with no food word ("ate half") disappears. Changing only an amount gives the same
  // note, so it is still local-only and never makes an estimate stale.
  function foodWords(c) {
    var raw = String(c).replace(/\d{1,3}(?:\.\d+)?\s*(%|percent\b|pct\b)/gi, ' ').match(/[A-Za-z][A-Za-z'-]*/g) || [];
    return raw.filter(function (w) { var l = w.toLowerCase(); return l.length >= 3 && STOP.indexOf(l) === -1 && STOP.indexOf(stem(l)) === -1; }).join(' ');
  }
  function analysisNote(note) {
    return clauses(note).map(function (c) { return readClause(c) ? foodWords(c) : c; }).filter(Boolean).join(', ');
  }
  // Suggestions for these components. index -1 = the whole meal (a clause with no food word, e.g. "ate half").
  function noteFractions(note, components) {
    var comps = Array.isArray(components) ? components : [];
    var found = clauses(note).map(readClause).filter(Boolean);
    var best = {}; // component index -> { clause, pos, specific }
    var unmatched = [], meal = null;
    found.forEach(function (cl, ci) {
      if (!cl.keywords.length) { meal = { fraction: cl.fraction, text: cl.text }; return; }
      var hit = false;
      comps.forEach(function (comp, i) {
        var nameW = words(comp.name).map(stem);
        cl.keywords.forEach(function (k) {
          var pos = nameW.lastIndexOf(k), specific = false;
          if (pos === -1 && ROLE_WORDS[k] && comp.role === ROLE_WORDS[k]) { pos = nameW.length; specific = true; }
          if (pos === -1) return;
          hit = true;
          var cur = best[i];
          // a food word later in the name is its head noun ("butter chicken SAUCE" is a sauce): it wins
          if (!cur || pos > cur.pos || (pos === cur.pos && specific && !cur.specific)) best[i] = { clause: ci, pos: pos, specific: specific };
        });
      });
      if (!hit) unmatched.push(cl.text);
    });
    var suggestions = Object.keys(best).map(Number).sort(function (a, b) { return a - b; }).map(function (i) {
      return { index: i, name: String(comps[i].name || ''), fraction: found[best[i].clause].fraction, phrase: found[best[i].clause].text };
    });
    // a clause whose components were all claimed by a more specific clause is reported, not silently dropped
    found.forEach(function (cl, ci) {
      if (!cl.keywords.length || unmatched.indexOf(cl.text) !== -1) return;
      if (!suggestions.some(function (sg) { return sg.phrase === cl.text; })) unmatched.push(cl.text);
    });
    return { suggestions: suggestions, meal: meal, unmatched: unmatched, any: found.length > 0 };
  }
  // Possible double counting: the same food listed twice, or a whole dish listed next to its own sauce.
  var GENERIC = ['sauce', 'gravy', 'curry', 'dressing', 'oil', 'ghee', 'about', 'cooked', 'piece', 'pieces', 'portion', 'serving', 'with', 'and', 'the'];
  function overlapWarnings(components) {
    var comps = Array.isArray(components) ? components : [], out = [];
    function sig(c) { return words(c.name).map(stem).filter(function (w) { return w.length >= 3 && GENERIC.indexOf(w) === -1; }); }
    for (var i = 0; i < comps.length; i++) for (var j = 0; j < comps.length; j++) {
      if (i === j || !String(comps[i].name || '').trim() || !String(comps[j].name || '').trim()) continue;
      var a = sig(comps[i]), b = sig(comps[j]);
      if (i < j && words(comps[i].name).join(' ') === words(comps[j].name).join(' ')) { out.push({ a: i, b: j, kind: 'SAME_NAME', text: '“' + comps[i].name + '” is listed twice. If both are the same food (for example the same plate seen in two photos), remove one.' }); continue; }
      var bIsSauce = comps[j].role === 'SAUCE' || /\b(sauce|gravy|curry|dressing)\b/i.test(comps[j].name);
      var aIsSauce = comps[i].role === 'SAUCE' || /\b(sauce|gravy|dressing)\b/i.test(comps[i].name);
      var wholeA = words(comps[i].name).map(stem).every(function (w) { return GENERIC.indexOf(w) === -1 || w === 'with' || w === 'and'; });
      if (bIsSauce && !aIsSauce && a.length && wholeA && a.every(function (w) { return b.indexOf(w) !== -1; }))
        out.push({ a: i, b: j, kind: 'DISH_AND_SAUCE', text: '“' + comps[i].name + '” may already include “' + comps[j].name + '”. Count the sauce once: keep the solid food and the sauce as separate items, or remove one.' });
    }
    return out;
  }

  // ================= P0 sprint (23 Nov 2026): photo + note are ONE meal — "not accounted for" check =================
  // Production lost "3 eggs, 2 pork patties" when only the yogurt was pictured: the model's list replaced the meal's
  // items and nothing compared it with the note. This reads the foods NAMED in the note with fixed rules (no model, no
  // network) and reports each one that no item accounts for, and any food that appears twice. The app shows these
  // conspicuously and refuses to count the meal until the owner adds/edits an item or explicitly acknowledges each one.
  // Note text is data only: an instruction typed in the note is just an unmatched phrase the owner has to look at.
  var NOTE_UNITS = ['cup', 'cups', 'bowl', 'bowls', 'plate', 'plates', 'serving', 'servings', 'portion', 'portions', 'piece', 'pieces', 'slice', 'slices',
    'gram', 'grams', 'kg', 'oz', 'ml', 'tbsp', 'tsp', 'tablespoon', 'tablespoons', 'teaspoon', 'teaspoons', 'glass', 'glasses', 'can', 'cans', 'pot', 'pots',
    'large', 'small', 'medium', 'big', 'little', 'extra', 'side', 'sides', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'dozen', 'couple', 'few', 'several', 'handful', 'some', 'each', 'per', 'also', 'plus', 'then', 'today', 'breakfast', 'lunch',
    'dinner', 'snack', 'meal', 'about', 'around', 'approx', 'approximately', 'roughly'];
  var NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, couple: 2 };
  function nstem(w) { // plural -> singular, deterministic: patties -> patty, eggs -> egg, tomatoes -> tomato
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (w.length > 4 && /(oes|ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
    var r = stem(w);
    // Claude QA of P1.4-RC2: one spelling for yogurt, so "Greek yoghurt" in the note matches a "Greek yogurt" item
    return /^yogh(?:o)?urt$/.test(r) ? 'yogurt' : r;
  }
  function foodKeys(text) {
    return words(String(text).replace(/\d+(?:[.,]\d+)?\s*(%|percent\b|pct\b|g\b|kg\b|ml\b|oz\b)?/gi, ' ')).map(nstem).filter(function (w) {
      return w.length >= 3 && !/^\d/.test(w) && STOP.indexOf(w) === -1 && NOTE_UNITS.indexOf(w) === -1 && ['cooked', 'the', 'with', 'and'].indexOf(w) === -1;
    });
  }
  // Foods named in the note: one entry per clause (split at , ; . newline "and" "with" "plus" "&"), in typed order.
  function describedFoods(note) {
    var out = [], seen = {};
    String(note || '').slice(0, 1000).split(/[,;\n]+|\.(?!\d)|\s+(?:and|with|plus|but|&)\s+|\s+w\/\s*|\s*\+\s*/i).forEach(function (raw) {
      var text = raw.trim().replace(/\s+/g, ' ');
      if (!text) return;
      var keys = foodKeys(text);
      if (!keys.length) return; // "ate half", "100%" or a bare number names no food
      var key = keys.join(' ');
      if (seen[key]) return; seen[key] = true;
      var low = text.toLowerCase(), m = /(?:^|\s)(\d{1,3}(?:\.\d+)?)(?!\s*(?:%|percent|pct))\b/.exec(low), qty = null;
      if (m) qty = Number(m[1]);
      else { var w = words(low).filter(function (x) { return hasOwn(NUM_WORDS, x); })[0]; if (w) qty = NUM_WORDS[w]; }
      out.push({ text: text.slice(0, 120), keys: keys, head: keys[keys.length - 1], qty: qty });
    });
    return out.slice(0, 20);
  }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function headOf(c) { var k = foodKeys(String(c && c.name || '').replace(/\([^)]*\)/g, ' ')); return k.length ? k[k.length - 1] : null; }
  function compKeys(c) { return foodKeys(String(c && c.name || '') + ' ' + String(c && c.preparation || '')); }
  function matches(food, ck) {
    if (ck.indexOf(food.head) !== -1) return true;
    // Claude QA of P1.4-RC2: without the food's own noun, HALF the words was enough ("chicken salad" was taken as covered by
    // a "Chicken soup" item, "2 pork patties" by "Pork chop"), so a named food could be lost with no warning. Now more than
    // half of its words must be present. A wrong "not accounted for" costs one tap; a wrong "accounted for" loses the food.
    var hit = food.keys.filter(function (k) { return ck.indexOf(k) !== -1; }).length;
    return hit * 2 > food.keys.length;
  }
  // acks: [{ kind: 'FOOD'|'TWICE', key }] the owner has acknowledged (kept on the draft's ai record).
  function reconcileNote(note, components, acks) {
    var comps = Array.isArray(components) ? components : [];
    var ack = Array.isArray(acks) ? acks : [];
    var acked = function (kind, key) { return ack.some(function (a) { return a && a.kind === kind && a.key === key; }); };
    var ckeys = comps.map(function (c) { return String(c && c.name || '').trim() ? compKeys(c) : []; });
    var foods = describedFoods(note).map(function (f) {
      var idx = [];
      ckeys.forEach(function (ck, i) { if (ck.length && matches(f, ck)) idx.push(i); });
      return { text: f.text, key: f.keys.join(' '), head: f.head, qty: f.qty, matched: idx };
    });
    var unaccounted = foods.filter(function (f) { return !f.matched.length && !acked('FOOD', f.key); });
    // the same food listed twice: two items that both match one named food and share its head noun
    var twice = [];
    foods.forEach(function (f) {
      // each item's own head noun (its last food word) must be the named food's head: "chicken pieces (butter chicken)"
      // and "butter chicken sauce" are the P10 non-overlapping split, not a double count
      var same = f.matched.filter(function (i) { var hd = headOf(comps[i]); return hd === f.head; });
      if (same.length > 1 && !acked('TWICE', f.key)) twice.push({ text: f.text, key: f.key, indexes: same });
    });
    var described = {};
    foods.forEach(function (f) { f.matched.forEach(function (i) { described[i] = true; }); });
    // where each item came from, for the review: the model's basis when it gave one, else what the note says
    var origin = comps.map(function (c, i) {
      if (c && c.basis === 'USER') return 'USER';
      if (c && BASES.indexOf(c.basis) !== -1) return c.basis === 'PHOTO' && described[i] ? 'BOTH' : c.basis;
      return described[i] ? 'BOTH' : 'PHOTO';
    });
    return { foods: foods, unaccounted: unaccounted, twice: twice, origin: origin, open: unaccounted.length + twice.length };
  }
  var ORIGIN_TEXT = { PHOTO: 'from photo', NOTE: 'from your note (not in the photo)', BOTH: 'photo + your note', USER: 'added by you' };

  // ================= P10: Quick "Log steps" (Today / Yesterday / Choose date) =================
  // Builds the record to save for a whole-day step total WITHOUT touching anything else in that day's check-in:
  // same record identity ('daily-' + date, or the existing record's own id), every other field copied unchanged.
  // The caller saves it through the normal validated store path (future dates, ranges and damage rules apply there too).
  function addDaysIso(iso, n) { var d = new Date(String(iso) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function quickStepsUpdate(existing, date, raw, todayIso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || addDaysIso(date, 0) !== date) return { ok: false, error: 'Choose a valid date.' };
    if (date > todayIso) return { ok: false, error: 'Steps cannot be logged for a future date (Asia/Qatar calendar).' };
    var t = String(raw == null ? '' : raw).trim().replace(/[,\s\u00A0\u202F]/g, '');
    if (t === '') return { ok: false, error: 'Enter the day\'s total steps. Blank stays missing (not zero).' };
    if (!/^\d{1,6}$/.test(t)) return { ok: false, error: 'Steps must be a whole number from 0 to 200,000.' };
    var v = Number(t);
    if (v > 200000) return { ok: false, error: 'Steps must be a whole number from 0 to 200,000.' };
    var prev = existing && existing.steps && existing.steps.state === 'OBSERVED' && typeof existing.steps.value === 'number' ? existing.steps.value : null;
    var rec = existing ? JSON.parse(JSON.stringify(existing)) : { id: 'daily-' + date, date: date };
    rec.steps = { state: 'OBSERVED', value: v };
    return { ok: true, rec: rec, previous: prev, changed: prev !== v };
  }

  return { describedFoods: describedFoods, reconcileNote: reconcileNote, ORIGIN_TEXT: ORIGIN_TEXT, BASES: BASES,
    noteFractions: noteFractions, analysisNote: analysisNote, overlapWarnings: overlapWarnings, quickStepsUpdate: quickStepsUpdate, addDaysIso: addDaysIso,
    LIMITS: LIMITS, ACCEPT: ACCEPT, LABELS: LABELS, LABEL_NAMES: LABEL_NAMES, requestKey: requestKey, safeDiag: safeDiag, CATEGORY_ACTION: CATEGORY_ACTION, validateFile: validateFile, stripJpegMetadata: stripJpegMetadata, hasMetadata: hasMetadata,
    sanitizeInBrowser: sanitizeInBrowser, validateResult: validateResult, resultToComponents: resultToComponents,
    providers: { unconfigured: unconfigured, mock: mock, http: http }, createSession: createSession, toBase64: toBase64,
    MOCK_FIXTURES: MOCK_FIXTURES, friendlyMessage: friendlyMessage };
});
