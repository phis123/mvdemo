// png.mjs — a minimal, dependency-free PNG encoder (RGBA8, no interlace).
// We need it because this box has no ffmpeg, no node-canvas and no sharp:
// the only compression primitive available is Node's built-in zlib.
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @param {Buffer|Uint8Array} rgba  raw RGBA8, top-down */
export function encodePng(rgba, width, height) {
  const src = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  if (src.length !== width * height * 4) {
    throw new Error(`encodePng: expected ${width * height * 4} bytes, got ${src.length}`);
  }

  // One filter byte per row. Filter 0 (None) is enough here and keeps it fast;
  // these images are flat colour, so zlib still compresses them heavily.
  const stride = width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: truecolour + alpha
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Nearest-neighbour downscale, in place-ish. Used for contact sheets. */
export function scaleRgba(src, sw, sh, dw, dh) {
  const out = Buffer.allocUnsafe(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      src.copy(out, (y * dw + x) * 4, (sy * sw + sx) * 4, (sy * sw + sx) * 4 + 4);
    }
  }
  return out;
}

/** Compose a grid of equally sized tiles into one image. */
export function grid(tiles, cols, rows, tw, th, bg = [11, 10, 14, 255]) {
  const W = cols * tw;
  const H = rows * th;
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = bg[0]; out[i + 1] = bg[1]; out[i + 2] = bg[2]; out[i + 3] = bg[3];
  }
  tiles.forEach((tile, i) => {
    if (!tile) return;
    const cx = (i % cols) * tw;
    const cy = Math.floor(i / cols) * th;
    for (let y = 0; y < th; y++) {
      tile.copy(out, ((cy + y) * W + cx) * 4, y * tw * 4, y * tw * 4 + tw * 4);
    }
  });
  return { buf: out, W, H };
}

/* --------------------------------------------------------------- decoding */
// Only needs to handle what encodePng() above produces: 8-bit RGBA, no
// interlace, filter type 0. That keeps this short and predictable.

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error('decodePng: only 8-bit RGBA, non-interlaced');
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error(`decodePng: unsupported filter ${filter}`);
    raw.copy(out, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { data: out, width, height };
}

/* ------------------------------------------------------------- bitmap text */
const GLYPHS = {
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

/** Blit 3x5 bitmap text into an RGBA buffer. Used for sheet captions. */
export function label(buf, W, H, str, x0, y0, scale, color = [255, 190, 150]) {
  let x = x0;
  for (const ch of str) {
    const g = GLYPHS[ch] || GLYPHS[' '];
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
