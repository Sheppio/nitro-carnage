import { SIM } from '../config.js';
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

/**
 * Where the boxes stand: `P.rows` rows spread round the lap, each a box per
 * lane. A row goes on the straightest piece of road near its share of the
 * lap, clear of the start line, the ramps and any level crossing. Only the
 * kinds that would do something are laid: with weapons off, ammo and repairs
 * would not; with the turbo off, a turbo box would not. Their lanes get the
 * row's other kinds instead, and with nothing left there are no rows at all.
 */
export function pickupSpots(track: Track, weapons: boolean, turbo = true): PickupSpot[] {
  const useful = (k: PickupKind): boolean => (k === 'turbo' ? turbo : weapons);
  if (!weapons && !turbo) return [];
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
  const kinds: PickupKind[][] = [['ammo', 'repair', 'turbo'], ['turbo', 'ammo', 'repair'], ['repair', 'turbo', 'ammo']];
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
    if (best < 0) continue;
    const pose = track.poseAt(best);
    const lanes = [-1, 0, 1];
    lanes.forEach((lane, k) => {
      const [x, z] = track.offsetPoint(pose.i, lane * track.halfWidth * 0.55);
      const frac = best / spacing - pose.i;
      out.push({
        x: x + track.line.tx[pose.i]! * frac, z: z + track.line.tz[pose.i]! * frac, s: best,
        kind: kindFor(kinds[r % kinds.length]!, k, useful),
      });
    });
  }
  return out;
}

/** Lane `k`'s kind in a row, or the next useful one along the row. */
function kindFor(row: PickupKind[], k: number, useful: (k: PickupKind) => boolean): PickupKind {
  for (let o = 0; o < row.length; o++) {
    const kind = row[(k + o) % row.length]!;
    if (useful(kind)) return kind;
  }
  return row[k]!;
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
