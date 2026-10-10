// shot.mjs — render stills and sequences out of the piece, with no ffmpeg.
//
//   node tools/shot.mjs --sheet --times 0.2,0.75,1.1,...   contact sheet (PNG)
//   node tools/shot.mjs --seq --out out/frames             full PNG sequence
//   node tools/shot.mjs --verify --repeat 2                determinism report
//   node tools/shot.mjs --video --out out/demo.mp4         only if ffmpeg exists
//
// Everything is read back from the page as raw RGBA; PNGs are encoded here with
// tools/png.mjs (zlib only). The browser is a rasteriser, nothing more.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, serve, findBrowser } from './cdp.mjs';
import { encodePng, grid } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ------------------------------------------------------------------ args */
function args(argv) {
  const o = { mode: null, times: [], out: null, cols: 2, cell: null, repeat: 2, fps: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--sheet') o.mode = 'sheet';
    else if (a === '--seq') o.mode = 'seq';
    else if (a === '--verify') o.mode = 'verify';
    else if (a === '--video') o.mode = 'video';
    else if (a === '--times') o.times = next().split(',').map(Number);
    else if (a === '--out') o.out = next();
    else if (a === '--cols') o.cols = Number(next());
    else if (a === '--cell') o.cell = next().split('x').map(Number);
    else if (a === '--repeat') o.repeat = Number(next());
    else if (a === '--fps') o.fps = Number(next());
    else if (a === '--from') o.from = Number(next());
    else if (a === '--to') o.to = Number(next());
    else if (a === '--step') o.step = Number(next());
    else if (a === '--dir') o.dir = next();
    else if (a === '--ffmpeg') o.ffmpeg = next();
    else if (a === '--crf') o.crf = Number(next());
    else if (a === '--preset') o.preset = next();
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

/* ------------------------------------------------------- bitmap captions */
// A 3x5 font so the contact sheet can be labelled without any font dependency
// on the Node side. The frame itself always uses real browser text.
const F = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
  's': ['000', '111', '100', '011', '111'], '.': ['000', '000', '000', '000', '010'],
  ':': ['000', '010', '000', '010', '000'], '-': ['000', '000', '111', '000', '000'],
  'f': ['111', '100', '110', '100', '100'], 'x': ['000', '101', '010', '101', '000'],
  ' ': ['000', '000', '000', '000', '000'],
};

function text(buf, W, H, str, x0, y0, scale, color = [242, 236, 226]) {
  let x = x0;
  for (const ch of str) {
    const g = F[ch] || F[' '];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (g[r][c] !== '1') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = x + c * scale + dx;
            const py = y0 + r * scale + dy;
            if (px < 0 || py < 0 || px >= W || py >= H) continue;
            const i = (py * W + px) * 4;
            buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]; buf[i + 3] = 255;
          }
        }
      }
    }
    x += 4 * scale;
  }
  return x;
}

const rgbaBlob = (b64) => Buffer.from(b64, 'base64');

/* --------------------------------------------------------------- runtime */
async function withPage({ width, height }, fn) {
  const server = await serve(ROOT);
  const browser = await launch({ width, height });
  try {
    await browser.page.send('Page.navigate', {
      url: `${server.url}/index.html?mode=export&w=${width}&h=${height}`,
    });
    try {
      await browser.page.waitFor('window.__mv && window.__mv.ready', { label: 'export ready', timeoutMs: 60000 });
    } catch (e) {
      const diag = await browser.page.eval(`JSON.stringify({
        readyState: document.readyState,
        url: location.href,
        hasMv: typeof window.__mv,
        hasPreview: typeof window.__preview,
        scripts: [...document.scripts].map(s => s.src || '(inline)'),
        bodyStart: document.body ? document.body.innerHTML.slice(0, 200) : null
      })`).catch((err) => `eval failed: ${err.message}`);
      console.error('diagnostics: ' + diag);
      console.error('page logs: ' + (browser.page.logs.join(' || ') || '(none)'));
      throw new Error(`export page never became ready | ${diag} | logs: ${browser.page.logs.join(' || ') || '(none)'}`);
    }
    const fonts = await browser.page.eval('JSON.stringify(window.__mv.fonts)');
    return await fn(browser.page, JSON.parse(fonts), server);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function grab(page) {
  const r = await page.eval('JSON.stringify(window.__mv.grab())');
  return JSON.parse(r);
}

/* ----------------------------------------------------------------- modes */
async function sheet(o) {
  const fps = o.fps || 60;
  // Default: a dense contact sheet. Cell count comes from the frame count.
  const times = o.times.length
    ? o.times
    : Array.from({ length: 16 }, (_, i) => (i * 5) / 15);
  const cols = o.cols;
  const rows = Math.ceil(times.length / cols);
  const [tw, th] = o.cell || [640, 360];

  const out = o.out || path.join(ROOT, 'out', 'sheet.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });

  await withPage({ width: tw, height: th }, async (page) => {
    const tiles = [];
    const meta = [];
    for (const t of times) {
      const g = await grab(await setTime(page, t));
      const buf = rgbaBlob(g.b64);
      tiles.push(buf);
      meta.push({ t, frame: Math.round(t * fps), meta: g.meta });
    }
    const { buf, W, H } = grid(tiles, cols, rows, tw, th);
    // caption each tile in the corner
    times.forEach((t, i) => {
      const cx = (i % cols) * tw;
      const cy = Math.floor(i / cols) * th;
      text(buf, W, H, `t${t.toFixed(2)}s`, cx + 12, cy + 12, 2, [255, 190, 150]);
      text(buf, W, H, `f${Math.round(t * fps)}`, cx + 12, cy + 32, 2, [150, 146, 160]);
    });
    fs.writeFileSync(out, encodePng(buf, W, H));
    fs.writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify(meta, null, 2));
    console.log(`sheet  ${W}x${H}  ${times.length} frames -> ${out}`);
    console.log(`   times  ${times.map((t) => t.toFixed(2)).join(', ')}`);
  });
}

async function setTime(page, t) {
  await page.eval(`window.__mv.setTime(${t})`);
  return page;
}

async function seq(o) {
  const fps = o.fps || 60;
  const from = o.from ?? 0;
  const to = o.to ?? 5;
  const step = o.step ?? 1 / fps;
  const dir = o.out || path.join(ROOT, 'out', 'frames');
  fs.mkdirSync(dir, { recursive: true });

  const times = [];
  for (let t = from; t < to - 1e-9; t += step) times.push(Number(t.toFixed(6)));

  await withPage({ width: 1920, height: 1080 }, async (page) => {
    const manifest = [];
    let i = 0;
    for (const t of times) {
      const g = await grab(await setTime(page, t));
      const buf = rgbaBlob(g.b64);
      const name = `f${String(i).padStart(5, '0')}.png`;
      fs.writeFileSync(path.join(dir, name), encodePng(buf, g.w, g.h));
      manifest.push({
        i, t, file: name,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        meta: g.meta,
      });
      i++;
      if (i % 30 === 0) process.stdout.write(`\r  ${i}/${times.length} frames`);
    }
    process.stdout.write(`\r  ${times.length}/${times.length} frames\n`);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      fps, from, to, step, width: 1920, height: 1080, count: times.length, frames: manifest,
    }, null, 2));
    console.log(`seq    ${times.length} PNGs @1920x1080 -> ${dir}`);
  });
}

async function verify(o) {
  const times = o.times.length ? o.times : [0.5, 1.2, 2.0, 3.0, 4.0, 4.9];
  const out = o.out || path.join(ROOT, 'out', 'verify.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const runs = [];
  for (let r = 0; r < o.repeat; r++) {
    runs.push(await withPage({ width: 960, height: 540 }, async (page) => {
      const rows = [];
      for (const t of times) {
        const g = await grab(await setTime(page, t));
        rows.push({
          t,
          sha256: crypto.createHash('sha256').update(rgbaBlob(g.b64)).digest('hex'),
          meta: g.meta,
        });
      }
      return rows;
    }));
  }

  const report = {
    times,
    runs: o.repeat,
    results: times.map((t, i) => {
      const hashes = runs.map((r) => r[i].sha256);
      const identical = hashes.every((h) => h === hashes[0]);
      return {
        t,
        identical,
        sha256: hashes[0],
        typed: runs[0][i].meta?.typed,
        zoom: Number(runs[0][i].meta?.zoom?.toFixed(4)),
        fonts: runs[0][i].meta?.fonts,
      };
    }),
  };
  report.allIdentical = report.results.every((r) => r.identical);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  const bitmaps = report.results.map((r) => (r.identical ? '=' : '!')).join('');
  console.log(`verify ${o.repeat} runs x ${times.length} times -> ${out}`);
  for (const r of report.results) {
    console.log(
      `  t=${r.t.toFixed(2)}  ${r.identical ? 'IDENTICAL' : 'DIFFERS  '}  ` +
      `zoom=${String(r.zoom).padEnd(6)}  typed="${r.typed ?? ''}"  [${(r.fonts || []).join(' ')}]`,
    );
  }
  console.log(`  per-time stability: ${bitmaps}`);
  console.log(`  deterministic: ${report.allIdentical ? 'YES' : 'NO'}`);
}

/* ------------------------------------------------------------------ video */
// ffmpeg is resolved in this order so the project works both with a bundled
// portable binary (tools/bin) and with a system install — and never silently
// picks a different one than you expect.
function resolveFfmpeg(explicit) {
  const candidates = [
    explicit,
    process.env.MV_FFMPEG,
    path.join(ROOT, 'tools', 'bin', 'ffmpeg.exe'),
    path.join(ROOT, 'tools', 'bin', 'ffmpeg'),
    'ffmpeg',
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['-hide_banner', '-version'], { stdio: 'ignore' });
    if (r.status === 0) return c;
  }
  throw new Error(
    'ffmpeg not found. Put ffmpeg.exe in tools/bin/, or set MV_FFMPEG, or install it\n' +
    'system-wide. Only --video needs it; --sheet and --seq do not.',
  );
}

async function video(o) {
  const dir = o.dir || path.join(ROOT, 'out', 'frames');
  const manPath = path.join(dir, 'manifest.json');
  const ffmpeg = resolveFfmpeg(o.ffmpeg);

  // A rendered sequence dictates fps and length; without one we trust the flags.
  let fps = o.fps || 60;
  let secs = null;
  if (fs.existsSync(manPath)) {
    const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    fps = man.fps;
    secs = man.count / man.fps;
    console.log(`input  ${man.count} frames from ${dir} (${fps} fps, ${secs.toFixed(3)} s)`);
  } else {
    console.log(`input  ${dir} (no manifest.json — assuming --fps ${fps})`);
  }

  const out = o.out || path.join(ROOT, 'out', 'demo_1080p60.mp4');
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const cmd = [
    '-y', '-hide_banner',
    '-framerate', String(fps),
    '-i', path.join(dir, 'f%05d.png'),
    '-c:v', 'libx264',
    '-crf', String(o.crf ?? 16),
    '-preset', o.preset ?? 'slow',
    '-pix_fmt', 'yuv420p',          // without this many players refuse the file
    '-movflags', '+faststart',
    out,
  ];
  console.log(`\n$ ${ffmpeg} ${cmd.join(' ')}\n`);
  const r = spawnSync(ffmpeg, cmd, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg exited with status ${r.status}`);

  console.log(`\nvideo  ${out}  (${(fs.statSync(out).size / 1e6).toFixed(2)} MB` +
    `${secs ? ` for ${secs.toFixed(2)} s` : ''})`);

  // Read the file back instead of trusting the encoder's log. ffprobe ships
  // next to ffmpeg in the same build.
  const probe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));
  const p = spawnSync(probe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_frames,pix_fmt',
    '-show_entries', 'format=duration,size,bit_rate',
    '-of', 'json', out,
  ], { encoding: 'utf8' });
  if (p.status === 0) {
    const j = JSON.parse(p.stdout);
    const s = j.streams?.[0] || {};
    const f = j.format || {};
    console.log(`  codec    ${s.codec_name}  ${s.width}x${s.height}  ${s.r_frame_rate}  ${s.pix_fmt}`);
    console.log(`  frames   ${s.nb_frames}`);
    console.log(`  duration ${Number(f.duration).toFixed(3)} s   bitrate ${(Number(f.bit_rate) / 1e6).toFixed(2)} Mbps`);
  } else {
    console.log('  (ffprobe unavailable; skipped the read-back check)');
  }
}

/* ------------------------------------------------------------------- main */
const o = args(process.argv.slice(2));
if (!o.mode) {
  console.log(`usage: node tools/shot.mjs <--sheet|--seq|--verify|--video> [options]
  --times a,b,c     explicit times (sheet/verify)
  --from --to --step   sequence range
  --cols N --cell WxH  contact sheet layout
  --out PATH        output file or directory
  --repeat N        runs for --verify
  --fps N           override fps for labels/step
  --dir PATH        sequence directory (--video input)
  --ffmpeg PATH     explicit ffmpeg binary
  --crf N           x264 quality, lower is better (default 16)
  --preset NAME     x264 preset (default slow)`);
  process.exit(0);
}

try {
  if (o.mode === 'sheet') await sheet(o);
  else if (o.mode === 'seq') await seq(o);
  else if (o.mode === 'verify') await verify(o);
  else if (o.mode === 'video') await video(o);
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
  process.exit(1);
}
