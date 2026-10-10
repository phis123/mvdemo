// tiles.mjs — pick frames out of a rendered sequence and lay them into one sheet.
//   node tools/tiles.mjs --dir out/frames --cols 4 --cell 480x270 --out out/timeline.png
//
// Reads the manifest written by tools/shot.mjs --seq so the sheet always matches
// what was actually rendered.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng, grid, label, scaleRgba } from './png.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);

const dir = arg('--dir', 'out/frames');
const out = arg('--out', 'out/timeline.png');
const cols = Number(arg('--cols', 4));
const [tw, th] = arg('--cell', '480x270').split('x').map(Number);
const count = Number(arg('--count', cols * 4));

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const total = manifest.count;
const picks = Array.from({ length: count }, (_, i) => Math.round((i * (total - 1)) / (count - 1)));

const tiles = picks.map((i) => {
  const png = decodePng(fs.readFileSync(path.join(dir, manifest.frames[i].file)));
  // nearest-neighbour: these are 1920x1080 -> 480x270, and the picture is flat
  return scaleRgba(png.data, png.width, png.height, tw, th);
});

const rows = Math.ceil(picks.length / cols);
const { buf, W, H } = grid(tiles, cols, rows, tw, th);

picks.forEach((i, k) => {
  const cx = (k % cols) * tw;
  const cy = Math.floor(k / cols) * th;
  label(buf, W, H, `t${manifest.frames[i].t.toFixed(2)}s`, cx + 14, cy + 14, 2);
  label(buf, W, H, `f${i}`, cx + 14, cy + 36, 2, [150, 146, 160]);
});

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng(buf, W, H));
console.log(`timeline ${W}x${H}  ${picks.length}/${total} frames -> ${out}`);
console.log(`  picked: ${picks.join(', ')}`);
