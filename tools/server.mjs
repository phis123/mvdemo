// server.mjs — a small static server for the preview, no bundler needed.
//   node tools/server.mjs [--port 5173] [--open]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const portArg = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : Number(process.env.PORT || 5173);
const open = argv.includes('--open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

function start(port, tries = 20) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': data.length,
      });
      res.end(data);
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) {
      console.warn(`port ${port} busy, trying ${port + 1}`);
      start(port + 1, tries - 1);
    } else {
      console.error(e.message);
      process.exit(1);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}/`;
    console.log(`preview   ${url}`);
    console.log('          space pause · ←/→ 1s · ,/. frame · Home restart · ?t=3.2 to seek');
    if (open) {
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]];
      try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch {}
    }
  });
}

start(portArg);
