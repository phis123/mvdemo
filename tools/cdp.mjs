// cdp.mjs — just enough Chrome DevTools Protocol to drive a local browser.
// No puppeteer/playwright: Node 24 already ships fetch and WebSocket.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const WIN = process.platform === 'win32';

const CANDIDATES = [
  process.env.MV_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export function findBrowser() {
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
  throw new Error('no Chrome/Edge found — set MV_BROWSER to the executable path');
}

async function freePort() {
  const net = await import('node:net');
  return await new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

/** A page target with a flat CDP session. */
export class Page {
  constructor(ws, sessionId) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      // Surface page-side failures: without this a broken module just looks like a hang.
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        this.logs.push(`[${msg.params.type}] ${text}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        this.logs.push(`[exception] ${d.exception?.description || d.text}`);
      } else if (msg.method === 'Log.entryAdded') {
        this.logs.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`);
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }

  send(method, params = {}, timeoutMs = 120000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async eval(expression, { awaitPromise = false } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page error: ${d.exception?.description || d.text}`);
    }
    return r.result?.value;
  }

  async waitFor(expression, { timeoutMs = 30000, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (await this.eval(expression)) return true;
      } catch { /* page may still be parsing */ }
      if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
      await new Promise((r) => setTimeout(r, 60));
    }
  }
}

/** Launch a browser and open one blank page target. Readiness is the caller's job. */
export async function launch({ width, height, browser, extraArgs = [] }) {
  const exe = browser || findBrowser();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mvdemo-'));

  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--hide-scrollbars',
    '--mute-audio',
    // Deterministic text and colour: no subpixel AA, no colour profile guessing.
    '--disable-lcd-text',
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    `--window-size=${width},${height}`,
    ...extraArgs,
    'about:blank',
  ];

  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch {
      await new Promise((rr) => setTimeout(rr, 100));
    }
  }
  if (!wsUrl) {
    proc.kill();
    throw new Error('browser did not expose a debugging endpoint');
  }

  const ws = new WebSocket(wsUrl);
  await once(ws, 'open');

  // browser-level session
  const bsend = (() => {
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
    return (method, params = {}) =>
      new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
  })();

  // NB: width/height are NOT valid here — the viewport comes from
  // --window-size at launch and Emulation.setDeviceMetricsOverride below.
  const { targetId } = await bsend('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await bsend('Target.attachToTarget', { targetId, flatten: true });

  const page = new Page(ws, sessionId);
  page.targetId = targetId;
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable').catch(() => {});
  await page.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });

  return {
    page,
    ws,
    proc,
    profile,
    async close() {
      try { ws.close(); } catch {}
      try { proc.kill(); } catch {}
      await new Promise((r) => setTimeout(r, 250));
      if (WIN) {
        // A headless Chromium can leave children behind; kill the tree.
        try {
          const { spawnSync } = await import('node:child_process');
          spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {}
      }
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
}

/** Serve a directory over http://127.0.0.1:<port>. Avoids file:// read restrictions. */
export async function serve(root, { port = 0 } = {}) {
  const http = await import('node:http');
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.md': 'text/markdown; charset=utf-8',
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (req.method === 'HEAD') { res.writeHead(200).end(); return; }
    try {
      const data = await fs.promises.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': data.length,
      });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const actual = server.address().port;
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    close: () => new Promise((r) => server.close(r)),
  };
}
