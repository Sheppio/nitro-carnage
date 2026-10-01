import { SIM } from '../config.js';
import { mulberry32 } from '../util.js';
import type { Track } from './track/buildTrack.js';

/**
 * Pickups on the road: rows of boxes across the track that top up missiles
 * and mines, patch the car up, or fill the turbo. Pure: where they stand
 * comes from the track alone, so every client puts them in the same places,
 * and whether one is there is a function of when it was last taken.
 *
 * Who takes a box is decided like a mine: by the client that drives the car
 * that touched it. It applies the effect to its own car and tells the room,
 * and every other screen hides that box until it comes back. Two cars
 * reaching the same box within a packet's flight both get it, which nobody
 * will ever notice.
 */

export type PickupKind = 'ammo' | 'repair' | 'turbo';

export interface PickupSpot {
  x: number;
  z: number;
  /** Arc length of its row. */
  s: number;
  kind: PickupKind;
}

const P = SIM.pickups;
const KINDS: readonly PickupKind[] = ['ammo', 'repair', 'turbo'];
/** A row's two boxes: either side of the middle of the road, as a fraction of its half-width. */
const LANES = [-1, 1];

/**
 * Where the boxes stand: `P.rows` rows spread round the lap, each two boxes
 * across the road. A row goes on the straightest piece of road near its share
 * of the lap, clear of the start line, the ramps and any level crossing.
 * Each box is a kind drawn at random (#30) — a row may be a mix, or two of a
 * kind — from the track's seed, so every client deals the same. Only the
 * kinds that would do something are drawn: with weapons off, ammo and repairs
 * would not; with the turbo off, a turbo box would not. With nothing left
 * there are no rows at all.
 */
export function pickupSpots(track: Track, weapons: boolean, turbo = true): PickupSpot[] {
  const kinds = KINDS.filter((k) => (k === 'turbo' ? turbo : weapons));
  if (!kinds.length) return [];
  const rand = mulberry32(track.def.seed ^ 0x9e3779b9);
  const L = track.length;
  const spacing = L / track.n;
  const heading = (s: number): number => track.poseAt(s).yaw;
  const turn = (s: number): number => {
    let d = heading(s + 20) - heading(s - 20);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d);
  };
  const near = (s: number, at: number, r: number): boolean => {
    const d = Math.abs(((s - at) % L + L * 1.5) % L - L / 2);
    return d < r;
  };
  const out: PickupSpot[] = [];
  for (let r = 0; r < P.rows; r++) {
    const target = L * ((r + 0.5) / P.rows);
    let best = -1;
    let bestTurn = Infinity;
    // Search a window round the target, in 5 m steps, for the straightest clear road.
    for (let o = -L * 0.12; o <= L * 0.12; o += 5) {
      const s = (target + o + L) % L;
      // Not on the grid, a ramp or the level crossing.
      if (near(s, 0, 45) || track.ramps.some((rp) => near(s, (rp.s0 + rp.s1) / 2, 30 + (rp.s1 - rp.s0) / 2))) continue;
      if (track.rail && near(s, track.rail.s, 30)) continue;
      const t = turn(s) + Math.abs(o) * 0.0005;
      if (t < bestTurn) {
        bestTurn = t;
        best = s;
      }
    }
    // Drawn whether or not the row finds road, so one row's luck never
    // changes the next row's boxes.
    const drawn = LANES.map(() => kinds[Math.floor(rand() * kinds.length)]!);
    if (best < 0) continue;
    const pose = track.poseAt(best);
    LANES.forEach((lane, k) => {
      const [x, z] = track.offsetPoint(pose.i, lane * track.halfWidth * 0.5);
      const frac = best / spacing - pose.i;
      out.push({ x: x + track.line.tx[pose.i]! * frac, z: z + track.line.tz[pose.i]! * frac, s: best, kind: drawn[k]! });
    });
  }
  return out;
}


/** The boxes in one race, and when each is back. */
export class Pickups {
  readonly spots: PickupSpot[];
  /** World time each box is back on the road; 0 while it is there. */
  readonly back: Float64Array;

  constructor(track: Track, weapons: boolean, turbo = true) {
    this.spots = pickupSpots(track, weapons, turbo);
    this.back = new Float64Array(this.spots.length);
  }

  /** Whether box `i` is on the road at world time `t`. */
  here(i: number, t: number): boolean {
    return t >= (this.back[i] ?? Infinity);
  }

  /** Box `i` was taken at world time `t`: gone until it respawns. Later news of the same take changes nothing. */
  take(i: number, t: number): void {
    if (i < 0 || i >= this.spots.length) return;
    this.back[i] = Math.max(this.back[i]!, t + P.respawn);
  }

  /** The box a car at (x, z) is touching at time `t`, or -1. */
  touching(x: number, z: number, t: number): number {
    const r2 = P.radius * P.radius;
    for (let i = 0; i < this.spots.length; i++) {
      const p = this.spots[i]!;
      if (this.here(i, t) && (p.x - x) ** 2 + (p.z - z) ** 2 < r2) return i;
    }
    return -1;
  }
}
