#!/usr/bin/env node
// Assembles the P1.4-RC3 (P1.4-RC2 + Claude independent QA fixes, 23 Nov 2026; RC2 = P1.4-RC1 + Sprint B2 meal-draft recovery) deploy package (unchanged layout since Phase 9): publish/ (the 20 static app files from DEPLOY-FILES.txt) + netlify/functions + netlify/lib
// + netlify.toml + package.json (+ lockfile if present) + tools/make-owner-code.mjs.  Usage: node tools/build-deploy-package.mjs <outDir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'build', 'hyrox-p1-4-rc3-deploy'));
const APP_FILES = fs.readFileSync(path.join(root, 'DEPLOY-FILES.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^(index\.html|src\/.+)$/.test(l));
if (APP_FILES.length !== 20) throw new Error('expected 20 app files (R8 adds src/integrations/garmin-import.js; P1.3 added src/data/hyrox-coach.js; Sprint D P1.4 adds src/data/hyrox-coach-export.js), found ' + APP_FILES.length);
fs.rmSync(out, { recursive: true, force: true });
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true }); fs.copyFileSync(path.join(root, from), path.join(out, to)); };
for (const f of APP_FILES) copy(f, path.join('publish', f));
// P0 build label: the source id is the first 12 hex digits of the SHA-256 over the app files exactly as they are in the
// source tree (path + NUL + bytes, in DEPLOY-FILES.txt order). Only the packaged index.html carries it; the source keeps "dev".
function sourceId(rootDir, files) {
  const hsh = crypto.createHash('sha256');
  for (const f of files) { hsh.update(f); hsh.update('\0'); hsh.update(fs.readFileSync(path.join(rootDir, f))); hsh.update('\0'); }
  return hsh.digest('hex').slice(0, 12);
}
{
  const id = sourceId(root, APP_FILES);
  const idx = path.join(out, 'publish', 'index.html');
  const html = fs.readFileSync(idx, 'utf8');
  const tag = '<meta name="hyrox-build-id" content="dev">';
  if (html.split(tag).length !== 2) throw new Error('index.html must contain exactly one unstamped hyrox-build-id tag');
  fs.writeFileSync(idx, html.replace(tag, '<meta name="hyrox-build-id" content="' + id + '">'));
  console.log('source id ' + id);
}
// pending CC confirmation (Claude decision 2, t111u): leave the Garmin proxy
// endpoint (and its lib stubs) OUT of the deploy package until S7/S9. Stubs
// stay in the source tree for offline tests. S6 auth-lockout-shared.mjs still ships.
for (const f of fs.readdirSync(path.join(root, 'netlify/functions')).sort()) {
  if (!/\.(mjs|js|cjs)$/.test(f)) continue;
  if (/garmin-personal-proxy/.test(f)) continue;
  copy('netlify/functions/' + f, 'netlify/functions/' + f);
}
for (const f of fs.readdirSync(path.join(root, 'netlify/lib')).sort()) {
  if (/garmin-personal-proxy/.test(f)) continue;
  copy('netlify/lib/' + f, 'netlify/lib/' + f);
}
copy('deploy/netlify.toml', 'netlify.toml');
copy('deploy/package.json', 'package.json');
if (fs.existsSync(path.join(root, 'deploy/package-lock.json'))) copy('deploy/package-lock.json', 'package-lock.json');
copy('tools/make-owner-code.mjs', 'tools/make-owner-code.mjs');
copy('deploy/README-DEPLOY.txt', 'README-DEPLOY.txt');
console.log('built ' + out + ' (' + APP_FILES.length + ' static files)');
