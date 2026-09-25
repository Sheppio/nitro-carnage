/**
 * Build the real-circuit tracks (PLAN.md M9): outlines in, `TrackDef`s out.
 *
 *   npm run build && node scripts/build-circuits.mjs
 *
 * Writes src/sim/track/circuits.ts. It runs offline, and its output is
 * committed, because every client has to build a byte-identical track: the
 * projection from latitude and longitude uses Math.cos, which no two
 * browsers are promised to agree on to the last bit. So the maths happens
 * once, here, and the game only ever sees whole metres.
 *
 * For each circuit:
 * 1. The outline, in metres: projected from GeoJSON (scripts/circuits/
 *    f1-circuits.json, MIT, © Tomislav Bacinger, github.com/bacinger/
 *    f1-circuits), or drawn by hand in scripts/circuits/hand.mjs.
 * 2. Scaled to an arcade lap (1.2-1.8 km): longer circuits get longer laps,
 *    up to the limit.
 * 3. Simplified to a polygon (Douglas-Peucker), each corner given the radius
 *    the real road takes: from how far the real line cuts inside the
 *    corner's point, r = d / (sec(θ/2) - 1).
 * 4. Corners too tight to drive, or with too little straight between them to
 *    fit their curve, are merged with a neighbour until everything fits:
 *    two turns the same way become one at the meeting of their outer edges
 *    (a double apex becomes one corner), a left-right becomes a kink.
 * 5. Validated like every track; a circuit that fails stops the build.
 */
import fs from 'node:fs';
import { Track } from '../dist/sim/track/buildTrack.js';
import { validateTrack } from '../dist/sim/track/validate.js';
import { straightStart } from '../dist/sim/track/gridStart.js';
import { HAND } from './circuits/hand.mjs';
import { CIRCUIT_INFO } from './circuits/info.mjs';

/** Lap lengths to aim for, longest first, metres: the first that builds cleanly wins. About 30 s a lap. */
const TARGETS = (process.env.TARGETS ?? '1250,1150,1050').split(',').map(Number);
/**
 * Each circuit's own lap length, from timing the best bot on it: corners cost
 * time, so a twisty circuit gets less road than an oval for the same ~30 s.
 */
const TARGET_FOR = JSON.parse(fs.readFileSync(new URL('./circuits/targets.json', import.meta.url)));
const targetsFor = (id) => (TARGET_FOR[id] ? [1, 0.93, 0.86].map((f) => Math.round(TARGET_FOR[id] * f)) : TARGETS);
/** Road width, and the tightest corner that still leaves the inside wall room. */
const WIDTH = 13.75;
const RMIN = 12;
const geo = JSON.parse(fs.readFileSync(new URL('./circuits/f1-circuits.json', import.meta.url)));

/** lon/lat to metres, +X east and +Z south (screen down). */
function project(coords) {
  const lat0 = coords.reduce((a, p) => a + p[1], 0) / coords.length;
  const lon0 = coords.reduce((a, p) => a + p[0], 0) / coords.length;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const pts = coords.map(([lon, lat]) => [(lon - lon0) * kx, -(lat - lat0) * 110540]);
  const [a, b] = [pts[0], pts[pts.length - 1]];
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1) pts.pop();
  return pts;
}

const len = (pts) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + Math.hypot(q[0] - p[0], q[1] - p[1]); }, 0);

/** Douglas-Peucker on a closed loop, split at the start and the far point. */
function simplify(pts, eps) {
  const dp = (a, b) => {
    const [ax, az] = pts[a % pts.length], [bx, bz] = pts[b % pts.length];
    let far = -1, fd = eps;
    for (let i = a + 1; i < b; i++) {
      const [px, pz] = pts[i % pts.length];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
      const d = Math.hypot(px - ax - t * dx, pz - az - t * dz);
      if (d > fd) { fd = d; far = i; }
    }
    return far < 0 ? [a] : [...dp(a, far), ...dp(far, b)];
  };
  // Split at the point farthest from the start, so neither half is degenerate.
  let far = 0, fd = 0;
  for (let i = 0; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
  return [...dp(0, far), ...dp(far, pts.length)].map((i) => pts[i % pts.length]);
}

/** Shortest distance from a point to a closed polyline. */
function distTo(pts, x, z) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[(i + 1) % pts.length];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

/** Turn at a corner: signed angle, and tan of half its size. */
function turn(p, c, q) {
  const ax = c[0] - p[0], az = c[1] - p[1], bx = q[0] - c[0], bz = q[1] - c[1];
  const cross = ax * bz - az * bx, dot = ax * bx + az * bz;
  const ang = Math.atan2(cross, dot);
  return { ang, tanHalf: Math.tan(Math.abs(ang) / 2) };
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Where the lines p→a and b→q meet, or null if they (nearly) do not. */
function meet(p, a, b, q) {
  const d1x = a[0] - p[0], d1z = a[1] - p[1], d2x = q[0] - b[0], d2z = q[1] - b[1];
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-6 * Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z)) return null;
  const t = ((b[0] - p[0]) * d2z - (b[1] - p[1]) * d2x) / den;
  return [p[0] + t * d1x, p[1] + t * d1z];
}

/**
 * Corners with radii that fit. `line` is the scaled real outline, for the
 * radius each corner really has.
 *
 * Each corner wants the radius the real road takes there. Where two corners
 * want more of the straight between them than it has, both are shrunk in
 * proportion. Where that would take one below the tightest the road allows,
 * the straight is lengthened instead — the pair pushed apart, which keeps a
 * hairpin a hairpin and a chicane a chicane — and only where that would
 * have to be absurd are the two merged into one.
 */
function cornersFor(poly, line, rmin, separate) {
  let c = poly.map((p) => [p[0], p[1], 0]);
  for (let guard = 0; guard < 900; guard++) {
    const n = c.length;
    const t = [], want = [];
    for (let i = 0; i < n; i++) {
      const p = c[(i + n - 1) % n], v = c[i], q = c[(i + 1) % n];
      const { ang, tanHalf } = turn(p, v, q);
      t[i] = tanHalf;
      const apex = distTo(line, v[0], v[1]);
      const sec = 1 / Math.cos(Math.abs(ang) / 2) - 1;
      want[i] = Math.abs(ang) < 0.02 ? 600 : Math.min(600, Math.max(rmin, apex / Math.max(sec, 1e-6)));
    }
    // The track builder lets each corner use up to half of each straight beside it.
    const half = (i) => (Math.min(dist(c[(i + n - 1) % n], c[i]), dist(c[i], c[(i + 1) % n])) * 0.97) / 2;
    let worst = -1, worstNeed = 1;
    for (let i = 0; i < n; i++) {
      const need = (rmin * t[i]) / half(i);
      if (need > worstNeed) { worstNeed = need; worst = i; }
    }
    if (worst < 0) {
      for (let i = 0; i < n; i++) c[i][2] = Math.max(rmin, Math.min(want[i], t[i] > 1e-9 ? half(i) / t[i] : 600));
      // It fits; now, does the road clear itself? If not, push apart and go round again.
      const moved = separate(c);
      if (!moved) return c;
      c = moved;
      continue;
    }
    // The shorter straight beside the worst corner is the one to lengthen (or the pair across it to merge).
    const prevShort = dist(c[(worst + n - 1) % n], c[worst]) < dist(c[worst], c[(worst + 1) % n]);
    worst = prevShort ? (worst + n - 1) % n : worst;
    const a = worst, b = (worst + 1) % n;
    const L = dist(c[a], c[b]);
    const needLen = (2 * rmin * Math.max(t[a], t[b])) / 0.95 + 1;
    const ca = c[a], cb = c[b];
    if (t[a] < 4 && t[b] < 4 && needLen < 2.5 * L + 30) {
      // Push the pair apart along their straight.
      const ux = (cb[0] - ca[0]) / (L || 1), uz = (cb[1] - ca[1]) / (L || 1);
      const grow = (needLen - L) / 2;
      c[a] = [ca[0] - ux * grow, ca[1] - uz * grow, 0];
      c[b] = [cb[0] + ux * grow, cb[1] + uz * grow, 0];
      continue;
    }
    // Merge: same way round, at the meeting of the outer edges if it is near; otherwise halfway.
    const pa = c[(a + n - 1) % n], nb = c[(b + 1) % n];
    const sa = Math.sign(turn(pa, ca, cb).ang), sb = Math.sign(turn(ca, cb, nb).ang);
    let merged = null;
    if (sa === sb) {
      const m = meet(pa, ca, cb, nb);
      if (m && dist(m, ca) < 3 * L + 20) merged = m;
    }
    if (!merged) merged = [(ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2];
    const next = [];
    for (let k = 0; k < n; k++) {
      if (k === a) next.push([merged[0], merged[1], 0]);
      else if (k !== b) next.push(c[k]);
    }
    c = next;
  }
  throw new Error('corners never settled');
}

/**
 * A figure of eight cannot be driven in a flat world: the crossover would be
 * a crossroads. Untangle it by driving one lobe the other way, which keeps
 * the outline, and pull the two passes apart where they met.
 */
function untangle(pts, cut) {
  const n = pts.length;
  const seg = (i) => [pts[i], pts[(i + 1) % n]];
  const cross = (a, b, c, d) => {
    const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
    if (Math.abs(den) < 1e-9) return null;
    const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
    const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
    return t > 0 && t < 1 && u > 0 && u < 1 ? [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] : null;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const x = cross(...seg(i), ...seg(j));
      if (!x) continue;
      const lobe = pts.slice(i + 1, j + 1).reverse();
      const out = [...pts.slice(0, i + 1), x, ...lobe, x, ...pts.slice(j + 1)];
      return out.filter((p) => Math.hypot(p[0] - x[0], p[1] - x[1]) > cut);
    }
  }
  return pts;
}

function build(id, info, outline) {
  if (info.untangle) outline = untangle(outline, info.untangle);
  const real = len(outline);
  let best = null;
  let fallback = null;
  // The full arcade lap if it can be had — the more room, the more of the
  // real corners survive — else a little less. For each size, a few
  // tolerances; for each, scale until the finished lap is on target.
  const targets = targetsFor(id);
  const tries = targets.flatMap((target) => [2.5, 3.5, 5, 7].map((eps) => [target, eps]));
  for (const [target, eps] of tries) {
    if (fallback && target < targets[0]) break;
    // Bisect the scale: merging makes the lap jump as the scale moves, so a
    // proportional step overshoots; keep a bracket instead.
    let k = target / real, lo = 0, hi = Infinity;
    for (let pass = 0; pass < 10; pass++) {
      const line = outline.map(([x, z]) => [x * k, z * k]);
      const poly = simplify(line, eps);
      const rmin = RMIN;
      let raw;
      try {
        raw = cornersFor(poly, line, rmin, (c) => pushApart(id, info, c, line[0]));
      } catch (e) {
        best = e.message;
        // Try a touch larger: more room usually settles it.
        lo = k;
        k = hi < Infinity ? (lo + hi) / 2 : k * 1.05;
        continue;
      }
      // Centre on the origin, whole metres.
      const cx = raw.reduce((s, p) => s + p[0], 0) / raw.length, cz = raw.reduce((s, p) => s + p[1], 0) / raw.length;
      let corners = raw.map(([x, z, r]) => [Math.round(x - cx), Math.round(z - cz), r]);
      refit(corners, rmin);
      const start = [Math.round(line[0][0] - cx), Math.round(line[0][1] - cz)];
      const def = defFor(id, info, corners, start);
      let why, lap = 0;
      try {
        const t = new Track({ ...def, props: [] });
        lap = t.length;
        why = validateTrack(t);
      } catch (e) {
        why = e.message;
      }
      if (process.env.CLOSE && why?.startsWith('road passes')) {
        const t = new Track({ ...def, props: [] });
        let bd = Infinity, bi = 0, bj = 0;
        for (let i = 0; i < t.n; i += 3) for (let j = i + 3; j < t.n; j += 3) {
          if (Math.min(j - i, t.n - (j - i)) < 60) continue;
          const d = Math.hypot(t.line.px[i] - t.line.px[j], t.line.pz[i] - t.line.pz[j]);
          if (d < bd) { bd = d; bi = i; bj = j; }
        }
        closeAt[id] = { def, a: [t.line.px[bi], t.line.pz[bi]], b: [t.line.px[bj], t.line.pz[bj]], d: bd, fa: bi / t.n, fb: bj / t.n };
      }
      if (process.env.TRACE === id) console.log(`  eps ${eps} pass ${pass} k ${k.toFixed(3)} lap ${lap.toFixed(0)} corners ${corners.length}: ${why ?? 'ok'}`);
      if (!why && Math.abs(lap - target) < 80) return { def: gridOnStraight(def), k, eps, real };
      if (!why) fallback = fallback ?? { def: gridOnStraight(def), k, eps, real };
      best = why ?? best;
      if (!lap) break;
      if (Math.abs(lap - target) < 20) break;
      if (lap < target) lo = k; else hi = k;
      k = hi < Infinity ? (lo + hi) / 2 : k * Math.min(1.3, target / lap);
    }
  }
  if (fallback) return fallback;
  throw new Error(`${id}: ${best}`);
}

/** Radii that fit whole-metre corners: on a gentle kink, rounding moves the angle a lot. */
function refit(corners, rmin) {
  for (let i = 0; i < corners.length; i++) {
    const m = corners.length, p = corners[(i + m - 1) % m], v = corners[i], q = corners[(i + 1) % m];
    const th = turn(p, v, q).tanHalf;
    const most = th > 1e-9 ? (Math.min(dist(p, v), dist(v, q)) * 0.98) / 2 / th : 600;
    v[2] = Math.max(rmin, Math.floor(Math.min(v[2], most, 600)));
  }
}

/**
 * Where two stretches of road come too close — the real circuit's run close,
 * and at a third of the size, with the road three times too wide for it,
 * they touch — push the nearest corner of each apart, a few metres at a
 * time. Returns the moved corners, or null when the road clears itself.
 */
function pushApart(id, info, corners, start) {
  const sep = 28 + 2;
  let t;
  try {
    t = new Track({ ...defFor(id, info, corners.map(([x, z, r]) => [x, z, Math.floor(r)]), start), props: [] });
  } catch {
    return null;
  }
  let bd = Infinity, bi = 0, bj = 0;
  for (let i = 0; i < t.n; i += 3) {
    for (let j = i + 3; j < t.n; j += 3) {
      if (Math.min(j - i, t.n - (j - i)) < 60) continue;
      const d = Math.hypot(t.line.px[i] - t.line.px[j], t.line.pz[i] - t.line.pz[j]);
      if (d < bd) { bd = d; bi = i; bj = j; }
    }
  }
  if (bd >= sep) return null;
  const a = [t.line.px[bi], t.line.pz[bi]], b = [t.line.px[bj], t.line.pz[bj]];
  const nearest = (p, not) => {
    let k = -1, kd = Infinity;
    corners.forEach((c, i) => { const d = dist(c, p); if (i !== not && d < kd) { kd = d; k = i; } });
    return k;
  };
  const ka = nearest(a, -1), kb = nearest(b, ka);
  const d = Math.max(bd, 0.5);
  const ux = (a[0] - b[0]) / d, uz = (a[1] - b[1]) / d;
  const push = Math.min(6, (sep - bd) / 2 + 1);
  return corners.map((c, i) => (i === ka ? [c[0] + ux * push, c[1] + uz * push, 0] : i === kb ? [c[0] - ux * push, c[1] - uz * push, 0] : c));
}

function defFor(id, info, corners, start) {
  return {
    id,
    name: info.name,
    laps: info.laps ?? 3,
    seed: info.seed,
    theme: info.theme,
    circuit: info.circuit,
    corners,
    // Narrower than the game's own tracks: at a fifth of the real size, a wide
    // road swallows the real corners. 11 m at first; a quarter wider when the
    // laps came down to about 30 s, because play-testing asked for room.
    width: WIDTH,
    verge: info.theme === 'park' ? { width: 3, surface: 2 } : { width: 3, surface: 4 },
    walls: true,
    minSeparation: 28,
    start,
    checkpoints: [0.25, 0.5, 0.75],
    surfaces: [],
    ramps: [],
    props: [],
  };
}

/** The corners' bounding box. */
function bbox(corners) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of corners) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  return { minX, maxX, minZ, maxZ };
}

/**
 * The scenery for a circuit: farmland and woods for the parkland ones, the
 * city for the street circuits, and water where the real place has it —
 * the harbour at Monaco and Yas Marina, Lake Lloyd inside Daytona.
 */
/**
 * The real start line, moved on to the first straight long enough for the
 * grid: at 30 s a lap some real lines were right after a corner, and the
 * back of the grid started on the bend.
 */
function gridOnStraight(def) {
  const start = straightStart(new Track({ ...def, props: [] }), (st) => new Track({ ...def, start: st, props: [] }));
  return start ? { ...def, start } : def;
}

function dress(def, info) {
  const b = bbox(def.corners);
  const area = [b.minX - 250, b.minZ - 250, b.maxX + 250, b.maxZ + 250];
  const props = [];
  const water = [];
  if (info.harbour) {
    // Beyond the side of the box nearest the start line, with a marina along its edge.
    const [sx, sz] = def.start;
    const gaps = [sz - b.minZ, b.maxX - sx, b.maxZ - sz, sx - b.minX];
    const side = gaps.indexOf(Math.min(...gaps));
    const Q = 14, far = 420;
    let from, to;
    if (side === 0) { water.push([b.minX - 200, b.minZ - Q - far, b.maxX + 200, b.minZ - Q]); from = [b.minX, b.minZ - Q]; to = [b.maxX, b.minZ - Q]; }
    else if (side === 1) { water.push([b.maxX + Q, b.minZ - 200, b.maxX + Q + far, b.maxZ + 200]); from = [b.maxX + Q, b.minZ]; to = [b.maxX + Q, b.maxZ]; }
    else if (side === 2) { water.push([b.minX - 200, b.maxZ + Q, b.maxX + 200, b.maxZ + Q + far]); from = [b.maxX, b.maxZ + Q]; to = [b.minX, b.maxZ + Q]; }
    else { water.push([b.minX - Q - far, b.minZ - 200, b.minX - Q, b.maxZ + 200]); from = [b.minX - Q, b.maxZ]; to = [b.minX - Q, b.minZ]; }
    props.push({ kind: 'marina', from, to, out: -6 });
  }
  if (info.lake) {
    // The infield lake: the middle of the box, shrunk until it is well clear of the road.
    const t = new Track({ ...def, props: [] });
    for (let f = 0.3; f < 0.49; f += 0.02) {
      const w = [b.minX + (b.maxX - b.minX) * f, b.minZ + (b.maxZ - b.minZ) * f, b.maxX - (b.maxX - b.minX) * f, b.maxZ - (b.maxZ - b.minZ) * f].map(Math.round);
      let near = Infinity;
      for (let i = 0; i < t.n; i += 4) {
        const x = t.line.px[i], z = t.line.pz[i];
        near = Math.min(near, Math.hypot(Math.max(w[0] - x, 0, x - w[2]), Math.max(w[1] - z, 0, z - w[3])));
      }
      if (near > t.wallOffset + 25) { water.push(w); break; }
    }
  }
  if (info.theme === 'park') {
    const trees = Math.min(4000, Math.round(((area[2] - area[0]) * (area[3] - area[1])) * 0.0035));
    props.push(
      { kind: 'farms', count: 2, clearance: 3 },
      { kind: 'windmills', count: 1, clearance: 3 },
      { kind: 'fields', count: 5, clearance: 2 },
      { kind: 'herds', count: 3, clearance: 2 },
      { kind: 'flowers', spacing: 40 },
      { kind: 'trees', area, count: trees, clearance: 2.5, height: [7, 17] },
    );
  } else {
    props.push(
      { kind: 'city', area: [b.minX - 150, b.minZ - 150, b.maxX + 150, b.maxZ + 150], lot: 20, clearance: 0.5, footprint: [12, 18], height: [10, 34], gaps: 0.06, tallness: 0.9 },
      { kind: 'lamps', spacing: 28 },
    );
  }
  return { ...def, ...(water.length ? { water } : {}), props };
}

const out = [];
const report = [];
const closeAt = {};
for (const [id, info] of Object.entries(CIRCUIT_INFO)) {
  const outline = info.hand ? HAND[info.hand]() : project(geo[info.geo].coordinates);
  try {
    const { def, k, eps, real } = build(id, info, outline);
    const t = new Track({ ...def, props: [] });
    out.push(dress(def, info));
    report.push(`${info.name.padEnd(42)} ${(real / 1000).toFixed(2)} km -> ${(t.length / 1000).toFixed(2)} km (x${k.toFixed(3)}), ${def.corners.length} corners, eps ${eps}`);
  } catch (e) {
    report.push(`FAILED ${e.message}`);
  }
}
console.log(report.join('\n'));
if (process.env.CLOSE) fs.writeFileSync(process.env.CLOSE, JSON.stringify(closeAt));
if (process.argv.includes('--write')) {
  const src = `import type { TrackDef } from './TrackDef.js';

/**
 * Built-in tracks shaped like real circuits (M9). GENERATED by
 * scripts/build-circuits.mjs — edit the outlines or the per-circuit info
 * there, not this file.
 *
 * Outlines from github.com/bacinger/f1-circuits (MIT, © Tomislav Bacinger)
 * where it has them; the rest drawn by hand. Shapes only: scaled to an
 * arcade lap, the small wiggles merged, no hills.
 */
export const CIRCUITS: readonly TrackDef[] = ${JSON.stringify(out, null, 1).replace(/\n\s+(-?\d+),\n\s+(-?\d+),\n\s+(-?\d+)\n\s+\]/g, ' $1, $2, $3 ]').replace(/\n\s+(-?\d+),\n\s+(-?\d+)\n\s+\]/g, ' $1, $2 ]')};
`;
  fs.writeFileSync(new URL('../src/sim/track/circuits.ts', import.meta.url), src);
  console.log('wrote src/sim/track/circuits.ts');
}
