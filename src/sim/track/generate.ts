import { hashString, mulberry32 } from '../../util.js';
import { Surface } from '../surfaces.js';
import { Track } from './buildTrack.js';
import type { PropRule, TrackDef } from './TrackDef.js';
import { validateTrack } from './validate.js';
import { GRID_RADIUS, gridBend } from './gridStart.js';

/**
 * A candidate is kept if it validates and its whole grid is on a straight:
 * shortened to 30 s laps, one seed in 25 put the back rows on a bend.
 */
function fits(def: TrackDef): boolean {
  const t = new Track({ ...def, props: [] });
  return validateTrack(t) === null && gridBend(t) <= 1 / GRID_RADIUS;
}

/**
 * Tracks from a seed (PLAN.md M7): the track of the day, and any track a
 * player can name.
 *
 * The same seed must give the same track on every computer, so the
 * generator deals only in integers until it hands over a `TrackDef`:
 * - the random numbers are mulberry32, which is integer arithmetic, and its
 *   draws are turned into choices by exact integer maths;
 * - angles are whole degrees, looked up in a table of cosines and sines
 *   rounded to integers, so no two JavaScript engines can disagree in the
 *   last bit of a `Math.sin`;
 * - corners are whole metres.
 * So the `TrackDef` — the thing that decides the track — is identical
 * everywhere, and a test pins a table of seeds to their exact output.
 *
 * A candidate that fails `validateTrack` is thrown away and the generator
 * draws again from the same stream, so the retries are part of the
 * determinism too.
 */

/** cos and sin of whole degrees, times 10000, rounded: integer trigonometry. */
const COS = Array.from({ length: 360 }, (_, d) => Math.round(Math.cos((d * Math.PI) / 180) * 10000));
const SIN = Array.from({ length: 360 }, (_, d) => Math.round(Math.sin((d * Math.PI) / 180) * 10000));

const THEMES = ['dusk', 'park', 'overcast'] as const;

const FIRST = ['Copper', 'Harbour', 'Neon', 'Rust', 'Velvet', 'Iron', 'Silver', 'Sunset', 'Midnight', 'Amber', 'Cobalt', 'Granite', 'Hollow', 'Signal', 'Static', 'Ember'];
const SECOND = ['Loop', 'Ring', 'Circuit', 'Run', 'Sprint', 'Bends', 'Mile', 'Park', 'Yard', 'Heights', 'Cross', 'Reach'];

/** The seed of any text a player types: case and spacing do not matter. */
export function seedOf(text: string): number {
  return hashString(text.trim().toUpperCase().replace(/\s+/g, ' ')) || 1;
}

/** Today's date in UTC as YYYY-MM-DD: the same string everywhere on Earth at the same instant. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The track of the day's seed. */
export function daySeed(ms: number): number {
  return seedOf(`DAY ${utcDay(ms)}`);
}

/** A name for a seed, drawn from its own stream, so a shared seed is a shared name. */
export function trackName(seed: number): string {
  const rand = mulberry32(seed ^ 0x6e616d65);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  return `${pick(FIRST)} ${pick(SECOND)}`;
}

const cache = new Map<number, TrackDef>();

/**
 * The track for a seed. Memoised: a race builds its `Track` from this, and
 * the racing line is cached per track.
 */
export function generateTrack(seed: number): TrackDef {
  const s = seed >>> 0 || 1;
  const hit = cache.get(s);
  if (hit) return hit;
  const rand = mulberry32(s);
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const style = pickStyle(int, s);
  for (let attempt = 0; attempt < 400; attempt++) {
    const def = candidate(s, int, attempt, style);
    try {
      // Checked bare: scattering a city round a candidate only to throw it away is most of the cost.
      if (fits(def)) {
        cache.set(s, def);
        return def;
      }
    } catch {
      // A corner radius that does not fit between its neighbours: draw again.
    }
  }
  throw new Error(`no valid track for seed ${s}`);
}

/** How many candidates a seed took, for tests and tuning. */
export function attemptsFor(seed: number): number {
  const s = seed >>> 0 || 1;
  const rand = mulberry32(s);
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const style = pickStyle(int, s);
  for (let attempt = 0; attempt < 400; attempt++) {
    const def = candidate(s, int, attempt, style);
    try {
      if (fits(def)) return attempt + 1;
    } catch {
      /* next */
    }
  }
  return Infinity;
}

/** Layout styles, and how each reads on the menu. */
const LAYOUTS = ['loop', 'grid', 'straights'] as const;
const LAYOUT_NAMES = { loop: 'Flowing loop', grid: 'City grid', straights: 'Long straights' } as const;

type Int = (lo: number, hi: number) => number;
type Corner = [number, number, number];
type Style = { theme: (typeof THEMES)[number] | 'day'; layout: (typeof LAYOUTS)[number] };

/**
 * A seed's look and shape, drawn once before any candidate: a layout that
 * fails validation more often is retried until it passes, not swapped for
 * an easier one, so each layout gets its fair third of the seeds.
 */
function pickStyle(int: Int, seed: number): Style {
  const theme = THEMES[int(0, THEMES.length - 1)]!;
  const layout = LAYOUTS[int(0, LAYOUTS.length - 1)]!;
  // A city is by day or at dusk, half and half (M10). Drawn from a stream of
  // its own, so the choice leaves every other draw — the shape — as it was.
  const day = theme === 'dusk' && mulberry32(seed ^ 0x64617921)() < 0.5;
  return { theme: day ? 'day' : theme, layout };
}

function candidate(seed: number, int: Int, attempt: number, { theme, layout }: Style): TrackDef {
  // The tightest corner a theme allows: the park's wide grass verge puts its wall further in.
  const tight = theme === 'park' ? 16 : 14;
  let corners = layout === 'grid' ? grid(int, tight) : layout === 'straights' ? straights(int, tight) : loop(int, theme);
  // Either way round.
  if (int(0, 1)) corners = corners.reverse();
  fit(corners);
  // Shrunk to about a 30 s lap. The layouts were drawn for 1.2-1.8 km, and
  // their spacing rules (notches, dents, sweepers) are in those metres, so
  // they draw as they did and the whole shape scales, in integers so every
  // client rounds alike, by what a lap of each costs: a city grid, all right
  // angles, to 3/5 (its points are on a 5 m grid, which 3/5 keeps exact, so
  // its right angles and diagonals stay true); long straights to 17/20; a
  // flowing loop, the fastest per metre, to 9/10. A radius keeps room for the
  // inside wall.
  const [num, den] = layout === 'grid' ? [3, 5] : layout === 'straights' ? [17, 20] : [9, 10];
  corners = corners.map(([x, z, r]) => [Math.round((x * num) / den), Math.round((z * num) / den), Math.max(Math.round((r * num) / den), tight)]);
  fit(corners);
  const n = corners.length;
  // The longest edge is the main straight: the start line goes on it.
  let longest = 0;
  let best = -1;
  for (let i = 0; i < n; i++) {
    const [ax, az] = corners[i]!;
    const [bx, bz] = corners[(i + 1) % n]!;
    const len2 = (bx - ax) * (bx - ax) + (bz - az) * (bz - az);
    if (len2 > best) {
      best = len2;
      longest = i;
    }
  }
  const [sx0, sz0] = corners[longest]!;
  const [sx1, sz1] = corners[(longest + 1) % n]!;
  // A third of the way along it, so the grid behind the line is on the straight too.
  const start: [number, number] = [Math.round(sx0 + ((sx1 - sx0) * 2) / 3), Math.round(sz0 + ((sz1 - sz0) * 2) / 3)];
  // A jump on the second-longest edge, sometimes.
  let second = -1;
  let secondLen = -1;
  for (let i = 0; i < n; i++) {
    if (i === longest) continue;
    const [ax, az] = corners[i]!;
    const [bx, bz] = corners[(i + 1) % n]!;
    const len2 = (bx - ax) * (bx - ax) + (bz - az) * (bz - az);
    if (len2 > secondLen) {
      secondLen = len2;
      second = i;
    }
  }
  const jump = int(0, 2) > 0 && secondLen > 110 * 110;
  const [jx0, jz0] = corners[second]!;
  const [jx1, jz1] = corners[(second + 1) % n]!;

  const props: PropRule[] = [];
  const area = [-340, -340, 340, 340] as const;
  let water: [number, number, number, number][] | undefined;
  if (theme === 'dusk' || theme === 'day') {
    props.push({ kind: 'city', area, lot: 20, clearance: 0.5, footprint: [12, 18], height: [10, 34], gaps: 0.06, tallness: 0.9 });
    props.push({ kind: 'lamps', spacing: 28 });
  } else if (theme === 'park') {
    // Farmland (M10), before the trees so they keep off it.
    props.push({ kind: 'farms', count: 2, clearance: 3 });
    props.push({ kind: 'windmills', count: 2, clearance: 3 });
    props.push({ kind: 'fields', count: 6, clearance: 2 });
    props.push({ kind: 'herds', count: 4, clearance: 2 });
    props.push({ kind: 'ponds', count: 3, clearance: 3 });
    props.push({ kind: 'flowers', spacing: 36 });
    props.push({ kind: 'trees', area, count: 2100, clearance: 2.5, height: [7, 17] });
  } else {
    const port = harbour(corners, sx0, sz0, sx1, sz1, seed);
    water = [port.water];
    props.push({ kind: 'warehouses', count: 4, clearance: 3 });
    props.push({ kind: 'containers', area, clearance: 1.5, stack: 4, gaps: 0.1, yards: 0.2 });
    props.push(...port.props);
  }

  return {
    id: `seed-${seed.toString(36)}`,
    name: trackName(seed),
    laps: 3,
    seed: (seed ^ Math.imul(attempt + 1, 0x9e3779b1)) >>> 0,
    theme,
    layout: LAYOUT_NAMES[layout],
    corners,
    // A quarter wider than the first tracks' 13 and 14 m, from play-testing.
    width: theme === 'park' ? 16.25 : 17.5,
    verge: theme === 'park' ? { width: 6, surface: Surface.Grass } : { width: theme === 'overcast' ? 2 : 3, surface: Surface.Kerb },
    walls: true,
    start,
    checkpoints: [0.25, 0.5, 0.75],
    ...(water ? { water } : {}),
    surfaces: [],
    ramps: jump ? [{ at: [Math.round((jx0 + jx1) / 2), Math.round((jz0 + jz1) / 2)], len: 14, lift: 1.4 }] : [],
    props,
  };
}

/**
 * A loose star: evenly spread bearings, jittered, at jittered distances, with
 * open corners. The flowing sort of circuit.
 */
function loop(int: Int, theme: string): Corner[] {
  const n = int(7, 11);
  const corners: Corner[] = [];
  const spread = Math.floor(360 / n);
  const base = int(0, 359);
  const radius = int(150, 230);
  for (let i = 0; i < n; i++) {
    const deg = (base + i * spread + int(-Math.floor(spread / 3), Math.floor(spread / 3)) + 720) % 360;
    const r = radius + int(-70, 60);
    corners.push([Math.round((r * COS[deg]!) / 10000), Math.round((r * SIN[deg]!) / 10000), int(theme === 'park' ? 30 : 16, theme === 'park' ? 60 : 40)]);
  }
  return corners;
}

/**
 * City blocks, like Neon Downtown and the Docks: a rectangle whose sides have
 * square notches cut in or pushed out, and now and then a corner cut off on
 * the diagonal. Right angles and tight radii; every point on a 10 m grid.
 */
function grid(int: Int, tight: number): Corner[] {
  const w = int(28, 40) * 10;
  const h = int(20, 32) * 10;
  // Clockwise on screen from the top-left: along the top, down the right, back along the bottom, up the left.
  const sides = [
    { from: [0, 0], dir: [1, 0], len: w },
    { from: [w, 0], dir: [0, 1], len: h },
    { from: [w, h], dir: [-1, 0], len: w },
    { from: [0, h], dir: [0, -1], len: h },
  ];
  const corners: Corner[] = [];
  const at = (x: number, z: number, r: number): void => {
    corners.push([x, z, r]);
  };
  const r = (): number => int(tight, tight + 10);
  for (const side of sides) {
    const [fx, fz] = side.from as [number, number];
    const [dx, dz] = side.dir as [number, number];
    // Inward is the direction turned right (clockwise on screen, +Z down): (dx, dz) -> (-dz, dx).
    const ix = -dz;
    const iz = dx;
    const across = side.len === w ? h : w;
    // The corner at the start of this side: square, or cut on the diagonal.
    if (int(0, 3) === 0) {
      const c = int(3, 5) * 10;
      at(fx + ix * c, fz + iz * c, r() + 6);
      at(fx + dx * c, fz + dz * c, r() + 6);
    } else {
      at(fx, fz, r());
    }
    // Up to two notches along the side, clear of its ends and of each other.
    const notches = side.len >= 320 ? int(0, 2) : int(0, 1);
    let pos = 90;
    for (let k = 0; k < notches; k++) {
      const room = side.len - 90 - pos - (notches - k - 1) * 130;
      if (room < 60) break;
      const span = int(6, Math.min(12, Math.floor(room / 10))) * 10;
      const a = pos + int(0, Math.floor((room - span) / 10)) * 10;
      const b = a + span;
      // In is into the block the circuit goes round; out pushes a block onto the outside.
      const inward = int(0, 2) > 0;
      const depth = (inward ? Math.min(int(6, 12), Math.floor((across - 90) / 10)) : int(6, 10)) * 10;
      if (depth < 50) break;
      const s = inward ? 1 : -1;
      at(fx + dx * a, fz + dz * a, r());
      at(fx + dx * a + ix * depth * s, fz + dz * a + iz * depth * s, r());
      at(fx + dx * b + ix * depth * s, fz + dz * b + iz * depth * s, r());
      at(fx + dx * b, fz + dz * b, r());
      pos = b + 70;
    }
  }
  // Centred on the origin, so the scenery's square is round it.
  return corners.map(([x, z, rr]) => [x - Math.round(w / 2), z - Math.round(h / 2), rr]);
}

/**
 * A long, thin circuit: a stretched star with few corners, deep dents that
 * make hairpins at the ends, and radii from a crawl to flat out. Turned to
 * any whole-degree bearing.
 */
function straights(int: Int, tight: number): Corner[] {
  const n = int(6, 9);
  const spread = Math.floor(360 / n);
  const base = int(0, 359);
  const turn = int(0, 359);
  const long = int(330, 430);
  const short = int(150, 210);
  // One corner pulled well in: a dent in a long side, and a hairpin into and out of it.
  const dent = int(0, n - 1);
  const corners: Corner[] = [];
  for (let i = 0; i < n; i++) {
    const deg = (base + i * spread + int(-Math.floor(spread / 4), Math.floor(spread / 4)) + 720) % 360;
    const pull = i === dent ? int(25, 50) : int(60, 100);
    const x = Math.round((long * pull * COS[deg]!) / 1000000);
    const z = Math.round((short * pull * SIN[deg]!) / 1000000);
    const rx = Math.round((x * COS[turn]! - z * SIN[turn]!) / 10000);
    const rz = Math.round((x * SIN[turn]! + z * COS[turn]!) / 10000);
    corners.push([rx, rz, int(tight, tight + 12)]);
  }
  // The gentle ones — under about 45° — may be fast sweepers instead.
  for (let i = 0; i < n; i++) {
    const t = tanHalf(corners[(i + n - 1) % n]!, corners[i]!, corners[(i + 1) % n]!);
    if (int(0, 1) === 0 && t < 0.41) corners[i]![2] = int(30, 50);
  }
  return corners;
}

/**
 * Shrink any corner too round for its edges: a fillet of radius r turning
 * through angle θ runs r·tan(θ/2) along each edge, and may have half of each.
 * tan(θ/2) comes from the edges as |a×b| / (|a||b| + a·b), which needs only
 * square roots, and IEEE square roots are exact: the same on every engine.
 */
function fit(corners: Corner[]): void {
  const n = corners.length;
  for (let i = 0; i < n; i++) {
    const p = corners[(i + n - 1) % n]!;
    const c = corners[i]!;
    const q = corners[(i + 1) % n]!;
    const t = tanHalf(p, c, q);
    if (t === 0) continue;
    const most = Math.floor(Math.min(dist(p, c), dist(c, q)) / 2 / t);
    if (c[2] > most) c[2] = most;
  }
}

/** Straight-line distance between two corners, by an exact square root. */
function dist(a: Corner, b: Corner): number {
  return Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
}

/** tan of half the angle the road turns through at `c`, coming from `p` and going on to `q`; 0 if it runs straight on. */
function tanHalf(p: Corner, c: Corner, q: Corner): number {
  const ax = c[0] - p[0], az = c[1] - p[1], bx = q[0] - c[0], bz = q[1] - c[1];
  const den = dist(p, c) * dist(c, q) + ax * bx + az * bz;
  const cross = Math.abs(ax * bz - az * bx);
  return cross === 0 || den <= 0 ? 0 : cross / den;
}

/**
 * A harbour for a generated port (M10): water beyond the side of the track's
 * bounding box nearest the main straight, so it is seen every lap; quay
 * cranes along its edge, two ships under their booms, and on some seeds a
 * marina. All whole metres, and no draws from the stream, so the track's
 * shape is the same as it would be without it. The walls keep every car out
 * of the water: the wall is at least 7 m short of it.
 */
function harbour(corners: Corner[], sx0: number, sz0: number, sx1: number, sz1: number, seed: number): { water: [number, number, number, number]; props: PropRule[] } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of corners) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  // The straight's middle, doubled to stay in integers.
  const mx = sx0 + sx1, mz = sz0 + sz1;
  const gaps = [mz - 2 * minZ, 2 * maxX - mx, 2 * maxZ - mz, mx - 2 * minX];
  const side = gaps.indexOf(Math.min(...gaps)); // 0 north, 1 east, 2 south, 3 west
  const Q = 18; // apron between the outermost corner and the water: the wall is at most 10.75 m out
  const far = 420;
  // The quay line runs so that the water is on its right (negative `out` puts ships on its left).
  let water: [number, number, number, number];
  let from: [number, number], to: [number, number];
  if (side === 0) { water = [minX - 200, minZ - Q - far, maxX + 200, minZ - Q]; from = [minX, minZ - Q]; to = [maxX, minZ - Q]; }
  else if (side === 1) { water = [maxX + Q, minZ - 200, maxX + Q + far, maxZ + 200]; from = [maxX + Q, minZ]; to = [maxX + Q, maxZ]; }
  else if (side === 2) { water = [minX - 200, maxZ + Q, maxX + 200, maxZ + Q + far]; from = [maxX, maxZ + Q]; to = [minX, maxZ + Q]; }
  else { water = [minX - Q - far, minZ - 200, minX - Q, maxZ + 200]; from = [minX - Q, maxZ]; to = [minX - Q, minZ]; }
  // Along the quay, the water is on the left of from→to: out is negative.
  const len = Math.abs(to[0] - from[0]) + Math.abs(to[1] - from[1]);
  const dx = Math.sign(to[0] - from[0]), dz = Math.sign(to[1] - from[1]);
  // Cranes 11 m out, booms over the water: yaw so the crane's -Z points away from the land.
  const yaw = [0, -Math.PI / 2, Math.PI, Math.PI / 2][side]!;
  // The left of from→to on screen (+Z is down): towards the water.
  const lx = dz, lz = -dx;
  const cranes: [number, number, number][] = [];
  for (let s = 40; s < len - 20 && cranes.length < 4; s += 75) cranes.push([from[0] + dx * s + lx * 11, from[1] + dz * s + lz * 11, yaw]);
  const props: PropRule[] = [
    { kind: 'cranes', at: cranes },
    { kind: 'ships', from, to, out: -42, count: len > 300 ? 2 : 1 },
  ];
  if ((seed >>> 3) & 1) {
    // A marina past the end of the quay.
    const s0 = Math.max(0, len - 20);
    props.push({ kind: 'marina', from: [from[0] + dx * s0, from[1] + dz * s0], to: [from[0] + dx * (s0 + 150), from[1] + dz * (s0 + 150)], out: -14 });
  }
  return { water, props };
}
