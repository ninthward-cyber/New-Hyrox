// Image gate: strict base64, JPEG-only allowlist, full marker-level structure walk, metadata strip.
// Pure JS, no dependencies. NOT a pixel re-encode: the browser already re-encodes through a canvas before sending
// (src/ai/photo-ai.js), and this gate refuses anything that is not a structurally complete baseline/progressive JPEG.
import { createHash } from 'node:crypto';

const err = (code, message) => ({ ok: false, code, message });
const SOF = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]);
export const MIME_ALLOWLIST = ['image/jpeg'];
export const LIMITS = Object.freeze({ minSide: 8, maxSide: 4096, maxPixels: 12_000_000 });

export function sniff(b) {
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 6 && b.toString('latin1', 0, 3) === 'GIF') return 'gif';
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') return 'heif';
  if (b.length >= 4 && b.toString('latin1', 0, 4) === '%PDF') return 'pdf';
  return 'unknown';
}

// Walks every segment (including entropy-coded scan data) and rebuilds the file without APP1-15 and COM.
function walkJpeg(b) {
  const out = [b.subarray(0, 2)];
  let i = 2, w = 0, h = 0, comps = 0, sawSof = false, sawSos = false, eoi = false;
  const len = b.length;
  while (i < len) {
    if (b[i] !== 0xFF) throw new Error('marker expected');
    while (i < len && b[i] === 0xFF) i++; // fill bytes
    if (i >= len) throw new Error('truncated');
    const m = b[i++];
    if (m === 0xD9) { out.push(Buffer.from([0xFF, 0xD9])); eoi = true; break; }
    if (m === 0x00 || m === 0x01 || (m >= 0xD0 && m <= 0xD7) || m === 0xD8) { if (m === 0xD8) throw new Error('nested SOI'); out.push(Buffer.from([0xFF, m])); continue; }
    if (i + 2 > len) throw new Error('truncated');
    const segLen = (b[i] << 8) | b[i + 1];
    if (segLen < 2 || i + segLen > len) throw new Error('bad segment length');
    const body = b.subarray(i + 2, i + segLen);
    if (SOF.has(m)) {
      if (sawSof) throw new Error('second SOF');
      if (body.length < 6) throw new Error('short SOF');
      if (body[0] !== 8) throw new Error('precision');
      h = (body[1] << 8) | body[2]; w = (body[3] << 8) | body[4]; comps = body[5];
      if (!(comps === 1 || comps === 3) || body.length < 6 + comps * 3) throw new Error('components');
      sawSof = true;
    }
    const drop = (m >= 0xE1 && m <= 0xEF) || m === 0xFE;
    if (!drop) out.push(Buffer.concat([Buffer.from([0xFF, m]), b.subarray(i, i + segLen)]));
    i += segLen;
    if (m === 0xDA) {
      if (!sawSof) throw new Error('SOS before SOF');
      sawSos = true;
      // entropy-coded data: copy until the next real marker
      const start = i;
      while (i < len) {
        if (b[i] === 0xFF) {
          const n = b[i + 1];
          if (n === undefined) throw new Error('truncated scan');
          if (n === 0x00 || (n >= 0xD0 && n <= 0xD7) || n === 0xFF) { i += (n === 0xFF ? 1 : 2); continue; }
          break;
        }
        i++;
      }
      if (i >= len) throw new Error('scan not terminated');
      out.push(b.subarray(start, i));
    }
  }
  if (!eoi) throw new Error('no EOI');
  if (!sawSof || !sawSos) throw new Error('no frame or scan');
  return { bytes: Buffer.concat(out), width: w, height: h };
}

export function checkImage({ imageBase64, mimeType }, maxImageBytes) {
  if (typeof imageBase64 !== 'string' || !imageBase64.length) return err('BAD_REQUEST', 'No image was sent.');
  if (typeof mimeType !== 'string' || !MIME_ALLOWLIST.includes(mimeType.toLowerCase())) return err('UNSUPPORTED_TYPE', 'Only JPEG photos are accepted (the app converts photos before sending).');
  if (imageBase64.length > Math.ceil(maxImageBytes / 3) * 4 + 8) return err('TOO_LARGE', 'The prepared photo is too large.');
  if (imageBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) return err('BAD_REQUEST', 'The image data is not valid base64.');
  const raw = Buffer.from(imageBase64, 'base64');
  if (raw.length > maxImageBytes) return err('TOO_LARGE', 'The prepared photo is too large.');
  if (sniff(raw) !== 'jpeg') return err('UNSUPPORTED_TYPE', 'The file is not a JPEG image.');
  let r;
  try { r = walkJpeg(raw); } catch (e) { return err('CORRUPT_IMAGE', 'The image could not be read (damaged or incomplete).'); }
  if (r.width < LIMITS.minSide || r.height < LIMITS.minSide || r.width > LIMITS.maxSide || r.height > LIMITS.maxSide || r.width * r.height > LIMITS.maxPixels) {
    return err('CORRUPT_IMAGE', 'The image dimensions are outside the allowed range.');
  }
  return { ok: true, bytes: r.bytes, width: r.width, height: r.height, sha256: createHash('sha256').update(r.bytes).digest('hex') };
}

// ---- P10: one meal, 1-3 photos ----
// Accepts EITHER the single-photo shape { imageBase64, mimeType } (unchanged; every P9 client keeps working) OR
// { images: [{ imageBase64, mimeType, label }] } with 1-3 entries. Every photo passes the same gate as a single photo
// (JPEG only, full structure walk, APP1-15/COM stripped). Labels come from a fixed list; free text is never accepted.
// Returns { ok, multi, images: [{ bytes, width, height, sha256, label }] } or an error.
export function checkImages(j, cfg, labels) {
  const hasSingle = j.imageBase64 !== undefined || j.mimeType !== undefined;
  if (j.images === undefined) {
    const one = checkImage(j, cfg.maxImageBytes);
    if (!one.ok) return one;
    // Claude P10 review (owner decision 17 Nov 2026): a single photo has the same 1600 px cap as each photo in a set.
    if (one.width > cfg.multiMaxSide || one.height > cfg.multiMaxSide) return err('TOO_LARGE', 'This photo is larger than ' + cfg.multiMaxSide + ' pixels. Nothing was sent.');
    return { ok: true, multi: false, images: [{ ...one, label: 'SAME_PLATE' }] };
  }
  if (hasSingle) return err('BAD_REQUEST', 'Send either one photo or a list of photos, not both.');
  if (!Array.isArray(j.images) || j.images.length < 1) return err('BAD_REQUEST', 'No image was sent.');
  if (j.images.length > cfg.maxImages) return err('TOO_MANY_IMAGES', 'At most ' + cfg.maxImages + ' photos per meal. Nothing was sent.');
  // cheap aggregate check on the encoded size before any decoding
  let encoded = 0;
  for (const im of j.images) {
    if (!im || typeof im !== 'object' || Array.isArray(im)) return err('BAD_REQUEST', 'Malformed photo entry.');
    for (const k of Object.keys(im)) if (!['imageBase64', 'mimeType', 'label'].includes(k)) return err('BAD_REQUEST', 'Malformed photo entry.');
    if (im.label !== undefined && !labels.includes(im.label)) return err('BAD_REQUEST', 'Unknown photo label.');
    encoded += typeof im.imageBase64 === 'string' ? im.imageBase64.length : 0;
  }
  if (encoded > Math.ceil(cfg.maxMultiTotalBytes / 3) * 4 + 8 * j.images.length) return err('TOO_LARGE', 'These photos are too large together. Remove one or retake them. Nothing was sent.');
  const out = []; let total = 0;
  for (let i = 0; i < j.images.length; i++) {
    const im = j.images[i];
    const r = checkImage(im, cfg.maxMultiImageBytes);
    if (!r.ok) return { ...r, message: 'Photo ' + (i + 1) + ': ' + r.message };
    if (r.width > cfg.multiMaxSide || r.height > cfg.multiMaxSide) return err('TOO_LARGE', 'Photo ' + (i + 1) + ' is larger than ' + cfg.multiMaxSide + ' pixels. Nothing was sent.');
    total += r.bytes.length;
    if (out.some((o) => o.sha256 === r.sha256)) return err('DUPLICATE_IMAGE', 'The same photo was added twice. Remove the copy. Nothing was sent.');
    out.push({ ...r, label: im.label || 'SAME_PLATE' });
  }
  if (total > cfg.maxMultiTotalBytes) return err('TOO_LARGE', 'These photos are too large together. Remove one or retake them. Nothing was sent.');
  return { ok: true, multi: true, images: out };
}

// Idempotency identity of a request: the ORDERED list of sanitized photos (with their labels) plus the note.
// Same photos in another order, another label or another note is a different request.
export function requestSetHash(images, note) {
  return createHash('sha256').update(JSON.stringify({ v: 2, note: String(note || ''), images: images.map((im) => [im.label, im.sha256]) })).digest('hex');
}
