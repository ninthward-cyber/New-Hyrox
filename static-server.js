'use strict';

// Plain Node static server for P0 e2e. Binds 127.0.0.1 only. Never public.
// App root: HYROX_APP_ROOT (later: /workspace/hyrox-p2/build), default = repo root.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.env.HYROX_APP_ROOT || path.join(__dirname, '..'));
const HOST = '127.0.0.1';
const PORT = Number(process.env.HYROX_APP_PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function safeFile(urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(ROOT, rel));
  const root = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (file !== ROOT && !file.startsWith(root)) return null;
  return file;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch (e) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  const file = safeFile(pathname);
  if (!file) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write('hyrox-static http://' + HOST + ':' + PORT + ' root=' + ROOT + '\n');
});

server.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
