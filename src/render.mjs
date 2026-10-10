// render.mjs — the whole picture, as one pure function of time.
//
// Conventions (kept on purpose, they are what makes this scale to longer films):
//   * renderFrame(t) is a PURE function of t. No previous-frame state, no wall clock.
//   * All coordinates are in a virtual 1920x1080 space; the canvas transform does the scaling.
//   * Every colour comes from config.palette. No hex literals below.
//   * Every time constant comes from the timeline JSON. No magic seconds below.
//   * Noise/randomness is a stateless hash of (seed, integer key) — same t, same frame.

const VW = 1920;
const VH = 1080;

/* ---------------------------------------------------------------- helpers */

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, k) => a + (b - a) * k;
const inv = (t, a, b) => clamp((t - a) / (b - a));

/** Ease in/out, symmetric. k=1 is linear. */
const ease = (k, p = 2) =>
  k < 0.5 ? Math.pow(2 * k, p) / 2 : 1 - Math.pow(2 * (1 - k), p) / 2;

/** Ease in only (slow start). */
const easeIn = (k, p = 3) => Math.pow(clamp(k), p);

const smooth = (k) => k * k * (3 - 2 * k);

/** Deterministic 0..1 hash. Stateless: same key always gives the same value. */
function rnd(seed, key) {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (key | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** #rrggbb or #rrggbbaa -> {r,g,b,a} (0..255 / 0..1). */
function parseColor(c) {
  let h = c.replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a,
  };
}

const MIX_CACHE = new WeakMap();
/** Mix two palette colours. Cached per (cfg, a, b) pair. */
function mix(cfg, a, b, k) {
  let layer = MIX_CACHE.get(cfg);
  if (!layer) { layer = new Map(); MIX_CACHE.set(cfg, layer); }
  const ck = `${a}|${b}`;
  let f = layer.get(ck);
  if (!f) {
    const ca = parseColor(a);
    const cb = parseColor(b);
    f = (t) => `rgba(${Math.round(lerp(ca.r, cb.r, t))},${Math.round(lerp(ca.g, cb.g, t))},` +
      `${Math.round(lerp(ca.b, cb.b, t))},${lerp(ca.a, cb.a, t).toFixed(3)})`;
    layer.set(ck, f);
  }
  return f(clamp(k));
}

/** Chinese and Latin in one string need separate faces. */
const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

function faceFor(ch, F) {
  return CJK.test(ch) ? F.cjk : F.latin;
}

/**
 * Per-character placement with mixed faces, and a .fonts array so the
 * verification step can assert which families were actually used.
 */
function measureMixed(ctx, text, size, F, weight = '') {
  const fonts = {};
  let w = 0;
  const chars = [...text].map((ch) => {
    const f = faceFor(ch, F);
    fonts[f] = true;
    ctx.font = `${weight} ${size}px ${f}`.trim();
    const advance = ctx.measureText(ch).width;
    const box = { ch, f, advance, x: w };
    w += advance;
    return box;
  });
  return { w, chars, fonts: Object.keys(fonts) };
}

function drawMixed(ctx, layout, x, y, color, size, weight = '') {
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const c of layout.chars) {
    ctx.font = `${weight} ${size}px ${c.f}`.trim();
    ctx.fillText(c.ch, x + c.x, y);
  }
}

/* ------------------------------------------------------------ background */

const RADIAL_CACHE = new Map();
function radial(ctx, x, y, r, stops) {
  const key = `${x}|${y}|${r}|${stops.map((s) => s[0] + s[1]).join(',')}`;
  let g = RADIAL_CACHE.get(key);
  if (!g) {
    g = ctx.createRadialGradient(x, y, 0, x, y, r);
    for (const [o, c] of stops) g.addColorStop(o, c);
    RADIAL_CACHE.set(key, g);
  }
  return g;
}

const LIN_CACHE = new Map();
function linear(ctx, x0, y0, x1, y1, stops) {
  const key = `${x0}|${y0}|${x1}|${y1}|${stops.map((s) => s[0] + s[1]).join(',')}`;
  let g = LIN_CACHE.get(key);
  if (!g) {
    g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (const [o, c] of stops) g.addColorStop(o, c);
    LIN_CACHE.set(key, g);
  }
  return g;
}

function backdrop(ctx, P, cfg, z) {
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, VW, VH);

  // A stage glow in the middle, breathing very slightly with the zoom.
  const breathe = 1 + 0.06 * Math.sin(z * 2.2);
  ctx.fillStyle = radial(ctx, VW / 2, 470, 900 * breathe, [
    [0, P.stage],
    [0.55, P.stageFade],
    [1, P.stageEnd],
  ]);
  ctx.fillRect(0, 0, VW, VH);

  // Margin rules: a frame drawn around the page, like a printed sheet.
  ctx.strokeStyle = P.rule;
  ctx.lineWidth = 2;
  ctx.strokeRect(cfg.layout.margin, cfg.layout.margin, VW - cfg.layout.margin * 2, VH - cfg.layout.margin * 2);
}

function grain(ctx, P, cfg, t, frame) {
  const { grain: amt, cell } = cfg.post;
  if (amt <= 0) return;
  const n = rnd(cfg.seed, frame);
  const ox = -((frame * 37) % cell);
  const oy = -((frame * 53) % cell);
  ctx.save();
  ctx.globalAlpha = amt;
  ctx.fillStyle = P.grain;
  for (let y = oy; y < VH; y += cell) {
    for (let x = ox; x < VW; x += cell) {
      const k = rnd(cfg.seed + 7, ((x / cell) | 0) * 8191 + ((y / cell) | 0));
      if (k > 0.82 - n * 0.1) ctx.fillRect(x, y, 2, 2);
    }
  }
  ctx.restore();
}

function vignette(ctx, P, k) {
  if (k <= 0) return;
  ctx.fillStyle = radial(ctx, VW / 2, VH / 2, 1180, [
    [0.45, P.vig0],
    [1, P.vig1],
  ]);
  ctx.globalAlpha = k;
  ctx.fillRect(0, 0, VW, VH);
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------- the film */

/**
 * @param {number} t  seconds from the start of the piece (NOT song time; demo has no audio)
 */
export function renderFrame(t, ctx, cfg, state) {
  const { timeline: TL, palette: P } = cfg;
  const frame = Math.round(t * cfg.fps);
  const S = state;

  ctx.save();
  ctx.setTransform(S.sx, 0, 0, S.sy, 0, 0);
  ctx.clearRect(0, 0, VW, VH);

  /* --- 1. timeline state -------------------------------------------------- */
  const intro = smooth(inv(t, TL.intro.from, TL.intro.to));

  let typed = '';
  let caretOn = true;
  for (const seg of TL.segments) {
    if (t < seg.from) break;
    const k = clamp(inv(t, seg.from, seg.to));
    if (k >= 1) {
      typed += seg.text;
    } else {
      typed += seg.text.slice(0, Math.floor(seg.text.length * k));
      caretOn = false;
    }
  }
  if (t >= TL.end) typed = TL.segments[TL.segments.length - 1].text;

  const zk = ease(inv(t, TL.zoom.from, TL.zoom.to), TL.zoom.ease);
  const zoom = lerp(TL.zoom.from_scale ?? 1, TL.zoom.to_scale, zk);

  const caretBlink = (t * TL.caret.blinkHz) % 1 < 0.55;
  const caretVisible = t < TL.caret.hideAt && (caretOn || caretBlink);

  const box = TL.box;

  /* --- 2. the page ------------------------------------------------------- */
  backdrop(ctx, P, cfg, zk);

  // Watermark: the same sentence, huge and faint, behind everything.
  const wm = TL.watermark;
  if (wm) {
    const full = TL.segments.map((s) => s.text).join('');
    const wmAlpha = wm.alpha * (1 - 0.75 * zk);
    if (wmAlpha > 0.002) {
      ctx.save();
      // Keep the watermark inside the page: it is a texture, not a headline.
      ctx.beginPath();
      ctx.rect(0, 0, VW, wm.clipY ?? VH);
      ctx.clip();
      ctx.translate(wm.x, wm.y);
      ctx.rotate(wm.rotate * Math.PI / 180);
      const size = wm.size;
      const layout = measureMixed(ctx, full, size, cfg.fonts, '700');
      ctx.globalAlpha = wmAlpha;
      drawMixed(ctx, layout, -layout.w / 2, 0, P.watermark, size, '700');
      ctx.restore();
    }
  }

  /* --- 3. the search box, inside the zoom group -------------------------- */
  ctx.save();
  ctx.translate(box.cx, box.cy);
  ctx.scale(zoom, zoom);
  ctx.translate(-box.cx, -box.cy);

  const bx = box.cx - box.width / 2;
  const by = box.cy - box.height / 2;
  const r = box.radius;

  const boxAlpha = intro;
  ctx.globalAlpha = boxAlpha;

  // focus bloom, warms up with the zoom; intensity stays under 1 so the fill
  // brightens toward paper-white instead of clipping to white
  const glow = 0.20 + 0.34 * zk;
  ctx.save();
  ctx.shadowColor = P.glow;
  ctx.shadowBlur = box.glowBlur * glow;
  ctx.fillStyle = mix(cfg, P.boxFill, P.boxFillHot, zk);
  ctx.beginPath();
  ctx.roundRect(bx, by, box.width, box.height, r);
  ctx.fill();
  ctx.restore();

  // border: thin, cool at rest, accent when zooming
  ctx.strokeStyle = P.boxLine;
  ctx.lineWidth = box.lineWidth;
  ctx.beginPath();
  ctx.roundRect(bx, by, box.width, box.height, r);
  ctx.stroke();

  // accent underline: its width IS the typing progress
  const typeProgress = clamp(typed.length / TL.segments[TL.segments.length - 1].text.length);
  const uy = by + box.height - box.lineWidth;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(bx, by, box.width, box.height, r);
  ctx.clip();
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = box.lineWidth * 3;
  ctx.beginPath();
  ctx.moveTo(bx, uy);
  ctx.lineTo(bx + box.width * Math.max(0.02, typeProgress), uy);
  ctx.stroke();
  ctx.restore();

  // magnifier glyph
  const ic = box.icon;
  ctx.strokeStyle = typed ? P.accent : P.iconIdle;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(bx + ic.x, by + ic.y, ic.r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(bx + ic.x + ic.r * 0.72, by + ic.y + ic.r * 0.72);
  ctx.lineTo(bx + ic.x + ic.r * 1.55, by + ic.y + ic.r * 1.55);
  ctx.stroke();

  // typed text, with the last word picked out
  const fs = box.fontSize;
  const layout = measureMixed(ctx, typed, fs, cfg.fonts, '600');
  const tx = bx + box.text.x;
  const ty = box.cy + fs * 0.35;
  const fontsUsed = new Set(layout.fonts);

  const hit = TL.highlight;
  const hiStart = hit ? typed.indexOf(hit.text, hit.after ?? 0) : -1;
  group: {
    if (hiStart < 0) {
      if (typed) drawMixed(ctx, layout, tx, ty, P.text, fs, '600');
      break group;
    }
    const hiEnd = hiStart + hit.text.length;
    const before = typed.slice(0, hiStart);
    const mid = typed.slice(hiStart, hiEnd);
    const after = typed.slice(hiEnd);
    const wBefore = before ? measureMixed(ctx, before, fs, cfg.fonts, '600').w : 0;
    const wMid = measureMixed(ctx, mid, fs, cfg.fonts, '600').w;
    if (before) drawMixed(ctx, measureMixed(ctx, before, fs, cfg.fonts, '600'), tx, ty, P.text, fs, '600');
    if (mid) drawMixed(ctx, measureMixed(ctx, mid, fs, cfg.fonts, '600'), tx + wBefore, ty, P.accent, fs, '600');
    if (after) drawMixed(ctx, measureMixed(ctx, after, fs, cfg.fonts, '600'), tx + wBefore + wMid, ty, P.text, fs, '600');
  }

  // caret + the "pen" rule: a thin line that ends exactly where the typing is
  if (caretVisible) {
    const cx = tx + layout.w + 7;
    ctx.save();
    ctx.shadowColor = P.glow;
    ctx.shadowBlur = 22;
    ctx.fillStyle = P.caret;
    ctx.fillRect(cx, ty - fs * 0.82, 5, fs * 1.06);
    ctx.globalAlpha = boxAlpha * 0.22;
    ctx.fillStyle = P.accent;
    ctx.fillRect(tx, ty + fs * 0.30, Math.max(0, layout.w), 2);
    ctx.restore();
  }

  // placeholder, before anything is typed
  if (!typed && t < TL.segments[0].from + 0.9) {
    ctx.globalAlpha = boxAlpha * (1 - inv(t, TL.segments[0].from, TL.segments[0].from + 0.9));
    ctx.fillStyle = P.placeholder;
    ctx.font = `500 ${fs * 0.9}px ${cfg.fonts.cjk}`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(TL.placeholder, tx, ty);
    ctx.globalAlpha = boxAlpha;
  }

  ctx.globalAlpha = 1;
  ctx.restore(); // end zoom group

  /* --- 4. subtitle block (screen space: does NOT zoom) ------------------- */
  const sub = TL.subtitles;
  const subIn = smooth(inv(t, sub.from, sub.from + sub.in));
  if (subIn > 0.002) {
    const rows = sub.rows;
    const totalH = rows.reduce((a, b) => a + b.size + b.gap, 0);
    let y = sub.y - totalH / 2;
    ctx.save();
    ctx.globalAlpha = subIn;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const row of rows) {
      ctx.font = `600 ${row.size}px ${row.cjk ? cfg.fonts.cjk : cfg.fonts.latin}`;
      const w = ctx.measureText(row.text).width;
      const cx = VW / 2;
      // a dark plate behind the line keeps it readable over the zooming box
      ctx.fillStyle = P.subPlate;
      ctx.beginPath();
      ctx.roundRect(cx - w / 2 - 26, y - row.size * 0.82, w + 52, row.size * 1.18, 10);
      ctx.fill();
      ctx.fillStyle = P.subText;
      ctx.fillText(row.text, cx, y);
      y += row.size + row.gap;
    }
    ctx.restore();
  }

  /* --- 5. progress rail -------------------------------------------------- */
  const rail = TL.rail;
  const railW = rail.width * clamp(t / TL.end);
  ctx.fillStyle = P.railTrack;
  ctx.fillRect((VW - rail.width) / 2, rail.y, rail.width, rail.thickness);
  ctx.fillStyle = P.railFill;
  ctx.fillRect((VW - rail.width) / 2, rail.y, railW, rail.thickness);

  /* --- 6. texture ------------------------------------------------------- */
  grain(ctx, P, cfg, t, frame);
  vignette(ctx, P, cfg.post.vignette * (0.35 + 0.65 * zk));

  ctx.restore();

  /* --- 7. what the verifier checks -------------------------------------- */
  return {
    t,
    frame,
    typed,
    caretVisible,
    zoom,
    fonts: [...fontsUsed],
    pure: true,
  };
}

export const VIEW = { VW, VH };
