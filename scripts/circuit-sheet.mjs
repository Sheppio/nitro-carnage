/**
 * docs/circuits.png: each real circuit's source outline (grey) beside the
 * track the game builds from it (black), to judge by eye what survived the
 * scaling. `npm run circuits:sheet` after `npm run circuits`.
 */
import fs from 'node:fs';
import { launch } from '../test/rig.mjs';
import { Track } from '../dist/sim/track/buildTrack.js';
import { CIRCUITS } from '../dist/sim/track/circuits.js';
import { HAND } from './circuits/hand.mjs';
import { CIRCUIT_INFO } from './circuits/info.mjs';

const geo = JSON.parse(fs.readFileSync(new URL('./circuits/f1-circuits.json', import.meta.url)));

/** lon/lat to metres, as the build does. */
function project(coords) {
  const lat0 = coords.reduce((a, p) => a + p[1], 0) / coords.length;
  const lon0 = coords.reduce((a, p) => a + p[0], 0) / coords.length;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  return coords.map(([lon, lat]) => [(lon - lon0) * kx, -(lat - lat0) * 110540]);
}

/** A closed path fitted into a box. */
function path(pts, x0, y0, size) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const k = size / Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY);
  const ox = x0 + (size - (Math.max(...xs) - minX) * k) / 2, oy = y0 + (size - (Math.max(...ys) - minY) * k) / 2;
  return 'M' + pts.map(([x, y]) => `${(ox + (x - minX) * k).toFixed(1)},${(oy + (y - minY) * k).toFixed(1)}`).join('L') + 'Z';
}

const COLS = 3, CELL = 300, PAD = 16, SIZE = 120;
const rows = Math.ceil(CIRCUITS.length / COLS);
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * CELL}" height="${rows * (SIZE + 56)}" font-family="sans-serif">`;
svg += `<rect width="100%" height="100%" fill="#fff"/>`;
CIRCUITS.forEach((def, n) => {
  const info = CIRCUIT_INFO[def.id];
  const outline = info.hand ? HAND[info.hand]() : project(geo[info.geo].coordinates);
  const t = new Track({ ...def, props: [] });
  const line = [];
  for (let i = 0; i < t.n; i += 4) line.push([t.line.px[i], t.line.pz[i]]);
  const x = (n % COLS) * CELL, y = Math.floor(n / COLS) * (SIZE + 56);
  svg += `<path d="${path(outline, x + PAD, y + 30, SIZE)}" fill="none" stroke="#aaa" stroke-width="2"/>`;
  svg += `<path d="${path(line, x + PAD + SIZE + 20, y + 30, SIZE)}" fill="none" stroke="#111" stroke-width="2.5"/>`;
  svg += `<text x="${x + PAD}" y="${y + 20}" font-size="12" fill="#222">${def.name.replace('&', '&amp;')} · ${(t.length / 1000).toFixed(2)} km</text>`;
});
svg += '</svg>';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: COLS * CELL, height: rows * (SIZE + 56) } });
await page.setContent(`<body style="margin:0">${svg}</body>`);
await page.screenshot({ path: new URL('../docs/circuits.png', import.meta.url).pathname });
await browser.close();
console.log('wrote docs/circuits.png');
