import { hashString, mulberry32 } from '../../util.js';
import { Surface } from '../surfaces.js';
import { Track } from './buildTrack.js';
import type { PropRule, TrackDef } from './TrackDef.js';
import { validateTrack } from './validate.js';

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
  for (let attempt = 0; attempt < 400; attempt++) {
    const def = candidate(s, int, attempt);
    try {
      // Checked bare: scattering a city round a candidate only to throw it away is most of the cost.
      if (validateTrack(new Track({ ...def, props: [] })) === null) {
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
  for (let attempt = 0; attempt < 400; attempt++) {
    const def = candidate(s, int, attempt);
    try {
      if (validateTrack(new Track({ ...def, props: [] })) === null) return attempt + 1;
    } catch {
      /* next */
    }
  }
  return Infinity;
}

function candidate(seed: number, int: (lo: number, hi: number) => number, attempt: number): TrackDef {
  const theme = THEMES[int(0, THEMES.length - 1)]!;
  const n = int(7, 11);
  const corners: [number, number, number][] = [];
  // Round a loose star: evenly spread bearings, jittered, at jittered distances.
  // Integer degrees and metres throughout.
  const spread = Math.floor(360 / n);
  const base = int(0, 359);
  const radius = int(150, 230);
  for (let i = 0; i < n; i++) {
    const deg = (base + i * spread + int(-Math.floor(spread / 3), Math.floor(spread / 3)) + 720) % 360;
    const r = radius + int(-70, 60);
    const x = Math.round((r * COS[deg]!) / 10000);
    const z = Math.round((r * SIN[deg]!) / 10000);
    corners.push([x, z, int(theme === 'park' ? 30 : 16, theme === 'park' ? 60 : 40)]);
  }
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
  const area = [-420, -420, 420, 420] as const;
  if (theme === 'dusk') {
    props.push({ kind: 'city', area, lot: 20, clearance: 0.5, footprint: [12, 18], height: [10, 34], gaps: 0.06, tallness: 0.9 });
    props.push({ kind: 'lamps', spacing: 28 });
  } else if (theme === 'park') {
    props.push({ kind: 'trees', area, count: 3600, clearance: 2.5, height: [7, 17] });
  } else {
    props.push({ kind: 'containers', area, clearance: 1.5, stack: 4, gaps: 0.14 });
  }

  return {
    id: `seed-${seed.toString(36)}`,
    name: trackName(seed),
    laps: 3,
    seed: (seed ^ Math.imul(attempt + 1, 0x9e3779b1)) >>> 0,
    theme,
    corners,
    width: theme === 'park' ? 13 : 14,
    verge: theme === 'park' ? { width: 6, surface: Surface.Grass } : { width: theme === 'dusk' ? 3 : 2, surface: Surface.Kerb },
    walls: true,
    start,
    checkpoints: [0.25, 0.5, 0.75],
    surfaces: [],
    ramps: jump ? [{ at: [Math.round((jx0 + jx1) / 2), Math.round((jz0 + jz1) / 2)], len: 14, lift: 1.4 }] : [],
    props,
  };
}
