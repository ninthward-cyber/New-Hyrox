#!/usr/bin/env node
// Generates the single-owner access code and the hash the server stores.
//   node tools/make-owner-code.mjs            -> prints a new code (type it once into the app) and its hash (goes into Netlify)
//   node tools/make-owner-code.mjs --hash     -> reads a code from stdin and prints only its hash (to re-derive or verify)
// The code is 256 bits of randomness. The server keeps only SHA-256(code). Nothing is sent anywhere by this script.
import { randomBytes, createHash } from 'node:crypto';

const hashOf = (code) => createHash('sha256').update(code).digest('hex');

if (process.argv.includes('--hash')) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { data += d; });
  process.stdin.on('end', () => { const code = data.trim(); if (!code) { console.error('No code on stdin.'); process.exit(1); } console.log(hashOf(code)); });
} else {
  const code = 'hx1-' + randomBytes(32).toString('base64url');
  console.log('');
  console.log('OWNER ACCESS CODE (secret; type it once into the app on your iPhone; keep it in a password manager; never paste it in chat):');
  console.log('  ' + code);
  console.log('');
  console.log('HYROX_OWNER_CODE_HASH (this is what goes into the Netlify environment variable; it cannot be turned back into the code):');
  console.log('  ' + hashOf(code));
  console.log('');
}
